import { test } from "node:test";
import assert from "node:assert/strict";
import { explainFill } from "../lib/review-model";
import type { ReviewEntry } from "../lib/review-summary";

// explainFill turns the engine's terse `detail` log line into intuitive, applicant-facing copy on the
// review card. Contract: the FRONTEND never shows the raw engine string — the precise `detail` stays in
// the bundle + service-worker logs for debugging.
const mk = (e: Partial<ReviewEntry>): ReviewEntry =>
  ({
    field_id: "P::formField-x",
    page: "P",
    question_label: "Q",
    widget_type: "dropdown",
    canonical_field: "education[0].degree",
    is_required: true,
    needs_review: true,
    fill_status: "filled",
    ...e,
  }) as ReviewEntry;

test("ai-canonicalized: names the profile value it mapped FROM and the option it chose", () => {
  const msg = explainFill(
    mk({
      flag: "ai-canonicalized",
      current_value: "Bachelors",
      detail: 'AI canonicalized stated "Bachelor of Science" → "Bachelors" (vocab map, not inferred)',
    })
  )!;
  assert.match(msg, /Bachelor of Science/, "quotes the profile value");
  assert.match(msg, /Bachelors/, "quotes the chosen option");
  assert.match(msg, /wasn’t an exact option/, "explains WHY it needed matching");
  assert.doesNotMatch(msg, /vocab map|canonicalized/, "no raw engine jargon on the frontend");
});

test("ai-choice represented (flat typeahead): reads as a match, not an inference", () => {
  const msg = explainFill(
    mk({
      flag: "ai-choice",
      match_tier: "ai-choice",
      current_value: "Electrical Engineering",
      detail: 'AI: "Electrical Engineering" (genuinely represented in the list)',
    })
  )!;
  assert.match(msg, /matched it to the closest one — “Electrical Engineering”/);
  assert.doesNotMatch(msg, /represented in the list/, "no raw engine string");
});

test("ai-choice source-tree: distinct phrasing from a flat pick", () => {
  const msg = explainFill(mk({ flag: "ai-choice", match_tier: "ai-source-tree", current_value: "LinkedIn" }))!;
  assert.match(msg, /in this form’s list/);
});

test("ai-closest-forced: flags it as the riskiest answer", () => {
  const msg = explainFill(mk({ flag: "ai-closest-forced", current_value: "Nearest", confidence: "low" }))!;
  assert.match(msg, /required/);
  assert.match(msg, /Double-check this one/);
});

test("ai-eeo-guess: says you didn't state it and to verify/clear", () => {
  const msg = explainFill(mk({ flag: "ai-eeo-guess", current_value: "Prefer not to say" }))!;
  assert.match(msg, /didn’t state this/);
  assert.match(msg, /Verify or clear/);
});

test("bucket: reads as a taught answer, not an AI guess", () => {
  const msg = explainFill(mk({ flag: "bucket", current_value: "Yes", needs_review: true }))!;
  assert.match(msg, /taught ApplyPilot/);
});

test("deterministic containment/fuzzy: closest-match phrasing", () => {
  const msg = explainFill(mk({ flag: null, match_tier: "containment", current_value: "United States" }))!;
  assert.match(msg, /closest match/);
});

test("unknown flag with a technical detail → generic intuitive line, NEVER the raw detail", () => {
  const raw = "audit-mismatch before=X after=Y auditLoc=div[data-automation-id]";
  const msg = explainFill(mk({ flag: "audit-mismatch", current_value: "Y", detail: raw }))!;
  assert.doesNotMatch(msg, /auditLoc|before=|after=/, "raw engine detail is not surfaced");
  assert.match(msg, /double-check/i);
});

test("a truly unrecognized needs_review flag falls back to an intuitive nudge, not the raw detail", () => {
  const msg = explainFill(mk({ flag: "some-future-flag", detail: "internal debug string", needs_review: true }))!;
  assert.equal(msg, "Please double-check this field.");
});

test("not flagged, no detail → nothing to say", () => {
  assert.equal(explainFill(mk({ flag: null, detail: null, needs_review: false, fill_status: "filled" })), null);
});
