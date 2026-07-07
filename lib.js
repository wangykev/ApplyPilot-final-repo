// Pure, dependency-free helpers shared across contexts (same tri-context pattern as
// db.js): service worker via importScripts, Node tests via require (UMD-lite bottom
// guard). Deliberately free of chrome.* / DOM so it stays unit-testable without a page.
// The injected engine can't import this (it's stringified), so anything the engine
// needs is computed in the SW from these helpers and passed in as plain values.

// Parse a profile "YYYY-MM" date into zero-padded { year, month } segments for the
// Workday date spinbuttons — or null if it isn't a real year-month. Rejecting the
// literal "YYYY-MM" placeholder is what stops us typing it into the form. Accepts an
// un-padded month ("2023-5" → "05") and rejects out-of-range months ("2023-13").
function parseYearMonth(iso) {
  const m = /^(\d{4})-(\d{1,2})$/.exec(String(iso == null ? "" : iso).trim());
  if (!m) return null;                       // no match — includes the "YYYY-MM" placeholder
  const month = parseInt(m[2], 10);
  if (month < 1 || month > 12) return null;  // out of range
  return { year: m[1], month: String(month).padStart(2, "0") };
}

// Parse a profile "YYYY-MM-DD" date into zero-padded { year, month, day } segments for a
// full Month/Day/Year Workday date composite (Certifications' Issued/Expiration dates) — or
// null if it isn't a real date. Rejects the "YYYY-MM-DD" placeholder AND any partial date
// ("YYYY-MM"): a half-filled optional date can block Next, so we fill only complete dates.
// Accepts un-padded segments ("2024-6-5"); rejects out-of-range month (>12) / day (>31).
function parseYearMonthDay(iso) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(iso == null ? "" : iso).trim());
  if (!m) return null;                                  // no match — includes "YYYY-MM-DD" and partial "YYYY-MM"
  const month = parseInt(m[2], 10), day = parseInt(m[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year: m[1], month: String(month).padStart(2, "0"), day: String(day).padStart(2, "0") };
}

// Select the entries in a repeating-section array worth filling: those with real data
// in ANY of `keys`. Pure → unit-tested; the SW uses it to decide how many form entries
// to add/fill (the injected engine can't import this). Order preserved so the i-th kept
// entry maps to the i-th form entry.
function meaningfulEntries(arr, keys) {
  // A value counts as present if it's a non-empty string OR a non-empty array (some
  // choice fields, e.g. degree/field_of_study, are profile-side TIERED candidate lists).
  const nonEmpty = (v) => (typeof v === "string" && v.trim() !== "") || (Array.isArray(v) && v.length > 0);
  const ks = Array.isArray(keys) ? keys : [keys];
  return Array.isArray(arr) ? arr.filter((e) => e && ks.some((k) => nonEmpty(e[k]))) : [];
}

// Parse a Workday repeating-section ENTRY container's data-fkit-id into its section base +
// entry index — the GENERIC replacement for the hardcoded prefix catalog. Shape is
// "<base>-<N>--null" (N = Workday's internal, non-sequential index). Returns { base, index }
// or null. The "-<digits>--null" anchor is load-bearing in BOTH exclusion directions:
//   (a) it drops the date sub-wrappers that share the prefix ("workExperience-3--startDate"/
//       "--endDate" → no "--null" → null), and
//   (b) it drops the lone "<name>--null" containers that are NOT repeating entries (e.g. the
//       page-1 "phoneNumber--null" → no "-<digits>-" index segment → null).
// LOCKSTEP: cdp.js's cdpGenericRepeatingScan inlines this EXACT regex (it's stringified for
// cdpEval and can't require this module). Change both together.
function parseRepeatingFkit(fkitId) {
  const m = /^(.+?)-(\d+)--null$/.exec(String(fkitId == null ? "" : fkitId).trim());
  if (!m) return null;
  return { base: m[1], index: parseInt(m[2], 10) };
}

