# ApplyPilot Chrome Extension

## Where the documentation lives

This file holds **standing rules, invariants and safety contracts only** — everything an agent must know
*without* loading anything else. Mechanism lives in skills, loaded on demand.

| Load this | When |
|---|---|
| `cdp-actuation` skill | pacing, input primitives, any widget handler (text/date/radio/dropdown/typeahead/source/**skills**), the option scrape, cascade+sweep, input-lock, M40 audit |
| `workday-walk` skill | the N-page walk, `clickPageNext`, nav-timeout halts, AI-4 remediation, phantom duplicates, repeating sections + the `*_MAP` maps, résumé attach |
| `review-and-submit` skill | the `reviewSummary` schema, accumulation, the viewer/editor, the approval envelope, replay re-verify, review-page reconcile, `submitPrecondition` |
| `answers-and-ai` skill | the full match ladder, answer buckets + answer ladders, `llm.js` / AI-0…AI-4, employer-match + employment-status recognizers |
| `ats-tenants` skill | Greenhouse / Lever / Ashby (`ats.js`) — routing, the option poll, per-ATS traps, the dev loop. ⚠ Assumes a top-frame, login-free form: for **iCIMS** read the iCIMS section below first (iframe-hosted, and it creates an account), then use this skill's dev loop |
| `workday-onboarding` skill | pre-form: JD → Apply → sign-in → Gmail verify → the form |
| `job-discovery` skill | the LinkedIn / Handshake / Simplify sweep (`discover.js`) |
| `live-testing` skill | driving a real end-to-end run through Chrome |
| `docs/adding-a-filler.md` | **adding support for a NEW ATS / platform** — the substrate decision, the recon checklist, the exact integration surface, the five widget-registration sites, and the trap catalogue organized by symptom. Read it before writing a line of code for a new platform |
| `docs/dom-patterns.md` | the dated observed-DOM rulebook (every tenant + refutations). **Has a topic index at the top — use it; never read the file whole.** |
| `docs/progress-log.md` | full extension milestone history. Append new entries here. **Has a topic index at the top; never read it whole.** |
| `docs/fill-speed-log.md` | **fill SPEED / timing** — every measurement, refuted theory, per-run data and fix direction. Read before investigating any slow fill; append new speed rounds here |
| `docs/status.md` | current state, NEXT items, operator TODOs, deferred work |
| `WEBSITE.md` | the Next.js + Supabase companion site (`web/`) — design + the handoff contracts |
| `docs/website-progress-log.md` | website milestone history. Append new website entries here. |
| `docs/profile-v2-plan.md` | the design reference for Profile v2 / answer buckets / the teach flow — **still live**, cited from `fill-driver.js`, `web/lib/buckets.ts`, `web/lib/teach.ts` |
| `docs/gmail-setup.md` | Gmail auto-verify OAuth setup |
| `docs/archive/` | superseded plans, kept for reference only |

⚠ **Search with the `Grep` tool, not `grep -r`.** `.claude/worktrees/` holds ~728MB of gitignored worktree
copies (including `.next` build output); ripgrep skips them via `.gitignore`, a bare `grep -r` does not and
will time out.

## What this is

A Manifest V3 Chrome extension that automates Workday job applications from a stored profile. From-scratch
rewrite of a Python + Playwright tool of the same name; the Python repo lives separately and is a **design
reference, not code to port** — it documents what the system should do; this repo builds it for the runtime
that will ship.

The shape is a **fill → review → submit** pipeline: the engine fills a page and produces a per-field review
summary, a human reviews/edits it, and a later pass replays the approved values. All three stages are built;
the SUBMIT stage is live-verified in **SIMULATE mode** (it runs the full replay + precondition gate and logs
"would click submit" — no real click yet; going live is one flag flip behind an eyes-on, disposable-app
gate).

## Architecture & invariants

- Manifest V3; host permissions `*://*.myworkdayjobs.com/*` **and `*://*.myworkdaysite.com/*`** (the
  logged-in Workday host — needed so the website-Run JD scrape's `chrome.scripting.executeScript` can read
  the page; the CDP walk works there regardless since `chrome.debugger` isn't host-gated), plus
  `www.linkedin.com` / `app.joinhandshake.com` / `raw.githubusercontent.com` for the discovery sweep.
  **Deliberately NOT `<all_urls>`:** discovery reads arbitrary employer/ATS job pages through CDP instead.
- **Active-tab injection — NOT a content script, NOT a background tab.** `background.js` (service worker)
  receives a `RUN_FILL` message from the popup and uses `chrome.scripting.executeScript` to inject
  `fillEngine` into the active tab (frame 0). *Why:* the operator is logged in and on the form themselves, so
  injecting into the active tab fills the page they're looking at. Content-script files and
  background-tab/multi-page automation were deliberately deferred.
- **Profile + defaults + jobContext live in `chrome.storage.local`** — the permanent website→extension
  handoff contract. The engine ALWAYS reads them from storage (today the popup's "Load default profile"
  seeds `profile` from `data/profile.json` and `defaults` from `data/application_defaults.json`;
  `jobContext.company` is set via a popup field; later a website will write them). The engine is agnostic to
  how they got there.
- **"Engine computes / service worker does I/O."** The injected `fillEngine` is self-contained (closes over
  nothing from the SW), reads/writes the page DOM, and RETURNS results — it never touches `chrome.storage`.
  `background.js` does all storage I/O (e.g. persisting the review summary). **Keep this boundary.**
- **Pipeline shape:** fill (engine, per page) → review (the `reviewSummary` + the website review editor,
  human edits) → submit (replay approved values).
- **UI:** `popup.html` / `popup.js` — profile/résumé/LLM config + the fill, recon, and walk buttons.
  `summary.html` / `summary.js` — the fallback review-summary viewer/editor. `[ApplyPilot]` logs land in the
  **service-worker** console.

## Workday DOM model

See `docs/dom-patterns.md` for the full, dated rulebook. Short version:

- Every form field sits in a `<div data-automation-id="formField-*">` wrapper.
- `classifyField` derives the widget type from wrapper descendants, **first match wins**: hierarchical
  `source` → typeahead (`data-uxi-widget-type="multiselect"`) → radio (`input[type=radio]`) → dropdown
  (`button[aria-haspopup="listbox"]`) → checkbox (ONE) → **checkbox_group** (2+ checkboxes in one wrapper = a
  pick-one set, e.g. the OFCCP disability self-ID; radio-like fill — unchecks the current option
  first, verifies exactly one ends checked; options read from the DOM by the scan, so a field left BLANK
  still reaches review as a picker. ⚠ It matched on a RAW lowercase byte compare until 2026-08-10, which is
  why the profile's `"No, I do not have a disability"` missed cat.wd5's `"No, I do not have a disability and
  have not had one in the past"` and blocked Save; it now goes through **`matchCandidates` with
  `containment:false`** like radio/dropdown, so POLARITY LEAD lands it) → **date** (a `dateSection*-input` composite — its spinbuttons carry no
  `type`, so 3 of them used to read as "not one text input" → `unknown` → a bare textbox in review; the scan
  carries `dateSegments` → `date_order`, so review renders the form's own MM/DD/YYYY vs MM/YYYY vs YYYY) →
  text → unknown.
- **Rules come from observed DOM, not the Python spec.** Patterns the spec assumed do NOT hold on observed
  pages (e.g. `role="combobox"`, `role="radiogroup"` don't fire on Comcast). **When code and doc disagree, fix
  one — don't let them drift.**

## React fill technique

Workday is React-based: `input.value = "x"` updates the DOM but not React's internal state, so the value
reverts on submit. The working pattern (verified on Comcast text fields; needed for any controlled input):

1. native setter: `Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set`
2. `nativeSetter.call(input, value)`
3. dispatch `new Event('input', { bubbles: true })`
4. dispatch `new Event('change', { bubbles: true })`

## Interaction patterns (the shared helpers)

Primitives proven against real Workday pages, now the shared helpers inside `fillEngine` (`background.js`).
**Reuse them — don't reinvent.**

- **`robustClick` — the click primitive.** Three-strategy ladder: (1) pointer-event sequence
  (`pointerdown→mousedown→pointerup→mouseup→click`, `clientX/Y` from the bounding rect — closest analog to a
  real click), (2) native `el.click()`, (3) bare `MouseEvent('click')`. On Comcast the pointer sequence has
  succeeded on every widget; the fallbacks are kept because portaled-listbox/overlay layers can mask
  synthetic clicks on other tenants. Use it for any non-text-input interaction.
- **Typeahead is open-before-find.** The searchBox `<input>` isn't reachable until the widget opens
  (container carries `data-automation-hiddensearch="true"`). Click the opener first, then `waitFor`
  `input[data-automation-id="searchBox"]` scoped to the wrapper. Opener ladder:
  `[data-automation-id="multiselectInputContainer"]` → `[data-uxi-widget-type="selectinput"]` → first
  `<input>` → wrapper.
- **Clear before typing.** Set the search input to `""` (native setter + input event), wait briefly, then
  type — avoids residual-text contamination on re-fill.
- **Settle-poll the filter, don't scrape on a fixed delay.** Live-filtering typeaheads race a fixed
  `setTimeout` (we saw option counts flip 21↔1 with wrong matches). Poll the enabled-option count ~120ms and
  accept only after **two consecutive equal, non-zero reads**, with a timeout fallback to the latest read.
- **Sequential cleanup — don't over-engineer per-field close.** Moving to the next field blurs the prior
  widget and dismisses its listbox for free. We burned time on explicit Escape/click-outside closes before
  realizing the sequence handles teardown.
- **Radios: click the label, group by `name`.** Inputs are CSS-clipped; the `<label for="<id>">` is the
  styled click target (native label-activation flips `checked` + fires the change event React listens for).
  Group by shared `name` (not a `role="radiogroup"` wrapper, which Comcast omits). Verify via `input.checked`.
- **Options are portaled to the document root** (outside the `formField-*` subtree). **But a bare page-wide
  `[role="option"]` scrape is contaminated** — scope dropdown scrapes to the field's own listbox (below).
  Filter `aria-disabled="true"` (the "Select One" placeholder).
- **Always verify state, not just click outcome.** `robustClick` returning a strategy means an event fired,
  not that the page updated. Re-read observable state after a delay: radios → `input.checked`; dropdowns →
  trigger text; typeaheads/source → the `selectedItem` chip / `multiselectlistitem` selected-state. Synthetic
  clicks have no-op'd silently.

## Choice-widget handlers & hard-won DOM lessons

Full per-tenant detail is in `docs/dom-patterns.md`. The load-bearing whys:

- **`source` ("How did you hear about us?") has three tenant shapes**, all handled by `fillSource`
  (discover-and-trace): Cambium = button+listbox **expand-walk** (no searchBox); Comcast = typeahead;
  **US Bank = searchBox that filters on ENTER, not live**, whose result leaves are
  `<div data-automation-id="promptOption" data-automation-label="…">` — **NOT `role="option"`** (that role is
  on a sibling `menuItem`), and whose searchBox `aria-controls` points at a `promptAriaInstruction` node (the
  wrong target). So: type → full Enter → race-safe wait for `promptOption`s → match on
  `data-automation-label` → click → **commit-gated** via the enclosing `multiselectlistitem` selected-state.
- **Dropdown option contamination — and why visibility filtering is a DEAD END.** A page-wide
  `[role="option"]` scrape pulled in two *genuinely-visible* contaminants: (1) **selected-item CHIPS** — a
  filled multiselect/source renders its selected value as
  `<ul role="listbox" data-automation-id="selectedItemList"><li role="option" data-automation-id="selectedItem">…</li></ul>`,
  i.e. **the chips carry `role="option"` markup**, so "LinkedIn"/"(+1)" showed up as options inside every
  dropdown; and (2) **a prior dropdown's listbox stays open** (filling State, Country's `ctny0` was still
  mounted, so State listed countries). **Visibility filtering was tried TWICE and confirmed a dead end — do
  not retry it**: both contaminants are genuinely `visible:true`. **Fix:** scope the scrape to the trigger's
  own `aria-controls` listbox (verified per widget: `ctny0`→countries, `ctny1`→states, `ctny2`→phone-types —
  unlike `source`, here aria-controls resolves to the real options container). `settlePoll` also excludes
  `selectedItemList` chips.
- **`is_required` detection varies by tenant.** Workday marks required fields with one of:
  `<abbr title="required">`, a **bare `<abbr>*</abbr>`** (asterisk as content, no title — US Bank dropdowns),
  `aria-required="true"`, or a label/legend whose visible text **ends with `*`**. Detect all of them (safe
  over-flag direction). Accuracy matters: **a required field reading *false* is the dangerous direction** — it
  hides an unfilled required field, and a required field the engine can't fill will block page advancement.

## Matching strategy — the net rule

Full ladder, per-tier detail and the boolean/normalize rules: **`answers-and-ai` skill.** What must never be
forgotten:

**ApplyPilot accepts only an EXACT match, a TYPO (fuzzy ≥ 90), or a value WORKDAY AUTOCOMMITTED** — plus, for
SKILLS only, a guarded whole-word containment. Everything else escalates → the operator picks it on the
website review editor / teaches an answer bucket (→ an exact match next time), or the AI rescue fills a
required field.

- **Value is an ordered candidate list, most-specific first** (`resolve()` coerces per widget type; an array
  passes through as a ready-made tiered list). A **BOOLEAN** profile value coerces to `["Yes","True"]` /
  `["No","False"]` for dropdown/typeahead **AND radio**, so a checkbox, a true/false dropdown, a yes/no
  dropdown and yes/no radios all fill DETERMINISTICALLY from a stored boolean.
- **Containment is a GUESS unless Workday made it (2026-07-16).** Dropdowns + radios and *directed* typeahead
  picks pass `{containment:false}` — a substring match on a shown list is a wrong guess (the `"PA"` → **"Armed
  Forces Pacific"** bug: `"pa"` ⊂ "pa**cific**", the ONLY option containing it, so the ambiguity guard couldn't
  help, and it committed at `filled` with NO review flag). Typeahead **AUTOCOMMIT recognition** KEEPS
  containment — "the chip contains what I typed" is how we recognize *Workday's own* completion. That's
  trusting Workday, not guessing; still `filled_review`.
- **Why not low-threshold fuzzy:** a 60% bar matches near-gibberish and silently selects a WRONG value,
  corrupting the application — the worst failure for an accuracy tool, worse than leaving a field unfilled.
  Fuzzy is typo-tolerance at 90+, not a general matcher.
- **needs-review / fuzzy connection:** a fuzzy/no match is not a confident answer — it's exactly the category
  that belongs in the human-review pile.

Lives in `matchCandidates` (lib.js + the inline `fillEngine` copy in `background.js` — **LOCKSTEP**).

## Answer buckets (website-driven; Profile v2)

How a choice widget picks an option. Architectural decision, with rationale:
- **Value is an ordered candidate list, most-specific first**, supplied by the profile (`resolve()` coerces per widget type; an array passes through as a ready-made tiered list). The handler tries candidates in order. **A BOOLEAN profile value coerces to the tiered list `["Yes","True"]` / `["No","False"]` for dropdown/typeahead AND radio** (2026-07-23) — so a checkbox, a true/false dropdown, a yes/no dropdown, and yes/no radios all fill DETERMINISTICALLY from a stored boolean. *Why it matters:* a bare `"true"`/`"false"` string matched no "Yes"/"No" option and leaked required boolean questions (e.g. "Are you over 18?*") to the AI post-pass — flagged LEGALLY-LOADED on every fill despite the profile answering it. Both `resolve()` copies (lib.js/fill-driver.js + the background.js engine) are lockstep; regression-pinned.
- **Match ladder (per candidate, stop at first hit):** (1) **Exact** after `normalize()`; (2) **Containment — WIDGET-DEPENDENT, AMBIGUITY-SAFE + short-guarded** (`matchCandidates(cands, opts, {containment})`, default ON) — `startsWith` then `includes`, committed ONLY when **exactly one** option contains the candidate (a candidate in **2+ options is NOT a confident match** → skip), AND mid-string `includes` requires the candidate to be **≥ 3 chars** (a 2-char abbrev is a substring of too many unrelated options); (3) **Fuzzy ≥ 90** Levenshtein — **TYPO TOLERANCE ONLY**; (4) **Escalate** → `needs_review` (a REQUIRED field then goes to the AI rescue; optional → blank).
- **Containment is a GUESS unless Workday made it (2026-07-16). ApplyPilot never PICKS a containment match itself:**
  - **Dropdowns + radios (select from a full list)** pass `{containment:false}` → exact → typo → escalate. *Why:* a substring match on a shown list is a wrong guess (the `"PA"` → **"Armed Forces Pacific"** bug — `"pa"` ⊂ "pa**cific**", the ONLY option containing it, so the ambiguity guard couldn't help; it committed at `filled` with NO review flag). (`fillRadioCdp` was already exact-label-only, so this only changed `fillDropdownCdp`.)
  - **Typeahead / cert / source DIRECTED picks** (Workday showed a filtered list and did NOT autocommit, and we would click the one containing option) ALSO pass `{containment:false}` — same reasoning: us picking is a guess.
  - **Typeahead / cert / source AUTOCOMMIT recognition** KEEPS containment (default) — when *Workday itself* drops in a completed chip after you type (e.g. `"Training Instructor - AEVO"` → `"…AEVO - Multiple Recognized Providers"`), "the chip contains what I typed" is how we RECOGNIZE Workday's completion (vs a genuine stray like a `"Canada"` chip for a US query). That's trusting Workday, not guessing; still `filled_review` (flagged). The AI anti-hallucination belts keep containment too (the AI's choice → a real option; the AI rescue must succeed for required fields).
  - **ONE authorized exception — SKILLS (operator, 2026-08-07).** `matchSkillOption` has a **containment tier** so a skill Workday only lists under a broader name still lands (`Vivado` → `Xilinx Vivado`). It is safe only because of three guards, all earned on one live run: **WHOLE-WORD** containment (raw `includes` puts `Git` inside "Di**git**al" and `CAN` inside "**Can**adian"), a **distinctiveness gate** (a lone token must be ≥5 chars — on that run `CAN` was offered "**Can Openers**", a real whole-word hit the gate refused), and a **ranking tie-break** (several containing rows → Workday's own first result, alternatives named in the review). Every widened commit is `filled_review` + `skills-containment`, never silent. This does NOT relax the rule anywhere else.
  - **POLARITY LEAD — a yes/no answer matches an option that LEADS with it (operator, 2026-08-09).** Tier 1.5, right after exact: a stored `"No"` fills `"No, I do not require sponsorship"` **DETERMINISTICALLY** — `filled`, high confidence, no review, no teach. Operator's reasoning: for a yes/no question the polarity token IS the answer; everything after it is the tenant's phrasing, not something we inferred. This is NOT containment and is far narrower — three guards, each load-bearing: the CANDIDATE must be a bare `Yes/No/true/false` (any-string prefixing would let `"Bachelor"` claim `"Bachelor of Science in …"`, the exact guess containment exists to refuse); the match is **word-anchored** (`^no\b` never hits "November"); and **EXACTLY ONE** option may lead with it — a tenant splitting one polarity into two meanings (`"No, I do not now or in the future…"` vs `"No, I do not now, BUT WILL…"`) escalates to review instead of being guessed. `flagTierCategory` grades it **exact** (without that line it falls to `"none"` ⇒ `needs_review`/stray — the opposite of the intent). Lives in `matchCandidates` (lib.js + the inline `fillEngine` copy — LOCKSTEP), so dropdown/radio get it even though they pass `{containment:false}`.
  - **Net rule:** ApplyPilot accepts only an **exact** match, a **leading-polarity yes/no** (above), a **typo** (fuzzy ≥ 90), or a value **Workday autocommitted** — plus, for SKILLS only, a guarded **whole-word containment** (above). Everything else escalates → the operator picks it on the website review editor / teaches an answer bucket (→ an exact match next time), or the AI rescue fills a required field. **Lives in `matchCandidates` (lib.js + the inline `fillEngine` copy in `background.js` — LOCKSTEP); dropdown/radio + directed-typeahead call sites pass `{containment:false}`.**
- **Why not low-threshold fuzzy:** a 60% bar matches near-gibberish and silently selects a WRONG value, corrupting the application — the worst failure for an accuracy tool, worse than leaving a field unfilled. Fuzzy is typo-tolerance at 90+, not a general matcher.
- **`normalize()`** lowercases, strips a trailing `(+digits)`, collapses whitespace — lets "United States of America" exact-match the rendered "United States of America (+1)" with no fuzzy step. A tiered profile array (e.g. `["United States of America (+1)", "United States"]`) makes the exact-normalized hit land at **high** confidence instead of containment (medium).
- **needs-review / fuzzy connection:** a fuzzy/no match is not a confident answer — it's exactly the category that belongs in the human-review pile.
- **Parked (opt-in per field, never global):** dial-code-suffix matching ("any `(+1)` is acceptable for a US phone"). Global would silently accept a wrong country whose dial code happened to match.
Mechanism, Mode A/B, answer ladders, repeating-entry filling, starter/default wordings:
**`answers-and-ai` skill.** The standing rules:

- A **bucket** = one canonical answer + the question wordings that map to it. The website owns `buckets_json`,
  synced via `AP_SYNC_PROFILE`; the SW loads it from `chrome.storage.local` and hands it into `drivePageFill`.
- Consulted for any UNMAPPED field the deterministic pass left empty, **before** the AI post-pass. Runs for
  REQUIRED **and** OPTIONAL fields.
- **Exact-normalized match only — no fuzzy** (the AI fallback covers misses; a fuzzy tier would only add
  silent-wrong-match risk).
- Whatever a bucket supplies is a **CANDIDATE through the SAME match ladder vs the LIVE options — never a
  blind commit**; a no-match falls through to AI/blank. A real commit is flagged `bucket` (a "remembered"
  provenance, NOT an `ai-*` flag).
- **Supersedes** `answerBank`. `normalizeLabel` (lib.js) ↔ `normalizeQuestion` (web `lib/buckets.ts`) are a
  lockstep dup.

## AI feature — multi-provider LLM (AI-0…AI-4 built)

Prompt shapes, per-tier behaviour, the recon harness and current status: **`answers-and-ai` skill.** The
safety contract, which is absolute:

- **Every AI fill is guess + fill + FLAG `needs_review`, never silent trust — the human review gate is the
  safety.** ALWAYS `filled_review`.
- **The Workday batch covers DROPDOWNS *and* FREE TEXT, split across two ROUTES (2026-08-12).** It fires
  BEFORE the deterministic pass and un-awaited — **that overlap is the design and must not be traded away**
  (it is the opposite order to `ats.js`, deliberately: see the multi-ATS section). Text was excluded until
  this date, so every REQUIRED free-text question made its own serial call. Text candidates are **free to
  batch — they need no options, so they add ZERO page contact**; only an `infer` dropdown ever opens
  anything. Because `act.llm` carries one `action`, picks go out on `"fill"` and prose on `"essay"` as two
  concurrent un-awaited calls, and `aiBatchAnswer` **awaits only the route that could serve the field** —
  blocking a prose question on the dropdown call would make the first AI field wait for the slower of two
  replies for nothing. `aiFillText` takes a `preAnswer` exactly like `aiFillField`; the batch normalizes
  every answer onto `choice`, so it unwraps back into `parseAiText`'s `{answer}` contract at that seam.
- **Every AI choice is a CANDIDATE that must clear the match ladder vs the live options — never a blind
  commit**, then text-keyed commit + read-back + persistence re-read.
- **`llm.js` is the ONLY provider-aware code.** `callLLM({provider, model, apiKey, system, user, maxTokens})`
  → normalized `{ok, text} | {ok:false, error}`, **NEVER throws**. `act.llm` is the only I/O method on `act`;
  `act.aiEnabled` enforces the opt-in toggle (**OFF ⇒ no provider call, no spend**). The brain
  (fill-driver.js) builds the prompt and owns the decision, so it stays Node-testable with a fake `act.llm`.
- **Eligibility is HARD and unit-pinned: AI fills an unmapped/unmatched dropdown / text / typeahead ONLY when
  the field is REQUIRED** (operator rule). An OPTIONAL one fills deterministically or stays BLANK — a blank
  optional doesn't block Save & Continue, so there's no reason to spend an LLM call guessing it. **NEVER
  (regardless of required): `file_upload` and `checkbox`.** The two value-CANONICALIZE paths are NOT gated —
  they operate on a value the user PROVIDED, not a guess.
- **A REQUIRED EEO field fills via the same AI inference as any required field** (the operator RETRACTED the
  exclusion), then gets the loud `ai-eeo-guess` "AI-GUESSED DEMOGRAPHIC — VERIFY" badge. An OPTIONAL EEO field
  is left BLANK. **A STATED demographic still fills deterministically — the AI never overrides a value you
  provided.**
- **The review gate bites off the FLAG, never confidence.** `ai-choice-sensitive` answers render FIRST with a
  red "⚠ LEGALLY-LOADED — VERIFY" badge — a high-confidence reasoning-from-absence answer (e.g.
  criminal→"No") must NOT be the easiest to scroll past.
- **Every AI commit path must call `closeDropdownConfirmed`** (see "Workday never rewrites…" below).

## Workday's voluntary self-ID page — ALWAYS answerable (operator, 2026-08-10)

One structure wherever it appears (disability pick + signature Name + Date, sometimes a form-language
picker / employee id). Only the option **wording** varies, and only in its tail. So both answers are filled
**UNCONDITIONALLY, required or not**:

- **A signature date is TODAY** — deterministic, `filled`, no review flag, no LLM call. `dateSignedOn`, or
  any date whose label `isSignatureDateQuestion` recognizes. That recognizer stays NARROW: "Date of Birth" /
  "Graduation Date" / "Desired Start Date" are real questions and must never be stamped with today.
- **Disability comes from `self_identification.disability_status`**, expanded by
  `selfIdDisabilityCandidates` into the stored wording FIRST and the bare polarity token LAST — POLARITY
  LEAD then commits it only when exactly one option leads with that polarity.

**WHY unconditional is the point, not laziness:** these render OPTIONAL until `name` is filled, and filling
`name` PROMOTES them to required. Answering them up front leaves the cascade nothing to promote, so the
halt cannot happen rather than needing recovery (see the cascade-PROMOTE rule under review/submit).

**DETERMINISTIC AND THE AI NET ARE LAYERED, NOT REDUNDANT** — measured 2026-08-10 by switching the
deterministic fills OFF on a live cat.wd5 run. The AI net *does* rescue the page (it reached REVIEW, and
picked the right disability box), but it is strictly worse as the primary: it flags the demographic
`ai-eeo-guess` so the operator re-verifies an answer already in the profile (5 flagged vs 4), it can answer
DIFFERENTLY run to run (`name` came back "Kevin Wang" via AI vs "Kevin" deterministically — same field, two
answers on a real application), and the page cost ~3s → 33.2s. **Map what you know; let the net catch what
you don't.**

## Employer match — "previously employed here?" (safety-critical)

The recognizer, its bail patterns, per-widget commits and the tenant anchoring: **`answers-and-ai` skill.**
The invariants:

`candidateIsPreviousWorker` sits next to a **truthfulness certification**, and selecting "Yes" unfurls
follow-up fields — so a wrong "Yes" is a false legal statement.

| `decidePreviousWorker` case | action |
|---|---|
| **clean miss** (no known employer matches) | fill **"No"**, no review |
| **partial overlap** with the application company | fill **"No" + review** |
| **exact company match OR a known employer named in the question text** | fill **"Yes" + review** |
| **unevaluable** (list unconfigured / `[]`) | **blank + review** — no blind guess |

- **NEVER auto-"Yes" without a review flag.** Every "Yes" (and every uncertain "No") gets a mandatory human
  check.
- **A non-empty employer list is treated as COMPLETE** (operator 2026-07-24: "trust your list") — a clean miss
  fills "No" even with no company anchor, and even when the question broadens to affiliates/subsidiaries
  (there is no ownership DB). An EMPTY list can't confirm non-membership → unevaluable.
- **`employment_history_companies` = industry employers ONLY** (companies you were formally employed by;
  excludes academic/lab/club affiliations). Its completeness is what makes the auto-"No" safe. `["none"]` =
  "never formally employed" → confident "No"; `[]` = unfilled → flags every such question for review.
- The question-text scan **reads the user's KNOWN employers out of the question — it does NOT extract company
  names from prose (no LLM)**.
- A tenant's own worded employment question fills **deterministically on every widget type** via
  `recognizeEmploymentQuestion` — a clean "No" fills SILENTLY (a grounded fact, not absence-reasoning); a
  "Yes"/uncertain is `filled_review` + `employer-match`.

## CDP off-loop actuation — the primary fill path

Everything about how a field is actuated: **`cdp-actuation` skill.** The standing rules:

- A hidden/minimized tab throttles page timers to ~1Hz then deep-freezes, so a page-injected fill stalls (a
  PASSIVE debugger attach does NOT relieve it). Fix: actuation as **CDP commands from the service worker**
  (`chrome.debugger`, the `"debugger"` permission) — `Input.*` / `Runtime.evaluate` execute off the page loop,
  throttle-immune.
- Workday's debounced REACTION still runs page-side and throttled → **all waits are generous SW-side
  wall-clock; Δperf ~1000ms during a run is EXPECTED, never failure.**
- **Substrate/brain split (the substrate-swap hedge):** `cdp.js` = the substrate (attach/detach lifecycle,
  input primitives, `cdpEval`, `makeCdpActuation()`); `fill-driver.js` = the brain (`drivePageFill`) calling
  ONLY the actuation interface — Node-testable with a fake actuation. **ONE debugger client per tab**, so page
  DevTools on the tab kills the attach.
- **ALL pacing goes through `act.delay` (SW wall-clock) — never a page-side timer.** Every element is
  re-resolved fresh per call (React re-renders orphan held nodes).
- **Nothing proceeds on a fixed timer** — every wait polls the page condition it gates. `cdpFast()` = tab
  VISIBLE, **or** hidden-but-worker-timers-MEASURED-fast — never fast on assumption.
- **Every commit is read-back verified, and a verification that cannot be made is `needs_review` — never a
  silent pass and never a wrong value.** The dropdown commit adds a **PERSISTENCE re-read**: a momentary pick
  discarded on render-complete must never be reported filled — the false-verify class, the ONE failure the
  safety contract exists to prevent.
- **M40 post-fill audit:** a SECOND, independent DOM read after the whole page settles, reconciled vs what
  each field recorded → match / `audit-mismatch` / `audit-unverifiable` (never a silent pass).
- **SYNTHETIC-INPUT mode is scoped opt-in** (`cdpSetSyntheticInput(true)`; reset at every `cdpAttach`): the
  FILL entry points and the REPLAY walk. **ONBOARDING/AUTH and recon stay TRUSTED** — the auth form is the one
  surface synthetic failed live (fields read back OK but Sign In never fired). **`act.clickSubmit` is forced
  back to TRUSTED even when hidden** — ~1.5s for a single click, against never wondering whether a synthetic
  click half-fired. Kill-switch: `chrome.storage.local.forceTrustedInput`.
- **Every dropdown close confirms the portaled options are GONE** (`optionCount`/`leafCount === 0`), NOT merely
  `aria-expanded="false"` — options linger a beat while unmounting and STAY CLICKABLE, and a lingering option
  strays the next field's open-click.
- **Recon FIRST on any new tenant** (`cdp-recon`, `cdp-repeat-recon`, `cdp-questions-recon`, `cdp-tree-recon`,
  `RUN_CDP_RESUME_RECON`) — trace the real DOM before writing a handler.

## Multi-page walk (SW-driven; NEVER submits)

Page transitions, cover-checks, halts, AI-4 remediation and the phantom duplicate-entry fix:
**`workday-walk` skill.** The invariants:

- **The engine is torn down on every page transition** → the loop lives in the **service worker**, driving the
  ACTIVE tab per page (never a background tab). Per-page: fill → persist that page's bundle → **the SW clicks
  Next** (a separate guarded step AFTER the fill result is captured and persisted, so triggering navigation
  can never drop review data) → wait for the new page → repeat. `WALK_MAX_PAGES=8` backstop.
- **Termination: stop at the review page, NEVER submit — double guard.** The footer Next button **reuses the
  same automation-id as Submit** on the review page (marker `data-automation-id="applyFlowReviewPage"`).
  **Guard 1:** the walk stops when the marker is present — checked at the TOP of each iteration, before any
  fill or click. **Guard 2:** `clickNext`/`clickPageNext` independently refuse (`{refused:"review-page"}`) —
  defense in depth on the one click that could submit an application.
  **HARD GATE: the first walk that actually reaches the review page must be watched eyes-on on a DISPOSABLE
  application.**
- **Required fields block advancement → graceful halt, never a guess.** Workday won't advance with a required
  field empty: the signature never changes and the walk halts `nav-timeout` with diagnostics. **A dirty-state
  nav-timeout means "eyeball the page", not "session expired".**
- **Session death is behavioral, not DOM-static** (a timed-out page is DOM-identical to a live one).
  `sessionLooksDead(state)` = `vpsErrorPresent` OR session banner OR login marker OR no-form — **NEVER keyed
  off validation-error markers** (a form showing validation errors is alive).
- **Transition wait is poll-based, never a fixed delay.** Page signature = `url || pageId || formFieldIds`
  (any one differing = advanced). ⚠ `pageId` alone is NOT sufficient — the `applyFlowPage` container id is
  shared across pages; the `formField-*` set delta is the load-bearing signal.
- **NEVER scan a Workday page without settling it first** — JD page → `jobPageSettleStep`, form pages →
  `awaitFieldSetSettled` (called by BOTH the fill and replay walks), review page → `awaitReviewPageSettled`.
  Settle polls use **`delayFull`**, never `delayRender` (adaptive, collapses to ~40ms visible, which makes a
  half-rendered page look "stable").
- **Accumulation: write-per-page.** Each page merges into ONE `reviewSummary`; the walk clears
  `reviewSummary` + `reviewAudit` ONCE at start, **OUTSIDE the loop** (a mid-walk clear would wipe accumulated
  pages).

## Repeating sections — WE / Education / Websites / Languages / Certifications

The `*_MAP` maps, `deleteOnNoMatch`, the tenant-variable resolution ladder and nested cert specialties:
**`workday-walk` skill.** The invariants:

- **Reconcile to exactly N, then fill each entry** — true idempotency, proven from ARBITRARY dirty state.
- **`formField-*` ids DUPLICATE across entries** → every field access MUST scope to the entry container. The
  flat driver loop SKIPS fields inside repeating containers (`isRepeating`) so nothing double-fills.
- Entry containers are `[data-fkit-id^="<section>-"][data-fkit-id$="--null"]` — the From/To date wrappers
  share the prefix, so a bare prefix over-matches. **Add buttons all share
  `data-automation-id="add-button"`** → anchor by section heading (`findSectionAdd`).
- **`deleteOnNoMatch` (Languages, Certifications only):** an optional entry whose REQUIRED pick ends a
  **GENUINE** no-match is DELETED so it can't block Next; **a transient/infra failure KEEPS + flags — a render
  hiccup must never destroy valid entries.** WE / Education / Websites: flag, never delete.
- **When the live scan's widget disagrees with the map's, the LIVE DOM WINS** — the value is re-resolved for
  it (never a blind commit). A field's `formField-*` id AND its widget both vary by tenant.
- Dates are `role="spinbutton"` composites parsed **SW-side** by pure helpers in lib.js (the injected engine
  can't import).

## Résumé upload & storage

Storage, the attach path and the confirmation wait: **`workday-walk` skill.** The invariants:

- The résumé is NOT picked from the OS filesystem per application — the end state generates per-application
  AI-tailored variants, so the bytes are held/produced inside the extension and attached programmatically.
- **One PDF → base64 in IndexedDB** (DB `ApplyPilot`, store `resume`, single fixed key `resume:default`).
  Not `chrome.storage` — a real résumé's base64 blows past its quotas. **Phase 2+ variants just add more keys
  to this same store — do NOT pre-build variant slots or per-application keying.**
- **Strings only across the injection/message boundary — a `File`/`Blob` serializes to `{}`.**
- **Success = the confirmation ROW, not the input:** `input.files` RESETS to 0 after Workday's XHR upload.
  Gate on **`file-upload-successful`** (`file-upload-item` renders first).
- **`role="alert"` on the upload widget is the STATUS channel, NOT an error channel** — Workday announces
  progress there, and treating it as an error caused a false `resume-not-attached` HALT on a healthy upload.
- No-résumé / failed attach → `needs_review` and the walk halts `resume-not-attached` BEFORE clicking Next.
- **Per-entry attachments (e.g. per-cert) are the operator's job** — the résumé only ever attaches to the
  top-level Documents field (regression-pinned).

## Review summary (the fill → review → submit contract)

The full schema, accumulation, the viewer/editor, replay re-verify and the review-page reconcile:
**`review-and-submit` skill.** The contract:

- **PRIMARY review surface = the WEBSITE (2026-07-16).** The walk PUSHES its accumulated bundle to the site on
  every exit (`reportApplication`); before replay the SW PULLS the site-approved bundle
  (`pullApprovedBundle`) so `runCdpReplayWalk` / `submitPrecondition` are unchanged. The extension's
  `summary.html` viewer stays as a fallback — **keep the two schemas in lockstep.**
- **⚠ The pull MUST be TARGETED for a submit run.** Keyed on the run-stable `job_key`; the route NEVER widens
  to url/most-recent fallbacks when `job_key` is given; and the caller **REFUSES rather than replaying
  whatever is in storage**. Without this, submitting job B while storage held job A's fill would have replayed
  A's approved values into B's form and submitted it.
- On a **fully-completed** run the engine builds the bundle and RETURNS it; `background.js` writes it —
  **only on completion** (a crashed/aborted run writes nothing; no partials).
- **`page` is a STABLE merge key** (the field-SET, **not** the shared `applyFlowPage` container id — the M31
  lesson). `field_id` is PAGE-QUALIFIED (`<page_key>::formField-<name>`). `page_number`/`page_label` are
  display only.
- **`current_value` is only ever a live page value.** `original_ai_value` is the bot's pick at write time,
  never changed by edits.
- **The summary is the page's SOURCE OF TRUTH.** `sweepAlreadyFilled` (the LAST pass in `drivePageFill`) flips
  any `skipped` record whose field HOLDS a live value to `already-filled`; those are **AUDIT-EXCLUDED, never
  re-actuated**.
- **A KNOWN, profile-defined empty section is NOT a review item** — leaving it empty is the user's own choice.
  Only an UNKNOWN section stub nags. Same rule for an OPTIONAL orphan consent checkbox: shown and tickable,
  never a review item, **left UNCHECKED** — an optional consent is the operator's to give.
- **REVIEW ORDER = FORM ORDER** — `orderResultsByDom` sorts the bundle by the live DOM position.
- **`submit_ready` = every flagged field approved AND no unreplaced AI placeholder.** A VALUE edit RESETS that
  field's approval.
- **A REQUIRED field with NO VALUE blocks SUBMIT** (`bundleSubmitBlockers`, in both `review-approval.ts` and
  `summary-lib.js`).
- **Cascade-revealed REQUIRED fields go BACK TO REVIEW, not a blind halt** — `newlyRequiredGaps` creates an
  EMPTY, unapproved, `needs_review` entry and the walk halts `replay-needs-approval`. **It NEVER invents an
  answer.**
- **A CASCADE CAN PROMOTE, NOT ONLY REVEAL (2026-08-10).** Filling one field can make an ALREADY-PRESENT
  optional field REQUIRED. Every AI fallback is gated on `f.isRequired` read from the PRE-FILL scan, so a
  promoted field's fallback can never fire — live on cat.wd5, filling `name` promoted the self-ID Date and
  disability box and the walk halted with `cascade 0s+0s`, because `cascadePass` only looked for fields that
  APPEARED. It now ALSO re-fills an already-seen field that was OPTIONAL when scanned, is REQUIRED now, and
  is still EMPTY. **Keyed on required-ness AS FIRST SCANNED** — re-filling every required-and-empty field is
  a second fill pass on every page, not a cascade fix (it broke 20 tests). Carry `cascadeRevealed` over when
  replacing a record: it is what forces the re-review at the submit gate.
- **An approved field ABSENT from the live page is REPORTED but NEVER FATAL** — that was wrong twice live.
  ⚠ WHY the scan misses such fields is UNSETTLED; `cdpPageScan.fields` is a convenience list, **not an
  inventory**. The authority is Workday's own review page.
- **Review-page CHECK is READ-ONLY: attach → read → detach, never clicks Next/Submit.** Only **DISAGREE**
  blocks the gate (positive evidence the page CONTRADICTS what was approved); **MISSING is absence of evidence
  and is INFORMATIONAL** — Workday legitimately doesn't render every field. A scrape FAILURE still blocks.

## iCIMS — an IFRAME-hosted form whose ACCOUNT IS CREATED BY THE SUBMISSION (2026-08-16)

Observed DOM (ids, required markers, section shape, the résumé postback): `docs/dom-patterns.md`
`2026-08-16 — Astrion iCIMS`. The standing rules:

- **The whole application is inside a same-origin `<iframe id="icims_content_iframe">`** — the top
  document has ZERO controls. `cdpUseFormFrame` pins `Runtime.evaluate` to the frame's isolated world
  (`Page.getFrameTree` → `Page.createIsolatedWorld`), armed in `waitAtsFormReady` so BOTH the fill and
  the submit run get it. **`_frameCtxId` defaults null, so Workday / GH / Lever / Ashby are byte-identical.**
  An isolated world is not a compromise: it shares the DOM, and iCIMS is server-rendered jQuery, not React.
  ⚠ A postback can replace the world (`Cannot find context with specified id`) — `cdpEval` re-arms ONCE
  and retries; a stale world is recoverable, not a failed field. **`atsFormUrl` KEEPS the query for
  iCIMS** — `?eem=…&code=…` is a one-time magic-link session, not tracking cruft, and a second top-level
  navigation to the frame's src consumes it and lands on a 0-field sign-in page.
- **`atsCompanyFromUrl` reads the SUBDOMAIN for iCIMS**, not path segment 0 (which is the literal
  `jobs`) — that string anchors the safety-critical employment recognizer.
- **CREDENTIALS ARE A TIER, AND IT IS THE TOP ONE** (`atsRouteField`, above the static map, buckets,
  labels and AI). iCIMS embeds "Create a login" INSIDE the form because **the account is created as part
  of submitting** — so it is simply another section, and a prepopulated value (iCIMS renders the
  session's own login) is REPLACED. Being first is the safety property: every rung below could otherwise
  reach a login box. Invariants, all unit-pinned:
  - the value comes ONLY from `store.credentials` — the website's Credentials page, the same slot Workday
    onboarding signs in with. **Never a profile value, never a taught bucket, never an LLM.** The contact
    email (`personal_info.email`) is deliberately NOT the login: the two may differ.
  - **it never enters a log line, a record or the review bundle.** `rec.after` is a PLACEHOLDER
    (`"(stored login)"`) + `credential:true` + `credentialKind`, so review names WHICH credential without
    carrying it. `atsInjSetCredential` / `atsInjVerifyCredential` return a LENGTH and a MATCH BOOLEAN,
    never a value — `atsInjSetText`'s `{after: el.value}` would hand the secret to Supabase, because
    `buildReviewBundle` copies `rec.after` into `current_value` and nothing on that path redacts.
  - **clear before typing** — the setter SETS rather than replaces, so a rewrite merged into
    `"old@x.comnew@y.com"`. Write order is pinned `["", value]`.
  - absent/incomplete credentials ⇒ `needs_review` + `credentials-not-stored`, never a half-made account.
  - **REVIEW SHOWS IT LIKE A LOGIN FORM, and reads the value from the ACCOUNT, not the bundle
    (operator, 2026-08-17).** The bundle carries `credential: true` + `credential_kind` — FLAGS ONLY —
    so the review editor renders the login as text and the password as dots with a reveal toggle,
    sourcing the actual value server-side from `credentials_json` (the same row the Credentials page
    edits). ⚠ **Read-only, and that is the safe direction, not a shortcut:** an editable box would
    write what was typed into `current_value`, which is precisely how the secret would reach the
    application row. Changing it belongs on the Credentials page — the submit run re-reads it there
    anyway. Regression-checked live: the stored bundle contains neither the password nor the login
    email, only the placeholders.
  - **an unmapped `type=password` box is claimed anyway** — recognition is what keeps the AI rescue away
    from it, so an UNrecognized password field is the dangerous outcome. Claiming a LOGIN needs two
    agreeing signals (`autocomplete="username"` AND login/username wording).
- **THE IMMEDIATE READ-BACK IS NOT ENOUGH — `atsCredentialRecheck` runs LAST.** `autocomplete="username"`
  invites Chrome's own password manager into the box after the page settles: observed live as written,
  verified, reverted, still reported `filled`. The post-fill audit **structurally cannot** cover this (it
  compares against `rec.after`, which is a placeholder — so credential records are SKIPPED there), which
  is why a dedicated check compares against the EXPECTED value, inside the fill where the credentials
  already are. A replaced field is rewritten once; one the page keeps taking back ends `needs_review` +
  `credential-overwritten` with its placeholder cleared. **A login we could not keep on the page must
  never be reported as filled.**
- **A CREDENTIAL IS NEVER REPLAYED FROM THE BUNDLE.** The bundle holds the placeholder by design, so the
  submit run re-reads `chrome.storage.local.credentials` and routes these fields through the credential
  tier — otherwise it would type `"(stored login)"` into the account's login box and submit it.
- **NOT EVERY `<select>` ON THIS FORM IS A SELECT — the `icims_dropdown` widget (2026-08-16).** iCIMS
  replaces many of them with its own AJAX combobox ("IdDropDown"), and when it does the `<select>` is
  left **permanently empty** (one blank `<option>`) while its `value` holds an **opaque numeric id**
  (`12781`), never text. The real choices are `<li role="option">` rows in a sibling
  `<ul id="<id>_dropdown-results">`. The tell is the element's own attribute,
  `icimsdropdown-enabled="1"` — not a guess. Anatomy: `<a id="<id>_icimsDropdown">` opens it,
  `<span id="<id>_fakeSelected_icimsDropdown">` is the READ-BACK, `input.dropdown-search` is the search
  box, and the container's `dropdown-invisible` class is the open/closed gate — **`aria-expanded` stays
  `"false"` even while open.** Reading `select.options` there returns NOTHING, which is exactly how the
  required Country and State/Province reached review as *"no live options to choose from"* while the
  page was plainly showing a list.
  - **ONE PAGE AT A TIME** — measured 26 countries / 25 states (Alabama…Michigan, so Minnesota→Wyoming
    are absent). A first-page miss is NOT proof the option is absent: **search before reporting**, or
    everyone past Michigan fails. Its option list is therefore recorded **always partial**.
  - **A NEW CHOICE WIDGET MUST BE REGISTERED IN FOUR PLACES**, and missing one fails silently and
    differently each time: `ATS_REVIEW_WIDGET`, the `isChoice` list feeding `resolve()` (miss it and a
    TIERED profile array is coerced as free text, so the fallback tier that matches the form's wording
    is never tried), `atsAiBatchKind`, and `atsAiFallback`'s option-read + commit switches.
  - **`atsInjReadValue` needs a branch too** — otherwise the post-fill audit flags every one of these
    as `audit-mismatch` on a correct fill, because `selectedIndex` says "nothing selected".
- **A PARENT→CHILD DEPENDENCY IS DECLARED IN THE DOM, so report it rather than guessing.** Country
  carries `data-ddd-child-link="PersonProfileFields.AddressState"` and an `onchange` calling
  `icimsChangeParent`; the child's list reads `"Please select a country"` until the parent commits.
  DOM order already puts parent before child, so the natural fill order works — but a child whose
  parent is unset must say **that**, not "no options": the generic message sent a debugging round to
  the option read instead of to the unset parent.
- **A REPEATING-SECTION FIELD IS SEALED TO ITS OWN ENTRY (operator, 2026-08-16).** A "State/Province"
  inside an Education entry is the COLLEGE's state, so answering it from the applicant's home address
  is a DIFFERENT FACT, not a near-miss. `atsEntrySpec` / `atsResolveEntryField` read
  `profile.<source>[entryIndex]` and the rung **returns even when it has no answer**
  (`entry-unanswered`) — that early return is the seal; falling through would let the label ladder
  reach the profile root. **The LLM obeys the same seal:** `atsScopeForField` hands an entry field
  ONLY its own entry, and `atsRunAiBatch` groups deferred questions **by scope**, so an entry question
  never shares a prompt with page-level ones (which carry the whole profile) or with a different
  entry. A solo call uses the scoped profile too — otherwise the seal would hold only when a batch
  happened to fire. Entry indexes are stamped by **first DOM appearance** of the ordinal, never its
  numeric value (`-1` is the default entry; saved ones carry opaque server ids).
- **SCHOOL / OTHER SCHOOL is ONE decision across TWO required fields.** In the list ⇒ pick it and put
  `"N/A"` in Other School; not in the list ⇒ pick the list's own `"Other"` and put the name in Other
  School. Two non-obvious parts: on the fallback the record is **rebuilt, not patched** (the failed
  attempt's tier/detail describe a different commit), and an **UNKNOWN** School outcome writes the
  NAME, not `"N/A"` — treating unknown as matched is the one branch that silently loses the school.
- **A FORM CAN REQUIRE A DAY THE PROFILE DOES NOT STORE (operator, 2026-08-17).** Profile dates are
  month-precision (`"2025-05"`), so every required Day reached review BLANK. Two sources, and the
  distinction is the point: the profile's OWN day when it stores one (`"2025-05-12"` → a stated FACT,
  `filled`, unflagged), else `defaults.date_day` (`data/application_defaults.json`, built-in **1**) —
  an APPROXIMATION, so it is **`filled_review` + `default-value`** and faces the human gate like any
  value the operator did not state (operator, 2026-08-17). It still FILLS, which is the point: the
  field went from blank-and-flagged (type a value) to filled-and-flagged (approve it). ⚠ Deliberately ONE
  default, not first-of-month/last-of-month cleverness: that invents precision the operator never gave,
  and a date on an application is a factual claim. `atsDefaultDay` accepts only **1–31** so a typo
  cannot reach a form, an explicit `null` OPTS OUT (nothing filled), and a **year-only** value gets no
  day at all — a day off `"2024"` is two guesses stacked. ⚠ **REQUIRED ONLY:** an optional blank blocks
  nothing (not Save, not the submit gate, and it is not a review item), so an approximation there buys
  nothing and adds an unasked-for claim — the same rule the AI tier obeys. A **stated** day ignores
  required-ness, because a fact has no downside.
- **`currently_enrolled` IS NOT TRUSTWORTHY ALONE — a FUTURE graduation date wins.** The website's
  education editor does not expose that checkbox, so a synced profile carries the schema default
  (`false`) and a student graduating in 2028 was answered **"Yes, graduated"** deterministically and
  unflagged on 2026-08-16. Reading an absent field as a positive assertion was the fault, not the
  matching. `atsIsFutureYearMonth` decides first; the flag is consulted only when the dates say
  nothing. A US state in the entry's `location` also implies the country — which is what fills the
  declared PARENT (Country) in the same pass, ahead of its child (State).
- **THE SEARCH SETTLE POLLS FOR A MATCH, NOT FOR STILLNESS — three attempts, one cause.** Every
  "has the search finished?" proxy is already satisfied by the PRE-SEARCH list: stability accepts it
  (non-zero and stable), and "changed since we opened" accepts it too, because the list is often
  still loading at open time so the baseline is empty. Measured: the school search takes **~4s** to
  return, and a 675ms give-up reported `no option matched "Carnegie Mellon University" (after
  searching)` while typing the same text by hand returns it first. Now: match on EVERY read, stop at
  the first hit, `"No Results"` is the widget's own terminal no, ~8s budget. **Check "awaiting
  parent" BEFORE searching** — searching replaces the widget's "Please select a country" row, which
  destroys the evidence and misreports the cause.
- **The address block is a REPEATING section** (`a.iCIMS_Anchor` "Add More (Addresses)"), and every
  field carries an entry ordinal: `-1_PersonProfileFields.AddressCity`. `atsMapKey` strips a leading
  `<digits>_` **for iCIMS only** before the static-map lookup, so the map is keyed on the bare platform
  id. Keying by id is safe here precisely because `PersonProfileFields.Address*` is iCIMS' own
  vocabulary for the CANDIDATE's address — a work-history employer address is a per-customer
  `rcf<NNNN>` group and cannot collide. **The candidate's PHONE is the same shape and the same rule**
  (`PersonProfileFields.PhoneNumber` / `.PhoneType` / `.PhoneExtension` / `.PhoneCountry`) — ⚠ both were
  UNMAPPED until 2026-08-17, and because their labels are only "Number" and "Type" they fell through the
  label ladder to the AI, which answered the required "Number" with **`24615` — the job's requisition
  id** (flagged `ai-text`, so the gate held, but it recurred every run). *A required platform field
  whose label is a bare noun is the shape that silently reaches the AI.*
- **A REPEATED entry of a single-value field is DETECTED, NOT DECLARED (operator, 2026-08-17).** The
  static map is keyed on the ordinal-STRIPPED id, so a second rendered address/phone row would be handed
  a DUPLICATE of the first. Nothing names which blocks repeat — iCIMS is configured per customer, so a
  family list (`Address*`, `Phone*`) would make the next portal a code change. Instead
  `atsAssignEntryIndexes` asks what the page can answer: **has this exact BARE id already appeared under
  a different ordinal?** `repeatIndex` is the position of the field's own ordinal in that id's first-seen
  ordinal list — so index 0 is the entry the map fills, a form with one row produces 0 for everything and
  the rule never fires, and a tenant that repeats something we have never seen is covered for free.
  Ordinals are POSITIONS, never values (`-1` is the default entry; a saved one carries an opaque server
  id). Fields already claimed by a SECTION are excluded — those repeat legitimately from a profile ARRAY
  (`rcf3271` "Employer Phone Number" at -1/-2/-3 is three real jobs, not one value three times).
  A repeat is left **BLANK with a note**: the profile holds one phone, so a copy is a fabricated second
  number and the AI's would be a guessed one, and the extra entry is optional so blank blocks nothing.
- **⚠ THE SUBMIT RUN MUST GROW REPEATING ENTRIES FROM THE *BUNDLE*, NOT THE PROFILE (2026-08-17).** A
  replay passes `profile: {}` by design (every value comes from the approved bundle), so the
  entry-growing pass counted 0 rows and the form kept the ONE entry it renders. Live that was **28 of a
  rehearsal's 32 verify failures** — every field of work-history entries 2 and 3 reported *"approved
  value has NO matching field on the live form"*, and a multi-entry history could not be replayed at
  all. `runAtsSubmitRun` counts entries from the bundle (BOTH shapes: `canonical_field`'s
  `experience[2]…` and the `entry_section`/`entry_index` a per-customer field carries) and passes
  `opts.entryCounts`.
- **⚠ INDEX 0 IS NOT "UNSELECTED" — a `<select>` need not have a placeholder (2026-08-17).** Both select
  readers used `selectedIndex > 0`, so iCIMS' salary Currency and Time Frame (raw options start at
  `"USD $"` / `"Hr."`, no blank first row) read a legitimately-chosen FIRST option as blank — a
  rehearsal reported `native select commit failed` on two fields whose values were on the form the whole
  time. **A false negative on a verify gate blocks a submit that should pass.** "Unselected" is: nothing
  selected, or the selected row is a PLACEHOLDER. LOCKSTEP in `atsInjScan` + `atsInjReadValue` (two
  injected fns cannot share code) — pinned by a test that strips comments first, because both functions
  now *document* the old shape in prose and a naive grep matches the explanation.
- **A MULTI-ANSWER value arrives JOINED, and the replay must split it.** `current_value` for a
  checkbox group / native multi-select is the display string (`"Internship; Part-time"`), so passing it
  through as one candidate asks the form for an option by that whole name. Split with
  `atsLib.splitGroupValue` — the same vocabulary the fill joined it with.
- **`atsInjSubmitState` needs its iCIMS branch**: the control is `<input type="submit"
  id="cp_form_submit_i" value="Submit Profile">`, and the generic finder queries only `button`s and
  matches `textContent`, which an `<input>` lacks. Measured: without it `hasSubmit:false` and
  `atsLooksLikeApplicationForm` REFUSES a perfectly good form.
- **A RUN STARTS FROM AN EMPLOYER-HOSTED PORTAL, AND ITS LOGIN PAGE LOOKS LIKE A FORM (2026-08-16).**
  `careers.astrion.us` is an iCIMS portal on the EMPLOYER's domain, so `detectAts` (**URL-only** — see
  the Oracle note below for why that is the real rule, not "host-only") returns null. Detection is by PAGE EVIDENCE — `atsPortalAts` reads the hosts the
  page itself references and refuses when two ATSs are named. ⚠ Then the Apply link lands on
  `/jobs/<id>/login`, whose email box + submit control **PASS `atsLooksLikeApplicationForm`** — so
  `runIcimsPreForm` runs BEFORE the form wait, never as a fallback after it. Reaching the gate and calling
  it "the form" would type profile data into a login box. `icimsAuthView`'s control bound is what separates
  them, and it is unit-pinned in the direction that bites: **the application form carries its OWN
  Login/Password block, so a password box is NOT evidence of a sign-in page.** The stage carries
  `runCdpOnboard`'s invariants verbatim (credentials only from storage and written through
  `atsInjSetCredential`, so the password cannot reach a log line; SSO refused on URL evidence ONLY;
  federated and account-creation controls REPORTED, never pressed; every stop `needs_operator`; it stops at
  the form and submits nothing) and runs on the SUBMIT path too, which meets the same gate on a fresh tab.
  `login.icims.com` is the **RECRUITER** login and needs its own refusal — it is an `icims.com` host, so
  the SSO test exempts it. Settle before scanning: the frame mounts after the document, and that race is
  **VISIBLE-ONLY** (a hidden run is slow enough to miss it, so "it worked in the background" is not
  evidence). The flaky Apply control is retried against the page's own IDENTITY (`atsSignatureChanged`
  over top **and** frame — a postback changes only the frame), never a click count.
- **⚠ THE SIGN-IN GATE IS INVISIBLE hCAPTCHA, AND OUR OWN TIMER POLYFILL BREAKS IT (2026-08-16).** The
  gate's submit is `preventDefault`-ed and only proceeds on `hcaptcha.execute`'s callback; measured,
  hCaptcha **never initialises** under the blob-worker timer polyfill (`captchaFrames 0` under a run vs a
  rendered iframe by hand). Isolated to the WORKER alone, not the CSP bypass, so iCIMS runs pass
  `{noWorkerTimers:true}` to `cdpInstallPageOverrides` and accept `hidden-SLOW` pacing. **Measured A/B
  2026-08-17: hidden 37.2s vs visible 16.6s (2.24×), and the whole gap is per-field PAGE CONTACT (26.5s
  vs 6.5s), NOT SW drift** (~1.1s — and the VISIBLE run's overrun was worse, so Workday's
  drift-dominates conclusion does not transfer here). ⛔ **DO NOT close that gap by giving the FORM the
  polyfill: the form carries its OWN captcha** (2 hcaptcha frames + an `h-captcha-response` input), so
  Submit Profile is captcha-gated exactly like the gate and the failure mode is silent. **The gap is
  closed the OTHER way instead: `cdpSetFastWhenHidden(true)`** — a scoped per-run opt-in (reset at every
  attach, so it cannot leak to Workday) that lets `cdpFast()` say yes on a hidden tab because iCIMS'
  reactions are AJAX/DOM, not page-timer driven. Hidden went **37.2s → 15.1s, parity with visible's
  16.6s**, with `needs_review` unchanged and the rehearsal still `0 failure(s)`. ⚠ A DIFFERENT AXIS from
  `cdpSetPageClock`: that chooses WHERE a pace sleeps, this chooses HOW LONG. Safe because it applies the
  SAME `FAST_FACTOR` every visible run uses and every pace site is read-back gated — a short wait costs a
  retry, never a silent wrong fill. Rounds 11–12 of `docs/fill-speed-log.md`.
  **This is NOT captcha handling and must never become it:** it removes OUR tampering so the page's own
  check can run and judge the session — nothing is solved, forged or hidden, and a refusal still halts for
  the operator. The gate also **disables its own button** on submit (`icimsDisableSaveAndSubmitButtons`) and
  only the captcha callback unlocks it, so a stall cannot be retried in place — one bounded reload, then
  `captcha-unanswered`. Diagnose with the pair `submitLocked` (the submit FIRED) + `captchaToken` (the
  captcha RESOLVED); nothing else tells the two apart.
- **AN OPTIONAL DROPDOWN MUST REACH REVIEW AS A REAL PICKER (operator, 2026-08-16).** On these
  one-page forms a field we never filled still has to be ANSWERABLE, and a picker with no usable
  options is just a text box. The lists were already being READ — the gap was that
  `icims_dropdown` was flagged partial **unconditionally** (the flag read a `data-ap-complete`
  attribute nothing ever wrote), and a partial list is attached as `captured_options` +
  widgetType `typeahead`, which review renders as type-it-yourself. A two-option "May We Contact"
  question arrived as FREE TEXT. **The form reveals its own page size when you look at every
  dropdown at once** (`atsIcimsPageCap`): unrelated vocabularies do not stop at the same exact
  length by chance, so N dropdowns all ending at 25 is a pager — and a list SHORTER than a page has
  reached its end. Derived, never hardcoded (the cap is a tenant setting), and a repeated length must
  clear `ATS_ICIMS_CAP_MIN` or ten Yes/No dropdowns "prove" a page size of 2 and nothing is ever
  complete again. ⚠ **The asymmetry is the safety property:** a picker MISSING the operator's answer
  makes them conclude the form doesn't offer it, while a complete list called partial only costs a
  typed value — so every uncertain case stays partial. A **proven-complete scan list also beats a
  search-FILTERED actuation list** (the "the actuation list is better" rule holds only while it is
  fuller). Costs nothing: no page contact, measured same wall clock. Diagnose with the two always-on
  `[ATS-OPTIONS]` lines — *scan-time coverage* (what we knew, printed BEFORE anything actuates, the
  only uncontaminated moment) and *review editors* (what the operator will see); reading one as the
  other is how "16 proven complete" gets mistaken for "16 pickers".
  ⚠ A result's `widgetType` is rewritten to the **REVIEW** vocabulary as the record is built, so
  anything inspecting a RESULT must match `ATS_CHOICE_REVIEW_WIDGETS`, not `ATS_CHOICE_WIDGETS`.
- **⚠ A RUN USUALLY STARTS FROM THE POSTING ITSELF, AND THEN *EVERYTHING* IS IN THE FRAME (live
  2026-08-18).** The Astrion flow — employer portal → Apply → gate → form — is the EXCEPTION. Most
  iCIMS links are `<tenant>.icims.com/jobs/<id>/…/job`, where the job description **and its lone
  `<a>Apply for this job online</a>`** live inside `#icims_content_iframe` and the top document is ~13
  characters of branding. `cdpUseFormFrame` refused to pin that frame because it counts **form
  controls** and a posting page has none, so the pre-form stage read the top document and halted
  `apply-not-followable` on a page whose Apply link works by hand. A control count answers "which frame
  has the form"; it cannot answer "which frame is this tenant's content".
  - `minControls:0` is now reachable but must be **IDENTITY-ANCHORED** (`opts.identifyUrl`, matched
    against the frame's own url, taken from the page's own `<iframe src>` via `atsInjIcimsFrameSrc`) —
    an unanchored 0-floor call would happily pin an analytics iframe and blind the caller in a NEW
    way, silently. An identified frame outranks a fuller one; a 0-floor call with no identity is
    refused. `runIcimsPreForm` tries the ordinary floored call FIRST, so a gate/form page is unchanged.
  - **`cdpEval`'s re-arm reproduces how the pin was obtained** (`_frameArmSpec`) instead of a hardcoded
    floor of 1 — otherwise a postback on a 0-control frame re-armed, failed, dropped the pin back to
    the top document, and the same blindness returned later looking like a different bug.
- **⚠ AN ACCEPT CHECKBOX IS TICKED — STANDING OPERATOR INSTRUCTION (2026-08-18).** Many tenants gate the
  gate: an UNCHECKED `aria-required` privacy box (`#accept_gdpr`), a hidden `#consentCaptureTitle` naming
  it, and a row stating the rule ("You must indicate that you have read the privacy notice … before you
  can continue"). Measured 2 of 5 sampled tenants — ITT (one box) and Peraton (**two**: "I accept the
  Privacy Policy", "I accept the Peraton Job Application Privacy Notice"); Astrion, Cretex and Wieland
  have none. **The operator read those notices themselves and instructed that accept checkboxes be
  ticked, now and in the future** — they are the data subject, the notice governs the processing of
  THEIR data for THEIR application, and declining it means the application cannot be made at all. This
  REPLACED a `consent-required` halt.
  - **Only `atsConsentKind === "accept"`** — assent to a notice/policy/terms/GDPR. An **OPT-IN** (talent
    community, job alerts, "email me about similar jobs") is NEVER ticked: it is not an acceptance, and
    it would sign the operator up for mail they never asked for. An opt-in that merely *mentions*
    privacy still classifies as an opt-in — pinned by test.
  - **A truthfulness ATTESTATION is deliberately excluded** ("I certify the information is accurate",
    "under penalty of perjury"). That is a factual claim by the applicant, not assent to a notice; the
    consequence of a wrong one differs, and the instruction that authorised this was about privacy
    notices. Recognized (`ATS_CONSENT_ATTEST_RE`) only so it is skipped ON PURPOSE. **Do not fold these
    in without asking.**
  - **Cookie/consent BANNERS are out of scope** — unrelated to applying; the onboarding rule below
    (never press an affirmative consent-popup control) is untouched, as is preferring the
    privacy-preserving option on a cookie banner.
  - **Auditable, not silent:** every acceptance is logged BY NAME with the notice's own title
    (`✔ ACCEPTED on your instruction: …`) and carried out on the run result as `consents_accepted`. The
    tick is **verified** — a box that did not end checked halts `consent-not-accepted` rather than being
    reported as consent given, which also keeps iCIMS' `preventDefault`ed submit from resurfacing as
    "the Next control could not be pressed". Kill-switch: `chrome.storage.local.declineConsents = true`
    restores the halt.
  - The scan REPORTS boxes and classifies nothing (`atsInjAuthScan` returns label + row text + markers);
    the judgement lives SW-side in `atsConsentKind`/`atsConsentPlan`, so there is one copy of it rather
    than an injected dup that could drift from what was authorised.
- **SECURITY CLEARANCE — STATED OR NOT ANSWERED (operator, 2026-08-18).**
  `work_authorization.security_clearance` (a dropdown of the US clearances +
  `None` — `SECURITY_CLEARANCE_OPTIONS`, web/lib/profile-fields.ts). A clearance is a FACTUAL claim and
  claiming one you do not hold is serious, so the rung in `atsRouteLabel` answers ONLY from that field.
  - **EMPTY ≠ "None".** Empty = the operator has not told us ⇒ `clearance-unstated`, blank + review.
    "None" = a stated fact ⇒ answers "do you hold an active clearance?" with **No**.
  - **It CLAIMS the question even when it cannot answer it.** That is the point: an unanswered REQUIRED
    clearance question would otherwise reach the AI rescue, whose prompt tells it to infer from ABSENCE
    and never refuse — and an invented "No" for a TS/SCI holder, or an invented "Yes" for someone with
    nothing, is the confident-wrong-value class. Recognition is what keeps the AI away from it.
  - **ONE tiered candidate list serves both shapes** (a level dropdown and a yes/no), because the ladder
    only ever commits an exact or leading-polarity hit. Aliases are strictly SIDEWAYS
    (`atsClearanceAliases`): a Secret must never offer Top Secret, an interim grade never the full one.
  - **BAILS on willingness/eligibility** ("willing to obtain", "eligible to obtain", "sponsor a
    clearance") — those ask about the FUTURE and a held level answers them wrongly in both directions.
  - **BOTH ENGINES, ONE DEFINITION.** The recognizer, the future-tense bail and the candidate ladder live
    in **lib.js** (`recognizeClearanceQuestion` / `clearanceCandidates` / `clearanceAliases`), reached as
    `atsLib.*` from ats.js and `apMatch.*` from fill-driver.js — a second copy could drift from the one
    the operator authorised. ⚠ Both hand-written SW literals need the names (the `atsLib` literal in
    ats.js **and** the `apMatch` literal in fill-driver.js); `test/sw-globals.test.js` caught exactly that
    omission before a live run did.
  - **⚠ ON WORKDAY, FOUR PATHS WOULD OTHERWISE GUESS IT — all four are now closed**, and three of them are
    invisible from the deterministic rung:
    1. the **AI batch** — `deterministicTierFor` returns `"clearance"`, so the question never enters the
       batch (the planner skips any field a tier owns);
    2. the **AI infer** pass — a flagged `needs_review` is not `producedNothing`, so it is skipped;
    3. the **required-radio / checkbox-group rescues** — these exist to *guess to reach review*, and
       `record.resolved == null` does NOT exclude a clearance (that gate catches a decision we made and
       failed to commit; here the rung deliberately made none, which looks identical to "unmapped").
       Caught by a test whose fixture handed the model a willing "No";
    4. the **final required-dropdown backstop** (`forceRequiredDropdownPick`) — the one deliberate
       exception to "a required dropdown never ends a page blank". For a phone type that trade is right;
       for a clearance, whatever it picked is a false statement in one direction or the other, so the
       field ends BLANK, the walk may halt, and the detail says `last-resort pick DELIBERATELY SKIPPED`.
    Plus **AI-4 remediation may not refill it** — the most tempting path of all, since the page has just
    refused to save and the error names the empty field. The halt is the intended outcome; the fix is one
    profile edit.
- **A JD-scraped COMPANY can be a PAGE TITLE, and that string is safety-critical.** On an employer page
  there is no ATS markup to key on, so the scrape returned the document title as the company — the anchor
  for "have you worked for us before?". `atsPlausibleCompany` is a NEGATIVE test; what it rejects falls back
  to the iCIMS tenant subdomain (evidence), what it cannot judge is KEPT (so GH/Lever/Ashby are unchanged).
- **THE RÉSUMÉ GOES ON FIRST, AND ITS PARSE IS WAITED OUT — ORDER IS THE WHOLE FIX (operator,
  2026-08-17).** iCIMS parses the upload SERVER-SIDE and posts the result back into the panel seconds
  later, re-rendering entries under new ids and blanking what was written ("Existing data in the form
  will be replaced" — the form's own words). As an ordinary field mid-fill it therefore destroys the fill
  it is meant to help, which is why it was `kind:"skip"` from 2026-08-16. `atsIcimsResumeStage` attaches
  it after the form settles and **before a single value is written**, then waits; the parse can only
  overwrite an empty form, and everything filled afterwards lands on top of whatever it produced.
  - **The wait is NOT a timer** (the standing pacing rule) — two polled conditions, both required: the
    form's own IDENTITY changed (`atsFormSignature` = field SET + which fields hold a value; a
    field-COUNT settle cannot see a re-render that keeps the count), **and then** the panel goes QUIET
    (the mutation-stamp watch — the only probe here that can say "the DOM is mid-reaction"). A parse
    that changed NOTHING is indistinguishable from one that has not started, so that branch still spends
    its whole change budget and requires quiet+stable before filling. Being slow costs latency; being
    early costs the entire fill.
  - **The fill loop NEVER attaches on iCIMS** — it records the stage's outcome. A second upload is a
    second parse, and that one lands *during* the fill (on a submit run, over approved values).
    A form already carrying a file is left alone, which is what makes the cascade re-replay safe.
  - **BOTH VISITS ATTACH — fill and rehearsal/submit.** The parse re-renders repeating entries under new
    ids, so a bundle captured from an UNPARSED form replayed against a PARSED one reports every entry
    field as *"approved value has NO matching field on the live form"* (the shape that produced 28 of a
    rehearsal's 32 verify failures when entry counts disagreed). A résumé is also a FILE: the bundle
    never carries bytes, so it comes from IndexedDB on each visit — like credentials, never from the
    bundle. A **required** résumé that did not attach **blocks the submit gate** (`resume-not-attached`):
    the strict verify only re-checks approved VALUES, so nothing else downstream would notice.
  - **`filled` needs EVIDENCE the file landed, not just that we wrote `input.files`** (a page-side write;
    iCIMS uploads on the change event). Either the widget confirmed it (filename read back) **or** the
    server reacted (a postback — only an accepted upload causes one). Neither ⇒ `filled_review` +
    `resume-unconfirmed`; a parse still churning at the ceiling ⇒ `resume-parse-unsettled`.
  - The form's own "Upload Resume at a later time" box is still left UNTICKED — the operator's choice.
  - **⚠ AND THE PARSE MAKES ENTRY IDS PER-VISIT, SO A SUBMIT KEY MUST BE A POSITION (live 2026-08-18).**
    `atsDurableFieldName` sufficed while iCIMS numbered repeating entries POSITIONALLY (`-1_`, `-2_`,
    `-3_` — an ordinal *is* a position, and the same form serves the same ordinals every visit). The
    parse SAVES the entries it extracts, so they return as server rows with opaque ids and each visit
    mints its own: measured, a fill wrote its bundle under `-8455804/5/6_` and the rehearsal's form
    served `-8459967/8/9_`, so **all 45 Experience fields** reported *"approved value has NO matching
    field on the live form"* and the gate refused a submit whose values were all present.
    `atsSubmitKey` keys a section entry as `@experience[0]/<bare id>` from the `entryIndex` /
    `entrySection` stamp (bundle: `entry_section` / `entry_index`) — the pair `entryCounts` already
    reads. **Not a new trust assumption:** ordinal matching was already positional, so only the SOURCE
    of the position changed. Anything without a section stamp keeps the old key byte-for-byte (every
    page-level field, and the candidate's own address/phone block, which the parse leaves at `-1_` —
    live, not one of the 45 failures was `PersonProfileFields.Address*`/`Phone*`), so GH/Lever/Ashby
    are untouched. It accepts BOTH shapes (live camelCase, bundle/record snake_case) because the two
    sides keying differently IS the bug.
- **A CONTACT OPT-IN ASKED AS A QUESTION IS STILL AN OPT-IN (operator, 2026-08-18).** Ticking ACCEPT
  boxes is authorised and opt-ins are NOT — but that rule lived only on the checkbox path, so the same
  question asked as a required Yes/No **dropdown** went to the AI, which answered "Yes" and subscribed
  the operator to texts (live on SCS Engineers **and** Sargent & Lundy: *"Do you consent to receive text
  message communication…?"*). One policy, two widgets: answered **"No" deterministically**, flagged so
  someone who does want texts can flip it. ⚠ **The bail list is the load-bearing half** — a "No" to a
  background check, a drug screening, a reference check or the privacy notice **SINKS the application**,
  and none of those is a marketing opt-in, so the rung fires only on contact/marketing wordings and
  refuses anything naming a check or the data-processing notice. Pinned in BOTH directions.
- **WILLINGNESS TO RELOCATE IS IN THE PROFILE, AND NEITHER ENGINE READ IT (live 2026-08-18).** Sargent &
  Lundy's required relocation dropdown was answered by the AI *while its reasoning cited the field*
  (`screening.willing_to_relocate is explicitly set to true in profile`) — so an operator who stated
  their preference got it back as a flagged guess to re-approve. Now `recognizeRelocationQuestion` /
  `relocationCandidates` in lib.js, wired into **both** engines like clearance. Two facts stay APART
  (`willing_to_relocate` = would you move at all; `willing_to_relocate_at_own_cost` = would you move
  unpaid) because answering either from the other is a wrong answer, not an approximation. Two wordings
  are REFUSED: the past ("have you relocated before?") and what the EMPLOYER must provide ("do you
  require relocation assistance?") — the latter looks answerable by negating own-cost, but it is a
  question about a NEGOTIATION. ⚠ **Unlike clearance this rung does NOT claim what it cannot answer** —
  a clearance is a legal status where an invented answer is a false statement; a relocation preference
  is an ordinary flagged guess, and blocking Save over an unstated preference costs a walk to save
  nothing.
- **"MAY WE CONTACT THIS EMPLOYER?" — THREE ANSWERS, AND UNANSWERED IS CLAIMED (operator, 2026-08-18).**
  `may_contact` is per work-experience entry and is now **yes / no / yes_if_required** (a profile
  dropdown; the schema MIGRATES the tri-bool it replaced, `true` → `"yes"`, because a failed parse here
  silently empties the WHOLE profile). Each answer is a **tiered ladder**, so the form's vocabulary
  decides: the conditional one ends with a bare "Yes", so a form offering *"Yes, if required"* takes that
  and a plain Yes/No form takes "Yes" — the truthful projection onto the options that exist. Unflagged,
  like every tiered profile ladder. A conditional yes also **RELEASES** the employer email/phone (it
  permits contact, and those fields are the mechanism); "no" and unanswered still withhold.
  ⚠ **An UNANSWERED one is CLAIMED, not passed on.** The resolver already refused to default it
  ("not a default anyone should own") and then returned null — which makes it an ordinary
  `entry-unanswered` field, and those go to the AI **by design**, whose prompt infers from ABSENCE and
  never refuses. Measured on Cretex, all three work-history rows: `ai-choice · "Yes" ·
  reasoning-from-absence`. **The refusal was being overridden one rung later.** Same remedy as the
  clearance rung and the credential tier: claiming is what keeps the AI away, so it is claimed even
  though we cannot answer it. A "Yes" nobody gave could tip off an employer the operator has not told
  they are looking, and that is not recoverable from a review page afterwards.
- **⚠ THE PARSE-SETTLE HEARTBEAT MUST BE A CHEAP READ, OR IT BECOMES THE WAIT (live 2026-08-18).** Asked
  why the fill starts so long after the résumé upload: on Cretex the parse landed at **6.0s** and the
  stage finished at **15.4s** — the 8.6s between was **OURS**, proving the form had gone quiet.
  `atsIcimsAwaitParse` called `atsInjScan` once per tick, and that is a 479-line full read (labels,
  every option list, every `icims_dropdown`'s results `<ul>`, the section walk, the ordinals, then 68
  field objects back over CDP) — so a "900ms poll" really cost **~2.9s** and the three stable reads took
  ~8.6s instead of ~2.8s. `atsInjLeanSignature` reads only each control's NAME + whether it HOLDS a
  value and returns the finished STRING (10 reads, **704ms total**; stage 15.4s → 12.7s).
  Plumbing is skipped — a rotating anti-forgery token in a hidden input would mean the form NEVER looks
  stable — and a `<select>` is judged by its **value**, never `selectedIndex > 0`.
  ⚠ **BOTH SIDES OF THE COMPARISON MUST BE COMPUTED THE SAME WAY**, so the caller no longer passes a
  full-scan baseline: mixed vocabularies differ on tick ONE, the loop reads that as "the parse changed
  the form", and a **false `changed` lets it finish on the first brief quiet — possibly before the parse
  has started**, which is the one failure this stage exists to prevent. `quietMs` 1500 → **2500**,
  deliberately spending ~1s of what the probe saved: **polling faster makes a STABILITY predicate
  weaker, not stronger**, so the binding evidence must be the quiet watch's wall-clock idle time.
- **Map only PLATFORM ids** (`PersonProfileFields.*` etc.). `rcf<NNNN>` are per-customer questions → the
  label ladder. A leading `-1_` is a repeating-entry ordinal whose ids recur inside work history, where
  an "address" is the EMPLOYER's — mapping those by bare id files your home address under a past job.

## Oracle Recruiting Cloud (ORC) — RECON DONE, FILL NOT BUILT (2026-08-19)

Observed DOM, URL shapes and every measurement: `docs/dom-patterns.md` `2026-08-19 — Oracle Recruiting
Cloud (ORC) / Candidate Experience: FIRST RECON`. **Read `docs/adding-a-filler.md` before building the
rest.** What is settled, and what must not be re-litigated:

- **DETECTED, AND DELIBERATELY REFUSED UNTIL THE SCAN EXISTS.** `detectAts` returns `"oracle"` (host +
  path — see the URL-only amendment above), and BOTH `runAtsApplicationRun` and `runAtsSubmitRun` halt
  `oracle-not-implemented` **before the attach**. That guard is not caution for its own sake:
  `atsInjScan` has no `oracle` branch, so an ORC page would reach the GENERIC tail, and because ORC's
  controls are plain `<input>`s that tail would classify them — including the honeypot below. A
  plausible-but-wrong bundle is worse than no bundle. **Delete both guards in the commit that adds the
  scan**, not before.
- **⚠⚠ THERE IS A BOT-DETECTION HONEYPOT AND EVERY VISIBILITY TEST WE OWN PASSES IT.** `#honey-pot-1`
  sits beside the real email box with rect **179×38**, closest-`div` **179×19**, `offsetParent` non-null,
  `display:inline-block`, `visibility:visible`, `opacity:1`. The Greenhouse/Lever predicate
  (`rect.width > 0 && rect.height > 0`) admits it. It is OPTIONAL, so the AI tier never fills it and the
  fill *looks* clean — but it still reaches the **review editor as a fillable box**, and a value typed
  there is replayed on submit and marks the application as a bot. **No read-back catches this: the write
  SUCCEEDS.** Invisible from inside the pipeline, and it lands on the employer's side.
  - `atsDecoyKind` (ats.js, pure, unit-pinned both directions) is the recognizer. The primary signal is
    **generic, not an Oracle name match**: `aria-hidden="true"` **AND** `tabindex="-1"` — a control the
    page hides from assistive tech *and* removes from tab order is not one a human is asked to fill, on
    any platform. **Neither marker alone is enough** (a decorative wrapper legitimately carries
    `aria-hidden`; custom widgets routinely park a focused input out of tab order). The `honey[-_ ]?pot`
    name match is a word-anchored belt.
  - ⛔ **DO NOT "fix" this by tightening the visibility test** — the Workday dropdown-chip dead end
    (tried twice, confirmed): the element is genuinely visible by every computed-style measure.
    Exclusion must key on **declared intent**, never on geometry.
  - **The scan REPORTS the markers; the judgement stays SW-side**, like `atsInjAuthScan` /
    `atsConsentKind` — one copy of a rule this consequential, not an injected dup that can drift.
  - **Polarity trap, same page:** the terms checkbox is **0×0**, `opacity:0`, clipped — and it MUST be
    ticked (click its `<label>`, the Workday radio rule verbatim). Non-zero rect ⇒ never touch;
    zero rect ⇒ click the label. **Geometry answers neither question.**
- **PAGE-SIDE SYNTHETIC, and that is MEASURED not assumed.** The form path is not JET components but
  native `<input>`s carrying a Knockout `data-bind`. A native-setter write with **no events** left
  `aria-invalid` at `false` (Knockout did not notice); adding `input` + `change` flipped it to `true`.
  Same lesson as React for a different reason — `el.value = x` alone is still not enough. ⚠ `valueUpdate`
  is **per-element and dynamic** (`element.valueUpdateType()`), so always dispatch BOTH events rather
  than detecting which one is bound. ⚠ JET components DO exist (`oj-text-area`, `oj-dialog`) — so far
  only in dialogs and the AI assistant. An `oj-select-single` binds its value as an element **property**,
  not through an inner input, so if the form uses them that is a separate widget class with its own
  commit path and read-back.
- **THE APPLY URL IS NOT DERIVABLE — the button is a required STAGE.** `…/job/<id>/apply` **redirects to
  `…/sites/<site>/404`**; only pressing `button.apply-now-button` pushes `…/job/<id>/apply/email`. So
  `atsFormUrl` returns the POSTING url unchanged for `oracle`, and that is the correct answer, not an
  oversight — **do not append a path**. ORC therefore needs an Apply-click pre-form stage like iCIMS'.
- **AUTH: the Workday pattern, per operator instruction (2026-08-19)** — sign in with the **stored
  credentials** and let **Gmail auto-verify** approve the emailed code. Two shapes exist: the quick
  `<quick-email-verification-form>` gate (email + terms → code; *"You don't need to have an account"*, so
  **no password and no account creation**) and a full account sign-in. Either way the value comes ONLY
  from `store.credentials` via `atsInjSetCredential` (returns a LENGTH, never a value) — never a profile
  value, never a bucket, never an LLM — and it never enters a log line, a record or the bundle. The
  terms box is an **ACCEPT** checkbox under the 2026-08-18 instruction ⇒ ticked, logged by name, verified.
- **THE COMPANY ANCHOR IS EVIDENCE, NOT A URL HEURISTIC.** `atsCompanyFromUrl` returns **null** for
  oracle on purpose: the subdomain is an opaque Fusion **pod id** (`eeho`, `fa-evmr-saasfaprod1`) and
  path segment 0 is the literal `hcmUI` — either would hand the safety-critical employment recognizer a
  word no employer is called, the exact failure iCIMS' `jobs` segment produced. Null is safe here *only*
  because ORC supplies the real name structurally: JSON-LD **`hiringOrganization.name`**, plus its own CX
  REST requisition endpoint (`recruitingCEJobRequisitionDetails`, **200 unauthenticated**). With no
  plausible fallback, an absent company correctly makes the recognizer UNEVALUABLE (blank + review).
- **`siteCode` IS A TENANT SETTING** — `CX_1`, `CX`, `CX_1001`, `CX_1003`, `nfcu`, `LateralHiring`.
  Nothing may key on the literal `CX_1`. Three host shapes, and `jpmc.fa.oraclecloud.com` has **no region
  segment**. A vanity domain CNAME'd to ORC is deliberately unmatched — that is the page-evidence case.
- **SCOPE THE SCAN TO THE APPLY-FLOW CONTAINER.** `oj-text-area#oda-work-summary-text-area` (the Oracle
  Digital Assistant's box) carries `required="true"` and is **not an application field** — a
  document-wide sweep for required controls picks it up, and a required unmapped textarea is exactly the
  shape that buys an LLM call. Same discipline as scoping a Workday dropdown scrape to its own listbox.
- **No iframe** (JET SPA in the top document), so no `cdpUseFormFrame`. But `<session-expire>` means ORC
  has an idle timeout, so the Workday rule holds: **session death is behavioural, not statically
  detectable**. And the JD scrape's largest-text-block fallback is a **contest** on an SPA that is mostly
  bundled JS — the shape that made a session token a job description on iCIMS. Prefer JSON-LD → REST →
  rendered text, and keep `redactSecrets` on the assignment.

### Through the gate — the form's shape (recon 2, 2026-08-19; Baylor + Nokia)

- **⚠ ONCE THE CANDIDATE EXISTS, THE CODE IS REQUIRED ON *EVERY* RE-ENTRY — so Gmail auto-verify is on the
  critical path for every run, fill included (operator, 2026-08-19).** This took three passes to get right
  and the wrong versions were each load-bearing, so the whole ladder is recorded:
  - recon 2 saw a **brand-new** email go `Next` → straight to `…/apply/section/1` and concluded "no code is
    ever needed". Wrong, from one observation of a conditional branch.
  - recon 4 saw a **known** email hit **"Confirm Your Identity"** and concluded "conditional on whether the
    email is known". Closer, but it framed the code as the exception.
  - the operator's own experience settles it: *"you need to approve each time you reopen the application."*
    So: **no candidate account yet ⇒ no code; the account exists ⇒ a code on every entry.** Both earlier
    observations fit that, and the common case in production is the coded one.
  The screen: six digit boxes (`input#pin-code-1…6`, `type=number`, **no `name`**, Knockout-bound,
  `aria-label="Enter verification code digit N of six."`), a `Verify` button, `<resend-pin>` / "Send New
  Code". Route `…/apply/pin` on some tenants, still `…/apply/email` on others — so **recognize the view by
  its CONTENT, never by route or message text** (Baylor names the address, Oracle's own site says only "sent
  to you").
- **⚠⚠ THE APPLY-FLOW SESSION IS PER-TAB, NOT A COOKIE (measured 2026-08-19).** A fresh tab in the SAME
  Chrome profile, with `ORA_CX_USERID` / `ORA_CX_SITE_NUMBER` cookies present, still bounces
  `…/apply/section<n>` → `…/apply/pin`. The verified flow state lives in **`sessionStorage`**, which is
  per-tab. Two consequences, both structural: **a run must clear the gate in the SAME TAB it then fills**
  and can never borrow a session another tab established (including the operator's own signed-in tab); and
  **the flow is not resumable cold** — a deep link from a new tab is not an entry point.
  ⚠ The terms checkbox is **per-tenant optional** (Nokia has one, Baylor none) — tick it when present, never
  require it. The honeypot's WIDTH also varies by tenant (179 vs 200), so no size constant may ever enter the
  test.
- **⚠ TWO SCANNING HAZARDS MEASURED ON THIS PAGE.** `document.querySelector("h1,h2")` returned **"Are You
  Still With Us?"** — the hidden `<session-expire>` dialog's heading, not the visible "Confirm Your Identity".
  A first-match query reaches a hidden dialog, so headings need the same visibility scoping the fields do.
  And `Runtime.evaluate` **blocked past 45s on six separate occasions**, always around a route transition —
  so ORC needs generous CDP timeouts and its waits must never rely on page timers (they were not firing).
- **⚠⚠ THE ACTIVE-SECTION SIGNAL IS THE EXACT INVERSE OF THE HONEYPOT SIGNAL — neither may become *the*
  rule.** The form is a **4-step wizard** (`…/apply/section/<n>`) and **all four steps sit in the DOM at
  once**. Measured on the inactive ones while on step 1: `hidden` = false, **`aria-hidden` = `"false"`**,
  `display` = `block` — every declared signal says they are live — and only the **bounding rect** is 0×0.
  > On the **GATE**, geometry lies and declared intent tells the truth (the honeypot is 179×38 yet
  > `aria-hidden="true"`). On the **FORM**, declared intent lies and geometry tells the truth. Each signal
  > is authoritative precisely where the other fails.
  **So: never scan the document. Scope to the active section**, keyed primarily off the URL's section number
  (`apply-flow-section[n]` — index 0 is an empty shell, so it lines up), with geometry as the cross-check.
  A document-wide scan on step 1 returns all 39 fields of all four steps.
- **⚠⚠ `name` IS THE DURABLE KEY; `id` CARRIES A VOLATILE COUNTER.** Every control is `id="<name>-<N>"` with
  N a render-**assignment** counter (`country-19` numbers below `email-27` while appearing after it). Key
  bundles on `name`; treat `id` as an in-visit DOM address only. Same lesson as iCIMS' per-visit entry ids
  reached by another route, and the same consequence: an `id`-keyed bundle fails every field on the submit
  visit. ⚠ `label[for=…]` and `aria-controls` both point at the volatile id, so resolve both **live** —
  never reconstruct them from a remembered value.
- **Three id families, one mappable.** Platform names (`firstName`, `lastName`, `knownAs`, `email`,
  `country`, `addressLine1/2`, `postalCode`, `city`, `region1/2`, `title`, `fullName`) → the static map.
  Per-tenant flexfields (`300000016979265`, `namInformation15`) → **label ladder only**. Standard self-ID
  (`US-STANDARD-ORA_GENDER-STANDARD`, `…ORA_VETERAN_STATUS…`, `…ORA_DISABILITY_STATUS…`, radios suffixed
  `-ORA_PER_Y`/`-ORA_PER_N`) → mappable, and must obey the EEO rules. `dq-option-<id>` are ORC's
  **disqualification** (screening) checkboxes — ⚠ some carry a bare small integer, so a `dq-option-*` key is
  not automatically durable.
- **⚠⚠ `name="phoneNumber"` IS THE DIAL-CODE PICKER, NOT THE NUMBER.** The number input has **no id and no
  name** — only `aria-label="Phone Number"` + `class="phone-row__input"` — so a name-keyed scan maps the
  number onto the country-code combobox and leaves the real field unkeyed. Address it by class/aria-label.
- **⚠ THREE FILE INPUTS SHARE `name="attachment-upload"`**, told apart ONLY by their wrapper
  (`<resume-upload-button>` / `<cover-letter-upload-button>` / `<attachment-upload-button>`). So `name` is
  **not unique** on an ORC form, and résumé-vs-cover-letter is a wrapper decision. All three report
  `required` — a widget artifact, not the tenant's rule; do not trust it.
- **The choice widget is `input[role="combobox"].cx-select-input` with `aria-controls="<id>-listbox"`, and
  that aria-controls resolves to the REAL listbox** (unlike Workday's `source`) — so scope every option
  scrape to it, never a page-wide `[role=option]` sweep. `aria-expanded` exists but the close still gates on
  options being **GONE**. Plain text rows are `input.input-row__control` with a Knockout `data-bind`;
  combobox inputs have none.
- **⚠ THE WHOLE ADDRESS BLOCK IS SUGGESTION-DRIVEN.** `addressLine1` (classed `--auto-su`), `postalCode`,
  `city`, `region1` **and** `region2` are all comboboxes; only `addressLine2` is free text. ⚠ **`region1` vs
  `region2` is UNRESOLVED — do not guess**: both required, and which is State/Province vs County almost
  certainly varies by country, so mapping the wrong one files a state as a county. Resolve from the live
  label. ⚠ `country` arrived **prefilled "United States" AND classed `cx-select-input--invalid`** — a value
  present is not a value accepted, so read-back must not treat non-empty as verified.
- **Labels are a proper `label[for]`** (`label.input-row__label` inside `div.input-row`), so the house
  `labelFor` helper is already correct. Required is marked **three** ways — `aria-required`, the label class
  `input-row__label--required`, and a `<span class="input-row__label--required-star">` — detect all.
- **`<form-builder>` is the generic renderer**, which is *why* one scan can be generic: a per-tenant question
  and a platform field are structurally identical. Group a field by its `<apply-flow-block-title>`.
  ⚠ `<address-form-v2>` is **versioned** — expect a v1 on older tenants.
- **⚠ The renderer is heavy enough to break a harness:** `Runtime.evaluate` containing an in-page
  `setTimeout` await **timed out at 45s twice** across the section-1 transition — page timers were not
  firing. Reads must be synchronous with waits taken OUTSIDE the page, and a section transition needs real
  pacing (measure into `fill-speed-log.md` once a fill runs).

### Sections 2–4 and the timeline (recon 3, 2026-08-19)

- **`div.input-row--<kind>` IS THE WIDGET CLASSIFIER** — declared by the framework, so classification is a
  read rather than a guess: `--text` · `--textarea` · `--has-picker` (combobox) · `--radiogroup` (option
  group) · `datepicker-row` (month+year). Sections are also **directly URL-addressable**
  (`…/apply/section/3` loads with step 1 empty — validation does not gate navigation), and exactly one
  `apply-flow-section` has a non-zero rect with its index equal to the URL's number, which confirms the
  URL-keyed scoping rule. A real fill should still press `Next` so the tenant's validation and save fire.
- **⚠⚠ AN OPTION GROUP IS RENDERED TWO WAYS AND ONE HAS NO `name` AT ALL.** Disability self-ID = 3
  `type=radio` sharing a name; Baylor's enrollment question = 3 **`type=checkbox` with `name: null`**; EEO
  race = 6 the same. So **grouping cannot be by `name`** the way every other platform does it — the group is
  `div.input-row--radiogroup`. ⚠ **And the question text is not any option's label**: each box's `label[for]`
  is its own OPTION text, so the question must be read from the group. Using a member's label as the field
  label files every option as a separate question — the Gusto 12-phantom-field failure in a new costume.
  ⚠ **`radiogroup` does NOT imply pick-one** — EEO race is legitimately multi-select inside one. The class
  names the widget family, not the arity; treat arity as unresolved rather than inferring it.
- **⚠⚠ A DATE IS TWO COMBOBOXES SHARING ONE `name`, month + year, NO DAY.** `month-startDate-34` and
  `year-startDate-34` both carry `name="startDate"`, so the **`month-`/`year-` id prefix is the only
  discriminator** — a name identifies the *pair*, not a control (same shape as the phone composite). **No day
  means iCIMS' `atsDefaultDay` approximation must NOT be applied here** — the profile's month precision is
  exactly right.
- **⚠ EVERY TEXTAREA ROW HOLDS TWO TEXTAREAS** — the named one plus a clone with **empty id and empty name**,
  both visible by rect. Push only the named one. Untreated this is the Greenhouse double-push again, and here
  the phantom is a *textarea*, the shape that becomes a required free-text field and buys an LLM call.
- **§3 is a repeating timeline**: `<beautiful-timeline>` with `button.work-and-education-timeline-add-button`
  (`.timeline-work-add-button` / `.timeline-education-add-button`), opening `<timeline-form-inline>` →
  `<timeline-form-builder>` (⚠ a *different* renderer from the page-level `<form-builder>`). Experience
  fields: `employerName` (req) · `jobTitle` · `startDate` · `endDate` · `countryCode` · `employerCity` ·
  `responsibilities` · `leavingReason`. ⚠ `countryCode` is the **EMPLOYER's** country — the iCIMS entry seal
  applies verbatim. The date fields carry **no label**, so they are identifiable only structurally.
- **⚠⚠ TWO TIMELINE TRAPS, EITHER OF WHICH DESTROYS AN ENTRY SILENTLY.** (1) **The commit button has the SAME
  TEXT as the opener** (`Add Experience` both outside and inside the form) — disambiguate by container:
  inside `timeline-form-inline` ⇒ commit, outside ⇒ open. (2) **Clicking outside the entry box DISCARDS it**,
  and the tenant says so itself (*"Do not click outside the white box until you have submitted your
  information"*). That collides directly with portaled combobox options — the entry form holds **four**
  comboboxes, and if an option list mounts outside the white box then selecting an option *is* a click
  outside. With the Workday findings that portaled lists share coordinates and linger while unmounting, the
  failure is an entry that vanishes while every commit reports success. **Check where the option list mounts
  relative to `timeline-form-inline` BEFORE writing the entry handler**, and re-read the whole entry after
  each commit rather than trusting one field's read-back.
- **§2** = per-tenant screening questions (`300000…` comboboxes + a checkbox group), three file inputs
  (Résumé / Cover Letter / references Attachment — distinguished by **label AND wrapper**, a useful
  redundancy), and `siteLink-1` whose label is the bare noun **"Link 1"** and whose trailing `-1` is a
  **meaningful entry ordinal**, not a render counter.
- **§4** = `Sex` / `Veteran Status` (comboboxes), disability (3 radios incl. "I do not want to answer"),
  race/ethnicity checkbox groups, and **E-Signature → `fullName`** (required text — the Workday signature-name
  rule applies; no signature date on this tenant). **Every self-ID field here is OPTIONAL**, so the standing
  rule holds: unstated + optional ⇒ **blank, no AI**; stated ⇒ deterministic. ⚠ The disability wording is
  **byte-identical to Workday cat.wd5's**, so `selfIdDisabilityCandidates` + POLARITY LEAD should land it
  with no new matching code — verify rather than assume.
- **⚠⚠ THE DURABLE KEY NEEDS NORMALIZING: A RADIO GROUP'S `name` CARRIES THE VOLATILE COUNTER.** Text and
  combobox names are clean (`lastName`, `US-STANDARD-ORA_GENDER-STANDARD`) but the disability group's is
  `…ORA_DISABILITY_STATUS-STANDARD-12`. So the durable name **strips a trailing `-<digits>`** — the same move
  as iCIMS' `atsMapKey`. ⚠ The exceptions must be pinned before it ships: `siteLink-1` → `siteLink` is
  *desirable* (family + ordinal), `dq-option-4` → `dq-option` is acceptable only because the group is the
  field, and `namInformation15` ends in digits with **no hyphen** and must be left alone. Wrong in either
  direction and the submit visit misses the field.

### The SUBMIT stage — a REPLAY WALKS the wizard (2026-08-20, rehearsal live-verified)

`runAtsSubmitRun` was single-page from the day it was written, because every ATS on this path was.
ORC is the first that is not, and the `oracle-not-implemented` guard is now deleted from BOTH runs.

- **ANY WALK STOP OTHER THAN `reached-final-step` REFUSES THE GATE** (`replay-incomplete`), before the
  verify and before the click. The fill run marks a short walk's bundle PARTIAL; here the consequence
  is a submitted application missing whatever the walk never reached, so it is not interpreted at all.
- **THE ADVANCE IS ONE SHARED FUNCTION** — `orcAdvanceAfterStep` (guard 1, the disabled-Next wait,
  guard 2, the monotone predicate, the settle), called by both walks; `orcAwaitBlocksPopulated` the
  same. A test pins that guard 1 appears **exactly once in the file**. This is the double guard on the
  one irreversible act in the pipeline: a near-duplicate keeps working until the day it stops agreeing
  with the other about what "the last step" is, and the disagreement surfaces as a submitted form.
- **RESULTS ARE UNIONED ACROSS STEPS, then verified ONCE.** The strict verify's "approved value has no
  matching field" check is a set difference over the WHOLE bundle, so a per-step verify would flag
  every other step's fields on every step.
- **THE PRE-FORM RUNS BEFORE THE FORM WAIT** — ORC's gate passes `atsLooksLikeApplicationForm`, so a
  run that waited for "a form" would find the GATE and replay approved values into a login box. And
  because the fill created the candidate, **the emailed code is required on every submit run** —
  Gmail auto-verify is on this path by construction, not as an edge case.
- **A REPLAY *REPORTS* THE REPEATING ENTRIES; IT MUST NEVER REBUILD OR DELETE THEM.** `profile:{}` is
  by design, so the entry plan is empty — correct as an ACTION (ORC saves entries server-side; live,
  the rehearsal found Experience 3 / Education 1 still there) but not as an ANSWER, because the bundle
  carries a record per entry and emitting none fails every one at verify. `reportOnly` reads the tiles
  and records them, so the verify means "the entries you approved are still on the form". ⚠ It must
  not actuate: with `profile:{}` a reconcile reads "wants 0, form has 3" and **deletes the work
  history**. Pinned in both directions.
- **⚠ A CHOICE RECORD MUST STORE THE OPTION THAT WAS CHOSEN, NOT THE WIDGET'S READ-BACK.** `rec.after`
  becomes the bundle's `current_value`, which is what the replay matches against the live options. The
  dial-code picker DISPLAYS `"+1"` while its option reads `"+1 (United States)"`, so the fill recorded
  `"+1"` and the rehearsal correctly REFUSED it — `+1` is the United States **and** Canada, so a bare
  code is a guess between two real countries. The fix is never to loosen the ladder (the ambiguity is
  real) but to record a value that reproduces the decision; the read-back stays the VERIFICATION.
  Safe because `atsSurfacePrefilled` skips any record carrying `resolved`, so nothing re-reads and
  compares the two. *Suspect this shape on any widget whose display differs from its option text.*
- **⚠ SCOPE BITES IN THIS FILE — AND `npm test` NOW CATCHES IT.** Five live failures were code
  written against a scope it did not have (`profile`, `apMatch.cdpPageKey`, `preCreds`, the entry
  pass, and `startUrl` in the submit run's Oracle branch). The unit guards scan source TEXT and
  cannot evaluate a scope, so every one of them passed the suite and cost a live run.
  **`eslint.config.mjs` runs `no-undef` as `pretest`** — it found the fifth in under a second, in
  code that had already passed 1693 tests and a rehearsal. It reads the SW file list from
  background.js's own `importScripts` call and each page's from its HTML, so the "one shared global
  scope" model can never drift from reality; `no-undef` is the ONLY rule on, deliberately.

**Open (submit):** the ex-Oracle screening question fails the replay `read null` after 2 presses over
8s (34.7s on the field) — ORC renders an option group **two ways** (radios sharing a `name`, and
`type=checkbox` with `name: null`), so the yes/no reader likely handles only the first. Needs a live
widget recon, not a guess.

**Open:** whether a combobox accepts a typed value or strictly requires a suggestion; `region1`/`region2`
semantics per country (must not be guessed); **where a combobox's options mount relative to
`timeline-form-inline`** (the discard hazard); whether ids renumber across a section transition; captcha on
submit and `<apply-flow-submission-checklist>` semantics; the Education entry's field set; and a **second
tenant's form** (the gate has two tenants, the form still has one).

## Multi-ATS — Greenhouse / Lever / Ashby (`ats.js`; fill + gated submit, live-verified 2026-07-31)

Routing, the option poll, per-ATS traps, the dev loop and every measured refutation: **`ats-tenants` skill.**
The standing rules:

- These forms are ONE page, login-free and draft-free, so the pipeline is **two visits to a blank form**:
  FILL (profile → form → the SAME review bundle → website) and SUBMIT (approved bundle → re-fill → strict
  verify → the gated click). **A submit run does not "resume" anything** — a field the fill filled but the
  bundle does not carry will be blank on submit.
- **`detectAts(url)` routes `AP_RUN_APPLICATION` / `AP_SUBMIT_APPLICATION`.** Workday and anything
  unrecognized keep the existing onboard→walk path **byte-identical**. All through CDP — **NO new host
  permissions.**
  ⚠ **THE RULE IS URL-ONLY, NOT HOST-ONLY (amended 2026-08-19, operator-approved).** Every family except
  Oracle is identified by host alone, and the property that actually matters is that detection needs **no
  PAGE EVIDENCE** — that is `atsPortalAts`' job, a separate and more expensive decision. Oracle keeps that
  property while breaking the letter: `*.fa.*.oraclecloud.com` is the generic Oracle **Fusion
  Applications** host, which also serves ERP / HCM back-office UIs this pipeline must never drive, and the
  recruiting product's identity lives in the **PATH** (`/hcmUI/CandidateExperience/`). So Oracle tests
  host **and** path — still one URL parse, no fetch, no injection. A host test widened until it matched
  what it cannot verify would be the unsafe direction.
- **Actuation is page-side synthetic via `Runtime.evaluate`** — all three commit state from synthetic events,
  so visible and hidden runs are IDENTICAL: no pacing regime, no focus emulation. The ONE trusted exception is
  the SUBMIT click. Every commit is read-back-verified; AI fills are ALWAYS flagged.
- **⚠ INSTALL THE PAGE OVERRIDES BEFORE THE DOCUMENT EXISTS.** Landing them on an already-running document
  leaves the page half-native/half-ours, after which react-select never resolves again — **and a refresh cures
  it**. A run opens its tab BLANK, attaches, registers overrides, then navigates. *If a widget works by hand
  and not under a run, ask what the run did to the page before the page loaded.*
- **`runAtsSubmitRun` gates** (all must pass before the one trusted click): bundle blockers + STRICT live
  verify + **no VISIBLE captcha challenge** + `arm===true` (absent ⇒ full dry rehearsal logging "WOULD CLICK
  SUBMIT"). **AI is OFF for submit runs regardless of the toggle.** A VISIBLE challenge halts
  `needs_operator` — **the bot never solves or bypasses a captcha.**
- **A CLOSED POSTING IS NOT A BROKEN PIPELINE** — `atsPostingGone` reads Lever's `Not found` title and
  Greenhouse's redirect-to-board-index, and halts `posting-gone` rather than sending the operator to debug a
  fill on a job that no longer exists.
- **AI IS DEFERRED, THEN ASKED ONCE — and the ORDER is the point (2026-08-11).** The deterministic pass runs
  FIRST and to completion; every field it could not answer is RECORDED, then **ONE** `act.llm` call asks
  about exactly those, then a **second actuation pass** fills them. ⚠ **This is the OPPOSITE ORDER to
  Workday's `aiBatch` (fill-driver.js) — do NOT unify them.** Workday fires BEFORE the deterministic pass so
  the two overlap in time, which makes it a speculative CACHE that must PREDICT which fields will fall
  through, paying tokens for every misprediction; here the outcome is already known, so nothing is asked
  about an answered field. *Why it matters more than latency:* rotation advances only on FAILURE, so N calls
  are N requests through ONE key, and free-tier Gemini meters **15 requests/minute per key** — a 7-question
  page spent half of one key's minute. **Safety is unchanged by construction:** the batched answer enters
  through the SAME seam the old prefetch used (`atsAiFallback`'s `prefetched`), so it is still a CANDIDATE
  that must clear the match ladder vs the LIVE options read at commit time, still read-back verified, still
  ALWAYS `filled_review` + flagged — and a batch that fails, parses badly or omits a question leaves that
  field to make its own call, so a batch failure costs LATENCY, never COVERAGE. Answers are cached **by
  QUESTION (`normalizeLabel`), never by automation-id**, so a cascade re-mount reuses the answer already
  paid for and **one page can never hold two different answers to the same question**. A deferred combobox
  is **read then CLOSED** (gated on the option count, not `aria-expanded`) — nothing is committed while the
  call is in flight, so no menu is left open across it. **ONE deferred question is not a batch** and takes
  its own path unchanged. Round 10 of `docs/fill-speed-log.md`.
- **ONE CALL PER KIND, because `action` is per-call (2026-08-12).** `act.llm` resolves ONE `action`, and the
  AI page configures a different model per action — `"fill"` for short picks, `"essay"` for prose. So the
  batch splits: **choice → `fill`, text → `essay`**, fired CONCURRENTLY (no latency cost, and the two may
  resolve to different keys, spreading a page across two per-minute budgets). **"One question is not a
  batch" therefore applies PER KIND** — 5 essays still batch when the page's only pick rides alone.
  ⚠ `atsAiWriteText` passed NO action until this date, so every long answer on GH/Lever/Ashby silently went
  to the operator's yes/no model while the "Fill — essays and long answers" slot sat unused; the Workday
  twin (`aiFillText`) had always routed correctly. Live-verified: `AI batch [text → "essay" route]` next to
  `[LLM] … for "essay"`.

## Onboarding walk (pre-form: JD → apply → login → verify)

SAFETY INVARIANTS (always apply — never lazily loaded): onboarding **NEVER submits an application**; it stops
at the form (`reached_form`) and chains into the fill walk ONLY when `onboardConfig.continueToWalk === true`.
It **never clicks an affirmative consent-popup control**, and it **refuses SSO** (`sso` halt — URL-evidenced
only; field-absence is NOT SSO evidence on a Workday host). Every human-needed stop returns `needs_operator` +
a self-explaining `stopped`/`detail`; `ok:false` means a CRASH only. An ALREADY-APPLIED page is VERIFIED
against the candidate's own application list rather than believed (a started-but-unsubmitted application still
shows it) — and that recovery only ever REACHES a form, never fills or submits.

**A FILL run takes "Autofill with Resume"; a REHEARSE/SUBMIT run does NOT (2026-08-07).** The chooser offers
`autofillWithResume` alongside `applyManually`, and taking it makes Workday PARSE the résumé and pre-populate
the form — which is what seeds the Skills section with its own suggestions. `runCdpOnboard` takes
`preferResumeAutofill`, set true only by `AP_RUN_APPLICATION`; the submit path stays manual/continue so saved
skills survive and the résumé is not re-parsed over them. It changes the PAGE ORDER: a résumé page
(`/apply/autofillWithResume`, ids `file-upload-input-ref` → `file-upload-successful` → Continue) comes BEFORE
My Information, and **onboarding must consume it** — it reports one bare `formField-` wrapper, so `isPastAuth`
otherwise calls it "the form" and the walk writes a junk 1-field bundle page. The parse is a BONUS LAYER,
never a substitute: live it left the whole address, `source` and `candidateIsPreviousWorker` empty, so the
walk still refills the page as if blank.

Mechanism (the auth loop + which-view discrimination, Gmail auto-verify, hidden-tab render budgets, the
wait-predicate rules, the cover-check re-measure, per-tenant traps): **load the `workday-onboarding` skill.**

## A SCRAPED JOB DESCRIPTION IS UNTRUSTED TEXT, AND IT LEAKS THREE WAYS (2026-08-16)

`jobContext.description` is not just display data. One string reaches **Supabase** (the tracker row,
at rest), **every AI prompt it grounds** (sent to the model provider verbatim), and **the run's log
lines** — so anything secret inside it leaks three times over, and fixing only the report boundary
fixes one third of the problem.

- **⚠ `textContent` INCLUDES `<script>` SOURCE.** `scrapeJobPosting`'s reader is
  `innerText || textContent`, and its last-resort "largest text block on the page" loop is a
  CONTEST — so on a server-rendered portal whose page is mostly bootstrap JS, the winner is the JS
  (`innerText` of a script-wrapping div is empty, so every candidate fell through). Live on iCIMS
  that stored 3009 chars of `icims_handlePostMessage` as the description, carrying the **one-time
  magic-link session token** (`?from=login&eem=…&code=…`). That loop reads **rendered text only**;
  the hidden-tab case the fallback existed for is paid ONCE, on the body, with script/style
  subtracted. A `<script>` is never a job description.
- **`redactSecrets` (lib.js, pure) is the belt**, applied where `description` is ASSIGNED (both the
  ATS and Workday paths) **and** at `reportApplication`, the single choke point to the tracker. It
  rewrites credential-shaped URL params to `key=<redacted>` — **keeping the KEY**, so a leak stays
  diagnosable while carrying nothing usable. Anchored on a URL separator (`? & ; #` — `#` because an
  OAuth token lives in the FRAGMENT) so prose like "use code=ALPHA" is untouched: a JD is prose, and
  over-redacting corrupts what the operator reads and the model is grounded on. 6-char floor keeps
  `?code=US`. ⚠ Called as a **bare global** from background.js — never through the `apMatch` literal.
- **Remediation for data already written:** `web/scripts/scrub-job-description-secrets.mjs` — imports
  the same helper, dry-runs by default, idempotent, and never prints a token (key names + counts
  only). Re-run it after any new leak class is found.

## Job discovery (find work → the website queue; reads only, NEVER applies)

SAFETY INVARIANTS (always apply): discovery **only READS** — it never applies, never clicks an Apply button
(clicking LinkedIn's can mark a posting applied when it has not been), and **never attempts a login**. It
RETURNS jobs and writes nothing; the WEBSITE persists them (engine computes / caller does I/O).
`discoverInFlight` and `runInFlight` are **MUTUALLY EXCLUSIVE** — cdp.js tracks ONE `cdpTabId`, so a sweep
would clobber a running walk's attach mid-fill. ⚠ **AND SO ARE TWO RUNS (2026-08-12).** `AP_RUN_APPLICATION`
and `AP_SUBMIT_APPLICATION` guarded only on `discoverInFlight` while every other handler already refused on
`runInFlight`, so a second run could steal the first's attach for exactly the same reason. Observed, not
theorised: two overlapping runs on one Greenhouse posting produced a bundle with **12 `error` fields** where
that posting fills `15/9/1` cleanly. Both now refuse `run-in-flight`; safe because both reset the flag in a
`finally`, so a crashed run cannot strand the next one. It matters most on the SUBMIT path — a concurrent
run mutating the page under the replay's strict verify is exactly when "the page agrees with the approved
bundle" stops meaning anything. **No silent caps:** whatever a cap drops is reported as a note.

Mechanism (the one board driver + each board's JSON contract, the location resolver, `discoveryJobKey`
lockstep with web/lib/discover.ts, ranking, the hidden-tab levers): **load the `job-discovery` skill.**

## Workday never rewrites a committed value into a DIFFERENT option (operator, 2026-08-06)

**A committed value can, very rarely, be REMOVED by Workday. It is NEVER silently changed into another
option.** So when a field you committed later holds a *different* valid option, that is **us**, not the
tenant — stop looking for an explanation on Workday's side and go find our own stray write.

This is a load-bearing diagnostic rule, and ignoring it cost a full debugging round. Live on waystar page 3:
relocation was committed `"Yes, I am open to relocating"` and later read `"No, but I live near one of these
locations"`. That was written up as "Workday rewrites the value on its own", and the remedies built on that
premise (answer memory, a pre-Save recovery) treated a symptom. The real cause was ours: **every portaled
listbox renders at the SAME screen coordinates** (every commit on that page logged `rect=463,298`), the
options **linger a beat while unmounting and stay clickable**, and the next field's open-click therefore
landed on the previous field's still-mounted list — selecting the option that happened to sit at that point.
Changing relocation then remounted the dependent basecamp question under a new automation-id, blank and
required, which is what blocked Save.

`closeDropdownConfirmed` has gated the DETERMINISTIC path on options-GONE (not merely `aria-expanded`) since
2026-07-06; the **AI commit paths never called it**, and they are what fill screening questions. Now gated:
`aiFillField`, `aiCanonicalizeField`, and the employment-status dropdown commit.

**Corollary for triage:** value GONE ⇒ plausibly Workday (rare). Value CHANGED to another real option ⇒
**ours** — look for a lingering list, a stale rect, or a second write, in that order.

## Test pages

- Primary (Comcast SWE Intern, My Information):
  `https://comcast.wd5.myworkdayjobs.com/en-US/Comcast_Careers/job/IL---Chicago%2C-350-N.-Orleans-St-1300N/Comcast-Software-Engineering-Intern_R438146/apply/applyManually`
  — requires manual login + account creation; this is page 1 of the flow.
- Tenants observed: **Comcast wd5**, **Cambium Learning**, **US Bank wd1**, **LiveRamp wd5** (page-engine
  multi-page + repeating sections), **Magna wd3** (the CDP proving ground) — they differ (e.g. AssetMark uses
  `role="radiogroup"` where Comcast doesn't; `source` has three shapes). **Add an observation entry to
  `docs/dom-patterns.md` when testing a new tenant.**

## How to test

1. `chrome://extensions` → Developer mode → Load unpacked → this folder (first time only).
2. After code changes: reload the extension card; reload the Workday tab too if the injected function changed.
3. Open the **service worker** DevTools (the "service worker" link on the card) — `[ApplyPilot]` logs land
   here, NOT the page F12 console.
4. Navigate to the test URL, log in, reach the target page.
5. Popup → **Load default profile** → **Fill current page** (page engine) or **CDP fill FULL PAGE**; **View
   last summary** for the review summary.
6. Watch the service-worker console. `npm test` runs the unit suite (`node:test`).

For a real end-to-end run driven through Chrome, load the **`live-testing`** skill.

## A SLOW page is the LLM until proven otherwise (measured 2026-08-09)

**Subtract the `[LLM]` line before blaming a tenant, the DOM, or the fill code for a slow page.** Provider
latency is the biggest random variable in the whole pipeline and it dwarfs everything else on the page:
across three back-to-back cat.wd5 runs `gemini-3.1-flash-lite` answered in 486ms, 646ms and 796ms — and
once, same model, same config, same session, in **30657ms** (one attempt, no retry, no key rotation,
finishing 343ms inside the 30s `LLM_REQUEST_TIMEOUT_MS`). That single call was the entire difference
between a 1.9s page and a **32s** page. A page that "randomly filled slower" is this until the log says
otherwise.

Rank of per-page cost, from those runs: **LLM (0.5–30s, random)** › `capture`/`scrapeTaOptions` (2–16s,
OURS but deterministic — it scales with the option-list size) › everything else. The debugger channel is
NOT a factor: the no-op page probe's p50 is 1ms across ~1500 commands.

**`captureChoiceOptions` SKIPS skills (2026-08-09) — page 2 fill 15.6s → 8.0s.** Every other widget it
re-opens has a FIXED vocabulary, so one read-only scrape hands the review editor a real picker. Skills is
answered by a server-side RANKED search, so an empty-filter open is one page of a huge taxonomy that
varies run to run — it can never BE the picker, and it cost 8.6s of page 2's 15.6s. Review renders skills
as its recorded `"A; B; C"` text instead, which is exactly what `replayField` splits apart and re-adds.
This is also what the operator saw as the walk "hovering" over skills mid-run: capture scrolling a
virtualised list highlights rows, and it is READ-ONLY (that run's M40 audit re-read 27 fields, all matched).

**MITIGATION — the fast-retry (`LLM_FAST_RETRY_RULES`, llm.js).** For a matching model (today: gemini 3.1
only), the first two attempts are capped at **2s** and a call still running at that point is abandoned and
re-issued on a fresh socket after 150ms. At a p50 of ~650ms, a call still running at 2s is a stuck socket,
not a slow model. **Two invariants make it safe, both unit-pinned:** (1) once the fast tries are spent the
next attempt gets the FULL budget, so a genuinely slow provider is never FAILED by the cap — a failed AI
call blanks a required field and halts the walk, which is far worse than one slow page; and (2) the
fast-try budget is INDEPENDENT of the error ladder, because rotation probes every key with `noRetry:true`
— gating it on the ladder made it silently never fire whenever 2+ keys were configured (caught live, not
by tests). A fast abort is never a key fault: it does not consume a rotation slot or get a key marked bad.
Adding another model is one line in the rule table; `fastRetry:false` opts a call out.

**⚠ "THE LLM" IS NOT ONE THING — LATENCY BELONGS TO A provider+MODEL (2026-08-11).** Two same-price,
same-quota siblings diverge by **20×** for hours: A/B'd on ONE key in ONE minute, `gemini-3.1-flash-lite`
answered in 11499/7620/10903ms while `gemini-3.5-flash-lite` answered in 409/682/395ms (3.1 also 503'ing
"overloaded"). So "a slow page is the LLM" is right but not precise enough — **name the model, and A/B the
siblings on one key before concluding anything.** A 429 is the KEY's per-minute quota; a 5xx is the MODEL's
health; they must never be treated alike. Three fixes came out of it, all in `docs/fill-speed-log.md`
round 9: the **adaptive fast-retry cap** (the static 2000ms was tuned for a ~650ms p50 and fired on 76/77
calls once the real p50 hit ~11s — it now tracks the observed p50 and switches OFF when no short cap could
separate "stuck" from "slow"), the **AUTO model** (`model:"auto"` — ordered preference with failover, and
stale measurements are DISCARDED not averaged, which is what makes a recovered model win its traffic back
in ~1 call instead of ~75min), and **per-slot key pinning**.

**An `auto` route slot expands to ONE ATTEMPT PER CANDIDATE** (`llmExpandAutoAttempts`, llm.js — pure and
unit-tested, because cdp.js cannot be `require`d by a Node test). `act.llm`'s loop over the attempt list IS
the in-call failover, so a slot resolving to ONE model was also the LAST attempt: a persistent 503 ended
the call unanswered and the sibling was only reached by a later call. **One `auto` slot is therefore a
complete config** — it carries its own fallback, inherits the slot's `keyId` onto every attempt (Auto and
pinning compose), and re-dedupes against any concrete slot. ⚠ It expands per CALL and is NEVER written to
storage — the order is an observation, and freezing it into the saved config is the thing to avoid.

**Rotation does NOT spread load — it advances only on FAILURE (2026-08-11).** N equal-tier keys therefore
send every call through the FIRST one (measured: 6/6 calls on key 1, key 2 never touched), so a free-tier
account holding 30 requests/min of headroom breaches a **15/min PER-KEY** limit inside half of it. The fix
is the AI page's per-slot **Key** dropdown (`keyId`): pin the primary to key A and its fallback to key B.
The pin is STRICT for the slot (the isolated budget is the point), resilience comes from the NEXT slot's
own key, and an id matching no stored key is IGNORED rather than obeyed. `keyId` is part of a slot's dedupe
identity in `resolveLlmRoute` — without that, "same model, two keys" collapses to one attempt.

**Both the fill (`ats.js`) and the Workday walk (`fill-driver.js`) call `act.llm` with NO `action`**, so
both resolve the SAME `"fill"` route from the AI page, and `makeAtsActuation` reuses `workday.llm`
verbatim. Model + fallback + key bindings all come from the website's AI page for every path — verify with
`AP_DEV_LLM_PROBE`, which reports the resolved route rather than requiring you to read the code.

**`AP_DEV_LLM_PROBE` is how you PROVE it — the IDLE control arm (2026-08-11).** It fires N calls through
the same `act.llm` seam with **no tab, no attach, no run**, so provider latency is measured with nothing
else to blame. Use it before attributing any slowness to a tenant, a tab's visibility, or the fill code:
a hidden-vs-visible comparison cannot separate the two, because BOTH arms run while a tab is being driven.
It refuses while a run is in flight. This retired the "hidden is 2.4× slower on ATS" claim — **the LLM is
76–91% of an ATS fill**, an idle no-tab call hit 46.8s, and the second run of a back-to-back pair is
slower whichever arm it is (round 8, `docs/fill-speed-log.md`).

**`debugLagTrace`** (`AP_DEV_FLAG`) is the tool that settles it, and it exists because a duration alone
never could: it times every CDP command at the `cdpSend` choke point, runs a 500ms no-op page probe, and
measures the service worker's own timer drift — three clocks that fail independently, so each slow command
prints whether it was the renderer, the channel, or that call's own work. OFF ⇒ pass-through. Detail + how
to read it: the `live-testing` skill. **SW timer drift is the LAG itself, not an artefact (answered
2026-08-10): `act.delay` overruns 3–69× in the MV3 worker — every speed measurement, refutation and fix
direction lives in `docs/fill-speed-log.md`; read it before investigating any slow fill.** ⚠ Drift costs
**LATENCY, not coverage**: all 59 wall-clock poll loops were audited and every run-path one watches a
MONOTONE predicate (can only be noticed late, never missed) or a STABILITY one (where sparse reads are
*stronger* evidence) — so **a wait that timed out wants a bigger BUDGET; never add an attempts floor**,
and "the poll didn't look often enough" is not an available explanation for a failed wait.

## Working principles

- **`apMatch` is TWO objects — Node gets all of lib.js, the SW gets a HAND-WRITTEN literal.**
  `fill-driver.js` reaches lib.js through `apMatch`, which is `require("./lib.js")` under Node but an explicit
  object literal in the service worker. So `apMatch.foo(...)` can pass every test and throw
  `apMatch.foo is not a function` in the browser — live 2026-07-28, the replay walk died mid-run on
  `apMatch.dateOrderOf`. **Adding a lib.js helper that fill-driver uses means updating BOTH: lib.js's
  `module.exports` AND the SW literal.** Guarded by `test/sw-globals.test.js`.
- **ONE global scope in the service worker — never re-declare an imported name.** `background.js` loads
  db/lib/llm/gmail/cdp/fill-driver with `importScripts`, which evaluates them all into the SAME global scope
  (unlike Node's per-module scope). Two files declaring the same TOP-LEVEL name is a `SyntaxError` and the
  worker **fails to register at all** — "Service worker registration failed. Status code: 15", i.e. a
  completely dead extension. It happened live (2026-07-28): `dateOrderOf` moved into lib.js and a one-line
  alias was left in fill-driver.js; **all 765 node tests stayed green** because Node never shares a scope, and
  only loading the unpacked extension surfaced it. fill-driver.js reaches lib.js helpers via **`apMatch.*`** —
  that indirection is exactly why the two files can coexist. Guarded by `test/sw-globals.test.js`; deliberate
  lockstep dups live INSIDE functions, so they never touch the global scope.
- **Trace the real DOM before writing a handler — don't guess.** Every hard bug (the `source` picker, the
  dropdown chip contamination) only cracked after blind guesses failed and we instrumented a read-only trace
  of the *actual* DOM, then built from what it showed. Make a discovery trace the first step on any new
  widget/tenant.
- **Incremental:** one focused change per milestone, verified on a real page. No skipping ahead.
- **Observation-driven:** rules in `docs/dom-patterns.md` come from observed DOM, not assumptions; keep code
  and doc in sync.
- **Don't port the Python repo blindly:** it's a design reference (intent, prompts, edge cases), not code to
  mechanically translate to JS.
- **Commit per milestone:** each working milestone gets a commit, so we can bisect when something breaks.
- **NO AI ATTRIBUTION in anything that reaches GitHub (operator, 2026-08-11).** No `Co-Authored-By: Claude …`
  trailer on commits, no "Generated with Claude Code" line in PR bodies, and no equivalent mention in commit
  text, PR titles or issue comments. This **overrides** the default tooling convention that adds them. The
  commit bodies themselves are unchanged — still long, still reasoning-first; just unsigned.
- **Keep this file lean:** standing rules and invariants only. When a milestone lands, update the relevant
  rule here (a few lines), append the full dated entry to `docs/progress-log.md`, put observed-DOM findings in
  `docs/dom-patterns.md`, and put mechanism in the matching skill.
- **Three consoles:** service worker (`background.js` + the engine's returned data), page F12 (anything
  `console.log`'d inside the injected function), popup right-click → Inspect (`popup.js`). Most `[ApplyPilot]`
  output is in the service-worker console.

### TODO(dup) — change in LOCKSTEP (both copies carry markers)

- `normalize` / `fuzzyRatio` / `matchCandidates` — `lib.js` (driver + tests) and inline in `fillEngine`
  (stringified, can't import).
- `buildReviewBundle` (fill-driver) mirrors the page-engine `buildEntry` schema.
- `FIELD_MAP` + the `*_MAP` section maps exist in both `fill-driver.js` and `background.js`.
- `discoveryJobKey` + `DISCOVER_DEFAULTS` exist in `discover.js` and `web/lib/discover.ts` — this pair is
  **test-enforced** (`web/test/discover.test.ts` cross-loads the real `discover.js` and fails on drift). Do
  the same for the others when convenient.
- `normalizeLabel` (lib.js) ↔ `normalizeQuestion` (web `lib/buckets.ts`).
- `summary-lib.js` ↔ `web/lib/review-approval.ts`; `summary.js` grouping ↔ `web/lib/review-model.ts`.
