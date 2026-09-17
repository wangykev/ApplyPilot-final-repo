// test/ats-orc-entry-settle.test.js — an ORC entry form is scanned once its field set SETTLES,
// not on the first input that appears.
//
// LIVE 2026-09-17, Emerson education entry on an armed submit. The entry filled three fields and
// then refused to commit:
//
//   education[0].educationalEstablishment (dropdown) → filled · "Carnegie Mellon University"
//   education[0].major (text)                        → filled · "Electrical and Computer Engineering"
//   education[0].gpa (text)                          → filled · "3.95"
//   ⛔ Education entry 1: … the entry would NOT commit — Oracle refused the entry
//   (every field the entry form offered had an approved value …)
//
// Three fields, all filled, nothing skipped — yet the FILL run on the same entry had listed
// startDate, endDate, educationLevel, yearAcquired, dateAcquired and minor. So the required field
// (Education Level) was never SCANNED. It was not blank-and-skipped; it was invisible, which is why
// the refusal could not name it even after the skipped-field diagnostic was added.
//
// THE CAUSE: the open-and-wait loop broke out the instant `live.length > before`, i.e. on the first
// render tick. ORC mounts an entry form progressively, so first-change is the one predicate
// guaranteed to fire mid-render. The repo's own standing rule says a stability predicate must be
// TIMED ("unchanged for N ms") — it had simply never been applied here.
//
// Run: node --test test/ats-orc-entry-settle.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const ats = require("../ats.js");

// A block whose entry form mounts PROGRESSIVELY: 3 inputs on the first tick, 7 a little later.
function progressiveBlock(schedule) {
  const t0 = Date.now();
  const mk = (id, label, role) => ({
    id, name: id, type: "text", value: "",
    getAttribute: (k) => (k === "role" ? (role || null) : k === "aria-label" ? label : null),
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 200, height: 24 }),
  });
  const ALL = [
    mk("educationalEstablishment-1", "School", "combobox"),
    mk("major-1", "Major"),
    mk("gpa-1", "GPA"),
    mk("educationLevel-1", "Education Level", "combobox"),
    mk("yearAcquired-1", "Year Acquired", "combobox"),
    mk("month-startDate-1", "Start Date"),
    mk("year-startDate-1", "Start Date"),
  ];
  const addBtn = {
    tagName: "BUTTON", textContent: "Add Education",
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 120, height: 32 }),
    click: () => {},
  };
  const visibleCount = () => {
    const ms = Date.now() - t0;
    let n = 0;
    for (const s of schedule) if (ms >= s.at) n = s.count;
    return n;
  };
  const block = {
    querySelector: (sel) => (sel === "apply-flow-block-title" ? { textContent: "Education" } : null),
    querySelectorAll: (sel) => {
      if (sel === "button") return [addBtn];
      return ALL.slice(0, visibleCount());
    },
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 600, height: 400 }),
  };
  return { block, ALL };
}

function runOpen(schedule, budgetMs) {
  const { block } = progressiveBlock(schedule);
  const g = {
    document: {
      querySelectorAll: (sel) => (sel === "apply-flow-block" ? [block] : []),
      querySelector: () => null,
    },
    window: { CSS: { escape: (s) => s } },
    CSS: { escape: (s) => s },
  };
  const f = new Function("g", "pat", "budget",
    `with (g) { return (${ats.atsInjOrcOpenEntryAndWait.toString()})(pat, budget); }`);
  return f(g, "Education", budgetMs);
}

test("⚠⚠ a progressively-mounted entry form is scanned in FULL, not at first change", async () => {
  // Closed (0 inputs), then 3 on the first render tick, then the remaining 4 — the Emerson shape.
  const r = await runOpen([{ at: 0, count: 0 }, { at: 30, count: 3 }, { at: 150, count: 7 }], 4000);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.count, 7, "first-change captured only the first 3 and lost Education Level");
  assert.ok(r.fields.some((f) => f.id === "educationLevel-1"),
    "the field Oracle actually requires must be in the scan");
  assert.strictEqual(r.settled, true);
});

test("a form that mounts all at once is unchanged (no added latency beyond one quiet period)", async () => {
  const t0 = Date.now();
  const r = await runOpen([{ at: 0, count: 0 }, { at: 20, count: 7 }], 4000);
  assert.strictEqual(r.count, 7);
  assert.ok(Date.now() - t0 < 1500, "settling costs one quiet period, not a fixed sleep");
});

test("⚠ a form still growing when the budget expires returns the FULLEST set seen, not nothing", async () => {
  // Grows past the budget; the old code would have returned its first snapshot, and returning
  // nothing would be worse still — the caller cannot fill what it cannot see.
  const r = await runOpen([{ at: 0, count: 0 }, { at: 20, count: 3 }, { at: 200, count: 5 }, { at: 5000, count: 7 }], 600);
  assert.strictEqual(r.ok, true);
  assert.ok(r.count >= 5, `expected the fullest set seen, got ${r.count}`);
});

test("⚠ the first-change break must not come back", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "ats.js"), "utf8");
  const i = src.indexOf("async function atsInjOrcOpenEntryAndWait");
  const body = src.slice(i, i + 7000);
  assert.match(body, /const QUIET_MS = 250;/);
  assert.match(body, /if \(Date\.now\(\) - stableSince >= QUIET_MS\) break;/,
    "the break must be gated on the count holding still");
});
