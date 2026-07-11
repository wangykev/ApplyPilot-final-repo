// Unit tests for reconcileReviewPage (lib.js) — the end-to-end fill-verify. It diffs what the Workday
// REVIEW page displays (ground truth) against what the extension RECORDED it filled (the reviewSummary
// bundle). The observed review page has NO reliable field labels, so matching is VALUE-PRESENCE for
// distinctive values (does the recorded value appear on the page at all?) with a digit + region-abbrev
// relief, and LABEL-ANCHORED for short values ("Yes"/"No") and checkboxes. DOM-agnostic: consumes
// [{label, value}] pairs. A MISSING (recorded value nowhere on the page) is the headline bug signal.
const { test } = require("node:test");
const assert = require("node:assert");
const { reconcileReviewPage, AI_NEEDS_ANSWER_MARK } = require("../lib.js");

// Terse entry builder — only the fields reconcileReviewPage reads.
const entry = (o) => Object.assign({ question_label: null, current_value: null, fill_status: "filled",
  widget_type: "text", canonical_field: null, is_required: false, page_number: 1, field_id: null }, o);

test("distinctive value present on the page → agree (value-presence, ignores label)", () => {
  const r = reconcileReviewPage(
    [{ label: "How Did You Hear About Us?", value: "Kevin Wang" }], // deliberately WRONG label
    [entry({ question_label: "First Name", current_value: "Kevin Wang" })]
  );
  assert.strictEqual(r.counts.agree, 1);
  assert.strictEqual(r.counts.missing_on_review, 0);
  assert.strictEqual(r.agree[0].tier, "text");
});

test("dropdown (+dial-code) reconciles with the review page's bare display via normalize", () => {
  const r = reconcileReviewPage(
    [{ label: "x", value: "United States of America" }],
    [entry({ question_label: "Country Phone Code", current_value: "United States of America (+1)", widget_type: "typeahead" })]
  );
  assert.strictEqual(r.counts.agree, 1);
  assert.strictEqual(r.counts.missing_on_review, 0);
});

test("containment: bundle 'United States' is present inside the page's 'United States of America'", () => {
  const r = reconcileReviewPage(
    [{ label: "x", value: "715 Middlebrooks Circle Tallahassee, FL 32312 United States of America" }],
    [entry({ question_label: "Country", current_value: "United States", widget_type: "dropdown" })]
  );
  assert.strictEqual(r.counts.agree, 1);
});

test("phone matches on DIGITS despite the review page's formatting", () => {
  const r = reconcileReviewPage(
    [{ label: "x", value: "+1 850-666-0266 (Mobile)" }],
    [entry({ question_label: "Phone Number", current_value: "8506660266" })]
  );
  assert.strictEqual(r.counts.agree, 1);
  assert.strictEqual(r.agree[0].tier, "digits");
});

test("region name↔abbrev: stored 'Florida' matches the page's 'Tallahassee, FL'", () => {
  const r = reconcileReviewPage(
    [{ label: "x", value: "715 Middlebrooks Circle Tallahassee, FL 32312" }],
    [entry({ question_label: "State", current_value: "Florida", widget_type: "dropdown" })]
  );
  assert.strictEqual(r.counts.agree, 1);
  assert.strictEqual(r.agree[0].tier, "region-abbrev");
});

test("a distinctive recorded value NOWHERE on the page → missing_on_review (the didn't-stick signal)", () => {
  const r = reconcileReviewPage(
    [{ label: "First Name", value: "Kevin" }],
    [entry({ question_label: "Secret Field", current_value: "a value that reverted to blank", is_required: true })]
  );
  assert.strictEqual(r.counts.missing_on_review, 1);
  assert.strictEqual(r.missing_on_review[0].is_required, true);
});

test("disagree: value absent but a same-label item shows a DIFFERENT value", () => {
  const r = reconcileReviewPage(
    [{ label: "State", value: "California" }],
    [entry({ question_label: "State", current_value: "New York", widget_type: "dropdown" })]
  );
  assert.strictEqual(r.counts.disagree, 1);
  assert.strictEqual(r.counts.agree, 0);
  assert.strictEqual(r.disagree[0].value_review, "California");
});

