// test/ats-required-backcheck.test.js — a REQUIRED field still empty gets one more pass.
//
// Operator, 2026-09-13: "you should have a back check, after the first pass, if there are any
// required fields unanswered, go back and answer them so it can see questions like this and answer
// them."
//
// The case that earned it, measured on TWO tenants: `rcf3049` ("Please specify") is the CHILD of
// `rcf3048` ("How did you hear about us"). iCIMS declares the dependency in the DOM and the child's
// list reads "Please select…" until the parent commits — but the AI batch answers both in the SAME
// pass, so the child was asked to choose from a list nobody could read. It invented one, the commit
// failed, and on Rockefeller (where it is REQUIRED) the walk stopped at step 1.
//
// ⚠ THE CASCADE ROUNDS COULD NOT COVER THIS. They only consider fields NOT YET IN `results`
// (`fresh = …filter(f => !seen.has(f.fieldName))`), so a field that was attempted and came back
// empty was never looked at again. That is the gap.
//
// Every exclusion below is a load-bearing invariant this pass nearly broke while being written, and
// each is pinned here with the reason rather than the rule alone.
//
// Run: node --test test/ats-required-backcheck.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

// ⚠ `[^\r\n]*`, never `.*$` — CRLF checkout, and JS `.` does not match `\r`.
const strip = (t) => String(t)
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .split("\n").map((l) => l.replace(/\/\/[^\r\n]*/, "")).join("\n");
const src = strip(fs.readFileSync(path.join(__dirname, "..", "ats.js"), "utf8"));

const body = (() => {
  const i = src.indexOf("back-check:");
  assert.ok(i > 0, "the back-check pass must exist");
  // the whole enclosing block: back up to the rescan that feeds it
  const start = src.lastIndexOf("let rescan2", i);
  return src.slice(start, src.indexOf("atsCaptureMissingOptions", i));
})();

test("⚠ it re-reads the page rather than trusting the first scan", () => {
  // The entire point: a dependent list only EXISTS once its parent has committed, so the second
  // pass has to look again. Re-using the first scan would see the same empty list.
  assert.match(body, /await act\.eval\(atsInjScan, ats\)/);
  assert.match(body, /atsAssignEntryIndexes\(ats, rescan2\.fields\)/,
    "a fresh scan needs its entry ordinals stamped like any other");
});

test("⚠ REQUIRED and genuinely empty only", () => {
  assert.match(body, /if \(!f \|\| !f\.isRequired\) return false/,
    "an optional blank is the operator's own choice and blocks nothing");
  assert.match(body, /!String\(rec\.after == null \? "" : rec\.after\)\.trim\(\)/,
    "a field holding a value is answered — a flag on it does not make it unanswered");
});

test("⚠⚠ never re-actuates something deliberately SKIPPED", () => {
  // Oracle's address block actuates only the ANCHOR and leaves #city to the cascade, because typing
  // into a dependent CLEARS the anchor — it has its own test saying so. A back-check that re-filled
  // every required blank would undo exactly that, and did, before this line.
  assert.match(body, /rec\.status !== "needs_review" && rec\.status !== "error"/,
    "only an attempt that FAILED is this pass's remit");
});

test("⚠⚠ never re-types a widget that reported LOADING", () => {
  // Standing rule with its own test: the form's own search never answered, so a second attempt
  // re-types over something still in flight and learns nothing.
  assert.match(body, /still loading/i);
});

test("⚠ a credential is never re-typed from here", () => {
  assert.match(body, /if \(rec\.credential\) return false/);
});

test("⚠⚠ the stale record is REMOVED before the retry — atsFillFields APPENDS", () => {
  // Leaving it would put two rows for one field into the bundle, and the review page would show the
  // failed one alongside the answer.
  assert.match(body, /results\.splice\(i, 1\)/);
  const splice = body.indexOf("results.splice(i, 1)");
  const refill = body.indexOf("await atsFillFields(");
  assert.ok(splice > 0 && refill > splice, "the drop must happen BEFORE the re-fill appends");
});

test("⚠ ONE pass — a field two passes cannot answer is a genuine review item", () => {
  assert.strictEqual((body.match(/await atsFillFields\(/g) || []).length, 1,
    "no loop: this runs exactly once");
});

test("⚠ what it re-filled is marked, so the bundle can show it was a second attempt", () => {
  assert.match(body, /results\[i\]\.backChecked = true/);
});

test("⚠ it runs AFTER the cascade rounds and BEFORE the option capture", () => {
  // After, because it depends on values the first pass committed; before the counts/capture, so the
  // envelope reports what it actually left behind.
  const cascade = src.indexOf("cascade round ");
  const back = src.indexOf("back-check:");
  const capture = src.indexOf("atsCaptureMissingOptions(act");
  assert.ok(cascade > 0 && back > cascade, "the back-check follows the cascade rounds");
  assert.ok(capture > back, "…and precedes the read-only option capture");
});
