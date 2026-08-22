// ── THE REPLAY SUBTRACTS: a wrong entry is replaced, a stray one removed ──────────────────
//
// Operator, 2026-08-21: "for 4 you say purely additive however I need it to subtract if in any case
// the current experience block is wrong."
//
// ⚠⚠ THIS IS THE MOST DESTRUCTIVE PATH IN THE PIPELINE, so it is driven end to end here against a
// fake actuation rather than only grepped. The rule it replaces ("a replay never deletes") existed
// because the reconcile was PROFILE-driven and a replay passes profile:{} — it read "wants 0, the form
// has 3" and would have deleted a whole work history. Every test below exists to prove that the
// decision now comes from the APPROVED BUNDLE, and that it refuses when the bundle cannot justify it.
const test = require("node:test");
const assert = require("node:assert");
const ats = require("../ats.js");

const ENTRY_FIELDS = () => [
  { name: "employerName", id: "employerName-1", label: "Employer Name", type: "text" },
  { name: "jobTitle", id: "jobTitle-2", label: "Job Title", type: "text" },
  { name: "startDate", id: "month-startDate-3", role: "combobox" },
  { name: "startDate", id: "year-startDate-4", role: "combobox" },
];

// A fake ORC step-2 form: one Experience block plus whatever tiles the test puts on it.
function makeWorld(tiles, openedValues) {
  const w = {
    tiles: tiles.map((t) => ({ text: t })),
    deleted: [],
    added: [],
    written: {},
    log: [],
  };
  w.act = {
    delayFull: async () => {},
    eval: async (fn, ...args) => {
      const n = fn && fn.name;
      if (n === "atsInjOrcBlocks") {
        return { ok: true, blocks: [{ title: "Experience", inputs: 0, addCaption: "Add Experience" }] };
      }
      if (n === "atsInjOrcTiles") return { ok: true, count: w.tiles.length, tiles: w.tiles };
      if (n === "atsInjOrcDeleteTile") {
        const i = args[1] == null ? w.tiles.length - 1 : args[1];
        w.deleted.push(w.tiles[i] ? w.tiles[i].text : null);
        w.tiles.splice(i, 1);
        return { ok: true, remaining: w.tiles.length, dialog: { present: false } };
      }
      if (n === "atsInjOrcOpenTileAndWait") {
        return { ok: true, fields: ENTRY_FIELDS().map((f) => ({ ...f, value: (openedValues || {})[f.id] || "" })) };
      }
      if (n === "atsInjOrcCloseEntry") return { ok: true, via: "Cancel" };
      if (n === "atsInjOrcOpenEntryAndWait") return { ok: true, fields: ENTRY_FIELDS() };
      if (n === "atsInjOrcCommitEntryAndWait") {
        w.added.push({ ...w.written });
        w.tiles.push({ text: [w.written["#employerName-1"], w.written["#jobTitle-2"]].filter(Boolean).join(" ") });
        return { ok: true, closed: true };
      }
      if (n === "atsInjOrcPickFromOwnList") {
        const cand = (args[1] && args[1][0]) || (args[2] && args[2][0]) || null;
        w.written[args[0]] = cand;
        return { ok: true, kind: /month-/.test(args[0]) ? "month" : "year", value: cand, invalid: false, options: [] };
      }
      if (n === "atsInjSetText") { w.written[args[0]] = args[1]; return { ok: true }; }
      if (n === "atsInjReadValue") return { ok: true, value: w.written[args[1]] || null };
      if (n === "atsInjOrcUnclaimed") return { ok: true, unclaimed: [] };
      return { ok: true };
    },
  };
  return w;
}

const APPROVED_2 = {
  "work_experience[0].employerName": "Rivian and Volkswagen Technologies",
  "work_experience[0].jobTitle": "Characterization Intern",
  "work_experience[1].employerName": "Carnegie Mellon Racing",
  "work_experience[1].jobTitle": "Firmware Team Member",
};

function run(world, approved, counts) {
  return ats.atsOrcFillEntries(world.act, {}, {}, {
    reportOnly: true,
    valueFor: (q) => approved[q.fieldName],
    entryCounts: counts,
    log: (m) => world.log.push(m),
  });
}

