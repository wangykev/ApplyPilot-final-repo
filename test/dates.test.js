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
});

// ⚠⚠ THIS ASSERTION USED TO BE THE OPPOSITE, and the old one was the bug (live 2026-09-08).
// It read `parseYearMonth("2023-05-01") === null  // full date, not YYYY-MM` — a rule about the
// STRING's shape, when the caller's actual question is "which month and year is this?". The
// website's profile editor stores work-experience dates as FULL dates ("2026-05-15",
// "2024-09-01", "2025-05-01" — read live out of Supabase), so every one parsed to null and:
//   • the REQUIRED Workday From/To fell through to the AI, which gave all three of the
//     operator's jobs the SAME 8/2024–5/2028 (their education span);
//   • workExperienceRecency / sortWorkExperienceByRecency scored every entry -Infinity, so
//     "most recent first" silently became "whatever order the profile stored".
// A green suite reported all of that as fine, because the test agreed with the code about a
// premise they were both wrong about.
test("⚠ parseYearMonth ACCEPTS a full YYYY-MM-DD and discards the day", () => {
  // The Workday From/To composite is MM/YYYY and has NO day slot, so dropping the day is the
  // form's own granularity, not lost precision. Deterministic + unflagged: a stated fact.
  assert.deepStrictEqual(parseYearMonth("2026-05-15"), { year: "2026", month: "05" });
  assert.deepStrictEqual(parseYearMonth("2024-09-01"), { year: "2024", month: "09" });
  assert.deepStrictEqual(parseYearMonth("2025-05-01"), { year: "2025", month: "05" });
  assert.deepStrictEqual(parseYearMonth("2024-6-5"), { year: "2024", month: "06" }); // un-padded
  // and the day must not leak into the returned segments — the composite has nowhere to put it
  assert.deepStrictEqual(Object.keys(parseYearMonth("2026-05-15")).sort(), ["month", "year"]);
});

test("⚠ parseYearMonth still refuses placeholders and impossible dates", () => {
  // The literal placeholders must never be typed into a form, in either shape.
  assert.strictEqual(parseYearMonth("YYYY-MM"), null);
  assert.strictEqual(parseYearMonth("YYYY-MM-DD"), null);
  // An out-of-range DAY rejects the WHOLE string: if it is not a real date, its month and year
  // are not trustworthy evidence either — the same judgement parseYearMonthDay makes.
  assert.strictEqual(parseYearMonth("2024-06-32"), null);
  assert.strictEqual(parseYearMonth("2024-06-00"), null);
  assert.strictEqual(parseYearMonth("2024-13-01"), null); // month still range-checked with a day
  // and nothing longer than a date sneaks through the optional group
  assert.strictEqual(parseYearMonth("2024-06-15-01"), null);
  assert.strictEqual(parseYearMonth("2024-06-15T00:00:00Z"), null);
});
