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
    clearBroken: !!opts.clearBroken,            // the box refuses to empty (the dirty-box trap)
    clearFailsFor: opts.clearFailsFor || 0      // the clear no-ops for the first N calls, then recovers
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
      if (st.clearFailsFor > 0) { st.clearFailsFor--; return; } // transient: focus was elsewhere
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

test("matchSkillOption: CONTAINMENT lands a skill Workday only lists under a broader name", () => {
  // Operator-authorized 2026-08-07, so "Vivado" lands against Workday's "Xilinx Vivado".
  const m = lib.matchSkillOption("Vivado", ["Xilinx Vivado", "Cadence Virtuoso"]);
  assert.deepEqual([m.index, m.tier], [0, "containment"]);
  const p = lib.matchSkillOption("PCB design", ["PCB Design and Layout", "Mechanical Design"]);
  assert.deepEqual([p.index, p.tier], [0, "containment"]);
});

test("matchSkillOption: containment is WHOLE-WORD — the two cases that make raw substring wrong", () => {
  // "git" is inside "Digital" and "can" is inside "Canadian". A plain `includes` tier would put a
  // marketing skill on an embedded engineer's application; these must not match.
  assert.equal(lib.matchSkillOption("Git", ["Digital Marketing"]).index, -1);
  assert.equal(lib.matchSkillOption("CAN", ["Canadian Payroll"]).index, -1);
  // and a lone SHORT token is refused outright, even where it would be a whole word
  assert.equal(lib.matchSkillOption("CAN", ["CAN Bus Diagnostics"]).index, -1,
    "a 3-char lone token is not distinctive enough to widen on");
  assert.ok(!lib.skillContainmentEligible("Git"));
  assert.ok(lib.skillContainmentEligible("Vivado"));
  assert.ok(lib.skillContainmentEligible("VS Code"), "multi-word is distinctive even when short");
});

test("matchSkillOption: an EXACT or QUALIFIED row still beats containment", () => {
  // Widening is the last resort, so an offered exact row wins and the commit stays silent/high.
  const m = lib.matchSkillOption("Vivado", ["Xilinx Vivado", "Vivado"]);
  assert.deepEqual([m.index, m.tier], [1, "exact"]);
  const q = lib.matchSkillOption("Vivado", ["Xilinx Vivado", "Vivado (Software)"]);
  assert.deepEqual([q.index, q.tier], [1, "qualified"]);
});

test("matchSkillOption: several containing rows resolve on WORKDAY'S ranking, alternatives carried", () => {
  // Refusing here is what kept "Vivado" off the form live — Workday offered more than one row
  // containing it. The tie breaks on its own first result, and the rest ride along for the review.
  const m = lib.matchSkillOption("Vivado", ["Xilinx Vivado", "Vivado HLS"]);
  assert.deepEqual([m.index, m.tier], [0, "containment"]);
  assert.deepEqual(m.alternatives, ["Vivado HLS"]);
});

test("missingSkills: a BROADER chip covers the skill, so a re-run can't add a second variant", () => {
  // Containment opens an idempotency hole: base names differ, so without this the next pass searches
  // "Vivado" again, finds the selected row gone, and widens onto "Vivado HLS" alongside it.
  assert.deepEqual(lib.missingSkills(["Vivado", "Git"], ["Xilinx Vivado"]), ["Git"]);
  // ...but the same guard must not let an unrelated chip swallow a short skill
  assert.deepEqual(lib.missingSkills(["Git"], ["Digital Marketing"]), ["Git"]);
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
  const r = await fd.fillSkillsCdp(act, LOC, ["Python", "Docker", "Linux"], B, { fillAll: true });
  assert.equal(r.status, "filled");
  assert.deepEqual(st.chips, ["Python (Programming Language)", "Docker", "Linux"]);
  assert.match(r.detail, /Python → Python \(Programming Language\)/);
  assert.equal(r.after, "Python (Programming Language); Docker; Linux");
});

