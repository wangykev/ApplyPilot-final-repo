# Design: AI-fill + delete-with-memory for repeating-section fields

Status: **PROPOSAL — awaiting operator approval** (2026-07-20). No code written yet.
Supersedes the "keep value-holding row + halt" behavior shipped in the education-bug fix.

## Problem

A repeating-section entry (Education, Work Experience, Certifications, Languages, Websites)
often fills most of its fields deterministically but leaves one field unfilled — either because
the profile has the value in *different wording* than the form's options (e.g. degree dropdown:
profile `"Bachelor of Science"`, form offers only `"Bachelors"`), or because the profile genuinely
lacks that field. Today:

- **Repeating dropdowns get ZERO AI** (`fillEntryCdp` calls a bare `fillDropdownCdp`) — only the
  deterministic tiered-list match. Repeating **typeaheads** already get the inline AI rescue +
  required-empty inference. So the degree-dropdown wording gap has no bridge.
- A partial row either blocks Save & Continue (required field empty → walk halts) or, under AI-4
  Tier-1.5 remediation, USED to be deleted whole (now fixed to keep value-holding rows). Neither
  is ideal: halting stalls the walk; deleting lost the data + vanished from review.

## Target behavior (per repeating entry, decided AT FILL TIME)

After an entry's fields fill deterministically, classify each field and resolve gaps:

```
for each MISSING field (skipped / genuine no-match) in the entry:
    if the field has a STATED profile value that didn't match the form's options:
        → AI CANONICALIZE (reword the user's value to the form's vocab; never a guess)
    else if the field is REQUIRED and has NO profile value:
        → AI INFER from the profile (only if High/Medium confidence)
    (canonicalize/infer commit ONLY a value that clears the match ladder vs the LIVE options)

then, for the WHOLE entry:
    if every REQUIRED field is now filled (deterministic + AI):
        → KEEP the entry. Flag ONLY the AI-filled field(s) for review (ai-canonicalized / ai-choice).
           Deterministic fields are not flagged.
    else (a REQUIRED field is still unfillable — AI declined / low-confidence / no basis):
        → DELETE the entry on the form (so the walk advances to review), BUT the bundle REMEMBERS
           everything: the values that DID fill (deterministic + AI), the recon (field shape /
           options / date order), and WHICH field couldn't fill. Surface it in review as a
           "removed — add back" card.

if the entry filled NOTHING (whole row empty, no profile data):
    → delete, do NOT surface (a true orphan; current behavior).
```

Key point: the delete decision moves to **fill time** (proactive), not remediation — "during the
fill it was deleted." The walk never halts on an unfillable repeating field; it advances to review
with the entry remembered.

### "Confidently fill" (safety)
- **Canonicalize** = map a value the user *provided* to the form's vocabulary (`aiCanonicalizeField`).
  Safe — it's the user's answer reworded, gated on clearing the match ladder. Flag `ai-canonicalized`.
