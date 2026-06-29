// Unit tests for summary-lib.js — the PURE helpers behind the review-summary viewer
// (edit provenance, checkbox token families, the effective-replay value, and the Plan-2
// approval roll-up). The viewer (summary.js) is DOM/chrome.* and untestable here; these are
// the logic seams it (and the future SUBMIT) depend on — the first tests for the summary path.
const { test } = require("node:test");
const assert = require("node:assert");
const { editKindOf, checkedOf, tokenFor, effectiveValue, requiresApproval, approvalEnvelope, submitReady, hasPlaceholder, SUMMARY_PLACEHOLDER_MARK } = require("../summary-lib.js");

// ── editKindOf — the replay provenance ──
test("editKindOf: unedited → null (original === current)", () => {
  assert.strictEqual(editKindOf({ original_ai_value: "Bachelors", current_value: "Bachelors" }), null);
  assert.strictEqual(editKindOf({ original_ai_value: null, current_value: null }), null);
  assert.strictEqual(editKindOf({ original_ai_value: "", current_value: null }), null); // "" and null normalize equal
});
test("editKindOf: bot left blank, human filled → filled_blank", () => {
  assert.strictEqual(editKindOf({ original_ai_value: null, current_value: "Masters" }), "filled_blank");
});
test("editKindOf: bot filled, human cleared → cleared", () => {
  assert.strictEqual(editKindOf({ original_ai_value: "Masters", current_value: null }), "cleared");
});
test("editKindOf: human changed a filled value → override", () => {
  assert.strictEqual(editKindOf({ original_ai_value: "Bachelors", current_value: "Masters" }), "override");
});

// ── checkbox token families ──
test("checkedOf: recognizes the truthy token family + boolean", () => {
  for (const v of [true, "Checked", "true", "Yes", "1", "on", "ON"]) assert.strictEqual(checkedOf(v), true, `${v}`);
  for (const v of [false, "Unchecked", "No", "0", "off", null, ""]) assert.strictEqual(checkedOf(v), false, `${v}`);
});
test("tokenFor: round-trips within the bot's original family (no false override on flip-back)", () => {
  // original "Yes" → uncheck → "No" → re-check → "Yes" (same family, so editKindOf reads it correctly)
  assert.strictEqual(tokenFor("Yes", false), "No");
  assert.strictEqual(tokenFor("Yes", true), "Yes");
  assert.strictEqual(tokenFor("Checked", false), "Unchecked");
  assert.strictEqual(tokenFor("True", false), "False");
  assert.strictEqual(tokenFor(true, false), false);   // boolean original → boolean token
  assert.strictEqual(tokenFor(true, true), true);
  assert.strictEqual(tokenFor("weird", true), "Checked"); // unknown family → default
});
test("tokenFor + editKindOf: flipping a checkbox back to the bot's state reads as NOT edited", () => {
  const orig = "Yes";
  const off = tokenFor(orig, false);                          // "No"
  assert.strictEqual(editKindOf({ original_ai_value: orig, current_value: off }), "override");
  const backOn = tokenFor(orig, true);                        // "Yes"
  assert.strictEqual(editKindOf({ original_ai_value: orig, current_value: backOn }), null); // not edited
});

// ── effectiveValue — what SUBMIT (Plan 1) replays ──
test("effectiveValue: returns the edited value + kind + approved + deleted", () => {
  const e = { original_ai_value: "Bachelors", current_value: "Masters", is_approved: true, is_deleted: false };
  assert.deepStrictEqual(effectiveValue(e), { value: "Masters", kind: "override", approved: true, deleted: false });
});
test("effectiveValue: a cleared field → value null, kind cleared", () => {
  assert.deepStrictEqual(effectiveValue({ original_ai_value: "X", current_value: null }), { value: null, kind: "cleared", approved: false, deleted: false });
});
test("effectiveValue: a soft-deleted entry is flagged deleted (SUBMIT skips it)", () => {
  assert.strictEqual(effectiveValue({ original_ai_value: "X", current_value: "X", is_deleted: true }).deleted, true);
});

// ── placeholder detection (lockstep marker) ──
test("hasPlaceholder: detects the AI-2 sentinel", () => {
  assert.strictEqual(hasPlaceholder(SUMMARY_PLACEHOLDER_MARK + " — tell us why]"), true);
  assert.strictEqual(hasPlaceholder("a normal answer"), false);
  assert.strictEqual(hasPlaceholder(null), false);
});

// ── requiresApproval — only flagged, non-deleted fields ──
test("requiresApproval: flagged yes; un-flagged approved-by-default (no); deleted no", () => {
  assert.strictEqual(requiresApproval({ needs_review: true }), true);
  assert.strictEqual(requiresApproval({ needs_review: false }), false);          // un-flagged → approved by default
  assert.strictEqual(requiresApproval({ needs_review: true, is_deleted: true }), false);
});

// ── approvalEnvelope / submitReady ──
const mk = (over) => Object.assign({ needs_review: false, is_approved: false, is_deleted: false, flag: null, current_value: null }, over);

test("approvalEnvelope: un-flagged-only bundle is submit_ready immediately (nothing to approve)", () => {
  const ap = approvalEnvelope([mk({}), mk({})]);
  assert.strictEqual(ap.to_approve_count, 0);
  assert.strictEqual(ap.all_approved, true);
  assert.strictEqual(ap.submit_ready, true);
});
test("approvalEnvelope: a flagged-unapproved field blocks submit; approving it unblocks", () => {
  const flagged = mk({ needs_review: true });
  let ap = approvalEnvelope([mk({}), flagged]);
  assert.strictEqual(ap.to_approve_count, 1);
  assert.strictEqual(ap.pending_count, 1);
  assert.strictEqual(ap.submit_ready, false);
  flagged.is_approved = true;
  ap = approvalEnvelope([mk({}), flagged]);
  assert.strictEqual(ap.approved_count, 1);
  assert.strictEqual(ap.all_approved, true);
  assert.strictEqual(ap.submit_ready, true);
});
test("approvalEnvelope: an unreplaced AI placeholder blocks submit even if all flagged are approved", () => {
  const ph = mk({ needs_review: true, is_approved: true, flag: "ai-text-needs-answer", current_value: SUMMARY_PLACEHOLDER_MARK + " …]" });
  const ap = approvalEnvelope([ph]);
  assert.strictEqual(ap.all_approved, true);            // it's approved...
  assert.strictEqual(ap.unreplaced_placeholders, 1);    // ...but the placeholder text remains
  assert.strictEqual(ap.submit_ready, false);           // so NOT ready
});
test("approvalEnvelope: a replaced placeholder (approved) IS submit_ready", () => {
  const fixed = mk({ needs_review: true, is_approved: true, flag: "ai-text-needs-answer", current_value: "My real answer" });
  assert.strictEqual(approvalEnvelope([fixed]).submit_ready, true);
});
test("approvalEnvelope: a soft-deleted required-flagged entry is EXCLUDED from the denominator", () => {
  const deleted = mk({ needs_review: true, is_deleted: true });
  const ap = approvalEnvelope([mk({}), deleted]);
  assert.strictEqual(ap.to_approve_count, 0);           // deleted doesn't count
  assert.strictEqual(ap.submit_ready, true);
});
test("submitReady: convenience predicate agrees with the envelope", () => {
  assert.strictEqual(submitReady([mk({ needs_review: true })]), false);
  assert.strictEqual(submitReady([mk({ needs_review: true, is_approved: true })]), true);
});
