// THE RESTORE, EXERCISED — not just grepped.
//
// Operator, 2026-08-21: "there were 3 experience fields approved. the reherse run only saw 1 repeating
// section and did not add the other 2 that were approved. it must add them and get the page to match
// what is approved."
//
// The source-scanning tests next door pin the SHAPE (additive only, bundle-driven, never deletes).
// This one RUNS atsOrcAddApprovedEntry against a fake actuation, so the happy path is proven
// deterministically rather than only observed on a live form — a live ORC form cannot be put into the
// missing-entry state on demand.
const test = require("node:test");
const assert = require("node:assert");
const ats = require("../ats.js");

// The two field shapes an Experience entry has: plain text, and a month+year date PAIR whose halves
// share one `name` and are told apart only by the `month-`/`year-` id prefix.
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

// An approved bundle carrying a date as its two HALVES, which is what the fill now records.
const APPROVED = {
  "work_experience[1].employerName": "Carnegie Mellon Racing",
  "work_experience[1].jobTitle": "Firmware Team Member",
  "work_experience[1].startDate.month": "September",
  "work_experience[1].startDate.year": "2024",
  "work_experience[1].endDate.month": "May",
  "work_experience[1].endDate.year": "2026",
};

function makeAct(opts) {
  const o = opts || {};
  const calls = [];
  const written = {};
  return {
    calls,
    written,
    delayFull: async () => {},
    eval: async (fn, ...args) => {
      const name = fn && fn.name;
      calls.push({ name, args });
      if (name === "atsInjOrcOpenEntryAndWait") {
        if (o.openFails) return { ok: false, error: "no-add-button" };
        return { ok: true, pressed: "Add Experience", fields: experienceForm() };
      }
      if (name === "atsInjOrcPickFromOwnList") {
        const [sel, monthCands, yearCands] = args;
        const cand = (monthCands && monthCands[0]) || (yearCands && yearCands[0]) || null;
        const kind = /month-/.test(sel) ? "month" : "year";
        written[sel] = cand;
        return { ok: true, kind, committed: cand, value: cand, invalid: false,
                 options: kind === "month" ? ["January", "September", "May"] : ["2024", "2025", "2026"] };
      }
      if (name === "atsInjSetText") { written[args[0]] = args[1]; return { ok: true }; }
      // atsInjReadValue is called as (ats, sel, kind) — the SELECTOR is args[1]. Reading args[2]
      // ("text") made every text field read back empty, which is a fake-fixture bug that looked
      // exactly like a real read-back failure.
      if (name === "atsInjReadValue") return { ok: true, value: written[args[1]] || null };
      if (name === "atsInjOrcPick") return { ok: true };
      if (name === "atsInjOrcReadPicker") return { ok: true, value: written[args[0]] || null, invalid: false };
      if (name === "atsInjOrcCommitEntryAndWait") {
        if (o.commitRefuses) return { ok: true, closed: false, pressed: "Add Experience" };
        return { ok: true, closed: true, pressed: "Add Experience" };
      }
      if (name === "atsInjOrcEntryAction") return { ok: true };
      return { ok: true };
    },
  };
}

const SPEC = { label: "Experience", pattern: "experience", source: "work_experience" };
const EMAP = ats.ATS_ORC_ENTRY_MAPS.work_experience;
const valueFor = (q) => APPROVED[q.fieldName];

test("it restores every approved field of a missing entry, dates included, and commits", async () => {
  const act = makeAct();
  const logs = [];
  const res = await ats.atsOrcAddApprovedEntry(act, SPEC, 1, EMAP, valueFor, (m) => logs.push(m));

  assert.equal(res.ok, true, "the entry must commit");
  // Text fields written from the bundle.
  assert.equal(act.written["#employerName-1"], "Carnegie Mellon Racing");
  assert.equal(act.written["#jobTitle-2"], "Firmware Team Member");
  // ⚠ EACH DATE HALF GOES TO ITS OWN CONTROL. The two halves share `name`, so a bug here writes both
  // into whichever id came first — the failure that put the whole "2025-05" in one box.
  assert.equal(act.written["#month-startDate-3"], "September");
  assert.equal(act.written["#year-startDate-4"], "2024");
  assert.equal(act.written["#month-endDate-5"], "May");
  assert.equal(act.written["#year-endDate-6"], "2026");

  // Six records, keyed exactly as the bundle keys them, or the strict verify cannot line them up.
  const names = res.records.map((r) => r.fieldName).sort();
  assert.deepEqual(names, Object.keys(APPROVED).sort());
  assert.ok(res.records.every((r) => r.status === "filled" && r.verified === true),
    "every restored field is read-back verified");
  assert.ok(res.records.every((r) => r.entrySection === "work_experience" && r.entryIndex === 1),
    "records must carry section+index so atsSubmitKey lines them up with the bundle");
  // The halves keep their scanned vocabulary, so review still renders them as pickers.
  const half = res.records.find((r) => r.fieldName.endsWith(".startDate.month"));
  assert.deepEqual(half.options, ["January", "September", "May"]);
  assert.equal(half.part_label, "Month");
  assert.equal(half.question_key, "work_experience[1].startDate");
});

test("it never opens or deletes an EXISTING tile — only Add and Commit", async () => {
  const act = makeAct();
  await ats.atsOrcAddApprovedEntry(act, SPEC, 1, EMAP, valueFor, () => {});
  const used = act.calls.map((c) => c.name);
  assert.ok(used.includes("atsInjOrcOpenEntryAndWait"), "it presses Add");
  assert.ok(used.includes("atsInjOrcCommitEntryAndWait"), "…and commits");
  assert.ok(!used.includes("atsInjOrcDeleteTile"), "it must NEVER delete");
  assert.ok(!used.includes("atsInjOrcOpenTileAndWait"), "…and never open an entry that is present");
});

test("a refused entry is CANCELLED and reported, never left open to block the step", async () => {
  const act = makeAct({ commitRefuses: true });
  const logs = [];
  const res = await ats.atsOrcAddApprovedEntry(act, SPEC, 1, EMAP, valueFor, (m) => logs.push(m));
  assert.equal(res.ok, false, "a form that stays open is NOT a restored entry");
  const cancel = act.calls.find((c) => c.name === "atsInjOrcEntryAction" && c.args[1] === "cancel");
  assert.ok(cancel, "it must cancel — an open entry form blocks Next for everything after it");
  assert.ok(logs.some((m) => /would NOT commit/.test(m)), "and say so");
});

test("a field the bundle does not carry is skipped, not invented", async () => {
  const act = makeAct();
  // Only the employer is approved — no title, no dates.
  const thin = (q) => (q.fieldName === "work_experience[1].employerName" ? "Carnegie Mellon Racing" : undefined);
  const res = await ats.atsOrcAddApprovedEntry(act, SPEC, 1, EMAP, thin, () => {});
  assert.deepEqual(res.records.map((r) => r.fieldName), ["work_experience[1].employerName"]);
  assert.equal(act.written["#jobTitle-2"], undefined, "nothing may be written for an unapproved field");
  assert.equal(act.written["#month-startDate-3"], undefined, "…including a date half");
});

test("it reports rather than throws when no entry form can be opened", async () => {
  const act = makeAct({ openFails: true });
  const logs = [];
  const res = await ats.atsOrcAddApprovedEntry(act, SPEC, 1, EMAP, valueFor, (m) => logs.push(m));
  assert.equal(res.ok, false);
  assert.match(String(res.error), /no-add-button/);
  assert.deepEqual(res.records, [], "nothing is claimed when nothing was opened");
});
