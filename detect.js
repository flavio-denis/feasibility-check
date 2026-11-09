// Bot-block and vendor detection.
// Copied from the config repo so this app runs without a config checkout:
//   config/.claude/skills/onboard-retailer/gate.js (BLOCK_TITLE, VENDOR_MARKERS, thresholds, detectBotBlock)
//   config/.claude/skills/tunnel-advisor/advisor.js (VENDORS cookie/host markers)
// Keep in sync by hand if those change.

export const BLOCK_TITLE = /access denied|access to this page has been denied|blocked|captcha|challenge|are you a human|verify you|just a moment|attention required|pardon our interruption|request unsuccessful/i

// Vendor markers ship on healthy pages too, so they only count on a thin page (gate.js rule).
export const VENDOR_MARKERS = [
  ['cloudflare', /cf-browser-verification|cf-challenge-running|__cf_chl_|cdn-cgi\/challenge-platform|challenges\.cloudflare\.com/i],
  ['datadome', /captcha-delivery\.com|datadome/i],
  ['perimeterx', /perimeterx|_pxhd|px-captcha|px-cdn\.net|px-cloud\.net/i],
  ['imperva', /incapsula|_incap_|imperva|_Incapsula_Resource|reese84/i],
  ['akamai', /akamai.*reference\s*#/i],
  ['kasada', /kasada|kpsdk/i],
  ['captcha widget', /\/recaptcha\/api2\/bframe|class\s*=\s*["'][^"']*\bg-recaptcha\b|\bh-captcha\b|hcaptcha\.com\/captcha|\bcf-turnstile\b|geetest_panel|funcaptcha|arkoselabs|press\s*(?:&amp;|&|and)\s*hold/i]
]

// Cookie names that reveal a vendor even on a healthy page (advisor.js VENDORS).
export const VENDOR_COOKIES = [
  ['cloudflare', /^(cf_clearance|__cf_bm)$/],
  ['perimeterx', /^_px(3|2|hd)?$/],
  ['datadome', /^datadome$/],
  ['akamai', /^(_abck|bm_sz|ak_bmsc)$/],
  ['imperva', /^(incap_ses|visid_incap|reese84)/]
]

const GEO_TEXT = /not available in your (country|region)|not available in your location|unavailable in your region|only available in|geo.?block|region.?restricted/i

export const EMPTY_TEXT = 200
export const THIN_TEXT = 1000

/**
 * Script for chrome-devtools `evaluate_script` (arg `function`) or neo `evaluate_in_page`.
 * Returns a compact probe so the agent never pastes whole pages into a tool call.
 */
export function probeScript() {
  const markers = JSON.stringify(VENDOR_MARKERS.map(([n, re]) => [n, re.source, re.flags]))
  return `() => {
  const html = document.documentElement ? document.documentElement.outerHTML : '';
  const clone = document.body ? document.body.innerText || '' : '';
  const markers = ${markers};
  const vendorHits = markers.filter(([, s, f]) => new RegExp(s, f).test(html)).map(([n]) => n);
  const pick = sel => document.querySelector(sel);
  const ld = [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => s.textContent || '');
  return {
    url: location.href,
    title: document.title || '',
    textLength: clone.replace(/\\s+/g, ' ').trim().length,
    textSample: clone.replace(/\\s+/g, ' ').trim().slice(0, 400),
    vendorHits,
    cookieNames: document.cookie.split(';').map(c => c.split('=')[0].trim()).filter(Boolean),
    dataBlobs: {
      nextData: !!pick('#__NEXT_DATA__'),
      nuxt: typeof window.__NUXT__ !== 'undefined',
      initialState: typeof window.__INITIAL_STATE__ !== 'undefined' || typeof window.__PRELOADED_STATE__ !== 'undefined',
      ldJsonProduct: ld.some(t => /"@type"\\s*:\\s*"Product"/.test(t)),
      ldJsonItemList: ld.some(t => /"@type"\\s*:\\s*"ItemList"/.test(t))
    },
    localStorageKeys: (() => { try { return Object.keys(localStorage).slice(0, 60) } catch { return [] } })()
  };
}`
}

/**
 * Classify a probe (output of probeScript) the same way gate.js classifies a saved page.
 * @returns {{blocked:boolean, strong:string[], vendors:string[], thinWithVendor:boolean, geo:boolean, textLength:number}}
 */
export function classifyProbe(probe = {}) {
  const title = String(probe.title || '').trim()
  const textLength = Number(probe.textLength) || 0
  const cookieVendors = VENDOR_COOKIES
    .filter(([, re]) => (probe.cookieNames || []).some(c => re.test(c)))
    .map(([n]) => n)
  const vendors = [...new Set([...(probe.vendorHits || []), ...cookieVendors])]
  const strong = []
  if (title && BLOCK_TITLE.test(title)) strong.push(`title "${title}"`)
  if (textLength < EMPTY_TEXT) strong.push(`only ${textLength} chars of visible text`)
  const pageMarkers = (probe.vendorHits || []).length > 0
  const thinWithVendor = pageMarkers && textLength < THIN_TEXT
  const geo = GEO_TEXT.test(`${title} ${probe.textSample || ''}`)
  return { blocked: strong.length > 0 || thinWithVendor, strong, vendors, thinWithVendor, geo, textLength }
}

/** Same check on raw HTML (used by check.js samples). */
export function detectBotBlock(html) {
  const title = ((html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '').trim()
  const text = html
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const vendorHits = VENDOR_MARKERS.filter(([, re]) => re.test(html)).map(([n]) => n)
  return classifyProbe({ title, textLength: text.length, textSample: text.slice(0, 400), vendorHits, cookieNames: [] })
}
