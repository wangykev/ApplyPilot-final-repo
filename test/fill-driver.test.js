// Unit tests for fill-driver.js — the substrate-agnostic CDP fill brain — driven
// by a FAKE actuation (the substrate-swap hedge made testable). The fake logs
// every actuation call so tests can assert not just outcomes but that deferred
// widgets are NEVER actuated and unverified commits are NEVER pressed.
const { test } = require("node:test");
const assert = require("node:assert");
const { drivePageFill, fillSourceCdp, commitOutcome, driveRepeatingSectionCdp, WEBSITE_MAP, LANGUAGE_MAP, fillDateCompositeCdp } = require("../fill-driver.js");

// Tiny budgets: success paths settle on the first reads; failure-path polls
// spin only for a few ms of wall clock.
const T_BUDGETS = {
  openCeilingMs: 60, settleIntervalMs: 1, stableReads: 2,
  commitCeilingMs: 25, commitIntervalMs: 1,
  textReadDelayMs: 1, typeJumpDelayMs: 1, arrowStepMs: 1, maxArrowSteps: 60,
  interFieldMs: 0,
  taOpenCeilingMs: 50, taOpenIntervalMs: 1, taActionSettleMs: 1,
  taSettleCeilingMs: 60, taSettleIntervalMs: 1, taEnterCommitCeilingMs: 25,
  entryReconcileCeilingMs: 40, entryReconcileIntervalMs: 1
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
            // residualChipAfterCommit: simulate a tenant that ADDS a chip instead of
            // REPLACING (recon = REPLACE on Magna; this drives the defensive assertion).
            else if (fm.autoCommit) { ta.chips = ta.residualChipAfterCommit ? (ta.chips || []).concat([fm.autoCommit]) : [fm.autoCommit]; ta._open = false; ta._banner = false; }
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
    // M28: text-keyed dropdown option click. clickDismisses = click dispatched but
    // nothing commits (the Uruguay out-of-view shape) — trigger stays unchanged.
    clickDropdownOptionByText: async (loc, text) => {
      log.push(["clickDropdownOptionByText", text]);
      const f = byLoc(loc);
      if (f.clickDismisses) return true;
      const o = (f.options || []).find((x) => !x.disabled && x.text === text);
      if (!o) return false;
      f.triggerText = o.text;
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

test("dropdown: commits the matched option via TEXT-keyed click (no type-jump, no arrow-walk)", async () => {
  const act = makeFakeAct([ddField()]);
  const out = await drivePageFill(act, usProfile, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "United States of America");
  assert.match(rec.detail, /text-click-commit/);
  assert.ok(act.log.some(([m]) => m === "clickDropdownOptionByText"), "committed by text-keyed click");
  assert.ok(!act.log.some(([m]) => m === "typeJumpChars"), "no type-jump");
  assert.ok(!act.log.some(([m]) => m === "arrowStep"), "no arrow-walk (no step counting)");
});

test("dropdown: M28 — starting on a same-first-letter value still commits (no type-jump cycling)", async () => {
  // The live bug: dropdown already on a U-item ("Uruguay" here; "United Arab Emirates"
  // live) → native type-jump cycled to the next U, then errored. Text-keyed click is
  // immune to the starting selection.
  const act = makeFakeAct([ddField({ triggerText: "Uruguay" })]);
  const out = await drivePageFill(act, usProfile, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "United States of America");
  assert.ok(!act.log.some(([m]) => m === "typeJumpChars"), "no type-jump from a same-prefix start");
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

test("dropdown: click dispatched but nothing commits → needs_review, never a silent/wrong fill", async () => {
  const [rec] = await run([ddField({ clickDismisses: true })], usProfile, {});
  assert.strictEqual(rec.status, "needs_review");
  assert.match(rec.detail, /commit failed/);
  assert.strictEqual(rec.after, "Select One"); // unchanged trigger surfaced, not accepted
});

test("dropdown: trigger already matches a candidate → filled / dropdown-prefilled-kept, NO re-open (M27 Commit C)", async () => {
  const act = makeFakeAct([ddField({ triggerText: "United States of America" })]);
  const out = await drivePageFill(act, usProfile, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.matchTier, "pre-filled");
  assert.strictEqual(rec.flag, "dropdown-prefilled-kept");
  assert.strictEqual(rec.confidence, "high");
  assert.strictEqual(rec.after, "United States of America");
  assert.ok(!act.log.some(([m]) => m === "openDropdown"), "a matching dropdown is not re-opened");
});

test("dropdown: 'Select One' placeholder does NOT trigger keep — falls through to the verified fill", async () => {
  const act = makeFakeAct([ddField()]); // default triggerText "Select One"
  const out = await drivePageFill(act, usProfile, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "United States of America");
  assert.ok(act.log.some(([m]) => m === "openDropdown"), "placeholder dropdown must still open + fill");
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

// ── M30 session-expiry early-warning (heuristic, SOURCE-only) ────────────────
// A NOTE never a halt; fires only when the source options NEVER load (dead-session
// tell), NOT on a matching miss (the false-positive guard).

test("M30 session warning: source options NEVER load → out.sessionWarning set", async () => {
  const act = makeFakeAct([srcField({ wrapperSel: "[w-src]", filterMap: { LinkedIn: { banner: true }, Other: { banner: true } } })]);
  const defaults = { how_did_you_hear: { preferred: ["LinkedIn"], fallback: "Other" } };
  const out = await drivePageFill(act, nameProfile, defaults, {}, T_BUDGETS);
  assert.strictEqual(out.results[0].status, "needs_review");
  assert.strictEqual(out.results[0].optionsLoaded, false, "leaves never rendered");
  assert.ok(out.sessionWarning, "a likely-expired-session warning is raised");
  assert.match(out.sessionWarning, /session expired/i);
});

test("M30 session warning: source loaded-but-no-match → NO warning (false-positive guard)", async () => {
  // Leaves DO render; the candidate just isn't among them — a matching miss, not a
  // dead session. The most important guard: it must NOT misfire.
  const act = makeFakeAct([srcField({ wrapperSel: "[w-src]", filterMap: { LinkedIn: { filtered: ["Facebook", "Twitter"] } } })]);
  const defaults = { how_did_you_hear: { preferred: ["LinkedIn"] } };
  const out = await drivePageFill(act, nameProfile, defaults, {}, T_BUDGETS);
  assert.strictEqual(out.results[0].status, "needs_review");
  assert.strictEqual(out.results[0].optionsLoaded, true, "leaves rendered");
  assert.strictEqual(out.sessionWarning, null, "a matching miss is NOT a session warning");
});

test("M30 session warning: source commits normally → NO warning", async () => {
  const act = makeFakeAct([srcField({ wrapperSel: "[w-src]", filterMap: { LinkedIn: { autoCommit: "LinkedIn" } } })]);
  const defaults = { how_did_you_hear: { preferred: ["LinkedIn"] } };
  const out = await drivePageFill(act, nameProfile, defaults, {}, T_BUDGETS);
  assert.strictEqual(out.results[0].status, "filled");
  assert.strictEqual(out.sessionWarning, null);
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
  assert.strictEqual(rec.flag, "prefilled-kept");
  assert.strictEqual(rec.after, "United States of America (+1)");
  assert.strictEqual(rec.verified, true);
  assert.strictEqual(act.log.length, 0, "pre-filled-correct must not be touched (no overwrite actuation)");
});

// ── M27 Commit B: non-destructive overwrite of a mismatched pre-fill ─────────
// (Replaces the old "left as-is, zero actuation" pinned test — a mismatched
// pre-fill now ACTUATES: search-while-populated, commit REPLACES, no-match keeps
// the original. The behavior change is intentional and sanctioned by M27.)

test("overwrite: mismatched pre-fill + matching candidate → filled_review / overwrite-success, original recorded, single chip (REPLACE)", async () => {
  const field = taField({ chips: ["Canada (+1)"], filterMap: { "United States of America (+1)": { autoCommit: "United States of America (+1)" } } });
  const act = makeFakeAct([field]);
  const out = await drivePageFill(act, taProfile(["United States of America (+1)"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled_review");
  assert.strictEqual(rec.flag, "overwrite-success");
  assert.strictEqual(rec.confidence, "high");
  assert.strictEqual(rec.after, "United States of America (+1)");
  assert.deepStrictEqual(rec.overwrite, { original: "Canada (+1)", refilled: true });
  assert.deepStrictEqual(field.chips, ["United States of America (+1)"], "REPLACE — exactly one chip, the new value");
});

test("overwrite: no candidate matches → needs_review / overwrite-nomatch-original-kept, ORIGINAL preserved + resting {chips:[original], query:''}", async () => {
  const field = taField({ chips: ["Canada (+1)"], filterMap: { "United States of America (+1)": { banner: true } } });
  const act = makeFakeAct([field]);
  const out = await drivePageFill(act, taProfile(["United States of America (+1)"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.flag, "overwrite-nomatch-original-kept");
  assert.strictEqual(rec.after, "Canada (+1)");                          // the original, NOT empty
  assert.deepStrictEqual(rec.overwrite, { original: "Canada (+1)", refilled: false });
  assert.deepStrictEqual(field.chips, ["Canada (+1)"], "original chip NEVER destroyed on a no-match");
  assert.strictEqual(field._value, "", "leftover filter text cleared — field rests clean");
});

test("overwrite: a different value commits (stray) → needs_review / overwrite-stray, original recorded", async () => {
  const field = taField({ chips: ["Canada (+1)"], filterMap: { "United States of America (+1)": { autoCommit: "Mexico (+52)" } } });
  const act = makeFakeAct([field]);
  const out = await drivePageFill(act, taProfile(["United States of America (+1)"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.flag, "overwrite-stray");
  assert.strictEqual(rec.after, "Mexico (+52)");
  assert.deepStrictEqual(rec.overwrite, { original: "Canada (+1)", refilled: false });
});

test("overwrite: a residual second chip (tenant ADDED, not REPLACED) → needs_review / overwrite-residual-flagged", async () => {
  const field = taField({ chips: ["Canada (+1)"], residualChipAfterCommit: true, filterMap: { "United States of America (+1)": { autoCommit: "United States of America (+1)" } } });
  const act = makeFakeAct([field]);
  const out = await drivePageFill(act, taProfile(["United States of America (+1)"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.flag, "overwrite-residual-flagged");
  assert.ok(field.chips.length > 1, "two chips present — a two-value state is never silently accepted");
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

// ── M36.1 tier-aware pre-filled guard ────────────────────────────────────────
// A pre-fill matching a LOWER tier was kept priority-blind (the live fieldOfStudy
// bug: a stale tier-3 "electrical engineering" kept over the reordered tier-1
// "Other"). Now: tier 0 → keep, ZERO actuation (countryPhoneCode auto-derive);
// tier k>0 → walk only the HIGHER tiers and overwrite to the BEST offered, keeping
// the pre-fill if none is offered; tier -1 → full overwrite walk (unchanged).
const taTypedQueries = (act) => act.log.filter(([m]) => m === "typeInSearch").map(([, t]) => t);

test('INVARIANT (M36.1): a tier-0 pre-fill is KEPT with ZERO actuation — countryPhoneCode auto-derive is never re-typed', async () => {
  // The chip carries the (+1) suffix; normalize() strips it, so it is tier 0 vs the
  // tiered candidate list — keep, no open/clear/type/Enter.
  const act = makeFakeAct([taField({ chips: ["United States of America (+1)"] })]);
  const out = await drivePageFill(act, taProfile(["United States of America (+1)", "United States of America", "United States"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.flag, "prefilled-kept");
  assert.strictEqual(rec.after, "United States of America (+1)");
  assert.strictEqual(act.log.length, 0, "a tier-0 (top) pre-fill must never be actuated");
});

test("M36.1 typeahead k>0: upgrades to the HIGHEST offered tier (best-available, not first-that-lands)", async () => {
  // The live fieldOfStudy reorder: pre-fill = tier-3 "electrical engineering"; tier-1
  // "Other" AND tier-2 "computer engineering" are BOTH offered; tier-0 is NOT. Must
  // upgrade to tier-1 "Other" (the highest offered) — NOT tier-2.
  const field = taField({
    chips: ["electrical engineering"],
    filterMap: {
      "Electrical and Computer Engineering": { banner: true },   // tier 0 — not offered
      "Other": { autoCommit: "Other" },                          // tier 1 — offered
      "computer engineering": { autoCommit: "computer engineering" } // tier 2 — also offered
    }
  });
  const act = makeFakeAct([field]);
  const out = await drivePageFill(act, taProfile(["Electrical and Computer Engineering", "Other", "computer engineering", "electrical engineering"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled_review");
  assert.strictEqual(rec.flag, "overwrite-success");
  assert.strictEqual(rec.after, "Other", "the HIGHEST offered tier, NOT tier-2 'computer engineering'");
  assert.deepStrictEqual(rec.overwrite, { original: "electrical engineering", refilled: true });
  // priority order proven: tried tier-0 then tier-1, STOPPED (tier-2 never typed); the
  // pre-fill's own tier-3 is NEVER re-searched.
  assert.deepStrictEqual(taTypedQueries(act), ["Electrical and Computer Engineering", "Other"]);
});

test("M36.1 typeahead k>0: nothing higher offered → KEEP the pre-fill (prefilled-better-tier-unavailable) — NOT zero-actuation", async () => {
  // Pre-fill = tier-1 "Other"; the only higher tier (tier-0) is NOT offered → "Other"
  // is the best available → kept, flagged. It DID actuate (searched tier-0).
  const field = taField({
    chips: ["Other"],
    filterMap: { "Electrical and Computer Engineering": { banner: true } } // tier 0 not offered
  });
  const act = makeFakeAct([field]);
  const out = await drivePageFill(act, taProfile(["Electrical and Computer Engineering", "Other", "computer engineering"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.flag, "prefilled-better-tier-unavailable");
  assert.strictEqual(rec.after, "Other", "the pre-fill (best available tier) is kept");
  assert.deepStrictEqual(field.chips, ["Other"], "chip unchanged — never re-committed");
  assert.deepStrictEqual(taTypedQueries(act), ["Electrical and Computer Engineering"], "DID search the higher tier (not zero-actuation); never re-searched its own tier");
});

test("M36.1 typeahead k===-1: a mismatched pre-fill walks the FULL list (down to the last tier) — unchanged from M27", async () => {
  // Pre-fill matches NO candidate → genuine mismatch → full overwrite walk; only the
  // LAST tier is offered, and it commits — proving the full list is in scope (unlike
  // k>0, which excludes the pre-fill's tier and below).
  const field = taField({
    chips: ["Mechanical Engineering"], // not in the candidate list
    filterMap: {
      "Electrical and Computer Engineering": { banner: true }, // tier 0
      "computer engineering": { banner: true },                // tier 1
      "Other": { autoCommit: "Other" }                         // tier 2 (last) — offered
    }
  });
  const act = makeFakeAct([field]);
  const out = await drivePageFill(act, taProfile(["Electrical and Computer Engineering", "computer engineering", "Other"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled_review");
  assert.strictEqual(rec.flag, "overwrite-success");
  assert.strictEqual(rec.after, "Other");
  assert.deepStrictEqual(rec.overwrite, { original: "Mechanical Engineering", refilled: true });
  assert.deepStrictEqual(taTypedQueries(act), ["Electrical and Computer Engineering", "computer engineering", "Other"], "full list walked incl. the last tier");
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

// ── M27 flag taxonomy (Commit A) ────────────────────────────────────────────
// flag = provenance, confidence = match quality (orthogonal); both from ONE table.

test("M27 commitOutcome table: (overwrite?, commitKind, matchTier) → (status, confidence, flag)", () => {
  // empty-field, auto
  assert.deepStrictEqual(commitOutcome(false, "auto", "exact-normalized"), { status: "filled", confidence: "high", flag: "autocommit-exact" });
  assert.deepStrictEqual(commitOutcome(false, "auto", "containment"), { status: "filled_review", confidence: "low", flag: "autocommit-containment" });
  assert.deepStrictEqual(commitOutcome(false, "auto", "fuzzy-93"), { status: "filled_review", confidence: "low", flag: "autocommit-fuzzy" });
  assert.deepStrictEqual(commitOutcome(false, "auto", null), { status: "needs_review", confidence: "none", flag: "autocommit-stray" });
  // empty-field, directed
  assert.deepStrictEqual(commitOutcome(false, "directed", "exact-normalized"), { status: "filled", confidence: "high", flag: "directed-exact" });
  assert.deepStrictEqual(commitOutcome(false, "directed", "containment"), { status: "filled_review", confidence: "low", flag: "directed-containment" });
  assert.deepStrictEqual(commitOutcome(false, "directed", "fuzzy-90"), { status: "filled_review", confidence: "low", flag: "directed-fuzzy" });
  // overwrite: flag is ALWAYS overwrite-success regardless of commitKind/tier; confidence tracks tier
  assert.deepStrictEqual(commitOutcome(true, "auto", "exact-normalized"), { status: "filled_review", confidence: "high", flag: "overwrite-success" });
  assert.deepStrictEqual(commitOutcome(true, "directed", "containment"), { status: "filled_review", confidence: "low", flag: "overwrite-success" });
  assert.deepStrictEqual(commitOutcome(true, "auto", "fuzzy-91"), { status: "filled_review", confidence: "low", flag: "overwrite-success" });
  assert.deepStrictEqual(commitOutcome(true, "directed", null), { status: "needs_review", confidence: "none", flag: "overwrite-stray" });
  // precedence invariant: NO autocommit-*/directed-* flag ever fires under overwrite
  for (const ck of ["auto", "directed"]) for (const t of ["exact-normalized", "containment", "fuzzy-95", null]) {
    const flag = commitOutcome(true, ck, t).flag;
    assert.ok(flag === "overwrite-success" || flag === "overwrite-stray", `overwrite flag must be overwrite-*, got "${flag}"`);
  }
});

test("typeahead: exact auto-commit → filled, autocommit-exact, high confidence", async () => {
  const act = makeFakeAct([taField({ filterMap: { "United States of America (+1)": { autoCommit: "United States of America (+1)" } } })]);
  const out = await drivePageFill(act, taProfile(["United States of America (+1)"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.flag, "autocommit-exact");
  assert.strictEqual(rec.confidence, "high");
  assert.strictEqual(rec.matchTier, "enter-auto-commit"); // commit-path preserved
});

test("typeahead: containment auto-commit → filled_review + autocommit-containment, low confidence", async () => {
  // Candidate "United States"; Workday auto-commits the fuller "United States of America (+1)".
  const act = makeFakeAct([taField({ filterMap: { "United States": { autoCommit: "United States of America (+1)" } } })]);
  const out = await drivePageFill(act, taProfile(["United States"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled_review");
  assert.strictEqual(rec.flag, "autocommit-containment");
  assert.strictEqual(rec.confidence, "low");
  assert.strictEqual(rec.after, "United States of America (+1)"); // value kept, not cleared
  assert.strictEqual(rec.verified, true);
});

test("typeahead: fuzzy auto-commit → filled_review + autocommit-fuzzy, low (kept, never silently filled)", async () => {
  // A typo'd auto-commit ("Engineerng" for "Engineering") — fuzzy >=90, not containment.
  const act = makeFakeAct([taField({ filterMap: { "Engineering": { autoCommit: "Engineerng" } } })]);
  const out = await drivePageFill(act, taProfile(["Engineering"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled_review");
  assert.strictEqual(rec.flag, "autocommit-fuzzy");
  assert.strictEqual(rec.confidence, "low");
  assert.strictEqual(rec.after, "Engineerng");
});

test("typeahead: stray auto-commit (no match) → needs_review + autocommit-stray, value recorded", async () => {
  const act = makeFakeAct([taField({ filterMap: { "United States of America (+1)": { autoCommit: "Canada (+1)" } } })]);
  const out = await drivePageFill(act, taProfile(["United States of America (+1)"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.flag, "autocommit-stray");
  assert.strictEqual(rec.confidence, "none");
  assert.strictEqual(rec.after, "Canada (+1)"); // surfaced, not accepted
  assert.strictEqual(rec.verified, false);
});

test("typeahead: directed containment commit → filled_review + directed-containment", async () => {
  // candidate "United States" filters to the fuller option at index 0 (containment) → directed commit.
  const act = makeFakeAct([taField({ filterMap: { "United States": { filtered: ["United States of America (+1)", "United States Minor Outlying Islands"] } } })]);
  const out = await drivePageFill(act, taProfile(["United States"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled_review");
  assert.strictEqual(rec.flag, "directed-containment");
  assert.strictEqual(rec.confidence, "low");
  assert.strictEqual(rec.after, "United States of America (+1)");
  assert.strictEqual(rec.matchTier, "enter-commit"); // commit-path, not the match tier
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
  assert.strictEqual(rec.flag, "prefilled-kept");
  assert.strictEqual(act.log.length, 0, "pre-filled-correct source must not be touched");
});

test("source overwrite: mismatched pre-fill + matching candidate → filled_review / overwrite-success (lockstep with typeahead)", async () => {
  const field = srcField({ chips: ["Family"], filterMap: { LinkedIn: { autoCommit: "LinkedIn" } } });
  const { rec } = await runSource(field, ["LinkedIn"]);
  assert.strictEqual(rec.status, "filled_review");
  assert.strictEqual(rec.flag, "overwrite-success");
  assert.strictEqual(rec.after, "LinkedIn");
  assert.deepStrictEqual(rec.overwrite, { original: "Family", refilled: true });
  assert.deepStrictEqual(field.chips, ["LinkedIn"]);
});

test("source overwrite: no candidate matches → needs_review / overwrite-nomatch-original-kept, original preserved + resting", async () => {
  const field = srcField({ chips: ["Family"], filterMap: { LinkedIn: { banner: true } } });
  const { rec } = await runSource(field, ["LinkedIn"]);
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.flag, "overwrite-nomatch-original-kept");
  assert.strictEqual(rec.after, "Family");
  assert.deepStrictEqual(field.chips, ["Family"], "original source chip never destroyed");
  assert.strictEqual(field._value, "", "leftover source filter text cleared");
});

// M36.1 tier-aware pre-filled guard — source, in LOCKSTEP with the typeahead tests above.
const srcTypedQueries = (act) => act.log.filter(([m]) => m === "typeInSourceSearch").map(([, t]) => t);

test("M36.1 source k>0: upgrades to the HIGHEST offered tier (lockstep)", async () => {
  // Pre-fill = tier-2 "Friend"; tier-0 "LinkedIn" AND tier-1 "Other" both offered →
  // upgrade to tier-0 "LinkedIn" (the highest), STOP (tier-1 never tried).
  const field = srcField({ chips: ["Friend"], filterMap: { LinkedIn: { autoCommit: "LinkedIn" }, Other: { autoCommit: "Other" } } });
  const { rec, act } = await runSource(field, ["LinkedIn", "Other", "Friend"]);
  assert.strictEqual(rec.status, "filled_review");
  assert.strictEqual(rec.flag, "overwrite-success");
  assert.strictEqual(rec.after, "LinkedIn", "the HIGHEST offered tier, NOT tier-1 'Other'");
  assert.deepStrictEqual(rec.overwrite, { original: "Friend", refilled: true });
  assert.deepStrictEqual(srcTypedQueries(act), ["LinkedIn"], "stopped at the highest offered; tier-1/own tier never searched");
});

test("M36.1 source k>0: nothing higher offered → KEEP the pre-fill (prefilled-better-tier-unavailable), DID actuate (lockstep)", async () => {
  const field = srcField({ chips: ["Other"], filterMap: { LinkedIn: { banner: true } } }); // tier-0 not offered
  const { rec, act } = await runSource(field, ["LinkedIn", "Other"]);
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.flag, "prefilled-better-tier-unavailable");
  assert.strictEqual(rec.after, "Other", "the pre-fill (best available tier) is kept");
  assert.deepStrictEqual(field.chips, ["Other"], "chip unchanged — never re-committed");
  assert.deepStrictEqual(srcTypedQueries(act), ["LinkedIn"], "DID search the higher tier (not zero-actuation)");
});

test("source: containment auto-commit → filled_review + autocommit-containment (lockstep with typeahead)", async () => {
  const { rec } = await runSource(srcField({ filterMap: { "LinkedIn": { autoCommit: "LinkedIn Corporation" } } }), ["LinkedIn"]);
  assert.strictEqual(rec.status, "filled_review");
  assert.strictEqual(rec.flag, "autocommit-containment");
  assert.strictEqual(rec.confidence, "low");
  assert.strictEqual(rec.after, "LinkedIn Corporation");
  assert.strictEqual(rec.matchTier, "enter-auto-commit");
});

test("source: directed exact leaf-click → filled, directed-exact (commit-path matchTier)", async () => {
  const { rec } = await runSource(srcField({ commitVia: "leaf", filterMap: { LinkedIn: { filtered: ["LinkedIn", "LinkedIn Learning"] } } }), ["LinkedIn"]);
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.flag, "directed-exact");
  assert.strictEqual(rec.confidence, "high");
  assert.strictEqual(rec.matchTier, "source-click-commit");
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

// ── M32 repeating-section fill (driveRepeatingSectionCdp) ───────────────────
// A fake actuation modeling ONE repeating section as a mutable entries[] array:
// repeatingScan/entryCount derive from it; clickSectionAdd pushes a fresh entry,
// clickDeleteEntry splices; the text/checkbox handlers route a COMPOSED entry-scoped
// wrapperSel back to the right entry's field. .log keeps every call so a test can
// assert a deferred date field is NEVER actuated. NOTE: byLoc resolves by
// construction, so this guards ROUTING only — true entry-scope selector uniqueness
// (the duplicate-formField-id trap) is proven by the LIVE eyeball, not this fake.
function makeFakeRepeatAct(state) {
  const log = [];
  const selOf = (fkit, fieldName) => '[data-fkit-id="' + fkit + '"] [data-automation-id="formField-' + fieldName + '"]';
  const allFields = () => state.entries.flatMap((e) => e.fields.map((f) => ({ f, sel: selOf(e.fkit, f.fieldName) })));
  const byLoc = (loc) => { const hit = allFields().find((x) => x.sel === loc.wrapperSel); return hit ? hit.f : null; };
  let focusedText = null;
  let focusedInputId = null;
  let focusedSeg = null; // { f, seg } — a focused date segment (M36)
  return {
    log,
    delay: async () => {},
    entryCount: async () => state.entries.length,
    repeatingScan: async () => ({
      url: "fake://repeat",
      sectionsPresent: [state.prefix],
      sections: { [state.prefix]: {
        entryCount: state.entries.length,
        entries: state.entries.map((e) => ({
          entryFkitId: e.fkit, deletePresent: true, deleteRect: { w: 10, h: 10, cx: 1, cy: 1 },
          fieldCount: e.fields.length,
          fields: e.fields.map((f) => ({
            fieldName: f.fieldName, automationId: "formField-" + f.fieldName,
            widgetType: f.widgetType, label: f.label || f.fieldName, isRequired: !!f.isRequired,
            hashedId: false, dateSegments: f.widgetType === "date" ? ["dateSectionYear-input"] : [],
            wrapperSel: selOf(e.fkit, f.fieldName)
          }))
        }))
      } },
      addButtons: []
    }),
    clickSectionAdd: async (re) => {
      log.push(["clickSectionAdd", re]);
      if (!state.addable) return { ok: false };
      state.entries.push(state.newEntry(state.entries.length));
      return { ok: true };
    },
    clickDeleteEntry: async (prefix, index) => {
      log.push(["clickDeleteEntry", index]);
      if (!state.deletable) return { ok: false };
      if (state.noDrop) return { ok: true }; // clicked but the count won't change (the guard test)
      state.entries.splice(index, 1);
      return { ok: true };
    },
    // text
    readTextValue: async (loc) => { const f = byLoc(loc); return f ? { value: f.value || "", focused: focusedText === f } : null; },
    focusText: async (loc) => { log.push(["focusText", loc.wrapperSel]); const f = byLoc(loc); if (!f || f.noFocus) return null; focusedText = f; focusedSeg = null; return "cdp-click"; },
    clearText: async () => { log.push(["clearText"]); if (focusedText) focusedText.value = ""; },
    typeText: async (text) => { log.push(["typeText", text]); if (focusedSeg) focusedSeg.f.segments[focusedSeg.seg].value = String(text); else if (focusedText) focusedText.value = text; },
    // checkbox
    readCheckboxState: async (loc) => { const f = byLoc(loc); return { inputId: f.inputId, checked: f.checked }; },
    readChecked: async (id) => { const hit = allFields().find((x) => x.f.inputId === id); return hit ? hit.f.checked : null; },
    focusInput: async (id) => { focusedInputId = id; return true; },
    pressSpace: async () => { log.push(["pressSpace"]); const hit = allFields().find((x) => x.f.inputId === focusedInputId); if (hit) hit.f.checked = !hit.f.checked; },
    clickCheckboxLabel: async (loc) => { log.push(["clickCheckboxLabel", loc.wrapperSel]); const f = byLoc(loc); if (!f || f.checkboxClickRectDead) return false; f.checked = !f.checked; return true; },
    // dropdown (M28 flow: open → settle → matchCandidates → clickDropdownOptionByText → commit-verify)
    openDropdown: async (loc) => { log.push(["openDropdown", loc.wrapperSel]); const f = byLoc(loc); if (!f || f.openFails) return false; f._open = true; return true; },
    readDropdownState: async (loc) => {
      const f = byLoc(loc); const open = !!(f && f._open);
      const options = open ? (f.options || []) : [];
      return { triggerText: f ? (f.triggerText || null) : null, listboxPresent: open,
        optionCount: options.filter((o) => !o.disabled).length,
        options: options.map((o) => ({ text: o.text, disabled: !!o.disabled, selected: false })), activeText: null };
    },
    clickDropdownOptionByText: async (loc, text) => {
      log.push(["clickDropdownOptionByText", loc.wrapperSel, text]);
      const f = byLoc(loc); if (!f) return false;
      const o = (f.options || []).find((x) => !x.disabled && x.text === text);
      if (!o) return false;
      f.triggerText = text; f._open = false; return true; // commit: trigger now shows the picked option
    },
    pressEscape: async () => { log.push(["pressEscape"]); state.entries.forEach((e) => e.fields.forEach((f) => { f._open = false; })); },
    // date segments (M36): a date field carries `segments: { Month/Day/Year: { value } }`.
    // focusDateSegment returns the triple-click-display rung; typeDigits/typeText WRITE the
    // focused segment's value (so a test can prove the write actually happened).
    focusDateSegment: async (loc, seg) => {
      log.push(["focusDateSegment", seg]);
      const f = byLoc(loc);
      if (!f || !f.segments || !f.segments[seg] || f.dateFocusFails) { focusedSeg = null; return null; }
      focusedSeg = { f, seg }; focusedText = null;
      return f.dateFocusRung || "triple-click-display";
    },
    readDateSegment: async (loc, seg) => {
      const f = byLoc(loc);
      if (!f || !f.segments || !f.segments[seg]) return null;
      return { value: f.segments[seg].value, focused: !!(focusedSeg && focusedSeg.f === f && focusedSeg.seg === seg) };
    },
    typeDigits: async (text) => {
      log.push(["typeDigits", String(text)]);
      if (focusedSeg && !focusedSeg.f.dateTypeFails) focusedSeg.f.segments[focusedSeg.seg].value = String(text);
    }
  };
}

const webEntry = (fkit, url) => ({ fkit, fields: [{ fieldName: "url", label: "URL*", widgetType: "text", isRequired: true, value: url || "" }] });
const webState = (overrides) => Object.assign({
  prefix: "webAddress-", addable: true, deletable: true,
  newEntry: (i) => webEntry("webAddress-new" + i, ""),
  entries: []
}, overrides || {});
const runWeb = async (state, items, extra) => {
  const act = makeFakeRepeatAct(state);
  const out = await driveRepeatingSectionCdp(act, Object.assign({
    name: "website", headingRegex: "websites?|web ?address", containerPrefix: "webAddress-",
    items, fieldMap: WEBSITE_MAP, deleteOnNoMatch: false
  }, extra || {}), T_BUDGETS);
  return { out, act, state };
};

test("repeating UP: adds entries to reach N, then fills each url", async () => {
  const state = webState({ entries: [webEntry("webAddress-4--null", "")] });
  const items = [{ url: "https://a.example" }, { url: "https://b.example" }, { url: "https://c.example" }];
  const { out, state: s } = await runWeb(state, items);
  assert.strictEqual(s.entries.length, 3);
  const add = out.results.find((r) => r.fieldName === "website.add");
  assert.strictEqual(add.status, "filled");
  assert.match(add.detail, /added 2 entry\(ies\); 3\/3/);
  const urls = out.results.filter((r) => /\.url$/.test(r.fieldName));
  assert.strictEqual(urls.length, 3);
  assert.ok(urls.every((r) => r.status === "filled" && r.verified === true));
});

test("repeating DOWN: deletes trailing extras to reach N (trailing-first)", async () => {
  const state = webState({ entries: [
    webEntry("webAddress-1--null"), webEntry("webAddress-2--null"),
    webEntry("webAddress-3--null"), webEntry("webAddress-4--null")
  ] });
  const items = [{ url: "https://a.example" }, { url: "https://b.example" }];
  const { out, act, state: s } = await runWeb(state, items);
  assert.strictEqual(s.entries.length, 2);
  const del = out.results.find((r) => r.fieldName === "website.delete");
  assert.strictEqual(del.status, "filled");
  assert.match(del.detail, /deleted 2 extra\(s\); 2\/2/);
  const delIdx = act.log.filter(([m]) => m === "clickDeleteEntry").map(([, i]) => i);
  assert.deepStrictEqual(delIdx, [3, 2]); // trailing-first
  assert.strictEqual(out.results.filter((r) => /\.url$/.test(r.fieldName)).length, 2);
});

test("repeating fill: each entry gets ITS OWN url (routing; live proves uniqueness)", async () => {
  const state = webState({ entries: [
    webEntry("webAddress-1--null"), webEntry("webAddress-2--null"), webEntry("webAddress-3--null")
  ] });
  const items = [{ url: "https://alice.example" }, { url: "https://bob.example" }, { url: "https://carol.example" }];
  const { out } = await runWeb(state, items);
  const urls = out.results.filter((r) => /\.url$/.test(r.fieldName));
  assert.deepStrictEqual(urls.map((r) => r.after), ["https://alice.example", "https://bob.example", "https://carol.example"]);
  assert.ok(urls.every((r) => r.status === "filled" && r.verified === true));
});

test("repeating N===0: deletes phantom entries, records a single skipped section", async () => {
  const state = webState({ entries: [webEntry("webAddress-1--null"), webEntry("webAddress-2--null")] });
  const { out, state: s } = await runWeb(state, []);
  assert.strictEqual(s.entries.length, 0);
  assert.strictEqual(out.results.find((r) => r.fieldName === "website.delete").status, "filled");
  const skip = out.results.find((r) => r.fieldName === "website");
  assert.strictEqual(skip.status, "skipped");
  assert.match(skip.detail, /no meaningful website entries/);
  assert.ok(!out.results.some((r) => /\.url$/.test(r.fieldName)));
});

// M36 — the M32b "date is DEFERRED / zero-actuation" invariant is INVERTED: the date branch
// now FILLS via fillDateCompositeCdp. The flip asserts the segments were ACTUALLY WRITTEN
// (per-segment typeDigits happened + the fake's segment values changed) — not merely
// status:"filled" (which a fake could pass without modeling the write).
test("repeating M/Y date now FILLS via the composite — segments ACTUALLY written (M36 un-defer)", async () => {
  const entry = { fkit: "webAddress-1--null", fields: [
    { fieldName: "url", label: "URL*", widgetType: "text", isRequired: true, value: "" },
    { fieldName: "startDate", label: "From", widgetType: "date", isRequired: false, segments: { Month: { value: "" }, Year: { value: "" } } }
  ] };
  const state = webState({ entries: [entry] });
  const fieldMap = [
    { field: "url", widget: "text", key: "url", path: "url" },
    { field: "startDate", widget: "date", key: "from", path: "from" }
  ];
  const act = makeFakeRepeatAct(state);
  const out = await driveRepeatingSectionCdp(act, {
    name: "website", headingRegex: "websites?", containerPrefix: "webAddress-",
    items: [{ url: "https://a.example", from: { month: "12", year: "2024" } }], fieldMap, deleteOnNoMatch: false
  }, T_BUDGETS);
  const dateRec = out.results.find((r) => /startDate$/.test(r.fieldName));
  assert.strictEqual(dateRec.status, "filled");
  assert.strictEqual(dateRec.flag, null); // no cdp-date-deferred anymore
  assert.strictEqual(entry.fields[1].segments.Month.value, "12"); // WRITTEN, provably
  assert.strictEqual(entry.fields[1].segments.Year.value, "2024");
  assert.ok(act.log.some(([m, a]) => m === "typeDigits" && a === "12"), "Month digits actually typed");
  assert.ok(act.log.some(([m, a]) => m === "typeDigits" && a === "2024"), "Year digits actually typed");
});

test("repeating M/D/Y date fills all THREE segments in-section (the Certs shape)", async () => {
  const entry = { fkit: "certification-1--null", fields: [
    { fieldName: "issuedDate", label: "Issued Date", widgetType: "date", isRequired: false, segments: { Month: { value: "" }, Day: { value: "" }, Year: { value: "" } } }
  ] };
  const state = { prefix: "certification-", addable: true, deletable: true, newEntry: () => entry, entries: [entry] };
  const fieldMap = [{ field: "issuedDate", widget: "date", key: "issuedDateParsed", path: "issued_date" }];
  const out = await driveRepeatingSectionCdp(makeFakeRepeatAct(state), {
    name: "certification", headingRegex: "certifications?", containerPrefix: "certification-",
    items: [{ issuedDateParsed: { month: "6", day: "15", year: "2024" } }], fieldMap, deleteOnNoMatch: false
  }, T_BUDGETS);
  assert.strictEqual(out.results.find((r) => /issuedDate$/.test(r.fieldName)).status, "filled");
  assert.deepStrictEqual(
    [entry.fields[0].segments.Month.value, entry.fields[0].segments.Day.value, entry.fields[0].segments.Year.value],
    ["6", "15", "2024"]);
});

test("repeating Education-shape entry: text + dropdown + YEAR date all fill (date coexists)", async () => {
  const entry = { fkit: "education-1--null", fields: [
    { fieldName: "schoolName", label: "School*", widgetType: "text", isRequired: true, value: "" },
    { fieldName: "degree", label: "Degree*", widgetType: "dropdown", isRequired: true, triggerText: "Select One", options: [{ text: "Select One", disabled: true }, { text: "Bachelors" }] },
    { fieldName: "firstYearAttended", label: "From", widgetType: "date", isRequired: false, segments: { Year: { value: "" } } }
  ] };
  const state = { prefix: "education-", addable: true, deletable: true, newEntry: () => entry, entries: [entry] };
  const fieldMap = [
    { field: "schoolName", widget: "text", key: "school", path: "school" },
    { field: "degree", widget: "dropdown", key: "degree", path: "degree" },
    { field: "firstYearAttended", widget: "year", key: "fromYearParsed", path: "from_year" }
  ];
  const out = await driveRepeatingSectionCdp(makeFakeRepeatAct(state), {
    name: "education", headingRegex: "education", containerPrefix: "education-",
    items: [{ school: "CMU", degree: ["Bachelor of Science", "Bachelors"], fromYearParsed: "2024" }], fieldMap, deleteOnNoMatch: false
  }, T_BUDGETS);
  const rec = (n) => out.results.find((r) => r.fieldName === n);
  assert.strictEqual(rec("education[0].schoolName").after, "CMU");
  assert.strictEqual(rec("education[0].degree").after, "Bachelors"); // tiered array → matched
  assert.strictEqual(rec("education[0].firstYearAttended").status, "filled");
  assert.strictEqual(entry.fields[2].segments.Year.value, "2024"); // year date WRITTEN
});

test("repeating delete-on-no-match: required no-fill entries deleted high→low", async () => {
  const mk = (fkit) => ({ fkit, fields: [{ fieldName: "x", label: "X*", widgetType: "text", isRequired: true, value: "", noFocus: true }] });
  const state = webState({ entries: [mk("webAddress-1--null"), mk("webAddress-2--null")] });
  const fieldMap = [{ field: "x", widget: "text", key: "x", path: "x" }];
  const act = makeFakeRepeatAct(state);
  const out = await driveRepeatingSectionCdp(act, {
    name: "lang", headingRegex: "x", containerPrefix: "webAddress-",
    items: [{ x: "a" }, { x: "b" }], fieldMap, deleteOnNoMatch: true
  }, T_BUDGETS);
  const delIdx = act.log.filter(([m]) => m === "clickDeleteEntry").map(([, i]) => i);
  assert.deepStrictEqual(delIdx, [1, 0]); // high→low so lower indices stay valid
  const removed = out.results.filter((r) => /removed$/.test(r.fieldName));
  assert.strictEqual(removed.length, 2);
  assert.ok(removed.every((r) => r.status === "skipped" && /entry deleted/.test(r.detail)));
});

test("repeating UP: add that never mounts stops bounded, flags needs_review", async () => {
  const state = webState({ addable: false, entries: [webEntry("webAddress-1--null")] });
  const items = [{ url: "https://a.example" }, { url: "https://b.example" }, { url: "https://c.example" }];
  const { out, act, state: s } = await runWeb(state, items);
  const add = out.results.find((r) => r.fieldName === "website.add");
  assert.strictEqual(add.status, "needs_review");
  assert.match(add.detail, /added 0 entry\(ies\); 1\/3/);
  assert.strictEqual(act.log.filter(([m]) => m === "clickSectionAdd").length, 1); // bounded — no spin
  assert.strictEqual(s.entries.length, 1);
});

test("repeating DOWN: delete that doesn't drop the count stops bounded", async () => {
  const state = webState({ noDrop: true, entries: [
    webEntry("webAddress-1--null"), webEntry("webAddress-2--null"), webEntry("webAddress-3--null")
  ] });
  const { out, act, state: s } = await runWeb(state, [{ url: "https://a.example" }]);
  assert.strictEqual(out.results.find((r) => r.fieldName === "website.delete").status, "needs_review");
  assert.strictEqual(act.log.filter(([m]) => m === "clickDeleteEntry").length, 1); // bounded — no spin
  assert.strictEqual(s.entries.length, 3);
});

// ── M34 CDP date composite (fillDateCompositeCdp) ───────────────────────────
// A fake actuation modeling ONE date field's segments. focusDateSegment sets the
// focused segment + returns the winning rung; typeDigits (per-char) / typeText
// (insertText fallback) write the focused segment's value; readDateSegment reads it
// back. Flags simulate focus failure, per-char no-op (→ insertText fallback), and
// both-methods failure (→ needs_review). .log asserts a segment that can't focus is
// NEVER typed into (the "never type blind" invariant).
function makeFakeDateAct(segs, opts) {
  opts = opts || {};
  const log = [];
  let focused = null;
  const focusFails = new Set(opts.focusFailsFor || []);
  const perCharFails = new Set(opts.perCharFailsFor || []);
  const bothFail = new Set(opts.bothFailFor || []);
  const rung = (s) => (opts.focusRungFor && opts.focusRungFor[s]) || "triple-click-display";
  return {
    log,
    delay: async () => {},
    focusDateSegment: async (loc, seg) => {
      log.push(["focusDateSegment", seg]);
      if (focusFails.has(seg) || !(seg in segs)) { focused = null; return null; }
      focused = seg;
      return rung(seg);
    },
    readDateSegment: async (loc, seg) => (seg in segs ? { value: segs[seg].value, focused: focused === seg } : null),
    clearText: async () => { log.push(["clearText", focused]); if (focused && segs[focused]) segs[focused].value = ""; },
    typeDigits: async (text) => {
      log.push(["typeDigits", focused, text]);
      if (!focused) return;
      if (perCharFails.has(focused) || bothFail.has(focused)) return; // per-char no-op → insertText fallback
      segs[focused].value = String(text);
    },
    typeText: async (text) => {
      log.push(["typeText", focused, text]);
      if (!focused) return;
      if (bothFail.has(focused)) return; // insertText also no-op → needs_review
      segs[focused].value = String(text);
    }
  };
}
const seg0 = () => ({ value: "" });
const runDate = (segs, parsed, opts) => {
  const act = makeFakeDateAct(segs, opts);
  return fillDateCompositeCdp(act, { wrapperSel: "[w-date]" }, parsed, T_BUDGETS).then((rec) => ({ rec, act }));
};

test("date composite: M/Y fills + verifies each segment", async () => {
  const segs = { Month: seg0(), Year: seg0() };
  const { rec } = await runDate(segs, { month: "12", year: "2024" });
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "12/2024");
  assert.strictEqual(rec.verified, true);
  assert.deepStrictEqual([segs.Month.value, segs.Year.value], ["12", "2024"]);
});

test("date composite: year-only (string parsed) fills the Year segment", async () => {
  const segs = { Year: seg0() };
  const { rec } = await runDate(segs, "2028");
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "2028");
  assert.strictEqual(segs.Year.value, "2028");
});

test("date composite: M/D/Y fills all three segments in order", async () => {
  const segs = { Month: seg0(), Day: seg0(), Year: seg0() };
  const { rec } = await runDate(segs, { month: "6", day: "15", year: "2027" });
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "6/15/2027");
  assert.deepStrictEqual([segs.Month.value, segs.Day.value, segs.Year.value], ["6", "15", "2027"]);
});

test("date composite: a segment that can't focus → needs_review with ZERO typing on it", async () => {
  const segs = { Month: seg0(), Year: seg0() };
  const { rec, act } = await runDate(segs, { month: "12", year: "2024" }, { focusFailsFor: ["Year"] });
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.verified, false);
  assert.strictEqual(segs.Month.value, "12"); // month still filled
  // the load-bearing "never type blind": a segment that failed to focus is NEVER typed into.
  assert.ok(!act.log.some(([m, s]) => (m === "typeDigits" || m === "typeText") && s === "Year"),
    "must not type into a segment that failed to focus");
});

test("date composite: per-char no-op → insertText fallback verifies → filled", async () => {
  const segs = { Month: seg0(), Year: seg0() };
  const { rec } = await runDate(segs, { month: "12", year: "2024" }, { perCharFailsFor: ["Month"] });
  assert.strictEqual(rec.status, "filled");
  assert.match(rec.detail, /"Month":"triple-click-display\/insertText"/);
  assert.strictEqual(segs.Month.value, "12");
});

test("date composite: both per-char AND insertText fail → needs_review (never 'filled')", async () => {
  const segs = { Month: seg0(), Year: seg0() };
  const { rec } = await runDate(segs, { month: "12", year: "2024" }, { bothFailFor: ["Month"] });
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.verified, false);
  assert.match(rec.detail, /Month.*FAILED/);
});

// REGRESSION GUARD (M34 M/D/Y bug): the composite must NEVER Ctrl+A-clear the whole date
// composite — that resets the active segment to Month, so per-char Day/Year digits pile
// into Month (the "12/20/2024" bug). triple-click-select + type-replace needs no clear.
test("date composite: NEVER calls a whole-field clearText (no Ctrl+A in the date path)", async () => {
  const segs = { Month: seg0(), Day: seg0(), Year: seg0() };
  const { rec, act } = await runDate(segs, { month: "6", day: "15", year: "2024" });
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "6/15/2024");
  assert.ok(!act.log.some(([m]) => m === "clearText"),
    "composite must not Ctrl+A-clear the whole date composite (resets focus to Month → digit-piling)");
});

// ── M35 Languages (driveRepeatingSectionCdp + LANGUAGE_MAP) ─────────────────
// Exercises the dropdown + checkbox + labelRegex routing in fillEntryCdp. The
// proficiency fields use IDENTICAL hashed fieldNames across entries (the live
// duplicate-id trap) — resolution must stay entry-scoped (find within the entry's
// fields + fkit-prefixed wrapperSel). Reuses makeFakeRepeatAct (now with dropdowns).
const LANG_OPTS = [{ text: "Select One", disabled: true }, { text: "English" }, { text: "Chinese" }, { text: "Spanish" }];
const PROF_OPTS = [{ text: "Select One", disabled: true }, { text: "Novice" }, { text: "Intermediate" }, { text: "Advanced" }, { text: "Fluent" }];
const langEntry = (fkit, o) => ({ fkit, fields: [
  { fieldName: "language", label: "Language*", widgetType: "dropdown", isRequired: true, triggerText: "Select One", options: LANG_OPTS },
  { fieldName: "5aaaedREAD", label: (o && o.readingLabel) || "Reading Proficiency*", widgetType: "dropdown", isRequired: true, triggerText: "Select One", options: PROF_OPTS },
  { fieldName: "5aaaedSPEAK", label: "Speaking Proficiency*", widgetType: "dropdown", isRequired: true, triggerText: "Select One", options: PROF_OPTS },
  { fieldName: "5aaaedWRITE", label: "Writing Proficiency*", widgetType: "dropdown", isRequired: true, triggerText: "Select One", options: PROF_OPTS },
  { fieldName: "native", label: "I am fluent in this language.", widgetType: "checkbox", isRequired: false, inputId: fkit + "-native", checked: false }
] });
const runLang = async (entries, items) => {
  const state = { prefix: "language-", addable: true, deletable: true, newEntry: (i) => langEntry("language-new" + i), entries };
  const act = makeFakeRepeatAct(state);
  const out = await driveRepeatingSectionCdp(act, {
    name: "language", headingRegex: "languages?", containerPrefix: "language-",
    items, fieldMap: LANGUAGE_MAP, deleteOnNoMatch: true
  }, T_BUDGETS);
  return { out, act, state };
};
const EN = { language: "English", reading: "Fluent", speaking: "Fluent", writing: "Fluent", _allFluent: true };
const ZH = { language: "Chinese", reading: "Intermediate", speaking: "Advanced", writing: "Intermediate", _allFluent: false };
const nativeOf = (e) => e.fields.find((f) => f.fieldName === "native").checked;

test("languages: English all-Fluent → dropdowns filled (incl. by-LABEL proficiencies) + 'I am fluent' checked", async () => {
  const { out, state } = await runLang([langEntry("language-6--null")], [EN]);
  const rec = (n) => out.results.find((r) => r.fieldName === n);
  assert.strictEqual(rec("language[0].language").after, "English");
  for (const p of ["readingProficiency", "speakingProficiency", "writingProficiency"]) {
    assert.strictEqual(rec("language[0]." + p).status, "filled", p);
    assert.strictEqual(rec("language[0]." + p).after, "Fluent", p);
  }
  assert.strictEqual(rec("language[0].native").status, "filled");
  assert.strictEqual(nativeOf(state.entries[0]), true);
  assert.strictEqual(out.needsReview.length, 0);
});

test("languages: Chinese per-skill → distinct proficiencies + 'I am fluent' left unchecked", async () => {
  const { out, state } = await runLang([langEntry("language-6--null")], [ZH]);
  const rec = (n) => out.results.find((r) => r.fieldName === n);
  assert.strictEqual(rec("language[0].language").after, "Chinese");
  assert.strictEqual(rec("language[0].readingProficiency").after, "Intermediate");
  assert.strictEqual(rec("language[0].speakingProficiency").after, "Advanced");
  assert.strictEqual(rec("language[0].writingProficiency").after, "Intermediate");
  assert.strictEqual(nativeOf(state.entries[0]), false); // _allFluent:false → reconciled to unchecked
});

test("languages: ENTRY-SCOPED resolve with DUPLICATE hashed ids — entries get their OWN values (not crossed)", async () => {
  const e6 = langEntry("language-6--null"); // both share fieldName "5aaaedREAD" etc. — fkit differs
  const e7 = langEntry("language-7--null");
  await runLang([e6, e7], [EN, ZH]);
  const v = (e, fn) => e.fields.find((f) => f.fieldName === fn).triggerText;
  assert.strictEqual(v(e6, "language"), "English");
  assert.strictEqual(v(e6, "5aaaedREAD"), "Fluent");      // entry-6 reading = English's Fluent
  assert.strictEqual(v(e7, "language"), "Chinese");
  assert.strictEqual(v(e7, "5aaaedREAD"), "Intermediate"); // entry-7 reading = Chinese's — NOT crossed
  assert.strictEqual(v(e7, "5aaaedSPEAK"), "Advanced");
});

test("languages: deleteOnNoMatch — an unmatchable language deletes the RIGHT entry (high→low)", async () => {
  const bogus = { language: "Klingon", reading: "Fluent", speaking: "Fluent", writing: "Fluent", _allFluent: true };
  const { act, state } = await runLang([langEntry("language-6--null"), langEntry("language-7--null")], [EN, bogus]);
  assert.strictEqual(state.entries.length, 1);
  assert.strictEqual(state.entries[0].fkit, "language-6--null"); // the bogus entry-7 deleted, the real one kept
  const delIdx = act.log.filter(([m]) => m === "clickDeleteEntry").map(([, i]) => i);
  assert.deepStrictEqual(delIdx, [1]); // deleted index 1 (bogus), not 0
});

test("languages: labelRegex NO-match → 'field wrapper not found' (resolve-failure path)", async () => {
  const e = langEntry("language-6--null", { readingLabel: "Comprehension Level" }); // won't match /reading proficiency/i
  const { out } = await runLang([e], [EN]);
  const r = out.results.find((x) => x.fieldName === "language[0].readingProficiency");
  assert.strictEqual(r.status, "error");
  assert.match(r.detail, /field wrapper not found/);
});

test("languages: 'I am fluent' checkbox is processed LAST (after the proficiencies)", async () => {
  const { out } = await runLang([langEntry("language-6--null")], [EN]);
  const order = out.results.filter((r) => /^language\[0\]\./.test(r.fieldName)).map((r) => r.fieldName);
  assert.ok(order.indexOf("language[0].native") > order.indexOf("language[0].writingProficiency"),
    "native must be filled after the proficiencies");
});
