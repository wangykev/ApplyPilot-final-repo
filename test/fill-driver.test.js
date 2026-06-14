// Unit tests for fill-driver.js — the substrate-agnostic CDP fill brain — driven
// by a FAKE actuation (the substrate-swap hedge made testable). The fake logs
// every actuation call so tests can assert not just outcomes but that deferred
// widgets are NEVER actuated and unverified commits are NEVER pressed.
const { test } = require("node:test");
const assert = require("node:assert");
const { drivePageFill, fillSourceCdp } = require("../fill-driver.js");

// Tiny budgets: success paths settle on the first reads; failure-path polls
// spin only for a few ms of wall clock.
const T_BUDGETS = {
  openCeilingMs: 60, settleIntervalMs: 1, stableReads: 2,
  commitCeilingMs: 25, commitIntervalMs: 1,
  textReadDelayMs: 1, typeJumpDelayMs: 1, arrowStepMs: 1, maxArrowSteps: 60,
  interFieldMs: 0,
  taOpenCeilingMs: 50, taOpenIntervalMs: 1, taActionSettleMs: 1,
  taSettleCeilingMs: 60, taSettleIntervalMs: 1, taEnterCommitCeilingMs: 25
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
//   typeahead:{ chips:[], openTexts? (rendered list at open — the stable
//               pre-filter case), fallbackTexts? (the full list a no-match
//               re-renders UNDER the banner), filterMap: { query →
//               {filtered:[...]} | {banner:true} | {autoCommit:"text"} },
//               enterCommitFails? }. Mirrors the recon-observed mechanics:
//               the first Enter after typing applies filterMap (bumping a
//               revision counter — the real page transitions through a
//               cleared list, so the sig always changes on a response); a
//               SECOND Enter commits the first filtered option as the chip;
//               a banner and the list PERSIST across clearSearch (stale).
function makeFakeAct(fields) {
  const log = [];
  const byLoc = (loc) => fields.find((f) => f.wrapperSel === loc.wrapperSel);
  let focusedText = null;
  let focusedInputId = null;
  let openField = null;
  let focusedTa = null;
  let focusedSrc = null;
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
      // Source filter-Enter (no commit-Enter for source — commit is clickSourceLeaf).
      const src = focusedSrc;
      if (src && src._open) {
        const fm = (src.filterMap || {})[src._value];
        if (fm) {
          src._rev = (src._rev || 0) + 1;
          if (fm.banner) { src._banner = true; src._leaves = (src.fallbackLeaves || src._leaves || []).slice(); }
          else if (fm.autoCommit) { src.chips = [fm.autoCommit]; src._open = false; src._banner = false; }
          else if (fm.filtered) { src._leaves = fm.filtered.slice(); src._banner = false; }
        }
        return;
      }
      // Typeahead next (focused-searchBox semantics).
      const ta = focusedTa;
      if (ta && ta._open) {
        if (!ta._filtered) {
          const fm = (ta.filterMap || {})[ta._value];
          if (fm) {
            ta._rev = (ta._rev || 0) + 1; // page transitions through a cleared list — sig changes on a response
            if (fm.banner) { ta._banner = true; ta._texts = (ta.fallbackTexts || ta._texts || []).slice(); ta._filtered = true; }
            else if (fm.autoCommit) { ta.chips = [fm.autoCommit]; ta._open = false; ta._banner = false; }
            else if (fm.filtered) { ta._texts = fm.filtered.slice(); ta._banner = false; ta._filtered = true; }
          }
          // no filterMap entry → the page never responds (the stable pre-filter case)
        } else if (!ta.enterCommitFails && (ta._texts || []).length && !ta._banner) {
          ta.chips = [ta._texts[0]]; // commit-Enter takes the auto-highlighted FIRST option
          ta._open = false;
        }
        return;
      }
      const f = openField;
      if (!f || !f.open) return;
      if (f.enterFails) { f.open = false; return; }
      if (f.enterCommitsWrongIdx !== undefined) { f.triggerText = f.options[f.enterCommitsWrongIdx].text; f.open = false; return; }
      if (f.activeIdx != null) f.triggerText = f.options[f.activeIdx].text;
      f.open = false;
    },
    pressEscape: async () => {
      log.push(["pressEscape"]);
      if (focusedTa) focusedTa._open = false;
      if (focusedSrc) focusedSrc._open = false;
      if (openField) openField.open = false;
    },

    // ── source (backlog C) — filter-Enter only (commit is clickSourceLeaf) ──
    openSource: async (loc) => {
      log.push(["openSource", loc.wrapperSel]);
      const f = byLoc(loc);
      f._open = true;
      if (!f.focusUnconfirmable) f._focusedSb = true;
      if (f._leaves === undefined) f._leaves = (f.openLeaves || []).slice();
      if (f._banner === undefined) f._banner = false;
      focusedSrc = f;
      return true;
    },
    readSource: async (loc) => {
      const f = byLoc(loc);
      const leaves = f._open ? (f._leaves || []) : [];
      const sig = (f._rev || 0) + "|" + leaves.length + "|" + leaves.slice(0, 3).join("~");
      return {
        searchBox: { present: !!f._open, visible: !!f._open, focused: !!(f._open && f._focusedSb), value: f._value || "" },
        leaves, leafCount: leaves.length, sig,
        banner: !!(f._open && f._banner),
        chips: (f.chips || []).slice()
      };
    },
    focusSourceSearch: async (loc) => { log.push(["focusSourceSearch"]); const f = byLoc(loc); if (!f.focusUnconfirmable) f._focusedSb = true; focusedSrc = f; return true; },
    typeInSourceSearch: async (t) => { log.push(["typeInSourceSearch", t]); if (focusedSrc) { focusedSrc._value = t; focusedSrc._filtered = false; } },
    clearSourceSearch: async () => { log.push(["clearSourceSearch"]); if (focusedSrc) { focusedSrc._value = ""; focusedSrc._filtered = false; } },
    probeSourceLeaf: async (label) => {
      const f = focusedSrc;
      const found = !!(f && (f._leaves || []).includes(label));
      return { found, commitWrapper: { isSelectedValue: f && f._selectedLeaf === label ? "true" : "false" }, rect: { cx: 1, cy: 1, w: 10, h: 10 } };
    },
    clickSourceLeaf: async (label) => {
      log.push(["clickSourceLeaf", label]);
      const f = focusedSrc;
      if (!f || !(f._leaves || []).includes(label)) return false;
      if (f.clickCommitFails) return true;
      if (f.commitVia === "chip") f.chips = [label]; else f._selectedLeaf = label;
      return true;
    },

    // typeahead
    openTypeahead: async (loc) => {
      log.push(["openTypeahead", loc.wrapperSel]);
      const f = byLoc(loc);
      f._open = true;
      if (!f.focusUnconfirmable) f._focusedSb = true; // focusUnconfirmable: opens/visible but focus never confirms
      if (f._texts === undefined) f._texts = (f.openTexts || []).slice();
      if (f._banner === undefined) f._banner = false;
      focusedTa = f;
      return true;
    },
    focusSearchBox: async (loc) => {
      log.push(["focusSearchBox", loc.wrapperSel]);
      const f = byLoc(loc);
      if (!f.focusUnconfirmable) f._focusedSb = true;
      focusedTa = f;
      return true;
    },
    readTypeahead: async (loc) => {
      const f = byLoc(loc);
      const texts = f._open ? (f._texts || []) : [];
      const sig = (f._rev || 0) + "|" + texts.length + "|" + texts.slice(0, 3).join("~");
      return {
        searchBox: { present: !!f._open, visible: !!f._open, focused: !!(f._open && f._focusedSb), value: f._value || "" },
        chips: (f.chips || []).slice(),
        banner: f._open && f._banner ? { text: "No matches found", automationId: "promptTitle" } : null,
        pageWide: { count: texts.length, sig, sample: texts.slice(0, 10), texts: texts.slice(0, 40) },
        activeText: null
      };
    },
    typeInSearch: async (text) => {
      log.push(["typeInSearch", text]);
      if (focusedTa) { focusedTa._value = text; focusedTa._filtered = false; }
    },
    clearSearch: async () => {
      log.push(["clearSearch"]);
      if (focusedTa) { focusedTa._value = ""; focusedTa._filtered = false; }
      // stale banner + rendered list deliberately PERSIST (recon finding)
    },
    // Trusted-click commit fallback. Default: commits the named option (trusted
    // clicks work); flags: clickCommitFails (dispatched, page ignores it),
    // clickCommitsWrongText (mis-commit — the chip gate must catch it).
    clickTaOption: async (loc, text) => {
      log.push(["clickTaOption", text]);
      const f = byLoc(loc);
      if (!f._open || !(f._texts || []).some((t) => t === text)) return false; // option not visible
      if (f.clickCommitFails) return true; // click dispatched, nothing committed
      f.chips = [f.clickCommitsWrongText || text];
      f._open = false;
      return true;
    },
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

// ── deferred / unmapped widgets: honest records, ZERO actuation ──────────────

test("source with NO how_did_you_hear defaults → needs_review, ZERO actuation; unmapped typeahead → skipped", async () => {
  const act = makeFakeAct([
    { wrapperSel: "[w-src]", fieldName: "source", widgetType: "hierarchical", label: "How Did You Hear About Us?" },
    { wrapperSel: "[w-ta2]", fieldName: "mysteryPicker", widgetType: "typeahead", label: "Mystery", chips: [], filterMap: {} }
  ]);
  const out = await drivePageFill(act, nameProfile, {}, {}, T_BUDGETS); // defaults = {} → no hdyh
  assert.strictEqual(out.results[0].status, "needs_review");
  assert.match(out.results[0].detail, /no how_did_you_hear defaults/);
  assert.strictEqual(out.results[1].status, "skipped");
  assert.strictEqual(out.results[1].detail, "no mapping");
  assert.strictEqual(act.log.length, 0, "no-defaults source + unmapped widgets must never be actuated");
});

test("source WITH how_did_you_hear defaults → routes through fillSourceCdp and fills (drivePageFill)", async () => {
  const act = makeFakeAct([
    srcField({ wrapperSel: "[w-src]", filterMap: { LinkedIn: { autoCommit: "LinkedIn" } } })
  ]);
  const defaults = { how_did_you_hear: { preferred: ["LinkedIn"], fallback: "Other" } };
  const out = await drivePageFill(act, nameProfile, defaults, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "LinkedIn");
  assert.strictEqual(rec.verified, true);
  assert.deepStrictEqual(rec.resolved, ["LinkedIn", "Other"]); // candidates from defaults
});

// ── typeahead (M25 — the proven Magna brain on CDP; accuracy regression suite) ──
// This field type silently FALSE-FILLED before; these tests pin the guards.

const taField = (flags) => Object.assign({
  wrapperSel: "[w-ta]", fieldName: "countryPhoneCode", widgetType: "typeahead",
  label: "Country Phone Code*", chips: [], filterMap: {}
}, flags || {});
const taProfile = (candidates) => ({ personal_info: { country_phone_code: candidates } });
const enters = (act) => act.log.filter(([m]) => m === "pressEnter").length;

test("typeahead: banner hard-block — never commits from the fallback full list", async () => {
  // The fallback list rendered UNDER the banner CONTAINS the candidate's value —
  // the exact false-fill condition. The banner must block any pick.
  const act = makeFakeAct([taField({
    fallbackTexts: ["Afghanistan (+93)", "Albania (+355)", "United States of America (+1)"],
    filterMap: { "United States of America (+1)": { banner: true } }
  })]);
  const out = await drivePageFill(act, taProfile(["United States of America (+1)"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.after, null);
  assert.strictEqual(enters(act), 1, "only the filter-Enter — a commit-Enter must never fire on a banner");
});

test("typeahead: the stable pre-filter list is never matched (transition-aware settle)", async () => {
  // The list rendered at open contains a plausible value and the page never
  // responds to the filter — mere stability must NOT be treated as filtered.
  const act = makeFakeAct([taField({
    openTexts: ["Accounting", "United States of America (+1)", "Zoology"],
    filterMap: {}
  })]);
  const out = await drivePageFill(act, taProfile(["United States of America (+1)"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.after, null);
  assert.strictEqual(enters(act), 1, "no commit-Enter against a never-transitioned list");
});

test("typeahead: a stale banner does not block the next candidate", async () => {
  // cand-0 banners; the banner + list persist through the clear (recon).
  // cand-1's fresh filter must still settle and commit.
  const act = makeFakeAct([taField({
    fallbackTexts: ["Other", "Other Technology", "Electrical Engineering"],
    filterMap: {
      "Electrical and Computer Engineering": { banner: true },
      "Other": { filtered: ["Other", "Other Technology"] }
    }
  })]);
  const out = await drivePageFill(act, taProfile(["Electrical and Computer Engineering", "Other"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "Other");
  assert.strictEqual(rec.verified, true);
  assert.strictEqual(rec.settle_trace[1].staleBannerAtStart, true, "the stale banner was present when cand-1 started");
});

test("typeahead: per-candidate isolation — a later tier's value in the fallback list is never picked early", async () => {
  // The Magna contamination shape: cand-0 banners while the visible fallback
  // list contains cand-1's value ("Other"). It must be committed only from
  // cand-1's OWN filtered set, never scraped during cand-0.
  const act = makeFakeAct([taField({
    fallbackTexts: ["Accounting", "Other", "Electrical Engineering"],
    filterMap: {
      "Electrical and Computer Engineering": { banner: true },
      "Other": { filtered: ["Other", "Other Technology"] }
    }
  })]);
  const out = await drivePageFill(act, taProfile(["Electrical and Computer Engineering", "Other"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.after, "Other");
  const typed = act.log.filter(([m]) => m === "typeInSearch").map(([, t]) => t);
  assert.deepStrictEqual(typed, ["Electrical and Computer Engineering", "Other"]);
  assert.strictEqual(enters(act), 3, "cand-0: filter-Enter only (banner); cand-1: filter-Enter + commit-Enter");
});

test("typeahead: single exact match auto-commits on the filter-Enter; chip verified", async () => {
  const act = makeFakeAct([taField({
    filterMap: { "United States of America (+1)": { autoCommit: "United States of America (+1)" } }
  })]);
  const out = await drivePageFill(act, taProfile(["United States of America (+1)", "United States of America"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.matchTier, "enter-auto-commit");
  assert.strictEqual(rec.verified, true);
  assert.strictEqual(enters(act), 1);
});

test("typeahead: an auto-commit chip that mismatches the candidate is NEVER reported filled", async () => {
  const act = makeFakeAct([taField({
    filterMap: { "United States of America (+1)": { autoCommit: "Canada (+1)" } }
  })]);
  const out = await drivePageFill(act, taProfile(["United States of America (+1)", "United States of America"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.after, "Canada (+1)"); // surfaced, not accepted
  assert.strictEqual(rec.verified, false);
  const typed = act.log.filter(([m]) => m === "typeInSearch").map(([, t]) => t);
  assert.deepStrictEqual(typed, ["United States of America (+1)"], "walk stops — a chip exists; more typing contaminates");
});

test("typeahead: commit-Enter fires only when the match is the FIRST filtered option", async () => {
  // exact match at index 1 → no commit-Enter (highlight is unreadable; never blind)
  let act = makeFakeAct([taField({ filterMap: { "Other": { filtered: ["Other Technology", "Other"] } } })]);
  let out = await drivePageFill(act, taProfile(["Other"]), {}, {}, T_BUDGETS);
  assert.strictEqual(out.results[0].status, "needs_review");
  assert.strictEqual(enters(act), 1);
  // exact match at index 0 → commit
  act = makeFakeAct([taField({ filterMap: { "Other": { filtered: ["Other", "Other Technology"] } } })]);
  out = await drivePageFill(act, taProfile(["Other"]), {}, {}, T_BUDGETS);
  assert.strictEqual(out.results[0].status, "filled");
  assert.strictEqual(out.results[0].after, "Other");
  assert.strictEqual(out.results[0].verified, true);
});

test("typeahead: no chip within budget → needs_review, never a silent fill", async () => {
  // Total commit failure: the Enter no-ops AND the click fallback is ignored.
  const act = makeFakeAct([taField({
    enterCommitFails: true, clickCommitFails: true,
    filterMap: { "Other": { filtered: ["Other", "Other Technology"] } }
  })]);
  const out = await drivePageFill(act, taProfile(["Other"]), {}, {}, T_BUDGETS);
  assert.strictEqual(out.results[0].status, "needs_review");
  assert.strictEqual(out.results[0].verified, false);
});

test("typeahead: Enter-commit fails → trusted click commits the matched option (chip verified)", async () => {
  // The live 2026-06-12 shape: no armed highlight, the commit-Enter no-ops —
  // the click fallback must carry tier-1 instead of losing it to a lower tier.
  const act = makeFakeAct([taField({
    enterCommitFails: true,
    filterMap: { "Other": { filtered: ["Other", "Other Technology"] } }
  })]);
  const out = await drivePageFill(act, taProfile(["Other", "engineering"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "Other");
  assert.strictEqual(rec.verified, true);
  assert.match(rec.detail, /click-commit/);
  assert.ok(act.log.some(([m]) => m === "clickTaOption"));
});

test("typeahead: click commits the WRONG option → chip mismatch → needs_review, walk stops", async () => {
  const act = makeFakeAct([taField({
    enterCommitFails: true, clickCommitsWrongText: "Other Technology",
    filterMap: { "Other": { filtered: ["Other", "Other Technology"] } }
  })]);
  const out = await drivePageFill(act, taProfile(["Other", "engineering"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.after, "Other Technology"); // surfaced, never accepted
  assert.strictEqual(rec.verified, false);
  const typed = act.log.filter(([m]) => m === "typeInSearch").map(([, t]) => t);
  assert.deepStrictEqual(typed, ["Other"], "walk stops — a chip exists; more typing contaminates");
});

test("typeahead: Enter and click both fail → next candidate carries, never a silent fill", async () => {
  const act = makeFakeAct([taField({
    enterCommitFails: true, clickCommitFails: true,
    filterMap: {
      "Other": { filtered: ["Other", "Other Technology"] },
      "engineering": { autoCommit: "Engineering" }
    }
  })]);
  const out = await drivePageFill(act, taProfile(["Other", "engineering"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "Engineering"); // tier-2 carried after tier-1's commit failed
  assert.strictEqual(rec.matchTier, "enter-auto-commit");
  assert.strictEqual(rec.settle_trace[0].note, "no chip from commit-Enter or click — commit did not take");
});

test("countryPhoneCode pre-filled-correct → kept with ZERO actuation calls", async () => {
  // Workday auto-derives the phone code from Country, so an already-correct
  // chip is the common case. The failure mode is "verifying" it by re-typing —
  // duplicating or clearing a correct chip. ZERO actuation allowed.
  const act = makeFakeAct([taField({ chips: ["United States of America (+1)"] })]);
  const out = await drivePageFill(act, taProfile(["United States of America (+1)", "United States of America", "United States"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.matchTier, "pre-filled");
  assert.strictEqual(rec.after, "United States of America (+1)");
  assert.strictEqual(rec.verified, true);
  assert.strictEqual(act.log.length, 0, "pre-filled-correct must not be touched");
});

test("typeahead: pre-filled chip matching no candidate → needs_review, zero actuation", async () => {
  const act = makeFakeAct([taField({ chips: ["Canada (+1)"] })]);
  const out = await drivePageFill(act, taProfile(["United States of America (+1)"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.after, "Canada (+1)");
  assert.strictEqual(act.log.length, 0, "a mismatched pre-fill is flagged, never overwritten");
});

test("typeahead: first candidate to commit wins — later candidates never typed", async () => {
  const act = makeFakeAct([taField({
    filterMap: { "United States of America (+1)": { autoCommit: "United States of America (+1)" } }
  })]);
  const out = await drivePageFill(act, taProfile(["United States of America (+1)", "United States of America"]), {}, {}, T_BUDGETS);
  assert.strictEqual(out.results[0].status, "filled");
  const typed = act.log.filter(([m]) => m === "typeInSearch").map(([, t]) => t);
  assert.deepStrictEqual(typed, ["United States of America (+1)"]);
});

// ── focus hygiene (M25 leak fix) — the abort guard closes the bug CLASS ──────
// A banner drops searchBox focus; without re-asserting + verifying focus, the
// next candidate's Ctrl+A hits the page, the query never lands, and a bare
// Enter commits the listbox's highlighted row (the stray "Afghanistan" commit).

test("typeahead: searchBox focus cannot be confirmed → ZERO actuation, needs_review", async () => {
  const act = makeFakeAct([taField({ focusUnconfirmable: true })]);
  const out = await drivePageFill(act, taProfile(["United States of America (+1)"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.match(rec.detail, /could not focus the search field/);
  // The whole point: NO blind Ctrl+A / type / Enter when focus isn't confirmed.
  assert.ok(!act.log.some(([m]) => m === "clearSearch"), "no Ctrl+A clear");
  assert.ok(!act.log.some(([m]) => m === "typeInSearch"), "no typing");
  assert.ok(!act.log.some(([m]) => m === "pressEnter"), "no Enter");
});

// ── source picker (backlog C — the Magna SEARCH shape; mirrors the typeahead walk) ──

const srcField = (flags) => Object.assign({
  wrapperSel: "[w-src]", fieldName: "source", widgetType: "hierarchical", chips: [], filterMap: {}
}, flags || {});
const runSource = (field, candidates) => {
  const act = makeFakeAct([field]);
  return fillSourceCdp(act, { wrapperSel: field.wrapperSel }, candidates, T_BUDGETS).then((rec) => ({ rec, act }));
};

test("source: single exact match auto-commits on the filter-Enter; chip verified", async () => {
  const { rec } = await runSource(srcField({ filterMap: { LinkedIn: { autoCommit: "LinkedIn" } } }), ["LinkedIn", "Other"]);
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "LinkedIn");
  assert.strictEqual(rec.matchTier, "enter-auto-commit");
  assert.strictEqual(rec.verified, true);
});

test("source: multi-match → trusted leaf-click, verified via promptLeafNode isselected", async () => {
  const { rec, act } = await runSource(srcField({ commitVia: "leaf", filterMap: { LinkedIn: { filtered: ["LinkedIn", "LinkedIn Learning"] } } }), ["LinkedIn"]);
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "LinkedIn");
  assert.strictEqual(rec.verified, true);
  assert.match(rec.detail, /promptLeafNode-isselected/);
  assert.ok(act.log.some(([m]) => m === "clickSourceLeaf"));
});

test("source: commit verified via selectedItem chip", async () => {
  const { rec } = await runSource(srcField({ commitVia: "chip", filterMap: { LinkedIn: { filtered: ["LinkedIn", "LinkedIn Learning"] } } }), ["LinkedIn"]);
  assert.strictEqual(rec.status, "filled");
  assert.match(rec.detail, /selectedItem-chip/);
  assert.strictEqual(rec.verified, true);
});

test("source: banner on tier-0 → walks to tier-1 and commits", async () => {
  const { rec } = await runSource(srcField({
    commitVia: "leaf", fallbackLeaves: ["Other"],
    filterMap: { LinkedIn: { banner: true }, Other: { filtered: ["Other"] } }
  }), ["LinkedIn", "Other"]);
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "Other");
});

test("source: no candidate in its filtered set → needs_review", async () => {
  const { rec } = await runSource(srcField({ filterMap: { LinkedIn: { filtered: ["Facebook", "Twitter"] } } }), ["LinkedIn"]);
  assert.strictEqual(rec.status, "needs_review");
  assert.match(rec.detail, /no source candidate/);
});

test("source: matched leaf but commit click fails → needs_review, never false-filled", async () => {
  const { rec } = await runSource(srcField({ clickCommitFails: true, commitVia: "leaf", filterMap: { LinkedIn: { filtered: ["LinkedIn", "LinkedIn Learning"] } } }), ["LinkedIn"]);
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.verified, false);
});

test("source: searchBox focus cannot be confirmed → ZERO actuation, needs_review", async () => {
  const { rec, act } = await runSource(srcField({ focusUnconfirmable: true, filterMap: { LinkedIn: { autoCommit: "LinkedIn" } } }), ["LinkedIn"]);
  assert.strictEqual(rec.status, "needs_review");
  assert.match(rec.detail, /could not focus the source search field/);
  assert.ok(!act.log.some(([m]) => m === "clearSourceSearch"), "no clear");
  assert.ok(!act.log.some(([m]) => m === "typeInSourceSearch"), "no typing");
  assert.ok(!act.log.some(([m]) => m === "pressEnter"), "no Enter");
  assert.ok(!act.log.some(([m]) => m === "clickSourceLeaf"), "no leaf click");
});

test("source: pre-filled chip matching a candidate → kept with ZERO actuation", async () => {
  const { rec, act } = await runSource(srcField({ chips: ["LinkedIn"] }), ["LinkedIn", "Other"]);
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.matchTier, "pre-filled");
  assert.strictEqual(act.log.length, 0, "pre-filled-correct source must not be touched");
});

test("typeahead: walk-dry but a stray chip is present → record reports it, never after:null", async () => {
  // No candidate matches (banner), but a stray chip sits on the field at
  // walk-end (a late highlight-Enter commit our settle missed). The honesty
  // read must surface it instead of claiming the field is empty.
  const act = makeFakeAct([taField({
    fallbackTexts: ["Afghanistan (+93)"],
    filterMap: { "United States of America (+1)": { banner: true } }
  })]);
  // The stray exists only at walk-END (the honesty read happens after Escape):
  // flip a flag in pressEscape, inject the chip on reads after it.
  const origRead = act.readTypeahead, origEsc = act.pressEscape;
  let walkEnded = false;
  act.pressEscape = async (...a) => { walkEnded = true; return origEsc(...a); };
  act.readTypeahead = async (loc) => {
    const st = await origRead(loc);
    if (walkEnded) st.chips = ["Afghanistan (+93)"];
    return st;
  };
  const out = await drivePageFill(act, taProfile(["United States of America (+1)"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.after, "Afghanistan (+93)"); // surfaced, NOT null
  assert.match(rec.detail, /uncommanded value on the field/);
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
