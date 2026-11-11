/* Feasibility check UI. Routes: #/  #/?again=<id>  #/runs  #/runs/<id> */

// ---------- tiny helpers ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
class Raw { constructor(s) { this.s = s } }
const raw = s => new Raw(s)
const fmt = v => v instanceof Raw ? v.s : Array.isArray(v) ? v.map(fmt).join('') : v == null || v === false ? '' : esc(v)
const html = (strs, ...vals) => raw(strs.reduce((a, s, i) => a + s + (i < vals.length ? fmt(vals[i]) : ''), ''))
const $ = s => document.querySelector(s)
const view = $('#view')

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || r.statusText)
  return j
}
const zone = (() => { try { return new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName').value } catch { return '' } })()
const clock = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const when = ts => {
  if (!ts) return ''
  const d = new Date(ts), now = new Date()
  const day = d.toDateString() === now.toDateString() ? 'Today' : d.toDateString() === new Date(now - 864e5).toDateString() ? 'Yesterday' : d.toLocaleDateString([], { day: 'numeric', month: 'short' })
  return `${day} ${clock(ts)}`
}
const mmss = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` }
const took = ms => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` }
// Only web addresses become links; anything else (e.g. "javascript:") is shown as text.
const safeUrl = u => /^https?:\/\//i.test(String(u || '')) ? u : null
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return u || '' } }
const pathOf = u => { try { const x = new URL(u); return x.pathname === '/' && !x.search ? x.hostname.replace(/^www\./, '') : decodeURI(x.pathname + x.search) } catch { return u || '' } }
let toastT
function toast(t) { const e = $('#toast'); e.textContent = t; e.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => e.classList.remove('show'), 2000) }
function announce(t) { $('#announce').textContent = t }
async function copy(text, htmlText, done = 'Copied') {
  try {
    if (htmlText && window.ClipboardItem) await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([htmlText], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })])
    else await navigator.clipboard.writeText(text)
    toast(done)
  } catch (e) { toast('Copy failed: ' + e.message) }
}

// ---------- icons and statuses ----------
const SVG = {
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.2 4.2L19 7"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>',
  bang: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 8v4.5M12 15.8h.01"/></svg>',
  shield: '<svg viewBox="0 0 24 24"><path d="M12 3.5l7 2.8v5.2c0 4.3-3 7.6-7 9-4-1.4-7-4.7-7-9V6.3z"/></svg>',
  slash: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M6.2 6.2l11.6 11.6"/></svg>',
  q: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M9.8 9.6a2.3 2.3 0 1 1 3.2 2.1c-.6.3-1 .8-1 1.5v.3M12 16.4h.01"/></svg>',
  dash: '<svg viewBox="0 0 24 24"><path d="M8 12h8"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  right: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h9"/></svg>',
  ext: '<svg viewBox="0 0 24 24"><path d="M14 5h5v5M19 5l-8 8M18 14v5H5V6h5"/></svg>',
  key: '<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/></svg>',
  sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/></svg>'
}
const STATUS = {
  pass: { icon: SVG.check, word: 'Pass' },
  fail: { icon: SVG.x, word: 'Fail' },
  needs_csm: { icon: SVG.bang, word: 'Needs CSM' },
  bypass_needed: { icon: SVG.shield, word: 'Bypass needed' },
  account_needed: { icon: SVG.key, word: 'Login account' },
  blocked: { icon: SVG.slash, word: 'Could not open' },
  unknown: { icon: SVG.q, word: 'Not checked' },
  skipped: { icon: SVG.dash, word: 'Skipped' },
  notrun: { icon: SVG.dash, word: 'Not checked' },
  pending: { icon: '', word: 'Waiting' }
}
const VERDICT = {
  Feasible: { s: 'pass' },
  'Not feasible': { s: 'fail' },
  'Needs CSM': { s: 'needs_csm' },
  'Manual check needed': { s: 'blocked' },
  Incomplete: { s: 'unknown' }
}
const si = (s, small) => s === 'current'
  ? html`<span class="si ${small ? 'sm' : ''} s-current"><span class="spin"></span></span>`
  : html`<span class="si ${small ? 'sm' : ''} s-${s}" aria-hidden="true">${raw(STATUS[s]?.icon || '')}</span>`
const label = (s, text) => html`<span class="label s-${s}">${si(s, true)}${text || STATUS[s]?.word}</span>`
const verdictLabel = (v, noPrice) => label(VERDICT[v]?.s || 'unknown', v === 'Manual check needed' ? 'Manual check' : noPrice && v === 'Feasible' ? 'Feasible, no prices' : v)
const statusWord = s => ({ elsewhere: 'Running in another window', running: 'Checking', waiting_human: 'Your turn', done: 'Done', incomplete: 'Ended early', cancelled: 'Cancelled', interrupted: 'Interrupted' })[s] || s

// ---------- theme: one click toggles light / dark ----------
function applyTheme() {
  const dark = document.documentElement.dataset.theme === 'dark'
  const b = $('#themeBtn')
  b.innerHTML = dark ? SVG.sun : SVG.moon
  b.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme')
  b.title = b.getAttribute('aria-label')
}
$('#themeBtn').onclick = () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
  document.documentElement.dataset.theme = next
  localStorage.setItem('feas.theme', next)
  applyTheme()
}

// ---------- setup popover ----------
function toggleSetup(open) {
  const pop = $('#setupPop'), btn = $('#setupChip')
  const willOpen = open ?? pop.classList.contains('hidden')
  pop.classList.toggle('hidden', !willOpen)
  btn.setAttribute('aria-expanded', String(willOpen))
  if (willOpen) pop.style.right = `${Math.max(8, window.innerWidth - btn.getBoundingClientRect().right)}px`
}
$('#setupChip').onclick = e => { e.stopPropagation(); toggleSetup() }
document.addEventListener('click', e => { if (!e.target.closest('.popover')) toggleSetup(false) })
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !document.querySelector('dialog[open]') && !$('#setupPop').classList.contains('hidden')) { toggleSetup(false); $('#setupChip').focus() } })
document.addEventListener('click', e => { const c = e.target.closest('dialog [data-close]'); if (c) c.closest('dialog').close() })

