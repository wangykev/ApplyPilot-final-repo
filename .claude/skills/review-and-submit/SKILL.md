---
name: review-and-submit
description: The fill → review → submit contract — the reviewSummary bundle schema, page keying and accumulation, the viewer/editor, the approve/merge envelope, the replay walk's re-verify and cascade handling, the review-page reconcile, and what blocks the submit gate. Read this before touching buildReviewBundle, summary.js/summary-lib.js, web review-approval.ts/review-model.ts, reconcileReviewPage, or submitPrecondition.
---

# Review summary — the fill → review → submit contract

Stage 1 of the pipeline. On a **fully-completed** run the engine builds a `reviewSummary` bundle and
RETURNS it; `background.js` writes it to `chrome.storage.local` — **only on completion** (a
crashed/aborted run writes nothing; no partials).

## PRIMARY review surface = the WEBSITE (2026-07-16)

The human edit/approve stage was ported to the site (`WEBSITE.md` M9:
`components/app/review/ReviewEditor.tsx` over the same `reviewSummary` schema; pure transforms
`web/lib/review-approval.ts` — a LOCKSTEP port of `summary-lib.js` — plus `web/lib/review-model.ts`, a
port of this repo's `summary.js` grouping).

Round-trip: the walk PUSHES its accumulated bundle to the site on every exit (`reportApplication` in
`runCdpWalk`'s `finally`); before replay the SW PULLS the site-approved bundle (`pullApprovedBundle` →
`GET /api/extension/review`, writing `chrome.storage.local.reviewSummary`) so `runCdpReplayWalk` /
`submitPrecondition` are UNCHANGED (site connected + has a bundle ⇒ it's the source of truth).

**⚠ The pull MUST be TARGETED for a submit run (2026-07-26).** By default it keys on the LOCAL bundle's
url, and the endpoint's no-match fallback is "the most-recently-updated app that HAS a bundle" — so
submitting job B while storage held job A's fill would have **replayed A's approved values into B's form
and submitted it**. Fixed three ways:

1. `pullApprovedBundle(LOG, {jobKey})` keys on the run-stable `job_key`.
2. The route NEVER widens to the url / most-recent fallbacks when `job_key` is given (no match ⇒
   `bundle:null`).
3. The caller REFUSES rather than replaying whatever is in storage.

`runCdpReplayWalk` takes `opts.jobKey` and threads it into its own re-pull so the walk can't re-clobber
the targeted bundle.

The extension's own `summary.html` / `summary.js` viewer/editor STAYS as a fallback for when the site
isn't connected, until the web path is live-verified — **keep the two schemas in lockstep.**

## Envelope

`schema_version` (**"1.1"**; viewer tolerates 1.0) · `page` (the stable MERGE key — `cdpPageKey` =
pathname|field-set on CDP, the field-set key on the page engine; "accumulated (N pages)" once merged) ·
`page_number` / `page_label` (display only) · `url` · `tenant` · `captured_at` · `total` · `counts` (by
fill_status) · `by_type` · `needs_review_count` · `entries[]` (every field, page order). The viewer may
also write an `approval` roll-up.

## Per-field entry

| field | meaning |
|---|---|
| `field_id` | **PAGE-QUALIFIED** `<page_key>::formField-<name>` — globally unique in the accumulated bundle, on BOTH paths |
| `page` | = the merge key, NOT the human label |
| `page_number` | the walk's 1..N ordinal — display order; null = single-page |
| `page_label` | friendly caption |
| `field_index`, `question_label`, `widget_type`, `canonical_field`, `is_required` | — |
| `current_value` | the value actually filled — selected option text for choice widgets; only ever a live page value |
| `original_ai_value` | the bot's pick at write time, never changed by edits |
| `is_edited`, `edit_kind` | `override` / `filled_blank` / `cleared` / `null` — provenance for the later replay |
| `is_approved`, `approved_at` | human sign-off |
| `confidence` (high/medium/low/none), `confidence_source` | the tier |
| `needs_review`, `needs_review_reason` | — |
| `fill_status` (filled/not_filled/skipped/error), `fill_error` | — |
| `detail`, `match_tier` | — |
| `options` | full list, plain dropdowns |
| `captured_options` | the partial filtered set, typeaheads |
| `options_partial` | PROVENANCE — see the ATS note below |
| `tree_structure` | cert/source tree-AI: chosen category + leaves |
| `character_count` | reserved |

## Page keying — merge key vs display

`page` is a STABLE merge key (field-SET, **not** the shared `applyFlowPage` container id — the M31
lesson); `accumulateBundle` merges on it (keeps OTHER pages + viewer edits verbatim). The viewer ORDERS
pages by `page_number` and CAPTIONS by `page_label` (never the raw composite key — `cleanPageName`
collapses it to the path tail). Both paths clear once at walk start + ACCUMULATE write-per-page; the SW
stamps `page_number` per page (the engine doesn't know the ordinal).

## The summary is the page's SOURCE OF TRUTH

`sweepAlreadyFilled` (the LAST pass in `drivePageFill`) flips any `skipped` record whose field HOLDS a
live value to `already-filled` (needs_review; `already-filled-match` unflagged when it equals the profile
value; both **AUDIT-EXCLUDED — never re-actuated**).

Unknown/generic sections surface with current values + an addable stub carrying the DOM-detected
`section_field_shape` (an EMPTY unknown section is revealed-by-add ONCE per bundle-lifetime).

**A `section-stub` NAGS for review (`needs_review: section_unfilled`) only when it's UNKNOWN
(`section_known:false`** — a tenant repeating section the profile doesn't model). **A KNOWN,
profile-DEFINED empty section** (cert / languages / WE / education / websites, `section_known:true`)
still SHOWS in ALL FIELDS and is addable but is **NOT a review item** — leaving it empty is the user's own
choice, and a required-empty known section still blocks Save & Continue → nav-timeout halt (2026-07-20).

Pre-advance `reconPageTruth` re-syncs deleted/index-shifted rows to the live page before every
remediation re-click; AI-4's synthetic rows are filtered from the bundle. `current_value` renders for ANY
status, so a needs_review kept-original shows the real field value.

**Required-field escalation:** a required field left unfilled surfaces in review (highest-value review
item — and, multi-page, it blocks page advancement).

## ORPHAN CONSENT CHECKBOXES (2026-07-25)

A consent checkbox rendered OUTSIDE any `formField-*` wrapper is invisible to the page scan (Caterpillar's
page-1 SMS/marketing consent — cascade timing and a blur fix were both red herrings; the create-account
consent needed its own finder for the same reason).

`cdpScanOrphanCheckboxes` inventories rendered checkboxes outside the field set (skipping repeating
entries) as `consent.<key>` records with their full text, **left UNCHECKED** — an optional consent,
especially a marketing one, is the operator's to give.

- **OPTIONAL** ⇒ NOT a review item (flag `consent-checkbox`, status `skipped` → `deriveReview` false): it
  shows in ALL FIELDS and is tickable, mirroring the KNOWN-empty-section rule.
- **REQUIRED + unchecked** ⇒ `needs_review` (it blocks Save & Continue).
- **Already CHECKED on the page** ⇒ the already-filled convention (verify).

## REVIEW ORDER = FORM ORDER (2026-07-25)

Records are produced flat-loop-first then section-by-section, and the bundle's entry array IS the render
order in both viewers — so a flat field BETWEEN two repeating sections rendered above both.

`cdpPageScan` reports each wrapper's document position (`domIndex`) + each section's first-field position
(`sectionOrder`); the pure `orderResultsByDom` (LAST step in `drivePageFill`, off a FRESH scan) sorts by
it — a section's records all take the section's position (entries stay contiguous, in fill order),
unpositioned records inherit their neighbour's key, and the sort is STABLE. A scan failure leaves the order
as produced.

## Viewer / editor (the extension fallback)

`summary.html` / `summary.js` + the PURE, requireable `summary-lib.js` (`editKindOf` / `tokenFor` /
`checkedOf` / `effectiveValue` / `approvalEnvelope`, tested in `test/summary.test.js`): NEEDS REVIEW
first, then ALL FIELDS.

**Every widget is editable** — plain dropdown/radio → `<select>` from `options`; typeahead/source/tree → a
type-to-filter combobox (`position:fixed`) over `options` / `captured_options` /
`tree_structure.leaves` + a partial-note; text/date/textarea/checkbox editable; radio without captured
options degrades to a text box + note.

Edits write back into the SAME record (`current_value`=pick, `original_ai_value` preserved, `is_edited` /
`edit_kind` set), persisted, updated in place (no re-render → no scroll jump).

Approve-by-section; required-EMPTY fields refuse approval (with a note); a checked "I currently work here"
hides that entry's To row (a FLAGGED endDate stays visible); a gray PRE-POPULATED badge marks
`already-filled*` rows.

## Approve / merge layer (the seam SUBMIT reads; NOT the replay)

Per-flagged-row **Approve** toggle (un-flagged fields are approved-by-default — lower friction); a header
strip with progress + "Approve all reviewed" + a **disabled-until-`submit_ready`** "Approve & continue to
submit" button that does **NOT** submit.

`approvalEnvelope(entries)` (pure) → `{to_approve_count, approved_count, pending_count,
unreplaced_placeholders, all_approved, submit_ready}`.

**`submit_ready` = every flagged field approved AND no unreplaced AI placeholder.**

A VALUE edit RESETS that field's approval (re-review); a soft-deleted entry is excluded from the
denominator; `effectiveValue(entry)` → `{value, kind, approved, deleted}` is the documented value SUBMIT
will replay.

## A REQUIRED field with NO VALUE blocks SUBMIT (2026-07-27)

`bundleSubmitBlockers` (and therefore the website submit run's pre-flight AND the live `submitPrecondition`
gate) refuses, naming the fields; `required_blank` joins the approval envelope in **both**
`web/lib/review-approval.ts` and `summary-lib.js`, so `submit_ready` is false and the site's Submit
disables.

Until this, NOTHING encoded it — the extension viewer's `canApprove` refused a required-empty field in the
UI only, the website port dropped even that, and the envelope/gate never checked — so the sole backstop was
Workday refusing the page, which surfaces as a mid-replay nav-timeout halt (live: page 5, "The field Date
is required").

Conservative: an unchecked checkbox stores `"false"` (never empty), `file_upload` is excluded (own
re-attach + `resume-not-attached` halt), stub rows are display-only, preferred-name fields are
`is_required:false`.

## The replay walk's own verification layers

### PRE-SAVE RE-VERIFY (2026-07-28)

The fill walk has the M40 post-settle audit for the "filled, verified, then lost it" class; the replay had
NONE, so it clicked Save & Continue on a page it believed was complete. Live: the disability checkbox group
replayed AND verified checked (`fillCheckboxGroupCdp` re-reads and requires exactly one box on; the page
reported `0 FAILED`), then Save came back "Please check one of the boxes below … is required" — the
operator watched it uncheck itself.

Now ONE fresh scan before every Save & Continue feeds **`requiredBlankOnPage`** (lib.js, PURE — the MIRROR
of `newlyRequiredGaps`: required + blank on the page + the bundle HAS an answer), and only the fields that
actually went blank are re-replayed, then logged either way. Same blank/carve-out rules as
`bundleSubmitBlockers` so the three checks agree.

### CASCADE RE-REPLAY (2026-07-27)

A value committed during a replay can REVEAL the rest of the page (Workday page 1: address/region/postal/
phone mount only AFTER Country commits), so the field set captured before the replay is not final. After
`replayFlatFields`, the walk re-scans (bounded, 2 rounds) and replays anything that has since mounted,
replacing the provisional `replay-field-absent` verdicts.

Live evidence for why: after a soft-error reload page 1 scanned as ONE field (`country`) and all 14 other
approved entries reported absent → a false `replay-mismatch` halt on a page that was merely mid-cascade.

**Severity split:** an absent field only HALTS when it is REQUIRED; an OPTIONAL one is logged as `skipped`
(nothing to do — a phone extension, a cascade that never fired), never fatal.

### CASCADE-REVEALED REQUIRED fields go BACK TO REVIEW, not a blind halt (2026-07-27)

Filling an OPTIONAL field can promote others to REQUIRED (live, solarturbines page 5: an optional Name
promoted "Date" + a disability checkbox group). Nothing was wrong with the fill — both were optional AND
blank when reviewed, so there was nothing to record — but the replay then had no approved value and Workday
refused the page.

On a replay nav-timeout the walk now calls **`newlyRequiredGaps`** (lib.js, PURE): every LIVE field that is
`isRequired` + holds no value + whose bundle entry is **MISSING or BLANK** (the blank case is the one that
actually fires) becomes a **`cascadeEntryFor`** entry — EMPTY, `is_approved:false`, `needs_review`,
`cascade_revealed`, carrying the live options (a checkbox group ships its labels in the DOM, so review
renders a real picker).

Merged into the bundle, persisted, `reportApplication`-pushed to the website, then a clean
**`replay-needs-approval`** halt naming the questions. **It NEVER invents an answer**, so
`bundleSubmitBlockers` (required-blank + unapproved-flagged) keeps refusing until a human answers.

**Badge: `✱ BECAME REQUIRED`, NOT `⤴ REVEALED`** — both are `cascade_revealed` (same approval force), but
one merely appeared while this one is a question the form is now DEMANDING (operator 2026-07-27);
`isBecameRequired` (flag `cascade-required`) is checked FIRST so exactly one badge shows — in
`review-model.ts` + `review-approval.ts` + `summary-lib.js` / `summary.js`, lockstep with
`isCascadeRevealed`.

**The VIEWER normalizes the date order too** (`normalizeDateOrder`, review-model.ts): `DateSeg` fell back
to `{ph: segment}` for an unknown token, so a bundle holding raw ids PRINTED them as the input
placeholders — and a bundle is DURABLE (an already-stored one, or an older extension build still
installed, keeps its raw ids), so the page must heal rather than trust; junk now degrades to a plain text
box instead of showing the token. A DATE field carries `dateOrderOf(dateSegments)`
(`["month","day","year"]`), never the raw scan ids — passing those through printed
`dateSectionMonth-display / …` as the field's content instead of a segmented editor. `dateOrderOf` moved to
lib.js (fill-driver keeps a one-line alias, all call sites unchanged).

`file_upload` excluded (own re-attach + halt); a required field the page already holds a value for is NOT a
gap (that's a replay failure, owned by the strict verify).

### A `skipped` replay is NAMED in the log (2026-07-27)

`skipped` counted as neither changed, kept, nor failed, so a page could report *"4 field(s) — 1 changed, 1
already-correct, 0 FAILED"* while TWO approved entries were quietly left blank by `replayField`'s `cleared`
branch (an approved value that is empty). The per-page line now carries a `not-actuated` count and lists
those fields with their reason.

### An approved field ABSENT from the live page is REPORTED but NEVER FATAL (settled 2026-07-28)

`replayFlatFields` used to `continue` SILENTLY when a bundle entry's name wasn't in the live scan (live:
page 5 selected 5 approved entries, replayed 4, and the missing one — an answered `checkbox_group` — left
no trace with `0 FAILED`). It now pushes a **`skipped`** / `replay-field-absent` record naming the field
plus a sample of the LIVE field names, and the walk logs those separately.

**It does NOT halt** — that was wrong twice live: once on a page merely MID-CASCADE (only `country` had
rendered, so all 14 other entries read absent), and once on a page whose EEO gender/ethnicity/veteranStatus
fields the operator could SEE ("all the values do exist on the page") while the scan reported one field.

**⚠ WHY the scan missed them is UNSETTLED.** Candidates: the wrapper mounted later, the page renders prior
answers as read-only text (no `formField-*` wrapper), or a different automation-id. Two things follow:

1. The replay PROBES the DOM directly (`act.selExists` on the entry's own wrapper) before believing any
   field is missing, since `cdpPageScan.fields` FILTERS OUT fields inside repeating containers and so is a
   convenience list, **not an inventory**.
2. When a field is still absent the walk dumps the page's ACTUAL unfiltered `formField-*` ids + a
   per-wrapper DOM probe, so the next occurrence settles the cause instead of inviting another guess.

**The authority is Workday's own review page:** the entry keeps its approved value, so
`reconcileReviewPage` looks for it and `submitPrecondition` HARD-BLOCKS on `missing_on_review` — a value
genuinely lost can't be submitted, and a field Workday still wants blocks Save & Continue anyway (→ the
cascade/nav-timeout path). Two backstops, so no mid-walk guess is needed.

Repeating + `file_upload` entries still skip silently (own replay steps).

## Review-page CHECK (the end-to-end fill-verify)

`RUN_CDP_REVIEW_CHECK` / `cdp-review-check`. The final Workday review page renders every value ACTUALLY in
the form as read-only text — ground truth.

`cdpReadReviewPage` (self-contained) scrapes those displayed values and the PURE `reconcileReviewPage`
(lib.js, `test/review-reconcile.test.js`) diffs them vs the saved `reviewSummary`; a divergence flags a fill
bug (the value-revert class). **READ-ONLY: attach → read → detach, never clicks Next/Submit.** Output
`[REVIEW-CHECK]` in the SW console.

**VALUE-PRESENCE, not label-match.** The observed review DOM has NO reliable field labels (bare `<span>` /
`<div>`), so:

- A **DISTINCTIVE** recorded value (≥4 chars, or ≥3 and not a generic yes/no token) AGREES iff it appears in
  the page text — digit relief for phones ("8506660266" ↔ "+1 850-666-0266"), region name↔abbrev relief
  ("Florida" ↔ "FL").
- **SHORT** values ("Yes"/"No") + CHECKBOXES fall back to LABEL-ANCHORING on the distinctive question text
  (`normL` strips the trailing required "*"/"**").
- **FILE_UPLOAD** matches the résumé filename.

The scraper feeds VALUE HINTS from the bundle (value-anchoring: locate each recorded value → tag with its
true label).

**Buckets:** AGREE / DISAGREE (page value ≠ recorded) / MISSING (recorded but nowhere on the page) / EXTRA
(a distinctive page value the bundle doesn't hold) / AMBIGUOUS.

**Only DISAGREE blocks the submit gate (relaxed 2026-07-28), and a MIS-PAIRED row is not a DISAGREE.**

- **DISAGREE is positive evidence** — the page CONTRADICTS what was approved.
- **MISSING is absence of evidence and is INFORMATIONAL.** Workday's summary legitimately doesn't render
  every field (live: `Language*`="English" controls the page's display language and never appears there,
  blocking a run that was otherwise AGREE 53 · DISAGREE 0), and value-presence matching is heuristic on
  short values, so a locate failure is not proof a value was lost — it is logged, not blocked.
- **EXTRA** was already non-blocking.
- A **scrape FAILURE still blocks** (without a read, DISAGREE can't be checked either).

### SETTLE THE REVIEW PAGE BEFORE SCRAPING IT (`awaitReviewPageSettled`, 2026-07-28)

The ROOT cause of the mis-pairing below. The check used to read the summary the instant the walk arrived.
On a HIDDEN tab that reads it HALF-DRAWN: same job, FOREGROUND runs scraped **AGREE 53 · DISAGREE 0 ·
MISSING 1**, the first HIDDEN run **AGREE 26 · DISAGREE 3 · MISSING 24** — the operator's own copy of the
page showed the "missing" values present and the "disagreeing" ones correct.

Now polls `cdpReadReviewPage` until a NON-ZERO record count holds UNCHANGED for ≥1.2s (wall-clock via
`delayFull`, **never `delayRender`** — which collapses to ~40ms visible and would call a half-page
"stable"), 15s ceiling, and RETURNS the settled snapshot so the verdict is computed on exactly what it
settled on. Used by the replay walk AND the standalone `RUN_CDP_REVIEW_CHECK` (which has no `act` → falls
back to `cdpDelay`).

Third instance of one lesson: **never scan a Workday page without settling it first.**

### MIS-PAIRING GUARD (2026-07-28)

Repeating entries reuse identical labels, so the row→value pairing can shuffle WITHIN an entry — live,
`Location` "Pittsburgh, PA" was reported as showing "Yes" (the NEXT row's "I currently work here") while
"Pittsburgh, PA" sat in that same entry, and two more like it blocked an otherwise-clean run.

Before calling a keyed mismatch a contradiction, `verdictFor` checks whether the approved value is the
value of ANOTHER ROW OF THE SAME ENTRY (same `fkitPrefix` + `entryOrdinal`) → AMBIGUOUS
(`mispaired-within-entry`, logged, non-blocking).

**NARROW on purpose:** it does NOT accept "the value appears somewhere on the page", because a keyed match
must still beat coincidental presence (approved "LinkedIn" vs `source` reading "Indeed" is a REAL disagree
even though another field's prose says "my LinkedIn profile" — unit-pinned). FLAT fields keep the strict
path entirely.

**ONE exception keeps MISSING fatal:** a value the walk DELETED ITSELF to clear Workday's phantom duplicate
error (`phantomLost`) — that fix's premise is that Workday retained its own copy, so absence IS positive
evidence the application would be filed without it.

## Note for the ATS pipeline

`options_partial` rides the bundle for Greenhouse/Lever/Ashby: **partial is PROVENANCE** — a menu read on
OPEN is complete however long; anything reached by TYPING is a view of it — and the flag is **never
cleared**, because clearing the query restores the whole list on a static widget but only page ONE on a
server-backed one, and those are indistinguishable from inside the code. It was previously set and never
read, so the site re-derived it from `captured_options.length > 2` and a server-backed field returning 1–2
rows got no explanation. See the `ats-tenants` skill.
