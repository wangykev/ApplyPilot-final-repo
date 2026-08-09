---
name: cdp-actuation
description: The Workday CDP fill substrate — how a field is actually actuated from the service worker (chrome.debugger). Read this before touching pacing, the input primitives, any widget handler (text/date/radio/dropdown/typeahead/source/skills), the option scrape, the cascade + sweep passes, the input-lock, or the M40 audit. Covers the hidden-tab throttle model, synthetic-input mode, and the verify contract that keeps a no-op from becoming a wrong fill.
---

# CDP off-loop actuation — the primary Workday fill path

A hidden/minimized tab throttles page timers to ~1Hz then deep-freezes, so a page-injected fill
stalls (a PASSIVE debugger attach does NOT relieve it). Fix: actuation as **CDP commands from the
service worker** (`chrome.debugger`, the `"debugger"` permission) — `Input.*` / `Runtime.evaluate`
execute off the page loop, throttle-immune.

Workday's debounced REACTION still runs page-side and throttled → **all waits are generous SW-side
wall-clock; Δperf ~1000ms during a run is EXPECTED, never failure.**

Empirical detail behind all of this: `docs/dom-patterns.md` 2026-06-12 onward.

## The verify contract (the reason this path is trustworthy)

Every commit is read-back verified, and a verification that cannot be made is `needs_review` — never
a silent pass and never a wrong value. This is the ONE failure the safety contract exists to prevent:
**a momentary pick discarded on render-complete must never be reported filled.**

- Nothing proceeds on a fixed timer — every wait polls the page condition it gates.
- Text/date read-backs poll until the COMPLETE value registers (the ceiling is give-up only).
- Dropdown option-settle waits for COMPLETE render before picking, and the commit-verify adds a
  **PERSISTENCE re-read**.
- **M40 post-fill audit** — a SECOND, independent DOM read after the whole page settles, reconciled
  against what each field recorded (re-read by widget type via the retained `auditLoc`, re-resolved
  fresh): match / mismatch (`needs_review` + `audit-mismatch`, `after` = the live truth) /
  unverifiable (`audit-unverifiable`, never a silent pass). Inline (auto, may self-heal with ONE
  re-fill then re-read) plus a standalone flag-only re-audit (`RUN_CDP_AUDIT`).
- The initial audit re-read is **BATCHED into ONE `Runtime.evaluate`** (`act.readAuditRaw` →
  `cdpReadAuditRaw`, which COMPOSES the single-source reader fns — no body dup) instead of one
  `cdpEval` per field; cuts N serial round-trips to 1 (biggest win on HIDDEN). The `{actual,readable}`
  mapping stays SW-side (`auditActualFromRaw`, Node-tested); a missing/failed batch falls back to the
  per-field path. The mismatch→refill re-read stays per-field.
- Text/date fills also self-heal (one retry on read-back mismatch).
- `already-filled*` records are audit-EXCLUDED (never re-actuated).

## Substrate / brain split (the substrate-swap hedge)

- **`cdp.js` = the substrate** — attach/detach lifecycle (detach in `finally`; external-detach and
  tab-close listeners; **ONE debugger client per tab**, so page DevTools on the tab kills the attach),
  trusted input primitives, `cdpEval` DOM reads, `makeCdpActuation()`.
- **`fill-driver.js` = the brain** (`drivePageFill`): `FIELD_MAP` / `resolve` / employer-match /
  record+status semantics calling ONLY the actuation interface — Node-testable with a fake actuation
  (`test/fill-driver.test.js`, including the NAMED invariant test that the previous-worker radio is
  never left "Yes" without a review flag).

ALL pacing goes through `act.delay` (SW wall-clock) — **never a page-side timer**. Every element is
re-resolved fresh per call (React re-renders orphan held nodes — recon-proven).

## Pacing model

`act.delay` / `act.delayRender` are **adaptive** — ~10× faster (`FAST_FACTOR 0.1`, floor 10ms) when
`cdpFast()` says fast, full otherwise. **`act.delayFull`** stays never-scaled for the few waits that
must always run full (the M40 audit settle).

**`cdpFast()` = tab VISIBLE, OR hidden-but-worker-timers-measured-fast** — never fast on assumption.