// ---------- stage model (SOP order; bot protection belongs to the whole site) ----------
const STAGES = [
  { id: 'site', name: 'Site and bot protection', page: 'home', keys: ['open:site', 'bot:site', 'bot:home'], req: ['open:site', 'bot:site'] },
  { id: 'category', name: 'Category page', page: 'category', keys: ['login:category', 'dom:category', 'bot:category'], req: ['login:category', 'dom:category'] },
  { id: 'search', name: 'Search page', page: 'search', keys: ['login:search', 'dom:search', 'bot:search'], req: ['login:search', 'dom:search'] },
  { id: 'detail', name: 'Product page', page: 'detail', keys: ['login:detail', 'dom:detail', 'bot:detail'], req: ['login:detail', 'dom:detail'] },
  { id: 'store', name: 'Store selection', page: 'store', keys: ['store:site'], legacy: true }, // checks before 2026-11-08 only
  { id: 'banner', name: 'Banners', page: 'home', keys: ['banner:home'], opt: 'banner' },
  { id: 'mla', name: 'Store pages', page: 'category', keys: ['mla:store'], opt: 'mla' }
]
const STAGE_NAME = Object.fromEntries(STAGES.map(s => [s.id, s.name]))
const AREA = { open: 'Site opens', bot: 'Bot protection', login: 'Login', dom: 'Product data', store: 'Store', banner: 'Banners', mla: 'Pickup stores' }
const PAGE_LABEL = { site: 'Site', home: 'Home page', category: 'Category page', search: 'Search page', detail: 'Product page', store: 'Store pages' }
const RANK = ['fail', 'blocked', 'needs_csm', 'unknown', 'bypass_needed', 'account_needed', 'pass']
const SEG = { pass: 'done', bypass_needed: 'done', account_needed: 'done', fail: 'bad', needs_csm: 'warn', blocked: 'warn', unknown: 'neutral', skipped: 'neutral', notrun: 'neutral', pending: '' }
const isLiveStatus = s => ['running', 'waiting_human'].includes(s)

function buildStages(run) {
  const { checks = {}, input = {}, result } = run
  const live = isLiveStatus(run.status)
  const urls = (result && result.testUrls) || {}
  const siteDead = ['fail', 'blocked'].includes(checks['open:site']?.status)
  const visible = STAGES.filter(s => s.legacy ? checks[s.keys[0]] : !s.opt || input[s.opt] || checks[s.keys[0]])
  const reported = live && run.progressStage
  let currentSet = false
  return visible.map(s => {
    const recs = s.keys.map(k => checks[k]).filter(Boolean)
    const complete = recs.some(c => c.status === 'blocked') || (s.req || s.keys).every(k => checks[k])
    let status
    if (!recs.length) status = live && !siteDead ? 'pending' : 'notrun'
    else if (recs.every(c => c.status === 'unknown')) status = 'skipped'
    else status = RANK.find(r => recs.some(c => c.status === r)) || 'pass'
    let current = false
    if (live && !siteDead) {
      // The agent reports where it is (progress tool); older runs fall back to the first unfinished stage.
      if (reported) current = reported === s.id
      else if (!complete && !currentSet) current = true
      if (current) currentSet = true
    }
    const url = urls[s.page] || recs.find(c => c.url)?.url || (s.id === 'site' ? input.url : null)
    const shotRec = ['dom', 'login', 'bot', 'open', 'store', 'banner', 'mla'].map(a => recs.find(c => c.area === a && c.screenshot)).find(Boolean)
    return { ...s, recs, status, current, complete, url, shot: shotRec && shotRec.screenshot.split('/').pop() }
  })
}

// ---------- plain-language activity ----------
const BROWSER = { 'browseros-neo': 'BrowserOS', 'chrome-devtools': 'Chrome' }
function sayTool(name, args = {}) {
  const [srv, tool] = name.includes('__') ? name.split('__') : ['', name]
  const where = BROWSER[srv] || ''
  const u = args.url ? pathOf(args.url) : ''
  switch (tool) {
    case 'new_page': case 'navigate': case 'navigate_page': return u ? `Opening ${u} in ${where}` : `Going back or reloading in ${where}`
    case 'tabs': return args.action === 'new' ? `Opening ${u || 'a new tab'} in ${where}` : args.action === 'close' ? `Closing the ${where} tab` : null
    case 'close_page': return 'Closing the Chrome tab'
    case 'take_screenshot': case 'screenshot': return 'Taking a screenshot'
    case 'take_snapshot': case 'snapshot': case 'read': case 'grep': case 'evaluate_script': case 'evaluate_in_page': case 'run': case 'diff': return 'Reading the page'
    case 'click': case 'hover': case 'click_at': case 'drag': return 'Clicking on the page'
    case 'act': return 'Clicking or typing on the page'
    case 'fill': case 'fill_form': case 'type_text': return args.value ? `Typing “${args.value}”` : 'Typing on the page'
    case 'press_key': return 'Pressing a key'
    case 'wait_for': case 'wait': return 'Waiting for the page to load'
    case 'scroll': return 'Scrolling the page'
    case 'list_network_requests': case 'get_network_request': return 'Looking at the data the page loads'
    case 'browser_target': case 'browser_profiles': case 'windows': case 'name_session': return 'Getting BrowserOS ready'
    case 'detect_block': return 'Checking for bot protection'
    case 'list_pages': case 'select_page': case 'record_check': case 'ask_human': case 'progress': case 'list_console_messages': return null
  }
  if (name === 'StructuredOutput') return 'Writing up the result'
  return 'Working on the page'
}
const ANSWER = {
  solved: 'You solved it.', cant_solve: 'You couldn’t solve it. Trying the other browser.', not_captcha: 'You said it isn’t a CAPTCHA.',
  vpn_on: 'You turned on the VPN.', no_vpn: 'No VPN available.',
  signed_in: 'You signed in.', signed_in_otp: 'You signed in, but it needed a one-time code.', credentials_ready: 'You gave the tool a login. It will sign in now.', no_account: 'No login available.',
  timeout: 'No answer within 15 minutes.', cancelled: 'The check was cancelled.'
}
const WIN = b => b === 'chrome' ? 'Chrome' : 'BrowserOS'
const ERROR_TEXT = [
  [/authentication_failed|run `claude login`/i, 'Claude isn’t signed in on this computer. Ask for help to run “claude login”, then start again.'],
  [/No browser could start/i, 'No browser could start. Open BrowserOS (or install Chrome), then start again.'],
  [/Target closed|No page|browser has disconnected|Protocol error/i, 'The browser window was closed during the check. Results so far are kept. Run it again to finish.'],
  [/60 minutes/i, 'Stopped after 60 minutes. Results so far are kept.'],
  [/API key/i, 'Claude is set up with an API key instead of a Claude login. Ask for help to remove it.']
]
const friendly = m => (ERROR_TEXT.find(([re]) => re.test(m)) || [null, m])[1]

