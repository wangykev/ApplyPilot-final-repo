# Adding support for a new ATS / job-application platform

**What this is.** A playbook, distilled from building the Workday, Greenhouse/Lever/Ashby and iCIMS
fillers. Every rule below was paid for by a live failure — usually one that produced a *confidently
wrong* answer rather than an obvious crash, which is the failure class this pipeline exists to
prevent. Read it before writing a line of code for a new platform.

**Companion reading**, in this order:
1. `CLAUDE.md` — the standing invariants. Non-negotiable; this doc never overrides it.
2. `ats-tenants` skill — the dev loop for the non-Workday path, and the debugging rules.
3. `docs/dom-patterns.md` — the observed-DOM rulebook (topic index at the top; never read it whole).
4. `live-testing` skill — how to drive a real run and how to read the logs without fooling yourself.

---

## 0. The shape you are building

A filler is **not** "code that types values into a form". It is a pipeline stage with a contract:

```
     FILL visit                          human                     SUBMIT visit
  ┌──────────────┐                  ┌────────────┐            ┌───────────────────┐
  │ scan the page│                  │ review     │            │ re-fill from the  │
  │ route fields │ ──► reviewSummary│ editor on  │ ──► approved│ APPROVED bundle   │
  │ actuate      │     bundle       │ the website│    bundle   │ strict verify     │
  │ read-back    │                  │ approve /  │            │ gated submit click│
  │ audit        │                  │ edit       │            └───────────────────┘
  └──────────────┘                  └────────────┘
```

Two properties make the whole thing work, and a new filler inherits both for free **only if it
produces records in the existing schema**:

- **The review bundle is the same schema on every platform.** `buildReviewBundle` (fill-driver.js)
  consumes ATS records verbatim, so the website's review editor needs zero platform-specific code.
  Deviating here means building a second review UI — don't.
- **Every commit is read-back verified, and a verification that cannot be made is `needs_review`.**
  Never a silent pass, never a wrong value. This is the one rule that has never been relaxed.

### Which substrate does the new platform need?

There are two, and picking wrong costs a rewrite.

| | **Page-side synthetic** (`ats.js`) | **CDP `Input.*` off-loop** (`cdp.js` + `fill-driver.js`) |
|---|---|---|
| How | `Runtime.evaluate` runs a JS fn in the page; it dispatches synthetic events | Real `Input.dispatchKeyEvent` / `dispatchMouseEvent` from the service worker |
| Cost | Cheap, fast, identical visible/hidden | Slow, needs pacing, focus emulation, throttle handling |
| Use when | The form **commits state from synthetic events** | It doesn't |
| Proven on | Greenhouse, Lever, Ashby, iCIMS | Workday |

**How to decide — measure, don't assume.** Write one value into one field with a native setter +
`input`/`change` events, then read it back after a beat, then check it survives a *save or a
navigation*. Workday needed the trusted path because fields read back fine and then **reverted on
submit** — the read-back alone did not catch it. If in doubt, test the one field most likely to be
React-controlled (a dropdown, not a text box), and test a *hidden* tab too.

**Default to page-side synthetic.** It is dramatically simpler and it has been right 4 platforms out
of 5. Escalate only on evidence.

---

## 1. Recon FIRST — before any handler exists

This is the most-repeated lesson in the whole project and it has never once been wrong:

> **Trace the real DOM before writing a handler. Every hard bug only cracked after blind guesses
> failed and we instrumented a read-only trace of the *actual* DOM, then built from what it showed.**

Concretely, for a new platform, answer these **in writing** (an entry in `docs/dom-patterns.md`)
before touching `ats.js`:

### 1.1 Structural questions

- [ ] **Host shape.** One host, per-customer subdomains, or employer-hosted (no ATS host at all)?
      Determines whether `detectAts` can be an allowlist, needs an anchored suffix test, or needs
      page-evidence detection (`atsPortalAts`).
- [ ] **Is the form in an iframe?** iCIMS' entire application is inside
      `<iframe id="icims_content_iframe">` and the top document has **zero** controls. If yes, you
      need `cdpUseFormFrame` — and read §5.3, because that pin has bitten twice.
