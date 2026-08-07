---
name: live-testing
description: How to live-test a real application end to end (fill -> review -> approve/edit -> rehearse) against a real Workday/ATS posting through Chrome. Read this BEFORE driving the browser, running a fill, or claiming a tenant works. Covers the run loop, the log-reading rules, the automation traps that produce false results, and the never-submit invariant.
---

# Live testing an application end to end

Unit tests prove the logic; only a live run proves the product. This is how to do one without
producing a false result — and most of it exists because a false result was produced that way.

## START HERE — state as of 2026-08-06

Everything the 2026-08-05 list warned about is resolved; that list is gone. Current state:

**The page-3 class of failure is FIXED and the fix is verified.** Symptom was a required dropdown ending
blank after a sibling "changed itself". Cause was ours: every portaled listbox renders at the same screen
coordinates, options linger while unmounting and stay clickable, and the AI commit paths never waited for
the list to unmount — so the next field's open-click landed on the previous field's options. One
`closeDropdownConfirmed` in three places. Result: 4/4 clean runs (2 hidden, 2 visible), page 3 19.4s → 7.0s.
If a `⚠ REMOUNT` line ever appears again, that gate is the first suspect.

**AI batching is ON by default** (`disableAiBatch` is the kill-switch). A page's AI questions go out as ONE
call fired before the deterministic fill. It is a CACHE, NOT A GATE — a question it misses makes its own
per-field call, so a broken batch costs speed, never an answer. Answers are cached **by question, not
automation-id**, so a page refill makes ZERO calls and cannot contradict the first pass.

**Baselines to compare against** (waystar, page 3 = the screening page):
`visible ~7–10s · hidden ~19s` per page-3 fill; the typeahead option scrape is ~2.3s (249 options, 22 hops)
and **hidden is within 6% of visible** — the non-painting problem is handled by the worker-timer override,
so do NOT attribute a slow hidden run to paint. LLM latency ranged **1.0s–10.0s** across one session; that
variance swamps most page-level timing comparisons, so never conclude from a single run.

**Two things that will bite you in the first ten minutes:**
- **The site session expires every ~20 minutes.** `reportApplication` 401s and the completed fill's bundle
  never reaches the tracker — there is no re-push, so the whole fill must be re-run. Re-link on
  `/app/connect` → **"Link for tracking only"** (NOT "Sync everything", which overwrites the profile).
  Do it right before any run whose review you intend to keep.
- **Drive the UI with JS `.click()`.** MCP ref-clicks and focus+Return both fail to reach React on
  `/app/run` — the run silently never starts. Firing the extension message directly
  (`AP_RUN_APPLICATION` / `AP_SUBMIT_APPLICATION`) is equivalent and is what worked all session.

**Other mechanics:** keep every in-page `setTimeout` poll ≤30s (`Runtime.evaluate` dies at ~45s and you lose
the read, not the run). If the MCP tab group flips to a Chrome profile with no `applypilot.extensionId` in
localStorage, run `switch_browser` and have the operator reconnect.

**Burned fixtures:** `waystar R3132` now returns ALREADY APPLIED (~8 runs). Many waystar drafts exist under
`tester+12@gmail.com`. Start a fresh tester rather than adding to that pile.

## Diagnostic flags — turn these on before guessing (2026-08-06)

All are `AP_DEV_FLAG` toggles, and they exist because guessing cost several rounds each. When a page
misbehaves, turn one on and re-run rather than reasoning from the outcome.

| Flag | What it shows |
|---|---|
| `debugPageTrace` | Per-field **plan before acting** (`plan: DETERMINISTIC (bucket)` / `AI (answer already known: …)`), the outcome after, every wait named (`SCOUT`, `AI CALL fired`, `WAITING on the AI reply`, `CAPTURE`), and **every action ≥120ms timed**. `⏸` marks anything over 1s. |
| `debugAiPrompts` | The questions + options of every `act.llm` call, batched or per-field (the profile blob is stripped). |
| `debugClobber` | Re-scans after EVERY field and names any OTHER field that changed underneath it — value changed, vanished, or appeared. Costs a scan per field. |
| `enableAiBatch` | One AI call per page instead of one per question (opt-in). |

