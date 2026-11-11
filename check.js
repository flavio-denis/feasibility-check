// Self-check: `node check.js`. No network, no Claude usage.
import assert from 'node:assert/strict'
import { computeVerdict, requiredCoreKeys } from './verdict.js'
import { detectBotBlock, classifyProbe } from './detect.js'
import { jiraSection, verdictReason, nextSteps, statusPhrase, loginUsedOf, clientLine } from './report.js'
import { solverFor } from './solvers.js'
import { vpnReply } from './tools.js'
import { _handleForTest as handle, fillLogin, firstPrompt, sumTokens } from './agent.js'

const allPass = Object.fromEntries(requiredCoreKeys().map(k => [k, { area: k.split(':')[0], page: k.split(':')[1], status: 'pass', evidence: 'ok' }]))

// Verdict rules
assert.equal(computeVerdict(allPass, { completed: true }).core, 'Feasible')
assert.equal(computeVerdict({ ...allPass, 'dom:search': { ...allPass['dom:search'], status: 'needs_csm' } }, { completed: true }).core, 'Needs CSM')
assert.equal(computeVerdict({ ...allPass, 'dom:detail': { ...allPass['dom:detail'], status: 'fail' } }, { completed: true }).core, 'Not feasible')
const { ['login:search']: _, ...missingOne } = allPass
assert.equal(computeVerdict(missingOne, { completed: true }).core, 'Incomplete', 'missing checks = run again, not a CSM question')
assert.equal(computeVerdict(allPass, { completed: false }).core, 'Incomplete')
// Optional checks never change the core verdict
const withMla = { ...allPass, 'mla:store': { area: 'mla', page: 'store', status: 'fail', evidence: 'same data' } }
const v = computeVerdict(withMla, { completed: true, options: { mla: true, banner: true } })
assert.equal(v.core, 'Feasible')
assert.equal(v.optional.mla, 'Not feasible')
assert.equal(v.optional.banner, 'Not checked')

// Core rule: a CAPTCHA never makes a retailer Not feasible
const bypassed = { ...allPass, 'bot:site': { area: 'bot', page: 'site', status: 'bypass_needed', evidence: 'Cloudflare, solved manually' } }
const vb = computeVerdict(bypassed, { completed: true })
assert.equal(vb.core, 'Feasible', 'bypass_needed does not lower the verdict')
assert.equal(vb.bypass[0].page, 'site')
const { ['login:detail']: _l, ['dom:detail']: _d, ...blockedDetail } = allPass
blockedDetail['dom:detail'] = { area: 'dom', page: 'detail', status: 'blocked', evidence: 'DataDome on the product page' }
const vbl = computeVerdict(blockedDetail, { completed: true })
assert.equal(vbl.core, 'Manual check needed', 'content unreachable in every browser = manual check')
assert.deepEqual(vbl.missing, [], 'checks skipped on a blocked page are not listed as missing')
const homeBlocked = { 'open:site': { area: 'open', page: 'site', status: 'blocked', evidence: 'geo block' } }
assert.equal(computeVerdict(homeBlocked, { completed: true }).core, 'Manual check needed')
assert.equal(computeVerdict(homeBlocked, { completed: true, options: { banner: true } }).optional.banner, 'Manual check needed', 'banner not run because site blocked')
const notShop = { ...blockedDetail, 'open:site': { area: 'open', page: 'site', status: 'fail', evidence: 'corporate site' } }
assert.equal(computeVerdict(notShop, { completed: true }).core, 'Not feasible', 'a real content failure still wins')

