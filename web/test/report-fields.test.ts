import { test } from "node:test";
import assert from "node:assert/strict";
import { reportColumns, loginFields, str } from "../lib/report-fields";

// THE RULE: a report never NULLS a column it wasn't given a value for.
// Live 2026-07-28 — the tracker row lost its company and role after a Rehearse run, keeping only the url.
// `reportApplication` sends `role: null` on EVERY report (the extension doesn't know the job title) and
// `company: null` when the run has no jobContext; the route wrote those nulls into an UPDATE and erased
// what the FILL had recorded. The fill path only survived because saveRunJob rewrites company/role
// afterwards from the scraped JD — a submit run has no such follow-up.

test("reportColumns: a payload with NO company/role OMITS them, so an UPDATE can't erase them", () => {
  const cols = reportColumns({ url: "https://x/apply", job_key: "wd5:r1", status: "needs_review", company: null, role: null }, "u1");
  assert.equal("company" in cols, false, "absent company must not be written as null");
  assert.equal("role" in cols, false, "absent role must not be written as null");
  assert.equal(cols.url, "https://x/apply", "what IS carried still gets written");
  assert.equal(cols.job_key, "wd5:r1");
});

test("reportColumns: values that ARE carried get written", () => {
  const cols = reportColumns({ company: "Solar Turbines", role: "2027 Gas Turbine Intern", url: "https://x", captured_at: "2026-07-28T00:00:00Z" }, "u1");
  assert.equal(cols.company, "Solar Turbines");
  assert.equal(cols.role, "2027 Gas Turbine Intern");
  assert.equal(cols.applied_at, "2026-07-28T00:00:00Z");
});

test("reportColumns: whitespace-only is treated as absent, not as a value", () => {
  const cols = reportColumns({ company: "   ", role: "\t" }, "u1");
  assert.equal("company" in cols, false);
  assert.equal("role" in cols, false);
});

test("reportColumns: the report's OWN payload is always written", () => {
  const bundle = { entries: [] };
  const cols = reportColumns({ status: "needs_review", needs_review_count: 3, review_bundle: bundle }, "u1");
  assert.equal(cols.user_id, "u1");
  assert.equal(cols.status, "needs_review");
  assert.equal(cols.needs_review_count, 3);
  assert.equal(cols.review_bundle_json, bundle);
  // …and a missing count/bundle still writes a definite value (that IS the report).
  const bare = reportColumns({}, "u1");
  assert.equal(bare.needs_review_count, 0);
  assert.equal(bare.review_bundle_json, null);
});

test("reportColumns: an unknown status falls back to needs_review, never through unvalidated", () => {
  assert.equal(reportColumns({ status: "nonsense" }, "u1").status, "needs_review");
  assert.equal(reportColumns({ status: "submitted" }, "u1").status, "submitted");
  assert.equal(reportColumns({}, "u1").status, "needs_review");
});

test("loginFields: an absent or emailless login writes NOTHING (never blanks the account on file)", () => {
  assert.deepEqual(loginFields(undefined), {});
  assert.deepEqual(loginFields(null), {});
  assert.deepEqual(loginFields({ tenant: "Cat" }), {}, "no email ⇒ nothing truthful to record");
  assert.deepEqual(loginFields({ email: "   " }), {});
});

test("loginFields: a real login is normalized", () => {
  const f = loginFields({ email: "  Tester+10@Gmail.com ", tenant: "Cat", host: "cat.wd5.myworkdayjobs.com", created: true, verified: false, at: "2026-07-28T00:00:00Z" });
  assert.equal(f.login_email, "tester+10@gmail.com", "trimmed + lowercased");
  assert.equal(f.login_tenant, "Cat");
  assert.equal(f.login_created, true);
  assert.equal(f.login_verified, false);
  assert.equal(f.login_at, "2026-07-28T00:00:00Z");
});

test("str: trims, and treats empty/whitespace/non-strings as absent", () => {
  assert.equal(str("  x "), "x");
  assert.equal(str(""), null);
  assert.equal(str("   "), null);
  assert.equal(str(42), null);
  assert.equal(str(null), null);
});
