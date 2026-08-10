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

// Canonicalize a website URL to the FULL link the operator wants stored and filled (2026-07-26):
// a scheme, AND "www." on a bare apex host — "linkedin.com/in/x" → "https://www.linkedin.com/in/x".
//
// WHY www: a form's URL field (and the site itself) canonicalizes to the www host, so a stored bare
// host doesn't match what the page ends up holding. That mismatch is not cosmetic — it fails EVERY
// equality tier we have (exact, containment [www. is inserted mid-string, so neither side contains
// the other], and fuzzy, which lands at 89 vs the 90 bar), which flags the M40 audit and makes
// submitPrecondition BLOCK the submit on a review-page DISAGREE. Storing the canonical form is what
// keeps all three copies — profile, page, bundle — byte-identical.
//
// www is added ONLY to a bare apex host, because it is WRONG anywhere else: "blog.example.com" has no
// "www.blog.example.com", and neither does most personal-domain hosting. So a host that already
// carries ANY subdomain (including "www.") is returned untouched, as are IP/userinfo hosts. An apex is
// 2 labels ("linkedin.com"), or 3 whose last two are a public multi-part suffix ("example.co.uk").
// Pure → unit-tested. LOCKSTEP with the website's ensureHttpsUrl (web/lib/profile-schema.ts): both
// must produce the SAME string, or the synced profile and the filled value drift apart again.
const APEX_MULTIPART_TLD = /^(co|com|net|org|edu|gov|ac|gob|mil)\.[a-z]{2}$/i;
function ensureHttps(url) {
  const t = String(url == null ? "" : url).trim();
  if (!t) return "";
  const withScheme = /^https?:\/\//i.test(t) ? t : "https://" + t;
  try {
    const u = new URL(withScheme);
    if (u.username || u.password) return withScheme;                 // user:pass@host — the splice below can't be trusted
    const host = u.hostname;
    if (!host || /^[\d.]+$/.test(host) || host.indexOf(":") !== -1) return withScheme; // IPv4/IPv6 → never www
    const labels = host.split(".");
    const isApex =
      labels.length === 2 ||
      (labels.length === 3 && APEX_MULTIPART_TLD.test(labels.slice(-2).join(".")));
    if (!isApex) return withScheme;                                  // already subdomained (incl. www.) → leave alone
    // Splice "www." after the scheme rather than rebuilding via URL.toString(), which would also
    // normalize the rest (e.g. appending a trailing "/" to a path-less URL) — we change the host only.
    const m = /^(https?:\/\/)([\s\S]*)$/i.exec(withScheme);
    return m ? m[1] + "www." + m[2] : withScheme;
  } catch (e) {
    return withScheme; // unparseable → still better than a scheme-less value; never throws
  }
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
// A dropdown PLACEHOLDER row ("Select One", "-- Please select --", "Choose...") is a prompt, not an
// answer. Workday usually marks it aria-disabled and the option readers already drop those — but not
// always: Waystar's is a plain enabled option, so it reached the AI as a legitimate choice and the AI
// picked it, committing a value Workday then rejected as empty (live 2026-08-02). Recognised by TEXT,
// which is generic across tenants and ATSs — no page-specific selector.
//
// Deliberately NARROW. It matches the fixed prompt vocabulary (select / choose / pick / please select)
// and pure punctuation, and ONLY when the text carries no answer content of its own: "Select One" is a
// placeholder, "Select all that apply to you" is a real option and must not be eaten. The failure
// direction matters — a missed placeholder costs one flagged review row, while eating a real option
// would silently remove a valid answer from the AI's list.
const PLACEHOLDER_OPTION_RE = /^(?:[-–—_.*\s]*)(?:(?:please\s+)?(?:select|choose|pick)(?:\s+(?:an?|one|any|option|value|item))?|none\s+selected|no\s+selection|make\s+a\s+selection)(?:\s*(?:one|option|value|item))?(?:[-–—_.*\s]*)$/i;
function isPlaceholderOption(text) {
  const t = String(text == null ? "" : text).replace(/\u00a0/g, " ").trim();
  if (!t) return true;                                   // an empty row is never an answer
  if (/^[-–—_.*\s]+$/.test(t)) return true;               // pure punctuation separators
  return PLACEHOLDER_OPTION_RE.test(t);
}
// Strip placeholders from a list of option texts. Used on the AI's CHOICE list only — the human's
// review list keeps every row the form renders, so the editor still shows the form as it is.
function withoutPlaceholderOptions(texts) {
  const keep = (Array.isArray(texts) ? texts : []).filter((t) => !isPlaceholderOption(t));
  return keep.length ? keep : (Array.isArray(texts) ? texts.slice() : []); // never hand back an EMPTY list
}
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

// Is this candidate a bare YES/NO answer? Only these earn the polarity-lead tier — see matchCandidates.
// Kept deliberately tiny: "yes"/"no" and the booleans resolve() coerces them from. Anything with more
// words is a real value, not a polarity, and must go through the ordinary tiers.
const POLARITY_TOKENS = { yes: "yes", no: "no", true: "yes", false: "no" };
function isPolarityToken(s) {
  return Object.prototype.hasOwnProperty.call(POLARITY_TOKENS, String(s == null ? "" : s).trim().toLowerCase());
}
// Index of the ONE option that leads with this polarity, or -1 when none or several do. Word-anchored so
// "No" cannot lead-match "November", and ambiguity-refusing so a tenant that splits a polarity into two
// different meanings escalates instead of being guessed at.
function polarityLeadIndex(optionTexts, cand) {
  const want = POLARITY_TOKENS[String(cand == null ? "" : cand).trim().toLowerCase()];
  if (!want) return -1;
  const re = new RegExp("^" + want + "\\b", "i");
  const hits = [];
  (optionTexts || []).forEach((t, i) => { if (re.test(String(t == null ? "" : t).trim())) hits.push(i); });
  return hits.length === 1 ? hits[0] : -1;
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
  // Tier 1.5: POLARITY LEAD (operator, 2026-08-09). For a YES/NO question the polarity token IS the whole
  // answer — everything after it is the tenant's own phrasing, not something we are inferring. Operator:
  // "if the answer begins with the answer I have in my ladder, it is correct... it doesn't matter how it
  // elaborates if it begins with no and that is my answer." So a stored "No" fills
  // "No, I do not require sponsorship" DETERMINISTICALLY — no review, no teach.
  //
  // This is NOT the containment tier and is deliberately far narrower, because containment is a guess and
  // this is not. Three limits, and each one is load-bearing:
  //   1. The CANDIDATE must be a bare polarity token. Allowing any string would let "Bachelor" claim
  //      "Bachelor of Science in …", which is exactly the guess the containment rule exists to refuse.
  //   2. The match is ANCHORED at the start on a WORD boundary (^no\b) — "No" must not hit "November".
  //   3. EXACTLY ONE option may lead with it. The dangerous shape is a tenant splitting one polarity into
  //      two meanings — "No, I do not now or in the future require sponsorship" vs "No, I do not now, BUT
  //      WILL in the future" — which lead identically and mean opposite things. 0 or 2+ ⇒ fall through and
  //      let the ladder escalate to review. That guard is what makes the rest safe.
  for (const cand of candidates) {
    if (!isPolarityToken(cand)) continue;
    const hit = polarityLeadIndex(optionTexts, cand);
    if (hit !== -1) return { targetIndex: hit, matchTier: "polarity-lead", matchedCandidate: cand };
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
// `pageOrdinal` = the walk's 1..N page number, used ONLY when the flat field set is EMPTY.
//
// A page with no flat fields has NO identity in this scheme, and the pathname alone is shared by the
// whole apply flow — so EVERY field-less page in a run produces the byte-identical key `<path>|`.
// `accumulateBundle` treats identical keys as the same physical page and DROPS the prior entries, and
// `samePhysicalPage` refuses to match a field-less key to anything but itself, so such a page can also
// never be matched on a replay.
//
// Live on kiongroup.wd3 (2026-08-09), which cost a whole page of the application: My Experience is
// legitimately field-less (every field sits inside a repeating section, which the flat loop skips) and
// My Information scanned field-less only because the key was computed before its fields had mounted.
// Both keyed `<path>|`, My Experience overwrote My Information, and the bundle went to review missing
// name/address/country/source entirely — 4 pages recorded for 5 filled. The rehearsal then halted
// `replay-page-not-in-bundle` on live page 1, which is the only reason anyone found out.
//
// The ordinal is stable across re-runs (same walk, same page order, and a soft-error reload restarts
// at page 1 and re-walks identically), so it keys a field-less page uniquely without breaking the
// re-fill overwrite: `<path>|#2` overlaps itself and nothing else, which is exactly the behaviour
// samePhysicalPage wants. A single-page fill passes no ordinal and cannot collide with anything.
function cdpPageKey(scan, pageOrdinal) {
  if (!scan || !Array.isArray(scan.fields)) return null;
  let path = scan.url || "";
  try { path = new URL(scan.url).pathname; } catch (e) { /* non-URL → keep raw (still stable) */ }
  const fieldSet = scan.fields.map((f) => f.fieldName).sort().join(",");
  if (!fieldSet) return path + "|#" + (pageOrdinal != null ? pageOrdinal : "1");
  return path + "|" + fieldSet;
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
// An `ai-text-needs-answer` field is unreplaced while it still holds what the fill put there.
// It used to be a bracketed marker, which read as machine junk on an employer's form and — worse
// — Workday REJECTED it in a constrained field, so Save & Continue blocked and the walk halted
// short of review (live 2026-08-02, two tenants, a required "desired Annual Salary"). The value
// written is now plain "N/A" (operator 2026-07-31: "never answer with AI declined, N/A would be
// better"), so the HARD BLOCK can no longer key on the text alone: it keys on the FLAG plus the
// value still being untouched. A human who edits it to anything else clears the block, exactly as
// replacing the old marker did.
function unreplacedPlaceholders(entries) {
  const untouchedNA = (v) => String(v == null ? "" : v).trim().toUpperCase().replace(/[./\s]/g, "") === "NA";
  // A NUMERIC-only field rejects "N/A", so the fill falls back to "0" to get the page past Workday's
  // required check and reach review (operator 2026-08-03: "nothing should halt"). That makes "0" a
  // placeholder exactly like "N/A", and it MUST block submit for the same reason: nobody's salary
  // expectation is zero, and filing it would state one they never gave. Only counts when the entry
  // still carries the needs-answer flag — a human who types 0 deliberately has edited the field, which
  // clears the flag through the normal edit path.
  const untouchedZero = (v) => /^[0\s.,$]*0[0\s.,$]*$/.test(String(v == null ? "" : v).trim()) && /0/.test(String(v));
  return (entries || []).filter((e) => e && e.flag === "ai-text-needs-answer" &&
    (isAiPlaceholder(e.current_value) || untouchedNA(e.current_value) || untouchedZero(e.current_value)));
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
  // SPECIFIC WORDINGS FIRST, because the generic pattern below is non-greedy and a question label
  // very often contains one of its own stop-words. Live (Copart 2026-08-03): "The field What is your
  // anticipated graduation month and year (MM/YYYY) is required..." parsed as **"What"** — the match
  // ended at the label's OWN "is". Every "What is your …" question — desired compensation, desired
  // start date, anticipated graduation — hit this, and a truncated name matches no wrapper, so Tier-1
  // deterministic remediation, the phantom-required guard and the field diagnosis were all handed a
  // useless name and silently did nothing. Anchoring on the full trailing PHRASE fixes it: "What" is
  // no longer a candidate because "What is required" never appears.
  const anchored = [
    /\bfield\s+(.+?)\s+is\s+required\b/i,
    /\bfield\s+(.+?)\s+must\s+have\s+a\s+value\b/i,
    /\bfield\s+(.+?)\s+is\s+not\s+valid\b/i,
  ];
  for (const re of anchored) {
    m = s.match(re);
    if (m && m[1].trim()) return m[1].trim().replace(/^["'<\s]+|["'>:\s]+$/g, "") || null;
  }
  // Generic fallback for wordings we have not seen. Still non-greedy, so it can still truncate a
  // label containing a stop-word — it only runs when none of the known phrasings matched.
  m = s.match(/\bfield\s+(.+?)\s+(is|are|must|cannot|can't|should|requires?|needs?)\b/i);
  if (m && m[1].trim()) return m[1].trim().replace(/^["'<\s]+|["'>:\s]+$/g, "") || null;
  return null;
}

// AI-4 NO-PROGRESS guard: did a remediation attempt change the error set at all? Compares two
// arrays of error texts as normalized SETS (trim, drop empties, sort). UNCHANGED (true) ⇒ the
// action didn't resolve anything → HALT rather than burn the cap re-firing the same fix.
// A value the FORM REJECTED is not a filled field (2026-08-03).
//
// Live on Copart: a required free-text compensation question got the "N/A" placeholder, the write
// verified, the M40 audit re-read it and matched — and Save & Continue answered "is required and must
// have a value" with the box empty in DOM, reactProps and fiber alike. Workday discarded it during
// validation. Every check we have runs BEFORE that point, so nothing noticed, and the bundle kept
// claiming "N/A". That is the worst shape for a review bundle: the human approves a value that is not
// on the form, the replay re-enters the same rejected text, and the page fails again — a loop the
// operator cannot break from the review editor.
//
// So: after a blocked Save, for each field the ERROR NAMES, compare what we recorded against what the
// page now holds. Recorded a value + page holds nothing ⇒ rewrite the record as EMPTY and needs_review,
// naming the value that was rejected. `bundleSubmitBlockers`'s required-blank rule then refuses submit
// until a human answers it for real.
//
// NARROW on purpose — it only touches fields the error text names AND that read empty on a live scan.
// A field the form merely dislikes for another reason keeps its value, because overwriting a real
// answer with "" would destroy the human's data to fix a display problem. `liveFields` comes from a
// fresh cdpPageScan; an empty/failed scan changes nothing (absence of evidence).
function rejectedValueEntries(entries, liveFields, errorTexts) {
  const list = Array.isArray(entries) ? entries : [];
  const live = Array.isArray(liveFields) ? liveFields : [];
  const out = { entries: list, changed: [], notes: [] };
  const titles = (Array.isArray(errorTexts) ? errorTexts : [])
    .map((t) => parseErrorFieldName(t)).filter(Boolean);
  if (!titles.length) return out;
  if (!live.length) { out.notes.push("no live field scan — cannot tell what the page kept"); return out; }
  const holds = (v) => v != null && String(v).trim() !== "";
  // An entry's field_id is "<page>::formField-<fieldName>", so the live scan's fieldName identifies it
  // independently of the LABEL — which is the fragile key here, since the wrapper's text now also
  // carries Workday's inline error.
  const nameOf = (e) => String((e && e.field_id) || "").split("formField-").pop() || "";
  const byName = new Map(), changedIdx = new Map();
  list.forEach((e, i) => { const n = nameOf(e); if (n) byName.set(n, i); });
  for (const title of titles) {
    const want = normalizeLabel(title);
    // Exact, then fieldName, then a UNIQUE prefix. The prefix tier is the one that matters after a
    // blocked save: Workday renders its message INSIDE the field wrapper, so the scan's label becomes
    // "What is your desired compensation *Error: The field ... is required and must have a value." and
    // no longer equals the title parsed out of that very error. It is a prefix, though, because the
    // message is appended. Ambiguity refuses rather than guesses — two fields sharing a prefix means we
    // cannot tell which one the error is about, and blanking the wrong field destroys an answer.
    let f = live.find((x) => normalizeLabel((x && x.label) || "") === want)
      || live.find((x) => normalizeLabel((x && x.fieldName) || "") === want);
    if (!f) {
      const pre = live.filter((x) => normalizeLabel((x && x.label) || "").indexOf(want) === 0);
      if (pre.length === 1) f = pre[0];
      else if (pre.length > 1) { out.notes.push(`"${title}" prefixes ${pre.length} fields on the page — too ambiguous to act on`); continue; }
    }
    if (!f) { out.notes.push(`"${title}" is not in the live scan — cannot check what the page kept`); continue; }
    if (holds(f.value)) { out.notes.push(`"${title}" still holds ${JSON.stringify(String(f.value))} on the page — left alone`); continue; }
    let idx = f.fieldName != null && byName.has(f.fieldName) ? byName.get(f.fieldName) : -1;
    if (idx === -1) idx = list.findIndex((e) => e && normalizeLabel(e.question_label || "") === want);
    if (idx === -1) { out.notes.push(`"${title}" is empty on the page but no bundle entry matches it`); continue; }
    const e = list[idx];
    if (!holds(e.current_value)) continue;                       // already honest — nothing to correct
    changedIdx.set(idx, String(e.current_value));
  }
  if (!changedIdx.size) return out;
  out.entries = list.map((e, i) => {
    if (!changedIdx.has(i)) return e;
    const was = changedIdx.get(i);
    out.changed.push({ label: e.question_label || nameOf(e), was });
    return Object.assign({}, e, {
      current_value: "",
      fill_status: "not_filled",
      is_approved: false,                                         // an approval of the old value cannot carry
      approved_at: null,
      needs_review: true,
      needs_review_reason: "value_rejected",
      flag: "value-rejected",
      detail: "The form REJECTED " + JSON.stringify(was) + " — it was entered and read back, but the page "
        + "cleared it and reported the field as required. Please give an answer this form will accept.",
    });
  });
  return out;
}
// A checkbox GROUP holds a SET, not a value (2026-08-03).
//
// Traced live on PSECU's `ethnicityMulti`: checking "White" while "Asian" was checked left BOTH on,
// and both survived Save & Continue. Its label says "the ethnicity (or ethnicities)" and Workday
// means it. Caterpillar's OFCCP disability group is the other shape — genuinely pick-one — so the
// code cannot assume either; it has to carry whatever the human chose and reproduce exactly that.
//
// The bundle keeps `current_value` as the JOINED display string, so every existing consumer (blank
// tests, the submit gate, the audit's readable form) keeps working untouched, and adds
// `selected_options` as the authoritative array. An older bundle has no array — its single
// current_value is then the set, which is exactly what it meant.
const GROUP_JOIN = "; ";
function groupSelection(entry) {
  if (!entry) return [];
  if (Array.isArray(entry.selected_options)) return entry.selected_options.map((s) => String(s)).filter((s) => s.trim() !== "");
  // No array ⇒ a bundle written before selected_options existed. Its current_value is the only record
  // of the set, so it has to be split back apart — which is exactly why the array exists: splitting is
  // only sound while no option label contains the separator, and going forward nothing depends on it.
  // (Must match the web copy in review-approval.ts, which splits here too.)
  return splitGroupValue(entry.current_value);
}
// Join a selection for display / storage in current_value. Order is preserved — it is the order the
// options appear in on the form, which is the order a human reading the review expects.
function joinGroupValue(labels) {
  return (Array.isArray(labels) ? labels : []).map((s) => String(s)).filter((s) => s.trim() !== "").join(GROUP_JOIN);
}
// The inverse: a set that arrives as the joined STRING (an older bundle, or current_value) or already
// as an array. Kept beside joinGroupValue so the two can never disagree about the separator.
function splitGroupValue(v) {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter((x) => x.trim() !== "");
  const s = String(v == null ? "" : v);
  return s.trim() === "" ? [] : s.split(GROUP_JOIN).map((x) => x.trim()).filter(Boolean);
}
// ── Workday SKILLS ("Type to Add Skills") ────────────────────────────────────
// A MULTI-VALUE typeahead over Workday's OWN skill taxonomy. Traced live on cat.wd5 2026-08-07
// (docs/dom-patterns.md). Two OBSERVED facts drive every helper here:
//
//  1. The taxonomy RENAMES. "Python" is offered only as "Python (Programming Language)" — there is
//     no bare "Python" row — while "Docker" is offered as BOTH "Docker" and "Docker (Software)".
//     So a plain exact match finds nothing for most skills, and that trailing parenthetical is a
//     QUALIFIER Workday added, the same shape normalize() already strips off a dial code "(+1)".
//
//  2. The search is SERVER-SIDE FUZZY and answers almost anything. "Yosys" → "Yodiz" + "GoSystem
//     Tax RS"; "ODrive" → "Top Drive" + "Optical Disk Drives"; even "zzqqxwvj" returns rows. The
//     server has ALREADY fuzzed, badly — so containment, Levenshtein and "take the first row" are
//     not weak tiers here, they are wrong answers waiting to be committed. Only an exact name
//     (bare or qualified) may be committed; anything else is left for the human to add by hand.
const SKILL_QUALIFIER_RE = /\s*\([^()]*\)\s*$/; // ONE trailing "(...)" — never a mid-string paren

// Workday annotates a chip the RÉSUMÉ PARSE contributed as "Digital Systems (Suggested)" (traced live
// 2026-08-07 on the Autofill-with-Resume flow). That suffix is UI provenance, not part of the skill's
// name — Workday's own review page prints the bare name — so it is stripped before a chip is recorded,
// deduped or replayed. Without this the bundle stores a value the review page never shows, and the
// reconcile reports a correctly-filled skill as missing. Only this exact marker is removed; a real
// qualifier like "(Programming Language)" is part of the name and stays.
function skillChipName(s) {
  return String(s == null ? "" : s).replace(/\s*\((?:suggested|recommended)\)\s*$/i, "").trim();
}

// "Python (Programming Language)" → "python". A name that is NOTHING but a parenthetical is kept
// whole, so a degenerate option can't collapse to "" and match everything.
function skillBaseName(s) {
  const full = normalize(String(s == null ? "" : s));
  const bare = full.replace(SKILL_QUALIFIER_RE, "").trim();
  return bare || full;
}

// Match ONE profile skill against the live search results → { index, tier } (index -1 = commit
// NOTHING). Two tiers, and deliberately no containment and no fuzzy tier (fact 2 above):
//   • "exact"     — the option IS the skill               ("Docker" → "Docker")
//   • "qualified" — the skill plus Workday's parenthetical ("Python" → "Python (Programming Language)")
// A bare exact WINS, so "Docker" never resolves to "Docker (Software)" while the plain row is on
// offer. Both tiers are AMBIGUITY-GUARDED: if two rows match, we cannot tell which the human meant
// (e.g. "Python (Programming Language)" vs a hypothetical "Python (Snake)"), so we commit nothing.
function matchSkillOption(skill, optionTexts) {
  const opts = Array.isArray(optionTexts) ? optionTexts.map((t) => String(t == null ? "" : t)) : [];
  const want = normalize(String(skill == null ? "" : skill));
  if (!want || !opts.length) return { index: -1, tier: null };
  const hits = (fn) => { const out = []; opts.forEach((t, i) => { if (fn(t)) out.push(i); }); return out; };
  const exact = hits((t) => normalize(t) === want);
  if (exact.length === 1) return { index: exact[0], tier: "exact" };
  if (exact.length > 1) return { index: -1, tier: null, ambiguous: "exact" };
  const wantBase = skillBaseName(want);
  const qualified = hits((t) => skillBaseName(t) === wantBase);
  if (qualified.length === 1) return { index: qualified[0], tier: "qualified" };
  if (qualified.length > 1) return { index: -1, tier: null, ambiguous: "qualified" };
  // TIER 3 — CONTAINMENT, an OPERATOR-AUTHORIZED exception to the standing "containment is a guess"
  // rule (2026-08-07), so a skill Workday only lists under a broader name still lands: "Vivado" →
  // "Xilinx Vivado". It is the LAST tier, it is ambiguity-guarded, and every commit through it is
  // flagged for review — the operator sees exactly what was widened.
  //
  // WHOLE-WORD, not raw substring, and that is the load-bearing part. Plain `includes` on this
  // vocabulary is actively wrong: "Git" is inside "Di**git**al" and "CAN" is inside "**Can**adian",
  // so a raw substring tier would put a marketing skill on an embedded engineer's application.
  if (!skillContainmentEligible(want)) return { index: -1, tier: null };
  const contained = hits((t) => skillWholeWordIn(normalize(t), want));
  if (contained.length === 1) return { index: contained[0], tier: "containment" };
  if (contained.length > 1) {
    // SEVERAL broader rows contain the skill. Refusing here is what kept "Vivado" off the form — live,
    // Workday offered more than one row containing it. The tie is broken on WORKDAY'S OWN RANKING (its
    // first result for that query), the same "pick the first" rule the exact tier and clickHierLeaf
    // already use, rather than on a preference of ours about which product name is the "real" one. The
    // alternatives ride along so the review names what else was on offer and the human can switch.
    return { index: contained[0], tier: "containment",
             alternatives: contained.slice(1).map((i) => opts[i]) };
  }
  return { index: -1, tier: null };
}

// Split a normalized skill into tokens, keeping the characters real skill names carry (+ # .) so
// "c++", "c#" and "node.js" stay single tokens instead of dissolving.
function skillTokens(s) {
  return String(s == null ? "" : s).split(/[^a-z0-9+#.]+/).filter(Boolean);
}

// May this skill be matched by CONTAINMENT at all? A DISTINCTIVENESS gate, modelled on the
// employer-match scan's rule (multi-word, or a lone word long enough to be unambiguous). A short lone
// token is exactly where containment goes wrong — "CAN" (the bus) against "Canadian Payroll", "rqt",
// "C++" — so those stay exact/qualified-only. "Vivado" (6) and "PCB design" (2 words) pass.
const SKILL_CONTAINMENT_MIN_LONE = 5;
function skillContainmentEligible(skill) {
  const t = skillTokens(normalize(String(skill == null ? "" : skill)));
  if (!t.length) return false;
  return t.length >= 2 || t[0].length >= SKILL_CONTAINMENT_MIN_LONE;
}

// Does `needle` appear in `haystack` as a whole word / contiguous word sequence? Both are expected
// normalized. Boundaries are non-alphanumeric (or the string ends), which is what separates
// "vivado" ⊂ "xilinx vivado" (a real match) from "git" ⊂ "digital" (not one).
function skillWholeWordIn(haystack, needle) {
  const h = String(haystack == null ? "" : haystack), n = String(needle == null ? "" : needle);
  if (!h || !n) return false;
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("(^|[^a-z0-9])" + esc + "([^a-z0-9]|$)").test(h);
}

// The SHARED core of the skills detector. The fill path recognises a live SCAN field and the
// reconcile recognises a bundle ENTRY; routing both through this one predicate is what stops them
// drifting into disagreeing about which field this even is. Deliberately anchored, never a bare
// /skill/ test — a language-proficiency field and a prose "Skills" box must not match.
function isSkillsFieldName(name, label) {
  if (/(^|[-_])skills$/i.test(String(name == null ? "" : name))) return true;
  const l = String(label == null ? "" : label).replace(/\*+\s*$/, "").trim();
  return /^(type to add\s+)?skills$/i.test(l);
}

// A review-bundle entry for the skills field. `field_id` is "<page>::formField-<name>".
function isSkillsEntry(entry) {
  if (!entry) return false;
  const wt = String(entry.widget_type || "");
  if (wt !== "typeahead" && wt !== "hierarchical") return false;
  let s = String(entry.field_id == null ? "" : entry.field_id);
  const i = s.lastIndexOf("formField-");
  if (i !== -1) s = s.slice(i + "formField-".length);
  return isSkillsFieldName(s, entry.question_label);
}

// Which of `wanted` are not already on the widget, in profile order. Compared on the BASE name in
// both directions, because a chip Workday created reads back QUALIFIED: a "Python (Programming
// Language)" chip already covers the profile's "Python". Without that, a second pass would search
// "Python" again, find the bare row GONE (Workday drops an already-selected skill from its own
// results — observed), and commit "Python IDLE" as a near-duplicate. Also dedupes `wanted` against
// itself, so a profile listing a skill twice can't add it twice.
function missingSkills(wanted, chips) {
  const chipList = (Array.isArray(chips) ? chips : []).map((c) => normalize(String(c == null ? "" : c))).filter(Boolean);
  const have = new Set(chipList.map(skillBaseName).filter(Boolean));
  const out = [];
  for (const raw of (Array.isArray(wanted) ? wanted : [])) {
    const s = String(raw == null ? "" : raw).trim();
    if (!s) continue;
    const base = skillBaseName(s);
    if (!base || have.has(base)) continue;
    // A chip committed through the CONTAINMENT tier reads back BROADER than the profile name
    // ("Vivado" landed as "Xilinx Vivado"), so a base-name comparison alone would call it missing and
    // search again — and Workday drops the selected row from its own results, so the next containment
    // hit would be a DIFFERENT variant ("Vivado HLS") added alongside. Same whole-word + eligibility
    // rule as the matcher, so a "Digital Marketing" chip never counts as covering "Git".
    if (skillContainmentEligible(base) && chipList.some((c) => skillWholeWordIn(c, base))) continue;
    have.add(base);
    out.push(s);
  }
  return out;
}

// A checkbox GROUP's recorded value is a JOINED set ("Asian; White"), and Workday's review page
// prints the options separately — so looking for the joined string finds nothing and a correct
// two-answer field reads as MISSING. Expand a group entry into its individual values before matching.
function reviewValuesOf(entry) {
  if (entry && entry.widget_type === "checkbox_group") {
    const sel = groupSelection(entry);
    if (sel.length) return sel;
  }
  const v = entry && entry.current_value;
  return v == null || String(v).trim() === "" ? [] : [String(v)];
}
// A COMPENSATION question — the one required free-text field the profile routinely cannot answer
// (live: Copart "What is your desired compensation?", clearesult "What is your salary expectation").
// Recognised by wording so the AI can be asked for a market-rate ESTIMATE instead of declining and
// stranding the page. Requires a money word AND an asking word, so "salary history" or a benefits
// blurb does not match — a wrong hit here would put a number in a box that wanted something else.
const COMP_MONEY_RE = /\b(salary|compensation|pay|wage|rate|remuneration)\b/i;
const COMP_ASK_RE = /\b(expect\w*|desired|desire|require\w*|request\w*|seeking|sought|target|preferred|asking|minimum|range|what is your|how much)\b/i;
function isCompensationQuestion(label) {
  const t = String(label == null ? "" : label).replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (/\bhistory\b/i.test(t)) return false;          // "salary history" is a different (often illegal) ask
  return COMP_MONEY_RE.test(t) && COMP_ASK_RE.test(t);
}
// A SIGNATURE / completion date — the day the form is being filled in, which is always TODAY.
//
// Workday's voluntary self-identification pages (disability, veteran) carry a bare "Date" beside the
// attestation, and a few tenants spell it out ("Today's Date", "Date Signed"). It is not a fact to
// look up or a preference to guess: the applicant is completing the form now. Live on Asuep the AI
// guessed 8/10/2026 — a FUTURE date on a form being attested to today (operator 2026-08-04).
//
// Deliberately narrow. A bare "date" matches, and the explicit signature wordings match, but anything
// that names a DIFFERENT event does not — start date, birth date, graduation, expiry, from/to. Those
// are real questions with real answers, and quietly stamping today on one would be a wrong answer
// rather than a missing one.
const SIG_DATE_RE = /^(?:today'?s?\s+)?date(?:\s*(?:signed|of\s+signature|completed|of\s+completion))?$/i;
const SIG_DATE_EXPLICIT_RE = /\b(date\s+signed|signature\s+date|date\s+of\s+signature|today'?s\s+date|date\s+completed|date\s+of\s+completion)\b/i;
const SIG_DATE_OTHER_EVENT_RE = /\b(start|begin|available|birth|dob|graduat|expir|issue|hire|end|from|to|employ|last|next)\b/i;
function isSignatureDateQuestion(label) {
  const t = String(label == null ? "" : label).replace(/[*\s]+$/, "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (SIG_DATE_OTHER_EVENT_RE.test(t)) return false;   // names a different event — never today
  return SIG_DATE_RE.test(t) || SIG_DATE_EXPLICIT_RE.test(t);
}
// Do two strings name the SAME calendar date? Workday re-formats what we typed — it displays
// "05/01/2028" for an approved "5/1/2028" — and a plain string compare calls that a contradiction,
// which BLOCKS submit over pure zero-padding (live, Home Depot 2026-08-04).
//
// Numeric comparison on the three parts, so it accepts only re-formatting and never a different day:
// 5/1/2028 == 05/01/2028, and 5/1/2028 != 5/2/2028. Both sides must parse as a complete, plausible
// date or it returns false and the caller stays strict — an unparseable value is not evidence of
// agreement. Deliberately does NOT reorder: 1/5 and 5/1 are different dates in the same locale, and
// guessing which convention a tenant used would be exactly the kind of silent wrong answer this
// codebase refuses elsewhere.
function sameCalendarDate(a, b) {
  const parse = (v) => {
    const s = String(v == null ? "" : v).trim();
    let m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);          // M/D/YYYY
    if (m) return [+m[3], +m[1], +m[2]];
    m = s.match(/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})$/);              // YYYY-MM-DD
    if (m) return [+m[1], +m[2], +m[3]];
    m = s.match(/^(\d{1,2})[\/.-](\d{4})$/);                            // M/YYYY (month precision)
    if (m) return [+m[2], +m[1], null];
    return null;
  };
  const x = parse(a), y = parse(b);
  if (!x || !y) return false;
  if (x[1] < 1 || x[1] > 12 || y[1] < 1 || y[1] > 12) return false;
  if (x[0] !== y[0] || x[1] !== y[1]) return false;
  // One side month-precision and the other day-precision are NOT the same answer — a form showing
  // 05/2028 has not confirmed our 05/01/2028.
  return x[2] === y[2];
}
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

// ── ERROR-TEXT ↔ FIELD-LABEL matching key (2026-08-07) ──────────────────────────────────────────────
// `parseErrorFieldName` strips a trailing colon off the name it extracts (its own trailing-char class
// includes ":"), but `normalizeLabel` strips only "*" and whitespace. So for any field whose visible
// label ENDS IN A COLON the two sides can never be equal, and every strict-equality error→field matcher
// silently finds nothing:
//
//   error  "…The field Please check one of the boxes below is required" → "please check one of the boxes below"
//   label  "Please check one of the boxes below:*"                      → "please check one of the boxes below:"
//
// That one character is the whole self-ID disability blocker. Reproduced deterministically on
// analogdevices.wd1 (passed rehearsal #1, failed #2) and seen on radiancetech.wd12, itron.wd5 and
// waystar.wd1: Workday drops the disability answer when you RE-ENTER a saved application (its siblings
// on the same page keep theirs), so the replay lands on `disabilityStatus ""*` — present, required,
// empty, WITH an approved value in the bundle — and then the force-re-fill and the phantom-required
// guard both report "match no field on this page" and the run halts having done nothing.
//
// Deliberately NOT folded into normalizeLabel: that one is LOCKSTEP with the website's
// `normalizeQuestion` for answer-bucket matching, and widening it would change which taught wordings
// match on both sides. This key is only for matching Workday's own error text to a field on the page,
// where a slightly loose match is already documented as safe (re-filling an already-correct field is a
// no-op). Strips any trailing run of "*", ":", ";", ".", ",", and dashes, in any order.
function errorLabelKey(s) {
  return String(s == null ? "" : s).toLowerCase()
    .replace(/\s+/g, " ").trim()
    .replace(/[*:;.,–—-\s]+$/, "")
    .trim();
}

// Is Workday DEMANDING the signature date on this page? Returns the live field it means, or null.
//
// The replay may write exactly one value the review page did not approve — today's date — and only
// because Workday ASKED. Recognizing the ask used to be a single wording, `"Enter today's date"`.
// Live on marvell page 5 the ask reads "The field Date is required and must have a value", so nothing
// fired and the rehearsal halted `replay-blocked` on a page that was one re-type from advancing.
//
// The load-bearing detail is WHY the field is rejected, because it changes what counts as evidence.
// The trace showed the wrapper already holding the value: `Date* current value is 8/9/2026`. Workday
// re-renders the date from its saved copy but has DROPPED it server-side (the same self-ID class as
// the disability checkbox and hispanicOrLatino), so the page shows an answer the model does not have.
// The replay then does nothing at all, because `skipIfCorrect` reads the screen, sees today's date and
// takes the zero-actuation path — the value is correct in the DOM and absent where it counts.
//
// So this deliberately does NOT require the field to be blank. Blankness is the one piece of evidence
// that is guaranteed absent in the failure it exists to catch. What it requires instead:
//   • the field is a SIGNATURE-date question (isSignatureDateQuestion rejects start/birth/graduation/
//     expiry/from/to — a wrong stamp there would be a wrong answer, not a missing one), and
//   • Workday itself named it — either by spelling out the ask, or by naming that exact field in the
//     error text. We never pick a date field Workday did not complain about.
// The caller re-types with budgets that carry no `skipIfCorrect`, so the value is actuated for real
// and handed to the model, which is the whole point.
// TEXT-ONLY half of the check, so a nav-timeout with nothing to do with a date never pays for an extra
// page scan. Kept here rather than inlined at the call site because background.js reaches lib.js through
// the hand-written `apMatch` literal: every helper it calls has to be listed there, and one that is not
// throws only in the browser (Node sees all of lib.js, so the suite stays green — live 2026-08-09,
// `apMatch.parseErrorFieldName is not a function` aborted a replay that was otherwise fixed).
// Workday's own 404 for a requisition that no longer exists — the posting was filled, pulled, or the
// link went stale. Live (sonos.wd1 2026-08-09): the job URL rendered "The page you are looking for
// doesn't exist." in 132 characters. Nothing is wrong with the extension on this page, but every
// downstream stage reads it as its OWN failure: there is no Apply button to click, so the run walks
// on to the auth wait and halts `auth-form-not-rendered — the sign-in fields never appeared`, which
// sends whoever reads it hunting for a sign-in bug on a tenant that signs in fine. It cost exactly
// that detour before the page was opened by hand.
//
// Text-based on purpose: this is Workday's generic not-found shell, with no automation-id of its own
// and no posting markup to key off. Anchored on the full sentence so a job description that happens
// to contain the word "exist" can't trip it, and paired by the caller with a genuinely empty page.
const JOB_GONE_RE = /\bthe page you are looking for\s+(?:doesn'?t|does not)\s+exist\b/i;
function isJobPostingGone(bodyText) {
  return JOB_GONE_RE.test(String(bodyText == null ? "" : bodyText).replace(/\s+/g, " "));
}
function signatureDateAskInText(errorTexts) {
  return (errorTexts || []).some((t) => {
    const s = String(t == null ? "" : t);
    if (/enter\s+today'?s\s+date/i.test(s)) return true;
    const n = parseErrorFieldName(s);
    return !!(n && isSignatureDateQuestion(n));
  });
}
function signatureDateDemanded(errorTexts, liveFields) {
  const texts = (errorTexts || []).map((t) => String(t == null ? "" : t)).filter(Boolean);
  if (!texts.length) return null;
  const sigFields = (liveFields || []).filter((f) => f
    && (f.widgetType === "date" || f.widgetType === "text")
    && isSignatureDateQuestion(f.label));
  if (!sigFields.length) return null;

  // (1) EXPLICIT ask — Workday spelled out what it wants, so any signature-date field on the page is it.
  if (texts.some((t) => /enter\s+today'?s\s+date/i.test(t))) return sigFields[0];

  // (2) GENERIC ask — Workday only says a field is required. Ground it on the NAME it used.
  for (const t of texts) {
    const named = parseErrorFieldName(t);
    if (!named) continue;
    const key = errorLabelKey(named);
    if (!key) continue;
    const hit = sigFields.find((f) => errorLabelKey(f.label) === key);
    if (hit) return hit;
  }
  return null;
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

// ── SURFACES THAT IGNORE SYNTHETIC INPUT (2026-08-04) ───────────────────────────────────────────────
// Measured on waystar's Self Identify page: a HIDDEN run (which dispatches page-side synthetic events)
// failed 2/2 with Workday reporting Name and Date as required-and-empty on a page whose DOM plainly held
// both, and the SAME run passed with forceTrustedInput. A trusted re-type afterwards cleared the date but
// not the name, so patching it up after the fact is not reliable — the values have to be entered trusted
// in the first place. This is the second such surface: the AUTH form behaves identically, which is why
// onboarding has always run trusted.
//
// Detected by its OWN FIELDS, not by tenant, because the reason we care is a property of the surface
// rather than of the company. The signature block is the tell: the OFCCP disability self-ID group, its
// language selector, or the name+date signature pair.
function isSelfIdPage(scanFields) {
  const names = new Set((Array.isArray(scanFields) ? scanFields : []).map((f) => f && f.fieldName).filter(Boolean));
  if (names.has("disabilityStatus") || names.has("disabilityForm")) return true;
  return names.has("dateSignedOn") && names.has("name");
}

// ── EXTERNAL GATES: a page Workday refuses for a reason no fill can satisfy (2026-08-04) ──────────
// Live on copart.wd12 (Software Engineering Intern): five pages filled and verified, then Save &
// Continue came back "You must complete the assessment test to continue with your job application.
// Take Assessment". Nothing was wrong with the fill — Workday wants a step that happens OUTSIDE the
// application form, and a human has to take it. The walk halted, but it halted as a generic
// nav-timeout: it warned "PAGE 5 MAY NOW BE DIRTY — eyeball it" (the page is not dirty) and named
// `employeeId — no mapping` as "the likely validation cause" (it is unrelated — the error text names
// no field at all). That reads as an ApplyPilot bug and sends the operator hunting a mapping gap.
//
// DELIBERATELY NARROW. A loose matcher here is the DANGEROUS direction: labelling a genuine fill
// failure "the operator's problem" would hide a real bug behind a needs_operator halt. So each entry
// requires wording that can only mean an out-of-band step, and anything unrecognized keeps the
// existing nav-timeout path byte-for-byte.
const EXTERNAL_GATES = [
  { reason: "assessment-required",
    rx: /\b(?:complete|take|finish)\b[^.]{0,40}\bassessment\b|\bassessment\b[^.]{0,30}\b(?:required|must be completed)\b/i,
    detail: "Workday requires an assessment/test to be completed before this page will advance. That happens outside the application form — a human has to take it; the bot never will." },
];
// Returns {reason, detail, evidence} for the FIRST recognized gate, else null. Reads the split error
// samples AND the whole error-page text, because the wording has been seen in both.
function externalGateHalt(errorTexts, errorPageText) {
  const texts = (Array.isArray(errorTexts) ? errorTexts : [errorTexts])
    .concat([errorPageText])
    .map((t) => String(t == null ? "" : t))
    .filter((t) => t.trim() !== "");
  for (const t of texts) {
    for (const g of EXTERNAL_GATES) {
      if (g.rx.test(t)) return { reason: g.reason, detail: g.detail, evidence: t.slice(0, 300) };
    }
  }
  return null;
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

// ── GENERIC phantom-duplicate support: ANY repeating section (2026-07-27) ───────────────────────────
// Workday's backend sometimes APPENDS a repeating section instead of REPLACING it, so its stored copy
// holds duplicates the FORM does not show — the page is visibly clean and Save & Continue is still
// rejected. First seen on websites + languages (which have their own tuned helpers above, kept because
// they're live-verified and know their sections' value semantics); these three generalize the same
// treatment to EVERY repeating section (work experience / education / certifications / …).

// Which repeating SECTION does a "duplicate…" validation error name? Returns a PAGE_SECTIONS name, or
// null when the text isn't a duplicate error / names nothing we model. Deliberately looser than the two
// phrase-exact detectors above (Workday words these differently per section, and we only have two
// observed samples) — safe because the ACTION it authorizes is bounded (delete that section's visible
// rows) and independently verified afterwards (the rows must reappear on the review page).
const DUPLICATE_SECTION_WORDS = [
  { section: "website",        rx: /website|web\s?address|\burls?\b/i },
  { section: "language",       rx: /language/i },
  { section: "education",      rx: /education|school|degree|university/i },
  { section: "workExperience", rx: /work\s?experience|employment|employer|job\s?title/i },
  { section: "certification",  rx: /certificat|licen[cs]e/i },
];
function duplicateErrorSection(errorTexts) {
  const texts = (Array.isArray(errorTexts) ? errorTexts : [errorTexts]).map((t) => String(t == null ? "" : t));
  for (const t of texts) {
    if (!/duplicate/i.test(t)) continue;
    for (const d of DUPLICATE_SECTION_WORDS) if (d.rx.test(t)) return d.section;
  }
  return null;
}

// Entries of ANY repeating section, parsed out of a page's results (records keyed
// `<section>[i].<field>`), each carrying a composite KEY — every filled value of that row, normalized
// and order-independent — so "two identical rows" is decidable for a section whose identity isn't one
// field (a work-experience row is title+company+dates, not a single URL).
function sectionEntriesFromResults(results, section) {
  const rx = new RegExp("^" + String(section || "").replace(/[^\w]/g, "") + "\\[(\\d+)\\]\\.(\\w+)");
  const byIdx = {};
  for (const r of (Array.isArray(results) ? results : [])) {
    const m = rx.exec((r && r.fieldName) || "");
    if (!m) continue;
    const i = parseInt(m[1], 10);
    const e = (byIdx[i] = byIdx[i] || { index: i, values: {} });
    if (r.after != null && String(r.after).trim() !== "") e.values[m[2]] = String(r.after).trim();
  }
  return Object.keys(byIdx).map((k) => byIdx[k]).sort((a, b) => a.index - b.index).map((e) => {
    const keys = Object.keys(e.values).sort();
    return {
      index: e.index,
      key: keys.map((k) => k + "=" + e.values[k].toLowerCase().replace(/\/+$/, "")).join("|"),
      summary: keys.map((k) => e.values[k]).join(" · ") || "?",
    };
  });
}

// Real-vs-phantom deletion plan for ANY repeating section — the generic of website/languageDeletionPlan,
// keyed on the composite entry signature. Two rows with the SAME signature ⇒ a REAL duplicate → delete
// only the later occurrence(s). All rows distinct ⇒ Workday is complaining about a duplicate that isn't
// on the page (PHANTOM) → the whole visible section goes, which is what its backend accepts.
function sectionDeletionPlan(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const seen = new Set(), dupes = [];
  for (const e of list) {
    const v = String((e && e.key) || "").trim();
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
    // Requisition ids are not all "R<digits>" (2026-08-03). Copart and PSECU use JR109393 / JR100897,
    // and those fell through to the origin+pathname fallback — which is NOT stable, because Workday
    // redirects the posting URL you paste to its own canonical spelling ("Harrisburg-PA" ->
    // "Harrisburg%2C-PA"). Live that produced TWO tracker rows for one job, and a submit run that
    // refused its own approved bundle: the fill stored the key under the redirected path, the submit
    // computed it from the pasted one. Any letters+digits requisition token now keys the same way.
    // The _R tier above is untouched and still matches FIRST, so every existing wdN:r<digits> key is
    // byte-identical — only URLs that had no key at all get one.
    // …including ids that SEPARATE the letter prefix from the digits (2026-08-09). Moog posts
    // `…-Engineering_R-26-18835`: the "_R<digits>" tier needs a digit straight after the R, and this
    // tier needed one straight after the letters, so BOTH missed and the key fell to the path — which
    // differs between the posting URL and the form URL by an "en-US/" locale segment AND the location
    // spelling ("Buffalo-NY" vs "Buffalo%2C-NY"). One job, two keys, and the rehearsal REFUSED its own
    // approved bundle. Allowing one separator keys both URLs off the requisition instead, which is the
    // whole point of these tiers: the req id is identical in every spelling of the link.
    const alt = (p.pathname.match(/_([A-Za-z]{1,4}[-_]?\d[\w-]*?)(?=\/|$)/g) || []).pop();
    if (alt) return (dc || "wd") + ":" + alt.slice(1).toLowerCase();
    // A purely NUMERIC requisition id (2026-08-09). Marvell posts `…-Engineer_2601615` — no "R", no
    // letter prefix — so it matched neither tier above and fell through to the path fallback, which is
    // ENCODING-SENSITIVE: Workday serves the location segment percent-encoded ("San-Diego%2C-CA") while
    // a hand-typed or redirected URL may carry the bare comma. The two spellings produced two different
    // keys for one job, so the submit run REFUSED its own approved bundle:
    //   REFUSING: no approved bundle for job_key "…" (no-remote-bundle)
    // Same failure the letters+digits tier was added for on 2026-08-03, one character narrower.
    // Ordered AFTER both tiers above, so every existing key stays byte-identical; ≥4 digits so an
    // ordinary path number can't be mistaken for a requisition.
    // A trailing "-<n>" is part of the id, not a separate segment (hp.wd5: `…Internship_3167270-1`).
    // Without this the whole token failed the tier and fell to the encoding-sensitive path again.
    const num = (p.pathname.match(/_(\d{4,}(?:-\d+)*)(?=\/|$)/g) || []).pop();
    if (num) return (dc || "wd") + ":" + num.slice(1);
    // Strip the FORM-page tail so a posting URL and its form URL key identically:
    // /apply(…) (Workday + Lever) and /application (Ashby — 2026-07-31; without this a
    // submit run keyed on the posting could never find the fill's reported bundle).
    // ⚠ An EMBED url carries its job identity ONLY in the query string: every employer's
    // Greenhouse embed is `job-boards.greenhouse.io/embed/job_app?for=<board>&token=<id>`, so
    // origin+pathname collapses ALL of them to one key. Live 2026-08-02 that made a submit run
    // pull a DIFFERENT company's approved bundle — the review page showed 'all approved' while
    // the gate refused, naming a field from the other application. Keep the job token when the
    // path alone cannot identify the job.
    // decodeURI-ish: fold percent-escapes so "%2c" and "," cannot key differently (see the numeric tier).
    const decoded = (() => { try { return decodeURIComponent(p.pathname); } catch (e) { return p.pathname; } })();
    const path = (p.origin + decoded).toLowerCase().replace(/\/apply(?:\/[^/]*)*\/?$/i, "").replace(/\/application\/?$/i, "").replace(/\/+$/, "");
    const tok = p.searchParams.get("token") || p.searchParams.get("gh_jid");
    if (tok && /\/embed\/job_app$|\/embed\/job_board$/.test(path)) return path + "?token=" + String(tok).toLowerCase();
    return path;
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
    // A re-formatted DATE is the same answer — checked before fuzzy, which would rate 5/1/2028 against
    // 05/01/2028 on character overlap rather than on meaning.
    if (sameCalendarDate(a, b)) return "date";
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
    // A date the FORM re-formatted is the same answer: approved "5/1/2028" vs a displayed
    // "05/01/2028" is zero-padding, not a contradiction, and blocking submit over it refuses a
    // correct application (live, Home Depot 2026-08-04). This is the KEYED path verdictFor uses —
    // the digit-strip below cannot serve here, because it would also equate 5/1/2028 with 51/2028.
    if (sameCalendarDate(recRaw, revRaw)) return true;
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
  // ── MIS-PAIRING GUARD, scoped to ONE repeating entry (2026-07-28) ───────────────────────────────
  // A DISAGREE means "the page shows a value that CONTRADICTS what was approved" — and it is the last
  // value check that BLOCKS a submit, so a false one is expensive. Live on Caterpillar/Solar Turbines it
  // reported three, all provably false:
  //     ≠ "Location": approved "Pittsburgh, PA" but the page shows "Yes"
  // "Yes" is the value of the NEXT row, "I currently work here" — and "Pittsburgh, PA" was sitting in the
  // same entry all along. Repeating entries reuse identical labels, so the row→value pairing can shuffle
  // WITHIN an entry.
  //
  // NARROW ON PURPOSE: the guard fires only when the approved value is the value of ANOTHER ROW OF THE
  // SAME ENTRY (same fkitPrefix + entryOrdinal). That is the signature of a shuffle. It deliberately does
  // NOT accept "the value appears somewhere on the page", because a keyed match must still beat
  // coincidental presence — approved "LinkedIn" vs a page `source` reading "Indeed" is a REAL disagree
  // even though another field's prose says "my LinkedIn profile" (pinned in review-reconcile.test.js).
  // Flat fields therefore keep the strict path entirely.
  const verdictFor = (base, cvs, cand, repSection) => {
    const inSameEntry = cand && cand.entryOrdinal != null && cand.fkitPrefix
      ? items.filter((it) => it !== cand && it.fkitPrefix === cand.fkitPrefix && it.entryOrdinal === cand.entryOrdinal)
      : [];
    const shuffled = inSameEntry.find((it) => valuesAgree(cvs, it.value));
    if (shuffled) {
      return ambiguous.push({ ...base, value_review: cand.value, tier: "mispaired-within-entry" });
    }
    // …and ACROSS the entries of an ORDER-FREE section (2026-08-02, operator: "on magna it is a
    // repeating section right? so it doesn't matter the order"). Exactly so — Magna's Websites
    // entries hold a URL and NOTHING else, so the section is a SET and the two rows coming back
    // with LinkedIn and GitHub swapped is not a disagreement at all. It was blocking the gate.
    //
    // ORDER-FREE means the entry has ONE field. Where an entry pairs several (work experience =
    // title + company + dates), one value moving between entries is NOT harmless — it can mean
    // genuinely mispaired data — so those keep the strict DISAGREE. `singleFieldSections` is
    // computed from the BUNDLE (how many distinct leaves the section records), not from the page.
    //
    // And where it IS order-free, RE-PAIR instead of excusing: claim the row that actually holds
    // our value and report AGREE. That is what set semantics means, it keeps the counts honest,
    // and a value with no home anywhere in the group still disagrees — so losing one is still caught.
    const orderFree = cand && cand.fkitPrefix && repSection && singleFieldSections.has(repSection);
    if (orderFree) {
      const mate = items.find((it) => it !== cand && !it.used && it.fkitPrefix === cand.fkitPrefix &&
        it.entryOrdinal !== cand.entryOrdinal && it.nlabel && it.nlabel === cand.nlabel &&
        valuesAgree(cvs, it.value));
      if (mate) {
        cand.used = false; mate.used = true;
        return agree.push({ ...base, value_review: mate.value, tier: "entry-reordered" });
      }
    }
    return disagree.push({ ...base, value_review: cand.value });
  };

  // Sections whose entries record exactly ONE field — a bare list (Websites is url-only), so their
  // entry ORDER carries no information. Derived from the bundle, which is what we actually know.
  const leavesBySection = new Map();
  for (const e of (Array.isArray(bundleEntries) ? bundleEntries : [])) {
    const r = e && parseCanonical(e.canonical_field);
    if (!r || !r.path) continue;
    if (!leavesBySection.has(r.section)) leavesBySection.set(r.section, new Set());
    leavesBySection.get(r.section).add(r.path);
  }
  const singleFieldSections = new Set([...leavesBySection].filter(([, v]) => v.size === 1).map(([k]) => k));

  let skipped = 0, placeholders = 0, claimed = 0;
  const claimedValues = []; // normalized recorded values — drives the EXTRA computation

  for (const e of (Array.isArray(bundleEntries) ? bundleEntries : [])) {
    if (!e) continue;
    const cv = e.current_value;
    if (cv == null || String(cv).trim() === "") continue;          // the extension claims no value here
    if (isAiPlaceholder(cv)) { placeholders++; continue; }          // an unreplaced AI mark, not a real value
    // ── A SIGNATURE date may legitimately read as EITHER the approved value OR today (2026-08-08) ──
    // This compared against today UNCONDITIONALLY, because the replay used to re-derive a signature
    // date on every run. That is no longer true: the replay now follows the review page, and today is
    // stamped only REACTIVELY, when Workday itself comes back with "Enter today's date" (see the
    // signature-date remediation in runCdpReplayWalk). Both outcomes are therefore correct:
    //   • Workday never asked  → the page holds the APPROVED value
    //   • Workday asked        → the walk stamped TODAY and re-saved
    // Comparing to today alone would now report a FALSE DISAGREE on the first case and block a clean
    // submit — the mirror of the bug the unconditional substitution was added to fix.
    //
    // So accept either, and nothing else: a page showing some THIRD date still disagrees, which is the
    // property that matters. Narrow by construction — isSignatureDateQuestion rejects any label naming
    // a different event (start / birth / graduation / expiry / from / to).
    const wt = e.widget_type;
    let cvs = String(cv);
    let altCvs = null;
    if ((wt === "date" || wt === "text") && isSignatureDateQuestion(e.question_label)) {
      const t = new Date();
      altCvs = `${t.getMonth() + 1}/${t.getDate()}/${t.getFullYear()}`;
    }
    const nlabel = normalizeLabel(e.question_label), nval = normalize(cvs);
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

    // ── checkbox GROUP: a SET, printed as separate values on the review page. Matching the JOINED
    //    string would find nothing and call a correct two-answer field MISSING, so each selected
    //    option is checked on its own and the row AGREES only when every one of them is present.
    //    A group with a single selection falls through to the normal path unchanged. ──
    //    SKILLS is the other multi-value field and prints the same way (one value per skill), so it
    //    takes this path too — matching the joined "A; B; C" as one string would report a correctly
    //    filled 20-skill field as MISSING on every rehearsal.
    const groupVals = wt === "checkbox_group" ? groupSelection(e) : [];
    const setVals = groupVals.length ? groupVals : (isSkillsEntry(e) ? splitGroupValue(cvs) : []);
    if (setVals.length > 1) {
      claimed++; claimedValues.push(...setVals.map((g) => normalize(g)));
      const absent = setVals.filter((g) => {
        const n = normalize(g);
        if (n.length >= 4 || (n.length >= 3 && !AMBIGUOUS_SHORT.test(n))) return !presentTier(g);
        return !items.some((it) => it.nlabel && labelMatches(it.nlabel, nlabel) && valueTier(n, it.nval));
      });
      if (!absent.length) agree.push({ ...base, value_review: cvs, tier: groupVals.length ? "checkbox-group-set" : "skills-set" });
      else missing_on_review.push({ ...base, detail: "not shown on the review page: " + absent.join("; ") });
      continue;
    }

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
        // altCvs is set ONLY for a signature date: today is an equally-correct page value there, because
        // the walk stamps it reactively when Workday demands it. Any other date still disagrees.
        if (valuesAgree(cvs, cand.value) || (altCvs && valuesAgree(altCvs, cand.value)))
          agree.push({ ...base, value_review: cand.value, tier: rep ? "entry" : "keyed" });
        else verdictFor(base, cvs, cand, rep && rep.section); // a shuffled row is not a contradiction
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
  // ── PAST AUTH IS PAST AUTH, EVEN BEFORE THE FIELDS MOUNT (2026-08-07) ────────────────────────────
  // Success used to require form FIELDS, so a sign-in that had plainly worked read as "unknown" until
  // Workday finished mounting them — and the caller spent its whole budget waiting, then re-submitted
  // the auth form or reloaded the page. Measured on jabil.wd5, the successful sign-in:
  //
  //   still waiting at 2.0s — title "Careers"      formFields 0 · hasAuthEl false · markers [none]
  //   timed out after 4000ms (52 reads)
  //   last state:  title "Principal Product Test Engineer…" · formFields 0 · markers [applyFlowPage]
  //   sign-in outcome: unknown
  //
  // `applyFlowPage` is Workday's APPLICATION-FLOW container — you cannot be on it without being signed
  // in — and `hasAuthEl` false means every piece of auth chrome is gone. That is success; the fields are
  // simply a beat behind. Waiting for them HERE is duplicated work: both walks call
  // awaitFieldSetSettled before touching a page, which waits for a non-zero, stable field count. So an
  // early success costs nothing and saves the whole remainder of the auth budget.
  //
  // Deliberately narrow: it still requires NO auth element, and the verify / wrong-credentials text
  // checks above run FIRST, so a page mid-auth or reporting an error can never reach here.
  if (s.markers && s.markers.applyFlowPage && !s.hasAuthEl) return "success";
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

// "You've already applied for this job." Workday shows a dedicated already-applied page instead of the
// application form when the signed-in candidate has already submitted for this requisition. It's a CLEAN
// terminal state, NOT an error — the onboarding halts gracefully ("already-applied") rather than timing
// out on a form/auth screen that will never appear. Primary signal is the marker
// (data-automation-id="alreadyAppliedPage"); the body-text fallback catches a tenant that omits it. The
// page TITLE is unreliable (observed as a stale "Create Account" on Magna wd3, 2026-07-24), so it's ignored.
function isAlreadyApplied(state) {
  const s = state || {};
  if (s.markers && s.markers.alreadyAppliedPage) return true;
  const t = String(s.bodyText || "");
  return /you.{0,3}ve already applied|you have already applied|already applied for this (job|position|requisition|role)/i.test(t);
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
  const url = String(s.url || "");
  const ssoUrl = /\bsso\b|[?&/](saml|idp|oidc|federation)\b|okta|pingidentity|pingone|onelogin|microsoftonline|\badfs\b|auth0|login\.gov/i.test(url);
  if (ssoUrl) return true; // POSITIVE evidence: we were redirected to an identity provider.
  // ── FIELD-ABSENCE IS NOT EVIDENCE OF SSO ON A WORKDAY-HOSTED PAGE (operator, 2026-07-27:
  //    "Workday will never be SSO"). ────────────────────────────────────────────────────────────
  // The check below infers SSO from a MISSING email/password field, which is absence-of-evidence: a
  // Workday auth widget that is still RENDERING looks exactly like a bare "Sign in with <provider>"
  // redirect — auth chrome present, fields not yet in the DOM. Live (Caterpillar wd5, hidden tab,
  // 2026-07-27) that produced a flat-wrong "this tenant uses SSO" halt on an ordinary create-account
  // page: the tab was backgrounded, the widget needed >20s to paint (the post-apply-manually wait
  // timed out at 20s), the fields weren't there yet, and the "Already have an account? Sign In" link
  // satisfied signInButtonPresent. A REAL SSO redirect leaves the Workday host, so the URL test above
  // still catches it — while still ON a Workday host, a slow render is by far the likelier story, and
  // the caller waits/halts honestly instead of blaming SSO.
  if (isWorkdayHost(url)) return false;
  // A sign-in button with NO email/password field AND no email-chooser button = a bare
  // "Sign in with <provider>" redirect → SSO. (Non-Workday hosts only, per above.)
  if (s.signInButtonPresent && !s.passwordInput && !s.emailInput) return true;
  return false;
}

// ── Job-posting settle-poll: the ACCEPT RULE (pure, unit-pinned) ─────────────────────────────────
// One step of "has the posting finished rendering?", folded over successive page reads. The SW does the
// I/O (waitJobPageSettled in background.js); this owns the decision, so it can be tested without a page.
//
// `read` = { len, hasPosting } — body-text length + whether the posting's OWN content is in the DOM.
// `state` = the previous step's return ({ prev, stable }); pass nothing to start.
//
// Rule: only TWO CONSECUTIVE EQUAL, non-empty reads count as settled (the same discipline as the fill's
// settle-polls — never a fixed sleep). A stable count is only TRUSTWORTHY once the posting's content is
// actually present; without it, insist on more repeats, because a page can PAUSE mid-hydration and hold
// a partial byte count (live: a background run sat at 461 chars of a posting that renders 2913).
function jobPageSettleStep(read, state) {
  const prev = state && typeof state.prev === "number" ? state.prev : -1;
  const prevStable = state && typeof state.stable === "number" ? state.stable : 0;
  const len = read && typeof read.len === "number" ? read.len : 0;
  const stable = len > 0 && len === prev ? prevStable + 1 : 0;
  const accept = stable > 0 && (!!(read && read.hasPosting) || stable >= 3);
  return { accept, prev: len, stable };
}

// ── The EMPTY Workday shell after a sign-in submit (operator 2026-07-27: "the solution is to just
//    refresh the page") ────────────────────────────────────────────────────────────────────────────
// Live on cat.wd5/solarturbines: sign-in submitted, and the page came back with `readyState=complete`
// but NOTHING on it — no form fields, no auth chrome (no email/password/submit/links), no apply
// controls, no already-applied marker; body text just the cookie boilerplate, while the title still
// read "Create Account". There is nothing to act on and nothing to classify (classifyAuthOutcome says
// "unknown"), so the flow used to halt `auth-unknown` — but a plain RELOAD reliably brings the real
// page back, so this is recoverable, not operator-worthy.
//
// STRICT by design, because the action it authorizes is a page reload: it requires the document to be
// FULLY LOADED (never fires mid-navigation, when everything is legitimately absent for a moment) and
// EVERY actionable marker to be absent. A page with any field, any auth control, any apply button, or
// real content is NOT blank. `readyState` is optional so an older scan (which didn't report it) simply
// never matches — fail-closed.
const BLANK_PAGE_BOILERPLATE_MAX = 700; // a genuinely empty shell is just the cookie/skip-link text
// ── IS THE BLANK PAGE PERSISTENT, OR JUST MID-NAVIGATION? (2026-08-07) ──────────────────────────────
// `isBlankAuthPage` is a single-read test, and every condition it checks is ALSO satisfied by an SPA
// mid-navigation: the old view torn down, the new one not yet mounted, `readyState` already "complete".
// Straight after an auth POST that is the EXPECTED transient, not a failure — so reloading there throws
// away a navigation that was about to finish and restarts the whole sign-in. Traced live: a false
// re-click produced exactly this, and the reload is where the 8-9s went.
//
// The reload rule itself is right — it came from cat.wd5, where the empty shell was PERSISTENT and only
// a refresh recovered it. What was missing is WHEN it may fire. So: require the blank state to HOLD
// across several consecutive reads rather than trusting one. A single non-blank read anywhere in the
// window means the page was moving, and moving pages are not reloaded.
//
// PURE so the decision is unit-testable; the caller does the polling.
const BLANK_AUTH_MIN_READS = 3;
function blankAuthPersists(reads, minReads) {
  const rs = (Array.isArray(reads) ? reads : []).filter((r) => r != null);
  const need = Number(minReads) > 0 ? Number(minReads) : BLANK_AUTH_MIN_READS;
  if (rs.length < need) return false;              // not enough evidence to call it stuck
  return rs.every((s) => isBlankAuthPage(s));      // ANY page that moved ⇒ it was navigating, not dead
}

function isBlankAuthPage(state) {
  const s = state || {};
  if (s.readyState !== "complete") return false;          // still loading ⇒ absence proves nothing
  if ((s.formFieldCount || 0) > 0) return false;
  if (s.hasAuthEl || s.emailInput || s.passwordInput || s.signInWithEmail) return false;
  const m = s.markers || {};
  // ANY actionable/known page shape disqualifies it — this must never fire on a page we can drive.
  if (m.signInSubmit || m.createAccountSubmit || m.signInLink || m.createAccountLink || m.verifyPassword) return false;
  if (m.adventureButton || m.continueButton || m.applyManually || m.useMyLastApplication) return false;
  if (m.applyFlowReviewPage || m.alreadyAppliedPage || m.formField) return false;
  const text = String(s.bodyText || "").replace(/\s+/g, " ").trim();
  return text.length <= BLANK_PAGE_BOILERPLATE_MAX;        // real content ⇒ not an empty shell
}

// ── Workday's PHANTOM "required" error — filled, but reported empty (2026-07-28) ────────────────────
// PURE half of the fix (the actuation is nudgePhantomRequired in background.js). Live on a HIDDEN
// solarturbines replay, page 5: "The field Name is required and must have a value" + the same for Date,
// while both fields visibly held correct, read-back-verified values. Cause: Workday validates on BLUR,
// and synthetic-input mode never blurs a field (see cdpCommitPendingEdits) — the DOM has the value, the
// form model was never told the edit finished. The operator's manual fix is a focus/blur cycle.
//
// This decides WHETHER that is what we're looking at. It is the safety gate, so it is deliberately
// strict — a false positive would re-save a page with a genuinely empty required field, hiding a real
// problem behind a retry:
//   • every error title must map to a field ON the page (an unmatched title ⇒ we don't understand this
//     error, so we don't act on it);
//   • every one of those fields must HOLD a value (one empty ⇒ a real validation block, not the race).
// Returns { phantom, targets:[{title, fieldName, wrapperSel, value}], reason }.
function phantomRequiredTargets(errorTitles, liveFields) {
  const titles = (Array.isArray(errorTitles) ? errorTitles : []).map((t) => String(t == null ? "" : t).trim()).filter(Boolean);
  const fields = Array.isArray(liveFields) ? liveFields : [];
  if (!titles.length) return { phantom: false, targets: [], reason: "the error text names no field" };

  const holds = (v) => v === true || (v != null && v !== "" && v !== false && !/^select one$/i.test(String(v)));
  const matched = [], unmatched = [];
  for (const title of titles) {
    const want = errorLabelKey(title);   // colon-tolerant — see errorLabelKey
    // Visible label first, then the automation-id — some tenants word the error after the id.
    const hit = fields.find((f) => errorLabelKey((f && f.label) || "") === want)
      || fields.find((f) => errorLabelKey((f && f.fieldName) || "") === want);
    if (hit) matched.push({ title, fieldName: hit.fieldName, wrapperSel: hit.wrapperSel, value: hit.value });
    else unmatched.push(title);
  }
  if (!matched.length) return { phantom: false, targets: [], reason: `the error names ${titles.map((t) => JSON.stringify(t)).join(", ")}, which match no field on this page` };
  if (unmatched.length) return { phantom: false, targets: [], reason: `not every error maps to a field on this page (unmatched: ${unmatched.join(", ")}) — not treating this as the phantom` };

  const empty = matched.filter((m) => !holds(m.value));
  if (empty.length) return { phantom: false, targets: [], reason: `genuinely empty on the page: ${empty.map((m) => `${m.title} (${m.fieldName})`).join(", ")} — a real validation block, not the blur race` };

  return { phantom: true, targets: matched, reason: null };
}

// ── "Which page am I actually on?" (operator 2026-07-28) ────────────────────────────────────────────
// Standing rule from the already-applied bug: **after every click that navigates, DETECT the page you
// landed on — never assume the click took you where you aimed.** Each caller used to test only for the
// ONE thing it wanted (auth fields, a form, the review marker), so any other landing read as "the thing
// I wanted didn't render" and produced a halt naming the wrong cause. This is the single classifier the
// redirect points share, so an unexpected landing is REPORTED as what it is.
//
// Ordered most-specific first, and deliberately: the transient/terminal states (maintenance, soft error,
// already-applied) come BEFORE the shape tests, because those pages can carry leftover chrome that would
// otherwise match a later, wronger bucket.
function classifyWorkdayPage(state) {
  const s = state || {};
  const m = s.markers || {};
  if (isWorkdayMaintenance({ title: s.title, bodyText: s.bodyText, formFieldCount: s.formFieldCount, passwordInputPresent: s.passwordInput, signInButtonPresent: s.signInButtonPresent })) return "maintenance";
  if (isWorkdaySoftError(s.bodyText)) return "soft-error";
  if (isAlreadyApplied(s)) return "already-applied";
  if (isMyApplicationsPage(s)) return "my-applications";
  if (m.applyFlowReviewPage) return "review";
  if ((s.formFieldCount || 0) > 0 && !s.hasAuthEl) return "form";
  if (s.hasAuthEl || s.emailInput || s.passwordInput || s.signInWithEmail) return "auth";
  // The apply chain lives on the JOB-DESCRIPTION page — and it is also the page the already-applied
  // recovery lands on after clicking an application row, where the affordance is "Continue Application"
  // (`continueButton`). Both are "a posting with a way in", so they share a bucket.
  if (m.adventureButton || m.continueButton || m.applyManually || m.useMyLastApplication) return "job-description";
  if (isBlankAuthPage(s)) return "blank";
  return "unknown";
}

// ── THE STUCK, HALF-TORN-DOWN APPLY CHAIN (2026-08-07) ───────────────────────────────────────────────
// The JD page offers `adventureButton` (Apply). The /apply CHOOSER offers `applyManually` +
// `useMyLastApplication` — and, verified live on a cleanly-loaded radiancetech.wd12 chooser, it does NOT
// carry `adventureButton`. So the two markers are MUTUALLY EXCLUSIVE on any healthy page, and seeing them
// TOGETHER means the SPA swapped views without tearing the old one down: a coordinate click then lands on
// a layer that is no longer live, reports success, and nothing moves.
//
// This is not theoretical — it is what two tenants actually did on a fresh account (radiancetech.wd12 and
// magna.wd3, hidden AND foreground). Every read for the full 45s budget showed
// `markers [adventureButton, applyManually, useMyLastApplication]`, the click "succeeded" each time, and
// onboarding halted `backToApply` after re-issuing the identical click three rounds over (~135s).
//
// Deliberately NARROW: it requires the contradiction AND no auth element AND no form fields, so a page
// mid-render toward the auth screen (which is simply "not landed yet") can never match. It is a signal to
// change the ACTIVATION MECHANISM, never to give up — the caller still escalates and still waits.
function applyChainStuckMixed(state) {
  const s = state || {};
  const m = s.markers || {};
  if (s.hasAuthEl || s.emailInput || s.passwordInput) return false; // already at/near auth — just not landed
  if ((s.formFieldCount || 0) > 0) return false;                    // a form is up; nothing is stuck
  return !!(m.adventureButton && m.applyManually);
}

// Workday's candidate-home "My Applications" list — the page behind the already-applied page's "View My
// Applications" link, and the ONLY place that says whether an application was really submitted.
// Text-anchored on purpose: the automation-ids here are unconfirmed across tenants (no recon dump yet),
// while the heading + a status word are what the operator actually reads off the page. Requiring BOTH a
// list heading and a status word keeps it off an ordinary posting that merely links to the list.
function isMyApplicationsPage(state) {
  const s = state || {};
  const m = s.markers || {};
  if (m.myApplicationsPage) return true;                    // confirmed marker (once a tenant shows one)
  const t = String(s.bodyText || "");
  if (isAlreadyApplied(s)) return false;                    // the already-applied page LINKS to the list; it is not the list
  const heading = /\bmy applications\b|\byour applications\b|\bapplication history\b/i.test(t);
  return heading && APPLICATION_STATUS_RX.test(t);
}

// A row's status word. NEGATIVE FIRST — "Not Submitted" contains "Submitted", so any test that checks
// the positive first mislabels every unsubmitted draft as submitted, which is the exact failure this
// whole recovery exists to fix (and the dangerous direction: it would give up on a fillable application).
const APPLICATION_STATUS_RX = /\bnot submitted\b|\bunsubmitted\b|\bsubmitted\b|\bin progress\b|\bincomplete\b|\bdraft\b|\bstarted\b/i;
function applicationStatusOf(text) {
  const t = String(text == null ? "" : text);
  if (/\bnot submitted\b|\bunsubmitted\b|\bnot yet submitted\b/i.test(t)) return "not-submitted";
  if (/\bin progress\b|\bincomplete\b|\bdraft\b|\bnot complete(d)?\b/i.test(t)) return "not-submitted";
  if (/\bsubmitted\b|\bunder consideration\b|\breceived\b|\bactive application\b/i.test(t)) return "submitted";
  return "unknown";
}

// The requisition id out of a job/application URL or a row's text — "…_R0000382293" → "R0000382293".
// This is the STRONG match key for finding our application among many at the same company: titles repeat
// and get truncated, the req id doesn't. Mirrors canonicalJobUrl's `_R(\d+)` key, then falls back to a
// standalone R/JR/REQ token anywhere in the string.
function reqIdFromUrl(u) {
  const s = String(u == null ? "" : u);
  const underscore = s.match(/_((?:R|JR|REQ)[-_]?\d{3,})\b/i);
  if (underscore) return underscore[1].toUpperCase();
  const bare = s.match(/\b((?:R|JR|REQ)[-_]?\d{4,})\b/i);
  return bare ? bare[1].toUpperCase() : null;
}

// Pick OUR application out of the My Applications list. Same philosophy as the fill's match ladder: an
// EXACT/keyed hit or nothing — never a confident-looking guess. A wrong pick here would open a DIFFERENT
// application and fill it, so ambiguity must escalate to the operator, not resolve itself.
//   1. req id (from the row's href or its text) — exact, unambiguous, survives title truncation
//   2. exact normalized title
//   3. containment, committed ONLY when exactly ONE row contains the title (the ambiguity guard)
// Returns { row, tier } or { row: null, reason } so the caller can say WHY it refused.
function pickApplicationRow(rows, target) {
  const list = Array.isArray(rows) ? rows : [];
  const t = target || {};
  if (!list.length) return { row: null, reason: "the applications list rendered no rows" };

  const wantReq = t.reqId || reqIdFromUrl(t.url || "");
  if (wantReq) {
    const hits = list.filter((r) => {
      const fromHref = reqIdFromUrl(r && r.href);
      const fromText = reqIdFromUrl(r && r.text);
      return fromHref === wantReq || fromText === wantReq;
    });
    if (hits.length === 1) return { row: hits[0], tier: "req-id" };
    if (hits.length > 1) return { row: null, reason: `${hits.length} rows carry requisition ${wantReq} — refusing to guess which` };
  }

  const wantTitle = normalize(t.title || "");
  if (wantTitle) {
    const exact = list.filter((r) => normalize((r && r.title) || "") === wantTitle);
    if (exact.length === 1) return { row: exact[0], tier: "exact-title" };
    if (exact.length > 1) return { row: null, reason: `${exact.length} rows share the title "${t.title}" — refusing to guess which` };
    const contains = list.filter((r) => {
      const rt = normalize((r && r.title) || "");
      return rt && (rt.indexOf(wantTitle) >= 0 || wantTitle.indexOf(rt) >= 0);
    });
    if (contains.length === 1) return { row: contains[0], tier: "title-containment" };
    if (contains.length > 1) return { row: null, reason: `${contains.length} rows partially match "${t.title}" — refusing to guess which` };
  }

  return { row: null, reason: `no row matches this job (${wantReq ? "requisition " + wantReq : "no requisition id"}${t.title ? `, title "${t.title}"` : ""})` };
}


// ── Locating a repeating section on the LIVE page (pure) ────────────────────────────────────────────
// The fkit container prefix is TENANT-VARIABLE — website rows live under `webAddress-` on the observed
// tenants while their records are keyed `website[i]`, and nothing guarantees that mapping holds
// everywhere. Trusting a hardcoded prefix is exactly what made the first live phantom-duplicate fix
// delete 0 of 2 rows (entryCount("webAddress-") → 0 → the loop bailed immediately). cdpRepeatingScan
// DISCOVERS the prefixes actually present in the DOM; this picks ours out of them, most-certain first:
// the canonical prefix → a prefix starting with the section NAME → the section's HEADING (the same
// anchor findSectionAdd uses, and the most tenant-proof of the three). `sectionCfg` is the PAGE_SECTIONS
// row ({containerPrefix, headingRegex}) passed in by the caller so this stays dependency-free.
function findLiveSection(rscan, sectionName, sectionCfg) {
  const sections = (rscan && rscan.sections) || {};
  const keys = Object.keys(sections);
  if (!keys.length) return null;
  const sec = sectionCfg || null;
  if (sec && sec.containerPrefix && sections[sec.containerPrefix]) return { prefix: sec.containerPrefix, live: sections[sec.containerPrefix] };
  const byName = keys.find((k) => k.toLowerCase().indexOf(String(sectionName || "").toLowerCase()) === 0);
  if (byName) return { prefix: byName, live: sections[byName] };
  if (sec && sec.headingRegex) {
    const re = new RegExp(sec.headingRegex, "i");
    const byHeading = keys.find((k) => re.test(String(sections[k].heading || "")));
    if (byHeading) return { prefix: byHeading, live: sections[byHeading] };
  }
  return null;
}

// Plan-shaped entries from the LIVE scan's rows — index, a dedupe KEY, a summary, and whether the row
// even HAS a Delete control. Live rows beat results-derived ones: they include anything Workday added
// behind our back, and they carry the values actually on screen. `keyField` is the section's identity
// field when it has one (website→url, language→language — their duplicate errors are about that single
// value); absent, or missing from the row, the whole row's values form the key.
function liveDupEntries(liveEntries, keyField) {
  const norm = (v) => String(v).trim().toLowerCase().replace(/\/+$/, "");
  return (liveEntries || []).map((e, i) => {
    const filled = ((e && e.fields) || []).filter((f) => f && f.value != null && String(f.value).trim() !== "");
    const keyed = keyField ? filled.filter((f) => f.fieldName === keyField) : [];
    const basis = keyed.length ? keyed : filled;
    return {
      index: i,
      key: basis.map((f) => f.fieldName + "=" + norm(f.value)).sort().join("|"),
      summary: filled.map((f) => String(f.value)).join(" · ") || "?",
      deletePresent: !!(e && e.deletePresent),
    };
  });
}

// A date composite's SEGMENT ORDER for the review editor: the scan reports raw segment automation-ids
// (["dateSectionMonth-display","dateSectionMonth-input","dateSectionYear-display",…]) and the viewer
// needs the form's own order — ["month","day","year"] / ["month","year"] / ["year"] — to render a
// segmented MM/DD/YYYY editor instead of a text box. Passing the RAW ids through instead printed them
// as the field's content on the review page (live 2026-07-27, the cascade-added "Date" field).
function dateOrderOf(segs) {
  const order = [];
  for (const seg of (Array.isArray(segs) ? segs : [])) {
    const m = /dateSection(Month|Day|Year)/i.exec(String(seg));
    if (m) { const p = m[1].toLowerCase(); if (!order.includes(p)) order.push(p); }
  }
  return order;
}

// ── CASCADE-REVEALED REQUIRED FIELDS (pure) ─────────────────────────────────────────────────────────
// A field the form has since made REQUIRED, which the approved bundle cannot answer, is a question for
// the HUMAN — not something to guess and not something to halt blind on. Live (solarturbines page 5,
// 2026-07-27): filling an OPTIONAL name promoted "Date" and "Please check one of the boxes below" to
// required. Nothing was wrong with the fill — both were optional AND blank when the page was reviewed,
// so there was genuinely nothing to record; the replay then had nothing to put there and Workday refused
// the page. These two turn that into a review item the operator can answer on the website.
//
// BOTH gap shapes count, and the second is the one that actually happened: an entry MISSING from the
// bundle, and an entry PRESENT but BLANK. Neither helper ever invents a value — every entry produced is
// empty and unapproved, so bundleSubmitBlockers (required-blank + unapproved-flagged) keeps refusing
// until a human answers it.
function newlyRequiredGaps(liveFields, bundleEntries, pageKey, errorTitles) {
  const nameOf = (e) => {
    const id = String((e && e.field_id) || "");
    const tail = id.includes("::") ? id.slice(id.lastIndexOf("::") + 2) : id;
    return tail.indexOf("formField-") === 0 ? tail.slice("formField-".length) : tail;
  };
  const byName = new Map();
  for (const e of bundleEntries || []) byName.set(nameOf(e), e);
  const blank = (v) => v == null || String(v).trim() === "";
  const titles = (errorTitles || []).map((t) => normalizeLabel(String(t || "")));
  return (liveFields || [])
    .filter((f) => f && f.isRequired === true && blank(f.value) && f.widgetType !== "file_upload")
    .map((f) => {
      const entry = byName.get(f.fieldName) || null;
      const named = titles.length ? titles.includes(normalizeLabel(String(f.label || ""))) : false;
      return { field: f, entry, reason: !entry ? "not-in-bundle" : "blank-in-bundle", namedByError: named };
    })
    // Only fields the bundle can't answer. A required field the bundle HAS a value for isn't a gap —
    // if it's still blank on the page that's a replay failure, which the strict verify already reports.
    .filter((g) => !g.entry || blank(g.entry.current_value));
}

// The mirror of newlyRequiredGaps: REQUIRED fields the page shows as BLANK that the approved bundle DOES
// have a value for. That is a value which did not STICK — it was filled and verified, then something
// cleared it before Save & Continue.
//
// Live (solarturbines page 5, 2026-07-28): the disability checkbox group was replayed and VERIFIED
// checked (fillCheckboxGroupCdp re-reads and requires exactly one box on), the page then reported
// "Please check one of the boxes below … is required and must have a value", and the operator watched it
// happen — "the checkbox at the end first clicked, but then something happened and it got unclicked".
// The fill walk catches this class with its post-settle M40 audit; the replay had no equivalent, so the
// walk clicked Save & Continue on a page it believed was complete.
//
// Deliberately the same blank/carve-out rules as bundleSubmitBlockers so the three checks agree: a
// checkbox stores "false" (never empty), file_upload has its own re-attach step.
// The HOLE in requiredBlankOnPage (2026-08-04): it walks the live scan, so a required field whose
// wrapper is MISSING from that scan is not merely un-refilled — it is invisible. And "missing from the
// scan" is exactly what the M40 audit reports as `audit-unverifiable`, which is how the disability
// self-ID group slipped past the one guard meant to catch it.
//
// So: required entries that HOLD an answer and are NOT in the live scan at all. The caller must probe the
// DOM for each one before believing it (cdpPageScan filters out fields inside repeating containers, so
// absence from that list is not proof of absence from the page — the same lesson replayFlatFields learned).
function requiredEntriesAbsentFromScan(liveFields, bundleEntries) {
  const nameOf = (e) => {
    const id = String((e && e.field_id) || "");
    const tail = id.includes("::") ? id.slice(id.lastIndexOf("::") + 2) : id;
    return tail.indexOf("formField-") === 0 ? tail.slice("formField-".length) : tail;
  };
  const blank = (v) => v == null || String(v).trim() === "";
  const present = new Set((liveFields || []).map((f) => f && f.fieldName).filter(Boolean));
  const out = [];
  for (const e of bundleEntries || []) {
    if (!e || e.is_required !== true) continue;
    if (e.widget_type === "file_upload" || e.widget_type === "section") continue; // own re-attach / display-only
    if (e.is_deleted) continue;
    const name = nameOf(e);
    if (!name || present.has(name)) continue;
    if (blank(e.current_value)) continue;                 // nothing to put back → newlyRequiredGaps owns it
    out.push({ name, entry: e, approved: String(e.current_value) });
  }
  return out;
}

function requiredBlankOnPage(liveFields, bundleEntries) {
  const nameOf = (e) => {
    const id = String((e && e.field_id) || "");
    const tail = id.includes("::") ? id.slice(id.lastIndexOf("::") + 2) : id;
    return tail.indexOf("formField-") === 0 ? tail.slice("formField-".length) : tail;
  };
  const blank = (v) => v == null || String(v).trim() === "";
  const byName = new Map();
  for (const e of bundleEntries || []) byName.set(nameOf(e), e);
  const out = [];
  for (const f of liveFields || []) {
    if (!f || f.isRequired !== true || f.widgetType === "file_upload") continue;
    if (!blank(f.value)) continue;                       // holds a value → fine
    const entry = byName.get(f.fieldName);
    if (!entry || blank(entry.current_value)) continue;   // nothing approved to put back → newlyRequiredGaps owns it
    out.push({ field: f, entry, approved: String(entry.current_value) });
  }
  return out;
}

// A LIVE required field that is BLANK, whose answer we already have under a DIFFERENT automation-id
// (2026-08-06). Workday REMOUNTS a dependent question under a new id whenever the field it depends on
// changes, so the bundle can hold "Which basecamp…" as filled under id A while the page shows the same
// question, blank and required, under id B. Both existing pre-Save checks key on the BUNDLE's id, so
// neither sees it: one reports "in the bundle but NOT on the page — left alone, not fatal", and Save is
// then clicked into a rejection that cannot be anything else. Live on waystar page 3, repeatedly.
//
// The QUESTION is the stable identity, so match on the label and re-fill at the id the page is using NOW.
// Deliberately narrow, because a label match is weaker evidence than an id match:
//   - the live field must be REQUIRED and BLANK (nothing is ever overwritten by this),
//   - the entry must actually hold a value (otherwise the cascade/review path owns it, not us),
//   - and the entry's OWN field must be absent from the page — if it is still there, this is not a
//     remount and requiredBlankOnPage owns it.
// Returns { field, entry, approved, fromName } — `field` is the LIVE field, so the caller fills the id
// that exists rather than the one that used to.
function requiredBlankByLabel(liveFields, bundleEntries) {
  const nameOf = (e) => {
    const id = String((e && e.field_id) || "");
    const tail = id.includes("::") ? id.slice(id.lastIndexOf("::") + 2) : id;
    return tail.indexOf("formField-") === 0 ? tail.slice("formField-".length) : tail;
  };
  // A dropdown sitting on its PLACEHOLDER is empty, whatever the scan calls it. Live: the remounted
  // basecamp field read "Select One", so a plain empty-string test saw it as filled and this whole
  // recovery silently did nothing while Workday refused the page for that exact field being required.
  const blank = (v) => v == null || String(v).trim() === "" || isPlaceholderOption(String(v));
  const key = (x) => errorLabelKey(x);   // colon-tolerant, same reason as phantomRequiredTargets
  const live = new Set((liveFields || []).map((f) => f && f.fieldName));
  const byLabel = new Map();
  for (const e of bundleEntries || []) {
    if (!e || e.is_deleted) continue;
    if (blank(e.current_value)) continue;
    if (live.has(nameOf(e))) continue;               // its own field is still on the page → not a remount
    const k = key(e.question_label);
    if (k && !byLabel.has(k)) byLabel.set(k, e);
  }
  const out = [];
  if (!byLabel.size) return out;
  for (const f of liveFields || []) {
    if (!f || f.isRequired !== true || f.widgetType === "file_upload") continue;
    if (!blank(f.value)) continue;
    const entry = byLabel.get(key(f.label));
    if (!entry) continue;
    out.push({ field: f, entry, approved: String(entry.current_value), fromName: nameOf(entry) });
  }
  return out;
}

// Build a review entry for a newly-required field. Empty + unapproved BY DESIGN — this asks the human a
// question, it never answers it.
function cascadeEntryFor(gap, pageKey, pageNumber, index) {
  const f = gap.field;
  const options = Array.isArray(f.checkboxes) && f.checkboxes.length
    ? f.checkboxes.map((c) => ({ text: c.labelText }))          // a checkbox group carries its labels in the DOM
    : Array.isArray(f.options) ? f.options : [];
  return {
    field_id: (pageKey ? pageKey + "::" : "") + "formField-" + f.fieldName,
    page: pageKey || null,
    page_number: pageNumber || null,
    field_index: index,
    question_label: f.label || f.fieldName,
    widget_type: f.widgetType,
    canonical_field: null,
    is_required: true,
    current_value: null,
    original_ai_value: null,
    is_edited: false,
    edit_kind: null,
    is_approved: false,
    confidence: "none",
    confidence_source: "cascade_revealed",
    needs_review: true,
    needs_review_reason: "cascade_required",
    fill_status: "not_filled",
    cascade_revealed: true,
    flag: "cascade-required",
    options,
    date_order: f.widgetType === "date" || f.widgetType === "year" ? dateOrderOf(f.dateSegments) : null,
    detail: gap.reason === "not-in-bundle"
      ? "became REQUIRED on the live form and was never captured when this application was reviewed — answer it here, then re-run"
      : "was OPTIONAL and left blank when this application was reviewed, and the form has since made it REQUIRED — answer it here, then re-run",
  };
}


// Is this URL on a Workday-owned host (the careers/JD host or the logged-in form host)? Used to reject
// absence-based SSO inference (above) — while we're still on Workday's own domain, a missing field means
// "not rendered yet", not "federated login". An unparseable/empty URL is NOT treated as Workday.
function isWorkdayHost(url) {
  try { return /\.myworkday(?:jobs|site)\.com$/i.test(new URL(String(url == null ? "" : url)).hostname); }
  catch (e) { return false; }
}

// The company brand from a Workday tenant URL — magna.wd3.myworkdayjobs.com → "Magna" (also the
// logged-in myworkdaysite.com form host). The tenant subdomain IS the company brand on virtually every
// Workday tenant AND is always present in the page URL, so it's a reliable employment-question anchor when
// the scraped jobContext.company is missing (Option 1, 2026-07-25 — anchor on the URL tenant, still
// confirmed-in-question by the recognizer; the answer comes from the profile employer list). Returns null
// on a non-Workday / unparseable URL. Mirrors scrapeJobDescription's subdomain+titleCase fallback.
function tenantCompanyFromUrl(url) {
  let host = "", path = "";
  try { const u = new URL(String(url == null ? "" : url)); host = u.hostname; path = u.pathname || ""; } catch (e) {}
  if (!/\.myworkday(?:jobs|site)\.com$/i.test(host)) return null; // trust ONLY Workday hosts
  const titleCase = (s) => (String(s || "").replace(/[-_+]+/g, " ").replace(/\s+/g, " ").trim()
    .split(" ").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ") || null);
  const dec = (s) => { try { return decodeURIComponent(s); } catch (e) { return s; } };
  // The brand lives in the SUBDOMAIN on the careers/JD host (magna.wd3.myworkdayjobs.com), but in the PATH
  // on the LOGGED-IN FORM host — wd3.myworkdaysite.com/en-US/recruiting/<tenant>/<Tenant>/job/… (no company
  // subdomain there). The fill runs on the form host, so the path fallback is the load-bearing one. Mirrors
  // scrapeJobDescription's subdomain → path fallbacks.
  const sub = host.match(/^([a-z0-9-]+)\.wd\d+\.myworkday(?:jobs|site)\.com$/i);
  if (sub) return titleCase(sub[1]);
  const rec = path.match(/\/recruiting\/([^/]+)/i);      // /recruiting/<tenant>/… — the clean tenant slug (preferred)
  if (rec) return titleCase(dec(rec[1]));
  const job = path.match(/\/([^/]+)\/job\//i);           // fallback: the segment right before "/job/"
  if (job) return titleCase(dec(job[1]));
  return null;
}

// ── DEV LOG MIRROR — pure helpers ───────────────────────────────────────────────────────────────────
// [ApplyPilot] output goes to the SERVICE-WORKER console, which is a worker target rather than a tab, so
// nothing outside DevTools can read it — an agent driving this extension is blind to the one channel that
// explains what a run actually did. background.js mirrors every console line into a bounded ring buffer
// that the local dev site pulls over AP_DEV_LOGS (the same localhost-only external channel as AP_RELOAD).
// The buffer mechanics live here so they're testable; background.js owns the state and the console patch.

// One console call → one line. Objects are JSON'd (a console object arg is unreadable as "[object Object]")
// and the whole line is capped, because a single log of a full review bundle would otherwise eat the ring.
function devLogFormat(args, lineMax) {
  const max = Number(lineMax) > 0 ? Number(lineMax) : 1200;
  const one = (a) => {
    if (typeof a === "string") return a;
    if (a === null) return "null";
    if (a === undefined) return "undefined";
    if (a instanceof Error) return String(a.stack || a.message || a);
    if (typeof a === "object") { try { return JSON.stringify(a); } catch (e) { return String(a); } } // circular → String()
    return String(a);
  };
  const s = (Array.isArray(args) ? args : [args]).map(one).join(" ");
  return s.length > max ? s.slice(0, max) + `…(+${s.length - max} chars)` : s;
}

// Append with a hard cap, oldest evicted first. Returns how many were dropped so the caller can keep a
// cumulative count — a reader that sees dropped>0 knows its window missed lines rather than there being none.
function devLogAppend(ring, entry, max) {
  const cap = Number(max) > 0 ? Number(max) : 1200;
  ring.push(entry);
  if (ring.length <= cap) return 0;
  const dropped = ring.length - cap;
  ring.splice(0, dropped);
  return dropped;
}

// Cursor-based read: `since` is the last `n` the caller saw, so polling during a run returns only what's
// new. An over-limit result keeps the NEWEST lines and says so (`truncated`) — silently dropping the tail
// of a filtered query would read as "nothing more happened". A bad regex is reported, never thrown.
function devLogSelect(ring, opts) {
  const o = opts || {};
  const since = Number(o.since) || 0;
  let lines = (Array.isArray(ring) ? ring : []).filter((e) => e && Number(e.n) > since);
  let patternError = "";
  if (o.pattern) {
    try {
      const re = new RegExp(String(o.pattern), "i");
      lines = lines.filter((e) => re.test(String(e.msg || "")));
    } catch (e) { patternError = String((e && e.message) || e); }
  }
  const matched = lines.length;
  const limit = Number(o.limit) > 0 ? Number(o.limit) : 200;
  const truncated = matched > limit;
  if (truncated) lines = lines.slice(-limit);
  return { lines, matched, truncated, patternError };
}

// UMD-lite: export for the Node test runner; in the SW `module` is undefined so the
// functions simply stay globals (from importScripts).

// ── DID THE WEBSITE ACCEPT OUR REPORT? (2026-08-06) ──────────────────────────────────────────────────
// The push was fire-and-forget: any non-2xx was logged once at a normal volume and swallowed, so a
// rejected report meant the tracker silently stopped updating while fills looked perfectly healthy
// (live 2026-08-05: three fills in a row never reached the site). 401 has a specific, fixable cause
// worth naming rather than a generic failure: `syncEverything` MINTS a key and DELETES every prior one,
// so a sync from any other tab, window or dev server invalidates the key this extension holds.
// Pure so it can be tested; the caller does the logging and the storage marker.
function reportOutcome(status) {
  const code = Number(status);
  if (code >= 200 && code < 300) return { ok: true, loud: false, reason: null, message: null };
  if (code === 401 || code === 403) {
    return {
      ok: false, loud: true, reason: "stale-key",
      message: "THE WEBSITE REJECTED THIS REPORT (" + code + ") — nothing reached the tracker. The extension's " +
        "ingest key is stale: every \"Sync everything\" mints a NEW key and deletes the old one, so a sync from " +
        "another tab, window or dev server invalidates this one. Re-sync on /app/connect from the site you use.",
    };
  }
  if (!code) return { ok: false, loud: true, reason: "no-response", message: "THE REPORT NEVER GOT A RESPONSE — nothing reached the tracker (site down, or the wrong origin)." };
  return { ok: false, loud: true, reason: "http-" + code, message: "THE WEBSITE REJECTED THIS REPORT (" + code + ") — nothing reached the tracker." };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
  groupSelection, joinGroupValue, splitGroupValue, reviewValuesOf, isCompensationQuestion, isSignatureDateQuestion, signatureDateDemanded, signatureDateAskInText, isJobPostingGone, sameCalendarDate,
  skillBaseName, skillChipName, matchSkillOption, missingSkills, isSkillsFieldName, isSkillsEntry,
  skillTokens, skillContainmentEligible, skillWholeWordIn, reportOutcome,
  rejectedValueEntries,
  isPlaceholderOption, withoutPlaceholderOptions,
  isPlaceholderOption, withoutPlaceholderOptions, parseYearMonth, parseYearMonthDay, parseRepeatingFkit, parseNestedFkit, meaningfulEntries, meaningfulWorkExperience, sortWorkExperienceByRecency, workExperienceRecency, parseYear, joinBullets, ensureHttps, isFluent, normalize, fuzzyRatio, matchCandidates, isPolarityToken, polarityLeadIndex, sessionLooksDead, isWorkdayMaintenance, cdpPageKey, AI_NEEDS_ANSWER_MARK, isAiPlaceholder, unreplacedPlaceholders, parseErrorFieldName, errorSetUnchanged, normalizeLabel, errorLabelKey, mappedFieldsFromErrors, expandErrorSamples, externalGateHalt, isSelfIdPage, isDuplicateLanguageError, languageEntriesFromResults, languageDeletionPlan, isDuplicateWebsiteError, websiteEntriesFromResults, websiteDeletionPlan, duplicateErrorSection, sectionEntriesFromResults, sectionDeletionPlan, findLiveSection, liveDupEntries, newlyRequiredGaps, requiredBlankOnPage, requiredBlankByLabel, requiredEntriesAbsentFromScan, cascadeEntryFor, dateOrderOf, canonicalJobUrl, reconcileReviewPage, APPLY_BUTTON_CHAIN, APPLY_REJECT, pickApplyTarget, classifyAuthOutcome, ONBOARD_VERIFY_RX, ONBOARD_WRONG_RX, isWorkdaySoftError, looksLikeSso, isWorkdayHost, isBlankAuthPage, blankAuthPersists, BLANK_AUTH_MIN_READS, jobPageSettleStep, isAlreadyApplied, tenantCompanyFromUrl, classifyWorkdayPage, applyChainStuckMixed, isMyApplicationsPage, applicationStatusOf, reqIdFromUrl, pickApplicationRow, phantomRequiredTargets, devLogFormat, devLogAppend, devLogSelect, REGION_ABBREV };
}
