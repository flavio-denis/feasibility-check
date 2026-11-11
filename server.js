import http from 'node:http'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runAgent, config } from './agent.js'
import { computeVerdict } from './verdict.js'
import { jiraSection, reportPage, verdictReason, nextSteps, statusPhrase, loginUsedOf } from './report.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 4545)
const RUNS_DIR = process.env.FEAS_RUNS_DIR || join(HERE, 'runs')
// The config repo enables the "already onboarded?" warning. Default: ~/config when it exists.
const CONFIG_REPO = process.env.FEAS_CONFIG_REPO || (existsSync(join(homedir(), 'config', 'retailer')) ? join(homedir(), 'config') : '')
const ACTIVE_LIMIT_MS = 60 * 60 * 1000 // agent working time; human waits don't count
// Files the running app loaded at start. If any changes on disk, the app must be restarted before the next check.
const CODE_FILES = ['server.js', 'agent.js', 'tools.js', 'verdict.js', 'report.js', 'detect.js', 'solvers.js', 'prompt.md']
const BOOTED_AT = Date.now()
const codeChanged = () => CODE_FILES.filter(f => { try { return statSync(join(HERE, f)).mtimeMs > BOOTED_AT } catch { return false } })
mkdirSync(RUNS_DIR, { recursive: true })

const runs = new Map() // live runs (this process)
let activeRun = null

// ---------- run object ----------

function createRun(input) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'retailer'
  const id = `${stamp}_${slug}`
  const dir = join(RUNS_DIR, id)
  const screenshotsDir = join(dir, 'screenshots')
  mkdirSync(screenshotsDir, { recursive: true })
  writeFileSync(join(dir, 'input.json'), JSON.stringify(input, null, 2))
  writeFileSync(join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, port: PORT, at: Date.now() }))

  const run = {
    id, dir, screenshotsDir, input,
    checks: {}, events: [], subscribers: new Set(),
    status: 'running', startedAt: Date.now(), endedAt: null, activeMs: 0,
    abort: new AbortController(), pendingHuman: null,
    result: null, usage: null, sessionId: null, rateLimit: null, endReason: null,
    shotCount: 0, lastShot: null, progress: null
  }

  // A handed-over login is masked in everything the run writes or sends (events, checks, result).
  run.secrets = []
  run.redact = v => {
    if (!run.secrets.length) return v
    const one = x => run.secrets.reduce((t, sec) => t.split(sec).join('***'), x)
    const deep = x => typeof x === 'string' ? one(x) : Array.isArray(x) ? x.map(deep) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, deep(y)])) : x
    return deep(v)
  }
  run.emit = (type, data = {}) => {
    const ev = { seq: run.events.length, t: Date.now(), type, data: run.redact(data) }
    run.events.push(ev)
    appendFileSync(join(dir, 'events.jsonl'), JSON.stringify(ev) + '\n')
    for (const res of run.subscribers) res.write(`data: ${JSON.stringify(ev)}\n\n`)
  }

  run.setProgress = p => {
    run.progress = { ...p, at: Date.now() }
    run.emit('progress', run.progress)
  }

  run.recordCheck = input => {
    const c = run.redact({ ...input })
    if (c.area === 'bot') {
      c.page = 'site' // bot protection is per retailer, solved once on the home page
      if (c.status === 'fail') c.status = 'bypass_needed' // a bot wall is never a reason for "not feasible"
    }
    if (c.area === 'open') c.page = 'site'
    if (c.area === 'mla') c.page = 'store' // store pages: one result for the whole store test
    // "Only prices missing" must be said explicitly by the agent; the word search is only for older runs.
    if ((c.area === 'login' || c.area === 'dom') && c.priceOnly === undefined) c.priceOnly = false
    // Attach the latest screenshot only if it was taken on the current page (after the last navigation).
    const freshShot = run.lastShot && (run.lastShotAt || 0) >= (run.lastNavAt || 0) ? run.lastShot : undefined
    c.screenshot = c.screenshot ? basename(c.screenshot) : freshShot
    if (c.screenshot && !existsSync(join(screenshotsDir, c.screenshot))) c.screenshot = freshShot
    run.checks[`${c.area}:${c.page}`] = { ...c, phrase: statusPhrase(c, { loginUsed: run.loginUsed }), at: Date.now() }
    writeFileSync(join(dir, 'checks.json'), JSON.stringify(run.checks, null, 2))
    run.emit('check', run.checks[`${c.area}:${c.page}`])
  }

  run.waitForHuman = (question, timeoutMs) => new Promise(resolve => {
    const done = answer => {
      clearTimeout(timer)
      run.abort.signal.removeEventListener('abort', onAbort)
      run.pendingHuman = null
      if (run.status === 'waiting_human') run.status = 'running'
      run.emit('human_done', { answer })
      resolve(answer)
    }
    const onAbort = () => done('cancelled')
    const timer = setTimeout(() => done('timeout'), timeoutMs)
    run.abort.signal.addEventListener('abort', onAbort, { once: true })
    run.pendingHuman = { question, done }
    run.status = 'waiting_human'
    run.emit('human', question)
  })

  runs.set(id, run)
  return run
}