// Parse a data-fkit-id into its full NESTED repeating PATH — a "--"-joined sequence of "<base>-<idx>"
// levels + a trailing field ("null" = the deepest level's entry container). Generic for ANY depth: it's
// the basis for detecting repeating-sections-inside-repeating-entries (cert → specialties →
// "certification-54--specialties-5--specialtyParent" = [{certification,54},{specialties,5}], field
// "specialtyParent"). Returns { levels:[{base,index}], field } or null (not a repeating fkit — e.g. a
// lone "phoneNumber--null", whose first segment isn't "<base>-<idx>"). levels.length === depth; depth ≥ 2
// = NESTED. LOCKSTEP: cdp.js cdpGenericNestedScan inlines this same split-on-"--" + /^(.+)-(\d+)$/ parse.
function parseNestedFkit(fkitId) {
  const parts = String(fkitId == null ? "" : fkitId).trim().split("--");
  if (parts.length < 2) return null;
  const field = parts[parts.length - 1];
  const levels = [];
  for (let i = 0; i < parts.length - 1; i++) {
    const m = /^(.+)-(\d+)$/.exec(parts[i]);
    if (!m) return null;
    levels.push({ base: m[1], index: parseInt(m[2], 10) });
  }
  return { levels, field };
}

// Convenience wrapper for work_experience (entries with a job title or company).
function meaningfulWorkExperience(arr) {
  return meaningfulEntries(arr, ["job_title", "company"]);
}

// A work_experience entry's recency rank for "most recent job first" ordering. Higher =
// more recent. A currently-held job (currently_work_here:true) has no end date and is the
// most recent → Infinity. Otherwise rank by the END date ("to"); if "to" is missing/the
// "YYYY-MM" placeholder, fall back to the START date ("from") so an entry stored without an
// end date still lands near its true recency instead of at the bottom; no parseable date at
// all → -Infinity (last). Months are encoded as year*12+month for a total order.
function workExperienceRecency(e) {
  if (e && e.currently_work_here === true) return Infinity;
  const enc = (d) => { const p = parseYearMonth(d); return p ? parseInt(p.year, 10) * 12 + parseInt(p.month, 10) : null; };
  const end = enc(e && e.to);
  if (end != null) return end;
  const start = enc(e && e.from);
  return start != null ? start : -Infinity;
}

// Sort work_experience entries most-recent-first (by end date; currently-held jobs first),
// tie-broken by start date, then by original order so genuine ties stay stable. Pure → the
// SW calls it in prepareProfile so the i-th filled form entry is the i-th most-recent job,
// regardless of how the profile stored them. Non-array → returned as-is. Does not mutate.
function sortWorkExperienceByRecency(arr) {
  if (!Array.isArray(arr)) return arr;
  const cmpDesc = (x, y) => (x === y ? 0 : x > y ? -1 : 1); // descending; Infinity-safe (unlike y-x)
  const startEnc = (e) => { const p = parseYearMonth(e && e.from); return p ? parseInt(p.year, 10) * 12 + parseInt(p.month, 10) : -Infinity; };
  return arr
    .map((e, i) => ({ e, i }))
    .sort((a, b) =>
      cmpDesc(workExperienceRecency(a.e), workExperienceRecency(b.e)) ||
      cmpDesc(startEnc(a.e), startEnc(b.e)) ||
      (a.i - b.i)
    )
    .map((x) => x.e);
}

// Parse a profile year ("2021") into a 4-digit year string, or null. Rejects empty,
// the "YYYY" placeholder, and non-4-digit values (used for Education's year-only date).
function parseYear(s) {
  const t = String(s == null ? "" : s).trim();
  return /^\d{4}$/.test(t) ? t : null;
}

// Join a work_experience entry's bullets into a newline-separated Role Description.
// Pure → unit-tested; the SW computes it (the injected engine can't import). Empty /
// whitespace-only bullets are dropped; order preserved; non-array → "".
function joinBullets(bullets) {
  return Array.isArray(bullets)
    ? bullets.filter((b) => typeof b === "string" && b.trim() !== "").join("\n")
    : "";
}