- [ ] **One page or many?** One page ⇒ two visits to a blank form (the ATS model). Many pages with a
      server-held draft ⇒ the Workday walk model (much more machinery: transitions, halts,
      accumulation).
- [ ] **Login required?** Before the form, inside the form (iCIMS creates the account *as part of
      submitting*), or never?
- [ ] **Does a draft persist server-side?** If yes, a submit run *resumes*; if no, it *re-fills*.
- [ ] **React/controlled, or server-rendered?** Check for fiber keys on inputs (`__reactProps$…`).
      iCIMS is jQuery — plain native-setter writes are enough, no re-sync needed.
- [ ] **What is the submit control?** iCIMS' is `<input type="submit">`, and the generic finder queried
      only `button`s and matched `textContent`, which an `<input>` lacks — so `hasSubmit:false` and the
      form was REFUSED. Check the tag, not just the label.
- [ ] **Captcha?** Where — the sign-in gate, the form, both? Invisible or visible? See §5.4.

### 1.2 Per-field questions

For every field on a real posting, record:

- [ ] **The stable identity.** `id`? `name`? A platform id (`PersonProfileFields.AddressCity`) vs a
      per-customer question id (`rcf3271`)? **Only map PLATFORM ids** — a per-customer id means the
      same key holds a different question at the next employer, and mapping it files your home address
      under a past job.
- [ ] **The widget type**, and whether it *lies*. See §5.1 — `<select>` elements that are not selects
      are the single most expensive trap found so far.
- [ ] **The required marker**, all of the ways it is expressed. Detect *all* of them.
      **Over-flagging is safe; a required field reading `false` is the dangerous direction** — it hides
      an unfilled required field that will silently block advancement.
- [ ] **Repeating sections.** How is an entry delimited? Do field ids duplicate across entries? Is the
      ordinal a *position* or an opaque server id? (Both, on iCIMS — see §5.6.)
- [ ] **Declared dependencies.** Does a parent field declare its child in the DOM
      (`data-ddd-child-link`)? Report it rather than guessing — and make the child's failure message
      say *"awaiting parent"*, not *"no options"*. The generic message sent a whole debugging round to
      the wrong subsystem.

### 1.3 The recon tooling

Use a **read-only** trace. Do not actuate during recon. The existing harnesses:

- `AP_DEV_*` recon messages (`cdp-recon`, `cdp-questions-recon`, `cdp-tree-recon`) for Workday shapes.
- For a new ATS: write a throwaway injected fn and call it through the dev bridge, or drive Chrome
  directly (`claude-in-chrome`) and read the page. Print **counts and the raw attribute names**, not
  your interpretation of them.
- Log the **uninterpreted** truth. `[ATS-OPTIONS]` prints scan-time coverage *before anything
  actuates* precisely because that is the only uncontaminated moment.

---

## 2. Where the code goes — the integration surface

For a platform that fits the ATS model, everything lives in `ats.js` + a handful of `background.js`
call sites. Here is the complete surface, in dependency order. iCIMS touches **8 sites in `ats.js` and
11 in `background.js`** — that count is the realistic budget for a platform with quirks.

### 2.1 `ats.js` — detection and routing

