// Report rendering. Every site-derived string goes through esc().

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const AREA_LABEL = { open: 'Site opens', bot: 'Bot protection', login: 'Login', dom: 'Product data', store: 'Store selection', banner: 'Banners', mla: 'Store pages' }
const ORDER = ['open', 'bot', 'login', 'dom', 'store', 'banner', 'mla']
const OPTIONAL_AREAS = ['banner', 'mla']
const PAGE_ORDER = ['site', 'home', 'category', 'search', 'detail', 'store']

export function sortedChecks(checks) {
  return Object.values(checks).sort((a, b) =>
    ORDER.indexOf(a.area) - ORDER.indexOf(b.area) || PAGE_ORDER.indexOf(a.page) - PAGE_ORDER.indexOf(b.page))
}

const STATUS_WORD = { fail: 'failed', needs_csm: 'needs CSM', unknown: 'not checked', blocked: 'unreachable' }

/** Was a login used in this run (the user signed in, or handed one over)? Older runs: read it from the evidence. */
export function loginUsedOf(run) {
  if (typeof run.loginUsed === 'boolean' && run.loginUsed) return true
  return Object.values(run.checks || {}).some(c => c.area === 'login' && (c.status === 'account_needed' || /signed in with the account/i.test(c.evidence || '')))
}

/** One plain sentence that explains the verdict from the recorded checks. */
const END_REASON = {
  auth: 'Claude isn’t signed in on this computer.',
  not_subscription: 'Claude is set up with an API key instead of a Claude login.',
  no_browser: 'No browser could start: BrowserOS was closed and Chrome was not available.',
  max_turns: 'The check took too many steps and stopped.',
  timeout: 'The check stopped after 60 minutes.',
  cancelled: 'You cancelled the check.',
  server_restart: 'The app was closed or restarted during the check.',
  rate_limited: 'Claude’s usage limit was reached.'
}

export function verdictReason(checks, verdict, { loginUsed = false, endReason = null } = {}) {
  const rows = sortedChecks(checks)
  const core = rows.filter(c => !OPTIONAL_AREAS.includes(c.area) && c.area !== 'store') // store:site is a legacy check
  const name = c => `${AREA_LABEL[c.area].toLowerCase()} on ${c.page}`
  switch (verdict.core) {
    case 'Not feasible': {
      const f = core.filter(c => c.status === 'fail')
      return f.length ? f.map(c => `${AREA_LABEL[c.area]} failed on ${c.page}: ${c.evidence.replace(/[.\s]+$/, '')}.`).join(' ') : 'A core check failed.'
    }
    case 'Manual check needed': {
      // Use the agent's own reason when it explains the block (e.g. a country block with no VPN).
      const why = checks['open:site']?.status === 'blocked' && checks['open:site'].evidence
      if (why) return `${why.replace(/[.\s]+$/, '')}.`
      const b = (verdict.blockedPages || []).map(k => k.split(':')[1])
      const where = b.includes('site') || !b.length ? 'the site' : b.map(x => `the ${PAGE_NAME[x] || x}`).join(', ')
      return `No browser could open ${where}, so this needs a check by hand.`
    }
    case 'Needs CSM': {
      const n = core.filter(c => ['needs_csm', 'unknown'].includes(c.status))
      const loginPages = n.filter(c => c.area === 'login' && c.status === 'needs_csm').map(c => c.page)
      const parts = []
      if (loginPages.length) parts.push(loginUsed ? 'the account we signed in with shows no prices' : 'prices need a login and no account was available')
      // Hidden data on a login page is the same problem; list everything else once, in plain words.
      for (const c of n) {
        if (c.area === 'login' && c.status === 'needs_csm') continue
        if (c.area === 'dom' && loginPages.includes(c.page)) continue
        parts.push(`${(PAGE_NAME[c.page] || c.page)}: ${statusPhrase(c, { loginUsed }).toLowerCase()}`)
      }
      const t = parts.join('; ')
      return `The CSM needs to confirm: ${t.charAt(0).toLowerCase() + t.slice(1)}.`
    }
    case 'Feasible': {
      if (verdict.withoutPrices) return 'Everything except prices is there. Your team decided to onboard without prices.'
      const extra = []
      if ((verdict.bypass || []).length) extra.push('bot protection')
      if ((verdict.geo || []).length) extra.push('a country block')
      if ((verdict.account || []).length) extra.push('a login')
      return extra.length ? `All core checks passed. Onboarding will need to handle ${extra.join(', ').replace(/, ([^,]*)$/, ' and $1')}.` : 'All core checks passed.'
    }
    default: {
      const m = verdict.missing || []
      if (endReason === 'completed' && m.length) return `The check finished, but ${m.length} check${m.length > 1 ? 's were' : ' was'} not recorded. Run it again.`
      const why = END_REASON[endReason] || 'The check ended early.'
      const done = rows.length
      return `${why} ${done ? `${done} check${done > 1 ? 's were' : ' was'} recorded before it stopped.` : 'Nothing was recorded.'}`
    }
  }
}