// Ensure a website URL has a scheme: leave http(s):// URLs as-is, prepend "https://"
// to a scheme-less one (e.g. "linkedin.com/in/x" → "https://linkedin.com/in/x"); ""→"".
// Pure → unit-tested; the SW applies it when prepping websites so the form gets a full URL.
function ensureHttps(url) {
  const t = String(url == null ? "" : url).trim();
  if (!t) return "";
  return /^https?:\/\//i.test(t) ? t : "https://" + t;
}

// Is a proficiency value "Fluent"? Accepts a string or a tiered array (fluent appearing
// among the candidates counts). The SW uses it to set a language's "I am fluent" box when
// reading+speaking+writing are all fluent.
function isFluent(value) {
  const arr = Array.isArray(value) ? value : [value];
  return arr.some((v) => typeof v === "string" && v.trim().toLowerCase() === "fluent");
}

// ── Option-matching ladder (SW-side copy for the CDP fill driver) ────────────
// TODO(dup): normalize / fuzzyRatio / matchCandidates are INTENTIONAL DUPLICATES of
// the inline copies inside background.js fillEngine (the injected engine is
// stringified into the page and cannot import this file). Change them IN LOCKSTEP —
// drift means the CDP driver and the page engine match options differently. The
// inline copies carry the mirror of this marker.

// Normalize an option string for matching: lowercase, strip a trailing
// "(+digits)" suffix, collapse whitespace.
function normalize(s) {
  return s.toLowerCase().replace(/\s*\(\+\d+\)\s*$/, "").replace(/\s+/g, " ").trim();
}

// Simple Levenshtein-ratio fuzzy match (0-100). Typo tolerance only — used by the
// match ladder at a >=90 threshold (see CLAUDE.md), never as a loose matcher.
function fuzzyRatio(a, b) {
  a = a.toLowerCase();
  b = b.toLowerCase();
  if (a === b) return 100;
  const m = a.length, n = b.length;
  if (m === 0 || n === 0) return 0;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
  const dist = d[m][n];
  return Math.round((1 - dist / Math.max(m, n)) * 100);
}

// Ordered-candidate match ladder (shared by dropdown + typeahead). Candidates
// are tried most-specific first; NO low-threshold fuzzy — a loose bar silently
// selects a WRONG value. Returns { targetIndex, matchTier, matchedCandidate };
// targetIndex === -1 means escalate to needs_review rather than guess.
function matchCandidates(candidates, optionTexts) {
  // Tier 1: exact after normalize() (which strips a trailing "(+N)").
  for (const cand of candidates) {
    const nc = normalize(cand);
    const idx = optionTexts.findIndex((t) => normalize(t) === nc);
    if (idx !== -1) return { targetIndex: idx, matchTier: "exact-normalized", matchedCandidate: cand };
  }
  // Tier 2: containment — startsWith, then includes. AMBIGUITY-SAFE: a candidate
  // contained in 2+ options is NOT a confident match (e.g. "United States" is in both
  // "...of America" and "...Virgin Islands") → skip it, never silently pick the first.
  // Commit ONLY when EXACTLY ONE option contains it. startsWith still beats includes.
  for (const cand of candidates) {
    const nc = normalize(cand);
    const sw = []; optionTexts.forEach((t, i) => { if (normalize(t).startsWith(nc)) sw.push(i); });
    if (sw.length === 1) return { targetIndex: sw[0], matchTier: "containment", matchedCandidate: cand };
    if (sw.length > 1) continue; // ambiguous prefix → try next (more-specific) candidate, else escalate
    const inc = []; optionTexts.forEach((t, i) => { if (normalize(t).includes(nc)) inc.push(i); });
    if (inc.length === 1) return { targetIndex: inc[0], matchTier: "containment", matchedCandidate: cand };
    // 0 or 2+ includes → not a confident containment match for this candidate
  }
  // Tier 3: fuzzy >= 90 — typo tolerance only.
  let best = -1, bestScore = 0, bestCand = null;
  for (const cand of candidates) {
    const nc = normalize(cand);
    optionTexts.forEach((t, i) => {
      const score = fuzzyRatio(nc, normalize(t));
      if (score > bestScore) { bestScore = score; best = i; bestCand = cand; }
    });
  }
  if (bestScore >= 90) return { targetIndex: best, matchTier: `fuzzy-${bestScore}`, matchedCandidate: bestCand };
  return { targetIndex: -1, matchTier: null, matchedCandidate: null };
}

