# ApplyPilot extension — progress log (archive)

Moved out of `CLAUDE.md` on 2026-07-02 to keep the auto-loaded context lean (the pre-slim CLAUDE.md is preserved verbatim in git history at commit `4992b82`). This file is the full milestone-by-milestone build history — one entry per verified milestone, one commit each, so the project stays bisectable. **Append new milestone entries here** (same style: what/why/how-verified); `CLAUDE.md` keeps only standing rules + a short "Current state & open items" section. DOM observations live in `docs/dom-patterns.md`.

## How to use this file

**Do not read it whole (~492KB).** Find your topic below, then grep the entry's heading text verbatim
(headings are stable; the file is append-only, so nothing above your match moves) and read from there.

For *what is true now*, read `CLAUDE.md` + the matching skill — not this file. This is **history**: it says
what changed, when, and how it was verified. Entries are dated `## YYYY-MM-DD — title`. ⚠ The tail is **not
strictly chronological** — the Workday, multi-ATS and discovery tracks were appended in parallel during
2026-07/08, and several entries name the branch they landed on.

For current state and open work, see **`docs/status.md`**.

### By subsystem — where to start (most recent / most complete entry first)

| Topic | Grep for |
|---|---|
| **Multi-ATS (Greenhouse / Lever / Ashby)** | `2026-07-31 — MULTI-ATS: Greenhouse / Lever / Ashby end-to-end` (the landing milestone), then `2026-07-31 (b)`…`(f)`, `2026-08-04 — the async combobox`, `2026-08-05 — multi-ATS end to end`, `2026-08-07 — the dead first fill` |
| **Job discovery** | `2026-07-30 — Discovery rebuilt from a live trace`, `2026-07-26 — Job DISCOVERY: a Discover button` |
| **Onboarding / auth / already-applied** | `2026-08-07 — fresh-account regression`, `2026-07-28 — Workday's already-applied LIE`, `2026-07-29 - a job-description page is not an auth screen`, `2026-07-27 — The false "SSO" halt`, `2026-07-24 — "Already applied" detector` |
| **Autofill with résumé** | `2026-08-08 — Autofill-with-Resume end to end`, `2026-08-07 (e) — the flow a first application should take` |
| **SKILLS field** | `2026-08-07 (d) — SKILLS: the multi-value typeahead` |
| **Replay walk / submit gate** | `2026-07-28 — The replay walk never settled the page`, `2026-07-28 — Submit gate relaxed`, `2026-07-28 — Background submit runs`, `2026-07-27 — Page-5 replay`, `2026-07-26 — Per-application LOGIN on the backend` |
| **Review page reconcile / false disagrees** | `2026-07-28 — Three FALSE disagrees blocked a clean run`, `2026-07-28 — The review-page scrape had no settle either` |
| **Cascade-revealed / became-required** | `2026-07-27 — Cascade-revealed required fields go back to REVIEW`, `2026-07-27 — Cascade review polish` |
| **Phantom duplicate entries** | `2026-07-27 — The REPLAY adapts to Workday's phantom duplicate-entry error`, `2026-07-27 — Phantom duplicate-entry fix generalized`, `2026-07-27 — Why the phantom-duplicate fix deleted 0/2` |
| **The phantom "required" error (self-ID)** | `2026-07-28 (later)`, `2026-07-28 (round 2)`, `2026-07-28 (round 3)`, `2026-08-07 (later) — the self-ID disability blocker was a COLON`, `2026-08-07 (later still) — waystar's self-ID variant` |
| **Employment-status recognizer** | `2026-07-24 — Employment-status screening radios`, `2026-07-24 — Employment-status hardening`, `2026-07-24 — Employment-status: ALL widget types` |
| **Answer buckets / teach flow** | `2026-07-31 (d) — TEACH verified end-to-end`, `2026-07-26 — Website URLs require ` |
| **AI batching / stray clicks** | `2026-08-06 — one AI call per page, and the stray click that was blamed on Workday` |
| **Résumé attach** | `2026-07-29 (later) - ` (the `role="alert"` status-channel fix) |
| **Service-worker breakage (the two Node-invisible classes)** | `2026-07-28 — Dead service worker: two files declaring one name`, `2026-07-28 — The replay walk never settled the page` |
| **Latest live sweeps** | `2026-08-09 — live sweep: marvell + moog verified`, `2026-08-09 (b) — the non-Workday merge did NOT regress Workday` |

## Progress log

Incremental: each milestone is one focused change, verified on a real page, one git commit (so we can bisect). Detail lives in git history + the topical sections above; this is the index.
- **M1–M9:** scaffold MV3 (popup→SW→injected chain) → enumerate `data-automation-id`s → `formField-*` classifier → text/dropdown/radio/typeahead fills → **classifier-driven engine** with shared helpers (`robustClick`, `waitFor`, `setSearchValue`, `settlePoll`, `normalize`, `matchCandidates`, `classifyField`) + per-field results table.
- **M10:** storage-backed profile + active-tab fill engine; `FIELD_MAP` (Workday fieldName → canonical profile path) + `resolve()` coercion; explicit skip-vs-`needs_review` (see Architecture).
- **M11 / M13.1:** `source` hierarchical picker, the US-Bank Enter-filter/`promptOption` variant, and the `isRequired` bare-`<abbr>` fix (see DOM lessons).
- **M12 / M13.3:** safety-first employer match + question-text employer scan (see Employer match).
- **M13 / M14:** persistent review summary + editable-dropdown review with `is_edited`/`edit_kind` provenance (see Review summary).
- **M13.2:** high-confidence tiered candidate lists (see Matching strategy).
- **M14.1:** `aria-controls`-scoped dropdown scrape fixing the chip/prior-listbox contamination (see DOM lessons).
- **M15:** SW-driven ONE page transition — fill → SW clicks Next (guarded) → poll-by-reinjection wait → re-inject → fill, hard 2-page cap; engine returns `nav` metadata, double Submit-guard, overwrite-per-page interim summary (see Multi-page). Live-verified on LiveRamp wd5.
- **M16.1:** proved the resume ATTACH mechanism on LiveRamp — rebuild a (hardcoded base64) PDF into a File in-page, set `input.files` via `DataTransfer` + synthetic `change` → Workday renders its confirmation row. `input.files` resets to 0 post-upload, so the `file-upload-item`/`file-upload-successful` row is the success signal (see dom-patterns 2026-06-03). The "Test resume attach" popup button + `attachResumeTest()` are **throwaway scaffolding** for round 2.
- **M16.2:** real resume stored in **IndexedDB** (`db.js`, key `resume:default`) — popup uploads a PDF → base64 in IDB; the attach test now reads those bytes in the SW and passes them as a STRING arg into the injection (a File can't cross the boundary). First unit tests in the repo (`node:test` + fake-indexeddb, `npm test`). Live-verified on LiveRamp (real resume attaches, confirmation row shows its filename). See Resume upload & storage.
- **M16.3:** resume attach **wired into the page fill** — engine reports `nav.uploadWidgetPresent` (new `file_upload` widget type); SW post-fill step `attachResumeForPage` (in both `RUN_FILL` and the walk) reads IndexedDB → injects `attachResume` (clears existing attachments via a re-resolved-fresh delete loop, attaches, gates on `file-upload-successful`) → patches the bundle entry to `filled`. Throwaway test button removed. Live-verified on LiveRamp (empty / 1 / 3 existing → all cleared + replaced). See Resume upload & storage.
- **M17 (round 4a):** first page-2 *content* fill — `fillWorkExperience` fills the first Work-Experience entry's `jobTitle`/`companyName`/`location` from `work_experience[0]` via `fillText`, **scoped to the `data-fkit-id="workExperience-N--null"` entry container** (the fix for duplicate `formField-*` ids); flat driver loop skips WE-container fields. Fill-in-place + idempotency live-verified on LiveRamp. See Repeating sections.
- **M17-date:** Work-Experience `From`/`To` **date composite** — pure `parseYearMonth` (`lib.js`, unit-tested incl. `"YYYY-MM"`-placeholder rejection) parses `"YYYY-MM"` **in the SW**, passed to the engine as `fromParsed`/`toParsed`; `fillDateComposite` sets the month/year spinbuttons (native-setter). Also **reconciles the `currentlyWorkHere` checkbox** to `currently_work_here` (the To box is removed when checked) before filling dates. Live-verified on LiveRamp. See Repeating sections.
- **M18 (round 4b):** **Work-Experience repetition** — `meaningfulWorkExperience` (pure, tested in `lib.js`) → `N`; the engine clicks **"Add Another"** to reach `N`, then fills each entry via the extracted `fillWorkExperienceEntry` (currentlyWorkHere reconcile → text → dates), re-resolving entries fresh per iteration. Add-only idempotency. Fixed the entry-container selector (`--null` suffix — date wrappers share the prefix). Live-verified on LiveRamp (3 distinct entries in order; entry 2's `currently_work_here` re-render didn't corrupt 1/3). See Repeating sections.
- **M18-role:** Work-Experience **Role Description** — filled per entry from `bullets` newline-joined (`joinBullets`, pure+tested in `lib.js`, computed SW-side as `bulletsText`); the engine sets the `<textarea>` via the `HTMLTextAreaElement` native setter. A WE entry is now complete (title/company/location/dates/currently-work-here/description). Live-verified on LiveRamp.
- **M19 (round 4c):** **Education** section — generalized the WE machinery into `fillRepeatingSection` (reused by both); `fillEducation`/`EDUCATION_MAP` fill school (text) / degree (dropdown) / fieldOfStudy (typeahead) / From-To (year-only date composite) per `education[]`, via the **create-first Add** path (Education starts empty). `degree`/`field_of_study` are **PROFILE-side tiered candidate lists** (through `resolve()`); `meaningfulEntries(arr,keys)` + `parseYear` added to `lib.js` (tested). Live-verified on LiveRamp (Add creates entries; degree→"Bachelors" via tier; fieldOfStudy matched). See Repeating sections.
- **M20:** **config-driven `fillMappedEntry`** (generalized the per-entry filler from a fieldMap) + **Websites** section (`webAddress-` entries ← `profile.websites[].url`) + **Education GPA** (`gradeAverage`→`gpa`). Live-verified on LiveRamp. See Repeating sections.
- **M21:** **delete-extras** — `fillRepeatingSection` now reconciles to **exactly N** (add up + delete trailing extras via `deleteEntryButton`, the panel-header `<button>Delete</button>` outside the `--null` container) — true idempotency across WE/Education/Websites. Plus **`ensureHttps`** (`lib.js`, tested) so website URLs fill as full `https://` URLs. Live-verified on LiveRamp (extra Education/Website deleted; URLs full). See Repeating sections.
- **M22:** **Languages** section — `language` dropdown + reading/speaking/writing proficiency dropdowns **resolved by label** (hashed ids; new `fillMappedEntry` `labelRegex` + `checkbox` widget) + the **"I am fluent" checkbox auto-checked when all three are Fluent** (`isFluent`, tested). **delete-on-no-match** added to `fillRepeatingSection` (optional pick-sections delete an entry whose required pick can't match, instead of blocking Next). Live-verified on LiveRamp (English all-Fluent + box checked; Chinese per-skill; bogus entry deleted). See Repeating sections.
- **M23a:** **Certifications section rebuilt on M22** — `parseYearMonthDay` (`lib.js`, tested), `fillDateComposite` full M/D/Y (`dateSectionDay-input`), `date` widget in `fillMappedEntry`, `CERTIFICATION_MAP` + `fillCertifications` (delete-on-no-match), `prepareProfile` cert parsing, `certifications` schema in profile.example. `fillTypeahead` deliberately LEFT at its M22 original (the typeahead rework is the next task). 26/26 tests; NOT yet live-verified end-to-end (the cert typeahead needs the Magna rework below). *(Context: an earlier uncommitted attempt at certs + a Magna typeahead rework was discarded via `git reset`; this is the clean rebuild on M22.)*
- **M24:** **CDP off-loop actuation** — recon (`RUN_CDP_RECON`, the new-tenant first step) + the simple-widget fill port (`RUN_CDP_FILL`): `cdp.js` substrate + `fill-driver.js` brain (M22 logic verbatim, fake-actuation tests incl. the named previous-worker-never-silent-"Yes" invariant), dropdown commit = type-to-highlight + verified Enter (coordinate clicks on out-of-view options dismiss the popup), text via `Input.insertText`, radio/checkbox label-click/Space — all SW-paced. Live-verified MINIMIZED on Magna wd3 (10 fields filled+verified; typeahead/source → honest `needs_review`). Throttle-diagnosis scaffolding (observe.js, `RUN_FILL_DEBUG`, experiment buttons) pruned — findings live in dom-patterns 2026-06-12. 49 tests. See CDP off-loop actuation.
- **M25:** **CDP typeahead port** (`fillTypeaheadCdp`, fill-driver.js) — the proven Magna brain on the CDP substrate, live-verified hidden on Magna wd3. Per-candidate tier walk; transition-aware settle (fresh-change since the candidate's own Enter; stale banner survives clearing); banner hard-block; chip-only commit signal; single-exact auto-commit on filter-Enter; multi-match via TRUSTED CDP CLICK (no highlight arms under CDP typing — the spec's second-Enter was human-typing; short-list proven / long-list = the Uruguay open question); pre-filled KEEP guard (countryPhoneCode auto-derived from Country). **Leak found + fixed mid-round:** a no-match banner DROPS searchBox focus → blind post-banner Ctrl+A/type/Enter committed a stray row-0 ("Afghanistan"); fixed with per-candidate **focus-hygiene (re-assert + verify, else abort to needs_review, never blind)** + an honesty final-chip-read (never `after:null` when the page holds a value). Live-verified: bogus `["xdfhjksdf","1"]` → no stray; real tiers → US committed; "United States of" containment + pre-filled-mismatch → flagged. Targeted harness `RUN_CDP_FILL_TA`; named `focusUnconfirmable` invariant test; 65 tests. See CDP off-loop actuation + dom-patterns 2026-06-12 (M25). The page-engine `fillTypeahead` (M22) is UNCHANGED (page substrate); the discarded-spec delete-sweep `ok` change waits for repeating sections on CDP.
- **M26:** **CDP source picker** (`fillSourceCdp`, fill-driver.js) — the "How did you hear about us?" hierarchical field is a SEARCH typeahead on Magna (chevron categories on open, but typing filters straight to leaves). Recon (`RUN_CDP_SOURCE_RECON`) → port mirroring the M25 walk with source deltas (promptOption/`data-automation-label` leaves chip-excluded; `promptLeafNode`-isselected / `selectedItem`-chip commit-verify; aria-controls null); fixed the cross-field chip contamination (exclude `selectedItemList`). Candidates from `defaults.how_did_you_hear`; wired into `drivePageFill`; targeted harness `RUN_CDP_SOURCE_FILL`. Live-verified hidden on Magna (LinkedIn auto-commits, verified). 74 tests (8 source). Tree/expand-walk source + Magna cert tree still deferred. See CDP off-loop actuation + dom-patterns 2026-06-14.
- **M27:** **CDP chip overwrite + auto-commit flag taxonomy** (`fill-driver.js`). **(a) Flag taxonomy:** one `commitOutcome(overwrite?, commitKind, matchTier)` lookup table emits the `(status, confidence, flag)` triple so they can't drift — `flag` = provenance (`autocommit-exact/fuzzy/containment/stray`, `directed-*`, `overwrite-success/stray/nomatch-original-kept/residual-flagged`, `prefilled-kept`), `confidence` = match quality; both NEW record fields, `matchTier` kept as the commit-path descriptor. Fuzzy-≥90 auto-commit DECISION: keep the value, **soft flag** (`filled_review`/`autocommit-fuzzy`), never silent `filled`. **(b) Non-destructive overwrite** of a mismatched pre-fill: recon (`RUN_CDP_OVERWRITE_RECON` / `RUN_CDP_SOURCE_OVERWRITE_RECON`) proved single-pick typeahead+source are **search-while-populated + commit-REPLACES + clearSearch-preserves-chip**, so the mismatch branch now FALLS THROUGH into the walk (NO delete-first; the old `DELETE_charm` plan is unneeded). Transition-aware chip detection (normalized set vs `priorChips` captured once, sampled in settlePoll); a no-match leaves the original intact + clears the filter text (`overwrite-nomatch-original-kept` — the non-destructive guarantee); a stray commit = `overwrite-stray` (ACCEPTED destructive edge — the original was already wrong); defensive single-chip assertion (`overwrite-residual-flagged`) for a hypothetical ADD tenant. Typeahead+source in **lockstep** (shared `chipSetChanged` / `overwriteNoMatchResting`). Live-verified hidden on Magna: directed-containment; source Family→LinkedIn + typeahead Albania→US (`overwrite-success`); bogus candidate → original kept + filter cleared. 87 tests. **Dropdown keep-guard = a follow-on commit.** See CDP off-loop actuation + dom-patterns 2026-06-14.
- **M27.C (dropdown keep-guard):** `fillDropdownCdp` short-circuits to `filled`/`dropdown-prefilled-kept` when the trigger already EXACT-matches a candidate (skip re-opening a cold 200+ list); placeholder/containment fall through. Shipped with the M27 set.
- **M28:** **CDP dropdown commit fix — TEXT-KEYED click** (`fillDropdownCdp`, fill-driver.js). The type-jump + counted arrow-walk broke when the dropdown was already on a value sharing the target's first letter (native type-ahead cycles the first char to the NEXT same-prefix match; on a 249-item list the `maxArrowSteps` cap was exhausted) AND — worst — it returned `needs_review` BEFORE the scroll+click fallback could run (that fallback was gated behind the highlight verifying). Replaced with a **TEXT-KEYED scroll+click** of the matched option (`cdpDropdownOptionRectByText` / `clickDropdownOptionByText`, scoped to the trigger's aria-controls listbox) — deterministic regardless of the STARTING selection, no scrape-order index assumption, **no arrow counting**; verify gate TIGHTENED to exact-normalize; backstop confirms the target is still present pre-click + a non-fatal index-desync canary; one retry then `needs_review` (never a wrong/silent commit). Live-verified hidden on Magna: country pre-set "United Arab Emirates" → commits "United States of America", `countryRegion`→"Florida", 0 needs_review/errors. **Finding (name fields):** the extra/erroring local/middle-name boxes seen in the bug run were revealed by the WRONG country committing — with the correct country NONE appear; that follow-up is narrowed to "do any correctly-picked countries reveal unfillable fields?" (US: no). 87 tests. See dom-patterns 2026-06-14.
- **M29:** **CDP rect/focus read retry** (`cdp.js`). `cdpRectReady(sel, scroll)` polls `cdpRectOf` SW-side until a non-zero layout box (≤2.5s/150ms); `focusText` retries the whole focus ladder until focused or ceiling; `openDropdown`/`clickRadioLabel`/checkbox-label routed through it. Logs `RECOVERED`/`gave up` ONLY when the retry engages (clean runs silent) — a diagnostic. Absorbs a genuine throttle-transient 0-rect; happy path is first-read (no added latency). 87 tests, no regression; live: clean run, transient not reproduced (engagement confirmed opportunistically via the logs). **REFRAME (load-bearing):** the field-drops we chased ("could not focus input" / "trigger rect dead") are most likely **session-logout**, not throttle-transient — a logged-out session can't fetch/lay-out server-loaded content (live: `source` "How did you hear" did NOT load after a manual logout → "no candidate"). So M29 fixes only the smaller transient sliver; a `gave up` log next logout confirms "session-gone". See dom-patterns 2026-06-14.
- **M30:** **CDP session-expiry EARLY-WARNING (heuristic, SOURCE-only — NOT general session detection).** Recon refuted static detection: a timed-out Magna page is **DOM-identical** to a live one (form fully rendered, candidate email still shown, same URL, no login/session/VPS markers — `RUN_CDP_SESSION_RECON` diff). Session-death is only observable behaviorally. So M30 ships a narrow heuristic: `fillSourceCdp` reports `optionsLoaded` (did the "How did you hear about us?" leaves EVER render); `drivePageFill` raises ONE run-level `sessionWarning` when the source field ended `needs_review` with `optionsLoaded === false` (server never returned options = likely dead session); `runCdpFill` leads the report with it + popup status. **SCOPE (honest):** only fires on pages that HAVE the `source` field, via its options failing to load — a page without `source` gets NO warning (no false positive, no coverage); a matching miss (leaves loaded, no candidate) does NOT fire (the false-positive guard, unit-tested). It's a NOTE, never a halt. 90 tests. See dom-patterns 2026-06-14.
- **M31:** **CDP guarded page-advance + VPS/session detector** (one transition). **Recon GATE first** (per the false-positive risk): proved `vpsErrorPresent` (the `Error Code: VPS|` banner) is FALSE on a LIVE validation error and TRUE on a dead session → the clean discriminator (one Magna pair — re-check other tenants). `sessionLooksDead(state)` (lib.js, pure, unit-tested) = `vpsErrorPresent` OR `sessionBanner` OR login marker OR no-form; NEVER keys off the validation-tripping `errorPageText`/`errorMarkers` — a valid form (incl. one showing validation errors) is never dead. `clickPageNext` (cdp.js): guarded Save & Continue (refuse on `applyFlowReviewPage` — the double Submit-guard). `runCdpWalk` (background.js): fill page 1 → guarded advance → `cdpWaitNextPage` (the CDP attach SURVIVES nav — no re-injection; dead-check first, else hydrated page-signature change) → **HALT "session expired" on VPS/dead**, "advanced (page-2 fill deferred)" on a clean transition, or a **nav-timeout DIRTY-STATE report** (clicked, no advance, no error → page 1 may be dirty; eyeball, don't re-scan fresh). ONE transition; **page-2 fill is OUT** (My Experience = repeating sections, deferred on CDP). **M31.1:** the nav-timeout/session-expired stops now PRINT the exact page errors (`errorMarkers` samples + `errorPageText`) AND the fields the walk left EMPTY because the profile/JSON has no value (the likely "required" cause) — for future-AI page-debugging. **LIVE-VERIFIED:** advance (clean transition), dead-session detector (logged-out → VPS halt), validation false-positive guard (required field empty → nav-timeout DIRTY-STATE, NOT session-expired), Back restores page 1. M30 also live-verified. 98 tests. See dom-patterns 2026-06-15.
- **M32a:** **CDP repeating-section recon harness** (`RUN_CDP_REPEAT_RECON` / `runCdpRepeatRecon` + `cdpRepeatingScan`, read-only structure dump + Websites shape check + a bounded date-spinbutton probe). Run hidden on Magna wd3 page 2: 5 sections enumerated; **date probe FAILED all three CDP channels (insertText/per-char/arrow) → dates are UNACTUATABLE on CDP, a recorded HARD BLOCKER**; Websites flagged as the date-free machinery proof. Committed as its own milestone (recon-only, +341/−0). See dom-patterns 2026-06-16.
- **M32b:** **CDP repeating-section fill — Websites** (`driveRepeatingSectionCdp` + `fillEntryCdp` in fill-driver.js; `repeatingScan`/`entryCount`/`clickSectionAdd`/`clickDeleteEntry` `act` methods + their page fns in cdp.js; `runCdpFillWebsites`/`RUN_CDP_FILL_WEBSITES` + the `cdp-fill-websites` popup button). Port of `fillRepeatingSection`+`fillMappedEntry`: reconcile to N (Add up / Delete trailing extras down, count-polled off-loop, bounded), then fill each entry's mapped fields via the existing per-widget CDP handlers with **entry-scoped composed selectors**. **DATE/YEAR fields DEFERRED** — `status:"skipped"`, `flag:"cdp-date-deferred"`, ZERO actuation (named invariant test). Add disambiguation by nearest-heading regex (verified: `/websites?|web ?address/i` hits only "Websites 3" among the 5 sections; no `length===1` fallback). Add/Delete = scroll-inside-eval + viewport-rect + M29 retry + `cdpClickAt`. Websites only this round; Languages/Education/Certs/WE reuse the driver later. 106 tests (8 new: reconcile up/down, distinct-url fill, N=0 cleanup, date-deferred-zero-actuation, delete-on-no-match high→low, add-cannot-mount + delete-no-drop bounded). **LIVE-VERIFIED hidden on Magna wd3 page 2:** reconcile UP (added 2 → 2/2) on the first run and reconcile DOWN (idempotent re-run deleted 2 extras → 2/2); `website[0].url`=linkedin / `website[1].url`=github each filled+verified with ITS OWN url (entry-scope uniqueness confirmed — distinct values, no duplicate-id bleed); 0 needs_review. **Date note (re-probe lead):** a HUMAN can click a date segment and type numbers, so the field isn't inherently locked — the M32 blocker is specifically CDP SYNTHETIC input (insertText/per-char/arrow all failed read-back); a future date round should re-probe the exact CDP key-event shape (focus landing / digit `code`+`keyCode`). See dom-patterns 2026-06-16.
- **M33:** **CDP date blocker RESOLVED — it was a probe artifact** (`runCdpRepeatRecon` date-probe rewrite). The M32 probe targeted `dateSection*-display` (`dateSegments[0]` — a read-only span with no `.value`) and read `.value` off it → compared `undefined === "12"` and false-negatived EVERY method regardless of whether keystrokes landed. The corrected probe (target the `-input`, parseInt read-back, focus decoupled from read-back): the `-input` is **0-box** (coordinate-click impossible — that was the real obstacle), but **triple-clicking the visible `-display` focuses it**, and then **BOTH per-char `cdpTypeChars` AND `Input.insertText` make `.value` stick** (read-back "12"); the month spinbutton **auto-advances to year** ("2024" stuck); clean restore. Rect-free `cdpFocusBySel`/`cdpDomFocus` are focus fallbacks. ⇒ dates ARE actuatable on CDP; the `cdp-date-deferred` skip stays only until M34. **LIVE-VERIFIED hidden on Magna wd3 page 2.** See dom-patterns 2026-06-16.
- **M34:** **CDP date composite — `fillDateCompositeCdp`** (proven standalone). Substrate: `cdpTripleClickAt` + `act.focusDateSegment`/`readDateSegment`/`typeDigits` (cdp.js). Brain (fill-driver.js): per segment, **triple-click the visible `dateSection<seg>-display`** (SELECTS it) → `focusDateSegment` READS `.focused` (the focus-verify gate — never type into an unfocused segment) → per-char type (insertText fallback) → parseInt read-back-verify. Targeted `RUN_CDP_FILL_DATE` harness. **⛔ NO Ctrl+A in the date path:** the first build cleared each segment with Ctrl+A+Delete, which spans the WHOLE composite + resets focus to Month → Day/Year digits piled into Month (the intermittent "12/20/2024" bug); the `RUN_CDP_DATE_MECH` mechanics probe (since pruned; finding in dom-patterns) proved it the SOLE culprit (no auto-advance race — both no-clear recipes 3/3). Triple-click-select + type-replace needs no clear (a `node --test` guard asserts the composite never whole-field-clears; a future replace-on-type-hostile tenant would use segment-scoped Backspace, never Ctrl+A). **LIVE-VERIFIED hidden on Magna wd3 page 2:** WE M/Y "5/2025", Education **year-only** "2024", Certs **M/D/Y** "6/15/2024" — all `filled`/`verified`, every segment via `triple-click-display`; M/Y confirmed not a Month-first false pass (Year focus-verified). 113 tests. `fillEntryCdp`'s date branch stays DEFERRED until M35. See dom-patterns 2026-06-16.
- **M35:** **Languages on CDP (date-free)** — `LANGUAGE_MAP` ported into fill-driver + `runCdpFillLanguages`/`RUN_CDP_FILL_LANGUAGES` + the `cdp-fill-languages` popup button, reusing `driveRepeatingSectionCdp`/`fillEntryCdp` UNCHANGED (the dropdown + checkbox + `labelRegex` routing built in M32b). FIRST live exercise of the wired-but-unproven paths, **all PROVEN LIVE hidden on Magna page 2:** (1) the hashed-id proficiency dropdowns (`formField-5aaaed…`) resolve **BY LABEL** and commit; (2) **entry-scope holds despite IDENTICAL hashed ids across entries** (the duplicate-id trap — `language[0]` English / `language[1]` Chinese, own values, not crossed, via the fkit-prefixed composed `wrapperSel`); (3) "I am fluent" reconciled to `_allFluent` (English checked / Chinese unchecked); (4) **deleteOnNoMatch via the no-match trigger** — a bogus `"Zxqwbogus"` language → `language[2].removed` ("required pick didn't match"), the RIGHT entry deleted, English/Chinese intact. Corrected the false "checking fluent hides the proficiencies" comment (recon: they stay visible). 119 tests (6 Languages: English-all-Fluent, Chinese-per-skill, entry-scoped-duplicate-hashed-id, deleteOnNoMatch-right-entry, labelRegex-no-match→error, native-last). See dom-patterns 2026-06-17.
- **Cleanup (post-M35):** pruned 5 served popup harnesses + their full logic (handler + dispatch + runner) — the one-off milestone recons `cdp-ta-recon` (M25), `cdp-overwrite-recon` + `cdp-source-overwrite-recon` (M27), `cdp-source-recon` (M26), and the redundant single-widget verify harness `cdp-fill-ta` (typeahead is exercised by the full `cdp-fill` + unit tests). Dead helpers removed in lockstep: `TA_ENTRY_CANDIDATES` (background.js), `cdpScanTypeaheads` (cdp.js). **KEPT** (caller-traced, NOT name-matched): `cdp-source-fill` (the ONLY path that ever live-filled source — M26/M27 ran through it, not `cdp-fill`), the new-tenant recons (`cdp-recon`/`cdp-repeat-recon`/`cdp-session-recon`), the section harnesses (`cdp-fill-websites`/`languages`/`date`), and all `act`-interface-shared reads (`cdpReadTaState`/`cdpSourceLeafProbe`/`cdpReadSourcePick` — used by `fillTypeaheadCdp`/`fillSourceCdp` inside `cdp-fill`). Popup 20→14 buttons; grep-verified zero dangling refs; 119 tests green.
- **M36:** **CDP dates wired into Education + Certifications** — un-deferred `fillEntryCdp`'s date branch (the M32b `cdp-date-deferred` zero-actuation skip) to call the M34 `fillDateCompositeCdp` (a "YYYY" string → year-only; `{month,year,day}` → M/D/Y); ported `EDUCATION_MAP` (school/degree/fieldOfStudy/gpa + from/to **year-only** dates) + `CERTIFICATION_MAP` (certification typeahead/number + issued/expiration **M/D/Y** dates) into fill-driver.js (lockstep ↔ background.js); `runCdpFillEducation`/`runCdpFillCertifications` + dispatches + `cdp-fill-education`/`cdp-fill-certifications` popup buttons. **`deleteOnNoMatch` `ok`-fix:** a required pick that committed a value as `filled_review` (containment/fuzzy — e.g. the abbreviated cert "CPP" → the full option via `autocommit-containment`) now KEEPS the entry (`ok = …|| r.status === "filled_review"`) — it won't block Next, so it's kept + flagged, NOT deleted (latent bug: any abbreviated/fuzzy required pick was at risk). **LIVE-VERIFIED hidden on Magna wd3 page 2:** Education year-dates in-section (`firstYearAttended` "2024" / `lastYearAttended` "2028", verified, entry intact); Certs **M/D/Y** in-section (`issuedDate` 6/15/2024 / `expirationDate` 6/15/2027, **distinct per-segment** values via `triple-click-display/typeChars`, verified) AND the "CPP" `filled_review` cert **kept** (not deleted) — the `ok`-fix live-proven. 121 tests (the M32b deferred-date test replaced by 3 segment-WRITE tests: M/Y, M/D/Y-Certs-shape, Education-year-coexists). **Surfaced (→ follow-on):** each cert entry also has a **nested Specialties** sub-section (a repeating typeahead + start/end date *inside* the entry) + per-cert **Attachments** — never recon'd; Specialties → recon AFTER M36.1; Attachments → DEFERRED (no source data in the profile). See dom-patterns 2026-06-17.
- **M36.1:** **CDP tier-aware pre-filled guard** (`fillTypeaheadCdp` + `fillSourceCdp`, lockstep). The pre-filled guard kept a chip priority-blind (`candidates.some(...)`) — the live fieldOfStudy bug: a stale tier-3 "Electrical Engineering" was kept over the reordered tier-1 "Other". Fix: compute the pre-fill's matched **tier index** `k` (first candidate it exact-normalize-matches); **`k===0`** → keep, ZERO actuation (`prefilled-kept` — countryPhoneCode auto-derive, `normalize()` strips the `(+1)` so the chip is tier 0); **`k>0`** → walk ONLY the higher tiers (`candidates.slice(0,k)`, priority order) and overwrite to the HIGHEST the form offers (`overwrite-success`), else keep the pre-fill (`overwriteNoMatchResting(keptLowerTier)` → `filled`/**`prefilled-better-tier-unavailable`**, NOT a no-match — and NOT zero-actuation: it searched the higher tiers); **`k===-1`** (mismatch) → unchanged full overwrite walk. Dropdown left priority-blind for now (a tier-aware dropdown keep would re-open a cold 200-item list — the M27.C cost). **[SUPERSEDED 2026-06-30: dropdowns are now tier-aware too — see the "tier-aware dropdown" progress-log entry below; the operator wanted a lower-tier country pre-fill overwritten to the top candidate.]** **LIVE-VERIFIED hidden on Magna page 2:** fieldOfStudy "Electrical Engineering"→**"Other"** overwrite (run 1), then "Other" kept best-available (run 2, tier-0 not offered); countryPhoneCode + source "LinkedIn" tier-0 → `prefilled-kept`, zero actuation (regression intact). 127 tests (6 new: tier-0 zero-actuation INVARIANT, k>0 highest-offered for TA+source, k>0 nothing-higher keep, k===-1 full-walk). See dom-patterns 2026-06-17.
- **M36.2:** **CDP cert Specialties recon (read-mostly discovery — structure DISCOVERED LIVE).** `runCdpCertSpecialtyRecon` + `cdpCertSpecialtyScan` (background.js + cdp.js) + `cdp-cert-specialty-recon` popup button: ensure a cert entry → observe its inside Add → mount ONE specialty → dump the before/after `data-fkit-id` + field DIFF → log. **Findings:** each cert entry hosts a REPEATING **Specialties** sub-section + an **Attachments** upload (a repeating section nested inside a repeating entry — first observed). Specialty entry fkit = **`certification-<N>--specialties-<M>--<field>` (NO `--null` container** — the entry is the SET of `--specialties-<M>--{specialtyParent,startDate,endDate}` field-fkit nodes); fields = `specialtyParent` (typeahead, required) + `startDate`/`endDate` (M/D/Y dates); Add is INSIDE the cert entry (heading "Specialties", page-wide → the nested fill needs per-cert-entry-scoped Add/Delete); `formField-*` ids duplicate across specialties → scope via the `--specialties-<M>--` fkit. **Nested specialty FILL DEFERRED** (niche; recon'd + documented — see dom-patterns 2026-06-18). The recon MOUNTS a specialty and does NOT auto-remove it (not a `--null` entry; the real nested Delete is the deferred fill's job) → honest LEFTOVER log; operator clears manually. **Cert Attachments DEFERRED** (no per-cert files). See dom-patterns 2026-06-18.
- **M37 Part 0:** **CDP textarea actuation recon — the WE gate, RESOLVED.** `runCdpTextAreaRecon` + `RUN_CDP_TEXTAREA_RECON` + `cdp-textarea-recon` popup button: probe the WE `roleDescription` `<textarea>` with a MULTI-LINE value (2 lines, one `\n`) via (a) coordinate-click focus + `Input.insertText` and (b) native-setter via `cdpEval`. **LIVE on Magna page 2: BOTH PASS** — full value landed with the newline intact (`lines===2`) AND survived a React re-read. **DECISION: (a) `Input.insertText` PREFERRED** (trusted input, consistent with `fillTextCdp`'s `typeText`; insertText does NOT mishandle the textarea newline); (b) native-setter is the proven fallback. ⇒ WE roleDescription needs only a textarea-TARGETING focus + read-back (`querySelector("textarea")`, not `"input"`) reusing the same `typeText`; the `<input>` path stays untouched. See dom-patterns 2026-06-18.
- **M37 Part 1:** **Work Experience on CDP — PROVEN LIVE (incl. dirty-state).** `fillTextCdp` gained a `tag` param (default `"input"` → existing callers byte-identical; `focusText`/`readTextValue`/`cdpReadTextState` target `tag`); `fillEntryCdp` gained a `textarea` widget (→ `fillTextCdp(...,"textarea")`), a generic `skipWhen(item)`, and a `waitForPresence` **poll-until-present** (bounded re-scan, never a fixed wait — M29); `WORK_EXPERIENCE_MAP` (currentlyWorkHere checkbox FIRST → text → M/Y dates → roleDescription textarea ← `bulletsText`) + `runCdpFillWorkExperience`/`RUN_CDP_FILL_WORK_EXPERIENCE` + `cdp-fill-work-experience` button, reusing `driveRepeatingSectionCdp`. **LIVE on Magna page 2 (3 entries × 2 runs, 0 needs_review):** roleDescription textarea filled+verified multi-line every entry; currentlyWorkHere reconciled (false→already / false→true label-click / true→already); `currently_work_here:true` → endDate `skipped`; M/Y dates + entry-scoping held. **Run 2 dirty-state proof:** operator added wrong values + random checkboxes → re-run reconcile-DOWN deleted the extra entry, overwrote every wrong value back to correct, idempotent checkboxes (reconcile-from-arbitrary-state, not just happy-path). 132 tests (5 new WE). See dom-patterns 2026-06-18.
- **M38 Part 1:** **the FOLD — full page-2 in ONE `drivePageFill` (flat + repeating).** A `PAGE_SECTIONS` registry → `drivePageFill` drives each PRESENT repeating section after the flat fields (presence = `containerPrefix` in `repeatingScan.sections` OR an `addButtons` nearestHeading matching the `headingRegex`; absent → skipped, so page 1 is byte-identical) + `runCdpFillPage`/`RUN_CDP_FILL_PAGE` + the **"CDP fill FULL PAGE"** button (passes the PREPARED profile). A **literal oracle comparison** (folded run vs the 5 standalone harnesses) caught 2 integration bugs "0 needs_review" would miss: **Bug A** — `focusDateSegment`'s one-shot focus flaked WE[0].endDate Year → **fixed** with an M29-style retry; **Bug B** — `deleteOnNoMatch` SILENTLY destroyed valid English/Chinese on a transient dropdown-render failure → **fixed (B1)**: pick handlers tag `genuineNoMatch` (dropdown options-rendered-but-absent; typeahead/source every-candidate-definitively-negative), `deleteOnNoMatch` deletes ONLY on a genuine no-match — transient/infra → KEEP + `needs_review` (M35 genuine-delete preserved + unit-pinned). **Re-run = clean oracle pass** (filled 46, filled_review 1 CPP, skipped 2, 0 needs_review; every section matches). 136 tests (3 fold + genuine-vs-transient deleteOnNoMatch pair). **Bug B2 (the intermittent cold-widget render failure deep in a long fold) UNDIAGNOSED** — didn't reproduce; B1 makes it non-destructive; targeted fix waits for a reproduction with detail (a known long-fold risk for ANY section). Console-report only. See dom-patterns 2026-06-19.
- **M38 Part 2:** **CDP review-summary bundle + write-per-page accumulation (viewer-verified).** The CDP path's FIRST persisted `reviewSummary` (was console-only). `buildReviewBundle` (fill-driver.js, pure) reproduces the page-engine `buildEntry` schema (TODO(dup) — the viewer reads both paths; schema-drift check passed: `summary.js` reads a subset), filters `widgetType==="section"`, **page-qualifies `field_id`** (the viewer keys `reviewValueNodes` on it). `cdpPageKey` (lib.js) = url PATHNAME (drops volatile query) + field-set — the STABLE merge key (not the full-url `cdpPageSig`). `accumulateBundle`+`persistAccumulated` (background.js) merge **write-per-page**, keeping OTHER pages VERBATIM (viewer edits survive). Wired into `runCdpFillPage` (pre-fill `cdpPageKey` → build → persist). **"Clear summary" popup button** = the reset (accumulation grows monotonically — a first run retained stale section recs). **LIVE: "View last summary" renders the accumulated CDP bundle; after Clear → re-fill → CLEAN (single page, 44 fields, zero stale recs, NEEDS REVIEW = file_upload + CPP).** 143 tests (4 bundle/accumulate + 3 cdpPageKey). Edit-persistence = unit-proven + inferred (unchanged page-engine editor on a schema-matching bundle), NOT live-exercised on a CDP bundle yet (first seam if a Part-3 edit doesn't survive). See dom-patterns 2026-06-19.
- **M39: foreground fast-fill + the false-verify it exposed (3 stacked fixes, all live-verified — page MATCHES report).** **(a) Foreground fast-fill** — `act.delay` is now visibility-adaptive (`cdpVisible()` TTL cache → ~5× faster when `document.visibilityState==="visible"`, FULL when hidden, re-sampled so a mid-fill minimize/restore adapts live); `runCdpFillPage` DROPPED the `cdpWaitHidden` gate (fills immediately, visible=fast/watch or minimize=slow/background). **The 5× applies to OUR pacing between actions — NEVER the page's own render.** **(b) Open-retry** — a fast open-click fires DURING the prior field's post-commit React re-render and NO-OPs (the trigger never expands → no list → the old single open burned the full ceiling + false-failed "options did not render"; the alternating-dropdown pattern was the tell, and this was ALSO M38's undiagnosed Bug B2). `fillDropdownCdp` now bounded-retries on an aria-expanded GATE (re-open ONLY while not expanded; **toggle-shut INVARIANT** — never re-click an expanded trigger, a 2nd click closes it); same open/focus retry for the typeahead. **(c) FALSE-VERIFY fix (SEVERITY: a false `verified:true` — the ONE failure the safety contract exists to prevent).** At fast pacing the dropdown PICKED before the option list finished rendering; the pick was DISCARDED on render-complete, but the inline verify caught the MOMENTARY value → reported `filled`/verified with the target while the PAGE reverted to default (degree Bachelors→Associates; English/Chinese reading+speaking →Basic). Fix = `act.delayFull` (NON-adaptive — the page's render takes real wall-clock time regardless of tab speedup): GATE 2 option-settle waits for COMPLETE render before picking, AND the commit-verify adds a PERSISTENCE re-read (the target must STILL show after a real beat — a momentary pick is never accepted → honest `needs_review`, never a silent wrong fill). **Class audit (every widget's verify):** only the dropdown was exposed (correctness depends on an async option-list render + a discardable pick); text/date read back values set SYNCHRONOUSLY (`insertText`/`typeDigits`), radio/checkbox `pollCheckedIs`, typeahead/source poll the chip — all render-aware. **LIVE on Magna page 2 (visible):** page matches report — degree Bachelors, English all Fluent, Chinese reading Intermediate/speaking Advanced/writing Intermediate, correct FIRST TRY; text/dates stay fast. 148 tests (open-retry recover, toggle-shut invariant, never-expands→needs_review, false-verify persistence guard, typeahead focus-race recover). See dom-patterns 2026-06-19.
- **M39.1: reactive text/date read-backs (the M39 generalization, part 1).** The open-race + false-verify were ONE disease — fixed-time-then-assume instead of poll-until-the-page-state-holds; this sweeps the read-backs so the fill survives any machine / laggy wifi (nothing proceeds on a hardcoded timer). `fillTextCdp`: type → **POLL `readTextValue` until `value === target`** (the COMPLETE value), ceiling = give-up only (dropped the fixed clear-settle — CDP clear→type events apply in order). `fillDateCompositeCdp`: per segment, type → **POLL `readDateSegment` until `parseInt === val`** (COMPLETE — a half-typed "1" of "15" can't satisfy it; the dropdown's complete-state lesson applied), ceiling = give-up. `DEFAULT_BUDGETS` gained `textReadCeilingMs`/`textReadIntervalMs`. On a good connection the poll matches on the first read (no fixed wait); on lag it waits as long as the page needs, up to the ceiling. **LIVE-VERIFIED on Magna page 2 (visible): page matches report, text/dates fast, no regression.** 152 tests (lag-model: value/segment registers only after N reads → poll waits then fills; never-registers / stuck-partial → needs_review, since real lag can't be injected live). Pure-pacing delays (`interFieldMs`/`reopenSettleMs` — no page-condition to poll) kept minimal. See dom-patterns 2026-06-20.
- **M39.2: reactive typeahead/source pre-Enter settle (the M39 generalization, part 2 — the DELICATE one, verified IN ISOLATION).** The last fixed-then-assume waits: `fillTypeaheadCdp`/`fillSourceCdp` did `clear → fixed delay → snapshot` then `type → fixed delay → pressEnter`. Converted ONLY the pre-Enter waits → a shared **`pollSearchValue`** polling the searchBox VALUE (the input REFLECTION `searchBox.value` — an ECHO wait, NOT the filter-render; `typeInSearch` is char-by-char + awaits every keystroke dispatch, so the happy path matches on the FIRST read) until `""` (post-clear) / the full candidate (post-type), ceiling = give-up → PROCEED-to-Enter (strictly-better than today — worst case == today, no hang). The COMMIT gate (post-Enter transition-settle: sawChange/chip/banner/filtered) is UNTOUCHED, so M25 focus-hygiene / stray-commit guard / banner-block run exactly as before. Also converted the `overwriteNoMatchResting` resting-clear (gates nothing verified — result comes from `endChips`). **LIVE-VERIFIED IN ISOLATION (separate from text/date, watching for the M25 stray/partial-commit SHAPE not mere presence):** `cdp-source-fill` → LinkedIn `autocommit-exact`, single chip, settle 459ms; full-page typeaheads → fieldOfStudy "Other" (`overwrite-success`, correctly over the stale "Electrical Engineering") + cert CPP `autocommit-containment`, both `filled_review`, NO stray, commit on the COMPLETE candidate. 154 tests (+2: typed value reflects late → poll waits then Enter fires + commits; echo never lands → proceeds to Enter, no hang). See dom-patterns 2026-06-20.
- **M40: post-fill page AUDIT — the permanent backstop for the false-verify CLASS.** A SECOND, INDEPENDENT read of the live DOM AFTER the whole page settles, reconciled vs what each field RECORDED — catches what per-field in-fill verify structurally CANNOT: a value clobbered AFTER its own fill (cross-field / delayed reset; M39 was the IN-fill race, this is the post-settle one). **FLAG-ONLY** (reconcile + flag, never auto-refill). `reconcileAudit` (fill-driver.js) re-reads each `filled`/`filled_review` field by widget type (reusing the existing `act` reads, all keyed by the retained `auditLoc` — a selector string re-resolved fresh) after one `delayFull` settle, and classifies **match / mismatch / unverifiable**. Dates re-read via `auditDateSegments` (the EXACT inverse of `fillDateCompositeCdp`'s `afterStr`: 1 part=Year, 2=M/Y, 3=M/D/Y — round-trip unit-pinned). A **mismatch** → `needs_review`/`audit-mismatch`, `after`=the live truth; **unverifiable** (loc no longer resolves) → `audit-unverifiable` (NEVER a silent pass). Two triggers: **inline** (auto, end of `drivePageFill` → mutates results → flows into the bundle) + **standalone** (`runCdpAudit`/`RUN_CDP_AUDIT` + "CDP re-audit last fill" button, re-reads the persisted `reviewAudit` expectations — for the perturbation re-check + manual re-check). **LIVE perturbation-gate-verified on Magna (both pages clean = ZERO false flags; then every staged change CAUGHT — countryPhoneCode→Algeria typeahead-mismatch, schoolName→"…yyy" text + issuedDate→6/15/2023 date (round-trip proven live), and a DELETED workExperience[2] → all 7 fields `unverifiable`/"null", never silent).** Also dropped the stale "minimize" message on the full-page button (M39). 165 tests (+11: date round-trip all 3 shapes, per-widget mismatch, no-false-flip, unverifiable, the mutation, clean-run-no-false-flags). See dom-patterns 2026-06-21.
- [ ] **NEXT — Field-of-Study typeahead recon (READ-ONLY feasibility probe, chosen before Part 3).** FoS renders only "Other" + the edit-on-form note (it's a typeahead; the bot's search surfaced ≤2 options). Probe: does Magna's FoS typeahead ENUMERATE a bounded option list (on open / a broad/empty search), and HOW LARGE? If enumerable + reasonable → a later round captures `entry.options` so the review shows a dropdown + the fill matches a specific value. If huge/server-search-only → document + keep the form-edit note + the profile-top-tier workaround. **Stay read-only — do NOT build an option-capture path before the size is known.**
- **M38 Part 3: the N-page walk loop — BUILT (live-verify-to-review DEFERRED, blocked on prereqs).** Generalized M31's one-transition `runCdpWalk` into an N-page LOOP: extracted **`fillAndPersistPage`** (the per-page work — fold `drivePageFill` + inline M40 audit + `buildReviewBundle` + `persistAccumulated`) shared by `runCdpFillPage` (single page, now a thin wrapper) and the walk. Loop: top-of-iteration guards (`sessionLooksDead` → halt; `applyFlowReviewPresent` → **STOP `reached-review`, SUCCESS, never submit**) → fill (no advance click) → `clickPageNext` (independently refuses on the review marker — the 2nd guard) → `cdpWaitNextPage` (`sessionDead` halt / `timeout` `nav-timeout-dirty` + diagnostics / `advanced` → next). Dropped the hidden-gate (M39 foreground fast-fill). **Clears `reviewSummary`+`reviewAudit` ONCE at walk START, OUTSIDE the loop** (mid-walk clear would wipe accumulated pages). `WALK_MAX_PAGES=8` backstop. **SUBMIT-NEVER double guard reused VERBATIM from M31** (review check at the TOP of each iteration before any fill/click + `clickPageNext` review-refusal — confirmed the extraction did NOT move the check after a click). 165 tests green (the walk is SW glue, not fill-driver). ⚠ **Live-verified only up to graceful halts; the LOOP reaching the ACTUAL review page has NEVER run live** (no page advances until the resume + AI prereqs land → the to-review path is currently UNREACHABLE by construction). **HARD GATE before any unattended walk: the first to-review walk MUST be watched eyes-on on a DISPOSABLE application** (committing-as-built does NOT discharge this). **Blocked on two prereqs below.**
- **Resume attach on the CDP path (walk prereq 1) — mechanism PROVEN LIVE; isolated advance-past-upload PENDING.** The required page-2 "Application Documents → Upload a file*" blocks Save & Continue until a file attaches; the CDP fold recorded `file_upload` as `skipped`. **Recon (`RUN_CDP_RESUME_RECON`) resolved the unknown:** `cdpEval(attachResume, base64, filename, mime)` runs the PROVEN self-contained `attachResume` on the SAME debugger attach (no chrome.scripting, no second client) and WORKS — `attached:true`, `confirmationVia:"file-upload-successful"`, ~1–2.2s VISIBLE, idempotent (`deletedCount:1` on re-runs: clears-then-attaches). Wired into `fillAndPersistPage` (after `drivePageFill`, before `buildReviewBundle`): read `getResume` (IndexedDB) → `cdpEval(attachResume,…)` → patch the `file_upload` record to `filled`; **no-resume/attach-failed → `needs_review`**, and `runCdpWalk` HALTS `resume-not-attached` BEFORE `clickPageNext` (self-explaining, not a bare nav-timeout). **LIVE in the walk: page 1 filled → `✓ advanced` → page 2 filled → `resume: attached "Kevin's Resume 2.pdf"`.** ⚠ **The isolated "Save & Continue ADVANCES past the upload" proof is PENDING — confounded (NOT disproven) this run by an unrelated `Duplicate language entries are not allowed` validation blocker** (state residue from re-running the same app + manual perturbations — NOT a fill bug: the fill report + M40 audit both show distinct English/Chinese; the M31.1 halt correctly named the dup). To confirm on a clean page-2 state. 165 tests green (SW/CDP glue; brain untouched). `RUN_CDP_RESUME_RECON` stays as the new-tenant resume probe. See dom-patterns 2026-06-21.
- **Typeahead keptLowerTier STRAY fix ("Other"→"Accounting") — a fast-pacing disarm race, LIVE-VERIFIED.** M40 surfaced a silent corruption: `fieldOfStudy` pre-filled "Other" reported KEPT "Other" but the page held "Accounting". Recon (`RUN_CDP_TA_STRAY_RECON`) + the full-page fill pinned it: a no-match higher-tier search ARMS listbox row-0 ("Accounting"); `overwriteNoMatchResting` re-focuses → DISARMS, but the disarm is async — at SLOW pacing it completes (safe), at FAST (M39) pacing the field is EXITED first and the next field's focus COMMITS the still-armed stray (M39-family race; the operator facts fit — Escape doesn't blur, a human-slow neutral click is safe). **Fix:** (1) keptLowerTier → AFFIRMATIVELY **re-commit** the kept value (`recommitFn`) so the armed row becomes the correct value (race-proof); (2) plain overwrite-no-match + the empty-field sibling → **`disarmHighlight`** (re-focus + poll `delayFull` real-time until `activeText` null before dismissing); (3) **strayed-check** → `overwrite-stray` if it still strayed (never a false keep). TA+source lockstep. **LIVE: fieldOfStudy stays "Other", M40 no mismatch; cert "CPP" kept.** 166 tests. See dom-patterns 2026-06-22.
- **Input-lock during fill — operator-protection, LIVE-VERIFIED (deterrent+mitigation, not absolute).** While a CDP fill runs VISIBLE the operator can accidentally click/type and corrupt it; the bot's CDP input is `isTrusted` like the operator's. Recon (`RUN_CDP_INPUTLOCK_RECON`, 3 probes; the can't-miss choke = all `Input.*` originate in `cdpClickAt`/`cdpTripleClickAt`/`cdpKeyTap`/`cdpInsertText`): (1) a pointer-events:auto overlay BLOCKS the bot's own click → flag-gate, not a static overlay; (2) `insertText` bypasses a keydown-blocker, per-char keys don't → block keydown+paste; (3) with a CONTROL, clear-after-dispatch LANDED → the toggle-timing self-block is NOT real (CDP's awaited Input.* resolves after propagation). **Build:** `installInputLock`/`removeInputLock` (cdp.js) — a VISUAL overlay (pointer-events:none) + banner + capture-phase listeners that swallow the operator's events when the `window.__apActing` COUNTER ≤ 0; the 4 primitives bump the counter ±1 (clear-after-dispatch); COUNTER (not bool) keeps the nested `cdpTypeChars→cdpKeyTap` correct; `inputLockActive` ⇒ non-lock runs pay nothing. Installed per-page in `fillAndPersistPage`, removed in the `runCdpFillPage`/`runCdpWalk` finally (no stuck lock). + a "NO input-lock (baseline)" popup button (oracle). **LIVE: NO self-block across all 3 input modes (clicks/insertText/the nested typeChars→keyTap path — dates+typeahead); lock blocked interference except ONE same-instant keystroke slip (caught by read-back → needs_review, never silent) vs the no-lock baseline letting 4 changes through.** HONEST: a strong DETERRENT+MITIGATION, NOT absolute — the ~ms same-instant window is unavoidable (where the bot's own key must pass); safety = defense-in-depth (lock blocks accidental interference; read-back/M40-audit catches the rare slip). 166 tests. See dom-patterns 2026-06-22. **WALK forward-note:** confirm/close the between-pages re-install gap when the first LOCKED walk runs.
- **AI-0: multi-provider LLM adapter + `act.llm` seam — live-verified (committed `6ccd1ac`).** `llm.js` (`callLLM` + Anthropic/Gemini/OpenAI builders/parsers, NEVER throws; `LLM_MODELS` curated per-provider lists → popup **dropdown**, default = first entry); `manifest.json` host_permissions for the 3 hosts; `RUN_LLM_TEST` (direct SW fetch, no attach); `cdp.js` `act.llm` + `act.aiEnabled` (opt-in enforced); `background.js` `getLlmConfig` threaded into `runCdpFillPage`/`runCdpWalk`; popup config (provider/model-dropdown/key + toggle + Test-connection). 9 `llm.js` unit tests (fake fetch). Live: Test-connection ✓ on the flash-lite models (a stale default model was the 429 → verified the current Google model list). See the AI feature section.
- **AI-1: AI fill for screening-question dropdowns — always-guess + confidence + justification, live-verified (committed `4ed3b6b`).** `aiFillField` (fill-driver.js): the gated dispatch post-pass answers an unmapped/unmatched screening dropdown via `act.llm` (profile+question+options → choose one + a SHORT basis-naming justification + High/Medium/Low confidence), the choice cleared through the **match ladder** (never blind-commit), committed + read-back + M39 persistence, ALWAYS `filled_review`. **ALWAYS-GUESS** — the UNKNOWN gate is dropped (required fields; a blank HALTS the walk; safety = the human gate + per-answer confidence). `closeAndVerifyBlank` = value-based blank (fixed a live false-stray: a slow-closing list + a reopen-toggle mislabeled a blank field a stray). Hard exclusions unit-pinned (prev-worker / file_upload / EEO / free-text + toggle-OFF → `act.llm` NEVER called); `legallyLoaded` → `ai-choice-sensitive`. Review surfacing: `flag` persisted, AI-confidence surfaced (`deriveConfidence`), **sensitive answers rendered FIRST with a red LEGALLY-LOADED badge — prominence off the FLAG, not confidence** + AI-INFERRED + the justification. Recon harness shipped (`reconDropdownDump` / `RUN_CDP_QUESTIONS_RECON` / `cdp-questions-recon`). Default model → `gemini-3.1-flash-lite`. **LIVE on Magna page 3:** all 4 (currently-Magna→No, eligible-Canada→No, over-18→Yes, criminal→No/Medium "inferred from absence") answered+flagged, M40 re-read all 4 + matched. 189 tests. See dom-patterns 2026-06-22 + the AI feature section.
- **AI-4: validation-error remediation + test harness — live-verified (committed `e383474`; dup-language Tier-0 live-PENDING).** Autonomous Save-&-Continue remediation in `runCdpWalk`'s nav-timeout branch (`remediatePageErrors`, background.js): **Tier-0** hardcoded duplicate-language delete-all (real-vs-phantom from the audited results — `isDuplicateLanguageError`/`languageEntriesFromResults`/`languageDeletionPlan`, lib.js) → **Tier-1** DETERMINISTIC re-fill of the MAPPED fields the error TEXT names (`mappedFieldsFromErrors` + the new `drivePageFill` `onlyFieldNames` filter — NO AI) → **Tier-2** AI last-resort (`aiRemediateError`, restricted whitelist refill/delete_entry/none, sanitized by `parseRemediation`). GLOBAL cap + halt-on-no-progress (`errorSetUnchanged`); every action recorded `ai-remediation`; the **double submit-guard untouched**. Harness `runCdpTestRemediation` (+ `cdp-test-ai4` fixable/unfixable popup buttons) clears a required field to stage an error (lock-immune, SW-driven). **LIVE on Magna:** fixable → Tier-1 deterministic re-fill (NO Gemini) advances; unfixable → clean no-progress halt. **LIVE-PENDING:** the dup-language Tier-0 hardcode is UNIT-COMPLETE only — the Workday phantom-dup bug wasn't reproducible to live-verify. See dom-patterns 2026-06-23.
- **Resume-under-lock + self-heal — live-verified (committed `e383474`).** Resume: the input-lock's capture blocker SWALLOWED `attachResume`'s synthetic delete-clicks (dispatchEvent, not the gated `cdpClickAt`) whenever `__apActing` was 0 → "removed 0, N remain"; bump `window.__apActing` around the attach (as the gated primitives do) → resume attaches under the walk's lock. Self-heal: `fillTextCdp`/`fillDateCompositeCdp` RETRY the fill on a read-back mismatch before flagging (`textFillAttempts`); the INLINE M40 audit re-fills once on a mismatch (`auditRefillEntry`) then re-reads (recovered → kept, still → `audit-mismatch`) — the standalone re-audit stays FLAG-ONLY (diagnostic). LIVE-VERIFIED (self-healed-on-attempt-2; the stray-"f" residue overwritten).
- **Fill latency — fast error-exit + CPP autocommit-close — live-verified (committed `ef9167f`).** `cdpWaitNextPage` early-exits a validation error (`errorMarkers` present + no advance, 2 reads → ~1s vs the 15s ceiling; safe — errors ⟺ won't-advance, a clean advance changes the sig). The CPP cert typeahead AUTOCOMMITS its pre-fill + CLOSES on the filter-Enter; the equal chip made `chipSetIsNew` false → the settle burned its budget + mislabeled a CORRECT value `needs_review` → new **`closed-commit`** settle outcome (a closed dropdown holding a chip is settled → classify the chip via the existing ladder → containment → `filled_review`, HONEST `autocommit-containment` flag + KEPT provenance, NOT overwrite-success; no disarm needed — already closed). Lockstep typeahead+source; the Round-2 `empty` outcome kept as a dormant backstop; a per-candidate **settle-trace** instrument (outcome/ms/count/open/chip in the SW log) pinned the diagnosis. ~8s→~1.8s, value intact, no stray (M40 matched). See dom-patterns 2026-06-23.
- **Summary option capture — FoS searchable typeahead + prefilled-kept dropdown options — live-verified.** The review summary can only EDIT a choice field whose bundle entry carries `options`; two gaps left them empty on a pre-filled re-run. **FoS typeahead:** only ever recorded `captured_options` (partial search matches); now its FULL list (65, curated) is scraped by `cdpScrapeTaOptions` (cdp.js) — an in-page, frame-paced, READ-ONLY scroll-accumulate over the VIRTUALIZED `[role=option]` list (220ms live; no type/Enter/arrow → nothing arms). **Prefilled-kept dropdowns** (M27.C zero-actuation): never opened → no options; now captured via `captureDropdownOptions` (`openAndReadDropdown` → enabled texts → `closeAndVerifyBlank` on the kept value). Both run in **`captureChoiceOptions`** (fill-driver.js) at END OF PAGE — after all fields settle/close (a fresh re-open shows the empty-filter full list), BEFORE the M40 audit (re-reads each value → backstops any stray). Inline attempts FAILED (scrape-before-fill scrolled the list + corrupted the keptLowerTier re-commit → "Religion" stray; scrape-immediately-after raced the post-commit state → empty). Cached per option-set key (same-vocab fields re-open ONCE). **Dropdowns scoped to REPEATING-section only** (`/\[\d+\]\./` fieldName) — flat page-1 dropdowns (country 250) are SKIPPED (the M27.C cold-list cost; they fill fresh WITH options anyway). Summary editor (summary.js): typeahead-with-full-options → a type-to-filter combobox (shows ALL matches, scrollable; focus/clear → whole list); dropdowns keep the `<select>` now populated from the captured `options`; M14 write-back unchanged. Recon harnesses kept (`RUN_CDP_FOS_RECON`/`RUN_CDP_FOS_CAPTURE` + buttons). **LIVE on Magna page 2:** FoS "Other" filled (no stray), full searchable list in the summary; degree/language/proficiency dropdowns show full options; M40 clean. 239 tests. See dom-patterns 2026-06-24.
- **FoS typeahead stray RESOLVED — the terminal-state GATE (`awaitListTerminal`) + the two-banner model — live-verified.** The FoS "Other"→"Economics"/"Accounting" stray (survived a settle-race round, an arming round, a between-candidate-settle round) is fixed by gating every typeahead action on a **CONFIRMED terminal render state** — banner OR autocommit, NEVER a bannerless list (the old `settleResults` banner-OR-count-steady was the wrong gate). **Read layer:** recon (`RUN_CDP_RESULTS_BANNER_RECON`) confirmed BOTH banners live on the SAME `data-automation-id="promptTitle"` DIV, text-distinguished — RESULTS = "Search Results" (NO count in the text), NO-MATCH = "No matches found"; the no-match state carries a NON-ZERO (~15) fallback list + the aria-controls count reads 0 (options portaled to the doc root) so the BANNER is the only terminal signal + the count comes from `pageWide.count`. Added `resultsBanner` (`promptTitle` `/search results/i`) to `cdpReadTaState`/`cdpReadSourcePick`. **`awaitListTerminal(act, readFn, loc, budgets, chipSetIsNew)`** (fill-driver.js) → `"autocommit"` (new chip / box-closed-with-chip, first) | `"nomatch"` (no-match banner + count stable) | `"results"` (results banner + count>0 stable) | `"timeout"`; a bannerless non-zero list and `count===0`-no-banner are NOT terminal (keep polling); the echo (`pollSearchValue`) is never the render signal. Gates the **post-type match (ONLY on `"results"`)**, the between-candidates transition, and the recommit; the initial recon-scrape open is gated by `awaitListStable` (shorter `taOpenCeilingMs`). Retired `settleResults`/`taBannerGraceMs`. **Typeahead+source LOCKSTEP.** **Trade-off:** a NO-banner-tenant no-match now times out (Magna shows the banner → fast; a per-tier `"timeout"` is the latency smell). **LIVE-VERIFIED (Magna page-2, VISIBLE, many runs, no stray):** empty FoS → `directed-exact` "Other" (the live no-match→match walk); pre-filled "Other" → `prefilled-better-tier-unavailable`; pre-filled mismatch → `overwrite-success` (`filled_review`); full-page fill + summary correct. Also **dropped the `cdpWaitHidden` "MINIMIZE NOW" gate** from the page-2 section fills (education/websites/languages/work-experience/certifications/date) — they fill VISIBLE=fast or minimized=slow, adapting live (M39). The during-fill option capture (2026-06-24/25) was never the cause and runs fine. 256 tests. See dom-patterns 2026-06-26.
- **Typeahead exit redesign — Tab-blur, the disarm fallacy DELETED (BUILT, unit-green; live-verify PENDING).** The FoS "Other"→"Accounting" stray's TRUE root cause: the exit/disarm code rested on a FALSE DOM assumption. Operator recon (Magna FoS, 2026-06-26) corrected the model with three facts: (1) **re-focusing the searchBox does NOT clear the armed row-0 highlight** — the armed row only changes by typing a new non-empty query, so `disarmHighlight` (re-focus + poll `activeText`→null) was structurally a NO-OP that either burned the ceiling or exited on a transient null and LIED; (2) **`""` + Enter is a no-op** (clearing + Enter leaves banner/list/armed-row intact — clearing is valid ONLY as delete-old-text-before-the-next-query); (3) **Tab is the ONLY clean non-committing exit** — Enter commits the armed row, Escape hides the popup but KEEPS focus + the armed row (so the next field's focus blur-commits the stray), Tab blurs + abandons it. **Fix (minimal, typeahead+source LOCKSTEP — Tab is the UNIVERSAL non-commit close; dropdowns keep Escape):** added `act.pressTab` (cdp.js, counter-gated like the other key taps); **DELETED `disarmHighlight`**; **EVERY non-commit exit Tab-blurs** (a commit closes the list itself): the honesty-read exits via the shared `tabBlurExit(act, loc, readFn)` (Tab → read resting chips — `overwriteNoMatchResting` plain path + the typeahead/source empty-field exits), the **early bails** (`could-not-focus` / `could-not-type`, both handlers) via a bare `await act.pressTab()` before their `needs_review` return, and the read-only `captureFieldOptions` close via bare `act.pressTab`. **The early bails were the live gap:** a prior candidate's no-match ARMS row-0, then a LATE candidate's focus drops (the documented post-banner focus loss) → the bail returned WITHOUT blurring → the armed "Accounting" strayed (this is what the user's "walk exhausted, strays Accounting" actually was). Dropped the now-unused `clearFn` param from `overwriteNoMatchResting` + both call sites. The stray-backstop (post-exit chip ≠ original → `overwrite-stray`), the `overwrite-nomatch-original-kept` keep, the empty-field honesty read + `genuineNoMatch`, the commit ladder, and the keptLowerTier `recommitFn` (already disarm-free) are UNCHANGED. Commit exits untouched (the commit already closed the list). `activeText` KEPT in `cdpReadTaState`/`cdpReadSourcePick` (the recon harnesses still read it). 256 tests green (overwrite/stray/walk-dry/capture + both focus-cannot-confirm bails + the could-not-type bail assert Tab-exit; no net new). **Supersedes the disarm mechanism from the keptLowerTier-stray (2026-06-22) + the disarm note in the FoS-terminal entry.** **LIVE-VERIFIED:** the OVERWRITE no-match case (pre-filled "Other" → genuine no-match → stays "Other", no stray). ⚠ **HARD GATE — the typeahead filler must be live-verified correct before the parked AI typeahead fallback resumes;** the remaining live check is the EMPTY-field / early-bail case: an empty FoS whose walk arms row-0 then exhausts or bails (focus drops after a banner) must end BLANK, no "Accounting" stray; the in-list-value + clean-overwrite + keptLowerTier-recommit regressions still commit; no-match exits go instant (no useless disarm poll). See dom-patterns 2026-06-26.
- **AI typeahead fallback (FoS headline) + EEO retraction — BUILT, unit-green (274 tests); LIVE-VERIFY PENDING (operator verifies next session; committed unverified by request).** Fulfills the parked "AI picks from the captured list on a typeahead no-match" for FLAT typeaheads. When a typeahead ends a GENUINE no-match (`fillTypeaheadCdp` `genuineNoMatch`, OR a pre-filled `overwrite-nomatch-original-kept` — the "future-AI candidate") the new AI pass hands the captured option list + profile to `act.llm` and commits its pick by RE-ENTERING `fillTypeaheadCdp(loc,[target])` (the proven empty/overwrite path, NOT clear-first), ALWAYS `filled_review`. fill-driver.js helpers: `parseAiTypeaheadReply` (`{choice,represented,confidence}`, `represented` defaults FALSE), `aiTypeaheadEligible` (pure), `aiTypeaheadFallback` (decision tree), `commitAiTypeahead` (anti-hallucination `matchCandidates` + verify), `nearestOption` (argmax `fuzzyRatio`, NO threshold), and the extracted `runAiTypeaheadPass` (SHARED by `drivePageFill` + the education harness). **Decision tree:** only-"Other" → "Other" (NO LLM, `ai-other-only`); represented → pick (`ai-choice`); !represented + "Other" → "Other" (`ai-choice-other`); !represented + no "Other" + REQUIRED → forced nearest (`ai-closest-forced`, super-hard — NEVER declines: a blank required HALTS the walk); !represented + no "Other" + optional → `ai-typeahead-decline` (blank ok). **Tree exclusion (0.4 LIVE recon, `RUN_CDP_TREE_RECON`/`cdp-tree-recon`, kept):** cert is a TREE mis-tagged "typeahead" (chevron `menuItem` category rows on open; FoS/countryPhoneCode flat = 0 category rows) → excluded by a cert name-belt + the structural `act.isTreePicker` (`rows.some(isCategory)` via `cdpReadSourceState`); source excluded by widgetType "hierarchical". **Prompt tuned:** a clear parent/child/sibling discipline = represented=true (ECE→"Electrical Engineering"). **Delete-vs-AI defer** (`driveRepeatingSectionCdp`): an entry of all-AI-rescuable typeaheads isn't deleted when AI on (dormant — cert excluded, languages=dropdown). **summary.js super-hard tier** (`ai-closest-forced` + low-confidence AI → loudest badge, rendered FIRST). **EEO RETRACTION (operator decision):** the "never AI-guess EEO" rule REMOVED from `aiEligible` + `aiTypeaheadEligible` — EEO (gender/race/veteran/disability/…) now fills via the SAME AI inference as any field, re-tagged `ai-eeo-guess` at the call site for the loud "AI-GUESSED DEMOGRAPHIC — VERIFY" badge; `isEeoField` is now a detector not a blocker; a STATED demographic still fills deterministically (AI never overrides it); `aiInferEeoField` confidence-gated path kept ONLY for the mapped-but-empty REQUIRED EEO dropdown corner. **LIVE-VERIFY PENDING:** FoS ECE→"Electrical Engineering"/`ai-choice` (education button or full page), cert SKIPPED (`ai-tree-excluded`/name-belt), AI-OFF byte-identical, EEO page fills + `ai-eeo-guess` badge. 274 tests.
- **AI typeahead fallback — LIVE-VERIFIED + moved INLINE (Option B) + debug input-trace.** The prior entry's fallback is **live-verified** (Magna page-2: profile FoS `["Electrical and Computer Engineering"]` → deterministic no-match → AI → **"Electrical Engineering" / `ai-choice` / `filled_review`**, M40 clean, cert skipped). Then, per operator request, the rescue moved from the end-of-page `runAiTypeaheadPass` to **INLINE inside `fillTypeaheadCdp`** at the genuine no-match exits (both overwrite + empty): if `opts.ai` is present (the call site passes it for AI-eligible typeaheads) and AI is on, `tryInlineAi` runs `aiTypeaheadFallback` and **commits the pick ON THE STILL-OPEN FIELD — no Tab-abandon, no re-open** (the commit re-enters `fillTypeaheadCdp(loc,[target])` WITHOUT `opts.ai` → no recursion; the open field is reused via the proven focus-safe re-type). `onCapture` now RETURNS the scraped options so the inline AI has the full list; `profile`/`jobContext` threaded through `driveRepeatingSectionCdp`→`fillEntryCdp` (`section.aiContext`) + the flat loop. **Cert (a TREE) is routed to the two-prompt `aiTreeFallback`** by `tryInlineAi`'s structural `readTreeCategories(loc)>0` check on the open field — NOT the flat fallback (the `act.isTreePicker` discriminator + `runAiTypeaheadPass`/the `aiTypeaheadEligible` cert name-belt are retained only for unit tests; there is NO live section-name exclusion — see the cert tree-drill entry below). The end-of-page pass is removed. **Debug input-trace (`cdp.js`):** every trusted input logs `[ApplyPilot][INPUT]` (click / triple-click / key / insertText) via the 4 primitives (`cdpClickAt`/`cdpTripleClickAt`/`cdpKeyTap`/`cdpInsertText`) — a keystroke-by-keystroke replay for debugging. 281 tests (inline-rescue + cert-section-exclusion + no-Tab-on-commit assertions; the obsolete isTreePicker-orchestration test replaced).
- **Source tree-drill AI — LIVE-VERIFIED (the parked SOURCE half of the tree-AI fallback).** When the deterministic `fillSourceCdp` walk genuinely no-matches (AI on), `tryInlineAiSource` runs a TWO-PROMPT category→leaf drill on the "How did you hear about us?" picker: `scrapeSourceRows` scroll-enumerate categories → Prompt 1 → DRILL → scroll-enumerate leaves → Prompt 2 → typed commit, ALWAYS `filled_review`/`ai-choice` (`ai-eeo-guess` if EEO). **The decisive bug (operator browser-diag):** the AI-chosen category row is **react-virtualized + rendered BELOW the viewport fold**, and CDP clicks at VIEWPORT coords (`cy > innerHeight` = dead space), so the old coordinate click hit empty space + never drilled — fixed in `cdpSourceRowRect` by `scrollIntoView`-ing the **`promptLeafNode`** (the node with the onClick/DRILL handler — NOT the `menuItem` role=option nor the `promptOption` text) into the visible viewport (scrolls the PAGE + ancestors), re-querying after each settle (recycle-safe), and **`document.elementFromPoint` validation before the trusted click**. Two dead ends disproven: the synthetic `dispatchEvent` click never drilled (handler needs a trusted event); a 40-step scroll loop risked the eval timeout. **Commit (operator recipe, simplified):** directly on the still-open field — **focus → Ctrl+A+Delete → type the leaf → Enter** (autocommit a unique match / click the TOP on a multi-tree tie); the `fillSourceCdp([leaf])` re-entry was dropped (its `openSource` re-opened + disturbed the settled view), and the settle-wait/second-focus were dropped (one focus → clear → type lands the value). Profile-driven candidates (`profile.how_did_you_hear` WINS → `defaults.how_did_you_hear` fallback). Isolated harness: popup "Source AI (isolated)" (`RUN_CDP_SOURCE_AI_DEBUG`). **LIVE-VERIFIED on Magna** (carrier-pigeon profile → deterministic no-match → AI category drill → leaf pick → typed commit). 298 tests. See dom-patterns 2026-06-28.
- **Cert tree-drill AI — BUILT, unit-green (300 tests); LIVE-VERIFY PENDING (operator verifies next session).** The last tree-AI piece — cert is a TREE like source, and most of it was already in place: `tryInlineAi` routes a cert no-match to the two-prompt `aiTreeFallback` (category→drill→leaf) via the structural `readTreeCategories>0` check, and `fillEntryCdp` already passes `opts.ai` for EVERY section typeahead (no live section-name exclusion ever existed — the old "excluded" test/`aiTypeaheadEligible` name-belt only gated the test-only `runAiTypeaheadPass`, and that test passed only because a bannerless no-match has no options for the flat fallback). **The one real fix:** the leaf COMMIT was viewport-blind (`clickSourceLeaf` = single read + immediate rect → MISSES an off-fold leaf, the same below-the-fold bug fixed for the category click), now committed via the new viewport-aware **`act.clickTreeLeaf`** (cdp.js — reuses `cdpSourceRowRect`: scroll the leaf's `promptLeafNode` into the clickable viewport + `elementFromPoint`-validate + trusted click; `clickSourceLeaf` left untouched for the source fallback). Also threaded `getLlmConfig()`+`aiContext` into `runCdpFillCertifications` so the `cdp-fill-certifications` button isolate-tests cert AI. Stale "excluded by section name" test repurposed to an honest negative; the dead name-belt (`aiTypeaheadEligible`) left as a tiny follow-up. 300 tests (+2 cert tree integration: confident→KEPT, forced-low→DELETED; +`makeFakeRepeatAct` tree seams; `makeFakeTreeAct` `clickSourceLeaf`→`clickTreeLeaf`). **LIVE-VERIFY:** bogus cert name → no-match → `aiTreeFallback` drills + commits the off-fold leaf via `clickTreeLeaf` (chip verified, M40 clean, entry KEPT); real cert ("CPP") still deterministic; AI-OFF byte-identical. See dom-patterns 2026-06-28.
- **Merge → ONE hierarchical-typeahead filler (cert + source + FoS) + source-AI hardening + required-empty fill — LIVE-VERIFIED, committed `ad1b34c`.** Cert typeahead and "How did you hear about us?" are the SAME Workday multiselect widget (operator recon, supersedes the earlier "two slightly-wrong recons") → collapsed `fillSourceCdp` INTO `fillTypeaheadCdp`: ONE reader (`cdpReadHierState` — `promptOption`/`data-automation-label`, scoped by `data-uxi-multiselect-id`, `promptLeafNode`-isselected; `aria-controls` was null on both), ONE click-by-label FIRST-match commit (handles the "two Other leaves" tie + off-fold via `cdpSourceRowRect`), ONE type-commit TREE drill (`aiTreeDrillFallback`) for source + cert + generic trees — RETIRED the cert-only `clickTreeLeaf` commit + the separate `aiTreeFallback`/`tryInlineAiSource`. Source routes through `fillTypeaheadCdp` (a `fillSourceCdp` alias kept for the recon harnesses); the `m.targetIndex===0` commit gate dropped; the `isCategory` side-charm-svg "fix" REVERTED (it broke cert/source category detection — these ARE drillable trees, the chevron observation was right). **Fix 2 (scrape timing):** FLAT typeaheads scrape options ONCE at the START (`makeStartCapture` → the review page + the flat AI, no AI-stage scrape); TREES are NOT start-scraped (a cheap `readTreeCategories` detect, no scroll → no wasted scroll on a successful fill). **Source/cert AI drill (restored + hardened):** CLICK-drill the AI-chosen category (typing a category filters to NOTHING — it must be clicked) → scrape leaves → AI leaf → TYPE-commit; the commit DETECTS no-autocommit (Workday won't auto-pick a multi-result "Search Results (2): Other / Others") → escalates click-the-exact-leaf / Enter-AGAIN, gated so the committed chip normalize-EQUALS the AI's leaf (a stray "Others" → `ai-commit-failed`, never a false fill); FAST-EXIT on results-rendered-no-chip (no 10s autocommit wait — `settleCommit`); SKIP the re-commit + Tab-close when the field already holds the AI's leaf. **AI prompts pass the STATED answer (the candidates) NOT the whole profile** when one exists (`statedAnswerBlock`) — saves tokens + MATCHES a typo ("Otherrr"→"Other") instead of inferring an unrelated profile fact ("Carnegie Mellon"); falls back to the profile only when there is no stated answer (e.g. EEO). **Required-EMPTY typeahead AI-fill:** a REQUIRED typeahead / FoS with no profile value is no longer left `skipped` (which BLOCKS Save & Continue) — when AI is on it runs the filler with NO candidates → profile-inference + a FORCED pick + flag (flat loop AND `fillEntryCdp`; AI OFF or OPTIONAL → stays `skipped`). 315 unit tests; live-verified on Magna. See dom-patterns 2026-06-29.
- **Plan 2 — review-summary page-scoping/accumulation + approve/merge + editable-everything — BUILT, unit-green (347 tests); LIVE-VERIFY PENDING (operator verifies next session).** Three parts on the review summary. **(1) Page keying:** separated the stable MERGE key (`page`, field-set) from DISPLAY — added `page_number` (the walk's 1..N ordinal) + `page_label`; the viewer ORDERS pages by `page_number` and CAPTIONS by `page_label`/`cleanPageName` (no more raw composite key in the UI), fixing the accumulate-reorder. Brought the **page-engine path** (`buildEntry`/`runWalk`) onto the SAME field-set key + PAGE-QUALIFIED `field_id` + clear-once-at-start + `persistAccumulated` (was overwrite-per-page) — the actual fix for "My-Experience shows under page 1" (pageId is shared across pages — the M31 lesson). SW stamps `page_number` per page (the engine doesn't know the ordinal). Schema → **"1.1"** (viewer tolerates 1.0; new fields default). **(2) Approve/merge:** per-entry `is_approved`/`approved_at` (default false) + the new pure `summary-lib.js` (`effectiveValue`/`approvalEnvelope`/`submitReady` — the seam the future SUBMIT/Plan 1 reads). UI: per-flagged-row Approve toggle (un-flagged = approved-by-default), header progress + "Approve all reviewed", a disabled-until-`submit_ready` "Approve & continue to submit" that does NOT submit; a VALUE edit RESETS that field's approval. `submit_ready` = all flagged approved AND no unreplaced AI placeholder; soft-deleted excluded. **(3) Editable text/radio/checkbox:** closed the gaps (radio-without-options → text box + partial-note) + moved `editKindOf`/`tokenFor`/`checkedOf` into the requireable `summary-lib.js` with the first-ever summary tests (`test/summary.test.js`). 347 tests (+ Plan-2 buildReviewBundle/accumulate page_number+approval-survival + the whole summary-lib suite). **LIVE-VERIFY PENDING:** CDP walk on Magna → both pages under DISTINCT "Page N" captions; edit a prior-page field, persist a later page, the edit + approval survive; the approve flow toggles the submit button; the page-engine walk (LiveRamp) no longer collapses My-Experience under page 1.
- **Plan 2 follow-ons — "I currently work here" To-box handling + review UX — BUILT, unit-green (355 tests); LIVE-VERIFY PENDING.** Three small changes. **(a) Review approve-inline:** the per-flagged-row Approve toggle now sits BESIDE the editor (a `.ved` flex line), not below — less vertical space. **(b) Review mirrors the form's "I currently work here":** `summary-lib.js` `isCurrentlyWorkHere`/`isWorkExpEndDate`/`visibleEntryItems` — when an entry's currentlyWorkHere checkbox is CHECKED the viewer HIDES that entry's "To" (endDate) row (toggling re-renders); a FLAGGED endDate (the today-fallback below) is KEPT visible so it can't be hidden unverified. **(c) Form safety — stuck-required To fallback:** `fillEntryCdp` no longer blind-skips WE `endDate` on `currently_work_here` — `todayIfStuckRequired` re-scans, and if the To box did NOT disappear AND is still required (would block Save & Continue), fills **TODAY's date** (`todayYMD` → M/D/Y composite), `filled_review`/`we-currentwork-today` (M40 re-verifies via auditLoc); box removed or optional → the original zero-actuation skip (one scan, no added happy-path latency). 355 tests (+3 WE today-fallback present-required/optional/absent, +5 summary-lib WE-visibility). LIVE-VERIFY: a WE entry with "currently work here" checked → To row hidden in review; on a tenant where the To box stays required, it fills today's date + flags.
- **Cascade re-scan (M1) + cascade-removed + optional→deterministic-only gate + tier-aware dropdown + preferred-name cascade — LIVE-VERIFIED on main (366 tests).** Submit-prep + operator-reported page-1 fixes, mostly in `fill-driver.js` (the FIELD_MAP adds are lockstep in `background.js` too; the AI/cascade logic has no `background.js` lockstep — `fillEngine` has no AI). **(1) M1 cascade RE-SCAN-after-change** (`drivePageFill`, after the fold): a committed value can REVEAL new fields (Magna recon: Country=Afghanistan → 2 "Cyrillic name" text fields ~5.6s later, + HID "State"). Re-scan + fill any NEW flat field through the IDENTICAL onlyFieldNames ladder, tagged `cascadeRevealed`. BYTE-IDENTICAL when nothing's revealed (one read-only `act.scanPage()`, NO fixed wait — the ~5.6s latency is absorbed by the fill work that ran after the trigger), `maxCascadeRounds` backstop, skipped under `onlyFieldNames`. **(2) Cascade-REMOVED fields** (new reconciliation pass, after the cascade block, before the audit): a field in the up-front scan but GONE from a fresh `act.scanPage()` (deleted by an earlier value — e.g. State, removed by Country=Afghanistan) was recording a MISLEADING `needs_review` "options did not render"; now reclassified `status:"removed"`/`flag:"cascade-removed"` → `buildReviewBundle` filters `status !== "removed"` so it DROPS from the summary/counts/review entirely (NOT an error). DOM-absence is the signal (a still-present failed field stays flagged); guard: only relabel if the rescan returns a non-empty field list (filled/filled_review excluded → that's the M40 audit's `audit-unverifiable` job). **(3) Optional → deterministic-only** (`f.isRequired && aiEligible(f)` on the INFER branch): only REQUIRED unmapped dropdown/text/typeahead get an AI fallback; OPTIONAL ones (incl. the cascade-revealed Local-Name fields + optional EEO) fill deterministically and are left BLANK — no LLM call (a blank optional doesn't block Save & Continue). Canonicalize + inline-typeahead AI (operate on a STATED value) unchanged. **(4) Tier-aware dropdown pre-filled guard** (`fillDropdownCdp`): the keep was priority-BLIND (kept a pre-fill matching ANY candidate), so a lower-tier pre-fill blocked the top choice (country left on "United States of America" when tier-0 was "Afghanistan"). Now mirrors M36.1's typeahead guard: keep zero-actuation ONLY if the pre-fill is tier-0; `k>0` re-opens + overwrites to the HIGHEST offered tier (`dropdown-overwrite-success`) else keeps best-available (`dropdown-prefilled-better-tier-unavailable`); `k===-1` full walk. Re-opens the cold list ONLY when an upgrade is possible. **(5) Preferred-name cascade mapping** (FIELD_MAP, lockstep both copies): `preferredCheck → personal_info.has_preferred_name` (true CHECKS the "I have a preferred name" box → reveals `preferredName--firstName`/`--lastName`), and those two → `personal_info.preferred_first_name`/`preferred_last_name` → the M1 cascade re-scan fills them deterministically (mapped ⇒ no AI, even though optional). **LIVE-VERIFIED on Magna page 1:** country→"Afghanistan" overwrite (`dropdown-overwrite-success`); `countryRegion`→`removed` (dropped from review, console `counts` only); Local-Name fields blank (optional, zero LLM); `has_preferred_name:true` → box checked → "John"/"Doe" filled via the cascade. 366 tests (4 optional-AI → no-AI/blank; +required-vs-optional regression; +cascade-removed; +tier-aware-dropdown ×3; +preferredCheck-map + revealed-fields-fill). **DO NOT touch `data/profile.json`** (it's gitignored — operator-managed; `country:["Afghanistan",…]` is intentional test data). **DEFERRED (separate worktree): required-radio AI fallback** — mirror the dropdown AI-1 pattern; safety reversal: even `candidateIsPreviousWorker` must be AI-guessed to REACH review then flagged HARD (not left blank). See `ai-fallback-coverage.md`.
- **AI-4 remediation gaps from the live specialty halt — error-banner split + Tier-1.5 section re-fill + nested N=0 reconcile — BUILT, unit-green (432 tests); LIVE-VERIFY PENDING.** The 2026-07-01 walk halt (specialty-required + dup-language errors, remediation `no-action`) exposed three stacked gaps (dom-patterns 2026-07-01). **(1) Error samples un-truncated + SPLIT:** Workday's top summary banner concatenates EVERY error into ONE element and the M31 `errorMarkers.samples` read sliced it at 120 chars — samples became AI-4 DECISION inputs, so errors past the first ~2 were INVISIBLE to the tiers (the Tier-0 dup-language hardcode never fired on a banner that plainly contained its error). Fix: `cdpReadSessionState` slice → 600 (cdp.js) + **`expandErrorSamples`** (lib.js, pure) splits samples on the `Error-` prefix + drops `[role=alert]` success toasts ("resume successfully uploaded" was counted as 2 of the "4 errors"); applied in `remediatePageErrors` (tier triggers, AI prompt, no-progress compare) + `reportPageErrors`. The `cdpWaitNextPage` fast-exit COUNT is unchanged. **(2) Tier 1.5 — deterministic SECTION re-fill:** an error naming a section field (the nested cert "Specialty" — excluded from the flat scan by `isRepeating`, not in FIELD_MAP; Tier 2's AI correctly named `specialtyParent` but its executor's flat-scan lookup skipped "not on the page") now maps to its OWNING section via **`sectionsFromErrorNames`** (fill-driver.js: heading regex / fieldMap labelRegex / camelCase field words / nested sub-section labels; "Specialty ()" empty-parens normalized) → re-runs JUST those sections via the new **`drivePageFill({onlySections})`** mode (flat loop skipped; reconcile-to-N + re-fill incl. nested; same targeted-mode skips as `onlyFieldNames`; records flagged `ai-remediation`, `filled`→`filled_review`). Sits between Tier 1 and Tier 2. **(3) Nested reconcile at N=0:** `fillNestedSpecialtiesCdp`'s `!N` early-return never deleted orphan EMPTY specialty rows when the profile cert has no specialties (an empty REQUIRED specialtyParent blocks Save & Continue — this walk's actual blocker, the recon-mounted leftovers); the call site now ALWAYS invokes the nested fill and reconcile-DOWN runs at N=0 (M21 reconcile-to-exactly-N semantics) — the walk's "clear orphan specialties first" PREREQ log is retired. 432 tests (+8: banner split / Tier-0-regression-detected / toast-drop; sectionsFromErrorNames routes; onlySections drives-only-named + zero-actuation-on-unnamed; nested N=0 standalone + wire). **LIVE-VERIFY:** re-run the blocked Magna walk — orphan specialties auto-deleted during the cert fill; on a still-blocked page Tier-0 deletes the dup languages and/or Tier-1.5 re-runs certification (watch for `(Tier 0` / `(Tier 1.5` in the [CDP-WALK] log).
- **AI-4 round 2 — never-act-blind gate + Tier-1.5 DELETE for empty repeating rows + preserveExtras re-fill — LIVE-VERIFIED (440 tests).** The second live remediation run (operator staged an EMPTY extra Specialty row) exposed the blind-action hole and settled the refill-vs-delete rule (dom-patterns 2026-07-02). **(1) Never act blind:** the error banner renders LATER than the ~1s fast-exit, so remediation entered with "0 error(s)" and Tier 2's AI — nothing to anchor on — blind-deleted the correctly-filled cert entry (the cascade's first domino). `remediatePageErrors` now POLLS for the banner (500ms×8) and HARD-GATES every attempt on non-empty expanded error text (`no-error-text` / `errors-cleared-not-advancing` clean halts — the AI can never fire without an error to anchor on); `cdpWaitNextPage`'s fast-exit counts EXPANDED errors (raw markers include `[role=alert]` success toasts). **(2) The ladder is now Tier 0 dup-language → Tier 1 flat re-fill → Tier 1.5 DELETE → Tier 1.6 section re-fill → Tier 2 AI.** Tier 1.5 (operator rule: repeating ⇒ optional ⇒ a blocking row with nothing to refill gets DELETED, and a layer-2 error deletes ONLY layer-2 rows): `deleteTargetsFromErrorNames` maps error-named titles to repeating-section fields; `deleteEmptyErrorRows` deletes every row whose named field reads EMPTY on the live page (a hand-FILLED row never reads empty → never deleted); a NESTED name deletes ONLY the inner rows (cert ▸ specialties) — the parent entry is never touched; an unresolvable nested probe leaves the row UNTOUCHED (never blind). **(3) Tier 1.6 `preserveExtras`:** the remediation section re-fill NEVER reconciles DOWN (top-level `driveRepeatingSectionCdp` + nested `fillNestedSpecialtiesCdp` skips) so manually-added entries survive a remediation pass; the MAIN fill's M21 reconcile-to-exactly-N is unchanged. 440 tests (+6: target routing incl. ambiguous both-fire, top-level empty-only delete, nested layer-2-only + parent-untouched, unreadable-probe untouched, preserveExtras top-level + nested). **LIVE-VERIFIED on Magna (2026-07-02):** a staged empty extra Specialty row → the walk's `(Tier 1.5, deterministic DELETE)` removed JUST that row and the page advanced — cert entry + filled specialty intact.
- **Generic sections in review (m3a/m3b) + review-UX round — LIVE-VERIFIED (2026-06-30→07-01).** The review can now represent ANY repeating section, known or not. **m3a:** UNKNOWN sections (present on the form, not in PAGE_SECTIONS) surface with every existing entry's fields + CURRENT values flagged **`already-filled`** ("on the form — NOT filled by ApplyPilot"; empty-optional → unflagged skip, empty-required → needs_review) + an addable **section stub** carrying the DOM-detected `section_field_shape` (options/date_order recon'd → real widgets in the editor, not text boxes). **m3b:** an EMPTY unknown section (Add button + heading, no containers) is revealed-by-add ONCE per bundle-lifetime (mount → read shape → delete → stub; cached via `section_shapes`/heading). Review UX: approve-by-SECTION, multi-file attachment picker, required-EMPTY fields refuse approval (with an explanatory note), the type-to-filter combobox `position:fixed` (no clipping at the page bottom). Also recorded: the Workday **maintenance page** observation (`isWorkdayMaintenance` detects it; a start-of-fill gate is a recorded TODO — dom-patterns 2026-07-01).
- **Nested cert Specialties FILL — DONE (the deferred milestone) — LIVE-VERIFIED (CPP + "otherrrr"→AI→"Other").** `CERT_NESTED.fieldMap` + **`fillNestedSpecialtiesCdp`**: reconcile the child rows to N (per-cert-entry-scoped Add/Delete; N=0 deletes orphans), fill `specialtyParent` (typeahead + the inline AI — a typo'd stated answer maps to its option) + M/D/Y dates via the proven per-widget handlers, records nested-canonical (`certification[i].specialties[j].*`) + grouped under the parent in review. **The wrapper-selector lesson:** the fkit ↔ formField relationship is TENANT-VARIABLE (the composed descendant selector failed live) → **`cdpNestedFieldSel`** probes the live DOM per field and returns whichever single suffix-composable selector resolves (descendant / same-node / `:has()` / element-id) — nothing hardcoded, all indices runtime-scanned. **Proactive nested deleteOnNoMatch:** a child row whose REQUIRED pick ends BLANK on a definitive negative (genuine no-match / failed AI) is deleted at fill time (value-holders + transients NEVER deleted; preserveExtras skips; the stub notes "N rows REMOVED"). **Per-cert TEST résumé attach** (`attach_resume` profile flag + the `act.attachStoredResume` SW seam): verified live, then **REMOVED with its test data** (2026-07-02, operator request) — per-entry attachments are the operator's (form / review picker); the résumé only ever attaches to the top-level Documents field (a regression test pins that even a stale flag + seam stay inert).
- **Summary = the page's SOURCE OF TRUTH — LIVE-VERIFIED.** Three stacked layers. **(1) The already-filled SWEEP** (`sweepAlreadyFilled`, the LAST pass in `drivePageFill` — after cascade fills, option capture, and the M40 audit): any `skipped` record whose field HOLDS a live value flips to `already-filled` (needs_review; `already-filled-match` unflagged when it equals the profile value); unmapped section fields with values get NEW records; nested records re-read via their probed `auditLoc`; both flags are AUDIT-EXCLUDED (never re-actuated — the fluent-checkbox lesson). `cdpPageScan`/`cdpRepeatingScan` capture live values (empty date segments show "MM/DD/YYYY" placeholders — filtered). Viewer: a gray **PRE-POPULATED** badge + a note on every view; a FLAGGED row's detail note shows in the physical section too. **(2) `current_value` for ANY status** — `after` is only ever a live page value, so a needs_review kept-original renders IN the field, not as an empty box (and becomes approvable). **(3) Pre-advance TRUTH recon** (`reconPageTruth`, before EVERY remediation re-Save&Continue): deleted rows drop, index-shifted survivors refresh to the live value (`recon-mismatch`), nested rows existence-checked via `act.selExists`; AI-4's synthetic "workaround" rows (`widgetType:"remediation"`) are FILTERED from the bundle — the summary shows exactly what is on the page at each click, the latest recon overriding earlier persists. **Honesty fix:** a FAILED inline-AI rescue (needs_review, after:null) never masks a live chip — the resting read reports the kept original with "AI rescue failed: …" appended (a genuinely blank field keeps the AI record + its flag).
- **Fill in DOM order — LIVE-VERIFIED (sections + entry fields); full interleave REVERTED (operator risk call).** `sectionsInDomOrder`: sections drive in PAGE order (a section's non-nested Add button index in the document-order addButtons IS its position); `fillEntryCdp` iterates the ENTRY'S scanned fields top-to-bottom mapped back to the config (Languages: language → "I am fluent" → proficiencies, as the form lays out; unscanned map entries run after, `waitForPresence`/`skipWhen` unchanged; assumption: a controlling checkbox precedes what it controls — true on every observed tenant). The cert attachment fills in-section. The flat↔section INTERLEAVE (résumé at its exact page position) was built then **REVERTED** (`dee4c5b`→`5bc38b5`) — restructuring the battle-tested flat loop wasn't worth the résumé's position; it attaches at the end via the proven post-pass (which now excludes `nested-attachment` records from its patch target).
- **Phantom empty specialty + the shape leaks — LIVE-VERIFIED (452 tests).** Three stacked bugs from the same fact (nested specialty fields live INSIDE the cert `--null` container). **(1) m3b clicked the nested Specialties Add** (page-wide addButtons, unknown heading, no `--null` container → passed every guard; the mounted row was invisible to the reveal's prefix/grown detection → left behind, re-fired every fill) → addButtons now carry **`insideEntry`** (any `-<digits>--` fkit ancestor — the isRepeating idiom) and m3b skips them; `revealUnknownSection` gained a nestedScan-diff backstop that deletes whatever a mis-click mounts. **(2) The add-entry shape leak:** `detectSectionShapes` (the ORIGINAL-state pre-fill scan, persisted as `section_shapes` for the viewer's "+ Add entry") and `captureDetectedShape` (the emptied-section stub) swallowed the mounted specialty fields + the Attachments wrapper → both now exclude a known section's nested child names, its attachments input, and ANY empty-fieldName wrapper (LOCKSTEP). **(3) The classifier gap:** `cdpRepeatingScan.classify` lacked the `file_upload` rung (an attachments input typed "unknown" evaded every exclusion → the text-box "Attachments" row) + the `selectinput` rung (Magna's specialty typeahead has no "multiselect" node) — added LOCKSTEP with cdpPageScan/cdpGenericNestedScan.
- **keptLowerTier Tab-closes — the affirmative re-commit RETIRED (operator speed rule; 452 tests).** The kept pre-fill is ALREADY correctly committed, and the Tab-blur exit model (live-proven) abandons an armed row without committing — so the re-type/Enter/click re-commit (the 2026-06-22 stray fix, pre-Tab-model) was ~4 wasted round-trips per keptLowerTier field. `overwriteNoMatchResting` now Tab-closes on BOTH overwrite paths; keptLowerTier VERIFIES the post-Tab chip (== original → `filled`/`prefilled-better-tier-unavailable`; differs → `overwrite-stray` honest live value; vanished → needs_review, never a false "kept"). recommitFn + TYPEAHEAD_SELF_VERIFY deleted; typeahead+source lockstep tests updated (only the higher tier is ever typed; Tab asserted). See dom-patterns 2026-07-02 follow-up 2.
- **keptLowerTier never reaches the inline AI (the FoS "why is this flagged?" fix) — unit-pinned (453 tests).** A PRE-FILLED typeahead whose chip matches a LOWER profile tier (`preTierIndex > 0`, e.g. FoS holding tier-1 "Electrical Engineering" from a prior run) walks only the higher tiers; on their no-match the overwrite exit was handing the field to `tryInlineAi`, which re-picked the SAME value and re-flagged it `ai-choice`/`filled_review` — a spurious AI flag on a STATED profile value. The exit now gates the AI on `preTierIndex <= 0`: keptLowerTier resolves deterministically (recommit → `filled`/`prefilled-better-tier-unavailable`, zero LLM calls — INVARIANT test); the AI rescue remains for the MISMATCHED pre-fill (`k === -1`) and the empty-field genuine no-match. See dom-patterns 2026-07-02 follow-up.
- **LLM 503 retry + prefilled-dropdown honesty on the AI no-commit exits — BUILT, unit-green (460 tests); LIVE-VERIFY PENDING (page 3 re-run).** Two page-3 (AI screening-question) bugs from the 2026-07-02 live run. **(1) Transient-availability retry (`callLLM`, llm.js):** a Gemini HTTP 503 "high demand … try again later" killed one question outright; `callLLM` now WAITS then re-sends on a retryable HTTP status ONLY (429/500/502/503/504/529 — `LLM_RETRY_STATUS`), delays `LLM_RETRY_DELAYS_MS` [2s, 8s], then the normal `ok:false` NAMING the attempts ("gave up after 3 attempts"). Auth/validation (401 etc.), malformed responses, and network throws keep the single-attempt contract. Lives in the adapter → covers EVERY `act.llm` caller (AI-1/2/3/4, canonicalize, typeahead/tree fallbacks) + popup Test-connection; `sleepImpl` injectable (tests don't wait). **(2) The summary MASKED a prefilled value on AI failure (the important one):** `closeAndVerifyBlank`'s `blank` means "value UNCHANGED", and every AI no-commit exit did `after: cz.blank ? null : cz.after` — a dropdown that stayed on its REAL prefilled answer (Workday restores prior answers on a re-run) was recorded `after:null`, so the summary (`current_value = rec.after`) showed an EMPTY field while the page held "No". New `noCommitAfter(cz)` on all 10 no-commit exits (`aiFillField` ×3, `aiCanonicalizeField` ×3, `aiInferEeoField` ×4): unchanged+real → the live kept value + a `keptPrefillNote` detail ('the field already held "X" (prefilled) — KEPT, verify'); unchanged+placeholder (via the existing `hasLiveValue` — "Select One") → null (genuinely blank, regression-pinned); changed → the strayed value (the `*-stray` flags, keyed on `cz.blank`, untouched). The `aiFillField` SUCCESS path also names a replaced prefill ('overwrote prefilled "Yes"') for reviewer provenance. No background.js lockstep (fillEngine has no AI path). 460 tests (+8: 503-then-success / persistent-503 exhausts+names attempts / 401-never-retries / 429-retryable; prefilled call-failed keeps+reports the value down to bundle `current_value` / blank stays null / prefilled no-match reports kept value / overwrote-prefilled note). **LIVE-VERIFY:** re-run page 3 with the questions prefilled — a failed AI call must show the prefilled answer in the review summary (needs_review + KEPT note); a transient 503 should recover in-run (~2–10s).
- **Pre-advance recon false-positives on correctly-filled WE dates + checkboxes — FIXED, unit-green (465 tests); LIVE-VERIFY PENDING.** After an AI-4 remediation round the pre-advance `reconPageTruth` (fill-driver.js) flagged every correctly-filled work-experience date and every correctly-unchecked "I currently work here" with spurious "— verify" notes. Two root causes, both false positives (the data was correct): **(1) Dates ("live value changed before advance"):** the recon compares the record's `after` (the date FILL's `afterStr`, built from each segment's INPUT read → "9/2024") against `cdpRepeatingScan`'s value, which reads the visible DISPLAY (Workday renders it ZERO-PADDED → "09/2024"); `norm()` treats "9"≠"09", so every M/Y|M/D/Y date false-flagged. Fix: for `widgetType==="date"` compare SEGMENT-wise by numeric value, reusing the M40 audit's existing `auditDateMatches` (the fill afterStr is its exact inverse — no new helper, no drift). **(2) Checkboxes ("field is EMPTY on the page at advance-time"):** the scan returns a BOOLEAN for a checkbox and `hasLiveValue(false)` is false, so a correctly-unchecked box (a valid, determinate state — a past job with a To date) was treated as an unfilled/empty field. Fix: a checkbox (`widgetType==="checkbox"` or a boolean value) always "has a value" (`fd.value != null`); only null (no input found) is empty. Genuine changes/emptiness still flag — regression-pinned: a real month change, a truly-empty date (display placeholders → null), and a genuinely toggled checkbox all still surface `recon-mismatch`. Only the remediation path is affected (`reconPageTruth` runs solely there); the M40 audit was already correct (it reads dates from the input on both sides + uses `auditDateMatches`). +5 recon integration tests. **LIVE-VERIFY:** trigger a page-2 (My Experience) nav-timeout/remediation and confirm correctly-filled dates + unchecked "currently work here" no longer carry the "— verify" note.
- **Hidden-walk stall on page 2→3 (throttled re-navigation) — FIXED (core), diagnostic added; LIVE-VERIFY PENDING (hidden re-run).** Operator report: the full CDP walk reaches page 3 when the tab is VISIBLE but always stalls at page 2 when HIDDEN. Deduction: since visible advances with the IDENTICAL profile/cert data, the data + cert are fine — the hidden failure is a pure THROTTLING artifact (Chrome throttles a hidden tab to ~1Hz; CDP actuation is throttle-immune but Workday's page-side validation + route transition are not). Live trace: page 2 Save & Continue → a throttle-induced phantom `Duplicate language entries are not allowed` (distinct English/Chinese — exactly what Tier-0 targets; does NOT fire visible) → Tier-0 deleted both languages → errors cleared 2→0 → **but the throttled re-navigation didn't finish inside the default 15s `cdpWaitNextPage` ceiling**, so the walk halted `errors-cleared-not-advancing`. (Page 1→2 worked hidden, so the ceiling is fine in general — only the post-remediation re-nav under throttle was too tight.) Fixes (background.js `remediatePageErrors`): (1) the re-`Save & Continue` wait uses a throttle-generous ceiling `REMEDIATION_RENAV_CEILING_MS = 40000` (a genuine validation error still fast-exits ~1s, so this only extends the no-error slow-nav case; a visible fast nav returns early either way); (2) the post-re-click error read now POLLS (≤8×500ms) instead of a single read — under throttle the banner renders later than the ceiling, and a single read can mislabel a still-blocking error as "cleared"; (3) a `[tab visible|hidden]` diagnostic on the remediation-start log so a stuck hidden run is unambiguous. NOT unit-tested (the remediation LOOP is live-verified glue, not a unit; 465 units stay green + `node -c` clean). The operator RETAINED the Tier-0 delete-all workaround (AskUserQuestion 2026-07-03) — the deleted languages are logged with re-add content; surfacing that deletion IN the review summary (currently filtered as a synthetic remediation row) is the queued follow-up. **LIVE-VERIFY:** re-run the walk HIDDEN — page 2 should now advance to page 3 after Tier-0 clears the phantom (the `[tab hidden]` log confirms the throttle path); if it still stalls, the polled error read will now name the real late-rendering blocker.
- **Hidden-walk stall — CORRECTED diagnosis: the transition STALLS, not just runs slow (page WAKE added); LIVE-VERIFY PENDING.** The 40s-ceiling fix above did NOT help — the paired VISIBLE vs HIDDEN logs (2026-07-03) prove it: visible `✓ advanced after AI-4 remediation`; hidden cleared the same errors (`2→0`) but did NOT advance even inside the 40s window → the page-2→3 transition genuinely does not run while hidden (not slow — STALLED). Mechanism: a hidden tab throttles timers to ~1Hz AND pauses `requestAnimationFrame` entirely; the FILL survives (React commits via a channel that still runs throttled — 40 fields audit clean hidden), but Workday's SPA route transition depends on the paused/throttled machinery, so `Save & Continue` never navigates while hidden. Fix attempt (best-effort, the freeze flavor): `cdpWakePage()` (cdp.js) sends `Page.setWebLifecycleState('active')` to pull the tab out of Chrome's FROZEN lifecycle, wired into `cdpWaitNextPage`'s poll loop (every transition, main + remediation) + right before each `Save & Continue`. It does NOT spoof `document.visibilityState` (that would corrupt the adaptive-pacing sampler + race the next fill) — only the freeze lifecycle. Honest fallback if the wake is insufficient (pure rAF-pause, which only true visibility resumes): `reportPageErrors` now emits a loud operator hint when it halts with the tab HIDDEN + no error text ("bring the tab to the FOREGROUND; the fill works hidden but page advancement may need a visible tab"). 465 units green, `node -c` clean. **LIVE-VERIFY:** re-run HIDDEN — if `Page.setWebLifecycleState` un-stalls it, page 2→3 advances hidden; if it still stalls, the cause is rAF-pause and the practical rule is "keep the tab visible for page transitions" (the new hint says so).
- **Hidden-walk stall — THE FIX: inject a page-context rAF→setTimeout override so Workday's SPA route transition runs while hidden (Steps 0+1); LIVE-VERIFIED HIDDEN (2026-07-04).** Building on the corrected diagnosis above (the transition STALLS on the paused rAF, it isn't merely slow), the real fix repoints the page's `requestAnimationFrame` at `setTimeout` — a paused-forever rAF becomes an eventually-firing timer (~1fps under the background throttle, enough to unblock a one-shot router "next frame" defer) — installed via CDP at attach. **Step 0 (prerequisite — decouple pacing from page-reported visibility):** `cdpVisible()` (cdp.js) now reads REAL visibility from the SERVICE WORKER (`chrome.tabs.get` → `tab.active` AND `chrome.windows.get` → `win.state !== "minimized"`; focus NOT required — an unfocused-but-active tab still renders full-speed), not `document.visibilityState` from the page. Why first: the escalation step spoofs `document.visibilityState`, and if the adaptive-pacing sampler read that spoofed value it would always see "visible" and drive `act.delay` 5× faster on a still-throttled page → race the fill. Reading real visibility is strictly more accurate regardless and is the safety prerequisite. Same `_visCache`/`VIS_TTL_MS` amortization; defaults to NOT-visible (safe = full delays) on any read error. **Step 1 (the override):** `cdpAttach` now also `Page.enable`s (required for `addScriptToEvaluateOnNewDocument`; does not affect nav-survival of the attach); `cdpInstallPageOverrides()` installs `OVERRIDE_SRC` (an IIFE: `hasFocus()`→true — a METHOD not a getter — plus the rAF polyfill, guarded by `window.__apRafPatched` for idempotency) BOTH via `Page.addScriptToEvaluateOnNewDocument` (future full loads / re-auth) AND via `Runtime.evaluate` on the CURRENT already-loaded SPA doc (the common case — the walk attaches mid-application; the SPA never reloads so the new-document hook alone would never fire). Best-effort (try/catch + log) — an install failure never aborts a run. Wired into `runCdpWalk` (before the loop) and `runCdpFillPage` (both after their attach). **Diagnostics:** the `[tab visible|hidden]` remediation-start log and the `reportPageErrors` hidden-tab hint now read REAL visibility (new `cdpVisibilityLabel()`), so they stay truthful even after a future `document.visibilityState` spoof; the hint's advice is reframed as a fallback ("the rAF-override fix didn't unblock it this time — bring the tab to the foreground"). This is the SIMPLE stage — 465 units green, `node -c` clean; the walk loop is live-verified glue, not unit-tested. **Staged escalation (only if the simple override is proven insufficient on the hidden re-run): Step 2** — also spoof `document.visibilityState`/`hidden` + swallow `visibilitychange`/`blur` (now SAFE thanks to Step 0; note `cdpWaitHidden` reads the page's real visibilityState and would need switching to real visibility if this spoof lands); **Step 3** — route `setTimeout` through a Web Worker for full-speed timers, with a try/catch fallback to native `setTimeout` (Workday CSP may block `blob:` workers); **Step 4** — a one-time page-1-start reload (never mid-walk) if Workday cached rAF at init and the current page still stalls on the first transition. `cdpWakePage()` + the 40s `REMEDIATION_RENAV_CEILING_MS` from the two attempts above are now redundant-but-harmless (kept as defense in depth). **LIVE-VERIFY (the gate):** start the walk on a disposable Magna application, MINIMIZE the tab → success = `[tab hidden]` AND `✓ page 2 → advanced` / reaching `──── PAGE 3 ────` with the tab still hidden; also confirm a VISIBLE run still advances (no regression) and the hidden FILL still audits clean (proves Step 0 didn't break pacing). If it still halts `errors-cleared-not-advancing` hidden → escalate to Step 2. **RESULT (2026-07-04, tab MINIMIZED the whole run):** the walk advanced page 2 → `✓ page 2 → advanced` → page 3 → `✓ page 3 → advanced` → `✓✓ reached the REVIEW page` (NOT submitted); every page's post-settle audit read "all matched the report" — so Step 0's real-visibility pacing did NOT break the hidden fill, and Step 1's rAF→setTimeout override alone unblocked the hidden SPA transition. **Answers the plan's open question:** the page transition is a ONE-SHOT rAF defer that the ~1fps setTimeout polyfill satisfies — Steps 2 (visibility spoof) and 3 (Web-Worker full-speed timers) were NOT needed. The fill was slow-but-correct hidden (adaptive full delays + ~1fps rAF callbacks) — the expected throttle tradeoff, not a regression. NOTE: this run traversed screening-questions + EEO pages; the specific phantom-dup-language remediation→re-nav case (the original My-Experience repro) still advances via the same override but was not exercised this run.
- [ ] **PARKED — AI from the full list on a TREE no-match — DONE (both tree pickers unified on `aiTreeDrillFallback`).** Re-open only if a NEW tenant shows a tree shape without a searchBox (a pure expand-walk, no typing) — that needs its own deterministic drill fill first.
- [ ] **NEXT — the to-review N-page walk + AI-2/AI-3 live-verify (AI-0/1/2/3/4 all built).** The walk to the REVIEW page (eyes-on, DISPOSABLE app — the deferred M38-Part-3 hard gate, now unblocked: resume + AI-4 remediation land) is the headline next milestone. Plus the still-live-PENDING units: AI-2 essays (no essay page observed yet), AI-3 EEO-inference/canonicalization (Magna exact-matches), the AI-4 dup-language Tier-0 (phantom-dup not reproducible), and the sdjkf honesty fix + proactive nested delete (unit-green, live-verify on the next run). All under the guess+fill+FLAG contract. **Operator TODO: restore the real cert in `data/profile.json`** (the `_TEST_REMOVE` CPP/otherrrr/attach_resume test cert) once nested-specialty testing wraps.
- **Nested cert Specialties fill — DONE (see the progress-log entry above).** *(Was the long-deferred build; the old "clear leftover empty specialties" operator TODO is RETIRED — the nested fill reconciles orphan empty rows away, incl. at N=0.)*
- **Re-scan-after-change — DONE (M1, see the progress-log entry above).** A field-revealing change (e.g. Country) is now caught by the cascade re-scan; revealed fields fill (required) or stay blank (optional). The unmapped local-name fields (`legalName--firstNameLocal`/`lastNameLocal`) now correctly stay `skipped`/blank (optional gate) rather than AI-guessed; a real MAPPING for them (so they fill deterministically from a profile field) is still an open low-priority gap.
- [ ] **Deferred (inherited by M27 overwrite) — long-list click-commit (Uruguay):** the overwrite re-walk reuses the existing typeahead/source commit ladder, so an out-of-view multi-match click degrades to `needs_review` (safe), never a mis-commit; a proper fix (scroll/virtualized-list commit) is its own recon round.
- **Hierarchical/tree pickers on CDP — DONE (the merge above).** `source` + Magna's Certification are the same multiselect; both fill via the unified `fillTypeaheadCdp` (deterministic) + the gated `aiTreeDrillFallback` (AI no-match drill). A genuinely searchBox-less expand-walk tenant is the only remaining un-handled tree shape (PARKED above).
- [ ] **Known issue (observed once, unreproduced):** a long-lived / stale extension instance produced a **25s settle timeout on a no-match typeahead candidate** (Field of Study candidate-0) that a **reload fixed** — candidate-0 back to banner-blocking in ~839ms on the same committed code (M25). Suspect MV3 service-worker respawn leaving stale state, or a `chrome.debugger` attach/detach that didn't cleanly reset across many runs. Matters because users run ONE install across MANY applications WITHOUT reloading (opposite of the dev reload-often pattern) → they accumulate worse than we test. Not blocking; revisit if it recurs or users report a hung/slow fill. **Mitigations to consider then:** (a) at each CDP run start, defensively `cdpDetach` any existing attachment to the tab before re-attaching (clean slate, so a leftover attach from an evicted/crashed prior run can't poison the next); (b) don't trust module-level state (`cdpTabId` etc.) across runs — an MV3 SW respawn wipes it, so re-derive attach state per run rather than assuming the tracked value is current; (c) on a settle hitting the ceiling, log SW-lifetime / attach-age to correlate timeouts with accumulation; (d) reset any per-run caches at run start.
- [ ] **Later rounds:** strict-replay SUBMIT (Plan 1 — consumes Plan 2's `effectiveValue`/`is_approved`/`submit_ready`; must defensively recompute the envelope if a never-opened bundle lacks it, and live-re-read + REFUSE on any unreplaced AI placeholder); full N-page loop (see Multi-page); auto-populate `jobContext.company`; map standalone `linkedInAccount`/`preferredCheck`/`regionSubdivision1`; dial-code tiebreak (parked); account creation; backend. *(Plan 2 shipped the summary page-scoping/accumulation + approve/merge + editable text/radio/checkbox — see the progress-log entry.)*
- **Hidden-tab FAST fill — worker-timers + measured-latency pacing gate (Stage 1; 2026-07-04; fast path LIVE-VERIFIED on Magna).** The rAF→setTimeout override (shipped) made the hidden walk *advance* but rAF still fired at ~1fps (native `setTimeout` is throttled to ~1Hz hidden), so the fill was correct-but-slow hidden — slow enough the operator won't run it that way. Root cause: two independent sources — **(S1)** the page's OWN debounced reactions (typeahead filter, cold dropdown render, section mounts) sit through ~1s throttled ticks (dominant), and **(S2)** our `act.delay` used full delays when hidden. **Fix (`cdp.js` only, +114/-22):** (1a) `OVERRIDE_SRC` → **`buildOverrideSrc({forceNoWorker})`** now also installs a **worker-timers polyfill** — `window.setTimeout`/`setInterval` routed through a `blob:` Web Worker whose timers escape Chrome's main-thread background throttle (callbacks return via `postMessage`, not throttled); own `try/catch` sets `window.__apWorkerTimers` and NEVER stops the rAF override (which installs after it and now picks up the worker-backed `setTimeout` → rAF fast too). Guard renamed `__apRafPatched`→`__apOverridesInstalled`. (1b) `cdpInstallPageOverrides` reads a `chrome.storage.local.forceWorkerTimersOff` debug flag (mirrors `debugInputTrace`) → `forceNoWorker` simulates a CSP-blocked tenant on demand; reads back `window.__apWorkerTimers` into module flag `_workerTimersActive`; log reports `worker-timers ON/OFF (CSP?)/OFF (forced)`. (1c) **`cdpTimersFast()`** — the honest "not throttled" signal: a real in-page `setTimeout(0)` round-trip, **NON-BLOCKING** via `Promise.race([probe, cdpDelay(200)→"TIMEOUT"])` (a throttled probe takes ~1s and a *dead* worker's never resolves — the race bounds every probe to ≤200ms and IS the fast/slow decision), TTL-cached 1.5s. (1d) **`cdpFast()`** gate: visible → fast (no probe); hidden + no worker → slow (skip probe); hidden + worker → fast ONLY if timers MEASURE fast. `cdpAdaptiveDelay` now uses `cdpFast()`; `_timerLatCache`/`_workerTimersActive` reset at `cdpAttach`. **Safety:** never paces fast on the mere assumption the worker installed — always the measured probe; worker blocked / timers slow ⇒ **byte-identical to the pre-Stage-1 slow-but-correct path**; the `delayFull` settle intervals (option-count, commit persistence) stay FULL in Stage 1 (their correctness gates — 2-equal-reads, persistence re-read — untouched); SUBMIT double-guard + rAF override + `cdpWakePage` untouched. **Verify (unit):** `node -c cdp.js/background.js` clean; 465 tests green. **Verify (live — the gate): FAST PATH VERIFIED on Magna (2026-07-04).** A HIDDEN single-page CDP full-page fill logged `page overrides installed (… worker-timers ON)` — so Magna's CSP does NOT block `blob:` workers, and (because `cdpFast()` only paces fast when hidden if `_workerTimersActive` AND the live `setTimeout(0)` probe measures <200ms) the observed speed-up PROVES both the worker installed and the page's own timers ran unthrottled. The post-settle audit read clean (40/40 "all matched the report"), and typeahead settles landed ~490–644ms (vs the multi-second range a ~1Hz-throttled tab produces) — page-side corroboration the worker-backed timers took on Workday's call sites. **STILL PENDING:** the full hidden WALK to the review page (multi-page); the forced-slow no-regression run (`forceWorkerTimersOff` ON → expect `OFF (forced)`, slow-but-correct, no ~1s probe stalls, still advances); a visible no-regression run. Plan: `~/.claude/plans/squishy-churning-tiger.md`.
- **Hidden-tab FAST fill — STAGE 2: adaptive dropdown render-settle (2026-07-04; operator said "still needs to be faster" after Stage 1).** Stage 1 shrank the inter-action pacing but left the two dominant `delayFull` settle *intervals* full, so every dropdown still paid ≥~700ms option-settle + 2×`commitIntervalMs` commit even when the page rendered in ~50ms. **Fix:** new actuation method **`act.delayRender = cdpAdaptiveDelay`** (`cdp.js`) — the render-SETTLE intervals now flow through the SAME measured-fast `cdpFast()` gate as `act.delay`, instead of the never-scaled `delayFull`. Routed at the dropdown sites whose correctness is **interval-LENGTH-INDEPENDENT**: `fillDropdownCdp`'s option-count settle (2-equal-non-zero-reads), its commit + commit-**persistence** re-read, and its commit-fail retry re-open settle; plus the shared `openAndReadDropdown` (feeds `captureDropdownOptions` + `aiFillField`). Driver reads `act.delayRender || act.delayFull` so older/fake substrates (unit tests) transparently fall back to `delayFull` — keeps the read-only method-whitelist tests green. **Why safe:** the interval only shrinks when timers **MEASURE fast** (worker-timers/visible → the list renders in ~50ms, so "2 reads ~70ms apart" both see the COMPLETE render — the historic partial-render hazard cannot occur when the page is fast); a throttled/network-cold list keeps count 0 (`n>0` gate) or stays full (measured slow); and even a premature settle is backstopped by the commit persistence re-read (a discarded pick reverts → honest `needs_review`, never a wrong/silent commit). Ceilings/deadlines stay raw (full) → no false time-out on a genuinely slow list. Slow path byte-identical to before. **Out of scope (deferred to a next stage if still slow):** the typeahead open/settle intervals, the M40 audit settle, and repeating-section mount settles stay `delayFull`. **Verify (unit):** `node -c` clean on cdp/fill-driver/background; 465 tests green (incl. the dropdown-capture READ-ONLY whitelist tests, exercising the fallback). **Verify (live — PENDING):** a hidden walk with cold dropdowns (Country/State/phone-type on My Information) should be materially faster with audits clean; forced-slow + visible runs unregressed. **VERIFIED LIVE on Magna 2026-07-05** (operator: everything works) → merged to main.
- **Hidden-tab FAST fill — STAGE 3: adaptive typeahead render-settle (2026-07-05; operator: "extend delayRender to typeahead settle intervals").** The MAIN typeahead filler (`fillTypeaheadCdp` / `awaitListTerminal` / `pollSearchValue`) already paced its core banner/terminal settle on `act.delay` (adaptive), so it was fast; the residual `delayFull` typeahead cost lived in the **read-only end-of-page option-capture** helpers + the **AI tree-drill rescue**. Routed those through `delayRender` (fill-driver.js, `act.delayRender || act.delayFull` fallback per fn): `captureFieldOptions` (flat FoS scrape — open/focus poll + post-Tab close), `captureTypeaheadOptions` (summary tree/flat classify — open poll + re-open/focus/scrape poll + post-Tab close), and `aiTreeDrillFallback`'s no-match-fallback render-settle before the category scrape (+ its debug harness beat). **Why safe:** every converted site is a poll/settle gated by an **interval-LENGTH-INDEPENDENT** state check — `searchBox.visible`, a non-empty scrape result, or the drilled-category banner — with the ceilings (`taOpenCeilingMs`/`scCeiling`) computed raw (stay full); the capture helpers are **READ-ONLY** (open → scrape → Tab-blur, the clean non-committing exit — no type/Enter/arrow, nothing arms) and end-of-page, and the AI drill's commit is **chip-gated** (chip normalize-equals the AI leaf), so a shrunk settle can only re-poll sooner, never mis-commit. It only shrinks when timers MEASURE fast; throttled/slow ⇒ full ⇒ byte-identical. The banner-gated terminal wait, focus-hygiene re-verify, and Tab-blur non-commit exit are all untouched (the "Afghanistan stray" guards intact). **Out of scope (still `delayFull`):** the dropdown commit-verify reopen settles, the M40 audit settle, the repeating-section mount settle. **Verify (unit):** `node -c` clean; 465 tests green (the read-only capture whitelist tests exercise the fallback). **Verify (live — PENDING):** a hidden typeahead-heavy page (education FoS + certifications) with the end-of-page option capture should be faster with audits clean; forced-slow + visible unregressed.
- **Hidden virtualized-list scrape truncation — FIXED by dispatching a scroll event (2026-07-05; LIVE-VERIFIED on Magna; a Stage 1 fallout found during Stage 3 verify).** Operator checked the review editor and the Field-of-Study option list was **truncated** ("stopped at Design" — 17 of 65). The read-only virtualized-list scrapes (`cdpScrapeTaOptions` flat FoS, `cdpScrapeSourceRows` source/cert trees) scroll a window per step and read the mounted `[role=option]`/`promptOption`. **DIAGNOSIS BY TRACE (not theory — the discipline the first guess violated):** instrumented the scrape to log per-step `{scrollTop, mounted-now, seen}`; the data showed `scroller:true sh:1984 ch:211`, `scrollTop` climbed 0→1772 (it DID scroll the full height), but the **mounted set stayed a FROZEN 17 rows and `seen` never grew past 17** — i.e. a programmatic `scrollTop` set does NOT drive the react virtualizer's scroll-listener re-render on a **HIDDEN** tab, so it never mounts the off-screen rows. (Pre-worker-timers this never surfaced — hidden fills were too slow to run to the capture; the 65-option scrape was only ever seen VISIBLE, where the natural scroll fires the listener.) **FIX:** fire an explicit `sc.dispatchEvent(new Event("scroll"))` after each `scrollTop` set → the virtualizer mounts the new window even hidden. **LIVE-VERIFIED:** 65/65 options, `seen` climbs 17→22→…→65, and the full list renders in the review editor. A single `frame()` per step suffices (the same pacing that always worked visible — it was never the pacing). **A WRONG FIRST ATTEMPT, then reverted:** a mount-gated `settleWindow` (poll frames until the count stabilizes) was tried first on a pacing hypothesis — it did NOT fix the truncation (the data later showed why: the rows never mount at all without the scroll event) and it slowed even the visible scroll, so it was **reverted** at the operator's call; the diagnostics were removed. Read-only scrapes; no fill/commit path touched — the FILLED VALUE was always correct (audit clean). **Verify:** `node -c` clean; 465 tests green (in-page scrapes aren't unit-covered); live-verified hidden on Magna.
- **Rapidfire pacing STAGE A — lower the adaptive knobs (2026-07-05; operator wants near-zero inter-field delay, fg + worker-fast bg).** `FAST_FACTOR` **0.2→0.1** and `FAST_FLOOR_MS` **25→10** (`cdp.js`). Halves every adaptive interval + inter-field beat (all class-A `DEFAULT_BUDGETS` intervals + `interFieldMs`) for BOTH foreground and worker-fast background (they share the `cdpFast()` gate); the slow path (hidden no-worker) is untouched. **Zero new race risk:** every value-committing actuation is followed by a delay-LENGTH-INDEPENDENT gate (aria-expanded open-retry, option-count 2-stable-reads + commit-persistence re-read, typeahead terminal-render + focus/echo verify, text/date read-back, M40 audit) — a too-fast action that races retries or flags `needs_review`, never a silent wrong fill. Ceilings/deadlines/retry-counts/`stableReads` stay raw. **Verify:** `node -c` clean; 465 tests green. **Verify (live — PENDING):** fg + hidden runs audit-clean and materially faster; forced-slow unchanged.
- **Rapidfire pacing STAGE B — adaptive/gated fixed substrate waits (2026-07-05; Stage A alone left the visible fill still slow — the dominant per-field cost is the FIXED `cdpDelay(N)` waits the adaptive knobs don't touch).** All in `cdp.js`: (1) **per-char typing** (`cdpTypeChars` — 40ms typeahead/text, 80ms dates, 120ms legacy) is now ADAPTIVE (sampled once via `cdpFast`, scaled by `FAST_FACTOR`) with a typing-specific `TYPE_FAST_FLOOR_MS=15` floor > `FAST_FLOOR_MS` so keystroke-driven listeners still arm the typeahead highlight; slow path keeps the full gap. (2) **`isTreePicker`'s blind 700ms** tree-vs-flat render wait → a GATED mount-poll (poll `cdpReadSourceState` at an adaptive interval until any rows mount, 1500ms raw ceiling, then classify) — fast when the list mounts fast (the common case), never reads an empty list; the 200ms close → adaptive. This was ~900ms **per typeahead field**. (3) **`cdpSelectAllDelete`** 60ms Ctrl+A→Delete gap → adaptive. (4) **focus settles** — `focusText` 250ms and `focusDateSegment` 200/120/120ms + its retry interval → adaptive; all gated by a `.focused` read-back, so a too-short settle just costs one retry. **Left FULL (unchanged):** `auditSettleMs` (M40 audit), all ceilings/retry-counts/`stableReads`. **Safety:** every shrunk wait is either gated by a delay-length-independent check (focus read-back, mount-poll, downstream chip/value verify) or backstopped by the M40 audit — a race retries or flags, never a silent wrong fill. **Verify:** `node -c` clean; 465 tests green. **Verify (live — PENDING):** fg + hidden audit-clean + typeaheads commit + FoS 65-option capture intact + noticeably faster; forced-slow unchanged.
- **Faster recon scroll — render-completion early-break (2026-07-06; operator: the end-of-page recon scroll is slow; behavior must NOT change, only speed).** REVERTED the reuse-siblings rewrite of `captureChoiceOptions` (the operator wants the original recon behavior: scrape ONCE per dropdown-stem, cached across a repeating section's entries — 2 languages both prefilled-kept → one re-open, the 2nd reuses). Kept that behavior byte-for-byte; sped ONLY the virtualized-list scroll (`cdpScrapeTaOptions`): the fixed per-step double-rAF (~32ms regardless of render speed) → a poll of SINGLE frames that breaks the instant the mounted-window signature changes (React committed the new window), capped at 3 frames (≈ the old double-rAF worst case). Breaks at ~1 frame on the common middle steps (≈2× faster there), never slower than before, and reads a COMMITTED window (the sig-change is the mount signal) so it can't advance before the mount → **cannot re-truncate** (overlap + de-dup + stable-2-at-bottom still backstop). Only the flat-typeahead scrape changed; the tree scrape (`cdpScrapeSourceRows`, AI-drill path) left as-is. **Follow-up (operator: FoS scroll still too slow visible — hidden and visible needn't use the same mechanism):** the bigger lever was the STEP SIZE, not the wait. The scrape hopped by a *viewport* (~0.8× clientHeight) each step, but a virtualizer keeps a much larger window MOUNTED (viewport + overscan — the trace showed ~17 rows for a ~7-row viewport). Now it measures the mounted window's pixel span (`mountedSpan`, via `getBoundingClientRect` of the mounted rows) and hops by **0.6× that span** (~40% overlap → no row skipped even if the span is mis-measured by up to 40%; de-dup + stable-2 still backstop). This cuts a 65-item list from ~12 hops to ~5, self-adapts to each tenant's overscan, and speeds BOTH visible and hidden (so no separate visible-only mechanism was needed — cleaner than a visible-only smooth scroll, which is browser-speed-limited and wouldn't help hidden). **Verify:** `node -c` clean; 465 tests green. **Verify (live — PENDING):** FoS scroll noticeably faster VISIBLE + hidden; review editor still lists all 65; 2nd prefilled entry still shows a reused dropdown.
- **Recon between-fields dead time — adaptive, LISTBOX-GONE-gated close (2026-07-06; operator: physical open/close are fast but there's a ~1s gap BETWEEN each recon field; then a RACE from making it adaptive).** The gap was `closeAndVerifyBlank`'s per-close `act.delayFull(reopenSettleMs=400)` — NON-adaptive, ran full even when visible/fast, once per re-opened choice field (and main's page-1 choice-field recon re-opens MORE of them). Made it adaptive (`act.delayRender`). **First attempt gated on `ariaExpanded==="false"` — WRONG:** aria flips the instant Escape fires, but the portaled listbox lingers a beat with its options still CLICKABLE, so the fast close returned too early and the NEXT recon field's open-click landed on a lingering option (live stray: "Landline" committed to Phone Device Type — the Country-Phone-Code box sat exactly where that option rendered). **Fix:** gate the close on the LISTBOX being GONE (`!listboxPresent || optionCount===0`), not aria; poll adaptively (fast — breaks the instant the list unmounts, ~1 poll) with a real deadline (the old `openRetries×reopenSettleMs` budget) bounding a genuinely slow close. Fast happy path, no stray. **Sibling hardened (same commit-series):** the typeahead recon close (`captureFieldOptions` + `captureTypeaheadOptions`) had the same latent race (`pressTab` + a fixed adaptive settle could return while promptOption LEAVES lingered). New shared `awaitTypeaheadClosed` polls `readHier` until `leafCount === 0` (leaves unmounted — the typeahead analog of the dropdown's `optionCount === 0`) before returning; adaptive/bounded (breaks the instant the popup empties; iteration+deadline cap so a slow close or a leafCount-less substrate never hangs). Test fake `makeCaptureAct` now models the close (Tab-blur → `leafCount 0`). `node -c` clean; 482 tests green. **NOTE — branch synced to main here:** this branch had forked at `8fff9a9` and was 3 commits behind `origin/main` (`1a292d6`); merged `origin/main` in (main added replay minimal-diff, phone-format tolerance, page-1 choice-field recon in `fill-driver.js`/`background.js`/`summary.*` — my branch only ever changed `cdp.js`, so the merge was conflict-free and preserved main's work). The earlier "fill-driver identical to main" note was a three-dot-diff mistake; the screening-question AI-fill behavior is governed by `fill-driver.js`, now main's current code.
- **dup-language mis-commit — dropdown option click now validates elementFromPoint before firing (2026-07-06; recon of a recurring live bug).** A Magna walk mis-filled `language[0].language`: commit-failed "English → trigger shows Chinese", `language[1]`=Chinese too → Workday duplicate-language error → AI-4 Tier-0 deleted one. The read-back CAUGHT it (needs_review, not silent — safety held). RECON (see dom-patterns 2026-07-06) found the option COMMIT is a coordinate click on a rect captured in a SEPARATE round-trip (`cdpDropdownOptionRectByText` → `cdpClickAt`), with nothing re-verifying the option is still at those coords — a still-settling/virtualizing listbox shifts the row and the "English" click lands on a NEIGHBOR ("Chinese"); intermittent, and aggravated by the fast-timer `delayRender`. **Fix:** `cdpDropdownOptionRectByText` reports `hitTarget` (`elementFromPoint(cx,cy)` resolves to the target option) + `collisions` (aria-controls id count); `clickDropdownOptionByText` re-captures ≤4× (~80ms apart) until the target is CONFIRMED in place before clicking (mirrors the source-drill's `elementFromPoint` validation), and logs a `[CDP-DD-COMMIT]` warning if the aria-controls id collides across entries (the latent Vector-B cross-entry-routing risk, to confirm on the next occurrence). Commit-persistence re-read remains the backstop. `node -c` clean; 482 tests green. **Verify (live — PENDING):** the two-language walk fills English+Chinese with no dup-language error; watch `[CDP-DD-COMMIT]` for any re-capture/collision logs.
- **Hidden dropdown OVERWRITE fails — element-dispatch commit retry (2026-07-06; recon via the `[CDP-DD-COMMIT]` diagnostic).** Operator clarified the dup-language symptom: two language dropdowns start pre-filled+FLIPPED and the fill must OVERWRITE each — but the overwrite click doesn't take when HIDDEN, leaving them flipped. The diagnostic proved it: VISIBLE and HIDDEN log identical `hitTarget=true atPoint="English" collisions=1 rect=456,298`, yet VISIBLE commits and HIDDEN doesn't (`language[0]` "English" never leaves "Chinese", even on the re-open retry). So a TRUSTED CDP COORDINATE click lands on the correct portaled option but does NOT fire its onClick on a hidden tab (the coordinate hit-test can't reach the non-composited overlay). **Fix:** `fillDropdownCdp`'s commit retry now dispatches the click DIRECTLY on the option element (`cdpClickDropdownOptionDirect` → `act.clickDropdownOptionDirect`; the robustClick pointer→mouse→click sequence, element-targeted, no coordinate hit-test) instead of re-doing the coordinate click. Primary commit stays the trusted coordinate click (works visible + most hidden); the direct dispatch is the retry (synthetic, but gated by the commit-persistence re-read → never a false fill); falls back to the coordinate click for older fakes. My earlier elementFromPoint re-capture (wrong vector) was reverted first. `node -c` clean; 482 tests green. **Verify (live — PENDING):** the hidden flipped-languages walk now fills English+Chinese (watch `[CDP-DD-COMMIT] direct element-dispatch retry … dispatched` then the commit succeeding); no dup-language error.
- **Hidden dropdown OVERWRITE fails = FAST-PACING race — non-adaptive settle for overwrites (2026-07-06; root cause confirmed via `forceWorkerTimersOff`).** Follow-on to the above: neither the trusted coordinate click NOR the synthetic element-dispatch committed a pre-filled language dropdown's overwrite when hidden. `forceWorkerTimersOff:true` (all-`delayFull` slow path) commits BOTH correctly on the first coordinate click → the cause is the FAST PACING: a dropdown RE-SELECTION needs the just-opened list to be INTERACTIVE before the click, and fast pacing (~70ms option-settle) clicks too early — the click lands on the correct option (`hitTarget=true`) but doesn't fire the selection, so it never commits (then burns the ~10s commit ceiling). **Fix:** `fillDropdownCdp` inserts a NON-ADAPTIVE `act.delayFull(settleIntervalMs*2 ≈ 700ms)` before the commit click ONLY for an OVERWRITE (`before` is a real enabled option ≠ target); EMPTY fills (placeholder `before`) stay fast. Targeted to pre-filled dropdowns (rare on a fresh form) and NET FASTER on the failing case (commits vs two ~10s fail-poll+retry cycles). The element-dispatch retry from the prior commit is now moot (primary commits) but left as a harmless fallback. `node -c` clean; 482 tests green. **Verify (live — PENDING):** hidden flipped-languages walk fills English+Chinese first-try (no dup-language), and the fill stays fast (only the two overwrites pay ~700ms).
- **Background-fill SPEED round — full-clock tax sweep + cross-run option cache + [CDP-TIME] evidence (2026-07-25; operator: "the background fill is still a bit too slow — speed it up dramatically").** The hidden fill was already 10×-adaptive (Stages 1–3 + A/B), so this round attacked the REMAINING fixed full-clock taxes and repeated page-bound work, plus instrumentation so the next round is evidence-driven, not guessed. All changes keep the safety model intact: every shortened wait is gated by an interval-length-INDEPENDENT state check, and ceilings/windows stay wall-clock. **(1) Per-page initial field-set settle** (`fillAndPersistPage`) — was 3 stable reads × 500ms `delayFull` (~1.5–2.0s per page, ALWAYS, +1.5s zero-bail on repeating-only pages); now a WALL-CLOCK no-growth window (non-zero count unchanged ≥1.2s, polled at 150ms; zero-bail ~1.0s) — same guarantee measured in real time, ~0.4–0.8s/page saved. **(2) `cdpWaitNextPage`** — the fixed 500ms `cdpDelay` poll → `cdpAdaptiveDelay` (~50ms fast), saving up to ~1s discretization per transition; the validation-error fast-exit's transient-flicker guard became WALL-CLOCK (errors must persist ≥600ms) so the adaptive beat can't weaken it. **(3) `closeDropdownConfirmed`** — was `delayFull(commitIntervalMs)` × 4 iterations (≈300ms full per committed dropdown even when the options unmounted on the first beat); now `delayRender` polls bounded by the SAME total wall-clock window closeAndVerifyBlank uses (openRetries×reopenSettleMs) — the options-gone gate is unchanged, exits in ~1 fast poll. **(4) READ-FIRST poll reorders** — `pollCheckedIs` (radio/checkbox), both GATE-1 aria-expanded polls (`fillDropdownCdp` + `openAndReadDropdown`), and `commitByClick`'s first read now read state BEFORE the first wait (the trusted click's React reaction usually lands synchronously in the click's own event turn); the commit-PERSISTENCE re-read stays delay-first (it must be a real beat). Saves one interval per widget on both regimes (bigger on the slow path). **(5) CROSS-RUN OPTION-LIST CACHE** (`captureChoiceOptions` + SW I/O in `fillAndPersistPage`) — the end-of-page capture re-opened every tier-0 prefilled-kept choice field COLD each run (country ~5.6s server list + state/phone/countryPhoneCode: ~5–15s per page-1, re-paid on every re-run AND every reload-retry restartWalk). New `chrome.storage.local.optionListCache` (tenant-scoped, key = the existing `dd:stem`/`ta:captureKey`, TTL 7d, pruned to 64 keys × 12 tenants): the SW loads the tenant slice and hands it to the driver (engine computes / SW does I/O); the driver serves capture from it (ZERO re-opens on a hit) and FEEDS it for free from committed fills' `enabledTexts` — so run 1's committed Country feeds run 2, where the same value is a tier-0 keep. COSMETIC surface only (the review editor's `<select>`/combobox lists) — the fill/match ladder always reads LIVE options, so a stale list can never cause a wrong fill (worst case: a stale review pick no-matches on replay → needs_review). **(6) [CDP-TIME] instrumentation** — per-field `rec.elapsedMs` (flat loop + `fillEntryCdp`), per-phase `out.timings` (flat/sections/stubs/cascade/capture/audit/sweep), and a per-page SW log line (settle | fill phases | resume | slowest fields ≥1.5s) so the operator can SEE where wall-clock goes per real run. **Verify:** `node -c` clean ×3; **689 tests green** (5 new pins: cache hit = zero re-opens, committed-options feed, TTL-stale ignored + rewritten, typeahead captureKey hit, closeDropdownConfirmed delayRender+options-gone). **Verify (live — PENDING):** a hidden website-Run fill audit-clean with [CDP-TIME] lines showing the settle ~1.2s, near-zero capture on a re-run (cache hits logged), and unchanged fill correctness; forced-slow (`forceWorkerTimersOff`) unregressed.
- **Hidden-run ~11s/field diagnosis → CDP `Page.setBypassCSP` unblocks the worker-timers fast path (2026-07-25; from the FIRST [CDP-TIME] live evidence, Magna wd3 full hidden Run).** The operator's hidden website-Run printed the new [CDP-TIME] lines: page 2 fill **244.4s** (sections 243.5s), and the slowest-fields list showed a suspiciously UNIFORM **~11s per field across unrelated widgets** (M/Y dates 11.0–11.4s, education degree 10.9s, hashed screening dropdowns 11.0–11.4s, gender 11.6s) with the checkbox at ~half (5.1s — cost scales with actuation-step count), while the M40 audit batch-read **27 fields in ONE Runtime.evaluate in ~0.1s** (0.7s phase minus the 0.6s settle). That combination rules out CDP round-trip cost and full-budget delays alone — it means every **page-side timer-paced reaction** (listbox render, option mount, commit debounce, entry mount, date-segment update — each field chains ~6–10 of them) was quantizing to the **~1Hz hidden throttle**, i.e. the run executed with **worker-timers OFF** — the CSP-blocked branch (`worker-timers OFF (CSP?)` at attach): the 2026-07-04 fast-path verify ran where the blob: worker installed, but the website-Run flow lands on `wd3.myworkdaysite.com`, whose CSP evidently blocks blob: workers → the designed slow-but-correct fallback became the WHOLE run. **Fix (cdp.js):** we are already attached via `chrome.debugger`, so `cdpInstallPageOverrides` now issues **`Page.setBypassCSP {enabled:true}`** (the standard Puppeteer technique; best-effort + logged; scoped to the attach — detach restores enforcement) BEFORE installing the overrides, and — because a SPA doc can carry `__apOverridesInstalled` from an earlier no-bypass attach, making the full override no-op — a **worker-only RETRY** (`buildWorkerRetrySrc`, the extracted `WORKER_TIMERS_SRC` guarded on `__apWorkerTimers !== true`) re-runs just the worker block after the bypass, then re-reads the truth. `forceWorkerTimersOff` skips the bypass (the slow-path regression flag keeps meaning what it meant). The attach log now prints `CSP bypass ON/unavailable` + a worker-timers verdict incl. `OFF (blocked even with CSP bypass)`; the per-page [CDP-TIME] line now LEADS with a **pacing regime label** (`cdpPacingLabel`: visible-fast / hidden-fast (worker timers) / hidden-SLOW (no worker timers) / hidden-SLOW (worker throttled)) so every future timing line self-diagnoses which regime it ran in. **Safety unchanged:** the measured-fast gate (`cdpTimersFast`) still decides pacing — the bypass only gives the worker a chance to install; if it still can't, the readback stays false → byte-identical slow path. **Expected:** the verified fast hidden path (~5–10× on this run's page 2) on CSP-strict tenants. **If the next run still prints `hidden-SLOW`:** the remaining lever is running the fill in a VISIBLE-but-unfocused mini window (visibility disables ALL throttle classes at the browser level — no CSP dependence); sketched, not built (UX decision). **Verify:** `node -c` clean; 689 tests green. **Verify (live — PENDING):** re-run the hidden Run; expect `CSP bypass ON; worker-timers ON` at attach, `pacing hidden-fast (worker timers)` per page, and page-2 fill time collapsing accordingly.
- **Hidden-run bottleneck ROOT CAUSE #2 — the INPUT PIPELINE, not timers: batched input sends + the visible mini-window Run (2026-07-25; from the second [CDP-TIME] live run, Magna wd3).** The CSP-bypass run flipped the pacing label to `hidden-fast (worker timers)` — and the per-field times DIDN'T MOVE (checkbox 5.1→5.2s, gender 11.6→11.3s; typing-heavy fields got worse: FoS 40.8s, roleDescription 19.9s, education degree 41.9s). With delays exonerated, the cost model that fits ALL observations: **per-field time ≈ (number of trusted `Input.dispatch*` events) × ~1.2–1.5s** — checkbox = 3 mouse events ≈ 5s; dropdown ≈ 8 (open 3 + option-click 3 + Escape 2) ≈ 11s; textarea ≈ 8 (focus 3 + Ctrl+A/Del 4 + insertText 1) ≈ 20s; typeahead = dozens of keystrokes ≈ 41s — while `Runtime.evaluate` is fast (27-field audit ~0.1s; 150ms settle polls fine). Chromium processes dispatched input on compositor-frame scheduling; a hidden tab produces NO frames, so each awaited input ack waits a ~1s+ fallback drain. NO pacing knob can touch this. **Fixes:** (1) **batched input sends** (`cdpClickAt`/`cdpTripleClickAt`/`cdpKeyTap`) — `chrome.debugger.sendCommand` delivers in order per target, so the event sequence is ISSUED back-to-back and the acks awaited together (`Promise.all`): one pipeline drain per click/tap burst instead of one per event (~3× on clicks, ~2× on keytaps, hidden; event order/semantics unchanged; a still-visible tab is unaffected — acks are ms there). (2) **the website background Run opens a VISIBLE-but-UNFOCUSED MINI WINDOW** (`chrome.windows.create {type:"popup", focused:false}`, 480×640, bottom-right of the operator's current window) instead of a background tab — visibility keeps compositor frames flowing, so trusted input lands in ms, the page paints (the overwrite debounce takes the tiny VISIBLE beats — `act.visible` true → the [30,100,700,5000] ladder), and `cdpFast` is fast with no worker/CSP dependence; the operator's window keeps focus. Covering/minimizing the mini window degrades to the hidden-safe path (worker-timers + adaptive pacing + cdpWakePage remain the belt) — never worse than the old background tab. **Deeper fix sketched, not built:** a synthetic-event actuation substrate (page-side robustClick/native-setter dispatched via Runtime.evaluate — the page engine's PROVEN repertoire) would make a fully-HIDDEN fill fast too; it's the substrate-swap the act-interface split was designed for, its own milestone + per-widget live-verify. **Verify:** `node -c` clean; 689 tests green. **Verify (live — PENDING):** a background Run should open the mini window, log `pacing visible-fast` per page, and the per-field slowest list should collapse (~11s dropdowns → ~1s); if the window is covered mid-run, expect self-degrade to hidden pacing, still audit-clean.
- **SYNTHETIC-INPUT mode — the truly-hidden fast path (2026-07-25; operator: "no, I don't want it visible — truly hidden, just fill faster").** The visible mini-window (same-day) was REVERTED (the Run opens a plain unfocused tab again); the hidden input-pipeline stall (~1.2–1.5s per trusted `Input.dispatch*` event — see the prior entry) is instead solved by swapping the actuation TRANSPORT when hidden: the six input primitives (`cdpClickAt`/`cdpTripleClickAt`/`cdpKeyTap`/`cdpInsertText`/`cdpSelectAllDelete`/`cdpTypeChars`) now dispatch SYNTHETIC events INSIDE the page via one `Runtime.evaluate` each (~50–100ms hidden, the [CDP-TIME]-proven fast channel) instead of the frame-gated Input domain. This is the substrate-swap the act-interface split was designed for, done at the PRIMITIVE level so the driver and every act method stay byte-identical. The synthetic repertoire is the PAGE ENGINE's proven one: robustClick pointer→mouse→click at the same viewport coords (elementFromPoint DESCENDS open shadow roots — the Simplify X — and steps past Workday's `click_filter` overlay); native-setter REPLACE + input/change for ALL text entry (the React fill technique; replace ≡ select+type because typing always follows a clear/select-all — incl. the date segments, where the page engine's native-setter fill was M17-proven on LiveRamp); label activation for radio/checkbox; searchBox value-set + synthetic Enter (the US Bank page-path recipe). Synthetic events run NO browser default actions — the two the fill relies on are RECREATED (`Tab` → `el.blur()`, the typeahead's clean non-commit exit; `Space` → `el.click()` activation) and focus-on-click is mimicked (trusted mousedown's default) so activeElement-targeted key dispatches land correctly; `cdpTypeChars` wraps its value-set in a last-char keydown/keyup so keystroke-armed listeners still fire. `window.__apActing` is bumped INSIDE each dispatch eval (input-lock passthrough — the attachResume lesson). Every downstream verify gate is UNCHANGED (read-back polls, chip/persistence re-reads, options-gone closes, M40 audit) so a tenant whose widgets ignore a synthetic event ends `needs_review`, never a wrong/silent fill; each primitive also FALLS THROUGH to the trusted path on a per-op miss (no element at point / eval error). VISIBLE tabs keep the trusted path untouched. Kill-switch `chrome.storage.local.forceTrustedInput` (read at attach, logged) reverts hidden runs to trusted wholesale. **Expected:** ~11s/field → ~0.5–1.5s (dropdowns), 41s typeahead candidates → ~2–3s (server-filter-bound), page 2 ~330s → well under a minute — truly hidden. **Known risks to WATCH on live-verify:** dropdown Escape-close relies on Workday's document-level keydown handler (if a tenant binds Escape to the listbox node only, the options-gone close-confirm bounds it and the next-open retries); the date `-display` synthetic click may not focus (the focus ladder's `el.focus()` rung recovers); the M25 highlight-arming keystroke nuance (mitigated by the last-char keystroke wrap; commit correctness is chip-gated regardless). **Verify:** `node -c` clean; 689 tests green (fakes exercise the driver, which is untouched). **Verify (live — PENDING):** a hidden background Run: attach log `input mode: synthetic when hidden`, `[INPUT] …(synth)` traces with the debug toggle, [CDP-TIME] slowest-fields collapsing, audits clean; then a `forceTrustedInput` run to confirm the kill-switch restores the old behavior. **SAME-DAY LIVE RESULT → SCOPED (the sign-in stall):** three hidden Runs each stalled at the AUTH screen — Apply/Apply-Manually/Sign-In-tab clicks and the email/password fills all worked synthetically (read-backs OK), but the **Sign In submit never produced an outcome** (both clicks + the retry; `auth-unknown` after the 15s ceiling). The auth screens are the ONE surface the synthetic repertoire was never proven on (the page engine only ever filled application FORM pages; onboarding has always been trusted-input) — most plausibly the auth app doesn't register native-setter values in its own state, leaving the submit inert/disabled, or its submit ignores untrusted clicks. Not worth blind-debugging remotely: synthetic input is now a per-run OPT-IN (`cdpSetSyntheticInput`, reset at attach) enabled ONLY by the FILL entry points (`runCdpWalk`, `runCdpFillPage`) — where the minutes are and where the repertoire is proven — while ONBOARDING/AUTH, the REPLAY walk (submit-adjacent, stays battle-tested), and recon keep trusted input (~15–25s total on auth, acceptable). If the trusted sign-in STILL stalls on the next run, the suspect is the (also-new, never-live-exercised) batched input sends — revert those next. **LIVE-VERIFIED same day (Magna wd3, full hidden background Run):** trusted sign-in worked (wrong-creds → create-account → form, the normal flow — batched sends fine), the walk logged `synthetic input ENABLED`, and the fill collapsed: page 1 **13.3s** (3 option-cache hits, zero cold re-opens), page 2 **329.8s → 11.3s (~29×)**, page 3 **64.5s → 4.1s**, page 4 **17.5s → 1.1s** — ~30s of fill for the whole 4-page application, truly hidden, `pacing hidden-fast` throughout, **M40 audits clean on every page (47 fields re-read, all matched), 0 need review, reached the review page**. The whole 2026-07-25 speed arc ([CDP-TIME] evidence → CSP bypass → input-pipeline diagnosis → synthetic-input mode) is live-proven; merged to main.
- **Multi-tenant live-testing sweep — Caterpillar / Solar Turbines (cat.wd5), 2026-07-25/26.** The first sweep after the speed round; every fix below came from a real halt or a wrong-looking review row, and each is unit-pinned. **ONBOARDING:** the create-account consent is labeled **"I accept"** (not in the consent word-list, and not in an associated `<label>`) → `cdpConsentRect` gained the word + `aria-label` + a nearest-SMALL-ancestor text fallback, and `submitAndWait` re-runs `checkConsent` before every re-click (`beforeRetry`) so a missed box self-heals; the auth widget can **OPEN on the Create Account view** with sign-in behind "Already have an account? Sign In", and since BOTH views carry email+password the old "a credential field exists ⇒ we're signing in" test filled the CREATE-ACCOUNT fields and pressed CREATE ACCOUNT while logging "Sign In submit" → `onSignInView`/`onCreateView` key on the SUBMIT markers, `switchAuthView` clicks the link (page-side element-click fallback when the widget's own `h3#authViewTitle` false-positives the cover-check; submit + federated buttons excluded) and POLLS for the target view before any field is touched. **FILL:** a section field's id AND widget are both tenant-variable (education school = `formField-school`, a multiselect TYPEAHEAD where Magna renders text) → the `fmMatchesFd` resolution ladder (`labelRegex` | `field` | `altFields[]` | `labelFallback`, two-pass so a fallback never steals an id-named field) + **widget-adaptive fill** (the LIVE DOM wins; the value re-resolves for it and goes through that widget's own ladder + commit verify); the already-filled SWEEP uses the same ladder plus a wrapper-level (`auditLoc`) guard, so a renamed field this run FILLED is no longer re-surfaced as a duplicate "already on the form" review row. **Answer buckets now fill REPEATING entries** (operator's design): inside a repeating section every entry shows the SAME wording, so the bucket identifies WHICH FIELD and the entry ORDINAL picks WHICH VALUE (read from the entry's own item — inherently index-correct); fires only for entry fields the map didn't claim, the bucket's path root must name the section, and Mode-B (a fixed value) deliberately does NOT fire per-entry. **New `checkbox_group` widget** for the OFCCP disability self-ID (2+ checkboxes in one wrapper acting pick-one; the tenant refuses a second check while one is set) — label-EXACT match, unchecks the current option first, verifies exactly one ends checked, options read from the DOM by the scan so a BLANK voluntary question still reaches review as a picker; wired through the M40 audit + `replayField`. **Flat DATE composites** were classifying as `unknown` (their spinbuttons carry no `type`, so 3 of them failed the "exactly one text input" test) → now `date` + `dateSegments` → `date_order`, so review renders the form's own MM/DD/YYYY. **ORPHAN consent checkboxes** (Caterpillar's page-1 SMS/marketing consent lives OUTSIDE any `formField-*` wrapper — cascade timing and a blur fix were both red herrings) are inventoried read-only and left UNCHECKED; an OPTIONAL one is visible in ALL FIELDS but never a review item. **Typeahead pre-scrape SHORT-CIRCUIT:** with a COMPLETE start-scrape, candidates absent from the list are never typed and a total no-match skips the walk straight to the AI rescue. **Second, FREE cascade pass** after the capture+audit (which already spend ~1s of real settle) catches a reveal that was still rendering when the first pass fired, for the price of one read-only scan; plus `act.blurActive()` before the reveal passes for blur-gated commits. **WALK:** `clickPageNext` re-measures the footer on every cover round (a revealed field REFLOWS it downward, and the stale point read as "covered by a floating extension widget"), and `cdpCoverCheck` walks the whole `elementsFromPoint` stack treating `click_filter`, `pointer-events:none` and non-painting shadow HOSTS as see-through. **REVIEW ORDER = FORM ORDER:** `orderResultsByDom` sorts records by document position (a section takes its first field's position; stable; unpositioned records inherit their neighbour's key) so a flat field between two sections no longer renders above both. **WEB/teach:** two-axis routing — the question WORDING and the ANSWER are independent, so a new-wording + new-answer card gets a MERGED side-by-side popup, and a scalar field holding a different value files the tenant's phrasing in the answer-VARIANT ladder instead of OVERWRITING the profile value (race "Asian" was about to be replaced by "Asian (not hispanic or latino)"); `fieldHoldsAnswer` counts the variants ladder so a taught variant stops resurfacing; "Wrong field?" now picks the field directly on the profile panel (retarget mode) instead of a popup over it; every profile field's bucket ships with its own name as a default wording (websites use their TYPE — LinkedIn / GitHub / Personal Website — never "URL"); website URLs normalize to full `https://` at the schema level (lockstep with `ensureHttps`); new profile field "Willing to relocate at your own cost". **Verify:** extension **716** + web **59** tests green; tsc + next build clean. Live-verified progressively across the sweep (each fix re-run on the tenant that produced it).
- **Cleanup (button sweep):** pruned ~27 one-off debug/recon/test popup harnesses + their full logic (button + popup.js handler + background.js dispatch + runner, in lockstep) now that the bugs they diagnosed are long fixed and the full-page fill exercises the same paths. REMOVED buttons/runners: `cdp-fill` (simple-widgets, superseded by the fold), `cdp-fill-page-nolock` (input-lock oracle baseline — its `skipLock`/`noLock` plumbing deleted; the lock is now unconditionally installed for the fill), `cdp-source-fill`, `cdp-source-ai-debug`, `cdp-audit` (M40 standalone re-audit), and the section/single-widget fill harnesses `cdp-fill-websites`/`languages`/`work-experience`/`education`/`certifications`/`date`, plus the bug/feature recons `cdp-resume-recon`/`cdp-ta-stray-recon`/`cdp-fos-recon`/`cdp-fos-capture`/`cdp-fos-focus-recon`/`cdp-tree-recon`/`cdp-tree-drill-recon`/`cdp-results-banner-recon`/`cdp-inputlock-recon`/`cdp-cert-specialty-recon`/`cdp-textarea-recon`/`cdp-cascade-recon`/`cdp-generic-section-recon`/`cdp-generic-nested-recon`/`cdp-replay-page`, the AI-4 test harness (`cdp-test-ai4`/`-unfixable`), and the now-orphaned `ta-label` + `results-banner-query` inputs. **KEPT (operator-confirmed):** the production flow (`load-profile`, `fill-page`/`walk-pages` page-engine, `cdp-fill-page`, `cdp-walk`, `view-summary`, `clear-summary`, resume upload, AI config, company) + the FIVE documented new-tenant recon probes (`cdp-recon`/`cdp-repeat-recon`/`cdp-session-recon`/`cdp-questions-recon`/`cdp-page-recon`). Shared brain untouched: `replayFlatFields` (fill-driver.js, still unit-tested, now uncalled until M2 replay), `remediatePageErrors`/`fillAndPersistPage` and all `act`-interface reads stay. **This SUPERSEDES the post-M35 "KEPT" list above** (`cdp-source-fill` + the section harnesses `cdp-fill-websites`/`languages`/`date` are now removed). Popup 34→13 buttons; `node --check` clean on background.js/popup.js; grep-verified zero dangling refs; 452 tests green.


## Superseded section content (retained build history)

The two per-milestone bullets below lived in CLAUDE.md's "CDP off-loop actuation" section, marked as retained build history after the 2026-06-29 merge collapsed the separate typeahead (M25) and source (M26) fillers into the ONE hierarchical-typeahead filler (`fillTypeaheadCdp`). For CURRENT behavior read CLAUDE.md + dom-patterns 2026-06-29; these document how the merged filler's guarantees were originally derived.

- **Typeahead (M25) = the proven Magna brain on this substrate** (`fillTypeaheadCdp`, fill-driver.js). Per-candidate tier walk; transition-aware settle requiring a FRESH change since the candidate's own filter-Enter (the pre-filter fallback list is STABLE — matching it was the historic false-fill — and a STALE banner survives input clearing); banner (`promptTitle` "No matches found") = HARD BLOCK; match ONLY the current candidate; the ONLY commit signal is the `selectedItem` chip normalize-equal to the matched option — never option text. **Focus hygiene (load-bearing):** a banner DROPS searchBox focus, so before EVERY candidate's clear/type we re-assert + READ-VERIFY `searchBox.focused` (re-open if it unmounted); if focus can't be confirmed → `needs_review` "could not focus — not actuating blind", STOP. Without this, a post-banner Ctrl+A selects the whole PAGE, the query never lands, and the widget's type-ahead-HIGHLIGHT + filter-Enter commits a STRAY row 0 (the live "Afghanistan" stray). **Honesty:** a final chip read → a record never reports `after:null` when the page holds a value (an uncommanded stray is flagged). **Pre-filled guard:** a chip matching a candidate is KEPT with zero actuation (countryPhoneCode is auto-derived from Country — the common case, live-proven incl. surviving a same-value Country re-commit); a mismatched pre-fill is flagged, never overwritten (overwrite = M25.1). **Commit ladder:** single-exact AUTO-COMMITS on the filter-Enter (chip may carry the FULL option name — accepted only on normalize-equality, else flagged); multi-match commits via a **TRUSTED CDP CLICK** on the matched option (text-keyed; short-list proven, long-list UNTESTED — the Uruguay condition) because **NO highlight ever arms under CDP-injected typing** (aria-activedescendant null with insertText AND per-char keystrokes — the spec's second-Enter was a human-typing behavior). Enter is the ONLY filter trigger (typing alone does not filter — verified). Targeted harness: popup "CDP fill one typeahead" (`RUN_CDP_FILL_TA`, label regex, entry-scoped composed selectors).
- **Source (M26) = a SEARCH typeahead on Magna** (`fillSourceCdp`, fill-driver.js): the "How did you hear about us?" picker shows ~13 chevron CATEGORY rows on open, but typing into the searchBox FILTERS straight to leaves — so it's driven like the typeahead (categories bypassed). Mirrors the M25 walk (focus hygiene, transition settle, banner block) with source deltas: leaves = `promptOption` + `data-automation-label` (NOT role=option), **chip-excluded** (a committed chip elsewhere embeds a promptOption — the contamination that cost a recon round); commit-verify = the matched leaf's `promptLeafNode` `multiselectlistitem-isselected` flip OR a `selectedItem` chip. Candidates from `profile.how_did_you_hear` (WINS) → `defaults.how_did_you_hear` fallback (preferred + fallback) — profile-driven, the earlier "policy not profile" rule RETRACTED. Wired into `drivePageFill`. On a genuine no-match (AI on) `tryInlineAiSource` runs a **TWO-PROMPT DRILL with scroll-enumerate + TYPED commit** (DOM facts: typing does NOT drill — it filters the WHOLE tree and a UNIQUE match autocommits; clicking a category chevron drills it; lists are VIRTUALIZED — scroll to see every option; the same label can sit in multiple trees, e.g. two "Other", so a typed filter shows >1 → commit the TOP): (1) `scrapeSourceRows` scroll-enumerates ALL categories → Prompt 1 picks one; (2) `expandCategory` drills it — **the decisive fix**: the chosen category row is **react-virtualized and renders BELOW the viewport fold**, and CDP clicks at VIEWPORT coords (`cy > innerHeight` = dead space), so `cdpSourceRowRect` `scrollIntoView`s the row into the visible viewport (it scrolls the PAGE + ancestors, not just the inner list), re-queries after each settle (recycle-safe), and **validates with `document.elementFromPoint(cx,cy)` before the trusted click** — clicking the **`promptLeafNode`** (the node carrying the onClick/DRILL handler — NOT the `menuItem` role=option, which has only mouseover/contextmenu, nor the `promptOption` text). Then `scrapeSourceRows` scroll-enumerates ALL its leaves → Prompt 2 picks a SEEN leaf; (3) commit DIRECTLY on the still-open field (do NOT re-enter `fillSourceCdp` — its `openSource` re-opens + disturbs the settled view): **focus → Ctrl+A+Delete (`clearSourceSearch`, clears the leftover no-match query) → type the leaf → Enter** (autocommit a unique match / click the TOP on a multi-tree tie); ONE focus, no settle-wait (live-confirmed: a single focus → clear → type lands the value). The AI only ever types a leaf it SAW (no blind guessing). Cert keeps the click-in-drilled-view drill (`aiTreeFallback`); source can't use that because its drilled "Other" is the CATEGORY chevron, which re-drills instead of committing. **LIVE-VERIFIED on Magna** (carrier-pigeon profile → deterministic no-match → AI category drill → leaf pick → typed commit). Isolated harness: popup "Source AI (isolated)" (`RUN_CDP_SOURCE_AI_DEBUG`).

## 2026-07-05 — Review-summary fixes: page-1 choice-field recon + clearer tier editor

Three operator-reported bugs from a live Magna page-1 fill (all in the fill→review contract, no walk change):

- **Bug 1 — tiered-typeahead review UI (`summary.js` `tierEditor`).** A hierarchical/optionless-typeahead field (e.g. `source` "How Did You Hear About Us?") rendered the actually-filled value ("LinkedIn") ONLY as candidate "1." inside a list labeled "value to try" — reading like it hadn't been filled. Added a read-only **"Filled" box ABOVE** the candidate editor (`renderFilled`, re-rendered on every tier edit + on the row `set()` refresh) plus a "Values to try on re-fill" caption on the list, so the filled value is unambiguous and the tier list is clearly the re-fill order. New CSS `.tier-filled*` / `.tier-cap` in `summary.html`. Source stays a tier editor (trees are never scraped) — this is exactly its target case.
- **Bugs 2+3 (same root cause) — page-1 flat choice fields showed as textboxes in review (`fill-driver.js` `captureChoiceOptions`).** A tier-0 `dropdown-prefilled-kept` dropdown (country/state/phone) and a `prefilled-kept` typeahead (countryPhoneCode) return with NO options (a zero-actuation keep never opened the widget), and `captureChoiceOptions` only reconned repeating-section fields (`/\[\d+\]\./` dropdowns + `captureOptions`-tagged typeaheads) — so page-1 choice fields had `options:null` → the viewer degraded them to a plain textbox, unlike page-2. **Fix:** dropped both restrictions; `captureChoiceOptions` now reconstructs options for ANY optionless filled choice field via the existing read-only helpers (`captureDropdownOptions` = open→enabled-texts→`closeAndVerifyBlank`; `captureFieldOptions` = open→`scrapeTaOptions`→Tab). The `!rec.options.length` guard means only the few prefilled-kept flat lists actually re-open — the M27.C cold-list cost, **paid deliberately** so review shows a real `<select>`/combobox. Cache keys on the fieldName stem (flat fields key distinctly; repeating share a stem).
- **Invariant relaxation (operator-approved).** This re-opens tier-0 pre-fills, which the named **M27.C (dropdown "NO re-open")** and **M36.1 (typeahead "no open")** invariants literally forbade. Operator call 2026-07-05: allow it — the recon is READ-ONLY (never type/clear/Enter/leaf-click → value preserved) and runs BEFORE the M40 audit, which re-reads every value and backstops any stray. The 4 invariant tests were retargeted from "zero actuation / no open" to the TRUE property: **no value-changing mutation** of a tier-0 pre-fill (deny `clickDropdownOptionByText`/`typeJumpChars`/… for dropdowns, `typeInHier`/`clearHierSearch`/`pressEnter`/`clickHierLeaf`/… for typeaheads) + `after` unchanged. Two capture-behavior tests flipped (untagged flat typeahead + flat dropdown now captured). CLAUDE.md updated in the two tier-aware-guard bullets + the `captureChoiceOptions` bullet. Unit suite green (`npm test`, 465 tests). Live-verify pending (eyes-on the review page after a page-1 fill).

## 2026-07-06 — Follow-up: countryPhoneCode review recon (typeahead scrape hardening) — LIVE-VERIFIED

The 2026-07-05 page-1 recon worked for flat dropdowns (country) but `countryPhoneCode` (a flat prefilled-kept
typeahead) still rendered a textbox in review — `[CDP-SCRAPE-TA]` logged `0 options [role=2 prompt=2]` despite
the list visibly opening. Root cause (see dom-patterns 2026-07-06): the 2 `role=option` nodes were the
selected-value CHIPS (chip-contamination), which locked the selector + were then filtered out, and the real
`promptOption` leaves mount a beat AFTER the searchBox turns visible. Fix in `cdpScrapeTaOptions` (cdp.js):
exclude chips before choosing the selector, and frame-poll until real non-chip leaves render before scraping
(role=option → promptOption fallback; returns roleCount/promptCount/usedSel for triage). FoS resolves at
frame 0 (unchanged). **LIVE-VERIFIED on Magna** — countryPhoneCode now shows a searchable option list in the
summary. Unit suite green (465 on the branch; 482 on merged main). Merged to main.

## 2026-07-06 — Dropdown OVERWRITE commit: elapsed-time-adaptive debounce beat (replaces the hardcoded 700ms)

Follow-up to the dup-language fix (see dom-patterns 2026-07-06 Vector A). Committing a RE-SELECTION (replacing
a real prior value — the pre-filled+flipped languages) failed under fast pacing: the trusted coordinate click
landed on the correct portaled option (`hitTarget=true`) but didn't fire its selection. Confirmed via
`forceWorkerTimersOff` that the slow (all-`delayFull`) path commits on the first click — it's a Workday-internal
option-click DEBOUNCE after the list opens, and fast pacing clicks inside it. The first fix was a hardcoded
non-adaptive `act.delayFull(~700ms)` before an overwrite's commit click (live-verified — languages committed
correctly visible AND hidden). The operator then asked to make the wait adaptive rather than pay it flat on
every overwrite.

- **Recon FIRST (per the working principle — trace, don't guess):** a temp read-only sampler
  (`cdpDropdownReadinessSample` + `act.sampleDropdownReadiness`) logged the just-opened list's readiness signals
  every 100ms across the 700ms window — `aria-expanded`, listbox-present, enabled-option count,
  `opacity`/`visibility`/`pointer-events`/`transition`, `aria-activedescendant`, selected-option, listbox rect.
  **`[DD-READY]` result: every signal is at its settled value from t=0 — NOTHING flips 0→700ms.** So the list
  is fully DOM-READY immediately; the debounce has NO pollable DOM correlate. (Operator confirmed the recon run
  committed English + Chinese correctly.)
- **First fix — elapsed-time beat.** `fillDropdownCdp` records `openedAt` at `aria-expanded="true"` and the
  overwrite beat waited only the REMAINDER of ~700ms since open. Removed the temp sampler
  (`cdpDropdownReadinessSample` + the `sampleDropdownReadiness` method).
- **Final shape — FAST-FIRST with a slow refill fallback, VISIBILITY-SPLIT beats (operator asks: "fill fast,
  refill slower only if it misses; log the refill rate to tune", then "make visible and hidden different").**
  For an overwrite, **attempt 1 FAST** waits only the fast beat since open, clicks, and confirms with a SHORT
  failure deadline (`min(overwriteFailFastMs, commitCeilingMs)`, default 600ms) so a miss is caught cheaply. On
  a MISS, **attempt 2 refills SLOW**: re-open if the list closed, wait the slow beat since the (re-)open,
  commit with the full ceiling. **The beats split on REAL tab visibility** (`act.visible` = `cdpVisible`, now
  exposed to the fill layer — tab active + window not minimized, NOT `cdpFast` which is true for hidden+worker-
  timers) because the debounce is a PAINT thing (tiny visible, ~700ms hidden): **VISIBLE = fast `30` / slow
  `100`; HIDDEN = fast `120` / slow `700`** (`overwriteFastBeatMs`/`overwriteSlowBeatMs` + `*VisibleMs`). A
  `[CDP-DD-REFILL]` line logs `VISIBLE|hidden fastBeat=Nms → committed on FAST attempt | MISSED fast → refilled
  slow` per overwrite for retuning. `commitByClick` gained an optional ceiling arg; the commit-PERSISTENCE
  re-read still gates every accept → a fast miss can only cost a slow refill, NEVER a wrong/silent fill. EMPTY
  fills skip the beat (rapidfire, unchanged).
- **Live-tuning history:** 300 (initial) → 70 hidden (BOTH languages refilled — fallback verified) → 100 hidden
  (committed fast) → visibility split, 30 visible (committed fast) / 100 hidden → hidden bumped to 120 (small
  margin over the verified-fast 100). All live-verified on Magna.
- Docs synced (CLAUDE.md dropdowns rule, dom-patterns Vector A FINAL SHAPE). New unit tests pin the slow refill
  (a fast miss re-opens and commits, ending `filled` — never left flipped) and the visibility split (visible
  fast beat < hidden's). `node -c` clean; unit suite green (**485**). Merged to main.

## 2026-07-06 — Dropdown CLOSE race in the FILL path: gate on options-GONE, not aria-expanded

Operator report on this branch: dropdowns don't close instantly — the next action must wait for the listbox
to be closed / options === 0 or the dropdowns race. The RECON close was already hardened to gate on
listbox-GONE (`closeAndVerifyBlank` / `awaitTypeaheadClosed`), but the FILL path had two gaps (both byte-
identical on main — the recon-close hardening never reached them, so main was NOT actually fixed here):

- **`closeDropdownConfirmed` gated on `ariaExpanded`** (used by the tier-KEEP + genuine-no-match returns).
  aria flips `"false"` the instant Escape/commit fires, but the options linger a beat while they unmount and
  STAY CLICKABLE → returned early → the next field's open-click strayed onto a lingering option. Fixed to the
  SAME gate as the recon close: `stillOpen = listboxPresent && optionCount > 0`; poll (re-Escaping) until the
  options are gone.
- **The SUCCESSFUL COMMIT return didn't close-confirm at all** — it returned `filled` while the list was still
  unmounting. Now every `fillDropdownCdp` return that opened the list (successful commit, commit-failed,
  tier-keep, no-match) calls `closeDropdownConfirmed` before returning.

`closeDropdownConfirmed` exported + unit-pinned (aria always `"false"` yet options linger 2 reads → the gate
must keep polling until `optionCount === 0`; an aria-only gate would Escape zero times). Happy path adds ~1
read (options already gone → immediate). Docs synced (CLAUDE.md close-gate invariant, dom-patterns entry).
`node -c` clean; unit suite green (**484**). **LIVE-VERIFY PENDING** with the fast-first change before merge.

## 2026-07-06 — Required-radio AI fallback (`aiFillRadio`) — the deferred milestone, BUILT (live-verify pending)

A REQUIRED radio the deterministic pass can't answer was left BLANK, which BLOCKS Save & Continue (and halts
the walk). Reported live: `candidateIsPreviousWorker` on Magna with no `jobContext.company` set → `decidePreviousWorker`
"unevaluable" → blank + review. Built the deferred required-radio AI fallback, mirroring the dropdown AI-1
(`aiFillField`) exactly:

- **`aiFillRadio` (fill-driver.js)**: read the live radio labels → LLM infers the best option from the profile
  → the pick must clear the match ladder vs the live labels (never blind-commit) → commit via the proven
  `fillRadioCdp` (label-click → focus+Space → read-back verify) → ALWAYS `filled_review`, never silently trusted.
- **Dispatch**: a dedicated post-pass in `drivePageFill` (NOT via `aiEligible`, which stays radio→false — mirrors
  the typeahead pass), gated `act.aiEnabled && f.isRequired && widgetType==="radio" && record.resolved == null &&
  status not filled/filled_review`. The `resolved == null` gate is the load-bearing SAFETY: a decision the
  deterministic pass already made but failed to commit (e.g. a matched employer "Yes") is NEVER overridden by a
  contradictory guess — it stays review-flagged.
- **Flagging**: `candidateIsPreviousWorker` is force-flagged `ai-choice-sensitive` (LEGALLY-LOADED badge — it sits
  next to a truthfulness certification; a wrong "Yes" is a false statement); a low-confidence guess auto-escalates
  to super-hard in the viewer. A demographic radio → `ai-eeo-guess` (re-tagged at the call site). The
  truthfulness-cert invariant holds under AI: a "Yes" is ALWAYS `filled_review`, never plain `filled`.
- **Optional / AI-OFF**: never fires (a blank optional radio doesn't block; unit-pinned).

8 new unit tests (473 total, green on the branch). `aiEligible` unchanged (radio still excluded there — the AI
runs through the separate pass). CLAUDE.md updated (AI safety/eligibility bullet + open-items). **HARD GATE per
CLAUDE.md: live-verify eyes-on, on a DISPOSABLE application — this changes a truthfulness-cert-adjacent field.**

## 2026-07-06 — Detach-cleanup + blocking-popup detection on Save & Continue (operator UX)

Two robustness fixes (CDP substrate; live-verify pending):

- **External detach strands the input-lock overlay → onDetach cleanup.** The native `chrome.debugger` infobar's
  "Cancel" detaches MID-RUN; the run's `finally → removeInputLock()` goes through `cdpEval`, which can't reach the
  now-detached page, so the "⏳ ApplyPilot is filling this form — please don't click or type" overlay was left
  STUCK. Fix: the `chrome.debugger.onDetach` listener (cdp.js) now tears the overlay down via
  `chrome.scripting.executeScript(cdpRemoveInputLock)` (no debugger needed; self-contained; no-op if never
  installed). So Cancel ⇒ detach **+ remove the lock banner**. NOTE the "started debugging" banner is Chrome's
  NATIVE infobar — the extension can't add/intercept its X/Cancel; merely dismissing it (without detach) already
  leaves the run running, so there's nothing to change there.
- **Blocking popup over the Next button → detect + log, don't swallow.** `clickPageNext` did a coordinate click
  at the button rect without checking what's on top; a popup/overlay (Simplify's dialog, a consent modal) would
  swallow the click and surface as a bare nav-timeout. Fix: `elementFromPoint` the button's center first — if the
  top node isn't the button (or its subtree), refuse `{clicked:false, refused:"blocked", blockedBy:<descriptor>}`
  and log "Save & Continue is COVERED by an overlay/popup — Blocked by: <tag#id[data-automation-id].class \"text\">".
  The walk halts `click-refused:blocked` with `blocked_by` in the result (self-explaining, not a generic error).

Unit suite unaffected (490 green — these are substrate methods, not unit-tested). CLAUDE.md updated (input-lock
bullet + the multi-page clickPageNext note).

## 2026-07-06 — Operator-cancel cause on the summary page + world:MAIN overlay teardown (live-verified pieces)

Live testing of the detach/banner behavior surfaced two fixes:

- **Stranded input-lock overlay on Cancel → `world:"MAIN"`.** The overlay is installed via `cdpEval` (CDP
  Runtime.evaluate → the page's MAIN world), so `window.__apLock` lives there. The onDetach cleanup used
  `chrome.scripting.executeScript` WITHOUT a world → ran in the ISOLATED world where `__apLock` is undefined →
  `cdpRemoveInputLock` no-op'd and the "please don't click or type" banner stayed STUCK after Cancel. Passing
  `world:"MAIN"` fixes it. **LIVE-VERIFIED**: Cancel now clears the banner (operator confirmed). X and Cancel
  BOTH detach (Chrome-native infobar, indistinguishable) — accepted; no auto-reattach.
- **Operator-cancel cause on the summary (+ SW log).** A mid-run detach makes the in-flight fill's CDP calls
  fail, and the errors looked causeless. Now `chrome.debugger.onDetach` writes a `lastRunAbort` marker (reason
  `operator-cancelled` when Chrome's `reason==="canceled_by_user"`, else `debugger-detached`), cleared at the
  next `cdpAttach`. The SW log says "⛔ OPERATOR CANCELLED mid-run …", and `summary.js` renders a red
  `abort-banner` at the top (shown even when the cancel wrote no bundle) explaining the incomplete/errored
  state. Unit suite unaffected (490 green). CLAUDE.md input-lock bullet updated.

- **Perf: batched M40 audit re-read (one round-trip — hidden-run speedup).** The M40 audit re-read every actuated field with one `cdpEval` PER FIELD → N serial SW↔page round-trips; on a HIDDEN tab (the slowest fill mode, where each debugger round-trip costs most) that IPC latency stacked up. New `act.readAuditRaw` (cdp.js `cdpReadAuditRaw`) reads ALL fields in ONE `Runtime.evaluate` by COMPOSING the single-source reader fns (`cdpReadTextState`/…/`cdpReadSourcePick` via `.toString()` inside one scoped IIFE — NO body duplication, so no new lockstep hazard) + a per-widget dispatcher; returns a parallel array of RAW reads (a "date" entry → an array of per-segment reads). The `{actual,readable}` MAPPING stayed SW-side, extracted to the pure `auditActualFromRaw` (Node-tested) and shared by BOTH the per-field `auditReReadActual` and the batched path — identical verdicts, only the fetch changed N→1. `reconcileAudit` fetches the batch once (guarded: absent method / wrong-length / throw → per-field fallback), and the mismatch→refill re-read STAYS per-field (a fresh read of the one re-filled field). A single snapshot is also more consistent than N reads spread across the pass. 497 tests (+4: verdict PARITY vs the per-field path across every widget + one-round-trip/no-per-field-reads spy, whole-page one-call, wrong-length fallback, throw fallback); composition parse+dispatch validated in a standalone harness. **Live-verify PENDING** on a hidden CDP fill (unit-green + composition-checked; behavior is verdict-identical to the proven path).
- **Fix: dropdown OVERWRITE commit uses an ESCALATING BEAT LADDER (occlusion / alt-tab fix).** The overwrite commit split its beat off `act.visible` (`tab.active && !minimized`): VISIBLE pair `[30,100]`, HIDDEN `[120,700]`. Live-found: a tab **alt-tabbed BEHIND another app is OCCLUDED** — Chrome stops painting it (throttled like hidden) — yet it still reports `tab.active && !minimized`, so `act.visible` mislabels it "visible" and used the `[30,100]` pair; the option-click DEBOUNCE is a PAINT thing that needs ~700ms when not painting, so BOTH beats missed → the two `language` dropdowns commit-failed / swapped to `needs_review` (safety held — never a wrong fill). Occlusion is NOT reliably detectable: extension APIs expose no occlusion flag, `win.focused` can’t separate "unfocused-but-visible" from "occluded", and the page’s `visibilityState`/`rAF` are spoofed/polyfilled by our own hidden-tab overrides. So instead of detecting the state, the commit ESCALATES: `overwriteBeatLadder` returns an ASCENDING ladder (VISIBLE `[30,100,700]`, HIDDEN `[120,700]`), and on each MISS the commit re-opens + waits the next-larger beat, up to the ~700ms tier REGARDLESS of the label. A painting tab commits on tier 0 (no penalty); a mislabeled/occluded tab self-corrects to the big beat instead of failing. The commit-PERSISTENCE re-read gates every accept, so escalation only ever costs extra re-opens — never a wrong/silent fill. `[CDP-DD-REFILL]` now logs the ladder + which tier committed. 500 tests (+3: `overwriteBeatLadder` ascending/deduped, a VISIBLE-labeled commit that only takes at the 700 tier escalates + commits `filled`, a never-committing commit exhausts the ladder → `needs_review`); existing fast-first + visibility-aware beat tests still green. **Live-verify PENDING** on a genuinely hidden/occluded tab.
- **Follow-up: final ~5s safety tier on the overwrite ladder.** Appended `overwriteMaxBeatMs: 5000` to BOTH ladders (VISIBLE `[30,100,700,5000]`, HIDDEN `[120,700,5000]`) so a deeply-throttled/occluded tab that even the 700ms tier misses gets one last 5s attempt before `needs_review`. Only ever reached after every shorter tier misses (a stuck field headed for review anyway), so it costs the common paths nothing; the persistence gate still guards correctness. `overwriteBeatLadder` test updated; 500 tests green.
- **Batched M40 audit — LIVE-VERIFIED (hidden) + temp logging removed.** Confirmed on a genuinely HIDDEN Magna page-2 fill: `batched 14ms (1 round-trip) vs per-field 92ms (40 round-trips) → saved ~78ms; disagreements: 0` (the batched read returned the identical live value for all 40 fields the old per-field path would have). Per-field cost ~2.3ms/read hidden vs ~1.8ms visible — each round-trip costs more hidden, so collapsing 40→1 helps hidden most, as predicted. The throwaway `[PERF-TEMP]` diagnostic block (+ its per-field comparison pass) is now REMOVED; only the single batched read remains. 500 tests green.
## 2026-07-06 — Best-effort auto-dismiss of a popup covering Save & Continue (shadow-DOM aware)

Follow-up to the blocking-popup DETECTION (which live-verified). Operator opted into auto-CLOSING the popup so
the walk can proceed. Live case: the blocker is `div.simplify-jobs-shadow-root` — Simplify renders into a
SHADOW DOM, so its X button lives in `host.shadowRoot` and is invisible to a light-DOM query / `elementFromPoint`
(which only ever returns the shadow HOST).

- **`cdpFindDismissControl(cx,cy)`** (cdp.js): reads the blocker at the button's center; searches its OPEN
  `shadowRoot` (Simplify) or, for a regular modal, its subtree climbed to a dialog/overlay ancestor. Returns the
  viewport rect of ONE clearly-dismissive control — X-glyph / aria-label|title|class close|dismiss / text
  "Close"/"No thanks"/"Not now"/"Skip"/"Dismiss" — for a trusted click. **SAFETY**: an affirmative deny-list
  (`accept|agree|ok|got it|allow|yes|confirm|continue|submit|save|…|autofill|apply`) is checked FIRST, so a
  consent/accept button is NEVER clicked; big containers (>120px) are skipped (target the icon, not the panel);
  a CLOSED shadow root or no safe control → not-found. Never removes/hides DOM.
- **`clickPageNext`**: on a detected block, try the dismiss ONCE (trusted click on the control), poll ~1.5s for
  the cover to clear (`elementFromPoint` no longer the blocker), then click Save & Continue → `{clicked:true,
  dismissed}`. If it stays covered / no safe control → the existing halt `click-refused:blocked` (+ `dismissTried`).

Unit suite unaffected (490 green — CDP substrate). CLAUDE.md multi-page `clickPageNext` note updated. Live-verify
pending on the real Simplify overlay.

## 2026-07-06 — Simplify auto-dismiss LIVE-VERIFIED + English-last language order

- **Simplify overlay auto-dismiss — LIVE-VERIFIED.** The blocker-dump recon showed `div.simplify-jobs-shadow-root`
  has an OPEN shadow root with a `<button aria-label="Minimize">`. Added `minimi[sz]e` to the dismiss-control
  matcher (NOT "collapse" — that matches Simplify's "Collapse Resume Section" sub-control). `clickPageNext` now
  minimizes Simplify's panel and advances past Save & Continue (operator confirmed: "it minimizes and advances").
  The DIAG blocker dump was removed.
- **English filled LAST (`prepareProfile`).** Operator found that ordering English last in the Languages section
  reduces Workday's spurious "duplicate languages not allowed" ghost error on Save & Continue. `prepareProfile`
  now stable-partitions `out.languages` (non-English first, English last) before the CDP fill consumes it.

Unit suite green.

## 2026-07-06 — Session round LIVE-VERIFIED on Magna (review fixes + detach/popup/radio)

Operator live-verified the full round on Magna wd3; all shipped to main:
- Review summary: tier-editor "Filled" box; page-1 flat dropdown/typeahead recon (country → real `<select>`;
  countryPhoneCode combobox — chip-exclusion + wait-for-render + promptOption fallback in `cdpScrapeTaOptions`).
- Required-radio AI fallback (`aiFillRadio`): `candidateIsPreviousWorker` unevaluable → AI-guessed, LEGALLY-LOADED
  flag, never blank-blocks.
- Input-lock/detach: `world:"MAIN"` teardown clears the "please don't click or type" banner on Cancel; X/Cancel
  both detach (accepted); a mid-run detach writes `lastRunAbort` → SW "OPERATOR CANCELLED mid-run" log + a red
  `abort-banner` on the summary page.
- Save & Continue: blocking-popup detection; best-effort auto-dismiss — Simplify's `div.simplify-jobs-shadow-root`
  is minimized via its `<button aria-label="Minimize">` (open shadow root), then the walk advances.
- Languages: `prepareProfile` fills English LAST (reduces the ghost duplicate-language error).

The earlier per-feature "live-verify pending" notes are now superseded — this round is verified.

- **Onboarding walk (pre-form stage) — BUILT 2026-07-08, live-verify PENDING.** The stage BEFORE the fill walk: drive the active tab from a job-description page through **Apply → Apply Manually → sign-in / create-account → email verification → land on the form**, then (opt-in) hand off to the existing CDP fill walk. Port of the Playwright repo's `workday.py` onboarding state machine (`navigate_to_first_form_page`/`handle_application_modal`/`handle_auth_screen`/`_handle_email_verification`) + `gmail_client.py`, on the CDP substrate, hardened. See the new **CLAUDE.md → "Onboarding walk"** section + **`docs/gmail-setup.md`** (one-time setup).
  - **Manifest:** pinned extension **`key`** (public half of gitignored `secrets/ext-key.pem`) → stable ID `degflnkiejblbjcihdpmikekdgmbgehb` (adding the key resets the extension's storage — re-add + re-load profile/credentials); `identity` permission + `oauth2` (`client_id` placeholder + **`gmail.readonly` scope only**) + `gmail.googleapis.com` host.
  - **`gmail.js`** (NEW) — Gmail auto-verify adapter mirroring `llm.js` (never-throws, UMD, injectable fetch/now/sleep): `chrome.identity.getAuthToken` glue (Chrome owns the token cache/refresh — nothing stored; all data client-side), `gmailFindVerificationEmail` polls `from:workday.com newer_than:1h` (5s/120s, `internalDate` freshness guard), base64url MIME body walk, and extracts the first URL containing the tenant host → the SW `cdpNavigate`s to it. `gmailApiGet`/`gmailExtractBodyText`/`gmailExtractVerificationUrl`/`gmailBuildQuery` pure-tested (`test/gmail.test.js`, 13).
  - **`lib.js`** (pure decisions, `test/onboarding.test.js`, 11): `pickApplyTarget` (`adventureButton → continueButton → applyManually`, never `useMyLastApplication`), `classifyAuthOutcome` (`verify`/`wrong_credentials`/`success`/`unknown`), **`isWorkdaySoftError`** (the operator-requested "Something went wrong / please refresh" detector → one-shot reload), `looksLikeSso`.
  - **`cdp.js`** (NEW primitives): `cdpNavigate` (`Page.navigate`), `cdpReload` (`Page.reload` — the refresh), `cdpOnboardScan` (self-contained onboarding state read), `cdpCoverCheck` (parametrized cover-check), `cdpConsentRect` / `cdpNthPasswordRect` (create-account form).
  - **`background.js`:** `runCdpOnboard` (the state machine — sign-in-FIRST; `verify`→Gmail→re-sign-in; `wrong`→create-account→loop; capped attempts; `maybeRefresh` reload-once-capped; SSO/2FA/CAPTCHA/no-creds/verify-failed → self-explaining `needs_operator` halts; **contract: `ok:false` ⇒ crash only**) + `runGmailSmokeTest` (`RUN_GMAIL_TEST`) + the `RUN_CDP_ONBOARD` handler (chains into `runCdpWalk` ONLY if `onboardConfig.continueToWalk === true`, OFF by default — the fill walk advances a live app). No input-lock (a takeover halt leaves the operator free). Detaches in `finally`.
  - **Popup:** an **Onboarding** section — Load credentials (`data/credentials.json` → storage; non-dot — Chrome won't serve a dotfile via getURL), Start URL (optional; blank = active tab), Gmail auto-verify toggle + Connect/test, continue-to-walk toggle, Start.
  - **Safety unchanged:** never submits (the fill walk's double-guard is untouched); never clicks affirmative consent-popup controls. Credentials FIXED (same Gmail `+alias` account reused per tenant — why sign-in-first works). Two operator flags carried for live-verify: (1) restricted-scope Gmail verification is a public-launch step, not dev; (2) confirm the fetched verify LINK completes headlessly vs. being session-bound. 524 unit tests green (`npm test`). Live-verify + the eyes-on disposable-application run are the next step.

- **Onboarding walk — LIVE-VERIFIED (visible + hidden) 2026-07-10.** Ran end-to-end on three tenants: **Comcast** (create → straight to form), **altasciences wd1** (create → Gmail verify → navigate the activate link → account activated → re-sign-in → form), **Palo Alto Networks wd5** (social-login chooser → email form → create → verify → form). Gmail auto-verify proven (getAuthToken + readonly `users/me/profile` smoke test; the fetched `/activate/` link DOES complete on navigation — not session-bound on these tenants). Hardening discovered/added during live testing (each its own commit):
  - **Setup:** the pinned manifest `key` changes the extension ID (storage reset, re-add + re-load). getAuthToken (operator's choice over launchWebAuthFlow) with a **Chrome-Extension OAuth client** whose Item ID = the pinned ID; `gmail.readonly` only; the private signing key lives OUTSIDE the loaded folder (Chrome warns on a `.pem` in an unpacked extension). Standardized on **`data/credentials.json`** (non-dot — Chrome won't serve a dotfile via `getURL`); example renamed to `credentials.example.json`.
  - **Selectors/clicks:** try `[data-automation-id=…]` FIRST (canonical; avoids a ~2.5s `cdpRectReady` stall on a missing generic selector); Workday's transparent **`click_filter`** overlay is the click surface, not a blocker (`cdpCoverCheck`).
  - **Social-login chooser** (PANW): reveal the email form via `SignInWithEmailButton` (never the federated buttons); `looksLikeSso` returns false when an email button exists; if the reveal can't repaint hidden, halt `hidden-render-stalled` (foreground + re-run) instead of looping.
  - **Submit resilience:** pre-submit `cdpDelay(500)` FIXED (not paced — a scaled ~50ms click hit the not-yet-enabled button and no-op'd) + **`submitAndWait`** re-click fallback (both submits, up to 3 attempts, gated on the form still being up).
  - **Gmail:** query is **sender-agnostic** (`newer_than:1h (myworkdayjobs OR from:workday.com)`) — PANW sends from `Workday@paloaltonetworks.com`; prefer an `/activate` link over a job-listing link on the same host; **5s post-activation settle** before re-sign-in (immediate re-sign-in re-triggered a 2nd email — the PANW double-cycle); **click "Resend Account Verification"** (`cdpResendVerifyRect`) before polling when signing into an existing-but-unverified account (the original email is stale) → makes the flow idempotent across re-runs of a `+alias`.
  - **Hidden-safe pacing:** all click/type/transition pacing routes through `pace()` = `cdpAdaptiveDelay` (fast visible / full hidden), the 3 real server-commit waits stay fixed (`cdpDelay`); `cdpInstallPageOverrides` (worker-timers) + `cdpWakePage` + **`Emulation.setFocusEmulationEnabled`** keep a backgrounded tab repainting. A page whose CSP blocks the blob worker can't repaint a client-side transition hidden → the stall halts are the graceful net. (Reverted two mis-diagnosed attempts: a per-nav override re-install — redundant with the new-document hook — and a create-account reload — the page had actually rendered.)
  - **Merged to `main`.** ~526 unit tests green. NEXT: more tenants; the SSO-refusal + verify-link-session-bound halts on a tenant that trips them; then the to-review N-page fill walk (the disposable-app hard gate).

## 2026-07-07 — Review-page CHECK (end-to-end fill-verify) LIVE-VERIFIED on Magna

New read-only verification tool. The final Workday review page renders every value ACTUALLY in the form
as read-only text — the ground truth of what would submit. The CHECK scrapes those values and reconciles
them against the saved `reviewSummary` bundle (what the extension recorded it filled); a divergence flags
a fill bug. READ-ONLY — attach → read → detach; it NEVER clicks Next/Submit (the review page's footer
button IS Submit).

- **`reconcileReviewPage(reviewItems, bundleEntries)` (lib.js, PURE, `test/review-reconcile.test.js`).**
  DOM-agnostic — consumes `[{label, value}]` pairs. Buckets: AGREE / DISAGREE (page value ≠ recorded) /
  MISSING (recorded but nowhere on the page — the didn't-stick signal) / EXTRA (a distinctive page value
  the bundle doesn't hold) / AMBIGUOUS.
- **VALUE-PRESENCE, not label-match (the load-bearing lesson).** The observed review DOM has NO reliable
  field labels (every value is a bare `<span>`/`<div>`), so label-first matching mislabels and floods
  false MISSING/EXTRA. Instead a DISTINCTIVE recorded value (≥4 chars, or ≥3 and not a generic yes/no
  token) AGREES iff it appears in the page text, with a digit-only relief (phones: "8506660266" vs the
  rendered "+1 850-666-0266") and a US/CA region name↔abbrev relief ("Florida" vs "Tallahassee, FL").
  SHORT values ("Yes"/"No") and CHECKBOXES can't be found by value (they appear everywhere), so they
  fall back to LABEL-ANCHORING against the item whose label matches; `normL` strips the trailing required
  "*"/"**" the bundle label carries but the page leaf lacks. FILE_UPLOAD matches the résumé filename by
  page-text containment. Checkboxes prefer a yes/no-valued item so a mislabeled distinctive value can't
  cause a false disagree.
- **`cdpReadReviewPage(valueHints)` (background.js, self-contained).** Scoped to
  `[data-automation-id="applyFlowReviewPage"]`. VALUE-ANCHORED: given the bundle's claimed values as
  hints, it locates each on the page and tags it with the hint's own (correct) label — plus a
  LABEL-ANCHORED pass (find a distinctive question's text leaf → read the next value leaf, for the
  short-valued screening dropdowns) and the generic `<label>`/`<dt>`/two-leaf strategies for the disagree
  case. Returns items + trimmed diagnostics (`anchor_samples`, a capped raw own-text map) that the
  `[REVIEW-CHECK]` log prints only when something didn't match.
- **Wiring:** `RUN_CDP_REVIEW_CHECK` → `runCdpReviewReconcile` in background.js; popup button
  `cdp-review-check`. No profile/LLM needed.

Live-verified on Magna wd3: after the value-presence + label-anchor + region/digit reliefs, every value
the fill committed reconciles as AGREE (My Information, work/education/certification, screening
questions, résumé), with the check going quiet except for genuinely-unrecorded page values. Unit suite
green.

## 2026-07-12 — Strict-replay SUBMIT pipeline (M2–M6) + review-check section-scoped rewrite + reload-retry

The third pipeline stage — **fill → review → submit** — built end-to-end and live-verified in SIMULATE
mode on Magna wd3 (a 4-page application). Source of truth at submit = the human-approved `reviewSummary`
bundle, NEVER the profile. Unit suite 587 green (`node:test`).

**M2 — `replayField` + repeating replay + skip-if-correct.** `replayField(act, entry, budgets)` replays one
approved bundle entry via the correct per-widget handler; the value is a SINGLE candidate through the match
ladder, so a live no-match → `needs_review` (STOP, never guess). Repeating sections: `bundleToSectionItems`
reconstructs the profile-shaped `items` from the bundle (drops `is_deleted`, re-indexes, reconstructs nested
cert specialties, includes Feature-B added entries), fed into `driveRepeatingSectionCdp` with STRICT
overrides (`deleteOnNoMatch:false`, `aiContext:null`). A section the operator DELETED in review reconciles
the live form DOWN TO 0 (was skipped → the "cert did not delete" bug). **skip-if-correct** (`budgets.skipIfCorrect`,
on for replay): every handler reads the live value first and leaves an already-correct field UNTOUCHED
(zero actuation) — `textValuesMatch` is phone-format-tolerant so Workday's `(850) 666-0266` == stored
`8506660266`; wired into `fillTextCdp`/`fillRadioCdp`/`fillDateCompositeCdp` (checkbox/dropdown/typeahead
self-skip via their keep-guards) so page-2 repeating entries no longer fully re-fill.

**M3 — `runCdpReplayWalk` (DRY replay walk).** Clones the fill walk (maintenance / session-dead /
review-terminal guards, `cdpWaitNextPage`, guarded `clickPageNext`, input-lock, detach-in-finally) but reads
the APPROVED bundle, runs NO AI / NO AI-4 remediation, and HALTS rather than guessing. Per page:
`selectPageBundleEntries` (pure) matches the live page to ONE bundle page-group by FLAT-field-name overlap +
live-SECTION overlap (repeating pages have no flat fields) — robust to a cascade reveal having changed the
field-set key (max overlap, not exact); entry ordinal comes from the `-N-panel` heading, never the global
fkitNum. Strict per-field verify: any field that didn't replay cleanly HALTS (`replay-mismatch`); a
nav-timeout = a required field empty (likely a cascade-revealed field the bundle doesn't cover) → HALT
(`replay-blocked`). Résumé re-attached (`replayField` defers file_upload). Stops at review; NEVER submits.

**M4 — `clickSubmit(authorize)` + `submitPrecondition` gate.** `act.clickSubmit(authorize)` (cdp.js) is the
EXACT inverse of `clickPageNext`: fires only when the review marker is present AND `authorize===true`, then
clicks `pageFooterNextButton` (which IS Submit on review). Pure `submitPrecondition(bundle, liveState,
findings, opts)` → `{ok, blockers[]}`, ALL must pass: authorize · on review · session alive / not maintenance
· accepted `schema_version` (1.0/1.1) · every `needs_review` OR `cascade_revealed` field approved · no
unreplaced AI placeholder (bundle + a live page-text scan) · **review-page EQUALITY** (see below) · zero
cascade-revealed / replay-mismatch · single-fire. Heaviest unit coverage — the safety surface.

**M5 — armed "Replay + SUBMIT" popup button.** `RUN_CDP_SUBMIT` → `runCdpReplayWalk({authorize:true,
simulateSubmit:true})`. ⚠ `simulateSubmit:true` is HARDCODED in the handler: at the review terminal the walk
runs the FULL gate and logs `▶▶ WOULD CLICK SUBMIT ◀◀` but NEVER calls `clickSubmit` (the simulate branch
returns before it). Going live = flip that ONE flag + the eyes-on disposable-app hard gate. Live-verified:
4 pages replayed (skip-if-correct kept the correct fields) → review-check AGREE all / DISAGREE 0 / MISSING 0
→ gate passed → would-submit, nothing submitted.

**M6 — cascade-revealed review polish.** A field revealed AFTER another value committed (M1 cascade, e.g.
Country → the Cyrillic-name fields) never passed the operator's eyes on the first fill, so it must be
reviewed before submit even if it filled cleanly. `buildReviewBundle` now carries `cascade_revealed` onto the
entry (was dropped); summary.js shows a "⤴ REVEALED" badge; summary-lib `requiresApproval` AND the M4 gate
force its approval. The cascade re-scan loop is multi-round (`maxCascadeRounds`), so a chained reveal during a
re-fill is caught; a reveal during the submit REPLAY halts safely (`replay-blocked`).

**Review-page CHECK — section/entry-scoped rewrite + account-email verify.** The flat, heuristic scraper
mislabeled and missed repeats, giving 3 false positives on a correct page (the two-language "I am fluent"
checkbox, the hashed screening questions). Rewrote `cdpReadReviewPage` to emit STRUCTURED records off the
review DOM's clean hooks (value-span `id` = form-field name; `label[for]`/richText ENTRY/ROW-scoped — never
document-wide; entry ordinal from the `role="group"` `-N-panel` heading, NOT the global `data-fkit-id` num;
section from h3/h4). `reconcileReviewPage` matches id/entry-scoped first — (a) flat: `field_id` tail ===
value-span id; (b) repeating: section (via `CANONICAL_TO_FKIT`, website↔webAddress) + ordinal, THEN
key-or-label WITHIN the entry — with the legacy value-presence preserved as fallback for the generated-id
My-Information fields. **Account-email verify** (operator ask): the pre-filled signup email is checked vs the
login credentials / `auth_strategy.account_email` / `personal_info.email` — a match → agree (`account-email`
tier, no longer EXTRA noise), a mismatch → disagree (BLOCKS the gate). Both consumers (the read-only CHECK
button + the M4 submit gate) feed it `accountEmails`.

**Reload-retry on a transient render-flake (fill + submit walks).** A choice widget whose option list never
renders (`options did not render` / `skipped_no_option_match`) is a Workday RENDER FLAKE, not a real no-match
(live-seen on Magna page-2 language proficiencies — the replay correctly halted, a manual reload+re-run then
completed). `isTransientRenderFailure` (pure) is true iff there ARE failures and EVERY one is a render-flake
(any terminal failure → false → still halts). Because a Workday reload returns to PAGE 1, on a transient the
walk `reloadAndSettle`s + RESTARTS the whole walk from page 1 via a labeled `restartWalk` loop, bounded per
run (`MAX_RELOAD_RETRIES=2`); skip-if-correct / the already-filled sweep make the good pages fast on the
restart. Terminal failures still halt for the operator.

**Review UI — hide preferred first/last when the checkbox is unchecked.** "I have a preferred name" reveals
the preferred first/last fields; unchecked → the form hides them, so the review does too (`isHiddenPreferredName`
— match the field-NAME tail + canonical, NOT the whole `field_id`, whose cdpPageKey prefix lists every flat
field name and would hide the ENTIRE page). Toggling it in the viewer re-renders (like "I currently work
here") so the rows hide/show live.

**Profile v2 — web editor overhaul + answer buckets (merged PR #10, 2026-07-16).** Two halves, built +
live-verified on the website (localhost:3000); every schema shift kept in lockstep with the extension.

*(A) Editor UX (`web/`).* Country / phone-code / citizenship pickers — a dropdown for the canonical choice +
a subtle in-field ▾ opening an "Advanced choices" popup over the tiered fallback candidates (`lib/countries.ts`
expands a pick to its known variants, dodging the ambiguous single-"United States" match). Workday-style
segmented **date pickers** (year / month-year / month-day-year) emitting the SAME canonical strings
`prepareProfile` parses; the month is a typeable "5"/"05" → "05 — May" input. **Yes/No toggles** — divider bar
+ bold amber selected cell, no blank option (Esc clears). Self-identification → dropdowns. **Preferred name** —
an "I have a preferred name" checkbox reveals `preferred_first_name`/`preferred_last_name` (the extension's
`preferredCheck`/`preferredName--first/last` already mapped these — the web schema was the missing half).
**Websites** — 3 fixed rows (LinkedIn/GitHub/Personal Website, type LOCKED via a disabled box; existing links
slotted in by `withDefaultWebsites`) + custom rows with free-text type. **Role description** — `bullets[]`
replaced by ONE dash-bulleted textarea (focus seeds "- ", Enter continues; `coerceProfile` migrates legacy
bullets → "- " lines); the extension derives `bulletsText` from it (bullets fallback), so `WORK_EXPERIENCE_MAP`
is unchanged. Languages `fluent` is now a human-set stored box (the extension uses it, else derives
reading∧speaking∧writing). How-did-you-hear = a fallback source list. Every mapped field label is a clickable
bucket link (white hover; highlights on field-hover via group-hover). Schema (`lib/profile-schema.ts` v2.0)
gained `preferred_first_name`/`_last_name`, `role_description`, `languages[].fluent`,
`certifications[].specialties[]` (each `{specialty, start_date, end_date, attachment}`, matches `CERT_NESTED`),
`additional_files[]`.

*(B) Answer buckets.* The platform-agnostic answer store (`profiles.buckets_json`, migration `0002`;
`web/lib/buckets.ts`; `STARTER_BUCKETS` Mode-A seed, provision-if-null). A bucket = one canonical answer + the
question wordings that map to it — Mode A (profile-backed `profile_path`) or Mode B (standalone `value`). Edited
via **per-field popups** (click a field label → edit its wordings, created on first use). The extension consumes
them in `drivePageFill` (`buildBucketIndex` + `fillFromBucket`, exact-normalized wording only — **no fuzzy**,
match-ladder-gated, BEFORE the AI pass; commit flagged `bucket`); +6 unit tests (fake bucket, Mode A/B, gate,
runs-before-AI). Supersedes the `answerBank`/`docs/profile-learning-plan.md` sketch. **Attachments** — a private
`attachments` Storage bucket (migration `0003`) + `POST /api/attachments/upload`; per-specialty files +
`additional_files[]`. Fix: `AP_SYNC_PROFILE` now MERGES `defaults` (a website sync no longer wipes the
extension's field_of_study/degree/gpa_range). Web typecheck + full build green; extension suite **593/593**.
**Follow-ups:** date/textarea bucket FILLING (labels/wordings persist now; the consume tier fills
text/dropdown/radio/typeahead/checkbox); the extension attaching specialty/additional files per-field on Workday
(website upload/storage is done). Design + build plan: `docs/profile-v2-plan.md`; website contract: `WEBSITE.md`
M8.

## 2026-07-16 — Review stage migrated to the website (editing + approval + round-trip)

Moved the review stage OFF the extension's `summary.html` viewer and ONTO the companion
website — the website is now the PRIMARY review surface. The extension's `summary.html`/
`summary.js` stays as a fallback until the web path is live-verified. Operator decision:
full editor parity in one go; write-back = the extension PULLS the approved bundle from the
backend (DB is the source of truth), not a website→extension push.

**Web (Next.js/TS).**
- **M1 — pure transforms ported.** `web/lib/review-approval.ts` = faithful TS port of
  `summary-lib.js` (editKindOf/tokenFor/checkedOf/effectiveValue/approvalEnvelope/
  requiresApproval/newEntryRecords/visibleEntryItems/isHiddenPreferredName + the AI-2
  placeholder marker). `web/lib/review-model.ts` = the non-DOM logic from `summary.js`
  (sectionOf-with-index/nestedInfoOf/flag-prominence predicates/statusOf/sectionShapeFor/
  nextIndexFor). `ReviewEntry`/`ReviewBundle` (review-summary.ts) extended with the
  editing+approval fields the replay reads. LOCKSTEP with `summary-lib.js`;
  `test/summary.test.js` remains the semantic spec.
- **M2/M3 — the React editor + persistence.** `web/components/app/review/ReviewEditor.tsx`
  ports the whole `summary.js` editor: needs-review-first with flag-driven prominence
  (super-hard / legally-loaded / demographic / needs-answer badges), every widget editable
  (select / combobox / segmented date / checkbox / textarea / tier editor), per-field /
  per-section / all approval with submit-readiness gating + submit-blocked banner,
  repeating-entry add + soft-delete (+undo), nested cert-specialty sub-sections, and the
  currently-work-here / preferred-name visibility mirrors. React holds ONE bundle in state
  (immutable updates replace the manual DOM-refresher machinery); a value edit resets that
  field's approval. `saveReviewBundle` server action autosaves (debounced) to
  `applications.review_bundle_json` (RLS), recomputing the approval envelope +
  needs_review_count server-side. `/app/tracker/[id]` renders the editor instead of the
  read-only view; DEV_PREVIEW/sample data shows but doesn't persist.
- **M4 — the pull endpoint.** `GET /api/extension/review` (ingest-key auth, mirrors the
  queue-pull) returns the approved bundle by `?url=` (the report upsert key). READ-ONLY.

**Extension (vanilla JS).**
- **M5 — pull before replay.** `pullApprovedBundle` (background.js) reads `apSession` + the
  local bundle's url, GETs `reviewUrl`, and writes `chrome.storage.local.reviewSummary` — so
  `runCdpReplayWalk` (unchanged; it reads that slot directly) replays exactly what was
  approved on the site. NEVER throws: not-connected / no-remote-bundle / HTTP error all fall
  back to the local bundle. `AP_SET_SESSION` now stores `reviewUrl` (derived from `ingestUrl`
  for older sessions); the website's getSyncBundle/getSession + ConnectPanel supply it.
- **M6 — the walk pushes.** `runCdpWalk` now reports its accumulated bundle to the website on
  every exit (reached-review / halt / abort) via `reportApplication` in its `finally`
  (previously only the single-page fill reported).

The submit pipeline is UNCHANGED — `runCdpReplayWalk` / `replayField` / `submitPrecondition`
still read `current_value`/`edit_kind`/`is_deleted`/`is_approved`/`needs_review`/
`cascade_revealed` off each entry and re-check the review-page equality gate, so the round-trip
can only change WHERE the bundle is edited, never HOW it's verified/submitted. Extension suite
**593/593**; web typecheck + production build green (incl. the new route).

**Live-verify PENDING (operator):** end-to-end on a real tenant — fill → walk reports to the
site → edit/approve on `/app/tracker/[id]` → Replay pulls the approved bundle → replay/would-submit.
Needs Supabase wired + the extension connected (`/app/connect`). Prod origin must be added to
the extension manifest `externally_connectable` + `host_permissions` before a non-localhost site.

## 2026-07-16 — Containment is a guess unless Workday made it (match-ladder safety)

Live bug: profile state `"PA"` filled a dropdown as **"Armed Forces Pacific"** at `filled` with NO review
flag. `normalize("PA")="pa"` is a mid-string substring of "Armed Forces **Pa**cific" — the ONLY option
containing it, so the ambiguity-safe guard (which only rejects 2+ hits) couldn't help, and the dropdown
commit graded a containment match as a confident `filled` (not `filled_review`). A 2-letter abbreviation is
a substring of countless unrelated options → the whole class is unsafe on a *select-from-a-list* widget.

Operator decision: **ApplyPilot never PICKS a containment match itself.** `matchCandidates` gained an
`opts.containment` param (default ON, LOCKSTEP lib.js + the `background.js` inline copy) plus a
short-candidate guard (mid-string `includes` requires ≥ 3 chars):
- **Dropdowns + radios** (`fillDropdownCdp`, page-engine dropdown; `fillRadioCdp` was already exact-only) →
  `{containment:false}`: exact → typo (fuzzy ≥ 90) → escalate. A `"PA"` with no exact/typo option now flags
  for review (→ AI rescue on a required field).
- **Typeahead / cert / source DIRECTED picks** (Workday showed a list, did NOT autocommit, we would click
  the one containing option) → `{containment:false}` too — us picking is a guess.
- **Typeahead AUTOCOMMIT recognition KEPT** (default containment): when *Workday itself* commits a completed
  chip after you type (`"Training Instructor - AEVO"` → `"…AEVO - Multiple Recognized Providers"`),
  "chip contains what I typed" is how we RECOGNIZE Workday's own completion (vs a stray `"Canada"` chip for a
  US query) — trusting Workday, not guessing; still `filled_review` (flagged). AI anti-hallucination belts
  keep containment (the AI rescue must resolve the AI's choice to a real option for required fields).

Net rule: accept only an **exact** match, a **typo**, or a value **Workday autocommitted**; everything else
escalates → the website review editor / an answer bucket (→ exact next time) / the AI rescue for required
fields (**all required fills keep the AI rescue** — operator rule). Tests: `test/matching.test.js` rewritten
(containment ON default incl. the ≥3 short guard + autocommit case; OFF for dropdown/radio); the CDP
directed-containment test updated to expect escalation; autocommit-containment tests unchanged. Extension
suite **597/597**. Docs: CLAUDE.md → Matching strategy.

## 2026-07-16 — Flatten checkbox fields to plain booleans (no "unanswered" state)

Follow-up to the checkbox-fill fix: a checkbox has no "unanswered" state on a form, so the true
checkbox-widget profile fields are now plain `boolean` (default `false`) instead of `triBool`
(`true|false|null`) — `personal_info.has_preferred_name`, `work_experience[].currently_work_here`,
`education[].currently_enrolled` (`web/lib/profile-schema.ts` new `bool` = preprocess→boolean, default
false; `coerceProfile` migrates legacy `null`→`false`, verified null/absent→false). The editor's
"Currently work here" switches from a Yes/No `TriBoolField` to a real `CheckboxField` (which gained
`bucketPath` support). `triBool` stays for genuine yes/no QUESTIONS (`work_authorization.*`,
`screening.*` — null=unanswered is meaningful) and `languages[].fluent` (null=auto-derive). Web
typecheck + build green. Docs: WEBSITE.md boolean convention.

## 2026-07-16 — Halt reason + form errors on the review page; yes/no radios as buttons

Two review-page improvements requested after a live fill halted on a bad postal code
("32312 is not a valid postal code for Pennsylvania"):

**Halt surfacing (why a fill didn't reach the end).** `runCdpWalk` now stamps a `walk_status`
onto the accumulated bundle in its finally — `{completed, stopped_page, page_errors[], error_text,
empty_fields[], cancelled}` — captured via closure vars (reachedReview / walkPage / lastDiag from
reportPageErrors) with no change to the walk's return sites. It's reported to the website with the
bundle. `ReviewEditor` renders a LOUD red `WalkStatusBanner` at the top when `!completed`: the reason
(form error / empty required / operator-cancelled / other), the exact Workday error text verbatim, any
empty required fields, and an **"Edit my profile"** link (→ `/app/profile`). `WalkStatus` added to the
bundle type; the report/save paths carry it unchanged (stored in `review_bundle_json`).

**Radio yes/no → buttons.** A radio field with ≤4 options now renders as segmented Yes/No-style
buttons in the review editor (the profile's toggle look, matching how the field is on the form) instead
of a `<select>`; larger radio sets still use a select. New `RadioButtons` editor.

Extension suite 597/597; web typecheck + build green. Refill button + edit-preserving refill (so
approved deterministic fields don't re-review after a refill) proposed next — needs the
website↔extension refill-trigger decision.

## 2026-07-16 — Refill: replay APPROVED fields (flat + repeating), re-fill the rest

After a halt (e.g. a bad postal code), the operator fixes the profile + approves the correct
fields on the website, then REFILLS. A refill re-runs the guarded walk but REPLAYS the
human-approved fields via the SAME primitives the submit replay walk uses — so an approved field
lands identically to a submit-replay and drops out of the flag list; everything else re-fills
fresh from the (now-fixed) profile. The new review always contains every field; approval only
flips a field flagged → not-flagged. NEVER submits.

- **Flat** — `refillReplayApprovedFlat` (fill-driver): matches approved flat entries to live records
  by field name, `replayField` each (skip-if-correct → per-widget commit); committed → `filled` +
  `approved-kept` + `is_approved` (buildReviewBundle's deriveReview → needs_review:false); a replay
  that doesn't commit KEEPS the field flagged (no false "kept").
- **Repeating** — a section with ANY approved field is replayed whole via the SAME
  `replayRepeatingSections`; `refillMergeApprovedSections` (pure) replaces the fresh section entries
  with the reviewed ones, un-flagging approved. `refillApprovedRepeatingSections` picks the sections.
- `buildReviewBundle` carries `is_approved`/`approved_at` (both lockstep twins) so replayed-approved
  fields stay approved. `runCdpWalk({refill:true})` pulls the website-approved bundle before the clear
  + threads the entries per page (`fillAndPersistPage`). `RUN_CDP_REFILL` handler + popup "CDP REFILL".
- **Website:** when `walk_status.completed === false`, the ApprovalBar button becomes **Refill**
  (ungated) instead of "Approve & continue to submit", with guidance to re-run in the extension.

Model: FILL/WALK = fresh (a re-run overwrites); **REFILL = preserve-approved** (approvals are the
mechanism, replayed). +3 unit tests (600 total). Extension suite 600/600; web typecheck + build green.
Follow-up: skip fresh-filling approved sections (avoid the double-fill) is an optimization, not needed
for correctness (the replay reconciles over the fresh fill).

## 2026-07-18 — Answer buckets CHANGEABLE + the /app/teach flow (Buckets M1–M9)

Make answer buckets editable and close the learning loop: approved answers that didn't fill
deterministically become teaching cards that get filed into buckets, so they fill deterministically
(no review) next time. Built off the web-review migration (the website is the primary review surface).

- **M1 — schema:** bucket `value` → a **candidate list** (`string[]`; text→value[0], choice→match ladder,
  like a tiered dropdown across tenants) + a `category`; `coerceBuckets` upgrades legacy strings;
  `fillFromBucket` (extension) consumes the list (legacy string tolerated). LOCKSTEP web ↔ extension.
- **M2 — Mode-B management:** an "Other remembered answers" section in `ProfileEditor` — create/edit/delete
  standalone buckets (wordings, candidate-list answer, field type, category, sensitive).
- **M3 — coverage:** no-op (every flat bucket-eligible field already had a clickable label).
- **M4 — piggyback:** `aiFillField`/`aiFillText`/`aiFillRadio` return `maps_to`+`suggested_category` in the
  SAME fill call → ride the review bundle → the teach page needs no 2nd LLM call for AI-filled questions.
- **M5 — `/app/teach`:** reads APPROVED review data from `applications.review_bundle_json`; a flashcard
  queue. `web/lib/teach.ts` (pure) + server page + `TeachInbox`.
- **M6 — persistent skip:** `profiles.teach_dismissed_json` (migration `0004`) — a skipped card never
  reappears.
- **M7 — web test harness:** `tsx --test` (resolves `@/` aliases + strips types) + `test/teach.test.ts`
  (the web had no test runner before).
- **M8 — split-screen + broaden:** the profile is **physically displayed on the left** (`ProfilePanel`,
  `flattenProfileFields`), the recommended field highlighted, clicking a field files the wording under it;
  the queue broadened to EVERY non-deterministic (`needs_review`) approved fill; an **AI recommendation on
  every card** — a teach-time fallback (`recommendField` → `callLLM` with the user's `ai_config`) for cards
  with no stamped hint.
- **M9 — recommendation precedence:** `canonical_field` (the mapped home — free/exact) → fill-time `maps_to`
  → LLM fallback (fires only when nothing known). A fuzzy/containment match on a known field shows a
  "possible typo/variant — verify" note instead of an LLM guess.

Verified: extension `npm test` **604**; web `tsx --test` **15**, `tsc --noEmit` + `next build` clean. Merged
to main. Remaining: end-to-end live-verify on a real Workday page (fill → approve on review → teach → re-fill
deterministic); apply migration `0004` to Supabase; the fill-time typeahead-AI piggyback (covered by the
teach-time fallback for now).

## 2026-07-20 — Fill idempotency + AI-off halt + replay cascade race + false-advance (branch `fill-overwrite-and-halt-fixes`)

CDP fill/replay fixes, each root-caused by a read-only trace (never guessed):

- **False "advanced" → phantom page re-fill (`runCdpWalk` + `runCdpReplayWalk`).** `prevSig` (the
  transition signature `cdpWaitNextPage` diffs against) was captured BEFORE the page fill. But the fill
  itself mutates the field set — leaving "preferred name" unchecked removes its two fields, a Country
  cascade adds/removes others — so the post-fill signature already differed from the stale pre-fill one.
  On a FRESH form with an invalid value (operator repro: a ZIP that doesn't match the state), Save &
  Continue was BLOCKED, but the changed signature made `cdpWaitNextPage` read "advanced" → the walk
  re-scanned the SAME page as "page 2" and RE-FILLED it (regardless of AI on/off). Now `prevSig` is
  snapshotted AFTER the fill/replay, immediately before the click, so only a REAL transition changes it —
  a blocked page correctly stays put (nav-timeout → remediation-if-AI / halt-if-not). Only bit the FIRST
  fill because a re-run starts with those fields already removed (no signature delta). The
  `remediatePageErrors` re-click already captured its sig post-refill — unchanged.

- **Duplicate review page → OVERWRITE (`accumulateBundle`).** Dedup was by EXACT `cdpPageKey` (pathname +
  sorted field-set). Filling ONE page twice can yield DIFFERENT keys when the field-set shifts between
  fills — a cascade-revealed field (country→state/phone) persisted, so the 2nd pre-fill scan sees it and
  the 1st didn't — so the prior entries weren't dropped → **two page-1 groups**. New pure
  `samePhysicalPage(a,b)`: same page ⇔ same pathname AND field-sets OVERLAP (≥50% of the smaller set);
  genuinely different same-pathname SPA pages have DISJOINT field-sets (the M31 discriminator) → stay
  separate. Any re-fill (single-page `runCdpFillPage`, remediation, or the reload-restart) now OVERWRITES.
  Recon never writes `reviewSummary`, so the perceived "recon copy" was always a fill duplicate — same fix.
- **AI OFF → halt on error, NO refill (`runCdpWalk` nav-timeout branch).** `remediatePageErrors` ran
  unconditionally; its deterministic Tier-1/1.6 re-fill fired even with AI off (the unwanted "refill on
  error"). Now gated on `act.aiEnabled`: AI off ⇒ skip remediation, try only a harmless re-click (a
  swallowed Save & Continue, never a re-fill), else HALT `nav-timeout-dirty`. AI on keeps the full AI-4 ladder.
- **Replay page-2 cascade race → bounded reload-retry (`RENDER_FLAKE_RX`).** On Magna the Country cascade
  reveals region/phone/postal ~5.6s after Country commits — past the dropdown 2.5s rect poll and the
  one-shot text/typeahead reads (0s) — so replay hit "no input in wrapper" / "typeahead wrapper not found" /
  "options did not render" and HALTED (the reload-retry didn't fire: those errors weren't flakes).
  Broadened `RENDER_FLAKE_RX` to the control-not-laid-out family so the bounded reload-retry (BOTH walks)
  recovers on a fresh load (which also clears the stale-session aggravation a cancelled-then-rerun adds). A
  genuine no-match ("value not offered") stays terminal — a reload can never mask a real problem.

- **Replay walk: premature "advanced" → re-processing the SAME page (`runCdpReplayWalk`).** On a 2nd
  refill of an already-completed Magna form (bundle now holds all pages), page 1's Save & Continue read
  as "advanced" while My-Information was still mounted, so "page 2" re-scanned My-Info, `selectPageBundleEntries`
  re-matched the 14 My-Info entries, and it died focusing the empty `extension` field. Three fixes:
  (1) `cdpPageSig` now strips the URL query (pathname + field-set, matching `cdpPageKey`) so a session/
  tracking token (Magna's `?utm_source=…&ref=…`) mutating mid-transition can't register as an advance;
  (2) a SAME-PAGE guard in the replay loop — if the live page's flat-fields+sections identity equals the
  step just replayed, HALT `did-not-advance` instead of re-replaying; (3) `replayField`'s cleared-text
  path SKIPS an already-blank / not-yet-laid-out optional field (read-first) instead of focus-and-clear,
  so an empty `extension` can never halt the walk. Root-caused by a read-only trace (both refill runs
  diffed); `selectPageBundleEntries` was NOT at fault — it matched the (wrong, still-page-1) fields it
  was handed.

- **Source ("How did you hear about us?") tree never drilled on Magna → left blank / flat-guessed.** The
  category→click→recon-leaves→pick-leaf→commit drill lives only in `aiTreeDrillFallback`, and it enumerated
  categories via `scrapeSourceRows` (reads `promptOption` nodes ONLY). Magna renders its category rows as
  `role=option`/`treeitem` nodes → the scrape returned 0 → the drill ABORTED to `null` before clicking →
  the flat "no candidate produced a verified chip" exit → required-source error → the AI-4 remediation
  then FLAT-TYPED a guess ("job boards") because `refillFieldWithValue`'s hierarchical branch passed no
  tree context. Two fixes: (1) `aiTreeDrillFallback` falls back to `readTreeCategories` (which reads the
  `role=option`/`treeitem` rows) when the promptOption scrape finds 0 categories, so the drill actually
  runs (category → `expandCategory` → recon leaves → pick → commit); (2) the AI-4 remediation of a
  hierarchical `source` re-runs the drill from the profile's `how_did_you_hear` fallback (LinkedIn first)
  with the tree-drill AI context, instead of flat-typing the LLM's guess. New test: a 0-category
  promptOption scrape falls back to `readTreeCategories` and still drills+commits.

- **Source tree is SERVER-FETCHED → the DETERMINISTIC fallback ladder ran too early and lost to the AI
  (`awaitSourceListLoaded`, LIVE-VERIFIED on Magna).** With no primary/per-application source value (that
  answer is deferred), the deterministic candidate loop (LinkedIn → Handshake → GitHub → Other) IS what
  fills — and typing a candidate + Enter DOES autocommit / pick the filtered match. But the loop typed
  the instant the picker opened, BEFORE Magna's category tree finished loading, so `awaitListStable`
  accepted the stable-EMPTY list, every candidate hit a false "No matches found", and the field fell
  straight to the `aiTreeDrillFallback` AI drill (which then guessed a category). Fix: for a `sourceTree`
  field the first-open now waits on new `awaitSourceListLoaded` — a cheap `readTreeCategories` poll
  (150ms, real wall-clock, bounded by `sourceCatLoadCeilingMs`, re-opens only if the popup closed) that
  proceeds the INSTANT the tree has content (adaptive, not a fixed sleep — an earlier fixed wait was
  "way too slow"). So the deterministic ladder is tried FIRST (type→Enter→autocommit, `sourceTree:true`
  passed by both `drivePageFill` and the AI-4 re-drill, independent of the AI toggle); the AI drill runs
  ONLY on a genuine no-match. New tests: `awaitSourceListLoaded` returns true the moment a late tree
  loads, and false (bounded) when it never loads.

- **Known empty repeating sections no longer nag for review (operator rule: "having no values is fine since
  they're in the profile; a repeating section NOT in the profile on the page should be review").**
  `buildReviewBundle` flagged EVERY `section-stub` as `needs_review: section_unfilled`. Now it keys off
  `section_known` — a KNOWN, profile-DEFINED section (cert / languages / work-experience / education /
  websites, `section_known:true`) left empty is the user's own choice → still shows in ALL FIELDS (addable)
  but is NOT a review item; only an UNKNOWN section (`section_known:false`, a tenant repeating section the
  profile doesn't model) is a genuine gap → review. A required-but-empty KNOWN section still blocks Save &
  Continue → nav-timeout halt, so skipping the review flag never hides a blocker. (A source-specific
  relaxation was tried + REVERTED: a deterministic NON-EXACT source match stays `filled_review`/flagged like
  any choice widget; an EXACT match — at any ladder position — is already `filled`, no special-casing.)

- **AI-4 remediation deleted PARTIAL repeating entries (the education data-loss bug).** `deleteEmptyErrorRows`
  (Tier 1.5 — deletes error-named repeating rows to clear a Save & Continue error) gated deletion on
  `anyEmpty`: if ANY error-named field in a row was empty, it deleted the WHOLE row. So an education entry
  with school + degree FILLED but one field EMPTY (not in the profile) got NUKED — and the removed row is
  filtered from the bundle, so it VANISHED from review. This contradicted the documented intent ("a
  value-holding row is never deleted"). Fixed: delete ONLY a row that is ENTIRELY empty (`holdsValue` false —
  a true orphan the tenant left that blocks Save); a row holding ANY value is KEPT even with an empty
  required field — that field surfaces for review / the walk halts, never a silent data loss. Single-field
  rows behave identically (unit-pinned); a new test pins that a multi-field partial row survives while an
  entirely-empty orphan is still deleted. (operator 2026-07-20)

(The extension keeps MIRRORING the website's AI toggle via `AP_SET_LLM` — the website's own enable
toggle is the single opt-in; an earlier extension-side auto-opt-in was reverted as redundant.)

Verified: extension suite (minus `db`, uninstalled dep) **609/609** incl. new `samePhysicalPage`,
`accumulateBundle`-overwrite, broadened `isTransientRenderFailure`, `awaitSourceListLoaded`
load/give-up, section-stub known-vs-unknown, source non-exact-stays-flagged / later-ladder-exact-
not-flagged, and `deleteEmptyErrorRows` keep-value-holding-partial-row tests. The source category-load timing + deterministic-before-AI ladder is **LIVE-VERIFIED
on Magna** (fills LinkedIn deterministically once the tree loads). **Live-verify PENDING** (eyes-on,
disposable app): the duplicate-overwrite, the AI-off halt, and the replay reload-recovery on a real
Workday page.

## 2026-07-21 — Website "Run" full-flow trigger (JD → onboard → walk → review) (branch `web-run-home-flow`)

The website can now drive the WHOLE pipeline from one button — the missing link was a *trigger*: the
extension's `onMessageExternal` contract only ever PERSISTED the handoff (`AP_PING`/`AP_SYNC_PROFILE`/
`AP_SET_LLM`/`AP_SET_SESSION`/`AP_SYNC_RESUME`/`AP_CLEAR_RESUME`) — its comment literally said "NOTHING
here fills or submits." Everything downstream already existed (`runCdpOnboard` → `runCdpWalk`, triggered
only by the popup's `RUN_CDP_ONBOARD`).

- **Extension — one new external message `AP_RUN_APPLICATION` (background.js).** The ONE external message
  that ACTUATES (all the others only persist); reachable only from an `externally_connectable` origin
  (localhost), so a random page can't fire it. It `chrome.tabs.create({url})` a FRESH tab, waits for load
  (`waitTabComplete` + a hydration beat), scrapes the job description (`scrapeJobDescription`, injected via
  `chrome.scripting` — jobPostingHeader/description + tenant-subdomain company fallback) BEFORE Apply
  navigates away, then runs `runCdpOnboard(tabId,{startUrl:null,gmailEnabled,credentials})` on the
  already-loaded page and — reached_form — ALWAYS chains into `runCdpWalk` (the website Run IS the explicit
  opt-in the popup's `continueToWalk` toggle gates). Returns `{...onb, walked, walk, jd, tabId, startUrl}`.
  The submit double-guard is UNTOUCHED — it stops at review, never submits. `runCdpOnboard`/`runCdpWalk`
  themselves are unchanged (pure additive: +114 lines, 0 deletions).
- **Web — a `/app/run` page** (`RunPanel.tsx` client + `page.tsx`): URL field + Run button →
  `sendToExtension(extId,{type:"AP_RUN_APPLICATION",startUrl})` (same channel the Connect page uses), a
  connected-here guard, a spinner-then-outcome card that translates the onboarding/walk `stopped` reasons to
  friendly copy (`reached-review` → success; SSO/no-creds/verify/nav-timeout → "needs you"), a link to the
  tracker row, and the captured JD (collapsible). Sidebar gains a **Run** entry (top, after Overview) + a
  hero card on the `/app` overview.
- **JD save** — migration `0006_job_description.sql` adds `applications.job_description`; the new server
  action `saveRunJob` upserts by (user_id,url) — the same key the extension's report path uses — so it and
  the walk's own status report converge on ONE row (never clobbers the review bundle; the report path never
  clobbers the JD). Feeds the existing cover-letter generator + the tracker.

Verified: `background.js` parses; web `tsc --noEmit` clean; `next build` green with `/app/run` compiled as
a route. **Live-verify PENDING** (eyes-on, disposable app): the end-to-end website→extension round-trip on a
real tenant (needs Supabase wired + `/app/connect` linked + Gmail connected for verify tenants). For a
non-localhost deploy, add the prod origin to `manifest.json` `externally_connectable` (already a known TODO).

## 2026-07-21 — Sign-in & email page: credentials + Gmail sync from the website (branch `web-run-home-flow`)

The Run flow needs a Workday account to sign in with; until now that only came from `data/credentials.json`
loaded in the popup. Added a website page that supplies it (and Gmail auto-verify) the same autosync way the
profile/AI/resume already do.

- **Extension — 3 new external messages (background.js, additive):** `AP_SET_CREDENTIALS` ({email,password}
  → `chrome.storage.local.credentials`, the SAME slot the popup writes + `runCdpOnboard` reads; both blank ⇒
  CLEAR); `AP_SET_ONBOARD_CONFIG` ({onboardConfig} merged read-modify-write, for the `gmailEnabled` toggle);
  `AP_GMAIL_CONNECT` ({interactive}) → reuses the popup's `runGmailSmokeTest` — interactive:true pops Chrome's
  account picker (the OAuth is Chrome-owned and can ONLY run in the extension; the website merely TRIGGERS it),
  interactive:false is a silent "already connected?" check. Persist/trigger only — no sign-in happens here.
- **Web — `/app/credentials` ("Sign-in & email"):** a credentials card (email + password, show/hide, dirty-gated
  Save → `saveCredentials` + `liveSync("credentials")`) and a Gmail card (a `gmailEnabled` toggle that saves +
  `liveSync("onboard")` on flip, a "Connect Gmail" button → `AP_GMAIL_CONNECT` interactive, and a silent status
  line on mount). New `lib/credentials.ts` (zod `credentialsSchema` + `onboardConfigSchema`, mirroring the AI
  pattern), server actions, `extension-sync` gains `credentials` + `onboard` kinds, migration `0007` adds
  `profiles.credentials_json` + `onboard_config`. "Sync everything" (Connect) + the overview setup grid +
  sidebar now include Sign-in. Password stored plaintext on the owner-only profile row — SAME posture as the
  existing `ai_config` API key; the UI warns to use a throwaway account.

Verified: `background.js` parses; web `tsc --noEmit` clean; `next build` green with `/app/credentials` +
`/app/run` compiled. **Live-verify PENDING** with the round-trip (same gate as the Run entry above).

## 2026-07-22 — Run-tab hardening + teach-flow fixes (live-testing the website Run on Magna wd3) (branch `web-run-home-flow`)

Follow-ups from live-testing the one-button website Run end-to-end. Web changes hot-reload; extension
changes (`background.js`/`cdp.js`/`lib.js`) need an extension reload.

**Onboarding sign-in.** The pre-submit settle before the FIRST "Sign In" click was a flat 500ms; a miss
then stalled the full ~20s `submitAndWait` timeout before the re-click. Reworked into an escalating ladder:
a 200ms pre-click settle, and `submitAndWait` now takes a per-attempt `timeouts` ladder — Sign In uses
`[500, 20000]` (fast re-click at 500ms, then the full 20s for a genuinely slow sign-in). Happy path is
200ms; a missed first click recovers in ~500ms. Create-Account submit unchanged.

**Fill walk — Workday soft-error.** The transient "Something went wrong / please refresh" page had NO
handling in the walk (only onboarding did) — after login the walk saw a form-less page, called it terminal,
and stopped. Added `softErrorPresent` to `cdpReadSessionState` (lockstep with lib.js `isWorkdaySoftError`);
the walk detects it at the top of each page AND at the post-fill terminal spot → `reloadAndSettle` +
`continue restartWalk` (a refresh restarts the Workday form at page 1, so the walk restarts too), bounded
at 3/run; a reload landing on the login page is caught by the existing `sessionLooksDead` guard.

**Fill walk — render-settle.** The page-render settle added in the Run milestone polled on `act.delayRender`
(adaptive → ~40ms on a visible tab), so it "confirmed stable" before the form rendered and most fields got
cascade-mis-tagged. Switched to `act.delayFull` (real wall-clock) + require the flat field count unchanged
across 3 reads. LIVE-VERIFIED on Magna ("14 flat field(s) stable after 3144ms").

**Tracker — dedup + display.** (1) Re-running the same job piled up a new row each time: a Workday
application url changes every run (after login the form is on `wdN.myworkdaysite.com` with a
per-application-instance path). Fixed with a stable `job_key = "<datacenter>:r<reqid>"` (`canonicalJobUrl`,
`lib.js` ↔ `web/lib/job-key.ts` lockstep) — the data-center token + requisition id is identical across the
posting host (`<tenant>.wdN.myworkdayjobs.com`) and the form host (`wdN.myworkdaysite.com`).
`reportApplication` + `saveRunJob` upsert by (user_id, job_key); migration `0008` adds the column. (First
attempt keyed on the tenant SUBDOMAIN, which the myworkdaysite host lacks → split the two apart; the
data-center token is the fix.) (2) The row showed the host, not company/title: the JD scrape
(`chrome.scripting.executeScript`) is host-permission-gated and `host_permissions` lacked
`myworkdaysite.com` → the scrape threw. Added `*://*.myworkdaysite.com/*`; `scrapeJobDescription` also
derives the title from the URL slug + company from the tenant path segment. JD saved to
`applications.job_description` (migration `0006`), shown via a "Job description" modal button on the
review/detail page.

**Profile.** Save is dirty-gated (disabled until profile/buckets actually change). "How did you hear about
us?" — "Other" is now the last DEFAULT entry of the single source list; the separate "last resort" field is
retired (kept in the schema, defaulted empty, for backward-compat). Added `web/supabase/schema.sql` — a
consolidated one-paste snapshot of all migrations (the numbered files stay the source of truth).

**Teach flow** (`isTeachable` = AI-filled + approved, or a manual edit — UNCHANGED throughout):
- A **"Skipped (N)"** section reveals skipped teach cards + a Restore that drops them back into the queue.
- **`coveredKeys(buckets, profile)`** — a bucket "covers" (hides from teach) a question ONLY when it can
  actually answer it (Mode-A bound field non-empty, or Mode-B value non-empty). An empty/unanswered bucket
  (e.g. the `over_18` starter bound to a blank `screening.at_least_18_years_old`, or a field the operator
  removed) no longer hides its question → it resurfaces in teach with the "add it back" warning.
- **#4:** an AI-filled entry is NOT hidden by `covered` even when a bucket nominally covers it (the AI fill
  proves the bucket's saved value didn't match this tenant) → surface it so the operator can add the tenant
  variant. A clean/fuzzy bucket fill stays covered; skip + dedup still apply.
- The card recommends the matching Mode-A bucket's bound field (`bucket_path`) over the AI's `maps_to` hint
  (which had hallucinated "education" for over-18); `profileValueAt` returns "" for object/array-of-objects
  paths (no more "[object Object]").
- Fixed a "Remember wording" popup flash: `commit()` applied the optimistic profile/bucket update while the
  confirm popup was still open (→ `decideTeachRoute` flipped "answer"→"wording"); now it persists first and
  applies the store update only on success, batched with closing the popup + advancing.

Verified per change: extension unit suites green where runnable (fill-driver 443, session/onboarding + the
lib-dependent suites); web `tsc --noEmit` clean + `next build` green. LIVE-VERIFIED on Magna wd3: the Run
tab onboards → fills → soft-error recovers → reaches review; the tracker shows one row with company/title.
Remaining: exercise more tenants; the JD-scrape host-permission covers myworkdayjobs + myworkdaysite only.

## 2026-07-23 — triBool→AI leak, answer ladders as their own thing, education dual-shape, password-manager overlay (branch `web-run-home-flow`)

Live-testing follow-ups + a class of "value is in the profile but the fill still goes to AI" bugs.

**triBool / boolean → AI leak (the over-18 bug).** "Are you over the age of 18?*" was flagged
`ai-choice-sensitive` "LEGALLY-LOADED — VERIFY" on EVERY fill even though the profile answered it. Root
cause: `resolve()` coerced a boolean profile value to a bare `"true"`/`"false"` string for the RADIO path
only — a yes/no **dropdown** got `"true"`, which never matches a "Yes"/"No" option → escalated to the AI
post-pass. Fixed in BOTH copies (fill-driver.js + the background.js engine, lockstep): a boolean now
resolves to the tiered candidate list `["Yes","True"]` / `["No","False"]` for dropdown/typeahead AND radio
(with array handling), so a checkbox, a true/false dropdown, a yes/no dropdown, and yes/no radios all fill
deterministically from the stored boolean. Regression-pinned in `test/fill-driver.test.js`.

**Answer ladders are their own thing (separate from the question bucket).** The question **bucket** (the
wordings that map a tenant's question to a field) and the **answer ladder** (the acceptable answer variants
for that field) were conflated. Split them, modeled on how Country's tiered list works:
- `answer_ladders: Record<path, {yes:string[], no:string[], values?:string[]}>` lives in `profile_json`
  (NO migration — it rides the existing profile blob). `yes`/`no` = triBool polarity ladders; `values` =
  scalar-field answer variants.
- **Profile page:** every `TextField`/`SelectField` renders an in-field `›` arrow → `AdvancedChoices`
  popup editing `answer_ladders[path].values` — proactively, for EVERY field, so the operator can pre-load
  variants (e.g. GPA `["4.0/4.0","3.5+","3.0+"]`) WITHOUT waiting for a teach. A triBool field's arrow edits
  its yes/no polarity ladder.
- **Teach page:** click the ANSWER → the AdvancedChoices popup shows (mirrors the profile arrow). A
  non-standard yes/no label teaches via a tiered-field ladder draft.
- Fill: `appendFieldVariants`/`boolLadderCandidates` (fill-driver.js) append the ladder's variants as extra
  candidates for choice widgets, keyed by the bucket's `profile_path` VERBATIM (dotted, incl. numeric
  `education.0.gpa`). UI polish: the yes/no toggle HIGHLIGHTS the selected text (not underline) and only
  after it's clicked (you can't open the ladder until a polarity is selected).

**Teach resurface — value-based coverage.** A taught field reappeared on re-approving the same bundle even
though the answer was now in the profile. `bucketCoversAnswer`/`fieldHoldsAnswer`/`profileValueAt`
(web/lib/teach.ts) are now BOOLEAN-aware (a boolean profile value matches "Yes"/"True"/"No"/"False" via
`boolAnswerCandidates`, and honors the custom `answer_ladders`), so a covered+answered question stays
hidden — including when the operator files under their OWN bucket rather than the AI's suggestion.

**Delete-all-skipped (teach).** A "Delete all" button in the teach **Skipped** section clears skipped cards
(distinct from Restore, which requeues them); shown ONLY when the Skipped list is expanded. Persisted via a
`teach_deleted_json` column (migration `0009`) so a hard-deleted skip doesn't resurface.

**Education dual-shape (repeating AND flat).** Workday-style forms ask Education either as a repeat-add
section OR as flat single questions (School / GPA / Degree). The extension only filled the repeating shape.
Now flat education (+ work-experience) fills too, via **Mode-A starter buckets** bound to entry-0 paths
(`education.0.{school_or_university,gpa,degree,field_of_study}`, `work_experience.0.{job_title,company}`),
matched on the tenant's label wording — `getByPath(profile,"education.0.gpa")` reads straight from the
primary entry. No double-fill: the flat driver loop SKIPS fields inside repeating containers (`isRepeating`),
so a repeating tenant fills via the section and the flat buckets don't fire; a flat tenant fills via the
buckets. `ensureStarterBuckets(buckets)` merges the new starters into EXISTING profiles (dedup by
`profile_path`, idempotent, non-destructive), applied where buckets load/sync. Repeating-section fields also
got the answer-ladder affordance (dropped the `\.\d` exclusion). Repeating fill + schema untouched.

**SSO false-positive (a race).** The Run flow halted "This tenant uses SSO / federated login" then worked
on a manual retry. `looksLikeSso` fired before the login form finished rendering (a sign-in button visible,
email/password not yet painted). `doAuth` now waits for the credential form to reveal before the SSO
classification.

**Certification date fields overlapping / off-page.** The Issued/Expiration month-day-year `DateField`
couldn't shrink in a `grid-cols-3` row (fixed segment widths, `flex-1` month, no `min-w-0`), so the two
dates overlapped and ran off the page. Fixed: `DateField` root `group min-w-0`, month input `min-w-0
flex-1`, and the cert/specialty date rows use `sm:grid-cols-2`.

**Password-manager overlay before submit (live).** During live-testing the "Sign In" coordinate click
silently missed and the walk halted `auth-unknown` after the full 20s timeout. Cause: Chrome's
password-manager autofill dropdown is BROWSER chrome painted above the page — `cdpCoverCheck`/
`elementFromPoint` can't see it, so the coordinate click landed on the dropdown. The dropdown only shows
while a credential field is FOCUSED and has no DOM node to query, so the proxy for "gone" is "no credential
field focused". `dismissPasswordManager()` (background.js, wired into `submitAndWait` → covers both the
sign-in and create-account submits): Escape (closes the visible dropdown) + Tab (Escape KEEPS focus; Tab
actually moves focus off the field) then POLL-confirm no email/password input is focused before clicking.
Bounded, best-effort.

Verified per change: extension `node --test test/*.test.js` green (0 fail); web `tsc --noEmit` clean +
`next build` green. The password-manager fix is implemented + compiles/tests-green but LIVE-CONFIRMATION on
the operator's browser is pending (reload the extension from this worktree, re-run the sign-in).

## 2026-07-24 — "Already applied" detector (onboarding halts cleanly, no random error) (branch `web-run-home-flow`)

Live-testing surfaced it: when the signed-in candidate has already applied for a requisition, Workday shows
a dedicated "You've already applied for this job" page (`data-automation-id="alreadyAppliedPage"`) instead
of the form — no form fields, no apply/auth chrome. The onboarding had no detector for it, so it wasted the
12s Stage-3 auth-or-form wait and then halted with a confusing `unknown-page` (or `auth-unknown` after a
fresh sign-in). NOTE the page TITLE is a stale "Create Account" on Magna wd3, so title-matching is useless —
the automation-id is the reliable signal.

**`isAlreadyApplied(state)` (lib.js, pure + unit-pinned).** Primary signal: the `alreadyAppliedPage` marker
(added to `cdpOnboardScan`); body-text fallback (`/you.{0,3}ve already applied|already applied for this
(job|position|requisition|role)/i`) for a tenant that omits it. `runCdpOnboard` checks it at three points —
the initial scan (the common Run case: already signed in → navigate to Apply → redirected here), the start
of Stage 3 (revealed after Apply/Apply Manually, before the 12s wait), and in `doAuth` after a successful
sign-in (Workday shows already-applied instead of the form) — and returns a CLEAN terminal outcome
`{ ok:true, reached_form:false, already_applied:true, stopped:"already-applied", detail:… }`. It is NOT
`needs_operator`: the operator already applied, there's nothing to fix or fill.

**Website (RunPanel).** `interpret` gets a dedicated `already_applied` branch → an "ok"-tone "You've already
applied to this job" result (was falling through to the amber "Needs you to step in"). `ONBOARD_STOP` gains
an `already-applied` fallback line.

Verified: extension `node --test test/*.test.js` green (0 fail; +3 `isAlreadyApplied` tests — marker,
body-text fallback, and no-false-positive on form/auth/apply pages); web `tsc --noEmit` clean + tests 43/43.
Live-confirmation on the operator's browser pending (reload the extension, re-run a job already applied to).

## 2026-07-24 — Employment-status screening radios fill deterministically (no AI, no "LEGALLY-LOADED" flag) (branch `web-run-home-flow`)

A tenant's own worded yes/no question — "If you are a former MAGNA employee, please select Yes… No.",
"Are you currently employed with Magna?" — is NOT Workday's standard `candidateIsPreviousWorker` field, so
it bypassed the deterministic employer-match decider and fell to the required-radio AI fallback
(`aiFillRadio`), which reasons from ABSENCE and is force-flagged `ai-choice-sensitive` → the loud
"LEGALLY-LOADED — VERIFY" badge on EVERY fill, even though the answer is in the profile. The operator wants
these answered confidently without review. Root causes: (a) no handler for these custom-worded questions
(only the standard field routed to the decider); (b) no handler for CURRENT employment (only past); (c)
`jobContext.company` wasn't wired from the JD scrape, so even the standard path was unevaluable.

**The safety principle.** The system already splits "profile answers directly" (deterministic, no flag)
from "AI inferred from absence" (flagged). The fix MOVES these into the first bucket — a "No" becomes a
GROUNDED negative ("the company I'm applying to isn't in my complete employer list") instead of an
absence-guess. It does NOT weaken the flag; it stops these from being guesses.

**Deterministic recognizer, no AI** (`recognizeEmploymentQuestion`, fill-driver.js — a post-pass BEFORE
`aiFillRadio`). Fires when a REQUIRED yes/no RADIO **names the application company** (`jobContext.company`)
**adjacent to an employment word** ("«co» employee", "employed with/at/by «co»", "worked/working
for/at/with «co»"). Anchored on the company you're applying to → **generalizes across tenants, zero
per-tenant config, never calls the LLM**. AI is never the answerer.

**Grounded membership check** (`decideEmploymentStatus`): former/ever reuse the proven `decidePreviousWorker`
(exact match / affiliate-named-in-the-question / partial overlap / clean-miss → No); current →
`decideCurrentlyEmployed`, derived from the work-history `currently_work_here` flags. `optionForPolarity`
maps the Yes/No decision to the LIVE option by leading token, so it commits the verbose "No, I'm NOT
currently employed with Magna" label as well as a plain "No".

**Asymmetric commit** (all existing safety kept): a clean **"No" fills SILENTLY** — status `filled`, no
flag, no review (the whole point). A **"Yes"/uncertain → `filled_review` + `employer-match` flag** →
renders as `employer_match_uncertain` (NOT AI-inferred); **never auto-"Yes"** (truthfulness-adjacent,
unfurls follow-ups). Unrecognized / unevaluable / polarity-unmappable → falls through to the AI/blank
fallback, unchanged.

**Operator decisions (2026-07-24):** (#1) a NON-EMPTY employer list is treated as complete (no extra
affirmation); (#2) current employment is derived from the work-history "I currently work here" flags (no
new field); (#3) a clean miss is always "No" even when the question broadens to affiliates/subsidiaries (we
trust your list — there is no company-ownership database).

**Foundational wiring:** `jobContext.company` is now populated from the JD scrape in the website Run
(`jd.company` → `jobContext.company`, background.js) — the anchor the recognizer needs; also improves the
tracker row. No false fires: "Do you agree Magna may contact your former employers?", "willing to work
weekends at Magna?", and "want to work at Magna?" don't trip it (adjacency window + past/progressive-only
`work` guard).

Scope: the CDP path (fill-driver.js — what the Run flow uses); the legacy page-engine (background.js) is
unchanged (it already lacks the AI radio fallback). Verified: extension `node --test test/*.test.js` green
(645 pass, 0 fail; +9 tests — recognizer positive/negative, `decideCurrentlyEmployed`, `optionForPolarity`,
and end-to-end silent-No / verbose-No / Yes-review / no-anchor-not-filled). Live-confirmation on Magna
pending (reload the extension, re-run — the two Magna questions should fill "No" with no review flag).

## 2026-07-24 — Employment-status hardening: dropdown parity + adversarial-wording guards (branch `web-run-home-flow`)

Operator asked for a double-check of the morning's employment-status feature: does a yes/no DROPDOWN fill
deterministically too, and can adversarial wordings break the recognizer into a WRONG deterministic answer?
Both audits found real holes; all fixed, all unit-pinned.

**Dropdown parity (a real ordering bug).** The check gated on `widgetType === "radio"` only AND sat AFTER
the generic AI FALLBACK block — so a yes/no DROPDOWN version of the same question was AI-filled (flagged)
before the employment check could ever run. Moved the block ABOVE the AI FALLBACK (right after the bucket
consult — placement is load-bearing) and widened to radio + dropdown. Dropdown commit reuses the proven
pieces: `openAndReadDropdown` → `optionForPolarity` vs the live options → the AI path's text-keyed click +
persistence re-read. Prefilled-equal → kept with ZERO value actuation; commit-fail → `needs_review` with
`resolved` set, so `producedNothing` stays false and the AI can never override a made decision.

**Adversarial wordings (each WOULD have silently produced a wrong answer; all now BAIL to the flagged
AI fallback — the safe direction):**
- **Wrong SUBJECT** — "Do you have any relatives currently employed with Magna?", "Were you referred by a
  current Magna employee?", "Is your spouse employed by Magna?" (the question is about someone ELSE).
- **Wrong OBJECT / scope** — "employed by a competitor/supplier of Magna?", "terminated by ANY employer,
  including Magna?" (membership being asked isn't at the application company).
- **Different FACT** — "eligible/legally authorized for employment with Magna" (a WORK-AUTH question — a
  clean-miss "No" would be wrong), termination manner, reference-contact consent, policy/handbook agreement.
- **Inverted POLARITY** — "I certify that I am not a current employee of Magna" (the right answer for a
  non-employee is YES; the polarity map would say No), "are you not / no longer employed". The REAL Magna
  Q1 ("If you are not a former MAGNA employee, please select No.") is EXEMPTED by its same-sentence
  select-instruction — the target question survives every guard (pinned).
- **ASPIRATIONAL** — "Would you accept employment with Magna?", "able to begin employment immediately?"
  (they're applying; a clean-miss "No" would be absurd).
- **Cross-sentence contamination** — "Do you have a criminal record? Magna requires all employees to
  disclose." The recognizer is now SENTENCE-SCOPED: one sentence must name the company, hold an employment
  word within 3 tokens, AND ask about YOU (`EMPLOY_ASK_RE`); bails otherwise.
- **Tense combination** — "current or former Magna employee?" now → "ever" (decidePreviousWorker), so a
  former employee is never mis-answered by a current-only check.
- **Overwrite guard (both widgets)** — a pre-existing DIFFERENT real value (a prior run / human answer) is
  never silently overwritten: the grounded answer commits but is FORCE-flagged for review.
- **Regex sharpening** — `\bable\s+to\b` (bare "able to" matched inside "applicABLE TO you" — Magna Q1
  boilerplate says "applicable"); `\breferr` (matched inside "pReferred").

Verified: extension suite green — 661 pass, 0 fail (+16 tests: the full adversarial battery, the two REAL
Magna labels verbatim as survivors, dropdown parity incl. silent-No/verbose/Yes-review/prefill-kept/
overwrite-forced-review, and the bare-vs-granular Yes option semantics). Live-confirmation on Magna pending.

## 2026-07-24 — Employment-status: ALL widget types (text/textarea + checkbox join radio/dropdown) (branch `web-run-home-flow`)

Operator: the employment-status questions must fill correctly on EVERY answer widget, not just radio +
dropdown. Extended the deterministic tier to text/textarea and checkbox; also made it run for OPTIONAL
fields (it's a deterministic tier like buckets — the AI fallbacks stay required-only).

- **Recognizer:** `EMPLOY_ASK_RE` gains the FIRST-person assertion form ("I am/was a «co» employee") — the
  checkbox rendering; the negated "I am not…" was already an inverted-polarity bail.
- **Text/textarea:** types the polarity word ("Yes"/"No") via `fillTextCdp`; clean No silent, Yes/uncertain
  review-flagged; a pre-existing DIFFERENT value → commit + forced review; already-equal → kept, zero
  actuation. A **detail-REQUEST** field ("please enter/list/provide your employee ID/dates…") is NOT a
  yes/no ask → bailed to AI-2 (a bare silent "No" in an ID box would be sloppy). Note the Magna Q1 wording
  ("…enter all the applicable information below") self-selects OUT of the text path via "enter".
- **Checkbox (operator decisions mid-build):** a REQUIRED checkbox is STILL always auto-checked — required
  can't stay blank ("still keep the auto check for every required checkbox"). But when the label is a
  recognized employment ASSERTION and the grounded answer is "No", the silent auto-consent would silently
  assert what the profile contradicts → the check stays, FLAGGED `filled_review`+`employer-match`.
  Agreement (grounded Yes) / unevaluable → silent as before; ordinary consent checkboxes are byte-identical
  (their agree/authorize/policy wording bails the recognizer). An OPTIONAL checkbox is DETERMINED ("this is
  if the checkbox is not required then you can determine whether to check it or not"): check="Yes" (always
  review), uncheck="No" (virgin box → zero actuation, silent; clearing a pre-TICKED box → forced review).
- Verified: extension suite green — 674 pass, 0 fail (+13 tests: first-person recognition, required-checkbox
  contradiction flag + agreement-silent + consent-unchanged, optional-checkbox No/Yes/pre-ticked, text
  silent-No/Yes-review/detail-request-bail/overwrite, textarea, optional-radio tier). Live-confirmation on
  Magna pending.

## 2026-07-26 — Per-application LOGIN on the backend + a SUBMIT button on the Run page (branch `worktree-background-fill`)

Two operator asks, plus a real safety bug the second one surfaced.

### 1. Which account each application was filed with (`applications.login_*`, migration `0011`)

Workday accounts are per-TENANT, so "what did I sign in as on this one?" is a real question weeks later when
a recruiter replies — and after a create-account run the tracker row is the only record that the account
exists at all. Until now the sign-in lived in exactly one place (`profiles.credentials_json`, one row for
everything) and nothing tied an account to an application.

**Migration `0011_application_login.sql`** — `applications` gains `login_email`, `login_tenant`, `login_host`,
`login_created` (the account was CREATED on that run vs signed in to), `login_verified` (the email
round-trip completed), `login_at`, plus a `(user_id, login_email)` index ("which applications went through
this account?"). The PASSWORD is deliberately NOT copied per row — it lives once, on `credentials_json`;
duplicating the same secret across rows buys nothing.

**The extension is the source of truth** — it's the thing that actually signed in, so it records what it
USED, not what the website separately has stored (the two can diverge if an edit never synced).
`recordRunLogin({email,url,tenant,created,verified})` (background.js) writes `chrome.storage.local.lastRunLogin`
the moment a run reaches the form, at BOTH onboarding call sites (the website `AP_RUN_APPLICATION` and the
popup's `RUN_CDP_ONBOARD`, so a popup-driven fill is tracked too). `getRunLoginFor(bundleUrl)` then attaches
it to `reportApplication`'s payload — **match-gated**: an exact `job_key` match, else a same-tenant match,
else `null`. A stale record from a previous run against a different tenant must never be reported as this
application's account: **no login beats a wrong login.** An empty email also yields `null` — that's a
hand-signed-in run and there is nothing truthful to record.

Both writers fill the same columns and agree: `POST /api/extension/report` maps `body.login` through
`loginFields()`, and the website's `saveRunJob` takes the login straight out of the run response (the
handlers now RETURN the recorded object) via `loginPatch()`. Both treat "no usable record" as `{}` — an
older extension build or a hand-signed-in run never BLANKS a login already on file.

**UI:** the tracker detail header renders `LoginLine` — "Signed in as `you+magna@…` on Magna" with
`account created` / `email verified` badges and a link to the Sign-in page. Nothing renders when unknown,
rather than implying an account we can't vouch for.

### 2. A Submit button on `/app/run` (`AP_SUBMIT_APPLICATION`)

The strict-replay SUBMIT pipeline has been live-verified in simulate since 2026-07-12, but it was reachable
only from the popup's armed button on an already-open tab. Now the site drives the third stage the way it
drives the first: paste the same job link → **Submit**.

**`AP_SUBMIT_APPLICATION` (background.js)** — the SECOND external message that actuates, and the only one
that can submit: pull the approved bundle for ONE job → pre-flight → open the posting in a fresh tab →
`runCdpOnboard` (sign in, record the login) → `runCdpReplayWalk({authorize:true, simulateSubmit:!arm, jobKey})`
→ strict per-field verify per page → review-page equality → `submitPrecondition` → submit ONCE.
`arm:true` is the per-run token; WITHOUT it the run is a full DRY rehearsal — same code path end to end,
logging "▶▶ WOULD CLICK SUBMIT ◀◀" instead of clicking. Always a FOREGROUND tab: the replay path uses
trusted input (it has no synthetic-input fast path, unlike the fill), and an irreversible action should be
watchable while it happens. `simulateSubmit:true` stays HARDCODED in the popup's `RUN_CDP_SUBMIT` — this
handler adds a caller, it does not relax the existing gate.

**`bundleSubmitBlockers(bundle)` (fill-driver.js, PURE)** — the BUNDLE-decidable half of the submit gate
(a real bundle, an accepted schema, every flagged/revealed field approved, no unreplaced AI placeholder),
EXTRACTED from `submitPrecondition` so there is ONE implementation and no lockstep dup. Two callers: the
live gate folds it in (unchanged behavior, blocker order preserved), and the submit run uses it as a
PRE-FLIGHT before opening a tab — so "3 fields still need approval" costs milliseconds instead of a full
sign-in + replay. A named invariant test pins that every pre-flight blocker is ALSO reported by
`submitPrecondition`: the pre-flight can never be laxer than the authority.

**⚠ SAFETY BUG FIXED (found while wiring this).** `pullApprovedBundle` keyed the pull on the LOCAL bundle's
url, and `GET /api/extension/review`'s no-match fallback is "the most-recently-updated application that HAS
a bundle". A submit run for job B while storage held job A's fill would therefore have replayed **A's
approved answers into B's form and submitted it** — the worst possible failure for this tool. Fixes, all
three: `pullApprovedBundle(LOG, {jobKey})` targets by the run-stable `job_key`; the review route NEVER
widens to the url/most-recent fallbacks when a `job_key` is given (no match ⇒ `bundle:null`); and the
submit run REFUSES on no match instead of replaying whatever is in storage. `runCdpReplayWalk` takes
`opts.jobKey` and threads it into its own re-pull, so the walk can't re-clobber the targeted bundle either.

**Web (`RunPanel.tsx`)** — a "Submit this application" card beside the existing Run buttons: **Rehearse
(no submit)** and **Submit** behind a two-step confirm ("Submit for real? This can't be undone." →
Yes/Cancel), the pending confirmation dropped whenever the link is edited. `interpretSubmit` maps every
outcome to plain language (`REPLAY_STOP` for the replay halts, which mostly mean "the form changed since
you approved it — re-fill and re-approve"), and gate blockers render as a list instead of an opaque stop.
`saveRunSubmit` (run/actions.ts) is the ONE place an application becomes `submitted` — the extension
deliberately never reports that status ("the human submits"), and here the human authorized it on this page;
a rehearsal writes no status at all, so it can never make an unsubmitted application look submitted.

Verified: extension suite green (724 pass / 0 fail — +8: `bundleSubmitBlockers` approved/unapproved/
cascade-revealed/empty/stale-schema/placeholder/soft-deleted + the never-laxer invariant); web
`tsc --noEmit` clean, production build green, web tests 59/59. **Live-verification pending** (needs the
operator's browser + Supabase: run migration `0011`, reload the extension, then Rehearse on an
already-approved job before ever pressing Submit).

## 2026-07-26 — Website URLs require `www` (the full canonical link) (branch `worktree-background-fill`)

Fallout from a live LinkedIn card on `/app/teach`. The profile held `https://linkedin.com/in/wangykev`,
the bucket filled it cleanly (`status:"filled"`, `flag:"bucket"`, `verified:true`) — and yet the field
came back flagged on the review page with the `www.` form as its value. Nothing in the repo adds `www.`
(the only match repo-wide is an SVG namespace), so the www came from the page/operator, and the two
strings then fail EVERY equality tier we have:

| check | result |
|---|---|
| `textValuesMatch` (M40 audit, fill-driver) | **false** — exact-match plus a PHONE-digit relief only, and `PHONE_SHAPE` excludes anything containing a letter, so URLs get nothing |
| containment (`valuesAgree`, lib.js) | **no** — `www.` is inserted MID-string, so neither side contains the other |
| fuzzy | **89** vs the 90 bar — missed by one point |
| `reconcileReviewPage` | **DISAGREE** |
| `submitPrecondition` | **BLOCKS** — `"1 review-page value(s) DISAGREE with the approved bundle"`, and the blocker doesn't even name the field |

So a bare-host profile value doesn't just nag on review — it can refuse a submit outright. Operator's
call: fix it at the SOURCE by storing the canonical link, rather than adding a URL relief to the
comparators.

**`ensureHttps` (lib.js) / `ensureHttpsUrl` (web/lib/profile-schema.ts) — LOCKSTEP.** Both now return
scheme + `www.` on a bare apex host: `linkedin.com/in/x` → `https://www.linkedin.com/in/x`.

**`www` goes on an APEX host ONLY** — this is the load-bearing restriction. `www.blog.example.com`
generally does not resolve, and neither does `www.<personal-domain>` on much personal hosting, so
blanket-prefixing would turn a WORKING profile link into a dead one — a worse failure than the mismatch
being fixed. An apex is 2 labels (`linkedin.com`) or 3 whose last two match a public multi-part suffix
(`/^(co|com|net|org|edu|gov|ac|gob|mil)\.[a-z]{2}$/` → `example.co.uk`). A host that already carries ANY
subdomain (including `www.`), an IP host, or userinfo is returned UNTOUCHED. The output is spliced after
the scheme rather than rebuilt via `URL.toString()`, which would also normalize the rest (appending a
trailing `/` to a path-less URL); `URL` is used for the DECISION only, wrapped so it never throws.

Idempotent by construction (an already-canonical URL returns byte-identical — no `www.www.`), which is
what makes re-normalizing safe: it runs on schema PARSE and on editor blur, so a stored profile
self-heals on its next save with no migration. Editor hint/placeholder/error updated to say "including
www". CAVEAT recorded for the operator: `github.com` → `www.github.com` (redirects fine, but GitHub's
canonical is bare), and a personal domain without a www record is the one case to eyeball.

Verified: a cross-check script ran BOTH copies over 16 inputs (bare/scheme'd/already-www/subdomained/
multi-part-TLD/IP/localhost/empty/whitespace) — byte-identical on every one. Extension suite **728/728**
(+5 ensureHttps tests: canonicalization, idempotency, subdomain-never-www, multi-part suffix, IP +
no-throw); web tests **62/62** (+3, existing website-URL expectations updated); typecheck + build green.
Live-verification pending (re-save the profile, re-sync, confirm the LinkedIn field fills www and the
audit stops flagging it).

## 2026-07-27 — The false "SSO" halt: a hidden-tab render race, and waits that couldn't say why (branch `worktree-background-fill`)

Operator report, Caterpillar wd5, BACKGROUND (hidden) run — intermittent, not reproducible on demand:

```
[ONBOARD] clicked "Apply Manually".
[ONBOARD] waitFor(post-apply-manually) timed out after 20000ms
[ONBOARD] Stage 3 — auth screen detected.
[ONBOARD] waitFor(sign-in-form-render) timed out after 8000ms
[CDP] detached from tab …
```
…and then, looking at the tab: the CREATE ACCOUNT page, fully rendered, "with everything". The run had
reported **SSO** — "idk where that log even came from", and the operator's rule: *Workday will never be SSO.*

**Root cause (reproduced in a unit harness, not inferred).** A chain of three:
1. A hidden tab paints slowly. `waitFor(post-apply-manually)` burned its full 20s — then the very next
   scan saw the auth screen. That timeout was itself the evidence the page needed >20s.
2. Stage 3 fires on `hasAuthEl`, which is true via `createAccountSubmit`/`signInLink` — while
   `emailInput`/`passwordInput` are still absent. So the flow entered the race-guard block, whose budget
   is a flat **8s**. The widget hadn't painted its inputs in that window either.
3. Fall-through to `looksLikeSso(st)` — whose second branch infers SSO from a MISSING email/password
   field plus any "sign in"-texted clickable. Caterpillar's create-account view carries an "Already have
   an account? **Sign In**" link → `signInButtonPresent` true → **SSO halt on an ordinary create-account
   page.** Fed the real state into the pure function: `looksLikeSso(...) === true`. Confirmed.

The operator sees a fully-rendered page afterwards because *looking at the tab foregrounds it* — the
classic heisenbug shape for this class.

**Fix 1 — field-absence is not SSO evidence on a Workday host.** `looksLikeSso` keeps the URL test
(POSITIVE evidence: a real federated login LEAVES the Workday host for okta/ping/saml/…), and now returns
false for the absence branch when `isWorkdayHost(url)` (new pure helper, exported). Unit-pinned both ways:
a mid-render Workday page (careers host AND the logged-in `myworkdaysite` form host) is NOT sso; an
Okta/Microsoft redirect still IS; a non-Workday host keeps the original inference unchanged.

**Fix 2 — render budgets scale with visibility.** Both auth-render waits go through
`renderBudget(visibleMs, hiddenMs)` (`cdpVisible`-gated): post-apply-manually 20s→**45s** hidden,
sign-in-form-render 8s→**30s** hidden. VISIBLE keeps the tuned, live-verified values, so the foreground
happy path is byte-identical. A genuinely fieldless auth screen (no create-account affordance either) now
halts **`auth-form-not-rendered`** — "if you ran this in the background it's usually a slow repaint, run
it in the foreground" — instead of blaming SSO. New `ONBOARD_STOP` copy on the Run page.

**Fix 3 — the waits can now explain themselves** (the operator's actual ask: "put a log so if it happens
again we can be sure"). Three different failures used to print one indistinguishable line:
- `scan()` swallowed EVERY read error into `null` — a destroyed execution context mid-navigation, a
  detach, a page exception and "not there yet" were the same thing. It now counts OK/failed reads and
  keeps the last error text.
- A `waitFor` timeout logs those read counts, the tab's REAL visibility (SW-side `cdpVisible`, not the
  page's spoofed `visibilityState`), and `describeState(last)` — url · title · **readyState** (new field
  on `cdpOnboardScan`: was the document still parsing?) · formFields · email/password/signInWithEmail/
  signInButtonText/hasAuthEl · the list of present markers. It also returns the last SUCCESSFUL scan
  rather than a possibly-null final attempt.
- Every `needs_operator` halt in the auth stage now goes through `haltNeedsOperator`, which LOGS the
  reason and that page state. They were silent returns, which is why the console just stopped at
  "detached" with the reason visible only in the popup/website response.

Had these existed, the original report would have read: *hidden tab, 16 reads OK / 0 failed, readyState
complete, hasAuthEl true, email=false password=false, markers=[signInLink,createAccountSubmit]* — i.e.
"the page is fine, the fields just aren't painted yet", not "SSO".

Verified: extension **730/730** (+4 looksLikeSso regression tests); web typecheck + build green.
⚠ **Unresolved flake:** one full-suite run in seven failed with a bare `ERR_ASSERTION (actual:false,
expected:true)`; six consecutive re-runs were clean and the failing test name wasn't captured. Not
introduced by this change (the only unit-tested surface touched is `looksLikeSso`, which is pure and
deterministic) — recorded here so the next sighting can be tied to this one.
Live-verification pending: re-run the Caterpillar job in the background and confirm it now signs in (or
halts with a truthful reason + a state dump) instead of reporting SSO.

## 2026-07-27 — Onboarding's cover-check re-measures (the phantom "covered by locations…" refusal)

Second Caterpillar wd5 background-run report, same day, different symptom — and it worked on a re-run:

```
[ONBOARD] Stage 1 — clicking "Apply (job listing)".
[ONBOARD] "Apply (job listing)" is covered by div.css-cygeeu "locationsSan Diego, California"
          — refusing a blind click.
[CDP] detached
```

**That "cover" is ordinary page content** — the job-details location block. It can't overlay the Apply
button; it sits in the normal flow. So the coordinates were wrong, not the page.

**Root cause: a STALE RECT after a reflow.** `clickTarget` (the onboarding click primitive — Apply /
Apply Manually / the Sign In tab / the auth view-switch links) measured the button rect ONCE with
`cdpRectReady`, then ran `cdpCoverCheck` at those coordinates, and re-checked at the SAME coordinates
after any dismiss attempt. This is precisely the bug `clickPageNext` was fixed for on **2026-07-25**
(a fill-revealed SMS-consent checkbox reflowed the footer downward → the old point hit a floating
extension widget → halt blaming a phantom overlay). The fix was never ported to the onboarding path.

The trigger here is hydration, not a fill: the run's own log shows the JD scrape returned **461 chars**
(and a raw `XMLNAME …` title) where a healthy run on the same posting got **2913**. The page was still
filling in; content above the Apply button grew; the button moved down; the measured point ended up
inside the details panel. A hidden tab makes that window much wider — and re-running worked because the
second load was warm.

**Fix.** `clickTarget` now mirrors `clickPageNext`: a `probe()` that re-measures the rect AND re-runs the
cover check together, looped up to **3 × 250ms** before any cover is believed (which also lets a real
animating overlay settle), a FRESH probe after clicking a dismiss control (dismissing reflows the page
too), and a refusal message that states the rect was re-measured — so a future refusal means a genuine
overlay rather than a coordinate artifact. Standing rule added to CLAUDE.md: any new coordinate-click
site must re-measure inside its cover loop.

Verified: extension **730/730**, `node --check` clean. Live-verification pending (re-run the Caterpillar
job in the background; Stage 1 should click through instead of refusing).

**Noted, NOT fixed** (separate, non-blocking): the JD scrape can capture a partially-hydrated page (461 vs
2913 chars), so the tracker's saved job description is occasionally truncated and the title keeps
Workday's `XMLNAME` prefix. `AP_RUN_APPLICATION` waits `waitTabComplete` + a flat 1500ms hydration beat,
which is not enough for a hidden tab. A settle-poll (wait for body-text length to stop growing, bounded)
would fix both — deferred pending the operator's go-ahead since it adds latency to every run.

## 2026-07-27 — Settle-poll the job posting before reading or clicking it (operator go-ahead)

The deferred half of the previous entry, approved by the operator. The JD page is an SPA render: the tab
reports "complete" when the DOCUMENT loads, but Workday keeps filling the posting in afterwards, and the
old wait was a flat `setTimeout(1500)`. On a hidden tab that under-waits, with two observed costs:
- the saved job description was TRUNCATED (**461 chars** of a posting that healthy runs read as **2913**),
  and the role came out as Workday's raw slug `XMLNAME 2027 Gas Turbine …` because the real
  `jobPostingHeader` hadn't rendered, so the URL-slug fallback won;
- the still-growing page REFLOWED the Apply button out from under Stage 1's cover-check → the phantom
  `covered by div.css-cygeeu "locationsSan Diego, California"` refusal.

**`waitJobPageSettled(tabId, ceilingMs=12000, intervalMs=300)`** (background.js) polls the page via
`chrome.scripting` (no debugger attach exists yet at this point in the run) for
`{ len: body.innerText.length, hasPosting, readyState }`.

**The accept rule is PURE and unit-pinned — `jobPageSettleStep(read, state)` (lib.js)**, folded over the
reads, mirroring the fill's settle-poll discipline (two CONSECUTIVE EQUAL, non-empty reads — never a
fixed sleep). The twist over a plain byte-count settle: a stable count is only TRUSTWORTHY once the
posting's own content (`jobPostingDescription` / `jobPostingHeader`) is present. Without it the rule
demands 3 repeats, because a page can PAUSE mid-hydration and hold a partial count — exactly the 461-char
observation, which a naive "two equal reads" would have accepted immediately. 5 tests pin it: warm load
(settles on read 3), the 461 stall (never accepted on one repeat), stall-then-render (settles once the
real content lands), an unrecognized-marker page (still settles at 3 repeats — never block forever), and
empty/unreadable reads (never settle).

Properties worth keeping: it EXITS EARLY on a warm load (~2 polls ≈ 600ms), so the common case is now
FASTER than the 1500ms beat it replaced; it is best-effort — a read failure or the ceiling proceeds
anyway, since the scrape and the onboarding scan are each independently guarded, so a too-early return
costs a retry and never a wrong action; and it logs what it decided (`SETTLED after Nms — C chars,
posting content present`), so a future partial scrape is self-evident in the console.

Wired into BOTH `AP_RUN_APPLICATION` and `AP_SUBMIT_APPLICATION` — the submit run doesn't scrape a JD, but
it clicks the same Apply button through the same cover-check. Also: `scrapeJobDescription` strips the
`XMLNAME` prefix Workday puts on a slug whose title starts with a digit, so that artifact can't reach the
tracker as the role name even if the header fallback is ever used again.

Verified: extension **735/735** (+5). Live-verification pending — re-run the Caterpillar job in the
background and confirm the log reports a settled page with the full character count.

## 2026-07-27 — The REPLAY adapts to Workday's phantom duplicate-entry error (deterministic, no AI)

Live replay on solarturbines (Caterpillar family), page 2:

```
[CDP-REPLAY-WALK] page 2 replay: 31 field(s) — 8 changed, 21 already-correct, 0 FAILED.
[CDP-REPLAY-WALK] page 2 Save & Continue: {"clicked":true}
[CDP-REPLAY-WALK]   re-click fallback: error text present — NOT re-clicking (a real validation block…)
[CDP-REPLAY-WALK] page errors (1):
[CDP-REPLAY-WALK]     • Error-URLYou can't add duplicate website URLs.
[CDP-REPLAY-WALK] ⚠ page 2 did NOT advance … HALT
```

**This is not our bug and not a real duplicate.** The replay filled correctly (0 FAILED) and the page
shows three DISTINCT URLs. Operator's diagnosis: *"the workday backend is flaky … sometimes it will
append instead of replace, making it seem like there are duplicates. On the actual page there is no
duplicates, but workday gives us an error saying there are."* So the duplicate exists only in Workday's
STORED copy, and the form is clean.

**What Workday accepts is deleting the VISIBLE rows** — its retained copy then satisfies the section,
which is why the values still show on the REVIEW page afterwards. Operator's requirement, both halves:
delete the fake duplicates, **and** make sure the websites are still there at review as if we hadn't.

**`clearPhantomDuplicates(act, results, errorSamples, LOG)`** (background.js), wired into the replay
walk's nav-timeout branch as the ONE remediation a replay performs (it still runs NO AI-4). It reuses the
existing PURE plan from the fill walk's Tier 0 rather than inventing a second rule:
`isDuplicateWebsiteError` / `isDuplicateLanguageError` → `websiteDeletionPlan` / `languageDeletionPlan`,
where a REAL duplicate (two rows sharing a value) deletes only the later occurrence(s) and all-distinct
rows are the PHANTOM case. For PHANTOM it clears every **LIVE** row (driven by `act.entryCount`, not the
results' indices, which can lag the DOM after a re-render). Then it re-clicks Save & Continue and the
walk continues. **Bounded at 2 per RUN** — a duplicate error that survives the fix is a real problem, not
something to retry.

**The retention premise is CHECKED, not assumed.** The deleted values remain in the approved bundle, so
`reconcileReviewPage` at the review page already compares them against what Workday displays, and a value
that did NOT come back lands in `missing_on_review` — which `submitPrecondition` treats as a HARD blocker.
Added on top: the walk records what it deleted (`phantomDeleted`) and ATTRIBUTES the outcome at review —
either `✓ phantom-duplicate check: all N deleted website value(s) are present on the review page` or a
loud `⛔ … did NOT come back … submitting would file this application WITHOUT them`. So the safety
property is "we never submit an application whose websites Workday silently dropped", enforced by the
existing gate rather than by trust.

**Refactor (no behavior change):** the row-delete loop (highest-index-first, count-polled, stop on
no-progress) was duplicated in both Tier-0 blocks; it is now `deleteEntriesByIndex(act, prefix, indices)`
— ONE implementation shared by the fill walk's language + website tiers and the new replay path, so they
can't drift. The Tier-0 blocks keep their own logging and record-merging, so the fill walk's observable
behavior is byte-identical.

Verified: extension **735/735** (the existing dup-plan tests cover the pure decision layer and still
pass through the refactor); the live error string from the log was fed to `isDuplicateWebsiteError` →
true, and the three distinct live rows → `{mode:"phantom", deleteIndices:[0,1,2]}`, i.e. clear the
section. `clearPhantomDuplicates` / `deleteEntriesByIndex` live in background.js, which the node test
runner can't require (SW `importScripts`), so they carry no direct unit test — the decision layer they
call is pure and pinned, and the delete loop is the fill walk's live-verified one.
Live-verification pending: re-run the replay and confirm page 2 advances after the fix, then that the
review page shows the websites (the `✓ phantom-duplicate check` line).

## 2026-07-27 — Phantom duplicate-entry fix generalized to ALL repeating sections, both walks

Follow-on to the entry above, per the operator: *"make the duplicate fix for all repeating sections
during the run and the review … during the fill, if you deleted the section, make it show as filled on
the review page … for the review, if it is depleted, make sure it shows back on the workday review page."*

Three changes.

**1. EVERY repeating section, in BOTH walks.** The remediation was two hardcoded tiers (language-only,
website-only) in the fill walk plus the replay hook added earlier. It is now ONE function,
`clearPhantomDuplicates`, called by the fill walk as AI-4 **Tier 0** and by the replay walk as its only
remediation. New PURE helpers in lib.js, unit-pinned:
- `duplicateErrorSection(errorTexts)` — routes a "duplicate…" error to a section by wording
  (website / language / education / workExperience / certification), and claims NOTHING for a
  non-duplicate error or a duplicate naming no section we model (pinned both ways — a plain
  "The field School is required" must never authorize deleting a section).
- `sectionEntriesFromResults(results, section)` + `sectionDeletionPlan(entries)` — the generic of the
  website/language pair, keying a row on the **composite signature of all its fields**, because most
  sections aren't identified by one value (a work-experience row is title+company+dates). website and
  language keep their bespoke, value-aware helpers (live-verified); everything else uses the generic.
Real-vs-phantom is unchanged: identical rows ⇒ delete the later occurrence(s); all-distinct ⇒ PHANTOM,
clear every LIVE row (`entryCount`-driven, since the results' indices can lag the DOM).

**2. Deleted rows now stay FILLED in the review summary.** This was a real gap: Tier 0 deletes the rows,
then the pre-advance `reconPageTruth` marks anything no longer on the page `status:"removed"` → "dropped
from review" → `repersistPageBundle` writes a bundle with the whole section MISSING. So the operator's
review page lost a section that is still on the submitted application. `markPhantomKept` now flags those
records `phantomKept` (+ annotates the detail with why they're absent from the form), and
`reconPageTruth` SKIPS flagged records in its removal sweep. Status stays `filled` deliberately — the
operator asked for them to read "as if we did not delete it".

**3. The retention premise is verified at Workday's review page.** Unchanged in mechanism from the
previous entry, now covering any section: the values stay in the approved bundle, so
`reconcileReviewPage` compares them against what Workday displays and a value that did not come back is
`missing_on_review` → a HARD `submitPrecondition` blocker, with the replay walk attributing it in the log
(`⛔ the … value(s) we deleted … did NOT come back`) so a blocked submit names its cause.

Also folded in: the row-delete loop existed twice (both Tier-0 blocks) and now has a third caller, so it
is `deleteEntriesByIndex(act, prefix, indices)` — one implementation, highest-index-first, count-polled,
stops on no-progress.

Verified: extension **740/740** (+5 pure tests: per-section error routing, the two negative cases,
composite-signature entries, real-vs-phantom, empty-section). `clearPhantomDuplicates` /
`markPhantomKept` / `deleteEntriesByIndex` live in background.js (not requireable by the node runner —
SW `importScripts`), so they carry no direct unit test; the decision layer they call is pure and pinned.
Live-verification pending: a replay that trips the duplicate error should log `⟳ Workday rejected Save &
Continue with a duplicate-… error`, advance, keep the section visible+filled in the review summary, and
finish with `✓ phantom-duplicate check: all N deleted … value(s) are present on the review page`.

## 2026-07-27 — Workday's EMPTY page after a sign-in submit: reload instead of halting

The new wait-diagnostics earned their keep on the first submit rehearsal. Full evidence, from one run:

```
[ONBOARD] clicked "Sign In submit".
[ONBOARD] waitFor(Sign In submit outcome) timed out after 500ms — 8 read(s) OK / 0 failed; tab VISIBLE.
[ONBOARD]   last page state: … title="Sign In" · readyState=complete · formFields=2 · email=true ·
            password=true · hasAuthEl=true · markers=[applyFlowPage,createAccountLink,formField,signInSubmit]
[ONBOARD] Sign In submit: no outcome after 500ms and the form is still up — re-clicking…
[ONBOARD] clicked "Sign In submit (retry 1)".
[ONBOARD] waitFor(Sign In submit outcome) timed out after 6000ms — 94 read(s) OK / 0 failed; tab VISIBLE.
[ONBOARD]   last page state: … title="Create Account" · readyState=complete · formFields=0 · email=false ·
            password=false · hasAuthEl=false · markers=[none]
[ONBOARD] sign-in outcome: unknown.
[ONBOARD] ⛔ HALT (needs operator) — auth-unknown: Create Account — Skip to main content This site uses…
```

Note what the state dumps establish, which the old one-line timeout could not: **94 reads succeeded, 0
failed** — the extension was reading the page perfectly. The page itself was EMPTY: fully loaded, zero
form fields, zero auth chrome, no markers at all, body text nothing but the cookie banner, under a stale
"Create Account" title. Nothing to classify (`classifyAuthOutcome` → `unknown`), nothing to act on.
Operator: *"the solution is to just refresh the page."*

**`isBlankAuthPage(state)` (lib.js, PURE, unit-pinned)** detects exactly that shape, and `doAuth` now
RELOADS + re-enters the auth loop instead of halting — bounded at 2 (`MAX_BLANK_RELOADS`), after which it
halts `blank-page-after-signin` ("Workday kept returning an EMPTY page … refresh the tab and re-run"),
with matching Run-page copy.

**Strictness is the whole design**, because what this authorizes is a page reload: it requires
`readyState === "complete"` (so it can never fire mid-navigation, where absence proves nothing) AND every
actionable marker absent — any form field, any auth control (email/password/submit/links/verifyPassword),
any apply-chain button, the already-applied marker, or more than ~700 chars of body text disqualifies it.
A scan lacking `readyState` (an older build) fails closed. Pinned with the live state as the positive
case plus seven near-misses, including the live sign-in form captured one step earlier in this very log.
It sits BEFORE the breach-dialog branch (which requires `signInSubmit` present — mutually exclusive with
a blank page) and before the `auth-unknown` halt, so no working path changes.

**Correlation recorded, not acted on:** the blank page appeared after the **500ms fast re-click** of Sign
In. The first click was almost certainly in flight rather than swallowed — at 500ms the form was still up,
which is what `submitAndWait`'s `formStillUp` guard reads as "re-click". Double-submitting Workday's
sign-in is a plausible way to reach a broken shell. The tuned 500ms tier is deliberate (2026-07-22: a flat
500ms pre-click was too slow on the happy path), so it was left alone; if this recurs, lengthening that
first Sign-In tier is the next lever, and the reload recovery makes it non-fatal meanwhile.

Verified: extension **743/743** (+3), web typecheck clean. Live-verification pending — the next
occurrence should log the reload and continue instead of halting.

## 2026-07-27 — The REPLAY walk reloads on Workday's soft-error page (and stops blaming the bundle)

Live, on a **Rehearse (no submit)** run:

```
[CDP-REPLAY-WALK] ⚠ ARMED REPLAY WALK (authorize=true) — replaying the 63 approved field(s)…
[CDP-REPLAY-WALK] ──── REPLAY PAGE 1 ────
[CDP-REPLAY-WALK] ⚠ page 1: NO matching page in the approved bundle (live flat fields: none;
                  repeating: none). The bundle never captured this page — HALT.
```

The tab was on Workday's transient **"Something went wrong / please refresh"** page. The FILL walk has
reloaded past that since 2026-07-22 (`softErrorPresent`, checked at the top of each page and again after
the fill, → `reloadAndSettle` + restart from page 1). The REPLAY walk never got that guard.

The resulting message was worse than a bare failure: the error page has no form, so `liveNames` and the
repeating scan both came back empty, `selectPageBundleEntries` matched nothing, and the walk concluded
**"The bundle never captured this page"** — pointing the operator at a 63-field approved bundle that was
entirely fine, for a Workday hiccup a refresh clears.

**Two fixes.**

1. **Soft-error parity.** `runCdpReplayWalk` now checks `nav.softErrorPresent` at the TOP of each page
   (before the no-form / no-match paths can misread it) and `navAfter.softErrorPresent` after each page's
   replay — the same two spots, in the same order, as the fill walk. Each reloads via `reloadAndSettle`
   and `continue restartWalk`; a reload returns Workday to page 1, so the whole replay restarts, and
   skip-if-correct makes the already-correct pages cheap on the way back. Bounded by
   `MAX_REPLAY_SOFT_RELOADS` (3/run, mirroring the fill walk's `MAX_SOFT_RELOADS`), after which it halts
   `workday-soft-error` with a needs-operator message instead of looping.

2. **An EMPTY page is never blamed on the bundle.** Before the "not in the approved bundle" halt, the
   walk now asks whether the page has ANY flat fields or repeating sections at all. None of either means
   there is nothing on screen to match — a hiccup, a page still rendering, an error shell — which is a
   PAGE problem, not a coverage gap. It reloads + restarts on the same budget, then halts
   **`replay-page-empty`**: *"The approved bundle is fine; the PAGE never rendered."* The
   `replay-page-not-in-bundle` halt now only fires when the page genuinely HAS fields that the bundle
   doesn't cover — which is what that message always claimed.

Run-page copy added for both new stops (`workday-soft-error`, `replay-page-empty`).

Verified: extension **743/743**, web typecheck clean. Live-verification pending — re-run the Rehearse; a
soft-error page should now log the reload + restart rather than halting on page 1.

## 2026-07-27 — Why the phantom-duplicate fix deleted 0/2, and the rebuild on the real walk's mechanism

The fix fired correctly on a live Rehearse and then did nothing:

```
[CDP-REPLAY-WALK] ⟳ Workday rejected Save & Continue with a duplicate-website error, but the page shows
                  no duplicates (phantom) … Deleting 2 visible row(s): [linkedin, github]
[CDP-REPLAY-WALK]    deleted 0/2 website row(s).
[CDP-REPLAY-WALK] ⚠ page 2 did NOT advance (nav-timeout, real error present) — HALT
```

**Root cause: a hardcoded fkit prefix.** The section registry pinned websites to `webAddress-`, so the
loop opened with `act.entryCount("webAddress-")`, got 0, and broke on its first iteration. The plan had
been computed from the RESULTS (2 rows), so the log promised 2 deletions and delivered none. Worse, the
loop's three exits — no rows, no Delete button, count didn't drop — were indistinguishable from outside,
so "deleted 0/2" carried no diagnosis at all. (My own instrumentation gap; the same one this session has
now fixed twice elsewhere.)

**Rebuilt on the live page + the real walk's mechanism** (operator: *"you can see how the real walk
deletes. and use the same mechanism."*):
- **`findLiveSection(rscan, name, cfg)` (lib.js, PURE)** — `cdpRepeatingScan` already DISCOVERS the
  prefixes present in the DOM (it derives them from `<base>-<N>--null`), so the prefix is never assumed:
  canonical `containerPrefix` → a prefix starting with the section NAME → the section's HEADING regex
  (the anchor `findSectionAdd` uses, and the most tenant-proof). Returns null when the section genuinely
  isn't there — a failed scan is not a licence to delete.
- **`liveDupEntries(rows, keyField)` (lib.js, PURE)** — dedupe entries built from the LIVE rows rather
  than from results, so anything Workday added behind our back is included; each carries the row's
  `deletePresent`. `keyField` is the section's identity value where it has one (website→url,
  language→language, matching their tuned semantics), else the whole row's signature; a row missing that
  field falls back to the whole-row key rather than producing an empty one.
- **`deleteRepeatingRows`** replaces the bespoke loop with the shapes the fill walk already proves:
  **clear-to-N** is `driveRepeatingSectionCdp`'s reconcile-down — delete `count - 1`, RE-POLL the count,
  repeat — which cannot be derailed by a stale index; **targeted** mirrors remediation's Tier-1.5
  index delete (highest-first). Both poll via `pollEntryCount` on the section-reconcile budgets and stop
  on no-progress, capped at 10.
- **Honesty:** every exit logs its reason (`no-rows:<prefix>` / `no-delete-button@<i>` /
  `count-did-not-drop@<i>`), and a 0-row delete returns `ran:false` — the fix never claims success it
  didn't achieve, so the walk halts visibly rather than continuing on a false premise. It also logs how
  many live rows lack a Delete control, which is the next thing to know if this recurs.

Verified: extension **750/750** (+7 pure tests covering exactly the regression — canonical prefix,
section-name fallback, heading fallback, absent-section null, live keying, missing-key-field fallback,
and real-vs-phantom on live rows). Live-verification pending: the next duplicate error should log the
resolved live prefix and a non-zero delete, or say precisely why not.

## 2026-07-27 — Page-5 replay: the silently-dropped approved field, and the missing required-blank guard

The phantom-duplicate fix worked live (pages 2–4 advanced: *"deleted 2/2 website row(s) … ✓ page 2 →
advanced"*). Page 5 then exposed three separate things. Two are fixed here; the third is a design
question answered in the response, not built.

### 1. An approved field was replayed into thin air (FIXED)

```
page 5 → matched approved page … (4 flat-field overlap; 5 approved entries).
page 5 replay: 4 field(s) — 1 changed, 1 already-correct, 0 FAILED.
  • Error-Please check one of the boxes below:The field … is required and must have a value.
```

**5 approved entries, 4 replayed.** `replayFlatFields` had `if (!present.has(fname)) continue;` — an
approved entry whose field name isn't in the live page scan was dropped **silently**: no record, no log,
and `0 FAILED`. The operator had answered "Please check one of the boxes below" and the run neither
filled it nor said it hadn't. (`checkbox_group` IS supported by `replayField`, so the widget wasn't the
problem — the entry never reached it.)

It now emits a real record: `status:"needs_review"`, `flag:"replay-field-absent"`, with the field name
AND a sample of the live field names. Two consequences: the walk's strict per-field verify HALTS on it
(instead of continuing toward a submit missing an approved answer), and the log immediately distinguishes
"the field is genuinely absent" from "its automation-id differs from the one recorded at fill time" —
which is the recon the operator asked for, delivered at the moment of failure rather than as a separate
run. The pre-existing test asserting the silent-drop contract was updated; repeating + file_upload
entries still skip silently (each has its own dedicated replay step).

### 2. "Can I blank a mandatory field and still submit?" — you could. Now you can't. (FIXED)

Checked rather than assumed, and the answer was **no guard existed**:
- the extension viewer refuses to APPROVE a required-empty field (`canApprove` in summary.js) — but that
  is UI-only, and the **website port dropped it**;
- `approvalEnvelope.submit_ready` (both copies) only ever required *all flagged approved + no AI
  placeholder*; a required-but-blank field satisfied it;
- `bundleSubmitBlockers` / `submitPrecondition` never encoded it either.

The only thing catching it was Workday's own validation — i.e. exactly the page-5 nav-timeout halt.
Now it's a first-class blocker in `bundleSubmitBlockers` (so both the website submit run's PRE-FLIGHT and
the live gate refuse, naming the offending fields), and `required_blank` joins the approval envelope in
BOTH `web/lib/review-approval.ts` and `summary-lib.js` so `submit_ready` goes false and the site's Submit
button disables. **Conservative by construction:** an unchecked checkbox stores `"false"` (not empty) so
it's never mis-flagged, `file_upload` is excluded (own re-attach + `resume-not-attached` halt), stub rows
are display-only, and preferred-name fields are `is_required:false` so a hidden one can't trip it.

### 3. Cascade-revealed REQUIRED fields (not built — see the response)

Filling an optional Name field promoted "Date" and the checkbox group to required. Those weren't in the
approved bundle, so the replay had nothing to put there and Workday refused the page. The machinery for
the answer already exists (`cascade_revealed`, the `refill` mode, the report-to-website path); the
proposal is to capture newly-required-but-unapproved fields into the bundle, push them to the review
page, and halt asking for approval — rather than halt blind.

Verified: extension **753/753** (+4), web tests 62/62, typecheck + build green.

## 2026-07-27 — Cascade-revealed required fields go back to REVIEW (and the two invisible replay outcomes)

Built after re-deriving the page-5 diagnosis, which my previous entry got partly wrong.

**The corrected reading.** From the live log — `page 5 replay: 4 field(s) — 1 changed, 1 already-correct,
0 FAILED` against `5 approved entries` — the counters (`changed`=filled, `kept`=already-correct,
`failed`=needs_review/error) leave **2 results unaccounted: status `skipped`**, and **1 entry that never
produced a result at all**. So THREE approved entries went unfilled through TWO invisible mechanisms, and
the previous entry only closed one of them:
1. `!present.has(fname) → continue` — vanished before `replayField` (closed previously).
2. `replayField`'s `cleared` branch — `value == null || value === ""` → `skipped`, counted by nothing.

Mechanism 2 is almost certainly what happened to the operator's checkbox group, and it reframes the whole
page-5 report: **the checkbox group and Date were both OPTIONAL and BLANK when the page was reviewed.**
The fill was correct — there was nothing to record. Filling the optional Name at replay time promoted
both to REQUIRED, and Workday refused a page whose approved bundle legitimately had blanks. The
"cascade" issue and the "checkbox didn't fill" issue are one root cause.

**1. Cascade-revealed required → a review question.** On a replay nav-timeout (after the phantom-dup
attempt), a fresh scan feeds **`newlyRequiredGaps(liveFields, bundleEntries, pageKey, errorTitles)`**
(lib.js, PURE): every live field that is `isRequired`, holds no value, and whose bundle entry is MISSING
**or BLANK** is a gap. Each becomes a **`cascadeEntryFor`** entry — empty, unapproved, `needs_review`,
`cascade_revealed`, with the live options attached (a checkbox group carries its labels in the DOM, so the
review page renders a real picker instead of a bare text box) and a detail explaining *why* it is suddenly
required. They're merged into the bundle (upgrading a blank entry in place rather than duplicating),
persisted, pushed via `reportApplication`, and the walk halts **`replay-needs-approval`** listing the
questions. The Run page renders them as the blocker list.

It never invents an answer: every entry is empty and unapproved, so the new required-blank rule and the
unapproved-flagged rule in `bundleSubmitBlockers` both keep refusing until a human answers. Excluded:
`file_upload` (own re-attach + `resume-not-attached` halt), and a required field the page ALREADY holds a
value for — that's a replay failure, owned by the strict per-field verify.

**2. `skipped` is no longer invisible.** The per-page line gained a `not-actuated` count, and skipped
entries are listed by name with their reason (`cleared`, `replay-deleted`, …). That single line would
have made the page-5 diagnosis immediate.

Verified: extension **759/759** (+6 pure tests: both gap shapes, page-already-has-a-value, optional-blank,
bundle-has-an-answer, file_upload carve-out, and that `cascadeEntryFor` yields an empty unapproved entry
with real checkbox options), web 62/62, typecheck + build green. Live-verification pending: re-run the
Rehearse — page 5 should now stop with "A few new questions need your answer", listing Date and the
checkbox group, with both answerable on the Tracker.

## 2026-07-27 — Two false halts from my own changes: the mid-cascade replay, and halting on success

Both surfaced immediately in live runs, and both are cases where the code stopped on a page that was
actually fine. The new state-dump logging is what made each obvious in one read.

### A. Replay halted mid-cascade (a regression from the absent-field record)

```
⚠ Workday soft-error at replay page 1 — reloading + restarting (soft-reload 1/3).   ← the new fix, working
page 1 → matched approved page … (1 flat-field overlap; 15 approved entries)
page 1 replay: 15 field(s) — 1 changed, 0 already-correct, 0 not-actuated, 14 FAILED.
    • legalName--firstName … no field named "legalName--firstName" on this page (live: country)
    …13 more
```

`live: country` — after the soft-error reload the page had rendered ONLY the Country field. Workday page 1
mounts address / region / postal / phone **after Country commits** (the documented M1 cascade). The
previous entry's `replay-field-absent` record then fired on all 14 and turned a mid-cascade page into a
hard `replay-mismatch` halt. Before that record existed these were silently skipped, so this halt was
introduced by that change.

Two fixes: **(1) cascade re-replay** — after `replayFlatFields`, re-scan (bounded, 2 rounds) and replay
whatever has since mounted, replacing the provisional absent verdicts with real ones; the fill walk has
had this cascade re-scan for a long time, the replay side simply never did. **(2) severity split** — an
absent field HALTS only when it is REQUIRED; an OPTIONAL one is `skipped` + logged (a phone extension, a
cascade that never fired, is nothing to do and must not fail a submit).

### B. Onboarding halted on the page it wanted

```
the page came back EMPTY after the sign-in submit … Reloading (1/2) and retrying   ← the new fix, working
waitFor(sign-in-form-render) timed out after 8000ms — 123 read(s) OK / 0 failed; tab VISIBLE.
    last page state: … readyState=complete · formFields=14 · hasAuthEl=false · markers=[applyFlowPage,formField]
⛔ HALT — auth-form-not-rendered
```

`formFields=14 · hasAuthEl=false` **is the application form** — `isPastAuth` by definition. The sign-in
had succeeded and the reload landed on the form; the flow halted anyway because
`waitFor(sign-in-form-render)` polls only for `passwordInput || emailInput || signInWithEmail`. The form
appeared INSIDE the 8s window, so the budget was never the problem (the operator's read — "it didn't let
the page load before giving up" — was close, but the wait wasn't looking for the right thing).

`isPastAuth(s)` is now part of that predicate, of the chooser-reveal predicate, and of a new
`post-blank-reload` wait (the blank-page recovery previously took a single early scan, which reads an
empty document a beat too soon and sends the loop hunting for sign-in fields that will never come). Each
wait is followed by `isPastAuth ⇒ continue`, so the loop top returns `reached_form`, and the
`auth-form-not-rendered` halt re-checks it before firing.

Verified: extension **760/760** (+1: absent-required halts / absent-optional doesn't). Live-verification
pending on both.

## 2026-07-27 — Audit: every wait predicate in the onboarding flow

Three bugs in one day shared one shape — *a wait polls for one specific thing and misses that the goal was
already reached, or that it can never be reached* — so all 10 `waitFor` call sites in `runCdpOnboard` were
audited against both halves.

**(1) Does it accept the GOAL STATE?** A wait for sign-in fields must also accept "we're already past
auth", because the sign-in can land mid-wait.

| wait | verdict |
|---|---|
| `sign-in-form-render` | **was missing** → fixed (halted `auth-form-not-rendered` on a page showing the form) |
| `email-sign-in-form` (chooser) | **was missing** → fixed |
| `post-blank-reload` | added with the fix; also upgraded from a single early scan to a real wait |
| `switchAuthView` view wait | **was missing** → fixed. A signed-in page can never "switch views", so it waited the full 8s and then logged "the auth widget did not switch" about a page we were past |
| `Sign In submit outcome`, `post-breach-dismiss outcome` | OK — `classifyAuthOutcome` returns `success` on form-present + no-auth-chrome |
| `post-activation sign-in page`, `post-apply`, `post-apply-manually`, `auth-or-form` | OK — each already accepts `formFieldCount > 0` |

**(2) Does it bail on a TERMINAL state?** None of them did. Every predicate waits for a page to BECOME
something; on an already-applied or maintenance page it never will, so each wait burned its full budget in
turn — an already-applied posting cost **20s (post-apply) + 45s (post-apply-manually) + 12s
(auth-or-form)** before the flow reached a state it detects instantly. Fixed once, centrally: `waitFor`
now exits early on `isAlreadyApplied` / `isWorkdayMaintenance`, logging why and returning a `terminal`
field. Callers then reach their proper clean halts immediately.

**Bonus finding (a real wrong-halt).** `doAuth`'s loop top checks `classifyAuthOutcome` and `isPastAuth`
but **never `isAlreadyApplied`** — it's checked at the initial scan, at the start of Stage 3, and after a
successful sign-in, but not inside the loop. An already-applied page reached during the loop therefore
fell through to the race-guard and halted `auth-form-not-rendered`, because its shape (no form, no auth
chrome, no credential fields) is precisely what that halt tests for. Now it returns the clean
`already-applied` result; the halt itself also re-checks before firing.

**Left alone, deliberately:** `cdpWaitNextPage` (the walk's transition detector) already checks
maintenance then session-death before anything else. It does NOT early-exit on a soft-error page — that
costs one wasted timeout, after which the caller's own `softErrorPresent` check handles it. It is the most
load-bearing wait in the system and the payoff didn't justify touching it. `settlePage` is a generic
readyState settle with nothing to add, and the injected page-engine's `waitFor(selector)` is a different,
DOM-level contract (out of scope).

Verified: extension **760/760**, web typecheck clean.

## 2026-07-27 — Cascade review polish: the date editor, and "BECAME REQUIRED" ≠ "REVEALED"

The cascade handler worked end-to-end on the first live run — page 5 replayed, hit the duplicate-free
`Error-Date The field Date is required`, captured the field, pushed it to the site
(`application reported — 200 (needs_review, 3 need review)`) and halted `replay-needs-approval`. Two
presentation defects in what the operator then saw.

**1. The date field rendered as its own plumbing.** The review card showed
`dateSectionMonth-display / dateSectionMonth-input / dateSectionDay-display / …` where the value editor
should be. `cascadeEntryFor` passed the scan's RAW segment automation-ids through as `date_order`, but
the viewer expects the form's segment ORDER — `["month","day","year"]` — to render a segmented MM/DD/YYYY
editor. The fill path has always converted via `dateOrderOf`; the new cascade path didn't. `dateOrderOf`
moved into lib.js (fill-driver keeps a one-line alias, so all its existing call sites are untouched) and
`cascadeEntryFor` now uses it, only for `date`/`year` widgets. Pinned: full M/D/Y, a month-year composite,
and a non-date field (null).

**2. "⤴ REVEALED" was the wrong words.** Operator: *"It also says revealed. instead can you make a
different flag like became required."* Correct — the two are different news. `⤴ REVEALED` describes a
field that merely appeared after another value committed; this one is a question the form is now
DEMANDING an answer to, and the operator needs to know which. New predicate **`isBecameRequired`**
(`cascade_revealed && flag === "cascade-required"`) renders **`✱ BECAME REQUIRED`** with an explanatory
tooltip, checked BEFORE the generic revealed badge so exactly one shows. Added in lockstep across all
four copies that carry `isCascadeRevealed`: `review-model.ts` (what ReviewEditor imports),
`review-approval.ts`, `summary-lib.js`, and `summary.js`'s badge row.

Both entries stay `cascade_revealed`, so `requiresApproval` and the submit gate are unchanged — this is
purely what the human is told.

Verified: extension **761/761** (+1), web 62/62, typecheck + build green.

## 2026-07-28 — New review items on top; date questions never teach

Two operator asks once the cascade-back-to-review flow was working.

**1. NEW review items sort to the TOP.** A question sent back by a submit run is the whole reason the
operator reopened the review page, but the list was in form order, so it appeared among fields that were
already approved once — the easiest place to miss it. `reviewPriority` + `orderForReview`
(`web/lib/review-model.ts`, PURE) now tier the "Needs review" list: **0** became-required (a question the
form now demands — nothing to verify, something to ANSWER) → **1** otherwise cascade-revealed → **2**
super-hard (forced / low-confidence AI on a sensitive field) → **3** must-replace → **4** everything else.
The sort is STABLE, so form order still decides inside a tier and two new items keep their relative order;
the pre-existing loudness ordering is preserved beneath the new tiers rather than replaced.
`ReviewEditor`'s three-way `flagged` filter collapses to one `orderForReview` call.

**2. A date question is never a teach card.** Operator: *"don't put any questions that are just date into
teach."* Right — a signature/acknowledgement date is per-APPLICATION, so remembering it would teach a
bucket to fill a STALE date on every future form: actively worse than not learning it.
`isDateOnlyQuestion(label, widget)` (`web/lib/teach.ts`) excludes the `date`/`year` WIDGETS — which can't
be bucket-filled at all today, so such a card is unanswerable, and this keeps it excluded if `date` is
ever added to `BUCKET_ELIGIBLE` — plus bare date asks by LABEL ("Date", "Date*", "Date:", "Today's Date",
"Date Signed On", "Signature Date", "Date Completed", …). **Narrow on purpose:** "Date of Birth",
"Graduation Date" and "Earliest date you can start" ARE reusable answers and must keep teaching, so only
questions that are JUST a date ask are dropped. Wired into `isTeachable`.

NOT touched: the extension's own `summary.js` viewer ordering — it's the fallback the operator has
confirmed is being deleted, so polish there is waste. (`isBecameRequired` was still added to it in the
previous entry, so its badge is correct.)

Verified: web tests **69/69** (+7: three ordering cases incl. stability, four date cases incl. the
must-keep-teaching ones), typecheck + build green; extension **761/761** unchanged.

## 2026-07-28 — The date editor heals its own input; the replay re-verifies before Save

**1. The date STILL rendered wrong — because the fix was on the wrong side.** Operator: *"instead of
dd/mm/yyyy it is now date/date/date/date/date/date/date"*. `DateSeg` does
`const m = DATE_META[s] || { ph: s, max: 4 }` — for any token it doesn't know it uses **the token itself
as the input's placeholder**. So whatever `date_order` holds gets printed verbatim. Fixing
`cascadeEntryFor` (yesterday) only fixed what NEW bundles contain; a review bundle is **durable**, so the
already-stored bundle kept its raw ids, and an older extension build still installed would keep producing
them.

So the fix belongs in the VIEWER: **`normalizeDateOrder`** (review-model.ts, PURE) accepts either the
clean form or the raw scan ids, matching `/(month|day|year)/` per token (so `dateSectionMonth-display`
→ `month`), deduping and dropping anything unrecognized. `DateSeg` uses it and falls back to a plain text
box when nothing usable survives — an unknown token can never again reach the UI as a placeholder. 6 raw
ids → `["month","day","year"]`; junk → a text box. Pinned with raw ids, month-year, year-only, an
already-clean order, and four junk shapes.

**2. The checkbox that unchecked itself → pre-Save re-verify.** Operator: *"the checkbox at the end first
clicked, but then something happened and it got unclicked."* Checked the evidence first: the group
replayed and **verified** (`fillCheckboxGroupCdp` re-reads the group and requires exactly one box on, and
the page reported `0 FAILED`), then Save & Continue returned "Please check one of the boxes below … is
required and must have a value". So the fill was right and the value did not STICK.

The fill walk catches exactly this with its post-settle M40 audit. The replay walk had no equivalent — it
clicked Save on a page it believed was complete. Now it takes ONE fresh scan immediately before every Save
& Continue and runs **`requiredBlankOnPage`** (lib.js, PURE) — the mirror of `newlyRequiredGaps`: fields
that are required, blank on the page, and that the approved bundle DOES have a value for (a value that
didn't stick). Only those are re-replayed, and the outcome is logged either way, so a validation error
becomes a self-healing retry with a trail. It deliberately claims nothing it can't fix: a field with no
approved answer belongs to `newlyRequiredGaps`, an unchecked checkbox stores `"false"` (never blank), and
`file_upload` has its own re-attach step — the same carve-outs as `bundleSubmitBlockers`.

Verified: extension **763/763** (+2), web **72/72** (+3), typecheck + build green. Live-verification
pending: the date should render MM/DD/YYYY on the existing bundle with no re-fill needed, and a
disappearing checkbox should now be re-filled before Save instead of failing it.

## 2026-07-28 — A "Today" button on review-page date fields

Operator: *"for date questions in the review page can you put a button next to it that fills with the
current date."* Well targeted — the one date a form asks for that the profile can never hold is TODAY (a
signature / acknowledgement date), and it is exactly the field that keeps coming back as BECAME REQUIRED,
so typing it by hand is the friction worth removing.

`todayForDateOrder(order, now?)` (`web/lib/review-model.ts`, PURE) returns one value per segment IN THE
FORM'S OWN ORDER, so a month/year composite gets only month+year and a DD/MM tenant gets its own order
rather than ours. Zero-padded to match the MM / DD placeholders. **LOCAL date, not UTC** — a click at
23:30 would otherwise sign the form with tomorrow's date. `now` is injectable, so it's tested without
freezing the clock.

`DateSeg` renders a `btn-ghost` "Today" beside the segments. The click commits the COMPUTED values
directly rather than calling `commit()`, which reads the `parts` state that the same click is setting (a
stale-state race). Value format verified end-to-end against the replay: `auditDateSegments("07/05/2026")`
→ Month/Day/Year in order, and `auditDateMatches` compares with `parseInt`, so zero-padding is irrelevant
to the read-back — the button's output replays identically to a hand-typed date.

Appears on EVERY segmented date field (including repeating-section dates), which is what was asked; it's
inert unless clicked. NOT added to the extension's `summary.js` viewer — that's the fallback being
retired.

Verified: web **75/75** (+3: per-order shaping incl. DD/MM and year-only, the local-vs-UTC boundary, and
an empty order), typecheck + build green; extension **763/763** unchanged.

## 2026-07-28 — "Today" auto-approves; an absent approved field is never fatal

**1. Pressing "Today" approves the field.** Operator: *"if today is pressed, automatically approve."* A
value edit normally RESETS approval — a changed value deserves a fresh look — so the button needed an
explicit opt-out, not a bypass of the rule. `commit(entry, val, { approve: true })` sets
`is_approved`/`approved_at` **in the same patch** as the value, so there is no intermediate state where the
row reads edited-but-unapproved and `patchEntry` recomputes the envelope once (header progress + the
Submit button update on that single click). Still gated by `canApprove` — and deliberately evaluated
against the MERGED entry, because the pre-click entry is required-and-empty (which can never be approved)
while the post-click one holds a date. The rationale for the exception: clicking "Today" IS the human
decision on a single unambiguous value; demanding a second click to confirm what you just chose is pure
friction. Nothing else uses the option, so ordinary edits still reset approval.
Pinned at the semantic level (`approvalEnvelope`): a cascade-required date blocks while blank (and is also
caught as `required_blank`), value+approval together make it `submit_ready`, and a value WITHOUT the
approval still blocks — i.e. the auto-approve is what actually does the work.

**2. An absent approved field no longer halts the replay.** Live, pages 1–3 replayed clean and page 4
stopped:

```
page 4 → matched approved page … (1 flat-field overlap; 5 approved entries)
    • gender [dropdown] … no field named "gender" on this page (live: acceptTermsAndAgreements)
    • ethnicity [dropdown] …
    • veteranStatus [dropdown] …
⚠ page 4: 3 field(s) did not replay cleanly — HALT
```

The live page SCANNED as one field (the terms checkbox); the bundle's page-4 group held the three EEO
dropdowns too.

**CORRECTION — the cause is NOT settled.** My first two readings were both wrong, and the operator said so:
I guessed "Workday stopped asking because it already holds the answers", then "they're inside a repeating
container that `cdpPageScan` filters out". The operator: *"all the values do exist on the page"* and *"this
page is not a repeating section. this page has no repeating containers."* So the fields are visibly there
and the scan reported one. Remaining candidates, none proven: the wrappers mount later than the re-scan
looked, the page renders those answers as READ-ONLY text (no `formField-*` wrapper to fill), or the
wrappers carry different automation-ids on this step. What IS established is that the scan's name list
disagreed with the page.

Halting there was wrong twice over: it fails a page that is fine, and it prevents ever reaching the check
that can actually decide. **The authority is Workday's own review page.** The entry keeps its approved
value, so `reconcileReviewPage` looks for it and `submitPrecondition` HARD-BLOCKS on `missing_on_review`
— a value genuinely lost cannot be submitted — while a required field Workday still wants blocks Save &
Continue anyway and routes to the cascade/nav-timeout path. Two backstops, neither needing a mid-walk
guess. So an absent entry is now always `status:"skipped"` + `replay-field-absent`, with its own log line
naming the fields and saying the review-page check will vouch for them.

This supersedes yesterday's required-vs-optional severity split, which was a half-measure in the same
direction.

**3. The replay asks the DOM, not the scan's list.** `present` is built from `cdpPageScan.fields`, which
filters out every field inside a repeating container — it is a convenience list for the flat driver, NOT an
inventory of the page, so it can never be the authority on whether a field exists. `replayFlatFields` now
probes `act.selExists('[data-automation-id="formField-<name>"]')` — the very selector the per-widget
handlers address — before believing anything is missing. That covers a stale scan and the repeating filter
regardless of which one bit us here.

**4. And when a field IS still absent, the walk now dumps the evidence.** One eval, only on a page that
already went wrong: the page's ACTUAL unfiltered `formField-*` id list (with a total count, `readyState`,
and body length) plus a per-missing-wrapper DOM probe. The next occurrence settles the cause from the log
instead of inviting a third guess — the same recon-at-the-moment-of-failure move that resolved the false
SSO halt and the phantom-duplicate delete earlier in the week.

Verified: extension **763/763**, web **77/77** (+2), typecheck + build green.

## 2026-07-28 — Dead service worker: two files declaring one name (and the guard for it)

```
Service worker registration failed. Status code: 15
Uncaught SyntaxError: Failed to execute 'importScripts' on 'WorkerGlobalScope':
Identifier 'dateOrderOf' has already been declared.
```

The extension was completely dead — no fill, no walk, no popup handlers — and **every one of the 765 node
tests was green.**

**Cause, entirely self-inflicted.** Moving `dateOrderOf` into lib.js (so `cascadeEntryFor` could use it),
I left a convenience alias behind in fill-driver.js — `const dateOrderOf = (segs) => apMatch.dateOrderOf(segs)`
— specifically so its seven existing call sites wouldn't need editing. But `importScripts` evaluates every
file into ONE shared global scope, unlike Node's per-module scope: `function dateOrderOf` in lib.js and
`const dateOrderOf` in fill-driver.js are two declarations of the same global. That's a SyntaxError, and a
SyntaxError while importing means the worker never registers.

Node could never catch this — `require` gives each file its own scope — which is exactly why it survived a
green suite and only appeared on loading the unpacked extension.

**Fix:** the alias is gone and all seven call sites go through `apMatch.dateOrderOf` — the indirection
fill-driver.js already uses for every other lib.js helper, and the reason the two files can coexist at all.

**Guard: `test/sw-globals.test.js`.** It derives the file list from `background.js`'s actual
`importScripts(...)` call (so it can't drift), scans for top-level declarations anchored at column 0, and
fails listing any name owned by two files, with the SW-scope rule in the message. A second test asserts
every importScripts'd file exists and parses. **Verified against the real bug:** re-appending the alias
makes it fail, removing it makes it pass — so it catches this exact class rather than merely asserting
today's state. Indented declarations (the stringified `fillEngine`'s deliberate lockstep copies of
normalize/matchCandidates) are ignored, since they live inside functions and never touch the global scope.

A standing rule went into CLAUDE.md's Working principles: never re-declare an imported name; reach it
through `apMatch.*`.

Verified: extension **767/767** (+2), and a scan of all seven SW files reports no other collision.

## 2026-07-28 — The replay walk never settled the page (and a second Node-invisible SW break)

Two failures in one run, the second one the root cause the operator had already identified.

### A. `apMatch.dateOrderOf is not a function` — the same trap, one layer down

Yesterday's collision fix routed fill-driver's seven `dateOrderOf` call sites through `apMatch`. But
`apMatch` is TWO different objects:

```js
const apMatch = (typeof module !== "undefined" && module.exports)
  ? require("./lib.js")              // Node: everything lib.js exports
  : { normalize, matchCandidates, … } // SW: only what someone remembered to list
```

`dateOrderOf` was in lib.js's exports but NOT in the SW literal — so all 767 tests passed (Node takes the
`require` branch) and the replay walk died mid-run in the browser. Same lesson as the global-scope
collision: **Node cannot see SW-only wiring.** Fixed by listing it, and guarded by two new tests — every
`apMatch.X` used in fill-driver.js must appear in the literal, and every literal key must be exported by
lib.js (so the two branches can't drift apart). Both verified to FAIL when the wiring is broken:
removing `dateOrderOf: dateOrderOf` makes the first one report exactly that name.

### B. The replay walk scanned pages MID-RENDER

The operator: *"each time we go to the next page, it doesn't poll for the page to completely settle. check
the fill path to see how that logic works. the fill path works every time."* Correct, and the new
diagnostic proved it beyond doubt:

```
page 1: 9 approved value(s) had no field to fill on this page (candidateIsPreviousWorker,
        legalName--firstName, …, postalCode, consent.f01l8)
    the page carries 6 formField wrapper(s) in total (readyState=complete, 1699 chars):
        [source, country, phoneType, countryPhoneCode, phoneNumber, extension]
    wrapper present in the DOM? addressLine1=no · city=no · legalName--firstName=no · …
✓ page 1 → advanced
page 2 → matched approved page … (14 flat-field overlap; 15 approved entries)
    the page carries 14 formField wrapper(s) in total … [source, candidateIsPreviousWorker, country,
        legalName--firstName, …, extension]
```

Six wrappers, then fourteen — **the same physical page, scanned twice.** And this is why it looked like an
advance: `cdpWaitNextPage` keys on the page SIGNATURE (url ‖ pageId ‖ **field-id set**), so eight fields
mounting changes the signature and reads as a page transition. So the replay half-filled page 1, saved,
"advanced" onto the same page, and filled it properly the second time. (It also retires the page-4 EEO
mystery from earlier: same shape — a scan taken before the fields existed. My two guesses, "Workday
stopped asking" and "repeating containers", were both wrong; the operator's "all the values do exist on
the page" was right, and this is why.)

The fill walk has had the answer since 2026-07-25 — a WALL-CLOCK field-set settle — but it lived inside
`fillAndPersistPage`, which the replay walk never calls. Extracted verbatim as
**`awaitFieldSetSettled(act)`** and called by BOTH walks before the page scan: break only once a NON-ZERO
field count has held UNCHANGED for ≥1.2s of real time, polled at 150ms on **`delayFull`** (never
`delayRender` — adaptive, collapses to ~40ms on a visible tab, which would make a half-rendered page look
stable and defeat the whole point), 12s ceiling, ~1s all-zero bail so a repeating-only page like My
Experience doesn't wait. The replay logs the settle time and resulting field count per page.

Verified: extension **769/769** (+2 apMatch guards), `node --check` clean on the changed files. RELOAD THE
EXTENSION before the next run.

## 2026-07-28 — Submit gate relaxed: only a CONTRADICTED value blocks, not a missing one

First fully clean replay to the review page — and the gate still refused:

```
✓✓ reached the REVIEW page after replaying 5 page(s)
review page vs approved: AGREE 53 · DISAGREE 0 · MISSING 1 · EXTRA 1 · AMBIGUOUS 0 (of 54)
    ∅ approved "English" ("Language*") is NOT shown on the review page
submit gate: 1 blocker(s) — NOT submitting:
    ✗ 1 approved value(s) not shown on the review page
```

Operator: *"the language controls what language is shown on the page so does not matter for the review
page. Maybe make it so it just checks if anything is filled wrong. if things are missing it is fine."*

Right, and the distinction is epistemic. **DISAGREE is positive evidence** — the review page displays a
value that CONTRADICTS what was approved, which is exactly the value-revert class this check was built to
catch. **MISSING is absence of evidence**, and it conflates two very different things: a value that didn't
stick, and a field Workday's summary simply never renders. `Language*` is the second kind — it selects the
page's display language, so it has no business appearing in an application summary. On top of that, the
matcher is heuristic by design (CLAUDE.md: VALUE-PRESENCE, not label-match; short values fall back to
label-anchoring), so failing to LOCATE a value is not proof it was lost.

So `submitPrecondition` no longer blocks on `reviewMissing`. It is still surfaced in the log, now with a
line saying it is informational and why. DISAGREE still blocks. EXTRA was already non-blocking. A scrape
FAILURE still blocks — without a successful read, DISAGREE can't be evaluated either, so "can't confirm"
must not read as "confirmed fine".

**The one exception, deliberately kept fatal.** The phantom-duplicate fix DELETES visible rows on the
premise that Workday retained its own copy — and its verification was `reviewMissing` blocking. Dropping
that blocker outright would have silently gutted it: a deleted website whose value never came back would
sail through. So the walk now collects those specific values (`phantomLost`, the intersection of what we
deleted with what the review page lacks) and passes them as their OWN blocker, naming the values. For
anything we deleted ourselves, absence IS positive evidence. The log line that already said "The gate
blocks below" is now telling the truth again.

Verified: extension **772/772** (+3: missing-alone doesn't block, DISAGREE still does, phantom-lost still
does, scrape-failure still does). Note this is a genuine relaxation of the submit gate — the remaining
guards are DISAGREE, scrape-failure, phantom-lost, every flagged field approved, no unreplaced AI
placeholder, no required field blank, on-review-page, session alive, and single-fire.

## 2026-07-28 — A Rehearse run wiped the tracker row's company + role

Operator: *"when I fill out the form, it accurately shows in the review page company/role. when I do the
new rehearse run, it goes back to the tracker without the company/role, just the website."*

**Cause.** `reportApplication` (background.js) sends **`role: null` on every report** — the extension has
no idea what the job title is — and `company: (jobContext?.company) || bundle.tenant || null`, which is
null when the run has no jobContext. `POST /api/extension/report` wrote those nulls straight into its
UPDATE, erasing what the fill had recorded. The FILL path only ever survived this **by accident**:
`saveRunJob` runs afterwards and rewrites company/role from the scraped JD. A submit run has no such
follow-up, so the damage stuck. The trigger on a Rehearse is the cascade path added earlier this week,
which reports the bundle when it sends newly-required fields back to review.

**Fix — the rule, not the symptom: a report never NULLS a column it wasn't given.** Extracted to
`web/lib/report-fields.ts` (PURE, so it's testable without a route or a DB): `reportColumns(body, userId)`
OMITS `company` / `role` / `url` / `job_key` / `applied_at` when the payload doesn't carry them, rather
than writing null. Safe for an INSERT too (an omitted column takes its default). The report's OWN payload —
status, needs_review_count, review_bundle_json — is always written, since that IS the report. This
generalizes the rule the login columns already followed ("an absent login must not blank the account on
file"): absence means *"I have nothing to say about this"*, never *"set it to nothing"*.

**Second fix, a wrong-value hazard rather than a null one.** The cascade report passed
`chrome.storage.local.jobContext`. Checked what that slot actually holds, and it is worse than "the last
run's company": **nothing in background.js writes it back** — a Run builds its own local `jobContext` from
the JD scrape and threads it down without persisting — so storage only ever holds what the WEBSITE synced
from `profiles.job_context_json`. That is a per-USER value (its editor page was retired; it survives as a
Cover-letter default), with no relationship to the job being submitted. Writing it onto the row would
stamp an unrelated company on the application, and **a plausible WRONG value is worse than a blank one**: a
gap is visible and the next fill repairs it, whereas a wrong company reads as fact — and `company` is not
inert, it anchors the employment-status recognizer's "are you a former «company» employee?" decisions. Now
passes `null`, so `company` falls back to `bundle.tenant`, captured from THIS application's own fill.
LATENT, not observed: it needs the cascade path to fire on a submit run while the synced job context names
a different company, which this session's same-job runs never did.

Verified: web **85/85** (+8 pinning the no-clobber rule: absent company/role omitted, whitespace treated
as absent, carried values written, the report's own payload always written, status validation, and the
login carve-outs), extension **772/772**, typecheck green. NOTE the production build failed ONCE with
`Failed to collect page data for /_not-found` and passed on two clean re-runs — recorded as flaky, not
diagnosed.

## 2026-07-28 — Background submit runs: synthetic input for the replay, trusted for the one click

Operator: *"it should be able to submit in the background too. for now I have been testing in the
foreground and it works now. Time to test them in the background."*

Foreground already worked because a visible tab uses trusted `Input.*` and acks in milliseconds. HIDDEN was
the problem: trusted input to a hidden tab stalls ~1.2–1.5s **per event** (input processing rides
compositor-frame scheduling, and a hidden tab produces no frames), and the replay walk had synthetic input
switched OFF.

**Why it was off, and why that reason no longer applies.** The comment said the submit-adjacent path keeps
trusted primitives "until the fill walk's synthetic mode is live-verified" — a condition the background
fills have since met. More importantly the original objection was never about form pages: synthetic failed
on the **AUTH** form, whose Sign In submit never fired because the auth app doesn't register native-setter
values. That surface isn't in the replay walk at all — `runCdpOnboard` signs in on its OWN attach, and
`cdpAttach` resets the flag, so `cdpSetSyntheticInput(true)` inside `runCdpReplayWalk` covers ONLY
application FORM pages: exactly where the synthetic repertoire is proven.

**Why it's safe.** Nothing about verification changes. Synthetic engages only when the tab is HIDDEN
(`cdpSynthInput`), every read-back / persistence re-read / M40 audit is untouched, and the replay stacks
strict per-field verify + review-page equality + `submitPrecondition` on top. A synthetic no-op therefore
surfaces as `needs_review` and HALTS the walk — it cannot become a wrong value.
`chrome.storage.local.forceTrustedInput` still overrides everything.

**The one exception, deliberately slow: `act.clickSubmit` is forced back to TRUSTED even when hidden**
(`cdpSetSyntheticInput(false)` immediately before it). It is the single action in the whole system that
cannot be undone, so it uses the most proven mechanism rather than the fastest one — ~1.5s for one click,
against never having to wonder whether a synthetic click half-fired.

**UI.** `/app/run`'s submit card gains a "Run in the background (unfocused tab)" checkbox, defaulted OFF,
covering both Rehearse and Submit. Ticking it shows a plain warning that a background run can't be watched
— fine for a rehearsal, but for a real submit you won't see the final click. The replay's opening banner
now prints the tab's input mode (`VISIBLE (trusted)` / `HIDDEN (synthetic for fields; submit click stays
trusted)`) so a slow run self-diagnoses, and it no longer tells the operator to "keep the tab VISIBLE"
when they deliberately chose otherwise.

Verified: extension **772/772**, web **85/85**, typecheck + build green. Live-verification pending — try
Rehearse with the box ticked first; the banner should report HIDDEN/synthetic and it should finish in
roughly foreground time.

## 2026-07-28 — Three FALSE disagrees blocked a clean run: rows shuffled within a repeating entry

```
review page vs approved: AGREE 26 · DISAGREE 3 · MISSING 24 · EXTRA 1 · AMBIGUOUS 1 (of 54)
    ≠ "Location": approved "Pittsburgh, PA" but the page shows "Yes"
    ≠ "From*":    approved "9/2024"         but the page shows "No"
    ≠ "Company*": approved "CISCOR"         but the page shows "No"
submit gate: 1 blocker(s) — ✗ 3 review-page value(s) DISAGREE with the approved bundle
```

The operator pasted the whole review page, and it settles it: **"Pittsburgh, PA" is on the page**, in
Work Experience 1, immediately above `I currently work here → Yes`. So the paired value ("Yes") belongs to
the NEXT ROW. Same for `Company` → "No" and `From` → "No". These are not contradictions; the row→value
pairing shuffled inside the entry. (Repeating entries reuse identical labels, which is exactly what makes
that pairing fragile.) The operator's hypothesis was a render delay — but a half-rendered page yields
MISSING, not a neighbour's value, so the mechanism is pairing, not timing.

That matters more than it looks: after this week's relaxation, DISAGREE is the LAST value check that blocks
a submit, so a false one refuses an otherwise-perfect run — which is precisely what happened.

**Fix — `verdictFor` in `reconcileReviewPage`.** Before calling a keyed mismatch a contradiction, ask
whether the approved value is the value of ANOTHER ROW OF THE SAME ENTRY (same `fkitPrefix` +
`entryOrdinal`). If it is, the entry's rows are shuffled → **AMBIGUOUS** (`mispaired-within-entry`, logged,
never blocking). If it isn't, it stays a DISAGREE and still blocks.

**Deliberately NARROW, and the narrowing is the interesting part.** The obvious version — "if the approved
value appears anywhere on the page, don't disagree" — was written first and **broke an existing test that
encodes the opposite principle**: an authoritative keyed match must beat coincidental presence, because
approved "LinkedIn" vs a page `source` reading "Indeed" is a REAL disagree even though another field's
prose happens to say "my LinkedIn profile". Restricting the guard to *within one repeating entry* satisfies
both: the shuffle signature is caught, coincidental presence is not, and FLAT fields keep the strict path
untouched.

Verified: extension **774/774** (+2 — the live shuffle downgrades to ambiguous; a value the page nowhere
contains still disagrees — alongside the pre-existing keyed-disagree test, which passes unchanged).

NOTE (written before learning the run was HIDDEN, and **superseded by the next entry**): I flagged the 24
MISSING as a separate scraper defect — "matching only ~26 of 54 … worth its own round". It is not a separate
defect. The half-rendered page accounts for it: FOREGROUND runs of this same job match **53 of 54**, and the
single miss (`Language*` = "English") is legitimate — the summary renders "Languages: No Response" and never
shows that value. So the scraper is sound on a settled page; the fix it needed was the settle, not a
rewrite. Leaving the original text visible above rather than deleting it, because over-flagging on partial
evidence is the mistake worth remembering.

## 2026-07-28 — The review-page scrape had no settle either (root cause of the false disagrees)

Follow-up to the entry above, with the context that changes its diagnosis. Operator: *"I have ran this
multiple times and it has worked before. for more context this run was hidden."*

Same job, same bundle:

| run | result |
|---|---|
| FOREGROUND (several) | AGREE 53 · DISAGREE 0 · MISSING 1 |
| HIDDEN (first) | AGREE 26 · DISAGREE 3 · MISSING 24 |

So the previous entry treated a SYMPTOM. The row-shuffle and the 24 phantom "missing" values weren't
inherent fragility in the pairing — they are what a **half-rendered** summary looks like. A hidden tab
renders slower, the scrape ran the instant the walk arrived, and a label whose own value span hadn't
mounted yet picks up the next row's value. The operator's copy of the page shows every one of those values
present and correct.

**`awaitReviewPageSettled(act, hints)`** now polls `cdpReadReviewPage` until a NON-ZERO record count holds
UNCHANGED for ≥1.2s — wall-clock via `delayFull`, never `delayRender` (adaptive, ~40ms on a visible tab,
which would pronounce a half-drawn page "stable": the exact trap this exists to avoid) — with a 15s
ceiling. It RETURNS the settled snapshot, so the verdict is computed on precisely the state it settled on
rather than a fresh read that might differ, and it costs one round-trip less. Wired into the replay walk
and the standalone `RUN_CDP_REVIEW_CHECK` (no `act` there → falls back to `cdpDelay`).

**This is the third instance of one lesson**, all found live this week: never scan a Workday page without
settling it first. The JD page (`jobPageSettleStep`), form pages (`awaitFieldSetSettled`, whose absence in
the replay walk made it process the same page twice), and now the review page. Each looked like a different
bug — a truncated job description, phantom absent fields, contradicted values — and each was the same
mistake.

The mis-pairing guard from the previous commit STAYS: it is still correct that a row shuffled within an
entry shouldn't hard-block a submit, and it is now defence-in-depth rather than the primary fix.

Verified: extension **774/774** (unchanged — the settle is I/O, and like `awaitFieldSetSettled` it carries
no direct unit test; the pure verdict logic it feeds is covered). Live-verification pending: re-run the
HIDDEN rehearse; the log should print `review page settled in Nms — 5x displayed value(s)` and the counts
should match the foreground runs.

---

## 2026-07-28 — Workday's already-applied LIE, the landing classifier, and the hidden-tab résumé race

Three operator-reported bugs from one background submit run. They look unrelated but share the theme the
last several entries keep circling: **the extension believed a page instead of checking it.**

### A. "You've already applied" is sometimes false — verify it against My Applications

Operator: *"sometimes it says you have applied to this application when you have not. so when on that
screen, press view my applications … here it will say for real submitted or not submitted."*

`isAlreadyApplied` has been a CLEAN TERMINAL halt since 2026-07-24 — the flow stops, reports
`already-applied`, and the website tracker records it. That is right when it's true. But Workday shows the
same page for an application that was **STARTED and never SUBMITTED**, and there the halt threw away a
perfectly fillable application; worse, it looked like a successful, correct outcome, so nothing flagged it.

`handleAlreadyApplied` (background.js, inside `runCdpOnboard`) now does what the operator does by hand:

```
already-applied page
  → "View My Applications"          (text-anchored click through the proven clickTarget path)
  → expand collapsed sections       (loops until the ROW COUNT settles — the dropdown is often closed)
  → find THIS job                   (req id → exact title → single-hit containment; ambiguity REFUSES)
  → read Submitted / Not Submitted
      submitted     → the original halt stands, now WITH EVIDENCE
      not-submitted → click the row → job-description page → "Continue Application" → page 1
      no status     → open it; a "Continue Application" affordance is positive proof it's still open
```

The decisions are PURE and unit-pinned in lib.js (`isMyApplicationsPage`, `applicationStatusOf`,
`pickApplicationRow`, `reqIdFromUrl`); the reads are `cdpReadApplicationsPage` / `cdpReadJobIdentity`.

Three things carry the safety:

- **`applicationStatusOf` tests the NEGATIVE first.** `"Not Submitted"` CONTAINS `"Submitted"`, so a
  positive-first test labels every unsubmitted draft as submitted — i.e. it would abandon exactly the
  applications this feature exists to rescue. Regression-pinned with that string verbatim.
- **`pickApplicationRow` refuses ambiguity.** Opening the wrong row would FILL SOMEONE ELSE'S
  APPLICATION, so the ladder is req-id (from the row's href/text — titles truncate in the list, req ids
  don't) → exact normalized title → containment committed ONLY on a single hit. Two matches ⇒ halt with
  the reason, never a coin flip. Same philosophy as the fill's match ladder.
- **The requisition is re-PROVEN on the job-description page** before "Continue Application" is clicked
  (operator: *"make sure it is the correct application"*).

Clicks reuse the existing `clickTarget` (re-measured cover-check, consent-safe auto-dismiss) via
`cdpTagClickableByText` / `cdpTagRowByHref`, which stamp `data-ap-click` on a text-matched control. Text
anchoring is unavoidable: no automation-id for this page is confirmed on any tenant, so instead of
guessing one, `cdpReadApplicationsPage` enumerates the page STRUCTURALLY (every job-ish link, its
enclosing row, that row's text) and every failure path PRINTS what it saw — headings, row titles,
statuses, hrefs. The first live run therefore either works or self-reports the exact DOM to tighten it,
with no separate recon round.

Bounded at 2 per run (one attempt can legitimately be consumed by the list demanding a sign-in first, which
hands back to the auth stage). It only ever REACHES a form — it never fills, advances, or submits.

### B. `classifyWorkdayPage` — detect the landing, never assume it

Operator: *"when you click a button, always add a fallback, don't assume you will go to an expected page,
each redirect detect which page you are on."*

Every caller tested only for the ONE thing it wanted — auth fields, a form, the review marker — so ANY
other landing read as "the thing I wanted didn't render" and produced a halt naming the wrong cause. That
is the same shape as the false `sso` halt (2026-07-27), the false `auth-form-not-rendered` on its own
success, and `replay-page-not-in-bundle` blaming a good bundle for a Workday soft error.

One pure classifier: `maintenance | soft-error | already-applied | my-applications | review | form | auth
| job-description | blank | unknown`. Two ordering rules are load-bearing and pinned:

- transient/terminal states **outrank page shape** — a soft-error or already-applied page can carry
  leftover chrome, and acting on the shape means acting on a page that is about to be replaced;
- `form` requires fields **AND** no auth chrome, the same rule as `isPastAuth`, so a half-rendered auth
  widget over a form can't be mistaken for having arrived.

Used at every hop of the recovery above, and at the replay walk's empty-page halt — which previously
reloaded three times and blamed the bundle. It now names the page: an already-applied / my-applications /
maintenance landing halts immediately (`replay-landed-<kind>`) because reloading those changes nothing.

### C. The hidden-tab résumé upload race

```
[CDP-REPLAY-WALK] resume: NOT attached — resume attach failed — file-upload-item appeared but
                  file-upload-successful did not within 10s — upload may be in progress or failed
[CDP-REPLAY-WALK] ⚠ resume NOT attached on page 3 … HALT.
```

Operator: *"on a hidden run I got this error. ran it some more times and this error disappeared. it is
probably some type of race."* Correct, and the message even said so — *"may be in progress"*.

`attachResume`'s confirmation gate is a **page-side** poll on a flat 10s ceiling tuned on a VISIBLE tab. A
hidden tab slows the XHR, throttles the React render that paints `file-upload-successful`, and (when the
page's CSP blocks the blob worker-timer override) drops page timers to ~1Hz. The upload was fine; the
watcher gave up. dom-patterns 2026-06-21 had actually predicted this — *"SW-pace only if a hidden walk
ever misses it"*.

`cdpAttachResumeConfirmed` is now the ONE attach path for both walks:

1. the page-side ceiling is a PARAMETER, scaled by `cdpVisible()` — VISIBLE keeps the live-verified 10s,
   HIDDEN gets 25s (same `renderBudget` reasoning as the auth waits);
2. an upload that **started but hasn't confirmed** is re-polled **from the service worker on wall-clock**
   for 20s more, waking the page each tick — the standing rule that no wait may depend on a page timer;
3. an explicit Workday error row, or an upload that never started, SKIPS the re-poll — those are not
   races, and waiting would only delay an honest failure.

`attachResume` now also reports `sawItem` and `errorText` so the SW can tell those apart at all, and the
success detail says how long the re-poll took, so a tenant that consistently needs it is visible in the log.

Also fixed from the same run: the replay walk's not-actuated line printed a literal `undefined`
(`page 2: 3 approved entries were NOT actuated: language, skills (cleared), undefined`) — repeating-section
records key the field name differently, so the bare `r.field` missed the `|| r.fieldName` fallback the rest
of the file uses. The whole value of that line is NAMING what was left blank.

Verified: extension **785/785** (`node --test`; +20 new — the status substring trap, the row-pick ambiguity
refusals, req-id extraction, the classifier's two ordering rules). SW global-scope + `apMatch` guards green,
so the worker still registers. **Live-verification pending on all three:** the already-applied recovery has
never run against a real My Applications page — its DOM is unconfirmed, which is why every step
self-reports. Run it on a tenant that shows the false already-applied page and paste the
`[ApplyPilot][ONBOARD]` block; the row dump will show whether the generic reader found the list.

---

## 2026-07-28 (later) — Workday's PHANTOM "required" error: blur is what commits a field

Fourth bug from the same background submit run, and the most interesting one because the fill was
*perfect*:

```
page 5 replay: 5 field(s) — 3 changed, 1 already-correct, 1 not-actuated, 0 FAILED.
page 5 Save & Continue: {"clicked":true}
  re-click fallback: error text present — NOT re-clicking (a real validation block, not a swallowed click).
page errors (2):
    • Error-NameThe field Name is required and must have a value.
    • Error-DateThe field Date is required and must have a value.
⚠ page 5 did NOT advance (nav-timeout, real error present) — a required field is empty. HALT
```

Operator: *"The fields are physically filled correctly … manually I just click into the field text box,
and then press next and the error goes away."* — and *"not sure why this happens on hidden runs."*

That workaround is the whole diagnosis. **Workday validates a field on BLUR.** Real typing ends with the
user moving away, which fires blur/focusout. `cdpSynthSetValue` fires keydown → input → change → keyup and
**nothing else**, and the only thing that blurs a synthetic-filled field is the NEXT synthetic click
calling `el.focus()` (cdp.js:564), whose side effect is the previous element's blur. So:

- the **last field filled on a page is still focused** when Save & Continue is clicked, and its blur — hence
  Workday's validation commit — races the submit **in the same tick**;
- the value is genuinely in the DOM (which is why the M40 audit, the read-backs and `0 FAILED` all agree),
  but Workday's form model was never told the edit finished.

"Why hidden runs" answers itself: synthetic input only engages when the tab is hidden. Visible runs use
trusted `Input.*` and never had this. Page 5 is also the worst case for it — the disability self-ID page,
whose last field is a DATE composite of spinbutton segments.

### The fix — two deterministic halves, no AI

**Preventive.** `clickPageNext` is the ONE method both walks advance through, so `cdpCommitPendingEdits`
goes there: blur whatever editable is focused, then settle a beat, before every Save & Continue. It uses
the real `.blur()` so the browser sequences genuine focus events.

**Curative.** On a nav-timeout with errors, `nudgePhantomRequired` reproduces the manual fix —
focus → change → blur every value-bearing input inside each error-named field (`cdpNudgeFieldCommit`; a
date composite walks its month/day/year spinbuttons exactly as tabbing would) — then re-saves ONCE.
Bounded at 2 per run, on the same reasoning as `clearPhantomDuplicates`: if a focus/blur commit doesn't
clear it, it isn't the blur race. Wired as a replay-walk tier (which previously had no remediation at all
and halted hard) and as fill-walk **Tier 0.5**, placed before Tier 1 deliberately — Tier 1 would re-FILL an
already-correct field to fix this, re-actuating a verified value for no reason.

Neither half touches a VALUE. They only tell the page that an edit already made has finished.

### The safety gate is the pure part

`phantomRequiredTargets` (lib.js) decides whether this is the phantom at all, and it is strict in one
direction on purpose: **a false positive re-saves a page that really is incomplete, burying a real gap
under a retry.** So it fires only when

- every error-named title maps to a field ON the page — an unmatched title means we don't understand this
  error (it could name a field inside a repeating section the flat scan filters out), and
- every one of those fields HOLDS a value — one genuinely empty field vetoes the whole thing.

Anything else returns `phantom:false` with a reason, and the walk halts exactly as it did before. Both
refusals are pinned, along with the live page-5 shape verbatim, `"Select One"` not counting as a value,
an unchecked checkbox not counting, and the `Name*` asterisk not breaking the label match (that last one
would have silently disabled the fix on every required field — i.e. on every field it exists for).

Verified: extension **793/793** (`node --test`; +8). SW global-scope + `apMatch` guards green.
**Live-verification pending:** re-run the HIDDEN replay on solarturbines page 5. Expect either no error at
all (the preventive blur did it) or `phantom-required: … Committing … and re-saving` followed by
`✓ page 5 → advanced after committing name, dateSignedOn`. If it instead logs
`(phantom-required check: not applicable — …)`, the reason string says which gate refused.

---

## 2026-07-28 (round 2) — the phantom "required" error is NOT the blur race; instrument, don't guess again

The blur-commit fix from the previous entry shipped and **did not work** — operator: *"that fix did not
work. same thing happened."* Same page (solarturbines page 5, HIDDEN replay), same two errors, same halt.

So the mechanism is unconfirmed. The blur race was a plausible inference from the operator's manual
workaround, and it is still true that synthetic mode never blurs a field — but it is evidently not what
is producing this error. **A third guess is not worth making**, and this is exactly the situation
CLAUDE.md's first working principle covers: trace the real thing before writing the handler.

### What we can rule in/out from the failing log

The pre-save re-verify (`requiredBlankOnPage`, added earlier the same day) prints a line whenever an
approved value has gone blank before Save. **That line is absent**, so the fields were not blank at
pre-save time — which argues against the "watched it uncheck itself" revert class, at least as measured
by a DOM read.

That leaves several live hypotheses that a DOM read cannot distinguish, because every check we own
(read-backs, the M40 audit, `cdpPageScan`) reads *the DOM*:

| # | hypothesis | signature |
|---|---|---|
| H1 | Workday's model disagrees with its own DOM | domValue set, react set |
| H2 | the value reverted after we verified it | domValue EMPTY |
| H3 | React's internal state never took the value (its next render wipes it) | domValue set, react EMPTY |
| H4 | the error is STALE and the Save click was swallowed | no error node inside the wrapper |
| H5 | the DATE composite behaves differently (spinbuttons) | value vs aria-valuenow disagree |

### The instrument

`cdpDiagnoseFieldCommit` (cdp.js) + `diagnoseRequiredErrorFields` (background.js) dump `[FIELD-DIAG]` on
EVERY required-error nav-timeout, in **both** walks, **read-only**, and **before any remediation tier
touches the page** so the log shows the failure as it actually was. Per input it prints:

- `domValue`, `defaultValue`
- **React's own `__reactProps$*.value` and the fiber's `memoizedProps.value`** ← the load-bearing part
- `aria-valuenow` (where a date spinbutton's real value lives), `aria-invalid`, `aria-required`
- `checked`, `disabled`, whether it is `document.activeElement`
- whether each error node is rendered INSIDE that field's wrapper, plus every error node on the page

DOM-vs-React divergence is precisely what a native-setter write that never notified React looks like, and
it is invisible to everything we already log. The dump ships with its own legend mapping each combination
back to the table above, so the next occurrence is self-interpreting rather than another round trip.

### The one remedy worth adding blind

Alongside the instrument, a **mechanism-agnostic** remedy: force-re-actuate every error-named field with
**`skipIfCorrect: false`** — a real clear+type even where the box already looks correct — then re-save.
Bounded 2/run, deterministic, approved values only, per-field verify unchanged, so the worst case is that
it changes nothing and we halt exactly as before.

It is worth adding *without* knowing the mechanism because it covers three of the hypotheses at once:
a value that reverted (H2), a value React never took (H3), and — new, and a strong candidate — a field
**Workday PRE-FILLED** that our skip-if-correct deliberately left untouched, so Workday's model never saw
it completed. The failing log contains `1 already-correct`, i.e. exactly one field on that page was
verified as matching and never actuated.

And it is *diagnostic in its own right*: if a run advances at `✓ page 5 → advanced after force-re-filling
…`, that IS the answer — the value had to be re-WRITTEN, not merely committed — and it points straight at
H2/H3/pre-fill rather than at Workday's model.

Verified: extension **793/793** (`node --test`, unchanged — the diagnostic is pure I/O and the remedy
reuses the already-pinned `replayFlatFields`; `phantomRequiredTargets`' gates stay pinned). SW
global-scope + `apMatch` guards green. **Status: OPEN.** The next hidden run on page 5 should be read for
(a) the `[FIELD-DIAG]` block, and (b) whether the forced re-fill advances the page.

---

## 2026-07-28 (round 3) — the phantom "required" error, narrowed to Workday's own form model

The `[FIELD-DIAG]` instrument from round 2 paid for itself on the first run. Operator also confirmed by
eye: *"on the page everything is filled correctly."*

### What the dump proved

```
[FIELD-DIAG] the page's 5 flat field(s): disabilityForm="English"* · name="Kevin Wang"* · employeeId=""
                                        · dateSignedOn="07/28/2026"* · disabilityStatus="No, I do not…"*
[FIELD-DIAG] [data-automation-id="formField-name"]
    ↳ INPUT type=text domValue="Kevin Wang" reactProps="(none)" reactFiber="(none)" ariaInvalid="true"
    wrapper text: "Name*Error: The field Name is required and must have a value."
[FIELD-DIAG] [data-automation-id="formField-dateSignedOn"]
    ↳ dateSectionMonth-input domValue="7"    reactProps="7"    reactFiber="7"    ariaValueNow="7"
    ↳ dateSectionDay-input   domValue="28"   reactProps="28"   reactFiber="28"   ariaValueNow="28"
    ↳ dateSectionYear-input  domValue="2026" reactProps="2026" reactFiber="2026" ariaValueNow="2026" ←FOCUSED
    wrapper text: "Date*current value is 7/28/2026 … Error: The field Date is required and must have a value."
```

Every required field on the page holds its value. React's own state holds the date. **Workday's own widget
renders "current value is 7/28/2026" — it is describing the value while its validator calls the field
empty.** The fields carry `aria-invalid="true"` and an **inline, per-field** error, so this is that field's
own validation, not a leftover banner.

⇒ **The value is present in every layer we can read, and missing only from Workday's own form model** — the
layer above React that we cannot inspect.

### Ruled out, each by live evidence rather than argument

| hypothesis | how it died |
|---|---|
| the blur race (round 1) | real focus + change + blur on all 4 inputs, then Save — still blocked, **twice** |
| the value reverted after verify | the pre-save `requiredBlankOnPage` re-verify never fires (nothing goes blank) |
| React never took the value | the date's `reactProps`/`reactFiber` hold `7`/`28`/`2026` |
| stale error / swallowed Save click | the errors are inline **inside each field's wrapper**, not banner-only |

(`name`'s `reactProps="(none)"` is not evidence of H3 — that input simply exposes no React `value` prop,
i.e. it is uncontrolled. The date segments prove the reader works.)

### Round 2's own bug — a silent no-op that cost a live run

The "forced" re-fill logged:

```
• name: filled → "Kevin Wang" — already correct on the page — left unchanged (no actuation)
```

`replayField` had its **own** skip-if-correct block that never consulted `budgets.skipIfCorrect`, so
passing `skipIfCorrect:false` did nothing. Now gated on `b.skipIfCorrect !== false` — `undefined` still
skips, so every existing caller is byte-identical — and **pinned in both directions**, because this is
exactly the kind of wiring bug that passes review and burns a whole live run.

### Round 3: force a TRUSTED re-write, and let it be decisive

The remaining suspect has precedent **in this codebase, for this exact symptom**. From
`cdpSetSyntheticInput`, about the auth form: *"the auth app likely doesn't register native-setter values in
its own state, leaving the submit inert."* Synthetic input writes via the native setter; React's input
state updates (we can see it), but an app tracking its own model off real input/key events never hears
about it. And the operator's own framing lines up: **this only happens on hidden runs, and hidden runs are
the only ones that use synthetic input** — a VISIBLE run of this page has never shown it.

So the retry now does what a visible run does: `cdpSetSyntheticInput(false)` (restored afterwards, so the
rest of the walk keeps its hidden-tab speed) + `skipIfCorrect:false` → a real trusted click-focus,
select-all, re-type, read-back — then re-save. Bounded 2/run, approved values only, per-field verify
unchanged.

This is a candidate fix AND the experiment: **if the page advances at `✓ … after re-writing … with TRUSTED
input`, the mechanism is confirmed**, and the proper fix becomes "use trusted input for these field types
(or this page)" instead of paying for a retry. The log states that conclusion inline so the next run
doesn't need interpreting.

Ordering also changed: the round-1 blur nudge is **demoted to run after** the trusted re-write. It has
failed live twice and every failed Save costs a full nav-timeout, so there is no longer a reason to spend
one on it first. And the diagnostic's own H4 test was fixed — it reported "errors inside this wrapper:
NONE" while the wrapper text plainly showed the inline error, because Workday's inline error element
carries neither an error-ish automation-id nor `role="alert"`; it now falls back to the wrapper TEXT, so
only "no node AND no text" reads as page-level/possibly-stale.

Verified: extension **795/795** (`node --test`; +2 pinning the skip gate). SW global-scope + `apMatch`
guards green. **Status: still OPEN**, now with three hypotheses eliminated by evidence and one testable
candidate armed. Read the next hidden page-5 run for the `✓ … with TRUSTED input` line.

### Round 4 — SOLVED, live: the trusted re-write advanced the page

```
page 5: FORCE-re-filling 2 error-named field(s) [name, dateSignedOn] with skip-if-correct OFF
        and TRUSTED input (tab HIDDEN; synthetic was ON)
    - name:          filled -> "Kevin Wang" - overwrote "Kevin Wang"
    - dateSignedOn:  filled -> "7/29/2026"  - segments {Month, Day, Year: typeChars}
page 5 Save & Continue (after the forced re-fill): {"clicked":true}
+ page 5 -> advanced after re-writing name, dateSignedOn with TRUSTED input.
++ reached the REVIEW page after replaying 5 page(s)
review page vs approved: AGREE 53 . DISAGREE 0 . MISSING 1 . EXTRA 1 . AMBIGUOUS 0
SUBMIT GATE PASSED - WOULD CLICK SUBMIT NOW (SIMULATE MODE)
```

**Mechanism confirmed.** The synthetic (native-setter) write updates the DOM and React's input state but
never reaches Workday's own form model. Re-writing the same two values with TRUSTED input cleared both
errors at once, the page advanced, and the run went the rest of the way to a passing submit gate.

Note what the re-write log proves: `name: overwrote "Kevin Wang"` — the same value it already held. Nothing
about the VALUE was wrong. Only the *way it was written* was invisible to Workday.

**Both halves of the fix are load-bearing:**

- **trusted input** — the native-setter write is exactly what Workday misses;
- **`skipIfCorrect: false`** — the box already reads correct, so the default minimal-diff replay skips it.
  That skip is what made the first attempt at this remedy a silent no-op, because `replayField` had its
  OWN skip-if-correct that ignored `budgets.skipIfCorrect`. Now gated (`undefined` still skips, so every
  existing caller is unchanged) and pinned in both directions.

**An operator observation, and why the tier built on it was reverted.** By hand, a bare second Save cleared
the Date error, then a click into the Name box + Save cleared the rest — *"and it magically works"*, with
nothing re-typed. That is consistent with the same root cause (both give Workday a real interaction, which
re-validates). A `resubmitStalePhantomRequired` tier was built to automate that sequence, then **reverted**
once the trusted re-write proved out live: re-submitting without re-writing is the weaker remedy, and
`reclickNextWhenClean`'s refusal to re-click while error text is present is a guard worth keeping rather
than punching through.

**Follow-up left open deliberately:** force trusted input for these field types (or this whole page) so the
retry isn't needed at all. Kept as a retry for now — it costs one extra Save cycle on one page and
preserves the hidden-tab speed win everywhere else. The retry's log line states the confirmed mechanism, so
whoever picks this up doesn't have to re-derive it.

Verified: extension **795/795** (`node --test`). SW global-scope + `apMatch` guards green. Live-verified
end-to-end on solarturbines: 5 pages replayed, review AGREE 53 / DISAGREE 0, submit gate passed in
SIMULATE mode.

---

## 2026-07-29 - a job-description page is not an auth screen (the false `auth-form-not-rendered` halt)

Background submit run, cat.wd5/solarturbines. The rehearsal loaded the approved bundle fine, then:

```
[SUBMIT-RUN] job page did NOT settle (ceiling) after 12156ms - 0 chars.
[ONBOARD] Stage 3 - auth screen detected.
[ONBOARD] waitFor(sign-in-form-render) timed out after 30000ms - 137 read(s) OK / 0 failed; tab HIDDEN.
[ONBOARD]   last page state: url=.../XMLNAME-2027--Gas-Turbine-Product-Engineering-Internship_R0000382293
            readyState=complete formFields=0 email=false password=false hasAuthEl=false
            signInButtonText=false markers=[continueButton]
[ONBOARD] HALT - auth-form-not-rendered
```

### The chain

The halt state names the bug: `markers=[continueButton]` is the **job-description page**, and the flow was
sitting on it waiting for sign-in fields.

1. The posting came back **EMPTY** - `0 chars` for the full 12s ceiling; Workday served nothing.
2. Stage 1 therefore found no Apply button (`pickApplyTarget` -> null) and **skipped**.
3. Stage 3's condition is `st.hasAuthEl || st.signInButtonPresent`. `signInButtonPresent` is a TEXT match
   over every clickable, and a Workday posting carries **"Sign In" in its own header** - so a JD page
   satisfied it. "Stage 3 - auth screen detected."
4. `doAuth` waited its full 30s hidden budget for credential fields that were never coming.
5. During that wait the page finished rendering and revealed `continueButton` - the very button Stage 1
   wanted - and **nothing re-checked**, so it halted claiming the sign-in fields never appeared.

The empty page was the TRIGGER; the false auth detection is the BUG. It would misfire the same way on a
merely slow posting.

### Three fixes

**`onJobDescription(s)`** - an apply-chain marker is POSITIVE evidence, and it beats the absence-based text
match. It requires NO credential field (`!hasAuthEl && !passwordInput && !emailInput && !signInWithEmail`,
zero form fields, `classifyWorkdayPage === "job-description"`), so a genuine auth screen can never match it.
Pinned in both directions: the live JD state -> `job-description`; an auth screen with a leftover apply
marker -> still `auth`.

**Stages 1-3 are now a bounded loop** (`applyStage:`, `MAX_APPLY_ROUNDS = 2`). Discovering mid-flow that we
are on a posting sends us back to Stage 1 rather than halting: `doAuth` returns `{backToApply:true}` and the
caller re-runs the stage. Previously the flow was a straight line with no way back to a stage it had passed.

**The wait predicate bails.** `onJobDescription` joined `sign-in-form-render`'s predicate, so it exits the
moment the button appears instead of burning 30s. That is the third instance of the standing wait-predicate
rule: *a wait must notice both that the GOAL arrived and that we are in the WRONG PLACE* (the first two were
`isPastAuth` in the auth waits and the terminal-state bail in `waitFor`).

### Not fixed with a reload - deliberately

The operator's initial instinct was a reload-and-retry for the empty page, then, on seeing the diagnosis:
*"if the issue isn't that the page didn't load and is something else don't change the reload"* and *"no need
to implement the reload now if it doesn't actively fix the issue."* A `settleJobPageWithRetry` was written
and then **reverted**. Correct call: the reload addresses the trigger, not the halt, and the three fixes
above make the flow recover from a late-rendering posting whether or not it was ever empty. Worth
reconsidering only if an empty posting shows up as a failure on its own.

Verified: extension **797/797** (`node --test`; +2 pinning the JD-vs-auth discriminator). SW global-scope +
`apMatch` guards green. Live-verification pending: re-run the background submit rehearsal on solarturbines;
the log should show either Stage 1 clicking Continue Application directly, or a hand-back line
(`this is the JOB-DESCRIPTION page, not an auth screen ... Handing back to the apply stage`) followed by it.

---

## 2026-07-29 (later) - `role="alert"` is Workday's upload STATUS channel, not an error channel

A rehearse run halted on page 2:

```
resume: NOT attached - resume attach failed - Workday reported an upload error:
        "Kevin's Hardware Resume.pdf loading"
resume NOT attached on page 2 ... the required upload blocks advancement. HALT.
```

`"Kevin's Hardware Resume.pdf loading"` is not an error. It is Workday's own aria-live PROGRESS
announcement, and the upload was in flight. This was a self-inflicted regression from the previous
resume fix: the new error detector matched `[role="alert"]`, and because it set `errorText`,
`cdpAttachResumeConfirmed` took its "Workday rejected the file, don't wait" branch and **skipped the
SW-side re-poll** - the exact wait that fix existed to perform. So the change intended to make a slow
upload succeed instead made it fail faster.

The precedent was already in the repo and I didn't heed it: dom-patterns records this channel announcing
*"...successfully uploaded"*, and `expandErrorSamples` already drops `[role=alert]` toasts because Workday
uses that role for non-errors.

### The fix

- The text is read as **`statusText`** - a status, not a verdict.
- An **ERROR** requires unambiguous wording (`error|failed|unsuccessful|unsupported|too large|exceeds|
  invalid|not allowed|try again`) or a dedicated `[data-automation-id="file-upload-error"]` node.
- **Progress wording** (`loading|uploading|in progress|processing|N%`) is treated as POSITIVE evidence the
  upload is still going: it sets `uploading`, which upgrades `sawItem` and **extends** the re-poll to 45s
  (from 20s) rather than aborting it. Checked BEFORE `sawItem`, so "loading" alone is enough to keep
  waiting even if the poll never caught a `file-upload-item` row.
- The SW re-poll now re-reads the status each tick, so a genuinely LATE error stops the wait instead of
  burning the whole budget.
- Every failure path logs `cleared / deleted / filesSet / sawItem / uploading / status`.

### Why the REPLAY run hits this and the FILL run doesn't

Operator: *"this has never happened during a fill but somehow keeps happening during the rehearse/submit
run."* Both paths share `cdpAttachResumeConfirmed`, so the code is not the difference. Leading suspect,
**not yet confirmed**: a FILL lands on a virgin Documents section, so `attachResume`'s clear loop is a
no-op and the upload starts immediately; a re-apply finds Workday's carried-over copy and must
delete-then-re-upload, which adds a server round trip immediately before the upload and delays its start.
The new `cleared=/deleted=` diagnostic settles that on the next occurrence rather than inviting another
guess.

**Deliberately NOT done:** skipping the clear+re-upload when the section already holds a row with the same
filename. It would remove this failure mode outright and be faster, but if the operator re-uploaded a
different resume under the same name we would silently keep the old document - a wrong-document failure,
which is worse than a slow one for an accuracy tool. Worth doing only with an explicit decision about that
trade-off.

Verified: extension **797/797** (`node --test`, unchanged - this is I/O classification; the page-side read
carries no pure unit). SW global-scope + `apMatch` guards green. Live-verification pending: re-run the
rehearse; a slow upload should now log `upload still IN FLIGHT ... Workday says "... loading"` and then
either confirm during the re-poll or fail with the full status trail.
## 2026-07-26 — Job DISCOVERY: a Discover button that fills the queue from LinkedIn + Handshake + the Simplify board (branch `discover-jobs`)

Operator ask: *"on the run page … make a discover button. that opens a linkedin, handshake, and github of the
simplify 2026 internships page. Finds recently posted jobs that I have not yet applied to and adds them to a
queue stored on the website. If the job description is not on the page, physically open the link, scrape the
jd, and close it."* Follow-up: *"The linkedin and handshake pages will use my account since I will be logged
in with cookies."* — so the boards are read out of the operator's OWN signed-in tabs; no API keys, no
credential handling, and discovery never attempts a login.

The stage BEFORE the queue. New `discover.js` (SW, importScripts after lib.js) + `AP_DISCOVER_JOBS` /
`AP_DISCOVER_RECON` external handlers + a `DiscoverPanel` on `/app/run`. **Reads only — never applies,
never submits, and writes nothing itself:** the sweep RETURNS jobs and the WEBSITE persists them
(`saveDiscovered` → `queue_items`), extending "engine computes / the caller does I/O" one level out.

- **Three sources, cheapest substrate that works.**
  - **simplify** — the SimplifyJobs/Summer2026-Internships board publishes STRUCTURED JSON
    (`.github/scripts/listings.json`: `company_name, title, url, locations, terms, category, active,
    is_visible, date_posted` unix-s — schema verified against the live file), so it's a plain `fetch`: no
    tab, no scraping, and a REAL posted date to filter on. Scraping the rendered README would be strictly
    worse. Only `active && is_visible` rows survive — an inactive row is a CLOSED posting, and queueing one
    would waste a whole run.
  - **linkedin / handshake** — the operator's logged-in job search, read from a real unfocused tab through
    their cookies. LinkedIn's `f_TPR=r<seconds>` + `sortBy=DD` make the SOURCE do the recency filtering
    (far cheaper than scraping a year of postings and dropping them here).
- **⚠ Selector confidence, stated honestly.** The Simplify feed is a verified published contract. The
  LinkedIn/Handshake list scrapers could NOT be traced from the build environment (both need an
  authenticated session), so against the standing "trace the real DOM — don't guess" principle they are
  written **structure-first**: anchor on the one thing that has survived every redesign (an `<a href>`
  carrying the posting id — `/jobs/view/<id>`, `/jobs/<id>`), walk UP to the enclosing card, then read
  title/company/location/date through a selector LADDER with a text-line fallback. They report
  `signedIn` + a per-source note rather than silently returning nothing. **`runDiscoverRecon`
  (`AP_DISCOVER_RECON` / popup "Discover recon") dumps the real card markup + selector hit-counts from the
  operator's session** — run it once per board and tighten the ladders from observation.
- **The JD pass — "physically open the link, scrape the jd, and close it."** `fillMissingDescriptions`
  opens each posting ONE tab at a time (never a fan-out), scrapes via the generic `scrapeJobPosting`
  ladder (Workday/Greenhouse/Lever/Ashby/Oracle + a largest-text-block fallback), and closes it in a
  `finally` — a thrown scraper can't leak a tab. A failed scrape is NON-FATAL: the job still queues with
  an empty description, because a missing JD is a nice-to-have, not a reason to lose a posting.
- **Reading arbitrary ATS hosts without an `<all_urls>` grab.** `discoverReadPage` tries
  `chrome.scripting` first (for the hosts we DO take: linkedin, handshake, raw.githubusercontent) and
  falls back to **CDP** for arbitrary employer pages — `chrome.debugger` is not host-gated, the same
  invariant the Workday walk already relies on. Cost: Chrome's "started debugging" infobar for the moment
  the tab is open. **`discoverInFlight` ⟷ `runInFlight` are now MUTUALLY EXCLUSIVE** — not politeness:
  cdp.js tracks its attachment in a module-level `cdpTabId`, so a discovery CDP read would clobber a
  running walk's tracked tab and detach it mid-fill.
- **Dedup — the load-bearing bit.** `discoveryJobKey` extends the tracker's `canonicalJobUrl` with board
  ids (`linkedin:<id>`, `handshake:<id>`, `greenhouse:<co>:<id>`, lever, ashby). Ordering matters: a
  Workday posting keys through `canonicalJobUrl` FIRST, so a job found on the Simplify board (whose url IS
  the employer's Workday link) produces the SAME key `applications.job_key` holds after it's applied to —
  that is what makes "jobs I have not yet applied to" actually hold across the two tables. The website
  sends `knownKeys` (applications INCLUDING soft-deleted + every queue row, each contributing both its
  stored key and a freshly-derived one so legacy rows don't re-surface) so the sweep skips them BEFORE
  spending a tab open; `saveDiscovered` re-derives every key SERVER-SIDE (a client-supplied key is
  ignored) and dedupes authoritatively, with the partial unique index on `(user_id, job_key)` as the
  race backstop.
- **Bounded by construction + NO SILENT CAPS.** `maxPerSource` 25 / `maxTotal` 60 / `maxJdOpens` 10, and
  whatever a cap drops is reported as a note ("N more matched but were left out by the cap") — "found 60"
  must not read as "that's all there is". An UNKNOWN posted date counts as FRESH (unit-pinned): every
  source is already time-bounded upstream, so an unparseable date is far more likely a parse gap than a
  stale job, and dropping it would hide real postings invisibly.
- **Storage:** migration `0010_queue_discovery.sql` adds `job_key/company/role/source/location/posted_at/
  job_description` to `queue_items` + the partial unique index. A PASTED row leaves them null and renders
  exactly as before; a DISCOVERED row leads with company · role · source · freshness · a JD toggle.
- Verified: extension suite **718 pass, 0 fail** (+29 discover tests); web suite **56 pass, 0 fail**
  (+11, including a **LOCKSTEP test that cross-loads the extension's real `discover.js`** and asserts both
  `discoveryJobKey` copies agree — drift is now a test failure, not a production surprise); web typecheck
  + production build green. **Live-verify PENDING** (needs the operator's signed-in Chrome): run
  **Discover recon first** per board, tighten the LinkedIn/Handshake ladders from the dump, then a real
  sweep.

## 2026-07-30 — Discovery rebuilt from a live trace of both signed-in boards

The 2026-07-26 discovery build shipped its LinkedIn/Handshake list scrapers
"structure-first": written blind, because tracing them needs an authenticated session
that wasn't available at build time. This was the trace that was meant to tighten
them from observation. It refuted them instead, and the rebuild changed the substrate.

### What the trace found

**Every one of the ~30 LinkedIn selectors matched ZERO** on an ordinary signed-in
results page. Not drift — a rewrite. LinkedIn shipped a server-driven UI where result
cards are `div[role="button"]` containing **no anchor at all** (the old identity anchor,
"every row carries a `/jobs/view/<id>` link, walk up from it", simply no longer exists),
and every class is a rotating build hash. Worse, and independent of the redesign: **the
search page silently DISCARDS `location=`, `sortBy=` and `f_E=` from its own URL**, so
the sweep had been running an unsorted, unlocated search since it was written.

Two stable, semantic, id-carrying anchors do exist, and both are what the rebuild uses:
`componentkey="job-card-component-ref-<id>"` (LinkedIn) and
`data-hook="job-result-card | <id>"` (Handshake).

Both boards also expose the JSON their own front-ends run on, which is strictly better
for what this branch needs: the employer's real application URL arrives as a **typed
field** rather than being guessed from off-host anchors near an apply button, board-only
applications are identified by that field's SHAPE instead of matching the words "easy
apply", posted dates are exact epochs instead of "3 days ago" parsed backwards, and
applicant counts come through — which is what makes ranking meaningful.

Full DOM detail, including every verified filter code and all three trap cases:
`docs/dom-patterns.md` 2026-07-30.

### What shipped

- **ONE driver for both boards.** Once traced, LinkedIn and Handshake have the same
  shape, so `discoverFromBoard(source, opts)` + a `BOARD_CONFIG` entry does both:
  identical paging, filtering, detail read, dedup and logging. Roughly 150 lines of
  near-duplicate driver code became one. Both use the rendered SEARCH PAGE for
  discovery (Handshake's JSON index ignores every filter param; LinkedIn's page runs its
  newer SEMANTIC search and beats its own keyword API for the same words) and the
  board's JSON RECORD per posting.
- **No overlaps across sources**, which was the explicit ask: because both boards
  resolve a posting to the employer's URL *before* dedup, the same job found on both
  collapses to one `discoveryJobKey` — the same key the tracker writes after applying.
- **The card-clicking pane reader is gone.** It clicked each result and settle-polled
  the details rail on page timers, which is exactly what made it unreliable in a
  background tab. One JSON read per posting replaces it, and nothing is clicked at all,
  so the Apply button can never be touched.
- **Scrape wide, queue narrow** (operator's design): several pages per board, then only
  the best `queueLimit` (default 10, or "all") by the deterministic `scoreDiscovery` —
  keyword/profile overlap, internship-by-title, freshness in hours, applicant count,
  Run-drivability, minus a promoted penalty. Everything left behind is reported with its
  score and reasons. Not an LLM call: cheap, stable, auditable.
- **Location is free text again**, resolved through each board's own typeahead once per
  (board, text) and cached. No hardcoded country anywhere; the panel seeds from the
  profile's `personal_info.country`.
- **Board-only applications skipped by default with support explicitly deferred**, and
  closed/archived postings dropped — both counted and noted.
- **Hidden-tab safe by construction:** all pacing is service-worker wall clock and the
  injected functions contain no `setTimeout` (Chrome throttles page timers in background
  tabs but not `fetch`). Card discovery polls for cards rather than guessing a settle
  delay, and recon reports `readyState`/`hidden` so a zero is always interpretable.

### Three bugs caught by testing against real data, not fixtures I wrote

1. **Handshake's apply link is in `job_apply_setting`, not `external_apply_link`.** The
   record has both; the obvious-looking pair is LEGACY and was `false`/`null` on **all
   30** sampled live postings, *including* ones that plainly apply offsite. My first
   adapter read it, my unit test passed because I wrote the fixture from the field I had
   assumed, and the live sample said "0% of Handshake jobs have an employer link" — which
   would have quietly reduced the whole source to zero once board-only postings are
   skipped. Read correctly: **33%** carry a real link (Greenhouse, Workday, Google
   Careers, Paylocity, Tesla). Pinned both directions.
2. **A `(Verified job)` card shifted every field by one.** The a11y summary line isn't
   byte-equal to the title, so a consecutive-dedupe left it in place and company took the
   title's value while location took the company's — on 2 of the first 5 cards. Wrong data
   that still looks plausible, which is the worst kind. The split moved out of the
   injected scraper into the pure `linkedInFieldsFromLines` specifically so it could be
   pinned against all three real card shapes.
3. **Date-sorting LinkedIn's search API destroys keyword relevance.** `sortBy:List(DD)`
   drops every promoted row, which looked like a free win and was briefly made
   unconditional — but "embedded software intern" then returns *EH&S Intern*, *Audit
   Intern*, *Finance Intern*: the newest internships of any kind. Relevance returns
   Skydio, Anduril, Blue Origin avionics/embedded, Palantir. Now relevance for WHAT, our
   own score for the ORDER, promoted penalised rather than sorted away.

Also fixed en route: **`maxTotal` was silently inert** — the panel never sent it and
object spread copies the `undefined` over the default, so `slice(0, undefined)` returned
everything. Both message forwarders now pass only keys the caller actually supplied.

### Verification

Extension **862 pass / 0 fail**; web **107 pass / 0 fail** (the lockstep test now
compares EVERY mirrored `DISCOVER_DEFAULTS` key, not four named ones); web typecheck +
production build green.

Verified live, in-page, against the operator's own signed-in session — running the real
shipped functions, not approximations: both list scrapers (25/25 LinkedIn cards with 0
field shifts, 24 Handshake), both detail APIs end-to-end through the real adapters (5/10
Handshake postings resolving to real employer hosts, up from 0/10 before the
`job_apply_setting` fix), the search-URL contracts (`start=25` paginates and returns a
different 25, `jobType=3` takes 62,820 → 4,989, the closed `sort` set), and the complete
location resolver (typed "Seattle" → 5 suggestions → clicked → `geoId=104116203`, pill
"Seattle, WA (50 mi)").

**PENDING:** the extension itself has not been reloaded, so the service-worker
orchestration (tab lifecycle, SW-side pacing, the website round-trip) is unverified.
Chrome blocks automation of `chrome://extensions`, so that reload is a manual step.

### 2026-07-30 (same day, later) — live-verified end to end, and the five bugs live testing found

The rebuild above was unit-green and in-page-verified, but the extension itself had not
run it. Reloading and actually sweeping found five real defects that no test caught,
each of which is now pinned or documented. Verified working end to end afterwards:
LinkedIn + Handshake + Simplify, fully unfocused, employer links on every queued row.

**1. `scanned 3` of 25 — a silent under-read.** `pollForCards` returned on the first
NON-EMPTY read; both boards mount their list progressively, so it caught the page
mid-render and reported success. Now it settles on a stable non-zero count (or a full
page), with per-board budgets (LinkedIn ~8s, Handshake 15–25s). Fourth instance of the
same lesson — never scan a progressively-rendered page without settling it first.

**2. The location resolver ran before the page existed.** It fired ~2s after the tab
opened, so the control wasn't there yet, and the failure was NOT harmless: with no
geoId the url carries no location param and LinkedIn substitutes the SESSION's last
location — every result came back Seattle while the operator had asked for the whole
US. Resolve now runs after the cards settle, and a failed resolve says explicitly that
the board used its own default.

**3. The location control is a TOGGLE and was being re-clicked blind.** Click → flat
500ms → check once → loop. The panel needs longer than 500ms, so attempt 2 closed what
attempt 1 opened, alternating (`clicked yes, box NOT found` × 8). Now: check if already
open, click at most once per round, then poll.

**4. It typed the location into the JOB SEARCH BOX.** The worst of the five. Handshake's
location panel is `display:none` until opened, so no location box is visible, and a
"first input that isn't the keyword box" fallback returned the KEYWORD box — the
resolver typed "Pittsburgh, Pennsylvania" into the job field, matched a job suggestion,
clicked it, and reported `location-token-never-appeared`. A completely wrong ACTION
disguised as a timing failure. (It also slipped the exclusion list because the regex
said `describe the job` and Handshake's placeholder is "Describe **a** job you want".)
Both boards are now matched POSITIVELY, and anything else returns null — which correctly
means "the panel isn't open yet".

**5. The record budget was spent on the wrong jobs.** `maxJdOpens` (10) was calibrated
when a JD meant opening a tab. A board record is now one cheap fetch, but records were
read for the NEWEST 10 while the queue kept the BEST N — different sets — so a queued
Amazon posting arrived with no JD and no employer link (`resolved:false`). Split into
`maxRecords` (25, covers a page) and `maxJdOpens` (10, real tab loads), plus a pre-rank
so the budget goes to the jobs most likely to be queued.

**NEVER REQUIRE FOCUS (operator, mid-session).** The resolve initially worked only in a
foreground tab — same click, same coordinates, panel opens when presented and never when
hidden, because the reveal defers on rAF (paused) and timers (throttled). Borrowing real
focus was implemented and then REJECTED on the operator's instruction: a sweep must run
unattended. Replaced with the three levers cdp.js already had — `cdpInstallPageOverrides`
(worker timers escape throttling, behind `Page.setBypassCSP`), `cdpWakePage`
(`setWebLifecycleState:"active"`, re-applied per poll tick since a hidden tab can be
re-frozen), and `cdpSetFocusEmulation` (`Emulation.setFocusEmulationEnabled`, which keeps
the page repainting). "Denver, Colorado" and "Pittsburgh, Pennsylvania" then both resolved
with the tab unfocused, results genuinely Denver/Pittsburgh.

**What made this debuggable.** The service-worker console isn't readable from outside, so
`could-not-open-location-control` was unactionable on its own. `resolveBoardLocation` now
returns a `diag` — attempts, whether the control was found and its label, whether the
click happened, whether the box was found, the viewport, the filter-strip buttons it DID
see, the suggestions offered and which was picked — and the note prints it. That is what
located bugs 3, 4 and 5. One `return` omitted the diag and the note then blamed a missing
control that had in fact been found and clicked; every failure path now carries it.
A localhost-only `AP_RELOAD` message (operator-approved) restarts the worker so a
build/verify cycle doesn't need a manual click at chrome://extensions; it is refused while
a run or sweep is in flight.

### The before/after, in the operator's own queue

The queue ended the session holding both eras, which is the clearest evidence of what
changed. 20 rows from the OLD code, every one a `linkedin.com` BOARD LINK and none of
them a match: *National Director General Agents*, *Associate Commercial Title
Underwriter*, *Auxiliary Operator*, *Tax Accountant – Retail Location*, *Office
Manager*, *Audiovisual Technician III* — i.e. LinkedIn's RECOMMENDED FEED, which is
exactly what a keyword-less/unlocated search returns. 12 rows from the rebuilt sweeps,
every one an employer/ATS link: `sonos.wd1.myworkdayjobs.com`, `boards.greenhouse.io`
(×2), `joinbytedance.com`, `eeho.fa.us2.oraclecloud.com`, `recruiting.paylocity.com`,
`grnh.se`, `workforcenow.cloud.adp.com`, `www.amazon.jobs`, `jsv3.recruitics.com`,
`www.governmentjobs.com`. 100% board links before, 100% drivable employer links after.

### Live-verified runs (all with the tab UNFOCUSED unless noted)

- LinkedIn, "software engineer intern", 1 page → `scanned 25`, 23 matched, best 2 queued,
  21 reported as left behind.
- LinkedIn, "robotics intern", Denver CO → location resolved HIDDEN, all results
  Golden/Littleton CO, `employerLinks 20/20`, `jdOpened 0`, `jdFailed 0`, `unenriched 0`.
- Handshake, "software engineering intern", Pittsburgh PA → location resolved HIDDEN,
  24 → 9 matched (the filter really applied), results genuinely Pittsburgh.
- All three sources, "software engineering intern" → `scanned {handshake:24, linkedin:25,
  simplify:14649}`, 70 matched, best 8 queued, every one `external` + `resolved` + read
  from a board record, `jdOpened 0`, and the cross-source guard fired: *"1 posting was
  listed on more than one board under different employer links and was queued once."*
- Foreground run (the new "Sweep in the background" toggle, off) → same behaviour, which
  is how the focus dependency was isolated in the first place.

Suites after all of it: extension **866 pass / 0 fail**, web **107 pass / 0 fail**,
typecheck + production build green.

**Correction (same day).** The note above claimed Handshake's location box "only accepts a
city, state or ZIP" and therefore could not filter by country. That was WRONG — the
operator corrected it, and a re-test confirms Handshake resolves "United States" fine
(25 scanned, 24 matched, every result a US location). The original failure was the
keyword-box bug: the location text had been typed into the job-search field, so no place
could match, and the placeholder was then quoted as if it explained the limit. The
explanation outlived the bug that produced it. The resolver's message now reports only
what was observed ("its location box offered no match for X — check the spelling") and
asserts nothing about what a board supports.

### 2026-07-30 (later still) — ranked by MATCH %, resume-derived searches, richer queue rows

Five operator changes, and the live sweeps that made each of them work.

**1. Applicant count no longer ranks anything.** ("I don't need the how many people
applied sort. mainly filter on when it was posted.") It is still read and shown — it is
free and useful to a human — but `matchPercent` ignores it and freshness took the weight
it used to carry. Unit-pinned in both directions.

**2. A REPOST is not a new posting.** ("sometimes it says when it was reposted. that is
different from when it was actually posted.") Measured on LinkedIn: **2 of 3** sampled
postings were reposts, one whose bump was **63 days** newer than its original. Ranking
the bump would re-float a two-month-old job to the top of every daily sweep. The record
carries both `listedAt` and `originalListedAt`; `postedForRanking` takes the original,
`reposted` rides through to the queue, and the row says "reposted 2h ago" rather than
"posted 2h ago" with the true date on hover. Live: a genuinely-new posting scores 95%
where the 63-day repost scores 65%.

**3. Three knobs removed, one added.** "Posted within N days", "Read up to N job
records" and "Scan up to N pages" are gone; the sweep uses the shared defaults instead
(the recency window went to 30d — matchPercent scores freshness directly, so a wide net
costs nothing because stale postings simply fall under the threshold). In their place a
single **"Queue matches above N%"**. That is why `matchPercent`'s components sum to
exactly 100 — relevance 0–65, freshness 0–30, drivable 0–5 — an unbounded score cannot
be compared against "60".

**4. A blank keyword box now searches the RESUME, not just the major.** ("search for
different things that I would be interested in based on my resume instead of just the
major.") `buildDiscoverQueries` derives several searches — past job titles with the
level words stripped, the field of study, then skills PAIRED — and runs each against
both boards, merging via the existing dedup. Live on the operator's own profile it
produced *"Robotics Lab intern · Firmware intern · Electrical and Computer Engineering
intern"*. Two quality fixes came straight out of seeing that: "Firmware **Team Member**"
was searching for "team member" as though that were a kind of job, and the titles filled
every slot and pushed the major out entirely — so generic-noise nouns are stripped and
one slot is RESERVED for the field of study.

**5. The queue shows pay, term, deadline and why it matched.** ("give more information
like the pay, start date/end date if they have and other important information.")
Discovery already read all of it from each board's record and was throwing it away at the
queue boundary. Migration `0012` adds one `details jsonb` — one column rather than eight
scalars because the set is board-dependent and still settling (Handshake publishes pay
and a term; LinkedIn publishes neither — its `salaryInsights` is a link to its salary
tool, not a number). Rows now carry pay · employment type · workplace · term · apply-by ·
applicants · match % + its reasons, and a `NN% match` badge whose tooltip lists why.

### The bugs these rounds surfaced

**Handshake's pay was being invented.** The first cut rebuilt the label from the record's
raw numbers and produced **"$3000/hr"** and **"$50K/mo"** live. Tracing one posting
against its own card showed why: `salary` is in **CENTS** (3000 where the card reads
"$30-50/hr"), `salary_type_name` is **"Paid"/"Unpaid"** rather than a unit — it was being
read as one — and **"Unpaid"**, which the card states plainly and which matters a lot to
a student, was dropped entirely. Handshake already formats the label correctly, so the
reconstruction was deleted and the CARD is now the source of truth. Live after: "$30-50/hr",
"$15-20/hr", "$40-50/hr" — matching the board exactly.

**Handshake wouldn't render hidden.** A query that shows 14 cards in a foreground tab
returned `scanned 0` three sweeps running while unfocused, and the sweep blamed the
scraper ("no job cards found … run recon"). LinkedIn survives a hidden tab; Handshake's
slower SPA does not. `retryHiddenRender` now applies the same three levers the location
resolver uses — worker-timers behind `Page.setBypassCSP`, `setWebLifecycleState`, and
`Emulation.setFocusEmulationEnabled` — but ONLY when a board came back empty while
hidden, so a board that renders fine unfocused never pays a debugger attach. Live after:
`scanned 14`, matching the foreground count exactly.

**"No cards" and "no results" were the same message.** A narrow derived search with zero
matches was reported as "the layout may have changed — run recon", sending the operator
to debug a scraper that was working. Handshake states the count itself in a hook already
traced (`job-search-results-status-announcer`), so the two are now distinguished.

**A failed location resolve poisoned the rest of the sweep.** Handshake persists filters
per session, so an abandoned "United States of America" left sitting in its location box
kept being applied to every later search. The resolver now empties the box on the way
out, unconditionally.

**The profile's country matched neither board.** Its canonical value is "United States of
America"; both typeaheads want "United States". `locationVariants` tries progressively
simpler forms (strip " of America", then the first comma-parts), so one unlucky string no
longer costs the location filter entirely.

**A failed resolve was retried at full price every sweep.** Driving a location dropdown
is the most expensive thing in a sweep, and a failure costs the whole budget — repeating
it is what pushed a 3-search sweep to **224s**, past the point where the page had given
up waiting. Failures are now negative-cached for a day (so a transient one still
self-heals), the resolver's own budgets are tighter, pages after the first get a shorter
"warm" ceiling, and a SLOW board runs fewer of the derived searches (`maxQueries` per
board: LinkedIn 3, Handshake 1). 224s → **65s**.

**A python heredoc turned every `\b` into a literal 0x08 byte** in the ported regexes, so
the word-boundary assertions silently became impossible-to-match literals. The lockstep
test caught it as a drift. All patching now goes through a small CRLF-normalising helper
rather than shell heredocs.

### Verification

Extension **875 pass / 0 fail**, web **110 pass / 0 fail** (the lockstep suite now covers
`buildDiscoverQueries` and `discoverKeywordTokens`, and asserts neither side keeps a stale
`queueLimit`), typecheck + production build green. Live, tab unfocused: Handshake
`scanned 14` with correct pay/term/deadline on every row; LinkedIn `scanned 62` across
three derived searches with 8 cross-query duplicates deduped; a 60% threshold queueing 3–4
of 16–18 found and reporting the rest.

## 2026-07-31 — MULTI-ATS: Greenhouse / Lever / Ashby end-to-end (fill → review → submit-gate), all live-verified in BACKGROUND tabs

The first non-Workday ATS support, built in one day from live traces (branch `worktree-multi-ats`; the standing rules live in CLAUDE.md → Multi-ATS). Commits: dev-log mirror (`99f00e5`), traces + substrate + GH fill (`99775a8`), Lever + EEO containment + JD grounding (`4f26a38`), Ashby (`cec89c9`), submit gate (this commit).

- **Recon first** (the standing rule): all three ATSs traced read-only in the operator's browser across Anthropic/Figma (GH), Kraken (Lever), OpenAI (Ashby) — full rulebook entry in dom-patterns 2026-07-31. Key findings: one page, no login, no draft ⇒ submit = re-fill a BLANK form from the approved bundle; ALL THREE commit from synthetic events (Runtime.evaluate page-side — identical visible/hidden, no Input.* pipeline, no focus emulation); react-select repeats the Workday option-contamination lesson verbatim (scope reads to the widget's own listbox).
- **`ats.js`** — detection, per-ATS static maps + a label ladder (buckets → recognizers → employment recognizer → AI(required-only) → blank), ONE unified scanner, self-contained injected actuation fns, `driveAtsPageFill` producing Workday-record-compatible results → the SAME `buildReviewBundle` → the website review editor works unchanged. Reuses `resolve()` (bool ladders), `matchCandidates` (containment OFF default), `recognizeEmploymentQuestion`/`decideEmploymentStatus` (live: "Have you ever worked for Figma before?" → deterministic clean-miss "No"), `optionForPolarity`, and the AI seam (`makeCdpActuation(llmConfig).llm` — identical gating).
- **Live-caught fixes** (each visible in the [ATS-FILL] per-field log): the dial-code composite needs the route KIND to reach actuation + `country_phone_code`'s ladder; GH phone renders "(850) 666-0266" (digit-relief verify); stated-EEO containment (each ATS words long-form demographics differently) + the POLARITY BRIDGE ("do not" vs "don't" — a contraction no string tier can bridge; a stated Yes/No-leading value maps to the unique same-polarity option, flagged); Lever location = a same-origin `/searchLocations` fetch + writing the input + hidden `selectedLocation` exactly as a suggestion click would (the RENDER never happens hidden — fetch is throttle-immune); Ashby entry UNION (the EEOC survey + consents carry only the hashed `_fieldEntry_*` class) + a stamped id for the identity-less location combobox + 3-consecutive-reads settle (sections mount in bursts); the JD now rides `jobContext.description` into the AI prompts (ungrounded, the essay invented "Kraken's work in the robotics space" for an ENERGY company).
- **Submit runs** (`runAtsSubmitRun`): pull by job_key → re-fill from `valueFor` (bundle values, AI OFF) → STRICT verify (every approved non-blank value on the form; absent fields fail) → gate = bundle blockers + verify + no VISIBLE captcha challenge + `arm===true` → the ONE trusted click. Verified as DRY REHEARSALS on all three ATSs: **GH would-submit · Lever would-submit · Ashby would-submit — nothing submitted anywhere** (no `arm` was ever sent). Live-caught en route: the bundle must store the COMMITTED OPTION TEXT, not the dial chip's "+1" display (unreplayable); Lever's DORMANT invisible-hCaptcha container is a full-viewport `visibility:hidden` iframe (a size-only test false-halts — the challenge detector now reads computed styles + sane challenge dimensions); **Ashby's EEOC names carry a PER-SESSION uuid prefix** — replay keys on the durable `__systemfield_*` suffix (both sides).
- **Website**: ReviewEditor's "Submit blocked" banner filtered on the `ai-text-needs-answer` FLAG alone, so a REPLACED placeholder blocked the banner forever — now lockstep with the envelope (`flag && hasPlaceholder`). `canonicalJobUrl` strips Ashby's `/application` (lockstep `web/lib/job-key.ts`).
- **Dev loop**: `AP_DEV_LOGS` (the SW-console mirror) + `AP_DEV_ATS_SCAN` (read a run tab's live form state) made every one of these fixes diagnosable without DevTools. ⚠ Chrome can randomly WEDGE the SW after a `chrome.runtime.reload()` (a Chrome bug, NOT reload-frequency — operator: reload freely; it happened once in ~15 reloads): the SW goes silent (even AP_PING times out) until a manual chrome://extensions reload.
- **Known limits**: GH `candidate-location`'s places service never loads in this browser (even human typing hangs on "Loading…" with zero network — suspected privacy extension) → honest needs_review; Lever forms with a VISIBLE hCaptcha checkbox halt `captcha-challenge` (never solved by the bot); GH cover_letter deliberately operator-supplied; Ashby date questions fill as text + flagged.

## 2026-07-31 (b) — MULTI-ATS robustness round: 4 more live companies, 8 fixes, buckets own the aliases

Breadth pass (operator: "everything needs to be properly tested; make these sites very robust"): GitLab + Scale AI (GH), Zoox (Lever), Ramp (Ashby) — 8 companies total now across the three ATSs, plus a FOREGROUND fill (visible/hidden parity confirmed byte-for-byte on Zoox) and a first-try rehearsal pass on a never-before-rehearsed form (Zoox: would-submit, 0 failures, incl. the fetch-based location replay).

- **The one silent-wrong-fill caught** (Scale AI): "…require company sponsorship to retain or extend your WORK AUTHORIZATION…" hit the auth rung's `work authorization` tail → answered "Yes" (authorized) where the truth was "No" (no sponsorship). Sponsorship now routes FIRST; the auth rung refuses labels mentioning sponsor*; pinned with the live wording. Every other gap this round failed SAFE (blank/flagged), this one didn't — it's the reason the round existed.
- **Ramp's nested-radio entry**: the SMS-consent radios live INSIDE the Phone entry; the scanner's radio branch `continue`d past the entry and the tel input vanished from the scan. Branches now FALL THROUGH to the generic input loop (dedup by `seen`; the loop skips radio/checkbox explicitly).
- **Cascade re-scan** (the Workday M1 pattern): SPA sections mount in bursts — even 3-consecutive-reads settle can catch a pause. Post-fill re-scan (2 rounds) runs the identical ladder on late-mounted fields, tagged cascadeRevealed (fill loop extracted as atsFillFields/atsFinishFill).
- **EEO relief is LABEL-keyed** (Zoox): a bucket routed eeo[race] before the EEO rung and carried no containment → "Asian" missed "Asian (Not Hispanic or Latino)". atsIsEeoLabel enables containment + the polarity bridge whatever tier produced the value; the native-<select> path (first exercised on Zoox's EEO selects) gets the polarity bridge too.
- **ALIASES BELONG TO THE BUCKETS** (operator rule, same day): "Phone"/"Preferred Name (if applicable)"/"What is your current country of residence?"/current-employer+title/salary variants ship as DEFAULT_ALIAS_WORDINGS in ensureDefaultFieldWordings (web/lib/teach.ts) — visible + editable on /app/teach, reaching the fill through the ordinary bucket tier. The extension's label router keeps ONLY composes (full name) and multi-fact logic (sponsorship, employment recognizers), and says so in a comment. Round-trip verified: sync → Ramp phone AI(flagged) → filled·bucket.
- Also: GitLab's "worked at or consulted for GitLab?" correctly falls past the strict employment recognizer to a FLAGGED AI "No" (the recognizer stays high-precision; the flag is the net); cover_letter file input scanned + deliberately operator-supplied.

## 2026-07-31 (c) — APPLY-ELSEWHERE decoy detection (the Anthropic/Constellation pattern)

Operator: some postings host a DECOY form — "you will not be considered unless you complete the Constellation application form… You do not need to submit this Greenhouse application" — and the real application is the partner link. Detection is STRONG-PHRASE only (precision over recall; pinned that ordinary form language never matches). The anchor pick is scored (apply-labeled text → near-phrase → apply-ish href), refuses 2+ distinct targets, and the run then CHASES the link once: a supported-ATS landing continues that pipeline in the same tab; Workday hands the resolved URL back; anything else halts `apply-elsewhere` naming the real URL. The SUBMIT run refuses decoys outright — even a bundle approved before the detector existed. Live: the Anthropic Fellows posting detected, "Apply using this link" picked from 26 off-host anchors, bit.ly resolved to the Airtable application form, honest halt with the URL; Figma (negative case) filled normally.

## 2026-07-31 (d) — TEACH verified end-to-end on multi-ATS fills; two teach bugs + the "AI declined" text

The teach loop was exercised against the new ATSs and CLOSED: Zoox's "Race" (a stated-profile fill that could only reach the form via the flagged containment tier) → taught from the teach page → next fill **10 filled / 0 needing review** (was 9/1). The modal correctly offered "TEACH BOTH" — the new WORDING ("Race") and the new ANSWER VARIANT ("Asian (Not Hispanic or Latino)") — leaving the stored profile value untouched.

Two real bugs found by doing it:
- **A deterministic fill didn't name its own field.** The EEO / work-auth / how-did-you-hear / age rungs returned candidates with NO `path`, so the record had no `mappedPath` → the bundle no `canonical_field` → the teach page said *"no existing field matched"* and offered to create a DUPLICATE answer next to the real `self_identification.race_ethnicity`. Every profile-backed rung now carries its path (pinned).
- **`maps_to` is LLM-authored and hallucinates.** A relocation question came back `screening.willing_to_relocate` — no such path (the real one is `application_questions.availability_and_preferences.willing_to_relocate`). Binding a Mode-A bucket there resolves undefined forever: a DEAD bucket that silently teaches nothing. `validProfilePath` now checks the hint RESOLVES in this profile (resolution, not the panel's displayable rows — those skip nested objects, but a bucket resolves any dotted path). Both directions pinned.

Also (operator): **the AI must never write machine jargon onto an employer's form.** A required text the AI can't ground was writing `[NEEDS YOUR ANSWER — AI declined: ai-declined]`; it now writes **"N/A"** — the truthful answer for the case that actually produced it (a conditional "if yes, tell us more…" next to an answered "No"). Safety is unchanged: the record stays `needs_review` (flag `ai-no-basis`), so approval still gates the submit; the operator edits it or knowingly approves the N/A.

## 2026-07-31 (e) — Discord (heavy Greenhouse form): the combobox path rebuilt; a stated answer never vanishes

Discord's 26-field SWE application broke every select while five other forms worked, and fixing it turned the combobox path from "open, wait 250ms, read once" into OPEN → SETTLE → SEARCH BY NAME → REPORT. Four distinct traps, all documented in dom-patterns 2026-07-31 (b): a one-shot read under-waits (menus are polled now); **`aria-expanded` lies** (a phantom-expanded widget skipped its own open forever → the open call takes a `force` flag, used only after an empty list has been SEEN); a controlled react-select input **reverts a directly-set value** (clear → settle → type, the Workday rule on a different framework); and a long list renders only its first page, so absence is only believable after SEARCHING BY NAME — polling FOR THE HIT, never for "some options", because the widget shows the previous page while it searches. Result on Discord: 7 filled/11 review → **12 filled / 5 flagged / a handful surfaced honestly**, with country + every EEOC/work-auth dropdown now deterministic. Regression-checked after the rewrite: Figma 13 filled/4 review, Zoox 10/0, Ashby OpenAI 10 filled + 2 flagged — all hold or improve.

Second change, from the same evidence: **a STATED profile answer the form can't take is now `needs_review`, not a silent skip.** The profile said "Bachelor of Science"; the form offered "Bachelor's Degree"; the field simply vanished. The operator HAS an answer there, so it belongs on review (flag `stated-value-unmatched`, the live options attached so the editor renders a picker) and in teach. A genuinely unmapped question stays a quiet `skipped` — optional-blank as before.

⚠ Honest limitation kept in the docs: Discord's `school--0` async list answers a hand-typed "Carnegie Mellon" in ~2s but returns nothing to the identical query during a fill (typed + stuck + verified, ~5s of polling, foreground and background) while its sibling pickers on the same form DO answer. It ends as an honest needs_review naming the profile answer — never a wrong value.

## 2026-07-31 (f) — generality round: 9 companies, apply-link following, honest option recon, 3 full end-to-ends

Operator's bar for this round: it must work on ANY form of a supported type — fill correctly or surface honestly, never fill WRONG — and **never** a page-specific hack. Audited first: every literal in `ats.js` is an ATS-wide platform convention (Greenhouse's standard field ids + react-select classes, Lever's `#location-input`/`urls[...]`/`#btn-submit`, Ashby's `_systemfield_*`/`_fieldEntry`); company names appear only in provenance comments, never in code.

**Three full end-to-ends, one per ATS, each fill → review (edit/approve) → dry rehearsal → `would_submit`, nothing submitted:** Palantir (Lever, NEW — two values changed in review, incl. picking a campus), Linear (Ashby, NEW — 7/7 approved), GitLab (Greenhouse — 13 fields replayed, 0 failures).

New generic behaviour, each earned from a live failure:
- **THE LANDING MAY NOT BE THE FORM.** A Greenhouse posting URL 302'd to the employer's own careers site (zero fields, only an "Apply" link). The run now classifies where it actually landed, finds the apply affordance (`atsInjFindApplyLinks` + the scored, ambiguity-refusing `atsPickApplyLink`), follows it ONE hop, re-detects the ATS, and continues there — or halts naming the real URL (live: Stripe self-hosts its application → honest `apply-off-pipeline`, nothing filled). A Workday landing is handed back for the Workday pipeline.
- **A REVIEWED CHOICE FIELD ALWAYS CARRIES ITS OPTIONS.** The AI path returned before attaching them, so a required university dropdown reached review as "please fill it in yourself" with nothing to pick — after the fill had just read all 3302 options.
- **A TRUNCATED LIST IS NOT AN OPTION SET.** A widget that renders one page (exactly 60 of ~2000, alphabetical) was rendering as a pick-one `<select>` — inviting a wrong-but-present pick, or stranding a required field. `atsAttachOptions` now routes a page-sized-or-longer read into `captured_options` + `widget_type:"typeahead"` (the schema's existing partial concept), and the web editor gained a `PartialCombobox`: filter what we captured **or type the exact value**, with an honest "showing N of more" note.
- **SHOW THE OPTIONS NEAR WHAT WE WANTED.** `atsNearOptions` ranks the live list against the intended value, so a 3302-school list surfaces "Carnegie Mellon University - Pittsburgh / - Silicon Valley" — which is exactly the choice the ambiguity guard correctly refused to make. Narrowing applies ONLY to long lists; on a short list every option stays (unit-pinned both ways).
- Fixed en route: re-attaching options left the previous set behind (stale options in review).

Also: `AP_DEV_CLOSE_TABS` (dev-only) cleans up the tab each run leaves behind. Suite 933/933; web typecheck green.

## 2026-08-02 — placeholder guard, sign-in clear, honest halts; review→rehearse verified with human edits

Session goal (operator): "physically go and approve things … maybe change an answer here or there to
test if the rehearsal run truly will follow the human approved answers." It does — and getting there
turned up three bugs. Full DOM detail: dom-patterns 2026-08-02 (d).

- **A menu's prompt row is never an answer.** Waystar's "Select One" is a plain ENABLED option, so it
  reached the AI as a legitimate choice and got picked; Workday rejected the page as required-empty.
  `isPlaceholderOption` (lib.js, pure, text-based, deliberately narrow) now keeps it out of the three AI
  dropdown prompts, out of the review editor's lists (the operator's point: on Workday the placeholder
  is TEMPORARY and cannot be re-chosen, so offering it offers something the form disallows), and counts
  as BLANK in the submit gate. Live-verified: the same question now answers "Yes, I am open to
  relocating".
- **Verify the clear before typing.** Browser autofill left an address in the sign-in email box, the
  keyboard clear silently failed, and the insert APPENDED. The clear is now read back, retried with a
  second strategy, and a field we could not write HALTS instead of submitting garbage (which Workday
  reads as wrong credentials — and the flow could then create an account under a foreign address).
- **Stop naming unverified causes.** The stalled sign-in blamed Chrome's data-breach dialog (it was the
  contaminated box); the replay's nav-timeout blamed an empty required field (Workday's banner said
  "32312 is not a valid postal code for Georgia"). Both now quote what they saw.
- **The contract holds.** Seven hand-made edits across two Magna applications — text, dropdown,
  repeating-entry text, textarea, self-ID dropdown — all replayed as the human left them:
  AGREE 46 · DISAGREE 0 and AGREE 45 · DISAGREE 0 → WOULD CLICK SUBMIT, nothing submitted.

Extension 961/961; web 117/117; typecheck + build green.

**Blocked, not a code fault:** the Gemini free-tier key is out of quota (HTTP 429; Test connection
confirms), so new fills needing an AI answer leave those fields `needs_review`. Rehearsals are
unaffected — the replay runs with AI off by design.

## 2026-08-03 — running the full human flow, twice per job

Operator: find the job, run it from the website, review, approve/change fields, rehearse — "this
process should have no errors". Five bugs, each invisible from outside the logs. Detail:
dom-patterns 2026-08-03.

- **The error parser truncated any label containing its own stop-word** ("What is your desired
  compensation" -> "What"), which silently disabled Tier-1 remediation, the phantom-required guard
  and the field diagnosis, and pointed the log at the wrong explanation.
- **A value the form REJECTED still counted as filled.** Every verification we own runs before
  Workday validates, so a discarded value stayed in the bundle as an answer. Now reconciled against
  a live scan, narrowly, and every no-op explains itself — the first cut was silent and hid its own
  failure for a whole run.
- **An absent autofill_rules allowlist read as "off"**, and the website never sends one — so AI
  free-text was disabled on every website-driven run while the log blamed the operator.
- **A required pick-one checkbox group had no path to an answer** on any layer, so PSECU could never
  advance. A bare checkbox stays excluded: ticking one is an assertion, not a choice.
- **Requisition ids that are not R<digits>** (JR109393) fell back to a path key that Workday's own
  redirect rewrites — two tracker rows for one job, and a rehearsal refusing its own bundle.

PSECU then ran the whole flow clean: fill -> approve 8 -> change the AI demographic + phone type ->
re-approve -> rehearse -> AGREE 49 · DISAGREE 0 -> would-submit. Nothing submitted.

Extension 972/972; web 117/117; typecheck green.

## 2026-08-04 — the async combobox: "No options" is not an answer while the widget is still searching

Closed the oldest open multi-ATS bug (the 2026-07-31 Discord `school--0` limitation) by tracing it
instead of theorising about it. Full DOM detail + measurements: dom-patterns 2026-08-04.

The diagnosis, from running the shipped reader verbatim in the live page: the widget renders **"No
options" at 4ms**, marks itself **"Loading..." at 23ms**, and answers at **4049ms** on a hidden tab
(the search fires 312–873ms after typing — a ~300ms debounce inflated by the ~1Hz timer throttle —
and renders 390–4459ms in). The fill polled a flat 2000ms, then **re-typed** the query, which
restarts that debounce and discards the in-flight search, then gave up 1500ms later. So the old path
could not have filled this widget at any budget, and the variance is what made it look intermittent.

Four changes, each pinned by a test that fails when it is reverted:
- **`atsInjReadOptions` reports `loading`** (react-select's `.select__loading-indicator` /
  "Loading..." menu message / `aria-busy`) — the only signal separating "no such option" from "not
  yet". Verified live: true for the whole pending window, false the moment it answers.
- **Poll budgets gained a loading CEILING** (`ATS_POLL`): the soft deadline no longer applies while
  the widget says it is fetching. A widget that is not loading behaves exactly as before, and a
  healthy one still exits on its first read, so nothing fast got slower.
- **The retry recovers from a FAULT, not from slowness.** Force-open + re-type now fires only when
  the menu is genuinely CLOSED or the widget dropped our query; an open widget still holding the
  query that never reported loading gets one re-type nudge (the client-side recovery, kept and
  pinned); one that HAS been loading is only ever waited out.
- **Look before clearing.** A long server-backed list does not carry the searched value on its
  unfiltered first page, so the pre-commit clear was deleting the option it was about to click
  (`option-not-found`). It now reads the menu first and clears only if the option is not on screen.
- Plus: a field that runs out of budget mid-fetch now says *"the form's own option list was still
  loading"* instead of "listed no options", and the AI fallback's own option read got the same gate
  (it was stranding required fields with "no live options to choose from").

Verified live on the real widget, one sequence: type → wait through `loading` (4.4s) → click the
searched option without clearing → the field reads "Bowdoin College". Nothing submitted. Extension
1049/1049; web 140/140; typecheck green.

Still not proven: the 2026-08-02 `#country` empty-list observation — a client-side widget, never
reproduced. The force-toggle-and-re-type shape its entry named as the leading theory is now
impossible, so it is removed-by-construction rather than diagnosed.

## 2026-08-05 — multi-ATS end to end, and the résumé that was filed as a cover letter

Branch `worktree-non-workday-debug`. Goal (operator): keep debugging non-Workday forms, end to end.
Six defects, all found by running the whole human flow on live Greenhouse forms; DOM detail in
dom-patterns 2026-08-04 / 2026-08-05.

**The terminal line, on GitLab AI Engineer:**

    fill      -> 23 fields, 5 to review, 35.4s (1540ms/field, tab HIDDEN, NOT painting)
    review    -> the website tracker, 20 filled / 3 skipped
    approve   -> 6 / 6 flagged approved, Ready to submit
    rehearse  -> 23 field(s) replayed, 0 failure(s), 0 bundle blockers, no captcha
    gate      -> ▶▶ WOULD CLICK SUBMIT ◀◀        (nothing submitted; no arm was ever sent)

- **⚠ The résumé went into the COVER-LETTER slot on a replay** — the operator watched it. Greenhouse
  renders the cover letter as a file dropzone and the replay treated every file field as the résumé;
  the fill was innocent (its router maps `cover_letter` → skip), so nothing but a rehearsal could
  surface it, and no gate could catch it (the strict verify only re-checks approved VALUES). Fixed by
  routing replay file fields through the same router the fill uses. Verified live twice.
- **Numbered option lists** (`"1. United States of America"`) beat exact, containment AND fuzzy (88.9%
  vs the 90 bar), leaving a REQUIRED field the profile answers perfectly for the operator. Stripped for
  matching on BOTH sides — a commit stores the option's real text, so a replay's approved value carries
  the numbering too, and stripping one side made the replay fail to match its own value.
- **A pick-one that reads like a places box.** "Where are you currently based?" was routed to the
  places path, which typed a city and waited out a service that never answers; the widget was a
  three-option list already showing the answer. The live widget now wins over the label's guess, and
  the location route's candidates are tiered (city+state, then country) — which also exposed that a
  profile ladder ARRAY handed to the match ladder throws `s.toLowerCase is not a function`.
- **The option poll SETTLES** (operator: "is there any reason it is hardcoded and not a settle poll?").
  It distinguishes LOADING (server-backed → full ceiling), mounted-but-empty (one confirming read) and
  never-mounted (brief grace), and consults the **quiescence watch ported verbatim from the Workday
  branch** (`77abbdf`) to tell "the menu isn't coming" from "the page is still reacting". My first cut
  used our own read latency, which measures the CDP round trip rather than the page — and it skipped
  three healthy dropdowns. `cdpPainting`/`cdpPaintLabel` came along in the same port, so both pipelines
  now share one implementation instead of two variants.
- **Honest reporting where absence can't be proven:** a paged list (100 of ~3300 schools, narrowed to
  20 near-matches) no longer renders as a complete pick-one, and no longer claims the profile answer
  "isn't one of this form's options" when the form's own search never answered.

Also: the replay keeps the fill's `dial` routing (an approved dial value could never commit as a plain
select), and `[ATS-TIME]` prints the measured paint state next to Chrome's visibility.

Extension **1059/1059**. Every fix was reverted individually to confirm its test fails; two tests that
passed both ways were rewritten until they discriminated (one needed a time-based fake rather than a
read-count one, another an assertion on behaviour rather than outcome).

**Still open:** Greenhouse's `school--0` service is genuinely slow and erratic (390ms → >20s for the
same class of query), so a school field can still reach review honestly flagged; the candidate-location
places service never loads in this browser; and the fetch-assisted tier for the education endpoint (the
Lever-location pattern) is the obvious next step for both.

## 2026-08-05 (b) — breadth: Greenhouse, Lever and Ashby all reach the gate

Four forms, four shapes, each fill → review → approve → rehearse → `WOULD CLICK SUBMIT`, nothing
submitted: GitLab (GH, 23 replayed), Shield AI (Lever, 39), Notion (Ashby, 19) and Coinbase
(employer-hosted GH, 30). Detail: dom-patterns 2026-08-05 (b).

Fixed in this round: a signature date is TODAY on the ATS path too (Lever's answered "As soon as
possible" via the AI after a 19.2s call); a radio persists the option it CHOSE rather than a label
carrying the option's whole description (which no live option could re-match, so the replay failed a
field the fill had verified); the pre-onboard probe follows an employer page's apply LINK, not just an
embedded frame (Coinbase halted in the Workday auth path on a page with no sign-in); and the halt
banner stops telling one-page ATS users about a review page they do not have.

Also: `ats.js` reaches lib.js/fill-driver.js through `atsLib`/`atsFd` — TWO objects, exactly like
`apMatch` — and the SW-literal guard never covered them. It does now, and caught a missing key on its
first run. Extension 1063/1063; web 140/140; typecheck clean.

Remaining: résumé attach (15.2s) and the location widgets (10.6s / 12.2s) are where ATS fill time now
sits; Greenhouse's school service is still slow and erratic; the fetch-assisted tier for the education
endpoint is the next obvious step.

## 2026-08-05 (c) — hidden-tab parity: force the frames, and stop waiting on signals that cannot arrive

Operator: the ATS fill must be fast, and visible/hidden should take similar time — "half a second to
12 seconds resume attach is too big of a gap", then "there is definitely a way to get it to render".
There was. Detail: dom-patterns 2026-08-05 (c).

- **`Page.startScreencast` makes a hidden tab genuinely render** (frames, not a spoof — the paint probe
  reports `painting (hidden)`), which is what no existing lever could do. Capture rate is load-bearing:
  every-frame capture starved the renderer and a `gender` select went from ~1s to 33.4s with NO options;
  at ~1 fps the same field is 72ms. Acked, torn down with the attach, `forceRenderOff` to opt out.
- **The résumé attach was never the upload**: Greenhouse deletes its file input on completion, so the
  confirmation poll could not succeed and always burned 15s. 15.2s → 0.3s in both modes.
- **A places box with no places library** no longer costs the full budget: 10.6s → 6.5s.
- **One field, one budget**: the option ceiling was per poll, so search+retry could spend it twice (44.6s
  on one widget). Also: every record now logs its own elapsed — the résumé branch `continue`d before the
  loop's log, so the most variable field in the run had no line at all.
- Choice AI decisions whose options come from the SCAN (radio / yes-no / checkbox-group) now run
  concurrently; comboboxes stay serial because their prompt needs the live list.

Net on GitLab: no field burns a ceiling any more (was 16.1s / 29.4s / 44.6s outliers), résumé 0.3s, and
review quality identical to a visible run. ⚠ Totals are NOT a clean A/B — that form had been run ~15
times against a rate-limiting board while provider latency drifted 0.8-5.8s per call. A clean
measurement needs a fresh posting per ATS, visible and hidden back-to-back, no reloads in between.

⚠ Footgun recorded for the Workday synthetic-input work: `cdpSynthInput()` decides from
`cdpPainting()`, so enabling render forcing there would flip hidden runs to TRUSTED input (~1.2-1.5s
per event). That decision needs real visibility, not the paint probe.

## 2026-08-07 — the dead first fill, and what it had been hiding

The first fill on a Greenhouse form was dead: location, school and degree sat `loading` to their
ceilings and reached review unanswered, and a refresh always cured it. Everything else was ruled out
first — it held with a VISIBLE painting tab, with trusted clicks, and with trusted keystrokes.

**Cause: our own page overrides, landing mid-life.** They replace `setTimeout`/`setInterval`/`rAF` so
a hidden tab's timers escape throttling, and react-select schedules its search on exactly those.
Installed into an ALREADY-RUNNING document, the page is left half-native/half-ours and those widgets
never resolve again. Only Greenhouse showed it because only Greenhouse serves its form FROM the
posting URL — Lever and Ashby navigate on to `/apply` and `/application`, get a fresh document, and
were never affected. The operator saw the shape before the logs did: *opening the link from the
website always broke location, copy-pasting the same link never did, and reloading always fixed it.*

Fix: an ATS run opens its tab **blank**, attaches, registers the overrides, and only then navigates.
Same single page load as before, just moved to after the install; the submit run gets it for free.
Discord, hidden: a 4.9s dead pass + recovery reload + 53.0s refill became **one 17.2s fill**.

**Then three workarounds could go.** Each existed to survive that bug.

- **Screencast (`Page.startScreencast`)** put a hidden tab under capture so Chrome kept producing
  frames. It worked, and it was treating the same disease less directly. Measured after the real fix,
  tab verifiably dark: Discord **16.9s vs 17.2s** under capture, and Reddit's rehearsal — the run that
  FAILED without forcing on 2026-08-06 — passed its whole gate dark, 23 fields, 0 failures. Removed,
  with the lever documented where it lived. WARNING: you cannot measure this while your own automation
  holds the tab under capture — the paint probe reads `painting (hidden)` with forcing off, and that
  is your tooling, not the product. Confirm `NOT painting` before believing a dark-tab result.
- **The reload-and-refill remedy** cost a second full fill to rediscover the same answer. What remains
  of that signal is the honest kind — a places service that truly does not respond — so the widget is
  NAMED in the log and left for review instead of retried.
- **`atsSkipOverrides` / `forceRenderOff`** were diagnostic flags for this hunt.

Regression, all hidden, no capture: Greenhouse/Discord 18.3s 25 fields, Lever/Zoox 5.5s 17 fields,
Ashby/Sierra 13.8s 35 fields.

### Bugs the tenant sweep then surfaced

- **A stated answer carries its polarity in its leading words.** Ashby/Sierra renders its diversity
  survey as SELECT ALL THAT APPLY — each identity its own checkbox, so the LABEL is an option. The
  profile answers in whole sentences ("No, I do not have a disability"), which matched neither
  `/^(yes|true)$/` nor `/^(no|false)$/`, so two questions the profile ALREADY ANSWERS came back as
  "your profile answer isn't one of this form's options". Leaving the box unchecked IS that answer.
  35 fields, 3 review items to 1.
- **A box labelled "Location" is not always a city box.** ElevenLabs labels one "Location" and
  describes it *"Country you're currently residing in"*. We typed "Pittsburgh", read an empty menu,
  and blamed the places service for 15s. The city now falls through to the remaining candidates (the
  location rung already tiers the country behind the city; a BUCKET routes first and carries one
  value, which is how the field arrived holding only "Pittsburgh, PA"), and those are matched through
  the ordinary ladder — the country tier's wording is routinely LONGER than the option
  ("United States of America" vs "United States"), which the city-containment pick cannot see.
  Same field: 15.5s "didn't respond" to `filled - exact-normalized - "United States"`.
- **…and the places pick got strict about the state** (`atsPlacePick`). The query is the city alone,
  because a service that never heard of "Pittsburgh, PA" answers "Pittsburgh" instantly — but "first
  row containing the city" is not a safe pick when the city is Pittsburgh (PA, CA, TX). It prefers the
  row agreeing on the state in EITHER spelling via `REGION_ABBREV` (Canadian provinces included), and
  when we hold a state no row offers, it still answers but at the flagged tier.
- **"How did you FIRST hear about this role?"** missed the rung's wording, so a REQUIRED question the
  profile answers exactly went to the AI — which answered "LinkedIn" correctly, after an LLM call,
  flagged `ai-choice`, parked in review. One wildcard word is allowed in the middle now. Pinning that
  caught something the OLD wording did too: it ended at the verb, so "How did you find working with
  your last team?" routed here and would have answered an interview question with "LinkedIn".
- **Greenhouse scanned every checkbox twice.** Its general element loop skipped only `hidden`, so each
  box of a group was pushed as a REQUIRED "text" field AND as the real `checkbox_group`. On Gusto's
  12-box select-all, every phantom bought its own LLM call answering "N/A" — 12 of that form's 21
  review items. Worse than noise: writing text to a checkbox sets the value that option would SUBMIT.
  Lever and Ashby always skipped both. 35 fields to 24, 21 review items to 10.
- **A run no longer claims it reported a fill the tracker rejected.** `reportApplication` returned
  nothing, so the ATS run printed "Reported to the website." one line under the loud rejection saying
  it hadn't.
- **A run refreshes the extension's ingest credential before starting.** Minting a key DELETES the
  previous ones, so a later sync silently invalidates what the extension holds — surfacing as a fill
  that never reaches the tracker, or a submit run that 401s and REFUSES (correctly, but it reads as a
  broken run).

### Verified end to end (fill, approve, rehearse, `WOULD CLICK SUBMIT`) — 17 tenants

Greenhouse: GitLab, Coinbase (employer-hosted), Reddit, Discord, Duolingo, Flexport, Gusto, Roblox.
Lever: Shield AI, gopuff, Zoox, Spotify. Ashby: Notion, Cohere, Sierra, ElevenLabs, Linear.

Suite 1088/1088. New skill: `.claude/skills/ats-tenants/` — the ATS dev loop and the debugging rules,
each of which was paid for with a wrong conclusion.

### 2026-08-07 (later) — a second sweep, and four more bugs

Driven by the operator's question "are all the typeaheads reconned with every option?" — which was
worth asking, because the answer was no, for a reason nobody had looked at.

**Does the ATS path need a scroll accumulator? No — and now it is measured, not assumed.** Traced in
the live DOM: Greenhouse's dial `country` holds all **244** entries ("Zimbabwe+263" last) and
`discipline--0` all **72**, unchanged after scrolling to the bottom; `degree--0` 10, EEO selects 3
and 8. Ashby's location combobox opens with **0** options and returns 5 after typing "Pitt" — purely
server-backed, nothing below the fold. Lever renders 4 native `<select>`s and no combobox at all.
Plain react-select puts every option in the menu DOM and CSS-clips it; none of these uses a windowed
list. Workday's `cdpScrapeTaOptions` exists because ITS picker is genuinely virtualized — a real
substrate difference, not a gap in the port.

- **A partial option list is one we TYPED for, not one that is long.** `atsAttachOptions` called any
  list of >= 60 partial, stored 60 and printed "not the full list" — so 244 countries reached review
  as a truncated picker with a note denying what we held. Provenance replaces length: a menu read on
  open is the whole list however long, anything reached by typing is a view of it. The flag is never
  cleared, deliberately — clearing the query restores the whole list on a static widget but only page
  one on a server-backed one, and those are indistinguishable from inside the code. That is what
  keeps the paged-school guard intact (my first attempt cleared it and the regression test caught it).
- **The WHY now travels with the list.** `optionsPartial` was set and never read, so the website
  re-derived partialness from `captured_options.length > 2` — and a server-backed field whose search
  returned one or two rows, the case that most needs explaining, got no explanation. It rides the
  bundle as `options_partial`.
- **A protected characteristic can be asked without naming the dimension.** Chime words its gender
  question "I identify as:" — no "gender", no "sex" — so an AI-guessed protected characteristic wore
  the ordinary `ai-choice` badge while the field directly below it ("I identify my sexual orientation
  as:") got the loud one. The self-identification frame counts on its own now.
- **The posting settle has to be asked over CDP.** Introduced by the install-before-navigate change:
  it reused `waitJobPageSettled`, which reads through host-gated `chrome.scripting`, and the ATS hosts
  are deliberately absent from `host_permissions`. Every ATS run failed on its first read
  ("Cannot access contents of url") and logged a settle that never happened. Over CDP: Lever now
  reports `posting settled after 1245ms — 5697 chars`.
- **A closed posting says so.** Twilio and Binance both halted "form-not-rendered … open the tab and
  check", sending the operator to debug a fill on a job that no longer exists. Lever answers a removed
  posting with the title "Not found"; Greenhouse REDIRECTS to the board index, dropping the job id
  from the URL. `atsPostingGone` reads both and the halt is now `posting-gone`.

**Environment trap worth recording.** Two web-side fixes appeared not to work because **port 3000 was
being served by a DIFFERENT worktree** (`multi-ats`), so this worktree's `web/` was never executing.
The extension is loaded unpacked from here, which is why every extension change took effect and only
the web ones seemed inert — a very confusing signature. This worktree now runs on **3200**
(`NEXT_PUBLIC_SITE_URL` in its gitignored `.env.local`). Also: `AP_SET_SESSION` now logs the HOST it
will report to, because a stale ingest credential is the most common way a healthy fill misses the
tracker and it was completely silent.

**Housekeeping:** the extension opens a tab per run and nothing closed them — 33 had accumulated and
were wedging the browser. `AP_DEV_CLOSE_TABS {urlContains}` per ATS host, after each run, and never
while one is in flight.

**Measured latency, for the next pacing round:** Ashby's location combobox is the slowest field in the
pipeline and it is the WIDGET, not our visibility handling — Speak filled it in 9.6s visible vs 11.8s
hidden, so only ~2s is the trusted wake.

### Verified end to end — 21 tenants

Greenhouse: GitLab, Coinbase (employer-hosted), Reddit, Discord, Duolingo, Flexport, Gusto, Roblox,
Chime. Lever: Shield AI, gopuff, Zoox, Spotify, Sonatype. Ashby: Notion, Cohere, Sierra, ElevenLabs,
Linear, Speak, OpenEvidence.

Also filled clean but not yet through the gate: Veeva, Runway, Mem0, Slingshot AI. Suite 1090/1090.

## 2026-08-06 — one AI call per page, and the stray click that was blamed on Workday

Two threads: making the AI cheaper, and chasing a page-3 failure on waystar that had survived several
rounds. The second one is the lesson.

### The bug: "Workday keeps rewriting our answer"

waystar page 3 filled, then Save was refused because a required dropdown ("Which basecamp location…")
was blank. Traced repeatedly: relocation was committed `"Yes, I am open to relocating"` and later read
`"No, but I live near one of these locations"`; that change remounted the dependent basecamp question
under a NEW automation-id, blank; our record pointed at the dead one.

It was written up as Workday rewriting the value on its own, and **two remedies were built on that
premise** — a reload-and-replay re-entry (live-refuted, removed the same day) and a back-a-page retreat
(never fired once, removed today). Both treated a symptom.

The operator ended it with a rule: **Workday can rarely REMOVE a committed value, but NEVER rewrites one
into a different option.** So a value that CHANGED is ours. That is now in CLAUDE.md as a triage rule,
because it eliminates a whole class of wrong explanation in one line.

The real cause, once we looked for our own write: **every portaled listbox renders at the same screen
coordinates** (every commit on that page logged `rect=463,298`), and the options **linger a beat while
unmounting and stay clickable**. So the next field's open-click landed on the previous field's list —
on the option that happened to sit at that point. `fillDropdownCdp` has gated on options-GONE (not
`aria-expanded`) since 2026-07-06 for exactly this cross-field stray; **the AI commit paths never called
it**, and they are what fill screening questions. One `closeDropdownConfirmed` in three places.

Result on the form that failed reliably: **4/4 clean runs, 2 hidden + 2 visible** — `remount 0 · stalls 0
· drift 0`, page 3 **19.4s → 7.0s**. Not recovered from; absent.

### Batched AI — one call per page

The AI questions on a page are now identified, their options read, and sent as ONE call fired before the
deterministic fill so it overlaps. **Transport only**: each answer goes back to the same per-field
function that would have called the model itself, so the match ladder against LIVE options, the commit,
the read-back, `filled_review` and the EEO re-tag all still happen where they did. The batch is a CACHE,
NOT A GATE — a question it misses makes its own call, so a wrong or empty batch costs speed, never an
answer. Default-on as of today (`disableAiBatch` is the kill-switch).

Answers are cached **by QUESTION, not automation-id**, and shared with the cascade recursion and both
AI-4 re-fill paths, so a page REFILL makes **zero** calls and cannot contradict the first pass —
contradiction was what remounted dependent questions.

Things that had to be fixed to get there, each found by instrumentation rather than reasoning:
- The collector threw on a non-string profile value and **silently collected nothing** — a totally broken
  batch and a working one produce identical output, differing only in speed.
- `resolve()` returns `{candidates}` for a choice widget and `{value}` for text; reading it as a scalar
  produced that throw and mislabelled every mapped text field.
- The planner modelled only `FIELD_MAP`, so bucket- and recognizer-answerable questions were scouted and
  prompted anyway. It now models every deterministic tier.
- An OPTIONAL unmapped textarea **awaited the call and blocked the page 3.56s** before being skipped —
  the batch was consulted before the eligibility gate.
- An AI pick committed via two flat `delayFull(reopenSettleMs)` beats — **800ms/field**, never scaled,
  no polling — while a deterministic pick used the adaptive poll. One shared `awaitDropdownCommit` now.

### Also fixed

- **The self-ID input policy never reached the REPLAY walk** (it lived in `fillAndPersistPage`, which the
  replay only calls for refills), so the replay wrote text/date SYNTHETICALLY on the one surface that
  ignores synthetic writes. Fixing it took **waystar to SUBMIT GATE PASSED** — 7 of 10 tenants.
- **Sign In and Apply presses now escalate the MECHANISM** on retry (coordinate click → focus+Enter →
  password-field Enter → in-page activation) instead of re-issuing the identical click. Confirmed live:
  `sign-in fallback 1 … (the coordinate click did not register)`.
- **A checkbox group cost ~2.5s when nothing was wrong** — the persistence loop never broke early. Now
  exits on a 3-read hold streak at a 250ms beat, which is also *stricter*: the observed wipe lands ~281ms
  after the click, which 700/1400/2100 could straddle and 250/500/750 brackets three times.
- **The cross-run option cache is gone** (operator): a form is filled ONCE in the real flow, so it was
  always cold when it mattered — and it made repeat test runs faster than a genuine first fill,
  distorting every timing measured against it.

### Diagnostics kept, because each one found a bug

`debugPageTrace` (per-field plan-before-acting, every wait named, every action ≥120ms timed),
`debugAiPrompts`, `debugClobber`, plus the always-on `[AI-BATCH]` line and a `⚠ REMOUNT` alarm — the
last always-on deliberately, since a remount should now never happen and a regression you only see when
a flag is enabled is one you find late.

Measured and left alone: the typeahead scroll scrape is at its floor (249 options, 22 hops, 21 of them
committing, ~86ms per commit — the widget's latency, not our pacing), and hidden runs are **within 6% of
visible** on the same scrape, so the non-painting problem is already handled by the worker-timer override.
Earlier page-level hidden/visible gaps were LLM latency variance (1.0s–10.0s across today's runs), not paint.

Extension 1099/1099.

## 2026-08-07 — fresh-account regression + expansion sweep: two onboarding blockers fixed, 4 tenants to the gate

A regression + expansion sweep on a **brand-new tester alias** (`tester+30@gmail.com`), chosen so no
tenant would have a pre-existing account. That turned out to be the point: every failure this sweep was
in the ACCOUNT-CREATION path, which the previous scoreboard had never exercised — its tenants all had
accounts already. Two real blockers, both the same shape, both now fixed.

**1. Stage 2 (Apply Manually) had no activation ladder.** Stage 1 (the Apply click) got one on
2026-08-06 because "the coordinate click can report success and still not register". Stage 2 clicked
once, waited the full render budget, and gave up. Live on `radiancetech.wd12` AND `magna.wd3`: the click
reported success, the chooser never moved for 45s, and the applyStage loop re-issued the IDENTICAL click
two more rounds before halting `backToApply` — ~135s to fail, on a page whose Apply Manually is a plain
`<a href>` that navigates fine when activated in-page. The stuck page is diagnosable: every read logged
`markers [adventureButton, applyManually, useMyLastApplication]`, and a cleanly-loaded chooser does NOT
carry `adventureButton` — the two are mutually exclusive on any healthy page, so together they mean the
SPA swapped views without tearing the old one down. Stage 2 now mirrors Stage 1 (4s → focus+Enter →
in-page activation → render budget), plus a shortcut when the pure `applyChainStuckMixed` recognises that
state. Unit-pinned, and verified to discriminate: the naive marker-only check fails the guard test.

**2. The account-creation consent tick was a single blind coordinate click.** It measured the label, fired
one click, logged whatever it then found, and carried on. When the click missed, the box stayed unchecked,
Create Account could not submit, and the auth loop spent **~12 minutes** re-clicking a button that was
never going to fire. Diagnosed on the live page rather than guessed: the input is `opacity:0` with a 56×20
"I agree" `<label for>`, the finder resolves it correctly, and `elementFromPoint` at the computed centre
returns that very label — so the rect was right when MEASURED and wrong when USED. **A stale rect**: read
one CDP round-trip before the click was dispatched (~1.2–1.5s hidden), while the just-filled password
fields' requirement list reflows the label out from under it. Exactly the lesson `clickPageNext` learned on
2026-07-25. Now: re-measure before every attempt, re-read `checked` after every attempt, escalate to
in-page native label activation. It NEVER halts (operator's call) — if everything fails it says so and lets
the submit report the failure. Live log: `consent checkbox — checked via in-page label activation (the
coordinate click was not registering)`.

**3. Diagnostic — the auth page's own error is now logged.** "Create Account submit: no outcome after 20s
and the form is still up" read identically whether the click never registered or Workday rejected the
submission, which cost a round. `cdpOnboardScan` now collects up to 6 short RENDERED leaf-ish error nodes
into `authErrors`, and `describeState` appends `pageErrors=[...]` to the dump it already prints.

**Results.** `itron.wd5` (NEW) and `magna.wd3` (path-hosted) reached **SUBMIT GATE PASSED** hidden, on a
fresh account, nothing submitted. `waystar.wd1`, `cat.wd5` and `radiancetech.wd12` (NEW) all reached the
REVIEW page. Extension **1104/1104**.

**The dominant remaining blocker is the self-ID disability checkbox group**, now reproduced on THREE
tenants (waystar, radiancetech, and itron on a second pass into the saved application). Two distinct
shapes: waystar's bundle HAS the entry and the replay cannot make it stick (`asked for [No, I do not have
a disability…] and it holds []`), while radiancetech/itron report `the approved bundle has no entry for [Please
check one of the boxes below] on this page`. Consistent with the traced note that Workday does not persist
some self-ID answers across re-entry.

**Two testing facts worth keeping.** (a) Email auto-verify can never work with a `tester+NN@gmail.com`
alias — the connected mailbox is `wangykev@gmail.com`, so `tester+NN` is a DIFFERENT inbox; an
email-verify tenant needs `wangykev+NN@gmail.com`. This silently blocked `analogdevices.wd1` and
`jabil.wd5`. (b) Polling the localhost tab with `javascript_tool` ACTIVATES it, so a run launched
`background:false` logs `tab HIDDEN` — a "visible" run must be left alone while it works.

## 2026-08-07 (later) — the self-ID disability blocker was a COLON

Same-day follow-up to the sweep above. The blocker that had been open across several sessions and was
written up as *"the disability checkbox unchecks itself"* is a one-character string mismatch in OUR code.

**What Workday does** (real, and not the bug): re-entering a SAVED application drops the disability
answer, while its siblings on the same page keep theirs. The `[FIELD-DIAG]` dump says it plainly —
`disabilityForm "English"* · name "Kevin Wang"* · employeeId "" · dateSignedOn "08/07/2026"* ·
disabilityStatus ""*`. Consistent with the earlier `workday-selfid-not-persisted` trace.

**What we did wrong**: `parseErrorFieldName` strips a trailing `:` off the name it extracts (its
trailing-char class includes it); `normalizeLabel` strips only `*` and whitespace. So for a field whose
visible label ENDS IN A COLON the two sides can never be equal:

```
error  "…The field Please check one of the boxes below is required" → "please check one of the boxes below"
label  "Please check one of the boxes below:*"                      → "please check one of the boxes below:"
```

Every strict-equality error→field matcher therefore found nothing, on the one page where it mattered:
the force-re-fill reported *"the approved bundle has no entry for [Please check one of the boxes below]"*
and the phantom-required guard reported *"which match no field on this page"* — both while
`disabilityStatus` sat right there, required, empty, with an approved value in the bundle. The walk
halted having done nothing.

**Reproduced deterministically, not inferred.** `analogdevices.wd1` passed rehearsal #1
(`SUBMIT GATE PASSED`) and failed #2 with exactly this; `itron.wd5` did the same; `radiancetech.wd12`
matches. That pass-then-fail pattern is the tell: the recovery path only runs once Workday has dropped
the value, which only happens on a RE-ENTRY.

**Fix**: `errorLabelKey` (lib.js, pure) — normalize, then strip any trailing run of `*`, `:`, `;`, `.`,
`,` and dashes in any order — used by the three strict matchers (`phantomRequiredTargets`,
`requiredBlankByLabel`, and the replay's force-re-fill site). Deliberately NOT folded into
`normalizeLabel`, which is LOCKSTEP with the website's `normalizeQuestion` for answer-bucket matching;
widening that would change which taught wordings match on both sides. Error→field matching is a
different job, and a loose match there is already documented as safe.

**Verified**: the identical rehearsal that failed twice now logs
`page 5: FORCE-re-filling 1 error-named field(s) [disabilityStatus]` → `✅✅✅ SUBMIT GATE PASSED`, twice
in a row. Unit-pinned on the VERBATIM live strings and verified to discriminate (reverting
`errorLabelKey` to `normalizeLabel` fails 4 of the new tests). Extension **1110/1110**.

**Still open — a DIFFERENT shape on waystar.wd1.** There the *initial* replay's own verify fails
(`asked for [No, I do not have a disability…] and it holds []`) and halts `replay-mismatch` BEFORE any
error text exists, so this fix cannot reach it. That is an actuation failure on the checkbox group, not
an error-matching one, and it needs its own round — likely the same mechanism-escalation medicine the
Apply and consent clicks just got.

## 2026-08-07 (later still) — waystar's self-ID variant: synthetic clicks, then a stale signature date

Chasing the one shape the colon fix could not reach turned up TWO more faults, stacked on the same page.
Both were found by reading the replay's own log rather than by theorising, and each was confirmed by a
controlled change before being kept.

**1. Synthetic CLICKS don't reach Workday's model on the self-ID page.** Text/date went trusted here on
2026-08-06; clicks were left synthetic on the strength of a 2026-08-05 fill-path note ("committed and
held 2/2 under synthetic; trusted clicks produce the intermittent did-not-commit"). Every ADI rehearsal
refuted that, identically:

```
page 5 replay: 5 field(s) — 3 changed, 1 already-correct, 1 not-actuated, 0 FAILED
page 5 Save & Continue: {"clicked":true}
re-click fallback: error text present — NOT re-clicking (a real validation block)
```

Our read-back says the box IS checked; Workday says that field is required. The force-re-fill then
re-wrote the SAME field with TRUSTED input and the page advanced — every time — which is a repeated
demonstration that trusted clicks DO commit here. So the whole page now goes trusted on the replay,
clicks included. Controlled result on the run that always hit the block: **force-re-fills 0, validation
blocks 0, page 5 advances on the FIRST Save** — one Save cycle cheaper, and the only thing that can reach
waystar's variant, where the synthetic click didn't even update the DOM (`asked for […] and it holds []`)
and so failed the strict verify BEFORE any error text existed for the force-re-fill to key on.

**2. A signature date goes stale overnight.** With page 5 finally advancing, waystar surfaced
`Error-Date "Enter today's date"` — the bundle was approved 08/06 and replayed on 08/07. The fill path
already stamps a signature date deterministically (`isSignatureDateQuestion`); the REPLAY wrote back the
stored literal. This also explains why ADI passed the same page all along: its bundle was filled the SAME
day. **A one-day-old approval is enough**, which makes it a guaranteed failure for any review not
submitted the day it was filled — the normal case. `replayField` now re-derives it to today.

**2b. And the reconcile had to move with it.** Fixing only the replay traded a nav-timeout for a submit
block: `≠ "Date*": approved "8/6/2026" but the page shows "08/07/2026"`. `reconcileReviewPage` now
compares a signature date against today too. Both stay narrow — `isSignatureDateQuestion` rejects any
label naming a different event — and both stay strict: a page showing any date other than today still
disagrees.

**waystar.wd1 now passes**: `page 5 → advanced` · `AGREE 41 · DISAGREE 0` · `✅✅✅ SUBMIT GATE PASSED`.
Extension **1117/1117**. One test-writing note worth keeping: the first draft of the reconcile tests
passed for the WRONG reason — every row landed in `missing_on_review` because the fixture used the wrong
argument shape — so they now assert `tier === "keyed"` to prove they exercise the real compare.

## 2026-08-07 (d) — SKILLS: the multi-value typeahead, built from a hand trace

`Type to Add Skills` has been `skipped: no mapping` since 2026-06-04 — the last always-empty field on
page 2. The plan on the books was "a repeat-commit loop around `fillTypeaheadCdp`". The trace says that
would have been wrong in a way unit tests could never have caught, so the trace came first: page 2 of a
real Solar Turbines draft (`cat.wd5`), driven by hand in the operator's own session, reading the DOM
after every keystroke. Full observation record: dom-patterns 2026-08-07.

**What the widget actually does.** It does not live-filter (ENTER is the filter trigger, banner "Search
Results"); the input only GAINS `data-automation-id="searchBox"` once opened; the open list is
"No Items." so there is nothing to start-scrape; a commit ADDS a chip and leaves the list open with the
query intact, so N skills go in on one open; Tab-blur exits clean. A synthetic pointer-sequence click
commits fine here — no trusted input needed.

**Three findings changed the design.**

**1. The taxonomy renames, so exact-only would have filled almost nothing.** "Python" is offered ONLY as
`Python (Programming Language)`; "Docker" is offered as BOTH `Docker` and `Docker (Software)`. That
trailing parenthetical is Workday's own qualifier — the same shape `normalize()` already strips off a
dial code `(+1)` — hence `skillBaseName` and a "qualified" match tier, with a bare exact winning so
"Docker" never resolves to "Docker (Software)".

**2. The search is server-side FUZZY, so its results are NOT candidates.** `Yosys` → **Yodiz**;
`ODrive` → **Top Drive**; even `zzqqxwvj` → `z/VM`. All under the same "Search Results" banner as a real
hit. Containment and Levenshtein would each have committed one of those onto an application, which is the
precise failure this project's match ladder exists to prevent — so this field allows exact/qualified only,
ambiguity-guarded, and a skill Workday doesn't know stays OFF the form and is NAMED for the human. No AI:
it is optional, and guessing a demonstrated-bad row is worse than a blank.

**3. A dirty search box FABRICATES a skill.** A zero-result query + Enter makes Workday add the typed text
as a brand-new skill. Mid-trace a `ctrl+a` that didn't land meant the next skill appended to the old
query, and Enter created the chip **"DockerCubeMars motor drivers"** — a skill nobody claimed. On every
other typeahead a dirty box merely wastes a candidate; here it writes a wrong answer. So the clear is a
HARD GATE: unverified-empty ⇒ the field stops rather than press Enter. (That same behaviour is also the
only way an off-taxonomy skill lands verbatim, and it is accepted when the new chip IS what we typed —
Workday completed it, we didn't guess it.)

**And one that makes a re-fill safe.** An already-selected skill DISAPPEARS from its own later results:
with `Docker` committed, re-searching it offered only `Docker (Software)` and `Dockerfile`. So a re-fill
that didn't dedup would commit a near-duplicate — `missingSkills` compares BASE names in both directions
(a `Python (Programming Language)` chip covers the profile's "Python"), all-present is zero actuation, and
the replay is idempotent by construction.

**Shipped.** `skillBaseName`/`matchSkillOption`/`missingSkills` (lib.js, mirrored into the SW `apMatch`
literal — the lockstep guard caught this one immediately, for a comment containing `field:` that its
literal parser read as a key), `isSkillsField` + `fillSkillsCdp` (fill-driver.js), routed in
`drivePageFill`'s flat loop and in `replayField` (splitting the approved `"A; B; C"` back apart, ABOVE
skip-if-correct so chip order can't read as a mismatch). Each commit is verified as chip-set GROWTH plus
identity of the new chip; `skillsMaxAdds`/`skillsBudgetMs` bound a cost that scales with the profile
(~2–4s/skill), and whatever they drop is named rather than silently trimmed.

### Live verification, and the three things it changed

Six runs on the same Solar Turbines draft. **Visible worked first time** — 7 of 24 added, with the
qualified tier firing exactly as designed (`C → C (Programming Language)`, `Python → Python (Programming
Language)`, `Java → Java (Programming Language)`) — and `slowest: skills 33s`, so this field dominates
page 2 and always will. Then three defects the fake could never have shown:

**1. A single transient clear failure abandoned the rest of the list.** The visible run added 7 and quit;
Git, Docker, VS Code and Vivado were all still to come and all exist in the taxonomy. The clear is
focus-blind (trusted Ctrl+A/Delete) and on this widget Ctrl+A does not even select the input's text. Now a
React-safe native-setter clear goes first, a failure RETRIES, and only a SECOND consecutive failure ends
the field — and a skipped skill is reported as an infra failure, never as "Workday doesn't have it".

**2. The hidden failure was NOT what it looked like, and the wrong fix nearly shipped.** A hidden run added
ZERO skills, logging `{focused:true, ok:true, openedNow:false}` three times per skill; the byte-identical
run under `forceTrustedInput` opened and searched fine. That is the exact signature of the auth-form /
Self-Identify class ("this surface needs trusted events"), so trusted input was scoped to the field — and
it did NOT help (the log proved the switch ran: "synthetic input ENABLED" appeared twice, once at run start
and once for the restore). The real cause was the OPENER: it fired BOTH routes in one attempt, so the
coordinate click landed before the searchBox mounted and a second click TOGGLES a multiselect shut — the
same toggle-shut invariant the unified typeahead filler already documents. One settle beat plus alternating
routes across retries fixed it, and **an isolation probe with the trusted scoping removed then filled the
field normally on a hidden synthetic tab**: 13 candidates processed, adding `JavaScript`,
`Altium Designer`, `Git`, `Docker (Software)`, then `RViz`, `Fusion 360`, `Yosys`. The trusted path was
deleted (it doubles the field's wall-clock for nothing) and the call site now says so, so nobody re-adds it
off the back of the same misleading symptom.

**3. A readable trace matters.** The step key was `skill`, but the walk's settle-trace printer reads
`candidate`, so every line logged `cand "undefined"` — the diagnostic was there and useless. Renamed, and
each step now carries the printer's fields (`settleMs`/`count`/`banner`/`open`/`chips`) plus the open
diagnostic, which is how cause 2 was finally attributed instead of guessed at a fourth time.

**Two honest limits.** Coverage varies RUN TO RUN because the result set is a ranked top-7 (`Yosys` matched
on one run, not the previous). And strictness costs coverage: a skill whose only offered row is a
differently-named relative (`Vivado` against `Xilinx Vivado`) is left OFF rather than guessed — named in
the record for the human. That is the intended trade, not a gap.

**4. The opener was DELETING skills, and our own diagnostic caught it.** `Git` was on the form after one run
and gone after the next — in the run that logged `cand "C++" → autocommit, 0 options`, i.e. the chip-set
change test firing on a REMOVAL. `openHier` clicks the centre of `multiselectInputContainer`, which on a
multi-value widget grows with every chip until its centre sits on a CHIP, whose delete X is a child. The
coordinate route now aims at the INPUT's own rect. Both routes are still required: a run with only the
page-side focus+click opened nothing (1 candidate, `needs_review`), so the trusted coordinate click is the
reliable opener — it just has to be aimed at something that isn't a chip.

**Converged**, hidden and synthetic: 11 remaining candidates attempted, `ROS 2` and `Git` added, nothing
lost, `[filled]` — **15 of the profile's 24 skills on the form**. The nine that stay off (`C++`, `HTML/CSS`,
`CAN`, `ODrive`, `CubeMars motor drivers`, `rqt`, `PCB design`, `VS Code`, `Vivado`) have no exact-or-
qualified row on this tenant and are named in the record for the human.

## 2026-08-08 — Autofill-with-Resume end to end, and the two writes that were never approved

Two operator bug reports, both traced to US writing values the human never approved, and both fixed and
live-verified on cat.wd5 in one sitting.

**1. The phantom "required" errors were a missing BLUR.** Workday refused Save & Continue with
`Error-To / Error-From / The field is required` and `Invalid LinkedIn URL` on a page that visibly HELD
all of those values. Operator: *"all I did to manually fix it is to click into and then click out of the
box."* Clicking out is a blur, and neither `fillDateCompositeCdp` nor `fillTextCdp` ever issued one —
they typed, read back, and moved on. Several Workday inputs hand their value to the form model (and run
validation) on blur, so a field we typed and never LEFT reads correct in the DOM and is unset as far as
Workday is concerned. Both fillers now blur after the read-back verify.

*Why it surfaced with Autofill-with-Resume and never with Apply Manually:* on a blank form we fill
several fields per entry, so the next field's click incidentally blurs the previous one. On an autofilled
form Workday has already populated most of an entry, so we often touch a single field — and nothing ever
blurs it. Same code, different exposure. Verified: the page that halted the previous run advanced with
only the blur added.

**2. The replay INVENTED a signature date, and that write cascaded.** Operator: *"reherse filled out the
date when it was not approved in the review summary. and then when date gets filled, name and disability
checkbox becomes required so it failed."* Exactly right. `replayField` re-derived any signature date to
TODAY on every replay (a 2026-08-07 fix for Workday's "Enter today's date" on a day-old bundle), but it
overrode `current_value` unconditionally — including onto a date the human had left BLANK. On the Self
Identify page that write CASCADES: Name and the disability group become required, neither has an approved
answer, and the rehearse halts on two questions the human never saw.

New rule, the operator's: **the replay always follows the review page.** Today's date is written only
REACTIVELY — when Save & Continue actually returns "Enter today's date", the walk stamps that page's
signature-date field and re-clicks once (bounded per run, refuses to guess if no signature-date field is
on the page). The old tests were updated to the new rule rather than deleted, plus a new pin for the
exact live failure: an UNAPPROVED (blank) signature date must be left alone.

**Verified end to end** on a clean bundle: fill reached REVIEW after 5 pages via `/apply/autofillWithResume`
→ approved `3 / 3 flagged` → rehearse replayed every page and reached the submit gate, with page 5 reading

    page 5: 4 approved entries NOT actuated (left as-is): name (cleared), employeeId (cleared),
            dateSignedOn (cleared), disabilityStatus (cleared)
    ✓ page 5 → advanced.
    review page vs approved: AGREE 47 · DISAGREE 0 · MISSING 3 · EXTRA 1 · AMBIGUOUS 0

The date was left alone, the self-ID fields stayed blank, nothing cascaded, and the reconcile is clean.

**The gate then blocked for an HONEST reason, not a regression:** the website rows deleted to clear
Workday's phantom-duplicate error did not come back on the review page, so submitting would file the
application without them (`phantomLost`). That is the retention premise being CHECKED rather than assumed
— the same URL-loss issue already recorded for clearwater, now reproduced on cat.wd5.

**Still open from the autofill flow:** the parse leaves repeating entries we do not own (an education
entry that was entirely EMPTY blocked a page), and it writes `linkedInAccount`, which we skip as unmapped
and therefore never validate — Workday rejected its own value. Both need the section reconcile to clean
up after the parse, not just fill what is empty.

### The CONTAINMENT tier (operator decision, same day)

"Accept the containment match for skills so Vivado lands too." Added as the LAST tier in
`matchSkillOption` — a **skills-only** exception to the standing "containment is a guess" rule, which
CLAUDE.md's match-ladder section now records explicitly rather than leaving the code and the doc
contradicting each other.

The guards are not caution for its own sake; each one fired on the verifying run:

- **Whole-word, never raw substring.** `includes` would match `Git` inside "Di**git**al" and `CAN` inside
  "**Can**adian".
- **Distinctiveness** (multi-word, or a lone token ≥5 chars). On that very run `CAN` was offered
  **"Can Openers"** — a genuine whole-word hit. This gate is all that kept it off the application.
- **Ranking tie-break.** The first attempt REFUSED `Vivado` (`containment match was ambiguous (2+ options)`)
  because Workday offers both `Xilinx Vivado` and `Vivado HLS` — so the tie now breaks on Workday's own
  first result, with the alternatives carried into the review so a human can switch.

Every widened commit is `filled_review` + `skills-containment`, detail
`Vivado → Xilinx Vivado (broader; Workday also offered Vivado HLS)`. `missingSkills` also treats a BROADER
chip as covering the profile name, or the next pass would re-search `Vivado`, find the selected row hidden,
and widen onto `Vivado HLS` alongside it.

**18 of 24 now land** (`Xilinx Vivado` and `PCB design` via containment; `rqt` via Workday's free-text add).
The six refusals — `C++`, `HTML/CSS`, `CAN`, `ODrive`, `CubeMars motor drivers`, `VS Code` — are all
correct: the offered rows are different skills. Per-skill evidence table: dom-patterns 2026-08-07 (c).

Extension **1147/1148** (`test/skills.test.js`, 36 pins; the one failure is `db.test.js` — `fake-indexeddb`
is missing from this worktree's `node_modules`, unrelated and pre-existing). One operator call still open:
whether a partial fill should nag review or just name the absent skills in the detail (current behaviour).

## 2026-08-07 (e) — the flow a first application should take: AUTOFILL WITH RESUME

Operator's manual finding, which reframes the skills work: a first application should click **Autofill with
Resume**, so Workday parses the résumé and seeds the form — including the Skills section — and the fill then
refills it as if blank. Traced, built and live-verified the same day; DOM detail in dom-patterns 2026-08-07 (d).

**Onboarding.** `runCdpOnboard` gained `preferResumeAutofill`, set only by `AP_RUN_APPLICATION`. Stage 2
now chooses `autofillWithResume` over `applyManually` for a fill run; a REHEARSE/SUBMIT run deliberately
keeps manual/continue so saved skills survive and the résumé is not re-parsed. The flow inserts a RÉSUMÉ
page before My Information, which onboarding consumes with the existing `attachResume` (same ids) and a
Continue click. Two things had to be got right:

- **`isPastAuth` had to exclude it.** The page reports one bare `formField-` wrapper, so the past-auth test
  called it "the form".
- **The wait had to be generous.** At 6s the upload input had not mounted, so onboarding timed out and the
  WALK adopted the page — attaching the résumé itself and writing a junk 1-field bundle page. Nothing
  broke, but the résumé page is pre-form. Now render-budgeted, and the log reads
  `résumé page done — Workday parsed it; the next page has 14 field(s)`.

**The parse is a bonus layer, not a substitute.** Live it filled name/country/phone and left the entire
address, `source`, and `candidateIsPreviousWorker` empty — Workday refused Save & Continue on the last one.
A method note worth keeping: reading a radio group's `input.value` gives `"true"`/`"false"` as an
ATTRIBUTE and a checkbox's gives `"on"`, regardless of selection. Reading those as state made the parse
look like it had answered both fields when it had answered neither, and I reported that before catching it.
Read `.checked`.

**Skills policy, per the operator's spec.** New `profile.fill_all_skills` (a checkbox on the profile, with
the warning that it makes each application noticeably longer). OFF (default) ⇒ keep Workday's suggestions,
add nothing, record the list for the review page. ON ⇒ add every profile skill the taxonomy accepts on top.
A replay always passes `fillAll:true` — it reproduces an approved list rather than re-deciding policy. The
setting is excluded from teach's default-wording seeding (`NON_ANSWER_FIELDS`), since no form asks it.

**And a fix that cascaded from a fix.** Parsed chips read back annotated (`Computer Hardware (Suggested)`),
which Workday's review page does not print — so `skillChipName` strips it wherever a chip becomes a value.
That immediately flagged a correctly-kept field `skills:audit-mismatch` on a live run, because the M40
audit re-reads the RAW chips: cleaning one side is worse than cleaning neither. `auditActualFromRaw` now
cleans too, and the next run read `audit: re-read 26 filled field(s) — all matched the report`.

**Verified live** on three fresh cat.wd5 postings: `Stage 2 — clicking "Autofill with Resume"` → résumé
page consumed by onboarding → 15 suggested skills kept (`kept the 15 skill(s) Workday suggested from the
résumé — "try to fill all skills" is off`) → `✓✓ reached the REVIEW page after 5 page(s)`.

Extension **1153/1154** (42 skills pins; `db.test.js` still fails on the missing `fake-indexeddb`). Web
typecheck clean; the worktree's web VITEST cannot run at all (`Cannot find package '@/lib/job-key'` — the
same broken `node_modules`), so the 4 web files are typecheck-verified only. NOT yet verified: the review
page's rendering of the kept skills (the tracker push 401'd — the site session expired mid-session), and
the rehearse path's manual/continue re-entry.

## 2026-08-09 — live sweep: marvell + moog verified, four fixes

Continued the live regression/expansion sweep. Every run a fill or a rehearsal
(`arm:false`); nothing was ever submitted.

**Verified live to SUBMIT GATE PASSED (rehearsed twice each, hidden):**
- **marvell.wd1** — AGREE 31 · DISAGREE 0 · MISSING 1 (`Language*`, the known
  informational case: Workday's summary doesn't render it).
- **moog.wd5** — NEW tenant, clean first fill (5 pages, 65 fields, 8 flagged),
  AGREE 44 · DISAGREE 0.

**Not verified, with the reason:**
- **sonos.wd1** — the requisition is GONE (Workday's not-found page). Not a code
  failure; see fix 3.
- **hp.wd5** — reaches sign-in and requires Gmail email verification, which timed
  out (120s). Skipped per the operator's standing instruction.

### Fixes

1. **The apMatch lockstep guard did not scan background.js.** It pins that every
   `apMatch.X` call is present in the SW's hand-written literal — the check Node
   can never do, since it takes the `require()` branch. It only read
   fill-driver.js, so background.js had exactly the hole the test exists to close:
   a call to `apMatch.parseErrorFieldName` passed 1185/1185 and aborted the live
   replay with "is not a function". Both callers scanned now; the message names
   the offending file.

2. **Workday has a second wording for "the signature date is required."** The
   replay may write one unapproved value — today's date — and only when asked. The
   ask was matched as the literal "Enter today's date"; marvell page 5 says "The
   field Date is required and must have a value", so nothing fired and the
   rehearsal halted `replay-blocked`.

   The diagnostic is what mattered: the wrapper already held the value (`current
   value is 8/9/2026`, React props AND fiber set). Workday re-renders the date from
   its saved copy but has dropped it server-side — the same self-ID class as the
   disability checkbox — so the page displays an answer the model does not have,
   and `skipIfCorrect` reads the screen and actuates nothing. `signatureDateDemanded`
   therefore does NOT require the field to be blank: blankness is the one piece of
   evidence this failure destroys, and requiring it would have been the obvious
   guard that missed every real occurrence. It requires instead that the field is a
   signature-date question and that Workday named it.

3. **A posting that no longer exists now says so.** sonos's job URL renders
   Workday's not-found shell in 132 characters. Nothing is wrong with the extension
   there, but with no Apply button the run walked on to the auth wait and halted
   "the sign-in fields never appeared" — which reads as a sign-in bug on a tenant
   that signs in fine, and cost exactly that detour. Now `job-posting-not-found`
   in ~2s.

4. **The social-login chooser is matched by text.** Some tenants put the email form
   behind "Sign in with email" beside federated Apple/Google buttons; that shape was
   handled but keyed to one automation-id, and sonos hashes it. Detector and click
   fall back to the button's text (the click stamps an attribute, since clickTarget
   takes a selector). Unit-pinned but NOT live-exercised — sonos's posting is dead
   either way.

5. **job_key: requisition ids that separate letters from digits.** A job must key
   identically from its posting URL and its form URL, because the fill stores the
   bundle under one and the submit run looks it up by the other. The form URL adds
   an `en-US/` segment and percent-encodes the location, so the path fallback can't
   do it. Moog's id is `R-26-18835` — a separator where both req tiers wanted a
   digit — so every tier missed and the rehearsal REFUSED its own approved bundle.
   HP's `_3167270-1` failed the numeric tier the same way. Both tiers allow one
   separator now; existing keys are byte-identical (regression-pinned on marvell,
   `_R438146`, `JR109393`). Lockstep with `web/lib/job-key.ts`.

### Still open
- The signature-date stamp is unit-pinned but has not been observed firing live —
  the marvell block is intermittent and has not recurred since.
- `web/` vitest fails to resolve its `@/lib/*` alias for 7 suites. Verified
  identical with all changes stashed: pre-existing, unrelated.
- Suite 1189/1189; web typecheck clean.

## 2026-08-09 (b) — the non-Workday merge did NOT regress Workday

Pulled the ATS branch (45 commits, `e84102e`) into the Workday worktree. It touches shared files —
`cdp.js`, `background.js`, `lib.js`, `fill-driver.js` — so the Workday path needed re-verifying rather
than assuming.

**Suite 1234/1234** (was 1188; the merge brought 46 tests, none broken). All five of my sweep commits
survived, and the merge extended the same `apMatch` lockstep guard to `ats.js`/`atsLib`/`atsFd` — the
class the guard was widened for that morning.

**The biggest risk turned out not to be live.** `5eec8a9` put a hidden tab under `Page.startScreencast`
to force frames, which would have changed hidden-tab behaviour for every Workday run; `ac76366` then
dropped it again, leaving only the comment explaining the measurement. `cdp.js`'s remaining changes are
additive to the `act` interface (`trustedType`, `trustedFocus`, `painting`, `paintLabel`, `quietInstall`,
`quietRead`), so nothing the Workday path already called changed shape.

**Live, on the merged build (`post-ats-merge-1`), hidden, nothing submitted:**
- **moog.wd5** — SUBMIT GATE PASSED, AGREE 44 · DISAGREE 0 · MISSING 1 · EXTRA 1 — byte-identical to
  the pre-merge run.
- **marvell.wd1** — SUBMIT GATE PASSED, AGREE 31 · DISAGREE 0 · MISSING 1 · EXTRA 1 — also identical.

### The one failure, and why it isn't the merge

Marvell's FIRST rehearsal on the merged build halted `replay-mismatch`:

    • disabilityStatus [checkbox_group] needs_review — the form did not accept the approved selection
      — asked for [No, I do not have a disability and have not had one in the past] and it holds []

That run hit Workday's transient "Something went wrong / please refresh", so the replay reloaded and
restarted from page 1 (the 2026-07-27 guard, working as designed). The immediate re-run, same code, had
no soft error and passed with `0 FAILED` on page 5.

This is the known disability-checkbox blocker, and the pairing sharpens it: **a reload+restart IS a
re-entry**, and re-entry is precisely when Workday serves self-ID answers back empty (dom-patterns
2026-08-04 (b)). So the suspect is the re-entry, not the click — which also explains why no
settle-before-clicking gate ever helped. If it holds, the reload path needs its own self-ID re-assert on
the way back through page 5, and the fix does NOT belong in `fillCheckboxGroupCdp`, whose click verified
fine on both runs. ONE observation each way, so: a correlation to test, not a cause.

The halt itself is correct behaviour — it refused to advance rather than submit an application whose
approved disability answer had not taken.

**Not re-verified by me:** the ATS path itself (Greenhouse/Lever/Ashby). That is the merged branch's own
work and its commits claim all three reach the gate; this entry only covers Workday.

## 2026-08-09 (c) — hidden fill: the résumé junk page is real; the slowness is the overwrite ladder

Operator: "try the runs hidden, I think sometimes the apply with resume doesn't work when hidden."
Autofill-with-Resume is a FILL-run path only (`preferResumeAutofill` is set by `AP_RUN_APPLICATION`), so
no rehearsal exercises it. One hidden `Background fill` on moog.wd5, merged build:

**1. The résumé page is NOT being consumed by onboarding — CONFIRMED.** Workday sent the
Autofill-with-Resume click to the SIGN IN screen; after auth the résumé page came back and the WALK
processed it, writing the junk bundle page CLAUDE.md predicts:

    Summary saved (accumulated) — page ".../apply/autofillWithResume|": +1 field(s)

The key's field-set half is EMPTY (`|` with nothing after) — the one bare `formField-` wrapper that makes
`isPastAuth` call the résumé page "the form". The résumé itself attached fine
(`resume: attached "Kevin's Hardware Resume.pdf"`), and the run completed and reported, so this is bundle
pollution rather than a failed upload. Not yet checked: whether that 1-field page survives into the
approved bundle and what the replay does with it.

**2. The 4-minute hidden run was NOT the résumé, the AI, or throttling.** Total 318s vs ~75s for the same
job pre-merge. Exactly one gap, 236s, and `[CDP-TIME]` attributes it:

    pacing hidden-fast (worker timers) | NOT painting | settle 4.2s | fill 236.1s (flat 225.7s)

Ruled out by evidence rather than guess: pacing was hidden-FAST, so the worker-timer overrides were
installed and this is not the ~1Hz path; `[AI-BATCH] 0 candidate(s) · NOT fired (needs 2+)` and the one
LLM call returned in 4958ms; settle was 4.2s.

The cause is the interaction of two existing behaviours. Workday soft-errored on page 2, so the walk
reloaded and restarted from page 1 (the 2026-07-22 guard). On that second pass every field is ALREADY
FILLED, so each commit is an OVERWRITE and pays the escalating beat ladder (120 → 700 → 5000ms with a
re-open per tier) instead of the single fast commit an empty field gets — the first pass over the same
page was `fill 0.7s`. ~12s/field × 19 fields. Hidden makes it worse because the option-click debounce is
a PAINT thing (~700ms when not painting), which is why the ladder starts higher there.

So: correct, just expensive. Worth considering whether the post-reload pass can skip fields whose live
value already equals what we would write (the replay's `skipIfCorrect`, which the FILL walk does not have).

**Also seen:** moog soft-errors often right now — 3 of the last 5 runs, on both fill and replay.

## 2026-08-09 (d) — the résumé junk page: fixed, unit-guarded, NOT yet live-exercised

Cause found by reading the log rather than the code: the run never printed
`"reached the application form."` — it printed `sign-in outcome: success.` and went straight to the walk.
`runCdpOnboard` has TWO post-auth "reached the form" exits and only one consumed Workday's résumé-upload
page. The Autofill-with-Resume → bounced-to-SIGN-IN path lands on the other one (background.js:7508),
which returned `reached_form: true` immediately.

So onboarding announced the form while sitting on the upload page, the walk took that page as page 1, and
wrote a bundle page keyed on an EMPTY field set (`".../apply/autofillWithResume|": +1 field(s)`) — the one
bare `formField-` wrapper `isPastAuth` excludes for exactly this reason. The résumé uploaded fine and the
run completed, so the damage is bundle pollution, not a failed attach.

The fix mirrors the sibling exit verbatim, including the bounce case (`needsAuth` re-enters the auth loop
rather than announcing a form we are not on), and returns `resume_autofilled`, which this exit dropped.

**Guarded structurally, not behaviourally** — "two exits and one of them forgets" is precisely the bug a
test on either exit alone passes. Every post-auth `reached_form` exit must have an `onResumeUploadPage`
consult above it; verified to FAIL before the fix, naming `background.js:7508`. Suite 1236/1236.

**LIVE-VERIFIED on the signed-OUT path (moog.wd5, hidden).** The first post-fix run took
`"Continue Application (returning user)"` — signed in, application already open — so the Autofill path
never ran and its clean bundle proved nothing. The operator signed the account out, which is what puts
Workday back on the Apply chooser; the re-run then exercised the exact broken branch:

    Stage 2 — clicking "Autofill with Resume"
    Workday sent the Autofill-with-Resume click to the SIGN IN screen — handing back to the auth stage
    Stage 3 — auth screen detected                     [signs in]
    uploading the résumé for Workday's autofill parse (Kevin's Hardware Resume.pdf)…   <- the fix
    clicked "Continue (after the résumé upload)."                                       <- the fix
    résumé page done — Workday parsed it; the next page has 2 field(s).
    reached the form

Result: **zero `autofillWithResume|` bundle pages**, the first saved page is the real form
(`apply|addressLine1,…` +19), and page 2 came back `+34` fields INCLUDING `skills` — the résumé-parse
benefit this path exists for. Ran through to the review page in 185s and reported 200; nothing submitted.

**Technique worth keeping:** to re-test onboarding paths that only occur for a signed-OUT user, sign the
tester account out of the tenant first. A signed-in session with an open application gets "Continue
Application" instead of the Apply chooser, so the whole Autofill branch is unreachable — which is exactly
why this bug survived a full day of testing.

## 2026-08-09 (e) — cadence.wd1 verified end to end from a SIGNED-OUT start

Continuing the signed-out sweep. A tenant never applied to is signed-out by construction, so it
exercises the Autofill-with-Resume branch without any manual sign-out.

**cadence.wd1 — VERIFIED, hidden, nothing submitted.** The fullest onboarding chain yet, all in one run:

    Stage 1 — clicking "Apply (job listing)"
    Stage 2 — clicking "Autofill with Resume"
    Workday sent the Autofill-with-Resume click to the SIGN IN screen — handing back to the auth stage
    Stage 3 — auth screen detected
    [sign-in fails: no account] → creating a Workday account as wangykev+31@gmail.com…
    uploading the résumé for Workday's autofill parse…
    clicked "Continue (after the résumé upload)."
    résumé page done — Workday parsed it; the next page has 8 field(s).
    reached the application form.

Fill: 5 pages, 57 filled · 8 skipped, 11 flagged, review page reached in 321s. Approved 11/11 on the
tracker, then **two consecutive rehearsals, both SUBMIT GATE PASSED, AGREE 54 · DISAGREE 0 · MISSING 1 ·
EXTRA 1** — identical across runs. Also exercised live: account CREATION on a fresh tenant, and the
tenant-variable field ladder (`education[0].schoolName: tenant renders this as a typeahead (map says
text) — filling as typeahead (live DOM wins)`).

**A junk-page false alarm, worth writing down.** Grepping the bundle for `autofillWithResume|` reported a
hit on cadence. It was not one: `/apply/autofillWithResume` is the whole FLOW's path on this tenant, so My
Information sits on it too. The junk page is identified by an EMPTY field-set half (the key ENDS at the
`|`), not by the path — cadence's key was `…|addressLine1,city,country,countryRegion,legalName--firstName,…`
with 13 fields. Check `key.endsWith("|")`, never `key.includes("autofillWithResume|")`.

**⚠ Workday's maintenance page also means "unknown site".** synopsys/lamresearch/teradyne/qualcomm site
guesses all redirected to `community.workday.com/maintenance-page`; cadence loaded fine at the same
moment, so it was four wrong site names, not an outage. Relevant to the recorded TODO for a
start-of-fill maintenance gate: `isWorkdayMaintenance` cannot distinguish "Workday is down" from "that
URL is wrong", so a gate keyed on it should say so rather than assert an outage.

## 2026-08-09 (f) — discovery works; kiongroup.wd3 exposes a DEGENERATE PAGE KEY that merges two pages

Used the Discover sweep instead of guessing tenant URLs (operator: "I have code for that"). It behaved
exactly as designed: scanned simplify 14485 / linkedin 48, read 25 LinkedIn records with **a real employer
link on 25 of 25, 0 board-only**, and resolved them to employer ATS URLs incl. Workday tenants. It queued
0 only because every candidate scored **below the ranking threshold** (best 49%), each with its reasons
logged — the gate working, not a failure. The resolved links are themselves the useful output.

**kiongroup.wd3 — fill reached review; the REHEARSAL halted `replay-page-not-in-bundle`.**

Verified live on the way in:
- **The social-login chooser fix (2026-08-09) FIRED** — `auth is a social-login chooser — clicking "Sign
  in with email" to reveal the form.` That fix was committed unit-pinned-only because sonos's posting was
  dead; this is its first live exercise.
- **The `job_key` separator widening (2026-08-09) FIRED** — `approved bundle loaded for job_key
  "wd3:jr-0088855"`. A letters-DASH-digits requisition now keys correctly end to end.
- The résumé page was consumed correctly (account created, uploaded, parsed, no junk page).
- `pacing hidden-SLOW (worker throttled)` — the documented wd3 CSP case blocking the blob worker. Fill
  66.8s vs ~13s on the fast path. Self-diagnosing from the pacing label, as intended.

**THE BUG.** The fill's five page keys (`cdpPageKey` = pathname|field-set):

    apply/autofillWithResume ||                                     <- EMPTY field set
    apply/autofillWithResume ||                                     <- EMPTY field set
    apply/autofillWithResume || 90b8915caea31001447e9f7107710000,…
    apply/autofillWithResume || ethnicityMulti,gender,veteranStatus
    apply/autofillWithResume || dateSignedOn,disabilityForm,employeeId,name

Two pages produced an EMPTY field-set half, so both collapsed to the SAME key
`…/apply/autofillWithResume|`. `accumulateBundle` merges on that key, so the second page's entries
overwrote the first's. My Information's fields therefore appear NOWHERE in the 49-field bundle, and the
replay correctly reports `page 1: NO matching page in the approved bundle (live flat fields: source,
candidateIsPreviousWorker, country, legalName--firstName, …)` and halts.

This is the M31 lesson recurring: the field-SET is what makes the key stable, so a page whose flat field
list reads EMPTY has no identity at all — and a SECOND such page silently destroys the first. The halt is
correct behaviour (it refuses to replay a bundle that doesn't describe the page), but the data loss
happened back in the FILL, and nothing flagged it there.

Not yet established: WHY those two pages scanned as zero flat fields. Candidates — a page whose fields
all sit inside repeating containers (the flat list legitimately empties, e.g. My Experience), and the
hidden-SLOW pacing letting the key be computed before the field set settled. The two cases want different
fixes, so this needs the page-key computation traced on this tenant before anything is changed. A
degenerate key should probably never be allowed to MERGE regardless — falling back to the page ordinal
would preserve both pages even when the field set is genuinely empty.

Tenants verified end to end today, all hidden, nothing submitted: **moog.wd5** (résumé fix), **cadence.wd1**
(new tenant, account created, 2× SUBMIT GATE PASSED, AGREE 54 · DISAGREE 0), **marvell.wd1**, plus the
post-merge regression pass.

## 2026-08-09 (g) — the field-less page key: diagnosed properly, fixed, verified

The kiongroup halt from (f), run to ground. Worth recording how the diagnosis went, because two of my
readings were wrong before the right one:

1. First read (from the LOG): "two pages both keyed EMPTY and collided." Right conclusion, weak evidence
   — the ring truncates messages and I split the key on `indexOf("|")`, which can manufacture an empty
   field-set half out of a truncated line.
2. The operator refuted the premise: the résumé page and My Information have very different DOMs, so why
   would both key empty? Fair, and it forced a real check.
3. Second read (from the BUNDLE, via the tracker's RSC payload — authoritative, no truncation): 4 page
   keys for 5 filled pages, one of them field-less holding 31 entries. I then read that as "they MERGED,
   nothing was lost" — also wrong.
4. Third read, listing the 31 entries: all `workExperience[*]`/`education[0]`/`language`/`website[*]` —
   ONE page, My Experience. My Information's fields (`source`, `country`, `legalName--*`, `addressLine1`,
   `city`) were in the bundle NOWHERE. So it WAS an overwrite, and a whole page of the application was
   gone from the review.

**Cause — two faults, both required.** (a) `fillAndPersistPage` computed the merge key ~40 lines BEFORE
`awaitFieldSetSettled`, off a scan taken as the page was entered; kiongroup runs the wd3 CSP path (blob
worker blocked, page timers ~1Hz), so My Information had not mounted its fields and keyed field-less.
(b) A field-less page has no identity and the pathname is shared by the whole apply flow, so every
field-less page keys byte-identically as `<path>|` — and My Experience is LEGITIMATELY field-less (all
its fields sit in repeating sections, which the flat loop skips). `accumulateBundle` drops the prior
entries for the same physical page, so My Experience overwrote My Information.

Nothing complained at fill time. It surfaced only because `samePhysicalPage` deliberately refuses to
match a field-less key to anything but itself, so the replay could not match live page 1 and halted
`replay-page-not-in-bundle`. The halt was the only alarm on a silent data loss.

**Fix.** The key is taken from a SETTLED scan (still pre-fill, so a cascade still cannot change it
mid-page), and a genuinely field-less page falls back to the walk ordinal — `<path>|#2` overlaps itself
and nothing else, which is exactly what `samePhysicalPage` needs for the re-fill overwrite. `preScan`'s
other two consumers (the group-watch diagnostic and `isSelfIdPage`) now read settled data too, which
quietly fixes `isSelfIdPage` having been able to miss the self-ID page on a slow tenant.

Pinned two ways, both verified failing first: `cdpPageKey` must give two field-less pages distinct keys,
and — structurally, since this was an ORDER bug that every unit test on `cdpPageKey` itself passed — the
key must be computed after the settle.

**LIVE-VERIFIED** on kiongroup.wd3, same job, build `pagekey-settled-47b241c`. Five pages now produce
FIVE distinct keys:

    addressLine1,candidateIsPreviousWorker,city,country,cou…   My Information  (was EMPTY)
    #2                                                         My Experience   (field-less → ordinal)
    90b8915caea31001447e9f7107710000,…                         Application Questions
    ethnicityMulti,gender,veteranStatus                        Voluntary Disclosures
    dateSignedOn,disabilityForm,disabilityStatus,employeeId    Self Identify

Reported 200 with **42** needing review, up from 14 — because My Information's fields are now in the
bundle instead of being overwritten. Suite 1237/1237.

**Method note for next time:** read the BUNDLE, not the log, when the question is what the bundle holds.
Two of the three wrong turns above came from parsing truncated log lines; the RSC payload on the tracker
page answered it exactly.

### (g) follow-up — the page-1 halt IS cleared; a SECOND halt remains, on the self-ID page

Re-ran kiongroup approve → rehearse on `pagekey-settled-47b241c`. The original failure is gone:

    page 1 → matched approved page "…/apply" (14 flat-field overlap; 14 approved entries)
    page 2 → matched (3 flat-field overlap; 31 approved entries)
    page 3 → matched (10 flat-field overlap; 10 approved entries)

Page 1 previously reported `NO matching page in the approved bundle`, so the field-less-key fix is
confirmed end to end, not just in the page keys.

The run still stops, one page later: `⚠ page 4: NO matching page in the approved bundle (live flat
fields: disabilityForm, name, employeeId, dateSignedOn, disabilityStatus…)` → `replay-page-not-in-bundle`.
That is the SELF-ID page, and it is NOT the same fault. Two candidates, neither yet separated:

1. **That page took all 28 fill errors.** Per-page counts for the re-fill were page 1 `filled 12 ·
   filled_review 1 · skipped 1`, page 2 `filled 27 · skipped 3 · filled_review 1`, page 3
   `filled_review 8 · needs_review 2`, page 4 `filled 1 · filled_review 2`, **page 5 `removed 5 ·
   error 28 · skipped 2`** — with `rectReady` on `formField-disabilityForm`'s listbox button giving up
   6 times (2.5s–11.3s). Pages 1–4 are healthy; the self-ID page alone is failing to actuate. This is
   the known self-ID instability on this surface, on the slow wd3 path — NOT caused by the key fix
   (page 5's preScan already held fields pre-fix, so self-ID detection and trusted-input forcing are
   unchanged there).
2. ~~The bundle is a MIXED-SCHEME hybrid.~~ **WRONG — retracted the same day.** I inferred from
   49 → 88 fields that the re-fill had stacked stale pre-fix pages beside the new ones, and wrote that
   any pre-fix application must be re-filled from a CLEARED summary. Checking the bundle refuted it:
   **every** page key is under `/apply` (no `/apply/autofillWithResume` survivor), the envelope reads
   `accumulated (5 pages)`, and 14+31+10+3+30 = 88 accounts for all of it. `runCdpWalk` already clears
   `reviewSummary`+`reviewAudit` once at walk start, and a report REPLACES `review_bundle_json`
   wholesale (`reportColumns` always writes it), so a hybrid was never possible. The count grew only
   because the self-ID page contributed **30** entries this run (28 errors + 2 skipped) instead of 5.
   No migration step is needed for pre-fix applications.

So candidate 1 is the whole story: the self-ID page is failing to actuate, and the replay cannot match a
page the fill largely errored out on. That is the thread to pull — same thread as the disability-checkbox
blocker and the re-entry correlation from earlier in the day, which are worth attacking as ONE piece.

### (g) resolved — kiongroup.wd3 reaches SUBMIT GATE PASSED

Cleared summary → fresh fill → approve → rehearse, on `pagekey-settled-47b241c`.

The refill was CLEAN, and it retires the "the self-ID page is failing to actuate" reading from the
follow-up above. Per-page: page 1 `filled 12 · filled_review 1 · skipped 1`, page 2 `filled 27 ·
skipped 3 · filled_review 1`, page 3 `filled_review 8 · needs_review 2`, page 4 `filled 1 ·
filled_review 2`, page 5 **`filled_review 1 · skipped 4` — zero errors**, and `rectReady … gave up`
appeared **0** times in the whole run (previous run: 28 errors and 6 give-ups on
`formField-disabilityForm`). So that failure is INTERMITTENT on this tenant, not a standing fault —
one run is not evidence of a broken widget, which is the same lesson as the marvell Date block.

Bundle: 54 filled · 7 skipped · **0 error** · 15/15 flagged approved · Ready to submit.

Rehearsal: every page matched an approved page, **AGREE 51 · DISAGREE 0 · MISSING 3 · EXTRA 1**,
**SUBMIT GATE PASSED — WOULD CLICK SUBMIT (SIMULATE MODE: NOT clicking)**. Nothing submitted.

So kiongroup.wd3 joins the verified list, and the field-less page key is fixed end to end: the fill
records five distinct pages, the replay matches every one, and the gate passes.

**Tenants verified end to end 2026-08-09** (all hidden, all `arm:false`, nothing ever submitted):
moog.wd5 · cadence.wd1 · marvell.wd1 · kiongroup.wd3.

## 2026-08-09 (h) — cat.wd5 verified end to end (the last outstanding tenant)

Posting found via the CxS API (`/wday/cxs/cat/CaterpillarCareers/jobs`, 314 hits for "electrical
engineer"); ran Griffin-Georgia `_R0000386586` hidden, signed out.

Onboarding took the full chain cleanly: Apply → Autofill with Resume → bounced to SIGN IN → signed in
(coordinate click missed, the focus+Enter fallback took it — that ladder earning its keep) → **résumé
uploaded, parsed, page consumed** → reached the form. `job_key` resolved to `wd5:r0000386586`.

Fill: 5 pages, 49 filled · 9 skipped · 3 error, 6 flagged, 300s. Approved 6/6, then **two consecutive
rehearsals, both SUBMIT GATE PASSED, AGREE 46 · DISAGREE 0 · MISSING 2 · EXTRA 1** — identical across
runs. Nothing submitted.

**Incidental second confirmation of the page-key fix.** Onboarding handed off announcing "the next page
has 5 field(s)", and the key computed after the settle recorded
`addressLine1,candidateIsPreviousWorker,city,country,…` with 13 filled — i.e. the page had mounted its
full field set by the time the key was taken. Pre-fix, that hand-off is exactly the shape that produced a
field-less key. All five pages keyed distinctly.

**TENANTS VERIFIED END TO END 2026-08-09** — all hidden, all `arm:false`, nothing ever submitted:
**moog.wd5 · cadence.wd1 · marvell.wd1 · kiongroup.wd3 · cat.wd5**.

Fixes landed today, each unit-pinned (every test verified failing first) and all but one live-exercised:
1. the apMatch lockstep guard now scans background.js (the hole that let a live abort through),
2. Workday's second wording for the signature-date demand,
3. `job-posting-not-found` instead of blaming the sign-in form,
4. the social-login chooser matched by TEXT (live on kiongroup),
5. `job_key` for requisitions that separate letters from digits (live on kiongroup `jr-0088855`),
6. the résumé page consumed at the OTHER post-auth exit (live on moog/cadence/kiongroup/cat),
7. the field-less page key no longer overwrites the previous page (live on kiongroup, confirmed twice).

Still open: the signature-date STAMP is unit-pinned but has never been observed firing (the marvell block
has not recurred); the self-ID actuation failure on kiongroup is intermittent, seen once in ~4 runs.

## 2026-08-09 (i) — a field the tenant doesn't render is gone from review (live-verified on cat.wd5)

Operator, on finding three blank rows on the cat tracker: "if the repeating section has no gpa, it
shouldn't show up in the review page."

Those rows were `education[0].gpa` / `from_year` / `to_year`, each rendered as a bare "—" saying
"ApplyPilot couldn't fill this — please fill it in yourself" on a form whose Education section is only
School, Degree and Field of Study. No box to fill; and no label, because a label is READ OFF THE PAGE and
there is no field on the page to read one from. They were `error` rather than `skipped` purely because the
profile HAS a GPA and years — the old rule kept "a value with nowhere to go" loud.

**The obvious fix was wrong and the suite proved it.** Three different things reach that branch and look
identical there: (a) the tenant has no such box; (b) a field that REMOUNTS was absent when we looked (WE
endDate); (c) a field that IS rendered but our labelRegex/id missed it (a Languages proficiency).
Reclassifying all three would silently drop real fields — the data-loss class this file has spent weeks
removing. Two existing tests caught it immediately.

**The discriminator:** is there a rendered field in this entry that NO map entry claims? Leftover box ⇒ we
failed to identify something that IS on the form, stay loud. Everything accounted for ⇒ the form has no
home for this one, drop it as `removed` (the existing "drops from the summary, not an error" status, which
`buildReviewBundle` filters) so it leaves the human's queue while the per-page `counts:` line still
tallies it. This also makes repeating sections behave like FLAT fields, which were always silent here.
Two guards err toward keeping a row visible: an entry that rendered NOTHING proves nothing, and the claim
check excludes `labelFallback`. `waitForPresence` already polls to its ceiling BEFORE this branch, so (b)
only reaches it after the field genuinely never appeared.

The **languages labelRegex test passes UNCHANGED** — that is the proof the discriminator separates (c)
from (a). The two tests whose expectations the decision changes were updated in place with the reasoning,
not deleted; the endDate one still pins that `waitForPresence` is the difference between filling and not.

**LIVE-VERIFIED, cat.wd5, build `omits-field-863c434`.** Page 2 counts went
`{filled 27, skipped 3, error 3, needs_review 1}` → `{filled 27, skipped 3, removed 3}`; the report went
from 6 needing review to **2**; and the review page now lists exactly
`education[0].school_or_university / degree / field_of_study` with **zero** "couldn't fill this" rows and
no error count in the header. Suite 1237/1237.

**Process note (cost ~20 minutes):** the fix looked un-deployed because the WRONG CHROME was connected —
its extension loads from the `workday-skills` worktree (marker `polarity-capture-1`) while the right one
loads from `ApplyPilot-ext Debugger`. I misread that as a folder problem and went hunting checkouts; the
operator diagnosed it in one line. **`AP_BUILD` disagreeing with the folder on disk means CHECK THE
BROWSER before touching anything else** — `switch_browser` re-pairs in one call.