test("a tile the approved review does not want is REMOVED", async () => {
  const w = makeWorld([
    "Rivian and Volkswagen Technologies Characterization Intern",
    "Carnegie Mellon Racing Firmware Team Member",
    "Some Stale Employer Some Old Title",     // approved by nobody
  ]);
  await run(w, APPROVED_2, { work_experience: 2 });
  assert.deepEqual(w.deleted, ["Some Stale Employer Some Old Title"],
    "only the unapproved tile may be removed");
  assert.equal(w.tiles.length, 2, "the two approved entries must survive");
});

test("⚠ NOTHING is removed when the bundle approves no entries for the section", async () => {
  // This is the original hazard, restated: a profile-derived count would read "wants 0" here.
  const w = makeWorld([
    "Rivian and Volkswagen Technologies Characterization Intern",
    "Carnegie Mellon Racing Firmware Team Member",
  ]);
  await run(w, {}, {});                        // nothing approved at all
  assert.deepEqual(w.deleted, [], "an empty approval must never delete a work history");
  assert.equal(w.tiles.length, 2);
});

test("⚠ NOTHING is removed when every tile matches an approved entry", async () => {
  const w = makeWorld([
    "Rivian and Volkswagen Technologies Characterization Intern",
    "Carnegie Mellon Racing Firmware Team Member",
  ]);
  await run(w, APPROVED_2, { work_experience: 2 });
  assert.deepEqual(w.deleted, [], "a form that already matches must not be touched");
  assert.deepEqual(w.added, [], "…and nothing re-added");
});

test("a tile whose FIELDS disagree is deleted and re-added from the approved values", async () => {
  // The tile's summary hides the job title, so the entry is opened — and the open shows a WRONG
  // employer, which is a real disagreement rather than a tile that simply does not display it.
  const w = makeWorld(
    ["Carnegie Mellon Racing"],
    { "employerName-1": "Carnegie Mellon Racing", "jobTitle-2": "WRONG TITLE" }
  );
  await run(w, {
    "work_experience[0].employerName": "Carnegie Mellon Racing",
    "work_experience[0].jobTitle": "Firmware Team Member",
  }, { work_experience: 1 });
  assert.equal(w.deleted.length, 1, "the disagreeing entry must be removed");
  assert.equal(w.added.length, 1, "…and rebuilt from the approved values");
  assert.equal(w.added[0]["#jobTitle-2"], "Firmware Team Member", "with the APPROVED title, not the form's");
});

test("⚠ a disagreeing tile is LEFT ALONE when the bundle cannot rebuild it", async () => {
  // Only the title is approved — no employer, so the identity needed to rebuild is missing. Deleting
  // something we cannot put back is worse than leaving it wrong.
  const w = makeWorld(
    ["Carnegie Mellon Racing"],
    { "employerName-1": "Carnegie Mellon Racing", "jobTitle-2": "WRONG TITLE" }
  );
  const res = await run(w, { "work_experience[0].jobTitle": "Firmware Team Member" }, { work_experience: 1 });
  assert.deepEqual(w.deleted, [], "it must not delete what it cannot rebuild");
  assert.ok((res.notes || []).some((x) => /LEFT ALONE/.test(x)), "and must say why, so the gate refusal is actionable");
});

test("the replacement's records supersede the mismatch rows for that entry", async () => {
  // Otherwise the bundle carries both the DIFFER verdict and the corrected value for one field, and
  // the gate refuses an entry it just fixed.
  const w = makeWorld(
    ["Carnegie Mellon Racing"],
    { "employerName-1": "Carnegie Mellon Racing", "jobTitle-2": "WRONG TITLE" }
  );
  const res = await run(w, {
    "work_experience[0].employerName": "Carnegie Mellon Racing",
    "work_experience[0].jobTitle": "Firmware Team Member",
  }, { work_experience: 1 });
  const mism = (res.records || []).filter((r) => r.flag === "entry-mismatch");
  assert.deepEqual(mism, [], "no entry-mismatch row may survive a successful replacement");
  const title = (res.records || []).find((r) => r.fieldName === "work_experience[0].jobTitle");
  assert.equal(title.after, "Firmware Team Member");
  assert.equal(title.status, "filled");
});