// M31: classify a cdpReadSessionState snapshot as a likely-DEAD/expired Workday
// session. CONSERVATIVE — a valid form (INCLUDING one showing ordinary VALIDATION
// errors) is NEVER dead; a false positive would send a fine user to re-auth and lose
// page state. Recon (Magna, 2026-06-15) proved `vpsErrorPresent` (the "Error Code:
// VPS|" banner that appears on Save & Continue) is FALSE on a live validation error
// and TRUE on a dead session — the clean discriminator. Deliberately does NOT key off
// errorPageText / errorMarkers (a validation error sets those). One-tenant/one-pair
// proof — re-check if another tenant's validation ever carries a VPS-like code.
function sessionLooksDead(state) {
  if (!state) return false;
  if (state.vpsErrorPresent) return true;                                              // VPS| code (post-Save&Continue)
  if (state.sessionBanner) return true;                                                // explicit "session expired" text
  if (state.passwordInputPresent || state.signInButtonPresent || state.authUrl) return true; // login/redirect
  if ((state.formFieldCount || 0) === 0 && !state.applyFlowPagePresent) return true;   // no form at all (hard redirect/blank)
  return false;
}

// Classify a page as Workday's PLANNED-MAINTENANCE page ("Workday is currently unavailable") — a
// TRANSIENT, retry-later state that is NOT a dead session (no re-login needed). Recon (2026-06-27,
// Magna during the maintenance window): title === "Workday is currently unavailable.", an H2 with the
// same text, ZERO data-automation-ids, ZERO form fields, HTTP 200 (NOT 503 — status is useless), body
// = "...performing planned maintenance during the following period: <window>... please check back
// later. © Workday, Inc." No login/VPS/session markers. Checked BEFORE sessionLooksDead (which returns
// true on "no form" → would MISreport maintenance as an expired session → wrong "re-login" guidance).
// CONSERVATIVE: a real form page (formFieldCount>0) or a login redirect is never maintenance.
function isWorkdayMaintenance(state) {
  if (!state) return false;
  if ((state.formFieldCount || 0) > 0) return false;                          // a real form page is never maintenance
  if (state.passwordInputPresent || state.signInButtonPresent) return false;  // login redirect, not maintenance
  if (state.maintenancePresent === true) return true;                         // the cdpReadSessionState body-text marker
  const hay = String(state.title || "") + " " + String(state.bodyTextSample || state.bodyText || "");
  return /workday is currently unavailable|performing (planned )?maintenance|scheduled maintenance|temporarily unavailable|check back later/i.test(hay);
}

// M38 Part 2 — STABLE per-page key for the review-summary accumulation merge (write-
// per-page). Unlike cdpPageSig (which keys the M31 transition detector off the FULL url
// incl. query — fine for "did anything change", but VOLATILE: a session token in the
// query would make the same page get a new key → duplicate accumulation), this drops the
// query/hash (url PATHNAME only) and combines it with the sorted field-name SET — stable
// across re-runs AND distinct across pages even on a same-pathname SPA (the field-set is
// the discriminator, the M31 lesson). `scan` = a cdpPageScan result ({ url, fields:[{fieldName}] }).
function cdpPageKey(scan) {
  if (!scan || !Array.isArray(scan.fields)) return null;
  let path = scan.url || "";
  try { path = new URL(scan.url).pathname; } catch (e) { /* non-URL → keep raw (still stable) */ }
  return path + "|" + scan.fields.map((f) => f.fieldName).sort().join(",");
}

