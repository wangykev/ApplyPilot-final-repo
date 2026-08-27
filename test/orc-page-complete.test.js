// ── A PAGE MUST BE COMPLETE BEFORE THE WALK ADVANCES (operator, 2026-08-24) ───────────────────
//
// "make sure each page is filled correctly before going to the next page. oracle allows you to go to
// the next page even if a certain page is unfilled, but the submit won't click so make sure each page
// is correct before moving on."
//
// The asymmetry is the point: Workday REFUSES the advance itself, so a gap there announces itself as a
// nav-timeout while the operator is watching. ORC advances happily and only withholds SUBMIT, so the
// same gap reaches the end of the walk silently and presents as a submit button that does nothing,
// three steps away from its cause.
//
// Live instance that prompted it: committing Country re-renders the whole address block, so a scan
// taken beforehand held stale ids and Oracle's default-locale labels. `addressLine1` wrote to a node
// that no longer existed (`set failed: not-found:#addressLine1-27`), `postalCode` matched a US ZIP
// against a "Pin Code" list, and because postal code is the geo ANCHOR the cascade never fired —
// leaving city / region1 / region2 empty too. The walk then advanced twice more.
const test = require("node:test");
const assert = require("node:assert");
const ats = require("../ats.js");

const F = (o) => Object.assign({ fieldName: "x", widgetType: "text", isRequired: true, value: null }, o);

test("a required field the form left EMPTY is a gap", () => {
  const gaps = ats.atsOrcRequiredGaps([
    F({ fieldName: "addressLine1", value: null }),
    F({ fieldName: "postalCode", widgetType: "select", value: "" }),
    F({ fieldName: "city", widgetType: "select", value: "   " }),   // whitespace is empty
  ]);
  assert.deepEqual(gaps.map((g) => g.fieldName), ["addressLine1", "postalCode", "city"]);
});

test("a required field WITH a value is not a gap, and neither is an optional empty one", () => {
  const gaps = ats.atsOrcRequiredGaps([
    F({ fieldName: "lastName", value: "Wang" }),
    F({ fieldName: "region2", widgetType: "select", value: "Leon" }),
    F({ fieldName: "middleNames", isRequired: false, value: null }),
    F({ fieldName: "addressLine2", isRequired: false, value: "" }),
  ]);
  assert.deepEqual(gaps, []);
});

// ⚠ Each exclusion below would otherwise halt a perfectly good walk.
test("file_upload is excluded — an accepted upload reports no value", () => {
  // ORC's file input reports empty once the upload is accepted, exactly as iCIMS' does. The résumé has
  // its own resume-not-attached halt; bundleSubmitBlockers excludes it for the same reason.
  assert.deepEqual(ats.atsOrcRequiredGaps([F({ fieldName: "resume-upload", widgetType: "file_upload", value: null })]), []);
});

test("a checkbox is excluded — unchecked is an ANSWER, not an empty field", () => {
  assert.deepEqual(ats.atsOrcRequiredGaps([F({ fieldName: "agree", widgetType: "checkbox", value: null })]), []);
});

test("⚠ the bot-detection DECOY is never a gap — it is not ours to fill", () => {
  // A honeypot is aria-hidden + untabbable. Treating it as an unfilled required field would halt every
  // run on the gate, and "filling it" is the one thing that must never happen.
  const decoy = F({ fieldName: "honey-pot", value: null, ariaHidden: true, tabIndex: -1 });
  assert.deepEqual(ats.atsOrcRequiredGaps([decoy]), [],
    "a decoy must be excluded whether it is pre-flagged or recognised by atsDecoyKind");
  assert.deepEqual(ats.atsOrcRequiredGaps([F({ fieldName: "z", value: null, decoy: true })]), []);
});

test("a non-array input is tolerated rather than thrown on", () => {
  for (const bad of [null, undefined, 0, "nope", {}]) {
    assert.deepEqual(ats.atsOrcRequiredGaps(bad), [], String(bad));
  }
});

// The wiring. ⚠ THE CONTRACT CHANGED BY OPERATOR DECISION (2026-08-24): "wait do not halt on a bad
// list, make sure it is correct" / "so refill it if it is wrong". An earlier version of this test
// asserted a HALT; halting was wrong, because it stops at step 1 and the operator then gets no review
// data for the later steps — which is exactly where they would answer the gap. So the invariant is now
// "refill, then report and carry on", with Oracle withholding SUBMIT as the backstop.
test("the walk REPORTS a required gap before advancing, and never halts on one", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const bg = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  const gate = bg.indexOf("if ((out.requiredGaps || []).length)");
  const adv = bg.indexOf("const adv = await orcAdvanceAfterStep(");
  assert.ok(gate > 0, "the walk must consult the page's own completeness verdict");
  assert.ok(adv > 0, "…and still have an advance to guard");
  assert.ok(gate < adv, "the check must come BEFORE the advance, or it reports too late to matter");
  assert.ok(!/walkStopped = "step-incomplete"/.test(bg),
    "a required gap must NOT halt the walk — the rest of the application has to reach review");
  assert.ok(/stepGaps\.push\(/.test(bg), "…and the gap must be carried out of the walk, not only logged");
  assert.ok(/required_gaps: stepGaps/.test(bg), "…and reported on the run result, so a caller can explain a dead Submit");
});

// The refill itself: rounds that RE-SCAN, and a hard exclusion that the existing geo tests caught me
// violating (the first version typed into #city, which clears the anchor that fills it).
test("the refill re-scans each round and never actuates a geo dependent", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.join(__dirname, "..", "ats.js"), "utf8");
  const i = src.indexOf("const ORC_REFILL_ROUNDS");
  assert.ok(i > 0, "the refill rounds must exist");
  const block = src.slice(i, i + 4200);
  assert.ok(/await act\.eval\(atsInjScan, ats\)/.test(block),
    "each round must re-scan — a stale scan is what caused the failure this fixes");
  assert.ok(/filter\(\(f\) => !f\.geoDependent\)/.test(block),
    "a geo dependent must never be retried: typing into one clears the anchor that fills it");
  assert.ok(/left\.length >= before/.test(block),
    "a round that changes nothing must stop, rather than spinning on an unanswerable field");
});

// And the cause: country is the address block's parent, so it commits first and forces a re-scan.
test("country is committed BEFORE the address block is scanned for filling", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.join(__dirname, "..", "ats.js"), "utf8");
  const pre = src.indexOf("country committed FIRST");
  const cap = src.indexOf("await atsCaptureOrcOptions(");
  // ⚠ Anchor on the CALL, not the name: `atsOrcGeoPlan(` also matches the function's own DEFINITION,
  // which sits earlier in the file — so the bare name compared against the wrong position.
  const geo = src.indexOf("const geo = atsOrcGeoPlan(");
  assert.ok(pre > 0, "the country pre-pass must exist");
  assert.ok(pre < cap, "…and run before the option capture, which reads the block's lists");
  assert.ok(pre < geo, "…and before the geo plan, which picks the anchor from those fields");
});
