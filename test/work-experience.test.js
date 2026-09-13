// Unit test for the pure meaningful-entry filter (lib.js) — runs without a page.
// It decides how many Work-Experience entries the engine fills/adds, so dropping the
// empty placeholder rows (and keeping order) matters.
const test = require("node:test");
const assert = require("node:assert");

const { meaningfulWorkExperience, meaningfulEntries, joinBullets, ensureHttps, isFluent, sortWorkExperienceByRecency, workExperienceRecency } = require("../lib.js");

test("isFluent — true only for a 'fluent' value (string or in a tiered array)", () => {
  assert.strictEqual(isFluent("Fluent"), true);
  assert.strictEqual(isFluent("  fluent  "), true);
  assert.strictEqual(isFluent(["Fluent", "Advanced"]), true);
  assert.strictEqual(isFluent("Intermediate"), false);
  assert.strictEqual(isFluent("Advanced"), false);
  assert.strictEqual(isFluent(""), false);
  assert.strictEqual(isFluent(null), false);
});

test("ensureHttps canonicalizes to the FULL link — scheme + www on a bare apex host", () => {
  assert.strictEqual(ensureHttps("linkedin.com/in/wangykev"), "https://www.linkedin.com/in/wangykev");
  assert.strictEqual(ensureHttps("https://github.com/x"), "https://www.github.com/x", "a scheme alone isn't the full link — the apex still gains www");
  assert.strictEqual(ensureHttps("http://x.com"), "http://www.x.com", "an explicit http scheme is the operator's choice; only the host changes");
  assert.strictEqual(ensureHttps("  example.com  "), "https://www.example.com");
  assert.strictEqual(ensureHttps(""), "");
  assert.strictEqual(ensureHttps(null), "");
});

// The whole point of requiring www: the stored value must equal what the page ends up holding, or the
// M40 audit flags it and the submit gate BLOCKS on a review-page DISAGREE (www. is inserted mid-string,
// so containment can't save it, and fuzzy lands at 89 vs the 90 bar). Idempotency is what makes
// re-normalizing an already-canonical profile a no-op instead of "www.www.".
test("ensureHttps is IDEMPOTENT — an already-canonical URL is returned byte-identical", () => {
  const canonical = "https://www.linkedin.com/in/wangykev";
  assert.strictEqual(ensureHttps(canonical), canonical);
  assert.strictEqual(ensureHttps(ensureHttps("linkedin.com/in/wangykev")), canonical, "normalizing twice must not stack www.");
});

// www is only correct on an APEX host. Prepending it to a host that already has a subdomain invents a
// name that usually does not resolve ("www.blog.example.com"), which would turn a working profile link
// into a dead one — a worse failure than the mismatch this change fixes.
test("ensureHttps NEVER adds www to a host that already carries a subdomain", () => {
  assert.strictEqual(ensureHttps("blog.example.com/post"), "https://blog.example.com/post");
  assert.strictEqual(ensureHttps("gist.github.com/x"), "https://gist.github.com/x");
  assert.strictEqual(ensureHttps("https://sub.domain.example.com"), "https://sub.domain.example.com");
});

test("ensureHttps treats a multi-part public suffix as an apex (example.co.uk gains www; www.example.co.uk doesn't)", () => {
  assert.strictEqual(ensureHttps("example.co.uk"), "https://www.example.co.uk");
  assert.strictEqual(ensureHttps("example.co.uk/cv"), "https://www.example.co.uk/cv");
  assert.strictEqual(ensureHttps("www.example.co.uk"), "https://www.example.co.uk");
});

