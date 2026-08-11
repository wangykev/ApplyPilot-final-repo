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
7. **nearest preceding `<h1>`–`<h6>` heading** ← *the Breezy rung; without it, required EEO groups get an option label as their question*
8. **adjacent `StaticText` sibling** ← *the consent-checkbox rung*
9. `placeholder`
10. none → **`needs_review`, never a guess**

**⚠ Label text must be a FILTERED read, never `textContent` of the wrapper.** Two corpus forms proved
this independently:
- Lever: `"Current location ✱No location found. Try entering a different…"` — an inline **error message**
  concatenated into the question.
- Workable: `"Phone (Optional)+1United States+1United Kingdom+44Canada+1Ge…"` — the **entire country-code
  option list** concatenated into the question.

Both strings would have been handed to the LLM as the question to answer. So the read must exclude
descendant option lists, error/help nodes, and any nested control's own text.

**Identity**, first durable hit wins:
1. `name`
2. `id` — **but only if it passes a durability test.** Workable's résumé input is
   `input_files_input_QQUpFBNbEVDkaqRr`, **regenerated per render**: a second visit produces a different
   id, so it cannot key a replay. `cdp.js` already has an `isHashed` heuristic for exactly this on
   Workday; generalize it and reject ids that look random.
3. a stable `data-*` attribute
4. **the label**, hashed — Ashby already relies on this ("the label is the only durable key"), and
   Workable's telephone-country-code combobox and Lever's `cards[<uuid>][field0]` customs land here too.
5. none → `needs_review`. Never fill a field you cannot re-find.

**Required-ness** — over-flag is the safe direction; under-flag hides a blocker:
- ⚠ **Never trust `required` on the visible control.** On every Greenhouse react-select, the real
  `select__input` reads `required:false` while its hidden mirror carries `required:true`. Recover from
  the field unit: any `[required]`/`[aria-required]` inside it, a `*`/`✱` in the label or heading, a
  `[class*=required]` marker, or the AX node's own required flag.
- Note the asterisk is frequently *not* trailing (Lever's was mid-string, ahead of the error text), so an
  end-anchored `\*$` test is not enough.

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

---

## 7. Constraints the design must respect

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

## 8. Build order

1. **The scan ladder** (§3–§4) as a pure, Node-testable function over a DOM+AX snapshot, with the corpus
   above pinned as fixtures. Each rung gets the regression it was earned from: Greenhouse's 6 mirrors,
   Breezy's 2 wrong group labels + honeypot, Lever's error-bleed and excluded résumé, Workable's random
   id and option-list bleed.
2. **The generic driver** — scan → the existing brain → the existing bundle. Everything flagged. Verify
   against the two controls first: it must reproduce what `ats.js` already gets right on Greenhouse and
   Lever before it is pointed at anything new.
3. **The widget-driver registry** (§5), fingerprint-keyed, extracted from `atsActuateField`.
4. **Flow blockers** (§6) as explicit halts: bot-wall, consent-wall, posting-gone, apply-CTA vocabulary.
5. **Named adapters, cheapest first** — each one now a *refinement* of a working baseline: recon tells you
   the three things the generic scanner got wrong, and you override only those.

Cheapest-first order for step 5, from the corpus: **Workable** and **Breezy** are `ats.js`-shaped
(one page, no login, one submit button) and mostly work off the generic ladder already. Teamtailor and
SmartRecruiters are gated by §6 blockers, not by fill difficulty, so they wait on an operator story.
iCIMS / Taleo / SuccessFactors are Workday-shaped and belong in a separate, later, depth-first effort.

---

## 9. Open questions — each needs recon, none should be guessed

- **AngularJS commit semantics** (Breezy). Does native-setter + `input` commit through `ng-model`, or is a
  digest needed? Untested; every current synthetic-input assumption was proven against React only.
- **Are Workable's `city`/`postcode`/`country` real fields or autocomplete backing stores?** Determines
  whether the exclusion rule was right or wrong there. All three read `required:false`, so nothing is
  blocked either way — but the answer decides whether the address flow needs a composite handler.
- **Does DataDome pass in the operator's own Chrome?** Decides whether SmartRecruiters is supportable at
  all. Must be tested in a real profile, not an automated one.
- **Does the AX tree stay cheap at scale?** `getFullAXTree` on a large form is unmeasured. Given the
  standing rule that a slow page is the LLM until proven otherwise, this needs its own measurement before
  it is blamed or exonerated.
- **Multi-step wizards.** None of the four reachable forms was multi-page. The generic driver's page-
  transition model is therefore **completely untested** — and Workday's history says that is where the
  cost hides.
