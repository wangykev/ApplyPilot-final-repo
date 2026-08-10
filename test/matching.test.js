// Unit tests for the lib.js option-matching ladder — the SW-side copies the CDP
// fill driver uses (TODO(dup): intentional duplicates of fillEngine's inline
// versions; these tests pin the shared behavior both must keep).
const { test } = require("node:test");
const assert = require("node:assert");
const { normalize, fuzzyRatio, matchCandidates, isPolarityToken, polarityLeadIndex } = require("../lib.js");

// ── Tier 1.5: POLARITY LEAD (operator, 2026-08-09) ───────────────────────────────────────────────
// "if the answer begins with the answer I have in my ladder, it is correct ... it doesn't matter how it
// elaborates if it begins with no and that is my answer." Deterministic: no review, no teach.

test("polarity-lead: a stored 'No' fills a verbose 'No, I do not require sponsorship'", () => {
  const opts = ["Yes, I will require sponsorship now or in the future", "No, I do not require sponsorship"];
  const r = matchCandidates(["No"], opts, { containment: false }); // dropdown ⇒ containment OFF; this tier still fires
  assert.strictEqual(r.targetIndex, 1);
  assert.strictEqual(r.matchTier, "polarity-lead");
});

test("polarity-lead REFUSES when two options lead with the same polarity — the dangerous split", () => {
  // These lead identically and mean opposite things to the employer; guessing either is unacceptable.
  const opts = [
    "No, I do not now or in the future require sponsorship",
    "No, I do not now, but I will in the future require sponsorship",
    "Yes",
  ];
  const r = matchCandidates(["No"], opts, { containment: false });
  assert.strictEqual(r.targetIndex, -1, "ambiguous polarity must escalate to review, never pick the first");
});

test("polarity-lead is word-anchored — 'No' does not lead-match 'November'", () => {
  const r = matchCandidates(["No"], ["November", "December"], { containment: false });
  assert.strictEqual(r.targetIndex, -1);
});

test("polarity-lead only applies to BARE yes/no answers, never an arbitrary value", () => {
  // Allowing any string would let "Bachelor" silently claim the longer degree — the exact guess the
  // containment rule exists to refuse.
  const r = matchCandidates(["Bachelor"], ["Bachelor of Science in Underwater Basket Weaving"], { containment: false });
  assert.strictEqual(r.targetIndex, -1);
  assert.strictEqual(isPolarityToken("Bachelor"), false);
  assert.strictEqual(isPolarityToken("no"), true);
  assert.strictEqual(isPolarityToken("TRUE"), true);
});

test("polarity-lead: booleans coerce, and EXACT still wins over the lead tier", () => {
  assert.strictEqual(polarityLeadIndex(["Yes, always", "No, never"], "false"), 1);
  const r = matchCandidates(["No"], ["No", "No, with conditions"], { containment: false });
  assert.strictEqual(r.matchTier, "exact-normalized", "a bare exact option is preferred over a verbose lead");
  assert.strictEqual(r.targetIndex, 0);
});

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

// CONTAINMENT is WIDGET-DEPENDENT (2026-07-16). It is ON by default for TYPE-and-complete widgets
// (typeahead / cert / source — the typed partial ⊆ the widget's completion is the correct commit signal)
// and OFF for SELECT-from-list widgets (dropdown / radio) via {containment:false} — there a substring is
// a GUESS ("PA"→"Armed Forces Pacific"), so those escalate to review (exact → typo → review; the operator
// picks the option / teaches a bucket → an exact match next time). A 2-char candidate never mid-string-
// matches even when containment is ON (short-candidate guard).

// ── containment ON (default: typeahead / cert / source) ──
test("containment ON (default): a typed partial commits the widget's completion (cert prefix)", () => {
  const m = matchCandidates(["Training Instructor - AEVO"], ["Training Instructor - AEVO - Multiple Recognized Providers"]);
  assert.strictEqual(m.targetIndex, 0);
  assert.strictEqual(m.matchTier, "containment");
});

test("containment ON (default): startsWith commits when unambiguous (Bachelor→Bachelors)", () => {
  const m = matchCandidates(["Bachelor"], ["Masters", "Bachelors"]);
  assert.strictEqual(m.targetIndex, 1);
  assert.strictEqual(m.matchTier, "containment");
});

