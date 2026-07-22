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
//
// opts.containment (default TRUE) — whether the containment tier runs. WIDGET-DEPENDENT (2026-07-16):
//   • SELECT-from-a-full-list widgets (dropdown / radio) pass {containment:false}. There a substring
//     match is a GUESS dressed up as a match — "PA" silently committed "Armed Forces Pacific" — so those
//     escalate to needs_review instead (exact → typo → review; the operator picks the option / teaches a
//     bucket → an exact match next time). (fillRadioCdp is already exact-label-only, so this only affects
//     fillDropdownCdp.)
//   • TYPE-a-partial-the-widget-completes widgets (typeahead / cert / source) keep containment ON — there
//     "what I typed ⊆ what the widget offered" IS the correct commit signal (and the commit is separately
//     chip-verified + always flagged filled_review, so it's never silent). It stays the DEFAULT.
function matchCandidates(candidates, optionTexts, opts) {
  const allowContainment = !opts || opts.containment !== false;
  // Tier 1: exact after normalize() (which strips a trailing "(+N)").
  for (const cand of candidates) {
    const nc = normalize(cand);
    const idx = optionTexts.findIndex((t) => normalize(t) === nc);
    if (idx !== -1) return { targetIndex: idx, matchTier: "exact-normalized", matchedCandidate: cand };
  }
  // Tier 2: containment — startsWith, then includes. AMBIGUITY-SAFE: a candidate contained in 2+ options
  // is NOT a confident match → skip it, never silently pick the first. Commit ONLY when EXACTLY ONE option
  // contains it. startsWith still beats includes. MID-STRING `includes` additionally requires the candidate
  // to be >= 3 chars — a 2-char value ("PA") is a substring of too many unrelated options to trust, and the
  // ambiguity guard can't catch a SINGLE coincidental hit. Skipped entirely for dropdown/radio (see opts).
  if (allowContainment) {
    for (const cand of candidates) {
      const nc = normalize(cand);
      const sw = []; optionTexts.forEach((t, i) => { if (normalize(t).startsWith(nc)) sw.push(i); });
      if (sw.length === 1) return { targetIndex: sw[0], matchTier: "containment", matchedCandidate: cand };
      if (sw.length > 1) continue; // ambiguous prefix → try next (more-specific) candidate, else escalate
      if (nc.length >= 3) {
        const inc = []; optionTexts.forEach((t, i) => { if (normalize(t).includes(nc)) inc.push(i); });
        if (inc.length === 1) return { targetIndex: inc[0], matchTier: "containment", matchedCandidate: cand };
      }
      // 0 or 2+ includes (or a candidate too short to mid-string-match) → not a confident containment match
    }
  }
  // Tier 3: fuzzy >= 90 — TYPO TOLERANCE ONLY.
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

// AI-4 Tier-0 trigger: the Workday phantom "You can't add duplicate website URLs" bug. On repeat
// fills with the same account Workday sometimes fails to clear the PRIOR run's website links on its
// backend, so a freshly-added URL is rejected as a duplicate of a link the FORM no longer shows.
// Handled like dup-language: delete the website rows so Save & Continue proceeds; the stale links may
// still surface on the final review page, which is expected/acceptable (they're Workday's state, not
// ours). NOT a catch-all "duplicate" match — scoped to website/URL text so real duplicate errors in
// other sections aren't blindly deleted.
function isDuplicateWebsiteError(errorTexts) {
  return (Array.isArray(errorTexts) ? errorTexts : []).some((t) => /duplicate\s+(?:website|web\s?address)\s+urls?/i.test(String(t == null ? "" : t)));
}

// Parse the FILLED website entries out of a page's results (records keyed `website[i].url`) into
// [{index, url, summary}] sorted by index.
function websiteEntriesFromResults(results) {
  const byIdx = {};
  for (const r of (Array.isArray(results) ? results : [])) {
    const m = /^website\[(\d+)\]\.url/.exec((r && r.fieldName) || "");
    if (!m) continue;
    const i = parseInt(m[1], 10);
    (byIdx[i] = byIdx[i] || { index: i }).url = r.after;
  }
  return Object.keys(byIdx).map((k) => byIdx[k]).sort((a, b) => a.index - b.index)
    .map((e) => ({ index: e.index, url: e.url || null, summary: e.url || "?" }));
}

// AI-4 Tier-0 plan for websites (DETERMINISTIC, no AI) — mirrors languageDeletionPlan: two entries
// sharing a normalized URL ⇒ a REAL duplicate → delete only the later occurrence(s); all-distinct ⇒
// the PHANTOM backend bug → delete ALL (the rejected URL isn't a visible in-form row to keep).
function websiteDeletionPlan(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const seen = new Set(), dupes = [];
  for (const e of list) {
    const v = String((e && e.url) || "").trim().toLowerCase().replace(/\/+$/, "");
    if (!v) continue;
    if (seen.has(v)) dupes.push(e.index); else seen.add(v);
  }
  const summary = list.map((e) => e.summary).join(", ");
  if (dupes.length) return { mode: "real", deleteIndices: dupes.slice(), summary };
  return { mode: "phantom", deleteIndices: list.map((e) => e.index), summary };
}

// Stable per-JOB identity for tracker dedup. A Workday application URL VARIES across runs AND hosts:
// the POSTING the user pastes is <tenant>.wdN.myworkdayjobs.com (tenant in the SUBDOMAIN), but after
// login the form is on wdN.myworkdaysite.com (tenant in the PATH, /recruiting/<tenant>/ — NOT the
// subdomain), with a per-application-instance tail. The one token common to BOTH hosts is the
// data-center (wd3, wd5, …); combined with the requisition id (…_R00244793, present in both paths) it
// gives a key — "<dc>:r<reqid>" — that collapses the posting + every form/instance/query variant to
// ONE row. (Keying on the subdomain split myworkdayjobs from myworkdaysite — the 2026-07-22 bug.)
// No _R match (non-Workday / odd URL) → origin+pathname minus query and the /apply… tail. LOCKSTEP
// with the web copy in web/lib/job-key.ts (reportApplication + saveRunJob must produce identical keys).
function canonicalJobUrl(u) {
  try {
    const p = new URL(String(u));
    const req = (p.pathname.match(/_R(\d+)\b/i) || [])[1];
    const dc = (p.hostname.match(/\bwd\d+\b/i) || [""])[0].toLowerCase(); // "wd3" — on both hosts
    if (req) return (dc || "wd") + ":r" + req;
    return (p.origin + p.pathname).toLowerCase().replace(/\/apply(?:\/[^/]*)*\/?$/i, "").replace(/\/+$/, "");
  } catch (e) {
    return String(u == null ? "" : u).split(/[?#]/)[0].toLowerCase();
  }
}

// US + Canada region name → postal abbreviation. Workday review pages render the address as ONE blob
// with the abbreviation ("Tallahassee, FL"), not the spelled-out region a dropdown stored ("Florida"),
// so a name↔abbrev equivalence stops a stored region from reading as a false "missing".
const REGION_ABBREV = {
  alabama:"al",alaska:"ak",arizona:"az",arkansas:"ar",california:"ca",colorado:"co",connecticut:"ct",delaware:"de",
  florida:"fl",georgia:"ga",hawaii:"hi",idaho:"id",illinois:"il",indiana:"in",iowa:"ia",kansas:"ks",kentucky:"ky",
  louisiana:"la",maine:"me",maryland:"md",massachusetts:"ma",michigan:"mi",minnesota:"mn",mississippi:"ms",missouri:"mo",
  montana:"mt",nebraska:"ne",nevada:"nv","new hampshire":"nh","new jersey":"nj","new mexico":"nm","new york":"ny",
  "north carolina":"nc","north dakota":"nd",ohio:"oh",oklahoma:"ok",oregon:"or",pennsylvania:"pa","rhode island":"ri",
  "south carolina":"sc","south dakota":"sd",tennessee:"tn",texas:"tx",utah:"ut",vermont:"vt",virginia:"va",
  washington:"wa","west virginia":"wv",wisconsin:"wi",wyoming:"wy","district of columbia":"dc",
  alberta:"ab","british columbia":"bc",manitoba:"mb","new brunswick":"nb","newfoundland and labrador":"nl",
  "nova scotia":"ns",ontario:"on","prince edward island":"pe",quebec:"qc",saskatchewan:"sk",
};

// Canonical-section name → data-fkit-id prefix. The ONLY divergence between the bundle's
// canonical_field section name and the review page's fkit prefix is `website`↔`webAddress`
// (workExperience / education / certification / language are identical on both sides). Mirrors
// PAGE_SECTIONS' name↔containerPrefix (fill-driver.js) — LOCKSTEP, but lib.js can't import
// fill-driver.js, so this table is the local source of truth. A section not listed here maps to
// itself. (Websites ARE panelized on the review page — `Websites-1-panel`/`Websites-2-panel` — so
// `webAddress` resolves through the normal entry-scoped path like every other repeating section.)
const CANONICAL_TO_FKIT = { website: "webAddress" };

// REVIEW-PAGE RECONCILIATION (the end-to-end fill-verify). The Workday review page (the final
// application page) renders every value ACTUALLY in the form as read-only text — the ground truth of
// what would be submitted. Compare it against what the extension RECORDED it filled (the accumulated
// reviewSummary bundle's entries). A disagreement means the fill did not stick (the React value-revert
// class the safety contract exists to catch) or the extension recorded a value that is not really on
// the form — a bug to investigate.
//
// ID + SECTION/ENTRY-SCOPED, with a value-presence fallback (the 2026-07-10 rewrite). The review page's
// DOM is highly regular: each field's value lives in a `<span id="KEY">` whose id IS the form-field name,
// grouped into repeating entries by `role="group"` panels (`aria-labelledby$="-<N>-panel"`) and sections
// by h3/h4. So `cdpReadReviewPage` now emits STRUCTURED records ({ key, label, entryOrdinal, fkitPrefix,
// value, isAttachment }) and the AUTHORITATIVE match is by identity:
//   (a) FLAT field  → the unused record with entryOrdinal===null && key===<form-field name>.
//   (b) REPEATING   → SCOPE to the entry FIRST (fkitPrefix===CANONICAL_TO_FKIT(section) && entryOrdinal
//       ===index+1 — the PANEL ordinal, which RESETS per section; NEVER the global fkit number), THEN
//       within that ONE entry match key===<name> OR normalizeLabel(label)===normalizeLabel(question).
//       (The label bridge is safe ONLY because entry-scoping runs first: Reading/Speaking/Writing
//       Proficiency labels repeat across entries but are distinct within one.)
// A keyed/entry match is AUTHORITATIVE — a value mismatch is a real DISAGREE, never fall through (which
// could false-agree against an unrelated field). checkbox → TRUEISH decides; else a single-pair tiered
// compare (exact→containment→digits→region-abbrev→fuzzy≥90).
//
// FALLBACK — records with no id/entry context (bare `{label,value}`, or a bundle field whose review span
// carries a GENERATED id that matches no form-field name, e.g. the My-Info Legal Name/Address/Email/Phone
// spans) flow through the PRESERVED legacy path: value-presence for distinctive values (a substring of
// the page text, with digit + region-abbrev relief), label-anchoring for short "Yes"/"No" + checkboxes.
// FILE_UPLOAD matches the resume filename by page-text containment. Unreplaced AI placeholders excluded;
// an unchecked box is SKIPPED. EXTRA = a distinctive page value NOT explained by any recorded value.
//
//   reviewItems   : [{label, value, key?, entryOrdinal?, fkitPrefix?, isAttachment?}]  structured records
//                   from cdpReadReviewPage (bare {label,value} still works → fallback path)
//   bundleEntries : reviewSummary.entries[]     (question_label, current_value, fill_status,
//                   widget_type, canonical_field, is_required, page_number, field_id)
// Returns { agree, disagree, missing_on_review, extra_on_review, ambiguous, counts }.
function reconcileReviewPage(reviewItems, bundleEntries, opts) {
  const TRUEISH = /^(true|yes|checked|selected|on|1)$/i;
  // Values that are too generic to trust by page-presence (they appear all over the page) — these ride
  // the label-anchored path instead, so "yes"/"no" verify the RIGHT question, not any stray "no".
  const AMBIGUOUS_SHORT = /^(yes|no|n\/?a|true|false)$/i;
  // Emails Workday may pre-fill from the ACCOUNT you signed up with (login / auth_strategy.account_email /
  // personal_info.email) — lowercased. Used by the email-verify pass below; empty ⇒ that pass is skipped.
  const accountEmails = (((opts && opts.accountEmails) || [])).map((s) => String(s == null ? "" : s).trim().toLowerCase()).filter(Boolean);
  const items = (Array.isArray(reviewItems) ? reviewItems : [])
    .map((it) => ({ label: String((it && it.label) || ""), value: String((it && it.value) || ""), used: false,
                    section: it && it.section != null ? String(it.section) : "", // structured record's section (h3/h4) — for the email-verify pass
                    key: it && it.key != null ? String(it.key) : null,
                    entryOrdinal: it && it.entryOrdinal != null ? it.entryOrdinal : null,
                    fkitPrefix: it && it.fkitPrefix != null ? String(it.fkitPrefix) : null }))
    .filter((it) => it.label || it.value)
    .map((it) => ({ ...it, nlabel: normalizeLabel(it.label), nval: normalize(it.value) }));

  // The whole review page as one lowercased blob (from the scraped item values) + its digits-only form.
  const pageText = items.map((it) => it.value).join("  ").toLowerCase().replace(/\s+/g, " ");
  const pageDigits = pageText.replace(/\D+/g, "");

  const labelMatches = (a, b) => {
    if (!a || !b) return false;
    if (a === b) return true;
    const short = a.length <= b.length ? a : b, long = a.length <= b.length ? b : a;
    return short.length >= 3 && long.includes(short);
  };
  const valueTier = (a, b) => { // value agreement for the label-anchored path (short values / disagree)
    if (a === b) return a === "" ? "exact-blank" : "exact";
    if (!a || !b) return null;
    const short = a.length <= b.length ? a : b, long = a.length <= b.length ? b : a;
    if (short.length >= 4 && long.includes(short)) return "containment";
    if (a.length >= 3 && b.length >= 3 && fuzzyRatio(a, b) >= 90) return "fuzzy";
    return null;
  };
  // Is this DISTINCTIVE recorded value present on the page? Returns the tier or null.
  const presentTier = (rawValue) => {
    const nv = normalize(rawValue);
    if (nv.length >= 2 && pageText.includes(nv)) return "text";
    const vd = String(rawValue).replace(/\D+/g, "");
    if (vd.length >= 4 && pageDigits.includes(vd)) return "digits";
    const ab = REGION_ABBREV[nv];
    if (ab && new RegExp("(^|[ ,])" + ab + "([ ,]|$)").test(pageText)) return "region-abbrev";
    return null;
  };
  // Single-PAIR tiered value compare (the authoritative path — the two values are already the RIGHT
  // field, so this only asks "are they equal enough?"): exact→containment→digits→region-abbrev→fuzzy≥90.
  const valuesAgree = (recRaw, revRaw) => {
    const a = normalize(recRaw), b = normalize(revRaw);
    if (a === b) return true;
    if (!a || !b) return false;
    const short = a.length <= b.length ? a : b, long = a.length <= b.length ? b : a;
    if (short.length >= 4 && long.includes(short)) return true;
    const ad = String(recRaw).replace(/\D+/g, ""), bd = String(revRaw).replace(/\D+/g, "");
    if (ad.length >= 4 && bd.length >= 4 && (ad === bd || bd.includes(ad) || ad.includes(bd))) return true;
    const ab = REGION_ABBREV[a]; if (ab && new RegExp("(^|[ ,])" + ab + "([ ,]|$)").test(b)) return true;
    const ba = REGION_ABBREV[b]; if (ba && new RegExp("(^|[ ,])" + ba + "([ ,]|$)").test(a)) return true;
    if (a.length >= 3 && b.length >= 3 && fuzzyRatio(a, b) >= 90) return true;
    return false;
  };
  // A repeating canonical_field ("workExperience[0].jobTitle") → { section, index, path }; null if flat.
  const parseCanonical = (cf) => {
    const m = /^([A-Za-z_]+)\s*\[(\d+)\]\.(.+)$/.exec(String(cf == null ? "" : cf));
    return m ? { section: m[1], index: parseInt(m[2], 10), path: m[3] } : null;
  };
  // field_id ("<page>::formField-<name>", where <name> may be "section[idx].field" for repeating) → the
  // bare form-field name — the review span's id for a non-renamed field. Strips through the last
  // "formField-" then a leading "section[idx]." (the repeating canonical embedded in the name).
  const formFieldOf = (fieldId) => {
    let s = String(fieldId == null ? "" : fieldId);
    const i = s.lastIndexOf("formField-");
    if (i !== -1) s = s.slice(i + "formField-".length);
    return s.replace(/^[A-Za-z_]+\s*\[\d+\]\./, "");
  };

  const agree = [], disagree = [], missing_on_review = [], ambiguous = [];
  let skipped = 0, placeholders = 0, claimed = 0;
  const claimedValues = []; // normalized recorded values — drives the EXTRA computation

  for (const e of (Array.isArray(bundleEntries) ? bundleEntries : [])) {
    if (!e) continue;
    const cv = e.current_value;
    if (cv == null || String(cv).trim() === "") continue;          // the extension claims no value here
    if (isAiPlaceholder(cv)) { placeholders++; continue; }          // an unreplaced AI mark, not a real value
    const wt = e.widget_type, cvs = String(cv), nlabel = normalizeLabel(e.question_label), nval = normalize(cvs);
    const base = { label: e.question_label != null ? e.question_label : null, value_bundle: cvs,
                   field_id: e.field_id != null ? e.field_id : null, widget_type: wt != null ? wt : null,
                   canonical_field: e.canonical_field != null ? e.canonical_field : null,
                   is_required: !!e.is_required, page_number: e.page_number != null ? e.page_number : null };

    // ── file_upload: the resume filename must appear on the page (in the "Attachments" blob). ──
    if (wt === "file_upload") {
      claimed++; claimedValues.push(nval);
      if (nval.length >= 3 && pageText.includes(nval)) agree.push({ ...base, value_review: cvs, tier: "file" });
      else missing_on_review.push(base);
      continue;
    }

    // ── unchecked checkbox → skipped (the review page doesn't render it — absence isn't a bug). ──
    if (wt === "checkbox" && !TRUEISH.test(cvs.trim())) { skipped++; continue; }

    // ── AUTHORITATIVE id/entry-scoped match (structured records). Found ⇒ resolve here, NEVER fall
    //    through (a keyed/entry mismatch is a real disagree — falling through to value-presence could
    //    false-agree by finding the value in an unrelated field). Bare {label,value} records or an
    //    unmatched form-field name yield no candidate → the legacy fallback below. ──
    const ffName = formFieldOf(e.field_id);
    const rep = parseCanonical(e.canonical_field);
    let cand = null;
    if (!rep) {
      if (ffName) cand = items.find((it) => !it.used && it.entryOrdinal == null && it.key && it.key === ffName);
    } else {
      const fkBase = CANONICAL_TO_FKIT[rep.section] || rep.section;
      const inEntry = items.filter((it) => !it.used && it.fkitPrefix === fkBase && it.entryOrdinal === rep.index + 1);
      cand = (ffName ? inEntry.find((it) => it.key && it.key === ffName) : null)
          || (nlabel ? inEntry.find((it) => it.nlabel && it.nlabel === nlabel) : null);
    }
    if (cand) {
      cand.used = true;
      if (wt === "checkbox") {
        claimed++;
        if (TRUEISH.test(cand.value.trim())) agree.push({ ...base, value_review: cand.value, tier: "checkbox-keyed" });
        else disagree.push({ ...base, value_review: cand.value });
      } else {
        claimed++; claimedValues.push(nval);
        if (valuesAgree(cvs, cand.value)) agree.push({ ...base, value_review: cand.value, tier: rep ? "entry" : "keyed" });
        else disagree.push({ ...base, value_review: cand.value });
      }
      continue;
    }

    // ── FALLBACK (legacy, VERBATIM) — checkbox label-anchor; then value-presence; then label-anchor. ──
    if (wt === "checkbox") {
      claimed++;
      const cands = items.filter((it) => !it.used && it.nlabel && (it.nlabel === nlabel || labelMatches(it.nlabel, nlabel)));
      // PREFER a TRUEISH candidate first: with IDENTICAL repeating labels (two "I am fluent in this
      // language." rows — Chinese "No", English "Yes"), a CHECKED box must consume the "Yes", not the
      // first yes/no item (which may be another entry's "No" → false disagree). Then any yes/no-valued
      // item (the preferredCheck fix — a mislabeled distinctive value), then the first candidate.
      const cbCand = cands.find((it) => TRUEISH.test(it.value.trim())) || cands.find((it) => /^(yes|no|true|false)$/i.test(it.value.trim())) || cands[0];
      if (!cbCand) { missing_on_review.push(base); continue; }
      cbCand.used = true;
      if (TRUEISH.test(cbCand.value.trim())) agree.push({ ...base, value_review: cbCand.value, tier: "checkbox" });
      else disagree.push({ ...base, value_review: cbCand.value });
      continue;
    }

    claimed++; claimedValues.push(nval);

    // ── DISTINCTIVE value → value-presence (label-independent). A value is distinctive enough to trust
    //    by presence when it is ≥4 chars, OR ≥3 and not a generic yes/no token (so a short name like
    //    "Doe" — present in "John Doe" — is found, while a bare "Yes"/"No" stays on the label path). ──
    if (nval.length >= 4 || (nval.length >= 3 && !AMBIGUOUS_SHORT.test(nval))) {
      const tier = presentTier(cvs);
      if (tier) { agree.push({ ...base, value_review: cvs, tier }); continue; }
    }
    // ── SHORT value (or a distinctive value not found) → label-anchored against the scraped items. ──
    const cands = items.filter((it) => !it.used && it.nlabel && (it.nlabel === nlabel || labelMatches(it.nlabel, nlabel)));
    if (cands.length) {
      const ag = cands.find((it) => valueTier(nval, it.nval));
      if (ag) { ag.used = true; agree.push({ ...base, value_review: ag.value, tier: "label" }); }
      else if (cands.length === 1) { cands[0].used = true; disagree.push({ ...base, value_review: cands[0].value }); }
      else ambiguous.push({ ...base, candidates: cands.map((it) => it.value) }); // can't confidently pick
      continue;
    }
    missing_on_review.push(base); // recorded but nowhere on the page — the fill-didn't-stick signal
  }

  // ── EMAIL VERIFY (operator ask 2026-07-12): Workday pre-fills the applicant email from the ACCOUNT you
  //    signed up with, so it's NOT in the bundle and would otherwise surface as EXTRA noise. Confirm the
  //    displayed email IS one of your account emails — a MATCH is a positive verification (agree, no longer
  //    noise); a MISMATCH is a real problem (disagree → BLOCKS submit: you'd apply with the wrong contact
  //    email). Keyed off the "Email Address" section/label. Skipped when no accountEmails supplied (bare
  //    {label,value} callers behave exactly as before; the email just stays EXTRA as it did). ──
  const isEmailValue = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v == null ? "" : v).trim());
  if (accountEmails.length) {
    const er = items.find((it) => !it.used && isEmailValue(it.value) && (/e-?mail/i.test(it.section) || /e-?mail/i.test(it.label)));
    if (er) {
      er.used = true; claimed++;
      const b = { label: "Email Address", field_id: null, widget_type: "text", canonical_field: "personal_info.email", is_required: false, page_number: null };
      if (accountEmails.includes(er.value.trim().toLowerCase())) {
        claimedValues.push(normalize(er.value)); // verified → not "extra"
        agree.push({ ...b, value_bundle: er.value, value_review: er.value, tier: "account-email" });
      } else {
        disagree.push({ ...b, value_bundle: accountEmails.join(" / "), value_review: er.value }); // wrong email → real flag
      }
    }
  }

  // EXTRA = a DISTINCTIVE page value (≥4 chars) not explained by ANY recorded value (either contains the
  // other). Surfaces a value the form holds that the bundle doesn't — e.g. a language the summary deleted
  // but the form kept. Short/ambiguous values ("Yes"/"No") are never "extra"; a matched/used record isn't either.
  const explained = (nv) => claimedValues.some((cvn) => cvn && Math.min(cvn.length, nv.length) >= 4 && (cvn.includes(nv) || nv.includes(cvn)));
  const seenExtra = new Set(), extra_on_review = [];
  for (const it of items) {
    const nv = it.nval;
    if (nv.length < 4 || it.used || explained(nv) || seenExtra.has(nv)) continue;
    seenExtra.add(nv);
    extra_on_review.push({ label: it.label || null, value_review: it.value });
  }

  return {
    agree, disagree, missing_on_review, extra_on_review, ambiguous,
    counts: { claimed, agree: agree.length, disagree: disagree.length, missing_on_review: missing_on_review.length,
              extra_on_review: extra_on_review.length, ambiguous: ambiguous.length, skipped, placeholders },
  };
}

// ── Onboarding stage (JD → Apply → Apply Manually → auth → verify) helpers ────
// The pre-form flow that runs BEFORE the fill walk. These are the PURE, testable
// decisions; the DOM driving lives in the SW (background.js runCdpOnboard) over the
// cdp.js primitives. Ported from the Playwright repo's applypilot/ats/workday.py —
// same behavior, extension substrate.

// The Apply-button chain (workday.py _APPLY_BUTTON_CHAIN): matched by
// data-automation-id ONLY because the tag varies per tenant (an <a role=button> on
// some, a <button> on others). Tried in order; FIRST present wins. `applyManually`
// is included as the last rung — on tenants that surface the manual choice on the
// listing itself, clicking it here is correct and the modal step then no-ops.
const APPLY_BUTTON_CHAIN = [
  { sel: '[data-automation-id="adventureButton"]', label: "Apply (job listing)" },
  { sel: '[data-automation-id="continueButton"]', label: "Continue Application (returning user)" },
  { sel: '[data-automation-id="applyManually"]', label: "Apply Manually" }
];
// NEVER click these (workday.py _REJECT_SELECTORS): reusing a prior application is
// the wrong path — we always want a fresh manual fill.
const APPLY_REJECT = [{ sel: '[data-automation-id="useMyLastApplication"]', label: "Use My Last Application" }];
// Given the set of automation-id selectors PRESENT on the page, pick the first
// chain entry to click (or null). Pure so the priority is unit-pinned.
function pickApplyTarget(presentSelectors) {
  const present = new Set(presentSelectors || []);
  for (const c of APPLY_BUTTON_CHAIN) if (present.has(c.sel)) return c;
  return null;
}

// Sign-in outcome classifier (workday.py _classify_sign_in_outcome). After submitting
// the sign-in form, read the page's body text + form state and decide:
//   "verify"           → Workday sent a verification email (→ the Gmail flow)
//   "wrong_credentials"→ the account doesn't exist / creds rejected (→ create account)
//   "success"          → a real Workday form widget is present AND no auth element
//                        (the content-not-chrome gate — a progressBar/URL is NOT trusted)
//   "unknown"          → none of the above (caller re-checks after a wait, else halts)
// PRECEDENCE verify > wrong > success: the message text is decisive; success is the
// fallback only when the page shows neither message and a genuine form has rendered.
// `hasAuthEl` = any password field / sign-in|create submit / sign-in|create link is
// still present (so a lingering auth screen is never mistaken for the form).
const ONBOARD_VERIFY_RX = /email has been sent|verify your (account|email|identity)|check your (email|inbox)|verification (email|link|code)|we('| ?ha)?ve sent (you )?an? (email|verification)|confirm your email/i;
const ONBOARD_WRONG_RX = /(wrong|incorrect|invalid) (email|e-?mail|password|user\s?name|login|credentials)|(email|e-?mail|user\s?name|password)[^.\n]{0,40}\b(incorrect|invalid|is not correct|do(es)? not match)|account (might be|is) locked|couldn'?t find (an )?account|no account (was )?(found|exists)|does not match our records/i;
function classifyAuthOutcome(state) {
  const s = state || {};
  const t = String(s.bodyText || "");
  if (ONBOARD_VERIFY_RX.test(t)) return "verify";
  if (ONBOARD_WRONG_RX.test(t)) return "wrong_credentials";
  if ((s.formFieldCount || 0) > 0 && !s.hasAuthEl) return "success";
  return "unknown";
}

// Workday's transient soft-error page ("Something went wrong / Please refresh the
// page and then try again."). The fix is a ONE-SHOT page reload then retry (the
// reference's handle_auth_screen `refreshed` guard). Require BOTH the apology AND a
// refresh/try-again cue so an ordinary field-validation "something's wrong" banner
// can't trigger a needless reload. (workday.py _is_workday_error_page.)
function isWorkdaySoftError(bodyText) {
  const t = String(bodyText || "");
  return /something went wrong|an? (unexpected )?error (has )?occurred|we('| ?a)?re sorry/i.test(t)
    && /refresh (the|this) page|please refresh|try again/i.test(t);
}

// SSO / federated-login detection. The reference REFUSES SSO (a Workday tenant that
// bounces to Okta/Ping/Azure/etc can't be driven with an email+password) — so we halt
// for operator takeover rather than fumble. Two signals: an SSO-looking URL, or an
// auth screen that shows a sign-in button but NO email/password field (a "Sign in with
// …" redirect button). NOTE: a plain Workday login URL contains "login"/"signin" — that
// is NOT SSO, so this uses a NARROW url pattern (idp/saml/okta/…), not the broad authUrl.
function looksLikeSso(state) {
  const s = state || {};
  // A native "Sign in with email" button means Workday offers an email/password path (a
  // social-login CHOOSER, e.g. Palo Alto Networks) — NOT a forced SSO redirect. Reveal it, don't halt.
  if (s.signInWithEmail) return false;
  const ssoUrl = /\bsso\b|[?&/](saml|idp|oidc|federation)\b|okta|pingidentity|pingone|onelogin|microsoftonline|\badfs\b|auth0|login\.gov/i.test(String(s.url || ""));
  if (ssoUrl) return true;
  // A sign-in button with NO email/password field AND no email-chooser button = a bare
  // "Sign in with <provider>" redirect → SSO.
  if (s.signInButtonPresent && !s.passwordInput && !s.emailInput) return true;
  return false;
}

// UMD-lite: export for the Node test runner; in the SW `module` is undefined so the
// functions simply stay globals (from importScripts).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { parseYearMonth, parseYearMonthDay, parseRepeatingFkit, parseNestedFkit, meaningfulEntries, meaningfulWorkExperience, sortWorkExperienceByRecency, workExperienceRecency, parseYear, joinBullets, ensureHttps, isFluent, normalize, fuzzyRatio, matchCandidates, sessionLooksDead, isWorkdayMaintenance, cdpPageKey, AI_NEEDS_ANSWER_MARK, isAiPlaceholder, unreplacedPlaceholders, parseErrorFieldName, errorSetUnchanged, normalizeLabel, mappedFieldsFromErrors, expandErrorSamples, isDuplicateLanguageError, languageEntriesFromResults, languageDeletionPlan, isDuplicateWebsiteError, websiteEntriesFromResults, websiteDeletionPlan, canonicalJobUrl, reconcileReviewPage, APPLY_BUTTON_CHAIN, APPLY_REJECT, pickApplyTarget, classifyAuthOutcome, ONBOARD_VERIFY_RX, ONBOARD_WRONG_RX, isWorkdaySoftError, looksLikeSso };
}
