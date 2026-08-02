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
// Structured review-RECORD builder (what cdpReadReviewPage now emits). Bare {label,value} still works
// (all fields default to null → the record flows through the legacy value-presence fallback).
const rrec = (o) => Object.assign({ label: null, value: "", key: null, entryOrdinal: null, fkitPrefix: null }, o);

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

// ── STRUCTURED-RECORD tests (id + section/entry-scoped matching, the 2026-07-10 rewrite). Records carry
//    key (= the value-span id / form-field name), entryOrdinal (the PANEL ordinal, resets per section),
//    fkitPrefix (section identity). These exercise the AUTHORITATIVE path; the cases above (bare
//    {label,value}) prove the legacy fallback still holds. ──

test("STRUCTURED: two-language fluent checkbox — entry-scoping picks English's 'Yes' (fixes false-positive #1)", () => {
  // Chinese (entry 1, not fluent → skipped) and English (entry 2, fluent) share the IDENTICAL label
  // "I am fluent in this language." and the SAME span key "native". Only entry-scoping (ordinal 2 →
  // English) makes the checked box AGREE with the 'Yes', never DISAGREE against Chinese's 'No'.
  const items = [
    rrec({ key: "native", label: "I am fluent in this language.", value: "No", entryOrdinal: 1, fkitPrefix: "language" }),
    rrec({ key: "native", label: "I am fluent in this language.", value: "Yes", entryOrdinal: 2, fkitPrefix: "language" }),
  ];
  const bundle = [
    entry({ field_id: "P::formField-language[0].native", canonical_field: "language[0]._allFluent", question_label: "I am fluent in this language.", current_value: "false", widget_type: "checkbox" }),
    entry({ field_id: "P::formField-language[1].native", canonical_field: "language[1]._allFluent", question_label: "I am fluent in this language.", current_value: "true", widget_type: "checkbox" }),
  ];
  const r = reconcileReviewPage(items, bundle);
  assert.strictEqual(r.counts.disagree, 0, "English's true must NOT disagree with Chinese's 'No'");
  assert.strictEqual(r.counts.agree, 1);
  assert.strictEqual(r.counts.skipped, 1);
  assert.strictEqual(r.agree[0].tier, "checkbox-keyed");
});

test("STRUCTURED: flat screening questions match by hashed key === form-field name (fixes false-positive #2)", () => {
  // The bundle's hashed questionnaire ids ARE the review span ids → authoritative key match, so short
  // Yes/No screening answers verify against the RIGHT question (they used to be false MISSING).
  const items = [
    rrec({ key: "4f7c0000", label: "Are you eligible to work in Canada?", value: "No" }),
    rrec({ key: "4f7c0003", label: "Are you over the age of 18?", value: "Yes" }),
    rrec({ key: "4f7c0006", label: "Have you been convicted of a criminal offence…?", value: "No" }),
  ];
  const bundle = [
    entry({ field_id: "P::formField-4f7c0000", question_label: "Are you eligible to work in Canada?", current_value: "No", widget_type: "dropdown", is_required: true }),
    entry({ field_id: "P::formField-4f7c0003", question_label: "Are you over the age of 18?", current_value: "Yes", widget_type: "dropdown", is_required: true }),
    entry({ field_id: "P::formField-4f7c0006", question_label: "Have you been convicted of a criminal offence…?", current_value: "No", widget_type: "dropdown", is_required: true }),
  ];
  const r = reconcileReviewPage(items, bundle);
  assert.strictEqual(r.counts.agree, 3);
  assert.strictEqual(r.counts.missing_on_review, 0);
  assert.ok(r.agree.every((a) => a.tier === "keyed"), "flat key matches tag tier 'keyed'");
});

test("STRUCTURED: a keyed match with a different value is a real DISAGREE (no fall-through to value-presence)", () => {
  // The bundle value "LinkedIn" IS present on the page (in an unrelated field), so a value-presence
  // fall-through would false-AGREE. The authoritative key match on `source` must DISAGREE instead.
  const items = [
    rrec({ key: "source", label: "How Did You Hear About Us?", value: "Indeed" }),
    rrec({ key: "misc", label: "Other", value: "my LinkedIn profile" }),
  ];
  const bundle = [ entry({ field_id: "P::formField-source", question_label: "How Did You Hear About Us?", current_value: "LinkedIn", widget_type: "typeahead" }) ];
  const r = reconcileReviewPage(items, bundle);
  assert.strictEqual(r.counts.disagree, 1);
  assert.strictEqual(r.counts.agree, 0);
  assert.strictEqual(r.disagree[0].value_review, "Indeed");
});

