const test = require("node:test");
const assert = require("node:assert/strict");
const { isSelfIdLanguageField } = require("../fill-driver.js");

const SELF_ID_PAGE = [
  { fieldName: "disabilityStatus", widgetType: "checkbox_group", label: "Please check one of the boxes below:" },
  { fieldName: "name", widgetType: "text", label: "Name" },
  { fieldName: "dateSignedOn", widgetType: "date", label: "Date" },
  { fieldName: "language", widgetType: "dropdown", label: "Language*" },
];

const LANGUAGE_SECTION_PAGE = [
  { fieldName: "language", widgetType: "dropdown", label: "Language*" },
  { fieldName: "readingProficiency", widgetType: "dropdown", label: "Reading Proficiency" },
  { fieldName: "speakingProficiency", widgetType: "dropdown", label: "Speaking Proficiency" },
];

const langField = { fieldName: "language", widgetType: "dropdown", label: "Language*" };

test("the self-ID form's display-language dropdown is recognized", () => {
  assert.equal(isSelfIdLanguageField(langField, SELF_ID_PAGE), true);
});

test("SAFETY: a real language-PROFICIENCY question is never hijacked", () => {
  // Same label, same widget — only the page signature tells them apart. Answering this one from
  // page chrome would put a wrong answer on the application.
  assert.equal(isSelfIdLanguageField(langField, LANGUAGE_SECTION_PAGE), false);
});

test("the disability form alone is enough of a self-ID signature", () => {
  const page = [{ fieldName: "disabilityForm", widgetType: "checkbox_group", label: "Disability" }, langField];
  assert.equal(isSelfIdLanguageField(langField, page), true);
});

test("only an EXACT \"language\" label matches", () => {
  for (const label of ["Languages", "Language Proficiency", "Preferred Language", "Native Language"]) {
    assert.equal(isSelfIdLanguageField({ ...langField, label }, SELF_ID_PAGE), false, label);
  }
  // the required marker and casing are normalized away
  assert.equal(isSelfIdLanguageField({ ...langField, label: "LANGUAGE *" }, SELF_ID_PAGE), true);
});

test("only a DROPDOWN matches — a typeahead/text Language is left to the normal path", () => {
  assert.equal(isSelfIdLanguageField({ ...langField, widgetType: "typeahead" }, SELF_ID_PAGE), false);
  assert.equal(isSelfIdLanguageField({ ...langField, widgetType: "text" }, SELF_ID_PAGE), false);
});

test("junk input never throws", () => {
  assert.equal(isSelfIdLanguageField(null, SELF_ID_PAGE), false);
  assert.equal(isSelfIdLanguageField(langField, null), false);
  assert.equal(isSelfIdLanguageField(langField, []), false);
});
