# Workday DOM Patterns

Running log of DOM patterns observed on real Workday application pages.
Used to drive field classification in the extension. Each entry is a
dated snapshot of one page — refutations of earlier assumptions are
tracked explicitly so the classifier stays honest about which signals
actually fire in the wild.

## How to use this file

**Do not read it whole (~314KB).** Find your topic below, then grep the entry's heading text verbatim
(headings are stable; the file is append-only, so nothing above your match moves) and read from there.

Entries are dated `## YYYY-MM-DD — title`, with `(b)`, `(c)`… suffixes for same-day entries. ⚠ The tail of
the file is **not strictly chronological** — the Workday and multi-ATS tracks were appended in parallel
during 2026-08, so a later date can appear above an earlier one.

### By subsystem

| Topic | Entries to grep |
|---|---|
| **Classifier / wrapper shapes** | `Classifier branches (current)`, `2026-05-27 — Comcast` |
| **Typeahead + `source` picker** | `2026-06-01 — US Bank`, `2026-06-14 — Magna wd3, HIDDEN tab: source picker`, `2026-06-14 — Magna wd3, HIDDEN tab: populated-typeahead OVERWRITE`, `2026-06-26 — FoS typeahead stray RESOLVED`, `2026-06-26 — typeahead EXIT redesign`, `2026-06-29 — Cert + source MERGED`, `2026-07-06 — Typeahead option scrape` |
| **Dropdowns + the commit race** | `2026-06-14 — Magna wd3, HIDDEN tab: dropdown commit must be TEXT-keyed`, `2026-07-06 — dup-language recon`, `2026-07-06 — Dropdown CLOSE race`, `2026-06-27 — Containment matching is AMBIGUITY-SAFE` |
| **Dates / spinbutton composites** | `2026-06-17 — Magna wd3, HIDDEN: dates wired into Education`, `2026-08-05 — waystar.wd1 Self Identify` |
| **Checkbox groups (OFCCP self-ID)** | `2026-07-25 — Caterpillar/Solar Turbines: the OFCCP disability self-ID`, `2026-08-03 (b) — the checkbox-group SET`, `2026-08-04 (b) — the self-ID checkbox group` |
| **SKILLS (multi-value typeahead)** | `2026-08-07 — SKILLS ("Type to Add Skills")`, `2026-08-07 (b) — SKILLS live`, `2026-08-07 (c) — SKILLS: the CONTAINMENT tier` |
| **Repeating sections + nested certs** | `2026-06-16 — Magna wd3, HIDDEN tab: repeating-section fill`, `2026-06-17 — Magna wd3, HIDDEN: Languages`, `2026-06-18 — Magna wd3, HIDDEN: nested cert Specialties`, `2026-06-18 — Magna wd3, HIDDEN: Work Experience`, `2026-07-01 — Magna wd3: nested specialty fkit node`, `2026-07-02 — Magna wd3: nested fields contaminate`, `2026-07-25 — Solar Turbines (cat.wd5): a section field's automation-id` |
| **CDP substrate / hidden-tab speed / pacing** | `2026-06-12 — Magna wd3, HIDDEN tab: CDP off-loop actuation`, `2026-06-19 — Magna wd3: foreground fast-fill`, `2026-06-20 — Magna wd3: reactive read-backs`, `2026-07-04..06 — Hidden-tab SPEED`, `2026-08-05 (c) — making a HIDDEN tab render`, `2026-08-05 — page 2 is slow because of TRUSTED INPUT` |
| **The M40 audit / false-verify class** | `2026-06-21 — Magna wd3: post-fill page AUDIT (M40)`, `2026-06-19 — Magna wd3: foreground fast-fill` |
| **Multi-page walk + error banners** | `2026-06-15 — Magna wd3: VPS ≠ validation error`, `2026-06-21 — M38 Part 3: the N-page walk loop`, `2026-07-01 — Workday error banner CONCATENATES`, `2026-07-25 — Solar Turbines: a phone-triggered SMS-consent checkbox REFLOWS the footer` |
| **Session death / maintenance page** | `2026-06-14 — Magna wd3: rect/focus retry`, `2026-06-14 — Magna wd3: session-expiry is NOT statically detectable`, `2026-06-27 — Workday PLANNED-MAINTENANCE page` |
| **Auth / onboarding / consent** | `2026-07-25 — Caterpillar: create-account consent`, `2026-07-25 — Caterpillar: the auth widget can OPEN on the Create Account view`, `2026-08-02 (d) — the prompt row, the contaminated sign-in box`, `2026-08-07 (d) — AUTOFILL WITH RESUME` |
| **Résumé attach** | `2026-06-03 — LiveRamp wd5 resume upload`, `2026-06-21 — Resume attach on the CDP path` |
| **Review page / reconcile** | `2026-07-07 — Magna wd3 REVIEW page` |
| **What Workday does NOT persist** | `2026-08-04 — waystar.wd1: what Workday does NOT persist`, `2026-08-04 (c) — HIDDEN runs: Workday rejects synthetic text/date` |
| **AI (LLM fills, tree drill, AI-4)** | `2026-06-22 — AI-0/AI-1`, `2026-06-23 — AI-4 remediation`, `2026-06-28 — Source tree-drill AI`, `2026-06-28 — Cert tree-drill AI`, `2026-07-02 — AI-4 live round 2` |
| **Input-lock** | `2026-06-22 — operator input-lock` |
| **Multi-ATS (Greenhouse / Lever / Ashby)** | `2026-07-31 — Greenhouse / Lever / Ashby application forms`, `2026-07-31 (b) — react-select on a HEAVY Greenhouse form`, `2026-07-31 (c) — pacing a page-side-synthetic fill`, `2026-08-01 (a)`, `2026-08-02 (a)`, `2026-08-02 (b)`, `2026-08-04 — a server-backed combobox says "No options"`, `2026-08-05 — multi-ATS end to end on GitLab`, `2026-08-05 (b) — four forms end to end`, `2026-08-07 — Greenhouse / Lever / Ashby: five observed-DOM findings`, `2026-08-07 (later) — are ATS option menus virtualized?`, `2026-08-08 — the 2.5s settle floor` |
| **Generic filler / non-Workday ATS survey** | `2026-08-11 — SEVEN non-Workday ATSs` (Workable · Breezy · SmartRecruiters · Teamtailor · Rippling + the Greenhouse/Lever controls; the DOM-vs-AX-tree experiment, honeypots, validation mirrors, label pollution, consent + bot-detection walls) · `2026-08-11 (b) — the generic scan is FREE` (scan cost 0.2–0.4ms, the options census, the heading-rung regression, the apply-GATE taxonomy, the operator's real queue, KEF Robotics/Wix) · `2026-08-11 (c) — THROUGH the apply gate` (real Dayforce + Paylocity forms: form grows after paint, label-only required markers, duplicate labels, opaque entry ids, multi-step) · `2026-08-12 — Phenom People` (never-hydrates blocker; UltiPro/NEOGOV job identity lives in the query string) |
| **Job discovery (LinkedIn / Handshake)** | `2026-07-30 — LinkedIn's SDUI jobs rewrite` |
| **Host / URL shapes** | `2026-07-22 — logged-in host is` |

### Tenants observed

Comcast wd5 · Cambium Learning · US Bank wd1 · LiveRamp wd5 · **Magna wd3** (the CDP proving ground) ·
Caterpillar / Solar Turbines (cat.wd5) · waystar.wd1 · marvell · moog — plus Greenhouse, Lever and Ashby
across many employers. **Probed read-only (not driven):** Workable · Breezy · SmartRecruiters ·
Teamtailor · Rippling (2026-08-11 generic-scanner survey).

**Add an entry when you test a new tenant**, and add its row to the table above.

## Conventions

- **Wrapper**: an element with `data-automation-id="formField-<name>"`.
  Every classifiable field on a Workday form sits inside one of these.
- **Companion input**: a hidden `<input>` Workday keeps alongside
  custom widgets (dropdowns, multiselects) so the form still posts a
  value. Not the user-facing control.
- **Fieldname**: the substring after `formField-`, e.g.
  `legalName--firstName`.

## Classifier branches (current)

These are the six wrapper shapes we can detect today. Order matters —
evaluate top to bottom and take the first match.

| # | Branch              | Distinguishing signal                                                                                  |
|---|---------------------|--------------------------------------------------------------------------------------------------------|
| 1 | Radio group         | 2+ descendant `<input type="radio">` siblings (with OR without a `role="radiogroup"` ancestor)         |
| 2 | Multiselect         | descendant with `data-uxi-widget-type="multiselect"`                                                   |
| 3 | Single-select       | descendant `<button aria-haspopup="listbox">` (OR `role="combobox"` — see refutation below)            |
| 4 | Textarea            | descendant `<textarea>`                                                                                |
| 5 | Plain text input    | exactly one descendant `<input>`, no buttons, no listbox/multiselect signals                           |
| 6 | Unknown / fallback  | anything that doesn't match above — log and skip                                                       |

---

## 2026-05-27 — Comcast Workday wd5, "My Information" step

- **URL pattern**: `comcast.wd5.myworkdayjobs.com/.../apply/applyManually`
- **Page**: "My Information" (step 1 of application)
- **Wrappers found**: 13 `formField-*`, all with required marker (`<abbr>`) consistent with the visible asterisks.

> **Correction (M9 step 1.5):** Page actually has 15 `formField-*` wrappers, not 13 — `preferredCheck` (checkbox) and `regionSubdivision1` (text, likely conditional on country) were missed in initial M3 inspection. Engine classifies and skips both correctly.

### Patterns observed

| Count | Pattern              | Example field names                                                              | Shape                                                                       |
|-------|----------------------|----------------------------------------------------------------------------------|-----------------------------------------------------------------------------|
| 7     | Plain text input     | `legalName--firstName`, `legalName--lastName`, `addressLine1`, `city`, `postalCode`, `phoneNumber`, `extension` | single `<input>`, no buttons                                                |
| 3     | Single-select dropdown | `country`, `countryRegion`, `phoneType`                                        | 1 `<button aria-haspopup="listbox">` + 1 hidden companion `<input>`         |
| 2     | Multiselect          | `source`, `countryPhoneCode`                                                     | `data-uxi-widget-type="multiselect"` container + 1 hidden companion `<input>` |
| 1     | Radio group          | `candidateIsPreviousWorker`                                                      | 2 naked `<input type="radio">` siblings, **no** `role="radiogroup"` wrapper |

### Refutations of earlier (Python spec) assumptions

- **`role="combobox"` did NOT fire** on any dropdown on this page. The
  only reliable signal for single-selects we saw is
  `<button aria-haspopup="listbox">`. The classifier must accept the
  button-based signal; `role="combobox"` may still appear on other
  tenants, so detection should treat it as a secondary OR-condition,
  not a primary requirement.
- **`role="radiogroup"` did NOT wrap the radio question** on this
  page. Detection by walking up from `<input type="radio">` and
  expecting a `radiogroup` ancestor would have missed the only radio
  field here. Corroborated separately: other Workday forms *do* use
  `radiogroup`, so the classifier must handle both — radios with and
  without a `role="radiogroup"` ancestor.

### Confirmed from Python spec

- The hidden companion `<input>` pattern beside custom widgets
  (single-selects and multiselects) is present exactly as the Python
  spec described. Filling the user-facing control is what triggers
  Workday to update the companion; do not try to set the companion
  directly.

### Radio group structure on this tenant (verified during M7)

The `candidateIsPreviousWorker` wrapper contains:

- A `<fieldset>` ancestor surrounding the radios — no `role="radiogroup"`.
- Two `<input type="radio">` siblings, each with:
  - A shared `name` attribute (group identity)
  - A unique `id`
  - **No** `role="radio"` (the implicit role from `type="radio"` is what screen readers use)
  - **No** `aria-label` on the input itself
  - CSS-hidden (visually clipped); not the visible click target
- A `<label for="<input.id>">` for each radio, sibling-or-near-sibling
  to the input. The label's `textContent.trim()` is the option name
  ("Yes" / "No") and the label is what the user actually clicks.

Implications for classification:

- Cannot rely on `role="radiogroup"` or `role="radio"` on this tenant.
- Cannot rely on `aria-label` on the input — the label text comes from
  the associated `<label for>` element.
- Grouping radios by shared `name` attribute is the reliable signal.

### Dropdown structure on this tenant (verified during M6)

The `phoneType` dropdown wrapper contains a `<button aria-haspopup="listbox">`
as the trigger. When clicked, an `<ul role="listbox">` is mounted —
**outside** the `formField-*` wrapper subtree (portaled to the body or a
sibling container). Implications:

- Don't query for the listbox inside the wrapper. Query at `document` level.
- Same applies to `[role="option"]` elements — they live with the
  portaled listbox, not inside the field wrapper.
- The listbox mount is asynchronous; poll for it (the extension's
  `waitFor` helper uses 50ms intervals, 5s ceiling).

### Open questions (not answered by this page)

- Do file-upload fields (resume) live inside a `formField-*` wrapper?
  Not present on the "My Information" step — verify on the next step.
- Do typeahead-style location pickers use the same listbox-button
  pattern as plain dropdowns, or a different widget? Not observed here.
- Does the `<abbr>` required marker ever appear on optional fields
  (decorative)? All 13 wrappers were required, so we can't yet say
  whether `requiredMarker` is a reliable required-vs-optional signal
  or just a "this page happens to require everything" coincidence.

---

## 2026-05-28 — Comcast wd5 "My Information": widget interaction details (M6–M8)

Same page as the 2026-05-27 baseline. This entry records how each widget
actually *behaves when driven*, learned while building M6 (dropdown),
M7 (radio), and M8 (typeahead).

### Dropdown — `phoneType`, `country`, `countryRegion`

- Trigger: `<button aria-haspopup="listbox">` inside the wrapper, plus a
  hidden companion `<input>`.
- Click the trigger → an `<ul role="listbox">` renders **at the document
  root** (portaled, not inside the wrapper).
- Options are `<li role="option">`. Skip `aria-disabled="true"` (the
  "Select One" placeholder is disabled). Match by text, **click by index**
  into the enabled set.
- After selection the trigger button's text updates to the chosen value —
  that's the verification signal.
- `role="combobox"` does **NOT** fire on this tenant (see 2026-05-27
  refutation). The button + `aria-haspopup="listbox"` is the only signal.

### Radio — `candidateIsPreviousWorker`

- Naked `<input type="radio">` siblings, **no** `role="radiogroup"` on this
  tenant (other tenants DO use it — detection must handle both).
- Grouped by shared `name`. Each input has a unique `id` and a
  `<label for="<id>">` carrying the visible text ("Yes" / "No").
- Input is CSS-hidden; **click the label**, verify via `input.checked`.

### Flat typeahead — `countryPhoneCode`

- Container has `data-uxi-widget-type="multiselect"`. The search box lives
  in a `monikerSearchBox` with `data-automation-hiddensearch="true"`
  holding `input[data-automation-id="searchBox"]`.
- **Open-before-find:** the searchBox isn't reachable until the widget is
  opened — click the opener first, then `waitFor` the input.
- Filters **live** as you type (Enter not required). Options
  `[role="option"]` render at the document root, formatted `"Name (+code)"`.
- Selection shows as a `[data-automation-id="selectedItem"]` chip — that's
  the read-back / verification signal.
- This is a **single-pick** typeahead in practice (one dial code), even
  though Workday tags the container `multiselect`. See vocabulary note below.

### Hierarchical picker — `source` ("How Did You Hear About Us?") — HANDLED IN M11

- The options are **expandable categories** drilling into sub-options, not flat
  selectable leaves — picking a value means expand-the-category, then pick a leaf.
- ⚠️ **Refuted (M11, 2026-05-30):** the earlier "same `searchBox` container as
  `countryPhoneCode`" note above was wrong / unverified. When actually driven, the
  `source` widget on the Cambium tenant is a **`button[aria-haspopup="listbox"]`
  (no searchBox)** — consistent with the classifier treating it as button+listbox,
  not a multiselect/typeahead. `fillSource` opens it, then **expand-walks**:
  level-1 leaf check, else expand each category and scan revealed sub-options.
- Candidate list is now **profile-driven**: `profile.how_did_you_hear` WINS, falling back to
  `application_defaults.how_did_you_hear` (`[...preferred, fallback "Other"]`), tried in order. On the CDP
  path a genuine no-match (AI on) runs a **two-prompt drill + scroll-enumerate + TYPED commit**
  (`tryInlineAiSource`) — DOM facts (operator, 2026-06-27): **typing does NOT drill** (it filters the WHOLE
  tree; a UNIQUE match autocommits), **clicking a category chevron drills it**, lists are **VIRTUALIZED**
  (scroll to enumerate every option), and the **same label can sit in multiple trees** (two "Other") so a
  typed filter shows >1 → commit the **TOP**. Flow: (1) `scrapeSourceRows` scroll-enumerates ALL categories →
  Prompt 1 picks one; (2) `expandCategory` drills it (the row is react-virtualized + BELOW the viewport fold →
  scroll the `promptLeafNode` into the clickable viewport + `elementFromPoint`-validate before the trusted
  click — see 2026-06-28) → `scrapeSourceRows` scroll-enumerates ALL leaves → Prompt 2 picks a SEEN leaf;
  (3) commit DIRECTLY on the still-open field — **focus → Ctrl+A+Delete → type the leaf → Enter** (autocommit
  unique / click-top tie); the `fillSourceCdp([leaf])` re-entry was dropped (`openSource` disturbs the settled
  view). The AI only types a leaf it SAW. Source does NOT use the cert click-in-drilled-view drill
  (`aiTreeFallback`) — its drilled "Other" is the CATEGORY chevron, which re-drills instead of committing
  (the "clicked into the other box but did not pick the other option" live bug). No categories →
  `needs_review` (never guess blind). (The earlier "policy, not profile" rule is RETRACTED.) LIVE-VERIFIED
  2026-06-28.
- Built to **discover-and-trace** (emits `sourceTrace` with stable per-row
  identifiers) so a failed run yields selectors, not guesses. Verified filling
  "LinkedIn" on Cambium — see the 2026-05-30 entry.

### Vocabulary reconciliation: "multiselect" vs "typeahead" vs true multi-value

- `countryPhoneCode` is tagged `data-uxi-widget-type="multiselect"` in the
  DOM but we handle it as a **single-pick typeahead**. Here "multiselect"
  (Workday's DOM term) and "typeahead" (our handler term) refer to the
  **same widget** — don't let the two names suggest two code paths.
- A **true multi-value multiselect** — one that accepts several chips at
  once — would be signalled by `role="combobox"` + `aria-multiselectable="true"`.
  We have **not** seen one on this page. When we do, it's a separate widget
  class needing add-each-then-confirm logic.

### Sequential-cleanup principle (closing the listbox is the sequence's job)

We spent significant effort trying to explicitly close the typeahead
listbox after selection — Escape on the input, Escape on
`document.activeElement`, and click-outside on a neutral target. None were
reliable, and clicking the field's own `<label>` actively **reopened** the
widget (its `for=` points at the search input, so the click refocused it).
Resolution: **don't close per-field at all.** In a multi-field run,
focusing the next field blurs the previous widget and dismisses its
listbox for free. Only the last field could leave one open, and that's
cosmetic. All the close code was removed (see commit history around M8).

### `listboxClosed` detection caveat

If you ever DO need to detect whether a listbox is closed: Workday leaves
**hidden** `[role="option"]` nodes in the DOM after close, so a bare
`document.querySelector('[role="option"]')` reports "still open" when it
isn't. Closed-detection must filter to **visible** options (non-zero
bounding rect, not `display:none`). This unreliable open-detection is part
of why we abandoned explicit close in favor of the sequential-cleanup
principle above.

### Matching strategy (summary — full rationale in CLAUDE.md)

Choice widgets pick from an ordered candidate list (most-specific first),
matched with a conservative ladder: (1) exact after `normalize()`,
(2) containment, (3) fuzzy **≥ 90 — typo tolerance only**, (4) escalate to
`needs-review`. No low-threshold fuzzy: a loose bar silently selects a
wrong value, the worst failure for an accuracy-focused tool. `normalize()`
lowercases, strips a trailing `(+digits)` suffix, and collapses whitespace,
so `"United States of America"` exact-matches the rendered
`"United States of America (+1)"`.

---

## 2026-05-30 — Cambium Learning Workday, "My Information" step (M10–M11)

First run on a **second tenant** (Cambium Learning, not Comcast wd5), via the
storage-backed active-tab engine. Headline: the classifier + all four handlers
filled **12 of 15** fields correctly with **zero code changes from the Comcast
tenant** — the `formField-*` model generalizes.

### `source` is button+listbox, not a searchBox typeahead (refutes 2026-05-28)
Driven for the first time in M11. `fillSource` reported `opener: "BUTTON"`,
`searchBox: false`, `sourcePath: "expand-walk"`, and filled **"LinkedIn"**
(`matchTier: exact-normalized`, `verified: true`). So `source` is a
`button[aria-haspopup="listbox"]` hierarchical picker with **no search input** —
the earlier "same searchBox container as countryPhoneCode" note was wrong.

### Two previously-uncatalogued fields identified (via the new `label` column)
- `preferredCheck` → label **"I have a preferred name"** — a checkbox, **now MAPPED to
  `personal_info.has_preferred_name`** (2026-06-30). Checking it (`has_preferred_name:true`)
  is a **CASCADE**: it reveals `formField-preferredName--firstName` +
  `formField-preferredName--lastName`, which the M1 cascade re-scan then fills (those two are
  mapped to `personal_info.preferred_first_name`/`preferred_last_name`). Live-verified on
  Magna page 1 → "John"/"Doe" filled deterministically (mapped ⇒ no AI). The reveal mounts a
  few seconds after the box is checked (same latency class as the Country→Local-Name cascade).
- `regionSubdivision1` → label **"County"** — a conditional text field (not a
  state subdivision as the name suggests). Currently `skipped (no mapping)`.

### Single-bare-candidate containment ambiguity did NOT fire here
With the profile supplying bare `"United States"` for both `country` and
`country_phone_code` (single candidate, no curated specific-first list), the
match ladder's containment tier correctly resolved:
- `country` → **"United States of America"**
- `countryPhoneCode` → **"United States of America (+1)"**

No territory mis-match (e.g. "United States Minor Outlying Islands") on this
tenant. The risk is real but unobserved; the **dial-code tiebreak** (use the
orphaned `personal_info.dialing_code` "+1" to prefer the `(+1)` option) stays
**parked** until it actually fires. `personal_info.dialing_code` is currently
dormant — no FIELD_MAP entry reads it.

---

## 2026-06-01 — US Bank Workday wd1, "My Information" step (M13 + source/isRequired fixes)

Third tenant (`usbank.wd1.myworkdayjobs.com`). Two findings changed code.

### `source` — a THIRD variant: searchBox that filters on ENTER; leaves are `promptOption` divs
Refutes both prior `source` shapes. Here `source` opens as a
`DIV[multiselectInputContainer]` with a real `searchBox` (`searchBox: true`,
`sourcePath: "search"`), but it does **NOT live-filter** while typing — you must press
**Enter** to filter, after which it renders a clickable result list.

The clickable result leaf (verified by manual DOM inspection) is:

```html
<div id="promptOption-…" data-automation-id="promptOption"
     data-automation-label="LinkedIn">LinkedIn</div>
```

- It is **NOT** `role="option"`. That role sits on a *sibling* `menuItem` div
  (`data-automation-id="menuItem"`), so a `[role="option"]` query targets the wrong node.
- The searchBox's `aria-controls` points at a `promptAriaInstruction` node (an ARIA
  live-region), **not** the option list — so aria-controls scoping is useless here.
- Nesting: a `multiselectlistitem` wrapper → inner div → the `promptOption` leaf.

`fillSource`'s **search** path was rebuilt against this (the **expand-walk** path for
Cambium is untouched):
- Scrape leaves as **`[data-automation-id="promptOption"]`** (visible-only); match the
  candidate against **`data-automation-label`** (then `textContent`) via the shared ladder.
- type → **full Enter sequence** (keydown/keypress/keyup) → **race-safe wait**: the
  visible-leaf count must change from the pre-Enter baseline AND hold stable across
  several reads + a minimum settle window. (A single row flashing in mid-render must not
  read as the final set — that partial-render bug made it match "Other" instead of
  "LinkedIn".)
- **Commit-gated**: confirm the click committed via the enclosing `multiselectlistitem`'s
  `data-uxi-multiselectlistitem-isselected` flipping `true` (backups:
  `data-automation-selected` / `aria-selected` / a `selectedItem` chip / companion input).
  A match that does NOT commit → `needs_review`, never a false "filled", and never a
  fall-through to a less-preferred option. Verified filling **"LinkedIn"**.

### Hidden cross-widget option contamination — visible-only scoping is necessary, not sufficient
Workday leaves **hidden option nodes from OTHER widgets** in the DOM. A page-wide scrape
during `source` fill captured the **countryPhoneCode typeahead's** options ("United States
of America (+1)") — the wrong widget entirely. Filtering to **visible** elements (rect size
+ computed style; **not** `offsetParent`, which is null for `position:fixed` portaled
popups) reduces this from "wrong widget" to "one stray phone-code row bleeds in". Harmless
for `source` (distinct labels — the match ladder ignores the stray), but **not 100%
isolated**: a future tenant with a `source` option whose text overlapped a phone-code value
could see interference. Noted, not fixed.

### `isRequired` — US Bank marks required with a BARE `<abbr>*</abbr>` (no title / no aria-required)
The marker is `<abbr aria-hidden="true" class="…">*</abbr>` — the asterisk is the abbr's
**text content**, with **no** `title="required"`, **no** `aria-label`, and **no**
`aria-required` on the control. The M13 detector (keyed on `abbr[title*="required"]` +
`aria-required`) therefore **missed all three dropdowns** — `country` ("Country*"),
`countryRegion` ("State*"), `phoneType` ("Phone Device Type*") — while text inputs and the
typeahead detected fine (they carry `aria-required`). This is the **dangerous direction**
(a required field reading `false`). Fix: `isRequired` now also accepts an `<abbr>` whose
text contains "*", plus a label/legend whose visible text ends with "*" (safe over-flag
direction). Optional fields (Middle Name, Address Line 2, "I have a preferred name", Phone
Extension) correctly stay `false`.

### `candidateIsPreviousWorker` question text names the entities that count
The "previously employed here?" question is verbose and **names the specific companies** that
the answer covers, not just the posting's company — e.g. US Bank:

> "Have you previously worked as an employee or contractor for U.S. Bank or any of its related
> companies including any affiliates, subsidiaries, or predecessor organizations such as
> **Elavon, U.S. Bancorp Investments, or Union Bank**? If yes, please answer the questions below."

and Ken Garff: *"Are you a previous **Ken Garff** employee (not a DNQ)?"*. So `jobContext.company`
("U.S. Bank") alone would miss a candidate who worked at a named subsidiary (Union Bank). The
matcher (`decidePreviousWorker`) therefore also **scans the question label** (`getLabel`) for the
user's `employment_history_companies`, via a **contiguous whole-word token-sequence** match
(`containsSeq`) gated by a distinctiveness check — multi-word names, or a lone word ≥5 chars not
in `GENERIC_SINGLE` — so a short/common employer entry ("Bank", "Tech") can't coincidentally hit
question boilerplate. A hit → "Yes" + **mandatory review** (it sits beside a truthfulness cert and
unfurls follow-up fields), with a detail naming the matched employer + signal. The scan reads the
user's KNOWN employers out of the question; it does **not** try to extract company names from the
prose (no LLM). Precision note: the token-sequence is exact, so "Union Bankshares" does **not**
match an employer of "Union Bank".

### Dropdown options must be scoped to the trigger's `aria-controls` listbox (M14.1)
Making the summary dropdowns editable (M14) exposed that `fillDropdown`'s page-wide
`[role="option"]` scrape was **contaminated by two distinct sources** — and visibility filtering
fixed neither (two rounds), because both contaminants are genuinely `visible:true`:

1. **Selection chips**, not options. A filled multiselect/source/phone-code renders its *selected
   value* as `<ul role="listbox" data-automation-id="selectedItemList"><li role="option"
   data-automation-id="selectedItem">…</li></ul>`. So "LinkedIn" (source) and "United States of
   America (+1)" (countryPhoneCode) are `role="option"` nodes page-wide — and visibly shown.
2. **A prior dropdown's listbox stays open.** Tracing with State open showed Country's listbox
   (`ctny0`, 250 options) still present alongside State's (`ctny1`, 61) — so State's page-wide
   scrape grabbed countries too. The previous dropdown is not dismissed when later fields fill.

**Cure (verified by trace, not assumed):** each dropdown trigger's `aria-controls` resolves to its
**own** options listbox — `country`→`ctny0` (countries), `countryRegion`→`ctny1` (states),
`phoneType`→`ctny2` (phone types) — confirmed by option counts + samples. `fillDropdown` now polls
for `document.getElementById(trigger.aria-controls)` (also the open-gate; a bare `ul[role="listbox"]`
wait can match a pre-existing `selectedItemList` chip list) and scrapes `[role="option"]` **within
that listbox only**. This excludes both the chips and the sibling dropdown's listbox. (Contrast
`source`, whose `aria-controls` pointed at a `promptAriaInstruction` node — so aria-controls is
verified per widget, not trusted blindly.) `settlePoll` (typeahead) additionally excludes
`[data-automation-id="selectedItemList"]` chips for the same reason.

---

## 2026-06-03 — LiveRamp Workday wd5, two-page walk (M15)

Fourth tenant (`liveramp.wd5.myworkdayjobs.com`). First run that crosses a **page
transition** — the SW-driven walk (fill page 1 → click Next → wait → re-inject → fill
page 2, hard 2-page cap). Recorded here are the *structural* findings the transition
mechanism depends on; the walk mechanics live in CLAUDE.md → Multi-page.

### Footer "Next" button
- `<button data-automation-id="pageFooterNextButton">Save and Continue</button>`, inside
  `data-automation-id="pageFooter"`. This is the advance control the SW clicks (via the
  injected `clickNext`). On later pages the **review page reuses this same automation-id
  for Submit** — hence the double-guard (`clickNext` refuses if `applyFlowReviewPage` is
  present; the orchestrator refuses to advance once `reviewPagePresent`). Not exercised
  here (the cap stops at page 2, well before review), but the guard is in place.

### ⚠️ The page container `applyFlowPage` is SHARED across pages — `pageId` does NOT distinguish them
The engine derives `pageId` from `[data-automation-id^="applyFlow"][data-automation-id$="Page"]`.
On LiveRamp **both** page 1 (My Information) and page 2 (My Experience) report the **same**
`pageId = "applyFlowPage"`. So a transition detector keyed on `pageId` alone would hang —
it never changes. What *did* change is the **`formField-*` set** (13 wrappers → 10, different
ids). This is exactly why `waitForNextPage` treats the page **signature** as
`url || pageId || formFieldIds` (any one differing = advanced): the **field-set delta is the
load-bearing signal**, with url/pageId as corroboration, not the sole basis.

### Page 2 = "My Experience" — mostly widgets the engine doesn't yet fill
The 10 page-2 wrappers (for reference — page-2 fill *quality* is a later milestone, not M15):
- `Job Title*`, `Company*`, `Location` → classify as `text` (the first two required, unmapped → `skipped`).
- `From*`, `To*` → classify as **`unknown`** (date-segment composites, not a single text input).
- `Role Description` → **`unknown`** (rich-text/textarea-ish).
- `I currently work here` → `checkbox`.
- `Type to Add Skills` → `typeahead`.
- `Upload a file (5MB max)*` → **`unknown`** (file upload — first file field observed; answers the
  2026-05-27 open question "do file uploads live in a `formField-*`?" → **yes**, as `unknown`).
- `LinkedIn` (a websites/social URL) → `text`.

These are the multi-instance/Add-section, date-composite, and file-upload widgets the current
classifier+handlers don't target — all correctly `skipped`/flagged, none mis-filled. Mapping +
handlers for them are a future milestone.

### `source` took the **search** path here
Page 1's `source` filled "LinkedIn" via `sourcePath: "search"` (the US-Bank-style ENTER-filter
variant), `status: filled` — consistent with the 2026-06-01 entry, no new code needed.

---

## 2026-06-03 — LiveRamp wd5 resume upload: programmatic ATTACH proven (M16.1)

The page-2 "Upload a file (5MB max)*" widget (the `unknown` required field from M15) **can be
filled by an injected function** — proven live. This records the widget DOM and the technique
that works, so the round-2 real-resume handler is built on fact.

### Widget DOM
- Wrapper: `<div data-automation-id="formField-" data-fkit-id="resumeAttachments--attachments">`
  — the automation-id's fieldName is **empty** (just `formField-`), so the classifier sees
  `unknown`; **`data-fkit-id` is the stable identifier**, not the automation-id.
- Hidden input: `<input data-automation-id="file-upload-input-ref" type="file" multiple>` —
  **`accept` is null** (no client-side type filter), `disabled:false`, **`display:none` but
  present in the DOM before any interaction** (no need to click "Select files" to reveal it).
- Section chrome: `attachments-FileUpload` → `file-upload-drop-zone` (the dropzone; holds the
  `select-files` button) → the hidden `file-upload-input-ref`.

### The attach technique that WORKS (Playwright's `set_input_files` does NOT port)
An injected function has no filesystem, and a `File` can't cross `chrome.runtime` message-passing
(serializes to `{}`). So the file is **rebuilt in the page context** and attached via a synthetic
`DataTransfer`:
1. base64 → bytes (`atob` → `Uint8Array`) → `new File([bytes], "name.pdf", {type:"application/pdf"})`.
2. `const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files;`
3. dispatch `new Event("change", {bubbles:true})` (and `input`).

Verified on LiveRamp: `filesSetImmediately:1` (browser accepted the programmatic set) and Workday
rendered its confirmation row with the filename. **No drop-event fallback needed** — the
input-path `change` fires Workday's React `onChange` (delegated; not visible via `getEventListeners`).

### 🔑 Success signal = the confirmation ROW, not `input.files`
**Workday XHR-uploads then RESETS `input.files` to 0** (recon: `filesLengthAfter:0`) — so
`input.files.length` is NOT a success check. After upload the section grows a confirmation row:
- `file-upload-item` (the row — renders for the file) → `file-upload-item-name` (filename),
  `file-upload-successful` (the **completion** marker), `delete-file` (the remove button).
- ⚠️ **Round-2 note:** M16.1's poll matched `file-upload-item` *before* `file-upload-successful`
  appeared. `file-upload-item` also renders for **in-progress / errored** uploads, so a true
  *succeeded* confirmation should gate specifically on **`file-upload-successful`** (and treat a
  long-lived `file-upload-item` without it as in-progress/failed).

### Environment
Top frame, `iframeCount:0` — frame-0 injection reaches the widget directly.

## 2026-06-12 — Magna wd3, HIDDEN tab: CDP off-loop actuation (M24 recon + simple-widget port)

Recon + live fill with the window MINIMIZED end-to-end (chrome.debugger attached, all input
issued as CDP commands from the service worker). What hidden-tab Workday actually does:

### Throttling: what freezes and what doesn't
- Page timers throttle to ~1Hz hidden, then deep-freeze (Δperf 60–140s in the diagnosis
  runs) — page-injected fill stalls. A PASSIVE chrome.debugger attach does NOT relieve the
  throttle (tested: Δperf stayed ~1000ms while attached).
- CDP `Input.*` and `Runtime.evaluate` execute PROMPTLY while hidden — they run off the page
  loop. But Workday's debounced REACTIONS (filter/fetch/render) are page-side and stay
  throttled → every "did it commit" wait must be generous SW-side wall-clock. Δperf ~1000ms
  during a CDP run is EXPECTED, not failure.

### Layout is LIVE while hidden
- getBoundingClientRect returns real non-zero coords hidden — in-flow widgets (input 344×40,
  dropdown trigger 344×40, radio label 35×20) AND the portaled option popup. Viewport keeps
  real dimensions (1301×597 observed minimized).
- `scrollIntoView({behavior:"instant"})` works hidden. Smooth scrolling is rAF-driven and
  rAF IS frozen hidden — never use it.

### Text input (CDP)
- `Input.insertText` into the FOCUSED input fires trusted `beforeinput`+`input`, sets the
  value, and the value SURVIVES blur → React registered it. This is the text method.
- Trusted Ctrl+A + Delete clears; per-char keyDown(text)+keyUp also works (held in reserve).
- Focus lands via a CDP coordinate click on the input.
- ⚠ React re-renders ORPHAN held nodes/listeners (a probe's event counters read all-zero
  after a re-render while the typed value persisted) — re-resolve every element fresh from
  document on each read/actuation; never hold a reference across steps.

### Dropdowns (CDP)
- Mouse click on the trigger opens. Options render ATOMICALLY (country: 249 on the first
  read, zero growth across a 3s tail) — a 2-consecutive-equal-reads settle bar suffices.
  BUT a cold lazy list took ~5.6s to populate hidden → open budget 20s.
- ⚠ THE URUGUAY PITFALL: a coordinate click at an out-of-view option's rect lands OUTSIDE
  the popup's visible scroll area → outside-click DISMISSAL (listbox closes, nothing
  commits). CDP clicks a COORDINATE, not an element — Playwright's element click
  auto-scrolled and hid this. Do NOT type-then-click.
- ✔ The commit that works: native type-to-jump (typed chars move `aria-activedescendant`,
  and the highlighted option's text is readable) → verify highlight == matched target →
  Enter (~325ms commit). Arrow keys move the highlight one enabled option per press (the
  verified correction walk when the jump lands wrong). Commit gate = trigger display text.
  Live: country / countryRegion / phoneType all committed this way (`enter-commit`).
- Keyboard open also works (focused trigger + Enter; ~330ms warm).

### Radio / checkbox (CDP)
- Coordinate click on the `<label for>` commits in ~310ms (radio and checkbox).
- Focused input + Space also commits (radio ~620ms, checkbox ~310ms) — the fallback path.

### Lifecycle
- ONE debugger client per tab: page DevTools open on the same tab kills the attach; an
  external detach fires chrome.debugger.onDetach (clear tracked state, don't re-detach).

## 2026-06-12 — Magna wd3, HIDDEN tab: CDP typeahead port (M25)

The proven typeahead brain (per-candidate tier walk, transition-aware settle, banner hard
block, chip-only commit signal) ported to the CDP substrate, live-verified hidden
(countryPhoneCode on page 1; Field of Study on page 2).

### Option scope + filter
- The searchBox carries NO aria-controls on Magna typeaheads (null in every read) — the
  page-wide visible `[role="option"]` scrape EXCLUDING `selectedItemList` chips is the
  working scope (the M22 settlePoll rules).
- Enter-filter (typing alone does not filter); the filtered response lands ~810–860ms
  hidden (one throttled tick + fetch).

### Banner + the stale-banner rule
- No-match banner = leaf `[data-automation-id="promptTitle"]`, text "No matches found".
  On countryPhoneCode it CO-OCCURS with the re-rendered fallback window (17 visible of
  ~249 — the option list is VIRTUALIZED; the window is what is painted). Matching against
  that still-rendered list was the historic false-fill — banner = hard block.
- A STALE banner SURVIVES clearing the search input (the list stays rendered too). The
  settle must key terminal-banner on a FRESH change since the current candidate's own
  Enter — otherwise candidate N+1 inherits candidate N's banner.

### ⚠ A "No matches found" banner DROPS searchBox focus → focus hygiene per candidate
- Verified hidden: after candidate-0 banners, the NEXT candidate begins with the searchBox
  UNFOCUSED (`searchBox.focused:false`). With focus on the document, our per-candidate
  `clearSearch` (Ctrl+A + Delete) selects the WHOLE PAGE instead of the field (operator saw
  it), the field never clears, and the typed query never lands — so the list does NOT
  filter to the new candidate.
- The widget does **type-ahead-to-HIGHLIGHT** on the currently-showing list (a keystroke
  highlights the option starting with that letter; "f"→Falkland Islands, "1"→first "+1"
  row), and **Enter commits the highlighted row**. Blind post-focus-loss actuation =
  Ctrl+A→page, query never lands, highlight stays on row 0, the bare filter-Enter commits
  row 0 → a STRAY wrong value (live: "Afghanistan (+93)", row 0 of the full list). This is
  NOT our commit code (no commit action ran) — it is the widget's highlight+Enter.
- Fix shipped (M25): re-assert + READ-VERIFY searchBox focus BEFORE every candidate's
  clear/type (re-open if it unmounted, then `focusSearchBox`); if focus can't be confirmed
  → `needs_review` "could not focus the search field — not actuating blind", STOP — never
  blind Ctrl+A / type / Enter. (`clearSearch`'s Ctrl+A is correct — it clears the FIELD; it
  only mis-fired onto the page because focus was already lost — symptom, not cause.)
  Honesty: a final chip read so a record never reports `after:null` when the page
  physically holds a value; an uncommanded stray is flagged for review.

### Commits — what actually works hidden
- SINGLE exact match: AUTO-COMMITS on the filter-Enter itself (~600–850ms). ⚠ The chip can
  carry the FULL option name, not the typed query ("CPP" → chip "Certified Payroll
  Professional (CPP) - Multiple Recognized Providers") — an auto-commit is accepted only
  when the chip normalize-equals the candidate; anything else → needs_review, never a
  silent accept.
- MULTI-match: NO highlight ever arms under CDP-injected typing — aria-activedescendant
  read null in every recon and live read, with BOTH Input.insertText and per-char trusted
  keystrokes — so the spec-era "second Enter commits the highlighted first option" does
  NOT hold on this substrate (it was a human-typing observation); the commit-Enter no-ops.
  ✔ What works: a TRUSTED CDP CLICK on the matched option (text-keyed re-resolution +
  scrollIntoView + fresh rect) — the page-substrate isTrusted wall does not apply to CDP
  input. ⚠ SCOPE OF THE CLAIM: click-commit is proven on SHORT filtered lists only (2
  options, match inside the painted virtualized window). A long filtered list with the
  match scrolled outside the rendered window is the same coordinate-into-virtualized-list
  condition that failed in the dropdown recon ("Uruguay") — long-list / scrolled-match
  commit is UNTESTED, an open question for the chip-overwrite milestone.
- Pre-filled KEEP proven live: a chip that normalize-matches a candidate is KEPT with
  ZERO actuation — and in the same run a same-value Country re-commit ran upstream and
  the kept chip SURVIVED (a same-value re-commit does NOT reset dependent state).

### The chip
- Commit signal = `[data-automation-id="selectedItem"]` whose text == the committed
  value; its aria-label says "…press delete to clear value"; the chip subtree contains
  `[data-automation-id="DELETE_charm"]` — the handle for a future overwrite milestone.
- The listbox AND the searchBox self-unmount after a commit — no close workaround needed.

### ⚠ Certification on Magna is a TREE picker, not a flat typeahead (tenant-variant)
- Its popup shows expandable parent nodes with chevrons ("Multiple Recognized Providers",
  "Previous Place of Employment", "Workday") — the hierarchical/source family. On
  LiveRamp the same field is a FLAT typeahead (M23a) — tenant-variant, like source's
  three shapes.
- The classifier keys "hierarchical" to fieldName === "source" by NAME only; tree-ness is
  a POPUP-content property invisible on the wrapper (identical multiselect chrome), so
  Magna's certification classifies as "typeahead" and the flat brain can reach it via the
  targeted harness (page-2 repeating fields never reach the flat page fill). The chip
  gate CONTAINED it: the search-driven auto-commit of a tree leaf was flagged
  needs_review, never silently accepted.
- A bogus query on this field timed out (25s; no fresh transition, no banner detected) —
  cause UNDETERMINED (tree behavior vs a banner shown without a list re-render). To be
  resolved by the tree-picker recon when source/certification get their CDP milestone; no
  settle change was shipped on this evidence.

### Page/locale notes
- Country=Afghanistan adds `legalName--firstNameLocal`/`--lastNameLocal` fields (scanned
  and honestly skipped as unmapped) — the page FIELD SET varies with the Country value.
- countryPhoneCode sits inside `data-fkit-id="phoneNumber--null"` on page 1 — do not
  generalize the repeating-section guard to all `--null` containers.

## 2026-06-14 — Magna wd3, HIDDEN tab: source picker is a SEARCH typeahead (M26)

The "How did you hear about us?" `source` field (the deferred "tree" class) is — on Magna —
just a SEARCH typeahead, handled by the M25 walk with source-specific reads (fillSourceCdp).

### Structure — categories on open, but typing bypasses them
- On open the listbox shows ~13 CATEGORY rows: `<div role="option" data-automation-id="menuItem">`
  with a chevron (Billboard/Radio, Career Fair, … Social Media, Website/Digital). These are
  `isCategory` (chevron svg). LinkedIn is NOT a top-level row.
- BUT typing into the searchBox + Enter FILTERS straight to the matching LEAVES — no category
  drill needed. So source is driven exactly like the typeahead: type → filter → auto-commit /
  click the matched leaf → next candidate on no-match.

### Leaves + scope (differs from the typeahead)
- Result leaves are `<p data-automation-id="promptOption" data-automation-label="LinkedIn">`
  (NOT `role="option"` — that role is on the category menuItem). Match on `data-automation-label`
  then textContent.
- searchBox `aria-controls` is NULL (not even the promptAriaInstruction decoy) → page-wide
  `promptOption` scrape.
- ⚠ CHIP CONTAMINATION (cost a recon round): a committed chip ELSEWHERE on the page embeds a
  `promptOption` P (e.g. countryPhoneCode's chip "United States of America (+1)"). A bare
  page-wide promptOption scrape catches it → the source's "filter result" reads as the other
  field's chip, and the settle breaks instantly on it. FIX: exclude
  `.closest('[data-automation-id="selectedItemList"]')` from the scrape (the M14.1/M22 rule).

### Commit signal + what fired live
- The matched leaf sits in a `<… data-automation-id="promptLeafNode" data-uxi-multiselectlistitem-isselected="false">`
  that flips to `"true"` on select; OR a `selectedItem` chip appears in the source wrapper.
  fillSourceCdp accepts EITHER.
- Live (LinkedIn, hidden): single-exact match → AUTO-COMMITS on the filter-Enter (chip
  "LinkedIn", verified, ~500–1000ms) — same as countryPhoneCode. So the auto-commit/chip path
  fired; the `promptLeafNode`-isselected verify and the multi-match TRUSTED-CLICK are
  unit-tested but NOT yet live-proven for source (auto-commit short-circuited them — reachable
  with a how_did_you_hear value that filters to several leaves).
- An infobar `canceled_by_user` external-detach mid-run is handled (detach-in-finally + the
  onDetach listener); the retry attaches clean.

### Still deferred
- The tree/EXPAND-WALK source shape (NO searchBox → chevron categories you click to reveal
  sub-leaves) and Magna's Certification TREE — only needed when a tenant without a searchBox is
  observed; the in-tree page-substrate fillSource still covers the expand-walk on the page path.

## 2026-06-14 — Magna wd3, HIDDEN tab: populated-typeahead OVERWRITE model (M27 Step 0 recon)

Probe (`runCdpOverwriteRecon` / `RUN_CDP_OVERWRITE_RECON`) on `countryPhoneCode` with a HAND-SEEDED
WRONG chip "Åland Islands (+358)"; profile candidate "United States of America (+1)". Tab minimized.
This is the OPPOSITE of the M25 TA-RECON (which targets a chipless field): it answers whether an
already-committed typeahead can be overwritten NON-DESTRUCTIVELY.

### (a) Search-while-populated — TRUE
- Opening a single-pick typeahead that ALREADY holds a chip exposes a usable searchBox:
  `present: true, visible: true, focused: true` (focusedBy `opener-click`, openMs 370). The chip
  stays present while the searchBox is open. So you do NOT delete-first to re-fill — you search
  over the populated field.

### (a2) clearSearch preserves the chip — TRUE
- `cdpSelectAllDelete` (Ctrl+A+Delete) on the EMPTY searchBox with a chip present LEFT the chip
  intact ("Åland Islands (+358)" before and after; searchBox value `""`). So the per-candidate
  clear in the walk is safe with a committed chip — no reordering needed.
- NOTE: proven on the TYPEAHEAD widget only. `clearSourceSearch` is the byte-identical primitive
  (`() => cdpSelectAllDelete()`) but its chip-preservation on the SOURCE widget is not yet
  live-proven — verify when the source overwrite path is exercised.

### (b) Commit REPLACES (single-pick), does NOT add — verdict REPLACE
- Type the candidate → filter-Enter → at t=419 the chip still read "Åland Islands (+358)"
  (`differs:false`); at **t=835 the field held ONE chip "United States of America (+1)"** — the new
  value REPLACED the old (auto-commit on the exact single match, ~835ms hidden). `finalChipCount: 1`,
  `containsSeeded: false`, `containsCand: true`.
- ⇒ **No residual-chip cleanup / DELETE_charm primitive needed** (the M27 "Commit C" was dropped).
  A defensive single-chip assertion catches a hypothetical tenant that ADDs instead.

### Validates the transition-aware commit detection (M27 Commit B)
- The series shows the chip set EQUAL to `priorChips` at t=419, then DIFFERENT at t=835. The existing
  walk's bare `chips.length > 0` check would have falsely fired on the pre-existing chip at t=419.
  The fix: recognize a commit only when the NORMALIZED chip set differs from `priorChips` (captured
  once before the walk), sampled inside the existing settlePoll — confirmed correct by this series.

### Accepted destructive edge (M27, by design — see overwrite-stray)
- The non-destructive guarantee holds on clean walk-exhaustion (original chip kept). It does NOT
  hold if, mid-overwrite, an auto-commit substitutes a DIFFERENT wrong value (overwrite-stray):
  because commit REPLACES, the original is gone and unrecoverable on the page. Accepted: the
  original was already wrong, no candidate exists to restore it, and the field is flagged
  needs_review either way. The walk STOPS on the stray (contamination rule) — later candidates
  are not tried.

### Source widget — SAME model (recon, gate for Commit B's source path)
Probe (`runCdpSourceOverwriteRecon` / `RUN_CDP_SOURCE_OVERWRITE_RECON`) on `formField-source` with a
hand-seeded WRONG chip "Family"; candidate "LinkedIn" (from `defaults.how_did_you_hear`). Tab minimized.
- **(a) searchBoxUsableWhilePopulated: true** — with "Family" present, opening exposed the searchBox
  present+visible+focused (focusedBy `page-focus()`, openMs 401).
- **(a2) clearSourceSearchPreservesChip: TRUE** — `clearSourceSearch` (= the byte-identical
  `cdpSelectAllDelete`) left "Family" intact, searchBox value "". So Commit B's source no-match
  resting-state stands on a proven primitive, not assumed symmetry.
- **(b) REPLACE** — typing "LinkedIn" → filter-Enter → single chip "LinkedIn" at t=402 (auto-committed
  on the single-exact match; `leafCount:0`). Source overwrite-success can fire via auto-commit.
- Verdict: source is SYMMETRIC to the typeahead — the overwrite walk applies in lockstep.

## 2026-06-14 — Magna wd3, HIDDEN tab: dropdown commit must be TEXT-keyed, not type-jump (M28)

Bug found in a full-page CDP fill: the **country** dropdown failed to commit when it was already on a
value sharing the target's first letter (started on "United Arab Emirates", profile "United States of
America") → `needs_review` "could not verify highlight"; country stayed wrong; the dependent
`countryRegion` (State) then showed Emirate vocab → "no candidate matched". Started on "Select One" it
worked. So a stale-but-plausible starting selection broke the fill.

### Why type-jump + arrow-walk failed
- **Native listbox type-ahead cycles on a same-prefix selection:** with the active option already
  starting with the typed letter, pressing "u" jumps to the NEXT "U" item, not the first. And hidden-tab
  throttling breaks the multi-char buffer ("u"→"n"→"i") between keystrokes → the highlight lands far from
  target (observed: wandered toward "N").
- **The counted arrow-walk** (`maxArrowSteps` cap 60) can't cross a ~249-item list from a wrong landing.
- **Worst:** on a failed highlight the code returned `needs_review` BEFORE the scroll+click fallback ran
  (the fallback was gated behind the highlight verifying) — the one deterministic mechanism never fired.

### The fix — text-keyed scroll+click (TEXT, not index)
- `cdpDropdownOptionRectByText(wrapperSel, text)` resolves the option **within the trigger's
  `aria-controls` listbox** (chips / other listboxes excluded; skips `aria-disabled` placeholder) whose
  trimmed `textContent` == target, `scrollIntoView({block:"center"})`, returns the rect; `cdpClickAt`.
- Deterministic regardless of the starting selection; **no type-jump cycling, no arrow counting, no
  scrape-order==DOM-order index assumption** ("not virtualized" — full 249 list IS in the DOM — does NOT
  guarantee order parity, so text-keying removes the assumption at the source).
- Verify gate TIGHTENED to **exact-normalize** (a substring trigger can't false-pass). Backstop: a fresh
  read confirms the target is still present pre-click; a `fullIdx` desync canary is logged (non-fatal,
  text-keyed click can't mis-click). One retry, then `needs_review` — never a wrong/silent commit.
- The earlier "Uruguay pitfall" (out-of-view coordinate-click dismisses) is handled by the option's own
  `scrollIntoView` before the click; live-verified the click commits a deep same-prefix target.

### Live result (country pre-set "United Arab Emirates", normal session)
- `country` → `filled` "United States of America" (`text-click-commit`); `countryRegion` → `filled`
  "Florida" (cascade cleared); 0 needs_review, 0 errors.
- **Name-fields finding:** the extra/erroring local/middle-name boxes seen in the BUGGY run were revealed
  by the WRONG country (UAE) committing — with the correct country (US) NONE appear. So those weren't an
  engine gap; they were downstream of the dropdown bug. `legalName--firstNameLocal`/`lastNameLocal`
  remain `skipped: no mapping` (a separate, low-priority mapping gap).

## 2026-06-14 — Magna wd3: rect/focus retry (M29) + the reliability cause is SESSION LOGOUT

### M29 — retry one-shot rect/focus reads (cdp.js)
- `cdpRectReady(sel, scroll)` polls `cdpRectOf` SW-side until a non-zero layout box (≤2.5s / 150ms);
  `focusText` retries its whole ladder until the input is focused or the ceiling; `openDropdown` /
  `clickRadioLabel` / the checkbox label read go through it. Logs `RECOVERED` / `gave up` ONLY when the
  retry actually polled (clean runs are silent) — a diagnostic for the intermittent field-drops.
- Rationale: while hidden the page reacts on the ~1Hz loop, so a one-shot `getBoundingClientRect` can
  catch a not-yet-laid-out element → 0-rect → the actuation errored on a single bad tick. Polling
  absorbs a genuine transient; a truly-absent element still `gave up` after the ceiling (same safe
  outcome, now logged + bounded). Happy path = first read (no added latency).

### REFRAME — the field-drops are most likely SESSION LOGOUT, not throttle-transient
- Live: after the form sat / a manual logout, **`source` ("How did you hear about us?") did not load**
  → "no source candidate produced a verified commit". That field's options are **server-loaded**; a
  logged-out session can't fetch them, so they never render.
- This strongly implies the earlier scattered field-drops (`legalName--firstName` "could not focus
  input"; `countryRegion` "trigger rect dead") were the SAME logged-out symptom — a server-rendered /
  re-rendering element that never laid out — NOT a throttle-transient rect read. M29's retry can't fix
  that (it can't conjure un-fetched content); it just makes the failure logged + bounded. A `gave up`
  log on the next logout will CONFIRM "session-gone, not transient".
- Also observed: **Save & Continue → four `Error-Page Error — Error Code: VPS|…` banners** (top of
  page) — likely session/validation-related; for the page-advance + session round.
- ⇒ The real reliability win is **session-expiry detection** (surface "refresh + log in + reopen"),
  deferred to its own round; M29 is the smaller transient-sliver hardening + the diagnostic that
  motivates it.

## 2026-06-14 — Magna wd3: session-expiry is NOT statically detectable (M30 recon) → source-liveness heuristic

`RUN_CDP_SESSION_RECON` (read-only `cdpReadSessionState` snapshot) run on a VALID form and on a
LOGGED-OUT / timed-out form. The two snapshots are **DOM-identical**:
- `formFieldCount` 14 both; `applyFlowPagePresent` true both; `passwordInputPresent` /
  `signInButtonPresent` false both; `authUrl` false both; `sessionBanner` / `vpsErrorPresent` false
  both; same `url` / `title`; and the candidate **email (`wangykev@gmail.com`) still renders in BOTH**.
- A timed-out Magna page keeps the whole form client-rendered — there is **NO static marker** to gate
  on. The planned static `classifySession(snapshot)` is impossible here.

### What IS observable — behavioral only
- On a dead session, **server-loaded content doesn't render**: typing into `source` ("How did you hear
  about us?") returns no leaves (`leafCount` stays 0) → "no source candidate". (Bundled content like the
  country list still fills — so it's not uniform; `source` is the sensitive canary.)
- **Save & Continue → many `Error Code: VPS|…` banners** — the UNAMBIGUOUS server signal, but it only
  appears on the page-advance action (deferred to that round).

### M30 ships — source-liveness early-warning (heuristic, NOT general detection)
- `fillSourceCdp` tracks `optionsEverLoaded` (any settle read with `leafCount > 0` or a chip) and returns
  `optionsLoaded` on the walk-end no-commit. `drivePageFill` raises ONE `sessionWarning` iff the source
  record is `needs_review` AND `optionsLoaded === false`. NOTE, never a halt.
- **Scope is narrow + honest:** fires ONLY on pages with a `source` field, via its options failing to
  load. No `source` field → no warning (no false positive, no coverage). A matching miss (leaves loaded,
  candidate absent) → no warning (false-positive guard, unit-tested). Reliable detection = the VPS
  signal on Save & Continue, in the page-advance round.
- **M30 is LIVE-VERIFIED** (2026-06-15): on a dead session the `⚠⚠ Likely session expired …` warning fired
  (source `needs_review`, all other fields filled).

## 2026-06-15 — Magna wd3: VPS ≠ validation error (M31 gate) + CDP guarded page-advance

### The session detector is separable from ordinary validation (recon GATE — passed)
Both snapshots captured POST-Save&Continue:
- **LIVE session + a required field empty** (validation error): `vpsErrorPresent: false`, `errorPageText: null`,
  `sessionBanner: false`; `errorMarkers` = the field-level "The field … is required …" only. Workday shows
  a top "Errors Found" banner + a field-level error — NO `VPS|` code.
- **DEAD session + Save & Continue:** `vpsErrorPresent: true` (multiple `Error Code: VPS|<uuid>` in
  `errorPageText`), `sessionBanner: false`.
- ⇒ **`vpsErrorPresent` (the `Error Code: VPS|` banner) is the CLEAN discriminator** — present only on a
  dead session, absent on a live validation error. `sessionLooksDead` keys off it (+ `sessionBanner` +
  login markers + no-form), and DELIBERATELY NOT off `errorPageText`/`errorMarkers` (a validation error
  sets those). ⚠ **One-tenant / one-pair proof (Magna):** if another tenant's validation errors ever carry
  a VPS-like code, this guard needs re-checking — don't generalize "separable on Magna" to "everywhere".

### CDP guarded page-advance (M31)
- `clickPageNext` (cdp.js): refuse if `applyFlowReviewPage` present (footer `pageFooterNextButton` is
  Submit on review — the double-guard), else `cdpRectReady` the button + `cdpClickAt`.
- **The CDP attach SURVIVES the Save & Continue navigation** (only Runtime+DOM enabled, no Page domain) —
  no re-injection; `cdpWaitNextPage` just re-reads via `cdpEval` on the same attach: a dead-session check
  FIRST (`sessionLooksDead` — a dead session shows VPS on the SAME page, no transition), else a hydrated
  page-signature change (`url` + sorted formField-name set; field-set delta is load-bearing, steady across
  2 reads). `runCdpWalk` = fill page 1 → guarded advance → halt-on-dead / "advanced (page-2 deferred)" /
  nav-timeout DIRTY-STATE (clicked, no advance, no error → page 1 may be dirty; eyeball, don't re-scan fresh).
- **Page-2 fill is OUT** (My Experience = repeating sections, deferred on CDP) — the walk is one transition:
  the session detector + the guarded-advance foundation, not a useful page-2 fill.

### Live results (2026-06-15) — all confirmed
- **Advance:** live session → page 1 filled, `clickPageNext {clicked:true}`, transition detected → "advanced
  to page 2 (page-2 fill deferred)". Browser **Back restores page 1 with state intact** (the advance is
  safely reversible).
- **Dead-session detector:** logged-out session → page 1 filled (cached), Save & Continue → `sessionLooksDead`
  caught the VPS → "⚠⚠ SESSION EXPIRED" halt, no advance.
- **Validation false-positive guard:** live session with a required field empty (blanked
  `personal_info.first_name` so the walk SKIPS it + hand-cleared the field — needed because the walk
  re-fills and most page-1 fields are account-pre-filled) → Save & Continue → validation error, no advance,
  no VPS → **`nav-timeout` DIRTY-STATE, NOT "session expired"** → `sessionLooksDead` stayed alive end-to-end.

### M31.1 — dirty-state / session-expired reports print the EXACT errors + profile gaps
For future-AI page-debugging: the nav-timeout and session-expired stops now log `errorMarkers.samples`
(the field-level "…is required…" texts) + `errorPageText` (VPS/Error-Page text), AND the fields the walk
left EMPTY because the profile/JSON has no value (`results` with `status:"skipped"` + their detail — e.g.
"empty value at personal_info.first_name") — the likely cause of a "required" validation error. Returned
as `page_errors` / `error_page_text` / `empty_fields` on the walk result too.

## 2026-06-16 — Magna wd3, HIDDEN tab: repeating-section fill on CDP (M32 — Websites proven, dates BLOCKED)

Page 2 ("My Experience") repeating-section recon (`RUN_CDP_REPEAT_RECON` → `cdpRepeatingScan`) + the
Websites fill port (`driveRepeatingSectionCdp`). Sections seen live: workExperience- (3), education- (2),
webAddress- (3), language- (3), certification- (2).

### Date spinbuttons ARE actuatable on CDP — the M32 "blocker" was a PROBE ARTIFACT (M33, 2026-06-16)
The first M32 probe reported dates "unactuatable" — but it (1) targeted `dateSection*-**display**`
(`dateSegments[0]` — a read-only span with no `.value`) and (2) read `el.value` off that span (always
`undefined`), so the read-back compared `undefined === "12"` → false for every method REGARDLESS of whether
keystrokes landed. **Two compounding artifacts, not a real limit.**

The M33 corrected probe (Magna wd3 page 2, hidden) settled it:
- The date `-input` (`role="spinbutton"`) is **0-box** (zero-width masked input — the visible UI is the
  sibling `dateSection*-display` span). So `cdpClickAt` CANNOT coordinate-click it (`cdpRectReady` gives up —
  the iter-1 `no-rect` result). That, plus the wrong read-back element, was the whole "blocker."
- **The working recipe (proven by read-back):** **TRIPLE-CLICK the visible `-display` rect to focus the
  0-box `-input`** (`focusMethod:"triple-click-display"`), then type the digits. Once focused, **BOTH
  per-char `cdpTypeChars` AND `Input.insertText` make `-input.value` stick** (read-back "12"). The month
  spinbutton **auto-advances to year** after 2 digits (typed "2024" → stuck). Restore clean.
- Rect-free focus fallbacks (`cdpFocusBySel` = page `el.focus()`, `cdpDomFocus` = CDP DOM.focus) exist for
  segments where triple-click-display doesn't land (e.g. a standalone year — UNVERIFIED until M34).
⇒ Work Experience From/To, Education years, and Certification dates ARE fillable on CDP. M34 builds
`fillDateCompositeCdp` (focus EACH segment explicitly — robust vs auto-advance timing; per-char primary +
insertText fallback, each read-back-verified). The M32b `cdp-date-deferred` skip stays until M34's handler is
proven + M35 wires it into the date-bearing sections.

**Recon-tool lesson (carried forward):** target the EDITABLE `-input` for read-back and never gate actuation
on a masked input's own rect — focus via the visible sibling (triple-click) or a rect-free `focus()`.

### M34 — the CDP multi-segment date recipe (and the Ctrl+A bug that broke it)
`fillDateCompositeCdp` fills a date by, **per segment**: triple-click the visible `dateSection<seg>-display`
(which SELECTS the segment) → READ `.focused` (the `focusDateSegment` gate — never type into an unfocused
segment) → per-char type (insertText fallback) → parseInt read-back-verify. Live-verified hidden on Magna
wd3 page 2: WE M/Y "5/2025", Education year-only "2024", **Certs M/D/Y "6/15/2024"** — all verified, every
segment via `triple-click-display/typeChars`.
- **⛔ NO Ctrl+A anywhere in the date path.** The first M34 build cleared each segment with Ctrl+A+Delete
  (`cdpSelectAllDelete`) before typing — and **Ctrl+A spans the WHOLE date composite, clears all segments,
  and resets the active segment to Month**, so the per-char Day/Year digits piled into Month (15→clamps to
  12 → the live "12/20/2024" bug). It looked intermittent ("sometimes") because it depended on prior
  field/focus state. The `RUN_CDP_DATE_MECH` mechanics probe (since pruned; this is the record) proved it
  the SOLE culprit: with NO clear, both the sequential-one-focus and per-segment-triple-click recipes filled
  M/D/Y **3/3 deterministically, no auto-advance race** (immediate == settled focus reads).
- **No clear is needed** — triple-click SELECTS the segment, so typing REPLACES it (proven: mech-probe runs
  with residual segment values read back correctly). A future replace-on-type-hostile tenant would need a
  **segment-scoped Backspace** clear — NEVER Ctrl+A. A `node --test` guard asserts the composite never calls
  a whole-field clear.
- M/Y is NOT a Month-first false pass: `focusDateSegment` returns `triple-click-display` only after a
  `.focused` read, so Year is genuinely focus-verified before typing (confirmed live via the fill trace).
- The date branch in `fillEntryCdp` stays DEFERRED (`cdp-date-deferred`) until M35+ wires the composite
  into the date-bearing section fills.

### Websites = the date-free machinery proof
One `formField-url` text field per entry, no dates, no hashed ids, no dropdowns — the clean first section to
prove the reconcile-to-N + per-entry-fill machinery. Other sections reuse `driveRepeatingSectionCdp` later.

### Load-bearing mechanics (ported into the CDP substrate)
- **Entry enumeration = the `--null` containers ONLY:** `[data-fkit-id^="<prefix>"][data-fkit-id$="--null"]`.
  The bare prefix over-matches the date sub-wrappers (`workExperience-N--startDate`/`--endDate`) — the trap.
- **Duplicate `formField-*` ids across entries** → every field access MUST be entry-scoped via the composed
  selector `[data-fkit-id="<fkit>"] [data-automation-id="formField-<name>"]` (emitted by `cdpRepeatingScan`).
  The CDP handlers are selector-agnostic (`loc={wrapperSel}`), so they work per-entry unchanged.
- **Add/Delete are COORDINATE clicks** (`clickSectionAdd`/`clickDeleteEntry`): the scan's `addButtons[].rect` /
  `deleteRect` are PAGE coords (huge) — unusable for `cdpClickAt`. The substrate page-fn does
  `scrollIntoView({behavior:"instant"})` **inside the eval** (rAF/"smooth" is frozen hidden) + a fresh
  `getBoundingClientRect` viewport rect + M29-style 0-rect retry (`cdpEvalRectReady`), THEN `cdpClickAt`.
- **Add disambiguation by nearest-heading regex** (no `adds.length===1` fallback — 5 Add buttons coexist):
  `/websites?|web ?address/i` matches EXACTLY one of the recon's `nearestHeading`s ("Work Experience 3",
  "Education 2", "Specialties"×2, "Certifications 2", "Languages 3", "Websites 3") → only "Websites 3".
- **Count-poll reconcile:** after each Add/Delete, poll `entryCount(prefix)` SW-side (4000ms/150ms) until the
  count rises/drops; if it doesn't move → STOP (don't spin). Re-scan fresh per field (held descriptors orphan
  on re-render).
- **Languages labelRegex gap (later):** hashed proficiency-dropdown ids resolve by `label` (`cdpRepeatingScan`
  emits it), not automation-id — the labelRegex resolve path is wired in `fillEntryCdp` but UNPROVEN on CDP
  until the Languages round. **(RESOLVED in M35 — see 2026-06-17 below.)**

## 2026-06-17 — Magna wd3, HIDDEN: Languages on CDP (labelRegex/hashed-id + deleteOnNoMatch PROVEN LIVE) (M35)

`driveRepeatingSectionCdp` + `LANGUAGE_MAP` (language dropdown + 3 proficiency dropdowns + "I am fluent"
checkbox), date-free — the first LIVE exercise of the two paths wired-but-unproven since M32b. All passed
hidden on Magna page 2; the machinery (M32b) needed NO change — only `LANGUAGE_MAP` + a harness.

- **labelRegex resolves the HASHED-id proficiency dropdowns BY LABEL — PROVEN LIVE.** The three proficiency
  dropdowns have hashed `formField-5aaaed…` ids; `/reading|speaking|writing proficiency/i` matched the live
  labels ("Reading/Speaking/Writing Proficiency*") and they filled (`text-click-commit` where actuated,
  `dropdown-prefilled-kept` where already right).
- **Entry-scope holds despite IDENTICAL hashed ids across entries (the duplicate-id trap, confirmed live).**
  `formField-5aaaed…` (reading) is shared by `language-6` AND `language-7`; resolution stayed entry-scoped
  (labelRegex match WITHIN the entry's fields + the fkit-prefixed composed `wrapperSel`), so `language[0]`
  (English, all-Fluent) and `language[1]` (Chinese, per-skill) got their OWN values — NOT crossed.
- **"I am fluent" checkbox** reconciled to `_allFluent` (English → checked; Chinese → unchecked, "already in
  desired state"). Processed LAST in the map (proficiencies fill first; recon MutationObserver: the
  proficiency dropdowns STAY visible when fluent is checked — the old "checking it hides them" comment was
  false and is corrected).
- **deleteOnNoMatch — PROVEN LIVE via the no-match trigger.** A bogus `"Zxqwbogus"` language (unmatchable by
  the ~65-option dropdown) → its required `language` pick didn't match → that entry deleted as
  `language[2].removed` ("a required pick didn't match an option → entry deleted"), the **right** entry (the
  good English/Chinese survived filled). This is the no-match path, distinct from reconcile-down
  ("deleted N extra(s)"). (Verified with a TEMPORARY profile entry, reverted after — profile.json is
  untracked, never committed.)
- **Heading disambiguation:** `/languages?/i` matches only "Languages 3" among the page-2 section headings.

## 2026-06-17 — Magna wd3, HIDDEN: dates wired into Education + Certs (M36) + nested cert Specialties surfaced

Un-deferred `fillEntryCdp`'s date branch (the M32b `cdp-date-deferred` zero-actuation skip) to call the
M34 `fillDateCompositeCdp` UNCHANGED, then ported `EDUCATION_MAP` (year-only from/to) + `CERTIFICATION_MAP`
(M/D/Y issued/expiration). Both sections live-verified hidden on page 2.

- **Year-only AND M/D/Y dates fill IN-SECTION (not just standalone, M34).** Education `firstYearAttended`
  "2024" / `lastYearAttended` "2028" (year-only, single segment); Certs `issuedDate` 6/15/2024 /
  `expirationDate` 6/15/2027 (M/D/Y — the 3-segment auto-advance shape that had the M34 Ctrl+A pile-up
  bug). Every segment landed via `triple-click-display/typeChars`, parseInt read-back verified, with
  **distinct** Month/Day/Year values (not a Month-first false pass). The M34 composite needed no change in
  the repeating context — `fillEntryCdp` re-resolves the wrapper per entry, so the entry-scoped composed
  selector reaches the right date wrapper.
- **`deleteOnNoMatch` keep-fix — an abbreviated required pick that auto-commits as `filled_review` is
  KEPT, not deleted.** The cert typeahead candidate "CPP" containment-matched the chip the form
  auto-filled ("Certified Payroll Professional (CPP) - Multiple Recognized Providers") → `filled_review`
  / `autocommit-containment`. The old reconcile `ok`-check (`status === "filled"` only) would have
  `deleteOnNoMatch`-DELETED the entry, discarding a committed value. Fixed: `ok = …|| r.status ===
  "filled_review"` — a required pick that committed ANY value (filled or filled_review) won't block Next,
  so the entry is kept + flagged for review. `deleteOnNoMatch` still fires on `needs_review`/`error`/
  `skipped` (the genuine no-match). Live-proven: the "CPP" entry stayed, dates filled.
- **NEW structure surfaced — each Certification entry nests a repeating Specialties sub-section +
  Attachments (NOT handled; recon deferred).** Beyond the top-level cert fields, a cert entry offers
  "Add" for **Specialties** (each = a typeahead + start/end **date**) and an **Attachments** file upload.
  This is a **repeating section nested inside a repeating entry** — a new structural pattern
  (`driveRepeatingSectionCdp` handles one level; `cdpRepeatingScan` `PREFIXES` has no specialty prefix;
  the profile cert schema has no `specialties`). Decided: **Specialties → recon-first round AFTER M36.1**
  (read-only dump of the nested Add / specialty `data-fkit-id` prefix / per-specialty typeahead + the two
  M34 date composites); **Attachments → DEFERRED** (the profile stores no per-cert document files, unlike
  the single resume in IndexedDB — nothing to attach).
- 121 tests (the M32b "date field DEFERRED — zero actuation" test replaced by 3 segment-WRITE tests:
  M/Y, M/D/Y-Certs-shape, Education-year-coexists — asserting the segments were ACTUALLY typed, not just
  `status:"filled"`).

## 2026-06-17 — Magna wd3, HIDDEN: tier-aware pre-filled guard (M36.1) — a reordered profile takes effect

The CDP typeahead/source pre-filled guard kept a chip if it matched ANY candidate (`candidates.some`),
**priority-blind**. Live bug: a `field_of_study` reorder (operator moved "electrical engineering" to
tier 3, put "Other" at tier 1) had NO effect — the form's stale tier-3 "Electrical Engineering" chip was
`prefilled-kept`. Fix is tier-aware (typeahead + source in lockstep).

- **Tier index drives the decision.** `k` = first candidate the pre-fill exact-normalize-matches.
  - **k===0** → already the top choice → KEEP, zero actuation (`prefilled-kept`). countryPhoneCode is the
    canonical case: Workday auto-derives "United States of America (+1)" from Country and `normalize()`
    strips the `(+1)`, so the chip is tier 0 vs the tiered profile list. **Only k===0 is zero-actuation.**
  - **k>0** → walk ONLY `candidates.slice(0,k)` (the higher tiers, in priority order) and commit the
    FIRST that the form offers = the **highest-available** upgrade (`overwrite-success`). The walk's
    transition-aware commit detection (`chipSetChanged` vs the pre-fill) cleanly sees the new chip. If NO
    higher tier is offered, the walk-end keeps the pre-fill via `overwriteNoMatchResting(keptLowerTier)`
    → `filled` / **`prefilled-better-tier-unavailable`** (honest: the value IS a real tier hit, NOT a
    no-match). This path SEARCHED the higher tiers → it is NOT free; a lower-tier-but-best field
    re-searches on every re-run (bounded by tier count).
  - **k===-1** (pre-fill matches no candidate) → unchanged full overwrite walk (M27).
- **LIVE-VERIFIED (Magna page 2, hidden), the exact fieldOfStudy repro across two runs:**
  - Run 1: chip "Electrical Engineering" (tier 3) → **overwrote to "Other"** (tier 1; tier-0 "Electrical
    and Computer Engineering" is NOT a Magna option) — `filled_review` / `overwrite-success`,
    `overwrite.original: "Electrical Engineering"`, `enter-commit on "Other"`.
  - Run 2 (idempotent): chip now "Other" (tier 1), tier-0 still not offered → **kept** `filled` /
    `prefilled-better-tier-unavailable` ("no higher-priority tier is offered by the form").
  - countryPhoneCode "United States of America (+1)" + source "LinkedIn" → `prefilled-kept`, ZERO
    actuation (the tier-0 path is byte-identical to before — regression intact).
- **Dropdown deliberately left priority-blind** (`dropdown-prefilled-kept` unchanged): a tier-aware
  dropdown keep would re-open the cold 200+-item list on every non-tier-0 re-run — exactly the cost
  M27.C's keep-guard avoids, and tiered dropdowns normally have non-option top tiers (live: `degree`
  correctly kept "Bachelors", tiers 0/1 not options). Revisit only on an observed live dropdown mis-keep.
- 127 tests (6 new): a named tier-0 zero-actuation INVARIANT; k>0 highest-offered (tier-1 over tier-2,
  proving priority order + never re-searching its own tier) for typeahead AND source; k>0 nothing-higher
  → keep; k===-1 mismatch walks the full list. The pre-fill values mirror the live fieldOfStudy reorder.

## 2026-06-18 — Magna wd3, HIDDEN: nested cert Specialties structure (M36.2 recon — DISCOVERED LIVE)

`runCdpCertSpecialtyRecon` / `cdpCertSpecialtyScan` (read-mostly: dump cert entry → mount ONE specialty →
dump the before/after `data-fkit-id` + field DIFF → log). Run hidden on Magna page 2; the structure is
now fully known. **Each Certification entry hosts a REPEATING Specialties sub-section + an Attachments
upload — a repeating section nested inside a repeating entry (the first such on any observed tenant).**

- **Specialty entry fkit pattern: `certification-<N>--specialties-<M>--<field>`** (e.g.
  `certification-54--specialties-5--specialtyParent`). **CRITICAL: NO `--null` container** — unlike every
  top-level section entry (`education-N--null`, `certification-N--null`, …), a specialty "entry" is NOT a
  single `--null` node; it is the SET of field-fkit nodes sharing the `--specialties-<M>--` infix (M = the
  specialty entry index, a Workday internal counter). The Specialties SECTION parent is
  `certification-<N>--specialties`. ⇒ the existing `cdpEntryCount`/`cdpDeleteEntryRect` (which key on
  `[data-fkit-id$="--null"]`) DON'T apply to specialties; nested enumerate/Add/Delete need the
  `--specialties-<M>--` infix.
- **Per-specialty fields (3):** `specialtyParent` (typeahead, **required**, label "Specialty*", NOT
  hashed); `startDate` + `endDate` (both `date`, full **M/D/Y** — Month/Day/Year display+input segments,
  identical to the M34 composite). `formField-*` ids are `specialtyParent`/`startDate`/`endDate`.
- **Add is INSIDE the cert entry** — `nearestHeading` "Specialties" (text "Add" with 0, "Add Another"
  with ≥1; heading becomes "Specialties 1" once one exists). `clickSectionAdd("specialt")` mounted it
  live. **But it is page-wide by heading → with multiple cert entries it hits the FIRST cert's Specialties
  Add; the nested fill needs per-cert-entry-scoped Add/Delete.**
- **Entry-scoping:** specialty `formField-*` ids do NOT collide with the cert's OWN fields
  (`duplicateAutomationIdsVsCertOwn: []`) and are not hashed — BUT across MULTIPLE specialties they
  duplicate (`formField-specialtyParent` ×N), so the future nested fill MUST scope per specialty via the
  `--specialties-<M>--<field>` fkit (the WE/Languages composed-selector pattern).
- **Attachments:** one `input[type=file]` (`formField-` empty fieldName, hashed, label "Attachments") —
  DEFERRED (no per-cert files stored).
- **Recon hygiene note:** the recon MOUNTS a specialty to reveal the structure and does **NOT auto-remove
  it** (the specialty isn't a `--null` entry, so `clickDeleteEntry` can't; a proper per-cert nested Delete
  is the deferred fill milestone's job — not half-built here). Each run leaves one empty specialty → the
  operator clears them manually. Honest LEFTOVER log added.
- **Decision:** the nested specialty FILL is **DEFERRED** (niche — most applicants have none). The
  structure above is the complete input for that build whenever it's picked up.

## 2026-06-18 — Magna wd3, HIDDEN: CDP DOES drive a <textarea> (M37 Part 0 — WE gate RESOLVED)

The WE `roleDescription` is a `<textarea>`; `fillTextCdp` is `<input>`-only (`focusText` targets
`wrapperSel + " input"`, `cdpReadTextState` does `querySelector("input")`), and CDP `Input.insertText`
on a textarea — especially with NEWLINES — was unproven. Probed both write paths with a MULTI-LINE value
(2 lines, one `\n`: `"Recon line one — alpha\nRecon line two — bravo"`) on the live WE textarea.

- **BOTH paths PASS** — full value landed WITH the newline intact (`lines===2`) AND survived a React
  re-read (re-read after 600ms still `lines===2`):
  - **(a) coordinate-click focus + `Input.insertText`** → PASS. (The textarea has a REAL rect — unlike the
    masked date `-input` — so a coordinate click focuses it.)
  - **(b) native setter via `cdpEval`** (the exact page-engine `HTMLTextAreaElement.prototype` value
    setter + `input`+`change`) → PASS.
- **DECISION: (a) `Input.insertText` is PREFERRED** (trusted input, consistent with `fillTextCdp`'s
  `typeText`). **`insertText` does NOT mishandle the newline on a textarea** (the worry that drove the
  multi-line probe is refuted). (b) stays the guaranteed fallback.
- **Build implication:** the WE roleDescription needs only a textarea-TARGETING focus + read-back
  (`querySelector("textarea")`, not `"input"`) reusing the SAME `typeText` (insertText); the `<input>`
  path stays untouched (regression-safe). So WE is unblocked: focus the textarea (coordinate-click) →
  `Input.insertText` the newline-joined `bulletsText` → read-back-verify.

## 2026-06-18 — Magna wd3, HIDDEN: Work Experience on CDP (M37 Part 1 — PROVEN LIVE, incl. dirty-state)

WE filled via the SAME `driveRepeatingSectionCdp`/`fillEntryCdp` + `WORK_EXPERIENCE_MAP` (the bespoke
section folded onto the config path). New deltas, all live-verified on Magna page 2 (3 entries × 2 runs,
0 needs_review):

- **`fillTextCdp` `tag` param** (default `"input"` → existing callers byte-identical): `focusText`/
  `readTextValue`/`cdpReadTextState` target `tag`; `tag:"textarea"` drives `roleDescription` (the
  recon-proven coordinate-click focus + `Input.insertText`, newline-intact). The `roleDescription`
  textarea filled + `verified` multi-line on EVERY entry.
- **`currentlyWorkHere` reconciled FIRST** (checkbox, label-click), all three states seen live:
  false→false ("already in desired state"), false→**true** ("label-click"), true→true ("already").
- **Conditional `endDate` via `skipWhen(item)`**: `currently_work_here:true` → endDate `skipped`
  ("currently_work_here = true → no end date (To box removed)"), ZERO actuation; otherwise the M/Y date
  fills. (entry[1] true → skipped; entries [0]/[2] false → 8/2025, 8/2023.)
- **`waitForPresence` poll-until-present** for the endDate remount (uncheck case) — bounded re-scan, NEVER
  a fixed wait (M29). Unit-pinned with a with-poll(fills)-vs-without-poll(errors) test; the live runs
  here didn't need it (no checked→unchecked transition), but it's the safety net for that path.
- **M/Y dates** (startDate + endDate) fill via the M34 composite (triple-click-display/typeChars), distinct
  per entry; **entry-scoping** held across 3 entries (own jobTitle/company/location/dates/description).
- **Dirty-state robustness (run 2 — the strongest proof):** the operator added WRONG values + checked
  random boxes, then re-ran → **reconcile-DOWN deleted the extra entry** ("deleted 1 extra(s); 3/3"),
  **every field overwrote the wrong value back to correct**, and checkboxes reconciled idempotently. So
  the fill reconciles from an ARBITRARY starting state, not just a clean page (re-exercising the M36.1/M27
  overwrite path in anger).
- 132 tests (5 new WE). `WORK_EXPERIENCE_MAP` is the fill-driver config shape (TODO(dup): the page
  engine's `fillWorkExperienceEntry` is bespoke — INTENT-lockstep, not 1:1).

## 2026-06-19 — Magna wd3, HIDDEN: the FOLD (full page-2 in one drivePageFill) + two integration bugs (M38 Part 1)

`drivePageFill` now drives the flat fields THEN every PRESENT repeating section (a `PAGE_SECTIONS`
registry → `driveRepeatingSectionCdp` per section; presence = a `containerPrefix` in `repeatingScan.sections`
OR an `addButtons` nearestHeading matching the section's `headingRegex`). One "CDP fill FULL PAGE" click
fills the whole of page 2. **A LITERAL oracle comparison** (folded run vs the five standalone per-section
harnesses) caught two integration bugs that "0 needs_review" would NOT have — the load-bearing reason to
compare against the oracle, not just check for errors:

- **Bug A — date-segment focus is flaky (one-shot).** `workExperience[0].endDate` Year `focus-failed` →
  half-filled `"8"` (standalone filled `"8/2025"`). `focusDateSegment`'s triple-click→`el.focus`→`DOM.focus`
  ladder was one-shot-per-rung; a transient hidden-tab layout glitch failed all rungs in one pass. **Fix:**
  wrap the ladder in an M29-style retry (poll until `.focused` or `RECT_READY_CEILING_MS`); a true ceiling
  still returns null → the existing read-back-mismatch `needs_review` (never a silent wrong fill). Re-run:
  `endDate` filled `8/2025`.
- **Bug B — `deleteOnNoMatch` SILENTLY destroyed valid data.** Both Languages entries (English/Chinese)
  were DELETED ("required pick didn't match") and recorded only as `skipped` — the language dropdown had
  failed to render deep in the long fold (4th section). `fillDropdownCdp` returns `needs_review` for THREE
  reasons — "options did not render" (transient), "no candidate matched" (genuine — value not offered),
  "could not open" (transient) — and the OLD gate deleted on ALL of them. **Fix (B1, the win):** the pick
  handlers tag ONLY a genuine no-match with `genuineNoMatch:true` (dropdown: options rendered + candidate
  absent; typeahead/source: every candidate banner'd or filtered-but-absent — NOT a timeout, NOT
  present-but-uncommitted); `deleteOnNoMatch` deletes ONLY when every failed required pick is a genuine
  no-match. A transient/infra failure → KEEP + `needs_review` (never silent data loss). **M35 preserved**
  (a real bogus value → genuine no-match → still deletes). Re-run: English/Chinese FILLED cleanly (the
  intermittent render failure didn't recur).
- **Bug B2 (root cause) — UNDIAGNOSED + intermittent.** WHY the language dropdown intermittently fails to
  render deep in a long throttled fold (throttle accumulation? cross-section state-bleed?) — it didn't
  reproduce on the re-run, so no surfaced detail. Fix B1 makes it NON-DESTRUCTIVE (kept+surfaced on
  recurrence); the targeted fix (settle budget / between-section settle) waits for a reproduction WITH the
  detail (recon-first). **Known risk: a long fold can intermittently fail to render ANY section's cold
  widget** — watch for it; the safety net prevents data loss.
- **Re-run = clean oracle pass:** every section matches the standalone oracle; filled 46, filled_review 1
  (CPP), skipped 2 (file_upload + WE[1].endDate currently-work-here), 0 needs_review. 136 tests (3 fold +
  the genuine-vs-transient deleteOnNoMatch pair). Console-report only — the CDP review-summary bundle +
  accumulation is M38 Part 2.

## 2026-06-19 — CDP review-summary bundle + write-per-page accumulation (M38 Part 2, viewer-verified)

The CDP path had no persisted reviewSummary (console-only). M38 Part 2 builds it + accumulates across
pages, rendering in the existing `summary.html` viewer. Schema-drift check FIRST: `summary.js` reads a
SUBSET of the page-engine `buildEntry` schema (background.js ~3761) — no breaking drift, so reproduce
that schema.

- **`buildReviewBundle(results, meta)`** (fill-driver.js, PURE): reproduces the page-engine
  `mapFillStatus`/`deriveConfidence`/`deriveReview`/`buildEntry` (they read only the rec fields a CDP
  result carries — TODO(dup), lockstep with `fillEngine`; the viewer reads BOTH paths' bundles). **Filters
  `widgetType==="section"`** (the `.add`/`.delete`/`.removed` ops aren't review fields). **`field_id` is
  PAGE-QUALIFIED** (`<pageKey>::formField-<name>`) — globally unique across the accumulated multi-page
  bundle, because the viewer keys `reviewValueNodes[field_id]` for its in-place card refresh (a collision
  would refresh the wrong card; the edit DATA is closure-safe regardless).
- **`cdpPageKey(scan)`** (lib.js, tested): the STABLE accumulation merge key = url PATHNAME (drops the
  volatile query/token) + sorted field-set. Stable per page across re-runs; distinct across pages even on
  a same-pathname SPA (the field-set discriminates — the M31 lesson). NOT the full-url `cdpPageSig`.
- **`accumulateBundle`** (pure) + **`persistAccumulated`** (background.js I/O): WRITE-PER-PAGE — merge by
  `entry.page`, dropping only THIS page's prior entries and keeping every OTHER page VERBATIM (a viewer
  EDIT on a prior page survives the next page's persist — NOT a rebuild), recompute the envelope. Eviction-
  robust. Per-entry `page` provenance fixes the M15 "overwrite-per-page shows oddly" note.
- **Stale-data finding + the RESET:** write-per-page accumulates MONOTONICALLY — the same merge that
  protects edits also RETAINS a prior run's pages (a first live run showed stale "Add entries" section
  recs from an old reviewSummary). So a fresh application needs a reset: a **"Clear summary" popup button**
  (`chrome.storage.local.remove("reviewSummary")`). The walk (Part 3) must clear ONCE at start, OUTSIDE
  the page loop (a mid-walk clear would wipe accumulated pages).
- **LIVE-VERIFIED:** "CDP fill FULL PAGE" → "View last summary" renders the accumulated bundle (first run
  showed "accumulated (2 pages)", 63 fields, all correct). After Clear → re-fill → CLEAN: single page, 44
  fields, ZERO stale section recs, NEEDS REVIEW = the 2 real items (file_upload unmapped + CPP
  filled_review). 143 tests (4 bundle/accumulate + 3 cdpPageKey). **Edit-persistence is unit-proven
  (`accumulateBundle` retains current_value/edit_kind/is_edited) + inferred (the unchanged page-engine
  editor on a schema-matching bundle) — NOT live-exercised on a CDP bundle this round; first seam to check
  if a Part-3 edit doesn't survive.** field_id-page-qualification, cdpPageKey-stability, and edit-survival
  each traced to actual `summary.js` behavior.

## 2026-06-19 — Magna wd3: foreground fast-fill, the open-race, and a FALSE verified:true (M39)

The operator wanted the CDP fill MUCH faster when watching it (a visible tab isn't throttled, unlike the
hidden tab the off-loop path was built for). Making it fast exposed a class of latent bugs whose root is
ONE principle violation: **fixed-time-then-assume instead of poll-until-the-page-state-holds.** The 5×
speedup is for OUR pacing BETWEEN actions — it must NEVER shorten THE PAGE's own render time.

- **Foreground fast-fill** = visibility-adaptive `act.delay`. `cdpVisible()` reads
  `document.visibilityState` off-loop (works hidden too) behind a ~500ms TTL cache; `act.delay(ms)` returns
  `max(floor, ms×0.2)` when visible, full `ms` when hidden, re-sampled so a mid-fill minimize/restore
  adapts live. `runCdpFillPage` dropped the `cdpWaitHidden` "minimize-first" gate — it fills immediately,
  visible=fast (watch) or minimize=slow/background. Other runners keep the gate (run hidden → adaptive
  delay = full → byte-identical).
- **The open-race (also M38's undiagnosed Bug B2).** A fast open-click fires DURING the prior field's
  post-commit React re-render and NO-OPs — the trigger never sets `aria-expanded="true"`, so no list ever
  renders; the old single open then burned the full option ceiling and false-failed "options did not
  render." The tell was an ALTERNATING dropdown pattern per language entry (1st/3rd opened, 2nd/4th didn't
  — each successful commit's re-render broke the immediately-following open, whose long give-up gave the
  next one time). **Fix:** `fillDropdownCdp` bounded-retries the open on an **aria-expanded GATE** —
  re-open ONLY while not expanded; once expanded, poll options to the full ceiling. **TOGGLE-SHUT
  INVARIANT (named test):** never re-click a trigger already reading `aria-expanded="true"` — a 2nd click
  on an OPEN dropdown CLOSES it (the inverse bug a naive retry would introduce). Same bounded open/focus
  retry for the typeahead searchBox ("could not focus" was the same race).
- **THE SEVERE ONE — a false `verified:true`.** At fast pacing the dropdown PICKED an option before the
  option list finished rendering. The selection made against an INCOMPLETE list is DISCARDED on
  render-complete — but the inline commit-verify (poll trigger-text until == target, return on FIRST
  match) caught the MOMENTARY pick and reported `filled`/`verified:true` with the target while the PAGE
  reverted to its default. Live: degree Bachelors→**Associates**; English/Chinese reading+speaking
  →**Basic** (writing + the language field, picked after their lists had settled, stuck). This is the ONE
  failure mode the whole accuracy-first contract exists to prevent — a silent wrong fill that REPORTS
  success. The operator caught it by reading the actual page; the report claimed all-correct.
- **Fix = `act.delayFull` (NON-adaptive) where the wait depends on THE PAGE's render, two exposures:**
  (1) **GATE 2 option-settle** — the "2 stable non-zero reads" must span REAL wall-clock time so the list
  is COMPLETELY rendered before we match/click (at fast-scaled intervals they spanned ~140ms and concluded
  on a partial render). (2) **Commit-verify PERSISTENCE** — after the trigger first shows the target,
  re-read after another real beat and require it STILL shows the target; a value that doesn't stick keeps
  polling → honest `needs_review`, NEVER accepted. Both waits real-time; the open-detection / text / date /
  checkbox / inter-field pacing stays fast.
- **Class audit (the principle, every widget):** a verify must read AFTER the page-render it depends on.
  Only the dropdown was exposed — its correctness depends on an ASYNC option-list render AND the pick is
  discardable. The rest are already render-aware under fast pacing: text/date read back values set
  SYNCHRONOUSLY by `insertText`/`typeDigits` (no async render between action and value); radio/checkbox
  `pollCheckedIs` waits for `checked===want`; typeahead/source poll the chip/transition. **Poll the
  COMPLETE CORRECT state, never the presence of any state** — the false-verify came from reading a
  momentary/partial value.
- **LIVE-VERIFIED (visible):** the page MATCHES the report — degree Bachelors, English all Fluent, Chinese
  reading Intermediate/speaking Advanced/writing Intermediate, correct FIRST TRY, only the expected CPP
  `filled_review`; text/dates fast. 148 tests. **Follow-ups (committed plan):** generalize the principle —
  make text/date read-backs + typeahead pre-Enter settles reactive (poll-until-complete-state, ceilings =
  give-up only); then the post-fill page AUDIT (re-read the real DOM per field + reconcile) as the
  permanent backstop for this class, BEFORE the N-page walk.

## 2026-06-20 — Magna wd3: reactive read-backs (M39.1) — poll until the COMPLETE value, no fixed sleep

Generalizing M39's lesson (poll-until-the-page-state-holds, never fixed-time-then-assume) so the fill works
on ANY machine / laggy wifi — "if it doesn't load, don't proceed until it does." Part 1 = the read-backs.

- **`fillTextCdp`** — was: type → fixed `delay(textReadDelayMs)` → read ONCE → compare. Now: type → **POLL
  `readTextValue` until `value === target`** (the COMPLETE typed value — `===`, not "non-empty"), ceiling
  `textReadCeilingMs` = give-up only. Dropped the fixed clear-settle (the CDP clear→type input events apply
  in DOM order; no settle needed between).
- **`fillDateCompositeCdp`** — per segment: type → **POLL `readDateSegment` until `parseInt === val`** (the
  COMPLETE value — a half-typed "1" of "15" must NOT satisfy the poll; this is the dropdown false-verify
  lesson applied: poll the complete correct state, never a partial), ceiling = give-up. Keeps the insertText
  fallback (re-focus + per-char → poll, then insertText → poll).
- **Why this is correct, not just slower-safe:** `typeText`/`typeDigits` set the value via trusted input
  whose read-back is essentially synchronous — on a good connection the poll matches on the FIRST read (no
  added latency vs the old fixed 500ms; usually FASTER). The ceiling only engages under genuine lag, where
  the old fixed delay would have read too early → a false `needs_review` (missed fill) or worse. Ceilings
  are GIVE-UP bounds, not "assume-ready-after-N" waits.
- **Pure-pacing delays kept** (`interFieldMs` prior-field blur, `reopenSettleMs` re-render-before-reopen):
  they gate no correctness read — the next handler opens/reads reactively anyway — so they can't false-fill.
- **LIVE-VERIFIED (Magna page 2, visible):** page matches the report, text + all dates (M/Y, year-only,
  M/D/Y) correct + fast, no regression. 152 tests (+4: text lag→fills / never→needs_review; date partial→
  rejected-then-fills-on-complete / stuck-partial→needs_review — real lag can't be injected live, so the
  lag-model fakes are the proof). The DELICATE typeahead/source pre-Enter settle is M39.2 (separate, verified
  in isolation — its commit gate is unchanged; only the pre-Enter echo wait becomes reactive).

## 2026-06-20 — Magna wd3: reactive typeahead/source pre-Enter settle (M39.2) — echo, not render

The last fixed-then-assume waits. `fillTypeaheadCdp`/`fillSourceCdp` did `clear → delay(taActionSettleMs)
→ snapshot`, then `type → delay(taActionSettleMs) → pressEnter`. The fixed 400ms can be too short on lag →
Enter filters on PARTIAL text → wrong filter (safe needs_review, but a missed fill). DELICATE because this
is the M25-tuned path (focus-hygiene, stray-commit guard, banner-block) — so it was built + verified IN
ISOLATION, never riding the text/date pass.

- **`pollSearchValue(act, read, want, budgets)`** — poll the searchBox VALUE (`searchBox.value`, exposed at
  cdp.js:841/980/1060) until `=== want` (`""` after clear / the full candidate after type), ceiling =
  give-up only. The KEY distinction from the dropdown fix: this is an **ECHO wait, not a render wait** — it
  confirms our typed/cleared text LANDED in the input before we snapshot/press the filter-Enter; it does
  NOT (and must not) wait on the filter-render (the option list). So it correctly does NOT over-apply the
  dropdown's `delayFull` lesson: it uses adaptive `act.delay` (the echo is near-synchronous — `typeInSearch`
  is char-by-char `cdpTypeChars` and AWAITS every keystroke dispatch, so the happy path matches on the
  FIRST read). Read-only (never changes focus).
- **The commit gate is UNTOUCHED.** The post-Enter transition-settle (sawChange / chip / banner / filtered)
  stays exactly as M25/M27 built it — so focus-hygiene, the stray-commit chip gate, and the banner
  hard-block all run unchanged. pollSearchValue only makes the PRE-Enter wait condition-driven.
- **Ceiling-fallback = strictly-better-than-today:** value never echoes within the ceiling → PROCEED to
  Enter anyway (today's behavior; the post-Enter settle is the real gate). No hang, no new abort path.
- Also converted the `overwriteNoMatchResting` resting-clear (clear → poll `""` → escape) — gates nothing
  verified (the result comes from the post-escape chip read, never the searchBox value).
- **LIVE-VERIFIED IN ISOLATION (the pass condition = the M25 SHAPE: right value, NO stray chip, commit on
  the COMPLETE candidate — not mere "shows a value"):** `cdp-source-fill` → LinkedIn `autocommit-exact`,
  single chip, settle 459ms; full-page typeaheads → fieldOfStudy "Other" (`overwrite-success` over the
  stale "Electrical Engineering") + cert CPP `autocommit-containment`, both `filled_review`, no stray. 154
  tests (+2: typed value reflects late → poll waits then Enter fires + commits; echo never lands → proceeds
  to Enter, no hang — the underlying value landed, so it still commits, proving proceed-not-hang). The
  reactive sweep (M39 → M39.1 → M39.2) is complete. Next: the post-fill page AUDIT (M40) as the permanent
  backstop for the false-verify class, before the N-page walk.

## 2026-06-21 — Magna wd3: post-fill page AUDIT (M40) — the false-verify-class backstop

A field's own in-fill verify reads right after it acts — so it CANNOT see a value clobbered AFTER its fill
completes (a later field's actuation disturbing an earlier one, or a delayed server reset). M39 fixed the
IN-fill race; M40 is the independent POST-SETTLE pass: re-read the whole page once it's done + reconcile vs
what each field recorded. The automated form of the operator's manual page-check. FLAG-ONLY (reconcile +
flag, never auto-refill — the chosen scope).

- **`reconcileAudit(act, entries, budgets)`** (fill-driver.js, exported): one `delayFull` settle (the
  page's render is real wall-clock — the foreground speedup must not shorten it), then per entry re-read the
  LIVE value by widget type (reusing the existing `act` reads — text/textarea `readTextValue`, dropdown
  `readDropdownState.triggerText`, checkbox `readCheckboxState.checked`, radio `readRadioState`, typeahead
  `readTypeahead.chips`, source `readSource.chips`, date per-segment `readDateSegment` — all keyed by
  `auditLoc`, a SELECTOR STRING re-resolved fresh, never a held node) → classify **match / mismatch /
  unverifiable**.
- **Date re-read = the one with format ambiguity** (text/dropdown/checkbox are direct). `auditDateSegments`
  is the EXACT inverse of `fillDateCompositeCdp`'s `afterStr` (`["Month","Day","Year"].filter(present)
  .join("/")`): split count → shape (1=Year-only, 2=M/Y, 3=M/D/Y), compared parseInt-per-segment. A
  round-trip unit test pins all three so a correct date can't false-flag and a real change can't be missed.
- **Verdicts:** mismatch → `needs_review`/`audit-mismatch`, `after` = the LIVE TRUTH (the bundle must show
  what's actually on the page), detail = claimed-vs-actual. Unre-readable (loc gone) → `audit-unverifiable`
  — NEVER a silent pass (the honest branch). A match is left untouched (no false flip).
- **Two triggers:** INLINE (auto, end of `drivePageFill`, mutating results → the bundle — the real backstop,
  the walk gets it free) + STANDALONE (`runCdpAudit` + "CDP re-audit last fill" button, re-reading the
  persisted `reviewAudit` side-list `[{key,widgetType,auditLoc,auditTag,expected}]`, overwrite-per-fill).
  The standalone is what makes the perturbation test stageable (no operator intervention mid-run).
- **LIVE perturbation-gate-verified (the gate = it must CATCH, not just stay quiet):** clean page-1 + page-2
  runs added ZERO audit flags (no false flags on a correct page). Then staged changes were ALL caught —
  countryPhoneCode→"Algeria (+213)" (typeahead mismatch), schoolName→"…Universityyyy" (text) + issuedDate→
  6/15/2023 (DATE — the round-trip reconstruction proven LIVE), and a DELETED workExperience[2] entry → all
  7 of its fields `unverifiable` ("page shows null", the structural-loss proof: catches a removed entry, not
  just a changed value). 165 tests (+11). Next: M38 Part 3 (the N-page walk) reuses this inline per page.

## 2026-06-21 — M38 Part 3: the N-page walk loop (BUILT; live-verify-to-review DEFERRED)

Generalized M31's ONE-transition `runCdpWalk` into an N-page LOOP. The M31 guards (`clickPageNext`
review-refusal, `cdpWaitNextPage` dead-check-then-field-set-delta, `sessionLooksDead`, `reportPageErrors`)
are reused verbatim; Part 3 just loops them.

- **Extracted `fillAndPersistPage(act, prepared, defaults, jobContext, LOG)`** — the per-page work shared by
  `runCdpFillPage` (single page → thin wrapper) and the walk: `cdpPageKey` → `drivePageFill` (the fold +
  inline M40 audit) → report → persist `reviewAudit` + `buildReviewBundle` + `persistAccumulated`
  (write-per-page). Keeps the attach/clear concerns in the callers.
- **The loop** (`for page=1..WALK_MAX_PAGES=8`): (a) `sessionLooksDead` → halt; (b) `applyFlowReviewPresent`
  → STOP `reached-review` (SUCCESS — the whole app filled, never submit); (c) `fillAndPersistPage` (NO
  advance click); (d) `!nextButtonPresent` → `no-next-button`; (e) `clickPageNext` (refuses on review →
  `click-refused`); (f) `cdpWaitNextPage` → `sessionDead` halt / `timeout` `nav-timeout-dirty`+diagnostics /
  `advanced` → next iteration. Dropped the hidden-gate (M39 foreground fast-fill). Clears `reviewSummary`+
  `reviewAudit` ONCE at START, OUTSIDE the loop (mid-walk clear would wipe accumulated pages).
- **SUBMIT-NEVER (the load-bearing safety):** double guard reused VERBATIM from M31 — the review-terminal
  check is at the TOP of each iteration BEFORE any fill/click, AND `clickPageNext` independently refuses on
  the `applyFlowReviewPage` marker. Confirmed the `fillAndPersistPage` extraction has NO advance click and
  did NOT move the review check after a click. Submit is unreachable by construction.
- **HONEST STATUS:** unit-green (165 — the walk is SW glue, not fill-driver) + the guards unit-pinned/reused,
  BUT the LOOP reaching the ACTUAL review page has NEVER run live: no page advances until the prereqs land
  (the required page-2 resume upload blocks Save & Continue; not-in-JSON required questions block too), so
  the to-review path is currently UNREACHABLE by construction. **Committed as-built (operator-sanctioned)
  BUT the first to-review walk is a HARD eyes-on gate on a DISPOSABLE application before any unattended run.**
- **Blocked on two prereqs (next):** (1) resume attach on CDP — REUSE `attachResume` via `cdpEval` (self-
  contained), wired into `fillAndPersistPage`, no-resume → `needs_review` that HALTS at that page; (2) the
  multi-provider AI feature (Anthropic/Gemini/OpenAI) for free-text / unmapped-choice / yes-no screening
  (guess+fill+flag), with EEO/demographics as a review-NOTE, not AI.

## 2026-06-21 — Resume attach on the CDP path (walk prereq 1) — cdpEval-native, proven live in the walk

The required page-2 "Application Documents → Upload a file*" blocks Save & Continue until a file attaches;
the CDP fold recorded `file_upload` as `skipped`. M16's `attachResume` (rebuild File from base64 →
DataTransfer → input.files → change → gate on `file-upload-successful`) was proven on the page-INJECTION
path; it is SELF-CONTAINED (closes over nothing — built for injection), so it runs verbatim via `cdpEval`.

- **Recon (`RUN_CDP_RESUME_RECON`, live Magna page 2):** `cdpEval(attachResume, base64, filename, mime)`
  WORKS on the SAME debugger attach — `attached:true`, `confirmationVia:"file-upload-successful"`,
  `filesSetImmediately:1`, ~1–2.2s VISIBLE; re-runs show `deletedCount:1` (clear-then-attach is idempotent
  via CDP too). No chrome.scripting, no second debugger client. The internal page-side confirmation poll
  completed VISIBLE (the walk's operative case via M39 fast-fill); HIDDEN untested (walk is visible-by-
  design → SW-pace only if a hidden walk ever misses it). `attachResume` is scoped to
  `[data-fkit-id="resumeAttachments--attachments"]` so it targets the resume upload, NOT the deferred
  per-cert Attachments (recon-confirmed: fileName = the resume).
- **Wired** into `fillAndPersistPage` (after `drivePageFill`, before `buildReviewBundle`): detect the
  `file_upload` record → `getResume` (IndexedDB) → `cdpEval(attachResume,…)` → patch the record to `filled`
  (after=fileName) so the bundle/summary reflect it; **no-resume/attach-failed → `needs_review`** (self-
  explaining). `runCdpWalk` adds a pre-advance guard: a `file_upload` not `filled` → HALT
  `resume-not-attached` BEFORE `clickPageNext` (the required upload empty WOULD block Save & Continue → a
  self-explaining stop, not a bare nav-timeout).
- **LIVE in the walk:** page 1 filled → `✓ advanced` → page 2 filled → `resume: attached "Kevin's Resume
  2.pdf"`. ⚠ **The isolated "Save & Continue ADVANCES past the upload" proof is PENDING — confounded (NOT
  disproven) by an unrelated `Duplicate language entries are not allowed` validation blocker** (state
  residue: the fill report + M40 audit both show distinct English/Chinese, so the fill was clean — the dup
  is leftover from re-running the same app + manual perturbations, and the M31.1 halt correctly NAMED it,
  which is how we know it's residue not a fill bug). Confirm advance-past-upload on a clean page-2 state.
  165 tests green (SW/CDP glue; `drivePageFill`'s `file_upload`-skipped recording is unchanged → brain +
  fakes untouched).
- **Resume-confirmed ≠ advanced-past** (the M40-style distinction): `attachResume`'s `attached:true` is the
  ENGINE's claim (the file-upload-successful row rendered); the FORM accepting it (Save & Continue proceeds)
  is the form's TRUTH, and they can differ (a file that "attaches" but fails Workday's own doc validation
  would report attached yet still block). The walk's ADVANCE is the decisive proof — still open.

## 2026-06-22 — typeahead keptLowerTier STRAY ("Other"→"Accounting") — a fast-pacing disarm race

> **⚠ SUPERSEDED by 2026-06-26 (typeahead exit redesign — Tab-blur).** The keptLowerTier `recommitFn`
> fix (1) and the strayed-check (3) below STILL HOLD. But part (2) — `disarmHighlight` (re-focus + poll
> `activeText`→null) — rested on a FALSE assumption: **re-focusing does NOT disarm the armed row** (recon
> 2026-06-26). The "slow-safe / fast-strays" reading was a coincidence of the poll's wall-clock, not a real
> disarm. `disarmHighlight` is DELETED; the plain overwrite + empty-field exits now use Tab-blur (the only
> clean non-committing exit). Read the 2026-06-26 entry for the corrected model.

M40 surfaced a silent corruption: `fieldOfStudy` pre-filled "Other" (a tier-1 candidate) → the M36.1
keptLowerTier path reported KEPT "Other" but the page held "Accounting" (the audit caught it). Recon
(`RUN_CDP_TA_STRAY_RECON`, per-action chip+activeText reads) + the full-page fill pinned the mechanism:

- A no-match higher-tier search (typed an absent value + filter-Enter) **ARMS listbox row-0** (the first
  option "Accounting" — `activeText="Accounting"`), even with the "No matches" banner showing.
- `overwriteNoMatchResting` RE-FOCUSES the searchBox, which **DISARMS** the highlight (`activeText→null`) —
  BUT the disarm is async/page-side. **At SLOW (recon `delayFull`) pacing the disarm completes → NO stray;
  at FAST (M39 foreground) pacing the field is EXITED before it completes, and the NEXT field's focus then
  COMMITS the still-armed "Accounting"** (the M39 family — a fast-pacing race). Every operator fact fit:
  Escape does NOT blur/clear the box; a MANUAL (human-slow) neutral click is safe (disarm had time); only
  the automated FAST path raced it. NOT blur-in-general — it's the armed-row surviving to the blur.
- **Fix (prevention, not just the M40 catch):** (1) **keptLowerTier → AFFIRMATIVELY re-commit the kept
  value** (`recommitFn`: re-select "Other" via the proven commit machinery) — the field ends on a
  DELIBERATE commit; the armed row BECOMES the correct value → race-proof (doesn't depend on the disarm
  winning). (2) **plain overwrite-no-match + the empty-field-walk sibling** (original not a re-typeable
  candidate) → `disarmHighlight`: re-focus then POLL `delayFull` (REAL time — the disarm takes wall-clock
  the tab speedup must not shorten) until `activeText` is null BEFORE dismissing. (3) **strayed-check**: if
  the chip still strayed → `overwrite-stray` with the live value, never a false "kept". TA + source
  lockstep (`overwriteNoMatchResting` shared). **LIVE-VERIFIED:** fieldOfStudy stays "Other" (re-committed),
  M40 adds no mismatch; cert "CPP" `overwrite-nomatch-original-kept` (disarm-verify path, no stray). 166
  tests (2 M36.1 updated to the re-commit contract + a strayed-check backstop test). The recon harness
  (slow `delayFull`) pinned the disarm + the slow-safe/fast-strays split; the full-page fill (fast) is the
  authoritative reproduction + validation.

## 2026-06-22 — operator input-lock during a CDP fill (block accidental interference)

The foreground fast-fill runs VISIBLE so the operator watches it — and can absentmindedly click/type and
corrupt the in-progress fill. Goal: block the OPERATOR's pointer/keyboard while the bot actuates. Hard
because the bot's CDP input is `isTrusted` through the SAME pipeline as the operator's.

- **Recon (`RUN_CDP_INPUTLOCK_RECON`, 3 probes; a first run was an off-screen-target ARTIFACT — the finder
  must `scrollIntoView` + pick an in-viewport field, mirroring `cdpRectOf(sel,true)`):**
  - **(1) a pointer-events:auto overlay BLOCKS the bot's own `cdpClickAt`** (hit-testing) → a static
    blocking overlay is out; must flag-gate.
  - **(2) `cdpInsertText` BYPASSES a capture keydown-blocker (fires beforeinput/input, not keydown); per-
    char keys (`cdpTypeChars`/`cdpKeyTap`) are BLOCKED by it** → block keydown+paste for the operator's
    typing; the bot's key path needs gating, insertText is independently safe.
  - **(3) the `__apActing` toggle-timing self-block is NOT real here** — with a CONTROL (flag true
    throughout → click lands, proving the probe fired) both clear-after-dispatch AND clear-after-settle
    LANDED ⇒ the flag may CLEAR-AFTER-DISPATCH (CDP's awaited `Input.*` resolves after page propagation).
    cdpEval ≈ 1.4ms.
- **Build:** `installInputLock`/`removeInputLock` (cdp.js): a VISUAL-only overlay (pointer-events:none) +
  banner + **capture-phase listeners** (mousedown/click/keydown/keypress/paste/contextmenu) that swallow
  the operator's events when a `window.__apActing` COUNTER ≤ 0. The 4 input primitives
  (`cdpClickAt`/`cdpTripleClickAt`/`cdpKeyTap`/`cdpInsertText` — the choke; `cdpTypeChars`/`cdpSelectAllDelete`
  /Enter route through `cdpKeyTap`) bump the counter ±1 around their sends (clear-after-dispatch). A COUNTER
  (not a bool) keeps the nested `cdpTypeChars→cdpKeyTap` correct. `inputLockActive` ⇒ non-lock runs pay
  zero toggle cost. Installed in `fillAndPersistPage` (per page); removed in the `runCdpFillPage`/`runCdpWalk`
  finally (before `cdpDetach` — no stuck lock).
- **HONEST framing — a strong DETERRENT + MITIGATION, NOT an absolute block.** Live (Magna page 2): NO
  self-block across all 3 input modes (clicks, insertText, AND the nested cdpTypeChars→cdpKeyTap path —
  dates + typeahead filled identically under the lock); the lock blocked operator interference except ONE
  same-instant keystroke slip (`fFirmware…`), while the NO-LOCK baseline (same interference) let 4 changes
  through. **The ~ms same-instant window is REAL + unavoidable** — it's exactly the window where input MUST
  be allowed for the bot's own keystroke. Safety holds by **defense-in-depth**: the lock blocks accidental
  interference; the read-back/M40-audit catches the rare slip → `needs_review`, NEVER silent corruption.
- **FORWARD NOTE (the WALK, not this single-page commit):** install is per-page (re-installs after each nav,
  idempotent — `cdpInstallInputLock` early-returns if `__apLock` exists; nav wipes it with the page so each
  page gets exactly one, no stacking). BUT there's a between-pages WINDOW — after a page's fill, during
  `clickPageNext` + nav to the next page, the old overlay is wiped and the next isn't installed until the
  next `fillAndPersistPage` → the operator could interfere during the transition. Confirm + close (re-install
  right after `cdpWaitNextPage`) when the first LOCKED walk runs.

## 2026-06-22 — AI-0/AI-1: the LLM adapter + screening-question dropdown fill (Magna page 3)

The page AFTER My Experience is a screening QUESTIONS page. Magna page 3 (live recon + fill):

- **Structure:** 4 fields, ALL standard `aria-haspopup="listbox"` dropdowns, ALL required, 2 enabled
  options each (plus the "Select One" placeholder). Verbatim labels (the basis for the regexes):
  "Are you currently employed with Magna? (…please select \"No\".)**" → `["Yes, I'm currently employed
  with Magna","No, I'm NOT currently employed with Magna"]`; "Are you eligible to work in Canada?*" →
  Yes/No; "Are you over the age of 18?*" → Yes/No; "Have you been convicted of a criminal offence for
  which a pardon has not been granted?*" → Yes/No. No radio/typeahead/source on this page. So the
  existing `fillDropdownCdp`/`readDropdownState` machinery applies verbatim.

- **Recon false-clean → the LOAD-BEARING dropdown lesson.** `reconDropdownDump` (open→read→Escape→re-read)
  reported "4/4 clean" but the page actually ENDED with 3 dropdowns committed to "No". Mechanism: a
  click-opened dropdown arms NO highlight (safe to read), BUT **Escape does NOT reliably DISMISS a Magna
  dropdown**, and the portaled option list overlays the next field — so opening field N+1 (or the slow
  close) left values committed. The per-field before/after read happened too early (each field still
  showed "Select One" at its own close) so it missed the delayed/cross-field stray. ⇒ **a dropdown's
  "clean/blank" property is the VALUE (`triggerText` stayed on the placeholder), NOT `ariaExpanded` —
  a STRAY commits a value which ALSO closes the list.** `closeAndVerifyBlank` decides blank by value;
  do NOT reopen-to-toggle to force-close (it ping-pongs a slow-closing list → a FALSE stray on a blank
  field, the live Q2/Q3/Q4 "Select One STRAYED"). Best-effort Escape + the inter-field delay close it.

- **ALWAYS-GUESS, not UNKNOWN-gate (the contract shift for REQUIRED choice fields).** First fill returned
  Q2/Q3/Q4 as UNKNOWN→blank — but a blank REQUIRED field HALTS the walk (Save & Continue won't proceed),
  so "leave blank" is not a safe rest state here. The operator web-verified (same model, full profile)
  that all four are profile-DERIVABLE and inferred correctly. So the AI ALWAYS chooses + reports a
  confidence (High/Medium/Low) + a short justification; safety = the human review gate + the confidence,
  NOT a refusal. The choice still clears the match ladder (never blind-commit); UNKNOWN/paraphrase →
  rare `ai-nomatch` (the human answers). LIVE: currently-Magna→No (High), eligible-Canada→No (High,
  citizenship+address), over-18→Yes (High, education dates), criminal→No (**Medium**, the model itself
  rating its reasoning-from-ABSENCE less certain — the intended behavior). M40 re-read all 4 + matched.

- **Confidence is NOT a substitute for the sensitive flag (the inverse failure).** "Reasoning from absence"
  (profile silent ≠ profile asserts No) is exactly what the model marks HIGH and is the criminal/eligibility
  case where a wrong answer matters most — so confidence-driven prominence would BURY the most dangerous
  answers. ⇒ the viewer renders `ai-choice-sensitive` (legally-loaded) answers FIRST with a loud red badge,
  prominence keyed off the FLAG, never confidence; and the prompt makes the justification NAME its basis
  (positive fact vs absence) so absence-reasoning is reviewable for what it is.

- **`legallyLoaded` regex gap caught by the verbatim labels.** The first regex missed "over the age of **18**"
  (it required "18 years"/"18 or older"). Widened to include `\bage\b|over (the age of )?\d+|\b18\b` etc. —
  the recon's verbatim-label dump is exactly where to catch a regex gap before relying on it (over-flagging
  to sensitive is the safe direction).

- **Model facts.** `gemini-2.0-flash-lite` was SHUT DOWN 2026-06-01 (the original default's 429 — a stale
  hardcoded model). The flash-LITE models answer at low `maxTokens`; the THINKING models (`gemini-3.5-flash`,
  `gemini-2.5-flash`) returned `finishReason:MAX_TOKENS` with EMPTY text at `maxTokens:16` (they spend the
  budget on `thoughtsTokenCount` first) → `aiFillField` uses `maxTokens:512`. Default = `gemini-3.1-flash-lite`
  (operator-verified inference quality; ~15 RPM is ample for a ~4-call screening page). A model dropdown
  (curated `LLM_MODELS`, default=first) replaces a free-text field so a stale typed id can't 429.

- **Justification BREVITY.** "one-sentence justification" produced verbose detail that bloats the summary a
  future AI reads; "a SHORT phrase (~12 words, no preamble) that names its basis" produces tight, reviewable
  detail (e.g. "Inferred from the absence of any criminal record in the applicant profile.").

## 2026-06-23 — AI-4 remediation, resume-under-lock, self-heal, fill-latency (Magna wd3)

- **AI-4 error→field association: the error TEXT parse is reliable; the error-anchor CLICK is NOT (on Magna).**
  Recon hoped each validation error is a HYPERLINK that jump-focuses the offending field — but live, clicking
  the error elements focused NO `formField-*` (`focusedFieldName` returned null for all). The error TEXT, however,
  NAMES the field ("The field <First Name> is required"), so Tier-1 parses the name (`parseErrorFieldName`),
  label-matches it to a scanned field (`mappedFieldsFromErrors`, normalize + bidirectional-containment), and
  re-fills MAPPED fields from the profile DETERMINISTICALLY (no AI). The anchor-focus path was dropped.
- **The Workday "Duplicate language entries are not allowed" PHANTOM.** Distinct entries (English + Chinese)
  still trip it; deleting ONE doesn't clear it (the AI tried, then correctly declined). The only fix is delete
  ALL language entries. `languageDeletionPlan` reads the FILLED values from the audited results: two entries
  sharing a normalized language value = a REAL dupe (delete the later) vs all-distinct = the PHANTOM (delete all).
  Scoped to LANGUAGES (other sections' dup errors may be real). Not reproducible on demand → live-PENDING.
- **Resume attach under the input-lock — the lock SWALLOWS self-contained synthetic clicks.** `attachResume`
  clears existing attachments with `dispatchEvent`-based clicks (NOT the gated `cdpClickAt`); the input-lock's
  capture-phase blocker drops any `click`/`mousedown` while `window.__apActing` is 0 → "removed 0, N remain"
  (fails ONLY when an attachment must be cleared — a clean page works because the attach's `change` isn't blocked).
  Fix: bump `window.__apActing` around the `cdpEval(attachResume,…)` call. Any FUTURE self-contained page fn that
  does its own synthetic input under the lock needs the same bump.
- **CPP cert typeahead: the "0 options" was a CLOSED autocommitted dropdown, not an open empty list.** Typing
  "CPP" AUTOCOMMITS "Certified Payroll Professional (CPP) - Multiple Recognized Providers" and CLOSES; the chip
  EQUALS the pre-fill so `chipSetIsNew` is false → the chip-path missed it → the settle waited out its budget
  AND mislabeled a correct value `needs_review`. The discriminator was `searchBox.visible` (open) + `chips`
  (committed value) — read per-candidate in the settle trace; `open:false` + a chip = closed-committed. The new
  `closed-commit` settle outcome classifies the kept chip via the match ladder (containment → `filled_review`,
  honest flag, kept provenance). No disarm needed (already closed — no armed highlight). Recon-first
  instrument-then-fix earned this: the first "empty filtered list" hypothesis was a category error the trace refuted.
- **Validation-error detection: poll `errorMarkers`, don't burn the nav-ceiling.** A page that errors on
  Save & Continue keeps the same URL+field-set (sig unchanged) and isn't a dead session, so `cdpWaitNextPage`
  waited the full 15s. `errorMarkers` populate immediately, so: sig unchanged + errors present for 2 consecutive
  reads → conclude errored (~1s). Safe: errors-present ⟺ won't-advance (a clean advance changes the sig first).
- **Settle latency is page-side, not pacing.** The CPP close took ~1.8s of the FORM's own autocommit latency
  (irreducible); the bug was the 8s/15s WAIT on top, not the interaction. The `closed-commit` early-exit removed
  the wait without touching the M25/M27 commit/stray/disarm logic (additive settle exits only).

## 2026-06-24 — Summary editability: capture the FULL option list for choice fields (FoS + dropdowns)
The review summary lets a human edit choice fields, but a choice field is only editable if its bundle entry
carries `options`. Two gaps left some empty: (1) a **typeahead** (Field of Study) only ever recorded
`captured_options` = the bot's partial search matches; (2) a **`dropdown-prefilled-kept`** dropdown (M27.C
zero-actuation short-circuit) never opened, so it scraped no options. On a re-run (everything pre-filled) the
summary `<select>` for degree/language/proficiency showed only the current value, and FoS showed a partial note.
- **FoS option list is BOUNDED + ENUMERABLE but VIRTUALIZED.** `cdpReadTaState` visibility-filters `[role=option]`
  and ~16 render at a time; the full curated list (65, Accounting→Visual Arts, alphabetical) is revealed by
  SCROLLING. Capture = a **scroll-accumulate scrape** (`cdpScrapeTaOptions`, cdp.js): runs ENTIRELY in-page in one
  `cdpEval` (awaitPromise), frame-paced via double-rAF, finds the option-list scroll container (option's nearest
  scrollable ancestor / the searchBox `aria-controls` el), loops `read visible [role=option] → de-dupe in order →
  scrollTop += clientHeight → 2 frames` until bottom / no-new×2 / a 60-step cap. **READ-ONLY** (only sets scrollTop
  + reads text → no type/Enter/arrow → no listbox highlight ever arms). LIVE: 65 options in **220ms**, bottom
  reached, field left unchanged.
- **Capture runs at END OF PAGE, never inline.** Two inline attempts failed: scraping BEFORE the fill scrolled the
  list to the bottom and the immediately-following keptLowerTier re-commit committed a bottom-region row (FoS
  "Other"→"Religion" stray); scraping immediately AFTER the commit raced the post-commit residual state (banner /
  mid-unmount searchBox) and scraped empty. The PROVEN arrangement: capture in `drivePageFill` after all fields are
  filled + settled/closed (a fresh re-open shows the empty-filter full list), BEFORE the M40 audit (which re-reads
  each VALUE and backstops any capture-induced stray). `captureChoiceOptions` (fill-driver.js) dispatches per widget
  for `filled`/`filled_review` records that LACK options, cached per option-set key so same-vocabulary fields
  (FoS across education entries; `language`/`readingProficiency` across entries) re-open ONCE.
- **Dropdowns: capture REPEATING-section only, reusing the read-only readers.** `captureDropdownOptions` =
  `openAndReadDropdown` (open-retry + GATE-2 option settle) → enabled option texts → `closeAndVerifyBlank` on the
  KEPT value (Escape-close, no commit; value preserved). Scoped to repeating-section dropdowns (fieldName matches
  `/\[\d+\]\./`, e.g. `education[0].degree`) — **flat page-1 dropdowns (country/state/phone) are SKIPPED**: those are
  large cold lists (re-opening them is exactly the M27.C cost the keep-short-circuit avoids) and they fill fresh WITH
  options on a first run anyway. Committed dropdowns already carry `enabledTexts` → skipped (the `rec.options` check).
- **Summary editor (summary.js):** a typeahead with a full `options` list → a type-to-filter combobox (`<input>` +
  scrollable clickable list, shows ALL matches — the list box scrolls); focus / clear → the WHOLE list; type →
  narrows; "— clear —" row → null. Same M14 write-back as the `<select>` (`current_value`/`edit_kind`/`is_edited` +
  persist). Dropdowns keep the `<select>` (now populated from the captured `options`).
- **Recon harnesses** (read-only, kept): `RUN_CDP_FOS_RECON` (enumerability verdict) + `RUN_CDP_FOS_CAPTURE`
  (full scroll-scrape probe with scroll metrics + field-unchanged check) + their popup buttons.

## 2026-06-26 — FoS typeahead stray RESOLVED: the terminal-state GATE (`awaitListTerminal`) + the two-banner model

The FoS stray ("Other" → "Economics"/"Accounting"/"Religion") that survived several rounds (a settle-race
diagnosis, then an arming diagnosis, then a between-candidate settle) is finally fixed by gating on a
**CONFIRMED terminal render state** before the typeahead reads/matches/commits. The earlier `settleResults`
(banner-OR-count-steady) was the wrong gate; the real rule is **banner-or-autocommit ONLY — a bannerless list
is never terminal**. The during-fill option capture (2026-06-24/25) was NEVER the cause and now runs fine
(live: `[CDP-SCRAPE-TA] 65 options` during the fill + FoS commits correctly).

**Root cause.** A Magna typeahead no-match is a throttle-LAGGED page reaction: the page first renders a
**non-zero alphabetical FALLBACK list** (row-0 armed, e.g. "Accounting") and only SLIGHTLY LATER the "No
matches found" banner. The old code treated a bannerless non-zero list as "filtered" → it
read/matched/committed during that window → committed the armed row (the stray). Likewise the between-candidate
and re-commit transitions touched the box mid-render.

**The two-banner model (recon `RUN_CDP_RESULTS_BANNER_RECON`, Magna wd3 page-2 FoS — CONFIRMED):**
- Both banners render on the SAME node: `<div data-automation-id="promptTitle">`, distinguished ONLY by text.
  - RESULTS state → `promptTitle` text **"Search Results"** (NO count in the text — recon).
  - NO-MATCH state → `promptTitle` text **"No matches found"**.
- The aria-controls listbox `optionCount` reads **0 in BOTH states** (options are portaled to the document
  root, OUTSIDE aria-controls) → the count must come from **`pageWide.count`** (page-wide `[role=option]`),
  NOT aria-controls. And the no-match state carries a non-zero (~15) fallback list, so a **bannerless non-zero
  count is genuinely ambiguous** ⇒ the BANNER is the only terminal signal.

**The fix — `awaitListTerminal(act, readFn, loc, budgets, chipSetIsNew)`** (fill-driver.js), used by BOTH
`fillTypeaheadCdp` and `fillSourceCdp` (lockstep), returning ONE of:
- `"autocommit"` — a NEW chip, OR the box closed holding a chip (checked first, exits immediately).
- `"nomatch"` — `s.banner` ("No matches found") present AND count stable across `stableReads`.
- `"results"` — `s.resultsBanner` ("Search Results") present AND count > 0 stable across `stableReads`.
- `"timeout"` — `taSettleCeilingMs` ceiling (treated as no-match).
- A bannerless non-zero list and `count===0`-no-banner are **NOT terminal → keep polling**. The input ECHO
  (`pollSearchValue`) is NEVER the render signal. Read layer: `cdpReadTaState`/`cdpReadSourcePick` gained
  `resultsBanner` (a visible `promptTitle` matching `/search results/i`); the existing no-match `banner`
  (`/no matches found/i`) is unchanged. **Match ONLY on `"results"`**, never a bannerless list. The initial
  recon-scrape open is gated by `awaitListStable` (count>0 stable, shorter `taOpenCeilingMs` ceiling — a
  cold/empty open never burns the big settle budget; a timed-out-but-proceed is fine for a read-only scrape).
  `settleResults` + `taBannerGraceMs` retired. Termination is guaranteed: the stability counter resets only on
  a count CHANGE, and the fallback/filtered list stops changing once rendered, so once a banner is present it
  resolves within ~`stableReads` intervals.

**Trade-off (accepted):** a no-match on a hypothetical NO-banner tenant now times out (`taSettleCeilingMs`)
instead of a fast "empty" exit. Magna shows "No matches found" so it's fast there (banner ~1-2 s); cert "CPP"
autocommits. Per-candidate timeout never STACKS on Magna because each no-match tier resolves on the banner —
a `"timeout"` on a no-match tier in the SW log is the latency smell to watch.

**Live-verified (Magna wd3 page-2, VISIBLE, multiple runs, no minimize):** FoS correct in every pre-fill
state, **no stray** — empty → `directed-exact` "Other" (the live no-match→match walk: "Electrical and Computer
Engineering" → "No matches found", "Other" → "Search Results" → committed); pre-filled "Other" →
`prefilled-better-tier-unavailable` (kept + re-committed); pre-filled "Biological Science"/"Electrical
Engineering" → `overwrite-success` "Other" (`filled_review`, surfaced for review). Full-page fill + persisted
review summary also correct. The page-engine `fillTypeahead` (page substrate) is unchanged.

**Operator-ergonomics (same round):** the page-2 section-fill harnesses (education / websites / languages /
work-experience / certifications / single date) **dropped the `cdpWaitHidden` "MINIMIZE NOW" gate** — they fill
immediately, VISIBLE=fast (watch it) or minimized=slow/background, adapting live (the M39 visibility-adaptive
`act.delay`; the full-page `cdp-fill-page` already worked this way). The recons + the page-1 `cdp-fill`/
`cdp-source-fill` keep the hidden gate (throttle probes / out of the page-2 testing path).

**Mechanics (operator-confirmed, kept for reference):** the searchBox must be FOCUSED to type; it does NOT
live-filter (Enter filters); typing into an UNFOCUSED box HIGHLIGHTS the first-letter option and Enter commits
that highlight — which is why the render gate (wait for the banner) + the focus-safe echo-verified type loop
(re-assert focus, never Enter on a partial/unfocused box) together close the stray.

## 2026-06-26 — typeahead EXIT redesign: Tab-blur, the disarm fallacy DELETED

The FoS "Other"→"Accounting" stray had ONE more layer under the terminal-state gate above: the EXIT/disarm
code rested on a false DOM model. Operator recon (Magna FoS) corrected it. Three facts invalidate the old
`disarmHighlight` / clear-to-reset / Escape-dismiss code:

1. **Re-focusing the searchBox does NOT clear the armed row-0 highlight.** `disarmHighlight` polled
   `while (activeText != null …)` assuming a refocus nulls the highlight — it never does. The armed row
   can ONLY change by typing a new non-empty query. So the "disarm" was structurally a no-op that either
   burned `taSettleCeilingMs` or exited on a transient null read and LIED (reporting "kept original" while
   the row stayed armed). The 2026-06-22 "slow-safe / fast-strays" reading was a coincidence of the poll's
   wall-clock, NOT a real disarm.
2. **`""` + Enter is a no-op.** Clearing the box and pressing Enter does nothing — the prior banner +
   result list + armed row all persist. "Clear to reset the widget" is FALSE; clearing is valid ONLY as
   *delete-old-text-before-typing-the-next-query* (the between-candidate clears, which still hold).
3. **Tab is the ONLY clean non-committing exit.** Enter on the armed row commits it + blurs. Escape hides
   the popup but KEEPS focus + the armed row, so the *next field's focus* blur-commits the stray (this was
   the live corruption mechanism). **Tab blurs and ABANDONS the armed row without committing** (operator-
   verified manually).

**The root-cause path (overwrite no-match):** `disarmHighlight` (no-op) → `clearFn()` re-rendered the full
list and RE-ARMED row-0 → `pressEscape()` hid the popup but kept focus → the function read the still-intact
"Other" chip and returned `overwrite-nomatch-original-kept | "Other"` (honest at that instant) → ~2 s later
the next field's focus blur-committed the armed "Accounting". Report said "Other", page held "Accounting" —
silent corruption.

**The fix (minimal, typeahead + source LOCKSTEP) — Tab is the UNIVERSAL non-commit close (dropdowns keep
Escape):**
- `act.pressTab` (cdp.js) = `cdpKeyTap(CDP_KEYS.tab)`, next to `pressEnter`/`pressEscape` — counter-gated so
  the bot's own Tab passes the input-lock.
- **DELETED `disarmHighlight`.** **EVERY non-commit exit from `fillTypeaheadCdp` / `fillSourceCdp` Tab-blurs**
  (a commit closes the list itself, so only the non-commit paths "need" the close):
  - the honesty-read exits via the shared `tabBlurExit(act, loc, readFn)` (Tab → read the resting chips, null
    on read error): `overwriteNoMatchResting` plain path, the typeahead empty-field exit, the source
    empty-field exit;
  - the **early bails** (`could-not-focus` / `could-not-type`, both handlers) via a bare `await act.pressTab()`
    before their `needs_review` return — these were the live gap: a prior candidate's no-match ARMS row-0, then
    a LATE candidate's focus drops (the documented post-banner focus loss) → the bail returned WITHOUT blurring
    → the armed "Accounting" strayed on the next field's focus (this is what "the walk exhausted, strays
    Accounting" actually was);
  - the read-only `captureFieldOptions` close via a bare `act.pressTab`.
  - Commit exits (autocommit / directed click) are untouched — the commit already closed the list, no armed
    row survives.
- Dropped the now-unused `clearFn` param from `overwriteNoMatchResting` (the keptLowerTier path uses
  `recommitFn`, not `clearFn`) + both call sites.
- **UNCHANGED (verified still correct):** the keptLowerTier `recommitFn` (already disarm-free — type →
  filter-Enter in place → affirmative click); the stray-backstop (post-exit chip ≠ original →
  `overwrite-stray`, never a false keep); the `overwrite-nomatch-original-kept` keep; the empty-field
  honesty read + `genuineNoMatch`; the candidate-walk commit ladder; the between-candidate `clearSearch`
  (legit delete-before-type). `activeText` stays in `cdpReadTaState`/`cdpReadSourcePick` (the recon
  harnesses `cdp-ta-stray-recon` / `cdp-fos-*` still read it).

**Post-no-match rest state (the foundation the deferred AI typeahead fallback builds on):** after a no-match
exit the field rests on the INTACT pre-fill chip, the banner gone, the armed row ABANDONED, focus left the
box (Tab). No armed highlight survives to the next field's focus.

**Latency:** a no-match exit goes from a multi-second (or ceiling-length) useless disarm poll to an instant
Tab.

**Status:** unit-green (256 tests; overwrite/stray/walk-dry/capture tests + the two focus-cannot-confirm
bails + the could-not-type bail all assert Tab-exit, no net new). **Live-verified:** the OVERWRITE no-match
case (pre-filled "Other" → genuine no-match → stays "Other", no "Accounting" stray). **Live-verify PENDING**
for the extension: the EMPTY-field / early-bail case — an empty FoS whose walk arms row-0 then exhausts or
bails (focus drops after a banner) must end BLANK, no "Accounting" stray; the in-list-value + clean-overwrite
+ keptLowerTier-recommit regressions still commit.

## 2026-06-27 — Workday PLANNED-MAINTENANCE page ("Workday is currently unavailable") — fingerprint + detector

**Why:** during a planned-maintenance window Workday serves a barren "currently unavailable" page instead
of the app. With no form on it, `sessionLooksDead(state)` returns TRUE (its "no form" branch) → the walk
would MISreport it as a dead/expired session ("refresh + log in") when the right action is "retry after the
window, no re-login." Captured LIVE with the new read-only page-identity recon (`RUN_CDP_PAGE_RECON` /
the `cdp-page-recon` button → `cdpPageIdentityDump`) during the actual window (Magna, wd3 host).

**Live dump (verbatim markers):**
- `title`: **"Workday is currently unavailable."** (also the page's only `<h2>`).
- `httpStatusFromNav`: **200** — NOT 503. **HTTP status is useless for detection.**
- `formFieldCount`: **0**; distinct `data-automation-id` count: **0** (a Workday *app* page always has many
  `data-automation-id`s — a maintenance page has NONE); `passwordField`: false.
- `markers`: `maintenance:true, apology:true, workdayAdmin:true, noForm:true`; `login:false`,
  `vpsError:false`, `sessionExpired:false`.
- body text: "English Workday is currently unavailable. Workday is performing planned maintenance during
  the following period: <window> We apologize for the inconvenience. If you are a Workday customer and
  require additional assistance please contact the Workday Administrator within your organization.
  Otherwise, please check back later. America: Los Angeles © 2026 Workday, Inc. All rights reserved."
- metas: only generic mobile/viewport (`msapplication-config`, `MobileOptimized`, `HandheldFriendly`,
  `viewport`) — no useful structural marker.

**Detector (`isWorkdayMaintenance(state)`, lib.js — pure, unit-pinned):** TRUE when `formFieldCount===0`
AND not a login redirect (no password / sign-in) AND the title/body matches `/workday is currently
unavailable|performing (planned )?maintenance|scheduled maintenance|temporarily unavailable|check back
later/i` (or the `maintenancePresent` marker now set by `cdpReadSessionState`). CONSERVATIVE: a real form
page (`formFieldCount>0`) or a login page is never maintenance. Checked **BEFORE** `sessionLooksDead` at
all three walk gates (`runCdpWalk` top-of-iteration + after Save&Continue, and inside `cdpWaitNextPage`)
→ a distinct halt `stopped:"workday-maintenance"` ("retry after the window", never re-login). Text-based
(no automation-id / status to key off) → an English-locale signal; a localized maintenance page would
need its phrase added.

**Status:** LIVE-RECONNED (the dump above) + detector wired + unit-pinned. The end-to-end "walk halts
workday-maintenance" path is naturally only exercisable while Workday is actually down.

## 2026-06-27 — Containment matching is AMBIGUITY-SAFE (the "United States → Virgin Islands" first-wins hazard)

**Why:** the match ladder's containment tier (`matchCandidates`, lib.js Tier 2) used `findIndex` — it
committed the **FIRST** option that `startsWith`/`includes` the candidate, with NO ambiguity check. So a
generic value like `"United States"` silently committed whichever of `"United States of America"` /
`"United States Virgin Islands"` the tenant listed first — an arbitrary, possibly-WRONG commit (the worst
failure for an accuracy tool). Operator caught it off a cert that filled via `directed-containment` and asked
to stop the guess-among-ambiguous. A unit test (`fill-driver.test.js` directed-containment) had even baked
the hazard in as "expected" — `"United States"` + two containing options asserted commit index 0, "lucky"
that `of America` was first.

**Fix (LOCKSTEP, both copies — lib.js + the inline `fillEngine` copy in background.js):** containment commits
ONLY when **exactly one** option contains the candidate. Per candidate: count `startsWith` matches → if 1,
commit; if **>1, ambiguous → skip this candidate** (try the next, more-specific one); if 0, count `includes`
→ 1 commits, 0-or-2+ skips. All candidates exhausted → fall to fuzzy → escalate (`targetIndex -1`).

**Why this is the whole fix:** every `matchCandidates` consumer already escalates on `-1` — dropdown →
needs_review, typeahead directed (`fillTypeaheadCdp`) → `continue` → genuineNoMatch → AI/needs_review, source
→ `continue`, AI guards → ai-commit-failed. So ambiguous→-1 flows through the existing safe paths; no other
code changed. `commitOutcome`/`flagTierCategory`/`deriveConfidence` untouched (the `"containment"` tier still
exists, just fires only when unambiguous). The **exact tier (Tier 1) runs first**, so a candidate that IS a
complete option (`"United States"` exact-matching a `"United States"` option) is unaffected.

**Preserved (unambiguous containment unchanged):** the cert tree-leaf `"Training Instructor - AEVO"` → its
single suffixed leaf still fills (`directed-containment`/`filled_review`); `"Bachelor"` → `"Bachelors"`;
single-result autocommits. **Residual (not fixed, documented):** the typeahead AUTOCOMMIT path validates a
SINGLE committed chip, so ambiguity-among-options can't apply there — but Workday only auto-commits on the
filter-Enter for a *single* result; multi-result lists stay open → the directed path (covered). The pure
"Enter auto-commits row 0 of a multi-result list" edge is unaddressed; revisit only if observed live.

**Status:** BUILT + unit-pinned (matching.test.js: ambiguous-prefix→-1, more-specific-disambiguates,
includes-ambiguity→-1, cert-leaf-unambiguous→fills; fill-driver.test.js: directed-containment flipped to
escalate-on-ambiguity + a still-commits-when-unambiguous companion). 293 tests green. Live-verify pending
(cert still fills; a generic-prefix field now escalates).

## 2026-06-28 — Source tree-drill AI: the react-virtualized category click (CDP viewport-coords) + the direct commit

**Context.** The source picker ("How did you hear about us?") is a SEARCH typeahead whose no-match fallback shows
~13 chevron CATEGORY rows; on a genuine no-match (AI on), `tryInlineAiSource` drills a category, scroll-enumerates
its leaves, and types the AI's pick (see the 2026-06-27 source entry for the two-prompt flow). The drill CLICK is
where it kept failing — three compounding DOM facts, pinned by operator browser-diagnosis:

- **The onClick/DRILL handler is on `promptLeafNode`** (the MIDDLE node), NOT on the `menuItem` (`role="option"`,
  which carries only `mouseover`/`contextmenu`) nor the `promptOption` (the text leaf). Clicking the wrong node
  fired an event that did nothing. Climb `promptOption` → `closest('[data-automation-id="promptLeafNode"]')`.
- **The category rows are react-virtualized** (`div[data-automation-id="activeListContainer"]` →
  `ReactVirtualized__Grid ReactVirtualized__List`, `role="listbox"`; ~10 rows mounted at once). The scroll
  CONTAINER must be found from the first **`promptOption`** EXCLUDING `selectedItemList` — a stale committed chip
  (e.g. "LinkedIn") embeds its own `promptOption` first in DOM order and poisons the search → `scrollerFound:false`.
- **🔑 CDP `Input.dispatchMouseEvent` clicks at VIEWPORT coordinates.** The AI-chosen row (often the LAST category)
  renders **BELOW the viewport fold** — the dropdown panel is taller than the space under the field, so the row's
  center `cy ≈ 717–900 > window.innerHeight ≈ 711`. A coordinate click there hits **dead space** and never drills
  (Playwright's element-click auto-scrolls and hid this class of bug). The row is *mounted* (clipped), so a
  `while(!found) scroll` loop never even runs — the bug is purely "mounted but off-viewport."

**Fix (`cdpSourceRowRect`, cdp.js).** Find the `promptOption` (immediate; small bounded mount-scroll fallback) →
loop (≤12) `leaf.scrollIntoView({block:"center"})` (scrolls the PAGE + ancestors, not just the inner list) +
double-`requestAnimationFrame` + `sleep(150)` + **re-query** (recycle-safe) until `inClickableViewport(leaf)` —
which requires `cx/cy` within the viewport AND `document.elementFromPoint(cx,cy).closest('promptLeafNode') === leaf`
— then return the live rect; `expandCategory` does a trusted `cdpClickAt(cx,cy)`. **Dead ends disproven:** a
synthetic `dispatchEvent` click never drilled (the handler needs a trusted/`isTrusted` event); a 40×150 ms scroll
loop risked the `Runtime.evaluate` eval timeout (the ≤12 loop converges in 1–2 iterations).

**The commit — leaving the drill RE-RENDERS + clears focus.** Operator: returning from the drilled leaf view to
type the leaf re-renders the original list and then CLEARS searchbox focus after it paints. Two approaches tried
and dropped: (1) re-entering `fillSourceCdp([leaf])` — its `openSource` re-opens and disturbs the settled view;
(2) a settle-wait (poll the drilled-category banner clearing) + a second focus — unnecessary. **What works
(live-confirmed):** directly on the still-open field — **focus → Ctrl+A+Delete (`clearSourceSearch`) → type the
leaf → Enter** (autocommit a unique match / `clickSourceLeaf` the TOP on a multi-tree tie like two "Other") →
verify the chip. ONE focus, no settle-wait.

**Live-verified (Magna, visible).** `how_did_you_hear.preferred:["carrier pigeon"]` → deterministic no-match → AI
category "Website / Digital" drilled (`promptLeafNode` rect `cy:328` in viewport, trusted click, view changed) →
leaf enumerated → Prompt 2 → typed commit. Isolated harness: popup "Source AI (isolated)" (`RUN_CDP_SOURCE_AI_DEBUG`,
`runCdpSourceAiDebug` in background.js — candidates = `how_did_you_hear.preferred` with the fallback dropped to
FORCE the no-match). 298 tests.

## 2026-06-28 — Cert tree-drill AI: the leaf commit shares the below-the-fold viewport bug (clickTreeLeaf)

**Context.** Certification on Magna is a TREE (chevron CATEGORY rows on open; drill a category to reach its
leaves) — the same shape as the source picker. The cert two-prompt drill (`aiTreeFallback`, fill-driver.js) was
already built + unit-tested AND already wired live: `tryInlineAi` routes a cert no-match to it via the structural
`readTreeCategories(loc)>0` check, and `fillEntryCdp` passes `opts.ai` for EVERY section typeahead. (The old
"cert excluded by section name" claim was wrong — there is NO live section-name exclusion; the `aiTypeaheadEligible`
name-belt only gates the test-only `runAiTypeaheadPass`, and the stale test passed only because a bannerless
no-match leaves the FLAT fallback nothing to evaluate.)

**The one real bug — the leaf commit was viewport-blind.** `aiTreeFallback` commits a drilled leaf by CLICKING it
(unlike source, which TYPES — a drilled source "Other" is a category chevron that would re-drill). The commit went
through `act.clickSourceLeaf` → `cdpSourceLeafProbe`: a SINGLE read + one `scrollIntoView` + an immediate
`getBoundingClientRect` → `cdpClickAt`. That is the EXACT below-the-fold bug fixed for the category click on
2026-06-28: CDP `Input.dispatchMouseEvent` clicks at VIEWPORT coords, so a leaf in a long drilled-category list
that renders past `innerHeight` gets a click into dead space.

**Fix — `act.clickTreeLeaf(loc,label)`** (cdp.js, next to `expandCategory`): reuses the viewport-aware
`cdpSourceRowRect` (scroll the leaf's `promptLeafNode` into the clickable viewport, settle, re-query,
`document.elementFromPoint`-validate, then trusted-click its fresh center) — identical mechanism to the category
drill. Leaves and categories are BOTH `promptLeafNode`-wrapped `promptOption`s (clicking a leaf commits, a category
drills), and the FULL `" - <Category>"`-suffixed leaf label round-trips (`cdpSourceRowRect.matchPO` matches the
same `data-automation-label||textContent` that `readTreeLeaves` reads). `aiTreeFallback.commitLeaf` now calls
`clickTreeLeaf`; `clickSourceLeaf` (the rare SOURCE fallback) is left untouched — cert-scoped, zero source blast.
`readTreeLeaves` still does NOT scroll (fine for Magna's fully-rendered category leaves; a huge virtualized leaf
list is a future scroll-scrape — only the CLICK was viewport-sensitive, and that's what this fixes).

**Harness + delete-vs-AI.** `runCdpFillCertifications` (background.js) now threads `getLlmConfig()` + `aiContext`
so the `cdp-fill-certifications` button isolate-tests cert AI (previously only the full-page fill did). In a
`deleteOnNoMatch` section, a confident `ai-choice` cert pick is KEPT and an unconfident `ai-closest-forced` (a
no-"Other" required category whose AI leaf isn't represented) is DELETED (Step 2.5). 300 tests (2 cert tree
integration: confident→KEPT, forced-low→DELETED). LIVE-VERIFY pending (bogus cert name → drill → off-fold leaf
committed via `clickTreeLeaf`, chip verified, M40 clean; real "CPP" still deterministic; AI-OFF byte-identical).

## 2026-06-29 — Cert + source MERGED into one hierarchical-typeahead filler; source-AI commit hardening; required-empty fill

**The widgets are the SAME (operator recon, supersedes the two earlier "slightly-wrong recons").** The
Certification typeahead and "How did you hear about us?" are the identical Workday multiselect prompt: same
selectors/structure/state attrs. Corrected DOM facts that drove the merge:
- `searchBox.aria-controls` is **null on BOTH** — the aria-controls scoping branch was dead. The reliable
  join/scope key is **`data-uxi-multiselect-id`** (on the searchBox AND every `promptLeafNode`).
- Options = the page-wide visible **`[data-automation-id="promptOption"]`** (label = `data-automation-label` ||
  textContent), chip-excluded via `selectedItemList`; selected-state = the `promptLeafNode`'s
  `data-uxi-multiselectlistitem-isselected`. `role="option"` is the `menuItem` WRAPPER of `promptOption` (1:1).
- The earlier "the chevron is a checkbox side-charm, NOT a category" reading was **WRONG** — `isCategory`'s svg
  clause was restored. Cert + source DO have drillable CATEGORY rows on a no-match; **typing a category filters
  to NOTHING** (typing finds LEAVES) → the AI's chosen category must be **CLICKED** (`expandCategory`/
  `cdpSourceRowRect`), never typed.

**One filler.** `cdpReadHierState` (the unified reader), one click-by-label FIRST-match commit (the matchCandidates
exact tier resolves a duplicate label to its first index; `cdpSourceRowRect` clicks the first DOM node + scrolls
off-fold in), and one type-commit tree drill `aiTreeDrillFallback` for source + cert + generic trees. Retired:
`fillSourceCdp` (now a `fillTypeaheadCdp` alias), `aiTreeFallback` + its `clickTreeLeaf` commit, `tryInlineAiSource`,
the `m.targetIndex===0` gate.

**Source/cert AI-drill commit — the multi-result "no autocommit" bug.** After the AI types its chosen leaf,
Workday autocommits ONLY a UNIQUE filtered match — a value like "Other" that filters to **"Search Results (2):
Other / Others"** does NOT autocommit. The commit now: poll for the leaf's chip but EXIT the moment the results
render with no chip (stable across `stableReads`, ~600ms — never the full 10s `commitCeilingMs`), then ESCALATE
→ click the EXACT leaf (`clickSourceLeaf` matches by exact label → "Other", never "Others") → press Enter AGAIN
(commits the top, which is always the exact match). EVERY rung gates on the committed chip normalize-EQUALS the
AI's leaf, so a stray "Others" → `ai-commit-failed` (never a false fill). Skip the whole re-commit (+ Tab-close)
when the chip already equals the leaf.

**AI prompts: pass the STATED answer, not the whole profile.** `statedAnswerBlock(candidates, profile)` — when the
field HAS a stated answer (the candidates the walk tried), the AI gets ONLY that + the options and is told to MATCH
it (typo-tolerant: "Otherrr"→"Other"); the whole profile is sent ONLY when there is no stated answer (e.g. EEO).
This both saves tokens AND stops the AI overriding the stated answer by inferring an unrelated profile fact (the
"Otherrr → Carnegie Mellon" bug: it picked the applicant's school instead of their stated "Other").

**Fix 2 (scrape timing).** FLAT typeaheads scrape options ONCE at the START (`makeStartCapture` → the review page
+ the flat AI; no scrape after the deterministic fill fails); TREES are NOT start-scraped (the `readTreeCategories`
detect is a cheap read, no scroll → a successful tree fill pays no wasted scroll; the drill self-scrapes only on a
no-match).

**Required-EMPTY typeahead AI-fill (operator rule: a required field MUST get a value — the review page corrects it).**
`aiEligible` excludes typeaheads (they fill via their own inline path) and `producedNothing` doesn't cover
mapped-but-empty, so a REQUIRED empty typeahead/FoS was left `skipped` → blocks Save & Continue. Now (AI on) the
dispatch runs the unified filler with NO candidates → the inline AI has no stated answer → infers from the profile
and FORCES a pick (required never declines) + flags. Flat loop + `fillEntryCdp`. AI OFF / OPTIONAL → still `skipped`.

315 unit tests; live-verified on Magna. Committed `ad1b34c` (merge) + the follow-ups.

**2026-07-01 — Workday PLATFORM maintenance page (`community.workday.com/maintenance-page`) — observed, + a start-of-fill wiring gap to close.**
A CDP page-recon (`RUN_CDP_PAGE_RECON`) landed on `https://community.workday.com/maintenance-page?d=3&s=1&e=1&o=`. **Note the HOST: `community.workday.com`** (the Workday platform), NOT the tenant's `*.myworkdayjobs.com` — a whole-platform outage, not a tenant page. Observed:
- title & H2 = `"Workday is currently unavailable."`; `readyState: complete`; **httpStatus(nav) = 200** (status is useless — same lesson as the 2026-06-27 planned-maintenance page; a maintenance page is NOT 503).
- **0 form fields, 0 distinct automation-ids**, no password field.
- MARKERS `{apology:true, maintenance:true, workdayAdmin:true, noForm:true, login:false, sessionExpired:false, vpsError:false}`.
- body: *"…We are experiencing a service interruption. Your service will be restored as quickly as possible. We apologize for the inconvenience. If you are a Workday customer and require additional assistance please contact the Workday Administrator within your organization. Otherwise, please check back later. © 2026 Workday, Inc."*

This is a **TRANSIENT retry-later** state (like the 2026-06-27 planned-maintenance page), **NOT a dead session** — no re-login. `isWorkdayMaintenance(state)` (lib.js) ALREADY detects it (its `/workday is currently unavailable/i` branch + the `maintenancePresent` marker; unit-tested in `test/session.test.js`).

**Gap (why the operator saw "some random error"):** `isWorkdayMaintenance` is wired ONLY into the WALK transition — `cdpWaitNextPage` / `runCdpWalk` (background.js ~4047/4118) — so it catches maintenance that appears *mid-walk*. It is NOT checked at the **START** of `runCdpFillPage` / `runCdpWalk` / the single-widget + section harnesses. So STARTING a fill on an already-maintenance page (0 form fields) runs the fill logic against an empty page → downstream errors instead of a clean halt.
**TODO (future handler):** at the start of every CDP entry point (`runCdpFillPage`, `runCdpWalk`, the section/single-widget harnesses), read the identity/session state ONCE (`cdpReadSessionState`) and, if `isWorkdayMaintenance(state)`, **HALT immediately with a clear "Workday is under maintenance — retry later" status (zero actuation)** — the same treatment the walk already gives a mid-transition maintenance page. (Also consider: the recon is read-only and already surfaces this; the fill path just needs the same up-front gate before it touches the DOM.)

## 2026-07-01 — Magna wd3: nested specialty fkit node does NOT wrap the formField (the fill's selector fix)

The first live run of the nested Specialties fill errored `"typeahead wrapper not found"` on
`certification[0].specialties[0].specialtyParent`. The scan HAD found the child (fkit nodes
`certification-<N>--specialties-<M>--<field>` exist — reconcile ran), so the failure isolates to the
composed selector `[data-fkit-id="…--specialtyParent"] [data-automation-id="formField-specialtyParent"]`:
**the fkit node is NOT an ancestor of the formField node on nested specialty fields** (unlike the top-level
`--null` entry containers, which DO wrap their formFields — the WE/Education/Languages composed-selector
pattern doesn't transfer). Operator devtools facts: the specialty widget is a Workday multiselect typeahead
carrying **`data-uxi-widget-type="selectinput"`** (no `multiselect` marker node), and the search input's
**`id` IS the fkit string** (`certification-172--specialties-{n}--specialtyParent`).

- **Fix — probe the relationship, don't assume it** (`cdpNestedFieldSel`, cdp.js + `act.nestedFieldSel`;
  `fillNestedSpecialtiesCdp` consumes it): at fill time, resolve the fkit node and return whichever SINGLE
  suffix-composable selector actually works — fkit-wraps-formField → the classic descendant compose; same
  node → the fkit selector alone; fkit INSIDE the formField (e.g. on the input) → `formField:has(fkit)`;
  no `data-fkit-id` at all → key on the element **id** carrying the fkit string (`formField:has([id=…])`).
  Null → an honest per-field `error` record, zero blind actuation (unit-pinned). NO comma-list selectors —
  the substrate string-appends suffixes (`loc.wrapperSel + ' input…'`), so a selector list would bind the
  suffix to only the last alternative.
- **Portability rules held:** every fkit string is composed from runtime-scanned indices (`parentOrder`,
  the nested-scan child enumeration) — audit confirmed zero hardcoded numeric fkit ids / element ids /
  GUIDs in shipping code (Workday's `-<N>--` counters are per-application random).
- **`cdpGenericNestedScan` classify + wrapperSel fixed in lockstep:** the scan's field `wrapperSel` now
  records via the same relationship ladder (it previously composed the blind descendant selector), and its
  typeahead rung now also matches `selectinput` (self-or-descendant) — a selectinput-only nested typeahead
  no longer misclassifies as text/unknown.
- **`cdpNestedDeleteRect` hardened for tenant variance:** the Delete finder now matches text
  "Delete"/"Remove", aria-label/title/automation-id variants, AND **icon-only trash buttons**
  (`svg[class*="trash"]`, e.g. `wd-icon-trash`) — the ancestor-scoping guard (never spanning the parent's
  own fields) is what keeps an icon-only match safe. Top-level `cdpDeleteEntryRect` (panel-header text
  "Delete") left as-is — live-proven on Magna/LiveRamp.

## 2026-07-01 — Workday error banner CONCATENATES all errors into ONE element (AI-4 remediation blind spot)

Live walk halt (Magna page 2, "Junior Full Stack Developer Coop"): Save & Continue blocked with a
Specialty-required error + the dup-language error; AI-4 remediation returned `no-action` and dirty-halted.
Three independent gaps lined up — the log is a keeper:

- **The top error-summary banner is ONE element whose textContent concatenates EVERY error**, each
  prefixed `Error-<FieldName>`:
  `Error-SpecialtyThe field Specialty is required and must have a value.Error-LanguageDuplicate language entries are not allowed.`
  The M31 `errorMarkers.samples` read sliced each element to 120 chars — fine as a diagnostic, but AI-4
  later made samples DECISION inputs, so any error past the first ~2 in the banner was INVISIBLE to the
  tiers. Live: two Specialty errors sat ahead of the language error → "Duplicate language entr…" fell past
  the cut → the Tier-0 dup-language hardcode never fired on a page that plainly showed its error.
  **Fix:** slice raised to 600 (cdp.js) + `expandErrorSamples` (lib.js) splits samples on the `Error-`
  prefix into individual error texts before ANY tier/AI-prompt/no-progress comparison sees them.
- **`[role="alert"]` catches success toasts too** — "Kevin's Resume 2.pdf successfully uploaded" counted
  as 2 of the "4 errors" and fed noise into the AI prompt. `expandErrorSamples` drops
  success-toast pieces (no "error" text + /successfully uploaded/). The fast-exit COUNT in
  `cdpWaitNextPage` is unchanged (errors-present ⟺ won't-advance still holds — the toasts only appear
  alongside real state).
- **Nested section fields are invisible to the remediation executor.** Tier 2's AI correctly named
  `specialtyParent`, but the refill executor looks fields up in the FLAT `act.scanPage()` — which
  deliberately excludes every field inside an indexed fkit entry — so it logged "not on the page" and
  skipped. Tier 1 (`mappedFieldsFromErrors`) is flat-FIELD_MAP-only by construction.
  **Fix — Tier 1.5 section re-fill:** `sectionsFromErrorNames` (fill-driver.js) maps parsed error titles
  to their OWNING `PAGE_SECTIONS` entry (heading regex / fieldMap labelRegex / camelCase field words /
  nested sub-section field labels — "Specialty" → certification), and `remediatePageErrors` re-runs JUST
  those sections via the new `drivePageFill({onlySections})` mode (flat loop skipped; reconcile-to-N +
  re-fill incl. nested specialties; same targeted-mode skips as `onlyFieldNames`).
- **Error-title quirk:** a blank nested template slot renders its error title with EMPTY parens —
  "The field Specialty () is required…" (alongside a plain "Specialty" for another row).
  `sectionsFromErrorNames` normalizes `()` away.
- **Orphan empty specialties are now reconciled away at N=0:** `fillNestedSpecialtiesCdp`'s old `!N`
  early-return meant a cert whose profile has NO specialties never deleted recon-mounted empty child rows
  (an empty REQUIRED specialtyParent blocks Save & Continue — this walk's actual blocker). The call site
  now always invokes the nested fill (childItems may be empty) and the reconcile-down loop runs at N=0 —
  the same reconcile-to-exactly-N semantics as the M21 top-level sections. The runCdpWalk "clear orphan
  specialties first" PREREQ log is retired.

## 2026-07-02 — AI-4 live round 2: blind Tier-2 delete + the refill-vs-delete rule for repeating rows

Second live walk with remediation (Magna, operator manually added an EMPTY extra Specialty row to
stage the error). What the log showed, in order:

- **Remediation entered with "0 error(s)" and Tier 2 acted BLIND.** The error-summary banner renders
  LATER than the ~1s fast-exit that triggers remediation, so the entry read found no error text; all
  deterministic tiers no-op'd (nothing to match) and the ladder fell through to Tier 2, whose AI —
  with an empty error list — chose `delete_entry certification-#0` (reason empty) and DELETED the
  correctly-filled cert entry. Every subsequent error (phantom dup-language fired next, then
  Specialty-required on the re-created entry) cascaded from that.
  **Fixes:** (1) `remediatePageErrors` POLLS for the banner (500ms × 8) before reading; (2) every
  attempt is HARD-GATED on non-empty expanded error text — no tier, including the AI, ever acts
  without an error to anchor on (`no-error-text` / `errors-cleared-not-advancing` clean halts);
  (3) `cdpWaitNextPage`'s fast-exit now counts EXPANDED errors, not raw markers — the raw count
  includes `[role=alert]` SUCCESS toasts ("resume successfully uploaded"), which persist through a
  slow clean transition.
- **Operator rule — repeating ⇒ optional ⇒ delete the blocking row, don't re-fill the section.**
  The old Tier 1.5 answered a "Specialty is required" error by re-running the WHOLE certification
  section: reconcile-to-profile-N + re-fill — which re-mounts profile specialties AND (via
  reconcile-DOWN) deletes entries the operator added by hand. New ladder:
  - **Tier 1.5 = deterministic DELETE** (`deleteTargetsFromErrorNames` + `deleteEmptyErrorRows`,
    fill-driver.js): map the error-named titles to repeating-section fields; delete every row whose
    named field reads EMPTY on the live page ("is required and must have a value" = an empty slot;
    a hand-FILLED row never reads empty → never deleted). A NESTED (layer-2) name (Specialty)
    deletes ONLY the inner rows via `clickNestedDelete` — the parent cert entry is never touched.
    Top-level rows read emptiness from the repeating scan's `value`; nested rows via the PROBED
    `nestedFieldSel` selector + `readLiveValueByWidget` — an unresolvable probe means the row is
    UNTOUCHED (never a blind delete). Cross-section-ambiguous names ("Start Date" = WE + nested
    specialties) target both — safe, the empty-only rule self-limits.
  - **Tier 1.6 = the section re-fill**, demoted behind the delete tier and now `preserveExtras`:
    the remediation re-run NEVER reconciles DOWN (top-level `driveRepeatingSectionCdp` skip + the
    nested `fillNestedSpecialtiesCdp` skip), so manual entries survive. The MAIN fill's M21
    reconcile-to-exactly-N is unchanged.
  - Tier 0 (dup-language hardcode) kept as the fast path — it live-verified this round (phantom
    mode deleted both languages correctly).

## 2026-07-02 — Magna wd3: nested fields contaminate every PARENT-entry scan (three stacked bugs, one fact)

The one DOM fact: **a cert's nested Specialties fields (`formField-specialtyParent`/`startDate`/`endDate`)
and its per-entry Attachments input live INSIDE the cert `--null` container** — so ANY scan that
enumerates a cert entry's `formField-*` descendants sees them as if they were the cert's own fields.
Three separate consumers tripped over it:

- **m3b reveal-by-add clicked the nested Specialties Add.** `cdpRepeatingScan.addButtons` is
  page-wide; "Specialties" matches no PAGE_SECTIONS heading and has no `--null` container → it passed
  every unknown-empty-section guard → reveal-by-add MOUNTED an empty specialty row it then could
  neither detect (no new `--null` prefix; the cert count unchanged — the row is INSIDE the entry) nor
  delete → a leftover phantom row on EVERY full-page fill (its required pick then blocked Save &
  Continue until Tier-1.5 cleaned it). Fix: addButtons carry **`insideEntry`** (any ancestor fkit
  with the `-<digits>--` infix — the cdpPageScan isRepeating idiom); m3b skips them;
  `revealUnknownSection` diffs `nestedScan` around its Add and deletes whatever a mis-click mounts.
- **The add-entry SHAPE leak.** `detectSectionShapes` runs on the PRE-FILL scan (the page's original
  state) and persists `section_shapes` for the viewer's "+ Add entry"; `captureDetectedShape` feeds
  the emptied-section stub. Both mapped `entries[0].fields` raw → with a specialty mounted at page
  load the cert template showed Specialty*/Start/End FLAT plus a second Attachments row. Both now
  exclude a known section's nested child field names (from its nested config), its attachments
  input, and ANY field with an EMPTY fieldName. Timing was never the cure — by end-of-page the fill
  itself mounts a specialty; the exclusion (config knowledge) is.
- **The Attachments wrapper is `formField-` with an EMPTY suffix** (fieldName ""), and
  `cdpRepeatingScan.classify` had NO `input[type=file]` rung → the attachments field typed "unknown"
  and evaded every `file_upload` exclusion (→ a text-box "Attachments" row in review). classify now
  has the file rung + the `selectinput` rung (the nested specialty typeahead carries NO "multiselect"
  node — only `data-uxi-widget-type="selectinput"`), LOCKSTEP with cdpPageScan/cdpGenericNestedScan.
  Empty-fieldName wrappers are additionally skipped by the sweep + the m3a already-filled emit.

**Also settled this round (fill-driver, not DOM):** a FAILED inline-AI rescue (needs_review,
after:null) must never pre-empt the resting honesty read — the live "summary showed nothing while
the page held 'Other - OTH'" bug: the AI record wins only when the page is genuinely blank (its
ai-* flag drives review reasons + the delete-sweep), else the kept-chip record wins with the AI
failure appended. And the PROACTIVE nested deleteOnNoMatch: a nested row whose required pick ends
BLANK on a definitive negative is deleted at fill time (value-holders/transients never; the
sub-section stub notes the removal).
- **Follow-up (same day) — keptLowerTier must never reach the inline AI.** With FoS PRE-FILLED
  "Electrical Engineering" (tier 1 of the profile's 4-tier list), the M36.1 guard walks only tier 0
  ("Electrical and Computer Engineering") → genuine no-match → the overwrite exit handed the field
  to `tryInlineAi`, which re-picked the SAME value and re-flagged it `ai-choice`/`filled_review`.
  The kept chip EXACT-matches a lower PROFILE tier — a STATED value with nothing to rescue; the AI
  rescue exists for the MISMATCHED pre-fill (`preTierIndex === -1`) only. Fix: the overwrite
  no-match exit gates the AI on `preTierIndex <= 0` → the deterministic keep (recommit →
  `filled`/`prefilled-better-tier-unavailable`) wins, zero LLM calls (invariant unit-pinned).
- **Follow-up 2 (same day, operator speed rule) — the keptLowerTier re-commit is RETIRED; Tab-close
  instead.** The affirmative re-type/Enter/click re-commit (the 2026-06-22 stray fix) predates the
  Tab-blur exit model, which established (live-proven) that Tab abandons an armed row WITHOUT
  committing. Since the kept chip is already correctly committed, the re-commit was a wasted ~4
  round-trips per field. `overwriteNoMatchResting` now Tab-closes on BOTH paths; keptLowerTier just
  VERIFIES the post-Tab chip: still == original → `filled`/`prefilled-better-tier-unavailable`;
  differs → `overwrite-stray` with the honest live value; vanished → honest needs_review. The
  recommitFn closure + TYPEAHEAD_SELF_VERIFY are deleted.

## 2026-07-04..06 — Hidden-tab SPEED: worker-timers, the virtualized-list scroll mechanics, and the dropdown close race

The rapidfire work surfaced four load-bearing DOM/runtime facts (all live-verified on Magna wd3):

- **A hidden tab throttles `setTimeout`/`setInterval` to ~1Hz and PAUSES rAF — but timers in a Web
  Worker DON'T.** A `blob:` Worker whose callback returns via `postMessage` escapes the main-thread
  background throttle. Injecting a worker-timers polyfill (`buildOverrideSrc`) that reroutes the page's
  `setTimeout`/`setInterval` (and rAF) through it makes a hidden fill run at page-speed. CAVEAT: this can't
  be ASSUMED (Workday CSP could block `blob:` workers, though Magna does NOT) — pace fast only on a MEASURED
  in-page `setTimeout(0)` round-trip (`cdpTimersFast`), never on install-success alone; a blocked/slow probe
  ⇒ the old slow-but-correct path, unchanged.

- **A react virtualizer does NOT re-render its rows on a programmatic `scrollTop` change when the tab is
  HIDDEN.** Live diag: `scrollTop` climbed 0→1772 over `scrollHeight 1984`, but the mounted `[role=option]`
  set stayed a FROZEN 17 rows — so the virtualized option scrape (`cdpScrapeTaOptions`) truncated the
  Field-of-Study list to the on-open window (~17 of 65). FIX: **dispatch an explicit `scroll` event**
  (`el.dispatchEvent(new Event("scroll"))`) after each `scrollTop` set → the virtualizer's scroll listener
  runs and mounts the new window even hidden. (Visible tabs re-render on the native scroll, so this was
  invisible until hidden fills became usable.)

- **A virtualizer keeps a MUCH larger window MOUNTED than the viewport** (viewport + overscan — ~17 rows
  mounted for a ~7-row / 211px viewport, i.e. the mounted span is ~2–3× `clientHeight`). So the scrape hops
  by the MEASURED mounted-window pixel span (`getBoundingClientRect` of the mounted rows), not by a
  viewport, with ~30–40% overlap — cutting a 65-item enumeration from ~12 hops to ~5 while never skipping a
  row. Per-hop it breaks the instant the mounted set changes (render-completion), not on a fixed frame.

- **A dropdown's trigger `aria-expanded` flips to "false" the instant Escape fires, but the PORTALED
  listbox lingers a beat still mounted and CLICKABLE.** So a fast close that returned on `aria-expanded`
  alone let the NEXT recon field's open-click land on a lingering option — the live "Landline committed to
  Phone Device Type" stray (Phone Device Type's dropdown overlapped where the Country-Phone-Code box sits).
  FIX: gate every read-only recon close on the LISTBOX/LEAVES being GONE — `optionCount === 0` (dropdown,
  `closeAndVerifyBlank`) / `leafCount === 0` (typeahead, `awaitTypeaheadClosed`; leaves = `promptOption`s) —
  before the next field opens. `listboxPresent`/`leafCount` come from `cdpReadDropdownState`/`cdpReadHierState`.

## 2026-07-06 — Typeahead option scrape: chips carry role=option + the list mounts a beat AFTER the searchBox opens

Live on Magna wd3, page 1, `countryPhoneCode` (a flat, prefilled-kept typeahead). The end-of-page review
recon (`captureFieldOptions` → `cdpScrapeTaOptions`) logged `0 options [role=2 prompt=2]` while the widget
VISIBLY opened a full country-code list. Two stacked facts, both now handled in `cdpScrapeTaOptions`:

- **Selected-value CHIPS carry `role="option"` markup** (the same chip-contamination seen in dropdown scrapes
  — `<li role="option" data-automation-id="selectedItem">` inside `selectedItemList`). A prefilled typeahead
  shows its value as ~1–2 such chips. The scrape counted them (`role=2`), which (a) LOCKED the option-selector
  to `role=option` and (b) were then filtered out by the visible/not-in-selectedItemList guard → **0 real
  options**. Fix: exclude `selectedItemList` descendants BEFORE choosing the selector (`nonChip`), so chips
  can neither mask nor lock the real list.
- **The virtualized option rows mount a beat AFTER the searchBox becomes visible.** `ensureFocused` gates on
  `searchBox.visible`, which flips true before the leaves render, so a single immediate scrape reads 0. Fix:
  `cdpScrapeTaOptions` frame-polls (rAF, ~24-frame ceiling, bails on a "No matches found" banner) until
  NON-CHIP leaves appear, THEN scrapes. Field-of-Study is scraped mid-fill when its list is already rendered,
  so it resolves at frame 0 — unchanged (still 65).
- **Selector divergence confirmed:** `countryPhoneCode`'s real leaves are `data-automation-id="promptOption"`
  (NOT `role=option`), matching the hierarchical-typeahead model (`cdpReadHierState`); FoS's are `role=option`.
  `cdpScrapeTaOptions` now tries `role=option` first, falls back to `promptOption`, picking whichever finds
  non-chip leaves (returns `roleCount`/`promptCount`/`usedSel` in the `[CDP-SCRAPE-TA]` log for future triage).

## 2026-07-06 — dup-language recon: a repeating-dropdown commit can MIS-CLICK a neighbor (coordinate click on a stale rect)

Live on a Magna walk: `language[0].language` (profile English) came back `needs_review` "commit failed for
\"English\" (trigger shows \"Chinese\")", and `language[1]` was Chinese → Workday flagged a DUPLICATE language
and AI-4 Tier-0 deleted one. The read-back CAUGHT it (flagged, not silent — the safety contract held), but
the value was wrong. Two independent hazards in the dropdown commit (`cdpDropdownOptionRectByText` +
`clickDropdownOptionByText`, cdp.js):

- **Vector A (the likely cause) — the option COMMIT is a coordinate click on a rect captured in a SEPARATE
  round-trip.** `cdpDropdownOptionRectByText` scrolls the matched option into view and returns its center
  `(cx,cy)`; `clickDropdownOptionByText` then issues a separate `cdpClickAt(cx,cy)`. Nothing re-verified the
  option was STILL at those coords. A still-settling / virtualizing portaled listbox shifts the row between
  the two round-trips, so the click for "English" lands on a NEIGHBOR ("Chinese" is a few rows away in an
  alphabetical language list). Intermittent, and AGGRAVATED by the fast-timer `delayRender` (shorter settle).
  **CORRECTION (operator clarified 2026-07-06):** this was the WRONG diagnosis. The two languages start
  **pre-filled and FLIPPED** (entry 0=Chinese, entry 1=English) and the fill must OVERWRITE each to the
  profile value; the overwrite click is not taking, leaving them flipped. It is NOT a neighbor mis-click. The
  `elementFromPoint` RE-CAPTURE that was added here was **REVERTED** — it regressed a previously-working
  overwrite (entry 1 had been committing; with the re-capture, BOTH entries failed). What's kept:
  `cdpDropdownOptionRectByText` still returns `hitTarget`/`atPointText`/`collisions`, and
  `clickDropdownOptionByText` clicks ONCE (prior behavior) but now LOGS `[ApplyPilot][CDP-DD-COMMIT] "<opt>"
  hitTarget=… atPoint=… collisions=… rect=…` per commit — a read-only diagnostic to capture WHY a pre-filled
  overwrite click fails (off-target click vs wrong-entry routing vs click-lands-but-no-recommit).
  **CONFIRMED by the `[CDP-DD-COMMIT]` log (2026-07-06):** VISIBLE and HIDDEN are byte-identical —
  `hitTarget=true atPoint="English" collisions=1 rect=456,298` — yet VISIBLE commits and HIDDEN does not
  (`language[0]` "English" never leaves "Chinese", persistence-poll to the ceiling; even the re-open retry's
  coordinate click fails). So a TRUSTED CDP COORDINATE click lands on the correct portaled option but does NOT
  fire its onClick when the tab is HIDDEN — the coordinate hit-test doesn't reach the non-composited overlay.
  (Not id-collision, not neighbor, not scroll — coords/target verified correct.) A DIRECT element-dispatch
  retry (synthetic robustClick on the option element) was tried — it **also failed** hidden, so it's NOT the
  click method. **ROOT CAUSE (confirmed via `forceWorkerTimersOff`):** it's the FAST PACING. Forcing the slow
  (all-`delayFull`) path commits BOTH languages correctly on the first coordinate click (`text-click-commit`).
  So committing a dropdown RE-SELECTION needs the just-opened dropdown to be INTERACTIVE before the click, and
  fast pacing (~70ms option-settle) clicks before it is — the click lands (hitTarget=true) but doesn't fire
  the selection, so it never commits. **FIX:** for an OVERWRITE (`before` is a real enabled option ≠ target),
  `fillDropdownCdp` inserts a NON-ADAPTIVE `act.delayFull(~700ms)` before the commit click (replicates the
  slow path's option-settle duration). EMPTY fills (`before` = the disabled placeholder, not an enabled
  option) don't race → stay fast, no beat. Net FASTER on the failing case (commits instead of burning two
  ~10s fail-poll+retry cycles). Proficiency dropdowns fill fine hidden because they're EMPTY (not overwrites).
  (The element-dispatch retry is now moot — the primary commits — but left as a harmless fallback.)
  **REFINEMENT (2026-07-06, `[DD-READY]` recon → made adaptive):** the hardcoded 700ms was live-verified but
  paid on every overwrite. Before removing it, a temp read-only sampler (`cdpDropdownReadinessSample`) logged
  the just-opened list's readiness signals every 100ms across the window — `aria-expanded`, listbox present,
  enabled-option count, `opacity`/`visibility`/`pointer-events`/`transition`, `aria-activedescendant`,
  selected-option, and the listbox rect. **Result: NOTHING flips 0→700ms — every signal is at its settled
  value from t=0.** So the list is fully DOM-READY immediately and there is **NO pollable readiness signal**;
  the ~700ms is a Workday-internal option-click DEBOUNCE with no DOM correlate. The only honest adaptivity is
  therefore ELAPSED-TIME. The sampler was removed after the recon.
  **FINAL SHAPE (2026-07-06, operator ask — "fill fast, refill slower only if it misses; log the refill rate
  to tune", then "make visible and hidden different"): FAST-FIRST with a slow refill fallback, VISIBILITY-
  SPLIT beats.** `fillDropdownCdp` records `openedAt` when the trigger reads `aria-expanded="true"`. For an
  OVERWRITE it runs **attempt 1 FAST**: wait only up to the fast beat since open, click, and confirm with a
  SHORT failure deadline (`min(overwriteFailFastMs, commitCeilingMs)`, default 600ms) so a miss is detected
  cheaply. If the fast click MISSES (didn't clear the debounce), **attempt 2 refills SLOW**: re-open if the
  list closed, wait the slow beat since the (re-)open, and commit with the full ceiling.
  **The beats SPLIT on REAL tab visibility** (`act.visible` = `cdpVisible`, tab active + window not minimized —
  NOT `cdpFast`, which is true for hidden+worker-timers): the debounce is a PAINT thing, so a VISIBLE tab needs
  a tiny beat and a HIDDEN tab needs ~700ms. Live-tuned + verified: **VISIBLE = fast `30` / slow `100`; HIDDEN =
  fast `120` / slow `700`** (`overwriteFastBeatMs`/`overwriteSlowBeatMs` + the `*VisibleMs` pair). 70ms hidden
  refilled both languages (proving the fallback); 100ms hidden committed fast (120 keeps a small margin); 30ms
  visible committed fast. A
  `[CDP-DD-REFILL]` line logs `"<before>"→"<target>" VISIBLE|hidden fastBeat=Nms → committed on FAST attempt |
  MISSED fast → refilled slow(~Nms): OK/FAILED` per overwrite, so the operator retunes from the log. The
  commit-PERSISTENCE re-read still gates every accept, so a fast miss can only cost a slow refill — never a
  wrong/silent fill (unit-pinned: a fast-miss dropdown re-opens and commits on the refill ending `filled` never
  left flipped; and the visible fast beat < hidden's). EMPTY fills (`before` = the disabled placeholder) never
  race → single fast commit, no beat. (`node -c` + 485 tests green.)
- **Vector B (latent) — the listbox is resolved by a GLOBAL `document.getElementById(aria-controls)`.** If the
  aria-controls id COLLIDES across repeating entries (unverified — the `formField-*` ids ARE duplicated
  across entries), getElementById returns the first-in-DOM listbox, which could be the WRONG entry's. The
  portaled listbox lives outside the entry subtree, so a `closest()` owner-check is unreliable; instead the
  commit now logs `collisions` (count of elements sharing the id) — `[CDP-DD-COMMIT] ⚠ aria-controls id
  collides…` — so the next occurrence confirms or rules out cross-entry routing. (Per-field ids ARE distinct —
  M14.1 `ctny0/1/2` — but per-ENTRY uniqueness for the same repeating field is still to be confirmed live.)
- **AI-4 dup-language dedups on the OBSERVED `.after`** (`lib.js` `languageEntriesFromResults`/`languageDeletionPlan`),
  so two-Chinese (one mis-filled) reads as a "real" duplicate → it deletes an entry and MASKS the mis-commit.
  It's a safety net, not a diagnosis — the real fix is preventing the mis-click above.

## 2026-07-06 — Dropdown CLOSE race in the FILL path: gate on options-GONE, not aria-expanded (and close-confirm the successful commit)

Operator report on this branch: "dropdowns don't close instantly — you must wait for the listbox to be closed
and options to be 0 before the next action or the dropdowns race." The recon close was already hardened to
gate on listbox-GONE (`closeAndVerifyBlank` / `awaitTypeaheadClosed`, `optionCount`/`leafCount === 0`), but the
FILL path had two gaps:

- **`closeDropdownConfirmed` (the fill-path close used by the tier-KEEP + genuine-no-match returns) gated on
  `ariaExpanded === "true"`.** aria flips to `"false"` the INSTANT a commit/Escape fires, but the portaled
  option list lingers a beat while it unmounts and its options STAY CLICKABLE — so it returned while options
  were still up, and the next field's open-click strayed onto a lingering option (the degree→"Associates" /
  "Landline → Phone Device Type" cross-field stray). Fixed to the SAME gate as the recon close: `stillOpen =
  listboxPresent && optionCount > 0`; poll (re-Escaping) until the options are gone, bounded by iterations.
  (Not a main-vs-branch drift — `closeDropdownConfirmed` is byte-identical on main; the recon-close hardening
  simply never reached this helper.)
- **The SUCCESSFUL COMMIT return didn't close-confirm at all** — it returned `filled` the moment the commit
  verified, while the just-committed list was still unmounting. Now every `fillDropdownCdp` return that opened
  the list — successful commit, commit-failed, tier-keep, no-match — calls `closeDropdownConfirmed` before
  returning, so the next field never opens over a lingering list.

`closeDropdownConfirmed` is now exported + unit-pinned (aria always `"false"` yet options linger 2 reads → the
gate must keep polling/Escaping until `optionCount === 0`; an aria-only gate would Escape zero times). Happy
path adds ~1 read (options already gone → returns immediately). `node -c` clean; 484 tests green.

## 2026-07-07 — Magna wd3 REVIEW page (the final application page) — observed for the review-page CHECK

The final review page is marked `[data-automation-id="applyFlowReviewPage"]` and groups the whole
application into sections (`<h3>`/`<h4>`: My Information → Legal Name / Preferred Name / Address / Email /
Phone; My Experience → Work Experience / Education / Certifications / Languages / Application Documents /
Websites; Application Questions; Voluntary Disclosures; Terms and Conditions). What the review-page CHECK's
scraper had to learn from tracing it:

- **NO reliable field labels.** Each field's value is a bare `<span>`/`<div>` with `data-automation-id=null`
  and NO associated `<label>`/`<dt>` — the label↔value pairing that works on the *form* pages is absent
  here. A label-first scrape mislabels wholesale (an ancestor/nearest-leaf fallback tagged address, phone,
  and screening values all as "How Did You Hear About Us?"). Lesson: reconcile by VALUE PRESENCE, not label.
- **Address is ONE blob.** Address Line 1 + City + region + postal + country render as a single span
  ("715 Middlebrooks Circle Tallahassee, FL 32312 United States of America"), so the individual fields are
  found by substring containment. The region is the **abbreviation** ("FL"), not the stored dropdown value
  ("Florida") → needs a name↔abbrev map.
- **Phone is formatted** ("+1 850-666-0266 (Mobile)") — the stored "8506660266" only matches on a
  digits-only comparison; the device type shows in the "(Mobile)" suffix.
- **File uploads** render as `data-automation-id="file-upload-item-name"` (the filename) inside an
  `attachments-FileUpload`/`file-upload-item` subtree, with an `ariaLiveMessage` "…successfully uploaded"
  sibling — match the résumé by filename containment.
- **Screening-question labels carry a trailing required marker** ("… please select No.*", "… age of 18?*",
  a double `**` on some) that the page's value/question leaf does NOT — so a label match must strip a
  trailing `*`/`**` (`normL`). Short answers ("Yes"/"No") appear as the next leaf after the question text →
  captured by label-anchoring on the (asterisk-stripped) question text, read the following value leaf.
- **Repeated identical values** (two work-experience "Tallahassee, FL" locations) collapse under any
  dedup → value-presence agrees for each bundle entry regardless (both are present), so no false "missing".

Approach that fell out: pass the bundle's claimed values as HINTS, value-anchor each onto the page, and
reconcile by presence (distinctive values) + label-anchoring (short values / checkboxes). See
`cdpReadReviewPage` / `reconcileReviewPage` and progress-log 2026-07-07.

## 2026-07-22 — logged-in host is `wdN.myworkdaysite.com` (tenant in the PATH, not the subdomain)

Observed driving the website Run end-to-end on Magna wd3. Two facts that shaped the tracker dedup + the JD scrape:

- **Two hosts, one job.** The public POSTING the operator pastes is `<tenant>.wdN.myworkdayjobs.com` (tenant
  in the SUBDOMAIN). After Apply + login, the application FORM is on **`wdN.myworkdaysite.com`** — the tenant
  is now only in the PATH (`/en-US/recruiting/<tenant>/<Display>/job/…`), NOT the subdomain — and the path
  carries a per-application-instance segment that CHANGES every run. So the full url is NOT a stable per-job
  key. The one token common to both hosts is the **data-center** (`wd3`/`wd5`/…); combined with the
  **requisition id** (`…_R00244793`, present in both paths) it gives a stable key `"<datacenter>:r<reqid>"`
  (`canonicalJobUrl`). Keying on the tenant subdomain splits the posting from the form (the myworkdaysite
  host has no tenant subdomain) — a real bug that produced two tracker rows per job.
- **`chrome.scripting.executeScript` is host-permission-gated.** The CDP walk works on myworkdaysite because
  `chrome.debugger` is NOT host-gated, but the JD scrape (executeScript) threw "Cannot access contents of the
  page" until `*://*.myworkdaysite.com/*` was added to `host_permissions`. Company/title can be read from the
  URL even structurally: title from the `…/<slug>_R<reqid>/…` slug, company from the `/…/<Display>/job/` path
  segment (the tenant subdomain works only on the myworkdayjobs posting host).
- **The "Something went wrong / please refresh" soft-error can appear right after login**, mid-Run — the fill
  walk now detects it (`cdpReadSessionState.softErrorPresent`) and reloads + restarts from page 1 (a refresh
  restarts the Workday application), same as onboarding's `maybeRefresh`. See progress-log 2026-07-22.

## 2026-07-25 — Caterpillar: create-account consent is "I accept" (not matched by the agreementCheckbox id or the consent word-list)

First live-verified-speed-era new-tenant probe (background Run, Caterpillar). Onboarding reached the
create-account form, filled email/password/verify-password cleanly, but logged "no consent checkbox
detected — proceeding" and the submit then no-op'd with the form still up, Workday rendering
**"Error: Please check the box to continue"** under its "Caterpillar Global Data Privacy Statement"
block. Observations (from the rendered page + the detector's misses — full DOM ids not yet captured):

- The consent checkbox is NOT `[data-automation-id="agreementCheckbox"]` (the Magna shape) — that
  selector found nothing.
- Its accompanying text is **"I accept"** — which the old label word-list
  (`/consent|terms|agree|privacy|acknowledge/`) does NOT match ("accept" ≠ "agree"), and/or the text
  is not in an associated `<label>` at all (the label-for / wrapping-label routes both came up empty).
- The auth screen also opens on the **Create Account view** with an `h3#authViewTitle` ("Create
  Account") that the cover-check reported OVER the Sign In tab target — the sign-in-first attempt was
  refused as a blind click, fell through to wrong_credentials, and the loop correctly converged on
  create-account (no fix needed; noted for the pattern).

**Fixes (same day):** `cdpConsentRect` adds `accept` to the word-list, also reads `aria-label`, and —
only when label/aria give nothing — the nearest SMALL ancestor's own text (≤250 chars, so a page-wide
container can never match); a CSS-clipped labelless input falls back to clicking its wrapper. And
`submitAndWait` gained a `beforeRetry` hook: Create Account re-runs `checkConsent` before every
re-click, so even a tenant the detector misses self-heals on retry 1 (checkConsent is idempotent —
an already-checked box is never unchecked). Capture the real automation-id of Caterpillar's consent
wrapper on the next probe to pin the selector.

## 2026-07-25 — Solar Turbines (cat.wd5): a section field's automation-id AND its WIDGET are both tenant-variable

Second Caterpillar-family probe (`cat.wd5.myworkdayjobs.com/en-US/solarturbines`, background Run). Page 2
filled 28/35 cleanly but `education[0].schoolName` came back **`error: field wrapper not found in entry`**,
and Save & Continue was then blocked by *"Error-School or University — The field School or University is
required and must have a value."* Two independent tenant differences, both first observed here:

- **The id differs.** `EDUCATION_MAP` resolved school by the single automation-id `schoolName` (Magna's).
  Solar Turbines uses something else, so `findFd` returned null and **no fill path ever ran** — this is why
  "none of the fallbacks worked": every fallback (AI canonicalize, required-empty AI, deleteOnNoMatch) lives
  *downstream* of a resolved wrapper. AI-4 remediation then guessed the field name `school`, which also
  wasn't on the page, and correctly declined to act.
- **The widget differs.** The page renders School or University as a **multiselect TYPEAHEAD** — the UI shows
  `0 items selected` (the chip counter), not an empty text box. Magna renders the same logical field as plain
  text. So even a resolved wrapper would have been filled by the wrong handler.

Also seen on this tenant (no fix needed): `skills` (typeahead) and `linkedInAccount` (text) are unmapped →
`skipped: no mapping`; `degree` offers "Bachelor of Science (BS)" so the stated "Bachelor of Science /
Bachelors" needed the AI canonicalize (→ `filled_review`, correct); FoS scraped **404 options**.

**Fixes (same day, fill-driver.js):** (1) a field-resolution LADDER — `labelRegex` | `field` | `altFields[]` |
`labelFallback` (a last-resort label regex), applied TWO-PASS at every call site (ids across the whole map
first) so a fallback can never steal a field another entry names exactly; (2) **widget-adaptive fill** — when
the live scan's `widgetType` disagrees with the map's, the LIVE type wins and the value is re-resolved for it
(a plain string becomes a single-candidate list for a choice widget, then goes through that widget's normal
match ladder + commit verification — never a blind commit). Restricted to text/textarea/dropdown/typeahead in
both directions; date/year/checkbox never swap (classify() can't see a date composite). The swap is recorded
on the record (`widgetAdapted`) and the record reports the LIVE widget so review renders the right editor.
Unit-pinned (5 tests). **Still to capture on the next probe:** the actual `data-automation-id` of this
tenant's school field, so it can be pinned as an alt instead of relying on the label fallback.

## 2026-07-25 — Caterpillar: the auth widget can OPEN on the Create Account view (both views carry email+password)

Follow-on to the consent-checkbox entry. Right after "Apply Manually" this tenant sometimes lands on the
**Create Account** view of Workday's auth widget, with sign-in behind an "Already have an account? **Sign
In**" link. Two facts make this dangerous, and together they produced a silent mis-fill:

- **Both views render `email` + `password` inputs**, so the onboarding test `st.passwordInput ||
  st.emailInput` ("a credential field exists ⇒ we're on the sign-in form") is NOT a view discriminator.
  The only reliable signal is the SUBMIT marker: `signInSubmit` vs `createAccountSubmit`.
- **The Sign In link's coordinate click was REFUSED by the cover-check**: `"Sign In tab" is covered by
  h3#authViewTitle.css-ll0fik "Create Account" — refusing a blind click`. The widget's own heading
  overlaps the link's click point, so `elementFromPoint` reports the h3, not the link. The refusal is
  correct in general (it's what stops blind clicks under popups) but here it's a false positive.

**Observed consequence (live):** the view never switched, the flow filled the CREATE-ACCOUNT email +
password, then `submitAndWait`'s generic `button[type="submit"]` fallback clicked **Create Account** while
logging `clicked "Sign In submit"` (the two canonical sign-in selectors had already `gave up` in
rectReady). Workday answered with a validation error, `classifyAuthOutcome` read `wrong_credentials`, and
the run "recovered" into the create-account flow BY ACCIDENT. Operator: don't do that.

**Fixes (same day, background.js + cdp.js):** `onSignInView`/`onCreateView` predicates keyed on the SUBMIT
markers; `switchAuthView(want)` clicks the canonical link, falls back to a page-side element click
(`cdpClickAuthSwitch` — text/automation-id matched, **submit buttons explicitly excluded** so a bare
"Create Account" text match can never press the submit, federated/chooser buttons excluded too), then
POLLS for the target view's submit marker and reports whether the switch actually happened. The auth loop
now switches + verifies BEFORE filling, and if the sign-in view can't be reached it goes to account
creation DELIBERATELY (logged) instead of mislabelling one form as the other. doCreateAccount switches +
verifies the same way. Sign-in failure → wrong_credentials → create-account is the unchanged existing path
(the operator's "try sign in, if it doesn't work go back to create account").

## 2026-07-25 — Solar Turbines: a phone-triggered SMS-consent checkbox REFLOWS the footer (and the stale-rect cover-check blamed an extension overlay)

Page 1 filled clean (13/14, audits matched) and then HALTED: `Save & Continue covered by
div.simplify-jobs-shadow-root — clicking its dismiss control: "Minimize"` → `auto-dismiss clicked
"Minimize" but the button is STILL covered — halting`. The overlay was NOT on the button. What actually
happened:

- **A consent checkbox mounts AFTER the phone number is filled** — a long SMS/marketing consent ("I
  consent to receive periodic automated text messages … I understand that my consent is not required.
  Reply STOP …" + a Terms and Conditions link). It is **cascade-revealed by the phone field** and it
  **pushes Save & Continue DOWNWARD**.
- **`clickPageNext` measured the footer rect once, then re-checked the cover at those SAME stale
  coordinates** (the post-dismiss `coverGone()` closure captured `rect.cx/cy`). After the reflow, that
  point no longer sat on the button — it sat on the floating extension widget — so the re-check could
  never clear and the walk halted naming the wrong culprit.
- Secondary: `document.elementFromPoint` returns the shadow **HOST** for any point inside its box, so an
  extension container that paints nothing at that point still reads as a cover.

**Fixes (same day, cdp.js):** (1) `clickPageNext` now RE-MEASURES the button (scroll + rect) on every
cover round — an initial-settle loop (3 × 250ms) before believing any cover, and a fresh probe inside the
post-dismiss poll — so the rect and the cover test always describe the same layout; (2) `cdpCoverCheck`
walks the whole `elementsFromPoint` stack and treats as see-through: Workday's `click_filter`,
`pointer-events:none` elements, and a shadow HOST whose `shadowRoot.elementFromPoint` finds nothing at
that point; reaching the target with only see-through things above ⇒ clear, and a stack with nothing
opaque ⇒ clear (a stale rect must not halt the walk).

**Open (needs a devtools capture on the next probe):** the SMS-consent checkbox did NOT appear in the
page-1 records at all — so it is either mounted after the cascade re-scan rounds or is not inside a
`formField-*` wrapper. It is OPTIONAL ("consent is not required"), and the optional-unmapped-checkbox rule
correctly leaves it UNCHECKED (never auto-consent to marketing SMS) — but it should still be inventoried
in the review bundle. Capture its wrapper/automation-id to decide whether the cascade scan needs a longer
reveal window or the field lives outside the scanned shape.

## 2026-07-25 — Caterpillar/Solar Turbines: the OFCCP disability self-ID is a CHECKBOX GROUP, and the SMS consent is blur-gated

Last page of the Caterpillar flow (the voluntary self-identification of disability form: Name /
Employee ID / Date / "Please check one of the boxes below"). Three observations:

- **The three answers are CHECKBOXES in ONE wrapper, behaving as pick-one** — "Yes, I have a
  disability, or have had one in the past" / "No, I do not have a disability and have not had one in
  the past" / "I do not want to answer". The operator confirmed the tenant **refuses a second check
  while one is set** (you must UNCHECK the current option first). `classify` only matched a *single*
  checkbox, so the wrapper fell through to `unknown` → the review editor rendered a bare TEXTBOX for a
  pick-one legal question. New widget type **`checkbox_group`**: option labels come from the SCAN (read
  from the DOM, no actuation), so even a BLANK field (voluntary ⇒ the bot must not answer it) reaches
  review as a real picker; the filler is label-EXACT, unchecks-then-checks, and verifies the end state
  (exactly one checked). Wired through the M40 audit and `replayField` (the submit-stage fill).
- **The Date field is a `MM/DD/YYYY` composite** (the signature date). Left to the operator in review;
  the date replay path already fills it from the approved value.
- **The SMS/marketing consent checkbox on PAGE 1 is BLUR-GATED.** It is revealed by the phone number,
  but only once the phone field BLURS — the fill leaves focus inside the box it just typed, so the
  checkbox never mounted while we were looking (it was missing from the records through BOTH cascade
  passes). Fix: `act.blurActive()` — a direct `activeElement.blur()` (not Tab, which would move focus
  INTO the next widget and could arm a typeahead) — runs once after the fold, before the reveal passes.
  The checkbox itself is OPTIONAL ("my consent is not required") → the optional-unmapped-checkbox rule
  leaves it UNCHECKED, which is the correct answer; it just needs to be INVENTORIED in review.

**Also fixed from this page (review UX):** records were produced flat-fields-first then
section-by-section, so a flat field sitting BETWEEN two repeating sections rendered above both. The
bundle's entry array is the render order in both viewers, so `orderResultsByDom` now sorts records by
the wrapper's document position (a section takes the position of its FIRST field; unpositioned records
inherit their neighbour's key; stable, so fill order within a section is untouched).

## 2026-07-25 (b) — Caterpillar DOM captures: school typeahead, self-ID date, and the orphan SMS consent

Operator-supplied DOM for three fields on the cat.wd5/solarturbines flow:

- **Education school = `formField-school` + `data-fkit-id="education-484--school"`, a MULTISELECT
  typeahead** (`data-uxi-widget-type="multiselect"`, chips in `selectedItemList`). Confirms both halves
  of the earlier fix: the automation-id is `school` (now an explicit `altFields` entry, so the label
  fallback isn't even needed) and the widget is a typeahead where Magna renders a text box (the
  widget-adaptive fill handles it). Its committed chip is a `promptOption` inside a `selectedItem` `li`.
- **The self-ID date is `data-automation-id="dateInputWrapper"` with three `dateSection{Month,Day,Year}`
  spinbuttons** (`-display` shows the MM / DD / YYYY placeholders; `-input` holds the value). The FLAT
  `classify` had NO date branch at all — those inputs carry no `type` attribute, so three of them made
  `textLike.length !== 1` and the field fell through to **`unknown`** → a bare textbox in review with no
  granularity. Now classified `date`, and the scan carries `dateSegments` so the review renders the
  form's OWN order/granularity (MM/DD/YYYY here, MM/YYYY or YYYY elsewhere) — the same `date_order`
  section dates already had. Unmapped flat dates stay unfilled (the operator fills in review; the date
  replay path fills them at submit).
- **The page-1 SMS/marketing consent checkbox is NOT inside any `formField-*` wrapper** — which is why
  it never appeared in the records regardless of cascade timing or the blur fix (the page scan only
  walks formField wrappers; the create-account consent needed its own finder for the same reason). New
  READ-ONLY `cdpScanOrphanCheckboxes` inventories rendered checkboxes outside the field set (skipping
  anything inside a repeating entry), and they surface as `consent.<key>` records flagged
  `consent-checkbox`, **left UNCHECKED** — an optional consent, especially a marketing one, is the
  operator's to give; the record just makes it visible with its full text.

## 2026-07-30 — LinkedIn's SDUI jobs rewrite + Handshake, both traced on the operator's live session

The first time either board was read from a real signed-in session. Both discovery
list scrapers shipped "structure-first" (written blind, because an authenticated
session wasn't available at build time) and this is the trace that was supposed to
tighten them. It refuted them instead.

### LinkedIn: every previous selector reads ZERO

All ~30 selectors in the old LinkedIn scrapers matched nothing on a normal signed-in
results page. This is a rewrite, not drift:

- **Result cards are not anchors.** A 25-result page contained exactly ONE
  `a[href*="/jobs/view/"]`, and it wasn't on a card. The old identity anchor ("every
  row carries a posting link, walk up from it") no longer exists.
- **Cards are `div[role="button"][tabindex="0"]`** with **no anchor inside at all**.
- **Every class is a rotating build hash** (`_778a8c0c`, `c1b80624`, `_620c85ec`), so
  a class-based ladder is unfixable in principle rather than merely stale.
- The page is **server-driven UI**: `data-sdui-screen="com.linkedin.sdui.flagshipnav.jobs.SemanticJobDetails"`,
  `data-component-type="LazyColumn"`, `data-testid="lazy-column"` (a virtualized list).

**THE STABLE ANCHOR — `componentkey`.** LinkedIn keeps semantic `componentkey`
attributes alongside the hashed classes, and the card's carries the job id:

    div[componentkey="job-card-component-ref-4445788818"]

Verified 25/25 unique ids off a 25-result page. Same convention elsewhere on the page:
`JobsSearchFilters`, `SearchResults_SearchTyahInputRef`, `semanticSearchBox`,
`LocationTypeahead_TextEditor`, `semanticSearchBoxLocationList`. **`componentkey` is
the thing to key on for this UI.** (The attribute appears on the card AND an inner
wrapper, so take the node with the longest text per id.)

**Card fields come from reading order, and there are THREE shapes.** No per-field
selectors survive, so title/company/location are the card's text lines — but the
leading a11y summary line varies:

    A  ["Title (Verified job)", "Title", "Company", "Location", ...]   <- verified postings
    B  ["Title",                "Title", "Company", "Location", ...]
    C  ["Title",                         "Company", "Location", ...]

A plain consecutive-dedupe handles B and C but **not A** — `"Title (Verified job)"`
isn't byte-equal to `"Title"` — which shifted every field by one on exactly the
verified postings: company took the title's value, location took the company's. Wrong
data that still looks plausible. Strip the decoration FIRST, then dedupe, then drop a
leading line that is merely a longer form of the next (`linkedInFieldsFromLines`,
regression-pinned against all three real fixtures).

### LinkedIn: the SEARCH PAGE DISCARDS most of its own URL params

Navigating with `location=`, `sortBy=` or `f_E=` and then re-reading the URL shows the
page has **rewritten it and dropped them**. Only `keywords`, `geoId`, `f_TPR`,
`currentJobId` and `start` survive. So the old builder — which sent free-text
`location` + `sortBy=DD` — had been running an **unsorted, unlocated** search all
along, silently. `start=25` IS honoured and returns a different 25 postings, which is
what makes deeper daily sweeps possible.

### Both boards expose the JSON their own front-end runs on

Read from inside a tab on that board, so same-origin with the operator's own cookies.

**LinkedIn search** — `voyager/api/voyagerJobsDashJobCards?q=jobSearch`, filters as
`selectedFilters:(...)`. Verified effects: `timePostedRange:List(r<secs>)`;
`experience:List(1)` = Internship (127 -> 25 results, all genuine interns/co-ops);
`jobType:List(I)` (8, over-filters); `workplaceType:List(2)` = Remote (22);
`locationUnion:(geoId:<n>)` **requires a numeric geoId — `locationName:` returns HTTP
500**; `start`/`count` paginate against a real `paging.total`.

WARNING — **`sortBy:List(DD)` destroys keyword relevance.** It does drop every promoted
row (all `promoted:false`), which looks like a free win — but date-sorted, "embedded
software intern" returns *EH&S Intern*, *Audit Intern*, *Finance Intern*: the newest
internships of ANY kind. On relevance the same query returns Skydio, Anduril, Blue
Origin avionics/embedded, Palantir. Use relevance and penalise promoted rows instead.
Note also that the page's own search is LinkedIn's newer **semantic** search and beats
the keyword API for the same words (STMicroelectronics / Neuralink / Intel / Redwood),
which is why the page is the primary search substrate and the JSON is the fallback.

**LinkedIn detail** — `voyager/api/jobs/jobPostings/<id>`: `applyMethod` is a TYPED
union whose KEY says everything — `...OffsiteApply` carries **`companyApplyUrl`, the
employer's real application page** (verified across Workday, Greenhouse `grnh.se`,
Lever, UltiPro, Oracle Cloud), while `...ComplexOnsiteApply`/`...SimpleOnsiteApply` mean
Easy Apply, i.e. no employer url exists. Also `listedAt` (exact epoch ms), `jobState`
(`LISTED` while live), `description.text`, `applies` (applicant count), `expireAt`.

**Handshake** keeps SEMANTIC `data-hook` attributes, and the card's carries the id:

    [data-hook="job-result-card | 11243659"]

plus `job-result-card-footer` ("Remote / New" / "Promoted / Pittsburgh, PA + 2 / 2wk
ago"), `job-hide-button-<id>`, `job-search-filters`,
`job-search-results-status-announcer`. Its cards ARE anchors (`a[href*="/job-search/<id>"]`,
25 per page). **Its JSON posting index (`/stu/postings.json`) IGNORES every filter
param** (the total never moves off 62,820 whatever you send), so the PAGE is the only
thing that can run a search. Page params traced: `query`, `jobType=3` (Internship;
62,820 -> 4,989), `per_page`, `page`, `sort`, `locationFilter`. WARNING — **`sort` is a
CLOSED set**: `relevance`, `application_deadline_asc/desc`, `posted_date_desc`,
`posted_date_asc`. An invented value is NOT ignored: it renders Handshake's "Something
went wrong. Please try again." page and the source returns zero.

**Handshake detail** — `/stu/jobs/<id>.json` (110 fields): `text_description` (plain
text JD), `created_at`, `applications_count`, `archived`/`hidden`/`is_postable`,
`job_type`, `location_names`, `promoted_job`.

WARNING — **THE APPLY LINK IS IN `job_apply_setting`, NOT `external_apply_link`.** The
record has both, and the obvious-looking pair
`use_external_apply_link`/`external_apply_link` is LEGACY: across 30 live postings it
was `false`/`null` on **every single one**, including postings that plainly apply
offsite. Reading it concluded "0% of Handshake jobs have an employer link" — which
would have silently reduced the whole source to nothing once board-only postings are
skipped. The authoritative config is nested:

    job_apply_setting: { apply_type: "handshake" | "external", external_url,
                         external_apply_type, additional_instructions }

Read that way, 10 of the same 30 (33%) carry a real employer link — Greenhouse,
Workday (`austintexas.wd5.myworkdayjobs.com`), Google Careers, Paylocity, Tesla — and
`additional_instructions` sometimes says "apply using the external link only; resumes
received via Handshake will not be reviewed", which is worth keeping.

### The location box needs TRUSTED input, and is not an `<input>`

Neither board's location token can be constructed: LinkedIn needs a numeric `geoId`,
Handshake a JSON place blob (`{"id":"place.15042796","label":"Austin, Texas, United
States","point":"30.268072,-97.742806","distance":"50mi"}`). Both are produced only by
that board's own typeahead, and LinkedIn's runs through an **opaque RSC server action**
(`/flagship-web/rsc-action/actions/server-request`, build-specific ids) so it can't be
called directly. So the resolver drives the real control — and three things bite:

1. **SYNTHETIC EVENTS DO NOT OPEN LINKEDIN'S LOCATION PANEL.** `el.click()`, a full
   pointerdown->mousedown->pointerup->mouseup->click sequence *with*
   pointerId/isPrimary/detail, Enter-on-focus, and clicking the inner child ALL left it
   closed. Trusted CDP `Input.*` works. Same lesson already recorded for the Workday
   auth form — some surfaces only register trusted events.
2. **LinkedIn's box is a contenteditable div, not an input:**
   `div[componentkey="LocationTypeahead_TextEditor"][contenteditable="true"][role="textbox"]`
   — so every `querySelectorAll('input')` strategy found nothing while the box was
   plainly open on screen. Handshake's IS a real
   `input[placeholder="Search by city, state, or zip code"]`.
3. **Suggestions carry NO `role="option"`/`role="listbox"`.** They are `<a>` rows inside
   `div[componentkey="semanticSearchBoxLocationList"]`. A role-based scan returns zero
   while five suggestions are visible; the row selector must include `a`.

Selecting a suggestion rewrites the board's own URL with the token — verified
`geoId=104472865` for "Austin, Texas, United States" and `geoId=104116203` for
"Seattle, Washington, United States" (pill "Seattle, WA (50 mi)") — so the resolver
reads its answer off the URL and caches it per (board, text).

## 2026-07-31 — Greenhouse / Lever / Ashby application forms, traced live (the multi-ATS recon)

Traced read-only in the operator's browser (no logins needed on any of the three; nothing
submitted). Forms probed: Anthropic + Figma (job-boards.greenhouse.io), Kraken
(jobs.lever.co/kraken123), OpenAI (jobs.ashbyhq.com/openai). These are SINGLE-PAGE forms
with no account, no session, and no server-held draft — unlike Workday, every visit starts
from a blank form, which makes "replay" = "re-fill from approved values" rather than a diff.

### Greenhouse (`job-boards.greenhouse.io/<co>/jobs/<id>`)

- **`boards.greenhouse.io/<co>/jobs/<id>` REDIRECTS to `job-boards…`** — the legacy host
  is a redirect now (Figma's own careers page links the legacy host). One form generation.
- **The form is ON the posting page** (one `<form>`, action = same URL). No apply-click
  needed to reach it. There is also a "Quick Apply with MyGreenhouse" button — NEVER click.
- **Standard fields carry stable semantic ids**: `first_name`, `last_name`, `email`,
  `phone` (type=tel), `candidate-location` (async city combobox), `resume`
  (`input[type=file]`, visually-hidden behind an "Attach" button). EEOC block too:
  `gender`, `hispanic_ethnicity`, `race`, `veteran_status`, `disability_status`.
  Custom questions are `question_<digits>` with the label in `label[for]`.
- **⚠ `#country` is NOT a country question** — it's the dial-code half of the phone
  composite (committed value renders `<div class=iti__flag iti__us><span>+1</span>`).
  The phone widget is intl-tel-input (`iti__*` classes, `iti-0__search-input`).
- **Selects are react-select v5** (`.select__container/.select__control/.select__menu/
  .select__option`, input `role=combobox` id'd like `react-select-<name>-…`), and they
  respond to PURELY SYNTHETIC events: mousedown on the control opens, native-setter +
  `input` on the inner input filters (244→1 verified), synthetic mousedown/click on a
  `.select__option` COMMITS. Committed value renders in `.select__single-value`.
  Menus render INSIDE the container (`.select-shell`), not portaled to body.
- **⚠ Option-scrape contamination, the Workday lesson again**: a page-wide
  `.select__option` read while another menu is open returns BOTH menus' options
  (observed: Yes/No + Yes/No + Male/Female/Decline). Escape did NOT close the menu.
  Scope every read to the widget's own listbox — the input's `aria-controls`
  (`react-select-<name>-listbox`) or the option-id prefix `react-select-<name>-option-`.
- **Required marking**: `aria-required=true` on the input + label text ends `*`. Required
  react-selects ALSO carry a visually-hidden `input[class*=requiredInput]` INSIDE the same
  `.select` — the native-validation mirror; its presence is itself a required signal.
- **reCAPTCHA is on the form** (`#g-recaptcha-response-…` textarea) — invisible flavor.
  Submit = `button[type=submit]` "Submit application".

### Lever (`jobs.lever.co/<co>/<uuid>/apply`)

- The posting page is `/<co>/<uuid>`; **the form is at `/apply`** — plain navigation, no
  click needed. Classic name-keyed HTML form, the most traditional of the three:
  `name`(Full name — ONE box), `email`, `phone`, `org` (current company), `location`
  (`#location-input`, plain text with a suggestion dropdown — free text is accepted),
  `urls[LinkedIn]`, `urls[GitHub]`, `urls[Portfolio]`, `urls[Twitter]`, `urls[Other]`,
  `resume` (`#resume-upload-input`, type=file).
- **Custom questions are `cards[<uuid>][fieldN]`** — radio groups (the `value` attr IS the
  full answer text), textareas, selects; label lives in the `.application-question`
  container's `.application-label`/`.text`. Required marker: the `required` attribute +
  "✱" in the label.
- **⚠ Conditional follow-ups are rendered AND `required` even when their controlling
  radio is unanswered** ("If yes, tell us more…" `field1` sits `required:true` next to an
  unanswered `field0`). Client validation presumably enforces only the visible/active ones
  — settle at submit-recon time; until then fill-or-flag, never trust the bare attr.
- **EEO demographics are `surveysResponses[<uuid>][responses][fieldN]` radios** — optional.
  ⚠ The radio NodeList contains TEMPLATE rows (a JSON blob + a bare uuid as `value`)
  before the real options — filter to visible elements.
- **Pronouns is a CHECKBOX GROUP** (`name=pronouns`, multi-select) + an "other" text input.
- **hCaptcha**: `#hcaptchaSubmitBtn` (hidden) next to the REAL `#btn-submit`
  ("Submit application", `.template-btn-submit`). Invisible challenge on submit; if a
  visible challenge renders, that is a needs_operator halt, NEVER solved by the bot.

### Ashby (`jobs.ashbyhq.com/<co>/<uuid>/application`)

- The posting is `/<co>/<uuid>`; **the form is the `/application` tab** — plain navigation.
- **The field wrapper carries a SEMANTIC class**: `.ashby-application-form-field-entry`
  (hashed css-module classes sit next to stable `ashby-*` ones — same pattern the
  discovery scraper already relies on for `ashby-job-posting-*`).
- **Field identity**: system fields are `_systemfield_name` / `_systemfield_email` /
  `_systemfield_resume` (note: ONE "Legal Name" box, not first/last); custom fields'
  id AND name are a bare uuid; labels via `label[for]`. `required` attr present.
- **Yes/No questions are BUTTON PAIRS** (Yes | No) inside a `_yesno_*` container in the
  field entry, with a hidden checkbox (name=uuid) tracking state.
- **EEOC block**: radios named `<blockUuid>__systemfield_gender/_race/_veteran/_disability`,
  label per OPTION (wrapping label). Consent checkboxes' `name` is the LABEL TEXT itself.
- Location = `role=combobox` input; "start date" questions render a date picker
  (`placeholder="Pick date..."`). Captcha iframe present (same policy as Lever).
  Submit = button "Submit Application".

### What this means for the fill (all three)

- All three commit state from SYNTHETIC events (proven live on GH react-select; Lever is
  plain HTML; Ashby's widgets are ordinary React handlers) → the fill can run page-side via
  `Runtime.evaluate` — identical visible/hidden, no Input.* pipeline, no focus emulation.
  The ONE trusted-input exception: the SUBMIT click (irreversible + captcha vendors score
  event trust) — same rule as Workday's act.clickSubmit.
- No login, no draft persistence ⇒ fill and submit are two visits to a BLANK form: the
  submit run re-fills from the approved bundle, verifies, then (armed) clicks submit.
- Required-field recon: GH = aria-required / requiredInput mirror / label `*`; Lever =
  `required` attr / label `✱`; Ashby = `required` attr. All fail toward over-flagging.

## 2026-07-31 (b) — react-select on a HEAVY Greenhouse form (Discord): four traps in one widget

Discord's SWE application (26 fields: an education section, EEOC, screening dropdowns) broke
every select while Anthropic/Figma/GitLab/Scale AI worked. Four separate causes, each now
handled in `ats.js`'s combobox path — all four are "the widget lied or wasn't ready":

1. **A one-shot read under-waits.** The old flat 250ms after opening reported "options did not
   render" on EVERY select of this form, each of which opens fine by hand. The same form then
   flip-flopped between "100 options" and "none" run to run. Menus are POLLED now (5th instance
   of the standing settle rule).
2. **`aria-expanded` LIES.** `degree--0` sat at `aria-expanded="true"` with NO menu in the DOM,
   so an expanded-gated open skipped the click forever. The open call takes a `force` flag; the
   driver forces after it has SEEN an empty list (a click can only help there — it opens the
   menu, or shuts a phantom-open one so the next click opens). The toggle-shut invariant still
   governs the default path.
3. **A controlled react-select input REVERTS a directly-set value.** Setting `.value` +
   `input` straight to the query gets replaced with `""` on the component's next render, so the
   query never reaches the filter. `clear → settle (SW wall-clock) → type` sticks. This is the
   Workday typeahead's "clear before typing" rule, earned again on a different framework.
4. **A long list only renders its first page.** The school picker shows 100 options starting
   "Aalborg University", so "Carnegie Mellon University" was declared absent from a list that
   had simply never been searched. The driver now SEARCHES BY NAME (a 2-word prefix — what a
   human types, and what a long async list answers fastest) and polls FOR THE HIT, never for
   "some options": while the widget searches it keeps showing the PREVIOUS page, so an
   exit-on-non-empty reads a stale list and calls the value absent.

**RESOLVED 2026-08-04 — see the entry at the end of this file.** The list was answering all along,
just later than the poll waited (~4.4s on a hidden tab), and it renders "No options" while it
searches. Two things had to change: an empty menu is no longer an answer while the widget reports
`loading`, and the retry no longer re-types (which restarted the widget's debounce and discarded the
in-flight search — so the old path could not have succeeded at any budget).

Original write-up:
⚠ **Still unresolved (honest limitation):** Discord's `school--0` async list returns results for
a hand-typed "Carnegie Mellon" in ~2s but returns NOTHING to the same query during a fill
(`typed=true stuck=true got="Carnegie Mellon"` and `list(0)` across ~5s of polling, foreground
AND background). The sibling race/gender pickers on the same form DO return filtered results
through the identical path, so the mechanism is right and this one list differs. It ends as an
honest `needs_review` naming the profile answer with the live options attached — never a wrong
value. Next probe: watch its network request while a fill types, to see whether the search fires.

Also on this form: `#country` is intl-tel-input's own dropdown (`iti__country-list`,
`iti-0__item-af`), NOT a react-select — and its 244 `[role=option]` rows sit in the DOM
permanently, so a page-wide option scrape "finds" 244 options for any widget. Every read stays
scoped to the field's own `react-select-<name>-listbox`.

## 2026-07-31 (c) — pacing a page-side-synthetic fill: read first, but DON'T poll faster than the page can paint

Multi-ATS actuates entirely through page-side synthetic events (`Runtime.evaluate`), so unlike
Workday there is no trusted-input pipeline to pay for — yet a HIDDEN fill still measured 37%
slower than a visible one (15.6s vs 11.4s over 20 GitLab fields). Two findings, in order:

1. **Waiting before the first read charges every already-open widget a full beat.** The poll now
   READS FIRST and only then waits, so a menu that is already open costs nothing. Free win.
2. **⚠ But the interval itself must stay REAL wall-clock.** Routing it through the adaptive delay
   (Workday's Stage-2 trick) collapsed it to ~20ms when timers measured fast — and since every
   tick is a `Runtime.evaluate` round trip, the polling STARVED the renderer: the same GitLab
   fill went from 4 review items to **11**, every regression reading "the dropdown opened but
   listed no options". Adaptive pacing is safe for Workday's *inter-action* delays; it is NOT
   safe for a poll whose own ticks are page evaluations. Fixed interval: 150ms.

Third lever: a HEALTHY widget exits on its first read, so open/search DEADLINES are paid only by
widgets that are failing anyway — one dead select was costing ~13s (3s open + 2×2.5s forced
toggles + 2×2.5s search). Trimmed to ~8s total, which is what closed the remaining gap.

Result: HIDDEN 21.0s vs VISIBLE 18.9s on the same 21-field form — an 11% difference, with
identical fill quality. Remaining wall-clock is dominated by LLM latency (4 AI answers), not
pacing. `[ATS-TIME]` logs seconds + ms/field + the tab's real visibility on every run, so the
next pacing round retunes from evidence.

## 2026-08-01 (a) — multi-ATS: employer-hosted landings, and one unresolved widget

**The posting URL is not always the form.** Three distinct landings observed in one session,
all from ordinary `job-boards.greenhouse.io/<board>/jobs/<id>` links:

| Landing | Evidence | Handling |
|---|---|---|
| Employer page **embedding** the form | one `<iframe src="job-boards.greenhouse.io/embed/job_app?for=…&token=…">` | follow the frame src (Asana) |
| Employer page with an apply **button** (no `href`) | a single `<button>Apply Now</button>` | click it, re-detect the landing (Samsara) |
| Employer page that genuinely **self-hosts** | apply leads back to its own host | halt `apply-off-pipeline`, name the URL (Databricks, Samsara) |

- **Do NOT construct the embed URL from a job id.** `…/embed/job_app?token=<id>` alone returns
  *Page not found* — the real src also carries `for=<board>` and a `validityToken`. Reading the
  employer's own iframe `src` is evidence; building one is a guess that 404s.
- **A hidden tab can skip layout**, so `getBoundingClientRect()` returns 0×0 for elements that are
  genuinely visible. That is what made Samsara's Apply button unfindable. Use
  `checkVisibility({checkVisibilityCSS:true})` (computed style, maintained in a hidden tab), and
  never let an all-invisible verdict end a run — fall back to the unfiltered set.
- **Ashby regenerates a per-page-load form-instance UUID** and prefixes it onto every custom
  question: the same question was `2c63133a-…-caa_fe19ec8e-…` at fill time and
  `1103cd1e-…-829_fe19ec8e-…` on the replay. The trailing question uuid is stable. Strip a FULL
  leading uuid followed by `_` (and the same before `__systemfield_`) or a clean submit fails with
  "approved value has NO matching field on the live form".
- **Greenhouse's location box needs `google.maps`, which does not load in this browser** — so it
  offers no suggestions to a HUMAN either. Not our bug; the typed text does persist in the box.

**RESOLVED 2026-08-02 — Greenhouse *demographic* comboboxes (numeric ids, e.g. `1478`/`1479`/`57037`)
are react-select MULTI widgets.** The trace below was the original write-up; the cause turned out to be
a READ bug, not a commit bug. A multi has NO `.select__single-value` — its selection renders as
`.select__multi-value` chips — so the read-back fell through to `el.value`, which is the SEARCH input
and is empty after a commit. The fill was landing correctly the whole time and we reported
`commit did not persist (read null)`. Two facts, both verified live:
- **The value is the chips.** Read `.select__multi-value` (prefer the inner `.select__multi-value__label`
  — the chip's text otherwise includes its remove-button glyph). Joined with ", " when several.
- **A further commit APPENDS, and an already-selected option is HIDDEN from the menu.** So a second
  pass cannot re-pick the same value and could pick a different one — live, that produced
  `Male` + `Female` chips on "Please identify your sex". Fix (operator's, 2026-08-02): do what a person
  does — press each chip's `.select__multi-value__remove` ×, wait, RE-OPEN (the removed option only
  returns to the menu afterwards), then click the wanted option. Verified: `["Male"]` → × → `[]` →
  menu re-offers Male → click Other → exactly `["Other"]`. Already-correct single chip ⇒ zero actuation.
  `atsInjCommitOption` is now async for this (the injected-eval path already sets `awaitPromise`).
Live result: all three required demographics now fill (`sex → "Male"` and `race → "Asian"`
deterministically, unflagged; the "ethnicity" one is AI-resolved because its LABEL says ethnicity while
its OPTIONS are the Hispanic/Latino set — correct answer, correctly flagged).

Original write-up:
**⚠ UNRESOLVED — Greenhouse *demographic* comboboxes (numeric ids, e.g. `1478`/`1479`/`57037`).**
On the same form where every other combobox commits, these three report
`commit did not persist (read null wanted "Male")`. Routing, matching and option capture are all
CORRECT (the review row renders the real option list, and the match is exact). The commit click
lands and the read-back returns null, so the fill honestly escalates to `needs_review` rather than
claiming a value — no wrong data, but three REQUIRED fields are left for the operator. NOT yet
traced to a cause: the form is served inside a cross-origin iframe on the employer page, so it
could not be inspected from the top document, and guessing at a fix was refused. Next step is a
CDP-attached trace of the embed URL itself (it is reachable directly once the frame src is read),
watching where the committed value renders.

## 2026-08-02 (a) — multi-ATS: employer-hosted landings, end to end

Employers host these three ATSs on their OWN domains far more often than the board URLs suggest,
and every stage has to cope:

- **A settled field count is not a form.** An employer careers page's direct-mail signup settled
  at 2 fields (`dm-reservation-number`, `dm-postal-code`), so a run filled a MARKETING widget and
  filed an application record. Identify the page positively instead:
  `atsLooksLikeApplicationForm` = a SUBMIT control AND an identity anchor (resume / email / name).
  Rejecting the widget then drops into the embedded-frame recovery, which finds the REAL form on
  the same page — SoFi went 2 junk fields → 42 real ones.
- **An employer careers URL matches no ATS host pattern**, so a fill falls to the Workday onboard
  path. Two different pages failed there two different ways (`unknown-page`,
  `auth-form-not-rendered`) for the same reason. Probe for an embedded ATS ONCE, before entering
  that path, and hand off. Pinterest fills from `www.pinterestcareers.com` this way.
- **The submit run must go where the FILL went** (`bundle.url`), not the caller's posting link —
  otherwise the replay lands back on the employer page and dies at `form-not-rendered` for a job
  that fills perfectly. It carries the same embed recovery as a second net.
- **A job's identity must survive a landing hop.** Keying the application on the URL the fill ENDED
  at meant a re-fill created a DIFFERENT tracker row, so the original row kept a stale bundle
  forever and its submit failed against fields that no longer exist. `bundle.jobKeyUrl` records the
  link the run STARTED from; `bundle.ats` records which pipeline filled it (a submit can't
  re-derive that from an employer URL).

**RESOLVED 2026-08-02 — it was never a disagreement: the submit was pulling the WRONG APPLICATION.**
`canonicalJobUrl` returns `origin + pathname`, dropping the query — but a Greenhouse EMBED url carries
its job identity ONLY in the query (`/embed/job_app?for=<board>&token=<id>`), so EVERY employer's
embedded application collapsed to the single key `job-boards.greenhouse.io/embed/job_app`. Two
compounding causes:
- the tracker row stored `bundle.url` (the FORM url = the embed url), so a submit re-deriving its
  job_key from that row looked up the colliding key;
- every embed-served row therefore shared one key, and the lookup returned whichever row it found.
The evidence that cracked it: every pull logged **"loaded the website-approved bundle (14 fields)"**
while the job being submitted had 25 (Asana) or 65 (SoFi) — 14 was a THIRD company's (Pinterest)
bundle. The review page and the gate were each right about a DIFFERENT application, which is exactly
why the UI could show "6 / 6 approved" while the gate named an unapproved field the operator had never
seen ("Please select your country of residence…", `flag=ai-choice`, from the other job).
Fixes: `canonicalJobUrl` keeps the `token`/`gh_jid` param for `/embed/job_app` urls (LOCKSTEP in
lib.js + web/lib/job-key.ts, pinned with the non-embed shapes it must still collapse), and the row
stores `bundle.jobKeyUrl` — the link the run STARTED from — so the tracker shows the posting rather
than an opaque validity-token url. A blocked submit now also PRINTS each waiting field with its
needs_review / cascade_revealed / approved / flag, which is what made this diagnosable at all.
Verified: Asana's pull went from "14 fields" (wrong job) to "25 fields, 6/6 flagged approved" → replay
25, 0 failures, would-submit. Rows written before the fix carry the colliding key until re-filled.

Superseded write-up:
**⚠ OPEN — the submit gate and the review UI can disagree.** On SoFi's 65-field form the review
page reports `49 / 49 flagged fields approved` with ZERO unapproved rows rendered, while
`bundleSubmitBlockers` refuses with `1 flagged/revealed field(s) not approved
(/embed/job_app::formField-question_67708891)`. The operator has no way to clear it from the UI —
a dead end. The two predicates are documented as LOCKSTEP (`requiresApproval` in
web/lib/review-approval.ts vs `bundleSubmitBlockers` in fill-driver.js) and they have at least one
known asymmetry: the web envelope drops `isHiddenPreferredName` entries from its denominator and
the extension gate has no equivalent — but that exclusion needs a controlling "I have a preferred
name" checkbox, which a Greenhouse form does not have, so it does NOT explain this instance. NOT
fixed: the cause is unproven and the entry could not be read back (`/api/extension/review` returned
no bundle for that job_key). Next step is to dump the offending entry's `needs_review` /
`cascade_revealed` / `is_approved` / `flag` from the stored bundle and diff the two predicates
against it.

## 2026-08-02 (b) — multi-ats: an apply hop can reveal the form in place

**Clicking Apply does not always navigate.** On an employer careers page the Apply button
INJECTED the Greenhouse iframe into the page it was already on — `location.href` never changed
(it only gained `?gh_jid=`). A url-only re-check after the hop therefore saw an unsupported host
and halted `apply-off-pipeline` on a fillable application. After ANY apply hop, classify the
landing the same way the first landing is classified — URL, then embedded frame — and POLL for
either (the injected frame arrives asynchronously; a single sample after a flat wait misses it).
Live: Roblox went from `apply-off-pipeline` to 32 fields filled. Third occurrence of one rule:
wherever this pipeline concludes "no form here", it must ask BOTH what URL we are on AND whether
a form is embedded on it.

**PARTLY RESOLVED 2026-08-02 — two separate things were tangled here.**
1. **A real, deterministic MATCHING gap (fixed).** The profile stores the phone country as
   `"United States of America (+1)"` while the option reads `"United States +1"`. Stripping only the
   OPTION's code leaves `united states` vs `united states of america`, which cannot match by exact,
   containment OR fuzzy — reproduced in isolation. `atsDialMatch` adds a last-resort tier requiring
   TWO signals to agree: same dial CODE **and** one country name prefixes the other. Neither is safe
   alone (+1 is shared by the US/Canada/Caribbean — the parked dial-suffix idea; and a bare prefix
   would let "Congo" swallow "Congo, Democratic Republic of the"), and 2+ satisfying options refuse.
   It runs ONLY after the normal ladder fails, so it cannot mask a working path.
2. **The intermittent empty list is STILL UNEXPLAINED, and did NOT reproduce on a deliberate
   hidden re-test (2026-08-02).** Eliminated so far, each by direct test on the live widget rather
   than reasoning: the widget itself (plain click -> 244 options, type -> 1, clear -> 244); the
   CLEAR-then-type sequence the filler uses (operator confirmed Ctrl+A / Delete / type also yields
   the single option); the SCOPED read (`atsInjReadOptions` run VERBATIM in the page resolves
   `aria-controls` -> `react-select-country-listbox` and returns 244 / 244 / 1 across open, clear
   and type); and focus emulation (`cdpSetFocusEmulation(true)` is already on for the ATS fill run,
   same as the submit run). A deliberate HIDDEN run then filled it `exact-normalized ->
   "United States +1"` with no review. What the log's final `listed no options` DOES tell us: the
   FIRST poll must also have come back empty, because when the restore step reads empty the code
   keeps the earlier non-empty list — so the menu produced nothing for ~7s across three separate
   polls, rather than glitching once at a deadline. Still open.
   **NOTE on how it matches today:** the log prints the SCAN's widget type (`typeahead`) while the
   route refines it to `dial` for actuation, so options are dial-stripped to "United States" and the
   profile's TIERED `country_phone_code` (long form first, bare "United States" later) hits
   exact-normalized. `atsDialMatch` therefore does not fire for this profile — it is the net for a
   profile holding only the long form. On a later hidden run the same field filled
   `exact-normalized → "United States +1"` with no review, i.e. the symptom did not reproduce, and
   the successful path did NOT go through the new tier. So the original `list(0)` remains
   unattributed — the widget is healthy by hand (plain click → 244 options; typing "United States"
   → exactly 1; clearing → 244), which still points at menu STATE around the typed query rather than
   matching. Do not consider this closed.

**⚠ Original observation — a typed search on Greenhouse's `#country` dial composite intermittently
sees an empty list.** Live on a HIDDEN Robinhood run: `country search "United States" → no hit; typed=true
stuck=true; list(0)`, ending `needs review · the dropdown opened but listed no options`. The
widget itself is healthy — traced by hand on the same form: a plain click renders **244** options
("United States +1", "Afghanistan +93", …), typing "United States" filters to exactly **1**, and
clearing restores 244. So this is menu STATE/timing, not matching: the likeliest cause is the
forced-toggle recovery leaving the menu SHUT when the query is typed (two clicks = closed), with
the restore-unfiltered step then also reading a closed menu. Not fixed — the failure is honest
(`needs_review`, never a wrong country) and there is no reliable reproduction from outside yet.
Next step: log `aria-expanded` and the menu node's presence immediately before and after
`typeInto` on this widget, on a hidden tab, to confirm the shut-menu theory before changing the
open/retry ladder.

## 2026-08-02 (c) — Workday: three new Solar Turbines postings, one fix and one open bug

Ran three FRESH cat.wd5/solarturbines postings (SOX Supervisor R0000383804, Senior Supplier
Technical Engineer R0000372989, Maintenance Technician I R0000371125) hidden, end to end.

**FIXED — the fill walk never got the trusted re-write.** All three halted on PAGE 1 with the
phantom-required error (First Name / Last Name / Phone Number reported empty on a page holding all
three, 13 fields filled and read-back verified). Two causes, and the ORDER one was decisive:
- Tier 1 re-filled the error-named fields with the SAME synthetic input Workday was ignoring — a
  no-op by construction. It now forces TRUSTED input (save/restore via `cdpSyntheticInputEnabled`).
- The phantom-required NUDGE (Tier 0.5) ran FIRST, always "ran", set `didSomething`, and CONSUMED
  the single attempt, so Tier 1 never executed at all — fixing the input alone changed nothing, and
  the log proved it by never printing the new Tier-1 line. The nudge is now demoted below the
  trusted re-write, exactly as the REPLAY walk demoted it on 2026-07-28.
All three then advanced past page 1 and reached the review page (5 pages), nothing submitted.
NOTE this reproduced on 3/3 NEW postings of a tenant whose two OLDER applications never showed it —
it is a property of the page, not of one job.

**RESOLVED 2026-08-02 — and the suspicion in the note below was WRONG.** The replay DOES share the
`fmMatchesFd` ladder (`replayRepeatingSections` → `driveRepeatingSectionCdp` → `fillEntryCdp`), and the
entry resolved fine — `education[0].schoolName` even adapted text→typeahead on the same run. The real
cause: the section maps are the UNION of every Workday shape observed, and **Solar Turbines' education
entry has only School + Degree** — no GPA, no from/to years. The review page proves it (`ENTRY 1 |
Delete | School or University* | Degree*`), and the approved bundle holds no values for them. So
EDUCATION_MAP's gpa/date fields never resolved, and never could.
`fillEntryCdp` reported that as `error` BEFORE checking whether there was anything to fill. The FILL
shrugged it off; the REPLAY treats any error as "did not replay cleanly" and HALTS. Fix: a missing
wrapper with NO value is `skipped`; a missing wrapper we DO hold a value for stays an `error` (an
approved answer with nowhere to go must still stop the run) — pinned both ways, and the skip test is
verified to fail without the change while the error counterexample still passes.
Live, same job: `page 2 replay: 32 field(s) — 6 changed, 20 already-correct, 6 not-actuated, 0 FAILED`
(was 3 FAILED → halt), all 5 pages replayed, review page AGREE 44 · DISAGREE 0 · MISSING 3 · EXTRA 1,
SUBMIT GATE PASSED — would-submit, nothing clicked.
**Lesson worth keeping: a union field-map means "absent" is normal, so absence must only be fatal when
we are holding a value for it.**

**Superseded note — the REPLAY can't resolve education entry fields that the FILL resolved fine.** On the
rehearsal of R0000372989, page 2:
```
page 2 replay: 32 field(s) — 6 changed, 20 already-correct, 3 not-actuated, 3 FAILED
   education[0].gradeAverage      (text) error — field wrapper not found in entry
   education[0].firstYearAttended (date) error — field wrapper not found in entry
   education[0].lastYearAttended  (date) error — field wrapper not found in entry
→ HALT replay-mismatch
```
Those three fields were FILLED minutes earlier on the same page and carry values in the approved
bundle, so the wrapper existed for the fill and not for the replay. `field wrapper not found in
entry` is the SAME string the 2026-07-25 tenant-variable work fixed for the FILL by resolving entry
fields through the `fmMatchesFd` ladder (labelRegex | field | altFields | labelFallback, two-pass).
Whether the replay's repeating-section path shares that ladder — or whether the entry is simply not
expanded/mounted at replay time — is UNVERIFIED; do not guess, read `replayRepeatingSections`
against `fillEntryCdp` first. The outcome was SAFE (halt before advancing, nothing submitted), and
the other 26 fields on the page replayed correctly.

## 2026-08-02 (d) — the prompt row, the contaminated sign-in box, and halts that named the wrong cause

Three findings from a Workday session whose point was the REVIEW→REHEARSE contract: approve a bundle,
deliberately change some answers, and check the replay follows the human, not the profile.

### "Select One" is a real, ENABLED option on some tenants (Waystar wd1)

Workday normally marks the placeholder `aria-disabled="true"`, and every option reader here already
drops those. Waystar's is a plain enabled option. So it reached `aiFillField` inside `enabledTexts`,
the model was told to pick exactly one, and it picked the prompt row. The fill recorded
`filled_review` with a justification — a confident-looking answer — and Workday then rejected the page:

    Error-... The field ... is required and must have a value.

Two properties of the placeholder matter, and the second came from the operator:
  * it is not an answer — the form counts it as unanswered even though it renders as a value;
  * on Workday it is TEMPORARY. Once a real option is chosen the placeholder LEAVES the menu and
    cannot be chosen again. So the review editor was offering a choice the form no longer permits.

`isPlaceholderOption` (lib.js, pure) recognises it by TEXT — generic across tenants and ATSs, no
page-specific selector. Narrow on purpose: the prompt vocabulary (select/choose/pick/please select),
pure punctuation, and only when the row carries no answer content of its own. "Select One" matches;
"Select all that apply to you" must not. The failure direction is deliberate — a missed placeholder
costs one flagged review row, while eating a real option would silently delete a valid answer.
Applied to the three AI dropdown prompts, the review editor's option lists, and the blank test in
`bundleSubmitBlockers`/`approvalEnvelope` (scoped to CHOICE widgets — a text answer reading "select
one" is a real answer). LIVE-VERIFIED on the same Waystar question afterwards: it committed "Yes, I am
open to relocating".

### The sign-in email box kept content we did not type, and the clear silently failed

    filled "email" — read-back MISMATCH (got "wangykev+1@gmail.comtester+10@gmail.com")

The box already held another address (browser autofill), `cdpSelectAllDelete` did not take, and
`cdpInsertText` APPENDED. This reproduces reliably on this tenant — the retry log now shows it every
run: `clear attempt 1 left "wangykev+1@gmail.com" in the box`. The keyboard clear needs the field to
hold BOTH focus and a selection; a page-side native-setter clear needs neither, and recovers it.
The rule that generalises: **a clear is an action with an outcome, so read it back before typing** —
the same discipline every other commit in this codebase already follows.

`fillField` also already RETURNED `{ok:false}` and logged the mismatch; the sign-in caller dropped the
value and clicked Sign In anyway. That is worse than stopping, because Workday answers "wrong
credentials", the flow believes it, and can go on to CREATE AN ACCOUNT for an address that is not ours.

### Two halts asserted causes nobody had observed — and both were wrong in the same session

  * the stalled sign-in was reported as Chrome's "password found in a data breach" dialog. Operator:
    "this was not a password breach." The real cause was the contaminated box above, and the confident
    wrong explanation is what sent the debugging the wrong way.
  * the replay's non-advancing page said "a required field is empty" for EVERY nav-timeout. Live it
    said that while Workday's own banner read **"32312 is not a valid postal code for Georgia"** — a
    consistency check between two FILLED fields, nothing empty anywhere.

Both now report what was observed and quote the page. Standing rule, third instance: **a halt may state
what it saw and what it tried; it may not name a cause it has not verified.** A wrong diagnosis is more
expensive than none, because it is believed.

### The review→rehearse contract, verified end to end

Two Magna applications, seven deliberate edits made by hand in the website review editor, spanning
text, dropdown, repeating-entry text, textarea and a self-ID dropdown. Both replays followed the human
value, visibly overwriting the bot's: `"Florida"→"Georgia"`, `"Mobile"→"Landline"`,
`"Male"→"Undeclared"`. Review page came back **AGREE 46 · DISAGREE 0 · MISSING 0** and
**AGREE 45 · DISAGREE 0** → WOULD CLICK SUBMIT. Nothing was submitted.

The sharpest evidence is an accident: editing State to Georgia while leaving the Tallahassee ZIP made
Workday itself reject the combination. The replay wrote the human's Georgia and kept the unedited
32312 — it did not quietly repair the pair from the profile. A bot that silently "fixed" that would
have hidden a human's edit, which is the one thing this stage exists to prevent.

## 2026-08-03 — five bugs found by running the whole human flow, twice per job

Method (operator): find the job, run it from the website, open the review, approve and CHANGE
answers, rehearse. Copart and PSECU. Every one of these was invisible from the outside — the run
either halted several steps from the cause, or reported success while something was quietly wrong.

### 1. The error parser stopped at the LABEL's own stop-word

Workday's banner is `The field <LABEL> is required and must have a value.` The pattern was non-greedy
over `(is|are|must|...)`, so a label containing " is " ended the match early:

    The field What is your desired compensation is required...   ->   "What"

Every "What is your …" question hits it. A truncated name matches no wrapper, so Tier-1 remediation,
the phantom-required guard and `[FIELD-DIAG]` all received a useless name and did nothing — while the
log said "matched 0 wrapper(s) — inside a repeating section? not rendered?", pointing the
investigation at the wrong thing entirely. Fixed by trying the known full phrasings first.

### 2. A value the FORM rejected still counted as filled

"N/A" went into a required compensation box. The write verified; the M40 audit re-read it and matched.
Save & Continue then answered "is required" with the box empty in DOM, reactProps and fiber alike —
Workday discarded it during validation. **Every check we own runs before that point**, so the bundle
kept claiming `current_value:"N/A"`: review would show an answer the form does not hold, the human
would approve it, and the replay would re-enter the same rejected text forever.

`rejectedValueEntries` now compares record vs live scan for each field the error NAMES, and blanks
only those (needs_review, un-approved, naming the rejected value). Narrow, because blanking destroys
data. **Its first version was itself a silent no-op** — it matched by LABEL, and after a blocked save
the scan's label is `"What is your desired compensation *Error: The field ... is required..."`,
since Workday renders the message INSIDE the wrapper. Now keyed on the scan's `fieldName` (which the
entry's `field_id` encodes) or a UNIQUE label prefix, and every no-op says why.

### 3. An absent allowlist read as "switched off"

`autofill_rules.generation_allowed_only_for` gates AI free-text. The check required the key to be
PRESENT and to list open_ended — and **the website's profile model has no such key** (nor
`application_questions` / `writing_style`; see web/lib/profile-schema.ts). So every profile arriving
through AP_SYNC_PROFILE — the primary path — disabled generation, every required free-text question
got "N/A", and the log blamed an operator setting nobody had made. Absent now takes the shipped
default; an EXPLICIT `[]` still means off.

### 4. A required pick-one CHECKBOX GROUP had no path to an answer

PSECU's required ethnicity question renders as a checkbox group. No FIELD_MAP entry; `aiEligible`
excludes checkboxes; the required-radio pass keys on `widgetType === "radio"`; AI-4's Tier 2 declined,
correctly ("a single value string via refill would not satisfy a checkbox widget"). Four layers each
right locally, and the field still could not be filled — so Save & Continue could never pass and the
walk halted on that tenant every time.

`aiFillCheckboxGroup` mirrors `aiFillRadio`. The line that matters: a bare **checkbox** stays excluded
because ticking one is an ASSERTION ("I agree", "I certify") and an AI must not assert for someone; a
checkbox **group** is a pick-one SET, the same shape as a radio.

### 5. A requisition id is not always `R<digits>`

`canonicalJobUrl` matched `_R\d+`. Copart and PSECU issue `JR109393` / `JR100897`, which fell through
to the origin+pathname fallback — and that is not stable, because **Workday redirects the URL you
paste to its own spelling**: `Harrisburg-PA` -> `Harrisburg%2C-PA`. One posting produced TWO tracker
rows, and the rehearsal REFUSED its own approved bundle (rightly — it cannot tell "my bundle under
another key" from "another application's bundle"). Any letters+digits token now keys the same way;
the `_R` tier still matches first, so existing keys are byte-identical.

### What passed

PSECU HR Intern, the whole flow: 4 pages filled -> review -> approve 8 flagged -> change the
AI-guessed demographic and the phone device type -> re-approve (a value edit correctly RESET its
approval) -> rehearse -> **AGREE 49 · DISAGREE 0**, `"Mobile"->"Landline"` committed on the form,
WOULD CLICK SUBMIT. Nothing submitted.

Still open: Copart's required "What is your desired compensation" is unanswerable from the profile —
the AI correctly refuses to invent a salary and the form rejects "N/A". That one needs a profile
answer, not a code fix.

## 2026-08-03 (b) — the checkbox-group SET, live-verified end to end

Closing the gap left when PSECU was wedged at sign-in. After the multi-key AI merge it signed in
again, and the whole path ran on the real form:

  fill        -> ethnicityMulti AI-filled "Asian", flagged AI-GUESSED DEMOGRAPHIC
  review      -> renders SEVEN real checkboxes, exactly as the form does (not a <select>)
  human edit  -> ticked "White" as a second answer; the row showed "2 selected — this form
                 accepts more than one", and the edit RESET that field's approval
  approve     -> 8/8, submit-ready
  rehearse    -> AGREE 49 · DISAGREE 0 -> WOULD CLICK SUBMIT (nothing submitted)

And the part that actually matters, checked INDEPENDENTLY rather than taken from the replay's own
report — walked the live application back to page 4 by hand afterwards and read the DOM:

    checkedOnTheFORM: ["Asian (United States of America)", "White (United States of America)"]

Both boxes really are checked on the form. A replay reporting success is not the same claim as the
form holding the values, and only the second one is worth anything.

The ethnicity set lands in MISSING on the review-page reconcile, which is correct and non-blocking:
Workday's own summary page does not render the self-identification section at all, so absence there
is not evidence the value was lost (the 2026-07-28 rule).

## 2026-08-04 — a server-backed combobox says "No options" while it is still SEARCHING (Greenhouse `school--0`)

Closes the 2026-07-31 (b) "still unresolved" limitation: Discord's school list answered a hand-typed
query in ~2s but returned nothing to the identical query during a fill. Traced by running the
shipped `atsInjReadOptions` **verbatim in the live page** on a HIDDEN tab, sampling on every DOM
mutation from the instant the query was typed:

| t | options | `loading` | menu text |
|---|---|---|---|
| 4–9ms | 0 | **false** | **"No options"** |
| 23ms | 0 | **true** | "Loading..." |
| 4049–4459ms | 1 | false | the real answer ("Swarthmore College" / "Bowdoin College") |

- **The empty menu is a LIE, and it arrives before the loading state does.** The widget renders a
  definitive "No options" for ~15ms before react-select's async `loadOptions` marks itself busy. So a
  poll that treats "no options" as an answer can be wrong twice: during that window, and for the
  whole 4s that follows.
- **Nothing about this is fixable by tuning a flat budget.** Measured across four fresh queries on
  one form: the search fires at **312–873ms** after typing (a ~300ms debounce, inflated by the hidden
  tab's ~1Hz timer throttle) and renders at **390–4459ms**. The variance is why this looked
  intermittent, and why it "did not reproduce" on some re-tests. `loading` is the only signal that
  separates "no such option" from "not yet".
- **Re-typing is the worst possible recovery.** The fill's retry cleared and re-typed the query,
  which restarts the widget's own debounce and throws away the search already in flight — so the
  second poll started from zero and gave up sooner. The old path could therefore never succeed on
  this widget no matter how long it ran.
- **The unfiltered first page is NOT a superset of the search result.** The list serves 100 rows
  starting "Aalborg University"; the value being searched for is not on it at all (`page=1` is a real
  network fetch, `?term=` is another). So clearing the query to "unfilter" the menu before clicking
  DELETES the option we just matched — the commit then fails `option-not-found`. Read the menu
  first; clear only when the option genuinely is not on screen (which is the case that rule was
  written for — the 2026-08-02 polarity bridge, where the match came from the unfiltered list).
- **Cache note for anyone re-tracing this:** react-select caches by query, so re-testing the SAME
  query answers in ~9ms with no network and looks like a pass. Use a school you have not typed yet.

Verified live on the fixed path, in one sequence on the real widget: type → wait through `loading`
(4.4s) → click the searched option WITHOUT clearing → `.select__single-value` reads "Bowdoin
College". Nothing was submitted.

**Still not proven:** the 2026-08-02 (b) `#country` empty-list observation. That widget is
client-side (244 local options, no `loading` state) so it is a different mechanism, and it has never
reproduced. What HAS changed is that the fill no longer force-toggles and re-types a menu that is
open and still holding its query — i.e. the "two clicks = shut, then type into a closed widget"
shape that entry named as its leading theory is now impossible. Treat it as removed-by-construction,
not as diagnosed.

## 2026-08-05 — multi-ATS end to end on GitLab: numbered options, a pick-one that reads like a places box, and the résumé slot

The session that closed the loop (fill → review → approve → rehearse → `WOULD CLICK SUBMIT`) on
`job-boards.greenhouse.io/gitlab/jobs/…`. Six defects, each caught by a live run and none visible
from the unit suite.

- **⚠ THE RÉSUMÉ WAS ATTACHED TO THE COVER-LETTER SLOT (replay only).** Greenhouse renders the cover
  letter as a **file dropzone**, and the replay treated every `file_upload` field as the résumé. The
  fill never did — its router maps `cover_letter` → skip — so this was invisible until a rehearsal,
  where the operator SAW the same PDF in both slots. No gate can catch it: the strict verify only
  re-checks approved VALUES, and the bundle carries no file for a field the fill skipped. Diagnostic
  that settles it either way: `AP_DEV_ATS_SCAN` stops reporting a file field once it holds a file, so
  **23 fields + no file fields = both slots filled; 24 fields + `cover_letter value:null` = correct**.
- **⚠ NUMBERED OPTIONS DEFEAT EVERY TIER.** GitLab renders `"1. United States of America"` /
  `"2. Canada"` / `"3. Located Elsewhere"`. Against the profile's exact `"United States of America"`:
  exact fails, containment is deliberately off for dropdowns, and fuzzy scores **88.9%** against the
  90 bar — so a REQUIRED field the profile answers perfectly was left for the operator. The
  enumeration is display scaffolding (`atsEnumStrip`), stripped for MATCHING only. It must be stripped
  on **BOTH** sides: a commit stores the option's REAL text, so on a replay the approved value arrives
  carrying the numbering, and stripping only the options makes a field fail to match the very value it
  produced minutes earlier.
- **⚠ "Where are you currently based?" IS NOT ALWAYS A PLACES BOX.** The label recognizer routed it to
  the places-autocomplete path, which typed a city and waited out a suggestion service that never
  answers, reporting "places never loaded" — while the widget itself was a three-option pick-one whose
  own list already held the answer. The live widget now wins over the label's guess (the Workday
  widget-adaptive rule), and the location route's candidates are TIERED: city+state first, then
  country. Note the profile stores ladders as ARRAYS, so `personal_info.country` may itself be a list —
  handing it to the ladder as one candidate threw `s.toLowerCase is not a function` mid-fill.
- **⚠ A SERVER-BACKED LIST SAYS "No options" WHILE IT IS STILL SEARCHING** (full trace: 2026-08-04).
  Latency for the same class of query on ONE session: **390ms, 4.0s, 4.5s, >12s, >20s** — with a direct
  fetch of the same query returning HTTP 200 in 2971ms and no rate limiting. No flat budget can work;
  `loading` is the only honest signal.
- **A menu that has not MOUNTED is not an empty menu.** react-select paints its list a beat after the
  open click, and believing that beat is what mis-routed the pick-one above. But the converse bites
  too: waiting indefinitely for a menu that will never appear cost 20s per field on the replay, where
  Greenhouse's phone-dial composite reads as a plain select. The poll now separates the states —
  LOADING (full ceiling), mounted-but-empty (one confirming read), never-mounted (brief grace) — and
  asks the operator's **quiescence watch** whether the page is still mutating before believing any of
  it. Read latency is a poor proxy for this: it measures the CDP round trip, not the page.
- **A PAGED list cannot prove absence.** 100 of ~3300 schools were read, narrowed to their 20 nearest
  matches, and then rendered as a pick-one `<select>` that did not contain the operator's school —
  while the record claimed the answer "isn't one of this form's options". Narrowing must not launder a
  partial list into a complete one.

**Measured effect of the round on the same form:** fill 166.3s → **35.4s** (6650 → 1540 ms/field),
because fields resolve instead of waiting out ceilings; and the rehearsal went `1 failure` → **0
failures → WOULD CLICK SUBMIT**. `[ATS-TIME]` now prints the MEASURED paint state
(`NOT painting (chrome says hidden)`), so "visible but not painting" is diagnosable in ATS logs too.

## 2026-08-05 (b) — four forms end to end, and an employer page that LINKS (not embeds) its ATS

Breadth round (operator: "any greenhouse, any ashby, any lever form … all work end to end"). Each ran
fill → review → approve → rehearse, and each ended `WOULD CLICK SUBMIT`; nothing was submitted.

| ATS | Company | Fields replayed | Fill |
|---|---|---|---|
| Greenhouse | GitLab (AI Engineer) | 23 | 35.4s |
| Lever | Shield AI (Electrical Engineer I) | 39 | 32.8s |
| Ashby | Notion (AI Applications Engineer) | 19 | 19.4s |
| Greenhouse, employer-hosted | Coinbase (`www.coinbase.com/careers/positions/<id>?gh_jid=<id>`) | 30 | 68.7s |

- **⚠ AN EMPLOYER PAGE MAY LINK ITS ATS RATHER THAN EMBED IT.** The pre-onboard probe (2026-08-02)
  only looked for an embedded FRAME, so Coinbase — its own careers UI with an Apply link to
  `job-boards.greenhouse.io` — matched no ATS host, fell into the WORKDAY onboarding, and halted
  `auth-form-not-rendered` on a page that has no sign-in at all. The probe now also asks
  `atsInjFindApplyLinks` + the ambiguity-refusing `atsPickApplyLink` (the same pair the ATS pipeline
  uses for its own landing hops), and hands the resolved URL to the right pipeline. ⚠ The link must be
  READ from the page — a Greenhouse embed URL cannot be constructed from a `gh_jid` (2026-08-01).
- **Lever's EEO block, two traps in one field set.** `eeo[disabilitySignatureDate]` reached the AI
  free-text path and answered **"As soon as possible"** — an availability answer on a date field, after
  a 19.2s LLM call. And `eeo[race]` renders each option's whole DESCRIPTION inside its label, so the
  read-back is a paragraph while the option vocabulary is the answer alone; persisting the read-back
  put a value in the bundle that no live option could match, and the replay of a verified fill came
  back `stated-value-unmatched`.
- **The one-page ATSs have NO review page**, so Workday's "stopped before the review page" / "on page
  N" wording describes something that does not exist on them. `bundle.ats` (written since 2026-08-02)
  now drives the halt-banner copy.
- Slowest fields per run, now that `[ATS-TIME]` names them: Coinbase `resume 15.2s`,
  `candidate-location 10.6s`; Ashby `ap-ats-combobox-3 12.2s` (the stamped, identity-less location
  combobox). Résumé attach and the location widgets are where the remaining time is — not matching.

## 2026-08-05 (c) — making a HIDDEN tab render, and the two waits that were never about the page

### Three different things get called "visible", and they need different levers

| What is being changed | Lever | What it fixes |
|---|---|---|
| what the page BELIEVES | `document.visibilityState` spoof (the Workday walk's escalation path), `Emulation.setFocusEmulationEnabled` | page logic gated on visibility/focus |
| whether LAYOUT happens | `Emulation.setDeviceMetricsOverride` | 0×0 `getBoundingClientRect` on a hidden tab (2026-08-01) |
| whether FRAMES are produced | **`Page.startScreencast`** (capture), or real tab visibility | anything that must PAINT — e.g. a react-select menu |

The first two were already in the arsenal, which is why the gap survived: worker timers replace TIMERS,
focus emulation changes BELIEF, `setWebLifecycleState` only un-freezes. None makes the compositor draw,
and cdp.js's own note had concluded a pure rAF-pause "only true tab visibility resumes". **A tab UNDER
CAPTURE keeps producing frames**, and the paint probe proves it by measuring native rAF delivery:
`render forcing ON (screencast) — paint: painting (hidden)` on a tab `chrome.tabs` calls hidden.

**⚠ THE CAPTURE RATE IS LOAD-BEARING.** At `everyNthFrame:1` Chrome captures and JPEG-encodes every
frame, and the encoding STARVES the renderer it was meant to free — the same starvation lesson as
polling too hard (2026-07-31). Measured on one form, one field:

| capture | `gender` select |
|---|---|
| every frame | **33452ms, no options rendered at all** |
| ~1 fps (32×24, quality 1) | **72ms, filled exact-normalized** |

Frames must be ACKed (Chrome stops after two un-acked), the stream must be torn down with the attach,
and `chrome.storage.local.forceRenderOff` opts out.

**⚠ FOOTGUN for the Workday side:** `cdpSynthInput()` chooses synthetic-vs-trusted from
`cdpPainting()`. Forcing frames makes a hidden tab report PAINTING, so a Workday run with render
forcing on would switch to TRUSTED input while hidden — ~1.2-1.5s per event, the exact cost the
synthetic path exists to avoid. If render forcing is enabled there, the input-mode decision needs its
own signal (real visibility) rather than the paint probe.

### The résumé attach was never the upload

`resume confirm gave up after 15s — fromInput null rendered null error "not-found:#resume"`.
**Greenhouse REMOVES the `<input type=file>` once its upload completes**, so a poll watching
`input.files[0].name` cannot ever succeed — it ran the full ceiling every time and recorded the attach
`verified:false`, while the résumé sat attached on the form (by hand it is instant). An absent input is
now read as the widget having replaced itself with its attachment row, and the filename rendered on the
page is the confirmation. Waking the page between ticks matters too, since both signals need a
re-render: **15.2s → 0.3s hidden, 0.3s visible.**

### A places box with no places library

Greenhouse's `candidate-location` needs `google.maps.places`, which never loads in this browser — a
HUMAN gets no suggestions either (2026-07-31) — and the fill still paid the full budget proving it:
10.6s. Ask the page whether the library exists before waiting on it. **10.6s → 6.5s.**

### One field, one budget

The option-poll ceiling was per POLL, so a by-name search plus its retry could each spend it: 44.6s on
one widget whose menu never rendered. It is a per-FIELD allowance now, and the AI fallback no longer
re-opens and re-polls a list the deterministic pass just proved unreadable (it paid that ceiling twice
and reached the same `needs_review` either way).

## 2026-08-07 — Greenhouse / Lever / Ashby: five observed-DOM findings

**Greenhouse serves its application form FROM the posting URL.** Lever and Ashby navigate on to
`/apply` and `/application`. That single difference decided which ATS was broken by page overrides
installed on an already-running document: the ones that navigate get a fresh document for free.

**A Greenhouse checkbox group is `input[type=checkbox]` sharing `name="question_<id>[]"`,** with
per-box ids `question_<id>[]_<optionId>` and a `<fieldset id="question_<id>[]">` around them. The
legend carries the question ("How did you hear about this opportunity? (select all that apply) *")
and each box's `<label for>` carries the option ("LinkedIn", "Glassdoor", "Indeed", …). Observed on
Gusto with 12 boxes. Note the fieldset's id EQUALS the inputs' name, so a selector keyed on
`[id*=…]` matches both the fieldset and every box.

**Ashby renders a diversity survey as SELECT ALL THAT APPLY.** Each identity is its own checkbox —
"Person with disability", "Veteran", "Neurodiverse", "Parent", "Refugee or immigrant" — so the label
is an option VALUE, not a question. Observed on Sierra. Consequence: `atsIsEeoLabel` (which knows
dimension NAMES: veteran, disability, race) matches some of these and not others ("Asian" is a value,
not a dimension), so it cannot be the gate for deciding one.

**An Ashby field labelled "Location" can be a COUNTRY box.** ElevenLabs pairs the label with the
description *"Country you're currently residing in"*, and its suggestion service answers country
queries only — "Pittsburgh" returns nothing, while the country returns
`["United States", "American Samoa", "US Virgin Islands"]`. The label alone cannot tell you which
kind of box you have; the live widget can. Third instance of that rule, after GitLab's three-option
pick-one and Discord's already-rendered degree list.

**Ashby's places service knows "Pittsburgh, Pennsylvania" and not "Pittsburgh, PA".** Same profile,
same ATS, two forms an hour apart: the full-state spelling HIT in 2203ms and committed, the
abbreviation returned nothing across a 17.5s budget. Neither spelling is canonical — the profile
stores whichever the operator typed — so the query is the city alone and the state is enforced at the
pick instead (`atsPlacePick`).

## 2026-08-07 (later) — are ATS option menus virtualized? Measured: no

Asked because Workday's picker is, and the ATS path has no scroll accumulator. Each menu was opened
in the live DOM, its `[role=option]` counted, scrolled to the bottom with a dispatched `scroll` event,
and counted again.

| widget | on open | after scrolling to the bottom |
|---|---|---|
| GH `country` (phone dial composite) | **244**, last "Zimbabwe+263" | 244 |
| GH `discipline--0` | **72**, last "Veterinary Medicine" | 72 |
| GH `degree--0` | 10, last "Other" | 10 |
| GH EEO gender / race | 3 / 8 | 3 / 8 |
| Ashby location combobox | **0** | 5 after typing "Pitt" |
| Lever | no combobox at all — 4 native `<select>` | n/a |

Plain react-select renders every filtered option into the menu DOM and CSS-clips it; a windowed menu
(`react-window` / `WindowedMenuList`) would mount only a slice, and none of these does. So a single
`querySelectorAll` over the open menu already reads the whole list, and **no scroll accumulator is
needed on this substrate** — the difference from Workday is real, not an oversight in the port.

⚠ Two consequences worth keeping:
- The long lists are COMPLETE, so treating >= 60 options as "one page" was throwing away options we
  had already read (see progress-log).
- Ashby's location box is genuinely server-backed: empty on open, answers only what you type. It can
  never be enumerated by scrolling, which is why it carries a note in review instead.

**Ashby "Location" can be a COUNTRY box.** ElevenLabs pairs the label with the description
*"Country you're currently residing in"* and its service answers country queries only.

**Chime words its GENDER question "I identify as:"** — no dimension word anywhere in the label, while
the field directly below it reads "I identify my sexual orientation as:". A demographic detector keyed
only on dimension names splits those two apart.

**A removed posting is visible before you look for a form.** Lever serves the title `Not found`;
Greenhouse 302s to the company board index (title `Current openings at <Company>`), dropping the job
id from the URL.

## 2026-08-08 — the 2.5s settle floor: measured, and it stays

`waitAtsFormReady` accepts on three equal non-zero field counts **AND** `Date.now() - start >= 2500`.
That floor is pure waiting on a form that rendered instantly — on the fast Lever forms it is longer
than the fill — so it was worth trying to replace with a real signal. It was instrumented, measured
on live forms, and **the replacement was refuted**. The floor stays. Do not re-run this without
reading the numbers below.

**What was instrumented (all reverted).** An in-flight request counter (`window.__apInflight`,
wrapping `fetch`/`XHR` to count only) installed with the page overrides — the one place that runs
before the document exists and so sees the form's own first requests — plus a 150ms page-side sampler
recording `[t, form-control count, in-flight]` from document start, and a per-tick trace in the settle
loop. The accept rule was left on the floor throughout; the run only observed.

**The forms mount long before the settle loop looks.** Settle-relative traces:

| form | count final at | accepted at |
|---|---|---|
| Ashby / Sierra (35 fields) | 496ms | 3500ms |
| Ashby / Linear (12) | 530ms | 4906ms |
| Ashby / OpenEvidence (13) | ≤1542ms (first read) | 2941ms |
| GH / Discord (25) | 13ms (first read) | 2814ms |

So the floor is typically 2–4.5s of dead time. That is the prize, and it is real.

**Why DOM quiescence cannot claim it.** Ashby/Sierra, from document start:
`159ms c=0 q=0 | 1351ms c=0 q=1 | 2040ms c=60 q=1 | 2110ms c=60 q=0 | 2266ms c=61 q=0`.
At 2040ms the DOM has been still for a while — and a request is still in flight, with one more control
to come. Quiescence would accept a form short of a field. This is the 2026-07-31 failure (Ashby
accepted at 9 of 13 fields) reproduced in miniature.

**Why in-flight cannot claim it either — the refutation.** GH/Discord, from document start:
`280ms c=34 q=0 | 1716ms c=35 q=2 | 1807ms c=36 q=1 | 2250ms c=36 q=0`.
At **280ms the count is stable AND nothing is in flight**, and two more controls arrive **1.4 seconds
later** on requests that had not started yet. `q == 0` means "no request in flight right now", never
"no more requests coming". A stable-count + zero-in-flight rule accepts a form missing two controls.

Sierra adds a second, smaller objection: the count grew at 2266ms while `q` had already been 0 since
2110ms — React renders a tick AFTER the fetch resolves, so even a correct drain needs a settle margin
behind it.

**Conclusion.** There is no observable signal that distinguishes "finished mounting" from "quiet before
the next burst", because the distinguishing event is in the future. The floor is a crude but honest way
of waiting long enough for the next burst to *start*. It is not tuned and it is not clever; it is the
only thing measured that works.

⚠ Two traps found while doing this, both worth keeping:
- **Wrapping `fetch` must bind the receiver.** `_f.apply(this, …)` throws `Illegal invocation` for a
  bare `fetch(url)` from a strict-mode bundle, and that alone stopped an Ashby form from mounting at
  all — `form did not settle within 25000ms (last field count 0)`. Bind to `window`.
- **A comment inside `buildOverrideSrc` cannot contain a backtick.** That function returns a template
  literal, so a backtick in a comment terminates it and cdp.js stops parsing.

**A follow-up that was considered and NOT taken:** measure the floor from DOCUMENT START rather than
from settle start (the page has often already had its 2.5s by the time the loop begins). It is
appealing and would reclaim most of the dead time, but it is strictly less conservative — on a page
whose mounting finishes at 4s the loop could accept at 3s — and nothing measured here justifies that
trade. If it is ever attempted, it needs a slow-form counter-example first, not a fast-form win.

## 2026-08-04 — waystar.wd1: what Workday does NOT persist when you re-enter a saved application

Two tenants (waystar.wd1, radiancetech.wd12) halted on the SAME page with the same error —
`Error-Please check one of the boxes below:The field Please check one of the boxes below: is
required and must have a value` — after the fill had committed the disability self-ID group and
logged the value. The audit could not re-read the group (`audit-unverifiable`), and by Save time
`disabilityStatus ""*`. The standing suspicion was that the self-ID form's own Language dropdown
(`disabilityForm`) re-renders the form and wipes the box. Traced it instead of guessing further.

**Page map (waystar, 6 steps).** The apply flow names its steps, and the disability group lives on
step 5, NOT with the other EEO questions on step 4:

    step 1 My Information        step 4 Voluntary Disclosures
    step 2 My Experience         step 5 Self Identify      <- disabilityStatus, disabilityForm,
    step 3 Application Questions step 6 Review                name, dateSignedOn, employeeId

The progress bar is a `<li>` list and is NOT clickable — you cannot jump to a step; only Save and
Continue advances.

**The finding.** Re-entered the completed (unsubmitted) application through Candidate Home ->
`actionMenuTarget` -> "Continue Application", which restarts at step 1, and read step 4's DOM. The
extension had filled and saved that page minutes earlier and the review page had agreed. On
re-entry:

    ethnicity                 dropdown  "Asian (United States of America)"   PERSISTED
    gender                    dropdown  "Male"                              PERSISTED
    veteranStatus             dropdown  "I AM NOT A VETERAN"                 PERSISTED
    hispanicOrLatino          dropdown  "Select One"                         ** NOT persisted **
    acceptTermsAndAgreements  checkbox  false                                ** NOT persisted **

and Workday demanded both again:

    Error-Please indicate if you are Hispanic or Latino?
    Error-I have read and accept the Terms and Conditions for submitting an application with Waystar

So **Workday does not persist every answer on these pages across a re-entry of the flow** — three
sibling dropdowns on the SAME page came back filled while a fourth dropdown and the checkbox came
back empty. Nothing about the fill explains that; the server simply did not keep them.

**Why this reframes the disability bug.** The wiped field here is a CHECKBOX, and `disabilityStatus`
is a `checkbox_group`. The likelier mechanism is therefore not "the Language dropdown re-renders the
form" but "**Workday re-initialises checkbox-family widgets on the self-ID / voluntary-disclosure
pages to unchecked whenever the page is (re)entered or re-rendered, so the value only holds if it is
set and saved within the same visit**". That fits every observation: the commit read back fine, the
audit hit the group mid-re-init and could not read it (`audit-unverifiable`), and Save saw nothing.
It is also intermittent, because it depends on a re-render landing after the commit.

**Consequence for the walks.** A value being on the form when we set it is not the same claim as
Workday having kept it, so the only reliable check is a fresh read immediately before Save — which is
what the pre-Save re-verify does, now on BOTH walks (2026-08-04). Verified live on this exact field:

    page 5: 1 REQUIRED field(s) were filled but read BLANK now — re-filling before Save & Continue:
      "Please check one of the boxes below:*" (filled "No, I do not have a disability and have not had one in the past")
       ✓ re-filled — the page holds the filled values again.
    ✓ page 5 → advanced.   ✓✓ reached the REVIEW page after 5 page(s)

waystar had halted on that page twice before; it then went fill -> approve -> rehearse ->
AGREE 53 · DISAGREE 0 -> SUBMIT GATE PASSED.

**Not settled.** Whether the re-initialisation is triggered by the Language dropdown specifically, by
any re-render, or purely by page (re)entry. Answering it needs a tab PARKED on step 5, which the
pre-Save re-verify now prevents by healing the page — the trace hit its limit here because advancing
past step 4 by hand requires ticking "I have read and accept the Terms and Conditions", which the bot
must not do on the operator's behalf. Give `AP_DEV_WD_PROBE` a way to reach step 5 itself (it already
does the check-a-box-and-re-read experiment) and the question closes.

## 2026-08-04 (b) — the self-ID checkbox group: Workday REBUILDS it after a verified fill

Correcting the entry above, which blamed the Language dropdown, and correcting two further guesses of
mine along the way. The operator settled the first one by hand: with the box already checked, switching
Language English↔Spanish does NOT uncheck it (the probe agreed — the box stayed checked while every
label turned Spanish). Then: "I saw the fill click it and immediately after uncheck it."

**Measured, four instrumented runs** (`debugInputTrace` for the click log, `skipPreSaveReverify` so the
backstop could not hide the failure):

    run  settle  flat fill  group clicked ≈  in initial scan  fill verify  audit             outcome
    A    2.6s    3.8s       ~6.4s            no               ok           could not re-read HALT
    B    6.1s    10.9s      ~17s             no               ok           matched           review
    C    1.3s    7.8s       ~9.1s            YES              ok           matched           review
    D    2.3s    18.5s      ~20.8s           no               ok           could not re-read HALT

**Timing is not the variable.** D clicked the group ~20.8s after the page arrived and FAILED; B clicked
at ~17s and passed. So this is not "we click it before it is ready", and no settle-before-clicking gate
fixes it. Both of those were my hypotheses; both are wrong.

**We do not double-click it either.** The trusted-input log shows exactly ONE click on the group per run,
then nothing until Save & Continue. The uncheck is not ours.

What the record says on a failing run — the smoking gun, because `currently:` is a LIVE read:

    ⚠ [needs_review] disabilityStatus (checkbox_group) — "Please check one of the boxes below:*"
       → "No, I do not have a disability and have not had one in the past"
       | AUDIT: could not re-read to verify
       | currently: "No, I do not have a disability and have not had one in the past"

So the click LANDED and verified. Then the M40 audit could not read the group at all
(`readCheckboxGroup` → null when the wrapper is gone, `[]` when it holds no boxes), and by Save time the
field read `""`. **Workday rebuilds the widget after we fill it, and it comes back empty.** The operator
watched exactly that: checked, then instantly unchecked. Predictor across all four runs: failure ⟺ "audit
could not re-read" (2/2 failures, 2/2 passes read fine).

**Fix — the same guard the dropdown commit has always had** ("a momentary pick discarded on
render-complete is never reported filled"), which the checkbox group never had: after a verified commit,
re-read on real wall-clock (`delayFull`, since we are waiting on Workday's rebuild); unreadable ⇒
mid-rebuild, wait and judge when it returns; returned empty ⇒ re-fill and keep confirming; bounded, and
judged on a FRESH read, never a re-fill's own read-back. A rebuild that keeps eating the value ends
`needs_review` + `checkbox-group-rebuilt` instead of a false `filled`. Ids are matched by LABEL too — a
rebuild can re-issue them.

**Verified:** 4 consecutive passes with `skipPreSaveReverify` ARMED, i.e. the pre-Save re-verify could not
have masked a failed first fill. Against a pre-fix rate of 2 failures in 4, that is ~6% by chance — good
evidence, not proof; this is a flake and it deserves re-checking whenever page 5 is touched.

**Still open:** what triggers the rebuild. It is asynchronous relative to our fill and to the audit
(2 of 4 runs), which is why the fix confirms persistence rather than trying to schedule around it.

## 2026-08-04 (c) — HIDDEN runs: Workday rejects synthetic text/date on the Self Identify page

Operator's instinct, and it found a bug the visible runs never could: "test it on hidden too". Hidden is
a different actuation path — `cdpSynthInput()` returns true only when the tab is hidden, so a background
fill dispatches page-side synthetic events instead of trusted `Input.*`.

    hidden + SYNTHETIC   2 / 2 FAILED
    hidden + TRUSTED     1 / 1 passed      (chrome.storage.local.forceTrustedInput)
    visible (trusted)    11 / 12 passed

The two hidden failures are identical, and the shape is new:

    page errors (2):
      • Error-NameThe field Name is required and must have a value.
      • Error-DateThe field Date is required and must have a value.
    [FIELD-DIAG] name="Kevin Wang"* · dateSignedOn="08/04/2026"* · disabilityStatus="No, I do not have…"*

**Workday says the fields are empty while the DOM plainly holds the values.** So the synthetic
native-setter write lands in the DOM and the application never registers it. That is the SAME failure
this repo already recorded for the AUTH form ("fields read back OK but the Sign In submit never fired;
the auth app doesn't register native-setter values"), which is why onboarding stays trusted. The Self
Identify page is a second such surface, and `forceTrustedInput` clears it outright.

Two useful side-findings:

* **The checkbox-group fixes hold under synthetic.** `disabilityStatus` committed and kept its value on
  both hidden runs (quiescence gate waited 440ms / 425ms). The group was never the hidden problem.
* **No DOM-based guard can catch this.** The pre-Save re-verify, `requiredBlankOnPage` and the new
  required-unverified/unfilled halts all read the DOM — which agrees with us. Only Workday disagrees.

**Why the existing remediation does not save it.** The ladder already has both a Tier-1 trusted re-fill
and a Tier-0.5 phantom-required nudge, and the 2026-08-02 entry already demoted the nudge below the
trusted re-write for exactly this reason. It still fails here because:

  1. Tier 1 selects fields via `mappedFieldsFromErrors`, which only considers fields present in
     `FIELD_MAP` (`if (!f || !fm[f.fieldName]) continue`). `name` and `dateSignedOn` on this page are
     AI/recognizer-filled and are NOT in FIELD_MAP, so `refill` comes back empty and Tier 1 is skipped.
  2. Tier 0.5 then runs, correctly identifies the phantom ("Workday says Name + Date are empty, but the
     page HOLDS …"), and applies a focus→blur nudge via `cdpEval` — page-side again, i.e. the very kind
     of interaction this surface ignores. `remediation made NO PROGRESS` and the walk halts.

**The fix this points at** (not yet built): the phantom-required remedy should RE-TYPE the value the page
already holds using TRUSTED input, rather than nudging it page-side. It changes no value, needs no
FIELD_MAP entry, and trusted input is the one thing measured to work here. Restoring synthetic afterwards
keeps the hidden-tab speed win for the rest of the page, exactly as Tier 1 already does.

## 2026-08-05 — page 2 is slow because of TRUSTED INPUT, not occlusion (correcting the entry above)

I attributed a 39s page 2 to the occlusion blind spot: window behind another app, so trusted input
stalls on missing frames. Then a run on a tab the new paint probe CONFIRMED was painting took 38.3s.
So occlusion was not the cause.

    hidden  + synthetic    11.1s, 10.9s
    visible + trusted      14s, 39s, 38.3s      (the 38.3s one: probe says "painting (visible)")

Trusted `Input.*` is simply more expensive per event than a page-side synthetic dispatch — it goes
through the browser's whole input pipeline, while synthetic is one Runtime.evaluate. Page 2 is the page
dominated by input events (work experience + education text, dates, a typeahead, websites), so that is
where the difference shows; every other page sits at 6-11s in both modes. The 14s-vs-38s spread tracks
how much SECTION work a run had — the 38.3s run spent 14.5s on `website[0].url` alone, a field the 14s
run never touched.

What the paint probe is actually worth, stated honestly: it measures the right thing and it logs it, so
"visible but not painting" is no longer invisible. But the new case it enables — visible AND not
painting — has not been shown to exist or to matter, and it is NOT what made page 2 slow. It is a
diagnostic win, not the speed win the previous entry implied.

The speed lever the data does point at: if synthetic is ~3x cheaper per event and page 2 is
event-bound, the question is not "when are we not painting" but "why use trusted input on form pages at
all, when synthetic is already proven there and hidden runs finish page 2 in 11s". That is a policy
change, with trusted kept where it is REQUIRED: the auth form, the self-ID page's text/date fields, and
the single irreversible submit click.

## 2026-08-05 — waystar.wd1 Self Identify: Workday's MODEL loses the Date, and four remedies that do not fix it

Observed during a REHEARSAL (replay) on `waystar.wd1`, page 5 ("Self Identify"), reproducibly across
three arrivals in one run. Save & Continue is refused with:

```
Error-Date  The field Date is required and must have a value.
```

…on a `dateSignedOn` composite that plainly holds the value. The `[FIELD-DIAG]` dump is unambiguous —
every layer we can read agrees the value is present:

```
INPUT[dateSectionMonth-input] domValue "8"    reactProps "8"    reactFiber "8"    ariaValueNow "8"    ariaInvalid null
INPUT[dateSectionDay-input]   domValue "5"    reactProps "5"    reactFiber "5"    ariaValueNow "5"    ariaInvalid null
INPUT[dateSectionYear-input]  domValue "2026" reactProps "2026" reactFiber "2026" ariaValueNow "2026" ariaInvalid null
wrapper text: "Date*current value is 8/5/2026 08/05/2026 … Error: The field Date is required and must have a value."
```

So this is **not** the synthetic-input class (React would be empty) and **not** a value that reverted
(the DOM would be empty). Per the diag's own legend: *both set ⇒ Workday's model disagrees with its own
DOM.* The thing holding "unanswered" is Workday's **form model**, server-side of the React tree — and
nothing typed into the page reaches it.

**Four remedies tried, all refuted live:**

1. **Trusted re-write of the field** (`fillDateCompositeCdp`, synthetic forced off). No effect.
2. **focus→blur commit nudge** (`nudgePhantomRequired`). No effect — now failed live 3x total.
3. **Byte-identical re-type is a no-op by construction.** Both of the above re-enter *the value the page
   already shows*: `focusDateSegment` triple-click-SELECTS the segment and typing the same digits leaves
   it identical, so no value transition ever occurs. `forceSegmentTransition` (2026-08-05) now empties
   each segment with a **segment-scoped Backspace** first — never Ctrl+A, which spans the whole composite
   and resets focus to Month — giving a real empty→value transition. Still did not clear the error, but
   it is kept because writing a value over itself cannot re-answer a question even in principle.
4. **Reload + replay from page 1.** Refuted: page 5 reached 3x, phantom fired 2x, both re-entries hit the
   identical error. Removed from the code with a ⛔ marker so it is not re-added.

**What #4 DID establish** (worth keeping, it is the operator's "only refill what didn't latch"): the
return trip is cheap, because the answers that latched are still saved. Page 1 on re-entry:
`15 field(s) — 0 changed, 13 already-correct, 2 not-actuated, 0 FAILED`. So `skipIfCorrect` behaves
exactly as intended; the cost of re-entry is not the problem, the *remedy* is.

**The untried remedy — implement this next (operator's, and the only one not yet refuted).** NOT a
reload: click **Back** one page, confirm Workday's leave-page dialog, verify the previous page, then
**Save & Continue forward** again. The mechanism differs in kind: it makes Workday re-POST the previous
page and re-DERIVE this page's model server-side, rather than restoring the same broken model that a
reload restores. Prerequisite: this repo has never touched Workday's Back control or its confirm dialog,
so **trace both first** (footer/breadcrumb automation-ids, and whether the dialog is a real modal or a
portaled overlay) before writing the handler.

**Attribution note.** Do not reflexively blame phantom state from repeated runs. This form was run twice
before the rehearsal, so stale server state is plausible — but the fill walk SAVED this same page
successfully minutes earlier, and the failure is specific to re-entering a SAVED application, which is
what a replay always does. It is consistent with the already-recorded finding that Workday drops some
self-ID answers on re-entry while sibling dropdowns persist.

## 2026-08-07 — SKILLS ("Type to Add Skills") on cat.wd5: the multi-value typeahead, traced end to end

First full trace of the Skills widget, done by hand in the operator's own signed-in session on the Solar
Turbines draft (`cat.wd5/solarturbines`, page 2 "My Experience", `formField-skills`, label
**"Type to Add Skills"**, OPTIONAL). It had been `skipped: no mapping` since 2026-06-04. Everything below
was observed, and several points refute what the single-value typeahead path would have assumed.

**Structure.** Closed, the wrapper holds `multiSelectContainer[data-uxi-widget-type=multiselect]` →
`multiselectInputContainer` → `div[data-automation-hiddensearch=false]` → `input#skills--skills`
(placeholder "Search") + `promptAriaInstruction` reading **"0 items selected"**.

- **The input GAINS `data-automation-id="searchBox"` only once opened** (and `hiddensearch` flips to
  `true`). So `cdpReadHierState` reports `searchBox.present:false` on a closed widget — the open click is
  a precondition for reading it at all, not just for typing.
- **On open with an empty query the list is "No Items."** There is no browsable catalog, so a start-scrape
  (`makeStartCapture`) and `captureChoiceOptions` both come back empty here — no pre-scrape
  short-circuit, and no option list for the review editor. That is a property of the widget, not a bug.
- The open list is also where the **chip-contamination rule** proves itself again: a page-wide
  `promptOption` read returned "Carnegie Mellon University" and "Electrical and Computer Engineering" —
  the *school* and *field-of-study* chips from the Education section above. `cdpReadHierState`'s
  `selectedItemList` exclusion already removes them.

**It does NOT live-filter — ENTER is the filter trigger** (the US Bank `source` family). Typing "Python"
and waiting 2s left the list on "No Items."; Enter produced the `promptTitle` banner **"Search Results"**.

**Chip anatomy** (the delete affordance, and why a chip embeds an option):
```
li[data-automation-id=menuItem][role=presentation]
  div[data-automation-id=selectedItem][role=option][aria-label="Docker, press delete to clear value."]
    div[data-automation-id=DELETE_charm][role=presentation]      ← the X
    p[data-automation-id=promptOption]  "Docker"                 ← why a chip reads as an option
```
After a commit `promptAriaInstruction` reads **"1 item selected, Docker"** — a clean read-back signal.

### The findings that decide the design

**1. The taxonomy RENAMES, so a plain exact match fills almost nothing.** "Python" is offered ONLY as
`Python (Programming Language)` (plus `Python IDLE`) — there is no bare "Python" row. "Docker" is offered
as BOTH `Docker` and `Docker (Software)`. The trailing parenthetical is a QUALIFIER Workday added, the
same shape `normalize()` already strips off a dial code `(+1)`. Hence `skillBaseName` + a "qualified"
match tier, with a **bare exact winning** so "Docker" never resolves to "Docker (Software)".

**2. The search is SERVER-SIDE FUZZY and answers almost anything — its results are NOT candidates.**
Measured:

| typed | Workday returned |
|---|---|
| `Yosys` | **Yodiz**, GoSystem Tax RS |
| `ODrive` | **Top Drive**, Optical Disk Drives |
| `CubeMars motor drivers` | Motor Drives, Motor Controllers |
| `zzqqxwvj` (gibberish) | z/VM, Xilinx Zynq |

Every one of those came back under a "Search Results" banner, indistinguishable in shape from a real hit.
So containment, Levenshtein and "take the first row" are not weak tiers on this field — they are wrong
answers waiting to be committed onto an application. **Exact/qualified only**, ambiguity-guarded; a skill
Workday does not know stays OFF the form and is named for the human.

**3. Committing ADDS and the list STAYS OPEN.** A synthetic pointer sequence
(`pointerdown→mousedown→pointerup→mouseup→click`) on the leaf committed fine — chip added, **query still
in the box, list still rendered** — so N skills go in on ONE open, with no re-open or re-focus between
them. Note this widget does NOT need trusted input for the commit (unlike the Self Identify page).

**4. ⚠ A ZERO-RESULT query + Enter makes Workday ADD THE TYPED TEXT as a brand-new skill.** This is how a
dirty box becomes a fabricated answer, and it happened during the trace: with "Docker" left in the box a
`ctrl+a` that did not take effect meant the next skill APPENDED, and Enter created the chip
**"DockerCubeMars motor drivers"** — a skill nobody claimed. (Deleted via `DELETE_charm`.) On every other
typeahead a dirty box merely wastes a candidate; here it writes a wrong value. So the clear is a **HARD
GATE** on this field: unverified-empty ⇒ do not press Enter.
It is also the ONLY path by which an off-taxonomy skill can land verbatim — but it is not reachable on
demand, because the fuzzy search nearly always returns *something* (see the gibberish row above).

**5. An already-selected skill DISAPPEARS from its own future results.** With "Docker" committed,
re-searching `Docker` offered only `Docker (Software)` and `Dockerfile`. Two consequences: re-clicking
cannot toggle a chip off (the row is not there), and **a re-fill that does not dedup against the existing
chips will commit a near-duplicate** — the exact reason `missingSkills` compares BASE names in both
directions, so a `Python (Programming Language)` chip covers a profile "Python".

**Tab-blur is the clean exit** (as everywhere else): the query cleared, the list closed, the `searchBox`
automation-id disappeared, and NO stray chip was created.

**Résumé auto-parse did NOT pre-populate anything here.** The widget was empty on arrival, because this
pipeline reaches the form via **Apply Manually**, which skips Workday's résumé-parse step — so the
operator's "check what the parse already populated first" is still the right rule (a human who clicks
Autofill with Resume WILL see chips), but on our path the field starts blank and the dedup guard is what
makes the rule safe rather than an optimisation.

**Left on the page:** one legitimate chip, `Docker` (a real skill of the operator's) — deliberately kept
as a pre-existing-chip fixture for verifying the never-touch rule on the next run.

## 2026-08-07 (b) — SKILLS live: what actually breaks it, VISIBLE vs HIDDEN

Six real runs on the same Solar Turbines draft (`cat.wd5`), fill walk, one operator profile of 24 skills.
The widget works on both surfaces, but only after the OPEN was fixed — and the fix is not the one the
symptom suggested.

**VISIBLE (trusted input) — worked first time.** Added 7 of 24 and the qualified tier fired live:
`C → C (Programming Language)`, `Python → Python (Programming Language)`,
`Java → Java (Programming Language)`, plus exact hits `SystemVerilog`, `Modbus`, `Raspberry Pi`, `Linux`.
`slowest: skills 33s` for the whole field — it dominates page 2 and always will.

**HIDDEN (synthetic input) — failed with a misleading signature.** Three open attempts per skill, each
reporting `{focused:true, ok:true, openedNow:false}`: the input was found and focused, but the searchBox
automation-id never appeared, so ZERO skills were added while seven chips from an earlier run sat there
looking like success. **The same run with `forceTrustedInput` opened and searched normally**
(`cand "C++" → results (1314ms, 7 options, open:true)`), which reads exactly like "this widget needs
trusted events" — the documented pattern for the auth form and the Self Identify page.

**That conclusion was wrong, and an isolation probe is what showed it.** Scoping trusted input to the
field did NOT fix it (verified from the log: "synthetic input ENABLED" appeared twice, so the switch and
restore both ran). What fixed it was the OPENER:

- **Never fire both opener routes in one attempt.** The first cut clicked the input page-side and then
  immediately coordinate-clicked the container; the second click landed before the searchBox mounted, and
  a second click on a multiselect **toggles it shut** — so the poll always found it closed. This is the
  same toggle-shut invariant the unified typeahead filler already documents.
- **Retry, alternating routes, after a settle beat.** The open races Workday's re-render right after the
  preceding field commits — which is why the SLOWER trusted run opened on attempt 1 and the faster
  synthetic run missed every time. With one settle beat and the two routes alternating, a hidden
  *synthetic* run filled the field normally: 13 candidates processed, adding `JavaScript`,
  `Altium Designer`, `Git`, `Docker (Software)`, then `RViz`, `Fusion 360`, `Yosys` on the next run.
- **So do NOT re-add trusted input to this field.** It roughly doubles the field's wall-clock and buys
  nothing; the note in `fillSkillsCdp` says so at the call site.

**The clear is the other flaky primitive, and the reason matters.** `cdpSelectAllDelete` (trusted
Ctrl+A + Delete) is focus-blind, and on THIS widget Ctrl+A does not select the input's text — by hand the
select-all went to the page and the next keystrokes APPENDED. Live it cleared fine for seven skills, then
failed, and the field (first cut) abandoned the rest of the list — losing Git, Docker, VS Code and Vivado,
all of which the taxonomy has. Now: a React-safe native-setter clear (`clearHierInput`) is tried first,
trusted Ctrl+A is the fallback, a failure RETRIES, and only a second consecutive failure ends the field —
a skipped skill is reported as an infra failure, never as "Workday doesn't have it".

**Coverage varies RUN TO RUN, because the result set is a ranked top-7.** `Yosys`, `RViz` and `Fusion 360`
matched on one run and not the previous one. And strictness has a real cost worth stating plainly: a skill
whose only offered row is a differently-named relative (e.g. `Vivado` against rows like `Xilinx Vivado`)
is deliberately left OFF — accepting it would be the containment guess this project bans. Those skills are
named in the record so the human can add them by hand.

**An `autocommit` terminal can fire with NO new chip** (live: `cand "C++" → autocommit, 0 options`, and no
C++ chip afterwards). `awaitListTerminal` reports autocommit whenever the chip SET differs from the
snapshot, which a re-order/re-render also produces. Nothing added, nothing strayed — so it is bucketed as
a failure rather than disappearing from the report.

### ⚠ The coordinate opener can DELETE a chip — aim at the INPUT, never the container

The signal above is what exposed it. `Git` was on the form after one run and **GONE** after the next, in the
very run that logged `cand "C++" → autocommit, 0 options` — our own "the chip set changed" test firing on a
REMOVAL, not an addition.

Cause: the shared `openHier` ladder resolves `[data-automation-id="multiselectInputContainer"]` first and
clicks its **centre**. That is safe on a single-value picker, but this container **grows with every chip**,
so its centre drifts onto a CHIP — and `DELETE_charm` (the X) is a child of the chip. The opener was
deleting skills it had just added.

Fix: the coordinate route now targets the **input's own rect** (`clickHierInputRect`); the input is a
distinct element from the chip list, so the click opens the widget and cannot delete anything. Both routes
are still needed — a run using ONLY the page-side focus+click opened nothing (1 candidate, `needs_review`),
so the reliable open is the trusted coordinate click; it just has to be aimed correctly.

**Converged result (hidden, synthetic):** 11 remaining candidates attempted, `ROS 2` and `Git` added,
**nothing lost**, status `filled` — 15 of the profile's 24 skills on the form. The nine that stay off
(`C++`, `HTML/CSS`, `CAN`, `ODrive`, `CubeMars motor drivers`, `rqt`, `PCB design`, `VS Code`, `Vivado`)
have no exact-or-qualified row in Workday's taxonomy on this tenant, and are named in the record.

## 2026-08-07 (c) — SKILLS: the CONTAINMENT tier, and exactly what Workday offers

Operator decision: accept a containment match for skills so `Vivado` lands. Enabled as the LAST tier in
`matchSkillOption`, and the guards below are not caution for its own sake — every one of them fired on the
very run that verified the feature. **This is a skills-only exception; the rest of the codebase keeps
"containment is a guess".**

What Workday actually returned for the nine skills that had not matched (top rows, one live run):

| typed | Workday's rows | outcome |
|---|---|---|
| `Vivado` | **Xilinx Vivado**, Vivado HLS | **CONTAINMENT → "Xilinx Vivado"** (2 rows contain it → tie broken on Workday's ranking; the alternative is named in the review) |
| `PCB design` | PCB Design … | **matched** |
| `rqt` | Retek, RFQ Responses, ReQlogic, Retesting | **free-text add** — zero real matches, so Workday added `rqt` verbatim |
| `CAN` | CANopen, CANape, Canorus, **Can Openers** | **refused** — and note "Can Openers" IS a whole-word hit for "can". The **lone-token ≥5 chars** gate is the only thing standing between an embedded engineer and a "Can Openers" skill |
| `C++` | C (Programming Language), C NMR, C/AL, C-Arm | refused (no row contains `c++`; committing "C (Programming Language)" would be a different skill) |
| `HTML/CSS` | CSS HTML, XHTML CSS, Cshtml, CSS Framework | refused (the phrase never appears) |
| `ODrive` | Top Drive, Optical Disk Drives, Driveline | refused |
| `CubeMars motor drivers` | Motor Drives, Motor Controllers, Motor Driving | refused |
| `VS Code` | ISM Code, CodeTwo, M-Code, Code V (Software) | refused |

**The three guards:**
1. **WHOLE-WORD, never raw substring.** Boundaries are non-alphanumeric. Plain `includes` would match
   `Git` inside "Di**git**al" and `CAN` inside "**Can**adian" — a marketing skill on an embedded
   engineer's application.
2. **Distinctiveness:** multi-word, or a lone token ≥5 chars (`skillContainmentEligible`). Modelled on the
   employer-match scan's rule. Blocks `CAN`, `C++`, `Git`, `rqt` from widening at all; passes `Vivado`.
3. **Ranking tie-break:** several containing rows → Workday's own first result (the "pick the first" rule
   the exact tier and `clickHierLeaf` already use), with the rejected rows carried into the review so a
   human can switch. Refusing instead is what kept `Vivado` off the form on the previous run.

**Every widened commit is `filled_review` + `skills-containment`**, and the detail spells out
`Vivado → Xilinx Vivado (broader; Workday also offered Vivado HLS)`. `missingSkills` also treats a BROADER
chip as covering the profile name, or the next pass would search `Vivado` again, find the selected row gone
(Workday hides it) and widen onto `Vivado HLS` alongside.

**Result: 18 of 24** — `Altium Designer`, `C (Programming Language)`, `Docker (Software)`, `Fusion 360`,
`Git`, `Java (Programming Language)`, `JavaScript`, `Linux`, `Modbus`, `PCB design`,
`Python (Programming Language)`, `Raspberry Pi`, `ROS 2`, `RViz`, `SystemVerilog`, `Yosys`, `rqt`,
`Xilinx Vivado`. The remaining six are the refusals above, all correct.

## 2026-08-07 (d) — AUTOFILL WITH RESUME: the flow a first application should actually take

Operator's manual finding: the first application on a tenant should click **Autofill with Resume**, not
Apply Manually, because Workday then parses the résumé and pre-populates the form — including the Skills
section with its own suggestions. Traced and implemented the same day.

**The chooser** (after `adventureButton`) offers four options, all by automation-id:
`autofillWithResume` ("Autofill with Resume") · `applyManually` · `useMyLastApplication` (already in
APPLY_REJECT) · `applyWithLinkedIn`.

**The page order changes.** Autofill-with-Resume lands on `/apply/autofillWithResume` — a RÉSUMÉ page
that comes BEFORE My Information:

| step | page | notes |
|---|---|---|
| 1 | résumé upload | `input[type=file][data-automation-id="file-upload-input-ref"]`, gate `file-upload-successful`, footer `pageFooterNextButton` reading **"Continue"** — every id `attachResume` already drives |
| 2 | My Information | the same 14 `formField-*` wrappers as the manual flow |
| 3+ | My Experience, … | unchanged |

**⚠ The résumé page reports ONE bare `formField-` wrapper**, so `isPastAuth` (fieldCount > 0 && no auth
chrome) called it "the form". Onboarding therefore excludes it explicitly and consumes it — upload +
Continue — before any reached-form return. First cut waited only 6s for it to mount, timed out, and the
WALK picked the page up instead: it attached the résumé itself and wrote a junk 1-field bundle page. The
wait is now render-budgeted (15s visible / 30s hidden), and the log shows onboarding owning it:
`résumé page done — Workday parsed it; the next page has 14 field(s)`.

**What the parse actually gives you, and why the fill still refills everything.** Live it filled name,
country, phone type/code/number — and left `addressLine1`, `city`, `countryRegion`, `postalCode` and
`source` EMPTY, and `candidateIsPreviousWorker` unanswered (Workday blocked Save & Continue on it). So the
autofill is a bonus layer, never a substitute: the walk treats the page as a blank form and refills it.
(A caution for anyone reading state by hand: a radio group's `input.value` is `"true"`/`"false"` as an
ATTRIBUTE regardless of selection, and a checkbox's is `"on"` — reading those as state made the parse look
like it had answered both when it had answered neither. Read `.checked`.)

**Skills after the parse — the payoff.** The Skills multiselect arrives pre-populated, and each parsed chip
is annotated: `Computer Hardware (Suggested)`, `Digital Systems (Suggested)`. Counts vary by run (1 on one
posting, **15** on another).

- **The "(Suggested)" suffix is UI provenance, not part of the name.** Workday's own review page prints the
  bare name (operator), so `skillChipName` strips it wherever a chip becomes a recorded, deduped or
  replayed VALUE — otherwise the bundle stores a value the review page never shows and the reconcile
  reports a correctly-filled skill as missing.
- **It has to be stripped on BOTH sides.** The moment the fill recorded bare names, the M40 audit — which
  re-reads the raw chips — flagged a correctly-kept field `skills:audit-mismatch` on a live run.
  `auditActualFromRaw` now cleans chips too (a no-op for every other typeahead).
- Also of note: the review page needs a **"more (+)"** click to reveal the full list, and drops the
  "(Suggested)" annotation. Both expected; neither affects the fill.

**REHEARSE/SUBMIT deliberately does NOT come here.** It applies manually / continues, so the saved skills
survive and Workday does not re-parse the résumé over them — `preferResumeAutofill` is set only by the
FILL run (`AP_RUN_APPLICATION`).


## 2026-08-10 — cat.wd5 self-ID page 6: the OFCCP disability group, verbatim

The page (`.../apply` page 6), flat fields in DOM order, as the scan reads them:

```
disabilityForm  "English"*   (dropdown — options: English, Spanish)
name            "Kevin"*     (text — the signature name)
employeeId      ""           (text, optional)
dateSignedOn    ""*          (date — dateSectionMonth/Day/Year spinbuttons, label "Date")
disabilityStatus ""*         (checkbox_group — label "Please check one of the boxes below:")
```

**The disability options, verbatim** (this is the wording the match ladder has to hit):

```
Yes, I have a disability, or have had one in the past
No, I do not have a disability and have not had one in the past
I do not want to answer
```

Note the profile stores `"No, I do not have a disability"` — SHORTER than the rendered option. Exact
match therefore misses, and containment is refused by policy, so the only thing that lands it is
**POLARITY LEAD** (a bare `"No"`, committed because exactly one option leads with "No"). Any tenant that
splits a polarity into two meanings would have two leading options and must escalate instead.

**⚠ REQUIRED-NESS IS NOT STATIC ON THIS PAGE.** `dateSignedOn` and `disabilityStatus` render **optional**
and become **required the moment `name` holds a value** — `name` precedes both in DOM order, so an
ordinary top-to-bottom fill triggers it every time. The asterisks above are the POST-cascade reading;
the pre-fill scan shows both without one. The errors Workday then returns:

```
Error-Date: The field Date is required and must have a value.
Error-Please check one of the boxes below: The field Please check one of the boxes below: is required and must have a value.
```

The second error's field name carries a trailing colon, which is the same shape as the 2026-08-07
`errorLabelKey` fix; in this run it still logged `UNMATCHED (not in the flat scan…)` during AI-4
remediation, so error-name→field matching on this label is worth re-checking if it resurfaces.

**Render timing (measured 2026-08-10, VISIBLE tab, warm cache, no extension):** TTFB 467ms ·
DOMContentLoaded 793ms · load event 1484ms · posting content on screen **~13s**. cat.wd5 renders nothing
until it renders everything, so a poll that samples early sees a completely empty page (`formFields 0 ·
markers [none]`), not a partial one — do not read that as "the control is missing".

## 2026-08-11 — SEVEN non-Workday ATSs: the generic scanner probe

Read-only recon for the generic-filler design (`docs/generic-filler-plan.md`). One framework-agnostic
scanner probe injected via CDP `Runtime.evaluate` against seven live ATSs. No clicks, no fills, no submits,
no consent controls touched. **Greenhouse and Lever are CONTROLS** — `ats.js` already drives them
correctly, so they measure the generic scanner rather than merely describing it.

**Corpus:** Greenhouse (Anthropic) · Lever (Metabase) · Workable (TetraScience) · Breezy (Victory) ·
SmartRecruiters (ServiceNow) · Teamtailor (UpCloud) · Rippling (×2).
**Four of seven yielded a form.** The three failures were a consent wall, DataDome, and dead postings —
**never a widget.**

### Greenhouse — the phantom mirrors are generically detectable, and `required` lives on the mirror

30 controls scanned where truth is 24. The extra 6 are react-select's hidden validation twins
(`class="remix-css-…-requiredInput"`), one per select. Every one carries **all four** of
`aria-hidden="true"`, `tabindex="-1"`, computed `opacity:0`, `pointer-events:none` — any single signal
catches all six, no react-select knowledge needed. They are also **absent from Chrome's AX tree**.

⚠ **The real control reads `required:false`; the hidden mirror carries `required:true`.** So required-ness
must be recovered from the field UNIT (a `*` in the label/heading, an `[aria-required]`, a
`[class*=required]` marker, or the AX node's flag) — never read off the visible control.

⚠ **Size is not a filter, in both directions.** The real combobox input measures **3px × 20px**; the
`intl-tel-input` search contaminant measures 0×0. `width>0 && height>0` is exactly right and cannot be
raised. Label coverage was perfect: 24/24 (`aria-label` 12, `aria-labelledby` 11, `label[for]` 1).
reCAPTCHA Enterprise anchor iframe present and visible (an anchor is not a challenge).

### Lever — the exclusion rule kills the résumé input, and an error message bleeds into the label

Identity 12/12 from `name`; label coverage 12/12. Two refutations:

- ⚠ The `aria-hidden`/`tabindex=-1`/`opacity:0` exclusion rule **wrongly excluded `resume`**
  (`class="application-file-input invisible"`) — the most important field on the form. **`type=file` must
  be exempt from every visibility and exclusion test.**
- ⚠ `location`'s label read `"Current location ✱No location found. Try entering a different…"` — an inline
  **error message concatenated into the question**. Note the `✱` is mid-string, so an end-anchored `\*$`
  required test fails here.

Custom questions are keyed `cards[<uuid>][field0]` — stable per posting, opaque, label is the only
human-meaningful key. hCaptcha present (2 visible iframes). One button: `Submit application`.

### Workable — a per-render random id, and the option list bleeds into the label

- ⚠ **`id` is not always durable.** The résumé input is `input_files_input_QQUpFBNbEVDkaqRr`, regenerated
  per render — it cannot key a replay. The `isHashed` heuristic in `cdp.js` generalizes to exactly this.
- ⚠ `phone`'s label read `"Phone (Optional)+1United States+1United Kingdom+44Canada+1Ge…"` — the **entire
  country-code option list** swallowed into the question, because the `<label>` wraps the whole composite.
  Together with Lever's error bleed: **label text must be a FILTERED read** that excludes descendant option
  lists, error/help nodes and nested control text — never `textContent` of the wrapper.
- The exclusion rule also removed `city` / `postcode` / `country` (`aria-hidden` + `tabindex=-1`),
  plausibly address-autocomplete backing stores. All three `required:false`, so nothing is blocked — but
  **unresolved** (see the plan's open questions). The telephone-country-code combobox has no `name`/`id` at
  all (the Ashby "label is the only durable key" class). `address` arrived pre-filled from geolocation.

### Breezy — a HONEYPOT, AngularJS, and group labels that are the first option's text

Worst label quality in the corpus: **6/9 named — 3 unnamed, 4 placeholder-only.**

- ⚠ **`hp_7f2b` is a honeypot** (caught by `tabindex=-1`). Filling it is an automated self-report to the
  anti-bot layer. This is what earns the exclusion rule its place — the same rule that wrongly killed
  Lever's résumé.
- ⚠ **A radio group's label must never come from an option's own label.** `race_ethnicity` resolved to
  `"White (not Hispanic or Latino)"` and `gender` to `"Male"` — the first option in each case. **Both are
  REQUIRED**, so the LLM would have been asked a nonsense question and filled a demographic from it.
- **AngularJS** (21 `ng-*` nodes) — a commit regime never tested here; every synthetic-input assumption in
  the codebase was proven against React. Untested, not assumed.
- Repeating sections exist outside Workday: `+ Add Position`, `+ Add Education`.

### The decisive experiment: Chrome's AX tree vs the DOM probe (on Breezy)

Split verdict — **neither source is sufficient alone, and that is the design.**

| | AX tree | DOM probe |
|---|---|---|
| True question text | **wins** — `heading "Race or Ethnicity"` / `"Gender"` / `"Experience Summary"` | loses — returns the first option's label |
| Honeypots / mirrors | **wins** — omitted entirely | loses — must be filtered |
| `required` state | **wins** — exposed on the node | needs unit recovery |
| **Durable identity** | **loses** — only snapshot uids (`uid=1_24`); no `name`/`id` | **wins** — the only source |
| **Hidden-but-real controls** | **loses** — `input[name=cResume]` absent from the tree | **wins** — the only source |

**Both missed** the SMS-consent checkbox (`uid=1_29 checkbox`, no accessible name) and the summary textarea
(`uid=1_41 textbox multiline`, no name). Their questions live in an adjacent `StaticText` and a preceding
heading — hence the two extra rungs in the plan's label ladder.

### The three non-widget blockers

- **SmartRecruiters — DataDome.** The one-click apply page (`/oneclick-ui/company/<co>/publication/<uuid>`)
  returned **zero form controls** behind a `geo.captcha-delivery.com` interstitial. Never solve, never
  bypass ⇒ `needs_operator`. ⚠ It fired on an **automated** browser; the operator's real Chrome may pass —
  "verify in a real profile", not "impossible".
- ⚠ **The apply CTA is not always "apply".** SmartRecruiters' reads **"I'm interested"**, and the form uuid
  is **not derivable** from the JD slug — it must be READ from the page. Same lesson as Greenhouse embeds,
  now on a second vendor: prefer structural href signals over CTA text, and never construct a form URL.
- **Teamtailor — a hard consent wall.** No form exists in the DOM until consent is resolved
  (`body{overflow:clip}`, 2 inputs page-wide, **0 `<form>` tags**). The extension never clicks an
  affirmative consent control ⇒ operator halt.
- **Posting-gone generalizes.** Both Rippling postings redirected to the board index; the expired
  SmartRecruiters posting rendered `"Sorry, this job has expired"` with 0 forms. `atsPostingGone`'s existing
  redirect-to-index signal covers the first case already.

## 2026-08-11 (b) — the generic scan is FREE; options are the only cost. Plus the operator's real queue

Follow-up round, measured in the **operator's own Chrome** (so bot-defenses see a real profile) against
live URLs pulled from the queue at `localhost:3500/app/queue`, plus re-probes of the 08-11 corpus.
Design consequences: `docs/generic-filler-plan.md` §7.

### The generic scan costs 0.2–0.4ms — discovery is not a lag source

`performance.now()`, warm, median of 7 full-scan runs (enumerate → exclude → label ladder → identity →
required):

| form | DOM nodes | fields | scan median |
|---|---|---|---|
| Greenhouse (Anthropic) | 1546 | 24 | **0.4ms** |
| KEF Robotics (Wix) | 610 | 7 | **0.2ms** |
| Breezy (Victory) | 300 | 9 | **0.3ms** |
| Jobvite (locale gate) | 69 | 1 | **0.1ms** |

Flat across a 22× node range. **Treat "the generic scan is slow" as refuted** absent a `[TRACE]`-grade
measurement. `window.getComputedAccessibleNode` is NOT available, so the AX half cannot be priced
page-side — it needs a real `Accessibility.getFullAXTree` call inside the extension.

### Options are the only per-field cost — and two census rules are wrong by default

Greenhouse: **11 react-select comboboxes, ALL with 0 options mounted and `aria-controls: null`.** Neither
the "read them free" path nor Workday's aria-controls-scoped scrape works; each needs open→settle→
scrape→close.

- ⚠ **Mounted `[role=option]` nodes are not evidence a widget is free.** The page had **244** mounted
  option nodes — every one belonging to a single always-mounted `iti-0__country-listbox` (intl-tel-input
  dial codes, `visible:false`), none to any of the 11 comboboxes. **Attribute options to their owning
  listbox before counting.**
- ⚠ **"native `<select>` ⇒ options are free" is FALSE.** KEF Robotics' "Are you a US Citizen?" is a real
  `<select>` whose entire list is `["Choose an option"]`, **unchanged after 4s**. Decide `mustOpen` from
  the list's CONTENTS, never the tag name.

### ⚠ The heading label-rung made labels WORSE where placeholder already worked

Adding "nearest ancestor heading" to the label ladder *above* `placeholder` regressed Breezy: `cName`,
`cEmail`, `cPhoneNumber` and `cAddress` all resolved to the section heading **`"Personal Details"` — one
string for four fields** — where `placeholder` had correctly given "Full Name" / "Email Address" /
"Phone Number" / "Address". The rung is still required for the radio groups (no placeholder to fall back
on), so it stays — but **below `placeholder`, and rejecting any heading claimed by 2+ fields** (that is a
section heading, not a question).

### A JD page is not a form — and the "biggest `<form>`" heuristic lies about it

On the **Dayforce** JD page the only visible controls were **cookie-banner checkboxes plus a language
picker**, sitting inside a genuine `<form>`. A generic scan trusting "the form with the most controls"
would report page chrome as application fields. Gate on `atsLooksLikeApplicationForm` before scanning.

### The apply GATE taxonomy, from the operator's live queue

| gate | tenant | note |
|---|---|---|
| link with readable href | SmartRecruiters ("I'm interested") | CTA text is not "apply" |
| link with **opaque base64 token** | Paylocity | not constructible |
| **button, NO href** | Dayforce | target not derivable at all — must click |
| account/session | Oracle Fusion (`eeho.fa.us2.oraclecloud.com`) | operator was already signed in |
| consent wall | Teamtailor (hard); Dayforce / Paylocity banners | never click an affirmative control |
| bot wall | SmartRecruiters (DataDome) | `needs_operator` |
| **never hydrates** | Phenom (BAE) | body/control count never rises ⇒ `needs_operator`, never "empty form" |
| posting gone | Rippling ×2 · SmartRecruiters · Jobvite · Recruitee | **4 distinct signals** (below) |

**Posting-gone signals so far:** redirect → board index (Rippling) · redirect → vendor homepage
(Recruitee) · `"Sorry, this job has expired"` (SmartRecruiters) · `"The job listing no longer exists."`
(Jobvite). Five search-sourced postings died within days — **the operator's live queue is the better
source of test targets.**

### Queue composition — the case for the generic driver

27 queued jobs / 22 hosts. Supported today: Workday ×3, Lever ×2, Greenhouse ×2 (+2 `grnh.se`).
Unsupported: **Oracle Fusion · UKG/UltiPro · ADP WorkforceNow · Ceridian Dayforce · Paylocity · NEOGOV ·
BAE ×2 · Crown ×2 · Lincoln Electric · Fives · Astrion · Amazon.jobs · ByteDance · KEF Robotics (Wix) ·
Getro · recruitics redirect.** **≈19 of 27 (~70%) cannot be driven at all today.**

### 2026-08-11 (c) — THROUGH the apply gate: real Dayforce and Paylocity forms

Operator authorized clicking Apply on queued jobs. Reached two real enterprise forms; **nothing was ever
submitted**, no account created, no personal data entered.

**Getting through the gate — three lessons:**
- ⚠ **A consent modal silently eats the Apply click.** Dayforce's Apply sits at the same coordinates
  whether or not the Cookie Preferences modal is up; two clicks did nothing and the renderer froze, with no
  error. Dismissing consent (**Reject** — the privacy-preserving, non-affirmative control) made the very
  same click work. A generic driver must resolve consent BEFORE it decides an Apply click failed.
- **A guest-vs-account chooser can sit between Apply and the form.** Dayforce → `/apply?flowSelection=true`
  offering *"Apply without an Account"* / Sign In / Create one. Structurally the same as Workday's
  `autofillWithResume` vs `applyManually` chooser, and **the guest path reaches the form with no auth.**
- **The apply URL is often derivable even when the link/button says otherwise.** Dayforce's Apply is a
  `<button>` with NO href, yet the route is a plain `/jobs/<id>/apply`. Paylocity's Apply href is an opaque
  base64 tracking token, yet it lands on `/Recruiting/Jobs/Apply/<id>` — derivable from
  `/Recruiting/Jobs/Details/<id>`. **Oracle Fusion is the counter-example**: `/job/<id>/apply` 404s, two
  Apply clicks left the DOM byte-identical (653 nodes) while freezing the renderer >30s each time, and no
  form was reached. Derive where you can, but never assume.

**Dayforce (`jobs.dayforcehcm.com`, Legence/CMTA) — Ant Design, semantic ids, duplicate labels**

`/apply/manualApplication?applicationSource=Manual`. `antd` 57 nodes, reCAPTCHA ×2. Scan **0.7ms** on 1003
nodes; labels **100%** (14 `label[for]`, 2 `aria-label`).

- ⚠ **THE FORM GROWS AFTER FIRST PAINT: 16 visible controls at +3s, 37 at +20s** — the Education/Work
  History blocks mount late. A scan taken early silently sees **less than half the form**. This is the
  `awaitFieldSetSettled` rule, and it generalizes: **the generic driver needs a field-set-stability gate
  before scanning, on every tenant.**
- Identity is excellent and *semantic*, with the repeating index IN the id:
  `jobPostingApplication_personalInfo_email`, `..._educationHistory_0_degreeName`,
  `..._workHistory_0_title`. Entry scoping comes free here — unlike Workday's duplicated `formField-*`.
- ⚠ **But the LABEL is not unique: "Country dialing code" ×2, "Country" ×3, "State/Province" ×3, "City" ×3,
  "Start Date" ×2, "End Date" ×2.** Label-hash identity fails on exactly the repeating sections.
- ⚠ Worst case on this form: the two dialing-code selects have **neither a durable id nor a unique label** —
  they are `rc_select_4` / `rc_select_5`, rc-select's **sequential per-render counter**. Identity there
  must come from label + section/ordinal.
- 5 controls correctly excluded, all `ant-select-selection-search` (Ant's internal combobox inputs) — the
  exclusion rule earning its keep on a fourth widget library.
- `mustOpen` 3, `roleOptionsMounted` 0. Required-ness is marked properly (`reqEl` and `reqUnit` agree on all 16).

**Paylocity (`recruiting.paylocity.com`) — 44 fields, and four new failure modes**

`/Recruiting/Jobs/Apply/<id>`. No framework fingerprint matched (custom). Scan median **1.5ms** on 581 nodes.

- ⚠ **REQUIRED-NESS IS ONLY IN THE LABEL TEXT.** `"First Name (required)"`, `"Email Address (required)"`,
  `"Address Line 2(optional)"` — and **`required` / `aria-required` are false on every one of them**. This
  is a THIRD required mechanism after Workday's `<abbr>`/trailing-asterisk and Dayforce's proper attributes.
  Miss it and 10+ required fields read optional, which is the dangerous direction.
- ⚠ …and therefore **the label must be STRIPPED of `(required)` / `(optional)` before it is used as a
  question key**, or it will never match a bucket wording.
- ⚠ **The label read swallows the widget's own VALUE and PLACEHOLDER**: `"CountryUnited States"` (label +
  current value), `"StateSelect a state"` (label + placeholder), and
  `"How did you hear about us?(optional)Advertise…"` (label + the whole radio option list). Third vendor to
  prove the same rule — after Lever's error-text bleed and Workable's dial-code list. **A filtered label
  read is not optional.**
- ⚠ **Labels are mis-assigned across a field unit**: `info.maximumDesiredSalary` resolved to
  `"Desired Salary Type"` — a neighbouring field's label, not its own. Duplicate labels here:
  "Fill out application with my resume", "Desired Salary Type", "City".
- ⚠ **Repeating-entry field ids are opaque signed tokens (JWT-shaped)**, one per entry field — the
  strongest case yet that `id` cannot be a replay key without a durability test. Non-repeating fields use
  clean names (`info.firstName`, `public-site-address-city`).
- **First MULTI-STEP non-Workday form in the corpus** — the primary button is **"Next Step"**, plus
  "Add Work History" / "Add Education" repeating sections. Multi-page is not a Workday-only shape.
- `mustOpen` 9 of 44, `roleOptionsMounted` 0.

**⚠ One real scan-cost outlier, and its cause.** Paylocity's scan measured min 0.8ms / **median 1.5ms** /
**max 399.9ms** across 7 runs. The spike is layout thrash: the scan interleaves `getBoundingClientRect()`
and `getComputedStyle()` per control, forcing a reflow each time, and 44 fields is where it starts to bite.
**Fix direction: batch the reads** — collect all rects, then all styles, then classify. Still ~1.5ms
typical, so this is a tail-latency note, not a refutation of "the scan is free".

### 2026-08-12 — Phenom People, and two vendors whose job identity lives in the QUERY STRING

Third recon round off the operator's queue. Two new blocker classes, no new forms reached.

**Phenom People (`jobs.baesystems.com`) — the JD never hydrates**

Fingerprint is unambiguous: **287 `[data-ph-at-id]` nodes**. Phenom fronts many enterprise ATSs, so the
family matters more than this one employer. But the page never became usable:

- `document.body.innerText.length` stayed at **2001 chars** through a 7s wait, a scroll, and a further 6s —
  only accessibility/AI-usage boilerplate, never the job description.
- **`[data-ph-at-id]` count DROPPED 287 → 124 after scrolling** — the page is de-hydrating/re-rendering, not
  progressively filling in.
- **No Apply CTA ever existed.** The only apply-ish controls were nav chrome ("Applicant Resources",
  "How to Apply", "Check Application Status" — the last two `visible:false`). 0 form controls throughout.
- A sticky **Deny/Allow consent banner survived a coordinate click** on Deny and remained pinned to the
  viewport top.

⚠ **New blocker class: NEVER-HYDRATES.** Distinct from consent-wall (there a form exists once consent is
resolved) and from posting-gone (there the vendor says so). Here the page is live, the posting is real, and
the content simply never arrives. The generic driver needs to recognise it — a body-text/control-count
floor that fails to rise across N settle rounds — and halt `needs_operator` rather than scanning 2001 chars
of boilerplate and reporting an empty form. **Unresolved** whether this is Phenom generally, this tenant,
consent-gating, or automation detection.

Also on that page: an explicit employer notice that **"AI tools are not permitted during interviews"**
(interviews, not applications). Page content, recorded as context rather than as a rule.

**⚠ UltiPro and NEOGOV put the job identity in the QUERY STRING, not the path**

Both were unreachable from the path-only URLs used in the 08-11 round, and this was **my sanitization, not
a dead posting**:
- `recruiting2.ultipro.com/…/OpportunityDetail` without `?opportunityId=…` renders **"Not Found"** plus a
  browser-compatibility notice — which reads exactly like a posting-gone signal and is not one.
- `governmentjobs.com/OnlineApplication/Application/PartialIndex` without its params returns a **completely
  empty document** (0 controls, 0 forms, empty body) — it is a *partial* endpoint meant to be loaded with
  params.

**Consequence for the pipeline:** any canonicalization of a queued job URL **must preserve the query string
for these families**, and a "Not Found"/empty-document reading must not be classified `posting-gone` when
the URL was rewritten. Both are cheap ways to mark a live job dead.

### KEF Robotics (Wix) — the pure long-tail form, and it scans perfectly

Inline on the JD page, no gate, no captcha: 7 fields, **7/7 labelled** (6 `label[for]`, 1 unit walk), 0
exclusions, 0.2ms. Identity mixes human ids (`first-name`, `email`) with **Wix build ids**
(`collection_comp-lpjwscz6`, `fileInputcomp-lpjx9isk`) — the durability-test case again. ⚠ **Only `email`
carries any required signal**, element and unit agreeing on `false` for everything else including the
plainly-required citizenship question: on custom forms required-ness can be **JS-only and entirely absent
from the DOM**, and under-flagging is the dangerous direction.
