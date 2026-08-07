---
name: ats-tenants
description: Testing and debugging the NON-Workday pipeline — Greenhouse, Lever, Ashby (ats.js). Read this before running a fill on a job-boards.greenhouse.io / jobs.lever.co / jobs.ashbyhq.com posting, before touching the option poll or the field router, and before concluding a widget is broken. Covers the dev loop, the debugging rules that were each paid for with a wrong conclusion, and what "end to end" means here.
---

# Non-Workday tenants (Greenhouse · Lever · Ashby)

Sibling to `live-testing`, which describes the Workday walk. The invariant is shared and absolute:
**every run here is a FILL or a REHEARSAL (`arm:false`).** A rehearsal that reports
`▶▶ WOULD CLICK SUBMIT ◀◀` has SUCCEEDED — that is the terminal state, not a step to follow up on.

## Why this pipeline is a different shape

These forms are ONE page, login-free and draft-free. There is no onboarding stage, no session, no
page-to-page walk, nothing to resume. So the whole pipeline is **two visits to a blank form**:

| | Workday | here |
|---|---|---|
| reaching the form | onboard: Apply → sign in → page 1 | navigate; that's it |
| filling | N pages, SW-driven walk | one page, `driveAtsPageFill` |
| the draft | Workday holds it server-side | nothing is held — a submit run REFILLS from the bundle |
| actuation | trusted `Input.*` (synthetic when hidden) | **page-side synthetic always**, via `Runtime.evaluate` |
| the one trusted act | the submit click | the submit click |

That third row is the one people forget. A submit run does not "resume" anything: it opens a blank
form and replays the approved bundle into it, then verifies strictly. **A field the fill filled but
the bundle does not carry will be blank on submit** — which is exactly how the résumé-in-the-cover-
letter bug hid (below).

The fourth row is why Workday's input-trust reasoning does not transfer. All three ATSs commit state
from synthetic events (react-select opens, filters and commits fully synthetic), so **visible and
hidden runs are identical** — no pacing regime, no focus emulation, no input-event budget. If you
find yourself reasoning about frames or trust here, check that assumption first.

## What "end to end" means

Only when all four happened in one sitting:

1. **Fill** — `fill complete — N field(s), M need review`
2. **Approve** — on `/app/tracker/<id>`, `N / N flagged` and Ready to submit
3. **Rehearse** — `verify: N field(s) replayed, 0 failure(s); bundle blockers: 0`
4. **Gate** — `▶▶ WOULD CLICK SUBMIT ◀◀`

A fill alone is not end to end. The replay is a different code path against a different page state,
and it is where the remaining bugs live.

## The dev loop

```js
// helpers — install in a localhost tab; chrome:// and chrome-extension:// are blocked.
// A PAGE NAVIGATION WIPES THESE. Re-install after every navigate or you get
// "window.__apSend is not a function" and waste a round trip.
const EXT = "<NEXT_PUBLIC_EXTENSION_ID from web/.env.local>";   // localStorage does NOT hold it
window.__apSend = (msg, ms = 15000) => new Promise((res, rej) => {
  let d = false; const t = setTimeout(() => { if (!d) { d = true; rej(new Error("timeout")); } }, ms);
  chrome.runtime.sendMessage(EXT, msg, (r) => { if (d) return; d = true; clearTimeout(t);
    res(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : r); });
});
window.__tail = async (pat, n = 12) => {          // see the sanitizing rule below
  const r = await window.__apSend({ type: "AP_DEV_LOGS", limit: 900, pattern: pat });
  return { inFlight: r.runInFlight, lines: (r.lines || []).slice(-n)
    .map(l => (l.msg || "").replace(/[a-zA-Z]+:\/\/\S+/g, "LINK").replace(/[?&=]/g, " ").slice(0, 195)) };
};
window.__start = async (url, mode) => {           // mode: "Run" | "Background fill" | "Rehearse (no submit)"
  const inp = [...document.querySelectorAll("input")].find(i => /url|job|link/i.test(i.name + i.placeholder + i.type));
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(inp, url);
  inp.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise(r => setTimeout(r, 500));
  [...document.querySelectorAll("button")].find(b => b.textContent.trim() === mode).click();
};
```

Messages: `AP_PING` (returns `build`), `AP_DEV_LOGS` (`{limit, pattern, cursor}` — a ring that
survives worker restarts), `AP_DEV_ATS_SCAN` (`{ats, tabId|urlContains}` — the live form state, the
"go look at the tab" verification), `AP_DEV_FLAG` (`forceWorkerTimersOff`, `forceTrustedInput`),
`AP_DEV_CLOSE_TABS`.

**Reload to a BUILD MARKER, never to a sleep.** `chrome.runtime.reload()` races the next click, and a
run on stale code looks exactly like a fix that did not work — this cost several wrong conclusions in
one session. Bump `AP_BUILD` in background.js with each change and poll for it:

