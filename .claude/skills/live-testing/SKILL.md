---
name: live-testing
description: How to live-test a real application end to end (fill -> review -> approve/edit -> rehearse) against a real Workday/ATS posting through Chrome. Read this BEFORE driving the browser, running a fill, or claiming a tenant works. Covers the run loop, the log-reading rules, the automation traps that produce false results, and the never-submit invariant.
---

# Live testing an application end to end

Unit tests prove the logic; only a live run proves the product. This is how to do one without
producing a false result — and most of it exists because a false result was produced that way.

**This page describes the WORKDAY pipeline** (onboarding → the N-page walk → the replay). Greenhouse,
Lever and Ashby are a different shape — one page, no login, no draft, a submit run that refills a
blank form rather than resuming one — with their own dev loop and their own hard-won debugging rules.
For those, read the **`ats-tenants`** skill. The never-submit invariant below is shared.

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

⚠ **`AP_PING` right after `AP_RELOAD` reports the OLD build (2026-08-11).** The marker check below is only
trustworthy once the new worker is actually up: a ping ~3.5s after the reload answered `{ok:true}` with the
PREVIOUS marker, which reads exactly like "my edit didn't load" and sends you off to re-read correct code —
the very failure the marker exists to prevent. Repeated `chrome.runtime.reload()` calls are also throttled,
so a second reload soon after a first can be deferred. Wait ~9s and retry the ping a few times until the
marker CHANGES; if it never does, then suspect the edit. Cheap recipe:

```js
await window.__apSend({type:"AP_RELOAD"}, 10000);
await new Promise(r => setTimeout(r, 9000));
let p; for (let i = 0; i < 3; i++) { p = await window.__apSend({type:"AP_PING"}, 20000); if (p && p.ok) break;
  await new Promise(r => setTimeout(r, 2500)); }
p.build;   // compare against AP_BUILD_MARKER in background.js
```

**A dead worker looks different from a stale one:** if the reload hit a SyntaxError the extension fails to
register at all and the ping keeps timing out rather than returning an old marker. `node --check background.js`
(plus any file you edited) separates the two in seconds — it catches the one-global-scope collisions that
`importScripts` turns into a completely dead extension.

**Two traps this session cost real time:**
- **A 91-second LLM call.** `llm.js` had no request timeout, so one stalled fetch dragged a page fill from
  ~10s to 100.1s. Now capped by `LLM_REQUEST_TIMEOUT_MS`, which is **30000, not the 20s this doc claimed
  until 2026-08-09**. If a page suddenly takes ~30s or ~100s, check the `[LLM] ok in …ms` lines FIRST.
- **THE provider is the single biggest source of "it randomly got slower" (measured 2026-08-09).** Three
  back-to-back cat.wd5 runs: `gemini-3.1-flash-lite` answered in **486ms, 646ms and 796ms** — and once, on
  the same model with the same config in the same session, in **30657ms**. One attempt, no retry, no key
  rotation; it simply took that long, finishing 343ms inside the timeout. That ONE call was the whole
  difference between a 1.9s page and a 32s page. Before blaming a tenant or the fill code for a slow page,
  subtract the `[LLM]` line — the variance there dwarfs everything else on the page.
  **Now mitigated** by the fast-retry (`LLM_FAST_RETRY_RULES`): a gemini 3.1 call still running at 2s is
  abandoned and re-issued. You will see `[LLM] fast-retry: … abandoned it and re-issued on a new socket`
  and, on the answer, `— after N fast-retry abort(s)`. Seeing those lines is the feature WORKING, not a
  fault. **To live-test it deliberately, force the rule's `ms` down to ~50** — every call then takes the
  path, which is the only reliable way to exercise it (a real hang happened once in ~8 calls). Verified
  that way 2026-08-09: 2 aborts per call, then a full-budget attempt that succeeded (1668ms / 2423ms),
  AI fields still filled, REVIEW reached. **Restore the real 2000 afterwards** — two unit tests assert it
  and will fail while it is forced.
- **Re-running one requisition.** Three runs on the same nvidia req produced a page-2 block naming four
  required-and-empty work-experience fields that the DOM plainly showed filled. A FRESH req sailed through
  with zero errors. Prefer a new requisition over re-running one; if you must re-run, expect Workday's
  accumulated state and do not read it as a code failure.