const minutes = (a, b) => (a && b ? `${Math.max(1, Math.round((b - a) / 60000))} min` : 'n/a')

function testUrlList(result) {
  const t = (result && result.testUrls) || {}
  return ['home', 'category', 'search', 'detail', 'store'].filter(k => t[k]).map(k => [k, t[k]])
}

/** Copy-ready Jira text (jira-comment-style: strong labels, one <p> each, <ul> for 3+ items, no emoji). */
export function jiraSection(run) {
  const { input, checks, result, verdict, startedAt, endedAt } = run
  const date = new Date(endedAt || Date.now()).toISOString().slice(0, 10)
  const opt = Object.entries(verdict.optional || {}).map(([k, v]) => `${k === 'mla' ? 'Store pages' : 'Banners'}: ${v}`)
  const urls = testUrlList(result)
  const rows = sortedChecks(checks)

  const title = verdict.withoutPrices ? 'Feasible (without prices)' : verdict.core
  const decided = verdict.withoutPrices ? `Onboard without prices: decided by the ROB team${run.decisionAt ? ` on ${new Date(run.decisionAt).toISOString().slice(0, 10)}` : ''}. Prices will not be collected.` : ''
  const html = [
    `<p><strong>Feasibility check — ${esc(date)} — ${esc(title)}</strong></p>`,
    `<p>${esc(verdictReason(checks, verdict, { loginUsed: loginUsedOf(run) }))}</p>`,
    decided ? `<p><strong>Decision:</strong> ${esc(decided)}</p>` : '',
    `<p><strong>Retailer:</strong> ${esc(input.name)} (${esc(input.url)})</p>`,
    opt.length ? `<p><strong>Optional checks:</strong> ${esc(opt.join('; '))}</p>` : '',
    `<p><strong>Checks:</strong></p>`,
    `<ul>${rows.map(c => `<li>${esc(AREA_LABEL[c.area])} (${esc(c.page)}): ${esc(statusPhrase(c, { loginUsed: loginUsedOf(run) }))}. ${esc(c.evidence)}</li>`).join('')}</ul>`,
    verdict.missing && verdict.missing.length ? `<p><strong>Not checked:</strong> ${esc(verdict.missing.join(', '))}</p>` : '',
    verdict.bypass && verdict.bypass.length ? `<p><strong>Bot protection:</strong> ${esc((result && result.vendors && result.vendors.join(', ')) || 'yes')}. A bypass is needed in onboarding; this does not block feasibility.</p>` : '',
    verdict.geo && verdict.geo.length ? `<p><strong>Country block:</strong> ${esc(verdict.geo[0])}. Onboarding needs a tunnel for that country; this does not block feasibility.</p>` : '',
    verdict.account && verdict.account.length ? `<p><strong>Login:</strong> prices need signing in. Onboarding needs a login account; one was available for this check.</p>` : '',
    verdict.blockedPages && verdict.blockedPages.length ? `<p><strong>Content not reachable in any browser:</strong> ${esc(verdict.blockedPages.join(', '))}. Check these manually.</p>` : '',
    urls.length ? `<p><strong>Test URLs:</strong></p><ul>${urls.map(([k, u]) => `<li>${esc(k)}: ${esc(u)}</li>`).join('')}</ul>` : '',
    result && result.storeInfo ? `<p><strong>Store:</strong> ${esc(result.storeInfo)}</p>` : '',
    result && result.mlaInfo ? `<p><strong>Store pages:</strong> ${esc(result.mlaInfo)}</p>` : '',
    result && result.bannerInfo ? `<p><strong>Banner:</strong> ${esc(result.bannerInfo)}</p>` : '',
    result && result.vendors && result.vendors.length ? `<p><strong>Bot vendors seen:</strong> ${esc(result.vendors.join(', '))}</p>` : '',
    `<p><strong>Run time:</strong> ${esc(minutes(startedAt, endedAt))}</p>`
  ].filter(Boolean).join('\n')

  const md = [
    `**Feasibility check — ${date} — ${title}**`,
    verdictReason(checks, verdict, { loginUsed: loginUsedOf(run) }),
    '',
    decided ? `**Decision:** ${decided}` : '',
    `**Retailer:** ${input.name} (${input.url})`,
    opt.length ? `**Optional checks:** ${opt.join('; ')}` : '',
    '',
    '**Checks:**',
    ...rows.map(c => `- ${AREA_LABEL[c.area]} (${c.page}): ${statusPhrase(c, { loginUsed: loginUsedOf(run) })}. ${c.evidence}`),
    verdict.missing && verdict.missing.length ? `\n**Not checked:** ${verdict.missing.join(', ')}` : '',
    verdict.bypass && verdict.bypass.length ? `**Bot protection:** ${(result && result.vendors && result.vendors.join(', ')) || 'yes'}. A bypass is needed in onboarding; this does not block feasibility.` : '',
    verdict.geo && verdict.geo.length ? `**Country block:** ${verdict.geo[0]}. Onboarding needs a tunnel for that country; this does not block feasibility.` : '',
    verdict.account && verdict.account.length ? `**Login:** prices need signing in. Onboarding needs a login account; one was available for this check.` : '',
    verdict.blockedPages && verdict.blockedPages.length ? `**Content not reachable in any browser:** ${verdict.blockedPages.join(', ')}. Check these manually.` : '',
    urls.length ? '\n**Test URLs:**' : '',
    ...urls.map(([k, u]) => `- ${k}: ${u}`),
    result && result.storeInfo ? `\n**Store:** ${result.storeInfo}` : '',
    result && result.mlaInfo ? `**Store pages:** ${result.mlaInfo}` : '',
    result && result.bannerInfo ? `**Banner:** ${result.bannerInfo}` : '',
    result && result.vendors && result.vendors.length ? `**Bot vendors seen:** ${result.vendors.join(', ')}` : '',
    `**Run time:** ${minutes(startedAt, endedAt)}`
  ].filter(x => x !== '').join('\n')

  return { html, md }
}