test("STRUCTURED: a bundle repeating entry beyond the live entries → missing (soft-delete/reorder → fallback)", () => {
  // Bundle claims 3 languages; the page shows 2 entries. language[2] scopes to a non-existent panel 3 →
  // no authoritative match → fallback → its distinctive value isn't on the page → missing (never a crash).
  const items = [
    rrec({ key: "language", label: "Language", value: "Chinese", entryOrdinal: 1, fkitPrefix: "language" }),
    rrec({ key: "language", label: "Language", value: "English", entryOrdinal: 2, fkitPrefix: "language" }),
  ];
  const bundle = [
    entry({ field_id: "P::formField-language[0].language", canonical_field: "language[0].language", question_label: "Language", current_value: "Chinese", widget_type: "dropdown" }),
    entry({ field_id: "P::formField-language[1].language", canonical_field: "language[1].language", question_label: "Language", current_value: "English", widget_type: "dropdown" }),
    entry({ field_id: "P::formField-language[2].language", canonical_field: "language[2].language", question_label: "Language", current_value: "Spanish", widget_type: "dropdown" }),
  ];
  const r = reconcileReviewPage(items, bundle);
  assert.strictEqual(r.counts.agree, 2, "Chinese + English entry-matched");
  assert.strictEqual(r.counts.missing_on_review, 1);
  assert.strictEqual(r.missing_on_review[0].canonical_field, "language[2].language");
});

test("STRUCTURED: website[i].url resolves through CANONICAL_TO_FKIT (website↔webAddress) to the panel", () => {
  const items = [
    rrec({ key: "url", label: "URL", value: "https://linkedin.com/in/kev", entryOrdinal: 1, fkitPrefix: "webAddress" }),
    rrec({ key: "url", label: "URL", value: "https://github.com/kev", entryOrdinal: 2, fkitPrefix: "webAddress" }),
  ];
  const bundle = [
    entry({ field_id: "P::formField-website[0].url", canonical_field: "website[0].url", question_label: "URL", current_value: "https://linkedin.com/in/kev" }),
    entry({ field_id: "P::formField-website[1].url", canonical_field: "website[1].url", question_label: "URL", current_value: "https://github.com/kev" }),
  ];
  const r = reconcileReviewPage(items, bundle);
  assert.strictEqual(r.counts.agree, 2);
  assert.strictEqual(r.counts.disagree, 0);
  assert.ok(r.agree.every((a) => a.tier === "entry"));
});

test("STRUCTURED: hashed proficiency ids match by LABEL within the entry (distinct per entry, repeat across)", () => {
  // The review span id for "Reading Proficiency" is a hash ≠ the bundle's renamed 'readingProficiency',
  // so key match fails → the label bridge. Safe ONLY because entry-scoping runs first: the two records
  // share the SAME hashed key AND the SAME label, separated only by their panel ordinal.
  const items = [
    rrec({ key: "5aaaedHASH", label: "Reading Proficiency", value: "Intermediate", entryOrdinal: 1, fkitPrefix: "language" }),
    rrec({ key: "5aaaedHASH", label: "Reading Proficiency", value: "Fluent", entryOrdinal: 2, fkitPrefix: "language" }),
  ];
  const bundle = [
    entry({ field_id: "P::formField-language[0].readingProficiency", canonical_field: "language[0].reading", question_label: "Reading Proficiency", current_value: "Intermediate", widget_type: "dropdown" }),
    entry({ field_id: "P::formField-language[1].readingProficiency", canonical_field: "language[1].reading", question_label: "Reading Proficiency", current_value: "Fluent", widget_type: "dropdown" }),
  ];
  const r = reconcileReviewPage(items, bundle);
  assert.strictEqual(r.counts.agree, 2);
  assert.strictEqual(r.counts.disagree, 0);
  assert.ok(r.agree.every((a) => a.tier === "entry"));
});

test("STRUCTURED: a generated-id My-Info span (key matches no form-field name) falls through to value-presence", () => {
  // The review span carries a build-generated id (wn5o5e) that matches no bundle form-field name → no
  // authoritative match → the legacy value-presence path (unchanged) still finds the value on the page.
  const items = [ rrec({ key: "wn5o5e", label: null, value: "Kevin Wangg" }) ];
  const bundle = [ entry({ field_id: "P::formField-legalName--firstName", question_label: "First Name", current_value: "Kevin Wangg" }) ];
  const r = reconcileReviewPage(items, bundle);
  assert.strictEqual(r.counts.agree, 1);
  assert.strictEqual(r.agree[0].tier, "text", "value-presence fallback, not a keyed match");
});