**Burned fixtures:** `waystar R3132` now returns ALREADY APPLIED (~8 runs). Many waystar drafts exist under
`tester+12@gmail.com`. Start a fresh tester rather than adding to that pile.

## FIRST: prove the extension is running YOUR code (2026-08-07)

The service-worker start line carries a build marker:

```
[ApplyPilot][DEV] service worker started (…) · build backstop-1
```

Bump `AP_BUILD_MARKER` (top of `background.js`) whenever a live run has to prove the reload picked up your
edit, and check the marker after `AP_RELOAD` **before** reasoning about behaviour at all.

This exists because a whole round was spent on a fix that was never running. Two commits' worth of changes
were completely inert across three reload-and-rerun cycles; the log could not distinguish "gated out" from
"threw" from "not loaded", so the time went into re-reading correct code. The cause was the **wrong Chrome
browser** — a second profile had the same extension ID loaded from a stale copy, so `AP_PING` answered
`{ok:true}`, `AP_RELOAD` restarted a worker, runs executed, and everything looked healthy while none of the
edits were present.

`AP_PING` succeeding does NOT mean you are on the right browser. The marker does. And note the operator has
had to redirect the browser connection more than once in a session — re-check the marker after any
`switch_browser`, not just at the start.

## Diagnostic flags — turn these on before guessing (2026-08-06)

All are `AP_DEV_FLAG` toggles, and they exist because guessing cost several rounds each. When a page
misbehaves, turn one on and re-run rather than reasoning from the outcome.

| Flag | What it shows |
|---|---|
| `debugPageTrace` | Per-field **plan before acting** (`plan: DETERMINISTIC (bucket)` / `AI (answer already known: …)`), the outcome after, every wait named (`SCOUT`, `AI CALL fired`, `WAITING on the AI reply`, `CAPTURE`), and **every action ≥120ms timed**. `⏸` marks anything over 1s. |
| `debugAiPrompts` | The questions + options of every `act.llm` call, batched or per-field (the profile blob is stripped). |
| `debugClobber` | Re-scans after EVERY field and names any OTHER field that changed underneath it — value changed, vanished, or appeared. Costs a scan per field. |
| `enableAiBatch` | One AI call per page instead of one per question (opt-in). |
| `debugLagTrace` | **Answers "was that pause Workday or us?"** — see below. Times EVERY CDP command at the `cdpSend` choke point, runs a 500ms no-op page probe, and measures the service worker's own timer drift. Streams `⏳`/`⛔` lines live and prints one `[LAG]` summary per page. |

### `debugLagTrace` — attributing a pause instead of guessing (2026-08-09)

A duration alone cannot tell you who was slow: "this field took 4s" fits Workday thinking, the debugger
channel being slow, and our own service worker being blocked, equally well. So it measures three clocks
that fail independently:

- **SW scheduling drift** — a 500ms `setInterval`'s actual vs expected fire time. Only our worker can
  cause this. ⚠ It is measured with a timer INSIDE an MV3 worker, so some of it may be Chrome
  deprioritising worker timers rather than a stall that actually delays the fill — do not treat drift
  alone as proof of a problem until it is shown to track real slowness.
- **No-op page probe** — `Runtime.evaluate("1")`. Trivial, but must be scheduled on the page's main
  thread. Its **p50 also bounds transport latency from above**: across ~1500 commands in three runs the
  p50 was **1ms**, which is what rules the debugger channel out as a lag source. A spike therefore means
  the RENDERER is jammed, not the channel. (A second browser-process probe was tried and removed —
  browser-domain commands are not served on a tab-scoped attach.)
- **Per-command timing** by method, so a slow command can be compared against the live baseline.

Each slow command prints its own verdict — `THIS COMMAND'S OWN WORK` vs `RENDERER BLOCKED` vs `MIXED`.
When the flag is off, `cdpSend` is a straight pass-through, so the instrumentation cannot distort the
timings it exists to measure.

**Reading it:** a slow `Runtime.evaluate` is NOT automatically a bug — many of our evals are page-side
polls that wait by design. The useful signal is the *pairing*: a multi-second command while the no-op
probe still reads ~1ms means that call genuinely did that much work.

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

### The sign-in "8-9s" — answered (2026-08-07)

