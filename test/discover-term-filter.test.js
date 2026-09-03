// test/discover-term-filter.test.js — the sweep must return the TERM that was asked for.
//
// Live 2026-09-02: a sweep set to cycle "summer" / year "2027" queued "Electrical Engineering
// Intern - Fall 2026", and of 35 queued rows only 9 mentioned 2027 at all and 3 said Summer 2027.
// `cycle`/`year` shape the SEARCH STRING; only Simplify's feed filters on them, and
// LinkedIn/Handshake just keyword-match — so contradictions have to be refused on our side.
//
// ⚠ THE ASYMMETRY IS THE DESIGN: drop contradictions, keep unknowns. Most postings carry no season
// or year in the title, so a rule that REQUIRED a match would discard nearly every real result — it
// would look like a filter and behave like a blindfold.
//
// Run: node --test test/discover-term-filter.test.js

const test = require("node:test");
const assert = require("node:assert");
const d = require("../discover.js");

const contra = (title, cycle = "summer", year = "2027") => d.discoverTermContradiction(title, cycle, year);

test("⚠ the live miss: a Fall 2026 posting is refused for a Summer 2027 sweep", () => {
  assert.ok(contra("Electrical Engineering Intern - Fall 2026"), "must be refused");
  // …and it is refused for BOTH reasons, either of which alone is enough.
  assert.ok(contra("Electrical Engineering Intern - Fall 2027"), "wrong season alone");
  assert.ok(contra("Electrical Engineering Intern - Summer 2026"), "wrong year alone");
});

test("⚠⚠ SILENCE IS NOT A CONTRADICTION — an undated internship survives", () => {
  // This is the case that makes the filter usable at all: most titles say neither.
  for (const t of ["Software Engineer Intern", "Data Engineering Intern",
    "Junior Embedded Software Development Engineer", "Software Engineer Intern - Connectivity"]) {
    assert.strictEqual(contra(t), null, t);
  }
  assert.strictEqual(contra(""), null, "no title at all cannot contradict");
});

test("⚠ A YEAR ALONE IS NOT A SEASON — '2027 …Intern' survives a summer request", () => {
  // Anduril's real titles. The year is stated and matches; the cycle is simply unstated, and an
  // unstated cycle is not a wrong one.
  assert.strictEqual(contra("2027 Electrical Engineer Intern"), null);
  assert.strictEqual(contra("2027 Software Engineer Intern"), null);
  assert.strictEqual(contra("NVIDIA 2027 Internships: Software Engineering"), null);
});

test("an explicitly matching term survives", () => {
  for (const t of ["Systems Engineering Intern II, Summer 2027",
    "Humana Technology Internship – Summer 2027", "Summer 2027 SWE Intern"]) {
    assert.strictEqual(contra(t), null, t);
  }
});

test("⚠ a stray 4-digit number must not read as a year", () => {
  // A requisition id or a headcount blurb is not a season. Only plausible hiring years count.
  assert.strictEqual(contra("Software Engineer Intern (Req 1042)"), null);
  assert.strictEqual(contra("Software Engineer Intern - 5000+ employees"), null);
  assert.strictEqual(contra("Intern, Platform (ID 19842)"), null);
});

test("the filter is inert when no term was requested", () => {
  assert.strictEqual(d.discoverTermContradiction("Intern - Fall 2026", "", ""), null,
    "no cycle and no year ⇒ nothing to contradict");
  // A year-only request still judges years, and leaves seasons alone.
  assert.ok(d.discoverTermContradiction("Intern - Summer 2026", "", "2027"));
  assert.strictEqual(d.discoverTermContradiction("Intern - Fall 2027", "", "2027"), null,
    "year matches; no cycle was asked for");
  // A cycle-only request judges seasons, and leaves years alone.
  assert.ok(d.discoverTermContradiction("Intern - Fall 2027", "summer", ""));
  assert.strictEqual(d.discoverTermContradiction("Intern - Summer 2026", "summer", ""), null);
});

test("autumn counts as fall, and casing does not matter", () => {
  assert.ok(contra("Intern - AUTUMN 2027"));
  assert.ok(contra("intern, autumn 2027"));
});
