import { test } from "node:test";
import assert from "node:assert/strict";
import { addBackEntryRecords, approvalEnvelope } from "../lib/review-approval";
import type { RememberedField, ReviewEntry } from "../lib/review-summary";

// Phase 2 (delete-with-memory): reconstruct-with-prefill for a removed_entry add-back. A deterministic
// value comes back clean (approved-by-default); an AI value or an unfilled field needs review.
test("addBackEntryRecords: deterministic fields prefill clean; AI + unfilled fields need review", () => {
  const remembered: RememberedField[] = [
    { recName: "schoolName", path: "school_or_university", widget_type: "text", is_required: true, value: "Carnegie Mellon University", filled_by: "deterministic" },
    { recName: "degree", path: "degree", widget_type: "dropdown", is_required: true, value: "Bachelors", filled_by: "ai-canonicalized", options: ["Bachelors", "Masters"] },
    { recName: "fieldOfStudy", path: "field_of_study", widget_type: "typeahead", is_required: true, value: null, filled_by: "unfilled" },
  ];
  const recs = addBackEntryRecords(remembered, ["fieldOfStudy"], { page: "P2", sectionKey: "education", index: 1, at: "2026-07-21T00:00:00Z" });
  assert.equal(recs.length, 3);

  const school = recs.find((r) => r.canonical_field === "education[1].school_or_university")!;
  assert.equal(school.current_value, "Carnegie Mellon University", "deterministic value prefilled");
  assert.equal(school.needs_review, false, "a deterministic fill is clean (approved-by-default)");
  assert.equal(school.fill_status, "filled");
  assert.equal(school.is_added, true, "reconstructed = added → replay CREATES it");
  assert.equal(school.field_id, "P2::formField-education[1].schoolName");

  const deg = recs.find((r) => r.canonical_field === "education[1].degree")!;
  assert.equal(deg.current_value, "Bachelors", "AI value prefilled as a starting point");
  assert.equal(deg.needs_review, true, "an AI-filled value must be verified");
  assert.equal(deg.flag, "ai-canonicalized", "carries the AI provenance");
  assert.deepEqual(deg.options, ["Bachelors", "Masters"], "options ride along for the editor");

  const fos = recs.find((r) => r.canonical_field === "education[1].field_of_study")!;
  assert.equal(fos.current_value, null, "the unfilled field is blank for the operator to supply");
  assert.equal(fos.needs_review, true, "the missing field must be supplied");
  assert.equal(fos.fill_status, "not_filled");
  assert.equal(fos.flag, "added-entry");
});

test("addBackEntryRecords: empty remembered list → no records", () => {
  assert.deepEqual(addBackEntryRecords([], [], { sectionKey: "education", index: 0 }), []);
});


// ── The OUTCOME of the review page's "Today" button (operator 2026-07-28) ────────────────────────────
// "if today is pressed, automatically approve" — so one click must move the field from blocking to
// submit-ready. The button writes the value AND sets is_approved in ONE patch; these pin the envelope
// semantics that make that single click actually unblock a submit.
const dateEntry = (over: Partial<ReviewEntry>): ReviewEntry =>
  ({
    field_id: "P5::formField-dateSignedOn",
    page: "P5",
    question_label: "Date",
    widget_type: "date",
    is_required: true,
    needs_review: true,
    cascade_revealed: true,
    flag: "cascade-required",
    fill_status: "not_filled",
    current_value: null,
    ...over,
  }) as ReviewEntry;

test("approvalEnvelope: a cascade-required date BLOCKS while blank, and one click (value + approve) clears it", () => {
  const blank = approvalEnvelope([dateEntry({})]);
  assert.equal(blank.submit_ready, false, "blank + unapproved blocks");
  assert.equal(blank.pending_count, 1);
  assert.equal(blank.required_blank, 1, "and it is ALSO caught as a required-blank field");

  // What the Today click writes: the value and the approval, together.
  const done = approvalEnvelope([dateEntry({ current_value: "07/28/2026", is_approved: true, approved_at: "2026-07-28T00:00:00Z", is_edited: true, edit_kind: "filled_blank" })]);
  assert.equal(done.submit_ready, true, "one click makes it submit-ready");
  assert.equal(done.pending_count, 0);
  assert.equal(done.required_blank, 0);
});

test("approvalEnvelope: a value WITHOUT approval still blocks (the auto-approve is what does the work)", () => {
  const valueOnly = approvalEnvelope([dateEntry({ current_value: "07/28/2026", is_edited: true })]);
  assert.equal(valueOnly.required_blank, 0, "no longer blank…");
  assert.equal(valueOnly.submit_ready, false, "…but a flagged field still needs the approval");
  assert.equal(valueOnly.pending_count, 1);
});