async function drive(run, opts) {
  activeRun = run
  run.status = 'running'
  run.emit('status', { status: 'running' })
  const beat = () => { try { writeFileSync(join(run.dir, 'owner.json'), JSON.stringify({ pid: process.pid, port: PORT, at: Date.now() })) } catch {} }
  const tick = setInterval(() => {
    beat() // heartbeat: other app copies treat a run with no beat for 2 minutes as stopped
    if (run.status === 'running') run.activeMs += 15000
    if (run.activeMs > ACTIVE_LIMIT_MS && !run.abort.signal.aborted) {
      run.endReason = 'timeout'
      run.emit('error', { message: 'Stopped: 60 minutes of agent time used.' })
      run.abort.abort('timeout')
    }
  }, 15000)
  try {
    await runAgent(run, opts)
  } finally {
    clearInterval(tick)
    finish(run)
    if (activeRun === run) activeRun = null
  }
}

function finish(run) {
  if (run.pendingHuman) run.pendingHuman.done('cancelled')
  run.creds = null // a handed-over login lives only in memory, only for this run
  run.endedAt = Date.now()
  const reason = run.endReason || (run.abort.signal.aborted ? 'cancelled' : 'incomplete')
  run.status = reason === 'completed' ? 'done' : reason === 'cancelled' ? 'cancelled' : 'incomplete'
  run.verdict = computeVerdict(run.checks, { completed: run.status === 'done', options: run.input })
  saveResult(run)
  run.emit('done', summary(run))
  for (const res of run.subscribers) res.end('event: end\ndata: {}\n\n')
  run.secrets = [] // forget the masked values only after everything is written
}

function saveResult(run) {
  const data = {
    id: run.id, status: run.status, endReason: run.endReason, input: run.input, checks: run.checks,
    result: run.result, verdict: run.verdict, usage: run.usage, sessionId: run.sessionId,
    rateLimit: run.rateLimit, startedAt: run.startedAt, endedAt: run.endedAt, loginUsed: !!run.loginUsed,
    decision: run.decision || null, decisionAt: run.decisionAt || null, warnings: run.warnings || []
  }
  const safe = run.redact ? run.redact(data) : data
  writeFileSync(join(run.dir, 'result.json'), JSON.stringify(safe, null, 2))
  writeFileSync(join(run.dir, 'report.html'), reportPage(safe))
}

function summary(r) {
  // Runs saved before the "onboard without prices" option: work out whether prices are the only gap,
  // without changing the saved verdict itself.
  if (r.verdict && r.verdict.priceOnly === undefined && r.status === 'done') {
    r = { ...r, verdict: { ...r.verdict, priceOnly: computeVerdict(r.checks || {}, { completed: true, options: r.input || {} }).priceOnly && r.verdict.core === 'Needs CSM' } }
  }
  const jira = r.verdict ? jiraSection(r) : null
  return {
    id: r.id, status: r.status, endReason: r.endReason, input: r.input, result: r.result,
    checks: Object.fromEntries(Object.entries(r.checks || {}).map(([k, c]) => [k, { ...c, phrase: statusPhrase(c, { loginUsed: loginUsedOf(r) }) }])),
    verdict: r.verdict, usage: r.usage, rateLimit: r.rateLimit, startedAt: r.startedAt, endedAt: r.endedAt,
    jira,
    decision: r.decision || null, decisionAt: r.decisionAt || null, warnings: r.warnings || [],
    reason: r.verdict ? verdictReason(r.checks, r.verdict, { loginUsed: loginUsedOf(r), endReason: r.endReason }) : null,
    next: r.verdict ? nextSteps(r.verdict, r.checks, r.result, r.input, { loginUsed: loginUsedOf(r) }) : null
  }
}