Always-on, no flag needed: `[AI-BATCH]` + `[AI-BATCH-RECON]` (one line per page: candidates, opens, served
vs fell-back) and **`⚠ REMOUNT`**, which is now an ALARM — see below.

### The rule that ends a whole class of wrong theories

**Workday can rarely REMOVE a committed value. It NEVER rewrites one into a different option.** (Operator,
2026-08-06.) So a field that later holds a *different* valid option was changed by US. Do not go looking
for an explanation on Workday's side.

This cost a full round. On waystar page 3, relocation was committed `"Yes, I am open to relocating"` and
later read `"No, but I live near one of these locations"`. It was written up as Workday rewriting the
value, and two remedies were built on that premise. The real cause: **every portaled listbox renders at
the same screen coordinates** (every commit logged `rect=463,298`), the options **linger while unmounting
and stay clickable**, so the next field's open-click landed on the previous field's list. Changing
relocation remounted the dependent basecamp question under a new id, blank and required → Save refused.

Fix: the AI commit paths now call `closeDropdownConfirmed` (gate on options-GONE, not `aria-expanded`),
which `fillDropdownCdp` has done since 2026-07-06. Result on the form that failed reliably: **4/4 clean
runs, 2 hidden + 2 visible**, `remount 0 · stalls 0 · drift 0`, page 3 19.4s → 7.0s.

Triage order when a value changes under you: lingering list → stale rect → a second write.

## THE INVARIANT: nothing is ever submitted

Every run in this doc is a FILL (stops at Workday's review page) or a REHEARSAL (`arm:false` — runs
the whole submit gate and logs `WOULD CLICK SUBMIT`). The real submit is behind a separate armed flag
and an eyes-on disposable-application gate. **Never arm it while testing.** If a run reports
`would-submit`, that is the success condition, not a step to follow up on.

## How the pipeline works

Three stages, and the **review bundle** (`chrome.storage.local.reviewSummary`, schema 1.1) is the
contract between them. Understanding the hand-offs is what lets you attribute a failure to the right
stage instead of the one where it surfaced.

**1. FILL** — `AP_RUN_APPLICATION`

- **Onboarding** drives the posting to a form: JD page -> Apply -> Apply Manually -> sign in (or
  create the account) -> land on page 1. Details: the `workday-onboarding` skill.
- **The walk** then fills page by page. The injected engine is destroyed on every page navigation, so
  the loop lives in the **service worker**, not the page: fill a page -> persist that page into the
  accumulated bundle -> the SW clicks Save & Continue -> wait for the new page -> repeat.
- Per field, in order: `FIELD_MAP` deterministic fill -> answer **buckets** (taught wordings) ->
  deterministic recognizers (employment status, compensation, signature dates) -> **AI** (REQUIRED
  fields only) -> blank + review. Every AI answer is `filled_review` and flagged; a deterministic one
  is `filled` and silent.
- It **stops at Workday's review page** — a double guard, because the footer Next button reuses the
  same automation-id as Submit there.
- Output: the bundle, pushed to the website.

**2. REVIEW** — the website tracker (`/app/tracker/<id>`)

- The human edits values, ticks options, and approves. A **value edit resets that field's approval**,
  deliberately: a changed value deserves a fresh look.
- `submit_ready` = every flagged field approved AND no unreplaced placeholder AND no required field
  blank. That is what enables the Submit/Rehearse path.

**3. REHEARSE / SUBMIT** — `AP_SUBMIT_APPLICATION` (`arm:false` = rehearsal)

