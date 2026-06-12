// Unit test for the pure meaningful-entry filter (lib.js) — runs without a page.
// It decides how many Work-Experience entries the engine fills/adds, so dropping the
// empty placeholder rows (and keeping order) matters.
const test = require("node:test");
const assert = require("node:assert");

const { meaningfulWorkExperience, meaningfulEntries, joinBullets, ensureHttps, isFluent } = require("../lib.js");

test("isFluent — true only for a 'fluent' value (string or in a tiered array)", () => {
  assert.strictEqual(isFluent("Fluent"), true);
  assert.strictEqual(isFluent("  fluent  "), true);
  assert.strictEqual(isFluent(["Fluent", "Advanced"]), true);
  assert.strictEqual(isFluent("Intermediate"), false);
  assert.strictEqual(isFluent("Advanced"), false);
  assert.strictEqual(isFluent(""), false);
  assert.strictEqual(isFluent(null), false);
});

test("ensureHttps prepends https:// only when there's no scheme", () => {
  assert.strictEqual(ensureHttps("linkedin.com/in/wangykev"), "https://linkedin.com/in/wangykev");
  assert.strictEqual(ensureHttps("https://github.com/x"), "https://github.com/x");
  assert.strictEqual(ensureHttps("http://x.com"), "http://x.com");
  assert.strictEqual(ensureHttps("  example.com  "), "https://example.com");
  assert.strictEqual(ensureHttps(""), "");
  assert.strictEqual(ensureHttps(null), "");
});

test("meaningfulEntries keeps entries with real data in ANY of the given keys", () => {
  const arr = [
    { school_or_university: "FSU", degree: "" },   // kept (school)
    { school_or_university: "", degree: "BS" },     // kept (degree)
    { school_or_university: "", degree: "" },        // dropped
    { school_or_university: "  ", degree: "  " },     // dropped (whitespace)
    null                                              // dropped
  ];
  const out = meaningfulEntries(arr, ["school_or_university", "degree"]);
  assert.deepStrictEqual(out.map((e) => e.school_or_university || e.degree), ["FSU", "BS"]);
});

test("meaningfulEntries accepts a single key (string) and non-array → []", () => {
  assert.strictEqual(meaningfulEntries([{ a: "x" }, { a: "" }], "a").length, 1);
  assert.deepStrictEqual(meaningfulEntries(null, ["a"]), []);
});

test("meaningfulEntries counts a non-empty array value (tiered field) as present", () => {
  const arr = [
    { school_or_university: "", degree: ["Bachelor of Science", "Bachelors"] }, // kept (tier)
    { school_or_university: "", degree: [] }                                     // dropped (empty array)
  ];
  assert.strictEqual(meaningfulEntries(arr, ["school_or_university", "degree"]).length, 1);
});

test("keeps an entry with a job_title only", () => {
  const out = meaningfulWorkExperience([{ job_title: "Engineer", company: "" }]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].job_title, "Engineer");
});

test("keeps an entry with a company only", () => {
  assert.strictEqual(meaningfulWorkExperience([{ job_title: "", company: "Acme" }]).length, 1);
});

test("drops entries that are empty / whitespace / missing fields", () => {
  const out = meaningfulWorkExperience([
    { job_title: "", company: "" },
    { job_title: "   ", company: "  " },
    {},
    null
  ]);
  assert.deepStrictEqual(out, []);
});

test("filters a mixed list and preserves order", () => {
  const out = meaningfulWorkExperience([
    { job_title: "First", company: "" },
    { job_title: "", company: "" },         // dropped
    { job_title: "", company: "Third Co" }
  ]);
  assert.deepStrictEqual(out.map((e) => e.job_title || e.company), ["First", "Third Co"]);
});

test("non-array input returns []", () => {
  assert.deepStrictEqual(meaningfulWorkExperience(undefined), []);
  assert.deepStrictEqual(meaningfulWorkExperience(null), []);
  assert.deepStrictEqual(meaningfulWorkExperience("nope"), []);
});

test("joinBullets joins with newlines in order", () => {
  assert.strictEqual(joinBullets(["Built X", "Led Y", "Shipped Z"]), "Built X\nLed Y\nShipped Z");
});

test("joinBullets drops empty / whitespace-only bullets", () => {
  assert.strictEqual(joinBullets(["Built X", "", "   ", "Led Y"]), "Built X\nLed Y");
});

test("joinBullets returns '' for empty / non-array / non-string items", () => {
  assert.strictEqual(joinBullets([]), "");
  assert.strictEqual(joinBullets(undefined), "");
  assert.strictEqual(joinBullets(null), "");
  assert.strictEqual(joinBullets("nope"), "");
  assert.strictEqual(joinBullets([null, 42, {}]), "");
});
