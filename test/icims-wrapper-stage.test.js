// test/icims-wrapper-stage.test.js — an iCIMS /jobs/<id>/… url PROMISES a content frame.
//
// Live 2026-09-08 (Shure), and it cost three armed submits. With `?hub=7` iCIMS serves a branded
// WRAPPER first — title "Careers - Shure USA", a heading, one search input, and NO
// `#icims_content_iframe` element at all — then client-side navigates to the posting and mounts the
// frame. Timed by hand: still absent at 4.5s, present by ~15s.
//
// The settle's frame guard asks "is a frame ADVERTISED but not pinned yet?", which cannot fire while
// the <iframe> does not exist. So the wrapper satisfied `rendered` on its heading, the run read IT,
// found no auth fields and no Apply control, and halted apply-not-followable -> posting-gone. Both
// verdicts were FALSE: each posting renders its own "Apply for this job online" seconds later
// (verified by hand on 5013, 5028 and 4960).
//
// Run: node --test test/icims-wrapper-stage.test.js

const test = require("node:test");
const assert = require("node:assert");
const { icimsExpectsContentFrame } = require("../ats.js");

const SHURE = "https://careersus-shure.icims.com";

test("⚠⚠ a posting / apply / gate route promises a frame — the wrapper stage must be waited out", () => {
  for (const u of [
    `${SHURE}/jobs/5013/electrical-engineering-intern-%2528digital-circuitry%2529/job?hub=7`,
    `${SHURE}/jobs/5013/electrical-engineering-intern-%2528digital-circuitry%2529/job?hub=7&mode=apply&iis=LinkedIn`,
    `${SHURE}/jobs/4960/automated-test-engineering-intern/job`,
    `${SHURE}/jobs/4960/automated-test-engineering-intern/login?hub=7`,
    `${SHURE}/jobs/4960/automated-test-engineering-intern/candidate`,
    `${SHURE}/jobs/5028/x/job`,
    "https://astrioncareers-astrion.icims.com/jobs/12345/some-role/job",
  ]) assert.strictEqual(icimsExpectsContentFrame(u), true, u);
});

test("⚠ /jobs/search does NOT promise one — the id is what makes it a posting route", () => {
  // This is the page a bounced apply-mode link lands on. Waiting 12s for a frame there would turn a
  // real dead end into a slow one, and it is also where `posting-gone` is legitimately decided.
  assert.strictEqual(icimsExpectsContentFrame(`${SHURE}/jobs/search?hashed=-435589572`), false);
  assert.strictEqual(icimsExpectsContentFrame(`${SHURE}/jobs/search`), false);
  assert.strictEqual(icimsExpectsContentFrame(`${SHURE}/jobs`), false);
  assert.strictEqual(icimsExpectsContentFrame(`${SHURE}/`), false);
});

test("⚠ NON-iCIMS hosts are untouched — this must never make another platform wait", () => {
  for (const u of [
    "https://job-boards.greenhouse.io/acme/jobs/123",
    "https://jobs.lever.co/acme/abc-123/apply",
    "https://jobs.ashbyhq.com/acme/uuid/application",
    "https://acme.wd1.myworkdayjobs.com/en-US/acme/job/x_R1/apply",
    "https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/123",
    // a lookalike host must not match — the same anchoring discipline detectAts uses
    "https://icims.com.evil.com/jobs/5013/x/job",
  ]) assert.strictEqual(icimsExpectsContentFrame(u), false, u);
});

test("⚠ the RECRUITER login is NOT this predicate's job — it is refused earlier", () => {
  // login.icims.com IS an icims host, so this returns true for it, and that is correct scope: the
  // pre-form refuses the staff login via `icimsIsAdminLogin` BEFORE the settle ever runs, so this is
  // never consulted there. Asserting false here would be testing the wrong function's invariant, and
  // "fixing" the predicate to satisfy it would duplicate a refusal that already exists — the kind of
  // second copy this codebase keeps paying for. Pinned as scope, not as behaviour to rely on.
  assert.strictEqual(icimsExpectsContentFrame("https://login.icims.com/jobs/5013/x/job"), true);
});

test("junk in, false out — never throws", () => {
  for (const u of ["", null, undefined, "not a url", "javascript:alert(1)", 42, {}])
    assert.strictEqual(icimsExpectsContentFrame(u), false, String(u));
});
