// Does the BOT team's browser-node have a solver for this challenge?
// Source: config/.claude/skills/bot-detection-debugger/SKILL.md (browser-node auto-solve table).
// ponytail: static map; update by hand when the BOT team adds a solver.
export const SOLVERS = {
  cloudflare: { solver: 'yes', note: 'BOT platform solves Cloudflare challenges' },
  'captcha widget': { solver: 'partial', note: 'reCAPTCHA v2, hCaptcha, Geetest and press-and-hold are solved; Turnstile only partly' },
  perimeterx: { solver: 'yes', note: 'press-and-hold solver exists; PerimeterX also scores IPs, expect tunnel work' },
  imperva: { solver: 'unknown', note: 'no auto-solver listed; usually handled with incapsulaScript / tunnels' },
  akamai: { solver: 'unknown', note: 'no auto-solver listed; sensor-based, usually tunnel + cookie work' },
  datadome: { solver: 'no', note: 'no solver listed; needs BOT team' },
  kasada: { solver: 'no', note: 'no solver listed; needs BOT team' }
}

export function solverFor(vendors = []) {
  if (!vendors.length) return { solver: 'unknown', note: 'vendor not identified' }
  const rank = { yes: 0, partial: 1, unknown: 2, no: 3 }
  // The weakest vendor on the page decides.
  return vendors
    .map(v => ({ vendor: v, ...(SOLVERS[v] || { solver: 'unknown', note: 'vendor not in solver list' }) }))
    .sort((a, b) => rank[b.solver] - rank[a.solver])[0]
}
