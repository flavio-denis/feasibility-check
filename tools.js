import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { classifyProbe } from './detect.js'
import { solverFor } from './solvers.js'

const HUMAN_TIMEOUT_MS = 15 * 60 * 1000
const MAX_CAPTCHA_ASKS_PER_VENDOR = 3
const MAX_VPN_ASKS = 2 // per run: the first ask, plus one more if the page still keeps loading

/** What the agent is told after a VPN answer. Pure, so check.js can test it. */
export function vpnReply(answer, asks) {
  if (asks > MAX_VPN_ASKS) return 'limit_reached: the human was already asked twice to turn on a VPN. Do not ask again; record this page as blocked and continue.'
  if (answer === 'vpn_on') return 'vpn_on: hard-refresh the page now (it reloads everything and skips the cache). BrowserOS: `run` with code `await browser.page(<pageId>).cdp(\'Page.reload\', JSON.stringify({ ignoreCache: true }))` using your tab\'s page id. Chrome: `navigate_page` with type "reload" and ignoreCache true. Wait 10 seconds, then probe and take a screenshot.'
  return answer
}

/**
 * CAPTCHA gate: ask the human only after the challenge was seen twice, at least 8 s apart
 * (many checks pass on their own). One re-check request per situation, so a challenge the
 * probe misses (seen only on the screenshot) still reaches the human on the next ask.
 */
export function captchaGate(blockedAt, rechecked) {
  if (blockedAt.length >= 2 && blockedAt.at(-1) - blockedAt[0] >= 8000) return 'ask'
  return rechecked ? 'ask' : 'recheck'
}
export const CAPTCHA_RECHECK = 'not_asked_yet: many checks pass on their own. Wait 10 seconds (browser wait tool), run the probe and detect_block again, and take a screenshot. Only if it is still blocked, call ask_human again.'

const text = t => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t) }] })

/**
 * In-process MCP server "feas", bound to one run.
 * run: { id, emit(type, data), recordCheck(check), waitForHuman(question, timeoutMs) -> Promise<answer> }
 */
