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

// Wait budgets — recon-informed (2026-06-12, Magna wd3 hidden): dropdown cold
// open ~5.6s → 20s ceiling; commits 300-620ms → 10s ceilings; text read-back
// ≤700ms → 500ms read delay. GENEROUS by design: the page's reaction runs on a
// ~1s-throttled loop; a foreground-tuned timeout false-negatives to needs_review.
// Tests override with tiny values.
const DEFAULT_BUDGETS = {
  openCeilingMs: 20000,   // dropdown click → options rendered (cold lazy lists)
  settleIntervalMs: 350,  // option-list poll interval
  stableReads: 2,         // consecutive equal non-zero reads (atomic render confirmed)
  commitCeilingMs: 10000, // click/Enter → observable state change
  commitIntervalMs: 300,
  textReadDelayMs: 500,   // insertText → read-back
  typeJumpDelayMs: 700,   // type-to-jump chars → highlight settles
  arrowStepMs: 110,       // per arrow step (verified walk)
  maxArrowSteps: 60,      // walk bound — type-jump should land near; farther = something's off → needs_review
  interFieldMs: 300,
  // Typeahead (M25 recon, Magna wd3 hidden: filter settles ~810–860ms; the
  // ceiling tolerates colder tenants without false-negativing to needs_review).
  taOpenCeilingMs: 5000,   // opener click → searchBox visible+focused (~260ms observed)
  taOpenIntervalMs: 250,
  taActionSettleMs: 400,   // after clear / after typing, before Enter
  taSettleCeilingMs: 25000, // filter-Enter → fresh transition (banner/chip/filtered)
  taSettleIntervalMs: 400,
  taEnterCommitCeilingMs: 5000 // commit-Enter → chip, before the click fallback takes over
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
const fillTextCdp = async (act, loc, value, budgets) => {
  const pre = await act.readTextValue(loc);
  if (!pre) return { status: "error", detail: "no input in wrapper" };
  const before = pre.value;
  const focusMethod = await act.focusText(loc);
  if (!focusMethod) return { status: "error", detail: "could not focus input", after: before };
  await act.clearText();
  await act.delay(budgets.textReadDelayMs);
  await act.typeText(value);
  await act.delay(budgets.textReadDelayMs);
  const read = await act.readTextValue(loc);
  const after = read ? read.value : null;
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

  if (!(await act.openDropdown(loc))) return { status: "error", detail: "could not open dropdown (trigger rect dead)", after: before };

  // Settle: 2 consecutive equal non-zero reads (recon: the list renders
  // ATOMICALLY — 249 options on first read, stable through a 3s tail).
  let state = null, prevCount = -1, stable = 0;
  const openDeadline = Date.now() + budgets.openCeilingMs;
  while (Date.now() < openDeadline) {
    await act.delay(budgets.settleIntervalMs);
    state = await act.readDropdownState(loc);
    const n = state ? state.optionCount : 0;
    if (n > 0 && n === prevCount) {
      stable++;
      if (stable >= budgets.stableReads - 1) break;
    } else {
      stable = 0;
    }
    prevCount = n;
  }
  if (!state || state.optionCount === 0) {
    await act.pressEscape();
    return { status: "needs_review", detail: "options did not render (skipped_no_option_match)", after: before };
  }

  const enabledTexts = state.options.filter((o) => !o.disabled).map((o) => o.text);
  const m = apMatch.matchCandidates(candidates, enabledTexts);
  if (m.targetIndex === -1) {
    await act.pressEscape();
    return { status: "needs_review", detail: "no candidate matched", after: before, options: enabledTexts };
  }
  const target = enabledTexts[m.targetIndex];
  const onTarget = (s) => !!(s && s.activeText && norm(s.activeText) === norm(target));

  // Type-to-highlight: leading chars move aria-activedescendant (native listbox
  // type-jump, recon-confirmed); throttling can split keystrokes → verify, and
  // arrow-walk the remainder from the LIVE highlight if the jump landed wrong.
  await act.typeJumpChars(target.slice(0, Math.min(3, target.length)));
  await act.delay(budgets.typeJumpDelayMs);
  let s2 = await act.readDropdownState(loc);
  if (!onTarget(s2)) {
    const idxOf = (txt) => (txt == null ? -1 : enabledTexts.findIndex((t) => norm(t) === norm(txt)));
    let steps = 0;
    let dir = 1;
    while (!onTarget(s2) && steps < budgets.maxArrowSteps) {
      const cur = idxOf(s2 && s2.activeText);
      if (cur !== -1) dir = cur < m.targetIndex ? 1 : cur > m.targetIndex ? -1 : dir;
      await act.arrowStep(dir);
      await act.delay(budgets.arrowStepMs);
      s2 = await act.readDropdownState(loc);
      steps++;
    }
  }
  if (!onTarget(s2)) {
    await act.pressEscape();
    return { status: "needs_review", detail: `could not verify highlight on "${target}" — not committing`, after: before, options: enabledTexts, matchTier: m.matchTier };
  }

  // Verified highlight → Enter, then the post-commit gate: trigger text must
  // show the target. Mismatch is NEVER silently accepted.
  await act.pressEnter();
  const committedText = (t) => t != null && (norm(t) === norm(target) || norm(t).includes(norm(target)));
  let after = null;
  const commitDeadline = Date.now() + budgets.commitCeilingMs;
  while (Date.now() < commitDeadline) {
    await act.delay(budgets.commitIntervalMs);
    const cs = await act.readDropdownState(loc);
    after = cs ? cs.triggerText : after;
    if (committedText(after)) {
      return { status: "filled", after, verified: true, matchTier: m.matchTier, detail: "enter-commit", options: enabledTexts };
    }
  }

  // LAST RESORT (kept for tenants where Enter-commit might not take): reopen if
  // the Enter closed the list, scrollIntoView + coordinate-click the matched
  // option, SAME verify gate. Recon proved Enter works on Magna; this is
  // belt-and-suspenders, never an unverified accept.
  let fb = await act.readDropdownState(loc);
  if (!fb || fb.optionCount === 0) {
    if (await act.openDropdown(loc)) {
      const fbDeadline = Date.now() + Math.min(budgets.openCeilingMs, 8000);
      while (Date.now() < fbDeadline) {
        await act.delay(budgets.settleIntervalMs);
        fb = await act.readDropdownState(loc);
        if (fb && fb.optionCount > 0) break;
      }
    }
  }
  if (fb && fb.options && fb.optionCount > 0) {
    const fullIdx = fb.options.findIndex((o) => !o.disabled && norm(o.text) === norm(target));
    if (fullIdx !== -1 && (await act.clickOptionByIndex(loc, fullIdx))) {
      const d2 = Date.now() + budgets.commitCeilingMs;
      while (Date.now() < d2) {
        await act.delay(budgets.commitIntervalMs);
        const cs = await act.readDropdownState(loc);
        after = cs ? cs.triggerText : after;
        if (committedText(after)) {
          return { status: "filled", after, verified: true, matchTier: m.matchTier, detail: "click-fallback (enter-commit failed)", options: enabledTexts };
        }
      }
    }
    await act.pressEscape();
  }
  return { status: "needs_review", detail: `commit failed for "${target}" (trigger shows "${after}")`, after, options: enabledTexts, matchTier: m.matchTier };
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

  // Pre-filled guard FIRST (countryPhoneCode: Workday auto-derives it from
  // Country, so an already-correct chip is the COMMON case). Keep it with ZERO
  // actuation — re-typing a correct value is the duplicate/clear failure mode.
  // A same-value race with Workday's own auto-derivation is benign (we'd type
  // the identical value); a mismatched chip is flagged, never overwritten
  // (chip deletion is a later milestone).
  if (pre.chips.length) {
    const kept = pre.chips.find((c) => candidates.some((cand) => norm(c) === norm(cand)));
    if (kept) return { status: "filled", after: kept, verified: true, matchTier: "pre-filled", detail: "pre-filled chip matches a candidate — kept (no actuation)" };
    return { status: "needs_review", after: pre.chips.join("; "), verified: false, detail: "pre-filled with a value matching no candidate — left as-is (chip overwrite is a later milestone)" };
  }

  // Ensure the searchBox is present + focused. The widget loses searchBox focus
  // after a "No matches found" banner (recon 2026-06-12: a candidate after a
  // banner found focus on the PAGE — a Ctrl+A selected the whole document, the
  // typed query never landed, and the bare Enter committed the listbox's
  // highlighted row). So focus is re-asserted BEFORE every candidate, not just
  // at open. Returns the focused state, or null if focus can't be confirmed —
  // in which case the caller MUST NOT actuate (no blind clear/type/Enter).
  const ensureSearchFocused = async () => {
    let st = await act.readTypeahead(loc);
    if (!st || !st.searchBox.present || !st.searchBox.visible) {
      if (!(await act.openTypeahead(loc))) return null; // re-open if it unmounted
      const t0 = Date.now();
      while (Date.now() - t0 < budgets.taOpenCeilingMs) {
        await act.delay(budgets.taOpenIntervalMs);
        st = await act.readTypeahead(loc);
        if (st && st.searchBox.visible) break;
      }
    }
    if (st && st.searchBox.visible && !st.searchBox.focused) {
      await act.focusSearchBox(loc);
      st = await act.readTypeahead(loc);
    }
    return st && st.searchBox.focused ? st : null;
  };

  const trace = [];
  let lastFiltered = null;
  let s = null;
  for (const cand of candidates) {
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
    await act.delay(budgets.taActionSettleMs);
    const snap = await act.readTypeahead(loc);
    const snapSig = snap ? snap.pageWide.sig : null;
    step.staleBannerAtStart = !!(snap && snap.banner);
    await act.typeInSearch(cand);
    await act.delay(budgets.taActionSettleMs);
    await act.pressEnter(); // the filter-Enter (the ONLY filter trigger on this widget)

    let sawChange = false, stable = 0, prevSig = null, outcome = "timeout";
    const tSettle = Date.now();
    while (Date.now() - tSettle < budgets.taSettleCeilingMs) {
      await act.delay(budgets.taSettleIntervalMs);
      s = await act.readTypeahead(loc);
      const sig = s ? s.pageWide.sig : null;
      if (sig !== snapSig) sawChange = true;
      if (s && s.chips.length > 0) { outcome = "chip"; break; }
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
      // Single exact match auto-commits on the filter-Enter (recon-proven).
      step.chip = s.chips.join("; ");
      if (s.chips.some((c) => norm(c) === norm(cand))) {
        return { status: "filled", after: step.chip, verified: true, matchTier: "enter-auto-commit", detail: `auto-committed on the filter-Enter (candidate "${cand}")`, settle_trace: trace };
      }
      // A chip exists but is NOT this candidate — stop; more typing contaminates.
      return { status: "needs_review", after: step.chip, verified: false, detail: `auto-commit chip "${step.chip}" does not match candidate "${cand}" — flagged, walk stopped`, settle_trace: trace };
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
        if (cs && cs.chips.length > 0) break;
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
      return { status: "filled", after: step.chip, verified: true, matchTier: m.matchTier, detail: `${commitPath} on "${matchedOption}"`, captured_options: texts, settle_trace: trace };
    }
    if (chips.length) {
      return { status: "needs_review", after: step.chip, verified: false, detail: `chip "${step.chip}" does not match "${matchedOption}" — flagged, walk stopped`, captured_options: texts, settle_trace: trace };
    }
    step.note = "no chip from commit-Enter or click — commit did not take";
  }

  // Honesty: after closing the open list, a final chip read so the record NEVER
  // reports after:null when the page physically holds a value — catches a
  // late/stray commit our settle missed (e.g. a highlight-Enter that landed
  // after we moved on). Read AFTER Escape: a committed chip (selectedItem)
  // survives Escape, so this reflects the true settled state. An uncommanded
  // chip is flagged for review; clearing it is a later milestone.
  await act.pressEscape();
  let strayChip = null;
  try { const endState = await act.readTypeahead(loc); strayChip = endState && endState.chips.length ? endState.chips.join("; ") : null; } catch (e) { /* ignore read error */ }
  if (strayChip) {
    return { status: "needs_review", after: strayChip, verified: false, detail: "uncommanded value on the field — review (no candidate matched; chip overwrite is a later milestone)", captured_options: lastFiltered || undefined, settle_trace: trace };
  }
  return { status: "needs_review", after: null, verified: false, detail: "no candidate produced a verified chip", captured_options: lastFiltered || undefined, settle_trace: trace };
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
      matchTier: null,
      verified: null,
      after: null,
      detail: null
    };

    try {
      if (f.widgetType === "hierarchical") {
        // Deferred: the source picker is a different code path (tree/expand-walk
        // variants) — its own recon + milestone.
        record.status = "needs_review";
        record.detail = "source deferred (CDP milestone scope) — fill on the form";
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
    results.push(record);

    // Let one field's transient UI settle before the next opens (also the
    // natural blur of the prior field — the sequential-cleanup rule).
    await act.delay(budgets.interFieldMs);
  }

  const counts = results.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
  const needsReview = results.filter((r) => r.status === "needs_review" || r.status === "filled_review");
  return { url: scan.url, repeatingFieldCount: scan.repeatingFieldCount || 0, results, counts, needsReview };
}

// UMD-lite: export for the Node test runner; in the SW `module` is undefined so
// drivePageFill stays a global (from importScripts).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { drivePageFill, DEFAULT_BUDGETS, FIELD_MAP, resolve, decidePreviousWorker, fillTypeaheadCdp };
}
