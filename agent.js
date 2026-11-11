import { query } from '@anthropic-ai/claude-agent-sdk'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeFeasServer } from './tools.js'
import { probeScript } from './detect.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHROME_DEVTOOLS_MCP = 'chrome-devtools-mcp@1.12.0'
const NEO_DENY = ['credentials', 'payment_cards', 'upload', 'download', 'save_skill', 'run_skill', 'mark_skill_run']
  .map(t => `mcp__browseros-neo__${t}`)

export const config = {
  model: process.env.FEAS_MODEL || 'claude-sonnet-5-5',
  neoUrl: process.env.FEAS_NEO_URL || 'http://127.0.0.1:9010/mcp',
  neoProfile: process.env.FEAS_NEO_PROFILE || 'CIQ',
  chromePath: process.env.FEAS_CHROME_PATH || '',
  maxTurns: Number(process.env.FEAS_MAX_TURNS || 150)
}

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    testUrls: {
      type: 'object',
      properties: Object.fromEntries(['home', 'category', 'search', 'detail', 'store'].map(k => [k, { type: 'string' }]))
    },
    vendors: { type: 'array', items: { type: 'string' } },
    platform: { type: 'string' },
    storeInfo: { type: 'string' },
    mlaInfo: { type: 'string' },
    bannerInfo: { type: 'string' },
    clientBrands: { type: 'array', items: { type: 'string' }, description: 'Client brands seen on this site and used for the test pages; empty when none were found or no client was given' },
    clientInfo: { type: 'string', description: 'One plain sentence: which client brands were used on which page, or that none were found' },
    notes: { type: 'string', description: 'Overlay buttons, lazy loading, anything onboarding should know' },
    agentOpinion: { type: 'string' }
  },
  required: ['testUrls', 'agentOpinion']
}

// Read once at start-up, like the rest of the code, so a running app never mixes old and new rules.
const PROMPT = readFileSync(join(HERE, 'prompt.md'), 'utf8')

// Chrome is the fallback: its tools are deferred, so the agent loads them in one call before first use.
export const CHROME_LOAD = ' Its tools are not loaded yet: before your first Chrome call, load them once with `ToolSearch` query `select:mcp__chrome-devtools__new_page,mcp__chrome-devtools__navigate_page,mcp__chrome-devtools__list_pages,mcp__chrome-devtools__select_page,mcp__chrome-devtools__close_page,mcp__chrome-devtools__take_snapshot,mcp__chrome-devtools__take_screenshot,mcp__chrome-devtools__evaluate_script,mcp__chrome-devtools__click,mcp__chrome-devtools__fill,mcp__chrome-devtools__fill_form,mcp__chrome-devtools__type_text,mcp__chrome-devtools__press_key,mcp__chrome-devtools__wait_for,mcp__chrome-devtools__handle_dialog` (max_results 20).'

function systemPrompt(run, neoAvailable, chromeAvailable) {
  return PROMPT
    .replaceAll('{{probeScript}}', probeScript())
    .replaceAll('{{screenshotsDir}}', run.screenshotsDir)
    .replaceAll('{{banner}}', run.input.banner ? (run.input.bannerPolicy ? `no, already recorded by the app (${run.input.bannerPolicy})` : 'yes') : 'no')
    .replaceAll('{{mla}}', run.input.mla ? 'yes' : 'no')
    .replaceAll('{{neoAvailable}}', neoAvailable ? 'yes' : 'no')
    .replaceAll('{{chromeAvailable}}', chromeAvailable ? 'yes' : 'no')
    .replaceAll('{{chromeLoad}}', neoAvailable && chromeAvailable ? CHROME_LOAD : '')
    .replaceAll('{{neoProfile}}', config.neoProfile)
    .replaceAll('{{client}}', run.input.client || 'none')
}

export function firstPrompt(input) {
  return [
    `Retailer: ${input.name}`,
    `Home URL: ${input.url}`,
    `Client: ${input.client || 'none'}`,
    `Banner check requested: ${input.banner ? (input.bannerPolicy ? `no, already recorded by the app (${input.bannerPolicy})` : 'yes') : 'no'}`,
    `MLA check requested: ${input.mla ? 'yes' : 'no'}`,
    'Run the feasibility check now.'
  ].join('\n')
}


/** Child env: subscription login only. An API key here would silently win over `claude login`. */
function childEnv() {
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS = '0'
  env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false' // no claude.ai connectors (Granola, Google, …) in this agent
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'feasibility-check/0.1'
  return env
}

const short = v => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > 160 ? s.slice(0, 160) + '…' : s
}

/** Token totals across every model the run used (SDK result.modelUsage). */
export function sumTokens(modelUsage = {}) {
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const u of Object.values(modelUsage)) {
    t.input += u.inputTokens || 0
    t.output += u.outputTokens || 0
    t.cacheRead += u.cacheReadInputTokens || 0
    t.cacheWrite += u.cacheCreationInputTokens || 0
  }
  t.total = t.input + t.output + t.cacheRead + t.cacheWrite
  return t
}