test("fillSkillsCdp: a WIDENED commit lands but sends the field to review, naming the widening", async () => {
  const { act, st } = makeSkillsAct({ catalog: ["Xilinx Vivado", "Linux"], fuzz: FUZZ });
  const r = await fd.fillSkillsCdp(act, LOC, ["Vivado", "Linux"], B, { fillAll: true });
  assert.deepEqual(st.chips, ["Xilinx Vivado", "Linux"], "Vivado landed under Workday's broader name");
  assert.equal(r.status, "filled_review", "a value we widened is not a silent fill");
  assert.equal(r.flag, "skills-containment");
  assert.deepEqual(r.skills_widened, ["Vivado → Xilinx Vivado"]);
  assert.match(r.detail, /Vivado → Xilinx Vivado \(broader\)/);
});

test("fillSkillsCdp: a widening that had ALTERNATIVES names them, so review can switch", async () => {
  const { act, st } = makeSkillsAct({ catalog: ["Xilinx Vivado", "Vivado HLS"] });
  const r = await fd.fillSkillsCdp(act, LOC, ["Vivado"], B, { fillAll: true });
  assert.deepEqual(st.chips, ["Xilinx Vivado"]);
  assert.equal(r.flag, "skills-containment");
  assert.match(r.detail, /Workday also offered Vivado HLS/);
});

test("fillSkillsCdp: exact-only adds stay a SILENT filled — widening is what triggers review", async () => {
  const { act } = makeSkillsAct({ catalog: CATALOG, fuzz: FUZZ });
  const r = await fd.fillSkillsCdp(act, LOC, ["Linux", "Git"], B, { fillAll: true });
  assert.equal(r.status, "filled");
  assert.equal(r.flag, null);
  assert.deepEqual(r.skills_widened, []);
});

