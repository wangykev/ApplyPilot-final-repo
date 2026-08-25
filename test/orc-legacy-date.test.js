// ── A PRE-SPLIT APPROVAL MUST STILL REPLAY (live regression, 2026-08-21) ──────────────────
//
// Splitting an ORC date into two review rows (so each half is separately editable) silently
// invalidated every bundle ALREADY approved: the replay looked for `.month`/`.year`, found nothing,
// wrote an entry with no dates at all, and Oracle refused it. Measured live as four verify failures —
// "approved value has NO matching field on the live form" — on an application that had passed its
// rehearsal the day before.
//
// The fix is the same discipline atsSubmitKey already applies to entry keys: accept BOTH shapes,
// because the two sides keying differently IS the bug.
const test = require("node:test");
const assert = require("node:assert");
const ats = require("../ats.js");

function experienceForm() {
  return [
    { name: "employerName", id: "employerName-1", label: "Employer Name", type: "text" },
    { name: "jobTitle", id: "jobTitle-2", label: "Job Title", type: "text" },
    { name: "startDate", id: "month-startDate-3", role: "combobox" },
    { name: "startDate", id: "year-startDate-4", role: "combobox" },
    { name: "endDate", id: "month-endDate-5", role: "combobox" },
    { name: "endDate", id: "year-endDate-6", role: "combobox" },
  ];
}

function makeAct() {
  const written = {};
  return {
    written,
    delayFull: async () => {},
    eval: async (fn, ...args) => {
      const name = fn && fn.name;
      if (name === "atsInjOrcOpenEntryAndWait") return { ok: true, fields: experienceForm() };
      if (name === "atsInjOrcPickFromOwnList") {
        const cand = (args[1] && args[1][0]) || (args[2] && args[2][0]) || null;
        written[args[0]] = cand;
        return { ok: true, kind: /month-/.test(args[0]) ? "month" : "year", value: cand, invalid: false, options: [] };
      }
      if (name === "atsInjSetText") { written[args[0]] = args[1]; return { ok: true }; }
      if (name === "atsInjReadValue") return { ok: true, value: written[args[1]] || null };
      if (name === "atsInjOrcCommitEntryAndWait") return { ok: true, closed: true };
      return { ok: true };
    },
  };
}

const SPEC = { label: "Experience", pattern: "experience", source: "work_experience" };
const EMAP = ats.ATS_ORC_ENTRY_MAPS.work_experience;

test("atsOrcLegacyDateHalf takes a half out of a merged date, in every shape the fill produced", () => {
  const H = ats.atsOrcLegacyDateHalf;
  assert.equal(H("May 2026", "month"), "May");
  assert.equal(H("May 2026", "year"), "2026");
  assert.equal(H("05/2026", "month"), "May");
  assert.equal(H("05/2026", "year"), "2026");
  assert.equal(H("2026-05", "month"), "May");
  assert.equal(H("2026-05", "year"), "2026");
  // A bare year is a real shape — it is exactly what a half-committed date recorded live ("2026").
  assert.equal(H("2026", "year"), "2026");
  assert.equal(H("2026", "month"), null, "a bare year says nothing about the month");
  // ⚠ REFUSE WHAT IT CANNOT PARSE rather than guessing at half of a string it does not understand.
  assert.equal(H("sometime in 2026", "month"), null);
  assert.equal(H("", "year"), null);
  assert.equal(H(null, "month"), null);
  assert.equal(H("13/2026", "month"), null, "there is no 13th month");
});

test("the restore fills a date from a LEGACY merged approval when the halves are absent", async () => {
  const act = makeAct();
  const legacy = {
    "work_experience[1].employerName": "Carnegie Mellon Racing",
    "work_experience[1].jobTitle": "Firmware Team Member",
    "work_experience[1].startDate": "September 2024",
    "work_experience[1].endDate": "May 2026",
  };
  const res = await ats.atsOrcAddApprovedEntry(act, SPEC, 1, EMAP, (q) => legacy[q.fieldName], () => {});
  assert.equal(res.ok, true, "a legacy approval must still commit — this is precisely what broke live");
  assert.equal(act.written["#month-startDate-3"], "September");
  assert.equal(act.written["#year-startDate-4"], "2024");
  assert.equal(act.written["#month-endDate-5"], "May");
  assert.equal(act.written["#year-endDate-6"], "2026");
});

test("a NEW-shape approval still wins over the legacy row when both are present", async () => {
  const act = makeAct();
  const both = {
    "work_experience[1].employerName": "Carnegie Mellon Racing",
    "work_experience[1].startDate.month": "September",
    "work_experience[1].startDate.year": "2024",
    // A stale merged row that disagrees — the halves are the current truth and must be preferred.
    "work_experience[1].startDate": "January 1999",
  };
  await ats.atsOrcAddApprovedEntry(act, SPEC, 1, EMAP, (q) => both[q.fieldName], () => {});
  assert.equal(act.written["#month-startDate-3"], "September", "the per-half approval is authoritative");
  assert.equal(act.written["#year-startDate-4"], "2024");
});

test("the report-only path verifies a legacy date under ITS OWN key", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.join(__dirname, "..", "ats.js"), "utf8");
  const i = src.indexOf("if (o.reportOnly) {");
  const branch = src.slice(i, src.indexOf("\n  if (!plan.length) {", i));
  // Emitting the HALVES for a legacy bundle would leave its merged row unmatched, and the strict
  // verify reports an unmatched approved row as "no matching field" — refusing a good submit.
  assert.ok(/expected\.push\(\{ key, fieldName: `\$\{spec\.source\}\[\$\{k\}\]\.\$\{key\}`, want: String\(legacy\) \}\)/.test(branch),
    "a legacy merged approval must be reported under the merged key it was approved as");
});
