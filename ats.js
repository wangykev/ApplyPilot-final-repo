// ats.js — multi-ATS substrate + fill driver: Greenhouse / Lever / Ashby.
//
// These three ATSs are, compared to Workday, almost quaint: ONE page, NO login, NO session,
// NO server-held draft. Every visit starts from a blank form — so the fill stage and the
// submit stage are two visits to the same blank form (submit = re-fill from the APPROVED
// bundle, verify, then the gated click), not Workday's diff-replay. All three commit state
// from SYNTHETIC events (proven live 2026-07-31 — see docs/dom-patterns.md), so actuation
// runs page-side via Runtime.evaluate: identical visible/hidden, no Input.* pipeline, no
// focus emulation. The ONE trusted-input exception is the SUBMIT click (irreversible, and
// captcha vendors score event trust) — same rule as Workday's act.clickSubmit.
//
// Boundaries kept from the Workday path:
//   • "engine computes / service worker does I/O" — this file never touches chrome.storage;
//     background.js persists bundles and reports to the website.
//   • The safety contract: verify state after every actuation (read-back), never blind-commit
//     a guess (candidates clear the match ladder vs LIVE options), AI fills are always flagged.
//   • The review bundle is the SAME schema (fill-driver's buildReviewBundle consumes these
//     records verbatim), so the website review editor works unchanged.
//
// Load order: importScripts AFTER lib.js + fill-driver.js (uses their globals in the SW).
// Under Node the pure parts are require()able; the injected fns are self-contained.

// Namespace shims — Node gets the real modules, the SW gets the globals importScripts
// already evaluated. Only PURE helpers are listed (same rule as fill-driver's apMatch —
// and the same trap: adding a name here means it must exist in BOTH branches).
const atsLib = (typeof module !== "undefined" && module.exports)
  ? require("./lib.js")
  : { normalize: normalize, matchCandidates: matchCandidates, normalizeLabel: normalizeLabel,
      ensureHttps: ensureHttps, canonicalJobUrl: canonicalJobUrl, isAiPlaceholder: isAiPlaceholder,
      AI_NEEDS_ANSWER_MARK: AI_NEEDS_ANSWER_MARK, REGION_ABBREV: REGION_ABBREV };
const atsFd = (typeof module !== "undefined" && module.exports)
  ? require("./fill-driver.js")
  : { resolve: resolve, buildReviewBundle: buildReviewBundle, buildBucketIndex: buildBucketIndex,
      recognizeEmploymentQuestion: recognizeEmploymentQuestion, decideEmploymentStatus: decideEmploymentStatus,
      optionForPolarity: optionForPolarity, parseAiReply: parseAiReply, parseAiText: parseAiText,
      legallyLoaded: legallyLoaded, textValuesMatch: textValuesMatch, bundleSubmitBlockers: bundleSubmitBlockers,
      boolLadderCandidates: boolLadderCandidates, appendFieldVariants: appendFieldVariants };

// ── ATS detection + URL shaping (pure) ───────────────────────────────────────────────────

// Which ATS does a URL belong to? Only hosts whose FORM this file can drive return a value;
// Workday is named so callers can route to the existing pipeline explicitly.
function detectAts(url) {
  let host = "";
  try { host = new URL(String(url == null ? "" : url)).hostname.toLowerCase(); } catch (e) { return null; }
  if (/(^|\.)myworkday(jobs|site)\.com$/.test(host)) return "workday";
  if (host === "job-boards.greenhouse.io" || host === "boards.greenhouse.io" || host === "job-boards.eu.greenhouse.io" || host === "boards.eu.greenhouse.io") return "greenhouse";
  if (host === "jobs.lever.co" || host === "jobs.eu.lever.co") return "lever";
  if (host === "jobs.ashbyhq.com") return "ashby";
  return null;
}

// The URL the application FORM lives at, from a posting URL (2026-07-31 trace):
//   greenhouse — the form is ON the posting page (one page; legacy boards.* redirects itself).
//   lever      — /<co>/<uuid>/apply (the bare posting shows a JD + an Apply link).
//   ashby      — /<co>/<uuid>/application (a tab of the posting SPA).
// Idempotent: an already-form URL is returned unchanged (normalized).
function atsFormUrl(ats, url) {
  try {
    const u = new URL(String(url));
    const path = u.pathname.replace(/\/+$/, "");
    if (ats === "lever") {
      u.pathname = /\/apply$/i.test(path) ? path : path + "/apply";
      return u.origin + u.pathname; // Lever tracking params (?lever-origin=…) aren't needed to apply
    }
    if (ats === "ashby") {
      u.pathname = /\/application$/i.test(path) ? path : path + "/application";
      return u.origin + u.pathname;
    }
    return u.origin + u.pathname + u.search; // greenhouse: same page (gh_jid etc. kept — harmless)
  } catch (e) { return String(url == null ? "" : url); }
}

// Company slug from the URL path — the FALLBACK employment-question anchor when the JD
// scrape didn't produce a company (mirrors tenantCompanyFromUrl for Workday). First path
// segment on all three hosts: /anthropic/jobs/1 · /kraken123/<uuid>/apply · /openai/<uuid>.
function atsCompanyFromUrl(url) {
  try {
    const u = new URL(String(url));
    if (!detectAts(url) || detectAts(url) === "workday") return null;
    const seg = (u.pathname.split("/").filter(Boolean)[0] || "").replace(/[-_]+/g, " ").trim();
    if (!seg || seg === "embed") return null;
    return seg.split(" ").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
  } catch (e) { return null; }
}

// ── Static field maps (pure) ─────────────────────────────────────────────────────────────
// The stable per-ATS identities observed live (dom-patterns 2026-07-31). Everything not
// named here routes through the LABEL ladder (buckets → recognizers → employment → AI).
//   path     — profile path (getByPath + resolve, same as Workday's FIELD_MAP)
//   compose  — a derived value (full name, "City, State", current company)
//   website  — profile.websites[] entry by type
//   kind     — special handling: resume (the attach path), dial (the phone dial-code
//              composite whose options carry a trailing "+<digits>"), location (an async
//              place combobox), skip (deliberately left to the operator)
const ATS_STATIC_MAPS = {
  greenhouse: {
    "first_name": { path: "personal_info.first_name" },
    "last_name": { path: "personal_info.last_name" },
    "email": { path: "personal_info.email" },
    "phone": { path: "personal_info.phone_number" },
    // ⚠ NOT a country question — the phone widget's dial-code half. country_phone_code is the
    // profile's TIERED ladder for exactly this widget (same field Workday's countryPhoneCode
    // maps); bare `country` ("United States of America") misses the stripped option text
    // ("United States") — live 2026-07-31, the one skip in the first Anthropic fill.
    "country": { kind: "dial", path: "personal_info.country_phone_code", altPath: "personal_info.country" },
    "candidate-location": { kind: "location" },
    "resume": { kind: "resume" },
    "cover_letter": { kind: "skip", detail: "cover letter — operator-supplied (not modeled)" },
    // EEOC block — DETERMINISTIC from the operator's STATED self-identification (never
    // inferred). containment:true — each ATS words the long-form options its own way
    // ("No, I do not have a disability" ⊂ "… and have not had one in the past"); a unique
    // prefix hit commits at the CONTAINMENT tier, which grades filled_review (flagged).
    "gender": { path: "self_identification.gender", containment: true },
    "hispanic_ethnicity": { path: "self_identification.hispanic_or_latino", containment: true },
    "race": { path: "self_identification.race_ethnicity", containment: true },
    "veteran_status": { path: "self_identification.veteran_status", containment: true },
    "disability_status": { path: "self_identification.disability_status", containment: true },
  },
  lever: {
    "name": { compose: "full_name" },
    "email": { path: "personal_info.email" },
    "phone": { path: "personal_info.phone_number" },
    "org": { compose: "current_company" },
    "location": { kind: "location", compose: "city_state" }, // free text accepted (suggestions optional)
    "urls[LinkedIn]": { website: "linkedin" },
    "urls[GitHub]": { website: "github" },
    "urls[Portfolio]": { website: "portfolio" },
    "urls[Twitter]": { website: "twitter" },
    "urls[Other]": { website: "other" },
    "resume": { kind: "resume" },
    "comments": { kind: "skip", detail: "additional information — optional, operator's own voice" },
  },
  ashby: {
    "_systemfield_name": { compose: "full_name" },
    "_systemfield_email": { path: "personal_info.email" },
    "_systemfield_resume": { kind: "resume" },
    "_systemfield_location": { kind: "location", compose: "city_state" },
  },
};

// Derived values the profile doesn't store as one field.
function atsComposeValue(kind, profile) {
  const pi = (profile && profile.personal_info) || {};
  if (kind === "full_name") {
    const s = [pi.first_name, pi.last_name].filter(Boolean).join(" ").trim();
    return s || null;
  }
  if (kind === "city_state") {
    const s = [pi.city, pi.state_province].filter(Boolean).join(", ").trim();
    return s || null;
  }
  if (kind === "current_company" || kind === "current_title") {
    const we = Array.isArray(profile && profile.work_experience) ? profile.work_experience : [];
    // the current job wins; else the FIRST entry (prepareProfile orders by recency; a raw
    // profile is conventionally most-recent-first too)
    const cur = we.find((w) => w && w.currently_work_here) || we[0] || null;
    if (!cur) return null;
    const v = kind === "current_company" ? cur.company : cur.job_title;
    return (v && String(v).trim()) || null;
  }
  return null;
}

function atsWebsiteValue(profile, type) {
  const ws = Array.isArray(profile && profile.websites) ? profile.websites : [];
  const hit = ws.find((w) => w && String(w.type || "").toLowerCase() === type && String(w.url || "").trim());
  return hit ? atsLib.ensureHttps(hit.url) : null;
}

