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

**Timing, measured (round 8, `docs/fill-speed-log.md`):** hidden ≈ visible in wall-clock too, so the
sentence above is safe to read as a timing claim as well — with one caveat and one warning.
*Caveat:* our own non-LLM fill work is ~5.8s cheaper visible on a 25-field page (1.41×, p=0.057, n=4/arm)
— real but ~5% of a fill. *Warning:* **the LLM is 76–91% of an ATS fill**, so a hidden-vs-visible
comparison that does not subtract the `[LLM]` line measures the provider. An earlier "hidden is 2.4×
slower" claim came from one run per arm and was refuted; the second run of a back-to-back pair is slower
whichever arm it is. Use `AP_DEV_LLM_PROBE` (idle, no-tab control arm) to get the provider's baseline
before attributing anything to visibility.

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

---

# Reference — the mechanics

Full trace detail: `docs/dom-patterns.md` 2026-07-31 onward; milestone: `docs/progress-log.md` 2026-07-31.

## Routing and the run

**`detectAts(url)` routes `AP_RUN_APPLICATION` / `AP_SUBMIT_APPLICATION`:**

| ATS | posting host | form |
|---|---|---|
| greenhouse | `job-boards` / `boards.greenhouse.io` (incl. `.eu`) | same URL |
| lever | `jobs(.eu)?.lever.co` | `/apply` |
| ashby | `jobs.ashbyhq.com` | `/application` |

Workday and anything unrecognized keep the existing onboard→walk path **byte-identical**.