test("fillSkillsCdp: a skill Workday does not know is left OFF the form and named", async () => {
  const { act, st } = makeSkillsAct({ catalog: CATALOG, fuzz: FUZZ });
  const r = await fd.fillSkillsCdp(act, LOC, ["Git", "Yosys", "ODrive"], B, { fillAll: true });
  assert.deepEqual(st.chips, ["Git"], "no fuzzy row was ever committed");
  assert.deepEqual(r.skills_not_offered, ["Yosys", "ODrive"]);
  assert.match(r.detail, /NOT in Workday's skill list.*Yosys, ODrive/);
  assert.equal(r.status, "filled");
});

test("fillSkillsCdp: NEVER touches skills already on the form, and re-running adds nothing", async () => {
  // The résumé parse / a previous run owns those chips. Idempotency is what stops a second pass
  // from committing "Docker (Software)" next to an existing "Docker".
  const { act, st } = makeSkillsAct({ catalog: CATALOG, chips: ["Docker"], fuzz: FUZZ });
  const r1 = await fd.fillSkillsCdp(act, LOC, ["Docker", "Git"], B, { fillAll: true });
  assert.deepEqual(st.chips, ["Docker", "Git"]);
  assert.equal(r1.status, "filled");

  const { act: a2, st: s2, log } = makeSkillsAct({ catalog: CATALOG, chips: st.chips.slice(), fuzz: FUZZ });
  const r2 = await fd.fillSkillsCdp(a2, LOC, ["Docker", "Git"], B, { fillAll: true });
  assert.deepEqual(s2.chips, ["Docker", "Git"], "second pass is a no-op");
  assert.equal(r2.flag, "skills-already-present");
  assert.ok(!log.some((l) => l[0] === "enter"), "and it never even searched");
});

test("fillSkillsCdp: a qualified chip from a prior run counts as present", async () => {
  const { act, log } = makeSkillsAct({ catalog: CATALOG, chips: ["Python (Programming Language)"], fuzz: FUZZ });
  const r = await fd.fillSkillsCdp(act, LOC, ["Python"], B, { fillAll: true });
  assert.equal(r.flag, "skills-already-present");
  assert.ok(!log.some((l) => l[0] === "enter"));
});

test("fillSkillsCdp: a ZERO-result query free-text-adds, and that counts as filled", async () => {
  // The one path by which an off-taxonomy skill actually lands. Accepted only because the new chip
  // IS what we typed — Workday completed it, we did not guess it.
  const { act, st } = makeSkillsAct({ catalog: CATALOG }); // no fuzz → unknown queries return zero
  const r = await fd.fillSkillsCdp(act, LOC, ["CubeMars motor drivers"], B, { fillAll: true });
  assert.deepEqual(st.chips, ["CubeMars motor drivers"]);
  assert.equal(r.status, "filled");
});

test("fillSkillsCdp: an unverifiable CLEAR never reaches Enter — a dirty box can FABRICATE a skill", async () => {
  // The trap seen live: with "Docker" still in the box, typing the next skill appended to it and
  // Enter created the chip "DockerCubeMars motor drivers" — a skill nobody claimed. The box starts
  // genuinely empty, so skill 1 proceeds; the broken clear bites on skill 2, which must be SKIPPED
  // (never Enter on a concatenated query) and reported as an infra failure, not as absence.
  const fast = Object.assign({}, B, { taActionSettleCeilingMs: 120, taActionSettleIntervalMs: 20 });
  const { act, st, log } = makeSkillsAct({ catalog: CATALOG, clearBroken: true });
  const r = await fd.fillSkillsCdp(act, LOC, ["Python", "Git"], fast, { fillAll: true });
  assert.deepEqual(log.filter((l) => l[0] === "enter").map((l) => l[1]), ["Python"],
    "only the query whose box verified EMPTY reached Enter");
  assert.deepEqual(st.chips, ["Python (Programming Language)"], "no concatenated skill was fabricated");
  assert.deepEqual(r.skills_failed, ["Git"]);
  assert.deepEqual(r.skills_not_offered, [], "an unclearable box is NOT evidence Workday lacks the skill");
});

test("fillSkillsCdp: a TRANSIENT clear failure retries — it must not abandon the rest of the list", async () => {
  // Live regression (cat.wd5, first run): the clear failed ONCE mid-list and the field stopped at 7
  // skills, silently giving up on Git/Docker/VS Code/Vivado. One failure is a transient (the clear is
  // focus-blind and a commit can move focus), so it retries; the list must still finish.
  const { act, st } = makeSkillsAct({ catalog: CATALOG, fuzz: FUZZ, clearFailsFor: 1 });
  const r = await fd.fillSkillsCdp(act, LOC, ["Docker", "Linux", "Git"], B, { fillAll: true });
  assert.deepEqual(st.chips, ["Docker", "Linux", "Git"], "every skill still landed");
  assert.equal(r.status, "filled");
  assert.ok(!/stopped early/.test(r.detail), "and the field did not bail: " + r.detail);
});

test("fillSkillsCdp: a PERSISTENTLY stuck box stops after 2, and says so — it can't burn the budget", async () => {
  const fast = Object.assign({}, B, { taActionSettleCeilingMs: 120, taActionSettleIntervalMs: 20 });
  const { act, st, log } = makeSkillsAct({ catalog: CATALOG, clearBroken: true });
  const r = await fd.fillSkillsCdp(act, LOC, ["Docker", "Linux", "Git", "Python"], fast, { fillAll: true });
  assert.deepEqual(log.filter((l) => l[0] === "enter").map((l) => l[1]), ["Docker"],
    "only the first query, whose box was genuinely empty, reached Enter");
  assert.deepEqual(st.chips, ["Docker"], "nothing fabricated from a dirty box");
  assert.match(r.detail, /stopped early \(the search box would not clear\)/);
});

test("fillSkillsCdp: a commit that never lands is reported as FAILED, not as 'Workday lacks it'", async () => {
  // The distinction the human acts on: absent means add it by hand, failed means re-run.
  const { act } = makeSkillsAct({ catalog: CATALOG, fuzz: FUZZ });
  act.clickHierLeaf = async () => true; // click dispatched, no chip ever appears
  const r = await fd.fillSkillsCdp(act, LOC, ["Linux", "Yosys"], B, { fillAll: true });
  assert.deepEqual(r.skills_failed, ["Linux"]);
  assert.deepEqual(r.skills_not_offered, ["Yosys"]);
  assert.match(r.detail, /could not be entered/);
  assert.match(r.detail, /NOT in Workday's skill list/);
});

test("fillSkillsCdp: opens by FOCUSING the input when the coordinate click can't (the hidden-tab failure)", async () => {
  // Live: a HIDDEN run logged "could not focus the search box" and added ZERO skills, while the same
  // job worked visible. While closed the input has no `searchBox` automation-id, so opening depended on
  // a coordinate click — the step that a hidden, below-the-fold widget breaks. A page-side focus needs
  // no coordinates and no paint.
  const { act, st, log } = makeSkillsAct({ catalog: CATALOG });
  act.openHier = async () => { log.push(["open-FAILED"]); return false; };   // coordinate click lands nowhere
  act.openHierInput = async () => { log.push(["openInput"]); st.open = true; return { ok: true, focused: true }; };
  const r = await fd.fillSkillsCdp(act, LOC, ["Linux", "Git"], B, { fillAll: true });
  assert.deepEqual(st.chips, ["Linux", "Git"]);
  assert.equal(r.status, "filled");
  assert.ok(log.some((l) => l[0] === "openInput"), "used the input-focus/click route, not coordinates");
});

test("fillSkillsCdp: the opener RETRIES an open that lost the race, alternating both routes", async () => {
  // The actual hidden-tab fix. A hidden run failed every attempt ("could not focus the search box",
  // zero skills) because the open raced Workday's re-render right after the previous field committed —
  // NOT because of the event kind (an isolation probe with trusted input removed filled the field fine).
  // So the first opens are allowed to miss, and the routes alternate.
  const { act, st, log } = makeSkillsAct({ catalog: CATALOG });
  let opens = 0;
  act.openHierInput = async () => { opens++; if (opens >= 2) st.open = true;   // lands on the retry
    return { ok: true, focused: true, openedNow: st.open }; };
  act.openHier = async () => { log.push(["container-coords"]); return true; };
  act.clickHierInputRect = async () => { log.push(["input-coords"]); return true; };
  const r = await fd.fillSkillsCdp(act, LOC, ["Linux"], B, { fillAll: true });
  assert.deepEqual(st.chips, ["Linux"], "a first-attempt miss no longer costs the whole field");
  assert.equal(r.status, "filled");
  assert.ok(opens >= 2, "it retried the coordinate-free route");
  // `openHier` clicks the CONTAINER's centre, which drifts onto a CHIP (and its delete X) as chips
  // accumulate — live, a skill vanished between runs. The coordinate route must aim at the INPUT.
  assert.ok(!log.some((l) => l[0] === "container-coords"), "never coordinate-clicks the chip-bearing container");
});

test("fillSkillsCdp: nothing matched and the field is BLANK → needs_review", async () => {
  const { act } = makeSkillsAct({ catalog: CATALOG, fuzz: FUZZ });
  const r = await fd.fillSkillsCdp(act, LOC, ["Yosys", "ODrive"], B, { fillAll: true });
  assert.equal(r.status, "needs_review");
  assert.equal(r.flag, "skills-none-matched");
});

test("fillSkillsCdp: an empty profile list is a skip, not an error", async () => {
  const { act, log } = makeSkillsAct({ catalog: CATALOG });
  const r = await fd.fillSkillsCdp(act, LOC, [], B, { fillAll: true });
  assert.equal(r.status, "skipped");
  assert.ok(!log.length, "the widget was never even opened");
});

test("fillSkillsCdp: the cap is reported, never silent", async () => {
  const { act, st } = makeSkillsAct({ catalog: CATALOG, fuzz: FUZZ });
  const r = await fd.fillSkillsCdp(act, LOC, ["Python", "Docker", "Linux"], B, { maxAdds: 2, fillAll: true });
  assert.equal(st.chips.length, 2);
  assert.match(r.detail, /1 skill\(s\) not attempted — the 2-skill cap/);
});

test("fillSkillsCdp: an unexpected chip is surfaced, never accepted quietly", async () => {
  const { act, st } = makeSkillsAct({ catalog: CATALOG });
  const orig = act.clickHierLeaf;
  act.clickHierLeaf = async (loc, label) => { const ok = await orig(loc, label); st.chips.push("Something Else"); return ok; };
  const r = await fd.fillSkillsCdp(act, LOC, ["Linux"], B, { fillAll: true });
  assert.equal(r.status, "needs_review");
  assert.equal(r.flag, "skills-stray");
  assert.match(r.detail, /UNEXPECTED chip\(s\): Something Else/);
});

// ── Workday's "(Suggested)" annotation on résumé-parsed chips ───────────────

test("skillChipName strips Workday's (Suggested) provenance marker, not a real qualifier", () => {
  // Live on the Autofill-with-Resume flow: the parse's chip reads "Digital Systems (Suggested)", while
  // Workday's own review page prints the bare name — so recording the annotated form would store a value
  // the review page never shows and the reconcile would call a filled skill missing.
  assert.equal(lib.skillChipName("Digital Systems (Suggested)"), "Digital Systems");
  assert.equal(lib.skillChipName("Python (Programming Language)"), "Python (Programming Language)",
    "a real qualifier is part of the name");
  assert.equal(lib.skillChipName("Linux"), "Linux");
});

test("fillSkillsCdp: records the BARE name for a suggested chip, and dedupes against it", async () => {
  const { act, log } = makeSkillsAct({ catalog: CATALOG, chips: ["Digital Systems (Suggested)", "Linux (Suggested)"] });
  const kept = await fd.fillSkillsCdp(act, LOC, ["Git"], B);
  assert.equal(kept.after, "Digital Systems; Linux", "no annotation reaches the bundle");
  // and with fill-all on, a suggested chip still counts as covering the profile's own wording
  const { act: a2, log: l2 } = makeSkillsAct({ catalog: CATALOG, chips: ["Linux (Suggested)"] });
  const r = await fd.fillSkillsCdp(a2, LOC, ["Linux"], B, { fillAll: true });
  assert.equal(r.flag, "skills-already-present");
  assert.ok(!l2.some((x) => x[0] === "enter"), "never re-searched a skill the parse already suggested");
  assert.ok(!log.some((x) => x[0] === "enter"));
});

test("auditActualFromRaw: the audit strips (Suggested) too, or a kept field reads as a mismatch", () => {
  // This regressed the instant the stripping was introduced: the fill recorded the bare names while the
  // M40 audit re-read the annotated chips, so a correctly-kept skills field was flagged
  // `skills:audit-mismatch` on a live run. Both sides must clean.
  const got = fd.auditActualFromRaw("typeahead", { chips: ["Computer Hardware (Suggested)", "Linux"] });
  assert.equal(got.actual, "Computer Hardware; Linux");
  assert.equal(got.readable, true);
});

// ── the fill-all policy (the profile checkbox) ──────────────────────────────

test("fillSkillsCdp: fill-all OFF keeps Workday's suggested skills and adds NOTHING", async () => {
  // Autofill-with-Resume seeds this field with Workday's own suggestions. With the checkbox off we keep
  // them, spend no search round trips, and record the list so the review page can edit it.
  const { act, st, log } = makeSkillsAct({ catalog: CATALOG, chips: ["Python (Programming Language)", "Linux"] });
  const r = await fd.fillSkillsCdp(act, LOC, ["Git", "Docker", "Vivado"], B);
  assert.deepEqual(st.chips, ["Python (Programming Language)", "Linux"], "suggestions untouched, nothing added");
  assert.equal(r.status, "filled");
  assert.equal(r.flag, "skills-suggested-kept");
  assert.equal(r.after, "Python (Programming Language); Linux", "recorded, so review can add/delete");
  assert.ok(!log.length, "and it never even opened the widget");
});

test("fillSkillsCdp: fill-all OFF and NO suggestions → a review item, not a silent skip", async () => {
  // Live, the same résumé produced 15 suggestions on one posting, 1 on another and 0 on a third. When it
  // suggests nothing, "keep the suggestions" would ship an application with no skills at all — so the
  // empty case is surfaced for review rather than hidden.
  const { act } = makeSkillsAct({ catalog: CATALOG });
  const r = await fd.fillSkillsCdp(act, LOC, ["Git"], B);
  assert.equal(r.status, "needs_review");
  assert.equal(r.flag, "skills-none-suggested");
  assert.match(r.detail, /suggested no skills/i);
  assert.match(r.detail, /1\.5–3s per skill/, "and it names the real cost of turning it on");
});

test("fillSkillsCdp: fill-all ON adds on TOP of the suggestions, never replacing them", async () => {
  const { act, st } = makeSkillsAct({ catalog: CATALOG, chips: ["Python (Programming Language)"] });
  const r = await fd.fillSkillsCdp(act, LOC, ["Python", "Git"], B, { fillAll: true });
  assert.deepEqual(st.chips, ["Python (Programming Language)", "Git"],
    "the suggestion is kept (and covers the profile's 'Python'), Git is added");
  assert.equal(r.status, "filled");
});

// ── the reconcile against Workday's own review page ─────────────────────────

test("reconcileReviewPage: a skills SET is checked value-by-value, not as one joined string", () => {
  // Workday's review page prints one value per skill. Matching "A; B; C" as a single string would
  // report a correctly filled 20-skill field as MISSING on every single rehearsal.
  const entries = [{ field_id: "p2::formField-skills", widget_type: "typeahead",
    question_label: "Type to Add Skills", current_value: "Python (Programming Language); Docker; Linux",
    fill_status: "filled", is_approved: true }];
  const items = [
    { label: "Skills", value: "Python (Programming Language)", key: "skills" },
    { label: "Skills", value: "Docker" },
    { label: "Skills", value: "Linux" }
  ];
  const r = lib.reconcileReviewPage(items, entries, {});
  assert.equal(r.agree.length, 1);
  assert.equal(r.agree[0].tier, "skills-set", "took the multi-value path, not value-presence on the joined string");
  assert.equal(r.missing_on_review.length, 0);
});

test("reconcileReviewPage: a skill missing from the review page is reported, and NAMED", () => {
  const entries = [{ field_id: "p2::formField-skills", widget_type: "typeahead",
    question_label: "Type to Add Skills", current_value: "Docker; Linux; Kubernetes",
    fill_status: "filled", is_approved: true }];
  const items = [{ label: "Skills", value: "Docker", key: "skills" }, { label: "Skills", value: "Linux" }];
  const r = lib.reconcileReviewPage(items, entries, {});
  assert.equal(r.agree.length, 0);
  assert.equal(r.missing_on_review.length, 1);
  assert.match(r.missing_on_review[0].detail, /Kubernetes/);
});

test("isSkillsEntry: entry-level detection matches the fill-side predicate", () => {
  assert.ok(lib.isSkillsEntry({ field_id: "p2::formField-skills", widget_type: "typeahead", question_label: "Type to Add Skills" }));
  assert.ok(!lib.isSkillsEntry({ field_id: "p2::formField-skills", widget_type: "text", question_label: "Skills" }));
  assert.ok(!lib.isSkillsEntry({ field_id: "p2::formField-jobTitle", widget_type: "typeahead", question_label: "Job Title" }));
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