/**
 * Runs the agent for one run. Mutates run.{sessionId, result, usage, rateLimit, endReason}.
 * run: { id, input, checks, screenshotsDir, dir, abort: AbortController, emit, recordCheck, waitForHuman }
 */
export async function runAgent(run, { neoAvailable, chromeAvailable = true }) {
  let neoBound = false
  run.toolUses = run.toolUses || new Map()
  // BrowserOS neo is the primary browser; the clean chrome-devtools window is the fallback.
  const mcpServers = { feas: makeFeasServer(run) }
  if (neoAvailable) mcpServers['browseros-neo'] = { type: 'http', url: config.neoUrl, alwaysLoad: true, timeout: 120000 }
  if (chromeAvailable) mcpServers['chrome-devtools'] = {
    command: 'npx',
    args: ['-y', CHROME_DEVTOOLS_MCP, '--isolated', '--viewport', '1366x900',
      ...(config.chromePath ? ['--executablePath', config.chromePath] : [])],
    // Fallback only when BrowserOS is up: keep its ~30 tool descriptions out of every step until needed (ToolSearch loads them).
    alwaysLoad: !neoAvailable,
    timeout: 120000
  }

  const chromeDeferred = neoAvailable && chromeAvailable
  const fillCredentials = input => fillLogin(input, run.creds)

  const neoGuard = async input => {
    const name = input.tool_name || ''
    if (!name.startsWith('mcp__browseros-neo__')) return fillCredentials(input) || {}
    const ti = input.tool_input || {}
    if (name.endsWith('__browser_target') && ti.action === 'set') {
      if (ti.name === config.neoProfile) return {} // bound only once the call succeeds (PostToolUse below)
      return deny(`Bind the profile named "${config.neoProfile}" only.`)
    }
    if (name.endsWith('__browser_target')) return ti.action === 'get' ? {} : deny('Do not change the BrowserOS profile or window during the check.')
    if (!neoBound) return deny(`Call browser_target action=set name="${config.neoProfile}" before any other BrowserOS neo call.`)
    return fillCredentials(input) || {}
  }

  const options = {
    model: config.model,
    cwd: run.dir,
    systemPrompt: systemPrompt(run, neoAvailable, chromeAvailable),
    settingSources: [],
    persistSession: false, // nothing from a run (including a handed-over login) is saved in Claude's session files
    strictMcpConfig: true, // only the servers declared here
    tools: chromeDeferred ? ['ToolSearch'] : [],
    mcpServers,
    allowedTools: [...(chromeDeferred ? ['ToolSearch'] : []), 'mcp__feas__*', ...(neoAvailable ? ['mcp__browseros-neo__*'] : []), ...(chromeAvailable ? ['mcp__chrome-devtools__*'] : [])],
    disallowedTools: [...NEO_DENY, 'mcp__chrome-devtools__upload_file'],
    permissionMode: 'dontAsk',
    maxTurns: config.maxTurns,
    abortController: run.abort,
    env: childEnv(),
    outputFormat: { type: 'json_schema', schema: RESULT_SCHEMA },
    hooks: {
      PreToolUse: [{ hooks: [neoGuard], onFailure: 'block' }],
      PostToolUse: [{ hooks: [async input => {
        // The profile counts as bound only when BrowserOS confirms it.
        if (/__browser_target$/.test(input.tool_name || '') && input.tool_input?.action === 'set') {
          const out = JSON.stringify(input.tool_response || '')
          neoBound = out.includes('binding') && out.includes(config.neoProfile) && !/"isError"\s*:\s*true/.test(out)
        }
        return {}
      }] }]
    },
  }

  try {
    for await (const m of query({ prompt: firstPrompt(run.input), options })) {
      handle(run, m)
    }
  } catch (e) {
    if (!run.endReason) run.endReason = run.abort.signal.aborted ? (run.abort.signal.reason || 'cancelled') : 'error'
    run.emit('error', { message: String(e && e.message || e) })
  }
}

/**
 * Login placeholders: the AI types {{LOGIN_USERNAME}} / {{LOGIN_PASSWORD}}; the real values are put in
 * only on the way into a browser tool, so they never reach the AI, the log or the reports.
 * Returns null when the input has no placeholder.
 */
const TYPING_TOOLS = new Set(['mcp__chrome-devtools__fill', 'mcp__chrome-devtools__fill_form', 'mcp__chrome-devtools__type_text', 'mcp__browseros-neo__act'])

export function fillLogin(input, creds) {
  const name = input.tool_name || ''
  if (!JSON.stringify(input.tool_input || {}).includes('{{LOGIN_')) return null
  // Only tools that type into page fields; never scripts, navigation or reads (they could echo or send it elsewhere).
  if (!TYPING_TOOLS.has(name)) return deny('Login placeholders may only be typed into the sign-in form (fill, fill_form, type_text or act).')
  if (!creds) return deny('No login was handed over. Use ask_human kind=login first.')
  // Replacer functions, so "$" patterns in a password are kept literally.
  const sub = v => typeof v === 'string' ? v.replace(/\{\{LOGIN_USERNAME\}\}/g, () => creds.username).replace(/\{\{LOGIN_PASSWORD\}\}/g, () => creds.password)
    : Array.isArray(v) ? v.map(sub) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)])) : v
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: sub(input.tool_input) } }
}

