// test/relocation-site-pick.test.js — "WHICH places?" is not "WOULD you move?".
//
// Live 2026-09-08, Intel (Workday). A REQUIRED multi-select of Intel's sites:
//
//   "Please indicate your geographical preference by marking sites of interest including areas you
//    are open to relocating to:*"
//   → Austin, TX · Chandler, AZ · Folsom, CA · Hillsboro, OR · Hudson, MA · New Albany, OH ·
//     Rio Rancho, NM · Santa Clara, CA · San Jose, CA · All · Other
//
// The phrase "open to relocating to" tripped the relocation recognizer, which returned `willing` and
// supplied `["Yes","True"]` from screening.willing_to_relocate. No option can ever match that, so the
// group stayed empty — and because a rung HAD "answered", the AI rescue downstream was gated out on
// `record.resolved == null`. The required field ended blank, the walk halted `required-unfilled`, and
// the operator got a picker with 11 options and no answer.
//
// The profile cannot answer this question in ANY case: willing_to_relocate is a yes/no preference and
// holds no opinion about Folsom vs Hillsboro. Refusing is what lets the AI answer it and reach review.
//
// Run: node --test test/relocation-site-pick.test.js

const test = require("node:test");
const assert = require("node:assert");
const { recognizeRelocationQuestion, relocationCandidates } = require("../lib.js");

const INTEL = "Please indicate your geographical preference by marking sites of interest including areas you are open to relocating to:*";

test("⚠⚠ the Intel wording is REFUSED — it asks which places, not whether", () => {
  assert.strictEqual(recognizeRelocationQuestion(INTEL), null);
});

test("⚠ a refusal is what keeps the yes/no candidates away from a site list", () => {
  // The regression in one assertion: before the fix this produced ["Yes","True"] for a list of cities.
  const kind = recognizeRelocationQuestion(INTEL);
  assert.strictEqual(kind, null);
  // and the caller therefore has nothing to offer, which is the state the AI rescue keys on
  assert.strictEqual(kind && relocationCandidates({ willing_to_relocate: true }, kind), null);
});

test("other ways a form asks WHICH places are refused too", () => {
  for (const q of [
    "Select the sites of interest you would consider relocating to",
    "Please mark the locations you are willing to relocate to",
    "Indicate your geographic preference for relocation",
    "Which offices would you be willing to relocate to?",
    "Rank the campuses you are open to relocating to",
    "Choose the cities you would relocate to",
    // still a places question even when it mentions cost — checked BEFORE own_cost on purpose
    "Mark the sites you would relocate to at your own expense",
  ]) assert.strictEqual(recognizeRelocationQuestion(q), null, q);
});

test("⚠ a GENUINE willingness question that merely NAMES a place is still answered", () => {
  // The refusal is deliberately narrow: a bare place word must never be enough, or the rung stops
  // answering the questions it exists for and every one becomes a flagged AI guess.
  for (const q of [
    "Are you willing to relocate?",
    "Would you be open to relocating for this role?",
    "Are you willing to relocate to a different location?",
    "Would you relocate to one of our offices?",
    "Are you willing to move for this position?",
    "This role is based in Austin, TX. Are you willing to relocate?",
  ]) assert.deepStrictEqual(recognizeRelocationQuestion(q), { kind: "willing" }, q);
});

test("⚠ the own-cost and employer-provision rulings are unchanged", () => {
  assert.deepStrictEqual(recognizeRelocationQuestion("Are you willing to relocate at your own expense?"), { kind: "own_cost" });
  assert.deepStrictEqual(recognizeRelocationQuestion("Would you relocate without relocation assistance?"), { kind: "own_cost" });
  assert.strictEqual(recognizeRelocationQuestion("Do you require relocation assistance?"), null);
  assert.strictEqual(recognizeRelocationQuestion("Will relocation expenses be reimbursed?"), null);
  assert.strictEqual(recognizeRelocationQuestion("Have you ever relocated for a job?"), null);
  assert.strictEqual(recognizeRelocationQuestion("What is your favourite colour?"), null);
  assert.strictEqual(recognizeRelocationQuestion(""), null);
  assert.strictEqual(recognizeRelocationQuestion(null), null);
});

test("candidates still come from the stated preference, and an unstated one stays unstated", () => {
  assert.deepStrictEqual(relocationCandidates({ willing_to_relocate: true }, { kind: "willing" }).candidates, ["Yes", "True"]);
  assert.deepStrictEqual(relocationCandidates({ willing_to_relocate: false }, { kind: "willing" }).candidates, ["No", "False"]);
  assert.deepStrictEqual(relocationCandidates({}, { kind: "willing" }), { unstated: true });
});