// ── The LABEL ladder (pure) — custom questions (question_* / cards[*] / uuid fields) ─────
// Ordered, first hit wins; every rung is a HIGH-PRECISION recognizer (a wrong deterministic
// answer is worse than an AI-flagged one — the Workday matching philosophy). Returns
//   { candidates?|value?, path?, source, review?, flag?, detail?, skip? }
// or null (→ bucket already consulted by the caller → AI → blank).
function atsRouteLabel(label, f, profile, defaults) {
  const L = String(label || "");
  const aq = (profile && profile.application_questions) || {};
  const wa = (profile && profile.work_authorization) || {};
  const si = (profile && profile.self_identification) || {};
  const pi = (profile && profile.personal_info) || {};
  const has = (v) => v !== undefined && v !== null && String(v).trim() !== "";
  const bool = (v) => (v === true ? ["Yes", "True"] : v === false ? ["No", "False"] : null);

  // Work authorization / sponsorship — the most common screening pair everywhere.
  // BAIL to AI on export-control-style wordings ("US person") — different legal fact.
  // ⚠ ORDER IS LOAD-BEARING: sponsorship FIRST, and the auth rung REFUSES any label
  // mentioning sponsor*. Scale AI words sponsorship as "…require company sponsorship to
  // retain or extend your WORK AUTHORIZATION…" — the auth rung matched that tail and
  // answered "Yes" (authorized) where the right answer was "No" (no sponsorship needed):
  // a SILENT WRONG deterministic fill, the one failure class the ladder exists to prevent
  // (live 2026-07-31, regression-pinned).
  // Every rung that resolves from a KNOWN profile field carries its `path` → the record's
  // mappedPath → the bundle's canonical_field. The teach page prefers canonical_field over
  // the LLM's maps_to hint, so a deterministic-but-flagged fill offers the RIGHT existing
  // field instead of "no existing field matched" (live 2026-07-31: Zoox "Race" — the EEO
  // rungs returned candidates with no path, so teach couldn't see race_ethnicity).
  if (/\bus person\b|export control/i.test(L)) return null;
  if (/sponsorship|sponsor.*visa|visa.*sponsor|require.*visa|need.*visa/i.test(L) && (wa.requires_sponsorship_now != null || wa.requires_sponsorship_future != null)) {
    const needs = !!wa.requires_sponsorship_now || !!wa.requires_sponsorship_future; // "now or in the future" — either
    return { candidates: bool(needs), source: "work_auth", path: "work_authorization.requires_sponsorship_now", detail: "work_authorization.requires_sponsorship_(now|future)" };
  }
  if (!/sponsor/i.test(L) && (/(authorized|legally able|eligible|legal right|right)\s.*\bwork\b|work authorization/i.test(L)) && wa.authorized_to_work_in_us != null) {
    return { candidates: bool(!!wa.authorized_to_work_in_us), source: "work_auth", path: "work_authorization.authorized_to_work_in_us", detail: "work_authorization.authorized_to_work_in_us" };
  }

  // Profile links.
  if (/linked\s*in/i.test(L)) { const v = atsWebsiteValue(profile, "linkedin"); if (v) return { value: v, source: "website" }; }
  if (/git\s*hub/i.test(L)) { const v = atsWebsiteValue(profile, "github"); if (v) return { value: v, source: "website" }; }
  if (/portfolio|personal (web)?site/i.test(L)) { const v = atsWebsiteValue(profile, "portfolio"); if (v) return { value: v, source: "website" }; }
  if (/\btwitter\b|\bx (profile|url)\b/i.test(L)) { const v = atsWebsiteValue(profile, "twitter"); if (v) return { value: v, source: "website" }; }
  if (/other website|website url/i.test(L)) { const v = atsWebsiteValue(profile, "other"); if (v) return { value: v, source: "website" }; }

  // ⚠ IDENTITY-FIELD ALIASES ("Phone" for phone_number, "Current Employer", country-of-
  // residence, preferred-name phrasings…) deliberately do NOT live here (operator
  // 2026-07-31: "don't secretly code them together on the backend — have them visible in
  // the question bucket so users keep control"). They ship as DEFAULT_ALIAS_WORDINGS in
  // the website's ensureDefaultFieldWordings (web/lib/teach.ts) — visible + editable on
  // /app/teach — and reach this driver through the ordinary BUCKET tier, which routes
  // BEFORE this label ladder. Only two things stay code-side, because no profile path can
  // express them: COMPOSED values (full name = first+last) and multi-fact LOGIC
  // (sponsorship = now||future, employment recognizers).
  if (/^(full |legal )?name$/i.test(L)) { const v = atsComposeValue("full_name", profile); if (v) return { value: v, source: "map", detail: "(full_name — composed; no single profile field)" }; }
  // Location questions on a combobox widget (Ashby's "Where are you currently located?"
  // has NO field identity at all — the label is the only durable key). kind:"location"
  // routes the driver to the type-then-scoped-read combobox flow.
  if (/where are you (currently )?(located|based)|current location|^location( \(city\))?$|city of residence/i.test(L)) {
    const v = atsComposeValue("city_state", profile);
    if (v) return { kind: "location", value: v, source: "map", path: "(city+state)" };
  }

  // Compensation + availability (STATED only — an empty profile value falls through to AI/blank).
  if (/salary|compensation|pay expectation|desired pay|expected (salary|pay)/i.test(L)) {
    const v = (aq.availability_and_preferences || {}).salary_expectation;
    if (has(v)) return { value: v, source: "map", detail: "salary_expectation" };
    return null;
  }
  if (/when can you start|start date|earliest.*(start|available)|available to (start|begin)/i.test(L)) {
    const ap = aq.availability_and_preferences || {};
    const v = ap.earliest_start_date || ap.available_for_full_employment_after;
    if (has(v)) return { value: v, source: "map", detail: "availability.earliest_start_date", review: true, flag: "start-date-format" };
    return null;
  }

  // How-did-you-hear — the same ladder the Workday source picker uses.
  if (/how did you (hear|find)|how'd you hear|where did you (hear|find)/i.test(L)) {
    const hdyh = (profile && profile.how_did_you_hear) || (defaults && defaults.how_did_you_hear);
    if (hdyh && Array.isArray(hdyh.preferred) && hdyh.preferred.length) return { candidates: [...hdyh.preferred], source: "map", path: "how_did_you_hear.preferred", detail: "how_did_you_hear.preferred" };
  }

  // EEO / demographics — deterministic ONLY from stated values (the Workday rule verbatim:
  // a stated demographic fills deterministically; AI never overrides; optional+unstated → blank).
  // containment:true — a STATED long-form demographic against each ATS's own phrasing
  // ("No, I do not have a disability" ⊂ "…, or have had one in the past") commits at the
  // CONTAINMENT tier, which the driver grades filled_review (flagged, human verifies) —
  // never silent, and the ambiguity guard still refuses a 2+-option hit.
  if (/hispanic|latino/i.test(L)) { if (has(si.hispanic_or_latino)) return { candidates: [si.hispanic_or_latino], source: "eeo", containment: true, path: "self_identification.hispanic_or_latino" }; return { eeoUnstated: true }; }
  if (/race|ethnicit/i.test(L)) { if (has(si.race_ethnicity)) return { candidates: [si.race_ethnicity], source: "eeo", containment: true, path: "self_identification.race_ethnicity" }; return { eeoUnstated: true }; }
  if (/veteran/i.test(L)) { if (has(si.veteran_status)) return { candidates: [si.veteran_status], source: "eeo", containment: true, path: "self_identification.veteran_status" }; return { eeoUnstated: true }; }
  if (/disabilit/i.test(L)) { if (has(si.disability_status)) return { candidates: [si.disability_status], source: "eeo", containment: true, path: "self_identification.disability_status" }; return { eeoUnstated: true }; }
  if (/gender|sex\b/i.test(L)) { if (has(si.gender)) return { candidates: [si.gender], source: "eeo", containment: true, path: "self_identification.gender" }; return { eeoUnstated: true }; }
  if (/pronoun/i.test(L)) return { skip: true, detail: "pronouns — not modeled in the profile (left blank)" };

  // Age gate (legally loaded — flag even though deterministic when stated).
  if (/\b(18|eighteen)\b.*(age|years|older)|age of 18|at least 18/i.test(L)) {
    const v = (aq.background_and_compliance || {}).at_least_18_years_old;
    if (v != null) return { candidates: bool(!!v), source: "map", path: "application_questions.background_and_compliance.at_least_18_years_old", detail: "at_least_18_years_old" };
    return null;
  }

  return null;
}

// ── Injected page functions (self-contained — stringified through act.eval) ─────────────
// Same idiom as cdpPageScan: no closures, JSON-able args/returns, re-resolve everything
// from document on every call (React re-renders orphan held nodes).

