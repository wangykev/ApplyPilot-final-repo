// test/icims-walk-guards.test.js — the never-submit guards on the iCIMS multi-page walk.
//
// This walk presses `cp_form_submit_i`, which on iCIMS is NEXT on every step but the last and the
// REAL SUBMIT on the last. So a mistake here submits an application that no human approved. That is
// the same hazard Workday's footer button has (it reuses Submit's automation-id on the review page)
// and it is why that walk carries a double guard.
//
// ⚠ ORACLE'S GUARD 2 CANNOT BE REUSED. `orcAdvanceAfterStep` pairs "no Next control" with
// `atsInjOrcClickButton` refusing a forbidden CAPTION. On iCIMS both roles belong to the SAME element
// with the SAME caption, so a caption check is worthless and the absence of a Next control cannot
// mark the end either. Both iCIMS guards therefore read the platform's own step declaration, at two
// different times.
//
// SOURCE-TEXT guard (the house pattern — see the orcAdvanceAfterStep test in test/ats.test.js):
// background.js is a service-worker file and cannot be require()d, so these assertions read the
// source. Comments are stripped FIRST, because both functions now *document* the shapes they refuse
// and a naive grep would match the explanation instead of the code.
//
// Run: node --test test/icims-walk-guards.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

// ⚠ `[^\r\n]*`, NEVER `.*$` — JS `.` does not match `\r` and this repo checks out CRLF, so `.*`
// cannot reach `$` and NOTHING is stripped (see test/sw-globals.test.js for the full note).
const strip = (t) => String(t)
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .split("\n").map((l) => l.replace(/\/\/[^\r\n]*/, "")).join("\n");

