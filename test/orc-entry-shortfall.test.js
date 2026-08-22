// A REPLAY MUST NAME AN ENTRY SHORTFALL rather than leave it as per-field "no matching field".
//
// Live 2026-08-21: a 3-entry Experience bundle met a 1-tile form, because Oracle REFUSED the other
// entries at fill time (an incomplete required date is enough — see the date-picker note in
// CLAUDE.md), and an entry it refused never persisted. The strict verify then reported each absent
// field as "approved value has NO matching field on the live form", which does not say WHICH entry is
// missing or WHY — the cause was three steps upstream — and the operator read it as "the rehearsal
// did not add experience".
//
// This pins the DIAGNOSIS half only. Re-ADDING the missing entries so the page matches what was
// approved is the operator's actual requirement and is NOT implemented yet; `entryCounts` is threaded
// into the pass for exactly that work. See docs/fill-speed-log.md round 18.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

function stripJsComments(s) {
  return String(s).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const SRC = fs.readFileSync(path.join(__dirname, "..", "ats.js"), "utf8");

test("the bundle's entry counts reach the ORC entry pass", () => {
  // The count is derived from the APPROVED BUNDLE in background.js and was previously used only by
  // iCIMS — the ORC submit run logged "the form will be grown to fit" and then never passed the
  // numbers to the pass that could act on them.
  assert.ok(
    /async function atsFinishFill\(act, ats, scan, results, credentials, profile, jobContext, replay, valueFor, entryCounts\)/.test(SRC),
    "atsFinishFill must take the bundle's entryCounts"
  );
  assert.ok(
    /atsFinishFill\(act, ats, scan, results, o\.credentials, profile, jobContext, !!o\.valueFor, o\.valueFor, o\.entryCounts\)/.test(SRC),
    "…and the caller must pass o.entryCounts"
  );
  assert.ok(
    /reportOnly: !!replay, valueFor, entryCounts/.test(SRC),
    "…and it must reach atsOrcFillEntries, which is the only place that can see both numbers"
  );
});

test("SAFETY: the report-only pass compares the form's tiles against the APPROVED count", () => {
  const i = SRC.indexOf("if (o.reportOnly) {");
  assert.ok(i > 0, "the report-only branch must exist");
  const branch = stripJsComments(SRC.slice(i, SRC.indexOf("\n  if (!plan.length) {", i)));

  // The profile is {} on a replay, so a profile-derived count would read as "wants 0" — which is
  // exactly the reading that would DELETE a work history.
  assert.ok(/o\.entryCounts/.test(branch), "it must read the BUNDLE's entry count, not the profile's");
  assert.ok(/approvedCount > tiles\.length/.test(branch),
    "…and act on a SHORTFALL only: more approved than present. The other direction must never delete.");
  assert.ok(/notes\.push\(/.test(branch), "the shortfall must reach the run's notes, not only the log ring");
  assert.ok(!/atsInjOrcDeleteTile/.test(branch), "a report-only pass must never delete an entry");
});
