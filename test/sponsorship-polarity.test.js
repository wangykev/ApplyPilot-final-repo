const test = require("node:test");
const assert = require("node:assert/strict");
const { matchCandidates } = require("../lib.js");
const { flagTierCategory, resolve } = require("../fill-driver.js");

// The end-to-end shape of the sponsorship answer, as the fill actually performs it: a stored boolean
// becomes a tiered candidate list, the list meets the tenant's option text, and the resulting tier
// decides whether it lands silently or in the review pile. Each link is pinned, because the live card
// that prompted this looked like a ladder failure and was in fact a missing profile binding.

const ADI_OPTIONS = [
  "Yes, I require sponsorship now or in the future",
  "No, I do not require sponsorship.",
];

test("a stored FALSE becomes the Yes/No candidate ladder", () => {
  const r = resolve(false, "dropdown");
  assert.ok(!r.skip);
  assert.deepEqual(r.candidates, ["No", "False"]);
});

test("the ladder picks the option that LEADS with No, not by containment", () => {
  const r = matchCandidates(["No", "False"], ADI_OPTIONS, { containment: false });
  assert.equal(r.targetIndex, 1);
  assert.equal(r.matchTier, "polarity-lead");
});

test("…and Yes picks the Yes-leading option", () => {
  const r = matchCandidates(["Yes", "True"], ADI_OPTIONS, { containment: false });
  assert.equal(r.targetIndex, 0);
  assert.equal(r.matchTier, "polarity-lead");
});

test("polarity-lead grades as EXACT, so it fills silently instead of going to review", () => {
  // If this graded anything else the answer would land in the review pile — which is precisely the
  // state the operator reported.
  assert.equal(flagTierCategory("polarity-lead"), "exact");
});

test("SAFETY: a tenant that splits one polarity into two meanings still escalates", () => {
  // Two No-leading options = genuinely ambiguous; guessing between them would be a false statement.
  const split = [
    "Yes, I require sponsorship",
    "No, I do not now require sponsorship",
    "No, I do not now but WILL in the future require sponsorship",
  ];
  const r = matchCandidates(["No", "False"], split, { containment: false });
  assert.notEqual(r.matchTier, "polarity-lead");
});
