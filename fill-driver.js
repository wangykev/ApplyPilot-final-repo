// ============================================================================
// fill-driver.js — the SUBSTRATE-AGNOSTIC page-fill brain for the CDP port
// (Step 2: simple widgets — text / dropdown / radio / checkbox — hidden tab).
//
// drivePageFill(act, profile, defaults, jobContext, budgets) walks one page's
// flat fields and fills the simple widgets through the `act` actuation
// interface. It NEVER touches chrome.* or the DOM directly and paces
// EVERYTHING through act.delay (SW wall-clock under CDP; instant in tests) —
// page-side timers are throttled to ~1Hz hidden and then frozen, so no timing
// may live page-side. This file is the substrate-swap hedge: the same brain
// runs against the CDP actuation (cdp.js makeCdpActuation) or a test fake.
//
// DECISION LOGIC = the M22 in-tree rules, ported VERBATIM from background.js
// fillEngine (FIELD_MAP / resolve / decidePreviousWorker / record + status
// semantics). Do not redesign here; when fillEngine's copies change, change
// these in lockstep. matchCandidates/normalize come from lib.js (the engine's
// inline copies carry the mirror TODO(dup) marker).
//
// OUT OF SCOPE this milestone (records are honest, actuation is ZERO):
//   typeahead → needs_review · source/hierarchical → needs_review ·
//   file_upload → skipped · repeating sections → excluded by the scan.
//
// Tri-context note: SW via importScripts (lib.js loaded first → globals) and
// Node tests via require — same UMD-lite pattern as db.js / lib.js.
// ============================================================================

// lib.js matching helpers, context-safe (apMatch.* avoids redeclaring the
// lib.js globals in the SW scope).
const apMatch = (typeof module !== "undefined" && module.exports)
  ? require("./lib.js")
  : { normalize: normalize, matchCandidates: matchCandidates, fuzzyRatio: fuzzyRatio, normalizeLabel: normalizeLabel,
      // M4 submit gate needs these lib pures too — they're globals in the SW (lib.js loads first).
      sessionLooksDead: sessionLooksDead, isWorkdayMaintenance: isWorkdayMaintenance, unreplacedPlaceholders: unreplacedPlaceholders };

// ── M27 flag taxonomy ───────────────────────────────────────────────────────
// The SINGLE source of the (status, confidence, flag) triple for a choice-widget
// COMMIT, keyed by (overwrite?, commitKind, matchTier). Encoded as one table so
// the three values can't drift apart — never assign them ad-hoc per branch.
//   • flag = PROVENANCE (what action happened); confidence = MATCH QUALITY. They
//     are ORTHOGONAL.
//   • matchTier strings are apMatch.matchCandidates outputs ("exact-normalized" /
//     "containment" / "fuzzy-NN" / null); flagTierCategory collapses them.
//   • commitKind ∈ {"auto","directed"} (Workday auto-committed on the filter-Enter
//     vs we directed the commit via Enter/click on a verified option).
//   • Inside an overwrite context the flag is ALWAYS overwrite-* — NO autocommit-*/
//     directed-* flag ever fires under overwrite (the precedence rule). The
//     overwrite=true rows are authored here but only REACHED in Commit B; Commit A
//     calls commitOutcome with overwrite=false exclusively.
// The record's `matchTier` field stays the COMMIT-PATH descriptor (pre-filled /
// enter-auto-commit / enter-commit / click-commit / source-click-commit) — the
// match quality lives in the NEW `confidence` field, provenance in the NEW `flag`.
function flagTierCategory(matchTier) {
  if (matchTier === "exact-normalized") return "exact";
  if (matchTier === "containment") return "containment";
  if (typeof matchTier === "string" && matchTier.indexOf("fuzzy") === 0) return "fuzzy";
  return "none";
}
// A scanned LIVE value counts as "filled": checkbox true, or any non-empty string that isn't the
// dropdown placeholder. (false / "" / null / "Select One" = empty.) Shared by the unknown-section
// already-filled surfacing (m3a) and the page-wide already-filled sweep.
const hasLiveValue = (v) => v === true || (v != null && v !== "" && v !== false && !/^select one$/i.test(String(v)));
function commitOutcome(overwrite, commitKind, matchTier) {
  const tier = flagTierCategory(matchTier);
  if (overwrite) {
    // A successful overwrite is ALWAYS overwrite-success regardless of tier;
    // confidence still tracks the tier (high iff exact, else low). A changed chip
    // that matches no candidate is an overwrite-stray (destructive — see CLAUDE/
    // dom-patterns; accepted).
    if (tier === "none") return { status: "needs_review", confidence: "none", flag: "overwrite-stray" };
    return { status: "filled_review", confidence: tier === "exact" ? "high" : "low", flag: "overwrite-success" };
  }
  if (commitKind === "auto") {
    if (tier === "exact") return { status: "filled", confidence: "high", flag: "autocommit-exact" };
    if (tier === "containment") return { status: "filled_review", confidence: "low", flag: "autocommit-containment" };
    if (tier === "fuzzy") return { status: "filled_review", confidence: "low", flag: "autocommit-fuzzy" };
    return { status: "needs_review", confidence: "none", flag: "autocommit-stray" };
  }
  // directed
  if (tier === "exact") return { status: "filled", confidence: "high", flag: "directed-exact" };
  if (tier === "containment") return { status: "filled_review", confidence: "low", flag: "directed-containment" };
  if (tier === "fuzzy") return { status: "filled_review", confidence: "low", flag: "directed-fuzzy" };
  return { status: "needs_review", confidence: "none", flag: null };
}

// ── M27 overwrite helpers (Commit B — shared by typeahead + source, lockstep) ─
// Non-destructive overwrite: we do NOT delete the pre-fill; we search over the
// populated field and let a commit REPLACE it (recon 2026-06-14 = REPLACE on both
// widgets). A no-match leaves the original intact.
//
// chipSetChanged: did the committed chip set change from the pre-existing one?
// NORMALIZED, order-independent. For an EMPTY field (priorChips=[]) any non-empty
// chip set is a change, so the overwrite logic reduces to the original "a chip
// appeared" — empty-field behavior is unchanged.
function chipSetChanged(priorChips, chips) {
  const norm = apMatch.normalize;
  const a = (priorChips || []).map(norm).sort();
  const b = (chips || []).map(norm).sort();
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return true;
  return false;
}

// pollSearchValue (M39.2): reactive PRE-Enter settle for the typeahead/source search
// box. POLL the searchBox VALUE (the input REFLECTION — `searchBox.value`) until it
// equals `want` (`""` after a clear / the full candidate after typing), ceiling = give-up
// ONLY. This is an ECHO wait, NOT a render wait: it confirms our typed/cleared text has
// LANDED in the input before we snapshot/press the filter-Enter — it does NOT touch the
// filter-render (the option list), which the UNCHANGED post-Enter transition-settle still
// gates. `typeInSearch` types char-by-char and awaits every keystroke dispatch, so the
// happy path matches on the FIRST read (no added latency); the poll only absorbs reflection
// lag on a slow connection. Read-only (never changes focus). On give-up returns false and
// the caller PROCEEDS to Enter anyway (today's fixed-delay behavior — the post-Enter settle
// is the real commit gate) → strictly-better-than-today, never a hang. `read` is a thunk
// (() => act.readHier(loc) | act.readSource(loc)).
async function pollSearchValue(act, read, want, budgets) {
  const deadline = Date.now() + budgets.taActionSettleCeilingMs;
  do {
    const st = await read();
    if (st && st.searchBox && st.searchBox.value === want) return true;
    await act.delay(budgets.taActionSettleIntervalMs);
  } while (Date.now() < deadline);
  return false;
}

// tabBlurExit: the ONLY clean non-committing exit from an open typeahead/source widget (recon
// 2026-06-26, supersedes the disarmHighlight model). THREE corrected DOM facts killed the old
// disarm code: (1) RE-FOCUSING the searchBox does NOT clear the armed row-0 highlight — the armed
// row only changes by typing a new non-empty query, so "disarm by refocus + poll" was a no-op that
// either burned the ceiling or exited on a transient null and LIED; (2) `""` + Enter is a no-op
// (clearing + Enter leaves the banner/list/armed row intact — clearing is valid ONLY as
// delete-old-text-before-the-next-query); (3) Enter commits the armed row, Escape hides the popup
// but KEEPS focus + the armed row (so the next field's focus blur-commits the stray — the live
// fieldOfStudy "Other"→"Accounting" bug), and only TAB blurs + abandons the armed row WITHOUT
// committing (operator-verified). So we Tab, then read the resting chips (the caller's stray-check
// flags any chip that differs from the original). Returns the chips array, [] (none), or null (read
// error → caller keeps priorChips, never a false stray).
async function tabBlurExit(act, loc, readFn) {
  await act.pressTab();
  try { const st = await readFn(loc); return st && st.chips ? st.chips : []; } catch (e) { return null; }
}

// awaitListTerminal: BLOCK until the typeahead/source result list reaches a CONFIRMED terminal render state —
// the ONLY safe moment to read/match/commit or move to the next candidate. A no-match is a throttle-LAGGED page
// REACTION: the page renders a non-zero alphabetical FALLBACK list (row-0 armed) and, slightly LATER, a
// promptTitle banner. Acting on the box during that bannerless window races the focus drop + commits the armed
// row (the FoS stray). So the only non-timeout terminals require a BANNER or an autocommit — a bannerless list
// (EVEN a stable non-zero one) is NOT terminal, and count===0+no-banner is NOT terminal. Returns:
//   "autocommit" — a NEW chip appeared, OR the box closed holding a chip (checked FIRST → exits immediately).
//   "nomatch"    — the "No matches found" banner present AND count stable across stableReads.
//   "results"    — the "Search Results" banner present AND count > 0 stable across stableReads.
//   "timeout"    — taSettleCeilingMs ceiling (caller treats like no-match; the focus-safe type loops gate focus).
// Count = pageWide.count (typeahead) | leafCount (source). The input ECHO (pollSearchValue) is NEVER consulted.
// TERMINATION (not poll-forever): the stability counter resets ONLY on a count CHANGE; the fallback/filtered
// list STOPS changing once rendered, so once a banner is present the count goes stable within ~stableReads
// intervals → it resolves. It does NOT loop indefinitely because the banner co-arrived with a still-ticking
// count: we require count stable across stableReads reads FROM the point both hold, and the fallback is itself
// stable. A banner co-arriving with an already-stable count returns immediately. `read` is a thunk; chipSetIsNew
// is the caller's overwrite-aware new-chip test.
async function awaitListTerminal(act, readFn, loc, budgets, chipSetIsNew) {
  const deadline = Date.now() + budgets.taSettleCeilingMs;
  let prevCount = null, stable = 0;
  do {
    const s = await readFn(loc);
    if (s && chipSetIsNew(s.chips)) return "autocommit";                                  // a NEW chip committed
    if (s && s.searchBox && !s.searchBox.visible && s.chips && s.chips.length) return "autocommit"; // box closed holding a chip
    const count = s && s.pageWide ? s.pageWide.count : (s && s.leafCount != null ? s.leafCount : null);
    if (count === prevCount && count != null) stable++; else { stable = 0; prevCount = count; }
    const stableEnough = stable >= budgets.stableReads - 1;
    if (stableEnough && s && s.banner) return "nomatch";                                  // "No matches found" + stable
    if (stableEnough && s && s.resultsBanner && count > 0) return "results";              // "Search Results" + stable non-zero
    // bannerless (neither banner), even a stable non-zero count → NOT terminal; count===0 + no banner → NOT terminal
    await act.delay(budgets.taSettleIntervalMs);
  } while (Date.now() < deadline);
  return "timeout";
}

// awaitListStable: the INITIAL-open gate (pre-filter, NO banner expected) — wait until the opened option list is
// rendered + stable before the READ-ONLY recon scrape, so it never scrapes a mid-render list. SHORTER ceiling
// (taOpenCeilingMs, NOT the big taSettleCeilingMs): a cold/empty catalog or slow open must not burn 25s before
// the read-only scrape; a timed-out-but-proceed is acceptable here (worst case the scrape reads a slightly-early
// list — it does NOT gate the fill, which matches via pageWide.texts). Returns "stable" | "timeout".
async function awaitListStable(act, readFn, loc, budgets) {
  const deadline = Date.now() + budgets.taOpenCeilingMs;
  let prevCount = null, stable = 0;
  do {
    const s = await readFn(loc);
    const count = s && s.pageWide ? s.pageWide.count : (s && s.leafCount != null ? s.leafCount : null);
    if (count === prevCount && count != null) stable++; else { stable = 0; prevCount = count; }
    if (count > 0 && stable >= budgets.stableReads - 1) return "stable";
    await act.delay(budgets.taOpenIntervalMs);
  } while (Date.now() < deadline);
  return "timeout";
}

// awaitSourceListStable: the SOURCE picker's INITIAL-open render gate — the source analog of awaitListStable.
// Source's open view is the CHEVRON CATEGORY rows, NOT a leaf list (its leafCount stays 0 until a query filters
// the tree to leaves), so awaitListStable's leaf/option count would always read 0 here. The "rendered" signal
// is therefore the popup CONTENT: categories (the on-open state, via readTreeCategories) OR leaves (a tenant
// that opens straight to a flat list). Wait until that content is present + stable across stableReads before
// the first type, so the type never races the popup render (the source analog of the typeahead open-race).
// SHORTER ceiling (taOpenCeilingMs); a timed-out gate PROCEEDS (never hang) — worst case == today (type after
// the bare focus). readTreeCategories is substrate-guarded (older fakes/recon-only acts may omit it). Returns
// "stable" | "timeout".
async function awaitSourceListStable(act, loc, budgets) {
  const deadline = Date.now() + budgets.taOpenCeilingMs;
  let prev = null, stable = 0;
  do {
    let leaves = 0, cats = 0;
    try { const s = await act.readSource(loc); leaves = (s && s.leafCount) || 0; } catch (e) { /* read race → treat as not-yet-rendered */ }
    try { cats = act.readTreeCategories ? ((await act.readTreeCategories(loc)) || []).length : 0; } catch (e) { /* substrate without categories */ }
    const count = leaves + cats;
    if (count === prev) stable++; else { stable = 0; prev = count; }
    if (count > 0 && stable >= budgets.stableReads - 1) return "stable";
    await act.delay(budgets.taOpenIntervalMs);
  } while (Date.now() < deadline);
  return "timeout";
}

// overwriteNoMatchResting: the walk-end resting state under overwrite. BOTH paths exit via TAB —
// the ONLY clean non-committing exit (refocus does NOT disarm; "" + Enter is a no-op — both
// removed). Tab abandons any armed row WITHOUT committing it; the original chip is intact (we
// never deleted it) and a committed chip SURVIVES the blur, so the post-Tab read is the truth.
//   • keptLowerTier (M36.1) — the pre-fill EXACT-matched a LOWER candidate tier and no higher
//     tier is offered → the pre-fill IS the best answer AND is ALREADY correctly committed →
//     Tab-close + chip VERIFY, no re-type/re-commit (operator speed rule 2026-07-02; the old
//     affirmative re-commit was the pre-Tab-model stray fix — the Tab exit abandons the armed
//     row, live-proven on this exact widget state, making the re-commit a wasted round-trip).
//     Chip still == original → filled/`prefilled-better-tier-unavailable`; vanished → honest
//     needs_review (never a false "kept").
//   • plain overwrite no-match (original NOT a candidate) — same Tab exit, flagged
//     overwrite-nomatch-original-kept (the AI-rescue candidate).
// A chip that STRAYED despite the Tab → overwrite-stray on the LIVE value (both paths).
async function overwriteNoMatchResting(act, loc, readFn, priorChips, trace, lastOptions, budgets, keptLowerTier) {
  const norm = apMatch.normalize;
  const original = priorChips.join("; ");
  const tabbed = await tabBlurExit(act, loc, readFn);
  const endChips = tabbed == null ? priorChips : tabbed; // read error → keep priorChips (no false stray)
  const after = endChips.length ? endChips.join("; ") : original;
  if (endChips.length && norm(endChips.join("; ")) !== norm(original)) {
    return {
      status: "needs_review", after, verified: false, flag: "overwrite-stray", confidence: "none",
      detail: `resting Tab-exit strayed to "${after}" (expected original "${original}") — review`,
      captured_options: lastOptions || undefined, settle_trace: trace, overwrite: { original, refilled: false }
    };
  }
  if (keptLowerTier) {
    if (endChips.length) {
      return {
        status: "filled", after: original, verified: true, matchTier: "pre-filled",
        flag: "prefilled-better-tier-unavailable", confidence: "high",
        detail: `kept pre-fill "${original}" (no higher-priority tier offered by the form) — Tab-closed, no re-commit`,
        captured_options: lastOptions || undefined, settle_trace: trace
      };
    }
    // chip GONE after the Tab (unobserved mode — committed chips survive blur) → honest review,
    // never a false "kept".
    return {
      status: "needs_review", after: null, verified: false, matchTier: "pre-filled",
      flag: "overwrite-stray", confidence: "none",
      detail: `kept pre-fill "${original}" no longer present after the Tab-close (field empty) — review`,
      captured_options: lastOptions || undefined, settle_trace: trace
    };
  }
  return {
    status: "needs_review", after, verified: false,
    flag: "overwrite-nomatch-original-kept", confidence: "none",
    detail: `no candidate matched — original pre-fill "${original}" kept, exited via Tab (future-AI candidate)`,
    captured_options: lastOptions || undefined, settle_trace: trace, overwrite: { original, refilled: false }
  };
}

// Wait budgets — recon-informed (2026-06-12, Magna wd3 hidden): dropdown cold
// open ~5.6s → 20s ceiling; commits 300-620ms → 10s ceilings; text read-back
// ≤700ms → 500ms read delay. GENEROUS by design: the page's reaction runs on a
// ~1s-throttled loop; a foreground-tuned timeout false-negatives to needs_review.
// Tests override with tiny values.
const DEFAULT_BUDGETS = {
  openCeilingMs: 20000,   // dropdown click → options rendered (cold lazy lists)
  settleIntervalMs: 350,  // option-list poll interval
  stableReads: 2,         // consecutive equal non-zero reads (atomic render confirmed)
  // Open-retry (foreground fast-fill): a fast-paced open-click can fire during the
  // PRIOR field's post-commit React re-render and no-op (the trigger never expands).
  // openExpandWindowMs is the CHEAP aria-expanded gate (give up + re-open if the
  // trigger doesn't expand within it — does NOT burn the option ceiling); openRetries
  // bounds the re-opens; reopenSettleMs lets the re-render finish before re-opening.
  openRetries: 3,
  openExpandWindowMs: 2000,
  reopenSettleMs: 400,
  taOpenRetries: 3,       // same race on the typeahead searchBox open/focus
  commitCeilingMs: 10000, // click/Enter → observable state change
  commitIntervalMs: 300,
  textReadDelayMs: 500,   // insertText → read-back (legacy; reactive poll below)
  // Reactive read-back (text + date): POLL readback until it equals the COMPLETE target,
  // ceiling = give-up only (survives laggy wifi — the page registers the value when it does).
  textReadCeilingMs: 6000,
  textReadIntervalMs: 60,
  textFillAttempts: 2,    // self-heal: re-fill text/date once on a read-back mismatch (a WRONG value, not a slow one)
  typeJumpDelayMs: 700,   // type-to-jump chars → highlight settles
  arrowStepMs: 110,       // per arrow step (verified walk)
  maxArrowSteps: 60,      // walk bound — type-jump should land near; farther = something's off → needs_review
  interFieldMs: 300,
  // Typeahead (M25 recon, Magna wd3 hidden: filter settles ~810–860ms; the
  // ceiling tolerates colder tenants without false-negativing to needs_review).
  taOpenCeilingMs: 5000,   // opener click → searchBox visible+focused (~260ms observed)
  taOpenIntervalMs: 250,
  taActionSettleMs: 400,   // after clear / after typing, before Enter (legacy; reactive pollSearchValue below)
  // Reactive PRE-Enter settle (M39.2): poll the searchBox VALUE (input echo) until it reflects
  // the clear/typed candidate. Ceiling generous — a ~40-char candidate types ~1.6s char-by-char.
  taActionSettleCeilingMs: 6000,
  taActionSettleIntervalMs: 60,
  taSettleCeilingMs: 25000, // filter-Enter → fresh transition (banner/chip/filtered)
  taSettleIntervalMs: 400,
  taEmptyNoMatchMs: 8000,   // a filtered list that stays EMPTY (0 options, no banner) this long = no-match (CPP: avoids the 25s burn; above the ~5.6s cold-list latency). FAST path (sawChange+stable) usually fires sooner.
  taEnterCommitCeilingMs: 5000, // commit-Enter → chip, before the click fallback takes over
  // M32 repeating-section reconcile poll (Add/Delete → entry count moves). In-tree
  // budget is 4s/150ms; the page mounts the new/removed entry on its throttled loop.
  entryReconcileCeilingMs: 4000,
  entryReconcileIntervalMs: 150,
  // M40 post-fill audit: one settle (NON-adaptive — the page's render is real wall-clock)
  // before the independent re-read pass, so a still-settling last field isn't false-flagged.
  auditSettleMs: 600,
  // Cascade re-scan (M1): bound on the re-scan→fill→re-scan loop. Each round is ONE
  // read-only act.scanPage() + a fill of only the NEW fields, so the loop adds NO fixed
  // wait — it relies on the reveal latency (~5.6s, Magna recon) being ABSORBED by the
  // fill work that already runs after the triggering field (so the post-fold scan sees
  // the reveal already mounted). The cap is a runaway backstop (chained reveals are rare).
  maxCascadeRounds: 3,
  // Dropdown OVERWRITE commit (2026-07-06 fast-first; 2026-07-07 ESCALATING LADDER). Committing a
  // RE-SELECTION needs the just-opened list past a Workday-internal option-click DEBOUNCE (no pollable DOM
  // readiness signal). The debounce is a PAINT thing: tiny when the tab is VISIBLE (painting), ~700ms when
  // HIDDEN (not painting, even with worker-timers). act.visible picks the STARTING beats, BUT it can't detect
  // OCCLUSION (a tab alt-tabbed behind another app is throttled like hidden yet still reports
  // tab.active && !minimized → act.visible mislabels it "visible"), so the commit no longer trusts the label:
  // overwriteBeatLadder gives an ASCENDING ladder (visible [fast,slow-vis,slow-hidden]=30→100→700; hidden
  // [120,700]) and the commit ESCALATES on each MISS up to the ~700ms tier REGARDLESS of the label — a
  // painting tab commits on tier 0 (no penalty), a mislabeled/occluded tab self-corrects to the big beat
  // instead of failing to needs_review (the alt-tab language-swap bug). The persistence re-read gates every
  // accept, so escalation only costs extra re-opens, never a wrong fill. overwriteFailFastMs caps each
  // non-final tier so a MISS escalates cheaply (further capped by commitCeilingMs; the last tier gets the full
  // ceiling). Empty fills never race → single fast commit, no ladder. Watch [CDP-DD-REFILL] (logs the ladder +
  // which tier committed) to retune.
  overwriteFastBeatMs: 120,        // HIDDEN ladder tier 0 (live-verified: commits fast at 100ms hidden; 120 = a small margin)
  overwriteSlowBeatMs: 700,        // the proven ~700ms beat (≈ settleIntervalMs*2) — the main "not painting" tier
  overwriteFastBeatVisibleMs: 30,  // VISIBLE ladder tier 0 (visible paints → tiny debounce)
  overwriteSlowBeatVisibleMs: 100, // VISIBLE ladder tier 1 (a laggy-but-painting visible miss)
  overwriteMaxBeatMs: 5000,        // FINAL safety tier for BOTH ladders — a deeply-throttled/occluded tab that even 700ms misses gets one last 5s attempt before needs_review
  overwriteFailFastMs: 600
};

// ── Verbatim M22 ports (background.js fillEngine — change in lockstep) ──────

const FIELD_MAP = {
  "legalName--firstName": "personal_info.first_name",
  "legalName--lastName": "personal_info.last_name",
  "preferredCheck": "personal_info.has_preferred_name", // "I have a preferred name" checkbox — true CHECKS it (reveals the preferred first/last fields, a cascade)
  "preferredName--firstName": "personal_info.preferred_first_name", // revealed by preferredCheck; cascade re-scan fills it
  "preferredName--lastName": "personal_info.preferred_last_name",   // revealed by preferredCheck
  "addressLine1": "personal_info.address_line_1",
  "city": "personal_info.city",
  "postalCode": "personal_info.postal_code",
  "phoneNumber": "personal_info.phone_number",
  "extension": "personal_info.phone_extension",
  "country": "personal_info.country",
  "countryRegion": "personal_info.state_province",
  "phoneType": "personal_info.phone_device_type",
  "countryPhoneCode": "personal_info.country_phone_code",
  // AI-3: self-identification (EEO) — DETERMINISTIC fill from the user's stated data (NEVER
  //   AI-inferred). `gender` live-recon'd on Magna (options Female/Male/Other/Undeclared);
  //   race/veteran/disability map the same way once their automation-ids are observed.
  "gender": "self_identification.gender",
  // AI-3: agreements — legal consent checkbox; checked ONLY if the operator pre-set the
  //   boolean to true (fillCheckboxCdp reconciles to it). null/false → skipped → if REQUIRED
  //   the walk halts with a clean `consent-not-granted` message (never fabricates consent).
  "acceptTermsAndAgreements": "agreements.terms_and_conditions_acceptance"
  // "candidateIsPreviousWorker" — NOT mapped here; answered by the safety-first
  //   employer-match special case in the driver (jobContext.company vs
  //   profile.employment_history_companies).
  // "source" — hierarchical, needs_review (deferred this milestone)
  // "preferredCheck", "regionSubdivision1" — unmapped → skipped
};

const getByPath = (obj, path) =>
  path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

const isEmpty = (v) =>
  v === undefined || v === null || (typeof v === "string" && v.trim() === "");

// Coerce the raw profile value to what the classified widget needs.
// Returns { value } (text), { candidates } (choice/radio), or { skip:true }.
const resolve = (raw, widgetType) => {
  if (widgetType === "text") {
    if (isEmpty(raw)) return { skip: true };
    return { value: String(raw) };
  }
  if (widgetType === "dropdown" || widgetType === "typeahead") {
    if (Array.isArray(raw)) {
      const candidates = raw.map((v) => String(v)).filter((s) => s.trim() !== "");
      return candidates.length ? { candidates } : { skip: true };
    }
    if (isEmpty(raw)) return { skip: true };
    return { candidates: [String(raw)] };
  }
  if (widgetType === "radio") {
    if (raw === null || raw === undefined) return { skip: true };
    if (typeof raw === "boolean") return { candidates: [raw ? "Yes" : "No"] };
    if (isEmpty(raw)) return { skip: true };
    return { candidates: [String(raw)] };
  }
  return { skip: true, reason: `unsupported widget type "${widgetType}"` };
};

// ── "Previously employed here?" — company matcher (verbatim M12/M13.3 port).
// "Yes" is NEVER asserted without a review flag (it sits beside a truthfulness
// certification and unfurls follow-up fields).
const COMPANY_STOP = new Set(["inc","incorporated","llc","ltd","limited","corp","corporation","co","company","plc","gmbh","sa","ag","group","holdings","the","and","of"]);
const companyTight = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
const companyTokens = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/)
    .filter((t) => t.length >= 2 && !COMPANY_STOP.has(t));
const GENERIC_SINGLE = new Set(["bank","tech","global","systems","solutions","services","capital","financial","national","health","media","digital","consulting","ventures","labs","online","store","center"]);
const containsSeq = (hay, needle) => {
  if (!needle.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
};
const distinctiveForQuestion = (eTokens) =>
  eTokens.length >= 2 || (eTokens.length === 1 && eTokens[0].length >= 5 && !GENERIC_SINGLE.has(eTokens[0]));

// Returns { fill: "No"|"Yes"|null, review: bool, likelyYes?: bool, detail }.
// fill === null → cannot evaluate → leave blank (needs_review, unfilled).
const decidePreviousWorker = (company, questionText, employers) => {
  if (!Array.isArray(employers)) return { fill: null, review: true, detail: "employment_history_companies not configured — left blank" };
  if (employers.length === 1 && String(employers[0]).trim().toLowerCase() === "none") {
    return { fill: "No", review: false, detail: 'explicit no-employers sentinel (["none"]) → No' };
  }
  if (employers.length === 0) {
    return { fill: null, review: true, detail: 'no employers configured ([]) — left blank; add employers or set ["none"]' };
  }
  const co = (company || "").trim();
  const tightC = companyTight(co);
  const tokensC = new Set(companyTokens(co));
  const qTokens = companyTokens(questionText || "");

  const yesHits = [];
  const overlapHits = [];
  for (const e of employers) {
    const es = String(e).trim();
    if (!es) continue;
    const tightE = companyTight(es);
    if (!tightE) continue;
    const eTokens = companyTokens(es);
    if (tightC && tightC === tightE) { yesHits.push(`"${es}" (matches the company you're applying to)`); continue; }
    if (distinctiveForQuestion(eTokens) && containsSeq(qTokens, eTokens)) { yesHits.push(`"${es}" (named in the question text)`); continue; }
    let why = null;
    if (tightC && (tightC.includes(tightE) || tightE.includes(tightC))) why = "substring";
    else if (tightC && eTokens.some((t) => tokensC.has(t))) why = "shared word";
    if (why) overlapHits.push(`${es} (${why})`);
  }

  if (yesHits.length) {
    const corroborate = tightC ? "" : " — no application company was set to corroborate; verify carefully";
    return { fill: "Yes", review: true, likelyYes: true, detail: `Filled "Yes" — matched known employer ${yesHits.join("; ")}. Confirm you actually worked there before submitting (a wrong "Yes" is a false statement on a certification)${corroborate}.` };
  }
  if (overlapHits.length) {
    return { fill: "No", review: true, detail: `company "${co}" partially overlaps known employer(s): ${overlapHits.join(", ")} → filled "No"; REVIEW (could be the same employer)` };
  }
  if (tightC) {
    return { fill: "No", review: false, detail: `no known employer matches the company "${co}" or appears in the question → No (clean miss vs ${employers.length} known employer(s))` };
  }
  return { fill: null, review: true, detail: "no company set for this application and no known employer named in the question — left blank" };
};

// ── Per-widget fill paths (actuation via `act`, decisions per M22) ──────────

// Poll until an input's checked state is `want`. Generous wall-clock — the
// page's React update runs on the throttled loop.
const pollCheckedIs = async (act, id, want, budgets) => {
  const deadline = Date.now() + budgets.commitCeilingMs;
  while (Date.now() < deadline) {
    await act.delay(budgets.commitIntervalMs);
    if ((await act.readChecked(id)) === want) return true;
  }
  return false;
};

// Text: focus → trusted clear → insertText → read-back. Read-back mismatch is
// NEVER reported as filled (the commit-verification contract of this port).
// `tag` (M37) selects the element kind within the wrapper — default "input"; pass
// "textarea" for the WE roleDescription (recon 2026-06-18: coordinate-click focus +
// Input.insertText drives a Workday <textarea> with the newline intact + React-
// surviving). The default keeps every existing <input> caller byte-identical.
// Text-value equality with Workday's phone auto-format tolerance. An exact string match, OR — when
// BOTH sides are phone-shaped (only digits + phone punctuation, ≥7 digits) — the same digit sequence.
// Workday reformats a typed phone to "(850) 666-0266"; "8506660266" / "850-666-0266" are the SAME
// number, so a format-only difference is NOT a change (don't re-type, don't flag, don't audit-fail).
// SAFE: any value containing a letter is never phone-shaped, so ordinary text still compares exactly;
// the digit path only engages when the exact match already failed AND both sides are pure phone shape.
const PHONE_SHAPE = /^[\d()\-.\s+]+$/;
const phoneShaped = (s) => typeof s === "string" && PHONE_SHAPE.test(s.trim()) && s.replace(/\D/g, "").length >= 7;
function textValuesMatch(actual, expected) {
  if (actual == null || expected == null) return false;
  if (String(actual) === String(expected)) return true;
  if (phoneShaped(String(actual)) && phoneShaped(String(expected)) && String(actual).replace(/\D/g, "") === String(expected).replace(/\D/g, "")) return true;
  return false;
}

const fillTextCdp = async (act, loc, value, budgets, tag) => {
  const pre = await act.readTextValue(loc, tag);
  if (!pre) return { status: "error", detail: "no " + (tag || "input") + " in wrapper" };
  const before = pre.value;
  // SKIP-IF-CORRECT (minimal-diff replay, budgets.skipIfCorrect): the box already holds the value
  // (phone-format-tolerant) → leave it UNTOUCHED, zero actuation. A replay changes only what DIFFERS;
  // this is what makes page-2 repeating entries stop fully re-typing correct fields. Inert on the
  // normal fill path (the flag is unset), where an empty box never matches a real value anyway.
  if (budgets && budgets.skipIfCorrect && textValuesMatch(before, value)) {
    return { status: "filled", after: before, verified: true, flag: "replay-already-correct", detail: "already correct — left unchanged (no actuation)" };
  }
  // SELF-HEAL retry: a read-back mismatch (the live "fFirmware…" stray-char bug) is a WRONG value,
  // not a slow one — the reactive poll below already waits out lag, so a miss means a bad fill. Retry
  // the whole focus→clear→type→poll up to budgets.textFillAttempts before flagging. The happy path is
  // unchanged (attempt 1's poll matches on its first read); only a genuine miss pays the extra attempt.
  const attempts = budgets.textFillAttempts || 1;
  let after = before, focusMethod = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    focusMethod = await act.focusText(loc, tag);
    if (!focusMethod) { if (attempt < attempts) continue; return { status: "error", detail: "could not focus " + (tag || "input"), after: before }; }
    await act.clearText(); // local DOM op; CDP clear→type events apply in order — no fixed settle needed
    await act.typeText(value);
    // Reactive read-back: POLL until the field reads back the COMPLETE typed value (survives any
    // lag — laggy wifi, a throttled tick), NEVER a fixed sleep then a single read. `after === value`
    // is the COMPLETE-state condition (not "something appeared") — the same lesson as the dropdown
    // false-verify: a partial/momentary read must not satisfy it. Ceiling = give-up bound only.
    after = before;
    const deadline = Date.now() + budgets.textReadCeilingMs;
    do {
      const read = await act.readTextValue(loc, tag);
      after = read ? read.value : null;
      if (textValuesMatch(after, value)) break; // COMPLETE-state (phone-format-tolerant: Workday reformats a typed phone)
      await act.delay(budgets.textReadIntervalMs);
    } while (Date.now() < deadline);
    if (textValuesMatch(after, value)) {
      let detail = before ? `overwrote "${before}"` : null;
      if (attempt > 1) detail = (detail ? detail + " | " : "") + `self-healed on attempt ${attempt}`;
      return { status: "filled", after, verified: true, detail };
    }
    // mismatch → re-focus/clear/type on the next attempt (the prior type landed a wrong value)
  }
  return { status: "needs_review", after, verified: false, detail: `read-back mismatch after ${attempts} attempt(s) (typed via ${focusMethod}, field shows "${after}")` };
};

// ── AI-1 dropdown helpers (shared open/settle + verified-blank close) ─────────
// Open a dropdown with the proven retry + settle and return its FULL option list. Mirrors
// fillDropdownCdp's open-retry (GATE 1 aria-expanded) + option settle (GATE 2, delayFull —
// the option list renders at the PAGE's pace, never sped up). Reads `before` (the pre-open
// trigger text = the placeholder) so a later closeAndVerifyBlank can prove the field stayed
// blank. READ-ONLY — no match/commit. (fillDropdownCdp keeps its own inline copy; this serves
// reconDropdownDump + aiFillField, the no-commit readers.)
const openAndReadDropdown = async (act, loc, budgets) => {
  const delayRender = act.delayRender || act.delayFull; // STAGE 2: render-settle, adaptive under the measured-fast gate (fallback for older fakes)
  const pre = await act.readDropdownState(loc);
  const before = pre ? pre.triggerText : null;
  let state = null, expanded = false;
  for (let attempt = 1; attempt <= budgets.openRetries && !expanded; attempt++) {
    if (attempt > 1) { await act.pressEscape(); await act.delay(budgets.reopenSettleMs); }
    if (!(await act.openDropdown(loc))) continue; // trigger rect dead — re-open
    const expandDeadline = Date.now() + budgets.openExpandWindowMs;
    while (Date.now() < expandDeadline) {
      await act.delay(budgets.settleIntervalMs);
      state = await act.readDropdownState(loc);
      if (state && state.ariaExpanded === "true") { expanded = true; break; }
    }
  }
  if (expanded) { // GATE 2: settle to the COMPLETE list (2 equal non-zero reads); interval adaptive under the measured-fast gate (delayRender)
    let prevCount = -1, stable = 0;
    const openDeadline = Date.now() + budgets.openCeilingMs;
    while (Date.now() < openDeadline) {
      const n = state ? state.optionCount : 0;
      if (n > 0 && n === prevCount) { stable++; if (stable >= budgets.stableReads - 1) break; }
      else stable = 0;
      prevCount = n;
      await delayRender(budgets.settleIntervalMs);
      state = await act.readDropdownState(loc);
    }
  }
  return { before, state, expanded };
};

// The no-commit dismissal for the UNKNOWN / no-match paths (AI-1) and the recon. **BLANK is a
// VALUE property:** the trigger stayed on its opening placeholder (`norm(triggerText)===norm(before)`).
// Hold 1's actual property is "staying-blank" — a STRAY commits a real option, which CHANGES
// triggerText, so the value check fully captures it (incl. the commit-that-also-closes-the-list
// case Hold 1 named). We deliberately do NOT gate on `ariaExpanded` and do NOT reopen-to-toggle:
// the live run proved both manufacture a false stray — on a slow-closing Magna dropdown the read
// catches the list still open, the toggle REOPENS the closing list (ping-pong), retries exhaust,
// and a genuinely blank field got mislabeled `ai-unknown-stray` ("Select One STRAYED"). pressEscape
// is BEST-EFFORT close (never reopen); the inter-field delay + the next field's open-settle let it
// finish closing before the next field (empirically no cross-field stray live — and a cross-field
// stray WOULD surface as the NEXT field's value changing → still flagged, just attributed to the
// field it landed on). Returns {blank, after}: !blank ⇒ the caller surfaces `after` (the real
// strayed value) — Hold 2. The SOLE guard on the no-commit path (M40 never re-reads a blank field).
const closeAndVerifyBlank = async (act, loc, before, budgets) => {
  const norm = apMatch.normalize;
  const dr = act.delayRender || act.delayFull; // adaptive close-settle (fast fg/worker-fast; full on the slow path) — fallback for older fakes
  const blankNow = (s) => !!s && before != null && norm(s.triggerText) === norm(before);
  let s = null;
  // Poll until the portaled LISTBOX is truly GONE — NOT merely aria-expanded="false". aria flips the instant
  // Escape fires, but the listbox lingers a beat while it unmounts and its options stay CLICKABLE; returning
  // on aria alone let the NEXT recon field's open-click land on a lingering option (the live "Landline
  // committed to Phone Device Type" stray — the next field sat exactly where that option rendered). The
  // adaptive wait keeps the happy path fast (breaks the instant the listbox is gone — usually ~1 poll); a
  // real deadline (the old openRetries×reopenSettleMs budget) bounds a genuinely slow close so we NEVER
  // return with the list still up. Re-Escape each poll (idempotent on an already-closing list; never reopen).
  const deadline = Date.now() + (budgets.openRetries || 3) * (budgets.reopenSettleMs || 400);
  do {
    await act.pressEscape();
    await dr(budgets.reopenSettleMs);
    s = await act.readDropdownState(loc);
    if (s && (!s.listboxPresent || s.optionCount === 0)) break; // fully closed → no lingering clickable option
  } while (Date.now() < deadline);
  return { blank: blankNow(s), after: s ? s.triggerText : null };
};

// Honest AFTER for the AI no-commit exits (call failed / no options / no match). cz.blank means
// the value did not CHANGE — but an UNCHANGED field is only truly blank when what it held was
// the placeholder ("Select One"): a PREFILLED dropdown (Workday restores prior answers on a
// re-run) stays on its REAL value, and reporting after:null there MASKED the live value from the
// summary (the 2026-07-02 page-3 bug: a 503-failed AI call on a prefilled screening dropdown →
// the review showed an empty field while the page held the answer; current_value = rec.after, so
// null hid it). Unchanged+real → report the live value; unchanged+placeholder → null (genuinely
// blank); changed → the strayed value (the caller's *-stray flag, keyed on cz.blank, is untouched).
const noCommitAfter = (cz) => (cz.blank && !hasLiveValue(cz.after) ? null : cz.after);
// The companion review note — tells the reviewer the value they see was ALREADY on the page.
const keptPrefillNote = (cz) => (cz.blank && hasLiveValue(cz.after)
  ? "; the field already held \"" + cz.after + "\" (prefilled) — KEPT, verify" : "");

// AI-1 recon (READ-ONLY): open a dropdown, capture its FULL option list, then dismiss it via
// the VERIFIED-BLANK close (NOT a bare Escape) and report whether it stayed blank. NEVER
// types/arrows/clicks an option. `clean` is the real property (closed AND still on the
// placeholder) — a stray is reported clean:false with the strayed value (the recon's earlier
// false-clean is fixed: closeAndVerifyBlank catches the closed-but-committed case).
const reconDropdownDump = async (act, loc, budgets) => {
  const { before, state, expanded } = await openAndReadDropdown(act, loc, budgets);
  const options = state ? state.options.map((o) => ({ text: o.text, disabled: o.disabled, selected: o.selected })) : [];
  const optionCount = state ? state.optionCount : 0;
  const cz = await closeAndVerifyBlank(act, loc, before, budgets);
  return { opened: expanded, before, after: cz.after, clean: cz.blank, optionCount, options };
};

// ── AI-1 eligibility + the AI dropdown fill ──────────────────────────────────
// Legally-loaded screening questions get a STRONGER review reason. Widened per the Magna recon
// (the verbatim labels): the old /18 (years|or older)/ MISSED "over the age of 18". Over-flag
// to "sensitive" is the safe direction (worst case a benign Q gets a stronger flag).
const AI_LEGALLY_LOADED_RE = /criminal|convict|pardon|eligib|authoriz|work permit|right to work|currently employed|sponsor|\bage\b|over (the age of )?\d+|under \d+|\b18\b/i;
const legallyLoaded = (label) => AI_LEGALLY_LOADED_RE.test(String(label || ""));

// EEO/demographic detector. The "never AI-guess EEO" exclusion was RETRACTED (operator decision): EEO
// fields now fill via the SAME AI inference as any other field — the AI may ASSUME them. AI_EEO_RE
// survives ONLY to (a) tag an AI-committed demographic with the louder "AI-GUESSED DEMOGRAPHIC — VERIFY"
// review badge (ai-eeo-guess), and (b) route a mapped-but-empty REQUIRED EEO dropdown to the
// confidence-gated AI-3 path (aiInferEeoField). It NO LONGER blocks eligibility.
const AI_EEO_RE = /gender|\brace\b|ethnic|veteran|disab|sexual orientation|\bsex\b|hispanic|latino|pronoun/i;
const isEeoField = (o) => !!o && (AI_EEO_RE.test(String(o.label || "")) || AI_EEO_RE.test(String(o.fieldName || "")));

// AI-fill is allowed for an unmapped/unmatched CHOICE field (AI-1: dropdown) or free-text
// (AI-2: text/textarea). NEVER the employer-match radio (its own logic), file_upload, radio, or
// checkbox. EEO is NO LONGER excluded (the operator retracted that rule) — an EEO dropdown/text fills
// via AI inference like any field, then gets the demographic review badge (re-tagged at the call site).
// Hard gate — unit-pinned. MAPPED text fields (phone/postal/…) never reach the AI hook anyway (they
// fill deterministically so producedNothing(record) is false; only UNMAPPED text reaches AI-2).
const aiEligible = (f) => {
  if (!f) return false;
  if (f.fieldName === "candidateIsPreviousWorker") return false;  // employer-match path
  return f.widgetType === "dropdown" || f.widgetType === "text" || f.widgetType === "textarea";
};

// Did the deterministic pass produce NOTHING usable? (the AI-fallback trigger) — either
// unmapped (skipped "no mapping") or a GENUINE no-match (options rendered, none matched).
// NEVER a transient/infra failure (those aren't tagged genuineNoMatch).
const producedNothing = (record) =>
  (record.status === "skipped" && record.detail === "no mapping") ||
  (record.status === "needs_review" && record.genuineNoMatch === true);

// Parse the LLM's structured screening answer. The prompt asks for JSON {choice, justification,
// confidence}; be tolerant — strip ```-fences, fall back to the first {…} block, and if it's not
// JSON at all treat the whole reply as the choice (low confidence). confidence normalizes to the
// existing band vocabulary (high/medium/low) so the summary badge CSS + deriveConfidence reuse it.
const _aiConf = (c) => { const v = String(c == null ? "" : c).trim().toLowerCase(); return (v === "high" || v === "medium" || v === "low") ? v : "low"; };
const parseAiReply = (text) => {
  let t = String(text == null ? "" : text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let obj = null;
  try { obj = JSON.parse(t); } catch (e) {
    const mm = t.match(/\{[\s\S]*\}/);
    if (mm) { try { obj = JSON.parse(mm[0]); } catch (e2) { /* fall through to best-effort */ } }
  }
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const pick = (a, b) => String(obj[a] != null ? obj[a] : (obj[b] != null ? obj[b] : "")).trim();
    return { choice: pick("choice", "answer"), justification: pick("justification", "reason"), confidence: _aiConf(obj.confidence) };
  }
  return { choice: t, justification: "", confidence: "low" }; // unparseable → best-effort: whole reply is the choice
};

// AI dropdown fill (AI-1, ALWAYS-GUESS): open + read the LIVE options → the LLM gets the profile +
// question + exact options and CHOOSES one (these are REQUIRED fields — never UNKNOWN/blank, a blank
// HALTS the walk) + a one-sentence justification (that NAMES its basis: a positive profile fact vs
// reasoning from ABSENCE) + a confidence. The choice is a CANDIDATE that must clear the match ladder
// vs the LIVE options (never blind-commit) → commit + read-back + M39 persistence re-read. ALWAYS
// filled_review (never silent). Safety = the human review gate + per-answer confidence + the
// sensitive flag — the legally-loaded "reasoning-from-absence" answers (criminal→No, eligibility→No)
// are surfaced ai-choice-sensitive and the viewer keys PROMINENCE off that flag, NOT off confidence
// (a High-confidence sensitive answer must not be the easiest to scroll past). Provider-agnostic.
const aiFillField = async (act, loc, f, profile, jobContext, budgets) => {
  const norm = apMatch.normalize;
  const sensitive = legallyLoaded(f.label);
  const { before, state, expanded } = await openAndReadDropdown(act, loc, budgets);
  if (!expanded || !state || state.optionCount === 0) { // couldn't open / no render — infra, not invalid data
    const cz = await closeAndVerifyBlank(act, loc, before, budgets);
    return { status: "needs_review", after: noCommitAfter(cz), flag: cz.blank ? "ai-no-options" : "ai-no-options-stray",
      detail: "AI fallback: dropdown options did not render (not actuated)" + keptPrefillNote(cz), options: enabledTextsSafe(state), auditLoc: loc.wrapperSel };
  }
  const enabledTexts = state.options.filter((o) => !o.disabled).map((o) => o.text);
  const system = "You help an applicant fill out REQUIRED job-application screening questions. Given the applicant's profile (JSON), one question, and its exact answer options, choose the SINGLE best option. INFER from the profile even when it is not stated verbatim — e.g. work eligibility from citizenship/work_authorization, age from education/enrollment dates, criminal/background answers from the ABSENCE of any such record. These questions are REQUIRED: always choose the most likely option, never refuse. Keep the justification SHORT — one terse phrase, about 12 words, no preamble or restating the answer — that NAMES your basis: the positive profile fact used, OR plainly that you are inferring from the ABSENCE of information (e.g. \"no criminal record in profile\"; absence-based answers are less certain, so say so). Give your confidence: High, Medium, or Low.";
  const user = "Question: " + String(f.label || "")
    + "\nAnswer options (choose exactly one; reply with its EXACT text): " + JSON.stringify(enabledTexts)
    + "\nApplicant profile: " + JSON.stringify(profile)
    + "\nJob context: " + JSON.stringify(jobContext || {})
    + "\n\nReply ONLY with a JSON object and nothing else:\n{\"choice\":\"<exact option text>\",\"justification\":\"<short phrase, ~12 words, naming your basis>\",\"confidence\":\"High|Medium|Low\"}";
  const res = await act.llm({ system, user, maxTokens: 512 });
  if (!res || !res.ok) { // call failed / empty — infra, NOT a decision
    const cz = await closeAndVerifyBlank(act, loc, before, budgets);
    return { status: "needs_review", after: noCommitAfter(cz), flag: cz.blank ? "ai-call-failed" : "ai-call-failed-stray",
      detail: "AI call failed — " + ((res && res.error) || "no reply") + keptPrefillNote(cz), options: enabledTexts, auditLoc: loc.wrapperSel };
  }
  const ai = parseAiReply(res.text);
  const conf = ai.confidence; // the AI's self-reported inference confidence (high/medium/low)
  // The choice is a CANDIDATE — clear the match ladder vs the LIVE options. A paraphrase / refusal /
  // literal "UNKNOWN" won't match → a RARE needs_review fallback (never blind-commit arbitrary text).
  const m = ai.choice ? apMatch.matchCandidates([ai.choice], enabledTexts) : { targetIndex: -1, matchTier: null };
  if (m.targetIndex === -1) {
    const cz = await closeAndVerifyBlank(act, loc, before, budgets);
    const base = "AI chose \"" + ai.choice + "\" — not one of the options" + (ai.justification ? " (" + ai.justification + ")" : "");
    if (cz.blank) return { status: "needs_review", after: noCommitAfter(cz), flag: "ai-nomatch", confidence: conf,
      detail: base + keptPrefillNote(cz), options: enabledTexts, auditLoc: loc.wrapperSel };
    return { status: "needs_review", after: cz.after, flag: "ai-nomatch-stray", confidence: conf,
      detail: base + "; \"" + cz.after + "\" STRAYED onto this field — review/correct it", options: enabledTexts, auditLoc: loc.wrapperSel };
  }

  const target = enabledTexts[m.targetIndex];
  await act.clickDropdownOptionByText(loc, target);
  await act.delayFull(budgets.reopenSettleMs);
  let post = await act.readDropdownState(loc);
  let committed = post && norm(post.triggerText) === norm(target);
  if (committed) { // M39 persistence: re-read after a real beat — a momentary pick that reverts is NOT a commit
    await act.delayFull(budgets.reopenSettleMs);
    post = await act.readDropdownState(loc);
    committed = post && norm(post.triggerText) === norm(target);
  }
  if (!committed) return { status: "needs_review", after: post ? post.triggerText : null, flag: "ai-commit-failed", confidence: conf,
    detail: "AI chose \"" + target + "\" but the commit did not persist", options: enabledTexts, auditLoc: loc.wrapperSel };
  // ALWAYS filled_review — an AI guess is never silently trusted. If the dropdown held a REAL
  // prefilled value the AI's pick replaced, say so (provenance for the reviewer — the prior
  // answer is otherwise invisible once overwritten).
  const overwroteNote = hasLiveValue(before) && norm(before) !== norm(target)
    ? " (overwrote prefilled \"" + before + "\")" : "";
  return { status: "filled_review", after: target, verified: true, matchTier: m.matchTier,
    flag: sensitive ? "ai-choice-sensitive" : "ai-choice", confidence: conf,
    detail: "AI: " + (ai.justification || ("chose " + target)) + " → \"" + target + "\"" + (sensitive ? " — LEGALLY-LOADED, verify" : "") + overwroteNote,
    options: enabledTexts, auditLoc: loc.wrapperSel };
};
// options for the no-render branch (state may be null) — keep the report honest without throwing.
function enabledTextsSafe(state) { return state && Array.isArray(state.options) ? state.options.filter((o) => !o.disabled).map((o) => o.text) : null; }

// Parse the LLM's free-text reply (AI-2). The prompt asks for {answer} OR {skip,reason}; tolerate
// ```-fences / embedded JSON / a bare "SKIP" / a non-JSON answer (best-effort: the whole reply IS
// the answer). Returns {skip, answer, reason}.
const parseAiText = (text) => {
  let t = String(text == null ? "" : text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let obj = null;
  try { obj = JSON.parse(t); } catch (e) {
    const mm = t.match(/\{[\s\S]*\}/);
    if (mm) { try { obj = JSON.parse(mm[0]); } catch (e2) { /* fall through */ } }
  }
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    if (obj.skip === true || /^skip\b/i.test(String(obj.answer == null ? "" : obj.answer).trim())) return { skip: true, answer: "", reason: String(obj.reason == null ? "declined" : obj.reason).trim() || "declined" };
    return { skip: false, answer: String(obj.answer == null ? "" : obj.answer).trim(), reason: "" };
  }
  if (/^skip\b/i.test(t)) return { skip: true, answer: "", reason: "declined" };
  return { skip: false, answer: t, reason: "" }; // non-JSON → best-effort: the whole reply is the answer
};

// AI_NEEDS_ANSWER_MARK is the load-bearing placeholder sentinel — defined canonically in lib.js
// (apMatch); duplicated here ONLY for the SW path where apMatch is the inline {normalize,
// matchCandidates} fallback (no constant). LOCKSTEP with lib.js AI_NEEDS_ANSWER_MARK.
const AI_NEEDS_ANSWER_MARK_FD = "[NEEDS YOUR ANSWER";
const aiPlaceholderText = (reason) => AI_NEEDS_ANSWER_MARK_FD + " — AI declined: " + (reason || "no basis in profile") + "]";

// AI-2 free-text / essay fill (LLM). ALWAYS-GUESS adapted to text: GENERATE an answer from the
// profile, or SKIP for factual data it shouldn't fabricate — but **NEVER leave a REQUIRED field
// blank** (a blank halts the walk short of review). OPTIONAL skip → blank needs_review; REQUIRED
// skip → a CONSPICUOUS placeholder (non-blank → walk advances; the review banners it + the deferred
// SUBMIT hard-blocks on the marker). ALWAYS filled_review. Provider-agnostic (act.llm).
const aiFillText = async (act, loc, f, profile, jobContext, budgets) => {
  const required = !!f.isRequired;
  const tag = f.widgetType === "textarea" ? "textarea" : "input";
  // OPTIONAL decline → blank+flag; REQUIRED decline → placeholder so the walk reaches review.
  const declineOrPlaceholder = async (reason) => {
    if (!required) return { status: "needs_review", after: null, flag: "ai-text-skip", detail: "AI declined: " + reason, auditLoc: loc.wrapperSel };
    const ph = aiPlaceholderText(reason);
    const r = await fillTextCdp(act, loc, ph, budgets, tag);
    return { status: "filled_review", after: (r && r.after != null) ? r.after : ph, verified: r && r.verified === true, flag: "ai-text-needs-answer",
      detail: "REQUIRED — AI declined (" + reason + "); placeholder filled so the walk advances — REPLACE before submit", auditLoc: loc.wrapperSel };
  };
  // Generation master-switch: the operator's autofill_rules allowlist (empty ⇒ generation OFF).
  const genAllowed = !!(profile && profile.autofill_rules && Array.isArray(profile.autofill_rules.generation_allowed_only_for)
    && profile.autofill_rules.generation_allowed_only_for.indexOf("application_questions.open_ended") !== -1);
  if (!genAllowed) return await declineOrPlaceholder("AI text generation is off (autofill_rules)");

  const style = (profile && profile.application_questions && profile.application_questions.writing_style) || "";
  const system = "You write a brief, human, professional answer to ONE job-application question for the applicant, using ONLY the applicant's profile (experience, projects, skills, essay_drafts, story_bank, open_ended). "
    + (style ? "Writing style: " + style + " " : "")
    + "If the field asks for specific FACTUAL data not in the profile (a name, ID, code, date, number, URL, address) or you cannot answer from the profile, reply SKIP — NEVER fabricate facts about the applicant.";
  const user = "Question / field label: " + String(f.label || "")
    + "\nApplicant profile: " + JSON.stringify(profile)
    + "\nJob context: " + JSON.stringify(jobContext || {})
    + "\n\nReply ONLY with a JSON object and nothing else:\n{\"answer\":\"<your answer>\"}  OR  {\"skip\":true,\"reason\":\"<short reason>\"}";
  const res = await act.llm({ system, user, maxTokens: 1024 });
  if (!res || !res.ok) return await declineOrPlaceholder("AI call failed — " + ((res && res.error) || "no reply"));
  const parsed = parseAiText(res.text);
  if (parsed.skip || !parsed.answer) return await declineOrPlaceholder(parsed.reason || "AI returned no answer");

  const r = await fillTextCdp(act, loc, parsed.answer, budgets, tag);
  if (!r || r.status !== "filled") return { status: "needs_review", after: r ? r.after : null, flag: "ai-text-commit-failed",
    detail: "AI generated an answer but the text fill did not verify: " + ((r && r.detail) || "no read-back"), auditLoc: loc.wrapperSel };
  // ALWAYS filled_review — an AI-generated answer is never silently trusted.
  return { status: "filled_review", after: parsed.answer, verified: true, flag: "ai-text", confidence: "medium",
    detail: "AI-generated answer from the profile", auditLoc: loc.wrapperSel };
};

// AI-3 CANONICALIZATION (dropdown) — the deferred "LLM vocabulary canonicalization" job, now
// driven by the EEO gender case. The field is MAPPED and the user has a STATED value, but it
// didn't match the form's option vocab (genuineNoMatch). The AI is TOLD the value and only
// TRANSLATES it to the closest option — it NEVER infers/decides (so it is SAFE + allowed even for
// EEO: the demographic comes from the profile, the AI just maps "Male"→"Man"). The pick must clear
// the match ladder vs the LIVE options (never blind-commit); always filled_review; UNKNOWN/no-match
// → needs_review. `stated` = the profile candidate(s) that failed to match.
const aiCanonicalizeField = async (act, loc, f, stated, budgets) => {
  const norm = apMatch.normalize;
  const statedStr = Array.isArray(stated) ? stated.join(" / ") : String(stated);
  const { before, state, expanded } = await openAndReadDropdown(act, loc, budgets);
  if (!expanded || !state || state.optionCount === 0) {
    const cz = await closeAndVerifyBlank(act, loc, before, budgets);
    return { status: "needs_review", after: noCommitAfter(cz), flag: "ai-canon-no-options",
      detail: "AI canonicalize: options did not render (not actuated)" + keptPrefillNote(cz), auditLoc: loc.wrapperSel };
  }
  const enabledTexts = state.options.filter((o) => !o.disabled).map((o) => o.text);
  const system = "The applicant has ALREADY STATED a value for this field. Your ONLY job is to pick the option from the provided list that means the SAME as the stated value (vocabulary mapping, e.g. \"Male\"→\"Man\"). You are NOT inferring, deciding, or changing anything about the applicant. If NO option means the same, reply UNKNOWN. Never pick an option that differs in meaning.";
  const user = "Field: " + String(f.label || "")
    + "\nThe applicant's STATED value: " + JSON.stringify(statedStr)
    + "\nOptions (reply with the EXACT text of the matching one): " + JSON.stringify(enabledTexts)
    + "\n\nReply ONLY with a JSON object and nothing else:\n{\"choice\":\"<exact option text>\",\"confidence\":\"High|Medium|Low\"}";
  const res = await act.llm({ system, user, maxTokens: 128 });
  if (!res || !res.ok) {
    const cz = await closeAndVerifyBlank(act, loc, before, budgets);
    return { status: "needs_review", after: noCommitAfter(cz), flag: "ai-canon-failed",
      detail: "AI canonicalize call failed — " + ((res && res.error) || "no reply") + keptPrefillNote(cz), options: enabledTexts, auditLoc: loc.wrapperSel };
  }
  const ai = parseAiReply(res.text);
  const conf = ai.confidence;
  const m = ai.choice ? apMatch.matchCandidates([ai.choice], enabledTexts) : { targetIndex: -1, matchTier: null };
  if (m.targetIndex === -1) { // UNKNOWN / not a real option — never blind-commit a demographic
    const cz = await closeAndVerifyBlank(act, loc, before, budgets);
    const base = "AI could not map stated \"" + statedStr + "\" to an option" + (ai.choice ? " (replied \"" + ai.choice + "\")" : "");
    if (cz.blank) return { status: "needs_review", after: noCommitAfter(cz), flag: "ai-canon-nomatch", confidence: conf, detail: base + keptPrefillNote(cz), options: enabledTexts, auditLoc: loc.wrapperSel };
    return { status: "needs_review", after: cz.after, flag: "ai-canon-nomatch-stray", confidence: conf, detail: base + "; \"" + cz.after + "\" STRAYED — review", options: enabledTexts, auditLoc: loc.wrapperSel };
  }
  const target = enabledTexts[m.targetIndex];
  await act.clickDropdownOptionByText(loc, target);
  await act.delayFull(budgets.reopenSettleMs);
  let post = await act.readDropdownState(loc);
  let committed = post && norm(post.triggerText) === norm(target);
  if (committed) { await act.delayFull(budgets.reopenSettleMs); post = await act.readDropdownState(loc); committed = post && norm(post.triggerText) === norm(target); }
  if (!committed) return { status: "needs_review", after: post ? post.triggerText : null, flag: "ai-canon-commit-failed",
    detail: "AI mapped \"" + statedStr + "\" → \"" + target + "\" but the commit did not persist", options: enabledTexts, auditLoc: loc.wrapperSel };
  // ALWAYS filled_review — a canonicalized demographic still gets a human glance.
  return { status: "filled_review", after: target, verified: true, matchTier: m.matchTier, flag: "ai-canonicalized", confidence: conf,
    detail: "AI canonicalized stated \"" + statedStr + "\" → \"" + target + "\" (vocab map, not inferred)", options: enabledTexts, auditLoc: loc.wrapperSel };
};

// AI-3 MANDATORY-EEO inference (dropdown) — operator-decided (REVERSES "never AI-guess a demographic").
// A REQUIRED EEO field with NO profile value (a blank would HALT the walk). The LLM may INFER the
// demographic ONLY as a CONFIDENT guess (e.g. from the name); otherwise it MUST decline (the neutral
// option). Confidence-gated: a high-confidence non-decline guess commits (`ai-eeo-guess`); a decline,
// or a low-confidence guess (overridden to the decline), commits the neutral (`eeo_declined`). Both
// `filled_review` (a guessed/declined demographic always gets a human glance). The pick clears the
// match ladder. No decline option + no confident guess → `needs_review`. ⚠ name→demographic inference
// is culturally unreliable — the flag + the model's confidence are the only guard. Optional EEO never
// reaches here (the dispatch gate requires isRequired).
const AI_EEO_DECLINE_RE = /prefer not|decline|undeclared|do not wish|not.*(disclose|answer)|choose not|rather not/i;
const aiInferEeoField = async (act, loc, f, profile, budgets) => {
  const norm = apMatch.normalize;
  const { before, state, expanded } = await openAndReadDropdown(act, loc, budgets);
  if (!expanded || !state || state.optionCount === 0) {
    const cz = await closeAndVerifyBlank(act, loc, before, budgets);
    return { status: "needs_review", after: noCommitAfter(cz), flag: "ai-eeo-no-options", detail: "AI EEO: options did not render" + keptPrefillNote(cz), auditLoc: loc.wrapperSel };
  }
  const enabledTexts = state.options.filter((o) => !o.disabled).map((o) => o.text);
  const declineOpt = enabledTexts.find((o) => AI_EEO_DECLINE_RE.test(o)) || null;
  const system = "The applicant did NOT provide this demographic, and it is REQUIRED. Infer it from their profile (e.g. name) ONLY if you can make a CONFIDENT, well-supported guess; otherwise you MUST decline. Choose the matching option text if confident, or the option that declines to answer if not. Never guess at low confidence.";
  const user = "Field: " + String(f.label || "")
    + "\nApplicant profile: " + JSON.stringify(profile)
    + "\nOptions: " + JSON.stringify(enabledTexts)
    + (declineOpt ? "\nThe decline option is: " + JSON.stringify(declineOpt) : "\n(no explicit decline option exists)")
    + "\n\nReply ONLY with a JSON object and nothing else:\n{\"choice\":\"<exact option text>\",\"confidence\":\"High|Medium|Low\"}";
  const res = await act.llm({ system, user, maxTokens: 128 });
  if (!res || !res.ok) {
    const cz = await closeAndVerifyBlank(act, loc, before, budgets);
    return { status: "needs_review", after: noCommitAfter(cz), flag: "ai-eeo-failed", detail: "AI EEO call failed — " + ((res && res.error) || "no reply") + keptPrefillNote(cz), options: enabledTexts, auditLoc: loc.wrapperSel };
  }
  const ai = parseAiReply(res.text);
  const choseDecline = !!ai.choice && AI_EEO_DECLINE_RE.test(ai.choice);
  // Confidence gate: commit a demographic guess ONLY at high confidence; else fall back to the decline.
  let target = null, declined = false;
  if (choseDecline) { target = ai.choice; declined = true; }
  else if (ai.confidence === "high" && ai.choice) { target = ai.choice; }
  else if (declineOpt) { target = declineOpt; declined = true; } // low-confidence guess → override to decline
  if (!target) { // no confident guess + no decline option → can't safely fill
    const cz = await closeAndVerifyBlank(act, loc, before, budgets);
    return { status: "needs_review", after: noCommitAfter(cz), flag: "ai-eeo-undecided", detail: "AI could not confidently infer + no decline option" + (ai.choice ? " (low-confidence \"" + ai.choice + "\")" : "") + keptPrefillNote(cz), options: enabledTexts, auditLoc: loc.wrapperSel };
  }
  const m = apMatch.matchCandidates([target], enabledTexts);
  if (m.targetIndex === -1) {
    const cz = await closeAndVerifyBlank(act, loc, before, budgets);
    return { status: "needs_review", after: noCommitAfter(cz), flag: "ai-eeo-nomatch", detail: "AI EEO pick \"" + target + "\" not an option" + keptPrefillNote(cz), options: enabledTexts, auditLoc: loc.wrapperSel };
  }
  const opt = enabledTexts[m.targetIndex];
  await act.clickDropdownOptionByText(loc, opt);
  await act.delayFull(budgets.reopenSettleMs);
  let post = await act.readDropdownState(loc);
  let committed = post && norm(post.triggerText) === norm(opt);
  if (committed) { await act.delayFull(budgets.reopenSettleMs); post = await act.readDropdownState(loc); committed = post && norm(post.triggerText) === norm(opt); }
  if (!committed) return { status: "needs_review", after: post ? post.triggerText : null, flag: "ai-eeo-commit-failed", detail: "AI EEO chose \"" + opt + "\" but the commit did not persist", options: enabledTexts, auditLoc: loc.wrapperSel };
  if (declined) return { status: "filled_review", after: opt, verified: true, matchTier: m.matchTier, flag: "eeo_declined", detail: "AI declined to guess a required demographic → neutral \"" + opt + "\"", options: enabledTexts, auditLoc: loc.wrapperSel };
  return { status: "filled_review", after: opt, verified: true, matchTier: m.matchTier, flag: "ai-eeo-guess", confidence: ai.confidence, detail: "AI inferred a required demographic → \"" + opt + "\" (confident guess — VERIFY)", options: enabledTexts, auditLoc: loc.wrapperSel };
};

// AI-4 validation-error remediation DECISION (Tier 2). When Save & Continue stays blocked AFTER the
// deterministic anchor re-fill, feed the AI the error text(s) + the page's fields + repeating sections
// → ONE corrective action from a RESTRICTED set. The AI DECIDES here, never actuates — the SW loop
// executes through the SAME fill path / clickDeleteEntry (bounded, capped, never submit). Returns
// { action:"refill", field, value } | { action:"delete_entry", section, index } | { action:"none", reason }.
const aiRemediateError = async (act, errorTexts, pageState, budgets) => {
  const errs = (Array.isArray(errorTexts) ? errorTexts : []).filter(Boolean);
  const fields = (pageState && Array.isArray(pageState.fields)) ? pageState.fields : [];
  const sections = (pageState && pageState.sections) || null;
  const system = "A job-application page failed its \"Save & Continue\" with the validation error(s) below. "
    + "Decide ONE corrective action to clear the error, choosing ONLY from this restricted set:\n"
    + "1. {\"action\":\"refill\",\"field\":\"<exact fieldName>\",\"value\":\"<corrected value>\"} — set a named field to a corrected value (a wrong/invalid/missing value the error names).\n"
    + "2. {\"action\":\"delete_entry\",\"section\":\"<containerPrefix>\",\"index\":<0-based entry index>} — remove a duplicate/extra repeating-section entry (e.g. \"Duplicate ... entries are not allowed\").\n"
    + "3. {\"action\":\"none\",\"reason\":\"...\"} — if you cannot safely fix it from the information given.\n"
    + "Fix ONLY what the error explicitly names. NEVER invent unrelated data, never accept terms/consents, never submit. If unsure, choose \"none\".";
  const user = "Validation error(s): " + JSON.stringify(errs)
    + "\nPage fields (fieldName, label, widgetType, current value): "
    + JSON.stringify(fields.map((f) => ({ fieldName: f.fieldName, label: f.label, widgetType: f.widgetType, value: f.after != null ? f.after : (f.value != null ? f.value : null) })))
    + (sections ? "\nRepeating sections (containerPrefix → entry count): " + JSON.stringify(sections) : "")
    + "\n\nReply ONLY with a JSON object and nothing else (one of the three action shapes above).";
  const res = await act.llm({ system, user, maxTokens: 256 });
  if (!res || !res.ok) return { action: "none", reason: "AI call failed — " + ((res && res.error) || "no reply") };
  return parseRemediation(res.text);
};

// Parse + SANITIZE the remediation reply into a SAFE {action,...}. The restricted whitelist is
// enforced HERE, never trusted from the model — a hallucinated "submit"/"click"/free-form action
// can never escape this gate (everything unknown/malformed → {action:"none"}).
const parseRemediation = (text) => {
  let t = String(text == null ? "" : text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let obj = null;
  try { obj = JSON.parse(t); } catch (e) { const mm = t.match(/\{[\s\S]*\}/); if (mm) { try { obj = JSON.parse(mm[0]); } catch (e2) { /* best-effort */ } } }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { action: "none", reason: "unparseable remediation reply" };
  const action = String(obj.action == null ? "" : obj.action).trim().toLowerCase();
  if (action === "refill") {
    const field = String(obj.field == null ? "" : obj.field).trim();
    if (!field) return { action: "none", reason: "refill missing field" };
    return { action: "refill", field, value: obj.value == null ? "" : String(obj.value), reason: String(obj.reason || "").trim() };
  }
  if (action === "delete_entry") {
    const section = String(obj.section == null ? "" : obj.section).trim();
    const index = Number.isInteger(obj.index) ? obj.index : parseInt(obj.index, 10);
    if (!section || !Number.isInteger(index) || index < 0) return { action: "none", reason: "delete_entry missing section/index" };
    return { action: "delete_entry", section, index, reason: String(obj.reason || "").trim() };
  }
  return { action: "none", reason: String(obj.reason || (action ? "unknown action: " + action : "no action")).trim() };
};

// Close an OPENED dropdown and CONFIRM the portaled option LIST IS GONE before returning. The list
// OVERLAPS the next field, so a lingering list lets the NEXT field's open-click land on a stale option
// — the live degree→"Associates" / "Landline → Phone Device Type" cross-field stray (the next field
// sits exactly where a stale option rendered). GATE ON THE LISTBOX BEING GONE (`!listboxPresent ||
// optionCount === 0`), NOT aria-expanded: aria flips to "false" the instant Escape/commit fires, but
// the options linger a beat while they unmount and STAY CLICKABLE — returning on aria alone raced the
// close at fast (M39) pacing (this branch's dropdowns-don't-close-instantly report; matches the
// closeAndVerifyBlank listbox-gone gate). We poll readDropdownState until the options are gone,
// re-Escaping each round (real-time delayFull — the listbox closes at the page's pace), bounded by
// iterations so a stuck list can't spin. Returns true iff confirmed gone. Used by the successful
// COMMIT path, the commit-failed path, the tier-aware KEEP path, and the genuine-no-match path — every
// path that opened the list must confirm it's gone before the next field.
async function closeDropdownConfirmed(act, loc, budgets) {
  const stillOpen = (s) => !!(s && s.listboxPresent && s.optionCount > 0); // clickable options still mounted
  const maxTries = (budgets.openRetries || 3) + 1;
  let st = await act.readDropdownState(loc);
  for (let i = 0; i < maxTries && stillOpen(st); i++) {
    await act.pressEscape();
    await act.delayFull(budgets.commitIntervalMs);
    st = await act.readDropdownState(loc);
  }
  return !stillOpen(st);
}

// The dropdown OVERWRITE commit BEAT LADDER (ascending). Committing a re-selection needs the
// just-opened list past a Workday-internal option-click DEBOUNCE whose only lever is elapsed-time-
// since-open; a LONGER wait is strictly safer. We CANNOT reliably detect the true paint state: an
// OCCLUDED window (alt-tabbed behind another app) is throttled like hidden yet still reports
// `tab.active && !minimized`, so act.visible mislabels it "visible"; and the page's own
// visibilityState / rAF are spoofed / polyfilled by the hidden-tab overrides, so paint can't be read
// from the page either. So rather than trust the label, the commit ESCALATES through this ladder on
// each miss — the persistence re-read gates every accept, so escalation only ever costs extra re-opens,
// never a wrong fill. act.visible only picks the STARTING tiers (skip the tiny beats on a known-hidden
// tab); the full ~700ms tier is ALWAYS reachable, even when labeled visible (the alt-tab / occluded fix:
// a mislabeled tab self-corrects to the big beat instead of failing to needs_review). Every ladder ends
// with a FINAL ~5s safety tier (overwriteMaxBeatMs) so a deeply-throttled/occluded tab that even 700ms
// misses gets one last long attempt before needs_review. Ascending, deduped.
function overwriteBeatLadder(b, visible) {
  const ladder = visible
    ? [b.overwriteFastBeatVisibleMs, b.overwriteSlowBeatVisibleMs, b.overwriteSlowBeatMs, b.overwriteMaxBeatMs] // 30 → 100 → 700 → 5000
    : [b.overwriteFastBeatMs, b.overwriteSlowBeatMs, b.overwriteMaxBeatMs];                                     // 120 → 700 → 5000
  return ladder.filter((v, i) => typeof v === "number" && v > 0 && ladder.indexOf(v) === i).sort((x, y) => x - y);
}

// Dropdown: the Playwright pattern ported, commit = type-to-highlight +
// VERIFIED Enter (recon: a coordinate click on an out-of-view option dismisses
// the popup — the Uruguay failure; Enter on a verified highlight commits).
// The highlighted text MUST equal the matched target before Enter — never an
// unverified commit. Coordinate option-click survives only as a last resort,
// behind the same trigger-text verify gate.
const fillDropdownCdp = async (act, loc, candidates, budgets) => {
  const norm = apMatch.normalize;
  const delayRender = act.delayRender || act.delayFull; // STAGE 2: option-settle + commit-persistence intervals, adaptive under the measured-fast gate (fallback for older fakes)
  const pre = await act.readDropdownState(loc);
  const before = pre ? pre.triggerText : null;

  // TIER-AWARE KEEP guard (M36.1 parity for dropdowns — was priority-BLIND in M27.C,
  // which kept the pre-fill if it matched ANY candidate, so a LOWER-tier pre-fill blocked
  // the higher-priority choice; e.g. country ["Afghanistan","United States of America",
  // "United States"] left on "United States of America" was kept instead of upgrading to
  // tier-0 "Afghanistan"). Compute which TIER the pre-fill exact-matches (candidates are
  // most-specific first):
  //   preTierIndex === 0  → the dropdown already shows the TOP candidate → KEEP, ZERO
  //                         actuation (the common case — preserves the M27.C win of never
  //                         re-opening a cold 200+ list when nothing better is wanted).
  //   preTierIndex  >  0  → the form shows a lower-priority value than the profile prefers
  //                         → open + overwrite to the HIGHEST higher-priority tier the
  //                         dropdown offers (candidates.slice(0, preTierIndex)); if none is
  //                         offered, the pre-fill is the best available → keep it (the
  //                         no-match branch below). Re-opens the cold list ONLY when an
  //                         actual priority upgrade is possible.
  //   preTierIndex === -1 → no exact match (incl. the "Select One" placeholder) → walk the
  //                         FULL candidate list, as before.
  let overwriteCandidates = candidates;
  let preTierIndex = -1;
  if (before) {
    preTierIndex = candidates.findIndex((c) => norm(c) === norm(before));
    if (preTierIndex === 0) {
      return { status: "filled", after: before, verified: true, matchTier: "pre-filled", flag: "dropdown-prefilled-kept", confidence: "high", detail: "dropdown already shows the top candidate — kept (no actuation)" };
    }
    if (preTierIndex > 0) overwriteCandidates = candidates.slice(0, preTierIndex); // upgrade target = strictly higher-priority tiers only
  }

  // Open with a bounded, aria-expanded-GATED retry (M29 "retry the actuation until
  // it takes"). A fast-paced open-click can fire DURING the prior field's post-commit
  // React re-render and no-op — the trigger never expands, so no list ever appears;
  // the old single open then burned the full option ceiling and false-failed ("options
  // did not render"). STRICT TWO-GATE sequencing, with the INVARIANT that guards the
  // inverse bug: NEVER re-click a trigger already reading aria-expanded="true" — a
  // second click TOGGLES the open dropdown SHUT. So openDropdown is called ONLY while
  // not yet expanded (the for-loop's `!expanded` guard); once expanded we only poll.
  let state = null, expanded = false, openedAt = 0; // openedAt: when the list actually opened — the debounce window is measured from here (see the overwrite beat)
  for (let attempt = 1; attempt <= budgets.openRetries && !expanded; attempt++) {
    if (attempt > 1) { await act.pressEscape(); await act.delay(budgets.reopenSettleMs); } // close the half-state + let the re-render finish
    if (!(await act.openDropdown(loc))) continue; // trigger rect dead — re-open
    // GATE 1 (cheap): poll aria-expanded for a SHORT window. A real open expands
    // promptly; a raced no-op never does. Don't burn the option ceiling on a race.
    const expandDeadline = Date.now() + budgets.openExpandWindowMs;
    while (Date.now() < expandDeadline) {
      await act.delay(budgets.settleIntervalMs);
      state = await act.readDropdownState(loc);
      if (state && state.ariaExpanded === "true") { expanded = true; openedAt = Date.now(); break; }
    }
  }
  // GATE 2: the trigger IS expanded — NEVER re-click it. Poll optionCount to the FULL
  // ceiling (a cold lazy list renders after the expand). Settle = 2 equal non-zero reads.
  // STAGE 2 — delayRender (adaptive under the measured-fast gate, was NON-adaptive delayFull):
  // the historic hazard was a fast-scaled poll spanning only ~140ms concluding on an
  // INCOMPLETE render → a pick lands on a partial list, discarded on render-complete (the
  // false verified:true). That is now safe on two independent counts: (1) delayRender shrinks
  // the interval ONLY when timers MEASURE fast (worker-timers/visible), i.e. exactly when the
  // list renders in ~50ms so "2 reads ~70ms apart" both observe the COMPLETE list — a
  // throttled/network-cold list keeps the count at 0 (the n>0 gate) or full delayFull (measured
  // slow); and (2) even a premature settle is backstopped by the commit PERSISTENCE re-read
  // below (a discarded pick reverts → committedText fails → keeps polling → honest needs_review,
  // never a wrong/silent commit). The ceiling stays raw (full) so a genuinely slow list never
  // false-times-out. The openDeadline/ceiling are NOT routed through delayRender (stay full).
  if (expanded) {
    let prevCount = -1, stable = 0;
    const openDeadline = Date.now() + budgets.openCeilingMs;
    while (Date.now() < openDeadline) {
      const n = state ? state.optionCount : 0;
      if (n > 0 && n === prevCount) {
        stable++;
        if (stable >= budgets.stableReads - 1) break;
      } else {
        stable = 0;
      }
      prevCount = n;
      await delayRender(budgets.settleIntervalMs);
      state = await act.readDropdownState(loc);
    }
  }
  if (!state || state.optionCount === 0) {
    await act.pressEscape();
    return { status: "needs_review", detail: "options did not render (skipped_no_option_match)", after: before };
  }

  const enabledTexts = state.options.filter((o) => !o.disabled).map((o) => o.text);
  // DROPDOWN = select from a full list → NO containment (a substring match is a guess: "PA" must not
  // silently become "Armed Forces Pacific"). Exact → fuzzy(typo) → escalate to review. (2026-07-16)
  const m = apMatch.matchCandidates(overwriteCandidates, enabledTexts, { containment: false });
  if (m.targetIndex === -1) {
    // CLOSE-CONFIRMED before returning: the open list OVERLAPS the next field, so a lingering
    // list strays the next field's open-click (the live degree→"Associates" — the Field-of-Study
    // box sits over the degree list's "Associates"). Both the tier-keep and the genuine no-match
    // opened the list, so both must confirm it's gone (not a fire-and-return Escape).
    await closeDropdownConfirmed(act, loc, budgets);
    // Overwrite-upgrade miss (preTierIndex>0): the dropdown offers NONE of the higher-priority
    // tiers → the pre-fill IS the best the form has → KEEP it (filled, not needs_review — it's a
    // valid lower-tier candidate). (Typeahead parity: prefilled-better-tier-unavailable.)
    if (preTierIndex > 0) {
      // Honesty re-read: if the value strayed during the open/close window, surface the live
      // truth — NEVER report a false "kept <pre-fill>, verified" (the degree→"Associates" lesson).
      const back = await act.readDropdownState(loc);
      const liveAfter = back && back.triggerText != null ? back.triggerText : before;
      if (norm(liveAfter) !== norm(before)) {
        return { status: "needs_review", after: liveAfter, matchTier: "pre-filled", flag: "dropdown-prefilled-stray", detail: `pre-fill "${before}" STRAYED to "${liveAfter}" during the tier check — review`, options: enabledTexts };
      }
      return { status: "filled", after: before, verified: true, matchTier: "pre-filled", flag: "dropdown-prefilled-better-tier-unavailable", confidence: "high", detail: `kept pre-fill "${before}" — no higher-priority tier offered by the dropdown`, options: enabledTexts };
    }
    // GENUINE no-match: the option list RENDERED but no candidate is among it — i.e. this
    // value isn't offered (the only delete-worthy case for deleteOnNoMatch, M38 Bug B1).
    // The other needs_review/error returns (options-didn't-render / couldn't-open /
    // target-vanished / commit-didn't-take) are transient/infra failures, NOT invalid
    // data — they are NOT tagged, so deleteOnNoMatch keeps + surfaces them.
    return { status: "needs_review", detail: "no candidate matched", after: before, options: enabledTexts, genuineNoMatch: true };
  }
  const target = enabledTexts[m.targetIndex];
  // Verify gate TIGHTENED (M28): exact-normalize ONLY — a substring trigger can't false-pass.
  const committedText = (t) => t != null && norm(t) === norm(target);

  // Commit is TEXT-KEYED (M28): scroll the matched option into view and click it by
  // its text — deterministic regardless of the dropdown's STARTING selection, and
  // immune to scrape-order vs live-DOM-order drift (no index, no type-jump cycling,
  // no counted arrow-walk). The old type-jump+arrow-walk failed when the dropdown
  // already sat on a same-first-letter value (native type-ahead cycled to the NEXT
  // match) and on long lists (step cap), and worst it returned needs_review BEFORE
  // any click could run. Behind the SAME verify gate: filled only if the trigger
  // then shows the target exactly; otherwise needs_review (never a wrong commit).
  const commitByClick = async (clicker, ceilingMs) => {
    if (!(await clicker(loc, target))) {
      const cs = await act.readDropdownState(loc);
      return { ok: false, after: cs ? cs.triggerText : null };
    }
    let after = null;
    const deadline = Date.now() + (ceilingMs || budgets.commitCeilingMs); // ceilingMs: SHORT deadline for the fast overwrite attempt (fail quick → slow refill); full ceiling otherwise
    while (Date.now() < deadline) {
      await delayRender(budgets.commitIntervalMs); // the page commits the pick at its own pace — adaptive under the measured-fast gate (STAGE 2)
      const cs = await act.readDropdownState(loc);
      after = cs ? cs.triggerText : after;
      if (committedText(after)) {
        // PERSISTENCE (the false-verify guard): a pick made before the option list finished
        // rendering shows for an instant, then is DISCARDED on render-complete — that momentary
        // value is exactly what produced the false verified:true. Confirm the trigger STILL
        // shows the target after another beat before accepting; a revert keeps polling (→ honest
        // needs_review), never a silent wrong fill. This re-read is the interval-LENGTH-INDEPENDENT
        // gate that makes the adaptive delayRender safe: shrinking the beat only re-polls sooner —
        // acceptance still requires the target to PERSIST across the beat.
        await delayRender(budgets.commitIntervalMs);
        const cs2 = await act.readDropdownState(loc);
        const after2 = cs2 ? cs2.triggerText : null;
        if (committedText(after2)) return { ok: true, after: after2 };
        after = after2; // reverted — not committed; keep polling until the deadline
      }
    }
    return { ok: false, after };
  };

  // Backstop/log: a fresh read must still show the target present + enabled before
  // clicking (catches a vanished option / DOM drift). The index canary is non-fatal
  // — the click is text-keyed, so a scrape-vs-DOM order mismatch can't mis-click.
  const fresh = await act.readDropdownState(loc);
  const freshEnabled = fresh ? fresh.options.filter((o) => !o.disabled).map((o) => o.text) : [];
  if (!freshEnabled.some((t) => norm(t) === norm(target))) {
    await act.pressEscape();
    return { status: "needs_review", detail: `target "${target}" no longer in the open list — review`, after: before, options: enabledTexts, matchTier: m.matchTier };
  }
  const fullIdx = fresh.options.findIndex((o) => !o.disabled && norm(o.text) === norm(target));
  const idxCanary = (fresh.options[fullIdx] && norm(fresh.options[fullIdx].text) === norm(target)) ? "" : " [option-index desync vs scrape — text-keyed click used]";

  // OVERWRITE commit — FAST-FIRST with a slow refill fallback (2026-07-06). Committing a RE-SELECTION
  // (replacing a real prior value — e.g. pre-filled+flipped languages) needs the just-opened list past a
  // Workday-internal option-click DEBOUNCE: the click lands on the correct option but doesn't fire the
  // selection until the debounce elapses, and there is NO pollable DOM readiness signal (every signal is
  // settled from t=0), so the only lever is elapsed time since open. The debounce is a PAINT thing — tiny
  // when the tab is VISIBLE, ~700ms when HIDDEN — so the beats split on visibility (below). ATTEMPT 1 waits
  // only the fast beat then clicks; on a MISS, ATTEMPT 2 re-opens and pays the slow beat. A [CDP-DD-REFILL]
  // line logs whether each overwrite committed fast or needed the refill, for retuning. The commit-PERSISTENCE
  // re-read still gates every accept, so a fast miss can only cost a slow refill — never a wrong/silent fill.
  // EMPTY fills (`before` = the disabled placeholder) never race → single fast commit, no beat.
  const isOverwrite = !!before && norm(before) !== norm(target) && enabledTexts.some((t) => norm(t) === norm(before));
  // VISIBILITY split: the overwrite debounce is a PAINT thing — tiny visible, ~700ms hidden. Pick the beats
  // off REAL tab visibility (act.visible; absent on older fakes ⇒ treat as hidden = the safe/larger beats).
  const dropdownVisible = act.visible ? await act.visible() : false;
  // Escalating beat ladder (occlusion/alt-tab fix): try the smallest beat first, and on each MISS re-open
  // and wait the next-larger beat — up to the full ~700ms tier — REGARDLESS of the visibility label. A
  // painting tab commits on tier 0 (no penalty); a mislabeled/occluded/hidden tab self-corrects to the big
  // beat instead of failing (the old visible pair capped at 100ms → the alt-tab language-swap bug). The
  // commit-PERSISTENCE re-read gates every accept, so escalation only ever costs extra re-opens — never a
  // wrong/silent fill. EMPTY fills (placeholder → value) never race → single fast commit, no ladder.
  const beats = overwriteBeatLadder(budgets, dropdownVisible);
  let res = { ok: false, after: null }, committedTier = -1;
  if (isOverwrite) {
    let reAt = openedAt; // when the currently-open list opened; the beat is measured from here
    for (let tier = 0; tier < beats.length; tier++) {
      // Tier 0: the list is already open from the initial open (openedAt). Later tiers: the prior missed
      // click usually closed it → re-open and reset the beat clock (reAt) to the fresh open.
      let re = await act.readDropdownState(loc);
      if (!re || re.optionCount === 0) {
        reAt = 0;
        if (await act.openDropdown(loc)) {
          const d = Date.now() + Math.min(budgets.openCeilingMs, 8000);
          while (Date.now() < d) { await delayRender(budgets.settleIntervalMs); re = await act.readDropdownState(loc); if (re && re.optionCount > 0) { reAt = Date.now(); break; } } // re-open settle — adaptive under the measured-fast gate; gated by optionCount>0, interval-independent
        }
      }
      if (!re || re.optionCount === 0) break; // couldn't (re-)open → needs_review below
      if (act.delayFull && reAt) { const r = beats[tier] - (Date.now() - reAt); if (r > 0) await act.delayFull(r); } // this tier's beat SINCE the (re-)open, minus time already spent
      // Fail-fast on every tier BUT the last (so misses escalate quickly); the last tier gets the full ceiling.
      const ceiling = tier === beats.length - 1 ? budgets.commitCeilingMs : Math.min(budgets.overwriteFailFastMs, budgets.commitCeilingMs);
      res = await commitByClick(act.clickDropdownOptionByText, ceiling);
      if (res.ok) { committedTier = tier; break; }
    }
    console.log(`[ApplyPilot][CDP-DD-REFILL] "${before}"→"${target}" ${dropdownVisible ? "VISIBLE" : "hidden"} beats=[${beats.join(",")}]ms → ${committedTier === 0 ? "committed on tier 0 (fast)" : committedTier > 0 ? `escalated → committed on tier ${committedTier} (${beats[committedTier]}ms)` : "MISSED all tiers"}: ${res && res.ok ? `OK "${res.after}"` : `FAILED "${res && res.after}"`}`);
  } else {
    // EMPTY fill (placeholder → value): no debounce race — a single fast commit + the generic re-open retry.
    res = await commitByClick(act.clickDropdownOptionByText);
    if (!res.ok) {
      let re = await act.readDropdownState(loc);
      if (!re || re.optionCount === 0) {
        if (await act.openDropdown(loc)) {
          const d = Date.now() + Math.min(budgets.openCeilingMs, 8000);
          while (Date.now() < d) { await delayRender(budgets.settleIntervalMs); re = await act.readDropdownState(loc); if (re && re.optionCount > 0) break; } // re-open settle — adaptive under the measured-fast gate; gated by optionCount>0, interval-independent
        }
      }
      if (re && re.optionCount > 0) res = await commitByClick(act.clickDropdownOptionByText);
    }
  }
  if (res.ok) {
    // Don't return `filled` until the option LIST has UNMOUNTED — the commit closes it but a beat later,
    // and its options stay clickable meanwhile; returning early lets the next field's open-click stray onto
    // a lingering option (gate on options-gone, not aria — this branch's close-race report).
    await closeDropdownConfirmed(act, loc, budgets);
    const out = { status: "filled", after: res.after, verified: true, matchTier: m.matchTier, detail: `text-click-commit${idxCanary}`, options: enabledTexts };
    if (preTierIndex > 0) { out.flag = "dropdown-overwrite-success"; out.detail = `overwrote pre-fill "${before}" → "${res.after}" (higher-priority tier); text-click-commit${idxCanary}`; }
    return out;
  }
  await closeDropdownConfirmed(act, loc, budgets); // confirm the list is gone (not just aria) before the next field, even on a failed commit
  return { status: "needs_review", detail: `commit failed for "${target}" (trigger shows "${res.after}")`, after: res.after, options: enabledTexts, matchTier: m.matchTier };
};

// Radio: label-text exact match (case-insensitive, candidates in order — M22
// fillRadio), label-click primary, focus+Space fallback (both recon-proven),
// committed state verified by the checked read-back.
const fillRadioCdp = async (act, loc, candidates, budgets) => {
  const opts = await act.readRadioState(loc);
  if (!opts || opts.length === 0) return { status: "error", detail: "no radio inputs" };
  const optionLabels = opts.map((o) => o.labelText);
  const beforeOpt = opts.find((o) => o.checked);
  const before = beforeOpt ? beforeOpt.labelText : null;

  let target = null;
  for (const cand of candidates) {
    const found = opts.find((o) => o.labelText.toLowerCase() === String(cand).toLowerCase());
    if (found) { target = found; break; }
  }
  if (!target) return { status: "needs_review", detail: "no candidate matched radio labels", after: before, options: optionLabels };
  // SKIP-IF-CORRECT (minimal-diff replay): the correct option is already selected → leave it, zero
  // actuation. Inert on the normal fill path (radios start unselected, so beforeOpt is null there).
  if (budgets && budgets.skipIfCorrect && beforeOpt && beforeOpt.id === target.id) {
    return { status: "filled", after: before, verified: true, matchTier: "label-exact", flag: "replay-already-correct", detail: "already correct — left unchanged (no actuation)", options: optionLabels };
  }

  let pathUsed = "label-click";
  let committed = (await act.clickRadioLabel(loc, target.id)) && (await pollCheckedIs(act, target.id, true, budgets));
  if (!committed) {
    pathUsed = "focus+Space";
    if (await act.focusInput(target.id)) {
      await act.pressSpace();
      committed = await pollCheckedIs(act, target.id, true, budgets);
    }
  }
  const now = await act.readRadioState(loc);
  const checkedNow = now && now.find((o) => o.checked);
  const after = checkedNow ? checkedNow.labelText : null;
  if (!committed) return { status: "needs_review", detail: `radio selection did not commit (${pathUsed})`, after, options: optionLabels };
  return {
    status: "filled",
    after,
    verified: !!after && candidates.some((c) => String(c).toLowerCase() === after.toLowerCase()),
    matchTier: "label-exact",
    detail: pathUsed,
    options: optionLabels
  };
};

// AI-1 for REQUIRED RADIOS (the deferred required-radio fallback). A required radio the deterministic
// pass could not answer is left BLANK, which BLOCKS Save & Continue — so, exactly like the dropdown
// AI-1 (aiFillField), GUESS-to-reach-review rather than leave it empty: read the live labels → LLM
// INFERS the best option from the profile → the pick MUST clear the match ladder vs the live labels
// (never blind-commit arbitrary text) → commit via the proven fillRadioCdp (label-click → focus+Space →
// read-back) → ALWAYS filled_review, never silently trusted. candidateIsPreviousWorker is force-flagged
// sensitive: it sits next to a truthfulness certification (a wrong "Yes" is a false statement), so its
// guess renders LOUD (LEGALLY-LOADED), and a low-confidence guess auto-escalates to super-hard in the viewer.
const aiFillRadio = async (act, loc, f, profile, jobContext, budgets) => {
  const opts = await act.readRadioState(loc);
  if (!opts || opts.length === 0) return { status: "needs_review", after: null, flag: "ai-no-options", detail: "AI radio fallback: no radio inputs found (not actuated)", auditLoc: loc.wrapperSel };
  const optionLabels = opts.map((o) => o.labelText).filter(Boolean);
  const sensitive = legallyLoaded(f.label) || f.fieldName === "candidateIsPreviousWorker";
  const system = "You help an applicant fill out REQUIRED job-application screening questions. Given the applicant's profile (JSON), one question, and its exact answer options, choose the SINGLE best option. INFER from the profile even when it is not stated verbatim — e.g. work eligibility from citizenship/work_authorization, age from education/enrollment dates, whether they PREVIOUSLY WORKED at a company from their employment history, criminal/background answers from the ABSENCE of any such record. These questions are REQUIRED: always choose the most likely option, never refuse. Keep the justification SHORT — one terse phrase, about 12 words, no preamble or restating the answer — that NAMES your basis: the positive profile fact used, OR plainly that you are inferring from the ABSENCE of information (e.g. \"company not in employment history\"; absence-based answers are less certain, so say so). Give your confidence: High, Medium, or Low.";
  const user = "Question: " + String(f.label || "")
    + "\nAnswer options (choose exactly one; reply with its EXACT text): " + JSON.stringify(optionLabels)
    + "\nApplicant profile: " + JSON.stringify(profile)
    + "\nJob context: " + JSON.stringify(jobContext || {})
    + "\n\nReply ONLY with a JSON object and nothing else:\n{\"choice\":\"<exact option text>\",\"justification\":\"<short phrase, ~12 words, naming your basis>\",\"confidence\":\"High|Medium|Low\"}";
  const res = await act.llm({ system, user, maxTokens: 512 });
  if (!res || !res.ok) return { status: "needs_review", after: null, flag: "ai-call-failed", detail: "AI call failed — " + ((res && res.error) || "no reply"), options: optionLabels, auditLoc: loc.wrapperSel };
  const ai = parseAiReply(res.text);
  const conf = ai.confidence;
  // The AI's choice is a CANDIDATE — clear the match ladder vs the live labels. A paraphrase / refusal
  // won't match → needs_review (never blind-commit arbitrary text onto a truthfulness-adjacent field).
  const m = ai.choice ? apMatch.matchCandidates([ai.choice], optionLabels) : { targetIndex: -1, matchTier: null };
  if (m.targetIndex === -1) {
    return { status: "needs_review", after: null, flag: "ai-nomatch", confidence: conf,
      detail: "AI chose \"" + ai.choice + "\" — not one of the options" + (ai.justification ? " (" + ai.justification + ")" : ""),
      options: optionLabels, auditLoc: loc.wrapperSel };
  }
  const target = optionLabels[m.targetIndex];
  const hr = await fillRadioCdp(act, loc, [target], budgets); // proven commit: label-click → focus+Space → read-back verify
  if (!hr || hr.status !== "filled") {
    return { status: "needs_review", after: (hr && hr.after != null) ? hr.after : null, flag: "ai-commit-failed", confidence: conf,
      detail: "AI chose \"" + target + "\" but the radio did not commit (" + ((hr && hr.detail) || "no result") + ")",
      options: optionLabels, auditLoc: loc.wrapperSel };
  }
  // ALWAYS filled_review — an AI guess is never silently trusted; the human review gate is the safety.
  return { status: "filled_review", after: hr.after, verified: true, matchTier: m.matchTier,
    flag: sensitive ? "ai-choice-sensitive" : "ai-choice", confidence: conf,
    detail: "AI: " + (ai.justification || ("chose " + target)) + " → \"" + hr.after + "\"" + (sensitive ? " — LEGALLY-LOADED, verify" : ""),
    options: optionLabels, auditLoc: loc.wrapperSel };
};

// Checkbox: reconcile to the desired boolean (the M22 fillMappedEntry checkbox
// semantics) — label-click primary, focus+Space fallback, checked read-back.
const fillCheckboxCdp = async (act, loc, want, budgets) => {
  const st = await act.readCheckboxState(loc);
  if (!st || !st.inputId) return { status: "error", detail: "no checkbox input" };
  if (st.checked === want) return { status: "filled", after: String(st.checked), verified: true, detail: "already in desired state" };
  let pathUsed = "label-click";
  let ok = (await act.clickCheckboxLabel(loc)) && (await pollCheckedIs(act, st.inputId, want, budgets));
  if (!ok) {
    pathUsed = "focus+Space";
    if (await act.focusInput(st.inputId)) {
      await act.pressSpace();
      ok = await pollCheckedIs(act, st.inputId, want, budgets);
    }
  }
  const cur = await act.readChecked(st.inputId);
  if (!ok) return { status: "needs_review", detail: `checkbox did not reconcile to ${want} (${pathUsed})`, after: String(cur), verified: false };
  return { status: "filled", after: String(cur), verified: cur === want, detail: pathUsed };
};

// Typeahead — the M25 CDP port of the PROVEN Magna brain (spec:
// ~/.claude/plans/zany-shimmying-puzzle.md; recon 2026-06-12, hidden). Rules,
// preserved exactly — this field type silently FALSE-FILLED before:
//   • per-candidate tier walk; match ONLY the current candidate (full-list
//     contamination was the original bug);
//   • transition-aware settle — the pre-filter fallback list is STABLE, so
//     mere stability is never terminal; the set must CHANGE since this
//     candidate's filter-Enter (sawChange), and a STALE banner from the prior
//     candidate survives clearing the input (recon), so banner is terminal
//     only after sawChange too;
//   • banner ("No matches found", [data-automation-id="promptTitle"]) = HARD
//     BLOCK — the fallback full list stays rendered underneath it; never pick
//     from it;
//   • commit gate: a single exact match AUTO-COMMITS on the filter-Enter; a
//     multi-match commits via a second Enter ONLY when the candidate's match
//     is the auto-highlighted FIRST option (targetIndex===0 —
//     aria-activedescendant is unreadable on this widget, so no highlight
//     reads, no arrow navigation);
//   • the ONLY commit signal is the selectedItem CHIP whose normalized text
//     equals the matched option — no option-text fallback, ever;
//   • first verified commit wins; anything less → needs_review with the
//     settle trace, never a silent or false fill.
// The listbox + searchBox self-unmount after a trusted commit (recon (f)) —
// no close workaround needed.
const fillTypeaheadCdp = async (act, loc, candidates, budgets, opts = {}) => {
  const norm = apMatch.normalize;
  const pre = await act.readHier(loc);
  if (!pre) return { status: "error", detail: "typeahead wrapper not found" };

  // Pre-filled guard — TIER-AWARE (M36.1). countryPhoneCode is auto-derived by
  // Workday from Country, so an already-correct chip is the COMMON case. Find the
  // pre-fill's matched TIER (the first candidate it exact-normalize-matches):
  //   • tier 0  → the pre-fill is already the most-specific choice → KEEP, ZERO
  //     actuation (countryPhoneCode: its chip normalize-equals candidates[0] —
  //     `normalize()` strips the (+1) suffix, so it's tier 0 even when the rendered
  //     chip carries it). Re-typing a correct value is the duplicate/clear failure mode.
  //   • tier k>0 → a LOWER tier is showing but the profile prioritizes higher ones →
  //     try to UPGRADE: walk ONLY the higher tiers (candidates.slice(0,k), priority
  //     order) and overwrite to the BEST the form offers; if none is offered, the
  //     walk-end keeps the pre-fill (prefilled-better-tier-unavailable). NOT
  //     zero-actuation — it searches every higher tier.
  //   • tier -1 (no candidate matches the pre-fill) → genuine mismatch → full
  //     overwrite walk (M27 Commit B): non-destructive, REPLACE-on-commit, a no-match
  //     leaves the original intact.
  const priorChips = pre.chips.slice();
  const preTierIndex = priorChips.length
    ? candidates.findIndex((cand) => priorChips.some((c) => norm(c) === norm(cand)))
    : -1;
  if (preTierIndex === 0) {
    return { status: "filled", after: priorChips.join("; "), verified: true, matchTier: "pre-filled", flag: "prefilled-kept", confidence: "high", detail: "pre-filled chip is already the top candidate — kept (no actuation)" };
  }
  const overwriteCandidates = preTierIndex > 0 ? candidates.slice(0, preTierIndex) : candidates;
  const isOverwrite = priorChips.length > 0;          // a pre-fill we're trying to replace/upgrade (tier-0 KEEP already returned)
  const chipSetIsNew = (chips) => chips.length > 0 && chipSetChanged(priorChips, chips);
  const withOverwrite = (ret, refilled) => { if (isOverwrite) ret.overwrite = { original: priorChips.join("; "), refilled: !!refilled }; return ret; };

  // Ensure the searchBox is present + focused. The widget loses searchBox focus
  // after a "No matches found" banner (recon 2026-06-12: a candidate after a
  // banner found focus on the PAGE — a Ctrl+A selected the whole document, the
  // typed query never landed, and the bare Enter committed the listbox's
  // highlighted row). So focus is re-asserted BEFORE every candidate, not just
  // at open. Returns the focused state, or null if focus can't be confirmed —
  // in which case the caller MUST NOT actuate (no blind clear/type/Enter).
  const ensureSearchFocused = async () => {
    // Bounded open+focus retry (M29). A fast-paced open can race the prior field's
    // post-commit re-render so the searchBox isn't focusable on the first try (the
    // live "could not focus" — it worked on the slow/hidden path). Re-attempt.
    // INVARIANT (the toggle-shut analog): openTypeahead is called ONLY when the
    // searchBox is NOT present/visible — never re-open an already-open search.
    // Returns the focused state, or null after exhausting attempts → the caller
    // MUST NOT actuate (no blind clear/type/Enter).
    for (let attempt = 1; attempt <= budgets.taOpenRetries; attempt++) {
      let st = await act.readHier(loc);
      if (!st || !st.searchBox.present || !st.searchBox.visible) {
        if (!(await act.openHier(loc))) { await act.delay(budgets.reopenSettleMs); continue; } // unmounted — re-open
        const t0 = Date.now();
        while (Date.now() - t0 < budgets.taOpenCeilingMs) {
          await act.delay(budgets.taOpenIntervalMs);
          st = await act.readHier(loc);
          if (st && st.searchBox.visible) break;
        }
      }
      if (st && st.searchBox.visible && !st.searchBox.focused) {
        await act.focusHierSearch(loc); // already-visible search → focus only, never re-open
        st = await act.readHier(loc);
      }
      if (st && st.searchBox.focused) return st;
      await act.delay(budgets.reopenSettleMs); // let a racing re-render settle, then retry
    }
    return null;
  };

  const trace = [];
  let lastFiltered = null;
  let capturedFull = null; // the FULL option list from onCapture (for the inline AI rescue) — see opts.ai
  // M30 liveness (source): did the options EVER render during the walk? If they never load (leafCount stays 0,
  // no chip) the server didn't return them — the dead-session tell. Surfaced on the walk-end no-commit return
  // for drivePageFill's session warning (only meaningful for the source field; harmless for cert/FoS).
  let optionsEverLoaded = false;
  let s = null;
  // FoS capture (single-open, operator's corrected design): scrape the FULL option list BEFORE the
  // candidate loop, so the loop's ensureSearchFocused() — the LAST focus action immediately before
  // clear/type — erases any focus disruption the scrape caused. LOAD-BEARING: nothing that can drop
  // focus (no settle, no read, no delay) sits between the scrape and the loop's ensureSearchFocused
  // (only the pure-JS loop entry below), NOR between that ensureSearchFocused and typeInSearch (only
  // the intended clearSearch + pollSearchValue). The scrape leaves the dropdown OPEN; the loop
  // re-focuses the already-open field. NO settle/type AFTER the scrape here. (The abandoned
  // capture-first put this INSIDE the loop with a settle + a 2nd re-assert between the re-assert and
  // the type → the async blur landed in that gap → the then-live keptLowerTier re-commit strayed.
  // This puts the scrape entirely BEFORE the loop's single re-assert. (The re-commit itself was later
  // retired — keptLowerTier now Tab-closes in overwriteNoMatchResting, 2026-07-02.)
  if (opts.onCapture) {
    await act.openHier(loc);
    await awaitListStable(act, (l) => act.readHier(l), loc, budgets); // wait for the OPEN list to render+stabilize (shorter taOpenCeilingMs) before scraping — never a mid-render scrape
    capturedFull = await opts.onCapture();        // scroll-scrape → returns + records options (read-only); leaves the dropdown OPEN
  }
  for (const [ci, cand] of overwriteCandidates.entries()) {
    const step = { candidate: cand };
    trace.push(step);
    // BETWEEN CANDIDATES: a prior no-match leaves a throttle-LAGGED empty-results re-render still landing (a
    // non-zero fallback list while the "No matches found" banner is pending). Clearing/typing the NEXT
    // candidate into that mid-render state races the focus drop (the live "half-typed oth" + armed-row stray).
    // awaitListTerminal BLOCKS until the prior candidate reaches a terminal state (its banner / autocommit)
    // before we re-focus + clear — never a bannerless list. Resolves on the banner (fast on Magna); a "timeout"
    // here on a no-match tier is the latency smell to flag. Skipped for the first candidate.
    if (ci > 0) step.priorSettle = await awaitListTerminal(act, (l) => act.readHier(l), loc, budgets, chipSetIsNew);
    // Focus hygiene: re-assert (recover) focus before touching the field. If it
    // can't be confirmed, STOP — never blind Ctrl+A / type / Enter (that is the
    // exact path that committed a stray "Afghanistan" via the listbox highlight).
    if (!(await ensureSearchFocused())) {
      step.note = "could not focus search field — not actuating blind";
      await act.pressTab(); // BLUR before leaving: a prior candidate's no-match ARMED row-0 (e.g. "Accounting"); Tab abandons it so the next field's focus can't blur-commit the stray
      return { status: "needs_review", after: null, verified: false, detail: "could not focus the search field — not actuating blind (no clear/type/Enter)", settle_trace: trace };
    }
    // FIRST-OPEN RENDER GATE (the open-race fix): ensureSearchFocused above returns the moment the searchBox is
    // merely visible+focused, but the freshly-opened OPTION LIST is still rendering. Typing into that mid-render
    // state races the filter (the typed query can be dropped/misfiltered) AND the list's render can steal focus
    // off the box. So on the first candidate of a freshly-opened widget, BLOCK until the open list renders +
    // stabilizes (awaitListStable — the same gate the onCapture scrape uses), then RE-ASSERT focus (the render
    // may have blurred it) before the clear/type. Skipped when:
    //   • ci > 0 — the between-candidates awaitListTerminal already left a known terminal render state; and
    //   • opts.onCapture — the pre-loop open+awaitListStable+scrape already rendered the list and left it open.
    if (ci === 0 && !opts.onCapture) {
      await awaitListStable(act, (l) => act.readHier(l), loc, budgets);
      if (!(await ensureSearchFocused())) {
        step.note = "could not re-focus after the open list rendered — not actuating blind";
        await act.pressTab(); // BLUR before leaving (lockstep with the focus-fail bail above)
        return { status: "needs_review", after: null, verified: false, detail: "could not re-focus the search field after the open list rendered — not actuating blind", settle_trace: trace };
      }
    }
    // FOCUS-SAFE clear + type (structurally closed, same bail as the recommit): clearSearch is FOCUS-BLIND, and
    // a mid-type focus drop truncates the query → the filter-Enter then commits the armed listbox row (the
    // stray). So re-verify focus after the clear and ECHO-VERIFY the FULL candidate landed (pollSearchValue)
    // BEFORE the filter-Enter; on a blur/partial, re-focus + re-clear + re-type (bounded). NEVER pressEnter on
    // a partial/unfocused box. (The settle above makes a mid-type drop rare; this makes the loop closed, not
    // just probabilistically safe.)
    let snap = null, snapSig = null, landed = false;
    for (let attempt = 1; attempt <= budgets.taOpenRetries && !landed; attempt++) {
      if (attempt > 1 && !(await ensureSearchFocused())) break; // re-assert focus on retry (blur after a prior clear/type)
      await act.clearHierSearch();
      await pollSearchValue(act, () => act.readHier(loc), "", budgets); // the clear has LANDED in the input before snapshot
      snap = await act.readHier(loc);
      if (!(snap && snap.searchBox && snap.searchBox.focused)) continue; // blur after the clear → re-loop
      snapSig = snap.pageWide.sig;
      step.staleBannerAtStart = !!(snap && snap.banner);
      await act.typeInHier(cand);
      landed = await pollSearchValue(act, () => act.readHier(loc), cand, budgets); // FULL candidate echoed in the FOCUSED box?
    }
    if (!landed) {
      step.note = "could not type the full candidate into a focused box (partial/blur) — not pressing Enter";
      await act.pressTab(); // BLUR before leaving: an armed row from a prior/partial filter must not survive to the next field
      return { status: "needs_review", after: null, verified: false, detail: "could not type the candidate into a focused search box (partial/unfocused) — not actuating Enter blind", settle_trace: trace };
    }
    await act.pressEnter(); // the filter-Enter (the ONLY filter trigger on this widget)

    // RENDER GATE (the core fix): block until the list reaches a CONFIRMED terminal render state — banner or
    // autocommit, NEVER a bannerless list — before reading/matching/committing. A bannerless non-zero list is
    // the fallback-before-the-banner; matching it commits the armed row (the stray). The focus-safe type loop
    // above is the focus guard; this is the render guard.
    const tSettle = Date.now();
    const outcome = await awaitListTerminal(act, (l) => act.readHier(l), loc, budgets, chipSetIsNew);
    s = await act.readHier(loc); // fresh snapshot at the SETTLED terminal (stable → consistent re-read)
    if (s && (s.leafCount > 0 || (s.chips && s.chips.length))) optionsEverLoaded = true; // M30 source liveness
    step.outcome = outcome;
    step.settleMs = Date.now() - tSettle;
    step.count = s ? s.pageWide.count : null;
    step.banner = !!(s && s.banner);               // "No matches found"
    step.resultsBanner = !!(s && s.resultsBanner); // "Search Results"
    step.open = !!(s && s.searchBox && s.searchBox.visible);
    step.chips = (s && s.chips && s.chips.length) ? s.chips.join("; ") : null;

    if (outcome === "autocommit") {
      // An auto-commit fired on the filter-Enter: a NEW chip (vs priorChips), OR the dropdown CLOSED holding a
      // chip (closedCommit — the CPP case, chip EQUALS the pre-fill). Classify the chip by its match tier vs
      // THIS candidate (M27 commitOutcome): exact → filled; containment/fuzzy → filled_review + soft flag; no
      // match → needs_review (the stray, e.g. a "Canada" chip for a US query). Walk stops either way. `unchanged`
      // = closedCommit whose chip equals the prior value (NO new value, but it still satisfies the candidate) →
      // KEPT provenance, NOT "overwrote". No disarm needed (already closed/committed — no armed highlight).
      // closedCommit re-derived from the snapshot (awaitListTerminal conflates the two autocommit shapes): the
      // box CLOSED holding a chip that is NOT a new chip (it equals the pre-fill — the CPP case). A NEW chip is
      // an "enter-auto-commit" even if the box also closed, so closedCommit REQUIRES !chipSetIsNew.
      const closedCommit = !!(s && s.searchBox && !s.searchBox.visible && s.chips && s.chips.length && !chipSetIsNew(s.chips));
      step.chip = s.chips.join("; ");
      const cm = apMatch.matchCandidates([cand], s.chips);
      const unchanged = closedCommit && isOverwrite && apMatch.normalize(step.chip) === apMatch.normalize(priorChips.join("; "));
      const oc = commitOutcome(unchanged ? false : isOverwrite, "auto", cm.matchTier);
      const mt = closedCommit ? "closed-commit" : "enter-auto-commit";
      step.flag = oc.flag;
      if (oc.status === "needs_review") {
        // kept original (unchanged) → overwrite-nomatch-original-kept (NOT a "stray" — nothing strayed, the
        // field holds its original value); changed overwrite → overwrite-stray; empty-field → autocommit-stray.
        const flag = unchanged ? "overwrite-nomatch-original-kept" : oc.flag;
        step.flag = flag;
        const d = unchanged
          ? `kept pre-fill "${priorChips.join("; ")}" (autocommitted + closed) but it matches no candidate — review`
          : isOverwrite
          ? `overwrote pre-fill "${priorChips.join("; ")}" but the auto-commit chip "${step.chip}" matches no candidate — ${oc.flag}, walk stopped`
          : `auto-commit chip "${step.chip}" does not match candidate "${cand}" — flagged (${oc.flag}), walk stopped`;
        return withOverwrite({ status: "needs_review", after: step.chip, verified: false, matchTier: mt, flag, confidence: oc.confidence, detail: d, settle_trace: trace }, false);
      }
      // Defensive single-chip assertion (recon = REPLACE → 1 chip). A residual
      // second chip means a tenant ADDED — never silently accept a two-value state.
      if (isOverwrite && s.chips.length > 1) {
        return withOverwrite({ status: "needs_review", after: step.chip, verified: false, matchTier: mt, flag: "overwrite-residual-flagged", confidence: "none", detail: `overwrite left ${s.chips.length} chips (expected single REPLACE) — review`, settle_trace: trace }, true);
      }
      const prov = unchanged ? `kept pre-fill "${priorChips.join("; ")}" (matches candidate "${cand}" via ${cm.matchTier}) → ` : isOverwrite ? `overwrote "${priorChips.join("; ")}" → ` : "";
      return withOverwrite({ status: oc.status, after: step.chip, verified: true, matchTier: mt, flag: oc.flag, confidence: oc.confidence, detail: `${prov}${closedCommit ? "autocommit-closed" : "auto-committed"} on the filter-Enter (candidate "${cand}", ${oc.flag})`, settle_trace: trace }, true);
    }
    if (outcome === "nomatch") { step.note = "no-match terminal (\"No matches found\" banner + stable) — hard block, next candidate"; continue; }
    if (outcome !== "results") { step.note = "no terminal results within budget (timeout) — treated as no-match"; continue; } // timeout → no-match
    // outcome === "results": "Search Results" banner + stable non-zero count — NOW safe to read + match.

    const texts = s.pageWide.texts;
    lastFiltered = texts;
    step.filteredCount = s.pageWide.count;
    // DIRECTED pick (Workday showed a LIST and did NOT autocommit) → NO containment: us clicking the one
    // filtered option that merely CONTAINS what we typed is a self-made GUESS. Exact/typo only; else the
    // candidate escalates (→ next candidate → the inline AI rescue for a required field, else review). The
    // AUTOCOMMIT branch above KEEPS containment — there Workday itself resolved the input, which we trust.
    const m = apMatch.matchCandidates([cand], texts, { containment: false });
    if (m.targetIndex !== -1) step.match = { targetIndex: m.targetIndex, matchTier: m.matchTier };
    if (m.targetIndex === -1) { step.note = "candidate not in its own filtered set"; continue; }

    // Commit = VIEWPORT-AWARE click-by-label of the matched leaf (act.clickHierLeaf scrolls an off-fold leaf
    // into the clickable viewport, matches by data-automation-label||text → the FIRST DOM node). NO index-0
    // gate and NO commit-Enter (the old typeahead ladder): under CDP-injected typing the widget never arms a
    // row highlight (recon), so a second Enter is a no-op; the filter-Enter only AUTO-commits a UNIQUE match
    // (the "autocommit" terminal above handles that). A MULTI-match — e.g. two "Other" leaves across sub-trees
    // — does NOT auto-commit → we click the FIRST matching leaf: matchCandidates' exact tier already resolves a
    // duplicate label to its first index, and clickHierLeaf then hits the first DOM node with that label
    // ("pick the first if it matches"). Verify (lockstep source-style) via the matched leaf's promptLeafNode
    // isselected flip OR a chip == the matched option; a chip that is a DIFFERENT value is a stray (flagged).
    const matchedOption = texts[m.targetIndex];
    step.matchedOption = matchedOption;
    const verifyCommitted = async () => {
      let probe = null; try { probe = await act.probeHierLeaf(matchedOption); } catch (e) {}
      const leafSelected = !!(probe && probe.commitWrapper && probe.commitWrapper.isSelectedValue === "true");
      const st = await act.readHier(loc);
      const chips = st ? st.chips : [];
      const chipMatch = chips.some((c) => norm(c) === norm(matchedOption));
      return { committed: leafSelected || chipMatch, via: chipMatch ? "selectedItem-chip" : "promptLeafNode-isselected", chips };
    };
    let committed = false, via = null, vc = null;
    if (await act.clickHierLeaf(loc, matchedOption)) {
      const d0 = Date.now();
      while (Date.now() - d0 < budgets.commitCeilingMs) {
        await act.delay(budgets.commitIntervalMs);
        vc = await verifyCommitted();
        if (vc.committed) { committed = true; via = vc.via; break; }
      }
    }
    step.commitPath = committed ? "click-commit" : null;
    step.chip = vc && vc.chips.length ? vc.chips.join("; ") : null;
    if (committed) {
      // Directed commit verified. Grade by the candidate→option tier `m.matchTier` (M27): exact → filled;
      // containment/fuzzy → filled_review + flag. Under overwrite → overwrite-success + provenance.
      const oc = commitOutcome(isOverwrite, "directed", m.matchTier);
      step.flag = oc.flag;
      const finalChips = vc ? vc.chips : [];
      if (isOverwrite && finalChips.length > 1) {
        return withOverwrite({ status: "needs_review", after: step.chip, verified: false, matchTier: "click-commit", flag: "overwrite-residual-flagged", confidence: "none", detail: `overwrite left ${finalChips.length} chips (expected single REPLACE) — review`, captured_options: texts, settle_trace: trace }, true);
      }
      const prov = isOverwrite ? `overwrote "${priorChips.join("; ")}" → ` : "";
      return withOverwrite({ status: oc.status, after: step.chip || matchedOption, verified: true, matchTier: "click-commit", flag: oc.flag, confidence: oc.confidence, detail: `${prov}click-commit on "${matchedOption}" (verified via ${via}, ${m.matchTier})`, captured_options: texts, settle_trace: trace }, true);
    }
    // A chip exists but isn't the matched option — a stray: overwrite → overwrite-stray (a different value
    // replaced the original); empty field → directed-mismatch. Surfaced for review, never a silent fill.
    const strayChips = (vc && vc.chips && vc.chips.length) ? vc.chips : [];
    if (strayChips.length && !strayChips.some((c) => norm(c) === norm(matchedOption))) {
      return withOverwrite({ status: "needs_review", after: strayChips.join("; "), verified: false, matchTier: "click-commit", flag: isOverwrite ? "overwrite-stray" : "directed-mismatch", confidence: "none", detail: `chip "${strayChips.join("; ")}" does not match "${matchedOption}" — flagged, walk stopped`, captured_options: texts, settle_trace: trace }, false);
    }
    step.note = "matched leaf but commit did not verify (no isselected flip / chip)";
  }

  // INLINE AI RESCUE (Option B) — the walk exhausted (genuine no-match). If the call site supplied
  // opts.ai (AI eligible: not cert, EEO allowed) and AI is ON, hand the captured option list + profile to
  // the LLM and commit its pick ON THE OPEN FIELD — no Tab-abandon, no defer to an end-of-page pass.
  // aiTypeaheadFallback re-enters fillTypeaheadCdp(loc,[target]) WITHOUT opts.ai (the re-entry is a fresh
  // 4-arg call → opts.ai undefined → no recursion); the field is still open, so that re-entry REUSES it
  // (ensureSearchFocused re-asserts focus on the post-banner box — the proven recommit machinery). Returns
  // the AI result (committed → filled_review, or an honest needs_review after a clean Tab). null ⇒ AI off /
  // no context / nothing to evaluate ⇒ the caller falls through to the existing Tab-exit (unchanged).
  const tryInlineAi = async () => {
    if (!(opts.ai && act.aiEnabled)) return null;
    // TREE vs FLAT. A hierarchical picker — source (the sourceTree flag) OR any field whose open no-match view
    // shows CATEGORY rows (cert / generic) — is DRILLED by the ONE unified tree drill (CLICK the category →
    // scrape its leaves → TYPE the chosen leaf): typing a category filters to NOTHING, so it must be clicked.
    // A flat typeahead (FoS) uses the single-prompt flat fallback. readTreeCategories reads the STALE no-match
    // view (NO clear — the no-match falls back to the on-open list + banner, so a tree's category rows are
    // visible there); clearing wouldn't restore the on-open view anyway and is focus-blind.
    let isTree = !!opts.ai.sourceTree;
    if (!isTree && act.readTreeCategories) { try { isTree = (await act.readTreeCategories(loc)).length > 0; } catch (e) { isTree = false; } }
    if (isTree) {
      // capturedFull = the Fix 2 START-scraped CATEGORIES for a tree (else aiTreeDrillFallback self-scrapes). The
      // drill commits on the open field (a commit closes it; a fail returns an honest needs_review) — no extra Tab;
      // it tags ai-choice / ai-eeo-guess (EEO) itself.
      // `candidates` = the field's STATED answer → the drill MATCHES it (typo-tolerant) instead of inferring from
      // the whole profile (the "Otherrr → Carnegie Mellon" fix).
      const aiRes = await aiTreeDrillFallback(act, loc, opts.ai, budgets, capturedFull, candidates);
      return (aiRes && aiRes.status) ? aiRes : null;
    }
    // FLAT: the full option list is the Fix 2 onCapture START-scrape (capturedFull) — a flat typeahead is now
    // ALWAYS start-scraped, so there is NO scrape after the deterministic fill fails (the operator's ask). The
    // last filtered set is the only fallback (e.g. a start-scrape that returned nothing). statedAnswer =
    // `candidates` → the AI MATCHES it (typo-tolerant) instead of inferring from the whole profile.
    const rec = {
      auditLoc: loc.wrapperSel, widgetType: "typeahead",
      options: (capturedFull && capturedFull.length) ? capturedFull : (lastFiltered || []),
      captured_options: lastFiltered || undefined,
      statedAnswer: candidates,
      isRequired: !!opts.ai.isRequired, label: opts.ai.label, fieldName: opts.ai.fieldName
    };
    const aiRes = await aiTypeaheadFallback(act, rec, opts.ai.profile, opts.ai.jobContext, budgets);
    if (!aiRes || !aiRes.status) return null; // "no options to evaluate" → fall through to the normal no-match exit
    if (aiRes.status === "filled_review" && isEeoField(rec)) aiRes.flag = "ai-eeo-guess"; // EEO retraction: demographic badge
    // Clean exit if the AI did NOT commit (decline / failure leaves the field open on the failed query).
    try { const st = await act.readHier(loc); if (st && st.searchBox && st.searchBox.visible) await act.pressTab(); } catch (e) { /* best-effort */ }
    return aiRes;
  };

  // Walk exhausted. Under OVERWRITE the original chip is intact (non-destructive —
  // we never deleted it): rest the field clean ({chips:[original], query:""}) and
  // flag overwrite-nomatch-original-kept (future-AI candidate).
  if (isOverwrite) {
    // keptLowerTier (preTierIndex > 0) NEVER goes to the AI: the kept chip EXACT-matches a lower
    // PROFILE tier — a STATED value, there is nothing to rescue. Without this gate the AI re-picked
    // the very value the field already held and re-flagged it ai-choice/filled_review (live
    // 2026-07-02: FoS pre-filled "Electrical Engineering" = tier 1; the tier-0-only upgrade walk
    // no-matched → AI). The deterministic keep below (Tab-close → filled/
    // prefilled-better-tier-unavailable) is the correct outcome. The AI rescue exists for the
    // MISMATCHED pre-fill (preTierIndex === -1), where the kept chip is NOT a profile value.
    const aiR = preTierIndex > 0 ? null : await tryInlineAi();
    // Return the AI's record ONLY when it carries a real outcome (a commit, or an honest non-null
    // after). A FAILED rescue (needs_review, after:null) must NOT mask the kept original — the live
    // "summary showed nothing while the page held 'Other'" bug: the field still holds the
    // previously-committed chip, and the resting honesty read below is what reports it. The AI's
    // failure detail is carried onto that record so the whole story survives.
    if (aiR && !(aiR.status === "needs_review" && aiR.after == null)) return aiR;
    // keptLowerTier + plain no-match both rest via the SAME Tab-close inside overwriteNoMatchResting
    // (the affirmative re-type/re-commit was retired 2026-07-02 — the value is already correctly
    // committed; Tab abandons the armed row without committing, and the post-Tab chip read is the
    // stray-backstop). ~4 fewer round-trips per keptLowerTier field.
    const rest = await overwriteNoMatchResting(act, loc, (l) => act.readHier(l), priorChips, trace, lastFiltered, budgets, preTierIndex > 0);
    if (aiR) {
      // The page ended BLANK → the AI's failure record is the honest one (its ai-* flag drives the
      // review reason + the delete-sweep's unconfident-AI rule) — carry the resting detail along.
      if (rest.after == null) { aiR.detail = (aiR.detail ? aiR.detail + " | " : "") + (rest.detail || "walk exhausted, field blank"); return aiR; }
      // The page HOLDS a value (the kept original) → the resting record is the honest one.
      rest.detail = (rest.detail ? rest.detail + " | " : "") + "AI rescue failed: " + (aiR.detail || aiR.flag || "no commit");
    }
    return rest;
  }
  // INLINE AI RESCUE (Option B) — empty-field genuine no-match: try the AI on the OPEN field BEFORE the
  // Tab-exit (same as the overwrite branch above). null ⇒ AI off / no context ⇒ the existing Tab honesty
  // read runs unchanged. Same failed-rescue rule as the overwrite branch: a needs_review/after:null AI
  // record must not pre-empt the honesty read (a late/stray chip would go unreported).
  const aiR = await tryInlineAi();
  if (aiR && !(aiR.status === "needs_review" && aiR.after == null)) return aiR;
  // Empty-field honesty read: exit via TAB (the only clean non-committing exit — Escape kept
  // focus + the armed row so the next field's focus blur-committed the stray), then read the
  // resting chips so the record NEVER reports after:null when the page physically holds a value —
  // catches a late/stray commit our settle missed (e.g. a highlight-Enter that landed after we
  // moved on). A committed chip (selectedItem) survives the blur, so this reflects the true settled
  // state; an uncommanded chip is flagged for review.
  const endChips = await tabBlurExit(act, loc, (l) => act.readHier(l));
  const strayChip = endChips && endChips.length ? endChips.join("; ") : null;
  if (strayChip) {
    // The page HOLDS a value (a prior commit / late stray) → report IT — the "summary showed nothing
    // while the page held 'Other'" bug: a failed AI record (after:null) must never mask a live chip.
    const aiNote = aiR && (aiR.detail || aiR.flag) ? " | AI rescue failed: " + (aiR.detail || aiR.flag) : "";
    return { status: "needs_review", after: strayChip, verified: false, detail: "uncommanded value on the field — review (no candidate matched; chip overwrite is a later milestone)" + aiNote, captured_options: lastFiltered || undefined, settle_trace: trace };
  }
  // Page genuinely BLANK → a failed AI record is the honest one (its ai-* flag drives the review
  // reason + the delete-sweep's unconfident-AI rule).
  if (aiR) return aiR;
  // M38 Bug B1 — GENUINE no-match (for deleteOnNoMatch) ONLY if EVERY candidate gave a
  // definitive negative: a "No matches" banner, or filtered-but-absent (no match object).
  // A timeout (no fresh transition — transient) or a present-but-uncommitted candidate
  // (commit-ladder limitation, the data IS valid) is NOT genuine → keep + surface, never
  // delete. (Mirrors fillDropdownCdp's genuineNoMatch — the data-loss safety, lockstep.)
  const genuineNoMatch = trace.length > 0 && trace.every((s) => s.outcome === "nomatch" || (s.outcome === "results" && !s.match));
  return { status: "needs_review", after: null, verified: false, detail: "no candidate produced a verified chip", captured_options: lastFiltered || undefined, settle_trace: trace, optionsLoaded: optionsEverLoaded, genuineNoMatch };
};

// fillSourceCdp + tryInlineAiSource were MERGED into fillTypeaheadCdp — the unified hierarchical-typeahead
// filler (2026-06-28). The Certification typeahead and "How did you hear about us?" are the SAME Workday
// multiselect widget (operator recon): same selectors/structure/state attrs, both reading promptOption +
// data-automation-label scoped by data-uxi-multiselect-id, committing the FIRST matching leaf. Source now
// routes through fillTypeaheadCdp in drivePageFill (its how_did_you_hear candidates + M30 optionsLoaded +
// EEO preserved); the AI no-match path is fillTypeaheadCdp.tryInlineAi (flat by default; the gated
// aiTreeDrillFallback drill only when GENUINE categories render).
// Back-compat alias: the source/debug harnesses (background.js RUN_CDP_SOURCE_FILL / RUN_CDP_SOURCE_AI_DEBUG)
// + a few tests call fillSourceCdp(act, loc, candidates, budgets, opts) — signature-identical → the unified
// filler. (debugStopAfterCategory is now a no-op; that debug dump lived in the removed tryInlineAiSource.)
const fillSourceCdp = fillTypeaheadCdp;

// ── AI typeahead fallback (the parked "AI picks from the captured list on a no-match") ───────────
// When a FLAT typeahead exhausts its tiers and GENUINELY no-matches (genuineNoMatch — every candidate
// gave a banner/absent), hand the captured option list + the profile to the LLM, commit its pick
// through the PROVEN filler, and ALWAYS surface it filled_review (never silent). Headline: Field of
// Study. Tree pickers EXCLUDED — source by widgetType "hierarchical" (upstream); Magna's certification
// (a tree mis-tagged "typeahead") by the name-belt in aiTypeaheadEligible + the structural
// act.isTreePicker (the 0.4 discriminator, applied in drivePageFill). Provider-agnostic (act.llm).

// Parse the LLM's typeahead reply: {choice, represented, confidence}. Modeled on parseAiReply —
// tolerate ```-fences / the first {…} block / a non-JSON reply. `represented` (is the applicant's
// real answer genuinely in the list, or is `choice` only the nearest approximation?) DEFAULTS FALSE
// when missing/unparseable (conservative — an unresolvable reply must not claim representation).
const parseAiTypeaheadReply = (text) => {
  let t = String(text == null ? "" : text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let obj = null;
  try { obj = JSON.parse(t); } catch (e) {
    const mm = t.match(/\{[\s\S]*\}/);
    if (mm) { try { obj = JSON.parse(mm[0]); } catch (e2) { /* fall through to best-effort */ } }
  }
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const choice = String(obj.choice != null ? obj.choice : (obj.answer != null ? obj.answer : "")).trim();
    const represented = obj.represented === true || String(obj.represented).trim().toLowerCase() === "true";
    return { choice, represented, confidence: _aiConf(obj.confidence) };
  }
  return { choice: t, represented: false, confidence: "low" }; // unparseable → conservative: not represented
};

// "Other" detection (normalize lowercases + strips trailing (+digits) + collapses whitespace).
const isOtherOption = (o) => apMatch.normalize(o) === "other";

// Parse the AI's TREE-CATEGORY reply: {choice, confidence} (no `represented` — the category is a
// navigation step, not the answer). Tolerant like parseAiTypeaheadReply (```-fences / embedded / non-JSON).
const parseAiTreeReply = (text) => {
  let t = String(text == null ? "" : text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let obj = null;
  try { obj = JSON.parse(t); } catch (e) {
    const mm = t.match(/\{[\s\S]*\}/);
    if (mm) { try { obj = JSON.parse(mm[0]); } catch (e2) { /* fall through */ } }
  }
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    return { choice: String(obj.choice != null ? obj.choice : (obj.category != null ? obj.category : "")).trim(), confidence: _aiConf(obj.confidence) };
  }
  return { choice: t, confidence: "low" };
};

// Snap an UNRESOLVABLE AI choice to the CLOSEST real option — argmax fuzzyRatio, NO threshold. Used
// ONLY on a REQUIRED field with no "Other", where SOMETHING must be committed (a blank required field
// HALTS the walk). Distinct from matchCandidates (which returns -1 below 90 to avoid SILENT wrong fills):
// here a forced low-quality pick is acceptable because it's flagged super-hard (ai-closest-forced) for
// human review. Empty/garbled choice → the first option. Always returns an option when options is non-empty.
const nearestOption = (choice, options) => {
  if (!options || !options.length) return null;
  const c = apMatch.normalize(choice);
  if (!c) return options[0];
  let best = options[0], bestScore = -1;
  for (const o of options) {
    const s = apMatch.fuzzyRatio(c, apMatch.normalize(o));
    if (s > bestScore) { bestScore = s; best = o; }
  }
  return best;
};

// Eligibility for the AI typeahead rescue (PURE — used by BOTH the AI pass AND the delete-vs-AI defer):
// a GENUINE no-match flat typeahead. NEVER the cert section (a tree mis-tagged "typeahead" on Magna →
// name-belt; source is already excluded by widgetType "hierarchical" before the pass). EEO is NOT
// excluded (the operator retracted that rule) — an EEO typeahead fills via AI and gets the demographic
// badge (re-tagged in the pass). The structural act.isTreePicker is the cross-tenant tree guard, applied
// in the AI pass (it needs an open, so it can't live in this pure predicate).
const aiTypeaheadEligible = (rec) => {
  if (!rec) return false;
  if (rec.widgetType !== "typeahead") return false;
  // A genuine no-match the AI can rescue (both are status needs_review):
  //   • EMPTY field, every candidate definitively missed → genuineNoMatch === true; OR
  //   • PRE-FILLED field, every candidate missed so the deterministic fallback was kept →
  //     flag "overwrite-nomatch-original-kept" (the field shows e.g. "Other"; the overwrite path
  //     itself tags this the "future-AI candidate" — the AI may upgrade it to a represented option).
  const noMatch = rec.status === "needs_review"
    && (rec.genuineNoMatch === true || rec.flag === "overwrite-nomatch-original-kept");
  if (!noMatch) return false;
  if (/^certification\[/.test(String(rec.fieldName || ""))) return false; // cert = Magna tree (name-belt)
  return true;
};

// Commit an AI-chosen option through the PROVEN filler: re-enter fillTypeaheadCdp with a SINGLE
// candidate (the empty-field commit path on a no-match-blanked field — NOT a clear-first sequence).
// matchCandidates([target], options) is the anti-hallucination belt (target MUST be a real option →
// commit the CANONICAL option text). ALWAYS filled_review on success (an AI guess is never silently
// "filled"); unverified → ai-commit-failed (honest after, never a false fill).
const commitAiTypeahead = async (act, loc, target, flag, confidence, detail, options, budgets) => {
  const m = apMatch.matchCandidates([target], options);
  if (m.targetIndex === -1) return { status: "needs_review", after: null, verified: false, flag: "ai-commit-failed", confidence,
    detail: "AI target \"" + target + "\" is not a real option (hallucination guard)", options, auditLoc: loc.wrapperSel };
  const canonical = options[m.targetIndex];
  const commit = await fillTypeaheadCdp(act, loc, [canonical], budgets);
  const ok = commit && commit.verified === true && (commit.status === "filled" || commit.status === "filled_review");
  if (!ok) return { status: "needs_review", after: commit ? commit.after : null, verified: false, flag: "ai-commit-failed", confidence,
    detail: detail + " — commit did not persist (" + ((commit && (commit.flag || commit.detail)) || "no result") + ")", options, auditLoc: loc.wrapperSel };
  return { status: "filled_review", after: commit.after, verified: true, matchTier: commit.matchTier, flag, confidence, detail, options, auditLoc: loc.wrapperSel };
};

// The decision tree (in CODE, each leaf unit-tested). options = the captured full list
// (rec.options || rec.captured_options); realOptions = options minus "Other"; otherOpt = "Other".
// Build the AI's "what to base the pick on" line. When the applicant HAS a stated answer for THIS field (the
// candidates the deterministic walk tried), give the AI ONLY that stated answer + have it MATCH it to an option
// (typo-tolerant, e.g. "Otherrr"→"Other") — NOT the whole profile, which (a) wastes tokens and (b) lets the AI
// OVERRIDE the stated answer by inferring from unrelated facts (the "Otherrr → Carnegie Mellon" bug: it picked
// the applicant's school instead of their stated "Other"). Fall back to the full profile ONLY when there is no
// stated answer for the field (e.g. an EEO field to infer). Used by both the flat + tree typeahead AI fallbacks.
const statedAnswerBlock = (candidates, profile) => {
  const stated = (Array.isArray(candidates) ? candidates : (candidates == null ? [] : [candidates]))
    .map((c) => String(c == null ? "" : c).trim()).filter(Boolean);
  return stated.length
    ? { stated: true, line: "Applicant's STATED answer for this field (MATCH it to an option; correct obvious spelling/typos, e.g. \"Otherrr\"→\"Other\"): " + JSON.stringify(stated) }
    : { stated: false, line: "Applicant profile: " + JSON.stringify(profile || {}) };
};

const aiTypeaheadFallback = async (act, rec, profile, jobContext, budgets) => {
  const loc = { wrapperSel: rec.auditLoc };
  const options = (Array.isArray(rec.options) && rec.options.length) ? rec.options
    : (Array.isArray(rec.captured_options) ? rec.captured_options : []);
  const realOptions = options.filter((o) => !isOtherOption(o));
  const otherOpt = options.find(isOtherOption);
  const required = !!rec.isRequired;

  // No real option to evaluate (the list is only "Other") + Other present → commit "Other"
  // deterministically. The ONLY no-LLM shortcut (no spend — nothing to choose among).
  if (realOptions.length === 0) {
    if (otherOpt) return await commitAiTypeahead(act, loc, otherOpt, "ai-other-only", "medium",
      "no selectable options besides \"Other\" → committed \"Other\" (no AI call)", options, budgets);
    return { detail: "AI typeahead: no options to evaluate — left for review" }; // leave needs_review untouched
  }

  // ≥1 real option → the LLM picks. STATED-ANSWER mode (the applicant gave an answer for this field) → match it
  // to an option, typo-tolerant; PROFILE mode (no stated answer, e.g. EEO) → infer + judge representation.
  const ctx = statedAnswerBlock(rec.statedAnswer, profile);
  const system = "You help an applicant pick a value for a job-application typeahead/autocomplete field (e.g. Field of Study). "
    + "If the applicant's STATED answer is provided, return the SINGLE option that best MATCHES it, correcting obvious spelling/typos (e.g. \"Otherrr\"→\"Other\"), and set represented=true when an option matches the stated answer. "
    + "OTHERWISE (only their profile is given), return the SINGLE option that best represents the applicant and judge representation: set represented=true when an option is the SAME field of study OR a clear PARENT / CHILD / SIBLING discipline — e.g. \"Electrical and Computer Engineering\"→\"Electrical Engineering\", \"Applied Mathematics\"→\"Mathematics\" — and represented=false ONLY when NO option fits at all (the caller then falls back to \"Other\"). "
    + "Copy the chosen option's text EXACTLY. Reply ONLY with a JSON object.";
  const user = "Question: " + String(rec.label || rec.fieldName || "")
    + "\nSelectable options (choose exactly one; reply with its EXACT text): " + JSON.stringify(realOptions)
    + "\n" + ctx.line
    + "\nJob context: " + JSON.stringify(jobContext || {})
    + "\n\nReply ONLY with a JSON object and nothing else:\n{\"choice\":\"<exact option text>\",\"represented\":true|false,\"confidence\":\"High|Medium|Low\"}";
  const res = await act.llm({ system, user, maxTokens: 512 });
  if (!res || !res.ok) return { status: "needs_review", after: null, verified: false, flag: "ai-call-failed", confidence: "low",
    detail: "AI typeahead call failed — " + ((res && res.error) || "no reply"), options, auditLoc: loc.wrapperSel };
  const reply = parseAiTypeaheadReply(res.text);
  const conf = reply.confidence;
  const cm = apMatch.matchCandidates([reply.choice], realOptions); // anti-hallucination → canonical real option
  const resolved = cm.targetIndex !== -1 ? realOptions[cm.targetIndex] : null;

  // represented + resolves to a real option → commit the pick.
  if (reply.represented && resolved) {
    return await commitAiTypeahead(act, loc, resolved, "ai-choice", conf,
      "AI: \"" + resolved + "\" (genuinely represented in the list)", options, budgets);
  }
  // not represented (or unresolvable) + "Other" available → "Other" is the honest answer.
  if (otherOpt) {
    return await commitAiTypeahead(act, loc, otherOpt, "ai-choice-other", conf,
      "AI: the applicant's answer isn't in the list" + (resolved ? " (nearest: \"" + resolved + "\")" : "") + " → \"Other\"", options, budgets);
  }
  // not represented + no "Other" + REQUIRED → MUST commit a real option (a blank REQUIRED field HALTS
  // the walk — the AI-1 principle). Prefer the clean match; else SNAP the AI's (unresolvable/hallucinated)
  // choice to the nearest real option — never decline. SUPER-HARD flag (the applicant didn't claim it).
  if (required) {
    const forced = resolved || nearestOption(reply.choice, realOptions);
    return await commitAiTypeahead(act, loc, forced, "ai-closest-forced", conf,
      "AI FORCED \"" + forced + "\" — NOT genuinely represented, no \"Other\" on a REQUIRED field"
      + (resolved ? "" : " (snapped from \"" + reply.choice + "\")") + " — VERIFY", options, budgets);
  }
  // not represented + no "Other" + OPTIONAL → leave needs_review, commit nothing (a blank OPTIONAL field
  // doesn't block the walk, so we don't force a value the applicant didn't claim).
  return { status: "needs_review", after: null, verified: false, flag: "ai-typeahead-decline", confidence: conf,
    detail: "AI: the applicant's answer isn't among the options and there is no \"Other\"" + (resolved ? " (nearest: \"" + resolved + "\")" : "") + " — left for review", options, auditLoc: loc.wrapperSel };
};

// ── AI TREE drill — the ONE drill for EVERY hierarchical typeahead (source "How did you hear about us?" AND
// cert AND any generic Workday TREE picker; operator: "fill the exact same way the source scrape fills, no need
// for two functions"). A TREE's on-no-match rows are CATEGORIES, and typing a category into the searchBox
// filters to NOTHING (typing finds LEAVES, not categories) — so the AI's chosen category must be CLICKED
// (act.expandCategory → cdpSourceRowRect viewport-aware trusted click) to reveal its leaves, NOT typed (the merge
// bug: the flat path TYPED "College/University" and failed). The chosen LEAF is then committed by TYPING it
// (Enter autocommits a unique match / clicks the TOP on a multi-tree tie) — NOT clickTreeLeaf, because a drilled
// leaf can re-drill on a click (the old cert-only clickTreeLeaf path is RETIRED). Flow: categories (the Fix 2
// START-scrape `preCats` if supplied, else scroll-enumerate now) → Prompt 1 picks one → CLICK-drill (wait until
// the banner == the category / the list flips) → scroll-enumerate ALL its leaves → Prompt 2 picks a SEEN leaf →
// focus → clear → type the leaf → Enter. Returns the result, or null (no categories visible → caller falls to
// the Tab-exit + needs_review; never a blind guess). aiCtx = { profile, jobContext, label, fieldName,
// isRequired, debugStopAfterCategory }; preCats = the START-scraped category list (Fix 2) or undefined;
// candidates = the field's STATED answer (what the deterministic walk tried) — given to the AI to MATCH (instead
// of the whole profile) so a typo'd answer maps to the option (e.g. "Otherrr"→"Other") rather than the AI
// inferring an unrelated profile fact (the "Carnegie Mellon" bug). See statedAnswerBlock.
const aiTreeDrillFallback = async (act, loc, aiCtx, budgets, preCats, candidates) => {
  const profile = aiCtx.profile, jobContext = aiCtx.jobContext;
  const label = String(aiCtx.label || aiCtx.fieldName || "this field");
  const eeo = isEeoField({ widgetType: "hierarchical", fieldName: aiCtx.fieldName, label });
  const norm = apMatch.normalize;
  const delayRender = act.delayRender || act.delayFull; // STAGE 3: typeahead render-settle, adaptive under the measured-fast gate (fallback for older fakes)
  const ctx = statedAnswerBlock(candidates, profile); // STATED answer (match it) vs PROFILE (infer)
  const fail = (flag, confidence, detail, extra) => Object.assign({ status: "needs_review", after: null, verified: false, flag, confidence, detail, auditLoc: loc.wrapperSel }, extra || {});

  // (1) Categories: the Fix 2 START-scrape (`preCats`) if available, else scroll-enumerate the on-no-match
  //     fallback now (its category LABELS render as promptOptions → scrapeSourceRows returns them in `options`).
  let categories = (Array.isArray(preCats) && preCats.length) ? preCats.slice() : [];
  if (!categories.length) {
    await delayRender(budgets.commitIntervalMs); // let the no-match fallback list render (walk settled on the banner) — adaptive under the measured-fast gate (STAGE 3); the category scrape/drill/commit downstream is chip-gated
    let scan = null; try { scan = act.scrapeSourceRows ? await act.scrapeSourceRows(loc) : null; } catch (e) {}
    categories = (scan && scan.ok && scan.options.length) ? scan.options : [];
  }
  if (!categories.length) return null; // no options visible → caller's needs_review (never guess blind)

  // PROMPT 1 — pick the CATEGORY (the one most likely to CONTAIN the applicant's stated answer, or — with no
  // stated answer — inferred from the profile).
  const sys1 = "You are navigating a job-application TREE picker: the options are grouped into CATEGORIES. If the applicant's STATED answer for this field is given, choose the category most likely to CONTAIN it (correct obvious spelling/typos); otherwise choose the category most likely to contain their answer inferred from the profile. A broad 'multiple/various/other' category is the usual catch-all. Reply ONLY with a JSON object.";
  const user1 = "Field: " + label
    + "\nCategories (choose exactly one; reply with its EXACT text): " + JSON.stringify(categories)
    + "\n" + ctx.line + "\nJob context: " + JSON.stringify(jobContext || {})
    + "\n\nReply ONLY with a JSON object and nothing else:\n{\"choice\":\"<exact category text>\",\"confidence\":\"High|Medium|Low\"}";
  const r1 = await act.llm({ system: sys1, user: user1, maxTokens: 256 });
  if (!r1 || !r1.ok) return fail("ai-call-failed", "low", "AI source category call failed — " + ((r1 && r1.error) || "no reply"), { options: categories });
  const cReply = parseAiTreeReply(r1.text);
  const cm = apMatch.matchCandidates([cReply.choice], categories);
  const category = cm.targetIndex !== -1 ? categories[cm.targetIndex] : nearestOption(cReply.choice, categories);
  if (!category) return fail("ai-nomatch", cReply.confidence, "AI source category \"" + cReply.choice + "\" matched no category", { options: categories });

  // DEBUG isolation (operator harness): BEFORE the production drill — dump the category element + click test, then STOP.
  if (aiCtx.debugStopAfterCategory) {
    const category_dom = act.sourceRowRect ? await act.sourceRowRect(category) : null; // scroll+settle → promptLeafNode rect
    let clicked = false;
    if (category_dom && category_dom.found && category_dom.rect && category_dom.rect.w > 0 && act.clickAt) {
      await act.clickAt(category_dom.rect.cx, category_dom.rect.cy); clicked = true; // TRUSTED click on the leaf's live center
    }
    await delayRender(budgets.commitIntervalMs); // (debug harness) adaptive under the measured-fast gate (STAGE 3)
    let post = null, chips = null;
    try { post = await act.scrapeSourceRows(loc); } catch (e) {}
    try { const s = await act.readSource(loc); chips = (s && s.chips) || []; } catch (e) {}
    return { status: "skipped", flag: "ai-source-debug", verified: null, after: null,
      detail: "DEBUG: no-match → AI category \"" + category + "\" → click(" + (clicked ? "ok" : "FAILED") + "); stopped (no leaf/commit)",
      debug: { categories, ai_category_reply: cReply.choice, ai_confidence: cReply.confidence, chosen_category: category, category_dom, clicked, post_click: { banner: (post && post.banner) || null, options: (post && post.options) || [] }, chips },
      tree_structure: { categories, chosen: category, leaves: (post && post.options) || [] }, auditLoc: loc.wrapperSel };
  }

  // (2) DRILL the category (CLICK, not type); wait until the BANNER == the chosen category (drill confirmed) and
  //     the leaves are stable (2 equal scrapes). Banner-match primary; "options flipped from the category list"
  //     is the fallback for a tenant that shows no drilled-category banner.
  if (!(await act.expandCategory(loc, category))) return fail("ai-commit-failed", cReply.confidence, "could not drill category \"" + category + "\"", { tree_structure: { categories, chosen: category } });
  const wantBanner = norm(category), catSig = categories.join("|");
  let leaves = [];
  const t0 = Date.now();
  while (Date.now() - t0 < (budgets.taOpenCeilingMs || 5000)) {
    await act.delay(budgets.taOpenIntervalMs || 120);
    let s = null; try { s = await act.scrapeSourceRows(loc); } catch (e) {}
    if (!s || !s.ok || !s.options.length) continue;
    const bannerHit = !!(s.banner && norm(s.banner).indexOf(wantBanner) !== -1); // the drilled-category banner
    const flipped = s.options.join("|") !== catSig;                              // list replaced by leaves
    if (!bannerHit && !flipped) continue;                                        // still on the category view — keep waiting for the drill
    // Drilled + a FULL scroll-accumulate done in THIS scrape → accept it. (Dropped the old "2 equal scrapes"
    // stability re-read: scrapeSourceRows is already internally virtualization-complete — it scroll-accumulates
    // until the option set stops growing — and the drilled-category banner confirms the render, so re-scrolling
    // the whole list a second time only adds the duplicate down-then-top scroll the operator saw, no safety.)
    leaves = s.options;
    break;
  }
  if (!leaves.length) return fail("ai-no-options", cReply.confidence, "category \"" + category + "\" revealed no leaves (no drill banner / list never flipped)", { tree_structure: { categories, chosen: category } });

  // PROMPT 2 — pick the LEAF (the full scrolled list).
  const tree_structure = { categories, chosen: category, leaves };
  const sys2 = "You are picking the exact option under the category \"" + category + "\" for the field \"" + label + "\". If the applicant's STATED answer is given, choose the option that best MATCHES it, correcting obvious spelling/typos (e.g. \"Otherrr\"→\"Other\"); otherwise choose the option that best fits the applicant. Prefer \"Other\"/a catch-all only when nothing matches. Reply ONLY with a JSON object.";
  const user2 = "Field: " + label + "  (category: " + category + ")"
    + "\nOptions (choose exactly one; reply with its EXACT text): " + JSON.stringify(leaves)
    + "\n" + ctx.line + "\nJob context: " + JSON.stringify(jobContext || {})
    + "\n\nReply ONLY with a JSON object and nothing else:\n{\"choice\":\"<exact option text>\",\"confidence\":\"High|Medium|Low\"}";
  const r2 = await act.llm({ system: sys2, user: user2, maxTokens: 256 });
  if (!r2 || !r2.ok) return fail("ai-call-failed", "low", "AI source leaf call failed — " + ((r2 && r2.error) || "no reply"), { tree_structure, options: leaves });
  const lReply = parseAiTreeReply(r2.text);
  const lm = apMatch.matchCandidates([lReply.choice], leaves);
  const leaf = lm.targetIndex !== -1 ? leaves[lm.targetIndex] : nearestOption(lReply.choice, leaves);
  if (!leaf) return fail("ai-nomatch", lReply.confidence, "AI source leaf \"" + lReply.choice + "\" matched no option", { tree_structure, options: leaves });

  // SKIP-IF-ALREADY-COMMITTED (optimization): if the field ALREADY holds the AI's chosen leaf (e.g. a pre-filled
  // chip the deterministic walk didn't recognize as a match, or the drill's filter already committed it), there
  // is nothing to do — return it kept, ZERO actuation, never disturbing an already-correct value.
  let cur = null; try { cur = await act.readSource(loc); } catch (e) {}
  if (cur && (cur.chips || []).some((c) => norm(c) === norm(leaf))) {
    try { await act.pressTab(); } catch (e) {} // close the still-open drill box (Tab blurs WITHOUT committing — the already-correct chip survives)
    return { status: "filled_review", after: (cur.chips || []).join("; "), verified: true, matchTier: "ai-source-tree", flag: eeo ? "ai-eeo-guess" : "ai-choice", confidence: lReply.confidence, detail: "AI source: " + category + " → \"" + leaf + "\" already committed — kept (no re-commit)", options: leaves, tree_structure, auditLoc: loc.wrapperSel };
  }

  // (3) COMMIT the SEEN leaf by TYPING it on the still-open drilled field: focus → Ctrl+A+Delete (clear the
  //     leftover no-match query) → TYPE the leaf → Enter (autocommit a unique match / click the TOP on a tie).
  try { await act.focusSourceSearch(loc); } catch (e) {}
  await act.clearSourceSearch();
  await pollSearchValue(act, () => act.readSource(loc), "", budgets);
  await act.typeInSourceSearch(leaf);
  await pollSearchValue(act, () => act.readSource(loc), leaf, budgets);
  await act.pressEnter(); // the filter-Enter
  // COMMIT + VERIFY (operator): Workday autocommits ONLY a UNIQUE filtered match — a value like "Other" that
  // filters to "Search Results (2): Other / Others" does NOT autocommit. So DETECT no-autocommit by polling for
  // the leaf's chip, and if it didn't land, ESCALATE: (a) trusted CLICK the leaf (clickSourceLeaf matches by
  // EXACT label → "Other", never "Others"); (b) press Enter AGAIN (commits the top result, which is always the
  // exact match). At EVERY step the gate is identical — a committed chip that normalize-EQUALS `leaf` — so what
  // the AI chose is exactly what ends up filled; a stray (e.g. "Others") is NEVER accepted (→ ai-commit-failed).
  // settleCommit DOES NOT burn the full commitCeilingMs (10s) waiting for an autocommit a multi-result never
  // gives (the operator's "long pause before the click"): it returns the MOMENT the leaf's chip lands, OR the
  // results render WITHOUT a chip (stable across stableReads → no autocommit is coming → escalate to the click NOW).
  const committedAsLeaf = (cr) => !!(cr && (cr.chips || []).some((c) => norm(c) === norm(leaf)));
  const settleCommit = async () => {
    let cr = null, resultsStable = 0; const t0 = Date.now();
    while (Date.now() - t0 < budgets.commitCeilingMs) {
      await act.delay(budgets.commitIntervalMs);
      try { cr = await act.readSource(loc); } catch (e) {}
      if (committedAsLeaf(cr)) return cr;                                                       // the leaf's chip landed → done
      if (cr && cr.resultsBanner && !(cr.chips && cr.chips.length)) { if (++resultsStable >= budgets.stableReads) return cr; } // results shown, no chip → escalate
      else resultsStable = 0;
    }
    return cr;
  };
  let cr = await settleCommit();                                                                                 // (a) autocommit on the filter-Enter, or results → escalate
  if (!committedAsLeaf(cr)) { try { await act.clickSourceLeaf(leaf); } catch (e) { /* filter-Enter-only tenant */ } cr = await settleCommit(); } // (b) CLICK the exact leaf
  if (!committedAsLeaf(cr)) { try { await act.pressEnter(); } catch (e) {} cr = await settleCommit(); }           // (c) press Enter AGAIN (commits the top exact-match result)
  const committedChips = (cr && cr.chips) || [];
  if (!committedAsLeaf(cr)) return fail("ai-commit-failed", lReply.confidence, "AI source: typed-commit of \"" + leaf + "\" did not persist (chips: " + JSON.stringify(committedChips) + ")", { tree_structure, options: leaves });
  return { status: "filled_review", after: committedChips.join("; "), verified: true, matchTier: "ai-source-tree", flag: eeo ? "ai-eeo-guess" : "ai-choice", confidence: lReply.confidence, detail: "AI source: " + category + " → typed \"" + leaf + "\" (drilled + scroll-enumerated; click-drill → typed commit)", options: leaves, tree_structure, auditLoc: loc.wrapperSel };
};

// The AI typeahead pass: rescue every GENUINE no-match flat typeahead in `results` via the LLM.
// Extracted as a reusable pass over drivePageFill's results (full-page + walk); kept as a unit seam.
// No-op when act.aiEnabled is false (AI OFF ⇒ no provider call — byte-identical).
async function runAiTypeaheadPass(act, results, profile, jobContext, budgets) {
  if (!act || !act.aiEnabled) return;
  for (const rec of results || []) {
    if (!aiTypeaheadEligible(rec)) continue;
    try {
      // Structural tree guard (the 0.4 cross-tenant discriminator): a "typeahead"-classified field whose
      // opened popup shows category rows is a TREE (cert) → exclude. Defense-in-depth over the name-belt.
      if (act.isTreePicker && await act.isTreePicker({ wrapperSel: rec.auditLoc })) {
        rec.flag = "ai-tree-excluded";
        rec.detail = "AI typeahead skipped — tree picker (chevron categories), not a flat typeahead";
        continue;
      }
      const aiRes = await aiTypeaheadFallback(act, rec, profile, jobContext, budgets);
      // EEO retraction: an AI-inferred demographic typeahead still gets the loud "AI-GUESSED DEMOGRAPHIC
      // — VERIFY" badge (only on a committed fill).
      if (aiRes && aiRes.status === "filled_review" && isEeoField(rec)) aiRes.flag = "ai-eeo-guess";
      Object.assign(rec, aiRes);
    } catch (e) { rec.status = "needs_review"; rec.flag = "ai-error"; rec.detail = "AI typeahead error: " + String((e && e.message) || e); }
  }
}

// ── Fix 2 — start-of-fill option capture for EVERY typeahead (was FoS-only) ──────────────────────
// Build the onCapture that fillTypeaheadCdp runs ONCE at the START (after opening, before the candidate loop):
//   • FLAT field (no categories on open) → scrape the full leaf list (scrapeTaOptions) → recorded for the REVIEW
//     page (reviewOptions()) AND returned as `capturedFull` for the flat AI rescue. So a normal typeahead never
//     needs a scrape AFTER the deterministic fill fails — it's all done at the start (the FoS pattern, generalized).
//   • TREE field (categories on open) → return null: NOT start-scraped (the cheap readTreeCategories detect does
//     not scroll), so a successful tree fill pays no wasted scroll; its categories + leaves are scraped by the AI
//     tree drill ONLY if the deterministic fill fails ("the tree scrapes are only used if AI needs to be called").
// Substrate-guarded (older fakes/recon-only acts may omit a method). Returns { onCapture, reviewOptions }.
function makeStartCapture(act, loc) {
  let reviewOpts = null;
  const onCapture = async () => {
    let cats = [];
    try { cats = act.readTreeCategories ? (await act.readTreeCategories(loc)) : []; } catch (e) { cats = []; }
    if (cats && cats.length) return null; // TREE → no start-scrape (the drill self-scrapes only on a no-match)
    try {
      const sc = act.scrapeTaOptions ? await act.scrapeTaOptions(loc) : null;
      if (sc && sc.ok && Array.isArray(sc.options) && sc.options.length) { reviewOpts = sc.options.slice(); return reviewOpts; }
    } catch (e) { /* best-effort — the flat AI falls back to the last filtered set */ }
    return null;
  };
  return { onCapture, reviewOptions: () => reviewOpts };
}

// ── The page driver (the M22 flat-loop semantics over the actuation) ────────
// `opts.onlyFieldNames` (a Set) = AI-4 TARGETED RE-FILL: fill ONLY those flat fields through the
// SAME per-field loop (byte-identical to the full fill — no parallel re-impl, no drift) and skip
// the section fold + the inline audit (the remediation's Save & Continue retry is the verification).
// `opts.onlySections` (a Set of PAGE_SECTIONS names) = AI-4 Tier-1.5 SECTION RE-FILL: skip the flat
// loop entirely and drive ONLY the named repeating sections through the SAME fold (reconcile-to-N +
// re-fill, incl. nested specialties) — for errors naming section fields the flat FIELD_MAP can't
// reach (the live nested-Specialty miss, 2026-07-01). Same targeted-mode skips as onlyFieldNames
// (no unknown-section stubs / cascade / sweep / inline audit — the Save & Continue retry verifies).
// Default (no opts) = the full page fill, unchanged.
//
// ── Answer buckets (Profile v2) ─────────────────────────────────────────────
// A bucket = one answer + the question wordings that resolve to it (docs/profile-v2-plan.md).
// Consulted for an UNMAPPED field the deterministic pass left empty, BEFORE the AI pass — the
// value is a CANDIDATE through the SAME match ladder vs the LIVE options (never blind).

// Build a normalized-wording → bucket index (pure; last wording wins a collision, blank skipped).
function buildBucketIndex(buckets) {
  const idx = new Map();
  for (const b of (Array.isArray(buckets) ? buckets : [])) {
    if (!b || typeof b !== "object" || !Array.isArray(b.questions)) continue;
    for (const q of b.questions) {
      const k = apMatch.normalizeLabel(q);
      if (k) idx.set(k, b);
    }
  }
  return idx;
}

// Fill a field from a matched bucket. Mode A (profile_path) → resolve the profile value; Mode B →
// the bucket's own value. Runs the widget-appropriate deterministic fill (match-ladder-gated) and
// returns the result flagged `bucket` (provenance — a "remembered" style badge, NOT an ai-* flag)
// ONLY on a real commit; a no-match/failure returns null so the caller falls through to the AI pass
// / blank. textarea (essays) + file_upload + unknown are never bucket-filled.
const fillFromBucket = async (act, loc, f, bucket, profile, budgets) => {
  let arg;
  if (bucket.profile_path) {
    const r = resolve(getByPath(profile, bucket.profile_path), f.widgetType);
    if (!r || r.skip) return null;
    arg = r.value !== undefined ? r.value : r.candidates; // same shape as the mapped-path dispatch
  } else {
    const v = bucket.value != null ? String(bucket.value) : "";
    if (v.trim() === "") return null;
    arg = (f.widgetType === "text") ? v : [v]; // Mode B: a single standalone value
  }
  if (arg == null || (Array.isArray(arg) && arg.length === 0)) return null;

  let res = null;
  if (f.widgetType === "text") res = await fillTextCdp(act, loc, arg, budgets);
  else if (f.widgetType === "dropdown") res = await fillDropdownCdp(act, loc, arg, budgets);
  else if (f.widgetType === "radio") res = await fillRadioCdp(act, loc, arg, budgets);
  else if (f.widgetType === "typeahead") {
    const cap = makeStartCapture(act, loc);
    res = await fillTypeaheadCdp(act, loc, arg, budgets, { onCapture: cap.onCapture }); // NO opts.ai → deterministic candidate only
    if (res && (res.status === "filled" || res.status === "filled_review")) { const ro = cap.reviewOptions(); if (ro && ro.length) res.options = ro; }
  } else if (f.widgetType === "checkbox") {
    const want = /^(true|yes|checked|1|on)$/i.test(String(Array.isArray(arg) ? arg[0] : arg));
    res = await fillCheckboxCdp(act, loc, want, budgets);
  } else return null; // textarea / file_upload / unknown — never bucket-filled
  if (!res || (res.status !== "filled" && res.status !== "filled_review")) return null;
  res.flag = "bucket";
  res.detail = (bucket.profile_path ? "From a profile bucket (" + bucket.profile_path + ")" : "From a saved answer bucket")
    + (res.detail ? " · " + res.detail : "");
  return res;
};

async function drivePageFill(act, profile, defaults, jobContext, budgetsIn, opts) {
  const budgets = Object.assign({}, DEFAULT_BUDGETS, budgetsIn || {});
  const only = opts && opts.onlyFieldNames ? opts.onlyFieldNames : null; // AI-4 targeted re-fill
  const onlySec = opts && opts.onlySections ? opts.onlySections : null;  // AI-4 Tier-1.5 section re-fill
  const targeted = !!(only || onlySec); // either targeted mode → skip the full-fill-only passes below
  const bucketIndex = buildBucketIndex(opts && opts.buckets); // Profile v2: wording → answer buckets (consulted before AI)
  const scan = await act.scanPage();
  const results = [];

  for (const f of (onlySec ? [] : scan.fields)) { // section re-fill → flat loop skipped entirely
    if (only && !only.has(f.fieldName)) continue; // AI-4: re-fill only the targeted field(s)
    const loc = { wrapperSel: f.wrapperSel };
    const mappedPath = FIELD_MAP[f.fieldName] || null;
    const rawValue = mappedPath ? getByPath(profile, mappedPath) : undefined;

    const record = {
      fieldName: f.fieldName,
      label: f.label,
      widgetType: f.widgetType,
      isRequired: f.isRequired,
      mappedPath,
      rawValue: rawValue === undefined ? null : rawValue,
      resolved: null,
      status: null,
      matchTier: null,     // COMMIT-PATH descriptor (not match quality — that's `confidence`)
      confidence: null,    // M27: match quality (high/low/none) — set by commitOutcome
      flag: null,          // M27: provenance (autocommit-*/directed-*/overwrite-*) — set by commitOutcome
      verified: null,
      after: null,
      detail: null
    };

    try {
      if (f.widgetType === "hierarchical") {
        // Source ("How did you hear about us?") — candidates: profile.how_did_you_hear
        // WINS, falling back to application_defaults.how_did_you_hear (the value is now
        // profile-driven, not policy-only). Source is the SAME widget as the cert
        // typeahead (recon 2026-06-28) → handled by the unified fillTypeaheadCdp; on a
        // genuine no-match its inline AI rescues (flat by default; the gated aiTreeDrillFallback
        // drills only when GENUINE categories render) when AI is toggled on.
        const hdyh = (profile && profile.how_did_you_hear) || (defaults && defaults.how_did_you_hear);
        if (!hdyh || !Array.isArray(hdyh.preferred)) {
          record.status = "needs_review";
          record.detail = "no how_did_you_hear value (profile or defaults)";
        } else {
          const candidates = [...hdyh.preferred];
          if (hdyh.fallback) candidates.push(hdyh.fallback);
          record.resolved = candidates;
          // Inline AI rescue context (the typeahead's aiForField shape) + sourceTree → on a no-match the source
          // TREE is DRILLED (click category → leaves → type leaf), NOT the flat typed path. Only when AI is on.
          const aiForSource = act.aiEnabled
            ? { profile, jobContext, isRequired: f.isRequired, label: f.label, fieldName: f.fieldName, sourceTree: true }
            : undefined;
          Object.assign(record, await fillTypeaheadCdp(act, loc, candidates, budgets, { ai: aiForSource }));
        }
      } else if (f.fieldName === "candidateIsPreviousWorker") {
        // Fill + review-queue model (decidePreviousWorker, verbatim). Every
        // "Yes" carries a review flag; unevaluable stays blank + review.
        const company = jobContext && jobContext.company;
        const employers = profile.employment_history_companies;
        record.mappedPath = "(employer-match)";
        record.rawValue = company || null;
        const decision = decidePreviousWorker(company, f.label, employers);
        if (decision.fill) {
          record.resolved = [decision.fill];
          const hr = await fillRadioCdp(act, loc, [decision.fill], budgets);
          Object.assign(record, hr);
          record.detail = hr.detail ? `${decision.detail}; ${hr.detail}` : decision.detail;
          if (decision.likelyYes) record.matchTier = "likely-yes";
          if (hr.status === "filled" && decision.review) record.status = "filled_review";
        } else {
          record.status = "needs_review";
          record.detail = decision.detail;
        }
      } else if (f.widgetType === "file_upload") {
        record.status = "skipped";
        record.detail = "file upload — not attached by this harness (CDP milestone scope)";
      } else if (f.widgetType === "checkbox") {
        // AI-3 (operator-decided): a REQUIRED checkbox is a consent / acknowledgment → AUTO-CHECK it
        // (status `filled`, SILENT, NOT flagged) so the walk advances — UNLESS the profile EXPLICITLY
        // refuses it (mapped + false), which is respected as a deliberate refusal. Optional checkboxes
        // keep the profile-mapped reconcile (true→check / false→uncheck / empty→skip).
        // ⚠ This silently accepts Terms / certifies truthfulness / consents to background+drug checks
        //   with NO human review (operator-accepted; an explicit profile `false` is the only opt-out).
        const refused = !!mappedPath && (rawValue === false || /^(false|no)$/i.test(String(rawValue == null ? "" : rawValue)));
        if (f.isRequired && !refused) {
          record.resolved = true;
          Object.assign(record, await fillCheckboxCdp(act, loc, true, budgets)); // auto-consent
        } else if (!mappedPath) {
          record.status = "skipped";
          record.detail = "no mapping";
        } else if (rawValue === null || rawValue === undefined || (typeof rawValue === "string" && rawValue.trim() === "")) {
          record.status = "skipped";
          record.detail = `empty value at ${mappedPath}`;
        } else {
          const want = rawValue === true || /^(true|yes)$/i.test(String(rawValue));
          record.resolved = want;
          Object.assign(record, await fillCheckboxCdp(act, loc, want, budgets));
        }
      } else if (!mappedPath) {
        record.status = "skipped";
        record.detail = "no mapping";
      } else {
        const r = resolve(rawValue, f.widgetType);
        if (r.skip) {
          record.status = "skipped";
          record.detail = r.reason || `empty value at ${mappedPath}`;
        } else {
          const arg = r.value !== undefined ? r.value : r.candidates;
          record.resolved = arg;
          if (f.widgetType === "text") Object.assign(record, await fillTextCdp(act, loc, arg, budgets));
          else if (f.widgetType === "textarea") Object.assign(record, await fillTextCdp(act, loc, arg, budgets, "textarea"));
          else if (f.widgetType === "dropdown") Object.assign(record, await fillDropdownCdp(act, loc, arg, budgets));
          else if (f.widgetType === "radio") Object.assign(record, await fillRadioCdp(act, loc, arg, budgets));
          else if (f.widgetType === "typeahead") {
            // Fix 2: start-scrape the options (FLAT → review + AI; TREE → no start-scrape). Inline AI on no-match.
            const cap = makeStartCapture(act, loc);
            Object.assign(record, await fillTypeaheadCdp(act, loc, arg, budgets,
              { onCapture: cap.onCapture, ai: { profile, jobContext, fieldName: f.fieldName, label: f.label, isRequired: f.isRequired } }));
            const ro = cap.reviewOptions(); if (ro && ro.length) record.options = ro;
          }
          else { record.status = "skipped"; record.detail = `no handler for type ${f.widgetType}`; }
        }
      }
    } catch (e) {
      record.status = "error";
      record.detail = String(e);
    }

    // ── ANSWER-BUCKET CONSULT (Profile v2) ── BEFORE any AI: an UNMAPPED field the deterministic
    // pass left empty whose question matches a bucket wording fills from the bucket (Mode A → the
    // profile field; Mode B → the saved value) — a CANDIDATE through the SAME match ladder vs the
    // LIVE options (never blind). A no-match falls through to the AI pass / blank below. `!mappedPath`
    // so a mapped-but-no-match field goes to CANONICALIZE instead. A human-curated binding beats a
    // fresh AI guess → this runs first, for REQUIRED and OPTIONAL fields alike.
    if (producedNothing(record) && !mappedPath && bucketIndex.size) {
      const bucket = bucketIndex.get(apMatch.normalizeLabel(f.label));
      if (bucket) {
        try {
          const bkRes = await fillFromBucket(act, loc, f, bucket, profile, budgets);
          if (bkRes) Object.assign(record, bkRes);
        } catch (e) { /* leave the record as-is → the AI post-pass / blank handles it */ }
      }
    }

    // ── AI FALLBACK ── if AI is ON and the deterministic pass produced NOTHING usable. Additive +
    // gated — the deterministic record above is untouched unless this fires (existing paths
    // unchanged when AI is OFF). TWO distinct paths, never confused:
    //  • CANONICALIZE (AI-3): a MAPPED dropdown whose STATED profile value didn't match the option
    //    vocab → map the KNOWN value to an option. NEVER infers; keeps its own ai-canonicalized flag.
    //  • INFER (AI-1/AI-2): an unmapped/unanswerable field with NO known value → the AI decides.
    //    aiEligible-gated (NEVER the employer-match radio / file_upload), AND ONLY for REQUIRED
    //    fields (operator rule): an OPTIONAL unmapped dropdown/text/textarea — incl. the cascade-
    //    revealed Local Name fields and OPTIONAL EEO — fills DETERMINISTICALLY only and is left
    //    BLANK on a miss (no LLM call). A blank optional field doesn't block Save & Continue, so
    //    there's no reason to guess it. EEO is now INCLUDED for REQUIRED fields (the operator
    //    retracted the exclusion) → an AI-inferred demographic is re-tagged ai-eeo-guess so the
    //    viewer still shows the loud "AI-GUESSED DEMOGRAPHIC — VERIFY" badge. dropdown→aiFillField,
    //    text/textarea→aiFillText. ALWAYS filled_review, never silent.
    if (act.aiEnabled && producedNothing(record)) {
      const canonicalize = !!mappedPath && record.resolved != null && record.genuineNoMatch === true && f.widgetType === "dropdown";
      try {
        let aiRes = null;
        if (canonicalize) aiRes = await aiCanonicalizeField(act, loc, f, record.resolved, budgets); // map a STATED value (never infers) — runs for required OR optional (operates on a value the user PROVIDED, not a guess)
        else if (f.isRequired && aiEligible(f)) { // INFER only for REQUIRED fields — optional stays at its deterministic skipped/blank result, no LLM
          aiRes = (f.widgetType === "dropdown")
            ? await aiFillField(act, loc, f, profile, jobContext, budgets)
            : await aiFillText(act, loc, f, profile, jobContext, budgets);
          // EEO retraction: an AI-INFERRED demographic still gets the loud demographic badge. Only a
          // committed inference (filled_review); canonicalize keeps ai-canonicalized (maps a STATED value).
          if (aiRes && aiRes.status === "filled_review" && isEeoField(f)) aiRes.flag = "ai-eeo-guess";
        }
        if (aiRes) Object.assign(record, aiRes);
      } catch (e) { record.status = "needs_review"; record.flag = "ai-error"; record.detail = "AI fill error: " + String((e && e.message) || e); }
    }

    // ── Required-EMPTY TYPEAHEAD AI fill ── a REQUIRED typeahead with no profile value is SKIPPED above, but a
    // blank required field BLOCKS Save & Continue (the operator: a required field MUST get a value, even a wrong
    // one — the review page corrects it). aiEligible excludes typeaheads (they fill via their OWN inline path, so
    // the producedNothing block above didn't touch them) → so this is the typeahead analog of the dropdown AI-1
    // post-pass. Run the unified filler with NO candidates → its inline AI has no STATED answer → infers from the
    // profile and FORCES a pick (a required field never declines: ai-closest-forced / ai-choice-other / the tree
    // drill) + flags filled_review. AI OFF → stays skipped (can't infer) → escalated to needs_review below.
    if (act.aiEnabled && f.isRequired && record.status === "skipped" && f.widgetType === "typeahead") {
      try {
        const cap = makeStartCapture(act, loc);
        Object.assign(record, await fillTypeaheadCdp(act, loc, [], budgets,
          { onCapture: cap.onCapture, ai: { profile, jobContext, fieldName: f.fieldName, label: f.label, isRequired: true } }));
        const ro = cap.reviewOptions(); if (ro && ro.length) record.options = ro;
      } catch (e) { record.status = "needs_review"; record.flag = "ai-error"; record.detail = "AI required-empty typeahead error: " + String((e && e.message) || e); }
    }

    // ── AI-3 MANDATORY-EEO inference ── now ONLY the mapped-but-empty REQUIRED EEO dropdown corner: an
    // unmapped EEO field already filled via the generic INFER block above (EEO is no longer excluded), so
    // its status is filled_review (not `skipped`) and this won't fire. A MAPPED-but-empty required EEO
    // dropdown (status `skipped`, producedNothing false → the infer block skipped it) would HALT the walk
    // → the confidence-gated AI-3 path guesses-or-declines (ai-eeo-guess / eeo_declined). Optional never
    // reaches here (a blank optional doesn't block). Mutually exclusive with the infer block (status gate).
    if (act.aiEnabled && f.isRequired && record.status === "skipped" && f.widgetType === "dropdown"
        && (AI_EEO_RE.test(String(f.label || "")) || AI_EEO_RE.test(String(f.fieldName || "")))) {
      try { Object.assign(record, await aiInferEeoField(act, loc, f, profile, budgets)); }
      catch (e) { record.status = "needs_review"; record.flag = "ai-error"; record.detail = "AI EEO infer error: " + String((e && e.message) || e); }
    }

    // ── Required-RADIO AI fallback (the deferred required-radio path) ── a REQUIRED radio the deterministic
    // pass could NOT answer (unmapped → skipped; the employer-match "unevaluable" branch / no-options →
    // needs_review with no resolved value) is left BLANK, which BLOCKS Save & Continue. Like the dropdown/
    // typeahead AI-1: GUESS-to-reach-review (aiFillRadio) — infer + commit + ALWAYS filled_review, flagged
    // HARD. GATE on `record.resolved == null` so a decision the deterministic pass ALREADY made but failed to
    // commit (e.g. a matched "Yes" employer decision) is NEVER overridden by a contradictory guess — it stays
    // review-flagged. AI OFF / OPTIONAL → never fires (a blank optional radio doesn't block; unit-pinned).
    if (act.aiEnabled && f.isRequired && f.widgetType === "radio" && record.resolved == null
        && record.status !== "filled" && record.status !== "filled_review") {
      try {
        const aiRes = await aiFillRadio(act, loc, f, profile, jobContext, budgets);
        if (aiRes && aiRes.status === "filled_review" && isEeoField(f)) aiRes.flag = "ai-eeo-guess"; // a demographic radio → loud demographic badge
        if (aiRes) Object.assign(record, aiRes);
      } catch (e) { record.status = "needs_review"; record.flag = "ai-error"; record.detail = "AI radio fallback error: " + String((e && e.message) || e); }
    }

    record.auditLoc = f.wrapperSel; // M40: retain the locator (a selector string, re-resolved fresh) for the post-fill audit re-read
    results.push(record);

    // Let one field's transient UI settle before the next opens (also the
    // natural blur of the prior field — the sequential-cleanup rule).
    await act.delay(budgets.interFieldMs);
  }

  // M38 FOLD — after the flat fields, drive each repeating section PRESENT on this page
  // (so ONE drivePageFill = a full page fill). One repeatingScan determines presence: a
  // container with the section's prefix OR an Add button whose nearestHeading matches the
  // headingRegex (the create-first case — Education can start 0 entries but its Add +
  // heading are present). Absent sections are SKIPPED → a page with no repeating sections
  // (page 1) behaves exactly as before (no spurious Add attempts). Section results concat
  // into `results` (the counts/needsReview below cover them too); driveRepeatingSectionCdp
  // handles reconcile-to-N (create-first / delete-extras / 0-items) per section. `profile`
  // is the PREPARED profile (the SW prepareProfile's it), so profile[itemsKey] carries the
  // annotated arrays. Driven in registry order.
  let rscan = null;
  try { if (!only) rscan = await act.repeatingScan(); } catch (e) { /* no repeating substrate (flat-only fake) → skip */ }
  if (!only && rscan && (rscan.sections || rscan.addButtons)) {
    // FILL IN DOM ORDER (operator rule 2026-07-02): drive sections top-to-bottom as they appear on
    // the PAGE (the human order), not registry order — detected from the scan, nothing hardcoded.
    for (const sec of sectionsInDomOrder(PAGE_SECTIONS, rscan.addButtons)) {
      if (onlySec && !onlySec.has(sec.name)) continue; // Tier-1.5: only the error-named section(s)
      const hasContainer = !!(rscan.sections && rscan.sections[sec.containerPrefix]);
      const re = new RegExp(sec.headingRegex, "i");
      const hasAdd = Array.isArray(rscan.addButtons) && rscan.addButtons.some((b) => re.test((b && b.nearestHeading) || ""));
      if (!hasContainer && !hasAdd) continue; // section not on this page
      const items = Array.isArray(profile[sec.itemsKey]) ? profile[sec.itemsKey] : [];
      const out = await driveRepeatingSectionCdp(act, {
        name: sec.name, headingRegex: sec.headingRegex, containerPrefix: sec.containerPrefix,
        items, fieldMap: sec.fieldMap, deleteOnNoMatch: sec.deleteOnNoMatch,
        aiContext: { profile, jobContext }, // Option B: inline AI rescue context for the section's typeaheads (FoS)
        nested: sec.nested || null,          // HARDCODED nested sub-sections (cert ▸ Specialties + Attachments); null elsewhere
        // AI-4 Tier-1.6 remediation re-fill: NEVER reconcile-DOWN (deleting entries beyond profile-N
        // would wipe rows the operator added by hand — the 2026-07-02 complaint). Main fill: false.
        preserveExtras: !!(opts && opts.preserveExtras)
      }, budgets);
      if (out && Array.isArray(out.results)) results.push(...out.results);
    }
  }

  // m3a: surface UNKNOWN repeating sections (present on the form but NOT in PAGE_SECTIONS) as review
  // STUBS carrying the backend identifier (container_prefix + heading + the detected field shape when
  // it has entries), so ANY repeating section shows up in review + is fillable via add-entry. The bot
  // has NO mapping to auto-fill an unknown section, so it NEVER actuates one here (no value fill, no
  // add/delete) — the stub is needs_review and the values are the operator's (or a future fill-back
  // session's, which reads container_prefix/the field automation-ids). An EMPTY unknown section shows
  // its identifier; its fields are TBD until an entry exists (m3b reveal-by-add). Skipped under `only`.
  if (!targeted && rscan && rscan.sections) {
    const knownPrefixes = new Set(PAGE_SECTIONS.map((s) => s.containerPrefix));
    for (const prefix of Object.keys(rscan.sections)) {
      if (knownPrefixes.has(prefix)) continue; // a known section — handled by the loop above
      const sec = rscan.sections[prefix];
      const base = prefix.replace(/-$/, "");
      const human = base.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
      const entries = sec.entries || [];
      const n = entries.length;
      // (1) RECON the SHAPE from entries[0] — OPEN+SCRAPE each dropdown/typeahead's options so the
      //     summary shows real dropdowns/comboboxes (not bare text boxes); dates carry segment order.
      const shape = [];
      for (const f of ((entries[0] && entries[0].fields) || [])) {
        const s = { recName: f.fieldName, path: f.fieldName, widget_type: f.widgetType, label: f.label, is_required: !!f.isRequired };
        const loc = { wrapperSel: f.wrapperSel };
        try {
          if (f.widgetType === "dropdown") { const o = await captureDropdownOptions(act, loc, budgets); if (o && o.length) s.options = o; }
          else if (f.widgetType === "typeahead") { const cap = await captureTypeaheadOptions(act, loc, budgets); if (cap) { s.widget_type = cap.widget_type; if (Array.isArray(cap.options) && cap.options.length) s.options = cap.options; } }
          else if (f.widgetType === "date") { const ord = dateOrderOf(f.dateSegments); if (ord.length) s.date_order = ord; }
        } catch (e) { /* non-fatal — stays its base widget */ }
        shape.push(s);
      }
      const shapeByRec = {}; for (const s of shape) shapeByRec[s.recName] = s;
      // (2) SURFACE each EXISTING entry's fields with their CURRENT value, flagged "already on the form,
      //     NOT filled by ApplyPilot" (the bot has no mapping for an unknown section → it never touches
      //     these; the operator verifies). Editable (options/date_order from the recon'd shape).
      for (let i = 0; i < n; i++) {
        for (const f of ((entries[i] && entries[i].fields) || [])) {
          if (!f.fieldName) continue; // "" = a bare wrapper (e.g. an attachments "formField-") — unusable row
          const shp = shapeByRec[f.fieldName] || {};
          const v = f.value;
          const hasVal = hasLiveValue(v);
          const isReq = !!f.isRequired;
          // has a value → verify (filled_review); REQUIRED + empty → needs a value (needs_review);
          // OPTIONAL + empty → fine to leave EMPTY → "skipped" (deriveReview won't flag it for approval).
          const status = hasVal ? "filled_review" : (isReq ? "needs_review" : "skipped");
          results.push({
            fieldName: base + "[" + i + "]." + f.fieldName, label: f.label || f.fieldName,
            widgetType: shp.widget_type || f.widgetType, isRequired: isReq,
            mappedPath: base + "[" + i + "]." + f.fieldName,
            rawValue: null, resolved: null,
            status, matchTier: null, confidence: null, flag: "already-filled",
            // String(v) matches the bot's checkbox convention (fillCheckboxCdp → String(checked) =
            // "true"/"false") + the viewer's checkedOf/tokenFor; a checkbox reads back boolean true → "true".
            verified: null, after: hasVal ? String(v) : null,
            detail: hasVal ? "already on the form — NOT filled by ApplyPilot; verify"
              : isReq ? "required — on the form but EMPTY; needs a value" : "optional — on the form, empty; fine to leave",
            options: shp.options || null, date_order: shp.date_order || null, auditLoc: f.wrapperSel
          });
        }
      }
      // (3) the section STUB — add-entry + the "already there" note (shape carries recon'd options).
      results.push({
        fieldName: base, label: sec.heading || human, // the REAL section name (DOM heading), not "unmapped section"
        widgetType: "section_stub", isRequired: false, mappedPath: base + "._stub",
        rawValue: null, resolved: null, status: "skipped", matchTier: null, confidence: null,
        flag: "section-stub", verified: null, after: null,
        detail: "This repeating section isn't auto-filled by ApplyPilot (" + n + " entr" + (n === 1 ? "y" : "ies") + " already on the form) — add or verify entries here.",
        section_field_shape: shape.map((s) => ({ recName: s.recName, widget_type: s.widget_type, path: s.path, label: s.label, is_required: s.is_required, date_order: s.date_order || null, options: s.options || null })),
        container_prefix: prefix, section_heading: sec.heading || null, section_known: false
      });
    }
  }

  // 2c: capture the DETECTED field shape (LIVE form, not the hardcoded *_MAP) for each present+
  // mounted section → the review's add-entry builds new entries from DOM-detected fields, and the
  // bundle CACHES the shapes (so a section EMPTY on a later run still adds from a detected shape).
  // Cost: AT MOST one reused repeating-scan per page, and ONLY when a present section was create-
  // first (empty at the pre-loop scan but mounted after filling); zero actuation; skipped under `only`.
  let sectionShapes = {};
  if (!targeted && rscan) {
    const needRescan = PAGE_SECTIONS.some((sec) => {
      if (rscan.sections && rscan.sections[sec.containerPrefix]) return false; // already mounted at the pre-loop scan
      const re = new RegExp(sec.headingRegex, "i");
      return Array.isArray(rscan.addButtons) && rscan.addButtons.some((b) => re.test((b && b.nearestHeading) || ""));
    });
    let shapeScan = rscan;
    if (needRescan) { try { shapeScan = await act.repeatingScan(); } catch (e) { shapeScan = rscan; } }
    sectionShapes = detectSectionShapes(shapeScan);
  }

  // m3b: EMPTY unknown sections — present via an Add button + heading but with NO entry container
  // (so m3a's container loop can't see them). REVEAL-BY-ADD: mount one entry → detect its fields +
  // fkit prefix → delete it → emit the stub. The ONLY place m3 actuates an unknown section (the
  // operator opted into this one-time mount+delete). CACHED across runs via opts.cachedShapes (by
  // base) + opts.headingToBase (an empty section's base is unknown pre-mount, so it's matched by
  // heading) → fires once per bundle-lifetime, not every fill (the "fast, especially hidden"
  // constraint); "Clear summary" resets. Skipped under `only`.
  if (!targeted && rscan && Array.isArray(rscan.addButtons)) {
    const knownRes = PAGE_SECTIONS.map((s) => new RegExp(s.headingRegex, "i"));
    const norm = (h) => String(h || "").trim().toLowerCase().replace(/\s+/g, " ");
    // headings of sections m3a ALREADY surfaced (they have entries) — normalized so a case/whitespace
    // difference between the Add's nearestHeading and the section heading doesn't slip an already-
    // present section into reveal-by-add. (The revealUnknownSection self-clean is the hard backstop.)
    const containerHeadings = new Set(Object.keys(rscan.sections || {}).map((p) => norm((rscan.sections[p] && rscan.sections[p].heading) || "")).filter(Boolean));
    const cachedShapes = (opts && opts.cachedShapes) || {};
    const headingToBase = (opts && opts.headingToBase) || {};
    const seen = new Set();
    for (const b of rscan.addButtons) {
      const heading = (b && b.nearestHeading) || "";
      const hn = norm(heading);
      if (!heading || seen.has(hn)) continue;
      // an Add button INSIDE a repeating entry is a NESTED sub-section's (cert ▸ Specialties —
      // owned by its parent section's nested config), never a top-level unknown section. Clicking
      // it here mounted a phantom EMPTY specialty row that revealUnknownSection could not see
      // (specialties have no --null container → no new prefix, parent count unchanged) nor delete.
      if (b.insideEntry) continue;
      if (knownRes.some((re) => re.test(heading))) continue;   // a known section's Add button
      if (containerHeadings.has(hn)) continue;                 // already surfaced by m3a (it has entries)
      seen.add(hn);
      let base, prefix, shape;
      const cb = headingToBase[heading];
      const cachedShape = cb && Array.isArray(cachedShapes[cb]) ? cachedShapes[cb] : null;
      if (cachedShape && cachedShape.length) {
        base = cb; prefix = cb + "-"; shape = cachedShape; // cache hit → NO actuation (once per bundle-lifetime)
      } else {
        const revealed = await revealUnknownSection(act, heading, budgets);
        if (!revealed) continue; // couldn't mount → can't surface a container-less empty section
        base = revealed.base; prefix = revealed.prefix; shape = revealed.shape;
        sectionShapes[base] = shape; // persist onto the bundle so the next run is a cache hit
      }
      const human = base.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
      results.push({
        fieldName: base, label: heading || human, // the REAL section name (DOM heading)
        widgetType: "section_stub", isRequired: false, mappedPath: base + "._stub",
        rawValue: null, resolved: null, status: "skipped", matchTier: null, confidence: null,
        flag: "section-stub", verified: null, after: null,
        detail: "This repeating section isn't auto-filled by the bot (empty on the form) — add or verify its entries here.",
        section_field_shape: shape.map((s) => ({ recName: s.recName, widget_type: s.widget_type, path: s.path != null ? s.path : s.recName, label: s.label, is_required: s.is_required, date_order: s.date_order || null, options: s.options || null })), // carry BOTH date_order AND the recon'd options — revealUnknownSection computed them; a flat typeahead → combobox, a tree → widget_type "hierarchical" → tier editor
        container_prefix: prefix, section_heading: heading || null, section_known: false
      });
    }
  }

  // (Nested repeating sub-sections — cert ▸ Specialties + Attachments — are emitted per SURVIVING
  // parent entry INSIDE driveRepeatingSectionCdp from the HARDCODED section.nested config, DURING the
  // fill. No generic post-fold nested scan/reveal here — Certifications is the only observed nested
  // section; a new tenant with a different one gets its own config entry.)

  // ── M1 CASCADE RE-SCAN-AFTER-CHANGE ── a committed value can REVEAL new fields (Magna
  // recon 2026-06-29: changing Country revealed 2 "Cyrillic name" text fields ~5.6s later,
  // and HID "State"). The single up-front scan misses them, so they never fill / never enter
  // the bundle. Here we re-scan after the fold and fill any NEW flat field through the
  // IDENTICAL deterministic→AI ladder by re-invoking drivePageFill with `onlyFieldNames`
  // (the AI-4 targeted-refill path — NO duplicated fill logic). Each revealed record is
  // tagged `cascadeRevealed` so the submit replay can force a second review.
  // PERFORMANCE (the operator's constraint): BYTE-IDENTICAL when nothing is revealed — the
  // only cost is ONE read-only act.scanPage() per round (no actuation, NO fixed wait). The
  // ~5.6s reveal latency is absorbed by the fill work that already ran after the triggering
  // field, so by here the reveal is usually already mounted; the loop re-scans after each
  // fill round to catch a chained reveal, bounded by maxCascadeRounds. SKIPPED under `only`
  // (a targeted re-fill never needs to cascade — same gate as the fold/audit above).
  if (!targeted) {
    const seen = new Set(scan.fields.map((f) => f.fieldName)); // flat fields already processed up front
    for (let round = 0; round < budgets.maxCascadeRounds; round++) {
      let reFields;
      try { reFields = (await act.scanPage()).fields || []; } catch (e) { break; } // re-scan blip → stop (non-fatal)
      const revealed = reFields.filter((f) => !seen.has(f.fieldName));
      if (!revealed.length) break; // nothing new (the common case) → done, zero extra work
      const revealedNames = new Set(revealed.map((f) => f.fieldName));
      revealed.forEach((f) => seen.add(f.fieldName)); // mark BEFORE filling → a field is never re-triggered (termination is guaranteed: seen grows, the field set is finite)
      try {
        const sub = await drivePageFill(act, profile, defaults, jobContext, budgetsIn, { onlyFieldNames: revealedNames });
        for (const r of (sub && sub.results) || []) {
          r.cascadeRevealed = true; // provenance: appeared only AFTER a value committed → the submit gate forces a re-review
          r.detail = (r.detail ? r.detail + " | " : "") + "REVEALED by an earlier field's value (cascade re-scan)";
          results.push(r);
        }
      } catch (e) { /* a revealed-field fill threw → don't abort the whole page; next round / honest miss */ }
    }
  }

  // ── CASCADE-REMOVED reconciliation ── a field present in the UP-FRONT scan but now GONE
  // from the DOM (DELETED by an earlier field's value — e.g. Country=Afghanistan removes the
  // dependent "State" dropdown, docs/dom-patterns.md 2026-06-03) records a MISLEADING
  // needs_review ("options did not render") because fillDropdownCdp reached a trigger that no
  // longer exists. Reclassify such a field status:"removed" so it DROPS from the summary /
  // counts / review entirely (it's deleted, not an error). DOM-ABSENCE is the reliable signal
  // (not the render-failure detail): a still-present failed field (genuine no-match / transient
  // render flake) is left untouched + flagged. filled/filled_review are EXCLUDED here — a
  // filled-THEN-removed field is the M40 audit's audit-unverifiable job. Runs BEFORE the audit
  // so a removed field never reaches it. SKIPPED under `only` (a targeted re-fill never cascades).
  if (!targeted) {
    const upFront = new Set(scan.fields.map((f) => f.fieldName));
    const candidates = results.filter((r) => upFront.has(r.fieldName) && (r.status === "needs_review" || r.status === "error" || r.status === "skipped"));
    if (candidates.length) {
      let present = null;
      try { present = new Set(((await act.scanPage()).fields || []).map((f) => f.fieldName)); } catch (e) { present = null; }
      // GUARD: only relabel if the rescan returned a NON-EMPTY field list — a transient empty/
      // failed scan must NEVER mass-relabel live fields as removed.
      if (present && present.size > 0) {
        for (const r of candidates) {
          if (!present.has(r.fieldName)) {
            r.status = "removed";
            r.flag = "cascade-removed";
            r.detail = (r.detail ? r.detail + " | " : "") + "field deleted by an earlier field's value — treated as deleted (dropped from review)";
          }
        }
      }
    }
  }

  // ── AI TYPEAHEAD FALLBACK is now INLINE (Option B) ── a typeahead that GENUINELY no-matches hands the
  // captured option list + profile to the LLM and commits its pick ON THE OPEN FIELD right then, inside
  // fillTypeaheadCdp's no-match exit (gated on opts.ai — passed by the flat loop above + fillEntryCdp for
  // non-cert typeaheads). No end-of-page pass: by the time we reach here, every typeahead is already
  // resolved (filled_review on an AI commit, or an honest needs_review). The committed values are in
  // `results` BEFORE the M40 audit snapshot below, so the audit still re-reads them. AI OFF ⇒ no-op
  // (the no-match exits Tab-blur as before). runAiTypeaheadPass is retained for unit tests only.

  // M40 post-fill page AUDIT (inline backstop): after the WHOLE page has settled, re-read
  // every field that claims a value + reconcile vs what it recorded. Catches a value clobbered
  // AFTER its own fill (cross-field / delayed reset) that per-field verify can't see. A mismatch
  // → needs_review/audit-mismatch (after = the live truth); unre-readable → audit-unverifiable.
  // `auditEntries` (expected = the value just filled, BEFORE any mutation) is returned for the SW
  // to persist (the standalone re-audit). Flag-only — never auto-refills.
  // (AI-4 targeted re-fill skips the inline audit — the remediation's Save & Continue retry verifies.)
  const auditEntries = targeted ? [] : auditEntriesFromResults(results);
  // Summary editability: scrape the full option list for choice fields that lack one (tagged FoS
  // typeaheads + prefilled-kept dropdowns) into the records — at END OF PAGE (fields settled/closed →
  // reliable fresh re-open) and BEFORE the M40 audit (which re-reads each value + backstops any stray).
  if (!targeted) await captureChoiceOptions(act, results, budgets);
  if (!targeted) { const auditVerdicts = await reconcileAudit(act, auditEntries, budgets, { refillOnMismatch: true }); applyAuditVerdicts(results, auditVerdicts); }

  // ── ALREADY-FILLED sweep — the LAST pass before the bundle (source-of-truth ordering) ── the
  // review must inventory EVERYTHING the page holds at the moment Save & Continue is clicked: a
  // `skipped` record whose field HOLDS a live value (Workday account pre-fill / operator / prior
  // run) is surfaced with the value + flagged "already-filled" (needs_review) — or
  // "already-filled-match" (no flag) when it equals the profile's own value. Unmapped KNOWN-section
  // fields with values get NEW records; NESTED records re-read via their probed auditLoc. Read-only.
  // Deliberately AFTER the option capture + M40 audit (both actuate: capture opens/closes lists,
  // the audit can self-heal re-fill) so the captured values are the page's FINAL state — the two
  // passes touch disjoint records (audit = bot-filled only; both already-filled flags audit-excluded,
  // so nothing here is ever re-actuated: the fluent-checkbox lesson). Skipped in BOTH targeted
  // modes (onlyFieldNames / onlySections) — a remediation re-fill never re-inventories the page.
  if (!targeted) { try { await sweepAlreadyFilled(act, results); } catch (e) { /* completeness pass — never abort the page */ } }

  const counts = results.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
  const needsReview = results.filter((r) => r.status === "needs_review" || r.status === "filled_review");
  // M30 session-expiry EARLY-WARNING (heuristic, SOURCE-ONLY): if this page has the
  // `source` field and its options never loaded (server fetch failed), a dead/expired
  // session is likely. A NOTE, never a halt — and ONLY on pages WITH a source field
  // (this is NOT general session detection; a page without source gets no warning).
  // The UNAMBIGUOUS detector (VPS errors on Save & Continue) is the page-advance round.
  const srcRec = results.find((r) => r.widgetType === "hierarchical");
  const sessionWarning = (srcRec && srcRec.status === "needs_review" && srcRec.optionsLoaded === false)
    ? "Likely session expired — the \"How did you hear about us?\" options never loaded (server fetch failed). Refresh, log in, and reopen the form, then retry."
    : null;
  return { url: scan.url, repeatingFieldCount: scan.repeatingFieldCount || 0, results, counts, needsReview, sessionWarning, audit: auditEntries, sectionShapes };
}

// ============================================================================
// M32 — repeating-section fill on the CDP substrate.
//
// Port of background.js fillRepeatingSection (~3447) + fillMappedEntry (~3605).
// Substrate-agnostic (talks ONLY to `act`): reconciles the live entry count to
// items.length (Add up via clickSectionAdd / Delete trailing extras down via
// clickDeleteEntry, count-polled off-loop), then fills each entry's mapped fields
// through the EXISTING per-widget CDP handlers with ENTRY-SCOPED composed selectors
// (act.repeatingScan emits fd.wrapperSel = `[data-fkit-id="…"] [data-automation-id=
// "formField-…"]` — the duplicate-formField-id rule).
//
// DATE/YEAR fields fill via fillDateCompositeCdp (M34 composite, wired in M36): a
// "YYYY" string (year-only) or { month, year, day } (M/D/Y). (The M32-era
// cdp-date-deferred skip was removed once M33/M34 proved the date segments ARE
// actuatable — triple-click the visible -display + per-char type, NO Ctrl+A.)
//
// Returns the same envelope drivePageFill returns, so the harness report code is
// shared. Proven on Websites (date-free, one url text field/entry); the other
// sections (Languages/Education/Certs/WE) reuse this driver in later rounds.
//
// TODO(dup): WEBSITE_MAP + LANGUAGE_MAP mirror background.js (~3571 / ~3780). EDUCATION/
// CERTIFICATION are NOT ported yet — they need the deferred date path. Change in lockstep
// with the in-tree maps.
// ============================================================================
const WEBSITE_MAP = [{ field: "url", widget: "text", key: "url", path: "url" }];

// M35 — Languages (date-free). language dropdown + 3 proficiency dropdowns resolved BY LABEL
// (hashed `formField-5aaaed…` ids that are IDENTICAL across entries — resolution MUST stay
// entry-scoped: fillEntryCdp finds the labelRegex match within THIS entry's fields and fills
// through the fkit-prefixed composed wrapperSel) + the "I am fluent" checkbox. deleteOnNoMatch.
const LANGUAGE_MAP = [
  { field: "language", widget: "dropdown", key: "language", path: "language" },
  { labelRegex: /reading proficiency/i, name: "readingProficiency", widget: "dropdown", key: "reading", path: "reading" },
  { labelRegex: /speaking proficiency/i, name: "speakingProficiency", widget: "dropdown", key: "speaking", path: "speaking" },
  { labelRegex: /writing proficiency/i, name: "writingProficiency", widget: "dropdown", key: "writing", path: "writing" },
  // LAST for safety-in-principle: fill + record the proficiencies BEFORE touching the checkbox.
  // (Recon MutationObserver: on Magna the proficiency dropdowns STAY visible + interactive when
  // "I am fluent" is checked — no hide — so the order is harmless either way; NOT because checking
  // it hides them.) `_allFluent` is SW-computed by prepareProfile (isFluent × 3).
  { field: "native", widget: "checkbox", key: "_allFluent", path: "_allFluent" }
];

// M36 — Education (year-only dates) + Certifications (M/D/Y dates). TODO(dup) ↔ background.js
// EDUCATION_MAP (~2919) / CERTIFICATION_MAP (~2949). `degree`/`field_of_study` are PROFILE-side
// tiered arrays (resolve→candidates); the year/date keys are SW-parsed by prepareProfile
// (fromYearParsed/toYearParsed = parseYear; issuedDateParsed/expirationDateParsed = parseYearMonthDay)
// and filled by the now-un-deferred date branch via fillDateCompositeCdp.
const EDUCATION_MAP = [
  { field: "schoolName", widget: "text", key: "school_or_university", path: "school_or_university" },
  { field: "degree", widget: "dropdown", key: "degree", path: "degree" },
  { field: "fieldOfStudy", widget: "typeahead", key: "field_of_study", path: "field_of_study", captureOptions: true }, // FoS Round 3: scrape the full option list into the bundle → summary searchable editor
  { field: "gradeAverage", widget: "text", key: "gpa", path: "gpa" },
  { field: "firstYearAttended", widget: "year", key: "fromYearParsed", path: "from_year" },
  { field: "lastYearAttended", widget: "year", key: "toYearParsed", path: "to_year" }
];
const CERTIFICATION_MAP = [
  { field: "certification", widget: "typeahead", key: "certification", path: "certification" },
  { field: "certificationNumber", widget: "text", key: "certification_number", path: "certification_number" },
  { field: "issuedDate", widget: "date", key: "issuedDateParsed", path: "issued_date" },
  { field: "expirationDate", widget: "date", key: "expirationDateParsed", path: "expiration_date" }
];

// M37 — Work Experience (the bespoke section, via the same config-driven fillEntryCdp).
// `currentlyWorkHere` is FIRST — it controls whether the endDate "To" box exists; the
// checkbox reconcile settles the subtree before the dates. `endDate` carries skipWhen
// (currently_work_here → Workday removes the To box, no actuation) AND waitForPresence
// (when UNchecking, the To box REMOUNTS → POLL until present, never a fixed wait — M29).
// `roleDescription` is a <textarea> (recon 2026-06-18: coordinate-click focus +
// Input.insertText drives it, newline-intact + React-surviving). from/to are M/Y dates
// (parseYearMonth → {year,month}, no day). TODO(dup): the page engine's
// fillWorkExperienceEntry is bespoke (not this config shape) — keep INTENT in lockstep,
// not 1:1. prepareProfile (background.js) provides fromParsed/toParsed + bulletsText.
const WORK_EXPERIENCE_MAP = [
  { field: "currentlyWorkHere", widget: "checkbox", key: "currently_work_here", path: "currently_work_here" },
  { field: "jobTitle", widget: "text", key: "job_title", path: "job_title" },
  { field: "companyName", widget: "text", key: "company", path: "company" },
  { field: "location", widget: "text", key: "location", path: "location" },
  { field: "startDate", widget: "date", key: "fromParsed", path: "from" },
  { field: "endDate", widget: "date", key: "toParsed", path: "to",
    skipWhen: (i) => i.currently_work_here === true,
    skipDetail: "currently_work_here = true → no end date (To box removed)",
    todayIfStuckRequired: true, waitForPresence: true },
  { field: "roleDescription", widget: "textarea", key: "bulletsText", path: "role_description" }
];

// M38 — section registry for the FOLD. `drivePageFill` drives each PRESENT repeating
// section after the flat fields → ONE call = a full page fill. One entry per page-2
// section; values mirror the five per-section runners (Languages/Certs
// deleteOnNoMatch:true, the rest false). `itemsKey` reads the PREPARED profile array
// (work_experience/education/languages/certifications/websites). Registry order = fill
// order; sections are independent + entry-scoped (any cross-section effect is caught by
// the oracle comparison, not relied upon).
// HARDCODED nested sub-section config for Certifications (the only Workday section with repeating-
// inside-repeating we've observed — see the Specialty recon 2026-06-18). No generic nested scanner:
// the shape is a constant, so it surfaces in review + is addable even for a cert deleteOnNoMatch
// removes, at zero scan cost. specialtyParent is a typeahead with no captured options → the summary's
// tier editor ("values to try"); a new tenant with a different nested section gets its own config.
const CERT_NESTED = {
  subSections: [
    { childBase: "specialties", heading: "Specialties", headingStem: "specialt", itemsKey: "specialties",
      // `fields` = the recon SHAPE (for the review stub/add-entry); `fieldMap` = the FILL map (profile →
      // form) consumed by fillNestedSpecialtiesCdp. specialty → the specialtyParent typeahead (inline AI
      // fixes a typo like "otherrrr" → "Other"); start/end dates are M/D/Y, SKIPPED when the profile omits them.
      fields: [
        { recName: "specialtyParent", widget_type: "typeahead", label: "Specialty", is_required: true },
        { recName: "startDate", widget_type: "date", label: "Start Date", is_required: false, date_order: ["month", "day", "year"] },
        { recName: "endDate", widget_type: "date", label: "End Date", is_required: false, date_order: ["month", "day", "year"] }
      ],
      fieldMap: [
        // required: the row's PICK (label "Specialty*") — drives the proactive nested deleteOnNoMatch
        { field: "specialtyParent", widget: "typeahead", key: "specialty", path: "specialtyParent", required: true },
        // date_order → the record → the summary's SEGMENTED MM/DD/YYYY editor (not a text box)
        { field: "startDate", widget: "date", key: "startDateParsed", path: "startDate", date_order: ["month", "day", "year"] },
        { field: "endDate", widget: "date", key: "endDateParsed", path: "endDate", date_order: ["month", "day", "year"] }
      ] }
  ],
  attachments: true
};

const PAGE_SECTIONS = [
  { name: "workExperience", headingRegex: "work experience", containerPrefix: "workExperience-", itemsKey: "work_experience", fieldMap: WORK_EXPERIENCE_MAP, deleteOnNoMatch: false },
  { name: "education", headingRegex: "education", containerPrefix: "education-", itemsKey: "education", fieldMap: EDUCATION_MAP, deleteOnNoMatch: false },
  { name: "certification", headingRegex: "certifications?", containerPrefix: "certification-", itemsKey: "certifications", fieldMap: CERTIFICATION_MAP, deleteOnNoMatch: true, nested: CERT_NESTED },
  { name: "language", headingRegex: "languages?", containerPrefix: "language-", itemsKey: "languages", fieldMap: LANGUAGE_MAP, deleteOnNoMatch: true },
  { name: "website", headingRegex: "websites?|web ?address", containerPrefix: "webAddress-", itemsKey: "websites", fieldMap: WEBSITE_MAP, deleteOnNoMatch: false }
];

// AI-4 Tier-1.5 (DETERMINISTIC, no AI): which KNOWN repeating sections do these error-named field
// titles belong to? Tier-1's flat FIELD_MAP can't reach section fields — the live miss (2026-07-01)
// was "The field Specialty is required" naming the NESTED cert specialtyParent, which is neither in
// the flat scan (isRepeating excludes fkit-entry fields) nor in FIELD_MAP, so remediation had no
// executable action. This maps the parsed titles to their OWNING section(s) so remediatePageErrors
// can re-run JUST those sections via drivePageFill({onlySections}) — reconcile-to-N + re-fill.
// A name hits a section when it matches the section heading, a fieldMap labelRegex, a camelCase
// field name split to words ("specialtyParent" → "specialty parent"), or a nested sub-section's
// human field label ("Specialty"). Bidirectional containment after normalization (mirrors
// mappedFieldsFromErrors' loose-but-harmless rule: a section re-fill is idempotent — reconcile +
// re-filling correct values is a no-op-shaped write, and every record is flagged for review).
// `names` = parseErrorFieldName outputs; returns PAGE_SECTIONS `name`s, registry order.
// (normTitle/camelWords/titleContains are shared with deleteTargetsFromErrorNames below.)
const normTitle = (s) => String(s == null ? "" : s).toLowerCase()
  .replace(/\(\s*\)/g, " ")                 // "Specialty ()" → "Specialty" (empty parens = a blank template slot)
  .replace(/[*\s]+$/, "").replace(/\s+/g, " ").trim();
const camelWords = (s) => normTitle(String(s || "").replace(/([a-z])([A-Z])/g, "$1 $2"));
const titleContains = (a, b) => !!(a && b && (a === b || a.includes(b) || b.includes(a)));
function sectionsFromErrorNames(names) {
  const norm = normTitle, words = camelWords, contains = titleContains;
  const nList = (Array.isArray(names) ? names : []).map(norm).filter((n) => n && n.length >= 3); // <3 chars = too generic to anchor a section re-run
  if (!nList.length) return [];
  const out = [];
  for (const sec of PAGE_SECTIONS) {
    const headRe = new RegExp(sec.headingRegex, "i");
    const corpus = [];
    const regexes = [];
    for (const f of (sec.fieldMap || [])) {
      if (f.field) corpus.push(words(f.field));
      if (f.labelRegex) regexes.push(f.labelRegex);
    }
    for (const ss of ((sec.nested && sec.nested.subSections) || [])) {
      if (ss.heading) corpus.push(norm(ss.heading));
      for (const rf of (ss.fields || [])) if (rf.label) corpus.push(norm(rf.label));
      for (const f of (ss.fieldMap || [])) if (f.field) corpus.push(words(f.field));
    }
    if (nList.some((n) => headRe.test(n) || regexes.some((re) => re.test(n)) || corpus.some((c) => contains(c, n)))) {
      out.push(sec.name);
    }
  }
  return out;
}

// AI-4 Tier-1.5 (DETERMINISTIC DELETE — operator rule 2026-07-02): which repeating-section FIELDS do
// these error-named titles point at? A repeating section is OPTIONAL by nature (rows are removable),
// so a row that blocks Save & Continue is deletable — the executor (deleteEmptyErrorRows) deletes
// only rows whose named field reads EMPTY (that's what "is required and must have a value" points
// at; a row the operator hand-FILLED never reads empty, so it's never deleted). A name matching a
// NESTED (layer-2) sub-section field targets ONLY the inner rows (cert ▸ specialties) — never the
// parent entry (deleting the cert to fix a specialty would destroy good data). Cross-section
// ambiguity (e.g. "Start Date" = WE's startDate AND the nested specialty startDate) returns BOTH
// targets — safe, because the empty-only rule self-limits each to genuinely blocking rows.
// Returns [{kind:"entry"|"nested", section, containerPrefix, childBase?, fields:[{field,widget,labelRegex?}]}].
function deleteTargetsFromErrorNames(names) {
  const nList = (Array.isArray(names) ? names : []).map(normTitle).filter((n) => n && n.length >= 3);
  if (!nList.length) return [];
  const matches = (label, field, labelRegex) => nList.some((n) =>
    (labelRegex && labelRegex.test(n)) ||
    (label && titleContains(normTitle(label), n)) ||
    (field && titleContains(camelWords(field), n)));
  const out = [];
  for (const sec of PAGE_SECTIONS) {
    // NESTED (layer-2) sub-sections — labels come from the config's `fields` (recName-joined)
    for (const ss of ((sec.nested && sec.nested.subSections) || [])) {
      const hit = [];
      for (const fm of (ss.fieldMap || [])) {
        const rf = (ss.fields || []).find((x) => x.recName === fm.field);
        if (matches(rf && rf.label, fm.field, null)) hit.push({ field: fm.field, widget: fm.widget });
      }
      if (hit.length) out.push({ kind: "nested", section: sec.name, containerPrefix: sec.containerPrefix, childBase: ss.childBase, fields: hit });
    }
    // TOP-LEVEL section fields
    const flat = (sec.fieldMap || []).filter((fm) => matches(null, fm.field, fm.labelRegex || null))
      .map((fm) => ({ field: fm.field || null, widget: fm.widget, labelRegex: fm.labelRegex || null }));
    if (flat.length) out.push({ kind: "entry", section: sec.name, containerPrefix: sec.containerPrefix, fields: flat });
  }
  return out;
}

// The Tier-1.5 executor: delete repeating rows whose error-named field reads EMPTY on the live page.
// kind:"entry" → top-level entries via clickDeleteEntry (highest ordinal first — lower indices stay
// valid); kind:"nested" → layer-2 child rows via clickNestedDelete (parent entry NEVER deleted; the
// child's named field is read through the PROBED nested selector — unreadable ⇒ untouched, never a
// blind delete). Every delete is count-polled; a click that doesn't drop the count halts the loop
// (no-progress, don't spin the bound). Returns { deleted: [{section, kind, index, parentIndex?, child?}] }.
async function deleteEmptyErrorRows(act, targets, budgets) {
  const deleted = [];
  const ceiling = (budgets && budgets.entryReconcileCeilingMs) || 4000;
  const interval = (budgets && budgets.entryReconcileIntervalMs) || 150;
  for (const t of (Array.isArray(targets) ? targets : [])) {
    if (t.kind === "entry") {
      let scan = null; try { scan = await act.repeatingScan(); } catch (e) { scan = null; }
      const s = scan && scan.sections ? scan.sections[t.containerPrefix] : null;
      if (!s || !Array.isArray(s.entries)) continue;
      const emptyIdxs = [];
      for (let i = 0; i < s.entries.length; i++) {
        const fields = (s.entries[i] && s.entries[i].fields) || [];
        const anyEmpty = t.fields.some((fm) => {
          const fd = fm.labelRegex ? fields.find((x) => fm.labelRegex.test(x.label || "")) : fields.find((x) => x.fieldName === fm.field);
          return fd && !hasLiveValue(fd.value);
        });
        if (anyEmpty) emptyIdxs.push(i);
      }
      for (const idx of emptyIdxs.slice().sort((a, b) => b - a)) {
        const before = await act.entryCount(t.containerPrefix);
        if (before <= 0) break;
        const del = await act.clickDeleteEntry(t.containerPrefix, idx);
        if (!del || !del.ok) break;
        let now = before; const deadline = Date.now() + ceiling;
        while (Date.now() < deadline) { await act.delay(interval); now = await act.entryCount(t.containerPrefix); if (now < before) break; }
        if (now >= before) break; // no progress → stop
        deleted.push({ section: t.section, kind: "entry", index: idx });
      }
    } else if (t.kind === "nested" && act.nestedScan && act.clickNestedDelete) {
      const enumerate = async () => {
        let ns = null; try { ns = await act.nestedScan(); } catch (e) { return []; }
        const rows = [];
        for (const n of ((ns && ns.nestedSections) || [])) {
          if (n.parentBase !== t.section || n.childBase !== t.childBase) continue;
          for (const ent of (n.entries || [])) {
            const lv = ent.levels || []; if (lv.length < 2) continue;
            rows.push({ pIdx: lv[0].index, cIdx: lv[lv.length - 1].index });
          }
        }
        return rows;
      };
      const rows = await enumerate();
      const empties = [];
      for (const row of rows) {
        for (const f of t.fields) {
          const childFkit = t.section + "-" + row.pIdx + "--" + t.childBase + "-" + row.cIdx + "--" + f.field;
          let sel = null;
          if (act.nestedFieldSel) { try { sel = await act.nestedFieldSel(childFkit, f.field); } catch (e) { sel = null; } }
          else sel = '[data-fkit-id="' + childFkit + '"] [data-automation-id="formField-' + f.field + '"]';
          if (!sel) continue; // can't resolve → can't read → NEVER delete blind
          const v = await readLiveValueByWidget(act, f.widget, { wrapperSel: sel });
          if (!hasLiveValue(v)) { empties.push(row); break; }
        }
      }
      for (const row of empties.sort((a, b) => b.cIdx - a.cIdx)) {
        const before = (await enumerate()).length;
        if (!before) break;
        const del = await act.clickNestedDelete(t.section + "-" + row.pIdx + "--null", t.childBase, row.cIdx);
        if (!del || !del.ok) break;
        let now = before; const deadline = Date.now() + ceiling;
        while (Date.now() < deadline) { await act.delay(interval); now = (await enumerate()).length; if (now < before) break; }
        if (now >= before) break;
        deleted.push({ section: t.section, kind: "nested", child: t.childBase, parentIndex: row.pIdx, index: row.cIdx });
      }
    }
  }
  return { deleted };
}

// Today's date as a {month, day, year} composite — the WE "currently_work_here but the required
// To box didn't disappear" fallback (a blank required field would block Save & Continue). SW/Node
// runtime (not the Workflow sandbox), so new Date() is fine.
function todayYMD() {
  const d = new Date();
  return { month: String(d.getMonth() + 1), day: String(d.getDate()), year: String(d.getFullYear()) };
}

// Fill one entry's mapped fields. Re-reads act.repeatingScan() FRESH per field — a
// commit can re-render the entry subtree and orphan a held descriptor (the recon's
// core warning). Resolves the field by automation-id (`f.field`) OR by label
// (`f.labelRegex`, for hashed ids — Languages). Records use the SAME shape as
// drivePageFill so the report/table code is shared.
async function fillEntryCdp(act, prefix, idx, item, fieldMap, sectionName, budgets, aiCtx) {
  const recs = [];
  const base = sectionName + "[" + idx + "].";
  // FILL IN DOM ORDER (operator rule 2026-07-02): iterate the ENTRY'S scanned fields top-to-bottom
  // and fill each via its fieldMap entry — the human order the form lays out (Languages: language →
  // "I am fluent" → the proficiencies), NOT config order. Map entries the scan didn't show (a
  // remount-later field like WE endDate, a conditional) run AFTER, in config order — their
  // waitForPresence/skipWhen semantics are unchanged (the per-field body below re-scans anyway).
  // Detected from the live DOM each fill; a scan hiccup falls back to config order (today's
  // behavior). NOTE the assumption a controlling checkbox precedes what it controls in the DOM
  // (Workday lays "I currently work here" above the To date on every observed tenant) — the same
  // top-to-bottom order a human fills in.
  let orderedMap = fieldMap;
  try {
    const scan0 = await act.repeatingScan();
    const ent0 = scan0 && scan0.sections && scan0.sections[prefix] && Array.isArray(scan0.sections[prefix].entries) ? scan0.sections[prefix].entries[idx] : null;
    if (ent0 && Array.isArray(ent0.fields) && ent0.fields.length) {
      const used = new Set(); const inDom = [];
      for (const fd of ent0.fields) {
        const fm = fieldMap.find((m) => !used.has(m) && (m.labelRegex ? m.labelRegex.test(fd.label || "") : m.field === fd.fieldName));
        if (fm) { used.add(fm); inDom.push(fm); }
      }
      if (inDom.length) orderedMap = inDom.concat(fieldMap.filter((m) => !used.has(m)));
    }
  } catch (e) { /* no scan → config order */ }
  for (const f of orderedMap) {
    const recName = f.name || f.field;
    const findFd = (entry) => entry ? (f.labelRegex
      ? entry.fields.find((x) => f.labelRegex.test(x.label || ""))
      : entry.fields.find((x) => x.fieldName === f.field)) : null;
    const scanFd = async () => {
      const scan = await act.repeatingScan();
      const sec = scan && scan.sections ? scan.sections[prefix] : null;
      return findFd(sec && sec.entries ? sec.entries[idx] : null);
    };
    // M37 skipWhen: a conditional field (WE endDate when currentlyWorkHere is checked →
    // Workday removes the "To" box). It SHOULD vanish → record skipped. BUT a `todayIfStuckRequired`
    // field VERIFIES that: if the box did NOT get removed and is STILL required, a blank required
    // field would block Save & Continue → fall back to TODAY's date (operator decision; flagged
    // for review), never a blind skip.
    if (f.skipWhen && f.skipWhen(item)) {
      let fd = f.todayIfStuckRequired ? await scanFd() : null;
      // The box-removal is async after the checkbox commit — give it a bounded beat; the loop
      // exits the instant the field is gone (the common case = no added latency).
      if (fd && f.todayIfStuckRequired) {
        const t0 = Date.now();
        while (fd && Date.now() - t0 < budgets.entryReconcileCeilingMs) { await act.delay(budgets.entryReconcileIntervalMs); fd = await scanFd(); }
      }
      if (fd && fd.isRequired) {
        // STILL present + required → today's date so it can't block the walk (flagged to verify).
        const today = todayYMD();
        const rec = {
          fieldName: base + recName, label: fd.label, widgetType: "date", isRequired: true,
          mappedPath: base + f.path, rawValue: item[f.key] === undefined ? null : item[f.key],
          resolved: today, status: null, matchTier: null, confidence: null, flag: null, verified: null, after: null, detail: null,
          auditLoc: fd.wrapperSel
        };
        Object.assign(rec, await fillDateCompositeCdp(act, { wrapperSel: fd.wrapperSel }, today, budgets));
        if (rec.status === "filled") rec.status = "filled_review";
        rec.flag = "we-currentwork-today";
        rec.detail = "currently_work_here = true but the required To box did not disappear — filled TODAY's date (verify)";
        recs.push(rec); await act.delay(budgets.interFieldMs); continue;
      }
      // box removed (or present-but-optional) → the original ZERO-actuation skip
      recs.push({
        fieldName: base + recName, label: null, widgetType: f.widget === "year" ? "date" : f.widget,
        isRequired: false, mappedPath: base + f.path, rawValue: item[f.key] === undefined ? null : item[f.key],
        resolved: null, status: "skipped", matchTier: null, confidence: null, flag: null, verified: null, after: null,
        detail: f.skipDetail || "skipped (skipWhen)"
      });
      await act.delay(budgets.interFieldMs); continue;
    }
    let fd = await scanFd();
    // M37 waitForPresence: a field that REMOUNTS (WE endDate after UNchecking
    // currentlyWorkHere) — POLL until present (bounded), NEVER a fixed wait (the M29
    // poll-until-ready lesson: a sleep races the remount on the throttled hidden loop).
    if (!fd && f.waitForPresence) {
      const t0 = Date.now();
      while (!fd && Date.now() - t0 < budgets.entryReconcileCeilingMs) { await act.delay(budgets.entryReconcileIntervalMs); fd = await scanFd(); }
    }
    const rec = {
      fieldName: base + recName, label: fd ? fd.label : null,
      widgetType: f.widget === "year" ? "date" : f.widget,
      isRequired: fd ? !!fd.isRequired : false, mappedPath: base + f.path,
      rawValue: item[f.key] === undefined ? null : item[f.key], resolved: null,
      status: null, matchTier: null, confidence: null, flag: null, verified: null, after: null, detail: null
    };
    if (!fd) {
      rec.status = "error"; rec.detail = "field wrapper not found in entry";
      recs.push(rec); await act.delay(budgets.interFieldMs); continue;
    }
    const loc = { wrapperSel: fd.wrapperSel };
    rec.auditLoc = fd.wrapperSel; // M40: retain the entry-scoped locator for the post-fill audit re-read
    rec.auditTag = f.widget === "textarea" ? "textarea" : undefined;
    if (f.widget === "year" || f.widget === "date") { const ord = dateOrderOf(fd.dateSegments); if (ord.length) rec.date_order = ord; } // m3c: form's segment order → the summary's segmented date editor (all date fields, not just revealed ones)
    // FoS Round 3: tag so the END-OF-PAGE option-capture pass can find this record (captureKey groups
    // same-vocabulary fields across entries → one scrape). Captured at end-of-page, NOT inline — an
    // inline scrape races the field's post-commit settle (empty scrape) / corrupts the commit.
    if (f.captureOptions) { rec.captureOptions = true; rec.captureKey = f.field || String(f.labelRegex); }
    try {
      if (f.widget === "year" || f.widget === "date") {
        // M36: fill via the M34 date composite. item[f.key] is SW-parsed — a "YYYY"
        // string (year-only) or { month, year, day } (M/D/Y); fillDateCompositeCdp
        // accepts both. Skip cleanly when there's no value (matches the page engine).
        const parsed = item[f.key];
        if (!parsed) { rec.status = "skipped"; rec.detail = "no valid date at " + base + f.path; }
        else { rec.resolved = parsed; Object.assign(rec, await fillDateCompositeCdp(act, loc, parsed, budgets)); }
      } else if (f.widget === "checkbox") {
        rec.resolved = item[f.key] === true;
        Object.assign(rec, await fillCheckboxCdp(act, loc, item[f.key] === true, budgets));
      } else {
        // textarea (WE roleDescription) resolves like text — a plain string (bulletsText).
        const r = resolve(item[f.key], f.widget === "textarea" ? "text" : f.widget);
        if (r.skip) {
          rec.status = "skipped";
          rec.detail = r.reason || ("empty value at " + base + f.path);
        } else {
          const arg = r.value !== undefined ? r.value : r.candidates;
          rec.resolved = arg;
          if (f.widget === "text") Object.assign(rec, await fillTextCdp(act, loc, arg, budgets));
          else if (f.widget === "textarea") Object.assign(rec, await fillTextCdp(act, loc, arg, budgets, "textarea")); // M37: roleDescription textarea
          else if (f.widget === "dropdown") Object.assign(rec, await fillDropdownCdp(act, loc, arg, budgets));
          else if (f.widget === "typeahead") {
            // Fix 2: start-of-fill option capture for EVERY section typeahead (was FoS-only). makeStartCapture
            // scrapes the full leaf list at the START for a FLAT field (FoS → rec.options for the summary
            // searchable picker + the flat AI), and returns null for a TREE (cert) — no wasted scroll on a
            // successful fill; the AI tree drill self-scrapes categories + leaves only on a no-match. The END-OF-
            // PAGE pass (captureChoiceOptions) still backstops a tier-0 prefilled-kept FLAT field (never reaches
            // onCapture) via the rec.captureOptions tag.
            const cap = makeStartCapture(act, loc);
            // Inline AI rescue context (Option B) — passed for ALL section typeaheads (incl. the cert TREE).
            // tryInlineAi decides tree-vs-flat structurally (category rows on the open field) → the unified tree
            // drill for cert, the flat single-prompt for FoS. EEO allowed (re-tagged inside).
            const aiForField = aiCtx
              ? { profile: aiCtx.profile, jobContext: aiCtx.jobContext, fieldName: rec.fieldName, label: rec.label, isRequired: rec.isRequired }
              : undefined;
            Object.assign(rec, await fillTypeaheadCdp(act, loc, arg, budgets, { onCapture: cap.onCapture, ai: aiForField }));
            const ro = cap.reviewOptions(); if (ro && ro.length) rec.options = ro;
          }
          else if (f.widget === "radio") Object.assign(rec, await fillRadioCdp(act, loc, arg, budgets));
          else { rec.status = "skipped"; rec.detail = "no handler for widget " + f.widget; }
        }
      }
    } catch (e) {
      rec.status = "error"; rec.detail = String(e);
    }
    // Required-EMPTY TYPEAHEAD AI fill (section analog of the flat-loop block): a REQUIRED section typeahead with
    // no profile value (e.g. an Education entry's fieldOfStudy) is SKIPPED above, but a blank required field BLOCKS
    // Save & Continue. When AI is on, run the unified filler with NO candidates → the inline AI infers from the
    // profile (no stated answer) + FORCES a pick + flags. AI OFF → stays skipped. (NOT the deleteOnNoMatch cert
    // case — that path deletes an unfillable entry; this only fires for status `skipped`, i.e. no value to try.)
    if (aiCtx && act.aiEnabled && rec.isRequired && rec.status === "skipped" && f.widget === "typeahead") {
      try {
        const loc2 = { wrapperSel: rec.auditLoc };
        const cap = makeStartCapture(act, loc2);
        Object.assign(rec, await fillTypeaheadCdp(act, loc2, [], budgets,
          { onCapture: cap.onCapture, ai: { profile: aiCtx.profile, jobContext: aiCtx.jobContext, fieldName: rec.fieldName, label: rec.label, isRequired: true } }));
        const ro = cap.reviewOptions(); if (ro && ro.length) rec.options = ro;
      } catch (e) { rec.status = "needs_review"; rec.flag = "ai-error"; rec.detail = "AI required-empty typeahead error: " + String((e && e.message) || e); }
    }
    recs.push(rec);
    await act.delay(budgets.interFieldMs);
  }
  return recs;
}

// Fill ONE parent entry's NESTED repeating sub-section (cert ▸ Specialties) from the profile. Reconcile
// the child entries to N (mount/delete via the scoped Milestone-A primitives), then fill each child's
// mapped fields at "<parentBase>-<pIdx>--<childBase>-<cIdx>--<field>" — reusing resolve + the per-widget
// CDP handlers (incl. the typeahead inline AI, so a typo like "otherrrr" → "Other"). pOrd = the parent's
// DISPLAY ordinal (canonical records); pIdx = the parent's fkit index (DOM selectors). Records are
// canonical "<parentBase>[<pOrd>].<childBase>[<j>].<path>" with nested_parent/nested_child_base so the
// viewer groups them under the parent entry (summary.js nestedInfoOf / renderNestedSub).
async function fillNestedSpecialtiesCdp(act, o) {
  const { parentBase, pOrd, pIdx, childBase, headingStem, fieldMap, items, budgets, aiContext, preserveExtras } = o;
  const recs = [];
  const N = Array.isArray(items) ? items.length : 0;
  // N=0 does NOT early-return: reconcile DOWN still runs, deleting orphan empty child rows (e.g.
  // the recon-mounted empty Specialties — an empty REQUIRED specialtyParent blocks Save & Continue,
  // the 2026-07-01 live halt). Same reconcile-to-exactly-N semantics as the top-level sections (M21).
  if (!(act.nestedScan && act.clickNestedAdd && act.clickNestedDelete)) return recs;
  const parentFkit = parentBase + "-" + pIdx + "--null";
  const childIdxs = async () => { // sorted child fkit indices of THIS parent's childBase sub-section
    let scan = null; try { scan = await act.nestedScan(); } catch (e) { return []; }
    const out = [];
    for (const ns of ((scan && scan.nestedSections) || [])) {
      if (ns.parentBase !== parentBase || ns.childBase !== childBase) continue;
      for (const ent of (ns.entries || [])) { const lv = ent.levels || []; if (lv.length >= 2 && String(lv[0].index) === String(pIdx)) out.push(lv[lv.length - 1].index); }
    }
    return out.sort((a, b) => a - b);
  };
  let cur = await childIdxs(), guard = 0;
  while (cur.length < N && guard++ < N + 4) { // reconcile UP — mount specialties
    const before = cur.length;
    const add = await act.clickNestedAdd(parentFkit, headingStem);
    if (!add || !add.ok) break;
    const deadline = Date.now() + (budgets.entryReconcileCeilingMs || 4000);
    while (Date.now() < deadline) { await act.delay(budgets.entryReconcileIntervalMs || 150); cur = await childIdxs(); if (cur.length > before) break; }
    if (cur.length <= before) break; // mount didn't register — don't spin
  }
  guard = 0;
  // preserveExtras (remediation re-fill): child rows beyond profile-N may be manual — never delete.
  while (!preserveExtras && cur.length > N && guard++ < 12) { // reconcile DOWN — delete trailing extras
    const before = cur.length;
    const del = await act.clickNestedDelete(parentFkit, childBase, cur[cur.length - 1]);
    if (!del || !del.ok) break;
    const deadline = Date.now() + (budgets.entryReconcileCeilingMs || 4000);
    while (Date.now() < deadline) { await act.delay(budgets.entryReconcileIntervalMs || 150); cur = await childIdxs(); if (cur.length < before) break; }
    if (cur.length >= before) break;
  }
  for (let j = 0; j < Math.min(N, cur.length); j++) { // fill each child in order
    const cIdx = cur[j], item = items[j] || {};
    const canon = parentBase + "[" + pOrd + "]." + childBase + "[" + j + "].";
    for (const f of fieldMap) {
      // The fkit ↔ formField relationship is TENANT-VARIABLE (the composed descendant selector failed
      // live on Magna — the fkit node does not wrap the formField). PROBE the live DOM for the selector
      // that actually resolves (act.nestedFieldSel — cdpNestedFieldSel's relationship ladder); the fkit
      // string is composed entirely from runtime-scanned indices, never hardcoded. Fakes without the
      // probe keep the legacy composed selector.
      const childFkit = parentBase + "-" + pIdx + "--" + childBase + "-" + cIdx + "--" + f.field;
      let wrapperSel = null;
      if (act.nestedFieldSel) { try { wrapperSel = await act.nestedFieldSel(childFkit, f.field); } catch (e) { wrapperSel = null; } }
      else wrapperSel = '[data-fkit-id="' + childFkit + '"] [data-automation-id="formField-' + f.field + '"]';
      if (!wrapperSel) {
        recs.push({ fieldName: canon + f.path, label: f.field, widgetType: f.widget === "year" ? "date" : f.widget,
          isRequired: false, mappedPath: canon + f.path, rawValue: item[f.key] === undefined ? null : item[f.key],
          resolved: null, status: "error", matchTier: null, confidence: null, flag: null, verified: null, after: null,
          detail: "nested field wrapper not found (probed fkit + formField + id relations for " + childFkit + ")",
          auditLoc: null, nested_parent: { base: parentBase, index: pOrd }, nested_child_base: childBase });
        continue;
      }
      const loc = { wrapperSel };
      const rec = {
        fieldName: canon + f.path, label: f.field, widgetType: f.widget === "year" ? "date" : f.widget,
        isRequired: !!f.required, mappedPath: canon + f.path, rawValue: item[f.key] === undefined ? null : item[f.key],
        resolved: null, status: null, matchTier: null, confidence: null, flag: null, verified: null, after: null, detail: null,
        date_order: f.date_order || null, // → the summary's segmented date editor (bundle passes it through)
        auditLoc: wrapperSel, nested_parent: { base: parentBase, index: pOrd }, nested_child_base: childBase
      };
      try {
        if (f.widget === "date" || f.widget === "year") {
          const parsed = item[f.key];
          if (!parsed) { rec.status = "skipped"; rec.detail = "no date"; }
          else { rec.resolved = parsed; Object.assign(rec, await fillDateCompositeCdp(act, loc, parsed, budgets)); }
        } else {
          const r = resolve(item[f.key], f.widget);
          if (r.skip) { rec.status = "skipped"; rec.detail = r.reason || "empty"; }
          else {
            const arg = r.value !== undefined ? r.value : r.candidates;
            rec.resolved = arg;
            if (f.widget === "typeahead") {
              const cap = makeStartCapture(act, loc);
              const aiForField = aiContext ? { profile: aiContext.profile, jobContext: aiContext.jobContext, fieldName: rec.fieldName, label: rec.label, isRequired: false } : undefined;
              Object.assign(rec, await fillTypeaheadCdp(act, loc, arg, budgets, { onCapture: cap.onCapture, ai: aiForField }));
              const ro = cap.reviewOptions(); if (ro && ro.length) rec.options = ro;
            } else if (f.widget === "text") Object.assign(rec, await fillTextCdp(act, loc, arg, budgets));
            else if (f.widget === "dropdown") Object.assign(rec, await fillDropdownCdp(act, loc, arg, budgets));
            else { rec.status = "skipped"; rec.detail = "no handler for " + f.widget; }
          }
        }
      } catch (e) { rec.status = "error"; rec.detail = String(e); }
      // A SKIPPED nested field (no profile value) may still HOLD a value — operator-typed or
      // pre-filled — and the review must inventory it (the already-filled convention). Fill-time
      // read here on the probed selector; the sweep's nested pass re-reads at END-OF-PAGE too.
      // Read-only; a read failure keeps the honest skip.
      if (rec.status === "skipped") {
        const live = await readLiveValueByWidget(act, f.widget, loc);
        if (hasLiveValue(live)) {
          rec.status = "filled_review"; rec.flag = "already-filled";
          rec.after = String(live); rec.verified = null;
          rec.detail = "already on the form — NOT filled by ApplyPilot; verify";
        }
      }
      recs.push(rec);
      await act.delay(budgets.interFieldMs);
    }
  }
  // ── PROACTIVE nested deleteOnNoMatch (operator rule 2026-07-02) ── a child row whose REQUIRED
  // pick ended BLANK on a definitive negative — a deterministic GENUINE no-match (M38 B1) or a
  // failed/unconfident AI rescue (ai-*) — would block Save & Continue, and a nested sub-section is
  // optional → DELETE the row AT FILL TIME (was: left for AI-4 Tier-1.5 at advance time). A row
  // HOLDING a value (kept original / AI commit — after non-null) is NEVER deleted (it doesn't
  // block); a transient/infra failure (no genuineNoMatch tag, no ai- flag) is NEVER deleted (valid
  // data — the B1 safety). preserveExtras (remediation re-fill) skips deletion entirely. Deleted
  // rows' records → status "removed" (drop from the bundle) + ONE section-op note; the caller
  // annotates the sub-section stub so the operator SEES it happened.
  if (!o.preserveExtras && act.clickNestedDelete) {
    for (let j = Math.min(N, cur.length) - 1; j >= 0; j--) { // bottom-up (indices stay valid)
      const canon = parentBase + "[" + pOrd + "]." + childBase + "[" + j + "].";
      const rowRecs = recs.filter((r) => r.fieldName.indexOf(canon) === 0);
      const blocked = rowRecs.some((r) => r.isRequired && r.status === "needs_review" && r.after == null
        && (r.genuineNoMatch === true || /^ai-/.test(String(r.flag || ""))));
      if (!blocked) continue;
      const before = (await childIdxs()).length;
      const del = await act.clickNestedDelete(parentFkit, childBase, cur[j]);
      if (!del || !del.ok) continue; // can't delete → keep the honest flags (surfaces in review)
      let now = before;
      const deadline = Date.now() + (budgets.entryReconcileCeilingMs || 4000);
      while (Date.now() < deadline) { await act.delay(budgets.entryReconcileIntervalMs || 150); now = (await childIdxs()).length; if (now < before) break; }
      if (now >= before) continue; // click didn't drop the count → keep (never lie "removed")
      for (const r of rowRecs) { r.status = "removed"; r.flag = "nested-nomatch-removed"; }
      recs.push({
        fieldName: canon + "removed", label: childBase + " row removed", widgetType: "section",
        isRequired: false, mappedPath: null, rawValue: null, resolved: null,
        status: "skipped", matchTier: null, confidence: null, flag: "nested-nomatch-removed", verified: null, after: null,
        detail: "required pick matched nothing (AI could not rescue) → row deleted (optional sub-section; a blank required pick would block Save & Continue)",
        nested_parent: { base: parentBase, index: pOrd }, nested_child_base: childBase
      });
    }
  }
  return recs;
}

// ── ALREADY-FILLED sweep ── the review summary must inventory EVERYTHING the page holds, not just
// what the bot filled. A record that ended `skipped` (no mapping / not in profile) whose field HOLDS
// a live value was filled by someone else (Workday account pre-fill, the operator, a prior run) —
// surface the value + FLAG it ("already-filled" → needs_review, the m3a unknown-section convention
// generalized to flat fields + KNOWN sections). If the live value normalize-matches the record's own
// profile value it's correct → recorded, NOT flagged ("already-filled-match"). Fields a KNOWN
// section's map doesn't cover (tenant extras) get NEW already-filled records. READ-ONLY (one flat
// scan + one repeating scan, no actuation); nested child fields (cert ▸ specialties) are excluded —
// reconciled to the profile + M40-audited via their own records. NOTE: scan entry i joins record
// ordinal i (DOM order == fill ordinal); a mid-list deleteOnNoMatch delete could shift the join for
// later entries — flag-only, never actuates, so the worst case is a mislabeled review flag.
// Read ONE field's live value by widget type — READ-ONLY, keyed by a selector string re-resolved
// fresh from the document. Used by the nested filler's skip-read and the sweep's nested pass.
// Returns null when empty or unreadable (never throws).
async function readLiveValueByWidget(act, widget, loc) {
  try {
    if (widget === "date" || widget === "year") {
      const parts = [];
      for (const seg of ["Month", "Day", "Year"]) {
        const r = act.readDateSegment ? await act.readDateSegment(loc, seg) : null;
        if (r && r.value != null && String(r.value).trim() !== "" && !isNaN(parseInt(r.value, 10))) parts.push(String(r.value));
      }
      return parts.length ? parts.join("/") : null;
    }
    if (widget === "typeahead" || widget === "hierarchical") {
      const h = act.readHier ? await act.readHier(loc) : null;
      return h && h.chips && h.chips.length ? h.chips.join("; ") : null;
    }
    if (widget === "dropdown") {
      const d = act.readDropdownState ? await act.readDropdownState(loc) : null;
      return d ? d.triggerText : null;
    }
    if (widget === "checkbox") {
      const c = act.readCheckboxState ? await act.readCheckboxState(loc) : null;
      return c && c.inputId != null ? !!c.checked : null;
    }
    const t = act.readTextValue ? await act.readTextValue(loc) : null;
    return t ? t.value : null;
  } catch (e) { return null; }
}

async function sweepAlreadyFilled(act, results) {
  const norm = apMatch.normalize;
  const matchesOwn = (rec, live) => {
    const own = rec.resolved != null ? rec.resolved : rec.rawValue;
    const cands = Array.isArray(own) ? own : (own != null ? [own] : []);
    return cands.some((c) => typeof c === "string" && norm(c) && norm(c) === norm(String(live)));
  };
  const flip = (rec, live, wrapperSel) => {
    if (matchesOwn(rec, live)) {
      rec.status = "filled"; rec.flag = "already-filled-match";
      rec.detail = "already on the form — matches the profile value (not re-typed)";
    } else {
      rec.status = "filled_review"; rec.flag = "already-filled";
      rec.detail = "already on the form — NOT filled by ApplyPilot; verify";
    }
    rec.after = String(live); rec.verified = null;
    if (!rec.auditLoc && wrapperSel) rec.auditLoc = wrapperSel;
  };
  // FLAT fields — records keyed by the bare DOM fieldName (no "[").
  let flat = null; try { flat = await act.scanPage(); } catch (e) { flat = null; }
  if (flat && Array.isArray(flat.fields)) {
    const byName = {}; for (const f of flat.fields) byName[f.fieldName] = f;
    for (const rec of results) {
      if (rec.status !== "skipped" || rec.fieldName.indexOf("[") !== -1) continue;
      if (rec.widgetType === "file_upload" || rec.widgetType === "unknown" || rec.widgetType === "section") continue;
      if (rec.flag) continue; // already classified (ai-* skip, already-filled, …) — don't clobber provenance
      const f = byName[rec.fieldName];
      if (f && hasLiveValue(f.value)) flip(rec, f.value, f.wrapperSel);
    }
  }
  // KNOWN repeating sections — join scan entries ↔ records via each section's fieldMap
  // (field automation-id OR labelRegex, the fillEntryCdp findFd logic mirrored).
  let rscan = null; try { rscan = await act.repeatingScan(); } catch (e) { rscan = null; }
  const sections = (rscan && rscan.sections) || {};
  for (const sec of PAGE_SECTIONS) {
    const s = sections[sec.containerPrefix];
    if (!s || !Array.isArray(s.entries)) continue;
    const nestedFields = new Set([].concat(...(((sec.nested || {}).subSections) || []).map((ss) => (ss.fieldMap || []).map((fm) => fm.field))));
    for (let i = 0; i < s.entries.length; i++) {
      for (const fd of ((s.entries[i] && s.entries[i].fields) || [])) {
        // "" fieldName = the Attachments wrapper ("formField-" empty suffix) — never a sweep row
        if (!fd.fieldName || fd.widgetType === "file_upload" || nestedFields.has(fd.fieldName)) continue;
        const fm = (sec.fieldMap || []).find((m) => m.labelRegex ? m.labelRegex.test(fd.label || "") : m.field === fd.fieldName);
        if (fm) {
          const key = sec.name + "[" + i + "]." + (fm.name || fm.field);
          const rec = results.find((r) => r.fieldName === key && r.status !== "removed");
          if (rec && rec.status === "skipped" && !rec.flag && hasLiveValue(fd.value)) flip(rec, fd.value, fd.wrapperSel);
          else if (!rec && hasLiveValue(fd.value)) {
            // a LIVE value no record vouches for — a surviving row whose records were dropped
            // (index shift after a remediation delete) or an operator-added extra entry. The
            // summary is the page's source of truth → surface it as already-filled.
            results.push({
              fieldName: key, label: fd.label || fm.field, widgetType: fd.widgetType, isRequired: !!fd.isRequired,
              mappedPath: key, rawValue: null, resolved: null,
              status: "filled_review", matchTier: null, confidence: null, flag: "already-filled",
              verified: null, after: String(fd.value),
              detail: "on the form but not vouched for by this run's records — verify",
              auditLoc: fd.wrapperSel || null
            });
          }
        } else if (hasLiveValue(fd.value)) {
          // an UNMAPPED field inside a KNOWN section holding a value — the "not mapped" edge case
          results.push({
            fieldName: sec.name + "[" + i + "]." + fd.fieldName, label: fd.label || fd.fieldName,
            widgetType: fd.widgetType, isRequired: !!fd.isRequired,
            mappedPath: null, rawValue: null, resolved: null,
            status: "filled_review", matchTier: null, confidence: null, flag: "already-filled",
            verified: null, after: String(fd.value),
            detail: "already on the form (unmapped section field) — NOT filled by ApplyPilot; verify",
            auditLoc: fd.wrapperSel || null
          });
        }
      }
    }
  }
  // NESTED records (cert ▸ specialties) — the scans above can't join them by ordinal (Workday's
  // internal counters), but every nested record carries its PROBED auditLoc: re-read any STILL-
  // skipped one at end-of-page so a value typed/committed after the section filled is never missed.
  // (The nested filler already does a fill-time read — this is the end-of-page refresh.)
  for (const rec of results) {
    if (rec.status !== "skipped" || !rec.nested_child_base || !rec.auditLoc || rec.flag) continue;
    const live = await readLiveValueByWidget(act, rec.widgetType, { wrapperSel: rec.auditLoc });
    if (hasLiveValue(live)) flip(rec, live, rec.auditLoc);
  }
}

// ── PRE-ADVANCE TRUTH RECON (operator rule 2026-07-02) ── run after AI-4 remediation actions,
// right BEFORE every re-Save&Continue click: the persisted summary must show EXACTLY what is on
// the page at the moment it advances (the latest recon overrides earlier persists — the accumulate
// merge replaces this page's entries). READ-ONLY. Rules:
//  • a record whose field/row is GONE from the fresh scans → status "removed" (drops from the
//    bundle — remediation deletes rows deliberately; the console log keeps the trail)
//  • a surviving section row whose scanned LIVE value differs from what the record claims (an
//    index shift after a mid-list delete) → after = the live value, needs_review/"recon-mismatch"
//  • nested records (probed auditLoc) → existence-checked via act.selExists (gone → removed)
//  • then sweepAlreadyFilled — anything on the page no record vouches for is captured/flagged
//    (incl. a surviving row whose own records were dropped: re-added as already-filled)
// NOT called on the main walk's FIRST advance: there the end-of-fill audit+sweep (which preserve
// the M40 audit-unverifiable safety flags) ARE the recon — nothing runs between them and the click.
async function reconPageTruth(act, results) {
  let flat = null, rscan = null;
  try { flat = await act.scanPage(); } catch (e) { flat = null; }
  try { rscan = await act.repeatingScan(); } catch (e) { rscan = null; }
  const flatNames = new Set(((flat && flat.fields) || []).map((f) => f.fieldName));
  const sections = (rscan && rscan.sections) || {};
  const norm = apMatch.normalize;
  const markRemoved = (r, why) => { r.status = "removed"; r.flag = "recon-removed"; r.detail = (r.detail ? r.detail + " | " : "") + why; };
  for (const r of results) {
    if (r.status === "removed" || r.widgetType === "section" || r.widgetType === "remediation" || r.widgetType === "file_upload") continue;
    if (r.widgetType === "section_stub" || r.widgetType === "nested_section_stub") continue;
    // nested (cert ▸ specialties): the probed auditLoc is the existence key (Tier-1.5 deletes rows)
    if (r.nested_child_base) {
      if (r.auditLoc && act.selExists) {
        let there = true; try { there = !!(await act.selExists(r.auditLoc)); } catch (e) { there = true; }
        if (!there) markRemoved(r, "nested row no longer on the page at advance-time — dropped from review");
      }
      continue;
    }
    const m = /^([A-Za-z]\w*)\[(\d+)\]\./.exec(r.fieldName);
    if (m) {
      if (!rscan) continue; // scan failed → never mass-remove (the cascade-removed guard)
      const sec = PAGE_SECTIONS.find((x) => x.name === m[1]);
      if (!sec) continue; // unknown-section records (m3a) — not ours to reconcile
      const s = sections[sec.containerPrefix];
      const entries = (s && s.entries) || []; // an emptied section is legitimately absent from the scan
      const i = parseInt(m[2], 10);
      if (i >= entries.length) { markRemoved(r, "row no longer on the page at advance-time (deleted) — dropped from review"); continue; }
      // survivor row: the record must claim the LIVE value (a mid-list delete shifts later rows
      // onto earlier ordinals — the record would otherwise show the DELETED row's value)
      if (r.status === "filled" || r.status === "filled_review") {
        const recName = r.fieldName.slice(r.fieldName.indexOf("].") + 2);
        const fm = (sec.fieldMap || []).find((x) => (x.name || x.field) === recName);
        const fields = (entries[i] && entries[i].fields) || [];
        const fd = fm ? (fm.labelRegex ? fields.find((x) => fm.labelRegex.test(x.label || "")) : fields.find((x) => x.fieldName === fm.field)) : null;
        if (fd && r.after != null) {
          // A checkbox's live value is a BOOLEAN — an UNchecked box (false) is a valid, determinate
          // state, NOT an unfilled field. hasLiveValue(false) is false, which would wrongly flag every
          // correctly-unchecked "I currently work here" as EMPTY; a checkbox always has a value.
          const isCheckbox = fd.widgetType === "checkbox" || typeof fd.value === "boolean";
          const liveHasValue = isCheckbox ? (fd.value != null) : hasLiveValue(fd.value);
          // Dates compare SEGMENT-wise by NUMERIC value (auditDateMatches): the fill records the
          // segment INPUT ("9/2024") while this recon re-reads cdpRepeatingScan's DISPLAY value, which
          // Workday renders ZERO-PADDED ("09/2024") — norm() treats "9"≠"09" and would false-flag every
          // M/Y|M/D/Y date. Reuse the M40 audit's comparator (the fill afterStr is its exact inverse).
          const changed = fd.widgetType === "date"
            ? !auditDateMatches(String(fd.value), String(r.after))
            : norm(String(fd.value)) !== norm(String(r.after));
          if (liveHasValue && changed) {
            r.after = String(fd.value);
            r.status = "needs_review"; r.flag = "recon-mismatch";
            r.detail = (r.detail ? r.detail + " | " : "") + "live value changed before advance (post-remediation shift?) — verify";
          } else if (!liveHasValue) {
            r.status = "needs_review"; r.flag = "recon-mismatch";
            r.detail = (r.detail ? r.detail + " | " : "") + "field is EMPTY on the page at advance-time — verify";
          }
        }
      }
      continue;
    }
    // flat record: field gone from the fresh flat scan → removed (guard: non-empty scan only)
    if (flat && flatNames.size > 0 && !flatNames.has(r.fieldName)) {
      markRemoved(r, "field no longer on the page at advance-time — dropped from review");
    }
  }
  // finally: capture anything on the page that no record vouches for
  try { await sweepAlreadyFilled(act, results); } catch (e) { /* completeness — never abort */ }
}

// FILL IN DOM ORDER — order the section registry by each section's position ON THE PAGE. Every
// repeating section's Add button sits AT the section ("Add" / "Add Another"), and the scan's
// addButtons list is document-order — so the index of a section's (non-nested) Add button IS its
// page position. A section with no matched Add keeps registry order, appended after the matched
// ones (stable). Pure — unit-tested; nothing hardcoded (order comes from the live DOM each fill).
function sectionsInDomOrder(sections, addButtons) {
  const adds = Array.isArray(addButtons) ? addButtons : [];
  const domIx = (sec) => {
    const re = new RegExp(sec.headingRegex, "i");
    const i = adds.findIndex((b) => b && !b.insideEntry && re.test((b.nearestHeading) || ""));
    return i === -1 ? Infinity : i;
  };
  return sections.map((s, i) => ({ s, key: domIx(s), tie: i }))
    .sort((a, b) => (a.key - b.key) || (a.tie - b.tie))
    .map((x) => x.s);
}

async function driveRepeatingSectionCdp(act, section, budgetsIn) {
  const budgets = Object.assign({}, DEFAULT_BUDGETS, budgetsIn || {});
  const { name, headingRegex, containerPrefix, items, fieldMap, deleteOnNoMatch } = section;
  const N = Array.isArray(items) ? items.length : 0;
  const results = [];

  const sectionRec = (suffix, label, status, detail) => ({
    fieldName: name + suffix, label, widgetType: "section", isRequired: false,
    mappedPath: null, rawValue: null, resolved: null, status, matchTier: null,
    confidence: null, flag: null, verified: null, after: null, detail
  });

  // A section STUB — makes an EMPTY or FULLY-DELETED section still APPEAR in review + be addable.
  // Carries the field shape so add-entry can build a new entry; flag "section-stub". The shape
  // prefers the LIVE detected fields (captured before any delete sweep → carries the recon'd
  // date_order so the summary renders segmented MM/DD/YYYY, not a plain text box); it falls back to
  // the map only for a section that was NEVER populated (year → ["year"]; M/Y-vs-M/D/Y is unknown
  // without a live scan, so a bare date stays a text box — "don't guess").
  const humanName = name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
  let detectedShape = null; // filled by captureDetectedShape() from the live entries BEFORE deletion
  const captureDetectedShape = async () => {
    try {
      const s = await act.repeatingScan();
      const sec = s && s.sections ? s.sections[containerPrefix] : null;
      const fields = sec && sec.entries && sec.entries[0] && Array.isArray(sec.entries[0].fields) ? sec.entries[0].fields : null;
      if (fields && fields.length) {
        // The entry scan sees EVERYTHING inside the --null container — including NESTED child
        // fields (specialtyParent/startDate/endDate live INSIDE the cert entry) and the per-entry
        // Attachments file input. Those belong to nested_shapes / nested_attachments (the viewer
        // renders them as the Specialties sub-card + the file picker) — leaking them into the FLAT
        // shape DOUBLED them on an added-back entry (operator bug: "Specialty should only be a
        // subsection, not part of the main section" + two Attachments boxes). WE's own
        // startDate/endDate are unaffected — its exclusion set is empty (no nested config).
        const nestedFieldNames = new Set([].concat(...(((section.nested || {}).subSections) || []).map((ss) => (ss.fieldMap || []).map((fm) => fm.field))));
        const hasNestedAttach = !!(section.nested && section.nested.attachments);
        const flat = fields.filter((f) => !nestedFieldNames.has(f.fieldName) && !(hasNestedAttach && f.widgetType === "file_upload"));
        if (flat.length) detectedShape = flat.map((f) => {
          const o = { recName: f.fieldName, path: f.fieldName, widget_type: f.widgetType, label: f.label, is_required: !!f.isRequired };
          if (f.widgetType === "date") { const ord = dateOrderOf(f.dateSegments); if (ord.length) o.date_order = ord; }
          return o;
        });
      }
    } catch (e) { /* best-effort — the map fallback still applies */ }
  };
  const stubShape = () => (detectedShape && detectedShape.length) ? detectedShape
    : (Array.isArray(fieldMap) ? fieldMap : []).map((f) => ({ recName: f.name || f.field, widget_type: f.widget === "year" ? "date" : f.widget, path: f.path, date_order: f.widget === "year" ? ["year"] : null }));
  // NESTED sub-sections (cert ▸ Specialties + Attachments) are HARDCODED per section (section.nested)
  // — Certifications is the only Workday section with repeating-inside-repeating we've observed, so
  // there's no generic nested SCANNER / reveal-by-add (removed by design). The shape is a CONSTANT, so
  // it's available even for a cert that deleteOnNoMatch removes (it rides makeSectionStub for add-back),
  // and there's zero per-section scan cost. A new tenant with a different nested section gets its own
  // config entry (or we revisit a generic scanner then).
  const nested = section.nested || null;
  const nestedShapes = {}; // childBase → field shape (from the config)
  let nestedHasAttachments = false;
  if (nested) {
    for (const ss of (nested.subSections || [])) {
      nestedShapes[ss.childBase] = (ss.fields || []).map((f) => ({ recName: f.recName, path: f.recName, widget_type: f.widget_type, label: f.label != null ? f.label : f.recName, is_required: !!f.is_required, date_order: f.date_order || null }));
    }
    nestedHasAttachments = !!nested.attachments;
  }
  const makeSectionStub = (label, detail) => ({
    fieldName: name, label, widgetType: "section_stub", isRequired: false, mappedPath: name + "._stub",
    rawValue: null, resolved: null, status: "skipped", matchTier: null, confidence: null,
    flag: "section-stub", verified: null, after: null, detail,
    section_field_shape: stubShape(),
    container_prefix: containerPrefix, section_known: true,
    nested_shapes: Object.keys(nestedShapes).length ? nestedShapes : null, // hardcoded sub-section shapes → viewer shows them on an added-back parent
    nested_attachments: nestedHasAttachments || null                       // the section has a per-entry attach field → the viewer offers a file picker
  });
  const humanChild = (s) => String(s).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

  // Poll the entry count off-loop until it moves in the wanted direction or a
  // ceiling (port of the in-tree 4s/150ms reconcile poll; SW-paced via act.delay).
  const pollCount = async (before, rose) => {
    const deadline = Date.now() + budgets.entryReconcileCeilingMs;
    let count = await act.entryCount(containerPrefix);
    while ((rose ? count <= before : count >= before) && Date.now() < deadline) {
      await act.delay(budgets.entryReconcileIntervalMs);
      count = await act.entryCount(containerPrefix);
    }
    return count;
  };

  const finalize = (url) => {
    const counts = results.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
    const needsReview = results.filter((r) => r.status === "needs_review" || r.status === "filled_review");
    const repeatingFieldCount = results.filter((r) => r.widgetType !== "section" && r.widgetType !== "section_stub").length;
    return { url, repeatingFieldCount, results, counts, needsReview };
  };

  const initial = await act.repeatingScan();
  const url = initial ? initial.url : null;
  let count = await act.entryCount(containerPrefix);

  // reconcile UP — Add to reach N (create-first OR "Add Another").
  if (count < N) {
    let adds = 0;
    while (count < N && adds < N) {
      const before = count;
      const clicked = await act.clickSectionAdd(headingRegex);
      if (!clicked || !clicked.ok) break;
      count = await pollCount(before, true);
      if (count <= before) break; // mount didn't register — don't spin
      adds++;
      await act.delay(budgets.interFieldMs);
    }
    results.push(sectionRec(".add", name + " — Add entries",
      count >= N ? "filled" : "needs_review",
      "added " + adds + " entry(ies); " + count + "/" + N + " present"));
  }

  // reconcile DOWN — delete trailing extras beyond N (also cleans up when N===0).
  // preserveExtras (AI-4 remediation re-fill) SKIPS this: entries beyond profile-N may be the
  // operator's manual additions — a remediation pass must never wipe them (main fill unchanged).
  if (count > N && !section.preserveExtras) {
    let deleted = 0;
    while (count > N && deleted < 10) {
      const before = count;
      const clicked = await act.clickDeleteEntry(containerPrefix, count - 1);
      if (!clicked || !clicked.ok) break;
      count = await pollCount(before, false);
      if (count >= before) break; // didn't drop — don't spin
      deleted++;
      await act.delay(budgets.interFieldMs);
    }
    results.push(sectionRec(".delete", name + " — delete extras",
      count <= N ? "filled" : "needs_review",
      "deleted " + deleted + " extra(s); " + count + "/" + N + " entries"));
  }

  if (N === 0) {
    // SECTION STUB (Feature A) — drivePageFill only drives a section that's PRESENT on the page, so
    // reaching N===0 means the section is on the form but had no profile data → it stays EMPTY.
    // Emit a `section_stub` (a non-fillable category card) so the empty section SURFACES in review
    // (the operator can SEE it + — 2b — add an entry), instead of being silently dropped. The
    // "section_stub" widgetType PASSES buildReviewBundle's section filter (it drops only "section"
    // ops); canonical "<name>._stub" groups it under its section in the viewer; flag "section-stub"
    // → a gentle needs_review via deriveReview. (Page-engine twin is a deferred follow-on — CDP-first.)
    // SECTION STUB (Feature A) — the section is present but had no profile data → EMPTY. Surface a
    // stub (carries the field shape so add-entry works) instead of dropping it silently.
    results.push(makeSectionStub(humanName + " — section present, no entries",
      "no meaningful " + name + " entries to fill — the section is on the form but empty"));
    return finalize(url);
  }

  // Fill each entry; track whether all its REQUIRED fields filled (delete-on-no-match).
  const fillCount = Math.min(N, await act.entryCount(containerPrefix));
  const perEntry = [];
  for (let i = 0; i < fillCount; i++) {
    const entryRecs = await fillEntryCdp(act, containerPrefix, i, items[i], fieldMap, name, budgets, section.aiContext);
    // A required pick that COMMITTED a value (filled OR filled_review) keeps the entry — it won't
    // block Next. filled_review is a containment/fuzzy match (e.g. an abbreviated cert "CPP" →
    // "Certified Payroll Professional (CPP)…") — surfaced for human review, NOT silently deleted.
    const failedRequired = entryRecs.filter((r) => r.isRequired && r.status !== "filled" && r.status !== "filled_review");
    const ok = failedRequired.length === 0;
    // M38 Bug B1 — an entry is DELETABLE (deleteOnNoMatch) ONLY if EVERY failed required pick
    // is a GENUINE no-match (options/leaves RENDERED, candidate genuinely absent → this value
    // isn't offered). A transient/infra failure (dropdown didn't render / couldn't open / commit
    // didn't take / typeahead focus-unconfirmable) is NOT invalid data → KEEP + surface
    // (needs_review), NEVER silently destroy valid data (the live English/Chinese loss when the
    // language dropdown failed to render deep in a long fold).
    // Step 2.5 — an AI-rescued REQUIRED pick is KEPT only if it's CONFIDENT + genuinely represented
    // (ai-choice, high/medium). Anything shakier — low-confidence, ai-closest-forced (forced a value the
    // applicant didn't claim), ai-choice-other ("Other" fallback), ai-typeahead-decline, ai-commit-failed
    // — is UNCONFIDENT: in a deleteOnNoMatch (optional) section a shaky entry is worse than none → DELETE
    // it (operator rule). The AI is INLINE now (it already ran in fillEntryCdp), so there is no end-of-page
    // defer (the old aiWillRescue). `deletable` is acted on ONLY by the deleteOnNoMatch sweep below, so a
    // non-deletable section (education/FoS) keeps + flags regardless.
    const isAiRec = (r) => r.flag && String(r.flag).indexOf("ai-") === 0;
    const aiConfidentKeep = (r) => r.flag === "ai-choice" && (r.confidence === "high" || r.confidence === "medium");
    const aiUnconfident = entryRecs.some((r) => r.isRequired && isAiRec(r) && !aiConfidentKeep(r));
    const deletable =
      (failedRequired.length > 0 && failedRequired.every((r) => r.genuineNoMatch === true)) // deterministic genuine no-match (AI off / not eligible)
      || aiUnconfident;                                                                       // an unconfident AI pick (optional section only — sweep-gated)
    perEntry.push({ idx: i, recs: entryRecs, ok, deletable });
  }

  // delete-on-no-match (optional pick-sections: Languages/Certs) — an entry whose REQUIRED
  // pick GENUINELY didn't match (the value isn't offered) would block Next, so delete it.
  // Sweep high→low so lower indices stay valid. OFF for Websites (text always fills if present).
  // A transient/infra pick failure is NOT deletable (kept + surfaced — Bug B1).
  if (deleteOnNoMatch) {
    await captureDetectedShape(); // BEFORE deleting — so an emptied section's stub keeps the recon'd date_order (segmented date editor, not a text box)
    let removed = 0;
    for (let k = perEntry.length - 1; k >= 0; k--) {
      if (!perEntry[k].deletable) continue; // ok entries AND transient-fail entries are KEPT
      const before = await act.entryCount(containerPrefix);
      const clicked = await act.clickDeleteEntry(containerPrefix, perEntry[k].idx);
      if (!clicked || !clicked.ok) continue; // can't delete — leave it (surfaces in review)
      const after = await pollCount(before, false);
      if (after < before) {
        removed++;
        perEntry[k].wasDeleted = true; // so the nested emit below skips this entry's sub-sections
        perEntry[k].recs = [sectionRec("[" + perEntry[k].idx + "].removed", name + " entry removed",
          "skipped", "a required pick didn't match an option → entry deleted (optional section)")];
      }
      await act.delay(budgets.interFieldMs);
    }
    // If deletion EMPTIED the section, it would VANISH from review (the removed recs are widgetType
    // "section" → filtered out of the bundle). Keep the CATEGORY visible + addable, with a "removed —
    // no match" note, so the operator can still add/verify (the recon's field shape rides the stub).
    if (removed > 0 && (await act.entryCount(containerPrefix)) === 0) {
      results.push(makeSectionStub(humanName + " — no entries (removed)",
        removed + " entr" + (removed === 1 ? "y was" : "ies were") + " removed — no option matched what you entered. Add or verify here."));
    }
  }

  for (const e of perEntry) results.push(...e.recs);

  // HARDCODED nested sub-sections (cert ▸ Specialties + Attachments) per SURVIVING entry. The shape is
  // section.nested (a constant). If the profile has items for a sub-section (e.g. certifications[i].
  // specialties), FILL them (fillNestedSpecialtiesCdp — reconcile + fill via the typeahead inline AI);
  // ALWAYS also emit the addable stub. A fully-deleted section carries the shape on its stub above.
  if (nested) {
    const survivors = perEntry.filter((e) => !e.wasDeleted);
    let parentOrder = []; // surviving parent fkit indices (DOM order) → map the sj-th survivor to its fkit index
    if (act.nestedScan && survivors.length) { try { const s = await act.nestedScan(); parentOrder = (s && s.parentOrder && s.parentOrder[name]) || []; } catch (e) { /* fill-back only needs it; stubs still emit */ } }
    for (let sj = 0; sj < survivors.length; sj++) {
      const i = survivors[sj].idx;                       // display ordinal (canonical + items index)
      const pIdx = parentOrder[sj];                      // this parent's fkit index (DOM selectors)
      const item = (items && items[i]) || {};
      for (const ss of (nested.subSections || [])) {
        const childBase = ss.childBase;
        const childItems = (ss.itemsKey && Array.isArray(item[ss.itemsKey])) ? item[ss.itemsKey] : [];
        // Runs even with ZERO childItems: fillNestedSpecialtiesCdp reconciles the live child rows
        // to N (incl. down to 0 — deleting orphan empty rows that would block Save & Continue).
        let removedRows = 0;
        if (pIdx != null && Array.isArray(ss.fieldMap) && act.clickNestedAdd) {
          const filled = await fillNestedSpecialtiesCdp(act, {
            parentBase: name, pOrd: i, pIdx, childBase, headingStem: ss.headingStem || childBase,
            fieldMap: ss.fieldMap, items: childItems, budgets, aiContext: section.aiContext,
            preserveExtras: !!section.preserveExtras // remediation re-fill: never delete manual child rows
          });
          removedRows = filled.filter((r) => r.widgetType === "section" && r.flag === "nested-nomatch-removed").length;
          results.push(...filled);
        }
        results.push({ // the addable stub (header + "+ Add") — always, so the operator can add more
          fieldName: name + "[" + i + "]." + childBase + "._stub", label: humanChild(childBase),
          widgetType: "nested_section_stub", isRequired: false, mappedPath: name + "[" + i + "]." + childBase + "._stub",
          rawValue: null, resolved: null, status: "skipped", matchTier: null, confidence: null,
          flag: "nested-section-stub", verified: null, after: null,
          detail: "nested repeating sub-section (" + name + " ▸ " + childBase + ") — add or verify entries here"
            + (removedRows ? ` — ${removedRows} row${removedRows === 1 ? "" : "s"} REMOVED (required pick matched nothing; re-add here if needed)` : ""),
          section_field_shape: nestedShapes[childBase],
          container_prefix: name + "-<idx>--" + childBase + "-", // nested backend identifier (idx resolved at fill-back)
          nested_parent: { base: name, index: i }, nested_child_base: childBase, section_known: false
        });
      }
      if (nestedHasAttachments) {
        // (The TEST-ONLY attach_resume per-cert résumé attach lived here — verified live 2026-07-02,
        // then REMOVED with the test data. Per-entry attachments are the operator's, via the review
        // picker / the form; the résumé only ever attaches to the top-level Documents field.)
        results.push({
          fieldName: name + "[" + i + "].attachments", label: "Attachments",
          widgetType: "file_upload", isRequired: false, mappedPath: name + "[" + i + "].attachments",
          rawValue: null, resolved: null, status: "skipped", matchTier: null, confidence: null,
          flag: "nested-attachment", verified: null, after: null,
          detail: "per-entry attachments — upload on the form", nested_path: [{ base: name, index: i }]
        });
      }
    }
  }
  return finalize(url);
}

// ============================================================================
// M34 — CDP date composite. Port of fillDateComposite (background.js ~3270) onto
// the CDP substrate. The date `-input`s are 0-box masked spinbuttons (the M33
// finding) — focus EACH segment EXPLICITLY by triple-clicking its visible
// `-display` (rect-free el.focus()/DOM.focus fallbacks), then type the digits.
// Per-segment explicit focus is robust vs auto-advance timing (a throttled page
// reaction). Input ladder per segment: per-char (typeDigits) primary → insertText
// (typeText) fallback, EACH read-back-verified (parseInt). A read-back mismatch is
// NEVER reported "filled". `parsed` = a "YYYY" string (year-only) OR { month, year,
// day } (month/day optional). `detail` carries the per-segment focusRung/inputMethod
// trace so the live run shows HOW each focused (esp. the standalone year-only).
// Proven standalone via RUN_CDP_FILL_DATE; wired into fillEntryCdp in M35.
// ============================================================================
const fillDateCompositeCdp = async (act, loc, parsed, budgets) => {
  const b = Object.assign({}, DEFAULT_BUDGETS, budgets || {});
  const norm = (typeof parsed === "string" || typeof parsed === "number") ? { year: String(parsed) } : (parsed || {});
  const present = (v) => v !== null && v !== undefined && String(v).trim() !== "";
  const segs = [];
  if (present(norm.month)) segs.push(["Month", String(norm.month)]);
  if (present(norm.day)) segs.push(["Day", String(norm.day)]);
  if (present(norm.year)) segs.push(["Year", String(norm.year)]);
  if (!segs.length) return { status: "skipped", detail: "no date value to fill" };

  // SKIP-IF-CORRECT (minimal-diff replay, budgets.skipIfCorrect): if EVERY segment already reads the
  // desired numeric value, leave the composite UNTOUCHED — zero actuation (page 2 stops re-typing a
  // correct date). Segment-numeric compare (parseInt), matching auditDateMatches / fillSegment's poll.
  if (b.skipIfCorrect) {
    const cur = {};
    let allMatch = true;
    for (const [seg, val] of segs) {
      const r = await act.readDateSegment(loc, seg);
      cur[seg] = r ? r.value : null;
      if (!r || parseInt(r.value, 10) !== parseInt(val, 10)) { allMatch = false; break; }
    }
    if (allMatch) {
      const afterStr = ["Month", "Day", "Year"].filter((s) => cur[s] != null).map((s) => cur[s]).join("/");
      return { status: "filled", after: afterStr, verified: true, flag: "replay-already-correct", detail: "already correct — left unchanged (no actuation)" };
    }
  }

  const after = {};
  const trace = {};
  let allVerified = true;
  // Fill ONE segment: focus → type (typeChars, then insertText fallback) → reactive read-back poll.
  // Returns { read, ok, focusRung, inputMethod }. The outer loop retries the WHOLE thing (self-heal,
  // symmetric with fillTextCdp) so a focus flake or a wrong-value land gets a fresh attempt.
  const fillSegment = async (seg, val) => {
    const focusRung = await act.focusDateSegment(loc, seg);
    if (!focusRung) return { read: null, ok: false, focusRung: null, inputMethod: null };
    const typeAndPoll = async (how) => {
      // NO clearText (Ctrl+A+Delete) — it spans the WHOLE date composite and resets the
      // active segment to Month, so per-char Day/Year digits pile into Month (the M34
      // M/D/Y bug; mechanics probe proved it the sole culprit). focusDateSegment
      // triple-click-SELECTS the segment, so typing REPLACES it — no clear needed.
      // (Any future per-tenant clear must be segment-scoped Backspace, NEVER Ctrl+A.)
      if (how === "insertText") await act.typeText(val); else await act.typeDigits(val);
      // Reactive read-back: POLL the segment until it equals the COMPLETE value (parseInt
      // exact — a half-typed "1" of "15" must NOT satisfy it), ceiling = give-up only. Never
      // a fixed sleep then a single read (survives laggy wifi).
      let read = null;
      const deadline = Date.now() + b.textReadCeilingMs;
      do {
        read = await act.readDateSegment(loc, seg);
        if (read && parseInt(read.value, 10) === parseInt(val, 10)) return { read: read.value, ok: true };
        await act.delay(b.textReadIntervalMs);
      } while (Date.now() < deadline);
      return { read: read ? read.value : null, ok: false };
    };
    let inputMethod = "typeChars";
    let res = await typeAndPoll("typeChars");
    if (!res.ok) { // insertText fallback — re-focus first (typing may have shifted focus/auto-advanced)
      await act.focusDateSegment(loc, seg);
      inputMethod = "insertText";
      res = await typeAndPoll("insertText");
    }
    return { read: res.read, ok: res.ok, focusRung, inputMethod };
  };
  for (const [seg, val] of segs) {
    let r = null;
    for (let attempt = 1; attempt <= (b.textFillAttempts || 1); attempt++) {
      r = await fillSegment(seg, val);
      if (r.ok) { if (attempt > 1) trace[seg + "_healed"] = attempt; break; }
    }
    after[seg] = r ? r.read : null;
    trace[seg] = (r && r.focusRung ? r.focusRung : "focus-failed") + "/" + (r && r.ok ? r.inputMethod : ((r && r.inputMethod) || "?") + "-FAILED");
    if (!r || !r.ok) allVerified = false;
  }

  const afterStr = ["Month", "Day", "Year"].filter((s) => after[s] != null).map((s) => after[s]).join("/");
  const detail = "segments " + JSON.stringify(trace);
  if (!allVerified) return { status: "needs_review", after: afterStr, verified: false, detail: "date read-back mismatch — " + detail };
  return { status: "filled", after: afterStr, verified: true, detail };
};

// ============================================================================
// M40 — post-fill page AUDIT. A SECOND, INDEPENDENT read of the live DOM AFTER the
// whole page has settled, reconciled against what each field RECORDED. It catches the
// false-verify CLASS that a field's own in-fill verify structurally CANNOT see: a value
// clobbered AFTER its own fill completed (a later field's actuation disturbed an earlier
// one, or a delayed server reset — M39 was an IN-fill race; this is the post-settle one).
// FLAG-ONLY (the chosen scope): reconcile + flag, never auto-refill. Runs inline at the
// end of drivePageFill (the real backstop, mutating results → the bundle) AND standalone
// via the SW (re-read the persisted expectations — the perturbation re-check).
// ============================================================================

// auditDateSegments: the EXACT inverse of fillDateCompositeCdp's afterStr formatting
// (["Month","Day","Year"].filter(present).join("/")). Split count → segment shape:
// 1 part = Year-only, 2 = Month/Year, 3 = Month/Day/Year. A round-trip unit test pins this.
function auditDateSegments(expected) {
  const parts = String(expected == null ? "" : expected).split("/");
  if (parts.length === 1) return [["Year", parts[0]]];
  if (parts.length === 2) return [["Month", parts[0]], ["Year", parts[1]]];
  return [["Month", parts[0]], ["Day", parts[1]], ["Year", parts[2]]];
}
function auditDateMatches(actual, expected) {
  const a = String(actual).split("/"), b = String(expected).split("/");
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (parseInt(a[i], 10) !== parseInt(b[i], 10)) return false;
  return true;
}

// Map a widget's RAW read (the shape act.readTextValue/readDropdownState/… return) → {actual,
// readable}. PURE, and the SINGLE derivation used by BOTH the per-field re-read (auditReReadActual)
// and the batched one-round-trip pass (reconcileAudit via act.readAuditRaw). Keeping it SW-side keeps
// it Node-testable and means the batched page-side reader (cdp.js cdpReadAuditRaw) only fetches raw
// DOM state — no verdict logic leaks into the page. For "date", `raw` is an ARRAY of per-segment
// reads in auditDateSegments order; ANY missing segment → unverifiable (matches the per-field path).
function auditActualFromRaw(widgetType, raw) {
  switch (widgetType) {
    case "text": case "textarea": return { actual: raw ? raw.value : null, readable: !!raw };
    case "dropdown": return { actual: raw ? raw.triggerText : null, readable: !!raw };
    case "checkbox": return { actual: raw ? String(raw.checked) : null, readable: !!(raw && raw.inputId != null) };
    case "radio": { const ok = Array.isArray(raw) && raw.length > 0; const c = ok && raw.find((o) => o.checked); return { actual: c ? c.labelText : null, readable: ok }; }
    case "typeahead": case "hierarchical": return { actual: raw && raw.chips ? raw.chips.join("; ") : null, readable: !!raw };
    case "date": {
      if (!Array.isArray(raw)) return { actual: null, readable: false };
      const parts = [];
      for (const r of raw) { if (!r || r.value == null) return { actual: null, readable: false }; parts.push(r.value); }
      return { actual: parts.join("/"), readable: true };
    }
    default: return { actual: null, readable: false }; // unauditable type → unverifiable, never a pass
  }
}

// Re-read ONE field's live value by widget type (reusing the existing act reads, all keyed
// by wrapperSel — a SELECTOR STRING, re-resolved fresh from document, never a held node).
// Fetches the raw read per widget, then maps via auditActualFromRaw (the SAME mapping the batched
// path uses). Returns { actual, readable }: readable=false ⇒ the loc no longer resolves / read
// failed (→ audit-unverifiable, NEVER a silent pass).
async function auditReReadActual(act, e) {
  const loc = { wrapperSel: e.auditLoc };
  try {
    let raw;
    switch (e.widgetType) {
      case "text": case "textarea": raw = await act.readTextValue(loc, e.auditTag); break;
      case "dropdown": raw = await act.readDropdownState(loc); break;
      case "checkbox": raw = await act.readCheckboxState(loc); break;
      case "radio": raw = await act.readRadioState(loc); break;
      case "typeahead": raw = await act.readHier(loc); break;
      case "hierarchical": raw = await act.readSource(loc); break;
      case "date": {
        raw = [];
        for (const [seg] of auditDateSegments(e.expected)) raw.push(await act.readDateSegment(loc, seg));
        break;
      }
      default: return { actual: null, readable: false }; // unauditable type → unverifiable, never a pass
    }
    return auditActualFromRaw(e.widgetType, raw);
  } catch (err) { return { actual: null, readable: false }; }
}

// M40 re-fill (operator-chosen self-heal): re-fill ONE audited field with its RECORDED value
// (e.expected — the value that matched + committed, so a single candidate re-clears the match
// ladder), routed by widget type through the SAME handler the fill used. Used only on a mismatch,
// best-effort (the caller try/catches): a transient post-fill clobber recovers; a deterministic
// cross-field reset re-fails the re-read → stays flagged. THROWS if `act` lacks the fill primitives
// (a minimal audit fake) → the caller treats it as "not attempted" and flags the original mismatch.
async function auditRefillEntry(act, e, b) {
  const loc = { wrapperSel: e.auditLoc };
  const exp = e.expected;
  switch (e.widgetType) {
    case "text": case "textarea": return await fillTextCdp(act, loc, exp, b, e.auditTag);
    case "dropdown": return await fillDropdownCdp(act, loc, [exp], b);
    case "typeahead": return await fillTypeaheadCdp(act, loc, [exp], b);
    case "hierarchical": return await fillTypeaheadCdp(act, loc, [exp], b); // merged: source uses the unified filler
    case "radio": return await fillRadioCdp(act, loc, [exp], b);
    case "checkbox": return await fillCheckboxCdp(act, loc, String(exp) === "true", b);
    case "date": { const obj = {}; for (const [seg, v] of auditDateSegments(exp)) obj[seg.toLowerCase()] = v; return await fillDateCompositeCdp(act, loc, obj, b); }
    default: throw new Error("audit re-fill: unsupported widget " + e.widgetType);
  }
}

// ── M2 (strict-replay SUBMIT — the atom) ─────────────────────────────────────
// replayField: replay ONE human-approved review-summary bundle entry onto a FRESH live form
// (the submit walk M3 calls this per field; M4 adds the Submit click + gate). Generalizes
// auditRefillEntry, but the selector is taken from the PERSISTED entry — a submit replay is a
// fresh session, so there's no same-session auditLoc to reuse.
//
// FLAT FIELDS ONLY (this cut): a flat field's `field_id` is `<page>::formField-<name>`, and the
// `formField-<name>` automation-id is UNIQUE + STABLE across page loads, so the selector is EXACT
// (not a guess — we recorded it). REPEATING-section fields (canonical_field carries `[idx]`) are
// DEFERRED: their automation-ids duplicate across entries and the entry containers are re-created
// on a fresh form, so they replay POSITIONALLY via the section reconcile (M3), never by a recorded
// selector. file_upload is DEFERRED too (the SW's attachResumeForPage re-attaches the résumé, same
// as the fill path). The value is the approved `current_value`, passed as a SINGLE candidate → it
// still clears the match ladder → a live no-match returns needs_review from the handler (STOP,
// never guess — the "strict" in strict-replay). edit_kind "cleared" → leave/verify blank;
// is_deleted → skip (the section reconcile drops a removed entry). Mirrors Plan-2 effectiveValue
// (value=current_value, kind=edit_kind, deleted=is_deleted) without importing the viewer module.
function isRepeatingEntry(entry) {
  // sectionOf (summary.js) keys on `name[idx]` in canonical_field; the same signal marks a
  // repeating-section field here (workExperience[0].job_title, education[1].degree, …).
  return /^[A-Za-z_]+\s*\[\d+\]/.test(String((entry && entry.canonical_field) || ""));
}
function deriveFlatWrapperSel(entry) {
  // field_id = `<page>::formField-<name>` (or just `formField-<name>` single-page). The tail after
  // the LAST "::" is the automation-id — unique + stable for a FLAT field → an exact selector.
  const id = String((entry && entry.field_id) || "");
  const automationId = id.includes("::") ? id.slice(id.lastIndexOf("::") + 2) : id;
  return automationId ? '[data-automation-id="' + automationId + '"]' : null;
}
// Does the field's LIVE value already equal the approved value? Mirrors reconcileAudit's classify
// (text/textarea exact; checkbox by desired-boolean; date segment-numeric; choice widgets
// normalize-equal). The skip-if-correct gate: a replay CHANGES only what differs — re-committing a
// correct field is wasted work and re-opens the stray/false-verify risk (the degree→Associates class).
function replayValueMatches(widget, actual, expected) {
  if (actual == null || expected == null) return false;
  if (widget === "checkbox") { const want = expected === true || /^(true|yes)$/i.test(String(expected)); return String(actual) === String(want); }
  if (widget === "text" || widget === "textarea") return textValuesMatch(actual, expected); // phone-format-tolerant
  if (widget === "date") return auditDateMatches(String(actual), String(expected));
  return apMatch.normalize(String(actual)) === apMatch.normalize(String(expected)); // dropdown / radio / typeahead / hierarchical
}

async function replayField(act, entry, budgets) {
  const b = Object.assign({}, DEFAULT_BUDGETS, budgets || {});
  const widget = entry && entry.widget_type;
  if (!entry || !widget || widget === "section") return { status: "skipped", detail: "no widget / section op (not replayable)" };
  if (widget === "section_stub" || widget === "nested_section_stub") return { status: "skipped", flag: "replay-stub-skip", detail: "section stub — a display-only add-entry card, not a fillable field" };
  if (entry.is_deleted) return { status: "skipped", flag: "replay-deleted", detail: "deleted entry — dropped by the section reconcile, not replayed" };
  if (isRepeatingEntry(entry)) return { status: "skipped", flag: "replay-repeating-deferred", detail: "repeating-section field — replayed positionally by the section reconcile (M3), not by a recorded selector" };
  if (widget === "file_upload") return { status: "skipped", flag: "replay-file-deferred", detail: "résumé re-attach handled by the SW attachResumeForPage step, not replayField" };

  const sel = deriveFlatWrapperSel(entry);
  if (!sel) return { status: "error", detail: "could not derive a selector from field_id " + JSON.stringify(entry.field_id) };
  const loc = { wrapperSel: sel };
  const value = entry.current_value;
  const cleared = entry.edit_kind === "cleared" || value == null || value === "";

  // CLEARED (human emptied it): leave blank. A fresh submit form starts blank, so this is a
  // verify-blank, not a destructive clear (choice widgets default to their placeholder).
  if (cleared) {
    if (widget === "text" || widget === "textarea") {
      return Object.assign({ replay: "cleared" }, await fillTextCdp(act, loc, "", b, widget === "textarea" ? "textarea" : "input"));
    }
    return { status: "skipped", replay: "cleared", detail: "left blank (cleared in review; a fresh form defaults to blank)" };
  }

  // SKIP-IF-CORRECT (minimal-diff replay): read the field's LIVE value FIRST; if it already equals the
  // approved value, leave it UNTOUCHED — zero actuation. A replay changes only what DIFFERS: re-committing
  // a correct field is wasted work and re-opens the stray/false-verify risk (the degree→Associates class).
  // (Choice widgets self-skip via their keep-guards too; this covers text/date/radio/checkbox uniformly
  // and avoids even opening a correct dropdown.) A failed live read → fall through and actuate normally.
  try {
    const live = await auditReReadActual(act, { widgetType: widget, auditLoc: sel, auditTag: widget === "textarea" ? "textarea" : undefined, expected: value });
    if (live && live.readable && replayValueMatches(widget, live.actual, value)) {
      return { status: "filled", verified: true, after: live.actual, replay: "already-correct", flag: "replay-already-correct", detail: "already correct on the page — left unchanged (no actuation)" };
    }
  } catch (e) { /* live read failed → actuate normally below */ }

  // NORMAL: replay the approved value through the SAME per-widget handler (single candidate → match ladder).
  switch (widget) {
    case "text": return await fillTextCdp(act, loc, value, b, "input");
    case "textarea": return await fillTextCdp(act, loc, value, b, "textarea");
    case "dropdown": return await fillDropdownCdp(act, loc, [value], b);
    case "typeahead": case "hierarchical": return await fillTypeaheadCdp(act, loc, [value], b);
    case "radio": return await fillRadioCdp(act, loc, [value], b);
    case "checkbox": return await fillCheckboxCdp(act, loc, value === true || /^(true|yes)$/i.test(String(value)), b);
    case "date": { const obj = {}; for (const [seg, v] of auditDateSegments(value)) obj[seg.toLowerCase()] = v; return await fillDateCompositeCdp(act, loc, obj, b); }
    default: return { status: "needs_review", detail: "replay: unsupported widget " + widget };
  }
}
// replayFlatFields: the DRY-replay orchestrator (a unit seam for the future M2 strict-replay SUBMIT). Replays each FLAT,
// PRESENT, re-fillable bundle entry on the live page via replayField; skips repeating (deferred),
// file_upload, deleted, and any field NOT present in `presentFieldNames` (so it scopes to the
// current page). NO Next/Submit — the caller stays in control. Returns the per-field results.
async function replayFlatFields(act, entries, presentFieldNames, budgets) {
  const b = Object.assign({}, DEFAULT_BUDGETS, budgets || {});
  const present = presentFieldNames instanceof Set ? presentFieldNames : new Set(presentFieldNames || []);
  const fieldNameOf = (entry) => {
    const id = String((entry && entry.field_id) || "");
    const auto = id.includes("::") ? id.slice(id.lastIndexOf("::") + 2) : id;
    return auto.indexOf("formField-") === 0 ? auto.slice("formField-".length) : auto;
  };
  const results = [];
  for (const entry of entries || []) {
    if (!entry || entry.widget_type === "section" || entry.widget_type === "file_upload") continue;
    if (entry.is_deleted || isRepeatingEntry(entry)) continue;       // deferred / dropped
    const fname = fieldNameOf(entry);
    if (!present.has(fname)) continue;                                // not on THIS live page
    const r = await replayField(act, entry, b);
    results.push(Object.assign({ field: fname, widgetType: entry.widget_type }, r));
    await act.delay(b.interFieldMs);
  }
  return results;
}

// ── M3 (strict-replay SUBMIT — repeating sections) ───────────────────────────
// coerceReplayValue: turn a bundle entry's DISPLAY current_value back into the profile-shaped
// value fillEntryCdp expects at item[f.key]. Dates are the only real transform — the bundle stores
// the rendered string ("6/15/2024", "5/2025", "2024") but fillDateCompositeCdp wants the SW-parsed
// shape: a "YYYY" STRING for a year-only field, or {month,day?,year} for an M/Y or M/D/Y date
// (auditDateSegments does the same split the audit uses). Checkbox → boolean. Everything else
// (text/textarea/dropdown/typeahead) passes through verbatim → resolve() makes it a single candidate
// through the match ladder (strict — the approved value or needs_review, never a guess).
function coerceReplayValue(currentValue, widget) {
  if (currentValue == null || currentValue === "") return null;
  if (widget === "checkbox") return currentValue === true || /^(true|yes)$/i.test(String(currentValue));
  if (widget === "year") return String(currentValue);                 // fillDateCompositeCdp accepts a "YYYY" string
  if (widget === "date") {
    const segs = auditDateSegments(currentValue);                     // [["Month","6"],["Day","15"],["Year","2024"]] etc.
    if (segs.length === 1) return String(segs[0][1]);                 // year-only → the year string
    const o = {}; for (const [k, v] of segs) o[k.toLowerCase()] = v; // {month, day?, year}
    return o;
  }
  return currentValue;                                                // text / textarea / dropdown / typeahead
}

// bundleToSectionItems: reconstruct the profile-shaped `items` array for ONE known PAGE_SECTION from
// the approved bundle, so the strict replay can feed driveRepeatingSectionCdp (reconcile-to-N +
// entry-scoped fill). Groups the section's entries by index (canonical `<name>[i].…`), DROPS
// soft-deleted entries, re-indexes 0..M-1 (INCLUDING Feature-B added entries — same canonical
// shape), maps each field's canonical `path` → the fieldMap `key` (via coerceReplayValue), and
// reconstructs nested sub-sections (cert ▸ specialties → item[itemsKey][j]). A field with no
// fieldMap entry or no value is omitted → fillEntryCdp skips it (a cleared/blank field stays blank,
// correct on a fresh form). Pure + unit-testable. Unknown/generic sections (no fieldMap) are NOT
// handled here — they're the caller's deferral.
function bundleToSectionItems(entries, section) {
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("^" + esc(section.name) + "\\[(\\d+)\\]\\.(.+)$");
  const nestedRe = /^([A-Za-z_]+)\[(\d+)\]\.(.+)$/;
  const pathToFm = {}; for (const m of (section.fieldMap || [])) pathToFm[m.path] = m;
  const byIdx = new Map(); const order = [];
  for (const e of (entries || [])) {
    if (!e || e.is_deleted) continue;
    const m = String(e.canonical_field || "").match(re);
    if (!m) continue;
    const i = +m[1], rest = m[2];
    if (!byIdx.has(i)) { byIdx.set(i, { flat: {}, nested: {} }); order.push(i); }
    const bucket = byIdx.get(i);
    const nm = rest.match(nestedRe);
    if (nm && section.nested) {                                       // nested: "childBase[j].childPath"
      const sub = (section.nested.subSections || []).find((s) => s.childBase === nm[1]);
      const cfm = sub && (sub.fieldMap || []).find((x) => x.path === nm[3]);
      if (!cfm) continue;
      const v = coerceReplayValue(e.current_value, cfm.widget); if (v == null) continue;
      bucket.nested[nm[1]] = bucket.nested[nm[1]] || new Map();
      const j = +nm[2]; if (!bucket.nested[nm[1]].has(j)) bucket.nested[nm[1]].set(j, {});
      bucket.nested[nm[1]].get(j)[cfm.key] = v;
    } else {                                                          // flat entry field: "<path>"
      const fm = pathToFm[rest]; if (!fm) continue;
      const v = coerceReplayValue(e.current_value, fm.widget); if (v == null) continue;
      bucket.flat[fm.key] = v;
    }
  }
  order.sort((a, b) => a - b);                                        // positional: original index order, re-indexed on output
  return order.map((i) => {
    const bucket = byIdx.get(i);
    const item = Object.assign({}, bucket.flat);
    for (const childBase of Object.keys(bucket.nested)) {
      const sub = section.nested.subSections.find((s) => s.childBase === childBase);
      const js = [...bucket.nested[childBase].keys()].sort((a, b) => a - b);
      item[sub.itemsKey] = js.map((j) => bucket.nested[childBase].get(j));
    }
    return item;
  });
}

// replayRepeatingSections: the repeating-section counterpart to replayFlatFields. For each KNOWN
// PAGE_SECTION present on the live page that has approved bundle entries, reconstruct its items
// (bundleToSectionItems) and re-fill via the SAME driveRepeatingSectionCdp — but STRICT:
//   • deleteOnNoMatch:false — never drop an approved entry on a transient no-match (keep + flag).
//   • aiContext:null        — no AI; the human already approved the value.
// driveRepeatingSectionCdp reconciles the live count to the bundle's kept-entry count (CREATING
// Feature-B added entries) and fills each entry positionally + nested (cert specialties) via the
// proven per-widget handlers — a single approved candidate through the match ladder (a live
// no-match → needs_review, never a guess). A section with no approved entries is skipped (the
// emptied-section reconcile-to-0 case is a follow-on). UNKNOWN/generic sections (no fieldMap) are
// deferred. NO Next/Submit — the caller stays in control. Returns the per-field/section records.
async function replayRepeatingSections(act, entries, budgets) {
  // skipIfCorrect: minimal-diff replay — the per-widget handlers (text/date/radio, and checkbox
  // already) read the live value first and leave an already-correct field UNTOUCHED (zero actuation),
  // so page-2 repeating entries no longer fully re-fill. Choice widgets self-skip via their keep-guards.
  const b = Object.assign({}, DEFAULT_BUDGETS, budgets || {}, { skipIfCorrect: true });
  const results = [];
  let rscan = null;
  try { rscan = await act.repeatingScan(); } catch (e) { return results; } // no repeating substrate → nothing to replay
  if (!rscan || !(rscan.sections || rscan.addButtons)) return results;
  for (const sec of PAGE_SECTIONS) {
    const hasContainer = !!(rscan.sections && rscan.sections[sec.containerPrefix]);
    const re = new RegExp(sec.headingRegex, "i");
    const hasAdd = Array.isArray(rscan.addButtons) && rscan.addButtons.some((bt) => re.test((bt && bt.nearestHeading) || ""));
    if (!hasContainer && !hasAdd) continue;                            // section not on this page
    const items = bundleToSectionItems(entries, sec);
    if (!items.length) {
      // No approved entries. Distinguish "the operator DELETED this section's entries in review" from
      // "the section was never in the bundle". If deleted (is_deleted entries exist for this section),
      // reconcile the LIVE form DOWN TO 0 (driveRepeatingSectionCdp with items:[] deletes all its rows)
      // — a deleted section left with rows would submit content the operator removed (the "cert did not
      // delete" bug). If never captured, leave the section untouched (skip).
      const hadDeleted = (entries || []).some((e) => { const m = /^([A-Za-z_]+)\s*\[/.exec(String((e && e.is_deleted && e.canonical_field) || "")); return m && m[1] === sec.name; });
      if (!hadDeleted) continue;
      const cleared = await driveRepeatingSectionCdp(act, {
        name: sec.name, headingRegex: sec.headingRegex, containerPrefix: sec.containerPrefix,
        items: [], fieldMap: sec.fieldMap, nested: sec.nested, deleteOnNoMatch: false, aiContext: null
      }, b);
      if (cleared && Array.isArray(cleared.results)) results.push(...cleared.results);
      continue;
    }
    const out = await driveRepeatingSectionCdp(act, {
      name: sec.name, headingRegex: sec.headingRegex, containerPrefix: sec.containerPrefix,
      items, fieldMap: sec.fieldMap, nested: sec.nested,
      deleteOnNoMatch: false, // strict: keep + flag an approved entry that won't match, never delete
      aiContext: null         // strict: no AI — the human approved the value
    }, b);
    if (out && Array.isArray(out.results)) results.push(...out.results);
  }
  return results;
}

// selectPageBundleEntries (M3 walk): match the CURRENT live page to ONE page-group of the approved
// bundle, so replay scopes to THIS page's entries (a same-named field on another page never
// cross-replays — deriveFlatWrapperSel drops the page prefix, so scoping must happen here). Groups the
// bundle by the `page` merge key, then picks the group with the most OVERLAP with the live page. Overlap
// counts BOTH flat field names AND repeating SECTION presence — the latter is load-bearing: a repeating
// page (My Experience) has NO flat fields (cdpPageScan excludes anything inside an indexed fkit entry),
// so flat-only overlap scores 0 and the page looks "not in the bundle" even though its work-experience /
// education / … entries are. `liveRepeatingScan` (act.repeatingScan()) tells us which sections are live;
// PAGE_SECTIONS maps containerPrefix/heading → the section name the bundle's canonical_field uses.
// Overlap (NOT exact key equality) also survives a cascade reveal changing the flat field-set. score 0 →
// the bundle doesn't cover this page (the walk HALTS, never guesses).
function selectPageBundleEntries(entries, liveFieldNames, liveRepeatingScan) {
  const live = liveFieldNames instanceof Set ? liveFieldNames : new Set(liveFieldNames || []);
  // Which repeating SECTIONS are live on this page (by PAGE_SECTIONS name)?
  const liveSecs = new Set();
  const rscan = liveRepeatingScan;
  if (rscan && (rscan.sections || rscan.addButtons)) {
    for (const sec of PAGE_SECTIONS) {
      const hasContainer = !!(rscan.sections && rscan.sections[sec.containerPrefix]);
      let hasAdd = false;
      try { const re = new RegExp(sec.headingRegex, "i"); hasAdd = Array.isArray(rscan.addButtons) && rscan.addButtons.some((bt) => re.test((bt && bt.nearestHeading) || "")); } catch (e) { /* bad regex → skip */ }
      if (hasContainer || hasAdd) liveSecs.add(sec.name);
    }
  }
  const nameOf = (e) => {
    const id = String((e && e.field_id) || "");
    const auto = id.includes("::") ? id.slice(id.lastIndexOf("::") + 2) : id;
    return auto.indexOf("formField-") === 0 ? auto.slice("formField-".length) : null;
  };
  const secOf = (e) => { const m = /^([A-Za-z_]+)\s*\[/.exec(String((e && e.canonical_field) || "")); return m ? m[1] : null; };
  const groups = new Map();
  for (const e of entries || []) {
    const k = e && e.page != null ? e.page : "__nopage__";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  let best = null, bestKey = null, bestScore = -1;
  for (const [k, es] of groups) {
    const flatNames = new Set(es.filter((e) => !isRepeatingEntry(e)).map(nameOf).filter(Boolean));
    const secNames = new Set(es.filter((e) => isRepeatingEntry(e)).map(secOf).filter(Boolean));
    let inter = 0;
    for (const n of flatNames) if (live.has(n)) inter++;
    for (const s of secNames) if (liveSecs.has(s)) inter++;   // a repeating-only page matches here
    if (inter > bestScore) { bestScore = inter; best = es; bestKey = k; }
  }
  return { entries: best || [], pageKey: bestKey, score: bestScore };
}

// reconcileAudit: re-read each entry's live value + classify match / mismatch / unverifiable.
// One settle first (delayFull — the page's render takes real wall-clock; the foreground
// speedup must not shorten it). Pure verdict list; the caller (inline or SW) acts on it.
// opts.refillOnMismatch (INLINE audit only): on a mismatch, attempt ONE re-fill with the recorded
// value + re-read; recovered ⇒ "recovered" (kept filled + a note), still wrong ⇒ "mismatch". The
// standalone re-audit omits it (stays FLAG-ONLY — auto-correcting a manual perturbation re-check
// would undermine its diagnostic purpose).
async function reconcileAudit(act, entries, budgets, opts) {
  const b = Object.assign({}, DEFAULT_BUDGETS, budgets || {});
  const norm = apMatch.normalize;
  const refillOnMismatch = !!(opts && opts.refillOnMismatch);
  const classify = (e, actual, readable) => {
    if (!readable || actual === null) return "unverifiable";
    if (e.widgetType === "checkbox") return actual === e.expected ? "match" : "mismatch";
    if (e.widgetType === "text" || e.widgetType === "textarea") return textValuesMatch(actual, e.expected) ? "match" : "mismatch"; // phone-format-tolerant
    if (e.widgetType === "date") return auditDateMatches(actual, e.expected) ? "match" : "mismatch";
    return norm(actual) === norm(e.expected) ? "match" : "mismatch"; // dropdown / radio / typeahead / source
  };
  await act.delayFull(b.auditSettleMs);
  // PERF (hidden runs): read every field's live state in ONE page-side round-trip instead of one
  // cdpEval per field. Falls back to the per-field path when the substrate lacks readAuditRaw (older
  // fakes / a minimal audit act) or the batch shape doesn't line up. A single snapshot is also more
  // consistent than N reads spread across the pass. The mismatch→refill re-read below stays per-field
  // (a fresh read of the ONE field just re-filled). Any batch failure → null → per-field fallback.
  let batch = null;
  const _specs = entries.map((e) => ({
    widgetType: e.widgetType, wrapperSel: e.auditLoc, tag: e.auditTag || null,
    dateSegs: e.widgetType === "date" ? auditDateSegments(e.expected).map((s) => s[0]) : null
  }));
  if (typeof act.readAuditRaw === "function" && entries.length) {
    try {
      const raws = await act.readAuditRaw(_specs);
      if (Array.isArray(raws) && raws.length === entries.length) batch = raws;
    } catch (err) { batch = null; }
  }
  const verdicts = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    let { actual, readable } = batch ? auditActualFromRaw(e.widgetType, batch[i]) : await auditReReadActual(act, e);
    let verdict = classify(e, actual, readable);
    if (verdict === "mismatch" && refillOnMismatch) {
      try {
        await auditRefillEntry(act, e, b);
        const re = await auditReReadActual(act, e);
        const v2 = classify(e, re.actual, re.readable);
        if (v2 === "match") { verdict = "recovered"; actual = re.actual; }
        else if (re.actual !== null) { actual = re.actual; } // surface the latest live truth on the still-mismatch flag
      } catch (err) { /* act lacks fill primitives / re-fill threw → flag the ORIGINAL mismatch */ }
    }
    verdicts.push({ key: e.key, widgetType: e.widgetType, expected: e.expected, actual, verdict });
  }
  return verdicts;
}

// Build the audit entry list from drivePageFill results (the fields claiming a value) +
// apply the verdicts back to the results in place (a mismatch downgrades to needs_review).
function auditEntriesFromResults(results) {
  return (results || [])
    // Audit only fields the BOT actuated. An "already-filled" record (an UNKNOWN section's existing
    // entry, surfaced read-only) was never touched by the bot — there's nothing to reconcile, and
    // auditing it MIS-reconciles (e.g. a checkbox re-read returns a boolean vs the "Yes" expected →
    // the inline re-fill toggles it OFF — the live "fluent checkbox unchecked" bug). Skip it.
    .filter((r) => (r.status === "filled" || r.status === "filled_review") && r.auditLoc && r.flag !== "already-filled" && r.flag !== "already-filled-match")
    .map((r) => ({ key: r.fieldName, widgetType: r.widgetType, auditLoc: r.auditLoc, auditTag: r.auditTag || null, expected: r.after }));
}
function applyAuditVerdicts(results, verdicts) {
  for (const v of verdicts) {
    if (v.verdict === "match") continue;
    const rec = (results || []).find((r) => r.fieldName === v.key);
    if (!rec) continue;
    if (v.verdict === "recovered") {
      // M40 self-heal: the field drifted post-fill but a re-fill restored it — KEEP it filled/verified
      // (rec.after already equals the value), just note the auto-correction. NOT needs_review.
      rec.detail = (rec.detail ? rec.detail + " | " : "") + `AUDIT: drifted post-fill, re-filled to "${v.actual}"`;
      continue;
    }
    rec.verified = false;
    rec.status = "needs_review";
    if (v.verdict === "mismatch") {
      rec.flag = "audit-mismatch";
      rec.after = v.actual; // the bundle must show the TRUTH (the live page), not the claimed value
      rec.detail = (rec.detail ? rec.detail + " | " : "") + `AUDIT: page shows "${v.actual}" not "${v.expected}"`;
    } else {
      rec.flag = "audit-unverifiable";
      rec.detail = (rec.detail ? rec.detail + " | " : "") + "AUDIT: could not re-read to verify";
    }
  }
}

// FoS Round 3: scrape a typeahead's FULL option list (read-only) so the summary can render a
// searchable editor over the COMPLETE list (the fill itself only ever records captured_options =
// the partial search matches). Called INLINE in fillEntryCdp RIGHT AFTER the field is committed —
// so the open/scroll happens DURING that typeahead's fill step (adjacent, the operator's ask), not
// as a disjoint end-of-page sweep. AFTER (never before) the commit: a scrape before the fill
// scrolled the virtualized list + corrupted the immediately-following keptLowerTier re-commit.
//
// READ-ONLY: opens the field + scrolls (act.scrapeTaOptions = scrollTop + reads, no type/Enter/arrow
// → nothing arms), then a stray-safe close (Tab — the only clean non-committing exit; Escape kept
// focus + any armed row, Tab abandons it).
// Returns the options array, or null (NON-FATAL: null → the summary falls back to captured_options).
// Anti-stray close-confirm for the READ-ONLY typeahead recon (2026-07-06): after a Tab-blur the searchBox
// and portaled promptOption LEAVES linger a beat, still clickable — so the NEXT recon field's open-click can
// land on a lingering leaf (the same race the dropdown recon close had — "Landline → Phone Device Type").
// Poll `leafCount` (the mounted promptOptions — the analog of the dropdown's optionCount) until it reaches 0
// (leaves unmounted → no clickable stray target). Adaptive → breaks the instant the popup empties (fast
// happy path); bounded by iterations + a real deadline so a slow close (or an older substrate whose readHier
// lacks leafCount) never hangs. Read-only (only readHier + a settle).
async function awaitTypeaheadClosed(act, loc, budgets) {
  if (!act || !act.readHier) return;
  const dr = act.delayRender || act.delayFull;
  const dl = Date.now() + (budgets.openRetries || 3) * (budgets.reopenSettleMs || 400);
  for (let i = 0; i < 12 && Date.now() < dl; i++) {
    let cs = null; try { cs = await act.readHier(loc); } catch (e) { return; }
    if (!cs || cs.leafCount === 0) return; // leaves gone → no lingering clickable option
    if (dr) await dr(budgets.reopenSettleMs); else return;
  }
}
// Called from captureChoiceOptions at END OF PAGE (when fields are settled/closed → a fresh re-open
// shows the empty-filter full list); an inline call races the post-commit state (banner / residual
// search → empty scrape) or corrupts the commit, so it is NOT called inline.
async function captureFieldOptions(act, loc, budgets) {
  if (!act || !act.scrapeTaOptions) return null; // substrate (or an older fake) without the scrape → no-op
  const delayRender = act.delayRender || act.delayFull; // STAGE 3: read-only capture render-settle, adaptive under the measured-fast gate (fallback for older fakes)
  try {
    // open + re-assert focus on the searchBox so the full (empty-filter) list renders
    const ensureFocused = async () => {
      let st = await act.readHier(loc);
      if (!st || !st.searchBox || !st.searchBox.visible) {
        await act.openHier(loc);
        const t0 = Date.now();
        while (Date.now() - t0 < budgets.taOpenCeilingMs) {
          await delayRender(budgets.taOpenIntervalMs); // poll for searchBox.visible; ceiling stays raw (full)
          st = await act.readHier(loc);
          if (st && st.searchBox && st.searchBox.visible) break;
        }
      }
      if (st && st.searchBox && st.searchBox.visible && !st.searchBox.focused) { await act.focusHierSearch(loc); await delayRender(budgets.taOpenIntervalMs); }
      const r = await act.readHier(loc);
      return !!(r && r.searchBox && r.searchBox.visible);
    };
    let options = null;
    if (await ensureFocused()) {
      const scrape = await act.scrapeTaOptions(loc);
      if (scrape && scrape.ok && Array.isArray(scrape.options) && scrape.options.length) options = scrape.options.slice();
    }
    // stray-safe close (the scrape is read-only — no type/Enter/arrow → nothing arms): exit via TAB,
    // the only clean non-committing exit (Escape keeps focus + any armed row; Tab abandons it). The
    // field's existing chip is preserved; the end-of-page M40 audit backstops any stray.
    await act.pressTab();
    await awaitTypeaheadClosed(act, loc, budgets); // confirm the popup's leaves are GONE before returning — anti-stray for the next recon field (was a fixed adaptive settle that could return with leaves still up)
    return options;
  } catch (e) { return null; } // non-fatal: null → summary falls back to captured_options
}

// Capture a DROPDOWN's full option list (read-only) for the summary's editable <select>. A
// `dropdown-prefilled-kept` dropdown (M27.C zero-actuation short-circuit) never opened during the
// fill, so it carries no options; at end-of-page (resting/closed) a fresh open scrapes them cleanly.
// READ-ONLY: openAndReadDropdown (open-retry + GATE-2 option settle) → enabled option texts →
// closeAndVerifyBlank on the KEPT value (Escape-close, no commit; value preserved — a stray is caught
// + M40-backstopped). Returns the options array or null (non-fatal). Reuses the proven AI-1 readers.
async function captureDropdownOptions(act, loc, budgets) {
  if (!act || !act.openDropdown || !act.readDropdownState) return null;
  try {
    const { before, state } = await openAndReadDropdown(act, loc, budgets);
    const opts = state && Array.isArray(state.options) ? state.options.filter((o) => !o.disabled).map((o) => o.text) : [];
    await closeAndVerifyBlank(act, loc, before, budgets); // close, no commit (kept value preserved)
    return opts.length ? opts : null;
  } catch (e) { return null; } // non-fatal: null → summary shows the current value only
}

// END-OF-PAGE option capture for the summary's editable choice fields. Runs in drivePageFill AFTER
// the whole page is filled but BEFORE the M40 audit (which then re-reads each VALUE + backstops any
// capture-induced stray). For every filled/filled_review choice record that LACKS options, scrape the
// full list into rec.options so the review editor renders a real <select>/combobox, not a bare textbox.
// The `!rec.options.length` guard (below) means only OPTIONLESS records ever re-open — a committed flat
// dropdown already carries enabledTexts and a start-scraped flat typeahead already carries its options,
// so both are skipped. The records that DO reach a scrape here are the tier-0 "kept without actuation"
// ones — a `dropdown-prefilled-kept` flat dropdown (country/state/phone) and a `prefilled-kept` flat
// typeahead (countryPhoneCode), plus the repeating-section dropdowns/FoS typeaheads. This is the M27.C
// cold-list cost, now PAID deliberately (operator ask 2026-07-05: page-1 choice fields must show a real
// dropdown in review, same as page-2 does). Dispatch by widget; cache per option-set key so
// same-vocabulary fields (FoS across education entries; language/proficiency dropdowns across entries)
// re-open ONCE, not N times. Non-fatal throughout.
async function captureChoiceOptions(act, results, budgets) {
  if (!act) return;
  const cache = new Map(); // key → options[] | null (already attempted)
  for (const rec of results || []) {
    if (!rec || !rec.auditLoc) continue;
    if (rec.status !== "filled" && rec.status !== "filled_review") continue;
    if (Array.isArray(rec.options) && rec.options.length) continue; // committed dropdown / start-scraped typeahead already has them
    let key, scrape;
    if (rec.widgetType === "typeahead" && act.scrapeTaOptions) {
      // Repeating-section FoS typeaheads AND flat page-1 typeaheads kept without actuation
      // (prefilled-kept, e.g. countryPhoneCode): a tier-0 keep never opened the widget so nothing was
      // start-scraped. captureKey groups same-vocabulary repeating fields; a flat field keys on fieldName.
      key = "ta:" + (rec.captureKey || rec.fieldName);
      scrape = () => captureFieldOptions(act, { wrapperSel: rec.auditLoc }, budgets);
    } else if (rec.widgetType === "dropdown" && act.openDropdown) {
      // Repeating-section dropdowns (education[0].degree, language[1].readingProficiency — cached by stem)
      // AND flat page-1 dropdowns kept as pre-filled (country/state/phone — dropdown-prefilled-kept, zero
      // actuation → no options). A flat field has no "[idx]." segment, so split(".").pop() yields the bare
      // fieldName (country/countryRegion/phoneType) — each keyed distinctly, scraped once.
      key = "dd:" + String(rec.fieldName).split(".").pop(); // recName stem (degree/language/readingProficiency) — same stem ⇒ same option vocabulary
      scrape = () => captureDropdownOptions(act, { wrapperSel: rec.auditLoc }, budgets);
    } else continue;
    if (!cache.has(key)) cache.set(key, await scrape());
    const opts = cache.get(key);
    if (opts && opts.length) rec.options = opts.slice();
  }
}

// ============================================================================
// M38 Part 2 — CDP review-summary bundle (the persisted review UI for the CDP path).
// Reproduces the page-engine fillEngine's buildEntry + mapFillStatus/deriveConfidence/
// deriveReview (background.js ~3716) — they are PURE and read ONLY the rec fields a CDP
// result carries, so they apply verbatim. TODO(dup): keep in LOCKSTEP with fillEngine —
// summary.html (the viewer) reads BOTH paths' bundles, so a schema change must update
// both copies + the viewer. Section recs (.add/.delete/.removed) are filtered (not
// review fields). `field_id` is PAGE-QUALIFIED for global uniqueness across the
// accumulated multi-page bundle (the viewer keys reviewValueNodes on field_id).
// ============================================================================
const REVIEW_SCHEMA_VERSION = "1.1"; // 1.1 (Plan 2): + page_number/page_label, is_approved/approved_at. The viewer tolerates 1.0 (missing fields default).
const ACCEPTED_SCHEMA_VERSIONS = ["1.0", "1.1"]; // M4 submit gate accepts these (the viewer's documented tolerance); anything else = stale build → block.

// isTransientRenderFailure — are ALL these failing records TRANSIENT render-flakes (retryable via a page
// RELOAD) rather than terminal (a genuine no-match / real error / session death, which must halt)? The
// flake: a choice widget whose option list never rendered ("options did not render" /
// "skipped_no_option_match" — a Workday render race a reload clears; live-seen on Magna page-2 language
// proficiencies). Returns false when there are NO failures, or when ANY failure is terminal — so a reload
// can NEVER mask a real problem. Used by both walks' bounded reload-retry (operator ask 2026-07-11). PURE.
const RENDER_FLAKE_RX = /options did not render|skipped_no_option_match/i;
function isTransientRenderFailure(records) {
  const fails = (records || []).filter((r) => r && (r.status === "needs_review" || r.status === "error"));
  if (!fails.length) return false;
  return fails.every((r) => RENDER_FLAKE_RX.test(String((r && r.detail) || "") + " " + String((r && r.flag) || "")));
}

// submitPrecondition (M4) — the ORDERED gate for the ONE irreversible click (act.clickSubmit). PURE:
// every input is passed in; returns { ok, blockers[] } (blockers = human-readable reasons, logged for
// the operator). ALL conditions must pass. This is the safety surface — clickSubmit fires ONLY when
// this returns ok. Inputs: the approved `bundle` (reviewSummary), the LIVE session state
// (cdpReadSessionState), the replay `findings` accumulated across the walk, and control `opts`
// (authorize + alreadyFired single-fire sentinel). NAMED invariant (unit-pinned): SUBMIT never fires
// with any unresolved flagged/needs_review field, any unreplaced AI placeholder, or without authorize.
function submitPrecondition(bundle, liveState, findings, opts) {
  const o = opts || {};
  const f = findings || {};
  const blockers = [];
  const entries = (bundle && Array.isArray(bundle.entries)) ? bundle.entries.filter((e) => !e.is_deleted) : [];
  // 1. explicit per-run authorization (a token, never a standing setting).
  if (o.authorize !== true) blockers.push("not authorized (authorize !== true)");
  // 2. must be ON the review page — the ONLY page where the footer button IS Submit.
  if (!(liveState && liveState.applyFlowReviewPresent)) blockers.push("not on the review page (applyFlowReviewPresent is false)");
  // 3. session alive / not planned-maintenance.
  if (liveState && apMatch.isWorkdayMaintenance(liveState)) blockers.push("Workday maintenance page");
  else if (liveState && apMatch.sessionLooksDead(liveState)) blockers.push("session dead / expired");
  // 4. a real bundle + a schema this build can honor (never replay a stale-build bundle).
  if (!entries.length) blockers.push("no approved bundle entries to replay");
  if (bundle && bundle.schema_version && ACCEPTED_SCHEMA_VERSIONS.indexOf(bundle.schema_version) === -1) {
    blockers.push(`bundle schema_version "${bundle.schema_version}" not in accepted ${JSON.stringify(ACCEPTED_SCHEMA_VERSIONS)}`);
  }
  // 5. every field that requires approval IS approved. requiresApproval = needs_review && !deleted
  //    (mirrors summary-lib requiresApproval); super-hard / legally-loaded / needs-answer / eeo-guess
  //    are ALL needs_review, so this single check covers the whole mustReplace class.
  // needs_review OR cascade_revealed (M6: a revealed field forces a second review even if it filled
  // cleanly) must be human-approved — mirrors summary-lib requiresApproval so the gate and the viewer agree.
  const unapproved = entries.filter((e) => (e.needs_review || e.cascade_revealed) && !e.is_approved);
  if (unapproved.length) blockers.push(`${unapproved.length} flagged/revealed field(s) not approved (${unapproved.slice(0, 3).map((e) => e.field_id || e.canonical_field).join(", ")}${unapproved.length > 3 ? ", …" : ""})`);
  // 6. no unreplaced AI placeholder — in the BUNDLE, and (belt-and-suspenders) on the LIVE page.
  const bundlePh = apMatch.unreplacedPlaceholders(entries) || [];
  if (bundlePh.length) blockers.push(`${bundlePh.length} unreplaced AI placeholder(s) in the bundle`);
  if (f.livePlaceholder) blockers.push("an unreplaced AI placeholder is VISIBLE on the live review page");
  // 6b. REVIEW-PAGE EQUALITY — the review page must DISPLAY exactly the approved values (operator
  //     requirement). A scrape failure = can't confirm → block (strict). disagree = the page shows a
  //     CONTRADICTING value; missing = an approved value NOT shown on the page. (The caller logs
  //     extra-on-page but does not block on it — review boilerplate is noisy.)
  if (f.reviewScrapeFailed) blockers.push("could not read the review page to confirm it matches the approved values");
  if (Array.isArray(f.reviewDisagree) && f.reviewDisagree.length) blockers.push(`${f.reviewDisagree.length} review-page value(s) DISAGREE with the approved bundle`);
  if (Array.isArray(f.reviewMissing) && f.reviewMissing.length) blockers.push(`${f.reviewMissing.length} approved value(s) not shown on the review page`);
  // 7. no cascade-revealed field the bundle never covered (surfaced during the replay walk).
  if (Array.isArray(f.cascadeRevealed) && f.cascadeRevealed.length) blockers.push(`${f.cascadeRevealed.length} cascade-revealed field(s) not in the approved bundle`);
  // 8. zero replay-verify mismatches / unverifiables across all pages (a clean walk never reaches here
  //    with any — it halts earlier — but the gate re-checks; defense in depth).
  if (Array.isArray(f.mismatches) && f.mismatches.length) blockers.push(`${f.mismatches.length} replay-verify mismatch(es) across the walk`);
  // 9. single-fire — once clickSubmit has fired this run, a second attempt is a no-op (no double-submit).
  if (o.alreadyFired) blockers.push("submit already fired this run (single-fire sentinel)");
  return { ok: blockers.length === 0, blockers };
}

function summarizeEntries(entries) {
  return {
    total: entries.length,
    counts: entries.reduce((a, e) => { a[e.fill_status] = (a[e.fill_status] || 0) + 1; return a; }, {}),
    by_type: entries.reduce((a, e) => { a[e.widget_type] = (a[e.widget_type] || 0) + 1; return a; }, {}),
    needs_review_count: entries.filter((e) => e.needs_review).length
  };
}

// Build a SINGLE-page review bundle from drivePageFill's results. `meta = { page, url,
// tenant, capturedAt }` — the SW stamps capturedAt + the PRE-fill cdpPageSig as `page`.
// m3c: classify a typeahead for the summary — TREE-AWARE. A TREE picker (cert/source) has CATEGORY
// rows (readTreeCategories non-empty) → tag widget_type "hierarchical" WITHOUT an option list (the
// summary shows a TIER editor — the user supplies ordered candidates; scraping categories/leaves is
// not useful). A FLAT typeahead (Field of Study) → all options via the proven captureFieldOptions
// (role=option scrape) → a searchable combobox. ONE open cycle.
async function captureTypeaheadOptions(act, loc, budgets) {
  if (!act || !act.openHier) return null;
  const delayRender = act.delayRender || act.delayFull; // STAGE 3: read-only capture render-settle, adaptive under the measured-fast gate (fallback for older fakes)
  try {
    let st = null; const t0 = Date.now();
    const ceiling = budgets.taOpenCeilingMs || 20000;
    await act.openHier(loc);
    while (Date.now() - t0 < ceiling) {
      await delayRender(budgets.taOpenIntervalMs || 300); // poll for searchBox.visible; ceiling stays raw (full)
      st = act.readHier ? await act.readHier(loc) : null;
      if (st && st.searchBox && st.searchBox.visible) break;
      // RE-OPEN: a FRESHLY-MOUNTED typeahead's first open-click can no-op (React still rendering the
      // new entry) → the box never opens → we'd scrape nothing → tier-editor fallback. Retry the open
      // (only while NOT visible, so we never toggle-close a box that just opened).
      if (act.openHier) await act.openHier(loc);
    }
    const opened = !!(st && st.searchBox && st.searchBox.visible);
    if (!opened) { console.log("[ApplyPilot][ta-recon] NEVER OPENED after " + Math.round((Date.now() - t0) / 1000) + "s:", loc.wrapperSel, "→ no options (tier editor)"); return { widget_type: "typeahead", options: [] }; }
    let cats = [];
    if (act.readTreeCategories) { try { cats = await act.readTreeCategories(loc); } catch (e) {} }
    if (Array.isArray(cats) && cats.length) { // TREE → just tag hierarchical (categories aren't useful
      console.log("[ApplyPilot][ta-recon] TREE (" + cats.length + " categories) → hierarchical/tier editor:", loc.wrapperSel);
      if (act.pressTab) { await act.pressTab(); await awaitTypeaheadClosed(act, loc, budgets); } // anti-stray: wait until the popup's leaves unmount before the next recon field opens
      return { widget_type: "hierarchical" };
    }
    // FLAT → focus so the full list renders, then scrape [role=option]. A FRESHLY-MOUNTED typeahead's
    // list is server-populated a BEAT AFTER open, so an immediate scrape sees 0 (the live empty-Education
    // FoS bug). POLL scrapeTaOptions until it returns options — re-opening/re-focusing to keep the box
    // alive — up to the recon ceiling. Still 0 at the ceiling = genuinely empty on open (server-search-
    // only, needs a typed query) → tier-editor fallback, honestly.
    let opts = [];
    const scCeiling = Math.min(budgets.taOpenCeilingMs || 20000, 8000);
    const t2 = Date.now();
    while (act.scrapeTaOptions && Date.now() - t2 < scCeiling) {
      const s2 = act.readHier ? await act.readHier(loc) : st;
      if (!(s2 && s2.searchBox && s2.searchBox.visible)) { if (act.openHier) await act.openHier(loc); await delayRender(budgets.taOpenIntervalMs || 300); continue; } // box closed → re-open
      if (s2.searchBox && !s2.searchBox.focused && act.focusHierSearch) { await act.focusHierSearch(loc); await delayRender(budgets.taOpenIntervalMs || 300); }
      const sc = await act.scrapeTaOptions(loc);
      if (sc && sc.ok && Array.isArray(sc.options) && sc.options.length) { opts = sc.options.slice(); break; }
      await delayRender(budgets.taOpenIntervalMs || 300); // poll interval between scrape attempts; scCeiling stays raw (full)
    }
    console.log("[ApplyPilot][ta-recon] FLAT →", opts.length, "options after " + (Math.round((Date.now() - t2) / 100) / 10) + "s:", loc.wrapperSel);
    if (act.pressTab) { await act.pressTab(); await awaitTypeaheadClosed(act, loc, budgets); } // anti-stray: wait until the popup's leaves unmount before the next recon field opens
    return { widget_type: "typeahead", options: opts };
  } catch (e) { return null; }
}

// m3c: the form's date-segment ORDER + granularity from a field's dateSegments (["dateSectionMonth-
// input","dateSectionDay-input","dateSectionYear-input"] → ["month","day","year"]; M/Y → ["month",
// "year"]; year-only → ["year"]). The summary renders segmented inputs in THIS order (matches the
// form's mm/dd/yyyy — a browser <input type=date> would show the locale order instead).
function dateOrderOf(segs) {
  const order = [];
  for (const seg of (Array.isArray(segs) ? segs : [])) {
    const m = /dateSection(Month|Day|Year)/i.exec(String(seg));
    if (m) { const p = m[1].toLowerCase(); if (!order.includes(p)) order.push(p); }
  }
  return order;
}

// m3b: REVEAL-BY-ADD — an EMPTY unknown section is present only via its Add button + heading (no
// entry container to read), so mount ONE entry, detect its field shape + the now-known fkit prefix,
// then DELETE it (leave the form as found). Returns { prefix, base, heading, shape } or null if it
// couldn't mount. Uses the proven clickSectionAdd / repeatingScan / clickDeleteEntry primitives.
async function revealUnknownSection(act, heading, budgets) {
  const escaped = String(heading).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const before = await act.repeatingScan();
  const beforePrefixes = new Set(Object.keys((before && before.sections) || {}));
  const beforeCounts = {}; // per-prefix entry count BEFORE the add — so we can tell a NEW section from a grown existing one
  for (const p of beforePrefixes) beforeCounts[p] = ((before.sections[p] && before.sections[p].entries) || []).length;
  // NESTED snapshot (mis-click insurance): clickSectionAdd anchors page-wide by heading, so it can
  // land on a NESTED sub-section's Add — which mounts a row INVISIBLE to the prefix/grown detection
  // (no --null container, parent count unchanged). Snapshot the nested entries so the dead-end
  // below can find + delete what the click actually mounted (never a leftover phantom row).
  const nestedKeys = async () => {
    if (!act.nestedScan) return null;
    let ns = null; try { ns = await act.nestedScan(); } catch (e) { return null; }
    const keys = new Set();
    for (const g of ((ns && ns.nestedSections) || [])) {
      for (const ent of (g.entries || [])) {
        const lv = ent.levels || [];
        if (lv.length >= 2) keys.add(lv[0].base + "|" + lv[0].index + "|" + lv[lv.length - 1].base + "|" + lv[lv.length - 1].index);
      }
    }
    return keys;
  };
  const nestedBefore = await nestedKeys();
  const clicked = await act.clickSectionAdd(escaped);
  if (!clicked || !clicked.ok) return null;
  const newOf = (scan) => Object.keys((scan && scan.sections) || {}).find((p) => !beforePrefixes.has(p));
  // an EXISTING prefix whose count GREW — the "Add" belonged to a section that ALREADY HAS entries
  // (m3a's territory), NOT an empty unknown section. We must NOT surface a duplicate, and we MUST
  // delete the entry we just accidentally added (else a leftover empty entry — the live Languages bug).
  const grownOf = (scan) => Object.keys((scan && scan.sections) || {}).find((p) => beforePrefixes.has(p) && (((scan.sections[p] && scan.sections[p].entries) || []).length > (beforeCounts[p] || 0)));
  let scan = await act.repeatingScan();
  let newPrefix = newOf(scan), grown = grownOf(scan);
  const deadline = Date.now() + (budgets.entryReconcileCeilingMs || 4000);
  while (!newPrefix && !grown && Date.now() < deadline) {
    await act.delay(budgets.entryReconcileIntervalMs || 150);
    scan = await act.repeatingScan();
    newPrefix = newOf(scan); grown = grownOf(scan);
  }
  if (!newPrefix) {
    if (grown) {
      console.log("[ApplyPilot][m3b] '" + heading + "' Add grew EXISTING section " + grown + " (has entries → m3a's job) — deleting the accidental entry, not surfacing a duplicate");
      try { await act.clickDeleteEntry(grown, (((scan.sections[grown] && scan.sections[grown].entries) || []).length) - 1); } catch (e) { /* best-effort */ }
    } else if (nestedBefore && act.clickNestedDelete) {
      // no new prefix AND nothing grew — did the click mount a NESTED row (invisible to both
      // checks)? Diff the nested entries and delete what appeared (the phantom-specialty backstop).
      const nestedAfter = await nestedKeys();
      for (const k of (nestedAfter || new Set())) {
        if (nestedBefore.has(k)) continue;
        const [pBase, pIdx, cBase, cIdx] = k.split("|");
        console.log("[ApplyPilot][m3b] '" + heading + "' Add mounted a NESTED " + pBase + "[" + pIdx + "] ▸ " + cBase + " row (not a top-level section) — deleting the accidental row");
        try { await act.clickNestedDelete(pBase + "-" + pIdx + "--null", cBase, isNaN(+cIdx) ? cIdx : +cIdx); } catch (e) { /* best-effort */ }
      }
    }
    return null; // not an empty unknown section → don't reveal (m3a already surfaced it)
  }
  const sec = scan.sections[newPrefix];
  const fields = (sec && sec.entries && sec.entries[0] && Array.isArray(sec.entries[0].fields)) ? sec.entries[0].fields : [];
  console.log("[ApplyPilot][m3b] revealed '" + heading + "' → " + newPrefix + " (" + fields.length + " fields) — reconning options…");
  if (act.delayFull) await act.delayFull(budgets.reopenSettleMs || 300); // let the freshly-mounted entry become interactive before opening its widgets
  // Recon each CHOICE field's options while the entry is mounted (reuses the proven capture fns) so
  // the summary can render real widgets, not text boxes: dropdown → all options; typeahead → all
  // options; a TREE typeahead → its top-level CATEGORIES only (re-tagged widget_type "hierarchical"
  // → the summary shows a "these are categories, not the final options" note). text/date/checkbox
  // carry no options — the summary renders them by widget_type (date → a date picker). Non-fatal.
  const shape = [];
  for (const f of fields) {
    const s = { recName: f.fieldName, path: f.fieldName, widget_type: f.widgetType, label: f.label, is_required: !!f.isRequired };
    const loc = { wrapperSel: f.wrapperSel };
    try {
      if (f.widgetType === "dropdown") {
        const opts = await captureDropdownOptions(act, loc, budgets);
        if (opts && opts.length) s.options = opts;
      } else if (f.widgetType === "typeahead") {
        const cap = await captureTypeaheadOptions(act, loc, budgets); // tree → categories (retag hierarchical); flat → all options
        if (cap) { s.widget_type = cap.widget_type; if (Array.isArray(cap.options) && cap.options.length) s.options = cap.options; }
      } else if (f.widgetType === "date") {
        const ord = dateOrderOf(f.dateSegments); // the form's segment order → summary renders segmented inputs, not a locale date picker
        if (ord.length) s.date_order = ord;
      }
    } catch (e) { /* non-fatal — the field stays a text box in the summary */ }
    shape.push(s);
  }
  // clean up — delete the entry we mounted so the form is left as we found it (0 entries)
  try { await act.clickDeleteEntry(newPrefix, (sec.entries || []).length - 1); } catch (e) { /* best-effort */ }
  return { prefix: newPrefix, base: newPrefix.replace(/-$/, ""), heading: (sec && sec.heading) || heading || null, shape };
}


// 2c: DETECT a section's field shape from a live repeating-scan (the m1 per-entry read) — the
// field SET comes from the FORM, not the hardcoded *_MAP. Keyed by the PAGE_SECTIONS `name` (=
// the review viewer's section key). Only sections with ≥1 MOUNTED entry yield a shape (an empty
// section has nothing to read — it reuses a shape CACHED from a run where it WAS populated, or the
// map as a cold fallback). recName/path = the DOM automation-id suffix (the real selector, best for
// replay); label/required come from the DOM too. Pure (no I/O) → unit-tested.
function detectSectionShapes(scan) {
  const shapes = {};
  if (!scan || !scan.sections) return shapes;
  // m3a: iterate EVERY section the scan found (known + unknown), not just PAGE_SECTIONS. Key by the
  // registry name for a known section, else the discovered base (= the viewer's section key for an
  // unknown section). A present-but-empty section has no entry to read → no shape (m3b reveal-by-add).
  const knownByPrefix = {};
  for (const sec of PAGE_SECTIONS) knownByPrefix[sec.containerPrefix] = sec.name;
  // A KNOWN section's NESTED child fields + per-entry Attachments live INSIDE the entry container,
  // so the entry scan sees them — but they belong to nested_shapes / nested_attachments (the viewer's
  // Specialties sub-card + file picker), NOT the flat add-entry shape. This scan runs on the page's
  // ORIGINAL state: a specialty mounted at page-load leaked Specialty*/Start/End + a text-box
  // "Attachments" row into the cert's add-entry template (operator bug 2026-07-02). LOCKSTEP with
  // captureDetectedShape's exclusion (driveRepeatingSectionCdp).
  const nestedExcl = {};
  for (const sec of PAGE_SECTIONS) {
    nestedExcl[sec.containerPrefix] = {
      names: new Set([].concat(...(((sec.nested || {}).subSections) || []).map((ss) => (ss.fieldMap || []).map((fm) => fm.field)))),
      attach: !!(sec.nested && sec.nested.attachments)
    };
  }
  for (const prefix of Object.keys(scan.sections)) {
    const s = scan.sections[prefix];
    const fields = s && Array.isArray(s.entries) && s.entries[0] && Array.isArray(s.entries[0].fields) ? s.entries[0].fields : null;
    if (!fields || !fields.length) continue;
    const name = knownByPrefix[prefix] || prefix.replace(/-$/, "");
    const ex = nestedExcl[prefix] || { names: new Set(), attach: false };
    // fieldName "" = the Attachments wrapper ("formField-" with an empty suffix) — an unusable
    // recName in any shape (and the classifier can't type a bare file wrapper reliably) → always out.
    const flat = fields.filter((f) => f.fieldName && !ex.names.has(f.fieldName) && !(ex.attach && f.widgetType === "file_upload"));
    if (!flat.length) continue;
    shapes[name] = flat.map((f) => {
      const s = { recName: f.fieldName, path: f.fieldName, widget_type: f.widgetType,
        label: f.label != null ? f.label : f.fieldName, is_required: !!f.isRequired };
      if (f.widgetType === "date") { const ord = dateOrderOf(f.dateSegments); if (ord.length) s.date_order = ord; } // m3c: segment order for the summary date editor
      return s;
    });
  }
  return shapes;
}

function buildReviewBundle(results, meta) {
  const m = meta || {};
  const mapFillStatus = (status) => {
    if (status === "filled" || status === "filled_review") return "filled";
    if (status === "skipped") return "skipped";
    if (status === "error") return "error";
    return "not_filled"; // needs_review / null
  };
  const deriveConfidence = (rec) => {
    // AI fills carry the MODEL's self-reported inference confidence (high/medium/low) — surface
    // it (not the flagged-"none" band) so the review shows how sure the AI was. NOT prominence:
    // the viewer keys sensitive-prominence off the ai-choice-sensitive FLAG, never this.
    if (rec.flag && rec.flag.indexOf("ai-") === 0 && (rec.confidence === "high" || rec.confidence === "medium" || rec.confidence === "low")) {
      return { confidence: rec.confidence, confidence_source: "ai_inference" };
    }
    const flagged = rec.status === "needs_review" || rec.status === "filled_review" || rec.status === "error";
    let source;
    if (rec.fieldName === "candidateIsPreviousWorker") source = "employer_match";
    else if ((rec.widgetType === "text" || rec.widgetType === "date" || rec.widgetType === "textarea") && rec.status === "filled") source = "profile_direct";
    else if (rec.matchTier === "exact-normalized" || rec.matchTier === "label-exact") source = "exact";
    else if (rec.matchTier === "containment") source = "containment";
    else if (typeof rec.matchTier === "string" && rec.matchTier.startsWith("fuzzy")) source = "fuzzy";
    else source = "reason";
    let band;
    if (flagged || rec.status === "skipped") band = "none";
    else if (source === "profile_direct" || source === "exact" || source === "employer_match") band = "high";
    else band = "medium";
    return { confidence: band, confidence_source: source };
  };
  const deriveReview = (rec) => {
    // SECTION STUB (Feature A): a present-but-empty repeating section → a gentle review item so the
    // operator can see it / add an entry. Handled BEFORE the flagged-base guard (its status is
    // "skipped", which would otherwise early-return needs_review:false).
    if (rec.flag === "section-stub") return { needs_review: true, needs_review_reason: "section_unfilled" };
    if (rec.flag === "already-filled") { // a field already on the form — bot didn't fill it (unknown section OR the page-wide sweep)
      if (rec.status === "skipped") return { needs_review: false, needs_review_reason: null }; // OPTIONAL + empty → fine to leave, no approval needed
      return { needs_review: true, needs_review_reason: "already_on_form" }; // has a value (verify) OR required + empty (needs a value)
    }
    if (rec.flag === "already-filled-match") return { needs_review: false, needs_review_reason: null }; // already on the form AND equals the profile value → correct, no flag
    if (rec.flag === "nested-unfilled") return { needs_review: true, needs_review_reason: "nested_section" }; // a nested repeating field (cert → specialty) — operator fills/verifies
    if (rec.flag === "nested-section-stub") return { needs_review: true, needs_review_reason: "nested_section" }; // an EMPTY nested sub-section (reveal-by-add) — operator adds/verifies entries
    if (rec.flag === "nested-attachment") return { needs_review: true, needs_review_reason: "nested_attachment" }; // a per-entry attachment — upload on the form
    const required = !!rec.isRequired;
    const flaggedBase = rec.status === "needs_review" || rec.status === "filled_review" || rec.status === "error";
    const escalated = rec.status === "skipped" && required;
    if (!flaggedBase && !escalated) return { needs_review: false, needs_review_reason: null };
    const detail = (rec.detail || "").toLowerCase();
    let reason;
    if (rec.flag && rec.flag.indexOf("ai-") === 0) {
      // AI-inferred fields get a DISTINCT, scannable reason (so the human doesn't scroll-past
      // an unremarkable "low_confidence"). stray = a value landed that the AI didn't intend.
      if (/stray/.test(rec.flag)) reason = "ai_strayed_value";
      else if (rec.flag === "ai-text-needs-answer") reason = "ai_needs_answer"; // AI-2: REQUIRED placeholder — MUST replace before submit
      else if (rec.flag === "ai-text") reason = "ai_generated";               // AI-2: generated free-text answer
      else if (rec.flag === "ai-text-skip") reason = "ai_skipped";             // AI-2: optional field the AI declined (blank)
      else if (rec.flag === "ai-canonicalized") reason = "ai_canonicalized";   // AI-3: a STATED value mapped to the form's vocab (not inferred)
      else if (rec.flag === "ai-eeo-guess") reason = "ai_eeo_inferred";        // AI-3: a confident DEMOGRAPHIC guess on a required EEO field — VERIFY
      else if (rec.flag === "ai-choice-sensitive") reason = "ai_inferred_sensitive";
      else if (rec.flag === "ai-choice") reason = "ai_inferred";
      else if (rec.flag === "ai-remediation") reason = "ai_remediation";       // AI-4: a field the bot autonomously re-filled/deleted to clear a Save & Continue error — VERIFY
      else reason = "ai_no_answer"; // ai-nomatch / ai-no-options / ai-commit-failed / ai-text-commit-failed / ai-canon-* / ai-eeo-* / ai-error
    }
    else if (rec.flag === "eeo_declined") reason = "eeo_declined";             // AI-3: the AI declined to guess a required demographic → neutral decline
    else if (rec.fieldName === "candidateIsPreviousWorker") reason = "employer_match_uncertain";
    else if (rec.status === "error") reason = "fill_error";
    else if (rec.status === "skipped" && required && !rec.mappedPath) reason = "unmapped_required_field";
    else if (rec.status === "skipped" && required) reason = "required_field_empty";
    else if (detail.includes("no options appeared")) reason = "typeahead_empty_listbox";
    else if (detail.includes("unsupported widget") || detail.includes("no handler")) reason = "unsupported_widget";
    else if (detail.includes("defaults")) reason = "config_missing";
    else reason = "low_confidence";
    return { needs_review: true, needs_review_reason: reason };
  };
  // .add/.delete/.removed are ops; status "removed" = a field DELETED by a cascade / gone at
  // advance-time (drop from summary/counts/review). widgetType "remediation" = AI-4's synthetic
  // action rows ("Duplicate-language workaround", "Removed empty repeating row(s)") — operator rule
  // 2026-07-02: the summary shows EXACTLY what is on the page right before it advances, so the
  // synthetic rows stay OUT of the bundle (the console log keeps the remediation trail;
  // reconPageTruth refreshes the real rows to live state before each re-advance).
  const fieldRecs = (results || []).filter((r) => r.widgetType !== "section" && r.widgetType !== "remediation" && r.status !== "removed");
  const entries = fieldRecs.map((rec, index) => {
    const fill_status = mapFillStatus(rec.status);
    const { confidence, confidence_source } = deriveConfidence(rec);
    const { needs_review, needs_review_reason } = deriveReview(rec);
    // `after` is only ever a LIVE page value (fill verify / honesty reads / audit truth / the sweep)
    // — so it shows in the editor for ANY status, not just filled: a needs_review kept-original
    // ("Other - OTH" kept when 'sdjkf' matched nothing) renders IN THE FIELD with its note, not as
    // an empty box (operator rule 2026-07-02). LOCKSTEP with the background.js buildEntry twin.
    const current_value = rec.after != null ? rec.after : null;
    return {
      field_id: (m.page ? m.page + "::" : "") + "formField-" + rec.fieldName, // PAGE-QUALIFIED → unique in the accumulated bundle
      page: m.page != null ? m.page : null,
      field_index: index,
      question_label: rec.label != null ? rec.label : null,
      widget_type: rec.widgetType,
      canonical_field: rec.mappedPath != null ? rec.mappedPath : null,
      is_required: !!rec.isRequired,
      current_value,
      original_ai_value: current_value, // the bot's pick at write time — never changed by edits
      is_edited: false,
      edit_kind: null,
      is_approved: false,                // Plan 2: explicit human sign-off (flagged fields); the viewer toggles it
      approved_at: null,
      page_number: m.pageNumber != null ? m.pageNumber : null, // the walk's 1..N ordinal (display order/caption); null = single-page/unknown
      page_label: m.pageLabel != null ? m.pageLabel : null,     // friendly caption ("Page N"); null → viewer derives from page_number/page key
      confidence,
      confidence_source,
      needs_review,
      needs_review_reason,
      fill_status,
      fill_error: rec.status === "error" ? (rec.detail || null) : null,
      detail: rec.detail != null ? rec.detail : null,
      match_tier: rec.matchTier != null ? rec.matchTier : null,
      flag: rec.flag != null ? rec.flag : null, // PROVENANCE (was dropped) — the viewer badges "AI-INFERRED" off flag.startsWith("ai-")
      cascade_revealed: !!rec.cascadeRevealed, // M6: this field appeared only AFTER an earlier value committed (cascade re-scan) → the viewer badges it + it FORCES a second review before submit
      options: Array.isArray(rec.options) ? rec.options : null,
      captured_options: Array.isArray(rec.captured_options) ? rec.captured_options : null,
      tree_structure: (rec.tree_structure && typeof rec.tree_structure === "object") ? rec.tree_structure : null, // tree-AI recon (categories + chosen category's leaves) for the summary
      section_field_shape: Array.isArray(rec.section_field_shape) ? rec.section_field_shape : null, // 2b: section_stub → the viewer builds a new entry from this shape
      container_prefix: rec.container_prefix != null ? rec.container_prefix : null, // m3a: backend identifier (fkit prefix) for a future fill-back session
      section_heading: rec.section_heading != null ? rec.section_heading : null,    // m3a: section heading / Add anchor
      section_known: rec.section_known != null ? !!rec.section_known : null,        // m3a: false = unmapped/unknown section
      tiers: null, // m3c: ordered candidate list the review's tier editor fills for a hierarchical field (profile-shaped → portable)
      date_order: Array.isArray(rec.date_order) ? rec.date_order : null, // m3c: segment order → the summary's segmented date editor
      nested_path: Array.isArray(rec.nested_path) ? rec.nested_path : null, // nested: locate-now fkit level path (raw indices) for the fill-back; the ordinal canonical_field is the durable identity
      nested_parent: (rec.nested_parent && typeof rec.nested_parent === "object") ? rec.nested_parent : null, // nested-section stub: { base, index } — the parent entry the sub-section belongs to (viewer sub-grouping)
      nested_child_base: rec.nested_child_base != null ? rec.nested_child_base : null,                         // nested-section stub: the child base (e.g. "specialties") for the add-entry
      nested_shapes: (rec.nested_shapes && typeof rec.nested_shapes === "object") ? rec.nested_shapes : null,  // removed/empty section stub: { childBase → shape } recon'd during the fill → the viewer shows the sub-section on an added-back parent
      nested_attachments: rec.nested_attachments != null ? !!rec.nested_attachments : null,                    // section stub: the form has a per-entry attach field → the viewer offers attachments on an added-back parent
      character_count: null
    };
  });
  return Object.assign({
    schema_version: REVIEW_SCHEMA_VERSION,
    page: m.page != null ? m.page : null,
    page_number: m.pageNumber != null ? m.pageNumber : null,
    page_label: m.pageLabel != null ? m.pageLabel : null,
    url: m.url != null ? m.url : null,
    tenant: m.tenant != null ? m.tenant : null,
    captured_at: m.capturedAt != null ? m.capturedAt : null,
    section_shapes: (m.sectionShapes && typeof m.sectionShapes === "object") ? m.sectionShapes : {} // 2c: DOM-detected per-section field shapes for the review's add-entry
  }, summarizeEntries(entries), { entries });
}

// Accumulate a page bundle into the prior entries — WRITE-PER-PAGE (the M15 decision).
// Drop the prior entries for THIS page (by `entry.page`), KEEP all OTHER pages' entries
// VERBATIM (a viewer EDIT on a prior page survives the next page's persist — NOT a
// rebuild), append this page's, recompute the envelope. PURE — the SW does the I/O.
function accumulateBundle(priorEntries, pageBundle) {
  const pageKey = pageBundle.page;
  // Keep OTHER pages verbatim (edits intact) AND this page's OPERATOR-ADDED entries (2b — they
  // aren't in the engine's freshly-built page bundle, so a re-fill would otherwise drop them; the
  // future section-reconcile CREATEs them on the form). Their index sits beyond the fresh fill's
  // (nextIndexFor = max+1 at add time), so no collision with the rebuilt entries.
  const kept = (priorEntries || []).filter((e) => e.page !== pageKey || e.is_added);
  const entries = kept.concat(pageBundle.entries || []);
  const pages = Array.from(new Set(entries.map((e) => e.page).filter((p) => p != null))).sort();
  return Object.assign({
    schema_version: pageBundle.schema_version,
    page: pages.length > 1 ? "accumulated (" + pages.length + " pages)" : pageBundle.page,
    url: pageBundle.url,
    tenant: pageBundle.tenant,
    captured_at: pageBundle.captured_at
  }, summarizeEntries(entries), { entries });
}

// UMD-lite: export for the Node test runner; in the SW `module` is undefined so
// drivePageFill stays a global (from importScripts).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { drivePageFill, driveRepeatingSectionCdp, sectionsFromErrorNames, deleteTargetsFromErrorNames, deleteEmptyErrorRows, overwriteNoMatchResting, PAGE_SECTIONS, WEBSITE_MAP, LANGUAGE_MAP, EDUCATION_MAP, CERTIFICATION_MAP, WORK_EXPERIENCE_MAP, fillDateCompositeCdp, buildReviewBundle, accumulateBundle, detectSectionShapes, revealUnknownSection, CERT_NESTED, fillNestedSpecialtiesCdp, sweepAlreadyFilled, reconPageTruth, sectionsInDomOrder, DEFAULT_BUDGETS, FIELD_MAP, resolve, decidePreviousWorker, fillTypeaheadCdp, fillSourceCdp, reconDropdownDump, openAndReadDropdown, closeAndVerifyBlank, closeDropdownConfirmed, overwriteBeatLadder, aiFillField, aiFillRadio, aiFillText, aiCanonicalizeField, aiInferEeoField, parseAiText, aiEligible, legallyLoaded, producedNothing, parseAiReply, commitOutcome, flagTierCategory, reconcileAudit, auditDateSegments, auditEntriesFromResults, applyAuditVerdicts, auditRefillEntry, replayField, replayValueMatches, textValuesMatch, phoneShaped, replayFlatFields, isRepeatingEntry, deriveFlatWrapperSel, bundleToSectionItems, coerceReplayValue, replayRepeatingSections, selectPageBundleEntries, submitPrecondition, isTransientRenderFailure, REVIEW_SCHEMA_VERSION, aiRemediateError, parseRemediation, captureFieldOptions, captureDropdownOptions, captureChoiceOptions, awaitListTerminal, awaitListStable, awaitSourceListStable, parseAiTypeaheadReply, aiTypeaheadEligible, aiTypeaheadFallback, isOtherOption, runAiTypeaheadPass, parseAiTreeReply, aiTreeDrillFallback, makeStartCapture, fillFromBucket, buildBucketIndex };
}