const src = strip(fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8"));

/** The body of a named function, up to the next top-level declaration. */
function bodyOf(header) {
  const i = src.indexOf(header);
  assert.ok(i > 0, "could not find " + header);
  const rest = src.slice(i + header.length);
  const end = rest.search(/\n(async )?function [a-zA-Z]/);
  return rest.slice(0, end === -1 ? rest.length : end);
}

test("⚠⚠ the advance refuses unless isLast is EXACTLY false", () => {
  const fn = bodyOf("async function icimsAdvanceAfterStep(");
  // `!== false` is the whole guard: `true` is the submit step and `null` is an UNKNOWN position,
  // and unknown must never read as safe to press. A truthy test (`if (!isLast)`) would press on
  // null — the exact shape of the ORC count rule this codebase already paid for.
  assert.match(fn, /isLast\s*!==\s*false/,
    "terminality must be tested against the literal false, so an unknown position also refuses");
  assert.ok(!/if\s*\(\s*!\s*before\.isLast\s*\)/.test(fn),
    "a truthy test would press when the step position is UNKNOWN (null)");
});

test("⚠⚠ guard 2 is a SECOND, LATER read — not the caller's value reused", () => {
  const fn = bodyOf("async function icimsAdvanceAfterStep(");
  // ⚠ MATCHES ANY ARGUMENTS on purpose. This was `icimsStepState\(\)` and broke the moment the read
  // gained `{scrollSubmit:true}` — the guard was still there and still second, so a literal pattern
  // would have forced a REAL fix to be reverted to satisfy a test about something else. What matters
  // is that the advance takes its OWN read and refuses before pressing, not the argument list.
  assert.match(fn, /await\s+icimsStepState\(/,
    "the advance must re-read the step state itself; trusting the caller's read is one guard, not two");
  // and the refusal must come BEFORE anything is pressed
  const readAt = fn.search(/await\s+icimsStepState\(/);
  const guardAt = fn.search(/isLast\s*!==\s*false/);
  const clickAt = fn.search(/atsAimedClick/);
  assert.ok(readAt >= 0 && guardAt > readAt, "the guard must follow its own read");
  assert.ok(clickAt > guardAt, "nothing may be pressed before the guard has run");
});

test("⚠ a step declaration that disagrees with the DOM order REFUSES", () => {
  const fn = bodyOf("async function icimsAdvanceAfterStep(");
  assert.match(fn, /declaredAgrees\s*===\s*false/,
    "when 'Step N of M' and the step list disagree, which step is last is unsettled — refuse, never pick one");
});

test("⚠ terminality is NOT decided by comparing a step number to a total", () => {
  const fn = bodyOf("async function icimsAdvanceAfterStep(");
  // The ORC ruling, restated for this platform: Baylor serves 5 sections for 4 steps, so a count is
  // not terminality. Here the structural answer comes from atsInjIcimsSteps (nothing after this li).
  assert.ok(!/step\s*>=\s*total|>=\s*before\.total|step\s*===\s*total/.test(fn),
    "the step count must not be compared to a total to decide whether to press the submit control");
});

test("⚠ reaching the last step is the SUCCESS terminal, and it presses nothing", () => {
  const fn = bodyOf("async function icimsAdvanceAfterStep(");
  assert.match(fn, /reached-final-step/,
    "the fill must end on the last step the way the Workday walk ends on the review page");
  const finalAt = fn.search(/reached-final-step/);
  const clickAt = fn.search(/atsAimedClick/);
  assert.ok(finalAt < clickAt, "the final-step terminal must be reached before any press");
});

test("⚠ the advance predicate is MONOTONE — the declared step went UP", () => {
  const fn = bodyOf("async function icimsAdvanceAfterStep(");
  assert.match(fn, /now\.step\s*>\s*before\.step/,
    "a monotone predicate can be noticed late but never missed — the standing rule for every poll here");
});

test("⚠ a refused advance halts with the FORM's own words, and never retries in place", () => {
  const fn = bodyOf("async function icimsAdvanceAfterStep(");
  assert.match(fn, /atsInjErrors/, "the page's own error text is what the operator needs");
  assert.match(fn, /step-did-not-advance/);
  // no second press: exactly one aimed click in the whole function
  assert.strictEqual((fn.match(/atsAimedClick/g) || []).length, 1,
    "one press per advance — a retry loop on a control that may be the submit is not acceptable");
});

test("⚠⚠ the walk routes iCIMS to its OWN advance, and Oracle to Oracle's", () => {
  assert.match(src, /ats === "icims"\s*\n?\s*\?\s*await icimsAdvanceAfterStep\(/,
    "iCIMS must not be handed orcAdvanceAfterStep — its guard 2 is caption-based and cannot work here");
  assert.match(src, /await orcAdvanceAfterStep\(/, "Oracle keeps its own advance");
});

test("⚠ iCIMS is in the MULTI walk, and Greenhouse/Lever/Ashby are NOT", () => {
  assert.match(src, /const MULTI = ats === "oracle" \|\| ats === "icims"/);
  // the single-page platforms must stay single-page — one press there IS the submit, with no steps
  for (const one of ["greenhouse", "lever", "ashby"]) {
    assert.ok(!new RegExp('MULTI = [^;]*"' + one + '"').test(src),
      one + " must not enter the multi-step walk");
  }
});

test("⚠ Oracle's block settle does not run on iCIMS", () => {
  // orcAwaitBlocksPopulated polls for ORC's separately-fetched question blocks — an inventory iCIMS
  // does not have, so running it here would poll for something that never arrives.
  assert.match(src, /if \(ats !== "icims"\) await orcAwaitBlocksPopulated\(LOG\)/);
});

test("⚠ the résumé stage stays OUTSIDE the step loop — a second parse destroys the fill", () => {
  // iCIMS parses the upload server-side and posts the result back, re-rendering the form. Attaching
  // once per step would land that parse ON TOP of a filled step.
  const stageAt = src.indexOf("atsIcimsResumeStage");
  const loopAt = src.indexOf("for (let iter = 1; iter <= (MULTI ? ORC_MAX_STEPS : 1); iter++)");
  assert.ok(stageAt > 0 && loopAt > 0 && stageAt < loopAt,
    "the résumé must be attached before the walk begins, not inside it");
});