// ONE scanner for all three ATSs. Returns the unified field list:
//   { ats, url, title, fields: [{ fieldName, inputSel, widgetType, label, isRequired,
//                                 value, options?, group?, domIndex }] }
// fieldName is the STABLE identity (gh: element id · lever: name attr · ashby: name/uuid),
// inputSel resolves the primary control, and radio/checkbox groups collapse to ONE logical
// field (options = visible labels/values) exactly like Workday's radio grouping by name.
function atsInjScan(ats) {
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"));
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const txt = (el) => (el && el.textContent ? el.textContent.replace(/\s+/g, " ").trim() : "");
  const stripReq = (s) => String(s || "").replace(/[*✱]\s*$/, "").trim();
  const labelFor = (el) => {
    if (el.id) { const l = document.querySelector('label[for="' + esc(el.id) + '"]'); if (l) return txt(l); }
    const wrap = el.closest("label"); if (wrap) return txt(wrap);
    return null;
  };
  const out = { ats, url: location.href, title: document.title, fields: [] };
  const push = (d) => { d.domIndex = out.fields.length; out.fields.push(d); };
  const seen = new Set();

  if (ats === "greenhouse") {
    const form = document.querySelector("form"); if (!form) return out;
    // React-select combobox inputs (role=combobox) — includes EEOC + question_* selects.
    // The phone dial-code "country" and the intl-tel-input search box are recognized here too.
    for (const el of form.querySelectorAll("input, textarea")) {
      if (el.type === "hidden" || !vis(el.closest("div") || el)) continue;
      const id = el.id || "";
      if (!id || /^iti-|^g-recaptcha|^react-select/.test(id)) continue;
      if (/requiredInput/.test(String(el.className || ""))) continue; // the react-select native-validation mirror
      if (seen.has(id)) continue; seen.add(id);
      const isCombo = el.getAttribute("role") === "combobox";
      const label = stripReq(labelFor(el) || "");
      // required: aria-required OR the label's trailing * (stripped above, so re-test raw) OR
      // the react-select requiredInput mirror inside the same .select
      const rawLabel = labelFor(el) || "";
      const sel = el.closest(".select");
      const required = el.getAttribute("aria-required") === "true" || el.required === true ||
        /[*✱]\s*$/.test(rawLabel) || !!(sel && sel.querySelector('input[class*="requiredInput"]'));
      let widgetType, value = null;
      if (el.type === "file") { widgetType = "file_upload"; value = null; }
      else if (isCombo) {
        widgetType = id === "candidate-location" ? "location" : "select";
        const sv = sel ? sel.querySelector(".select__single-value") : null;
        value = sv ? txt(sv) : (el.value || null);
      } else if (el.tagName === "TEXTAREA") { widgetType = "textarea"; value = el.value || null; }
      else { widgetType = "text"; value = el.value || null; }
      push({ fieldName: id, inputSel: "#" + esc(id), widgetType, label: label || id, isRequired: required, value });
    }
    // file inputs are visually-hidden → the vis() filter above skips them; add explicitly.
    for (const f of form.querySelectorAll('input[type="file"]')) {
      const id = f.id || ""; if (!id || seen.has(id)) continue; seen.add(id);
      const chip = f.closest('[class*="field"]');
      push({ fieldName: id, inputSel: "#" + esc(id), widgetType: "file_upload", label: stripReq(labelFor(f) || id) || id, isRequired: id === "resume", value: chip && /\.pdf|\.docx?/i.test(txt(chip)) ? (txt(chip).match(/\S+\.(pdf|docx?)/i) || [null])[0] : null });
    }
    // checkbox groups (multi-select question_N[] customs).
    const cbByName = {};
    for (const cb of form.querySelectorAll('input[type="checkbox"]')) {
      if (!vis(cb.closest("div") || cb)) continue;
      const nm = cb.name || cb.id; if (!nm) continue;
      (cbByName[nm] = cbByName[nm] || []).push(cb);
    }
    for (const [nm, list] of Object.entries(cbByName)) {
      if (seen.has(nm)) continue; seen.add(nm);
      const qwrap = list[0].closest("fieldset") || list[0].closest('[class*="field"]');
      const legend = qwrap ? qwrap.querySelector("legend") : null;
      push({ fieldName: nm, inputSel: 'input[name="' + esc(nm) + '"]', widgetType: list.length > 1 ? "checkbox_group" : "checkbox",
        label: stripReq(legend ? txt(legend) : (labelFor(list[0]) || nm)), isRequired: list.some((c) => c.required || c.getAttribute("aria-required") === "true"),
        value: (list.filter((c) => c.checked).map((c) => labelFor(c) || c.value).join(", ")) || null,
        options: list.map((c) => labelFor(c) || c.value).filter(Boolean), group: "checkbox" });
    }
    return out;
  }

  if (ats === "lever") {
    const root = document.querySelector(".application-form, form") || document;
    const qLabel = (el) => {
      const q = el.closest(".application-question");
      if (q) { const t = q.querySelector(".application-label .text, .application-label, .text"); if (t) return txt(t); }
      return labelFor(el);
    };
    // grouped controls first (radio / checkbox by shared name) — ⚠ Lever's NodeList contains
    // TEMPLATE rows (a JSON blob / bare uuid as value) before the real options: visible-only.
    const groups = {};
    for (const r of root.querySelectorAll('input[type="radio"], input[type="checkbox"]')) {
      if (!vis(r.closest("label") || r)) continue;
      const nm = r.name || ""; if (!nm) continue;
      (groups[nm] = groups[nm] || []).push(r);
    }
    for (const [nm, list] of Object.entries(groups)) {
      seen.add(nm);
      const kind = list[0].type === "radio" ? "radio" : (list.length > 1 ? "checkbox_group" : "checkbox");
      const optLabel = (r) => { const l = r.closest("label"); return (l ? txt(l) : "") || r.value; };
      push({ fieldName: nm, inputSel: 'input[name="' + esc(nm) + '"]', widgetType: kind,
        label: stripReq(qLabel(list[0]) || nm), isRequired: list.some((r) => r.required),
        value: (list.filter((r) => r.checked).map(optLabel).join(", ")) || null,
        options: list.map((r) => r.value || optLabel(r)).filter(Boolean), group: list[0].type });
    }
    for (const el of root.querySelectorAll("input, textarea, select")) {
      if (el.type === "hidden" || el.type === "radio" || el.type === "checkbox") continue;
      const nm = el.name || el.id || ""; if (!nm || seen.has(nm)) continue;
      if (el.type !== "file" && !vis(el)) continue; // the file input is styled invisible on some themes
      seen.add(nm);
      const label = stripReq(qLabel(el) || nm);
      const required = el.required === true || /[*✱]\s*$/.test(qLabel(el) || "");
      if (el.type === "file") { push({ fieldName: nm, inputSel: el.id ? "#" + esc(el.id) : 'input[name="' + esc(nm) + '"]', widgetType: "file_upload", label, isRequired: required, value: (el.files && el.files[0] && el.files[0].name) || null }); continue; }
      if (el.tagName === "SELECT") { push({ fieldName: nm, inputSel: 'select[name="' + esc(nm) + '"]', widgetType: "dropdown_native", label, isRequired: required, value: el.selectedIndex > 0 ? txt(el.options[el.selectedIndex]) : null, options: [...el.options].map((o) => txt(o)).filter((t) => t && !/^select/i.test(t)) }); continue; }
      push({ fieldName: nm, inputSel: el.id ? "#" + esc(el.id) : (el.tagName === "TEXTAREA" ? "textarea" : "input") + '[name="' + esc(nm) + '"]',
        widgetType: el.tagName === "TEXTAREA" ? "textarea" : (nm === "location" ? "location" : "text"),
        label, isRequired: required, value: el.value || null });
    }
    return out;
  }

  // ashby — field units: the semantic .ashby-application-form-field-entry PLUS the
  // hashed `_fieldEntry_*` css-module class. The EEOC survey's entries and the consent
  // checkboxes carry ONLY the hashed one (live 2026-07-31, OpenAI) — the semantic class
  // marks just the main section. The `_fieldEntry` LOCAL NAME is stable across builds
  // (the hash suffix rotates); union + dedup, document order.
  const entrySet = new Set([
    ...document.querySelectorAll(".ashby-application-form-field-entry"),
    ...document.querySelectorAll('[class*="_fieldEntry"]'),
  ]);
  const entries = [...entrySet].sort((a, b) => (a.compareDocumentPosition(b) & 2 ? 1 : -1));
  for (const entry of entries) {
    // Yes/No button pair (hidden checkbox tracks state).
    const yesno = entry.querySelector('[class*="_yesno_"]');
    const cb = entry.querySelector('input[type="checkbox"]');
    const entryLabel = stripReq(txt(entry.querySelector("label")) || "");
    if (yesno && cb) {
      const nm = cb.name || cb.id; if (!nm || seen.has(nm)) continue; seen.add(nm);
      const picked = [...yesno.querySelectorAll("button")].find((b) => /_selected|active/i.test(String(b.className || "")) || b.getAttribute("aria-pressed") === "true");
      push({ fieldName: nm, inputSel: 'input[name="' + esc(nm) + '"]', widgetType: "yesno", label: entryLabel || nm,
        isRequired: cb.required === true || !!entry.querySelector('[class*="required"]'), value: picked ? txt(picked) : (cb.checked ? "Yes" : null), options: ["Yes", "No"] });
      continue;
    }
    // radio group(s) inside the entry (EEOC block: several logical questions can share one
    // entry). ⚠ NO `continue` here: Ramp nests its SMS-consent radios INSIDE the Phone
    // entry, so skipping to the next entry after the radios dropped the tel input entirely
    // (live 2026-07-31 — the phone field vanished from the scan). Radios are scanned, then
    // the generic input loop below still runs for the entry's OTHER inputs (dedup by seen).
    const radios = [...entry.querySelectorAll('input[type="radio"]')].filter((r) => r.name);
    if (radios.length) {
      const byName = {};
      for (const r of radios) (byName[r.name] = byName[r.name] || []).push(r);
      for (const [nm, list] of Object.entries(byName)) {
        if (seen.has(nm)) continue; seen.add(nm);
        // the question text: the nearest preceding label-ish node for this group — fall back
        // to the systemfield suffix ("__systemfield_gender" → "Gender").
        const sysm = /__systemfield_([a-z_]+)$/i.exec(nm);
        const qlbl = sysm ? sysm[1].replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : entryLabel;
        const optLabel = (r) => { const l = (r.id && document.querySelector('label[for="' + esc(r.id) + '"]')) || r.closest("label"); return (l ? txt(l) : "") || r.value; };
        const checked = list.find((r) => r.checked);
        push({ fieldName: nm, inputSel: 'input[name="' + esc(nm) + '"]', widgetType: "radio", label: qlbl || nm,
          isRequired: list.some((r) => r.required), value: checked ? optLabel(checked) : null, options: list.map(optLabel).filter(Boolean) });
      }
    }
    // consent checkboxes (one per entry, name = the label text itself — live, OpenAI).
    // NO `continue` (the Ramp nested-radio lesson): the generic loop below still runs for
    // any OTHER inputs sharing the entry; `seen` prevents double-scanning these.
    const soloCbs = [...entry.querySelectorAll('input[type="checkbox"]')];
    if (soloCbs.length && !entry.querySelector('input[type="radio"]') && !entry.querySelector('[class*="_yesno_"]')) {
      for (const cbx of soloCbs) {
        const nm = cbx.name || cbx.id; if (!nm || seen.has(nm)) continue; seen.add(nm);
        const l = (cbx.id && document.querySelector('label[for="' + esc(cbx.id) + '"]')) || cbx.closest("label");
        push({ fieldName: nm, inputSel: cbx.id ? "#" + esc(cbx.id) : 'input[name="' + esc(nm) + '"]', widgetType: "checkbox",
          label: stripReq((l ? txt(l) : "") || entryLabel || nm), isRequired: cbx.required === true, value: cbx.checked ? true : null });
      }
    }
    for (const el of entry.querySelectorAll("input, textarea")) {
      // radios/checkboxes were handled by the branches above (a leftover here would scan
      // as widgetType "text" — the fall-through made this reachable, so guard explicitly)
      if (el.type === "hidden" || el.type === "radio" || el.type === "checkbox") continue;
      const isCombo = el.getAttribute("role") === "combobox";
      // the location combobox has NO id and NO name (live, OpenAI) — STAMP one at scan
      // time (the discover data-ap-click idiom: React leaves foreign attributes alone
      // unless it remounts the node; a remount just kills the selector → an honest
      // needs_review, never a wrong fill — and every later pass re-scans fresh anyway).
      let nm = el.name || el.id || "";
      if (!nm && isCombo) {
        nm = "ap-ats-combobox-" + out.fields.length;
        try { el.id = nm; } catch (e) { continue; }
      }
      const inputSel = el.id ? "#" + esc(el.id) : 'input[name="' + esc(nm) + '"]';
      if (!nm || seen.has(nm)) continue;
      const isFile = el.type === "file";
      if (!isFile && !vis(el)) continue;
      seen.add(nm);
      const required = el.required === true;
      if (isFile) { push({ fieldName: nm, inputSel, widgetType: "file_upload", label: entryLabel || nm, isRequired: required, value: (el.files && el.files[0] && el.files[0].name) || null }); continue; }
      if (isCombo) { push({ fieldName: nm, inputSel, widgetType: "select", label: entryLabel || nm, isRequired: required, value: el.value || null }); continue; }
      if (el.tagName === "TEXTAREA") { push({ fieldName: nm, inputSel: "textarea[name=\"" + esc(nm) + "\"]", widgetType: "textarea", label: entryLabel || nm, isRequired: required, value: el.value || null }); continue; }
      const isDate = /pick date/i.test(el.placeholder || "");
      push({ fieldName: nm, inputSel, widgetType: isDate ? "date" : "text", label: entryLabel || nm, isRequired: required, value: el.value || null });
    }
  }
  return out;
}


// Set a text-like input/textarea: native setter + input/change (+blur-ish focusout) —
// the proven React commit pattern. Returns the read-back so the driver can verify.
function atsInjSetText(inputSel, value) {
  const el = document.querySelector(inputSel);
  if (!el) return { ok: false, error: "not-found:" + inputSel };
  const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  el.focus();
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.blur();
  el.dispatchEvent(new Event("focusout", { bubbles: true }));
  return { ok: true, after: el.value };
}

