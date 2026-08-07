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

```js
// Set the job URL. NEVER type a URL with the computer tool — it drops characters (a real run
// died on "magna/Magna" -> "magnaMagna"). Use the native setter.
const el = [...document.querySelectorAll("input")].find(i => /company\.wd5/.test(i.placeholder || ""));
const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
set.call(el, JOB_URL);
el.dispatchEvent(new Event("input", { bubbles: true }));
await new Promise(r => setTimeout(r, 1000));

// VERIFY before clicking — the button is disabled until the URL validates, and a click on a
// disabled button is a silent no-op that looks exactly like a run that produced nothing.
const btn = [...document.querySelectorAll("button")].find(b => /^Run$/.test(b.textContent.trim()));
if (el.value.length > 40 && !btn.disabled) btn.click();
```

Then poll `__tail()` every ~40s. A fill is 1–4 minutes depending on page count and AI calls.

For the rehearsal, same URL, but match `/Rehears/` instead of `/^Run$/`.

## Reading the logs — the rules that stop false conclusions

**The log is a RING BUFFER shared across runs.** A line matching your pattern is very often from a
PREVIOUS run. This has caused wrong conclusions repeatedly. Before believing any line:

```js
const r = await window.__apSend({ type: "AP_DEV_LOGS", limit: 50 });
const last = (r.lines || []).slice(-1)[0];
Math.round((Date.now() - last.t) / 1000);   // age in seconds — is this even your run?
```

**Silence can be the success signal.** The walk logs only FLAGGED records (`⚠`). A deterministic
`filled` is not logged. So "no line for field X" often means X filled cleanly — do not read it as
"X did not run".

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

## Traps that produce false results

- **Don't close tabs mid-run.** `AP_DEV_CLOSE_TABS` while a run is tearing down produces
  `walk aborted: CDP not attached`. Close BEFORE starting, never after.
- **A leftover Workday tab can hold a browser dialog** (password manager / breach warning) that
  blocks sign-in invisibly — the extension cannot see browser chrome. Symptom: sign-in submits with
  no outcome. Close stale tabs and retry.
- **`npx next build` clobbers the dev server's `.next`.** Never build while the dev server serves.
- **Multiple Chrome browsers connected** → you MUST ask the user which one; never pick.
- **A dead posting returns HTTP 200** and a generic "Careers" page. Confirm with the CxS API before
  blaming the code: `GET /wday/cxs/<tenant>/<board>/job/<path>` → 403 means unpublished.

## Phantom errors — when to bump the login

After repeated runs on one form, Workday starts producing errors that do not match the page: "already
exists for this application", duplicate-URL errors with no visible duplicates, `VPS|` codes. That is
its stale server-side state, not a bug you introduced.

Fix: change the login email on `/app/credentials` — `tester+23@gmail.com`, `+24`, … — using the
native setter, then Save (look for `✓ Saved`). Sign out of Workday or wait for cookies to expire
before retrying the FAILING form; a fresh account on a fresh form works immediately. Confirm with
`login recorded for this run — tester+NN@gmail.com @ <Tenant>`.

Prefer tenants where the account already exists: no email verification, so no Gmail dependency.

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
