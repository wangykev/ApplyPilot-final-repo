"use strict";
// SKILLS — the "Type to Add Skills" multi-value typeahead.
//
// Every fixture here encodes something OBSERVED on the live widget (cat.wd5, 2026-08-07 — see
// docs/dom-patterns.md), not something assumed:
//   • the taxonomy RENAMES ("Python" is only offered as "Python (Programming Language)")
//   • the search is server-side FUZZY and answers almost anything ("Yosys" → "Yodiz")
//   • ENTER is the only filter trigger; the list STAYS OPEN after a commit
//   • a ZERO-result query + Enter makes Workday add the typed text as a NEW skill
//   • an already-selected skill DISAPPEARS from its own future results
const { test } = require("node:test");
const assert = require("node:assert");
const lib = require("../lib.js");
const fd = require("../fill-driver.js");

// ── the fake widget ─────────────────────────────────────────────────────────
// Models the traced behaviour exactly: Enter filters, a click ADDS a chip and leaves the list open,
// a zero-result query free-text-adds, and a committed skill is dropped from later results.
function makeSkillsAct(opts = {}) {
  const catalog = opts.catalog || [];            // Workday's taxonomy
  const fuzz = opts.fuzz || {};                  // query → rows the server invents when nothing matches
  const st = {
    chips: (opts.chips || []).slice(),
    value: "", open: false, texts: [], resultsBanner: false, banner: false,
    clearBroken: !!opts.clearBroken             // the box refuses to empty (the dirty-box trap)
  };
  const log = [];
  const norm = (s) => String(s).toLowerCase().trim();
  const search = (q) => {
    const taken = new Set(st.chips.map(norm));
    // Workday drops an already-selected skill from its own results — the observed behaviour that
    // makes a non-deduping re-fill commit a near-duplicate.
    const hits = catalog.filter((c) => !taken.has(norm(c)) && norm(c).includes(norm(q)));
    if (hits.length) return hits;
    return (fuzz[q] || []).filter((c) => !taken.has(norm(c)));
  };
  const act = {
    delay: async () => {}, delayRender: async () => {}, delayFull: async () => {},
    readHier: async () => ({
      searchBox: { present: st.open, visible: st.open, focused: st.open, value: st.value },
      chips: st.chips.slice(),
      banner: st.open && st.banner ? { text: "No matches found" } : null,
      resultsBanner: !!(st.open && st.resultsBanner),
      pageWide: { count: st.texts.length, sig: st.texts.join("~"), sample: st.texts, texts: st.texts.slice() },
      leaves: st.texts.slice(), leafCount: st.texts.length, msId: "ms1", activeText: null
    }),
    openHier: async () => { log.push(["open"]); st.open = true; return true; },
    focusHierSearch: async () => { st.open = true; return true; },
    clearHierSearch: async () => {
      log.push(["clear"]);
      if (!st.clearBroken) { st.value = ""; st.texts = []; st.resultsBanner = false; st.banner = false; }
    },
    typeInHier: async (t) => { log.push(["type", t]); st.value += t; },
    pressEnter: async () => {
      log.push(["enter", st.value]);
      const rows = search(st.value);
      if (!rows.length) {              // ZERO results → Workday adds the typed text verbatim
        st.chips.push(st.value); st.texts = []; st.resultsBanner = false; st.banner = false;
      } else { st.texts = rows.slice(); st.resultsBanner = true; st.banner = false; }
    },
    clickHierLeaf: async (loc, label) => {
      log.push(["click", label]);
      if (!st.texts.includes(label)) return false;
      st.chips.push(label);            // ADDS — the list stays open and the query stays put
      return true;
    },
    pressTab: async () => { log.push(["tab"]); st.value = ""; st.open = false; st.texts = []; },
    probeHierLeaf: async () => ({ found: false, commitWrapper: { isSelectedValue: "false" } })
  };
  return { act, st, log };
}

