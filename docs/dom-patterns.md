# Workday DOM Patterns

Running log of DOM patterns observed on real Workday application pages.
Used to drive field classification in the extension. Each entry is a
dated snapshot of one page — refutations of earlier assumptions are
tracked explicitly so the classifier stays honest about which signals
actually fire in the wild.

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
- Candidate list is policy, not profile: `application_defaults.how_did_you_hear`
  (`[...preferred, fallback "Other"]`), tried in order; `needs_review` if none match.
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
- `preferredCheck` → label **"I have a preferred name"** — a checkbox
  (would map to `personal_info.has_preferred_name`). Currently `skipped (no mapping)`.
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
