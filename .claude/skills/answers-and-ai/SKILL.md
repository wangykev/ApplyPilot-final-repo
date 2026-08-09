---
name: answers-and-ai
description: How a value is chosen for a field — the full match ladder, answer buckets and answer ladders (website-driven), the multi-provider LLM seam (AI-0…AI-4) with its eligibility and safety gates, and the safety-critical employer-match / employment-status recognizers. Read this before touching matchCandidates, resolve(), buildBucketIndex/fillFromBucket, llm.js, aiFillField/aiFillText/aiFillRadio, decidePreviousWorker, or recognizeEmploymentQuestion.
---

# Matching, answer buckets, and the AI layer

The order a field's value is decided in `drivePageFill`:

```
FIELD_MAP (mapped path) → resolve() → match ladder
  ↓ nothing produced, not mapped
answer BUCKETS (website-driven)              ← deterministic, REQUIRED + OPTIONAL
  ↓
employment-status RECOGNIZER                 ← deterministic, REQUIRED + OPTIONAL
  ↓
AI fallback                                  ← REQUIRED only
  ↓
blank + review
```

Placement is load-bearing: the recognizer sits AFTER the bucket consult and **BEFORE the AI FALLBACK
block**, or the dropdown/text AI fills the question first.

---

# Matching strategy — the full ladder

**Value is an ordered candidate list, most-specific first**, supplied by the profile (`resolve()` coerces
per widget type; an array passes through as a ready-made tiered list). The handler tries candidates in
order.

**A BOOLEAN profile value coerces to the tiered list `["Yes","True"]` / `["No","False"]` for
dropdown/typeahead AND radio** (2026-07-23) — so a checkbox, a true/false dropdown, a yes/no dropdown, and
yes/no radios all fill DETERMINISTICALLY from a stored boolean. *Why it matters:* a bare `"true"` /
`"false"` string matched no "Yes"/"No" option and leaked required boolean questions (e.g. "Are you over
18?*") to the AI post-pass — flagged LEGALLY-LOADED on every fill despite the profile answering it. Both
`resolve()` copies (lib.js/fill-driver.js + the background.js engine) are lockstep; regression-pinned.

## Match ladder (per candidate, stop at first hit)

1. **Exact** after `normalize()`.
2. **Containment — WIDGET-DEPENDENT, AMBIGUITY-SAFE + short-guarded**
   (`matchCandidates(cands, opts, {containment})`, default ON) — `startsWith` then `includes`, committed
   ONLY when **exactly one** option contains the candidate (a candidate in **2+ options is NOT a confident
   match** → skip), AND mid-string `includes` requires the candidate to be **≥ 3 chars** (a 2-char abbrev
   is a substring of too many unrelated options).
3. **Fuzzy ≥ 90** Levenshtein — **TYPO TOLERANCE ONLY**.
4. **Escalate** → `needs_review` (a REQUIRED field then goes to the AI rescue; optional → blank).

## Containment is a GUESS unless Workday made it (2026-07-16)

**ApplyPilot never PICKS a containment match itself.**

- **Dropdowns + radios (select from a full list)** pass `{containment:false}` → exact → typo → escalate.
  *Why:* a substring match on a shown list is a wrong guess — the **`"PA"` → "Armed Forces Pacific"** bug
  (`"pa"` ⊂ "pa**cific**", the ONLY option containing it, so the ambiguity guard couldn't help; it
  committed at `filled` with NO review flag). (`fillRadioCdp` was already exact-label-only, so this only
  changed `fillDropdownCdp`.)
- **Typeahead / cert / source DIRECTED picks** (Workday showed a filtered list and did NOT autocommit, and
  we would click the one containing option) ALSO pass `{containment:false}` — same reasoning: us picking is
  a guess.
- **Typeahead / cert / source AUTOCOMMIT recognition** KEEPS containment (default) — when *Workday itself*
  drops in a completed chip after you type (e.g. `"Training Instructor - AEVO"` → `"…AEVO - Multiple
  Recognized Providers"`), "the chip contains what I typed" is how we RECOGNIZE Workday's completion (vs a
  genuine stray like a `"Canada"` chip for a US query). That's trusting Workday, not guessing; still
  `filled_review` (flagged). The AI anti-hallucination belts keep containment too (the AI's choice → a real
  option; the AI rescue must succeed for required fields).