No auth stage — `runAtsApplicationRun` navigates, settles (`waitAtsFormReady`), scrapes the JD via
`scrapeJobPosting`, fills, reports. All through CDP (`chrome.debugger` isn't host-gated) — **NO new host
permissions.**

⚠ The posting settle must be asked over **CDP** (`waitAtsPostingSettled`), because `waitJobPageSettled`
reads through host-gated `chrome.scripting` and the ATS hosts are deliberately absent from
`host_permissions` — it failed on its first read on every ATS run and logged a settle that never happened.

**Actuation is page-side synthetic via `Runtime.evaluate`.** All three ATSs commit state from synthetic
events (proven live; react-select opens/filters/commits fully synthetic), so visible and hidden runs are
IDENTICAL: no `Input.*` pipeline, no focus emulation, no pacing regimes. The ONE trusted-input exception is
the SUBMIT click (irreversible + captcha vendors score event trust — `cdpSetSyntheticInput(false)` +
`cdpClickAt`).

Every commit is read-back-verified; an M40-lite audit re-reads the page after the loop; AI fills are ALWAYS
flagged. Records feed the UNCHANGED `buildReviewBundle` → the website review editor works as-is.

## Value routing (`atsRouteField`, first hit wins)

1. **Per-ATS static maps** — GH semantic ids incl. the EEOC block; Lever `name=` keys + `urls[*]`; Ashby
   `_systemfield_*`.
2. **Buckets** — exact wording (live: Ashby's "Phone Number" filled from the website's default
   field-wording bucket).
3. **Label recognizers** —
   - work-auth / sponsorship ("US person" / export-control wordings BAIL to AI);
   - links;
   - salary / start-date, STATED-only;
   - how-did-you-hear ladder — its label match allows ONE adverb in the middle ("How did you FIRST hear
     about this role?" missed it and sent a REQUIRED question the profile answers exactly to the AI) and
     requires the verb to be followed by about/of/this/us/our (the old wording ended at the verb, so "How
     did you find working with your last team?" routed here);
   - EEO stated-only;
   - location.
4. **`recognizeEmploymentQuestion` / `decideEmploymentStatus`** (live: "worked for Figma before?" →
   deterministic clean-miss "No").
5. **AI** — REQUIRED only, same `act.llm` gating; a choice must clear the ladder vs LIVE options; declined
   required text gets the NEEDS-YOUR-ANSWER placeholder.
6. **blank + review.**

Booleans coerce through `resolve()`'s Yes/No ladders.

## Match-ladder amendments earned live

- **Stated-EEO routes pass `containment:true`** — each ATS words long-form demographics its own way, so a
  unique prefix hit commits at the flagged containment tier.
- **Plus the POLARITY BRIDGE** — a stated value LEADING with Yes/No maps to the unique same-polarity option
  via `optionForPolarity` ("No, I do not have a disability" → Ashby's "No, I don't have…" — a contraction NO
  string tier can bridge), flagged `polarity-lead`.
- **Choice records store the COMMITTED OPTION TEXT, never the chip display** — the GH dial chip renders
  "+1" for "United States +1", and a bundle holding "+1" can never replay. The audit + verify accept the
  chip as a SUBSTRING of the recorded text.

## GROUPED CONTROLS belong to the grouping pass, in EVERY branch (2026-08-07)

Greenhouse's general element loop skipped only `hidden`, so each box of a checkbox group was pushed TWICE:
once as a REQUIRED `text` field keyed on the box's own id, then again as the real `checkbox_group`. On
Gusto's 12-box "select all that apply", every phantom inherited the group's required flag and bought its own
LLM call answering `"N/A"` — **12 of that form's 21 review items.**

Worse than noise: `atsInjSetText` on a checkbox writes its `.value`, the string that option would SUBMIT.

Lever and Ashby always skipped both; source-pinned across all three branches in `test/ats.test.js` (verified
to FAIL when the skip is removed).

## A STATED ANSWER CARRIES ITS POLARITY IN ITS LEADING WORDS (2026-08-07)

Ashby renders its diversity survey as SELECT ALL THAT APPLY — each identity its OWN checkbox, so the LABEL is
an option, not a question. The profile answers in whole sentences (`"No, I do not have a disability"`), which
matched neither `/^(yes|true)$/` nor `/^(no|false)$/`, so questions the profile ALREADY ANSWERS came back as
"your profile answer isn't one of this form's options".

Leaving the box unchecked IS that answer: polarity now reads the leading words (reusing the assertion-lead
regexes; **negative is tested first**, since "I am not a protected veteran" satisfies the positive lead too),
and an answer that NAMES the box is its affirmative — **exact-normalized only**, and deliberately NOT gated on
`atsIsEeoLabel` (that detector knows dimension names, while these labels are the values). Containment stays
out: `"East Asian"` must not decide a box labelled `"Asian"`.

## LIST NUMBERING IS DISPLAY SCAFFOLDING, ON BOTH SIDES (2026-08-05)

`"1. United States of America"` beats exact, containment (off for dropdowns by design) AND fuzzy (**88.9%**
vs the 90 bar), so a REQUIRED field the profile answers perfectly went unfilled.

`atsEnumStrip` removes it for MATCHING only — the click uses the option's real text — and it MUST be applied
to CANDIDATES too: a commit stores the real text, so a replay's approved value arrives carrying the
numbering, and stripping one side made the replay fail to match the value it had just produced. Narrow by
construction: `1 - 3 years` and `401(k)` are untouched.

## THE OPTION MENUS ARE NOT VIRTUALIZED — MEASURED (2026-08-07)

Asked because Workday's picker IS windowed and this path has no scroll accumulator. Traced in the live DOM:
GH `country` holds all **244** entries ("Zimbabwe+263" last) and `discipline--0` all **72**, unchanged after
scrolling to the bottom; Ashby's location box opens with **0** and answers only what you type; Lever has no
combobox at all.

Plain react-select renders every option and CSS-clips it, so ONE `querySelectorAll` already reads the whole
list — **do not port `cdpScrapeTaOptions` here.**

The consequence: `atsAttachOptions` calling any list of ≥60 "partial" was discarding options already in hand
(244 countries reached review as 60 + "not the full list"). **Partial is now PROVENANCE** — a menu read on
OPEN is complete however long; anything reached by TYPING is a view of it — and the flag is **never
cleared**, because clearing the query restores the whole list on a static widget but only page ONE on a
server-backed one, and those are indistinguishable from inside the code (that is what keeps the paged-school
guard: absence is only provable against a list that answered in full). Storage caps at 400 and a truncated
list still says so.

The WHY travels too: `optionsPartial` was set and never read, so the site re-derived it from
`captured_options.length > 2` and a server-backed field returning 1–2 rows — the case that most needs
explaining — got no explanation. It rides the bundle as `options_partial`.

## THE 2.5s SETTLE FLOOR STAYS — MEASURED AND REFUTED (2026-08-08)

`waitAtsFormReady` accepts on **three equal field counts AND ≥2500ms** (sections mount in BURSTS; two reads
accepted Ashby at 9 of 16 fields). That floor is 2–4.5s of dead time on forms that mount in ~500ms.

Replacing it was instrumented (an in-flight `fetch`/XHR counter installed with the page overrides, plus a
page-side mount sampler from document start) and **the replacement was refuted, so the floor is unchanged**:

- **DOM quiescence fails** because a form is genuinely still between bursts (Ashby/Sierra: `2040ms c=60 q=1`
  — DOM quiet, request in flight, one more control to come).
- **In-flight fails too, which is the decisive one**: GH/Discord read `280ms c=34 q=0` — stable count,
  nothing in flight — and two more controls arrived **1.4s later** on requests that had not started yet.
  `q==0` means "nothing in flight NOW", never "nothing more is coming"; the distinguishing event is in the
  future, so no observable signal separates "finished" from "quiet before the next burst".

Two traps this cost: wrapping `fetch` must `.bind(window)` or a bare call throws `Illegal invocation` and the
form never mounts; a backtick in a `buildOverrideSrc` comment terminates its template literal. Numbers in
dom-patterns 2026-08-08.

**⚠ Do not re-run this experiment without a slow-form counter-example.**

## A LABEL'S GUESS LOSES TO THE LIVE WIDGET — the "Location" instance (2026-08-07)

Third instance, after GitLab's three-option pick-one and Discord's already-rendered degree list: ElevenLabs
labels a field "Location" and describes it *"Country you're currently residing in"*. We typed the city, read
an empty menu, and blamed the places service for 15s.

Now the city falls through to the REMAINING candidates (the location rung already tiers the country behind
the city; a **bucket** routes first and carries one value, which is how that field arrived holding only
`"Pittsburgh, PA"`, so the profile's country is appended), and those alternatives are matched through the
**ordinary ladder** — the country tier's wording is routinely LONGER than the option (`"United States of
America"` vs `"United States"`), which the city-containment pick cannot see.

The places pick itself got STRICTER (`atsPlacePick`): the query is the **city alone**, because a service that
never heard of `"Pittsburgh, PA"` answers `"Pittsburgh"` instantly, so the strictness moves to the pick —
prefer the row agreeing on the **state in either spelling** (`REGION_ABBREV`, Canadian provinces included),
because "first row containing the city" silently files against the wrong Pittsburgh; a state we hold that no
row offers still answers, at the flagged tier.

⚠ `personal_info.country` may itself be a LADDER ARRAY, which must be flattened into candidates or the match
ladder throws `s.toLowerCase is not a function` mid-fill.

## A CLOSED POSTING IS NOT A BROKEN PIPELINE (2026-08-07)

Twilio and Binance both halted `form-not-rendered … open the tab and check`, sending the operator to debug a
fill on a job that no longer exists. Both said so first: **Lever** serves a removed posting the title `Not
found`; **Greenhouse REDIRECTS to the board index** (`Current openings at <Company>`) dropping the job id
from the URL.

`atsPostingGone(jd, requestedUrl, landedUrl)` reads both — the URL rule is the general one, the titles
corroborate — and returns a REASON, **null when there is no evidence** (a missing JD must never read as a
dead job). Halt is `posting-gone`.

## `runAtsSubmitRun` gates

All must pass before the one trusted click:

1. bundle blockers (`bundleSubmitBlockers`);
2. **STRICT live verify** — every approved non-blank value committed on the fresh form; an approved field
   ABSENT from the live form FAILS;
3. **no VISIBLE captcha challenge**;
4. `arm===true` (absent ⇒ full dry rehearsal logging "WOULD CLICK SUBMIT").

**AI is OFF for submit runs regardless of the toggle** — `valueFor` covers every approved field; anything
else is deliberately blank.

⚠ Lever's DORMANT invisible-hCaptcha container is a FULL-VIEWPORT `visibility:hidden` iframe — the challenge
detector reads COMPUTED styles + sane challenge dimensions (<700px), never size alone. A VISIBLE challenge
halts `needs_operator` — **the bot never solves or bypasses a captcha.**

Post-click: poll for confirmation text / validation errors / a challenge, 30s, then "verify in the tab"
honestly.

Verified as DRY REHEARSALS on all three (GH · Lever · Ashby → would-submit; NOTHING submitted).

## Two environment traps that read as code bugs

**⚠ THE DEV SERVER MAY NOT BE THIS WORKTREE'S (2026-08-07).** Two web-side fixes read as broken for an hour
because **port 3000 was served by a DIFFERENT worktree**; the extension is loaded unpacked from HERE, so
extension changes took effect and only the web ones seemed inert — a badly confusing signature. This
worktree runs on **3200** (`NEXT_PUBLIC_SITE_URL`, gitignored `.env.local`). Check
`Get-NetTCPConnection -LocalPort <port>` before believing a web change did nothing.

Also: `AP_SET_SESSION` logs the HOST it will report to (never the key), because a stale ingest credential is
the most common way a healthy fill misses the tracker and it was silent. And the run opens a TAB PER RUN
that nothing closed — 33 accumulated and wedged the browser; use `AP_DEV_CLOSE_TABS {urlContains}` after each
run, **never while one is in flight**.

**REPORT THE REPORT HONESTLY (2026-08-07).** `reportApplication` returned nothing, so the ATS run printed
`"Reported to the website."` one line under the ⛔ saying the tracker had rejected it. It returns
`{ok, reason, status}` now (including the quiet `not-connected` / `no-bundle` paths) and the caller says
which happened.

Related, website-side: **a run refreshes the extension's ingest credential before it starts** (`getSession` +
`AP_SET_SESSION` on Run / Background fill / Rehearse / Submit) — minting a key DELETES the prior ones, so any
later sync silently invalidates what the extension holds, surfacing as a fill that never reaches the tracker
or a submit run that 401s and REFUSES.

## Known limits

- GH `candidate-location`'s places service can hang on "Loading…" with zero network in this browser (even
  HUMAN typing) → honest `needs_review` naming the cause. **⚠ Do NOT reach for that explanation FIRST:** the
  same report was produced twice by our own bugs (the mid-life overrides, and a country-shaped box searched
  with a city), and it reads exactly like an environment problem.
- Visible-hCaptcha Lever forms halt `captcha-challenge`.
- GH `cover_letter` deliberately operator-supplied.
- Ashby date questions fill as text + `date-format-unverified` flag.