const LOC = { wrapperSel: '[data-automation-id="formField-skills"]' };
const B = Object.assign({}, fd.DEFAULT_BUDGETS, { stableReads: 2 });
// The real taxonomy rows observed for these queries.
const CATALOG = ["Python (Programming Language)", "Python IDLE", "Docker", "Docker (Software)",
  "Dockerfile", "Linux", "Git", "C++ (Programming Language)"];
const FUZZ = { "Yosys": ["Yodiz", "GoSystem Tax RS"], "ODrive": ["Top Drive", "Optical Disk Drives"] };

// ── pure matchers ───────────────────────────────────────────────────────────

test("skillBaseName strips Workday's trailing qualifier, and only that", () => {
  assert.equal(lib.skillBaseName("Python (Programming Language)"), "python");
  assert.equal(lib.skillBaseName("Docker"), "docker");
  assert.equal(lib.skillBaseName("C++ (Programming Language)"), "c++");
  // a mid-string paren is part of the name, not a qualifier
  assert.equal(lib.skillBaseName("A (B) C"), "a (b) c");
  // stripping must never leave nothing to match on
  assert.equal(lib.skillBaseName("(Other)"), "(other)");
});

test("matchSkillOption: a bare exact WINS over the qualified row", () => {
  // Observed for Docker: both "Docker" and "Docker (Software)" are offered. Picking the qualified
  // one when the plain row exists would put a subtly different skill on the application.
  const m = lib.matchSkillOption("Docker", ["Docker (Software)", "Docker", "Dockerfile"]);
  assert.deepEqual([m.index, m.tier], [1, "exact"]);
});

test("matchSkillOption: the qualified tier is how most skills match at all", () => {
  const m = lib.matchSkillOption("Python", ["Python (Programming Language)", "Python IDLE"]);
  assert.deepEqual([m.index, m.tier], [0, "qualified"]);
});

test("matchSkillOption: Workday's FUZZY rows are never a match", () => {
  // The whole safety case for this field: the server answers "Yosys" with "Yodiz". Containment and
  // Levenshtein would both be tempted here; the ladder must refuse.
  assert.equal(lib.matchSkillOption("Yosys", ["Yodiz", "GoSystem Tax RS"]).index, -1);
  assert.equal(lib.matchSkillOption("ODrive", ["Top Drive", "Optical Disk Drives"]).index, -1);
  // and a containment-style near-row is still not a match
  assert.equal(lib.matchSkillOption("Java", ["JavaScript", "Java Persistence API"]).index, -1);
});

test("matchSkillOption: two rows sharing a base name are AMBIGUOUS, so nothing commits", () => {
  const m = lib.matchSkillOption("Python", ["Python (Programming Language)", "Python (Snake)"]);
  assert.equal(m.index, -1);
  assert.equal(m.ambiguous, "qualified");
});

test("missingSkills: a QUALIFIED chip already covers the bare profile name", () => {
  // Without this the second pass re-searches "Python", finds the qualified row gone (Workday hides
  // an already-selected skill), and commits "Python IDLE" as a near-duplicate.
  assert.deepEqual(lib.missingSkills(["Python", "Git"], ["Python (Programming Language)"]), ["Git"]);
});

test("missingSkills: dedupes the profile against itself, case-insensitively", () => {
  assert.deepEqual(lib.missingSkills(["Git", "git", " GIT "], []), ["Git"]);
});

test("isSkillsField: narrow — the multiselect only, never a prose box or a language field", () => {
  assert.ok(fd.isSkillsField({ fieldName: "skills", widgetType: "typeahead", label: "Type to Add Skills" }));
  assert.ok(fd.isSkillsField({ fieldName: "formFieldX", widgetType: "typeahead", label: "Skills*" }));
  assert.ok(!fd.isSkillsField({ fieldName: "skills", widgetType: "text", label: "Skills" }), "a TEXT box is a different question");
  assert.ok(!fd.isSkillsField({ fieldName: "languageSkillsProficiency", widgetType: "typeahead", label: "Reading Proficiency" }));
  assert.ok(!fd.isSkillsField({ fieldName: "jobTitle", widgetType: "typeahead", label: "Job Title" }));
});