// Read one field's CURRENT live value (verify/audit) — same read rules as the scan.
function atsInjReadValue(ats, inputSel, widgetType) {
  const el = document.querySelector(inputSel);
  if (!el) return { ok: false, error: "not-found:" + inputSel };
  const txt = (n) => (n && n.textContent ? n.textContent.replace(/\s+/g, " ").trim() : "");
  if (widgetType === "select" || widgetType === "location" || widgetType === "dial") {
    const sel = el.closest(".select");
    const sv = sel ? sel.querySelector(".select__single-value") : null;
    if (sv) return { ok: true, value: txt(sv) };
    return { ok: true, value: el.value || null };
  }
  if (widgetType === "dropdown_native") return { ok: true, value: el.selectedIndex > 0 ? txt(el.options[el.selectedIndex]) : null };
  if (widgetType === "radio" || widgetType === "checkbox_group") {
    const list = [...document.querySelectorAll(inputSel)];
    const on = list.filter((r) => r.checked);
    const lab = (r) => { const l = (r.id && document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(r.id) : r.id) + '"]')) || r.closest("label"); return (l ? txt(l) : "") || r.value; };
    return { ok: true, value: on.length ? on.map(lab).join(", ") : null };
  }
  if (widgetType === "checkbox") return { ok: true, value: !!el.checked };
  if (widgetType === "yesno") {
    const entry = el.closest(".ashby-application-form-field-entry");
    const picked = entry && [...entry.querySelectorAll("button")].find((b) => /_selected|active/i.test(String(b.className || "")) || b.getAttribute("aria-pressed") === "true");
    return { ok: true, value: picked ? txt(picked) : (el.checked ? "Yes" : null) };
  }
  if (widgetType === "file_upload") return { ok: true, value: (el.files && el.files[0] && el.files[0].name) || null };
  return { ok: true, value: el.value || null };
}

// Open a combobox (GH react-select / Ashby select) and read its options, SCOPED to the
// widget's own listbox — the Workday chip-contamination lesson holds verbatim here: a
// page-wide `.select__option` read returns OTHER open menus' options (observed live).
function atsInjOpenAndReadOptions(inputSel) {
  const el = document.querySelector(inputSel);
  if (!el) return { ok: false, error: "not-found:" + inputSel };
  const fire = (n, t) => n.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
  const container = el.closest(".select__container") || el.closest('[class*="_input"]')?.parentElement || el.parentElement;
  const ctrl = (container && (container.querySelector(".select__control") || container)) || el;
  const already = el.getAttribute("aria-expanded") === "true";
  if (!already) { fire(ctrl, "mousedown"); fire(ctrl, "mouseup"); fire(ctrl, "click"); }
  return { ok: true, opened: true, already };
}

function atsInjReadOptions(inputSel) {
  const el = document.querySelector(inputSel);
  if (!el) return { ok: false, error: "not-found:" + inputSel };
  // Scope: react-select names its listbox react-select-<name>-listbox and options
  // react-select-<name>-option-N; aria-controls / aria-owns carries the id when open.
  const listboxId = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
  let scope = listboxId ? document.getElementById(listboxId) : null;
  if (!scope) {
    const container = el.closest(".select__container") || el.closest(".ashby-application-form-field-entry") || document;
    scope = container.querySelector('.select__menu, [role="listbox"]') || null;
  }
  if (!scope) return { ok: true, open: false, options: [] };
  const opts = [...scope.querySelectorAll('[role="option"], .select__option')].map((o) => ({
    text: (o.textContent || "").replace(/\s+/g, " ").trim(),
    disabled: o.getAttribute("aria-disabled") === "true",
  })).filter((o) => o.text);
  return { ok: true, open: true, options: opts };
}

// Type into an open combobox's input (native setter + input) — react-select filters live.
function atsInjTypeInCombo(inputSel, text) {
  const el = document.querySelector(inputSel);
  if (!el) return { ok: false, error: "not-found:" + inputSel };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  el.focus();
  setter.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return { ok: true };
}

// Commit an option BY TEXT inside the scoped listbox (synthetic mousedown/click — proven
// to commit react-select live). Returns the committed display value for the verify gate.
function atsInjCommitOption(inputSel, optionText) {
  const el = document.querySelector(inputSel);
  if (!el) return { ok: false, error: "not-found:" + inputSel };
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const listboxId = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
  let scope = listboxId ? document.getElementById(listboxId) : null;
  if (!scope) {
    const container = el.closest(".select__container") || el.closest(".ashby-application-form-field-entry") || document;
    scope = container.querySelector('.select__menu, [role="listbox"]');
  }
  if (!scope) return { ok: false, error: "no-open-listbox" };
  const target = [...scope.querySelectorAll('[role="option"], .select__option')].find((o) => norm(o.textContent) === norm(optionText));
  if (!target) return { ok: false, error: "option-not-found" };
  const fire = (n, t) => n.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
  fire(target, "mousedown"); fire(target, "mouseup"); fire(target, "click");
  return { ok: true };
}

// Close any open react-select menus WITHOUT committing (blur + outside mousedown). The
// verify is value-based (the driver re-reads), mirroring closeAndVerifyBlank's philosophy.
function atsInjCloseCombo(inputSel) {
  const el = document.querySelector(inputSel);
  if (el) el.blur();
  document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
  return { ok: true };
}

// Radio / checkbox-group commit: click the option's LABEL (native label activation —
// the Workday radio lesson) matched by option label OR value, within the named group.
function atsInjCheckOption(inputSel, optionText, wantOn) {
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const list = [...document.querySelectorAll(inputSel)];
  if (!list.length) return { ok: false, error: "not-found:" + inputSel };
  const lab = (r) => (r.id && document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(r.id) : r.id) + '"]')) || r.closest("label");
  const target = list.find((r) => norm(r.value) === norm(optionText) || norm(lab(r) && lab(r).textContent) === norm(optionText));
  if (!target) return { ok: false, error: "option-not-found", offered: list.map((r) => r.value || (lab(r) ? lab(r).textContent.trim() : "")).slice(0, 12) };
  const clickEl = lab(target) || target;
  if (wantOn === false && target.checked) { clickEl.click(); }
  else if (target.checked !== (wantOn !== false)) { clickEl.click(); }
  target.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, checked: target.checked };
}

// Single checkbox (consents).
function atsInjSetChecked(inputSel, on) {
  const el = document.querySelector(inputSel);
  if (!el) return { ok: false, error: "not-found:" + inputSel };
  const lab = (el.id && document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]')) || el.closest("label");
  if (!!el.checked !== !!on) (lab || el).click();
  if (!!el.checked !== !!on) { el.checked = !!on; el.dispatchEvent(new Event("change", { bubbles: true })); }
  return { ok: true, checked: !!el.checked };
}

// Ashby Yes/No button pair.
function atsInjClickYesNo(inputSel, want) {
  const cb = document.querySelector(inputSel);
  if (!cb) return { ok: false, error: "not-found:" + inputSel };
  const entry = cb.closest(".ashby-application-form-field-entry");
  if (!entry) return { ok: false, error: "no-field-entry" };
  const btn = [...entry.querySelectorAll("button")].find((b) => (b.textContent || "").trim().toLowerCase() === String(want).toLowerCase());
  if (!btn) return { ok: false, error: "button-not-found", offered: [...entry.querySelectorAll("button")].map((b) => (b.textContent || "").trim()) };
  btn.click();
  return { ok: true };
}

