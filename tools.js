import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { classifyProbe } from './detect.js'
import { solverFor } from './solvers.js'

const HUMAN_TIMEOUT_MS = 15 * 60 * 1000
const MAX_CAPTCHA_ASKS_PER_VENDOR = 3

const text = t => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t) }] })

/**
 * In-process MCP server "feas", bound to one run.
 * run: { id, emit(type, data), recordCheck(check), waitForHuman(question, timeoutMs) -> Promise<answer> }
 */
export function makeFeasServer(run) {
  const captchaAsks = {}

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
      const s = solverFor(c.vendors)
      return text({ ...c, solver: s.solver, solverNote: s.note, solverVendor: s.vendor || null })
    }
  )

  const askHuman = tool(
    'ask_human',
    [
      'Pause and ask the human.',
      'kind=captcha: they solve it in the named browser window. Answer: solved | cant_solve | not_captcha | timeout | limit_reached.',
      'kind=vpn: the site is blocked for this country; they turn on a VPN for `country`. Answer: vpn_on | no_vpn | timeout.',
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
        const v = `${args.browser || 'chrome'}:${args.vendor || 'unknown'}`
        captchaAsks[v] = (captchaAsks[v] || 0) + 1
        if (captchaAsks[v] > MAX_CAPTCHA_ASKS_PER_VENDOR) {
          return text(args.browser === 'neo'
            ? 'limit_reached: the human already solved this challenge 3 times in BrowserOS. Do not ask again; record this page as blocked.'
            : 'limit_reached: the human already solved this vendor 3 times in Chrome. Do not ask again; switch to the BrowserOS neo fallback.')
        }
      }
      const answer = await run.waitForHuman(args, HUMAN_TIMEOUT_MS)
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