/** Standalone report page saved as runs/<id>/report.html. */
export function reportPage(run) {
  const { html } = jiraSection(run)
  return `<!doctype html><meta charset="utf-8"><title>Feasibility — ${esc(run.input.name)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem}li{margin:.2rem 0}</style>
${html}`
}

// ---------- plain-language labels and next steps (UI) ----------

const PHRASE = {
  pass: { open: 'Site opens', bot: 'No bot challenge', login: 'No login needed', dom: 'Product data present', store: 'Store selection OK', banner: 'Banners found', mla: 'Pickup stores can be set' },
  fail: { open: "Site doesn't open as a shop", bot: 'Blocked', login: 'Login wall', dom: 'Product data missing', store: "Store can't be set", banner: 'No banners', mla: "Pickup store can't be set" },
  needs_csm: { open: 'Needs CSM', bot: 'Needs CSM', login: 'Login needed, no account', dom: 'Data partly hidden', store: 'No default store', banner: 'Banners need login or a store', mla: 'Needs CSM' },
  bypass_needed: { open: 'Opens with a VPN (country block)', bot: 'Bot protection, bypass needed' },
  account_needed: { login: 'Signed in with an account' },
  blocked: {}, unknown: {}
}
const PHRASE_ANY = { bypass_needed: 'Bypass needed', account_needed: 'Signed in with an account', blocked: 'Not reachable', unknown: 'Not checked' }

/** Short human label for one check, e.g. "Login needed, no account". */
export function statusPhrase(c, { loginUsed = false } = {}) {
  if (c.area === 'login' && c.status === 'needs_csm' && loginUsed) return 'Signed in, but no prices for this account'
  if (c.area === 'login' && c.status === 'fail' && /one-time code|2FA|OTP|two-factor|verification code/i.test(c.evidence || '')) return 'Login needs a one-time code'
  if (c.area === 'banner' && c.status === 'fail' && /Amazon/.test(c.evidence || '')) return 'Not supported for Amazon'
  return (PHRASE[c.status] && PHRASE[c.status][c.area]) || PHRASE_ANY[c.status] || c.status
}

const PAGE_NAME = { site: 'home page', home: 'home page', category: 'category page', search: 'search page', detail: 'product page', store: 'store page' }
const trim = s => String(s || '').replace(/[.\s]+$/, '')

function csmQuestion(c, loginUsed) {
  const page = PAGE_NAME[c.page] || c.page
  if (c.status === 'unknown') return `The ${page} could not be checked (${trim(c.evidence)}). Can we onboard without it?`
  switch (c.area) {
    case 'store': return `Prices or stock only show after a store is chosen and there is no default store (${trim(c.evidence)}). Can we onboard without a default store, and which store should we use?`
    case 'dom': return `On the ${page}, part of the product data is hidden (${trim(c.evidence)}). Is the visible data enough to onboard?`
    case 'login': return loginUsed ? `We signed in with the account provided, but it shows no prices (${trim(c.evidence)}). Can the client provide an account that shows prices?` : `The site needs a login to show prices or stock (${trim(c.evidence)}), and we have no account. Can the client provide a login for onboarding?`
    default: return `${trim(c.evidence)}. Can we proceed with onboarding?`
  }
}

