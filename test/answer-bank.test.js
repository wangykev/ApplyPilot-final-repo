// Unit tests for the answer-bank helpers (lib.js) — the Profile Learning data layer (M1).
// The answerBank remembers human-confirmed answers to UNMAPPED fields, keyed by the normalized
// question label, so a future application auto-fills the same question. These helpers are PURE:
// they operate on a plain bank object and return a NEW one (chrome.storage I/O lives elsewhere).
// See docs/profile-learning-plan.md.

const test = require("node:test");
const assert = require("node:assert");
const {
  answerKey,
  isRememberableWidget,
  getRememberedAnswer,
  putRememberedAnswer,
  deleteRememberedAnswer,
} = require("../lib.js");

test("answerKey: normalizes to a tenant-agnostic key (lowercase, trailing */whitespace stripped, internal whitespace collapsed)", () => {
  assert.strictEqual(answerKey("Are you legally authorized to work in the US?*"), "are you legally authorized to work in the us?");
  assert.strictEqual(answerKey("Are you legally authorized to work in the US?**"), "are you legally authorized to work in the us?");
  assert.strictEqual(answerKey("  Gender   Identity  "), "gender identity");
  assert.strictEqual(answerKey("GENDER identity *"), "gender identity");
  // the same question with/without the required marker + case + spacing → the SAME key
  assert.strictEqual(answerKey("Do you require sponsorship? *"), answerKey("do you require sponsorship?"));
  assert.strictEqual(answerKey(""), "");
  assert.strictEqual(answerKey(null), "");
  assert.strictEqual(answerKey(undefined), "");
});

test("isRememberableWidget: choice + short text + checkbox yes; essay/textarea, file_upload, unknown no", () => {
  for (const w of ["text", "dropdown", "radio", "typeahead", "checkbox"]) {
    assert.strictEqual(isRememberableWidget(w), true, `${w} should be rememberable`);
  }
  for (const w of ["textarea", "file_upload", "unknown", "section", "", null, undefined]) {
    assert.strictEqual(isRememberableWidget(w), false, `${JSON.stringify(w)} should NOT be rememberable`);
  }
});

test("getRememberedAnswer: hit is case/whitespace/asterisk-insensitive; miss + blank label + bad bank → null", () => {
  const bank = { "are you legally authorized to work in the us?": { value: "Yes", widgetType: "radio" } };
  // the stored key matches regardless of how the live label is cased/marked
  assert.deepStrictEqual(getRememberedAnswer(bank, "Are you legally authorized to work in the US?*"), { value: "Yes", widgetType: "radio" });
  assert.strictEqual(getRememberedAnswer(bank, "some other question"), null, "miss → null");
  assert.strictEqual(getRememberedAnswer(bank, ""), null, "a blank label never keys");
  assert.strictEqual(getRememberedAnswer(bank, "   "), null, "a whitespace-only label never keys");
  assert.strictEqual(getRememberedAnswer(null, "x"), null, "no bank → null");
  assert.strictEqual(getRememberedAnswer({}, "x"), null, "empty bank → null");
});

test("putRememberedAnswer: stores under the normalized key with full metadata; preserves other entries; does not mutate the input", () => {
  const bank = { "existing question": { value: "kept", widgetType: "text", questionText: "existing question", sensitive: false, savedAt: 0 } };
  const out = putRememberedAnswer(bank, {
    label: "What is your GENDER? *",
    value: "Male",
    widgetType: "dropdown",
    questionText: "What is your GENDER? *",
    sensitive: true,
    savedAt: 123,
  });
  assert.deepStrictEqual(out["what is your gender?"], {
    value: "Male", questionText: "What is your GENDER? *", widgetType: "dropdown", sensitive: true, savedAt: 123,
  }, "stored under the normalized key with metadata");
  assert.ok(out["existing question"], "other entries preserved");
  assert.strictEqual(bank["what is your gender?"], undefined, "input bank NOT mutated");
  assert.notStrictEqual(out, bank, "returns a new object");
});

test("putRememberedAnswer: a boolean value (checkbox) is stored as 'true'/'false'; questionText defaults to the label", () => {
  const on = putRememberedAnswer({}, { label: "I agree to the optional survey", value: true, widgetType: "checkbox" });
  assert.strictEqual(on["i agree to the optional survey"].value, "true");
  assert.strictEqual(on["i agree to the optional survey"].questionText, "I agree to the optional survey", "questionText defaults to the label when not given");
  const off = putRememberedAnswer({}, { label: "I agree to the optional survey", value: false, widgetType: "checkbox" });
  assert.strictEqual(off["i agree to the optional survey"].value, "false", "false is a legitimate remembered checkbox state");
});

test("putRememberedAnswer: no-op on a blank label or a null/empty-string value (never persist a keyless/valueless answer)", () => {
  const bank = { keep: { value: "v" } };
  assert.strictEqual(putRememberedAnswer(bank, { label: "", value: "x" }), bank, "blank label → same bank, unchanged");
  assert.strictEqual(putRememberedAnswer(bank, { label: "q", value: null }), bank, "null value → no-op");
  assert.strictEqual(putRememberedAnswer(bank, { label: "q", value: "   " }), bank, "empty-string value → no-op");
  assert.strictEqual(putRememberedAnswer(bank, null), bank, "no entry → no-op");
  // a fresh no-op on a null bank yields an empty object, never throws
  assert.deepStrictEqual(putRememberedAnswer(null, { label: "", value: "x" }), {});
});

test("putRememberedAnswer: writing the same key overwrites in place (no duplicate)", () => {
  let bank = putRememberedAnswer({}, { label: "Q?", value: "No", widgetType: "radio" });
  bank = putRememberedAnswer(bank, { label: "q? ", value: "Yes", widgetType: "radio" }); // same normalized key
  assert.strictEqual(Object.keys(bank).length, 1, "still one entry");
  assert.strictEqual(bank["q?"].value, "Yes", "overwritten with the newer value");
});

test("deleteRememberedAnswer: removes by normalized key; no-op if absent; does not mutate the input", () => {
  const bank = { "q one": { value: "a" }, "q two": { value: "b" } };
  const out = deleteRememberedAnswer(bank, "Q ONE *");
  assert.strictEqual(out["q one"], undefined, "removed");
  assert.ok(out["q two"], "other entries preserved");
  assert.ok(bank["q one"], "input NOT mutated");
  assert.strictEqual(deleteRememberedAnswer(bank, "not present"), bank, "absent key → same bank, unchanged");
  assert.strictEqual(deleteRememberedAnswer(bank, ""), bank, "blank label → no-op");
});
