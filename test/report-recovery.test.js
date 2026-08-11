"use strict";
// SELF-HEALING REPORT RECOVERY (2026-08-11).
//
// The failure: `getSession` rotates the reporting key, so any re-link elsewhere leaves the extension
// holding a credential the server deleted and every completed fill 401s. That used to be silent DATA
// LOSS — minutes of filling, a good bundle, and nothing but a console line plus an `apReportError`
// marker that no code ever read. The repair parks the payload and re-POSTs it the moment a working
// credential arrives, so the user sees their application appear instead of a diagnostic.
//
// Source-level: background.js can't be require()d (it expects chrome.* at load) and the web guard is
// a React client component. The idiom is test/pacing-clock.test.js. What is pinned here is the set of
// properties whose violation is silent — each one fails in a way no test run or log line would show.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const bg = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
const guard = fs.readFileSync(
  path.join(__dirname, "..", "web", "app", "app", "tracker", "ReportHealthGuard.tsx"), "utf8");

function slice(src, from, toMarker) {
  const a = src.indexOf(from);
  assert.ok(a > 0, `not found: ${from}`);
  const b = src.indexOf(toMarker, a);
  return src.slice(a, b > a ? b : a + 4000);
}

test("a REJECTED report parks the payload — the run's work must survive a bad credential", () => {
  const body = slice(bg, "if (!outcome.ok) {", "// …and TELL THE CALLER");
  assert.match(body, /apPendingReport:\s*\{[^}]*payload/,
    "the payload itself must be stored; recording only that it failed is what made this data loss");
});

test("a SUCCESSFUL report clears the parked payload AND the error marker", () => {
  const body = slice(bg, "if (!outcome.ok) {", "// …and TELL THE CALLER");
  assert.match(body, /remove\(\["apReportError",\s*"apPendingReport"\]\)/,
    "a healthy report must leave no stale marker — the site reads apReportError to decide whether to heal");
});

// THE ROTATION-LOOP GUARD. Every heal calls getSession, which DELETES the user's key row and mints a
// new one. So if a successful flush left apReportError set, the tracker would heal on every single
// visit, rotating the credential each time — and two open tabs would rotate each other's keys
// forever. Clearing both together is what terminates the cycle.
test("flushPendingReport clears BOTH markers on success (else the site re-heals and rotates forever)", () => {
  const fn = slice(bg, "async function flushPendingReport()", "\n// The website is now the primary REVIEW");
  assert.match(fn, /remove\(\["apPendingReport",\s*"apReportError"\]\)/,
    "clearing only the payload leaves apReportError set, which re-triggers a heal on the next visit");
});

test("flushPendingReport does NOT report success when the retry was rejected again", () => {
  const fn = slice(bg, "async function flushPendingReport()", "\n// The website is now the primary REVIEW");
  assert.match(fn, /if \(!outcome\.ok\)[\s\S]{0,320}return \{ flushed: false/,
    "a still-rejected retry must stay parked and report failure — a false success would drop the run");
  assert.ok(!/remove\(\[[\s\S]{0,80}\)[\s\S]{0,40}if \(!outcome\.ok\)/.test(fn),
    "must not clear the parked payload before knowing the retry succeeded");
});

test("a fresh credential triggers the flush — the ONE event that can repair the failure", () => {
  const body = slice(bg, 'if (type === "AP_SET_SESSION")', 'if (type === "AP_REPORT_HEALTH")');
  assert.match(body, /await flushPendingReport\(\)/,
    "storing a new key without retrying the parked report leaves the user's application lost anyway");
  assert.match(body, /recovered: !!flush\.flushed/,
    "the caller needs to know the APPLICATION landed, not merely that a credential was stored");
});

test("AP_REPORT_HEALTH leaks no credential and no bundle", () => {
  const body = slice(bg, 'if (type === "AP_REPORT_HEALTH")', "// Resume bytes");
  assert.ok(!/ingestKey\s*[,:]/.test(body.replace(/apSession\.ingestKey/g, "")),
    "the health probe must never return the key itself");
  assert.ok(!/payload\s*[,:]\s*(pending|s\.)/.test(body),
    "the health probe must never return the parked bundle — it reports the SHAPE of the problem only");
  assert.match(body, /healthy:/, "the site's whole reason to call this is a healthy/not answer");
});

// ── the web guard ────────────────────────────────────────────────────────────────────────────────
// The one thing here that would be catastrophic rather than merely broken.
test("the tracker guard heals with the TRACKING-ONLY link — never the destructive full sync", () => {
  // Match the INVOCATION shape, not the bare name — the file names the forbidden messages in its
  // header on purpose, so the next reader knows which calls are off-limits and why.
  assert.match(guard, /type:\s*"AP_SET_SESSION"/, "healing pushes the reporting credential");
  assert.ok(!/type:\s*"AP_SYNC_PROFILE"/.test(guard),
    "AP_SYNC_PROFILE overwrites the extension's profile/buckets — silently destroying user data to fix "
    + "a reporting key would be far worse than the bug being fixed");
  assert.ok(!/type:\s*"AP_SYNC_RESUME"/.test(guard), "same for the resume");
  assert.ok(!/type:\s*"AP_SET_CREDENTIALS"/.test(guard), "and for the sign-in credentials");
});

test("the guard heals at most once per mount, and only on a REAL rejection", () => {
  assert.match(guard, /tried\.current/, "an unguarded heal rotates the key on every visit");
  assert.match(guard, /if \(!h\.ok \|\| h\.healthy \|\| !h\.hasPending\) return;/,
    "a healthy link, an unreachable extension, or nothing parked must all be no-ops — a speculative "
    + "heal would rotate a WORKING credential and cause the very failure it is meant to repair");
});

test("the guard is silent unless it has something to say", () => {
  assert.match(guard, /if \(state\.kind === "idle"\) return null;/,
    "the default state must render nothing — this is a repair, not a status readout");
});
