# Retailer web feasibility check

A local web app that checks whether a retailer website can be onboarded. It follows the ROB SOP "Web Feasibility and Onboarding Document - ROB" (Confluence page 4098719902).

You paste the retailer's website, and an AI agent opens it in a real browser. It walks the SOP checks page by page (home, category, search, product, plus banners and store pages if asked) and gives a verdict with evidence and screenshots. You only step in when the site asks to prove you are human, needs a VPN, or needs a login.

Verdicts:

| Verdict | Meaning |
|---|---|
| **Feasible** | The site opens as a shop, and on the category, search and product pages the prices and product data are there |
| **Feasible (without prices)** | Your team decided to onboard although prices are not shown |
| **Needs CSM** | A partial case the client/CSM must confirm (e.g. no login available, no default store, no search) |
| **Not feasible** | Not an online shop, no product data, or a login that needs a one-time code every time |
| **Manual check needed** | No browser could open the site (e.g. country block and no VPN); check it by hand |
| **Incomplete** | The check stopped early; run it again |

Built for the COB team: plain words throughout, technical details only when you ask for them.

> **Testing phase:** the app never reads or writes Jira. The result has a "Copy report" button; paste it into the ticket yourself.

---

## Quick start

```bash
git clone https://github.com/flavio-denis/feasibility-check.git
cd feasibility-check
npm install
claude login        # once, if Claude Code is not signed in yet
npm start           # then open http://localhost:4545
```