- Pulls the approved bundle **keyed on `job_key`** so it can never replay a different application's
  answers, then re-navigates, signs in, and replays.
- Per page: settle the field set -> replay only the approved values (skip-if-correct) -> **strict
  per-field verify** -> re-scan for cascade-revealed fields -> Save & Continue.
- At the end it reads **Workday's own review page** — the read-only text of what is really on the
  application — and reconciles it against the approved bundle: AGREE / DISAGREE / MISSING / EXTRA.
  Only DISAGREE blocks (MISSING is informational; Workday does not render every field).
- Then the submit gate: bundle blockers + no DISAGREE + session alive. AI is OFF for a submit run
  regardless of the toggle — every value must come from the approved bundle.

**Why a rehearsal can fail where the fill succeeded.** They are different code paths against a
different page state: the fill writes into a blank form, the replay writes into one that may already
hold values, and the replay additionally compares against Workday's review page. So a rehearsal
failure is usually the replay or the reconcile, not the fill — read its log lines specifically
(`CDP-REPLAY-WALK`), not the fill's.

## What "working end to end" means

Say a tenant works ONLY when all five happened in one sitting:

1. **Fill** reaches Workday's review page (`✓✓ reached the REVIEW page after N page(s)`)
2. **Review** loads on the website tracker with the bundle
3. **Approve** reaches `N / N flagged` and `Ready to submit`
4. **Rehearse** replays every page and reports `AGREE n · DISAGREE 0`
5. **Gate** logs `✅✅✅ SUBMIT GATE PASSED — ▶▶ WOULD CLICK SUBMIT NOW ◀◀`

A fill that reaches review is NOT "working end to end". Most bugs live in the replay.

## Setup

```bash
cd web && npx next dev          # background it; port 3000
```

Then in Chrome: load browser tools, open `http://localhost:3000/app/run`, and install the helpers
below in that tab. The extension talks to the page over `chrome.runtime.sendMessage`, so **every
helper must run in a localhost tab** — `chrome://` and `chrome-extension://` are both blocked.

```js
const EXT = localStorage.getItem("applypilot.extensionId");
window.__apSend = (msg, ms = 25000) => new Promise((res) => {
  let d = false; const t = setTimeout(() => { if (!d) { d = true; res({ err: "timeout" }); } }, ms);
  try { chrome.runtime.sendMessage(EXT, msg, (r) => { if (d) return; d = true; clearTimeout(t);
    res(chrome.runtime.lastError ? { err: String(chrome.runtime.lastError.message) } : r); }); }
  catch (e) { d = true; res({ err: String(e) }); }
});
// Log tail. Sanitize: the MCP layer BLOCKS output that looks like cookie/query data, so strip
// ?&=; and URLs or the whole call comes back "[BLOCKED]" and you lose the read.
window.__tail = async (n = 6, pat) => {
  const r = await window.__apSend({ type: "AP_DEV_LOGS", limit: pat ? 500 : 40, pattern: pat });
  return (r.lines || []).map((l) => String(l.msg).replace(/[?&=;]/g, " ")
    .replace(/https?:\/\/\S+/g, "URL")).slice(-n).map((s) => s.slice(0, 170));
};
```

Sanity-check before anything else: `await window.__apSend({type:"AP_PING"})` → `{ok:true}`.

## The run loop

**`javascript_tool` runs in an ISOLATED world.** Its `window` is not the page's, so a native-setter
write does NOT reach React's state — the input shows the URL, React still holds `""`, and the Run
button stays `disabled` forever. The old recipe (native set + `input` event, alone) does not work.
What works is priming the value and then letting a REAL keystroke produce React's own event:

```js
// 1. Prime the FULL url via the native setter (not a prefix — see below), then focus.
const el = [...document.querySelectorAll("input")].find(i => /wd\d|myworkday/.test(i.placeholder||""));
const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
set.call(el, JOB_URL);
el.dispatchEvent(new Event("input", { bubbles: true }));
el.focus();
```
Then **one real keystroke** with the computer tool — `x` then `BackSpace`. React's own handler fires,
reads the full primed value out of the DOM, and enables the button. Verify, then click:
```js
const btn = [...document.querySelectorAll("button")].find(b => /^Run$/.test(b.textContent.trim()));
({ len: el.value.length, disabled: btn.disabled });   // MUST be disabled:false before you click
```

**Click the button with JS `focus()` + a real `Return` keypress, not screenshot coordinates.**
Coordinates drift: the screenshot is scaled, and the scale changes whenever the window resizes, so a
`kx/ky` computed from an earlier screenshot lands somewhere else. Focus the button in JS, press
`Return` with the computer tool, and the click is coordinate-independent:
```js
btn.focus(); document.activeElement.textContent;   // confirm it's the Run button, THEN press Return
```
If you must use coordinates, recompute the scale from the CURRENT screenshot's dimensions and
confirm the target with `document.elementFromPoint(x, y)` before pressing.

Then poll `__tail()` every ~40s. A fill is 1–4 minutes depending on page count and AI calls.

For the rehearsal, same URL, but match `/Rehears/` instead of `/^Run$/`.

**`Runtime.evaluate` has a ~45s ceiling.** Any in-page poll you write must finish in ≤30s slices and
be called repeatedly, or the eval itself times out and you lose the read (not the run).

## Reading the logs — the rules that stop false conclusions

**The log is a RING BUFFER shared across runs.** A line matching your pattern is very often from a
PREVIOUS run. This has caused wrong conclusions repeatedly. Before believing any line:

```js
const r = await window.__apSend({ type: "AP_DEV_LOGS", limit: 50 });
const last = (r.lines || []).slice(-1)[0];
Math.round((Date.now() - last.t) / 1000);   // age in seconds — is this even your run?
```

**Age is not enough — grade from a CURSOR.** An age check tells you the log is fresh, not that the
line you're reading belongs to *this* run. Two runs a minute apart both look fresh. Stamp a cursor
before you click, and only grade lines after it:

```js
window.__cur = async () => ((await window.__apSend({type:"AP_DEV_LOGS", limit:1})).lines||[]).slice(-1)[0]?.t || Date.now();
const since = await window.__cur();          // BEFORE clicking Run
// ...after the run...
const r = await window.__apSend({ type:"AP_DEV_LOGS", limit:500, pattern:"REVIEW page" });
(r.lines||[]).filter(l => l.t > since);      // only these are yours
```
I graded a run on the previous run's lines and reported a pass that wasn't real. The cursor is cheap;
use it every time.

**Silence can be the success signal.** The walk logs only FLAGGED records (`⚠`). A deterministic
`filled` is not logged. So "no line for field X" often means X filled cleanly — do not read it as
"X did not run".

**Never assume whether a run was visible.** The operator may hide or alt-tab the tab mid-run, and an
occluded tab still reports `tab.active && !minimized`. Read it from the log's own pacing line
(`cdpPacingLabel`, plus the paint label) — that is ground truth. I labelled a hidden run "visible"
and used it as no-regression evidence; the operator had to correct me.

**Lines worth grepping**

| Pattern | Means |
|---|---|
| `reached the REVIEW page after N page(s)` | fill completed |
| `AGREE n · DISAGREE 0` | replay matched the review page |
| `SUBMIT GATE PASSED` | success terminal state |
| `nav-timeout on page N` | Workday refused the page; the line quotes its error |
| `\[LLM\]` | model, route, key count, timing per call |
| `⚠ YOUR PRIMARY AI MODEL IS FAILING` | primary model down; every call pays a wasted probe |
| `SESSION EXPIRED` / `VPS\|` | Workday session or server error, not a fill bug |

## Review + approve + edit

Open `http://localhost:3000/app/tracker/<id>`. Find the id from `/api/applications` filtered on the
posting's requisition id.

