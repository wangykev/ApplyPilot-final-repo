# The generic filler — design plan

**Status:** design reference. No code written yet. Recon done 2026-08-11 against seven live ATSs.
**Question it answers:** can ONE filler drive arbitrary application forms, or does every form family need
its own mechanism?

**Answer, measured:** the *decision* layer is already universal and needs no new work. The *discovery*
layer can be made universal, but only as a **JOIN of two sources that each fail alone** — and the join
rules below were each earned from a form that broke a simpler rule. The *actuation* layer is universal
per **widget library**, not per ATS. The *flow* layer is irreducibly per-family, and it is where all the
cost lives.

The corollary that shapes the whole build: across the recon corpus, **the generic driver's main enemy was
not widgets — it was reaching the form at all.** Four of seven targets yielded a form. Three were stopped
by a consent wall, commercial bot detection, and dead postings. Widget handling never once was the reason
a form could not be filled.

---

## 1. What was probed (2026-08-11)

Read-only. A single framework-agnostic scanner probe injected via CDP `Runtime.evaluate`; no clicks, no
fills, no submits, no consent controls touched. Two of the corpus (Greenhouse, Lever) are forms the
shipped `ats.js` already drives correctly, so they serve as **controls with ground truth** — they measure
the generic scanner instead of merely describing it.

| ATS | Form reached | Fields found | Identity source | Label coverage | Framework | Bot defense |
|---|---|---|---|---|---|---|
| **Greenhouse** (Anthropic) — control | yes | 24 real **+ 6 phantom** | 24/24 `id` | **24/24** (`aria-label` 12, `aria-labelledby` 11, `label[for]` 1) | react-select ×11 | reCAPTCHA Enterprise (anchor iframe visible) |
| **Lever** (Metabase) — control | yes | 12 | 12/12 `name` | **12/12** (`label`-wrap 9, unit-walk 3) | Lever custom | hCaptcha (2 iframes, visible) |
| **Workable** (TetraScience) | yes | 10 | 9 attr, 1 label-hash | 10/10, **2 polluted** | Workable custom | none detected |
| **Breezy** (Victory) | yes | 9 | 9/9 `name` | **6/9 — 3 unnamed, 4 placeholder-only, 2 group labels WRONG** | **AngularJS** (21 `ng-*`) | **honeypot field** |
| **SmartRecruiters** (ServiceNow) | **no** | 0 | — | — | — | **DataDome** interstitial |
| **Teamtailor** (UpCloud) | **no** | 0 | — | — | Stimulus | hard consent wall |
| **Rippling** (×2 postings) | **no** | — | — | — | — | both redirect → board index (posting gone) |

Per-tenant DOM detail is in `dom-patterns.md`, entry `2026-08-11 — SEVEN non-Workday ATSs: the generic
scanner probe`.

---

## 2. The four layers, and which are universal

| Layer | Universal? | Where it lives today |
|---|---|---|
| **Decision** — `resolve()`, `matchCandidates`, label ladder, buckets, recognizers, AI tiers, review bundle, submit gates | **Already universal** | `lib.js` + `fill-driver.js`. `ats.js` reuses 16 named helpers and consumes `buildReviewBundle` verbatim; `fill-driver.js` mentions Workday DOM markers 21 times in 8,000 lines. |
| **Discovery** — enumerate fields, name them, key them, decide required-ness | **Universalizable, as a JOIN** (§3) | Hand-written per family today: `cdpPageScan` + three `atsInjScan` branches. |
| **Actuation** — commit a value so the framework believes it | **Universal per widget LIBRARY** | `atsActuateField` already dispatches on `widgetType`, with only 9 `ats === "…"` comparisons in 2,831 lines. |
| **Flow** — pages, login, drafts, apply-CTA chasing, consent, captcha, posting-gone | **Irreducibly per-family** | `ats.js` = 2,831 lines for three ATSs; Workday alone ≈ 20k. Same widgets, ~7× the code. |

**The cost ratio is the whole lesson.** Widgets are cheap and finite. Flow is expensive and unbounded.
A generic filler is therefore a *discovery + actuation* project, and every flow it meets is either
already-shaped-like-`ats.js` (cheap) or Workday-shaped (expensive) — never free.

---

## 3. The scan ladder: DOM ∪ AX, because each fails alone

The decisive experiment was running the DOM probe and Chrome's own accessibility tree against **Breezy**,
the worst-labelled form in the corpus. The verdict was split, and the split *is* the design.

**What the AX tree got right and the DOM probe got wrong:**
- The real question text. Breezy puts questions in `<h3>` headings, not labels. The DOM ladder returned
  the **first option's own label** — `race_ethnicity` came back as `"White (not Hispanic or Latino)"` and
  `gender` as `"Male"`. The AX tree showed `heading "Race or Ethnicity"` / `heading "Gender"` directly
  above the groups. Both fields are REQUIRED, so the DOM answer would have sent a nonsense question to
  the LLM and filled a demographic from it.
- The honeypot. `hp_7f2b` is **absent from the AX tree entirely**.
- `required` is exposed directly on the node.

**What the DOM probe got right and the AX tree got wrong:**
- **Identity.** The AX tree offers only snapshot-scoped uids (`uid=1_24`). It exposes no `name`/`id`.
  The review→replay contract needs a key stable across two separate visits, so **the AX tree can never
  supply `field_id`.**
- **The résumé field.** `input[name=cResume]` is visually hidden, so it is **not in the AX tree at all** —
  AX-only discovery would silently miss the single most important field on the form.

**What BOTH missed:** the SMS-consent checkbox (`uid=1_29 checkbox`, no accessible name) and the
Experience Summary textarea (`uid=1_41 textbox multiline`, no accessible name). Their questions live in an
adjacent `StaticText` and a preceding `heading` respectively.