| Step | Function | What to add | Trap |
|---|---|---|---|
| 1 | `detectAts(url)` | host → your platform key | **Anchor the regex** (`/(^\|\.)icims\.com$/`) so `icims.com.evil.com` and `fakeicims.com` return null. Pinned by `test/ats.test.js`. |
| 2 | `atsFormUrl(ats, url)` | posting URL → form URL, **idempotent** | **Does the query string matter?** iCIMS' `?eem=…&code=…` is a one-time magic-link session — strip it and you land on a 0-field sign-in page. Greenhouse's `gh_jid` is cruft. Decide deliberately. |
| 3 | `atsCompanyFromUrl(url)` | where the company name lives | This string anchors the **safety-critical** employment recognizer. Path segment 0 is the literal `jobs` on iCIMS — that would hand the recognizer a word no employer is called, and every "have you worked for us before?" silently misreads. |
| 4 | `ATS_STATIC_MAPS[<ats>]` | platform id → profile path | **Platform ids only** (see §1.2). |
| 5 | `atsMapKey(ats, fieldName)` | id normalization before the map lookup | iCIMS strips a leading `<digits>_` ordinal. Keep it per-ATS — a global strip would corrupt other platforms' ids. |
| 6 | `atsInjScan(ats)` | **the injected scan** — a branch returning `{fields:[…]}` | The biggest piece. See §3. |
| 7 | `atsInjSubmitState(ats)` | how to find the submit control | Tag *and* text. See §1.1. |
| 8 | `atsInjErrors(ats)` | how the form reports validation errors | |
| 9 | `atsEntrySpec` / `atsAssignEntryIndexes` | repeating-section shape | See §5.6. |
| 10 | `atsActuateField` | a branch per **new** widget type only | Reuse `select`/`text`/`radio` etc. wherever the platform's widget behaves like one. |

### 2.2 `background.js` — the run wiring

| Site | What | Note |
|---|---|---|
| `runAtsApplicationRun` | page overrides, pacing, navigation, pre-form stage | **Install overrides BEFORE the document exists** — see §5.5. |
| `waitAtsFormReady` | arm the frame pin (if iframed), poll for the form | |
| `runAtsSubmitRun` | the gated submit path | Must re-read credentials and re-grow entries from the **bundle**, not the profile. See §5.7. |
| `makeAtsActuation` | the actuation interface handed to the driver | Usually unchanged. |
| a pre-form stage (optional) | e.g. `runIcimsPreForm` | Only if there is a login/gate before the form. Carries `runCdpOnboard`'s invariants verbatim. |

### 2.3 The `atsLib` / `apMatch` trap — read this or the extension dies

Two hand-written literals shim pure helpers into the service worker, because `importScripts` evaluates
every file into **one** global scope:

- `atsLib` (top of `ats.js`) — under Node it is `require("./lib.js")`; in the SW it is an **explicit
  object literal**.
- `apMatch` (in `fill-driver.js`) — same deal.

So `atsLib.foo(...)` can pass **every** test and throw `atsLib.foo is not a function` in the browser.
**Adding a lib.js helper that either engine uses means updating BOTH: lib.js's `module.exports` AND the
SW literal.** And never re-declare a top-level name across two files — that is a `SyntaxError` and the
worker **fails to register at all** ("Status code: 15", i.e. a completely dead extension), while all
Node tests stay green.

`test/sw-globals.test.js` guards this. It has already caught a real omission before a live run did.
**Run it.**

---

## 3. The injected scan — what a field record must carry

`atsInjScan(ats)` returns `{ats, url, title, fields:[…]}`. Each field:

```js
{
  fieldName,    // the stable identity (id / name / platform id)
  inputSel,     // a CSS selector that re-resolves the element FRESH every time
  widgetType,   // the scan vocabulary — see ATS_CHOICE_WIDGETS / ATS_REVIEW_WIDGET
  label,        // the question as a human reads it, required marker stripped
  isRequired,   // over-flag rather than under-flag
  value,        // what the field ALREADY holds (null if empty)
  options,      // for choice widgets: the live option texts
  domIndex,     // assigned by push() — REVIEW ORDER = FORM ORDER
  // repeating sections only:
  entrySection, entryIndex, repeatIndex,
}
```

**Rules the scan must obey:**

- **It is injected — it cannot reference module scope.** Any regex or constant it needs is inlined, and
  any such duplication is a LOCKSTEP dup that needs a test pinning the two copies together.
  `atsInjScan` and `atsInjReadValue` are the canonical pair: both now *document the old shape in
  prose*, so a naive grep matches the explanation — the pinning test strips comments first.
- **Never push a field twice.** Greenhouse's loop skipped only `hidden`, so every checkbox in a group
  was pushed twice: once as a phantom *required* `text` field keyed on the box's own id, and again as
  the real `checkbox_group`. On Gusto's 12-box question that meant 12 phantom required fields, each
  buying its own LLM call, each answered "N/A" with no basis — **12 of that form's 21 review items were
  one question**. Worse: writing text into a checkbox sets `.value`, which is the string that would be
  *submitted*.