```js
window.__reloadTo = async (build) => {
  try { await window.__apSend({ type: "AP_RELOAD" }, 4000); } catch (e) {}
  for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 1000));
    try { const p = await window.__apSend({ type: "AP_PING" }, 3000); if (p.build === build) return { ok: true }; } catch (e) {} }
  return { ok: false };
};
```

**Chrome occasionally WEDGES the service worker** after a reload (a Chrome bug, not a throttle — reload
as often as you need). Symptom: even `AP_PING` times out. Only a manual chrome://extensions reload
fixes it; ask the operator for that one click.

## Reading the logs

- **It is a RING BUFFER shared across runs.** A line matching your pattern is very often from a
  PREVIOUS run — this produces confident wrong conclusions. Check `l.t` age, or key on a marker you
  know is unique to this run.
- **Sanitize the output.** The MCP layer blocks anything resembling cookie/query data, and you lose
  the whole read to `[BLOCKED]`. Strip URLs and `?&=` (the helper above does).
- **Log entries are `{msg, lvl, n, t}`** — `l.msg`, not `l.line`/`l.text`. Mapping the wrong key
  silently prints a column of `[object Object]` or blank lines.
- **Don't sleep past the CDP ceiling.** `Runtime.evaluate` times out at 45s, so an in-page
  `setTimeout(60000)` fails the call and loses the result. Poll in ≤40s slices.

Worth grepping: `[ATS-TIME]` (per-run: total, ms/field, paint state, slowest fields — the line every
pacing decision should be retuned from), `[ATS-FILL]` (per field: status · tier · value · ms · why),
`[ATS-SUBMIT]` (the gate), `never answered` (a widget's own service didn't respond).

