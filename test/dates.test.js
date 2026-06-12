// Unit test for the pure date parser (lib.js) — runs without a page.
// The placeholder-rejection case is the load-bearing one: it stops the engine from
// typing a literal "YYYY-MM" into Workday's date spinbuttons.
const test = require("node:test");
const assert = require("node:assert");

const { parseYearMonth, parseYearMonthDay, parseYear } = require("../lib.js");

test("parseYearMonthDay parses a real YYYY-MM-DD (zero-padded)", () => {
  assert.deepStrictEqual(parseYearMonthDay("2024-06-15"), { year: "2024", month: "06", day: "15" });
  assert.deepStrictEqual(parseYearMonthDay("2024-6-5"), { year: "2024", month: "06", day: "05" });
});

test("parseYearMonthDay rejects the placeholder, partial dates, and out-of-range", () => {
  assert.strictEqual(parseYearMonthDay("YYYY-MM-DD"), null);
  assert.strictEqual(parseYearMonthDay("2024-06"), null);  // partial (YYYY-MM) — don't half-fill
  assert.strictEqual(parseYearMonthDay("2024-13-01"), null);
  assert.strictEqual(parseYearMonthDay("2024-06-32"), null);
  assert.strictEqual(parseYearMonthDay("2024-00-10"), null);
  assert.strictEqual(parseYearMonthDay("2024-06-00"), null);
});

test("parseYearMonthDay rejects empty / null / garbage", () => {
  assert.strictEqual(parseYearMonthDay(""), null);
  assert.strictEqual(parseYearMonthDay(null), null);
  assert.strictEqual(parseYearMonthDay(undefined), null);
  assert.strictEqual(parseYearMonthDay("not-a-date"), null);
});

test("parseYear accepts a 4-digit year, rejects placeholder/empty/non-4-digit", () => {
  assert.strictEqual(parseYear("2021"), "2021");
  assert.strictEqual(parseYear("  2021  "), "2021");
  assert.strictEqual(parseYear("YYYY"), null);
  assert.strictEqual(parseYear(""), null);
  assert.strictEqual(parseYear(null), null);
  assert.strictEqual(parseYear("21"), null);
  assert.strictEqual(parseYear("2021-05"), null);
});

test("parseYearMonth parses a real YYYY-MM", () => {
  assert.deepStrictEqual(parseYearMonth("2023-05"), { year: "2023", month: "05" });
});

test("parseYearMonth rejects the YYYY-MM placeholder (skip, not fill)", () => {
  assert.strictEqual(parseYearMonth("YYYY-MM"), null);
});

test("parseYearMonth normalizes an un-padded month", () => {
  assert.deepStrictEqual(parseYearMonth("2023-5"), { year: "2023", month: "05" });
});

test("parseYearMonth rejects an out-of-range month", () => {
  assert.strictEqual(parseYearMonth("2023-13"), null);
  assert.strictEqual(parseYearMonth("2023-00"), null);
});

test("parseYearMonth rejects empty / null / garbage", () => {
  assert.strictEqual(parseYearMonth(""), null);
  assert.strictEqual(parseYearMonth(null), null);
  assert.strictEqual(parseYearMonth(undefined), null);
  assert.strictEqual(parseYearMonth("not-a-date"), null);
  assert.strictEqual(parseYearMonth("2023-05-01"), null); // full date, not YYYY-MM
});