/** Turn one stored event into a feed entry (or null). */
function feedEntry(ev, run) {
  const d = ev.data || {}
  switch (ev.type) {
    case 'progress': return { t: ev.t, kind: 'step', text: d.note, stage: d.stage }
    case 'check': {
      const where = PAGE_LABEL[d.page] || d.page
      // The run's current wording wins over the wording saved in old events.
      const phrase = run.checks?.[`${d.area}:${d.page}`]?.phrase || d.phrase || STATUS[d.status]?.word
      // Site-wide results read on their own ("Site opens", "Bot protection, bypass needed"); page results get the page name.
      const text = d.page === 'site' || d.area === 'bot' ? (d.area === 'bot' && !/^Bot/.test(phrase) ? `Bot protection: ${phrase}` : phrase) : `${where}: ${phrase}`
      return { t: ev.t, kind: 'res', status: d.status, text }
    }
    case 'human': return { t: ev.t, kind: 'you', text: d.kind === 'captcha' ? `Waiting for you to solve the check in the ${WIN(d.browser)} window.` : d.kind === 'vpn' ? `Waiting for you to turn on a VPN${d.country ? ` set to ${d.country}` : ''}.` : d.kind === 'login' ? 'Waiting for you to sign in or give the tool a login.' : `Waiting for your answer: ${d.message}` }
    case 'human_done': return { t: ev.t, kind: 'you', text: ANSWER[d.answer] || `You answered: ${d.answer}` }
    case 'error': return { t: ev.t, kind: 'err', text: friendly(d.message), tech: d.message }
    case 'warning': return { t: ev.t, kind: 'warn', text: d.text }
    case 'status': return d.status === 'running' && !run._started ? (run._started = true, { t: ev.t, kind: 'step', text: 'Check started.' }) : null
    case 'done': return { t: ev.t, kind: 'step', text: d.status === 'done' ? `Check finished: ${d.verdict?.core}.` : d.status === 'cancelled' ? 'Check cancelled.' : d.endReason === 'rate_limited' ? 'Stopped: Claude usage limit reached.' : 'Check ended early.' }
    case 'log': {
      if (d.tool) {
        const name = d.name || (d.text.match(/^→ (\S+)/) || [])[1] || ''
        const args = d.args || { url: (d.text.match(/"url":"([^"]+)"/) || [])[1], action: (d.text.match(/"action":"([^"]+)"/) || [])[1] }
        const say = sayTool(name, args)
        return { t: ev.t, kind: 'act', text: say, tech: d.text, hideFriendly: !say }
      }
      if (/^Agent started/.test(d.text)) return { t: ev.t, kind: 'tech-only', tech: d.text }
      return { t: ev.t, kind: 'tech-only', tech: d.text }
    }
  }
  return null
}

// ---------- favicon, chime, notification ----------
function setFavicon(alert) {
  const c = document.createElement('canvas'); c.width = c.height = 64
  const g = c.getContext('2d')
  g.fillStyle = '#7800f2'; g.beginPath(); g.roundRect(4, 4, 56, 56, 14); g.fill()
  g.strokeStyle = '#fff'; g.lineWidth = 7; g.lineCap = 'round'; g.lineJoin = 'round'
  g.beginPath(); g.moveTo(18, 33); g.lineTo(28, 43); g.lineTo(47, 22); g.stroke()
  if (alert) { g.fillStyle = '#f59e0b'; g.strokeStyle = '#fff'; g.lineWidth = 4; g.beginPath(); g.arc(50, 14, 12, 0, 7); g.fill(); g.stroke() }
  $('#favicon').href = c.toDataURL()
}
function chime() {
  if (localStorage.getItem('feas.chime') !== '1') return
  try {
    const a = new AudioContext(), t = a.currentTime
    for (const [f, d] of [[880, 0], [1175, .18]]) {
      const o = a.createOscillator(), v = a.createGain()
      o.frequency.value = f
      v.gain.setValueAtTime(.0001, t + d); v.gain.exponentialRampToValueAtTime(.15, t + d + .02); v.gain.exponentialRampToValueAtTime(.0001, t + d + .25)
      o.connect(v).connect(a.destination); o.start(t + d); o.stop(t + d + .3)
    }
  } catch {}
}
function notify(title, body) { try { if (Notification.permission === 'granted' && document.hidden) new Notification(title, { body, tag: 'feas' }) } catch {} }

// ---------- setup + live run chip ----------
let preflight = null
const SETUP_NAME = { 'Node 20+': 'App runtime', 'Claude login': 'Claude', 'Config repo (optional)': 'Already-onboarded check' }
async function loadSetup() {
  try { preflight = await api('/api/preflight') } catch { return }
  const bad = preflight.items.filter(i => i.blocking && !i.ok)
  const warn = preflight.items.filter(i => !i.ok && !i.blocking && !/Config repo/.test(i.name))
  $('#setupChip').className = `chip ${bad.length ? 'bad' : warn.length ? 'warn' : ''}`
  $('#setupText').textContent = bad.length ? 'Setup problem' : warn.length ? 'Ready, with a note' : 'Ready'
  $('#setupChip').setAttribute('aria-label', `Setup: ${$('#setupText').textContent}`)
  $('#setupPop').innerHTML = html`<h3>Setup</h3>${preflight.items.map(i => {
    const optional = /Config repo/.test(i.name)
    const s = i.ok && !i.warn ? 'pass' : i.blocking ? 'fail' : optional ? 'notrun' : 'needs_csm'
    const detail = optional ? (/not set/.test(i.detail) ? 'Off (optional)' : 'On') : /Claude login/.test(i.name) ? (i.warn ? 'An API key is set; it is ignored and your Claude login is used.' : 'Uses your Claude login. Checked when a check starts.') : i.detail
    return html`<div class="setup-row">${si(s, true)}<div>${SETUP_NAME[i.name] || i.name}<small>${detail}</small></div></div>`
  })}`.s
}

async function pollLive() {
  let active = null
  try { active = (await api('/api/runs')).find(r => isLiveStatus(r.status)) || null } catch {}
  const chip = $('#liveChip'), onIt = active && location.hash === `#/runs/${active.id}`
  chip.classList.toggle('hidden', !active || onIt)
  if (!active && document.title.startsWith('(!)') && !location.hash.startsWith('#/runs/')) { document.title = 'Feasibility check'; setFavicon(false) }
  if (active && !onIt) {
    const needs = active.status === 'waiting_human'
    chip.href = `#/runs/${active.id}`
    chip.className = `chip ${needs ? 'warn' : 'live'}`
    $('#liveText').textContent = `${active.name} · ${needs ? 'Your turn' : STAGE_NAME[active.progress?.stage] || 'Checking'}`
    setFavicon(needs)
    if (needs) document.title = `(!) Your turn — ${active.name}`
    else if (document.title.startsWith('(!)')) document.title = 'Feasibility check'
  }
}

// ---------- router ----------
let cleanup = null
function route() {
  if (cleanup) { cleanup(); cleanup = null }
  const h = location.hash || '#/'
  const run = h.match(/^#\/runs\/([\w.-]+)$/)
  $('[data-nav="runs"]').removeAttribute('aria-current')
  view.className = ''
  window.scrollTo(0, 0)
  if (run) { view.className = 'wide'; return showRun(run[1]) }
  if (h === '#/runs') { $('[data-nav="runs"]').setAttribute('aria-current', 'page'); return showHistory() }
  showNew((h.match(/[?&]again=([\w.-]+)/) || [])[1])
}
window.addEventListener('hashchange', () => { route(); pollLive() })
// "New check" while already on the new-check screen: clear the form instead of doing nothing.
$('#newBtn').onclick = e => { if ((location.hash || '#/') === '#/' ) { e.preventDefault(); route() } }

// ---------- name suggestion: bite.lt -> Bite-LT, carrefour.it -> Carrefour-IT, foo.com -> Foo ----------
function suggestName(url) {
  let h
  try { h = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url).hostname.toLowerCase() } catch { return '' }
  const parts = h.replace(/^(www\d?|shop|m)\./, '').split('.')
  if (parts.length < 2 || !parts[parts.length - 1]) return ''
  const tld = parts[parts.length - 1]
  let sld = parts[parts.length - 2]
  if (['co', 'com', 'org', 'net'].includes(sld) && parts.length > 2) sld = parts[parts.length - 3]
  const name = sld.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('-')
  return tld.length === 2 ? `${name}-${tld.toUpperCase()}` : name
}