// ── EMAIL VERIFY: Workday pre-fills the applicant email from the signup ACCOUNT (not in the bundle). ──
test("EMAIL: a displayed email matching an account email → agree (account-email tier), NOT extra", () => {
  const r = reconcileReviewPage(
    [rrec({ value: "wangykev@gmail.com", section: "Email Address" })],
    [], // no bundle entry claims it (the pre-filled account email)
    { accountEmails: ["wangykev@gmail.com", "wangykev+magna@gmail.com"] }
  );
  assert.strictEqual(r.counts.agree, 1);
  assert.strictEqual(r.agree[0].tier, "account-email");
  assert.strictEqual(r.counts.disagree, 0);
  assert.strictEqual(r.counts.extra_on_review, 0, "a verified account email is not EXTRA noise");
});

test("EMAIL: a displayed email that is NOT an account email → disagree (wrong contact email blocks submit)", () => {
  const r = reconcileReviewPage(
    [rrec({ value: "someone.else@example.com", section: "Email Address" })],
    [],
    { accountEmails: ["wangykev@gmail.com"] }
  );
  assert.strictEqual(r.counts.disagree, 1);
  assert.strictEqual(r.disagree[0].value_review, "someone.else@example.com");
});

test("EMAIL: match is case-insensitive", () => {
  const r = reconcileReviewPage(
    [rrec({ value: "WangYKev@Gmail.com", section: "Email Address" })],
    [],
    { accountEmails: ["wangykev@gmail.com"] }
  );
  assert.strictEqual(r.counts.agree, 1);
  assert.strictEqual(r.agree[0].tier, "account-email");
});

test("EMAIL: with NO accountEmails supplied the pass is skipped (email stays EXTRA — prior behavior, backward-compat)", () => {
  const r = reconcileReviewPage(
    [rrec({ value: "wangykev@gmail.com", section: "Email Address" })],
    []
  );
  assert.strictEqual(r.counts.agree, 0);
  assert.strictEqual(r.counts.disagree, 0);
  assert.strictEqual(r.counts.extra_on_review, 1);
});

// ── MIS-PAIRING GUARD (live 2026-07-28, Caterpillar/Solar Turbines) ─────────────────────────────────
// The review-page check reported three DISAGREEs that were provably false — the operator's own copy of
// the page showed the approved values sitting right there:
//     ≠ "Location": approved "Pittsburgh, PA" but the page shows "Yes"
// "Yes" is the value of the NEXT row ("I currently work here"). Repeating entries reuse identical labels
// and the label→value pairing is heuristic, so an entry can be paired with a neighbouring row's value.
// A DISAGREE is the last value check that BLOCKS a submit, so a false one is expensive: it refused an
// otherwise-clean run. Rule: if the approved value appears ANYWHERE on the page, the page does not
// CONTRADICT us — we matched the wrong record → AMBIGUOUS (logged, non-blocking).
test("mis-pairing: an entry paired with a neighbour's value is AMBIGUOUS, not a disagree, when its own value IS on the page", () => {
  const items = [
    rrec({ section: "Work Experience", entryOrdinal: 1, fkitPrefix: "workExperience", key: "location", label: "Location", value: "Yes" }), // WRONG pairing (the checkbox's value)
    rrec({ section: "Work Experience", entryOrdinal: 1, fkitPrefix: "workExperience", key: "cbx", label: "I currently work here", value: "Pittsburgh, PA" }), // where the real value ended up
  ];
  const entries = [entry({
    question_label: "Location", current_value: "Pittsburgh, PA", widget_type: "text",
    canonical_field: "workExperience[0].location", field_id: "P2::formField-workExperience[0].location",
  })];
  const r = reconcileReviewPage(items, entries);
  assert.strictEqual(r.counts.disagree, 0, "the page contains 'Pittsburgh, PA' — it does not contradict us");
  assert.strictEqual(r.counts.ambiguous, 1, "surfaced as ambiguous instead");
  assert.match(r.ambiguous[0].tier || "", /mispaired/, "and says WHY it wasn't trusted");
});