- **Infer** = the profile has no value; AI infers from the rest of the profile. "Confident" = High/
  Medium self-reported confidence AND clears the ladder. Low-confidence / reasoning-from-absence is
  NOT confident → the delete-with-memory path (we do NOT force a junk value onto a repeating row —
  this DIVERGES from the flat-field "always force a required guess to reach review" rule, on purpose:
  a repeating entry can be dropped + re-added, a flat field can't).
- AI OFF: skip the AI step entirely. A required field with no deterministic value → delete-with-memory
  (advance + surface). No halt for repeating sections (flat required fields still halt as today).

## Data: the "removed-but-remembered" bundle record

A new section-level record (one per deleted entry), carried through `buildReviewBundle` → the bundle:

```js
{
  fieldName: "<section>[<i>].__removed",         // e.g. "education[0].__removed"
  widgetType: "removed_entry",                    // new (passes the bundle's section filter)
  flag: "entry-removed-remembered",               // new → deriveReview → needs_review:true
  section_known: true,
  page / page_number / page_label / field_index,  // standard envelope bits
  container_prefix: "education-",                  // backend id for re-add fill-back
  section_field_shape: [ ...recon... ],           // full field shape (widget, label, date_order, options)
  nested_shapes / nested_attachments,             // if the section has them (cert)
  remembered_fields: [                            // what to PREFILL on add-back
    { recName, path, widget_type, label, is_required,
      value,                                      // the value that filled (or null if unfilled)
      filled_by: "deterministic" | "ai-canonicalized" | "ai-choice",
      match_tier, options, date_order },
    ...
  ],
  unfilled_fields: ["fieldOfStudy"],              // the required field(s) that forced the delete
  detail: "Education entry removed — 'Field of Study' had no match in your profile. Add it back
           (school + degree prefilled) and supply Field of Study."
}
```

A KEPT entry with AI-filled fields uses the normal per-field records; only the AI field carries an
`ai-*` flag → needs_review. No new record type needed for the keep case.

## Website review editor (`web/`, PR #18)

- Render a `removed_entry` card in the section: "This entry was removed — add it back." Show the
  remembered values read-only + the unfilled field highlighted.
- **Add back** → reconstruct the entry in the review model from `remembered_fields` (prefilled) +
  `section_field_shape`; the `unfilled_fields` render empty for the user to fill; the AI-filled
  fields render flagged (need approval); deterministic fields approved-by-default.
- On approve, the reconstructed entry becomes a normal approved entry in the bundle.

## Replay / submit

- `bundleToSectionItems` reconstructs an added-back entry from its (now-complete) field values and
  feeds `driveRepeatingSectionCdp` (strict, no AI) — it re-adds + fills the entry on replay.
- A `removed_entry` the user did NOT add back stays absent (the fill already deleted it) → replay
  reconciles to the approved entry set. No orphan.
- The submit gate is unchanged (every needs_review field must be approved; a not-added-back removed
  entry is a needs_review item → must be resolved/approved before submit_ready).

## Teach (`web/lib/teach.ts`, PR #18)

- Only the **AI-filled** field of a kept entry, and the **user-supplied** field of an added-back
  entry, are teachable (they represent a wording/answer the profile didn't cover deterministically).
- Deterministically-filled fields (exact match) are NOT teachable (already known).
- Extends `teachableCards` to per-field granularity within a repeating entry (today it keys on
  whole entries / flat fields).

## Components & sequencing (once approved)

1. **Extension — AI for repeating fields** (PR #19): `fillEntryCdp` gains, for a genuine-no-match
   dropdown, `aiCanonicalizeField`; for a required-empty dropdown, AI inference (mirroring the
   typeahead paths). Keep the row when AI resolves all required fields; flag only AI fields.
2. **Extension — delete-with-memory** (PR #19): when a required field stays unfillable, delete the
   entry + emit the `removed_entry` record with `remembered_fields` + recon. Unify the fill-time
   delete (replaces the deleteOnNoMatch-at-fill + the keep-and-halt behavior) so it's ONE decision.
   `buildReviewBundle` + `deriveReview` handle the new record.
3. **Website — add-back-with-prefill** (PR #18): the `removed_entry` card + reconstruct-on-add.
4. **Teach — per-field scoping** (PR #18).
5. **Replay** (PR #19): `bundleToSectionItems` handles the added-back entry.

## Resolved decisions (operator, 2026-07-20)

- **D1 = HALT.** AI OFF + a required repeating field can't be filled deterministically → **halt the
  walk** (don't auto-delete to advance). Conservative-when-AI-off, matching the standing rule.
- **D2 = DELETE-WITH-MEMORY.** AI ON + a required field only inferable at LOW confidence → do NOT
  force a junk guess; delete the entry + remember + surface for add-back.
- **D3 = UNIFY.** Cert/Language route through the same AI-first-then-delete-remember flow.
- **D4 = SUPERSEDE.** Fill-time delete-with-memory replaces the "keep value-holding row + halt"
  Tier-1.5 fix; Tier-1.5 remediation shrinks to deleting only true empty orphans.

## Resolved decision tree (per repeating entry, at fill time)

```
Fill all fields deterministically.

IF AI is ON:
    for each still-missing field:
        stated value that didn't match  → AI CANONICALIZE (reword; clears the ladder → fill, flag ai-canonicalized)
        required + no profile value      → AI INFER (High/Med conf + clears the ladder → fill, flag ai-choice)
    → every REQUIRED field now filled     → KEEP the entry; flag ONLY the AI-filled fields.
    → a REQUIRED field still unfillable    → DELETE-WITH-MEMORY (delete entry, remember values + recon,
       (AI declined / LOW conf [D2] / no basis)   surface "removed — add back (prefilled)" in review).

IF AI is OFF:
    → every REQUIRED field filled deterministically → KEEP (normal).
    → a REQUIRED field unfilled:
         • OPTIONAL pick-section (cert / language, deleteOnNoMatch) AND a GENUINE no-match
           (the value the profile HAS simply isn't offered by this tenant) → this is a DETERMINISTIC
           resolution ("the optional entry can't exist here"), so DELETE-WITH-MEMORY + surface — do
           NOT halt on an optional entry. [operator-confirmed 2026-07-20]
         • otherwise (education / work-experience / websites — data you HAVE that must be filled, or
           an optional entry that merely wasn't ATTEMPTED) → HALT the walk. [D1]

Whole row empty (no field filled, no profile data) → delete, do NOT surface (true orphan).
```

DESIGN LOCKED (2026-07-20): every branch above is operator-confirmed. AI-OFF × cert/language resolved
to **delete-with-memory** — never halt on an optional entry; HALT is reserved for expected-data
sections (education / work-experience / websites).

## Build order (implementation, all under the locked design)

1. **Extension AI for repeating fields** (PR #19) — `fillEntryCdp`: canonicalize a stated-no-match
   DROPDOWN value; infer a required-empty DROPDOWN (mirroring the typeahead paths). Flag AI fields.
   - [x] **1a — canonicalize** DONE (2026-07-20): a repeating dropdown genuine-no-match with a stated
     value → `aiCanonicalizeField` → `ai-canonicalized` (the degree "Bachelor of Science"→"Bachelors"
     case). Test: `repeating dropdown AI canonicalize (Phase 1)`. Suite 610/610.
   - [ ] **1b — required-empty INFER** (folded into Phase 2, since a low-confidence infer must NOT
     force a value — it feeds the delete-with-memory decision, so it can't be a standalone commit).
2. **Extension delete-with-memory** (PR #19) — the unified entry-level decision in
   `driveRepeatingSectionCdp`: keep (flag AI) / delete-with-memory / halt, per the tree. Emit the
   `removed_entry` record with `remembered_fields` + recon. `buildReviewBundle`/`deriveReview` handle it.
   - [x] **2a — mechanism** DONE (2026-07-21): per-entry disposition keyed on `problemFields` (required
     fields not confidently resolved — unfilled OR unconfident-AI); AI-on → delete-with-memory, AI-off →
     optional-genuine-miss deletes / expected-data keeps→halts. New `makeRemovedEntry` → `removed_entry`
     record (`entry-removed-remembered`, `remembered_fields` {value, filled_by, recon}, `unfilled_fields`,
     `section_field_shape`/`nested_shapes`); `deriveReview` → needs_review `entry_removed`; bundle carries
     it; replay/reconPageTruth/finalize skip it. Old deleteOnNoMatch "removed"/emptied-stub tests migrated
     to `removed_entry`. Suite 612/612.
   - [ ] **2b — confident required-empty INFER** for repeating dropdowns/typeaheads (High/Med commits;
     Low → stays a problem field → delete-with-memory), reducing how often 2a deletes.
3. **Website add-back-with-prefill** (PR #18) — the `removed_entry` card + reconstruct-on-add.
4. **Teach per-field scoping** (PR #18).
5. **Replay** (PR #19) — `bundleToSectionItems` reconstructs an added-back entry.
