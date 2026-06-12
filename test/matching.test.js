// Unit tests for the lib.js option-matching ladder — the SW-side copies the CDP
// fill driver uses (TODO(dup): intentional duplicates of fillEngine's inline
// versions; these tests pin the shared behavior both must keep).
const { test } = require("node:test");
const assert = require("node:assert");
const { normalize, fuzzyRatio, matchCandidates } = require("../lib.js");

test("normalize lowercases, strips a trailing (+digits), collapses whitespace", () => {
  assert.strictEqual(normalize("United States of America (+1)"), "united states of america");
  assert.strictEqual(normalize("  Mobile   Phone "), "mobile phone");
  assert.strictEqual(normalize("Canada"), "canada");
});

test("tier 1: exact-normalized — profile value matches the rendered '(+1)' option", () => {
  const m = matchCandidates(["United States of America"], ["Canada (+1)", "United States of America (+1)"]);
  assert.strictEqual(m.targetIndex, 1);
  assert.strictEqual(m.matchTier, "exact-normalized");
});

test("candidates are tried in order — most-specific first wins the tier", () => {
  const m = matchCandidates(["United States of America (+1)", "United States"], ["United States of America"]);
  assert.strictEqual(m.targetIndex, 0);
  assert.strictEqual(m.matchTier, "exact-normalized");
  assert.strictEqual(m.matchedCandidate, "United States of America (+1)");
});

test("tier 2: containment — startsWith before includes", () => {
  const m = matchCandidates(["Bachelor"], ["Masters", "Bachelors"]);
  assert.strictEqual(m.targetIndex, 1);
  assert.strictEqual(m.matchTier, "containment");
});

test("tier 3: fuzzy >= 90 is typo tolerance only", () => {
  // "enginering" (typo) vs "Engineering": distance 1 over 11 → ratio 91 (>= 90).
  const m = matchCandidates(["enginering"], ["Marketing", "Engineering"]);
  assert.strictEqual(m.targetIndex, 1);
  assert.strictEqual(m.matchTier, "fuzzy-91");
  assert.strictEqual(fuzzyRatio("enginering", "engineering"), 91);
});

test("below the 90 bar → targetIndex -1 (escalate, never guess)", () => {
  const m = matchCandidates(["Electrical and Computer Engineering"], ["Accounting", "Anthropology"]);
  assert.strictEqual(m.targetIndex, -1);
  assert.strictEqual(m.matchTier, null);
});
