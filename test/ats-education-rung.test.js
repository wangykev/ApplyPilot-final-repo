// test/ats-education-rung.test.js — education questions answered from the profile.
//
// Live 2026-09-01, Whatnot: "Please select your graduation month", "…your graduation year" and
// "…your current or most recent university." are per-tenant AUTOCOMPLETES that render an EMPTY menu
// until a query is typed. Nothing routed them, so the deterministic pass produced no candidates, the
// SEARCH arm never ran (it types `candidates[0]`, and there was none), and the AI fallback bailed
// `no live options to choose from`. Three REQUIRED fields reached review reading "ApplyPilot
// couldn't fill this" on a form whose every answer is in the profile.
//
// The fix is deterministic rather than a better prompt: a graduation month is a STATED FACT, so it
// fills exact and unflagged, where an AI guess would be `ai-choice` and land back in review for a
// human to re-confirm something already known.
//
// Run: node --test test/ats-education-rung.test.js

const test = require("node:test");
const assert = require("node:assert");
const ats = require("../ats.js");

const PROFILE = {
  education: [{
    school_or_university: "Carnegie Mellon University",
    graduation_date: "2028-05",
    to_year: "2028",
  }],
};

test("⚠ graduation MONTH answers with a tiered list so the form's vocabulary decides", () => {
  const r = ats.atsEducationAnswer("Please select your graduation month", PROFILE);
  assert.ok(r, "the question must be recognised");
  // full name first, then the zero-padded and bare numbers a different tenant might offer
  assert.deepStrictEqual(r.candidates, ["May", "05", "5"]);
  assert.strictEqual(r.source, "education");
});

test("⚠ graduation YEAR is recognised even though it names no school", () => {
  const r = ats.atsEducationAnswer("Please select your graduation year", PROFILE);
  assert.deepStrictEqual(r.candidates, ["2028"]);
});

test("the university question answers with the school name", () => {
  const r = ats.atsEducationAnswer("Please select your current or most recent university.", PROFILE);
  assert.deepStrictEqual(r.candidates, ["Carnegie Mellon University"]);
});

test("⚠⚠ MONTH/YEAR are tested BEFORE school — a wording containing both is a date question", () => {
  // "What year will you graduate from your university?" contains a school word. Testing the school
  // shape first would fill a YEAR box with "Carnegie Mellon University".
  const r = ats.atsEducationAnswer("What year will you graduate from your university?", PROFILE);
  assert.deepStrictEqual(r.candidates, ["2028"], "must answer the YEAR, not the school");
  const m = ats.atsEducationAnswer("Which month do you graduate from college?", PROFILE);
  assert.deepStrictEqual(m.candidates, ["May", "05", "5"]);
});

test("⚠ a DIFFERENT school is refused rather than answered with the university", () => {
  // A wrong school is a false statement, not an approximation.
  for (const q of ["What high school did you attend?", "Name of your law school"]) {
    assert.strictEqual(ats.atsEducationAnswer(q, PROFILE), null, q);
  }
});

test("⚠ an UNKNOWN fact says nothing — it must fall through, never guess", () => {
  const noDate = { education: [{ school_or_university: "CMU" }] };
  assert.strictEqual(ats.atsEducationAnswer("Please select your graduation month", noDate), null,
    "no graduation_date ⇒ no month");
  // A YEAR-only graduation date still answers the year, but never invents a month.
  const yearOnly = { education: [{ school_or_university: "CMU", graduation_date: "2028" }] };
  assert.strictEqual(ats.atsEducationAnswer("graduation month", yearOnly), null);
  assert.deepStrictEqual(ats.atsEducationAnswer("graduation year", yearOnly).candidates, ["2028"]);
  // No education at all ⇒ the rung is silent and the ladder continues below it.
  assert.strictEqual(ats.atsEducationAnswer("Please select your graduation year", {}), null);
  assert.strictEqual(ats.atsEducationAnswer("Please select your graduation year", { education: [] }), null);
});

test("an unrelated question is not claimed", () => {
  for (const q of ["What is your email address?", "Are you authorized to work in the US?",
    "How did you hear about this role?", "Describe your most impactful project"]) {
    assert.strictEqual(ats.atsEducationAnswer(q, PROFILE), null, q);
  }
});

test("a day-precision graduation date still yields the month and year", () => {
  const p = { education: [{ school_or_university: "CMU", graduation_date: "2028-05-12" }] };
  assert.deepStrictEqual(ats.atsEducationAnswer("graduation month", p).candidates, ["May", "05", "5"]);
  assert.deepStrictEqual(ats.atsEducationAnswer("graduation year", p).candidates, ["2028"]);
});
