---
name: workday-walk
description: The SW-driven multi-page Workday walk — page transitions, the never-submit guards, nav-timeout halts, AI-4 error remediation, the phantom duplicate-entry fix, repeating sections (work experience / education / websites / languages / certifications), and résumé attach. Read this before touching runCdpWalk, runCdpReplayWalk, clickPageNext, any *_MAP section map, or attachResume.
---

# Multi-page walk, repeating sections, and résumé attach

Workday applications span several pages (My Information → Experience → Questions → … → Review). Live on
both substrates: the page-engine `runWalk` and the CDP `runCdpWalk` (the N-page loop; `WALK_MAX_PAGES=8`
backstop).

**The engine is torn down on every page transition** → the loop CANNOT live in the engine. It lives in
the **service worker**, driving the ACTIVE tab per page (never a background tab).

Per-page flow: fill → persist that page's review bundle → **the SW clicks Next** → wait for the new
page → repeat. The click is a separate guarded step AFTER the fill result is captured and persisted, so
triggering navigation can never drop review data.

## Termination: stop at the review page, NEVER submit — double guard

The footer Next button **reuses the same automation-id as Submit** on the review page (marker
`data-automation-id="applyFlowReviewPage"`).

- **Guard 1:** the walk stops when the marker is present — checked at the TOP of each iteration, before
  any fill or click.
- **Guard 2:** `clickNext` / `clickPageNext` independently refuse (`{refused:"review-page"}`) — defense
  in depth on the one click that could submit an application.

**HARD GATE: the first walk that actually reaches the review page must be watched eyes-on on a
DISPOSABLE application.**

## Clicking Next

