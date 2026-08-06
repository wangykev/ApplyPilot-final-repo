// Unit tests for fill-driver.js — the substrate-agnostic CDP fill brain — driven
// by a FAKE actuation (the substrate-swap hedge made testable). The fake logs
// every actuation call so tests can assert not just outcomes but that deferred
// widgets are NEVER actuated and unverified commits are NEVER pressed.
const { test } = require("node:test");
const assert = require("node:assert");
const { planAiBatchCandidates, deterministicTierFor, fillTextCdp, setCheckboxGroupCdp, orderResultsByDom, drivePageFill, fillSourceCdp, fillTypeaheadCdp, commitOutcome, driveRepeatingSectionCdp, sectionsFromErrorNames, deleteTargetsFromErrorNames, deleteEmptyErrorRows, overwriteNoMatchResting, WEBSITE_MAP, LANGUAGE_MAP, EDUCATION_MAP, WORK_EXPERIENCE_MAP, fillDateCompositeCdp, buildReviewBundle, accumulateBundle, samePhysicalPage, detectSectionShapes, revealUnknownSection, CERT_NESTED, fillNestedSpecialtiesCdp, sweepAlreadyFilled, reconPageTruth, sectionsInDomOrder, PAGE_SECTIONS, reconcileAudit, auditDateSegments, auditEntriesFromResults, applyAuditVerdicts, replayField, replayValueMatches, textValuesMatch, phoneShaped, replayFlatFields, deriveFlatWrapperSel, isRepeatingEntry, bundleToSectionItems, coerceReplayValue, replayRepeatingSections, selectPageBundleEntries, submitPrecondition, bundleSubmitBlockers, isTransientRenderFailure, reconDropdownDump, closeAndVerifyBlank, closeDropdownConfirmed, overwriteBeatLadder, aiEligible, legallyLoaded, parseAiReply, parseAiText, aiRemediateError, parseRemediation, captureFieldOptions, captureDropdownOptions, captureChoiceOptions, awaitListTerminal, awaitListStable, awaitSourceListStable, awaitSourceListLoaded, parseAiTypeaheadReply, aiTypeaheadEligible, aiTypeaheadFallback, isOtherOption, runAiTypeaheadPass, parseAiTreeReply, aiTreeDrillFallback, makeStartCapture, buildBucketIndex, resolve, boolLadderCandidates, appendFieldVariants } = require("../fill-driver.js");

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
      url: o.scanUrl || "fake://page", // o.scanUrl lets a test model a real tenant URL (the employment anchor's tenant fallback)
      repeatingFieldCount: 0,
      fields: fields.map((f) => ({
        wrapperSel: f.wrapperSel, fieldName: f.fieldName, widgetType: f.widgetType,
        label: f.label || f.fieldName, isRequired: !!f.isRequired,
        value: f.liveValue !== undefined ? f.liveValue : null, // already-filled sweep: the field's CURRENT live value
        groupOptions: f.groupOptions // checkbox_group: option labels read straight from the DOM (no actuation)
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
      // A field can REFUSE what you type: Copart's required "desired compensation" box only accepts a
      // number, so "N/A" never lands and the box stays empty (operator, live 2026-08-03). Modelled
      // generically as an accept-predicate, not as a tenant.
      if (focusedText.textRejectsAll) return;                                   // accepts nothing at all
      if (focusedText.textRejects && !/^[0-9]*$/.test(text)) return;            // DIGITS only — a comma or "N/A" is dropped
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
      return { ok: true, options, count: options.length, atBottom: !f.scrapeNotAtBottom, cappedOut: !!f.scrapeCappedOut };
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
      // commitsOnAttempt: N → the first N-1 text-clicks DISMISS the list without committing (the
      // fast-overwrite MISS the fast-first path models), the Nth commits. Exercises the slow refill.
      f._clickN = (f._clickN || 0) + 1;
      if (f.commitsOnAttempt && f._clickN < f.commitsOnAttempt) { f.open = false; return true; }
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
    // Quiescence gate: `quietDelayMs`/`quietNever` on a field model a page that is still reacting.
    awaitQuiet: async (loc, opts) => {
      const f = byLoc(loc);
      log.push(["awaitQuiet", loc.wrapperSel]);
      if (f.quietNever) return { quiet: false, waitedMs: (opts && opts.ceilingMs) || 3000 };
      return { quiet: true, waitedMs: f.quietDelayMs || 0 };
    },
    // checkbox GROUP (pick-one checkbox set — the OFCCP self-ID). Same shape as readRadioState.
    // `rebuildScript` models Workday REBUILDING the widget under us (live on waystar 2026-08-04): a queue
    // consumed one entry per read — "gone" = wrapper missing (null), "empty" = present with no boxes ([]),
    // "cleared" = comes back with every box UNCHECKED (our value discarded), anything else = read normally.
    readCheckboxGroup: async (loc) => {
      const f = byLoc(loc);
      // `rebuildAlways` takes over once the script is exhausted and then applies to EVERY later read.
      // A fixed-length script cannot express "this never sticks" without hardcoding how many rounds the
      // loop happens to run, so a script running dry silently turned a never-sticks fixture into a
      // recovers-eventually one. Compose them: the script covers the pre-loop reads, this covers the rest.
      const scripted = Array.isArray(f.rebuildScript) && f.rebuildScript.length;
      if (!scripted && f.rebuildAlways) {
        log.push(["readCheckboxGroup", f.rebuildAlways]);
        if (f.rebuildAlways === "gone") return null;
        if (f.rebuildAlways === "empty") return [];
        if (f.rebuildAlways === "cleared") f.options.forEach((o) => { o.checked = false; });
        return f.options ? f.options.map((o) => ({ ...o })) : null;
      }
      if (scripted) {
        const step = f.rebuildScript.shift();
        log.push(["readCheckboxGroup", step]);
        if (step === "gone") return null;
        if (step === "empty") return [];
        if (step === "cleared") { f.options.forEach((o) => { o.checked = false; }); }
      }
      return f.options ? f.options.map((o) => ({ ...o })) : null;
    },
    clickRadioLabel: async (loc, id) => {
      log.push(["clickRadioLabel", id]);
      const f = byLoc(loc);
      if (f.radioClickRectDead) return false;
      if (f.radioClickNoCommit) return true;
      if (f.widgetType === "checkbox_group") {
        // BOTH shapes exist and the fake has to model both (2026-08-03). Default is ordinary checkbox
        // semantics — a toggle, several can be on at once — which is what PSECU's ethnicityMulti does
        // live ("Asian" + "White" both checked, both saved). `pickOne: true` reproduces the
        // Caterpillar tenant quirk: while another option is checked a second check is REFUSED, so the
        // caller must uncheck first. The fake used to hardcode the quirk, which is precisely the
        // assumption that hid the multi case.
        const me = f.options.find((o) => o.id === id);
        if (!me) return true;
        if (me.checked) { me.checked = false; return true; }          // toggle OFF
        if (f.pickOne && f.options.some((o) => o.checked)) return true; // pick-one tenant refuses
        me.checked = true;
        return true;
      }
      f.options.forEach((o) => { o.checked = o.id === id; });
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
    // 2026-07-24 (operator "trust your list"): a clean miss with NO company anchor STILL fills a confident
    // "No" from the complete (non-empty) list — the anchor only corroborates the Yes/overlap paths.
    { name: "clean miss, NO company anchor → still confident No (trust the complete list)", company: null, employers: ["Google"], expect: { after: "No", status: "filled" } },
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

// ── Employment-status-at-the-application-company (DETERMINISTIC, no AI) — 2026-07-24 ──────────────
// A yes/no screening question naming the company you're applying to ("former MAGNA employee?",
// "currently employed with Magna?") fills from the profile's employment history: a clean "No" SILENTLY
// (no LEGALLY-LOADED flag, no review — the whole point), a "Yes"/uncertain review-flagged, NEVER auto-
// "Yes". Recognized by TEXT, anchored on jobContext.company; unrecognized/unevaluable → the AI/blank fallback.
const { recognizeEmploymentQuestion, decideCurrentlyEmployed, decideEmploymentStatus, optionForPolarity } = require("../fill-driver.js");
const empField = (label, options) => ({
  wrapperSel: "[w-emp]", fieldName: "customScreeningQuestion", widgetType: "radio", isRequired: true, label,
  options: options || [{ id: "y", labelText: "Yes", checked: false }, { id: "n", labelText: "No", checked: false }]
});
const pickFR = (d) => ({ fill: d.fill, review: d.review });

test("employment recognizer: fires on the company named adjacent to an employment word (any tenant)", () => {
  assert.deepStrictEqual(recognizeEmploymentQuestion("Are you a former MAGNA employee?", "Magna"), { tense: "former", company: "Magna" });
  assert.deepStrictEqual(recognizeEmploymentQuestion("Are you currently employed with Magna?", "Magna"), { tense: "current", company: "Magna" });
  assert.deepStrictEqual(recognizeEmploymentQuestion("Have you ever worked for Magna?", "Magna"), { tense: "former", company: "Magna" });
  assert.strictEqual(recognizeEmploymentQuestion("Are you employed by Bosch?", "Bosch").tense, "ever"); // generalizes — no per-tenant config
});
test("employment recognizer: no false positives on lookalikes", () => {
  assert.strictEqual(recognizeEmploymentQuestion("Do you agree Magna may contact your former employers?", "Magna"), null, "company not adjacent to an employment claim about YOU");
  assert.strictEqual(recognizeEmploymentQuestion("Are you willing to work weekends at Magna?", "Magna"), null, "bare 'work', no for/at/with-employment phrase");
  assert.strictEqual(recognizeEmploymentQuestion("Why do you want to work at Magna?", "Magna"), null, "aspirational 'want to work', not employment history");
  assert.strictEqual(recognizeEmploymentQuestion("Are you authorized to work in Canada?", "Magna"), null, "company not named");
  assert.strictEqual(recognizeEmploymentQuestion("Are you a former employee?", ""), null, "no application company → can't anchor");
});
test("employment recognizer: anchors on the BRAND token when the JD scrape yields a fuller name than the question", () => {
  // The Magna questions say bare "MAGNA", but the JD scrape can produce the fuller corporate name
  // ("Magna International") — the anchor must still fire on the brand token, not bail to the AI.
  const Q1 = "If you are a former MAGNA employee, please select Yes and enter all the applicable information below. If you are not a former MAGNA employee, please select No.";
  const Q2 = 'Are you currently employed with Magna? (If you are a current Magna employee, please use the "Jobs Hub" in Workday to apply for this role. If you are a current contingent/supplemental/contract worker, please select "No".)';
  for (const co of ["Magna International", "Magna Powertrain", "Magna International Inc.", "Magna Careers"]) {
    assert.strictEqual(recognizeEmploymentQuestion(Q1, co) && recognizeEmploymentQuestion(Q1, co).tense, "former", `Q1 must anchor for scraped company "${co}"`);
    assert.strictEqual(recognizeEmploymentQuestion(Q2, co) && recognizeEmploymentQuestion(Q2, co).tense, "current", `Q2 must anchor for scraped company "${co}"`);
  }
  // A GENERIC head still requires the full sequence — the brand fallback can't false-anchor on "bank".
  assert.strictEqual(recognizeEmploymentQuestion("Are you a former Bank employee?", "Bank of America"), null, "generic head 'bank' alone must not anchor");
  assert.deepStrictEqual(recognizeEmploymentQuestion("Are you a former Bank of America employee?", "Bank of America"), { tense: "former", company: "Bank of America" }, "full sequence still anchors");
});
test("employment question — multi-word scraped company (Magna International) still fills 'No' SILENTLY", async () => {
  const [rec] = await run([empField("If you are a former MAGNA employee, please select Yes. If you are not a former MAGNA employee, please select No.")], { employment_history_companies: ["Google"] }, { company: "Magna International" });
  assert.strictEqual(rec.after, "No");
  assert.strictEqual(rec.status, "filled", "a grounded No fills silently even when the scrape yielded the fuller corporate name");
  assert.ok(!rec.flag, "no LEGALLY-LOADED flag");
});
test("decideCurrentlyEmployed: derived from the 'currently work here' flags (operator decision #2)", () => {
  const p = (we, emp) => ({ work_experience: we, employment_history_companies: emp || ["Google"] });
  assert.deepStrictEqual(pickFR(decideCurrentlyEmployed("Magna", p([{ company: "Google", currently_work_here: true }]))), { fill: "No", review: false }, "current job elsewhere → confident No");
  assert.deepStrictEqual(pickFR(decideCurrentlyEmployed("Magna", p([{ company: "Magna Steyr", currently_work_here: true }], ["Magna Steyr"]))), { fill: "Yes", review: true }, "current Magna entry → Yes + review, never auto-Yes");
  assert.deepStrictEqual(pickFR(decideCurrentlyEmployed("Magna", p([{ company: "Magna", currently_work_here: false }], ["Magna"]))), { fill: "No", review: true }, "in history but not current → No + review");
  assert.deepStrictEqual(pickFR(decideCurrentlyEmployed("Magna", { work_experience: [], employment_history_companies: ["none"] })), { fill: "No", review: false }, '["none"] → never employed → No');
  assert.strictEqual(decideCurrentlyEmployed("Magna", { employment_history_companies: [] }).fill, null, "[] unfilled → blank + review");
});
test("optionForPolarity: maps Yes/No to simple AND verbose option labels", () => {
  assert.strictEqual(optionForPolarity(["Yes", "No"], "No"), "No");
  assert.strictEqual(optionForPolarity(["Yes, I am currently employed with Magna", "No, I'm NOT currently employed with Magna"], "No"), "No, I'm NOT currently employed with Magna");
  assert.strictEqual(optionForPolarity(["Nope", "Yeah"], "No"), null, "no leading-No option → ambiguous → null (never guess)");
});
test("employment question — clean 'No' fills SILENTLY (no flag, no review)", async () => {
  const [rec] = await run([empField("Are you a former MAGNA employee?")], { employment_history_companies: ["Google"] }, { company: "Magna" });
  assert.strictEqual(rec.after, "No");
  assert.strictEqual(rec.status, "filled", "a grounded No fills silently — the whole point");
  assert.ok(!rec.flag, "no LEGALLY-LOADED flag on a clean No");
  assert.strictEqual(buildReviewBundle([rec], {}).entries[0].needs_review, false, "clean No must NOT go to review");
});
test("employment question — verbose options (Q2): 'currently employed' maps to the verbose No label", async () => {
  const opts = [{ id: "y", labelText: "Yes, I am currently employed with Magna", checked: false }, { id: "n", labelText: "No, I'm NOT currently employed with Magna", checked: false }];
  const [rec] = await run([empField("Are you currently employed with Magna?", opts)], { work_experience: [{ company: "Google", currently_work_here: true }], employment_history_companies: ["Google"] }, { company: "Magna" });
  assert.strictEqual(rec.after, "No, I'm NOT currently employed with Magna");
  assert.strictEqual(rec.status, "filled");
  assert.ok(!rec.flag);
});
test("employment question — 'Yes' (company in history) → filled_review + employer-match (never auto-Yes)", async () => {
  const [rec] = await run([empField("Are you a former MAGNA employee?")], { employment_history_companies: ["Magna"] }, { company: "Magna" });
  assert.strictEqual(rec.after, "Yes");
  assert.strictEqual(rec.status, "filled_review");
  assert.strictEqual(rec.flag, "employer-match");
  const e = buildReviewBundle([rec], {}).entries[0];
  assert.strictEqual(e.needs_review, true);
  assert.strictEqual(e.needs_review_reason, "employer_match_uncertain", "renders as an employer match, NOT AI-inferred");
  assert.strictEqual(e.confidence_source, "employer_match");
});
test("employment question — no company anchor AND a non-tenant URL → NOT recognized → not silently filled (falls to blank/AI)", async () => {
  // run() uses the default fake scan url ("fake://page" → no tenant), so with jobContext.company empty
  // there's NO anchor at all → the recognizer can't fire. (Contrast the URL-tenant test just below.)
  const [rec] = await run([empField("Are you a former MAGNA employee?")], { employment_history_companies: ["Google"] }, {});
  assert.notStrictEqual(rec.status, "filled", "no anchor (no company + non-tenant url) → not recognized → never a silent deterministic fill");
});

// ── Option 1 (2026-07-25): the employment anchor falls back to the page URL's tenant subdomain ──
// so the recognizer + employer-match logic anchor RELIABLY off the URL (always present) instead of a
// scraped jobContext.company that may be empty. The decision still comes from the profile employer list.
const { tenantCompanyFromUrl } = require("../lib.js");
test("tenantCompanyFromUrl: extracts the company brand from a Workday tenant URL (subdomain AND path)", () => {
  // JD / careers host → the brand is the SUBDOMAIN
  assert.strictEqual(tenantCompanyFromUrl("https://magna.wd3.myworkdayjobs.com/en-US/x"), "Magna");
  assert.strictEqual(tenantCompanyFromUrl("https://comcast.wd5.myworkdayjobs.com/z"), "Comcast");
  assert.strictEqual(tenantCompanyFromUrl("https://acme-corp.wd1.myworkdayjobs.com/a"), "Acme Corp");
  // LOGGED-IN FORM host → NO subdomain; the brand is in the PATH (/recruiting/<tenant>/…). This is the
  // load-bearing case — the fill actually runs here (the live Magna URL that made the anchor go missing).
  assert.strictEqual(tenantCompanyFromUrl("https://wd3.myworkdaysite.com/en-US/recruiting/magna/Magna/job/Milton/Junior_R00244793/apply"), "Magna");
  assert.strictEqual(tenantCompanyFromUrl("https://wd5.myworkdaysite.com/en-US/recruiting/comcast/Comcast_Careers/job/x"), "Comcast");
  // non-Workday / junk
  assert.strictEqual(tenantCompanyFromUrl("https://careers.google.com/j"), null, "non-Workday → null");
  assert.strictEqual(tenantCompanyFromUrl(""), null);
  assert.strictEqual(tenantCompanyFromUrl(null), null);
});
test("employment anchor via URL tenant: a custom 'former «co» employee?' with EMPTY jobContext.company is recognized + filled 'No' deterministically (no AI)", async () => {
  // jobContext.company is empty ({}), but the page URL is a Magna tenant → the anchor falls back to
  // "Magna" (from the URL), so the recognizer fires and fills a deterministic clean-miss "No" from the
  // employer list — instead of the AI safety-reversal (LEGALLY-LOADED review). The LLM is never called.
  const act = makeFakeAct([empField("Are you a former MAGNA employee?")],
    { scanUrl: "https://wd3.myworkdaysite.com/en-US/recruiting/magna/Magna/job/Milton/Junior_R00244793/apply", aiEnabled: true, ai: '{"choice":"No","confidence":"High"}' });
  const rec = (await drivePageFill(act, { employment_history_companies: ["Google"] }, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(rec.after, "No");
  assert.strictEqual(rec.status, "filled", "recognized via the URL tenant → deterministic No, no review");
  assert.ok(!rec.flag, "no ai / LEGALLY-LOADED flag");
  assert.ok(!act.log.some(([m]) => m === "llm"), "LLM NOT called — the URL tenant anchor made it deterministic");
});

// ── ADVERSARIAL WORDINGS (2026-07-24) — each of these WOULD have produced a silent WRONG deterministic
// answer if recognized; all must bail (→ the AI+review fallback: a flagged guess, never a silent wrong).
test("employment recognizer BAILS: wrong SUBJECT (relatives / referral / spouse / know-anyone)", () => {
  assert.strictEqual(recognizeEmploymentQuestion("Do you have any relatives or family members currently employed with Magna?", "Magna"), null, "asks about RELATIVES — answering from YOUR history is the wrong subject");
  assert.strictEqual(recognizeEmploymentQuestion("Were you referred to this position by a current Magna employee?", "Magna"), null, "asks about the REFERRER's employment, not yours");
  assert.strictEqual(recognizeEmploymentQuestion("Is your spouse currently employed by Magna?", "Magna"), null);
  assert.strictEqual(recognizeEmploymentQuestion("Do you know anyone employed at Magna?", "Magna"), null);
});
test("employment recognizer BAILS: wrong OBJECT / broadened scope (competitor / any employer)", () => {
  assert.strictEqual(recognizeEmploymentQuestion("Are you currently employed by a competitor of Magna?", "Magna"), null, "membership at a COMPETITOR, not at Magna");
  assert.strictEqual(recognizeEmploymentQuestion("Have you ever been terminated by any employer, including Magna?", "Magna"), null, "scope is ANY employer — a clean-miss No could hide a real Yes elsewhere");
  assert.strictEqual(recognizeEmploymentQuestion("Are you currently employed by a supplier or vendor of Magna?", "Magna"), null);
});
test("employment recognizer BAILS: a different FACT than membership (work-auth / termination / reference / policy)", () => {
  assert.strictEqual(recognizeEmploymentQuestion("Are you legally authorized for employment at Magna?", "Magna"), null, "a WORK-AUTHORIZATION question — a clean-miss No would be wrong");
  assert.strictEqual(recognizeEmploymentQuestion("Are you eligible for employment with Magna?", "Magna"), null);
  assert.strictEqual(recognizeEmploymentQuestion("Were you ever terminated from employment with Magna?", "Magna"), null, "asks the MANNER employment ended, not membership");
  assert.strictEqual(recognizeEmploymentQuestion("May we contact Magna, your former employer, for a reference?", "Magna"), null, "reference-contact consent — No would refuse the reference");
  assert.strictEqual(recognizeEmploymentQuestion("Do you agree to comply with the Magna employee handbook?", "Magna"), null);
});
test("employment recognizer BAILS: inverted polarity — but the Magna conditional instruction still fires", () => {
  assert.strictEqual(recognizeEmploymentQuestion("I certify that I am not a current employee of Magna.", "Magna"), null, "inverted assertion — the right answer for a non-employee is YES, our polarity map would say No");
  assert.strictEqual(recognizeEmploymentQuestion("Are you not currently employed by Magna?", "Magna"), null);
  assert.strictEqual(recognizeEmploymentQuestion("Are you no longer employed by Magna?", "Magna"), null);
  // The REAL Magna Q1 contains "If you are not a former MAGNA employee, please select No." — that is a
  // STANDARD-polarity instruction (the same-sentence "select" exempts it) → still recognized.
  const q1 = "If you are a former MAGNA employee, please select Yes and enter all the applicable information below. If you are not a former MAGNA employee, please select No.";
  assert.deepStrictEqual(recognizeEmploymentQuestion(q1, "Magna"), { tense: "former", company: "Magna" }, "the target question must survive every guard");
});
test("employment recognizer BAILS: aspirational / future / availability", () => {
  assert.strictEqual(recognizeEmploymentQuestion("Would you accept employment with Magna?", "Magna"), null, "they're APPLYING — a clean-miss No would be absurd");
  assert.strictEqual(recognizeEmploymentQuestion("Are you interested in future employment with Magna?", "Magna"), null);
  assert.strictEqual(recognizeEmploymentQuestion("Are you able to begin employment with Magna immediately?", "Magna"), null, "start-availability, not membership");
});
test("employment recognizer: sentence scoping kills cross-sentence contamination", () => {
  assert.strictEqual(recognizeEmploymentQuestion("Do you have a criminal record? Magna requires all employees to disclose.", "Magna"), null, "the employment word sits near the company but the ASK is a criminal-record question");
  assert.strictEqual(recognizeEmploymentQuestion("Are you employed full-time? Magna offers flexible schedules.", "Magna"), null, "general employment-status ask; the company is boilerplate in another sentence");
});
test("employment recognizer: 'current or former' → tense 'ever' (a former employee is never mis-answered by a current-only check)", () => {
  assert.deepStrictEqual(recognizeEmploymentQuestion("Are you a current or former Magna employee?", "Magna"), { tense: "ever", company: "Magna" });
});
test("employment recognizer: the REAL Magna Q2 (verbose parenthetical) still fires as 'current'", () => {
  const q2 = 'Are you currently employed with Magna? (If you are a current Magna employee, please use the "Jobs Hub" in Workday to apply for this role. If you are a current contingent/supplemental/contract worker, please select "No".)';
  assert.deepStrictEqual(recognizeEmploymentQuestion(q2, "Magna"), { tense: "current", company: "Magna" });
});

// ── ADVERSARIAL SAFETY SWEEP (2026-07-25) — a deterministic "No"/"Yes" must NEVER be silently WRONG;
// surfacing for review is always the safe outcome. These pin the trickiest company + question wordings.
test("employment recognizer: common-descriptor company brands need the FULL name (never a lone descriptor)", () => {
  // A company whose FIRST token is a common English word ("General Motors", "Federal Signal", "American
  // Express") must be NAMED IN FULL — else a role/status question ("a GENERAL employee or a manager?",
  // "a FEDERAL employee?") would be misread as company membership → a WRONG silent "No".
  assert.strictEqual(recognizeEmploymentQuestion("Are you a general employee or a manager?", "General Motors"), null, "lone 'General' is a role word");
  assert.strictEqual(recognizeEmploymentQuestion("Are you a former General employee?", "General Motors"), null);
  assert.strictEqual(recognizeEmploymentQuestion("Are you a federal employee?", "Federal Signal"), null, "'federal employee' is a status, not this company");
  assert.strictEqual(recognizeEmploymentQuestion("Are you an American worker?", "American Express"), null);
  assert.strictEqual(recognizeEmploymentQuestion("Are you generally employed elsewhere?", "General Motors"), null, "'generally' must not match the brand token 'general'");
  // …but the FULL company name still anchors and fires:
  assert.deepStrictEqual(recognizeEmploymentQuestion("Are you a former General Motors employee?", "General Motors"), { tense: "former", company: "General Motors" });
  assert.deepStrictEqual(recognizeEmploymentQuestion("Are you a former Federal Signal employee?", "Federal Signal"), { tense: "former", company: "Federal Signal" });
  assert.deepStrictEqual(recognizeEmploymentQuestion("Are you a former American Express employee?", "American Express"), { tense: "former", company: "American Express" });
});
test("employment recognizer: 'payroll' counts as an employment word", () => {
  assert.deepStrictEqual(recognizeEmploymentQuestion("Are you currently on Magna's payroll?", "Magna"), { tense: "current", company: "Magna" });
});
test("employment recognizer: contractor/consultant/services broadening → NOT recognized (employment word >3 tokens from the company)", () => {
  // The formal-employer list can't answer a contractor/consultant relationship, so these must surface for
  // review, never a silent "No". Sentence scoping handles it: "employee" ends up far from "«co»".
  assert.strictEqual(recognizeEmploymentQuestion("Are you a former employee, contractor, or consultant of Magna?", "Magna"), null);
  assert.strictEqual(recognizeEmploymentQuestion("Have you ever provided contract or consulting services to Magna?", "Magna"), null, "'services' is not an employment word");
});
test("employment recognizer BAILS: more different-fact wordings (rehire eligibility / dismissal)", () => {
  assert.strictEqual(recognizeEmploymentQuestion("Are you eligible to be rehired by Magna?", "Magna"), null, "rehire ELIGIBILITY, not membership");
  assert.strictEqual(recognizeEmploymentQuestion("Were you dismissed for cause from Magna?", "Magna"), null);
});
test("employment recognizer: bare 'work' (not worked/working for/at/with) is not membership", () => {
  assert.strictEqual(recognizeEmploymentQuestion("Do you currently work for a company that competes with Magna?", "Magna"), null, "bare 'work' + competitor scope");
});
test("employment decision: subsidiaries broadening → clean-miss 'No' (operator #3: trust your list, no ownership DB)", () => {
  const p = { employment_history_companies: ["Rivian"], work_experience: [{ company: "Rivian", currently_work_here: true }] };
  const q = "Have you been employed by Magna or any of its subsidiaries?";
  const emp = recognizeEmploymentQuestion(q, "Magna");
  assert.deepStrictEqual(emp, { tense: "ever", company: "Magna" });
  assert.deepStrictEqual(pickFR(decideEmploymentStatus(emp.tense, "Magna", p, q)), { fill: "No", review: false });
});

// ── DROPDOWN parity (2026-07-24) — the same question rendered as a yes/no dropdown fills the same way.
const empDropdown = (label, opts) => ({
  wrapperSel: "[w-empdd]", fieldName: "customScreeningDd", widgetType: "dropdown", isRequired: true, label,
  triggerText: "Select One",
  options: opts || [{ text: "Select One", disabled: true }, { text: "Yes" }, { text: "No" }]
});
test("employment DROPDOWN — clean No fills silently; the AI is never consulted even when enabled", async () => {
  const act = makeFakeAct([empDropdown("Are you a former MAGNA employee?")], { aiEnabled: true, ai: '{"choice":"Yes","justification":"trap — must not be called","confidence":"High"}' });
  const rec = (await drivePageFill(act, { employment_history_companies: ["Google"] }, {}, { company: "Magna" }, T_BUDGETS)).results[0];
  assert.strictEqual(rec.after, "No");
  assert.strictEqual(rec.status, "filled", "a grounded No fills silently on a dropdown too");
  assert.ok(!rec.flag, "no flag on a clean No");
  assert.ok(!act.log.some(([m]) => m === "llm"), "the employment check runs BEFORE the dropdown AI — no LLM call");
  assert.strictEqual(buildReviewBundle([rec], {}).entries[0].needs_review, false);
});
test("employment DROPDOWN — verbose options map by polarity", async () => {
  const opts = [{ text: "Select One", disabled: true }, { text: "Yes, I am currently employed with Magna" }, { text: "No, I'm NOT currently employed with Magna" }];
  const [rec] = await run([empDropdown("Are you currently employed with Magna?", opts)], { work_experience: [{ company: "Google", currently_work_here: true }], employment_history_companies: ["Google"] }, { company: "Magna" });
  assert.strictEqual(rec.after, "No, I'm NOT currently employed with Magna");
  assert.strictEqual(rec.status, "filled");
});
test("employment DROPDOWN — Yes (company in history) → filled_review + employer-match, never silent", async () => {
  const [rec] = await run([empDropdown("Are you a former MAGNA employee?")], { employment_history_companies: ["Magna"] }, { company: "Magna" });
  assert.strictEqual(rec.after, "Yes");
  assert.strictEqual(rec.status, "filled_review");
  assert.strictEqual(rec.flag, "employer-match");
  assert.strictEqual(buildReviewBundle([rec], {}).entries[0].needs_review_reason, "employer_match_uncertain");
});
test("employment DROPDOWN — a DIFFERENT prefilled real value is never silently overwritten (forced review)", async () => {
  const dd = empDropdown("Are you a former MAGNA employee?");
  dd.triggerText = "Yes"; // a prior run / human left "Yes"
  const [rec] = await run([dd], { employment_history_companies: ["Google"] }, { company: "Magna" });
  assert.strictEqual(rec.after, "No", "the grounded answer commits");
  assert.strictEqual(rec.status, "filled_review", "an overwrite of a real value is ALWAYS review-flagged");
  assert.match(rec.detail, /overwrote prefilled "Yes"/);
});
test("employment DROPDOWN — already holds the grounded answer → kept with ZERO value actuation", async () => {
  const dd = empDropdown("Are you a former MAGNAemployee?".replace("MAGNAemployee", "MAGNA employee"));
  dd.triggerText = "No";
  const act = makeFakeAct([dd]);
  const rec = (await drivePageFill(act, { employment_history_companies: ["Google"] }, {}, { company: "Magna" }, T_BUDGETS)).results[0];
  assert.strictEqual(rec.status, "filled");
  assert.ok(!act.log.some(([m]) => m === "clickDropdownOptionByText"), "no value actuation on an already-correct field");
});
test("employment RADIO — a DIFFERENT pre-selected option is never silently overwritten (forced review)", async () => {
  const f = empField("Are you a former MAGNA employee?");
  f.options = [{ id: "y", labelText: "Yes", checked: true }, { id: "n", labelText: "No", checked: false }]; // "Yes" pre-selected
  const [rec] = await run([f], { employment_history_companies: ["Google"] }, { company: "Magna" });
  assert.strictEqual(rec.after, "No");
  assert.strictEqual(rec.status, "filled_review", "flipping a pre-selected answer is ALWAYS review-flagged");
  assert.match(rec.detail, /overwrote the pre-selected "Yes"/);
});
test("employment — a bare exact 'Yes' option commits even beside a granular variant (review-flagged as every Yes is)", async () => {
  const f = empField("Are you a former MAGNA employee?");
  f.options = [{ id: "a", labelText: "Yes", checked: false }, { id: "b", labelText: "Yes, within the last 2 years", checked: false }, { id: "c", labelText: "No", checked: false }];
  const [rec] = await run([f], { employment_history_companies: ["Magna"] }, { company: "Magna" });
  assert.strictEqual(rec.after, "Yes", "exact tier: the bare option is a valid polarity commit");
  assert.strictEqual(rec.status, "filled_review", "every Yes is review-flagged — the human picks the granularity if needed");
  assert.strictEqual(rec.flag, "employer-match");
});
test("employment — GENUINELY ambiguous options (no bare option, two Yes-leading) → falls to the flagged AI, never a wrong pick", async () => {
  const f = empField("Are you a former MAGNA employee?");
  f.options = [{ id: "a", labelText: "Yes, within the last 2 years", checked: false }, { id: "b", labelText: "Yes, more than 2 years ago", checked: false }, { id: "c", labelText: "No", checked: false }];
  const act = makeFakeAct([f], { aiEnabled: true, ai: '{"choice":"Yes, within the last 2 years","justification":"worked there per history","confidence":"Medium"}' });
  const rec = (await drivePageFill(act, { employment_history_companies: ["Magna"] }, {}, { company: "Magna" }, T_BUDGETS)).results[0];
  // decision is "Yes" but NO exact option and TWO Yes-leading → optionForPolarity refuses → AI picks (flagged)
  assert.strictEqual(rec.status, "filled_review");
  assert.ok(rec.flag && rec.flag.indexOf("ai-") === 0, "the AI (flagged) handles granularity the polarity map can't disambiguate");
});

// ── ALL WIDGET TYPES (2026-07-24) — the same question renders as a checkbox assertion or a free-text box.
test("employment recognizer: FIRST-PERSON checkbox assertion fires; the negated form bails", () => {
  assert.deepStrictEqual(recognizeEmploymentQuestion("I am a former Magna employee.", "Magna"), { tense: "former", company: "Magna" });
  assert.strictEqual(recognizeEmploymentQuestion("I am not a former Magna employee.", "Magna"), null, "negated first-person assertion → inverted polarity → bail");
});
const empCheckbox = (label, flags) => Object.assign({
  wrapperSel: "[w-empcb]", fieldName: "customScreeningCb", widgetType: "checkbox", label,
  inputId: "empcb-input", checked: false
}, flags || {});
test("employment REQUIRED checkbox — STILL auto-checked (required can't stay blank), but a grounded-No contradiction is review-flagged", async () => {
  const [rec] = await run([empCheckbox("I am a former Magna employee.", { isRequired: true })], { employment_history_companies: ["Google"] }, { company: "Magna" });
  assert.strictEqual(rec.after, "true", "the box IS checked — the auto-consent rule holds");
  assert.strictEqual(rec.status, "filled_review", "…but silently asserting what the profile contradicts is flagged");
  assert.strictEqual(rec.flag, "employer-match");
  assert.match(rec.detail, /grounded employment answer is "No"/);
});
test("employment REQUIRED checkbox — agreement (company IS a past employer) stays a silent auto-check", async () => {
  const [rec] = await run([empCheckbox("I am a former Magna employee.", { isRequired: true })], { employment_history_companies: ["Magna"] }, { company: "Magna" });
  assert.strictEqual(rec.after, "true");
  assert.strictEqual(rec.status, "filled", "the grounded answer agrees with the check — no flag needed");
  assert.ok(!rec.flag);
});
test("ordinary REQUIRED consent checkbox — auto-check behavior byte-identical (no employment question → no flag)", async () => {
  const [rec] = await run([empCheckbox("I agree to the terms and conditions and authorize a background check.", { isRequired: true })], { employment_history_companies: ["Google"] }, { company: "Magna" });
  assert.strictEqual(rec.after, "true");
  assert.strictEqual(rec.status, "filled");
  assert.ok(!rec.flag, "consent auto-check unchanged — 'agree'/'authorize' bail the recognizer");
});
test("employment OPTIONAL checkbox — clean No leaves it unchecked SILENTLY (zero value actuation)", async () => {
  const act = makeFakeAct([empCheckbox("I am a former Magna employee.")]);
  const rec = (await drivePageFill(act, { employment_history_companies: ["Google"] }, {}, { company: "Magna" }, T_BUDGETS)).results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "false", "stays unchecked — the grounded No");
  assert.ok(!rec.flag);
  assert.ok(!act.log.some(([m]) => m === "clickCheckboxLabel"), "a virgin box already matches 'No' — no actuation");
});
test("employment OPTIONAL checkbox — Yes (company in history) → CHECKED + review, never silent", async () => {
  const [rec] = await run([empCheckbox("I am a former Magna employee.")], { employment_history_companies: ["Magna"] }, { company: "Magna" });
  assert.strictEqual(rec.after, "true");
  assert.strictEqual(rec.status, "filled_review");
  assert.strictEqual(rec.flag, "employer-match");
});
test("employment OPTIONAL checkbox — a pre-TICKED box cleared by a grounded No is forced to review", async () => {
  const [rec] = await run([empCheckbox("I am a former Magna employee.", { checked: true })], { employment_history_companies: ["Google"] }, { company: "Magna" });
  assert.strictEqual(rec.after, "false", "unchecked — the grounded No commits");
  assert.strictEqual(rec.status, "filled_review", "clearing a pre-existing tick is ALWAYS review-flagged");
  assert.match(rec.detail, /unchecked the pre-ticked box/);
});
const empText = (label, flags) => Object.assign({
  wrapperSel: "[w-emptx]", fieldName: "customScreeningTx", widgetType: "text", isRequired: true, label, value: ""
}, flags || {});
test("employment TEXT — clean No types \"No\" silently; the AI is never consulted even when enabled", async () => {
  const act = makeFakeAct([empText("Are you a former MAGNA employee?")], { aiEnabled: true, ai: '{"answer":"trap — must not be called"}' });
  const rec = (await drivePageFill(act, { employment_history_companies: ["Google"] }, {}, { company: "Magna" }, T_BUDGETS)).results[0];
  assert.strictEqual(rec.after, "No");
  assert.strictEqual(rec.status, "filled");
  assert.ok(!rec.flag);
  assert.ok(!act.log.some(([m]) => m === "llm"), "deterministic — no LLM call");
});
test("employment TEXT — Yes (company in history) → filled_review + employer-match", async () => {
  const [rec] = await run([empText("Have you ever worked for Magna?")], { employment_history_companies: ["Magna"] }, { company: "Magna" });
  assert.strictEqual(rec.after, "Yes");
  assert.strictEqual(rec.status, "filled_review");
  assert.strictEqual(rec.flag, "employer-match");
});
test("employment TEXT — a detail-REQUEST field ('enter your employee ID') is NOT answered with a bare No", async () => {
  const [rec] = await run([empText("If you are a former MAGNA employee, please enter your employee ID below.")], { employment_history_companies: ["Google"] }, { company: "Magna" });
  assert.notStrictEqual(rec.mappedPath, "(employment-status)", "detail-request → not a yes/no ask → left for AI-2/blank");
  assert.notStrictEqual(rec.after, "No");
});
test("employment TEXT — a pre-existing DIFFERENT value is never silently overwritten", async () => {
  const [rec] = await run([empText("Are you a former MAGNA employee?", { value: "Yes" })], { employment_history_companies: ["Google"] }, { company: "Magna" });
  assert.strictEqual(rec.after, "No", "the grounded answer commits");
  assert.strictEqual(rec.status, "filled_review");
  assert.match(rec.detail, /overwrote "Yes"/);
});
test("employment TEXTAREA — clean No types \"No\" silently", async () => {
  const f = empText("Are you currently employed with Magna?");
  f.widgetType = "textarea";
  const [rec] = await run([f], { work_experience: [{ company: "Google", currently_work_here: true }], employment_history_companies: ["Google"] }, { company: "Magna" });
  assert.strictEqual(rec.after, "No");
  assert.strictEqual(rec.status, "filled");
});
test("employment OPTIONAL radio — the deterministic tier runs for optional fields too (like buckets)", async () => {
  const f = empField("Are you a former MAGNA employee?");
  f.isRequired = false;
  const [rec] = await run([f], { employment_history_companies: ["Google"] }, { company: "Magna" });
  assert.strictEqual(rec.after, "No");
  assert.strictEqual(rec.status, "filled", "grounded + deterministic → fills optional fields too");
});

// ── AI required-radio fallback (aiFillRadio) — the deferred required-radio path ──────────────
// A REQUIRED radio the deterministic pass can't answer would BLOCK Save & Continue → guess-to-reach-
// review (never blind-trust): infer + commit + ALWAYS filled_review, flagged HARD. AI OFF / OPTIONAL → blank.
const aiPwField = (flags) => pwField(Object.assign({ isRequired: true }, flags || {}));

test("AI radio (prev-worker unevaluable): infers No → filled_review + ai-choice-sensitive (LOUD), committed, confidence carried", async () => {
  // employment_history_companies:[] (unfilled) → decidePreviousWorker is UNEVALUABLE (blank — an empty
  // list can't confirm non-membership); the required-radio AI fallback then infers "No" from the absence.
  // (A NON-empty list is now a deterministic clean-miss "No" even without a company — so [] is the genuine
  // unevaluable input that still exercises the AI path.)
  const act = makeFakeAct([aiPwField()], { aiEnabled: true, ai: '{"choice":"No","justification":"Magna not in employment history","confidence":"High"}' });
  const rec = (await drivePageFill(act, pwProfile([]), {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(rec.status, "filled_review", "an AI guess is never silently filled");
  assert.strictEqual(rec.after, "No");
  assert.strictEqual(rec.flag, "ai-choice-sensitive", "prev-worker sits next to a truthfulness cert → always LOUD");
  assert.strictEqual(rec.confidence, "high");
  assert.match(rec.detail, /employment history/);
  assert.ok(act.log.some(([m]) => m === "llm") && act.log.some(([m]) => m === "clickRadioLabel"), "called the LLM + committed the radio");
  const e = buildReviewBundle([rec], {}).entries[0];
  assert.strictEqual(e.needs_review, true);
  assert.strictEqual(e.confidence_source, "ai_inference");
  assert.strictEqual(e.current_value, "No");
});

test('AI radio: an inferred "Yes" is STILL filled_review, never plain filled (the truthfulness-cert invariant holds under AI)', async () => {
  const act = makeFakeAct([aiPwField()], { aiEnabled: true, ai: '{"choice":"Yes","justification":"prior tenure suggested","confidence":"Low"}' });
  const rec = (await drivePageFill(act, pwProfile([]), {}, {}, T_BUDGETS)).results[0]; // [] = genuinely unevaluable → AI path
  assert.strictEqual(rec.after, "Yes");
  assert.notStrictEqual(rec.status, "filled", "a Yes is never silently filled");
  assert.strictEqual(rec.status, "filled_review");
  assert.strictEqual(rec.flag, "ai-choice-sensitive");
});

test("AI radio SAFETY: a determined-but-uncommitted decision (resolved set) is NEVER overridden by an AI guess", async () => {
  // exact company match → decidePreviousWorker decides "Yes"; the commit FAILS (dead rect + space fails).
  // resolved is set, so the AI fallback must NOT fire (else it could flip the answer). Stays deterministic.
  const act = makeFakeAct([aiPwField({ radioClickRectDead: true, spaceFails: true })], { aiEnabled: true, ai: '{"choice":"No","justification":"x","confidence":"High"}' });
  const rec = (await drivePageFill(act, pwProfile(["Magna"]), {}, { company: "Magna" }, T_BUDGETS)).results[0];
  assert.strictEqual(rec.status, "needs_review", "stays the deterministic review — not AI-overridden");
  assert.ok(!act.log.some(([m]) => m === "llm"), "the AI radio fallback must not fire when a decision was already made");
});

test("AI radio: an UNMAPPED required radio → AI picks a label → filled_review + ai-choice (not sensitive)", async () => {
  const field = { wrapperSel: "[w-r]", fieldName: "unknown_screen", widgetType: "radio", isRequired: true, label: "Do you have reliable transportation?",
    options: [{ id: "r-yes", labelText: "Yes", checked: false }, { id: "r-no", labelText: "No", checked: false }] };
  const act = makeFakeAct([field], { aiEnabled: true, ai: '{"choice":"Yes","justification":"driver license in profile","confidence":"Medium"}' });
  const rec = (await drivePageFill(act, {}, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(rec.status, "filled_review");
  assert.strictEqual(rec.after, "Yes");
  assert.strictEqual(rec.flag, "ai-choice");
  assert.strictEqual(rec.confidence, "medium");
});

test("AI radio: a demographic (EEO) required radio → re-tagged ai-eeo-guess (DEMOGRAPHIC badge)", async () => {
  const field = { wrapperSel: "[w-g]", fieldName: "gender", widgetType: "radio", isRequired: true, label: "Gender",
    options: [{ id: "g-m", labelText: "Male", checked: false }, { id: "g-f", labelText: "Female", checked: false }, { id: "g-x", labelText: "Decline to self-identify", checked: false }] };
  const act = makeFakeAct([field], { aiEnabled: true, ai: '{"choice":"Decline to self-identify","justification":"no gender stated","confidence":"Low"}' });
  const rec = (await drivePageFill(act, {}, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(rec.status, "filled_review");
  assert.strictEqual(rec.flag, "ai-eeo-guess");
});

test("AI radio: the AI's pick is not one of the labels → needs_review (ai-nomatch), no commit", async () => {
  const act = makeFakeAct([aiPwField()], { aiEnabled: true, ai: '{"choice":"Maybe","justification":"unsure","confidence":"Low"}' });
  const rec = (await drivePageFill(act, pwProfile([]), {}, {}, T_BUDGETS)).results[0]; // [] = unevaluable → AI path (a non-empty list now fills a deterministic "No")
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.flag, "ai-nomatch");
  assert.strictEqual(rec.after, null);
  assert.ok(!act.log.some(([m]) => m === "clickRadioLabel"), "never committed a non-option");
});

test("AI radio: an OPTIONAL blank radio never calls the LLM (optional doesn't block → no guess)", async () => {
  const field = pwField(); // no isRequired
  const act = makeFakeAct([field], { aiEnabled: true, ai: '{"choice":"No","justification":"x","confidence":"High"}' });
  const rec = (await drivePageFill(act, pwProfile([]), {}, {}, T_BUDGETS)).results[0];
  assert.ok(!act.log.some(([m]) => m === "llm"), "optional radio: no LLM call");
  assert.strictEqual(rec.after, null, "stays the deterministic unevaluable blank");
});

test("AI radio OFF: prev-worker unevaluable stays blank needs_review (no AI without the toggle)", async () => {
  const act = makeFakeAct([aiPwField()]); // aiEnabled default OFF
  const rec = (await drivePageFill(act, pwProfile([]), {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.after, null);
  assert.ok(!act.log.some(([m]) => m === "llm"));
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

test("dropdown: trigger already matches a candidate → filled / dropdown-prefilled-kept, value never overwritten (M27 Commit C)", async () => {
  const act = makeFakeAct([ddField({ triggerText: "United States of America" })]);
  const out = await drivePageFill(act, usProfile, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.matchTier, "pre-filled");
  assert.strictEqual(rec.flag, "dropdown-prefilled-kept");
  assert.strictEqual(rec.confidence, "high");
  assert.strictEqual(rec.after, "United States of America");
  // M27.C: the FILL never overwrites a tier-0 match. (2026-07-05: the end-of-page read-only option
  // capture MAY re-open it to scrape options for the review editor — value preserved, M40-audited —
  // so the invariant is "no value-changing commit", not the old "no open".)
  for (const bad of ["clickDropdownOptionByText", "typeJumpChars", "arrowStep", "clickOptionByIndex"])
    assert.ok(!act.log.some(([m]) => m === bad), "a tier-0 pre-fill is never re-committed — no " + bad);
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

test("dropdown OVERWRITE fast-first: a fast-attempt MISS re-opens and commits on the slow refill (never left flipped)", async () => {
  // Models the pre-filled+flipped languages: the fast (small-beat) click MISSES (dismisses the list without
  // committing), so the fast-first path must re-open and commit on the full ~700ms refill — ending FILLED,
  // not needs_review. commitsOnAttempt:2 → 1st text-click dismisses, 2nd commits.
  const opts = [{ text: "Select One", disabled: true }, { text: "Afghanistan" }, { text: "United States of America" }, { text: "United States" }];
  const act = makeFakeAct([ddField({ triggerText: "United States of America", options: opts, commitsOnAttempt: 2 })]);
  const out = await drivePageFill(act, { personal_info: { country: ["Afghanistan", "United States of America", "United States"] } }, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled", "commits on the slow refill — not left flipped/needs_review");
  assert.strictEqual(rec.after, "Afghanistan", "upgraded to the tier-0 candidate after the refill");
  assert.strictEqual(rec.flag, "dropdown-overwrite-success");
  assert.strictEqual(act.log.filter(([m]) => m === "clickDropdownOptionByText").length, 2, "fast attempt missed → exactly one refill click");
  assert.ok(act.log.filter(([m]) => m === "openDropdown").length >= 2, "re-opened the list for the refill");
});

test("dropdown OVERWRITE beat is VISIBILITY-aware: visible uses a SMALLER fast beat than hidden", async () => {
  // The overwrite debounce is a PAINT thing (tiny visible, ~700ms hidden), so the fast beat splits on
  // act.visible: visible=30ms, hidden=100ms. Record the delayFull durations and confirm the overwrite's
  // fast beat (the largest sub-500ms delayFull; the audit settle is 600, excluded) is smaller when visible.
  const mk = (visible) => {
    const opts = [{ text: "Select One", disabled: true }, { text: "Afghanistan" }, { text: "United States of America" }];
    const a = makeFakeAct([ddField({ triggerText: "United States of America", options: opts })]);
    a.visible = async () => visible;
    a._beats = [];
    const d = a.delayFull;
    a.delayFull = async (ms) => { a._beats.push(ms); return d(ms); };
    return a;
  };
  const vis = mk(true), hid = mk(false);
  const prof = { personal_info: { country: ["Afghanistan", "United States of America"] } }; // tier-0 upgrade → overwrite
  await drivePageFill(vis, prof, {}, {}, T_BUDGETS);
  await drivePageFill(hid, prof, {}, {}, T_BUDGETS);
  const fastBeatOf = (arr) => Math.max(0, ...arr.filter((b) => b > 0 && b < 500)); // audit settle (600) excluded
  const vb = fastBeatOf(vis._beats), hb = fastBeatOf(hid._beats);
  assert.ok(vb <= 30, `visible fast beat ≤30 (got ${vb})`);
  assert.ok(hb > 30 && hb <= 120, `hidden fast beat ~120 (got ${hb})`);
  assert.ok(vb < hb, `visible beat (${vb}) < hidden beat (${hb})`);
});

test("overwriteBeatLadder: visible → [30,100,700,5000]; hidden → [120,700,5000] (final 5s safety tier); ascending + deduped", () => {
  const b = { overwriteFastBeatVisibleMs: 30, overwriteSlowBeatVisibleMs: 100, overwriteFastBeatMs: 120, overwriteSlowBeatMs: 700, overwriteMaxBeatMs: 5000 };
  assert.deepStrictEqual(overwriteBeatLadder(b, true), [30, 100, 700, 5000], "visible escalates through the big beat to the 5s safety tier");
  assert.deepStrictEqual(overwriteBeatLadder(b, false), [120, 700, 5000], "hidden: proven pair + the 5s safety tier");
  // defensive: a tenant retune that makes beats out-of-order / duplicated still yields an ascending unique ladder
  assert.deepStrictEqual(overwriteBeatLadder({ overwriteFastBeatVisibleMs: 100, overwriteSlowBeatVisibleMs: 30, overwriteSlowBeatMs: 700 }, true), [30, 100, 700]);
});

test("dropdown OVERWRITE escalation: a VISIBLE-labeled tab whose commit needs the BIG beat escalates 30→100→700 and COMMITS (occlusion/alt-tab fix)", async () => {
  // The alt-tab/occlusion bug: act.visible reported "visible" but the tab was occluded (not painting), so
  // the overwrite only commits at the ~700ms beat. The OLD visible pair [30,100] never reached 700 → both
  // missed → needs_review (the observed swapped/failed languages). The ladder must escalate to the 700 tier
  // and end FILLED. commitsOnAttempt:3 → the first two tiers miss, the third (700) commits.
  const opts = [{ text: "Select One", disabled: true }, { text: "Afghanistan" }, { text: "United States of America" }];
  const act = makeFakeAct([ddField({ triggerText: "United States of America", options: opts, commitsOnAttempt: 3 })]);
  act.visible = async () => true; // mislabeled "visible" (occluded in reality)
  const out = await drivePageFill(act, { personal_info: { country: ["Afghanistan", "United States of America"] } }, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled", "escalated to the big beat and committed — NOT left needs_review");
  assert.strictEqual(rec.after, "Afghanistan");
  assert.strictEqual(rec.flag, "dropdown-overwrite-success");
  assert.strictEqual(act.log.filter(([m]) => m === "clickDropdownOptionByText").length, 3, "one click per tier (30, 100, 700)");
  assert.ok(act.log.filter(([m]) => m === "openDropdown").length >= 3, "re-opened the list for each escalation tier");
});

test("dropdown OVERWRITE escalation: a commit that NEVER takes exhausts the ladder → needs_review (never a wrong/silent fill)", async () => {
  const opts = [{ text: "Select One", disabled: true }, { text: "Afghanistan" }, { text: "United States of America" }];
  const act = makeFakeAct([ddField({ triggerText: "United States of America", options: opts, commitsOnAttempt: 99 })]); // never commits
  act.visible = async () => true;
  const out = await drivePageFill(act, { personal_info: { country: ["Afghanistan", "United States of America"] } }, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "needs_review", "exhausted all tiers without a persisted commit → honest needs_review");
  assert.notStrictEqual(rec.after, "Afghanistan", "never reported the target as filled when it did not persist");
});

test("closeDropdownConfirmed: waits for the LISTBOX to unmount (options gone), NOT just aria-expanded=false", async () => {
  // The close race: aria-expanded flips to "false" the instant a commit/Escape fires, but the portaled
  // options linger a beat while they unmount and STAY CLICKABLE. Gating on aria alone returns too early →
  // the next field's open-click strays onto a lingering option. Here aria is ALWAYS "false" yet options
  // linger for 2 reads — a correct gate must keep polling (re-Escaping) until optionCount hits 0.
  let escapes = 0, lingering = 2;
  const act = {
    delayFull: async () => {},
    pressEscape: async () => { escapes++; },
    readDropdownState: async () => {
      const open = lingering > 0; if (lingering > 0) lingering -= 1;
      return { ariaExpanded: "false", listboxPresent: open, optionCount: open ? 5 : 0 };
    }
  };
  const gone = await closeDropdownConfirmed(act, { wrapperSel: "[w]" }, { openRetries: 3, commitIntervalMs: 1 });
  assert.strictEqual(gone, true, "confirmed closed only once the options unmounted");
  assert.ok(escapes >= 1, "kept Escaping while options lingered — an aria-only gate would have Escaped 0 times");
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

test("dropdown TIER-AWARE: a tier-0 pre-fill is KEPT and never overwritten (fill does not actuate)", async () => {
  const act = makeFakeAct([ddField({ triggerText: "United States of America" })]);
  const out = await drivePageFill(act, { personal_info: { country: ["United States of America", "United States", "Canada"] } }, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.flag, "dropdown-prefilled-kept");
  assert.strictEqual(rec.after, "United States of America");
  // Value never mutated. (The read-only end-of-page option capture re-opens to scrape options for the
  // review editor — no commit — value preserved + M40-audited.)
  for (const bad of ["clickDropdownOptionByText", "typeJumpChars", "arrowStep", "clickOptionByIndex"])
    assert.ok(!act.log.some(([m]) => m === bad), "a tier-0 pre-fill must never be overwritten — no " + bad);
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

// ── BATCHED AI: one call per PAGE instead of one per question (2026-08-05) ──
// The win is N round trips → 1, with the call fired before the deterministic fill so it overlaps. The
// safety requirement is that batching changes the TRANSPORT ONLY: every answer still clears the match
// ladder against the LIVE options and still commits through the same verified path.
const AI_BATCH_BUDGETS = { ...T_BUDGETS, enableAiBatch: true };
const aiDd2 = (id, label, opts) => ({ wrapperSel: "[w-" + id + "]", fieldName: id, widgetType: "dropdown",
  isRequired: true, label, triggerText: "Select One",
  options: [{ text: "Select One", disabled: true }].concat((opts || ["Yes", "No"]).map((t) => ({ text: t }))) });

test("AI batch: TWO AI questions on a page cost ONE llm call, and both commit", async () => {
  const act = makeFakeAct([aiDd2("q1", "Are you legally authorized to work in the US?*"),
                           aiDd2("q2", "Do you require sponsorship?*")],
    { aiEnabled: true, ai: JSON.stringify({ answers: [
      { id: "q1", choice: "Yes", justification: "profile says authorized", confidence: "High" },
      { id: "q2", choice: "No", justification: "no sponsorship needed", confidence: "High" }] }) });
  const out = await drivePageFill(act, {}, {}, {}, AI_BATCH_BUDGETS);
  const calls = act.log.filter(([m]) => m === "llm").length;
  assert.strictEqual(calls, 1, `one batched call for the whole page, not one per question (saw ${calls})`);
  const q1 = out.results.find((r) => r.fieldName === "q1"), q2 = out.results.find((r) => r.fieldName === "q2");
  assert.strictEqual(q1.status, "filled_review", q1.detail);
  assert.strictEqual(q1.after, "Yes");
  assert.strictEqual(q2.status, "filled_review", q2.detail);
  assert.strictEqual(q2.after, "No");
  assert.match(q1.detail, /profile says authorized/, "the per-question justification survives the batch");
  assert.strictEqual(q1.confidence, "high", "and so does its confidence");
});

test("AI batch: a batched answer STILL clears the match ladder — an off-list choice never blind-commits", async () => {
  // The whole safety contract in one test: batching must not become a way to skip the ladder.
  const act = makeFakeAct([aiDd2("q1", "Pick one*"), aiDd2("q2", "Pick two*")],
    { aiEnabled: true, ai: JSON.stringify({ answers: [
      { id: "q1", choice: "Maybe", confidence: "High" },      // NOT an option
      { id: "q2", choice: "No", confidence: "High" }] }) });
  const out = await drivePageFill(act, {}, {}, {}, AI_BATCH_BUDGETS);
  const q1 = out.results.find((r) => r.fieldName === "q1");
  assert.strictEqual(q1.status, "needs_review", "an off-list batched answer is refused exactly like a per-field one");
  assert.strictEqual(q1.flag, "ai-nomatch");
  assert.notStrictEqual(q1.after, "Maybe", "and nothing was committed");
  assert.strictEqual(out.results.find((r) => r.fieldName === "q2").after, "No", "its sibling still commits");
});

test("AI batch is a CACHE, not a gate: a question the batch missed makes its OWN call", async () => {
  // Misprediction, a dropped id, a partial parse — none of these may cost an ANSWER, only speed.
  const act = makeFakeAct([aiDd2("q1", "Pick one*"), aiDd2("q2", "Pick two*")],
    { aiEnabled: true, ai: [JSON.stringify({ answers: [{ id: "q1", choice: "Yes", confidence: "High" }] }), // q2 absent
                            '{"choice":"No","justification":"per-field fallback","confidence":"Medium"}'] });
  const out = await drivePageFill(act, {}, {}, {}, AI_BATCH_BUDGETS);
  assert.strictEqual(act.log.filter(([m]) => m === "llm").length, 2, "the batch + ONE per-field call for the miss");
  assert.strictEqual(out.results.find((r) => r.fieldName === "q1").after, "Yes");
  const q2 = out.results.find((r) => r.fieldName === "q2");
  assert.strictEqual(q2.status, "filled_review", q2.detail);
  assert.strictEqual(q2.after, "No", "the missed question was still answered, by its own call");
});

test("AI batch: OFF by default → one call PER question (batching is opt-in until live-verified)", async () => {
  const act = makeFakeAct([aiDd2("q1", "Pick one*"), aiDd2("q2", "Pick two*")],
    { aiEnabled: true, ai: '{"choice":"Yes","confidence":"High"}' });
  const out = await drivePageFill(act, {}, {}, {}, T_BUDGETS); // batching NOT enabled
  assert.strictEqual(act.log.filter(([m]) => m === "llm").length, 2, "one call per question, exactly as before batching");
  assert.strictEqual(out.results.find((r) => r.fieldName === "q1").after, "Yes");
});

test("debugClobber: names the field that was wiped and the write that did it", async () => {
  // Live on waystar page 3: filling the relocation question CLEARS the dependent basecamp answer, and
  // the page then cannot Save because basecamp is required and empty. The end state was visible in the
  // FIELD-DIAG dump; the CAUSE was not. This flag re-scans after every field and attributes the change
  // to the write that caused it (a REMOUNT shows as a vanish + an appear).
  const a = { wrapperSel: "[w-a]", fieldName: "trigger", widgetType: "text", isRequired: true, label: "Trigger" };
  const b = { wrapperSel: "[w-b]", fieldName: "dependent", widgetType: "text", isRequired: true, label: "Dependent" };
  const act = makeFakeAct([a, b]);
  // The up-front scan sees the dependent answer present; every scan AFTER it sees the tenant's wipe.
  let scans = 0;
  act.scanPage = async () => {
    const first = scans++ === 0;
    return { fields: [
      { fieldName: "trigger", label: "Trigger", currentValue: "", wrapperSel: "[w-a]", widgetType: "text" },
      { fieldName: "dependent", label: "Dependent", currentValue: first ? "Atlanta, GA" : "", wrapperSel: "[w-b]", widgetType: "text" }] };
  };
  const out = await drivePageFill(act, { personal_info: {} }, {}, {},
    { ...T_BUDGETS, debugClobber: true, maxCascadeRounds: 0 });
  const hit = (out.clobberLog || []).find((l) => /dependent/.test(l) && /WITHOUT being touched/.test(l));
  assert.ok(hit, "the wipe must be attributed to the write that caused it: " + JSON.stringify(out.clobberLog));
  assert.match(hit, /Atlanta, GA/, "and it names the value that was lost");
  assert.match(hit, /after filling trigger/, "and the write that caused it");
});

test("debugClobber: OFF by default → no extra page scans (it is a diagnostic, not a cost)", async () => {
  const act = makeFakeAct([{ wrapperSel: "[w-a]", fieldName: "trigger", widgetType: "text", isRequired: true, label: "Trigger" }]);
  let scans = 0;
  const real = act.scanPage;
  act.scanPage = async () => { scans++; return real(); };
  await drivePageFill(act, { personal_info: {} }, {}, {}, { ...T_BUDGETS, maxCascadeRounds: 0 });
  const withFlag = scans; scans = 0;
  await drivePageFill(act, { personal_info: {} }, {}, {}, { ...T_BUDGETS, maxCascadeRounds: 0, debugClobber: true });
  assert.ok(scans > withFlag, `the flag adds the per-field scans (off=${withFlag}, on=${scans})`);
});

test("AI answer STABILITY: the same question under a NEW automation-id reuses the answer, no second call", async () => {
  // The waystar page-3 oscillation. Workday remounts a dependent question under a new id whenever the
  // field it depends on CHANGES, and the cascade re-fill calls drivePageFill recursively — which used to
  // build a fresh batch with no memory of the first, so the remounted question was asked again and the
  // model was free to answer differently. Live that produced Yes -> No -> Yes on the relocation question,
  // and every CHANGE remounted the dependent question again, so the page never settled and Save was
  // refused on a required field that had been answered twice.
  // The question is the stable identity, so the answer is cached by LABEL and shared with the recursion.
  const q = (id) => ({ wrapperSel: "[w-" + id + "]", fieldName: id, widgetType: "dropdown", isRequired: true,
    label: "Would you be open to relocating?", triggerText: "Select One",
    options: [{ text: "Select One", disabled: true }, { text: "Yes" }, { text: "No" }] });
  const act = makeFakeAct([q("id_before")], { aiEnabled: true,
    // If it ever asks twice it gets the OPPOSITE answer — so a second call cannot hide in a green test.
    ai: ['{"choice":"Yes","confidence":"High"}', '{"choice":"No","confidence":"High"}'] });
  const shared = new Map();
  const r1 = await drivePageFill(act, {}, {}, {}, { ...T_BUDGETS, maxCascadeRounds: 0 }, { aiAnswers: shared });
  assert.strictEqual(r1.results[0].after, "Yes");
  // Same question comes back under a DIFFERENT id — exactly what a remount looks like to us.
  const act2 = makeFakeAct([q("id_after_remount")], { aiEnabled: true,
    ai: ['{"choice":"No","confidence":"High"}'] });   // a fresh call here would answer "No"
  const r2 = await drivePageFill(act2, {}, {}, {}, { ...T_BUDGETS, maxCascadeRounds: 0 }, { aiAnswers: shared });
  assert.strictEqual(r2.results[0].after, "Yes", "the remounted question must reuse the FIRST answer, not re-ask");
  assert.strictEqual(act2.log.filter(([m]) => m === "llm").length, 0, "and it must not call the model at all");
});

test("AI memory: a page REFILL reuses every answer and calls the model ZERO times", async () => {
  // Operator's fix: "if this page needs to be refilled, it should remember the previous answers and not
  // recall AI". The SW now holds one answer map per PAGE and hands it to every drivePageFill for that
  // page — the initial fill, the cascade recursion, and AI-4's re-fills. Before this, each re-fill was a
  // fresh invocation with an empty cache, so it asked again and could answer DIFFERENTLY; that
  // contradiction is what remounted dependent questions and made the page unsaveable.
  const q = (id, label) => ({ wrapperSel: "[w-" + id + "]", fieldName: id, widgetType: "dropdown", isRequired: true,
    label, triggerText: "Select One", options: [{ text: "Select One", disabled: true }, { text: "Yes" }, { text: "No" }] });
  const fields = () => [q("a", "Would you relocate?"), q("b", "Available three days a week?")];
  const memory = new Map();                                   // what the SW keeps per page
  const first = makeFakeAct(fields(), { aiEnabled: true,
    ai: JSON.stringify({ answers: [{ id: "a", choice: "Yes", confidence: "High" }, { id: "b", choice: "Yes", confidence: "High" }] }) });
  const r1 = await drivePageFill(first, {}, {}, {}, { ...AI_BATCH_BUDGETS, maxCascadeRounds: 0 }, { aiAnswers: memory });
  assert.strictEqual(r1.results.find((r) => r.fieldName === "a").after, "Yes");
  assert.strictEqual(first.log.filter(([m]) => m === "llm").length, 1, "one batched call on the first pass");

  // THE REFILL. Every canned reply now says "No", so any re-ask flips the answers and fails this test.
  const again = makeFakeAct(fields(), { aiEnabled: true,
    ai: ['{"choice":"No","confidence":"High"}', '{"choice":"No","confidence":"High"}',
         JSON.stringify({ answers: [{ id: "a", choice: "No" }, { id: "b", choice: "No" }] })] });
  const r2 = await drivePageFill(again, {}, {}, {}, { ...AI_BATCH_BUDGETS, maxCascadeRounds: 0 }, { aiAnswers: memory });
  assert.strictEqual(again.log.filter(([m]) => m === "llm").length, 0, "a refill must not call the model at all");
  assert.strictEqual(r2.results.find((r) => r.fieldName === "a").after, "Yes", "and must re-commit the SAME answer");
  assert.strictEqual(r2.results.find((r) => r.fieldName === "b").after, "Yes");
});

test("AI batch: the output cap SCALES with the number of questions", async () => {
  // A flat cap truncates exactly the pages the batch exists for: 6 questions each needing a choice, a
  // justification, a confidence, maps_to and suggested_category do not fit in one question's worth of
  // room, and a truncated JSON reply is not a shorter answer -- it fails to parse, so the whole page
  // falls back to per-field calls. Generosity is free: max_tokens is a CAP, not a reservation.
  const caps = [];
  const mk = (n) => {
    const fields = [];
    for (let i = 0; i < n; i++) fields.push(aiDd2("q" + i, "Question " + i + "?*"));
    const act = makeFakeAct(fields, { aiEnabled: true,
      ai: JSON.stringify({ answers: fields.map((f) => ({ id: f.fieldName, choice: "Yes", confidence: "High" })) }) });
    const realLlm = act.llm;
    act.llm = async (req) => { caps.push(req.maxTokens); return realLlm(req); };
    return act;
  };
  await drivePageFill(mk(2), {}, {}, {}, AI_BATCH_BUDGETS);
  await drivePageFill(mk(6), {}, {}, {}, AI_BATCH_BUDGETS);
  assert.strictEqual(caps.length, 2, "one batched call each: " + JSON.stringify(caps));
  assert.ok(caps[1] > caps[0], `6 questions must get a bigger budget than 2 (got ${caps[0]} then ${caps[1]})`);
  // Enough room for a well-formed answer per question, with real headroom.
  assert.ok(caps[1] >= 6 * 200, `and enough room per question (got ${caps[1]} for 6)`);
});

// ── The planner must model EVERY deterministic tier, not just FIELD_MAP ─────────────────────────────
// The fill ladder is FIELD_MAP -> buckets -> employment recognizers -> AI. Modelling only the first meant
// a question a later tier would answer was still scouted (its dropdown opened for options) and still took
// a slot in the prompt, and the answer was then discarded. Live on waystar page 3: both sponsorship
// questions carry hashed ids, so FIELD_MAP knew nothing, and BUCKETS answered them from the taught
// wording -- after the planner had already opened them and paid for them.
const plnField = (id, label) => ({ wrapperSel: "[w-" + id + "]", fieldName: id, widgetType: "dropdown",
  isRequired: true, label });

test("planner: a BUCKET-answerable question is not an AI candidate", async () => {
  const f = plnField("69dab8dbb3371001adc84c25b7120000", "Do you currently require sponsorship?*");
  const profile = { work_authorization: { requires_sponsorship_now: false } };
  const buckets = [{ profile_path: "work_authorization.requires_sponsorship_now",
    questions: ["Do you currently require sponsorship?"] }];
  const idx = buildBucketIndex(buckets);
  assert.strictEqual(deterministicTierFor(f, profile, idx, null), "bucket");
  assert.deepStrictEqual(planAiBatchCandidates([f], profile, null, idx, null), [],
    "the bucket owns it — no scout, no prompt slot");
  // …and with NO bucket it is still an AI candidate, so the skip is the bucket's doing and not a
  // side effect of the hashed id.
  assert.strictEqual(planAiBatchCandidates([f], profile, null, buildBucketIndex([]), null).length, 1);
});

test("planner: a bucket that resolves to NOTHING does not suppress the AI candidate", async () => {
  // A bucket bound to an EMPTY profile path is not an answer. Suppressing on its mere existence would
  // leave a required field to the blank path instead of the AI.
  const f = plnField("hashed_q", "Do you currently require sponsorship?*");
  const idx = buildBucketIndex([{ profile_path: "work_authorization.requires_sponsorship_now",
    questions: ["Do you currently require sponsorship?"] }]);
  assert.strictEqual(deterministicTierFor(f, { work_authorization: {} }, idx, null), null);
  assert.strictEqual(planAiBatchCandidates([f], { work_authorization: {} }, null, idx, null).length, 1);
});

test("planner: the employer-match question is never an AI candidate", async () => {
  const f = plnField("candidateIsPreviousWorker", "Have you previously been employed by Waystar?*");
  assert.strictEqual(deterministicTierFor(f, {}, null, null), "employer-match");
  assert.deepStrictEqual(planAiBatchCandidates([f], {}, null, null, null), []);
});

test("planner: a FIELD_MAP-answerable question is not an AI candidate (unchanged)", async () => {
  const f = plnField("country", "Country*");
  assert.strictEqual(deterministicTierFor(f, { personal_info: { country: "United States" } }, null, null), "field-map");
  const f2 = plnField("country", "Country*");
  assert.strictEqual(deterministicTierFor(f2, { personal_info: {} }, null, null), null, "…but an EMPTY mapped path is not an answer");
});

test("debugPageTrace: tracing changes NOTHING about the fill (it wraps the act primitives)", async () => {
  // The per-action timer replaces act.* methods with timed wrappers. That is exactly the kind of
  // instrumentation that can quietly alter behaviour -- a wrapper that drops a return value, or turns a
  // sync member into a promise, would break the fill while looking like a logging change. So run the SAME
  // page both ways and require identical records.
  const mk = () => makeFakeAct([aiDd2("q1", "Pick one*"), aiDd2("q2", "Pick two*")], { aiEnabled: true,
    ai: JSON.stringify({ answers: [{ id: "q1", choice: "Yes", confidence: "High" }, { id: "q2", choice: "No", confidence: "High" }] }) });
  const shape = (o) => o.results.map((r) => [r.fieldName, r.status, r.after, r.flag || null]);
  const plain = await drivePageFill(mk(), {}, {}, {}, AI_BATCH_BUDGETS, { aiAnswers: new Map() });
  const traced = await drivePageFill(mk(), {}, {}, {}, { ...AI_BATCH_BUDGETS, debugPageTrace: true }, { aiAnswers: new Map() });
  assert.deepStrictEqual(shape(traced), shape(plain), "tracing must be observationally inert");
});

test("AI batch: an INELIGIBLE field never waits on the in-flight call", async () => {
  // Live on waystar page 3, caught by the trace: an OPTIONAL textarea with no mapping ("What is your
  // desired salary?") reached the AI site, AWAITED the batch, blocked the walk 3.56s, and was then
  // skipped -- and it blocked EARLY, cutting short the overlap the batch exists to create. The batch may
  // only be consulted by a field that would actually use an AI answer.
  const optionalText = { wrapperSel: "[w-txt]", fieldName: "salary_q", widgetType: "textarea",
    isRequired: false, label: "What is your desired salary?" };
  const act = makeFakeAct([aiDd2("q1", "Pick one*"), aiDd2("q2", "Pick two*"), optionalText],
    { aiEnabled: true, ai: JSON.stringify({ answers: [{ id: "q1", choice: "Yes", confidence: "High" },
                                                      { id: "q2", choice: "No", confidence: "High" }] }) });
  let awaited = 0;
  const realLlm = act.llm;
  act.llm = async (r) => { awaited++; return realLlm(r); };
  const out = await drivePageFill(act, {}, {}, {}, AI_BATCH_BUDGETS);
  assert.strictEqual(awaited, 1, "still exactly one batched call");
  const txt = out.results.find((r) => r.fieldName === "salary_q");
  assert.strictEqual(txt.status, "skipped", "the optional unmapped textarea stays blank, no AI");
  // The batch bookkeeping must not count it either — it never consulted the batch at all.
  assert.strictEqual(out.aiBatchInfo.served, 2, "only the two eligible dropdowns were served");
});

test("debugPageTrace: the action timer is applied ONCE, even across recursive fills", async () => {
  // `act` is reused across pages and the cascade recurses into drivePageFill, so in-place wrapping
  // stacked: one call printed several times under different page clocks, and the overhead grew per page.
  const act = makeFakeAct([aiDd2("q1", "Pick one*")], { aiEnabled: true, ai: '{"choice":"Yes","confidence":"High"}' });
  const B = { ...T_BUDGETS, debugPageTrace: true, maxCascadeRounds: 0 };
  await drivePageFill(act, {}, {}, {}, B);
  const once = act.readDropdownState;
  await drivePageFill(act, {}, {}, {}, B);
  assert.strictEqual(act.readDropdownState, once, "a second fill must not re-wrap an already-timed primitive");
});

test("AI commit waits for the option list to UNMOUNT before the next field (the stray-click race)", async () => {
  // Operator's diagnosis, and the log backs it: every portaled listbox renders at the SAME screen
  // position (every commit on waystar page 3 logged rect=463,298). Selecting an option closes the list,
  // but the options linger a beat while unmounting and stay CLICKABLE — so the next field's open-click
  // lands where the previous field's options still are. On page 3 that click hit "No, but I live near one
  // of these locations", an option of the RELOCATION list, silently changing relocation and remounting
  // the dependent basecamp question. It looked like Workday rewriting our answer; it was us mis-clicking.
  // fillDropdownCdp has gated on options-GONE since 2026-07-06; the AI commit paths never did.
  const act = makeFakeAct([aiDd()], { aiEnabled: true, ai: '{"choice":"No","confidence":"High"}' });
  // closeDropdownConfirmed gates on the LISTBOX being gone, re-pressing Escape each round — so the
  // observable signature is an Escape after the commit click.
  // Model the hazard itself: after the commit the listbox LINGERS for one read, still holding clickable
  // options (a few reads, since the commit poll consumes some). A fake that closes instantly would let a missing gate pass.
  const seq = [];
  let committed = false, lingered = 0;
  const realRead = act.readDropdownState;
  act.readDropdownState = async (l) => {
    const st = await realRead(l);
    if (committed && lingered < 4) { lingered++; return Object.assign({}, st, { listboxPresent: true, optionCount: 3 }); }
    return st;
  };
  const realEsc = act.pressEscape;
  act.pressEscape = async (...a) => { seq.push("escape"); return realEsc ? realEsc(...a) : undefined; };
  const realClick = act.clickDropdownOptionByText;
  act.clickDropdownOptionByText = async (...a) => { committed = true; seq.push("commit"); return realClick(...a); };
  const rec = (await drivePageFill(act, {}, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(rec.status, "filled_review", rec.detail);
  assert.strictEqual(rec.after, "No");
  const c = seq.indexOf("commit");
  assert.ok(c >= 0, "it committed: " + JSON.stringify(seq));
  assert.ok(seq.indexOf("escape", c) > c,
    "the AI commit must confirm the list is GONE after committing, before the next field: " + JSON.stringify(seq));
});

test("a DETERMINISTIC field that cannot match the live options still reaches the AI", async () => {
  // Operator's question: the batch planner EXCLUDES fields a deterministic tier owns, so they are never
  // in the batched call. If such a field then opens and finds its value is not among the live options,
  // does it still get AI help? It must -- otherwise excluding it from the batch would silently downgrade
  // it to blank. The batch is a CACHE, not a GATE: the field simply makes its own per-field call.
  const f = { wrapperSel: "[w-x]", fieldName: "country", widgetType: "dropdown", isRequired: true,
    label: "Country*", triggerText: "Select One",
    options: [{ text: "Select One", disabled: true }, { text: "United States of America (+1)" }, { text: "Canada" }] };
  // FIELD_MAP maps `country` -> personal_info.country. A stated value that matches NO live option.
  const profile = { personal_info: { country: "Freedonia" } };
  // The planner says this field is deterministic, so it is NOT batched…
  assert.strictEqual(deterministicTierFor(f, profile, null, null), "field-map");
  assert.deepStrictEqual(planAiBatchCandidates([f], profile, null, null, null), []);
  // …and yet the fill still gets AI help, via the CANONICALIZE path (a stated value, mapped to the vocab).
  const act = makeFakeAct([f], { aiEnabled: true, ai: '{"choice":"United States of America (+1)","confidence":"High"}' });
  const rec = (await drivePageFill(act, profile, {}, {}, AI_BATCH_BUDGETS)).results[0];
  assert.ok(act.log.some(([m]) => m === "llm"), "it must call the model per-field: " + rec.detail);
  assert.strictEqual(rec.status, "filled_review", rec.detail);
  assert.strictEqual(rec.after, "United States of America (+1)");
  assert.strictEqual(rec.flag, "ai-canonicalized", "a STATED value maps vocabulary; it is never re-inferred");
});

test("AI batch: ONE candidate costs ZERO page contact (the count gate)", async () => {
  // Live on waystar page 5: a single candidate (disabilityForm). The old collector opened it to read
  // options — 333ms — and only then found it could not fire a batch of one. Candidacy is decidable
  // without touching the page, so the count gate is checked FIRST.
  const act = makeFakeAct([aiDd2("only", "Pick one*")], { aiEnabled: true, ai: '{"choice":"Yes","confidence":"High"}' });
  const out = await drivePageFill(act, {}, {}, {}, AI_BATCH_BUDGETS);
  const rc = out.aiBatchInfo.recon;
  assert.strictEqual(rc.planned, 1, "it is a candidate…");
  assert.strictEqual(rc.opened, 0, "…but nothing was opened for a batch that cannot fire");
  assert.match(rc.dropped.join(" "), /fewer than 2/);
  assert.strictEqual(out.results.find((r) => r.fieldName === "only").after, "Yes", "and it still fills, per-field");
});

test("AI batch: opens ONLY the candidates that need options, and reports the count", async () => {
  // The recon line is the check the operator makes against what they see on screen: infer fields open
  // (twice overall — once here read-only, once to commit), everything else opens zero extra times.
  const act = makeFakeAct([aiDd2("q1", "Pick one*"), aiDd2("q2", "Pick two*")],
    { aiEnabled: true, ai: JSON.stringify({ answers: [{ id: "q1", choice: "Yes", confidence: "High" },
                                                      { id: "q2", choice: "No", confidence: "High" }] }) });
  const out = await drivePageFill(act, {}, {}, {}, AI_BATCH_BUDGETS);
  const rc = out.aiBatchInfo.recon;
  assert.strictEqual(rc.planned, 2);
  assert.strictEqual(rc.needOpen, 2, "both infer candidates need live options");
  assert.strictEqual(rc.opened, 2, "and exactly those two were opened — no others");
  assert.deepStrictEqual(rc.openFailed, [], "and no read-only close left a value behind");
});

test("AI batch: a STATED value is never a batch candidate (canonicalize is not batched)", async () => {
  // Batching a canonicalize needs its option list, and the only sources are an extra open per mapped
  // dropdown (measured a net loss) or a cross-run cache, which does not exist in the real fill-once flow.
  // So a mapped field with a stated value must never enter the plan, whatever its value's type.
  const fields = [{ wrapperSel: "[w-num]", fieldName: "postalCode", widgetType: "dropdown", isRequired: true, label: "Postal Code" }];
  assert.deepStrictEqual(planAiBatchCandidates(fields, { personal_info: { postal_code: 30301 } }), [],
    "a NUMERIC stated value is skipped — and resolve()'s {candidates} shape must not reach the ladder as an object");
  assert.deepStrictEqual(planAiBatchCandidates(fields, { personal_info: { postal_code: "30301" } }), [],
    "same for a string");
});

test("AI batch: an unanswerable REQUIRED dropdown IS a candidate, and needs its options", async () => {
  const plan = planAiBatchCandidates(
    [{ wrapperSel: "[w-q]", fieldName: "some_screening_q", widgetType: "dropdown", isRequired: true, label: "Do you consent?*" }], {});
  assert.strictEqual(plan.length, 1);
  assert.strictEqual(plan[0].kind, "infer");
  assert.strictEqual(plan[0].needsOpen, true, "infer is the one kind that costs an open");
});

test("AI batch: an OPTIONAL unmapped dropdown is never a candidate (optional stays deterministic-or-blank)", async () => {
  assert.deepStrictEqual(planAiBatchCandidates(
    [{ wrapperSel: "[w-o]", fieldName: "opt_q", widgetType: "dropdown", isRequired: false, label: "Optional?" }], []), []);
});

test("AI batch: a NON-STRING profile value must not abort the page's whole batch", async () => {
  // Live regression, found only because the [AI-BATCH] log line existed: the collector threw
  // `s.toLowerCase is not a function` on a mapped dropdown whose profile value was a NUMBER, and because
  // the guard only wrapped the open/close, collection aborted at field 1 — 0 candidates, batch never
  // fired, every question fell back to a per-field call. Indistinguishable from "the feature does
  // nothing", which is how the operator spotted it on the page.
  // postalCode IS in FIELD_MAP, so a NUMERIC postal code reaches the match ladder directly.
  const numeric = { wrapperSel: "[w-num]", fieldName: "postalCode", widgetType: "dropdown", isRequired: false,
    label: "Postal Code", triggerText: "Select One", options: [{ text: "Select One", disabled: true }, { text: "30301" }] };
  const act = makeFakeAct([numeric, aiDd2("q1", "Pick one*"), aiDd2("q2", "Pick two*")],
    { aiEnabled: true, ai: JSON.stringify({ answers: [{ id: "q1", choice: "Yes", confidence: "High" },
                                                      { id: "q2", choice: "No", confidence: "High" }] }) });
  // A warm option cache is what routes a stated value straight into the ladder with no open.
  const out = await drivePageFill(act, { personal_info: { postal_code: 30301 } }, {}, {}, AI_BATCH_BUDGETS);
  assert.strictEqual(act.log.filter(([m]) => m === "llm").length, 1,
    "the two good questions still batch into ONE call despite the numeric field");
  assert.strictEqual(out.results.find((r) => r.fieldName === "q1").after, "Yes");
  assert.strictEqual(out.results.find((r) => r.fieldName === "q2").after, "No");
  assert.strictEqual(out.aiBatchInfo.candidates, 2, "the two AI questions were collected");
  assert.strictEqual(out.aiBatchInfo.served, 2, "and both were served from the batch, not per-field");
  assert.strictEqual(out.aiBatchInfo.error, null, "collection completed — no page-wide abort");
});

test("AI commit uses the ADAPTIVE beat, not the never-scaled delayFull (the slow-AI-fill bug)", async () => {
  // Operator, watching a page: the pre-pass flew and then the AI fields filled visibly slower than the
  // deterministic ones. Cause: aiFillField hand-rolled its commit as two flat delayFull(reopenSettleMs)
  // beats — 800ms per field regardless of paint state, and no poll — while a deterministic pick used the
  // adaptive, read-first, poll-to-ceiling path. An AI pick is a candidate like any other and must commit
  // like one. delayFull is reserved for waits that must ALWAYS be real (the M40 settle); a commit poll
  // is not one of them, because its persistence re-read is what makes it safe, not the beat length.
  const act = makeFakeAct([aiDd()], { aiEnabled: true, ai: '{"choice":"No","confidence":"High"}' });
  const fullWaits = [];
  const realFull = act.delayFull;
  act.delayFull = async (ms) => { fullWaits.push(ms); return realFull ? realFull(ms) : undefined; };
  const rec = (await drivePageFill(act, {}, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(rec.status, "filled_review", rec.detail);
  assert.strictEqual(rec.after, "No");
  // The old commit spent reopenSettleMs on delayFull TWICE (click-beat + persistence-beat). The shared
  // poll spends it ZERO times — it uses the adaptive delayRender instead. Counting is what distinguishes
  // them, since other machinery legitimately uses delayFull elsewhere in the page.
  const settleBeats = fullWaits.filter((ms) => ms === T_BUDGETS.reopenSettleMs).length;
  assert.ok(settleBeats < 2,
    `the AI commit must not spend the never-scaled reopenSettle beats (saw ${settleBeats}): ` + JSON.stringify(fullWaits));
});

test("AI commit still REFUSES a pick that does not persist (the shared poll keeps the safety gate)", async () => {
  // The speed fix must not weaken the false-verify guard: a pick shown for one read and then discarded
  // is NOT a commit, however fast the beats are.
  const act = makeFakeAct([aiDd({ revertsAfterCommit: true, revertValue: "Select One" })],
    { aiEnabled: true, ai: '{"choice":"No","confidence":"High"}' });
  const rec = (await drivePageFill(act, {}, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(rec.status, "needs_review", "a momentary pick is never reported filled");
  assert.strictEqual(rec.flag, "ai-commit-failed");
  assert.notStrictEqual(rec.after, "No");
});

test("AI batch: aiBatchInfo reports what actually happened (the observability that found the bug)", async () => {
  const act = makeFakeAct([aiDd2("q1", "Pick one*"), aiDd2("q2", "Pick two*")],
    { aiEnabled: true, ai: JSON.stringify({ answers: [{ id: "q1", choice: "Yes", confidence: "High" }] }) });
  const out = await drivePageFill(act, {}, {}, {}, AI_BATCH_BUDGETS);
  const ab = out.aiBatchInfo;
  assert.strictEqual(ab.candidates, 2);
  assert.strictEqual(ab.fired, true);
  assert.strictEqual(ab.answers, 1, "only one answer came back");
  assert.strictEqual(ab.served, 1);
  assert.strictEqual(ab.fellBack, 1, "the uncovered question is COUNTED, so a silent no-op is visible");
});

test("AI batch: a batch that FAILS entirely still answers every question per-field", async () => {
  const act = makeFakeAct([aiDd2("q1", "Pick one*"), aiDd2("q2", "Pick two*")],
    { aiEnabled: true, ai: [{ ok: false, error: "429 exhausted" },      // the batched call fails
                            '{"choice":"Yes","confidence":"High"}', '{"choice":"No","confidence":"High"}'] });
  const out = await drivePageFill(act, {}, {}, {}, AI_BATCH_BUDGETS);
  assert.strictEqual(out.results.find((r) => r.fieldName === "q1").after, "Yes", "a dead batch costs speed, never an answer");
  assert.strictEqual(out.results.find((r) => r.fieldName === "q2").after, "No");
});

test("AI batch: the option scan leaves every candidate dropdown BLANK (read-only pre-pass)", async () => {
  const act = makeFakeAct([aiDd2("q1", "Pick one*"), aiDd2("q2", "Pick two*")],
    { aiEnabled: true, ai: JSON.stringify({ answers: [{ id: "q1", choice: "Yes", confidence: "High" },
                                                      { id: "q2", choice: "No", confidence: "High" }] }) });
  await drivePageFill(act, {}, {}, {}, AI_BATCH_BUDGETS);
  // Exactly one commit per field: the pre-pass must never have armed or committed an option itself.
  const clicks = act.log.filter(([m]) => m === "clickDropdownOptionByText");
  assert.strictEqual(clicks.length, 2, "one commit per field — the read-only scan committed nothing: " + JSON.stringify(clicks));
});

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

test("Buckets M4 piggyback: the fill AI's maps_to + suggested_category ride the record → the bundle entry (one call, no 2nd)", async () => {
  const act = makeFakeAct([aiDd({ label: "Are you legally authorized to work in the US?*" })], { aiEnabled: true,
    ai: '{"choice":"Yes","justification":"work_authorization says authorized","confidence":"High","maps_to":"work_authorization.authorized_to_work_in_us","suggested_category":"Work authorization"}' });
  const out = await drivePageFill(act, {}, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.after, "Yes");
  assert.strictEqual(rec.maps_to, "work_authorization.authorized_to_work_in_us", "the profile-field hint is carried on the record");
  assert.strictEqual(rec.suggested_category, "Work authorization");
  const e = buildReviewBundle(out.results, {}).entries[0];
  assert.strictEqual(e.maps_to, "work_authorization.authorized_to_work_in_us", "the hint reaches the review bundle (→ report → teach page)");
  assert.strictEqual(e.suggested_category, "Work authorization");
});

test("Buckets M4 piggyback: maps_to 'none' normalizes to \"\" (the teach card starts at 'is this in your profile?')", async () => {
  const act = makeFakeAct([aiDd({ label: "Do you own a reliable vehicle?" })], { aiEnabled: true,
    ai: '{"choice":"Yes","confidence":"Medium","maps_to":"none","suggested_category":"Screening"}' });
  const rec = (await drivePageFill(act, {}, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(rec.maps_to, "", "'none' → empty (no field hint)");
  assert.strictEqual(rec.suggested_category, "Screening");
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

// ── AI-1 on a PREFILLED dropdown (Workday restores prior answers on a re-run) ─
// The 2026-07-02 page-3 bug: a 503-failed AI call on a prefilled screening dropdown reported
// after:null → the summary showed an EMPTY field while the page held the answer. Every
// no-commit exit must surface the live kept value (current_value = rec.after in the bundle).

test("AI fallback on a PREFILLED dropdown: a FAILED LLM call reports the live kept value, never after:null (the 503 summary-masking bug)", async () => {
  const act = makeFakeAct([aiDd({ triggerText: "No" })], { aiEnabled: true,
    ai: { ok: false, error: "HTTP 503: high demand (gave up after 3 attempts)" } });
  const out = await drivePageFill(act, {}, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "needs_review", "an unverified AI question still needs human eyes");
  assert.strictEqual(rec.flag, "ai-call-failed", "unchanged value → not a stray");
  assert.strictEqual(rec.after, "No", "the live PREFILLED value — the page truth, not a false blank");
  assert.match(rec.detail, /HTTP 503/, "the LLM error (incl. its attempts note) is in the detail");
  assert.match(rec.detail, /already held "No" \(prefilled\) — KEPT/, "the reviewer is told the value was already on the page");
  assert.ok(!act.log.some(([m]) => m === "clickDropdownOptionByText"), "no commit — nothing was actuated");
  const e = buildReviewBundle(out.results, {}).entries[0];
  assert.strictEqual(e.current_value, "No", "the summary SHOWS the prefilled value");
  assert.strictEqual(e.needs_review, true);
});

test("AI fallback on a BLANK dropdown: a FAILED LLM call stays after:null ('Select One' is the placeholder, not a value — regression pin)", async () => {
  const act = makeFakeAct([aiDd()], { aiEnabled: true, ai: { ok: false, error: "HTTP 503: high demand" } });
  const rec = (await drivePageFill(act, {}, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.flag, "ai-call-failed");
  assert.strictEqual(rec.after, null, "genuinely blank — the placeholder never masquerades as a kept value");
  assert.ok(!/prefilled/.test(rec.detail), "no kept-prefill note on a blank field");
});

test("AI fallback on a PREFILLED dropdown: a no-match reply ALSO reports the kept prefilled value", async () => {
  const act = makeFakeAct([aiDd({ triggerText: "Yes" })], { aiEnabled: true, ai: '{"choice":"UNKNOWN","justification":"no basis","confidence":"Low"}' });
  const rec = (await drivePageFill(act, {}, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(rec.flag, "ai-nomatch");
  assert.strictEqual(rec.after, "Yes", "the kept prefill is surfaced, not a false blank");
  assert.match(rec.detail, /already held "Yes" \(prefilled\)/);
});

test("AI fallback on a PREFILLED dropdown: a successful pick that REPLACES the prefill names it in the detail (provenance)", async () => {
  const act = makeFakeAct([aiDd({ triggerText: "Yes" })], { aiEnabled: true, ai: '{"choice":"No","justification":"basis","confidence":"High"}' });
  const rec = (await drivePageFill(act, {}, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(rec.status, "filled_review");
  assert.strictEqual(rec.after, "No");
  assert.match(rec.detail, /overwrote prefilled "Yes"/, "the replaced prior answer is visible to the reviewer");
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
  assert.deepStrictEqual(parseAiReply('{"choice":"Yes","justification":"j","confidence":"High"}'), { choice: "Yes", justification: "j", confidence: "high", maps_to: "", suggested_category: "" });
  assert.strictEqual(parseAiReply('```json\n{"choice":"No","confidence":"Low"}\n```').choice, "No");
  assert.strictEqual(parseAiReply('Here is my answer: {"choice":"Maybe","confidence":"Medium"}').confidence, "medium");
  assert.strictEqual(parseAiReply('{"choice":"X","confidence":"bogus"}').confidence, "low", "unknown confidence → low");
  const fb = parseAiReply("just No"); assert.strictEqual(fb.choice, "just No"); assert.strictEqual(fb.confidence, "low");
  // piggyback (teach flow): maps_to + suggested_category parsed; "none" → ""
  const pg = parseAiReply('{"choice":"Yes","maps_to":"work_authorization.authorized_to_work_in_us","suggested_category":"Work authorization"}');
  assert.strictEqual(pg.maps_to, "work_authorization.authorized_to_work_in_us"); assert.strictEqual(pg.suggested_category, "Work authorization");
  assert.strictEqual(parseAiReply('{"choice":"Y","maps_to":"none"}').maps_to, "", "'none' → empty");
});

// ── AI-2: free-text / essay fill (fake act.llm) ──────────────────────────────
const GEN_ON = { autofill_rules: { generation_allowed_only_for: ["application_questions.open_ended"] }, application_questions: { writing_style: "plain professional first person" } };
const aiText = (flags) => Object.assign({
  wrapperSel: "[w-essay]", fieldName: "whyUs", widgetType: "text", isRequired: true, label: "Why do you want to work here?", value: ""
}, flags || {});

test("parseAiText: {answer}, {skip,reason}, bare SKIP, ```-fenced, and non-JSON → whole reply is the answer", () => {
  assert.deepStrictEqual(parseAiText('{"answer":"I admire the mission."}'), { skip: false, answer: "I admire the mission.", reason: "", maps_to: "", suggested_category: "" });
  assert.deepStrictEqual(parseAiText('{"skip":true,"reason":"asks for an ID"}'), { skip: true, answer: "", reason: "asks for an ID" });
  assert.strictEqual(parseAiText('{"answer":"5 years","maps_to":"screening.years_of_experience_total","suggested_category":"Screening"}').maps_to, "screening.years_of_experience_total"); // piggyback
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

test("AI-2 PRINCIPLE: a REQUIRED field the AI SKIPs → a submittable N/A, never blank (walk advances; submit still hard-blocks)", async () => {
  const act = makeFakeAct([aiText({ isRequired: true })], { aiEnabled: true, ai: '{"skip":true,"reason":"asks for a specific employee ID"}' });
  const rec = (await drivePageFill(act, GEN_ON, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(rec.status, "filled_review", "non-blank so the walk advances");
  assert.strictEqual(rec.flag, "ai-text-needs-answer");
  // A REAL, submittable answer: machine jargon must never reach an employer's form, and Workday
  // REJECTS a bracketed marker in a constrained field — live 2026-08-02 a required "desired Annual
  // Salary" box blocked Save & Continue on two tenants and the walk halted short of review.
  assert.strictEqual(String(rec.after).trim(), "N/A", "a submittable answer, not machine jargon");
  // …and it is STILL hard-blocked at submit: the block keys on the FLAG plus an untouched value,
  // now that the value itself is innocuous.
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

test("FIELD_MAP: preferredCheck → has_preferred_name — true CHECKS it; false OR null/unanswered UNCHECKS it", async () => {
  const prefField = (flags) => Object.assign({ wrapperSel: "[w-pref]", fieldName: "preferredCheck", widgetType: "checkbox", isRequired: false, label: "I have a preferred name", inputId: "pc-1" }, flags || {});
  // has_preferred_name:true → the optional checkbox reconciles to CHECKED (which reveals the preferred first/last fields on the live page → the cascade re-scan then fills them once mapped).
  const onF = prefField({ checked: false });
  const onRec = (await drivePageFill(makeFakeAct([onF]), { personal_info: { has_preferred_name: true } }, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(onRec.status, "filled");
  assert.strictEqual(onF.checked, true, "mapped + true → box checked");
  // has_preferred_name:false → reconciles to UNCHECKED (no reveal). Mapped, so not 'skipped: no mapping'.
  const offF = prefField({ checked: true });
  await drivePageFill(makeFakeAct([offF]), { personal_info: { has_preferred_name: false } }, {}, {}, T_BUDGETS);
  assert.strictEqual(offF.checked, false, "mapped + false → box unchecked");
  // has_preferred_name UNANSWERED (null / never toggled) → STILL unchecks a pre-checked form box. A
  // checkbox has no "unanswered" state on the form; the profile is authoritative. (2026-07-16 bug: a null
  // value used to SKIP → a box left checked by the account / a prior run never unchecked.)
  const nullF = prefField({ checked: true });
  const nullRec = (await drivePageFill(makeFakeAct([nullF]), { personal_info: {} }, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(nullF.checked, false, "mapped + null/unanswered → box unchecked (not skipped)");
  assert.strictEqual(nullRec.status, "filled");
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
  // radio stays OUT of aiEligible on purpose — a REQUIRED radio gets AI via its OWN post-pass
  // (aiFillRadio), exactly like typeaheads, NOT through this dropdown/text gate.
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

test("source: a DETERMINISTIC NON-EXACT match (containment) STAYS filled_review (flagged) — only an EXACT resolution is confident", async () => {
  // Type "LinkedIn"; Workday autocommits a COMPOUND option that only CONTAINS it → containment tier.
  // Source is graded like any choice widget: a non-exact match is a guess → filled_review, surfaced for
  // review. (operator rule 2026-07-20: "deterministic non-exact matches should still be review".)
  const act = makeFakeAct([
    srcField({ wrapperSel: "[w-src]", filterMap: { LinkedIn: { autoCommit: "Social Networking Site (LinkedIn)" } } })
  ]);
  const defaults = { how_did_you_hear: { preferred: ["LinkedIn"], fallback: "Other" } };
  const out = await drivePageFill(act, nameProfile, defaults, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.after, "Social Networking Site (LinkedIn)", "Workday resolved the typed candidate to a compound option (containment)");
  assert.strictEqual(rec.status, "filled_review", "a non-exact (containment) source match is a guess → flagged");
  const e = buildReviewBundle(out.results, { page: "p1" }).entries[0];
  assert.strictEqual(e.needs_review, true, "surfaced for review");
});

test("source: an EXACT match on a LATER ladder candidate → filled, NOT flagged (earlier options absent)", async () => {
  // Ladder [Handshake, GitHub]: Handshake isn't offered (no-match banner) → fall through to GitHub, which
  // EXACT-matches. An exact match commits `filled` regardless of ladder POSITION (commitOutcome grades by
  // tier, not order) → not surfaced for review. (operator rule 2026-07-20)
  const act = makeFakeAct([
    srcField({ wrapperSel: "[w-src]", filterMap: { Handshake: { banner: true }, GitHub: { autoCommit: "GitHub" } } })
  ]);
  const defaults = { how_did_you_hear: { preferred: ["Handshake", "GitHub"], fallback: "Other" } };
  const out = await drivePageFill(act, nameProfile, defaults, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.after, "GitHub", "fell through the absent earlier candidate to the one that exists");
  assert.strictEqual(rec.status, "filled", "an EXACT match commits filled at ANY ladder position");
  const e = buildReviewBundle(out.results, { page: "p1" }).entries[0];
  assert.strictEqual(e.needs_review, false, "a deterministic EXACT source fill is not flagged");
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

// ── keptLowerTier resting: Tab-close, NO re-commit (operator speed rule 2026-07-02) ─────────────
// The pre-fill IS the answer and is ALREADY committed — the walk-end just Tab-closes and verifies
// the chip. The old re-type/Enter/affirmative-click re-commit is retired: Tab abandons any armed
// row WITHOUT committing (the exit-redesign model, live-proven), so the re-commit was a wasted
// ~4-round-trip sequence. The post-Tab chip read is the stray-backstop.
// Field: pre-filled tier-1 "Other"; cand-0 "X" no-matches (0 options).
const reField = (flags) => taField(Object.assign({ chips: ["Other"], filterMap: { "X": { filtered: [] } } }, flags || {}));

test("keptLowerTier: Tab-close keeps the chip — NO re-type, NO Enter, NO click after the walk", async () => {
  // Even with the empty-results focus drop (the old re-commit's hard case) — irrelevant now,
  // nothing is typed after the walk.
  const act = makeFakeAct([reField({ dropsFocusAfterEmpty: true })]);
  const out = await drivePageFill(act, taProfile(["X", "Other"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "Other");
  assert.strictEqual(rec.flag, "prefilled-better-tier-unavailable");
  assert.deepStrictEqual(taTypedQueries(act), ["X"], "ONLY the higher-tier candidate was ever typed — no re-commit re-type");
  assert.strictEqual(enters(act), 1, "only cand-0's filter-Enter — the exit never pressed Enter");
  assert.ok(!act.log.some(([m]) => m === "clickHierLeaf"), "no affirmative click — nothing to re-commit");
  assert.ok(act.log.some(([m]) => m === "pressTab"), "closed via Tab");
});

// The stray-backstop and the vanished-chip honesty, unit-direct on the resting fn (the fake has no
// hook to mutate chips ON the Tab itself).
test("keptLowerTier resting STRAY-BACKSTOP: post-Tab chip differs → needs_review/overwrite-stray with the HONEST live after", async () => {
  const act = { pressTab: async () => {} };
  const rest = await overwriteNoMatchResting(act, { wrapperSel: "[w]" }, async () => ({ chips: ["Accounting"] }), ["Other"], [], null, T_BUDGETS, true);
  assert.strictEqual(rest.status, "needs_review");
  assert.strictEqual(rest.flag, "overwrite-stray");
  assert.strictEqual(rest.after, "Accounting", "HONEST live value, never a false 'Other'");
});

test("keptLowerTier resting: post-Tab chip GONE → needs_review, never a false 'kept'", async () => {
  const act = { pressTab: async () => {} };
  const rest = await overwriteNoMatchResting(act, { wrapperSel: "[w]" }, async () => ({ chips: [] }), ["Other"], [], null, T_BUDGETS, true);
  assert.strictEqual(rest.status, "needs_review");
  assert.strictEqual(rest.after, null);
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
  // Phase 2: the AI must be CONFIDENT (High/Med) for the entry to be KEPT — a low-confidence pick now
  // feeds the delete-with-memory decision (D2). "Biology" is represented AND High confidence → kept.
  const state = { prefix: "education-", addable: true, deletable: true, aiEnabled: true, ai: '{"choice":"Biology","represented":true,"confidence":"High"}', newEntry: (i) => eduEntry("education-new" + i), entries: [eduEntry("education-0--null")] };
  const act = makeFakeRepeatAct(state);
  const out = await driveRepeatingSectionCdp(act, { name: "education", headingRegex: "education", containerPrefix: "education-", items, fieldMap, deleteOnNoMatch: false, aiContext: { profile: {}, jobContext: {} } }, T_BUDGETS);
  const fos = out.results.find((r) => r.fieldName === "education[0].fieldOfStudy");
  assert.strictEqual(fos.status, "filled_review", "a required empty section typeahead is CONFIDENTLY AI-filled, not skipped");
  assert.strictEqual(fos.after, "Biology");
  assert.ok(!out.results.some((r) => r.widgetType === "removed_entry"), "a confident AI fill KEEPS the entry (not delete-with-memory)");
});

// ── Tenant-variable section fields: id alternates + WIDGET-ADAPTIVE fill (2026-07-25) ──────────
// Live break (cat.wd5/solarturbines): education "School or University" is neither `schoolName` NOR a
// text box — it's a multiselect TYPEAHEAD under a different id, so the single hardcoded id resolved
// nothing ("field wrapper not found in entry"), no fill ran, and the required field blocked Save &
// Continue. Two mechanisms fix it: altFields/labelFallback resolution, and the live DOM's widget winning.
const SCHOOL_FM = [{ field: "schoolName", altFields: ["school"], labelFallback: /school|university/i,
  widget: "text", key: "school_or_university", path: "school_or_university" }];

test("section field: an ALT automation-id resolves the wrapper (tenant renamed schoolName → school)", async () => {
  const entry = (fkit) => ({ fkit, fields: [{ fieldName: "school", widgetType: "text", isRequired: true, label: "School or University" }] });
  const act = makeFakeRepeatAct({ prefix: "education-", addable: true, deletable: true, newEntry: (i) => entry("education-new" + i), entries: [entry("education-0--null")] });
  const out = await driveRepeatingSectionCdp(act, { name: "education", headingRegex: "education", containerPrefix: "education-",
    items: [{ school_or_university: "Carnegie Mellon University" }], fieldMap: SCHOOL_FM, deleteOnNoMatch: false }, T_BUDGETS);
  const rec = out.results.find((r) => r.fieldName === "education[0].schoolName");
  assert.strictEqual(rec.status, "filled", "resolved via altFields — NOT 'field wrapper not found in entry'");
  assert.strictEqual(rec.after, "Carnegie Mellon University");
});

test("section field: LABEL fallback resolves a wrapper whose id matches no alternate", async () => {
  const entry = (fkit) => ({ fkit, fields: [{ fieldName: "e7f3a91c0000", widgetType: "text", isRequired: true, label: "School or University" }] });
  const act = makeFakeRepeatAct({ prefix: "education-", addable: true, deletable: true, newEntry: (i) => entry("education-new" + i), entries: [entry("education-0--null")] });
  const out = await driveRepeatingSectionCdp(act, { name: "education", headingRegex: "education", containerPrefix: "education-",
    items: [{ school_or_university: "Carnegie Mellon University" }], fieldMap: SCHOOL_FM, deleteOnNoMatch: false }, T_BUDGETS);
  const rec = out.results.find((r) => r.fieldName === "education[0].schoolName");
  assert.strictEqual(rec.status, "filled", "hashed/unknown id resolved by the label fallback");
  assert.strictEqual(rec.after, "Carnegie Mellon University");
});

test("section field: the LIVE widget WINS — a text-mapped field the tenant renders as a TYPEAHEAD fills through the typeahead ladder", async () => {
  const entry = (fkit) => ({ fkit, fields: [{ fieldName: "school", widgetType: "typeahead", isRequired: true, label: "School or University",
    chips: [], scrapeOptions: ["Carnegie Mellon University", "MIT"], filterMap: { "Carnegie Mellon University": { autoCommit: "Carnegie Mellon University" } } }] });
  const act = makeFakeRepeatAct({ prefix: "education-", addable: true, deletable: true, newEntry: (i) => entry("education-new" + i), entries: [entry("education-0--null")] });
  const out = await driveRepeatingSectionCdp(act, { name: "education", headingRegex: "education", containerPrefix: "education-",
    items: [{ school_or_university: "Carnegie Mellon University" }], fieldMap: SCHOOL_FM, deleteOnNoMatch: false }, T_BUDGETS);
  const rec = out.results.find((r) => r.fieldName === "education[0].schoolName");
  assert.strictEqual(rec.status, "filled", "filled as a typeahead even though the map says text");
  assert.strictEqual(rec.after, "Carnegie Mellon University");
  assert.strictEqual(rec.widgetType, "typeahead", "the record reports the LIVE widget (review renders the right editor)");
  assert.deepStrictEqual(rec.widgetAdapted, { configured: "text", live: "typeahead" }, "the swap is recorded");
});

test("section field: a matching map widget is NEVER swapped (no adaptation when config and live agree)", async () => {
  const entry = (fkit) => ({ fkit, fields: [{ fieldName: "schoolName", widgetType: "text", isRequired: true, label: "School or University" }] });
  const act = makeFakeRepeatAct({ prefix: "education-", addable: true, deletable: true, newEntry: (i) => entry("education-new" + i), entries: [entry("education-0--null")] });
  const out = await driveRepeatingSectionCdp(act, { name: "education", headingRegex: "education", containerPrefix: "education-",
    items: [{ school_or_university: "Carnegie Mellon University" }], fieldMap: SCHOOL_FM, deleteOnNoMatch: false }, T_BUDGETS);
  const rec = out.results.find((r) => r.fieldName === "education[0].schoolName");
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.widgetType, "text");
  assert.strictEqual(rec.widgetAdapted, undefined, "no swap recorded when the live DOM agrees with the map");
});

test("section field: a labelFallback NEVER steals a field another map entry names by id", async () => {
  // "Field of Study" must go to the fieldOfStudy entry, not to school's /school|university/i fallback —
  // and school's own field still resolves. Guards the two-pass (ids first) resolution.
  const entry = (fkit) => ({ fkit, fields: [
    { fieldName: "fieldOfStudy", widgetType: "text", isRequired: false, label: "Field of Study" },
    { fieldName: "someHashedId", widgetType: "text", isRequired: true, label: "School or University" }
  ] });
  const fm = [SCHOOL_FM[0], { field: "fieldOfStudy", widget: "text", key: "fos", path: "field_of_study" }];
  const act = makeFakeRepeatAct({ prefix: "education-", addable: true, deletable: true, newEntry: (i) => entry("education-new" + i), entries: [entry("education-0--null")] });
  const out = await driveRepeatingSectionCdp(act, { name: "education", headingRegex: "education", containerPrefix: "education-",
    items: [{ school_or_university: "Carnegie Mellon University", fos: "Electrical Engineering" }], fieldMap: fm, deleteOnNoMatch: false }, T_BUDGETS);
  assert.strictEqual(out.results.find((r) => r.fieldName === "education[0].schoolName").after, "Carnegie Mellon University");
  assert.strictEqual(out.results.find((r) => r.fieldName === "education[0].fieldOfStudy").after, "Electrical Engineering");
});

// ── PER-ENTRY answer buckets in a repeating section (2026-07-25, operator's design) ────────────
// The same wording appears in EVERY entry, so the bucket identifies WHICH FIELD and the entry ORDINAL
// picks WHICH VALUE: entry 0 → education[0]'s school, entry 1 → education[1]'s. Only fires for entry
// fields the fieldMap does NOT claim.
const SCHOOL_BUCKET = { questions: ["School or University"], profile_path: "education.0.school_or_university" };
const eduBucketEntry = (fkit, fieldName) => ({ fkit, fields: [{ fieldName: fieldName || "someForeignId", widgetType: "text", isRequired: true, label: "School or University" }] });

test("repeating bucket: an UNMAPPED entry field fills from its WORDING + that ENTRY's own value (ordinal picks the value)", async () => {
  const state = { prefix: "education-", addable: true, deletable: true,
    newEntry: (i) => eduBucketEntry("education-new" + i), entries: [eduBucketEntry("education-0--null"), eduBucketEntry("education-1--null")] };
  const act = makeFakeRepeatAct(state);
  const out = await driveRepeatingSectionCdp(act, {
    name: "education", headingRegex: "education", containerPrefix: "education-", itemsKey: "education",
    items: [{ school_or_university: "Carnegie Mellon University" }, { school_or_university: "Florida State University" }],
    fieldMap: [{ field: "degree", widget: "dropdown", key: "degree", path: "degree" }], // school NOT in the map
    deleteOnNoMatch: false, buckets: buildBucketIndex([SCHOOL_BUCKET])
  }, T_BUDGETS);
  const e0 = out.results.find((r) => r.fieldName === "education[0].someForeignId");
  const e1 = out.results.find((r) => r.fieldName === "education[1].someForeignId");
  assert.strictEqual(e0.after, "Carnegie Mellon University", "entry 0 got entry 0's value");
  assert.strictEqual(e1.after, "Florida State University", "entry 1 got ENTRY 1's value — not a repeat of entry 0");
  assert.strictEqual(e0.flag, "bucket");
  assert.strictEqual(e0.mappedPath, "education[0].school_or_university");
});

test("repeating bucket: a bucket from ANOTHER section never fires inside this one", async () => {
  const act = makeFakeRepeatAct({ prefix: "education-", addable: true, deletable: true,
    newEntry: (i) => eduBucketEntry("education-new" + i), entries: [eduBucketEntry("education-0--null")] });
  const foreign = { questions: ["School or University"], profile_path: "work_experience.0.company" }; // wrong root
  const out = await driveRepeatingSectionCdp(act, {
    name: "education", headingRegex: "education", containerPrefix: "education-", itemsKey: "education",
    items: [{ school_or_university: "Carnegie Mellon University", company: "SHOULD NOT FILL" }],
    fieldMap: [], deleteOnNoMatch: false, buckets: buildBucketIndex([foreign])
  }, T_BUDGETS);
  assert.ok(!out.results.some((r) => r.after === "SHOULD NOT FILL"), "a work_experience-bound bucket must never fill an education entry");
});

test("repeating bucket: Mode B (fixed value, no profile_path) does NOT fire per-entry (no indexed data = a guess)", async () => {
  const act = makeFakeRepeatAct({ prefix: "education-", addable: true, deletable: true,
    newEntry: (i) => eduBucketEntry("education-new" + i), entries: [eduBucketEntry("education-0--null"), eduBucketEntry("education-1--null")] });
  const modeB = { questions: ["School or University"], value: ["Some Fixed School"] };
  const out = await driveRepeatingSectionCdp(act, {
    name: "education", headingRegex: "education", containerPrefix: "education-", itemsKey: "education",
    items: [{}, {}], fieldMap: [], deleteOnNoMatch: false, buckets: buildBucketIndex([modeB])
  }, T_BUDGETS);
  assert.ok(!out.results.some((r) => r.after === "Some Fixed School"), "Mode B would fill every entry identically → not applied per-entry");
});

test("repeating bucket: NEVER double-fills a field the fieldMap already filled", async () => {
  const entry = (fkit) => ({ fkit, fields: [{ fieldName: "schoolName", widgetType: "text", isRequired: true, label: "School or University" }] });
  const act = makeFakeRepeatAct({ prefix: "education-", addable: true, deletable: true, newEntry: (i) => entry("education-new" + i), entries: [entry("education-0--null")] });
  const out = await driveRepeatingSectionCdp(act, {
    name: "education", headingRegex: "education", containerPrefix: "education-", itemsKey: "education",
    items: [{ school_or_university: "Carnegie Mellon University" }],
    fieldMap: [{ field: "schoolName", widget: "text", key: "school_or_university", path: "school_or_university" }],
    deleteOnNoMatch: false, buckets: buildBucketIndex([SCHOOL_BUCKET])
  }, T_BUDGETS);
  const hits = out.results.filter((r) => r.after === "Carnegie Mellon University");
  assert.strictEqual(hits.length, 1, "exactly one record — the mapped fill; the bucket tier skipped the claimed field");
  assert.notStrictEqual(hits[0].flag, "bucket", "the mapped fill is NOT re-flagged as a bucket fill");
});

test("sweep: a TENANT-RENAMED section field this run FILLED is not re-surfaced as 'already on the form' (no duplicate row)", async () => {
  // Live (Solar Turbines): education[0].schoolName filled correctly (autocommit-exact) and the sweep then
  // pushed a SECOND record education[0].school — filled_review "already on the form (unmapped section
  // field) — NOT filled by ApplyPilot" — because its join keyed on the map's id, which this tenant renamed.
  const entry = (fkit) => ({ fkit, fields: [{ fieldName: "school", widgetType: "text", isRequired: true, label: "School or University", value: "" }] });
  const state = { prefix: "education-", addable: true, deletable: true, newEntry: (i) => entry("education-new" + i), entries: [entry("education-0--null")] };
  const act = makeFakeRepeatAct(state);
  const out = await driveRepeatingSectionCdp(act, {
    name: "education", headingRegex: "education", containerPrefix: "education-", itemsKey: "education",
    items: [{ school_or_university: "Carnegie Mellon University" }], fieldMap: SCHOOL_FM, deleteOnNoMatch: false
  }, T_BUDGETS);
  // the section fill happens inside driveRepeatingSectionCdp; run the page-level sweep over its records
  const results = out.results.slice();
  await sweepAlreadyFilled(act, results);
  const schoolRecs = results.filter((r) => /^education\[0\]\.(school|schoolName)$/.test(r.fieldName));
  assert.strictEqual(schoolRecs.length, 1, "exactly ONE record for the school field — no duplicate sweep row");
  assert.strictEqual(schoolRecs[0].fieldName, "education[0].schoolName");
  assert.notStrictEqual(schoolRecs[0].flag, "already-filled", "the field this run filled is not re-flagged as someone else's value");
  assert.notStrictEqual(schoolRecs[0].status, "filled_review");
});

test("repeating bucket: no buckets configured ⇒ the tier is inert (byte-identical to the pre-bucket fill)", async () => {
  const act = makeFakeRepeatAct({ prefix: "education-", addable: true, deletable: true,
    newEntry: (i) => eduBucketEntry("education-new" + i), entries: [eduBucketEntry("education-0--null")] });
  const out = await driveRepeatingSectionCdp(act, {
    name: "education", headingRegex: "education", containerPrefix: "education-", itemsKey: "education",
    items: [{ school_or_university: "Carnegie Mellon University" }], fieldMap: [], deleteOnNoMatch: false
  }, T_BUDGETS);
  assert.ok(!out.results.some((r) => r.flag === "bucket"), "no bucket index → no bucket fills");
});

// ── CHECKBOX GROUP (pick-one checkbox set — Caterpillar's OFCCP disability self-ID, 2026-07-25) ──
// Several checkboxes in ONE wrapper acting like radios; the tenant refuses a second check while one
// is set, so the filler must UNCHECK the current option first. Options are read from the DOM by the
// SCAN (no actuation), so even a field left BLANK carries them → the review renders a real picker.
const SELFID_OPTS = [
  "Yes, I have a disability, or have had one in the past",
  "No, I do not have a disability and have not had one in the past",
  "I do not want to answer"
];
const selfIdField = (over = {}) => Object.assign({
  wrapperSel: "[w-selfid]", fieldName: "disabilityStatus", widgetType: "checkbox_group",
  label: "Please check one of the boxes below:",
  options: SELFID_OPTS.map((t, i) => ({ id: "cb" + i, labelText: t, checked: false })),
  groupOptions: SELFID_OPTS.map((t, i) => ({ id: "cb" + i, labelText: t, checked: false }))
}, over);

test("checkbox group: an UNMAPPED (voluntary self-ID) group is left BLANK but still carries its OPTIONS for review", async () => {
  const act = makeFakeAct([selfIdField()]);
  const out = await drivePageFill(act, {}, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "skipped", "a voluntary self-ID question is the OPERATOR's to answer — never auto-answered");
  assert.deepStrictEqual(rec.options, SELFID_OPTS, "options ride the record so review renders a picker, not a textbox");
  assert.ok(!act.log.some(([m]) => m === "clickRadioLabel"), "ZERO actuation on the blank group");
});

test("checkbox group: a MAPPED value checks the matching option (label-exact) and verifies exactly one is set", async () => {
  const field = selfIdField({ fieldName: "gender" }); // any mapped field name; FIELD_MAP.gender → self_identification.gender
  field.options = [{ id: "m", labelText: "Male", checked: false }, { id: "f", labelText: "Female", checked: false }];
  field.groupOptions = field.options.map((o) => ({ ...o }));
  const act = makeFakeAct([field]);
  const out = await drivePageFill(act, { self_identification: { gender: "Male" } }, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "Male");
  assert.strictEqual(rec.matchTier, "label-exact");
  assert.strictEqual(field.options.filter((o) => o.checked).length, 1, "exactly ONE option ends checked");
});

// ── PERSISTENCE RE-READ: Workday REBUILDS the widget after a verified fill (live waystar 2026-08-04) ──
// The click lands and verifies, then the widget is rebuilt and comes back EMPTY. The dropdown commit has
// always guarded this ("a momentary pick discarded on render-complete is never reported filled"); the
// checkbox group reported `filled` off a read taken microseconds after the click, so the walk banked a
// success and clicked Save & Continue into a page Workday then refused.
// initial opts + pre-click readBack + the post-quiescence RE-RESOLVE read + post-click readBack
const PRE_LOOP_READS = [null, null, null, null];
const genderGroup = (rebuildScript) => {
  const field = selfIdField({ fieldName: "gender" });
  field.options = [{ id: "m", labelText: "Male", checked: false }, { id: "f", labelText: "Female", checked: false }];
  field.groupOptions = field.options.map((o) => ({ ...o }));
  if (rebuildScript) field.rebuildScript = rebuildScript;
  return field;
};

test("checkbox group quiescence: the DOM is waited on BEFORE the first click, never after", async () => {
  // Ordering is the whole point: a gate checked after the click guards nothing.
  const field = genderGroup();
  const act = makeFakeAct([field]);
  await drivePageFill(act, { self_identification: { gender: "Male" } }, {}, {}, T_BUDGETS);
  const seq = act.log.map(([m]) => m);
  const q = seq.indexOf("awaitQuiet"), c = seq.indexOf("clickRadioLabel");
  assert.ok(q >= 0, "the quiescence gate ran: " + JSON.stringify(seq.slice(0, 8)));
  assert.ok(q < c, `awaitQuiet must precede the click (got awaitQuiet@${q}, click@${c})`);
});

test("checkbox group quiescence: ids RE-ISSUED during the wait are re-resolved, so the click still lands", async () => {
  // The regression the gate itself introduced, live: ids are read, we wait up to 3s, then click by id —
  // and a rebuild during that wait leaves label[for=<stale id>] absent, so NO click is dispatched at all
  // and the commit "fails". The label is the stable identity, so re-resolve by text after waiting.
  const field = genderGroup();
  const act = makeFakeAct([field]);
  const realQuiet = act.awaitQuiet;
  act.awaitQuiet = async (loc, opts) => {
    // rebuild DURING the wait: same labels, brand-new ids (what a React remount does)
    field.options = field.options.map((o) => ({ ...o, id: o.id + "-v2" }));
    field.groupOptions = field.options.map((o) => ({ ...o }));
    return realQuiet(loc, opts);
  };
  const out = await drivePageFill(act, { self_identification: { gender: "Male" } }, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled", "must still commit after the ids changed: " + rec.detail);
  assert.strictEqual(rec.after, "Male");
  const clicked = act.log.filter(([m]) => m === "clickRadioLabel").map(([, id]) => id);
  assert.ok(clicked.includes("m-v2"), "clicked the RE-ISSUED id, not the stale one: " + JSON.stringify(clicked));
});

test("checkbox group: a commit failure says whether a click was even DISPATCHED", async () => {
  // Live run 8: "did not commit" with no way to tell whether we clicked and it was ignored, or never
  // clicked at all — because clickRadioLabel's return value was thrown away. Those need opposite fixes.
  const field = genderGroup();
  const act = makeFakeAct([field]);
  act.clickRadioLabel = async () => false;            // no layout rect ⇒ nothing dispatched
  const out = await drivePageFill(act, { self_identification: { gender: "Male" } }, {}, {}, T_BUDGETS);
  assert.strictEqual(out.results[0].status, "needs_review");
  assert.match(out.results[0].detail, /NO CLICK WAS DISPATCHED/, out.results[0].detail);
});

test("checkbox group: a commit failure names what the click actually landed on", async () => {
  const field = genderGroup();
  const act = makeFakeAct([field]);
  act.clickRadioLabel = async () => ({ ok: true, cx: 524, cy: 299,
    hit: { hit: "DIV#overlay", text: "", mine: false } });   // landed somewhere else
  const out = await drivePageFill(act, { self_identification: { gender: "Male" } }, {}, {}, T_BUDGETS);
  assert.strictEqual(out.results[0].status, "needs_review");
  assert.match(out.results[0].detail, /NOT our label, the rect went stale/, out.results[0].detail);
  assert.match(out.results[0].detail, /DIV#overlay/);
});

test("checkbox group quiescence: a page that never goes quiet still gets clicked (never hangs)", async () => {
  const field = genderGroup();
  field.quietNever = true;
  const act = makeFakeAct([field]);
  const out = await drivePageFill(act, { self_identification: { gender: "Male" } }, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled", "the ceiling must not block the fill");
  assert.strictEqual(rec.after, "Male");
  assert.match(rec.detail, /CEILING — clicked while still busy/, "and it says it went ahead un-quiet: " + rec.detail);
});

test("checkbox group quiescence: a substrate without awaitQuiet still fills (older/other substrates)", async () => {
  const field = genderGroup();
  const act = makeFakeAct([field]);
  delete act.awaitQuiet;
  const out = await drivePageFill(act, { self_identification: { gender: "Male" } }, {}, {}, T_BUDGETS);
  assert.strictEqual(out.results[0].status, "filled");
  assert.strictEqual(out.results[0].after, "Male");
});

test("checkbox group persistence: a rebuild that comes back UNCHECKED is re-filled, not reported filled", async () => {
  // read #1 = the post-click verify (normal), then the widget is rebuilt with everything cleared.
  const field = genderGroup([...PRE_LOOP_READS, "cleared"]);
  const act = makeFakeAct([field]);
  const out = await drivePageFill(act, { self_identification: { gender: "Male" } }, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled", "re-filled and confirmed: " + rec.detail);
  assert.strictEqual(rec.after, "Male");
  assert.strictEqual(rec.flag, "checkbox-group-refilled");
  assert.match(rec.detail, /rebuild/i);
  assert.strictEqual(field.options.filter((o) => o.checked).length, 1, "exactly ONE ends checked on the form");
});

test("checkbox group persistence: a rebuild that KEEPS losing it ends needs_review, never a false filled", async () => {
  const field = genderGroup([...PRE_LOOP_READS]);
  field.rebuildAlways = "cleared";          // never sticks, however many rounds the loop runs
  const act = makeFakeAct([field]);
  const out = await drivePageFill(act, { self_identification: { gender: "Male" } }, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "needs_review", "a value that will not stick must reach review");
  assert.strictEqual(rec.flag, "checkbox-group-rebuilt");
  assert.match(rec.detail, /rebuilt/i);
});

test("checkbox group persistence: unreadable to the end (wrapper gone) is needs_review, not filled", async () => {
  // The exact live signature: readCheckboxGroup returns null (wrapper missing) — "could not re-read".
  const field = genderGroup([...PRE_LOOP_READS]);
  field.rebuildAlways = "gone";
  const act = makeFakeAct([field]);
  const out = await drivePageFill(act, { self_identification: { gender: "Male" } }, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.flag, "checkbox-group-rebuilt");
  assert.match(rec.detail, /never became readable/i);
});

test("checkbox group persistence: a healthy group EXITS on the hold streak, it does not burn every round", async () => {
  // The cost bug (2026-08-05): the loop `continue`d on success instead of breaking, so a group with
  // nothing wrong with it always paid every round — ~2.1s at the old 3x700ms, twice on a two-group page.
  // Pinned via the READ COUNT rather than wall-clock so it cannot pass by the beat merely being shorter:
  // with a ceiling of 8 rounds and a 2-read streak, a healthy group must read the group exactly twice
  // inside the loop. The pre-fix code ignores the streak entirely and reads 8 times.
  const field = genderGroup();
  const act = makeFakeAct([field]);
  let loopReads = 0;
  const real = act.readCheckboxGroup;
  act.readCheckboxGroup = async (loc) => { loopReads++; return real(loc); };
  const out = await drivePageFill(act, { self_identification: { gender: "Male" } }, {}, {},
    { ...T_BUDGETS, groupPersistMs: 1, groupPersistRounds: 8, groupPersistHolds: 2 });
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled", rec.detail);
  assert.strictEqual(rec.after, "Male");
  // 4 pre-loop reads (options, pre-click, post-quiescence re-resolve, post-click verify)
  // + 2 loop reads (the streak) + 1 final fresh read + 1 M40 audit re-read = 8.
  // Burning all 8 rounds instead of stopping at the streak would be 14.
  assert.strictEqual(loopReads, 8, `must stop at the streak, not the ceiling (saw ${loopReads} reads)`);
  assert.match(rec.detail, /held 2 consecutive reads/, rec.detail);
});

test("checkbox group persistence: a BROKEN streak restarts, so the early exit can never fire on a timer", async () => {
  // The early exit is only safe because it rests on consecutive evidence. A beat that comes back cleared
  // (re-filled) or unreadable must reset the count, or "held N reads" would be a claim about elapsed time.
  const field = genderGroup([...PRE_LOOP_READS, null, "cleared"]); // hold, then LOSE it, then hold again
  const act = makeFakeAct([field]);
  let loopReads = 0;
  const real = act.readCheckboxGroup;
  act.readCheckboxGroup = async (loc) => { loopReads++; return real(loc); };
  const out = await drivePageFill(act, { self_identification: { gender: "Male" } }, {}, {},
    { ...T_BUDGETS, groupPersistMs: 1, groupPersistRounds: 8, groupPersistHolds: 2 });
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled", rec.detail);
  assert.strictEqual(rec.flag, "checkbox-group-refilled", "the loss was seen and re-filled");
  // The one hold before the loss must NOT count toward the streak that ends the loop.
  assert.ok(loopReads > 7, `the broken streak must have restarted the count (saw ${loopReads} reads)`);
  assert.match(rec.detail, /held 2 consecutive reads/, rec.detail);
});

test("checkbox group persistence: a transient unreadable beat that comes back CHECKED still passes clean", async () => {
  // A rebuild we merely observed mid-flight must not be punished — the value survived it.
  const field = genderGroup([...PRE_LOOP_READS, "empty"]);
  const act = makeFakeAct([field]);
  const out = await drivePageFill(act, { self_identification: { gender: "Male" } }, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "Male");
  assert.notStrictEqual(rec.flag, "checkbox-group-rebuilt");
  assert.match(rec.detail, /persistence-confirmed/);
});

test("checkbox group: replacing a checked option UNCHECKS the current one first (the tenant refuses a second check)", async () => {
  const field = selfIdField({ fieldName: "gender" });
  field.options = [{ id: "m", labelText: "Male", checked: false }, { id: "f", labelText: "Female", checked: true }];
  field.groupOptions = field.options.map((o) => ({ ...o }));
  const act = makeFakeAct([field]);
  const out = await drivePageFill(act, { self_identification: { gender: "Male" } }, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled", "committed despite the tenant's uncheck-first rule");
  assert.strictEqual(rec.after, "Male");
  assert.deepStrictEqual(field.options.map((o) => o.checked), [true, false], "the prior option was unchecked, the target checked");
  const clicks = act.log.filter(([m]) => m === "clickRadioLabel").map(([, id]) => id);
  assert.deepStrictEqual(clicks, ["f", "m"], "uncheck the current option BEFORE checking the target");
});

test("checkbox group: no candidate matches the labels → needs_review, ZERO actuation (never a guessed self-ID answer)", async () => {
  const field = selfIdField({ fieldName: "gender" });
  field.options = [{ id: "a", labelText: "Male", checked: false }, { id: "b", labelText: "Female", checked: false }];
  field.groupOptions = field.options.map((o) => ({ ...o }));
  const act = makeFakeAct([field]);
  const out = await drivePageFill(act, { self_identification: { gender: "Nonbinary" } }, {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.ok(!field.options.some((o) => o.checked), "nothing was checked");
});

test("checkbox group: replayField (SUBMIT) sets the approved option through the same pick-one handler", async () => {
  const field = selfIdField({ wrapperSel: '[data-automation-id="formField-disabilityStatus"]' }); // replayField derives the selector from field_id
  field.options = [{ id: "y", labelText: SELFID_OPTS[0], checked: false }, { id: "n", labelText: SELFID_OPTS[1], checked: true }];
  const act = makeFakeAct([field]);
  const entry = { widget_type: "checkbox_group", current_value: SELFID_OPTS[0], field_id: "p::formField-disabilityStatus", canonical_field: "disabilityStatus" };
  const r = await replayField(act, entry, T_BUDGETS);
  assert.strictEqual(r.status, "filled", "the approved self-ID answer replays");
  assert.strictEqual(r.after, SELFID_OPTS[0]);
  assert.deepStrictEqual(field.options.map((o) => o.checked), [true, false]);
});

// ── REVIEW ORDER: form order, sections interleaved with flat fields (operator, 2026-07-25) ──
test("review order: a flat field BETWEEN two repeating sections stays between them (not hoisted above both)", () => {
  // Production order: all flat records first, then section-by-section. Page layout: phone (0),
  // workExperience (1..), "howDidYouHear" (10), education (11..), websites (20..).
  const scanFields = [{ fieldName: "phoneNumber", domIndex: 0 }, { fieldName: "howDidYouHear", domIndex: 10 }];
  const sectionOrder = { workExperience: 1, education: 11, webAddress: 20 };
  const results = [
    { fieldName: "phoneNumber" }, { fieldName: "howDidYouHear" },          // flat (produced first)
    { fieldName: "workExperience.add" }, { fieldName: "workExperience[0].jobTitle" }, { fieldName: "workExperience[1].jobTitle" },
    { fieldName: "education.add" }, { fieldName: "education[0].degree" },
    { fieldName: "website.add" }, { fieldName: "website[0].url" }          // section name "website" ≠ fkit base "webAddress"
  ];
  orderResultsByDom(results, scanFields, sectionOrder);
  assert.deepStrictEqual(results.map((r) => r.fieldName), [
    "phoneNumber",
    "workExperience.add", "workExperience[0].jobTitle", "workExperience[1].jobTitle",
    "howDidYouHear",                                                        // BETWEEN the sections, as on the form
    "education.add", "education[0].degree",
    "website.add", "website[0].url"
  ]);
});

test("review order: a section's own records keep their fill order (stable), and unpositioned records stay with their group", () => {
  const scanFields = [{ fieldName: "firstName", domIndex: 0 }];
  const sectionOrder = { education: 5 };
  const results = [
    { fieldName: "firstName" },
    { fieldName: "education.add" },
    { fieldName: "education[0].schoolName" },
    { fieldName: "education[0].degree" },
    { fieldName: "education[0].__note" },        // no position → inherits the previous key
    { fieldName: "education[1].schoolName" }
  ];
  const before = results.map((r) => r.fieldName);
  orderResultsByDom(results, scanFields, sectionOrder);
  assert.deepStrictEqual(results.map((r) => r.fieldName), before, "already in form order → unchanged (stable)");
});

test("review order: no scan positions ⇒ order is left exactly as produced (never scrambles)", () => {
  const results = [{ fieldName: "a" }, { fieldName: "b" }, { fieldName: "c" }];
  orderResultsByDom(results, [], {});
  assert.deepStrictEqual(results.map((r) => r.fieldName), ["a", "b", "c"]);
});

// ── PRE-SCRAPE SHORT-CIRCUIT (operator, 2026-07-25) ────────────────────────────────────────────
// The start-scrape already has the widget's whole option list, so a candidate that provably isn't in
// it must NOT be typed just to discover that. Gated on a COMPLETE scrape (atBottom, not capped).
test("typeahead short-circuit: candidates ABSENT from the complete scraped list are never typed", async () => {
  const act = makeFakeAct([taField({
    scrapeOptions: ["Accounting", "Biology", "Electrical Engineering"],
    filterMap: { "Electrical Engineering": { autoCommit: "Electrical Engineering" } }
  })]);
  const out = await drivePageFill(act, taProfile(["Electrical and Computer Engineering", "Electrical Engineering"]), {}, {}, T_BUDGETS);
  const typed = act.log.filter(([m]) => m === "typeInHier").map(([, t]) => t);
  assert.deepStrictEqual(typed, ["Electrical Engineering"], "only the candidate that IS in the list was typed");
  assert.strictEqual(out.results[0].status, "filled");
  assert.strictEqual(out.results[0].after, "Electrical Engineering");
});

test("typeahead short-circuit: NO candidate in the complete list → zero typing, straight to the AI rescue", async () => {
  const act = makeFakeAct([taField({
    isRequired: true,
    scrapeOptions: ["Accounting", "Biology"],
    filterMap: { "Biology": { autoCommit: "Biology" } }
  })], { aiEnabled: true, ai: '{"choice":"Biology","represented":true,"confidence":"High"}' });
  const out = await drivePageFill(act, taProfile(["Underwater Basket Weaving"]), {}, {}, T_BUDGETS);
  const typed = act.log.filter(([m]) => m === "typeInHier").map(([, t]) => t);
  assert.ok(!typed.includes("Underwater Basket Weaving"), "the absent candidate was never typed");
  assert.ok(act.log.some(([m]) => m === "llm"), "went straight to the AI rescue");
  assert.strictEqual(out.results[0].status, "filled_review");
  assert.strictEqual(out.results[0].after, "Biology");
});

test("typeahead short-circuit: an INCOMPLETE scrape (never reached the bottom) still walks the FULL ladder", async () => {
  // A partial list cannot prove absence — the candidate must still be typed (the server may filter to it).
  const act = makeFakeAct([taField({
    scrapeNotAtBottom: true,
    scrapeOptions: ["Accounting", "Biology"],
    filterMap: { "Zoology": { autoCommit: "Zoology" } }
  })]);
  const out = await drivePageFill(act, taProfile(["Zoology"]), {}, {}, T_BUDGETS);
  const typed = act.log.filter(([m]) => m === "typeInHier").map(([, t]) => t);
  assert.deepStrictEqual(typed, ["Zoology"], "typed despite being absent from the PARTIAL scrape");
  assert.strictEqual(out.results[0].status, "filled", "and it committed — no regression on server-filtered lists");
});

// ── ORPHAN CONSENT CHECKBOX (outside any formField wrapper) — Caterpillar's page-1 SMS consent ──
test("orphan consent checkbox: inventoried for review, left UNCHECKED, zero actuation", async () => {
  const act = makeFakeAct([{ wrapperSel: "[w-fn]", fieldName: "legalName--firstName", widgetType: "text", value: "" }]);
  const SMS = "I consent to receive periodic automated text messages … I understand that my consent is not required.";
  act.scanOrphanCheckboxes = async () => [{ key: "smsConsent", inputId: "smsConsent", selector: "input#smsConsent", checked: false, required: false, label: SMS }];
  const out = await drivePageFill(act, { personal_info: { first_name: "Kevin" } }, {}, {}, T_BUDGETS);
  const rec = out.results.find((r) => r.fieldName === "consent.smsConsent");
  assert.ok(rec, "the orphan consent checkbox reaches the review records");
  assert.strictEqual(rec.flag, "consent-checkbox");
  assert.strictEqual(rec.status, "skipped", "OPTIONAL + unchecked is the correct resting state — visible, but NOT a review item");
  assert.strictEqual(rec.label, SMS);
  assert.ok(!act.log.some(([m]) => m === "clickCheckboxLabel"), "never actuated");
  const bundle = buildReviewBundle(out.results, { page: "p1", url: "u", tenant: "t", capturedAt: "now" });
  const be = bundle.entries.find((e) => String(e.field_id).includes("consent.smsConsent"));
  assert.ok(be, "reaches the bundle (ALL FIELDS)");
  assert.strictEqual(be.needs_review, false, "does NOT nag in NEEDS REVIEW (operator: it's optional)");
});

test("orphan consent checkbox: one ALREADY checked by the tenant is surfaced for verification, not silently kept", async () => {
  const act = makeFakeAct([{ wrapperSel: "[w-fn]", fieldName: "legalName--firstName", widgetType: "text", value: "" }]);
  act.scanOrphanCheckboxes = async () => [{ key: "marketing", checked: true, required: false, label: "Send me marketing emails" }];
  const out = await drivePageFill(act, { personal_info: { first_name: "Kevin" } }, {}, {}, T_BUDGETS);
  const rec = out.results.find((r) => r.fieldName === "consent.marketing");
  assert.strictEqual(rec.status, "filled_review");
  assert.strictEqual(rec.after, "true");
});

test("orphan consent checkbox: a REQUIRED one left unchecked IS a review item (it blocks Save & Continue)", async () => {
  const act = makeFakeAct([{ wrapperSel: "[w-fn]", fieldName: "legalName--firstName", widgetType: "text", value: "" }]);
  act.scanOrphanCheckboxes = async () => [{ key: "mustAgree", checked: false, required: true, label: "I agree to the terms" }];
  const out = await drivePageFill(act, { personal_info: { first_name: "Kevin" } }, {}, {}, T_BUDGETS);
  const rec = out.results.find((r) => r.fieldName === "consent.mustAgree");
  assert.strictEqual(rec.status, "needs_review");
  const bundle = buildReviewBundle(out.results, { page: "p1", url: "u", tenant: "t", capturedAt: "now" });
  const be = bundle.entries.find((e) => String(e.field_id).includes("consent.mustAgree"));
  assert.ok(be, "the required consent reaches the bundle");
  assert.strictEqual(be.needs_review, true, "a REQUIRED unchecked consent must surface — it blocks the page");
});

test("orphan consent checkbox: absent substrate / none on the page ⇒ no records (inert)", async () => {
  const act = makeFakeAct([{ wrapperSel: "[w-fn]", fieldName: "legalName--firstName", widgetType: "text", value: "" }]);
  const out = await drivePageFill(act, { personal_info: { first_name: "Kevin" } }, {}, {}, T_BUDGETS);
  assert.ok(!out.results.some((r) => r.flag === "consent-checkbox"));
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

test("countryPhoneCode pre-filled-correct → kept, chip never re-typed/cleared (read-only recon aside)", async () => {
  // Workday auto-derives the phone code from Country, so an already-correct chip is the common case.
  // The failure mode is "verifying" it by re-typing — duplicating or clearing a correct chip. The FILL
  // does none of that. (2026-07-05: the end-of-page read-only option capture re-opens it to scrape
  // options for the review editor — no type/clear/Enter/leaf-click — chip preserved + M40-audited.)
  const act = makeFakeAct([taField({ chips: ["United States of America (+1)"] })]);
  const out = await drivePageFill(act, taProfile(["United States of America (+1)", "United States of America", "United States"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.matchTier, "pre-filled");
  assert.strictEqual(rec.flag, "prefilled-kept");
  assert.strictEqual(rec.after, "United States of America (+1)");
  assert.strictEqual(rec.verified, true);
  for (const bad of ["typeInHier", "clearHierSearch", "pressEnter", "clickHierLeaf", "typeText", "insertText"])
    assert.ok(!act.log.some(([m]) => m === bad), "pre-filled-correct must not be mutated — no " + bad);
});

// ── M27 Commit B: non-destructive overwrite of a mismatched pre-fill ─────────
// (Replaces the old "left as-is, zero actuation" pinned test — a mismatched
// pre-fill now ACTUATES: search-while-populated, commit REPLACES, no-match keeps
// the original. The behavior change is intentional and sanctioned by M27.)

test("overwrite: mismatched pre-fill + EXACT matching candidate → filled (deterministic, no review) / overwrite-success, original recorded, single chip (REPLACE)", async () => {
  const field = taField({ chips: ["Canada (+1)"], filterMap: { "United States of America (+1)": { autoCommit: "United States of America (+1)" } } });
  const act = makeFakeAct([field]);
  const out = await drivePageFill(act, taProfile(["United States of America (+1)"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled"); // EXACT overwrite is deterministic → no review (only a non-exact overwrite is filled_review)
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

test('INVARIANT (M36.1): a tier-0 pre-fill is KEPT and never re-typed — countryPhoneCode auto-derive is never mutated', async () => {
  // The chip carries the (+1) suffix; normalize() strips it, so it is tier 0 vs the tiered candidate
  // list — keep, the FILL does no clear/type/Enter/leaf-click. (2026-07-05: the end-of-page read-only
  // option capture re-opens it to scrape options for the review editor — value-preserving, M40-audited
  // — so the invariant is "never MUTATED", not the old literal "never opened".)
  const act = makeFakeAct([taField({ chips: ["United States of America (+1)"] })]);
  const out = await drivePageFill(act, taProfile(["United States of America (+1)", "United States of America", "United States"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.flag, "prefilled-kept");
  assert.strictEqual(rec.after, "United States of America (+1)");
  for (const bad of ["typeInHier", "clearHierSearch", "pressEnter", "clickHierLeaf", "typeText", "insertText"])
    assert.ok(!act.log.some(([m]) => m === bad), "a tier-0 (top) pre-fill must never be mutated — no " + bad);
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
  assert.strictEqual(rec.status, "filled"); // EXACT-match overwrite → deterministic, no review
  assert.strictEqual(rec.flag, "overwrite-success");
  assert.strictEqual(rec.after, "Other", "the HIGHEST offered tier, NOT tier-2 'computer engineering'");
  assert.deepStrictEqual(rec.overwrite, { original: "electrical engineering", refilled: true });
  // priority order proven: tried tier-0 then tier-1, STOPPED (tier-2 never typed); the
  // pre-fill's own tier-3 is NEVER re-searched.
  assert.deepStrictEqual(taTypedQueries(act), ["Electrical and Computer Engineering", "Other"]);
});

test("M36.1 typeahead k>0: nothing higher offered → KEEP the pre-fill, Tab-close (prefilled-better-tier-unavailable)", async () => {
  // Pre-fill = tier-1 "Other"; tier-0 NOT offered → "Other" is the best available AND is ALREADY
  // committed → Tab-close + chip verify, no re-commit (operator speed rule 2026-07-02; Tab abandons
  // any armed row without committing — the exit-redesign model).
  const field = taField({
    chips: ["Other"],
    filterMap: { "Electrical and Computer Engineering": { banner: true } } // tier-0 not offered
  });
  const act = makeFakeAct([field]);
  const out = await drivePageFill(act, taProfile(["Electrical and Computer Engineering", "Other", "computer engineering"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.flag, "prefilled-better-tier-unavailable");
  assert.strictEqual(rec.after, "Other", "the kept tier — untouched");
  assert.deepStrictEqual(field.chips, ["Other"], "chip never re-typed or re-committed");
  assert.deepStrictEqual(taTypedQueries(act), ["Electrical and Computer Engineering"], "ONLY the higher tier searched — no re-commit re-type");
  assert.ok(act.log.some(([m]) => m === "pressTab"), "closed via Tab");
});

test("INVARIANT: keptLowerTier (k>0) NEVER goes to the AI — deterministic keep even with AI ON (zero LLM calls)", async () => {
  // Live 2026-07-02: FoS pre-filled "Electrical Engineering" (tier 1 of the profile list) + a
  // tier-0-only upgrade no-match handed the exit to the inline AI, which re-picked the SAME value
  // and re-flagged it ai-choice/filled_review. The kept chip EXACT-matches a lower PROFILE tier —
  // a STATED value, nothing to rescue: the deterministic keep must win and act.llm must never fire.
  const field = taField({
    chips: ["Other"],
    filterMap: { "Electrical and Computer Engineering": { banner: true }, "Other": { autoCommit: "Other" } }
  });
  const act = makeFakeAct([field], { aiEnabled: true, ai: '{"choice":"Other","represented":true,"confidence":"High"}' });
  const out = await drivePageFill(act, taProfile(["Electrical and Computer Engineering", "Other", "computer engineering"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.flag, "prefilled-better-tier-unavailable", "deterministic keep — not an AI record");
  assert.strictEqual(rec.after, "Other");
  assert.ok(!act.log.some((l) => l[0] === "llm"), "act.llm NEVER called on a keptLowerTier exit");
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
  assert.strictEqual(rec.status, "filled"); // EXACT-match overwrite → deterministic, no review
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
  // overwrite: an EXACT overwrite is a deterministic profile match → FILLED (no review), like an exact
  // empty-field fill; a NON-exact overwrite (containment/fuzzy) is a GUESS that replaced a real value →
  // filled_review. The flag stays overwrite-* in EVERY case (the precedence invariant below).
  assert.deepStrictEqual(commitOutcome(true, "auto", "exact-normalized"), { status: "filled", confidence: "high", flag: "overwrite-success" });
  assert.deepStrictEqual(commitOutcome(true, "directed", "exact-normalized"), { status: "filled", confidence: "high", flag: "overwrite-success" });
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

test("typeahead DIRECTED containment REMOVED (2026-07-16): an unambiguous list-contain no longer self-commits → escalates", async () => {
  // WAS: "United States" filtered to ONE containing option → we clicked it (directed-containment). NOW a
  // DIRECTED pick never containment-matches — ApplyPilot only trusts Workday's OWN autocommit, or an exact/
  // typo match. So this escalates (→ the inline AI rescue for a REQUIRED field; here, no AI → genuine
  // no-match). The AUTOCOMMIT-containment path is unchanged (see the auto-commit test above).
  const act = makeFakeAct([taField({ filterMap: { "United States": { filtered: ["United States of America (+1)", "Canada (+1)"] } } })]);
  const out = await drivePageFill(act, taProfile(["United States"]), {}, {}, T_BUDGETS);
  const rec = out.results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.genuineNoMatch, true);
  assert.strictEqual(rec.after, null); // the containing option was NOT self-committed
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

test("source overwrite: mismatched pre-fill + EXACT matching candidate → filled (deterministic, no review) / overwrite-success (lockstep with typeahead)", async () => {
  const field = srcField({ chips: ["Family"], filterMap: { LinkedIn: { autoCommit: "LinkedIn" } } });
  const { rec } = await runSource(field, ["LinkedIn"]);
  assert.strictEqual(rec.status, "filled"); // EXACT-match overwrite → deterministic, no review
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
  assert.strictEqual(rec.status, "filled"); // EXACT-match overwrite → deterministic, no review
  assert.strictEqual(rec.flag, "overwrite-success");
  assert.strictEqual(rec.after, "LinkedIn", "the HIGHEST offered tier, NOT tier-1 'Other'");
  assert.deepStrictEqual(rec.overwrite, { original: "Friend", refilled: true });
  assert.deepStrictEqual(srcTypedQueries(act), ["LinkedIn"], "stopped at the highest offered; tier-1/own tier never searched");
});

test("M36.1 source k>0: nothing higher offered → KEEP the pre-fill, Tab-close (prefilled-better-tier-unavailable, lockstep)", async () => {
  const field = srcField({ chips: ["Other"], filterMap: { LinkedIn: { banner: true } } }); // tier-0 not offered
  const { rec, act } = await runSource(field, ["LinkedIn", "Other"]);
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.flag, "prefilled-better-tier-unavailable");
  assert.strictEqual(rec.after, "Other", "the kept tier — untouched");
  assert.deepStrictEqual(field.chips, ["Other"], "chip never re-typed or re-committed");
  assert.deepStrictEqual(srcTypedQueries(act), ["LinkedIn"], "ONLY the higher tier searched — no re-commit re-type (lockstep with typeahead)");
  assert.ok(act.log.some(([m]) => m === "pressTab"), "closed via Tab (lockstep)");
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
  // Nested (cert ▸ Specialties) seams — INERT unless state.nestedEnabled. parentOrder maps the section
  // name → surviving parent fkit indices (one per entry, idx = 700+ordinal); children tracked in _nkids
  // keyed by that fkit index. Off ⇒ nestedScan returns empty ⇒ the wire's pIdx is null ⇒ no fill call
  // (every existing nested test — stub-only emit — byte-identical).
  let _nkids = state.nestedKids ? Object.assign({}, state.nestedKids) : {}, _nnext = 900; // nestedKids = PRE-SEEDED orphan children ({ pIdx: [childIdx…] })
  const _secName = state.prefix ? state.prefix.replace(/-$/, "") : "certification";
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
    // nested (cert ▸ Specialties) — see the _nkids note above.
    nestedScan: async () => {
      if (!state.nestedEnabled) return { parentOrder: {}, nestedSections: [] };
      const order = state.entries.map((_, i) => 700 + i);
      const nestedSections = [];
      order.forEach((pIdx) => {
        const kids = _nkids[pIdx] || [];
        if (kids.length) nestedSections.push({ parentBase: _secName, childBase: "specialties",
          entries: kids.map((ci) => ({ levels: [{ base: _secName, index: pIdx }, { base: "specialties", index: ci }], fields: [] })) });
      });
      const parentOrder = {}; parentOrder[_secName] = order;
      return { parentOrder, nestedSections };
    },
    clickNestedAdd: async (pf, stem) => { log.push(["clickNestedAdd", pf, stem]); const m = /-(\d+)--/.exec(pf || ""); const pIdx = m ? +m[1] : 700; (_nkids[pIdx] = _nkids[pIdx] || []).push(_nnext++); return { ok: true }; },
    clickNestedDelete: async (pf, base, idx) => { log.push(["clickNestedDelete", pf, idx]); const m = /-(\d+)--/.exec(pf || ""); const pIdx = m ? +m[1] : 700; _nkids[pIdx] = (_nkids[pIdx] || []).filter((c) => String(c) !== String(idx)); return { ok: true }; },
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
        ariaExpanded: open ? "true" : "false", // model the real DOM signal openAndReadDropdown gates on (AI readers)
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

test("section_stub review flag keys off section_known: a KNOWN (profile-defined) empty section does NOT nag; an UNKNOWN one does", () => {
  // operator rule 2026-07-20: an empty cert/language/WE/education/websites section is the user's own
  // choice (the profile models it) → still shows in ALL FIELDS (addable) but is NOT a needs_review item.
  const known = [{ fieldName: "certification", label: "Certification — section present, no entries",
    widgetType: "section_stub", isRequired: false, mappedPath: "certification._stub",
    status: "skipped", flag: "section-stub", after: null, section_known: true,
    detail: "no meaningful certification entries to fill — the section is on the form but empty" }];
  const kb = buildReviewBundle(known, { page: "p1" });
  assert.strictEqual(kb.entries.length, 1); // KEPT (unlike the .add/.delete "section" ops, which are filtered)
  assert.strictEqual(kb.entries[0].widget_type, "section_stub");
  assert.strictEqual(kb.entries[0].canonical_field, "certification._stub");
  assert.strictEqual(kb.entries[0].needs_review, false, "known/profile-defined empty section does NOT nag for review");
  assert.strictEqual(kb.entries[0].fill_status, "skipped");
  assert.strictEqual(kb.entries[0].current_value, null);

  // An UNKNOWN section (a tenant repeating section the profile doesn't model) IS a genuine gap → review.
  const unknown = [{ fieldName: "publication", label: "Publications — section present (unmapped)",
    widgetType: "section_stub", isRequired: false, mappedPath: "publication._stub",
    status: "skipped", flag: "section-stub", after: null, section_known: false, detail: "unmapped section" }];
  const ub = buildReviewBundle(unknown, { page: "p1" });
  assert.strictEqual(ub.entries[0].needs_review, true, "unknown/unmodeled section IS a review item");
  assert.strictEqual(ub.entries[0].needs_review_reason, "section_unfilled");
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
test("detectSectionShapes: a MOUNTED specialty at page-load does NOT leak into the cert's add-entry shape (operator bug)", () => {
  // The ORIGINAL-state scan sees the nested specialty fields + the Attachments input INSIDE the
  // cert entry container. They belong to nested_shapes/nested_attachments — the flat add-entry
  // shape must hold ONLY the cert's own fields (was: Specialty*/Start/End flat in the added entry
  // + a text-box "Attachments" row alongside the real picker).
  const scan = { sections: {
    "certification-": { entries: [{ fields: [
      { fieldName: "certification", widgetType: "typeahead", label: "Certification*", isRequired: true },
      { fieldName: "certificationNumber", widgetType: "text", label: "Number", isRequired: false },
      { fieldName: "issuedDate", widgetType: "date", label: "Issued Date", dateSegments: ["dateSectionMonth-input", "dateSectionDay-input", "dateSectionYear-input"] },
      { fieldName: "expirationDate", widgetType: "date", label: "Expiration Date", dateSegments: ["dateSectionMonth-input", "dateSectionDay-input", "dateSectionYear-input"] },
      { fieldName: "specialtyParent", widgetType: "typeahead", label: "Specialty*", isRequired: true }, // nested — mounted at load
      { fieldName: "startDate", widgetType: "date", label: "Start Date" },                              // nested
      { fieldName: "endDate", widgetType: "date", label: "End Date" },                                  // nested
      { fieldName: "", widgetType: "unknown", label: "Attachments" },                                   // the attachments wrapper (empty fieldName)
      { fieldName: "someUpload", widgetType: "file_upload", label: "Attachments" },                     // a typed file input
    ] }] },
    "publication-": { entries: [{ fields: [ // UNKNOWN section — no nested config, startDate is its OWN field
      { fieldName: "title", widgetType: "text", label: "Title*", isRequired: true },
      { fieldName: "startDate", widgetType: "date", label: "Published" },
      { fieldName: "", widgetType: "unknown", label: "Files" }, // empty-name wrapper still excluded
    ] }] },
  } };
  const shapes = detectSectionShapes(scan);
  assert.deepStrictEqual(shapes.certification.map((s) => s.recName), ["certification", "certificationNumber", "issuedDate", "expirationDate"],
    "the cert shape holds ONLY its own fields — nested + attachments excluded");
  assert.deepStrictEqual(shapes["publication"].map((s) => s.recName), ["title", "startDate"],
    "an unknown section keeps its OWN startDate (no nested config) — only the empty-name wrapper drops");
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

test("driveRepeatingSectionCdp: section.nested + item.specialties → FILLS the nested specialtyParent (record beside the stub)", async () => {
  // The wire: a surviving cert entry whose profile item has specialties → fillNestedSpecialtiesCdp runs
  // (reconcile + fill), its records flow into results ALONGSIDE the addable stub. (The typeahead can't
  // commit in the fake — the point is the wire INVOKED the fill + emitted the nested canonical record.)
  const entry = { fkit: "certification-1--null", fields: [{ fieldName: "url", label: "URL", widgetType: "text", isRequired: false, value: "" }] };
  const state = webState({ prefix: "certification-", entries: [entry], nestedEnabled: true });
  const out = await driveRepeatingSectionCdp(makeFakeRepeatAct(state), {
    name: "certification", headingRegex: "certifications?", containerPrefix: "certification-",
    items: [{ url: "x", specialties: [{ specialty: "otherrrr" }] }],
    fieldMap: [{ field: "url", widget: "text", key: "url", path: "url" }],
    deleteOnNoMatch: false, nested: CERT_NESTED
  }, T_BUDGETS);
  const sp = out.results.find((r) => r.fieldName === "certification[0].specialties[0].specialtyParent");
  assert.ok(sp && sp.widgetType === "typeahead", "nested specialtyParent record emitted (fill invoked)");
  assert.deepStrictEqual(sp.nested_parent, { base: "certification", index: 0 });
  assert.ok(out.results.some((r) => r.fieldName === "certification[0].specialties._stub"), "the addable stub STILL emits (add more)");
});

test("driveRepeatingSectionCdp: section.nested + NO item.specialties → stub only (no nested fill record)", async () => {
  const entry = { fkit: "certification-1--null", fields: [{ fieldName: "url", label: "URL", widgetType: "text", isRequired: false, value: "" }] };
  const state = webState({ prefix: "certification-", entries: [entry], nestedEnabled: true });
  const out = await driveRepeatingSectionCdp(makeFakeRepeatAct(state), {
    name: "certification", headingRegex: "certifications?", containerPrefix: "certification-",
    items: [{ url: "x" }], fieldMap: [{ field: "url", widget: "text", key: "url", path: "url" }],
    deleteOnNoMatch: false, nested: CERT_NESTED
  }, T_BUDGETS);
  assert.ok(!out.results.some((r) => /specialties\[\d+\]/.test(r.fieldName)), "no nested fill record without profile specialties");
  assert.ok(out.results.some((r) => r.fieldName === "certification[0].specialties._stub"), "stub present");
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

test("generic UNKNOWN section: empty OPTIONAL field stays empty (not flagged); empty REQUIRED needs a value", async () => {
  const optField = { wrapperSel: "O0", fieldName: "note", widgetType: "text", label: "Note", isRequired: false };
  const reqField = { wrapperSel: "R0", fieldName: "title", widgetType: "text", label: "Title*", isRequired: true };
  const rscan = { url: "fake://p2", addButtons: [], sections: {
    "publication-": { entryCount: 1, heading: "Publications", entries: [{ fields: [
      { fieldName: "note", widgetType: "text", label: "Note", isRequired: false, value: null, wrapperSel: "O0" },
      { fieldName: "title", widgetType: "text", label: "Title*", isRequired: true, value: null, wrapperSel: "R0" },
    ] }] }
  } };
  const out = await drivePageFill(makeFakeAct([optField, reqField], { rscan }), {}, {}, {}, T_BUDGETS);
  assert.strictEqual(out.results.find((r) => r.fieldName === "publication[0].note").status, "skipped", "empty OPTIONAL → skipped (fine to leave empty, no approval)");
  assert.strictEqual(out.results.find((r) => r.fieldName === "publication[0].title").status, "needs_review", "empty REQUIRED → needs a value");
  const bundle = buildReviewBundle(out.results, { page: "p2" });
  assert.strictEqual(bundle.entries.find((e) => e.canonical_field === "publication[0].note").needs_review, false, "empty optional NOT flagged (won't require approval)");
  assert.strictEqual(bundle.entries.find((e) => e.canonical_field === "publication[0].title").needs_review, true, "empty required flagged");
});

test("fillNestedSpecialtiesCdp: reconciles UP to N (mounts) + nested canonical records + skips absent dates", async () => {
  // Fills a cert's Specialties: mount to N, fill each child's fields at the nested fkit selector. Here
  // the typeahead can't open in the fake (→ its record is flagged, not asserted); the point is the
  // reconcile + the nested canonical + date-skip. The AI typo-fix (otherrrr→Other) is live-verified.
  let children = [], nextIdx = 5;
  const scan = () => ({ parentOrder: { certification: [287] }, nestedSections: children.length ? [{ parentBase: "certification", childBase: "specialties",
    entries: children.map((ci) => ({ levels: [{ base: "certification", index: 287 }, { base: "specialties", index: ci }], fields: [] })) }] : [] });
  const act = {
    delay: async () => {}, delayFull: async () => {},
    nestedScan: async () => scan(),
    clickNestedAdd: async () => { children.push(nextIdx++); return { ok: true }; },
    clickNestedDelete: async (pf, base, idx) => { children = children.filter((c) => String(c) !== String(idx)); return { ok: true }; },
    // minimal typeahead seams → fillTypeaheadCdp returns cleanly (can't open) without throwing
    openHier: async () => false, focusHierSearch: async () => false, readHier: async () => null,
    readTreeCategories: async () => [], scrapeTaOptions: async () => ({ ok: false }), clearHierSearch: async () => {},
    typeInHier: async () => {}, pressEnter: async () => {}, pressTab: async () => {}, isTreePicker: async () => false, readSource: async () => null,
  };
  const fieldMap = [
    { field: "specialtyParent", widget: "typeahead", key: "specialty", path: "specialtyParent" },
    { field: "startDate", widget: "date", key: "startDateParsed", path: "startDate" },
    { field: "endDate", widget: "date", key: "endDateParsed", path: "endDate" },
  ];
  const recs = await fillNestedSpecialtiesCdp(act, { parentBase: "certification", pOrd: 0, pIdx: 287, childBase: "specialties",
    headingStem: "specialt", fieldMap, items: [{ specialty: "otherrrr" }], budgets: T_BUDGETS });
  assert.strictEqual(children.length, 1, "reconciled UP to N=1 (mounted one specialty)");
  const sp = recs.find((r) => r.fieldName === "certification[0].specialties[0].specialtyParent");
  assert.ok(sp && sp.widgetType === "typeahead", "specialtyParent record with the nested canonical");
  assert.deepStrictEqual(sp.nested_parent, { base: "certification", index: 0 });
  assert.strictEqual(sp.nested_child_base, "specialties");
  assert.strictEqual(recs.find((r) => r.fieldName === "certification[0].specialties[0].startDate").status, "skipped", "no start date → skipped (never half-filled)");
  assert.strictEqual(recs.find((r) => r.fieldName === "certification[0].specialties[0].endDate").status, "skipped", "no end date → skipped");
});

test("PAGE_SECTIONS: exactly one section (Certifications) carries a nested config", () => {
  assert.strictEqual(PAGE_SECTIONS.find((s) => s.name === "certification").nested, CERT_NESTED);
  assert.strictEqual(PAGE_SECTIONS.filter((s) => s.nested).length, 1);
});

// ── FILL IN DOM ORDER (operator rule 2026-07-02) ────────────────────────────────────────────────
test("sectionsInDomOrder: sections drive in PAGE order (Add-button document order), not registry order", () => {
  const adds = [
    { nearestHeading: "Specialties", insideEntry: true },  // a NESTED Add — ignored for ordering
    { nearestHeading: "Languages", insideEntry: false },
    { nearestHeading: "Certifications", insideEntry: false },
    { nearestHeading: "Work Experience" },
  ];
  const ordered = sectionsInDomOrder(PAGE_SECTIONS, adds).map((s) => s.name);
  assert.deepStrictEqual(ordered.slice(0, 3), ["language", "certification", "workExperience"], "DOM (Add-button) order wins");
  // registry-independent tail: whatever sections the registry holds beyond the three matched, in registry order
  const expectedTail = PAGE_SECTIONS.map((s) => s.name).filter((n) => !["language", "certification", "workExperience"].includes(n));
  assert.deepStrictEqual(ordered.slice(3), expectedTail, "unmatched sections keep registry order at the tail");
  assert.deepStrictEqual(sectionsInDomOrder(PAGE_SECTIONS, []).map((s) => s.name), PAGE_SECTIONS.map((s) => s.name), "no Add buttons → registry order (today's behavior)");
});

test("cert attachments: the nested-attachment row is ALWAYS the untouched stub — nothing ever attaches the résumé to a cert", async () => {
  // The TEST-ONLY attach_resume path (verified live 2026-07-02) was REMOVED with its test data: even
  // a leftover profile flag + a seam on the act must be IGNORED — per-entry attachments are the
  // operator's (the review picker / the form); the résumé only attaches to the top-level Documents field.
  const state = webState({ prefix: "certification-", nestedEnabled: true,
    entries: [{ fkit: "certification-1--null", fields: [{ fieldName: "url", label: "URL", widgetType: "text", isRequired: false, value: "" }] }] });
  const act = makeFakeRepeatAct(state);
  const calls = [];
  act.attachStoredResume = async (sel) => { calls.push(sel); return { attached: true, fileName: "resume.pdf" }; };
  const out = await driveRepeatingSectionCdp(act, {
    name: "certification", headingRegex: "certifications?", containerPrefix: "certification-",
    items: [{ url: "x", attach_resume: true }], // a stale profile flag — must be inert
    fieldMap: [{ field: "url", widget: "text", key: "url", path: "url" }], deleteOnNoMatch: false, nested: CERT_NESTED
  }, T_BUDGETS);
  assert.deepStrictEqual(calls, [], "no attach call, ever");
  const att = out.results.find((r) => r.fieldName === "certification[0].attachments");
  assert.strictEqual(att.status, "skipped", "the plain per-entry attachments stub");
  assert.strictEqual(att.flag, "nested-attachment");
});

test("nested deleteOnNoMatch (proactive): a BLANK genuine-no-match specialty row is DELETED at fill time; a value-holder is KEPT; preserveExtras skips", async () => {
  // Operator rule 2026-07-02 — was: the blocked row waited for AI-4 Tier-1.5 at advance time.
  // Mirrors the top-level rule + its safeties: genuine negatives only, value-holders never deleted.
  const fieldMap = CERT_NESTED.subSections[0].fieldMap;
  const mkAct = (fieldFlags) => {
    const field = taField(Object.assign({ wrapperSel: "[w-specialtyParent]", fieldName: "specialtyParent", label: "Specialty*" }, fieldFlags));
    const act = makeFakeAct([field]);
    let children = [7];
    act.nestedScan = async () => ({ parentOrder: { certification: [172] }, nestedSections: children.length ? [{ parentBase: "certification", childBase: "specialties",
      entries: children.map((ci) => ({ levels: [{ base: "certification", index: 172 }, { base: "specialties", index: ci }], fields: [] })) }] : [] });
    act.clickNestedAdd = async () => { children.push(9); return { ok: true }; };
    act.clickNestedDelete = async (pf, base, idx) => { act.log.push(["ndel", pf, base, idx]); children = children.filter((c) => String(c) !== String(idx)); return { ok: true }; };
    act.nestedFieldSel = async (fkit, fieldName) => "[w-" + fieldName + "]"; // dates resolve to unmatched sels → null reads → skipped
    return act;
  };
  const o = (extra) => Object.assign({ parentBase: "certification", pOrd: 0, pIdx: 172, childBase: "specialties",
    headingStem: "specialt", fieldMap, items: [{ specialty: "sdjkf" }], budgets: T_BUDGETS }, extra || {});
  // (a) BLANK + genuine no-match (banner) → the row is DELETED + records removed + a note
  const actA = mkAct({ chips: [], filterMap: { "sdjkf": { banner: true } } });
  const recsA = await fillNestedSpecialtiesCdp(actA, o());
  assert.ok(actA.log.some((l) => l[0] === "ndel" && String(l[3]) === "7"), "the blocked row deleted (right parent + fkit idx)");
  assert.ok(recsA.filter((r) => /specialties\[0\]\.(specialtyParent|startDate|endDate)$/.test(r.fieldName)).every((r) => r.status === "removed"), "the row's records drop from the bundle");
  assert.ok(recsA.some((r) => r.widgetType === "section" && r.flag === "nested-nomatch-removed"), "the removal note emitted (stub annotation feeds off it)");
  // (b) the field HOLDS a value (kept original) → NEVER deleted, the kept chip reported
  const actB = mkAct({ chips: ["Other - OTH"], filterMap: { "sdjkf": { banner: true } } });
  const recsB = await fillNestedSpecialtiesCdp(actB, o());
  assert.ok(!actB.log.some((l) => l[0] === "ndel"), "a value-holder is NEVER deleted (it doesn't block)");
  assert.strictEqual(recsB.find((r) => /specialtyParent$/.test(r.fieldName)).after, "Other - OTH", "the kept original reported");
  // (c) preserveExtras (remediation re-fill) → no deletion, ever
  const actC = mkAct({ chips: [], filterMap: { "sdjkf": { banner: true } } });
  await fillNestedSpecialtiesCdp(actC, o({ preserveExtras: true }));
  assert.ok(!actC.log.some((l) => l[0] === "ndel"), "preserveExtras never deletes");
});

test("buildReviewBundle: a needs_review record's live `after` renders as current_value (the kept original shows IN the field)", () => {
  const bundle = buildReviewBundle([{ fieldName: "certification[0].specialties[0].specialtyParent", label: "Specialty",
    widgetType: "typeahead", isRequired: true, mappedPath: "certifications[0].specialties[0].specialty",
    rawValue: "sdjkf", resolved: ["sdjkf"], status: "needs_review", matchTier: null, confidence: null,
    flag: "overwrite-nomatch-original-kept", verified: false,
    after: "Other - OTH", detail: 'no candidate matched — original pre-fill "Other - OTH" kept' }], { page: "p" });
  const e = bundle.entries[0];
  assert.strictEqual(e.current_value, "Other - OTH", "the live kept value shows in the editor, not an empty box");
  assert.strictEqual(e.needs_review, true, "still flagged for review");
});

test("fillNestedSpecialtiesCdp: N=0 reconciles DOWN — orphan empty specialty rows DELETED (they'd block Save & Continue)", async () => {
  // The 2026-07-01 live halt: recon-mounted EMPTY specialties + a profile with no specialties →
  // the old `!N` early-return never deleted them → "The field Specialty is required" blocked the
  // walk. N=0 must now reconcile down to 0 (same reconcile-to-exactly-N semantics as M21 top-level).
  let children = [5, 9];
  const scan = () => ({ parentOrder: { certification: [287] }, nestedSections: children.length ? [{ parentBase: "certification", childBase: "specialties",
    entries: children.map((ci) => ({ levels: [{ base: "certification", index: 287 }, { base: "specialties", index: ci }], fields: [] })) }] : [] });
  const deletes = [];
  const act = {
    delay: async () => {}, delayFull: async () => {},
    nestedScan: async () => scan(),
    clickNestedAdd: async () => { throw new Error("must NOT add at N=0"); },
    clickNestedDelete: async (pf, base, idx) => { deletes.push(idx); children = children.filter((c) => String(c) !== String(idx)); return { ok: true }; },
  };
  const recs = await fillNestedSpecialtiesCdp(act, { parentBase: "certification", pOrd: 0, pIdx: 287, childBase: "specialties",
    headingStem: "specialt", fieldMap: CERT_NESTED.subSections[0].fieldMap, items: [], budgets: T_BUDGETS });
  assert.strictEqual(children.length, 0, "reconciled DOWN to N=0 (orphans deleted)");
  assert.deepStrictEqual(deletes, [9, 5], "trailing-first (highest child index deleted first)");
  assert.deepStrictEqual(recs, [], "no fill records at N=0");
});

test("driveRepeatingSectionCdp wire: cert with NO profile specialties DELETES pre-existing orphan specialty rows", async () => {
  const entry = { fkit: "certification-1--null", fields: [{ fieldName: "url", label: "URL", widgetType: "text", isRequired: false, value: "" }] };
  const state = webState({ prefix: "certification-", entries: [entry], nestedEnabled: true, nestedKids: { 700: [900, 901] } });
  const act = makeFakeRepeatAct(state);
  const out = await driveRepeatingSectionCdp(act, {
    name: "certification", headingRegex: "certifications?", containerPrefix: "certification-",
    items: [{ url: "x" }], fieldMap: [{ field: "url", widget: "text", key: "url", path: "url" }],
    deleteOnNoMatch: false, nested: CERT_NESTED
  }, T_BUDGETS);
  const after = await act.nestedScan();
  assert.strictEqual((after.nestedSections || []).length, 0, "orphan specialties deleted (nested reconcile to 0)");
  assert.strictEqual(act.log.filter((l) => l[0] === "clickNestedDelete").length, 2, "both orphans deleted");
  assert.ok(out.results.some((r) => r.fieldName === "certification[0].specialties._stub"), "the addable stub still emits");
});

// ── AI-4 Tier-1.5 — section re-fill for section-named errors (drivePageFill onlySections) ────────
test("AI-4 sectionsFromErrorNames: nested 'Specialty' → certification; label/regex/camelCase routes; unknown → none", () => {
  assert.deepStrictEqual(sectionsFromErrorNames(["Specialty"]), ["certification"], "nested sub-section field label (the live miss)");
  assert.deepStrictEqual(sectionsFromErrorNames(["Specialty ()"]), ["certification"], "empty-parens variant (blank template slot)");
  assert.deepStrictEqual(sectionsFromErrorNames(["Reading Proficiency"]), ["language"], "fieldMap labelRegex route");
  if (PAGE_SECTIONS.some((s) => s.name === "education")) // registry-dependent (education TEMP-pulled for the generic-recon regression — self-heals on restore)
    assert.deepStrictEqual(sectionsFromErrorNames(["Field Of Study"]), ["education"], "camelCase field split to words");
  assert.deepStrictEqual(sectionsFromErrorNames(["Job Title"]), ["workExperience"]);
  assert.deepStrictEqual(sectionsFromErrorNames(["Frobnicator"]), [], "unknown name anchors nothing");
  assert.deepStrictEqual(sectionsFromErrorNames([]), []);
  assert.deepStrictEqual(sectionsFromErrorNames([null, "ab"]), [], "null / too-short names never anchor a section re-run");
});

test("drivePageFill onlySections (AI-4 Tier-1.5): drives ONLY the named section — flat fields untouched", async () => {
  const flat = { fieldName: "firstName", label: "First Name", widgetType: "text", isRequired: true, wrapperSel: "F0", value: "" };
  const state = webState({ entries: [webEntry("webAddress-4--null", "")], flatFields: [flat] });
  const act = makeFakeRepeatAct(state);
  const out = await drivePageFill(act, { websites: [{ url: "https://a.example" }] }, {}, {}, T_BUDGETS, { onlySections: new Set(["website"]) });
  const url = out.results.find((r) => r.fieldName === "website[0].url");
  assert.ok(url && url.status === "filled", "the named section re-filled");
  assert.ok(!out.results.some((r) => r.fieldName === "firstName"), "flat fields skipped entirely (no flat records)");
  assert.ok(!act.log.some((l) => l[0] === "focusText" && l[1] === "F0"), "zero actuation on flat fields");
});

test("drivePageFill onlySections: a PRESENT section NOT named is untouched (zero actuation)", async () => {
  const state = webState({ entries: [webEntry("webAddress-4--null", "")] });
  const act = makeFakeRepeatAct(state);
  const out = await drivePageFill(act, { websites: [{ url: "https://a.example" }] }, {}, {}, T_BUDGETS, { onlySections: new Set(["language"]) });
  assert.strictEqual(out.results.length, 0, "nothing driven (websites present but not named)");
  assert.ok(!act.log.some((l) => l[0] === "focusText"), "zero actuation on the un-named section");
});

// ── AI-4 Tier-1.5 — deterministic DELETE of empty error-named repeating rows (operator rule
// 2026-07-02: repeating ⇒ optional ⇒ a blocking row with nothing to refill gets DELETED; a nested
// name deletes ONLY the layer-2 rows, never the parent entry) ────────────────────────────────────
test("AI-4 deleteTargetsFromErrorNames: nested names → layer-2 target; top-level names → entry target; ambiguity → both", () => {
  const spec = deleteTargetsFromErrorNames(["Specialty ()"]);
  assert.deepStrictEqual(spec.map((t) => t.kind), ["nested"], "'Specialty' targets the INNER rows only");
  assert.strictEqual(spec[0].childBase, "specialties");
  assert.deepStrictEqual(spec[0].fields, [{ field: "specialtyParent", widget: "typeahead" }]);
  const lang = deleteTargetsFromErrorNames(["Language"]);
  assert.deepStrictEqual(lang.map((t) => [t.kind, t.section]), [["entry", "language"]]);
  const sd = deleteTargetsFromErrorNames(["Start Date"]);
  assert.deepStrictEqual(sd.map((t) => [t.kind, t.section]),
    [["entry", "workExperience"], ["nested", "certification"]],
    "an ambiguous name targets BOTH — safe, the empty-only executor self-limits");
  assert.deepStrictEqual(deleteTargetsFromErrorNames(["Frobnicator"]), []);
  assert.deepStrictEqual(deleteTargetsFromErrorNames([]), []);
});

test("AI-4 deleteEmptyErrorRows: top-level — deletes ONLY entries whose named field reads EMPTY", async () => {
  let entries = [
    { fields: [{ fieldName: "language", label: "Language*", value: "English" }] },
    { fields: [{ fieldName: "language", label: "Language*", value: null }] },       // the manually-added empty row
    { fields: [{ fieldName: "language", label: "Language*", value: "Chinese" }] },
  ];
  const deleteLog = [];
  const act = {
    delay: async () => {},
    repeatingScan: async () => ({ sections: { "language-": { entries } } }),
    entryCount: async () => entries.length,
    clickDeleteEntry: async (prefix, idx) => { deleteLog.push(idx); entries = entries.filter((_, i) => i !== idx); return { ok: true }; },
  };
  const del = await deleteEmptyErrorRows(act, deleteTargetsFromErrorNames(["Language"]), T_BUDGETS);
  assert.deepStrictEqual(deleteLog, [1], "only the EMPTY entry deleted; filled rows (incl. manual) untouched");
  assert.strictEqual(entries.length, 2);
  assert.deepStrictEqual(del.deleted, [{ section: "language", kind: "entry", index: 1 }]);
});

test("AI-4 deleteEmptyErrorRows: a VALUE-HOLDING row with ONE empty required field is KEPT — never nuke partial data (the education bug)", async () => {
  // Education entry: school + degree FILLED, Field of Study EMPTY (not in the profile), and the Save &
  // Continue error names "Field of Study". The OLD `anyEmpty` check deleted the WHOLE entry (losing
  // school + degree, and it vanished from review). Now a row that holds ANY value is KEPT — only a truly
  // ENTIRELY-empty orphan row is deleted. The missing required field surfaces for review / halts instead.
  let entries = [
    { fields: [
      { fieldName: "schoolName", label: "School*", value: "Carnegie Mellon University" },
      { fieldName: "degree", label: "Degree*", value: "Bachelor of Science" },
      { fieldName: "fieldOfStudy", label: "Field of Study*", value: null }, // not in profile → empty
    ] },
    { fields: [ // a genuinely-empty orphan row → still deleted (it blocks Save and holds nothing)
      { fieldName: "schoolName", label: "School*", value: null },
      { fieldName: "degree", label: "Degree*", value: null },
      { fieldName: "fieldOfStudy", label: "Field of Study*", value: null },
    ] },
  ];
  const deleteLog = [];
  const act = {
    delay: async () => {},
    repeatingScan: async () => ({ sections: { "education-": { entries } } }),
    entryCount: async () => entries.length,
    clickDeleteEntry: async (prefix, idx) => { deleteLog.push(idx); entries = entries.filter((_, i) => i !== idx); return { ok: true }; },
  };
  const targets = [{ kind: "entry", section: "education", containerPrefix: "education-", fields: [{ field: "fieldOfStudy" }] }];
  const del = await deleteEmptyErrorRows(act, targets, T_BUDGETS);
  assert.deepStrictEqual(deleteLog, [1], "ONLY the entirely-empty orphan row deleted; the partial (value-holding) education entry KEPT");
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].fields[0].value, "Carnegie Mellon University", "the partial education entry (school + degree) survives");
  assert.deepStrictEqual(del.deleted, [{ section: "education", kind: "entry", index: 1 }]);
});

test("AI-4 deleteEmptyErrorRows: nested — deletes ONLY the EMPTY layer-2 row; the parent cert entry is NEVER deleted", async () => {
  let kids = [5, 9]; // child 5 filled ("Other"), child 9 empty — the manually-added blocking row
  const chipBySel = { "SEL-5": ["Other"], "SEL-9": [] };
  const nestedDeletes = [], parentDeletes = [];
  const act = {
    delay: async () => {},
    nestedScan: async () => ({ nestedSections: kids.length ? [{ parentBase: "certification", childBase: "specialties",
      entries: kids.map((ci) => ({ levels: [{ base: "certification", index: 287 }, { base: "specialties", index: ci }] })) }] : [] }),
    nestedFieldSel: async (fkit) => "SEL-" + /specialties-(\d+)--/.exec(fkit)[1],
    readHier: async (loc) => ({ chips: chipBySel[loc.wrapperSel] || [] }),
    clickNestedDelete: async (pf, base, idx) => { nestedDeletes.push([pf, idx]); kids = kids.filter((k) => String(k) !== String(idx)); return { ok: true }; },
    clickDeleteEntry: async (prefix, idx) => { parentDeletes.push(idx); return { ok: true }; },
  };
  const del = await deleteEmptyErrorRows(act, deleteTargetsFromErrorNames(["Specialty"]), T_BUDGETS);
  assert.deepStrictEqual(nestedDeletes, [["certification-287--null", 9]], "only the empty child row deleted");
  assert.deepStrictEqual(parentDeletes, [], "the parent entry is NEVER deleted for a layer-2 error");
  assert.deepStrictEqual(kids, [5], "the filled child row survives");
  assert.deepStrictEqual(del.deleted, [{ section: "certification", kind: "nested", child: "specialties", parentIndex: 287, index: 9 }]);
});

test("AI-4 deleteEmptyErrorRows: unreadable nested field → row untouched (never a blind delete)", async () => {
  const kids = [7];
  const nestedDeletes = [];
  const act = {
    delay: async () => {},
    nestedScan: async () => ({ nestedSections: [{ parentBase: "certification", childBase: "specialties",
      entries: kids.map((ci) => ({ levels: [{ base: "certification", index: 287 }, { base: "specialties", index: ci }] })) }] }),
    nestedFieldSel: async () => null, // probe cannot resolve the field → cannot read → must not act
    readHier: async () => ({ chips: [] }),
    clickNestedDelete: async (pf, base, idx) => { nestedDeletes.push(idx); return { ok: true }; },
  };
  const del = await deleteEmptyErrorRows(act, deleteTargetsFromErrorNames(["Specialty"]), T_BUDGETS);
  assert.deepStrictEqual(nestedDeletes, [], "unreadable row never deleted");
  assert.deepStrictEqual(del.deleted, []);
});

test("driveRepeatingSectionCdp preserveExtras: entries beyond profile-N are KEPT (remediation re-fill never deletes manual entries)", async () => {
  const state = webState({ entries: [webEntry("webAddress-1--null", ""), webEntry("webAddress-2--null", "x"), webEntry("webAddress-3--null", "y")] });
  const { act } = await runWeb(state, [{ url: "https://a.example" }], { preserveExtras: true });
  assert.strictEqual(state.entries.length, 3, "no reconcile-down under preserveExtras");
  assert.ok(!act.log.some((l) => l[0] === "clickDeleteEntry"), "delete never clicked");
});

test("fillNestedSpecialtiesCdp preserveExtras: N=0 with existing child rows → rows KEPT (the remediation-context inverse of the N=0 reconcile)", async () => {
  let children = [5, 9];
  const scan = () => ({ parentOrder: { certification: [287] }, nestedSections: children.length ? [{ parentBase: "certification", childBase: "specialties",
    entries: children.map((ci) => ({ levels: [{ base: "certification", index: 287 }, { base: "specialties", index: ci }], fields: [] })) }] : [] });
  const act = {
    delay: async () => {}, delayFull: async () => {},
    nestedScan: async () => scan(),
    clickNestedAdd: async () => { throw new Error("must NOT add at N=0"); },
    clickNestedDelete: async () => { throw new Error("must NOT delete under preserveExtras"); },
  };
  const recs = await fillNestedSpecialtiesCdp(act, { parentBase: "certification", pOrd: 0, pIdx: 287, childBase: "specialties",
    headingStem: "specialt", fieldMap: CERT_NESTED.subSections[0].fieldMap, items: [], budgets: T_BUDGETS, preserveExtras: true });
  assert.deepStrictEqual(children, [5, 9], "rows kept");
  assert.deepStrictEqual(recs, []);
});

test("fillNestedSpecialtiesCdp: PROBES the wrapper selector (act.nestedFieldSel) + fills dates from parsed profile values", async () => {
  // The composed descendant selector failed LIVE on Magna ("typeahead wrapper not found" — the fkit node
  // does not wrap the formField), so the fill now PROBES the real relationship via the substrate. Here
  // the probe returns a :has()-shaped selector and the date seams are keyed on it — proving the probed
  // selector (not the legacy compose) is what drives the fill AND lands in auditLoc for the M40 audit.
  const children = [7];
  const scan = () => ({ parentOrder: { certification: [172] }, nestedSections: [{ parentBase: "certification", childBase: "specialties",
    entries: children.map((ci) => ({ levels: [{ base: "certification", index: 172 }, { base: "specialties", index: ci }], fields: [] })) }] });
  const probed = (fkit, field) => '[data-automation-id="formField-' + field + '"]:has([id="' + fkit + '"])';
  const segStore = {}; let focusedSeg = null;
  const act = {
    delay: async () => {}, delayFull: async () => {},
    nestedScan: async () => scan(),
    clickNestedAdd: async () => ({ ok: false }), clickNestedDelete: async () => ({ ok: false }),
    nestedFieldSel: async (fkit, field) => probed(fkit, field),
    // typeahead seams (specialtyParent can't open in the fake → flagged; not this test's point)
    openHier: async () => false, focusHierSearch: async () => false, readHier: async () => null,
    readTreeCategories: async () => [], scrapeTaOptions: async () => ({ ok: false }), clearHierSearch: async () => {},
    typeInHier: async () => {}, pressEnter: async () => {}, pressTab: async () => {}, isTreePicker: async () => false, readSource: async () => null,
    // date seams — keyed by the PROBED selector
    focusDateSegment: async (loc, seg) => { focusedSeg = loc.wrapperSel + "|" + seg; return "triple-click-display"; },
    readDateSegment: async (loc, seg) => ({ value: segStore[loc.wrapperSel + "|" + seg] || "", focused: focusedSeg === loc.wrapperSel + "|" + seg }),
    typeDigits: async (text) => { if (focusedSeg) segStore[focusedSeg] = String(text); },
    typeText: async (text) => { if (focusedSeg) segStore[focusedSeg] = String(text); },
  };
  const fieldMap = [
    { field: "specialtyParent", widget: "typeahead", key: "specialty", path: "specialtyParent" },
    { field: "startDate", widget: "date", key: "startDateParsed", path: "startDate" },
    { field: "endDate", widget: "date", key: "endDateParsed", path: "endDate" },
  ];
  const recs = await fillNestedSpecialtiesCdp(act, { parentBase: "certification", pOrd: 0, pIdx: 172, childBase: "specialties",
    headingStem: "specialt", fieldMap,
    items: [{ specialty: "otherrrr", startDateParsed: { year: "2024", month: "02", day: "01" }, endDateParsed: { year: "2025", month: "08", day: "15" } }],
    budgets: T_BUDGETS });
  const sp = recs.find((r) => r.fieldName === "certification[0].specialties[0].specialtyParent");
  assert.strictEqual(sp.auditLoc, probed("certification-172--specialties-7--specialtyParent", "specialtyParent"),
    "the PROBED selector (not the composed descendant) is the loc + auditLoc");
  const sd = recs.find((r) => r.fieldName === "certification[0].specialties[0].startDate");
  assert.strictEqual(sd.status, "filled", "startDate FILLED from the parsed profile date");
  assert.strictEqual(parseInt(segStore[probed("certification-172--specialties-7--startDate", "startDate") + "|Month"], 10), 2, "Month typed at the probed selector");
  assert.strictEqual(parseInt(segStore[probed("certification-172--specialties-7--startDate", "startDate") + "|Year"], 10), 2024, "Year typed");
  const ed = recs.find((r) => r.fieldName === "certification[0].specialties[0].endDate");
  assert.strictEqual(ed.status, "filled", "endDate FILLED too");
});

test("fillNestedSpecialtiesCdp: a manually-filled date the profile omits → surfaced already-filled + segmented date_order", async () => {
  // The operator's live case: profile has ONLY a start date; they typed the END date on the form
  // themselves. The end date must SHOW in review (already-filled, flagged) and BOTH date rows must
  // carry date_order so the summary renders the segmented MM/DD/YYYY editor, not a text box.
  const children = [7];
  const scan = () => ({ parentOrder: { certification: [172] }, nestedSections: [{ parentBase: "certification", childBase: "specialties",
    entries: children.map((ci) => ({ levels: [{ base: "certification", index: 172 }, { base: "specialties", index: ci }], fields: [] })) }] });
  const probed = (fkit, field) => '[data-automation-id="formField-' + field + '"]:has([id="' + fkit + '"])';
  const segs = {}; let focusedSeg = null;
  // pre-seed the OPERATOR's manual end date on the form
  segs[probed("certification-172--specialties-7--endDate", "endDate") + "|Month"] = "6";
  segs[probed("certification-172--specialties-7--endDate", "endDate") + "|Day"] = "15";
  segs[probed("certification-172--specialties-7--endDate", "endDate") + "|Year"] = "2025";
  const act = {
    delay: async () => {}, delayFull: async () => {},
    nestedScan: async () => scan(),
    clickNestedAdd: async () => ({ ok: false }), clickNestedDelete: async () => ({ ok: false }),
    nestedFieldSel: async (fkit, field) => probed(fkit, field),
    openHier: async () => false, focusHierSearch: async () => false, readHier: async () => null,
    readTreeCategories: async () => [], scrapeTaOptions: async () => ({ ok: false }), clearHierSearch: async () => {},
    typeInHier: async () => {}, pressEnter: async () => {}, pressTab: async () => {}, isTreePicker: async () => false, readSource: async () => null,
    focusDateSegment: async (loc, seg) => { focusedSeg = loc.wrapperSel + "|" + seg; return "triple-click-display"; },
    readDateSegment: async (loc, seg) => ({ value: segs[loc.wrapperSel + "|" + seg] || "", focused: focusedSeg === loc.wrapperSel + "|" + seg }),
    typeDigits: async (t) => { if (focusedSeg) segs[focusedSeg] = String(t); },
    typeText: async (t) => { if (focusedSeg) segs[focusedSeg] = String(t); },
  };
  const recs = await fillNestedSpecialtiesCdp(act, { parentBase: "certification", pOrd: 0, pIdx: 172, childBase: "specialties",
    headingStem: "specialt", fieldMap: CERT_NESTED.subSections[0].fieldMap, // the REAL config → its date_order flows
    items: [{ specialty: "otherrrr", startDateParsed: { year: "2024", month: "02", day: "01" } }], budgets: T_BUDGETS });
  const ed = recs.find((r) => r.fieldName === "certification[0].specialties[0].endDate");
  assert.strictEqual(ed.status, "filled_review", "the manual end date SURFACES in review");
  assert.strictEqual(ed.flag, "already-filled");
  assert.strictEqual(ed.after, "6/15/2025");
  assert.deepStrictEqual(ed.date_order, ["month", "day", "year"]);
  const sd = recs.find((r) => r.fieldName === "certification[0].specialties[0].startDate");
  assert.strictEqual(sd.status, "filled", "the profile start date still fills");
  assert.deepStrictEqual(sd.date_order, ["month", "day", "year"], "filled date rows render segmented too");
  const be = buildReviewBundle(recs, { page: "p2" }).entries.find((e) => e.canonical_field === "certification[0].specialties[0].endDate");
  assert.deepStrictEqual(be.date_order, ["month", "day", "year"], "date_order survives into the bundle");
  assert.strictEqual(be.needs_review, true, "flagged — the bot didn't fill it");
  assert.strictEqual(be.current_value, "6/15/2025");
});

test("fillNestedSpecialtiesCdp: probe resolves NOTHING → honest error record, ZERO blind actuation", async () => {
  const scan = () => ({ parentOrder: { certification: [172] }, nestedSections: [{ parentBase: "certification", childBase: "specialties",
    entries: [{ levels: [{ base: "certification", index: 172 }, { base: "specialties", index: 3 }], fields: [] }] }] });
  const touched = [];
  const act = {
    delay: async () => {}, delayFull: async () => {},
    nestedScan: async () => scan(),
    clickNestedAdd: async () => ({ ok: false }), clickNestedDelete: async () => ({ ok: false }),
    nestedFieldSel: async () => null, // the tenant has NO resolvable relation — never actuate blind
    openHier: async () => { touched.push("openHier"); return false; },
    focusDateSegment: async () => { touched.push("focusDateSegment"); return null; },
  };
  const recs = await fillNestedSpecialtiesCdp(act, { parentBase: "certification", pOrd: 0, pIdx: 172, childBase: "specialties",
    headingStem: "specialt", fieldMap: [
      { field: "specialtyParent", widget: "typeahead", key: "specialty", path: "specialtyParent" },
      { field: "startDate", widget: "date", key: "startDateParsed", path: "startDate" },
    ],
    items: [{ specialty: "x", startDateParsed: { year: "2024" } }], budgets: T_BUDGETS });
  assert.ok(recs.every((r) => r.status === "error" && /wrapper not found/.test(r.detail)), "every field an HONEST error");
  assert.deepStrictEqual(touched, [], "no handler ever actuated on an unresolved wrapper");
});

// ── ALREADY-FILLED sweep — the review inventories EVERYTHING the page holds ─────────────────────
test("sweep (wire): an unmapped flat field HOLDING a value → filled_review/already-filled + flagged in the bundle; empty stays skipped", async () => {
  const withVal = { wrapperSel: "X0", fieldName: "randomExtra", widgetType: "text", label: "Extra thing", isRequired: false, liveValue: "operator typed this" };
  const empty = { wrapperSel: "X1", fieldName: "otherExtra", widgetType: "text", label: "Other", isRequired: false, liveValue: null };
  const out = await drivePageFill(makeFakeAct([withVal, empty]), {}, {}, {}, T_BUDGETS);
  const r = out.results.find((x) => x.fieldName === "randomExtra");
  assert.strictEqual(r.status, "filled_review");
  assert.strictEqual(r.flag, "already-filled");
  assert.strictEqual(r.after, "operator typed this", "the LIVE value is captured into the record");
  const e = out.results.find((x) => x.fieldName === "otherExtra");
  assert.strictEqual(e.status, "skipped", "an EMPTY unmapped field stays skipped");
  assert.strictEqual(e.flag, null);
  const bundle = buildReviewBundle(out.results, { page: "p" });
  assert.strictEqual(bundle.entries.find((x) => x.field_id.endsWith("formField-randomExtra")).needs_review, true, "flagged for review");
  assert.strictEqual(bundle.entries.find((x) => x.field_id.endsWith("formField-randomExtra")).needs_review_reason, "already_on_form");
  assert.strictEqual(bundle.entries.find((x) => x.field_id.endsWith("formField-otherExtra")).needs_review, false);
});

test("sweep: a live value that MATCHES the profile's own value → already-filled-match, NOT flagged (correct value, no review)", async () => {
  const results = [{ fieldName: "phoneType", label: "Phone Type", widgetType: "dropdown", isRequired: false,
    mappedPath: "personal_info.phone_type", rawValue: "Mobile", resolved: null,
    status: "skipped", matchTier: null, confidence: null, flag: null, verified: null, after: null, detail: "options did not render earlier" }];
  const act = { scanPage: async () => ({ fields: [{ fieldName: "phoneType", wrapperSel: "P0", value: "Mobile" }] }), repeatingScan: async () => null };
  await sweepAlreadyFilled(act, results);
  assert.strictEqual(results[0].status, "filled");
  assert.strictEqual(results[0].flag, "already-filled-match");
  assert.strictEqual(results[0].after, "Mobile");
  const bundle = buildReviewBundle(results, { page: "p" });
  assert.strictEqual(bundle.entries[0].needs_review, false, "matches the profile → recorded but NOT flagged");
});

test("sweep: KNOWN sections — mapped-but-skipped field flips; an UNMAPPED section field with a value gets a NEW record; nested child fields excluded", async () => {
  // Uses the WEBSITE section (registry-independent of the education TEMP toggle): url is the mapped
  // field (WEBSITE_MAP), "notes" the unmapped extra; cert's specialtyParent pins the nested exclusion.
  const results = [{ fieldName: "website[0].url", label: "URL", widgetType: "text", isRequired: false,
    mappedPath: "websites[0].url", rawValue: null, resolved: null,
    status: "skipped", matchTier: null, confidence: null, flag: null, verified: null, after: null, detail: "empty value" }];
  const rscan = { sections: {
    "webAddress-": { entries: [{ fields: [
      { fieldName: "url", label: "URL", widgetType: "text", isRequired: false, value: "https://k.example", wrapperSel: "U0" },
      { fieldName: "notes", label: "Notes", widgetType: "text", isRequired: false, value: "portfolio site", wrapperSel: "N0" },
    ] }] },
    "certification-": { entries: [{ fields: [
      { fieldName: "specialtyParent", label: "Specialty", widgetType: "typeahead", isRequired: false, value: "Other", wrapperSel: "S0" },
    ] }] }
  } };
  const act = { scanPage: async () => ({ fields: [] }), repeatingScan: async () => rscan };
  await sweepAlreadyFilled(act, results);
  const url = results.find((r) => r.fieldName === "website[0].url");
  assert.strictEqual(url.status, "filled_review", "mapped-but-skipped section field with a live value → flipped");
  assert.strictEqual(url.flag, "already-filled");
  assert.strictEqual(url.after, "https://k.example");
  const notes = results.find((r) => r.fieldName === "website[0].notes");
  assert.ok(notes, "an unmapped KNOWN-section field with a value → NEW already-filled record (the 'not mapped' edge case)");
  assert.strictEqual(notes.flag, "already-filled");
  assert.strictEqual(notes.after, "portfolio site");
  assert.ok(!results.some((r) => /specialtyParent/.test(r.fieldName)), "nested child fields (cert ▸ specialties) are EXCLUDED — reconciled + audited via their own records");
});

test("sweep: NESTED records re-read via their probed auditLoc at end-of-page (nested sub-section coverage)", async () => {
  // The flat/section scans can't join nested records by ordinal — the sweep re-reads any
  // still-skipped nested record through its probed selector, so a value committed to a nested
  // field AFTER the section filled still lands in the review (source-of-truth ordering).
  const results = [{ fieldName: "certification[0].specialties[0].endDate", label: "endDate", widgetType: "date",
    isRequired: false, mappedPath: "certification[0].specialties[0].endDate", rawValue: null, resolved: null,
    status: "skipped", matchTier: null, confidence: null, flag: null, verified: null, after: null,
    detail: "no date", date_order: ["month", "day", "year"],
    auditLoc: "PROBED-endDate", nested_parent: { base: "certification", index: 0 }, nested_child_base: "specialties" }];
  const segs = { "PROBED-endDate|Month": "6", "PROBED-endDate|Day": "15", "PROBED-endDate|Year": "2025" };
  const act = {
    scanPage: async () => ({ fields: [] }), repeatingScan: async () => null,
    readDateSegment: async (loc, seg) => ({ value: segs[loc.wrapperSel + "|" + seg] || "" }),
  };
  await sweepAlreadyFilled(act, results);
  assert.strictEqual(results[0].status, "filled_review", "the late-committed nested value SURFACES");
  assert.strictEqual(results[0].flag, "already-filled");
  assert.strictEqual(results[0].after, "6/15/2025");
});

test("sweep: never clobbers an existing classification (flagged skip records untouched)", async () => {
  const results = [{ fieldName: "essayField", label: "Essay", widgetType: "textarea", isRequired: false,
    mappedPath: null, rawValue: null, resolved: null,
    status: "skipped", matchTier: null, confidence: null, flag: "ai-text-skip", verified: null, after: null, detail: "AI declined (optional)" }];
  const act = { scanPage: async () => ({ fields: [{ fieldName: "essayField", wrapperSel: "E0", value: "half-typed draft" }] }), repeatingScan: async () => null };
  await sweepAlreadyFilled(act, results);
  assert.strictEqual(results[0].flag, "ai-text-skip", "an already-classified skip keeps its provenance");
  assert.strictEqual(results[0].status, "skipped");
});

test("audit: 'already-filled-match' records are NOT audited either (bot never actuated them)", () => {
  const entries = auditEntriesFromResults([
    { fieldName: "a", widgetType: "dropdown", status: "filled", auditLoc: "L1", after: "X", flag: "already-filled-match" },
    { fieldName: "b", widgetType: "text", status: "filled", auditLoc: "L2", after: "Y", flag: null },
  ]);
  assert.deepStrictEqual(entries.map((e) => e.key), ["b"], "only the bot-actuated record is audited");
});

// ── PRE-ADVANCE TRUTH RECON (before every re-Save&Continue: summary = exactly what's on the page) ──
test("reconPageTruth: deleted rows drop, the survivor shows the LIVE value, synthetic remediation rows never reach the bundle", async () => {
  // The Tier-0 dup-language shape: 2 filled language records; remediation deleted entry 0 →
  // ONE live entry ("Chinese") remains. The persisted summary must show exactly that: one
  // language row with the live value (flagged to verify — index shift), the other dropped,
  // and NO "Duplicate-language workaround" row.
  const results = [
    { fieldName: "language[0].language", label: "Language", widgetType: "dropdown", isRequired: false,
      mappedPath: "languages[0].language", rawValue: "English", resolved: "English",
      status: "filled", matchTier: null, confidence: null, flag: null, verified: true, after: "English", detail: null, auditLoc: "L0" },
    { fieldName: "language[1].language", label: "Language", widgetType: "dropdown", isRequired: false,
      mappedPath: "languages[1].language", rawValue: "Chinese", resolved: "Chinese",
      status: "filled", matchTier: null, confidence: null, flag: null, verified: true, after: "Chinese", detail: null, auditLoc: "L1" },
    { fieldName: "language.duplicate-fix", label: "Duplicate-language workaround", widgetType: "remediation",
      status: "needs_review", flag: "ai-remediation", after: null, detail: "AI-4 hardcoded fix" },
  ];
  const rscan = { sections: { "language-": { entries: [{ fields: [
    { fieldName: "language", label: "Language", widgetType: "dropdown", isRequired: false, value: "Chinese", wrapperSel: "LIVE0" },
  ] }] } } };
  const act = { scanPage: async () => ({ fields: [] }), repeatingScan: async () => rscan };
  await reconPageTruth(act, results);
  const r0 = results.find((r) => r.fieldName === "language[0].language");
  assert.strictEqual(r0.status, "needs_review", "the survivor's record refreshed + flagged (index shift)");
  assert.strictEqual(r0.flag, "recon-mismatch");
  assert.strictEqual(r0.after, "Chinese", "the LIVE value, not the deleted row's");
  const r1 = results.find((r) => r.fieldName === "language[1].language");
  assert.strictEqual(r1.status, "removed", "the deleted row's record drops");
  assert.strictEqual(r1.flag, "recon-removed");
  const bundle = buildReviewBundle(results, { page: "p" });
  assert.ok(!bundle.entries.some((e) => e.widget_type === "remediation"), "synthetic remediation rows NEVER reach the bundle");
  assert.ok(!bundle.entries.some((e) => e.canonical_field === "languages[1].language"), "removed row not in the bundle");
  assert.strictEqual(bundle.entries.filter((e) => /language\[\d+\]\.language/.test(e.field_id)).length, 1, "exactly the ONE live row");
});

test("reconPageTruth: an emptied section drops ALL its records; a failed repeatingScan never mass-removes", async () => {
  const mk = () => [{ fieldName: "language[0].language", label: "Language", widgetType: "dropdown", isRequired: false,
    mappedPath: "languages[0].language", rawValue: "English", resolved: "English",
    status: "filled", flag: null, verified: true, after: "English", detail: null, auditLoc: "L0" }];
  // (a) section emptied (absent from the scan) → the record drops
  const emptied = mk();
  await reconPageTruth({ scanPage: async () => ({ fields: [] }), repeatingScan: async () => ({ sections: {} }) }, emptied);
  assert.strictEqual(emptied[0].status, "removed", "phantom-dup delete-all → the record drops");
  // (b) repeatingScan THROWS → guard: keep everything (never mass-remove on a transient scan failure)
  const guarded = mk();
  await reconPageTruth({ scanPage: async () => ({ fields: [] }), repeatingScan: async () => { throw new Error("boom"); } }, guarded);
  assert.strictEqual(guarded[0].status, "filled", "scan failure → records untouched");
});

test("reconPageTruth: a deleted NESTED row (probed auditLoc stops resolving) drops; no selExists seam → kept", async () => {
  const mk = () => [{ fieldName: "certification[0].specialties[0].specialtyParent", label: "specialtyParent", widgetType: "typeahead",
    isRequired: false, mappedPath: "certification[0].specialties[0].specialtyParent", rawValue: "Other", resolved: ["Other"],
    status: "filled_review", flag: "ai-choice", verified: true, after: "Other", detail: null,
    auditLoc: "PROBED-sp", nested_parent: { base: "certification", index: 0 }, nested_child_base: "specialties" }];
  const base = { scanPage: async () => ({ fields: [] }), repeatingScan: async () => null };
  const gone = mk();
  await reconPageTruth(Object.assign({ selExists: async () => false }, base), gone);
  assert.strictEqual(gone[0].status, "removed", "Tier-1.5-deleted specialty row drops from the summary");
  const kept = mk();
  await reconPageTruth(base, kept); // no selExists seam (minimal fake) → never guess, keep
  assert.strictEqual(kept[0].status, "filled_review", "no existence seam → record kept as-is");
});

// ── reconPageTruth false-positive fixes (2026-07-03): the remediation recon wrongly flagged
// correctly-filled WE dates ("9/2024" input vs "09/2024" display) and unchecked checkboxes ─────
const weAct = (fields) => ({ scanPage: async () => ({ fields: [] }),
  repeatingScan: async () => ({ sections: { "workExperience-": { entries: [{ fields }] } } }) });

test("reconPageTruth: a correctly-filled WE date (input 9/2024 vs zero-padded display 09/2024) is NOT flagged", async () => {
  const results = [{ fieldName: "workExperience[0].startDate", label: "From", widgetType: "date",
    status: "filled", flag: null, verified: true, after: "9/2024", detail: "segments {...}" }];
  await reconPageTruth(weAct([{ fieldName: "startDate", widgetType: "date", value: "09/2024" }]), results);
  assert.strictEqual(results[0].status, "filled", "no spurious recon-mismatch on a zero-padding-only difference");
  assert.strictEqual(results[0].flag, null);
});

test("reconPageTruth: a GENUINELY changed WE date IS flagged (regression pin — the fix must not blind the recon)", async () => {
  const results = [{ fieldName: "workExperience[0].startDate", label: "From", widgetType: "date",
    status: "filled", flag: null, verified: true, after: "9/2024", detail: null }];
  await reconPageTruth(weAct([{ fieldName: "startDate", widgetType: "date", value: "10/2024" }]), results);
  assert.strictEqual(results[0].status, "needs_review");
  assert.strictEqual(results[0].flag, "recon-mismatch");
  assert.strictEqual(results[0].after, "10/2024", "refreshed to the live value");
  assert.match(results[0].detail, /live value changed/);
});

test("reconPageTruth: a truly EMPTY WE date (display shows placeholders → null) IS flagged EMPTY", async () => {
  const results = [{ fieldName: "workExperience[0].startDate", label: "From", widgetType: "date",
    status: "filled", flag: null, verified: true, after: "9/2024", detail: null }];
  await reconPageTruth(weAct([{ fieldName: "startDate", widgetType: "date", value: null }]), results);
  assert.strictEqual(results[0].status, "needs_review");
  assert.strictEqual(results[0].flag, "recon-mismatch");
  assert.match(results[0].detail, /EMPTY on the page/);
});

test("reconPageTruth: a correctly-UNCHECKED 'I currently work here' (live false) is NOT flagged EMPTY", async () => {
  const results = [{ fieldName: "workExperience[0].currentlyWorkHere", label: "I currently work here",
    widgetType: "checkbox", status: "filled", flag: null, verified: true, after: "false", detail: "already unchecked" }];
  await reconPageTruth(weAct([{ fieldName: "currentlyWorkHere", widgetType: "checkbox", value: false }]), results);
  assert.strictEqual(results[0].status, "filled", "an unchecked box is a valid state, not an empty field");
  assert.strictEqual(results[0].flag, null);
});

test("reconPageTruth: a genuinely CHANGED checkbox (record false, live true) IS flagged", async () => {
  const results = [{ fieldName: "workExperience[0].currentlyWorkHere", label: "I currently work here",
    widgetType: "checkbox", status: "filled", flag: null, verified: true, after: "false", detail: null }];
  await reconPageTruth(weAct([{ fieldName: "currentlyWorkHere", widgetType: "checkbox", value: true }]), results);
  assert.strictEqual(results[0].status, "needs_review");
  assert.strictEqual(results[0].flag, "recon-mismatch");
  assert.strictEqual(results[0].after, "true");
  assert.match(results[0].detail, /live value changed/);
});

test("sweep: a LIVE mapped value whose records were dropped is RE-ADDED as already-filled (the survivor row)", async () => {
  const results = [{ fieldName: "language[0].language", label: "Language", widgetType: "dropdown", isRequired: false,
    mappedPath: "languages[0].language", rawValue: "English", resolved: "English",
    status: "removed", flag: "recon-removed", verified: null, after: "English", detail: "row deleted" }];
  const rscan = { sections: { "language-": { entries: [{ fields: [
    { fieldName: "language", label: "Language", widgetType: "dropdown", isRequired: false, value: "Chinese", wrapperSel: "LIVE0" },
  ] }] } } };
  await sweepAlreadyFilled({ scanPage: async () => ({ fields: [] }), repeatingScan: async () => rscan }, results);
  const added = results.find((r) => r.fieldName === "language[0].language" && r.status !== "removed");
  assert.ok(added, "the live row re-added (its own record was dropped)");
  assert.strictEqual(added.flag, "already-filled");
  assert.strictEqual(added.after, "Chinese");
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
  // use a prefix NOT in PAGE_SECTIONS ("publication-") so it's genuinely unknown (Languages is known again).
  const catField = { wrapperSel: "C0", fieldName: "category", widgetType: "dropdown", label: "Category*", isRequired: false,
    options: [{ text: "Select One", disabled: true }, { text: "Alpha" }, { text: "Beta" }], triggerText: "Alpha" };
  const rscan = { url: "fake://p2", addButtons: [], sections: {
    "publication-": { entryCount: 1, heading: "Publications", entries: [{ fields: [
      { fieldName: "category", widgetType: "dropdown", label: "Category*", isRequired: true, value: "Alpha", wrapperSel: "C0" }
    ] }] }
  } };
  const out = await drivePageFill(makeFakeAct([catField], { rscan }), {}, {}, {}, T_BUDGETS);
  const rec = out.results.find((r) => r.fieldName === "publication[0].category");
  assert.ok(rec, "existing entry field surfaced");
  assert.strictEqual(rec.flag, "already-filled");
  assert.strictEqual(rec.status, "filled_review", "surfaced for review (not silently trusted, not bot-filled)");
  assert.strictEqual(rec.after, "Alpha", "current value read from the form");
  assert.match(rec.detail, /not filled by ApplyPilot/i);
  assert.ok(Array.isArray(rec.options) && rec.options.includes("Alpha") && rec.options.includes("Beta"), "dropdown options recon'd → editable in the summary");
  const be = buildReviewBundle(out.results, { page: "p2" }).entries.find((e) => e.canonical_field === "publication[0].category");
  assert.ok(be && be.needs_review && be.current_value === "Alpha", "in the bundle: needs_review + current_value = the existing value");
  const stub = out.results.find((r) => r.widgetType === "section_stub" && r.fieldName === "publication");
  assert.ok(stub && stub.section_heading === "Publications", "section stub under the REAL DOM heading");
  assert.ok(stub.section_field_shape.some((s) => Array.isArray(s.options) && s.options.includes("Alpha")), "stub shape carries recon'd options for add-entry");
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

test("m3b: an Add button INSIDE a repeating entry (nested Specialties) is SKIPPED — never revealed, no phantom mount", async () => {
  // The phantom-specialty bug: the cert entry's nested "Specialties" Add showed up in the page-wide
  // addButtons with an unknown heading → m3b clicked it → mounted an empty specialty row it could
  // neither see (no --null container, cert count unchanged) nor delete. Fix: insideEntry buttons
  // (any ancestor fkit with the -<digits>-- infix) are a nested sub-section's — skip them.
  const mkRscan = (inside) => ({ url: "fake://p2", sections: {}, addButtons: [
    { text: "Add", nearestHeading: "Specialties", insideEntry: inside, rect: { cx: 1, cy: 1 } },
  ] });
  // insideEntry: true → NEVER clicked, no stub
  const calls = [];
  const act = makeFakeAct([], { rscan: mkRscan(true) });
  act.clickSectionAdd = async (h) => { calls.push(h); return { ok: false }; };
  const out = await drivePageFill(act, {}, {}, {}, T_BUDGETS);
  assert.deepStrictEqual(calls, [], "the nested Add was never clicked");
  assert.ok(!out.results.some((r) => r.widgetType === "section_stub" && /specialt/i.test(r.label || "")), "no bogus top-level 'Specialties' stub");
  // control — insideEntry: false (a genuine top-level unknown Add) → the reveal path DOES fire
  const calls2 = [];
  const act2 = makeFakeAct([], { rscan: mkRscan(false) });
  act2.clickSectionAdd = async (h) => { calls2.push(h); return { ok: false }; }; // refuse → reveal null, but the CLICK proves the path ran
  await drivePageFill(act2, {}, {}, {}, T_BUDGETS);
  assert.strictEqual(calls2.length, 1, "a top-level unknown Add still goes through reveal-by-add");
});

test("revealUnknownSection: a mis-click that mounts a NESTED row (no new/grown prefix) → deleted via clickNestedDelete, returns null", async () => {
  // Backstop: clickSectionAdd anchors page-wide by heading, so it can land on a nested Add. The
  // mount is INVISIBLE to the prefix/grown detection — the nestedScan diff finds + deletes it.
  let nestedRows = [5]; // one pre-existing specialty (must NOT be touched)
  const fake = {
    log: [], delay: async () => {},
    repeatingScan: async () => ({ addButtons: [], sections: {
      "certification-": { entryCount: 1, heading: "Certifications", entries: [{ fields: [] }] } // static — never grows
    } }),
    nestedScan: async () => ({ parentOrder: { certification: [172] }, nestedSections: [{ parentBase: "certification", childBase: "specialties",
      entries: nestedRows.map((ci) => ({ levels: [{ base: "certification", index: 172 }, { base: "specialties", index: ci }], fields: [] })) }] }),
    clickSectionAdd: async () => { nestedRows.push(9); return { ok: true }; }, // the mis-click mounts a nested row
    clickNestedDelete: async (pf, base, idx) => { fake.log.push(["ndel", pf, base, idx]); nestedRows = nestedRows.filter((c) => String(c) !== String(idx)); return { ok: true }; },
    clickDeleteEntry: async () => { fake.log.push(["del-top"]); return { ok: true }; },
  };
  const r = await revealUnknownSection(fake, "Specialties", T_BUDGETS);
  assert.strictEqual(r, null, "not a top-level section → no reveal");
  assert.deepStrictEqual(fake.log, [["ndel", "certification-172--null", "specialties", 9]], "exactly the mounted nested row deleted (scoped to the right parent)");
  assert.deepStrictEqual(nestedRows, [5], "the pre-existing specialty untouched — no leftover phantom");
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

test("revealUnknownSection: FLAT typeahead → scans its OPTIONS into the shape (empty section → combobox, not a tier box)", async () => {
  // The empty-Education bug: revealUnknownSection recon'd the fieldOfStudy typeahead, but the m3b stub
  // DROPPED the options → the summary showed a tier editor. This pins that the recon PRODUCES options
  // (a flat typeahead → widget_type stays "typeahead" + options); the m3b stub now carries them
  // (options: s.options || null, line ~2354 — the same fix as the m3a stub at ~2289).
  let mounted = false;
  const fake = {
    delay: async () => {}, delayFull: async () => {},
    repeatingScan: async () => ({ addButtons: [], sections: mounted ? {
      "education-": { entryCount: 1, heading: "Education", entries: [{ fields: [
        { fieldName: "fieldOfStudy", widgetType: "typeahead", label: "Field of Study", isRequired: false, wrapperSel: "SEL_FOS" },
      ] }] }
    } : {} }),
    clickSectionAdd: async () => { mounted = true; return { ok: true }; },
    clickDeleteEntry: async () => { mounted = false; return { ok: true }; },
    openHier: async () => true,
    readHier: async () => ({ searchBox: { visible: true, focused: true } }),
    readTreeCategories: async () => [], // NO categories → a FLAT typeahead
    focusHierSearch: async () => true,
    scrapeTaOptions: async () => ({ ok: true, options: ["Physics", "Chemistry", "Biology"] }),
    pressTab: async () => {},
  };
  const r = await revealUnknownSection(fake, "Education", T_BUDGETS);
  const fos = r.shape.find((s) => s.recName === "fieldOfStudy");
  assert.strictEqual(fos.widget_type, "typeahead", "flat → stays typeahead (combobox), not hierarchical");
  assert.deepStrictEqual(fos.options, ["Physics", "Chemistry", "Biology"], "options scanned into the shape → summary combobox");
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

test("repeating dropdown AI canonicalize (Phase 1): a STATED degree that isn't in the option vocab is reworded (ai-canonicalized), not left unfilled", async () => {
  // Education degree DROPDOWN; the profile's stated "Bachelor of Science" isn't among the form's options
  // (only Bachelors/Masters) → genuine no-match. Repeating dropdowns had ZERO AI before; now aiCanonicalize
  // rewords the STATED value (never a guess) → filled_review / ai-canonicalized, so ONLY this field flags.
  const state = {
    prefix: "education-",
    entries: [{ fkit: "education-1--null", fields: [
      { fieldName: "degree", label: "Degree*", widgetType: "dropdown", isRequired: true, triggerText: null,
        options: [{ text: "Bachelors" }, { text: "Masters" }] },
    ] }],
    addable: false, aiEnabled: true, ai: '{"choice":"Bachelors","confidence":"High"}',
  };
  const act = makeFakeRepeatAct(state);
  const fieldMap = [{ field: "degree", widget: "dropdown", key: "degree", path: "degree" }];
  const out = await driveRepeatingSectionCdp(act, {
    name: "education", headingRegex: "education", containerPrefix: "education-",
    items: [{ degree: ["Bachelor of Science"] }], fieldMap, deleteOnNoMatch: false,
    aiContext: { profile: {}, jobContext: {} },
  }, T_BUDGETS);
  const rec = out.results.find((r) => r.fieldName === "education[0].degree");
  assert.strictEqual(rec.status, "filled_review", "canonicalized → filled_review (flagged for a glance)");
  assert.strictEqual(rec.flag, "ai-canonicalized", "provenance: mapped a STATED value, not a guess");
  assert.strictEqual(rec.after, "Bachelors", "reworded to the form's vocab");
  assert.ok(act.log.some(([m]) => m === "llm"), "consulted the LLM to canonicalize");
  // keepOpenForCanonicalize: the dropdown is opened ONCE — fillDropdownCdp leaves the no-match list OPEN
  // and aiCanonicalizeField REUSES it (no redundant close→reopen: the "open it once" operator ask).
  assert.strictEqual(act.log.filter(([m]) => m === "openDropdown").length, 1, "opened once — no close→reopen for the canonicalize");
});

test("Phase 2 delete-with-memory: education (expected-data) + AI ON + an unfillable required field → entry DELETED but REMEMBERED (add-back prefills school+degree)", async () => {
  // school + degree fill deterministically; fieldOfStudy is required but has no profile value and no AI
  // resolution (2a: dropdowns have no infer) → the whole entry is delete-with-memory'd (advance the walk,
  // supersedes keep-and-halt, D4), remembering school+degree for prefill + recording fieldOfStudy as missing.
  const eduEntry = (fkit) => ({ fkit, fields: [
    { fieldName: "schoolName", label: "School*", widgetType: "text", isRequired: true, value: "" },
    { fieldName: "degree", label: "Degree*", widgetType: "dropdown", isRequired: true, triggerText: null, options: [{ text: "Bachelors" }] },
    { fieldName: "fieldOfStudy", label: "Field of Study*", widgetType: "dropdown", isRequired: true, triggerText: null, options: [{ text: "Accounting" }, { text: "Biology" }] },
  ] });
  const state = { prefix: "education-", addable: false, deletable: true, aiEnabled: true, ai: null, entries: [eduEntry("education-1--null")] };
  const act = makeFakeRepeatAct(state);
  const fieldMap = [
    { field: "schoolName", widget: "text", key: "school", path: "school_or_university" },
    { field: "degree", widget: "dropdown", key: "degree", path: "degree" },
    { field: "fieldOfStudy", widget: "dropdown", key: "fos", path: "field_of_study" },
  ];
  const out = await driveRepeatingSectionCdp(act, {
    name: "education", headingRegex: "education", containerPrefix: "education-",
    items: [{ school: "CMU", degree: ["Bachelors"] }], fieldMap, deleteOnNoMatch: false, // no fos value
    aiContext: { profile: {}, jobContext: {} },
  }, T_BUDGETS);
  assert.ok(act.log.some(([m]) => m === "clickDeleteEntry"), "AI on → delete-with-memory (advance the walk, not halt)");
  const rem = out.results.find((r) => r.widgetType === "removed_entry");
  assert.ok(rem, "delete-with-memory → a removed_entry card");
  assert.strictEqual(rem.flag, "entry-removed-remembered");
  const school = rem.remembered_fields.find((f) => f.recName === "schoolName");
  assert.ok(school && school.value === "CMU" && school.filled_by === "deterministic", "school remembered for prefill");
  const deg = rem.remembered_fields.find((f) => f.recName === "degree");
  assert.ok(deg && deg.value === "Bachelors" && deg.filled_by === "deterministic", "degree remembered for prefill");
  assert.ok(rem.unfilled_fields.some((u) => u.recName === "fieldOfStudy"), "the missing required field is recorded");
});

test("Phase 2: education (expected-data) + AI OFF + an unfillable required field → entry KEPT (walk halts), NOT delete-with-memory", async () => {
  // AI off + expected-data section → NEVER delete/advance: keep the entry with the unfilled required field
  // → Save & Continue fails → the walk HALTS for the operator (D1). Never destroy data blind.
  const eduEntry = (fkit) => ({ fkit, fields: [
    { fieldName: "schoolName", label: "School*", widgetType: "text", isRequired: true, value: "" },
    { fieldName: "fieldOfStudy", label: "Field of Study*", widgetType: "dropdown", isRequired: true, triggerText: null, options: [{ text: "Accounting" }] },
  ] });
  const state = { prefix: "education-", addable: false, aiEnabled: false, entries: [eduEntry("education-1--null")] };
  const act = makeFakeRepeatAct(state);
  const fieldMap = [
    { field: "schoolName", widget: "text", key: "school", path: "school_or_university" },
    { field: "fieldOfStudy", widget: "dropdown", key: "fos", path: "field_of_study" },
  ];
  const out = await driveRepeatingSectionCdp(act, {
    name: "education", headingRegex: "education", containerPrefix: "education-",
    items: [{ school: "CMU" }], fieldMap, deleteOnNoMatch: false, aiContext: null,
  }, T_BUDGETS);
  assert.ok(!act.log.some(([m]) => m === "clickDeleteEntry"), "expected-data + AI off → NEVER delete (keep → halt)");
  assert.ok(!out.results.some((r) => r.widgetType === "removed_entry"), "no delete-with-memory when AI is off");
  const fos = out.results.find((r) => r.fieldName === "education[0].fieldOfStudy");
  assert.strictEqual(fos.status, "skipped", "the unfilled required field is kept (skipped) → deriveReview flags it → blocks Save → walk halts");
  assert.strictEqual(fos.isRequired, true);
});

test("Phase 2b: required-empty repeating DROPDOWN + AI ON infers CONFIDENTLY → the field fills (ai-choice), the entry is KEPT", async () => {
  // fieldOfStudy is a required DROPDOWN with no profile value. Repeating dropdowns now infer (2b): the AI
  // returns a High-confidence represented pick → the field fills (ai-choice) and the entry is KEPT (a
  // confident fill resolves the field; only IT flags). A low-confidence / forced pick would instead feed
  // delete-with-memory (2a). Repeating dropdowns had NO infer before.
  const eduEntry = (fkit) => ({ fkit, fields: [
    { fieldName: "schoolName", label: "School*", widgetType: "text", isRequired: true, value: "" },
    { fieldName: "fieldOfStudy", label: "Field of Study*", widgetType: "dropdown", isRequired: true, triggerText: null, options: [{ text: "Computer Science" }, { text: "Biology" }] },
  ] });
  const state = { prefix: "education-", addable: false, deletable: true, aiEnabled: true, ai: '{"choice":"Computer Science","justification":"prior CS coursework","confidence":"High"}', entries: [eduEntry("education-1--null")] };
  const act = makeFakeRepeatAct(state);
  const fieldMap = [
    { field: "schoolName", widget: "text", key: "school", path: "school_or_university" },
    { field: "fieldOfStudy", widget: "dropdown", key: "fos", path: "field_of_study" },
  ];
  const out = await driveRepeatingSectionCdp(act, {
    name: "education", headingRegex: "education", containerPrefix: "education-",
    items: [{ school: "CMU" }], fieldMap, deleteOnNoMatch: false, // no fos value → AI infers
    aiContext: { profile: {}, jobContext: {} },
  }, T_BUDGETS);
  assert.ok(!act.log.some(([m]) => m === "clickDeleteEntry"), "a CONFIDENT infer KEEPS the entry (no delete-with-memory)");
  assert.ok(!out.results.some((r) => r.widgetType === "removed_entry"), "not delete-with-memory");
  const fos = out.results.find((r) => r.fieldName === "education[0].fieldOfStudy");
  assert.strictEqual(fos.status, "filled_review", "the inferred dropdown fills (flagged for review)");
  assert.strictEqual(fos.flag, "ai-choice");
  assert.strictEqual(fos.after, "Computer Science");
  assert.ok(act.log.some(([m]) => m === "llm"), "consulted the LLM to infer the required-empty dropdown");
});

test("Phase 2 fix: a PROVIDED value the AI maps to the form vocab (canonicalize) is KEPT + high-confidence, even at LOW AI confidence", async () => {
  // Operator bug: degree profile "Bachelor of Science" vs a form offering only "Bachelors" → genuine
  // no-match → aiCanonicalizeField maps it (ai-canonicalized) but the AI self-reported LOW confidence, so
  // it was wrongly treated as an unconfident guess and delete-with-memory'd. A value that's IN the profile
  // (just reworded) is a canonicalization, not a guess → KEEP + treat as high confidence. deletable:true so
  // the OLD behavior WOULD have deleted it.
  const state = {
    prefix: "education-",
    entries: [{ fkit: "education-1--null", fields: [
      { fieldName: "degree", label: "Degree*", widgetType: "dropdown", isRequired: true, triggerText: null, options: [{ text: "Bachelors" }, { text: "Masters" }] },
    ] }],
    addable: false, deletable: true, aiEnabled: true, ai: '{"choice":"Bachelors","confidence":"Low"}',
  };
  const act = makeFakeRepeatAct(state);
  const fieldMap = [{ field: "degree", widget: "dropdown", key: "degree", path: "degree" }];
  const out = await driveRepeatingSectionCdp(act, {
    name: "education", headingRegex: "education", containerPrefix: "education-",
    items: [{ degree: ["Bachelor of Science"] }], fieldMap, deleteOnNoMatch: false,
    aiContext: { profile: {}, jobContext: {} },
  }, T_BUDGETS);
  assert.ok(!act.log.some(([m]) => m === "clickDeleteEntry"), "a canonicalized PROVIDED value is KEPT, not delete-with-memory'd");
  assert.ok(!out.results.some((r) => r.widgetType === "removed_entry"), "no delete-with-memory");
  const deg = out.results.find((r) => r.fieldName === "education[0].degree");
  assert.strictEqual(deg.status, "filled_review", "kept + flagged for a glance");
  assert.strictEqual(deg.flag, "ai-canonicalized");
  assert.strictEqual(deg.after, "Bachelors");
  assert.strictEqual(deg.confidence, "high", "a provided-value map is treated as HIGH confidence (was low → deleted)");
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
  // Phase 2 delete-with-memory: each deleted entry → a removed_entry card (not a dropped "removed" op).
  const removed = out.results.filter((r) => r.widgetType === "removed_entry");
  assert.strictEqual(removed.length, 2);
  assert.ok(removed.every((r) => r.status === "skipped" && r.flag === "entry-removed-remembered" && /removed/i.test(r.detail)));
  assert.ok(removed.every((r) => Array.isArray(r.unfilled_fields) && r.unfilled_fields.length), "carries the unfilled field (why it was removed)");
});

test("repeating delete-on-no-match: EMPTYING the section surfaces a removed_entry card (delete-with-memory), not vanished", async () => {
  // Phase 2 (delete-with-memory): when a genuine no-match deletes an entry, it's not dropped — a
  // removed_entry record carries its recon + remembered values so the review shows an add-back card.
  // (Supersedes the old "emptied → section_stub" behavior.)
  const mk = (fkit) => ({ fkit, fields: [{ fieldName: "x", label: "X*", widgetType: "dropdown", isRequired: true, triggerText: null, options: [{ text: "Alpha" }, { text: "Beta" }] }] });
  const state = webState({ prefix: "certification-", entries: [mk("certification-1--null")] });
  const fieldMap = [{ field: "x", widget: "dropdown", key: "x", path: "x" }];
  const act = makeFakeRepeatAct(state);
  const out = await driveRepeatingSectionCdp(act, {
    name: "certification", headingRegex: "certifications?", containerPrefix: "certification-",
    items: [{ x: "Zzz-nomatch" }], fieldMap, deleteOnNoMatch: true
  }, T_BUDGETS);
  assert.strictEqual(await act.entryCount("certification-"), 0, "the only entry was deleted");
  const rem = out.results.find((r) => r.widgetType === "removed_entry");
  assert.ok(rem, "the deleted entry surfaces as a removed_entry card (not vanished)");
  assert.strictEqual(rem.flag, "entry-removed-remembered");
  assert.strictEqual(rem.container_prefix, "certification-"); // backend identifier for the future add-back
  assert.ok(Array.isArray(rem.section_field_shape) && rem.section_field_shape.length, "carries the field shape so add-back works");
  assert.ok(Array.isArray(rem.remembered_fields), "carries remembered_fields to prefill on add-back");
  assert.ok(Array.isArray(rem.unfilled_fields) && rem.unfilled_fields.length, "records the field that couldn't fill");
  assert.match(rem.detail, /removed/i);
  // ...and it SURVIVES into the bundle as a needs_review add-back item.
  const entries = buildReviewBundle(out.results, {}).entries;
  const remEntry = entries.find((e) => e.widget_type === "removed_entry" && /certification/.test(e.field_id || ""));
  assert.ok(remEntry, "the removed_entry reaches the bundle → shows on the review page");
  assert.strictEqual(remEntry.needs_review, true, "a removed entry is a review item (add it back + supply the missing field)");
  assert.strictEqual(remEntry.needs_review_reason, "entry_removed");
  assert.ok(Array.isArray(remEntry.remembered_fields), "remembered_fields ride into the bundle");
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
  const rem = out.results.find((r) => r.widgetType === "removed_entry");
  assert.ok(rem, "emptied section → a removed_entry card");
  const dShape = rem.section_field_shape.find((s) => s.recName === "d");
  assert.ok(dShape, "the date field is in the removed_entry's recon shape");
  assert.deepStrictEqual(dShape.date_order, ["year"], "date_order captured from the live entry (fake date field = year-only) → segmented add-back editor");
});

test("deleteOnNoMatch cert emptied → the stub carries the HARDCODED nested_shapes (add-back shows Specialties)", async () => {
  // A bogus cert → deleteOnNoMatch removes the whole section. Because the nested shape is HARDCODED
  // (section.nested), it survives the deletion + rides the removed-section stub so the operator can
  // add a cert back and see its Specialties (+ attachments). The LIVE entry scan sees the nested
  // child fields + the Attachments input INSIDE the cert container — the captured FLAT shape must
  // EXCLUDE them (operator bug: an added-back entry showed Specialty/Start/End flat in the cert +
  // TWO Attachments boxes — they render via nested_shapes / nested_attachments instead).
  const mk = (fkit) => ({ fkit, fields: [
    { fieldName: "certification", label: "Certification*", widgetType: "dropdown", isRequired: true, triggerText: null, options: [{ text: "PMP" }] },
    { fieldName: "certificationNumber", label: "Certification Number", widgetType: "text", value: "" },
    { fieldName: "specialtyParent", label: "Specialty*", widgetType: "typeahead", isRequired: true }, // nested — inside the container
    { fieldName: "startDate", label: "Start Date", widgetType: "date" },                              // nested
    { fieldName: "endDate", label: "End Date", widgetType: "date" },                                  // nested
    { fieldName: "attachments", label: "Attachments", widgetType: "file_upload" },                    // per-entry attach input
  ] });
  const state = webState({ prefix: "certification-", entries: [mk("certification-287--null")] });
  const fieldMap = [{ field: "certification", widget: "dropdown", key: "cert", path: "certification" }];
  const act = makeFakeRepeatAct(state);
  const out = await driveRepeatingSectionCdp(act, {
    name: "certification", headingRegex: "certifications?", containerPrefix: "certification-",
    items: [{ cert: "Zzz-bogus" }], fieldMap, deleteOnNoMatch: true, nested: CERT_NESTED
  }, T_BUDGETS);
  assert.strictEqual(await act.entryCount("certification-"), 0, "bogus cert deleted → section empty");
  const rem = out.results.find((r) => r.widgetType === "removed_entry");
  assert.ok(rem && rem.nested_shapes && Array.isArray(rem.nested_shapes.specialties), "the removed cert's card carries the hardcoded Specialties shape");
  assert.strictEqual(rem.nested_shapes.specialties[0].recName, "specialtyParent");
  assert.deepStrictEqual(rem.nested_shapes.specialties[1].date_order, ["month", "day", "year"], "nested date field kept its segment order");
  assert.strictEqual(rem.nested_attachments, true, "the card knows the section has attachments (add-back offers a picker)");
  assert.ok(!out.results.some((r) => r.widgetType === "nested_section_stub"), "a deleted cert → NO per-entry nested stub");
  const flatNames = rem.section_field_shape.map((s) => s.recName);
  assert.ok(flatNames.includes("certification") && flatNames.includes("certificationNumber"), "the cert's OWN fields stay in the flat shape");
  assert.ok(!flatNames.includes("specialtyParent") && !flatNames.includes("startDate") && !flatNames.includes("endDate"),
    "nested child fields EXCLUDED from the flat shape — Specialty renders ONLY as the sub-section");
  assert.ok(!rem.section_field_shape.some((s) => s.widget_type === "file_upload"),
    "the per-entry Attachments input EXCLUDED — nested_attachments renders the single picker (no double box)");
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
    // Segment-scoped clear (the triple-click selection): empties ONLY the focused segment.
    pressBackspace: async () => { log.push(["pressBackspace", focused]); if (focused && segs[focused]) segs[focused].value = ""; },
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
const runDate = (segs, parsed, opts, budgetOverrides) => {
  const act = makeFakeDateAct(segs, opts);
  return fillDateCompositeCdp(act, { wrapperSel: "[w-date]" }, parsed,
    budgetOverrides ? { ...T_BUDGETS, ...budgetOverrides } : T_BUDGETS).then((rec) => ({ rec, act }));
};

// ── forceSegmentTransition (2026-08-05) ─────────────────────────────────────
// Live on waystar's Self Identify page during a REPLAY: Workday reported "The field Date is required
// and must have a value" on a composite whose DOM, React props AND React fiber all held 8/5/2026 with
// ariaInvalid null. The phantom-required remedy re-typed the same digits over the triple-click
// selection — a byte-identical write, so no value transition ever reached Workday's model, and the
// page stayed blocked. These pin that the flag produces a real empty→value transition, and that an
// ordinary fill is completely unaffected by its existence.
test("date composite: forceSegmentTransition EMPTIES each segment before re-typing the SAME value", async () => {
  const segs = { Month: { value: "8" }, Day: { value: "5" }, Year: { value: "2026" } };
  const { rec, act } = await runDate(segs, { month: "8", day: "5", year: "2026" }, undefined,
    { forceSegmentTransition: true });
  assert.strictEqual(rec.status, "filled", rec.detail);
  assert.strictEqual(rec.after, "8/5/2026", "ends on the same value it started with");
  // The point is the TRANSITION, so assert the ordering per segment: focus → backspace → type.
  const seq = act.log.filter(([m]) => /focusDateSegment|pressBackspace|typeDigits/.test(m));
  for (const seg of ["Month", "Day", "Year"]) {
    const f = seq.findIndex(([m, s]) => m === "focusDateSegment" && s === seg);
    const b = seq.findIndex(([m, s]) => m === "pressBackspace" && s === seg);
    const t = seq.findIndex(([m, s]) => m === "typeDigits" && s === seg);
    assert.ok(f >= 0 && b > f && t > b,
      `${seg}: expected focus→backspace→type, got ${JSON.stringify(seq.map((x) => x.slice(0, 2)))}`);
  }
});

test("date composite: WITHOUT the flag no Backspace is ever sent (ordinary fills unchanged)", async () => {
  const segs = { Month: { value: "8" }, Day: { value: "5" }, Year: { value: "2026" } };
  const { rec, act } = await runDate(segs, { month: "8", day: "5", year: "2026" });
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(act.log.filter(([m]) => m === "pressBackspace").length, 0,
    "the ordinary date path must not gain a keystroke: " + JSON.stringify(act.log.map((x) => x[0])));
});

test("date composite: forceSegmentTransition still fills when the substrate has no pressBackspace", async () => {
  // Older/other substrates: the flag must degrade to today's behaviour, never throw.
  const segs = { Month: seg0(), Year: seg0() };
  const act = makeFakeDateAct(segs);
  delete act.pressBackspace;
  const rec = await fillDateCompositeCdp(act, { wrapperSel: "[w-date]" }, { month: "12", year: "2024" },
    { ...T_BUDGETS, forceSegmentTransition: true });
  assert.strictEqual(rec.status, "filled", rec.detail);
  assert.strictEqual(rec.after, "12/2024");
});

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

test("fillEntryCdp fills in the ENTRY'S DOM order — the fluent checkbox actuates at its page position (second)", async () => {
  // Magna lays Languages out as: Language → "I am fluent" → the proficiencies. The fill follows the
  // FORM's order (detected from the entry scan each fill), not LANGUAGE_MAP config order (checkbox
  // last). Outcomes are unchanged — only the actuation order moves.
  const fkit = "language-6--null";
  const domEntry = { fkit, fields: [
    { fieldName: "language", label: "Language*", widgetType: "dropdown", isRequired: true, triggerText: "Select One", options: LANG_OPTS },
    { fieldName: "native", label: "I am fluent in this language.", widgetType: "checkbox", isRequired: false, inputId: fkit + "-native", checked: false },
    { fieldName: "5aaaedREAD", label: "Reading Proficiency*", widgetType: "dropdown", isRequired: true, triggerText: "Select One", options: PROF_OPTS },
    { fieldName: "5aaaedSPEAK", label: "Speaking Proficiency*", widgetType: "dropdown", isRequired: true, triggerText: "Select One", options: PROF_OPTS },
    { fieldName: "5aaaedWRITE", label: "Writing Proficiency*", widgetType: "dropdown", isRequired: true, triggerText: "Select One", options: PROF_OPTS },
  ] };
  const state = { prefix: "language-", addable: true, deletable: true, newEntry: (i) => langEntry("language-new" + i), entries: [domEntry] };
  const act = makeFakeRepeatAct(state);
  const out = await driveRepeatingSectionCdp(act, {
    name: "language", headingRegex: "languages?", containerPrefix: "language-",
    items: [EN], fieldMap: LANGUAGE_MAP, deleteOnNoMatch: true
  }, T_BUDGETS);
  const iCheck = act.log.findIndex((l) => l[0] === "clickCheckboxLabel");
  const iRead = act.log.findIndex((l) => l[0] === "openDropdown" && /5aaaedREAD/.test(String(l[1])));
  assert.ok(iCheck !== -1 && iRead !== -1, "both the checkbox and the reading dropdown actuated");
  assert.ok(iCheck < iRead, "the fluent checkbox filled at its DOM position (before the proficiencies)");
  assert.strictEqual(out.needsReview.length, 0, "outcomes unchanged — only the order moved");
  assert.strictEqual(out.results.find((r) => r.fieldName === "language[0].native").status, "filled");
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
    // appearsAtScan 4: reconcile scan (1) + the DOM-ORDER pre-scan (2) + the first scanFd (3, absent)
    // → present on the poll's re-scan (4). Models the remount landing AFTER the first lookup.
    { fieldName: "endDate", label: "To", widgetType: "date", segments: { Month: { value: "" }, Year: { value: "" } }, appearsAtScan: 4 }
  ] }]);
  const item = { toParsed: { year: "2022", month: "06" } };
  // WITHOUT waitForPresence: the first scanFd misses the not-yet-remounted endDate → error.
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

// ── M40 audit — BATCHED re-read (one round-trip via act.readAuditRaw) ─────────
// The batched path (reconcileAudit → act.readAuditRaw) must yield the IDENTICAL verdicts as the
// per-field path — it changes only HOW the raw reads are fetched (ONE call vs N), not the mapping.
// makeAuditActBatched builds readAuditRaw from the SAME per-field reads makeAuditAct exposes, and
// SPIES (via un-wrapped originals) so a test can assert the per-field reads are NOT used when
// readAuditRaw is present, and readAuditRaw is called exactly once for the whole page.
function makeAuditActBatched(live) {
  const base = makeAuditAct(live);
  const orig = {};
  const calls = { readAuditRaw: 0, perField: 0 };
  ["readTextValue", "readDropdownState", "readCheckboxState", "readRadioState", "readHier", "readSource", "readDateSegment"].forEach((name) => {
    orig[name] = base[name];
    base[name] = async (...a) => { calls.perField++; return orig[name](...a); };
  });
  base.readAuditRaw = async (specs) => {
    calls.readAuditRaw++;
    // one call → all raw reads; mirrors cdp.js cdpReadAuditRaw's per-widget dispatch (raw shapes only).
    return Promise.all((specs || []).map(async (s) => {
      const loc = { wrapperSel: s.wrapperSel };
      switch (s.widgetType) {
        case "text": case "textarea": return orig.readTextValue(loc, s.tag);
        case "dropdown": return orig.readDropdownState(loc);
        case "checkbox": return orig.readCheckboxState(loc);
        case "radio": return orig.readRadioState(loc);
        case "typeahead": return orig.readHier(loc);
        case "hierarchical": return orig.readSource(loc);
        case "date": { const out = []; for (const seg of (s.dateSegs || [])) out.push(await orig.readDateSegment(loc, seg)); return out; }
        default: return null;
      }
    }));
  };
  base._calls = calls;
  return base;
}
const auditVerdictBatched = async (entry, liveForKey) => {
  const act = makeAuditActBatched({ "[w]": liveForKey });
  const v = await reconcileAudit(act, [Object.assign({ key: "k", auditLoc: "[w]" }, entry)], T_BUDGETS);
  return { verdict: v[0].verdict, calls: act._calls };
};

test("M40 audit BATCHED: verdict PARITY with the per-field path across every widget (+ one round-trip, no per-field reads)", async () => {
  const cases = [
    [{ widgetType: "dropdown", expected: "Bachelors" }, { trigger: "Associates" }],                          // mismatch
    [{ widgetType: "dropdown", expected: "United States of America" }, { trigger: "United States of America" }], // normalize match
    [{ widgetType: "text", expected: "Tallahassee, FL" }, { text: "Pittsburgh, PA" }],                        // mismatch
    [{ widgetType: "text", expected: "Tallahassee, FL" }, { text: "Tallahassee, FL" }],                       // match
    [{ widgetType: "checkbox", expected: "true" }, { checked: true }],                                        // match
    [{ widgetType: "checkbox", expected: "true" }, { checked: false }],                                       // mismatch
    [{ widgetType: "radio", expected: "Yes" }, { radioLabel: "Yes" }],                                        // match
    [{ widgetType: "typeahead", expected: "Other" }, { chips: ["Electrical Engineering"] }],                  // mismatch
    [{ widgetType: "hierarchical", expected: "LinkedIn" }, { chips: ["LinkedIn"] }],                          // match
    [{ widgetType: "date", expected: "6/15/2024" }, { segments: { Month: "6", Day: "15", Year: "2024" } }],   // match
    [{ widgetType: "date", expected: "6/15/2024" }, { segments: { Month: "1", Day: "15", Year: "2024" } }],   // mismatch
    [{ widgetType: "dropdown", expected: "Bachelors" }, { missing: true }],                                   // unverifiable
    [{ widgetType: "date", expected: "2024" }, { missing: true }]                                             // unverifiable
  ];
  for (const [entry, live] of cases) {
    const perField = await auditVerdict(entry, live);
    const b = await auditVerdictBatched(entry, live);
    assert.strictEqual(b.verdict, perField, `verdict parity for ${entry.widgetType} ${JSON.stringify(live)}`);
    assert.strictEqual(b.calls.readAuditRaw, 1, "readAuditRaw called exactly once (N→1 round-trip)");
    assert.strictEqual(b.calls.perField, 0, "per-field reads NOT used when readAuditRaw is present");
  }
});

test("M40 audit BATCHED: a whole page of fields → ONE readAuditRaw call for all of them", async () => {
  const act = makeAuditActBatched({
    "[w1]": { trigger: "Associates" },
    "[w2]": { text: "Tallahassee, FL" },
    "[w3]": { segments: { Month: "6", Day: "15", Year: "2024" } }
  });
  const verdicts = await reconcileAudit(act, [
    { key: "k1", auditLoc: "[w1]", widgetType: "dropdown", expected: "Bachelors" },
    { key: "k2", auditLoc: "[w2]", widgetType: "text", expected: "Tallahassee, FL" },
    { key: "k3", auditLoc: "[w3]", widgetType: "date", expected: "6/15/2024" }
  ], T_BUDGETS);
  assert.deepStrictEqual(verdicts.map((v) => v.verdict), ["mismatch", "match", "match"]);
  assert.strictEqual(act._calls.readAuditRaw, 1, "one round-trip for the whole page");
  assert.strictEqual(act._calls.perField, 0);
});

test("M40 audit BATCHED: a wrong-length batch result falls back to the per-field path (verdict still correct)", async () => {
  const act = makeAuditAct({ "[w]": { trigger: "Associates" } });
  act.readAuditRaw = async () => []; // shape mismatch (0 ≠ 1 entry) → guard rejects → per-field fallback
  const v = await reconcileAudit(act, [{ key: "k", auditLoc: "[w]", widgetType: "dropdown", expected: "Bachelors" }], T_BUDGETS);
  assert.strictEqual(v[0].verdict, "mismatch");
});

test("M40 audit BATCHED: readAuditRaw throwing falls back to per-field (never aborts the audit)", async () => {
  const act = makeAuditAct({ "[w]": { text: "Tallahassee, FL" } });
  act.readAuditRaw = async () => { throw new Error("boom"); };
  const v = await reconcileAudit(act, [{ key: "k", auditLoc: "[w]", widgetType: "text", expected: "Tallahassee, FL" }], T_BUDGETS);
  assert.strictEqual(v[0].verdict, "match");
});

// ── AI-4: validation-error remediation ──────────────────────────────────────
// The remediation LOOP itself lives in runCdpWalk (SW glue — live-verified eyes-on, not unit-tested);
// these pin the decision/parse UNITS it depends on.
const { reconcileReviewPage, parseErrorFieldName, errorSetUnchanged, mappedFieldsFromErrors, isDuplicateLanguageError, languageEntriesFromResults, languageDeletionPlan, isDuplicateWebsiteError, websiteEntriesFromResults, websiteDeletionPlan, duplicateErrorSection, sectionEntriesFromResults, sectionDeletionPlan, findLiveSection, liveDupEntries, newlyRequiredGaps, requiredBlankOnPage, requiredEntriesAbsentFromScan, cascadeEntryFor, canonicalJobUrl, expandErrorSamples, externalGateHalt, isSelfIdPage } = require("../lib.js");

// ── expandErrorSamples — the concatenated-banner split (the 2026-07-01 live Tier-0 miss) ────────
test("AI-4 expandErrorSamples: splits Workday's CONCATENATED error banner into individual errors", () => {
  const banner = "Error-SpecialtyThe field Specialty is required and must have a value.Error-LanguageDuplicate language entries are not allowed.";
  assert.deepStrictEqual(expandErrorSamples([banner]), [
    "Error-SpecialtyThe field Specialty is required and must have a value.",
    "Error-LanguageDuplicate language entries are not allowed."
  ]);
});

test("AI-4 expandErrorSamples: Tier-0 regression — dup-language DETECTED in a banner the old 120-char slice hid it in", () => {
  // Live 2026-07-01: TWO specialty errors sat ahead of the language error in the one-element
  // banner, pushing "Duplicate language…" past the old 120-char sample cut → Tier 0 never fired.
  const banner = "Error-SpecialtyThe field Specialty () is required and must have a value.Error-SpecialtyThe field Specialty is required and must have a value.Error-LanguageDuplicate language entries are not allowed.";
  assert.strictEqual(isDuplicateLanguageError([banner.slice(0, 120)]), false, "the OLD truncated sample hid the dup-language error");
  assert.strictEqual(isDuplicateLanguageError(expandErrorSamples([banner])), true, "the expanded pieces expose it");
  const named = expandErrorSamples([banner]).map(parseErrorFieldName).filter(Boolean);
  assert.deepStrictEqual(named, ["Specialty ()", "Specialty"], "each split piece parses its own field name");
});

test("AI-4 expandErrorSamples: success toasts dropped, plain texts pass through, dedupe, empties skipped", () => {
  assert.deepStrictEqual(expandErrorSamples([
    "Kevin's Resume 2.pdf successfully uploaded",
    "Kevin's Resume 2.pdf successfully uploaded",
    "Some plain validation text",
    "Some plain validation text",
    "", null
  ]), ["Some plain validation text"]);
});
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

test("AI-4 isDuplicateWebsiteError: matches the live 'duplicate website URLs' text; false otherwise", () => {
  assert.strictEqual(isDuplicateWebsiteError(["Error-URLYou can't add duplicate website URLs."]), true);
  assert.strictEqual(isDuplicateWebsiteError(["You can't add duplicate website URLs"]), true);
  assert.strictEqual(isDuplicateWebsiteError(["Duplicate language entries are not allowed."]), false); // scoped to websites/URLs
  assert.strictEqual(isDuplicateWebsiteError(["The field <URL> is required."]), false);
  assert.strictEqual(isDuplicateWebsiteError([]), false);
});
// ── GENERIC phantom-duplicate support: EVERY repeating section (2026-07-27) ─────────────────────────
// Workday's backend appends instead of replacing, so its stored copy holds duplicates the FORM doesn't
// show — a visibly-clean page is rejected on Save & Continue. Website/language had bespoke handling;
// these generalize it to work experience / education / certifications too.
// ── findLiveSection / liveDupEntries — why the FIRST live phantom-duplicate fix deleted 0 of 2 rows ──
// It trusted a hardcoded fkit prefix ("webAddress-"). entryCount returned 0, the delete loop bailed on
// its first iteration, and the run reported "deleted 0/2" with no reason. The live scan DISCOVERS the
// prefixes actually in the DOM; these pin that we find the section through any of them.
const WEBSITE_CFG = { containerPrefix: "webAddress-", headingRegex: "websites?|web ?address" };

// ── newlyRequiredGaps / cascadeEntryFor — the page-5 cascade (2026-07-27) ───────────────────────────
// Filling an OPTIONAL name promoted "Date" and a checkbox group to REQUIRED. The approved bundle had no
// answer for either — one was absent, one was present-but-BLANK (it was optional when reviewed) — so
// Workday refused the page. These pin that BOTH shapes are caught and turned into review questions.
const DATE_FIELD = { fieldName: "date", label: "Date", widgetType: "date", isRequired: true, value: null };
const BOXES_FIELD = {
  fieldName: "checkboxGroup", label: "Please check one of the boxes below:", widgetType: "checkbox_group",
  isRequired: true, value: null,
  checkboxes: [{ labelText: "Yes, I have a disability" }, { labelText: "No, I don't have a disability" }, { labelText: "I don't wish to answer" }],
};

test("newlyRequiredGaps: catches BOTH a field missing from the bundle AND one present-but-blank", () => {
  const live = [DATE_FIELD, BOXES_FIELD, { fieldName: "name", label: "Name", widgetType: "text", isRequired: true, value: "Kevin" }];
  const entries = [{ field_id: "P5::formField-checkboxGroup", current_value: "" }]; // reviewed while OPTIONAL → blank
  const gaps = newlyRequiredGaps(live, entries, "P5", []);
  assert.deepStrictEqual(gaps.map((g) => g.field.fieldName).sort(), ["checkboxGroup", "date"]);
  assert.strictEqual(gaps.find((g) => g.field.fieldName === "date").reason, "not-in-bundle");
  assert.strictEqual(gaps.find((g) => g.field.fieldName === "checkboxGroup").reason, "blank-in-bundle");
});

test("newlyRequiredGaps: a required field the page ALREADY holds a value for is not a gap", () => {
  const live = [{ fieldName: "name", label: "Name", widgetType: "text", isRequired: true, value: "Kevin" }];
  assert.deepStrictEqual(newlyRequiredGaps(live, [], "P5", []), []);
});

test("newlyRequiredGaps: an OPTIONAL blank field is not a gap, and a bundle ANSWER is not a gap", () => {
  const optional = [{ fieldName: "middle", label: "Middle", widgetType: "text", isRequired: false, value: null }];
  assert.deepStrictEqual(newlyRequiredGaps(optional, [], "P5", []), []);
  // required + blank on the page, but the bundle HAS an approved answer → a replay failure, not a gap
  // (the strict per-field verify owns that case).
  const answered = newlyRequiredGaps([DATE_FIELD], [{ field_id: "P5::formField-date", current_value: "2026-01-01" }], "P5", []);
  assert.deepStrictEqual(answered, []);
});

test("newlyRequiredGaps: file_upload is excluded (its own re-attach step + resume-not-attached halt)", () => {
  const live = [{ fieldName: "resume", label: "Resume", widgetType: "file_upload", isRequired: true, value: null }];
  assert.deepStrictEqual(newlyRequiredGaps(live, [], "P5", []), []);
});

test("cascadeEntryFor: produces an EMPTY, UNAPPROVED review question — never an invented answer", () => {
  const e = cascadeEntryFor({ field: BOXES_FIELD, entry: null, reason: "not-in-bundle" }, "P5", 5, 0);
  assert.strictEqual(e.current_value, null, "it asks a question, it never answers it");
  assert.strictEqual(e.is_approved, false);
  assert.strictEqual(e.is_required, true);
  assert.strictEqual(e.needs_review, true);
  assert.strictEqual(e.cascade_revealed, true, "so requiresApproval + the submit gate both demand a human");
  assert.strictEqual(e.field_id, "P5::formField-checkboxGroup");
  // A checkbox group carries its labels in the DOM → the operator gets a real picker, not a text box.
  assert.deepStrictEqual(e.options.map((o) => o.text), ["Yes, I have a disability", "No, I don't have a disability", "I don't wish to answer"]);
});

// ── requiredBlankOnPage — "filled + verified, then lost it" (live 2026-07-28) ───────────────────────
// The disability checkbox group replayed and VERIFIED checked, then Save & Continue reported it empty.
// This is the mirror of newlyRequiredGaps: the bundle HAS an answer, the page lost it.
// This comment used to add "the fill walk catches this with its M40 audit", and that was the reason the
// fill walk was left without the guard. 2026-08-04 refuted it live on waystar.wd1 and radiancetech.wd12:
// the audit REPORTED the doubt (audit-unverifiable — it could not re-read the group) and the walk saved
// anyway. Reporting a doubt is not resolving it, so BOTH walks now run this check before Save & Continue.
test("requiredBlankOnPage: a required field the bundle answered but the page shows blank is reported", () => {
  const live = [{ fieldName: "disabilityStatus", label: "Please check one of the boxes below:", widgetType: "checkbox_group", isRequired: true, value: null }];
  const entries = [{ field_id: "P5::formField-disabilityStatus", current_value: "I don't wish to answer" }];
  const lost = requiredBlankOnPage(live, entries);
  assert.strictEqual(lost.length, 1);
  assert.strictEqual(lost[0].approved, "I don't wish to answer", "carries the value to put back");
});

// ── requiredEntriesAbsentFromScan — the hole requiredBlankOnPage left (2026-08-04) ─────────────────
// A required field whose wrapper is MISSING from the live scan is not merely un-refilled by
// requiredBlankOnPage — it is invisible to it. "Missing from the scan" is exactly what the M40 audit
// reports as audit-unverifiable, which is how the disability self-ID group walked past that guard.
test("requiredEntriesAbsentFromScan: a required answered entry the scan never reported is surfaced", () => {
  const entries = [{ field_id: "P5::formField-disabilityStatus", widget_type: "checkbox_group",
    is_required: true, current_value: "No, I do not have a disability and have not had one in the past" }];
  const live = [{ fieldName: "disabilityForm", isRequired: true, value: "English" }]; // group absent
  const got = requiredEntriesAbsentFromScan(live, entries);
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].name, "disabilityStatus");
  assert.match(got[0].approved, /^No, I do not have a disability/);
});
test("requiredEntriesAbsentFromScan: silent when the field IS in the scan, or there is nothing to restore", () => {
  const e = (o) => Object.assign({ field_id: "P5::formField-x", is_required: true, current_value: "v" }, o);
  // present in the scan → requiredBlankOnPage's job, not this one
  assert.deepStrictEqual(requiredEntriesAbsentFromScan([{ fieldName: "x", value: null }], [e({})]), []);
  // optional → never
  assert.deepStrictEqual(requiredEntriesAbsentFromScan([], [e({ is_required: false })]), []);
  // no answer to put back → newlyRequiredGaps owns it
  assert.deepStrictEqual(requiredEntriesAbsentFromScan([], [e({ current_value: "" })]), []);
  // the résumé has its own re-attach step
  assert.deepStrictEqual(requiredEntriesAbsentFromScan([], [e({ widget_type: "file_upload" })]), []);
  // a soft-deleted row is not restored
  assert.deepStrictEqual(requiredEntriesAbsentFromScan([], [e({ is_deleted: true })]), []);
});

test("requiredBlankOnPage: does NOT claim fields it can't fix, or fields that are fine", () => {
  const entries = [{ field_id: "P5::formField-x", current_value: "v" }];
  // holds a value → fine
  assert.deepStrictEqual(requiredBlankOnPage([{ fieldName: "x", isRequired: true, value: "v" }], entries), []);
  // OPTIONAL blank → not our business
  assert.deepStrictEqual(requiredBlankOnPage([{ fieldName: "x", isRequired: false, value: null }], entries), []);
  // no approved answer to restore → newlyRequiredGaps owns it, not this
  assert.deepStrictEqual(requiredBlankOnPage([{ fieldName: "x", isRequired: true, value: null }], [{ field_id: "P5::formField-x", current_value: "" }]), []);
  // an unchecked checkbox stores "false", never empty — same carve-out as the submit gate
  assert.deepStrictEqual(requiredBlankOnPage([{ fieldName: "x", isRequired: true, value: "false" }], entries), []);
  // the résumé has its own re-attach step
  assert.deepStrictEqual(requiredBlankOnPage([{ fieldName: "x", isRequired: true, widgetType: "file_upload", value: null }], entries), []);
});

test("cascadeEntryFor: a DATE field carries the form's segment ORDER, not the raw segment ids", () => {
  // Live 2026-07-27: the raw scan ids were passed straight through as date_order, so the review page
  // printed "dateSectionMonth-display / dateSectionMonth-input / …" as the field's content instead of
  // rendering a segmented MM/DD/YYYY editor.
  const segs = ["dateSectionMonth-display", "dateSectionMonth-input", "dateSectionDay-display", "dateSectionDay-input", "dateSectionYear-display", "dateSectionYear-input"];
  const e = cascadeEntryFor({ field: { ...DATE_FIELD, dateSegments: segs }, entry: null, reason: "not-in-bundle" }, "P5", 5, 0);
  assert.deepStrictEqual(e.date_order, ["month", "day", "year"]);
  // A month/year-only composite keeps the form's own shape, and a non-date field has no order at all.
  assert.deepStrictEqual(cascadeEntryFor({ field: { ...DATE_FIELD, dateSegments: ["dateSectionMonth-input", "dateSectionYear-input"] }, entry: null, reason: "not-in-bundle" }, "P5", 5, 0).date_order, ["month", "year"]);
  assert.strictEqual(cascadeEntryFor({ field: BOXES_FIELD, entry: null, reason: "not-in-bundle" }, "P5", 5, 0).date_order, null);
});

test("cascadeEntryFor: the blank-in-bundle case explains WHY it's suddenly required", () => {
  const e = cascadeEntryFor({ field: DATE_FIELD, entry: { current_value: "" }, reason: "blank-in-bundle" }, "P5", 5, 1);
  assert.match(e.detail, /OPTIONAL and left blank/);
  assert.strictEqual(e.widget_type, "date");
});

test("findLiveSection: prefers the canonical container prefix when the page uses it", () => {
  const rscan = { sections: { "webAddress-": { heading: "Websites", entries: [] }, "education-": { heading: "Education", entries: [] } } };
  assert.strictEqual(findLiveSection(rscan, "website", WEBSITE_CFG).prefix, "webAddress-");
});

test("findLiveSection: falls back to a prefix named after the SECTION when the tenant differs", () => {
  // The regression: no "webAddress-" anywhere → the old hardcoded lookup found nothing and deleted 0.
  const rscan = { sections: { "website-": { heading: "Websites", entries: [] } } };
  assert.strictEqual(findLiveSection(rscan, "website", WEBSITE_CFG).prefix, "website-");
});

test("findLiveSection: last resort — match the section's HEADING (tenant-proof, as findSectionAdd does)", () => {
  const rscan = { sections: { "socialNetworkAccount-": { heading: "Websites 3", entries: [{}] } } };
  const loc = findLiveSection(rscan, "website", WEBSITE_CFG);
  assert.strictEqual(loc.prefix, "socialNetworkAccount-", "an unrecognized prefix is still found by its heading");
  assert.strictEqual(loc.live.entries.length, 1, "the live rows come back with it");
});

test("findLiveSection: a section that is genuinely absent returns null (never delete a guess)", () => {
  assert.strictEqual(findLiveSection({ sections: { "education-": { heading: "Education" } } }, "website", WEBSITE_CFG), null);
  assert.strictEqual(findLiveSection({ sections: {} }, "website", WEBSITE_CFG), null);
  assert.strictEqual(findLiveSection(null, "website", WEBSITE_CFG), null, "a failed scan is not a licence to delete");
});

test("liveDupEntries: keys a website row on its url and reports the Delete control", () => {
  const rows = [
    { deletePresent: true, fields: [{ fieldName: "url", value: "https://www.linkedin.com/in/wangykev" }] },
    { deletePresent: true, fields: [{ fieldName: "url", value: "https://www.github.com/wangykev" }] },
  ];
  const e = liveDupEntries(rows, "url");
  assert.strictEqual(e.length, 2);
  assert.notStrictEqual(e[0].key, e[1].key);
  assert.strictEqual(e[0].deletePresent, true);
  assert.strictEqual(sectionDeletionPlan(e).mode, "phantom", "two distinct live URLs = Workday's server-side ghost");
});

test("liveDupEntries: a row missing the key field falls back to its whole-row signature", () => {
  const rows = [{ deletePresent: false, fields: [{ fieldName: "webAddress", value: "https://a.dev" }] }];
  const e = liveDupEntries(rows, "url"); // "url" isn't this tenant's field name
  assert.match(e[0].key, /webAddress=/, "still produces a usable key instead of an empty one");
  assert.strictEqual(e[0].deletePresent, false, "surfaces that this row has NO Delete control");
});

test("liveDupEntries: identical live rows are detected as a REAL duplicate (delete the later one only)", () => {
  const rows = [
    { deletePresent: true, fields: [{ fieldName: "url", value: "https://a.dev" }] },
    { deletePresent: true, fields: [{ fieldName: "url", value: "https://a.dev/" }] }, // same modulo trailing slash
  ];
  const plan = sectionDeletionPlan(liveDupEntries(rows, "url"));
  assert.strictEqual(plan.mode, "real");
  assert.deepStrictEqual(plan.deleteIndices, [1]);
});

test("duplicateErrorSection: routes each tenant wording to its repeating section", () => {
  assert.strictEqual(duplicateErrorSection(["Error-URLYou can't add duplicate website URLs."]), "website"); // the LIVE solarturbines text
  assert.strictEqual(duplicateErrorSection(["Duplicate language entries are not allowed"]), "language");
  assert.strictEqual(duplicateErrorSection(["You cannot add duplicate Education entries"]), "education");
  assert.strictEqual(duplicateErrorSection(["Duplicate work experience is not allowed"]), "workExperience");
  assert.strictEqual(duplicateErrorSection(["Duplicate certification entries found"]), "certification");
});
test("duplicateErrorSection: a non-duplicate error, or a duplicate about nothing we model, is NOT claimed", () => {
  assert.strictEqual(duplicateErrorSection(["The field School is required"]), null, "a plain required-field error must not trigger a section delete");
  assert.strictEqual(duplicateErrorSection(["Duplicate entries are not allowed"]), null, "names no section → no guess");
  assert.strictEqual(duplicateErrorSection([]), null);
});

// ── isSelfIdPage — the surface that ignores synthetic writes (2026-08-04) ───────────────────────
test("isSelfIdPage: recognized by its own fields, not by tenant", () => {
  const f = (...n) => n.map((x) => ({ fieldName: x }));
  assert.strictEqual(isSelfIdPage(f("disabilityForm", "name", "employeeId", "dateSignedOn", "disabilityStatus")), true, "the live waystar page 5 field set");
  assert.strictEqual(isSelfIdPage(f("disabilityStatus")), true, "the OFCCP group alone is enough");
  assert.strictEqual(isSelfIdPage(f("name", "dateSignedOn")), true, "the signature pair is enough");
  // and it must NOT claim ordinary pages, or every page would lose the hidden-tab speed win
  assert.strictEqual(isSelfIdPage(f("legalName--firstName", "addressLine1", "phoneNumber")), false, "page 1");
  assert.strictEqual(isSelfIdPage(f("ethnicity", "gender", "hispanicOrLatino", "veteranStatus")), false, "voluntary disclosures");
  assert.strictEqual(isSelfIdPage(f("name")), false, "a bare name field is not a signature block");
  assert.strictEqual(isSelfIdPage([]), false);
});

// ── sectionsFromErrorNames must not route a FLAT field's own name to a section (2026-08-04) ──────
test("sectionsFromErrorNames: a bare \"Name\" that IS a flat field on this page routes nowhere", () => {
  // Live: the one remaining error on Self Identify was "Name" — the signature field, right there as a
  // flat field — and it re-ran workExperience AND education because containment matches schoolName.
  const flat = [{ fieldName: "name", label: "Name" }, { fieldName: "dateSignedOn", label: "Date" }];
  assert.deepStrictEqual(sectionsFromErrorNames(["Name"], flat), [], "must not drag sections in");
  // …while a genuine section field still routes, with the same flat list present
  assert.ok(sectionsFromErrorNames(["Degree"], flat).length > 0, "a real section field still routes with the same flat list present");
});
test("sectionsFromErrorNames: with no flat list it behaves exactly as before (back-compat)", () => {
  assert.ok(sectionsFromErrorNames(["Name"]).length > 0, "the old loose behaviour is unchanged when no page context is given");
});

// ── EXTERNAL GATES (2026-08-04) ────────────────────────────────────────────────────────────────
// The LIVE copart text, verbatim from the error page the walk dumped.
const COPART_ASSESSMENT = "Error-Page ErrorYou must complete the assessment test to continue with your job application.";
test("externalGateHalt: the live copart assessment wording is recognized as an external gate", () => {
  const g = externalGateHalt([COPART_ASSESSMENT], null);
  assert.ok(g, "must be recognized — otherwise the halt blames the fill for a step no fill can do");
  assert.strictEqual(g.reason, "assessment-required");
  assert.match(g.evidence, /assessment test/i, "the halt quotes Workday's own words");
});
test("externalGateHalt: found in the error-PAGE text too, not just the split samples", () => {
  const g = externalGateHalt([], "Page Error You must complete the assessment test to continue. Take Assessment Back Save and Continue");
  assert.ok(g && g.reason === "assessment-required");
});
test("externalGateHalt: an ORDINARY validation error is NEVER called an external gate", () => {
  // The dangerous direction: mislabelling a real fill failure as the operator's problem would hide a bug.
  assert.strictEqual(externalGateHalt(["Error-URLThe field URL is required and must have a value."], null), null);
  assert.strictEqual(externalGateHalt(["Error-Page ErrorThe field Date is required"], null), null);
  assert.strictEqual(externalGateHalt(["You can't add duplicate website URLs."], null), null);
  assert.strictEqual(externalGateHalt(["Please check one of the boxes below"], null), null);
  assert.strictEqual(externalGateHalt([], null), null);
  assert.strictEqual(externalGateHalt([""], ""), null);
  // "assessment" as a passing noun, with no requirement wording, is not a gate either
  assert.strictEqual(externalGateHalt(["Your assessment scores will be shared with the hiring team."], null), null);
});

test("sectionEntriesFromResults: builds one entry per row with a composite signature over ALL its fields", () => {
  const results = [
    { fieldName: "workExperience[0].jobTitle", after: "Engineer" },
    { fieldName: "workExperience[0].companyName", after: "Acme" },
    { fieldName: "workExperience[1].jobTitle", after: "Engineer" },
    { fieldName: "workExperience[1].companyName", after: "Globex" },
    { fieldName: "education[0].schoolName", after: "MIT" }, // a different section is ignored
  ];
  const entries = sectionEntriesFromResults(results, "workExperience");
  assert.strictEqual(entries.length, 2);
  assert.notStrictEqual(entries[0].key, entries[1].key, "same job title but different company ⇒ NOT the same row");
  assert.match(entries[0].summary, /Acme/);
});

test("sectionDeletionPlan: identical rows → REAL (delete the later one); all-distinct → PHANTOM (clear the section)", () => {
  const distinct = sectionEntriesFromResults([
    { fieldName: "education[0].schoolName", after: "MIT" },
    { fieldName: "education[1].schoolName", after: "Caltech" },
  ], "education");
  assert.strictEqual(sectionDeletionPlan(distinct).mode, "phantom", "a visibly-clean section is Workday's server-side ghost → clear it");
  assert.deepStrictEqual(sectionDeletionPlan(distinct).deleteIndices.slice().sort(), [0, 1]);

  const dupe = sectionEntriesFromResults([
    { fieldName: "education[0].schoolName", after: "MIT" },
    { fieldName: "education[1].schoolName", after: "Caltech" },
    { fieldName: "education[2].schoolName", after: "  mit " }, // same row, modulo case/whitespace
  ], "education");
  const plan = sectionDeletionPlan(dupe);
  assert.strictEqual(plan.mode, "real");
  assert.deepStrictEqual(plan.deleteIndices, [2], "keep the first occurrence, delete only the later duplicate");
});

test("sectionDeletionPlan: an empty section yields nothing to delete (never a no-op delete storm)", () => {
  assert.deepStrictEqual(sectionDeletionPlan([]).deleteIndices, []);
  assert.deepStrictEqual(sectionEntriesFromResults([], "language"), []);
});

test("AI-4 websiteDeletionPlan: distinct URLs → PHANTOM (delete all — the stale-backend bug)", () => {
  const results = [
    { fieldName: "website[0].url", after: "https://github.com/kevin" },
    { fieldName: "website[1].url", after: "https://linkedin.com/in/kevin" }
  ];
  const entries = websiteEntriesFromResults(results);
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].summary, "https://github.com/kevin");
  const plan = websiteDeletionPlan(entries);
  assert.strictEqual(plan.mode, "phantom");
  assert.deepStrictEqual(plan.deleteIndices.slice().sort(), [0, 1]); // ALL
});
test("AI-4 websiteDeletionPlan: a REAL duplicate URL (trailing-slash-insensitive) → delete only the later one", () => {
  const results = [
    { fieldName: "website[0].url", after: "https://github.com/kevin" },
    { fieldName: "website[1].url", after: "https://linkedin.com/in/kevin" },
    { fieldName: "website[2].url", after: "https://github.com/kevin/" } // same as [0] modulo trailing slash
  ];
  const plan = websiteDeletionPlan(websiteEntriesFromResults(results));
  assert.strictEqual(plan.mode, "real");
  assert.deepStrictEqual(plan.deleteIndices, [2]);
});

test("canonicalJobUrl: posting (tenant-subdomain) + logged-in form (tenant-in-path, myworkdaysite) collapse to ONE key", () => {
  // posting: tenant in the SUBDOMAIN (magna.wd3.myworkdayjobs.com); form after login: tenant only in
  // the PATH (host is bare wd3.myworkdaysite.com) + a per-application-instance tail + query. The
  // data-center token "wd3" is the only common host part → both must key to "wd3:r00244793".
  const posting = "https://magna.wd3.myworkdayjobs.com/en-US/Magna/job/Milton%2C-Ontario%2C-CA/Junior-Full-Stack-Developer-Coop_R00244793/apply";
  const form = "https://wd3.myworkdaysite.com/en-US/recruiting/magna/Magna/job/Milton%2C-Ontario%2C-CA/Junior-Full-Stack-Developer-Coop_R00244793/apply/applyManually?locale=en_US";
  const key = "wd3:r00244793";
  assert.strictEqual(canonicalJobUrl(posting), key, "posting (myworkdayjobs, tenant in subdomain)");
  assert.strictEqual(canonicalJobUrl(form), key, "form (myworkdaysite, tenant in path, instance tail + query)");
});
test("canonicalJobUrl: different reqs differ; non-Workday falls back to origin+path (no query/apply)", () => {
  const base = "https://magna.wd3.myworkdayjobs.com/en-US/job/x/Foo_R111/apply";
  const other = "https://magna.wd3.myworkdayjobs.com/en-US/job/x/Bar_R222/apply";
  assert.notStrictEqual(canonicalJobUrl(base), canonicalJobUrl(other));
  assert.strictEqual(canonicalJobUrl("https://careers.example.com/jobs/123/apply?x=1"), "https://careers.example.com/jobs/123");
  assert.strictEqual(canonicalJobUrl(""), "");
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
  let closed = false; // typeahead popup state: Tab-blur closes it (leaves unmount → leafCount 0); open re-opens
  // readHier reflects open/closed so the anti-stray close-confirm (awaitTypeaheadClosed) breaks on close
  const readState = () => ({ searchBox: { visible: !closed, focused: !closed }, activeText: null, chips: opts.chips || [], leaves: closed ? [] : FOS_OPTS.slice(), leafCount: closed ? 0 : FOS_OPTS.length });
  const act = {
    delay: () => { calls.push(["delay"]); return Promise.resolve(); },
    delayFull: () => { calls.push(["delayFull"]); return Promise.resolve(); },
    openHier: (loc) => { calls.push(["openHier", loc.wrapperSel]); closed = false; return Promise.resolve(true); },
    readHier: (loc) => { calls.push(["readHier", loc.wrapperSel]); return Promise.resolve(readState()); },
    focusHierSearch: (loc) => { calls.push(["focusHierSearch", loc.wrapperSel]); return Promise.resolve(true); },
    pressEscape: () => { calls.push(["pressEscape"]); return Promise.resolve(); },
    pressTab: () => { calls.push(["pressTab"]); closed = true; return Promise.resolve(); }
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

test("choice-capture: an untagged (flat, prefilled-kept) typeahead is NOW captured; not-filled / unlocated stay untouched", async () => {
  const recs = [
    taggedRec({ captureOptions: false, auditLoc: "[w-a]" }), // flat typeahead (no captureOptions tag) kept w/o actuation → NOW captured
    taggedRec({ status: "needs_review", auditLoc: "[w-c]" }), // not filled → untouched
    taggedRec({ auditLoc: null }) // no locator → untouched
  ];
  const { act, calls } = makeCaptureAct();
  await captureChoiceOptions(act, recs, CAP_BUDGETS);
  assert.deepStrictEqual(recs[0].options, FOS_OPTS); // flat typeahead captured for the review editor (2026-07-05 parity)
  assert.strictEqual(recs[1].options, undefined);    // not-filled untouched
  assert.strictEqual(recs[2].options, undefined);    // unlocated untouched
  assert.strictEqual(calls.filter((c) => c[0] === "scrapeTaOptions").length, 1); // only the flat filled one scraped
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

test("choice-capture: a FLAT dropdown (page 1, prefilled-kept, no options) is NOW captured for the review editor (2026-07-05)", async () => {
  const recs = [{ fieldName: "country", widgetType: "dropdown", status: "filled", auditLoc: "[w-country]" }]; // prefilled-kept, no options
  const { act, calls } = makeDropdownAct();
  await captureChoiceOptions(act, recs, T_BUDGETS);
  assert.deepStrictEqual(recs[0].options, ["Bachelors", "Masters", "Doctorate"]); // flat dropdown re-opened + captured so review shows a <select>
  assert.strictEqual(calls.filter((c) => c[0] === "openDropdown").length, 1);       // re-opened once (the M27.C cost, paid deliberately)
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

// The cross-run option cache was REMOVED 2026-08-06 (operator): it only ever helped a SECOND run
// against the same tenant, which is a testing artifact — in the real flow a form is filled once,
// reviewed, then submitted, so the store was always cold when it mattered, and it made repeat test
// runs faster than a genuine first fill. The per-PAGE dedupe above is what remains, and is tested there.

test("closeDropdownConfirmed: polls on delayRender (adaptive) with a wall-clock bound — options-gone gate unchanged", async () => {
  // The 2026-07-25 pacing change: the close-settle beat is delayRender (adaptive under the measured-
  // fast gate), bounded by a REAL wall-clock deadline (openRetries × reopenSettleMs — the same total
  // window closeAndVerifyBlank uses) instead of the old delayFull(commitIntervalMs) × 4 iterations.
  const calls = [];
  let lingering = 1;
  const act = {
    delayRender: async () => { calls.push("delayRender"); },
    delayFull: async () => { calls.push("delayFull"); },
    pressEscape: async () => {},
    readDropdownState: async () => { const open = lingering > 0; if (lingering > 0) lingering--; return { listboxPresent: open, optionCount: open ? 3 : 0 }; }
  };
  const gone = await closeDropdownConfirmed(act, { wrapperSel: "[w]" }, { openRetries: 3, commitIntervalMs: 300, reopenSettleMs: 400 });
  assert.strictEqual(gone, true, "still gates on options-gone");
  assert.ok(calls.includes("delayRender") && !calls.includes("delayFull"), "the close-settle beat is adaptive (delayRender), not a fixed full-clock wait");
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
      // o.scrapeCatsEmpty models a tenant (Magna wd3) whose CATEGORY rows are role=option/treeitem, NOT
      // promptOptions — so the promptOption-only scrape returns 0 categories on-open (readTreeCategories
      // still sees them). Leaves after a drill are promptOptions → scraped normally.
      return expanded
        ? { ok: true, options: leavesOf(), banner: expanded, atBottom: true }
        : { ok: true, options: o.scrapeCatsEmpty ? [] : tree.categories.slice(), banner: o.scrapeCatsEmpty ? "" : "No matches found", atBottom: true };
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

test("aiTreeDrillFallback: promptOption scrape finds 0 categories (role=option tenant) → falls back to readTreeCategories, STILL drills + commits (never returns null)", async () => {
  const act = makeFakeTreeAct(CERT_TREE, { scrapeCatsEmpty: true, ai: [
    '{"choice":"Multiple Recognized Providers","confidence":"High"}',
    '{"choice":"Certified Payroll Professional (CPP)","confidence":"High"}',
  ] });
  const out = await aiTreeDrillFallback(act, { wrapperSel: "[w]" }, { profile: {}, jobContext: {}, isRequired: true, label: "How Did You Hear About Us?", sourceTree: true }, T_BUDGETS);
  assert.ok(out && out.status === "filled_review", "drilled via the readTreeCategories fallback instead of returning null (the Magna source bug)");
  assert.strictEqual(out.after, "Certified Payroll Professional (CPP) - Multiple Recognized Providers");
  assert.ok(act.log.some(([m]) => m === "expand"), "the category→leaf drill actually ran");
});

test("awaitSourceListLoaded: waits out a LATE server-fetched tree, returns the instant categories appear", async () => {
  let calls = 0;
  const act = {
    delayFull: async () => {},
    readTreeCategories: async () => { calls++; return calls >= 3 ? ["Job Board", "College/University"] : []; },
    readHier: async () => ({ searchBox: { visible: true } }),
    scrapeSourceRows: async () => ({ ok: true, options: [] }),
  };
  const loaded = await awaitSourceListLoaded(act, { wrapperSel: "[w]" }, { sourceCatLoadCeilingMs: 2000, sourceCatPollMs: 1 });
  assert.strictEqual(loaded, true, "returns true once readTreeCategories populates (the fallback can then type into a loaded tree)");
  assert.ok(calls >= 3, "polled until the tree loaded (adaptive, not a fixed wait)");
});

test("awaitSourceListLoaded: a tree that never loads returns false (bounded — never blocks forever)", async () => {
  const act = {
    delayFull: async () => {},
    readTreeCategories: async () => [],
    readHier: async () => ({ searchBox: { visible: true } }),
    scrapeSourceRows: async () => ({ ok: true, options: [] }),
  };
  const loaded = await awaitSourceListLoaded(act, { wrapperSel: "[w]" }, { sourceCatLoadCeilingMs: 30, sourceCatPollMs: 1 });
  assert.strictEqual(loaded, false, "gives up at the ceiling → the caller falls through (needs_review / AI), never hangs");
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

test("M1 cascade LATE reveal: a field that mounts only AFTER the audit is still caught (the post-audit pass)", async () => {
  // Live (Solar Turbines): the LAST field filled has nothing running after it, so its reveal — an
  // SMS-consent checkbox revealed by the phone number — was still rendering when the first cascade pass
  // ran, and it never entered the records. The post-capture/post-audit pass catches it for the price of
  // one read-only scanPage. Here the reveal is gated on the AUDIT having run (readAuditRaw / the audit's
  // re-read), i.e. strictly later than the first cascade pass.
  const fields = [{ wrapperSel: "[w-phone]", fieldName: "phoneNumber", widgetType: "text", value: "" }];
  const late = { wrapperSel: "[w-sms]", fieldName: "city", widgetType: "text", value: "", isRequired: true };
  const act = makeFakeAct(fields);
  const baseScan = act.scanPage;
  let auditRan = false;
  const baseRead = act.readTextValue;
  act.readTextValue = async (loc, tag) => { if (fields[0].value) auditRan = true; return baseRead(loc, tag); }; // the audit re-reads the filled field
  act.scanPage = async () => {
    if (auditRan && !fields.some((f) => f.fieldName === "city")) fields.push(late); // mounts only after the audit's re-read
    return baseScan();
  };
  const out = await drivePageFill(act, { personal_info: { phone_number: "850-666-0266", city: "London" } }, {}, {}, { ...T_BUDGETS, maxCascadeRounds: 3 });
  const rec = out.results.find((r) => r.fieldName === "city");
  assert.ok(rec, "the LATE-revealed field is recorded (would have been missed by the single pre-audit pass)");
  assert.strictEqual(rec.cascadeRevealed, true);
  assert.strictEqual(rec.after, "London");
  assert.strictEqual(out.results.filter((r) => r.fieldName === "city").length, 1, "filled exactly once across both passes");
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

test("replayField: a CLEARED text entry on an ALREADY-BLANK field is SKIPPED (no focus — an empty optional field like phone extension can't halt the walk)", async () => {
  const f = { wrapperSel: '[data-automation-id="formField-extension"]', fieldName: "extension", widgetType: "text", value: "" };
  const act = makeFakeAct([f]);
  const r = await replayField(act, { field_id: "P1::formField-extension", canonical_field: "personal_info.phone_extension", widget_type: "text", current_value: "", edit_kind: null }, T_BUDGETS);
  assert.strictEqual(r.status, "skipped");
  assert.strictEqual(r.replay, "cleared");
  assert.strictEqual(f.value, "", "left blank, never actuated (no focus attempt)");
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

// ── Skip-if-correct: a replay CHANGES only what differs (minimal-diff reconciliation) ────────────
test("replayValueMatches: text exact, choice normalize-equal, date segment-numeric, checkbox desired-bool", () => {
  assert.strictEqual(replayValueMatches("text", "Kevin", "Kevin"), true);
  assert.strictEqual(replayValueMatches("text", "kevin", "Kevin"), false, "text is exact, not normalized");
  assert.strictEqual(replayValueMatches("dropdown", "United States of America (+1)", "United States of America"), true, "choice widgets normalize (drops the (+1))");
  assert.strictEqual(replayValueMatches("date", "6/15/2024", "06/15/2024"), true, "dates compare segment-numeric");
  assert.strictEqual(replayValueMatches("date", "6/15/2024", "6/16/2024"), false);
  assert.strictEqual(replayValueMatches("checkbox", "true", "yes"), true, "checkbox: live 'true' == desired 'yes'");
  assert.strictEqual(replayValueMatches("checkbox", "false", "yes"), false);
  assert.strictEqual(replayValueMatches("text", "x", null), false, "a null side never matches (no false skip)");
});

test("replayField (SKIP-IF-CORRECT): an already-correct TEXT field is left UNTOUCHED — zero actuation", async () => {
  const f = { wrapperSel: '[data-automation-id="formField-legalName--firstName"]', fieldName: "legalName--firstName", widgetType: "text", value: "Kevin" };
  const act = makeFakeAct([f]);
  const r = await replayField(act, { field_id: "P1::formField-legalName--firstName", widget_type: "text", current_value: "Kevin", edit_kind: null }, T_BUDGETS);
  assert.strictEqual(r.status, "filled");
  assert.strictEqual(r.flag, "replay-already-correct");
  assert.strictEqual(r.after, "Kevin");
  assert.ok(!act.log.some((e) => e[0] === "focusText" || e[0] === "typeText" || e[0] === "clearText"), "a correct text field is never re-typed");
});

test("replayField (SKIP-IF-CORRECT): an already-correct DROPDOWN is left as-is — never even opened", async () => {
  const f = { wrapperSel: '[data-automation-id="formField-country"]', fieldName: "country", widgetType: "dropdown", triggerText: "United States of America", options: [{ text: "Select One", disabled: true }, { text: "Canada" }, { text: "United States of America" }] };
  const act = makeFakeAct([f]);
  const r = await replayField(act, { field_id: "P1::formField-country", widget_type: "dropdown", current_value: "United States of America", edit_kind: null }, T_BUDGETS);
  assert.strictEqual(r.status, "filled");
  assert.strictEqual(r.flag, "replay-already-correct");
  assert.ok(!act.log.some((e) => e[0] === "openDropdown"), "a correct dropdown is not re-opened (no stray-click exposure)");
});

// REGRESSION (live, solarturbines page 5, 2026-07-28). Workday kept reporting Name/Date as required-and-
// empty while the page (DOM, React's own props, and Workday's own "current value is 7/28/2026" rendering)
// all held them. The remedy is to force a real RE-WRITE — but replayField's skip-if-correct block ignored
// `budgets.skipIfCorrect` entirely, so the "forced" re-fill logged "already correct — left unchanged (no
// actuation)" and did nothing. A whole live run was spent learning that. These pin BOTH directions.
test("replayField: skipIfCorrect:false FORCES a re-write of an already-correct field (the forced-remedy path)", async () => {
  const f = { wrapperSel: '[data-automation-id="formField-name"]', fieldName: "name", widgetType: "text", value: "Kevin Wang" };
  const act = makeFakeAct([f]);
  const r = await replayField(act, { field_id: "P5::formField-name", widget_type: "text", current_value: "Kevin Wang", edit_kind: null },
    Object.assign({}, T_BUDGETS, { skipIfCorrect: false }));
  assert.strictEqual(r.status, "filled");
  assert.notStrictEqual(r.flag, "replay-already-correct", "an explicit skipIfCorrect:false must NOT report already-correct");
  assert.ok(act.log.some((e) => e[0] === "typeText"), "the field must actually be re-typed — that is the whole point of the forced remedy");
});
test("replayField: skipIfCorrect UNDEFINED still skips (every existing caller unchanged)", async () => {
  const f = { wrapperSel: '[data-automation-id="formField-name"]', fieldName: "name", widgetType: "text", value: "Kevin Wang" };
  const act = makeFakeAct([f]);
  const b = Object.assign({}, T_BUDGETS); delete b.skipIfCorrect;
  const r = await replayField(act, { field_id: "P5::formField-name", widget_type: "text", current_value: "Kevin Wang", edit_kind: null }, b);
  assert.strictEqual(r.flag, "replay-already-correct", "only an EXPLICIT false forces; the default must keep the minimal-diff replay");
  assert.ok(!act.log.some((e) => e[0] === "typeText"));
});

test("replayField (SKIP-IF-CORRECT): a DIFFERING value STILL actuates (only-what-differs, not skip-everything)", async () => {
  const f = { wrapperSel: '[data-automation-id="formField-legalName--firstName"]', fieldName: "legalName--firstName", widgetType: "text", value: "Wrongname" };
  const act = makeFakeAct([f]);
  const r = await replayField(act, { field_id: "P1::formField-legalName--firstName", widget_type: "text", current_value: "Kevin", edit_kind: null }, T_BUDGETS);
  assert.strictEqual(r.status, "filled");
  assert.notStrictEqual(r.flag, "replay-already-correct");
  assert.strictEqual(f.value, "Kevin", "a field that differs from the approved value is corrected");
  assert.ok(act.log.some((e) => e[0] === "typeText"), "the differing field WAS actuated");
});

// ── Phone auto-format tolerance: "(850) 666-0266" == "8506660266" (same number, format-only diff) ──
test("textValuesMatch (phone): same digits in different formats match; letters/lengths still exact", () => {
  assert.strictEqual(textValuesMatch("(850) 666-0266", "8506660266"), true, "Workday's auto-format == raw digits");
  assert.strictEqual(textValuesMatch("(850) 666-0266", "850-666-0266"), true);
  assert.strictEqual(textValuesMatch("(850) 666-0266", "(850) 666-0266"), true);
  assert.strictEqual(textValuesMatch("8506660266", "8506660267"), false, "different digits never match");
  assert.strictEqual(textValuesMatch("Acme Corp", "acme corp"), false, "ordinary text stays exact — not phone-shaped");
  assert.strictEqual(textValuesMatch("12345", "1-2345"), false, "too few digits to be a phone → exact-only");
  assert.strictEqual(textValuesMatch("+1 (850) 666-0266", "8506660266"), false, "a country-code prefix changes the digit count — genuinely different");
  assert.strictEqual(phoneShaped("(850) 666-0266"), true);
  assert.strictEqual(phoneShaped("Suite 200"), false, "has letters → not phone-shaped");
});

test("replayField (SKIP-IF-CORRECT, phone): a phone already in Workday's (850) 666-0266 format is left untouched", async () => {
  const f = { wrapperSel: '[data-automation-id="formField-phoneNumber--phoneNumber"]', fieldName: "phoneNumber--phoneNumber", widgetType: "text", value: "(850) 666-0266" };
  const act = makeFakeAct([f]);
  const r = await replayField(act, { field_id: "P1::formField-phoneNumber--phoneNumber", widget_type: "text", current_value: "8506660266", edit_kind: null }, T_BUDGETS);
  assert.strictEqual(r.flag, "replay-already-correct", "the reformatted phone counts as correct — nothing changes");
  assert.ok(!act.log.some((e) => e[0] === "typeText"), "the phone is not re-typed");
});

// ── GENERIC skip-if-correct: page-2 repeating entries stop fully re-filling correct fields ─────────
test("replay skip-if-correct (REPEATING): a website entry already holding the approved url is left UNTOUCHED", async () => {
  const state = webState({ entries: [webEntry("webAddress-1--null", "https://a.example")] });
  const act = makeFakeRepeatAct(state);
  const out = await driveRepeatingSectionCdp(act, {
    name: "website", headingRegex: "websites?|web ?address", containerPrefix: "webAddress-",
    items: [{ url: "https://a.example" }], fieldMap: WEBSITE_MAP, deleteOnNoMatch: false
  }, Object.assign({}, T_BUDGETS, { skipIfCorrect: true }));
  const url = out.results.find((r) => /\.url$/.test(r.fieldName));
  assert.strictEqual(url.status, "filled");
  assert.strictEqual(url.flag, "replay-already-correct");
  assert.ok(!act.log.some((e) => e[0] === "typeText" || e[0] === "focusText"), "a correct repeating field is not re-typed (page 2 no longer fully refills)");
});

test("replay skip-if-correct (REPEATING): a DIFFERING url IS re-filled (only-what-differs, not skip-all)", async () => {
  const state = webState({ entries: [webEntry("webAddress-1--null", "https://old.example")] });
  const act = makeFakeRepeatAct(state);
  const out = await driveRepeatingSectionCdp(act, {
    name: "website", headingRegex: "websites?|web ?address", containerPrefix: "webAddress-",
    items: [{ url: "https://new.example" }], fieldMap: WEBSITE_MAP, deleteOnNoMatch: false
  }, Object.assign({}, T_BUDGETS, { skipIfCorrect: true }));
  const url = out.results.find((r) => /\.url$/.test(r.fieldName));
  assert.notStrictEqual(url.flag, "replay-already-correct");
  assert.ok(act.log.some((e) => e[0] === "typeText"), "a differing repeating field WAS re-typed");
  assert.strictEqual(state.entries[0].fields[0].value, "https://new.example");
});

test("NORMAL fill (no skipIfCorrect): an already-correct repeating url is STILL re-typed (fill path unchanged)", async () => {
  const state = webState({ entries: [webEntry("webAddress-1--null", "https://a.example")] });
  const act = makeFakeRepeatAct(state);
  const out = await driveRepeatingSectionCdp(act, {
    name: "website", headingRegex: "websites?|web ?address", containerPrefix: "webAddress-",
    items: [{ url: "https://a.example" }], fieldMap: WEBSITE_MAP, deleteOnNoMatch: false
  }, T_BUDGETS);
  const url = out.results.find((r) => /\.url$/.test(r.fieldName));
  assert.notStrictEqual(url.flag, "replay-already-correct");
  assert.ok(act.log.some((e) => e[0] === "typeText"), "without the flag the fill path is byte-identical (still re-types)");
});

// ── M3 walk: selectPageBundleEntries — scope replay to THIS live page's approved entries ──────────
test("selectPageBundleEntries: picks the bundle page-group with the most flat-field overlap", () => {
  const entries = [
    { page: "PA", field_id: "PA::formField-firstName", canonical_field: "pi.first" },
    { page: "PA", field_id: "PA::formField-country", canonical_field: "pi.country" },
    { page: "PB", field_id: "PB::formField-jobTitle", canonical_field: "we.title" },
    { page: "PB", field_id: "PB::formField-company", canonical_field: "we.company" },
  ];
  const r = selectPageBundleEntries(entries, ["firstName", "country", "phone"]);
  assert.strictEqual(r.pageKey, "PA");
  assert.strictEqual(r.score, 2);
  assert.strictEqual(r.entries.length, 2);
});

test("selectPageBundleEntries: a cascade-revealed field in the bundle key still matches the pre-reveal live page (overlap, not exact)", () => {
  const entries = [
    { page: "PA1", field_id: "PA1::formField-firstName", canonical_field: "pi.first" },
    { page: "PA1", field_id: "PA1::formField-country", canonical_field: "pi.country" },
    { page: "PA1", field_id: "PA1::formField-localName", canonical_field: "pi.local" }, // revealed by country last fill
    { page: "PB", field_id: "PB::formField-jobTitle", canonical_field: "we.title" },
  ];
  const r = selectPageBundleEntries(entries, ["firstName", "country"]); // fresh page: localName not yet revealed
  assert.strictEqual(r.pageKey, "PA1");
  assert.strictEqual(r.score, 2, "matches on the 2 present fields even though the bundle key has 3");
});

test("selectPageBundleEntries: a live page with NO overlap → score 0 (the walk HALTs, never guesses)", () => {
  const entries = [{ page: "PA", field_id: "PA::formField-firstName", canonical_field: "pi.first" }];
  const r = selectPageBundleEntries(entries, ["someOtherField", "unrelated"]);
  assert.strictEqual(r.score, 0);
});

test("selectPageBundleEntries: repeating entries don't count toward the overlap (flat fields decide the page)", () => {
  const entries = [
    { page: "P2", field_id: "P2::formField-jobTitle", canonical_field: "workExperience[0].job_title" }, // repeating
    { page: "P2", field_id: "P2::formField-someFlag", canonical_field: "pi.flag" },
    { page: "P1", field_id: "P1::formField-firstName", canonical_field: "pi.first" },
    { page: "P1", field_id: "P1::formField-lastName", canonical_field: "pi.last" },
  ];
  const r = selectPageBundleEntries(entries, ["firstName", "lastName"]);
  assert.strictEqual(r.pageKey, "P1", "repeating jobTitle on P2 is excluded from FLAT overlap → P1 wins");
  assert.strictEqual(r.score, 2);
});

test("selectPageBundleEntries: a repeating-only page (My Experience — no flat fields) matches via live SECTION presence", () => {
  const entries = [
    { page: "P1", field_id: "P1::formField-firstName", canonical_field: "pi.first" },
    { page: "P2", field_id: "P2::formField-jobTitle", canonical_field: "workExperience[0].job_title" },
    { page: "P2", field_id: "P2::formField-school", canonical_field: "education[0].school" },
  ];
  // page 2: cdpPageScan returns NO flat fields (all repeating); act.repeatingScan shows the live sections
  const rscan = { sections: { "workExperience-": {}, "education-": {} }, addButtons: [] };
  const r = selectPageBundleEntries(entries, [], rscan);
  assert.strictEqual(r.pageKey, "P2", "the repeating page is matched by its live sections, not flat fields");
  assert.strictEqual(r.score, 2, "2 live repeating sections overlap the bundle's P2 group");
});

// ── M4: submitPrecondition — the ordered gate for the ONE irreversible click (SAFETY SURFACE) ─────
// A clean, GATE-PASSING scenario; each test mutates ONE thing and asserts it blocks.
const cleanSubmitInputs = () => ({
  bundle: { schema_version: "1.1", entries: [
    { field_id: "P::formField-a", canonical_field: "pi.a", needs_review: false },
    { field_id: "P::formField-b", canonical_field: "pi.b", needs_review: true, is_approved: true },
  ] },
  liveState: { applyFlowReviewPresent: true, formFieldCount: 5 },
  findings: {},
  opts: { authorize: true, alreadyFired: false },
});
const gate = (m) => { const i = cleanSubmitInputs(); if (m) m(i); return submitPrecondition(i.bundle, i.liveState, i.findings, i.opts); };

test("submitPrecondition: a clean authorized review-page scenario PASSES (ok, no blockers)", () => {
  const r = gate();
  assert.strictEqual(r.ok, true, r.blockers.join("; "));
  assert.strictEqual(r.blockers.length, 0);
});

test("submitPrecondition: authorize !== true BLOCKS (the per-run token is mandatory)", () => {
  const r = gate((i) => { i.opts.authorize = false; });
  assert.strictEqual(r.ok, false);
  assert.ok(r.blockers.some((b) => /not authorized/.test(b)));
});

test("submitPrecondition: NOT on the review page BLOCKS (never submit off-review)", () => {
  const r = gate((i) => { i.liveState.applyFlowReviewPresent = false; });
  assert.strictEqual(r.ok, false);
  assert.ok(r.blockers.some((b) => /review page/.test(b)));
});

test("submitPrecondition: a dead session BLOCKS", () => {
  const r = gate((i) => { i.liveState.signInButtonPresent = true; });
  assert.strictEqual(r.ok, false);
  assert.ok(r.blockers.some((b) => /session dead/.test(b)));
});

test("submitPrecondition: a maintenance page BLOCKS", () => {
  const r = gate((i) => { i.liveState.formFieldCount = 0; i.liveState.maintenancePresent = true; });
  assert.strictEqual(r.ok, false);
  assert.ok(r.blockers.some((b) => /maintenance/.test(b)));
});

test("NAMED INVARIANT — submitPrecondition NEVER passes with an unresolved flagged/needs_review field", () => {
  const r = gate((i) => { i.bundle.entries[1].is_approved = false; }); // a needs_review field left unapproved
  assert.strictEqual(r.ok, false, "an unapproved flagged field MUST block submit");
  assert.ok(r.blockers.some((b) => /not approved/.test(b)));
});

// ── reload-retry: is a set of failures TRANSIENT (render-flake, retryable) vs TERMINAL (must halt)? ──
test("isTransientRenderFailure: all render-flakes → true; any terminal → false; no failures → false", () => {
  const flake = { status: "needs_review", detail: "options did not render (skipped_no_option_match)" };
  const flakeByFlag = { status: "needs_review", flag: "skipped_no_option_match", detail: "" };
  // control-not-laid-out family (the replay page-2 Country-cascade race — same underlying render race)
  const noInput = { status: "error", detail: "no input in wrapper" };
  const noTextarea = { status: "error", detail: "no textarea in wrapper" };
  const noTypeahead = { status: "error", detail: "typeahead wrapper not found" };
  const terminal = { status: "needs_review", detail: "no candidate matched — value not offered" };
  const ok = { status: "filled", detail: "overwrote x" };
  assert.strictEqual(isTransientRenderFailure([flake]), true);
  assert.strictEqual(isTransientRenderFailure([flake, flakeByFlag]), true);
  assert.strictEqual(isTransientRenderFailure([noInput, noTextarea, noTypeahead]), true, "control-not-laid-out is a render race");
  assert.strictEqual(isTransientRenderFailure([flake, noTypeahead]), true, "mixed render-races → retryable");
  assert.strictEqual(isTransientRenderFailure([flake, terminal]), false, "a mix with a genuine no-match is NOT retryable");
  assert.strictEqual(isTransientRenderFailure([noInput, terminal]), false, "a mix with a genuine no-match is NOT retryable");
  assert.strictEqual(isTransientRenderFailure([terminal]), false);
  assert.strictEqual(isTransientRenderFailure([ok]), false, "no failures → nothing to retry");
  assert.strictEqual(isTransientRenderFailure([]), false);
  assert.strictEqual(isTransientRenderFailure(null), false);
});

test("samePhysicalPage: same pathname + overlapping field-set → same page (overwrite); disjoint → separate", () => {
  const k = (path, fields) => path + "|" + fields.slice().sort().join(",");
  // a cascade-revealed field persisted between fills → keys differ but it's the SAME page
  assert.strictEqual(samePhysicalPage(k("/apply", ["country", "name", "email"]), k("/apply", ["country", "name", "email", "state"])), true);
  // genuinely different SPA pages sharing the pathname have DISJOINT field-sets → separate
  assert.strictEqual(samePhysicalPage(k("/apply", ["country", "name"]), k("/apply", ["workExp", "school"])), false);
  // different pathname → never the same
  assert.strictEqual(samePhysicalPage(k("/apply", ["a", "b"]), k("/review", ["a", "b"])), false);
  // plain (field-less) keys only match themselves
  assert.strictEqual(samePhysicalPage("P1", "P1"), true);
  assert.strictEqual(samePhysicalPage("P1", "P2"), false);
  assert.strictEqual(samePhysicalPage(null, "P1"), false);
});

test("accumulateBundle OVERWRITES a re-fill of the same page whose field-set SHIFTED (no duplicate page)", () => {
  const k = (fields) => "/apply|" + fields.slice().sort().join(",");
  const mk = (pageKey, fields) =>
    buildReviewBundle(fields.map((f) => ({ fieldName: f, widgetType: "text", status: "filled", after: f.toUpperCase(), label: f })), { page: pageKey });
  // first fill of page 1 (country blank → no cascade fields)
  let acc = accumulateBundle([], mk(k(["country", "name"]), ["country", "name"]));
  assert.strictEqual(acc.entries.length, 2);
  // re-fill of the SAME page — now country is set, so `state` cascade-revealed → a DIFFERENT key
  acc = accumulateBundle(acc.entries, mk(k(["country", "name", "state"]), ["country", "name", "state"]));
  assert.strictEqual(acc.entries.length, 3, "the prior page-1 entries were overwritten, not duplicated");
  assert.deepStrictEqual(acc.entries.map((e) => e.field_id.split("::").pop()).sort(), ["formField-country", "formField-name", "formField-state"]);
});

test("submitPrecondition (M6): an unapproved CASCADE-REVEALED field blocks even if it filled cleanly (needs_review false)", () => {
  const r = gate((i) => { i.bundle.entries.push({ field_id: "P::formField-localName", cascade_revealed: true, needs_review: false, is_approved: false }); });
  assert.strictEqual(r.ok, false, "a revealed field forces a second review — blocks until approved");
  assert.ok(r.blockers.some((b) => /not approved/.test(b)));
  const ok = gate((i) => { i.bundle.entries.push({ field_id: "P::formField-localName", cascade_revealed: true, needs_review: false, is_approved: true }); });
  assert.strictEqual(ok.ok, true, "once approved, it no longer blocks: " + ok.blockers.join("; "));
});

test("submitPrecondition: an unreplaced AI placeholder in the BUNDLE blocks", () => {
  const r = gate((i) => { i.bundle.entries.push({ field_id: "P::formField-essay", flag: "ai-text-needs-answer", current_value: "[NEEDS YOUR ANSWER: why us?]", needs_review: true, is_approved: true }); });
  assert.strictEqual(r.ok, false);
  assert.ok(r.blockers.some((b) => /placeholder/.test(b)));
});

test("submitPrecondition: a placeholder VISIBLE on the live review page blocks (live re-check)", () => {
  const r = gate((i) => { i.findings.livePlaceholder = true; });
  assert.strictEqual(r.ok, false);
  assert.ok(r.blockers.some((b) => /VISIBLE on the live review page/.test(b)));
});

test("submitPrecondition: a schema_version this build doesn't accept blocks (stale bundle)", () => {
  const r = gate((i) => { i.bundle.schema_version = "9.9"; });
  assert.strictEqual(r.ok, false);
  assert.ok(r.blockers.some((b) => /schema_version/.test(b)));
});

test("submitPrecondition: cascade-revealed fields / replay mismatches block", () => {
  assert.strictEqual(gate((i) => { i.findings.cascadeRevealed = [{ f: "localName" }]; }).ok, false);
  assert.strictEqual(gate((i) => { i.findings.mismatches = [{ f: "country" }]; }).ok, false);
});

test("submitPrecondition: a review-page value that DISAGREES with the approved bundle blocks (page must match exactly)", () => {
  const r = gate((i) => { i.findings.reviewDisagree = [{ label: "Country", value_bundle: "Afghanistan", value_review: "United States" }]; });
  assert.strictEqual(r.ok, false);
  assert.ok(r.blockers.some((b) => /DISAGREE with the approved bundle/.test(b)));
});

// RELAXED 2026-07-28 (operator): "make it so it just checks if anything is filled wrong. if things are
// missing it is fine." DISAGREE is positive evidence — the page shows a CONTRADICTING value. MISSING is
// absence of evidence: Workday's summary doesn't render every field (live: `Language*` = "English"
// controls the page's display language and never appears there, blocking a run that was otherwise
// AGREE 53 · DISAGREE 0), and value-presence matching is heuristic on short values.
test("submitPrecondition: an approved value MISSING from the review page does NOT block on its own", () => {
  const r = gate((i) => { i.findings.reviewMissing = [{ label: "Language*", value_bundle: "English" }]; });
  assert.strictEqual(r.ok, true, "a value the page simply doesn't display can't block a submit: " + r.blockers.join("; "));
});

test("submitPrecondition: a DISAGREE still blocks — a contradicted value is the thing we check for", () => {
  const r = gate((i) => { i.findings.reviewDisagree = [{ label: "City", value_bundle: "Chicago", value_review: "Detroit" }]; });
  assert.strictEqual(r.ok, false);
  assert.ok(r.blockers.some((b) => /DISAGREE/.test(b)), r.blockers.join("; "));
});

// The ONE exception to the relaxation: a value WE deleted to clear Workday's phantom duplicate-entry
// error. That fix's whole premise is that Workday retained its own copy, so absence there IS positive
// evidence — the application would be filed without it.
test("submitPrecondition: a value WE deleted that didn't come back on the review page still BLOCKS", () => {
  const r = gate((i) => { i.findings.phantomLost = ["https://www.linkedin.com/in/wangykev"]; });
  assert.strictEqual(r.ok, false);
  assert.ok(r.blockers.some((b) => /did NOT come back/.test(b)), r.blockers.join("; "));
  assert.ok(r.blockers.some((b) => /linkedin/.test(b)), "names the value so the operator knows what would be lost");
});

test("submitPrecondition: a review-page scrape failure STILL blocks (can't check DISAGREE either)", () => {
  const r = gate((i) => { i.findings.reviewScrapeFailed = true; });
  assert.strictEqual(r.ok, false);
  assert.ok(r.blockers.some((b) => /could not read the review page/.test(b)));
});

test("submitPrecondition: a review-page scrape FAILURE blocks (can't confirm it matches → don't submit)", () => {
  const r = gate((i) => { i.findings.reviewScrapeFailed = true; });
  assert.strictEqual(r.ok, false);
  assert.ok(r.blockers.some((b) => /could not read the review page/.test(b)));
});

test("submitPrecondition: single-fire — alreadyFired BLOCKS a second submit (no double-submit)", () => {
  const r = gate((i) => { i.opts.alreadyFired = true; });
  assert.strictEqual(r.ok, false);
  assert.ok(r.blockers.some((b) => /already fired/.test(b)));
});

test("submitPrecondition: a soft-DELETED flagged field is EXCLUDED (doesn't block)", () => {
  const r = gate((i) => { i.bundle.entries.push({ field_id: "P::formField-gone", needs_review: true, is_approved: false, is_deleted: true }); });
  assert.strictEqual(r.ok, true, "a deleted entry is not part of the approval denominator: " + r.blockers.join("; "));
});

test("submitPrecondition: reports ALL blockers at once (nothing authorized, off-review, unapproved)", () => {
  const r = gate((i) => { i.opts.authorize = false; i.liveState.applyFlowReviewPresent = false; i.bundle.entries[1].is_approved = false; });
  assert.strictEqual(r.ok, false);
  assert.ok(r.blockers.length >= 3, "each failed check contributes a blocker: " + r.blockers.join("; "));
});

// ── bundleSubmitBlockers — the BUNDLE-only half of the gate, shared with the website submit run's
//    PRE-FLIGHT check (background.js AP_SUBMIT_APPLICATION). It must agree with submitPrecondition
//    exactly, and must never be laxer: a pre-flight PASS is what lets a run open a tab and sign in,
//    so anything it misses would be caught only after a full replay (and the live gate still runs).
const preflight = (m) => { const i = cleanSubmitInputs(); if (m) m(i); return bundleSubmitBlockers(i.bundle); };

test("bundleSubmitBlockers: a fully-approved bundle has NO blockers (the pre-flight lets it run)", () => {
  assert.deepStrictEqual(preflight(), []);
});

test("bundleSubmitBlockers: an UNAPPROVED flagged field blocks (the pre-flight refuses before opening a tab)", () => {
  const b = preflight((i) => { i.bundle.entries[1].is_approved = false; });
  assert.ok(b.some((x) => /not approved/.test(x)), b.join("; "));
});

test("bundleSubmitBlockers: an unapproved CASCADE-REVEALED field blocks even though it filled cleanly", () => {
  const b = preflight((i) => { i.bundle.entries.push({ field_id: "P::formField-c", cascade_revealed: true, needs_review: false, is_approved: false }); });
  assert.ok(b.some((x) => /not approved/.test(x)), b.join("; "));
});

test("bundleSubmitBlockers: an empty / missing bundle blocks (nothing to replay)", () => {
  assert.ok(bundleSubmitBlockers(null).some((x) => /no approved bundle entries/.test(x)));
  assert.ok(bundleSubmitBlockers({ entries: [] }).some((x) => /no approved bundle entries/.test(x)));
});

test("bundleSubmitBlockers: a schema_version this build doesn't accept blocks (stale bundle)", () => {
  const b = preflight((i) => { i.bundle.schema_version = "0.9"; });
  assert.ok(b.some((x) => /schema_version/.test(x)), b.join("; "));
});

test("bundleSubmitBlockers: an unreplaced AI placeholder blocks", () => {
  const b = preflight((i) => { i.bundle.entries[0].flag = "ai-text-needs-answer"; i.bundle.entries[0].current_value = "[NEEDS YOUR ANSWER: why us?]"; });
  assert.ok(b.some((x) => /placeholder/.test(x)), b.join("; "));
});

test("bundleSubmitBlockers: a soft-DELETED flagged field is EXCLUDED (mirrors the live gate)", () => {
  const b = preflight((i) => { i.bundle.entries.push({ field_id: "P::formField-gone", needs_review: true, is_approved: false, is_deleted: true }); });
  assert.deepStrictEqual(b, [], "a deleted entry is not part of the approval denominator");
});

// A REQUIRED field with no value must never reach submit. Before 2026-07-27 nothing in the approval
// layer or the gate encoded this — only Workday's own validation caught it, as a mid-replay nav-timeout
// halt (live: page 5, "The field Date is required and must have a value").
test("bundleSubmitBlockers: a REQUIRED field with no value blocks (approving it is not enough)", () => {
  const b = preflight((i) => { i.bundle.entries.push({ field_id: "P::formField-date", question_label: "Date", widget_type: "date", is_required: true, current_value: "", needs_review: true, is_approved: true }); });
  assert.ok(b.some((x) => /REQUIRED field\(s\) have no value/.test(x)), b.join("; "));
  assert.ok(b.some((x) => /Date/.test(x)), "names the field so the operator knows which one");
});

test("bundleSubmitBlockers: required-blank is CONSERVATIVE — no false positives on the carve-outs", () => {
  // An unchecked checkbox stores "false", not empty → not blank.
  assert.deepStrictEqual(preflight((i) => { i.bundle.entries.push({ field_id: "P::formField-cb", widget_type: "checkbox", is_required: true, current_value: "false" }); }), []);
  // The résumé has its own re-attach step + resume-not-attached halt.
  assert.deepStrictEqual(preflight((i) => { i.bundle.entries.push({ field_id: "P::formField-resume", widget_type: "file_upload", is_required: true, current_value: "" }); }), []);
  // Display-only stub rows are not fields.
  assert.deepStrictEqual(preflight((i) => { i.bundle.entries.push({ field_id: "P::formField-s", widget_type: "section_stub", is_required: true, current_value: "" }); }), []);
  // An OPTIONAL blank field is fine.
  assert.deepStrictEqual(preflight((i) => { i.bundle.entries.push({ field_id: "P::formField-o", widget_type: "text", is_required: false, current_value: "" }); }), []);
  // A soft-deleted required-blank row is excluded like every other deleted entry.
  assert.deepStrictEqual(preflight((i) => { i.bundle.entries.push({ field_id: "P::formField-d", widget_type: "text", is_required: true, current_value: "", is_deleted: true }); }), []);
});

test("NAMED INVARIANT — every bundle blocker is ALSO reported by submitPrecondition (pre-flight is never laxer)", () => {
  // Each mutation that the pre-flight rejects must ALSO be rejected by the live gate, otherwise the
  // two could disagree about whether an application is approved enough to submit.
  const mutations = [
    (i) => { i.bundle.entries[1].is_approved = false; },
    (i) => { i.bundle.schema_version = "0.9"; },
    (i) => { i.bundle.entries[0].flag = "ai-text-needs-answer"; i.bundle.entries[0].current_value = "[NEEDS YOUR ANSWER: why us?]"; },
    (i) => { i.bundle.entries = []; },
  ];
  for (const m of mutations) {
    const pre = preflight(m);
    assert.ok(pre.length, "the pre-flight must flag this bundle");
    const live = gate(m);
    assert.strictEqual(live.ok, false, "the live gate must ALSO refuse: " + pre.join("; "));
    for (const b of pre) assert.ok(live.blockers.includes(b), `live gate is missing the pre-flight blocker "${b}"`);
  }
});

// An approved entry that is NOT on the live page used to `continue` SILENTLY — the live page-5 case
// where 5 approved entries produced 4 replays and the missing one (an answered checkbox_group) was
// invisible. It must now surface as needs_review so the strict verify HALTS instead of walking on
// toward a submit that is missing an approved answer.
test("replayFlatFields: an approved field ABSENT from the live page is REPORTED, never silently dropped", async () => {
  const act = makeFakeAct([{ wrapperSel: '[data-automation-id="formField-here"]', fieldName: "here", widgetType: "text", value: "" }]);
  const entries = [
    { field_id: "P1::formField-here", widget_type: "text", current_value: "yes" },
    { field_id: "P1::formField-gone", widget_type: "checkbox_group", question_label: "Please check one of the boxes below", current_value: "I don't wish to answer" },
  ];
  const results = await replayFlatFields(act, entries, new Set(["here"]), T_BUDGETS);
  const absent = results.find((r) => r.field === "gone");
  assert.ok(absent, "the absent entry produces a RECORD (it used to vanish)");
  assert.strictEqual(absent.flag, "replay-field-absent");
  assert.strictEqual(absent.status, "skipped", "visible, but the review-page check is what judges it");
  assert.match(absent.detail, /was NOT replayed/);
  assert.match(absent.detail, /here/, "lists the live field names, so an id mismatch is obvious");
});

// NOTE the contract change (2026-07-27): repeating + file_upload entries are still skipped SILENTLY
// (each is handled by its own dedicated step), but an entry that is simply ABSENT from the live page is
// now REPORTED as needs_review instead of dropped — see the dedicated test above for why.
// SEVERITY (settled 2026-07-28): an absent field is NEVER fatal — recorded, logged, and judged at the
// REVIEW PAGE. Halting was wrong twice live: once on a page that was merely mid-cascade (only `country`
// had rendered), and once on an EEO page whose gender/ethnicity/veteranStatus questions Workday had
// simply stopped asking because it already holds the answers. The entry keeps its approved value, so
// reconcileReviewPage looks for it and submitPrecondition hard-blocks on `missing_on_review` — a value
// that really was lost cannot be submitted, without this having to guess mid-walk.
// The scan's name list is NOT an inventory of the page: cdpPageScan.fields filters out every field
// inside a repeating container. Live 2026-07-28 that reported page 4's EEO dropdowns absent and halted
// the replay while the operator was looking right at them — "all the values do exist on the page". So a
// field missing from the list is PROBED in the DOM before we believe it.
test("replayFlatFields: a field missing from the scan list but PRESENT in the DOM is replayed, not skipped", async () => {
  const eeo = { wrapperSel: '[data-automation-id="formField-gender"]', fieldName: "gender", widgetType: "dropdown", triggerText: "Select One", options: [{ text: "Select One", disabled: true }, { text: "Male" }] };
  const terms = { wrapperSel: '[data-automation-id="formField-acceptTermsAndAgreements"]', fieldName: "acceptTermsAndAgreements", widgetType: "checkbox", checked: false };
  const act = makeFakeAct([eeo, terms]);
  // The fake act answers selExists from the SAME field table the fills use — i.e. the DOM has gender,
  // even though the caller's `present` set (the filtered flat scan) does not list it.
  act.selExists = async (sel) => [eeo, terms].some((f) => f.wrapperSel === sel);
  const entries = [{ field_id: "P4::formField-gender", widget_type: "dropdown", is_required: true, current_value: "Male" }];
  const results = await replayFlatFields(act, entries, new Set(["acceptTermsAndAgreements"]), T_BUDGETS);
  assert.strictEqual(results.length, 1);
  assert.notStrictEqual(results[0].flag, "replay-field-absent", "the DOM probe overrides the incomplete scan list");
  assert.strictEqual(results[0].status, "filled", "and the approved value actually gets replayed");
});

test("replayFlatFields: a field absent from BOTH the scan list and the DOM is still reported absent", async () => {
  const act = makeFakeAct([{ wrapperSel: '[data-automation-id="formField-here"]', fieldName: "here", widgetType: "text", value: "" }]);
  act.selExists = async () => false; // genuinely not on the page
  const results = await replayFlatFields(act, [{ field_id: "P1::formField-gone", widget_type: "text", current_value: "x" }], new Set(["here"]), T_BUDGETS);
  assert.strictEqual(results[0].flag, "replay-field-absent");
  assert.strictEqual(results[0].status, "skipped");
});

test("replayFlatFields: an ABSENT approved field never halts the walk — required or not", async () => {
  const act = makeFakeAct([{ wrapperSel: '[data-automation-id="formField-here"]', fieldName: "here", widgetType: "text", value: "" }]);
  const entries = [
    { field_id: "P1::formField-req", widget_type: "text", is_required: true, current_value: "x" },
    { field_id: "P1::formField-opt", widget_type: "text", is_required: false, current_value: "y" },
  ];
  const results = await replayFlatFields(act, entries, new Set(["here"]), T_BUDGETS);
  for (const f of ["req", "opt"]) {
    const r = results.find((x) => x.field === f);
    assert.strictEqual(r.status, "skipped", `${f}: absent is never a failure — the review page decides`);
    assert.strictEqual(r.flag, "replay-field-absent", `${f}: still visible`);
  }
  assert.strictEqual(results.filter((r) => r.status === "needs_review" || r.status === "error").length, 0,
    "nothing here can trip the walk's strict-verify halt");
});

test("replayFlatFields: replays ONLY flat + present + re-fillable entries (skips repeating/file_upload; REPORTS absent)", async () => {
  const fn = { wrapperSel: '[data-automation-id="formField-legalName--firstName"]', fieldName: "legalName--firstName", widgetType: "text", value: "" };
  const cty = { wrapperSel: '[data-automation-id="formField-country"]', fieldName: "country", widgetType: "dropdown", triggerText: "Select One", options: [{ text: "Select One", disabled: true }, { text: "Canada" }] };
  const act = makeFakeAct([fn, cty]);
  const entries = [
    { field_id: "P1::formField-legalName--firstName", canonical_field: "personal_info.first_name", widget_type: "text", current_value: "Kevin" },
    { field_id: "P1::formField-country", canonical_field: "personal_info.country", widget_type: "dropdown", current_value: "Canada" },
    { field_id: "P2::formField-jobTitle", canonical_field: "workExperience[0].job_title", widget_type: "text", current_value: "Eng" }, // repeating → skip
    { field_id: "P2::formField-resume", canonical_field: null, widget_type: "file_upload", current_value: null },                    // file_upload → skip
    { field_id: "P1::formField-ssn", canonical_field: "personal_info.ssn", widget_type: "text", current_value: "x" }                  // not present → REPORTED (not silently dropped)
  ];
  const present = new Set(["legalName--firstName", "country"]); // the live page scan
  const results = await replayFlatFields(act, entries, present, T_BUDGETS);
  const filled = results.filter((r) => r.status === "filled");
  assert.deepStrictEqual(filled.map((r) => r.field).sort(), ["country", "legalName--firstName"], "only the 2 present flat fields are actually replayed");
  // repeating + file_upload stay SILENT (each has its own dedicated replay step)…
  assert.ok(!results.some((r) => r.field === "jobTitle" || r.field === "resume"), "repeating/file_upload are handled elsewhere, not reported here");
  // …but an ABSENT approved field is surfaced, never dropped.
  const ssn = results.find((r) => r.field === "ssn");
  assert.ok(ssn && ssn.flag === "replay-field-absent" && ssn.status === "skipped", "an approved value with nowhere to go is reported, not dropped — and not fatal");
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

// ── M3: repeating-field replay — bundle→items reconstruction ─────────────────
// coerceReplayValue reverses the bundle's DISPLAY value into fillEntryCdp's item[key] shape;
// bundleToSectionItems rebuilds a section's profile-shaped items (grouped/re-indexed, path→key,
// dates re-parsed, nested + Feature-B added entries) to feed driveRepeatingSectionCdp.

test("coerceReplayValue: dates reversed to the parsed shape; checkbox→bool; text passthrough; null→null", () => {
  assert.deepStrictEqual(coerceReplayValue("6/15/2024", "date"), { month: "6", day: "15", year: "2024" });
  assert.deepStrictEqual(coerceReplayValue("5/2025", "date"), { month: "5", year: "2025" });
  assert.strictEqual(coerceReplayValue("2024", "date"), "2024");        // single segment (year) → string
  assert.strictEqual(coerceReplayValue("2024", "year"), "2024");
  assert.strictEqual(coerceReplayValue("true", "checkbox"), true);
  assert.strictEqual(coerceReplayValue("false", "checkbox"), false);
  assert.strictEqual(coerceReplayValue("Software Engineer", "text"), "Software Engineer");
  assert.strictEqual(coerceReplayValue(null, "text"), null);
  assert.strictEqual(coerceReplayValue("", "dropdown"), null);
});

const weSection = () => PAGE_SECTIONS.find((s) => s.name === "workExperience");
const certSection = () => PAGE_SECTIONS.find((s) => s.name === "certification");
const bent = (cf, val, extra) => Object.assign({ canonical_field: cf, current_value: val, widget_type: "text" }, extra || {});

test("bundleToSectionItems (WE): path→key mapping, date reparse, checkbox bool, multi-entry", () => {
  const items = bundleToSectionItems([
    bent("workExperience[0].job_title", "Engineer"),
    bent("workExperience[0].company", "Acme"),
    bent("workExperience[0].currently_work_here", "true"),
    bent("workExperience[0].from", "5/2025"),
    bent("workExperience[0].role_description", "Built things"),
    bent("workExperience[1].job_title", "Intern")
  ], weSection());
  assert.strictEqual(items.length, 2);
  assert.deepStrictEqual(items[0], { job_title: "Engineer", company: "Acme", currently_work_here: true, fromParsed: { month: "5", year: "2025" }, bulletsText: "Built things" });
  assert.deepStrictEqual(items[1], { job_title: "Intern" });
});

test("bundleToSectionItems: drops soft-deleted entries and re-indexes the survivors 0..M-1", () => {
  const items = bundleToSectionItems([
    bent("workExperience[0].job_title", "Deleted", { is_deleted: true }),
    bent("workExperience[1].job_title", "Kept")
  ], weSection());
  assert.strictEqual(items.length, 1, "the deleted entry is dropped");
  assert.deepStrictEqual(items[0], { job_title: "Kept" }, "survivor re-indexed to 0");
});

test("bundleToSectionItems: Feature-B added entry (higher index) is INCLUDED", () => {
  const items = bundleToSectionItems([
    bent("workExperience[0].job_title", "First"),
    bent("workExperience[2].job_title", "Added", { is_added: true, flag: "added-entry" })
  ], weSection());
  assert.strictEqual(items.length, 2, "added entry included → replay must CREATE it");
  assert.deepStrictEqual(items.map((i) => i.job_title), ["First", "Added"]);
});

test("bundleToSectionItems (Phase 5): a LEFT-removed removed_entry is SKIPPED (no phantom blank); an ADDED-BACK entry reconstructs", () => {
  // A delete-with-memory `removed_entry` the user LEFT removed has canonical "<name>[i].__removed" — it
  // matches the index regex but must NOT create an empty item (else the replay would re-create a blank
  // entry). An ADDED-BACK entry is real field records at a fresh index → reconstructs like any entry.
  const left = bundleToSectionItems([
    bent("workExperience[0].job_title", "Kept"),
    bent("workExperience[1].__removed", null, { widget_type: "removed_entry", flag: "entry-removed-remembered" }),
  ], weSection());
  assert.strictEqual(left.length, 1, "the left-removed entry does NOT reconstruct (no phantom blank item)");
  assert.deepStrictEqual(left[0], { job_title: "Kept" });

  const addedBack = bundleToSectionItems([
    bent("workExperience[0].job_title", "Kept"),
    bent("workExperience[3].job_title", "AddedBack", { is_added: true, flag: "added-entry" }),
    bent("workExperience[3].company", "Acme", { is_added: true }),
  ], weSection());
  assert.strictEqual(addedBack.length, 2, "the added-back entry reconstructs → replay re-creates it");
  assert.deepStrictEqual(addedBack.map((i) => i.job_title), ["Kept", "AddedBack"]);
  assert.deepStrictEqual(addedBack[1], { job_title: "AddedBack", company: "Acme" }, "its remembered + supplied values ride through");
});

test("bundleToSectionItems (cert nested): reconstructs item.specialties[j] with key mapping + date reparse", () => {
  const items = bundleToSectionItems([
    bent("certification[0].certification", "CPP", { widget_type: "typeahead" }),
    bent("certification[0].specialties[0].specialtyParent", "Safety", { widget_type: "typeahead" }),
    bent("certification[0].specialties[0].startDate", "6/15/2024", { widget_type: "date" })
  ], certSection());
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].certification, "CPP");
  assert.deepStrictEqual(items[0].specialties, [{ specialty: "Safety", startDateParsed: { month: "6", day: "15", year: "2024" } }]);
});

// ── M3: replayRepeatingSections orchestrator ─────────────────────────────────
// Feeds bundleToSectionItems into driveRepeatingSectionCdp (strict: deleteOnNoMatch:false,
// aiContext:null) for each present section that has approved bundle entries.

test("replayRepeatingSections: replays a present section's entries from the approved bundle", async () => {
  const state = webState({ entries: [webEntry("webAddress-0--null", ""), webEntry("webAddress-1--null", "")] });
  const act = makeFakeRepeatAct(state);
  const entries = [
    { canonical_field: "website[0].url", current_value: "https://a.example", widget_type: "text" },
    { canonical_field: "website[1].url", current_value: "https://b.example", widget_type: "text" }
  ];
  const results = await replayRepeatingSections(act, entries, T_BUDGETS);
  const r0 = results.find((r) => r.fieldName === "website[0].url");
  const r1 = results.find((r) => r.fieldName === "website[1].url");
  assert.strictEqual(r0 && r0.after, "https://a.example");
  assert.strictEqual(r1 && r1.after, "https://b.example");
});

test("replayRepeatingSections: skips a present section that has NO approved bundle entries (untouched)", async () => {
  const state = webState({ entries: [webEntry("webAddress-0--null", "")] }); // website present on the page
  const act = makeFakeRepeatAct(state);
  const entries = [{ canonical_field: "personal_info.first_name", current_value: "Ada", widget_type: "text" }]; // no website[*]
  const results = await replayRepeatingSections(act, entries, T_BUDGETS);
  assert.strictEqual(results.length, 0, "no approved website entries → section untouched");
  assert.ok(!act.log.some(([m]) => m === "clickSectionAdd"), "no reconcile on an empty-bundle section");
});

test("replayRepeatingSections: CREATES a Feature-B added entry (reconciles UP) and fills it", async () => {
  const state = webState({ entries: [webEntry("webAddress-0--null", "")] }); // live form starts with 1 entry
  const act = makeFakeRepeatAct(state);
  const entries = [
    { canonical_field: "website[0].url", current_value: "https://a.example", widget_type: "text" },
    { canonical_field: "website[1].url", current_value: "https://added.example", widget_type: "text", is_added: true, flag: "added-entry" }
  ];
  const results = await replayRepeatingSections(act, entries, T_BUDGETS);
  assert.strictEqual(state.entries.length, 2, "reconciled UP to include the added entry");
  assert.ok(act.log.some(([m]) => m === "clickSectionAdd"), "created the added entry");
  assert.ok(results.some((r) => r.fieldName === "website[1].url" && r.after === "https://added.example"), "filled the added entry");
});

test("replayRepeatingSections: a DELETED section (is_deleted entries) reconciles the live form DOWN TO 0", async () => {
  // Operator deleted the section in review → bundle has only is_deleted entries → the LIVE form must be
  // emptied (the 'cert did not delete' bug: it used to skip, leaving the operator-removed rows to submit).
  const state = webState({ entries: [webEntry("webAddress-0--null", "https://a.example"), webEntry("webAddress-1--null", "https://b.example")] });
  const act = makeFakeRepeatAct(state);
  const entries = [
    { canonical_field: "website[0].url", current_value: "https://a.example", widget_type: "text", is_deleted: true },
    { canonical_field: "website[1].url", current_value: "https://b.example", widget_type: "text", is_deleted: true },
  ];
  await replayRepeatingSections(act, entries, T_BUDGETS);
  assert.strictEqual(state.entries.length, 0, "a deleted section is reconciled to 0 on the live form (not left as-is)");
  assert.ok(act.log.some(([m]) => m === "clickDeleteEntry"), "the live rows were deleted");
});

// ── Answer buckets (Profile v2) ──────────────────────────────────────────────
// The consume tier: an UNMAPPED field whose question matches a bucket wording
// fills from the bucket — a candidate through the match ladder (never blind) —
// BEFORE the AI pass, for required and optional fields alike.

test("buildBucketIndex: normalizes wordings, skips blanks/malformed, maps to the bucket", () => {
  const b1 = { id: "a", questions: ["Are you 18?  ", "OVER 18*"] };
  const b2 = { id: "b", questions: ["", "Gender"] };
  const idx = buildBucketIndex([b1, b2, null, {}, { questions: "nope" }]);
  assert.equal(idx.get("are you 18?"), b1);
  assert.equal(idx.get("over 18"), b1); // trailing required marker + case stripped
  assert.equal(idx.get("gender"), b2);
  assert.equal(idx.has(""), false);
});

test("bucket Mode B: an unmapped field whose label matches a wording fills from the saved value, flagged 'bucket'", async () => {
  const field = { wrapperSel: "#b1", fieldName: "customColorQ", widgetType: "text", label: "What is your favorite color?", value: "" };
  const bucket = { id: "color", profile_path: "", value: ["Blue"], widget_hint: "text", questions: ["What is your favorite color?"], selectors: {} };
  const out = await drivePageFill(makeFakeAct([field]), {}, {}, {}, T_BUDGETS, { buckets: [bucket] });
  const rec = out.results.find((r) => r.fieldName === "customColorQ");
  assert.equal(rec.status, "filled");
  assert.equal(rec.flag, "bucket");
  assert.equal(field.value, "Blue");
  assert.match(rec.detail, /answer bucket/);
});

test("bucket Mode A: reads the bound profile field", async () => {
  const field = { wrapperSel: "#b2", fieldName: "legalGiven", widgetType: "text", label: "Legal given name", value: "" };
  const bucket = { id: "fn", profile_path: "personal_info.first_name", value: "", widget_hint: "text", questions: ["Legal given name"], selectors: {} };
  const out = await drivePageFill(makeFakeAct([field]), { personal_info: { first_name: "Ada" } }, {}, {}, T_BUDGETS, { buckets: [bucket] });
  const rec = out.results.find((r) => r.fieldName === "legalGiven");
  assert.equal(rec.status, "filled");
  assert.equal(rec.flag, "bucket");
  assert.equal(field.value, "Ada");
  assert.match(rec.detail, /personal_info\.first_name/);
});

test("resolve: coercion matrix — a triBool answer is fillable as checkbox/radio/dropdown, Yes/No AND True/False labels", () => {
  // The class of bug: a value PRESENT in the profile that resolve() turns into a candidate that can
  // never match the live options → silent fall-through to AI. A boolean triBool must resolve to a tiered
  // ["Yes","True"] / ["No","False"] list for BOTH dropdown and radio (checkbox has its own path), so the
  // match ladder hits whether the options are labeled Yes/No or True/False.
  for (const w of ["dropdown", "typeahead", "radio"]) {
    assert.deepEqual(resolve(true, w).candidates, ["Yes", "True"], `${w}: true → Yes/True ladder`);
    assert.deepEqual(resolve(false, w).candidates, ["No", "False"], `${w}: false → No/False ladder`);
    assert.equal(resolve(null, w).skip, true, `${w}: null (unanswered) → skip, never guessed`);
    assert.equal(resolve(undefined, w).skip, true, `${w}: undefined → skip`);
  }
  // A tiered candidate list passes through as the ladder for ALL choice widgets — including radio (the
  // gap this closes: resolve(array,"radio") used to become String(array) → "a,b" → never matched).
  for (const w of ["dropdown", "typeahead", "radio"]) {
    assert.deepEqual(resolve(["Bachelor of Science", "Bachelors"], w).candidates, ["Bachelor of Science", "Bachelors"], `${w}: tiered array → ladder`);
    assert.equal(resolve([], w).skip, true, `${w}: empty array → skip`);
  }
  // A plain string still passes through as a single candidate; empty string skips.
  assert.deepEqual(resolve("Male", "dropdown").candidates, ["Male"]);
  assert.equal(resolve("", "dropdown").skip, true);
});

test("boolLadderCandidates: a custom per-field yes/no ladder overrides the default; empty/absent → default", () => {
  const profile = { answer_ladders: { "screening.at_least_18_years_old": { yes: ["Yes", "True", "Affirmative"], no: [] } } };
  assert.deepEqual(boolLadderCandidates(profile, "screening.at_least_18_years_old", true), ["Yes", "True", "Affirmative"], "custom yes ladder used");
  assert.deepEqual(boolLadderCandidates(profile, "screening.at_least_18_years_old", false), ["No", "False"], "empty no list → default");
  assert.deepEqual(boolLadderCandidates(profile, "work_authorization.permanent_resident", true), ["Yes", "True"], "absent path → default");
  assert.deepEqual(boolLadderCandidates({}, "x", false), ["No", "False"], "no answer_ladders map → default");
  assert.deepEqual(boolLadderCandidates(null, "x", true), ["Yes", "True"], "null profile → default");
  // blanks are filtered — an all-blank custom list falls back to the default
  assert.deepEqual(boolLadderCandidates({ answer_ladders: { p: { yes: ["", "  "] } } }, "p", true), ["Yes", "True"], "all-blank custom → default");
});

test("appendFieldVariants: appends a scalar field's variants (answer_ladders[path].values) after the primary, deduped", () => {
  const profile = { answer_ladders: { "self_identification.gender": { yes: [], no: [], values: ["Man", "M"] } } };
  assert.deepEqual(appendFieldVariants(profile, "self_identification.gender", ["Male"]), ["Male", "Man", "M"]);
  assert.deepEqual(appendFieldVariants(profile, "self_identification.gender", "Male"), ["Male", "Man", "M"], "scalar arg wrapped");
  assert.deepEqual(appendFieldVariants({}, "x", ["A"]), ["A"], "no answer_ladders → unchanged");
  assert.deepEqual(appendFieldVariants(null, "x", ["A"]), ["A"], "null profile → unchanged");
  assert.deepEqual(appendFieldVariants({ answer_ladders: { p: { values: ["male"] } } }, "p", ["Male"]), ["Male"], "dup (case-insensitive) dropped");
  assert.deepEqual(appendFieldVariants({ answer_ladders: { p: { values: ["", "  "] } } }, "p", ["A"]), ["A"], "blanks dropped");
});

test("flat education: a Mode-A bucket bound to education.0.gpa fills a flat GPA field from education[0] (+ honors variants)", async () => {
  // Many forms ask education as a single flat question. A Mode-A bucket bound to "education.0.gpa"
  // resolves education[0].gpa via getByPath; on a range-dropdown the field's variant matches.
  const field = { wrapperSel: "#gpa", fieldName: "gpaHashed", widgetType: "dropdown", label: "GPA range?",
    triggerText: "Select One", options: [{ text: "Select One", disabled: true }, { text: "3.5+" }, { text: "3.0-3.5" }] };
  const bucket = { id: "edu_gpa", profile_path: "education.0.gpa", value: [], widget_hint: "text", questions: ["GPA range?"], selectors: {} };
  const profile = { education: [{ gpa: "4.0/4.0" }], answer_ladders: { "education.0.gpa": { yes: [], no: [], values: ["3.5+"] } } };
  const out = await drivePageFill(makeFakeAct([field]), profile, {}, {}, T_BUDGETS, { buckets: [bucket] });
  const rec = out.results.find((r) => r.fieldName === "gpaHashed");
  assert.equal(rec.flag, "bucket", "filled from the education.0.gpa bucket (education[0])");
  assert.equal(rec.after, "3.5+", "primary '4.0/4.0' missed; the education.0.gpa variant matched the range option");
});

test("flat education: a Mode-A bucket bound to education.0.school_or_university types education[0] school on a text field", async () => {
  const field = { wrapperSel: "#sch", fieldName: "schoolHashed", widgetType: "text", label: "School", value: "" };
  const bucket = { id: "edu_school", profile_path: "education.0.school_or_university", value: [], widget_hint: "text", questions: ["School"], selectors: {} };
  const profile = { education: [{ school_or_university: "Carnegie Mellon University" }] };
  const out = await drivePageFill(makeFakeAct([field]), profile, {}, {}, T_BUDGETS, { buckets: [bucket] });
  const rec = out.results.find((r) => r.fieldName === "schoolHashed");
  assert.equal(rec.flag, "bucket");
  assert.equal(field.value, "Carnegie Mellon University", "flat school field filled from education[0]");
});

test("bucket + field variants: a flat scalar dropdown matches a VARIANT option (e.g. gender 'Man')", async () => {
  // gender is "Male" in the profile; a tenant labels the option "Man". The editable per-field variant
  // ["Man"] lets the dropdown match (tried after the primary "Male").
  const field = { wrapperSel: "#g", fieldName: "genderHashed", widgetType: "dropdown", label: "Gender identity?",
    triggerText: "Select One", options: [{ text: "Select One", disabled: true }, { text: "Man" }, { text: "Woman" }] };
  const bucket = { id: "g", profile_path: "self_identification.gender", value: [], widget_hint: "dropdown", questions: ["Gender identity?"], selectors: {} };
  const profile = { self_identification: { gender: "Male" }, answer_ladders: { "self_identification.gender": { yes: [], no: [], values: ["Man"] } } };
  const out = await drivePageFill(makeFakeAct([field]), profile, {}, {}, T_BUDGETS, { buckets: [bucket] });
  const rec = out.results.find((r) => r.fieldName === "genderHashed");
  assert.equal(rec.flag, "bucket");
  assert.equal(rec.after, "Man", "primary 'Male' missed the options; the 'Man' variant matched");
});

test("bucket Mode A + custom answer_ladders: a yes/no dropdown fills the operator's custom label (Affirmative)", async () => {
  // The full path: bucket Mode-A → boolean true → boolLadderCandidates(custom) → the ladder matches a
  // tenant that labels the option "Affirmative" instead of Yes/True.
  const field = { wrapperSel: "#aff", fieldName: "hashedAff", widgetType: "dropdown", label: "Are you over the age of 18?*",
    triggerText: "Select One", options: [{ text: "Select One", disabled: true }, { text: "Affirmative" }, { text: "Negative" }] };
  const bucket = { id: "over_18", profile_path: "screening.at_least_18_years_old", value: [], widget_hint: "radio", questions: ["Are you over the age of 18?"], selectors: {} };
  const profile = { screening: { at_least_18_years_old: true }, answer_ladders: { "screening.at_least_18_years_old": { yes: ["Yes", "True", "Affirmative"], no: ["No", "False"] } } };
  const out = await drivePageFill(makeFakeAct([field]), profile, {}, {}, T_BUDGETS, { buckets: [bucket] });
  const rec = out.results.find((r) => r.fieldName === "hashedAff");
  assert.equal(rec.flag, "bucket", "filled deterministically from the bucket + custom ladder");
  assert.equal(rec.after, "Affirmative", "the custom candidate matched the tenant's 'Affirmative' option");
});

test("bucket Mode A: a Yes/No triBool fills a DROPDOWN (boolean → Yes), not just radio — the over-18 legally-loaded bug", async () => {
  // screening.at_least_18_years_old is a triBool (boolean). On tenants that render the question as a
  // DROPDOWN, resolve() used to String(true) → "true", which never matched the "Yes" option, so the
  // bucket produced nothing and the field fell to the AI (flag ai-choice-sensitive, "LEGALLY-LOADED —
  // VERIFY") on EVERY fill even though the profile answers it. resolve() now coerces boolean → Yes/No
  // for dropdowns too, so the bucket fills it deterministically (flag "bucket", no review, no AI).
  const field = { wrapperSel: "#a18", fieldName: "hashed18", widgetType: "dropdown", label: "Are you over the age of 18?*",
    triggerText: "Select One", options: [{ text: "Select One", disabled: true }, { text: "Yes" }, { text: "No" }] };
  const bucket = { id: "over_18", profile_path: "screening.at_least_18_years_old", value: [], widget_hint: "radio", questions: ["Are you over the age of 18?"], selectors: {} };
  const act = makeFakeAct([field], { aiEnabled: true, ai: '{"choice":"No","justification":"x","confidence":"Low"}' }); // AI (if reached) would say No
  const out = await drivePageFill(act, { screening: { at_least_18_years_old: true } }, {}, {}, T_BUDGETS, { buckets: [bucket] });
  const rec = out.results.find((r) => r.fieldName === "hashed18");
  assert.equal(rec.flag, "bucket", "the triBool bucket filled the dropdown deterministically");
  assert.equal(rec.after, "Yes", "boolean true → Yes matched the live option");
  assert.ok(!act.log.some((e) => e[0] === "llm"), "the AI pass never ran — no legally-loaded guess");
  // and the false → No direction
  const field2 = { wrapperSel: "#a18b", fieldName: "hashed18b", widgetType: "dropdown", label: "Are you over the age of 18?*",
    triggerText: "Select One", options: [{ text: "Select One", disabled: true }, { text: "Yes" }, { text: "No" }] };
  const out2 = await drivePageFill(makeFakeAct([field2]), { screening: { at_least_18_years_old: false } }, {}, {}, T_BUDGETS, { buckets: [{ ...bucket }] });
  const rec2 = out2.results.find((r) => r.fieldName === "hashed18b");
  assert.equal(rec2.after, "No", "boolean false → No");
});

test("bucket Mode A: an EMPTY bound profile value produces nothing (falls through, never blind-fills)", async () => {
  const field = { wrapperSel: "#b6", fieldName: "legalGiven", widgetType: "text", label: "Legal given name", value: "" };
  const bucket = { id: "fn", profile_path: "personal_info.first_name", value: "", widget_hint: "text", questions: ["Legal given name"], selectors: {} };
  const out = await drivePageFill(makeFakeAct([field]), { personal_info: {} }, {}, {}, T_BUDGETS, { buckets: [bucket] });
  const rec = out.results.find((r) => r.fieldName === "legalGiven");
  assert.notEqual(rec.flag, "bucket");
});

test("bucket: an unmapped field with NO matching wording is not bucket-filled", async () => {
  const field = { wrapperSel: "#b3", fieldName: "customX", widgetType: "text", label: "Some unmapped question", value: "" };
  const bucket = { id: "color", profile_path: "", value: ["Blue"], widget_hint: "text", questions: ["What is your favorite color?"], selectors: {} };
  const out = await drivePageFill(makeFakeAct([field]), {}, {}, {}, T_BUDGETS, { buckets: [bucket] });
  const rec = out.results.find((r) => r.fieldName === "customX");
  assert.notEqual(rec.flag, "bucket");
  assert.equal(rec.status, "skipped");
});

test("bucket: a match fills BEFORE the AI pass — the LLM is never consulted", async () => {
  const field = { wrapperSel: "#b4", fieldName: "customColorQ", widgetType: "text", label: "What is your favorite color?", isRequired: true, value: "" };
  const bucket = { id: "color", profile_path: "", value: ["Blue"], widget_hint: "text", questions: ["What is your favorite color?"], selectors: {} };
  const act = makeFakeAct([field], { aiEnabled: true, ai: '{"answer":"Green"}' });
  const out = await drivePageFill(act, {}, {}, {}, T_BUDGETS, { buckets: [bucket] });
  const rec = out.results.find((r) => r.fieldName === "customColorQ");
  assert.equal(rec.flag, "bucket");
  assert.equal(field.value, "Blue");
  assert.ok(!act.log.some((e) => e[0] === "llm"), "the bucket won → the AI pass never ran");
});

test("bucket Mode B: `value` is a CANDIDATE LIST — a choice widget tries each in order until one matches the live options", async () => {
  const field = { wrapperSel: "#b7", fieldName: "clearanceQ", widgetType: "dropdown", label: "Do you hold an active security clearance?",
    triggerText: "Select One", options: [{ text: "Select One", disabled: true }, { text: "Yes" }, { text: "No" }] };
  // the tenant words the option "No"; the first (more specific) candidate isn't on this form → the ladder falls to "No"
  const bucket = { id: "clearance", profile_path: "", value: ["No, I do not", "No"], widget_hint: "dropdown", questions: ["Do you hold an active security clearance?"], selectors: {} };
  const out = await drivePageFill(makeFakeAct([field]), {}, {}, {}, T_BUDGETS, { buckets: [bucket] });
  const rec = out.results.find((r) => r.fieldName === "clearanceQ");
  assert.equal(rec.flag, "bucket");
  assert.equal(rec.after, "No", "first candidate missed the live options; second matched (tiered fill)");
});

test("bucket Mode B: a LEGACY single-string `value` is tolerated (upgraded to one candidate at fill time)", async () => {
  const field = { wrapperSel: "#b8", fieldName: "legacyQ", widgetType: "text", label: "Legacy stored question?", value: "" };
  const bucket = { id: "legacy", profile_path: "", value: "Blue", widget_hint: "text", questions: ["Legacy stored question?"], selectors: {} };
  const out = await drivePageFill(makeFakeAct([field]), {}, {}, {}, T_BUDGETS, { buckets: [bucket] });
  const rec = out.results.find((r) => r.fieldName === "legacyQ");
  assert.equal(rec.flag, "bucket", "a pre-migration string value still fills");
  assert.equal(field.value, "Blue");
});

// The section maps are the UNION of every Workday shape seen, so a tenant that OMITS a field always
// resolved nothing for it. That was harmless on the fill and fatal on the REPLAY, which treats any
// `error` as "did not replay cleanly" and HALTS. Live 2026-08-02, Solar Turbines R0000372989: its
// education entry has only School + Degree, so EDUCATION_MAP's gpa/from/to died "field wrapper not
// found in entry" and a rehearsal halted replay-mismatch on three fields that were never on the form
// and had no approved value. A missing wrapper we DO hold a value for must still be an error.
test("education: a field this tenant does not render, with nothing to fill, is SKIPPED not error", async () => {
  const fkit = "education-1--null";
  const domEntry = { fkit, fields: [
    { fieldName: "schoolName", label: "School or University*", widgetType: "text", isRequired: true, value: "" },
    { fieldName: "degree", label: "Degree*", widgetType: "dropdown", isRequired: true, triggerText: "Select One",
      options: [{ text: "Select One", disabled: true }, { text: "Bachelor of Science (BS)" }] },
  ] }; // NOTE: no gpa, no firstYearAttended, no lastYearAttended — this tenant omits them
  const state = { prefix: "education-", addable: true, deletable: true, newEntry: () => domEntry, entries: [domEntry] };
  const act = makeFakeRepeatAct(state);
  const out = await driveRepeatingSectionCdp(act, {
    name: "education", headingRegex: "education", containerPrefix: "education-",
    items: [{ school_or_university: "Carnegie Mellon University", degree: "Bachelor of Science (BS)" }],
    fieldMap: EDUCATION_MAP, deleteOnNoMatch: false,
  }, T_BUDGETS);
  const byName = (n) => out.results.find((r) => r.fieldName === n);
  for (const n of ["education[0].gradeAverage", "education[0].firstYearAttended", "education[0].lastYearAttended"]) {
    const r = byName(n);
    if (!r) continue; // the map may name it differently; only assert on what was emitted
    assert.notStrictEqual(r.status, "error", n + " must not be an error — nothing to fill (" + r.detail + ")");
  }
  assert.strictEqual(out.results.filter((r) => r.status === "error").length, 0,
    "no hard errors: " + JSON.stringify(out.results.filter((r) => r.status === "error").map((r) => r.fieldName + ": " + r.detail)));
});

// The counterexample that keeps this honest: an approved value with nowhere to go is still an ERROR,
// because that is a real place a value could silently vanish.
test("education: a missing wrapper we DO have a value for is still an ERROR", async () => {
  const fkit = "education-1--null";
  const domEntry = { fkit, fields: [
    { fieldName: "schoolName", label: "School or University*", widgetType: "text", isRequired: true, value: "" },
  ] }; // degree is NOT rendered, but we hold a degree value
  const state = { prefix: "education-", addable: true, deletable: true, newEntry: () => domEntry, entries: [domEntry] };
  const act = makeFakeRepeatAct(state);
  const out = await driveRepeatingSectionCdp(act, {
    name: "education", headingRegex: "education", containerPrefix: "education-",
    items: [{ school_or_university: "Carnegie Mellon University", degree: "Bachelor of Science (BS)" }],
    fieldMap: EDUCATION_MAP, deleteOnNoMatch: false,
  }, T_BUDGETS);
  const deg = out.results.find((r) => r.fieldName === "education[0].degree");
  assert.ok(deg, "a record was emitted for the unrendered degree");
  assert.strictEqual(deg.status, "error", "an approved value with nowhere to go must still stop the run");
});

const apMatchLib = require("../lib.js");
const { REVIEW_SCHEMA_VERSION } = require("../fill-driver.js");
// ── the PLACEHOLDER row is never an answer (Waystar live 2026-08-02) ─────────
// Workday's "Select One" is normally aria-disabled and the option readers drop it. Waystar's is a
// plain ENABLED option, so it reached the AI as a legitimate choice, the AI picked it, and Workday
// rejected the page: "The field ... is required and must have a value". A placeholder is also
// TEMPORARY on Workday — once a real option is chosen it leaves the menu and cannot be chosen again
// (operator 2026-08-02), so it must not be offerable anywhere.
const phDd = (flags) => Object.assign({
  wrapperSel: "[w-ph]", fieldName: "relocate_q", widgetType: "dropdown", isRequired: true,
  label: "Would you be open to relocating for this role?",
  // ENABLED placeholder — exactly Waystar's shape (contrast aiDd above, whose placeholder is disabled).
  triggerText: "Select One",
  options: [{ text: "Select One" }, { text: "Yes, I am open to relocating" }, { text: "No, I am not open to relocating" }]
}, flags || {});

test("AI dropdown: an ENABLED 'Select One' placeholder is never OFFERED to the AI", async () => {
  const act = makeFakeAct([phDd()], { aiEnabled: true, ai: '{"choice":"Yes, I am open to relocating","justification":"j","confidence":"High"}' });
  await drivePageFill(act, {}, {}, {}, T_BUDGETS);
  const prompts = act.log.filter(([m]) => m === "llm").map(([, u]) => String(u));
  assert.ok(prompts.length, "the AI ran");
  const optLine = prompts.find((p) => /Answer options/.test(p)) || "";
  assert.ok(/Yes, I am open to relocating/.test(optLine), "the real options are still offered");
  assert.ok(!/Select One/.test(optLine), "the placeholder must NOT be in the AI's option list");
});

test("AI dropdown: the AI cannot COMMIT the placeholder even if it names it", async () => {
  // The model replies with the prompt row. It is not in the offered list, so it must not match —
  // the field lands in review instead of committing a value the form counts as empty.
  const act = makeFakeAct([phDd()], { aiEnabled: true, ai: '{"choice":"Select One","justification":"j","confidence":"High"}' });
  const rec = (await drivePageFill(act, {}, {}, {}, T_BUDGETS)).results[0];
  assert.notStrictEqual(rec.after, "Select One", "the placeholder is never committed as the answer");
  assert.strictEqual(rec.status, "needs_review", "no valid choice → review, not a bogus fill");
});

test("submit gate: a REQUIRED choice field still holding the placeholder BLOCKS submit", async () => {
  // A bundle written by an older build can hold one. It reads like an answer, so nothing else catches it.
  const bundle = { schema_version: REVIEW_SCHEMA_VERSION, entries: [
    { field_id: "p::formField-relocate", question_label: "Open to relocating?", widget_type: "dropdown",
      is_required: true, current_value: "Select One", is_approved: true },
  ] };
  const blockers = bundleSubmitBlockers(bundle);
  assert.ok(blockers.some((b) => /REQUIRED field\(s\) have no value/.test(b)),
    "a placeholder is not a value: " + JSON.stringify(blockers));
});

test("submit gate: a TEXT field whose real answer reads like a prompt is NOT treated as blank", async () => {
  // Scope guard: only a MENU has a prompt row. Free text must never be second-guessed.
  const bundle = { schema_version: REVIEW_SCHEMA_VERSION, entries: [
    { field_id: "p::formField-note", question_label: "Instructions you follow", widget_type: "text",
      is_required: true, current_value: "Select one", is_approved: true },
  ] };
  assert.ok(!bundleSubmitBlockers(bundle).some((b) => /have no value/.test(b)), "a text answer is a value");
});

test("isPlaceholderOption: prompt rows yes, real options no", () => {
  const yes = ["Select One", "select one", "-- Select --", "Please select", "Choose...", "", "---", "Select an option", "None selected"];
  const no = ["Yes", "No", "Other", "Select all that apply to you", "Selected Reservist", "Choose Health Plan A", "I choose not to disclose"];
  for (const t of yes) assert.ok(apMatchLib.isPlaceholderOption(t), JSON.stringify(t) + " is a placeholder");
  for (const t of no) assert.ok(!apMatchLib.isPlaceholderOption(t), JSON.stringify(t) + " is a REAL option");
  assert.deepStrictEqual(apMatchLib.withoutPlaceholderOptions(["Select One", "Yes", "No"]), ["Yes", "No"]);
  assert.deepStrictEqual(apMatchLib.withoutPlaceholderOptions(["Select One"]), ["Select One"],
    "an ALL-placeholder list is handed back untouched — never leave the caller with nothing");
});

// ── the error parser must not stop at the LABEL's own stop-word (Copart live 2026-08-03) ──
// Workday's banner is "The field <LABEL> is required and must have a value." The generic pattern is
// non-greedy, so a label containing " is " ended the match early: "What is your anticipated
// graduation month and year (MM/YYYY)" parsed as "What". A truncated name matches no wrapper, so
// Tier-1 remediation, the phantom-required guard and the field diagnosis all got a useless name and
// silently did nothing while the page stayed blocked.
test("parseErrorFieldName: a label containing its own stop-word survives", () => {
  const cases = [
    ["Error-What is your anticipated graduation month and year (MM/YYYY)The field  What is your anticipated graduation month and year (MM/YYYY)   is required and must have a value.",
     "What is your anticipated graduation month and year (MM/YYYY)"],
    ["The field What is your desired compensation is required and must have a value.", "What is your desired compensation"],
    ["The field When are you available to start is required and must have a value.", "When are you available to start"],
    // labels with no stop-word of their own must keep working
    ["The field Date is required and must have a value.", "Date"],
    ["The field Are you currently enrolled in a Canadian University or College  is required and must have a value.",
     "Are you currently enrolled in a Canadian University or College"],
    // other known wordings + the angle-bracket form
    ["The field Email must have a value.", "Email"],
    ["The field <Country> is required.", "Country"],
  ];
  for (const [input, want] of cases) {
    assert.strictEqual(apMatchLib.parseErrorFieldName(input), want, JSON.stringify(input));
  }
});

// ── a value the FORM REJECTED is not a filled field (Copart live 2026-08-03) ──
// "N/A" went into a required compensation box, the write verified, the M40 audit matched — and Save
// & Continue answered "is required" with the box empty. Every check we own runs before validation, so
// the bundle kept claiming "N/A": review would show an answer the form does not hold, the human would
// approve it, and the replay would re-enter the same rejected text forever.
const REJ_ERR = ['Error-What is your desired compensation?The field What is your desired compensation? is required and must have a value.'];
const rejEntries = () => ([
  { question_label: "What is your desired compensation?", current_value: "N/A", fill_status: "filled", is_approved: true, needs_review: false },
  { question_label: "First Name", current_value: "Kevin", fill_status: "filled", is_approved: true, needs_review: false },
]);

test("rejectedValueEntries: an error-named field the page cleared becomes EMPTY + needs_review", () => {
  const live = [{ label: "What is your desired compensation?", value: "" }, { label: "First Name", value: "Kevin" }];
  const r = apMatchLib.rejectedValueEntries(rejEntries(), live, REJ_ERR);
  assert.deepStrictEqual(r.changed, [{ label: "What is your desired compensation?", was: "N/A" }]);
  const e = r.entries[0];
  assert.strictEqual(e.current_value, "", "the bundle must not claim a value the page threw away");
  assert.strictEqual(e.fill_status, "not_filled");
  assert.strictEqual(e.needs_review, true);
  assert.strictEqual(e.is_approved, false, "an approval of the rejected value cannot carry over");
  assert.match(e.detail, /REJECTED/);
  assert.strictEqual(r.entries[1].current_value, "Kevin", "an unrelated field is untouched");
  assert.strictEqual(r.entries[1].is_approved, true);
});

test("rejectedValueEntries: it never blanks a field on weaker evidence", () => {
  const live = [{ label: "What is your desired compensation?", value: "" }];
  // the page STILL holds the value → the error is about something else about it, keep the answer
  assert.strictEqual(apMatchLib.rejectedValueEntries(rejEntries(),
    [{ label: "What is your desired compensation?", value: "N/A" }], REJ_ERR).changed.length, 0);
  // the error names a DIFFERENT field
  assert.strictEqual(apMatchLib.rejectedValueEntries(rejEntries(), live,
    ["The field Postal Code is required and must have a value."]).changed.length, 0);
  // no live scan (failed read) ⇒ absence of evidence, not evidence of absence
  assert.strictEqual(apMatchLib.rejectedValueEntries(rejEntries(), [], REJ_ERR).changed.length, 0);
  // no parseable field name in the error
  assert.strictEqual(apMatchLib.rejectedValueEntries(rejEntries(), live, ["Something went wrong."]).changed.length, 0);
});

test("rejectedValueEntries: a blanked required field then BLOCKS submit", () => {
  const live = [{ label: "What is your desired compensation?", value: "" }];
  const ents = rejEntries().map((e, i) => (i === 0 ? Object.assign({}, e, { is_required: true, widget_type: "text" }) : e));
  const r = apMatchLib.rejectedValueEntries(ents, live, REJ_ERR);
  const blockers = bundleSubmitBlockers({ schema_version: REVIEW_SCHEMA_VERSION, entries: r.entries });
  assert.ok(blockers.some((b) => /REQUIRED field\(s\) have no value/.test(b)), JSON.stringify(blockers));
});

// ── ABSENT autofill_rules is UNCONFIGURED, not opted out (2026-08-03) ──
// The website's profile model carries no autofill_rules (nor application_questions / writing_style),
// so every profile synced from it read as "generation off": required free-text questions all got the
// "N/A" placeholder while the log blamed an operator setting nobody made. Live on Copart the form then
// REJECTED the N/A and the walk halted. An EXPLICIT [] still means off — that stays pinned above.
test("AI-2: a profile with NO autofill_rules (a website-synced one) still generates", async () => {
  const WEBSITE_PROFILE = { first_name: "Kevin", application_questions: { open_ended: {} } }; // no autofill_rules key at all
  const act = makeFakeAct([aiText({ isRequired: true })], { aiEnabled: true, ai: '{"answer":"Open to a competitive market rate."}' });
  const rec = (await drivePageFill(act, WEBSITE_PROFILE, {}, {}, T_BUDGETS)).results[0];
  assert.ok(act.log.some(([m]) => m === "llm"), "an unconfigured allowlist must not silently disable generation");
  assert.strictEqual(rec.status, "filled_review", "a generated answer is never silently trusted");
  assert.strictEqual(rec.after, "Open to a competitive market rate.");
  assert.notStrictEqual(rec.flag, "ai-text-needs-answer", "it answered, so it is not the needs-answer placeholder");
});
const REJ_ERR2 = ["Error-What is your desired compensation The field What is your desired compensation  is required and must have a value."];

test("rejectedValueEntries: the live label carries Workday's INLINE ERROR — match on the prefix", () => {
  // The real shape after a blocked save: Workday renders its message inside the field wrapper, so the
  // scan's label no longer equals the title parsed out of that very error. Live this made the whole
  // reconciler a silent no-op. Keyed by field_id -> fieldName, or a UNIQUE label prefix.
  const ents = [
    { field_id: "p3::formField-ded8cb", question_label: "What is your desired compensation *", current_value: "N/A", fill_status: "filled", is_approved: true },
    { field_id: "p3::formField-fn", question_label: "First Name", current_value: "Kevin", is_approved: true },
  ];
  const live = [
    { fieldName: "ded8cb", label: "What is your desired compensation *Error: The field What is your desired compensation  is required and must have a value.", value: "" },
    { fieldName: "fn", label: "First Name", value: "Kevin" },
  ];
  const r = apMatchLib.rejectedValueEntries(ents, live, REJ_ERR2);
  assert.deepStrictEqual(r.changed.map((c) => c.was), ["N/A"], JSON.stringify(r.notes));
  assert.strictEqual(r.entries[0].current_value, "");
  assert.strictEqual(r.entries[1].current_value, "Kevin");
});

test("rejectedValueEntries: an ambiguous prefix REFUSES, and every no-op says why", () => {
  const ents = [{ field_id: "p3::formField-a", question_label: "What is your desired compensation *", current_value: "N/A", is_approved: true }];
  const amb = [
    { fieldName: "a", label: "What is your desired compensation (base)*Error: x", value: "" },
    { fieldName: "b", label: "What is your desired compensation (bonus)*Error: y", value: "" },
  ];
  const r = apMatchLib.rejectedValueEntries(ents, amb, REJ_ERR2);
  assert.strictEqual(r.changed.length, 0, "two candidates -> blanking either could destroy an answer");
  assert.match(r.notes.join(" "), /ambiguous/);
  // and a no-op is never silent
  assert.ok(apMatchLib.rejectedValueEntries(ents, [{ fieldName: "z", label: "Other", value: "" }], REJ_ERR2).notes.length);
});

// ── a REQUIRED pick-one checkbox GROUP is answerable (PSECU live 2026-08-03) ──
// A required "select the ethnicity ... which most accurately describe(s) how you identify yourself"
// renders as a checkbox GROUP. It was unmapped, aiEligible excludes checkboxes, and the required-radio
// pass keys on widgetType "radio" — so nothing could fill it and Save & Continue could never pass.
const ETH_OPTS = ["American Indian or Alaska Native", "Asian", "Black or African American", "White", "Two or more races"];
const ethField = (over = {}) => Object.assign({
  wrapperSel: "[w-eth]", fieldName: "ethnicityMulti", widgetType: "checkbox_group", isRequired: true,
  label: "Please select the ethnicity (or ethnicities) which most accurately describe(s) how you identify yourself.",
  options: ETH_OPTS.map((t, i) => ({ id: "e" + i, labelText: t, checked: false })),
  groupOptions: ETH_OPTS.map((t, i) => ({ id: "e" + i, labelText: t, checked: false })),
}, over);

test("checkbox group: a REQUIRED unmapped one gets an AI answer + the loud DEMOGRAPHIC badge", async () => {
  const act = makeFakeAct([ethField()], { aiEnabled: true, ai: '{"choice":"Asian","justification":"profile states Asian","confidence":"High"}' });
  const rec = (await drivePageFill(act, { self_identification: {} }, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(rec.status, "filled_review", "an AI guess is never silently trusted");
  assert.strictEqual(rec.after, "Asian");
  assert.strictEqual(rec.flag, "ai-eeo-guess", "a demographic gets the loud badge, not a plain ai-choice");
  assert.ok(act.log.some(([m]) => m === "llm"), "the AI was consulted");
});

test("checkbox group: the AI's pick must clear the match ladder, and a bare checkbox is still never AI-filled", async () => {
  // a paraphrase that is not an option must NOT be committed
  const bad = makeFakeAct([ethField()], { aiEnabled: true, ai: '{"choice":"Prefer not to disclose","confidence":"High"}' });
  const r1 = (await drivePageFill(bad, {}, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(r1.status, "needs_review");
  assert.strictEqual(r1.flag, "ai-nomatch");
  // OPTIONAL stays blank — a blank optional does not block the page, so there is nothing to guess for
  const opt = makeFakeAct([ethField({ isRequired: false })], { aiEnabled: true, ai: '{"choice":"Asian"}' });
  const r2 = (await drivePageFill(opt, {}, {}, {}, T_BUDGETS)).results[0];
  assert.ok(!opt.log.some(([m]) => m === "llm"), "optional → no AI call, no spend");
  assert.strictEqual(r2.after, null);
  // AI OFF → never fires
  const off = makeFakeAct([ethField()], { aiEnabled: false, ai: '{"choice":"Asian"}' });
  const r3 = (await drivePageFill(off, {}, {}, {}, T_BUDGETS)).results[0];
  assert.ok(!off.log.some(([m]) => m === "llm"));
  assert.strictEqual(r3.after, null);
  // a bare CHECKBOX is an ASSERTION, not a choice — still excluded
  assert.strictEqual(aiEligible({ widgetType: "checkbox", isRequired: true }), false);
});

// ── a requisition id is not always R<digits> (PSECU/Copart live 2026-08-03) ──
// canonicalJobUrl only matched _R<digits>, so "HR-Intern_JR100897" fell through to origin+pathname —
// and that is NOT stable, because Workday redirects the posting URL you paste to its own spelling
// ("Harrisburg-PA" -> "Harrisburg%2C-PA"). One job made TWO tracker rows, and the submit run REFUSED
// its own approved bundle: the fill stored the key under the redirected path, the submit computed it
// from the pasted one.
test("canonicalJobUrl: a JR-style requisition keys stably across Workday's own redirect", () => {
  const k = "wd12:jr100897";
  for (const u of [
    "https://psecu.wd12.myworkdayjobs.com/en-US/PSECU/job/Harrisburg-PA/HR-Intern_JR100897",
    "https://psecu.wd12.myworkdayjobs.com/en-US/PSECU/job/Harrisburg%2C-PA/HR-Intern_JR100897/apply",
    "https://psecu.wd12.myworkdayjobs.com/en-US/PSECU/job/Harrisburg%2C-PA/HR-Intern_JR100897/apply/applyManually",
  ]) assert.strictEqual(canonicalJobUrl(u), k, u);
  assert.strictEqual(canonicalJobUrl("https://copart.wd12.myworkdayjobs.com/en-US/copart/job/Dallas-TX---Headquarters/Software-Engineering-Intern_JR109393"), "wd12:jr109393");
});

test("canonicalJobUrl: existing key shapes are byte-identical", () => {
  // the _R tier still matches FIRST, so nothing already stored changes meaning
  assert.strictEqual(canonicalJobUrl("https://wd3.myworkdaysite.com/en-US/recruiting/magna/Magna/job/Brampton%2C-Ontario%2C-CA/Design-Project-Coordinator_R00254745/apply/applyManually"), "wd3:r00254745");
  assert.strictEqual(canonicalJobUrl("https://waystar.wd1.myworkdayjobs.com/en-US/Waystar/job/Atlanta-GA/Application-Engineer-Co-Op_R3313-1"), "wd1:r3313");
  assert.strictEqual(canonicalJobUrl("https://job-boards.greenhouse.io/embed/job_app?for=acme&token=12345"), "https://job-boards.greenhouse.io/embed/job_app?token=12345");
  assert.strictEqual(canonicalJobUrl("https://jobs.lever.co/acme/abc-123/apply"), "https://jobs.lever.co/acme/abc-123");
});

// ── a checkbox GROUP holds a SET (PSECU traced live 2026-08-03) ──────────────
// Verified by hand on the live form: with "Asian" checked, clicking "White" left BOTH on, and both
// survived Save & Continue. "I do not wish to answer" is not exclusive either. Caterpillar's OFCCP
// disability group is the other shape (pick-one), so neither can be assumed.
const ETH = ["American Indian or Alaska Native", "Asian", "Black or African American", "I do not wish to answer.", "White"];
const ethBoxes = (checked = []) => ETH.map((t, i) => ({ id: "e" + i, labelText: t, checked: checked.includes(t) }));
const ethMulti = (checked = [], over = {}) => Object.assign({
  wrapperSel: "[w-eth]", fieldName: "ethnicityMulti", widgetType: "checkbox_group", isRequired: true,
  label: "Please select the ethnicity (or ethnicities) which most accurately describe(s) how you identify yourself.",
  options: ethBoxes(checked), groupOptions: ethBoxes(checked),
}, over);

test("checkbox group SET: value model round-trips through join/split/selection", () => {
  assert.deepStrictEqual(apMatchLib.groupSelection({ selected_options: ["Asian", "White"] }), ["Asian", "White"]);
  assert.strictEqual(apMatchLib.joinGroupValue(["Asian", "White"]), "Asian; White");
  assert.deepStrictEqual(apMatchLib.splitGroupValue("Asian; White"), ["Asian", "White"]);
  // an OLDER bundle has no array — its single current_value IS the set, which is what it meant
  assert.deepStrictEqual(apMatchLib.groupSelection({ current_value: "Asian" }), ["Asian"]);
  assert.deepStrictEqual(apMatchLib.groupSelection({ current_value: "" }), []);
});

test("checkbox group SET: the replay checks TWO options when the human approved two", async () => {
  const act = makeFakeAct([ethMulti()]);
  const loc = { wrapperSel: "[w-eth]" };
  const r = await setCheckboxGroupCdp(act, loc, ["Asian", "White"], T_BUDGETS);
  assert.strictEqual(r.status, "filled", r.detail);
  assert.deepStrictEqual(r.selected_options.slice().sort(), ["Asian", "White"]);
  assert.strictEqual(r.after, "Asian; White");
});

test("checkbox group SET: REMOVE one and CHECK another in a single reconcile", async () => {
  // The operator's exact case. Starting state has Asian checked; the approved set is White only.
  const act = makeFakeAct([ethMulti(["Asian"])]);
  const r = await setCheckboxGroupCdp(act, { wrapperSel: "[w-eth]" }, ["White"], T_BUDGETS);
  assert.strictEqual(r.status, "filled", r.detail);
  assert.deepStrictEqual(r.selected_options, ["White"], "Asian was removed, White added");
});

test("checkbox group SET: swapping one of TWO keeps the other", async () => {
  const act = makeFakeAct([ethMulti(["Asian", "White"])]);
  const r = await setCheckboxGroupCdp(act, { wrapperSel: "[w-eth]" }, ["Asian", "Black or African American"], T_BUDGETS);
  assert.strictEqual(r.status, "filled", r.detail);
  assert.deepStrictEqual(r.selected_options.slice().sort(), ["Asian", "Black or African American"]);
});

test("checkbox group SET: already-correct is a no-op, not a re-click", async () => {
  const act = makeFakeAct([ethMulti(["Asian", "White"])]);
  const r = await setCheckboxGroupCdp(act, { wrapperSel: "[w-eth]" }, ["White", "Asian"], T_BUDGETS);
  assert.strictEqual(r.status, "filled");
  assert.match(r.detail, /already correct/);
  assert.ok(!act.log.some(([m]) => m === "clickRadioLabel"), "nothing was actuated");
});

test("checkbox group SET: a PICK-ONE page that refuses the second box is reported, never passed", async () => {
  // Caterpillar's shape. The fake refuses to hold two at once, exactly as that tenant does.
  const f = ethMulti();
  f.pickOne = true;
  const act = makeFakeAct([f]);
  const r = await setCheckboxGroupCdp(act, { wrapperSel: "[w-eth]" }, ["Asian", "White"], T_BUDGETS);
  assert.strictEqual(r.status, "needs_review", "a partly-applied selection must never read as success");
  assert.strictEqual(r.flag, "checkbox-group-partial");
  assert.match(r.detail, /did not accept/);
});

test("checkbox group SET: an approved option that is not on this form is named, not silently dropped", async () => {
  const act = makeFakeAct([ethMulti()]);
  const r = await setCheckboxGroupCdp(act, { wrapperSel: "[w-eth]" }, ["Asian", "Klingon"], T_BUDGETS);
  assert.strictEqual(r.status, "needs_review");
  assert.match(r.detail, /not on this form: Klingon/);
  assert.deepStrictEqual(r.selected_options, ["Asian"], "what DID apply is still reported");
});

test("checkbox group SET: the review-page reconcile checks EACH option, not the joined string", () => {
  const entry = { field_id: "p4::formField-ethnicityMulti", question_label: "Ethnicity", widget_type: "checkbox_group",
    current_value: "Asian; White", selected_options: ["Asian", "White"], is_required: true };
  // Workday prints them as separate rows — the joined string appears nowhere on the page.
  const page = [{ section: "Self Identify", label: "Ethnicity", value: "Asian" }, { section: "Self Identify", label: "Ethnicity", value: "White" }];
  const ok = reconcileReviewPage(page, [entry]);
  assert.strictEqual(ok.missing_on_review.length, 0, JSON.stringify(ok.missing_on_review));
  assert.strictEqual(ok.agree.length, 1);
  // one of the two genuinely absent => MISSING, naming which
  const half = reconcileReviewPage([{ section: "Self Identify", label: "Ethnicity", value: "Asian" }], [entry]);
  assert.strictEqual(half.missing_on_review.length, 1);
  assert.match(half.missing_on_review[0].detail, /White/);
});

test("checkbox group SET: a LEGACY bundle (joined string, no array) still replays both options", async () => {
  // Bundles written before selected_options existed hold only the joined current_value, so it has to be
  // split back apart. Both copies of groupSelection must agree about that — lib.js did not split at
  // first and the legacy replay silently applied nothing.
  assert.deepStrictEqual(apMatchLib.groupSelection({ current_value: "Asian; White" }), ["Asian", "White"]);
  const act = makeFakeAct([ethMulti([], { wrapperSel: '[data-automation-id="formField-eth"]' })]);
  const r = await replayField(act, { field_id: "p4::formField-eth", widget_type: "checkbox_group",
    current_value: "Asian; White", question_label: "Ethnicity" }, T_BUDGETS);
  assert.strictEqual(r.status, "filled", r.detail);
  assert.deepStrictEqual(r.selected_options.slice().sort(), ["Asian", "White"]);
});

test("AI-2 placeholder: a field that REFUSES \"N/A\" is never reported as answered", async () => {
  // Copart's required "desired compensation" box only accepts a number, so the characters never land.
  // The decline path used to hardcode filled_review and claim it entered N/A regardless — leaving the
  // bundle asserting a value over an empty field, which a human then approves and the replay re-sends.
  const f = aiText({ isRequired: true, textRejects: true });
  const act = makeFakeAct([f], { aiEnabled: true, ai: JSON.stringify({ skip: true, reason: "no salary in profile" }) });
  const rec = (await drivePageFill(act, GEN_ON, {}, {}, T_BUDGETS)).results[0];
  // The box takes DIGITS, so "N/A" is refused and the fill falls back to a PLACEHOLDER 0 purely so the
  // page can advance and review can see the rest of the application (operator 2026-08-03: "nothing
  // should halt, it should always get to the review page").
  assert.strictEqual(rec.status, "filled_review");
  assert.strictEqual(String(rec.after).trim(), "0");
  assert.strictEqual(rec.flag, "ai-text-needs-answer");
  assert.match(rec.detail, /PLACEHOLDER 0/);
  // …and it can never be SUBMITTED while it is still the placeholder — that is what makes writing a
  // number nobody chose acceptable.
  const { unreplacedPlaceholders } = require("../lib.js");
  assert.strictEqual(unreplacedPlaceholders([{ flag: rec.flag, current_value: rec.after }]).length, 1,
    "an untouched 0 must hard-block submit");
});

test("AI-2 placeholder: a field refusing BOTH N/A and 0 is reported, not faked", async () => {
  // A box that accepts neither is a genuine dead end — say so rather than invent something it takes.
  const f = aiText({ isRequired: true, textRejectsAll: true });
  const act = makeFakeAct([f], { aiEnabled: true, ai: JSON.stringify({ skip: true, reason: "x" }) });
  const rec = (await drivePageFill(act, GEN_ON, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(rec.status, "needs_review");
  assert.match(rec.detail, /REFUSED both/);
});

test("text fill: a digits-only field accepts a human's \"80,000\" as 80000", async () => {
  // Operator's case: a reviewer types a formatted figure, the field drops every non-digit, and the
  // whole write vanishes — on a replay that halts a run over an answer they DID give.
  const f = aiText({ isRequired: true, textRejects: true });
  const act = makeFakeAct([f]);
  const r = await fillTextCdp(act, { wrapperSel: f.wrapperSel }, "80,000", T_BUDGETS, "input");
  assert.strictEqual(r.status, "filled", r.detail);
  assert.strictEqual(r.after, "80000", "the record must report what LANDED, or the review-page check disagrees");
  assert.strictEqual(r.numericCoerced, true);
  assert.match(r.detail, /digits only/);
});

test("text fill: coercion never mangles a non-numeric answer, and never fires on a normal field", async () => {
  // prose into a digits-only field has no numeric form — it must fail honestly, not become a number
  const prose = makeFakeAct([aiText({ isRequired: true, textRejects: true })]);
  const p = await fillTextCdp(prose, { wrapperSel: "[w-essay]" }, "Negotiable", T_BUDGETS, "input");
  assert.strictEqual(p.status, "needs_review");
  // an ordinary field takes the value verbatim — no coercion, commas intact
  const ok = makeFakeAct([aiText({ isRequired: true })]);
  const g = await fillTextCdp(ok, { wrapperSel: "[w-essay]" }, "80,000", T_BUDGETS, "input");
  assert.strictEqual(g.status, "filled");
  assert.strictEqual(g.after, "80,000");
  assert.notStrictEqual(g.numericCoerced, true);
});

test("AI-2 placeholder: a field that ACCEPTS N/A still reports it, flagged", async () => {
  const act = makeFakeAct([aiText({ isRequired: true })], { aiEnabled: true, ai: JSON.stringify({ skip: true, reason: "x" }) });
  const rec = (await drivePageFill(act, GEN_ON, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(rec.status, "filled_review");
  assert.strictEqual(String(rec.after).trim(), "N/A");
  assert.strictEqual(rec.flag, "ai-text-needs-answer");
});

// ── a required COMPENSATION box gets a market-rate ESTIMATE (operator 2026-08-03) ──
// The profile states no figure, so the essay prompt correctly refuses to invent one — and the page
// then strands (live: Copart, clearesult; the "0" placeholder did not survive validation either).
// "Make the AI guess a salary expectation that is the salary that job will probably pay."
test("compensation: a required salary box gets an AI estimate, flagged for review", async () => {
  const f = aiText({ isRequired: true, label: "What is your salary expectation*", textRejects: true });
  const act = makeFakeAct([f], { aiEnabled: true, ai: "78000" });
  const rec = (await drivePageFill(act, GEN_ON, {}, { company: "Acme", title: "Energy Engineer III" }, T_BUDGETS)).results[0];
  assert.strictEqual(rec.status, "filled_review", "an estimate is never silently trusted");
  assert.strictEqual(rec.after, "78000");
  assert.strictEqual(rec.flag, "ai-estimate");
  assert.match(rec.detail, /ESTIMATED the market rate/);
});

test("compensation: only a digits figure reaches the form, and prose falls through", async () => {
  // the model wraps the number in words — take the number, never the sentence
  const chatty = makeFakeAct([aiText({ isRequired: true, label: "Desired salary*", textRejects: true })],
    { aiEnabled: true, ai: "Around $82,500 per year" });
  const r1 = (await drivePageFill(chatty, GEN_ON, {}, {}, T_BUDGETS)).results[0];
  assert.strictEqual(r1.after, "82500", "digits only — a currency symbol or comma is refused by these boxes");
  // UNKNOWN → no figure invented; falls through to the honest placeholder path
  const dunno = makeFakeAct([aiText({ isRequired: true, label: "Desired salary*", textRejects: true })],
    { aiEnabled: true, ai: "UNKNOWN" });
  const r2 = (await drivePageFill(dunno, GEN_ON, {}, {}, T_BUDGETS)).results[0];
  assert.notStrictEqual(r2.flag, "ai-estimate");
});

test("compensation: the recognizer needs BOTH a money word and an asking word", () => {
  const yes = ["What is your desired compensation?", "What is your salary expectation", "Desired salary",
    "What pay rate are you seeking?", "Minimum salary required"];
  const no = ["Please provide your salary history", "Salary and benefits are competitive",
    "What is your desired start date?", "Why do you want to work here?"];
  for (const t of yes) assert.ok(apMatchLib.isCompensationQuestion(t), t);
  for (const t of no) assert.ok(!apMatchLib.isCompensationQuestion(t), t);
});

// ── a digits-only field that FILTERS keystrokes has already given the right answer ──
// Operator 2026-08-03: "the 80,000 is fine since if it only takes numbers then the , will be omitted
// and it is still correct." Right — and the coercion I first added guarded the wrong case. Such a
// field can fail two ways: it FILTERS (box ends up "80000" — correct) or it REJECTS (box ends up
// empty). Only the second was handled, so the first returned needs_review over a CORRECT field, which
// on a replay is a halt on a value that landed.
test("text fill: a field that strips the comma to 80000 is ACCEPTED, not a mismatch", async () => {
  const f = aiText({ isRequired: true, mangle: (t) => t.replace(/[^0-9]/g, "") }); // filters as you type
  const act = makeFakeAct([f]);
  const r = await fillTextCdp(act, { wrapperSel: f.wrapperSel }, "80,000", T_BUDGETS, "input");
  assert.strictEqual(r.status, "filled", r.detail);
  assert.strictEqual(r.after, "80000", "reports what LANDED — a bundle holding 80,000 would DISAGREE on the review page");
  assert.strictEqual(r.numericCoerced, true);
});

test("text fill: acceptance is digits-EQUALITY, so a real mismatch still fails", async () => {
  // the field mangles the value into a DIFFERENT number — that is not normalization, it is wrong
  const wrong = makeFakeAct([aiText({ isRequired: true, mangle: () => "8000" })]);
  const r = await fillTextCdp(wrong, { wrapperSel: "[w-essay]" }, "80,000", T_BUDGETS, "input");
  assert.strictEqual(r.status, "needs_review", "80000 != 8000 — never paper over a real mismatch");
});

// ── a self-ID signature date is TODAY, never a guess (Asuep live 2026-08-04) ──
// The voluntary self-identification page carries a bare "Date" beside the attestation. aiFillDate was
// guessing it and wrote 8/10/2026 — a FUTURE date on a form the applicant is attesting to today.
// Operator: "for these disability questions it should always enter today's date."
// NOTE: the today-COMMIT itself is verified on a live page, not here. The fake's date composite does
// not type through focusDateSegment for a flat self-ID date (typed log came back empty), so a unit test
// of the commit would be testing the fixture rather than the code. The pure decision — WHICH dates get
// today — is pinned below, and the commit is covered by the Asuep run in dom-patterns 2026-08-04.
test("signature date: a date naming a DIFFERENT event is never stamped with today", () => {
  for (const t of ["Date", "Date*", "Today's Date", "Date Signed", "Signature Date", "Date of Signature"])
    assert.ok(apMatchLib.isSignatureDateQuestion(t), t);
  // these are real questions with real answers — quietly writing today would be a WRONG answer
  for (const t of ["What is your desired start date?", "Date of Birth", "Graduation Date", "Expiration Date",
    "From", "To", "Hire Date", "Last date of employment", "Date available to begin employment"])
    assert.ok(!apMatchLib.isSignatureDateQuestion(t), t);
});

// ── a date the FORM re-formatted is the same date (Home Depot live 2026-08-04) ──
// Approved "5/1/2028"; Workday's review page displays "05/01/2028". Identical calendar date, zero-
// padded by the form — and the submit gate blocked on it as a DISAGREE. Same shape as 80,000/80000:
// the form normalized our value and the comparison has to accept that.
test("sameCalendarDate: accepts re-formatting, never a different day", () => {
  for (const [a, b] of [["5/1/2028", "05/01/2028"], ["2028-05-01", "5/1/2028"], ["5/2028", "05/2028"]])
    assert.ok(apMatchLib.sameCalendarDate(a, b), `${a} == ${b}`);
  for (const [a, b] of [["5/1/2028", "5/2/2028"], ["5/1/2028", "6/1/2028"], ["5/1/2028", "5/1/2029"],
    // month-precision vs day-precision is NOT a confirmation of our answer
    ["5/1/2028", "5/2028"], ["Yes", "No"], ["13/1/2028", "13/01/2028"]])
    assert.ok(!apMatchLib.sameCalendarDate(a, b), `${a} != ${b}`);
});

test("review reconcile: a zero-padded date AGREES instead of blocking submit", () => {
  const entry = { field_id: "p2::formField-gradDate", question_label: "What is your anticipated graduation month and year (MM/YYYY)",
    widget_type: "date", current_value: "5/1/2028", is_required: true };
  const page = [{ section: "Education", label: "What is your anticipated graduation month and year (MM/YYYY)", value: "05/01/2028" }];
  const r = reconcileReviewPage(page, [entry]);
  assert.strictEqual(r.disagree.length, 0, "zero-padding is not a contradiction: " + JSON.stringify(r.disagree));
  assert.strictEqual(r.agree.length, 1);
  // a genuinely different day still DISAGREES — the gate must keep its teeth
  const wrong = reconcileReviewPage([{ section: "Education", label: entry.question_label, value: "05/02/2028" }], [entry]);
  assert.strictEqual(wrong.agree.length, 0, "a different day is a real disagreement");
});

// ── the KEYED review-page path must accept a re-formatted date too ──
// My first pass added the date tier only to valueTier (the label-anchored path), so the test passed
// while the live run still blocked: real page items carry a `key` and go through verdictFor/valuesAgree.
// Testing the path the code actually takes is the whole point.
test("review reconcile: a zero-padded date AGREES on the KEYED path, not just the label path", () => {
  const entry = { field_id: "p2::formField-gradDate", question_label: "What is your anticipated graduation month and year (MM/YYYY)",
    widget_type: "date", current_value: "5/1/2028", is_required: true };
  // The FLAT keyed lookup requires entryOrdinal == null and key === the field_id's form-field name.
  // My first fixture set entryOrdinal:0, so the lookup missed and it silently took the label-anchored
  // path — which is why the test passed with the fix reverted.
  const keyed = [{ section: "Education", label: entry.question_label, value: "05/01/2028",
    key: "gradDate", entryOrdinal: null }];
  const r = reconcileReviewPage(keyed, [entry]);
  assert.strictEqual(r.disagree.length, 0, "zero-padding must not block submit: " + JSON.stringify(r.disagree));
  // and a genuinely different day is still a contradiction on the same path
  const wrong = reconcileReviewPage([{ ...keyed[0], value: "05/02/2028" }], [entry]);
  assert.strictEqual(wrong.agree.length, 0, "a different day is a real disagreement");
});

// ── a PRE-FILLED typeahead skips higher tiers the form does not offer ──
// Operator 2026-08-04: with "Electrical Engineering" already committed it typed "Electrical and
// Computer Engineering" first, found nothing, then moved on — a search the complete scrape had already
// ruled out. The short-circuit's no-match branch was gated to normal fills only.
// Reaching that branch needs THREE things the first version of this test had none of: opts.onCapture
// (without it the whole pre-scrape block is skipped and capturedFull stays null), a capture that
// carries the non-enumerable `scrapeComplete` the real onCapture stamps on, and the log name the
// typeahead actually writes (`typeInHier` — not `typeInSourceSearch`/`typeText`, which no fake emits,
// so the old assertion read an always-empty array and passed with the fix reverted.)
const completeCapture = (act, loc) => async () => {
  const sc = await act.scrapeTaOptions(loc);
  if (!sc.ok) return null;
  const opts = sc.options.slice();
  // mirrors captureChoiceOptions: complete = reached the bottom AND not capped
  Object.defineProperty(opts, "scrapeComplete", { value: !!sc.atBottom && !sc.cappedOut, enumerable: false });
  return opts;
};

test("typeahead pre-filled: a provably-absent higher tier is never typed", async () => {
  const LOC = { wrapperSel: "[w-ta]" };
  const f = taField({
    fieldName: "fieldOfStudy",
    chips: ["Electrical Engineering"],                        // already committed → tier 1 of the list below
    scrapeOptions: ["Electrical Engineering", "Mechanical Engineering", "Computer Science"], // COMPLETE (atBottom)
  });
  const act = makeFakeAct([f], {});
  const r = await fillTypeaheadCdp(act, LOC,
    ["Electrical and Computer Engineering", "Electrical Engineering"], T_BUDGETS,
    { onCapture: completeCapture(act, LOC) });
  const typed = act.log.filter(([m]) => m === "typeInHier").map(([, v]) => String(v));
  assert.deepStrictEqual(typed, [],
    "the absent higher tier must not be typed — the complete scrape already ruled it out: " + JSON.stringify(typed));
  assert.match(String(r.after || ""), /^Electrical Engineering$/,
    "the prefill is kept, which is the same verdict the type/Enter walk would have reached");
});

// The guard on the above: absence must be proven, not assumed. An INCOMPLETE scrape of the same
// widget must still type the higher tier, because the server may filter to a value the partial
// list never showed.
test("typeahead pre-filled: an INCOMPLETE scrape still types the higher tier (absence unproven)", async () => {
  const LOC = { wrapperSel: "[w-ta]" };
  const f = taField({
    fieldName: "fieldOfStudy",
    chips: ["Electrical Engineering"],
    scrapeNotAtBottom: true,                                  // partial → cannot prove absence
    scrapeOptions: ["Electrical Engineering", "Mechanical Engineering"],
    filterMap: { "Electrical and Computer Engineering": { autoCommit: "Electrical and Computer Engineering" } },
  });
  const act = makeFakeAct([f], {});
  const r = await fillTypeaheadCdp(act, LOC,
    ["Electrical and Computer Engineering", "Electrical Engineering"], T_BUDGETS,
    { onCapture: completeCapture(act, LOC) });
  const typed = act.log.filter(([m]) => m === "typeInHier").map(([, v]) => String(v));
  assert.deepStrictEqual(typed, ["Electrical and Computer Engineering"],
    "a partial list cannot rule the tier out — it must still be typed");
  assert.strictEqual(r.after, "Electrical and Computer Engineering", "and the upgrade committed");
});
