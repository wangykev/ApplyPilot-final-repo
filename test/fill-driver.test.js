// Unit tests for fill-driver.js — the substrate-agnostic CDP fill brain — driven
// by a FAKE actuation (the substrate-swap hedge made testable). The fake logs
// every actuation call so tests can assert not just outcomes but that deferred
// widgets are NEVER actuated and unverified commits are NEVER pressed.
const { test } = require("node:test");
const assert = require("node:assert");
const { drivePageFill } = require("../fill-driver.js");

// Tiny budgets: success paths settle on the first reads; failure-path polls
// spin only for a few ms of wall clock.
const T_BUDGETS = {
  openCeilingMs: 60, settleIntervalMs: 1, stableReads: 2,
  commitCeilingMs: 25, commitIntervalMs: 1,
  textReadDelayMs: 1, typeJumpDelayMs: 1, arrowStepMs: 1, maxArrowSteps: 60,
  interFieldMs: 0
};

// ── fake actuation ───────────────────────────────────────────────────────────
// Each field spec is the mutable widget state + behavior flags:
//   text:     { value, mangle?, noFocus? }
//   dropdown: { triggerText, options:[{text,disabled?}], openFails?, neverRenders?,
//               typeJumpLandsIdx? (full-list idx | null = no move), highlightStuck?,
//               enterFails?, enterCommitsWrongIdx?, clickFallbackWorks? }
//   radio:    { options:[{id,labelText,checked}], radioClickRectDead?,
//               radioClickNoCommit?, spaceFails? }
//   checkbox: { inputId, checked, checkboxClickRectDead?, spaceFails? }
function makeFakeAct(fields) {
  const log = [];
  const byLoc = (loc) => fields.find((f) => f.wrapperSel === loc.wrapperSel);
  let focusedText = null;
  let focusedInputId = null;
  let openField = null;
  const enabledIdxs = (f) => f.options.map((o, i) => ({ o, i })).filter((x) => !x.o.disabled).map((x) => x.i);

  return {
    log,
    delay: async () => {},
    scanPage: async () => ({
      url: "fake://page",
      repeatingFieldCount: 0,
      fields: fields.map((f) => ({
        wrapperSel: f.wrapperSel, fieldName: f.fieldName, widgetType: f.widgetType,
        label: f.label || f.fieldName, isRequired: !!f.isRequired
      }))
    }),

    // text
    readTextValue: async (loc) => {
      const f = byLoc(loc);
      return f.noInput ? null : { value: f.value || "", focused: focusedText === f };
    },
    focusText: async (loc) => {
      log.push(["focusText", loc.wrapperSel]);
      const f = byLoc(loc);
      if (f.noFocus) return null;
      focusedText = f;
      return "cdp-click";
    },
    clearText: async () => { log.push(["clearText"]); if (focusedText) focusedText.value = ""; },
    typeText: async (text) => {
      log.push(["typeText", text]);
      if (focusedText) focusedText.value = focusedText.mangle ? focusedText.mangle(text) : text;
    },

    // dropdown
    openDropdown: async (loc) => {
      log.push(["openDropdown", loc.wrapperSel]);
      const f = byLoc(loc);
      if (f.openFails) return false;
      f.open = true;
      if (f.activeIdx === undefined) f.activeIdx = null;
      openField = f;
      return true;
    },
    readDropdownState: async (loc) => {
      const f = byLoc(loc);
      const open = f.open && !f.neverRenders;
      const options = open ? f.options : [];
      return {
        triggerText: f.triggerText,
        listboxPresent: !!open,
        optionCount: options.filter((o) => !o.disabled).length,
        options: options.map((o) => ({ text: o.text, disabled: !!o.disabled, selected: !!o.selected })),
        activeText: open && f.activeIdx != null ? f.options[f.activeIdx].text : null
      };
    },
    typeJumpChars: async (chars) => {
      log.push(["typeJumpChars", chars]);
      const f = openField;
      if (!f || !f.open || f.highlightStuck) return;
      if (f.typeJumpLandsIdx !== undefined) { f.activeIdx = f.typeJumpLandsIdx; return; }
      const i = f.options.findIndex((o) => !o.disabled && o.text.toLowerCase().startsWith(chars.toLowerCase()));
      if (i !== -1) f.activeIdx = i;
    },
    arrowStep: async (dir) => {
      log.push(["arrowStep", dir]);
      const f = openField;
      if (!f || !f.open || f.highlightStuck) return;
      const en = enabledIdxs(f);
      if (!en.length) return;
      if (f.activeIdx == null) { f.activeIdx = en[0]; return; }
      const pos = en.indexOf(f.activeIdx);
      f.activeIdx = en[Math.min(Math.max(pos + (dir < 0 ? -1 : 1), 0), en.length - 1)];
    },
    pressEnter: async () => {
      log.push(["pressEnter"]);
      const f = openField;
      if (!f || !f.open) return;
      if (f.enterFails) { f.open = false; return; }
      if (f.enterCommitsWrongIdx !== undefined) { f.triggerText = f.options[f.enterCommitsWrongIdx].text; f.open = false; return; }
      if (f.activeIdx != null) f.triggerText = f.options[f.activeIdx].text;
      f.open = false;
    },
    pressEscape: async () => { log.push(["pressEscape"]); if (openField) openField.open = false; },
    clickOptionByIndex: async (loc, index) => {
      log.push(["clickOptionByIndex", index]);
      const f = byLoc(loc);
      if (!f.clickFallbackWorks) return false;
      f.triggerText = f.options[index].text;
      f.open = false;
      return true;
    },

    // radio / checkbox
    readRadioState: async (loc) => byLoc(loc).options.map((o) => ({ ...o })),
    clickRadioLabel: async (loc, id) => {
      log.push(["clickRadioLabel", id]);
      const f = byLoc(loc);
      if (f.radioClickRectDead) return false;
      if (!f.radioClickNoCommit) f.options.forEach((o) => { o.checked = o.id === id; });
      return true;
    },
    focusInput: async (id) => { log.push(["focusInput", id]); focusedInputId = id; return true; },
    pressSpace: async () => {
      log.push(["pressSpace"]);
      if (!focusedInputId) return;
      for (const f of fields) {
        if (f.widgetType === "radio" && f.options && f.options.some((o) => o.id === focusedInputId)) {
          if (!f.spaceFails) f.options.forEach((o) => { o.checked = o.id === focusedInputId; });
          return;
        }
        if (f.widgetType === "checkbox" && f.inputId === focusedInputId) {
          if (!f.spaceFails) f.checked = !f.checked;
          return;
        }
      }
    },
    readChecked: async (id) => {
      for (const f of fields) {
        if (f.options) { const o = f.options.find((x) => x.id === id); if (o) return o.checked; }
        if (f.inputId === id) return f.checked;
      }
      return null;
    },
    readCheckboxState: async (loc) => { const f = byLoc(loc); return { inputId: f.inputId, checked: f.checked }; },
    clickCheckboxLabel: async (loc) => {
      log.push(["clickCheckboxLabel", loc.wrapperSel]);
      const f = byLoc(loc);
      if (f.checkboxClickRectDead) return false;
      f.checked = !f.checked;
      return true;
    }
  };
}