Check the setup chip at the top right of the app. It should say **Ready**. If it is amber or red, click it to see what is missing (see [Troubleshooting](#troubleshooting)).

---

## Prerequisites

| Need | Why | How to check |
|---|---|---|
| **Node.js 20 or newer** (22 recommended) | Runs the app | `node --version` |
| **Claude Code, signed in** with a Claude Pro / Max / Team / Enterprise plan | The AI agent runs on *your own* Claude login (no API key) | `claude --version`, then `claude login` |
| **BrowserOS** running, with a profile for office work (default name `CIQ`) | The main browser the agent uses | The app's setup chip shows "BrowserOS (main browser): Ready" |
| **Google Chrome** (optional if BrowserOS is running) | Backup browser: a clean window, used when BrowserOS can't get past a check | The setup chip shows "Chrome (backup browser): Ready" |
| A **`config` repo checkout** at `~/config` (optional) | Turns on the "possibly already onboarded" warning | — |

At least one of BrowserOS or Chrome must be available.

### Installing the prerequisites

- **Node.js:** install from [nodejs.org](https://nodejs.org) or with nvm: `nvm install 22 && nvm use 22`. This repo has an `.nvmrc`, so `nvm use` in the folder picks the right version.
- **Claude Code:** `npm install -g @anthropic-ai/claude-code`, then run `claude login` once and sign in with your Claude account.
- **BrowserOS:** install it, sign the office profile into the accounts you need, and make sure its MCP server is reachable at `http://127.0.0.1:9010/mcp` (the default). If your profile has a different name than `CIQ`, set `FEAS_NEO_PROFILE` (see [Settings](#settings)).
- **Chrome:** the normal Google Chrome install. If it is not in the standard place, set `FEAS_CHROME_PATH`.

### About the Claude login

The app uses the **Claude Agent SDK** with the Claude Code login on your computer. There is no API key.

- Run it **on your own computer, with your own login**. Do not host it for others: Anthropic does not allow sharing a subscription login through an app.
- If `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is set in your shell, the app removes it for its runs, and stops if Claude still reports an API key.
- Each check uses part of your plan's usage (default model: Sonnet). The result page shows roughly how much.

---

## Running a check

1. Start the app: `npm start`, then open <http://localhost:4545>.
2. Click **New check**.
3. Paste the **website** (home page). The **retailer name** fills in from it (`bite.lt` gives `Bite-LT`); change it to match the ticket.
4. Tick **Banners** and/or **Store pages (multi-store)** if the ticket asks for them.
5. Click **Start check**. Allow desktop notifications when the browser asks, so you hear about "Your turn" moments while in another tab.
6. Watch the page cards and the **What's happening** panel. Most checks take 1–6 minutes.
7. If an amber **Your turn** card appears, do what it says in the named window (BrowserOS or Chrome), then click its button:
   - **Prove you are human (CAPTCHA):** solve it, then click *Done, it's solved*. If you can't, click *I can't solve it* and the other browser is tried. A CAPTCHA never makes a retailer not feasible.
   - **Country block:** turn on a VPN for the named country, then click *Done, the VPN is on*.
   - **Login:** sign in yourself in the browser, *Give the tool a login* (typed into the site by the app, kept in memory only), or *No login available*. If signing in asks for a one-time code, click *Yes, it needed a one-time code*.
8. When it finishes, follow **What to do next**: *Copy report* and paste it into the feasibility ticket, set the ticket status it names, and copy the test URLs for the onboarding ticket later.

Only one check runs at a time. **History** lists every check, with search and a verdict filter.

---

## Settings

All optional. Set them before `npm start`, e.g. `PORT=4600 FEAS_NEO_PROFILE=Work npm start`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4545` | Web port. The app only listens on this computer (`127.0.0.1`) |
| `FEAS_MODEL` | `claude-sonnet-5-5` | Claude model the agent uses |
| `FEAS_NEO_URL` | `http://127.0.0.1:9010/mcp` | BrowserOS MCP address |
| `FEAS_NEO_PROFILE` | `CIQ` | BrowserOS profile the agent works in |
| `FEAS_CHROME_PATH` | auto-detected | Chrome executable, if not in the standard place |
| `FEAS_CONFIG_REPO` | `~/config` if it exists | `config` repo checkout for the "already onboarded" warning |
| `FEAS_MAX_TURNS` | `150` | Maximum agent steps per check |
| `FEAS_RUNS_DIR` | `./runs` | Where checks are saved |

---

## Troubleshooting

| What you see | What to do |
|---|---|
| Setup chip **red: App update** | The app's files changed while it was running. Stop it (`Ctrl+C`) and run `npm start` again |
| **BrowserOS: Not open** | Start BrowserOS. Checks still run in Chrome if Chrome is installed |
| **Chrome: Not found** and BrowserOS not open | Start BrowserOS, or install Chrome / set `FEAS_CHROME_PATH` |
| "Claude isn't signed in on this computer" | Run `claude login` in a terminal, then start the check again |
| "Claude is set up with an API key" | Remove `ANTHROPIC_API_KEY` from your shell profile, open a new terminal, `npm start` |
| "Claude's usage limit was reached" | Wait until the reset time shown, then **Run again** |
| `EADDRINUSE` when starting | Another copy is already running on that port. Use it, or start with `PORT=4600 npm start` |
| "A run is already in progress" | Only one check runs at a time (also across app windows). Open it from the live chip in the top bar, or cancel it |
| The page shows "Interrupted" | The app was closed during the check. Click **Run again** |
| A check's result looks wrong | Open the page cards for the evidence and screenshots, and tick *Technical details* in the activity panel for the raw steps |

---

## Updating

```bash
git pull
npm install
# stop the running app (Ctrl+C), then:
npm start
```

---

## How the check decides

- **Bot protection** is checked once for the whole retailer: solved on the home page, then every page is checked in the same browser session. It is never a reason for "not feasible"; the report notes that onboarding needs a bypass.
- **Country block:** you turn on a VPN and the check goes on. The report notes that onboarding needs a tunnel for that country. Without a VPN the result is Manual check needed.
- **Login:** with an account (you sign in, or hand it to the tool) it is Feasible with the note "onboarding needs a login account". Signed in but still no prices gives Needs CSM ("Can the client provide an account that shows prices?"). No account gives Needs CSM. A login that needs a one-time code every time is Not feasible.
- **Prices missing, everything else there:** the result lets your team choose **Onboard without prices** or **Ask the CSM**. *Change decision* undoes it.
- **Storefront inside a marketplace** (a shop on Trendyol, TMall, JD, a dark store): if its pages lead out to the main marketplace, the result is Needs CSM ("which site to onboard?").
- **Store pages** (when ticked): set **3 pickup stores** (not delivery) on category pages, either 3 on one category or 1 each on 3 categories. The store changing is enough; prices don't have to change. Store locators you can only look at, and "check stock in store" boxes, don't count. Very slow store setting gives Needs CSM. This has its own line and never changes the main verdict.
- **Banners** (when ticked): hero/promo images with links on the home page. Not supported for Amazon retailers (team policy).
- **Already onboarded?** A warning when the retailer name or website is already in the `config` repo.
- The **verdict is computed by code** (`verdict.js`) from the recorded checks, not by the AI.

## Data and privacy

- Everything stays on your computer. Each check is saved in `runs/<id>/` (git-ignored):

  | File | Contents |
  |---|---|
  | `input.json` | Website, name, options |
  | `events.jsonl` | The activity log |
  | `checks.json` | Each check as it was recorded |
  | `result.json` | Final status and verdict |
  | `report.html` | The report |
  | `screenshots/` | Page screenshots |

- **A login you hand over** is kept in memory for that check only. It is never written to `runs/`, logs or reports, and is masked as `***` if a page shows it back. The AI only sees placeholders; the app types the real values into the sign-in form. Claude session files are not saved for these runs.
- The app only accepts requests from its own page on `localhost`.

## What the agent never does

- Buy, create accounts, or submit personal data.
- Sign in, unless you hand it a login.
- Use BrowserOS credential, payment, upload or download tools.
- Change the BrowserOS profile during a check.
- Follow instructions written on a website (page text is treated as data).

---

## Project structure

| File | Role |
|---|---|
| `server.js` | HTTP + live updates (SSE), run state, setup checks, saving results |
| `agent.js` | Claude Agent SDK setup, browser tools, safety hooks |
| `tools.js` | The agent's own tools: `progress`, `record_check`, `detect_block`, `ask_human` |
| `prompt.md` | The SOP procedure the agent follows |
| `verdict.js` | Verdict rules |
| `report.js` | Plain-language wording, next steps, CSM questions, Jira text |
| `detect.js` | Bot-block detection (from the config repo's `onboard-retailer/gate.js` and `tunnel-advisor/advisor.js`) |
| `solvers.js` | Which bot vendors the BOT team can solve |
| `public/` | The web page (`index.html`, `app.css`, `app.js`) |
| `check.js` | Self-check |

## Development

```bash
npm run check    # offline self-check: verdict rules, wording, login safety, bot detection (no network, no Claude usage)
```

Run it after every change. The app also refuses new checks until it is restarted when its own files change, so code and rules never mix versions.