test("short value (Yes/No) is captured by LABEL-anchoring on the distinctive question", () => {
  const q = "Are you eligible to work in Canada?";
  const agreeR = reconcileReviewPage([{ label: q, value: "No" }], [entry({ question_label: q, current_value: "No", widget_type: "dropdown" })]);
  assert.strictEqual(agreeR.counts.agree, 1);
  assert.strictEqual(agreeR.agree[0].tier, "label");
  const disagreeR = reconcileReviewPage([{ label: q, value: "Yes" }], [entry({ question_label: q, current_value: "No", widget_type: "dropdown" })]);
  assert.strictEqual(disagreeR.counts.disagree, 1);
});

test("checkbox: prefers the yes/no-valued item over a mislabeled distinctive one (the preferredCheck fix)", () => {
  // Both items carry the checkbox's label (the scraper mislabeled "Kevin Wang" with it); the reconciler
  // must pick the "Yes" item, not disagree on "Kevin Wang".
  const r = reconcileReviewPage(
    [{ label: "I have a preferred name", value: "Kevin Wang" }, { label: "I have a preferred name", value: "Yes" }],
    [entry({ question_label: "I have a preferred name", current_value: "true", widget_type: "checkbox" })]
  );
  assert.strictEqual(r.counts.agree, 1);
  assert.strictEqual(r.counts.disagree, 0);
  assert.strictEqual(r.agree[0].tier, "checkbox");
});

test("checkbox: two IDENTICAL 'I am fluent' labels — a fluent language consumes the 'Yes', not another entry's 'No'", () => {
  // Live bug (Magna, 2 languages): Chinese not fluent (false → skipped as unchecked), English fluent
  // (true). The page shows both rows under the SAME label; English's true must AGREE with the 'Yes',
  // not falsely DISAGREE against Chinese's 'No' (the first label-matching item).
  const r = reconcileReviewPage(
    [{ label: "I am fluent in this language.", value: "No" }, { label: "I am fluent in this language.", value: "Yes" }],
    [
      entry({ question_label: "I am fluent in this language.", current_value: "false", widget_type: "checkbox" }),
      entry({ question_label: "I am fluent in this language.", current_value: "true", widget_type: "checkbox" }),
    ]
  );
  assert.strictEqual(r.counts.disagree, 0, "English's true must NOT disagree with Chinese's 'No'");
  assert.strictEqual(r.counts.agree, 1, "English's true agrees with the 'Yes' row");
});

test("short but distinctive value (a 3-char name 'Doe') matches by presence", () => {
  const r = reconcileReviewPage(
    [{ label: "I have a preferred name", value: "John Doe" }],
    [entry({ question_label: "Last Name", current_value: "Doe" })]
  );
  assert.strictEqual(r.counts.agree, 1);
  assert.strictEqual(r.counts.missing_on_review, 0);
});

test("a bare Yes/No does NOT value-present (it must label-anchor the right question)", () => {
  // "Yes" appears in the page text, but with no matching label the reconciler must NOT falsely agree.
  const r = reconcileReviewPage(
    [{ label: "Some unrelated question", value: "Yes indeed it is" }],
    [entry({ question_label: "Do you consent?", current_value: "Yes", widget_type: "dropdown" })]
  );
  assert.strictEqual(r.counts.agree, 0);
  assert.strictEqual(r.counts.missing_on_review, 1);
});

test("checkbox: a checked box not shown on review → missing_on_review", () => {
  const r = reconcileReviewPage(
    [{ label: "First Name", value: "Ada" }],
    [entry({ question_label: "I agree to the terms", current_value: "true", widget_type: "checkbox", is_required: true })]
  );
  assert.strictEqual(r.counts.missing_on_review, 1);
});

test("checkbox: an unchecked box (false) is skipped — absence isn't a bug", () => {
  const r = reconcileReviewPage([], [entry({ question_label: "I currently work here", current_value: "false", widget_type: "checkbox" })]);
  assert.strictEqual(r.counts.skipped, 1);
  assert.strictEqual(r.counts.claimed, 0);
  assert.strictEqual(r.counts.missing_on_review, 0);
});