// Bot detection
const cfChallenge = '<html><head><title>Just a moment...</title></head><body><div id="cf-challenge-running"></div><script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script></body></html>'
const cf = detectBotBlock(cfChallenge)
assert.ok(cf.blocked && cf.vendors.includes('cloudflare'), 'Cloudflare challenge is flagged')
const healthy = `<html><head><title>Organic Bananas 1kg | Shop</title><script src="https://www.google.com/recaptcha/api.js"></script></head><body><h1>Organic Bananas 1kg</h1><p>${'Fresh fruit, delivered daily. '.repeat(60)}</p><span class="price">€1.99</span></body></html>`
assert.equal(detectBotBlock(healthy).blocked, false, 'healthy page with a script tag is not blocked')
assert.ok(classifyProbe({ title: 'Shop', textLength: 5000, cookieNames: ['_abck', 'bm_sz'] }).vendors.includes('akamai'), 'Akamai cookies reveal the vendor')
assert.equal(classifyProbe({ title: 'Not available', textLength: 3000, textSample: 'This store is not available in your country' }).geo, true)
assert.equal(solverFor(['cloudflare', 'datadome']).solver, 'no', 'weakest vendor decides')

// Report escapes site text
const run = {
  input: { name: 'Evil<script>', url: 'https://x.test/' },
  checks: { 'open:site': { area: 'open', page: 'site', status: 'pass', evidence: '<img src=x onerror=alert(1)>' } },
  result: { testUrls: { detail: 'https://x.test/p?a=<b>' } },
  verdict: computeVerdict({}, { completed: true }),
  startedAt: 0, endedAt: 120000
}
const j = jiraSection(run)
assert.ok(!j.html.includes('<script>') && !j.html.includes('<img'), 'HTML is escaped')
assert.ok(j.html.includes('Incomplete') && j.md.includes('Not checked'), 'missing checks are listed')

// Usage-limit handling: rejected rate event + blocking_limit result => paused (rate_limited)
const fake = { abort: new AbortController(), emit: () => {}, checks: {} }
handle(fake, { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1790000000, rateLimitType: 'five_hour' } })
handle(fake, { type: 'result', subtype: 'error_during_execution', terminal_reason: 'blocking_limit', total_cost_usd: 0, num_turns: 3 })
assert.equal(fake.endReason, 'rate_limited')
assert.equal(fake.rateLimit.type, 'five_hour')
// API key instead of subscription => abort
const keyed = { abort: new AbortController(), emit: () => {}, checks: {} }
handle(keyed, { type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY', mcp_servers: [] })
assert.equal(keyed.endReason, 'not_subscription')
assert.ok(keyed.abort.signal.aborted)

// Verdict reasons
assert.equal(verdictReason(allPass, computeVerdict(allPass, { completed: true })), 'All core checks passed.')
assert.match(verdictReason(bypassed, vb), /bot protection/)
assert.match(verdictReason(blockedDetail, vbl), /could open the product page/)
assert.match(verdictReason(notShop, computeVerdict(notShop, { completed: true })), /^Site opens failed on site: corporate site/)
assert.match(verdictReason(missingOne, computeVerdict(missingOne, { completed: true }), { endReason: 'completed' }), /1 check was not recorded. Run it again/)
assert.match(verdictReason({}, computeVerdict({}, { completed: false }), { endReason: 'no_browser' }), /No browser could start/)

// Next steps per verdict
const nsF = nextSteps(vb, bypassed, { vendors: ['cloudflare'], testUrls: {} })
assert.equal(nsF.steps[0].action, 'copyReport'); assert.match(nsF.note, /needs a bypass/)
const nsN = nextSteps(computeVerdict(notShop, { completed: true }), notShop, {})
assert.equal(nsN.quote, 'corporate site'); assert.match(nsN.steps[1].text, /Not Feasible/)
const csmChecks = { ...allPass, 'dom:detail': { area: 'dom', page: 'detail', status: 'needs_csm', evidence: 'price only in the cart.' } }
const nsC = nextSteps(computeVerdict(csmChecks, { completed: true }), csmChecks, {})
assert.equal(nsC.csmQuestions.length, 1); assert.match(nsC.csmQuestions[0], /visible data enough/); assert.match(nsC.steps[2].text, /Awaiting CS Input/)
const nsM = nextSteps(vbl, blockedDetail, { testUrls: { detail: 'https://x.test/p/1' } })
assert.deepEqual(nsM.manualChecklist.map(m => [m.page, m.url]), [['product page', 'https://x.test/p/1']])
const nsH = nextSteps(computeVerdict(homeBlocked, { completed: true }), homeBlocked, {}, { url: 'https://x.test/' })
assert.equal(nsH.manualChecklist[0].url, 'https://x.test/')
const both = { 'open:site': { area: 'open', page: 'site', status: 'blocked', evidence: 'x' }, 'bot:site': { area: 'bot', page: 'site', status: 'blocked', evidence: 'x' } }
assert.equal(nextSteps(computeVerdict(both, { completed: true }), both, {}, { url: 'https://x.test/' }).manualChecklist.length, 1, 'one entry per page')
assert.equal(nextSteps(computeVerdict({}, { completed: false }), {}, {}).steps[0].action, 'runAgain')
assert.equal(statusPhrase({ area: 'login', status: 'needs_csm' }), 'Login needed, no account')
assert.equal(statusPhrase({ area: 'bot', status: 'bypass_needed' }), 'Bot protection, bypass needed')

// BrowserOS screenshots in tool results are saved, and become the latest screenshot
{
  const { mkdtempSync, existsSync: ex } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(tmpdir() + '/feas-check-')
  const r = { abort: new AbortController(), emit: () => {}, checks: {}, toolUses: new Map(), screenshotsDir: dir, shotCount: 0, lastShot: null }
  handle(r, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__browseros-neo__screenshot', input: { page: 3 } }] } })
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64')
  handle(r, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] }] } })
  assert.equal(r.lastShot, 'shot-001.png'); assert.ok(ex(dir + '/shot-001.png'))
}
// No browser at all = abort; BrowserOS down but Chrome up = warning only
{
  const r1 = { abort: new AbortController(), emit: () => {}, checks: {} }
  handle(r1, { type: 'system', subtype: 'init', apiKeySource: 'none', mcp_servers: [{ name: 'browseros-neo', status: 'failed' }, { name: 'chrome-devtools', status: 'failed' }] })
  assert.equal(r1.endReason, 'no_browser')
  const warns = []
  const r2 = { abort: new AbortController(), emit: (t, d) => t === 'warning' && warns.push(d), checks: {} }
  handle(r2, { type: 'system', subtype: 'init', apiKeySource: 'none', mcp_servers: [{ name: 'browseros-neo', status: 'failed' }, { name: 'chrome-devtools', status: 'connected' }] })
  assert.equal(r2.endReason, undefined); assert.equal(warns.length, 1)
}

