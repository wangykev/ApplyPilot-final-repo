// Unit tests for fill-driver.js — the substrate-agnostic CDP fill brain — driven
// by a FAKE actuation (the substrate-swap hedge made testable). The fake logs
// every actuation call so tests can assert not just outcomes but that deferred
// widgets are NEVER actuated and unverified commits are NEVER pressed.
const { test } = require("node:test");
const assert = require("node:assert");
const { drivePageFill, fillSourceCdp, fillTypeaheadCdp, commitOutcome, driveRepeatingSectionCdp, WEBSITE_MAP, LANGUAGE_MAP, WORK_EXPERIENCE_MAP, fillDateCompositeCdp, buildReviewBundle, accumulateBundle, reconcileAudit, auditDateSegments, applyAuditVerdicts, reconDropdownDump, closeAndVerifyBlank, aiEligible, legallyLoaded, parseAiReply, parseAiText, aiRemediateError, parseRemediation, captureFieldOptions, captureDropdownOptions, captureChoiceOptions, awaitListTerminal, awaitListStable } = require("../fill-driver.js");

// Tiny budgets: success paths settle on the first reads; failure-path polls
// spin only for a few ms of wall clock.
const T_BUDGETS = {
  openCeilingMs: 60, settleIntervalMs: 1, stableReads: 2,
  openRetries: 3, openExpandWindowMs: 20, reopenSettleMs: 1, taOpenRetries: 3,
  commitCeilingMs: 25, commitIntervalMs: 1,
  textReadDelayMs: 1, textReadCeilingMs: 30, textReadIntervalMs: 1, typeJumpDelayMs: 1, arrowStepMs: 1, maxArrowSteps: 60,
  interFieldMs: 0,
  taOpenCeilingMs: 50, taOpenIntervalMs: 1, taActionSettleMs: 1,
  taActionSettleCeilingMs: 30, taActionSettleIntervalMs: 1,
  taSettleCeilingMs: 60, taSettleIntervalMs: 1, taEnterCommitCeilingMs: 25, taEmptyNoMatchMs: 10,
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
function makeFakeAct(fields, opts) {
  const o = opts || {};
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
    // AI-1: the toggle gate + the LLM seam. aiEnabled defaults OFF (existing tests unchanged —
    // the AI hook never fires). `o.ai` is the canned reply: a string → {ok:true,text}; an object
    // → returned verbatim ({ok:false,error} models a failure); undefined → {ok:false} (no reply).
    aiEnabled: o.aiEnabled === true,
    llm: async (req) => {
      log.push(["llm", req && req.user]);
      const a = o.ai;
      if (a === undefined || a === null) return { ok: false, error: "no canned reply" };
      return typeof a === "string" ? { ok: true, text: a } : a;
    },
    delay: async () => {},
    delayFull: async () => {}, // non-adaptive (real-time) wait — instant in tests
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
      if (f.noInput) return null;
      // lag model: typeText stashed a pending value that REGISTERS only after N reads (laggy
      // read-back) — the reactive poll must keep reading until it appears.
      if (f._readsLeft !== undefined) {
        if (f._readsLeft > 0) f._readsLeft -= 1;
        else f.value = f._pending;
      }
      return { value: f.value || "", focused: focusedText === f };
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
      if (!focusedText) return;
      const v = focusedText.mangle ? focusedText.mangle(text) : text;
      if (focusedText.valueAfterReads !== undefined) { focusedText._pending = v; focusedText._readsLeft = focusedText.valueAfterReads; } // lag model
      else focusedText.value = v;
    },

    // dropdown
    openDropdown: async (loc) => {
      log.push(["openDropdown", loc.wrapperSel]);
      const f = byLoc(loc);
      if (f.openFails) return false;
      // Open-race model: the click "succeeds" (returns true) but the trigger only
      // actually EXPANDS once it has been opened expandsOnAttempt times (default 1 =
      // expands immediately). expandsOnAttempt:99 → never expands (genuine failure).
      f._openCount = (f._openCount || 0) + 1;
      f.open = f._openCount >= (f.expandsOnAttempt || 1);
      if (f.activeIdx === undefined) f.activeIdx = null;
      openField = f;
      return true;
    },
    readDropdownState: async (loc) => {
      const f = byLoc(loc);
      const expanded = !!f.open;                    // trigger aria-expanded (open-click took)
      const rendered = expanded && !f.neverRenders; // option list actually present
      const options = rendered ? f.options : [];
      // false-verify model (see clickDropdownOptionByText): show the target for a few reads
      // post-commit, then revert — the persistence/commit-stability guard must catch this.
      let triggerText = f.triggerText;
      if (f._revertCountdown !== undefined) {
        if (f._revertCountdown > 0) f._revertCountdown -= 1;
        else triggerText = f.revertValue || "Select One";
      }
      return {
        triggerText,
        ariaExpanded: expanded ? "true" : "false",
        listboxPresent: rendered,
        optionCount: options.filter((o) => !o.disabled).length,
        options: options.map((o) => ({ text: o.text, disabled: !!o.disabled, selected: !!o.selected })),
        activeText: rendered && f.activeIdx != null ? f.options[f.activeIdx].text : null
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
          if (fm.banner) { src._banner = true; src._resultsBanner = false; src._leaves = (src.fallbackLeaves || src._leaves || []).slice(); }
          else if (fm.autoCommit) { src.chips = [fm.autoCommit]; src._open = false; src._banner = false; src._resultsBanner = false; }
          else if (fm.filtered) { src._banner = false;
            if (fm.lateResultsBanner) {
              // LATE RESULTS banner (lockstep with the typeahead): a transient bannerless leaf list renders NOW;
              // the "Search Results" banner + the REAL leaves land after N reads. awaitListTerminal must WAIT.
              src._leaves = (src.fallbackLeaves || []).slice(); src._resultsBanner = false;
              src._resultsBannerPending = true; src._resultsBannerReadsLeft = fm.lateResultsBanner; src._pendingLeaves = fm.filtered.slice();
            } else {
              src._leaves = fm.filtered.slice();
              src._resultsBanner = src._leaves.length > 0; // a non-empty leaf list → the "Search Results" banner
            }
          }
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
            if (fm.banner) { ta._banner = true; ta._resultsBanner = false; ta._texts = (ta.fallbackTexts || ta._texts || []).slice(); ta._filtered = true; }
            // residualChipAfterCommit: simulate a tenant that ADDS a chip instead of
            // REPLACING (recon = REPLACE on Magna; this drives the defensive assertion).
            else if (fm.autoCommit) { ta.chips = ta.residualChipAfterCommit ? (ta.chips || []).concat([fm.autoCommit]) : [fm.autoCommit]; ta._open = false; ta._banner = false; ta._resultsBanner = false; }
            else if (fm.filtered) { ta._banner = false; ta._filtered = true;
              // strayChip: model the filter-Enter ALSO committing the armed row-0 (a stray) while the list
              // stays OPEN — the affirmative clickTaOption must then OVERWRITE it back to the kept value.
              if (fm.strayChip) ta.chips = [fm.strayChip];
              if (fm.lateResultsBanner) {
                // LATE RESULTS banner: a transient bannerless list (fallbackTexts) renders NOW; the "Search
                // Results" banner + the REAL filtered list land only after N reads. awaitListTerminal must WAIT
                // (never match the bannerless transient → that would commit a stray / a wrong row).
                ta._texts = (ta.fallbackTexts || []).slice(); ta._resultsBanner = false;
                ta._resultsBannerPending = true; ta._resultsBannerReadsLeft = fm.lateResultsBanner; ta._pendingTexts = fm.filtered.slice();
              } else {
                ta._texts = fm.filtered.slice();
                ta._resultsBanner = ta._texts.length > 0; // a non-empty filtered list → the "Search Results" banner
              }
              // empty-results (filtered to 0, no banner): a 0-options filter DROPS searchBox focus (the
              // keptLowerTier re-commit re-asserts). NOT terminal under awaitListTerminal → it times out.
              if (ta._texts.length === 0 && ta.dropsFocusAfterEmpty) { ta._focusedSb = false; if (ta.focusUnrecoverableAfterEmpty) ta.focusUnconfirmable = true; }
            }
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
      // strayChipOnEscape: model the live bug — an armed row-0 ("Accounting") that COMMITS on
      // the exit/dismiss despite the resting path. The strayed-check must flag it (overwrite-stray),
      // never report a false "kept original".
      if (focusedTa) { if (focusedTa.strayChipOnEscape) focusedTa.chips = [focusedTa.strayChipOnEscape]; focusedTa._open = false; }
      if (focusedSrc) { if (focusedSrc.strayChipOnEscape) focusedSrc.chips = [focusedSrc.strayChipOnEscape]; focusedSrc._open = false; }
      // strayValueOnEscape: model the recon's closed-but-COMMITTED dropdown — Escape collapses
      // the list AND a value lands (triggerText changes) → blank:false + the strayed value.
      // escapeWontClose: model the LIVE false-stray cause — a slow-closing list that stays OPEN
      // across the Escape while the VALUE stays the placeholder → must still read blank:true.
      if (openField) { if (openField.strayValueOnEscape) openField.triggerText = openField.strayValueOnEscape; if (!openField.escapeWontClose) openField.open = false; }
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
      if (f._resultsBannerPending) { f._resultsBannerReadsLeft -= 1; if (f._resultsBannerReadsLeft <= 0) { f._resultsBanner = true; f._resultsBannerPending = false; if (f._pendingLeaves) f._leaves = f._pendingLeaves; } } // late RESULTS banner lands after N reads
      const leaves = f._open ? (f._leaves || []) : [];
      const sig = (f._rev || 0) + "|" + leaves.length + "|" + leaves.slice(0, 3).join("~");
      return {
        searchBox: { present: !!f._open, visible: !!f._open, focused: !!(f._open && f._focusedSb), value: f._value || "" },
        leaves, leafCount: leaves.length, sig,
        banner: !!(f._open && f._banner),
        resultsBanner: !!(f._open && f._resultsBanner),
        chips: (f.chips || []).slice()
      };
    },
    focusSourceSearch: async (loc) => { log.push(["focusSourceSearch"]); const f = byLoc(loc); if (!f.focusUnconfirmable) f._focusedSb = true; focusedSrc = f; return true; },
    typeInSourceSearch: async (t) => { log.push(["typeInSourceSearch", t]); if (focusedSrc) { focusedSrc._value = t; focusedSrc._filtered = false; focusedSrc._resultsBanner = false; focusedSrc._resultsBannerPending = false; } },
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
      // focusUnconfirmable: opens/visible but focus NEVER confirms (the abort invariant).
      // focusRaces: open doesn't confirm focus; focusSearchBox confirms only on its 2nd
      // call (the fast-pacing open/focus race that the open-retry must recover from).
      if (!f.focusUnconfirmable && !f.focusRaces) f._focusedSb = true;
      if (f._texts === undefined) f._texts = (f.openTexts || []).slice();
      if (f._banner === undefined) f._banner = false;
      focusedTa = f;
      return true;
    },
    focusSearchBox: async (loc) => {
      log.push(["focusSearchBox", loc.wrapperSel]);
      const f = byLoc(loc);
      if (!f.focusUnconfirmable) f._focusedSb = f.focusRaces ? ((f._fsbTries = (f._fsbTries || 0) + 1) >= 2) : true;
      focusedTa = f;
      return true;
    },
    readTypeahead: async (loc) => {
      const f = byLoc(loc);
      // lateResultsBanner: the "Search Results" banner + the REAL filtered list LAND after N reads (throttle-
      // lag), over a transient bannerless list — every read brings it closer; awaitListTerminal polling waits it.
      if (f._resultsBannerPending) { f._resultsBannerReadsLeft -= 1; if (f._resultsBannerReadsLeft <= 0) { f._resultsBanner = true; f._resultsBannerPending = false; if (f._pendingTexts) f._texts = f._pendingTexts; } }
      const texts = f._open ? (f._texts || []) : [];
      const sig = (f._rev || 0) + "|" + texts.length + "|" + texts.slice(0, 3).join("~");
      // M39.2 lag model: the searchBox VALUE reflects the typed text only after N reads
      // (the underlying _value is set immediately, so the filter-Enter still works — only the
      // READ-back of the input echoes late). Default: value === _value (immediate, unchanged).
      let sbValue = f._value || "";
      if (f._lagLeft !== undefined) {
        if (f._lagLeft > 0) f._lagLeft -= 1; else f._lagReflected = f._lagPending;
        sbValue = f._lagReflected;
      }
      return {
        searchBox: { present: !!f._open, visible: !!f._open, focused: !!(f._open && f._focusedSb), value: sbValue },
        chips: (f.chips || []).slice(),
        banner: f._open && f._banner ? { text: "No matches found", automationId: "promptTitle" } : null,
        resultsBanner: !!(f._open && f._resultsBanner),
        pageWide: { count: texts.length, sig, sample: texts.slice(0, 10), texts: texts.slice(0, 40) },
        activeText: null
      };
    },
    typeInSearch: async (text) => {
      log.push(["typeInSearch", text]);
      if (!focusedTa) return;
      focusedTa._value = text; focusedTa._filtered = false; // _value (used by filter-Enter) lands immediately
      focusedTa._resultsBanner = false; focusedTa._resultsBannerPending = false; // new search → the results state resets
      if (focusedTa.searchValueLagReads !== undefined) { focusedTa._lagPending = text; focusedTa._lagReflected = ""; focusedTa._lagLeft = focusedTa.searchValueLagReads; } // but the READ echoes late
    },
    clearSearch: async () => {
      log.push(["clearSearch"]);
      if (focusedTa) { focusedTa._value = ""; focusedTa._filtered = false; }
      // stale banner + rendered list deliberately PERSIST (recon finding)
    },
    // FoS capture (single-open): read-only scroll-scrape. dropsFocusOnScrape models the scroll dropping
    // searchBox focus → the loop's ensureSearchFocused must re-focus (focusSearchBox) before the type.
    scrapeTaOptions: async (loc) => {
      log.push(["scrapeTaOptions", loc.wrapperSel]);
      const f = byLoc(loc);
      if (f && f.dropsFocusOnScrape) f._focusedSb = false;
      if (!f || f.scrapeFails) return { ok: false, error: "no wrapper" };
      const options = (f.scrapeOptions || []).slice();
      return { ok: true, options, count: options.length, atBottom: true };
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
      // false-verify model: the pick shows for `showTargetReads` reads (default 1) then
      // the page DISCARDS it (reverts to revertValue) — a pick made before render-complete.
      if (f.revertsAfterCommit) f._revertCountdown = f.showTargetReads !== undefined ? f.showTargetReads : 1;
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

// ── dropdown open-retry (foreground fast-fill: the open races the prior re-render) ──

test("dropdown: open RACES the prior re-render (expands on attempt 2) → re-open RECOVERS, filled", async () => {
  // The foreground-fast-fill bug: a fast open-click no-ops during the prior field's
  // post-commit re-render (the trigger never expands), so the old single open burned
  // the full option ceiling and false-failed. The aria-expanded-gated retry must
  // re-open and commit.
  const act = makeFakeAct([ddField({ expandsOnAttempt: 2 })]);
  const out = await drivePageFill(act, usProfile, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "United States of America");
  assert.strictEqual(act.log.filter(([m]) => m === "openDropdown").length, 2, "re-opened exactly once after the raced attempt");
});

test("dropdown: an already-EXPANDED dropdown is NOT re-clicked (toggle-shut invariant)", async () => {
  // The inverse bug the retry must NOT introduce: a 2nd click on an OPEN dropdown
  // TOGGLES IT SHUT. attempt-1 expands immediately → straight to options-settle, a
  // single open-click, never a second. NAMED invariant.
  const act = makeFakeAct([ddField()]); // expands on attempt 1 (default)
  const out = await drivePageFill(act, usProfile, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(act.log.filter(([m]) => m === "openDropdown").length, 1, "expanded dropdown opened exactly once (no toggle-shut re-click)");
});

test("dropdown: trigger NEVER expands across all retries → needs_review (options did not render), no false fill", async () => {
  const act = makeFakeAct([ddField({ expandsOnAttempt: 99 })]);
  const out = await drivePageFill(act, usProfile, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.match(rec.detail, /options did not render/);
  assert.strictEqual(act.log.filter(([m]) => m === "openDropdown").length, T_BUDGETS.openRetries, "re-opened up to the retry bound, then gave up — never a false filled");
});

test("reconDropdownDump (AI-1 recon): reads options + dismisses CLEAN, NEVER arms/commits an option", async () => {
  // Concern 1 — the recon runs on a REAL app's page 3 the operator then fills, so each
  // dropdown must end exactly where it started ("Select One"), never a stray row-0 commit.
  const act = makeFakeAct([ddField()]); // default triggerText "Select One"
  const dump = await reconDropdownDump(act, { wrapperSel: "[w-country]" }, T_BUDGETS);
  assert.strictEqual(dump.before, "Select One");
  assert.strictEqual(dump.after, "Select One");
  assert.strictEqual(dump.clean, true, "trigger text unchanged before vs after — left clean");
  assert.ok(dump.optionCount > 0 && dump.options.length, "captured the option list");
  // NEVER arms or commits: no type-jump / arrow / Enter / option-click in the actuation log.
  const armedOrCommitted = act.log.some(([m]) => ["typeJumpChars", "arrowStep", "pressEnter", "clickDropdownOptionByText", "clickOptionByIndex"].includes(m));
  assert.ok(!armedOrCommitted, "recon must never type/arrow/Enter/click an option (no armed row to stray)");
  assert.ok(act.log.some(([m]) => m === "pressEscape"), "dismissed via Escape (the clean close)");
});

// ── AI-1: AI dropdown fallback (fake act.llm) ────────────────────────────────
const aiDd = (flags) => Object.assign({
  wrapperSel: "[w-ai]", fieldName: "screen_q", widgetType: "dropdown", isRequired: true,
  label: "Are you over the age of 18?*",
  triggerText: "Select One", options: [{ text: "Select One", disabled: true }, { text: "Yes" }, { text: "No" }]
}, flags || {});

test("AI fallback: a matched JSON answer → filled_review + ai-choice-sensitive + the AI's confidence + justification (NEVER silent)", async () => {
  const act = makeFakeAct([aiDd()], { aiEnabled: true, ai: '{"choice":"No","justification":"the applicant is an enrolled student, so under 18 is implausible","confidence":"High"}' });
  const out = await drivePageFill(act, {}, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled_review", "an AI guess is never silently 'filled'");
  assert.strictEqual(rec.after, "No");
  assert.strictEqual(rec.flag, "ai-choice-sensitive", "'over the age of 18' is legally-loaded → the sensitive flag");
  assert.strictEqual(rec.confidence, "high", "the AI's self-reported confidence is carried");
  assert.match(rec.detail, /enrolled student/, "the justification (its basis) is in the detail");
  assert.ok(act.log.some(([m]) => m === "llm") && act.log.some(([m]) => m === "clickDropdownOptionByText"));
  const e = buildReviewBundle(out.results, {}).entries[0];
  assert.strictEqual(e.needs_review, true, "filled_review surfaces in NEEDS REVIEW (top of the viewer)");
  assert.strictEqual(e.flag, "ai-choice-sensitive", "flag PERSISTED → the viewer keys sensitive-prominence off it");
  assert.strictEqual(e.needs_review_reason, "ai_inferred_sensitive");
  assert.strictEqual(e.confidence, "high", "AI confidence surfaced in the bundle");
  assert.strictEqual(e.confidence_source, "ai_inference");
  assert.strictEqual(e.current_value, "No");
});

test("AI fallback: a literal UNKNOWN reply is just a non-option → needs_review (ai-nomatch), blank, no commit (the gate is dropped — guess, don't refuse)", async () => {
  const act = makeFakeAct([aiDd({ label: "Favorite color?" })], { aiEnabled: true, ai: '{"choice":"UNKNOWN","justification":"no basis","confidence":"Low"}' });
  const rec = (await drivePageFill(act, {}, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.after, null, "blank — UNKNOWN matched no option");
  assert.strictEqual(rec.flag, "ai-nomatch");
  assert.strictEqual(rec.confidence, "low", "carries the AI's confidence even on a non-match");
  assert.ok(!act.log.some(([m]) => m === "clickDropdownOptionByText"), "never committed");
});

test("AI fallback: LLM choice not among the options → needs_review (ai-nomatch), never blind-commit", async () => {
  const act = makeFakeAct([aiDd({ label: "Favorite color?" })], { aiEnabled: true, ai: '{"choice":"Maybe","justification":"unsure","confidence":"Medium"}' });
  const rec = (await drivePageFill(act, {}, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.flag, "ai-nomatch");
  assert.strictEqual(rec.after, null);
  assert.ok(!act.log.some(([m]) => m === "clickDropdownOptionByText"), "a non-option reply is never committed");
});

test("AI fallback HOLD 2: a non-option choice + a value STRAYS on close → ai-nomatch-stray surfaces the STRAYED value (never a false blank)", async () => {
  const act = makeFakeAct([aiDd({ label: "Favorite color?", strayValueOnEscape: "No" })], { aiEnabled: true, ai: '{"choice":"UNKNOWN","justification":"no basis","confidence":"Low"}' });
  const rec = (await drivePageFill(act, {}, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.flag, "ai-nomatch-stray");
  assert.strictEqual(rec.after, "No", "reports the TRUE page state (the strayed value), NOT a clean 'blank, please answer'");
  assert.match(rec.detail, /STRAYED/);
});

test("AI: sensitive-vs-not prominence DATA — both flags + distinct reasons persist (the viewer partitions on the flag, not confidence)", async () => {
  const act = makeFakeAct([
    aiDd({ wrapperSel: "[w-crim]", fieldName: "crim_q", label: "Have you been convicted of a criminal offence?", options: [{ text: "Select One", disabled: true }, { text: "Yes" }, { text: "No" }] }),
    aiDd({ wrapperSel: "[w-pref]", fieldName: "pref_q", label: "Preferred shift?", options: [{ text: "Select One", disabled: true }, { text: "Day" }, { text: "Night" }] })
  ], { aiEnabled: true, ai: '{"choice":"No","justification":"x","confidence":"High"}' });
  // both AI fields get the same canned reply; only the criminal one matches "No". Assert the flags.
  const out = await drivePageFill(act, {}, {}, {}, T_BUDGETS);
  const crim = out.results.find((r) => r.fieldName === "crim_q");
  assert.strictEqual(crim.flag, "ai-choice-sensitive", "criminal question → sensitive, even at High confidence");
  const e = buildReviewBundle(out.results, {}).entries.find((x) => x.question_label.includes("criminal"));
  assert.strictEqual(e.needs_review_reason, "ai_inferred_sensitive");
  assert.strictEqual(e.confidence, "high", "High confidence must NOT demote it — prominence is flag-driven in the viewer");
});

test("parseAiReply: plain JSON, ```-fenced, embedded, bad-confidence, and a non-JSON fallback", () => {
  assert.deepStrictEqual(parseAiReply('{"choice":"Yes","justification":"j","confidence":"High"}'), { choice: "Yes", justification: "j", confidence: "high" });
  assert.strictEqual(parseAiReply('```json\n{"choice":"No","confidence":"Low"}\n```').choice, "No");
  assert.strictEqual(parseAiReply('Here is my answer: {"choice":"Maybe","confidence":"Medium"}').confidence, "medium");
  assert.strictEqual(parseAiReply('{"choice":"X","confidence":"bogus"}').confidence, "low", "unknown confidence → low");
  const fb = parseAiReply("just No"); assert.strictEqual(fb.choice, "just No"); assert.strictEqual(fb.confidence, "low");
});

// ── AI-2: free-text / essay fill (fake act.llm) ──────────────────────────────
const GEN_ON = { autofill_rules: { generation_allowed_only_for: ["application_questions.open_ended"] }, application_questions: { writing_style: "plain professional first person" } };
const aiText = (flags) => Object.assign({
  wrapperSel: "[w-essay]", fieldName: "whyUs", widgetType: "text", isRequired: true, label: "Why do you want to work here?", value: ""
}, flags || {});

test("parseAiText: {answer}, {skip,reason}, bare SKIP, ```-fenced, and non-JSON → whole reply is the answer", () => {
  assert.deepStrictEqual(parseAiText('{"answer":"I admire the mission."}'), { skip: false, answer: "I admire the mission.", reason: "" });
  assert.deepStrictEqual(parseAiText('{"skip":true,"reason":"asks for an ID"}'), { skip: true, answer: "", reason: "asks for an ID" });
  assert.strictEqual(parseAiText('```json\n{"answer":"Hello"}\n```').answer, "Hello");
  assert.strictEqual(parseAiText("SKIP").skip, true);
  assert.deepStrictEqual(parseAiText("a plain prose answer"), { skip: false, answer: "a plain prose answer", reason: "" });
});

test("AI-2: generated answer → filled_review + ai-text + the prose typed (NEVER silent)", async () => {
  const act = makeFakeAct([aiText()], { aiEnabled: true, ai: '{"answer":"I am drawn to your robotics work, which matches my CAN-bus and ROS 2 experience."}' });
  const rec = (await drivePageFill(act, GEN_ON, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(rec.status, "filled_review");
  assert.strictEqual(rec.flag, "ai-text");
  assert.match(rec.after, /robotics work/);
  assert.ok(act.log.some(([m]) => m === "typeText"), "the answer was typed into the field");
});

test("AI-2: OPTIONAL field the AI SKIPs → needs_review BLANK (ai-text-skip), no fill", async () => {
  const act = makeFakeAct([aiText({ isRequired: false })], { aiEnabled: true, ai: '{"skip":true,"reason":"asks for a specific ID not in the profile"}' });
  const rec = (await drivePageFill(act, GEN_ON, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.flag, "ai-text-skip");
  assert.strictEqual(rec.after, null, "optional → blank is safe (doesn't halt the walk)");
});

test("AI-2 PRINCIPLE: a REQUIRED field the AI SKIPs → conspicuous placeholder, never blank (walk reaches review; submit hard-blocks)", async () => {
  const act = makeFakeAct([aiText({ isRequired: true })], { aiEnabled: true, ai: '{"skip":true,"reason":"asks for a specific employee ID"}' });
  const rec = (await drivePageFill(act, GEN_ON, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(rec.status, "filled_review", "non-blank so the walk advances");
  assert.strictEqual(rec.flag, "ai-text-needs-answer");
  assert.match(rec.after, /^\[NEEDS YOUR ANSWER/, "a detectable, conspicuous placeholder is filled");
  // the placeholder is detectable by the submit-precondition seam
  const { unreplacedPlaceholders } = require("../lib.js");
  const entries = buildReviewBundle((await drivePageFill(makeFakeAct([aiText()], { aiEnabled: true, ai: '{"skip":true,"reason":"x"}' }), GEN_ON, {}, {}, T_BUDGETS)).results, {}).entries;
  assert.strictEqual(unreplacedPlaceholders(entries).length, 1, "the bundle entry is detected as an unreplaced placeholder (submit-blocked)");
});

test("AI-2: generation OFF (empty autofill_rules) ⇒ act.llm NEVER called; required → placeholder, optional → skip", async () => {
  const GEN_OFF = { autofill_rules: { generation_allowed_only_for: [] } };
  const reqAct = makeFakeAct([aiText({ isRequired: true })], { aiEnabled: true, ai: '{"answer":"should not be used"}' });
  const reqRec = (await drivePageFill(reqAct, GEN_OFF, {}, {}, T_BUDGETS)).results[0];
  assert.ok(!reqAct.log.some(([m]) => m === "llm"), "generation off → the LLM is never consulted");
  assert.strictEqual(reqRec.flag, "ai-text-needs-answer", "required still gets a placeholder (walk advances)");
  const optAct = makeFakeAct([aiText({ isRequired: false })], { aiEnabled: true, ai: '{"answer":"x"}' });
  const optRec = (await drivePageFill(optAct, GEN_OFF, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(optRec.flag, "ai-text-skip");
  assert.strictEqual(optRec.after, null);
});

test("AI-2: a MAPPED text field fills deterministically and NEVER reaches the AI hook", async () => {
  const act = makeFakeAct([{ wrapperSel: "[w-city]", fieldName: "city", widgetType: "text", isRequired: true, label: "City", value: "" }], { aiEnabled: true, ai: '{"answer":"nope"}' });
  const rec = (await drivePageFill(act, Object.assign({ personal_info: { city: "Tallahassee" } }, GEN_ON), {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "Tallahassee");
  assert.ok(!act.log.some(([m]) => m === "llm"), "a mapped text field never reaches AI-2 (producedNothing is false)");
});

test("AI-2: an unmapped flat TEXTAREA routes to aiFillText and fills", async () => {
  const act = makeFakeAct([aiText({ wrapperSel: "[w-ta]", fieldName: "coverLetter", widgetType: "textarea", label: "Cover letter" })], { aiEnabled: true, ai: '{"answer":"Dear team, I would love to join."}' });
  const rec = (await drivePageFill(act, GEN_ON, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(rec.status, "filled_review");
  assert.strictEqual(rec.flag, "ai-text");
  assert.match(rec.after, /Dear team/);
});

test("AI-2 submit-belt: isAiPlaceholder + unreplacedPlaceholders (the CHECKED submit precondition)", () => {
  const { isAiPlaceholder, unreplacedPlaceholders } = require("../lib.js");
  assert.ok(isAiPlaceholder("[NEEDS YOUR ANSWER — AI declined: x]"));
  assert.ok(!isAiPlaceholder("a real answer"));
  assert.ok(!isAiPlaceholder(null));
  const entries = [
    { flag: "ai-text-needs-answer", current_value: "[NEEDS YOUR ANSWER — AI declined: x]" }, // still a placeholder → blocks
    { flag: "ai-text-needs-answer", current_value: "the human replaced it" },                 // replaced → no longer blocks
    { flag: "ai-text", current_value: "a generated answer" }                                  // not a placeholder field
  ];
  assert.strictEqual(unreplacedPlaceholders(entries).length, 1, "only the still-unreplaced placeholder blocks submit");
});

// ── AI-3: self-identification (EEO) + agreements (deterministic) + canonicalization ──────────
const genderField = (flags) => Object.assign({
  wrapperSel: "[w-gender]", fieldName: "gender", widgetType: "dropdown", isRequired: false,
  label: "What is your gender?",
  triggerText: "Select One", options: [{ text: "Select One", disabled: true }, { text: "Female" }, { text: "Male" }, { text: "Other" }, { text: "Undeclared" }]
}, flags || {});
const consentField = (flags) => Object.assign({
  wrapperSel: "[w-consent]", fieldName: "acceptTermsAndAgreements", widgetType: "checkbox", isRequired: true,
  label: "Yes, I have read and consent to the above terms and condition.", inputId: "c-1", checked: false
}, flags || {});

test("AI-3: gender fills DETERMINISTICALLY from self_identification (exact-match, NO AI even with AI ON)", async () => {
  const act = makeFakeAct([genderField()], { aiEnabled: true, ai: '{"choice":"should not be used"}' });
  const rec = (await drivePageFill(act, { self_identification: { gender: "Male" } }, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "Male");
  assert.ok(!act.log.some(([m]) => m === "llm"), "an EEO field that matches deterministically NEVER calls the LLM");
});

test("AI-3: a REQUIRED consent AUTO-CHECKS silently (filled, NOT flagged) even when the profile is null; an explicit profile `false` is respected", async () => {
  const f1 = consentField();
  const a1 = makeFakeAct([f1], { aiEnabled: true });
  const r1 = (await drivePageFill(a1, { agreements: { terms_and_conditions_acceptance: null } }, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(r1.status, "filled", "required consent auto-checks even when the profile is null");
  assert.notStrictEqual(r1.status, "filled_review", "NOT flagged for review (silent)");
  assert.strictEqual(f1.checked, true, "the box is actually checked");
  const f2 = consentField();
  const a2 = makeFakeAct([f2], { aiEnabled: true });
  await drivePageFill(a2, { agreements: { terms_and_conditions_acceptance: false } }, {}, {}, T_BUDGETS);
  assert.strictEqual(f2.checked, false, "an explicit profile `false` is respected — the consent is NOT auto-checked");
  assert.ok(!a1.log.concat(a2.log).some(([m]) => m === "llm"), "consents never involve the LLM");
});

test("AI-3 CANONICALIZATION: stated 'Male' vs a form's odd vocab → AI maps the KNOWN value (filled_review/ai-canonicalized)", async () => {
  const act = makeFakeAct([genderField({ options: [{ text: "Select One", disabled: true }, { text: "Man" }, { text: "Woman" }, { text: "Nonbinary" }] })], { aiEnabled: true, ai: '{"choice":"Man","confidence":"High"}' });
  const rec = (await drivePageFill(act, { self_identification: { gender: "Male" } }, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(rec.status, "filled_review");
  assert.strictEqual(rec.flag, "ai-canonicalized");
  assert.strictEqual(rec.after, "Man");
  assert.match(rec.detail, /canonicalized/);
  assert.ok(act.log.some(([m]) => m === "llm"), "canonicalization consulted the LLM with the KNOWN value");
});

test("AI-3 CANONICALIZATION: AI can't map the stated value to any option → needs_review (ai-canon-nomatch), never blind-commit", async () => {
  const act = makeFakeAct([genderField({ options: [{ text: "Select One", disabled: true }, { text: "Man" }, { text: "Woman" }] })], { aiEnabled: true, ai: '{"choice":"UNKNOWN"}' });
  const rec = (await drivePageFill(act, { self_identification: { gender: "Male" } }, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.flag, "ai-canon-nomatch");
  assert.strictEqual(rec.after, null);
});

test("AI-3 EEO: an OPTIONAL unmapped EEO field → blank, act.llm NEVER called; a MANDATORY one → the EEO inference runs", async () => {
  // OPTIONAL EEO, no value → blank, no LLM (a blank optional doesn't block the walk).
  const opt = makeFakeAct([genderField({ fieldName: "genderIdentity", label: "Gender identity", isRequired: false })], { aiEnabled: true, ai: '{"choice":"Male","confidence":"High"}' });
  const optRec = (await drivePageFill(opt, {}, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(optRec.status, "skipped");
  assert.ok(!opt.log.some(([m]) => m === "llm"), "optional EEO with no value → never calls the LLM");
  // MANDATORY EEO, no value → the EEO inference runs (would block otherwise).
  const req = makeFakeAct([genderField({ fieldName: "genderIdentity", label: "Gender identity", isRequired: true })], { aiEnabled: true, ai: '{"choice":"Male","confidence":"High"}' });
  const reqRec = (await drivePageFill(req, {}, {}, {}, T_BUDGETS)).results[0];
  assert.ok(req.log.some(([m]) => m === "llm"), "a MANDATORY unmapped EEO field → the AI EEO inference runs");
  assert.strictEqual(reqRec.flag, "ai-eeo-guess");
  assert.strictEqual(reqRec.after, "Male");
  assert.strictEqual(reqRec.status, "filled_review");
});

test("AI-3 EEO inference: high-confidence guess commits (ai-eeo-guess); low-confidence or a chosen decline → neutral (eeo_declined)", async () => {
  const opts = [{ text: "Select One", disabled: true }, { text: "Female" }, { text: "Male" }, { text: "Undeclared" }];
  // low confidence → NOT committed as a guess; falls back to the neutral decline ("Undeclared")
  const lo = makeFakeAct([genderField({ fieldName: "g2", label: "Gender", isRequired: true, options: opts })], { aiEnabled: true, ai: '{"choice":"Male","confidence":"Low"}' });
  const loRec = (await drivePageFill(lo, {}, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(loRec.flag, "eeo_declined", "a low-confidence demographic guess is NOT committed");
  assert.strictEqual(loRec.after, "Undeclared");
  assert.strictEqual(loRec.status, "filled_review");
  // the AI choosing to decline → eeo_declined
  const dec = makeFakeAct([genderField({ fieldName: "g3", label: "Gender", isRequired: true, options: opts })], { aiEnabled: true, ai: '{"choice":"Undeclared","confidence":"High"}' });
  const decRec = (await drivePageFill(dec, {}, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(decRec.flag, "eeo_declined");
  assert.strictEqual(decRec.after, "Undeclared");
});

test("AI INVARIANT: toggle OFF ⇒ act.llm NEVER called (no spend; stays deterministic)", async () => {
  const act = makeFakeAct([aiDd()], { aiEnabled: false, ai: "No" });
  const out = await drivePageFill(act, {}, {}, {}, T_BUDGETS);
  assert.ok(!act.log.some(([m]) => m === "llm"), "AI OFF → the LLM is never consulted");
  assert.strictEqual(out.results[0].status, "skipped", "stays the deterministic skipped (no mapping)");
});

test("AI INVARIANT: the screening-question INFERENCE never touches an EEO field — an OPTIONAL EEO dropdown ⇒ act.llm NEVER called", async () => {
  // aiEligible excludes EEO from the screening inference; an OPTIONAL EEO field also doesn't hit the
  // AI-3 mandatory-EEO inference (which requires isRequired) → no LLM at all. (A MANDATORY EEO field
  // DOES call the eeo-infer path — covered by the AI-3 EEO tests.)
  const act = makeFakeAct([aiDd({ label: "What is your gender?", isRequired: false })], { aiEnabled: true, ai: "Male" });
  const out = await drivePageFill(act, {}, {}, {}, T_BUDGETS);
  assert.ok(!act.log.some(([m]) => m === "llm"), "an optional protected EEO field is never AI-touched");
  assert.strictEqual(out.results[0].status, "skipped");
});

test("AI INVARIANT: prev-worker / file_upload / radio / EEO never AI-eligible; dropdown + text/textarea ARE (AI-2 extends to free-text)", () => {
  assert.strictEqual(aiEligible({ widgetType: "dropdown", fieldName: "candidateIsPreviousWorker", label: "Have you worked here?" }), false);
  assert.strictEqual(aiEligible({ widgetType: "file_upload", fieldName: "resume", label: "Resume" }), false);
  assert.strictEqual(aiEligible({ widgetType: "radio", fieldName: "x", label: "Pick one" }), false);
  assert.strictEqual(aiEligible({ widgetType: "dropdown", fieldName: "gender", label: "What is your gender?" }), false, "EEO never AI (any widget)");
  assert.strictEqual(aiEligible({ widgetType: "text", fieldName: "disabilityStatus", label: "Disability status" }), false, "EEO label blocks even text");
  assert.strictEqual(aiEligible({ widgetType: "dropdown", fieldName: "screen_q", label: "Eligible to work in Canada?" }), true);
  assert.strictEqual(aiEligible({ widgetType: "text", fieldName: "whyUs", label: "Why us?" }), true, "free-text now eligible (AI-2)");
  assert.strictEqual(aiEligible({ widgetType: "textarea", fieldName: "coverLetter", label: "Cover letter" }), true);
});

test("legallyLoaded matches all 4 Magna labels incl. 'over the age of 18'; benign label does not", () => {
  assert.ok(legallyLoaded("Are you currently employed with Magna?"));
  assert.ok(legallyLoaded("Are you eligible to work in Canada?"));
  assert.ok(legallyLoaded("Are you over the age of 18?"), "the recon-caught gap");
  assert.ok(legallyLoaded("Have you been convicted of a criminal offence for which a pardon has not been granted?"));
  assert.ok(!legallyLoaded("What is your favorite color?"));
});

test("closeAndVerifyBlank: stayed-blank → {blank:true}; strayed-on-close → {blank:false, after:<strayed value>}", async () => {
  const clean = makeFakeAct([aiDd()]);
  await clean.openDropdown({ wrapperSel: "[w-ai]" });
  assert.deepStrictEqual(await closeAndVerifyBlank(clean, { wrapperSel: "[w-ai]" }, "Select One", T_BUDGETS), { blank: true, after: "Select One" });
  const dirty = makeFakeAct([aiDd({ strayValueOnEscape: "No" })]);
  await dirty.openDropdown({ wrapperSel: "[w-ai]" });
  const r = await closeAndVerifyBlank(dirty, { wrapperSel: "[w-ai]" }, "Select One", T_BUDGETS);
  assert.strictEqual(r.blank, false);
  assert.strictEqual(r.after, "No", "the verified-blank close reports the strayed truth, never a false blank");
});

test("closeAndVerifyBlank REGRESSION (the live false-stray): list slow / won't close but value stays the placeholder → {blank:true}, NOT a stray", async () => {
  // The live Q2/Q3/Q4 bug: a blank field whose list was slow to dismiss got mislabeled a stray.
  // Value-based blank is the fix — list-open does NOT mean a value strayed (Confirm #1 + the
  // ariaExpanded gate / reopen-toggle that ping-ponged are gone).
  const stuck = makeFakeAct([aiDd({ escapeWontClose: true })]);
  await stuck.openDropdown({ wrapperSel: "[w-ai]" });
  const r = await closeAndVerifyBlank(stuck, { wrapperSel: "[w-ai]" }, "Select One", T_BUDGETS);
  assert.strictEqual(r.blank, true, "value === placeholder ⇒ blank, regardless of the list still being open");
  assert.strictEqual(r.after, "Select One");
});

test("AI fallback REGRESSION: a non-option choice with a slow-to-close list (value stays placeholder) → ai-nomatch BLANK, not a false ai-nomatch-stray", async () => {
  const act = makeFakeAct([aiDd({ label: "Favorite color?", escapeWontClose: true })], { aiEnabled: true, ai: '{"choice":"UNKNOWN","justification":"no basis","confidence":"Low"}' });
  const rec = (await drivePageFill(act, {}, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.flag, "ai-nomatch", "a blank field whose list was slow to close is reported clean, not STRAYED");
  assert.strictEqual(rec.after, null);
});

test("dropdown: commit shows the target then REVERTS (pick before render-complete) → needs_review, never a false verified:true", async () => {
  // The live silent wrong-fill: the trigger flashed the target (the inline verify caught that
  // instant) then the page DISCARDED the pick (degree Bachelors→Associates; proficiencies →Basic).
  // The commit PERSISTENCE guard must re-read after a real-time beat and reject a value that
  // didn't stick — the one failure mode the whole safety contract exists to prevent.
  const act = makeFakeAct([ddField({ revertsAfterCommit: true, revertValue: "Associates" })]);
  const out = await drivePageFill(act, usProfile, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "needs_review", "a pick that doesn't persist is NEVER reported filled");
  assert.match(rec.detail, /commit failed/);
  assert.strictEqual(rec.after, "Associates", "surfaces the reverted (actual) value, not the momentary target");
});

// ── text reactive read-back (laggy wifi: poll until the COMPLETE value reads back) ──

const cityField = (flags) => Object.assign({ wrapperSel: "[w-city]", fieldName: "city", widgetType: "text", label: "City", value: "" }, flags || {});
const cityProfile = { personal_info: { city: "Pittsburgh" } };

test("text: read-back LAGS (value registers only after several reads) → reactive poll WAITS, then fills", async () => {
  const act = makeFakeAct([cityField({ valueAfterReads: 5 })]);
  const out = await drivePageFill(act, cityProfile, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "Pittsburgh");
});

test("text: value NEVER registers within the ceiling → needs_review, never a false fill", async () => {
  // Infinity (not a big finite count): act.delay is instant in tests, so the poll spins many
  // iterations within the ceiling — a finite valueAfterReads would eventually register and
  // flip the result to filled (flaky). Infinity → _readsLeft never decrements to the swap.
  const act = makeFakeAct([cityField({ valueAfterReads: Infinity })]);
  const out = await drivePageFill(act, cityProfile, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.match(rec.detail, /read-back mismatch/);
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

// ── FoS capture (single-open): scrape BEFORE the candidate loop, the loop's ensureSearchFocused cleans up ──
// Corrected design: opts.onCapture scrapes the full option list BEFORE the loop, so the loop's existing
// ensureSearchFocused — the LAST focus action immediately before clear/type — is the sole re-assert.
// Load-bearing: nothing focus-dropping between the scrape and the loop, NOR between the loop's focus and
// typeInSearch. (The fake can't model the live async blur — these pin the call STRUCTURE that prevents it.)
const TA_LOC = { wrapperSel: "[w-ta]" };
const FOS_FULL = ["Accounting", "Biology", "Economics", "Other", "Religion"];

test("capture single-open: onCapture scrapes BEFORE the loop's first clearSearch (and commits the typed value)", async () => {
  const f = taField({ scrapeOptions: FOS_FULL, filterMap: { "Other": { autoCommit: "Other" } } });
  const act = makeFakeAct([f]);
  let scraped = null;
  const onCapture = async () => { const sc = await act.scrapeTaOptions(TA_LOC); if (sc.ok) scraped = sc.options.slice(); };
  const rec = await fillTypeaheadCdp(act, TA_LOC, ["Other"], T_BUDGETS, { onCapture });
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "Other");                 // commits the typed value, no stray
  assert.deepStrictEqual(scraped, FOS_FULL);              // the scrape ran + captured the full list
  const idx = (m) => act.log.findIndex(([x]) => x === m);
  assert.ok(idx("scrapeTaOptions") >= 0 && idx("scrapeTaOptions") < idx("clearSearch"), "scrape ran BEFORE the first clearSearch (i.e. before the candidate loop)");
});

test("capture single-open: the loop's re-assert is AFTER the scrape, with ONLY clearSearch before typeInSearch (the invariant)", async () => {
  // dropsFocusOnScrape models the scroll dropping focus → the loop's ensureSearchFocused must re-focus
  // (focusSearchBox) before clear/type, with the scrape strictly before that re-assert and NOTHING
  // focus-dropping between the re-assert and the type.
  const f = taField({ dropsFocusOnScrape: true, scrapeOptions: FOS_FULL, filterMap: { "Other": { autoCommit: "Other" } } });
  const act = makeFakeAct([f]);
  const onCapture = async () => { await act.scrapeTaOptions(TA_LOC); };
  const rec = await fillTypeaheadCdp(act, TA_LOC, ["Other"], T_BUDGETS, { onCapture });
  assert.strictEqual(rec.after, "Other");                 // the re-assert recovered focus → typed value commits
  const seq = act.log.map(([m]) => m);
  const typeIdx = seq.indexOf("typeInSearch");
  const reassertIdx = seq.lastIndexOf("focusSearchBox", typeIdx); // the loop's focus re-assert
  assert.ok(seq.indexOf("scrapeTaOptions") < reassertIdx, "scrape is BEFORE the loop's focus re-assert");
  assert.ok(reassertIdx >= 0 && reassertIdx < typeIdx, "re-assert is immediately before the type");
  assert.deepStrictEqual(seq.slice(reassertIdx + 1, typeIdx).filter((m) => m !== "clearSearch"), [], "ONLY clearSearch between the re-assert and the type — no scrape/read/settle in that gap");
});

test("capture single-open: no onCapture → no scrape (4-arg callers / non-tagged typeaheads unaffected)", async () => {
  const f = taField({ scrapeOptions: FOS_FULL, filterMap: { "Other": { autoCommit: "Other" } } });
  const act = makeFakeAct([f]);
  const rec = await fillTypeaheadCdp(act, TA_LOC, ["Other"], T_BUDGETS); // no opts
  assert.strictEqual(rec.after, "Other");
  assert.ok(!act.log.some(([m]) => m === "scrapeTaOptions"), "no scrape without onCapture");
});

// ── keptLowerTier RE-COMMIT: focus-safe re-type (the REAL FoS stray fix) ──────────────────────
// cand-0's empty-results (0 options) DROPS searchBox focus; the re-commit (overwriteNoMatchResting→
// recommitFn) must re-verify focus IMMEDIATELY before its re-type and NEVER pressEnter on a
// partial/unfocused box (Enter commits the highlighted listbox row — the live "Healthcare" stray).
// Field: pre-filled tier-1 "Other"; cand-0 "X" no-matches (0 options) → re-commit "Other".
const reField = (flags) => taField(Object.assign({ chips: ["Other"], filterMap: { "X": { filtered: [] }, "Other": { autoCommit: "Other" } } }, flags || {}));

test("keptLowerTier re-commit: empty-results drops focus → the re-commit RE-FOCUSES + lands the kept value", async () => {
  const act = makeFakeAct([reField({ dropsFocusAfterEmpty: true })]);
  const out = await drivePageFill(act, taProfile(["X", "Other"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "Other");                          // recovered → committed the kept value, NO stray
  assert.strictEqual(rec.flag, "prefilled-better-tier-unavailable");
  assert.ok(act.log.some(([m]) => m === "focusSearchBox"), "the re-commit re-focused the dropped searchBox before re-typing");
});

test("keptLowerTier re-commit: focus UNRECOVERABLE → needs_review, NEVER pressEnter on the unfocused re-type (invariant)", async () => {
  const act = makeFakeAct([reField({ dropsFocusAfterEmpty: true, focusUnrecoverableAfterEmpty: true })]);
  const out = await drivePageFill(act, taProfile(["X", "Other"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "needs_review");                  // couldn't hold focus → honest, no stray committed
  assert.strictEqual(enters(act), 1, "only cand-0's filter-Enter — the re-commit NEVER pressed Enter on the unfocused box (which would commit the highlighted stray)");
});

// ── the operator's two re-commit guards (no disarm; affirmative click is the committing action) ──
test("keptLowerTier re-commit: filter-Enter strays the chip (armed row-0) → the AFFIRMATIVE clickTaOption OVERWRITES it back to the kept value → filled", async () => {
  // The settled re-type's filter-Enter commits the armed row-0 ("Accounting") while the "Other" list stays
  // open — the affirmative clickTaOption("Other") is a real selection that OVERWRITES the stray (no disarm).
  const act = makeFakeAct([reField({ filterMap: { "X": { filtered: [] }, "Other": { filtered: ["Other", "Other Technology"], strayChip: "Accounting" } } })]);
  const out = await drivePageFill(act, taProfile(["X", "Other"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "Other");
  assert.strictEqual(rec.flag, "prefilled-better-tier-unavailable");
  assert.ok(act.log.some(([m, t]) => m === "clickTaOption" && t === "Other"), "the affirmative click overwrote the stray with the kept value");
});

test("keptLowerTier re-commit STRAY GUARD: a stray the click can't overwrite → needs_review with the HONEST live after (never silent, never [])", async () => {
  // The filter-Enter commits a STRAY ("Accounting") and CLOSES the list, so clickTaOption("Other") can't reach
  // the leaf. The chip is neither "Other" nor empty → must surface needs_review/overwrite-stray with the LIVE
  // value (not a false "Other", not a [] that would hide "Accounting" from the record + the M40 audit).
  const act = makeFakeAct([reField({ filterMap: { "X": { filtered: [] }, "Other": { autoCommit: "Accounting" } } })]);
  const out = await drivePageFill(act, taProfile(["X", "Other"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.flag, "overwrite-stray");
  assert.strictEqual(rec.after, "Accounting");                     // HONEST live value, never a false "Other"
});

// ── awaitListTerminal: the terminal-state gate (banner or autocommit ONLY; bannerless = NOT terminal) ──
const TERM_ACT = { delay: async () => {} };
const noNewChip = () => false;            // no new chip vs priorChips (the empty/no-match cases)
const anyChip = (chips) => chips.length > 0; // empty field: any chip is a NEW chip
test("awaitListTerminal (a): no-match banner + stable count → 'nomatch'", async () => {
  const read = async () => ({ banner: { text: "No matches found" }, resultsBanner: false, pageWide: { count: 15 }, searchBox: { visible: true }, chips: [] });
  assert.strictEqual(await awaitListTerminal(TERM_ACT, read, { wrapperSel: "[w]" }, T_BUDGETS, noNewChip), "nomatch");
});

test("awaitListTerminal (b): results banner + stable non-zero count → 'results'", async () => {
  const read = async () => ({ banner: null, resultsBanner: true, pageWide: { count: 5 }, searchBox: { visible: true }, chips: [] });
  assert.strictEqual(await awaitListTerminal(TERM_ACT, read, { wrapperSel: "[w]" }, T_BUDGETS, noNewChip), "results");
});

test("awaitListTerminal (c): a stable NON-ZERO count with NO banner is NOT terminal → polls to 'timeout' (the FoS fallback-before-the-banner)", async () => {
  let n = 0;
  const read = async () => { n++; return { banner: null, resultsBanner: false, pageWide: { count: 5 }, searchBox: { visible: true }, chips: [] }; };
  assert.strictEqual(await awaitListTerminal(TERM_ACT, read, { wrapperSel: "[w]" }, T_BUDGETS, noNewChip), "timeout");
  assert.ok(n > 2, "kept polling past the steady non-zero count (never concluded 'results' without the banner)");
});

test("awaitListTerminal (d): count===0 with no banner is NOT terminal → 'timeout'", async () => {
  const read = async () => ({ banner: null, resultsBanner: false, pageWide: { count: 0 }, searchBox: { visible: true }, chips: [] });
  assert.strictEqual(await awaitListTerminal(TERM_ACT, read, { wrapperSel: "[w]" }, T_BUDGETS, noNewChip), "timeout");
});

test("awaitListTerminal (e): a NEW chip appears → 'autocommit' (checked first, immediate)", async () => {
  const read = async () => ({ banner: null, resultsBanner: false, pageWide: { count: 0 }, searchBox: { visible: true }, chips: ["LinkedIn"] });
  assert.strictEqual(await awaitListTerminal(TERM_ACT, read, { wrapperSel: "[w]" }, T_BUDGETS, anyChip), "autocommit");
});

test("awaitListTerminal (f): box closes holding a (non-new) chip → 'autocommit'", async () => {
  const read = async () => ({ banner: null, resultsBanner: false, pageWide: { count: 0 }, searchBox: { visible: false }, chips: ["Kept Value"] });
  assert.strictEqual(await awaitListTerminal(TERM_ACT, read, { wrapperSel: "[w]" }, T_BUDGETS, noNewChip), "autocommit");
});

test("awaitListTerminal: source shape (leafCount) — banner confirmation works for the source loop too (lockstep)", async () => {
  const nomatch = async () => ({ banner: { text: "No matches found" }, resultsBanner: false, leafCount: 13, searchBox: { visible: true }, chips: [] });
  const results = async () => ({ banner: null, resultsBanner: true, leafCount: 3, searchBox: { visible: true }, chips: [] });
  assert.strictEqual(await awaitListTerminal(TERM_ACT, nomatch, { wrapperSel: "[w]" }, T_BUDGETS, noNewChip), "nomatch");
  assert.strictEqual(await awaitListTerminal(TERM_ACT, results, { wrapperSel: "[w]" }, T_BUDGETS, noNewChip), "results");
});

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

test("typeahead main loop (empty field, FAILURE-DIRECTION): the post-type gate WAITS for the LATE 'Search Results' banner — never matches the transient bannerless fallback → filled 'Other'", async () => {
  // The empty-first-fill FoS bug. cand-0 "Electrical…" no-matches ("No matches found"). cand-1 "Other": the
  // filter-Enter first shows a TRANSIENT bannerless fallback list that does NOT contain "Other" (["Accounting",
  // "Zoology"]); only after N reads does the "Search Results" banner + the REAL ["Other", …] list land.
  // awaitListTerminal must WAIT for the results banner; if it concluded on the bannerless transient it would
  // match the WRONG list (no "Other" → no commit). filled "Other" + outcome "results" PROVES the gate waited —
  // it FAILS without the render gate (the old bannerless "filtered" would conclude on the transient → no-match).
  const f = taField({
    fallbackTexts: ["Accounting", "Zoology"], // the transient bannerless list (NO "Other")
    filterMap: {
      "Electrical and Computer Engineering": { banner: true },
      "Other": { filtered: ["Other", "Other Technology"], lateResultsBanner: 4 }
    }
  });
  const out = await drivePageFill(makeFakeAct([f]), taProfile(["Electrical and Computer Engineering", "Other"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "Other");
  assert.strictEqual(rec.settle_trace[1].outcome, "results", "cand-1 concluded on the 'Search Results' banner terminal, never the bannerless transient");
});

test("typeahead walk (combined Step 4 + Step 3, the real FoS shape): tier-0 no-match resolves on 'nomatch' banner (NOT timeout/premature-results), tier-1 reaches 'results' + commits 'Other'", async () => {
  // tier-0 "Electrical…" no-matches → "No matches found"; tier-1 "Other" → "Search Results" + matches. Exercises
  // the BETWEEN-candidates gate (Step 4) AND the post-type gate (Step 3) together. The between-candidates gate
  // MUST resolve tier-0 on "nomatch" (the banner), NOT "timeout" (which would stack 25s waits across a multi-tier
  // walk) and NOT a premature "results".
  const f = taField({
    filterMap: {
      "Electrical and Computer Engineering": { banner: true },
      "Other": { filtered: ["Other", "Other Technology"] }
    }
  });
  const out = await drivePageFill(makeFakeAct([f]), taProfile(["Electrical and Computer Engineering", "Other"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "Other");
  assert.strictEqual(rec.settle_trace[0].outcome, "nomatch", "tier-0 post-type gate concluded on the 'No matches found' banner");
  assert.strictEqual(rec.settle_trace[1].priorSettle, "nomatch", "the BETWEEN-candidates gate confirmed tier-0's no-match via the banner — NOT a timeout (latency smell), NOT a premature results");
  assert.strictEqual(rec.settle_trace[1].outcome, "results", "tier-1 reached the 'Search Results' terminal and committed");
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

test("overwrite no-match: the resting dismissal STRAYS the chip (armed row-0 race) → needs_review/overwrite-stray, NEVER a false keep", async () => {
  // The fieldOfStudy "Accounting" class: the no-match search arms row-0; if the exit/dismiss
  // commits it despite the disarm-verify, the strayed-check must FLAG the live value (not report
  // a false "kept original"). Models the stray via strayChipOnEscape.
  const field = taField({ chips: ["Canada (+1)"], filterMap: { "United States of America (+1)": { banner: true } }, strayChipOnEscape: "Accounting" });
  const act = makeFakeAct([field]);
  const out = await drivePageFill(act, taProfile(["United States of America (+1)"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.flag, "overwrite-stray", "a strayed dismissal is flagged, not a false keep");
  assert.strictEqual(rec.after, "Accounting", "surfaces the LIVE strayed value, not the original");
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

test("M36.1 typeahead k>0: nothing higher offered → RE-COMMIT the kept pre-fill (prefilled-better-tier-unavailable)", async () => {
  // Pre-fill = tier-1 "Other"; tier-0 NOT offered → "Other" is the best available. The fix
  // AFFIRMATIVELY RE-COMMITS it (race-proof vs the armed-row-0 stray that the old dismiss-and-
  // hope left): searches tier-0 (miss) THEN re-commits its own tier, ending filled/
  // prefilled-better-tier-unavailable on a DELIBERATE commit (the fieldOfStudy "Accounting" fix).
  const field = taField({
    chips: ["Other"],
    filterMap: { "Electrical and Computer Engineering": { banner: true }, "Other": { autoCommit: "Other" } } // tier-0 not offered; the kept tier re-commits
  });
  const act = makeFakeAct([field]);
  const out = await drivePageFill(act, taProfile(["Electrical and Computer Engineering", "Other", "computer engineering"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.flag, "prefilled-better-tier-unavailable");
  assert.strictEqual(rec.after, "Other", "the kept tier — re-committed");
  assert.deepStrictEqual(field.chips, ["Other"], "ends on a DELIBERATE commit of Other (the affirmative re-commit)");
  assert.deepStrictEqual(taTypedQueries(act), ["Electrical and Computer Engineering", "Other"], "searched the higher tier (miss) THEN re-committed its own tier (the fix)");
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

test("typeahead: searchBox focus RACES on the first try → open/focus retry RECOVERS, commits", async () => {
  // The live fast-fill "could not focus the search field" (it WORKED slow/hidden) — a
  // fast open/focus raced the prior re-render. The bounded open+focus retry must recover
  // and commit, not abort. focusRaces = focus confirms on the 2nd focusSearchBox call.
  const act = makeFakeAct([taField({
    focusRaces: true,
    openTexts: ["United States of America (+1)"],
    filterMap: { "United States of America (+1)": { autoCommit: "United States of America (+1)" } }
  })]);
  const out = await drivePageFill(act, taProfile(["United States of America (+1)"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "United States of America (+1)");
});

// ── M39.2 reactive PRE-Enter settle (poll the searchBox echo, not the filter-render) ──

test("typeahead M39.2: typed value reflects LATE → poll WAITS for the echo, THEN the filter-Enter fires + commits", async () => {
  // Laggy wifi: the searchBox value echoes the typed candidate only after several reads. The
  // pre-Enter poll must WAIT for the COMPLETE candidate to land before pressing Enter (else the
  // filter runs on partial text). The filter-Enter must fire exactly once, after the echo.
  const act = makeFakeAct([taField({
    searchValueLagReads: 6,
    openTexts: ["United States of America (+1)"],
    filterMap: { "United States of America (+1)": { autoCommit: "United States of America (+1)" } }
  })]);
  const out = await drivePageFill(act, taProfile(["United States of America (+1)"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "United States of America (+1)");
  assert.strictEqual(enters(act), 1, "exactly one filter-Enter, fired AFTER the echo landed");
});

test("main loop echo-guard (supersedes M39.2 proceed-to-Enter): echo NEVER confirms → needs_review, NEVER pressEnter on an unverified value", async () => {
  // Lock-down 2 (lockstep with the recommit): the main loop ECHO-VERIFIES the FULL candidate landed in the
  // FOCUSED box before the filter-Enter. If the echo never confirms (a focus-drop truncating the type — the
  // FoS "half-typed oth" stray condition), it re-focuses + re-clears + re-types (bounded) and then BAILS to
  // needs_review — it NEVER presses Enter on an unverified value (which would commit the armed listbox row).
  // This is STRUCTURALLY closed, replacing M39.2's old proceed-to-Enter (which was only probabilistically safe
  // via the post-Enter settle). A genuinely-laggy-but-landed echo is the (rare) cost — needs_review is safe.
  const act = makeFakeAct([taField({
    searchValueLagReads: Infinity,
    openTexts: ["United States of America (+1)"],
    filterMap: { "United States of America (+1)": { autoCommit: "United States of America (+1)" } }
  })]);
  const out = await drivePageFill(act, taProfile(["United States of America (+1)"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(enters(act), 0, "NEVER pressed Enter — the echo never confirmed the full value landed in a focused box");
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

test("source main loop (FAILURE-DIRECTION, lockstep): the post-type gate WAITS for the LATE 'Search Results' banner — never matches the transient bannerless leaves → filled 'LinkedIn'", async () => {
  // Lockstep mirror of the typeahead failure-direction. cand-0 "Facebook" no-matches. cand-1 "LinkedIn": the
  // filter-Enter first shows a TRANSIENT bannerless leaf list WITHOUT "LinkedIn" (["Family"]); only after N
  // reads does the "Search Results" banner + the REAL ["LinkedIn"] land. awaitListTerminal must WAIT — matching
  // the transient would find no "LinkedIn" → no commit. filled "LinkedIn" + outcome "results" PROVES the wait.
  const f = srcField({
    commitVia: "leaf", fallbackLeaves: ["Family"], // transient bannerless leaves (NO "LinkedIn")
    filterMap: {
      Facebook: { banner: true },
      LinkedIn: { filtered: ["LinkedIn"], lateResultsBanner: 4 }
    }
  });
  const act = makeFakeAct([f]);
  const rec = await fillSourceCdp(act, { wrapperSel: f.wrapperSel }, ["Facebook", "LinkedIn"], T_BUDGETS);
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "LinkedIn");
  assert.strictEqual(rec.settle_trace[1].outcome, "results", "cand-1 concluded on the 'Search Results' banner terminal, never the bannerless transient (lockstep)");
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

test("M36.1 source k>0: nothing higher offered → RE-COMMIT the kept pre-fill (prefilled-better-tier-unavailable, lockstep)", async () => {
  const field = srcField({ chips: ["Other"], filterMap: { LinkedIn: { banner: true }, "Other": { autoCommit: "Other" } } }); // tier-0 not offered; kept tier re-commits
  const { rec, act } = await runSource(field, ["LinkedIn", "Other"]);
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.flag, "prefilled-better-tier-unavailable");
  assert.strictEqual(rec.after, "Other", "the kept tier — re-committed");
  assert.deepStrictEqual(field.chips, ["Other"], "ends on a DELIBERATE commit of Other (the affirmative re-commit)");
  assert.deepStrictEqual(srcTypedQueries(act), ["LinkedIn", "Other"], "searched the higher tier (miss) THEN re-committed its own tier (the fix)");
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
  const allFields = () => [
    ...state.entries.flatMap((e) => e.fields.map((f) => ({ f, sel: selOf(e.fkit, f.fieldName) }))),
    ...(state.flatFields || []).map((f) => ({ f, sel: f.wrapperSel })) // M38 fold: flat (page-level) fields
  ];
  const byLoc = (loc) => { const hit = allFields().find((x) => x.sel === loc.wrapperSel); return hit ? hit.f : null; };
  let focusedText = null;
  let focusedInputId = null;
  let focusedSeg = null; // { f, seg } — a focused date segment (M36)
  let scanCount = 0;     // M37: a field with `appearsAtScan: N` is OMITTED until the Nth
                         // repeatingScan — models a field that REMOUNTS (WE endDate after
                         // unchecking currentlyWorkHere) so the waitForPresence poll is testable.
  return {
    log,
    delay: async () => {},
    delayFull: async () => {}, // non-adaptive (real-time) wait — instant in tests
    entryCount: async () => state.entries.length,
    // M38: scanPage = the FLAT (page-level) fields the fold's flat loop fills (default none).
    scanPage: async () => ({
      url: "fake://page", repeatingFieldCount: 0,
      fields: (state.flatFields || []).map((f) => ({
        fieldName: f.fieldName, label: f.label || f.fieldName, widgetType: f.widgetType,
        isRequired: !!f.isRequired, wrapperSel: f.wrapperSel
      }))
    }),
    repeatingScan: async () => {
      scanCount++;
      const mkEntry = (e) => {
        const visible = e.fields.filter((f) => !f.appearsAtScan || scanCount >= f.appearsAtScan);
        return {
          entryFkitId: e.fkit, deletePresent: true, deleteRect: { w: 10, h: 10, cx: 1, cy: 1 },
          fieldCount: visible.length,
          fields: visible.map((f) => ({
            fieldName: f.fieldName, automationId: "formField-" + f.fieldName,
            widgetType: f.widgetType, label: f.label || f.fieldName, isRequired: !!f.isRequired,
            hashedId: false, dateSegments: f.widgetType === "date" ? ["dateSectionYear-input"] : [],
            wrapperSel: selOf(e.fkit, f.fieldName)
          }))
        };
      };
      // Mirror REAL cdpRepeatingScan: a prefix appears in `sections` ONLY if it has ≥1
      // entry container (empty sections omitted → drives the fold's presence-gate).
      const sections = {};
      if (state.entries.length > 0) sections[state.prefix] = { entryCount: state.entries.length, entries: state.entries.map(mkEntry) };
      return { url: "fake://repeat", sectionsPresent: Object.keys(sections), sections, addButtons: state.addButtons || [] };
    },
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
    typeText: async (text) => { log.push(["typeText", text]); if (focusedSeg) focusedSeg.f.segments[focusedSeg.seg].value = String(text); else if (focusedText && !focusedText.writeFails) focusedText.value = text; }, // writeFails (M37): the write no-ops → read-back mismatch → needs_review
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

test("repeating delete-on-no-match: a GENUINE no-match (options rendered, candidate absent) deletes high→low", async () => {
  // M38 Bug B1: deleteOnNoMatch fires on a GENUINE no-match — the required dropdown's
  // options RENDERED but the candidate isn't among them (this value isn't offered).
  const mk = (fkit) => ({ fkit, fields: [{ fieldName: "x", label: "X*", widgetType: "dropdown", isRequired: true, triggerText: null, options: [{ text: "Alpha" }, { text: "Beta" }] }] });
  const state = webState({ entries: [mk("webAddress-1--null"), mk("webAddress-2--null")] });
  const fieldMap = [{ field: "x", widget: "dropdown", key: "x", path: "x" }];
  const act = makeFakeRepeatAct(state);
  const out = await driveRepeatingSectionCdp(act, {
    name: "lang", headingRegex: "x", containerPrefix: "webAddress-",
    items: [{ x: "Zzz-nomatch" }, { x: "Qqq-nomatch" }], fieldMap, deleteOnNoMatch: true
  }, T_BUDGETS);
  const delIdx = act.log.filter(([m]) => m === "clickDeleteEntry").map(([, i]) => i);
  assert.deepStrictEqual(delIdx, [1, 0]); // high→low so lower indices stay valid
  const removed = out.results.filter((r) => /removed$/.test(r.fieldName));
  assert.strictEqual(removed.length, 2);
  assert.ok(removed.every((r) => r.status === "skipped" && /entry deleted/.test(r.detail)));
});

test("M38 Bug B1: a required pick failing TRANSIENTLY (options didn't render) is KEPT + needs_review, NOT deleted", async () => {
  // The live English/Chinese loss: the language dropdown didn't render deep in a long fold
  // → deleteOnNoMatch deleted VALID data. Now a transient/infra failure (NOT a genuine
  // no-match) keeps the entry + surfaces it for review — never silently destroyed.
  const mk = (fkit) => ({ fkit, fields: [{ fieldName: "x", label: "X*", widgetType: "dropdown", isRequired: true, triggerText: null, options: [] }] }); // options never render
  const state = webState({ entries: [mk("webAddress-1--null")] });
  const fieldMap = [{ field: "x", widget: "dropdown", key: "x", path: "x" }];
  const act = makeFakeRepeatAct(state);
  const out = await driveRepeatingSectionCdp(act, {
    name: "lang", headingRegex: "x", containerPrefix: "webAddress-",
    items: [{ x: "English" }], fieldMap, deleteOnNoMatch: true
  }, T_BUDGETS);
  assert.ok(!act.log.some(([m]) => m === "clickDeleteEntry"), "a transient failure must NOT delete the entry (no data loss)");
  assert.ok(!out.results.some((r) => /removed$/.test(r.fieldName)), "no removal rec");
  const xRec = out.results.find((r) => r.fieldName === "lang[0].x");
  assert.strictEqual(xRec.status, "needs_review", "kept + surfaced for review");
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
  const focusFailsOnce = new Set(opts.focusFailsOnceFor || []); // fail focus on the FIRST call only (self-heals on the outer retry)
  const _focusFailedOnce = new Set();
  const perCharFails = new Set(opts.perCharFailsFor || []);
  const bothFail = new Set(opts.bothFailFor || []);
  const readSeq = opts.readSequenceFor || {}; // { seg: [read1, read2, ...] } — dequeue per read, last sticks (laggy/partial read-back)
  const rung = (s) => (opts.focusRungFor && opts.focusRungFor[s]) || "triple-click-display";
  return {
    log,
    delay: async () => {},
    delayFull: async () => {}, // non-adaptive (real-time) wait — instant in tests
    focusDateSegment: async (loc, seg) => {
      log.push(["focusDateSegment", seg]);
      if (focusFailsOnce.has(seg) && !_focusFailedOnce.has(seg)) { _focusFailedOnce.add(seg); focused = null; return null; }
      if (focusFails.has(seg) || !(seg in segs)) { focused = null; return null; }
      focused = seg;
      return rung(seg);
    },
    readDateSegment: async (loc, seg) => {
      if (!(seg in segs)) return null;
      // lag/partial model: return the next queued read (a partial value must NOT satisfy the
      // poll — only the complete value does); the last element repeats.
      if (readSeq[seg]) { const q = readSeq[seg]; const v = q.length > 1 ? q.shift() : q[0]; return { value: v, focused: focused === seg }; }
      return { value: segs[seg].value, focused: focused === seg };
    },
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

test("date composite: a segment reads PARTIAL then complete → poll rejects the partial, fills only on the COMPLETE value", async () => {
  // Year reads "" → "202" (parseInt 202 ≠ 2024, a partial) → "2024" (complete). The poll's
  // parseInt===val must reject "202" and wait for "2024" — the complete-state lesson.
  const segs = { Month: seg0(), Year: seg0() };
  const { rec } = await runDate(segs, { month: "12", year: "2024" }, { readSequenceFor: { Year: ["", "202", "2024"] } });
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "12/2024");
});

test("date composite: a segment never reads back the COMPLETE value (stuck partial) → needs_review, never accepted", async () => {
  const segs = { Month: seg0(), Year: seg0() };
  const { rec } = await runDate(segs, { month: "12", year: "2024" }, { readSequenceFor: { Year: ["202"] } });
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.verified, false);
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

// ── M37 Work Experience (textarea + currentlyWorkHere-first + conditional endDate) ──
// WE via the SAME driveRepeatingSectionCdp/fillEntryCdp + WORK_EXPERIENCE_MAP. New deltas:
// the `textarea` widget (roleDescription, via fillTextCdp tag="textarea"), `skipWhen`
// (endDate when currently_work_here), and `waitForPresence` (endDate remount poll).
const weEntry = (fkit, o) => {
  o = o || {};
  const fields = [
    { fieldName: "currentlyWorkHere", label: "I currently work here", widgetType: "checkbox", inputId: fkit + "-cwh", checked: !!o.cwhChecked },
    { fieldName: "jobTitle", label: "Job Title*", widgetType: "text", value: "" },
    { fieldName: "companyName", label: "Company*", widgetType: "text", value: "" },
    { fieldName: "location", label: "Location", widgetType: "text", value: "" },
    { fieldName: "startDate", label: "From*", widgetType: "date", segments: { Month: { value: "" }, Year: { value: "" } } }
  ];
  if (o.endDate !== "absent") fields.push({ fieldName: "endDate", label: "To", widgetType: "date", segments: { Month: { value: "" }, Year: { value: "" } } });
  fields.push({ fieldName: "roleDescription", label: "Role Description", widgetType: "textarea", value: "", writeFails: !!o.roleDescWriteFails });
  return { fkit, fields };
};
const weState = (entries) => ({ prefix: "workExperience-", addable: true, deletable: true, newEntry: (i) => weEntry("workExperience-new" + i, {}), entries });
const weItem = (o) => Object.assign({ job_title: "Engineer", company: "Acme", location: "NYC", currently_work_here: false, fromParsed: { year: "2020", month: "01" }, toParsed: { year: "2022", month: "06" }, bulletsText: "Did X\nDid Y" }, o || {});
const runWE = async (entries, items) => {
  const state = weState(entries);
  const act = makeFakeRepeatAct(state);
  const out = await driveRepeatingSectionCdp(act, {
    name: "workExperience", headingRegex: "work experience", containerPrefix: "workExperience-",
    items, fieldMap: WORK_EXPERIENCE_MAP, deleteOnNoMatch: false
  }, T_BUDGETS);
  return { out, act, state };
};
const weRec = (out, i, n) => out.results.find((r) => r.fieldName === "workExperience[" + i + "]." + n);

test("M37 WE: an entry fills text + currentlyWorkHere + M/Y dates + the roleDescription textarea (multi-line)", async () => {
  const { out } = await runWE([weEntry("workExperience-0--null", { cwhChecked: false })], [weItem({ bulletsText: "Led the team\nShipped v2" })]);
  assert.strictEqual(weRec(out, 0, "jobTitle").after, "Engineer");
  assert.strictEqual(weRec(out, 0, "companyName").after, "Acme");
  assert.strictEqual(weRec(out, 0, "location").after, "NYC");
  assert.strictEqual(weRec(out, 0, "currentlyWorkHere").status, "filled"); // false → false: already in desired state
  assert.strictEqual(weRec(out, 0, "startDate").status, "filled");
  assert.strictEqual(weRec(out, 0, "startDate").verified, true);
  assert.strictEqual(weRec(out, 0, "endDate").status, "filled"); // currently_work_here false → endDate fills
  const td = weRec(out, 0, "roleDescription");
  assert.strictEqual(td.status, "filled");
  assert.strictEqual(td.verified, true);
  assert.strictEqual(td.after, "Led the team\nShipped v2"); // the multi-line value — newline preserved
});

test("M37 WE: currently_work_here=true → endDate SKIPPED (skipWhen), checkbox checked, startDate still fills", async () => {
  const { out } = await runWE([weEntry("workExperience-0--null", { cwhChecked: false })], [weItem({ currently_work_here: true })]);
  const ed = weRec(out, 0, "endDate");
  assert.strictEqual(ed.status, "skipped");
  assert.match(ed.detail, /currently_work_here/);
  assert.strictEqual(weRec(out, 0, "currentlyWorkHere").after, "true"); // reconciled to checked
  assert.strictEqual(weRec(out, 0, "startDate").status, "filled");
});

test("M37 WE: endDate REMOUNTS (absent then present) — waitForPresence POLLS until present (vs error without it)", async () => {
  const mk = () => weState([{ fkit: "workExperience-0--null", fields: [
    { fieldName: "endDate", label: "To", widgetType: "date", segments: { Month: { value: "" }, Year: { value: "" } }, appearsAtScan: 3 }
  ] }]);
  const item = { toParsed: { year: "2022", month: "06" } };
  // WITHOUT waitForPresence: the first scanFd (scan 2) misses the not-yet-remounted endDate → error.
  const noWait = await driveRepeatingSectionCdp(makeFakeRepeatAct(mk()), {
    name: "workExperience", headingRegex: "work experience", containerPrefix: "workExperience-",
    items: [item], fieldMap: [{ field: "endDate", widget: "date", key: "toParsed", path: "to" }], deleteOnNoMatch: false
  }, T_BUDGETS);
  assert.strictEqual(noWait.results.find((r) => /endDate/.test(r.fieldName)).status, "error",
    "without the poll, the not-yet-remounted endDate errors (field wrapper not found)");
  // WITH waitForPresence: the bounded poll re-scans until endDate remounts (scan 3), then fills.
  const withWait = await driveRepeatingSectionCdp(makeFakeRepeatAct(mk()), {
    name: "workExperience", headingRegex: "work experience", containerPrefix: "workExperience-",
    items: [item], fieldMap: [{ field: "endDate", widget: "date", key: "toParsed", path: "to", waitForPresence: true }], deleteOnNoMatch: false
  }, T_BUDGETS);
  const ed = withWait.results.find((r) => /endDate/.test(r.fieldName));
  assert.strictEqual(ed.status, "filled", "the bounded poll found the remounted endDate");
  assert.strictEqual(ed.verified, true);
});

test("M37 WE: a roleDescription textarea write that doesn't stick → needs_review, NEVER silent filled", async () => {
  const { out } = await runWE([weEntry("workExperience-0--null", { roleDescWriteFails: true })], [weItem()]);
  const td = weRec(out, 0, "roleDescription");
  assert.strictEqual(td.status, "needs_review");
  assert.strictEqual(td.verified, false);
  assert.match(td.detail, /read-back mismatch/);
});

test("M37 WE: two entries get their OWN values (entry-scoped, no bleed)", async () => {
  const { out } = await runWE(
    [weEntry("workExperience-0--null", {}), weEntry("workExperience-1--null", {})],
    [weItem({ company: "Acme", bulletsText: "A1\nA2" }), weItem({ company: "Globex", bulletsText: "B1\nB2" })]
  );
  assert.strictEqual(weRec(out, 0, "companyName").after, "Acme");
  assert.strictEqual(weRec(out, 1, "companyName").after, "Globex");
  assert.strictEqual(weRec(out, 0, "roleDescription").after, "A1\nA2");
  assert.strictEqual(weRec(out, 1, "roleDescription").after, "B1\nB2");
});

// ── M38 Part 1: the FOLD — drivePageFill = flat fields + every PRESENT repeating section ──
// The combined fake exposes scanPage (flat fields) AND repeatingScan (sections/addButtons).
const flatFirstName = { fieldName: "legalName--firstName", widgetType: "text", value: "", wrapperSel: "[flat-firstName]" };

test("M38 fold: drivePageFill fills flat fields THEN drives each PRESENT section (items from profile[itemsKey])", async () => {
  const state = {
    prefix: "webAddress-", addable: true, deletable: true, newEntry: (i) => webEntry("webAddress-new" + i, ""),
    entries: [webEntry("webAddress-0--null", "")], flatFields: [flatFirstName]
  };
  const act = makeFakeRepeatAct(state);
  const profile = { personal_info: { first_name: "Kevin" }, websites: [{ url: "https://k.example" }] };
  const out = await drivePageFill(act, profile, {}, {}, T_BUDGETS);
  assert.strictEqual(out.results.find((r) => r.fieldName === "legalName--firstName").after, "Kevin", "flat field filled");
  const url = out.results.find((r) => r.fieldName === "website[0].url");
  assert.ok(url, "the website section was driven by the fold");
  assert.strictEqual(url.after, "https://k.example", "section item came from profile[itemsKey]");
});

test("M38 fold: a page with NO recognized repeating sections drives ZERO sections (page-1 unchanged)", async () => {
  // entries=[] → repeatingScan omits the section; addButtons=[] → no heading match → nothing driven,
  // EVEN THOUGH the profile has websites (the section just isn't on this page).
  const state = { prefix: "webAddress-", entries: [], addButtons: [], flatFields: [flatFirstName] };
  const act = makeFakeRepeatAct(state);
  const out = await drivePageFill(act, { personal_info: { first_name: "Kevin" }, websites: [{ url: "x" }] }, {}, {}, T_BUDGETS);
  assert.strictEqual(out.results.find((r) => r.fieldName === "legalName--firstName").after, "Kevin");
  assert.ok(!out.results.some((r) => /^\w+\[\d+\]\./.test(r.fieldName)), "no repeating-section results");
  assert.ok(!act.log.some(([m]) => m === "clickSectionAdd"), "no Add attempts on a section-less page");
});

test("M38 fold: a section present ONLY via an Add-button heading (create-first) IS driven", async () => {
  // 0 entry containers, but the section's Add (heading 'Websites') is on the page → drive it (create-first Add).
  const state = {
    prefix: "webAddress-", addable: true, deletable: true, newEntry: (i) => webEntry("webAddress-new" + i, ""),
    entries: [], addButtons: [{ text: "Add", nearestHeading: "Websites", rect: { cx: 1, cy: 1 } }], flatFields: []
  };
  const act = makeFakeRepeatAct(state);
  const out = await drivePageFill(act, { websites: [{ url: "https://k.example" }] }, {}, {}, T_BUDGETS);
  assert.ok(act.log.some(([m]) => m === "clickSectionAdd"), "create-first Add fired (presence via heading)");
  const url = out.results.find((r) => r.fieldName === "website[0].url");
  assert.ok(url && url.after === "https://k.example", "create-first section filled");
});

// ── M38 Part 2: the CDP review-summary bundle + write-per-page accumulation ──────────
test("M38 Part 2 buildReviewBundle: CDP results → viewer-schema entries (section recs filtered, statuses mapped)", () => {
  const results = [
    { fieldName: "workExperience.add", widgetType: "section", status: "filled", detail: "added 1" }, // op, NOT a field
    { fieldName: "legalName--firstName", widgetType: "text", status: "filled", after: "Kevin", isRequired: true, mappedPath: "personal_info.first_name", label: "First Name" },
    { fieldName: "education[0].degree", widgetType: "dropdown", status: "filled", after: "Bachelors", matchTier: "exact-normalized", isRequired: true, label: "Degree", options: ["Bachelors", "Masters"] },
    { fieldName: "certification[0].certification", widgetType: "typeahead", status: "filled_review", after: "CPP - full", matchTier: "enter-auto-commit", isRequired: true, label: "Certification", detail: "autocommit-containment" },
    { fieldName: "language[0].language", widgetType: "dropdown", status: "needs_review", isRequired: true, label: "Language", detail: "options did not render" },
    { fieldName: "extension", widgetType: "text", status: "skipped", isRequired: false, label: "Ext", detail: "empty" }
  ];
  const b = buildReviewBundle(results, { page: "P2", url: "https://x.wd3.myworkdaysite.com/apply", tenant: "x.wd3.myworkdaysite.com", capturedAt: "2026-06-19T00:00:00Z" });
  assert.ok(!b.entries.some((e) => e.widget_type === "section"), "section recs filtered out");
  assert.strictEqual(b.entries.length, 5);
  assert.strictEqual(b.schema_version, "1.0");
  assert.strictEqual(b.page, "P2");
  assert.strictEqual(b.tenant, "x.wd3.myworkdaysite.com");
  assert.strictEqual(b.captured_at, "2026-06-19T00:00:00Z");
  const cert = b.entries.find((e) => /certification/.test(e.field_id));
  assert.strictEqual(cert.fill_status, "filled"); // filled_review → filled
  assert.strictEqual(cert.needs_review, true);
  assert.strictEqual(cert.current_value, "CPP - full");
  assert.strictEqual(cert.original_ai_value, "CPP - full");
  const lang = b.entries.find((e) => /language/.test(e.field_id));
  assert.strictEqual(lang.fill_status, "not_filled"); // needs_review → not_filled
  assert.strictEqual(lang.needs_review, true);
  const ext = b.entries.find((e) => /extension/.test(e.field_id));
  assert.strictEqual(ext.fill_status, "skipped");
  assert.strictEqual(ext.needs_review, false); // skipped + not required → not flagged
  const fn = b.entries.find((e) => /firstName/.test(e.field_id));
  assert.strictEqual(fn.field_id, "P2::formField-legalName--firstName"); // page-qualified
  assert.strictEqual(fn.question_label, "First Name");
  assert.strictEqual(fn.is_required, true);
  assert.strictEqual(fn.canonical_field, "personal_info.first_name");
  assert.strictEqual(fn.confidence, "high"); // text + filled → profile_direct → high
  assert.strictEqual(fn.field_index, 0);
  assert.strictEqual(b.needs_review_count, 2); // cert + lang
  assert.strictEqual(b.counts.filled, 3);      // firstName + degree + cert(filled_review→filled)
});

test("M38 Part 2 buildReviewBundle: field_id is PAGE-QUALIFIED (globally unique across pages)", () => {
  const rec = [{ fieldName: "source", widgetType: "dropdown", status: "filled", after: "LinkedIn", label: "Source" }];
  const p1 = buildReviewBundle(rec, { page: "P1" });
  const p2 = buildReviewBundle(rec, { page: "P2" });
  assert.strictEqual(p1.entries[0].field_id, "P1::formField-source");
  assert.strictEqual(p2.entries[0].field_id, "P2::formField-source");
  assert.notStrictEqual(p1.entries[0].field_id, p2.entries[0].field_id); // no cross-page collision
});

test("M38 Part 2 accumulateBundle: merges pages; re-writing a page replaces ONLY its entries", () => {
  const mk = (page, fields) => buildReviewBundle(fields.map((f) => ({ fieldName: f, widgetType: "text", status: "filled", after: f, label: f })), { page });
  let acc = accumulateBundle([], mk("P1", ["a", "b"]));
  assert.strictEqual(acc.total, 2);
  acc = accumulateBundle(acc.entries, mk("P2", ["c"]));
  assert.strictEqual(acc.total, 3); // both pages accumulated
  assert.ok(acc.entries.some((e) => e.page === "P1") && acc.entries.some((e) => e.page === "P2"));
  assert.match(acc.page, /accumulated \(2 pages\)/);
  acc = accumulateBundle(acc.entries, mk("P1", ["a"])); // re-write P1 (was 2 fields → now 1)
  assert.strictEqual(acc.entries.filter((e) => e.page === "P1").length, 1, "P1 replaced");
  assert.strictEqual(acc.entries.filter((e) => e.page === "P2").length, 1, "P2 untouched");
});

test("M38 Part 2 accumulateBundle: a viewer EDIT on a prior page SURVIVES the next page's persist", () => {
  let acc = accumulateBundle([], buildReviewBundle([{ fieldName: "degree", widgetType: "dropdown", status: "filled", after: "Bachelors", label: "Degree" }], { page: "P1" }));
  // simulate a viewer edit on the P1 entry (current_value/edit_kind/is_edited)
  const edited = acc.entries.find((e) => e.page === "P1");
  edited.current_value = "Masters"; edited.edit_kind = "override"; edited.is_edited = true;
  // persist page 2 → the merge must RETAIN P1 verbatim (not rebuild)
  acc = accumulateBundle(acc.entries, buildReviewBundle([{ fieldName: "language[0].language", widgetType: "dropdown", status: "filled", after: "English", label: "Language" }], { page: "P2" }));
  const survived = acc.entries.find((e) => e.page === "P1");
  assert.strictEqual(survived.current_value, "Masters");
  assert.strictEqual(survived.edit_kind, "override");
  assert.strictEqual(survived.is_edited, true);
});

// ── M40 post-fill page AUDIT — re-read the live DOM + reconcile vs recorded ──
// A self-contained fake exposing only the reads reconcileAudit uses; `live` maps a
// wrapperSel → the value the LIVE page now shows (the perturbation). missing:true →
// the loc no longer resolves (read returns null → audit-unverifiable).
function makeAuditAct(live) {
  const g = (loc) => live[loc.wrapperSel] || {};
  return {
    delayFull: async () => {},
    readTextValue: async (loc) => { const f = g(loc); return f.missing ? null : { value: f.text || "" }; },
    readDropdownState: async (loc) => { const f = g(loc); return f.missing ? null : { triggerText: f.trigger }; },
    readCheckboxState: async (loc) => { const f = g(loc); return f.missing ? null : { inputId: "i", checked: f.checked }; },
    readRadioState: async (loc) => { const f = g(loc); return f.missing ? null : [{ labelText: f.radioLabel, checked: true }]; },
    readTypeahead: async (loc) => { const f = g(loc); return f.missing ? null : { chips: f.chips || [] }; },
    readSource: async (loc) => { const f = g(loc); return f.missing ? null : { chips: f.chips || [] }; },
    readDateSegment: async (loc, seg) => { const f = g(loc); if (f.missing || !f.segments || f.segments[seg] == null) return null; return { value: String(f.segments[seg]) }; }
  };
}
const auditVerdict = async (entry, liveForKey) => {
  const v = await reconcileAudit(makeAuditAct({ "[w]": liveForKey }), [Object.assign({ key: "k", auditLoc: "[w]" }, entry)], T_BUDGETS);
  return v[0].verdict;
};

// (1) Date round-trip (the user's hard point): auditDateSegments is the EXACT inverse of
// fillDateCompositeCdp's afterStr — confirm the split-count→shape mapping round-trips for
// all three (year-only, M/Y, M/D/Y), else a correct date false-flags or a real one is missed.
test("M40 audit: auditDateSegments round-trips all three date shapes (inverse of the fill formatting)", () => {
  assert.deepStrictEqual(auditDateSegments("2024"), [["Year", "2024"]]);                                  // year-only
  assert.deepStrictEqual(auditDateSegments("5/2025"), [["Month", "5"], ["Year", "2025"]]);                 // M/Y
  assert.deepStrictEqual(auditDateSegments("6/15/2024"), [["Month", "6"], ["Day", "15"], ["Year", "2024"]]); // M/D/Y
});

test("M40 audit: a date whose live segments still equal the recorded value → match (round-trip, all shapes)", async () => {
  assert.strictEqual(await auditVerdict({ widgetType: "date", expected: "2024" }, { segments: { Year: "2024" } }), "match");
  assert.strictEqual(await auditVerdict({ widgetType: "date", expected: "5/2025" }, { segments: { Month: "5", Year: "2025" } }), "match");
  assert.strictEqual(await auditVerdict({ widgetType: "date", expected: "6/15/2024" }, { segments: { Month: "6", Day: "15", Year: "2024" } }), "match");
});

test("M40 audit: a date segment reverted on the live page → MISMATCH", async () => {
  // expected 6/15/2024 but the page now shows month 1 → caught.
  assert.strictEqual(await auditVerdict({ widgetType: "date", expected: "6/15/2024" }, { segments: { Month: "1", Day: "15", Year: "2024" } }), "mismatch");
});

// (2) Per-widget mismatch — the perturbation gate's unit analog (the live page differs from recorded).
test("M40 audit: dropdown reverted (degree Bachelors→Associates) → MISMATCH", async () => {
  assert.strictEqual(await auditVerdict({ widgetType: "dropdown", expected: "Bachelors" }, { trigger: "Associates" }), "mismatch");
});
test("M40 audit: text overwritten on the page → MISMATCH; unchanged → match", async () => {
  assert.strictEqual(await auditVerdict({ widgetType: "text", expected: "Tallahassee, FL" }, { text: "Pittsburgh, PA" }), "mismatch");
  assert.strictEqual(await auditVerdict({ widgetType: "text", expected: "Tallahassee, FL" }, { text: "Tallahassee, FL" }), "match");
});
test("M40 audit: dropdown still matches (normalize-aware) → match, no false flip", async () => {
  assert.strictEqual(await auditVerdict({ widgetType: "dropdown", expected: "United States of America" }, { trigger: "United States of America" }), "match");
});
test("M40 audit: checkbox state changed → MISMATCH; same → match", async () => {
  assert.strictEqual(await auditVerdict({ widgetType: "checkbox", expected: "true" }, { checked: false }), "mismatch");
  assert.strictEqual(await auditVerdict({ widgetType: "checkbox", expected: "true" }, { checked: true }), "match");
});
test("M40 audit: typeahead chip reverted → MISMATCH", async () => {
  assert.strictEqual(await auditVerdict({ widgetType: "typeahead", expected: "Other" }, { chips: ["Electrical Engineering"] }), "mismatch");
});

// (3) Unre-readable → audit-unverifiable, NEVER a silent pass (the honest branch).
test("M40 audit: a field whose locator no longer resolves → UNVERIFIABLE (never silently 'match')", async () => {
  assert.strictEqual(await auditVerdict({ widgetType: "dropdown", expected: "Bachelors" }, { missing: true }), "unverifiable");
  assert.strictEqual(await auditVerdict({ widgetType: "date", expected: "2024" }, { missing: true }), "unverifiable");
});

// (4) applyAuditVerdicts mutates the result in place: mismatch → needs_review/audit-mismatch,
// after = the live truth; unverifiable → audit-unverifiable; match → untouched.
test("M40 audit: applyAuditVerdicts downgrades a mismatch (after = live truth) + flags unverifiable + leaves matches", () => {
  const results = [
    { fieldName: "a", status: "filled", verified: true, flag: null, after: "Bachelors", detail: "x" },
    { fieldName: "b", status: "filled_review", verified: true, flag: "autocommit-containment", after: "CPP …", detail: "y" },
    { fieldName: "c", status: "filled", verified: true, flag: null, after: "Tallahassee, FL", detail: null }
  ];
  applyAuditVerdicts(results, [
    { key: "a", verdict: "mismatch", expected: "Bachelors", actual: "Associates" },
    { key: "b", verdict: "unverifiable", expected: "CPP …", actual: null },
    { key: "c", verdict: "match", expected: "Tallahassee, FL", actual: "Tallahassee, FL" }
  ]);
  assert.strictEqual(results[0].status, "needs_review");
  assert.strictEqual(results[0].flag, "audit-mismatch");
  assert.strictEqual(results[0].after, "Associates");        // the bundle shows the live truth
  assert.match(results[0].detail, /AUDIT: page shows "Associates" not "Bachelors"/);
  assert.strictEqual(results[1].status, "needs_review");
  assert.strictEqual(results[1].flag, "audit-unverifiable");
  assert.strictEqual(results[2].status, "filled");           // a match is left untouched
  assert.strictEqual(results[2].flag, null);
});

// (5) Integration: a CLEAN flat fill → the inline audit re-reads, everything matches, ZERO audit flags
// (proves the audit doesn't FALSE-flag a correct page — the complement of the mismatch tests above).
test("M40 audit: a clean drivePageFill run gets NO audit-* flags (no false flags on a correct page)", async () => {
  const out = await drivePageFill(makeFakeAct([ddField()]), usProfile, {}, {}, T_BUDGETS);
  assert.ok(!out.results.some((r) => r.flag === "audit-mismatch" || r.flag === "audit-unverifiable"), "a correct fill must not be audit-flagged");
  assert.strictEqual(out.results[0].status, "filled");
});

// ── AI-4: validation-error remediation ──────────────────────────────────────
// The remediation LOOP itself lives in runCdpWalk (SW glue — live-verified eyes-on, not unit-tested);
// these pin the decision/parse UNITS it depends on.
const { parseErrorFieldName, errorSetUnchanged, mappedFieldsFromErrors, isDuplicateLanguageError, languageEntriesFromResults, languageDeletionPlan } = require("../lib.js");
const llmAct = (text) => ({ llm: async () => (text === undefined ? { ok: false, error: "no reply" } : (typeof text === "string" ? { ok: true, text } : text)) });

test("AI-4 parseErrorFieldName: Magna '<…>' bracket form", () => {
  assert.strictEqual(parseErrorFieldName("Error: The field <How Did You Hear About Us?> is required."), "How Did You Hear About Us?");
});
test("AI-4 parseErrorFieldName: bare 'field X is required' form", () => {
  assert.strictEqual(parseErrorFieldName("The field Phone Number is required."), "Phone Number");
});
test("AI-4 parseErrorFieldName: generic error with no field name → null (Tier-1 anchors are the primary)", () => {
  assert.strictEqual(parseErrorFieldName("This field is required"), null); // "field" immediately followed by "is" → no name captured
  assert.strictEqual(parseErrorFieldName(""), null);
  assert.strictEqual(parseErrorFieldName(null), null);
});

test("AI-4 errorSetUnchanged: identical sets (any order) → true; different/longer → false", () => {
  assert.strictEqual(errorSetUnchanged(["a", "b"], ["b", "a"]), true);   // order-independent
  assert.strictEqual(errorSetUnchanged([" a ", "b"], ["a", "b"]), true); // trim-normalized
  assert.strictEqual(errorSetUnchanged(["a"], ["a", "b"]), false);       // a new error appeared = progress
  assert.strictEqual(errorSetUnchanged(["a", "b"], ["a"]), false);       // one cleared = progress
  assert.strictEqual(errorSetUnchanged([], []), true);
});

test("AI-4 parseRemediation: restricted whitelist — refill / delete_entry parse; everything else → none", () => {
  assert.deepStrictEqual(parseRemediation('{"action":"refill","field":"phoneNumber","value":"555-123-4567"}'),
    { action: "refill", field: "phoneNumber", value: "555-123-4567", reason: "" });
  assert.deepStrictEqual(parseRemediation('```json\n{"action":"delete_entry","section":"language-","index":2}\n```'),
    { action: "delete_entry", section: "language-", index: 2, reason: "" });
  assert.strictEqual(parseRemediation('{"action":"none","reason":"cannot fix"}').action, "none");
  // SAFETY: a hallucinated out-of-set action can NEVER escape the whitelist.
  assert.strictEqual(parseRemediation('{"action":"submit"}').action, "none");
  assert.strictEqual(parseRemediation('{"action":"click","x":10,"y":20}').action, "none");
  assert.strictEqual(parseRemediation("not json at all").action, "none");
  // malformed required fields → none (never a half-specified action)
  assert.strictEqual(parseRemediation('{"action":"refill","value":"x"}').action, "none");      // missing field
  assert.strictEqual(parseRemediation('{"action":"delete_entry","section":"x"}').action, "none"); // missing index
});

test("AI-4 aiRemediateError: a 'Duplicate … entries' error → delete_entry action", async () => {
  const d = await aiRemediateError(llmAct('{"action":"delete_entry","section":"language-","index":2,"reason":"duplicate Chinese"}'),
    ["Duplicate language entries are not allowed."], { fields: [], sections: { "language-": 3 } }, {});
  assert.strictEqual(d.action, "delete_entry");
  assert.strictEqual(d.section, "language-");
  assert.strictEqual(d.index, 2);
});
test("AI-4 aiRemediateError: an invalid-format error → refill with a corrected value", async () => {
  const d = await aiRemediateError(llmAct('{"action":"refill","field":"phoneNumber","value":"+1 555-123-4567"}'),
    ["Phone number format is invalid."], { fields: [{ fieldName: "phoneNumber", label: "Phone", widgetType: "text", after: "5551234567" }] }, {});
  assert.strictEqual(d.action, "refill");
  assert.strictEqual(d.field, "phoneNumber");
  assert.strictEqual(d.value, "+1 555-123-4567");
});
test("AI-4 aiRemediateError: AI call fails → action 'none' (never blind-acts)", async () => {
  const d = await aiRemediateError(llmAct(undefined), ["err"], { fields: [] }, {});
  assert.strictEqual(d.action, "none");
  assert.match(d.reason, /AI call failed/);
});

// ── AI-4 deterministic Tier-1 + hardcoded dup-language (no AI for the common cases) ─────────
const FM = { "legalName--firstName": "personal_info.first_name", "phoneNumber": "personal_info.phone_number" };
const scanFor = [
  { fieldName: "legalName--firstName", label: "First Name*", widgetType: "text" },
  { fieldName: "phoneNumber", label: "Phone Number*", widgetType: "text" },
  { fieldName: "preferredCheck", label: "Preferred Name?", widgetType: "checkbox" } // UNMAPPED
];
test("AI-4 mappedFieldsFromErrors: a MAPPED field named by the error (label match) → re-fill set", () => {
  assert.deepStrictEqual(mappedFieldsFromErrors(["The field <First Name> is required."], scanFor, FM), ["legalName--firstName"]);
});
test("AI-4 mappedFieldsFromErrors: an UNMAPPED named field is EXCLUDED (→ left for the AI tier)", () => {
  assert.deepStrictEqual(mappedFieldsFromErrors(["The field <Preferred Name> is required."], scanFor, FM), []);
});
test("AI-4 mappedFieldsFromErrors: no field name in the error → empty", () => {
  assert.deepStrictEqual(mappedFieldsFromErrors(["Duplicate language entries are not allowed."], scanFor, FM), []);
  assert.deepStrictEqual(mappedFieldsFromErrors([], scanFor, FM), []);
});

test("AI-4 isDuplicateLanguageError: matches the live Magna text; false otherwise", () => {
  assert.strictEqual(isDuplicateLanguageError(["Error-LanguageDuplicate language entries are not allowed."]), true);
  assert.strictEqual(isDuplicateLanguageError(["Duplicate education entries are not allowed."]), false); // scoped to LANGUAGES
  assert.strictEqual(isDuplicateLanguageError(["The field <First Name> is required."]), false);
  assert.strictEqual(isDuplicateLanguageError([]), false);
});

test("AI-4 languageDeletionPlan: distinct values → PHANTOM (delete all)", () => {
  const results = [
    { fieldName: "language[0].language", after: "English" }, { fieldName: "language[0].readingProficiency", after: "Fluent" }, { fieldName: "language[0].native", after: "true" },
    { fieldName: "language[1].language", after: "Chinese" }, { fieldName: "language[1].speakingProficiency", after: "Advanced" }
  ];
  const entries = languageEntriesFromResults(results);
  assert.strictEqual(entries.length, 2);
  assert.match(entries[0].summary, /English \(read Fluent, native\)/);
  const plan = languageDeletionPlan(entries);
  assert.strictEqual(plan.mode, "phantom");
  assert.deepStrictEqual(plan.deleteIndices.slice().sort(), [0, 1]); // ALL
  assert.match(plan.summary, /English/);
  assert.match(plan.summary, /Chinese/);
});
test("AI-4 languageDeletionPlan: a REAL duplicate value → delete only the later occurrence", () => {
  const results = [
    { fieldName: "language[0].language", after: "English" },
    { fieldName: "language[1].language", after: "Chinese" },
    { fieldName: "language[2].language", after: "English" } // a genuine duplicate
  ];
  const plan = languageDeletionPlan(languageEntriesFromResults(results));
  assert.strictEqual(plan.mode, "real");
  assert.deepStrictEqual(plan.deleteIndices, [2]); // keep the first English, delete the dupe — NOT all
});

// ── Read-back self-heal (in-fill retry + M40 re-fill) ───────────────────────
// (a) fillTextCdp in-fill retry: a WRONG first type (the "fFirmware…" stray-char class) is re-done.
test("self-heal: fillTextCdp re-fills on a wrong first type → filled (not needs_review)", async () => {
  let n = 0;
  const field = textField({ mangle: (t) => (n++ === 0 ? "f" + t : t) }); // attempt 1 prepends a stray "f", attempt 2 clean
  const [rec] = await run([field], nameProfile, {});
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "Kevin");
  assert.match(rec.detail, /self-healed on attempt 2/);
});
test("self-heal: fillTextCdp still flags needs_review when ALL attempts mismatch", async () => {
  const [rec] = await run([textField({ mangle: () => "WRONG" })], nameProfile, {}); // every type lands wrong
  assert.strictEqual(rec.status, "needs_review");
  assert.match(rec.detail, /read-back mismatch after 2 attempt/);
});

// (b) fillDateCompositeCdp outer retry: a segment whose FOCUS flakes on attempt 1 self-heals on retry.
test("self-heal: a date segment whose focus flakes on attempt 1 self-heals on the outer retry → filled", async () => {
  const segs = { Month: seg0(), Year: seg0() };
  const { rec } = await runDate(segs, { month: "5", year: "2025" }, { focusFailsOnceFor: ["Year"] });
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "5/2025");
  assert.deepStrictEqual([segs.Month.value, segs.Year.value], ["5", "2025"]);
});

// (c) M40 audit re-fill-once: a TRANSIENT post-fill drift recovers; a DETERMINISTIC clobber stays flagged.
test("self-heal: M40 audit re-fills a drifted field that RECOVERS → 'recovered', kept filled + a note", async () => {
  const field = textField({ value: "DRIFTED" }); // live value drifted away from the recorded "Kevin"
  const act = makeFakeAct([field]);
  const entry = { key: field.fieldName, widgetType: "text", auditLoc: field.wrapperSel, auditTag: null, expected: "Kevin" };
  const verdicts = await reconcileAudit(act, [entry], T_BUDGETS, { refillOnMismatch: true });
  assert.strictEqual(verdicts[0].verdict, "recovered");
  assert.strictEqual(verdicts[0].actual, "Kevin");
  const results = [{ fieldName: field.fieldName, status: "filled", verified: true, after: "Kevin", flag: null, detail: "x" }];
  applyAuditVerdicts(results, verdicts);
  assert.strictEqual(results[0].status, "filled");   // KEPT filled — the self-heal worked
  assert.strictEqual(results[0].flag, null);
  assert.match(results[0].detail, /re-filled to "Kevin"/);
});
test("self-heal: M40 audit re-fill that STILL mismatches stays audit-mismatch (deterministic clobber)", async () => {
  const field = textField({ value: "DRIFTED", mangle: () => "CLOBBERED" }); // any re-fill lands wrong
  const act = makeFakeAct([field]);
  const entry = { key: field.fieldName, widgetType: "text", auditLoc: field.wrapperSel, auditTag: null, expected: "Kevin" };
  const verdicts = await reconcileAudit(act, [entry], T_BUDGETS, { refillOnMismatch: true });
  assert.strictEqual(verdicts[0].verdict, "mismatch");
  const results = [{ fieldName: field.fieldName, status: "filled", verified: true, after: "Kevin", flag: null, detail: null }];
  applyAuditVerdicts(results, verdicts);
  assert.strictEqual(results[0].status, "needs_review");
  assert.strictEqual(results[0].flag, "audit-mismatch");
  assert.strictEqual(results[0].after, "CLOBBERED");  // bundle shows the live truth
});
test("self-heal: M40 standalone re-audit (no opts) stays FLAG-ONLY — never re-fills", async () => {
  const field = textField({ value: "DRIFTED" });
  const act = makeFakeAct([field]);
  const entry = { key: field.fieldName, widgetType: "text", auditLoc: field.wrapperSel, auditTag: null, expected: "Kevin" };
  const verdicts = await reconcileAudit(act, [entry], T_BUDGETS); // no refillOnMismatch → diagnostic mode
  assert.strictEqual(verdicts[0].verdict, "mismatch");
  assert.strictEqual(field.value, "DRIFTED");          // untouched — no re-fill happened
});

// ── count===0 + no banner is NOT terminal (awaitListTerminal) → timeout no-match ──
// Per the strict terminal spec, a 0-options-no-banner list is NOT a confirmed terminal (it could be a
// transient mid-render), so awaitListTerminal keeps polling to "timeout" (treated like a no-match, kept, not
// delete-on-no-match). Magna shows a "No matches found" banner so it's fast there; only a hypothetical
// no-banner tenant pays the ceiling — the operator's accepted banner-or-timeout trade-off.
test("typeahead: 0 options + no banner is NOT terminal → 'timeout' no-match (kept, never a false commit)", async () => {
  const act = makeFakeAct([taField({ filterMap: { "Nonexistent Cert (CPP)": { filtered: [] } } })]);
  const out = await drivePageFill(act, taProfile(["Nonexistent Cert (CPP)"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "needs_review");        // no-match (kept, never a false commit)
  assert.strictEqual(rec.after, null);
  assert.strictEqual(rec.settle_trace[0].outcome, "timeout", "0+no-banner is not terminal → timeout (not a premature commit)");
  assert.strictEqual(rec.genuineNoMatch, false, "timeout behaves like a no-match but is NOT genuineNoMatch — kept, not delete-on-no-match");
});
test("source: 0 leaves + no banner is NOT terminal → 'timeout' no-match (lockstep)", async () => {
  const act = makeFakeAct([srcField({ wrapperSel: "[w-src]", filterMap: { LinkedIn: { filtered: [] } } })]);
  const out = await drivePageFill(act, nameProfile, { how_did_you_hear: { preferred: ["LinkedIn"] } }, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.settle_trace[0].outcome, "timeout", "source 0-leaf-no-banner is not terminal → timeout (lockstep with typeahead)");
});

// ── CPP delay Round 3: AUTOCOMMIT-CLOSE — the dropdown closes holding a chip == the pre-fill ──
// Recon-confirmed: typing "CPP" autocommits "…(CPP)…" + closes; the chip equals the pre-fill so
// chipSetIsNew is false → the chip-path missed it → it burned the backstop + mislabeled a CORRECT
// value needs_review. The closed-commit outcome recognizes it: kept (containment) → filled_review, fast.
test("typeahead: a candidate that AUTOCOMMITS the pre-fill + closes → closed-commit, filled_review, value kept (CPP)", async () => {
  const CPP = "Certified Payroll Professional (CPP) - Multiple Recognized Providers";
  const act = makeFakeAct([taField({ chips: [CPP], filterMap: { "CPP": { autoCommit: CPP } } })]);
  const out = await drivePageFill(act, taProfile(["CPP"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.settle_trace[0].outcome, "autocommit", "the autocommit-close was detected via awaitListTerminal (matchTier below records the closed-commit shape)");
  assert.strictEqual(rec.status, "filled_review");        // kept + flagged (containment), NOT needs_review "no match"
  assert.strictEqual(rec.after, CPP);                     // value intact (kept, not moved)
  assert.strictEqual(rec.verified, true);
  assert.strictEqual(rec.matchTier, "closed-commit");
  assert.strictEqual(rec.flag, "autocommit-containment"); // HONEST flag — NOT "overwrite-success" (nothing was overwritten)
  assert.match(rec.detail, /kept pre-fill/);              // provenance: kept, never "overwrote" (Hold 1)
});

// ── FoS Round 3: captureFieldOptions (INLINE option scrape, read-only) ──────────────────────
// Called RIGHT BEFORE a tagged typeahead's fill (fillEntryCdp) to scrape the FULL option list →
// rec.options → the summary's searchable editor. Open → scrape → stray-safe close. Returns the
// options array or null (non-fatal: null → summary falls back to captured_options).
const CAP_BUDGETS = { taOpenCeilingMs: 50, taOpenIntervalMs: 1, taSettleCeilingMs: 50, commitIntervalMs: 1, reopenSettleMs: 1 };
const FOS_OPTS = ["Accounting", "Biology", "Computer Science", "Engineering General"];
const CAP_LOC = { wrapperSel: '[data-fkit-id="education-7--null"] [data-automation-id="formField-fieldOfStudy"]' };
function makeCaptureAct(opts = {}) {
  const calls = [];
  const scrape = opts.scrape === undefined ? { ok: true, options: FOS_OPTS.slice() } : opts.scrape;
  const taState = { searchBox: { visible: true, focused: true }, activeText: null, chips: opts.chips || [] };
  const act = {
    delay: () => { calls.push(["delay"]); return Promise.resolve(); },
    delayFull: () => { calls.push(["delayFull"]); return Promise.resolve(); },
    openTypeahead: (loc) => { calls.push(["openTypeahead", loc.wrapperSel]); return Promise.resolve(true); },
    readTypeahead: (loc) => { calls.push(["readTypeahead", loc.wrapperSel]); return Promise.resolve(taState); },
    focusSearchBox: (loc) => { calls.push(["focusSearchBox", loc.wrapperSel]); return Promise.resolve(true); },
    pressEscape: () => { calls.push(["pressEscape"]); return Promise.resolve(); }
  };
  if (!opts.noScrape) act.scrapeTaOptions = (loc) => { calls.push(["scrapeTaOptions", loc.wrapperSel]); return Promise.resolve(scrape); };
  return { act, calls };
}

test("FoS capture: a successful scrape returns the full option list", async () => {
  const { act, calls } = makeCaptureAct();
  const options = await captureFieldOptions(act, CAP_LOC, CAP_BUDGETS);
  assert.deepStrictEqual(options, FOS_OPTS);
  assert.strictEqual(calls.filter((c) => c[0] === "scrapeTaOptions").length, 1);
});

test("FoS capture: a failed / empty / null scrape returns null (fallback to captured_options)", async () => {
  for (const scrape of [{ ok: false, error: "no wrapper" }, { ok: true, options: [] }, null]) {
    const { act } = makeCaptureAct({ scrape });
    assert.strictEqual(await captureFieldOptions(act, CAP_LOC, CAP_BUDGETS), null);
  }
});

test("FoS capture: no-op (null, no calls) when the substrate lacks scrapeTaOptions (older fake)", async () => {
  const { act, calls } = makeCaptureAct({ noScrape: true });
  assert.strictEqual(await captureFieldOptions(act, CAP_LOC, CAP_BUDGETS), null);
  assert.strictEqual(calls.length, 0); // returned before touching the field
});

test("FoS capture is READ-ONLY: never commits — only open/read/focus/scrape/escape (named invariant)", async () => {
  const { act, calls } = makeCaptureAct();
  await captureFieldOptions(act, CAP_LOC, CAP_BUDGETS);
  const allowed = new Set(["delay", "delayFull", "openTypeahead", "readTypeahead", "focusSearchBox", "pressEscape", "scrapeTaOptions"]);
  assert.deepStrictEqual(calls.filter((c) => !allowed.has(c[0])), [], "capture made a non-read-only call");
  for (const bad of ["typeInSearch", "pressEnter", "clearSearch", "typeText", "clickDropdownOptionByText"])
    assert.strictEqual(calls.some((c) => c[0] === bad), false, "capture must never call " + bad);
});

// ── captureChoiceOptions (END-OF-PAGE pass over the results) — typeaheads (FoS) + dropdowns ──
const taggedRec = (over = {}) => Object.assign({
  fieldName: "education-7--null--fieldOfStudy", widgetType: "typeahead", status: "filled",
  captureOptions: true, captureKey: "fieldOfStudy", auditLoc: "[w-fos]"
}, over);

test("choice-capture: typeahead scrapes ONCE for two same-key records and copies options to both", async () => {
  const recs = [taggedRec({ auditLoc: "[w-fos-0]" }), taggedRec({ auditLoc: "[w-fos-1]" })];
  const { act, calls } = makeCaptureAct();
  await captureChoiceOptions(act, recs, CAP_BUDGETS);
  assert.deepStrictEqual(recs[0].options, FOS_OPTS);
  assert.deepStrictEqual(recs[1].options, FOS_OPTS);
  assert.strictEqual(calls.filter((c) => c[0] === "scrapeTaOptions").length, 1); // cached per captureKey → one re-open
});

test("choice-capture: untagged-typeahead / not-filled / unlocated records are untouched", async () => {
  const recs = [
    taggedRec({ captureOptions: false, auditLoc: "[w-a]" }), // untagged typeahead (no captureOptions) → not captured
    taggedRec({ status: "needs_review", auditLoc: "[w-c]" }), // not filled
    taggedRec({ auditLoc: null }) // no locator
  ];
  const { act, calls } = makeCaptureAct();
  await captureChoiceOptions(act, recs, CAP_BUDGETS);
  for (const r of recs) assert.strictEqual(r.options, undefined);
  assert.strictEqual(calls.filter((c) => c[0] === "scrapeTaOptions").length, 0);
});

test("choice-capture: distinct captureKeys each get their own scrape", async () => {
  const recs = [taggedRec({ auditLoc: "[w-fos]", captureKey: "fieldOfStudy" }), taggedRec({ auditLoc: "[w-cert]", captureKey: "certification", fieldName: "cert" })];
  const { act, calls } = makeCaptureAct();
  await captureChoiceOptions(act, recs, CAP_BUDGETS);
  assert.strictEqual(calls.filter((c) => c[0] === "scrapeTaOptions").length, 2);
  assert.ok(recs[0].options && recs[1].options);
});

// ── captureDropdownOptions (read-only open → enabled texts → no-commit close) ──────────────
const DD_OPTS = [{ text: "Select One", disabled: true }, { text: "Bachelors" }, { text: "Masters" }, { text: "Doctorate" }];
function makeDropdownAct(opts = {}) {
  const calls = [];
  const options = opts.options || DD_OPTS;
  const trigger = opts.trigger || "Bachelors";
  let open = false;
  const act = {
    delay: () => { calls.push(["delay"]); return Promise.resolve(); },
    delayFull: () => { calls.push(["delayFull"]); return Promise.resolve(); },
    pressEscape: () => { calls.push(["pressEscape"]); open = false; return Promise.resolve(); },
    openDropdown: () => { calls.push(["openDropdown"]); if (opts.noOpen) return Promise.resolve(false); open = true; return Promise.resolve(true); },
    readDropdownState: () => { calls.push(["readDropdownState"]); return Promise.resolve({ triggerText: trigger, ariaExpanded: open ? "true" : "false", optionCount: open ? options.length : 0, options: open ? options : [] }); }
  };
  return { act, calls };
}

test("dropdown-capture: returns the ENABLED option texts (disabled placeholder dropped)", async () => {
  const { act } = makeDropdownAct();
  const opts = await captureDropdownOptions(act, { wrapperSel: "[w-degree]" }, T_BUDGETS);
  assert.deepStrictEqual(opts, ["Bachelors", "Masters", "Doctorate"]); // "Select One" disabled → excluded
});

test("dropdown-capture: returns null when the dropdown never expands (trigger dead)", async () => {
  const { act } = makeDropdownAct({ noOpen: true });
  assert.strictEqual(await captureDropdownOptions(act, { wrapperSel: "[w]" }, T_BUDGETS), null);
});

test("dropdown-capture is READ-ONLY: never commits (no type/arrow/click-option) — open/read/escape only", async () => {
  const { act, calls } = makeDropdownAct();
  await captureDropdownOptions(act, { wrapperSel: "[w]" }, T_BUDGETS);
  const allowed = new Set(["delay", "delayFull", "pressEscape", "openDropdown", "readDropdownState"]);
  assert.deepStrictEqual(calls.filter((c) => !allowed.has(c[0])), [], "dropdown-capture made a non-read-only call");
});

test("choice-capture: a repeating prefilled-kept dropdown (no options) gets rec.options; a committed one is skipped", async () => {
  const recs = [
    { fieldName: "education[0].degree", widgetType: "dropdown", status: "filled", auditLoc: "[w-degree]" },              // kept, no options → capture
    { fieldName: "language[0].language", widgetType: "dropdown", status: "filled", auditLoc: "[w-lang]", options: ["English", "Chinese"] } // committed (has options) → skip
  ];
  const { act, calls } = makeDropdownAct();
  await captureChoiceOptions(act, recs, T_BUDGETS);
  assert.deepStrictEqual(recs[0].options, ["Bachelors", "Masters", "Doctorate"]);
  assert.deepStrictEqual(recs[1].options, ["English", "Chinese"]); // untouched
  assert.strictEqual(calls.filter((c) => c[0] === "openDropdown").length, 1); // only the optionless one re-opened
});

test("choice-capture: a FLAT dropdown (page 1, no [idx].) is NOT re-opened — M27.C preserved for big cold lists", async () => {
  const recs = [{ fieldName: "country", widgetType: "dropdown", status: "filled", auditLoc: "[w-country]" }]; // prefilled-kept, no options
  const { act, calls } = makeDropdownAct();
  await captureChoiceOptions(act, recs, T_BUDGETS);
  assert.strictEqual(recs[0].options, undefined);                 // flat dropdown not captured
  assert.strictEqual(calls.filter((c) => c[0] === "openDropdown").length, 0); // never re-opened
});

test("choice-capture: two same-stem repeating dropdowns share ONE open (stem cache), both get options", async () => {
  const recs = [
    { fieldName: "language[0].readingProficiency", widgetType: "dropdown", status: "filled", auditLoc: "[w-r0]" },
    { fieldName: "language[1].readingProficiency", widgetType: "dropdown", status: "filled", auditLoc: "[w-r1]" }
  ];
  const { act, calls } = makeDropdownAct();
  await captureChoiceOptions(act, recs, T_BUDGETS);
  assert.deepStrictEqual(recs[0].options, ["Bachelors", "Masters", "Doctorate"]);
  assert.deepStrictEqual(recs[1].options, ["Bachelors", "Masters", "Doctorate"]);
  assert.strictEqual(calls.filter((c) => c[0] === "openDropdown").length, 1); // cached by stem "readingProficiency"
});
