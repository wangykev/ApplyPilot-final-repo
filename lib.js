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

// Convenience wrapper for work_experience (entries with a job title or company).
function meaningfulWorkExperience(arr) {
  return meaningfulEntries(arr, ["job_title", "company"]);
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
  // Tier 2: containment — startsWith, then includes.
  for (const cand of candidates) {
    const nc = normalize(cand);
    let idx = optionTexts.findIndex((t) => normalize(t).startsWith(nc));
    if (idx === -1) idx = optionTexts.findIndex((t) => normalize(t).includes(nc));
    if (idx !== -1) return { targetIndex: idx, matchTier: "containment", matchedCandidate: cand };
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

// UMD-lite: export for the Node test runner; in the SW `module` is undefined so the
// functions simply stay globals (from importScripts).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { parseYearMonth, parseYearMonthDay, meaningfulEntries, meaningfulWorkExperience, parseYear, joinBullets, ensureHttps, isFluent, normalize, fuzzyRatio, matchCandidates, sessionLooksDead, cdpPageKey, AI_NEEDS_ANSWER_MARK, isAiPlaceholder, unreplacedPlaceholders };
}