// Country block opened with a VPN, and a login account: still Feasible, with notes
{
  const c = { ...allPass, 'open:site': { area: 'open', page: 'site', status: 'bypass_needed', evidence: 'Blocked outside Lithuania; opened with a VPN set to Lithuania.' } }
  for (const p of ['category', 'search', 'detail']) c[`login:${p}`] = { area: 'login', page: p, status: 'account_needed', evidence: 'Prices show after signing in.' }
  const v = computeVerdict(c, { completed: true })
  assert.equal(v.core, 'Feasible')
  assert.equal(v.geo.length, 1); assert.deepEqual(v.account, ['category', 'search', 'detail'])
  const n = nextSteps(v, c, {})
  assert.ok(n.notes.some(t => /Country block/.test(t)) && n.notes.some(t => /^Login/.test(t)))
  assert.match(verdictReason(c, v), /country block and a login/)
  assert.ok(/Country block/.test(jiraSection({ input: { name: 'X', url: 'u' }, checks: c, result: {}, verdict: v, startedAt: 0, endedAt: 1 }).md))
}
// No login available = Needs CSM with a question about getting one
{
  const c = { ...allPass, 'login:detail': { area: 'login', page: 'detail', status: 'needs_csm', evidence: 'Prices need a login and no account was available.' } }
  const v = computeVerdict(c, { completed: true })
  assert.equal(v.core, 'Needs CSM')
  assert.match(nextSteps(v, c, {}).csmQuestions[0], /client provide a login/)
  const c2 = { ...c, 'login:search': { ...c['login:detail'], page: 'search' }, 'dom:search': { area: 'dom', page: 'search', status: 'needs_csm', evidence: 'no prices' } }
  const q2 = nextSteps(computeVerdict(c2, { completed: true }), c2, {}).csmQuestions
  assert.equal(q2.length, 1, 'one login question for the site, no repeated data-hidden questions'); assert.match(q2[0], /search page, product page/)
}
// Store pages failing only affects the store-pages line; the old core store check is no longer judged
{
  const c = { ...allPass, 'mla:store': { area: 'mla', page: 'store', status: 'fail', evidence: 'Only delivery addresses, no pickup stores.' }, 'store:site': { area: 'store', page: 'site', status: 'needs_csm', evidence: 'old' } }
  const v = computeVerdict(c, { completed: true, options: { mla: true } })
  assert.equal(v.core, 'Feasible'); assert.equal(v.optional.mla, 'Not feasible')
}
// Login placeholders are filled only for browser tools, and literally (no "$&" surprises)
{
  const creds = { username: 'ana@x.lt', password: 'p$&w"d' }
  const out = fillLogin({ tool_name: 'mcp__browseros-neo__act', tool_input: { fields: [{ ref: 'e1', value: '{{LOGIN_USERNAME}}' }, { ref: 'e2', value: '{{LOGIN_PASSWORD}}' }] } }, creds)
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow')
  assert.deepEqual(out.hookSpecificOutput.updatedInput.fields.map(f => f.value), ['ana@x.lt', 'p$&w"d'])
  assert.equal(fillLogin({ tool_name: 'mcp__feas__record_check', tool_input: { evidence: 'pw {{LOGIN_PASSWORD}}' } }, creds).hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(fillLogin({ tool_name: 'mcp__chrome-devtools__fill', tool_input: { value: '{{LOGIN_PASSWORD}}' } }, null).hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(fillLogin({ tool_name: 'mcp__chrome-devtools__fill', tool_input: { value: 'milk' } }, creds), null)
  // Scripts, navigation and reads may never receive the real values (they could echo or send them away)
  for (const t of ['mcp__chrome-devtools__evaluate_script', 'mcp__browseros-neo__evaluate_in_page', 'mcp__browseros-neo__run', 'mcp__chrome-devtools__navigate_page', 'mcp__browseros-neo__navigate'])
    assert.equal(fillLogin({ tool_name: t, tool_input: { function: "() => '{{LOGIN_PASSWORD}}'", url: 'https://evil.test/?p={{LOGIN_PASSWORD}}' } }, creds).hookSpecificOutput.permissionDecision, 'deny', t)
}

// Signed in, but the account shows no prices: say so, don't claim "no account"
{
  const c = { ...allPass }
  for (const p of ['category', 'search', 'detail']) {
    c[`login:${p}`] = { area: 'login', page: p, status: 'needs_csm', evidence: 'Signed in with the account provided, but no prices show.' }
    c[`dom:${p}`] = { area: 'dom', page: p, status: 'needs_csm', evidence: 'No price for this account.' }
  }
  const v = computeVerdict(c, { completed: true })
  const n = nextSteps(v, c, {}, {}, { loginUsed: true })
  assert.equal(n.csmQuestions.length, 1); assert.match(n.csmQuestions[0], /account that shows prices/)
  assert.equal(verdictReason(c, v, { loginUsed: true }), 'The CSM needs to confirm: the account we signed in with shows no prices.')
  assert.equal(statusPhrase(c['login:detail'], { loginUsed: true }), 'Signed in, but no prices for this account')
  assert.ok(loginUsedOf({ checks: c }), 'older runs: detected from the evidence')
  assert.match(nextSteps(v, c, {}).csmQuestions[0], /no account/, 'without a login it still asks for one')
}

// Prices are the only thing missing: the team can decide to onboard without prices
{
  const c = { ...allPass }
  for (const p of ['category', 'search', 'detail']) {
    c[`login:${p}`] = { area: 'login', page: p, status: 'needs_csm', evidence: 'Signed in, but no prices show.' }       // heuristic (older runs)
    c[`dom:${p}`] = { area: 'dom', page: p, status: 'needs_csm', evidence: 'Name, stock, image present.', priceOnly: true } // explicit flag
  }
  const base = computeVerdict(c, { completed: true })
  assert.equal(base.core, 'Needs CSM'); assert.equal(base.priceOnly, true)
  assert.equal(nextSteps(base, c, {}).priceDecision, true)
  const v = computeVerdict(c, { completed: true, decision: 'no_price' })
  assert.equal(v.core, 'Feasible'); assert.equal(v.withoutPrices, true)
  assert.match(verdictReason(c, v), /without prices/)
  const j = jiraSection({ input: { name: 'X', url: 'u' }, checks: c, result: {}, verdict: v, startedAt: 0, endedAt: 1, decisionAt: Date.UTC(2026, 10, 8) })
  assert.match(j.md, /Feasible \(without prices\)/); assert.match(j.md, /decided by the ROB team on 2026-11-08/)
  assert.equal(computeVerdict(c, { completed: true, decision: 'ask_csm' }).core, 'Needs CSM')
  // Any other problem: no price-only choice, and a no_price decision changes nothing
  const c2 = { ...c, 'dom:search': { area: 'dom', page: 'search', status: 'needs_csm', evidence: 'Results never load.' } }
  const v2 = computeVerdict(c2, { completed: true, decision: 'no_price' })
  assert.equal(v2.priceOnly, false); assert.equal(v2.core, 'Needs CSM'); assert.equal(v2.withoutPrices, false)
  // A real failure (no products) is never price-only
  const c3 = { ...c, 'dom:category': { area: 'dom', page: 'category', status: 'fail', evidence: 'No products, no prices.' } }
  assert.equal(computeVerdict(c3, { completed: true, decision: 'no_price' }).core, 'Not feasible')
}

// Login that needs a one-time code every time: not feasible, but ask the CSM for a login without it first
{
  const c = { ...allPass, 'login:detail': { area: 'login', page: 'detail', status: 'fail', evidence: 'Signing in needs a one-time code (2FA/OTP) every time; the crawler cannot do this.' } }
  const v = computeVerdict(c, { completed: true })
  assert.equal(v.core, 'Not feasible')
  assert.equal(statusPhrase(c['login:detail']), 'Login needs a one-time code')
  assert.match(nextSteps(v, c, {}).steps[1].text, /login that doesn’t need a one-time code/)
  assert.equal(statusPhrase({ area: 'banner', status: 'fail', evidence: 'Banners are not supported for Amazon retailers (team policy).' }), 'Not supported for Amazon')
}

// Review fixes: a bot "fail" never counts; price-only needs a needs-CSM status; stock gaps are not price-only
{
  const botFail = { ...allPass, 'bot:site': { area: 'bot', page: 'site', status: 'fail', evidence: 'CAPTCHA' } }
  const v = computeVerdict(botFail, { completed: true })
  assert.equal(v.core, 'Feasible'); assert.equal(v.bypass.length, 1)
  const failPrice = { ...allPass, 'dom:detail': { area: 'dom', page: 'detail', status: 'fail', evidence: 'no products', priceOnly: true } }
  assert.equal(computeVerdict(failPrice, { completed: true, decision: 'no_price' }).core, 'Not feasible')
  const stock = { ...allPass, 'login:detail': { area: 'login', page: 'detail', status: 'needs_csm', evidence: 'Prices and stock need a login.' } }
  assert.equal(computeVerdict(stock, { completed: true }).priceOnly, false)
}

// Client brands: optional input, never changes the verdict, flagged when no brand was found
{
  assert.match(firstPrompt({ name: 'Bite-LT', url: 'https://bite.lt/', client: 'Acme Foods' }), /^Client: Acme Foods$/m)
  assert.match(firstPrompt({ name: 'Bite-LT', url: 'https://bite.lt/' }), /^Client: none$/m, 'no client = any product')
  assert.equal(clientLine({ name: 'X' }, { clientBrands: ['Crunchy'] }), null, 'no client, no line')
  assert.equal(clientLine({ client: 'Acme Foods' }, null), 'Acme Foods', 'run not finished: name only')
  assert.equal(clientLine({ client: 'Acme Foods' }, { clientBrands: ['Crunchy', 'Choco'] }), 'Acme Foods. Brands used: Crunchy, Choco.')
  assert.match(clientLine({ client: 'Acme Foods' }, { clientBrands: [] }), /No Acme Foods products were found/)
  const feasible = computeVerdict(allPass, { completed: true })
  const withBrands = { testUrls: {}, clientBrands: ['Crunchy'] }, noBrands = { testUrls: {}, clientBrands: [] }
  assert.equal(nextSteps(feasible, allPass, withBrands, { client: 'Acme Foods' }).notes.length, 0, 'brands found: nothing to flag')
  assert.match(nextSteps(feasible, allPass, noBrands, { client: 'Acme Foods' }).notes.join(' '), /no Acme Foods products/)
  assert.equal(nextSteps(feasible, allPass, noBrands, {}).notes.length, 0, 'no client: nothing to flag')
  const csmChecks2 = { ...allPass, 'dom:search': { ...allPass['dom:search'], status: 'needs_csm', evidence: 'x' } }
  assert.ok(nextSteps(computeVerdict(csmChecks2, { completed: true }), csmChecks2, noBrands, { client: 'Acme Foods' }).csmQuestions.some(q => /Does Acme Foods sell/.test(q)))
  const jr = jiraSection({ input: { name: 'R', url: 'https://r.test/', client: '<b>Evil</b>' }, checks: allPass, result: { clientBrands: ['<i>x</i>'] }, verdict: feasible, startedAt: 0, endedAt: 1 })
  assert.ok(jr.html.includes('<strong>Client:</strong> &lt;b&gt;Evil&lt;/b&gt;') && !jr.html.includes('<i>x</i>'), 'client text escaped')
  assert.match(jr.md, /\*\*Client:\*\* <b>Evil<\/b>\. Brands used: <i>x<\/i>\./)
  assert.ok(!jiraSection({ input: { name: 'R', url: 'https://r.test/' }, checks: allPass, result: {}, verdict: feasible, startedAt: 0, endedAt: 1 }).md.includes('Client'), 'old runs: no client line')
}

// VPN: after "VPN on" the agent is told to hard-refresh; at most 2 asks per run
assert.match(vpnReply('vpn_on', 1), /^vpn_on: hard-refresh/)
assert.match(vpnReply('vpn_on', 2), /ignoreCache: true/, 'BrowserOS hard refresh skips the cache')
assert.match(vpnReply('vpn_on', 1), /type "reload" and ignoreCache true/, 'Chrome hard refresh skips the cache')
assert.equal(vpnReply('no_vpn', 1), 'no_vpn')
assert.equal(vpnReply('timeout', 2), 'timeout')
assert.match(vpnReply(null, 3), /^limit_reached/, 'third ask is refused without bothering the person')

// Store pages not reachable (no VPN): core verdict unchanged, a manual step is added
{
  const ch = { ...allPass, 'mla:store': { area: 'mla', page: 'store', status: 'blocked', evidence: 'kept loading, no VPN' } }
  const vv = computeVerdict(ch, { completed: true, options: { mla: true } })
  assert.equal(vv.core, 'Feasible')
  assert.equal(vv.optional.mla, 'Manual check needed')
  assert.ok(nextSteps(vv, ch, {}).steps.some(s => /Check the store pages by hand/.test(s.text)))
  assert.ok(!nextSteps(computeVerdict(allPass, { completed: true, options: { mla: true } }), allPass, {}).steps.some(s => /by hand/.test(s.text)), 'no step when nothing is blocked')
}

// token totals sum every model's usage
{
  const t = sumTokens({ a: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 100, cacheCreationInputTokens: 20 }, b: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } })
  assert.deepEqual(t, { input: 11, output: 6, cacheRead: 100, cacheWrite: 20, total: 137 })
  assert.equal(sumTokens(undefined).total, 0)
}

console.log('check.js: all assertions passed')