const run = (fields, profile, jobContext) =>
  drivePageFill(makeFakeAct(fields), profile, {}, jobContext, T_BUDGETS).then((out) => out.results);

// ── the employer-match invariant (confirmation #1 — NAMED test) ─────────────

const PW_LABEL = "If you are a former MAGNA employee, please select Yes and enter all the applicable information below, including Elavon, US Bancorp Investments, Union Bank.";
const pwField = (flags) => Object.assign({
  wrapperSel: "[w-pw]", fieldName: "candidateIsPreviousWorker", widgetType: "radio", label: PW_LABEL,
  options: [{ id: "pw-yes", labelText: "Yes", checked: false }, { id: "pw-no", labelText: "No", checked: false }]
}, flags || {});
const pwProfile = (employers) => ({ employment_history_companies: employers });

test('previous-worker radio is NEVER left "Yes" without a needs_review flag', async () => {
  const scenarios = [
    { name: "exact company match", company: "Magna", employers: ["Magna"], expect: { after: "Yes", status: "filled_review" } },
    { name: "employer named in the question text", company: null, employers: ["US Bancorp Investments"], expect: { after: "Yes", status: "filled_review" } },
    { name: "partial overlap → No + review", company: "Magna", employers: ["Magna Steyr"], expect: { after: "No", status: "filled_review" } },
    { name: "clean miss → confident No, no review", company: "Magna", employers: ["Google"], expect: { after: "No", status: "filled" } },
    { name: '["none"] sentinel → confident No', company: "Magna", employers: ["none"], expect: { after: "No", status: "filled" } },
    { name: "[] unfilled → blank + review", company: "Magna", employers: [], expect: { after: null, status: "needs_review" } },
    { name: "unconfigured → blank + review", company: "Magna", employers: undefined, expect: { after: null, status: "needs_review" } },
    // Actuation failure on a Yes decision must surface as review, never silent.
    { name: "Yes decision but commit fails → needs_review", company: "Magna", employers: ["Magna"],
      flags: { radioClickRectDead: true, spaceFails: true }, expect: { status: "needs_review" } }
  ];
  const allRecords = [];
  for (const s of scenarios) {
    const [rec] = await run([pwField(s.flags)], pwProfile(s.employers), { company: s.company });
    allRecords.push({ scenario: s.name, rec });
    if (s.expect.after !== undefined) assert.strictEqual(rec.after, s.expect.after, `${s.name}: after`);
    assert.strictEqual(rec.status, s.expect.status, `${s.name}: status`);
  }
  // THE INVARIANT (sits beside a truthfulness certification): a "Yes" answer
  // must never carry plain "filled" — it is always review-flagged.
  for (const { scenario, rec } of allRecords) {
    if (rec.after === "Yes") {
      assert.notStrictEqual(rec.status, "filled", `INVARIANT VIOLATION in "${scenario}": "Yes" without a review flag`);
      assert.ok(rec.status === "filled_review" || rec.status === "needs_review", `INVARIANT VIOLATION in "${scenario}": status ${rec.status}`);
    }
  }
});