// Lever's location typeahead (live 2026-07-31): free text is CLEARED on blur (the widget
// requires a suggestion pick), and the suggestion RENDER never happens in a hidden tab
// (0 rows through 20 polls with every unfreeze lever applied). But the widget's own
// backend is a plain same-origin GET — `/searchLocations?text=…` → [{name, id}] — and a
// suggestion CLICK just writes the visible input + the hidden `selectedLocation` JSON.
// So: fetch the rows ourselves (fetch is NOT throttled hidden — the discover lesson) and
// write exactly the state a click writes. Match policy stays SW-side; these fns only do IO.
async function atsInjLeverLocLookup(query) {
  try {
    const res = await fetch("/searchLocations?text=" + encodeURIComponent(String(query)), { credentials: "same-origin" });
    if (!res.ok) return { ok: false, error: "http-" + res.status };
    const rows = await res.json();
    return { ok: true, rows: (Array.isArray(rows) ? rows : []).filter((r) => r && r.name && r.id).slice(0, 20) };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

function atsInjLeverLocCommit(name, id) {
  const el = document.querySelector("#location-input");
  const hid = document.querySelector('input[name="selectedLocation"]');
  if (!el || !hid) return { ok: false, error: "location inputs not found" };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(el, name);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  hid.value = JSON.stringify({ name: name, id: id });
  hid.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.blur();
  el.dispatchEvent(new Event("focusout", { bubbles: true }));
  return { ok: true, v: el.value, selected: !!hid.value };
}

// Attach the resume: rebuild the File page-side (strings only across the boundary — the
// attachResume lesson), set input.files via DataTransfer, dispatch change.
function atsInjAttachFile(inputSel, base64, filename, mime) {
  const el = document.querySelector(inputSel);
  if (!el) return { ok: false, error: "not-found:" + inputSel };
  try {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], filename, { type: mime });
    const dt = new DataTransfer();
    dt.items.add(file);
    el.files = dt.files;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return { ok: true, fileCount: el.files.length, name: el.files[0] && el.files[0].name };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// The submit control + captcha/confirmation state — READ-ONLY (the click itself is the
// caller's, trusted, and gated). One reader for everything the gate needs to see.
function atsInjSubmitState(ats) {
  const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  let btn = null;
  if (ats === "lever") btn = document.querySelector("#btn-submit");
  if (!btn) btn = [...document.querySelectorAll('button[type="submit"], button')].find((b) => /submit application|submit$/i.test((b.textContent || "").trim()) && vis(b));
  const r = btn ? btn.getBoundingClientRect() : null;
  // a VISIBLE captcha challenge. ⚠ Lever's DORMANT invisible-mode hCaptcha container is a
  // FULL-VIEWPORT iframe (1547×720 live) with `visibility:hidden` — a size-only test calls
  // it a challenge and falsely halts the submit run (live 2026-07-31). A real checkbox is
  // ~300×74 and a challenge popup ~400×580 — both COMPUTED-visible and under ~700px wide.
  const challenge = [...document.querySelectorAll('iframe[src*="hcaptcha"], iframe[src*="recaptcha"]')].some((f) => {
    const cs = getComputedStyle(f);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.1) return false;
    const fr = f.getBoundingClientRect();
    return fr.width > 60 && fr.height > 60 && fr.width < 700;
  });
  const bodyText = (document.body.innerText || "").slice(0, 4000);
  const confirmed = /thank(s| you) for (applying|your application)|application (was |has been )?(submitted|received)|we('ve| have) received your application/i.test(bodyText) || /\/thanks(\?|$)/.test(location.href);
  return { ok: true, hasSubmit: !!btn, rect: r ? { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2), w: r.width } : null,
    disabled: btn ? (btn.disabled || btn.getAttribute("aria-disabled") === "true") : null, captchaChallenge: challenge, confirmed, url: location.href };
}

// Validation errors after a refused submit — per-ATS error nodes + a generic fallback.
function atsInjErrors(ats) {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const sels = ats === "greenhouse" ? '[class*="error" i][class*="field" i], [id$="-error"], [role="alert"]'
    : ats === "lever" ? '.application-question.invalid, [class*="error" i], [role="alert"]'
      : '[class*="error" i], [role="alert"]';
  const out = [];
  for (const el of document.querySelectorAll(sels)) {
    if (!vis(el)) continue;
    const t = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (t && t.length < 300 && !out.includes(t)) out.push(t);
  }
  return { ok: true, errors: out.slice(0, 20) };
}

// ── The driver (SW-side) ─────────────────────────────────────────────────────────────────
// driveAtsPageFill(act, ats, profile, defaults, jobContext, opts) — the multi-ATS analog of
// drivePageFill. act = { eval(fn,…args), delay(ms), delayFull(ms), llm, aiEnabled,
// attachResume(ref) } (attachResume is SW-supplied — it owns the IndexedDB read).
// Produces Workday-record-compatible results; buildReviewBundle consumes them verbatim.

const ATS_REVIEW_WIDGET = { // scan widgetType → the review schema's widget_type vocabulary
  text: "text", textarea: "textarea", select: "dropdown", dial: "dropdown", location: "typeahead",
  dropdown_native: "dropdown", radio: "radio", checkbox: "checkbox", checkbox_group: "checkbox_group",
  yesno: "radio", file_upload: "file_upload", date: "date", unknown: "unknown",
};

// Options for a dial-code select carry a trailing "+<digits>" ("United States +1") that no
// profile value will ever contain — strip it for matching, commit by the FULL text.
function atsDialStrip(optText) { return String(optText || "").replace(/\s*\+\d[\d\s-]*$/, "").trim(); }

// ── APPLY-ELSEWHERE REDIRECT (operator 2026-07-31, the Anthropic/Constellation pattern) ──
// Some postings host a DECOY form: "Please note that you will not be considered unless you
// complete the Constellation application form… You do not need to submit this Greenhouse
// application." The REAL application is the partner link — filling/submitting the hosted
// form is worthless. Detection is STRONG-PHRASE only (precision over recall — a false
// positive abandons a fillable application): the page must literally say this form doesn't
// count. LOCKSTEP: the same pattern is inlined in atsInjDetectRedirect (injected fns can't
// reference module scope).
const ATS_REDIRECT_STRONG_RE = /(do(?:es)?\s*n[o']t|not)\s+(?:need|have|required)\s+to\s+(?:submit|complete|fill\s+out)\s+this\s+(?:greenhouse|lever|ashby)?\s*application|will\s+not\s+be\s+considered\s+unless\s+you\s+(?:complete|apply|submit)/i;

// Pick the redirect anchor from the page's off-host links. Scored, first bucket wins:
//   1. anchor TEXT says "apply" ("Apply using this link", "apply here", "application form")
//   2. anchor sits in the SAME text block as the strong phrase
//   3. href itself looks like an application form (apply|application|form in the URL)
// 2+ DISTINCT hrefs in the winning bucket → ambiguous → null (report, never guess).
function atsPickRedirectAnchor(anchors) {
  const list = (anchors || []).filter((a) => a && a.href);
  const uniq = (arr) => [...new Set(arr.map((a) => a.href))];
  const byText = list.filter((a) => /\bapply\b|application\s+form/i.test(String(a.text || "")));
  if (uniq(byText).length === 1) return byText[0].href;
  if (uniq(byText).length > 1) return null;
  const near = list.filter((a) => a.nearPhrase);
  if (uniq(near).length === 1) return near[0].href;
  if (uniq(near).length > 1) return null;
  const byHref = list.filter((a) => /apply|application|form/i.test(String(a.href)));
  if (uniq(byHref).length === 1) return byHref[0].href;
  return null;
}

// Injected: does THIS page carry the apply-elsewhere note, and which off-host anchors could
// be the real link? Read-only; the PICK stays SW-side (atsPickRedirectAnchor — testable).
function atsInjDetectRedirect() {
  // LOCKSTEP with the module-scope strong-phrase regex above (unreachable from an injected fn)
  const strong = /(do(?:es)?\s*n[o']t|not)\s+(?:need|have|required)\s+to\s+(?:submit|complete|fill\s+out)\s+this\s+(?:greenhouse|lever|ashby)?\s*application|will\s+not\s+be\s+considered\s+unless\s+you\s+(?:complete|apply|submit)/i;
  const body = document.body ? document.body.innerText || "" : "";
  const m = strong.exec(body);
  if (!m) return { redirect: false };
  // the text block(s) holding the phrase — for the nearPhrase signal
  const phraseNodes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const n = walker.currentNode;
    if (n.textContent && strong.test(n.textContent)) { const el = n.parentElement && n.parentElement.closest("p, div, section, label, li"); if (el) phraseNodes.push(el); }
  }
  const anchors = [...document.querySelectorAll('a[href^="http"]')].map((a) => {
    let off = false;
    try { off = new URL(a.href).host !== location.host; } catch (e) { off = false; }
    if (!off) return null;
    return {
      href: a.href,
      text: (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
      nearPhrase: phraseNodes.some((p) => p.contains(a) || (a.closest("p, div, section, label, li") || a).parentElement === p.parentElement),
    };
  }).filter(Boolean).slice(0, 60);
  return { redirect: true, phrase: (body.match(strong) || [""])[0].slice(0, 160), anchors };
}

// Is this label a demographic question? ORTHOGONAL to routing (2026-07-31, Zoox): a BUCKET
// can route an EEO field before the label ladder's EEO rung runs, and the bucket carries no
// containment — so "Asian" missed Zoox's "Asian (Not Hispanic or Latino)" even though the
// stated-EEO relief exists. The relief keys off the LABEL, whatever tier produced the value.
function atsIsEeoLabel(label) {
  return /hispanic|latino|race|ethnicit|veteran|disabilit|gender|\bsex\b/i.test(String(label || ""));
}

async function atsAiChooseOption(act, f, options, profile, jobContext) {
  // AI-1's contract, re-hosted: ALWAYS-GUESS for a required choice; the reply is a CANDIDATE
  // that must clear the match ladder vs the LIVE options; ALWAYS flagged for review.
  const optTexts = options.map((o) => (typeof o === "string" ? o : o.text)).filter(Boolean);
  const system = "You fill job application forms for a candidate. Choose EXACTLY ONE option from the provided list that best answers the question for this candidate. Reply ONLY with JSON: {\"choice\":\"<verbatim option>\",\"justification\":\"<short; name the profile fact or say reasoning-from-absence>\",\"confidence\":\"High|Medium|Low\",\"maps_to\":\"<profile field path or empty>\",\"suggested_category\":\"<short category>\"}";
  const user = "QUESTION: " + (f.label || f.fieldName) + "\nOPTIONS:\n" + optTexts.map((t) => "- " + t).join("\n") +
    "\nCOMPANY: " + ((jobContext && jobContext.company) || "unknown") +
    (jobContext && jobContext.title ? "\nROLE: " + jobContext.title : "") +
    (jobContext && jobContext.description ? "\nJOB DESCRIPTION (for context):\n" + String(jobContext.description).slice(0, 4000) : "") +
    "\nCANDIDATE PROFILE (JSON):\n" + JSON.stringify(profile).slice(0, 12000);
  const res = await act.llm({ system, user, maxTokens: 400 });
  if (!res || !res.ok) return { ok: false, error: (res && res.error) || "llm-failed" };
  const parsed = atsFd.parseAiReply(res.text);
  if (!parsed || !parsed.choice) return { ok: false, error: "unparseable-reply" };
  return { ok: true, choice: parsed.choice, justification: parsed.justification || "", confidence: parsed.confidence || "Low", maps_to: parsed.maps_to || "", suggested_category: parsed.suggested_category || "" };
}

async function atsAiWriteText(act, f, profile, jobContext) {
  const system = "You draft answers to job-application questions in the candidate's own plain, professional first-person voice. If the question needs a factual answer the profile clearly holds, give it concisely. Reply ONLY with JSON: {\"answer\":\"<the text to enter>\",\"confidence\":\"High|Medium|Low\",\"justification\":\"<short>\",\"maps_to\":\"\",\"suggested_category\":\"\"} — or {\"answer\":null} if you have no basis at all.";
  const style = ((profile || {}).application_questions || {}).writing_style || "";
  const user = "QUESTION: " + (f.label || f.fieldName) +
    "\nCOMPANY: " + ((jobContext && jobContext.company) || "unknown") +
    (jobContext && jobContext.title ? "\nROLE: " + jobContext.title : "") +
    (jobContext && jobContext.description ? "\nJOB DESCRIPTION (ground your answer in what the role actually is):\n" + String(jobContext.description).slice(0, 4000) : "") +
    (style ? "\nSTYLE RULES: " + style : "") +
    "\nCANDIDATE PROFILE (JSON):\n" + JSON.stringify(profile).slice(0, 12000);
  const res = await act.llm({ system, user, maxTokens: 700 });
  if (!res || !res.ok) return { ok: false, error: (res && res.error) || "llm-failed" };
  const parsed = atsFd.parseAiText(res.text); // {skip, answer, reason, maps_to?, suggested_category?}
  if (!parsed || parsed.skip || !String(parsed.answer || "").trim()) return { ok: false, error: (parsed && parsed.reason) || "ai-declined" };
  return { ok: true, answer: parsed.answer, confidence: "Low", justification: parsed.reason || "generated from profile" };
}

// Route ONE scanned field to a value/candidates decision. Pure given its inputs.
// Order: static map → bucket (exact wording) → label recognizers → employment recognizer →
// null (the driver then tries AI for REQUIRED fields, else leaves blank). Same tiering as
// the Workday driver: deterministic tiers run for optional fields too, AI is required-only.
function atsRouteField(ats, f, profile, defaults, jobContext, bucketIndex) {
  const map = (ATS_STATIC_MAPS[ats] || {})[f.fieldName];
  if (map) {
    if (map.kind === "resume") return { kind: "resume", source: "map" };
    if (map.kind === "skip") return { kind: "skip", source: "map", detail: map.detail };
    if (map.kind === "location") {
      const v = atsComposeValue("city_state", profile);
      return v ? { kind: map.kind, value: v, source: "map", path: "(city+state)" } : { kind: "skip", source: "map", detail: "no city/state in profile" };
    }
    if (map.compose) {
      const v = atsComposeValue(map.compose, profile);
      if (v != null) return { value: v, source: "map", path: "(" + map.compose + ")" };
      // fall through — an empty compose (no work history for `org`) still gets the
      // bucket/label rungs (an unstated EEO must reach the eeoUnstated rung below).
    } else if (map.path) {
      const get = (p) => p.split(".").reduce((o, k) => (o == null ? undefined : o[k]), profile);
      const nonEmpty = (v) => v !== undefined && v !== null && !(typeof v === "string" && !v.trim()) && !(Array.isArray(v) && !v.length);
      const raw = nonEmpty(get(map.path)) ? get(map.path) : (map.altPath && nonEmpty(get(map.altPath)) ? get(map.altPath) : undefined);
      if (raw !== undefined) return { raw, path: map.path, kind: map.kind || null, source: "map", containment: !!map.containment };
      // empty mapped value → fall through (same reason as above)
    }
  }
  // Buckets — the operator's own taught wordings, exact-normalized (no fuzzy; misses fall
  // through). Mode A (profile_path) + Mode B (value list) both become candidates/value.
  if (bucketIndex && f.label) {
    const b = bucketIndex.get ? bucketIndex.get(atsLib.normalizeLabel(f.label)) : bucketIndex[atsLib.normalizeLabel(f.label)];
    if (b) {
      if (b.profile_path) {
        const raw = String(b.profile_path).split(".").reduce((o, k) => (o == null ? undefined : o[k]), profile);
        if (raw !== undefined && raw !== null && String(raw).trim() !== "") return { raw, path: b.profile_path, source: "bucket" };
      }
      const vals = Array.isArray(b.value) ? b.value.filter((x) => typeof x === "string" && x.trim()) : (typeof b.value === "string" && b.value.trim() ? [b.value] : []);
      if (vals.length) return { candidates: vals, source: "bucket" };
    }
  }
  const routed = atsRouteLabel(f.label, f, profile, defaults);
  if (routed) return routed;
  // Employment-status recognizer (the "have you worked for «company» before?" class) —
  // the same deterministic tier the Workday driver runs, sentence-scoped + bail-guarded.
  // Contract (fill-driver): recognize → {tense, company} | null; decide → {fill, review,
  // detail} where fill:null = unevaluable → blank + review, NEVER a guess.
  const company = (jobContext && jobContext.company) || null;
  const er = atsFd.recognizeEmploymentQuestion(f.label, company);
  if (er) {
    const dec = atsFd.decideEmploymentStatus(er.tense, company, profile, f.label);
    if (dec && dec.fill) return { candidates: [dec.fill], source: "employment", review: !!dec.review, flag: dec.review ? "employer-match" : null, detail: dec.detail || "employment-status recognizer" };
    return { kind: "employment-blank", review: true, flag: "employer-match", detail: (dec && dec.detail) || "employment question unevaluable — left blank" };
  }
  return null;
}

async function driveAtsPageFill(act, ats, profile, defaults, jobContext, opts) {
  const o = opts || {};
  const bucketIndex = atsFd.buildBucketIndex(o.buckets);
  const scan = await act.eval(atsInjScan, ats);
  const results = [];
  const company = (jobContext && jobContext.company) || atsCompanyFromUrl(scan.url);
  const jc = Object.assign({}, jobContext, { company });

  await atsFillFields(act, ats, scan, scan.fields, results, profile, defaults, jc, bucketIndex, o);

  // CASCADE RE-SCAN (the Workday M1 pattern, earned again 2026-07-31 on Ramp): these SPAs
  // mount sections in BURSTS, and even a 3-consecutive-reads settle can catch a pause —
  // the run scanned 8 fields while Phone + Resume were still mounting. One read-only
  // re-scan after the fill; anything NOT yet in results (late-mounted OR revealed by a
  // committed value) gets the identical routing + actuation, tagged cascadeRevealed.
  for (let round = 0; round < 2; round++) {
    await act.delayFull(900);
    let rescan = null;
    try { rescan = await act.eval(atsInjScan, ats); } catch (e) { break; }
    if (!rescan || !rescan.fields) break;
    const seen = new Set(results.map((r) => r.fieldName));
    const fresh = rescan.fields.filter((f) => !seen.has(f.fieldName));
    if (!fresh.length) break;
    try { console.log(`[ApplyPilot][ATS-FILL] cascade round ${round + 1}: ${fresh.length} late-mounted field(s) — ${fresh.map((f) => f.fieldName).slice(0, 6).join(", ")}`); } catch (e) { /* log */ }
    const before = results.length;
    await atsFillFields(act, ats, rescan, fresh, results, profile, defaults, jc, bucketIndex, o);
    for (let i = before; i < results.length; i++) results[i].cascadeRevealed = true;
  }

  return await atsFinishFill(act, ats, scan, results);
}

// The per-field fill loop — extracted so the cascade pass runs the IDENTICAL ladder.
async function atsFillFields(act, ats, scan, fields, results, profile, defaults, jc, bucketIndex, o) {
  for (const f of fields) {
    const rec = {
      fieldName: f.fieldName, label: f.label, widgetType: ATS_REVIEW_WIDGET[f.widgetType] || f.widgetType,
      isRequired: !!f.isRequired, mappedPath: null, rawValue: null, resolved: null,
      status: null, matchTier: null, confidence: null, flag: null, verified: null, after: null, detail: null,
    };
    const ref = { inputSel: f.inputSel, widgetType: f.widgetType };
    try {
      // Replay mode: the value comes from the APPROVED bundle, not the profile (the submit
      // run re-fills a blank form). Everything else — actuation + verify — is identical.
      let route = null;
      if (o.valueFor) {
        const v = o.valueFor(f);
        if (v === undefined) { rec.status = "skipped"; rec.detail = "no approved entry for this field"; results.push(rec); continue; }
        route = f.widgetType === "file_upload" ? { kind: "resume", source: "replay" } : { value: v, source: "replay" };
      } else {
        route = atsRouteField(ats, f, profile, defaults, jc, bucketIndex);
      }

      if (route && route.kind === "resume") {
        const att = await act.attachResume(ref);
        Object.assign(rec, att.ok
          ? { status: "filled", after: att.name || "resume attached", detail: att.detail || null, verified: !!att.verified }
          : { status: f.isRequired ? "needs_review" : "skipped", detail: "resume attach failed: " + (att.error || "unknown"), flag: "resume-attach-failed" });
        results.push(rec); continue;
      }
      if (route && (route.kind === "skip" || route.skip)) { rec.status = "skipped"; rec.detail = route.detail || "deliberately left to the operator"; results.push(rec); continue; }
      if (route && route.kind === "employment-blank") { rec.status = "needs_review"; rec.flag = route.flag || "employer-match"; rec.detail = route.detail; results.push(rec); continue; }
      if (route && route.eeoUnstated) { rec.status = "skipped"; rec.detail = "demographic not stated in profile — left blank (never inferred)"; rec.flag = "eeo_declined"; results.push(rec); continue; }

      rec.mappedPath = (route && (route.path || null)) || null;
      rec.rawValue = route ? (route.raw !== undefined ? route.raw : (route.value != null ? route.value : (route.candidates || null))) : null;
      if (route && route.source === "bucket") rec.flag = "bucket";

      // Coerce to candidates through the SAME resolve() the Workday driver uses (booleans →
      // Yes/No ladders, arrays pass through as tiered lists).
      let candidates = null; let textValue = null;
      if (route) {
        if (route.candidates) candidates = route.candidates.slice();
        else if (route.raw !== undefined) {
          const isChoice = ["select", "dial", "radio", "yesno", "checkbox_group", "dropdown_native", "location"].includes(f.widgetType);
          const rr = atsFd.resolve(route.raw, isChoice ? "dropdown" : "text");
          if (rr.skip) { /* falls through to AI/blank */ }
          else if (rr.candidates) candidates = rr.candidates;
          else if (rr.value !== undefined) { textValue = String(rr.value); candidates = [String(rr.value)]; }
        } else if (route.value != null) { textValue = String(route.value); candidates = [String(route.value)]; }
        if (route.path && candidates) candidates = atsFd.appendFieldVariants(profile, route.path, candidates);
      }

      // The ROUTE can refine the widget (map kind "dial": the scan sees an ordinary select;
      // only the mapping knows its options carry a "+<digits>" tail that must strip for
      // matching — the country-skip bug, live 2026-07-31).
      const effF = route && (route.kind === "dial" || route.kind === "location")
        ? Object.assign({}, f, { widgetType: route.kind === "dial" ? "dial" : (ats === "lever" ? "location" : (f.widgetType === "select" ? "location" : f.widgetType)) })
        : f;
      // containment relief for STATED values: the route may flag it (EEO rungs / static
      // maps), OR the label is demographic regardless of which tier produced the value
      // (a bucket routes before the EEO rung and carries no flag — the Zoox race miss).
      const mopts = { containment: !!(route && route.containment) || (!!candidates && atsIsEeoLabel(f.label)) };
      const produced = await atsActuateField(act, ats, effF, ref, rec, candidates, textValue, jc, profile, mopts);
      if (!produced) {
        // Deterministic tiers produced nothing. AI fallback — REQUIRED fields only (the
        // operator rule: an optional blank costs nothing; a required blank blocks submit).
        if (f.isRequired && act.aiEnabled && ["select", "dial", "radio", "yesno", "checkbox_group", "dropdown_native", "textarea", "text", "location", "date"].includes(f.widgetType)) {
          await atsAiFallback(act, ats, f, ref, rec, jc, profile);
        } else if (rec.status == null) {
          rec.status = "skipped";
          rec.detail = rec.detail || (candidates ? "no candidate matched the live options" : "no profile mapping for this question");
        }
      }
      // Route-level review force (employment "Yes" etc.).
      if (route && route.review && rec.status === "filled") rec.status = "filled_review";
      if (route && route.flag && !rec.flag) rec.flag = route.flag;
      if (route && route.detail && !rec.detail) rec.detail = route.detail;
    } catch (e) {
      rec.status = "error";
      rec.detail = String((e && e.message) || e);
    }
    results.push(rec);
    try { console.log(`[ApplyPilot][ATS-FILL] ${rec.fieldName} (${rec.widgetType}${rec.isRequired ? ", req" : ""}) → ${rec.status}${rec.matchTier ? " · " + rec.matchTier : ""}${rec.flag ? " · " + rec.flag : ""}${rec.after != null ? " · after=" + JSON.stringify(String(rec.after).slice(0, 60)) : ""}${rec.detail ? " · " + rec.detail : ""}`); } catch (e) { /* log only */ }
  }
}

// The audit + envelope — extracted with the loop (see atsFillFields).
async function atsFinishFill(act, ats, scan, results) {
  // M40-lite AUDIT: one independent re-read after the page settles — a record must never
  // claim a value the page no longer holds (the false-verify class).
  await act.delayFull(600);
  for (const rec of results) {
    if (rec.status !== "filled" && rec.status !== "filled_review") continue;
    const f = scan.fields.find((x) => x.fieldName === rec.fieldName);
    if (!f || f.widgetType === "file_upload") continue;
    try {
      const live = await act.eval(atsInjReadValue, ats, f.inputSel, f.widgetType);
      if (!live || !live.ok) { rec.flag = rec.flag || "audit-unverifiable"; continue; }
      const liveV = live.value == null ? "" : String(live.value);
      const recV = rec.after == null ? "" : String(rec.after);
      // a chip DISPLAY that is a substring of the recorded option text is a match (the dial
      // select renders "+1" for the committed "United States +1" — same accept rule as the
      // fill-time verify).
      const chipSubstring = liveV && recV.toLowerCase().includes(liveV.toLowerCase());
      if (f.widgetType === "checkbox" ? String(!!live.value) !== String(rec.after === true || rec.after === "true") : !(atsFd.textValuesMatch(liveV, recV) || chipSubstring)) {
        rec.status = "needs_review"; rec.flag = "audit-mismatch";
        rec.detail = (rec.detail ? rec.detail + "; " : "") + "audit: page now holds " + JSON.stringify(liveV);
        rec.after = liveV || null;
      }
    } catch (e) { rec.flag = rec.flag || "audit-unverifiable"; }
  }

  const counts = results.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
  return { url: scan.url, title: scan.title, results, counts, needsReview: results.filter((r) => r.status === "needs_review" || r.status === "filled_review") };
}

// Actuate one field with the resolved candidates. Returns true when it produced an outcome
// (filled / filled_review / needs_review with a real attempt), false when nothing was
// attempted (→ AI/blank fallback). Every commit is read-back-verified.
async function atsActuateField(act, ats, f, ref, rec, candidates, textValue, jobContext, profile, mopts) {
  const wt = f.widgetType;
  const allowContainment = !!(mopts && mopts.containment); // default OFF — the "containment is a guess" rule

  // Lever location: type → the widget's own suggestions → click a row → verify the
  // committed value + the hidden selectedLocation (free text is CLEARED on blur — a
  // bare write can never stick; live-verified 2026-07-31).
  if (wt === "location" && ats === "lever") {
    if (!candidates || !candidates.length) return false;
    rec.resolved = candidates;
    const query = String(candidates[0]);
    const lk = await act.eval(atsInjLeverLocLookup, query);
    const rows = (lk && lk.rows) || [];
    if (!rows.length) { rec.status = f.isRequired ? "needs_review" : "skipped"; rec.detail = "location lookup returned nothing" + (lk && lk.error ? " (" + lk.error + ")" : "") + " for " + JSON.stringify(query); return true; }
    // Prefer city + state (abbrev via REGION_ABBREV: "Florida" → ", FL,"), else the first
    // city row at the flagged containment tier — never an unrelated place silently.
    const city = query.split(",")[0].trim().toLowerCase();
    const state = (query.split(",")[1] || "").trim().toLowerCase();
    const abbrev = (atsLib.REGION_ABBREV && atsLib.REGION_ABBREV[state]) || null;
    const cityRows = rows.filter((r) => r.name.toLowerCase().startsWith(city));
    let pick = cityRows.find((r) => (abbrev && new RegExp(",\\s*" + abbrev + "\\b", "i").test(r.name)) || (state && r.name.toLowerCase().includes(state)));
    let tier = pick ? "exact-normalized" : null;
    if (!pick && cityRows.length) { pick = cityRows[0]; tier = "containment"; }
    if (!pick) { rec.status = f.isRequired ? "needs_review" : "skipped"; rec.detail = "no suggestion matched " + JSON.stringify(query) + " — offered: " + rows.slice(0, 3).map((r) => r.name).join(" | "); rec.options = rows.map((r) => r.name); return true; }
    const c = await act.eval(atsInjLeverLocCommit, pick.name, pick.id);
    await act.delay(150);
    rec.after = c && c.v ? c.v : null;
    rec.options = rows.map((r) => r.name);
    const okv = !!(c && c.ok && c.v && c.selected);
    rec.status = okv ? (tier === "exact-normalized" ? "filled" : "filled_review") : "needs_review";
    rec.matchTier = tier; rec.verified = okv;
    if (!okv) rec.detail = "location commit did not persist (selectedLocation empty)";
    else if (tier === "containment") { rec.flag = rec.flag || "non-exact-match"; rec.detail = "picked the first city match — verify the state"; }
    return true;
  }

  // text-likes: one deterministic write + read-back.
  if (wt === "text" || wt === "textarea" || wt === "date") {
    if (textValue == null && candidates && candidates.length) textValue = candidates[0];
    if (textValue == null || String(textValue).trim() === "") return false;
    rec.resolved = textValue;
    const r = await act.eval(atsInjSetText, ref.inputSel, String(textValue));
    await act.delay(120);
    if (!r || !r.ok) { rec.status = "needs_review"; rec.detail = "set failed: " + ((r && r.error) || "unknown"); return true; }
    const back = await act.eval(atsInjReadValue, ats, ref.inputSel, wt);
    rec.after = back && back.ok ? back.value : r.after;
    const okv = atsFd.textValuesMatch(String(rec.after == null ? "" : rec.after), String(textValue));
    rec.status = okv ? "filled" : "needs_review";
    rec.verified = okv;
    if (!okv) rec.detail = "read-back mismatch (wanted " + JSON.stringify(String(textValue)) + ")";
    if (wt === "date" && okv) { rec.status = "filled_review"; rec.flag = rec.flag || "date-format-unverified"; rec.detail = rec.detail || "date entered as text — verify the widget accepted the format"; }
    return true;
  }

  // combobox family (react-select + ashby selects + GH location + the dial composite).
  if (wt === "select" || wt === "dial" || wt === "location") {
    if (!candidates || !candidates.length) return false;
    rec.resolved = candidates;
    await act.eval(atsInjOpenAndReadOptions, ref.inputSel);
    await act.delay(250);
    // async comboboxes (location): type the query first so options exist to read.
    if (wt === "location") {
      await act.eval(atsInjTypeInCombo, ref.inputSel, String(candidates[0]).split(",")[0]);
      await act.delayFull(900); // places lookup — real network time, never scaled
    }
    let read = await act.eval(atsInjReadOptions, ref.inputSel);
    if ((!read || !read.open || !read.options.length) && wt !== "location") {
      // some selects only populate after a keystroke — poke once with the first candidate
      await act.eval(atsInjTypeInCombo, ref.inputSel, String(candidates[0]).slice(0, 3));
      await act.delayFull(600);
      read = await act.eval(atsInjReadOptions, ref.inputSel);
    }
    const options = (read && read.options) || [];
    if (!options.length) {
      rec.status = f.isRequired ? "needs_review" : "skipped";
      // GH location note (2026-07-31, Figma): the places lookup can hang on "Loading…" with ZERO
      // network — google.maps never loads in some browsers, so even a HUMAN typing gets no options.
      // Name that in the review row instead of a bare "did not render".
      rec.detail = wt === "location"
        ? "location suggestions never loaded (the form's places service didn't respond — it may be broken in this browser; answer it in the tab before submitting)"
        : "options did not render";
      await act.eval(atsInjCloseCombo, ref.inputSel);
      return true;
    }
    const texts = options.filter((o) => !o.disabled).map((o) => o.text);
    const matchTexts = wt === "dial" ? texts.map(atsDialStrip) : texts;
    let hit = null;
    if (wt === "location") {
      // a places list: accept the first suggestion CONTAINING the city (they're all real
      // places for the typed query; flag anything that isn't an exact city+state read).
      const city = String(candidates[0]).split(",")[0].trim().toLowerCase();
      const idx = texts.findIndex((t) => t.toLowerCase().includes(city));
      if (idx >= 0) hit = { index: idx, tier: texts[idx].toLowerCase().startsWith(city) ? "exact-normalized" : "containment" };
    } else {
      const m = atsLib.matchCandidates(candidates, matchTexts, { containment: allowContainment });
      if (m && m.targetIndex >= 0) hit = { index: m.targetIndex, tier: m.matchTier };
      // stated Yes/No-leading value → the unique same-polarity option (the contraction
      // bridge — see the radio path; select twin for GH's EEO dropdowns).
      if (!hit && allowContainment) {
        const lead = /^(yes|no)\b/i.exec(String(candidates[0] || ""));
        const pol = lead ? atsFd.optionForPolarity(matchTexts, lead[1][0].toUpperCase() + lead[1].slice(1).toLowerCase()) : null;
        if (pol) hit = { index: matchTexts.indexOf(pol), tier: "polarity-lead" };
      }
    }
    if (!hit) { await act.eval(atsInjCloseCombo, ref.inputSel); rec.detail = "no candidate matched " + texts.length + " option(s); candidates=" + JSON.stringify(candidates.slice(0, 4)) + " sample=" + JSON.stringify((wt === "dial" ? matchTexts : texts).slice(0, 3)); rec.options = texts.slice(0, 60); return false; }
    const commitText = texts[hit.index];
    const c = await act.eval(atsInjCommitOption, ref.inputSel, commitText);
    await act.delay(200);
    const back = await act.eval(atsInjReadValue, ats, ref.inputSel, wt);
    rec.after = back && back.ok ? back.value : null;
    rec.options = texts.slice(0, 60);
    const backNorm = atsLib.normalize(String(rec.after == null ? "" : rec.after));
    const wantNorm = atsLib.normalize(commitText);
    // the dial composite renders "+1" (flag+code), not the option text — value-based accept:
    // any non-empty committed value whose text is IN the chosen option counts.
    // chip-substring accept for ANY select, not just wt==="dial": the REPLAY path runs as a
    // plain select (no route → no dial override) and must accept the "+1" chip for the
    // committed "United States +1" too. A non-empty display CONTAINED in the option we
    // clicked is still strong evidence of the right commit (a wrong option isn't a superstring).
    const okv = backNorm === wantNorm || (backNorm && wantNorm.includes(backNorm)) || (wt === "location" && !!backNorm);
    if (c && c.ok && okv) {
      rec.status = hit.tier === "exact-normalized" || hit.tier === "label-exact" ? "filled" : "filled_review";
      rec.matchTier = hit.tier; rec.verified = true;
      // Record the COMMITTED OPTION TEXT, not the chip display: the dial chip renders "+1"
      // while the option we clicked is "United States +1" — a bundle holding "+1" can never
      // replay (live 2026-07-31, the GH rehearsal's one failure). The option text is the
      // truthful "what was chosen"; the audit accepts the chip as a substring of it.
      rec.after = commitText;
      if (rec.status === "filled_review" && !rec.flag) rec.flag = "non-exact-match";
    } else {
      rec.status = "needs_review"; rec.verified = false;
      rec.detail = "commit did not persist (read " + JSON.stringify(rec.after) + " wanted " + JSON.stringify(commitText) + ")";
      await act.eval(atsInjCloseCombo, ref.inputSel);
    }
    return true;
  }

  if (wt === "dropdown_native") {
    if (!candidates || !candidates.length) return false;
    rec.resolved = candidates;
    const texts = f.options || [];
    let m = atsLib.matchCandidates(candidates, texts, { containment: allowContainment });
    // the stated-EEO polarity bridge, native-select twin (see the radio path)
    if ((!m || m.targetIndex < 0) && allowContainment) {
      const lead = /^(yes|no)\b/i.exec(String(candidates[0] || ""));
      const pol = lead ? atsFd.optionForPolarity(texts, lead[1][0].toUpperCase() + lead[1].slice(1).toLowerCase()) : null;
      if (pol) m = { targetIndex: texts.indexOf(pol), matchTier: "polarity-lead" };
    }
    if (!m || m.targetIndex < 0) { rec.detail = "no candidate matched " + texts.length + " option(s)"; rec.options = texts; return false; }
    const r = await act.eval(atsInjSelectNative, ref.inputSel, texts[m.targetIndex]);
    await act.delay(120);
    const back = await act.eval(atsInjReadValue, ats, ref.inputSel, wt);
    rec.after = back && back.ok ? back.value : null;
    rec.options = texts;
    const okv = atsLib.normalize(String(rec.after || "")) === atsLib.normalize(texts[m.targetIndex]);
    rec.status = okv ? (m.matchTier === "exact-normalized" ? "filled" : "filled_review") : "needs_review";
    rec.matchTier = m.matchTier; rec.verified = okv;
    if (!okv) rec.detail = "native select commit failed";
    return true;
  }

  if (wt === "radio" || wt === "checkbox_group") {
    if (!candidates || !candidates.length) return false;
    rec.resolved = candidates;
    const texts = (f.options || []).slice();
    const m = atsLib.matchCandidates(candidates, texts, { containment: allowContainment });
    let pick = m && m.targetIndex >= 0 ? texts[m.targetIndex] : null;
    let tier = m && m.targetIndex >= 0 ? m.matchTier : null;
    if (!pick) {
      // Yes/No-leading polarity (the Workday optionForPolarity rule) for boolean ladders —
      // and, for STATED long-form values (EEO, allowContainment), for a candidate that merely
      // LEADS with Yes/No: "No, I do not have a disability" maps to the unique No-leading
      // option even when the ATS words it "No, I don't have…" (a contraction neither
      // containment nor fuzzy can bridge — live 2026-07-31, Ashby). Flagged (polarity-lead
      // grades filled_review); 2+ same-polarity options still refuse.
      const lead = /^(yes|no)\b/i.exec(String(candidates[0] || ""));
      const polKey = candidates[0] === "Yes" || candidates[0] === "No" ? candidates[0] : (allowContainment && lead ? (lead[1][0].toUpperCase() + lead[1].slice(1).toLowerCase()) : null);
      const pol = polKey ? atsFd.optionForPolarity(texts, polKey) : null;
      if (pol) { pick = pol; tier = "polarity-lead"; }
    }
    if (!pick) { rec.detail = "no candidate matched " + texts.length + " option(s)"; rec.options = texts; return false; }
    const r = await act.eval(atsInjCheckOption, ref.inputSel, pick, true);
    await act.delay(150);
    const back = await act.eval(atsInjReadValue, ats, ref.inputSel, wt);
    rec.after = back && back.ok ? back.value : null;
    rec.options = texts;
    // accept when the click landed AND the read-back holds the picked option (a pre-checked
    // equal value also reads correct — same "state, not click outcome" rule as Workday).
    const readNorm = atsLib.normalize(String(rec.after || ""));
    const okv = readNorm === atsLib.normalize(pick) || (!!(r && r.ok) && readNorm.includes(atsLib.normalize(pick).slice(0, 40)));
    rec.status = okv ? (tier === "exact-normalized" || tier === "label-exact" ? "filled" : "filled_review") : "needs_review";
    rec.matchTier = tier; rec.verified = okv;
    if (!okv) rec.detail = "radio commit not reflected (read " + JSON.stringify(rec.after) + ")";
    return true;
  }

  if (wt === "yesno") {
    if (!candidates || !candidates.length) return false;
    rec.resolved = candidates;
    const want = candidates.find((c) => c === "Yes" || c === "No") || candidates[0];
    const r = await act.eval(atsInjClickYesNo, ref.inputSel, want);
    await act.delay(150);
    const back = await act.eval(atsInjReadValue, ats, ref.inputSel, wt);
    rec.after = back && back.ok ? back.value : null;
    rec.options = f.options || ["Yes", "No"];
    const okv = !!(r && r.ok) && atsLib.normalize(String(rec.after || "")) === atsLib.normalize(want);
    rec.status = okv ? "filled" : "needs_review";
    rec.verified = okv;
    if (!okv) rec.detail = "yes/no click not reflected (read " + JSON.stringify(rec.after) + ")";
    return true;
  }

  if (wt === "checkbox") {
    // Consent semantics — the Workday rule: REQUIRED → auto-check (silent); optional with a
    // mapped true → check; otherwise leave (blank optional is the correct resting state).
    const explicitTrue = candidates && candidates.length && /^(yes|true)$/i.test(String(candidates[0]));
    const explicitFalse = candidates && candidates.length && /^(no|false)$/i.test(String(candidates[0]));
    if (!f.isRequired && !explicitTrue) { if (!explicitFalse) return false; rec.status = "skipped"; rec.detail = "profile refuses this optional checkbox — left unchecked"; return true; }
    if (f.isRequired && explicitFalse) { rec.status = "needs_review"; rec.detail = "required checkbox the profile refuses — not auto-consenting"; return true; }
    rec.resolved = true;
    const r = await act.eval(atsInjSetChecked, ref.inputSel, true);
    await act.delay(120);
    rec.after = r && r.ok ? String(!!r.checked) : null;
    rec.status = r && r.ok && r.checked ? "filled" : "needs_review";
    rec.verified = !!(r && r.ok && r.checked);
    if (rec.status === "filled" && !f.isRequired) rec.status = "filled_review"; // an optional box we chose to tick — show the human
    return true;
  }

  return false; // unknown widget — AI/blank fallback decides
}

// Native <select> (Lever custom dropdowns).
function atsInjSelectNative(inputSel, optionText) {
  const el = document.querySelector(inputSel);
  if (!el) return { ok: false, error: "not-found:" + inputSel };
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const idx = [...el.options].findIndex((o) => norm(o.textContent) === norm(optionText));
  if (idx < 0) return { ok: false, error: "option-not-found" };
  el.selectedIndex = idx;
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return { ok: true };
}

// AI fallback for a REQUIRED field the deterministic tiers left empty. Same safety contract
// as AI-1/AI-2: the choice must clear the match ladder vs live options; ALWAYS flagged.
async function atsAiFallback(act, ats, f, ref, rec, jobContext, profile) {
  const wt = f.widgetType;
  try {
    if (wt === "textarea" || wt === "text" || wt === "date") {
      const ai = await atsAiWriteText(act, f, profile, jobContext);
      if (!ai.ok || !ai.answer) {
        // REQUIRED text the AI can't ground: write "N/A" — a real, submittable answer that reads
        // correctly on the form (operator 2026-07-31: "never answer with AI declined, N/A would be
        // better"; live, the Kraken conditional "if yes, tell us more…" sat next to an answered
        // "No", where N/A IS the truthful answer). Machine jargon must never reach an employer's
        // form. SAFETY IS UNCHANGED: the record stays needs_review, so `requiresApproval` blocks
        // submit until a human either edits it or knowingly approves the N/A.
        const NA = "N/A";
        await act.eval(atsInjSetText, ref.inputSel, NA);
        const back = await act.eval(atsInjReadValue, ats, ref.inputSel, wt);
        rec.after = back && back.ok && back.value != null ? back.value : NA;
        rec.status = "needs_review"; rec.flag = "ai-no-basis";
        rec.detail = "the AI had no basis for this REQUIRED question — entered \"N/A\"; replace it or approve the N/A" +
          (ai && ai.error && ai.error !== "ai-declined" ? " (" + ai.error + ")" : "");
        return;
      }
      const r = await act.eval(atsInjSetText, ref.inputSel, String(ai.answer));
      const back = await act.eval(atsInjReadValue, ats, ref.inputSel, wt);
      rec.after = back && back.ok ? back.value : (r && r.after) || null;
      rec.status = "filled_review"; // ALWAYS flagged — never silent AI text
      rec.flag = "ai-text"; rec.confidence = String(ai.confidence || "low").toLowerCase();
      rec.detail = "AI: " + (ai.justification || "generated answer");
      rec.maps_to = ""; rec.suggested_category = "";
      return;
    }
    // choice widgets: read live options (radio/yesno carry them on the scan; combobox opens).
    let texts = f.options || [];
    if (wt === "select" || wt === "dial" || wt === "location" || wt === "dropdown_native") {
      if (wt !== "dropdown_native") {
        await act.eval(atsInjOpenAndReadOptions, ref.inputSel);
        await act.delayFull(400);
        const read = await act.eval(atsInjReadOptions, ref.inputSel);
        texts = ((read && read.options) || []).filter((o) => !o.disabled).map((o) => o.text);
      }
    }
    if (!texts.length) { rec.status = "needs_review"; rec.detail = "AI fallback: no live options to choose from"; return; }
    const ai = await atsAiChooseOption(act, f, texts, profile, jobContext);
    if (!ai.ok) { rec.status = "needs_review"; rec.detail = "AI fallback failed: " + ai.error; return; }
    const m = atsLib.matchCandidates([ai.choice], texts, { containment: true });
    if (!m || m.targetIndex < 0) { rec.status = "needs_review"; rec.detail = "AI chose " + JSON.stringify(ai.choice) + " — not a live option"; return; }
    const pick = texts[m.targetIndex];
    let committed;
    if (wt === "radio" || wt === "checkbox_group") committed = await act.eval(atsInjCheckOption, ref.inputSel, pick, true);
    else if (wt === "yesno") committed = await act.eval(atsInjClickYesNo, ref.inputSel, pick);
    else if (wt === "dropdown_native") committed = await act.eval(atsInjSelectNative, ref.inputSel, pick);
    else committed = await act.eval(atsInjCommitOption, ref.inputSel, pick);
    await act.delay(200);
    const back = await act.eval(atsInjReadValue, ats, ref.inputSel, wt);
    rec.after = back && back.ok ? back.value : null;
    rec.options = texts.slice(0, 60);
    const okv = committed && committed.ok && String(rec.after || "").trim() !== "";
    rec.status = okv ? "filled_review" : "needs_review"; // AI is NEVER a silent fill
    rec.resolved = [ai.choice];
    rec.confidence = String(ai.confidence || "low").toLowerCase();
    rec.flag = atsFd.legallyLoaded(f.label) ? "ai-choice-sensitive" : "ai-choice";
    rec.detail = "AI: " + (ai.justification || "inferred") + (okv ? "" : " — commit failed");
    rec.maps_to = ai.maps_to || ""; rec.suggested_category = ai.suggested_category || "";
  } catch (e) {
    rec.status = "needs_review";
    rec.detail = "AI fallback exception: " + String((e && e.message) || e);
  }
}

// ── UMD-lite export (Node tests) ─────────────────────────────────────────────────────────
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    detectAts, atsFormUrl, atsCompanyFromUrl, ATS_STATIC_MAPS, atsComposeValue, atsWebsiteValue,
    atsRouteLabel, atsRouteField, atsDialStrip, ATS_REVIEW_WIDGET, driveAtsPageFill, atsActuateField,
    atsAiFallback, atsAiChooseOption, atsAiWriteText,
    ATS_REDIRECT_STRONG_RE, atsPickRedirectAnchor, atsInjDetectRedirect,
    atsInjScan, atsInjSetText, atsInjReadValue, atsInjOpenAndReadOptions, atsInjReadOptions,
    atsInjTypeInCombo, atsInjCommitOption, atsInjCloseCombo, atsInjCheckOption, atsInjSetChecked,
    atsInjClickYesNo, atsInjAttachFile, atsInjSubmitState, atsInjErrors, atsInjSelectNative,
  };
}
