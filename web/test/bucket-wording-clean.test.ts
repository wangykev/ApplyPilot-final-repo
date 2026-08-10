import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanWording, cleanWordings, coerceBuckets, bucketsSchema, normalizeQuestion } from "../lib/buckets";

test("the required marker is stripped from a stored wording", () => {
  assert.equal(cleanWording("Language*"), "Language");
  assert.equal(cleanWording("Language *"), "Language");
  assert.equal(cleanWording("Language**"), "Language");
  assert.equal(cleanWording("  Are you over 18? *  "), "Are you over 18?");
});

test("an asterisk that is NOT trailing is real text and survives", () => {
  assert.equal(cleanWording("Rate 1-5 (5 = best*)"), "Rate 1-5 (5 = best*)");
  assert.equal(cleanWording("A*B code"), "A*B code");
});

test("cleaning collapses the duplicate it creates, keeping the first spelling", () => {
  assert.deepEqual(cleanWordings(["Language*", "Language", "LANGUAGE *"]), ["Language"]);
  assert.deepEqual(cleanWordings(["Gender", "Gender*"]), ["Gender"]);
});

test("empties are dropped rather than stored as blank wordings", () => {
  assert.deepEqual(cleanWordings(["*", "  ", "", "Real question"]), ["Real question"]);
});

test("EXISTING buckets clean themselves on load — no migration needed", () => {
  const stored = [
    { id: "x", profile_path: "a.b", value: [], category: "", widget_hint: "", questions: ["Language*", "Language"], selectors: {} },
  ];
  assert.deepEqual(coerceBuckets(stored)[0].questions, ["Language"]);
});

test("and on SAVE, so a cleaned bucket persists cleaned", () => {
  const parsed = bucketsSchema.safeParse([
    { id: "x", profile_path: "a.b", value: [], category: "", widget_hint: "", questions: ["Are you at least 18?*"], selectors: {} },
  ]);
  assert.ok(parsed.success);
  assert.deepEqual(parsed.data[0].questions, ["Are you at least 18?"]);
});

test("matching is unaffected — it already ignored the marker", () => {
  // The live form label still arrives with its asterisk; normalizeQuestion strips it on both sides,
  // so a bucket stored without one still matches a form that shows one.
  assert.equal(normalizeQuestion("Language*"), normalizeQuestion(cleanWording("Language*")));
  assert.equal(normalizeQuestion("Language*"), "language");
});

test("cleaning is idempotent", () => {
  const once = cleanWordings(["Language*", "Gender *"]);
  assert.deepEqual(cleanWordings(once), once);
});
