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
  : { normalize: normalize, matchCandidates: matchCandidates };

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
// (() => act.readTypeahead(loc) | act.readSource(loc)).
async function pollSearchValue(act, read, want, budgets) {
  const deadline = Date.now() + budgets.taActionSettleCeilingMs;
  do {
    const st = await read();
    if (st && st.searchBox && st.searchBox.value === want) return true;
    await act.delay(budgets.taActionSettleIntervalMs);
  } while (Date.now() < deadline);
  return false;
}

// overwriteNoMatchResting: the walk-end resting state under overwrite. The
// original chip is intact (we never deleted it). Clear any leftover filter text
// so the field rests as {chips:[original], query:""}, and flag for review (a
// future-AI candidate). Parametrized by read/clear/ensureFocused fns to keep
// typeahead+source in lockstep (the ONLY differences between the two walks).
// clear is the recon-proven chip-PRESERVING Ctrl+A+Delete (clearSearch /
// clearSourceSearch); the best-effort focus is non-actuating beyond the clear.
// keptLowerTier (M36.1): the pre-fill EXACT-matched a LOWER candidate tier and the
// walk over the HIGHER tiers committed nothing (no higher tier is offered by the
// form) → the pre-fill IS the best available answer. KEEP it `filled` (the value is
// a real tier hit, NOT a no-match), flagged `prefilled-better-tier-unavailable` so
// review sees it isn't the top tier — honest taxonomy. (This path DID actuate: it
// searched every higher tier; only the tier-0 keep skips actuation entirely.)
async function overwriteNoMatchResting(act, loc, readFn, clearFn, ensureFocusedFn, priorChips, trace, lastOptions, budgets, keptLowerTier) {
  const original = priorChips.join("; ");
  const focused = await ensureFocusedFn();
  // Resting cleanup (gates nothing verified — the result comes from endChips below, never the
  // searchBox value): clear the leftover filter text, reactively confirm it landed, then escape.
  if (focused) { await clearFn(); await pollSearchValue(act, () => readFn(loc), "", budgets); }
  await act.pressEscape();
  let endChips = priorChips;
  try { const st = await readFn(loc); if (st && st.chips) endChips = st.chips; } catch (e) { /* keep priorChips */ }
  if (keptLowerTier) {
    return {
      status: "filled", after: endChips.length ? endChips.join("; ") : original, verified: true,
      matchTier: "pre-filled", flag: "prefilled-better-tier-unavailable", confidence: "high",
      detail: `kept pre-fill "${original}" — matches a candidate tier, but no higher-priority tier is offered by the form`,
      captured_options: lastOptions || undefined, settle_trace: trace
    };
  }
  return {
    status: "needs_review", after: endChips.length ? endChips.join("; ") : original, verified: false,
    flag: "overwrite-nomatch-original-kept", confidence: "none",
    detail: `no candidate matched — original pre-fill "${original}" kept, filter text cleared (future-AI candidate)`,
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
  taEnterCommitCeilingMs: 5000, // commit-Enter → chip, before the click fallback takes over
  // M32 repeating-section reconcile poll (Add/Delete → entry count moves). In-tree
  // budget is 4s/150ms; the page mounts the new/removed entry on its throttled loop.
  entryReconcileCeilingMs: 4000,
  entryReconcileIntervalMs: 150,
  // M40 post-fill audit: one settle (NON-adaptive — the page's render is real wall-clock)
  // before the independent re-read pass, so a still-settling last field isn't false-flagged.
  auditSettleMs: 600
};

// ── Verbatim M22 ports (background.js fillEngine — change in lockstep) ──────

const FIELD_MAP = {
  "legalName--firstName": "personal_info.first_name",
  "legalName--lastName": "personal_info.last_name",
  "addressLine1": "personal_info.address_line_1",
  "city": "personal_info.city",
  "postalCode": "personal_info.postal_code",
  "phoneNumber": "personal_info.phone_number",
  "extension": "personal_info.phone_extension",
  "country": "personal_info.country",
  "countryRegion": "personal_info.state_province",
  "phoneType": "personal_info.phone_device_type",
  "countryPhoneCode": "personal_info.country_phone_code"
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
const fillTextCdp = async (act, loc, value, budgets, tag) => {
  const pre = await act.readTextValue(loc, tag);
  if (!pre) return { status: "error", detail: "no " + (tag || "input") + " in wrapper" };
  const before = pre.value;
  const focusMethod = await act.focusText(loc, tag);
  if (!focusMethod) return { status: "error", detail: "could not focus " + (tag || "input"), after: before };
  await act.clearText(); // local DOM op; CDP clear→type events apply in order — no fixed settle needed
  await act.typeText(value);
  // Reactive read-back: POLL until the field reads back the COMPLETE typed value (survives any
  // lag — laggy wifi, a throttled tick), NEVER a fixed sleep then a single read. `after === value`
  // is the COMPLETE-state condition (not "something appeared") — the same lesson as the dropdown
  // false-verify: a partial/momentary read must not satisfy it. Ceiling = give-up bound only.
  let after = before;
  const deadline = Date.now() + budgets.textReadCeilingMs;
  do {
    const read = await act.readTextValue(loc, tag);
    after = read ? read.value : null;
    if (after === value) break;
    await act.delay(budgets.textReadIntervalMs);
  } while (Date.now() < deadline);
  if (after !== value) return { status: "needs_review", after, verified: false, detail: `read-back mismatch (typed via ${focusMethod}, field shows "${after}")` };
  return { status: "filled", after, verified: true, detail: before ? `overwrote "${before}"` : null };
};

// Dropdown: the Playwright pattern ported, commit = type-to-highlight +
// VERIFIED Enter (recon: a coordinate click on an out-of-view option dismisses
// the popup — the Uruguay failure; Enter on a verified highlight commits).
// The highlighted text MUST equal the matched target before Enter — never an
// unverified commit. Coordinate option-click survives only as a last resort,
// behind the same trigger-text verify gate.
const fillDropdownCdp = async (act, loc, candidates, budgets) => {
  const norm = apMatch.normalize;
  const pre = await act.readDropdownState(loc);
  const before = pre ? pre.triggerText : null;

  // KEEP guard (M27 Commit C): if the trigger already shows a value that
  // EXACT-matches a candidate, keep it with ZERO actuation — skip re-opening a
  // cold 200+ option list. Symmetry with the typeahead/source pre-filled KEEP;
  // exact-only (a containment/fuzzy trigger still goes through the verified
  // re-select), and the "Select One" placeholder matches nothing so empty
  // dropdowns fall through to the normal fill.
  if (before) {
    const k = apMatch.matchCandidates(candidates, [before]);
    if (k.targetIndex !== -1 && k.matchTier === "exact-normalized") {
      return { status: "filled", after: before, verified: true, matchTier: "pre-filled", flag: "dropdown-prefilled-kept", confidence: "high", detail: "dropdown already shows a matching value — kept (no actuation)" };
    }
  }

  // Open with a bounded, aria-expanded-GATED retry (M29 "retry the actuation until
  // it takes"). A fast-paced open-click can fire DURING the prior field's post-commit
  // React re-render and no-op — the trigger never expands, so no list ever appears;
  // the old single open then burned the full option ceiling and false-failed ("options
  // did not render"). STRICT TWO-GATE sequencing, with the INVARIANT that guards the
  // inverse bug: NEVER re-click a trigger already reading aria-expanded="true" — a
  // second click TOGGLES the open dropdown SHUT. So openDropdown is called ONLY while
  // not yet expanded (the for-loop's `!expanded` guard); once expanded we only poll.
  let state = null, expanded = false;
  for (let attempt = 1; attempt <= budgets.openRetries && !expanded; attempt++) {
    if (attempt > 1) { await act.pressEscape(); await act.delay(budgets.reopenSettleMs); } // close the half-state + let the re-render finish
    if (!(await act.openDropdown(loc))) continue; // trigger rect dead — re-open
    // GATE 1 (cheap): poll aria-expanded for a SHORT window. A real open expands
    // promptly; a raced no-op never does. Don't burn the option ceiling on a race.
    const expandDeadline = Date.now() + budgets.openExpandWindowMs;
    while (Date.now() < expandDeadline) {
      await act.delay(budgets.settleIntervalMs);
      state = await act.readDropdownState(loc);
      if (state && state.ariaExpanded === "true") { expanded = true; break; }
    }
  }
  // GATE 2: the trigger IS expanded — NEVER re-click it. Poll optionCount to the FULL
  // ceiling (a cold lazy list renders after the expand). Settle = 2 equal non-zero reads.
  // delayFull (NON-adaptive): the option list renders at the PAGE's pace, which the
  // foreground speedup must NOT shorten — at fast-scaled intervals the "2 stable reads"
  // span only ~140ms and conclude on an INCOMPLETE render, so a pick lands on a partial
  // list and is discarded on render-complete (the false verified:true). Real-time stability
  // ⇒ the list is fully rendered before we match/click.
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
      await act.delayFull(budgets.settleIntervalMs);
      state = await act.readDropdownState(loc);
    }
  }
  if (!state || state.optionCount === 0) {
    await act.pressEscape();
    return { status: "needs_review", detail: "options did not render (skipped_no_option_match)", after: before };
  }

  const enabledTexts = state.options.filter((o) => !o.disabled).map((o) => o.text);
  const m = apMatch.matchCandidates(candidates, enabledTexts);
  if (m.targetIndex === -1) {
    await act.pressEscape();
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
  const commitByClick = async () => {
    if (!(await act.clickDropdownOptionByText(loc, target))) {
      const cs = await act.readDropdownState(loc);
      return { ok: false, after: cs ? cs.triggerText : null };
    }
    let after = null;
    const deadline = Date.now() + budgets.commitCeilingMs;
    while (Date.now() < deadline) {
      await act.delayFull(budgets.commitIntervalMs); // real time — the page commits the pick at its own pace
      const cs = await act.readDropdownState(loc);
      after = cs ? cs.triggerText : after;
      if (committedText(after)) {
        // PERSISTENCE (the false-verify guard): a pick made before the option list finished
        // rendering shows for an instant, then is DISCARDED on render-complete — that momentary
        // value is exactly what produced the false verified:true. Confirm the trigger STILL
        // shows the target after another real-time beat before accepting; a revert keeps polling
        // (→ honest needs_review), never a silent wrong fill.
        await act.delayFull(budgets.commitIntervalMs);
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

  let res = await commitByClick();
  if (!res.ok) {
    // One retry: re-open if the click closed the list without committing, then re-click.
    let re = await act.readDropdownState(loc);
    if (!re || re.optionCount === 0) {
      if (await act.openDropdown(loc)) {
        const d = Date.now() + Math.min(budgets.openCeilingMs, 8000);
        while (Date.now() < d) { await act.delayFull(budgets.settleIntervalMs); re = await act.readDropdownState(loc); if (re && re.optionCount > 0) break; }
      }
    }
    if (re && re.optionCount > 0) res = await commitByClick();
  }
  if (res.ok) {
    return { status: "filled", after: res.after, verified: true, matchTier: m.matchTier, detail: `text-click-commit${idxCanary}`, options: enabledTexts };
  }
  await act.pressEscape();
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
const fillTypeaheadCdp = async (act, loc, candidates, budgets) => {
  const norm = apMatch.normalize;
  const pre = await act.readTypeahead(loc);
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
      let st = await act.readTypeahead(loc);
      if (!st || !st.searchBox.present || !st.searchBox.visible) {
        if (!(await act.openTypeahead(loc))) { await act.delay(budgets.reopenSettleMs); continue; } // unmounted — re-open
        const t0 = Date.now();
        while (Date.now() - t0 < budgets.taOpenCeilingMs) {
          await act.delay(budgets.taOpenIntervalMs);
          st = await act.readTypeahead(loc);
          if (st && st.searchBox.visible) break;
        }
      }
      if (st && st.searchBox.visible && !st.searchBox.focused) {
        await act.focusSearchBox(loc); // already-visible search → focus only, never re-open
        st = await act.readTypeahead(loc);
      }
      if (st && st.searchBox.focused) return st;
      await act.delay(budgets.reopenSettleMs); // let a racing re-render settle, then retry
    }
    return null;
  };

  const trace = [];
  let lastFiltered = null;
  let s = null;
  for (const cand of overwriteCandidates) {
    const step = { candidate: cand };
    trace.push(step);
    // Focus hygiene: re-assert (recover) focus before touching the field. If it
    // can't be confirmed, STOP — never blind Ctrl+A / type / Enter (that is the
    // exact path that committed a stray "Afghanistan" via the listbox highlight).
    const focused = await ensureSearchFocused();
    if (!focused) {
      step.note = "could not focus search field — not actuating blind";
      return { status: "needs_review", after: null, verified: false, detail: "could not focus the search field — not actuating blind (no clear/type/Enter)", settle_trace: trace };
    }
    await act.clearSearch();
    await pollSearchValue(act, () => act.readTypeahead(loc), "", budgets); // reactive: the clear has LANDED in the input before snapshot
    const snap = await act.readTypeahead(loc);
    const snapSig = snap ? snap.pageWide.sig : null;
    step.staleBannerAtStart = !!(snap && snap.banner);
    await act.typeInSearch(cand);
    await pollSearchValue(act, () => act.readTypeahead(loc), cand, budgets); // reactive: the full candidate has LANDED before the filter-Enter
    await act.pressEnter(); // the filter-Enter (the ONLY filter trigger on this widget)

    let sawChange = false, stable = 0, prevSig = null, outcome = "timeout";
    const tSettle = Date.now();
    while (Date.now() - tSettle < budgets.taSettleCeilingMs) {
      await act.delay(budgets.taSettleIntervalMs);
      s = await act.readTypeahead(loc);
      const sig = s ? s.pageWide.sig : null;
      if (sig !== snapSig) sawChange = true;
      // Transition-aware: a commit is a chip set that DIFFERS from priorChips
      // (M27). Empty field (priorChips=[]) → any chip; overwrite → only a NEW chip
      // (the pre-existing one alone is not a commit). Sampled here in settlePoll.
      if (s && chipSetIsNew(s.chips)) { outcome = "chip"; break; }
      if (s && s.banner && sawChange) { outcome = "banner"; break; }
      if (sawChange && s && s.pageWide.count > 0 && !s.banner && sig !== snapSig) {
        stable = sig === prevSig ? stable + 1 : 0;
        if (stable >= budgets.stableReads - 1) { outcome = "filtered"; break; }
      }
      prevSig = sig;
    }
    step.outcome = outcome;
    step.settleMs = Date.now() - tSettle;

    if (outcome === "chip") {
      // An auto-commit fired on the filter-Enter. Classify the committed chip by
      // its match tier vs THIS candidate (M27 taxonomy via commitOutcome): exact →
      // filled; containment/fuzzy → filled_review + soft flag (kept, never silently
      // trusted as plain "filled"); no match → needs_review (the stray, e.g. a
      // "Canada" chip for a US query). Walk stops either way — a chip now exists and
      // more typing contaminates. `matchTier` stays the commit-path; `flag`/
      // `confidence` carry the taxonomy.
      step.chip = s.chips.join("; ");
      const cm = apMatch.matchCandidates([cand], s.chips);
      const oc = commitOutcome(isOverwrite, "auto", cm.matchTier);
      step.flag = oc.flag;
      if (oc.status === "needs_review") {
        // empty-field → autocommit-stray; overwrite → overwrite-stray (the accepted
        // destructive edge: a different wrong value replaced the original).
        const d = isOverwrite
          ? `overwrote pre-fill "${priorChips.join("; ")}" but the auto-commit chip "${step.chip}" matches no candidate — ${oc.flag}, walk stopped`
          : `auto-commit chip "${step.chip}" does not match candidate "${cand}" — flagged (${oc.flag}), walk stopped`;
        return withOverwrite({ status: "needs_review", after: step.chip, verified: false, matchTier: "enter-auto-commit", flag: oc.flag, confidence: oc.confidence, detail: d, settle_trace: trace }, false);
      }
      // Defensive single-chip assertion (recon = REPLACE → 1 chip). A residual
      // second chip means a tenant ADDED — never silently accept a two-value state.
      if (isOverwrite && s.chips.length > 1) {
        return withOverwrite({ status: "needs_review", after: step.chip, verified: false, matchTier: "enter-auto-commit", flag: "overwrite-residual-flagged", confidence: "none", detail: `overwrite left ${s.chips.length} chips (expected single REPLACE) — review`, settle_trace: trace }, true);
      }
      const prov = isOverwrite ? `overwrote "${priorChips.join("; ")}" → ` : "";
      return withOverwrite({ status: oc.status, after: step.chip, verified: true, matchTier: "enter-auto-commit", flag: oc.flag, confidence: oc.confidence, detail: `${prov}auto-committed on the filter-Enter (candidate "${cand}", ${oc.flag})`, settle_trace: trace }, true);
    }
    if (outcome === "banner") { step.note = "fresh no-match banner — hard block"; continue; }
    if (outcome !== "filtered") { step.note = "no fresh transition within budget"; continue; }

    const texts = s.pageWide.texts;
    lastFiltered = texts;
    step.filteredCount = s.pageWide.count;
    const m = apMatch.matchCandidates([cand], texts);
    if (m.targetIndex !== -1) step.match = { targetIndex: m.targetIndex, matchTier: m.matchTier };
    if (m.targetIndex === -1) { step.note = "candidate not in its own filtered set"; continue; }
    if (m.targetIndex !== 0) { step.note = `match at index ${m.targetIndex}, not the auto-highlighted first option — not committing`; continue; }

    const matchedOption = texts[0];
    step.matchedOption = matchedOption;

    // Commit ladder: (1) commit-Enter — works when keystroke-driven typing
    // armed the first-option highlight; (2) trusted CDP click on the matched
    // option BY TEXT — the fallback for a never-armed highlight (live
    // 2026-06-12: the Enter no-op'd and tier-1 "Other" lost to a tier-3
    // auto-commit). Both paths end at the SAME chip gate.
    const pollChips = async (ceilingMs) => {
      let cs = null;
      const t0 = Date.now();
      while (Date.now() - t0 < ceilingMs) {
        await act.delay(budgets.commitIntervalMs);
        cs = await act.readTypeahead(loc);
        // Break on a NEW chip (overwrite) OR a chip == the matched option (covers
        // the same-value overwrite where the matched target already equals the
        // original — no needless timeout). Empty field: equivalent to "any chip".
        if (cs && (chipSetIsNew(cs.chips) || cs.chips.some((c) => norm(c) === norm(matchedOption)))) break;
      }
      return cs ? cs.chips : [];
    };
    await act.pressEnter(); // the commit-Enter
    let chips = await pollChips(budgets.taEnterCommitCeilingMs);
    let commitPath = "enter-commit";
    if (!chips.length) {
      // Click fallback — only while the filtered set still shows the matched text.
      const re = await act.readTypeahead(loc);
      if (re && re.pageWide.texts.some((t) => norm(t) === norm(matchedOption))) {
        if (await act.clickTaOption(loc, matchedOption)) {
          commitPath = "click-commit";
          chips = await pollChips(budgets.commitCeilingMs);
        }
      }
    }
    step.chip = chips.join("; ") || null;
    step.commitPath = chips.length ? commitPath : null;
    if (chips.length && chips.some((c) => norm(c) === norm(matchedOption))) {
      // Directed commit verified (chip == the matched option). Grade by the
      // candidate→option tier `m.matchTier` (M27): exact → filled; containment/fuzzy
      // → filled_review + flag. Under overwrite → overwrite-success + provenance.
      // `matchTier` = the commit-path; quality → confidence.
      const oc = commitOutcome(isOverwrite, "directed", m.matchTier);
      step.flag = oc.flag;
      if (isOverwrite && chips.length > 1) {
        return withOverwrite({ status: "needs_review", after: step.chip, verified: false, matchTier: commitPath, flag: "overwrite-residual-flagged", confidence: "none", detail: `overwrite left ${chips.length} chips (expected single REPLACE) — review`, captured_options: texts, settle_trace: trace }, true);
      }
      const prov = isOverwrite ? `overwrote "${priorChips.join("; ")}" → ` : "";
      return withOverwrite({ status: oc.status, after: step.chip, verified: true, matchTier: commitPath, flag: oc.flag, confidence: oc.confidence, detail: `${prov}${commitPath} on "${matchedOption}" (${m.matchTier})`, captured_options: texts, settle_trace: trace }, true);
    }
    if (chips.length) {
      // A chip exists but isn't the matched option — overwrite → overwrite-stray
      // (a different value replaced the original); empty field → directed-mismatch.
      return withOverwrite({ status: "needs_review", after: step.chip, verified: false, matchTier: commitPath, flag: isOverwrite ? "overwrite-stray" : "directed-mismatch", confidence: "none", detail: `chip "${step.chip}" does not match "${matchedOption}" — flagged, walk stopped`, captured_options: texts, settle_trace: trace }, false);
    }
    step.note = "no chip from commit-Enter or click — commit did not take";
  }

  // Walk exhausted. Under OVERWRITE the original chip is intact (non-destructive —
  // we never deleted it): rest the field clean ({chips:[original], query:""}) and
  // flag overwrite-nomatch-original-kept (future-AI candidate).
  if (isOverwrite) {
    return await overwriteNoMatchResting(act, loc, (l) => act.readTypeahead(l), () => act.clearSearch(), ensureSearchFocused, priorChips, trace, lastFiltered, budgets, preTierIndex > 0);
  }
  // Empty-field honesty read: after closing the list, a final chip read so the
  // record NEVER reports after:null when the page physically holds a value —
  // catches a late/stray commit our settle missed (e.g. a highlight-Enter that
  // landed after we moved on). A committed chip (selectedItem) survives Escape, so
  // this reflects the true settled state; an uncommanded chip is flagged for review.
  await act.pressEscape();
  let strayChip = null;
  try { const endState = await act.readTypeahead(loc); strayChip = endState && endState.chips.length ? endState.chips.join("; ") : null; } catch (e) { /* ignore read error */ }
  if (strayChip) {
    return { status: "needs_review", after: strayChip, verified: false, detail: "uncommanded value on the field — review (no candidate matched; chip overwrite is a later milestone)", captured_options: lastFiltered || undefined, settle_trace: trace };
  }
  // M38 Bug B1 — GENUINE no-match (for deleteOnNoMatch) ONLY if EVERY candidate gave a
  // definitive negative: a "No matches" banner, or filtered-but-absent (no match object).
  // A timeout (no fresh transition — transient) or a present-but-uncommitted candidate
  // (commit-ladder limitation, the data IS valid) is NOT genuine → keep + surface, never
  // delete. (Mirrors fillDropdownCdp's genuineNoMatch — the data-loss safety, lockstep.)
  const genuineNoMatch = trace.length > 0 && trace.every((s) => s.outcome === "banner" || (s.outcome === "filtered" && !s.match));
  return { status: "needs_review", after: null, verified: false, detail: "no candidate produced a verified chip", captured_options: lastFiltered || undefined, settle_trace: trace, genuineNoMatch };
};

// Source ("How did you hear about us?") — the Magna SEARCH shape, recon 2026-06-12.
// TODO(dup): this MIRRORS fillTypeaheadCdp's walk structure (focus hygiene,
// per-candidate clear/type/Enter-filter, transition-aware settle + banner block,
// candidate-only match, commit ladder, honesty read). Kept SEPARATE to leave the
// shipped typeahead path untouched; if a third picker appears, factor the shared
// walk into a picker-adapter and collapse both. Change in lockstep with
// fillTypeaheadCdp. Source-specific deltas vs typeahead:
//   • leaves = act.readSource().leaves (page-wide promptOption, data-automation-label,
//     CHIP-EXCLUDED — a committed chip elsewhere embeds a promptOption and otherwise
//     contaminates; recon Phase A hit exactly this);
//   • commit-verify accepts EITHER the matched leaf's promptLeafNode
//     `multiselectlistitem-isselected==="true"` (act.probeSourceLeaf) OR a
//     selectedItem chip normalize-matching the candidate;
//   • categories shown on open are bypassed — typing filters straight to leaves.
const fillSourceCdp = async (act, loc, candidates, budgets) => {
  const norm = apMatch.normalize;
  const pre = await act.readSource(loc);
  if (!pre) return { status: "error", detail: "source wrapper not found" };

  // Pre-filled guard — TIER-AWARE (M36.1, lockstep with fillTypeaheadCdp). tier 0 →
  // keep, ZERO actuation; tier k>0 → walk only the higher tiers (slice(0,k), priority
  // order) and overwrite to the best the form offers, else keep (walk-end
  // prefilled-better-tier-unavailable); tier -1 → genuine mismatch → full overwrite
  // walk (recon proved source is symmetric: search-while-populated, clearSourceSearch
  // preserves the chip, commit REPLACES).
  const priorChips = pre.chips.slice();
  const preTierIndex = priorChips.length
    ? candidates.findIndex((cand) => priorChips.some((c) => norm(c) === norm(cand)))
    : -1;
  if (preTierIndex === 0) {
    return { status: "filled", after: priorChips.join("; "), verified: true, matchTier: "pre-filled", flag: "prefilled-kept", confidence: "high", detail: "pre-filled source chip is already the top candidate — kept (no actuation)" };
  }
  const overwriteCandidates = preTierIndex > 0 ? candidates.slice(0, preTierIndex) : candidates;
  const isOverwrite = priorChips.length > 0;
  const chipSetIsNew = (chips) => chips.length > 0 && chipSetChanged(priorChips, chips);
  const withOverwrite = (ret, refilled) => { if (isOverwrite) ret.overwrite = { original: priorChips.join("; "), refilled: !!refilled }; return ret; };

  if (!(await act.openSource(loc))) return { status: "error", detail: "could not open source (opener rects dead)" };
  // ensure searchBox focused (focus hygiene; a banner can drop focus — M25 leak).
  const ensureFocused = async () => {
    let s = await act.readSource(loc);
    if (!s || !s.searchBox.present || !s.searchBox.visible) {
      if (!(await act.openSource(loc))) return null;
      const t0 = Date.now();
      while (Date.now() - t0 < budgets.taOpenCeilingMs) {
        await act.delay(budgets.taOpenIntervalMs);
        s = await act.readSource(loc);
        if (s && s.searchBox.visible) break;
      }
    }
    if (s && s.searchBox.visible && !s.searchBox.focused) { await act.focusSourceSearch(loc); s = await act.readSource(loc); }
    return s && s.searchBox.focused ? s : null;
  };

  const trace = [];
  let lastLeaves = null;
  // M30: did the source options EVER render during the walk? If they never load
  // (leafCount stays 0, no chip) the server didn't return them — the dead-session
  // tell (distinct from "loaded but no candidate matched"). Surfaced on the
  // walk-end no-commit return for drivePageFill's session warning.
  let optionsEverLoaded = false;
  for (const cand of overwriteCandidates) {
    const step = { candidate: cand };
    trace.push(step);
    const focused = await ensureFocused();
    if (!focused) {
      step.note = "could not focus source search field — not actuating blind";
      return { status: "needs_review", after: null, verified: false, detail: "could not focus the source search field — not actuating blind", settle_trace: trace };
    }
    await act.clearSourceSearch();
    await pollSearchValue(act, () => act.readSource(loc), "", budgets); // reactive: the clear has LANDED before snapshot
    const snap = await act.readSource(loc);
    const snapSig = snap ? snap.sig : null;
    await act.typeInSourceSearch(cand);
    await pollSearchValue(act, () => act.readSource(loc), cand, budgets); // reactive: the full candidate has LANDED before the filter-Enter
    await act.pressEnter(); // these filter on ENTER, not live (recon)

    let sawChange = false, stable = 0, prevSig = null, outcome = "timeout";
    let s = null;
    const tSettle = Date.now();
    while (Date.now() - tSettle < budgets.taSettleCeilingMs) {
      await act.delay(budgets.taSettleIntervalMs);
      s = await act.readSource(loc);
      const sig = s ? s.sig : null;
      if (sig !== snapSig) sawChange = true;
      if (s && (s.leafCount > 0 || (s.chips && s.chips.length > 0))) optionsEverLoaded = true; // M30 liveness
      // Transition-aware (M27): a commit is a chip set DIFFERING from priorChips.
      if (s && chipSetIsNew(s.chips)) { outcome = "chip"; break; }
      if (s && s.banner && sawChange) { outcome = "banner"; break; }
      if (sawChange && s && s.leafCount > 0 && !s.banner && sig !== snapSig) {
        stable = sig === prevSig ? stable + 1 : 0;
        if (stable >= budgets.stableReads - 1) { outcome = "filtered"; break; }
      }
      prevSig = sig;
    }
    step.outcome = outcome;
    step.settleMs = Date.now() - tSettle;

    if (outcome === "chip") {
      // Auto-commit on the filter-Enter — classify by tier (M27, lockstep with
      // fillTypeaheadCdp): exact → filled; containment/fuzzy → filled_review + flag;
      // no match → needs_review (stray). Walk stops either way.
      step.chip = s.chips.join("; ");
      const cm = apMatch.matchCandidates([cand], s.chips);
      const oc = commitOutcome(isOverwrite, "auto", cm.matchTier);
      step.flag = oc.flag;
      if (oc.status === "needs_review") {
        const d = isOverwrite
          ? `overwrote source pre-fill "${priorChips.join("; ")}" but the auto-commit chip "${step.chip}" matches no candidate — ${oc.flag}, walk stopped`
          : `source auto-commit chip "${step.chip}" does not match candidate "${cand}" — flagged (${oc.flag}), walk stopped`;
        return withOverwrite({ status: "needs_review", after: step.chip, verified: false, matchTier: "enter-auto-commit", flag: oc.flag, confidence: oc.confidence, detail: d, settle_trace: trace }, false);
      }
      if (isOverwrite && s.chips.length > 1) {
        return withOverwrite({ status: "needs_review", after: step.chip, verified: false, matchTier: "enter-auto-commit", flag: "overwrite-residual-flagged", confidence: "none", detail: `source overwrite left ${s.chips.length} chips (expected single REPLACE) — review`, settle_trace: trace }, true);
      }
      const prov = isOverwrite ? `overwrote "${priorChips.join("; ")}" → ` : "";
      return withOverwrite({ status: oc.status, after: step.chip, verified: true, matchTier: "enter-auto-commit", flag: oc.flag, confidence: oc.confidence, detail: `${prov}source auto-committed on the filter-Enter (candidate "${cand}", ${oc.flag})`, settle_trace: trace }, true);
    }
    if (outcome === "banner") { step.note = "fresh no-match banner — hard block"; continue; }
    if (outcome !== "filtered") { step.note = "no fresh transition within budget"; continue; }

    const leaves = s.leaves;
    lastLeaves = leaves;
    step.leafCount = s.leafCount;
    const m = apMatch.matchCandidates([cand], leaves);
    if (m.targetIndex !== -1) step.match = { targetIndex: m.targetIndex, matchTier: m.matchTier };
    if (m.targetIndex === -1) { step.note = "candidate not in its own filtered set"; continue; }

    const matchedLeaf = leaves[m.targetIndex];
    step.matchedLeaf = matchedLeaf;
    // Commit ladder: trusted CLICK the matched leaf (recon: no highlight arms under
    // CDP typing). Verify via the promptLeafNode isselected flip OR a selectedItem chip.
    const verifyCommitted = async () => {
      const probe = await act.probeSourceLeaf(matchedLeaf);
      const leafSelected = !!(probe && probe.commitWrapper && probe.commitWrapper.isSelectedValue === "true");
      const st = await act.readSource(loc);
      const chipMatch = !!(st && st.chips.some((c) => norm(c) === norm(matchedLeaf)));
      return { leafSelected, chipMatch, chips: st ? st.chips : [] };
    };
    let committed = false, via = null, vc = null;
    if (await act.clickSourceLeaf(matchedLeaf)) {
      const d0 = Date.now();
      while (Date.now() - d0 < budgets.commitCeilingMs) {
        await act.delay(budgets.commitIntervalMs);
        vc = await verifyCommitted();
        if (vc.leafSelected || vc.chipMatch) { committed = true; via = vc.chipMatch ? "selectedItem-chip" : "promptLeafNode-isselected"; break; }
      }
    }
    step.commitVia = via;
    step.chip = vc && vc.chips.length ? vc.chips.join("; ") : null;
    if (committed) {
      // Directed leaf-click verified. Grade by candidate→leaf tier (M27); under
      // overwrite → overwrite-success + provenance. matchTier = commit path,
      // quality → confidence, provenance → flag.
      const oc = commitOutcome(isOverwrite, "directed", m.matchTier);
      step.flag = oc.flag;
      const finalChips = vc ? vc.chips : [];
      if (isOverwrite && finalChips.length > 1) {
        return withOverwrite({ status: "needs_review", after: step.chip, verified: false, matchTier: "source-click-commit", flag: "overwrite-residual-flagged", confidence: "none", detail: `source overwrite left ${finalChips.length} chips (expected single REPLACE) — review`, captured_options: leaves, settle_trace: trace }, true);
      }
      const prov = isOverwrite ? `overwrote "${priorChips.join("; ")}" → ` : "";
      return withOverwrite({ status: oc.status, after: step.chip || matchedLeaf, verified: true, matchTier: "source-click-commit", flag: oc.flag, confidence: oc.confidence, detail: `${prov}source click-commit on "${matchedLeaf}" (verified via ${via}, ${m.matchTier})`, captured_options: leaves, settle_trace: trace }, true);
    }
    step.note = "matched leaf but commit did not verify (no isselected flip / chip)";
  }

  // Walk exhausted. Under OVERWRITE the original source chip is intact: rest the
  // field clean ({chips:[original], query:""}) and flag for review (lockstep).
  if (isOverwrite) {
    return await overwriteNoMatchResting(act, loc, (l) => act.readSource(l), () => act.clearSourceSearch(), ensureFocused, priorChips, trace, lastLeaves, budgets, preTierIndex > 0);
  }
  await act.pressEscape();
  // M38 Bug B1 — GENUINE no-match (deleteOnNoMatch) ONLY if every candidate gave a
  // definitive negative (banner / filtered-but-absent); a timeout or present-but-
  // uncommitted leaf is NOT genuine → keep + surface (lockstep with typeahead/dropdown).
  const genuineNoMatch = trace.length > 0 && trace.every((s) => s.outcome === "banner" || (s.outcome === "filtered" && !s.match));
  return { status: "needs_review", after: null, verified: false, detail: "no source candidate produced a verified commit", captured_options: lastLeaves || undefined, settle_trace: trace, optionsLoaded: optionsEverLoaded, genuineNoMatch };
};

// ── The page driver (the M22 flat-loop semantics over the actuation) ────────
async function drivePageFill(act, profile, defaults, jobContext, budgetsIn) {
  const budgets = Object.assign({}, DEFAULT_BUDGETS, budgetsIn || {});
  const scan = await act.scanPage();
  const results = [];

  for (const f of scan.fields) {
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
        // Source ("How did you hear about us?") — candidates come from
        // application_defaults.how_did_you_hear (NOT the profile), mirroring the
        // in-tree fillEngine. The Magna SEARCH shape is handled by fillSourceCdp;
        // the tree/expand-walk shape (no searchBox) is still deferred.
        const hdyh = defaults && defaults.how_did_you_hear;
        if (!hdyh || !Array.isArray(hdyh.preferred)) {
          record.status = "needs_review";
          record.detail = "no how_did_you_hear defaults loaded";
        } else {
          const candidates = [...hdyh.preferred];
          if (hdyh.fallback) candidates.push(hdyh.fallback);
          record.resolved = candidates;
          Object.assign(record, await fillSourceCdp(act, loc, candidates, budgets));
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
        // Reconcile-to-boolean. NOTE: no flat checkbox is mapped in FIELD_MAP
        // today (preferredCheck deliberately unmapped) — the mechanism is
        // exercised by tests; a future mapping just works.
        if (!mappedPath) {
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
          else if (f.widgetType === "dropdown") Object.assign(record, await fillDropdownCdp(act, loc, arg, budgets));
          else if (f.widgetType === "radio") Object.assign(record, await fillRadioCdp(act, loc, arg, budgets));
          else if (f.widgetType === "typeahead") Object.assign(record, await fillTypeaheadCdp(act, loc, arg, budgets));
          else { record.status = "skipped"; record.detail = `no handler for type ${f.widgetType}`; }
        }
      }
    } catch (e) {
      record.status = "error";
      record.detail = String(e);
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
  try { rscan = await act.repeatingScan(); } catch (e) { /* no repeating substrate (flat-only fake) → skip */ }
  if (rscan && (rscan.sections || rscan.addButtons)) {
    for (const sec of PAGE_SECTIONS) {
      const hasContainer = !!(rscan.sections && rscan.sections[sec.containerPrefix]);
      const re = new RegExp(sec.headingRegex, "i");
      const hasAdd = Array.isArray(rscan.addButtons) && rscan.addButtons.some((b) => re.test((b && b.nearestHeading) || ""));
      if (!hasContainer && !hasAdd) continue; // section not on this page
      const items = Array.isArray(profile[sec.itemsKey]) ? profile[sec.itemsKey] : [];
      const out = await driveRepeatingSectionCdp(act, {
        name: sec.name, headingRegex: sec.headingRegex, containerPrefix: sec.containerPrefix,
        items, fieldMap: sec.fieldMap, deleteOnNoMatch: sec.deleteOnNoMatch
      }, budgets);
      if (out && Array.isArray(out.results)) results.push(...out.results);
    }
  }

  // M40 post-fill page AUDIT (inline backstop): after the WHOLE page has settled, re-read
  // every field that claims a value + reconcile vs what it recorded. Catches a value clobbered
  // AFTER its own fill (cross-field / delayed reset) that per-field verify can't see. A mismatch
  // → needs_review/audit-mismatch (after = the live truth); unre-readable → audit-unverifiable.
  // `auditEntries` (expected = the value just filled, BEFORE any mutation) is returned for the SW
  // to persist (the standalone re-audit). Flag-only — never auto-refills.
  const auditEntries = auditEntriesFromResults(results);
  const auditVerdicts = await reconcileAudit(act, auditEntries, budgets);
  applyAuditVerdicts(results, auditVerdicts);

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
  return { url: scan.url, repeatingFieldCount: scan.repeatingFieldCount || 0, results, counts, needsReview, sessionWarning, audit: auditEntries };
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
  { field: "fieldOfStudy", widget: "typeahead", key: "field_of_study", path: "field_of_study" },
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
    skipDetail: "currently_work_here = true → no end date (To box removed)", waitForPresence: true },
  { field: "roleDescription", widget: "textarea", key: "bulletsText", path: "role_description" }
];

// M38 — section registry for the FOLD. `drivePageFill` drives each PRESENT repeating
// section after the flat fields → ONE call = a full page fill. One entry per page-2
// section; values mirror the five per-section runners (Languages/Certs
// deleteOnNoMatch:true, the rest false). `itemsKey` reads the PREPARED profile array
// (work_experience/education/languages/certifications/websites). Registry order = fill
// order; sections are independent + entry-scoped (any cross-section effect is caught by
// the oracle comparison, not relied upon).
const PAGE_SECTIONS = [
  { name: "workExperience", headingRegex: "work experience", containerPrefix: "workExperience-", itemsKey: "work_experience", fieldMap: WORK_EXPERIENCE_MAP, deleteOnNoMatch: false },
  { name: "education", headingRegex: "education", containerPrefix: "education-", itemsKey: "education", fieldMap: EDUCATION_MAP, deleteOnNoMatch: false },
  { name: "certification", headingRegex: "certifications?", containerPrefix: "certification-", itemsKey: "certifications", fieldMap: CERTIFICATION_MAP, deleteOnNoMatch: true },
  { name: "language", headingRegex: "languages?", containerPrefix: "language-", itemsKey: "languages", fieldMap: LANGUAGE_MAP, deleteOnNoMatch: true },
  { name: "website", headingRegex: "websites?|web ?address", containerPrefix: "webAddress-", itemsKey: "websites", fieldMap: WEBSITE_MAP, deleteOnNoMatch: false }
];

// Fill one entry's mapped fields. Re-reads act.repeatingScan() FRESH per field — a
// commit can re-render the entry subtree and orphan a held descriptor (the recon's
// core warning). Resolves the field by automation-id (`f.field`) OR by label
// (`f.labelRegex`, for hashed ids — Languages). Records use the SAME shape as
// drivePageFill so the report/table code is shared.
async function fillEntryCdp(act, prefix, idx, item, fieldMap, sectionName, budgets) {
  const recs = [];
  const base = sectionName + "[" + idx + "].";
  for (const f of fieldMap) {
    const recName = f.name || f.field;
    // M37 skipWhen: a conditional field (WE endDate when currentlyWorkHere is checked →
    // Workday removes the "To" box) — record skipped, ZERO actuation, no wrapper lookup.
    if (f.skipWhen && f.skipWhen(item)) {
      recs.push({
        fieldName: base + recName, label: null, widgetType: f.widget === "year" ? "date" : f.widget,
        isRequired: false, mappedPath: base + f.path, rawValue: item[f.key] === undefined ? null : item[f.key],
        resolved: null, status: "skipped", matchTier: null, confidence: null, flag: null, verified: null, after: null,
        detail: f.skipDetail || "skipped (skipWhen)"
      });
      await act.delay(budgets.interFieldMs); continue;
    }
    const findFd = (entry) => entry ? (f.labelRegex
      ? entry.fields.find((x) => f.labelRegex.test(x.label || ""))
      : entry.fields.find((x) => x.fieldName === f.field)) : null;
    const scanFd = async () => {
      const scan = await act.repeatingScan();
      const sec = scan && scan.sections ? scan.sections[prefix] : null;
      return findFd(sec && sec.entries ? sec.entries[idx] : null);
    };
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
          else if (f.widget === "typeahead") Object.assign(rec, await fillTypeaheadCdp(act, loc, arg, budgets));
          else if (f.widget === "radio") Object.assign(rec, await fillRadioCdp(act, loc, arg, budgets));
          else { rec.status = "skipped"; rec.detail = "no handler for widget " + f.widget; }
        }
      }
    } catch (e) {
      rec.status = "error"; rec.detail = String(e);
    }
    recs.push(rec);
    await act.delay(budgets.interFieldMs);
  }
  return recs;
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
    const repeatingFieldCount = results.filter((r) => r.widgetType !== "section").length;
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
  if (count > N) {
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
    results.push(sectionRec("", name, "skipped", "no meaningful " + name + " entries to fill"));
    return finalize(url);
  }

  // Fill each entry; track whether all its REQUIRED fields filled (delete-on-no-match).
  const fillCount = Math.min(N, await act.entryCount(containerPrefix));
  const perEntry = [];
  for (let i = 0; i < fillCount; i++) {
    const entryRecs = await fillEntryCdp(act, containerPrefix, i, items[i], fieldMap, name, budgets);
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
    const deletable = failedRequired.length > 0 && failedRequired.every((r) => r.genuineNoMatch === true);
    perEntry.push({ idx: i, recs: entryRecs, ok, deletable });
  }

  // delete-on-no-match (optional pick-sections: Languages/Certs) — an entry whose REQUIRED
  // pick GENUINELY didn't match (the value isn't offered) would block Next, so delete it.
  // Sweep high→low so lower indices stay valid. OFF for Websites (text always fills if present).
  // A transient/infra pick failure is NOT deletable (kept + surfaced — Bug B1).
  if (deleteOnNoMatch) {
    for (let k = perEntry.length - 1; k >= 0; k--) {
      if (!perEntry[k].deletable) continue; // ok entries AND transient-fail entries are KEPT
      const before = await act.entryCount(containerPrefix);
      const clicked = await act.clickDeleteEntry(containerPrefix, perEntry[k].idx);
      if (!clicked || !clicked.ok) continue; // can't delete — leave it (surfaces in review)
      const after = await pollCount(before, false);
      if (after < before) {
        perEntry[k].recs = [sectionRec("[" + perEntry[k].idx + "].removed", name + " entry removed",
          "skipped", "a required pick didn't match an option → entry deleted (optional section)")];
      }
      await act.delay(budgets.interFieldMs);
    }
  }

  for (const e of perEntry) results.push(...e.recs);
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

  const after = {};
  const trace = {};
  let allVerified = true;
  for (const [seg, val] of segs) {
    const focusRung = await act.focusDateSegment(loc, seg);
    if (!focusRung) { trace[seg] = "focus-failed"; after[seg] = null; allVerified = false; continue; }
    const attempt = async (how) => {
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
    let res = await attempt("typeChars");
    if (!res.ok) { // insertText fallback — re-focus first (typing may have shifted focus/auto-advanced)
      await act.focusDateSegment(loc, seg);
      inputMethod = "insertText";
      res = await attempt("insertText");
    }
    after[seg] = res.read;
    trace[seg] = focusRung + "/" + (res.ok ? inputMethod : inputMethod + "-FAILED");
    if (!res.ok) allVerified = false;
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

// Re-read ONE field's live value by widget type (reusing the existing act reads, all keyed
// by wrapperSel — a SELECTOR STRING, re-resolved fresh from document, never a held node).
// Returns { actual, readable }: readable=false ⇒ the loc no longer resolves / read failed
// (→ audit-unverifiable, NEVER a silent pass).
async function auditReReadActual(act, e) {
  const loc = { wrapperSel: e.auditLoc };
  try {
    switch (e.widgetType) {
      case "text": case "textarea": { const r = await act.readTextValue(loc, e.auditTag); return { actual: r ? r.value : null, readable: !!r }; }
      case "dropdown": { const r = await act.readDropdownState(loc); return { actual: r ? r.triggerText : null, readable: !!r }; }
      case "checkbox": { const r = await act.readCheckboxState(loc); return { actual: r ? String(r.checked) : null, readable: !!(r && r.inputId != null) }; }
      case "radio": { const r = await act.readRadioState(loc); const ok = Array.isArray(r) && r.length > 0; const c = ok && r.find((o) => o.checked); return { actual: c ? c.labelText : null, readable: ok }; }
      case "typeahead": { const r = await act.readTypeahead(loc); return { actual: r && r.chips ? r.chips.join("; ") : null, readable: !!r }; }
      case "hierarchical": { const r = await act.readSource(loc); return { actual: r && r.chips ? r.chips.join("; ") : null, readable: !!r }; }
      case "date": {
        const segs = auditDateSegments(e.expected);
        const parts = [];
        for (const [seg] of segs) { const r = await act.readDateSegment(loc, seg); if (!r || r.value == null) return { actual: null, readable: false }; parts.push(r.value); }
        return { actual: parts.join("/"), readable: true };
      }
      default: return { actual: null, readable: false }; // unauditable type → unverifiable, never a pass
    }
  } catch (err) { return { actual: null, readable: false }; }
}

// reconcileAudit: re-read each entry's live value + classify match / mismatch / unverifiable.
// One settle first (delayFull — the page's render takes real wall-clock; the foreground
// speedup must not shorten it). Pure verdict list; the caller (inline or SW) acts on it.
async function reconcileAudit(act, entries, budgets) {
  const b = Object.assign({}, DEFAULT_BUDGETS, budgets || {});
  const norm = apMatch.normalize;
  await act.delayFull(b.auditSettleMs);
  const verdicts = [];
  for (const e of entries) {
    const { actual, readable } = await auditReReadActual(act, e);
    let verdict;
    if (!readable || actual === null) verdict = "unverifiable";
    else if (e.widgetType === "text" || e.widgetType === "textarea" || e.widgetType === "checkbox") verdict = actual === e.expected ? "match" : "mismatch";
    else if (e.widgetType === "date") verdict = auditDateMatches(actual, e.expected) ? "match" : "mismatch";
    else verdict = norm(actual) === norm(e.expected) ? "match" : "mismatch"; // dropdown / radio / typeahead / source
    verdicts.push({ key: e.key, widgetType: e.widgetType, expected: e.expected, actual, verdict });
  }
  return verdicts;
}

// Build the audit entry list from drivePageFill results (the fields claiming a value) +
// apply the verdicts back to the results in place (a mismatch downgrades to needs_review).
function auditEntriesFromResults(results) {
  return (results || [])
    .filter((r) => (r.status === "filled" || r.status === "filled_review") && r.auditLoc)
    .map((r) => ({ key: r.fieldName, widgetType: r.widgetType, auditLoc: r.auditLoc, auditTag: r.auditTag || null, expected: r.after }));
}
function applyAuditVerdicts(results, verdicts) {
  for (const v of verdicts) {
    if (v.verdict === "match") continue;
    const rec = (results || []).find((r) => r.fieldName === v.key);
    if (!rec) continue;
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
const REVIEW_SCHEMA_VERSION = "1.0";

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
function buildReviewBundle(results, meta) {
  const m = meta || {};
  const mapFillStatus = (status) => {
    if (status === "filled" || status === "filled_review") return "filled";
    if (status === "skipped") return "skipped";
    if (status === "error") return "error";
    return "not_filled"; // needs_review / null
  };
  const deriveConfidence = (rec) => {
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
    const required = !!rec.isRequired;
    const flaggedBase = rec.status === "needs_review" || rec.status === "filled_review" || rec.status === "error";
    const escalated = rec.status === "skipped" && required;
    if (!flaggedBase && !escalated) return { needs_review: false, needs_review_reason: null };
    const detail = (rec.detail || "").toLowerCase();
    let reason;
    if (rec.fieldName === "candidateIsPreviousWorker") reason = "employer_match_uncertain";
    else if (rec.status === "error") reason = "fill_error";
    else if (rec.status === "skipped" && required && !rec.mappedPath) reason = "unmapped_required_field";
    else if (rec.status === "skipped" && required) reason = "required_field_empty";
    else if (detail.includes("no options appeared")) reason = "typeahead_empty_listbox";
    else if (detail.includes("unsupported widget") || detail.includes("no handler")) reason = "unsupported_widget";
    else if (detail.includes("defaults")) reason = "config_missing";
    else reason = "low_confidence";
    return { needs_review: true, needs_review_reason: reason };
  };
  const fieldRecs = (results || []).filter((r) => r.widgetType !== "section"); // .add/.delete/.removed are ops
  const entries = fieldRecs.map((rec, index) => {
    const fill_status = mapFillStatus(rec.status);
    const { confidence, confidence_source } = deriveConfidence(rec);
    const { needs_review, needs_review_reason } = deriveReview(rec);
    const current_value = fill_status === "filled" && rec.after != null ? rec.after : null;
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
      confidence,
      confidence_source,
      needs_review,
      needs_review_reason,
      fill_status,
      fill_error: rec.status === "error" ? (rec.detail || null) : null,
      detail: rec.detail != null ? rec.detail : null,
      match_tier: rec.matchTier != null ? rec.matchTier : null,
      options: Array.isArray(rec.options) ? rec.options : null,
      captured_options: Array.isArray(rec.captured_options) ? rec.captured_options : null,
      character_count: null
    };
  });
  return Object.assign({
    schema_version: REVIEW_SCHEMA_VERSION,
    page: m.page != null ? m.page : null,
    url: m.url != null ? m.url : null,
    tenant: m.tenant != null ? m.tenant : null,
    captured_at: m.capturedAt != null ? m.capturedAt : null
  }, summarizeEntries(entries), { entries });
}

// Accumulate a page bundle into the prior entries — WRITE-PER-PAGE (the M15 decision).
// Drop the prior entries for THIS page (by `entry.page`), KEEP all OTHER pages' entries
// VERBATIM (a viewer EDIT on a prior page survives the next page's persist — NOT a
// rebuild), append this page's, recompute the envelope. PURE — the SW does the I/O.
function accumulateBundle(priorEntries, pageBundle) {
  const pageKey = pageBundle.page;
  const kept = (priorEntries || []).filter((e) => e.page !== pageKey); // other pages, verbatim (edits intact)
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
  module.exports = { drivePageFill, driveRepeatingSectionCdp, PAGE_SECTIONS, WEBSITE_MAP, LANGUAGE_MAP, EDUCATION_MAP, CERTIFICATION_MAP, WORK_EXPERIENCE_MAP, fillDateCompositeCdp, buildReviewBundle, accumulateBundle, DEFAULT_BUDGETS, FIELD_MAP, resolve, decidePreviousWorker, fillTypeaheadCdp, fillSourceCdp, commitOutcome, flagTierCategory, reconcileAudit, auditDateSegments, auditEntriesFromResults, applyAuditVerdicts };
}