test("mis-pairing guard does NOT hide a REAL disagree — a value the page nowhere contains still blocks", () => {
  const items = [
    rrec({ section: "Work Experience", entryOrdinal: 1, fkitPrefix: "workExperience", key: "location", label: "Location", value: "Detroit, MI" }),
  ];
  const entries = [entry({
    question_label: "Location", current_value: "Pittsburgh, PA", widget_type: "text",
    canonical_field: "workExperience[0].location", field_id: "P2::formField-workExperience[0].location",
  })];
  const r = reconcileReviewPage(items, entries);
  assert.strictEqual(r.counts.disagree, 1, "'Pittsburgh, PA' appears NOWHERE — the page genuinely contradicts the approved value");
  assert.strictEqual(r.counts.ambiguous, 0);
});

// A repeating section whose entries hold ONE field is a SET — Magna's Websites entries are a bare
// URL and nothing else, so entry ORDER carries no information (operator 2026-08-02: "it is a
// repeating section right? so it doesn't matter the order"). Live, two rows both labelled "URL"
// came back with LinkedIn and GitHub swapped and 2 DISAGREE blocked an otherwise-clean submit gate.
test("STRUCTURED: a single-field section is order-free — a swap RE-PAIRS and agrees", () => {
  const items = [
    rrec({ key: "url", label: "URL", value: "https://www.github.com/wangykev", entryOrdinal: 1, fkitPrefix: "webAddress" }),
    rrec({ key: "url", label: "URL", value: "https://www.linkedin.com/in/wangykev", entryOrdinal: 2, fkitPrefix: "webAddress" }),
  ];
  const bundle = [
    entry({ field_id: "P::formField-url", canonical_field: "website[0].url", question_label: "URL", current_value: "https://www.linkedin.com/in/wangykev" }),
    entry({ field_id: "P::formField-url", canonical_field: "website[1].url", question_label: "URL", current_value: "https://www.github.com/wangykev" }),
  ];
  const r = reconcileReviewPage(items, bundle);
  assert.strictEqual(r.counts.disagree, 0, "a reorder is not a contradiction");
  assert.strictEqual(r.counts.agree, 2);
  assert.ok(r.agree.some((a) => a.tier === "entry-reordered"), JSON.stringify(r.agree.map((a) => a.tier)));
});

// …and order-freedom must not launder a LOST value: if the page holds one URL twice, the other is
// genuinely gone and must still block.
test("STRUCTURED: order-free does NOT excuse a value missing from the section", () => {
  const items = [
    rrec({ key: "url", label: "URL", value: "https://www.github.com/wangykev", entryOrdinal: 1, fkitPrefix: "webAddress" }),
    rrec({ key: "url", label: "URL", value: "https://www.github.com/wangykev", entryOrdinal: 2, fkitPrefix: "webAddress" }),
  ];
  const bundle = [
    entry({ field_id: "P::formField-url", canonical_field: "website[0].url", question_label: "URL", current_value: "https://www.linkedin.com/in/wangykev" }),
    entry({ field_id: "P::formField-url", canonical_field: "website[1].url", question_label: "URL", current_value: "https://www.github.com/wangykev" }),
  ];
  const r = reconcileReviewPage(items, bundle);
  assert.strictEqual(r.counts.disagree, 1, "the vanished LinkedIn must still be reported");
});

// A MULTI-field section is NOT order-free: an entry pairs title+company+dates, so one value moving
// between entries can mean genuinely mispaired data and must keep the strict verdict.
test("STRUCTURED: a multi-field section stays strict — a cross-entry swap still DISAGREES", () => {
  const items = [
    rrec({ key: "jobTitle", label: "Job Title", value: "Engineer B", entryOrdinal: 1, fkitPrefix: "workExperience" }),
    rrec({ key: "jobTitle", label: "Job Title", value: "Engineer A", entryOrdinal: 2, fkitPrefix: "workExperience" }),
  ];
  const bundle = [
    entry({ field_id: "P::formField-jobTitle", canonical_field: "workExperience[0].jobTitle", question_label: "Job Title", current_value: "Engineer A" }),
    entry({ field_id: "P::formField-companyName", canonical_field: "workExperience[0].companyName", question_label: "Company", current_value: "Acme" }),
  ];
  const r = reconcileReviewPage(items, bundle);
  assert.ok(!r.agree.some((a) => a.tier === "entry-reordered"),
    "a multi-field section must never take the order-free re-pair path: " + JSON.stringify(r.agree.map((a) => a.tier)));
});