**Hidden-tab SPEED (worker-timers, 2026-07-04).** The injected `buildOverrideSrc` routes the page's
`setTimeout` / `setInterval` (+ rAF) through a `blob:` Web Worker whose timers ESCAPE Chrome's
background throttle, so a hidden fill runs at page-speed instead of ~1Hz. Fast pacing is gated on a
MEASURED in-page `setTimeout(0)` round-trip (`cdpTimersFast`, a non-blocking `Promise.race` bounded to
~200ms), so a CSP-blocked worker or genuinely-slow page ⇒ **byte-identical slow path** (no
false-verify).

**CSP bypass (2026-07-25).** `wd3.myworkdaysite.com`'s CSP blocked the blob: worker, silently putting
WHOLE hidden runs on the ~1Hz slow path (~11s/field — the first `[CDP-TIME]` evidence). Since we're
already debugger-attached, `cdpInstallPageOverrides` issues `Page.setBypassCSP` before the install
(+ a worker-only retry for a SPA doc already stamped `__apOverridesInstalled` by a pre-bypass attach)
— best-effort, and the measured gate still decides pacing.

The per-page `[CDP-TIME]` line leads with the pacing regime (`cdpPacingLabel`) so a slow run
self-diagnoses. **`hidden-SLOW (no worker timers)` on a timing line = this class, not budget tuning.**

**`act.delayRender`** (adaptive, same `cdpFast()` gate) carries the render-SETTLE intervals: dropdown
option-settle, commit-persistence, recon opens/closes, and the `closeDropdownConfirmed` options-gone
poll (2026-07-25, bounded by a wall-clock deadline). Safe because each is gated by an
interval-length-INDEPENDENT state check, not the wait length.

**Full-clock tax sweep (2026-07-25).** State polls that follow a trusted click READ FIRST, then wait
(`pollCheckedIs`, the GATE-1 aria-expanded polls, `commitByClick`'s first read — the click's React
reaction usually lands synchronously); the commit-PERSISTENCE re-read stays delay-first, a real beat.
The per-page pre-fill field-set settle and `cdpWaitNextPage`'s error-confirm are WALL-CLOCK windows
(no-growth ≥1.2s / errors-persist ≥600ms) polled fast instead of read-counts at fixed 500ms beats;
`cdpWaitNextPage`'s poll itself is adaptive.

Per-page `[CDP-TIME]` log (settle | fill phases | resume | slowest fields, from `rec.elapsedMs` +
`out.timings`) is the evidence future pacing rounds retune from. `forceWorkerTimersOff`
(chrome.storage.local) forces the slow path for regression testing.

## Hidden-tab input stall and SYNTHETIC-INPUT mode

**The stall (2026-07-25, `[CDP-TIME]`-proven):** trusted `Input.dispatch*` to a HIDDEN tab stalls
~1.2–1.5s per event (input processing rides compositor-frame scheduling; a hidden tab produces no
frames). Per-field cost scales with the input-EVENT count and is IDENTICAL across pacing regimes, so
**no delay tuning touches it.**

**The fix — synthetic-input mode** (2026-07-25; the truly-hidden fast path — the operator rejected a
visible mini-window). SCOPED opt-in (`cdpSetSyntheticInput(true)`; reset to false at every
`cdpAttach`):

| Path | Input mode | Why |
|---|---|---|
| `runCdpWalk` / `runCdpFillPage` | synthetic when hidden | application form pages — proven surface |
| `runCdpReplayWalk` (since 2026-07-28) | synthetic when hidden | same surface; a background submit run shouldn't pay ~1.2–1.5s/event |
| onboarding / auth | **always trusted** | the auth app doesn't register native-setter values or untrusted clicks; live, fields read back OK but Sign In never fired |
| recon | always trusted | ~15–25s cost is acceptable there |
| `act.clickSubmit` | **forced back to TRUSTED even when hidden** | the one irreversible action |

When enabled and the tab is HIDDEN, the six input primitives (`cdpClickAt` / `cdpTripleClickAt` /
`cdpKeyTap` / `cdpInsertText` / `cdpSelectAllDelete` / `cdpTypeChars`) dispatch SYNTHETIC events
INSIDE the page via one `Runtime.evaluate` — the page-engine's PROVEN repertoire: `robustClick`
pointer→mouse→click at the same coords, shadow-piercing + `click_filter`-passthrough
`elementFromPoint`, native-setter REPLACE + input/change for all text (typing always follows a
clear/select-all, so replace ≡ select+type), label activation for radio/checkbox, searchBox set +
synthetic Enter.