export function makeFeasServer(run) {
  const captchaAsks = {}
  let vpnAsks = 0
  let blockedAt = [] // times detect_block said blocked, since the last CAPTCHA answer
  let captchaRechecked = false

  const recordCheck = tool(
    'record_check',
    'Record the result of one feasibility check as soon as you know it. Call again with the same area+page to overwrite.',
    {
      area: z.enum(['open', 'bot', 'login', 'dom', 'banner', 'mla']),
      page: z.enum(['site', 'home', 'category', 'search', 'detail', 'store']),
      status: z.enum(['pass', 'fail', 'needs_csm', 'unknown', 'bypass_needed', 'account_needed', 'blocked'])
        .describe('bypass_needed = bot protection passed, or (open) the site only opened with a VPN. account_needed = login: prices need signing in and an account was used. blocked = no browser could reach this page\'s content.'),
      evidence: z.string().describe('Short plain evidence: what you saw, URL, vendor, cookie/localStorage key, count'),
      url: z.string().optional(),
      priceOnly: z.boolean().optional().describe('login/dom only: true when the ONLY problem on this page is that prices are missing (everything else is there). Some retailers are onboarded without prices.'),
      screenshot: z.string().optional().describe('Optional. The app attaches the latest screenshot by itself.')
    },
    async args => {
      run.recordCheck(args)
      return text(`recorded ${args.area}:${args.page} = ${args.status}`)
    }
  )

  const progress = tool(
    'progress',
    'Tell the non-technical person watching what you are doing now. Call it when you start each stage and at key moments. One short plain sentence, no tool names or jargon.',
    {
      stage: z.enum(['site', 'category', 'search', 'detail', 'banner', 'mla', 'finish']),
      note: z.string().max(200)
    },
    async args => {
      run.setProgress(args)
      return text('ok')
    }
  )

  const detectBlock = tool(
    'detect_block',
    'Classify the current page as blocked or not. Pass the JSON object returned by the probe script (run it with evaluate_script / evaluate_in_page first).',
    {
      probe: z.looseObject({
        url: z.string().optional(),
        title: z.string().optional(),
        textLength: z.number().optional(),
        textSample: z.string().optional(),
        vendorHits: z.array(z.string()).optional(),
        cookieNames: z.array(z.string()).optional()
      })
    },
    async ({ probe }) => {
      const c = classifyProbe(probe)
      if (c.blocked) blockedAt.push(Date.now()); else blockedAt = []
      const s = solverFor(c.vendors)
      return text({ ...c, solver: s.solver, solverNote: s.note, solverVendor: s.vendor || null })
    }
  )

  const askHuman = tool(
    'ask_human',
    [
      'Pause and ask the human.',
      'kind=captcha: they solve it in the named browser window. Answer: solved | cant_solve | not_captcha | timeout | limit_reached.',
      'kind=vpn: the site is blocked for this country, or a page keeps loading and may only work from that country; they turn on a VPN for `country`. Put the reason in `message`. Answer: vpn_on (then hard-refresh the page as the answer says) | no_vpn | timeout | limit_reached.',
      'kind=login: prices need signing in. Answer: signed_in (they signed in themselves in the named window) | signed_in_otp (they signed in, but it needed a one-time code: record login fail) | credentials_ready (type {{LOGIN_USERNAME}} and {{LOGIN_PASSWORD}} exactly as written into the login form; the app fills in the real values) | no_account | timeout.',
      'kind=question: answer is one of options or free text.',
      'Never ask for passwords in a question; use kind=login.'
    ].join(' '),
    {
      kind: z.enum(['captcha', 'vpn', 'login', 'question']),
      country: z.string().optional().describe('kind=vpn: the country the VPN must be set to, e.g. Lithuania'),
      message: z.string(),
      url: z.string().optional(),
      vendor: z.string().optional(),
      browser: z.enum(['chrome', 'neo']).optional().describe('Which window the human must use: chrome = the clean Chrome window, neo = BrowserOS'),
      options: z.array(z.string()).optional()
    },
    async args => {
      if (args.kind === 'captcha') {
        if (captchaGate(blockedAt, captchaRechecked) === 'recheck') { captchaRechecked = true; return text(CAPTCHA_RECHECK) }
        const v = `${args.browser || 'chrome'}:${args.vendor || 'unknown'}`
        captchaAsks[v] = (captchaAsks[v] || 0) + 1
        if (captchaAsks[v] > MAX_CAPTCHA_ASKS_PER_VENDOR) {
          return text(args.browser === 'neo'
            ? 'limit_reached: the human already solved this challenge 3 times in BrowserOS. Do not ask again; record this page as blocked.'
            : 'limit_reached: the human already solved this vendor 3 times in Chrome. Do not ask again; switch to the BrowserOS neo fallback.')
        }
      }
      if (args.kind === 'vpn' && ++vpnAsks > MAX_VPN_ASKS) return text(vpnReply(null, vpnAsks))
      const answer = await run.waitForHuman(args, HUMAN_TIMEOUT_MS)
      if (args.kind === 'captcha') { blockedAt = []; captchaRechecked = false }
      if (args.kind === 'vpn') return text(vpnReply(answer, vpnAsks))
      if (answer === 'credentials_ready') return text('credentials_ready: type {{LOGIN_USERNAME}} into the username/email field and {{LOGIN_PASSWORD}} into the password field, exactly as written, then submit. Never write these placeholders anywhere else.')
      return text(answer)
    }
  )

  return createSdkMcpServer({
    name: 'feas',
    version: '1.0.0',
    tools: [progress, recordCheck, detectBlock, askHuman],
    alwaysLoad: true,
    timeout: 60 * 60 * 1000 // ask_human may wait up to 15 min; leave headroom
  })
}