// Is an unfinished run still owned by a running app (another window or server on this machine)?
function ownerAlive(dir) {
  const o = readJson(join(dir, 'owner.json'))
  if (o && o.pid) {
    // The owner writes a heartbeat every 15 s. No beat for 2 minutes = stopped (also covers a reused process id).
    if (Date.now() - (o.at || 0) > 2 * 60 * 1000) return false
    if (o.pid === process.pid) return runs.has(basename(dir))
    try { process.kill(o.pid, 0); return true } catch (e) { return e.code === 'EPERM' }
  }
  // Runs from older versions have no owner file: treat recent activity as alive.
  const ev = join(dir, 'events.jsonl')
  return existsSync(ev) && Date.now() - statSync(ev).mtimeMs < 3 * 60 * 1000
}
function foreignLiveRun() {
  for (const id of readdirSync(RUNS_DIR)) {
    const dir = join(RUNS_DIR, id)
    if (runs.has(id) || !existsSync(join(dir, 'input.json')) || existsSync(join(dir, 'result.json'))) continue
    if (ownerAlive(dir)) return { id, input: readJson(join(dir, 'input.json')) }
  }
  return null
}

// Boot: a run without result.json whose app has stopped was cut off by a crash or restart.
for (const id of readdirSync(RUNS_DIR)) {
  const dir = join(RUNS_DIR, id)
  if (!existsSync(join(dir, 'input.json')) || existsSync(join(dir, 'result.json'))) continue
  if (ownerAlive(dir)) continue // still running in another app instance: leave it alone
  const input = readJson(join(dir, 'input.json'))
  const checks = readJson(join(dir, 'checks.json')) || {}
  const data = {
    id, status: 'interrupted', endReason: 'server_restart', input, checks, result: null,
    verdict: computeVerdict(checks, { completed: false, options: input }), usage: null,
    startedAt: statSync(join(dir, 'input.json')).mtimeMs, endedAt: Date.now()
  }
  writeFileSync(join(dir, 'result.json'), JSON.stringify(data, null, 2))
}

// ---------- preflight + input ----------

function findChrome() {
  if (config.chromePath) return existsSync(config.chromePath) ? config.chromePath : null
  const candidates = {
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')],
    win32: [join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
      join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')]
  }[process.platform]
  if (candidates) return candidates.find(p => existsSync(p)) || null
  for (const bin of ['google-chrome', 'google-chrome-stable']) {
    try { return execFileSync('which', [bin]).toString().trim() } catch {}
  }
  return null
}

async function neoReachable() {
  try {
    await fetch(config.neoUrl, { method: 'GET', signal: AbortSignal.timeout(2000) })
    return true // any HTTP answer means the server is up
  } catch { return false }
}

async function preflight() {
  const nodeMajor = Number(process.versions.node.split('.')[0])
  const chrome = findChrome()
  const neo = await neoReachable()
  const apiKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
  const changed = codeChanged()
  const items = [
    ...(changed.length ? [{ name: 'App update', ok: false, blocking: true, detail: 'The app was updated while it was running. Restart it (Ctrl+C, then npm start) before the next check.' }] : []),
    { name: 'Node 20+', ok: nodeMajor >= 20, detail: `v${process.versions.node}`, blocking: true },
    { name: 'BrowserOS (main browser)', ok: neo, detail: neo ? `Ready, profile ${config.neoProfile}` : chrome ? 'Not open. Checks will run in Chrome only. Start BrowserOS for the best results.' : 'Not open. Start BrowserOS.', blocking: !neo && !chrome },
    { name: 'Chrome (backup browser)', ok: !!chrome, detail: chrome ? 'Ready' : neo ? 'Not found. BrowserOS will be used alone, with no backup.' : 'Not found. Install Google Chrome or set FEAS_CHROME_PATH.', blocking: !neo && !chrome },
    { name: 'Claude login', ok: true, detail: apiKey ? 'API key env var found: it is removed for runs so your subscription login is used' : 'verified when a run starts (`claude login`)', blocking: false, warn: apiKey },
    { name: 'Config repo (optional)', ok: !CONFIG_REPO || existsSync(join(CONFIG_REPO, 'retailer')), detail: CONFIG_REPO || 'FEAS_CONFIG_REPO not set and no ~/config folder; "already onboarded" check off', blocking: false }
  ]
  return { items, neo, chrome: !!chrome, model: config.model, busy: activeRun ? activeRun.id : null }
}

function normalizeUrl(raw) {
  let s = String(raw || '').trim()
  if (!s) throw new Error('Home URL is required.')
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s
  const u = new URL(s)
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs.')
  if (!u.hostname.includes('.')) throw new Error('That does not look like a website address.')
  return u.origin + u.pathname
}

async function reachability(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', accept: 'text/html' }
    })
    res.body?.cancel()
    return { ok: true, status: res.status, finalUrl: res.url }
  } catch (e) {
    const code = e?.cause?.code || e?.name
    // Timeouts are not proof of a dead site (some bot walls tarpit plain fetches); let the browser decide.
    if (code === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT') return { ok: true, status: null, finalUrl: url, warning: 'Server did not answer a plain request in 15 s; the browser will try.' }
    return { ok: false, error: `${code || 'error'}: ${e?.cause?.message || e.message}` }
  }
}