```js
[...document.querySelectorAll("button")].find(x => /Approve all reviewed/i.test(x.textContent)).click();
// then confirm — "N / N flagged" and "Ready to submit"
```

**Editing a field to test that the replay follows the human.** This is the highest-value test in the
whole flow and the easiest to get wrong.

- `<select>` — native setter + `change` event works.
- **text/textarea — the editor is a CONTROLLED input that commits on BLUR, and blur commits REACT
  STATE, not the DOM.** A native-setter write that does not reach React's `onChange` leaves the box
  visibly showing your text while the bundle keeps the old value. Real triple-click + type + Tab is
  the reliable path; automation frequently fails here.
- **Verify the edit committed. Do not trust the box.** The chip row must show `Edited N`, and the
  field must show a grey `autofilled: <old value>` line beneath it. "It let me approve" is NOT
  evidence — approval and edit are independent.

Then rehearse and confirm the log shows your value being written (`"Florida"→"Georgia"`) and the
review page agreeing.

## Debug levers — flags and probes

`AP_DEV_FLAG` writes a whitelisted key into `chrome.storage.local`; the SW reads it per run, so no
reload is needed. **Clear every flag when you're done** — several disable safety backstops, and a
forgotten flag silently invalidates every later measurement.

```js
await window.__apSend({ type:"AP_DEV_FLAG", key:"forceTrustedInput", value:true });
await window.__apSend({ type:"AP_DEV_FLAG", key:"forceTrustedInput", value:null }); // clear
```

| Flag | Effect |
|---|---|
| `forceTrustedInput` | reverts the whole run to trusted `Input.*` — the slow-but-proven path |
| `forceWorkerTimersOff` | forces the ~1Hz throttled page-timer path (regression-test the slow path) |
| `skipPreSaveReverify` | skips the pre-Save re-verify. **Disables a real backstop — clear it.** |
| `debugInputTrace` | per-event input log; the keystroke-by-keystroke replay |
| `debugGroupWatch` | ~10ms polling of a checkbox group's state, drained into the log |

Read-only probes: `AP_DEV_WD_PROBE` inspects a live Workday tab without running a fill. The steps are
opt-in **message keys**, not a mode string — `{type:"AP_DEV_WD_PROBE", urlContains:"waystar",
fieldName:"disabilityStatus", geom:true, wrappers:true, checkIds:[...], coordClickIds:[...],
reload:true}`. `reload:true` re-enters the page so you see what Workday renders BEFORE any fill.
It returns `{ok:false, error:"busy"}` while a run or sweep is in flight — probe between runs, not
during one. `AP_DEV_ATS_SCAN` is the equivalent for GH/Lever/Ashby.

## Traps that produce false results

- **Don't close tabs mid-run.** `AP_DEV_CLOSE_TABS` while a run is tearing down produces
  `walk aborted: CDP not attached`. Close BEFORE starting, never after.
- **A leftover Workday tab can hold a browser dialog** (password manager / breach warning) that
  blocks sign-in invisibly — the extension cannot see browser chrome. Symptom: sign-in submits with
  no outcome. Close stale tabs and retry.
- **`npx next build` clobbers the dev server's `.next`.** Never build while the dev server serves.
- **Never start a SECOND dev server against the same `web/`.** Two `next dev` processes share `.next`
  and corrupt each other's build — the tell is the page loading unstyled with 404s on every CSS
  chunk, which looks like a broken app. Fix: kill all node servers, `rm -rf web/.next`, start ONE.
- **Multiple Chrome browsers connected** → you MUST ask the user which one; never pick. Browser names
  can go stale mid-session; if a tool lands in the wrong browser, `switch_browser` and re-confirm by
  opening a known page before doing anything else.