// ---------- screen: new check ----------
async function showNew(againId) {
  document.title = 'New check · Feasibility check'
  setFavicon(false)
  const [list, prefill] = await Promise.all([api('/api/runs').catch(() => []), againId ? api(`/api/runs/${againId}`).catch(() => null) : null])
  if (!preflight) await loadSetup()
  const busy = list.find(r => isLiveStatus(r.status))
  const bad = preflight ? preflight.items.filter(i => i.blocking && !i.ok) : []
  const p = prefill ? prefill.input : {}
  view.innerHTML = html`
    <div>
      <h1>Check a retailer</h1>
      <p class="lede">Paste the retailer’s website. We open it, check each page the way the SOP describes and give you a verdict with evidence. You only step in if the site asks to prove you are human.</p>
    </div>
    <section class="card pad">
      ${busy ? html`<div class="notice info" style="margin-bottom:16px"><div style="flex:1"><b>${busy.name}</b> is being checked right now. One check runs at a time.</div><a class="btn btn-sm btn-primary" href="#/runs/${busy.id}">Open it</a></div>` : ''}
      ${bad.map(b => html`<div class="notice bad" style="margin-bottom:16px"><div><b>${b.name}:</b> ${b.detail}</div></div>`)}
      <form class="form" id="form" novalidate>
        <div class="field">
          <label for="url">Website (home page)</label>
          <input class="input" id="url" name="url" inputmode="url" autocomplete="url" placeholder="https://www.example.com/" value="${p.url || ''}" required aria-describedby="urlErr">
          <div class="error hidden" id="urlErr" role="alert"></div>
        </div>
        <div class="field">
          <label for="name">Retailer name</label>
          <input class="input" id="name" name="name" placeholder="e.g. Bite-LT" maxlength="80" value="${p.name || ''}" required aria-describedby="nameHint nameErr" style="max-width:320px">
          <div class="hint" id="nameHint">Use the name from the ticket.</div>
          <div class="error hidden" id="nameErr" role="alert"></div>
        </div>
        <div class="field">
          <label for="client">Client <span class="faint" style="font-weight:400">(optional)</span></label>
          <input class="input" id="client" name="client" placeholder="e.g. Acme Foods" maxlength="80" value="${p.client || ''}" aria-describedby="clientHint" style="max-width:320px">
          <div class="hint" id="clientHint">The category, search and product pages are checked with this client’s brands (e.g. Crunchy, Choco for Acme Foods). Leave empty to use any product.</div>
        </div>
        <fieldset class="field" style="border:0;padding:0;margin:0">
          <legend style="font-size:13px;font-weight:500;margin-bottom:6px">Also check (if the ticket asks)</legend>
          <div class="opts">
            <label class="opt"><input type="checkbox" name="banner" ${p.banner ? 'checked' : ''}><div><b>Banners on the home page</b><span>Big promo images and tiles with links</span></div></label>
            <label class="opt"><input type="checkbox" name="mla" ${p.mla ? 'checked' : ''}><div><b>Store pages (multi-store)</b><span>Set 3 pickup stores on category pages</span></div></label>
          </div>
        </fieldset>
        <div class="row">
          <button class="btn btn-primary btn-lg" id="start" type="submit" ${busy || bad.length ? 'disabled' : ''}>Start check</button>
          <span class="faint" style="font-size:12.5px">${busy ? 'Wait for the running check, or cancel it first.' : bad.length ? 'Fix the setup problem above first.' : 'Opens a browser window.'}</span>
        </div>
      </form>
    </section>
    <section class="card">
      <div class="card-head"><h2>Recent checks</h2><span class="spacer"></span>${list.length ? html`<a class="btn btn-sm btn-quiet" href="#/runs">See all</a>` : ''}</div>
      ${list.length ? list.slice(0, 5).map(r => html`
        <div class="recent-row">
          <div><b>${r.name}</b><small>${r.host}${r.client ? ` · for ${r.client}` : ''}</small></div>
          ${r.verdict ? verdictLabel(r.verdict, r.withoutPrices) : label('unknown', statusWord(r.status))}
          <time>${when(r.startedAt)}</time>
          <div class="row" style="gap:2px"><a class="btn btn-sm btn-quiet" href="#/runs/${r.id}">Open</a><a class="btn btn-sm btn-quiet again" href="#/?again=${r.id}">Run again</a></div>
        </div>`) : html`<div class="empty" style="padding:28px">Your checks will show up here.</div>`}
    </section>`.s

  const f = $('#form'), url = $('#url'), name = $('#name')
  const hint = $('#nameHint')
  // Suggest only; the name is filled in only when the user clicks the suggestion.
  const showSuggestion = () => {
    const s = suggestName(url.value.trim())
    if (!s || s === name.value.trim()) { hint.textContent = 'Use the name from the ticket.'; return }
    hint.innerHTML = html`Suggested: <button type="button" class="linkbtn" id="useName">${s}</button> · Use the name from the ticket.`.s
    $('#useName').onclick = () => { name.value = s; name.dispatchEvent(new Event('input')); name.focus() }
  }
  name.addEventListener('input', () => { showSuggestion(); $('#nameErr').classList.add('hidden'); name.removeAttribute('aria-invalid') })
  url.addEventListener('input', () => { showSuggestion(); $('#urlErr').classList.add('hidden'); url.removeAttribute('aria-invalid') })
  showSuggestion()
  url.addEventListener('blur', () => { const v = url.value.trim(); if (v && !/^https?:\/\//i.test(v)) url.value = 'https://' + v })
  const err = (sel, input, msg) => { const e = $(sel); e.textContent = msg; e.classList.remove('hidden'); input.setAttribute('aria-invalid', 'true'); input.focus() }
  f.onsubmit = async e => {
    e.preventDefault()
    const u = url.value.trim(), n = name.value.trim()
    if (!u) return err('#urlErr', url, 'Paste the retailer’s website address.')
    if (!n) return err('#nameErr', name, 'Add the retailer name from the ticket.')
    const btn = $('#start'); btn.disabled = true; btn.innerHTML = '<span class="spin" style="border-color:rgba(255,255,255,.4);border-top-color:#fff"></span> Starting…'
    if (window.Notification && Notification.permission === 'default') Notification.requestPermission()
    try {
      const r = await api('/api/runs', { method: 'POST', body: JSON.stringify({ name: n, url: u, client: f.client.value.trim(), banner: f.banner.checked, mla: f.mla.checked }) })
      location.hash = `#/runs/${r.id}`
    } catch (ex) {
      btn.disabled = false; btn.textContent = 'Start check'
      const m = ex.message
      if (/not reachable/i.test(m)) err('#urlErr', url, 'We couldn’t reach this website. Check the address, or the site may be down.')
      else if (/already in progress/i.test(m)) err('#urlErr', url, 'Another check is running. Wait for it or cancel it first.')
      else if (/name/i.test(m)) err('#nameErr', name, m)
      else err('#urlErr', url, m)
    }
  }
  if (!p.url) url.focus()
}

// ---------- screen: history ----------
async function showHistory() {
  document.title = 'History · Feasibility check'
  setFavicon(false)
  const list = await api('/api/runs').catch(() => [])
  const FILTERS = ['All', 'Feasible', 'Not feasible', 'Needs CSM', 'Manual check needed', 'Incomplete']
  let q = '', f = 'All'
  const verdictOf = r => r.verdict || 'Incomplete'
  const hit = r => !q || `${r.name} ${r.host} ${r.client || ''}`.toLowerCase().includes(q)
  view.innerHTML = html`
    <div class="row"><h1 style="flex:1">History</h1><input class="input" id="q" type="search" placeholder="Search retailer or website" aria-label="Search retailer or website" style="max-width:280px;height:38px"></div>
    <div class="filters" id="filters" role="group" aria-label="Filter by verdict"></div>
    <section class="card" id="histCard"></section>`.s
  const row = r => html`<a class="hist-row" href="#/runs/${r.id}">
      <div><b>${r.name}</b><small>${r.host}${r.client ? ` · for ${r.client}` : ''}</small></div>
      <div>${r.verdict ? verdictLabel(r.verdict, r.withoutPrices) : label('unknown', statusWord(r.status))}</div>
      <small class="vend">${(r.vendors || []).length ? `Bot protection: ${r.vendors.join(', ')}` : ''}</small>
      <time>${when(r.startedAt)}${r.endedAt ? html`<br>${took(r.endedAt - r.startedAt)}` : ''}</time>
      ${raw(SVG.right)}
    </a>`
  const render = () => {
    $('#filters').innerHTML = FILTERS.map(x => html`<button class="filter" data-f="${x}" aria-pressed="${x === f}">${x === 'Manual check needed' ? 'Manual check' : x}<small>${list.filter(r => hit(r) && (x === 'All' || verdictOf(r) === x)).length}</small></button>`.s).join('')
    const groups = new Map()
    for (const r of list.filter(r => hit(r) && (f === 'All' || verdictOf(r) === f))) {
      const k = `${(r.name || '').toLowerCase()}|${r.host}`
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(r)
    }
    $('#histCard').innerHTML = groups.size
      ? html`<div class="hist">${[...groups.values()].map(g => html`${row(g[0])}${g.length > 1 ? html`<details class="earlier"><summary>${g.length - 1} earlier check${g.length > 2 ? 's' : ''}</summary>${g.slice(1).map(row)}</details>` : ''}`)}</div>`.s
      : list.length ? html`<div class="empty">No checks match.<button class="btn" id="clear">Clear search and filter</button></div>`.s
      : html`<div class="empty">No checks yet.<a class="btn btn-primary" href="#/">Start your first check</a></div>`.s
    const c = $('#clear'); if (c) c.onclick = () => { q = ''; f = 'All'; $('#q').value = ''; render() }
  }
  $('#q').oninput = e => { q = e.target.value.trim().toLowerCase(); render() }
  $('#filters').onclick = e => { const b = e.target.closest('[data-f]'); if (b) { f = b.dataset.f; render() } }
  render()
}

// ---------- screen: run ----------
async function showRun(id) {
  const s = await api(`/api/runs/${id}`).catch(() => null)
  if (!s) { view.innerHTML = html`<div class="empty card">This check doesn’t exist any more.<a class="btn" href="#/runs">Back to history</a></div>`.s; return }
  const run = { ...s, checks: { ...(s.checks || {}) }, seq: -1, feed: [], human: null, errors: [], open: new Set(), touched: new Set(), confirmCancel: false, progressStage: null, pinned: true }
  const isLive = () => isLiveStatus(run.status)
  const finishedAtLoad = !isLive()
  document.title = `${run.input.name} · Feasibility check`
  if (s.status === 'elsewhere') {
    view.innerHTML = html`<div class="card pad"><h1 style="font-size:20px">${s.input.name}</h1><p class="lede">This check is running in another window of this app. Open that window to follow it and answer its questions. It will show up here when it finishes.</p></div>`.s
    return
  }
  view.innerHTML = html`<div class="runhead" id="head"></div><div id="turn"></div><div id="notes"></div><div id="result"></div>
    <div class="runbody">
      <div class="journey" id="journey"></div>
      <section class="card activity" aria-labelledby="actTitle">
        <div class="card-head"><h2 id="actTitle">What’s happening</h2></div>
        <div class="feed" id="feed" role="log" aria-live="polite" aria-relevant="additions"></div>
        <button class="btn btn-sm jump hidden" id="jump">Jump to latest</button>
      </section>
    </div>`.s
  const feedEl = $('#feed')

  const renderHead = () => {
    const st = buildStages(run)
    const cur = st.findIndex(x => x.current)
    let meta
    if (run.status === 'running') meta = html`${cur >= 0 ? html`Step ${cur + 1} of ${st.length} · ` : ''}<span class="mono" id="timer">${mmss(Date.now() - run.startedAt)}</span>`
    else if (run.status === 'waiting_human') meta = html`<b style="color:var(--warn)">Waiting for you</b> · <span class="mono" id="timer">${mmss(Date.now() - run.startedAt)}</span>`
    else meta = html`${statusWord(run.status)}${run.endedAt ? html` · took ${took(run.endedAt - run.startedAt)}` : ''} · ${when(run.startedAt)}`
    $('#head').innerHTML = html`
      <div class="row">
        <div class="title"><h1>${run.input.name}</h1>${run.input.client ? html`<span class="faint">for ${run.input.client}</span>` : ''}${safeUrl(run.input.url) ? html`<a href="${run.input.url}" target="_blank" rel="noopener">${hostOf(run.input.url)} ↗</a>` : hostOf(run.input.url)}</div>
        <div class="meta">${meta}</div>
        ${isLive() && !run.confirmCancel ? html`<button class="btn btn-sm btn-danger" data-act="cancel">Cancel</button>` : ''}
        ${!isLive() ? html`<a class="btn btn-sm" href="#/?again=${run.id}">Run again</a>` : ''}
      </div>
      ${run.confirmCancel ? html`<div class="notice warn row"><span style="flex:1">Cancel this check? Results so far are kept.</span><button class="btn btn-sm" data-act="keep">Keep running</button><button class="btn btn-sm btn-danger" data-act="reallycancel">Cancel check</button></div>` : ''}
      ${isLive() ? html`<div class="progress" aria-hidden="true">${st.map(x => html`<i class="${x.current ? 'current' : SEG[x.status] || ''}" title="${x.name}"></i>`)}</div>` : ''}`.s
  }

  const answer = a => api(`/api/runs/${id}/human`, { method: 'POST', body: JSON.stringify({ answer: a }) }).catch(e => toast(e.message))
  const renderTurn = () => {
    const box = $('#turn')
    if (!run.human) { box.innerHTML = ''; return }
    const q = run.human.q, win = q.browser === 'neo' ? 'BrowserOS' : 'Chrome'
    const vendor = q.vendor && !/unknown/i.test(q.vendor) ? q.vendor.charAt(0).toUpperCase() + q.vendor.slice(1) + ' ' : ''
    box.innerHTML = html`<section class="turn" role="alertdialog" aria-labelledby="turnTitle" aria-describedby="turnMsg">
      <div class="top">Your turn<span class="count" id="turnCount">${mmss(run.human.deadline - Date.now())} left</span></div>
      ${q.kind === 'captcha'
        ? html`<h2 id="turnTitle">Go to the ${win} window and complete the ${vendor}check</h2>
               <p id="turnMsg">${q.message}</p>
               <div class="actions">
                 <button class="btn btn-primary" data-answer="solved">Done, it’s solved</button>
                 <button class="btn" data-answer="cant_solve">I can’t solve it</button>
                 <button class="btn btn-quiet" data-answer="not_captcha">There’s no check on the page</button>
                 <label class="chime"><input type="checkbox" id="chime" ${localStorage.getItem('feas.chime') === '1' ? 'checked' : ''}> Play a sound</label>
               </div>
               <p class="faint" style="font-size:12px">If you can’t solve it, we try the other browser. A bot check never makes a retailer not feasible.</p>`
        : q.kind === 'vpn'
        ? html`<h2 id="turnTitle">Turn on a VPN${q.country ? html` set to ${q.country}` : ''}</h2>
               <p id="turnMsg">${q.message || `The website only opens from ${q.country || 'its own country'}. Turn on a VPN for that country on this computer, then click Done.`}</p>
               <p class="faint" style="font-size:12px">After you click Done, the page is reloaded fresh and the check carries on with the VPN on. Leave the VPN on until the check finishes.</p>
               <div class="actions">
                 <button class="btn btn-primary" data-answer="vpn_on">Done, the VPN is on</button>
                 <button class="btn" data-answer="no_vpn">I can’t use a VPN</button>
               </div>`
        : q.kind === 'login'
        ? html`<h2 id="turnTitle">This site needs a login to show prices</h2>
               <p id="turnMsg">Choose one.${q.url ? html` Sign-in page: <span class="mono">${pathOf(q.url)}</span>` : ''}</p>
               <div class="actions">
                 <button class="btn btn-primary" data-answer="signed_in">I’ve signed in myself in ${WIN(q.browser)}</button>
                 <button class="btn" data-act="showLogin">Give the tool a login</button>
                 <button class="btn btn-quiet" data-answer="no_account">No login available</button>
               </div>
               <p style="font-size:12.5px">Did signing in ask for a one-time code (SMS, email or app)? <button class="linkbtn" data-answer="signed_in_otp">Yes, it needed a one-time code</button></p>
               <form id="loginForm" class="hidden" autocomplete="off" style="display:grid;gap:10px;max-width:420px;margin-top:6px">
                 <div class="field"><label for="lgUser">Username or email</label><input class="input" id="lgUser" autocomplete="off" spellcheck="false" style="height:38px"></div>
                 <div class="field"><label for="lgPass">Password</label><input class="input" id="lgPass" type="password" autocomplete="new-password" style="height:38px"></div>
                 <div class="row"><button class="btn btn-primary">Sign in with this login</button><span class="faint" style="font-size:12px">Used only for this check, kept in memory, never saved. The AI never sees it.</span></div>
                 <div class="error hidden" id="lgErr" role="alert"></div>
               </form>
               <p class="faint" style="font-size:12px">With no login, the result will be “Needs CSM” so the client can provide one.</p>`
        : html`<h2 id="turnTitle">The check needs your choice</h2><p id="turnMsg">${q.message}</p>
               <div class="actions">${(q.options || []).map(o => html`<button class="btn" data-answer="${o}">${o}</button>`)}
                 <form id="freeForm" class="row" style="gap:6px"><input class="input" id="free" placeholder="Or type an answer" style="height:36px;width:240px" aria-label="Your answer"><button class="btn">Send</button></form></div>`}
    </section>`.s
    const first = box.querySelector('[data-answer]') || $('#free'); first && first.focus()
    const ch = $('#chime'); if (ch) ch.onchange = () => localStorage.setItem('feas.chime', ch.checked ? '1' : '0')
    const ff = $('#freeForm'); if (ff) ff.onsubmit = e => { e.preventDefault(); const v = $('#free').value.trim(); if (v) answer(v) }
    const lf = $('#loginForm')
    if (lf) lf.onsubmit = async e => {
      e.preventDefault()
      const u = $('#lgUser').value.trim(), pw = $('#lgPass').value
      if (!u || !pw) { $('#lgErr').textContent = 'Enter both the username and the password.'; $('#lgErr').classList.remove('hidden'); return }
      try {
        await api(`/api/runs/${id}/human`, { method: 'POST', body: JSON.stringify({ answer: 'credentials', username: u, password: pw }) })
        $('#lgPass').value = ''
      } catch (er) { $('#lgErr').textContent = er.message; $('#lgErr').classList.remove('hidden') }
    }
  }

  const renderNotes = () => {
    $('#notes').innerHTML = run.errors.length && isLive() ? html`<div class="notice bad">${friendly(run.errors[run.errors.length - 1])}</div>`.s : ''
  }

  const renderResult = () => {
    const box = $('#result')
    if (isLive()) { box.innerHTML = ''; return }
    const vd = run.verdict || { core: 'Incomplete' }, V = VERDICT[vd.core] || VERDICT.Incomplete, n = run.next || { steps: [] }
    const urls = Object.entries((run.result && run.result.testUrls) || {}).filter(([, u]) => u)
    const acts = st => ({
      copyReport: html`<span class="acts"><button class="btn btn-primary btn-sm" data-act="copyReport">${raw(SVG.copy)} Copy report</button><button class="linkbtn" data-act="copyMd">Copy as plain text</button></span>`,
      copyUrls: urls.length ? html`<button class="btn btn-sm" data-act="copyUrls">${raw(SVG.copy)} Copy test URLs</button>` : html`<span class="faint" style="font-size:12.5px">No test URLs were collected</span>`,
      runAgain: html`<a class="btn btn-sm btn-primary" href="#/?again=${run.id}">Run again</a>`
    })[st.action] || ''
    const opt = Object.entries(vd.optional || {})
    box.innerHTML = html`<section class="card result" aria-labelledby="verdictTitle">
      <div class="vline">
        <span class="s-${V.s}">${si(V.s)}</span><h2 id="verdictTitle" class="s-${V.s}">${vd.withoutPrices ? 'Feasible (without prices)' : vd.core}</h2>
        ${opt.length ? html`<div class="opts-inline">${opt.map(([k, x]) => html`<span>${k === 'mla' ? 'Store pages' : 'Banners'}: <b style="font-weight:500;color:var(--ink)">${x}</b></span>`)}</div>` : ''}
      </div>
      <p class="reason">${run.endReason === 'rate_limited' ? `Claude’s usage limit was reached${run.rateLimit?.resetsAt ? `; it resets at ${clock(run.rateLimit.resetsAt * 1000)} ${zone}` : ''}. Results so far are below. Run the check again after the reset.` : n.headline || run.reason || ''}</p>
      ${n.quote ? html`<p class="quote">${n.quote}</p>` : ''}
      ${(run.warnings || []).filter(w => /already onboarded/i.test(w)).map(w => html`<div class="notice warn">${w}</div>`)}
      ${(n.notes && n.notes.length ? n.notes : n.note ? [n.note] : []).map(t => html`<p class="note"><span class="s-bypass_needed">${si(/^Login/.test(t) ? 'account_needed' : 'bypass_needed', true)}</span><span>${t}</span></p>`)}
      ${n.notes && n.notes.length ? html`<p class="note faint" style="padding-left:24px">None of this blocks feasibility.</p>` : ''}
      <hr>
      ${n.priceDecision && run.decision !== 'ask_csm' ? html`<div class="decide">
        <h3>Prices are the only thing missing</h3>
        <p>Some retailers are onboarded without prices. You can decide that here, or ask the CSM.</p>
        <div class="row" style="gap:10px">
          <button class="btn btn-primary" data-decide="no_price">Onboard without prices</button>
          <button class="btn" data-decide="ask_csm">Ask the CSM</button>
        </div>
      </div>` : ''}
      ${n.priceDecision && run.decision === 'ask_csm' ? html`<p class="note faint">You chose to ask the CSM. <button class="linkbtn" data-decide="">Change decision</button></p>` : ''}
      ${vd.withoutPrices ? html`<p class="note faint">Decided${run.decisionAt ? ` on ${when(run.decisionAt)}` : ''}: onboard without prices. <button class="linkbtn" data-decide="">Change decision</button></p>` : ''}
      <h3>What to do next</h3>
      <ol class="steps">${n.steps.map(st => html`<li><div><span>${st.text}</span>${acts(st)}</div></li>`)}</ol>
      ${n.csmQuestions?.length ? html`<h3>Questions for the CSM</h3><ul class="qlist">${n.csmQuestions.map((q, i) => html`<li><span>${q}</span><button class="btn btn-sm" data-q="${i}">${raw(SVG.copy)} Copy</button></li>`)}</ul>` : ''}
      ${n.manualChecklist?.length ? html`<h3>Check these by hand</h3><ul class="mlist">${n.manualChecklist.map(m => html`<li>
          <div class="row"><b style="font-weight:600;flex:1;text-transform:capitalize">${m.page}</b>${safeUrl(m.url) ? html`<a class="btn btn-sm" href="${m.url}" target="_blank" rel="noopener">${raw(SVG.ext)} Open the page</a>` : html`<span class="faint">No address found</span>`}</div>
          <ul>${m.items.map(it => html`<li><input type="checkbox" aria-label="${it}"> ${it}</li>`)}</ul></li>`)}</ul>` : ''}
      ${run.jira ? html`<details class="preview"><summary>Preview the report</summary><div class="jira">${raw(run.jira.html)}</div></details>` : ''}
    </section>`.s
  }

  const renderJourney = () => {
    const st = buildStages(run)
    for (const x of st) {
      if (run.touched.has(x.id)) continue
      const want = x.current || (!isLive() && ['fail', 'needs_csm', 'blocked'].includes(x.status))
      want ? run.open.add(x.id) : run.open.delete(x.id)
    }
    $('#journey').innerHTML = st.map(x => {
      const expandable = x.recs.length || x.current
      const open = run.open.has(x.id) && expandable
      const sum = x.current && !x.recs.length ? (run.progressNote || 'Checking…') : x.current ? (run.progressNote || x.recs.map(c => c.phrase).join(' · ')) : x.status === 'pending' ? '' : x.status === 'notrun' ? 'Not checked' : [...new Set(x.recs.map(c => c.phrase || STATUS[c.status]?.word))].join(' · ')
      return html`<div class="stage ${x.current ? 'current' : ''} ${x.status === 'pending' && !x.current ? 'pending' : ''}" ${open ? 'open' : ''}>
        <button aria-expanded="${!!open}" ${expandable ? '' : 'disabled'} data-toggle="${x.id}">
          ${si(x.current ? 'current' : x.status)}
          <div style="min-width:0"><div class="name">${x.name}${x.opt ? html` <span class="faint" style="font-weight:400;font-size:12.5px">· asked by the ticket</span>` : ''}</div>${sum ? html`<div class="sum">${sum}</div>` : ''}</div>
          ${x.url ? html`<span class="path">${pathOf(x.url)}</span>` : html`<span></span>`}
          ${expandable ? raw(SVG.chev) : html`<span></span>`}
        </button>
        ${open ? html`<div class="stage-body ${x.shot ? '' : 'noshot'}">
          <div class="checks">
            ${x.recs.map(c => html`<div class="check">${si(c.status, true)}<div><b>${AREA[c.area]} <span>· ${c.phrase || STATUS[c.status]?.word}</span></b><p>${c.evidence}</p></div></div>`)}
            ${x.current ? html`<div class="check"><span class="si sm s-current"><span class="spin" style="width:12px;height:12px"></span></span><div><b class="faint" style="font-weight:400">Still checking this page…</b></div></div>` : ''}
            ${x.url ? html`<div class="urlbar"><span title="${x.url}">${x.url}</span><button class="btn btn-quiet" data-copy="${x.url}" aria-label="Copy address" title="Copy address">${raw(SVG.copy)}</button>${safeUrl(x.url) ? html`<a class="btn btn-quiet" href="${x.url}" target="_blank" rel="noopener" aria-label="Open page" title="Open page">${raw(SVG.ext)}</a>` : ''}</div>` : ''}
          </div>
          ${x.shot ? html`<button class="thumb" data-shot="${x.shot}" data-title="${x.name}" aria-label="View screenshot of ${x.name}"><img src="/runs/${id}/screenshots/${encodeURIComponent(x.shot)}" alt="" loading="lazy" onerror="this.closest('.thumb').remove()"></button>` : ''}
        </div>` : ''}
      </div>`.s
    }).join('')
  }

  // --- activity feed ---
  const feedRow = e => {
    if (e.kind === 'tech-only') return ''
    if (e.kind === 'act') {
      if (e.hideFriendly) return ''
      return html`<div class="e act"><time>${mmss(e.t - run.startedAt)}</time><span><span class="dotmark"></span></span><span>${e.text}${e.count > 1 ? html` <span class="x">×${e.count}</span>` : ''}</span></div>`
    }
    const icon = e.kind === 'res' ? si(e.status, true) : e.kind === 'step' ? html`<span class="dotmark"></span>` : e.kind === 'you' ? html`<span class="s-needs_csm">${si('needs_csm', true)}</span>` : e.kind === 'err' ? si('fail', true) : si('needs_csm', true)
    return html`<div class="e ${e.kind}"><time>${mmss(e.t - run.startedAt)}</time><span>${icon}</span><span>${e.text}</span></div>`
  }
  const renderFeed = () => {
    const html_ = run.feed.map(e => feedRow(e).s || '').join('')
    feedEl.innerHTML = html_ || '<div class="empty-feed">Waiting for the check to start…</div>'
    if (run.pinned) feedEl.scrollTop = feedEl.scrollHeight
  }
  const pushFeed = e => {
    if (!e) return
    const last = run.feed[run.feed.length - 1]
    if (e.kind === 'act' && last && last.kind === 'act' && last.text === e.text) { last.count = (last.count || 1) + 1; return }
    run.feed.push(e)
  }
  feedEl.onscroll = () => {
    run.pinned = feedEl.scrollTop + feedEl.clientHeight >= feedEl.scrollHeight - 30
    $('#jump').classList.toggle('hidden', run.pinned)
  }
  $('#jump').onclick = () => { run.pinned = true; feedEl.scrollTop = feedEl.scrollHeight; $('#jump').classList.add('hidden') }

  const renderAll = () => { renderHead(); renderTurn(); renderNotes(); renderResult(); renderJourney() }

  view.onclick = e => {
    const t = e.target.closest('[data-toggle],[data-act],[data-answer],[data-copy],[data-shot],[data-q],[data-decide]')
    if (!t) return
    if (t.dataset.toggle) { const k = t.dataset.toggle; run.touched.add(k); run.open.has(k) ? run.open.delete(k) : run.open.add(k); renderJourney(); return }
    if (t.dataset.answer) return answer(t.dataset.answer)
    if (t.dataset.decide !== undefined) {
      const decision = t.dataset.decide || null
      t.disabled = true
      return api(`/api/runs/${id}/decision`, { method: 'POST', body: JSON.stringify({ decision }) })
        .then(s2 => { Object.assign(run, { verdict: s2.verdict, reason: s2.reason, next: s2.next, jira: s2.jira, decision: s2.decision, decisionAt: s2.decisionAt }); renderResult(); toast(decision === 'no_price' ? 'Marked feasible without prices' : decision === 'ask_csm' ? 'Keeping it with the CSM' : 'Decision cleared') })
        .catch(er => { t.disabled = false; toast(er.message) })
    }
    if (t.dataset.copy) return copy(t.dataset.copy, null, 'Address copied')
    if (t.dataset.q) return copy(run.next.csmQuestions[Number(t.dataset.q)], null, 'Question copied')
    if (t.dataset.shot) {
      const src = `/runs/${id}/screenshots/${encodeURIComponent(t.dataset.shot)}`
      $('#lbImg').src = src; $('#lbImg').alt = `Screenshot of ${t.dataset.title}`; $('#lbOpen').href = src; $('#lbTitle').textContent = `${t.dataset.title}`; $('#lightbox').showModal()
      return
    }
    switch (t.dataset.act) {
      case 'showLogin': $('#loginForm').classList.remove('hidden'); $('#lgUser').focus(); break
      case 'cancel': run.confirmCancel = true; renderHead(); $('[data-act="keep"]').focus(); break
      case 'keep': run.confirmCancel = false; renderHead(); break
      case 'reallycancel': run.confirmCancel = false; renderHead(); api(`/api/runs/${id}/cancel`, { method: 'POST' }).then(() => toast('Cancelling…')).catch(er => toast(er.message)); break
      case 'copyReport': run.jira && copy(run.jira.md, run.jira.html, 'Report copied. Paste it into the ticket.'); break
      case 'copyMd': run.jira && copy(run.jira.md, null, 'Report copied as plain text'); break
      case 'copyUrls': copy(urlsText(), null, 'Test URLs copied'); break
    }
  }
  const urlsText = () => Object.entries(run.result?.testUrls || {}).filter(([, u]) => u).map(([k, u]) => `${k}: ${u}`).join('\n')

  // --- events (replayed from the start, then live) ---
  run.events = []
  let lastSig = ''
  const onEvent = ev => {
    if (ev.seq <= run.seq) return
    run.seq = ev.seq
    run.events.push(ev)
    const d = ev.data || {}
    pushFeed(feedEntry(ev, run))
    if (!finishedAtLoad) {
      switch (ev.type) {
        case 'status': run.status = d.status; break
        case 'progress': run.progressStage = d.stage; run.progressNote = d.note; break
        case 'check': run.checks[`${d.area}:${d.page}`] = d; break
        case 'error': run.errors.push(d.message); renderNotes(); break
        case 'human':
          run.status = 'waiting_human'; run.human = { q: d, deadline: ev.t + 15 * 60 * 1000 }
          renderHead(); renderTurn()
          if (Date.now() - ev.t < 5000) { chime(); notify('Your turn: feasibility check', `${d.kind === 'captcha' ? `Go to the ${d.browser === 'neo' ? 'BrowserOS' : 'Chrome'} window and complete the check` : d.message} (${run.input.name})`) }
          break
        case 'human_done': run.human = null; run.status = 'running'; renderHead(); renderTurn(); break
        case 'rate': if (d.status === 'rejected') run.rateLimit = { resetsAt: d.resetsAt }; break
        case 'done': Object.assign(run, d, { checks: { ...d.checks } }); run.human = null; run.progressStage = null; renderAll(); break
      }
      if (['check', 'status', 'progress'].includes(ev.type)) {
        const st = buildStages(run), sig = st.map(x => x.id + x.status + x.current).join() + run.status + (run.progressNote || '')
        if (sig !== lastSig) { lastSig = sig; renderHead(); renderJourney() }
        if (ev.type === 'progress') announce(d.note)
      }
      const needs = run.status === 'waiting_human'
      document.title = needs ? `(!) Your turn — ${run.input.name}` : `${run.input.name} · Feasibility check`
      setFavicon(needs)
    }
    if (ev.type === 'done' && es) es.close()
    scheduleFeed()
  }
  let feedQueued = false
  const scheduleFeed = () => { if (feedQueued) return; feedQueued = true; requestAnimationFrame(() => { feedQueued = false; renderFeed() }) }

  renderAll(); renderFeed()
  const es = new EventSource(`/api/runs/${id}/events`)
  es.onmessage = m => onEvent(JSON.parse(m.data))
  es.addEventListener('end', async () => {
    es.close()
    if (!isLive()) return
    const fresh = await api(`/api/runs/${id}`).catch(() => null)
    if (fresh && !isLiveStatus(fresh.status)) { Object.assign(run, fresh, { checks: { ...fresh.checks } }); run.human = null; run.progressStage = null; renderAll() }
  })
  const tick = setInterval(() => {
    const t = $('#timer'); if (t && ['running', 'waiting_human'].includes(run.status)) t.textContent = mmss(Date.now() - run.startedAt)
    const c = $('#turnCount'); if (c && run.human) c.textContent = `${mmss(Math.max(0, run.human.deadline - Date.now()))} left`
  }, 1000)
  cleanup = () => { es.close(); clearInterval(tick); view.onclick = null; setFavicon(false) }
}

// ---------- boot ----------
applyTheme()
setFavicon(false)
loadSetup()
route()
pollLive()
setInterval(pollLive, 5000)