test("previous-worker: blank decision performs ZERO radio actuation", async () => {
  const act = makeFakeAct([pwField()]);
  await drivePageFill(act, pwProfile([]), {}, { company: "Magna" }, T_BUDGETS);
  assert.ok(!act.log.some(([m]) => m === "clickRadioLabel" || m === "focusInput" || m === "pressSpace"),
    "blank+review must not touch the radio");
});

test("previous-worker: label-click no-commit falls back to focus+Space and stays review-flagged", async () => {
  const [rec] = await run([pwField({ radioClickNoCommit: true })], pwProfile(["Magna"]), { company: "Magna" });
  assert.strictEqual(rec.after, "Yes");
  assert.strictEqual(rec.status, "filled_review");
  assert.match(rec.detail, /focus\+Space/);
});

test("radio: no candidate matches the labels → needs_review with the options", async () => {
  const odd = pwField();
  odd.options = [{ id: "a", labelText: "Yeah", checked: false }, { id: "b", labelText: "Nope", checked: false }];
  const [rec] = await run([odd], pwProfile(["Magna"]), { company: "Magna" });
  assert.strictEqual(rec.status, "needs_review");
  assert.deepStrictEqual(rec.options, ["Yeah", "Nope"]);
});

// ── text ─────────────────────────────────────────────────────────────────────

const textField = (flags) => Object.assign({
  wrapperSel: "[w-first]", fieldName: "legalName--firstName", widgetType: "text", label: "First Name*", value: "Old"
}, flags || {});
const nameProfile = { personal_info: { first_name: "Kevin" } };

test("text: fills and verifies by read-back", async () => {
  const [rec] = await run([textField()], nameProfile, {});
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "Kevin");
  assert.strictEqual(rec.verified, true);
  assert.match(rec.detail, /overwrote "Old"/);
});

test("text: read-back mismatch is NEVER reported as filled", async () => {
  const [rec] = await run([textField({ mangle: () => "WRONG" })], nameProfile, {});
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.verified, false);
  assert.match(rec.detail, /read-back mismatch/);
});

// ── dropdown (type-to-highlight + verified Enter) ───────────────────────────

const DD_OPTIONS = [
  { text: "Select One", disabled: true },
  { text: "Canada" },
  { text: "United States of America" },
  { text: "Uruguay" }
];
const ddField = (flags) => Object.assign({
  wrapperSel: "[w-country]", fieldName: "country", widgetType: "dropdown", label: "Country*",
  triggerText: "Select One", options: DD_OPTIONS.map((o) => ({ ...o }))
}, flags || {});
const usProfile = { personal_info: { country: "United States of America" } };

test("dropdown: type-jump lands on target → verified Enter commit, no arrow-walk", async () => {
  const act = makeFakeAct([ddField()]);
  const out = await drivePageFill(act, usProfile, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "United States of America");
  assert.strictEqual(rec.detail, "enter-commit");
  assert.ok(!act.log.some(([m]) => m === "arrowStep"), "no arrow-walk needed");
});

test("dropdown: type-jump lands WRONG → arrow-walk correction → re-verified Enter", async () => {
  const act = makeFakeAct([ddField({ typeJumpLandsIdx: 3 /* Uruguay */ })]);
  const out = await drivePageFill(act, usProfile, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "United States of America");
  assert.ok(act.log.some(([m]) => m === "arrowStep"), "arrow-walk corrected the highlight");
});