Synthetic events run NO browser defaults, so the two the fill relies on are recreated: **Tab →
`blur()`** (the clean typeahead exit) and **Space → `click()`** activation; focus-on-click is mimicked
so activeElement-targeted keys land right. A per-op miss falls through to the trusted path.

**Every verify gate is UNCHANGED** — read-backs, chip/persistence re-reads, M40 audit. A synthetic
no-op ends `needs_review`, never a wrong fill. `__apActing` is bumped inside each dispatch eval
(input-lock passthrough — the attachResume lesson).

VISIBLE tabs keep the trusted `Input.*` path (battle-tested; acks are ms there), which also
**BATCH-SENDS** its event sequences (one hidden drain per burst, in-order delivery).

The replay walk's opening banner prints the tab's input mode; the attach log prints it too.
**Kill-switch:** `chrome.storage.local.forceTrustedInput` reverts hidden runs to trusted
(slow-but-proven).

## Simple widgets

- **Text** = `Input.insertText` (trusted `beforeinput` + `input`, survives blur) after CDP
  click-to-focus and a trusted Ctrl+A / Delete clear, read-back-verified.
- **`<textarea>`** = the same path with a `tag` param (insertText handles the newline).
- **Dates** = per segment: **triple-click the visible `dateSection*-display`** (the `-input` is 0-box
  — coordinate-click impossible) → focus-verify (never type into an unfocused segment) → type digits
  → `parseInt` read-back.
  **⛔ NO Ctrl+A in the date path** — it selects the WHOLE composite and resets focus to Month, piling
  digits into Month. A `node --test` guard pins that the composite never whole-field-clears;
  triple-click-select + type-replace needs no clear.
- **Radio / checkbox** = coordinate click on the `<label for>` (fallback: focused input + Space),
  verified via `checked`.
- **M29 retry:** rect/focus reads re-poll to a ceiling (absorbs throttle transients). A `gave up` log
  suggests session-death, not throttle.

## Dropdowns

**Commit = TEXT-KEYED scroll+click** of the matched option, scoped to the trigger's `aria-controls`
listbox. A coordinate click on an out-of-view option lands outside the popup and dismisses it — the
**"Uruguay pitfall"**. No type-jump / arrow-counting (native type-ahead cycles same-prefix values).
Exact-normalize verify + persistence re-read, one retry then `needs_review` — never a wrong or silent
commit.

### The OVERWRITE commit — escalating beat ladder

Committing a RE-SELECTION (replacing a real prior value, e.g. pre-filled-then-flipped languages) fails
under too-fast pacing: the click lands on the right option, `hitTarget=true`, but doesn't fire the
selection — a Workday-internal option-click DEBOUNCE with **NO DOM correlate**. Elapsed-time-since-open
is the only lever.

The debounce is a PAINT thing — tiny when the tab is painting, ~700ms when not. `act.visible`
(`cdpVisible` = tab active + window not minimized; NOT `cdpFast`) picks the STARTING beats.

⚠ **`act.visible` can't detect OCCLUSION:** a tab alt-tabbed BEHIND another app is throttled and not
painting yet still reports `tab.active && !minimized`. The page's own `visibilityState` / `rAF` are
spoofed/polyfilled by the hidden-tab overrides, so paint can't be read there either.

So the commit **does not TRUST the label**. `overwriteBeatLadder` returns an ASCENDING ladder —
**VISIBLE `[30,100,700,5000]`, HIDDEN `[120,700,5000]`** — and the commit **ESCALATES on each MISS**:
re-open + wait the next-larger beat since (re-)open, up to the 5s tier (`overwriteMaxBeatMs`)
REGARDLESS of the label. A painting tab commits on tier 0 (no penalty); a mislabeled/occluded/hidden
tab self-corrects to the big beat instead of failing to `needs_review` (the alt-tab language-swap bug,
fixed 2026-07-07 — the old visible pair capped at `100` and never reached `700`).

Non-final tiers fail-fast (`min(overwriteFailFastMs, commitCeilingMs)`) so a MISS escalates cheaply;
the last tier gets the full ceiling. A `[CDP-DD-REFILL]` line per overwrite prints the ladder and which
tier committed. The commit-PERSISTENCE re-read still gates every accept → escalation can only cost
extra re-opens, never a wrong fill (unit-pinned, including that a mislabeled-visible tab still reaches
the `700` tier).

### Pre-filled guard (tier-aware)