Field statuses: `filled` (deterministic, silent) · `filled_review` (committed but flagged — every AI
answer, every containment/polarity bridge) · `needs_review` (we have an answer the form wouldn't
take, or a commit didn't verify) · `skipped` (nothing to do, and that is correct).

## The traps that produce false results

- **The API key rotates.** `syncEverything` on `/app/connect` mints one key and DELETES all prior
  ones, so any earlier sync is dead. Symptom: `review pull: HTTP 401` then
  `REFUSING: no approved bundle for job_key … — never replaying a different application's values`.
  That refusal is CORRECT behaviour; re-sync and re-run. Expect this after any credential change.
- **Never start a run while one is in flight.** `runInFlight` is exclusive and a second call's tab
  cleanup closes the first run's tab, producing `CDP not attached` on every field — a "total failure"
  that is purely self-inflicted. Check `__tail().inFlight` first.
- **Confirm the browser and the tab.** Multiple Chrome profiles connect; never guess which. Ask.
- **react-select CACHES BY QUERY.** Re-tracing a fix with a query you already typed answers in ~9ms
  with no network and reads as a pass. Use a query you have not typed this session.
- **A test that passes both ways proves nothing.** When a live run contradicts a green test, the test
  is wrong until proven otherwise — revert the fix and confirm the test FAILS.

## Debugging rules, each paid for

**Install page overrides BEFORE the document exists (2026-08-07).** Our overrides replace
`setTimeout`/`setInterval`/`rAF` so a hidden tab escapes throttling. Landing them on an
already-running document leaves the page half-native/half-ours, and react-select — which schedules
its search on exactly those timers — never resolves again. Symptom: every server-backed combobox sits
`loading` to its ceiling and reaches review unanswered, **and a refresh cures it**. Only Greenhouse
showed it, because only Greenhouse serves its form FROM the posting URL; Lever and Ashby navigate on
to `/apply` and `/application` and get a fresh document. The run therefore opens its tab BLANK,
attaches, registers the overrides, and only then navigates. *If you ever see a widget that works by
hand and not under a run, ask what the run did to the page before the page loaded.*

**Screencast was removed, and here is when to bring it back.** `Page.startScreencast` puts a hidden
tab under capture, which makes Chrome keep producing frames. It genuinely works, and it was genuinely
unnecessary — it was compensating for the override bug above. Measured after the real fix, tab
verifiably dark: Discord 16.9s vs 17.2s under capture; Reddit's rehearsal, the run that FAILED without
forcing, passed its whole gate dark. It is not free (capture makes the renderer paint; at
`everyNthFrame:1` the JPEG encoding starved the renderer it was meant to free). Bring it back only
with a measurement. ⚠ **You cannot measure it while your own automation holds the tab under capture** —
the paint probe will read `painting (hidden)` with forcing off, and that reading is your tooling, not
the product. Confirm the probe reports `NOT painting` before believing a dark-tab result.

**Ask the PAGE, not a clock.** The option poll separates kinds of "nothing yet", because they need
opposite treatment: `loading` (the widget says a fetch is in flight) earns the full ceiling;
mounted-but-empty needs one confirming read; a menu that never mounted gets a brief grace. Before
believing any of it, consult the quiescence watch (`act.quietInstall`/`quietRead`) — the page stamps
its last mutation and the SW waits on real wall-clock. ⚠ Do **not** use our own read latency as the
proxy: it measures the CDP round trip, not the page, and a version that did skipped three healthy
dropdowns on a page whose reads took ~1.4s.

**Never re-type a slow widget.** That restarts its debounce and discards the search in flight. A
force-open + re-type is for a menu that is genuinely CLOSED. An open-but-empty widget that never
reported loading gets exactly one nudge.

**Look before clearing.** A long server-backed list does not carry the searched value on its
unfiltered first page, so clearing the query to "unfilter" deletes the option you were about to click.
Read the menu first; clear only when the option isn't on screen.

**List numbering is display scaffolding on BOTH sides.** `"1. United States of America"` beats exact,
containment (off for dropdowns by design) and fuzzy (88.9% vs the 90 bar). `atsEnumStrip` must be
applied to CANDIDATES too — a commit stores the real text, so a replay's approved value arrives
carrying the numbering, and stripping one side only made the replay fail to match what it had just
produced.

**A label's guess loses to the live widget.** "Where are you currently based?" reads like a places
question; GitLab answers it with a three-option pick-one already showing the answer. A location-routed
field whose widget shows a short list IS a pick-one. (Same rule as Workday's widget-adaptive fill.)

**The résumé goes in the résumé slot.** Greenhouse renders the cover letter as a file DROPZONE, and
the replay treated every `file_upload` as the résumé. The fill never did — its router maps
`cover_letter` → skip — so only a rehearsal could surface it, and NO gate can: the strict verify
re-checks approved VALUES, and a skipped field carries no file. Replay file fields route through the
same router the fill uses. Healthy `AP_DEV_ATS_SCAN` reading: *N file fields with
`cover_letter value:null`*.

**An identity checkbox is an option, not a question (2026-08-07).** Ashby renders its diversity survey
as select-all-that-apply — "Person with disability", "Veteran", "Neurodiverse" — so the LABEL is the
value. A stated answer carries its polarity in its leading words ("No, I do not have a disability"),
and leaving the box unchecked IS that answer. Matching such a label needs EXACT normalization only:
"East Asian" must never decide a box labelled "Asian" while an "East Asian" box may sit below it.

**Report what you observed, not a theory.** Several of the longest detours in this codebase were tidy
explanations that outlived the bug that caused them.

## Per-ATS traps

Full traces live in `docs/dom-patterns.md` (2026-07-31 onward). The ones that bite repeatedly:

- **Greenhouse** — `#country` is the phone DIAL-CODE composite, not a country question. Scope option
  reads to the widget's own `react-select-<name>-listbox` (a page-wide scrape is contaminated, same
  lesson as Workday). Escape does NOT close its menus. `candidate-location`'s places service does not
  load in every browser — an honest `needs_review` naming the cause is the correct outcome.
- **Lever** — radio `value` is the full answer text, and the NodeList holds TEMPLATE rows with JSON
  blobs (visible-only). Location free text is CLEARED on blur and the suggestion render never happens
  hidden, so fetch the widget's own `/searchLocations?text=…` and write the input + hidden
  `selectedLocation` JSON exactly as a click would. Its DORMANT invisible-hCaptcha container is a
  full-viewport `visibility:hidden` iframe — detect challenges by computed style AND sane dimensions,
  never size alone.
- **Ashby** — field entries are the semantic `.ashby-application-form-field-entry` UNION the hashed
  `[class*="_fieldEntry"]` (the EEOC and consent entries carry only the hashed one). The location
  combobox has NO id/name, so the scan STAMPS one and routes by LABEL. Consents' `name` IS the label
  text. EEOC radio names carry a PER-SESSION uuid prefix — key on the durable `__systemfield_*` suffix
  on both sides. Date questions fill as text with a `date-format-unverified` flag.

## Finding postings

`job-boards.greenhouse.io/<company>/jobs/<id>` · `jobs.lever.co/<company>/<uuid>` (form at `/apply`) ·
`jobs.ashbyhq.com/<company>/<uuid>` (form at `/application`). No login, so any live posting works and
you can test the same one repeatedly — none of Workday's phantom-state problem applies. The tracker
already holds a spread:

```js
const r = await fetch("/api/applications", { credentials: "include" }).then(x => x.json());
(r.applications || r).filter(a => /greenhouse|lever\.co|ashbyhq/.test(a.url || ""))
  .map(a => ({ c: a.company, u: a.url }));
```

**Pick for form variety, not company.** The point of many tenants is many form shapes: an EEOC block,
a school/degree pair, a places box, a consent list, a salary question, a long free-text. Two postings
from one company usually exercise one shape twice.