test("containment ON (default): AMBIGUITY-SAFE — a candidate that is a prefix of 2+ options escalates", () => {
  const m = matchCandidates(["United States"], ["United States of America (+1)", "United States Virgin Islands"]);
  assert.strictEqual(m.targetIndex, -1);
  assert.strictEqual(m.matchTier, null);
});

test("containment ON (default): SHORT-CANDIDATE guard — a 2-char value never mid-string-matches → escalates", () => {
  // "pa" is a substring of "...PAcific" and it's the ONLY option containing it, so the ambiguity guard
  // can't help — but a 2-char candidate must not commit by mid-string includes even on the typeahead path.
  const m = matchCandidates(["PA"], ["Armed Forces Pacific", "California", "New York"]);
  assert.strictEqual(m.targetIndex, -1);
  assert.strictEqual(m.matchTier, null);
});

test("containment ON (default): a 3-char credential abbrev still mid-string-matches (PhD/MBA kept)", () => {
  const m = matchCandidates(["PhD"], ["Master of Science", "Doctor of Philosophy (PhD)"]);
  assert.strictEqual(m.targetIndex, 1);
  assert.strictEqual(m.matchTier, "containment");
});

// ── containment OFF ({containment:false}: dropdown / radio — select from a full list) ──
test("containment OFF (dropdown/radio): the PA→'Armed Forces Pacific' bug can't happen → escalates", () => {
  const m = matchCandidates(["PA"], ["Armed Forces Pacific", "California", "New York"], { containment: false });
  assert.strictEqual(m.targetIndex, -1);
  assert.strictEqual(m.matchTier, null);
});

test("containment OFF (dropdown/radio): a prefix no longer auto-fills (Bachelor→Bachelors) → escalates", () => {
  // 89% fuzzy (one insert over 9) is just under the 90 typo bar → review, not a silent guess.
  const m = matchCandidates(["Bachelor"], ["Masters", "Bachelors"], { containment: false });
  assert.strictEqual(m.targetIndex, -1);
  assert.strictEqual(m.matchTier, null);
  assert.strictEqual(fuzzyRatio("bachelor", "bachelors"), 89);
});

test("containment OFF (dropdown/radio): exact still fills, and a real typo still fuzzy-matches", () => {
  assert.strictEqual(
    matchCandidates(["Canada"], ["Canada (+1)", "United States"], { containment: false }).matchTier,
    "exact-normalized"
  );
  const f = matchCandidates(["enginering"], ["Marketing", "Engineering"], { containment: false });
  assert.strictEqual(f.targetIndex, 1);
  assert.strictEqual(f.matchTier, "fuzzy-91");
});

test("exact still beats everything: the tiered '(+1)' candidate exact-normalizes, no fuzzy needed", () => {
  const m = matchCandidates(["United States of America (+1)", "United States"], ["United States of America"]);
  assert.strictEqual(m.targetIndex, 0);
  assert.strictEqual(m.matchTier, "exact-normalized");
});

test("tier 2: fuzzy >= 90 is typo tolerance only", () => {
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

// ── a rejected report must be LOUD, and name the cause it can name (2026-08-06) ──────────────────────
test("reportOutcome: 2xx is silent success; 401/403 names the key rotation; others are loud too", () => {
  const lib = require("../lib.js");
  for (const ok of [200, 201, 204]) {
    const r = lib.reportOutcome(ok);
    assert.strictEqual(r.ok, true, ok + " is success");
    assert.strictEqual(r.loud, false, "a healthy report says nothing extra");
  }
  for (const stale of [401, 403]) {
    const r = lib.reportOutcome(stale);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.loud, true);
    assert.strictEqual(r.reason, "stale-key", stale + " is the rotated-key case");
    assert.match(r.message, /Sync everything/, "it must say how to fix it");
    assert.match(r.message, /nothing reached the tracker/i, "and what was lost");
  }
  // a server error is not a key problem, but is still not silence
  const err = lib.reportOutcome(500);
  assert.strictEqual(err.reason, "http-500");
  assert.strictEqual(err.loud, true);
  assert.doesNotMatch(err.message, /key/i, "do not blame the key for a server fault");
  // no response at all (fetch threw / site down) is its own case
  const none = lib.reportOutcome(undefined);
  assert.strictEqual(none.reason, "no-response");
  assert.strictEqual(none.loud, true);
});
