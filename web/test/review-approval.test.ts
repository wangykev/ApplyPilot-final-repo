import { test } from "node:test";
import assert from "node:assert/strict";
import { addBackEntryRecords } from "../lib/review-approval";
import type { RememberedField } from "../lib/review-summary";

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