- **ONE authorized exception — SKILLS (operator, 2026-08-07).** `matchSkillOption` has a containment tier
  so a skill Workday only lists under a broader name still lands (`Vivado` → `Xilinx Vivado`). Safe only
  because of three guards, all earned on one live run: **WHOLE-WORD** containment (raw `includes` puts
  `Git` inside "Di**git**al" and `CAN` inside "**Can**adian"), a **distinctiveness gate** (a lone token must
  be ≥5 chars — on that run `CAN` was offered "**Can** Openers", a real whole-word hit the gate refused),
  and a **ranking tie-break** (several containing rows → Workday's own first result, alternatives named in
  the review). Every widened commit is `filled_review` + `skills-containment`, never silent. This does NOT
  relax the rule anywhere else. See the `cdp-actuation` skill.

**Net rule:** ApplyPilot accepts only an **exact** match, a **typo** (fuzzy ≥ 90), or a value **Workday
autocommitted** — plus, for SKILLS only, a guarded whole-word containment. Everything else escalates → the
operator picks it on the website review editor / teaches an answer bucket (→ an exact match next time), or
the AI rescue fills a required field.

Lives in `matchCandidates` (lib.js + the inline `fillEngine` copy in `background.js` — **LOCKSTEP**);
dropdown/radio + directed-typeahead call sites pass `{containment:false}`.

## Why not low-threshold fuzzy

A 60% bar matches near-gibberish and silently selects a WRONG value, corrupting the application — the worst
failure for an accuracy tool, worse than leaving a field unfilled. Fuzzy is typo-tolerance at 90+, not a
general matcher.

## `normalize()`

Lowercases, strips a trailing `(+digits)`, collapses whitespace — lets "United States of America"
exact-match the rendered "United States of America (+1)" with no fuzzy step. A tiered profile array (e.g.
`["United States of America (+1)", "United States"]`) makes the exact-normalized hit land at **high**
confidence instead of containment (medium).

**needs-review / fuzzy connection:** a fuzzy/no match is not a confident answer — it's exactly the category
that belongs in the human-review pile.