test("dropdown: highlight never verifiable → Enter NEVER pressed → needs_review", async () => {
  const act = makeFakeAct([ddField({ highlightStuck: true })]);
  const out = await drivePageFill(act, usProfile, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.match(rec.detail, /could not verify highlight/);
  assert.ok(!act.log.some(([m]) => m === "pressEnter"), "must not commit an unverified highlight");
  assert.ok(act.log.some(([m]) => m === "pressEscape"), "closes the listbox");
});

test("dropdown: options never render → Escape + needs_review (skipped_no_option_match)", async () => {
  const act = makeFakeAct([ddField({ neverRenders: true })]);
  const out = await drivePageFill(act, usProfile, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.match(rec.detail, /options did not render/);
  assert.ok(act.log.some(([m]) => m === "pressEscape"));
});

test("dropdown: no candidate matched → Escape + needs_review with captured options", async () => {
  const [rec] = await run([ddField()], { personal_info: { country: "Atlantis" } }, {});
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.detail, "no candidate matched");
  assert.deepStrictEqual(rec.options, ["Canada", "United States of America", "Uruguay"]);
});

test("dropdown: Enter commits the WRONG value → never silently accepted", async () => {
  const [rec] = await run([ddField({ enterCommitsWrongIdx: 1 /* Canada */ })], usProfile, {});
  assert.strictEqual(rec.status, "needs_review");
  assert.match(rec.detail, /commit failed/);
  assert.strictEqual(rec.after, "Canada"); // the wrong value is surfaced, not accepted
});

test("dropdown: Enter-commit fails → last-resort coordinate click, same verify gate", async () => {
  const [rec] = await run([ddField({ enterFails: true, clickFallbackWorks: true })], usProfile, {});
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "United States of America");
  assert.match(rec.detail, /click-fallback/);
});

// ── checkbox (reconcile-to-boolean; mapping synthetic — mechanism coverage) ──

test("checkbox: reconciles false→true and true→false, verified by checked read-back", async () => {
  const cb = (checked) => ({ wrapperSel: "[w-cb]", fieldName: "extension", widgetType: "checkbox", label: "Box", inputId: "cb-1", checked });
  const [recOn] = await run([cb(false)], { personal_info: { phone_extension: true } }, {});
  assert.strictEqual(recOn.status, "filled");
  assert.strictEqual(recOn.after, "true");
  const [recOff] = await run([cb(true)], { personal_info: { phone_extension: false } }, {});
  assert.strictEqual(recOff.status, "filled");
  assert.strictEqual(recOff.after, "false");
});

test("checkbox: unmapped (preferredCheck) → skipped with zero actuation", async () => {
  const act = makeFakeAct([{ wrapperSel: "[w-pref]", fieldName: "preferredCheck", widgetType: "checkbox", label: "I have a preferred name", inputId: "p-1", checked: false }]);
  const out = await drivePageFill(act, nameProfile, {}, {}, T_BUDGETS);
  assert.strictEqual(out.results[0].status, "skipped");
  assert.strictEqual(out.results[0].detail, "no mapping");
  assert.strictEqual(act.log.length, 0);
});

// ── deferred widgets: honest records, ZERO actuation ─────────────────────────

test("typeahead and source → needs_review with ZERO actuation calls", async () => {
  const act = makeFakeAct([
    { wrapperSel: "[w-ta]", fieldName: "countryPhoneCode", widgetType: "typeahead", label: "Phone Code" },
    { wrapperSel: "[w-src]", fieldName: "source", widgetType: "hierarchical", label: "How Did You Hear About Us?" }
  ]);
  const out = await drivePageFill(act, nameProfile, {}, {}, T_BUDGETS);
  assert.strictEqual(out.results[0].status, "needs_review");
  assert.match(out.results[0].detail, /typeahead deferred/);
  assert.strictEqual(out.results[1].status, "needs_review");
  assert.match(out.results[1].detail, /source deferred/);
  assert.strictEqual(act.log.length, 0, "deferred widgets must never be actuated");
  assert.strictEqual(out.needsReview.length, 2);
});

test("unmapped text field → skipped 'no mapping'; file_upload → skipped", async () => {
  const out = await drivePageFill(makeFakeAct([
    { wrapperSel: "[w-x]", fieldName: "regionSubdivision1", widgetType: "text", label: "County", value: "" },
    { wrapperSel: "[w-up]", fieldName: "resumeUpload", widgetType: "file_upload", label: "Resume" }
  ]), nameProfile, {}, {}, T_BUDGETS);
  assert.strictEqual(out.results[0].status, "skipped");
  assert.strictEqual(out.results[0].detail, "no mapping");
  assert.strictEqual(out.results[1].status, "skipped");
  assert.match(out.results[1].detail, /file upload/);
});
