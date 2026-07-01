// Unit tests for fill-driver.js — the substrate-agnostic CDP fill brain — driven
// by a FAKE actuation (the substrate-swap hedge made testable). The fake logs
// every actuation call so tests can assert not just outcomes but that deferred
// widgets are NEVER actuated and unverified commits are NEVER pressed.
const { test } = require("node:test");
const assert = require("node:assert");
const { drivePageFill, fillSourceCdp, fillTypeaheadCdp, commitOutcome, driveRepeatingSectionCdp, WEBSITE_MAP, LANGUAGE_MAP, WORK_EXPERIENCE_MAP, fillDateCompositeCdp, buildReviewBundle, accumulateBundle, detectSectionShapes, revealUnknownSection, CERT_NESTED, PAGE_SECTIONS, reconcileAudit, auditDateSegments, auditEntriesFromResults, applyAuditVerdicts, replayField, replayFlatFields, deriveFlatWrapperSel, isRepeatingEntry, reconDropdownDump, closeAndVerifyBlank, aiEligible, legallyLoaded, parseAiReply, parseAiText, aiRemediateError, parseRemediation, captureFieldOptions, captureDropdownOptions, captureChoiceOptions, awaitListTerminal, awaitListStable, awaitSourceListStable, parseAiTypeaheadReply, aiTypeaheadEligible, aiTypeaheadFallback, isOtherOption, runAiTypeaheadPass, parseAiTreeReply, aiTreeDrillFallback, makeStartCapture } = require("../fill-driver.js");

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
  let _llmIdx = 0; // for a SEQUENCE of canned llm replies (aiTreeFallback makes two: category, then leaf)
  const probe = { clearedWhileUnfocused: false }; // observe a focus-blind clear that hit an unfocused box
  const enabledIdxs = (f) => f.options.map((o, i) => ({ o, i })).filter((x) => !x.o.disabled).map((x) => x.i);

  return {
    log,
    probe,
    // AI-1: the toggle gate + the LLM seam. aiEnabled defaults OFF (existing tests unchanged —
    // the AI hook never fires). `o.ai` is the canned reply: a string → {ok:true,text}; an object
    // → returned verbatim ({ok:false,error} models a failure); undefined → {ok:false} (no reply).
    aiEnabled: o.aiEnabled === true,
    llm: async (req) => {
      log.push(["llm", req && req.user]);
      // o.ai is a single reply (string/object) OR a SEQUENCE (array) consumed in order — the latter
      // for aiTreeFallback's two prompts (category, then leaf).
      const a = Array.isArray(o.ai) ? o.ai[Math.min(_llmIdx++, o.ai.length - 1)] : o.ai;
      if (a === undefined || a === null) return { ok: false, error: "no canned reply" };
      return typeof a === "string" ? { ok: true, text: a } : a;
    },
    // structural tree discriminator (0.4): default FLAT; a field with `isTree: true` is excluded.
    isTreePicker: async (loc) => { log.push(["isTreePicker", loc.wrapperSel]); const f = byLoc(loc); return !!(f && f.isTree); },
    // tree-vs-flat router + drill for the inline AI (read on the STALE view). A tree field carries
    // `treeCategories` (visible on its no-match fallback) + `treeLeaves[category]`. readTreeCategories →
    // [] once a category is expanded (so aiTreeFallback's drill poll breaks); expandCategory drills (sets
    // _leaves so clickSourceLeaf can commit); readTreeLeaves → the drilled category's leaves.
    readTreeCategories: async (loc) => { log.push(["readTreeCategories", loc.wrapperSel]); const f = byLoc(loc); if (!f || !Array.isArray(f.treeCategories)) return []; return f._treeExpanded ? [] : f.treeCategories.slice(); },
    expandCategory: async (loc, label) => {
      log.push(["expandCategory", label]);
      const f = byLoc(loc);
      if (!f || !Array.isArray(f.treeCategories) || !f.treeCategories.includes(label)) return false;
      f._treeExpanded = label; f._open = true;
      f._leaves = (f.treeLeaves && f.treeLeaves[label]) ? f.treeLeaves[label].slice() : [];
      focusedSrc = f;
      return true;
    },
    readTreeLeaves: async (loc) => { const f = byLoc(loc); if (!f) return []; return f._treeExpanded ? (f._leaves || []) : (Array.isArray(f.treeCategories) ? f.treeCategories.slice() : []); },
    // scroll-accumulate (virtualized): on-open → categories; after a drill → that category's leaves. Returns
    // the FULL lists (the fake doesn't truncate — it models the post-scroll complete enumeration).
    scrapeSourceRows: async (loc) => {
      log.push(["scrapeSourceRows", loc.wrapperSel]);
      const f = byLoc(loc);
      if (!f) return { ok: false };
      // on-open → category labels (banner = no-match); after a drill → that category's leaves (banner = cat name).
      if (f._treeExpanded) return { ok: true, options: ((f.treeLeaves && f.treeLeaves[f._treeExpanded]) || []).slice(), banner: f._treeExpanded, atBottom: true };
      return { ok: true, options: Array.isArray(f.treeCategories) ? f.treeCategories.slice() : [], banner: "No matches found", atBottom: true };
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
    repeatingScan: async () => o.rscan || null, // m3a: o.rscan models repeating sections (known/unknown); default null = flat-only (existing tests unchanged)
    // nestedScan/clickNestedAdd/clickNestedDelete remain as inert seams for the CDP recon harness only
    // (the FILL no longer scans nested — cert ▸ Specialties is HARDCODED via section.nested).
    nestedScan: async () => (typeof o.nestedScan === "function" ? o.nestedScan() : (o.nestedScan || null)),
    clickNestedAdd: o.clickNestedAdd,
    clickNestedDelete: o.clickNestedDelete,

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
          // commitOnReEnter: models the operator bug — a value that filters to MULTIPLE results ("Search Results (2)")
          // does NOT autocommit on the first Enter; pressing Enter AGAIN commits the top (the exact match).
          else if (fm.commitOnReEnter) { src._banner = false;
            if (src._reEnterArmed) { src.chips = [fm.commitOnReEnter]; src._open = false; src._resultsBanner = false; }
            else { src._leaves = (fm.results || [fm.commitOnReEnter]).slice(); src._resultsBanner = true; src._reEnterArmed = true; }
          }
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
            if (fm.banner) { ta._banner = true; ta._resultsBanner = false; ta._texts = (ta.fallbackTexts || ta.fallbackLeaves || ta._texts || []).slice(); ta._filtered = true; }
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
                ta._texts = (ta.fallbackTexts || ta.fallbackLeaves || []).slice(); ta._resultsBanner = false;
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
          // dropsFocusOnFilterEnter: the live filter-Enter drops searchBox focus when the list re-renders
          // (banner / results) while the box stays OPEN — the focus drop the inline AI's tree-detect clear
          // must NOT then blind-actuate against.
          if (fm && ta.dropsFocusOnFilterEnter && ta._open) ta._focusedSb = false;
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
    pressTab: async () => {
      log.push(["pressTab"]);
      // Tab is the ONLY clean non-committing exit (recon 2026-06-26): it blurs + ABANDONS the armed
      // row WITHOUT committing → chips unchanged (the CORRECT behavior, no flag). strayChipOnTab
      // models a hypothetical tenant where Tab STILL commits an armed row-0 — the strayed-check
      // backstop must then flag it (overwrite-stray), never a false "kept original".
      if (focusedTa) { if (focusedTa.strayChipOnTab) focusedTa.chips = [focusedTa.strayChipOnTab]; focusedTa._open = false; }
      if (focusedSrc) { if (focusedSrc.strayChipOnTab) focusedSrc.chips = [focusedSrc.strayChipOnTab]; focusedSrc._open = false; }
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
    // viewport-aware tree-leaf commit (aiTreeFallback's commitLeaf): commits a leaf from the drilled
    // category's leaves (_leaves, set by expandCategory) → a chip (read back via readSource).
    clickTreeLeaf: async (loc, label) => {
      log.push(["clickTreeLeaf", label]);
      const f = byLoc(loc);
      if (!f || !(f._leaves || []).includes(label)) return false;
      f.chips = [label]; f._open = false;
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
      // Focus-blind in reality (Ctrl+A/Delete go to whatever has focus): an unfocused clear NO-OPS — flag it.
      if (focusedTa && focusedTa._focusedSb) { focusedTa._value = ""; focusedTa._filtered = false; }
      else if (focusedTa) { probe.clearedWhileUnfocused = true; }
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
    // ── unified hierarchical-typeahead (merge 2026-06-28) — the methods the merged fillTypeaheadCdp
    // (cert + source) actually drives. They reuse the typeahead internals (focusedTa/_texts) so the existing
    // typeahead fixtures (openTexts/filterMap/fallbackTexts) work; source fixtures (openLeaves/fallbackLeaves)
    // are accepted too. clickHierLeaf commits a leaf BY LABEL from _texts — the first match — and (default)
    // sets BOTH a chip and the promptLeafNode isselected flag; commitVia:"isselected" sets ONLY isselected
    // (verify-via-leaf), clickCommitFails dispatches without committing, clickCommitsWrongText mis-commits.
    openHier: async (loc) => {
      log.push(["openHier", loc.wrapperSel]);
      const f = byLoc(loc);
      f._open = true;
      if (!f.focusUnconfirmable && !f.focusRaces) f._focusedSb = true;
      if (f._texts === undefined) f._texts = (f.openTexts || f.openLeaves || []).slice();
      if (f._banner === undefined) f._banner = false;
      focusedTa = f;
      return true;
    },
    readHier: async (loc) => {
      const f = byLoc(loc);
      if (f._resultsBannerPending) { f._resultsBannerReadsLeft -= 1; if (f._resultsBannerReadsLeft <= 0) { f._resultsBanner = true; f._resultsBannerPending = false; if (f._pendingTexts) f._texts = f._pendingTexts; } }
      const texts = f._open ? (f._texts || []) : [];
      const sig = (f._rev || 0) + "|" + texts.length + "|" + texts.slice(0, 3).join("~");
      let sbValue = f._value || "";
      if (f._lagLeft !== undefined) { if (f._lagLeft > 0) f._lagLeft -= 1; else f._lagReflected = f._lagPending; sbValue = f._lagReflected; }
      return {
        searchBox: { present: !!f._open, visible: !!f._open, focused: !!(f._open && f._focusedSb), value: sbValue },
        chips: (f.chips || []).slice(),
        banner: f._open && f._banner ? { text: "No matches found", automationId: "promptTitle" } : null,
        resultsBanner: !!(f._open && f._resultsBanner),
        pageWide: { count: texts.length, sig, sample: texts.slice(0, 10), texts: texts.slice(0, 40) },
        leaves: texts.slice(0, 40), leafCount: texts.length,
        msId: f.msId || null, activeText: null
      };
    },
    focusHierSearch: async (loc) => { log.push(["focusHierSearch", loc.wrapperSel]); const f = byLoc(loc); if (!f.focusUnconfirmable) f._focusedSb = f.focusRaces ? ((f._fsbTries = (f._fsbTries || 0) + 1) >= 2) : true; focusedTa = f; return true; },
    typeInHier: async (text) => { log.push(["typeInHier", text]); if (!focusedTa) return; focusedTa._value = text; focusedTa._filtered = false; focusedTa._resultsBanner = false; focusedTa._resultsBannerPending = false; if (focusedTa.searchValueLagReads !== undefined) { focusedTa._lagPending = text; focusedTa._lagReflected = ""; focusedTa._lagLeft = focusedTa.searchValueLagReads; } },
    clearHierSearch: async () => { log.push(["clearHierSearch"]); if (focusedTa && focusedTa._focusedSb) { focusedTa._value = ""; focusedTa._filtered = false; } else if (focusedTa) { probe.clearedWhileUnfocused = true; } },
    clickHierLeaf: async (loc, label) => {
      log.push(["clickHierLeaf", label]);
      const f = focusedTa || byLoc(loc);
      if (!f || !(f._texts || []).some((t) => t === label)) return false; // leaf not visible
      if (f.clickCommitFails) return true; // click dispatched, nothing committed (verify will fail)
      const committed = f.clickCommitsWrongText || label;
      if (f.commitVia === "isselected" || f.commitVia === "leaf") { f._selectedLeaf = committed; }
      else { f.chips = [committed]; f._selectedLeaf = committed; }
      f._open = false;
      return true;
    },
    probeHierLeaf: async (label) => {
      const f = focusedTa;
      return { found: !!(f && (f._texts || []).includes(label)), commitWrapper: { isSelectedValue: (f && f._selectedLeaf === label) ? "true" : "false" }, rect: { cx: 1, cy: 1, w: 10, h: 10 } };
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

// ── dropdown TIER-AWARE pre-filled guard (M36.1 parity; the priority-blind bug) ──
// Reported: country ["Afghanistan","United States of America","United States"] (tier 0 first)
// left on tier-1 "United States of America" was KEPT instead of upgrading to tier-0.

test("dropdown TIER-AWARE: a tier>0 pre-fill is OVERWRITTEN to the highest tier the form offers", async () => {
  const opts = [{ text: "Select One", disabled: true }, { text: "Afghanistan" }, { text: "United States of America" }, { text: "United States" }];
  const act = makeFakeAct([ddField({ triggerText: "United States of America", options: opts })]);
  const out = await drivePageFill(act, { personal_info: { country: ["Afghanistan", "United States of America", "United States"] } }, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "Afghanistan", "upgraded to the tier-0 candidate (the reported bug)");
  assert.strictEqual(rec.flag, "dropdown-overwrite-success");
  assert.ok(act.log.some(([m]) => m === "openDropdown"), "must open to overwrite");
  assert.ok(act.log.some(([m]) => m === "clickDropdownOptionByText"), "committed the higher tier by text-click");
});

test("dropdown TIER-AWARE: a tier>0 pre-fill with NO higher tier offered is KEPT (better-tier-unavailable)", async () => {
  // tier-0 "Afghanistan" is NOT among the offered options (DD_OPTIONS: Canada/US of A/Uruguay)
  // → the pre-fill is the best the form has → keep it, do NOT downgrade to needs_review.
  const act = makeFakeAct([ddField({ triggerText: "United States of America" })]);
  const out = await drivePageFill(act, { personal_info: { country: ["Afghanistan", "United States of America"] } }, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "United States of America", "kept — best available tier");
  assert.strictEqual(rec.flag, "dropdown-prefilled-better-tier-unavailable");
  assert.ok(act.log.some(([m]) => m === "openDropdown"), "opened to check for a higher tier");
});

test("dropdown TIER-AWARE: a tier-0 pre-fill is KEPT with ZERO actuation (no re-open)", async () => {
  const act = makeFakeAct([ddField({ triggerText: "United States of America" })]);
  const out = await drivePageFill(act, { personal_info: { country: ["United States of America", "United States", "Canada"] } }, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.flag, "dropdown-prefilled-kept");
  assert.ok(!act.log.some(([m]) => m === "openDropdown"), "a tier-0 pre-fill must never re-open the list");
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

test("AI-2: an OPTIONAL field gets NO AI fallback — deterministic skip, BLANK, no LLM (operator rule)", async () => {
  // Operator rule: only REQUIRED fields get an AI fallback. An OPTIONAL unmapped field stays at
  // its deterministic result and is left BLANK — a blank optional doesn't block Save & Continue,
  // so there's no reason to spend an LLM call guessing it.
  const act = makeFakeAct([aiText({ isRequired: false })], { aiEnabled: true, ai: '{"answer":"should not be used"}' });
  const rec = (await drivePageFill(act, GEN_ON, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(rec.status, "skipped", "optional unmapped → deterministic skip (no AI)");
  assert.strictEqual(rec.after, null, "left BLANK");
  assert.ok(!act.log.some(([m]) => m === "llm"), "the LLM is NEVER consulted for an optional field");
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

test("AI-2: generation OFF (empty autofill_rules) ⇒ act.llm NEVER called; required → placeholder, optional → blank", async () => {
  const GEN_OFF = { autofill_rules: { generation_allowed_only_for: [] } };
  const reqAct = makeFakeAct([aiText({ isRequired: true })], { aiEnabled: true, ai: '{"answer":"should not be used"}' });
  const reqRec = (await drivePageFill(reqAct, GEN_OFF, {}, {}, T_BUDGETS)).results[0];
  assert.ok(!reqAct.log.some(([m]) => m === "llm"), "generation off → the LLM is never consulted");
  assert.strictEqual(reqRec.flag, "ai-text-needs-answer", "required still gets a placeholder (walk advances)");
  const optAct = makeFakeAct([aiText({ isRequired: false })], { aiEnabled: true, ai: '{"answer":"x"}' });
  const optRec = (await drivePageFill(optAct, GEN_OFF, {}, {}, T_BUDGETS)).results[0];
  assert.ok(!optAct.log.some(([m]) => m === "llm"), "optional → never consults the LLM (no AI fallback)");
  assert.strictEqual(optRec.status, "skipped");
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

test("FIELD_MAP: preferredCheck → has_preferred_name — true CHECKS it (reveals the preferred-name fields); false leaves it unchecked", async () => {
  const prefField = (flags) => Object.assign({ wrapperSel: "[w-pref]", fieldName: "preferredCheck", widgetType: "checkbox", isRequired: false, label: "I have a preferred name", inputId: "pc-1" }, flags || {});
  // has_preferred_name:true → the optional checkbox reconciles to CHECKED (which reveals the preferred first/last fields on the live page → the cascade re-scan then fills them once mapped).
  const onF = prefField({ checked: false });
  const onRec = (await drivePageFill(makeFakeAct([onF]), { personal_info: { has_preferred_name: true } }, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(onRec.status, "filled");
  assert.strictEqual(onF.checked, true, "mapped + true → box checked");
  // has_preferred_name:false → reconciles to UNCHECKED (no reveal). Mapped, so not 'skipped: no mapping' anymore.
  const offF = prefField({ checked: true });
  await drivePageFill(makeFakeAct([offF]), { personal_info: { has_preferred_name: false } }, {}, {}, T_BUDGETS);
  assert.strictEqual(offF.checked, false, "mapped + false → box unchecked");
});

test("FIELD_MAP: revealed preferred-name fields fill DETERMINISTICALLY from the profile (mapped → no AI even though optional)", async () => {
  const fields = [
    { wrapperSel: "[w-pfn]", fieldName: "preferredName--firstName", widgetType: "text", isRequired: false, label: "Preferred First Name", value: "" },
    { wrapperSel: "[w-pln]", fieldName: "preferredName--lastName", widgetType: "text", isRequired: false, label: "Preferred Last Name", value: "" }
  ];
  const act = makeFakeAct(fields, { aiEnabled: true, ai: '{"answer":"SHOULD NOT BE USED"}' });
  const out = await drivePageFill(act, { personal_info: { preferred_first_name: "John", preferred_last_name: "Doe" } }, {}, {}, T_BUDGETS);
  const fn = out.results.find((r) => r.fieldName === "preferredName--firstName");
  const ln = out.results.find((r) => r.fieldName === "preferredName--lastName");
  assert.strictEqual(fn.status, "filled"); assert.strictEqual(fn.after, "John");
  assert.strictEqual(ln.status, "filled"); assert.strictEqual(ln.after, "Doe");
  assert.ok(!act.log.some(([m]) => m === "llm"), "a MAPPED optional field fills deterministically — the optional gate only blocks AI for UNMAPPED fields");
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

test("EEO retraction + optional gate: a REQUIRED unmapped EEO field is AI-FILLED (ai-eeo-guess); an OPTIONAL one is left BLANK (no LLM)", async () => {
  // REQUIRED unmapped EEO → the generic inference fills it + the loud demographic verify badge.
  const req = makeFakeAct([genderField({ fieldName: "genderIdentity", label: "Gender identity", isRequired: true })], { aiEnabled: true, ai: '{"choice":"Male","confidence":"High"}' });
  const reqRec = (await drivePageFill(req, {}, {}, {}, T_BUDGETS)).results[0];
  assert.ok(req.log.some(([m]) => m === "llm"), "required EEO is AI-filled (the exclusion is retracted)");
  assert.strictEqual(reqRec.flag, "ai-eeo-guess", "an AI-filled demographic gets the verify badge");
  assert.strictEqual(reqRec.after, "Male");
  assert.strictEqual(reqRec.status, "filled_review");
  // OPTIONAL unmapped EEO → NO AI (optional = deterministic-only) → left blank, no LLM ("blank optional EEO too").
  const opt = makeFakeAct([genderField({ fieldName: "genderIdentity", label: "Gender identity", isRequired: false })], { aiEnabled: true, ai: '{"choice":"Male","confidence":"High"}' });
  const optRec = (await drivePageFill(opt, {}, {}, {}, T_BUDGETS)).results[0];
  assert.ok(!opt.log.some(([m]) => m === "llm"), "optional EEO is NOT AI-guessed");
  assert.strictEqual(optRec.status, "skipped");
  assert.strictEqual(optRec.after, null);
});

test("AI-3 EEO inference (mapped-but-empty required → the confidence-gated path): high-conf commits (ai-eeo-guess); low-conf/decline → neutral (eeo_declined)", async () => {
  const opts = [{ text: "Select One", disabled: true }, { text: "Female" }, { text: "Male" }, { text: "Undeclared" }];
  // fieldName "gender" is MAPPED but the profile has no value → status "skipped" → the generic infer
  // block skips it (producedNothing is false) → the confidence-gated AI-3 path handles it.
  // low confidence → NOT committed as a guess; falls back to the neutral decline ("Undeclared")
  const lo = makeFakeAct([genderField({ fieldName: "gender", label: "Gender", isRequired: true, options: opts })], { aiEnabled: true, ai: '{"choice":"Male","confidence":"Low"}' });
  const loRec = (await drivePageFill(lo, {}, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(loRec.flag, "eeo_declined", "a low-confidence demographic guess is NOT committed");
  assert.strictEqual(loRec.after, "Undeclared");
  assert.strictEqual(loRec.status, "filled_review");
  // the AI choosing to decline → eeo_declined
  const dec = makeFakeAct([genderField({ fieldName: "gender", label: "Gender", isRequired: true, options: opts })], { aiEnabled: true, ai: '{"choice":"Undeclared","confidence":"High"}' });
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

test("optional gate: an UNMAPPED OPTIONAL EEO dropdown gets NO AI — left blank, no LLM ('blank optional EEO too')", async () => {
  // aiDd's fieldName "screen_q" is unmapped; the gender LABEL makes it EEO. Optional + EEO → still
  // NO AI (the optional rule is uniform, including EEO): deterministic skip, blank, no LLM call.
  const act = makeFakeAct([aiDd({ label: "What is your gender?", isRequired: false })], { aiEnabled: true, ai: '{"choice":"No","confidence":"High"}' });
  const rec = (await drivePageFill(act, {}, {}, {}, T_BUDGETS)).results[0];
  assert.ok(!act.log.some(([m]) => m === "llm"), "optional EEO → never consults the LLM");
  assert.strictEqual(rec.status, "skipped");
  assert.strictEqual(rec.after, null);
});

test("optional gate (regression): REQUIRED unmapped fields still AI-fill; OPTIONAL ones never call the LLM (text + dropdown)", async () => {
  // REQUIRED unmapped text → AI generates (filled_review / ai-text).
  const reqT = makeFakeAct([aiText({ isRequired: true })], { aiEnabled: true, ai: '{"answer":"I admire the robotics mission."}' });
  const reqTRec = (await drivePageFill(reqT, GEN_ON, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(reqTRec.status, "filled_review"); assert.strictEqual(reqTRec.flag, "ai-text");
  // REQUIRED unmapped dropdown → AI chooses (filled_review, LLM consulted).
  const reqD = makeFakeAct([aiDd({ isRequired: true })], { aiEnabled: true, ai: '{"choice":"No","confidence":"High"}' });
  const reqDRec = (await drivePageFill(reqD, {}, {}, {}, T_BUDGETS)).results[0];
  assert.ok(reqD.log.some(([m]) => m === "llm")); assert.strictEqual(reqDRec.status, "filled_review");
  // OPTIONAL unmapped TEXT — the cascade-revealed Local-Name regression (firstNameLocal) → NO AI, blank.
  const optT = makeFakeAct([aiText({ fieldName: "legalName--firstNameLocal", label: "Cyrillic Given Name", isRequired: false })], { aiEnabled: true, ai: '{"answer":"Kevin"}' });
  const optTRec = (await drivePageFill(optT, GEN_ON, {}, {}, T_BUDGETS)).results[0];
  assert.ok(!optT.log.some(([m]) => m === "llm"), "optional revealed Local-name text → no LLM (the firstNameLocal regression)");
  assert.strictEqual(optTRec.status, "skipped"); assert.strictEqual(optTRec.after, null);
  // OPTIONAL unmapped dropdown → NO AI, blank.
  const optD = makeFakeAct([aiDd({ isRequired: false })], { aiEnabled: true, ai: '{"choice":"No","confidence":"High"}' });
  const optDRec = (await drivePageFill(optD, {}, {}, {}, T_BUDGETS)).results[0];
  assert.ok(!optD.log.some(([m]) => m === "llm"), "optional dropdown → no LLM");
  assert.strictEqual(optDRec.status, "skipped"); assert.strictEqual(optDRec.after, null);
});

test("cascade-removed: a field DELETED from the DOM after fills → status 'removed', dropped from the bundle / counts / review", async () => {
  // countryRegion ("State") fails — its trigger was deleted by an earlier value (Country=Afghanistan);
  // neverRenders models the gone trigger → needs_review "options did not render". The post-fill rescan
  // no longer lists countryRegion → reclassify "removed" so it leaves the summary entirely (not an error).
  const fields = [
    { wrapperSel: "[w-city]", fieldName: "city", widgetType: "text", label: "City", value: "" },
    ddField({ wrapperSel: "[w-state]", fieldName: "countryRegion", label: "State", neverRenders: true })
  ];
  const act = makeFakeAct(fields, {});
  const baseScan = act.scanPage;
  let n = 0;
  act.scanPage = async () => {
    n++; // call 1 = the up-front scan (countryRegion present); later scans omit it (it was deleted)
    if (n >= 2) return { url: "fake://page", repeatingFieldCount: 0, fields: fields.filter((f) => f.fieldName !== "countryRegion").map((f) => ({ wrapperSel: f.wrapperSel, fieldName: f.fieldName, widgetType: f.widgetType, label: f.label || f.fieldName, isRequired: !!f.isRequired })) };
    return baseScan();
  };
  const out = await drivePageFill(act, { personal_info: { city: "Tallahassee", state_province: ["California"] } }, {}, {}, T_BUDGETS);
  const rec = out.results.find((r) => r.fieldName === "countryRegion");
  assert.strictEqual(rec.status, "removed", "DOM-absent failed field → removed (deleted by a cascade)");
  assert.strictEqual(rec.flag, "cascade-removed");
  assert.ok(!out.needsReview.some((r) => r.fieldName === "countryRegion"), "removed field is NOT in needs-review");
  const bundle = buildReviewBundle(out.results, { page: "p1" });
  assert.ok(!bundle.entries.some((e) => /countryRegion/.test(e.field_id || "")), "removed field is excluded from the bundle");
  assert.ok(bundle.entries.some((e) => /city/.test(e.field_id || "")), "a present field stays in the bundle (sanity)");
});

test("AI INVARIANT: prev-worker / file_upload / radio never AI-eligible; dropdown + text/textarea ARE — and EEO is NOW eligible (rule retracted)", () => {
  assert.strictEqual(aiEligible({ widgetType: "dropdown", fieldName: "candidateIsPreviousWorker", label: "Have you worked here?" }), false);
  assert.strictEqual(aiEligible({ widgetType: "file_upload", fieldName: "resume", label: "Resume" }), false);
  assert.strictEqual(aiEligible({ widgetType: "radio", fieldName: "x", label: "Pick one" }), false);
  assert.strictEqual(aiEligible({ widgetType: "dropdown", fieldName: "gender", label: "What is your gender?" }), true, "EEO is NOW AI-eligible (exclusion retracted)");
  assert.strictEqual(aiEligible({ widgetType: "text", fieldName: "disabilityStatus", label: "Disability status" }), true, "EEO text is NOW eligible too");
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

test("checkbox: an UNMAPPED optional checkbox → skipped with zero actuation", async () => {
  // (preferredCheck is now MAPPED to has_preferred_name — see the FIELD_MAP test above; this
  // pins the unmapped-optional-checkbox behavior with a still-unmapped field.)
  const act = makeFakeAct([{ wrapperSel: "[w-opt]", fieldName: "marketingOptIn", widgetType: "checkbox", label: "Send me updates", inputId: "m-1", checked: false }]);
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
  assert.match(out.results[0].detail, /no how_did_you_hear value/);
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

// ── source AI tree drill + profile-driven how_did_you_hear ───────────────────

test("source: profile.how_did_you_hear WINS over defaults (candidate list comes from the profile)", async () => {
  const act = makeFakeAct([srcField({ wrapperSel: "[w-src]", filterMap: { LinkedIn: { autoCommit: "LinkedIn" } } })]);
  const profile = Object.assign({}, nameProfile, { how_did_you_hear: { preferred: ["LinkedIn"] } });
  const defaults = { how_did_you_hear: { preferred: ["Indeed"], fallback: "Other" } };
  const out = await drivePageFill(act, profile, defaults, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.deepStrictEqual(rec.resolved, ["LinkedIn"], "candidates from PROFILE, not defaults");
  assert.strictEqual(rec.after, "LinkedIn");
  assert.strictEqual(rec.status, "filled");
});

test("source AI: TWO-PROMPT drill — AI category → CLICK-drill (expandCategory) → AI leaf → TYPED commit (filled_review/ai-choice)", async () => {
  // Source is a TREE you DRILL (live 2026-06-28: "College/University" is a drillable category). The deterministic
  // value misses → genuine no-match → tryInlineAi routes to aiSourceTreeFallback (the sourceTree flag): scroll-
  // enumerate categories → Prompt 1 picks one → CLICK it open (expandCategory — typing a category filters to
  // NOTHING) → scroll-enumerate its leaves → Prompt 2 picks a SEEN leaf → commit by TYPING it (autocommit / click
  // the top on a tie). This is the regression the merge broke (the flat path TYPED the category + failed).
  const field = srcField({
    wrapperSel: "[w-src]",
    filterMap: {
      "university of carnegie": { banner: true },                            // deterministic no-match → categories
      "Carnegie Mellon University": { autoCommit: "Carnegie Mellon University" } // the TYPED commit of the chosen leaf
    },
    treeCategories: ["Job Boards", "Social Media", "College / University"],
    treeLeaves: { "College / University": ["Carnegie Mellon University", "Other University"] }
  });
  const act = makeFakeAct([field], { aiEnabled: true, ai: [
    '{"choice":"College / University","confidence":"Medium"}',  // Prompt 1: category
    '{"choice":"Carnegie Mellon University","confidence":"Medium"}' // Prompt 2: leaf
  ] });
  const profile = Object.assign({}, nameProfile, { how_did_you_hear: { preferred: ["university of carnegie"] } });
  const out = await drivePageFill(act, profile, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled_review");
  assert.strictEqual(rec.flag, "ai-choice");
  assert.strictEqual(rec.after, "Carnegie Mellon University");
  assert.ok(rec.tree_structure && rec.tree_structure.chosen === "College / University", "tree recon recorded (category + leaves)");
  assert.ok(act.log.some(([m]) => m === "scrapeSourceRows"), "scroll-enumerated the options");
  assert.ok(act.log.some(([m]) => m === "expandCategory"), "CLICK-drilled the chosen category (NOT typed)");
  assert.ok(act.log.some(([m]) => m === "typeInSourceSearch" && true), "committed the leaf by TYPING it on the open drilled field");
  assert.ok(!act.log.some(([m]) => m === "clickTreeLeaf"), "source uses the type-commit drill, NOT clickTreeLeaf");
});

test("source AI: the AI gets ONLY the STATED answer (not the whole profile) → a typo'd 'Otherrr' maps to 'Other', NOT an inferred profile fact", async () => {
  // The operator's "Otherrr → Carnegie Mellon" bug: a typo'd how_did_you_hear no-matches → the AI must MATCH the
  // STATED answer ("Otherrr" → "Other"), and must NOT be handed the whole profile (which contains the school →
  // it would infer "Carnegie Mellon"). Token-saving + intent-honoring.
  const field = srcField({
    wrapperSel: "[w-src]",
    filterMap: { "Otherrr": { banner: true }, "Other": { autoCommit: "Other" } }, // the typed-commit of the chosen leaf
    treeCategories: ["College / University", "Other Sources"],
    treeLeaves: { "Other Sources": ["Newspaper", "Other"] }
  });
  const act = makeFakeAct([field], { aiEnabled: true, ai: ['{"choice":"Other Sources"}', '{"choice":"Other"}'] });
  const profile = Object.assign({}, nameProfile, { how_did_you_hear: { preferred: ["Otherrr"] }, education: [{ school: "Carnegie Mellon University" }] });
  const out = await drivePageFill(act, profile, {}, {}, T_BUDGETS);
  assert.strictEqual(out.results[0].after, "Other", "mapped the typo'd stated answer to the option");
  const prompts = act.log.filter(([m]) => m === "llm").map(([, u]) => u).join("\n");
  assert.ok(/Otherrr/.test(prompts), "the AI prompt carried the applicant's STATED answer");
  assert.ok(!/Carnegie/.test(prompts), "the AI prompt did NOT carry the whole profile (no school → no wrong inference, fewer tokens)");
});

test("source AI commit: a multi-result that does NOT autocommit → Enter-AGAIN commits the top (the exact match) → filled with the AI's leaf", async () => {
  // Operator bug: after the AI types the leaf, Workday filters to "Search Results (2): Other / Others" and does
  // NOT autocommit. The commit ladder DETECTS no-autocommit, falls to a click (here disabled to force the next
  // rung), then presses Enter AGAIN, which commits the TOP (always the exact match). Verify lands the AI's leaf.
  const field = srcField({
    wrapperSel: "[w-src]",
    clickCommitFails: true, // force past the click rung to the Enter-again rung
    filterMap: { "carrier pidgon": { banner: true }, "Other": { commitOnReEnter: "Other", results: ["Other", "Others"] } },
    treeCategories: ["Job Boards", "Other Sources"],
    treeLeaves: { "Other Sources": ["Newspaper", "Other"] }
  });
  const act = makeFakeAct([field], { aiEnabled: true, ai: ['{"choice":"Other Sources"}', '{"choice":"Other"}'] });
  const profile = Object.assign({}, nameProfile, { how_did_you_hear: { preferred: ["carrier pidgon"] } });
  const out = await drivePageFill(act, profile, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled_review");
  assert.strictEqual(rec.flag, "ai-choice");
  assert.strictEqual(rec.after, "Other", "committed exactly the AI's leaf (the top exact match), never 'Others'");
  assert.strictEqual(act.log.filter(([m]) => m === "pressEnter").length >= 2, true, "pressed Enter AGAIN to commit the un-autocommitted top");
});

test("source AI commit: the AI's leaf ALREADY equals the committed chip → SKIP the re-commit (zero actuation)", async () => {
  // Optimization: the field is pre-filled "Other"; the deterministic candidate ("LinkedIn") doesn't match → the
  // AI drills and picks "Other" — which is already committed. The commit ladder must SKIP entirely (no clear/
  // type/Enter), keeping the existing chip.
  const field = srcField({
    wrapperSel: "[w-src]",
    chips: ["Other"], // pre-filled
    filterMap: { "LinkedIn": { banner: true } }, // the deterministic candidate no-matches → overwrite path → AI drill
    treeCategories: ["Social", "Other Sources"],
    treeLeaves: { "Other Sources": ["Newspaper", "Other"] }
  });
  const act = makeFakeAct([field], { aiEnabled: true, ai: ['{"choice":"Other Sources"}', '{"choice":"Other"}'] });
  const profile = Object.assign({}, nameProfile, { how_did_you_hear: { preferred: ["LinkedIn"] } });
  const out = await drivePageFill(act, profile, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled_review");
  assert.strictEqual(rec.after, "Other");
  assert.match(rec.detail, /already committed/);
  assert.ok(!act.log.some(([m]) => m === "typeInSourceSearch"), "skipped the re-commit — no re-typing of an already-correct chip");
  assert.ok(act.log.some(([m]) => m === "pressTab"), "closed the still-open drill box via Tab (chip kept)");
});

test("source AI commit (SAFETY): the leaf never lands → ai-commit-failed, never a false fill", async () => {
  // If neither the filter-Enter, the click, NOR Enter-again lands a chip equal to the AI's leaf, the commit gate
  // REJECTS it (ai-commit-failed) — what the AI chose is what gets filled, or nothing is reported filled.
  const field = srcField({
    wrapperSel: "[w-src]",
    clickCommitFails: true,
    filterMap: { "carrier pidgon": { banner: true }, "Other": { filtered: ["Other", "Others"] } }, // multi-result, never commits
    treeCategories: ["Job Boards", "Other Sources"],
    treeLeaves: { "Other Sources": ["Newspaper", "Other"] }
  });
  const act = makeFakeAct([field], { aiEnabled: true, ai: ['{"choice":"Other Sources"}', '{"choice":"Other"}'] });
  const profile = Object.assign({}, nameProfile, { how_did_you_hear: { preferred: ["carrier pidgon"] } });
  const out = await drivePageFill(act, profile, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.flag, "ai-commit-failed");
});

test("source AI: no categories (nothing to enumerate) → needs_review, no LLM (never guess blind)", async () => {
  const field = srcField({ wrapperSel: "[w-src]", filterMap: { "carrier pidgon": { banner: true } } }); // no treeCategories
  const act = makeFakeAct([field], { aiEnabled: true, ai: '{"choice":"Other"}' });
  const profile = Object.assign({}, nameProfile, { how_did_you_hear: { preferred: ["carrier pidgon"] } });
  const out = await drivePageFill(act, profile, {}, {}, T_BUDGETS);
  assert.strictEqual(out.results[0].status, "needs_review");
  assert.ok(!act.log.some(([m]) => m === "llm"), "no categories → bailed before any LLM call");
});

test("source AI OFF: a no-match with a category view is a byte-identical no-op (needs_review, NO drill, NO LLM)", async () => {
  const field = srcField({
    wrapperSel: "[w-src]",
    filterMap: { "Carrier Pigeon": { filtered: ["Facebook", "Twitter"] } },
    treeCategories: ["Job Boards"], treeLeaves: { "Job Boards": ["LinkedIn"] }, commitVia: "chip"
  });
  const act = makeFakeAct([field], { aiEnabled: false, ai: ['{"choice":"Job Boards"}', '{"choice":"LinkedIn","represented":true}'] });
  const profile = Object.assign({}, nameProfile, { how_did_you_hear: { preferred: ["Carrier Pigeon"] } });
  const out = await drivePageFill(act, profile, {}, {}, T_BUDGETS);
  assert.strictEqual(out.results[0].status, "needs_review");
  assert.ok(!act.log.some(([m]) => m === "llm"), "AI off → no provider call, no drill");
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
  assert.ok(idx("scrapeTaOptions") >= 0 && idx("scrapeTaOptions") < idx("clearHierSearch"), "scrape ran BEFORE the first clearSearch (i.e. before the candidate loop)");
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
  const typeIdx = seq.indexOf("typeInHier");
  const reassertIdx = seq.lastIndexOf("focusHierSearch", typeIdx); // the loop's focus re-assert
  assert.ok(seq.indexOf("scrapeTaOptions") < reassertIdx, "scrape is BEFORE the loop's focus re-assert");
  assert.ok(reassertIdx >= 0 && reassertIdx < typeIdx, "re-assert is immediately before the type");
  assert.deepStrictEqual(seq.slice(reassertIdx + 1, typeIdx).filter((m) => m !== "clearHierSearch"), [], "ONLY clearSearch between the re-assert and the type — no scrape/read/settle in that gap");
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
  assert.ok(act.log.some(([m]) => m === "focusHierSearch"), "the re-commit re-focused the dropped searchBox before re-typing");
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
  assert.ok(act.log.some(([m, t]) => m === "clickHierLeaf" && t === "Other"), "the affirmative click overwrote the stray with the kept value");
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
  const typed = act.log.filter(([m]) => m === "typeInHier").map(([, t]) => t);
  assert.deepStrictEqual(typed, ["Electrical and Computer Engineering", "Other"]);
  assert.strictEqual(enters(act), 2, "cand-0: filter-Enter (banner); cand-1: filter-Enter then click-by-label commit (no commit-Enter)");
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
  const typed = act.log.filter(([m]) => m === "typeInHier").map(([, t]) => t);
  assert.deepStrictEqual(typed, ["United States of America (+1)"], "walk stops — a chip exists; more typing contaminates");
});

test("typeahead: click-by-label commits the matched leaf at ANY index (merge: index-0 gate removed)", async () => {
  // Pre-merge a match not at index 0 was REFUSED (the commit-Enter could only take the highlighted first
  // option). The unified filler commits by VIEWPORT-AWARE click-by-LABEL → an exact match at index 1 commits.
  let act = makeFakeAct([taField({ filterMap: { "Other": { filtered: ["Other Technology", "Other"] } } })]);
  let out = await drivePageFill(act, taProfile(["Other"]), {}, {}, T_BUDGETS);
  assert.strictEqual(out.results[0].status, "filled");
  assert.strictEqual(out.results[0].after, "Other");
  assert.strictEqual(out.results[0].verified, true);
  assert.ok(act.log.some(([m, t]) => m === "clickHierLeaf" && t === "Other"), "committed the matched leaf by label, not by position");
  assert.strictEqual(enters(act), 1, "only the filter-Enter — no commit-Enter (click commits)");
  // index 0 also commits
  act = makeFakeAct([taField({ filterMap: { "Other": { filtered: ["Other", "Other Technology"] } } })]);
  out = await drivePageFill(act, taProfile(["Other"]), {}, {}, T_BUDGETS);
  assert.strictEqual(out.results[0].status, "filled");
  assert.strictEqual(out.results[0].after, "Other");
});

test("typeahead: two identical 'Other' leaves (multi-tree tie) → commit the FIRST by click-by-label (the AI-'Other' edge case)", async () => {
  // The operator edge case: a typed 'Other' doesn't auto-commit because two sub-trees each carry an 'Other';
  // matchCandidates' exact tier resolves the duplicate to its FIRST index, and clickHierLeaf clicks the first
  // DOM node with that label → "pick the first if it matches" (never a blind auto-commit on the ambiguous filter).
  const act = makeFakeAct([taField({ filterMap: { "Other": { filtered: ["Other", "Other"] } } })]);
  const out = await drivePageFill(act, taProfile(["Other"]), {}, {}, T_BUDGETS);
  assert.strictEqual(out.results[0].status, "filled");
  assert.strictEqual(out.results[0].after, "Other");
  assert.strictEqual(out.results[0].verified, true);
  assert.ok(act.log.some(([m, t]) => m === "clickHierLeaf" && t === "Other"), "clicked 'Other' (the first matching leaf)");
});

test("Fix 2: a FLAT typeahead start-scrapes options ONCE → rec.options (review) + the flat AI uses them, NO scrape after the deterministic fail", async () => {
  // A FLAT typeahead scrapes its full list at the START (before the candidate loop). The captured list is
  // recorded for the REVIEW page AND reused by the inline AI on a no-match — so there is NO scrape after the
  // deterministic fill fails (the operator's ask). The AI's 'Other' commits via the re-entry.
  const f = taField({ scrapeOptions: ["Accounting", "Other", "Biology"], filterMap: { "Zzz": { banner: true }, "Other": { autoCommit: "Other" } } });
  const act = makeFakeAct([f], { aiEnabled: true, ai: '{"choice":"Other","represented":false}' });
  const out = await drivePageFill(act, taProfile(["Zzz"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.deepStrictEqual(rec.options, ["Accounting", "Other", "Biology"], "the START-scrape is recorded for the review page");
  assert.strictEqual(rec.status, "filled_review");
  assert.match(rec.flag, /^ai-choice/, "the flat AI committed from the START-scraped list");
  assert.ok(!act.log.some(([m]) => m === "scrapeSourceRows"), "NO AI-stage scrape — the flat options came from the START scrape");
  // scrapeTaOptions ran exactly ONCE (the start), never again at the AI stage.
  assert.strictEqual(act.log.filter(([m]) => m === "scrapeTaOptions").length, 1, "scraped once, at the start");
});

test("Fix 2: makeStartCapture — FLAT scrapes once (review options); a TREE returns null with NO scrape (no wasted scroll)", async () => {
  // FLAT: scrapeTaOptions → the full list is returned (capturedFull for the AI) AND recorded for the review page.
  const flat = makeFakeAct([taField({ scrapeOptions: ["Accounting", "Biology"] })]);
  const capF = makeStartCapture(flat, { wrapperSel: "[w-ta]" });
  assert.deepStrictEqual(await capF.onCapture(), ["Accounting", "Biology"], "flat → the start-scrape returns the full list");
  assert.deepStrictEqual(capF.reviewOptions(), ["Accounting", "Biology"], "flat → recorded for the review page");
  // TREE: the cheap readTreeCategories detect sees categories → returns null, scraping NOTHING (no scroll), and
  // recording NO review options — the AI tree drill self-scrapes categories/leaves only if the deterministic fails.
  const tree = makeFakeAct([srcField({ treeCategories: ["Social Media", "Job Board"], scrapeOptions: ["should-not-be-scraped"] })]);
  const capT = makeStartCapture(tree, { wrapperSel: "[w-src]" });
  assert.strictEqual(await capT.onCapture(), null, "tree → NOT start-scraped");
  assert.strictEqual(capT.reviewOptions(), null, "tree → no review options");
  assert.ok(!tree.log.some(([m]) => m === "scrapeTaOptions"), "tree → no scrapeTaOptions (no wasted scroll on a successful fill)");
});

test("required-empty typeahead (flat): AI ON → infers from the profile + FORCES a pick (filled_review), never left skipped to block Next", async () => {
  // A REQUIRED typeahead with NO profile value is skipped by resolve(); a blank required field blocks Save &
  // Continue, so the AI must produce a best-guess. With no STATED answer it infers from the profile + forces a pick.
  const field = taField({ isRequired: true, scrapeOptions: ["Accounting", "Biology", "Other"], filterMap: { "Biology": { autoCommit: "Biology" } } });
  const act = makeFakeAct([field], { aiEnabled: true, ai: '{"choice":"Biology","represented":true}' });
  const out = await drivePageFill(act, {}, {}, {}, T_BUDGETS); // NO profile value → resolve skips → required-empty AI fill
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled_review", "a required empty typeahead is AI-filled, not left skipped");
  assert.strictEqual(rec.after, "Biology");
  assert.match(rec.flag, /^ai-/);
});

test("required-empty typeahead (flat): AI OFF → stays skipped, ZERO actuation (can't infer — left for the operator)", async () => {
  const field = taField({ isRequired: true, scrapeOptions: ["Accounting", "Biology"] });
  const act = makeFakeAct([field], { aiEnabled: false });
  const out = await drivePageFill(act, {}, {}, {}, T_BUDGETS);
  assert.strictEqual(out.results[0].status, "skipped");
  assert.ok(!act.log.some(([m]) => m === "openHier"), "AI off → no actuation");
});

test("required-empty typeahead: OPTIONAL empty typeahead is NOT AI-filled — stays skipped (only required fields are forced)", async () => {
  const field = taField({ isRequired: false, scrapeOptions: ["Accounting", "Biology"] });
  const act = makeFakeAct([field], { aiEnabled: true, ai: '{"choice":"Biology","represented":true}' });
  const out = await drivePageFill(act, {}, {}, {}, T_BUDGETS);
  assert.strictEqual(out.results[0].status, "skipped", "an OPTIONAL empty field doesn't block Next → no forced AI guess");
});

test("required-empty typeahead (section / FoS): AI ON → infers + forces a pick (filled_review), never left skipped", async () => {
  // The operator's real case: an Education entry's REQUIRED fieldOfStudy has no profile value → resolve skips it →
  // the section analog of the flat block AI-fills it (infer from profile + force a pick) rather than leaving it
  // blank to block Save & Continue.
  const eduEntry = (fkit) => ({ fkit, fields: [{ fieldName: "fieldOfStudy", widgetType: "typeahead", isRequired: true, chips: [], scrapeOptions: ["Accounting", "Biology", "Other"], filterMap: { "Biology": { autoCommit: "Biology" } } }] });
  const fieldMap = [{ field: "fieldOfStudy", widget: "typeahead", key: "fos", path: "field_of_study" }];
  const items = [{}]; // no fos value → resolve skips → required-empty AI fill
  const state = { prefix: "education-", addable: true, deletable: true, aiEnabled: true, ai: '{"choice":"Biology","represented":true}', newEntry: (i) => eduEntry("education-new" + i), entries: [eduEntry("education-0--null")] };
  const act = makeFakeRepeatAct(state);
  const out = await driveRepeatingSectionCdp(act, { name: "education", headingRegex: "education", containerPrefix: "education-", items, fieldMap, deleteOnNoMatch: false, aiContext: { profile: {}, jobContext: {} } }, T_BUDGETS);
  const fos = out.results.find((r) => r.fieldName === "education[0].fieldOfStudy");
  assert.strictEqual(fos.status, "filled_review", "a required empty section typeahead is AI-filled, not skipped");
  assert.strictEqual(fos.after, "Biology");
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
  assert.ok(act.log.some(([m]) => m === "clickHierLeaf"));
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
  const typed = act.log.filter(([m]) => m === "typeInHier").map(([, t]) => t);
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
  assert.strictEqual(rec.settle_trace[0].note, "matched leaf but commit did not verify (no isselected flip / chip)");
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

test("overwrite: no candidate matches → needs_review / overwrite-nomatch-original-kept, ORIGINAL preserved + Tab-blur exit", async () => {
  const field = taField({ chips: ["Canada (+1)"], filterMap: { "United States of America (+1)": { banner: true } } });
  const act = makeFakeAct([field]);
  const out = await drivePageFill(act, taProfile(["United States of America (+1)"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.flag, "overwrite-nomatch-original-kept");
  assert.strictEqual(rec.after, "Canada (+1)");                          // the original, NOT empty
  assert.deepStrictEqual(rec.overwrite, { original: "Canada (+1)", refilled: false });
  assert.deepStrictEqual(field.chips, ["Canada (+1)"], "original chip NEVER destroyed on a no-match");
  assert.ok(act.log.some(([m]) => m === "pressTab"), "exited via Tab (the only clean non-committing exit)");
  assert.ok(!act.log.some(([m]) => m === "pressEscape"), "NOT via Escape (Escape keeps the armed row → next-field stray)");
});

test("overwrite no-match: a post-Tab chip differing from the original (stray backstop) → needs_review/overwrite-stray, NEVER a false keep", async () => {
  // The fieldOfStudy "Accounting" class: the no-match search arms row-0. Tab is meant to abandon it,
  // but on a hypothetical tenant where Tab STILL commits the armed row, the strayed-check must FLAG
  // the live value (not report a false "kept original"). Models the stray via strayChipOnTab.
  const field = taField({ chips: ["Canada (+1)"], filterMap: { "United States of America (+1)": { banner: true } }, strayChipOnTab: "Accounting" });
  const act = makeFakeAct([field]);
  const out = await drivePageFill(act, taProfile(["United States of America (+1)"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.flag, "overwrite-stray", "a strayed Tab-exit is flagged, not a false keep");
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
  const typed = act.log.filter(([m]) => m === "typeInHier").map(([, t]) => t);
  assert.deepStrictEqual(typed, ["United States of America (+1)"]);
});

// ── M36.1 tier-aware pre-filled guard ────────────────────────────────────────
// A pre-fill matching a LOWER tier was kept priority-blind (the live fieldOfStudy
// bug: a stale tier-3 "electrical engineering" kept over the reordered tier-1
// "Other"). Now: tier 0 → keep, ZERO actuation (countryPhoneCode auto-derive);
// tier k>0 → walk only the HIGHER tiers and overwrite to the BEST offered, keeping
// the pre-fill if none is offered; tier -1 → full overwrite walk (unchanged).
const taTypedQueries = (act) => act.log.filter(([m]) => m === "typeInHier").map(([, t]) => t);

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
  assert.ok(!act.log.some(([m]) => m === "clearHierSearch"), "no Ctrl+A clear");
  assert.ok(!act.log.some(([m]) => m === "typeInHier"), "no typing");
  assert.ok(!act.log.some(([m]) => m === "pressEnter"), "no Enter");
  // …but DO blur via Tab on the way out: a prior candidate may have armed row-0; Tab abandons it.
  assert.ok(act.log.some(([m]) => m === "pressTab"), "blurred via Tab so no armed row can stray to the next field");
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
  assert.ok(act.log.some(([m]) => m === "pressTab"), "blurred via Tab on the could-not-type bail — no armed row left to stray");
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

test("typeahead directed containment is AMBIGUITY-SAFE: 2 containing options → escalate, never commit index 0", async () => {
  // The bug that WAS: "United States" filtered to TWO options both containing it; the old ladder
  // committed index 0 and only got lucky on order. Now → ambiguous → no commit → genuine no-match.
  const act = makeFakeAct([taField({ filterMap: { "United States": { filtered: ["United States of America (+1)", "United States Minor Outlying Islands"] } } })]);
  const out = await drivePageFill(act, taProfile(["United States"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.genuineNoMatch, true);
  assert.strictEqual(rec.after, null); // the wrong value was NOT committed
});

test("typeahead directed containment STILL commits when UNAMBIGUOUS (only one option contains the value)", async () => {
  // candidate "United States" filters to ONE containing option (+ an unrelated one) → directed commit.
  const act = makeFakeAct([taField({ filterMap: { "United States": { filtered: ["United States of America (+1)", "Canada (+1)"] } } })]);
  const out = await drivePageFill(act, taProfile(["United States"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled_review");
  assert.strictEqual(rec.flag, "directed-containment");
  assert.strictEqual(rec.confidence, "low");
  assert.strictEqual(rec.after, "United States of America (+1)");
  assert.strictEqual(rec.matchTier, "click-commit"); // commit-path (unified click-by-label), not the match tier
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
  assert.ok(act.log.some(([m]) => m === "clickHierLeaf"));
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

// ── source FIRST-OPEN render gate (awaitSourceListStable — the open-race fix, source variant) ──

test("awaitSourceListStable: WAITS for the source popup to render — 'stable' only once the category rows appear", async () => {
  // Source shows NO leaves on open (leafCount stays 0 until a query filters to leaves); the on-open content is
  // the CHEVRON CATEGORY rows. Model categories that render on the 3rd read → the gate must keep polling until
  // they're present + stable, never returning "stable" off the empty initial reads.
  let catReads = 0;
  const act = {
    delay: async () => {},
    readSource: async () => ({ leafCount: 0, searchBox: { visible: true } }), // never any leaves on open
    readTreeCategories: async () => { catReads++; return catReads >= 3 ? ["Social Media", "Job Board"] : []; }
  };
  const r = await awaitSourceListStable(act, { wrapperSel: "[w]" }, T_BUDGETS);
  assert.strictEqual(r, "stable");
  assert.ok(catReads >= 4, "polled past the empty reads until the categories rendered AND held stable (never typed into an empty popup)");
});

test("awaitSourceListStable: nothing ever renders → 'timeout' (PROCEEDS, never hangs — worst case == today)", async () => {
  const act = { delay: async () => {}, readSource: async () => ({ leafCount: 0 }), readTreeCategories: async () => [] };
  assert.strictEqual(await awaitSourceListStable(act, { wrapperSel: "[w]" }, T_BUDGETS), "timeout");
});

test("awaitSourceListStable: a tenant that opens straight to LEAVES (no categories) also satisfies the gate", async () => {
  const act = { delay: async () => {}, readSource: async () => ({ leafCount: 5, searchBox: { visible: true } }), readTreeCategories: async () => [] };
  assert.strictEqual(await awaitSourceListStable(act, { wrapperSel: "[w]" }, T_BUDGETS), "stable");
});

test("source first-open render gate: source routes through the unified filler; opened BEFORE the first type", async () => {
  // Source is the SAME widget as the cert typeahead (recon 2026-06-28) → it routes through the merged
  // fillTypeaheadCdp, whose unified open-race gate (awaitListStable, unit-tested separately) awaits the OPEN
  // popup before typing. Source opens to a FLAT leaf list (no categories); LinkedIn auto-commits (happy path).
  const f = srcField({ openLeaves: ["LinkedIn", "Facebook", "Indeed"], filterMap: { LinkedIn: { autoCommit: "LinkedIn" } } });
  const act = makeFakeAct([f]);
  const rec = await fillSourceCdp(act, { wrapperSel: f.wrapperSel }, ["LinkedIn"], T_BUDGETS);
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "LinkedIn");
  const firstOpen = act.log.findIndex(([m]) => m === "openHier");
  const firstType = act.log.findIndex(([m]) => m === "typeInHier");
  assert.ok(firstOpen >= 0 && firstOpen < firstType, "opened the popup BEFORE the first type (unified open-race gate)");
});

test("source: no candidate in its filtered set → needs_review", async () => {
  const { rec } = await runSource(srcField({ filterMap: { LinkedIn: { filtered: ["Facebook", "Twitter"] } } }), ["LinkedIn"]);
  assert.strictEqual(rec.status, "needs_review");
  assert.match(rec.detail, /no candidate produced a verified chip/);
});

test("source: matched leaf but commit click fails → needs_review, never false-filled", async () => {
  const { rec } = await runSource(srcField({ clickCommitFails: true, commitVia: "leaf", filterMap: { LinkedIn: { filtered: ["LinkedIn", "LinkedIn Learning"] } } }), ["LinkedIn"]);
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.verified, false);
});

test("source: searchBox focus cannot be confirmed → ZERO actuation, needs_review", async () => {
  const { rec, act } = await runSource(srcField({ focusUnconfirmable: true, filterMap: { LinkedIn: { autoCommit: "LinkedIn" } } }), ["LinkedIn"]);
  assert.strictEqual(rec.status, "needs_review");
  assert.match(rec.detail, /could not focus the search field/);
  assert.ok(!act.log.some(([m]) => m === "clearHierSearch"), "no clear");
  assert.ok(!act.log.some(([m]) => m === "typeInHier"), "no typing");
  assert.ok(!act.log.some(([m]) => m === "pressEnter"), "no Enter");
  assert.ok(!act.log.some(([m]) => m === "clickHierLeaf"), "no leaf click");
  assert.ok(act.log.some(([m]) => m === "pressTab"), "blurred via Tab (lockstep with typeahead)");
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

test("source overwrite: no candidate matches → needs_review / overwrite-nomatch-original-kept, original preserved + Tab-blur exit (lockstep)", async () => {
  const field = srcField({ chips: ["Family"], filterMap: { LinkedIn: { banner: true } } });
  const { rec, act } = await runSource(field, ["LinkedIn"]);
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.flag, "overwrite-nomatch-original-kept");
  assert.strictEqual(rec.after, "Family");
  assert.deepStrictEqual(field.chips, ["Family"], "original source chip never destroyed");
  assert.ok(act.log.some(([m]) => m === "pressTab"), "exited via Tab (lockstep with typeahead)");
  assert.ok(!act.log.some(([m]) => m === "pressEscape"), "NOT via Escape");
});

// M36.1 tier-aware pre-filled guard — source, in LOCKSTEP with the typeahead tests above.
const srcTypedQueries = (act) => act.log.filter(([m]) => m === "typeInHier").map(([, t]) => t);

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
  assert.strictEqual(rec.matchTier, "click-commit");
});

test("typeahead: walk-dry but a stray chip is present → record reports it, never after:null", async () => {
  // No candidate matches (banner), but a stray chip sits on the field at
  // walk-end (a late highlight-Enter commit our settle missed). The honesty
  // read must surface it instead of claiming the field is empty.
  const act = makeFakeAct([taField({
    fallbackTexts: ["Afghanistan (+93)"],
    filterMap: { "United States of America (+1)": { banner: true } }
  })]);
  // The stray exists only at walk-END (the honesty read inside tabBlurExit happens after the Tab):
  // flip a flag in pressTab, inject the chip on reads after it.
  const origRead = act.readHier, origTab = act.pressTab;
  let walkEnded = false;
  act.pressTab = async (...a) => { walkEnded = true; return origTab(...a); };
  act.readHier = async (loc) => {
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
  let focusedTa = null;  // a focused typeahead (the delete-vs-AI-defer test)
  let scanCount = 0;     // M37: a field with `appearsAtScan: N` is OMITTED until the Nth
                         // repeatingScan — models a field that REMOUNTS (WE endDate after
                         // unchecking currentlyWorkHere) so the waitForPresence poll is testable.
  let _llmIdx = 0;       // tree-AI: state.ai may be a SEQUENCE [categoryReply, leafReply] consumed in order.
  return {
    log,
    // delete-vs-AI defer: driveRepeatingSectionCdp reads act.aiEnabled. Defaults OFF (existing tests
    // unchanged → aiWillRescue false → delete behavior identical).
    aiEnabled: !!state.aiEnabled,
    // Option B inline AI: the LLM seam. state.ai is a single reply (string/object) OR a SEQUENCE (array)
    // consumed in order — the latter for the cert tree drill's two prompts (category, then leaf).
    llm: async (req) => { log.push(["llm", req && req.user]); const a = Array.isArray(state.ai) ? state.ai[Math.min(_llmIdx++, state.ai.length - 1)] : state.ai; if (a === undefined || a === null) return { ok: false, error: "no canned reply" }; return typeof a === "string" ? { ok: true, text: a } : a; },
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
    pressTab: async () => { log.push(["pressTab"]); state.entries.forEach((e) => e.fields.forEach((f) => { f._open = false; })); },
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
    },
    // typeahead (the delete-vs-AI-defer test) — a minimal mirror of makeFakeAct's typeahead model
    // (chips/filterMap/_open/_texts/_banner). Drives a required repeating typeahead to a GENUINE
    // no-match (filterMap → banner) so the defer's aiTypeaheadEligible path is exercised.
    openHier: async (loc) => { log.push(["openHier", loc.wrapperSel]); const f = byLoc(loc); if (!f) return false; f._open = true; if (!f.focusUnconfirmable) f._focusedSb = true; if (f._texts === undefined) f._texts = (f.openTexts || f.openLeaves || []).slice(); if (f._banner === undefined) f._banner = false; focusedTa = f; return true; },
    focusHierSearch: async (loc) => { log.push(["focusHierSearch", loc.wrapperSel]); const f = byLoc(loc); if (f && !f.focusUnconfirmable) f._focusedSb = true; focusedTa = f; return true; },
    readHier: async (loc) => {
      const f = byLoc(loc); if (!f) return null;
      const texts = f._open ? (f._texts || []) : [];
      const sig = (f._rev || 0) + "|" + texts.length + "|" + texts.slice(0, 3).join("~");
      return { searchBox: { present: !!f._open, visible: !!f._open, focused: !!(f._open && f._focusedSb), value: f._value || "" },
        chips: (f.chips || []).slice(),
        banner: f._open && f._banner ? { text: "No matches found", automationId: "promptTitle" } : null,
        resultsBanner: !!(f._open && f._resultsBanner),
        pageWide: { count: texts.length, sig, sample: texts.slice(0, 10), texts: texts.slice(0, 40) },
        leaves: texts.slice(0, 40), leafCount: texts.length, msId: (f && f.msId) || null, activeText: null };
    },
    clearHierSearch: async () => { log.push(["clearHierSearch"]); if (focusedTa) { focusedTa._value = ""; focusedTa._filtered = false; } },
    typeInHier: async (t) => { log.push(["typeInHier", t]); if (focusedTa) { focusedTa._value = t; focusedTa._filtered = false; focusedTa._resultsBanner = false; } },
    clickHierLeaf: async (loc, label) => { log.push(["clickHierLeaf", label]); const f = focusedTa || byLoc(loc); if (!f || !(f._texts || []).some((t) => t === label)) return false; if (f.clickCommitFails) return true; const committed = f.clickCommitsWrongText || label; if (f.commitVia === "isselected" || f.commitVia === "leaf") { f._selectedLeaf = committed; } else { f.chips = [committed]; f._selectedLeaf = committed; } f._open = false; return true; },
    probeHierLeaf: async (label) => { const f = focusedTa; return { found: !!(f && (f._texts || []).includes(label)), commitWrapper: { isSelectedValue: (f && f._selectedLeaf === label) ? "true" : "false" }, rect: { cx: 1, cy: 1, w: 10, h: 10 } }; },
    pressEnter: async () => {
      log.push(["pressEnter"]);
      const ta = focusedTa;
      if (!ta || !ta._open) return;
      if (!ta._filtered) {
        const fm = (ta.filterMap || {})[ta._value];
        if (fm) { ta._rev = (ta._rev || 0) + 1;
          if (fm.banner) { ta._banner = true; ta._resultsBanner = false; ta._texts = (ta.fallbackTexts || ta._texts || []).slice(); ta._filtered = true; }
          else if (fm.autoCommit) { ta.chips = [fm.autoCommit]; ta._open = false; ta._banner = false; ta._resultsBanner = false; }
          else if (fm.filtered) { ta._banner = false; ta._filtered = true; ta._texts = fm.filtered.slice(); ta._resultsBanner = ta._texts.length > 0; }
        }
      } else if (!ta.enterCommitFails && (ta._texts || []).length && !ta._banner) { ta.chips = [ta._texts[0]]; ta._open = false; }
    },
    // ── tree picker (cert) seams ── a field carries `tree: { categories:[], leaves:{cat:[full…]} }`. NO `tree`
    // ⇒ readTreeCategories returns [] ⇒ tryInlineAi routes FLAT (every non-tree test byte-identical). The UNIFIED
    // type-commit drill (aiTreeDrillFallback): scrapeSourceRows → on-open categories / drilled-category leaves;
    // expandCategory CLICK-drills (sets `_treeExpanded`); the chosen leaf is committed by TYPING (focus → clear →
    // type → pressEnter → clickSourceLeaf fallback). readSource exposes searchBox.value (for the echo poll) + chips.
    readTreeCategories: async (loc) => { const f = byLoc(loc); if (!f || !f.tree) return []; return f._treeExpanded ? [] : f.tree.categories.slice(); },
    scrapeSourceRows: async (loc) => { log.push(["scrapeSourceRows", loc.wrapperSel]); const f = byLoc(loc); if (!f || !f.tree) return { ok: false }; return f._treeExpanded ? { ok: true, options: (f.tree.leaves[f._treeExpanded] || []).slice(), banner: f._treeExpanded, atBottom: true } : { ok: true, options: f.tree.categories.slice(), banner: "No matches found", atBottom: true }; },
    scrapeTaOptions: async (loc) => { log.push(["scrapeTaOptions", loc.wrapperSel]); const f = byLoc(loc); if (!f || f.scrapeFails) return { ok: false }; const options = (f.scrapeOptions || []).slice(); return { ok: true, options, count: options.length, atBottom: true }; },
    expandCategory: async (loc, label) => { log.push(["expandCategory", label]); const f = byLoc(loc); if (!f || !f.tree || !f.tree.categories.includes(label)) return false; f._treeExpanded = label; focusedTa = f; return true; },
    readTreeLeaves: async (loc) => { const f = byLoc(loc); if (!f || !f.tree || !f._treeExpanded) return []; return (f.tree.leaves[f._treeExpanded] || []).slice(); },
    focusSourceSearch: async (loc) => { log.push(["focusSourceSearch"]); const f = byLoc(loc); focusedTa = f; if (f && !f.focusUnconfirmable) f._focusedSb = true; return true; },
    clearSourceSearch: async () => { if (focusedTa) focusedTa._value = ""; },
    typeInSourceSearch: async (t) => { log.push(["typeInSourceSearch", t]); if (focusedTa) focusedTa._value = t; },
    clickSourceLeaf: async (label) => { log.push(["clickSourceLeaf", label]); const f = focusedTa; if (!f || !f.tree || !f._treeExpanded || !(f.tree.leaves[f._treeExpanded] || []).includes(label)) return false; f.chips = [label]; f._open = false; return true; },
    readSource: async (loc) => { const f = byLoc(loc); return { searchBox: { present: !!(f && f._open), visible: !!(f && f._open), focused: !!(f && f._focusedSb), value: (f && f._value) || "" }, chips: (f && f.chips) ? f.chips.slice() : [] }; }
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

test("repeating N===0: deletes phantom entries, records a section STUB (Feature A)", async () => {
  const state = webState({ entries: [webEntry("webAddress-1--null"), webEntry("webAddress-2--null")] });
  const { out, state: s } = await runWeb(state, []);
  assert.strictEqual(s.entries.length, 0);
  assert.strictEqual(out.results.find((r) => r.fieldName === "website.delete").status, "filled");
  const skip = out.results.find((r) => r.fieldName === "website");
  assert.strictEqual(skip.status, "skipped");
  assert.match(skip.detail, /no meaningful website entries/);
  // Feature A: a present-but-empty section is now a section_stub (surfaces in review), not a
  // silently-filtered "section" op. canonical "<name>._stub" groups it under its section.
  assert.strictEqual(skip.widgetType, "section_stub");
  assert.strictEqual(skip.flag, "section-stub");
  assert.strictEqual(skip.mappedPath, "website._stub");
  assert.ok(!out.results.some((r) => /\.url$/.test(r.fieldName)));
});

test("section_stub flows through buildReviewBundle as a needs_review category (Feature A)", () => {
  const recs = [{ fieldName: "certification", label: "Certification — section present, no entries",
    widgetType: "section_stub", isRequired: false, mappedPath: "certification._stub",
    status: "skipped", flag: "section-stub", after: null,
    detail: "no meaningful certification entries to fill — the section is on the form but empty" }];
  const bundle = buildReviewBundle(recs, { page: "p1" });
  assert.strictEqual(bundle.entries.length, 1); // KEPT (unlike the .add/.delete "section" ops, which are filtered)
  const e = bundle.entries[0];
  assert.strictEqual(e.widget_type, "section_stub");
  assert.strictEqual(e.canonical_field, "certification._stub");
  assert.strictEqual(e.needs_review, true);
  assert.strictEqual(e.needs_review_reason, "section_unfilled");
  assert.strictEqual(e.fill_status, "skipped");
  assert.strictEqual(e.current_value, null);
});

test("section_stub carries section_field_shape into the bundle (2b: viewer builds a new entry)", () => {
  const recs = [{ fieldName: "website", label: "Website — section present, no entries",
    widgetType: "section_stub", isRequired: false, mappedPath: "website._stub",
    status: "skipped", flag: "section-stub", after: null, detail: "empty",
    section_field_shape: [{ recName: "url", widget_type: "text", path: "url" }] }];
  const bundle = buildReviewBundle(recs, { page: "p2" });
  assert.deepStrictEqual(bundle.entries[0].section_field_shape, [{ recName: "url", widget_type: "text", path: "url" }]);
});

test("buildReviewBundle carries date_order onto a date entry (m3c — segmented editor for all dates)", () => {
  const recs = [{ fieldName: "workExperience[0].startDate", widgetType: "date", isRequired: true, mappedPath: "workExperience[0].from", status: "filled", after: "5/2025", date_order: ["month", "year"] }];
  const e = buildReviewBundle(recs, { page: "p2" }).entries[0];
  assert.deepStrictEqual(e.date_order, ["month", "year"]); // → the summary renders MM/YYYY, not a text box
  assert.strictEqual(e.widget_type, "date");
});

test("detectSectionShapes: reads the field SET from a live scan, keyed by section NAME (2c)", () => {
  const scan = { sections: {
    "certification-": { entries: [{ fields: [
      { fieldName: "certification", widgetType: "typeahead", label: "Certification*", isRequired: true },
      { fieldName: "certificationNumber", widgetType: "text", label: "Number", isRequired: false },
    ] }] },
    "education-": { entries: [] }, // present but no fields → ignored
  } };
  const shapes = detectSectionShapes(scan);
  assert.ok(shapes.certification, "keyed by the PAGE_SECTIONS name, not the container prefix");
  assert.strictEqual(shapes.certification.length, 2);
  assert.deepStrictEqual(shapes.certification[0], { recName: "certification", path: "certification", widget_type: "typeahead", label: "Certification*", is_required: true });
  assert.ok(!("education" in shapes), "a present-but-empty section yields no shape (nothing to read)");
});
test("detectSectionShapes: empty/missing scan → {}", () => {
  assert.deepStrictEqual(detectSectionShapes(null), {});
  assert.deepStrictEqual(detectSectionShapes({}), {});
});
test("buildReviewBundle carries section_shapes onto the bundle (2c); defaults to {}", () => {
  const shapes = { website: [{ recName: "url", path: "url", widget_type: "text", label: "URL", is_required: true }] };
  assert.deepStrictEqual(buildReviewBundle([], { page: "p2", sectionShapes: shapes }).section_shapes, shapes);
  assert.deepStrictEqual(buildReviewBundle([], { page: "p2" }).section_shapes, {});
});

// ── m3a: generic detection of UNKNOWN repeating sections ──
test("detectSectionShapes: an UNKNOWN section is captured, keyed by its base (m3a)", () => {
  const scan = { sections: {
    "publication-": { entries: [{ fields: [
      { fieldName: "title", widgetType: "text", label: "Title*", isRequired: true },
      { fieldName: "journal", widgetType: "text", label: "Journal", isRequired: false },
    ] }] },
  } };
  const shapes = detectSectionShapes(scan);
  assert.ok(shapes.publication, "keyed by the discovered base (no PAGE_SECTIONS entry)");
  assert.strictEqual(shapes.publication.length, 2);
  assert.strictEqual(shapes.publication[0].recName, "title"); // recName = DOM automation-id suffix
});

test("buildReviewBundle carries the backend identifier (container_prefix/heading/known) for a section_stub (m3a)", () => {
  const recs = [{ fieldName: "publication", label: "Publications — section present (unmapped)",
    widgetType: "section_stub", isRequired: false, mappedPath: "publication._stub",
    status: "skipped", flag: "section-stub", after: null, detail: "unmapped section",
    section_field_shape: [{ recName: "title", widget_type: "text", path: "title" }],
    container_prefix: "publication-", section_heading: "Publications", section_known: false }];
  const e = buildReviewBundle(recs, { page: "p2" }).entries[0];
  assert.strictEqual(e.container_prefix, "publication-");
  assert.strictEqual(e.section_heading, "Publications");
  assert.strictEqual(e.section_known, false);
  assert.strictEqual(e.widget_type, "section_stub");
});

// ── Nested sub-sections — HARDCODED per section (cert ▸ Specialties + Attachments) ──────────────
// The generic reveal-by-add SCANNER was removed (Certifications is the only observed Workday nested
// section). section.nested (CERT_NESTED) drives a per-surviving-entry emit inside driveRepeatingSectionCdp.
test("driveRepeatingSectionCdp: section.nested → a Specialties stub + Attachments per SURVIVING entry (hardcoded)", async () => {
  const entry = { fkit: "certification-1--null", fields: [{ fieldName: "url", label: "URL", widgetType: "text", isRequired: false, value: "" }] };
  const state = webState({ prefix: "certification-", entries: [entry] });
  const out = await driveRepeatingSectionCdp(makeFakeRepeatAct(state), {
    name: "certification", headingRegex: "certifications?", containerPrefix: "certification-",
    items: [{ url: "x" }], fieldMap: [{ field: "url", widget: "text", key: "url", path: "url" }],
    deleteOnNoMatch: false, nested: CERT_NESTED
  }, T_BUDGETS);
  const stub = out.results.find((r) => r.fieldName === "certification[0].specialties._stub");
  assert.ok(stub && stub.widgetType === "nested_section_stub", "Specialties sub-section stub per surviving entry");
  assert.strictEqual(stub.flag, "nested-section-stub");
  assert.strictEqual(stub.container_prefix, "certification-<idx>--specialties-", "nested backend identifier");
  assert.deepStrictEqual(stub.nested_parent, { base: "certification", index: 0 });
  assert.strictEqual(stub.nested_child_base, "specialties");
  assert.strictEqual(stub.section_field_shape.length, 3, "hardcoded shape: specialtyParent + start/end dates");
  assert.strictEqual(stub.section_field_shape[0].recName, "specialtyParent");
  assert.strictEqual(stub.section_field_shape[0].widget_type, "typeahead");
  assert.deepStrictEqual(stub.section_field_shape[1].date_order, ["month", "day", "year"], "date segment order from the config");
  const att = out.results.find((r) => r.fieldName === "certification[0].attachments");
  assert.ok(att && att.widgetType === "file_upload" && att.flag === "nested-attachment", "Attachments row (config attachments:true)");
  const be = buildReviewBundle(out.results, { page: "p2" }).entries.find((e) => e.canonical_field === "certification[0].specialties._stub");
  assert.ok(be && be.widget_type === "nested_section_stub" && be.needs_review, "nested stub reaches the bundle");
});

test("driveRepeatingSectionCdp: NO section.nested → no nested emit (WE/Education/Websites/Languages)", async () => {
  const entry = { fkit: "education-1--null", fields: [{ fieldName: "url", label: "URL", widgetType: "text", isRequired: false, value: "" }] };
  const state = webState({ prefix: "education-", entries: [entry] });
  const out = await driveRepeatingSectionCdp(makeFakeRepeatAct(state), {
    name: "education", headingRegex: "education", containerPrefix: "education-",
    items: [{ url: "x" }], fieldMap: [{ field: "url", widget: "text", key: "url", path: "url" }], deleteOnNoMatch: false
  }, T_BUDGETS);
  assert.ok(!out.results.some((r) => r.widgetType === "nested_section_stub" || r.flag === "nested-attachment"), "no nested emit without a config");
});

test("PAGE_SECTIONS: exactly one section (Certifications) carries a nested config", () => {
  assert.strictEqual(PAGE_SECTIONS.find((s) => s.name === "certification").nested, CERT_NESTED);
  assert.strictEqual(PAGE_SECTIONS.filter((s) => s.nested).length, 1);
});

test("audit: 'already-filled' surfaced records are NOT audited (the fluent-checkbox uncheck bug)", () => {
  // The M40 audit is the LAST thing on the page. An "already-filled" record (unknown-section existing
  // entry, surfaced read-only) must be SKIPPED — auditing a checkbox whose expected is "Yes" vs a
  // boolean re-read mismatches → the inline re-fill toggles it OFF. A truly bot-filled field IS audited.
  const results = [
    { fieldName: "language[0].fluent", widgetType: "checkbox", status: "filled_review", flag: "already-filled", after: "Yes", auditLoc: "SEL" },
    { fieldName: "country", widgetType: "dropdown", status: "filled_review", flag: "autocommit-containment", after: "United States", auditLoc: "SEL2" },
  ];
  const entries = auditEntriesFromResults(results);
  assert.ok(!entries.some((e) => e.key === "language[0].fluent"), "already-filled is NOT audited (bot never touched it)");
  assert.ok(entries.some((e) => e.key === "country"), "a genuinely bot-filled field IS still audited");
});

test("generic UNKNOWN section: existing entries surface as 'already-filled' (values + recon'd dropdown options)", async () => {
  // A repeating section not in PAGE_SECTIONS (here "language-") with an existing entry. The bot has no
  // mapping, so it never fills it — but the entry must SHOW in review with its current value, flagged
  // "already on the form, not ApplyPilot-filled", and its dropdown options recon'd so the summary can edit it.
  const langField = { wrapperSel: "L0", fieldName: "language", widgetType: "dropdown", label: "Language*", isRequired: false,
    options: [{ text: "Select One", disabled: true }, { text: "English" }, { text: "Spanish" }], triggerText: "English" };
  const rscan = { url: "fake://p2", addButtons: [], sections: {
    "language-": { entryCount: 1, heading: "Languages", entries: [{ fields: [
      { fieldName: "language", widgetType: "dropdown", label: "Language*", isRequired: true, value: "English", wrapperSel: "L0" }
    ] }] }
  } };
  const out = await drivePageFill(makeFakeAct([langField], { rscan }), {}, {}, {}, T_BUDGETS);
  const rec = out.results.find((r) => r.fieldName === "language[0].language");
  assert.ok(rec, "existing entry field surfaced");
  assert.strictEqual(rec.flag, "already-filled");
  assert.strictEqual(rec.status, "filled_review", "surfaced for review (not silently trusted, not bot-filled)");
  assert.strictEqual(rec.after, "English", "current value read from the form");
  assert.match(rec.detail, /not filled by ApplyPilot/i);
  assert.ok(Array.isArray(rec.options) && rec.options.includes("English") && rec.options.includes("Spanish"), "dropdown options recon'd → editable in the summary");
  const be = buildReviewBundle(out.results, { page: "p2" }).entries.find((e) => e.canonical_field === "language[0].language");
  assert.ok(be && be.needs_review && be.current_value === "English", "in the bundle: needs_review + current_value = the existing value");
  const stub = out.results.find((r) => r.widgetType === "section_stub" && r.fieldName === "language");
  assert.ok(stub && stub.section_heading === "Languages", "section stub under the REAL DOM heading");
  assert.ok(stub.section_field_shape.some((s) => Array.isArray(s.options) && s.options.includes("English")), "stub shape carries recon'd options for add-entry");
});

test("drivePageFill surfaces an UNKNOWN repeating section as a stub with the backend identifier (m3a)", async () => {
  const rscan = { url: "fake://p2", addButtons: [], sections: {
    "publication-": { entryCount: 1, heading: "Publications", entries: [{ fields: [
      { fieldName: "title", widgetType: "text", label: "Title*", isRequired: true },
      { fieldName: "year", widgetType: "text", label: "Year", isRequired: false },
    ] }] },
  } };
  const out = await drivePageFill(makeFakeAct([], { rscan }), {}, {}, {}, T_BUDGETS);
  const stub = out.results.find((r) => r.fieldName === "publication");
  assert.ok(stub, "an unknown section is surfaced");
  assert.strictEqual(stub.widgetType, "section_stub");
  assert.strictEqual(stub.flag, "section-stub");
  assert.strictEqual(stub.container_prefix, "publication-"); // backend identifier for a future fill-back
  assert.strictEqual(stub.section_known, false);
  assert.strictEqual(stub.section_heading, "Publications");  // the REAL DOM heading (identifier + display)
  assert.strictEqual(stub.label, "Publications");            // shows under its real name, NOT "unmapped section"
  assert.strictEqual(stub.section_field_shape.length, 2);    // detected field shape (it has entries)
  // and the detected shape is cached on the returned bundle shapes (add-entry uses it)
  assert.ok(out.sectionShapes.publication && out.sectionShapes.publication.length === 2);
});

test("revealUnknownSection: mounts an entry, reads the shape, deletes it (m3b reveal-by-add)", async () => {
  let mounted = false;
  const fake = {
    log: [],
    delay: async () => {},
    repeatingScan: async () => ({ addButtons: [], sections: mounted ? {
      "publication-": { entryCount: 1, heading: "Publications", entries: [{ fields: [
        { fieldName: "title", widgetType: "text", label: "Title*", isRequired: true },
        { fieldName: "year", widgetType: "text", label: "Year", isRequired: false },
      ] }] }
    } : {} }),
    clickSectionAdd: async (re) => { fake.log.push(["add", re]); mounted = true; return { ok: true }; },
    clickDeleteEntry: async (p, i) => { fake.log.push(["del", p, i]); mounted = false; return { ok: true }; },
  };
  const r = await revealUnknownSection(fake, "Publications", T_BUDGETS);
  assert.ok(r);
  assert.strictEqual(r.base, "publication");
  assert.strictEqual(r.prefix, "publication-");
  assert.strictEqual(r.shape.length, 2);
  assert.strictEqual(r.shape[0].recName, "title"); // DOM automation-id suffix
  assert.ok(fake.log.some((l) => l[0] === "add"), "clicked the section's Add button");
  assert.ok(fake.log.some((l) => l[0] === "del"), "deleted the mounted entry (cleanup)");
  assert.strictEqual(mounted, false, "form left as found (0 entries)");
});

test("revealUnknownSection: null if the entry never mounts (Add refused)", async () => {
  const fake = { delay: async () => {}, repeatingScan: async () => ({ sections: {}, addButtons: [] }), clickSectionAdd: async () => ({ ok: false }), clickDeleteEntry: async () => ({ ok: true }) };
  assert.strictEqual(await revealUnknownSection(fake, "Publications", T_BUDGETS), null);
});

test("revealUnknownSection: Add GREW an existing section (has entries) → null + deletes the accidental entry (no leftover)", async () => {
  // The live Languages bug: m3b tried to reveal "Languages", but it ALREADY has entries. clickSectionAdd
  // grows the existing "language-" section (NO new prefix) → must return null AND delete the entry it
  // just added (else a leftover empty entry, + the stray mount perturbs entry 1).
  let count = 1;
  const mk = () => ({ fields: [{ fieldName: "language", widgetType: "dropdown", label: "Language*", isRequired: true }] });
  const fake = {
    log: [], delay: async () => {},
    repeatingScan: async () => ({ addButtons: [], sections: {
      "language-": { entryCount: count, heading: "Languages", entries: Array.from({ length: count }, mk) }
    } }),
    clickSectionAdd: async (re) => { fake.log.push(["add", re]); count += 1; return { ok: true }; },
    clickDeleteEntry: async (p, i) => { fake.log.push(["del", p, i]); if (p === "language-") count = Math.max(0, count - 1); return { ok: true }; },
  };
  const r = await revealUnknownSection(fake, "Languages", T_BUDGETS);
  assert.strictEqual(r, null, "not an empty unknown section → no reveal");
  assert.strictEqual(count, 1, "the accidentally-added entry was deleted — no leftover");
  assert.ok(fake.log.some((l) => l[0] === "del" && l[1] === "language-"), "deleted from the grown section (trailing)");
});

test("revealUnknownSection: TREE typeahead → tagged hierarchical (no option list); date → date_order (m3c)", async () => {
  let mounted = false;
  const fake = {
    delay: async () => {}, delayFull: async () => {},
    repeatingScan: async () => ({ addButtons: [], sections: mounted ? {
      "certification-": { entryCount: 1, heading: "Certifications", entries: [{ fields: [
        { fieldName: "certification", widgetType: "typeahead", label: "Certification*", isRequired: true, wrapperSel: "SEL_CERT" },
        { fieldName: "certificationNumber", widgetType: "text", label: "Number", isRequired: false, wrapperSel: "SEL_NUM" },
        { fieldName: "issuedDate", widgetType: "date", label: "Issued", isRequired: false, wrapperSel: "SEL_DATE", dateSegments: ["dateSectionMonth-input", "dateSectionDay-input", "dateSectionYear-input"] },
      ] }] }
    } : {} }),
    clickSectionAdd: async () => { mounted = true; return { ok: true }; },
    clickDeleteEntry: async () => { mounted = false; return { ok: true }; },
    openHier: async () => true,
    readHier: async () => ({ searchBox: { visible: true, focused: true } }),
    readTreeCategories: async () => ["Accounting", "IT", "Healthcare"], // categories exist → it's a TREE
    pressTab: async () => {},
  };
  const r = await revealUnknownSection(fake, "Certifications", T_BUDGETS);
  assert.ok(r);
  const cert = r.shape.find((s) => s.recName === "certification");
  assert.strictEqual(cert.widget_type, "hierarchical");                     // retagged (tree) → the summary shows a TIER editor
  assert.ok(!cert.options, "no option list stored for a tree (categories aren't useful — tiers instead)");
  const date = r.shape.find((s) => s.recName === "issuedDate");
  assert.deepStrictEqual(date.date_order, ["month", "day", "year"]);        // form's segment order → segmented date editor
  const num = r.shape.find((s) => s.recName === "certificationNumber");
  assert.strictEqual(num.widget_type, "text"); assert.ok(!num.options);     // a text field: no recon
});

test("accumulateBundle PRESERVES this page's operator-added entries across a re-fill (2b)", () => {
  const added = { page: "p2", field_id: "p2::formField-website[4].url", canonical_field: "website[4].url", is_added: true, current_value: "https://added.example", fill_status: "not_filled", needs_review: true };
  const otherPage = { page: "p1", field_id: "p1::formField-personal_info.first_name", canonical_field: "personal_info.first_name", fill_status: "filled" };
  const prior = [otherPage, added,
    { page: "p2", field_id: "p2::formField-website[0].url", canonical_field: "website[0].url", fill_status: "filled" }]; // a normal p2 entry (NOT added)
  const freshP2 = { page: "p2", schema_version: "1.1", entries: [
    { page: "p2", field_id: "p2::formField-website[0].url", canonical_field: "website[0].url", fill_status: "filled" }] };
  const merged = accumulateBundle(prior, freshP2);
  assert.ok(merged.entries.some((e) => e.is_added && e.canonical_field === "website[4].url"), "added entry preserved");
  assert.ok(merged.entries.some((e) => e.page === "p1"), "other page kept verbatim");
  assert.strictEqual(merged.entries.filter((e) => e.canonical_field === "website[0].url").length, 1, "non-added p2 entry replaced, not duplicated");
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

test("repeating delete-on-no-match: EMPTYING the section keeps the CATEGORY as a stub (recon + note), not vanished", async () => {
  // Operator bug: when deleteOnNoMatch deletes the LAST entry the whole section disappeared from
  // review (the "removed" recs are widgetType "section" → filtered from the bundle). Now the
  // section stays VISIBLE as a section_stub with a "removed — no match" note, so the operator can
  // still ADD an entry (the field-shape rides the stub) or verify.
  const mk = (fkit) => ({ fkit, fields: [{ fieldName: "x", label: "X*", widgetType: "dropdown", isRequired: true, triggerText: null, options: [{ text: "Alpha" }, { text: "Beta" }] }] });
  const state = webState({ prefix: "certification-", entries: [mk("certification-1--null")] });
  const fieldMap = [{ field: "x", widget: "dropdown", key: "x", path: "x" }];
  const act = makeFakeRepeatAct(state);
  const out = await driveRepeatingSectionCdp(act, {
    name: "certification", headingRegex: "certifications?", containerPrefix: "certification-",
    items: [{ x: "Zzz-nomatch" }], fieldMap, deleteOnNoMatch: true
  }, T_BUDGETS);
  assert.strictEqual(await act.entryCount("certification-"), 0, "the only entry was deleted");
  const stub = out.results.find((r) => r.widgetType === "section_stub");
  assert.ok(stub, "the emptied deleteOnNoMatch section still surfaces as a section_stub");
  assert.strictEqual(stub.fieldName, "certification");
  assert.strictEqual(stub.flag, "section-stub");
  assert.strictEqual(stub.container_prefix, "certification-"); // backend identifier for the future add-fill
  assert.ok(Array.isArray(stub.section_field_shape) && stub.section_field_shape.length, "carries the field shape so add-entry works");
  assert.match(stub.detail, /removed/i);
  assert.match(stub.detail, /no option matched/i);
  // ...and it must SURVIVE into the bundle (the "appear in review" requirement): the section_stub
  // passes buildReviewBundle's filter while the "removed" recs (widgetType "section") are dropped.
  const entries = buildReviewBundle(out.results, {}).entries;
  assert.ok(entries.some((e) => e.widget_type === "section_stub" && /certification/.test(e.field_id || "")),
    "the section_stub reaches the bundle → shows on the review page");
  assert.ok(!entries.some((e) => /\.removed$/.test(e.field_id || "")), "the raw 'removed' ops do NOT show");
});

test("deleteOnNoMatch stub keeps the recon'd date_order (captured before deletion) → segmented date editor, not a text box", async () => {
  // The date regression: an emptied section's stub built its shape from the fieldMap (no date_order)
  // → the summary rendered a plain text box. Now the shape is captured from the LIVE entries BEFORE
  // the delete sweep, so date fields keep their segment order.
  const mk = (fkit) => ({ fkit, fields: [
    { fieldName: "x", label: "X*", widgetType: "dropdown", isRequired: true, triggerText: null, options: [{ text: "Alpha" }] },
    { fieldName: "d", label: "Issued Date", widgetType: "date", isRequired: false, segments: { Year: { value: "" } } },
  ] });
  const state = webState({ prefix: "certification-", entries: [mk("certification-1--null")] });
  const fieldMap = [
    { field: "x", widget: "dropdown", key: "x", path: "x" },
    { field: "d", widget: "date", key: "dParsed", path: "issued_date" },
  ];
  const act = makeFakeRepeatAct(state);
  const out = await driveRepeatingSectionCdp(act, {
    name: "certification", headingRegex: "certifications?", containerPrefix: "certification-",
    items: [{ x: "Zzz-nomatch", dParsed: "2024" }], fieldMap, deleteOnNoMatch: true
  }, T_BUDGETS);
  const stub = out.results.find((r) => r.widgetType === "section_stub");
  assert.ok(stub, "emptied section still stubbed");
  const dShape = stub.section_field_shape.find((s) => s.recName === "d");
  assert.ok(dShape, "the date field is in the stub shape");
  assert.deepStrictEqual(dShape.date_order, ["year"], "date_order captured from the live entry (fake date field = year-only) → segmented editor");
});

test("deleteOnNoMatch cert emptied → the stub carries the HARDCODED nested_shapes (add-back shows Specialties)", async () => {
  // A bogus cert → deleteOnNoMatch removes the whole section. Because the nested shape is HARDCODED
  // (section.nested), it survives the deletion + rides the removed-section stub so the operator can
  // add a cert back and see its Specialties (+ attachments).
  const mk = (fkit) => ({ fkit, fields: [{ fieldName: "certification", label: "Certification*", widgetType: "dropdown", isRequired: true, triggerText: null, options: [{ text: "PMP" }] }] });
  const state = webState({ prefix: "certification-", entries: [mk("certification-287--null")] });
  const fieldMap = [{ field: "certification", widget: "dropdown", key: "cert", path: "certification" }];
  const act = makeFakeRepeatAct(state);
  const out = await driveRepeatingSectionCdp(act, {
    name: "certification", headingRegex: "certifications?", containerPrefix: "certification-",
    items: [{ cert: "Zzz-bogus" }], fieldMap, deleteOnNoMatch: true, nested: CERT_NESTED
  }, T_BUDGETS);
  assert.strictEqual(await act.entryCount("certification-"), 0, "bogus cert deleted → section empty");
  const stub = out.results.find((r) => r.widgetType === "section_stub");
  assert.ok(stub && stub.nested_shapes && Array.isArray(stub.nested_shapes.specialties), "the emptied cert's stub carries the hardcoded Specialties shape");
  assert.strictEqual(stub.nested_shapes.specialties[0].recName, "specialtyParent");
  assert.deepStrictEqual(stub.nested_shapes.specialties[1].date_order, ["month", "day", "year"], "nested date field kept its segment order");
  assert.strictEqual(stub.nested_attachments, true, "the stub knows the section has attachments (add-back offers a picker)");
  assert.ok(!out.results.some((r) => r.widgetType === "nested_section_stub"), "a deleted cert → NO per-entry nested stub");
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
  // endDate: omitted ("absent" → box removed), present-optional (default), or present-REQUIRED
  // (endDateRequired → the "stuck To box" case: required + M/D/Y segments for the today fallback).
  if (o.endDate !== "absent") fields.push({ fieldName: "endDate", label: o.endDateRequired ? "To*" : "To", widgetType: "date",
    isRequired: !!o.endDateRequired,
    segments: o.endDateRequired ? { Month: { value: "" }, Day: { value: "" }, Year: { value: "" } } : { Month: { value: "" }, Year: { value: "" } } });
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

test("WE: currently_work_here=true but the To box STAYS present + required → fills TODAY's date (filled_review, we-currentwork-today)", async () => {
  // The box did NOT get removed AND is required → a blank required field would block Save &
  // Continue, so fall back to today's date (flagged to verify), never a blind skip.
  const { out } = await runWE([weEntry("workExperience-0--null", { cwhChecked: true, endDateRequired: true })], [weItem({ currently_work_here: true })]);
  const ed = weRec(out, 0, "endDate");
  assert.strictEqual(ed.status, "filled_review");
  assert.strictEqual(ed.flag, "we-currentwork-today");
  const t = new Date();
  assert.strictEqual(ed.after, `${t.getMonth() + 1}/${t.getDate()}/${t.getFullYear()}`); // today, M/D/Y, all segments
  assert.match(ed.detail, /did not disappear/);
});

test("WE: currently_work_here=true and the To box is present but OPTIONAL → skipped (no today fallback)", async () => {
  const { out } = await runWE([weEntry("workExperience-0--null", { cwhChecked: true })], [weItem({ currently_work_here: true })]);
  const ed = weRec(out, 0, "endDate");
  assert.strictEqual(ed.status, "skipped");
  assert.strictEqual(ed.flag, null);
});

test("WE: currently_work_here=true and the To box is ABSENT (removed) → skipped, zero actuation (the normal case)", async () => {
  const { out } = await runWE([weEntry("workExperience-0--null", { cwhChecked: true, endDate: "absent" })], [weItem({ currently_work_here: true })]);
  const ed = weRec(out, 0, "endDate");
  assert.strictEqual(ed.status, "skipped");
  assert.match(ed.detail, /currently_work_here/);
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
  assert.strictEqual(b.schema_version, "1.1");
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

// ── Plan 2: page_number/page_label threading + is_approved default + approval survival ──
test("Plan 2 buildReviewBundle: page_number/page_label threaded onto every entry + the envelope; schema 1.1", () => {
  const rec = [{ fieldName: "degree", widgetType: "dropdown", status: "filled", after: "Bachelors", label: "Degree" }];
  const b = buildReviewBundle(rec, { page: "P2", pageNumber: 2, pageLabel: "Page 2" });
  assert.strictEqual(b.schema_version, "1.1");
  assert.strictEqual(b.page_number, 2);
  assert.strictEqual(b.page_label, "Page 2");
  assert.strictEqual(b.entries[0].page_number, 2);
  assert.strictEqual(b.entries[0].page_label, "Page 2");
});

test("Plan 2 buildReviewBundle: page_number/page_label DEFAULT to null when not threaded (single-page)", () => {
  const b = buildReviewBundle([{ fieldName: "x", widgetType: "text", status: "filled", after: "y", label: "X" }], { page: "P1" });
  assert.strictEqual(b.entries[0].page_number, null);
  assert.strictEqual(b.entries[0].page_label, null);
  assert.strictEqual(b.page_number, null);
});

test("Plan 2 buildReviewBundle: every entry defaults is_approved=false / approved_at=null", () => {
  const b = buildReviewBundle([{ fieldName: "src", widgetType: "dropdown", status: "needs_review", label: "Source", detail: "no match" }], { page: "P1" });
  assert.strictEqual(b.entries[0].is_approved, false);
  assert.strictEqual(b.entries[0].approved_at, null);
});

test("Plan 2 accumulateBundle: a prior page's is_approved SURVIVES the next page's persist", () => {
  let acc = accumulateBundle([], buildReviewBundle([{ fieldName: "src", widgetType: "dropdown", status: "needs_review", label: "Source", detail: "no match" }], { page: "P1", pageNumber: 1 }));
  const flagged = acc.entries.find((e) => e.page === "P1");
  flagged.is_approved = true; flagged.approved_at = "2026-06-29T00:00:00Z"; // viewer approves it
  acc = accumulateBundle(acc.entries, buildReviewBundle([{ fieldName: "lang", widgetType: "dropdown", status: "filled", after: "English", label: "Language" }], { page: "P2", pageNumber: 2 }));
  const survived = acc.entries.find((e) => e.page === "P1");
  assert.strictEqual(survived.is_approved, true);          // approval not clobbered by the next page
  assert.strictEqual(survived.approved_at, "2026-06-29T00:00:00Z");
  assert.strictEqual(survived.page_number, 1);             // ordinal preserved verbatim
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
    readHier: async (loc) => { const f = g(loc); return f.missing ? null : { chips: f.chips || [] }; },
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
    openHier: (loc) => { calls.push(["openHier", loc.wrapperSel]); return Promise.resolve(true); },
    readHier: (loc) => { calls.push(["readHier", loc.wrapperSel]); return Promise.resolve(taState); },
    focusHierSearch: (loc) => { calls.push(["focusHierSearch", loc.wrapperSel]); return Promise.resolve(true); },
    pressEscape: () => { calls.push(["pressEscape"]); return Promise.resolve(); },
    pressTab: () => { calls.push(["pressTab"]); return Promise.resolve(); }
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

test("FoS capture is READ-ONLY: never commits — only open/read/focus/scrape, exits via Tab (named invariant)", async () => {
  const { act, calls } = makeCaptureAct();
  await captureFieldOptions(act, CAP_LOC, CAP_BUDGETS);
  const allowed = new Set(["delay", "delayFull", "openHier", "readHier", "focusHierSearch", "pressTab", "scrapeTaOptions"]);
  assert.deepStrictEqual(calls.filter((c) => !allowed.has(c[0])), [], "capture made a non-read-only call");
  assert.ok(calls.some((c) => c[0] === "pressTab"), "closes via Tab (the clean non-committing exit)");
  for (const bad of ["typeInHier", "pressEnter", "clearHierSearch", "typeText", "clickHierLeaf", "clickDropdownOptionByText", "pressEscape"])
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

// ── AI typeahead fallback (the parked "AI picks from the captured list on a no-match") ───────────
// A genuine-no-match flat typeahead → the LLM picks from the captured option list → commit through the
// proven filler, ALWAYS filled_review. Tree pickers (cert/source) EXCLUDED. Headline: Field of Study.

// A typeahead field for the COMMIT re-entry (fillTypeaheadCdp([target])): typing `target` filters to
// exactly it → the commit-Enter takes it as the chip. `filterMap` keys the AI target(s) we expect.
const aiTaField = (filterMap) => ({ wrapperSel: "[w-fos]", fieldName: "fieldOfStudy", widgetType: "typeahead", chips: [], filterMap });
// A no-match rec as drivePageFill would hand the AI pass (entry-scoped auditLoc; options = captured list).
const aiTaRec = (opts) => Object.assign({
  fieldName: "education[0].fieldOfStudy", widgetType: "typeahead", status: "needs_review",
  genuineNoMatch: true, isRequired: true, label: "Field of Study", auditLoc: "[w-fos]"
}, opts);

test("parseAiTypeaheadReply: JSON / fenced / embedded / non-JSON — represented DEFAULTS false", () => {
  assert.deepStrictEqual(parseAiTypeaheadReply('{"choice":"Economics","represented":true,"confidence":"High"}'), { choice: "Economics", represented: true, confidence: "high" });
  assert.deepStrictEqual(parseAiTypeaheadReply('```json\n{"choice":"Arts","represented":false}\n```'), { choice: "Arts", represented: false, confidence: "low" });
  const emb = parseAiTypeaheadReply('sure: {"choice":"Biology","represented":"true"} done');
  assert.strictEqual(emb.choice, "Biology"); assert.strictEqual(emb.represented, true, "string \"true\" → true");
  assert.deepStrictEqual(parseAiTypeaheadReply("just prose"), { choice: "just prose", represented: false, confidence: "low" });
  assert.strictEqual(parseAiTypeaheadReply('{"choice":"X"}').represented, false, "missing represented → false (conservative)");
  assert.strictEqual(parseAiTypeaheadReply('{"answer":"Y","represented":true}').choice, "Y", "answer is the choice fallback");
});

test("isOtherOption: matches 'Other' case/space-insensitively, never a real option", () => {
  assert.strictEqual(isOtherOption("Other"), true);
  assert.strictEqual(isOtherOption(" other "), true);
  assert.strictEqual(isOtherOption("Accounting"), false);
});

test("aiTypeaheadEligible: a genuine-no-match flat typeahead is eligible; dropdown/EEO/cert/filled/transient are NOT", () => {
  const base = { widgetType: "typeahead", status: "needs_review", genuineNoMatch: true, fieldName: "education[0].fieldOfStudy", label: "Field of Study" };
  assert.strictEqual(aiTypeaheadEligible(base), true);
  assert.strictEqual(aiTypeaheadEligible({ ...base, widgetType: "dropdown" }), false, "dropdown → no");
  assert.strictEqual(aiTypeaheadEligible({ ...base, status: "filled" }), false, "already filled → no");
  assert.strictEqual(aiTypeaheadEligible({ ...base, genuineNoMatch: false }), false, "transient (not genuine) → no");
  assert.strictEqual(aiTypeaheadEligible({ ...base, label: "Gender" }), true, "EEO is NOW eligible (exclusion retracted) — it gets the demographic badge in the pass, not blocked here");
  assert.strictEqual(aiTypeaheadEligible({ ...base, fieldName: "certification[0].certification", label: "Certification" }), false, "cert section (Magna tree) → no (name-belt)");
  // a PRE-FILLED field whose every candidate missed (the overwrite path kept the original, e.g. "Other")
  // is ALSO a rescuable no-match — even without genuineNoMatch (the overwrite path doesn't set it).
  assert.strictEqual(aiTypeaheadEligible({ ...base, genuineNoMatch: false, flag: "overwrite-nomatch-original-kept", after: "Other" }), true, "pre-filled-kept no-match (the 'future-AI candidate') → eligible");
});

test("AI-TA pre-filled overwrite: a kept 'Other' (overwrite-nomatch-original-kept) → AI upgrades it to a represented pick", async () => {
  const field = { wrapperSel: "[w-fos]", fieldName: "fieldOfStudy", widgetType: "typeahead", chips: ["Other"], filterMap: { "Computer Science": { filtered: ["Computer Science"] } } };
  const act = makeFakeAct([field], { aiEnabled: true, ai: '{"choice":"Computer Science","represented":true,"confidence":"High"}' });
  const rec = aiTaRec({ options: ["Accounting", "Computer Science", "Other"], after: "Other", flag: "overwrite-nomatch-original-kept" });
  const out = await aiTypeaheadFallback(act, rec, {}, {}, T_BUDGETS);
  assert.strictEqual(out.status, "filled_review");
  assert.strictEqual(out.flag, "ai-choice");
  assert.strictEqual(out.after, "Computer Science", "the kept 'Other' was overwritten with the represented option");
});

test("AI-TA leaf 1: only 'Other' in the list → commit 'Other' DETERMINISTICALLY, NO LLM call", async () => {
  const act = makeFakeAct([aiTaField({ "Other": { filtered: ["Other"] } })], { aiEnabled: true, ai: '{"choice":"X","represented":true}' });
  const out = await aiTypeaheadFallback(act, aiTaRec({ options: ["Other"] }), {}, {}, T_BUDGETS);
  assert.strictEqual(out.status, "filled_review");
  assert.strictEqual(out.after, "Other");
  assert.strictEqual(out.flag, "ai-other-only");
  assert.ok(!act.log.some(([m]) => m === "llm"), "NO LLM call — nothing to choose among (the only deterministic-Other shortcut)");
});

test("AI-TA leaf 2: represented=true → commit the pick (ai-choice, filled_review, AI confidence carried)", async () => {
  const act = makeFakeAct([aiTaField({ "Accounting": { filtered: ["Accounting"] } })], { aiEnabled: true, ai: '{"choice":"Accounting","represented":true,"confidence":"High"}' });
  const out = await aiTypeaheadFallback(act, aiTaRec({ options: ["Accounting", "Biology", "Other"] }), {}, {}, T_BUDGETS);
  assert.strictEqual(out.status, "filled_review");
  assert.strictEqual(out.after, "Accounting");
  assert.strictEqual(out.flag, "ai-choice");
  assert.strictEqual(out.confidence, "high");
  assert.ok(act.log.some(([m]) => m === "llm"), "the LLM was consulted");
});

test("AI-TA leaf 3: represented=false + 'Other' present → commit 'Other' (ai-choice-other, the honest answer)", async () => {
  const act = makeFakeAct([aiTaField({ "Other": { filtered: ["Other"] } })], { aiEnabled: true, ai: '{"choice":"Finance","represented":false,"confidence":"Medium"}' });
  const out = await aiTypeaheadFallback(act, aiTaRec({ options: ["Accounting", "Finance", "Other"] }), {}, {}, T_BUDGETS);
  assert.strictEqual(out.flag, "ai-choice-other");
  assert.strictEqual(out.after, "Other");
  assert.strictEqual(out.status, "filled_review");
});

test("AI-TA leaf 4: represented=false + NO 'Other' + REQUIRED → closest pick, ai-closest-forced (super-hard)", async () => {
  const act = makeFakeAct([aiTaField({ "Finance": { filtered: ["Finance"] } })], { aiEnabled: true, ai: '{"choice":"Finance","represented":false,"confidence":"Low"}' });
  const out = await aiTypeaheadFallback(act, aiTaRec({ options: ["Accounting", "Finance"], isRequired: true }), {}, {}, T_BUDGETS);
  assert.strictEqual(out.flag, "ai-closest-forced");
  assert.strictEqual(out.after, "Finance");
  assert.strictEqual(out.status, "filled_review");
});

test("AI-TA leaf 4b: required + NO 'Other' + UNRESOLVABLE choice → FORCES the nearest real option (never declines/blocks the walk)", async () => {
  // The AI returns text that clears NO option (resolved===null); a REQUIRED field must still commit
  // SOMETHING (a blank required field halts the walk). It snaps to the nearest real option, super-hard.
  const act = makeFakeAct([aiTaField({ "Accounting": { filtered: ["Accounting"] }, "Finance": { filtered: ["Finance"] } })], { aiEnabled: true, ai: '{"choice":"Underwater Basketweaving","represented":false,"confidence":"Low"}' });
  const out = await aiTypeaheadFallback(act, aiTaRec({ options: ["Accounting", "Finance"], isRequired: true }), {}, {}, T_BUDGETS);
  assert.strictEqual(out.status, "filled_review", "a REQUIRED field never declines — it forces a pick so the walk advances");
  assert.strictEqual(out.flag, "ai-closest-forced");
  assert.ok(["Accounting", "Finance"].includes(out.after), "snapped to a real option (nearest-neighbor)");
});

test("AI-TA leaf 5: represented=false + NO 'Other' + OPTIONAL → needs_review, NOTHING committed", async () => {
  const act = makeFakeAct([aiTaField({})], { aiEnabled: true, ai: '{"choice":"Finance","represented":false}' });
  const out = await aiTypeaheadFallback(act, aiTaRec({ options: ["Accounting", "Finance"], isRequired: false }), {}, {}, T_BUDGETS);
  assert.strictEqual(out.status, "needs_review");
  assert.strictEqual(out.flag, "ai-typeahead-decline");
  assert.strictEqual(out.after, null);
  assert.ok(!act.log.some(([m]) => m === "openHier" || m === "clickHierLeaf"), "no commit was attempted");
});

test("AI-TA leaf 6: the AI pick can't commit (banner) → ai-commit-failed (needs_review, honest, never a false fill)", async () => {
  const act = makeFakeAct([aiTaField({ "Accounting": { banner: true } })], { aiEnabled: true, ai: '{"choice":"Accounting","represented":true}' });
  const out = await aiTypeaheadFallback(act, aiTaRec({ options: ["Accounting", "Other"] }), {}, {}, T_BUDGETS);
  assert.strictEqual(out.status, "needs_review");
  assert.strictEqual(out.flag, "ai-commit-failed");
});

test("AI-TA anti-hallucination: AI choice isn't a real option → can't commit as represented → falls through to 'Other'", async () => {
  const act = makeFakeAct([aiTaField({ "Other": { filtered: ["Other"] } })], { aiEnabled: true, ai: '{"choice":"Underwater Basketweaving","represented":true}' });
  const out = await aiTypeaheadFallback(act, aiTaRec({ options: ["Accounting", "Other"] }), {}, {}, T_BUDGETS);
  assert.strictEqual(out.flag, "ai-choice-other", "a non-option choice can't be a represented commit → Other");
  assert.strictEqual(out.after, "Other");
});

// ── orchestration through drivePageFill (a MAPPED flat typeahead: countryPhoneCode) ──
// A bogus profile value → genuine no-match (results, candidate absent) → captured_options set → the
// AI pass rescues. countryPhoneCode is in FIELD_MAP (personal_info.country_phone_code).
const cpcField = (extra) => Object.assign({
  wrapperSel: "[w-cpc]", fieldName: "countryPhoneCode", widgetType: "typeahead", isRequired: true, label: "Country Phone Code", chips: [],
  filterMap: {
    "Narnia (+99)": { filtered: ["United States (+1)", "Canada (+1)"] }, // bogus → genuine no-match (results), captured_options populated
    "United States (+1)": { filtered: ["United States (+1)"] }            // the AI target commits
  }
}, extra || {});
const cpcProfile = { personal_info: { country_phone_code: "Narnia (+99)" } };

test("AI-TA orchestration: AI ON rescues a flat no-match typeahead INLINE on the open field → filled_review/ai-choice, NO Tab", async () => {
  const act = makeFakeAct([cpcField()], { aiEnabled: true, ai: '{"choice":"United States (+1)","represented":true,"confidence":"High"}' });
  const rec = (await drivePageFill(act, cpcProfile, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(rec.status, "filled_review");
  assert.strictEqual(rec.flag, "ai-choice");
  assert.strictEqual(rec.after, "United States (+1)");
  assert.ok(!act.log.some(([m]) => m === "pressTab"), "Option B: the AI committed on the OPEN field — no Tab-exit then re-open");
});

test("AI-TA orchestration: AI OFF is a byte-identical no-op (stays needs_review, NO LLM)", async () => {
  const act = makeFakeAct([cpcField()], { aiEnabled: false, ai: '{"choice":"United States (+1)","represented":true}' });
  const rec = (await drivePageFill(act, cpcProfile, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.genuineNoMatch, true);
  assert.ok(!act.log.some(([m]) => m === "llm"), "AI OFF → no provider call, no spend");
});

test("AI-TA: tryInlineAi reads the STALE view, never clears-to-detect — no wasted unfocused clear (the doubled Ctrl+A/Delete fix)", async () => {
  // The deterministic filter-Enter drops searchBox focus (dropsFocusOnFilterEnter). Pre-fix, tryInlineAi's
  // tree-detection clearSearch fired on the now-unfocused box (the wasted first Ctrl+A/Delete + a wait); now it
  // only READS readTreeCategories (returns [] = flat → flat AI path). The single, FOCUSED clear is the commit
  // re-entry's (its main loop ensureSearchFocused()es first).
  const act = makeFakeAct([cpcField({ dropsFocusOnFilterEnter: true })], { aiEnabled: true, ai: '{"choice":"United States (+1)","represented":true,"confidence":"High"}' });
  const rec = (await drivePageFill(act, cpcProfile, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(rec.status, "filled_review");
  assert.strictEqual(rec.flag, "ai-choice");
  assert.strictEqual(rec.after, "United States (+1)");
  assert.ok(act.log.some(([m]) => m === "llm"), "AI was consulted (flat path)");
  assert.ok(act.log.some(([m]) => m === "readTreeCategories"), "tryInlineAi READ the stale view to route");
  assert.strictEqual(act.probe.clearedWhileUnfocused, false, "no focus-blind clear — the commit re-entry refocuses before its clear");
});

test("inline AI (repeating): a FoS no-match in Education is rescued INLINE on the open field — no Tab, filled_review/ai-choice", async () => {
  // "Zzz" filters to a list WITHOUT it → genuine no-match (results) with captured options → the inline AI
  // (driven by section.aiContext) commits the AI's pick on the still-open field, NO Tab-exit.
  const eduEntry = (fkit) => ({ fkit, fields: [{ fieldName: "fieldOfStudy", widgetType: "typeahead", isRequired: true, chips: [], filterMap: { "Zzz": { filtered: ["Economics", "Biology"] }, "Economics": { filtered: ["Economics"] } } }] });
  const fieldMap = [{ field: "fieldOfStudy", widget: "typeahead", key: "fos", path: "fos" }];
  const items = [{ fos: ["Zzz"] }];
  const state = { prefix: "education-", addable: true, deletable: true, aiEnabled: true, ai: '{"choice":"Economics","represented":true,"confidence":"High"}', newEntry: (i) => eduEntry("education-new" + i), entries: [eduEntry("education-0--null")] };
  const act = makeFakeRepeatAct(state);
  const out = await driveRepeatingSectionCdp(act, { name: "education", headingRegex: "education", containerPrefix: "education-", items, fieldMap, deleteOnNoMatch: false, aiContext: { profile: {}, jobContext: {} } }, T_BUDGETS);
  const fos = out.results.find((r) => r.fieldName === "education[0].fieldOfStudy");
  assert.strictEqual(fos.status, "filled_review");
  assert.strictEqual(fos.flag, "ai-choice");
  assert.strictEqual(fos.after, "Economics");
  assert.ok(act.log.some(([m]) => m === "llm"), "the LLM was consulted INLINE (not at end-of-page)");
  assert.ok(!act.log.some(([m]) => m === "pressTab"), "Option B: committed on the OPEN field — no Tab-exit");
});

// Cert tree shape shared by the cert tree-AI integration tests (one category with leaves + "Other",
// one single-leaf category with NO "Other" → the forced-required branch).
const CERT_TREE_FIELD = {
  "Multiple Recognized Providers": ["Certified Payroll Professional (CPP) - Multiple Recognized Providers", "Other - Multiple Recognized Providers"],
  "Workday": ["Workday Pro - Workday"]
};

test("inline AI (repeating): a CERTIFICATION tree no-match DRILLS → CLICK-drill + TYPE-commit the leaf (ai-choice) → entry KEPT", async () => {
  // Cert is a TREE: a bogus name no-matches (banner); tryInlineAi reads the category rows on the still-open
  // field → routes to the UNIFIED aiTreeDrillFallback (Prompt 1 category → CLICK-drill → Prompt 2 leaf → TYPE
  // commit, the same path as source). A confident ai-choice in a deleteOnNoMatch section is KEPT (Step 2.5).
  const tree = { categories: ["Multiple Recognized Providers", "Workday"], leaves: CERT_TREE_FIELD };
  const certEntry = (fkit) => ({ fkit, fields: [{ fieldName: "certification", widgetType: "typeahead", isRequired: true, chips: [], filterMap: { "Bogus Cert XYZ": { banner: true } }, tree }] });
  const fieldMap = [{ field: "certification", widget: "typeahead", key: "cert", path: "cert" }];
  const items = [{ cert: ["Bogus Cert XYZ"] }];
  const state = { prefix: "certification-", addable: true, deletable: true, aiEnabled: true,
    ai: ['{"choice":"Multiple Recognized Providers","confidence":"High"}', '{"choice":"Certified Payroll Professional (CPP)","confidence":"High"}'],
    newEntry: (i) => certEntry("certification-new" + i), entries: [certEntry("certification-0--null")] };
  const act = makeFakeRepeatAct(state);
  const out = await driveRepeatingSectionCdp(act, { name: "certification", headingRegex: "certifications?", containerPrefix: "certification-", items, fieldMap, deleteOnNoMatch: true, aiContext: { profile: {}, jobContext: {} } }, T_BUDGETS);
  const cert = out.results.find((r) => r.fieldName === "certification[0].certification");
  assert.strictEqual(cert.status, "filled_review");
  assert.strictEqual(cert.flag, "ai-choice");
  assert.strictEqual(cert.after, "Certified Payroll Professional (CPP) - Multiple Recognized Providers", "committed the FULL suffixed leaf");
  assert.ok(act.log.some(([m]) => m === "expandCategory"), "CLICK-drilled the category");
  assert.ok(act.log.some(([m]) => m === "typeInSourceSearch"), "committed the leaf by TYPING (the unified drill, same as source)");
  assert.ok(!act.log.some(([m]) => m === "clickTreeLeaf"), "the retired clickTreeLeaf commit is NOT used");
  assert.strictEqual(state.entries.length, 1, "confident ai-choice → entry KEPT");
});

test("inline AI (repeating): a CERTIFICATION tree no-match, AI low-confidence forced leaf → entry DELETED", async () => {
  // Chosen category "Workday" has a single leaf + NO "Other"; the AI's leaf doesn't match → nearest (never blank)
  // → ai-choice with LOW confidence → a deleteOnNoMatch section DELETES the unconfident entry (Step 2.5).
  const tree = { categories: ["Workday"], leaves: { "Workday": ["Workday Pro - Workday"] } };
  const certEntry = (fkit) => ({ fkit, fields: [{ fieldName: "certification", widgetType: "typeahead", isRequired: true, chips: [], filterMap: { "Bogus Cert XYZ": { banner: true } }, tree }] });
  const fieldMap = [{ field: "certification", widget: "typeahead", key: "cert", path: "cert" }];
  const items = [{ cert: ["Bogus Cert XYZ"] }];
  const state = { prefix: "certification-", addable: true, deletable: true, aiEnabled: true,
    ai: ['{"choice":"Workday"}', '{"choice":"Nope Not Here","confidence":"Low"}'],
    newEntry: (i) => certEntry("certification-new" + i), entries: [certEntry("certification-0--null")] };
  const act = makeFakeRepeatAct(state);
  await driveRepeatingSectionCdp(act, { name: "certification", headingRegex: "certifications?", containerPrefix: "certification-", items, fieldMap, deleteOnNoMatch: true, aiContext: { profile: {}, jobContext: {} } }, T_BUDGETS);
  assert.ok(act.log.some(([m]) => m === "expandCategory") && act.log.some(([m]) => m === "clickSourceLeaf"), "the tree AI drilled + committed a forced nearest pick");
  assert.strictEqual(state.entries.length, 0, "ai-choice LOW confidence → entry DELETED");
});

test("inline AI (repeating): a cert typeahead with NO tree categories + no captured options → flat path, no LLM, genuine no-match → deleted", async () => {
  // The honest negative (was misleadingly titled "excluded by section name" — there is NO such exclusion). A
  // banner no-match with NO `tree` and no captured options: readTreeCategories→[] → flat fallback has nothing
  // to evaluate → returns null → NO LLM. deleteOnNoMatch → the entry is deleted on the genuine no-match.
  const certEntry = (fkit) => ({ fkit, fields: [{ fieldName: "certification", widgetType: "typeahead", isRequired: true, chips: [], filterMap: { "Zzz": { banner: true } } }] });
  const fieldMap = [{ field: "certification", widget: "typeahead", key: "cert", path: "cert" }];
  const items = [{ cert: ["Zzz"] }];
  const state = { prefix: "certification-", addable: true, deletable: true, aiEnabled: true, ai: '{"choice":"Anything","represented":true}', newEntry: (i) => certEntry("certification-new" + i), entries: [certEntry("certification-0--null")] };
  const act = makeFakeRepeatAct(state);
  await driveRepeatingSectionCdp(act, { name: "certification", headingRegex: "certifications?", containerPrefix: "certification-", items, fieldMap, deleteOnNoMatch: true, aiContext: { profile: {}, jobContext: {} } }, T_BUDGETS);
  assert.ok(!act.log.some(([m]) => m === "llm"), "no tree categories + no captured options → flat fallback has nothing to evaluate → no LLM");
  assert.strictEqual(state.entries.length, 0, "genuine no-match (no rescue) + deleteOnNoMatch → entry deleted");
});

test("Step 2.5 delete-unconfident: a deleteOnNoMatch section KEEPS a confident AI pick, DELETES an unconfident one (+ AI-OFF still deletes on genuine no-match)", async () => {
  // "Zzz" filters to a list WITHOUT it → genuine no-match WITH captured leaves → the (flat) inline AI runs.
  const fm = { "Zzz": { filtered: ["Economics", "Biology"] }, "Economics": { filtered: ["Economics"] } };
  const taEntry = (fkit) => ({ fkit, fields: [{ fieldName: "fieldOfStudy", widgetType: "typeahead", isRequired: true, chips: [], filterMap: fm }] });
  const fieldMap = [{ field: "fieldOfStudy", widget: "typeahead", key: "fos", path: "fos" }];
  const items = [{ fos: ["Zzz"] }];
  const mkState = (ai, aiEnabled) => ({ prefix: "education-", addable: true, deletable: true, aiEnabled, ai, newEntry: (i) => taEntry("education-new" + i), entries: [taEntry("education-0--null")] });
  const section = { name: "education", headingRegex: "education", containerPrefix: "education-", items, fieldMap, deleteOnNoMatch: true, aiContext: { profile: {}, jobContext: {} } };
  // CONFIDENT (ai-choice, High) → KEPT.
  const keep = mkState('{"choice":"Economics","represented":true,"confidence":"High"}', true);
  await driveRepeatingSectionCdp(makeFakeRepeatAct(keep), section, T_BUDGETS);
  assert.strictEqual(keep.entries.length, 1, "confident ai-choice → entry KEPT");
  // UNCONFIDENT (represented:false, no Other, required → ai-closest-forced) → DELETED (treat optional).
  const force = mkState('{"choice":"Economics","represented":false,"confidence":"Low"}', true);
  await driveRepeatingSectionCdp(makeFakeRepeatAct(force), section, T_BUDGETS);
  assert.strictEqual(force.entries.length, 0, "unconfident (ai-closest-forced) → entry DELETED");
  // AI OFF → no AI runs → genuine no-match + deleteOnNoMatch → deleted (unchanged).
  const off = mkState('{"choice":"Economics","represented":true}', false);
  await driveRepeatingSectionCdp(makeFakeRepeatAct(off), section, T_BUDGETS);
  assert.strictEqual(off.entries.length, 0, "AI OFF → genuine no-match deletes");
});

test("EEO retraction (typeahead): an EEO typeahead no-match is AI-filled and re-tagged ai-eeo-guess", async () => {
  const field = { wrapperSel: "[w-eth]", fieldName: "ethnicity", widgetType: "typeahead", chips: [], filterMap: { "Asian": { filtered: ["Asian"] } } };
  const act = makeFakeAct([field], { aiEnabled: true, ai: '{"choice":"Asian","represented":true,"confidence":"High"}' });
  const rec = { fieldName: "ethnicity", widgetType: "typeahead", status: "needs_review", genuineNoMatch: true, isRequired: true, label: "Ethnicity", auditLoc: "[w-eth]", options: ["Asian", "White", "Other"] };
  await runAiTypeaheadPass(act, [rec], {}, {}, T_BUDGETS);
  assert.strictEqual(rec.status, "filled_review");
  assert.strictEqual(rec.flag, "ai-eeo-guess", "EEO typeahead → demographic verify badge (not the plain ai-choice)");
  assert.strictEqual(rec.after, "Asian");
});

test("runAiTypeaheadPass (the shared helper): no-op when AI OFF; rescues a no-match typeahead when ON", async () => {
  const mkRec = () => aiTaRec({ options: ["Accounting", "Other"] });
  // OFF → untouched, no LLM (the per-section harness with AI off is byte-identical to today).
  const off = makeFakeAct([aiTaField({ "Accounting": { filtered: ["Accounting"] } })], { aiEnabled: false, ai: '{"choice":"Accounting","represented":true}' });
  const recOff = mkRec();
  await runAiTypeaheadPass(off, [recOff], {}, {}, T_BUDGETS);
  assert.strictEqual(recOff.status, "needs_review", "AI OFF → the helper is a no-op");
  assert.ok(!off.log.some(([m]) => m === "llm"));
  // ON → rescued through the shared pass (same as drivePageFill).
  const on = makeFakeAct([aiTaField({ "Accounting": { filtered: ["Accounting"] } })], { aiEnabled: true, ai: '{"choice":"Accounting","represented":true,"confidence":"High"}' });
  const recOn = mkRec();
  await runAiTypeaheadPass(on, [recOn], {}, {}, T_BUDGETS);
  assert.strictEqual(recOn.status, "filled_review");
  assert.strictEqual(recOn.flag, "ai-choice");
  assert.strictEqual(recOn.after, "Accounting");
});

// ── AI fallback for TREE pickers (cert) — two-prompt drill (Step 2 of the tree-AI milestone) ───────────
// A fake act with the tree-drill substrate (readTreeCategories / expandCategory / readTreeLeaves /
// clickTreeLeaf / readSource). `ai` is a SEQUENCE of LLM replies [categoryReply, leafReply].
// Models the UNIFIED tree drill (aiTreeDrillFallback, the source-style type-commit): scrapeSourceRows returns
// the categories on-open and the drilled category's leaves after expandCategory; the leaf is committed by TYPING
// (focusSourceSearch → clearSourceSearch → typeInSourceSearch → pressEnter → clickSourceLeaf fallback). `ai` is a
// SEQUENCE of LLM replies [categoryReply, leafReply].
function makeFakeTreeAct(tree, opts) {
  const o = opts || {};
  const replies = Array.isArray(o.ai) ? o.ai : [o.ai];
  let replyIdx = 0, expanded = null, committed = null, value = "";
  const log = [];
  const leavesOf = () => (expanded ? (tree.leaves[expanded] || []).slice() : []);
  const act = {
    log,
    aiEnabled: o.aiEnabled !== false,
    delay: async () => {},
    delayFull: async () => {},
    llm: async (req) => {
      log.push(["llm", req && req.user]);
      const a = replies[Math.min(replyIdx++, replies.length - 1)];
      if (a == null) return { ok: false, error: "no reply" };
      return typeof a === "string" ? { ok: true, text: a } : a;
    },
    readTreeCategories: async () => (expanded ? [] : tree.categories.slice()),
    // scroll-accumulate: on-open → categories (banner "No matches found"); after a drill → that category's leaves
    // (banner = the category name, the drill-confirmation).
    scrapeSourceRows: async (loc) => {
      log.push(["scrapeSourceRows", loc && loc.wrapperSel]);
      return expanded
        ? { ok: true, options: leavesOf(), banner: expanded, atBottom: true }
        : { ok: true, options: tree.categories.slice(), banner: "No matches found", atBottom: true };
    },
    expandCategory: async (loc, label) => {
      if (!tree.categories.includes(label)) return false;
      expanded = label; log.push(["expand", label]); return true;
    },
    sourceRowRect: async () => ({ found: true, rect: { cx: 1, cy: 1, w: 10, h: 10 } }),
    clickAt: async () => {},
    focusSourceSearch: async () => { log.push(["focusSourceSearch"]); return true; },
    clearSourceSearch: async () => { value = ""; },
    typeInSourceSearch: async (t) => { log.push(["typeInSourceSearch", t]); value = t; },
    pressEnter: async () => { log.push(["pressEnter"]); }, // filter-Enter only; the leaf commits via clickSourceLeaf
    clickSourceLeaf: async (label) => {
      log.push(["clickSourceLeaf", label]);
      if (!expanded || !leavesOf().includes(label)) return false;
      committed = label; return true;
    },
    readSource: async () => ({ searchBox: { present: true, visible: true, focused: true, value }, chips: committed ? [committed] : [] }),
  };
  return act;
}

const CERT_TREE = {
  categories: ["Multiple Recognized Providers", "Previous Place of Employment", "Workday"],
  leaves: {
    "Multiple Recognized Providers": [
      "Certified Payroll Professional (CPP) - Multiple Recognized Providers",
      "Certified Information Systems Auditor (CISA) - Multiple Recognized Providers",
      "Other - Multiple Recognized Providers",
    ],
    "Workday": ["Workday Pro - Workday"], // NO "Other" → the forced-required branch
  },
};

test("parseAiTreeReply: {choice,confidence}; category alias; fenced / embedded / non-JSON", () => {
  assert.deepStrictEqual(parseAiTreeReply('{"choice":"Workday","confidence":"High"}'), { choice: "Workday", confidence: "high" });
  assert.strictEqual(parseAiTreeReply('```json\n{"category":"Multiple Recognized Providers"}\n```').choice, "Multiple Recognized Providers");
  assert.strictEqual(parseAiTreeReply('blah {"choice":"X","confidence":"Low"} trailing').choice, "X");
  assert.deepStrictEqual(parseAiTreeReply("just a category"), { choice: "just a category", confidence: "low" });
});

test("aiTreeDrillFallback: category + leaf → CLICK-drills + TYPE-commits the matched leaf (ai-choice, FULL chip)", async () => {
  const act = makeFakeTreeAct(CERT_TREE, { ai: [
    '{"choice":"Multiple Recognized Providers","confidence":"High"}',
    '{"choice":"Certified Payroll Professional (CPP)","confidence":"High"}',
  ] });
  const out = await aiTreeDrillFallback(act, { wrapperSel: "[w]" }, { profile: { certifications: [{ name: "CPP" }] }, jobContext: {}, isRequired: true, label: "Certification", fieldName: "certification[0].certification" }, T_BUDGETS);
  assert.strictEqual(out.status, "filled_review");
  assert.strictEqual(out.flag, "ai-choice");
  assert.strictEqual(out.after, "Certified Payroll Professional (CPP) - Multiple Recognized Providers", "containment-matched the AI's clean pick → committed the FULL suffixed leaf");
  assert.strictEqual(out.tree_structure.chosen, "Multiple Recognized Providers");
  assert.ok(act.log.some(([m]) => m === "expand"), "CLICK-drilled the category (not typed)");
  assert.ok(act.log.some(([m]) => m === "typeInSourceSearch"), "committed the leaf by TYPING (the unified type-commit, not clickTreeLeaf)");
});

test("aiTreeDrillFallback: AI picks 'Other' → commits the suffixed Other leaf (ai-choice)", async () => {
  const act = makeFakeTreeAct(CERT_TREE, { ai: [
    '{"choice":"Multiple Recognized Providers"}',
    '{"choice":"Other","confidence":"Medium"}',
  ] });
  const out = await aiTreeDrillFallback(act, { wrapperSel: "[w]" }, { profile: {}, jobContext: {}, isRequired: true, label: "Certification" }, T_BUDGETS);
  assert.strictEqual(out.flag, "ai-choice");
  assert.strictEqual(out.after, "Other - Multiple Recognized Providers");
});

test("aiTreeDrillFallback: an unresolvable leaf snaps to the NEAREST real leaf; the AI's low confidence flows through", async () => {
  // No separate ai-closest-forced flag (source semantics) — a forced/uncertain pick is ai-choice with the AI's
  // confidence, and a deleteOnNoMatch section deletes it when that confidence is low (the driver's Step 2.5).
  const act = makeFakeTreeAct(CERT_TREE, { ai: [
    '{"choice":"Workday"}',
    '{"choice":"Nope Not Here","confidence":"Low"}',
  ] });
  const out = await aiTreeDrillFallback(act, { wrapperSel: "[w]" }, { profile: {}, jobContext: {}, isRequired: true, label: "Certification" }, T_BUDGETS);
  assert.strictEqual(out.flag, "ai-choice");
  assert.strictEqual(out.confidence, "low");
  assert.strictEqual(out.after, "Workday Pro - Workday", "the only leaf → nearest, never blank");
});

test("aiTreeDrillFallback: a hallucinated/typo CATEGORY snaps to the nearest, then drills (proceeds, never stalls)", async () => {
  const act = makeFakeTreeAct(CERT_TREE, { ai: [
    '{"choice":"Multiple Recgnized Providrs"}', // typo → nearestOption → real category
    '{"choice":"Certified Payroll Professional (CPP)","confidence":"High"}',
  ] });
  const out = await aiTreeDrillFallback(act, { wrapperSel: "[w]" }, { profile: {}, jobContext: {}, isRequired: true, label: "Certification" }, T_BUDGETS);
  assert.strictEqual(out.tree_structure.chosen, "Multiple Recognized Providers", "typo category snapped to the nearest real one");
  assert.strictEqual(out.flag, "ai-choice");
  assert.strictEqual(out.after, "Certified Payroll Professional (CPP) - Multiple Recognized Providers");
});

test("aiTreeDrillFallback: NO categories visible → returns null (nothing to drill → caller falls to needs_review)", async () => {
  const act = makeFakeTreeAct({ categories: [], leaves: {} }, { ai: ["x"] });
  const out = await aiTreeDrillFallback(act, { wrapperSel: "[w]" }, { profile: {}, jobContext: {} }, T_BUDGETS);
  assert.strictEqual(out, null);
});

test("aiTreeDrillFallback: the AI's CLEAN leaf containment-matches + commits the FULL suffixed label", async () => {
  const act = makeFakeTreeAct(CERT_TREE, { ai: [
    '{"choice":"Multiple Recognized Providers"}',
    '{"choice":"Certified Information Systems Auditor (CISA)","confidence":"Medium"}',
  ] });
  const out = await aiTreeDrillFallback(act, { wrapperSel: "[w]" }, { profile: {}, jobContext: {}, isRequired: true, label: "Certification" }, T_BUDGETS);
  assert.strictEqual(out.after, "Certified Information Systems Auditor (CISA) - Multiple Recognized Providers");
  const clicked = act.log.find(([m]) => m === "clickSourceLeaf");
  assert.strictEqual(clicked[1], "Certified Information Systems Auditor (CISA) - Multiple Recognized Providers", "committed the FULL label");
});

// ── M1: cascade re-scan-after-change (revealed fields) ───────────────────────
// drivePageFill re-scans after the fold and fills any NEW flat field through the
// SAME deterministic→AI ladder (via the onlyFieldNames re-invoke), tagging it
// cascadeRevealed. The fake's scanPage reads the `fields` array live, so pushing
// to it between calls simulates a reveal (the ~5.6s-later mount, already absorbed).

test("M1 cascade: a stable page (no reveal) adds ZERO cascade records — byte-identical fill", async () => {
  const fields = [
    { wrapperSel: "[w-fn]", fieldName: "legalName--firstName", widgetType: "text", value: "" },
    { wrapperSel: "[w-ln]", fieldName: "legalName--lastName", widgetType: "text", value: "" }
  ];
  const out = await drivePageFill(makeFakeAct(fields), { personal_info: { first_name: "Ada", last_name: "Lovelace" } }, {}, {}, T_BUDGETS);
  assert.ok(!out.results.some((r) => r.cascadeRevealed), "no cascadeRevealed records on a stable page");
  assert.strictEqual(out.results.length, 2, "exactly the up-front fields — no spurious additions");
});

test("M1 cascade: a field REVEALED after a value commits is filled + tagged cascadeRevealed, never silent", async () => {
  const fields = [{ wrapperSel: "[w-fn]", fieldName: "legalName--firstName", widgetType: "text", value: "" }];
  const cityField = { wrapperSel: "[w-city]", fieldName: "city", widgetType: "text", value: "", isRequired: true };
  const act = makeFakeAct(fields);
  const baseScan = act.scanPage;
  let revealed = false;
  act.scanPage = async () => {
    // reveal `city` ONCE the first field has a value (the cascade is already mounted by post-fold time)
    if (fields[0].value && !revealed) { fields.push(cityField); revealed = true; }
    return baseScan();
  };
  const out = await drivePageFill(act, { personal_info: { first_name: "Ada", city: "London" } }, {}, {}, { ...T_BUDGETS, maxCascadeRounds: 3 });
  const rec = out.results.find((r) => r.fieldName === "city");
  assert.ok(rec, "the revealed field is recorded");
  assert.strictEqual(rec.cascadeRevealed, true, "tagged cascadeRevealed (forces a re-review on submit)");
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "London");
  assert.strictEqual(out.results.filter((r) => r.fieldName === "city").length, 1, "filled exactly once (only-NEW-keys, no re-trigger)");
});

test("M1 cascade: a page that reveals a NEW field on every scan TERMINATES (round cap) and never re-fills a field", async () => {
  const fields = [{ wrapperSel: "[w0]", fieldName: "legalName--firstName", widgetType: "text", value: "" }];
  const act = makeFakeAct(fields);
  const baseScan = act.scanPage;
  let k = 0;
  act.scanPage = async () => {
    k++;
    if (k >= 2) { const id = "rev" + k; if (!fields.some((f) => f.fieldName === id)) fields.push({ wrapperSel: "[w-" + id + "]", fieldName: id, widgetType: "text", value: "" }); }
    return baseScan();
  };
  // completes at all ⇒ the loop terminated (a non-terminating loop would hang the test)
  const out = await drivePageFill(act, { personal_info: { first_name: "Ada" } }, {}, {}, { ...T_BUDGETS, maxCascadeRounds: 2 });
  assert.ok(out.results.some((r) => r.cascadeRevealed), "at least one reveal handled");
  const names = out.results.map((r) => r.fieldName);
  assert.strictEqual(new Set(names).size, names.length, "no field is filled twice — only-NEW-keys guarantees termination");
});

test("M1 cascade: SKIPPED under opts.onlyFieldNames (AI-4 targeted re-fill never cascades)", async () => {
  const fields = [{ wrapperSel: "[w0]", fieldName: "legalName--firstName", widgetType: "text", value: "" }];
  const act = makeFakeAct(fields);
  const baseScan = act.scanPage;
  act.scanPage = async () => {
    if (fields[0].value && !fields.some((f) => f.fieldName === "city")) fields.push({ wrapperSel: "[w-city]", fieldName: "city", widgetType: "text", value: "" });
    return baseScan();
  };
  const out = await drivePageFill(act, { personal_info: { first_name: "Ada", city: "London" } }, {}, {}, T_BUDGETS, { onlyFieldNames: new Set(["legalName--firstName"]) });
  assert.ok(!out.results.some((r) => r.cascadeRevealed), "cascade block is gated off under onlyFieldNames");
  assert.ok(!out.results.some((r) => r.fieldName === "city"), "the revealed field is NOT filled during a targeted re-fill");
});

// ── M2: replayField — the strict-replay SUBMIT atom (flat fields) ────────────
// Replays one human-approved bundle entry onto a fresh live form; selector comes from the
// PERSISTED field_id (flat) — exact, not a guess. Repeating/file_upload/deleted are deferred/skipped;
// a live no-match → needs_review (STOP, never guess); cleared → blank.

test("deriveFlatWrapperSel: field_id (page-qualified OR bare) → the exact automation-id selector", () => {
  assert.strictEqual(deriveFlatWrapperSel({ field_id: "P1::formField-country" }), '[data-automation-id="formField-country"]');
  assert.strictEqual(deriveFlatWrapperSel({ field_id: "formField-country" }), '[data-automation-id="formField-country"]');
});

test("isRepeatingEntry: canonical_field with [idx] is repeating; a flat path is not", () => {
  assert.strictEqual(isRepeatingEntry({ canonical_field: "workExperience[0].job_title" }), true);
  assert.strictEqual(isRepeatingEntry({ canonical_field: "personal_info.first_name" }), false);
  assert.strictEqual(isRepeatingEntry({ canonical_field: null }), false);
});

test("replayField: a flat TEXT entry replays current_value at the recorded selector", async () => {
  const f = { wrapperSel: '[data-automation-id="formField-legalName--firstName"]', fieldName: "legalName--firstName", widgetType: "text", value: "" };
  const act = makeFakeAct([f]);
  const r = await replayField(act, { field_id: "P1::formField-legalName--firstName", canonical_field: "personal_info.first_name", widget_type: "text", current_value: "Kevin", edit_kind: null }, T_BUDGETS);
  assert.strictEqual(r.status, "filled");
  assert.strictEqual(r.after, "Kevin");
  assert.strictEqual(f.value, "Kevin", "filled the box the recorded field_id points at");
});

test("replayField: a flat DROPDOWN entry replays the approved value as a single candidate", async () => {
  const f = { wrapperSel: '[data-automation-id="formField-country"]', fieldName: "country", widgetType: "dropdown", triggerText: "Select One", options: [{ text: "Select One", disabled: true }, { text: "Canada" }, { text: "United States of America" }] };
  const act = makeFakeAct([f]);
  const r = await replayField(act, { field_id: "P1::formField-country", canonical_field: "personal_info.country", widget_type: "dropdown", current_value: "United States of America", edit_kind: null }, T_BUDGETS);
  assert.strictEqual(r.status, "filled");
  assert.strictEqual(r.after, "United States of America");
});

test("replayField (STRICT): an approved value with NO live match → needs_review, never guesses", async () => {
  const f = { wrapperSel: '[data-automation-id="formField-country"]', fieldName: "country", widgetType: "dropdown", triggerText: "Select One", options: [{ text: "Select One", disabled: true }, { text: "Canada" }, { text: "United States of America" }] };
  const act = makeFakeAct([f]);
  const r = await replayField(act, { field_id: "P1::formField-country", canonical_field: "personal_info.country", widget_type: "dropdown", current_value: "Atlantis", edit_kind: null }, T_BUDGETS);
  assert.strictEqual(r.status, "needs_review", "a value the live form no longer offers HALTS this field");
});

test("replayField: a CLEARED text entry leaves the field blank (verify-blank, no value typed)", async () => {
  const f = { wrapperSel: '[data-automation-id="formField-legalName--firstName"]', fieldName: "legalName--firstName", widgetType: "text", value: "stale" };
  const act = makeFakeAct([f]);
  const r = await replayField(act, { field_id: "P1::formField-legalName--firstName", canonical_field: "personal_info.first_name", widget_type: "text", current_value: null, edit_kind: "cleared" }, T_BUDGETS);
  assert.strictEqual(r.replay, "cleared");
  assert.strictEqual(f.value, "", "the box is emptied, not refilled");
});

test("replayField: a REPEATING-section field is DEFERRED (skipped, zero actuation — M3 replays it positionally)", async () => {
  const act = makeFakeAct([]);
  const r = await replayField(act, { field_id: "P2::formField-jobTitle", canonical_field: "workExperience[0].job_title", widget_type: "text", current_value: "Engineer" }, T_BUDGETS);
  assert.strictEqual(r.status, "skipped");
  assert.strictEqual(r.flag, "replay-repeating-deferred");
  assert.strictEqual(act.log.length, 0, "a deferred repeating field is never actuated by the flat atom");
});

test("replayField: is_deleted and file_upload are skipped (handled elsewhere), zero actuation", async () => {
  const act = makeFakeAct([]);
  const del = await replayField(act, { field_id: "P2::formField-jobTitle", canonical_field: "workExperience[1].job_title", widget_type: "text", current_value: "X", is_deleted: true }, T_BUDGETS);
  assert.strictEqual(del.flag, "replay-deleted");
  const up = await replayField(act, { field_id: "P2::formField-resume", canonical_field: null, widget_type: "file_upload", current_value: null }, T_BUDGETS);
  assert.strictEqual(up.flag, "replay-file-deferred");
  assert.strictEqual(act.log.length, 0, "neither touches the form");
});

test("replayFlatFields: replays ONLY flat + present + re-fillable entries (skips repeating/file_upload/absent)", async () => {
  const fn = { wrapperSel: '[data-automation-id="formField-legalName--firstName"]', fieldName: "legalName--firstName", widgetType: "text", value: "" };
  const cty = { wrapperSel: '[data-automation-id="formField-country"]', fieldName: "country", widgetType: "dropdown", triggerText: "Select One", options: [{ text: "Select One", disabled: true }, { text: "Canada" }] };
  const act = makeFakeAct([fn, cty]);
  const entries = [
    { field_id: "P1::formField-legalName--firstName", canonical_field: "personal_info.first_name", widget_type: "text", current_value: "Kevin" },
    { field_id: "P1::formField-country", canonical_field: "personal_info.country", widget_type: "dropdown", current_value: "Canada" },
    { field_id: "P2::formField-jobTitle", canonical_field: "workExperience[0].job_title", widget_type: "text", current_value: "Eng" }, // repeating → skip
    { field_id: "P2::formField-resume", canonical_field: null, widget_type: "file_upload", current_value: null },                    // file_upload → skip
    { field_id: "P1::formField-ssn", canonical_field: "personal_info.ssn", widget_type: "text", current_value: "x" }                  // not present → skip
  ];
  const present = new Set(["legalName--firstName", "country"]); // the live page scan
  const results = await replayFlatFields(act, entries, present, T_BUDGETS);
  assert.strictEqual(results.length, 2, "only the 2 present flat fields are replayed");
  assert.deepStrictEqual(results.map((r) => r.field).sort(), ["country", "legalName--firstName"]);
  assert.ok(results.every((r) => r.status === "filled"));
});

// ── dropdown tier-keep: CLOSE the opened list (the degree→"Associates" stray fix) ────────────
// The tier-aware keep path OPENS the dropdown to check for a higher tier. If it just Escapes and
// returns, the portaled list (which overlaps the NEXT field) can linger and the next field's
// open-click lands on a stale option (live: Field-of-Study clicked the degree list's "Associates"
// while the record falsely said "Bachelors"). Fix: confirm the dropdown is CLOSED + re-read.

test("dropdown tier-keep: the opened list is CLOSE-CONFIRMED before returning (no lingering list)", async () => {
  const f = ddField({ triggerText: "United States of America", options: [{ text: "Select One", disabled: true }, { text: "United States of America" }, { text: "Uruguay" }] });
  const act = makeFakeAct([f]);
  const out = await drivePageFill(act, { personal_info: { country: ["Canada", "United States of America"] } }, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.flag, "dropdown-prefilled-better-tier-unavailable");
  assert.strictEqual(rec.after, "United States of America");
  assert.strictEqual(f.open, false, "dropdown CLOSED before returning — the next field can't hit a lingering list");
  assert.ok(act.log.some(([m]) => m === "pressEscape"), "closed via Escape");
});

test("dropdown tier-keep: a value that STRAYS during the close → needs_review/dropdown-prefilled-stray (never a false verified-keep)", async () => {
  const f = ddField({ triggerText: "United States of America", strayValueOnEscape: "Uruguay", options: [{ text: "Select One", disabled: true }, { text: "United States of America" }, { text: "Uruguay" }] });
  const act = makeFakeAct([f]);
  const out = await drivePageFill(act, { personal_info: { country: ["Canada", "United States of America"] } }, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.flag, "dropdown-prefilled-stray");
  assert.strictEqual(rec.after, "Uruguay", "surfaces the live truth, not a false 'kept United States, verified'");
});

test("dropdown tier-keep: a slow-closing list is RE-ESCAPED until closed (not a single fire-and-return Escape)", async () => {
  const f = ddField({ triggerText: "United States of America", escapeWontClose: true, options: [{ text: "Select One", disabled: true }, { text: "United States of America" }, { text: "Uruguay" }] });
  const act = makeFakeAct([f]);
  const out = await drivePageFill(act, { personal_info: { country: ["Canada", "United States of America"] } }, {}, {}, T_BUDGETS);
  const escapes = act.log.filter(([m]) => m === "pressEscape").length;
  assert.ok(escapes >= 2, `re-escaped a slow-closing list (saw ${escapes})`);
  assert.strictEqual(out.results[0].after, "United States of America", "value intact (escapeWontClose doesn't change it)");
});