// AI-2: a REQUIRED free-text field the AI declined is filled with a CONSPICUOUS placeholder so
// the walk reaches review (a blank required field would halt it) — but that placeholder is text
// that MUST NOT ship. AI_NEEDS_ANSWER_MARK is the detectable sentinel; removal is a CHECKED
// precondition of submit (not just "loud"): the review viewer banners while any remains, and the
// deferred strict-replay SUBMIT MUST live-re-read the field + REFUSE while the marker is present.
// LOCKSTEP with fill-driver.js AI_NEEDS_ANSWER_MARK_FD (the SW path can't import this).
const AI_NEEDS_ANSWER_MARK = "[NEEDS YOUR ANSWER";
function isAiPlaceholder(text) { return typeof text === "string" && text.indexOf(AI_NEEDS_ANSWER_MARK) !== -1; }
// The submit-precondition seam: bundle entries flagged ai-text-needs-answer whose value STILL
// carries the marker (the bundle is a snapshot; the authoritative submit gate re-reads the LIVE field).
function unreplacedPlaceholders(entries) {
  return (entries || []).filter((e) => e && e.flag === "ai-text-needs-answer" && isAiPlaceholder(e.current_value));
}

// (AI-3 NOTE: the earlier `ungrantedRequiredConsents` consent-halt was REMOVED — operator decided
//  required consent checkboxes AUTO-CHECK silently in the fill, so a consent never strands the walk.)

