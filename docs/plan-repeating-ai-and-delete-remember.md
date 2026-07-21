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

## Open decisions (need operator confirmation)

- **D1 — AI-off + required repeating field unfillable:** delete-with-memory (advance + surface) vs
  halt. Proposal: **delete-with-memory** (repeating rows are re-addable; halting is worse UX).
- **D2 — Low-confidence inference on a required repeating field:** force a guess (flat-field style)
  vs delete-with-memory. Proposal: **delete-with-memory** (no junk value on the form).
- **D3 — deleteOnNoMatch sections (cert/language):** route through the SAME AI-first-then-delete-
  remember logic (unify) vs keep their current fill-time delete. Proposal: **unify.**
- **D4 — Does the recent "keep value-holding row + halt" Tier-1.5 fix get superseded?** Proposal:
  **yes** — the fill-time delete-with-memory replaces it; Tier-1.5's role shrinks to true orphans.
