// Unit tests for reconcileReviewPage (lib.js) — the end-to-end fill-verify. It diffs what the Workday
// REVIEW page displays (ground truth, [{label, value}] pairs) against what the extension RECORDED it
// filled (the reviewSummary bundle's entries). DOM-agnostic, so the match/compare logic is pinned here
// independent of the (untraced) review-page DOM. A DISAGREE is the headline bug signal.
const { test } = require("node:test");
const assert = require("node:assert");
const { reconcileReviewPage, AI_NEEDS_ANSWER_MARK } = require("../lib.js");

// Terse entry builder — only the fields reconcileReviewPage reads.
const entry = (o) => Object.assign({ question_label: null, current_value: null, fill_status: "filled",
  widget_type: "text", canonical_field: null, is_required: false, page_number: 1, field_id: null }, o);

test("exact label + value → agree (tier exact)", () => {
  const r = reconcileReviewPage(
    [{ label: "First Name", value: "Ada" }],
    [entry({ question_label: "First Name", current_value: "Ada" })]
  );
  assert.strictEqual(r.counts.agree, 1);
  assert.strictEqual(r.counts.disagree, 0);
  assert.strictEqual(r.agree[0].tier, "exact");
});

test("dropdown (+dial-code) reconciles with the review page's bare display via normalize", () => {
  const r = reconcileReviewPage(
    [{ label: "Country Phone Code", value: "United States of America" }],
    [entry({ question_label: "Country Phone Code", current_value: "United States of America (+1)", widget_type: "dropdown" })]
  );
  assert.strictEqual(r.counts.agree, 1, "the (+1) suffix is normalized away → exact");
  assert.strictEqual(r.counts.disagree, 0);
});

test("dropdown containment: bundle 'United States' matches review 'United States of America'", () => {
  const r = reconcileReviewPage(
    [{ label: "Country", value: "United States of America" }],
    [entry({ question_label: "Country", current_value: "United States", widget_type: "dropdown" })]
  );
  assert.strictEqual(r.counts.agree, 1);
  assert.strictEqual(r.agree[0].tier, "containment");
});

test("a real value mismatch is a DISAGREE (the headline bug signal)", () => {
  const r = reconcileReviewPage(
    [{ label: "State", value: "California" }],
    [entry({ question_label: "State", current_value: "New York", widget_type: "dropdown" })]
  );
  assert.strictEqual(r.counts.disagree, 1);
  assert.strictEqual(r.counts.agree, 0);
  assert.deepStrictEqual(
    { l: r.disagree[0].label, b: r.disagree[0].value_bundle, v: r.disagree[0].value_review },
    { l: "State", b: "New York", v: "California" }
  );
});

test("short values ('Yes'/'No') use exact-only — no false containment against a longer string", () => {
  const r = reconcileReviewPage(
    [{ label: "Previously employed here?", value: "Not specified" }],
    [entry({ question_label: "Previously employed here?", current_value: "No", widget_type: "radio" })]
  );
  // "no" must NOT be swallowed by "not specified" via containment → this is a real disagreement.
  assert.strictEqual(r.counts.disagree, 1);
});

test("filled in bundle but no matching label on the review page → missing_on_review", () => {
  const r = reconcileReviewPage(
    [{ label: "First Name", value: "Ada" }],
    [entry({ question_label: "Secret Question", current_value: "value that vanished", is_required: true })]
  );
  assert.strictEqual(r.counts.missing_on_review, 1);
  assert.strictEqual(r.missing_on_review[0].is_required, true);
});

test("a review value with no matching bundle entry → extra_on_review (informational)", () => {
  const r = reconcileReviewPage(
    [{ label: "Referred By", value: "A Friend" }],
    [entry({ question_label: "First Name", current_value: "Ada" })]
  );
  assert.strictEqual(r.counts.missing_on_review, 1); // First Name unmatched
  assert.strictEqual(r.counts.extra_on_review, 1);
  assert.strictEqual(r.extra_on_review[0].value_review, "A Friend");
});

test("checkbox: a CHECKED box (true) shows on review as its label → 'Yes' → agree", () => {
  const r = reconcileReviewPage(
    [{ label: "I currently work here", value: "Yes" }],
    [entry({ question_label: "I currently work here", current_value: "true", widget_type: "checkbox" })]
  );
  assert.strictEqual(r.counts.agree, 1);
  assert.strictEqual(r.agree[0].tier, "checkbox");
});