// ── the filler ──────────────────────────────────────────────────────────────

test("fillSkillsCdp: adds every matchable skill on ONE open, mapping through the qualifier", async () => {
  const { act, st } = makeSkillsAct({ catalog: CATALOG, fuzz: FUZZ });
  const r = await fd.fillSkillsCdp(act, LOC, ["Python", "Docker", "Linux"], B);
  assert.equal(r.status, "filled");
  assert.deepEqual(st.chips, ["Python (Programming Language)", "Docker", "Linux"]);
  assert.match(r.detail, /Python → Python \(Programming Language\)/);
  assert.equal(r.after, "Python (Programming Language); Docker; Linux");
});

test("fillSkillsCdp: a skill Workday does not know is left OFF the form and named", async () => {
  const { act, st } = makeSkillsAct({ catalog: CATALOG, fuzz: FUZZ });
  const r = await fd.fillSkillsCdp(act, LOC, ["Git", "Yosys", "ODrive"], B);
  assert.deepEqual(st.chips, ["Git"], "no fuzzy row was ever committed");
  assert.deepEqual(r.skills_not_offered, ["Yosys", "ODrive"]);
  assert.match(r.detail, /NOT in Workday's skill list.*Yosys, ODrive/);
  assert.equal(r.status, "filled");
});

test("fillSkillsCdp: NEVER touches skills already on the form, and re-running adds nothing", async () => {
  // The résumé parse / a previous run owns those chips. Idempotency is what stops a second pass
  // from committing "Docker (Software)" next to an existing "Docker".
  const { act, st } = makeSkillsAct({ catalog: CATALOG, chips: ["Docker"], fuzz: FUZZ });
  const r1 = await fd.fillSkillsCdp(act, LOC, ["Docker", "Git"], B);
  assert.deepEqual(st.chips, ["Docker", "Git"]);
  assert.equal(r1.status, "filled");

  const { act: a2, st: s2, log } = makeSkillsAct({ catalog: CATALOG, chips: st.chips.slice(), fuzz: FUZZ });
  const r2 = await fd.fillSkillsCdp(a2, LOC, ["Docker", "Git"], B);
  assert.deepEqual(s2.chips, ["Docker", "Git"], "second pass is a no-op");
  assert.equal(r2.flag, "skills-already-present");
  assert.ok(!log.some((l) => l[0] === "enter"), "and it never even searched");
});

test("fillSkillsCdp: a qualified chip from a prior run counts as present", async () => {
  const { act, log } = makeSkillsAct({ catalog: CATALOG, chips: ["Python (Programming Language)"], fuzz: FUZZ });
  const r = await fd.fillSkillsCdp(act, LOC, ["Python"], B);
  assert.equal(r.flag, "skills-already-present");
  assert.ok(!log.some((l) => l[0] === "enter"));
});

test("fillSkillsCdp: a ZERO-result query free-text-adds, and that counts as filled", async () => {
  // The one path by which an off-taxonomy skill actually lands. Accepted only because the new chip
  // IS what we typed — Workday completed it, we did not guess it.
  const { act, st } = makeSkillsAct({ catalog: CATALOG }); // no fuzz → unknown queries return zero
  const r = await fd.fillSkillsCdp(act, LOC, ["CubeMars motor drivers"], B);
  assert.deepEqual(st.chips, ["CubeMars motor drivers"]);
  assert.equal(r.status, "filled");
});

test("fillSkillsCdp: an unverifiable CLEAR stops the field — a dirty box can fabricate a skill", async () => {
  // The trap seen live: with "Docker" still in the box, typing the next skill appended to it and
  // Enter created the chip "DockerCubeMars motor drivers" — a skill nobody claimed. The box starts
  // genuinely empty, so skill 1 proceeds normally; the broken clear only bites on skill 2, and the
  // field must STOP there rather than press Enter on a concatenated query.
  const fast = Object.assign({}, B, { taActionSettleCeilingMs: 200, taActionSettleIntervalMs: 20 });
  const { act, st, log } = makeSkillsAct({ catalog: CATALOG, clearBroken: true });
  const r = await fd.fillSkillsCdp(act, LOC, ["Python", "Git"], fast);
  assert.deepEqual(log.filter((l) => l[0] === "enter").map((l) => l[1]), ["Python"],
    "only the query whose box verified EMPTY reached Enter");
  assert.deepEqual(st.chips, ["Python (Programming Language)"], "no concatenated skill was fabricated");
  assert.match(r.detail, /stopped early \(dirty box\)/);
});

test("fillSkillsCdp: nothing matched and the field is BLANK → needs_review", async () => {
  const { act } = makeSkillsAct({ catalog: CATALOG, fuzz: FUZZ });
  const r = await fd.fillSkillsCdp(act, LOC, ["Yosys", "ODrive"], B);
  assert.equal(r.status, "needs_review");
  assert.equal(r.flag, "skills-none-matched");
});

test("fillSkillsCdp: an empty profile list is a skip, not an error", async () => {
  const { act, log } = makeSkillsAct({ catalog: CATALOG });
  const r = await fd.fillSkillsCdp(act, LOC, [], B);
  assert.equal(r.status, "skipped");
  assert.ok(!log.length, "the widget was never even opened");
});

test("fillSkillsCdp: the cap is reported, never silent", async () => {
  const { act, st } = makeSkillsAct({ catalog: CATALOG, fuzz: FUZZ });
  const r = await fd.fillSkillsCdp(act, LOC, ["Python", "Docker", "Linux"], B, { maxAdds: 2 });
  assert.equal(st.chips.length, 2);
  assert.match(r.detail, /1 skill\(s\) not attempted — the 2-skill cap/);
});

test("fillSkillsCdp: an unexpected chip is surfaced, never accepted quietly", async () => {
  const { act, st } = makeSkillsAct({ catalog: CATALOG });
  const orig = act.clickHierLeaf;
  act.clickHierLeaf = async (loc, label) => { const ok = await orig(loc, label); st.chips.push("Something Else"); return ok; };
  const r = await fd.fillSkillsCdp(act, LOC, ["Linux"], B);
  assert.equal(r.status, "needs_review");
  assert.equal(r.flag, "skills-stray");
  assert.match(r.detail, /UNEXPECTED chip\(s\): Something Else/);
});

// ── the review → replay round trip ──────────────────────────────────────────

test("replayField: an approved skills SET is split back apart, not replayed as one string", async () => {
  const { act, st } = makeSkillsAct({ catalog: CATALOG, fuzz: FUZZ });
  const entry = { field_id: "p1::formField-skills", widget_type: "typeahead",
    question_label: "Type to Add Skills", current_value: "Docker; Linux" };
  const r = await fd.replayField(act, entry, B);
  assert.equal(r.replay, "skills-multi");
  assert.deepEqual(st.chips, ["Docker", "Linux"]);
  assert.equal(r.status, "filled");
});

test("replayField: replaying onto a form that already holds the skills actuates nothing", async () => {
  const { act, log } = makeSkillsAct({ catalog: CATALOG, chips: ["Docker", "Linux"] });
  const entry = { field_id: "p1::formField-skills", widget_type: "typeahead",
    question_label: "Type to Add Skills", current_value: "Docker; Linux" };
  const r = await fd.replayField(act, entry, B);
  assert.equal(r.status, "filled");
  assert.ok(!log.some((l) => l[0] === "enter" || l[0] === "click"));
});