**Parked (opt-in per field, never global):** dial-code-suffix matching ("any `(+1)` is acceptable for a US
phone"). Global would silently accept a wrong country whose dial code happened to match.

---

# Answer buckets (website-driven; Profile v2)

The website (`WEBSITE.md`) owns a `buckets_json` store synced via `AP_SYNC_PROFILE`. A **bucket** = one
canonical answer + the question wordings that map to it. The extension consults them in `drivePageFill` for
any UNMAPPED field the deterministic pass left empty, **before** the AI post-pass.

- **`buildBucketIndex(buckets)`** builds normalized-wording → bucket (`apMatch.normalizeLabel`, LOCKSTEP
  with the website's `normalizeQuestion`). **Exact-normalized match only — no fuzzy** (the AI fallback
  covers misses; a fuzzy tier would only add silent-wrong-match risk).
- **`fillFromBucket`:** **Mode A** (`profile_path`) resolves the bound profile value; **Mode B** uses the
  bucket's own `value` — a **CANDIDATE LIST** (`string[]`, a legacy string tolerated): text → `value[0]`,
  choice widgets pass the whole list through the match ladder (fills like a tiered dropdown/typeahead across
  tenants). Either way it's a CANDIDATE through the SAME match ladder vs the LIVE options — never a blind
  commit; a no-match falls through to AI/blank. A real commit is flagged `bucket` (a "remembered"-style
  provenance, NOT an `ai-*` flag). Gated `producedNothing(record) && !mappedPath` (a mapped-but-no-match
  field goes to CANONICALIZE instead). Runs for REQUIRED **and** OPTIONAL fields.
- The SW loads `buckets` from `chrome.storage.local` and hands them into `drivePageFill` (engine computes /
  SW does I/O). Unit-pinned in `test/fill-driver.test.js`. **Supersedes** `answerBank`.

## Teach-flow piggyback (for the website `/app/teach` page)

The AI fill functions (`aiFillField` / `aiFillText` / `aiFillRadio`) return, in the SAME fill call,
`maps_to` (the profile field this question maps to; `""`=none) + `suggested_category`; these ride each
review-bundle entry (`buildReviewBundle` + `background.js buildEntry`, lockstep). The website teach page
consumes them so curation needs **no extra LLM call** for AI-filled questions.

Buckets match LABEL-only (`normalizeLabel`); `bucket.selectors` (per-platform ids) stays UNUSED scaffolding.
`normalize`-style lockstep dup: `normalizeLabel` (lib.js) ↔ `normalizeQuestion` (web `lib/buckets.ts`).
**Not-yet-wired:** date/textarea bucket *filling*.

## Answer ladders are SEPARATE from the question bucket (2026-07-23)

The **bucket** = the question WORDINGS that map to a field; the **answer ladder** = the acceptable ANSWER
variants for that field. Two different things (modeled on Country's tiered list).

`answer_ladders: Record<path, {yes:string[], no:string[], values?:string[]}>` lives in `profile_json` (**no
migration** — rides the profile blob); `yes`/`no` = triBool polarity ladders, `values` = scalar variants.

UI: the profile page shows an in-field `›` arrow → `AdvancedChoices` popup on EVERY `TextField` /
`SelectField` (proactive — pre-load variants like GPA `["4.0/4.0","3.5+"]` WITHOUT waiting for a teach); the
teach page shows the same popup on clicking the answer.

Fill: `appendFieldVariants` / `boolLadderCandidates` (fill-driver.js) append the ladder's variants as extra
match-ladder candidates for choice widgets, keyed by the bucket's `profile_path` VERBATIM (dotted, incl.
numeric `education.0.gpa`).

## Buckets fill REPEATING-section entries too (2026-07-25, operator's design)

Inside a repeating section every entry shows the SAME wording, so the bucket identifies **which FIELD** and
the entry **ORDINAL** picks **which VALUE**: a bucket bound to `education.0.school_or_university` fills
entry 0 from `education[0]` and entry 1 from `education[1]` (the value is read from the ENTRY'S OWN item —
no index remapping).

Runs in `fillEntryCdp` AFTER the fieldMap loop, ONLY for entry fields the map did not claim (id or label),
so it can never double-fill; the bucket's path ROOT must name the section (`itemsKey`) or it can't fire; and
when a bucket fills a field the map named but couldn't RESOLVE, it updates that record instead of
duplicating it.

**Mode B (a fixed `value`) does NOT fire per-entry** — with no indexed data, filling every entry identically
is a guess. Same safety as the flat tier: a CANDIDATE through the match ladder, flagged `bucket`, never a
blind commit. Unit-pinned.

## Every profile field's bucket ships with the field's OWN NAME as a default wording (2026-07-26)

The website's `ensureDefaultFieldWordings(buckets, profile)` (web `lib/teach.ts`, applied on LOAD next to
`ensureStarterBuckets` at the sync slice / teach API / profile editor) seeds a Mode-A bucket per profile
field with its humanized label — the first-name bucket contains "First Name" — so a form that labels its
question the way the profile labels the field fills deterministically even when the tenant's automation-id
isn't in `FIELD_MAP`. Matching is normalized, so casing and spacing don't matter. Non-destructive +
idempotent (operator wordings kept, dedup by `normalizeQuestion`).

SKIPS labels too generic to be a safe EXACT match (type/name/value/url/id/status/title/other/notes/
description) and every repeating entry past the PRIMARY one.

**WEBSITES are the exception both ways:** each entry is a DIFFERENT question, so EVERY entry gets a bucket
and the wording is the entry's TYPE verbatim — "LinkedIn", "GitHub", "Personal Website" (never "URL").