function deny(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
}

function handle(run, m) {
  switch (m.type) {
    case 'system':
      if (m.subtype === 'init') {
        run.sessionId = m.session_id
        if (m.apiKeySource && m.apiKeySource !== 'none') {
          run.endReason = 'not_subscription'
          run.emit('error', { message: `Claude is using an API key (${m.apiKeySource}), not your subscription login. Remove it and run \`claude login\`.` })
          run.abort.abort('not_subscription')
          return
        }
        const st = n => ((m.mcp_servers || []).find(s => s.name === n) || {}).status
        const ok = v => v && v !== 'failed' && v !== 'needs-auth' && v !== 'disabled'
        if (!ok(st('browseros-neo')) && !ok(st('chrome-devtools'))) {
          run.endReason = 'no_browser'
          run.emit('error', { message: 'No browser could start: BrowserOS is not reachable and Chrome did not open.' })
          run.abort.abort('no_browser')
          return
        }
        if (st('browseros-neo') === 'failed') run.emit('warning', { text: 'BrowserOS did not connect, so this check runs in Chrome only.' })
        run.emit('log', { text: `Agent started · model ${m.model} · MCP: ${(m.mcp_servers || []).map(s => `${s.name}=${s.status}`).join(', ')}` })
      } else if (m.subtype === 'api_retry') {
        run.emit('log', { text: `API retry ${m.attempt} (${m.error_status || ''})` })
      }
      break
    case 'assistant': {
      if (m.error) {
        run.emit('error', { message: `Claude error: ${m.error}${m.error === 'authentication_failed' ? ' — run `claude login`' : ''}` })
        if (m.error === 'authentication_failed') run.endReason = 'auth'
      }
      for (const b of (m.message && m.message.content) || []) {
        if (b.type === 'text' && b.text.trim()) run.emit('log', { text: b.text.trim() })
        if (b.type === 'tool_use') {
          run.toolUses.set(b.id, { name: b.name, input: b.input || {} })
          if (/__(new_page|navigate_page|navigate)$/.test(b.name) || (/browseros-neo__tabs$/.test(b.name) && (b.input || {}).action === 'new')) run.lastNavAt = Date.now()
          const i = b.input || {}
          const args = {}
          for (const k of ['url', 'action', 'value', 'text', 'query', 'key', 'for', 'stage']) if (typeof i[k] === 'string') args[k] = i[k].slice(0, 160)
          run.emit('log', { text: `→ ${b.name.replace(/^mcp__/, '')} ${short(i)}`, tool: true, name: b.name.replace(/^mcp__/, ''), args })
        }
      }
      break
    }
    case 'user': {
      for (const b of (m.message && Array.isArray(m.message.content) && m.message.content) || []) {
        if (b.type !== 'tool_result') continue
        const use = run.toolUses && run.toolUses.get(b.tool_use_id)
        if (!use || b.is_error) continue
        if (/browseros-neo__screenshot$/.test(use.name)) {
          const img = (Array.isArray(b.content) ? b.content : []).find(c => c.type === 'image' && c.source && c.source.data)
          if (img) {
            const ext = /png/.test(img.source.media_type || '') ? 'png' : /webp/.test(img.source.media_type || '') ? 'webp' : 'jpg'
            const name = `shot-${String(++run.shotCount).padStart(3, '0')}.${ext}`
            try { writeFileSync(join(run.screenshotsDir, name), Buffer.from(img.source.data, 'base64')); run.lastShot = name; run.lastShotAt = Date.now() } catch {}
          }
        } else if (/chrome-devtools__take_screenshot$/.test(use.name) && use.input.filePath) {
          const name = basename(use.input.filePath)
          if (existsSync(join(run.screenshotsDir, name))) { run.lastShot = name; run.lastShotAt = Date.now() }
        }
      }
      break
    }
    case 'rate_limit_event': {
      const i = m.rate_limit_info || {}
      if (i.status === 'rejected') {
        run.rateLimit = { resetsAt: i.resetsAt || null, type: i.rateLimitType || null }
        run.emit('rate', { status: 'rejected', ...run.rateLimit })
      } else if (i.status === 'allowed_warning') {
        run.emit('rate', { status: 'warning', utilization: i.utilization, type: i.rateLimitType, resetsAt: i.resetsAt })
      }
      break
    }
    case 'result':
      run.usage = { costUsd: m.total_cost_usd, turns: m.num_turns, durationMs: m.duration_ms, tokens: sumTokens(m.modelUsage) }
      if (m.subtype === 'success') {
        run.result = m.structured_output || null
        run.endReason = 'completed'
      } else {
        if (m.terminal_reason === 'blocking_limit' || run.rateLimit) run.endReason = 'rate_limited'
        else if (m.subtype === 'error_max_turns') run.endReason = 'max_turns'
        else run.endReason = run.endReason || m.terminal_reason || m.subtype
        run.emit('log', { text: `Run ended: ${m.subtype}${m.terminal_reason ? ` (${m.terminal_reason})` : ''}` })
      }
      break
  }
}

export { handle as _handleForTest }