test("checkbox: a CHECKED box not found on review → missing_on_review (didn't stick)", () => {
  const r = reconcileReviewPage(
    [{ label: "First Name", value: "Ada" }],
    [entry({ question_label: "I agree to the terms", current_value: "true", widget_type: "checkbox", is_required: true })]
  );
  assert.strictEqual(r.counts.missing_on_review, 1);
  assert.strictEqual(r.counts.agree, 0);
});

test("checkbox: an UNCHECKED box (false) is skipped — the review page doesn't render it, so absence is not a bug", () => {
  const r = reconcileReviewPage(
    [],
    [entry({ question_label: "I currently work here", current_value: "false", widget_type: "checkbox" })]
  );
  assert.strictEqual(r.counts.skipped, 1);
  assert.strictEqual(r.counts.claimed, 0);
  assert.strictEqual(r.counts.missing_on_review, 0);
});

test("file_upload: the resume filename inside the review's Attachments blob → agree (label-independent)", () => {
  const r = reconcileReviewPage(
    [{ label: "Attachments", value: "Kevin's Resume 2.pdf successfully uploaded Kevin's Resume 2.pdf 173.59 KB" }],
    [entry({ question_label: "Resume", current_value: "Kevin's Resume 2.pdf", widget_type: "file_upload" })]
  );
  assert.strictEqual(r.counts.agree, 1);
  assert.strictEqual(r.agree[0].tier, "file");
  assert.strictEqual(r.counts.extra_on_review, 0, "the Attachments item is consumed, not left as extra");
});

test("file_upload: filename absent from the review page → missing_on_review (resume didn't attach)", () => {
  const r = reconcileReviewPage(
    [{ label: "Attachments", value: "someone-elses-file.pdf" }],
    [entry({ question_label: "Resume", current_value: "Kevin's Resume 2.pdf", widget_type: "file_upload" })]
  );
  assert.strictEqual(r.counts.missing_on_review, 1);
  assert.strictEqual(r.counts.agree, 0);
});

test("an unreplaced AI placeholder is excluded (not a real value)", () => {
  const r = reconcileReviewPage(
    [],
    [entry({ question_label: "Why us?", current_value: AI_NEEDS_ANSWER_MARK + " essay]", widget_type: "textarea" })]
  );
  assert.strictEqual(r.counts.placeholders, 1);
  assert.strictEqual(r.counts.claimed, 0);
  assert.strictEqual(r.counts.missing_on_review, 0);
});

test("blank/absent bundle values are not reconciled (no false missing)", () => {
  const r = reconcileReviewPage(
    [],
    [entry({ question_label: "Middle Name", current_value: "" }),
     entry({ question_label: "Suffix", current_value: null })]
  );
  assert.strictEqual(r.counts.claimed, 0);
  assert.strictEqual(r.counts.missing_on_review, 0);
});

test("repeating-section label collision disambiguates by value (greedy consume)", () => {
  // Two 'Job Title' rows on the review page; two bundle entries. Each should pair with its value-match,
  // not collapse into one match + one missing.
  const r = reconcileReviewPage(
    [{ label: "Job Title", value: "Engineer" }, { label: "Job Title", value: "Analyst" }],
    [entry({ question_label: "Job Title", current_value: "Analyst", canonical_field: "workExperience[0].jobTitle" }),
     entry({ question_label: "Job Title", current_value: "Engineer", canonical_field: "workExperience[1].jobTitle" })]
  );
  assert.strictEqual(r.counts.agree, 2);
  assert.strictEqual(r.counts.missing_on_review, 0);
  assert.strictEqual(r.counts.disagree, 0);
});

test("same label, NO value reconciles among multiple candidates → ambiguous, not a guessed disagree", () => {
  const r = reconcileReviewPage(
    [{ label: "Job Title", value: "Engineer" }, { label: "Job Title", value: "Analyst" }],
    [entry({ question_label: "Job Title", current_value: "Manager", canonical_field: "workExperience[0].jobTitle" })]
  );
  assert.strictEqual(r.counts.ambiguous, 1);
  assert.strictEqual(r.counts.disagree, 0);
  assert.deepStrictEqual(r.ambiguous[0].candidates.sort(), ["Analyst", "Engineer"]);
});

test("empty inputs are safe", () => {
  const r = reconcileReviewPage(null, null);
  assert.deepStrictEqual(r.counts, { claimed: 0, agree: 0, disagree: 0, missing_on_review: 0,
    extra_on_review: 0, ambiguous: 0, skipped: 0, placeholders: 0 });
});
