const test = require("node:test");
const assert = require("node:assert");
const { requiredBlankByLabel } = require("../lib.js");

// ── requiredBlankByLabel: a question that came back under a NEW automation-id (2026-08-06) ──────────
// Workday REMOUNTS a dependent question whenever the field it depends on changes, so the bundle can hold
// "Which basecamp…" filled under id A while the page shows the same question blank and required under
// id B. Both other pre-Save checks key on the BUNDLE's id and so report "in the bundle but NOT on the
// page — left alone, not fatal", and Save is then clicked into a rejection it cannot survive. Live on
// waystar page 3, repeatedly.
test("requiredBlankByLabel: maps the live BLANK id to the answer stored under the old id", () => {
  const live = [{ fieldName: "idB", label: "Which basecamp location?*", isRequired: true, widgetType: "dropdown", value: null }];
  const entries = [{ field_id: "pg::formField-idA", question_label: "Which basecamp location?*", current_value: "Atlanta, GA" }];
  const out = requiredBlankByLabel(live, entries);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].field.fieldName, "idB", "fills the id the page is using NOW");
  assert.strictEqual(out[0].fromName, "idA");
  assert.strictEqual(out[0].approved, "Atlanta, GA");
});

test("requiredBlankByLabel: does NOT fire when the entry's own field is still on the page", () => {
  // Not a remount — requiredBlankOnPage owns that case, and two checks re-filling one field would race.
  const live = [{ fieldName: "idA", label: "Which basecamp location?*", isRequired: true, widgetType: "dropdown", value: null }];
  const entries = [{ field_id: "pg::formField-idA", question_label: "Which basecamp location?*", current_value: "Atlanta, GA" }];
  assert.deepStrictEqual(requiredBlankByLabel(live, entries), []);
});

test("requiredBlankByLabel: never overwrites a field that HOLDS a value, and ignores optional/file fields", () => {
  const entries = [{ field_id: "pg::formField-idA", question_label: "Q*", current_value: "X" }];
  assert.deepStrictEqual(requiredBlankByLabel(
    [{ fieldName: "idB", label: "Q*", isRequired: true, widgetType: "dropdown", value: "already here" }], entries), []);
  assert.deepStrictEqual(requiredBlankByLabel(
    [{ fieldName: "idB", label: "Q*", isRequired: false, widgetType: "dropdown", value: null }], entries), []);
  assert.deepStrictEqual(requiredBlankByLabel(
    [{ fieldName: "idB", label: "Q*", isRequired: true, widgetType: "file_upload", value: null }], entries), []);
});

test("requiredBlankByLabel: an entry with NO value is not an answer (review owns it)", () => {
  const live = [{ fieldName: "idB", label: "Q*", isRequired: true, widgetType: "dropdown", value: null }];
  assert.deepStrictEqual(requiredBlankByLabel(live,
    [{ field_id: "pg::formField-idA", question_label: "Q*", current_value: "" }]), []);
});

test("requiredBlankByLabel: a dropdown on its PLACEHOLDER counts as blank", () => {
  // Live: the remounted basecamp field read "Select One", so a plain empty-string test saw it as FILLED
  // and the whole recovery silently did nothing — while Workday refused the page for that very field
  // being required. A placeholder is not an answer.
  const live = [{ fieldName: "idB", label: "Which basecamp location?*", isRequired: true, widgetType: "dropdown", value: "Select One" }];
  const entries = [{ field_id: "pg::formField-idA", question_label: "Which basecamp location?*", current_value: "Atlanta, GA" }];
  const out = requiredBlankByLabel(live, entries);
  assert.strictEqual(out.length, 1, "\"Select One\" is a placeholder, not a value");
  assert.strictEqual(out[0].approved, "Atlanta, GA");
});