// ── AI-4 validation-error remediation helpers (pure) ─────────────────────────
// Parse the offending FIELD NAME from a Workday validation-error text. Magna-confirmed format:
// "The field <How Did You Hear About Us?> is required …" (the title may be wrapped in <…> OR bare).
// Returns the human field title (to match against the scan's labels) or null. Best-effort — a
// generic "This field is required" yields null. This text-parse is the PRIMARY Tier-1 signal (the
// anchor-click-to-focus didn't fire on Magna); mappedFieldsFromErrors below turns it into re-fills.
function parseErrorFieldName(text) {
  if (!text) return null;
  const s = String(text);
  let m = s.match(/<([^>]+)>/);                                   // "<Field Title>"
  if (m && m[1].trim()) return m[1].trim();
  m = s.match(/\bfield\s+(.+?)\s+(is|are|must|cannot|can't|should|requires?|needs?)\b/i);
  if (m && m[1].trim()) return m[1].trim().replace(/^["'<\s]+|["'>:\s]+$/g, "") || null;
  return null;
}

// AI-4 NO-PROGRESS guard: did a remediation attempt change the error set at all? Compares two
// arrays of error texts as normalized SETS (trim, drop empties, sort). UNCHANGED (true) ⇒ the
// action didn't resolve anything → HALT rather than burn the cap re-firing the same fix.
function errorSetUnchanged(a, b) {
  const norm = (arr) => (Array.isArray(arr) ? arr : []).map((s) => String(s == null ? "" : s).trim()).filter(Boolean).sort();
  const x = norm(a), y = norm(b);
  if (x.length !== y.length) return false;
  return x.every((v, i) => v === y[i]);
}

// Normalize a field LABEL or an error's field name for matching: lowercase, drop a trailing
// "*"/whitespace (required marker), collapse internal whitespace.
function normalizeLabel(s) {
  return String(s == null ? "" : s).toLowerCase().replace(/[*\s]+$/, "").replace(/\s+/g, " ").trim();
}

// AI-4 Tier-1 (DETERMINISTIC, no AI): the MAPPED fields an error set names. For each error →
// parseErrorFieldName → match a scan field by label (equal OR bidirectional-containment after
// normalizeLabel) → keep only fields with `fieldMap[fieldName]` truthy (deterministically
// re-fillable from the profile). UNMAPPED named fields are intentionally excluded → left for the
// AI tier. Returns the deduped fieldNames. Re-filling an already-correct field is harmless (same
// value), so a loose label match is safe.
function mappedFieldsFromErrors(errorTexts, scanFields, fieldMap) {
  const out = new Set();
  const fm = fieldMap || {};
  for (const t of (Array.isArray(errorTexts) ? errorTexts : [])) {
    const name = parseErrorFieldName(t);
    if (!name) continue;
    const n = normalizeLabel(name);
    if (!n) continue;
    for (const f of (Array.isArray(scanFields) ? scanFields : [])) {
      if (!f || !fm[f.fieldName]) continue;                       // only MAPPED fields (deterministic)
      const fl = normalizeLabel(f.label);
      if (fl && (fl === n || fl.includes(n) || n.includes(fl))) out.add(f.fieldName);
    }
  }
  return [...out];
}

// AI-4 error-sample PREPROCESS (the 2026-07-01 live Tier-0 miss): Workday's top error-summary
// banner CONCATENATES every error into ONE element ("Error-SpecialtyThe field Specialty is
// required…Error-LanguageDuplicate language entries are not allowed."), and the M31 diagnostic
// read truncated each sample — so any error past the first ~2 was INVISIBLE to the remediation
// tiers (the dup-language hardcode never fired on a banner that plainly contained its error).
// Split each sample on the per-error "Error-" prefix into individual error texts; drop success
// toasts (the [role=alert] selector catches "…successfully uploaded" — not errors, just noise
// in the count/AI prompt); dedupe. Feed THIS to the tiers, never the raw samples.
function expandErrorSamples(samples) {
  const out = [];
  const seen = new Set();
  for (const s of (Array.isArray(samples) ? samples : [])) {
    const t = String(s == null ? "" : s).trim();
    if (!t) continue;
    for (const piece of t.split(/(?=\bError-)/)) {
      const p = piece.trim();
      if (!p) continue;
      if (/successfully uploaded/i.test(p) && !/\berror\b/i.test(p)) continue; // success toast, not an error
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

// AI-4 Tier-0 trigger: the known Magna/Workday phantom "Duplicate language entries are not allowed"
// bug. Scoped to LANGUAGES only (operator-confirmed) — other sections' duplicate errors may be real.
function isDuplicateLanguageError(errorTexts) {
  return (Array.isArray(errorTexts) ? errorTexts : []).some((t) => /duplicate\s+language\s+entr/i.test(String(t == null ? "" : t)));
}

// Parse the FILLED language entries out of a page's results (records keyed `language[i].<field>`)
// into [{index, language, summary}] sorted by index. `summary` is a human content string (language +
// per-skill proficiency + native) so a delete can RECORD what it removed (re-add manually if needed).
function languageEntriesFromResults(results) {
  const byIdx = {};
  for (const r of (Array.isArray(results) ? results : [])) {
    const m = /^language\[(\d+)\]\.(\w+)/.exec((r && r.fieldName) || "");
    if (!m) continue;
    const i = parseInt(m[1], 10);
    (byIdx[i] = byIdx[i] || { index: i })[m[2]] = r.after;
  }
  return Object.keys(byIdx).map((k) => byIdx[k]).sort((a, b) => a.index - b.index).map((e) => {
    const prof = [["read", e.readingProficiency], ["speak", e.speakingProficiency], ["write", e.writingProficiency]]
      .filter((p) => p[1]).map((p) => p[0] + " " + p[1]);
    if (String(e.native) === "true") prof.push("native");
    return { index: e.index, language: e.language || null, summary: (e.language || "?") + (prof.length ? " (" + prof.join(", ") + ")" : "") };
  });
}

// AI-4 Tier-0 plan (DETERMINISTIC, no AI) — real-vs-phantom from the entries' language VALUES (the
// error text alone can't tell them apart): two entries sharing a normalized language value ⇒ a REAL
// duplicate → delete only the later occurrence(s); all-distinct ⇒ the PHANTOM bug → delete ALL.
function languageDeletionPlan(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const seen = new Set(), dupes = [];
  for (const e of list) {
    const v = String((e && e.language) || "").trim().toLowerCase();
    if (!v) continue;
    if (seen.has(v)) dupes.push(e.index); else seen.add(v);
  }
  const summary = list.map((e) => e.summary).join(", ");
  if (dupes.length) return { mode: "real", deleteIndices: dupes.slice(), summary };
  return { mode: "phantom", deleteIndices: list.map((e) => e.index), summary };
}

// REVIEW-PAGE RECONCILIATION (the end-to-end fill-verify). The Workday review page (the final
// application page) renders every value ACTUALLY in the form as read-only text — the ground truth of
// what would be submitted. Compare it against what the extension RECORDED it filled (the accumulated
// reviewSummary bundle's entries). A disagreement means the fill did not stick (the React value-revert
// class the safety contract exists to catch) or the extension recorded a value that is not really on
// the form — a bug to investigate. DOM-AGNOSTIC on purpose: it consumes plain `[{label, value}]` pairs
// (however the scraper obtained them), so the match/compare logic is unit-testable independent of the
// review page's (untraced) DOM. The scraper (cdpReadReviewPage) is the part that needs live refinement.
//
//   reviewItems   : [{label, value}]           scraped from the review page (display strings)
//   bundleEntries : reviewSummary.entries[]     (question_label, current_value, fill_status,
//                   widget_type, canonical_field, is_required, page_number, field_id)
// Returns { agree, disagree, missing_on_review, extra_on_review, ambiguous, counts }.
//
// Value agreement is normalize()-based with a containment + fuzzy≥90 relief (so a dropdown's
// "United States of America (+1)" reconciles with the review page's "United States of America").
// WIDGET-AWARE: a CHECKBOX's current_value is "true"/"false" (String(checked)) and the review page
// shows a checked box as its label → "Yes", so a checked box is verified present (an unchecked box is
// SKIPPED — the review page doesn't render it, so its absence is not a bug); a FILE_UPLOAD's
// current_value is the resume filename, matched by containment against the review's "Attachments" value
// (label-independent). Unreplaced AI placeholders are excluded (not real values). All exclusions are
// surfaced as counts, never false bugs.
function reconcileReviewPage(reviewItems, bundleEntries) {
  const TRUEISH = /^(true|yes|checked|selected|on|1)$/i;
  const items = (Array.isArray(reviewItems) ? reviewItems : [])
    .map((it) => ({ label: String((it && it.label) || ""), value: String((it && it.value) || ""), used: false }))
    .filter((it) => it.label || it.value)
    .map((it) => ({ ...it, nlabel: normalizeLabel(it.label), nval: normalize(it.value) }));

  // A label containment match is only trusted when the shorter label is non-trivial (≥3 chars).
  const labelMatches = (a, b) => {
    if (!a || !b) return false;
    if (a === b) return true;
    const short = a.length <= b.length ? a : b, long = a.length <= b.length ? b : a;
    return short.length >= 3 && long.includes(short);
  };
  // Value agreement: exact-normalized, then containment (shorter ≥4 chars, so "No"/"Yes" stay
  // exact-only and can't false-match a longer string), then fuzzy≥90 (typo tolerance). Returns the
  // tier ("exact"/"containment"/"fuzzy") or null.
  const valueTier = (a, b) => {
    if (a === b) return a === "" ? "exact-blank" : "exact";
    if (!a || !b) return null;
    const short = a.length <= b.length ? a : b, long = a.length <= b.length ? b : a;
    if (short.length >= 4 && long.includes(short)) return "containment";
    if (a.length >= 3 && b.length >= 3 && fuzzyRatio(a, b) >= 90) return "fuzzy";
    return null;
  };

  const agree = [], disagree = [], missing_on_review = [], ambiguous = [];
  let skipped = 0, placeholders = 0, claimed = 0;

  for (const e of (Array.isArray(bundleEntries) ? bundleEntries : [])) {
    if (!e) continue;
    const cv = e.current_value;
    if (cv == null || String(cv).trim() === "") continue;          // the extension claims no value here
    if (isAiPlaceholder(cv)) { placeholders++; continue; }          // an unreplaced AI mark, not a real value
    const wt = e.widget_type, cvs = String(cv);
    const base = { label: e.question_label != null ? e.question_label : null, value_bundle: cvs,
                   field_id: e.field_id != null ? e.field_id : null, widget_type: wt != null ? wt : null,
                   canonical_field: e.canonical_field != null ? e.canonical_field : null,
                   is_required: !!e.is_required, page_number: e.page_number != null ? e.page_number : null };

    // ── file_upload: match by FILENAME containment against ANY review value (label-independent —
    //    the review shows the resume inside an "Attachments" blob). Absent ⇒ resume didn't attach. ──
    if (wt === "file_upload") {
      claimed++;
      const nfile = normalize(cvs);
      const hit = items.find((it) => !it.used && nfile.length >= 3 &&
        (it.nval.includes(nfile) || (it.nval.length >= 3 && nfile.includes(it.nval))));
      if (hit) { hit.used = true; agree.push({ ...base, value_review: hit.value, tier: "file" }); }
      else missing_on_review.push(base);
      continue;
    }

    // ── checkbox: an UNCHECKED box is skipped (not rendered on review); a CHECKED box must appear as
    //    its label → "Yes". Not found ⇒ a (required) box that didn't stick. ──
    if (wt === "checkbox") {
      if (!TRUEISH.test(cvs.trim())) { skipped++; continue; }
      claimed++;
      const nlabel = normalizeLabel(e.question_label);
      const cand = items.find((it) => !it.used && it.nlabel && (it.nlabel === nlabel || labelMatches(it.nlabel, nlabel)));
      if (!cand) { missing_on_review.push(base); continue; }
      cand.used = true;
      if (TRUEISH.test(cand.value.trim()) || valueTier("yes", cand.nval)) agree.push({ ...base, value_review: cand.value, tier: "checkbox" });
      else disagree.push({ ...base, value_review: cand.value });
      continue;
    }

    // ── everything else: label match (exact then containment), then value compare ──
    claimed++;
    const nlabel = normalizeLabel(e.question_label), nval = normalize(cvs);
    const exact = items.filter((it) => !it.used && it.nlabel && it.nlabel === nlabel);
    const cands = exact.length ? exact : items.filter((it) => !it.used && labelMatches(it.nlabel, nlabel));
    if (!cands.length) { missing_on_review.push(base); continue; }

    // Disambiguate by value: prefer a candidate whose value also reconciles.
    const withTier = cands.map((it) => ({ it, tier: valueTier(nval, it.nval) }));
    const agreeing = withTier.filter((c) => c.tier);
    if (agreeing.length) {
      const pick = agreeing[0]; pick.it.used = true;
      agree.push({ ...base, value_review: pick.it.value, tier: pick.tier });
    } else if (cands.length === 1) {
      cands[0].used = true;
      disagree.push({ ...base, value_review: cands[0].value });
    } else {
      // multiple label matches, none reconcile by value — can't confidently pick (repeating-section
      // label collisions land here). Surface all candidate values rather than guess a wrong "disagree".
      ambiguous.push({ ...base, candidates: cands.map((it) => it.value) });
    }
  }

  const extra_on_review = items.filter((it) => !it.used && it.value.trim())
    .map((it) => ({ label: it.label || null, value_review: it.value }));

  return {
    agree, disagree, missing_on_review, extra_on_review, ambiguous,
    counts: { claimed, agree: agree.length, disagree: disagree.length, missing_on_review: missing_on_review.length,
              extra_on_review: extra_on_review.length, ambiguous: ambiguous.length, skipped, placeholders },
  };
}

// UMD-lite: export for the Node test runner; in the SW `module` is undefined so the
// functions simply stay globals (from importScripts).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { parseYearMonth, parseYearMonthDay, parseRepeatingFkit, parseNestedFkit, meaningfulEntries, meaningfulWorkExperience, sortWorkExperienceByRecency, workExperienceRecency, parseYear, joinBullets, ensureHttps, isFluent, normalize, fuzzyRatio, matchCandidates, sessionLooksDead, isWorkdayMaintenance, cdpPageKey, AI_NEEDS_ANSWER_MARK, isAiPlaceholder, unreplacedPlaceholders, parseErrorFieldName, errorSetUnchanged, normalizeLabel, mappedFieldsFromErrors, expandErrorSamples, isDuplicateLanguageError, languageEntriesFromResults, languageDeletionPlan, reconcileReviewPage };
}