EMPTY fills (`before` = the disabled placeholder) never race → single fast commit, no ladder.

- **tier-0 pre-fill** → the FILL keeps zero-actuation (`dropdown-prefilled-kept`). The end-of-page
  `captureChoiceOptions` then re-opens it READ-ONLY to scrape options for the review editor, so a
  page-1 dropdown (country/state/phone) renders as a real `<select>` and not a textbox (value
  preserved, M40-audited — 2026-07-05 operator ask). The old literal "never re-open a tier-0 pre-fill"
  is relaxed to **"never value-change one"**.
- **`k>0`** → re-opens + upgrades to the highest offered tier (`dropdown-overwrite-success` /
  `-better-tier-unavailable`).
- **`k===-1`** → full walk.

## Hierarchical typeahead — ONE filler for typeahead + source + cert trees

`fillTypeaheadCdp`. Cert and "How did you hear about us?" are the SAME Workday multiselect;
`fillSourceCdp` is a kept alias.

**ONE reader `cdpReadHierState`** — leaves = `promptOption` / `data-automation-label` (**NOT
`role=option`**); `promptLeafNode` selected-state; scoped by `data-uxi-multiselect-id`; chips /
`selectedItemList` excluded (a committed chip elsewhere embeds a promptOption).

Per-candidate tier walk. **`awaitListTerminal` gates every action on a CONFIRMED terminal render:**
no-match banner ("No matches found") / results banner ("Search Results") / autocommit (new chip, or
box-closed-with-chip — a closed dropdown holding a chip is settled, `closed-commit`). Both banners live
on the SAME `promptTitle` div, text-distinguished. **A bannerless non-zero list is NEVER terminal.**
The input echo (`pollSearchValue`) is never the render signal. **Enter is the ONLY filter trigger.**
Banner = HARD block; match ONLY the current candidate.

**The ONLY commit signal is the `selectedItem` chip / `multiselectlistitem` selected-state
normalize-equal to the matched option** — never option text. Multi-match commits via a trusted
text-keyed click on the matched option.

**Focus hygiene (load-bearing):** re-assert and READ-VERIFY searchBox focus before EVERY clear/type —
a banner DROPS focus, and a blind post-banner Ctrl+A selects the whole PAGE and stray-commits row 0.
Unconfirmable → `needs_review` "not actuating blind", STOP.

**Tab-blur is the ONLY clean non-commit exit.** Enter commits the armed row; Escape hides the popup but
KEEPS focus and the armed row, so the next field's focus blur-commits a stray; re-focusing does NOT
clear an armed row (**the disarm fallacy — deleted**). EVERY non-commit exit (honesty reads,
`could-not-focus` / `could-not-type` early bails, read-only captures) Tab-blurs. Dropdowns keep Escape.