test("ensureHttps never touches an IP host, and never throws on an unparseable value", () => {
  assert.strictEqual(ensureHttps("https://192.168.0.1/x"), "https://192.168.0.1/x");
  assert.strictEqual(ensureHttps("localhost:3000"), "https://localhost:3000", "single-label host → no www");
  assert.strictEqual(ensureHttps("https://"), "https://", "unparseable → returned as-is, no throw");
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

// ── sortWorkExperienceByRecency — most-recent job first (by end date) ──────────
const titles = (arr) => sortWorkExperienceByRecency(arr).map((e) => e.job_title);

test("sorts by end date descending (most recent first)", () => {
  const arr = [
    { job_title: "Old", to: "2018-06" },
    { job_title: "Newest", to: "2023-01" },
    { job_title: "Middle", to: "2020-11" }
  ];
  assert.deepStrictEqual(titles(arr), ["Newest", "Middle", "Old"]);
});

test("a currently-held job comes first (no end date = most recent)", () => {
  const arr = [
    { job_title: "Past", to: "2023-12" },
    { job_title: "Current", currently_work_here: true, to: "" },
    { job_title: "Older", to: "2019-03" }
  ];
  assert.deepStrictEqual(titles(arr), ["Current", "Past", "Older"]);
});

test("currently_work_here wins even if a stale 'to' is stored", () => {
  const arr = [
    { job_title: "Recent", to: "2024-05" },
    { job_title: "Current", currently_work_here: true, to: "2010-01" } // bad stored 'to' ignored
  ];
  assert.deepStrictEqual(titles(arr), ["Current", "Recent"]);
});

test("missing/placeholder end date falls back to start date (not dumped last)", () => {
  const arr = [
    { job_title: "EndedEarly", to: "2019-12" },
    { job_title: "OpenStartedLater", from: "2021-02", to: "YYYY-MM" } // no real end → use start 2021
  ];
  assert.deepStrictEqual(titles(arr), ["OpenStartedLater", "EndedEarly"]);
});

test("entries with no parseable dates sort last, in original order (stable)", () => {
  const arr = [
    { job_title: "NoDatesA" },
    { job_title: "Dated", to: "2020-01" },
    { job_title: "NoDatesB" }
  ];
  assert.deepStrictEqual(titles(arr), ["Dated", "NoDatesA", "NoDatesB"]);
});

test("two currently-held jobs tie-break by start date desc, then stable order", () => {
  const arr = [
    { job_title: "CurStartedEarlier", currently_work_here: true, from: "2015-01" },
    { job_title: "CurStartedLater", currently_work_here: true, from: "2022-08" }
  ];
  assert.deepStrictEqual(titles(arr), ["CurStartedLater", "CurStartedEarlier"]);
});

test("equal end dates keep original profile order (stable)", () => {
  const arr = [
    { job_title: "First", to: "2020-06" },
    { job_title: "Second", to: "2020-06" }
  ];
  assert.deepStrictEqual(titles(arr), ["First", "Second"]);
});

test("reorders without mutating the input array", () => {
  const arr = [
    { job_title: "Old", to: "2018-01" },
    { job_title: "New", to: "2022-01" }
  ];
  const out = sortWorkExperienceByRecency(arr);
  assert.deepStrictEqual(arr.map((e) => e.job_title), ["Old", "New"]); // input untouched
  assert.deepStrictEqual(out.map((e) => e.job_title), ["New", "Old"]);
});

test("non-array input returned as-is", () => {
  assert.strictEqual(sortWorkExperienceByRecency(null), null);
  assert.strictEqual(sortWorkExperienceByRecency(undefined), undefined);
});

test("workExperienceRecency: currently-held = Infinity; by end then start; else -Infinity", () => {
  assert.strictEqual(workExperienceRecency({ currently_work_here: true }), Infinity);
  assert.strictEqual(workExperienceRecency({ to: "2020-03" }), 2020 * 12 + 3);
  assert.strictEqual(workExperienceRecency({ from: "2019-07", to: "YYYY-MM" }), 2019 * 12 + 7);
  assert.strictEqual(workExperienceRecency({}), -Infinity);
});

// ── FULL ISO DATES — the shape the website's profile editor actually stores ────────────────
//
// ⚠⚠ Every test above uses "YYYY-MM", which is what the ORIGINAL profile format stored — so this
// whole recency suite passed green while the operator's real profile (full dates: "2026-05-15",
// "2024-09-01", "2025-05-01", read live out of Supabase 2026-09-08) scored -Infinity across the
// board and the ordering silently degraded to the profile's stored order. A fixture that only
// ever uses one of two live formats cannot notice that the other one is broken.

test("⚠ recency ranks FULL ISO dates, the format the website stores", () => {
  assert.strictEqual(workExperienceRecency({ to: "2020-03-17" }), 2020 * 12 + 3);
  // a full "from" still backs up a missing/placeholder "to"
  assert.strictEqual(workExperienceRecency({ from: "2019-07-01", to: "YYYY-MM-DD" }), 2019 * 12 + 7);
  // and the two formats are directly comparable, so a MIXED profile still orders correctly
  assert.ok(workExperienceRecency({ to: "2023-01-05" }) > workExperienceRecency({ to: "2020-11" }));
});

test("⚠ sorts most-recent-first with the operator's real full-date entries", () => {
  // The three jobs that filled GE Vernova (dates verbatim), deliberately supplied in a
  // NON-recency order so a no-op sort cannot pass this.
  const arr = [
    { job_title: "CMR", from: "2024-09-01", to: "2026-05-01" },
    { job_title: "Rivian", from: "2026-05-15", to: "2026-08-05" },
    { job_title: "FSU", from: "2025-05-01", to: "2025-08-01" }
  ];
  assert.deepStrictEqual(titles(arr), ["Rivian", "CMR", "FSU"]);
});

test("⚠ a mixed-format profile does not put full dates last", () => {
  const arr = [
    { job_title: "MonthOnly", to: "2019-01" },
    { job_title: "FullDate", to: "2024-08-05" }
  ];
  assert.deepStrictEqual(titles(arr), ["FullDate", "MonthOnly"]);
});