- **Visible-only, but know the exceptions.** File inputs are usually styled invisible — add them
  explicitly. Lever's radio NodeList contains **template rows** (a JSON blob or bare uuid as value)
  before the real options.
- **Index 0 is NOT "unselected".** A `<select>` need not have a placeholder. iCIMS' salary Currency
  starts straight at `"USD $"`, so `selectedIndex > 0` read a legitimately-chosen first option as blank
  — and a rehearsal reported `native select commit failed` on two fields whose values were on the form
  the whole time. **A false negative on a verify gate blocks a submit that should pass.** "Unselected"
  is: nothing selected, **or** the selected row is a placeholder.
- **A scan is a convenience list, not an inventory.** Do not treat "the scan didn't see it" as "it
  isn't there". An approved field absent from the live page is **reported but never fatal** — that was
  wrong twice, live.

---

## 4. Registering a new widget type — FIVE places, and a miss fails silently and differently each time

This is the checklist CLAUDE.md calls out as "four places"; `atsInjReadValue` is the fifth and it was
found the hard way.

1. **`ATS_CHOICE_WIDGETS`** (ats.js) — the single source of truth for "is this a choice widget". Feeds
   the `isChoice` test that drives `resolve()`. **Miss it and a TIERED profile array is coerced as free
   text**, so the fallback tier that matches the form's wording is never tried.
2. **`ATS_REVIEW_WIDGET`** — scan vocabulary → the review schema's vocabulary. Miss it and review
   renders your picker as a text box. `ATS_CHOICE_REVIEW_WIDGETS` is **derived** from these two, so a
   new widget cannot be missed there.
3. **`atsAiBatchKind(f)`** — which AI route (choice vs text) the field belongs to.
4. **`atsAiFallback`** — the option-read switch **and** the commit switch (two switches, one function).
5. **`atsInjReadValue(ats, inputSel, widgetType)`** — the post-fill audit's independent read. Miss it
   and the audit flags **every** one of these as `audit-mismatch` on a correct fill.

Plus, if the widget needs its own actuation: a branch in **`atsActuateField`**.

⚠ **A result's `widgetType` is rewritten to the REVIEW vocabulary as the record is built.** Anything
inspecting a *result* must match `ATS_CHOICE_REVIEW_WIDGETS`, not `ATS_CHOICE_WIDGETS`. Checking the
scan vocabulary against a built record silently matches almost nothing.

---

## 5. The trap catalogue — organized by the shape of the symptom

### 5.1 "The field shows a list, but we reported *no options to choose from*"

**A `<select>` need not be a select.** iCIMS replaces many with its own AJAX combobox and leaves the
`<select>` **permanently empty** (one blank `<option>`) while its `value` holds an opaque numeric id.
The real choices are `<li role="option">` rows in a sibling `<ul>`. **The tell is the element's own
attribute** (`icimsdropdown-enabled="1"`) — not a guess, not a heuristic.

Corollaries:
- **The list may be ONE PAGE.** Measured 26 countries / 25 states (Alabama…Michigan). **A first-page
  miss is not proof the option is absent — search before reporting**, or everyone past Michigan fails.
- **A partial list must be recorded as partial.** But see §5.9 — over-claiming partial has its own cost.

### 5.2 "The search said no match, but typing it by hand works"

**Poll for a MATCH, not for stillness.** Every "has the search finished?" proxy is already satisfied by
the **pre-search** list: stability accepts it (non-zero and stable), and "changed since we opened"
accepts it too, because the list is often still loading at open time so the baseline is empty.

Measured: the school search takes **~4s**, and a 675ms give-up reported
`no option matched "Carnegie Mellon University" (after searching)`. Fix: match on **every** read, stop
at the first hit, treat the widget's own `"No Results"` as the terminal no, budget ~8s.

And **check "awaiting parent" BEFORE searching** — searching replaces the widget's
`"Please select a country"` row, which destroys the evidence and misreports the cause.

### 5.3 "It works by hand but not under a run" (frames)