`clickNext` / `clickPageNext` **handle a COVERED button**: `elementFromPoint`-check the button's center
before the coordinate click — if a popup/overlay (Simplify's dialog, a cookie/consent modal) sits on
top, a click would be swallowed and look like a bare nav-timeout.

It first attempts a **best-effort auto-dismiss** (`cdpFindDismissControl`): click ONE clearly-dismissive
control (X / Close / No-thanks — **never** Accept/Agree/OK/Got-it, consent-safe) inside the popup.
**Shadow-DOM aware** — Simplify renders into `div.simplify-jobs-shadow-root`, so the X lives in
`host.shadowRoot`, invisible to a light-DOM query; a CLOSED shadow root → not-found → safe halt. Never
force-removes DOM. Then re-check and proceed if clear (`{clicked:true, dismissed}`).

If no safe control is found or it stays covered → halt `click-refused:blocked` + log the blocker
(`blockedBy`).

**The cover-check RE-MEASURES (2026-07-25).** `clickPageNext` measured the footer rect once and then
re-checked the cover at those STALE coordinates, so a field revealed by an earlier fill (Caterpillar
mounts an SMS-consent checkbox after the phone number) REFLOWED the footer downward and the old point
landed on a floating extension widget → the walk halted blaming an overlay that was never on the button.

Now the rect is re-measured on every cover round (a 3×250ms settle before believing any cover, and a
fresh probe inside the post-dismiss poll), and `cdpCoverCheck` walks the whole `elementsFromPoint` stack
treating as see-through: Workday's `click_filter`, `pointer-events:none` elements, and a shadow HOST
whose shadow tree paints nothing at that point (an extension container otherwise reads as a cover
everywhere). Reaching the target with only see-through things above ⇒ clear; nothing opaque in the stack
⇒ clear (a stale rect must not halt the walk).

## Transition wait is poll-based, never a fixed delay

- **Page engine:** `waitForNextPage` re-injects a tiny `probePage` every ~400ms (15s ceiling); injection
  errors mid-navigation = "not ready, keep polling", not a failure.
- **CDP:** `cdpWaitNextPage` — the debugger attach SURVIVES navigation (no re-injection), with a ~1s
  fast-exit when validation errors render without an advance.

**Page signature = `url || pageId || formFieldIds` (any one differing = advanced).** ⚠ `pageId` alone is
NOT sufficient — the `applyFlowPage` container id is shared across pages; the `formField-*` set delta is
the load-bearing signal.

## Settle the field set before scanning (`awaitFieldSetSettled`, shared 2026-07-28)

Workday mounts a page's fields PROGRESSIVELY. The fill walk has waited for the flat field set to stop
growing since 2026-07-25 (wall-clock: a NON-ZERO count unchanged for ≥1.2s, polled at 150ms on
**`delayFull`** — never `delayRender`, which is adaptive and collapses to ~40ms on a visible tab, making
a half-rendered page look "stable"; 12s cap, ~1s all-zero bail for repeating-only pages).

But it lived INSIDE `fillAndPersistPage`, which the REPLAY walk never calls, so the replay had NO settle
at all. Live: replay "page 1" scanned **6 of 14** wrappers (name/address/city/region/postal genuinely
absent from the DOM — the diagnostic probe confirmed it), declared 9 approved values unfillable, and
saved anyway; the remaining fields then mounted, which CHANGED the page signature, so `cdpWaitNextPage`
read it as an advance and the walk processed **the same physical page twice**.

Now extracted and called by BOTH, logging the settle time + the field count per page. Operator's
diagnosis, exactly: *"each time we go to the next page, it doesn't poll for the page to completely
settle … the fill path works every time."*

This is one instance of a standing rule — **never scan a Workday page without settling it first**: JD
page → `jobPageSettleStep`, form pages → this, review page → `awaitReviewPageSettled`.

## Halts, never guesses

**Required fields block advancement.** Workday won't advance with a required field empty: the signature
never changes and the walk halts `nav-timeout` with diagnostics (page error samples + the fields left
empty because the profile has no value). **A dirty-state nav-timeout means "eyeball the page", not
"session expired".**

**Session death is behavioral, not DOM-static** (a timed-out page is DOM-identical to a live one —
recon-refuted static detection). `sessionLooksDead(state)` (lib.js, pure) = `vpsErrorPresent` OR session
banner OR login marker OR no-form — **NEVER keyed off validation-error markers** (a form showing
validation errors is alive). The walk halts "session expired" on dead, and `resume-not-attached` BEFORE
clicking Next if the résumé didn't attach. Narrow early-warning: `sessionWarning` when the `source`
field's options never loaded.

## Accumulation (RESOLVED: write-per-page)

Each page merges into ONE `reviewSummary` via `accumulateBundle` / `persistAccumulated` (merge key = the
field-set `page`). The walk clears `reviewSummary` + `reviewAudit` ONCE at start, **OUTSIDE the loop** —
a mid-walk clear would wipe accumulated pages.

## The REPLAY walk's own hazards (2026-07-27)

**Workday's soft-error page.** The fill walk has reloaded on the transient "Something went wrong /
please refresh" page since 2026-07-22; the REPLAY walk never got that guard, and the failure mode was
actively misleading: the error page carries NO form, so `selectPageBundleEntries` matched nothing and the
walk halted **`replay-page-not-in-bundle` — "The bundle never captured this page"**, blaming a perfectly
good approved bundle for a Workday hiccup (live, on a Rehearse run).

`runCdpReplayWalk` now checks `softErrorPresent` at the TOP of each page AND after each replay (both
spots the fill walk checks) → `reloadAndSettle` + `continue restartWalk`, bounded by
`MAX_REPLAY_SOFT_RELOADS` (3/run) then a clean `workday-soft-error` halt.

**An EMPTY page** (no flat fields AND no repeating sections) is no longer attributed to the bundle at
all — it reloads+restarts on the same budget, then halts **`replay-page-empty`** saying the bundle is
fine and the PAGE never rendered.

A reload returns Workday to page 1, so both restart the whole replay; skip-if-correct makes the
already-correct pages fast on the way back.

## Workday's PHANTOM duplicate-entry error (2026-07-27, DETERMINISTIC, no AI)

Workday's backend sometimes **APPENDS** a repeating section instead of REPLACING it, so its stored copy
holds duplicates **the form does not show**: the page is visibly clean, every row distinct, and Save &
Continue is still rejected with *"You can't add duplicate website URLs."* (live, solarturbines, during a
replay — operator: *"on the actual page, there is no duplicates, but workday gives us an error saying
there are"*).

What Workday accepts is **deleting the VISIBLE rows** — its own retained copy then satisfies the section,
which is why the values still appear on the REVIEW page "as if we did not delete it".

**ONE implementation, `clearPhantomDuplicates` (background.js)**, used by BOTH the fill walk (as AI-4
**Tier 0**, replacing the old language-only + website-only tiers) and the REPLAY walk (its ONLY
remediation — no AI-4 there).

`duplicateErrorSection(errorTexts)` (lib.js, pure) routes the error to a section by wording (website /
language / education / workExperience / certification). Website + language keep their tuned
parsers/plans (live-verified, value-aware); every other section uses the generic
`sectionEntriesFromResults` + `sectionDeletionPlan`, which key a row on the **composite signature of ALL
its fields** (a work-experience row is title+company+dates, not one value).

Plan: a **REAL** duplicate (two rows with the same signature) deletes only the later occurrence(s);
**all-distinct rows = PHANTOM** → clear every LIVE row (`entryCount`-driven, not the results' indices,
which lag the DOM). Then re-click Save & Continue. **Bounded at 2 per RUN** — a duplicate error that
survives the fix is a real problem, not a retry loop.

**The deleted rows stay FILLED in the review summary.** They're still on the application (Workday
retained them), so dropping them would hide a whole section from the operator. `markPhantomKept` flags
those records `phantomKept` + annotates the detail, and **`reconPageTruth` SKIPS them** in its "row no
longer on the page → `removed`" sweep — without that guard the pre-advance re-persist deletes them from
the bundle (operator rule: *"make it show as filled … as if we did not delete it"*).

**The retention premise is CHECKED, never assumed.** Those values remain in the approved bundle, so
`reconcileReviewPage` compares them against Workday's own review page and a value that did NOT come back
lands in `missing` → a HARD `submitPrecondition` blocker; the replay walk additionally ATTRIBUTES it
(*"the … value(s) we deleted … did NOT come back"*) so a blocked submit names the cause instead of citing
an anonymous mismatch.

**It uses the LIVE page, and the REAL walk's delete mechanism** (2026-07-27, after it deleted 0/2 live).
The first build hardcoded the fkit prefix (`webAddress-`); `entryCount` returned 0, the loop bailed on
iteration 1, and it reported a useless "deleted 0/2". Now:

- `findLiveSection` (lib.js, PURE) resolves the section from `repeatingScan`, which DISCOVERS the
  prefixes actually in the DOM — canonical prefix → a prefix named after the section → the section's
  HEADING (`findSectionAdd`'s anchor).
- `liveDupEntries` (PURE) builds the dedupe entries from the LIVE rows (so rows Workday added behind our
  back count too), carrying each row's `deletePresent`.
- Deletion is `deleteRepeatingRows`, mirroring the fill walk's own loops: **clear-to-N** reconciles down
  by deleting `count - 1` and RE-POLLING each pass (never a stale index list — operator: *"use the same
  mechanism the real walk uses"*); **targeted** deletes given indices highest-first. Both use
  `pollEntryCount` on the section-reconcile budgets and stop on no-progress.

**Every exit reports WHY** (`no-rows:<prefix>` / `no-delete-button@<i>` / `count-did-not-drop`), and
deleting 0 returns `ran:false` — it never claims a fix it didn't make, so the walk halts visibly instead
of silently continuing.

## AI-4 remediation (the nav-timeout branch, `remediatePageErrors`)

**Never acts blind** — polls for the error banner (it renders LATER than the fast-exit) and hard-gates
every attempt on non-empty EXPANDED error text. `expandErrorSamples` splits Workday's single concatenated
banner element on the `Error-` prefix and **drops `[role=alert]` success toasts**. Clean halts:
`no-error-text` / `errors-cleared-not-advancing`.

Ladder:

- **Tier 0** — dup-language delete-all (real-vs-phantom from audited results); see phantom duplicates
  above.
- **Tier 1** — deterministic re-fill of the mapped fields the error text names (`onlyFieldNames`, no AI).
- **Tier 1.5** — deterministic DELETE of error-named repeating rows that read EMPTY on the live page.
  **EMPTY = the WHOLE row holds no value in ANY field** (`holdsValue` false), a true orphan the tenant
  left. **A value-holding row is NEVER deleted even if an error-named required field is still empty** —
  the old `anyEmpty` check nuked a partial row (e.g. an education entry with school+degree filled and one
  missing field), silently losing its data; that empty field surfaces for review / halts instead
  (2026-07-20). A nested name deletes ONLY nested rows, the parent untouched; an unreadable probe leaves
  the row alone.
- **Tier 1.6** — section re-fill (`onlySections`; `preserveExtras` — remediation NEVER reconciles down,
  manually-added entries survive).
- **Tier 2** — AI last-resort (whitelisted `refill` / `delete_entry` / `none`, sanitized by
  `parseRemediation`).

Global cap + halt-on-no-progress (`errorSetUnchanged`); every action recorded `ai-remediation`; the submit
double-guard untouched.

---

# Repeating sections — WE / Education / Websites / Languages / Certifications

Page 2 (My Experience) is repeating multi-field sections, all driven by one machinery on both substrates:
page engine `fillRepeatingSection` + `fillMappedEntry`; CDP `driveRepeatingSectionCdp` + `fillEntryCdp`.
Full DOM detail: dom-patterns 2026-06-04 / -16 / -17 / -18.

## Reconcile to exactly N, then fill each entry

True idempotency, proven from ARBITRARY dirty state: Add→mount up to N (count-polled, bounded), delete
trailing extras via `deleteEntryButton`.

Per-entry fill is config-driven over a `fieldMap` of `{field|labelRegex, name, widget, key, path}` —
**`labelRegex` for hashed `formField-*` ids** (Languages proficiencies; entry-scope holds even with
IDENTICAL hashed ids across entries). Values run through `resolve()` (tiered-array passthrough). Entry
fields fill in the entry's scanned DOM order; sections drive in page order (`sectionsInDomOrder`); entries
re-resolved fresh each iteration (re-renders).

## The maps

- **`WORK_EXPERIENCE_MAP`** — `currentlyWorkHere` checkbox FIRST (it controls the To box) → text → M/Y
  dates → `roleDescription` `<textarea>` ← `bulletsText` (Profile v2: `prepareProfile` derives
  `bulletsText` from the profile's single `role_description` textarea; legacy `bullets[]` is the
  `joinBullets` fallback). `currently_work_here:true` skips endDate, but `todayIfStuckRequired` fills
  TODAY + a `we-currentwork-today` flag if the To box stays present AND required.
- **`EDUCATION_MAP`** — school / degree / fieldOfStudy / gpa + **year-only** dates.
- **`WEBSITE_MAP`** — `url` via `ensureHttps`.
- **`LANGUAGE_MAP`** — language dropdown + BY-LABEL proficiency dropdowns + the `_allFluent` "I am
  fluent" checkbox LAST (Profile v2: `prepareProfile` uses the human-set `languages[].fluent` when
  present, else derives from reading ∧ speaking ∧ writing).
  **`prepareProfile` reorders the languages list so any English entry is filled LAST** — the operator
  found English-last reduces Workday's spurious "duplicate languages not allowed" ghost error on Save &
  Continue (stable partition; non-English keep their order).
- **`CERTIFICATION_MAP`** — certification typeahead + number + full **M/D/Y** dates + the **NESTED
  Specialties** sub-section (`CERT_NESTED` / `fillNestedSpecialtiesCdp`: a repeating section nested inside
  a repeating entry; per-cert-entry-scoped Add/Delete; reconciles orphan empty rows away even at N=0;
  wrapper selectors probed live per field by `cdpNestedFieldSel` — the fkit↔formField relationship is
  tenant-variable, nothing hardcoded; records nested-canonical `certification[i].specialties[j].*`,
  grouped under the parent in review).

## `deleteOnNoMatch` (Languages, Certifications only)

An optional pick-section entry whose REQUIRED pick ends a **GENUINE** no-match (options rendered but
absent / every candidate definitively negative) is DELETED so it can't block Next.

A transient/infra failure KEEPS + flags (unit-pinned — **a render hiccup must never destroy valid
entries**). A `filled_review` commit (containment/fuzzy) KEEPS the entry. WE / Education / Websites:
flag, never delete. Nested child rows: a required pick ending BLANK on a definitive negative is deleted at
fill time (value-holders + transients never). An entry of all-AI-rescuable typeaheads isn't deleted when
AI is on.

## Tenant-variable fields — RESOLUTION LADDER + WIDGET-ADAPTIVE fill (2026-07-25)

A section field's `formField-*` id AND its widget both vary by tenant (Magna's education school = text
`schoolName`; cat.wd5/solarturbines = a multiselect TYPEAHEAD under `school`). The single hardcoded id
resolved NOTHING → `field wrapper not found in entry` → **no fill path ran at all**, so no fallback could
fire (AI canonicalize / required-empty AI / `deleteOnNoMatch` all live DOWNSTREAM of a resolved wrapper)
and the required field blocked Save & Continue.

Fix: **`fmMatchesFd` ladder** — `labelRegex` | `field` | `altFields[]` | `labelFallback` (a last-resort
label regex), applied **TWO-PASS at every call site** (ids across the whole map first) so a fallback can
never steal a field another entry names exactly.

And when the live scan's `widgetType` disagrees with the map's, **the LIVE DOM WINS** — the value is
re-resolved for it (a string → a single-candidate list for a choice widget, then that widget's own match
ladder + commit verification; never a blind commit). text/textarea/dropdown/typeahead only —
date/year/checkbox never swap (classify can't see a date composite). Recorded as `rec.widgetAdapted`; the
record reports the LIVE widget so review renders the right editor.

The already-filled SWEEP uses the SAME ladder (and a wrapper-level guard keyed on `auditLoc`), or a
renamed field this run FILLED gets re-surfaced as a duplicate "already on the form" review row.

## Key DOM facts

- Entry containers are `[data-fkit-id^="<section>-"][data-fkit-id$="--null"]` — the From/To date wrappers
  share the prefix, so a bare prefix over-matches (one entry → 3 nodes).
- **`formField-*` ids DUPLICATE across entries** → every field access MUST scope to the entry container
  (the flat driver loop skips fields inside repeating containers — `isRepeating`).
- **Add buttons all share `data-automation-id="add-button"`** ("Add" / "Add Another") → anchor by section
  heading (nearest-heading regex, `findSectionAdd`). Nested Adds carry `insideEntry` (any `-<digits>--`
  fkit ancestor) and are excluded from page-level logic.
- Dates are `role="spinbutton"` composites (M/Y, year-only, M/D/Y) parsed **SW-side** by the pure
  `parseYearMonth` / `parseYear` / `parseYearMonthDay` (lib.js — the injected engine can't import; rejects
  placeholders/out-of-range).
- Profile lists are SW-prepared (`prepareProfile`, `meaningfulEntries`); profile-side tiered candidate
  lists (degree, field_of_study) live in the profile, not the filler.

---

# Résumé upload & storage

The résumé is NOT picked from the OS filesystem per application. *Why:* the end state generates a
per-application AI-tailored résumé variant (or one fixed résumé), so the bytes are held/produced inside
the extension and attached programmatically — a picker is incompatible with generated variants and hostile
to the high-volume queue-and-run premise.

## Storage (`db.js`)

One PDF uploaded in the popup → **base64 in IndexedDB** (DB `ApplyPilot`, store `resume`, single fixed key
**`resume:default`** → `{filename, mime, size, base64, savedAt}`). IndexedDB, not `chrome.storage` — a
real résumé's base64 blows past its quotas and binary document bytes don't belong there.

`db.js` loads in three contexts off ONE file (popup `<script>`, SW `importScripts`, Node `require` —
UMD-lite), which makes it unit-testable (fake-indexeddb).

**Phase 2+ (AI-tailored per-application variants) just adds more keys to this same store — do NOT
pre-build variant slots or per-application keying.**

## Attach (`attachResume`, self-contained)

**Strings only across the injection/message boundary — a `File`/`Blob` serializes to `{}`.** The SW reads
the base64 from IndexedDB and passes it as plain STRING args; the injected fn rebuilds the `File` in the
page, sets `input.files` via a `DataTransfer`, and dispatches `change` (Workday's delegated React
`onChange` fires).

It first **clears existing attachments** one-at-a-time, **re-resolving the section/items/`delete-file`
fresh from `document` each pass** — Workday swaps the subtree mid-loop, so a captured ref goes stale and
caps deletion at n−1.

**Success = the confirmation ROW, not the input:** `input.files` RESETS to 0 after Workday's XHR upload.
Gate specifically on **`file-upload-successful`** (`file-upload-item` renders first, before the success
marker).

## `role="alert"` is the STATUS channel, NOT an error channel (2026-07-29)

Workday announces upload PROGRESS there — live: `"Kevin's Hardware Resume.pdf loading"`. A first cut of
the error detection matched any `[role="alert"]` text and reported *"Workday reported an upload error"* on
a perfectly healthy in-flight upload, which then made the SW **skip the very re-poll** that exists for a
slow upload → a false `resume-not-attached` HALT on a rehearse run. (dom-patterns already recorded this
channel announcing "…successfully uploaded", and `expandErrorSamples` already drops role=alert toasts for
the same reason — the precedent was there.)

Now: the text is read as a **`statusText`**; an ERROR requires unambiguous wording
(`error|failed|unsupported|too large|invalid|not allowed|try again`) or a dedicated `file-upload-error`
node; and **progress wording (`loading|uploading|in progress|processing|N%`) is POSITIVE evidence the
upload is still in flight** — it sets `uploading`, which *extends* the SW re-poll (45s instead of 20s)
instead of aborting it. The re-poll re-reads the status each tick so a genuinely LATE error stops the wait.
Every failure path logs `cleared/deleted/filesSet/sawItem/uploading/status`.

**Why the REPLAY run hits this and the FILL run doesn't** (leading suspect, not yet confirmed): a fill
lands on a virgin Documents section so the clear loop is a no-op, whereas a re-apply finds Workday's
carried-over copy and must delete-then-re-upload — a slower server round trip right before the upload. The
`cleared=` / `deleted=` log settles it on the next occurrence.

## The confirmation wait is VISIBILITY-SCALED + RE-POLLED FROM THE SW (`cdpAttachResumeConfirmed`, 2026-07-28)

`attachResume`'s gate is a PAGE-side poll, so a hidden tab subjects it to a slower XHR, a throttled React
render, and (when CSP blocks the worker-timer override) ~1Hz timers. Live on a BACKGROUND run it reported
*"file-upload-item appeared but file-upload-successful did not within 10s"* and the replay walk HALTED
`resume-not-attached` — while the same job attached fine on later runs, the signature of a race, not a
broken upload.

Now: the page-side ceiling is a PARAMETER (VISIBLE 10s — the live-verified value, unchanged; HIDDEN 25s),
and an upload that STARTED but hasn't confirmed is then re-polled **from the service worker on wall-clock
for 20s more**, waking the page each tick (the standing rule that a wait must never depend on a page
timer). An explicit Workday error row (`errorText`) or an upload that never started SKIPS the re-poll —
those aren't races, and waiting would only delay an honest failure.

ONE shared path for both walks (the fill's `fillAndPersistPage` block and the replay's
`replayAttachResume`); it also owns the `__apActing` bump.

## Wiring

- **Page path** = the SW post-fill step `attachResumeForPage` (both `RUN_FILL` and the walk).
- **CDP path** = `cdpEval(attachResume, …)` on the SAME debugger attach, inside `fillAndPersistPage`
  (after `drivePageFill`, before the bundle build), patching the `file_upload` record to `filled`.
- No-résumé / failed attach → `needs_review` and the walk halts `resume-not-attached` BEFORE clicking Next
  (self-explaining, not a bare nav-timeout).
- The attach bumps `window.__apActing` so the input-lock doesn't swallow its synthetic delete-clicks.
- **Per-entry attachments (e.g. per-cert) are the operator's job** (form / review picker) — the résumé only
  ever attaches to the top-level Documents field (regression-pinned).
- New-tenant probe: `RUN_CDP_RESUME_RECON`.