- **The website session expires silently.** `reportApplication` starts 401ing and `/app/run`
  redirects to `/login`; the extension log says nothing useful. Check with a `/api/applications`
  fetch that returns `{"ok":false,"reason":"not-signed-in"}`. **Ask the operator to sign in — never
  enter credentials yourself.**
- **The LLM keys exhaust.** After ~25 runs: `no usable API key for gemini: every key is disabled,
  rejected, or resting`. Every AI field then fails and the run looks like a fill regression. Check
  `[LLM]` lines before blaming code; the fix is a new key from the operator.
- **A dead posting returns HTTP 200** and a generic "Careers" page. Confirm with the CxS API before
  blaming the code: `GET /wday/cxs/<tenant>/<board>/job/<path>` → 403 means unpublished.
- **Some gates are not ours to pass.** A tenant's Terms-and-Conditions checkbox, an SSO wall, or a
  captcha is an operator step — `externalGateHalt` names these. Do not tick a legal agreement to get
  a run further, and report the tenant as externally blocked rather than failed.

## Phantom errors — when to bump the login

After repeated runs on one form, Workday starts producing errors that do not match the page: "already
exists for this application", duplicate-URL errors with no visible duplicates, `VPS|` codes. That is
its stale server-side state, not a bug you introduced.

Fix: change the login email on `/app/credentials` — `tester+23@gmail.com`, `+24`, … — using the
native setter, then Save (look for `✓ Saved`). Sign out of Workday or wait for cookies to expire
before retrying the FAILING form; a fresh account on a fresh form works immediately. Confirm with
`login recorded for this run — tester+NN@gmail.com @ <Tenant>`.

Prefer tenants where the account already exists: no email verification, so no Gmail dependency.

## Starting a FRESH tester account

Repeated runs against one form give Workday stale server state (see Phantom errors) and eventually an
ALREADY APPLIED page that ends the run before it starts. A fresh tester is the clean reset, and it is the
right way to begin a regression sweep.

1. `/app/credentials` — set the login email to the next unused alias (`tester+NN@gmail.com`). Use the
   native setter + a real keystroke, then Save; look for `✓ Saved`.
2. The account will NOT exist on any tenant, so **onboarding must create it and verify by email**. That
   makes Gmail auto-verify a hard dependency for the first run on each tenant — check it is connected
   before starting, or the run halts `verification-required-gmail-off`.
3. Confirm it took: the run log prints `login recorded for this run — tester+NN@gmail.com @ <Tenant>`, and
   the tracker row shows the same under "Signed in as".
4. **First run on a fresh account is slower** (account creation + email round trip). Do not read that
   run's timings as a baseline; use the second run on that tenant.

A fresh tester also resets the "already applied" state, so a previously-burned req becomes usable again —
but prefer a genuinely unused req so the two variables stay separated.

## Finding postings to test with

NOT the same thing as the product's Discover feature — that sweeps LinkedIn / Handshake / Simplify for
the user's real queue and is documented in the `job-discovery` skill. What you want here is test
FIXTURES: live postings on tenants you can sign into, which is a different job with different
constraints (you want variety of DOM, not the best match).

**Start from tenants that already work.** An existing account means no email verification, which is the
single biggest time sink. The tracker knows which ones you have:

```js
const r = await fetch("/api/applications").then(x => x.json());
// Two host shapes: <tenant>.wdN.myworkdayjobs.com, and wdN.myworkdaysite.com/…/recruiting/<tenant>/
// Handle both or you will never see the myworkdaysite tenants (e.g. magna), which are the ones worth
// testing deliberately — see the DOM-variety note below.
[...new Set((r.applications || r).map((a) => {
  const u = a.url || "";
  const sub = u.match(/\/\/([^.]+)\.(wd\d+)\./);              // tenant in the SUBDOMAIN
  if (sub) return sub[1] + "." + sub[2];
  const path = u.match(/\/\/(wd\d+)\.myworkdaysite\.com\/[^/]+\/recruiting\/([^/]+)/); // tenant in the PATH
  return path ? path[2] + "." + path[1] : null;
}))].filter(Boolean);   // e.g. ["aptiv.wd5", "copart.wd12", "clearesult.wd1", "magna.wd3", ...]
```