It was NOT Workday being slow, and not the retry ladder. **Success was not being recognised.**
`classifyAuthOutcome` required `formFieldCount > 0`, so a sign-in that had plainly worked read as
`unknown` until Workday mounted the fields — and the caller burned its whole budget, then re-submitted the
auth form or reloaded the page. The live proof, jabil.wd5's SUCCESSFUL sign-in:

```
still waiting at 2.0s — title "Careers"      formFields 0 · hasAuthEl false · markers [none]
timed out after 4000ms (52 reads)
last state:  title "Principal Product Test Engineer…" · formFields 0 · markers [applyFlowPage]
sign-in outcome: unknown
```

Three fixes, in order of how much they mattered:
1. `applyFlowPage` + no auth chrome now counts as success (waiting for fields here is duplicated work —
   both walks call `awaitFieldSetSettled` anyway).
2. An EMPTY page after a submit must PERSIST across 3 consecutive reads before it earns a reload — an
   empty page right after an auth POST is a navigation in progress, not a dead shell.
3. The first retry rung 500ms → 4000ms; 500ms timed out on 3/3 sign-ins whose clicks had all worked.

For reference: filling starts **~135ms** after success is detected, so there is nothing to win after
sign-in itself.

**✔ SIGNING OUT WORKS — the old claim here ("you cannot force a sign-in by clicking Sign Out; Workday's
session self-restores from a persistent cookie; clearing site cookies is the only reliable way") is WRONG
and was corrected 2026-08-11 by the operator, then verified live on cat.wd5.** The UI sign-out lands on
`/login`, and the very next run logged `Stage 3 — auth screen detected` + `sign-in attempt 1`. Do it from
any tenant page in three JS clicks (coordinates drift; automation-ids don't):

```js
document.querySelector('[data-automation-id="hammyMenuIcon"]').click();          // top-right menu
// wait ~1.8s
document.querySelector('[data-automation-id="account-submenu-button"]').click(); // shows the account email
// wait ~1.8s
[...document.querySelectorAll('button,a,[role="button"],[role="menuitem"]')]
  .find(e => /^sign\s*out$/i.test((e.innerText||"").trim())).click();
```

⚠ **This matters more than it looks: while the session is warm, EVERY run skips Stage 3 entirely.** Live,
six consecutive runs produced ZERO sign-ins — so any onboarding auth bug (the re-click, the empty shell,
create-account) is UNREACHABLE by re-running, and a clean result proves nothing about that code. Sign out
before each auth test. The session cookie is HttpOnly (only `timezoneOffset` is JS-visible on cat.wd5), so
the page cannot clear it — the UI sign-out is the lever. See the `signed-out-testing` memory.

### Fresh-account findings (2026-08-07) — read before starting one

A fresh alias exercises the ACCOUNT-CREATION path, which the tenants on the scoreboard below never did
(they all had accounts). Two blockers lived there and are now fixed; three facts remain:

- **The login alias MUST be an alias of the CONNECTED mailbox.** Gmail auto-verify polls
  `wangykev@gmail.com`, so a `tester+NN@gmail.com` login is a completely different inbox and the
  verification mail never arrives — the run sits in "polling Gmail… (up to 120s)" and halts. Use
  `wangykev+NN@gmail.com`. Switching to it turned `analogdevices.wd1` from blocked into a full
  `SUBMIT GATE PASSED` on the next run (`verification link found — navigating the tab to it`).
- **The post-verify sign-in can lose a race.** Straight after auto-verify, ADI halted `auth-unknown`
  with the page at `readyState loading` — a 500ms first wait classifying a still-loading page. A plain
  re-run signed straight in. Retry once before believing it.
- **Polling the localhost tab with `javascript_tool` ACTIVATES it**, so a run launched `background:false`
  logs `tab HIDDEN` and you will mislabel it. To measure a genuinely visible run, fire it and then wait
  WITHOUT touching Chrome (a backgrounded `sleep`), reading the log only afterwards.
- **`window.__last` is as unreliable as the log ring.** An aborted run's promise resolves late and
  overwrites it, so a result object can belong to a run you killed two tenants ago. Grade the TAIL against
  a cursor, exactly as with log lines.

**The self-ID disability blocker was a COLON, and is FIXED** (2026-08-07). Worth knowing because it was
mis-described for several sessions as "the checkbox unchecks itself", which sent a whole round chasing a
Workday-side ghost.

- **Workday's part is real**: re-entering a SAVED application DROPS the disability answer while its
  siblings on the same page keep theirs. So the replay always meets `disabilityStatus ""*`.
- **Our part was the bug**: `parseErrorFieldName` strips a trailing `:`; `normalizeLabel` strips only `*`.
  So `"Please check one of the boxes below"` (from the error) never equalled
  `"Please check one of the boxes below:*"` (the live label), and both recovery paths reported "match no
  field on this page" while the field sat there with an approved value. Fixed by `errorLabelKey`.
- **The tell is pass-then-fail**: the recovery only runs after Workday has dropped the value, i.e. on a
  RE-ENTRY. `analogdevices.wd1` passed rehearsal #1 and failed #2, deterministically — if you only ever
  rehearse once per tenant you will not see this. **Rehearse twice.**

**waystar's variant is also FIXED** — it was two more faults stacked on the same page:

- **Synthetic CLICKS don't reach Workday's model on the self-ID page.** The tell is our read-back and
  Workday disagreeing: `page 5 replay: … 0 FAILED` immediately followed by
  `re-click fallback: error text present — a real validation block`. The whole page now goes TRUSTED on
  the replay, clicks included. Result: force-re-fills 0, page 5 advances on the first Save.
- **A signature date goes stale overnight.** `Error-Date "Enter today's date"` — the bundle was approved
  08/06 and replayed 08/07. `replayField` now re-derives it, and `reconcileReviewPage` compares against
  today to match (fixing only one half traded a nav-timeout for a submit block). **A one-day-old approval
  is enough**, so any review not submitted the day it was filled hits this — test it deliberately by
  approving one day and rehearsing the next.

**A test-writing warning from this round.** The first draft of the reconcile tests passed for the WRONG
reason: the fixture used the wrong argument shape, every row landed in `missing_on_review`, and "0
disagreements" looked like success. They now assert `tier === "keyed"` to prove they reach the real
compare. Always check WHICH path your fixture exercises, not just the verdict.

### Scoreboard as of 2026-08-07

| Tenant | State |
|---|---|
| `itron.wd5` (NEW) | **verified live 2026-08-07** — `SUBMIT GATE PASSED`, hidden, fresh account created this run |
| `nvidia.wd5` (NEW) | **verified live 2026-08-07** — `AGREE 47 · DISAGREE 0` → `SUBMIT GATE PASSED` on rehearsals #1 AND #2. Needed the required-dropdown backstop (its Phone Device Type offers only Home / Home Cellular, no "Mobile"). Page fills hidden: 11.7 · 17.1 · 2.9 · 3.4 · 6.8s |
| `marvell.wd1` (NEW) | fill verified live 2026-08-07 — REVIEW after 5 pages, reported 200. Approve/rehearse not yet run |
| `jabil.wd5` (NEW) | **blocked** — its `Type to Add Skills*` is REQUIRED, and skills is the deferred unmapped section. The AI forced `"No Items."` (the empty-list placeholder), the commit correctly did not persist, and the walk halted naming the field. This turns the deferred SKILLS work into a hard blocker for any tenant that makes it required |
| `analogdevices.wd1` (NEW) | **verified live 2026-08-07** — `SUBMIT GATE PASSED` on rehearsals #1, #3, #4; #2 is what caught the colon bug |
| `magna.wd3` (path-hosted) | **verified live 2026-08-07** — `SUBMIT GATE PASSED`, hidden, fresh account |
| `radiancetech.wd12` (NEW) | fill verified live (REVIEW, 5 pages); rehearsal blocked on the self-ID group |
| `waystar.wd1` | **verified live 2026-08-07** — `SUBMIT GATE PASSED`, `AGREE 41 · DISAGREE 0`; needed all four self-ID fixes |
| `cat.wd5` | fill verified live (REVIEW, 5 pages); rehearsal blocked page 1, no error text (stale draft) |
| `analogdevices.wd1`, `jabil.wd5` | blocked on email verification — see the alias note above |
| Aptiv, PSECU, clearesult, Home Depot | verified live (earlier sessions, pre-existing accounts) |
| `copart` | externally blocked (operator gate) |
| `clearwater` | unresolved |

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