- **A control count answers "which frame has the form"; it cannot answer "which frame is this tenant's
  content".** A posting page has zero controls, so `cdpUseFormFrame` refused to pin the frame that held
  the Apply link and the run halted on a page whose link works by hand.
- A `minControls:0` call must be **identity-anchored** (match the frame's own url, read from the page's
  own `<iframe src>`) — an unanchored 0-floor call will happily pin an analytics iframe and blind the
  caller in a NEW way, silently.
- **A postback can replace the isolated world** (`Cannot find context with specified id`). `cdpEval`
  re-arms once and retries — and the re-arm must **reproduce how the pin was obtained**, not assume a
  hardcoded floor, or a 0-control frame re-arms, fails, drops the pin back to the top document, and the
  same blindness returns later looking like a different bug.

### 5.4 "The submit fired and nothing happened" (captcha)

- **Our own timer polyfill can break the page's captcha.** iCIMS' gate is invisible hCaptcha whose
  submit is `preventDefault`-ed and only proceeds on the captcha callback; under the blob-worker timer
  polyfill hCaptcha **never initialises** (measured: `captchaFrames 0` under a run vs a rendered iframe
  by hand). Pass `{noWorkerTimers:true}` for that platform.
- **This is not captcha handling and must never become it.** It removes OUR tampering so the page's own
  check can run and judge the session. Nothing is solved, forged or hidden. **A visible challenge halts
  `needs_operator` — the bot never solves or bypasses a captcha.**
- The gap that decline costs a hidden run is closed the *other* way: `cdpSetFastWhenHidden(true)`, a
  scoped per-run opt-in, safe only because every pace site is read-back gated.
- **Diagnose with the pair `submitLocked` (the submit FIRED) + `captchaToken` (the captcha RESOLVED).**
  Nothing else tells the two apart.

### 5.5 "The widget worked, then never resolved again, and a refresh cured it"

**Install the page overrides BEFORE the document exists.** They replace
`setTimeout`/`setInterval`/`rAF`; landing them on an already-running document leaves the page
half-native/half-ours and async widgets never resolve again. A run opens its tab **blank**, attaches,
registers overrides, *then* navigates.

> **If a widget works by hand and not under a run, ask what the run did to the page before the page
> loaded.**

### 5.6 Repeating sections

- **Every field access must scope to the entry container** — ids duplicate across entries.
- **A field inside a repeating entry is SEALED to that entry.** An Education "State/Province" is the
  *college's* state; answering it from the home address is a **different fact**, not a near-miss. The
  rung must **return even when it has no answer** — that early return *is* the seal. And the seal must
  be `if (es)`, not `if (es && es.spec)`: an *unmapped* field inside a repeating section must still be
  sealed, or it falls through to the label ladder and gets answered from the profile root.
- **The LLM obeys the same seal** — an entry field is handed ONLY its own entry, and deferred questions
  are grouped **by scope** so an entry question never shares a prompt with page-level ones. A solo call
  uses the scoped profile too, or the seal would hold only when a batch happened to fire.
- **Ordinals are POSITIONS, never values.** And if the platform mints new entry ids per visit (iCIMS'
  résumé parse *saves* the entries it extracts, so each visit serves fresh server ids), the submit key
  must be a **position** (`@experience[0]/<bare id>`), or every entry field reports *"approved value
  has NO matching field on the live form"* — live, that was **all 45 Experience fields**.
- **A REPEATED entry of a single-value field is DETECTED, not declared.** Ask what the page can answer:
  *has this exact bare id already appeared under a different ordinal?* A repeat is left **blank with a
  note** — the profile holds one phone, so a copy is a fabricated second number.

### 5.7 The submit visit is not the fill visit

- **Credentials are NEVER replayed from the bundle** (it holds a placeholder by design) — re-read them
  from storage, or you type `"(stored login)"` into the account's login box and submit it.
- **A résumé is never in the bundle either** (no bytes) — re-attach from IndexedDB on each visit.
- **Grow repeating entries from the BUNDLE, not the profile.** A replay passes `profile: {}` by design,
  so an entry-growing pass counted 0 rows and the form kept the one entry it renders — **28 of a
  rehearsal's 32 verify failures**.