**Tier-aware pre-filled guard:**
- tier-0 chip → the FILL keeps it with ZERO value-changing actuation (`prefilled-kept` —
  countryPhoneCode auto-derives from Country, the common case). The end-of-page `captureChoiceOptions`
  re-opens it READ-ONLY for review options — no type/clear/Enter/leaf-click, chip preserved,
  M40-audited (2026-07-05, relaxing M36.1's literal "no open" to "no mutation").
- `k>0` → walk ONLY the higher tiers; `keptLowerTier` Tab-closes with a post-Tab chip verify
  (`filled` / `prefilled-better-tier-unavailable`; chip differs → honest `overwrite-stray`; vanished →
  `needs_review`, never a false "kept"). **NEVER reaches the inline AI** — a stated lower-tier value is
  deterministic, zero LLM calls (invariant-pinned).
- `k===-1` → full non-destructive overwrite walk (search-while-populated, commit-REPLACES; a no-match
  keeps the original and clears the filter — `overwrite-nomatch-original-kept`).

A post-exit chip ≠ original is always surfaced (`overwrite-stray`). An honesty final-read: a record
never reports `after:null` when the page holds a value (including a failed AI rescue — the kept
original is reported with the failure note appended).

Flat typeaheads scrape their FULL option list ONCE at start (`makeStartCapture` — feeds the review
editor + the flat AI; read-only frame-paced scroll-accumulate over the virtualized list,
`cdpScrapeTaOptions`). Trees are detected cheaply (`readTreeCategories` — chevron category rows) and
never start-scraped.

**Source-tree load gate (`awaitSourceListLoaded`, 2026-07-20).** A `sourceTree` field's category list
is SERVER-FETCHED and arrives AFTER the picker opens, so the first-open WAITS for it (cheap
`readTreeCategories` poll, real wall-clock, bounded by `sourceCatLoadCeilingMs`, adaptive — proceeds the
instant the tree has content, re-opens only if the popup closed) BEFORE the deterministic candidate loop
types. Without it the loop typed into an empty tree, `awaitListStable` accepted the stable-EMPTY list,
and every candidate hit a false "No matches" → fell to the AI.

**Net:** the deterministic fallback ladder (the profile's `how_did_you_hear.preferred` = LinkedIn →
Handshake → GitHub → Other — "Other" is now the LAST DEFAULT entry of the single list; the separate
`fallback` field is retired, kept in the schema defaulted empty for backward-compat, 2026-07-22) is
tried FIRST via type→Enter→autocommit; `aiTreeDrillFallback` runs ONLY on a genuine no-match. The
primary/per-application source answer is deferred, so this ladder is what actually fills.
`drivePageFill` and the AI-4 re-drill both pass `sourceTree:true` (independent of the AI toggle).

Source is graded like any choice widget — an EXACT ladder match (at ANY position; a later candidate
winning because earlier ones aren't offered is fine) → `filled`, no review; a NON-EXACT deterministic
match (containment/fuzzy) → `filled_review`, flagged. No source-specific relaxation — the
"containment is a guess" rule holds for source too.

### Pre-scrape SHORT-CIRCUIT (2026-07-25)

When the start-scrape already enumerated the widget's whole option list, the candidates are matched
against it ONCE: a match starts the candidate loop AT that candidate (the known-absent ones are never
typed — live, FoS burned ~540ms proving "Electrical and Computer Engineering" was absent before typing
the one that was there); NO match skips the type/Enter walk entirely and flows to the SAME
genuine-no-match end, so the inline AI rescue (which picks from that very list) runs unchanged.

GATED on a COMPLETE scrape (`atBottom && !cappedOut` — a partial list can't prove absence) and on the
normal fill path (a tier-UPGRADE walk keeps its keep-the-prefill semantics). Matching uses the
directed-pick ladder (`{containment:false}`), so a containment-only near-miss is still typed — that's
how Workday's own autocommit recognition works.

⚠ CAVEAT: a server-search typeahead whose on-open list is a subset would report "complete" for that
subset. The cost is an AI rescue (flagged) instead of a deterministic fill — never a wrong value.

## Inline AI rescue

Fires at the genuine-no-match exits and at required-EMPTY fields; the call site passes `opts.ai` for
AI-eligible typeaheads.

**Flat** → `aiTypeaheadFallback` picks from the captured options. Decision tree: only-"Other" → "Other"
(no LLM); represented → pick, `ai-choice`; not-represented + "Other" → "Other"; not-represented + no
"Other" + REQUIRED → forced nearest, `ai-closest-forced` (NEVER declines — a blank required halts the
walk); optional → decline/blank. Committed on the STILL-OPEN field via the proven re-type (re-enters
`fillTypeaheadCdp(loc,[target])` WITHOUT `opts.ai` — no recursion, no Tab-abandon).

**Trees (source + cert)** → `aiTreeDrillFallback`, a two-prompt category→leaf drill: scroll-enumerate
the VIRTUALIZED rows (`scrapeSourceRows`), CLICK-drill the AI's category (typing filters the whole
tree, it can't drill), then scrape leaves and have the AI pick a SEEN leaf → typed commit (focus →
Ctrl+A+Delete → type → Enter; a multi-result tie escalates to click-the-exact-leaf / Enter-again).

⚠ The chosen row renders BELOW the fold and CDP clicks at VIEWPORT coords, so `cdpSourceRowRect`
`scrollIntoView`s the **`promptLeafNode`** (the node with the onClick handler) into the clickable
viewport, re-queries after each settle, and validates with `elementFromPoint` before the trusted click.

Gated so the committed chip normalize-EQUALS the AI's leaf (`ai-commit-failed`, never a false fill).

A REQUIRED typeahead with NO profile value runs the filler with no candidates → profile-inference +
forced pick + flag (AI OFF or OPTIONAL → stays `skipped`). ALWAYS `filled_review`; every AI choice
clears the match ladder, never blind-commits.

## SKILLS (`Type to Add Skills`) — the MULTI-VALUE typeahead

Its OWN filler (`fillSkillsCdp`, 2026-08-07). Same Workday multiselect as cert/source, but it holds a
SET, so `fillTypeaheadCdp` is the wrong shape end to end (it commits ONE candidate, treats an existing
chip as a pre-fill to keep/overwrite, and flags a second chip `overwrite-residual-flagged`).

Routed by `isSkillsField` (automation-id `*skills`, or the label "Skills" / "Type to Add Skills";
**typeahead-family ONLY** — a prose TEXT box labelled Skills, and a language-proficiency field, must
never match) in `drivePageFill`'s flat loop, ahead of the unmapped skip that used to leave it empty.
**NOT in `FIELD_MAP`** — that resolves ONE value; here the whole `profile.skills` array is the answer.
Full trace: dom-patterns 2026-08-07.

**OPT-IN, because Workday's résumé parse already suggests skills.** `profile.fill_all_skills` (the
"Try to fill all of these skills" checkbox on the profile, shipped with its slowness warning) decides:

- **OFF (default)** ⇒ KEEP what Autofill-with-Resume suggested, add nothing, spend zero round trips,
  and record the list so the review page can add/delete (`filled` + `skills-suggested-kept`; an empty
  field ⇒ `skipped` with a detail saying how to turn it on).
- **ON** ⇒ also add every profile skill the taxonomy accepts, on TOP of the suggestions.
- A **REPLAY always passes `fillAll:true`** — it reproduces an APPROVED list, it is not making the
  policy choice.

A parsed chip reads back as `"Computer Hardware (Suggested)"`. `skillChipName` strips that provenance
marker wherever a chip becomes a recorded/deduped/replayed value, **and `auditActualFromRaw` strips it
too** — cleaning only one side flagged a correctly-kept field `skills:audit-mismatch` live.

**Three tiers: EXACT → QUALIFIED → guarded CONTAINMENT** (`matchSkillOption`; bare-exact wins so
"Docker" never resolves to "Docker (Software)"). Workday's taxonomy RENAMES ("Python" only as "Python
(Programming Language)"), so the qualified tier is what makes the field fillable at all. Containment
(operator-authorized 2026-08-07) lands the rest (`Vivado` → `Xilinx Vivado`, `PCB design` → its longer
row) and is **whole-word + distinctiveness-gated + ranking-tie-broken + always flagged**.

**Fuzzy is NEVER a tier here** — Workday's own search is server-side fuzzy and answers almost anything:
`Yosys` → "Yodiz", `ODrive` → "Top Drive", gibberish → "z/VM", all under the same "Search Results"
banner as a real hit. A skill with no exact/qualified/whole-word row stays OFF the form and is NAMED in
the record (live: `C++`, `HTML/CSS`, `CAN`, `ODrive`, `CubeMars motor drivers`, `VS Code` — every
refusal correct). No AI (optional field).

**⚠ The CLEAR is a HARD GATE — unverified-empty means DO NOT press Enter.** A ZERO-result query + Enter
makes Workday add the typed text as a NEW skill, so a dirty box FABRICATES an answer (live: a stale
"Docker" + the next skill created the chip "DockerCubeMars motor drivers"). Everywhere else a dirty box
merely wastes a candidate. That same behaviour is also the only way an off-taxonomy skill lands
verbatim — accepted when the new chip IS what we typed (Workday completed it, we did not guess).

**Existing chips are never touched, and the dedup is what makes a re-fill safe.** Workday DROPS an
already-selected skill from its own later results, so without `missingSkills` (BASE-name comparison
both ways, so a "Python (Programming Language)" chip covers the profile's "Python") a second pass would
commit a near-duplicate like "Docker (Software)". All-present ⇒ zero actuation.

**N skills go in on ONE open** (the list stays open and the query stays after a commit); each commit is
verified as chip-set GROWTH **plus** identity of the new chip; Tab-blur is the clean exit. Cost scales
with the PROFILE (~1.5–3s/skill; it is the slowest field on page 2 — `slowest: skills 33s` visible), so
`skillsMaxAdds` / `skillsBudgetMs` bound it and whatever they drop is named — never a silent cap.

**Replay** splits the approved `"A; B; C"` back apart and re-runs the same additive filler (idempotent
by construction), sitting ABOVE skip-if-correct so a chip-order difference can't read as a mismatch.

**⚠ THE OPEN is the fragile step, and it is a RE-RENDER RACE — not an input-kind problem.** Two opener
routes exist because a closed widget has no `searchBox` id for `readHier` to find: page-side
focus+click on the input (`openHierInput`, coordinate-free) and the coordinate click on the container
(`openHier`). Rules, all earned live:

1. **Never fire BOTH in one attempt** — the second click lands before the searchBox mounts, and a
   second click TOGGLES a multiselect shut, so the poll always finds it closed.
2. **Settle one beat first, then RETRY alternating the routes** — the open races Workday's re-render
   right after the previous field commits, which is why a SLOWER trusted run opened on attempt 1 while
   a faster synthetic run missed all three.
3. **Do NOT force trusted input here.** A hidden synthetic run added ZERO skills (`focused:true,
   openedNow:false` ×3) while the same run under `forceTrustedInput` worked — which looks conclusive
   and is not: an isolation probe with the trusted scoping REMOVED filled the field fine once the
   opener was fixed. Trusted roughly doubles this field's wall-clock and buys nothing.

Verified live BOTH ways: VISIBLE added 7; HIDDEN synthetic processed 13 candidates, adding
JavaScript / Altium Designer / Git / Docker (Software), then RViz / Fusion 360 / Yosys next run.

**The CLEAR writes via the React-safe native setter first** (`clearHierInput`): trusted Ctrl+A is
focus-blind AND does not select this input's text — live it cleared seven skills then failed, and the
first cut then abandoned the whole remaining list (losing Git/Docker/VS Code/Vivado). Ctrl+A is the
fallback, a failure RETRIES, and only a **second consecutive** failure ends the field.

The report keeps two buckets apart because the human acts on them differently: **`skills_not_offered`**
= the taxonomy genuinely lacks it (add by hand) vs **`skills_failed`** = typing/commit/clear didn't land
(re-run). ⚠ **Coverage varies run to run** — the result set is a ranked top-7, so `Yosys` / `RViz` /
`Fusion 360` matched on one run and not the previous; and a skill whose only offered row is a
differently-named relative (`Vivado` vs `Xilinx Vivado`) is deliberately left OFF rather than guessed.

## Cascade + sweep passes (end of `drivePageFill`)

- **M1 cascade re-scan** — fills fields REVEALED by a committed value (e.g. Country → Cyrillic-name
  fields); identical fill ladder, tagged `cascadeRevealed`; byte-identical when nothing revealed (one
  read-only `act.scanPage()`, no fixed wait); `maxCascadeRounds` backstop; skipped under
  `onlyFieldNames`. **Runs TWICE** — once after the fold and once AFTER the capture+audit, which already
  spend ~1s of real settle, so a reveal still MID-RENDER when the first pass fired (the last-filled
  field's own reveal — live: an SMS-consent checkbox after the phone number) is caught for the price of
  one read-only scan, with no fixed wait added to any page.
- Fields REMOVED by a value → `status:"removed"` / `cascade-removed`, dropped from the summary (not an
  error). Guard: only when the rescan returns a non-empty field list.
- **`captureChoiceOptions`** (end-of-page, after fields settle, BEFORE the audit — inline capture
  raced/corrupted commits) captures full option lists for the review editor, cached per option-set key
  (per PAGE — same-vocabulary fields re-open once, not N times).
  **There is deliberately NO cross-run cache (removed 2026-08-06):** in the real flow a form is filled
  ONCE, reviewed, then submitted, so a cross-run store is always cold when it matters. It only ever
  sped up a SECOND run against the same tenant — a testing artifact — and it made repeat test runs
  faster than a genuine first fill, distorting every timing measured against it.
  Covers repeating-section dropdowns/typeaheads AND flat page-1 prefilled-kept dropdowns/typeaheads
  (country/state/phone/countryPhoneCode: a tier-0 keep never captured options, so a READ-ONLY re-open
  here gives review a real `<select>`/combobox instead of a bare textbox — the M27.C cold-list cost,
  paid deliberately per 2026-07-05). A committed / start-scraped field already carries options → skipped
  by the `!rec.options.length` guard.
- **`sweepAlreadyFilled` LAST** — see the `review-and-submit` skill.

### The option scrape (`cdpScrapeTaOptions`)

- **DISPATCHES a `scroll` event after each `scrollTop` set** — a HIDDEN react virtualizer does NOT
  re-render on a bare programmatic `scrollTop` (dom-patterns 2026-07-06).
- **Hops by the MEASURED mounted-window span** (viewport + overscan, ~2–3× `clientHeight`) → far fewer
  hops than viewport-sized steps, and reads the instant the mounted set changes (render-completion, not
  a fixed frame).
- **EXCLUDES `selectedItem` CHIPS when picking the option selector** and frame-polls until real leaves
  render — chips carry `role=option` too and mount before the leaves (the countryPhoneCode `0 options`
  bug; `role=option` → `promptOption` fallback).

### Closing a dropdown — confirm the options are GONE

**Every dropdown close — recon AND fill — confirms the portaled listbox/leaves are GONE**
(`optionCount` / `leafCount === 0`), **NOT merely `aria-expanded="false"`** (which flips the instant
Escape/commit fires while the options linger a beat unmounting and STAY CLICKABLE), before the next
field opens. Otherwise a lingering clickable option strays the next open-click (the live
"Landline → Phone Device Type" and degree→"Associates" strays).

Helpers: `closeAndVerifyBlank` (recon dropdowns) + `awaitTypeaheadClosed` (typeaheads).
**`closeDropdownConfirmed` gates the FILL path on options-gone on EVERY return that opened the list** —
the successful COMMIT, the commit-failed, the tier-KEEP, and the genuine-no-match (2026-07-06: it
previously gated on `aria-expanded` and the successful-commit path didn't close-confirm at all →
dropdowns raced under fast pacing).

## Input-lock (operator protection — deterrent + mitigation, NOT absolute)

While a fill runs: a visual overlay (`pointer-events:none`) + banner + capture-phase listeners swallow
the operator's events while `window.__apActing` ≤ 0. The 4 trusted-input primitives (`cdpClickAt` /
`cdpTripleClickAt` / `cdpKeyTap` / `cdpInsertText`) bump the COUNTER ±1 (clear-after-dispatch; a
counter, not a bool — the nested `cdpTypeChars→cdpKeyTap` stays correct).

Installed per page in `fillAndPersistPage`, removed in `finally` (no stuck lock).

**External detach mid-run** (native infobar "Cancel") strands the overlay — the `finally`'s
`removeInputLock` goes through `cdpEval`, which can't reach a detached page. So the
`chrome.debugger.onDetach` listener (cdp.js) tears it down via
`chrome.scripting.executeScript(cdpRemoveInputLock)` — **`world:"MAIN"` is load-bearing** (the overlay
was installed via `cdpEval` in the MAIN world, so `window.__apLock` isn't visible from the default
ISOLATED world). Cancel ⇒ detach **+ remove the lock banner**.

`onDetach` also writes a **`lastRunAbort`** storage marker (reason `operator-cancelled` when Chrome's
detach `reason==="canceled_by_user"`), CLEARED at the next `cdpAttach`, so a cancel-aborted run's errors
have a STATED cause — the SW log says "OPERATOR CANCELLED mid-run" and the summary page renders an
`abort-banner` explaining the incomplete/errored state.

The "started debugging" banner itself is Chrome's NATIVE infobar — X and Cancel BOTH detach and are
indistinguishable to the extension; the extension can't add/modify its buttons or make one "keep going."

The ~ms same-instant window is unavoidable — read-back + the M40 audit catch the rare slip. Every
trusted input logs `[ApplyPilot][INPUT]` (a keystroke-by-keystroke replay for debugging).

## Entry points

**Recon FIRST on any new tenant:**
`cdp-recon` (rect liveness, input/commit paths, latencies) · `cdp-repeat-recon` · `cdp-session-recon` ·
`RUN_CDP_RESUME_RECON` · `cdp-questions-recon` · `cdp-tree-recon`.

**Fill:**
**CDP fill FULL PAGE** (`RUN_CDP_FILL_PAGE` → `fillAndPersistPage`: fold + resume attach + audit +
bundle) · per-section buttons (websites / languages / education / certifications / work-experience /
date) · `cdp-source-fill` · `RUN_CDP_FILL` (flat) · the walk · `cdp-test-ai4` (staged-error remediation
harness) · "Clear summary" (resets the accumulated bundle) · "NO input-lock (baseline)".

**Verify:**
**review-page CHECK** (`RUN_CDP_REVIEW_CHECK` / `cdp-review-check`) — read-only reconcile of the review
page vs the saved summary, NEVER submits. See the `review-and-submit` skill.