**Then query that tenant's own job API.** Every Workday tenant exposes an unauthenticated search:

```bash
curl -s -X POST "https://<tenant>.<dc>.myworkdayjobs.com/wday/cxs/<tenant>/<board>/jobs"   -H "content-type: application/json" -H "accept: application/json"   -d '{"appliedFacets":{},"limit":20,"offset":0,"searchText":"firmware"}'
```

- `<tenant>` and `<dc>` come from the host (`copart.wd12.…` -> `copart`, `wd12`).
- `<board>` is the path segment after the locale in any posting URL
  (`/en-US/CareerDepotCanada/job/…` -> `CareerDepotCanada`). Case-sensitive.
- Response: `total` plus `jobPostings[]`, each with `title` and `externalPath`.
- Job URL = `https://<tenant>.<dc>.myworkdayjobs.com/en-US/<board>` + `externalPath`.

**Search terms that surface relevant roles.** `searchText` is a plain keyword match over the posting,
so query the SKILL rather than the level — "intern" alone returns mostly unrelated reqs. Run several
and pool: `firmware`, `embedded`, `hardware engineer`, `software engineer intern`, `electrical
engineer`, `ASIC`, `FPGA`, `verification`, `co-op`.

**Pick for DOM variety, not just relevance.** The point of ten tenants is ten different form shapes.
Prefer a spread of data centers (`wd1`, `wd3`, `wd5`, `wd12`) and note that `wd3.myworkdaysite.com`
hosts tenants in the PATH instead of the subdomain — that host is worth including deliberately, since
it exercises a different URL/job-key path.

**Confirm a posting is ALIVE before blaming the code.** A dead req still returns HTTP 200 with a
generic "Careers" page, which reads exactly like an onboarding failure:

```bash
curl -s "https://<tenant>.<dc>.myworkdayjobs.com/wday/cxs/<tenant>/<board>/job/<externalPath>"   -H "accept: application/json" | head -c 200      # 403 "permission denied" => unpublished
```

**One posting per tenant per sitting.** Re-running the same form repeatedly is what triggers Workday's
phantom state (see above). If you need a second run on one tenant, bump the login first.

## When a live run contradicts a passing test

The test is wrong until proven otherwise. This happened repeatedly, and the cause was always the
fixture taking a different code path than the live page.

**Always revert the fix and confirm the test FAILS.** A test that passes both ways proves nothing —
and it will read as verification to the next person. If the fixture cannot reach the real path, say so
in the commit message rather than letting a green suite imply coverage.

## Reporting

State what was observed, with the log line. Distinguish:

- **verified live** — you saw the terminal success line this run
- **unit-verified only** — tests pass, no live confirmation
- **unverified** — reasoning only

Never report a tenant as working end to end without the `SUBMIT GATE PASSED` line from a run whose
age you checked.

### Scoreboard as of 2026-08-06 — 7 of 10

| Tenant | State |
|---|---|
| Aptiv, PSECU, clearesult, Home Depot | **verified live** (earlier sessions) |
| `cat.wd5` | **verified live** — REVIEW after 5 pages, ~16s total fill |
| `magna.wd3` (path-hosted) | **verified live** — REVIEW after 4 pages, ~10s |
| `waystar.wd1` | **verified live 2026-08-06** — full loop to `SUBMIT GATE PASSED`; needed the self-ID replay-input fix and the stray-click fix |
| `copart` | externally blocked (operator gate) — not a code failure |
| `radiancetech`, `clearwater` | unresolved; need postings |

Three to go. Prefer tenants with an existing account (no email verification), and one
`wdN.myworkdaysite.com` path-hosted tenant for URL/job-key variety.