- **A multi-answer value arrives JOINED** (`"Internship; Part-time"`) — split it with the same
  vocabulary the fill joined it with, or you ask the form for an option by that whole name.
- **The pull must be TARGETED**, keyed on the run-stable `job_key`, and the caller **refuses rather
  than replaying whatever is in storage**. Without this, submitting job B while storage held job A's
  fill replays A's approved values into B's form and submits it.

### 5.8 "A required field reached the AI even though the profile answers it"

**Recognition is what keeps the AI away from a field.** The AI rescue's prompt tells it to infer from
absence and never refuse — so an unclaimed question gets a confident answer. Therefore some rungs
**claim a question even when they cannot answer it**:

- **Security clearance** — empty ≠ "None". Empty means the operator hasn't told us ⇒ blank + review. An
  invented "No" for a TS/SCI holder is a false statement. It also bails on willingness/eligibility
  wordings (those ask about the *future*).
- **"May we contact this employer?"** — an unanswered one is claimed, not passed on. A "Yes" nobody gave
  could tip off an employer the operator hasn't told they're looking, and that is **not recoverable
  from a review page afterwards**.
- **Contact opt-ins** — answered "No" deterministically, whatever widget asks. But the **bail list is
  the load-bearing half**: a "No" to a background check, a drug screening, a reference check or the
  privacy notice **sinks the application**.
- **Credentials** — the top rung, above everything, because every rung below could otherwise reach a
  login box.

⚠ On Workday **four** separate paths would otherwise guess a clearance, three of them invisible from
the deterministic rung (the AI batch, the AI infer pass, the required-radio/checkbox rescues, and the
final required-dropdown backstop). **When you add a claiming rung, enumerate every path that could
reach the field and close all of them** — then pin each with a test.

Conversely: a **required platform field whose label is a bare noun** is the shape that silently reaches
the AI. iCIMS' phone fields are labelled only "Number" and "Type"; the AI answered the required
"Number" with the job's **requisition id**.

### 5.9 Option lists and what review can offer

**An optional dropdown must reach review as a real picker.** On a one-page form a field we never filled
still has to be *answerable*, and a picker with no usable options is just a text box.

**The asymmetry is the safety property:** a picker **missing** the operator's answer makes them conclude
the form doesn't offer it; a complete list called partial only costs a typed value. So every uncertain
case stays partial.

Deriving completeness: **the form reveals its own page size when you look at every dropdown at once.**
Unrelated vocabularies do not stop at the same exact length by chance, so N dropdowns all ending at 25
is a pager — and a list *shorter* than a page has reached its end. Derive it; never hardcode. And a
repeated length must clear a floor, or ten Yes/No dropdowns "prove" a page size of 2 and nothing is ever
complete again.

### 5.10 The résumé, when the platform parses it server-side

**Order is the whole fix.** iCIMS parses the upload server-side and posts the result back seconds later,
re-rendering entries under new ids and blanking what was written — *"Existing data in the form will be
replaced"*, in the form's own words. As an ordinary field mid-fill it **destroys the fill it is meant to
help**.

So: attach it after the form settles and **before a single value is written**, then wait. The parse can
only overwrite an empty form.

**The wait is NOT a timer** — two polled conditions, both required: the form's own **identity** changed
(field set + which fields hold a value — a field-*count* settle cannot see a re-render that keeps the
count), **and then** the panel goes **quiet**. A parse that changed nothing is indistinguishable from
one that hasn't started, so that branch still spends its whole budget. **Being slow costs latency; being
early costs the entire fill.**