test("file_upload: the resume filename inside the review's Attachments blob → agree", () => {
  const r = reconcileReviewPage(
    [{ label: "Attachments", value: "Kevin's Resume 2.pdf successfully uploaded Kevin's Resume 2.pdf 173.59 KB" }],
    [entry({ question_label: "Resume", current_value: "Kevin's Resume 2.pdf", widget_type: "file_upload" })]
  );
  assert.strictEqual(r.counts.agree, 1);
  assert.strictEqual(r.agree[0].tier, "file");
});

test("file_upload: filename absent from the page → missing_on_review (resume didn't attach)", () => {
  const r = reconcileReviewPage(
    [{ label: "Attachments", value: "someone-elses-file.pdf" }],
    [entry({ question_label: "Resume", current_value: "Kevin's Resume 2.pdf", widget_type: "file_upload" })]
  );
  assert.strictEqual(r.counts.missing_on_review, 1);
  assert.strictEqual(r.counts.agree, 0);
});

test("repeating identical values both agree by presence (no dedup false-missing)", () => {
  // The scraper dedupes two identical "Tallahassee, FL" rows to ONE item; value-presence still agrees
  // for BOTH bundle entries.
  const r = reconcileReviewPage(
    [{ label: "Location", value: "Tallahassee, FL" }],
    [entry({ question_label: "Location", current_value: "Tallahassee, FL", canonical_field: "workExperience[1].location" }),
     entry({ question_label: "Location", current_value: "Tallahassee, FL", canonical_field: "workExperience[2].location" })]
  );
  assert.strictEqual(r.counts.agree, 2);
  assert.strictEqual(r.counts.missing_on_review, 0);
});

test("EXTRA: a distinctive page value NOT explained by any recorded value (the deleted-language catch)", () => {
  const r = reconcileReviewPage(
    [{ label: "First Name", value: "Kevin" }, { label: "Language", value: "Chinese" }],
    [entry({ question_label: "First Name", current_value: "Kevin" })] // bundle has NO language (it was deleted)
  );
  assert.strictEqual(r.counts.agree, 1);
  assert.strictEqual(r.counts.extra_on_review, 1);
  assert.strictEqual(r.extra_on_review[0].value_review, "Chinese");
});

test("EXTRA: a value contained in a recorded blob is explained, not extra; short values never extra", () => {
  const r = reconcileReviewPage(
    [{ label: "x", value: "715 Middlebrooks Circle Tallahassee, FL 32312" }, { label: "y", value: "Yes" }],
    [entry({ question_label: "Address Line 1", current_value: "715 Middlebrooks Circle" })]
  );
  assert.strictEqual(r.counts.extra_on_review, 0);
});

test("multiple same-label items, none reconcile by value → ambiguous, not a guessed disagree", () => {
  const r = reconcileReviewPage(
    [{ label: "Job Title", value: "Engineer" }, { label: "Job Title", value: "Analyst" }],
    [entry({ question_label: "Job Title", current_value: "Mgr", canonical_field: "workExperience[0].jobTitle" })] // short + absent
  );
  assert.strictEqual(r.counts.ambiguous, 1);
  assert.strictEqual(r.counts.disagree, 0);
  assert.deepStrictEqual(r.ambiguous[0].candidates.sort(), ["Analyst", "Engineer"]);
});

test("an unreplaced AI placeholder is excluded (not a real value)", () => {
  const r = reconcileReviewPage([], [entry({ question_label: "Why us?", current_value: AI_NEEDS_ANSWER_MARK + " essay]", widget_type: "textarea" })]);
  assert.strictEqual(r.counts.placeholders, 1);
  assert.strictEqual(r.counts.claimed, 0);
  assert.strictEqual(r.counts.missing_on_review, 0);
});

test("blank/absent bundle values are not reconciled (no false missing)", () => {
  const r = reconcileReviewPage([], [entry({ question_label: "Middle Name", current_value: "" }), entry({ question_label: "Suffix", current_value: null })]);
  assert.strictEqual(r.counts.claimed, 0);
  assert.strictEqual(r.counts.missing_on_review, 0);
});

test("empty inputs are safe", () => {
  const r = reconcileReviewPage(null, null);
  assert.deepStrictEqual(r.counts, { claimed: 0, agree: 0, disagree: 0, missing_on_review: 0,
    extra_on_review: 0, ambiguous: 0, skipped: 0, placeholders: 0 });
});
