// Fixed verdict rules. The agent's opinion is shown as a note only.
//
// Rules from the user (2026-11-08):
// - A CAPTCHA / bot wall never makes a retailer Not feasible (onboarding bypasses bots).
// - A country block never makes it Not feasible either: the user turns on a VPN and the check goes on
//   (onboarding uses a tunnel for that country).
// - A login wall is fine when an account is available (the user signs in, or hands the login to the tool).
//   No account available = Needs CSM.
// - Store pages are their own line: set 3 pickup stores on category pages. Failing that makes only
//   "Store pages" not feasible, never the whole retailer.
// - If no browser can reach the content at all, the tool can't decide: "Manual check needed".

export const CORE_PAGES = ['category', 'search', 'detail']
export const OPTIONAL = ['banner', 'mla']
export const MANUAL = 'Manual check needed'
// Statuses that pass the check but leave a note for onboarding.
const PASS_WITH_NOTE = ['bypass_needed', 'account_needed']

/** Every check the core verdict needs. Missing ones count as unknown. */
export function requiredCoreKeys() {
  const keys = ['open:site', 'bot:site'] // bot protection is one check for the whole retailer
  for (const p of CORE_PAGES) keys.push(`login:${p}`, `dom:${p}`)
  return keys
}

/**
 * Check statuses: pass | fail | needs_csm | unknown | bypass_needed | account_needed | blocked
 *  - bypass_needed: bot protection (bot) or a country block opened with a VPN (open); onboarding needs a bypass/tunnel.
 *  - account_needed (login): prices need signing in, and an account was available.
 *  - blocked: no browser could reach the content of that page.
 * @param {Record<string,{status:string, evidence?:string}>} checks keyed `${area}:${page}`
 * @param {{completed:boolean, options:{banner?:boolean, mla?:boolean}}} run
 */
/**
 * Is this problem only about prices? (The agent flags it with priceOnly; older runs: a needs-CSM
 * login or data check whose evidence talks about prices.)
 */
export function isPriceOnly(key, c) {
  // Only a needs-CSM gap can be waived; a fail or a blocked page never can.
  if (c.status !== 'needs_csm' || !['login', 'dom'].includes(key.split(':')[0])) return false
  if (c.priceOnly !== undefined) return c.priceOnly === true
  // Runs from before the flag existed: the evidence must talk about prices and not about stock.
  return /\bprices?\b|\bpricing\b/i.test(c.evidence || '') && !/\bstock\b|availability/i.test(c.evidence || '')
}

/**
 * @param decision 'no_price' = the team decided to onboard without prices; 'ask_csm' = keep asking the CSM.
 */
export function computeVerdict(checks, { completed, options = {}, decision = null }) {
  const entries = Object.entries(checks)
  // A bot wall never counts against a retailer: an old "fail" on a bot check is read as "bypass needed".
  const bypass = entries.filter(([k, c]) => k.startsWith('bot:') && ['bypass_needed', 'fail'].includes(c.status)).map(([k, c]) => ({ page: k.split(':')[1], evidence: c.evidence }))
  const geo = entries.filter(([k, c]) => k === 'open:site' && c.status === 'bypass_needed').map(([, c]) => c.evidence)
  const account = entries.filter(([k, c]) => k.startsWith('login:') && c.status === 'account_needed').map(([k]) => k.split(':')[1])
  const blockedPages = entries.filter(([, c]) => c.status === 'blocked').map(([k]) => k)
  if (!completed) return { core: 'Incomplete', optional: {}, missing: [], bypass, geo, account, blockedPages }

  // The old core "store:site" check (before 2026-11-08) is shown but no longer judged.
  const core = entries.filter(([k]) => !OPTIONAL.includes(k.split(':')[0]) && k !== 'store:site')
  const judged = core.filter(([k, c]) => !(k.startsWith('bot:') && ['pass', 'fail'].includes(c.status)) && !PASS_WITH_NOTE.includes(c.status))
  const blockedCorePages = new Set(judged.filter(([, c]) => c.status === 'blocked').map(([k]) => k.split(':')[1]))
  // Checks that could not run because their page was blocked are covered by "Manual check needed".
  const missing = requiredCoreKeys().filter(k => !checks[k] && !blockedCorePages.has(k.split(':')[1]) && !blockedCorePages.has('site'))

  let verdict = 'Feasible'
  if (judged.some(([, c]) => c.status === 'fail')) verdict = 'Not feasible'
  else if (blockedCorePages.size) verdict = MANUAL
  else if (judged.some(([, c]) => ['needs_csm', 'unknown'].includes(c.status))) verdict = 'Needs CSM'
  else if (missing.length) verdict = 'Incomplete' // checks were skipped: run it again, nothing to ask the CSM yet

  // Some retailers are onboarded without prices. When prices are the only thing missing, the team may
  // decide that themselves instead of asking the CSM.
  const problems = judged.filter(([, c]) => c.status !== 'pass')
  const priceOnly = !missing.length && problems.length > 0 && problems.every(([k, c]) => isPriceOnly(k, c))
  let withoutPrices = false
  if (priceOnly && decision === 'no_price') { verdict = 'Feasible'; withoutPrices = true }

  const optional = {}
  for (const area of OPTIONAL) {
    if (!options[area]) continue
    const c = entries.filter(([k]) => k.startsWith(`${area}:`)).map(([, v]) => v)
    optional[area] = !c.length ? (blockedCorePages.has('site') ? MANUAL : 'Not checked')
      : c.some(x => x.status === 'fail') ? 'Not feasible'
      : c.some(x => x.status === 'blocked') ? MANUAL
      : c.some(x => !['pass', ...PASS_WITH_NOTE].includes(x.status)) ? 'Needs CSM'
      : 'Feasible'
  }
  return { core: verdict, optional, missing, bypass, geo, account, blockedPages, priceOnly, withoutPrices, decision: priceOnly ? decision : null }
}