const MANUAL_CHECKS = ['The page loads without a block', 'The price shows and finishes loading', 'Name, stock and images are present', 'No sign-in is needed to see the price']

/**
 * What the user should do next, by verdict.
 * @returns {{ steps: {text:string, action?:'copyReport'|'copyUrls'|'runAgain'|'resume'}[], csmQuestions: string[], manualChecklist: {page:string, url:string|null, items:string[]}[], quote: string|null, note: string|null }}
 */
export function nextSteps(verdict, checks, result, input = {}, { loginUsed = false } = {}) {
  const all = Object.values(checks || {})
  const core = all.filter(c => !OPTIONAL_AREAS.includes(c.area) && c.area !== 'store') // store:site is a legacy check
  const urls = (result && result.testUrls) || {}
  const vendors = (result && result.vendors) || []
  const out = { steps: [], csmQuestions: [], manualChecklist: [], quote: null, headline: null, note: null, notes: [] }
  switch (verdict.core) {
    case 'Feasible':
      out.steps.push({ text: 'Paste the report into the feasibility ticket', action: 'copyReport' })
      out.steps.push({ text: 'Move the ticket to Feasible' })
      out.steps.push({ text: 'When the onboarding ticket appears, add the test URLs', action: 'copyUrls' })
      out.notes = []
      if ((verdict.bypass || []).length) out.notes.push(`Bot protection${vendors.length ? ` (${vendors.join(', ')})` : ''}: onboarding needs a bypass.`)
      if ((verdict.geo || []).length) out.notes.push('Country block: the site only opened with a VPN. Onboarding needs a tunnel for that country.')
      if ((verdict.account || []).length) out.notes.push('Login: prices need signing in. Onboarding needs a login account.')
      out.note = out.notes.length ? out.notes.join(' ') : null
      break
    case 'Not feasible': {
      const f = core.find(c => c.status === 'fail')
      out.quote = f ? trim(f.evidence) : null
      out.headline = f ? `${statusPhrase(f)} (${PAGE_NAME[f.page] || f.page}).` : null
      out.steps.push({ text: 'Paste the report into the feasibility ticket', action: 'copyReport' })
      if (f && f.area === 'login' && /one-time code|2FA|OTP|two-factor/i.test(f.evidence || '')) out.steps.push({ text: 'Ask the CSM whether the client has a login that doesn’t need a one-time code. If not, move the ticket to Not Feasible' })
      else out.steps.push({ text: 'Move the ticket to Not Feasible' })
      break
    }
    case 'Needs CSM':
      out.priceDecision = !!verdict.priceOnly // prices are the only thing missing: the team may decide without the CSM
      {
        const open = core.filter(c => ['needs_csm', 'unknown'].includes(c.status))
        // One login question for the whole site; "data hidden" on those pages is the same problem, so it is not asked again.
        const loginPages = open.filter(c => c.area === 'login' && c.status === 'needs_csm').map(c => c.page).sort((a, b) => ['category', 'search', 'detail'].indexOf(a) - ['category', 'search', 'detail'].indexOf(b))
        if (loginPages.length) out.csmQuestions.push(loginUsed
          ? `We signed in with the account provided, but it shows no prices on the ${loginPages.map(p => PAGE_NAME[p] || p).join(', ')}. Can the client provide an account that shows prices?`
          : `The site needs a login to show prices or stock (${loginPages.map(p => PAGE_NAME[p] || p).join(', ')}), and we have no account. Can the client provide a login for onboarding?`)
        for (const c of open) {
          if (c.area === 'login' && c.status === 'needs_csm') continue
          if (c.area === 'dom' && loginPages.includes(c.page)) continue
          out.csmQuestions.push(csmQuestion(c, loginUsed))
        }
      }
      out.steps.push({ text: 'Ask the CSM the questions below' })
      out.steps.push({ text: 'Paste the report into the feasibility ticket', action: 'copyReport' })
      out.steps.push({ text: 'Move the ticket to Awaiting CS Input' })
      break
    case 'Manual check needed':
      out.manualChecklist = [...new Set((verdict.blockedPages || []).map(k => k.split(':')[1]))].map(page => {
        const url = page === 'site' || page === 'home' ? (urls.home || input.url || null) : (urls[page] || null)
        const items = MANUAL_CHECKS
        return { page: PAGE_NAME[page] || page, url, items }
      })
      out.steps.push({ text: 'Open the pages below yourself (try a VPN for the retailer’s country if the site is blocked)' })
      out.steps.push({ text: 'Paste the report into the feasibility ticket and add what you found', action: 'copyReport' })
      break
    default:
      out.steps.push({ text: 'Run the check again', action: 'runAgain' })
  }
  return out
}
