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
      AI_NEEDS_ANSWER_MARK: AI_NEEDS_ANSWER_MARK, REGION_ABBREV: REGION_ABBREV,
      isSignatureDateQuestion: isSignatureDateQuestion };
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
  // ⚠ iCIMS is the ONE suffix test here, and it is deliberate: unlike the three above, iCIMS gives
  // every customer its own subdomain (astrioncareers-astrion.icims.com, careers-acme.icims.com), so
  // an exact-host allowlist cannot work. ANCHORED at a dot or start so `icims.com.evil.com` and
  // `fakeicims.com` still return null — the same discipline test/ats.test.js pins for the others.
  if (/(^|\.)icims\.com$/.test(host)) return "icims";
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
    // ⚠ iCIMS falls to the default below, and KEEPING THE QUERY IS LOAD-BEARING — not incidental
    // like greenhouse's gh_jid. An iCIMS apply link carries the one-time magic-link session in
    // `?eem=…&code=…`; strip it and the run lands on a sign-in page with no form at all.
    return u.origin + u.pathname + u.search; // greenhouse: same page (gh_jid etc. kept — harmless)
  } catch (e) { return String(url == null ? "" : url); }
}

// Company slug from the URL path — the FALLBACK employment-question anchor when the JD
// scrape didn't produce a company (mirrors tenantCompanyFromUrl for Workday). First path
// segment on all three hosts: /anthropic/jobs/1 · /kraken123/<uuid>/apply · /openai/<uuid>.
function atsCompanyFromUrl(url) {
  try {
    const u = new URL(String(url));
    const kind = detectAts(url);
    if (!kind || kind === "workday") return null;
    // ⚠ iCIMS puts the company in the SUBDOMAIN, not the path — path segment 0 is the literal
    // "jobs", which would hand the safety-critical employment recognizer the anchor "Jobs" and make
    // every "have you worked for us before?" question compare against a word no employer is called.
    // The subdomain is `<portal>-<tenant>` (astrioncareers-astrion) or a bare tenant; the LAST
    // hyphen segment is the tenant, and a trailing careers/jobs token is portal naming, not a name.
    if (kind === "icims") {
      let label = (u.hostname.toLowerCase().split(".")[0] || "");
      const parts = label.split("-").filter(Boolean);
      let seg = parts.length > 1 ? parts[parts.length - 1] : label;
      seg = seg.replace(/(careers|jobs|portal)$/i, "").trim();
      if (!seg) return null;
      return seg[0].toUpperCase() + seg.slice(1);
    }
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
  // iCIMS (traced live 2026-08-16 — astrioncareers-astrion.icims.com, 118 controls inside
  // `#icims_content_iframe`). Unlike the three above, these ids are PLATFORM fields, not per-customer
  // ones: `PersonProfileFields.*` / `PortalProfileFields.*` are iCIMS' own vocabulary and should hold
  // on every tenant. Per-customer questions are the `rcf<NNNN>` ids, which are deliberately NOT mapped
  // — they route through the label ladder like every other custom question.
  //
  // ⚠ Only the UN-PREFIXED fields are mapped. Address/phone arrive as `-1_PersonProfileFields.*`,
  // where the leading integer is a REPEATING-ENTRY ordinal, and the same ids recur inside work-history
  // entries — where an "address" is the EMPLOYER's, not the applicant's. Mapping them by bare id would
  // put the candidate's home address into a past job. Left to a later round, deliberately.
  icims: {
    // ── The "Create a login" block. THIS ACCOUNT IS CREATED BY THE SUBMISSION ──────────────
    // Not a sign-in form and not a profile edit: on this class of application the account is created
    // as part of submitting, so the credential block is simply another section of the form and must
    // be filled like any other. A prepopulated value is REPLACED — the account this application
    // creates has to use the credentials stored on the website. See the credential tier in
    // atsRouteField for the safety properties that make that safe.
    "PersonProfileFields.Login": { kind: "credential", credentialKind: "login" },
    "PersonProfileFields.Password": { kind: "credential", credentialKind: "password" },
    "PersonProfileFields.Password_Confirm": { kind: "credential", credentialKind: "password_confirm" },
    // ── Identity ──────────────────────────────────────────────────────────────────────────
    // ⚠ Email is the PROFILE's address and is deliberately NOT the login above: the two are allowed to
    // differ (a plus-addressed account login against a plain contact address), and conflating them
    // would silently file the application under the wrong contact.
    "PersonProfileFields.FirstName": { path: "personal_info.first_name" },
    "PersonProfileFields.MiddleName": { path: "personal_info.middle_name" },
    "PersonProfileFields.LastName": { path: "personal_info.last_name" },
    "PersonProfileFields.Email": { path: "personal_info.email" },
    // ── The candidate's own address (a REPEATING section: "Add More (Addresses)") ──────────
    // Keyed WITHOUT the entry ordinal — the live ids are `-1_PersonProfileFields.AddressCity`, and
    // the ordinal is stripped before this lookup (see atsMapKey). Safe to key by id here precisely
    // because `PersonProfileFields.Address*` is iCIMS' own vocabulary for the CANDIDATE's address:
    // a work-history employer address is a per-customer `rcf<NNNN>` group, so it cannot collide.
    // ⚠ Country is TIERED in the profile (an array), which resolve() passes through as a ready-made
    // candidate ladder — that is what lets "United States of America" fall back to "United States",
    // which is the text this form actually offers.
    "PersonProfileFields.AddressStreet1": { path: "personal_info.address_line_1" },
    "PersonProfileFields.AddressStreet2": { path: "personal_info.address_line_2" },
    "PersonProfileFields.AddressCity": { path: "personal_info.city" },
    "PersonProfileFields.AddressZip": { path: "personal_info.postal_code" },
    "PersonProfileFields.AddressCountry": { path: "personal_info.country" },
    "PersonProfileFields.AddressState": { path: "personal_info.state_province" },
    // ── Résumé — SKIPPED ON PURPOSE (operator, 2026-08-16) ─────────────────────────────────
    // iCIMS parses an uploaded résumé SERVER-SIDE and posts the results back into the panel seconds
    // after the attach reports success, re-rendering entries under new ids and blanking everything
    // written so far. Until that postback is handled, attaching the résumé destroys the fill it is
    // supposed to help. The form's own "Upload Resume at a later time" box is left UNTICKED — that is
    // an operator's choice about their own application, not ours to make.
    "PortalProfileFields.Resume_File": { kind: "skip", detail: "résumé upload deferred — iCIMS re-parses and blanks the form mid-fill (attach it yourself, or wait for the postback fix)" },
  },
};

// Derived values the profile doesn't store as one field.
// A PREFERRED-NAME question, answered from the profile. If no preferred name is set, the answer
// is the LEGAL name at the SAME granularity the field asks for — because when you have no
// preferred name, your preferred name IS your name (operator 2026-08-02, after an AI guessed it).
// Deterministic and truthful: every value here is one the user typed into their own profile, so
// it fills unflagged. Granularity matters — a "Preferred Last Name" box must get the LAST name,
// never the full one, or the form carries wrong data.
// Returns null when the label isn't a preferred-name field or the profile has no name at all.
function atsPreferredNameValue(label, profile) {
  const L = String(label || "");
  // "prefer" AND "name", minus the two neighbours that share those words but are different
  // questions: "Preferred Pronouns" (no "name") and "Name Pronunciation" (no "prefer").
  if (!/prefer/i.test(L) || !/name/i.test(L)) return null;
  if (/pronoun|pronunciation|pronounce/i.test(L)) return null;
  // "Do you have a preferred name?" is a yes/no question, not a name box — the caller also
  // gates on widget type, this is the wording belt.
  if (/^(do|does|would|have|has|are|is)\b/i.test(L.trim())) return null;

  const pi = (profile && profile.personal_info) || {};
  const has = (v) => v !== undefined && v !== null && String(v).trim() !== "";
  // An explicit "I have a preferred name: no" wins over any stale text left in those boxes.
  const usePreferred = pi.has_preferred_name !== false;
  const pFirst = usePreferred && has(pi.preferred_first_name) ? String(pi.preferred_first_name).trim() : null;
  const pLast = usePreferred && has(pi.preferred_last_name) ? String(pi.preferred_last_name).trim() : null;
  const lFirst = has(pi.first_name) ? String(pi.first_name).trim() : null;
  const lLast = has(pi.last_name) ? String(pi.last_name).trim() : null;

  if (/\b(first|given|fore)[\s_-]*name\b/i.test(L)) {
    const v = pFirst || lFirst;
    return v ? { value: v, path: pFirst ? "personal_info.preferred_first_name" : "personal_info.first_name", derived: !pFirst } : null;
  }
  if (/\b(last|family|sur)[\s_-]*name\b/i.test(L)) {
    const v = pLast || lLast;
    return v ? { value: v, path: pLast ? "personal_info.preferred_last_name" : "personal_info.last_name", derived: !pLast } : null;
  }
  // No granularity named ⇒ the whole name.
  const v = [pFirst || lFirst, pLast || lLast].filter(Boolean).join(" ").trim();
  return v ? { value: v, path: "(preferred name)", derived: !pFirst && !pLast } : null;
}

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

// ── CREDENTIAL RECOGNITION (pure) ────────────────────────────────────────────────────────
// ── REPEATING-ENTRY ORDINALS (pure) ──────────────────────────────────────────────────────
// iCIMS prefixes every field of a repeating section with its entry ordinal:
// `-1_PersonProfileFields.AddressCity`. `-1` is the entry the form renders by default; "Add More"
// mints further ones, and a saved application comes back with SERVER ids (`-6489344_`). The static
// map is keyed on the bare platform id, so the ordinal is stripped for the lookup.
//
// ⚠ SCOPED DELIBERATELY, AND THE SCOPE IS THE SAFETY. Only the leading `<digits>_` is removed, and
// only iCIMS uses this — a Greenhouse field named `2_foo` keeps its name. It does NOT attempt to
// tell entry 1 from entry 2: with one address in the profile and one entry on the form there is
// nothing to disambiguate, but a SECOND address entry would map to the same profile address, so
// multi-entry repeating sections are still open work (docs/status.md).
function atsMapKey(ats, fieldName) {
  const n = String(fieldName == null ? "" : fieldName);
  if (ats !== "icims") return n;
  return n.replace(/^-?\d+_/, "");
}

// ── REPEATING SECTIONS ARE SCOPED TO THEIR OWN ENTRY (operator, 2026-08-16) ──────────────
// A field inside a repeating section may ONLY be answered from THAT section's data. The rule was
// asked for with the example that makes it obvious: a "State/Province" inside an Education entry is
// the COLLEGE's state, so answering it "Florida" from the applicant's home address is not a slightly
// wrong guess — it is a different fact. The same holds for a work-history address (the EMPLOYER's).
//
// Two consequences, and the second is the one worth stating:
//   • deterministic fills read `profile.<source>[entryIndex]`, never the profile root;
//   • when the entry does not hold the answer, the field is NOT answered from the root as a
//     fallback. It goes to the AI — which is likewise shown ONLY that entry (see atsScopeForField).
//     Live here: the single education entry carries no location at all, so Country/State have no
//     in-section source and must not borrow one.
const ATS_ICIMS_ENTRY_MAPS = {
  education: {
    source: "education",                  // the profile ARRAY this section's entries come from
    idPrefix: "CandProfileFields.",
    // ⚠ MEMBERSHIP, NOT AN ALLOWLIST — this was a hole, and it filled a real wrong answer.
    // The first version listed the field names it knew, so `EducationCity` (which it did not) escaped
    // the seal entirely, reached the label ladder, and was answered "Tallahassee" from the HOME
    // address — exactly the class of error the seal exists to prevent. A seal that only covers the
    // fields you remembered is not a seal. `sectionTitle` matches the section's own heading so any
    // field the section contains is covered, mapped or not; the name regex stays as the fast path
    // (and for fixtures that carry no heading).
    sectionTitle: /^education$/i,
    match: /^CandProfileFields\.(School|OtherSchool|Degree|Major|Minor|GPA|IsGraduated|Graduation|Education)/,
    fields: {
      "CandProfileFields.School": { kind: "school" },
      "CandProfileFields.OtherSchool": { kind: "other_school" },
      "CandProfileFields.Degree": { path: "degree" },
      "CandProfileFields.Major": { path: "field_of_study" },
      "CandProfileFields.Minor": { path: "minor" },
      "CandProfileFields.GPA": { path: "gpa" },
      "CandProfileFields.IsGraduated": { kind: "is_graduated" },
      "CandProfileFields.GraduationDate_Month": { kind: "date_month", from: "graduation_date" },
      "CandProfileFields.GraduationDate_Year": { kind: "date_year", from: "graduation_date" },
      "CandProfileFields.EducationStartDate_Month": { kind: "date_month", from: "from_year" },
      "CandProfileFields.EducationStartDate_Year": { kind: "date_year", from: "from_year" },
      // derived from the ENTRY's own location ("Pittsburgh, PA"), never the home address
      "CandProfileFields.EducationCountry": { kind: "entry_country" },
      "CandProfileFields.EducationState": { kind: "entry_state" },
      "CandProfileFields.EducationCity": { kind: "entry_city" },
    },
  },
  // ── Professional Experience ────────────────────────────────────────────────────────────
  // ⚠ ROUTED BY LABEL, NOT BY ID. Every field here is a per-customer `rcf<NNNN>` (rcf3212 is
  // "Employer" on THIS tenant and means nothing on the next one), so an id table would be
  // write-once-per-customer. Labels are stable vocabulary — and reading a bare "City" as the
  // EMPLOYER's is only safe because the section seal already scoped it; outside the seal that same
  // label is the home address, which is exactly the bug the seal exists to stop.
  experience: {
    source: "work_experience",
    sectionTitle: /^(professional\s+)?experience/i,
    match: /^$/,                       // no id family — membership is what identifies these
    addButton: /professional experience|employment/i,
    byLabel: {
      "employer": { path: "company" },
      "company": { path: "company" },
      "title": { path: "job_title" },
      "job title": { path: "job_title" },
      "position": { path: "job_title" },
      "description": { path: "role_description" },
      "city": { kind: "entry_city" },
      "state": { kind: "entry_state" },
      "province": { kind: "entry_state" },
      "state/province": { kind: "entry_state" },
      "country": { kind: "entry_country" },
      // Employer detail the profile now carries (operator, 2026-08-16). Human-entered only — a
      // resume states none of it — so an empty one simply stays empty rather than reaching the AI.
      "address": { path: "employer_address" },
      "zip": { path: "employer_postal_code" },
      "postal code": { path: "employer_postal_code" },
      "supervisor's name": { path: "supervisor_name" },
      "supervisor name": { path: "supervisor_name" },
      "supervisor's title": { path: "supervisor_title" },
      "supervisor title": { path: "supervisor_title" },
      "reason for leaving": { path: "reason_for_leaving" },
      "may we contact": { kind: "may_contact" },
      "may we contact this employer": { kind: "may_contact" },
      // ⚠ GATED ON THE ANSWER, NOT ON WHETHER THEY HAPPEN TO BE FILLED IN. Handing an employer's
      // email or phone to a recruiter is the whole substance of "may we contact?" — so a `no`, or an
      // unanswered question, must withhold them even when the profile holds them.
      "employer email": { kind: "contact_if_allowed", path: "employer_email" },
      "employer e-mail": { kind: "contact_if_allowed", path: "employer_email" },
      "employer phone": { kind: "contact_if_allowed", path: "employer_phone" },
      "employer phone number": { kind: "contact_if_allowed", path: "employer_phone" },
    },
    // Month/Day/Year repeat per date, so the LABEL cannot say which date it is. The scan stamps
    // `dateGroup` by DOM order within the entry: group 0 is the start, group 1 the end.
    dateGroups: [{ from: "from" }, { from: "to" }],
  },
  // ── Professional Certifications ────────────────────────────────────────────────────────
  // ⚠ THERE IS NO "CERTIFICATIONS" HEADING — traced 2026-08-16. The section is titled "Skills",
  // and holds exactly ONE control: a repeating `Certifications` text box (its Add More reads
  // "Add More (Professional Certifications)"). So the seal keys on the SKILLS heading, which here
  // is unambiguous precisely because that heading has nothing else under it — worth re-checking on
  // any tenant that puts a real skills control there.
  // This form asks only for the certification's NAME: no number, no issued/expiry date, so the
  // profile's certification_number and dates have nowhere to go and are simply not mapped.
  certifications: {
    source: "certifications",
    sectionTitle: /^skills$/i,
    match: /^$/,                       // per-customer rcf ids — membership identifies these
    addButton: /professional certifications/i,
    byLabel: {
      "certifications": { kind: "certification_name" },
      "certification": { kind: "certification_name" },
      "certification name": { kind: "certification_name" },
      // Astrion asks only for the name, but the vocabulary is borrowed from the Workday side's
      // CERTIFICATION_MAP so a tenant that asks for more is already covered.
      "certification number": { path: "certification_number" },
      "license number": { path: "certification_number" },
      // ⚠ ISSUED / EXPIRATION DATES ARE DELIBERATELY NOT MAPPED. The profile stores them as
      // "YYYY-MM-DD", and the existing date_month/date_year kinds only parse "YYYY-MM" or "YYYY" —
      // pointing a label at them would resolve to null on every run and look like a broken mapping
      // rather than a missing one. Left unmapped, such a field is still SEALED (membership covers
      // it), so it reaches the scoped AI instead of the profile root. Wiring them properly means a
      // day-precision kind, which no observed tenant has asked for yet.
    },
  },
};

// Which repeating section (if any) does a field belong to, and which ENTRY of it?
// `entryIndex` is stamped onto the scan by atsAssignEntryIndexes — the ordinal in the id (`-1_`) is
// an iCIMS internal, NOT an array index, so it is never used as one.
function atsEntrySpec(ats, f) {
  if (ats !== "icims" || !f) return null;
  const bare = atsMapKey(ats, f.fieldName);
  const hasOrdinal = /^-?\d+_/.test(String(f.fieldName || ""));
  for (const [section, def] of Object.entries(ATS_ICIMS_ENTRY_MAPS)) {
    // Either signal is enough: the field's NAME is one we know, or the field SITS IN the section
    // (its own heading says so). The second is what closes the allowlist hole — an unmapped field
    // inside the section is still sealed, it simply has no deterministic value and reaches the
    // scoped AI instead of the profile root.
    const byName = def.match.test(bare);
    const bySection = hasOrdinal && def.sectionTitle && def.sectionTitle.test(String(f.section || "").trim());
    if (!byName && !bySection) continue;
    // id table first (stable platform ids), then the LABEL table (per-customer rcf ids), then the
    // date groups — a Month/Day/Year label says nothing about WHICH date without its group.
    let spec = (def.fields || {})[bare] || null;
    if (!spec && def.byLabel) {
      const key = String(f.label || "").toLowerCase().replace(/\s+/g, " ").replace(/[*✱:]\s*$/, "").trim();
      spec = def.byLabel[key] || null;
      if (!spec && def.dateGroups && typeof f.dateGroup === "number") {
        const g = def.dateGroups[f.dateGroup];
        if (g && /^month$/i.test(key)) spec = { kind: "date_month", from: g.from };
        else if (g && /^year$/i.test(key)) spec = { kind: "date_year", from: g.from };
        else if (g && /^day$/i.test(key)) spec = { kind: "skip", detail: "day-of-month — the profile stores month precision" };
      }
    }
    return { section, source: def.source, bare, spec,
      entryIndex: typeof f.entryIndex === "number" ? f.entryIndex : 0, def };
  }
  return null;
}

// Stamp `entryIndex` on every field of a repeating section. Entries are ordered by FIRST DOM
// APPEARANCE of their ordinal, not by the ordinal's numeric value — iCIMS uses `-1` for the entry it
// renders by default and opaque SERVER ids for saved ones, so sorting numerically would reorder them.
function atsAssignEntryIndexes(ats, fields) {
  if (ats !== "icims" || !Array.isArray(fields)) return fields;
  const order = {}; // section → [ordinal, …] in first-seen order
  for (const f of fields) {
    const bare = atsMapKey(ats, f.fieldName);
    const m = /^(-?\d+)_/.exec(String(f.fieldName || ""));
    if (!m) continue;
    for (const [section, def] of Object.entries(ATS_ICIMS_ENTRY_MAPS)) {
      // Same dual signal atsEntrySpec uses — name OR section membership. Matching on the name
      // alone left every per-customer rcf field unstamped, so its date groups never formed and
      // start/end dates resolved to nothing.
      const bySec = def.sectionTitle && def.sectionTitle.test(String(f.section || '').trim());
      if (!def.match.test(bare) && !bySec) continue;
      const list = (order[section] = order[section] || []);
      if (list.indexOf(m[1]) === -1) list.push(m[1]);
      f.entryIndex = list.indexOf(m[1]);
      f.entrySection = section;
    }
  }
  // Stamp WHICH date each Month/Day/Year belongs to. The controls repeat with identical labels, so
  // only their position distinguishes start from end: group by the id base (`rcf3214` vs `rcf3215`)
  // and number those bases in DOM order within the entry. Keyed on the BASE rather than on a count
  // of fields, so a form that omits Day — or orders Year first — still groups correctly.
  const seenBases = {};
  for (const f of fields) {
    if (typeof f.entryIndex !== "number" || !f.entrySection) continue;
    const m = /^(.*)_(Month|Date|Day|Year)$/i.exec(atsMapKey(ats, f.fieldName));
    if (!m) continue;
    const entryKey = f.entrySection + ":" + f.entryIndex;
    const bases = (seenBases[entryKey] = seenBases[entryKey] || []);
    if (bases.indexOf(m[1]) === -1) bases.push(m[1]);
    f.dateGroup = bases.indexOf(m[1]);
  }
  return fields;
}

// The ONLY profile a field is allowed to be answered from — including by the LLM.
// A repeating-entry field sees its own entry and nothing else; everything else sees the profile.
function atsScopeForField(ats, f, profile) {
  const es = atsEntrySpec(ats, f);
  if (!es) return profile;
  const arr = (profile || {})[es.source];
  const entry = Array.isArray(arr) ? arr[es.entryIndex] : null;
  // Named so the model knows what it is looking at, and deliberately NOTHING else from the profile.
  return entry ? { [es.section + "_entry"]: entry } : { [es.section + "_entry"]: {} };
}

// Month names as the form spells them (its Month select is a native <select> of full names).
const ATS_MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

// A month as the tenant might spell it, most specific first: full name, then the 3-letter
// abbreviation, then "Sept" for the one month whose short form is commonly four letters. May is
// already three letters, so it yields a single candidate rather than a duplicate.
function atsMonthCandidates(mi) {
  const full = ATS_MONTHS[mi];
  if (!full) return [];
  const out = [full];
  const abbr = full.slice(0, 3);
  if (abbr !== full) out.push(abbr);
  if (full === "September") out.push("Sept");
  return out;
}

// Is a "YYYY" or "YYYY-MM" strictly in the future? null when it is neither shape.
// `now` is a parameter so the rule is unit-testable without freezing the clock.
function atsIsFutureYearMonth(s, now) {
  const t = now == null ? new Date() : new Date(now);
  const ym = /^(\d{4})-(\d{1,2})$/.exec(String(s).trim());
  const y = /^(\d{4})$/.exec(String(s).trim());
  if (!ym && !y) return null;
  const yr = parseInt((ym ? ym[1] : y[1]), 10);
  const mo = ym ? parseInt(ym[2], 10) : 12;          // a bare year is only past once the year is over
  const nowYr = t.getFullYear(), nowMo = t.getMonth() + 1;
  return yr > nowYr || (yr === nowYr && mo > nowMo);
}

// Resolve ONE repeating-entry field from ITS OWN entry. Returns a route, or null to fall through
// (which, for an entry field, means the scoped AI — never the profile root).
function atsResolveEntryField(es, entry, f, now) {
  const spec = es.spec;
  if (!spec || !entry) return null;
  const val = (k) => { const v = entry[k]; return v === undefined || v === null || (typeof v === "string" && !v.trim()) ? null : v; };
  if (spec.kind === "skip") return { kind: "skip", source: "entry", detail: spec.detail || "left to the operator" };
  // ⚠ A SPEC CARRYING A `kind` IS NOT A PLAIN PATH, even when it also carries a `path`. This branch
  // ran FIRST and returned the value directly, silently bypassing the may_contact gate below — so
  // the employer's email and phone would have been released on a "no", and on an UNANSWERED
  // question. Caught by the test, not by review. Only a BARE path short-circuits here; every kind
  // is handled below, where its own rule applies.
  if (spec.path && !spec.kind) { const v = val(spec.path); return v == null ? null : { raw: v, path: es.section + "[" + es.entryIndex + "]." + spec.path, source: "entry" }; }
  // ⚠ A ROLE YOU STILL HOLD HAS NO END DATE. Without this the empty `to` reads as "unanswered" and
  // the sealed AI is asked to invent one — on a REQUIRED field it would have to produce something,
  // and any date it picks is a claim that you left a job you are still doing.
  if ((spec.kind === "date_month" || spec.kind === "date_year") && spec.from === "to" && entry.currently_work_here === true) {
    return { kind: "skip", source: "entry", detail: "you still work here — the end date is deliberately left blank" };
  }

  if (spec.kind === "school") {
    const s = val("school_or_university");
    return s == null ? null : { candidates: [String(s)], source: "entry", kind: "school",
      path: es.section + "[" + es.entryIndex + "].school_or_university" };
  }
  if (spec.kind === "other_school") {
    // Decided by the SCHOOL field's outcome, not here — see the pairing in atsFillFields.
    const s = val("school_or_university");
    return { kind: "other_school", source: "entry", schoolName: s == null ? null : String(s),
      path: es.section + "[" + es.entryIndex + "].school_or_university" };
  }
  if (spec.kind === "is_graduated") {
    // ⚠ `currently_enrolled` IS NOT TRUSTWORTHY ON ITS OWN, and this cost a wrong live answer.
    // The website's education editor does not expose that checkbox at all, so a synced profile
    // carries the schema DEFAULT (false) — and a student graduating in 2028 was confidently
    // answered "Yes, graduated" on 2026-08-16, deterministically and unflagged. An absent field
    // read as a positive assertion is the failure here, not the matching.
    // A graduation date in the FUTURE is the harder fact and wins: you have not graduated if the
    // date has not happened yet. The checkbox is only consulted when the dates say nothing.
    const grad = val("graduation_date") || val("to_year");
    const path = es.section + "[" + es.entryIndex + "]." + (val("graduation_date") ? "graduation_date" : "to_year");
    const fut = grad == null ? null : atsIsFutureYearMonth(String(grad), now);
    if (fut === true) return { candidates: ["No"], source: "entry", path };
    if (entry.currently_enrolled === true) return { candidates: ["No"], source: "entry", path: es.section + "[" + es.entryIndex + "].currently_enrolled" };
    if (fut === false) return { candidates: ["Yes"], source: "entry", path };
    return null;
  }
  if (spec.kind === "date_month" || spec.kind === "date_year") {
    const raw = val(spec.from);
    if (raw == null) return null;
    const s = String(raw);
    const ym = /^(\d{4})-(\d{1,2})$/.exec(s);          // "2028-05"
    const yOnly = /^(\d{4})$/.exec(s);                  // "2024"
    if (spec.kind === "date_year") {
      const y = ym ? ym[1] : (yOnly ? yOnly[1] : null);
      return y == null ? null : { value: y, source: "entry", path: es.section + "[" + es.entryIndex + "]." + spec.from };
    }
    if (!ym) return null;                               // a year-only value says nothing about the month
    const mi = parseInt(ym[2], 10) - 1;
    // ⚠ TIERED, because a month dropdown's VOCABULARY is the tenant's choice, not a fact about the
    // date. Live 2026-08-16 two end-date months reached review as `stated-value-unmatched` —
    // "August" against a list that spells it "Aug" — while the education date control on the SAME
    // page lists Jan…Dec. Most specific first, so a form offering full names still matches exactly
    // and only an abbreviating one falls to the second tier. "Sept" is included because it is the
    // one abbreviation that is commonly four letters.
    return mi >= 0 && mi < 12
      ? { candidates: atsMonthCandidates(mi), source: "entry", path: es.section + "[" + es.entryIndex + "]." + spec.from }
      : null;
  }
  if (spec.kind === "certification_name") {
    // `certification` is TIERED (most specific first), the same shape degree and field_of_study use.
    // This is a free-text box rather than a picker, so the most specific tier is simply written —
    // there is no list to fall back through. A tier list that arrived as a bare string still works.
    const raw = entry.certification;
    const name = Array.isArray(raw) ? raw.find((x) => typeof x === "string" && x.trim()) : raw;
    return name && String(name).trim()
      ? { value: String(name).trim(), source: "entry", path: es.section + "[" + es.entryIndex + "].certification" }
      : null;
  }
  if (spec.kind === "may_contact") {
    // A tri-state: unanswered stays UNANSWERED. Defaulting either way decides on the operator's
    // behalf whether a recruiter may ring a past employer, which is not a default anyone should own.
    const v = entry.may_contact;
    if (v === true) return { candidates: ["Yes"], source: "entry", path: es.section + "[" + es.entryIndex + "].may_contact" };
    if (v === false) return { candidates: ["No"], source: "entry", path: es.section + "[" + es.entryIndex + "].may_contact" };
    return null;
  }
  if (spec.kind === "contact_if_allowed") {
    // ⚠ WITHHELD UNLESS THE ANSWER IS AN EXPLICIT YES. Releasing an employer's email or phone IS
    // the consequence the "may we contact?" question governs, so `no` and UNANSWERED both withhold.
    if (entry.may_contact !== true) {
      return { kind: "skip", source: "entry",
        detail: entry.may_contact === false
          ? "withheld — you answered No to contacting this employer"
          : "withheld — \"may we contact this employer?\" is unanswered for this role" };
    }
    const v = val(spec.path);
    return v == null ? null : { raw: v, path: es.section + "[" + es.entryIndex + "]." + spec.path, source: "entry" };
  }
  if (spec.kind === "entry_city") {
    // The city half of the entry's own "City, ST". Deterministic when the entry states it — better
    // than asking the model to remember where a university sits, and it cannot drift to the home city.
    const loc = val("location");
    if (loc == null) return null;
    const city = String(loc).split(",")[0].trim();
    return city ? { value: city, source: "entry", path: es.section + "[" + es.entryIndex + "].location" } : null;
  }
  if (spec.kind === "entry_country" || spec.kind === "entry_state") {
    // ⚠ The ENTRY's own location, and nothing else. This profile's education entry has none, so both
    // correctly return null and go to the scoped AI rather than inheriting the home address.
    const loc = val("location");
    if (loc == null) return null;
    const parts = String(loc).split(",").map((x) => x.trim()).filter(Boolean);
    if (spec.kind === "entry_state") {
      const st = parts.length > 1 ? parts[parts.length - 1] : null;
      if (!st) return null;
      // "PA" → ["PA", "Pennsylvania"] so either spelling can match the form's list
      const full = Object.keys(atsLib.REGION_ABBREV || {}).find((n) => atsLib.REGION_ABBREV[n] === st.toLowerCase());
      const cands = full ? [full.replace(/\b\w/g, (c) => c.toUpperCase()), st] : [st];
      return { candidates: cands, source: "entry", path: es.section + "[" + es.entryIndex + "].location" };
    }
    // ⚠ A US STATE IMPLIES THE UNITED STATES, and deriving it is what keeps the PAIR fillable.
    // Country is this field's declared PARENT: until it commits, the child's list reads "Please
    // select a country" and no state can be chosen. Live, Country had no deterministic source, was
    // deferred to the AI, and the deterministic "Pennsylvania" for State therefore ran against an
    // empty list and was lost. Recognising "Pittsburgh, PA" as US is a grounded fact — not a guess —
    // and it fills the parent in the SAME pass, ahead of the child.
    const tail = parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "";
    const isUsState = !!tail && (Object.prototype.hasOwnProperty.call(atsLib.REGION_ABBREV || {}, tail) ||
      Object.keys(atsLib.REGION_ABBREV || {}).some((n) => atsLib.REGION_ABBREV[n] === tail));
    if (!isUsState) return null;
    return { candidates: ["United States", "United States of America"], source: "entry",
      path: es.section + "[" + es.entryIndex + "].location" };
  }
  return null;
}

// Which stored credential, if any, does this field want? → "login" | "password" |
// "password_confirm" | null.
//
// Two sources, in order:
//   1. the static map — the known iCIMS platform ids. This is the authority.
//   2. an INPUT-TYPE fallback, for a tenant whose ids the map does not know.
//
// ⚠ THE FALLBACK EXISTS FOR SAFETY, NOT COVERAGE. Recognizing a field as a credential is what
// keeps buckets, the label ladder and the LLM away from it — so an UNRECOGNIZED password box is
// the dangerous outcome, not an unfilled one: it would reach the AI rescue as an ordinary required
// text field and be answered with a guess. Hence `type="password"` alone is enough to claim a
// field, while claiming a LOGIN needs two agreeing signals (an `autocomplete="username"` hint AND
// login/username wording), because a bare text box is not self-evidently a credential and a false
// positive there would overwrite an ordinary answer with an account name.
function atsCredentialKind(ats, f) {
  if (!f) return null;
  const map = (ATS_STATIC_MAPS[ats] || {})[atsMapKey(ats, f.fieldName)];
  if (map && map.kind === "credential") return map.credentialKind || null;
  const idLabel = String((f.fieldName || "") + " " + (f.label || "")).toLowerCase();
  if (f.inputType === "password") {
    return /confirm|re-?enter|re-?type|verify|again|repeat/.test(idLabel) ? "password_confirm" : "password";
  }
  if (f.autocomplete === "username" && /\blogin\b|\busername\b|\buser id\b/.test(idLabel)) return "login";
  return null;
}

// The value for a recognized credential field. Returns null when the credentials are absent or
// incomplete — the caller then reports the field to review rather than making half an account.
function atsCredentialValue(kind, credentials) {
  const c = credentials || null;
  if (!c || !c.email || !c.password) return null;
  if (kind === "login") return String(c.email);
  if (kind === "password" || kind === "password_confirm") return String(c.password);
  return null;
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

  // Preferred name — a DERIVED value, so it lives here rather than in a bucket: no single
  // profile_path can express "the preferred name, or the legal name when there isn't one"
  // (the same carve-out as composed full names and multi-fact logic, noted just below).
  // Text widgets only: a choice/yes-no widget asking about preferred names is a different
  // question and must fall through.
  if (!f || f.widgetType === "text" || f.widgetType === "textarea") {
    const pn = atsPreferredNameValue(L, profile);
    if (pn) return { value: pn.value, source: "name", path: pn.path, detail: pn.derived ? "no preferred name set — used your name" : "preferred name" };
  }

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
  if (ATS_LOCATION_LABEL_RE.test(L)) {
    const v = atsComposeValue("city_state", profile);
    // TIERED, most specific first — because "where are you based?" is NOT always a places
    // autocomplete. GitLab renders it as a three-option pick-one ("1. United States of America" /
    // "2. Canada" / "3. Located Elsewhere"), where a city+state string can never match and the
    // COUNTRY is the answer (live 2026-08-05: a REQUIRED field left empty while the profile held
    // the exact country). The city is still tried first, so a real places widget is unaffected.
    // country may itself be a TIERED LIST (the profile stores ladders as arrays, e.g.
    // ["United States of America", "United States"]) — flatten it into candidates rather than
    // handing an array to the match ladder, which normalizes strings and throws on anything else
    // (live 2026-08-05: `s.toLowerCase is not a function` killed the field mid-fill).
    const rawCountry = profile && profile.personal_info ? profile.personal_info.country : null;
    const country = (Array.isArray(rawCountry) ? rawCountry : [rawCountry])
      .filter((x) => typeof x === "string" && x.trim());
    // `candidates` (not `value`) is how this router hands over a TIERED list — a bare array in
    // `value` gets String()'d into one comma-joined string. `value` stays the city, which is what
    // a real places box should be typed with.
    const cands = [v].concat(country).filter(Boolean);
    if (cands.length) return { kind: "location", value: cands[0], candidates: cands, source: "map", path: "(city+state)" };
  }

  // A SIGNATURE / COMPLETION DATE IS TODAY — never an AI guess. Live 2026-08-05 on Lever's EEO block:
  // `eeo[disabilitySignatureDate]` fell through to the AI free-text path, which answered "As soon as
  // possible" (an availability answer on a date field) after a 19.2s LLM call — the slowest field of
  // the run. The applicant is completing the form now, so the answer is deterministic. Same recognizer
  // the Workday path uses, and it is deliberately narrow: any label naming a DIFFERENT event (start,
  // birth, graduation, expiry…) is refused rather than stamped with today.
  if (atsLib.isSignatureDateQuestion(label)) {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return { value: `${mm}/${dd}/${d.getFullYear()}`, source: "signature-date", path: "(today)" };
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
  // ONE ADVERB IS ALLOWED IN THE MIDDLE (2026-08-07). Roblox asks "How did you FIRST hear about this
  // role?" and the old wording missed it, so a REQUIRED question the profile answers exactly went to
  // the AI, which answered "LinkedIn" — the right value, arrived at the expensive way, flagged
  // ai-choice, and parked in review for a human to re-confirm something the profile already said.
  // Same class as the boolean-ladder leak: a deterministic answer that the label match let slip.
  // "how did you <word> hear/find" is idiomatic only for this question, so a single wildcard word is
  // safe and generalizes past guessing at first/originally/initially one at a time.
  // …and the verb must be followed by what the question is ABOUT. The old wording ended at the verb,
  // so "How did you find working with your last team?" routed here too — it would have answered an
  // interview question with "LinkedIn". Every real wording continues with about / of / this / us / our.
  if (/(?:how|where)(?: did| do|'d) you (?:\w+ )?(?:hear|find)\s+(?:out\s+)?(?:about|of|this|us|our)\b/i.test(L)) {
    const hdyh = (profile && profile.how_did_you_hear) || (defaults && defaults.how_did_you_hear);
    if (hdyh && Array.isArray(hdyh.preferred) && hdyh.preferred.length) return { candidates: [...hdyh.preferred], source: "map", path: "how_did_you_hear.preferred", detail: "how_did_you_hear.preferred" };
  }

  // WHICH KINDS OF EMPLOYMENT WOULD YOU CONSIDER — a MULTI-answer question (iCIMS renders it as a
  // native multi-select: "Please select the following employment options you would consider…", with
  // Full-time / Internship / Part-time / Temporary). Deterministic from a stated list; every stored
  // answer still clears the ordinary ladder against the live options, so a form offering different
  // words commits only what it actually has. Anchored on "employment/position/job" + a
  // consider/interested/seeking verb, so it cannot swallow the work-AUTHORISATION questions above
  // (those are about eligibility, and they run first regardless).
  if (/\b(employment|position|job)\b[^?]*\b(you would|you'd|would you)?\s*(consider|interested in|seeking|looking for|open to)\b/i.test(L) ||
      /\b(employment|work)\s+(type|options?|status)\b[^?]*\b(consider|interested|seeking|prefer)/i.test(L)) {
    const et = (profile && profile.employment_types_considered) || (defaults && defaults.employment_types_considered);
    const list = Array.isArray(et) ? et.filter((x) => typeof x === "string" && x.trim()) : [];
    if (list.length) return { candidates: list, source: "map", path: "employment_types_considered", detail: "employment_types_considered" };
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
  // Pronouns are not modeled in the profile. OPTIONAL ⇒ leave blank (nothing is lost). REQUIRED ⇒
  // do NOT swallow it here: returning skip bypassed the required-field machinery entirely, so a
  // required Pronouns field reached review empty and could not be approved, blocking an otherwise
  // complete application (live 2026-08-01). Falling through to null lets the ordinary required
  // path run — the form^s own decline option, or an AI answer that is always flagged.
  if (/pronoun/i.test(L)) return f && f.isRequired ? null : { skip: true, detail: "pronouns — not modeled in the profile (left blank)" };

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
      // ⚠ RADIO AND CHECKBOX BELONG TO THE GROUPING PASS BELOW, not here (2026-08-07). This loop
      // skipped only `hidden`, so every box in a Greenhouse group was pushed TWICE: once here as a
      // required "text" field keyed on the box's own id, and again below as the real checkbox_group.
      // Live on Gusto's "How did you hear about this opportunity? (select all that apply)" — 12
      // boxes — each phantom text field was REQUIRED, so each one bought its own LLM call, which
      // answered "N/A" with no basis, and 12 of that form's 21 review items were this one question.
      // Worse than noise: atsInjSetText on a checkbox writes its .value, which is the string that
      // would be SUBMITTED for that option. The Lever and Ashby branches have always skipped both.
      if (el.type === "hidden" || el.type === "radio" || el.type === "checkbox") continue;
      if (!vis(el.closest("div") || el)) continue;
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

  // iCIMS — a classic server-rendered form (jQuery, NO React: there are no fiber keys on its
  // inputs, traced 2026-08-16), so plain native-setter writes are enough and there is no
  // controlled-component state to re-sync. Structure is a table of `.iCIMS_TableRow` inside
  // `.iCIMS_ProfileFormTable`, each section preceded by an `h2.iCIMS_SubHeader`.
  //
  // ⚠ THIS RUNS INSIDE THE FORM IFRAME, not the top document — see cdpUseFormFrame. `document`
  // here IS the frame's document, which is why nothing below reaches through a frame boundary.
  if (ats === "icims") {
    // Required is marked three independent ways and they do not always agree; detect all of them.
    // Over-flagging is the safe direction (CLAUDE.md: a required field reading FALSE is the
    // dangerous one — it hides an unfilled field that will block advancement).
    const req = (el) => {
      if (/iCIMS_Forms_RequiredField/.test(String(el.className || ""))) return true;
      if (el.getAttribute("aria-required") === "true" || el.required === true) return true;
      if (el.getAttribute("i_required") === "true") return true; // iCIMS' own marker, on its dropdowns
      const row = el.closest(".iCIMS_TableRow") || el.parentElement;
      if (row && row.querySelector(".Field_Required, .Field_RequiredStar")) return true;
      return /[*✱]\s*$/.test(labelFor(el) || "");
    };
    // The nearest preceding section heading ("Create a login", "Enter your information") — carried
    // for logs and review grouping. ⚠ A required repeating block titles itself with a <legend>, not
    // a heading, so a heading is a HINT about where a field sits, never an identity.
    const sectionOf = (el) => {
      const table = el.closest(".iCIMS_ProfileFormTable");
      let p = table ? table.previousElementSibling : null;
      for (let i = 0; i < 4 && p; i++) { if (/^H[1-4]$/.test(p.tagName)) return txt(p); p = p.previousElementSibling; }
      const lg = el.closest("fieldset") ? el.closest("fieldset").querySelector("legend") : null;
      return lg ? stripReq(txt(lg)) : null;
    };
    // GROUPED CONTROLS FIRST (radio + checkbox, by shared name), so the general loop below can skip
    // their members. Same shape as the Greenhouse and Lever branches, and for the same reason: a box
    // classified by the general loop becomes a phantom REQUIRED text field over the same control,
    // and a text write to a checkbox sets the string that option would SUBMIT.
    const optLabel = (r) => (r.id && txt(document.querySelector('label[for="' + esc(r.id) + '"]'))) || txt(r.closest("label")) || r.value;
    const groups = {};
    for (const r of document.querySelectorAll('input[type="radio"], input[type="checkbox"]')) {
      if (!vis(r.closest("label") || r.closest(".iCIMS_TableRow") || r)) continue;
      const nm = r.name || r.id || ""; if (!nm) continue;
      (groups[nm] = groups[nm] || []).push(r);
    }
    for (const [nm, list] of Object.entries(groups)) {
      seen.add(nm);
      const kind = list[0].type === "radio" ? "radio" : (list.length > 1 ? "checkbox_group" : "checkbox");
      const rec = { fieldName: nm, inputSel: 'input[name="' + esc(nm) + '"]', widgetType: kind,
        label: stripReq(labelFor(list[0]) || nm), isRequired: list.some(req), section: sectionOf(list[0]) };
      if (kind === "checkbox") { push(Object.assign(rec, { value: list[0].checked ? "true" : null })); continue; }
      push(Object.assign(rec, {
        value: (list.filter((r) => r.checked).map(optLabel).join(", ")) || null,
        options: list.map(optLabel).filter(Boolean), group: list[0].type }));
    }
    for (const el of document.querySelectorAll("input, textarea, select")) {
      if (el.type === "hidden" || el.type === "radio" || el.type === "checkbox") continue;
      const id = el.id || el.name || ""; if (!id || seen.has(id)) continue;
      // file inputs are styled invisible on this theme (the visible control is a sibling button row)
      if (el.type !== "file" && !vis(el)) continue;
      seen.add(id);
      const sel = el.id ? "#" + esc(el.id) : el.tagName.toLowerCase() + '[name="' + esc(el.name) + '"]';
      const label = stripReq(labelFor(el) || id);
      const base = { fieldName: id, inputSel: sel, label: label || id, isRequired: req(el), section: sectionOf(el) };
      if (el.type === "file") { push(Object.assign(base, { widgetType: "file_upload", isRequired: req(el), value: (el.files && el.files[0] && el.files[0].name) || null })); continue; }
      if (el.tagName === "SELECT" && el.multiple) {
        // A native <select multiple> is a MULTI-answer control: committing it by selectedIndex (what
        // dropdown_native does) would answer one option and silently discard the rest.
        push(Object.assign(base, { widgetType: "multiselect_native",
          value: [...el.selectedOptions].map((o) => txt(o)).join(", ") || null,
          options: [...el.options].map((o) => txt(o)).filter((t) => t && !/^(select|—s*make a selection)/i.test(t)) }));
        continue;
      }
      if (el.tagName === "SELECT") {
        // ⚠ NOT EVERY <select> HERE IS A SELECT. iCIMS replaces many of them with its own AJAX
        // combobox ("IdDropDown"), and when it does, the <select> element is left PERMANENTLY EMPTY —
        // one blank <option> — while the real choices live in a sibling `<ul id="<id>_dropdown-results">`
        // of `<li role="option">`. Reading `el.options` there yields NOTHING, which is exactly how the
        // required Country and State/Province fields reached review as "no live options to choose
        // from" (live 2026-08-16) while the page was showing a perfectly good list.
        // The tell is the element's own attribute, not a guess: `icimsdropdown-enabled="1"`.
        // ⚠ The backing <select> stays empty even AFTER a successful commit — it holds an opaque id
        // (`12781`), never the text — so both the option read and the read-back must use the widget.
        if (el.getAttribute("icimsdropdown-enabled") === "1") {
          const ul = document.getElementById(el.id + "_dropdown-results");
          const items = ul ? [...ul.children].map((li) => txt(li)).filter((t) => t && !/^—\s*make a selection/i.test(t)) : [];
          const shown = document.getElementById(el.id + "_fakeSelected_icimsDropdown");
          const cur = shown ? txt(shown) : "";
          push(Object.assign(base, {
            widgetType: "icims_dropdown",
            value: cur && !/^—\s*make a selection/i.test(cur) && !/^please select/i.test(cur) ? cur : null,
            options: items,
            // ⚠ PROVENANCE, NOT A GUESS: this widget renders ONE PAGE and offers a search box —
            // measured at 26 countries and 25 states (Alabama…Michigan, so Minnesota→Wyoming are
            // absent). Marking it partial is what stops review presenting a 25-row list as the
            // complete set of US states, and what tells the actuator to search before giving up.
            optionsPartial: !!(ul && ul.getAttribute("data-ap-complete") !== "1"),
            // The parent→child dependency, DECLARED by the page: picking this field's value is what
            // populates the named child (Country → State/Province). Carried so the driver can order
            // them and explain an empty child honestly instead of guessing.
            childLink: el.getAttribute("data-ddd-child-link") || null,
          }));
          continue;
        }
        push(Object.assign(base, { widgetType: "dropdown_native",
          value: el.selectedIndex > 0 ? txt(el.options[el.selectedIndex]) : null,
          // iCIMS' placeholder row is "— Make a Selection —"; drop it and any bare "Select…"
          options: [...el.options].map((o) => txt(o)).filter((t) => t && !/^(select|—\s*make a selection)/i.test(t)) }));
        continue;
      }
      if (el.tagName === "TEXTAREA") { push(Object.assign(base, { widgetType: "textarea", value: el.value || null })); continue; }
      // ⚠ `inputType` is carried for ONE reason: a password box must be recognizable as a secret
      // even on a tenant whose field ids the static map does not know. See atsCredentialKind.
      push(Object.assign(base, { widgetType: "text", inputType: el.type || "text",
        autocomplete: el.getAttribute("autocomplete") || null,
        value: el.type === "password" ? null : (el.value || null) }));
    }
    return out;
  }

  // ⚠ THE ASHBY BLOCK BELOW IS THE FALL-THROUGH, NOT A GUARDED BRANCH. Without this line a fifth
  // tenant added above would silently run Ashby's selectors and return a plausible-looking 0-field
  // scan instead of failing. An empty scan is refused by atsLooksLikeApplicationForm — an honest stop.
  if (ats !== "ashby") return out;

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

// ── CREDENTIAL WRITE / VERIFY ────────────────────────────────────────────────────────────
// Deliberately separate from atsInjSetText for two reasons, each earned:
//
// 1. ⚠ IT NEVER RETURNS THE VALUE. atsInjSetText answers `{after: el.value}`, which for a password
//    box hands the secret back across the CDP boundary into a record, a log line and ultimately the
//    review bundle POSTed to the website. These return a LENGTH and a MATCH BOOLEAN — everything
//    needed to verify the write, nothing that carries it.
// 2. ⚠ IT CLEARS FIRST. The setter SETS a value, it does not replace a selection, so rewriting a
//    prepopulated login produced "someone.else@old-account.comkevin@example.com". iCIMS renders the
//    session's own login into that box, so a rewrite is the NORMAL case here, not an edge one.
//    Same "clear before typing" rule the typeahead path already follows.
function atsInjSetCredential(inputSel, value) {
  const el = document.querySelector(inputSel);
  if (!el) return { ok: false, error: "not-found:" + inputSel };
  const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  const had = (el.value || "").length;
  el.focus();
  setter.call(el, "");
  el.dispatchEvent(new Event("input", { bubbles: true }));
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.blur();
  el.dispatchEvent(new Event("focusout", { bubbles: true }));
  return { ok: true, hadLength: had, len: (el.value || "").length, matches: el.value === value };
}

// Independent re-read of a credential box. Same no-value contract as the write.
// `matches` is the whole point: it answers "does the page still hold what we put there?" without
// anyone outside the page ever seeing either string.
function atsInjVerifyCredential(inputSel, value) {
  const el = document.querySelector(inputSel);
  if (!el) return { ok: false, error: "not-found:" + inputSel };
  const v = el.value || "";
  return { ok: true, len: v.length, empty: v === "", matches: v === value };
}

// ── iCIMS "IdDropDown" — an AJAX combobox wearing a <select> ─────────────────────────────
// Anatomy, traced live 2026-08-16 (astrion), all ids derived from the <select>'s own id:
//   <select id="X" icimsdropdown-enabled="1" data-ddd-child-link="…">  ← ALWAYS EMPTY; value is an
//                                                                        opaque id ("12781"), never text
//   <a  id="X_icimsDropdown" class="dropdown-select">                  ← the OPENER
//   <span id="X_fakeSelected_icimsDropdown">                           ← what the user SEES = read-back
//   <div id="X_icimsDropdown_ctnr" class="dropdown-container[ dropdown-invisible]">
//        <input class="dropdown-search" placeholder="— Type to Search —">
//   <ul id="X_dropdown-results"> <li role="option" class="dropdown-result result-selectable">
//
// ⚠ `aria-expanded` STAYS "false" even while open — gate on the container's `dropdown-invisible`
// class, never on aria (the same lesson Workday's dropdown close taught).
// ⚠ ONE PAGE ONLY: 26 countries / 25 states. Anything past it needs the search box.

// Open the widget. Returns the option texts it is showing.
function atsInjIcimsOpen(inputSel) {
  const el = document.querySelector(inputSel);
  if (!el || !el.id) return { ok: false, error: "not-found:" + inputSel };
  const opener = document.getElementById(el.id + "_icimsDropdown");
  const ctnr = document.getElementById(el.id + "_icimsDropdown_ctnr");
  if (!opener || !ctnr) return { ok: false, error: "no-widget" };
  if (/dropdown-invisible/.test(String(ctnr.className))) {
    for (const t of ["pointerdown", "mousedown", "mouseup", "click"]) {
      opener.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    }
  }
  const ul = document.getElementById(el.id + "_dropdown-results");
  const txt = (n) => (n && n.textContent ? n.textContent.replace(/\s+/g, " ").trim() : "");
  const opts = ul ? [...ul.children].map(txt).filter((t) => t && !/^—\s*make a selection/i.test(t)) : [];
  return { ok: true, open: !/dropdown-invisible/.test(String(ctnr.className)), options: opts };
}

// Type into the widget's own search box. iCIMS filters/fetches on input; the caller re-reads after.
function atsInjIcimsSearch(inputSel, query) {
  const el = document.querySelector(inputSel);
  if (!el || !el.id) return { ok: false, error: "not-found:" + inputSel };
  const ctnr = document.getElementById(el.id + "_icimsDropdown_ctnr");
  const box = ctnr ? ctnr.querySelector("input.dropdown-search") : null;
  if (!box) return { ok: false, error: "no-search-box" };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  box.focus();
  setter.call(box, "");
  box.dispatchEvent(new Event("input", { bubbles: true }));
  setter.call(box, String(query));
  box.dispatchEvent(new Event("input", { bubbles: true }));
  box.dispatchEvent(new Event("keyup", { bubbles: true }));
  return { ok: true };
}

// Read whatever the widget is currently showing (after a search, or to settle-poll it).
function atsInjIcimsReadOptions(inputSel) {
  const el = document.querySelector(inputSel);
  if (!el || !el.id) return { ok: false, error: "not-found:" + inputSel };
  const ul = document.getElementById(el.id + "_dropdown-results");
  if (!ul) return { ok: false, error: "no-results-list" };
  const txt = (n) => (n && n.textContent ? n.textContent.replace(/\s+/g, " ").trim() : "");
  const all = [...ul.children].map(txt);
  return { ok: true,
    options: all.filter((t) => t && !/^—\s*make a selection/i.test(t) && !/^no results/i.test(t)),
    // a child whose parent is unset says so in its own list — report it rather than calling it empty
    awaitingParent: all.some((t) => /^please select a /i.test(t)),
    noChildren: all.some((t) => /^no .* available$/i.test(t)),
    // the widget's own "nothing matched" row. A TERMINAL state for a search: it means keep waiting
    // is pointless, and (for the school pair) that the form's "Other" branch is the right answer.
    noResults: all.some((t) => /^no results/i.test(t)) };
}

// Commit by clicking the row whose text matches EXACTLY (the caller has already run the match ladder).
function atsInjIcimsCommit(inputSel, optionText) {
  const el = document.querySelector(inputSel);
  if (!el || !el.id) return { ok: false, error: "not-found:" + inputSel };
  const ul = document.getElementById(el.id + "_dropdown-results");
  if (!ul) return { ok: false, error: "no-results-list" };
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const row = [...ul.children].find((li) => norm(li.textContent) === norm(optionText));
  if (!row) return { ok: false, error: "option-not-found" };
  for (const t of ["pointerdown", "mousedown", "mouseup", "click"]) {
    row.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
  }
  return { ok: true };
}

// Read-back: the widget's OWN displayed text. Never `select.value` — that is an opaque numeric id.
function atsInjIcimsRead(inputSel) {
  const el = document.querySelector(inputSel);
  if (!el || !el.id) return { ok: false, error: "not-found:" + inputSel };
  const shown = document.getElementById(el.id + "_fakeSelected_icimsDropdown");
  const t = shown && shown.textContent ? shown.textContent.replace(/\s+/g, " ").trim() : "";
  const placeholder = !t || /^—\s*make a selection/i.test(t) || /^please select/i.test(t);
  return { ok: true, value: placeholder ? null : t, rawId: el.value || null };
}

// Close, and CONFIRM it closed. Same rule as the Workday dropdown close: a list left mounted over
// the next field's opener is how a stray click commits the wrong value.
function atsInjIcimsClose(inputSel) {
  const el = document.querySelector(inputSel);
  if (!el || !el.id) return { ok: false, error: "not-found:" + inputSel };
  const ctnr = document.getElementById(el.id + "_icimsDropdown_ctnr");
  if (!ctnr) return { ok: true, closed: true };
  if (!/dropdown-invisible/.test(String(ctnr.className))) {
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    const opener = document.getElementById(el.id + "_icimsDropdown");
    if (opener && !/dropdown-invisible/.test(String(ctnr.className))) {
      for (const t of ["pointerdown", "mousedown", "mouseup", "click"]) {
        opener.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
      }
    }
  }
  return { ok: true, closed: /dropdown-invisible/.test(String(ctnr.className)) };
}

// Click a repeating section's "Add More" anchor. Anchored by the anchor's OWN TEXT rather than its
// id (`rcf3211Button_-1` is per-customer) — every one of them reads "Add More (<section name>)".
// Returns the control count before/after so the caller can tell a real mount from a no-op.
// Where does this field sit inside the FRAME's document? (absolute, not viewport-relative)
function atsInjFrameFieldY(inputSel) {
  const el = document.querySelector(inputSel);
  if (!el) return { ok: false };
  const r = el.getBoundingClientRect();
  return { ok: true, y: Math.round(r.top + (window.scrollY || 0)), h: Math.round(r.height) };
}

// ⚠ SCROLLING INSIDE THE FRAME MOVES NOTHING WHEN THE FRAME IS FULL-HEIGHT. iCIMS sizes its iframe
// to its content, so the frame's document has no scrollbar of its own — the TOP window is the
// scroller. `atsInjScrollIntoView` therefore ran per field and the operator still saw a motionless
// page. This runs in the TOP frame and scrolls it to the field's position PLUS the iframe's own
// offset, which is the only place that arithmetic is available.
function atsInjScrollTopToFrameY(y, h) {
  const fr = document.getElementById("icims_content_iframe") ||
    document.querySelector('iframe[id*="icims"], iframe[name*="icims"]');
  if (!fr) return { ok: false };
  const fy = fr.getBoundingClientRect().top + (window.scrollY || 0);
  const target = fy + y - Math.max(120, (window.innerHeight || 800) / 2 - (h || 0) / 2);
    // ⚠ INSTANT, NEVER SMOOTH. A smooth scroll is still ANIMATING when the next widget is opened and
  // clicked, and these comboboxes portal their menu at a fixed screen position — so the page slid
  // under the menu and three fields that had filled cleanly came back "no option matched". Watching
  // the fill must never move the page while the fill is touching it.
  window.scrollTo({ top: Math.max(0, Math.round(target)), behavior: "auto" });
  return { ok: true };
}

function atsInjIcimsAddEntry(labelPattern) {
  const re = new RegExp(labelPattern, "i");
  const anchors = [...document.querySelectorAll("a, button")].filter((a) => {
    const t = (a.textContent || "").replace(/\s+/g, " ").trim();
    return /^add more/i.test(t) && re.test(t);
  });
  if (!anchors.length) return { ok: false, error: "no-add-button" };
  const before = document.querySelectorAll("input, select, textarea").length;
  const a = anchors[anchors.length - 1]; // the LAST one is the live section's, after any prior adds
  for (const t of ["pointerdown", "mousedown", "mouseup", "click"]) {
    a.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
  }
  return { ok: true, before, label: (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60) };
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
    // A react-select MULTI has NO .select__single-value — its selection is chips. Reading only
    // the single value fell through to el.value, which is the SEARCH input and is empty after a
    // commit, so a perfectly good fill reported `commit did not persist (read null)` and three
    // REQUIRED demographic questions were escalated for nothing (live 2026-08-02, Greenhouse).
    const chips = sel ? [...sel.querySelectorAll(".select__multi-value")] : [];
    if (chips.length) {
      const seen = [];
      for (const c of chips) { const t = txt(c.querySelector(".select__multi-value__label") || c); if (t && seen.indexOf(t) === -1) seen.push(t); }
      if (seen.length) return { ok: true, value: seen.join(", ") };
    }
    return { ok: true, value: el.value || null };
  }
  if (widgetType === "multiselect_native") return { ok: true, value: [...el.selectedOptions].map(txt).join(", ") || null };
  if (widgetType === "dropdown_native") return { ok: true, value: el.selectedIndex > 0 ? txt(el.options[el.selectedIndex]) : null };
  // ⚠ iCIMS' AJAX combobox: its <select> is empty and holds an opaque numeric id, so BOTH the usual
  // reads (`selectedIndex`/`el.value`) lie about it — one says "nothing selected", the other returns
  // "12781". The truth is the text the widget displays. Without this the post-fill audit would flag
  // every one of these as audit-mismatch on a correct fill.
  if (widgetType === "icims_dropdown") {
    const shown = el.id ? document.getElementById(el.id + "_fakeSelected_icimsDropdown") : null;
    const t = shown ? txt(shown) : "";
    return { ok: true, value: (!t || /^—\s*make a selection/i.test(t) || /^please select/i.test(t)) ? null : t };
  }
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
// `force` clicks REGARDLESS of aria-expanded. ⚠ aria-expanded LIES (live 2026-07-31, Discord):
// degree--0 sat at aria-expanded="true" with no menu in the DOM, so an expanded-gated open
// skipped the click forever and every read returned zero options — the field then reported
// "no options" on a list that opens fine by hand. The toggle-shut invariant still holds for the
// DEFAULT path; the caller only forces after it has SEEN an empty list, where a click can only
// improve matters (it either opens the menu or closes a phantom-open one so the next click opens).
function atsInjOpenAndReadOptions(inputSel, force) {
  const el = document.querySelector(inputSel);
  if (!el) return { ok: false, error: "not-found:" + inputSel };
  const fire = (n, t) => n.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
  const container = el.closest(".select__container") || el.closest('[class*="_input"]')?.parentElement || el.parentElement;
  const ctrl = (container && (container.querySelector(".select__control") || container)) || el;
  const already = el.getAttribute("aria-expanded") === "true";
  const clicked = force === true || !already;
  if (clicked) { fire(ctrl, "mousedown"); fire(ctrl, "mouseup"); fire(ctrl, "click"); }
  return { ok: true, opened: true, already, clicked };
}

function atsInjReadOptions(inputSel) {
  const el = document.querySelector(inputSel);
  if (!el) return { ok: false, error: "not-found:" + inputSel };
  // Scope: react-select names its listbox react-select-<name>-listbox and options
  // react-select-<name>-option-N; aria-controls / aria-owns carries the id when open.
  const listboxId = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
  let scope = listboxId ? document.getElementById(listboxId) : null;
  const shell = el.closest(".select__container") || el.closest(".select") || el.closest(".ashby-application-form-field-entry") || el.parentElement;
  if (!scope) scope = (shell || document).querySelector('.select__menu, [role="listbox"]') || null;
  // LOADING is the ONLY thing that separates "the list has no such option" from "the list has
  // not answered yet" — and a server-backed menu ANNOUNCES "No options" while its own search is
  // still pending, so an empty read is not an answer. Traced live 2026-08-04 on Discord's
  // school picker (a hidden tab), from the instant the query was typed:
  //     t=4ms    0 options, "No options"      ← what a 2s poll used to believe
  //     t=24ms   0 options, "Loading..."      ← the loading indicator appears
  //     t=4049ms 1 option,  "Swarthmore College"
  // react-select renders .select__loading-indicator / a "Loading..." menu message while its
  // async loadOptions runs; aria-busy covers the same idea on other widgets.
  const loading = !!(
    (shell && shell.querySelector('[class*="loading"]')) ||
    el.getAttribute("aria-busy") === "true" ||
    (scope && /^\s*loading\b/i.test((scope.textContent || "").replace(/\s+/g, " ")))
  );
  if (!scope) return { ok: true, open: false, options: [], loading };
  const opts = [...scope.querySelectorAll('[role="option"], .select__option')].map((o) => ({
    text: (o.textContent || "").replace(/\s+/g, " ").trim(),
    disabled: o.getAttribute("aria-disabled") === "true",
  })).filter((o) => o.text);
  return { ok: true, open: true, options: opts, loading };
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

// The combobox input's CURRENT text — proves whether a typed query actually landed (a
// controlled React input can revert it on the next render).
function atsInjReadComboInput(inputSel) {
  const el = document.querySelector(inputSel);
  if (!el) return { ok: false, error: "not-found:" + inputSel };
  return { ok: true, value: el.value, expanded: el.getAttribute("aria-expanded") };
}

// Commit an option BY TEXT inside the scoped listbox (synthetic mousedown/click — proven
// to commit react-select live). Returns the committed display value for the verify gate.
async function atsInjCommitOption(inputSel, optionText) {
  const el = document.querySelector(inputSel);
  if (!el) return { ok: false, error: "not-found:" + inputSel };
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const fire = (n, t) => n.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // A react-select MULTI holds its selection as CHIPS and a further commit APPENDS — it also
  // HIDES an already-selected option, so a re-run cannot re-pick the same value and could pick a
  // different one, leaving two contradictory answers on a single-answer question (live
  // 2026-08-02: Male + Female on 'Please identify your sex'). Do what a person does: press the
  // chip's little x to clear it, then pick the one we want (operator 2026-08-02). Verified live:
  // removing a chip puts its option back in the menu, and the result is exactly one chip.
  const shell = el.closest(".select");
  const chipsNow = () => (shell ? [...shell.querySelectorAll(".select__multi-value")] : []);
  const chipText = (c) => String(((c.querySelector(".select__multi-value__label") || c).textContent) || "").replace(/\s+/g, " ").trim();
  let cleared = null;
  const held = chipsNow().map(chipText);
  if (held.length) {
    // exactly the value we want, and nothing else ⇒ done, ZERO actuation
    if (held.length === 1 && norm(held[0]) === norm(optionText)) return { ok: true, already: true, held };
    for (const c of chipsNow()) {
      const x = c.querySelector(".select__multi-value__remove");
      if (x) { fire(x, "mousedown"); fire(x, "mouseup"); fire(x, "click"); await sleep(320); }
    }
    cleared = held;
    await sleep(400);
    const stuck = chipsNow().map(chipText);
    if (stuck.length) return { ok: false, error: "could-not-clear:" + stuck.join(", "), cleared, held: stuck };
    // Re-open: clearing closes the menu, and the removed option only reappears afterwards.
    const ctrl = el.closest(".select__control");
    if (ctrl) { fire(ctrl, "mousedown"); fire(ctrl, "mouseup"); fire(ctrl, "click"); await sleep(700); }
  }

  // Resolve the listbox AFTER any re-open — the old node is gone by then.
  const listboxId = el.getAttribute("aria-controls") || el.getAttribute("aria-owns");
  let scope = listboxId ? document.getElementById(listboxId) : null;
  if (!scope) {
    const container = el.closest(".select__container") || el.closest(".ashby-application-form-field-entry") || document;
    scope = container.querySelector('.select__menu, [role="listbox"]');
  }
  if (!scope) return { ok: false, error: "no-open-listbox", cleared };
  const target = [...scope.querySelectorAll('[role="option"], .select__option')].find((o) => norm(o.textContent) === norm(optionText));
  if (!target) return { ok: false, error: "option-not-found", cleared };
  fire(target, "mousedown"); fire(target, "mouseup"); fire(target, "click");
  return { ok: true, cleared };
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

// WHY THE ATTACH LOOKED SLOW (2026-08-05): the confirmation poll read `input.files[0].name`, and these
// ATSs CLEAR the input once their upload XHR completes — the same lesson Workday's attach learned as
// "success is the confirmation ROW, not the input". So on Coinbase the poll ran its FULL 15s ceiling,
// returned `verified:false`, and charged the run 15.2s for an upload the operator sees land instantly.
// Read both: the input while it still holds the file, and the FILENAME the form renders near the field
// once the upload is done. Error text is reported, never fatal on its own — Workday's role="alert" is a
// STATUS channel ("… loading"), and a false "upload failed" is worse than a slow one (2026-07-29).
function atsInjReadFileState(inputSel, wantName) {
  const txt = (n) => (n && n.textContent ? n.textContent.replace(/\s+/g, " ").trim() : "");
  // Does the page SHOW the file we attached? Matched on the filename's stem, because a widget may
  // render it truncated or re-quoted. >=4 chars so a short stem cannot match by coincidence.
  const stem = String(wantName || "").replace(/\.[a-z0-9]+$/i, "").trim().toLowerCase();
  const shownOnPage = () => {
    if (stem.length < 4) return null;
    const body = txt(document.body).toLowerCase();
    return body.includes(stem) ? String(wantName) : null;
  };
  const el = document.querySelector(inputSel);
  if (!el) {
    // ⚠ AN ABSENT INPUT IS NOT A FAILURE. Greenhouse REPLACES the <input type=file> with its
    // attachment row once the upload completes, so the element we were polling is GONE — and the
    // poll spent its whole 15s ceiling on `not-found:#resume` while the résumé sat attached on the
    // form (live 2026-08-05, GitLab + Coinbase; by hand the attach is instant). The filename
    // rendered on the page is the confirmation.
    const shown = shownOnPage();
    return { ok: true, inputGone: true, fromInput: null, rendered: shown, error: null, progress: null };
  }
  const fromInput = (el.files && el.files[0] && el.files[0].name) || null;
  // widen a few levels: the confirmation row is a sibling of the input's immediate wrapper
  let scope = el.parentElement;
  for (let i = 0; i < 3 && scope && scope.parentElement; i++) scope = scope.parentElement;
  const body = txt(scope);
  const m = /[\w()\-.,' ]+\.(pdf|docx?|rtf|txt)/i.exec(body);
  const rendered = (m ? m[0].trim() : null) || shownOnPage();
  const alerts = scope ? [...scope.querySelectorAll('[role="alert"],[class*="error"]')].map(txt).filter(Boolean) : [];
  const bad = alerts.find((t) => /(error|failed|unsupported|too large|invalid|not allowed|try again)/i.test(t)) || null;
  const progress = alerts.find((t) => /(loading|uploading|in progress|processing|\d+%)/i.test(t)) || null;
  return { ok: true, inputGone: false, fromInput, rendered, error: bad, progress };
}


// Greenhouse's location box is backed by google.maps places. In this browser that library never loads
// — a HUMAN gets no suggestions either (2026-07-31) — and the fill still paid the full places budget
// on every such form: 10.6s on Coinbase, for a service that cannot answer. Ask the page whether the
// library is even there before waiting on it. Absent ⇒ go straight to the honest typed-unverified
// path; present ⇒ wait exactly as before, because then the suggestions really are coming.
function atsInjPlacesReady() {
  try {
    const g = window.google;
    const has = !!(g && g.maps && g.maps.places);
    return { ok: true, places: has };
  } catch (e) { return { ok: true, places: false }; }
}

// Bring the field being filled into view. On a VISIBLE run the operator is watching, and a fill that
// jumps around off-screen is impossible to follow or to trust (operator, 2026-08-06). It also gives a
// hidden tab a reason to lay the element out, which is what the coordinate paths need — trustedFocus
// already scrolls for exactly that reason, so this brings the ordinary path in line.
// `block:"center"` rather than the default, so the field is not left tucked under a sticky header.
function atsInjScrollIntoView(sel) {
  const el = document.querySelector(sel);
  if (!el) return { ok: false, error: "not-found:" + sel };
  try {
    const target = el.closest("label, fieldset, .select__container, div") || el;
    target.scrollIntoView({ block: "center", inline: "nearest" });
  } catch (e) {
    try { el.scrollIntoView(); } catch (e2) { return { ok: false, error: String((e2 && e2.message) || e2) }; }
  }
  return { ok: true };
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
  // ⚠ iCIMS NEEDS ITS OWN BRANCH, and without it the form is REFUSED rather than filled. Its control
  // is `<input type="submit" id="cp_form_submit_i" value="Submit Profile">`, which the generic finder
  // below cannot see twice over: it queries only `button`s, and it matches on `textContent`, which an
  // <input> does not have (its caption is `.value`). `hasSubmit:false` makes
  // atsLooksLikeApplicationForm reject a perfectly good page as "not an application form".
  // Scoped to iCIMS so the other three tenants' detection stays byte-identical.
  // Detection only — nothing here clicks anything; the fill run never submits, and the submit run
  // clicks only behind the arm gate.
  if (ats === "icims") btn = [...document.querySelectorAll('#cp_form_submit_i, input[type="submit"], button[type="submit"]')].find((b) => vis(b)) || null;
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

// Attach a choice field's LIVE options to its review record. A list we could only read the
// FIRST PAGE of must NOT render as a <select>: a 2000-school picker truncated to its A-names
// invites the operator to pick a wrong-but-present option, or strands them when the right one
// is absent (live 2026-07-31). The bundle schema already distinguishes these — `options` is a
// COMPLETE list, `captured_options` is a partial one — and the review editor renders the
// partial case as a type-to-filter combobox with a "partial list" note. A truncated list is,
// from the reviewer's point of view, exactly a typeahead, so the record says so.
// The options a human would actually be choosing between, given the value we WANTED. Searching
// a 3302-school list for "Carnegie Mellon University" should put its two campuses in front of
// the operator, not the alphabetical page the widget happened to render (live 2026-07-31). Pure
// and client-side: the whole list is already in memory, so this costs no page interaction.
// Ranks by how many significant tokens an option contains, then prefix, then brevity.
function atsNearOptions(texts, query, limit) {
  const q = atsLib.normalize(String(query == null ? "" : query));
  const toks = q.split(/\s+/).filter((t) => t.length > 2);
  if (!toks.length) return [];
  const scored = [];
  for (const t of (texts || [])) {
    const n = atsLib.normalize(t);
    let hits = 0;
    for (const tk of toks) if (n.indexOf(tk) !== -1) hits++;
    if (hits) scored.push({ t, hits, starts: n.indexOf(toks[0]) === 0 ? 1 : 0 });
  }
  scored.sort((a, b) => b.hits - a.hits || b.starts - a.starts || a.t.length - b.t.length);
  return scored.slice(0, limit || 20).map((x) => x.t);
}

// Poll budgets for the combobox family, in ms: a SOFT deadline plus a hard CEILING that is only
// ever reached by a widget still reporting `loading` when the soft deadline passes (see
// atsInjReadOptions). A healthy widget exits on its first read and pays neither. `search` is
// sized from the live measurement that earned this: Discord's school list answered at 4049ms on
// a hidden tab, so the old flat 2000ms could not have worked no matter how it retried.
const ATS_POLL = {
  // The first render after opening. The soft deadline only applies once the menu has actually
  // SETTLED (see pollFor): an empty read while the menu node isn't even mounted is not an answer,
  // any more than a half-mounted Workday page is. This matters beyond speed — an empty first read
  // is what decides whether a location-routed field is a places box or a pick-one (live
  // 2026-08-05: a REQUIRED 3-option question was read as empty at 1.8s, treated as a places
  // lookup, and left unanswered while its own widget was about to show the answer).
  open: 1800, openCeil: 6000,
  retry: 1500, retryCeil: 4000,     // after a forced re-open
  // A typed by-name query. The ceiling is paid ONLY while the widget still reports loading, so
  // it is not a flat cost — and it has to be generous because the list behind it is a slow,
  // highly variable third-party service: measured on ONE session, Greenhouse's school endpoint
  // answered a fresh query in 390ms, 4049ms, 4459ms and then >12s (a direct fetch of the same
  // query: HTTP 200 in 2971ms, no rate limiting). An 8s ceiling missed the bad end of that
  // spread, which is a REQUIRED field going unanswered — much more expensive than the wait.
  // A healthy search answers in ~1.3s (measured on Discord: "Loading..." → result, and
  // "Loading..." → "No options" for a genuine miss). A widget still loading after this is the
  // dead-form state, and the remedy is the page refresh the run now performs — so waiting longer only
  // delays the fix. Was 20000, which cost ~20s per silent widget before the reload could help.
  search: 2000, searchCeil: 6000,
  restore: 1200, restoreCeil: 3000, // clearing the query to report real options
  showing: 900, showingCeil: 3000,  // waiting for the option we are about to click
  loadingTick: 400,                 // poll interval WHILE the widget reports loading (see pollFor)
  fieldMaxMs: 20000,                // TOTAL option-polling allowance for ONE field (see pollFor)
  mountGrace: 1200,                 // extra wait for a menu that has NEVER mounted (see pollFor)
  responsiveReadMs: 400,            // fallback signal when the quiet watch is unavailable (see pollFor)
  busyIdleMs: 300,                  // DOM mutated this recently ⇒ the page is still reacting, keep waiting
};
// A location question whose widget already shows this few options is a pick-one, not a places
// autocomplete (see the location branch in atsActuateField).
// A location QUESTION, by wording. Shared, because the bucket rung has to ask it too: a taught
// bucket answers before the label ladder runs, so a location field whose value came from a bucket used
// to be matched as an ordinary dropdown — and "Pittsburgh, PA" cannot match the suggestion
// "Pittsburgh, Pennsylvania, United States" under the strict ladder, even though the widget offered it
// (live 2026-08-06, Ashby/Cohere: five real suggestions, no hit, 17.5s spent).
const ATS_LOCATION_LABEL_RE = /where are you (currently )?(located|based)|current location|^location( \(city\))?$|city of residence/i;

// A US STATE HAS TWO SPELLINGS AND A PLACES SERVICE KNOWS ONLY ONE (2026-08-07). Live on Ashby, the
// same profile on two forms an hour apart: "Pittsburgh, Pennsylvania," HIT in 2.2s and committed,
// while "Pittsburgh, PA" returned nothing for 17.5s and reached review as "the form's places service
// didn't respond" — which is not what happened. The service answered fine; it had never heard of that
// spelling. The profile stores whichever spelling the operator typed and a bucket can supply its own,
// so neither can be canonical.
//
// So a places box is searched with the CITY ALONE, which every spelling agrees on. That is a looser
// QUERY, and the comment on the search loop already notes a looser query never loosens the answer —
// but only because the PICK stays strict, and picking "the first row containing the city" is not
// strict when the city is Pittsburgh (PA, CA, TX) or Springfield. Filing against the wrong state at
// the exact-normalized tier is precisely the silent-wrong-value failure this ladder exists to
// prevent. Hence: prefer the row that also agrees on the STATE, in EITHER spelling; if we hold a
// state and no row agrees, still answer, but at the flagged tier so a human sees it. Mirrors the
// Lever location path, which has resolved city+state through REGION_ABBREV since 2026-08-02.
// A DEAD POSTING IS NOT A BROKEN PIPELINE (2026-08-07). Two runs in a row halted
// "form-not-rendered ... open the tab and check", which sends the operator to debug the fill on a job
// that simply no longer exists. Both said so plainly before we ever looked for a form: Lever answers
// a removed posting with the title "Not found", and Greenhouse REDIRECTS to the company's board index
// ("Current openings at Twilio"), dropping the job id from the URL on the way.
//
// The URL check is the general one and the title checks corroborate it — a posting we asked for by id
// that we are no longer standing on is gone, whatever the page says. Returns a REASON to quote back,
// or null when there is no evidence, because "I could not drive this form" and "this job is closed"
// are different problems with different next steps.
function atsPostingGone(jd, requestedUrl, landedUrl) {
  const title = String((jd && jd.title) || "").trim();
  if (/^(not found|404|page not found|job not found)$/i.test(title)) return 'the posting page reports "' + title + '"';
  if (/^current openings at/i.test(title)) return 'it redirected to the board index ("' + title + '")';
  const idOf = (u) => {
    const t = String(u || "");
    const m = /\/jobs?\/(\d{4,})/.exec(t) ||
      /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(t);
    return m ? m[1].toLowerCase() : null;
  };
  const want = idOf(requestedUrl);
  if (want && landedUrl && !String(landedUrl).toLowerCase().includes(want)) {
    return "the posting id " + want + " is no longer in the URL we landed on";
  }
  return null;
}

function atsPlacePick(candidate, texts) {
  const c = String(candidate == null ? "" : candidate);
  const city = c.split(",")[0].trim().toLowerCase();
  if (!city) return null;
  const rows = (texts || []).map((t, i) => ({ t: String(t == null ? "" : t), i }))
    .filter((r) => r.t.toLowerCase().includes(city));
  if (!rows.length) return null;
  const tierOf = (r) => (r.t.toLowerCase().startsWith(city) ? "exact-normalized" : "containment");

  const abbrevOf = atsLib.REGION_ABBREV || {};                     // "pennsylvania" → "pa"
  const nameOf = Object.create(null);
  for (const k of Object.keys(abbrevOf)) nameOf[abbrevOf[k]] = k;  // "pa" → "pennsylvania"
  const state = (c.split(",")[1] || "").trim().toLowerCase();
  // whatever the profile gave us, plus its other spelling — deduped, empties dropped
  const forms = [...new Set([state, abbrevOf[state], nameOf[state]].filter(Boolean))];
  if (!forms.length) return { index: rows[0].i, tier: tierOf(rows[0]) };   // no state to check against

  const agrees = (t) => forms.some((s) => (s.length === 2
    ? new RegExp(",\\s*" + s + "\\b", "i").test(t)   // an abbrev must sit in its own segment
    : t.toLowerCase().includes(s)));
  const withState = rows.find((r) => agrees(r.t));
  if (withState) return { index: withState.i, tier: tierOf(withState) };
  // the city is offered, but never in the state we hold — a DIFFERENT place of the same name.
  return { index: rows[0].i, tier: "containment", stateMismatch: true };
}
const ATS_LOC_PICKONE_MAX = 12;
const ATS_OPTION_CAP = 60;
// `partial` FORCES the partial treatment for a list we have already narrowed. Live 2026-08-04: a
// 100-option page read was narrowed to its 20 near-matches, which then looked like a COMPLETE
// short list — so review offered the operator a pick-one <select> of 20 schools that did not
// include theirs, with no way to type the real one. Narrowing must never launder a paged list into
// a complete one; the caller knows which it is.
// Is what we read the WHOLE option set? A short, settled, non-loading list is complete: everything the
// widget has is on screen, so a no-match is a real answer and typing could only filter it away. A
// page-sized read (>= the cap) is a paged/server-backed list, where searching by name is the only way
// to reach an option that was never rendered.
function atsListIsComplete(read) {
  const opts = ((read && read.options) || []).filter((o) => !o.disabled);
  return opts.length > 0 && opts.length < ATS_OPTION_CAP && !(read && read.loading);
}

// PARTIAL IS ABOUT PROVENANCE, NOT LENGTH (2026-08-07). This used to call any list of >= 60 partial,
// which is the wrong test and threw away options we had already read: traced live on Discord, the
// dial `country` menu holds all **244** entries in the DOM (…"Zimbabwe+263") and `discipline--0` all
// **72**, unchanged after scrolling to the bottom — react-select renders every option and CSS-clips
// it. We stored 60 of them and printed "not the full list", so review offered a truncated picker for
// a field whose whole list was in hand. (Checked while confirming the ATS path needs no scroll
// accumulator at all — unlike Workday's virtualized picker. Full survey: dom-patterns 2026-08-07.)
//
// The true rule: a list read on OPEN — nothing typed, not loading — IS the complete list, however
// long. A list that only exists because we typed a query is a filtered view of it, and a
// server-backed page (the 3300-school picker serving 100 at a time) is genuinely one page. Callers
// pass that provenance; `undefined` means "read unfiltered", which is the common case.
const ATS_OPTION_STORE_MAX = 400; // a complete list longer than this is stored truncated, and SAYS so
function atsAttachOptions(rec, texts, partial) {
  const list = (texts || []).filter(Boolean);
  if (!list.length) return;
  // ALWAYS set both: a later call refines an earlier one (the raw list first, then the
  // neighbourhood of what we wanted), and a leftover from the first call would show the
  // operator a STALE option set in review.
  if (partial === true || list.length > ATS_OPTION_STORE_MAX) {
    rec.captured_options = list.slice(0, ATS_OPTION_STORE_MAX);
    rec.options = null;
    rec.widgetType = "typeahead"; // review renders a filter-or-type editor + an honest partial note
    rec.optionsPartial = true;
    return;
  }
  rec.options = list;
  rec.captured_options = null;
}

const ATS_REVIEW_WIDGET = { // scan widgetType → the review schema's widget_type vocabulary
  text: "text", textarea: "textarea", select: "dropdown", dial: "dropdown", location: "typeahead",
  dropdown_native: "dropdown", radio: "radio", checkbox: "checkbox", checkbox_group: "checkbox_group",
  yesno: "radio", file_upload: "file_upload", date: "date", unknown: "unknown",
  icims_dropdown: "dropdown", multiselect_native: "checkbox_group",
};

// Options for a dial-code select carry a trailing "+<digits>" ("United States +1") that no
// profile value will ever contain — strip it for matching, commit by the FULL text.
// Read a committed value back, POLLING until it appears. `act.delay` is ADAPTIVE — it collapses
// to ~20ms whenever page timers measure fast — so "delay(200) then read once" could sample the
// widget BEFORE React had committed its re-render, and report `commit did not persist (read
// null)` on a commit that in fact worked. Live 2026-08-02 that hit two Greenhouse dropdowns on
// HIDDEN runs (Chime, Gusto); by hand the same widgets commit and read back "No" every time.
// It is the same trap the option poll already documents: an adaptive interval starves the
// renderer, and this pipeline's rule is that a wait polls the condition it gates.
// A genuinely blank field still reports blank — it just costs the full window to say so, and the
// callers that WANT blank (the no-commit dismissal) do not use this.
async function atsReadBackSettled(act, ats, inputSel, widgetType, ms) {
  const deadline = Date.now() + (ms || 2000);
  let b = null;
  for (;;) {
    b = await act.eval(atsInjReadValue, ats, inputSel, widgetType);
    const v = b && b.ok ? b.value : null;
    if (v !== null && v !== undefined && String(v).trim() !== "") return b;
    if (Date.now() >= deadline) return b;
    await act.delayFull(120); // REAL — see above
  }
}

function atsDialStrip(optText) { return String(optText || "").replace(/\s*\+\d[\d\s-]*$/, "").trim(); }

// A NUMBERED option ("1. United States of America") carries display scaffolding, not a different
// answer — and the numbering defeats every tier we have: exact fails, containment is deliberately
// OFF for dropdowns (picking a substring match is a guess), and fuzzy lands at 88.9% against the
// 90 bar. Live 2026-08-05, GitLab "Where are you currently based?*": the profile holds exactly
// "United States of America" and the REQUIRED field was left empty. Stripped for MATCHING only —
// the commit still clicks the option's real text, so the form gets what it rendered. Narrow on
// purpose: 1–2 digits then a dot or paren then whitespace, so "1 - 3 years" and "401(k)" are
// untouched (neither has the separator+space shape).
function atsEnumStrip(optText) { return String(optText || "").replace(/^\s*\d{1,2}\s*[.)]\s+/, "").trim(); }

// A dial composite's options read "<Country> +<code>", but the profile stores the phone country
// as a LONG-FORM name with the code in parentheses — "United States of America (+1)". Stripping
// only the OPTION's code leaves "united states" against "united states of america", which cannot
// match by exact, containment OR fuzzy: live 2026-08-02 EVERY Greenhouse #country field failed
// this way and reached review, on a form where the widget itself was perfectly healthy.
//
// Match on TWO INDEPENDENT SIGNALS AGREEING: the dial CODES are equal AND one country name is a
// prefix of the other. Neither is safe alone — the code is shared (+1 covers the US, Canada and
// much of the Caribbean; dial-suffix matching was PARKED for exactly that reason), and a bare
// prefix would let "Congo" take "Congo, Democratic Republic of the". Together they disambiguate.
// Ambiguity still refuses: 2+ options satisfying both is not a confident answer.
function atsDialCode(s) { const m = /\+\s*(\d[\d\s-]*)/.exec(String(s == null ? "" : s)); return m ? m[1].replace(/[\s-]/g, "") : null; }
function atsDialName(s) {
  return String(s == null ? "" : s)
    .replace(/\(?\s*\+\s*\d[\d\s-]*\)?/g, " ")
    .replace(/[(),]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
function atsDialMatch(candidates, optionTexts) {
  const opts = optionTexts || [];
  for (const cand of candidates || []) {
    const cc = atsDialCode(cand), cn = atsDialName(cand);
    if (!cc || !cn) continue;
    const hits = [];
    opts.forEach((o, i) => {
      if (atsDialCode(o) !== cc) return;
      const on = atsDialName(o);
      if (on && (on === cn || on.startsWith(cn) || cn.startsWith(on))) hits.push(i);
    });
    if (hits.length === 1) return { index: hits[0], tier: "dial-code+name" };
  }
  return null;
}

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

// ── APPLY AFFORDANCES (the landing may not be the form) ─────────────────────────────────
// A posting URL does NOT always serve the application: an employer can point its ATS link at
// its OWN careers page, which carries only an "Apply" affordance (live 2026-07-31 — a
// Greenhouse posting URL 302'd to the company's branded careers site with zero form fields).
// Same shape as the Workday rule "DETECT THE LANDING — never assume a click went where it
// aimed". Read-only; the PICK is SW-side so it can use detectAts.
function atsInjFindApplyLinks() {
  const seen = new Set();
  const out = [];
  const push = (href, text, kind) => {
    const h = String(href || "").trim();
    if (!/^https?:\/\//i.test(h) || seen.has(h)) return;
    seen.add(h);
    out.push({ href: h, text: String(text || "").replace(/\s+/g, " ").trim().slice(0, 80), kind });
  };
  for (const a of document.querySelectorAll("a[href]")) {
    const t = (a.textContent || "").replace(/\s+/g, " ").trim();
    // apply-LABELLED anchors, and anchors whose own URL says "apply" — never links harvested
    // from description prose (the discovery lesson: a JD routinely cites unrelated companies)
    if (/\bapply\b/i.test(t) || /\/apply|apply\?|application/i.test(a.getAttribute("href") || "")) {
      push(a.href, t, /\bapply\b/i.test(t) ? "text" : "href");
    }
    if (out.length > 40) break;
  }
  const btns = [...document.querySelectorAll("button")]
    .filter((b) => /\bapply\b/i.test((b.textContent || "").trim()))
    .map((b) => (b.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60));
  return { ok: true, url: location.href, links: out, applyButtons: btns.slice(0, 5) };
}

// Click an apply BUTTON (no href) and report where it left us. Some careers pages route their
// apply action through script rather than a link, so an anchor-only search finds nothing and
// the run stops on a page that has a perfectly good Apply button (live 2026-07-31). Text-matched
// because these pages carry no stable attribute; refuses when the match is ambiguous.
function atsInjClickApplyButton() {
  // A HIDDEN tab can skip layout, so a 0x0 rect is NOT proof an element is invisible.
  // checkVisibility() answers from computed style, which a hidden tab still maintains.
  const vis = (el) => {
    if (typeof el.checkVisibility === "function") return el.checkVisibility({ checkVisibilityCSS: true });
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const APPLY_RE = /^apply\b|\bapply (now|here|for this)\b/i;
  const all = [...document.querySelectorAll('button, [role="button"], a[href="#"]')].filter((b) => {
    const t = (b.textContent || "").replace(/\s+/g, " ").trim();
    return APPLY_RE.test(t) && t.length <= 40;
  });
  // Prefer a visibly-rendered one, but an all-invisible verdict falls back to the full set
  // rather than abandoning the run on a measurement a hidden tab is known to get wrong.
  const shown = all.filter(vis);
  const btns = shown.length ? shown : all;
  if (btns.length === 0) return { ok: false, reason: "no-apply-button" };
  const uniq = [...new Set(btns.map((b) => (b.textContent || "").replace(/\s+/g, " ").trim()))];
  if (uniq.length > 1) return { ok: false, reason: "ambiguous", offered: uniq.slice(0, 4) };
  btns[0].click();
  return { ok: true, clicked: uniq[0], hiddenLayout: shown.length === 0 };
}

// An employer page can EMBED the ATS form in an iframe rather than link to it (Greenhouse's
// "#grnhse_app" widget and its `?gh_jid=` pages are the common case; Lever and Ashby ship the
// same kind of widget). The iframe SRC is the exact URL the employer itself uses, so reading it
// beats constructing one from a job id: no guessing about which board host or path shape.
// Returns every frame src so the SW can pick with detectAts and report what it saw.
function atsInjFindEmbeddedForms() {
  const srcs = [...document.querySelectorAll("iframe")]
    .map((f) => f.getAttribute("src") || f.src || "")
    .filter(Boolean);
  return { srcs: srcs.slice(0, 20) };
}

// Pick an embedded ATS form to open. `isAts` is injected (detectAts) so host knowledge stays
// SW-side. Refuses ambiguity the same way the apply-link picker does: two DIFFERENT ATS frames
// on one page is not a situation to guess through.
function atsPickEmbeddedForm(srcs, isAts) {
  const abs = (u) => { try { return new URL(u, "https://x.invalid").href; } catch (e) { return null; } };
  const ats = (srcs || []).map(abs).filter((u) => u && isAts(u));
  const uniq = [...new Set(ats)];
  return uniq.length === 1 ? uniq[0] : null;
}

// The DURABLE identity of a field, for matching a stored review entry against a live form on a
// LATER page load. Two ATS-wide prefixes are per-session noise and must be stripped:
//   - Ashby renders a custom question as "<form-instance-uuid>_<question-uuid>", and the FIRST
//     uuid is regenerated on every page load (live 2026-08-01: the same two work-authorization
//     questions came back under a different prefix, so the replay reported the approved values
//     as having no field on the form and refused an otherwise-clean submit).
//   - Its system fields carry the same kind of prefix before "__systemfield_".
// Only a FULL uuid followed by more content is stripped, so a field whose real name merely
// starts with hex is left alone.
function atsDurableFieldName(name) {
  let n = String(name == null ? "" : name);
  n = n.replace(new RegExp("^" + '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' + "(?=__systemfield_)", "i"), "");
  n = n.replace(new RegExp("^" + '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' + "_(?=.+$)", "i"), "");
  return n;
}

// The form's OWN "no answer" option, if it offers one. A required choice question the profile
// cannot answer must not be left blank — it blocks the submit and reaches the operator as a
// dead end. Declining is a real, truthful, submittable answer that asserts nothing false, and a
// form only ever OFFERS it for a question where declining is acceptable. This is the choice-
// widget twin of the required-text "N/A" rule (operator 2026-07-31: "never answer with AI
// declined, N/A would be better"). Anchored at the start so it can never match a real answer.
var ATS_DECLINE_RE = /^(i )?(don't|dont|do not|prefer not|choose not|wish not|decline)\s*(to\s*)?(wish |want )?(to )?(answer|self[ -]?identify|disclose|say|state|specify|respond|provide)/i;
function atsDeclineOption(texts) {
  const list = (texts || []).map((t) => String(t == null ? "" : t).replace(/\s+/g, " ").trim());
  const hits = list.filter((t) => t && ATS_DECLINE_RE.test(t));
  // Exactly one decline option is unambiguous; two or more means the wording is doing something
  // we do not understand, so refuse rather than pick one.
  return hits.length === 1 ? hits[0] : null;
}

// Is this page actually an APPLICATION FORM? A settled, non-zero field count only proves the
// page stopped changing — live 2026-08-02 an employer careers page's direct-mail signup
// (a reservation number + a postal code) settled at 2 fields, so the run filled a MARKETING
// widget and filed an application record for it. Nothing was submitted, but a form we cannot
// submit is never the form we came for.
// POSITIVE identification, the same rule as every other control here: an application form has
// a SUBMIT control AND at least one identity anchor (resume, email, or a name field). Both
// hold on every Greenhouse/Lever/Ashby application form; a marketing capture fails the first.
function atsLooksLikeApplicationForm(fields, submitState) {
  const list = Array.isArray(fields) ? fields : [];
  const txt = (x) => (String((x && x.fieldName) || "") + " " + String((x && x.label) || "")).toLowerCase();
  const hasEmail = list.some((x) => /e-?mail/.test(txt(x)));
  const hasResume = list.some((x) => (x && x.widgetType === "file_upload") || /resume|\bcv\b/.test(txt(x)));
  const hasName = list.some((x) => /(^|[^a-z])(first|last|full|preferred|legal)?[ _-]*name([^a-z]|$)/.test(txt(x)));
  const hasSubmit = !!(submitState && submitState.hasSubmit);
  return {
    ok: hasSubmit && (hasResume || hasEmail || hasName),
    hasSubmit, hasResume, hasEmail, hasName,
    why: hasSubmit ? (hasResume || hasEmail || hasName ? "" : "no resume/email/name field — this doesn't look like an application form")
                   : "no submit control on the page — this isn't a form we could ever submit",
  };
}

// Choose the apply link to follow. `isAts` is injected (detectAts) so host knowledge stays
// SW-side. A link the pipeline can actually DRIVE wins; otherwise a single apply-labelled
// link is followed and re-classified on landing; ambiguity refuses (report, never guess).
function atsPickApplyLink(links, isAts) {
  const list = (links || []).filter((l) => l && l.href);
  const uniq = (arr) => [...new Set(arr.map((l) => l.href))];
  const drivable = list.filter((l) => { const k = isAts(l.href); return k && k !== "workday"; });
  if (uniq(drivable).length === 1) return drivable[0].href;
  if (uniq(drivable).length > 1) {
    // several drivable candidates — prefer the apply-LABELLED one if that is unambiguous
    const labelled = drivable.filter((l) => l.kind === "text");
    if (uniq(labelled).length === 1) return labelled[0].href;
    return null;
  }
  const wd = list.filter((l) => isAts(l.href) === "workday");
  if (uniq(wd).length === 1) return wd[0].href;
  const labelled = list.filter((l) => l.kind === "text");
  if (uniq(labelled).length === 1) return labelled[0].href;
  return null;
}

// A STATED demographic and the form's option can be the same answer in different words: the profile
// holds "I am not a protected veteran" (the Workday/Greenhouse wording) while Lever's diversity survey
// offers "I am not a U.S. veteran". Neither contains the other and fuzzy scores ~63%, so nothing
// matched and a stated answer reached review (live 2026-08-06, gopuff).
//
// Bridge on the SELF-ASSERTION, exactly like the Yes/No polarity bridge and with the same guard: the
// candidate must lead with a first-person assertion, the option must lead with the SAME polarity, and
// exactly ONE option may qualify — 2+ refuse rather than guess a demographic. Positive never matches a
// negative ("I identify as a veteran" cannot answer "I am not a veteran"). Flagged like any non-exact
// tier, and only ever reached for a value the operator STATED (allowContainment), never an AI guess.
const ATS_NEG_LEAD_RE = /^\s*i\s+(?:am|do|have)\s+not\b/i;
const ATS_POS_LEAD_RE = /^\s*i\s+(?:am|do|have|identify)\b/i;
function atsAssertionLead(candidate, texts) {
  const c = String(candidate == null ? "" : candidate);
  const neg = ATS_NEG_LEAD_RE.test(c);
  const pos = !neg && ATS_POS_LEAD_RE.test(c);
  if (!neg && !pos) return null;
  const list = (texts || []).map((t) => String(t == null ? "" : t));
  const hits = neg
    ? list.filter((t) => ATS_NEG_LEAD_RE.test(t))
    : list.filter((t) => ATS_POS_LEAD_RE.test(t) && !ATS_NEG_LEAD_RE.test(t));
  return hits.length === 1 ? hits[0] : null;   // ambiguous ⇒ refuse
}

// DEGREE LEVEL is a small closed vocabulary, and forms model it at a different granularity than a
// person states it: the profile says "Bachelor of Science" (and its ladder "Bachelors",
// "Bachelor of Science (BS)"), while Discord's list offers "Bachelor's Degree". The apostrophe and the
// "Degree" suffix put that out of reach of exact, of containment (off for dropdowns by design) and of
// fuzzy (~56%), so a reconned 10-option list produced no match at all (live 2026-08-06).
//
// Match on the LEVEL both sides name, with the usual guard: exactly ONE option may carry that level —
// a form listing "Bachelor of Science" AND "Bachelor of Arts" is a real choice and must reach the
// human. Ordered most-specific first so a doctorate is never read as something else.
const ATS_DEGREE_LEVELS = [
  // ⚠ PROFESSIONAL DOCTORATES ARE SEPARATE LEVELS, not one "doctorate" bucket. A first cut collapsed
  // them, so a PhD candidate matched "Doctor of Medicine (M.D.)" — the only doctorate on the list, so
  // the exactly-one guard cheerfully committed a credential the applicant does not hold. Caught in
  // testing, and it is the worst failure class this project has: a confident wrong value.
  // Most-specific first, so "Doctor of Medicine" reads as md rather than a generic doctorate.
  ["md", /\b(m\.?\s?d\.?|doctor of medicine)\b/i],
  ["jd", /\b(j\.?\s?d\.?|juris doctor)\b/i],
  ["edd", /\b(ed\.?\s?d\.?|doctor of education)\b/i],
  ["phd", /\b(ph\.?\s?d|d\.?phil|doctor of philosophy|doctorate|doctoral)\b/i],
  ["master", /\b(master|masters|m\.?\s?s\.?|m\.?\s?a\.?|m\.?b\.?a|m\.?eng|m\.?phil)\b/i],
  ["bachelor", /\b(bachelor|bachelors|b\.?\s?s\.?|b\.?\s?a\.?|b\.?eng|b\.?tech|undergraduate)\b/i],
  ["associate", /\b(associate|associates|a\.?\s?a\.?|a\.?\s?s\.?)\b/i],
  ["high-school", /\b(high\s?school|secondary|ged)\b/i],
];
function atsDegreeLevel(text) {
  const t = String(text == null ? "" : text).replace(/[\u2018\u2019']/g, "");
  for (const [level, re] of ATS_DEGREE_LEVELS) if (re.test(t)) return level;
  return null;
}
function atsDegreeMatch(candidates, options) {
  const wanted = (candidates || []).map(atsDegreeLevel).find(Boolean);
  if (!wanted) return null;
  const hits = (options || []).filter((o) => atsDegreeLevel(o) === wanted);
  return hits.length === 1 ? hits[0] : null;   // 2+ of the same level is a real choice — ask the human
}

// Is this label a demographic question? ORTHOGONAL to routing (2026-07-31, Zoox): a BUCKET
// can route an EEO field before the label ladder's EEO rung runs, and the bucket carries no
// containment — so "Asian" missed Zoox's "Asian (Not Hispanic or Latino)" even though the
// stated-EEO relief exists. The relief keys off the LABEL, whatever tier produced the value.
function atsIsEeoLabel(label) {
  // Widened 2026-08-06 to the wordings live boards actually use: Reddit asks about "military service"
  // and about being transgender; gopuff's diversity survey asks pronouns, LGBTQ+ and an age RANGE.
  // Every one is a protected-characteristic question, so an AI answer to any of them must carry the
  // loud demographic badge — an ordinary "AI" badge under-warns on a field where a wrong answer is a
  // legal misstatement. Deliberately NOT bare "age": an "are you over 18" question is a different,
  // non-protected thing that legallyLoaded already covers.
  // …and widened again 2026-08-07: a question can ask a protected characteristic WITHOUT naming the
  // dimension. Chime words its gender question "I identify as:" — no "gender", no "sex" — so it read
  // as an ordinary question, and an AI-guessed protected characteristic wore the ordinary `ai-choice`
  // badge while the field right below it ("I identify my sexual orientation as:") got the loud one.
  // The self-identification FRAME is the signal there. Over-flagging is the safe direction: the cost
  // of a false positive is a louder badge on a question that did not need one.
  return /hispanic|latino|race|ethnicit|veteran|military service|disabilit|gender|\bsex\b|sexual orientation|transgender|lgbt|pronoun|age range/i.test(String(label || "")) ||
    /\bi identify (?:as|my)\b|how do you identify\b/i.test(String(label || ""));
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
  // ROUTE: "essay", not the default "fill" (2026-08-12). `act.llm` resolves `action || "fill"`, so
  // omitting it sent every free-text answer — the cover-letter-shaped "why do you want to work here"
  // boxes — to the model configured for yes/no picks. The AI page has had a separate
  // "Fill — essays and long answers" slot all along and the Workday twin (`aiFillText`) already used
  // it; only this path did not, so the operator's essay model was silently unused on GH/Lever/Ashby.
  // …EXCEPT a date, which reaches this function for its prompt SHAPE but is a short factual answer,
  // not prose. Workday's `aiFillDate` routes a date to "fill"; keep the two paths agreeing.
  const action = f && f.widgetType === "date" ? "fill" : "essay";
  const res = await act.llm({ system, user, maxTokens: 700, action });
  if (!res || !res.ok) return { ok: false, error: (res && res.error) || "llm-failed" };
  const parsed = atsFd.parseAiText(res.text); // {skip, answer, reason, maps_to?, suggested_category?}
  if (!parsed || parsed.skip || !String(parsed.answer || "").trim()) return { ok: false, error: (parsed && parsed.reason) || "ai-declined" };
  return { ok: true, answer: parsed.answer, confidence: "Low", justification: parsed.reason || "generated from profile" };
}

// Route ONE scanned field to a value/candidates decision. Pure given its inputs.
// Order: static map → bucket (exact wording) → label recognizers → employment recognizer →
// null (the driver then tries AI for REQUIRED fields, else leaves blank). Same tiering as
// the Workday driver: deterministic tiers run for optional fields too, AI is required-only.
function atsRouteField(ats, f, profile, defaults, jobContext, bucketIndex, credentials) {
  // ── CREDENTIALS — the TOP rung, above the static map, buckets, labels and AI ────────────
  // This is the only way a credential is ever filled, and being FIRST is a safety property, not
  // an ordering preference: every rung below it could otherwise reach a login box (a taught bucket
  // wording, a label recognizer, or the AI rescue on a required field), and each of those would put
  // a value into an account credential that the operator never chose.
  //
  // The properties this tier guarantees:
  //   • the value comes ONLY from `store.credentials` — the same slot the website's Credentials page
  //     writes and the Workday onboarding signs in with. Never a profile value, never a bucket, never
  //     an LLM. There is no path from any of those to a field recognized here.
  //   • it never enters a log line, a record or the review bundle. The record carries `credential:true`
  //     + `credentialKind` so review can name WHICH credential was used without carrying it.
  //   • `overwrite:true` — a prepopulated box is REPLACED. iCIMS renders the session's own login into
  //     it, and the account this application creates must use the stored credentials.
  //   • absent or incomplete credentials ⇒ needs_review, never a blank guess and never half an account.
  const ck = atsCredentialKind(ats, f);
  if (ck) {
    const value = atsCredentialValue(ck, credentials);
    const pretty = ck.replace(/_/g, " ");
    if (!value) {
      return { kind: "credential-missing", credentialKind: ck, review: true, flag: "credentials-not-stored",
        detail: "this form asks for a " + pretty + ", but no complete sign-in credentials are stored — set them on the website's Credentials page, or type it here" };
    }
    return { kind: "credential", credentialKind: ck, value, source: "credentials", credential: true, overwrite: true };
  }
  // ── REPEATING-ENTRY FIELDS ARE SEALED TO THEIR OWN ENTRY ───────────────────────────────
  // Above the static map, buckets and labels, and it RETURNS EVEN WHEN IT HAS NO ANSWER — that
  // early return is the point. Falling through would let the label ladder answer an Education
  // "State/Province" from the home address, which is a different fact, not a near-miss. An entry
  // field the entry cannot answer goes to the AI, which sees only that entry (atsScopeForField).
  // ⚠ `es` ALONE SEALS IT — deliberately not `es && es.spec`. A field inside a repeating section
  // that we have NO mapping for must still be sealed: with the `.spec` condition, an unmapped
  // `EducationCity` fell straight through to the label ladder and was answered "Tallahassee" from
  // the home address. No mapping means "no deterministic answer", never "answer it from anywhere".
  const es = atsEntrySpec(ats, f);
  if (es) {
    const arr = (profile || {})[es.source];
    const entry = Array.isArray(arr) ? arr[es.entryIndex] : null;
    const r = atsResolveEntryField(es, entry, f);
    if (r) return r;
    return { kind: "entry-unanswered", source: "entry", section: es.section, entryIndex: es.entryIndex };
  }
  const map = (ATS_STATIC_MAPS[ats] || {})[atsMapKey(ats, f.fieldName)];
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
        if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
          // KEEP THE WIDGET SEMANTICS even though the VALUE came from a bucket: a location box wants
          // the city typed and its suggestions matched by city, not an exact-string pick from a list
          // it builds per keystroke.
          const kind = ATS_LOCATION_LABEL_RE.test(String(f.label || "")) ? "location" : undefined;
          return { raw, path: b.profile_path, source: "bucket", kind };
        }
      }
      const vals = Array.isArray(b.value) ? b.value.filter((x) => typeof x === "string" && x.trim()) : (typeof b.value === "string" && b.value.trim() ? [b.value] : []);
      if (vals.length) return { candidates: vals, source: "bucket", kind: ATS_LOCATION_LABEL_RE.test(String(f.label || "")) ? "location" : undefined };
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

// Add entries to each repeating section until it can hold every profile row it maps to.
// Bounded twice over: never more than the profile has, and never more than ATS_ENTRY_MAX clicks —
// a section whose Add button does not actually mount anything must cost a few seconds, not a loop.
const ATS_ENTRY_MAX = 8;
async function atsGrowIcimsEntries(act, ats, scan, profile) {
  let current = scan;
  for (const [section, def] of Object.entries(ATS_ICIMS_ENTRY_MAPS)) {
    if (!def.addButton) continue;
    const want = Array.isArray((profile || {})[def.source]) ? profile[def.source].length : 0;
    if (want < 2) continue;                       // one entry is what the form already renders
    const countEntries = (s) => {
      const seen = new Set();
      for (const f of (s && s.fields) || []) if (f.entrySection === section && typeof f.entryIndex === "number") seen.add(f.entryIndex);
      return seen.size;
    };
    let have = countEntries(current);
    let guard = 0;
    while (have < Math.min(want, ATS_ENTRY_MAX) && guard++ < ATS_ENTRY_MAX) {
      const r = await act.eval(atsInjIcimsAddEntry, def.addButton.source).catch(() => null);
      if (!r || !r.ok) break;
      await act.delayFull(900);                   // the new entry is server-rendered into the panel
      const rescan = await act.eval(atsInjScan, ats).catch(() => null);
      if (!rescan || !rescan.fields) break;
      atsAssignEntryIndexes(ats, rescan.fields);
      const now = countEntries(rescan);
      current = rescan;
      if (now <= have) break;                     // the click mounted nothing — stop rather than spin
      have = now;
    }
    try { console.log(`[ApplyPilot][ATS-FILL] ${section}: profile has ${want} entr(ies), form now shows ${have}`); } catch (e) { /* log only */ }
  }
  return current;
}

async function driveAtsPageFill(act, ats, profile, defaults, jobContext, opts) {
  const o = opts || {};
  const bucketIndex = atsFd.buildBucketIndex(o.buckets);
  let scan = await act.eval(atsInjScan, ats);
  // Stamp which ENTRY of a repeating section each field belongs to, before anything routes it.
  if (scan && scan.fields) atsAssignEntryIndexes(ats, scan.fields);
  // ⚠ GROW REPEATING SECTIONS TO FIT THE PROFILE, BEFORE FILLING. The form renders ONE entry and
  // mints the rest on demand, so without this a three-role history silently becomes a one-role
  // history — the worst kind of miss, because the page looks completely filled. Reconcile UP only:
  // never delete an entry the operator may have typed themselves.
  if (ats === "icims" && !o.valueFor) scan = await atsGrowIcimsEntries(act, ats, scan, profile);
  const results = [];
  const company = (jobContext && jobContext.company) || atsCompanyFromUrl(scan.url);
  const jc = Object.assign({}, jobContext, { company });
  // ONE AI answer cache for the whole page, keyed by normalized QUESTION — so a field a cascade
  // round re-mounts under a new automation-id reuses the answer we already paid for, and cannot
  // be given a second, contradicting one.
  const fillOpts = Object.assign({}, o, { aiCache: (o && o.aiCache) || new Map() });

  await atsFillFields(act, ats, scan, scan.fields, results, profile, defaults, jc, bucketIndex, fillOpts);

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
    atsAssignEntryIndexes(ats, rescan.fields);
    const seen = new Set(results.map((r) => r.fieldName));
    const fresh = rescan.fields.filter((f) => !seen.has(f.fieldName));
    if (!fresh.length) break;
    try { console.log(`[ApplyPilot][ATS-FILL] cascade round ${round + 1}: ${fresh.length} late-mounted field(s) — ${fresh.map((f) => f.fieldName).slice(0, 6).join(", ")}`); } catch (e) { /* log */ }
    const before = results.length;
    await atsFillFields(act, ats, rescan, fresh, results, profile, defaults, jc, bucketIndex, fillOpts);
    // ⚠ ONLY FLAG WHAT THE LATE DISCOVERY ACTUALLY LEFT OPEN (operator, 2026-08-12).
    // `cascadeRevealed` is not decoration: `requiresApproval` is `needs_review || cascade_revealed`,
    // so tagging every late row DEMANDS A HUMAN APPROVAL for it. Blanket-tagging made the Shield AI
    // self-ID signature — `Name` "Kevin Wang" (composed from the profile) and `Date` "08/12/2026"
    // (the signature-date rule) — both `filled`, `needs_review:false`, `confidence:high`, sit in the
    // review pile demanding sign-off on answers the profile had already given deterministically.
    // WHY THIS PATH DIFFERS FROM WORKDAY'S, which keeps its blanket flag: there, cascadeRevealed
    // means the form REVEALED or PROMOTED a field in reaction to a value we committed, and
    // re-checking that is the point. Here the re-scan mostly catches fields that were still MOUNTING
    // during the first scan (see the burst note above) — a SCAN-TIMING artifact, not a form reaction,
    // and one the field itself cannot be held responsible for.
    // So a late row that filled DETERMINISTICALLY AND VERIFIED (`filled` — the AI paths all end
    // `filled_review`) clears the same bar every other auto-approved field on the page clears, and is
    // approved by default like them. Anything else keeps the flag and still faces the gate.
    for (let i = before; i < results.length; i++) {
      if (results[i].status !== "filled") results[i].cascadeRevealed = true;
    }
  }

  return await atsFinishFill(act, ats, scan, results, o.credentials);
}

// ── DEFERRED AI: ONE batched call per page ───────────────────────────────────────────────
//
// The deterministic pass runs FIRST and to completion. Every field it could not answer is
// RECORDED rather than asked about; once the page is otherwise done the recorded questions go
// out in ONE call, and a second actuation pass fills them.
//
// ⚠ THIS IS THE OPPOSITE ORDER TO WORKDAY'S `aiBatch` (fill-driver.js ~4180) — do not "unify"
// them. Workday fires its batch BEFORE the deterministic pass so the two overlap in time, which
// makes it a speculative CACHE (a question it misses simply makes its own call) and forces it to
// PREDICT which fields the deterministic tiers will fail to answer — every misprediction is
// prompt tokens spent on a question that was already answered. Here the deterministic outcome is
// already KNOWN, so the call asks about exactly the fields that need it and nothing else. That is
// strictly cheaper, and it buys it with something Workday's cache does not have: a real second
// actuation pass.
//
// WHAT THIS REPLACES: N concurrent per-field calls (4 at a time). Concurrency hid latency but
// still spent N REQUESTS, and rotation does not spread them — a free-tier Gemini key meters
// 15 requests/MINUTE and rotation only advances on FAILURE, so a 7-question page burned half of
// one key's minute (round 9, docs/fill-speed-log.md). One call per page is the quota fix as much
// as the latency one, and it also ends the speculation: nothing is asked about a field the
// deterministic pass answered.
//
// CACHED BY QUESTION, never by automation-id. The cascade rounds re-enter this function with
// late-mounted fields, and the same question appearing again must reuse the first answer rather
// than pay for — and possibly CONTRADICT — a second one. `normalizeLabel` is the same key the
// bucket index uses.
//
// SAFETY IS UNCHANGED, and deliberately so: a batched answer enters through the SAME seam the old
// prefetch used — `atsAiFallback`'s `prefetched` argument. It is still only a CANDIDATE that must
// clear the match ladder against the LIVE options read at commit time, still read-back verified,
// still ALWAYS `filled_review` + flagged. A batch that fails, parses badly, or omits a question
// leaves that field to make its own call, exactly as a prefetch miss did.
const ATS_AI_BATCH_MAX = 24;   // same reasoning as fill-driver's AI_BATCH_MAX: past this the reply stops being reliable

// Which AI shape does this field need? `null` = not an AI field.
// text/textarea/date answer in prose (atsAiWriteText's contract); everything else picks an option.
function atsAiBatchKind(f) {
  const wt = f && f.widgetType;
  if (wt === "text" || wt === "textarea") return "text";
  // A DATE still defers (so it is filled, and in form order) but is NEVER batched: it shares
  // atsAiWriteText's prompt shape, yet it is a short factual answer, not prose — batching it would put
  // it in the "essay" group and bill it to the operator's essay model. Workday's `aiFillDate` routes a
  // date to "fill" for the same reason; this keeps the two paths saying the same thing.
  if (wt === "date") return "date";
  if (["select", "dial", "radio", "yesno", "checkbox_group", "dropdown_native", "location", "icims_dropdown", "multiselect_native"].includes(wt)) return "choice";
  return null;
}

// Open a combobox and poll its option list. Extracted from atsAiFallback so the DEFER pass and
// the commit pass read the list the same way — read-first, then poll adaptively, and never treat
// an empty menu as an answer while the widget still reports `loading` (the Discord school-picker
// lesson: "No options" at 4ms, "Loading..." at 24ms, the real answer at 4049ms).
async function atsOpenAndPollOptions(act, ref) {
  await act.eval(atsInjOpenAndReadOptions, ref.inputSel);
  const optDeadline = Date.now() + ATS_POLL.open;
  const optCeiling = Date.now() + ATS_POLL.openCeil;
  for (;;) {
    const read = await act.eval(atsInjReadOptions, ref.inputSel);
    const texts = ((read && read.options) || []).filter((o) => !o.disabled).map((o) => o.text);
    const now = Date.now();
    if (texts.length || now >= optCeiling || (now >= optDeadline && !(read && read.loading))) return texts;
    await act.delayFull(150); // real interval — see pollFor's note on starving the renderer
  }
}

// Close a menu the DEFER pass opened only to read, and CONFIRM it closed. The Workday rule
// ("every dropdown close confirms the portaled options are GONE, not merely aria-expanded") applies
// for the same reason here: a react-select menu left mounted still swallows clicks aimed at the
// next widget. Cheap — one read, and one retry before giving up and saying so.
async function atsCloseComboConfirmed(act, ref) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await act.eval(atsInjCloseCombo, ref.inputSel); } catch (e) { return false; }
    let read = null;
    try { read = await act.eval(atsInjReadOptions, ref.inputSel); } catch (e) { return false; }
    if (!read || !read.open || !((read.options || []).length)) return true;
    await act.delayFull(120);
  }
  return false;
}

// Same option list, order-insensitive — "did the AI choose from what the form is showing NOW?"
function atsSameOptionSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  // NEWLINE, not a space: `normalize` collapses every whitespace run to a single space, so an
  // option can contain spaces and ["a b"] would otherwise key the same as ["a","b"] — but no
  // normalized option can contain a newline, so this separator cannot be forged.
  const key = (arr) => arr.map((s) => atsLib.normalize(String(s == null ? "" : s))).sort().join("\n");
  return key(a) === key(b);
}

// The batched prompt. TWO kinds in one call, because an ATS page mixes screening dropdowns with
// "why do you want to work here" boxes and both are deferred by the same rule. Each kind keeps the
// contract its single-call twin (atsAiChooseOption / atsAiWriteText) already states, so an answer
// arriving by batch is indistinguishable downstream from one that came from its own call.
function atsBuildBatchPrompt(items, profile, jobContext) {
  const system = "You help an applicant fill out ONE job-application page. You are given the applicant's profile (JSON) and SEVERAL questions at once. Answer EVERY question, keyed by its id.\n" +
    "Each question has a \"kind\":\n" +
    "  • \"choice\" — put EXACTLY ONE of that question's \"options\", VERBATIM, in the \"choice\" field. These are REQUIRED questions: always choose the most likely option, INFERRING from the profile even when it is not stated verbatim (work eligibility from citizenship/work_authorization, age from education or enrollment dates, criminal/background answers from the ABSENCE of any such record). NEVER refuse, never answer UNKNOWN, and never write an option that is not in that question's list.\n" +
    "  • \"text\" — write the answer as free text in the \"answer\" field, in the applicant's own plain, professional first-person voice. If the question wants a factual answer the profile clearly holds, give it concisely. Use null for \"answer\" ONLY if you have no basis at all.\n" +
    "For every answer give a SHORT justification — one terse phrase, about 12 words, no preamble, no restating the answer — that NAMES your basis: the positive profile fact used, OR plainly that you are inferring from the ABSENCE of information (e.g. \"no criminal record in profile\"; absence-based answers are less certain, so say so). Give confidence: High, Medium, or Low. " +
    "ALSO map each question to the applicant's profile for later curation: \"maps_to\" = the dotted path of the matching profile field (from the profile JSON's structure, e.g. \"work_authorization.authorized_to_work_in_us\"), or \"none\" if no existing field fits; \"suggested_category\" = ONE of: Screening, Work authorization, Demographics, Personal, Experience, Education, Other.";
  const style = ((profile || {}).application_questions || {}).writing_style || "";
  const qs = items.map((it) => (it.kind === "choice"
    ? { id: it.id, kind: "choice", question: it.question, options: it.options }
    : { id: it.id, kind: "text", question: it.question }));
  const user = "QUESTIONS: " + JSON.stringify(qs) +
    "\nCOMPANY: " + ((jobContext && jobContext.company) || "unknown") +
    (jobContext && jobContext.title ? "\nROLE: " + jobContext.title : "") +
    (jobContext && jobContext.description ? "\nJOB DESCRIPTION (ground free-text answers in what the role actually is):\n" + String(jobContext.description).slice(0, 4000) : "") +
    (style ? "\nSTYLE RULES for free-text answers: " + style : "") +
    "\nCANDIDATE PROFILE (JSON):\n" + JSON.stringify(profile).slice(0, 12000) +
    "\n\nReply ONLY with a JSON object and nothing else, one entry per question id:\n" +
    "{\"answers\":[{\"id\":\"<id>\",\"choice\":\"<verbatim option — kind=choice only>\",\"answer\":\"<free text — kind=text only>\",\"justification\":\"<short phrase, ~12 words, naming your basis>\",\"confidence\":\"High|Medium|Low\",\"maps_to\":\"<profile dotted path or none>\",\"suggested_category\":\"<one category or none>\"}]}";
  return { system, user };
}

// Room for the reply. A cap is not a spend — it only bounds what the model MAY produce — but it has
// to be per-KIND here: a choice answer is ~70-80 tokens (fill-driver budgets 400 for 5x headroom)
// while a free-text answer is a paragraph (the single-call path allows 700).
function atsBatchMaxTokens(items) {
  const texts = items.filter((i) => i.kind === "text").length;
  return 512 + 400 * (items.length - texts) + 700 * texts;
}

// Sibling of fill-driver's `parseBatchAiReply` — same latitude with ```-fences, embedded JSON and an
// object-keyed-by-id shape instead of the asked-for array. NOT shared with it, because this reply
// carries TWO answer kinds and each is validated for the kind it was ASKED about: a "choice" that
// comes back as prose is not a pick, and a "text" that comes back empty is the AI declining (which
// has its own N/A path downstream). An id we never asked about, or an answer of the wrong shape,
// simply yields no entry — and that field then makes its own call.
// Returns Map id → the SAME answer object shape atsAiChooseOption / atsAiWriteText return.
function atsParseBatchReply(text, items) {
  const out = new Map();
  const byId = new Map((items || []).map((i) => [i.id, i]));
  const t = String(text == null ? "" : text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let obj = null;
  try { obj = JSON.parse(t); } catch (e) {
    const m = t.match(/\{[\s\S]*\}/);
    if (m) { try { obj = JSON.parse(m[0]); } catch (e2) { return out; } }
  }
  if (!obj || typeof obj !== "object") return out;
  const take = (id, a) => {
    if (!a || typeof a !== "object") return;
    const it = byId.get(String(id == null ? "" : id));
    if (!it || out.has(it.id)) return;
    // ACCEPT THE OTHER KEY TOO (2026-08-12). The prompt asks for `choice` on a choice question and
    // `answer` on a text one, and the parser used to REQUIRE exactly that — so a model that replied
    // `{"answer":"Yes"}` to a choice question had a perfectly good answer thrown away, silently, and
    // that question then paid for its own call. Both observed misses in the regression sweep were on
    // MIXED batches (shieldai 4 choice + 2 text answered 0/6; linear 1 choice + 6 text answered 6/7),
    // which is exactly where a cross-key reply is likeliest.
    // ⚠ THIS CANNOT WEAKEN SAFETY, which is the only reason it is allowed: a choice answer arriving
    // under the wrong key is still just a CANDIDATE, and still has to clear the match ladder against
    // the LIVE options before anything commits. Being lenient about which JSON key carried it changes
    // nothing about what may be written to the form.
    const under = (primary, secondary) => {
      const p = a[primary] == null ? "" : String(a[primary]).trim();
      return p || (a[secondary] == null ? "" : String(a[secondary]).trim());
    };
    if (it.kind === "text") {
      // atsAiWriteText's shape exactly, including its FIXED "Low" confidence — an AI-written
      // paragraph is never high-confidence, and the record/bundle expect that value.
      const answer = under("answer", "choice");
      if (!answer) return;
      out.set(it.id, { ok: true, answer, confidence: "Low",
        justification: a.justification == null || !String(a.justification).trim() ? "generated from profile" : String(a.justification) });
      return;
    }
    const choice = under("choice", "answer");
    if (!choice) return;
    // atsAiChooseOption's shape, plus the list the question was ASKED with — the commit pass
    // reuses this answer only if the form is still showing that same list (see atsAiFallback).
    out.set(it.id, { ok: true, choice,
      justification: a.justification == null ? "" : String(a.justification),
      confidence: a.confidence == null || !String(a.confidence).trim() ? "Low" : String(a.confidence),
      maps_to: a.maps_to == null ? "" : String(a.maps_to),
      suggested_category: a.suggested_category == null ? "" : String(a.suggested_category),
      promptOptions: it.options || [] });
  };
  if (Array.isArray(obj.answers)) obj.answers.forEach((a) => take(a && a.id, a));
  else if (Array.isArray(obj)) obj.forEach((a) => take(a && a.id, a));
  else for (const k of Object.keys(obj)) take(k, obj[k]);
  return out;
}

// ONE CALL PER KIND, NOT ONE PER PAGE — and the reason is ROUTING, not batching (2026-08-12).
// `act.llm` resolves ONE `action` per call, and the AI page configures a different model per action:
// "Fill" for picks, "Fill — essays and long answers" for prose. A single mixed call can only carry one
// of them, so it would have to send someone's essay questions to their yes/no model (or the reverse).
// Splitting by kind keeps each question on the model the operator chose for it.
//
// It costs nothing in latency: the two calls are INDEPENDENT and fire CONCURRENTLY. And it is a small
// quota win — the two actions may resolve to different models and different pinned keys, so a page's
// AI spend now spreads across two per-minute budgets instead of one.
const ATS_BATCH_ACTION = { choice: "fill", text: "essay" };

// Fire the batched call(s) for everything the deterministic pass deferred, and fold the answers into
// the page-level cache (key = normalized QUESTION). Never throws: every failure mode simply leaves the
// cache without that question, and the commit pass then makes its own per-field call.
// ⚠ ONE BATCH PER SCOPE (operator, 2026-08-16). A repeating-entry field may only be answered from
// its OWN entry, and that rule binds the LLM exactly as it binds the deterministic tiers — so an
// entry field cannot share a prompt with page-level questions (it would be shown the whole profile)
// nor with a DIFFERENT entry of the same section. Group first, batch within a group. Batching is
// preserved where it matters: all of one entry's questions still go in one call.
async function atsRunAiBatch(act, deferred, profile, jc, cache) {
  const groups = new Map();
  for (const d of deferred) {
    const k = d.scopeKey || "";
    if (!groups.has(k)) groups.set(k, { items: [], profile: d.scopeProfile || profile });
    groups.get(k).items.push(d);
  }
  let fired = false, items = 0, answers = 0;
  for (const g of groups.values()) {
    const r = await atsRunAiBatchGroup(act, g.items, g.profile, jc, cache);
    fired = fired || !!(r && r.fired);
    items += (r && r.items) || 0;
    answers += (r && r.answers) || 0;
  }
  return { fired, items, answers };
}

async function atsRunAiBatchGroup(act, deferred, profile, jc, cache) {
  const byKind = { choice: [], text: [] };
  const idToKey = new Map();
  const seen = new Set();
  let cached = 0, dup = 0, noOptions = 0, capped = 0, unbatched = 0, n = 0;
  for (const d of deferred) {
    if (cache.has(d.qKey)) { cached++; continue; }         // an earlier cascade round already answered this question
    if (seen.has(d.qKey)) { dup++; continue; }              // same question twice on one page
    if (!byKind[d.kind]) { unbatched++; continue; }          // a kind with no batch group (date) — its own call
    // A choice question with nothing to choose from is not answerable — the commit pass re-reads the
    // widget and reports it honestly. Asking about it would only spend tokens.
    if (d.kind === "choice" && !d.options.length) { noOptions++; continue; }
    if (n >= ATS_AI_BATCH_MAX) { capped++; continue; }
    // SHORT SYNTHETIC IDS, not the question text: a long id invites the model to paraphrase it, and
    // an id that comes back paraphrased is an answer we throw away. Unique across BOTH kinds so the
    // two replies can never be confused for one another.
    const id = "q" + (++n);
    seen.add(d.qKey);
    idToKey.set(id, d.qKey);
    byKind[d.kind].push({ id, kind: d.kind, question: d.label, options: d.kind === "choice" ? d.options : null });
  }
  if (capped) {
    try { console.log(`[ApplyPilot][ATS-FILL] AI batch capped at ${ATS_AI_BATCH_MAX} — ${capped} question(s) will make their own call`); } catch (e) { /* log only */ }
  }

  // ONE question of a kind is not a batch: the same single request, wrapped in a prompt whose parse
  // can fail. Leave it to its own path (the rule fill-driver's aiBatch already applies) — and note it
  // is applied PER KIND, so 5 essays still batch even when the page's only pick rides alone.
  const runs = Object.keys(byKind).filter((k) => byKind[k].length >= 2);
  const solo = Object.keys(byKind).reduce((a, k) => a + (byKind[k].length === 1 ? 1 : 0), 0);
  const askable = Object.keys(byKind).reduce((a, k) => a + byKind[k].length, 0);
  if (!runs.length) {
    // report the ASKABLE count, not 0 — "no batch — 0 askable question(s)" next to two deferred
    // fields reads like a collection bug when it is really the per-kind minimum doing its job.
    return { fired: false, items: askable, answers: 0, cached, dup, noOptions, capped, solo };
  }

  const fireOne = async (kind) => {
    const items = byKind[kind];
    const action = ATS_BATCH_ACTION[kind] || "fill";
    const { system, user } = atsBuildBatchPrompt(items, profile, jc);
    try { console.log(`[ApplyPilot][ATS-FILL] AI batch [${kind} → "${action}" route]: ${items.length} deferred question(s) in ONE call (cap ${atsBatchMaxTokens(items)} tokens)${cached ? ` · ${cached} already cached` : ""}`); } catch (e) { /* log only */ }
    let res = null;
    try { res = await act.llm({ system, user, maxTokens: atsBatchMaxTokens(items), action }); }
    catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
    if (!res || !res.ok) {
      try { console.log(`[ApplyPilot][ATS-FILL] AI batch [${kind}] FAILED (${(res && res.error) || "no reply"}) — each question falls back to its own call`); } catch (e) { /* log only */ }
      return 0;
    }
    const parsed = atsParseBatchReply(res.text, items);
    for (const [id, ans] of parsed) cache.set(idToKey.get(id), ans);
    if (parsed.size < items.length) {
      // NAME the dropped questions and their KINDS. Without this a partial parse is as undiagnosable
      // as a total one was: "6/7" says nothing about whether one kind is being lost systematically,
      // which is the first thing you want to know.
      const missed = items.filter((i) => !parsed.has(i.id)).map((i) => `${i.id}:${i.kind}`).join(", ");
      try { console.log(`[ApplyPilot][ATS-FILL] AI batch [${kind}] answered ${parsed.size}/${items.length} — the rest fall back to their own call (missed ${missed})`); } catch (e) { /* log only */ }
    }
    // A call that SUCCEEDS and yields NOTHING is the one failure this design cannot diagnose from the
    // outside — `ok in 1364ms` next to `answered 0/6` looks identical whether the model refused, was
    // truncated mid-JSON, or answered with ids we never asked about. Live on Shield AI (Lever,
    // 2026-08-12). So dump the head of the reply, but ONLY in that case: a partial parse is already
    // self-explaining, and the reply carries profile-derived answers, so this stays short and rare.
    if (!parsed.size) {
      const t = String((res && res.text) || "");
      try { console.log(`[ApplyPilot][ATS-FILL] AI batch [${kind}] parsed NOTHING from a successful call — reply was ${t.length} char(s): ${JSON.stringify(t.slice(0, 220))}`); } catch (e) { /* log only */ }
    }
    return parsed.size;
  };

  // CONCURRENT: the two kinds are independent questions on different routes, so the page waits for the
  // SLOWER of the two rather than their sum.
  const counts = await Promise.all(runs.map(fireOne));
  const asked = runs.reduce((a, k) => a + byKind[k].length, 0);
  return { fired: true, items: asked, answers: counts.reduce((a, b) => a + b, 0), cached, dup, noOptions, capped, solo, kinds: runs };
}

// The per-field fill loop — extracted so the cascade pass runs the IDENTICAL ladder. THREE phases
// (see the DEFERRED AI block above): fill deterministically and record what needs the AI → ONE call
// for exactly those questions → a second actuation pass that fills them.
async function atsFillFields(act, ats, scan, fields, results, profile, defaults, jc, bucketIndex, o) {
  // Page-level, so a question repeated by a cascade round costs ZERO further calls (keyed by
  // QUESTION, not automation-id). Absent (a direct call, a test) ⇒ this loop keeps its own.
  const aiCache = (o && o.aiCache) || new Map();
  const deferred = [];
  for (const f of fields) {
    const rec = {
      fieldName: f.fieldName, label: f.label, widgetType: ATS_REVIEW_WIDGET[f.widgetType] || f.widgetType,
      isRequired: !!f.isRequired, mappedPath: null, rawValue: null, resolved: null,
      status: null, matchTier: null, confidence: null, flag: null, verified: null, after: null, detail: null,
    };
    const ref = { inputSel: f.inputSel, widgetType: f.widgetType };
    // show the operator what we are filling (see atsInjScrollIntoView) — best effort, never fatal
    try { await act.eval(atsInjScrollIntoView, f.inputSel); } catch (e) { /* a field we cannot scroll to still fills */ }
    // ⚠ AND SCROLL THE TOP PAGE TOO (operator, 2026-08-16). iCIMS sizes its iframe to its content,
    // so the frame has no scroller of its own and the line above moves nothing — the run looked
    // motionless while it filled. Best-effort and never fatal: a fill that cannot be watched is
    // still a fill. Only when a frame is pinned, so the other tenants are untouched.
    if (ats === "icims" && act.evalTop) {
      try {
        const at = await act.eval(atsInjFrameFieldY, f.inputSel);
        if (at && at.ok) await act.evalTop(atsInjScrollTopToFrameY, at.y, at.h);
      } catch (e) { /* watching is a nicety, never a requirement */ }
    }
    // Per-field wall clock, so [ATS-TIME] can name what a slow fill actually spent its time on
    // (the Workday [CDP-TIME] habit). A record is finalized at several `continue`s below, so the
    // stamp is applied by `fin()` rather than at one exit.
    const fieldT0 = Date.now();
    const fin = () => {
      rec.elapsedMs = Date.now() - fieldT0;
      // LOG HERE, not at the end of the loop: several branches `continue` before that point, so the
      // résumé attach — the single most variable field — produced no line at all and its cost could
      // only be inferred from the [ATS-TIME] slowest list (which ignores anything under 1.5s).
      try {
        console.log(`[ApplyPilot][ATS-FILL] ${rec.fieldName} (${rec.widgetType}${rec.isRequired ? ", req" : ""}) → ${rec.status}${rec.matchTier ? " · " + rec.matchTier : ""}${rec.flag ? " · " + rec.flag : ""}${rec.after != null ? " · after=" + JSON.stringify(String(rec.after).slice(0, 60)) : ""} · ${rec.elapsedMs}ms${rec.detail ? " · " + rec.detail : ""}`);
      } catch (e) { /* log only */ }
      return rec;
    };
    try {
      // Replay mode: the value comes from the APPROVED bundle, not the profile (the submit
      // run re-fills a blank form). Everything else — actuation + verify — is identical.
      let route = null;
      // ⚠ A CREDENTIAL IS NEVER REPLAYED FROM THE BUNDLE — note the `&& !atsCredentialKind(...)`.
      // The bundle deliberately carries a PLACEHOLDER for these ("(stored login)"), never the value,
      // so a replay that treated them like any other approved field would type that placeholder
      // string into the account's login box and submit it. They re-route through the credential
      // tier instead, which reads the stored credentials directly — the same source the fill used.
      if (o.valueFor && !atsCredentialKind(ats, f)) {
        const v = o.valueFor(f);
        if (v === undefined) { rec.status = "skipped"; rec.detail = "no approved entry for this field"; results.push(fin()); continue; }
        if (f.widgetType === "file_upload") {
          // ⚠ NOT EVERY FILE FIELD IS THE RÉSUMÉ. Greenhouse renders the COVER LETTER as a file
          // dropzone too, so attaching to every file field put the résumé in the cover-letter slot
          // (operator watched it happen on a Discord rehearsal, 2026-08-04). On a real submit that
          // files the wrong document to the employer, and NO gate catches it: the strict verify
          // only re-checks approved VALUES, and a bundle never carries a file for a field we
          // deliberately skipped. Route it through the same router the fill uses — which maps
          // exactly one field to the résumé — and leave any other file field alone.
          const fr = atsRouteField(ats, f, profile, defaults, jc, bucketIndex, o.credentials);
          route = fr && fr.kind === "resume"
            ? { kind: "resume", source: "replay" }
            : { kind: "skip", detail: (fr && fr.detail) || "a file field that is not the résumé — left to the operator" };
        } else {
          route = { value: v, source: "replay" };
          // KEEP THE KIND THE FILL USED. The replay routed every non-file field as a plain value,
          // so Greenhouse's phone-dial composite (#country) was actuated as an ordinary select —
          // the wrong widget shape, whose menu never mounts — and an approved dial value could
          // never commit (live 2026-08-05: `skipped · the dropdown opened but listed no options`,
          // which the strict verify then rightly refuses, blocking an otherwise-clean submit).
          // Same lesson as the résumé slot: a replay that drops the fill's routing is a replay
          // that cannot reproduce the fill.
          // Read the KIND straight from the static map: it describes the widget's SHAPE, which is
          // true regardless of whether the profile happens to hold a value for it (atsRouteField
          // returns nothing when the mapped value is empty, and the shape would be lost with it).
          const shape = (ATS_STATIC_MAPS[ats] || {})[atsMapKey(ats, f.fieldName)];
          if (shape && shape.kind === "dial") route.kind = "dial";
        }
      } else {
        route = atsRouteField(ats, f, profile, defaults, jc, bucketIndex, o.credentials);
      }
      const es0 = atsEntrySpec(ats, f);
      // An entry field its own entry cannot answer falls through to the AI/blank path exactly like an
      // unrouted field — the difference is that the AI is handed ONLY that entry (see the deferral).
      // It must NOT fall back to the profile root, which is what the early return in atsRouteField
      // prevents and what this preserves.
      if (route && route.kind === "entry-unanswered") route = null;

      // ── CREDENTIALS ────────────────────────────────────────────────────────────────────
      // Handled before every other kind, and it `continue`s out before `rec.rawValue` /
      // `rec.resolved` are assigned further down — which is exactly how the value stays out of the
      // record, and therefore out of the review bundle and the report POSTed to the website.
      if (route && route.kind === "credential-missing") {
        rec.status = "needs_review";
        rec.credential = true; rec.credentialKind = route.credentialKind;
        rec.flag = route.flag || "credentials-not-stored";
        rec.detail = route.detail;
        results.push(fin()); continue;
      }
      if (route && route.kind === "credential") {
        const w = await act.eval(atsInjSetCredential, ref.inputSel, route.value);
        await act.delay(120);
        rec.credential = true; rec.credentialKind = route.credentialKind;
        rec.mappedPath = "(credentials." + (route.credentialKind === "login" ? "email" : "password") + ")";
        // ⚠ A PLACEHOLDER, NEVER THE VALUE — `fin()` logs `rec.after`, and the bundle carries it.
        rec.after = "(stored " + route.credentialKind.replace(/_/g, " ") + ")";
        if (!w || !w.ok) {
          rec.status = "needs_review"; rec.after = null;
          rec.detail = "could not write the " + route.credentialKind.replace(/_/g, " ") + ": " + ((w && w.error) || "unknown");
          results.push(fin()); continue;
        }
        rec.verified = !!w.matches;
        rec.status = w.matches ? "filled" : "needs_review";
        if (!w.matches) { rec.after = null; rec.detail = "the box did not take the value (" + w.len + " characters present afterwards)"; }
        else if (w.hadLength) rec.detail = "replaced a value the page had prefilled";
        results.push(fin()); continue;
      }

      // ── SCHOOL / OTHER SCHOOL — one decision spanning two REQUIRED fields (operator) ────
      // The form pairs a school typeahead with a free-text "Other School", and both are required.
      // The rule: if the school IS in the list, pick it and put "N/A" in Other School; if it is NOT,
      // pick the list's own "Other" and put the school's name in Other School. DOM order puts School
      // first, so the pair's outcome is recorded there and read by the text field below.
      const pairKey = es0 ? es0.section + ":" + es0.entryIndex : null;
      if (route && route.kind === "school") {
        const store = (o._icimsSchool = o._icimsSchool || {});
        const name = (route.candidates || [])[0] || null;
        await atsActuateField(act, ats, f, ref, rec, route.candidates || [], null, jc, profile, { containment: false });
        if (rec.status === "filled" || rec.status === "filled_review") {
          store[pairKey] = { matched: true, schoolName: name };
        } else if (!rec.listNoResults) {
          // ⚠ WE COULD NOT CONFIRM THE SCHOOL IS ABSENT, so we must not claim it is (operator,
          // 2026-08-16). "Other" is only truthful once the widget has SAID "No Results" for the
          // school we typed. Any other miss — a search still in flight, a menu disturbed by the
          // page moving under it (which the smooth-scroll bug did), a list that never answered —
          // is an UNKNOWN, and answering an unknown with "Other" writes a false statement onto the
          // application: it says this university is not in their system when it is. Observed live:
          // School "Other" + Other School "Carnegie Mellon University" on a form that lists CMU.
          store[pairKey] = { matched: false, confirmedAbsent: false, schoolName: name };
          rec.flag = rec.flag || "school-unconfirmed";
          rec.detail = "could not confirm whether this form lists " + JSON.stringify(String(name || "")) +
            " — the search did not report \"No Results\", so it was NOT answered \"Other\"; pick it here";
        } else {
          // Confirmed absent: the widget itself reported No Results for this school, so the form's
          // own escape hatch is the truthful answer rather than leaving a REQUIRED field empty.
          // The record is REBUILT rather than patched: the failed attempt's detail/tier/after describe
          // a different commit, and leaving them would report the "Other" pick as if it were the miss.
          rec.status = null; rec.after = null; rec.detail = null; rec.matchTier = null; rec.verified = null; rec.flag = null;
          await atsActuateField(act, ats, f, ref, rec, ["Other"], null, jc, profile, { containment: false });
          store[pairKey] = { matched: false, schoolName: name };
          if (rec.status === "filled" || rec.status === "filled_review") {
            rec.status = "filled_review";
            rec.flag = "school-not-listed";
            rec.detail = "this form's school list does not offer " + JSON.stringify(String(name || "")) +
              " — chose its own \"Other\" and put the name in Other School";
          }
        }
        rec.mappedPath = route.path || null;
        results.push(fin()); continue;
      }
      if (route && route.kind === "other_school") {
        const st = (o._icimsSchool || {})[pairKey] || null;
        // ⚠ UNKNOWN ≠ MATCHED. If School never produced an outcome (an error, or a form that renders
        // Other School first), writing "N/A" would silently drop the school entirely — the one
        // outcome that loses information. Write the NAME and flag it instead.
        const useName = !st || st.matched === false;
        const value = useName ? (st && st.schoolName) || route.schoolName || null : "N/A";
        if (value == null) { rec.status = "needs_review"; rec.detail = "no school in this education entry"; results.push(fin()); continue; }
        rec.mappedPath = route.path || null;
        await atsActuateField(act, ats, f, ref, rec, null, String(value), jc, profile, {});
        if (!st) { rec.flag = rec.flag || "school-pair-unresolved"; rec.detail = "the School field produced no outcome, so the name was written here rather than \"N/A\""; }
        results.push(fin()); continue;
      }

      if (route && route.kind === "resume") {
        const att = await act.attachResume(ref);
        Object.assign(rec, att.ok
          ? { status: "filled", after: att.name || "resume attached", detail: att.detail || null, verified: !!att.verified }
          : { status: f.isRequired ? "needs_review" : "skipped", detail: "resume attach failed: " + (att.error || "unknown"), flag: "resume-attach-failed" });
        results.push(fin()); continue;
      }
      if (route && (route.kind === "skip" || route.skip)) { rec.status = "skipped"; rec.detail = route.detail || "deliberately left to the operator"; results.push(fin()); continue; }
      if (route && route.kind === "employment-blank") { rec.status = "needs_review"; rec.flag = route.flag || "employer-match"; rec.detail = route.detail; results.push(fin()); continue; }
      if (route && route.eeoUnstated) {
        // OPTIONAL: leave it blank — the operator's own choice, nothing blocks.
        // REQUIRED: blank blocks the submit, so take the form's OWN decline option when it
        // offers one (live 2026-08-01: three required demographic questions on one form each
        // ended blank and unapprovable, stranding an otherwise-complete application). Declining
        // asserts nothing false and is what a form offering it expects for 'no answer'; the
        // record still reaches review flagged, so a human can answer properly instead.
        // NEVER inferred: we do not guess a demographic — this only ever picks 'no answer'.
        const dec = f.isRequired ? atsDeclineOption(f.options || []) : null;
        if (dec) {
          const c = f.widgetType === "radio" || f.widgetType === "checkbox_group"
            ? await act.eval(atsInjCheckOption, ref.inputSel, dec, true)
            : f.widgetType === "dropdown_native"
              ? await act.eval(atsInjSelectNative, atsInjSelectNativeMulti, ref.inputSel, dec)
              : await act.eval(atsInjCommitOption, ref.inputSel, dec);
          const b = await atsReadBackSettled(act, ats, ref.inputSel, f.widgetType);
          rec.after = b && b.ok ? b.value : null;
          const ok = c && c.ok && String(rec.after || "").trim() !== "";
          atsAttachOptions(rec, f.options || []);
          rec.status = ok ? "filled_review" : "needs_review";
          rec.flag = "declined-no-basis";
          rec.detail = "this REQUIRED demographic isn't stated in your profile — chose the form's own " + JSON.stringify(dec) +
            " so it cannot block the submit; answer it here if you would rather" + (ok ? "" : " (commit failed)");
          results.push(fin()); continue;
        }
        rec.status = f.isRequired ? "needs_review" : "skipped";
        atsAttachOptions(rec, f.options || []);
        rec.detail = "demographic not stated in profile — left blank (never inferred)" +
          (f.isRequired ? ", and this form is REQUIRING it with no decline option — answer it here" : "");
        rec.flag = "eeo_declined"; results.push(fin()); continue;
      }

      rec.mappedPath = (route && (route.path || null)) || null;
      rec.rawValue = route ? (route.raw !== undefined ? route.raw : (route.value != null ? route.value : (route.candidates || null))) : null;
      if (route && route.source === "bucket") rec.flag = "bucket";

      // Coerce to candidates through the SAME resolve() the Workday driver uses (booleans →
      // Yes/No ladders, arrays pass through as tiered lists).
      let candidates = null; let textValue = null;
      if (route) {
        if (route.candidates) candidates = route.candidates.slice();
        else if (route.raw !== undefined) {
          // ⚠ A NEW CHOICE WIDGET MUST BE LISTED HERE. resolve() coerces per KIND, and a widget
          // missing from this list is treated as free text — which silently drops a TIERED profile
          // array (the country ladder) instead of passing it through as candidates, so the fallback
          // tier that actually matches the form's wording never gets tried.
          const isChoice = ["select", "dial", "radio", "yesno", "checkbox_group", "dropdown_native", "location", "icims_dropdown", "multiselect_native"].includes(f.widgetType);
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
      const mopts = { containment: !!(route && route.containment) || (!!candidates && atsIsEeoLabel(f.label)), replay: !!(o && o.valueFor) };
      const produced = await atsActuateField(act, ats, effF, ref, rec, candidates, textValue, jc, profile, mopts);
      if (!produced) {
        // Deterministic tiers produced nothing. AI fallback — REQUIRED fields only (the
        // operator rule: an optional blank costs nothing; a required blank blocks submit).
        const aiKind = f.isRequired && act.aiEnabled ? atsAiBatchKind(f) : null;
        if (aiKind) {
          // DEFER, don't ask. Record everything the question needs and move on; the batch below
          // asks about all of them at once and the commit pass actuates them.
          const d = { f, ref, rec, kind: aiKind, options: [], label: rec.label || f.fieldName };
          d.qKey = atsLib.normalizeLabel(d.label);
          if (aiKind === "choice") {
            // Options the SCAN already carries (radio / yes-no / checkbox-group / native select) are
            // free. A react-select combobox has to be OPENED to be read — and then CLOSED again,
            // because nothing is committed here. That open is the one cost this ordering adds, and
            // it is paid once: today's per-field path opened the menu and then held it open across
            // the whole LLM call, which is both longer and more fragile.
            // ⚠ NOT `location`: a places box has no list until something is TYPED, so an empty-query
            // open can only ever return nothing. Reading it here would be a guaranteed-wasted open on
            // the single most expensive widget on this path (candidate-location spans 7.1-20.3s on
            // ONE posting — round 9, docs/fill-speed-log.md). It goes to the commit pass unbatched,
            // which handles it exactly as before.
            d.options = (f.options || []).slice();
            if (!d.options.length && ["select", "dial"].includes(f.widgetType)) {
              try {
                d.options = await atsOpenAndPollOptions(act, ref);
                if (!(await atsCloseComboConfirmed(act, ref))) {
                  try { console.log(`[ApplyPilot][ATS-FILL] ${rec.fieldName}: menu still open after the deferred option read`); } catch (e) { /* log only */ }
                }
              } catch (e) { d.options = []; }   // the commit pass re-reads and reports it honestly
            }
          }
          // The ONLY profile this question may be answered from. For a repeating-entry field that is
          // its own entry and nothing else — same seal the deterministic tier obeys.
          const scope = atsEntrySpec(ats, f);
          if (scope) {
            d.scopeKey = scope.section + ":" + scope.entryIndex;
            d.scopeProfile = atsScopeForField(ats, f, profile);
          }
          deferred.push(d);
          // PROVISIONAL — phase 3 overwrites both, so neither ever reaches a review bundle. The
          // record is pushed HERE, in the loop, so REVIEW ORDER stays FORM ORDER.
          rec.status = "deferred_ai";
          rec.detail = "deferred to this page's one AI call";
        } else if (rec.status == null) {
          // A STATED value that the form couldn't take is NOT "blank is fine" (live 2026-07-31,
          // Discord: the profile says "Bachelor of Science", the form offers "Bachelor's Degree",
          // and the field vanished silently). The operator HAS an answer here — surface it so
          // they can pick it on review and teach the variant. Genuinely unmapped questions
          // (no candidates at all) stay a quiet `skipped`, optional-blank as before.
          const stated = !!(candidates && candidates.length);
          rec.status = stated ? "needs_review" : "skipped";
          if (stated) {
            rec.flag = rec.flag || "stated-value-unmatched";
            // A human sentence for the review page — the raw match diagnostic is kept after it
            // (it names the options), and rec.options already feeds the editor's picker.
            rec.detail = (rec.listUnproven
              // the list is paged, or its search never answered — say what we actually know
              ? "this form's own list never answered our search for " + JSON.stringify(String(candidates[0])) +
                " (it serves one page at a time), so we can't tell whether it's there — pick it here, or answer it in the tab"
              : "your profile answer (" + JSON.stringify(String(candidates[0])) + ") isn't one of this form's options — pick the right one here") +
              (rec.detail ? " · " + rec.detail : "");
          } else {
            rec.detail = rec.detail || "no profile mapping for this question";
          }
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
    results.push(fin());
  }

  if (!deferred.length) return;

  // ── PHASE 2: ONE call for everything the deterministic pass could not answer ─────────────
  // Never fatal: a batch that cannot even be BUILT must not cost the page its deferred fields —
  // they each make their own call below, which is exactly the pre-batch behaviour.
  let batch = { fired: false, items: 0, answers: 0 };
  try { batch = await atsRunAiBatch(act, deferred, profile, jc, aiCache); }
  catch (e) { try { console.log(`[ApplyPilot][ATS-FILL] AI batch threw (${String((e && e.message) || e)}) — every deferred question falls back to its own call`); } catch (e2) { /* log only */ } }

  // ── PHASE 3: the second actuation pass ───────────────────────────────────────────────────
  // Nothing new here — each deferred field goes through the SAME atsAiFallback the per-field path
  // always used, with the batched answer handed in as its `prefetched`. So the match ladder vs the
  // LIVE options, the read-back, the decline fallback and the always-flagged rule are untouched,
  // and a question the batch did not answer simply makes its own call inside it.
  let served = 0, fellBack = 0;
  for (const d of deferred) {
    const answer = aiCache.get(d.qKey) || null;
    if (answer) served++; else fellBack++;
    const t0 = Date.now();
    try { await act.eval(atsInjScrollIntoView, d.ref.inputSel); } catch (e) { /* a field we cannot scroll to still fills */ }
    try {
      // scoped profile when this field belongs to a repeating entry — a solo call must obey the
      // same seal the batch does, or the scoping is only as good as whether a batch happened to fire
      await atsAiFallback(act, ats, d.f, d.ref, d.rec, jc, d.scopeProfile || profile, answer);
    } catch (e) {
      d.rec.status = "needs_review";
      d.rec.detail = "AI commit pass exception: " + String((e && e.message) || e);
    }
    // The record already carries phase 1's cost; this pass is the rest of the SAME field's time,
    // so [ATS-TIME]'s slowest-field list keeps naming the field rather than a phantom.
    d.rec.elapsedMs = (d.rec.elapsedMs || 0) + (Date.now() - t0);
    try {
      console.log(`[ApplyPilot][ATS-FILL] ${d.rec.fieldName} (${d.rec.widgetType}${d.rec.isRequired ? ", req" : ""}) → ${d.rec.status}${d.rec.flag ? " · " + d.rec.flag : ""}${d.rec.after != null ? " · after=" + JSON.stringify(String(d.rec.after).slice(0, 60)) : ""} · ${d.rec.elapsedMs}ms · ${answer ? "from the batched call" : "own call"}${d.rec.detail ? " · " + d.rec.detail : ""}`);
    } catch (e) { /* log only */ }
  }
  try {
    console.log(`[ApplyPilot][ATS-FILL] AI pass done: ${deferred.length} deferred · ${served} served by the batch · ${fellBack} made their own call` +
      (batch.fired ? ` (batch asked ${batch.items}, answered ${batch.answers})` : ` (no batch — ${batch.items} askable question(s))`));
  } catch (e) { /* log only */ }
}

// ── CREDENTIALS ARE RE-CHECKED LAST ──────────────────────────────────────────────────────
// The credential tier verifies its write with an immediate read-back, and that read-back is NOT
// enough. Observed live on iCIMS: `PersonProfileFields.Login` ended up holding an address that was
// neither the profile's nor the stored one, with an empty password, on a run whose log said both
// were filled and verified. The box carries `autocomplete="username"`, and the address was the
// operator's real one — the browser's own password manager writes into it AFTER the page settles.
// Written, verified, reverted, still reported `filled`: the exact false-verify class the safety
// contract exists to prevent.
//
// ⚠ THE POST-FILL AUDIT STRUCTURALLY CANNOT COVER THIS, which is why this exists rather than a
// tweak to it. `atsFinishFill` compares the live page against `rec.after`, and `rec.after` is
// deliberately the placeholder "(stored login)" rather than a value — so the audit can only ever
// mismatch on a credential, which is why credential records are skipped there. This check compares
// against the EXPECTED value instead, which has to stay out of records and the bundle, so it lives
// where the credentials already are: inside the fill.
//
// It runs LAST, after the cascade rounds and the audit, so anything that was going to re-render or
// autofill already has. A field that has been replaced is rewritten once; one the page keeps taking
// back ends `needs_review` + `credential-overwritten` with its placeholder cleared — a login we
// could not keep on the page must never be reported as filled.
async function atsCredentialRecheck(act, ats, scan, results, credentials) {
  if (!credentials || !credentials.email || !credentials.password) return null;
  const creds = results.filter((r) => r && r.credential && r.credentialKind && r.status === "filled");
  if (!creds.length) return null;
  let repaired = 0, lost = 0;
  for (const rec of creds) {
    const f = scan.fields.find((x) => x.fieldName === rec.fieldName);
    if (!f) continue;
    const want = atsCredentialValue(rec.credentialKind, credentials);
    if (!want) continue;
    let v = null;
    try { v = await act.eval(atsInjVerifyCredential, f.inputSel, want); } catch (e) { v = null; }
    if (v && v.ok && v.matches) continue;
    let w = null;
    try { w = await act.eval(atsInjSetCredential, f.inputSel, want); } catch (e) { w = null; }
    await act.delay(150);
    let after = null;
    try { after = await act.eval(atsInjVerifyCredential, f.inputSel, want); } catch (e) { after = null; }
    if (after && after.ok && after.matches) {
      repaired++;
      rec.detail = (rec.detail ? rec.detail + "; " : "") + "the page replaced this after the fill — rewritten";
      continue;
    }
    lost++;
    rec.status = "needs_review";
    rec.flag = "credential-overwritten";
    rec.verified = false;
    rec.after = null;
    rec.detail = "the page kept replacing this " + rec.credentialKind.replace(/_/g, " ") +
      " after we wrote it (the browser's own password manager is the usual cause) — set it yourself before submitting";
  }
  if (repaired || lost) {
    try { console.log(`[ApplyPilot][ATS-FILL] credential re-check: ${repaired} rewritten, ${lost} could not be kept on the page`); } catch (e) { /* log only */ }
  }
  return { repaired, lost };
}

// The audit + envelope — extracted with the loop (see atsFillFields).
async function atsFinishFill(act, ats, scan, results, credentials) {
  // M40-lite AUDIT: one independent re-read after the page settles — a record must never
  // claim a value the page no longer holds (the false-verify class).
  await act.delayFull(600);
  for (const rec of results) {
    if (rec.status !== "filled" && rec.status !== "filled_review") continue;
    const f = scan.fields.find((x) => x.fieldName === rec.fieldName);
    if (!f || f.widgetType === "file_upload") continue;
    // ⚠ CREDENTIALS ARE NOT AUDITABLE HERE, AND SKIPPING THEM IS NOT A HOLE — atsCredentialRecheck
    // below is the second look they get, and it is a STRONGER one. This loop compares the page
    // against `rec.after`, which for a credential is the placeholder "(stored login)" rather than a
    // value, so it could only ever produce a false audit-mismatch. Auditing them here would also
    // read a password out of the page and into `rec.after` — the one thing this path must not do.
    if (rec.credential) continue;
    try {
      const live = await act.eval(atsInjReadValue, ats, f.inputSel, f.widgetType);
      if (!live || !live.ok) { rec.flag = rec.flag || "audit-unverifiable"; continue; }
      const liveV = live.value == null ? "" : String(live.value);
      const recV = rec.after == null ? "" : String(rec.after);
      // a chip DISPLAY that is a substring of the recorded option text is a match (the dial
      // select renders "+1" for the committed "United States +1" — same accept rule as the
      // fill-time verify).
      const chipSubstring = liveV && recV.toLowerCase().includes(liveV.toLowerCase());
      // …and the REVERSE, for a widget whose display is LONGER than the answer: Lever's EEO radios
      // render the option's whole description inside the label, so the page reads
      // "Asian (Not Hispanic or Latino)A person having origins in…" for a recorded
      // "Asian (Not Hispanic or Latino)". That is the same value, more verbosely displayed — not a
      // page that lost its value (live 2026-08-05). Anchored at the START and length-guarded, so a
      // recorded value that merely appears somewhere inside an unrelated display is still a
      // mismatch, and a 1-2 char recorded value can never "prefix-match" a paragraph.
      const labelDescription = recV.length >= 3 && liveV.toLowerCase().startsWith(recV.toLowerCase());
      if (f.widgetType === "checkbox" ? String(!!live.value) !== String(rec.after === true || rec.after === "true") : !(atsFd.textValuesMatch(liveV, recV) || chipSubstring || labelDescription)) {
        rec.status = "needs_review"; rec.flag = "audit-mismatch";
        rec.detail = (rec.detail ? rec.detail + "; " : "") + "audit: page now holds " + JSON.stringify(liveV);
        rec.after = liveV || null;
      }
    } catch (e) { rec.flag = rec.flag || "audit-unverifiable"; }
  }

  // Genuinely last, and BEFORE counts — a credential the page took back becomes `needs_review`
  // here, and the envelope must report that, not the status it held a moment earlier.
  await atsCredentialRecheck(act, ats, scan, results, credentials);

  const counts = results.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
  // DID THIS PAGE'S ASYNC WIDGETS EVER ANSWER? Greenhouse forms sometimes load in a state where their
  // server-backed comboboxes (school / degree / discipline / location) never return anything — the
  // operator's own workaround is to refresh the page, and by hand the same widget then answers in ~1s
  // (2026-08-06). We could not tell that state apart from a slow one, so a fill would sit through the
  // full budget on each such field and hand them all to review. This flag lets the RUN decide to
  // reload once and try again, which is the same remedy a human applies.
  const deadAsync = results.filter((r) => r.listUnproven || /never answered our search|suggestions never loaded/i.test(String(r.detail || "")));
  return { url: scan.url, title: scan.title, results, counts,
    deadAsync: deadAsync.map((r) => r.fieldName),
    needsReview: results.filter((r) => r.status === "needs_review" || r.status === "filled_review") };
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

  // iCIMS' AJAX combobox. Its own widget, because none of the react-select helpers fit: the opener,
  // the results list, the search box and the read-back are all iCIMS-specific, and its <select> is
  // decorative. Shape: open → (search if the page we can see doesn't hold it) → match through the
  // SAME ladder → click the row → read back the DISPLAYED text → close CONFIRMED.
  if (wt === "icims_dropdown") {
    if (!candidates || !candidates.length) return false;
    rec.resolved = candidates;
    const open = await act.eval(atsInjIcimsOpen, ref.inputSel);
    await act.delay(180);
    if (!open || !open.ok) { rec.status = "needs_review"; rec.detail = "could not open the dropdown: " + ((open && open.error) || "unknown"); return true; }

    let opts = open.options || [];
    let searched = false;
    // ⚠ ASK ABOUT THE PARENT FIRST, BEFORE ANY SEARCH. A child whose parent is unset shows only the
    // widget's own "Please select a country" row; searching REPLACES that row, so by the time the
    // no-match branch re-read the list the evidence was gone and the field reported the generic
    // "no option matched \"Pennsylvania\"" — naming the wrong cause. Searching a list that cannot
    // contain the answer is also pure latency.
    {
      const pre = await act.eval(atsInjIcimsReadOptions, ref.inputSel).catch(() => null);
      if (pre && pre.ok && pre.awaitingParent) {
        await act.eval(atsInjIcimsClose, ref.inputSel).catch(() => null);
        rec.status = "needs_review";
        rec.detail = "this list only fills in once its parent field is chosen, and that hadn't happened yet";
        return true;
      }
    }
    let m = atsLib.matchCandidates(candidates, opts, { containment: allowContainment });
    // ⚠ ONE PAGE AT A TIME (26 countries / 25 states measured live). A miss here is NOT proof the
    // option doesn't exist, so the search box is tried before anything is reported — otherwise a
    // candidate in Texas fails on a list that stops at Michigan.
    if (!m || m.targetIndex < 0) {
      const beforeKey = opts.join("");
      const s = await act.eval(atsInjIcimsSearch, ref.inputSel, String(candidates[0]));
      if (s && s.ok) {
        searched = true;
        // POLL FOR SUCCESS, NOT FOR STILLNESS. Two settles failed live for the SAME underlying
        // reason: every "has the search finished?" proxy is already satisfied by the PRE-SEARCH
        // list. Stability alone accepts it (it is non-zero and perfectly stable). "Changed since we
        // opened" accepts it too, because the list is frequently still loading at open time, so the
        // baseline is empty and the ordinary unfiltered page reads as the change — which is what
        // made School report `no option matched "Carnegie Mellon University" (after searching)` and
        // fall to "Other" in 675ms, while typing the same text by hand returns it as the first hit.
        //
        // A MATCH is unambiguous, so match on EVERY read and stop at the first hit; "No Results" is
        // the widget's own terminal no. Otherwise keep looking for the whole budget rather than
        // deciding that a still list is a finished one. Only the timeout path can be wrong now, and
        // it errs toward looking longer.
        let read = null, hit = null;
        for (let i = 0; i < 40; i++) {
          await act.delay(200);
          read = await act.eval(atsInjIcimsReadOptions, ref.inputSel);
          if (!read || !read.ok) continue;
          if (read.noResults) { opts = []; rec.listNoResults = true; break; }
          const list = read.options || [];
          if (list.length) opts = list;
          const tryM = atsLib.matchCandidates(candidates, list, { containment: allowContainment });
          if (tryM && tryM.targetIndex >= 0) { opts = list; hit = tryM; break; }
        }
        m = hit || atsLib.matchCandidates(candidates, opts, { containment: allowContainment });
      }
    }
    // ALWAYS partial: this widget renders one page and offers a search box, so even an unsearched
    // read is a VIEW of the list, never the whole of it. Review then gets a type-to-filter editor
    // and an honest note instead of a 25-row list presented as every US state.
    atsAttachOptions(rec, opts, true);

    if (!m || m.targetIndex < 0) {
      const st = await act.eval(atsInjIcimsReadOptions, ref.inputSel).catch(() => null);
      await act.eval(atsInjIcimsClose, ref.inputSel).catch(() => null);
      rec.status = "needs_review";
      // A CHILD WHOSE PARENT IS UNSET SAYS SO, and that is a different fact from "your answer isn't
      // offered" — reporting them the same way is what produced "no live options to choose from" on
      // a State field whose Country simply hadn't been chosen yet.
      rec.detail = st && st.awaitingParent
        ? "this list only fills in once its parent field is chosen, and that hadn't happened yet"
        : st && st.noChildren
          ? "the form offers no options here for the parent value chosen"
          : "no option matched " + JSON.stringify(String(candidates[0])) + (searched ? " (after searching)" : "") +
            (opts.length ? " — offered: " + opts.slice(0, 4).join(" | ") : " — the list was empty");
      return true;
    }

    const chosen = opts[m.targetIndex];
    const c = await act.eval(atsInjIcimsCommit, ref.inputSel, chosen);
    await act.delay(250);
    const back = await act.eval(atsInjIcimsRead, ref.inputSel);
    rec.after = back && back.ok ? back.value : null;
    // ⚠ close BEFORE reporting: a results list left mounted sits over the next field's opener, and
    // this page stacks these widgets directly above one another (Country → State/Province).
    await act.eval(atsInjIcimsClose, ref.inputSel).catch(() => null);
    const okv = !!(c && c.ok) && String(rec.after || "").trim() !== "" &&
      atsLib.normalize(String(rec.after || "")) === atsLib.normalize(String(chosen));
    rec.matchTier = m.matchTier;
    rec.verified = okv;
    rec.status = okv ? (m.matchTier === "exact-normalized" ? "filled" : "filled_review") : "needs_review";
    if (!okv) rec.detail = "the pick did not persist (the widget shows " + JSON.stringify(String(rec.after || "")) + ")";
    else if (m.matchTier !== "exact-normalized") { rec.flag = rec.flag || "non-exact-match"; rec.detail = rec.detail || ("matched at the " + m.matchTier + " tier"); }
    return true;
  }

  // Native multi-select: EVERY stored answer that the form offers, in one commit.
  if (wt === "multiselect_native") {
    if (!candidates || !candidates.length) return false;
    rec.resolved = candidates;
    const texts = f.options || [];
    // Each stored answer goes through the ORDINARY ladder against the live options — a multi-answer
    // question is still N single matches, so nothing is committed that the form did not offer.
    const picks = [];
    for (const c of candidates) {
      const m = atsLib.matchCandidates([c], texts, { containment: allowContainment });
      if (m && m.targetIndex >= 0 && picks.indexOf(texts[m.targetIndex]) === -1) picks.push(texts[m.targetIndex]);
    }
    atsAttachOptions(rec, texts);
    if (!picks.length) { rec.detail = "none of " + candidates.length + " stored answer(s) matched " + texts.length + " option(s)"; return false; }
    const r = await act.eval(atsInjSelectNativeMulti, ref.inputSel, picks);
    await act.delay(140);
    const back = await act.eval(atsInjReadValue, ats, ref.inputSel, wt);
    rec.after = back && back.ok ? back.value : (r && r.selected ? r.selected.join(", ") : null);
    const got = String(rec.after || "").split(/,\s*/).filter(Boolean).map((x) => atsLib.normalize(x));
    const okv = !!(r && r.ok) && picks.every((p) => got.indexOf(atsLib.normalize(p)) !== -1);
    rec.verified = okv;
    // ⚠ A STORED ANSWER THIS FORM DOES NOT OFFER IS REPORTED, never dropped in silence: the operator
    // said they would consider it, and a shorter list than they chose is a different answer.
    const unoffered = candidates.filter((c) => !picks.some((p) => atsLib.normalize(p) === atsLib.normalize(c)));
    if (!okv) { rec.status = "needs_review"; rec.detail = "the selection did not persist (form shows " + JSON.stringify(String(rec.after || "")) + ")"; }
    else if (unoffered.length) {
      rec.status = "filled_review"; rec.flag = rec.flag || "partial-multiselect";
      rec.detail = "selected " + picks.length + " of your " + candidates.length + " answers — this form does not offer " + unoffered.join(", ");
    } else { rec.status = "filled"; rec.matchTier = "exact-normalized"; }
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
    // OPEN → SETTLE → SEARCH → REPORT. One sequence, because the branchy version had three
    // ways to end up matching against the wrong list (live 2026-07-31, Discord).
    //   • never a one-shot read: a heavy form renders its menu well past any flat delay, and
    //     the same form flip-flops between "100 options" and "none" run to run
    //   • never exit a search poll on "some options": while the widget searches it keeps
    //     showing the PREVIOUS page, so exiting early reads a stale list and calls the value
    //     absent ("Carnegie Mellon University" resolves by hand in ~2s; the fill gave up on
    //     the stale A-list)
    //   • absence is only believable AFTER asking for the value BY NAME
    const optsOf = (r) => ((r && r.options) || []).filter((o) => !o.disabled).map((o) => o.text);
    // Option text as the MATCH LADDER should see it: dial codes and list numbering are both
    // rendering artifacts (see atsDialStrip / atsEnumStrip). The commit always uses the raw text.
    const forMatch = (arr) => (wt === "dial" ? arr.map(atsDialStrip) : arr.map(atsEnumStrip));
    // BOTH SIDES get the same treatment, or the ladder compares unlike things. A committed value
    // is stored as the option's REAL text, so on a replay the approved answer arrives carrying the
    // form's own numbering ("1. United States of America") while the live options are stripped for
    // matching — no tier can bridge that (live 2026-08-05: the replay of a field the fill had just
    // filled exact-normalized reported "isn't one of this form's options").
    const hasHit = (texts) => {
      const mt = forMatch(texts);
      const m0 = atsLib.matchCandidates(forMatch(candidates), mt, { containment: allowContainment });
      return !!(m0 && m0.targetIndex >= 0);
    };
    // CLEAR BEFORE TYPING, SW-paced (the Workday typeahead rule, earned again 2026-07-31 on
    // Discord's school picker): setting a controlled react-select input straight to a new
    // value races the component's own render and React puts "" back — the query never reaches
    // the filter and the list looks empty. A clear + settle + type sticks ("Carnegie" → 1
    // option). The settle must be SW wall-clock; a page-side timer would be throttled hidden.
    // Type with REAL keystrokes when the actuation offers them, falling back to the synthetic path.
    // Greenhouse's async comboboxes (school / degree / discipline / location) only run their search
    // for genuine key events: with a trusted CLICK alone the school box still sat `loading` for
    // seconds and the location box showed nothing, while a real click + real typing answers in about
    // a second (traced both ways, 2026-08-06). Everything else on these forms keeps filling
    // synthetically, so this is the narrow exception, not a new default.
    const typeTrusted = async (text) => {
      if (!act.trustedType) return null;
      try {
        const ok = await act.trustedType(ref.inputSel, String(text));
        if (!ok) return null;
        await act.delay(120);
        const st = await act.eval(atsInjReadComboInput, ref.inputSel);
        const got = st && st.ok ? String(st.value || "") : "";
        return { ok: true, got, stuck: atsLib.normalize(got) === atsLib.normalize(String(text)) };
      } catch (e) { return null; }
    };
    const typeInto = async (text) => {
      await act.eval(atsInjTypeInCombo, ref.inputSel, "");
      await act.delay(250);   // adaptive — the read-back below is the real gate
      const r = await act.eval(atsInjTypeInCombo, ref.inputSel, String(text));
      await act.delay(150);
      // READ BACK: a controlled input can silently revert (that is exactly this bug's shape),
      // and "we typed it" is not evidence the widget received it.
      const back = await act.eval(atsInjReadComboInput, ref.inputSel);
      return Object.assign({}, r, { stuck: !!(back && back.value === String(text)), got: back && back.value });
    };
    // READ FIRST, then wait — and wait ADAPTIVELY. The Workday Stage-2 pacing rule: a poll
    // gated by an interval-length-INDEPENDENT state check can shrink its interval safely, and
    // waiting BEFORE the first read charged every already-open menu a full beat. The DEADLINE
    // stays real wall-clock, so a genuinely slow widget still gets its full budget.
    // ⚠ THE CEILING IS A PER-FIELD BUDGET, NOT PER POLL. Each poll used to get its own, so a
    // by-name search plus its retry could spend it TWICE: live 2026-08-05 on a hidden tab,
    // question_36707272002 took 44.6s of a 91.8s fill — one widget whose menu never renders, paying
    // 20s + 20s + change. The widget still gets a real budget; it just cannot get it repeatedly.
    const fieldPollT0 = Date.now();
    const pollFor = async (ms, want, ceilMs) => {   // want(texts) → done?
      const deadline = Date.now() + ms;
      // The CEILING is a loading allowance: while the widget itself reports that it is still
      // fetching (atsInjReadOptions.loading), an empty menu is not an answer, so the soft
      // deadline does not apply. Earned live 2026-08-04 — Discord's school list says
      // "No options" at 4ms, "Loading..." at 24ms and answers at 4049ms, so NO flat budget
      // under ~4s could ever have worked, and the retry that re-typed only restarted the clock.
      // A widget that is not loading behaves exactly as it did before.
      const hardDeadline = Math.min(
        Date.now() + Math.max(ms, ceilMs || ms),
        fieldPollT0 + ATS_POLL.fieldMaxMs,          // …and never past this field's whole allowance
      );
      // Keep the most INFORMATIVE read, not merely the most recent. `r.options` is always an
      // array and [] is truthy, so `last` used to be overwritten by every sample INCLUDING empty
      // ones — and on a timeout we returned whatever the final sample happened to be. A widget
      // mid-re-render reads as zero options for a frame, so a poll that saw the real list and
      // then caught one empty frame at the deadline reported "listed no options" and sent a
      // perfectly fillable field to review (live 2026-08-02, Greenhouse #country on a HIDDEN
      // tab: by hand the same widget opens 244 / filters to 1 / restores 244, every time).
      // Hidden tabs re-render more raggedly, which is why this surfaced there.
      // A stale non-empty list cannot cause a wrong commit: a HIT returns immediately above, and
      // the commit re-resolves the option BY TEXT against the live DOM and gates on a read-back.
      const startedAt = Date.now();
      let last = null, lastSeen = null, sawLoading = false, ticks = 0, sawEmptyMounted = false, sawMounted = false, lastReadMs = 0, quietIdleMs = null; let stopReason = "none";
      for (;;) {
        const readAt = Date.now();
        const r = await act.eval(atsInjReadOptions, ref.inputSel);
        lastReadMs = Date.now() - readAt;
        ticks++;
        // How long has this widget's subtree been still? Only asked once the soft deadline has
        // passed with nothing rendered — the one place the answer changes what we do.
        if (act.quietRead && Date.now() >= deadline && !sawMounted) {
          try { const q = await act.quietRead(ref.inputSel); quietIdleMs = q && q.ok ? q.idleMs : null; }
          catch (e) { quietIdleMs = null; }
        }
        if (r && Array.isArray(r.options)) { lastSeen = r; if (r.options.length) last = r; }
        if (r && r.loading) sawLoading = true;
        if (r && want(optsOf(r))) { r.waitedMs = Date.now() - startedAt; r.ticks = ticks; return r; }
        const now = Date.now();
        const loading = !!(r && r.loading);
        // SETTLE, don't count clock. Two page states mean "not yet", not "nothing":
        //   • the widget says it is LOADING (a server-backed list — see atsInjReadOptions)
        //   • the menu node is not mounted at all, or it is mounted and reads empty for the FIRST
        //     time — a react-select paints its list a beat after the open click, and treating that
        //     beat as "no options" is what mis-routed a required field (2026-08-05). An empty read
        //     is only believed once the SAME empty read repeats with the menu present.
        const emptyNow = !!(r && Array.isArray(r.options) && !r.options.length);
        const settledEmpty = emptyNow && !!(r && r.open) && sawEmptyMounted;
        if (emptyNow && r && r.open) { sawEmptyMounted = true; sawMounted = true; }
        else if (r && r.open) sawMounted = true;
        // Not every kind of "nothing yet" is progress, and the difference is worth ms:
        //   • LOADING — the widget says a fetch is in flight → the full ceiling is justified.
        //   • MOUNTED but empty — one repeat read confirms it, then believe it.
        //   • NEVER MOUNTED — we may not even be looking at the right widget (live 2026-08-05:
        //     the replay reads Greenhouse's phone-dial composite as a plain select, whose menu
        //     never appears, and a full-ceiling wait burned 20s to reach the same honest skip).
        //     A brief grace, then stop: an absent menu is not evidence of anything to come.
        let why = "soft";
        const stop = (() => {
          if (now < deadline) return false;
          if (loading) { why = "loading-ceiling"; return now >= hardDeadline; }
          if (emptyNow && r && r.open) { why = "empty-mounted"; return settledEmpty || now >= hardDeadline; }
          if (emptyNow && !sawMounted) {
            // A menu that has never mounted is only believable when the page is actually
            // RESPONSIVE: our own read is a Runtime.evaluate, so when it takes ~1.4s the main
            // thread is jammed and the widget cannot paint a menu OR answer us (live 2026-08-05:
            // two reads spanning 2761ms declared three healthy dropdowns "never mounted" and
            // skipped values that had filled fine minutes earlier). Slow reads ⇒ keep waiting.
            // `quietIdleMs` is the operator's quiescence watch from the Workday branch
            // (cdpInstallQuietWatch): the page stamps its last mutation and the SW does the
            // waiting on real wall-clock. Read latency stays only as the fallback for when the
            // watch is unavailable (a fake actuation, or an install that failed).
            const busy = quietIdleMs != null
              ? quietIdleMs < ATS_POLL.busyIdleMs
              : lastReadMs > ATS_POLL.responsiveReadMs;
            if (busy) { why = quietIdleMs != null ? "page-busy" : "page-jammed"; return now >= hardDeadline; }
            why = "never-mounted";
            return now >= Math.min(deadline + ATS_POLL.mountGrace, hardDeadline);
          }
          return true;
        })();
        if (stop) {
          stopReason = why;
          const out = last || lastSeen;
          // Carry WHY we stopped, so a field that reaches review can name the real cause: a list
          // that never finished loading is a different report from one that answered "nothing" —
          // and so the recovery below knows whether a search was ever in flight to protect.
          // waitedMs/ticks make the next occurrence self-diagnosing instead of a guess about
          // whether the budget or the poll pressure was the problem.
          if (out) { out.stillLoading = loading; out.sawLoading = sawLoading; out.waitedMs = now - startedAt; out.ticks = ticks; out.stopReason = stopReason; }
          return out;
        }
        // BACK OFF WHILE IT IS FETCHING. Every tick is a Runtime.evaluate round trip, and this
        // project has already measured that polling a react-select too hard STARVES the renderer
        // so the menu never paints (2026-07-31: a 20ms interval took a GitLab fill from 4 review
        // items to 11, all "listed no options"). While the widget says it is loading there is
        // nothing to learn from a fast tick — the answer is bounded by its own fetch + render —
        // so give the page room instead of hammering it.
        if (loading) { await act.delayFull(ATS_POLL.loadingTick); continue; }
        // ⚠ REAL 150ms, not the adaptive delay. Adaptive collapses to ~20ms when timers measure
        // fast, and each poll tick is a Runtime.evaluate round trip — at that rate the polling
        // STARVES the renderer and the menu never paints. Live 2026-07-31: switching this one
        // interval to adaptive took a 20-field GitLab fill from 4 review items to 11, every
        // regression reading "the dropdown opened but listed no options". The win came
        // from reading BEFORE the first wait (an already-open menu costs nothing); the interval
        // itself must stay real so the page has time to do its own work.
        await act.delayFull(150);
      }
    };

    let nearMatches = []; // what a by-name search turned up — the operator's real choices
    let didSearch = false; // a typed query leaves the menu FILTERED — see the commit below
    // WHETHER WE EVER TYPED. That is the whole test for "is this the complete list": a menu read on
    // OPEN is everything the widget has (244 countries, 72 disciplines — verified in the DOM), while
    // anything we reached by typing is a view of it, and on a server-backed picker even the restored
    // unfiltered list is just page one. Never cleared, deliberately — see the restore below.
    let optionsFiltered = false;
    let listPending = false; // the widget was STILL fetching when we ran out of budget
    // Start the quiescence watch BEFORE the open click, so "has this subtree gone quiet?" has a
    // baseline by the time the poll needs it. Best effort: without it the poll falls back to
    // read latency.
    if (act.quietInstall) { try { await act.quietInstall(ref.inputSel); } catch (e) { /* fallback */ } }
    let opened = await act.eval(atsInjOpenAndReadOptions, ref.inputSel, false);
    let read = await pollFor(ATS_POLL.open, (t) => t.length > 0, ATS_POLL.openCeil);
    // Two FORCED toggles if nothing rendered: aria-expanded can be stale-true (a phantom-open
    // menu), so one forced click closes it and the next opens for real. Each attempt flips the
    // state, so two cover both "the click missed" and "it lied about being open".
    for (let attempt = 0; attempt < 2 && !optsOf(read).length; attempt++) {
      opened = await act.eval(atsInjOpenAndReadOptions, ref.inputSel, true);
      read = await pollFor(ATS_POLL.retry, (t) => t.length > 0, ATS_POLL.retryCeil);
    }
    // THE LIVE WIDGET WINS OVER THE LABEL'S GUESS (the Workday widget-adaptive rule, earned again
    // 2026-08-05). "Where are you currently based?" reads like a places question, but GitLab
    // answers it with a THREE-option pick-one already rendered on open. Typing a city there waits
    // out a suggestion service that will never respond and reports "places never loaded" on a
    // field that was answerable all along. A short list that is already showing IS the option set.
    const preOpts = optsOf(read);
    const locIsPickOne = wt === "location" && preOpts.length > 0 && preOpts.length <= ATS_LOC_PICKONE_MAX && hasHit(preOpts);
    // WHICH candidate the places list actually answered — the pick has to judge what we ASKED for.
    // A country-shaped "Location" box answers the country tier, and judging those options against
    // the city would find nothing and throw the answer away (see the fallback below).
    let locCand = candidates && candidates.length ? String(candidates[0]) : "";
    let locAlts = [];   // the non-city wordings offered to a country-shaped box (see below)
    if (wt === "location" && !locIsPickOne) {
      // ⚠ DO NOT GATE THIS ON google.maps. I added such a probe on 2026-08-05 ("don't wait for a
      // service that cannot answer") on the strength of an older note calling this box places-backed.
      // It is NOT: traced 2026-08-06 on Reddit, `google.maps` is absent and no maps script is ever
      // requested, yet typing "Tallahassee" returns "Tallahassee, Florida, United States" from
      // GREENHOUSE'S OWN service in react-select's normal listbox. The probe therefore skipped the wait
      // on every Greenhouse location field and manufactured "suggestions never loaded" — a regression
      // that read exactly like the environment problem the note described. The general poll already
      // bounds this wait (loading gate + per-field budget), so it needs no special case.
      // ⚠ WAKE IT WITH A REAL CLICK FIRST. This widget's suggestion service stays asleep for a
      // synthetic open click: the fill typed "Tallahassee" and polled 22.7s for nothing, while by hand
      // the same query answers in ~1s — and after ONE trusted click, SYNTHETIC typing drives it fine
      // (traced both ways, 2026-08-06). So the trust is needed for the click, not the keystrokes.
      const city = String(candidates[0]).split(",")[0];
      if (!(await typeTrusted(city))) await typeInto(city);
      read = await pollFor(6000, (t) => t.length > 0); // the widget's own lookup — real network time
      // A BOX LABELLED "Location" IS NOT ALWAYS A CITY BOX (2026-08-07). ElevenLabs labels one
      // "Location" and describes it "Country you're currently residing in" — a COUNTRY list, where
      // "Pittsburgh" matches nothing. We typed the city, read an empty menu, and reported "the form's
      // places service didn't respond" for 15s on a field that was answerable the whole time. Same
      // shape as the GitLab pick-one lesson above: the label's guess loses to the live widget.
      //
      // So when the city finds nothing, walk the REMAINING candidates — the location rung already
      // tiers the country behind the city for exactly this — and add the profile's country when a
      // BUCKET routed here (buckets carry their own single value and know nothing of the ladder,
      // which is how this field arrived with only "Pittsburgh, PA"). Costs nothing on a real places
      // box: it found its city and never reaches this.
      if (!optsOf(read).length) {
        const alts = candidates.slice(1).map(String);
        const pi = (profile && profile.personal_info) || {};
        const rawCountry = Array.isArray(pi.country) ? pi.country : [pi.country];
        for (const c of rawCountry) {
          if (typeof c === "string" && c.trim() && !alts.some((a) => atsLib.normalize(a) === atsLib.normalize(c))) alts.push(c.trim());
        }
        locAlts = alts;
        for (const alt of alts) {
          await typeInto(alt);
          read = await pollFor(ATS_POLL.search, (t) => t.length > 0, ATS_POLL.searchCeil);
          if (optsOf(read).length) { locCand = alt; break; }   // the PICK must judge what we asked for
        }
      }
    } else if (!hasHit(optsOf(read)) && atsListIsComplete(read)) {
      // THE WHOLE LIST IS ALREADY ON SCREEN — do not type. Traced live 2026-08-06 on Discord's degree
      // box: opening it renders all 10 options, and typing the profile's own wording
      // ("Bachelor of Science") filters that list to "No options", because the widget matches the
      // TYPED TEXT while the form's vocabulary is "Bachelor's Degree". Searching a complete list can
      // only ever hide the answer — and the operator's rule for these forms is the same: recon the
      // small typeaheads (degree, discipline), search only the ones too large to enumerate (school,
      // location). The bridges below (degree level, assertion lead, polarity) then run against the
      // FULL list rather than a filtered-to-nothing one.
      try { console.log(`[ApplyPilot][ATS-FILL] ${f.fieldName}: ${optsOf(read).length} option(s) read on open — matching the whole list, not searching it`); } catch (e) { /* log only */ }
    } else if (!hasHit(optsOf(read))) {
      // SEARCH BY NAME: types each candidate (most-specific first) and polls FOR THE HIT.
      // ONE search attempt (the most-specific candidate). Two attempts doubled the worst-case
      // cost on a form full of unmatched selects — a Discord fill ran into minutes — for a
      // vanishing gain: if the widget can find the value at all, the primary candidate finds it.
      for (const cand of candidates.slice(0, 1)) {
        // Search with a PREFIX, not the whole value: it is what a human types, it matches
        // more broadly, and a long async list answers it faster ("Carnegie Mellon" resolves
        // where the full "Carnegie Mellon University" can come back empty). The MATCH is still
        // exact against whatever the widget returns — a looser query never loosens the answer.
        // A PLACES BOX IS SEARCHED WITH THE CITY, not the first two words: "Pittsburgh, PA" is a
        // spelling a places service may never have heard of, while "Pittsburgh" is one they all
        // know (see atsPlacePick, which keeps the PICK strict about the state). Everything else
        // keeps the two-word prefix — it is what a human types, it matches more broadly, and a long
        // async list answers it faster.
        const query = (wt === "location" && !locIsPickOne && String(cand).includes(","))
          ? String(cand).split(",")[0].trim()
          : (String(cand).split(/\s+/).slice(0, 2).join(" ") || String(cand));
        // Wake the widget with a REAL interaction before searching. Greenhouse's async comboboxes
        // (school, degree, discipline, location) leave their fetch asleep — or firing but never
        // resolving — when everything they have seen is synthetic: live 2026-08-06 the school box sat
        // `loading` for 19.2s and the location box showed nothing for 21.6s, while by hand each
        // answered in about a second. Once woken, ordinary synthetic typing drives them.
        const typed = (await typeTrusted(query)) || (await typeInto(query)); didSearch = true; optionsFiltered = true;
        const wantHit = (t) => t.length > 0 && hasHit(t);
        let found = await pollFor(ATS_POLL.search, wantHit, ATS_POLL.searchCeil);
        // A query only filters a menu that is OPEN. The forced-toggle recovery above can leave
        // it CLOSED (two clicks = shut), and then the text lands in the input while the widget
        // shows nothing — live 2026-07-31 this read as "the value isn't in the list" with
        // stuck=true, got="Carnegie Mellon University", list(0). Re-open (no-op if already
        // open) and poll again before believing a query found nothing.
        if (!optsOf(found).length) {
          // ⚠ RECOVER ONLY FROM AN ACTUAL FAULT — a CLOSED menu, or a query the widget dropped.
          // Re-typing restarts the widget's own debounce and DISCARDS the search already in
          // flight, and force-clicking an OPEN menu SHUTS it (two clicks = closed), after which
          // the text sits in a widget that shows nothing. Doing both unconditionally is how a
          // healthy-but-slow list produced "the menu produced nothing across three polls"
          // (#country, 2026-08-02) — the recovery was the thing breaking it. A widget that is
          // open, still holding our query and merely slow is now simply waited out above.
          const st = await act.eval(atsInjReadComboInput, ref.inputSel);
          const closed = !(found && found.open);
          const lostQuery = !(st && st.ok && String(st.value) === query);
          const pending = !!(found && (found.sawLoading || found.stillLoading));
          if (closed || lostQuery) {
            // FORCE the click: aria-expanded lies (see atsInjOpenAndReadOptions), so a
            // non-forced re-open no-ops on a phantom-expanded widget and the menu stays shut.
            if (closed) { await act.eval(atsInjOpenAndReadOptions, ref.inputSel, true); await act.delay(250); }
            await typeInto(query);   // opening can reset the query the widget just took
            found = await pollFor(ATS_POLL.retry, wantHit, ATS_POLL.searchCeil);
          } else if (!pending) {
            // Open, still holding our query, and it never reported a fetch: nothing is in flight,
            // so ONE re-type is a free nudge for a local list that rendered raggedly. When the
            // widget HAS been loading, this is exactly the wrong move — it would restart the
            // debounce and discard the search — so that case is only ever waited out.
            await typeInto(query);
            found = await pollFor(ATS_POLL.retry, wantHit, ATS_POLL.retryCeil);
          }
        }
        const seen = optsOf(found);
        if (found && found.stillLoading) listPending = true;
        try { console.log(`[ApplyPilot][ATS-FILL] ${f.fieldName} search ${JSON.stringify(query)} → ${hasHit(seen) ? "HIT" : "no hit"}; typed=${!!(typed && typed.ok)} stuck=${typed && typed.stuck} got=${JSON.stringify(String((typed && typed.got) || ""))}; open=${!!(found && found.open)} loading=${!!(found && found.stillLoading)} waited=${(found && found.waitedMs) || 0}ms/${(found && found.ticks) || 0} reads stop=${(found && found.stopReason) || "?"}; list(${seen.length}): ${JSON.stringify(seen.slice(0, 3))}`); } catch (e) { /* log only */ }
        if (seen.length) nearMatches = seen;
        // ⚠ `read` IS ONLY REPLACED ON A HIT — and that is what makes a query safe to run against a
        // COMPLETE list. Measured 2026-08-07 on Discord's `discipline--0`: 72 options on open, typing
        // the profile's own wording ("Electrical and Computer Engineering", which that form words
        // differently) filters the menu to ZERO, clearing it brings all 72 back. Because a search that
        // found nothing never overwrites `read`, the on-open list survives regardless of whether the
        // restore below comes back in time, and the bridges (degree-level, polarity, assertion-lead)
        // run against the full list. Do not "simplify" this into an unconditional assignment.
        if (seen.length && hasHit(seen)) { read = found; break; }
      }
      if (!hasHit(optsOf(read))) { // nothing by name — restore the unfiltered list so the report names real options
        await act.eval(atsInjTypeInCombo, ref.inputSel, "");
        const restored = await pollFor(ATS_POLL.restore, (t) => t.length > 0, ATS_POLL.restoreCeil);
        // ⚠ this does NOT make the list complete again. Clearing the query restores the whole list on a
        // STATIC widget, but only PAGE ONE on a server-backed one (100 of ~3300 schools), and the two
        // are indistinguishable from here — no loading flag, no count that separates 244 countries
        // from 100 schools. Once we have typed, the safe reading is "a view of the list", forever.
        if (optsOf(restored).length) read = restored;

      }
    }
    let options = (read && read.options) || [];
    // DON'T THROW AWAY WHAT WE SAW. A by-name search can surface real suggestions and then lose them
    // when the query is cleared (the widget rebuilds its list per keystroke), leaving this branch to
    // report "listed no options" about a widget that had just offered five — and to hand review a field
    // with NOTHING to pick (live 2026-08-06, Ashby/Cohere: the box offered "Pittsburgh, Pennsylvania,
    // United States" and the record said it listed nothing). What the search saw IS the option set.
    if (!options.length && nearMatches.length) {
      options = nearMatches.map((t) => ({ text: t, disabled: false }));
      read = Object.assign({}, read || {}, { options });
    }
    if (!options.length) {
      rec.status = f.isRequired ? "needs_review" : "skipped";
      // A LOCATION box whose places service never answered still HOLDS what we typed, and that
      // text came from the profile rather than a guess. Leave it in the field and report it as
      // the value, so review shows something real to approve instead of "— blank —" (live
      // 2026-08-01: google.maps never loads in this browser, so a HUMAN gets no suggestions
      // either). Still needs_review — the form may want a places selection we could not make.
      if (wt === "location" && candidates.length) {
        const typed = await typeInto(String(candidates[0]));
        if (typed && typed.ok && typed.got) {
          rec.after = typed.got; rec.matchTier = "typed-unverified";
          // ON A REPLAY, AN APPROVED VALUE THAT IS ACTUALLY IN THE BOX IS COMMITTED. The human already
          // approved this exact text, so refusing it would override an explicit approval and block the
          // gate forever on a places service that never loads in this browser (a field a HUMAN cannot
          // fill either — 2026-07-31). Still FLAGGED, never silent.
          //
          // ⚠ AND THIS DEFERS TO THE AUDIT, which is the part that matters. Live 2026-08-06 on Reddit
          // the box did NOT retain the text — the M40 re-read found `page now holds ""` and correctly
          // downgraded the field to needs_review, so the gate still refused. That is the right outcome:
          // the required field really is empty. This grade only survives on a form that KEEPS what we
          // typed; where the widget discards it, the audit overrules us.
          if (mopts && mopts.replay && atsLib.normalize(String(typed.got)) === atsLib.normalize(String(candidates[0]))) {
            rec.status = "filled_review";
            rec.flag = rec.flag || "location-typed-unverified";
          }
        }
      }
      // GH location note (2026-07-31, Figma): the places lookup can hang on "Loading…" with ZERO
      // network — google.maps never loads in some browsers, so even a HUMAN typing gets no options.
      // Name that in the review row instead of a bare "did not render".
      rec.detail = wt === "location"
        ? ("location suggestions never loaded (the form's places service didn't respond — it may be broken in this browser)"
           + (rec.after ? ' — the box now holds "' + rec.after + '" from your profile; confirm it, or answer it in the tab.' : " — answer it in the tab before submitting."))
        // distinguish "the control never opened" from "it opened but listed nothing" — they
        // have different causes (an unrecognized widget vs an empty/server-backed list) — and
        // from "its own search never came back", which is neither of those and is the operator's
        // cue that the FORM is slow rather than the answer missing (2026-08-04).
        : ((opened && opened.ok)
          ? (listPending || (read && read.stillLoading)
            ? "the form's own option list was still loading when we ran out of time — answer it in the tab, or re-run"
            : "the dropdown opened but listed no options")
          : "could not open the dropdown (control not found)");
      // Tell the AI fallback not to pay this budget again: it re-opens the widget and re-polls the
      // SAME list from scratch, so an unreadable menu cost its ceiling TWICE (live 2026-08-05, hidden:
      // question_36707272002 16.1s, question_36749076002 13.5s — the two together were most of a 44s
      // fill, and both still ended needs_review either way).
      rec.optionsUnreadable = true;
      await act.eval(atsInjCloseCombo, ref.inputSel);
      return true;
    }
    const texts = options.filter((o) => !o.disabled).map((o) => o.text);
    const matchTexts = forMatch(texts);
    let hit = null;
    if (wt === "location" && !locIsPickOne) {
      // a places list: accept the first suggestion CONTAINING the city (they're all real
      // places for the typed query; flag anything that isn't an exact city+state read).
      // A pick-one location widget skips this and goes through the ordinary match ladder, so its
      // options are matched as options — not scanned for a city that was never going to be there.
      const pick = atsPlacePick(locCand || candidates[0], texts);
      if (pick) {
        hit = { index: pick.index, tier: pick.tier };
        if (pick.stateMismatch) {
          rec.flag = rec.flag || "location-state-mismatch";
          rec.detail = (rec.detail ? rec.detail + "; " : "") +
            "this form offers no " + JSON.stringify(String(locCand || candidates[0])) + " — picked " +
            JSON.stringify(String(texts[pick.index])) + "; confirm the state";
        }
      }
      // A COUNTRY-SHAPED BOX IS MATCHED AS A LIST, NOT AS A PLACE. Its answer comes from the country
      // tier, whose profile wording is routinely LONGER than the option — live: candidates led with
      // "United States of America" while the widget offered "United States", and the city-containment
      // pick above cannot see that at all (it asks whether the option contains the city). The ordinary
      // ladder normalizes and has the tiers for exactly this, and the profile stores the country as a
      // LADDER for exactly this reason, so every wording we were willing to answer with is offered —
      // not just the one that happened to make the menu render.
      if (!hit && locAlts.length) {
        const m = atsLib.matchCandidates(forMatch(locAlts), matchTexts, { containment: false });
        if (m && m.targetIndex >= 0) hit = { index: m.targetIndex, tier: m.matchTier };
      }
    } else {
      const m = atsLib.matchCandidates(forMatch(candidates), matchTexts, { containment: allowContainment });
      if (m && m.targetIndex >= 0) hit = { index: m.targetIndex, tier: m.matchTier };
      // stated Yes/No-leading value → the unique same-polarity option (the contraction
      // bridge — see the radio path; select twin for GH's EEO dropdowns).
      if (!hit && allowContainment) {
        const lead = /^(yes|no)\b/i.exec(String(candidates[0] || ""));
        const pol = lead ? atsFd.optionForPolarity(matchTexts, lead[1][0].toUpperCase() + lead[1].slice(1).toLowerCase()) : null;
        if (pol) hit = { index: matchTexts.indexOf(pol), tier: "polarity-lead" };
        if (!hit) {
          const asrt = atsAssertionLead(candidates[0], matchTexts);
          if (asrt) hit = { index: matchTexts.indexOf(asrt), tier: "assertion-lead" };
        }
      }
      // …and the degree-level bridge, for a field that ASKS about a degree (see atsDegreeMatch)
      if (!hit && /degree|education level/i.test(String(f.label || ""))) {
        const deg = atsDegreeMatch(candidates, matchTexts);
        if (deg) hit = { index: matchTexts.indexOf(deg), tier: "degree-level" };
      }
      // Dial composite: the ladder above compares NAMES that can never meet (see atsDialMatch).
      // Uses the RAW option texts — the codes are what it needs.
      if (!hit && wt === "dial") hit = atsDialMatch(candidates, texts);
    }
    if (!hit) {
      await act.eval(atsInjCloseCombo, ref.inputSel);
      // Show the operator the options that ACTUALLY relate to their answer. Searching a 3302-school
      // list for "Carnegie Mellon University" returns its two campuses — infinitely more useful in
      // review than the alphabetical first page the widget happens to render (live 2026-07-31).
      const client = texts.length > ATS_OPTION_CAP ? atsNearOptions(texts, candidates[0], 20) : [];
      const near = client.length ? client : (nearMatches.length && nearMatches.length < texts.length ? nearMatches : texts);
      rec.detail = "no candidate matched " + texts.length + " option(s); candidates=" + JSON.stringify(candidates.slice(0, 4)) +
        (near !== texts ? "; closest on this form: " + JSON.stringify(near.slice(0, 4)) : " sample=" + JSON.stringify((wt === "dial" ? matchTexts : texts).slice(0, 3)));
      // …and if what we READ was only a page (or the search never answered), say so even after
      // narrowing — otherwise the 20 near-matches masquerade as the whole option set.
      // ABSENCE IS PROVABLE AGAINST A LIST WE READ IN FULL, however long it is. This used to treat
      // any >= 60 read as one page, so a complete 244-option country menu was reported as a list that
      // "serves one page at a time" — sending the operator to look for an option we had already
      // proven absent. Now only a still-fetching widget, or a page-sized SEARCH result, is unproven.
      const unproven = listPending || (optionsFiltered && texts.length >= ATS_OPTION_CAP);
      // `near` is a narrowed neighbourhood when it differs from `texts` — partial by construction.
      atsAttachOptions(rec, near, (unproven || optionsFiltered || near !== texts) ? true : undefined);
      // ABSENCE IS ONLY PROVABLE AGAINST A LIST THAT ANSWERED, IN FULL. This form serves 100 of
      // ~3300 schools per page and its search service is slow and erratic (2026-08-04: 390ms,
      // 4.0s, 4.5s, then >20s for the same kind of query), so "not in what we read" is not
      // "not on the form" — claiming otherwise sends the operator looking for a missing option
      // that is really there, and buries the actual problem (the list never came back).
      if (unproven) rec.listUnproven = true;
      return false;
    }
    const commitText = texts[hit.index];
    // A typed query leaves the menu FILTERED, and the match was computed against the list we
    // READ — which may be the unfiltered one. Clicking now can miss entirely: live 2026-08-02 a
    // disability field searched "No, I" (the first two words of the profile's long answer) on a
    // form whose options are just Yes/No, filtering the menu to ZERO; the match still resolved
    // via the polarity bridge, and the click then found nothing. Clear the query and wait for the
    // option we intend to click to actually be there.
    if (didSearch) {
      const norm1 = (x) => String(x == null ? "" : x).replace(/\s+/g, " ").trim().toLowerCase();
      const showing = (t) => t.some((o) => norm1(o) === norm1(commitText));
      // LOOK BEFORE CLEARING. On a long server-backed list the option we matched exists ONLY in
      // the search result — Discord's 3300-school picker does not carry "Swarthmore College" on
      // the unfiltered first page at all — so clearing the query throws away the very option we
      // are about to click, and the commit then fails `option-not-found`. Clear only when the
      // option genuinely is not on screen, which is the case the clear was written for (the
      // 2026-08-02 polarity bridge: the match came from the unfiltered list while the query had
      // filtered the menu to zero).
      let back = await act.eval(atsInjReadOptions, ref.inputSel);
      if (!showing(optsOf(back))) {
        await act.eval(atsInjTypeInCombo, ref.inputSel, "");
        back = await pollFor(ATS_POLL.showing, showing, ATS_POLL.showingCeil);
        // A query that matches NOTHING closes the menu outright, and clearing the text does not
        // bring it back — so re-open before giving up (live 2026-08-02: "could not click No —
        // no-open-listbox"). Forcing is safe here: we have just established the menu is not
        // showing our option, so a click can only improve matters.
        if (!showing(optsOf(back))) {
          await act.eval(atsInjOpenAndReadOptions, ref.inputSel, true);
          back = await pollFor(ATS_POLL.retry, showing, ATS_POLL.showingCeil);
        }
      }
    }
    const c = await act.eval(atsInjCommitOption, ref.inputSel, commitText);
    const back = await atsReadBackSettled(act, ats, ref.inputSel, wt);
    rec.after = back && back.ok ? back.value : null;
    atsAttachOptions(rec, texts, (optionsFiltered || listPending) ? true : undefined);
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
      // Distinguish the two failures: the click never found its option (a LIST problem) vs the
      // click landed and the value did not stick (a COMMIT problem). Reporting the first as the
      // second sent three investigations after the wrong thing.
      rec.detail = c && c.ok
        ? "commit did not persist (read " + JSON.stringify(rec.after) + " wanted " + JSON.stringify(commitText) + ")"
        : "could not click " + JSON.stringify(commitText) + " — " + ((c && c.error) || "no result") + " (the menu was not showing it)";
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
    if (!m || m.targetIndex < 0) { rec.detail = "no candidate matched " + texts.length + " option(s)"; atsAttachOptions(rec, texts); return false; }
    const r = await act.eval(atsInjSelectNative, ref.inputSel, texts[m.targetIndex]);
    await act.delay(120);
    const back = await act.eval(atsInjReadValue, ats, ref.inputSel, wt);
    rec.after = back && back.ok ? back.value : null;
    atsAttachOptions(rec, texts);
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
      // …and the same bridge for a first-person assertion (see atsAssertionLead)
      if (!pick && allowContainment) {
        const asrt = atsAssertionLead(candidates[0], texts);
        if (asrt) { pick = asrt; tier = "assertion-lead"; }
      }
    }
    if (!pick) { rec.detail = "no candidate matched " + texts.length + " option(s)"; atsAttachOptions(rec, texts); return false; }
    const r = await act.eval(atsInjCheckOption, ref.inputSel, pick, true);
    await act.delay(150);
    const back = await act.eval(atsInjReadValue, ats, ref.inputSel, wt);
    rec.after = back && back.ok ? back.value : null;
    atsAttachOptions(rec, texts);
    // accept when the click landed AND the read-back holds the picked option (a pre-checked
    // equal value also reads correct — same "state, not click outcome" rule as Workday).
    const readNorm = atsLib.normalize(String(rec.after || ""));
    const okv = readNorm === atsLib.normalize(pick) || (!!(r && r.ok) && readNorm.includes(atsLib.normalize(pick).slice(0, 40)));
    rec.status = okv ? (tier === "exact-normalized" || tier === "label-exact" ? "filled" : "filled_review") : "needs_review";
    // RECORD THE OPTION WE CHOSE, not the read-back display — the dial-chip rule, earned again on a
    // radio. Lever's EEO options render their whole DESCRIPTION inside the label ("Asian (Not
    // Hispanic or Latino)A person having origins in any of the original peoples of the Far East…"),
    // while the option vocabulary the scan reports is the answer alone. Storing the display put a
    // paragraph in the bundle that no live option could ever match, so the replay of a field the
    // fill had verified came back `stated-value-unmatched` (live 2026-08-05, Shield AI).
    // The read-back stays the VERIFY (above, which already tolerates the description); only what we
    // persist changes. Single-choice only: a checkbox GROUP can hold several answers, and the
    // read-back is the one thing that reports all of them.
    if (okv && wt === "radio") rec.after = pick;
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
    //
    // A STATED ANSWER CARRIES ITS POLARITY IN ITS LEADING WORDS, not as a bare token (2026-08-07).
    // Ashby/Sierra renders its diversity survey as SELECT ALL THAT APPLY: each identity is its own
    // checkbox — "Person with disability", "Veteran", "Neurodiverse", "Parent" — so the LABEL is an
    // option, not a question. The profile answers those dimensions in whole sentences ("No, I do not
    // have a disability", "I am not a protected veteran"), which matched neither /^(yes|true)$/ nor
    // /^(no|false)$/, so two questions the profile ALREADY ANSWERS fell through to "your profile
    // answer isn't one of this form's options — pick the right one here". Nothing was unmatched:
    // leaving the box unchecked IS that answer, completely. Negative is tested FIRST, because "I am
    // not a protected veteran" satisfies the positive lead too.
    const c0 = candidates && candidates.length ? String(candidates[0]) : "";
    const explicitFalse = !!c0 && (/^(no|false)\b/i.test(c0) || ATS_NEG_LEAD_RE.test(c0));
    // …and on such a list, an answer that NAMES this box is the affirmative. EXACT-normalized only,
    // and deliberately NOT gated on atsIsEeoLabel: that detector knows DIMENSION names ("veteran",
    // "disability"), while these labels are the VALUES ("Asian", "White") — which is the whole point
    // of a select-all list. Exact equality stands on its own anyway: the profile literally says this
    // label, on any checkbox. Containment must stay out — "East Asian" must not decide a box labelled
    // "Asian" while an "East Asian" box may be sitting right below it.
    const namesIt = !!c0 &&
      candidates.some((c) => atsLib.normalize(String(c)) === atsLib.normalize(String(f.label)));
    const explicitTrue = !!c0 && !explicitFalse && (/^(yes|true)\b/i.test(c0) || ATS_POS_LEAD_RE.test(c0) || namesIt);
    if (!f.isRequired && !explicitTrue) {
      if (!explicitFalse) return false;
      rec.status = "skipped";
      rec.detail = "your profile answers this (" + JSON.stringify(c0) + "), so the box stays unchecked";
      return true;
    }
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

// Native <select multiple> — select EVERY requested option in one pass.
// ⚠ Not a loop over the single-select committer: each `selectedIndex =` write REPLACES the whole
// selection, so committing four options one at a time leaves exactly the last one. The selection is
// built first and `change` fired ONCE at the end, which is also what a real multi-select does.
function atsInjSelectNativeMulti(inputSel, optionTexts) {
  const el = document.querySelector(inputSel);
  if (!el) return { ok: false, error: "not-found:" + inputSel };
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const want = (Array.isArray(optionTexts) ? optionTexts : []).map(norm);
  const missed = [];
  for (const w of want) if (![...el.options].some((o) => norm(o.textContent) === w)) missed.push(w);
  for (const o of el.options) o.selected = want.indexOf(norm(o.textContent)) !== -1;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, missed, selected: [...el.selectedOptions].map((o) => (o.textContent || "").replace(/\s+/g, " ").trim()) };
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
async function atsAiFallback(act, ats, f, ref, rec, jobContext, profile, prefetched) {
  const wt = f.widgetType;
  try {
    if (wt === "textarea" || wt === "text" || wt === "date") {
      // use the concurrently-prefetched answer when there is one (atsPrefetchAiText); otherwise ask now
      const ai = prefetched || await atsAiWriteText(act, f, profile, jobContext);
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
    if (rec.optionsUnreadable && !texts.length) {
      // the deterministic pass just spent the full budget establishing there is nothing to read
      rec.status = "needs_review";
      rec.detail = rec.detail || "AI fallback: no live options to choose from";
      return;
    }
    if (wt === "select" || wt === "dial" || wt === "location" || wt === "dropdown_native") {
      // read-first, then poll adaptively (same rule as the deterministic path) — a one-shot read
      // after a flat wait both over-waits an open menu and under-waits a slow one. ⚠ THIS READ IS
      // NOT OPTIONAL EVEN WHEN THE ANSWER WAS BATCHED: the menu has to be OPEN for the commit
      // anyway, and the answer must be matched against what the form is showing NOW.
      if (wt !== "dropdown_native") texts = await atsOpenAndPollOptions(act, ref);
    }
    // ⚠ THIS IS WHAT PRODUCED "AI fallback: no live options to choose from" ON A PAGE THAT WAS
    // PLAINLY SHOWING A LIST (live 2026-08-16, the required Country field). The AI path read options
    // through the react-select helpers, which find nothing on an iCIMS widget — so the field was
    // reported as offering no choices at all, and the message sent debugging to the option read
    // rather than to the widget. It has its own opener; use it.
    if (wt === "icims_dropdown") {
      const o = await act.eval(atsInjIcimsOpen, ref.inputSel).catch(() => null);
      texts = (o && o.ok && o.options) || [];
      if (!texts.length) {
        const st = await act.eval(atsInjIcimsReadOptions, ref.inputSel).catch(() => null);
        if (st && st.ok && st.awaitingParent) {
          await act.eval(atsInjIcimsClose, ref.inputSel).catch(() => null);
          rec.status = "needs_review";
          rec.detail = "this list only fills in once its parent field is chosen, and that hadn't happened yet";
          return;
        }
      }
    }
    if (!texts.length) { rec.status = "needs_review"; rec.detail = "AI fallback: no live options to choose from"; return; }
    // ATTACH THE LIVE OPTIONS NOW, before any early return. A choice field that reaches review
    // must carry the form's real list so the editor renders a PICKER — whatever the AI did with
    // it. Live 2026-07-31: a required university dropdown whose AI pick wasn't a live option
    // reached review as "please fill it in yourself" with nothing to pick from, stranding the
    // operator even though the fill had just read all 60 options.
    atsAttachOptions(rec, texts);
    // A REQUIRED choice with no grounded answer takes the form's own decline option rather than
    // staying blank (see atsDeclineOption). Still needs_review — a human must approve it.
    const declineFallback = async (why) => {
      const dec = f.isRequired ? atsDeclineOption(texts) : null;
      if (!dec) { rec.status = "needs_review"; rec.detail = why + " — pick from the options here"; return false; }
      let c;
      if (wt === "radio" || wt === "checkbox_group") c = await act.eval(atsInjCheckOption, ref.inputSel, dec, true);
      else if (wt === "yesno") c = await act.eval(atsInjClickYesNo, ref.inputSel, dec);
      else if (wt === "dropdown_native") c = await act.eval(atsInjSelectNative, ref.inputSel, dec);
      else if (wt === "icims_dropdown") c = await act.eval(atsInjIcimsCommit, ref.inputSel, dec);
      else c = await act.eval(atsInjCommitOption, ref.inputSel, dec);
      const b = await atsReadBackSettled(act, ats, ref.inputSel, wt);
      rec.after = b && b.ok ? b.value : null;
      const ok = c && c.ok && String(rec.after || "").trim() !== "";
      rec.status = ok ? "filled_review" : "needs_review";
      rec.flag = "declined-no-basis";
      rec.detail = why + " — chose this form's own " + JSON.stringify(dec) + " so it cannot block the submit; change it here if you would rather answer" + (ok ? "" : " (commit failed)");
      return ok;
    };
    // A batched decision was made against a SPECIFIC option list — the one the defer pass recorded,
    // carried on the answer as `promptOptions`. Reuse it only when the form is showing that same
    // list NOW; anything else (a cascade, a re-render, a server-backed list that answered
    // differently) re-asks, because the AI must always choose from what the form is actually
    // showing. Order-insensitive: react-select is free to reorder a list it did not change.
    const preUsable = !!(prefetched && atsSameOptionSet(prefetched.promptOptions, texts));
    const ai = preUsable ? prefetched : await atsAiChooseOption(act, f, texts, profile, jobContext);
    if (!ai.ok) { await declineFallback("no grounded answer for this REQUIRED question (" + ai.error + ")"); return; }
    const m = atsLib.matchCandidates([ai.choice], texts, { containment: true });
    if (!m || m.targetIndex < 0) {
      rec.status = "needs_review";
      // put the CLOSEST real options in front of the operator instead of the alphabetical page
      // Narrow ONLY when the list is too long to show whole — on a short list every option is
      // a legitimate choice and hiding any of them is worse than showing all (unit-pinned).
      const near = texts.length > ATS_OPTION_CAP ? atsNearOptions(texts, ai.choice, 20) : [];
      if (near.length) atsAttachOptions(rec, near);
      const why = "the AI suggested " + JSON.stringify(ai.choice) + ", which this form doesn't offer" +
        (near.length ? " (closest: " + JSON.stringify(near.slice(0, 3)) + ")" : "");
      if (!(await declineFallback(why))) rec.detail = why + " — pick the right option here";
      return;
    }
    const pick = texts[m.targetIndex];
    let committed;
    if (wt === "radio" || wt === "checkbox_group") committed = await act.eval(atsInjCheckOption, ref.inputSel, pick, true);
    else if (wt === "yesno") committed = await act.eval(atsInjClickYesNo, ref.inputSel, pick);
    else if (wt === "dropdown_native") committed = await act.eval(atsInjSelectNative, ref.inputSel, pick);
    else if (wt === "icims_dropdown") committed = await act.eval(atsInjIcimsCommit, ref.inputSel, pick);
    else committed = await act.eval(atsInjCommitOption, ref.inputSel, pick);
    const back = await atsReadBackSettled(act, ats, ref.inputSel, wt);
    rec.after = back && back.ok ? back.value : null;
    atsAttachOptions(rec, texts);
    const okv = committed && committed.ok && String(rec.after || "").trim() !== "";
    rec.status = okv ? "filled_review" : "needs_review"; // AI is NEVER a silent fill
    rec.resolved = [ai.choice];
    rec.confidence = String(ai.confidence || "low").toLowerCase();
    // A GUESSED DEMOGRAPHIC IS ITS OWN CATEGORY. The Workday path has flagged these `ai-eeo-guess`
    // since AI-3 — "AI-GUESSED DEMOGRAPHIC — VERIFY", which the review editor renders loudest — but
    // this path only had ai-choice / ai-choice-sensitive, so a model-inferred veteran or gender answer
    // wore an ordinary AI badge (live 2026-08-06, Reddit: "No military service", and a transgender
    // question answered from the profile's GENDER — a related but different fact).
    rec.flag = atsIsEeoLabel(f.label)
      ? "ai-eeo-guess"
      : (atsFd.legallyLoaded(f.label) ? "ai-choice-sensitive" : "ai-choice");
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
    atsRouteLabel, atsRouteField, atsDialStrip, atsEnumStrip, atsListIsComplete, atsAttachOptions, atsNearOptions, ATS_REVIEW_WIDGET, ATS_POLL, driveAtsPageFill, atsActuateField,
    atsCredentialKind, atsCredentialValue, atsCredentialRecheck, atsFinishFill, atsMapKey,
    atsEntrySpec, atsAssignEntryIndexes, atsScopeForField, atsResolveEntryField, atsIsFutureYearMonth, atsGrowIcimsEntries, atsMonthCandidates, ATS_ICIMS_ENTRY_MAPS, ATS_MONTHS,
    atsAiFallback, atsAiChooseOption, atsAiWriteText,
    ATS_AI_BATCH_MAX, atsAiBatchKind, atsBuildBatchPrompt, atsParseBatchReply, atsBatchMaxTokens,
    atsSameOptionSet, atsOpenAndPollOptions, atsCloseComboConfirmed, atsRunAiBatch,
    ATS_REDIRECT_STRONG_RE, atsPickRedirectAnchor, atsInjDetectRedirect,
    atsInjFindApplyLinks, atsPickApplyLink, atsInjClickApplyButton,
    atsInjFindEmbeddedForms, atsPickEmbeddedForm, atsDurableFieldName, atsDeclineOption,
    atsIsEeoLabel,
    atsPreferredNameValue, atsLooksLikeApplicationForm, atsAssertionLead, atsDegreeLevel, atsDegreeMatch, atsDialMatch, atsDialCode, atsDialName,
    atsPlacePick, atsPostingGone, ATS_LOCATION_LABEL_RE,
    atsReadBackSettled,
    atsInjReadComboInput, atsInjScan, atsInjSetText, atsInjSetCredential, atsInjVerifyCredential, atsInjReadValue, atsInjOpenAndReadOptions, atsInjReadOptions,
    atsInjFrameFieldY, atsInjScrollTopToFrameY, atsInjIcimsAddEntry, atsInjIcimsOpen, atsInjIcimsSearch, atsInjIcimsReadOptions, atsInjIcimsCommit, atsInjIcimsRead, atsInjIcimsClose,
    atsInjTypeInCombo, atsInjCommitOption, atsInjCloseCombo, atsInjCheckOption, atsInjSetChecked,
    atsInjClickYesNo, atsInjAttachFile, atsInjReadFileState, atsInjPlacesReady, atsInjScrollIntoView, atsInjSubmitState, atsInjErrors, atsInjSelectNative,
  };
}