And: **the heartbeat probe must be a cheap read, or it becomes the wait.** A full scan per tick made a
"900ms poll" really cost ~2.9s; three stable reads took ~8.6s instead of ~2.8s. A lean signature (each
control's name + whether it holds a value, returned as a finished string) cut 10 reads to 704ms total.
⚠ **Both sides of the comparison must be computed the same way** — a full-scan baseline against lean
ticks differs on tick ONE, which reads as "the parse changed the form", and a **false `changed` lets the
loop finish on the first brief quiet, possibly before the parse has started.**

### 5.11 Consent checkboxes

**Standing operator instruction (2026-08-18): accept checkboxes are ticked.** Privacy notices, terms,
GDPR. The operator is the data subject, the notice governs *their* data for *their* application, and
declining means the application cannot be made at all.

**Never ticked:** opt-ins (talent community, job alerts — an opt-in that merely *mentions* privacy is
still an opt-in), truthfulness **attestations** (a factual claim by the applicant, deliberately excluded
— do not fold these in without asking), and cookie banners (out of scope).

**Auditable, not silent:** every acceptance is logged by name with the notice's own title, carried on
the run result, and **verified** — a box that did not end checked halts rather than being reported as
consent given. The scan **reports** boxes and classifies nothing; the judgement lives SW-side so there
is one copy of it. Kill-switch: `chrome.storage.local.declineConsents = true`.

### 5.12 "The value changed to a different option on its own"

**It is never the platform. It is us.** A committed value can rarely be *removed*; it is never silently
*changed into another option*. Live, the cause was: every portaled listbox renders at the **same screen
coordinates**, options **linger a beat while unmounting and stay clickable**, and the next field's
open-click landed on the previous field's still-mounted list.

**Triage rule:** value GONE ⇒ plausibly the platform (rare). Value **CHANGED to another real option** ⇒
**ours** — look for a lingering list, a stale rect, or a second write, in that order.

Hence: **every dropdown close confirms the portaled options are GONE** (option count === 0), not merely
`aria-expanded="false"`.

### 5.13 A scraped job description is untrusted text

`textContent` **includes `<script>` source**, and a "largest text block on the page" heuristic is a
**contest** — on a server-rendered portal whose page is mostly bootstrap JS, the winner is the JS. Live
that stored the **one-time magic-link session token** as the job description, which then reached
Supabase, every AI prompt it grounded, and the run's logs. Run `redactSecrets` where `description` is
**assigned**, not only at the report boundary.

---

## 6. What must never be traded away

Short list. If a change touches one of these, it needs the operator's sign-off, not a judgement call.

1. **Every commit is read-back verified.** A verification that cannot be made is `needs_review`.
2. **Never blind-commit a guess.** Whatever supplies a value — profile, bucket, AI — it is a
   **CANDIDATE through the match ladder vs the LIVE options**, read at commit time.
3. **The match ladder accepts only:** exact (normalized), a **leading-polarity** yes/no, a **typo**
   (fuzzy ≥ 90), or a value **the platform itself autocommitted**. Everything else escalates.
   **Containment is a GUESS unless the platform made it.**
4. **Why not low-threshold fuzzy:** a 60% bar matches near-gibberish and silently selects a WRONG value
   — the worst failure for an accuracy tool, worse than leaving a field unfilled.
5. **Every AI fill is flagged `needs_review`.** Always. The human review gate is the safety.
6. **AI eligibility is HARD:** an unmapped/unmatched field gets AI **only when REQUIRED**. Never
   `file_upload`, never `checkbox`. An optional field fills deterministically or stays blank.
7. **Never submit outside the gate.** Bundle blockers + strict live verify + no visible captcha +
   `arm===true`. Absent `arm` ⇒ a full dry rehearsal that logs "WOULD CLICK SUBMIT". **AI is OFF for
   submit runs regardless of the toggle.**
8. **Nothing proceeds on a fixed timer.** Every wait polls the condition it gates. Pacing is SW
   wall-clock (`act.delay`), never a page-side timer.
9. **Engine computes / service worker does I/O.** `ats.js` never touches `chrome.storage`.
10. **Credentials never enter a log line, a record or the bundle.** Setters return a **length**;
    verifiers return a **boolean**.
11. **No silent caps.** Whatever a cap drops is reported as a note.
12. **Two runs are mutually exclusive.** cdp.js tracks ONE tab; a second run steals the first's attach.
    Observed: two overlapping runs on one posting produced a bundle with 12 `error` fields.

---

## 7. Performance — read the log before blaming the platform

- **A slow page is the LLM until proven otherwise.** Subtract the `[LLM]` line first. Measured: the same
  model, same config, same session answered in 486ms, 646ms, 796ms — and once in **30657ms**. That
  single call was the entire difference between a 1.9s page and a 32s page.
- **"The LLM" is not one thing — latency belongs to a provider+MODEL.** Two same-price siblings diverged
  **20×** for hours. Name the model, and A/B the siblings on one key before concluding anything. **A 429
  is the KEY's quota; a 5xx is the MODEL's health.** Never treat them alike.
- **Use the idle control arm** (`AP_DEV_LLM_PROBE`): N calls through the same seam with **no tab, no
  attach, no run**. A hidden-vs-visible comparison cannot separate provider latency from page cost,
  because both arms run while a tab is being driven. This retired a "hidden is 2.4× slower" claim.
- **SW timer drift is real** (`act.delay` overruns 3–69× in the MV3 worker) but it costs **latency, not
  coverage** — every run-path poll watches a monotone or a stability predicate. So **a wait that timed
  out wants a bigger BUDGET; never add an attempts floor.** "The poll didn't look often enough" is not
  an available explanation for a failed wait.
- **A stability predicate gets WEAKER when you poll faster.** Sparse reads are stronger evidence that
  nothing is moving. If you make a probe cheaper, spend some of the saving on a longer quiet window.
- Append every measurement — including refuted theories — to `docs/fill-speed-log.md`.

---

## 8. The dev loop

1. **Recon** on a real posting, read-only. Write the `docs/dom-patterns.md` entry.
2. **Detection + the scan.** Get `atsInjScan` returning correct field records. Verify by *reading the
   scan output*, not by filling.
3. **Routing.** Static map, then the label ladder. Check what falls through to AI — anything the profile
   answers that reaches the AI is a routing bug (§5.8).
4. **Actuation, one widget class at a time**, each with its read-back.
5. **A full fill.** Read the `[ATS-OPTIONS]` lines and the per-field tiers. Check the audit.
6. **Review** the bundle on the website. Confirm every picker is a real picker.
7. **A dry rehearsal** (no `arm`) — it must log "WOULD CLICK SUBMIT" with 0 failures.
8. **Only then**, an armed submit, eyes-on, on a **disposable** application.

⚠ **Reload discipline:** reload the extension card after code changes, and reload the target tab too if
an injected function changed.

⚠ **Worktree gotcha:** the extension reports to `NEXT_PUBLIC_SITE_URL` (default `:3000` = the MAIN
checkout), so a worktree live test can verify the wrong code. Check the port.

### Definition of done for a new platform

- [ ] `npm test` green, with new tests pinning: the anchored host regex, every LOCKSTEP dup, the routing
      decisions that were paid for (both directions — what it claims *and* what it bails on), and
      `test/sw-globals.test.js`.
- [ ] A fill run on **two different tenants** (per-customer config means tenant 1 proves little).
- [ ] `needs_review` accounted for field by field — each one is a real question for the human, not a
      routing miss.
- [ ] A dry rehearsal with **0 failures**.
- [ ] `docs/dom-patterns.md` entry written; `CLAUDE.md` given its standing-rules section;
      `docs/progress-log.md` given the dated entry; `docs/status.md` updated.

---

## 9. Documentation contract

When a milestone lands:

| Where | What |
|---|---|
| `CLAUDE.md` | **Standing rules and invariants only** — a few lines. Keep it lean. |
| `docs/progress-log.md` | The full dated milestone entry (append-only). |
| `docs/dom-patterns.md` | Observed-DOM findings, dated, **including refutations**. Add the topic-index row. |
| `docs/fill-speed-log.md` | Any timing measurement, including theories that were refuted. |
| `docs/status.md` | Current state, NEXT items, open blockers. |
| the matching skill | Mechanism. |

**Record refutations, not just conclusions.** "Visibility filtering was tried TWICE and confirmed a dead
end — do not retry it" has saved more time than most of the positive findings, because the next person's
first instinct is exactly the thing that already failed.

**One commit per milestone**, reasoning-first in the body, so a regression can be bisected. **No AI
attribution** in anything reaching GitHub (operator instruction).