function alreadyOnboarded(name, url) {
  if (!CONFIG_REPO || !existsSync(join(CONFIG_REPO, 'retailer'))) return []
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const n = norm(name)
  const host = new URL(url).hostname.replace(/^www\./, '')
  const hits = []
  for (const dir of readdirSync(join(CONFIG_REPO, 'retailer'))) {
    if (norm(dir) === n) { hits.push(`retailer/${dir} (same name)`); continue }
    const g = join(CONFIG_REPO, 'retailer', dir, 'gather')
    if (!existsSync(g)) continue
    for (const f of readdirSync(g)) {
      if (!f.endsWith('.json')) continue
      if (readFileSync(join(g, f), 'utf8').includes(host)) { hits.push(`retailer/${dir} (uses ${host})`); break }
    }
  }
  return hits.slice(0, 10)
}

// ---------- HTTP ----------

function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(type === 'application/json' ? JSON.stringify(body) : body)
}
const body = req => new Promise((resolve, reject) => {
  let b = ''
  req.on('data', c => { b += c; if (b.length > 1e5) req.destroy() })
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}) } catch (e) { reject(e) } })
})

function loadRun(id) {
  if (runs.has(id)) return runs.get(id)
  if (!/^[\w.-]+$/.test(id)) return null
  const dir = join(RUNS_DIR, id)
  const data = readJson(join(dir, 'result.json'))
  if (data) return { ...data, dir, events: null }
  const input = readJson(join(dir, 'input.json'))
  if (!input) return null
  // Started by another copy of the app and still going (or cut off and not yet tidied up).
  return { id, dir, input, checks: readJson(join(dir, 'checks.json')) || {}, status: ownerAlive(dir) ? 'elsewhere' : 'interrupted', endReason: 'server_restart', startedAt: statSync(join(dir, 'input.json')).mtimeMs, events: null, verdict: null }
}

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`])
const server = http.createServer(async (req, res) => {
  try {
    // Block other websites (and DNS-rebinding pages) from using the app through this browser.
    if (!ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) return send(res, 403, { error: 'Open the app at http://localhost:' + PORT })
    if (req.method === 'POST' && !/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, { error: 'JSON only.' })
    const url = new URL(req.url, 'http://localhost')
    const p = url.pathname
    const m = p.match(/^\/api\/runs\/([\w.-]+)(?:\/(events|human|cancel|decision))?$/)

    if (req.method === 'GET' && p === '/') return send(res, 200, readFileSync(join(HERE, 'public/index.html')), 'text/html; charset=utf-8')
    const asset = req.method === 'GET' && p.match(/^\/(app\.css|app\.js)$/)
    if (asset) return send(res, 200, readFileSync(join(HERE, 'public', asset[1])), asset[1].endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8')
    if (req.method === 'GET' && p === '/api/preflight') return send(res, 200, await preflight())

    if (req.method === 'GET' && p === '/api/runs') {
      const list = readdirSync(RUNS_DIR).filter(id => existsSync(join(RUNS_DIR, id, 'input.json'))).sort().reverse().slice(0, 50).map(id => {
        const live = runs.get(id)
        const d = live || readJson(join(RUNS_DIR, id, 'result.json')) || { input: readJson(join(RUNS_DIR, id, 'input.json')), status: ownerAlive(join(RUNS_DIR, id)) ? 'running' : 'interrupted', startedAt: statSync(join(RUNS_DIR, id)).birthtimeMs }
        return {
          id, name: d.input?.name, client: d.input?.client || null, url: d.input?.url, host: (() => { try { return new URL(d.input?.url).hostname.replace(/^www\./, '') } catch { return '' } })(),
          status: d.status, endReason: d.endReason || null, banner: !!d.input?.banner, mla: !!d.input?.mla,
          verdict: d.verdict?.core || null, withoutPrices: !!d.verdict?.withoutPrices, optional: d.verdict?.optional || {}, vendors: d.result?.vendors || [],
          bypass: (d.verdict?.bypass || []).map(b => b.page), startedAt: d.startedAt || null, endedAt: d.endedAt || null,
          progress: live ? live.progress : null
        }
      })
      return send(res, 200, list)
    }

    if (req.method === 'POST' && p === '/api/runs') {
      if (activeRun) return send(res, 409, { error: `A run is already in progress (${activeRun.input.name}). Finish or cancel it first.` })
      const other = foreignLiveRun()
      if (other) return send(res, 409, { error: `A run is already in progress (${other.input?.name || other.id}) in another window of this app. Finish or cancel it first.` })
      const b = await body(req)
      const name = String(b.name || '').trim().slice(0, 80)
      if (!name) return send(res, 400, { error: 'Retailer name is required.' })
      // Optional. One line, so it cannot add lines to the agent's first message.
      const client = String(b.client || '').replace(/\s+/g, ' ').trim().slice(0, 80)
      let homeUrl
      try { homeUrl = normalizeUrl(b.url) } catch (e) { return send(res, 400, { error: e.message }) }
      const pf = await preflight()
      const blocker = pf.items.find(i => i.blocking && !i.ok)
      if (blocker) return send(res, 400, { error: `${blocker.name}: ${blocker.detail}` })
      const reach = await reachability(homeUrl)
      if (!reach.ok) return send(res, 400, { error: `Site not reachable: ${reach.error}` })

      const warnings = []
      if (reach.warning) warnings.push(reach.warning)
      if (reach.finalUrl && new URL(reach.finalUrl).hostname !== new URL(homeUrl).hostname) warnings.push(`Redirects to ${reach.finalUrl}`)
      if (reach.status && reach.status >= 400) warnings.push('The website turned away a quick test visit. This is common with bot protection; the browser check continues.')
      const onboarded = alreadyOnboarded(name, homeUrl)
      if (onboarded.length) warnings.push(`Possibly already onboarded: ${onboarded.join(', ')}`)

      // Team policy: banners are not supported for Amazon retailers (ROB-23433, ROB-23439).
      const amazon = /(^|\.)amazon\.[a-z.]+$/i.test(new URL(homeUrl).hostname)
      const run = createRun({ name, url: homeUrl, ...(client ? { client } : {}), banner: !!b.banner, mla: !!b.mla, ...(amazon && b.banner ? { bannerPolicy: 'banners are not supported for Amazon retailers' } : {}) })
      run.warnings = warnings
      for (const w of warnings) run.emit('warning', { text: w })
      if (run.input.bannerPolicy) run.recordCheck({ area: 'banner', page: 'home', status: 'fail', evidence: 'Banners are not supported for Amazon retailers (team policy).' })
      drive(run, { neoAvailable: pf.neo, chromeAvailable: pf.chrome }).catch(e => console.error('Run failed to finish cleanly:', e))
      return send(res, 201, { id: run.id, warnings })
    }

    if (m) {
      const [, id, action] = m
      const run = loadRun(id)
      if (!run) return send(res, 404, { error: 'Run not found.' })

      if (!action && req.method === 'GET') return send(res, 200, runs.has(id) ? { ...summary(run), live: run.status } : { ...summary(run) })

      if (action === 'events' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        const evFile = join(run.dir, 'events.jsonl')
        const past = run.events || (existsSync(evFile) ? readFileSync(evFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])
        for (const ev of past) res.write(`data: ${JSON.stringify(ev)}\n\n`)
        if (runs.has(id) && ['running', 'waiting_human'].includes(run.status)) {
          run.subscribers.add(res)
          const ping = setInterval(() => res.write(': ping\n\n'), 20000)
          req.on('close', () => { clearInterval(ping); run.subscribers.delete(res) })
        } else res.end('event: end\ndata: {}\n\n')
        return
      }

      if (action === 'human' && req.method === 'POST') {
        if (!runs.has(id) || !run.pendingHuman) return send(res, 409, { error: 'No question is waiting.' })
        const b = await body(req)
        if (b.answer === 'credentials') {
          if (run.pendingHuman.question.kind !== 'login') return send(res, 409, { error: 'The check is not asking for a login right now.' })
          const username = String(b.username || '').trim(), password = String(b.password || '')
          if (!username || !password) return send(res, 400, { error: 'Enter both the username and the password.' })
          if (username.length > 200 || password.length > 200) return send(res, 400, { error: 'That login is too long.' })
          run.creds = { username, password } // memory only; never written to disk, events or reports
          run.secrets = [password, username].filter(x => x.length >= 3) // masked in everything the run writes
          run.loginUsed = true
          run.pendingHuman.done('credentials_ready')
          return send(res, 200, { ok: true })
        }
        if (b.answer === 'signed_in' || b.answer === 'signed_in_otp') run.loginUsed = true
        run.pendingHuman.done(String(b.answer || '').slice(0, 500) || 'no answer')
        return send(res, 200, { ok: true })
      }

      if (action === 'decision' && req.method === 'POST') {
        // Team decision when prices are the only thing missing: onboard without prices, or ask the CSM.
        if (runs.has(id) && ['running', 'waiting_human'].includes(run.status)) return send(res, 409, { error: 'Wait for the check to finish.' })
        const b = await body(req)
        const decision = ['no_price', 'ask_csm'].includes(b.decision) ? b.decision : null
        const file = join(RUNS_DIR, id, 'result.json')
        const data = readJson(file)
        if (!data) return send(res, 404, { error: 'Run not found.' })
        const base = computeVerdict(data.checks || {}, { completed: data.status === 'done', options: data.input || {} })
        if (decision && !base.priceOnly) return send(res, 409, { error: 'This choice is only possible when prices are the only thing missing.' })
        if (!data.verdictBeforeDecision) data.verdictBeforeDecision = data.verdict // the verdict as the check saved it
        data.decision = decision
        data.decisionAt = decision ? Date.now() : null
        data.verdict = decision === 'no_price'
          ? computeVerdict(data.checks || {}, { completed: data.status === 'done', options: data.input || {}, decision })
          : { ...data.verdictBeforeDecision, priceOnly: base.priceOnly, decision }
        writeFileSync(file, JSON.stringify(data, null, 2))
        writeFileSync(join(RUNS_DIR, id, 'report.html'), reportPage(data))
        if (runs.has(id)) Object.assign(runs.get(id), { decision: data.decision, decisionAt: data.decisionAt, verdict: data.verdict })
        return send(res, 200, summary(data))
      }

      if (action === 'cancel' && req.method === 'POST') {
        if (!runs.has(id) || !['running', 'waiting_human'].includes(run.status)) return send(res, 409, { error: 'This check has already finished.' })
        run.endReason = 'cancelled'
        run.abort.abort('cancelled')
        return send(res, 200, { ok: true })
      }
    }

    const shot = p.match(/^\/runs\/([\w.-]+)\/screenshots\/([\w.-]+\.(?:png|jpe?g|webp))$/)
    if (req.method === 'GET' && shot) {
      const f = join(RUNS_DIR, shot[1], 'screenshots', basename(shot[2]))
      if (!existsSync(f)) return send(res, 404, { error: 'not found' })
      return send(res, 200, readFileSync(f), shot[2].endsWith('png') ? 'image/png' : 'image/jpeg')
    }

    send(res, 404, { error: 'Not found' })
  } catch (e) {
    console.error(e)
    if (!res.headersSent) send(res, 500, { error: String(e.message || e) })
  }
})

// Localhost only: the app drives a browser with your login; never expose it on the network.
server.listen(PORT, '127.0.0.1', () => console.log(`Feasibility check: http://localhost:${PORT}  (model ${config.model})`))