Website URLs are stored as the FULL CANONICAL link — scheme **and `www.`** (`websiteSchema.url` transforms
through `ensureHttpsUrl`, LOCKSTEP with the extension's `ensureHttps`), so the value seen, synced and filled
is one string.

**Why `www` is REQUIRED (2026-07-26):** the site/form canonicalize to the www host, and a bare-host profile
value then fails EVERY equality tier — exact, containment (`www.` is inserted MID-string, so neither side
contains the other), and fuzzy (**89** vs the 90 bar) — which flags the M40 audit (`textValuesMatch` has
phone-digit relief only) and makes `submitPrecondition` BLOCK on a review-page DISAGREE.

`www.` is added ONLY to a bare APEX host (2 labels, or 3 ending in a multi-part public suffix like `co.uk`);
a host that already carries any subdomain (incl. `www.`), an IP, or userinfo is returned UNTOUCHED —
inventing `www.blog.example.com` would break a working link, a worse failure than the mismatch. Idempotent
(never stacks `www.`); normalization runs on profile PARSE + editor blur, so existing profiles self-heal on
their next save.

## Education (& other repeating sections) fill BOTH shapes (2026-07-23)

A section like Education renders as a repeat-add block OR as flat single questions. Flat fill goes through
Mode-A **starter buckets** bound to entry-0 paths
(`education.0.{school_or_university,gpa,degree,field_of_study}`,
`work_experience.0.{job_title,company}`) matched on label wording (`getByPath` reads the primary entry).

**No double-fill:** the flat driver loop SKIPS fields inside repeating containers (`isRepeating`) — a
repeating tenant fills via `driveRepeatingSectionCdp`, a flat tenant via the buckets.
`ensureStarterBuckets(buckets)` merges new starters into EXISTING profiles (dedup by `profile_path`,
idempotent, non-destructive). Repeating-section fill + schema untouched.

---

# AI feature — multi-provider LLM (AI-0…AI-4 built)

Not-in-JSON questions (free-text/essays, unmapped choice fields, yes/no screening) leave REQUIRED fields
empty → block Save & Continue → need an LLM. Built behind ONE provider-agnostic seam; **every AI fill is
under the safety contract — guess + fill + FLAG `needs_review`, never silent trust — and the human review
gate is the safety.**

## The seam (`act.llm`, AI-0)

`llm.js` is the ONLY provider-aware code: `callLLM({provider, model, apiKey, system, user, maxTokens})` →
normalized `{ok, text} | {ok:false, error}`, **NEVER throws** (Anthropic / Gemini / OpenAI builders+parsers;
adding a provider = one entry).

`LLM_MODELS` = curated per-provider model lists feeding the popup **dropdown** (default = the FIRST entry,
single source of truth — **`gemini-3.1-flash-lite`** leads; a stale hardcoded model was the 429 lesson).

`makeCdpActuation(llmConfig)` exposes `act.llm` (the only I/O method on `act`) + `act.aiEnabled` — both
enforce the opt-in toggle (OFF ⇒ no provider call, no spend). The brain (fill-driver.js) builds the prompt
+ owns the decision, so it stays Node-testable with a fake `act.llm`. Popup config (provider/model/key +
toggle + Test-connection); `manifest.json` `host_permissions` for the 3 hosts.

## AI-1 — screening-question dropdowns (`aiFillField`, fill-driver.js)

A gated dispatch post-pass fires when `act.aiEnabled && f.isRequired && aiEligible(f) &&
producedNothing(record)` (an unmapped dropdown / genuine no-match).

**ALWAYS-GUESS** — no UNKNOWN gate, because these are REQUIRED fields and a blank HALTS the walk: open →
read the live options → `act.llm` with the profile + question + exact options → the model CHOOSES one + a
SHORT justification that NAMES its basis (a positive profile fact vs reasoning-from-ABSENCE) + a confidence
(High/Medium/Low).

The choice is a **CANDIDATE that must clear the match ladder** vs the live options (never blind-commit) →
text-keyed commit + read-back + persistence re-read. ALWAYS `filled_review`. `parseAiReply` tolerates
```-fenced / embedded JSON + a non-JSON fallback.

## Safety / eligibility (HARD, unit-pinned)

AI-fill an unmapped/unmatched **dropdown / text / typeahead** — **but ONLY when the field is REQUIRED**
(operator rule).

An OPTIONAL unmapped dropdown/text/typeahead fills **deterministically only** and is left **BLANK** on a
miss — a blank optional doesn't block Save & Continue, so there's no reason to spend an LLM call guessing it
(INCLUDING optional EEO, incl. cascade-revealed Local-Name fields). The gate is `f.isRequired &&
aiEligible(f)` on `drivePageFill`'s INFER branch; `aiEligible` itself is a detector.

The two value-CANONICALIZE paths (`aiCanonicalizeField` for a STATED dropdown value; the inline typeahead AI
that only fires on a `resolve()`-produced candidate) are **NOT gated** — they operate on a value the user
PROVIDED, not a guess, so they run for required OR optional.

**NEVER (regardless of required): `file_upload` and `checkbox`.**

A REQUIRED **radio** the deterministic pass can't answer gets an AI guess via its OWN post-pass
(`aiFillRadio` — NOT through `aiEligible`, mirroring the typeahead pass): infer from the profile → the pick
clears the match ladder vs the live labels → commit via `fillRadioCdp` → ALWAYS `filled_review`, flagged
HARD, never blank-blocking.

This INCLUDES `candidateIsPreviousWorker` when its employer-match path is UNEVALUABLE (no company set + no
known employer named) — **the safety reversal**: AI-guess to REACH review (force-flagged
`ai-choice-sensitive` → LEGALLY-LOADED; a low-confidence guess auto-escalates to super-hard in the viewer)
rather than leave a truthfulness-adjacent required field blank. GATED on `record.resolved == null` so a
decided-but-uncommitted employer-match answer (e.g. a matched "Yes") is NEVER overridden by a contradictory
guess. AI OFF / OPTIONAL radio ⇒ stays blank (unit-pinned).

**EEO/protected (gender/race/ethnicity/veteran/disability/sexual-orientation) is NO LONGER excluded for
REQUIRED fields — the operator RETRACTED that rule.** A REQUIRED EEO field fills via the SAME AI inference
as any required field, then gets the loud `ai-eeo-guess` "AI-GUESSED DEMOGRAPHIC — VERIFY" review badge
(re-tagged at the call site; `isEeoField` is a detector, not a blocker). An OPTIONAL EEO field is left BLANK
(the optional gate above — uniform). **A STATED demographic still fills deterministically — the AI never
overrides a value you provided.**

Toggle OFF ⇒ `act.llm` never called. `legallyLoaded(label)` (widened to catch "over the age of 18") →
`ai-choice-sensitive`.

## The no-commit dismissal (`closeAndVerifyBlank`)

The UNKNOWN/no-match path must leave the field BLANK — and **blank is VALUE-based** (`triggerText` stayed on
the opening placeholder), NOT the listbox state: a STRAY commits a value (which ALSO closes the list), so
the value-check is the real property; a genuinely CHANGED value is surfaced (`*-stray`), never a false
"blank, please answer."

(An `ariaExpanded` hard-gate + a reopen-toggle once manufactured a false stray on a slow-closing list — both
removed.) This is the SOLE guard on the no-commit path (the M40 audit only re-reads `filled` /
`filled_review`, never a blank field). Reused by the recon (`reconDropdownDump`).

## The review gate bites (two operator requirements)

`flag` is persisted in the bundle; `deriveConfidence` surfaces the AI's self-reported confidence
(`confidence_source:"ai_inference"`); the viewer (`summary.js`) renders **`ai-choice-sensitive` answers
FIRST with a red "⚠ LEGALLY-LOADED — VERIFY" badge — prominence off the FLAG, never confidence** (a
high-confidence reasoning-from-absence answer, e.g. criminal→"No", must NOT be the easiest to scroll past)
+ the AI-INFERRED badge + the justification (which names its basis). The super-hard tier
(`ai-closest-forced` + low-confidence AI) renders loudest, FIRST. M40 audit re-reads AI fills.

## Prompt shape

**AI prompts pass the STATED answer (the candidates), NOT the whole profile**, when one exists
(`statedAnswerBlock`) — saves tokens + matches a typo ("Otherrr"→"Other") instead of inferring an unrelated
profile fact; falls back to the profile only when there is no stated answer (e.g. EEO).

## Recon harness

`reconDropdownDump` + `RUN_CDP_QUESTIONS_RECON` + `cdp-questions-recon`: read-only dump of a screening
page's dropdowns (verbatim labels + options + a verified-blank clean-close) — the new-tenant probe before
relying on the fill path.

## Status

AI-0 (adapter), AI-1 (screening choice), the inline typeahead/tree rescues, and AI-4 (remediation — see the
`workday-walk` skill) are live-verified. AI-2 (essays — the required-text INFER branch) and the AI-3 EEO
corner (`aiInferEeoField`, kept only for the mapped-but-empty REQUIRED EEO dropdown) are built, live-verify
pending.

⚠ **Every AI commit path must call `closeDropdownConfirmed`** — see the "Workday never rewrites a committed
value" rule in CLAUDE.md. Gated since 2026-08-06: `aiFillField`, `aiCanonicalizeField`, and the
employment-status dropdown commit.

---

# Employer match — "previously employed here?" (safety-critical)

`candidateIsPreviousWorker` sits next to a **truthfulness certification**, and selecting "Yes" unfurls
follow-up fields — so a wrong "Yes" is a false legal statement.

## `decidePreviousWorker(company, questionText, employers)`

| case | action |
|---|---|
| **clean miss** (no known employer matches) | fill **"No"**, no review (confident non-membership) |
| **partial overlap** with the application company | fill **"No" + review** (name overlap may be the same employer) |
| **exact company match OR a known employer named in the question text** | fill **"Yes" + review** |
| **unevaluable** (list unconfigured / `[]`) | **blank + review** — no blind guess |

A **complete (non-empty) list makes the clean miss safe WITHOUT a company anchor** (operator 2026-07-24:
"trust your list") — it fills "No" even when `jobContext.company` is unset; the anchor only corroborates the
Yes/overlap paths. An empty list can't confirm non-membership, hence unevaluable.

**NEVER auto-"Yes" without a review flag.** *Why:* this field is adjacent to a truthfulness certification
and a "Yes" unfurls follow-up questions, so a wrong positive is a false legal statement — every "Yes" (and
every uncertain "No") gets a mandatory human check, never a silent auto-answer.

## Question-text scan

These questions name the entities that count (affiliates/subsidiaries/predecessors — "Elavon, U.S. Bancorp
Investments, Union Bank"; "Ken Garff") which the bare `jobContext.company` misses.

Scan the question label for each known employer via a **contiguous whole-word token-sequence** match, gated
by a distinctiveness check (multi-word, or a lone word ≥5 chars not in `GENERIC_SINGLE`) so a short/common
entry ("Bank") can't false-match boilerplate. Works even with `jobContext.company` unset (adds a "no company
to corroborate" note).

**It reads the user's KNOWN employers out of the question — it does NOT extract company names from prose (no
LLM).**

## `employment_history_companies` = industry employers ONLY

Companies you were formally employed by; excludes academic/lab/club affiliations. Its completeness is what
makes the auto-"No" safe. `["none"]` = "never formally employed" → confident "No"; `[]` = unfilled → flags
every such question for review.

## Custom employment-status screening questions (2026-07-24)

A tenant's OWN worded yes/no question ("Are you a former MAGNA employee?", "Are you currently employed with
Magna?", the checkbox assertion "I am a former Magna employee") is NOT Workday's standard
`candidateIsPreviousWorker` field, so it used to fall to the AI fallback → force-flagged
`ai-choice-sensitive` (the "LEGALLY-LOADED — VERIFY" badge) on every fill despite being answerable from the
profile.

Now a **deterministic recognizer** (`recognizeEmploymentQuestion`, fill-driver.js) — a post-pass AFTER the
bucket consult and **BEFORE the AI FALLBACK block**; a DETERMINISTIC tier like buckets → runs for REQUIRED
**and OPTIONAL** fields (the AI fallbacks stay required-only).

Fires when a yes/no-capable widget — **radio, dropdown, text/textarea, checkbox** — meets ALL of:

- **(a)** one SENTENCE **names the application company** (`empCompany`) with an employment word within 3
  tokens (or "worked/working for/at/with «co»" — bare "work" deliberately excluded);
- **(b)** that sentence **asks about YOU** (`EMPLOY_ASK_RE`: "are/were/have/do/if you … employee/employed/
  worked", the FIRST-person checkbox assertion "I am/was a «co» employee", a terse "Former «co» employee?"
  opener, or "your former/current employer");
- **(c)** **no BAIL pattern** hits (`EMPLOY_BAIL_RE`).

`EMPLOY_BAIL_RE` was hardened 2026-07-24 against adversarial wordings that WOULD produce a silent wrong
answer:

- wrong SUBJECT — "relatives/spouse/referred-by/know-anyone employed at «co»";
- wrong OBJECT/scope — "employed by a competitor/supplier of «co»", "terminated by ANY employer";
- different FACT — "eligible/authorized for employment" (work-auth!), termination manner, reference-contact,
  policy/handbook consent;
- inverted POLARITY — "I certify I am not…", "are you not/no longer" (while the Magna conditional "If you
  are not a former MAGNA employee, please select No" is EXEMPTED by its same-sentence select-instruction);
- ASPIRATIONAL — "would you accept/interested in/able to begin employment".

Sentence scoping kills cross-sentence contamination ("Do you have a criminal record? Magna requires all
employees…").

**Tense:** current-only → `decideCurrentlyEmployed` (derived from the work-history `currently_work_here`
flags); former/ever → `decidePreviousWorker`; **BOTH ("current or former") → "ever"**.

**Polarity mapping:** `optionForPolarity` maps the decision to the live option by **leading-token polarity**
— exact first, else a UNIQUE Yes/No-leading label like "No, I'm NOT currently employed with Magna"; 2+
leading → refuse → AI.

**Commit per widget:**

- **radio** — `fillRadioCdp`.
- **dropdown** — `openAndReadDropdown` + the AI path's text-keyed click + persistence re-read (prefilled-equal
  → kept, ZERO value actuation).
- **text/textarea** — type the polarity word via `fillTextCdp` — EXCEPT a detail-REQUEST field ("please
  enter/list/provide your employee ID/dates…"), which is NOT a yes/no ask → left for AI-2 (a bare silent
  "No" there would be sloppy).
- **checkbox** — a REQUIRED checkbox is STILL always auto-checked (operator rule 2026-07-24 — required can't
  stay blank), but a grounded-"No" CONTRADICTION re-flags the check `filled_review` + `employer-match` (never
  silently assert what the profile contradicts; agreement/unevaluable → silent as before, ordinary consents
  unchanged — their agree/authorize wording bails the recognizer). An OPTIONAL checkbox is DETERMINED —
  check="Yes" (always review), uncheck="No" (virgin box → zero actuation, silent; clearing a pre-ticked box
  → forced review).

**Outcomes:** a clean **"No" fills SILENTLY** (status `filled`, no flag — a grounded fact from your complete
list, NOT absence-reasoning); a **"Yes"/uncertain → `filled_review` + `employer-match`** (renders
`employer_match_uncertain`, NOT AI-inferred; **never auto-"Yes"**); a **pre-existing DIFFERENT real value is
never silently overwritten** (commit + forced review). Unrecognized / unevaluable / polarity-unmappable → the
AI/blank fallback unchanged; a commit-fail sets `resolved` so `producedNothing` stays false and the AI can
never override a made decision.

## Anchoring — `empCompany` (Option 1, 2026-07-25)

`empCompany` = `jobContext.company` (scraped) **OR the page URL's TENANT SUBDOMAIN** (`tenantCompanyFromUrl`,
lib.js — `magna.wd….myworkday{jobs,site}.com` → "Magna").

The tenant is always present in the URL, so the recognizer / employer-match never fall to the AI just because
the scrape/hand-off didn't populate a company. Computed ONCE at the top of `drivePageFill` from `scan.url` and
used at every employment site (`candidateIsPreviousWorker` + the recognizer post-pass + the checkbox
contradiction flag).

The recognizer still confirms the company is NAMED in the question; **the answer comes from your employer
list.** `jobContext.company` (from the JD scrape) is now an optional override + display only.

## Operator decisions (2026-07-24)

- A **non-empty** employer list is treated as complete.
- Current employment derives from the work-history flags.
- A clean miss is always "No" **even when the question broadens to affiliates/subsidiaries** — we trust your
  list; there is no ownership DB.

Lives in fill-driver.js (CDP path); adversarial wordings unit-pinned in `test/fill-driver.test.js`.