### The resulting ladder

**Enumerate from the DOM** (it alone sees hidden-but-real controls), then **annotate from the AX tree**,
then apply these rungs. Every rung below exists because a corpus form defeated the version without it.

**Label**, first hit wins — and the rung that fired is recorded on the field:
1. `aria-label`
2. `aria-labelledby` (join the referenced nodes)
3. `label[for=id]`
4. wrapping `<label>`
5. **AX accessible name** (Chrome's AccName, which subsumes 1–4 but also catches vendor quirks)
6. field-unit `<label>` / `<legend>` / `[class*=label]`
7. `placeholder`
8. **nearest preceding `<h1>`–`<h6>` heading, DISAMBIGUATED** ← *the Breezy rung; without it, required EEO groups get an option label as their question*
9. **adjacent `StaticText` sibling** ← *the consent-checkbox rung*
10. none → **`needs_review`, never a guess**

⚠ **Rung ORDER is load-bearing, and the obvious order is wrong (measured 2026-08-11).** The heading rung
was first placed *above* `placeholder`, inside the field-unit walk. On Breezy that made labels **worse**:
`cName` / `cEmail` / `cPhoneNumber` / `cAddress` all resolved to the section heading
**`"Personal Details"` — the same string for four different fields** — where `placeholder` had correctly
given "Full Name", "Email Address", "Phone Number", "Address". So:

- `placeholder` is tried **before** an ancestor heading.
- A heading is accepted only if it is **not already claimed by another field** in the same scan. A heading
  that would label 2+ fields is a SECTION heading, not a question, and must be rejected.
- Prefer the nearest **preceding heading in document order** over the nearest ancestor's first heading,
  and prefer the deepest level (`h3` over `h1`).

The radio-group case still needs the rung (`race_ethnicity` has no placeholder to fall back to), which is
exactly why it stays in the ladder rather than being dropped.

**⚠ Label text must be a FILTERED read, never `textContent` of the wrapper.** Two corpus forms proved
this independently:
- Lever: `"Current location ✱No location found. Try entering a different…"` — an inline **error message**
  concatenated into the question.
- Workable: `"Phone (Optional)+1United States+1United Kingdom+44Canada+1Ge…"` — the **entire country-code
  option list** concatenated into the question.

- Paylocity: `"CountryUnited States"` (label + the widget's **current value**), `"StateSelect a state"`
  (label + **placeholder**), `"How did you hear about us?(optional)Advertise…"` (label + the whole radio
  option list).

Three vendors, same failure. So the read must exclude descendant option lists, error/help nodes,
placeholders, the widget's own rendered value, and any nested control's text.

⚠ **Then STRIP the required marker from the question.** `(required)` / `(optional)` / a trailing `*` are
form chrome, not part of the question. Left in, they are carried into `normalizeLabel` and the label will
never match a stored bucket wording. Extract required-ness from them first (above), then strip.

⚠ **A label can be MIS-ASSIGNED, not merely polluted.** On Paylocity `info.maximumDesiredSalary` resolved
to `"Desired Salary Type"` — a *neighbouring field's* label. A field-unit walk that climbs too far grabs
the wrong sibling's label, and the result looks perfectly plausible. This is why the unit walk records
which rung fired and how many hops it took: a label found 3+ hops up, in a unit holding other controls,
is low-confidence and belongs in review rather than being trusted.

**Identity**, first durable hit wins:
1. `name`
2. `id` — **but only if it passes a durability test.** Workable's résumé input is
   `input_files_input_QQUpFBNbEVDkaqRr`, **regenerated per render**: a second visit produces a different
   id, so it cannot key a replay. `cdp.js` already has an `isHashed` heuristic for exactly this on
   Workday; generalize it and reject ids that look random.
3. a stable `data-*` attribute
4. **the label**, hashed — Ashby already relies on this ("the label is the only durable key"), and
   Workable's telephone-country-code combobox and Lever's `cards[<uuid>][field0]` customs land here too.
5. **label + section/ordinal**, because ⚠ **the label alone is NOT unique on real forms.** Dayforce
   repeats "Country dialing code" ×2, "Country" ×3, "State/Province" ×3, "City" ×3, "Start Date" ×2,
   "End Date" ×2 — the collisions land precisely on repeating sections. Paylocity repeats three more.
6. none → `needs_review`. Never fill a field you cannot re-find.

**The durability test is doing real work.** Ids observed that must be REJECTED as replay keys:
`input_files_input_QQUpFBNbEVDkaqRr` (Workable, per-render random) · `rc_select_4` / `rc_select_5`
(Dayforce, rc-select's **sequential per-render counter** — and these two *also* share the duplicate label
"Country dialing code", so they have neither a durable id nor a unique name) · Paylocity's
repeating-entry ids, which are **opaque JWT-shaped tokens**. Ids that pass: Dayforce's semantic
`jobPostingApplication_educationHistory_0_degreeName` — note it even carries the **repeating index**, so
entry scoping comes free there, unlike Workday's duplicated `formField-*`.

**Required-ness** — over-flag is the safe direction; under-flag hides a blocker. **Four independent
mechanisms observed, and a form may use exactly one of them:**
1. `[required]` / `[aria-required]` on a control in the field unit — Dayforce marks all 16 fields this way.
2. A `*` / `✱` in the label, heading or legend — Workday, Lever, Greenhouse.
3. **`(required)` / `(optional)` as literal text inside the label** — **Paylocity, where it is the ONLY
   signal**: `"First Name (required)"` while `required` and `aria-required` are **false on every field**.
   Miss this and 10+ required fields read optional.
4. A `[class*=required]` marker node, or the AX node's own required flag.

- ⚠ **Never trust `required` on the visible control.** On every Greenhouse react-select, the real
  `select__input` reads `required:false` while its hidden mirror carries `required:true`.
- The asterisk is frequently *not* trailing (Lever's was mid-string, ahead of an error message), so an
  end-anchored `\*$` test is not enough.
- ⚠ **A form may carry NO required signal at all** (KEF Robotics: only `email`, with validation in JS).
  Treat "no required signal anywhere on this form" as a distinct, reported state — not as "nothing is
  required".

---

## 4. The exclusion rule — necessary, dangerous, and never silent

Some controls in the DOM are not fields. Two classes matter, and both are real in the corpus:

- **Validation mirrors.** Every Greenhouse react-select renders a hidden twin. Six of the 30 controls the
  first probe found were these. Left in, each becomes a phantom REQUIRED field that buys its own LLM call
  and its own review row — the exact failure `ats.js` already documents on Gusto ("12 of that form's 21
  review items were this one question"). Worse, writing to a checkbox mirror writes the string that would
  be *submitted*.
- **Honeypots.** Breezy ships `hp_7f2b`. Filling it is an automated self-report to the anti-bot layer.

All six Greenhouse mirrors and the Breezy honeypot are caught by framework-agnostic signals — `aria-hidden="true"`,
`tabindex="-1"`, computed `opacity:0`, `pointer-events:none`. Any *one* of the four would have caught all
six mirrors.

**⚠ But the same rule wrongly excluded real fields, twice:**
- **Lever's résumé input** (`tabindex=-1` + `opacity:0`, class `application-file-input invisible`) — the
  most important field on the form.
- **Workable's `city` / `postcode` / `country`** (`aria-hidden` + `tabindex=-1`), plausibly backing stores
  for the address autocomplete, but not obviously so.

So the rule ships with three non-negotiable conditions:
1. **`type=file` is exempt from every visibility and exclusion test.** File inputs are routinely made
   invisible by design; `ats.js` already carves this out and the corpus confirms it is mandatory.
2. **Excluded controls are REPORTED, not dropped.** The scan returns them with the reason, so an
   over-exclusion is visible to the operator instead of silently shrinking the form. Same discipline as
   the existing "no silent caps" rule in discovery.
3. **Size is never a filter.** Greenhouse's real combobox input measures **3px × 20px**; the
   `intl-tel-input` contaminant measures 0×0. The `width>0 && height>0` threshold is load-bearing and
   cannot be raised — which independently re-confirms the standing "visibility filtering is a DEAD END"
   rule, this time from the opposite direction.

---

## 5. Actuation: a widget-driver registry keyed by fingerprint, not hostname

The corpus shows four distinct commit regimes across seven ATSs, and they do **not** partition by ATS:

| Regime | Seen on | Commit technique |
|---|---|---|
| Native HTML control | Lever `<select>`, all plain inputs | native setter + `input`/`change` |
| **react-select** | Greenhouse, Ashby | open → type → poll options → click option → verify chip |
| Vendor-custom listbox | Workable (`aria-haspopup=listbox`) | `aria-controls`-scoped option scrape (the Workday idiom) |
| **AngularJS `ng-model`** | Breezy | distinct regime — Angular's digest cycle, not React's synthetic state |

react-select spans two ATSs already. So the registry keys on a **DOM fingerprint** (`.select__control`,
`.ant-select`, `.MuiInputBase-root`, `[aria-haspopup=listbox]`, `[ng-model]`, …), not on hostname. A new
ATS built from native inputs plus react-select then needs **zero new actuation code** — only a discovery
descriptor.

This is a refactor, not an invention: `atsActuateField` already dispatches on `widgetType`. The change is
to make the widget-library dimension explicit alongside it.

**⚠ AngularJS is a genuinely new regime and must be verified before it is trusted.** Every current
page-side-synthetic assumption was proven against React. Angular commit is an open question (§8).

---

## 6. Flow: the expensive layer, and the blockers that outrank widgets

Three of seven targets never produced a form. Each is a distinct, first-class blocker:

- **Commercial bot detection.** SmartRecruiters' apply page returned *zero* form controls behind a
  DataDome interstitial (`geo.captcha-delivery.com`). Per the absolute never-solve/never-bypass rule this
  is a `needs_operator` halt, not a puzzle. ⚠ It fired on an **automated** browser; the operator's own
  Chrome, with real history and cookies, may pass — so this is "verify in the operator's browser", not
  "SmartRecruiters is impossible."
- **Consent walls.** Teamtailor renders no form at all until consent is resolved (`body{overflow:clip}`,
  2 inputs page-wide, 0 `<form>` tags). The extension must **never click an affirmative consent control**
  (existing onboarding invariant) — so this is an operator halt with a self-explaining reason.
- **Dead postings.** Both Rippling postings redirected to the board index; the first SmartRecruiters
  posting rendered a button reading `"Sorry, this job has expired"` with zero forms. The existing
  `atsPostingGone` already reads Greenhouse's redirect-to-index and Lever's `Not found` — the pattern
  **generalizes**, and each new family contributes its own signal. Cheap to add, and it stops the
  operator being sent to debug a fill on a job that no longer exists.

**The apply-CTA recognizer needs a vocabulary, not a keyword.** SmartRecruiters' CTA reads
**"I'm interested"** — no "apply" anywhere. And its form URL
(`/oneclick-ui/company/<co>/publication/<uuid>`) is **not derivable** from the JD slug; the uuid must be
READ from the page. That is precisely the lesson `ats.js` already records for Greenhouse embeds, now
confirmed on a second vendor: prefer structural signals (an href on a known apply path) over CTA text,
and never construct a form URL.

**Repeating sections are not Workday-only.** Breezy ships `+ Add Position` and `+ Add Education`. The
reconcile-to-exactly-N machinery and the `*_MAP` shape will eventually be needed outside Workday — worth
knowing before the maps are hard-wired to Workday's containers.

### What the OPERATOR's real queue actually contains (2026-08-11)

The corpus in §1 was assembled from web search. The operator's live queue is a better sample of what the
tool is actually pointed at, and it is dominated by families no one would have picked from search — **27
queued jobs across 22 hosts:**

| Family | Hosts in the queue |
|---|---|
| **Supported today** | Workday ×3 (sonos.wd1, hp.wd5, moog.wd5) · Lever ×2 · Greenhouse ×2 + 2 `grnh.se` short links |
| **Enterprise HCM — unsupported** | Oracle Fusion Recruiting (`eeho.fa.us2.oraclecloud.com`) · UKG/UltiPro (`recruiting2.ultipro.com`) · ADP WorkforceNow · Ceridian Dayforce · Paylocity |
| **Public sector — unsupported** | NEOGOV (`governmentjobs.com`) |
| **Employer-hosted / custom — unsupported** | BAE ×2 · Crown ×2 · Lincoln Electric · Fives · Astrion · Amazon.jobs · ByteDance · KEF Robotics (Wix) · MAC VC board (Getro) · `jsv3.recruitics.com` (a marketing redirect layer) |

**Roughly 19 of 27 (~70%) are ATSs the extension cannot drive at all today.** That is the case for the
generic driver, and it says the long tail is not a rounding error — it is the majority of this queue.

### The apply-GATE taxonomy (what stands between a JD and a form)

Six kinds observed, and the generic driver needs a named halt or handler for each:

| Gate | Seen on | Handling |
|---|---|---|
| Apply is a **link with a readable href** | SmartRecruiters ("I'm interested"), Paylocity (**opaque base64 token**) | READ it; never construct |
| Apply is a **button with NO href** | Dayforce | Must click — the target is not derivable at all |
| Apply needs an **account/session** | Oracle Fusion (operator already signed in) · **SAP SuccessFactors** (Lincoln Electric, Crown) · Astrion | Existing onboarding-style auth story, per family |
| **auth gate visible in the HREF** | Astrion — the Apply anchor points at `/jobs/<id>/login` | Cheapest possible pre-check: detect before clicking, no navigation spent |
| **cross-origin apply hop** | SuccessFactors: employer host → `career2.successfactors.eu` | CDP is fine; anything host-scoped is not. Also breaks job-key origin assumptions |
| **never hydrates** | Phenom (BAE) | Body/control count never rises ⇒ `needs_operator`, never "empty form" |
| **Consent wall** | Teamtailor (hard), Dayforce / Paylocity / SmartRecruiters (banners) | Operator halt — never click an affirmative consent control |
| **Bot-detection wall** | SmartRecruiters (DataDome) | `needs_operator`; never solve, never bypass |
| **Posting gone** | Rippling ×2, SmartRecruiters, Jobvite, Recruitee | Four distinct signals so far (see below) |

### Getting THROUGH the gate — measured by actually doing it (2026-08-11, operator-authorized)

Two real enterprise forms reached; nothing submitted, no account made, no personal data entered.

- ⚠ **A consent modal silently eats the Apply click, with no error.** Dayforce's Apply sits at the same
  coordinates whether or not the Cookie Preferences modal is up. Two clicks did nothing and the renderer
  froze; dismissing consent first (**Reject** — privacy-preserving and non-affirmative, so it satisfies
  both the extension's "never click an affirmative consent control" rule and the safety policy) made the
  identical click work. **Resolve consent before concluding an Apply click failed.**
- **A guest-vs-account chooser can sit between Apply and the form** — Dayforce's
  `/apply?flowSelection=true` offers *"Apply without an Account"*, and that path reaches the form with no
  auth. Structurally the same as Workday's `autofillWithResume` vs `applyManually` chooser, and it needs
  the same explicit handling.
- **The apply URL is often derivable even when the control says otherwise** — Dayforce's Apply is a
  `<button>` with no href yet the route is a plain `/jobs/<id>/apply`; Paylocity's href is an opaque base64
  tracking token yet it lands on `/Recruiting/Jobs/Apply/<id>`, derivable from `/Jobs/Details/<id>`.
  **Oracle Fusion is the counter-example** — `/job/<id>/apply` 404s, and two Apply clicks left the DOM
  byte-identical at 653 nodes while freezing the renderer >30s each time. Derive where you can; never
  assume; always keep the click path.
- ⚠ **On a plain anchor, activate the DOM node — do not click coordinates.** Lincoln Electric's
  "Apply now »" was screenshot-verified at the exact pixel clicked, and was a plain same-origin `https:`
  anchor with no `target`, `onclick`, or `rel` — the coordinate click did nothing **twice**, while
  `a.click()` navigated immediately. This is `robustClick`'s ladder earning its native-`el.click()`
  fallback on a vendor it had never seen, and it means the apply-hop step should try DOM activation
  **first** for anchors, keeping coordinates for real buttons and canvas-like controls.

⚠ **`postingGone` needs to be a first-class, per-family recognizer, not an afterthought.** Five of the
search-sourced postings died within days of being listed, each announcing it differently: a redirect to
the board index (Rippling), a redirect to the vendor homepage (Recruitee), `"Sorry, this job has expired"`
(SmartRecruiters), `"The job listing no longer exists."` (Jobvite). A recon corpus rots fast — which is
also why the operator's live queue is the better source of test targets.

⚠ **A JD page is not a form, and the "biggest `<form>`" heuristic will happily lie about it.** On the
Dayforce JD page the only visible controls were **cookie-banner checkboxes and a language picker**, inside
a real `<form>` tag. A generic scan that trusts "the form with the most controls" reports page chrome as
application fields. `ats.js` already has `atsLooksLikeApplicationForm`; the generic driver must gate on it
before scanning anything.

---

## 7. Speed — the lag model, measured (2026-08-11)

**Read `docs/fill-speed-log.md` first.** Its standing conclusions govern this design, and the biggest one
is counter-intuitive: **the lag was never the DOM or the tenant — it was our own MV3 service-worker
`setTimeout`, overrunning `act.delay` by 3–69×** (a `delay(250)` measured at 17.30s). Round 2 fixed it by
pacing on the page's worker-backed clock: page-1 fill **154.6s → 6.4s**, whole-run **194.5s → 30.4s**.

### What the generic scan actually costs — it is free

Measured page-side with `performance.now()`, warm, median of 7 runs of the full scan (enumerate →
exclude → label ladder → identity → required):

| Form | DOM nodes | fields | **scan median** |
|---|---|---|---|
| Greenhouse (Anthropic) | 1,546 | 24 | **0.4 ms** |
| KEF Robotics (custom Wix) | 610 | 7 | **0.2 ms** |
| Breezy (Victory) | 300 | 9 | **0.3 ms** |
| Jobvite (locale gate) | 69 | 1 | **0.1 ms** |

Sub-millisecond on every form, and flat against DOM size over a 22× node range. Two later forms behind the
apply gate agree: **Dayforce 0.7ms** (1,003 nodes, 37 fields), **Paylocity median 1.5ms** (581 nodes, 44
fields). **Discovery is not a lag source and must not be optimized.** Any future "the generic scan is slow"
claim should be treated as already refuted unless it comes with a `[TRACE]`-grade measurement.

⚠ **One tail-latency caveat, measured.** Paylocity's 7 runs read min 0.8ms / median 1.5ms / **max 399.9ms**.
The spike is **layout thrash**: the scan interleaves `getBoundingClientRect()` and `getComputedStyle()` per
control, forcing a reflow each time, and ~44 fields is where it bites. **Batch the reads** — all rects,
then all styles, then classify. Typical cost is unchanged; this only removes the tail.

### ⚠ The form is not all there when it first paints — settle before scanning

**Dayforce showed 16 visible controls at +3s and 37 at +20s**; the Education and Work History blocks mount
late. A scan taken early silently sees **less than half the form**, and every field it misses is a field
the review bundle never learns about.

This is `awaitFieldSetSettled` — `CLAUDE.md`'s "NEVER scan a Workday page without settling it first" — and
it **generalizes to every tenant**. The generic driver needs a field-set-stability gate (N equal reads of
the control set) before it scans. Note the settle poll is a STABILITY predicate, which round 6 showed
drift makes *safer*, not weaker — so it is the adaptive FAST path, not a starved clock, that is the risk
here.

### The ONLY expensive part is learning a widget's OPTIONS

This is `captureChoiceOptions` generalized, and it is the one real cost: **4.7–21.1s per Workday run**
today, all of it re-opening choice widgets purely so the review editor gets a real picker.

Measured on Greenhouse: **11 react-select comboboxes, every one with zero options mounted and
`aria-controls: null`.** So neither trick available elsewhere works — options are not in the DOM, and
Workday's "scope the scrape to the trigger's own `aria-controls` listbox" resolves to nothing. Learning
those 11 vocabularies means 11 × (open → settle → scrape → close), each step paced.

⚠ **Two census rules, both earned by measurement:**
- **A mounted `[role=option]` set is not evidence the widget is free.** Greenhouse had 244 mounted option
  nodes — *all 244 belonged to one always-mounted `intl-tel-input` dial-code list*, and none to any of the
  11 comboboxes. Attribute options to their owning listbox before counting them.
- **"native `<select>` ⇒ options are free" is FALSE.** KEF Robotics' "Are you a US Citizen?" is a real
  `<select>` holding exactly one option, `"Choose an option"`, still unchanged after 4s. A select whose
  list is only a placeholder is `mustOpen`, same as a combobox. **Decide `mustOpen` from the list's
  CONTENTS, never from the tag name.**

### The design rule that keeps the generic filler fast

**Open a widget only when a FILL decision depends on its options. Never open one merely to populate the
review picker.**

This generalizes the carve-out `CLAUDE.md` already documents for skills ("capture SKIPS skills… review
renders its recorded `"A; B; C"` text instead", page 2 fill 15.6s → 8.0s). It matters more here than on
Workday, because a generic driver knows *less* about each widget and is therefore tempted to open *more*
of them. Concretely:

- A field the profile/bucket answers, on a widget we must match against → open it (the match ladder needs
  the live options; that is a correctness requirement, not a nicety).
- A field left blank, or one whose value we will replay as recorded text → **do not open**. Review shows
  the recorded value, not a picker.
- The vocabulary is already mounted and attributable to that widget → read it free, open nothing.

⚠ **The obvious next lever — caching fixed vocabularies across runs — was built, live-verified at
21.3s → 0.0s, and then REVERTED (`f685b10`, reverted by `235dd9e`) with an empty commit message and no
note in any doc.** Until that reason is recovered it must be treated as a **known-refused approach**, not
a free win. See open questions.

### Pacing: the generic driver's new hazard

`cdpSetPageClock(on)` is **scoped opt-in** — FILL and REPLAY enable it; **onboarding, auth and recon stay
SW-timed**, because *a navigating document's timer does not fire* and the abandon ceiling is itself an SW
timer, so a pace there has no reliable bound (50ms requested, 3.5–5.0s observed).

**⚠ This is sharper for the generic filler than for Workday, and it is the main new lag risk.** A generic
run spends far more of its life navigating: JD → apply-CTA hop → possible interstitial → the form, across
vendors whose CTA may be a button with no href (Dayforce) or an opaque token (Paylocity). Every one of
those hops is the navigation case. So:

- ⚠ **DO NOT arm the page clock on the generic path. This plan proposed it and main REFUTED it**
  (`2a52635`, reverted, no code shipped). Arming it in the two ATS settle loops made things **worse** —
  2 pace overruns became **5, mostly `page-abandoned`** — because the settle runs immediately after a
  NAVIGATE, the state round 3 already flagged as unsafe for *either* clock.
- ⚠ **And the gate this plan proposed — "turn it on once a form is confirmed present" — is the exact gate
  that failed.** The flaw, worth memorising: **a successful `cdpEval` proves the document EXECUTES, not
  that its TIMERS fire.** `Runtime.evaluate` is not timer-driven, so on a freshly navigated document those
  two come apart, and the page arm hangs while the abandonment ceiling (itself an SW timer) fires late.
  A scan succeeding is **not** evidence the page clock is safe.
- **What DOES transfer is the drift, and the fix is BUDGET.** Live hidden Greenhouse: a 450ms pace took
  2987ms (6.6×), a 1000ms pace took 3045ms. `waitAtsFormReady` accepts on three consecutive equal reads,
  so a 6.6× beat pushes acceptance from ~900ms to ~6s and its deliberate 2500ms floor stops being what
  binds. So: **budget-bounded, never attempts-bounded** (round 6: lateness is latency, not lost coverage).
- **Check what there is to pace before porting anything.** `ats.js` has **ZERO SW poll loops**
  (background.js 28, fill-driver.js 28): actuation is page-side synthetic and the fill's own sleeps run in
  the page. Most of the Workday pacing work has nothing to bite on in an ATS-shaped driver.
- **There is no hidden-tab penalty on this path** — refuted with an idle control arm (`871cb09`): per-call
  medians hidden 11203ms / visible 14438ms / **idle 11922ms**, with visible-vs-idle indistinguishable
  (p=0.303). A 46.8s call with no tab open is provider latency and can be nothing else. Do not re-open this.
- Any NEW poll the generic driver adds must be classified **monotone / stability / transient** before it
  ships. Transients cannot be polled on a starved clock; they need a page-side `MutationObserver`. Round 6
  audited all 59 existing loops and found class-transient empty — do not be the one to add the first.
- **Never print a poll count you did not COUNT** — a derived count assumes the clock kept time, which is
  the one thing under test.

## 8. The AI request budget — mirror the DEFERRED batch, not the speculative cache

**The generic driver must adopt the ATS path's deferred-AI ordering** (`1cc377f`, live-verified round 10).
This is the single most important efficiency decision in the design, and it is about **request COUNT, not
wall-clock**.

### The shape

```
fill deterministically TO COMPLETION
  → record every question that could not be answered  (defer — do NOT ask yet)
  → ONE batched call for exactly those questions
  → a SECOND actuation pass commits the answers
```

Live on the cloudflare fixture: **7 calls became 1** — `AI batch: 7 deferred question(s) in ONE call`,
`[LLM] ok in 2257ms`, the only `[LLM]` line of the run, all 7 committing read-back values as
`filled_review · ai-choice`, with field counts identical to the pre-change baseline (15 filled / 8
filled_review / 2 skipped).

### Why the count is what matters

**Key rotation advances only on FAILURE**, so N calls all go through the same key, and a free Gemini key
meters **15 requests/minute**. A 7-question page burned half of one key's minute — which is exactly the
operator's "sometimes I call AI 16 times a minute, the limit is 15". A generic driver is *more* exposed
than the ATS path, because it knows less and will therefore defer more questions per page.

⚠ **Do not grade this on fill time.** In that run the LLM was 2.3s of a 33.8s fill (6.7%) while
`candidate-location` alone was 17.1s. Collapsing 7 calls into 1 is invisible on the clock and always was.

### ⚠ This is the OPPOSITE ORDER to Workday's `aiBatch`, and the two must NOT be unified

| | Workday `aiBatch` (fill-driver ~4180) | ATS deferred batch — **what the generic driver copies** |
|---|---|---|
| When | **Before** the deterministic pass, so they overlap in time | **After** it, once the outcome is known |
| What it is | a speculative **CACHE** — a miss just makes its own call | a **deferred batch** — nothing is asked about an answered field |
| Cost | must **PREDICT** which fields will fall through; every misprediction is a paid request for a question the profile already answered | strictly cheaper |
| Price paid | none | needs a real **second actuation pass** |

The generic driver has no reason to predict — it can afford the second pass — so it takes the deferred
form. Keeping both shapes in the codebase is deliberate; a "unification" refactor would silently
re-introduce prediction.

### Four load-bearing details, each of which is a bug if dropped

- **Cache by QUESTION (`normalizeLabel`), never by field id.** Cascade rounds re-enter the fill loop with
  late-mounted fields; the same wording under a new id reuses the answer already paid for. Beyond cost,
  this makes it **impossible for one page to hold two different answers to the same question** — which
  matters more on the generic path, where §3's identity ladder already admits that ids are often
  non-durable and labels are often duplicated.
- **A deferred combobox is READ then CLOSED — gated on the option COUNT, not `aria-expanded`.** Same
  reason as everywhere else: a menu left mounted swallows the next widget's open-click. The old per-field
  path held a menu open across the entire LLM call; deferring removes that window because nothing is
  committed while the call is in flight.
- **ONE deferred question is not a batch.** It takes the single-question path unchanged — wrapping one
  request in a batch prompt buys nothing and adds a parse that can fail.
- **Places/location widgets are deliberately NOT pre-read.** A places box has no list until something is
  typed, so an empty-query open can only return nothing — and it is the most expensive widget on the path
  (`candidate-location` spans **7.1–20.3s on one posting**). This generalizes directly: Workable's address
  autocomplete and Paylocity's `public-site-address-address-1` are the same widget class.

### Cost, stated honestly

One extra **open + close per deferred combobox** (defer reads the options; the commit pass re-opens because
committing needs a mounted listbox). Radio / yes-no / checkbox-group / native-select options come from the
scan and cost nothing — which is exactly why §7's `mustOpen` census is the number to watch. There is also a
**double option-read on a combobox whose menu never renders**, deliberately not short-circuited: a
transient empty read would otherwise permanently strand a REQUIRED field, and a second chance is the safer
direction on a widget headed for review either way.

### Safety is unchanged, and that is the point

A batched answer enters through the **same seam** a per-field answer did. It is still only a **CANDIDATE
that must clear the match ladder against the LIVE options read at commit time**, still read-back verified,
still **always `filled_review` + flagged**. A batch that fails, parses badly, or omits a question leaves
that field to make its own call — the pre-batch behaviour exactly. **A batch failure costs LATENCY, never
COVERAGE.** Two failure modes already found and fixed upstream, both worth copying:
- the parser **silently dropped an answer that arrived under the OTHER key** (`2fa5a55`) — accept both;
- a successful call that parses to nothing must **dump the reply** (`fe5ee46`), or the evidence for the
  only claim being made does not exist.

### ⚠ And a method rule from this round: a duration is not a code path

The round-10 log first recorded the react-select defer as *not* live-covered, inferring from a 20–29ms
defer cost that those fields were native `<select>`s. Inspecting the DOM refuted it — **0 native selects,
16 comboboxes** — and 20–29ms is simply what four ~1ms CDP evals cost. When the question is *which branch
ran*, read the DOM or add a log line. Never infer a branch from a timing. (This plan's own §7 census makes
the same mistake easy: `mustOpen` must be decided from list CONTENTS, not from tag names or timings.)

## 9. Constraints the design must respect

- **CDP-only.** Universal filling across arbitrary employer hosts via content scripts would need
  `<all_urls>`, which the manifest deliberately refuses. Discovery already reads arbitrary pages through
  CDP. **The CDP substrate is what makes universality permission-free** — no new host permissions.
- **`field_id` must survive two visits.** Fill and submit are separate visits to the same form; the
  identity ladder (§3) exists for this and its durability test is not optional.
- **Engine computes / SW does I/O.** A generic driver returns records; `background.js` persists.
- **The safety contract is unchanged and non-negotiable.** Read-back verify every commit; a verification
  that cannot be made is `needs_review`; every AI fill is flagged; the submit gate keeps its blockers.
  A generic fill that flags a high share of its fields is still a real product — the human review gate is
  what makes low-confidence discovery honest rather than dangerous.
- **What the generic driver must NOT do:** invent an answer for a field it could not name; fill a control
  it cannot re-find; fill anything it excluded; touch consent or captcha; or submit. On an unknown form
  the correct output is a *well-labelled review pile*, not a completed application.

---

## 9b. STATUS — built 2026-08-12 (steps 1–4 of the build order)

Shipped in `ats.js` + `background.js`, with 40 tests in `test/ats-generic.test.js`:

| Piece | Where |
|---|---|
| Injected generic scanner (DOM → raw candidates) | `atsInjScanGeneric` |
| PURE resolver (labels, identity, required, options) | `atsGenericPostProcess` + `atsGenericIdDurable` / `atsGenericCleanLabel` / `atsGenericRequiredFromLabel` / `atsGenericPickLabel` |
| One scan entry point | `atsScanFor` (ats.js) · `cdpAtsScan` (background.js) |
| Review picker for unfilled choice fields | `atsCaptureChoiceOptions` |
| Résumé recognizer (no static map exists) | `atsRouteField`, generic branch |
| Wizard-vs-submit split | `atsInjSubmitState` (`multiStep`) + `atsLooksLikeApplicationForm` |
| Fallback hooks | `runAtsApplicationRun` (3 bail points) + the `AP_RUN_APPLICATION` unrecognized-host branch |

**Kill switch:** `chrome.storage.local.genericFillDisabled = true`.

### ⚠ Three bugs the LIVE run found that the fixtures did not

Running the real scanner against the live Paylocity form (43 fields) caught three things unit tests
had passed. Recorded because each is the same lesson: *a fixture is written from what you already
believe.*

1. **The Breezy group bug came back through a DIFFERENT rung.** Blocking `labelFor`/`labelWrap` for a
   group is not enough — the field UNIT contains the option labels, so `unitLabel` picked the first
   one and `info.howDidYouHearAboutUs` resolved to **"Advertisement-Print"**. A group's label now
   resolves legend → `label[for=<group NAME>]` → a label that wraps ≠1 members.
2. **A question label can WRAP its own options.** `label[for="info.howDidYouHearAboutUs"]` read
   `"How did you hear about us?(optional)Advertisement-PrintCollege-Recruiting Event…"`. Nested
   `label`/`legend` are now stripped by the filtered read — verified against every other control on
   that page: **0 labels changed**, so it only helps the group case.
3. **Two file inputs both matched the résumé.** Paylocity offers `btn-forceResume` *and* `btn-resume`
   as two routes to the same upload; attaching to both would upload twice and can start two
   server-side parses. Exactly one slot is now `primaryResumeSlot`.

### What is NOT verified yet

**A real end-to-end FILL has not been run.** The scanner and resolver are verified against live DOM
(KEF Robotics and Paylocity), and every downstream stage is reused code — but the actuation pass on a
generic form has only been reasoned about, not observed. It needs the worktree loaded as an unpacked
extension; the operator's Chrome runs the main checkout.

Confidence, stated honestly: text / textarea / native-select / radio / checkbox / file all actuate
through injected functions that are already ATS-agnostic (`atsInjSetText`, `atsInjSelectNative`,
`atsInjCheckOption`, `atsInjSetChecked`, `atsInjAttachFile`), so KEF Robotics should fill. An
arbitrary COMBOBOX is the weak spot: the commit path is react-select-shaped, and a vendor widget that
is not react-select will fail its read-back and reach review as `needs_review` — honest, but unfilled.
That is the first thing to measure on a live run, and the widget-driver registry (§5, build step 3) is
the fix.

## 10. Build order

1. **The scan ladder** (§3–§4) as a pure, Node-testable function over a DOM+AX snapshot, with the corpus
   above pinned as fixtures. Each rung gets the regression it was earned from: Greenhouse's 6 mirrors,
   Breezy's 2 wrong group labels + honeypot, Lever's error-bleed and excluded résumé, Workable's random
   id and option-list bleed.
2. **The generic driver, with the DEFERRED-AI ordering built in from the start** (§8) — scan → settle gate
   → deterministic fill to completion → record deferred questions → ONE batched call → second actuation
   pass → the existing bundle. Everything flagged. **Do not ship a per-field-call version first**: the ATS
   path already paid for that mistake, and a generic driver defers *more* questions per page than
   `ats.js` does, so it would hit the 15-req/min key quota sooner. Verify against the two controls first —
   it must reproduce what `ats.js` already gets right on Greenhouse and Lever before it is pointed at
   anything new.
3. **The widget-driver registry** (§5), fingerprint-keyed, extracted from `atsActuateField`.
4. **Flow blockers** (§6) as explicit halts: bot-wall, consent-wall, posting-gone, apply-CTA vocabulary,
   never-hydrates (Phenom), and the guest-vs-account chooser.
5. **Named adapters, cheapest first** — each one now a *refinement* of a working baseline: recon tells you
   the three things the generic scanner got wrong, and you override only those.

Cheapest-first order for step 5, now graded by what the recon actually reached:

| Tier | Families | Why |
|---|---|---|
| **1 — nearly free** | KEF-style custom/Wix forms, **Workable**, **Breezy** | One page, no gate, no login, one submit. All scan clean off the generic ladder today. |
| **2 — one gate each** | **Dayforce**, **Paylocity** | Forms reached and fully scanned. Each needs: consent dismissal, the guest-path chooser (Dayforce), and — for Paylocity — the label-text required parser and multi-step support. |
| **3 — blocked on an operator story, not on fill** | Teamtailor (consent wall), SmartRecruiters (DataDome) | Nothing to build until access is settled. |
| **4 — own recon session** | **Oracle Fusion**, UKG/UltiPro, ADP, NEOGOV, iCIMS/Taleo/SuccessFactors | Workday-shaped: auth + wizard + drafts. Oracle already resisted once. |

**Paylocity is the best single target for step 2 of the build order**, because one form exercises almost
every rule at once: 44 fields, label-only required markers, value/placeholder bleed, mis-assigned labels,
duplicate labels, opaque JWT entry ids, repeating sections, a multi-step wizard, and 9 must-open widgets.
If the generic driver handles Paylocity honestly, the ladder is real.

---

## 11. Open questions — each needs recon, none should be guessed

- **AngularJS commit semantics** (Breezy). Does native-setter + `input` commit through `ng-model`, or is a
  digest needed? Untested; every current synthetic-input assumption was proven against React only.
- **Are Workable's `city`/`postcode`/`country` real fields or autocomplete backing stores?** Determines
  whether the exclusion rule was right or wrong there. All three read `required:false`, so nothing is
  blocked either way — but the answer decides whether the address flow needs a composite handler.
- **Does DataDome pass in the operator's own Chrome?** Decides whether SmartRecruiters is supportable at
  all. Must be tested in a real profile, not an automated one.
- **Does the AX tree stay cheap at scale?** Still unmeasured, and it now has to be measured **inside the
  extension**: `window.getComputedAccessibleNode` is unavailable in Chrome here, so there is no page-side
  AccName proxy — only a real `Accessibility.getFullAXTree` CDP call can answer it. The DOM half of the
  join is settled (0.2–0.4ms, §7); the AX half is the only unpriced piece of discovery.
- **⚠ Why was the option-vocabulary cache reverted?** `f685b10` shipped it (live-verified 21.3s → 0.0s,
  bounded by per-tenant key + 30-day TTL + 12-tenant LRU, and safe because `rec.options` feeds only the
  review picker); `235dd9e` reverted it with an **empty message**, no doc note, and no surviving code.
  This blocks the most obvious lag win in §7, and the design deliberately does not assume it. **Operator
  question — was this a correctness problem, a scope call, or just a clean-branch revert?**
- **Required-ness may be entirely absent on custom forms.** On KEF Robotics only `email` carried any
  required signal — element and field-unit agreed, both `false` — while "Are you a US Citizen?" is
  plainly required in practice and enforced in JS only. Under-flagging is the dangerous direction
  (`CLAUDE.md`), so the generic driver may need to treat "no required signal anywhere on the form" as a
  distinct, reported state rather than "nothing is required".
- **Multi-step wizards — no longer hypothetical, still untested.** Paylocity's primary control is
  **"Next Step"**, so multi-page is not a Workday-only shape. The generic driver's page-transition model
  remains unexercised, and Workday's history says that is where the cost hides. This is now the largest
  unknown in the plan.
- **Oracle Fusion resisted every approach tried.** Apply URL 404s, and two Apply clicks changed nothing
  while freezing the renderer >30s. Unresolved whether it needs a different control, a popup that was
  blocked, or a session state we did not have. Given Oracle's install base this deserves its own recon
  session rather than a guess.
