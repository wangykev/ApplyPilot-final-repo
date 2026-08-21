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
      isSignatureDateQuestion: isSignatureDateQuestion,
      // Security clearance: recognizer + candidate ladder, shared with the Workday driver's own rung so
      // the two engines answer a clearance question identically.
      recognizeClearanceQuestion: recognizeClearanceQuestion, clearanceCandidates: clearanceCandidates,
      recognizeRelocationQuestion: recognizeRelocationQuestion, relocationCandidates: relocationCandidates,
      // The checkbox-GROUP vocabulary. A native multi-select reaches review as a group, so it must
      // join/split exactly the way groups do — see the multiselect commit path.
      joinGroupValue: joinGroupValue, splitGroupValue: splitGroupValue, GROUP_JOIN: GROUP_JOIN,
      // Work-experience bullets → one prose block for a "Responsibilities" textarea.
      joinBullets: joinBullets };
const atsFd = (typeof module !== "undefined" && module.exports)
  ? require("./fill-driver.js")
  : { resolve: resolve, buildReviewBundle: buildReviewBundle, buildBucketIndex: buildBucketIndex,
      recognizeEmploymentQuestion: recognizeEmploymentQuestion, decideEmploymentStatus: decideEmploymentStatus,
      optionForPolarity: optionForPolarity, parseAiReply: parseAiReply, parseAiText: parseAiText,
      legallyLoaded: legallyLoaded, textValuesMatch: textValuesMatch, bundleSubmitBlockers: bundleSubmitBlockers,
      boolLadderCandidates: boolLadderCandidates, appendFieldVariants: appendFieldVariants,
      // The disability self-ID ladder: the stored wording FIRST, the bare polarity token LAST, so
      // POLARITY LEAD can commit it deterministically. See the ORA_DISABILITY_STATUS map entry.
      selfIdDisabilityCandidates: selfIdDisabilityCandidates,
      // Grades a match tier as exact / containment / fuzzy / none. See atsTierIsDeterministic.
      flagTierCategory: flagTierCategory };

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
  // ⚠ ORACLE RECRUITING CLOUD IS THE ONE FAMILY THE HOST ALONE CANNOT IDENTIFY (2026-08-19).
  // Every test above is host-only, and CLAUDE.md said that must stay so — the reason being that
  // detection must never need PAGE EVIDENCE (that is atsPortalAts' job, and it is a separate,
  // more expensive decision). Oracle keeps that property while breaking the letter of the rule:
  // `*.fa.*.oraclecloud.com` is the generic Oracle FUSION APPLICATIONS host, which also serves
  // ERP and HCM back-office UIs — pages this pipeline must never drive. The recruiting product's
  // identity is in the PATH (`/hcmUI/CandidateExperience/`), so that is what we test. Still
  // URL-only: no fetch, no injection, no page contact. Operator-approved 2026-08-19.
  //
  // Three host shapes observed live, and the third has NO region segment:
  //   eeho.fa.us2.oraclecloud.com · ejov.fa.ca2 · hdpc.fa.us2 · efds.fa.em5 · hcmn.fa.ap1 · hdow.fa.us6
  //   fa-evmr-saasfaprod1.fa.ocs.oraclecloud.com   (the `fa-<code>-saasfaprod1` + `.fa.ocs.` shape)
  //   jpmc.fa.oraclecloud.com                      (bare — the optional region group is absent)
  // ANCHORED at `$` and on a label boundary, so `oraclecloud.com.evil.com` and
  // `fakeoraclecloud.com` return null — the same discipline test/ats.test.js pins for the others.
  //
  // ⚠ An employer VANITY domain CNAME'd to ORC (careers.<company>.com) does not match, by design:
  // that is the employer-hosted-portal case iCIMS already established, and it is answered by page
  // evidence, not by widening a host test until it matches things it cannot verify.
  if (/(^|\.)fa(\.[a-z0-9-]+)?\.oraclecloud\.com$/.test(host)) {
    let path = "";
    try { path = new URL(String(url)).pathname; } catch (e) { return null; }
    if (/\/hcmUI\/CandidateExperience\//i.test(path)) return "oracle";
    return null;
  }
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
    // ⚠ ORACLE MUST NOT BE GIVEN A SYNTHESIZED FORM URL (measured 2026-08-19). It falls to the
    // default below — which returns the POSTING url unchanged — and that is the correct answer, not
    // an oversight. Guessing the Lever/Ashby shape `…/job/<id>/apply` **redirects to
    // `…/sites/<site>/404`**: the apply route is reached only by pressing `button.apply-now-button`,
    // which pushes `…/job/<id>/apply/email`. Landing on that route directly is also not a shortcut —
    // it is a step of a stateful SPA flow. So the Apply click is a required STAGE for ORC, the way
    // it is for an iCIMS portal. Do not "fix" this by appending a path.
    if (ats === "oracle") return u.origin + u.pathname + u.search;
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
    // ⚠ ORACLE'S SUBDOMAIN IS OPAQUE, SO THIS RETURNS NOTHING RATHER THAN A GUESS (2026-08-19).
    // The tenant label is a Fusion POD id — `eeho`, `hdpc`, `ejov`, `fa-evmr-saasfaprod1` — which
    // names no employer, and path segment 0 is the literal `hcmUI`. Both would hand the
    // safety-critical employment recognizer ("have you worked for us before?") a word no company is
    // called, which is the exact failure iCIMS' `jobs` segment produced.
    //
    // Returning null is SAFE here in a way it would not be elsewhere, and only because ORC supplies
    // the real name in STRUCTURED form: the posting carries JSON-LD `hiringOrganization.name`
    // ("Nokia Corporation"), and its own CX REST requisition endpoint answers 200 unauthenticated.
    // So the anchor is evidence rather than a URL heuristic — and with no plausible fallback, an
    // absent company correctly makes the recognizer UNEVALUABLE (blank + review) instead of
    // confidently comparing against a pod id.
    if (kind === "oracle") return null;
    const seg = (u.pathname.split("/").filter(Boolean)[0] || "").replace(/[-_]+/g, " ").trim();
    if (!seg || seg === "embed") return null;
    return seg.split(" ").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
  } catch (e) { return null; }
}

// IS THIS STRING A COMPANY NAME, OR A PAGE TITLE THE SCRAPE MISTOOK FOR ONE? An employer-hosted
// careers page has no ATS markup for the JD scrape to key on, so its company heuristic can fall
// back to the document title — live 2026-08-16 on careers.astrion.us it produced
// "Engineering Directorate Support Intern in Mountain View, California | Astrion".
//
// That is not cosmetic. `jobContext.company` is the anchor for the SAFETY-CRITICAL employment
// recognizer ("have you worked for us before?"), and comparing a tenant's own question against a
// job title means the anchor silently never matches. CLAUDE.md already names the same hazard for
// iCIMS' path segment: hand the recognizer a word no employer is called and every such question
// misreads.
//
// Deliberately a NEGATIVE test with loud tells, not a cleverer parser: a real name is short and
// carries no title furniture. Anything it rejects falls back to the URL-derived tenant, which is
// evidence rather than a guess; anything it can't judge is KEPT, so the existing Greenhouse /
// Lever / Ashby behaviour is unchanged.
function atsPlausibleCompany(name) {
  const s = String(name == null ? "" : name).replace(/\s+/g, " ").trim();
  if (!s) return false;
  if (s.length > 48) return false;                 // names are short; titles run on
  if (/[|·—]/.test(s)) return false;               // "<title> | <Company>" separators
  if (/\bin\s+[A-Z][\w.'-]+,\s*[A-Z]/.test(s)) return false;  // "… in Mountain View, California"
  if (/\b(intern|engineer|manager|analyst|developer|scientist|director|specialist|technician|associate|architect)\b/i.test(s)) return false;
  return true;
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
  // ⚠ Keys are the id with any REPEATING-ENTRY ORDINAL STRIPPED (`atsMapKey`): the live ids for the
  // address and phone blocks are `-1_PersonProfileFields.AddressCity`, `-1_PersonProfileFields.PhoneNumber`.
  // Keying them bare is safe because `PersonProfileFields.Address*` / `.Phone*` are iCIMS' OWN vocabulary
  // for the CANDIDATE — a work-history employer's address or phone is a per-customer `rcf<NNNN>` and
  // cannot collide. But the ordinal still matters: the form can render a SECOND entry, and a bare-id
  // map would hand it a duplicate of the first. The repeat is DETECTED from the page rather than
  // declared here — see `repeatIndex` in atsAssignEntryIndexes — so only the first entry the form
  // renders is mapped, on any tenant, whether or not its blocks happen to repeat.
  // ── ORACLE RECRUITING CLOUD (observed 2026-08-19; Baylor + Oracle's own careers site) ──────────
  // Keys are the control's `name` after atsMapKey (render counter stripped, self-ID reduced to its
  // ORA_ token). ONLY platform names belong here — per-tenant flexfields (`300000016979265`,
  // `namInformation15`) and `dq-option-*` screening questions go to the LABEL ladder, which is why
  // they are absent rather than forgotten.
  oracle: {
    "firstName": { path: "personal_info.first_name" },
    "lastName": { path: "personal_info.last_name" },
    "email": { path: "personal_info.email" },
    // ORC's "Known As" is the preferred/known-as name (Baylor marks it REQUIRED). Falls through to
    // the label ladder when the operator has no preferred name, which is the right behaviour.
    "knownAs": { path: "personal_info.preferred_first_name" },
    // ⚠⚠ `phoneNumber` IS THE DIAL-CODE PICKER, NOT THE NUMBER — measured, and the single most
    // misleading name on an ORC form. `id="country-codes-dropdownphoneNumber"`, `role=combobox`,
    // label "Country code", value "+1". The control that actually wants the number has NO id and NO
    // name at all (only `aria-label="Phone Number"` + `.phone-row__input`), so it cannot be mapped
    // here and needs a scan-side synthetic name. Mapping this to the phone NUMBER would type the
    // number into the dial-code list — the same class of error as Greenhouse's `country`, which is
    // why it takes the same `kind:"dial"` + tiered ladder.
    "phoneNumber": { kind: "dial", path: "personal_info.country_phone_code", altPath: "personal_info.dialing_code" },
    // ⚠ `title` IS A SALUTATION (Mr./Mrs./Dr./Professor/Frau/Dipl. Ing. — 17 rows measured), NOT a
    // job title, and it sits in the NAME block between lastName and middleNames. The profile stores
    // no salutation, so the right value is BLANK.
    //
    // It is CLAIMED rather than left unmapped, and that is the whole point: unmapped, its label
    // normalizes to "title", which collides with one of the most common taught-bucket wordings there
    // is — live 2026-08-19 an operator bucket answered it "Characterization and Test Automation
    // Intern", i.e. a job title typed into a salutation picker. The bucket is not even wrong in
    // general ("Title" means job title on nearly every other form); only the PLATFORM ID can tell the
    // two apart, which is why recognition has to happen here. Same shape as the clearance rung and
    // `may_contact`: claiming a question we cannot answer is what keeps the guessers off it.
    // (It committed nothing that run — the salutation list held no such row — but on a form whose
    // picker accepts free text it would have.)
    "title": { kind: "skip", detail: "salutation (Mr./Ms./Dr.) — the profile stores none, so it stays blank; claimed so a \"Title\" bucket cannot answer it with a JOB title" },
    // Address. `country` is the ADDRESS country (a tiered profile array), not the phone's.
    "country": { path: "personal_info.country" },
    "addressLine1": { path: "personal_info.address_line_1" },
    "addressLine2": { path: "personal_info.address_line_2" },
    "city": { path: "personal_info.city" },
    "postalCode": { path: "personal_info.postal_code" },
    // ⚠ `region1` / `region2` ARE DELIBERATELY UNMAPPED. Both are required comboboxes and their
    // labels did not render in recon, so which one is State/Province vs County is UNKNOWN — and it
    // almost certainly varies by `country`. Mapping the wrong one files the applicant's state as a
    // county, i.e. a confidently wrong value, which is worse than reaching review. Resolve from the
    // live label first, then map. Left here as a named gap so it is not mistaken for an oversight.
    // ── §2 documents. The résumé route + attach already exist (kind:"resume" → act.attachResume);
    // ORC only ever needed the map entry, which is why a REQUIRED résumé reached review as
    // "no profile mapping for this question" on a run that was otherwise clean.
    //
    // ⚠ ORDER IS THE OPPOSITE OF iCIMS, AND THAT IS DELIBERATE. iCIMS parses the upload SERVER-SIDE
    // and re-renders the whole panel with the result, so its résumé must go on BEFORE any value is
    // written (atsIcimsResumeStage). Oracle's résumé sits on a LATER STEP than the fields it could
    // disturb, and Oracle's own parse offer is the section-0 résumé-import banner, which we never
    // press — so the ordinary in-loop attach is correct here and no pre-stage is needed. Do not
    // "unify" the two: the reason they differ is WHEN the tenant re-renders the form.
    "resume-upload": { kind: "resume" },
    // Operator-supplied documents. Same reasoning as iCIMS' cover_letter: a cover letter is the
    // operator's own voice and an extra attachment is theirs to choose, so neither is invented.
    "cover-letter-upload": { kind: "skip", detail: "cover letter — operator-supplied (not modeled)" },
    "attachment-upload": { kind: "skip", detail: "extra attachment — the operator's to choose" },
    // ⚠ `siteLink-<n>` IS A NUMBERED FAMILY (<candidate-links>), and atsMapKey strips the trailing
    // `-<digits>` for Oracle, so this one key serves every rendered row.
    "siteLink": { kind: "website" },
    // E-signature (§4). The Workday signature rule: a signature NAME is the candidate's own name and
    // fills deterministically. ORC showed no signature DATE on the tenants observed.
    "fullName": { compose: "full_name" },
    // Self-ID, reduced by atsMapKey to Oracle's own ORA_ vocabulary so the map is locale-neutral.
    // containment:true for the same reason Greenhouse's block carries it — each tenant words the
    // long options its own way ("No, I do not have a disability" ⊂ "… and have not had one in the
    // past"), and a unique prefix hit commits at the flagged containment tier.
    // ⚠ These are STATED values only; an unstated one stays blank per the EEO rule (every self-ID
    // field on the observed tenants was OPTIONAL, so unstated ⇒ blank, no AI).
    "ORA_GENDER": { path: "self_identification.gender", containment: true },
    "ORA_ETHNICITY": { path: "self_identification.race_ethnicity", containment: true },
    "ORA_VETERAN_STATUS": { path: "self_identification.veteran_status", containment: true },
    // ⚠⚠ THE DISABILITY SELF-ID USES THE POLARITY LADDER, NOT CONTAINMENT (operator, 2026-08-20).
    // The operator's question was exactly right: "the disability question seems like it filled
    // deterministically, why is that for review." It committed the correct option — but at the
    // CONTAINMENT tier, and containment is graded `filled_review` BY DESIGN because containment is a
    // guess. The profile stores "No, I do not have a disability" and the form offers "No, I do not
    // have a disability and have not had one in the past", so the stored value is a strict PREFIX and
    // the ladder had nothing better to reach for.
    //
    // Workday has the answer already: `selfIdDisabilityCandidates` expands the stored value into the
    // stored wording FIRST and the bare polarity token LAST, and POLARITY LEAD then commits it
    // DETERMINISTICALLY — `filled`, unflagged — but only when EXACTLY ONE option leads with that
    // polarity. Here that is true ("Yes, I have…", "No, I do not…", "I do not want to answer"), and a
    // tenant that split one polarity into two meanings would still escalate to review instead of
    // being guessed. The ORC recon predicted this would work because the wording is byte-identical to
    // cat.wd5's; this is that prediction wired up.
    "ORA_DISABILITY_STATUS": { path: "self_identification.disability_status", kind: "selfid_disability" },
    // ⚠ Race/ethnicity is ALSO rendered as a checkbox GROUP whose boxes have NO `name` at all, so
    // that shape cannot be reached by this map and needs the scan's group handling first.
  },
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
    // ── The candidate's phone (also a REPEATING block, same `-1_` ordinal shape) ───────────
    // ⚠ THESE WERE MISSING, AND THE AI FILLED THE GAP WITH THE REQUISITION NUMBER. Both are
    // REQUIRED and their labels are just "Number" and "Type", which match nothing in the label
    // ladder — so both fell through to the AI, and it answered "Number" with `24615`, the job's req
    // id (live 2026-08-16, flagged `ai-text`). The review gate caught it, but a phone field holding
    // a requisition id is the confident-wrong-value class, and it recurred on every run.
    // Safe to key by bare id for exactly the reason the address block is: `PersonProfileFields.Phone*`
    // is iCIMS' own vocabulary for the CANDIDATE's phone, while an employer's phone in a work-history
    // entry is a per-customer `rcf<NNNN>` (rcf3271 here) and cannot collide.
    "PersonProfileFields.PhoneNumber": { path: "personal_info.phone_number" },
    "PersonProfileFields.PhoneExtension": { path: "personal_info.phone_extension" },
    // The type is a plain <select> of Work/Home/Mobile/Other/Email — the profile's stored device type
    // answers it deterministically, and the AI's "Mobile" guess (flagged `ai-choice`) was only ever a
    // guess that happened to look right.
    "PersonProfileFields.PhoneType": { path: "personal_info.phone_device_type" },
    // ⚠ THE ADDRESS TYPE IS KNOWABLE, AND THE AI WAS ANSWERING IT TWO DIFFERENT WAYS (live 2026-08-18).
    // Its label is a bare "Type" inside the candidate's own address block, so the label ladder has nothing
    // to key on and it fell to the AI — which answered "Home" on one tenant and "Work" on the next. Same
    // question, same profile, two answers, and "Work" is simply wrong: the one address a profile holds is
    // `personal_info.address_*`, the applicant's residence. There is no profile field for this because
    // there is nothing to ask: it is a fact about the FORM's vocabulary, so the answer is a literal.
    // Tiered because tenants word it differently, and still matched against the live options.
    "PersonProfileFields.AddressType": { candidates: ["Home", "Home Address", "Residence", "Personal"],
      note: "(the profile's address is the candidate's home)" },
    // The dial-code half, when a tenant renders one. Tiered in the profile like country, so resolve()
    // passes a ready-made candidate ladder; `kind:"dial"` strips the trailing "+<digits>" for matching.
    "PersonProfileFields.PhoneCountry": { kind: "dial", path: "personal_info.country_phone_code", altPath: "personal_info.country" },
    // ── Résumé — ATTACHED FIRST, NEVER DURING THE FILL (operator, 2026-08-17) ──────────────
    // iCIMS parses an uploaded résumé SERVER-SIDE and posts the results back into the panel seconds
    // after the attach reports success, re-rendering entries under new ids and blanking everything
    // written so far — the page says so itself ("Existing data in the form will be replaced"). That is
    // why this was `kind:"skip"` from 2026-08-16: as an ordinary field mid-fill, the résumé destroys
    // the fill it is supposed to help.
    // The fix is ORDER, not avoidance. `atsIcimsResumeStage` attaches the résumé BEFORE a single field
    // is written and waits the parse out (postback landed → panel quiet), so the parse overwrites
    // nothing of ours and every value we then write lands on top of whatever it produced. The entry is
    // `kind:"resume"` so ONE router decides which file field is the résumé on every path — the fill,
    // the replay and the stage all ask it — but the branch consuming it in `atsFillFields` REFUSES to
    // attach on iCIMS and records the stage's outcome instead: a second attach is a second parse, and
    // the second one would blank the fill the first one exists to precede.
    // The form's own "Upload Resume at a later time" box is still left UNTICKED — that is an operator's
    // choice about their own application, not ours to make.
    "PortalProfileFields.Resume_File": { kind: "resume" },
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

// ⚠ THE FIRST NON-EMPTY WEBSITE, IN THE PROFILE'S OWN ORDER — not "the LinkedIn one". The profile
// keeps `websites` as an ordered list WITH BLANK SLOTS (the portfolio and "other" rows are usually
// empty strings), so a type-keyed lookup answers nothing for a generic "Website" field while a naive
// `websites[0].url` can hand a form an empty string to type into a url input. "First that exists"
// gives a candidate who filled only GitHub a real link, and gives nobody a blank one.
// ONE row is filled because ORC renders one `siteLink-<n>` at a time; adding more is the operator's.
function atsFirstWebsiteValue(profile) {
  const list = atsProfileWebsites(profile);
  return list.length ? list[0] : null;
}

// EVERY non-empty website, in the profile's own order, https-normalized. The profile keeps blank
// slots (the portfolio and "other" rows are usually empty strings), so the list is compacted here —
// which is what makes an ORDINAL meaningful: "link 2" is the second website that EXISTS, not the
// second row of the editor.
function atsProfileWebsites(profile) {
  const ws = Array.isArray(profile && profile.websites) ? profile.websites : [];
  const out = [];
  for (const w of ws) {
    const u = w && typeof w.url === "string" ? w.url.trim() : "";
    if (!u) continue;
    const full = atsLib.ensureHttps(u);
    if (full && out.indexOf(full) === -1) out.push(full);
  }
  return out;
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
  if (ats === "icims") return n.replace(/^-?\d+_/, "");
  // ── ORACLE: strip the render counter, then reduce a self-ID name to its ORA_ token ────────
  // ⚠ THIS IS THE **MAP-LOOKUP** KEY ONLY, NOT A DURABLE/SUBMIT KEY. The two differ for ORC and
  // conflating them would be a bug: this function is allowed to be LOSSY because the map contains
  // only known platform names, so a collapsed per-tenant key simply fails to match and falls to the
  // label ladder — which is the correct destination for it anyway. A submit key must instead stay
  // UNIQUE per field, and for ORC that is deliberately still unsettled (see below).
  //
  // 1. A trailing `-<digits>` is the render-assignment counter. Text and combobox `name`s are clean
  //    (`lastName`, `US-STANDARD-ORA_GENDER-STANDARD`) but a RADIO GROUP's shared name carries it
  //    (`US-STANDARD-ORA_DISABILITY_STATUS-STANDARD-12`), so without this the disability group never
  //    matches the map entry its gender/veteran siblings do. Observed 2026-08-19.
  //    ⚠ Safe on every other observed name because the digits there are NOT hyphen-separated:
  //    `region1`, `region2`, `addressLine1`, `namInformation15` are all untouched.
  //    `siteLink-1` → `siteLink` is INTENDED (the digit is an entry ordinal; the family is the map
  //    key, exactly as iCIMS treats its ordinals).
  // 2. Self-ID names are `<JURISDICTION>-STANDARD-ORA_<THING>-STANDARD`. `ORA_<THING>` is Oracle's
  //    stable vocabulary; the wrapper is jurisdiction + variant, so keying on the whole string would
  //    silently stop matching outside the US. Reduce to the token and the map becomes locale-neutral.
  if (ats === "oracle") {
    const bare = n.replace(/-\d+$/, "");
    const ora = /(ORA_[A-Z0-9_]+)/.exec(bare);
    return ora ? ora[1] : bare;
  }
  return n;
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
      // ⚠ DAY PARTS, AND WHY THE `from` KEYS DIFFER (operator, 2026-08-18). A form can require a DAY
      // for education dates. `from_year`/`to_year` are year-only — a year says nothing about a month,
      // let alone a day — so the profile grew `start_date` ("YYYY-MM-DD", or "YYYY-MM" when only the
      // month is known) for exactly this, while the END parts read `graduation_date` (one fact, one place
      // to state it). `fromAlt` is the year-only fallback, so a profile
      // that has not filled the new fields behaves exactly as before.
      // The `_Date` suffix is iCIMS' own name for the day part (observed on the experience block's
      // rcf3214_Date); `_Day` is accepted too because the platform ids are not guaranteed to agree
      // across tenants and a wrong guess here costs nothing — an id that does not exist never matches.
      "CandProfileFields.GraduationDate_Month": { kind: "date_month", from: "graduation_date" },
      "CandProfileFields.GraduationDate_Year": { kind: "date_year", from: "graduation_date" },
      "CandProfileFields.GraduationDate_Date": { kind: "date_day", from: "graduation_date" },
      "CandProfileFields.GraduationDate_Day": { kind: "date_day", from: "graduation_date" },
      "CandProfileFields.EducationStartDate_Month": { kind: "date_month", from: "start_date", fromAlt: "from_year" },
      "CandProfileFields.EducationStartDate_Year": { kind: "date_year", from: "start_date", fromAlt: "from_year" },
      "CandProfileFields.EducationStartDate_Date": { kind: "date_day", from: "start_date" },
      "CandProfileFields.EducationStartDate_Day": { kind: "date_day", from: "start_date" },
      // ⚠ THE EDUCATION END DATE *IS* THE GRADUATION DATE (operator, 2026-08-18). These read
      // `graduation_date` rather than a field of their own: one fact, one place to state it. Two fields
      // could disagree, and then the fill would have to pick — which is exactly the kind of guess this
      // codebase refuses. `to_year` stays as the year-only fallback for the Month/Year parts.
      "CandProfileFields.EducationEndDate_Month": { kind: "date_month", from: "graduation_date", fromAlt: "to_year" },
      "CandProfileFields.EducationEndDate_Year": { kind: "date_year", from: "graduation_date", fromAlt: "to_year" },
      "CandProfileFields.EducationEndDate_Date": { kind: "date_day", from: "graduation_date" },
      "CandProfileFields.EducationEndDate_Day": { kind: "date_day", from: "graduation_date" },
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
    // ⚠ THE HEADING IS THIS SECTION'S ONLY IDENTITY, SO ITS WORDING IS LOAD-BEARING (live 2026-08-18).
    // `match` below is empty on purpose — there is no id family to key on — which means one unmatched
    // heading unmaps the whole section silently. That happened: Astrion titles it "Experience" and this
    // pattern was anchored at the start, so Cretex's "Work Experience" missed. The consequence was not a
    // missing field or two — the ENTIRE work-history block went unstamped, the label ladder then answered
    // each row from `work_experience.0` (always entry 0), the repeat-detector left rows 2 and 3 blank as
    // "repeats of a single value", and iCIMS' résumé-parse guesses stayed on the form in all of them.
    // Education survived the same tenant only because it HAS an id family as a second signal.
    // Widened to the wordings tenants actually use, and deliberately NOT to every heading containing the
    // word: "Volunteer Experience" and "Military Experience" are different sections, and filing volunteer
    // or service history as employment would be a factual error about the applicant, not a near-miss.
    sectionTitle: /^(?!.*\b(volunteer|military|education)\b)(work\s+|professional\s+|employment\s+|prior\s+|relevant\s+)?(experience|employment|work\s+history|employment\s+history)\b/i,
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

// ── A REPEATED FIELD IS DETECTED, NOT DECLARED (operator, 2026-08-17) ─────────────────────
// iCIMS renders the candidate's own address and phone as repeating BLOCKS ("Add More (Addresses)"),
// and every field in them carries an entry ordinal: `-1_PersonProfileFields.AddressCity`. The static
// map is keyed on the ordinal-STRIPPED id, so without this a second entry is handed a DUPLICATE of
// the first — CLAUDE.md already flagged exactly that for addresses, and phone has the same shape.
//
// ⚠ THERE IS DELIBERATELY NO LIST OF WHICH BLOCKS REPEAT. A first cut named the families
// (`Address*`, `Phone*`) and that is wrong for the plain reason that iCIMS is configured per
// customer: a block that repeats on this tenant may be a single row on the next, and a block that
// does not repeat here may repeat there. Naming families means the next portal is a code change.
//
// So ask the question the PAGE can answer: **has this exact field already appeared under a different
// ordinal?** Group by the BARE id and take the position of the field's own ordinal in that id's
// first-seen ordinal list. Index 0 is the entry the map fills; anything above it is a repeat. A form
// that renders one address row therefore produces index 0 for everything and this never fires at
// all — which is also why it needs no claim about whether a given tenant's phone block repeats.
//
// Ordinals are POSITIONS, never values: `-1` is iCIMS' default entry and a saved one carries an
// opaque server id, so `-2` is not "the second" and 4839201 is not "the 4839201st".
//
// Fields already claimed by a SECTION (Education / Experience / Certifications) are excluded — those
// repeat legitimately from a profile ARRAY, and their own entry tier answers them before this is
// reached. `rcf3271` ("Employer Phone Number") appearing as -1/-2/-3 is that case, not this one.
//
// Why blank rather than a copy or an AI guess: the profile holds ONE address and ONE phone, so a copy
// is a fabricated second phone number and the AI's would be a guessed one. Blank plus a note that
// says why is the honest answer, and the extra entry is optional, so nothing is blocked.

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
      // ⚠ KEY ON THE PART LABEL FOR A COMPOSITE, NOT THE COMPOSED DISPLAY LABEL. The scan now renders a
      // composite part's label as "<question> — <part>" ("Start Date — Month") so review reads
      // properly — and that BROKE this lookup, which tests `/^month$/i` to decide a date group. The
      // spec stopped matching, the field fell through to the AI, and it INVENTED work-experience dates
      // that the profile already answers ("Jun 1 2026", reasoned from "typical summer internship start
      // date"). A display change must not be able to reach the matching layer: `partLabel` is the raw
      // name of the control, which is what this has always meant.
      const key = String(f.partLabel || f.label || "").toLowerCase().replace(/\s+/g, " ").replace(/[*✱:]\s*$/, "").trim();
      spec = def.byLabel[key] || null;
      if (!spec && def.dateGroups && typeof f.dateGroup === "number") {
        const g = def.dateGroups[f.dateGroup];
        if (g && /^month$/i.test(key)) spec = { kind: "date_month", from: g.from };
        else if (g && /^year$/i.test(key)) spec = { kind: "date_year", from: g.from };
        else if (g && /^day$/i.test(key)) spec = { kind: "date_day", from: g.from };
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
  // ⚠ SAY WHEN A REPEATING BLOCK MATCHED NO SECTION AT ALL. This is the signal whose absence cost a whole
  // round: on Cretex every work-history field carried an ordinal, sat under a heading, and matched no
  // section map — and NOTHING said so. The fill then looked healthy (rows filled from entry 0, later rows
  // "left for you"), the review pile looked like ordinary unmapped questions, and the parse's values sat
  // on the form. A heading is a per-customer string, so this WILL happen again on the next tenant; the
  // log is what makes it a five-second diagnosis instead of an archaeology session.
  try {
    // ⚠ WARN ONLY ABOUT A GENUINE MULTI-ROW BLOCK. The first version of this fired on every iCIMS form,
    // because the candidate's own address and phone fields also carry ordinals and match no section — and
    // for THEM that is correct (they are single-value fields answered from the profile root, see the
    // repeat rule below). A warning that cries wolf on every run is worse than none: it trains you to
    // skip the line that matters. The discriminator is REPETITION — a missed section renders the SAME
    // bare id under two or more ordinals (Cretex's rcf3212 under -1/-2/-3), while an address block
    // renders each id exactly once.
    const byId = {};
    for (const f of fields) {
      const mm = /^(-?\d+)_/.exec(String(f.fieldName || ""));
      if (!mm || f.entrySection) continue;
      const bare = atsMapKey(ats, f.fieldName);
      const h = String(f.section || "(no heading)").trim() || "(no heading)";
      const k = h + "\u0000" + bare;
      (byId[k] = byId[k] || new Set()).add(mm[1]);
    }
    const perHeading = {};
    for (const [k, ords] of Object.entries(byId)) {
      if (ords.size < 2) continue;                       // rendered once — not a repeating block
      const [h, bare] = k.split("\u0000");
      (perHeading[h] = perHeading[h] || { ids: [], rows: 0 });
      perHeading[h].ids.push(bare);
      perHeading[h].rows = Math.max(perHeading[h].rows, ords.size);
    }
    for (const [heading, info] of Object.entries(perHeading)) {
      console.log(`[ApplyPilot][ATS-FILL] ⚠ ${info.ids.length} field(s) under ${JSON.stringify(heading)} repeat across ${info.rows} rows but matched NO section map — every row will be answered from entry 0 (or left as a repeat), so a multi-entry block here fills only its first row. Add the heading to a section map. Ids: ${[...new Set(info.ids)].slice(0, 6).join(", ")}`);
    }
  } catch (e) { /* diagnostic only */ }

  // …and stamp REPEATS of a field that is answered from the profile ROOT — the candidate's own
  // address and phone blocks, and anything else a tenant chooses to make repeatable. DETECTED, not
  // declared: group by the BARE id and record where this field's ordinal falls in that id's
  // first-seen ordinal list. See the comment on this block above for why there is no family list.
  const repeatOrder = {}; // bare id → [ordinal, …] in first-seen order
  for (const f of fields) {
    // A section entry is filled from its own profile ARRAY, so its repeats are legitimate and its
    // own tier answers them. Excluded here so the two ideas can never fight over a field.
    if (f.entrySection) continue;
    const m = /^(-?\d+)_/.exec(String(f.fieldName || ""));
    if (!m) continue;
    const bare = atsMapKey(ats, f.fieldName);
    const list = (repeatOrder[bare] = repeatOrder[bare] || []);
    if (list.indexOf(m[1]) === -1) list.push(m[1]);
    f.repeatIndex = list.indexOf(m[1]);
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

// Is a "YYYY", "YYYY-MM" or "YYYY-MM-DD" strictly in the future? null when it is none of those shapes.
// `now` is a parameter so the rule is unit-testable without freezing the clock.
// ⚠ THE DAY FORM WAS MISSING AND THAT REGRESSED A DETERMINISTIC ANSWER (live 2026-08-18). This accepted
// month precision only, so the moment a graduation date carried a day — "2028-05-01", the whole point of
// the day-capable fields — it returned null, the is_graduated rule could not decide, and "have you
// graduated?" fell through to the AI and came back FLAGGED. Adding precision must never cost an answer:
// same lesson as the Month/Year parts, found the same way (a run that should have had one fewer review
// item had one more).
// A stated DAY is compared as a day, so a graduation later this month reads as future rather than past;
// month precision keeps its old meaning (the whole month counts as future until it is over), and a bare
// year likewise.
function atsIsFutureYearMonth(s, now) {
  const t = now == null ? new Date() : new Date(now);
  const str = String(s).trim();
  const ymd = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(str);
  const ym = /^(\d{4})-(\d{1,2})$/.exec(str);
  const y = /^(\d{4})$/.exec(str);
  if (!ymd && !ym && !y) return null;
  const yr = parseInt((ymd ? ymd[1] : ym ? ym[1] : y[1]), 10);
  const mo = ymd ? parseInt(ymd[2], 10) : ym ? parseInt(ym[2], 10) : 12; // a bare year is past only once over
  const nowYr = t.getFullYear(), nowMo = t.getMonth() + 1, nowDay = t.getDate();
  if (yr !== nowYr) return yr > nowYr;
  if (mo !== nowMo) return mo > nowMo;
  // same year AND month: only a stated day can separate them. Without one, the month is not over, so it
  // stays "future" exactly as before.
  return ymd ? parseInt(ymd[3], 10) > nowDay : true;
}

// Resolve ONE repeating-entry field from ITS OWN entry. Returns a route, or null to fall through
// (which, for an entry field, means the scoped AI — never the profile root).
// The operator's default day-of-month, for a form that REQUIRES a day on a date the profile stores to
// the month. PURE + validated: only 1–31 is accepted, so a typo cannot put "0" or "45" on a real
// application; anything else (absent, junk, out of range) means "no default", and the field goes back
// to reaching review rather than being filled with nonsense.
var ATS_DEFAULT_DAY = 1;
function atsDefaultDay(defaults) {
  const raw = defaults && defaults.date_day;
  if (Array.isArray(raw)) return null;                // junk config — do not interpret it
  // `{ value: N, note: "…" }` is the shipped shape; a bare number is accepted too.
  const v = raw && typeof raw === "object" ? raw.value : raw;
  if (v === null) return null;                        // an explicit null opts OUT — keep nagging
  // `undefined` covers both "no `date_day` at all" and `{}` (a wrapper with no value), which are
  // indistinguishable and mean the same thing: unconfigured, so use the built-in.
  if (v === undefined) return ATS_DEFAULT_DAY;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) && n >= 1 && n <= 31 ? n : null;
}

// The stored "may we contact this employer?" answer → a TIERED candidate ladder, most specific first.
// Returns null for UNANSWERED, which is what makes the caller claim the field rather than guess.
//
// Accepts the tri-bool this replaced (true/false) as well as the three codes, because a profile synced
// before 2026-08-18 still carries booleans and a migration that only worked on the website would leave
// the extension answering nothing. Also accepts the label spellings, so a hand-edited profile.json
// ("Yes, if required") is not silently read as unanswered.
function atsMayContactCandidates(stored) {
  if (stored === true) return { answer: "yes", candidates: ["Yes", "True"] };
  if (stored === false) return { answer: "no", candidates: ["No", "False"] };
  const t = String(stored == null ? "" : stored).trim().toLowerCase().replace(/[\s_-]+/g, " ").replace(/[.,]/g, "");
  if (!t) return null;
  if (/^(yes|y|true)$/.test(t)) return { answer: "yes", candidates: ["Yes", "True"] };
  if (/^(no|n|false)$/.test(t)) return { answer: "no", candidates: ["No", "False"] };
  if (/^(yes )?(if|only if) (required|requested|necessary|needed)$/.test(t)) {
    return { answer: "yes_if_required", conditional: true, candidates: [
      // every wording a form has been seen to offer, then the bare polarity as the last tier
      "Yes, if required", "Yes if required", "Yes, if necessary", "Yes if necessary",
      "Only if required", "Only if necessary", "If required", "Yes",
    ] };
  }
  return null;                                     // prose we cannot read is UNANSWERED, never a guess
}
function atsResolveEntryField(es, entry, f, now, defaults) {
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
  // ── DAY-OF-MONTH (operator, 2026-08-17) ────────────────────────────────────────────────
  // A form can REQUIRE the day of a date the profile stores to the month ("2025-05"), and a required
  // field we cannot answer reaches review — so every date on the page nagged for a day. Two sources,
  // in order, and the distinction is the point:
  //   • the profile's OWN day, when it stores one ("2025-05-12") — a stated fact;
  //   • otherwise the operator's configured default (`defaults.date_day`, data/application_defaults
  //     .json), which is an APPROXIMATION and says so in its detail.
  // Deliberately ONE default rather than a clever per-side rule (first-of-month for a start,
  // last-of-month for an end): that would be us inventing precision the operator never gave, and on a
  // job application a date is a factual claim. One number they can see and change is honest; guessing
  // differently at each end is not.
  if (spec.kind === "date_day") {
    // `fromAlt` is a YEAR-ONLY fallback and can never carry a day, so the day spec does not consult it:
    // a day off "2024" would be two guesses stacked (see the year-only refusal below).
    const raw = val(spec.from);
    if (raw == null) return null;
    const ymd = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(raw));
    const path = es.section + "[" + es.entryIndex + "]." + spec.from;
    // A day the profile STATES is a fact, so it fills whether the form requires it or not.
    if (ymd) return { value: String(parseInt(ymd[3], 10)), source: "entry", path };
    // Month precision — fall back to the default, but only for a value that IS a date. A year-only
    // "2024" says nothing about a month either, so a day off it would be doubly invented.
    if (!/^\d{4}-\d{1,2}$/.test(String(raw))) return null;
    // ⚠ THE DEFAULT IS FOR REQUIRED FIELDS ONLY (operator, 2026-08-17). An optional blank blocks
    // nothing — it does not hold up Save, it does not hold up the submit gate, and it is not a review
    // item — so putting an APPROXIMATION there buys nothing and adds an unasked-for claim to the
    // application. The default exists to unblock a field the form insists on, and that is the only
    // place it belongs. Same rule the AI tier already obeys: required gets a fallback, optional fills
    // deterministically or stays blank.
    if (!f || !f.isRequired) return null;
    const d = atsDefaultDay(defaults);
    if (d == null) return null;
    // ⚠ FLAGGED FOR REVIEW (operator, 2026-08-17). A default is an APPROXIMATION, not something the
    // operator stated, so it faces the human gate like every other value we did not get from them —
    // the same rule that flags an AI answer and a non-exact match. It still FILLS, which is the point:
    // the field went from blank-and-flagged (type a value) to filled-and-flagged (approve it), so the
    // nag costs one click instead of a lookup, and a wrong default can never be submitted unnoticed.
    // A day the profile actually STATES is a fact and stays unflagged — see the branch above.
    return { value: String(d), source: "default", review: true, flag: "default-value",
      detail: 'day-of-month is not in your profile (it stores "' + String(raw) + '") — used your default of ' + d + '; approve it or set the real day' };
  }
  if (spec.kind === "date_month" || spec.kind === "date_year") {
    // Prefer the day-capable field; fall back to the year-only one when the operator has not filled it,
    // so adding these fields cannot change what an existing profile fills.
    const raw = val(spec.from) != null ? val(spec.from) : (spec.fromAlt ? val(spec.fromAlt) : null);
    if (raw == null) return null;
    const s = String(raw);
    // ⚠ ACCEPT DAY PRECISION TOO. These specs matched "YYYY-MM" EXACTLY, so the moment a date carried a
    // day ("2024-08-26" — the whole point of the day-capable date fields) the month part returned
    // null and the form's Month dropdown went unfilled while its Day filled perfectly. A more precise
    // value must never answer LESS than a vaguer one.
    const ym = /^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/.exec(s);   // "2028-05" or "2028-05-11"
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
    // A THREE-WAY STORED ANSWER (operator, 2026-08-18) — yes / no / yes_if_required — and each one
    // becomes a TIERED ladder, most specific first, so the form's own vocabulary decides which lands.
    // `atsMayContactCandidates` also migrates the tri-bool this replaced, because a profile synced
    // before today still carries true/false.
    //
    // The conditional answer is the reason a boolean was not enough: it ends with a bare "Yes", so a
    // plain Yes/No form gets "Yes" — the truthful projection onto the options that exist, since the
    // conditionality has nowhere to live there — while a form that DOES offer "Yes, if required" gets
    // that instead, at a higher tier. Unflagged, like every other tiered profile ladder: the operator
    // chose an answer that entails yes, and a value they stated is not a guess we made.
    const mc = atsMayContactCandidates(entry.may_contact);
    if (mc) return { candidates: mc.candidates, source: "entry",
      path: es.section + "[" + es.entryIndex + "].may_contact",
      detail: mc.conditional
        ? "may_contact = \"yes, if required\" — a form offering only Yes/No gets Yes"
        : "may_contact = " + JSON.stringify(mc.answer) };
    // ⚠ AND AN UNANSWERED ONE IS CLAIMED, NOT PASSED ON (live 2026-08-18). The refusal two lines up
    // was being overridden one rung later: returning null made this an ordinary "entry-unanswered"
    // field, which by design falls through to the AI — whose prompt tells it to infer from ABSENCE and
    // never refuse. Measured on Cretex, all three work-history rows: `ai-choice · after "Yes" ·
    // reasoning-from-absence: default affirmative`. So the one question this file explicitly declines
    // to default was answered "Yes" by a model, handing a recruiter permission to ring a past — or
    // CURRENT — employer that the operator never gave. A current employer learning you are job
    // hunting is a real cost, and it is not recoverable from a review page after the fact.
    // Same remedy as the clearance rung and the credential tier: CLAIMING the field is what keeps the
    // AI away from it, so it is claimed even though we cannot answer it. A required one then blocks the
    // submit gate until a human answers it — which is the honest outcome, and the fix is one profile
    // edit ("No" is a perfectly good answer) rather than a guess.
    return { kind: "entry-permission-unstated", review: true, flag: "may-contact-unstated", source: "entry",
      path: es.section + "[" + es.entryIndex + "].may_contact",
      detail: "this asks whether they may contact this employer, and your profile does not say for this role — "
        + "answer it here, or set it on the Profile page. It is deliberately never guessed: a \"Yes\" nobody "
        + "gave could tip off an employer you have not told you are looking." };
  }
  if (spec.kind === "contact_if_allowed") {
    // ⚠ WITHHELD UNLESS THE ANSWER IS AN EXPLICIT YES. Releasing an employer's email or phone IS
    // the consequence the "may we contact?" question governs, so `no` and UNANSWERED both withhold.
    // ⚠ WITHHELD UNLESS THE ANSWER ALLOWS CONTACT. "yes_if_required" DOES allow it — it permits
    // contact when the process demands it, and an employer email/phone is the mechanism BY WHICH that
    // contact happens, so withholding the details would answer "yes" and then make it impossible.
    // "no" and UNANSWERED both still withhold.
    const mcA = atsMayContactCandidates(entry.may_contact);
    if (!mcA || mcA.answer === "no") {
      return { kind: "skip", source: "entry",
        detail: mcA && mcA.answer === "no"
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

  // ── A CONTACT OPT-IN ASKED AS A QUESTION IS STILL AN OPT-IN (operator's rule, 2026-08-18) ──────
  // The operator authorised ticking ACCEPT boxes (privacy notices) and explicitly NOT opt-ins — "it is not
  // an acceptance, and it would sign the operator up for mail they never asked for". That rule lived only
  // on the checkbox path, so the SAME question asked as a required Yes/No dropdown went to the AI, which
  // answered "Yes" and subscribed them to texts: live on SCS Engineers, "Do you consent to receive text
  // message communication during your application process?" → `ai-choice: Yes`. One policy, two widgets.
  // Answered "No" DETERMINISTICALLY — declining is the privacy-preserving direction, it is truthful (they
  // have not asked to be texted), and it costs the application nothing. Flagged, so a human who does want
  // texts can flip it in review.
  //
  // ⚠ NARROW ON PURPOSE, and the bail list is the load-bearing half. A "No" to the wrong consent question
  // SINKS the application: a background check, a drug test, a reference check and the privacy notice
  // itself are all things an applicant must agree to for the process to continue, and none of them is a
  // marketing opt-in. So this fires only on CONTACT/MARKETING wordings and refuses anything that names a
  // check, a screening, or the data-processing notice.
  if (/\b(text message|text messages|sms|marketing|promotional|newsletter|job alerts?|talent (community|network)|future (job|role|opportunit))/i.test(L)
      && /\b(consent|opt[- ]?in|agree|receive|subscribe|join|sign me up|would you like)\b/i.test(L)
      && !/(background|drug|reference|credit|criminal|e-?verify|screening|privacy (notice|policy|statement)|data protection|processing of your|terms)/i.test(L)) {
    return { candidates: ["No", "False"], source: "optin-declined", review: true, flag: "optin-declined",
      detail: "this asks whether you want to be CONTACTED (texts/marketing), which is an opt-in rather than something the application needs — answered \"No\" because you have not asked to be contacted that way; flip it here if you want it" };
  }

  // ── SECURITY CLEARANCE — STATED OR NOT ANSWERED (operator, 2026-08-18) ─────────────────────
  // A clearance is a FACTUAL claim about the applicant, and claiming one you do not hold is a serious
  // matter — so this rung answers ONLY from `work_authorization.security_clearance` and refuses in
  // every other case. Two deliberate asymmetries:
  //   • it CLAIMS the question even when the profile is empty (`clearance-unstated` → review, blank).
  //     That is the whole point of claiming it: an unanswered REQUIRED clearance question would
  //     otherwise reach the AI rescue, which answers by reasoning from absence — and "No" invented for
  //     someone who holds TS/SCI, or worse a "Yes" invented for someone who holds nothing, is exactly
  //     the confident-wrong-value class the ladder exists to prevent. Recognition is what keeps the AI
  //     away from it, so being unable to answer is not a reason to let go of the question.
  //   • EMPTY ≠ "None". Empty means the operator has not told us; "None" is a stated fact and answers a
  //     yes/no with No.
  // ⚠ BAILS on a WILLINGNESS / ELIGIBILITY wording ("are you willing to obtain", "eligible to obtain",
  // "can you be sponsored for a clearance"). Those ask about the FUTURE, and answering them from a
  // currently-held level is wrong in both directions — a cleared applicant is not necessarily willing,
  // and an uncleared one is not necessarily unwilling. Same discipline as the export-control bail above.
  // ⚠ THE JUDGEMENT LIVES IN lib.js, NOT HERE. The WORKDAY driver needs the identical one, and a second
  // copy in this file could drift from the one the operator authorised — so the wording recognizer, the
  // future-tense bail and the candidate ladder are all `atsLib.*`, shared with fill-driver's rung.
  if (atsLib.recognizeClearanceQuestion(L)) {
    const cl = atsLib.clearanceCandidates(wa.security_clearance);
    if (cl.unstated) {
      return { kind: "clearance-unstated", review: true, flag: "clearance-unstated",
        detail: "this form asks about a security clearance and your profile does not state one — set it on the Profile page (\"None\" is a valid answer) rather than having it guessed" };
    }
    return { candidates: cl.candidates, source: "clearance", path: "work_authorization.security_clearance",
      detail: "work_authorization.security_clearance = " + JSON.stringify(cl.level) };
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

  // RELOCATION — STATED only, and the two facts are kept apart (see recognizeRelocationQuestion).
  // Live 2026-08-18: a required relocation dropdown on Sargent & Lundy was answered by the AI from
  // the very profile field nothing read. An unstated preference still falls through — the operator
  // not having answered is not a "No".
  {
    const rq = atsLib.recognizeRelocationQuestion(label);
    if (rq) {
      const rc = atsLib.relocationCandidates(profile && profile.screening, rq.kind);
      if (rc.candidates) return { candidates: rc.candidates, source: "relocation", path: rc.path, detail: rc.path };
      return null;
    }
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
  // ⚠⚠ THE QUESTION CAN BE IN THE OPTIONS RATHER THAN THE LABEL, and on a US EEO form the two
  // demographics that get confused this way are the two that must never be swapped. Live on Oracle:
  //
  //     label "Ethnicity"  ·  single checkbox  ·  option "I am Hispanic or Latino."
  //
  // "Ethnicity" carries no hispanic/latino token, so it fell past this rung into the race one and was
  // answered from `race_ethnicity` ("Asian") — a demographic answered from a DIFFERENT demographic
  // field. It could not commit (the form offers no such option), so it reached review rather than
  // submitting something false; but the next tenant to word it as a yes/no dropdown would have taken
  // the wrong value silently.
  //
  // The US EEO standard asks TWO questions — "are you Hispanic or Latino?" then "what race?" — and
  // the profile models them as two fields precisely so each is answered from its own. Reading the
  // OPTIONS is what tells them apart when the label will not: an option naming Hispanic/Latino IS the
  // Hispanic/Latino question, whatever the heading above it says. Evidence, not inference.
  // ⚠⚠ AND "AN OPTION MENTIONS HISPANIC" IS NOT THE TEST — a regression test caught that within
  // minutes. EEO-1 race categories are routinely SUFFIXED with the phrase as a negation:
  //     ["Asian (Not Hispanic or Latino)", "White (Not Hispanic or Latino)", "Decline to self identify"]
  // so both "any option mentions it" and "every option mentions it" misroute a RACE question to the
  // Hispanic field. The discriminator is whether the options offer OTHER RACES as alternatives: a
  // list of races qualified by ethnicity is a race question; a list that only ever talks about
  // Hispanic identity is the ethnicity question.
  const opts = ((f && f.options) || []).map(String);
  const RACE_TOKEN = /\basian\b|\bwhite\b|\bblack\b|african|american indian|alaska|hawaiian|pacific islander|two or more races|caucasian/i;
  const optsAreOnlyHispanic = opts.length > 0
    && opts.every((o) => /hispanic|latino/i.test(o))
    && !opts.some((o) => RACE_TOKEN.test(o));
  if (/hispanic|latino/i.test(L) || optsAreOnlyHispanic) {
    if (has(si.hispanic_or_latino)) return { candidates: [si.hispanic_or_latino], source: "eeo", containment: true, path: "self_identification.hispanic_or_latino" };
    return { eeoUnstated: true };
  }
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
  // ⚠ WHAT A <select> ACTUALLY HOLDS — and index 0 is NOT "unselected". A select need not carry a
  // placeholder row: iCIMS' salary currency starts straight at "USD $" and its timeframe at "Hr.", so a
  // `selectedIndex > 0` test read a legitimately-chosen FIRST option as blank. Live 2026-08-17 that made
  // a rehearsal report `native select commit failed` on two fields whose values were on the form the
  // whole time — a false negative on a verify gate, which blocks a submit that should pass.
  // "Unselected" is: nothing selected, or the selected row is a PLACEHOLDER (same vocabulary the option
  // filter below uses). LOCKSTEP with atsInjReadValue's dropdown_native branch — two injected functions
  // cannot share code, so a test pins them together.
  const selectedTextOf = (el) => {
    if (!el || el.selectedIndex < 0) return null;
    const t = txt(el.options[el.selectedIndex]);
    return (!t || /^(select|choose|—\s*make a selection)/i.test(t)) ? null : t;
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
      if (el.tagName === "SELECT") { push({ fieldName: nm, inputSel: 'select[name="' + esc(nm) + '"]', widgetType: "dropdown_native", label, isRequired: required, value: selectedTextOf(el), options: [...el.options].map((o) => txt(o)).filter((t) => t && !/^select/i.test(t)) }); continue; }
      push({ fieldName: nm, inputSel: el.id ? "#" + esc(el.id) : (el.tagName === "TEXTAREA" ? "textarea" : "input") + '[name="' + esc(nm) + '"]',
        widgetType: el.tagName === "TEXTAREA" ? "textarea" : (nm === "location" ? "location" : "text"),
        label, isRequired: required, value: el.value || null });
    }
    return out;
  }

  // ── ORACLE RECRUITING CLOUD (Oracle JET SPA + Knockout on native inputs; observed 2026-08-19) ──
  // Structure: <apply-flow-section> → <apply-flow-block> (+ <apply-flow-block-title>) →
  // <form-builder> → div.input-row.input-row--<kind>. The row CLASS declares the widget, so
  // classification here is a read rather than an inference — the opposite of every earlier platform.
  //
  // ⚠ SCOPED TO EVERY *VISIBLE* SECTION, and each half of that is a measured correction:
  //   • not the whole document — all sections of all steps are mounted at once, and the inactive ones
  //     report `hidden`=false, `aria-hidden`="false", `display`=block. Only the RECT distinguishes
  //     them, so a document-wide scan returns every step's fields as if they were one page.
  //   • not "the single visible section" and not the URL's number either — Baylor served 5 sections
  //     for 4 steps (index 0 an empty shell) while Oracle serves 4 for 3, and on Oracle TWO are
  //     visible at once (index 0 is the résumé-import banner, index 1 the real step-1 content).
  // So: every section with a non-zero rect, and no arithmetic on indexes.
  if (ats === "oracle") {
    const secs = [...document.querySelectorAll("apply-flow-section")].filter(vis);
    if (!secs.length) return out;
    const stripStar = (s) => String(s || "").replace(/\s*[*✱]\s*$/, "").trim();
    const blockOf = (el) => {
      const b = el.closest("apply-flow-block");
      return b ? txt(b.querySelector("apply-flow-block-title")) : "";
    };
    // ⚠ A DECOY IS EXCLUDED BY DECLARED INTENT, NEVER BY GEOMETRY. ORC's gate ships a honeypot
    // measuring 179×38 / 200×38 with visibility:visible and a non-null offsetParent, so every
    // visibility test here passes it. Writing to one marks the application as a bot and NO read-back
    // notices, because the write succeeds. LOCKSTEP with atsDecoyKind (an injected fn cannot import).
    const isDecoy = (e) => {
      const nm = ((e.name || "") + " " + (e.getAttribute("aria-label") || "")).replace(/\s+/g, " ");
      if (/\bhoney[\s_-]?pot\b/i.test(nm)) return true;
      return e.getAttribute("aria-hidden") === "true" && e.getAttribute("tabindex") === "-1";
    };
    const reqOf = (el, rawLabel) => el.required === true || el.getAttribute("aria-required") === "true"
      || /[*✱]\s*$/.test(String(rawLabel || ""))
      || !!(el.id && (document.querySelector('label[for="' + esc(el.id) + '"]') || {}).classList
            && document.querySelector('label[for="' + esc(el.id) + '"]').classList.contains("input-row__label--required"));

    for (const sec of secs) {
      // 1) OPTION GROUPS first, so their member boxes are never also emitted as standalone fields.
      //    The group is the ROW (div.input-row--radiogroup) — NOT a shared `name`, which the
      //    checkbox-rendered variant does not even have (measured `name: null` on race + ethnicity).
      //    ⚠ The QUESTION is the row's own label, which is the one WITHOUT a `for` attribute; each
      //    member's `label[for=<id>]` is its OPTION text. Using a member's label as the field label
      //    would file every option as its own required question — the Gusto 12-phantom-field failure.
      //    ⚠ `--radiogroup` does NOT imply pick-one: this tenant's race group asks "Select the races
      //    you identify with." So ARITY comes from the input TYPE, never from the class name.
      for (const row of sec.querySelectorAll("div.input-row--radiogroup")) {
        const boxes = [...row.querySelectorAll('input[type="radio"], input[type="checkbox"]')].filter((e) => !isDecoy(e));
        if (!boxes.length) continue;
        const qEl = row.querySelector("form-element-label") || [...row.querySelectorAll("label")].find((l) => !l.getAttribute("for"));
        const rawQ = txt(qEl);
        const optOf = (b) => (b.id ? txt(document.querySelector('label[for="' + esc(b.id) + '"]')) : "") || b.value || "";
        const isRadio = String(boxes[0].type).toLowerCase() === "radio";
        // A shared `name` exists only on the radio variant; fall back to the group's question so a
        // nameless checkbox group still has a stable key.
        // ⚠ The group separator "; " is inlined — a LOCKSTEP dup of lib.js's GROUP_JOIN, because an
        // injected fn cannot import, and the replay splits a multi-answer value on exactly this
        // vocabulary. Change one, change both.
        // (The helper name is deliberately not written here: the self-containment test greps this
        //  function's SOURCE for shim references, and a comment would trip it.)
        const key = boxes[0].name || ("group:" + String(rawQ).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48));
        if (seen.has(key)) continue; seen.add(key);
        push({ fieldName: key, inputSel: boxes.map((b) => "#" + esc(b.id)).join(", "),
          // ⚠⚠ A ONE-BOX GROUP IS STILL A GROUP (operator, 2026-08-20). Typing it `checkbox` made the
          // review editor render a bare boolean and DROP the options, so the Hispanic/Latino question
          // reached the operator as `Ethnicity — Unchecked`: the group's question with an opaque
          // state word, and no sign of what was being declined. The distinction that matters is
          // structural, not arity — in a `--radiogroup` row the QUESTION and the OPTION TEXT are
          // different elements ("Ethnicity" vs "I am Hispanic or Latino"), so collapsing to a boolean
          // always loses the half that carries the meaning. A genuine standalone checkbox (branch 3,
          // `div.input-row--checkbox`, e.g. a terms box) keeps `checkbox`, because there the label IS
          // the meaning and a boolean says everything.
          widgetType: isRadio ? "radio" : "checkbox_group",
          label: stripStar(rawQ) || key, isRequired: boxes.some((b) => reqOf(b, rawQ)),
          value: boxes.filter((b) => b.checked).map(optOf).join("; ") || null,
          options: boxes.map(optOf).filter(Boolean),
          optionSels: boxes.map((b) => "#" + esc(b.id)),
          group: isRadio ? "radio" : "checkbox", section: blockOf(boxes[0]) });
      }

      // 2) DATE COMPOSITES. Parts share ONE `name` and are told apart only by an id prefix
      //    (`month-startDate-34` / `year-startDate-34`), so a name identifies the PAIR, not a
      //    control. ⚠ ARITY VARIES: the timeline's dates are month+year, while this tenant's
      //    `earliestAvailableDate` is month+DAY+year — so the parts are discovered, never assumed,
      //    and a required day here means the profile's month precision is not always sufficient.
      for (const row of sec.querySelectorAll("div.datepicker-row")) {
        const parts = [...row.querySelectorAll("input")].filter((e) => !isDecoy(e));
        if (!parts.length) continue;
        const nm = parts[0].name || "";
        if (!nm || seen.has("date:" + nm)) continue; seen.add("date:" + nm);
        const order = [];
        const bySel = {};
        for (const p of parts) {
          const m = /^(month|day|year)-/.exec(p.id || "");
          if (m) { order.push(m[1]); bySel[m[1]] = "#" + esc(p.id); }
        }
        const rawLabel = txt(row.querySelector("form-element-label")) || txt([...row.querySelectorAll("label")].find((l) => !l.getAttribute("for")));
        push({ fieldName: nm, inputSel: Object.values(bySel).join(", "), widgetType: "date",
          label: stripStar(rawLabel) || nm, isRequired: parts.some((p) => reqOf(p, rawLabel)),
          value: parts.map((p) => p.value).filter(Boolean).join("/") || null,
          dateParts: order, datePartSels: bySel, section: blockOf(parts[0]) });
      }

      // 3) LONE CHECKBOX ROWS. ORC files a standalone checkbox in `div.input-row--checkbox` rather
      //    than a radiogroup, so it needs its own pass — the general loop below deliberately skips
      //    every radio and checkbox (see the note there), and without this they would be lost.
      //    ⚠ VISIBLE ONLY: this tenant ships pre-checked, hidden communication-preference flags
      //    (`af-checkbox-emailPreferredFlag`, `…phonePreferredFlag`). They are not questions being
      //    asked, so surfacing them would add review noise and invite us to toggle a contact
      //    preference nobody chose.
      for (const row of sec.querySelectorAll("div.input-row--checkbox")) {
        const box = [...row.querySelectorAll('input[type="checkbox"]')].filter((e) => !isDecoy(e) && vis(e))[0];
        if (!box) continue;
        const key = box.name || box.id;
        if (!key || seen.has(key)) continue; seen.add(key);
        const rawLabel = (box.id ? txt(document.querySelector('label[for="' + esc(box.id) + '"]')) : "")
          || txt(row.querySelector("form-element-label")) || box.getAttribute("aria-label") || "";
        push({ fieldName: key, inputSel: "#" + esc(box.id), widgetType: "checkbox",
          label: stripStar(rawLabel) || key, isRequired: reqOf(box, rawLabel),
          value: box.checked ? "true" : null, section: blockOf(box) });
      }

      // 3b) ⚠⚠ ORC'S YES/NO QUESTIONS ARE A PAIR OF **BUTTONS**, NOT A CONTROL (live 2026-08-20).
      // The operator reported three REQUIRED yes/no questions on step 3 that no run ever filled. They
      // were there the whole time, and every sweep this file owns was blind to them at once:
      //   • `input, select, textarea` finds nothing — there is no form control of any kind;
      //   • the ARIA sweep finds nothing — the roles are `list` / `listitem`, not radio/radiogroup;
      //   • the block-population settle read 0 "inputs" and spent 15s deciding the block was still
      //     loading, then said so — while the block sat there VISIBLE at 680×331 with all three
      //     questions rendered.
      // The widget is `ul.cx-select-pills-container` → `li` → `button.cx-select-pill-section`, with
      // **`aria-pressed`** as the selected state. So "count the controls" was never the right
      // question; the right one is "what can be answered here".
      //
      // ⚠ AND THE ROW CLASS IS `input-row--has-picker` — THE SAME AS A COMBOBOX. That is why this
      // must be its own pass rather than a branch in the loop below: the classifier would call it a
      // picker, look for `input[role=combobox]` inside, find none, and drop the field silently.
      //
      // ⚠ IDENTITY: there is no id and no name anywhere on the widget. The row's own
      // `<label for="302960759052341-13">` points at an id that DOES NOT EXIST as an element, but it
      // names the per-tenant flexfield — so the durable key is that id with the volatile render
      // counter stripped, exactly the rule every other ORC field follows (`lastName-21` → lastName).
      // The FULL id is used only for the live selector, which is what an id is for here.
      for (const ul of sec.querySelectorAll("ul.cx-select-pills-container")) {
        if (!vis(ul)) continue;
        const row = ul.closest("div.input-row");
        if (!row) continue;
        const forId = (row.querySelector("label[for]") || {}).getAttribute
          ? row.querySelector("label[for]").getAttribute("for") : null;
        if (!forId) continue;
        const key = String(forId).replace(/-\d+$/, "");
        if (!key || seen.has(key)) continue; seen.add(key);
        // The ul's OWN aria-label carries the whole question, untruncated and without the required
        // star — cleaner than the label element, whose text is the same string plus decoration.
        const rawLabel = ul.getAttribute("aria-label") || txt(row.querySelector("form-element-label")) || "";
        const btns = [...ul.querySelectorAll("li button")];
        if (!btns.length) continue;
        const picked = btns.find((b) => b.getAttribute("aria-pressed") === "true");
        // ⚠ REQUIRED IS ON THE **LABEL** CLASS, not the row's. A first probe looked at the row and
        // concluded these were optional — which would have been the worst possible outcome, because
        // the AI rescue is gated on `isRequired` and an optional unmapped field is deliberately left
        // blank. They would have stayed unfilled AND unexplained.
        const lblEl2 = row.querySelector("label.input-row__label");
        const isReq = !!(lblEl2 && /input-row__label--required/.test(String(lblEl2.className || "")))
          || !!row.querySelector(".input-row__label--required-star")
          || /[*✱]\s*$/.test(String(rawLabel || ""));
        push({ fieldName: key,
          inputSel: 'div.input-row:has(label[for="' + esc(forId) + '"]) ul.cx-select-pills-container',
          widgetType: "yesno", label: stripStar(rawLabel) || key, isRequired: isReq,
          value: picked ? txt(picked) : null,
          options: btns.map((b) => txt(b)).filter(Boolean), section: blockOf(ul) });
      }

      // 4) EVERYTHING ELSE, one control at a time.
      // ⚠ RADIO AND CHECKBOX ARE SKIPPED HERE ON PURPOSE — the grouping passes above own them.
      // Classifying a grouped box here would push it a SECOND time as a plain field keyed on its own
      // id, which on Greenhouse turned one 12-option question into 12 phantom REQUIRED text fields,
      // each buying its own LLM call. Structurally enforced by a test that reads this very line.
      for (const el of sec.querySelectorAll("input, textarea, select")) {
        if (el.type === "hidden" || el.type === "radio" || el.type === "checkbox" || isDecoy(el)) continue;
        if (el.closest("div.input-row--radiogroup") || el.closest("div.datepicker-row")) continue; // handled above
        // ⚠ EVERY TEXTAREA ROW SHIPS A CLONE with an empty id AND empty name (an autosize mirror).
        // Pushing it creates a phantom free-text field — the shape that becomes required and buys an
        // LLM call. The named one is the real control.
        const isFile = el.type === "file";
        // ⚠ THE ANONYMOUS-BUT-REAL CONTROLS MUST SURVIVE THIS GUARD. It exists to drop the textarea
        // CLONE (empty id AND empty name — an autosize mirror), but ORC's actual phone-number input
        // is also id-less and name-less, and it is REQUIRED. Caught by running this scan against the
        // live form: the field silently vanished, which would leave the form uncompletable while the
        // bundle looked clean. `type=tel` is therefore admitted here and keyed synthetically below.
        const isAnonReal = !el.id && !el.name && el.type === "tel";
        if (!el.id && !el.name && !isFile && !isAnonReal) continue;
        if (!isFile && !vis(el)) continue; // file inputs are styled invisible by design

        const lblEl = el.id ? document.querySelector('label[for="' + esc(el.id) + '"]') : null;
        const rawLabel = txt(lblEl) || el.getAttribute("aria-label") || "";
        const row = el.closest("div.input-row");
        const rowCls = String((row && row.className) || "");
        let widgetType, key = el.name || el.id, searchDriven = false;

        if (isFile) {
          // ⚠ THREE FILE INPUTS SHARE `name="attachment-upload"`, told apart ONLY by their wrapper
          // (<resume-upload-button> / <cover-letter-upload-button> / <attachment-upload-button>). So
          // `name` is NOT unique on an ORC form and the wrapper is the discriminator; the label
          // agrees, which is a useful redundancy rather than the primary signal.
          let wrap = null;
          for (let p = el.parentElement; p && !wrap; p = p.parentElement) {
            const n = p.tagName.toLowerCase();
            if (/^(resume|cover-letter|attachment)-upload-button$/.test(n) || n === "referral-resume-block") wrap = n;
          }
          widgetType = "file_upload";
          key = wrap ? wrap.replace(/-button$/, "") : (el.id || "attachment-upload");
        } else if (el.tagName === "SELECT") {
          widgetType = "dropdown_native";
        } else if (el.getAttribute("role") === "combobox" || /input-row--has-picker/.test(rowCls)) {
          // ⚠ IS THIS PICKER ENUMERABLE? Declared by the row, not inferred: a geo picker carries
          // `geo-hierarchy-form-element` and is BOTH dependent on a parent and effectively unbounded
          // (cities, postal codes), so an empty open cannot produce the operator's answer — the same
          // reason Workday's option capture skips SKILLS. Everything else is a fixed vocabulary that
          // an empty open returns WHOLE (measured: country = 251 rows, Afghanistan→Zimbabwe, so ORC
          // does not paginate and needs no page-cap derivation the way iCIMS did).
          searchDriven = /geo-hierarchy-form-element/.test(rowCls);
          // ORC's own picker. Options are NOT read here: the listbox is created on demand and holds
          // `div[role="row"]` rows inside a `div[role="grid"]` — a `[role=option]` scrape finds
          // NOTHING — so reading them at scan time would mean opening every dropdown on the page.
          widgetType = "select";
        } else if (el.tagName === "TEXTAREA" || /input-row--textarea/.test(rowCls)) {
          widgetType = "textarea";
        } else if (el.type === "checkbox") {
          widgetType = "checkbox";
        } else {
          widgetType = "text";
        }

        // The phone composite: `name="phoneNumber"` is the DIAL-CODE picker, and the control that
        // wants the number has NO id and NO name at all. Give it a synthetic key so it is
        // addressable and can never collide with the picker's.
        if (!el.name && !el.id && el.type === "tel") { key = "phoneNumber--number"; widgetType = "text"; }

        if (!key || seen.has(key)) continue; seen.add(key);
        // ⚠ THE SELECTOR MUST BE THE FIELD'S OWN, and `.phone-row__input` is NOT a general fallback.
        // Caught by running this scan through the extension: ORC's résumé-IMPORT input has no id and
        // no name, so it inherited the phone fallback and came back as
        // `{fieldName:"attachment-upload", inputSel:".phone-row__input"}` — an attach would have
        // written a file into the PHONE box. A fallback that is right for one field and silently
        // wrong for every other is worse than no fallback.
        let sel = el.id ? "#" + esc(el.id) : (el.name ? '[name="' + esc(el.name) + '"]' : null);
        if (!sel && key === "phoneNumber--number") sel = ".phone-row__input";
        if (!sel && isFile) {
          // A file input is addressable through the wrapper that identifies it, when there is one.
          for (let p = el.parentElement; p && !sel; p = p.parentElement) {
            const n = p.tagName.toLowerCase();
            if (/^(resume|cover-letter|attachment)-upload-button$/.test(n)) sel = n + ' input[type="file"]';
          }
        }
        // ⚠ NO SELECTOR ⇒ NOT EMITTED. An unaddressable field cannot be actuated OR verified, so
        // emitting it would put a record in the bundle that no later pass can act on. ORC's
        // résumé-import banner is exactly this, and skipping it is also what the operator asked for:
        // that control is the résumé AUTOFILL, which must not run before the deterministic fill.
        if (!sel) continue;
        push({ fieldName: key, inputSel: sel,
          widgetType, label: stripStar(rawLabel) || key, isRequired: reqOf(el, rawLabel),
          value: (el.type === "checkbox" ? (el.checked ? "true" : null) : (el.value || null)),
          searchDriven: searchDriven || undefined,
          section: blockOf(el) });
      }
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
    // ── ONE QUESTION, SEVERAL CONTROLS — detected, not enumerated ────────────────────────
    // "What are your salary requirements? (Currency / Amount / Time Frame)" is ONE question that
    // iCIMS renders as three controls, and so is "End Date (Month / Day / Year)". Traced 2026-08-17:
    //
    //   DIV.iCIMS_FieldRow                    ← the QUESTION; its label is the question text
    //    └ DIV.iCIMS_TableCell
    //       └ DIV.iCIMS_Table
    //          └ DIV.iCIMS_TableRow           ← the PARTS
    //             ├ …Salary_Currency   label "Currency"
    //             ├ …Salary            label "Amount (Numbers only)"
    //             └ …Salary_Timeframe  label "Time Frame"
    //
    // ⚠ `iCIMS_FieldRow` IS THE DISCRIMINATOR, and using it is what keeps this free of hardcoding
    // (operator's standing ask): no list of composite field names, no suffix vocabulary
    // (_Currency/_Month/_Year), no per-tenant table. The page says "these controls answer one
    // question" and we read that. Any composite iCIMS invents is covered for free, and the inner
    // `.iCIMS_TableRow` alone is NOT enough — it also matches the outer field row, which is exactly
    // why the question and its parts have to be told apart by the FieldRow class.
    // ⚠ MATCH THE FieldRow FAMILY, not one class. A date question wraps its parts in
    // `iCIMS_FieldRow_Inline` — a DIFFERENT class token, which `.iCIMS_FieldRow` does not match, so
    // "End Date (Month / Day / Year)" stayed three separate rows while Salary grouped correctly
    // (traced 2026-08-17: `DIV.rcf3211-1 iCIMS_TableRow iCIMS_FieldRow_Inline`, label "End Date").
    // A prefix match covers the whole family, including variants no tenant has shown us yet, which is
    // the point — enumerating `_Inline` would just be the same mistake one class later.
    const questionRowOf = (el) => el.closest('[class*="iCIMS_FieldRow"]') || null;
    const questionTextOf = (el) => {
      const qr = questionRowOf(el);
      if (!qr) return null;
      // The FIRST label in the question row is the question; the parts' own labels come after it,
      // inside the nested table.
      const l = qr.querySelector("label, .iCIMS_FormLabel, legend");
      const t = l ? stripReq(txt(l)) : null;
      return t || null;
    };
    // ⚠ GROUP BY THE INNERMOST PARTS ROW, take only the question TEXT from the FieldRow. A composite's
    // controls always share ONE `.iCIMS_TableRow`; a FieldRow may legitimately hold several distinct
    // questions, and keying the group on it would merge them into one row on the review page. Using
    // the nearest row is both tighter and immune to that — and `closest` picks the inner row even
    // though the FieldRow also carries `iCIMS_TableRow`, because it walks outward and stops first.
    const partsRowOf = (el) => el.closest(".iCIMS_TableRow") || null;
    const qrKeys = new Map();
    const questionKeyOf = (el) => {
      const pr = partsRowOf(el);
      if (!pr) return null;
      if (!qrKeys.has(pr)) qrKeys.set(pr, "q" + qrKeys.size);
      return qrKeys.get(pr);
    };
    // ⚠ COUNT ONLY WHAT THE LOOP BELOW WILL ACTUALLY EMIT. Counting every control in the row marked
    // single-question rows as composites whenever the row also held a radio or checkbox — which this
    // loop skips (they are handled by the grouping pass) — so "Time Zone" and the SMS-consent
    // dropdown arrived flagged as composites with one part each.
    const emittable = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=radio]):not([type=checkbox]), select, textarea';
    // ⚠ AND ONLY THE VISIBLE ONES. An `icims_dropdown` keeps its own `input.dropdown-search` inside
    // the same field row, hidden until the widget is opened — so a plain one-question row counted TWO
    // controls and was mis-marked a composite ("Time Zone", the SMS-consent question). The loop below
    // already skips invisible controls; the count has to agree with it or the two disagree about what
    // a question contains.
    const controlsInQuestion = (el) => {
      const pr = partsRowOf(el);
      if (!pr) return 1;
      return [...pr.querySelectorAll(emittable)].filter(vis).length;
    };
    // The container that holds THIS control and no other — its own cell within the question. Found by
    // walking outward while the ancestor still contains exactly one emittable control, which needs no
    // class names at all and so survives any markup iCIMS uses. That cell's label is the part's name
    // ("Currency", "Month"): those labels are SIBLINGS of the control, not `label[for=…]` and not
    // ancestors, which is why labelFor found nothing and every part inherited the question text.
    const partLabelOf = (el) => {
      let cell = el;
      for (let i = 0; i < 5; i++) {
        const up = cell.parentElement;
        if (!up || up.querySelectorAll(emittable).length !== 1) break;
        cell = up;
      }
      const l = cell.querySelector("label, .iCIMS_FormLabel, legend");
      if (l) { const t = stripReq(txt(l)); if (t) return t; }
      // No label element — take the cell's own text, minus anything the control itself renders (a
      // <select>'s option list would otherwise come back as the "label").
      const own = [...cell.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ");
      const t = stripReq(String(own || "").replace(/\s+/g, " ").trim());
      return t || null;
    };

    for (const el of document.querySelectorAll("input, textarea, select")) {
      if (el.type === "hidden" || el.type === "radio" || el.type === "checkbox") continue;
      // ⚠ A BUTTON IS NOT A FIELD. `<input type="submit" id="cp_form_submit_i">` was being scanned as
      // a text field, so "cp_form_submit_i" appeared in review as a question with a raw id for a label
      // (operator, 2026-08-17) — and, worse, it was a writable target: atsInjSetText on a submit input
      // rewrites its caption. Detected by the element's own type, so it needs no per-tenant id.
      if (/^(submit|button|reset|image)$/.test(String(el.type || ""))) continue;
      const id = el.id || el.name || ""; if (!id || seen.has(id)) continue;
      // file inputs are styled invisible on this theme (the visible control is a sibling button row)
      if (el.type !== "file" && !vis(el)) continue;
      seen.add(id);
      const sel = el.id ? "#" + esc(el.id) : el.tagName.toLowerCase() + '[name="' + esc(el.name) + '"]';
      // ⚠ NEVER FALL BACK TO THE RAW ID FOR A LABEL. `labelFor` only knows `label[for=…]` and an
      // ancestor <label>, and an iCIMS composite part has neither — so review showed
      // "CandProfileFields.Salary_Currency" AS THE QUESTION (operator, 2026-08-17). Three sources
      // now, in order of how well they describe the field to a human:
      //   own label  → the part's name inside the question ("Currency", "Month")
      //   question   → the FieldRow's label ("What are your salary requirements?")
      //   the id     → last resort, and now visibly a last resort rather than the norm
      const question = questionTextOf(el);
      const parts = controlsInQuestion(el);
      // For a composite the part's name comes from its own cell (partLabelOf); for a lone control the
      // ordinary label association is right, and cheaper.
      const own = parts > 1 ? (partLabelOf(el) || stripReq(labelFor(el) || "") || null)
        : (stripReq(labelFor(el) || "") || null);
      // A question rendered as SEVERAL controls needs both halves to read properly; a lone control
      // just takes whichever it has, because "Currency — Currency" is noise.
      const label = (parts > 1 && question && own && own !== question) ? question + " — " + own
        : (question || own || id);
      const base = { fieldName: id, inputSel: sel, label, isRequired: req(el), section: sectionOf(el),
        // Carried so review can GROUP the parts of one question instead of listing them as peers.
        questionKey: parts > 1 ? questionKeyOf(el) : null,
        questionLabel: parts > 1 ? question : null,
        partLabel: parts > 1 ? own : null };
      if (el.type === "file") { push(Object.assign(base, { widgetType: "file_upload", isRequired: req(el), value: (el.files && el.files[0] && el.files[0].name) || null })); continue; }
      if (el.tagName === "SELECT" && el.multiple) {
        // A native <select multiple> is a MULTI-answer control: committing it by selectedIndex (what
        // dropdown_native does) would answer one option and silently discard the rest.
        // ⚠ JOINED WITH "; " — the shared group separator (`GROUP_JOIN`, lib.js), NOT ", ".
        // A multi-select's selection reaches review the same way a checkbox GROUP's does: the joined
        // string is `current_value` and the array is `selected_options`, and the review editor ticks
        // its boxes by splitting the joined string on GROUP_JOIN. Joining with ", " here meant
        // `splitGroupValue` could not split it, so `"Internship, Part-time"` arrived as ONE unmatched
        // option and the editor rendered the question BLANK while the form plainly held both answers
        // (operator, live 2026-08-17). Hardcoded because an injected function cannot import — pinned
        // against GROUP_JOIN by test.
        push(Object.assign(base, { widgetType: "multiselect_native",
          values: [...el.selectedOptions].map((o) => txt(o)).filter(Boolean),
          value: [...el.selectedOptions].map((o) => txt(o)).join("; ") || null,
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
          // ⚠ DROP THE AWAITING-PARENT ROW TOO, not just the placeholder. A child whose parent is
          // unset renders exactly one row — "Please select a country" — and that is not an option:
          // left in, it is a one-item list, which reads as a COMPLETE vocabulary and would reach the
          // review editor as the single thing the operator may pick. The unset parent is explained
          // by the record's own detail (see awaitingParent); the option list must simply be empty.
          // …AND DROP THE WIDGET'S OWN "No Results" ROW, for exactly the reason above. It was missed
          // here while the ACTUATION reader (atsInjIcimsReadOptions) filtered it all along, so a field
          // whose list had been searched reached review offering ONE pickable option — "No Results"
          // (live 2026-08-18, Cretex's Degree). The operator would have selected a sentinel.
          // ⚠ LOCKSTEP with atsInjIcimsReadOptions' filter: two injected fns cannot share code.
          const items = ul ? [...ul.children].map((li) => txt(li))
            .filter((t) => t && !/^—\s*make a selection/i.test(t) && !/^please select a /i.test(t)
              && !/^no results/i.test(t)) : [];
          // ⚠ CAN THIS WIDGET BE SEARCHED AT ALL? It says so itself, and the answer changes what may be
          // done to it: `icimsdropdown-search="0"` means the list is LOCAL and COMPLETE, and the search
          // box present in the markup merely FILTERS the rendered rows. Typing into it therefore empties
          // the list rather than fetching more — which is exactly how Cretex's 9-option Degree list
          // ("High School Diploma/GED, AS, BS, MS, PhD, MBA, MCS, BCS, BA") was reported EMPTY, twice,
          // by us and then by the probe sent to check us (live 2026-08-18, operator's screen refuted it).
          const searchable = el.getAttribute("icimsdropdown-search") !== "0";
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
            // …EXCEPT when the widget itself says it cannot be searched. `icimsdropdown-search="0"` is a
            // LOCAL list: there is no second page to fetch, so what is rendered IS the vocabulary, and
            // calling it partial hands review a type-it-yourself box in place of a real picker.
            optionsPartial: searchable ? !!(ul && ul.getAttribute("data-ap-complete") !== "1") : false,
            // Whether the search box may be TYPED INTO. Carried because the box exists in the markup
            // either way, so its presence proves nothing — and typing into a search-less widget FILTERS
            // its rendered rows to nothing, which reads exactly like an empty list.
            searchable,
            // The parent→child dependency, DECLARED by the page: picking this field's value is what
            // populates the named child (Country → State/Province). Carried so the driver can order
            // them and explain an empty child honestly instead of guessing.
            childLink: el.getAttribute("data-ddd-child-link") || null,
          }));
          continue;
        }
        push(Object.assign(base, { widgetType: "dropdown_native",
          // Same "index 0 is not unselected" rule as atsInjReadValue — a select whose first row is a
          // REAL option (iCIMS' salary currency starts at "USD $") would otherwise scan as blank, so a
          // value already on the form is invisible to the fill and to the post-fill audit.
          value: selectedTextOf(el),
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

// Press an auth form's own submit control. Page-side on purpose: iCIMS is server-rendered jQuery,
// so `el.click()` on a real `<input type="submit">` runs the browser's native submit algorithm
// (onsubmit handlers included, which is what invisible hCaptcha hooks into). That is NOT the
// Workday case where a synthetic auth submit went inert — there the failure was React never seeing
// a native-setter value, and iCIMS has no controlled-component layer to miss it. The caller still
// proves the page moved afterwards rather than trusting the click.
function atsInjClickAuthSubmit(sel) {
  const btn = (sel ? document.querySelector(sel) : null)
    || document.querySelector('input[type="submit"], button[type="submit"]');
  if (!btn) return { ok: false, error: "no-submit-control" };
  if (btn.disabled || btn.getAttribute("aria-disabled") === "true") return { ok: false, error: "submit-disabled" };
  btn.click();
  return { ok: true, caption: String(btn.value || btn.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40) };
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

// WHICH URL IS THE iCIMS CONTENT FRAME? Read from the TOP document, where the <iframe> element lives,
// so the answer is the tenant's own markup rather than a guess about the frame tree. This is what lets
// a frame be pinned BEFORE it holds any form control (an `<tenant>.icims.com` posting page: job
// description + one Apply anchor, zero inputs) without risking a pin on an unrelated iframe — see
// cdpUseFormFrame's identity rule.
function atsInjIcimsFrameSrc() {
  const fr = document.getElementById("icims_content_iframe") ||
    document.querySelector('iframe[id*="icims"], iframe[name*="icims"]');
  if (!fr) return { ok: false };
  // `.src` is the attribute as written; the frame's LIVE url can differ once it navigates (a postback,
  // an Apply click), so both are reported and the caller matches on whichever it can.
  return { ok: true, src: fr.src || null, id: fr.id || fr.name || null };
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
  // `values` is the AUTHORITATIVE array; `value` is the joined display string, and it joins on the
  // shared group separator "; " (GROUP_JOIN, lib.js) so the review editor can split it back into
  // ticked options. See the scan's multiselect branch for what joining on ", " cost.
  if (widgetType === "multiselect_native") {
    const picked = [...el.selectedOptions].map(txt).filter(Boolean);
    return { ok: true, values: picked, value: picked.join("; ") || null };
  }
  // ⚠ INDEX 0 IS NOT "UNSELECTED" — a select need not have a placeholder. This read used
  // `selectedIndex > 0`, so on iCIMS' salary selects (raw options start at "USD $" and "Hr." with NO
  // blank first row) choosing the FIRST option read back as null, and a rehearsal reported `native
  // select commit failed` on two fields whose values were sitting on the form the whole time
  // (measured 2026-08-17: selectedIndex 0, value "USD $"). A FALSE NEGATIVE on a verify gate blocks a
  // submit that should pass, which is why it is worth the extra care.
  // "Unselected" is: nothing selected at all, or the selected row is a PLACEHOLDER — the same
  // vocabulary the scan uses to filter placeholders out of its option list.
  if (widgetType === "dropdown_native") {
    if (el.selectedIndex < 0) return { ok: true, value: null };
    const t = txt(el.options[el.selectedIndex]);
    return { ok: true, value: (!t || /^(select|choose|—\s*make a selection)/i.test(t)) ? null : t };
  }
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
    // …and the same container fallback as atsInjClickYesNo, for the same reason. `aria-pressed` was
    // already the signal it reads, which is exactly what ORC's pills use.
    const entry = el.closest(".ashby-application-form-field-entry") || el;
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
  // ⚠ THE BUTTON CONTAINER IS THE ASHBY FIELD ENTRY **OR THE ELEMENT ITSELF**. Ashby hands this a
  // hidden checkbox whose sibling buttons live in an ancestor wrapper; ORC's pill widget IS the
  // container (`ul.cx-select-pills-container` holding the Yes/No buttons), so requiring the Ashby
  // wrapper made a perfectly answerable question `no-field-entry`. Falling back to the element keeps
  // Ashby byte-identical while making the primitive shape-agnostic — which is the whole reason ORC
  // needed no new commit path, no new review widget and no new AI kind: `yesno` already existed.
  const entry = cb.closest(".ashby-application-form-field-entry") || cb;
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

// Tick an ACCEPT checkbox the operator has authorised (atsConsentKind → "accept"), and prove it took.
// The LABEL is clicked in preference to the input: iCIMS is server-rendered jQuery whose handlers hang
// off the row, and native label activation flips `checked` AND fires the change event those handlers
// listen for — the same reason the Workday radio path clicks labels. Falls back to the input itself,
// then to a property write + change, so a tenant that hides its box behind CSS still commits.
// Returns only whether it ended CHECKED: a tick that did not take must never be reported as consent
// given, because the caller is about to say so in the log on the operator's behalf.
function atsInjTickConsent(sel) {
  const el = document.querySelector(sel);
  if (!el) return { ok: false, error: "not-found:" + sel };
  if (el.checked) return { ok: true, checked: true, already: true };
  // Read the escaper OFF window, matching the guard. The sibling readers here write `window.CSS &&
  // CSS.escape`, which works in a page (bare `CSS` resolves on the global) but throws the moment the
  // global is anything other than a real window — including under a unit test, which is how a tick
  // primitive doing something legally meaningful would otherwise go unpinned.
  const esc = (s) => (window.CSS && window.CSS.escape ? window.CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"));
  const label = el.id ? document.querySelector('label[for="' + esc(el.id) + '"]') : (el.closest("label") || null);
  try { if (label) label.click(); } catch (e) { /* fall through */ }
  if (!el.checked) { try { el.click(); } catch (e) { /* fall through */ } }
  if (!el.checked) {
    try {
      el.checked = true;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }
  return { ok: !!el.checked, checked: !!el.checked };
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
  // ⚠ ORACLE'S STEP PAGES HAVE **NEXT**, NOT SUBMIT — Submit appears only on the last step. So the
  // generic finder returns nothing and atsLooksLikeApplicationForm rejected a perfectly good form as
  // "not an application form" (measured: a run reached …/apply/section/1 and stopped
  // `form-not-rendered`). Third instance of this exact lesson after Lever's #btn-submit and iCIMS'
  // <input type=submit>.
  //
  // ⚠⚠ REPORTED SEPARATELY, NOT FOLDED INTO `hasSubmit`, and that separation is the safety property:
  // `hasSubmit` is what the SUBMIT GATE clicks. Letting a "Next" satisfy it would mean a submit run
  // pressing Next — advancing a step while believing it had submitted the application. Recognition
  // and submission are different questions and get different fields.
  let flowNext = null;
  if (ats === "oracle") {
    const pag = document.querySelector("apply-flow-pagination") || document;
    flowNext = [...pag.querySelectorAll("button")].find((b) => /^(next|continue)\b/i.test((b.textContent || "").trim()) && vis(b)) || null;
  }
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
  return { ok: true, hasSubmit: !!btn, hasFlowControl: !!flowNext,
    flowCaption: flowNext ? (flowNext.textContent || "").replace(/\s+/g, " ").trim().slice(0, 30) : null,
    rect: r ? { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2), w: r.width } : null,
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
// ORC's picker search is server-backed and its own budget: the school/geo lookups answered in ~1.3-4s
// during recon, and a give-up that is too short reports "no option matched" on a field whose list was
// about to arrive — the exact failure iCIMS' 675ms settle produced. Separate from ATS_POLL because
// nothing else in that table describes a grid-of-rows widget.
var ATS_ORC_PICK_MS = 8000;

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
  // iCIMS says so in the URL, and it is the clearest signal any of these tenants gives: a dead job id
  // redirects to the tenant's OWN job-search page carrying `notFound=1` (measured 2026-08-18 — three of
  // four postings taken from a search index were already closed, every one answering this way). Checked
  // ahead of the id rule below because it names the cause instead of describing the symptom.
  if (/[?&]notfound=1(&|$)/i.test(String(landedUrl || ""))) return "the tenant's own search page answered notFound=1 for it";
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

// ── IS AN iCIMS DROPDOWN'S LIST COMPLETE, OR JUST THE FIRST PAGE? ────────────────────────
// The widget serves ONE page and offers a search box, so its rows may be a prefix of a longer
// list. Until now EVERY icims_dropdown was marked partial UNCONDITIONALLY: the flag read a
// `data-ap-complete` attribute that nothing in this codebase has ever written. And a partial list
// is attached as `captured_options` with widgetType "typeahead" — review renders a type-it-yourself
// box with an honest caveat instead of a picker. So a two-option "May We Contact" question reached
// the operator as FREE TEXT. Measured on the Astrion form: 14 of 25 dropdowns were provably
// complete and mislabelled, including all ten Yes/No screening questions and a 6-row Availability.
//
// The form reveals its own page size when you look at every dropdown at once: unrelated
// vocabularies do not stop at the same exact length by chance. Measured there — Time Zone, Country,
// State/Province and Degree all stop at exactly 25 while nothing else comes near it. That is a
// pager, not a coincidence. Derived rather than hardcoded because the cap is a tenant setting: a
// constant 25 would silently mislabel a tenant that pages at 50.
var ATS_ICIMS_CAP_MIN = 10; // below this a repeated length is a vocabulary, not a page size

function atsIcimsPageCap(lengths) {
  const counts = new Map();
  for (const n of lengths || []) {
    if (!Number.isFinite(n) || n < ATS_ICIMS_CAP_MIN) continue;
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  let cap = null;
  for (const [n, c] of counts) if (c >= 2 && (cap == null || n > cap)) cap = n;
  return cap;
}

// A pager that returned FEWER rows than a full page has reached its end — the same inference any
// paged API invites. With no cap proven the only safe claim is "nothing on this form is even
// page-sized, so truncation is not in play at all"; everything else stays UNPROVEN, which is
// exactly today's behaviour.
// ⚠ THE ASYMMETRY IS DELIBERATE. Calling a truncated list complete shows the operator a picker
// that is MISSING their answer — they conclude the form does not offer it. Calling a complete list
// partial merely costs them a typed value. So this errs toward under-claiming, every time.
function atsIcimsListComplete(n, cap, maxLen) {
  if (!Number.isFinite(n) || n <= 0) return false;
  if (cap != null) return n < cap;
  return Number.isFinite(maxLen) && maxLen > 0 && maxLen < ATS_ICIMS_CAP_MIN;
}

// THE choice-widget list, in ONE place. It was inlined identically at three call sites, which is
// exactly the trap CLAUDE.md already warns about for this vocabulary ("a new choice widget must be
// registered in FOUR places, and missing one fails silently and differently each time") — a
// copy-paste list makes the fourth miss inevitable.
var ATS_CHOICE_WIDGETS = ["select", "dial", "radio", "yesno", "checkbox_group", "dropdown_native",
  "location", "icims_dropdown", "multiselect_native"];

const ATS_REVIEW_WIDGET = { // scan widgetType → the review schema's widget_type vocabulary
  text: "text", textarea: "textarea", select: "dropdown", dial: "dropdown", location: "typeahead",
  dropdown_native: "dropdown", radio: "radio", checkbox: "checkbox", checkbox_group: "checkbox_group",
  yesno: "radio", file_upload: "file_upload", date: "date", unknown: "unknown",
  icims_dropdown: "dropdown", multiselect_native: "checkbox_group",
};

// The same set of widgets under their REVIEW-side names. A record's `widgetType` is rewritten to
// this vocabulary the moment it is built (`ATS_REVIEW_WIDGET[f.widgetType]`), so anything looking at
// a RESULT must match on these, not on the scan's names — checking the scan vocabulary against a
// built record silently matches almost nothing. DERIVED from the two tables above rather than
// written out a third time, so a new choice widget cannot be missed here. `typeahead` is added
// explicitly because `atsAttachOptions` rewrites a partial-list record to it.
var ATS_CHOICE_REVIEW_WIDGETS = [...new Set(
  ATS_CHOICE_WIDGETS.map((w) => ATS_REVIEW_WIDGET[w] || w).concat(["typeahead"])
)];

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
    // ⚠⚠ AN EXACT NAME MATCH WINS OUTRIGHT (live rehearsal, 2026-08-20). The prefix fallback below
    // exists so a form's shorter or longer wording still lands, but it made "United States" match
    // BOTH "+1 (United States)" and "+1 (United States Minor Outlying Islands)" — two hits, so the
    // ambiguity guard refused, and the replay reported `no dial-code option agreed with
    // ["+1 (United States)"]` while the form was offering that exact string as its FIRST option.
    // The guard was right to distrust two prefix hits; it should never have been asked, because one
    // of them was an exact match. Exact first; ambiguity only among equally-good candidates.
    const exact = [];
    opts.forEach((o, i) => { if (atsDialCode(o) === cc && atsDialName(o) === cn) exact.push(i); });
    if (exact.length === 1) return { index: exact[0], tier: "dial-code+name" };
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
  // ⚠ READ THE CAPTION FROM THE LEAVES TOO, NOT ONLY THE ELEMENT'S OWN TEXT (live 2026-08-18).
  // iCIMS' action-button widget renders its label TWICE for responsive layout —
  //   <a class="iCIMS_Anchor iCIMS_Action_Button iCIMS_ApplyOn" href="…">
  //     <div class="iCIMS_Action_ButtonText">
  //       <span class="iCIMS_LongLabel">Apply</span><span class="iCIMS_ShortLabel">Apply</span>
  // — so the anchor's textContent is "ApplyApply", and `/^apply\b/` does NOT match it: there is no word
  // boundary between "y" and "A". The control a human plainly sees was therefore invisible to both
  // finders, and the run halted `apply-not-followable` on a perfectly good posting (SCS Engineers).
  // Astrion hid this because its own duplication happened to leave a space ("Apply for this job
  // onlineApply"), which the anchored alternative still matched.
  // Each LEAF's text is what is actually rendered, so testing those alongside the concatenation is both
  // more faithful and generic — no iCIMS class to key on, and it fixes any duplicated-label widget.
  const caps = (el) => {
    const own = String(el.textContent || "").replace(/\s+/g, " ").trim();
    const leaves = [...el.querySelectorAll("*")].filter((n) => !n.children.length)
      .map((n) => String(n.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean);
    return [own, ...leaves];
  };
  const applyCap = (el) => caps(el).find((t) => t.length <= 40 && APPLY_RE.test(t)) || null;
  const all = [...document.querySelectorAll('button, [role="button"], a[href="#"]')].filter((b) => !!applyCap(b));
  // Prefer a visibly-rendered one, but an all-invisible verdict falls back to the full set
  // rather than abandoning the run on a measurement a hidden tab is known to get wrong.
  const shown = all.filter(vis);
  const btns = shown.length ? shown : all;
  if (btns.length === 0) return { ok: false, reason: "no-apply-button" };
  const uniq = [...new Set(btns.map((b) => applyCap(b)))];
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

// ⚠ AN ENTRY'S SUBMIT KEY IS ITS POSITION, NOT THE ID THE FORM MINTED (live 2026-08-18).
// `atsDurableFieldName` alone was enough while iCIMS numbered repeating entries POSITIONALLY (`-1_`,
// `-2_`, `-3_` — an ordinal is a position, and the same form renders the same ordinals every visit).
// The résumé parse breaks that: it SAVES the entries it extracts, so they come back as server rows
// carrying opaque ids, and a fresh visit mints fresh ones. Measured on Astrion: a fill wrote its bundle
// under `-8455804/5/6_` and the rehearsal's form served `-8459967/8/9_`, so all 45 Experience fields
// reported `approved value has NO matching field on the live form` and the gate refused a submit whose
// values were all present. An id that changes per visit cannot be a key.
//
// The position CAN be, and both sides already carry it: `atsAssignEntryIndexes` stamps `entryIndex`
// (+`entrySection`) by FIRST DOM APPEARANCE, and the bundle carries them as `entry_section` /
// `entry_index`. So a section entry keys as `@experience[0]/<bare id>` — stable however the tenant
// numbers its rows.
//
// This is not a NEW trust assumption: matching by ordinal was already positional, so a tenant that
// reordered its rows between visits could always have mis-aligned them. What changed is only that the
// position is now read from the stamp instead of from the id. Anything without a section stamp — every
// page-level field, and the candidate's own address/phone block, which the parse leaves at `-1_` (all 45
// failures were Experience; not one was `PersonProfileFields.Address*`/`Phone*`) — keeps the old key
// exactly, so Greenhouse / Lever / Ashby are byte-identical.
// Accepts BOTH shapes on purpose: live scan fields (camelCase, from atsInjScan) and bundle entries /
// result records (snake_case). One key function, or the two sides key differently and nothing matches.
// ⚠⚠ ORC STAMPS A VOLATILE RENDER COUNTER ONTO A RADIO GROUP'S `name` (live rehearsal, 2026-08-20).
// Measured across two visits to the SAME form: the fill saw
// `US-STANDARD-ORA_DISABILITY_STATUS-STANDARD-12` and the rehearsal `…-STANDARD-13`, so the approved
// answer reported `no matching field on the live form` and blocked the gate on a question that was
// sitting right there. The recon predicted this ("id carries a volatile counter"); this is it
// arriving on a `name`, which is supposed to be the durable half.
//
// ⚠ THE STRIP IS DELIBERATELY NARROW, and the reason is a collision, not caution. ORC also serves
// `siteLink-1` / `siteLink-2`, where the trailing number is a MEANINGFUL ENTRY ORDINAL — stripping
// that would key both links as `siteLink`, so one would shadow the other and the verify would match
// the wrong one or call it missing. There is no syntactic way to tell a render counter from an
// ordinal in general, so this keys on the ONE shape actually observed to be volatile: the platform
// self-ID groups, whose names end `-STANDARD-<digits>`. `namInformation15` (digits, no hyphen) is
// untouched for free. Widen ONLY on evidence of another family doing it — a wrong widening is
// silent and costs a mismatched answer, which is worse than the failure it would fix.
const ATS_ORC_VOLATILE_SUFFIX_RE = /-STANDARD-\d+$/;
function atsOrcDurableName(name) {
  const n = String(name == null ? "" : name);
  return ATS_ORC_VOLATILE_SUFFIX_RE.test(n) ? n.replace(/-\d+$/, "") : n;
}

function atsSubmitKey(ats, f) {
  // A bare string is accepted so a caller that only holds a name still gets the OLD key rather than a
  // silently empty one — an empty key would match every other keyless field, which is worse than
  // missing the position.
  if (typeof f === "string") return ats === "oracle" ? atsOrcDurableName(f) : atsDurableFieldName(f);
  const name = String((f && (f.fieldName != null ? f.fieldName : f.name)) || "");
  if (ats === "oracle") return atsOrcDurableName(name);
  if (ats !== "icims" || !f) return atsDurableFieldName(name);
  const section = f.entrySection != null ? f.entrySection : f.entry_section;
  const idx = typeof f.entryIndex === "number" ? f.entryIndex
    : (typeof f.entry_index === "number" ? f.entry_index : null);
  if (section != null && String(section) !== "" && typeof idx === "number") {
    return "@" + section + "[" + idx + "]/" + atsMapKey(ats, name);
  }
  return atsDurableFieldName(name);
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
  // ⚠ A MULTI-STEP FLOW CONTROL COUNTS FOR RECOGNITION. On Oracle, step 1 of 3 has "Next" and no
  // Submit at all, so requiring a submit control refused a form we could fill perfectly well. What
  // this function answers is "is this a fillable application page", and a Next answers that.
  // It does NOT make the page submittable — that stays keyed on `hasSubmit`, which the submit gate
  // reads, so nothing here can cause a Next to be pressed in place of a Submit.
  const hasFlow = !!(submitState && submitState.hasFlowControl);
  const canAct = hasSubmit || hasFlow;
  return {
    ok: canAct && (hasResume || hasEmail || hasName),
    hasSubmit, hasFlowControl: hasFlow, hasResume, hasEmail, hasName,
    why: canAct ? (hasResume || hasEmail || hasName ? "" : "no resume/email/name field — this doesn't look like an application form")
                : "no submit or next control on the page — this isn't a form we could fill or advance",
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

// ── EMPLOYER-FRONTED PORTALS: the URL names no ATS at all ────────────────────────────────
// `careers.astrion.us/jobs/24615` is an iCIMS career portal served under the EMPLOYER's own
// domain, so `detectAts` — which is host-based and must stay that way, because that is what makes
// `icims.com.evil.com` return null — sees nothing. There is no hostname pattern to widen to:
// "careers.<anything>" is every ATS and none of them.
//
// So the portal is identified the way every other unknown in this codebase is: READ THE PAGE, and
// decide SW-side. The evidence is the set of hosts the page itself references — iframe srcs, script
// srcs, stylesheet hrefs, and the hosts its own Apply affordances point at. That is the employer
// telling us who runs their careers site, not us guessing from a name.
function atsInjPortalEvidence() {
  const attr = (sel, name) => [...document.querySelectorAll(sel)].map((e) => e.getAttribute(name) || "").filter(Boolean).slice(0, 60);
  const hostsOf = (list) => {
    const out = [];
    for (const u of list) { try { out.push(new URL(u, location.href).hostname.toLowerCase()); } catch (e) { /* skip */ } }
    return out;
  };
  const applyHrefs = [...document.querySelectorAll("a[href]")]
    .filter((a) => /\bapply\b/i.test(a.textContent || "") || /\/(apply|login)\b|apply\?/i.test(a.getAttribute("href") || ""))
    .map((a) => a.href).slice(0, 20);
  return {
    ok: true, url: location.href,
    frameHosts: hostsOf(attr("iframe", "src")),
    scriptHosts: hostsOf(attr("script[src]", "src")),
    linkHosts: hostsOf(attr("link[href]", "href")),
    applyHosts: hostsOf(applyHrefs),
    frameIds: [...document.querySelectorAll("iframe")].map((f) => f.id || "").filter(Boolean).slice(0, 10),
  };
}

// Which ATS does the page's own evidence name? `isAts` is injected (detectAts) so host knowledge
// stays in ONE place. Refuses ambiguity exactly like atsPickApplyLink / atsPickEmbeddedForm: a page
// referencing two different ATSs is not a situation to guess through.
function atsPortalAts(ev, isAts) {
  if (!ev || !ev.ok) return null;
  const kinds = new Set();
  for (const hosts of [ev.frameHosts, ev.scriptHosts, ev.applyHosts, ev.linkHosts]) {
    for (const h of hosts || []) {
      const k = isAts("https://" + h + "/");
      if (k && k !== "workday") kinds.add(k);
    }
  }
  if (kinds.size === 1) return [...kinds][0];
  if (kinds.size > 1) return null;
  // iCIMS' own frame id, which only exists on a page iCIMS rendered. Kept as a LAST tier rather
  // than a first one: a host reference is harder evidence than an element id.
  if ((ev.frameIds || []).some((id) => /^icims_content_iframe$/i.test(id))) return "icims";
  return null;
}

// ── PAGE SIGNATURE — "did that click actually do anything?" ──────────────────────────────
// The iCIMS Apply control is FLAKY: a click can be swallowed and the page simply stays put
// (operator, observed). A fixed click COUNT is the wrong remedy — it either under-clicks a slow
// page or over-clicks a page that already moved. So the retry polls the page's own IDENTITY, the
// same rule the Workday walk's transition wait uses: url || the rendered control set || the
// heading. Any one of them differing means we advanced.
function atsInjPageSignature() {
  const q = "input:not([type=hidden]), select, textarea";
  const ids = [...document.querySelectorAll(q + ", button")].map((e) => e.id || e.name || "").filter(Boolean).sort().join("|");
  const fr = document.getElementById("icims_content_iframe") || document.querySelector('iframe[id*="icims"], iframe[name*="icims"]');
  const h = document.querySelector("h1, h2");
  return {
    // ⚠ `ok` IS LOAD-BEARING, NOT DECORATION (live 2026-08-19). Every other atsInj* fn returns it, so
    // a caller naturally writes `r && r.ok ? r : null` — and runOrcPreForm's did. This function did
    // NOT return it, so that guard turned EVERY successful read into null: both sides of the compare
    // were null, atsSignatureChanged's deliberately-conservative "an unreadable side is no change"
    // rule then said false forever, and every ORC waitForChange ran its FULL budget every time
    // (measured: 15697ms of a 15000ms budget, 20228ms of 20000ms — 36s per run). The flow still
    // worked, because the loop's next round re-scans and sees the new view, which is exactly why it
    // hid: a wait that always times out looks like a slow page, and the tempting fix is a bigger
    // budget. Nothing was wrong with the budget.
    ok: true,
    url: String(location.href).split("#")[0],
    frameSrc: fr ? String(fr.getAttribute("src") || fr.src || "").split("#")[0] : null,
    controls: document.querySelectorAll(q).length,
    heading: String((h && h.textContent) || "").replace(/\s+/g, " ").trim().slice(0, 80),
    ids: ids.slice(0, 600),
  };
}

// PURE. Deliberately conservative in ONE direction: an unreadable side is "no change", so a read
// that failed can never be mistaken for progress — the caller keeps waiting or gives up saying so.
function atsSignatureChanged(a, b) {
  if (!a || !b) return false;
  if (String(a.url) !== String(b.url)) return true;
  if (String(a.frameSrc || "") !== String(b.frameSrc || "")) return true;
  if (String(a.heading || "") !== String(b.heading || "")) return true;
  if (Number(a.controls || 0) !== Number(b.controls || 0)) return true;
  return String(a.ids || "") !== String(b.ids || "");
}

// Click an Apply control the existing `atsInjClickApplyButton` cannot see. That one queries
// `button, [role=button], a[href="#"]` and matches on `textContent` — so an `<input type="submit"
// value="Apply">` (no textContent) and an ordinary `<a href="…">Apply</a>` (a real href) both miss.
// Kept SEPARATE rather than widening the original, so Greenhouse / Lever / Ashby keep the exact
// affordance-finding they were live-verified with. Same refusals: invisible-preferred, ambiguity
// declines rather than guesses.
function atsInjClickApplyAnchor() {
  const vis = (el) => {
    if (typeof el.checkVisibility === "function") return el.checkVisibility({ checkVisibilityCSS: true });
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const APPLY_RE = /^apply\b|\bapply (now|here|online|for this)\b/i;
  // ⚠ READ THE CAPTION FROM THE LEAVES TOO, NOT ONLY THE ELEMENT'S OWN TEXT (live 2026-08-18).
  // iCIMS' action-button widget renders its label TWICE for responsive layout —
  //   <a class="iCIMS_Anchor iCIMS_Action_Button iCIMS_ApplyOn" href="…">
  //     <div class="iCIMS_Action_ButtonText">
  //       <span class="iCIMS_LongLabel">Apply</span><span class="iCIMS_ShortLabel">Apply</span>
  // — so the anchor's textContent is "ApplyApply", and `/^apply\b/` does NOT match it: there is no word
  // boundary between "y" and "A". The control a human plainly sees was therefore invisible to both
  // finders, and the run halted `apply-not-followable` on a perfectly good posting (SCS Engineers).
  // Astrion hid this because its own duplication happened to leave a space ("Apply for this job
  // onlineApply"), which the anchored alternative still matched.
  // Each LEAF's text is what is actually rendered, so testing those alongside the concatenation is both
  // more faithful and generic — no iCIMS class to key on, and it fixes any duplicated-label widget.
  const caps = (el) => {
    const own = String(el.value || el.textContent || "").replace(/\s+/g, " ").trim();
    const leaves = [...el.querySelectorAll("*")].filter((n) => !n.children.length)
      .map((n) => String(n.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean);
    return [own, ...leaves];
  };
  const cap = (el) => caps(el).find((t) => t.length <= 40 && APPLY_RE.test(t)) || caps(el)[0] || "";
  const all = [...document.querySelectorAll('a[href], input[type="submit"], input[type="button"]')]
    .filter((el) => caps(el).some((t) => t.length <= 40 && APPLY_RE.test(t)));
  const shown = all.filter(vis);
  const els = shown.length ? shown : all;
  if (!els.length) return { ok: false, reason: "no-apply-control" };
  const uniq = [...new Set(els.map(cap))];
  if (uniq.length > 1) return { ok: false, reason: "ambiguous", offered: uniq.slice(0, 4) };
  els[0].click();
  return { ok: true, clicked: uniq[0], href: els[0].tagName === "A" ? String(els[0].href || "").split("?")[0] : null };
}

// ── iCIMS SIGN-IN GATE ───────────────────────────────────────────────────────────────────
// Reaching an iCIMS application form means getting past an email gate first (traced live
// 2026-08-16 on astrioncareers-astrion.icims.com/jobs/<id>/login): step one is an "Enter Your
// Information" card holding ONE visible control — `<input type="email" id="email"
// name="css_loginName">` — plus `<input type="submit" id="enterEmailSubmitButton" value="Next">`,
// inside the same `#icims_content_iframe` the form itself lives in, with hCaptcha in INVISIBLE
// mode (a corner badge, no checkbox).
//
// ⚠ THE LOGIN PAGE PASSES `atsLooksLikeApplicationForm`. It has a submit control and an email
// field, which is exactly that function's positive test — so without an auth check running FIRST,
// a run that reaches the gate would classify it as the application form and start filling profile
// data into a login box. Recognising the gate is therefore a SAFETY property, not a convenience:
// the same reasoning that makes an UNrecognised password field the dangerous outcome for the
// credential tier.
//
// READ-ONLY. Runs inside the form frame when one is armed and works unchanged on a top-level
// document, so a tenant that stops framing its login needs no new code.
function atsInjAuthScan() {
  const vis = (el) => {
    if (!el) return false;
    if (typeof el.checkVisibility === "function") return el.checkVisibility({ checkVisibilityCSS: true });
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"));
  const labelOf = (e) => {
    let l = e.id ? document.querySelector('label[for="' + esc(e.id) + '"]') : null;
    if (!l) l = e.closest("label");
    if (!l) { const row = e.closest("tr, .iCIMS_TableRow, fieldset, div"); l = row ? row.querySelector("label") : null; }
    return clean(l && l.textContent).slice(0, 80);
  };
  const words = (e) => clean((e.id || "") + " " + (e.name || "") + " " + (e.getAttribute("autocomplete") || "") + " " + labelOf(e));
  const selOf = (e) => (e.id ? "#" + esc(e.id) : (e.name ? '[name="' + esc(e.name) + '"]' : null));
  const describe = (e) => (e ? { sel: selOf(e), id: e.id || null, name: e.name || null, label: labelOf(e),
    type: String(e.type || "").toLowerCase(), prefilled: !!(e.value && String(e.value).length) } : null);

  const shown = [...document.querySelectorAll("input:not([type=hidden]), select, textarea")].filter(vis);
  const find = (test) => describe(shown.find(test) || null);
  const password = find((e) => String(e.type || "").toLowerCase() === "password");
  const email = find((e) => String(e.type || "").toLowerCase() === "email" || /\b(e-?mail|loginname|login_?name|username|user_?id)\b/i.test(words(e)));
  // A one-time code box. iCIMS can mail a code instead of showing a password step; recognising it
  // is what lets the run say so instead of halting on "an unknown page".
  const code = find((e) => /one-time-code/i.test(e.getAttribute("autocomplete") || "")
    || /\b(otp|one[ _-]?time|verification[ _-]?code|access[ _-]?code|security[ _-]?code|passcode)\b/i.test(words(e)));

  const clickables = [...document.querySelectorAll('input[type="submit"], input[type="button"], button, a.iCIMS_Anchor, [role="button"]')].filter(vis);
  const cap = (b) => clean(b.value || b.textContent).slice(0, 60);
  const submitEl = clickables.find((b) => /^input$/i.test(b.tagName) && /^submit$/i.test(String(b.type || "")))
    || clickables.find((b) => /^(next|continue|sign in|log ?in|submit|go|send)\b/i.test(cap(b)));
  const submit = submitEl ? { sel: submitEl.id ? "#" + esc(submitEl.id) : null, id: submitEl.id || null, caption: cap(submitEl) } : null;

  // FEDERATED buttons are REPORTED and never clicked — the Workday `sso` rule, carried over.
  const federated = clickables.map(cap).filter((t) => /\b(with|using)\s+(google|linkedin|apple|microsoft|facebook)\b|\b(sso|single sign[ -]?on)\b/i.test(t)).slice(0, 5);
  // An account-CREATION control is likewise reported, never pressed: on iCIMS the account is made
  // by the SUBMISSION (the form's own "Create a login" block, behind the review gate), so a
  // standalone register button here is a flow we have not traced and must not press blind.
  const createAccount = clickables.map(cap).filter((t) => /\b(create (an? )?account|register|sign ?up)\b/i.test(t)).slice(0, 5);

  // Same VISIBLE-challenge rule as atsInjSubmitState (a dormant invisible-mode container is a
  // full-viewport hidden iframe and must not read as a challenge).
  const captchaChallenge = [...document.querySelectorAll('iframe[src*="hcaptcha"], iframe[src*="recaptcha"]')].some((f) => {
    const cs = getComputedStyle(f);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.1) return false;
    const r = f.getBoundingClientRect();
    return r.width > 60 && r.height > 60 && r.width < 700;
  });

  const errors = [...document.querySelectorAll('.iCIMS_Error, .iCIMS_Validation_Error, .error, [role="alert"], .alert-danger')]
    .filter(vis).map((e) => clean(e.textContent)).filter(Boolean).slice(0, 4);

  // ── A LEGAL CONSENT IS A PRECONDITION WE MUST NOT SATISFY OURSELVES (live 2026-08-18) ──────
  // iCIMS gates postings outside the US behind a data-privacy consent ON THE SIGN-IN CARD: an
  // UNCHECKED `#accept_gdpr` carrying `aria-required="true"`, a hidden `#consentCaptureTitle` naming
  // it ("General Data Protection Regulation (GDPR)"), and a row that states the rule itself — "You
  // must indicate that you have read the privacy notice and consent to the processing of your
  // personal data before you can continue." (ITT, a Bogotá posting.)
  // This function REPORTS them and classifies NOTHING. Which boxes are an acceptance of a notice,
  // which are an unrelated opt-in, and what may be done about either is a JUDGEMENT — it lives in
  // `atsConsentKind` + the caller, so there is exactly one copy of it instead of an injected dup that
  // could drift from the one the operator authorised.
  // `blocking` is two-sourced on purpose: the required MARKER, or the row SAYING it is mandatory,
  // because a tenant can word the requirement without marking the input.
  const consentTitle = clean((document.querySelector("#consentCaptureTitle") || {}).value || "").slice(0, 80);
  const rowTextOf = (e) => clean((e.closest("tr, .iCIMS_TableRow, fieldset, div") || {}).innerText || "").slice(0, 240);
  const consents = [...document.querySelectorAll('input[type="checkbox"]')].filter(vis)
    .map((e) => {
      const row = rowTextOf(e);
      return {
        sel: selOf(e), id: e.id || null, checked: !!e.checked,
        label: labelOf(e) || null, rowText: row, title: consentTitle || null,
        required: e.required === true || e.getAttribute("aria-required") === "true",
        blocking: e.required === true || e.getAttribute("aria-required") === "true"
          || /must|before you can continue|required/i.test(row),
      };
    }).slice(0, 8);

  // ── the two signals that say WHY a submit went nowhere ──────────────────────────────
  // The gate's submit is preventDefault-ed and gated on INVISIBLE hCaptcha (traced 2026-08-16):
  //   form.onsubmit → e.preventDefault() → hcaptcha.execute(widgetId)
  //   hCaptcha callback → append <input name="h-captcha-response" value=token> → form.submit()
  // So "the page did not change" has two completely different causes, and without these two reads
  // they are indistinguishable — which is a whole debugging round each time.
  //   submitLocked : iCIMS' own onsubmit calls icimsDisableSaveAndSubmitButtons, so a DISABLED
  //                  button proves the submit event FIRED and we are waiting on the captcha.
  //   captchaToken : a token present proves hCaptcha RESOLVED and the form was really submitted.
  // The token's VALUE is never returned — a boolean and a length, the credential discipline.
  const tokenEl = document.querySelector('[name="h-captcha-response"]');
  const submitLocked = submitEl ? !!(submitEl.disabled || submitEl.getAttribute("aria-disabled") === "true") : null;

  return { ok: true, url: location.href, title: document.title, readyState: document.readyState,
    controlCount: shown.length, email, password, code, submit, federated, createAccount,
    consents, consentTitle: consentTitle || null,
    captchaChallenge, submitLocked,
    captchaPresent: !!tokenEl, captchaToken: !!(tokenEl && tokenEl.value && String(tokenEl.value).length),
    captchaFrames: document.querySelectorAll('iframe[src*="hcaptcha"]').length,
    errors, bodyText: clean(document.body ? document.body.innerText : "").slice(0, 1200) };
}

// How many visible controls before a page stops being a sign-in card and starts being a form. The
// gate renders ONE (measured); the application form renders ~118. Nothing real sits between, and
// the caller ALSO requires the positive form identity (atsLooksLikeApplicationForm) before it
// treats a page as the form — this bound only stops the auth classifier claiming a page it should
// keep its hands off.
var ICIMS_AUTH_MAX_CONTROLS = 5;

// PURE. What auth view is this? Ordered so a BLOCKING state outranks page shape, and so the
// classifier never claims a page that is too big to be a sign-in card.
//   captcha    — a visible challenge; the bot never solves one
//   code       — iCIMS mailed a one-time code
//   password   — the credential step
//   email      — the "Enter Your Information" gate
//   blocked    — an auth-shaped page whose only way on is a control we refuse to press
//   none       — not an auth view (the caller decides whether it is the form)
function icimsAuthView(s) {
  if (!s || !s.ok) return "unreadable";
  if (s.captchaChallenge) return "captcha";
  if (Number(s.controlCount || 0) > ICIMS_AUTH_MAX_CONTROLS) return "none";
  if (s.code) return "code";
  if (s.password) return "password";
  if (s.email) return "email";
  // No field we can fill, but the page is offering federated sign-in or account creation — that is
  // an auth wall, and saying so beats "unknown page".
  if ((s.federated || []).length || (s.createAccount || []).length) return "blocked";
  return "none";
}

// ── ORC's TYPEAHEAD PICKER: type → poll → pointer-commit, ALL IN ONE CALL (2026-08-19) ───
// Every clause below is a measured live finding, not a precaution. Verified on Oracle's own careers
// site (`eeho.fa.us2`, job 334325) against country / city / state / county / postal / dial-code.
//
//   1. THE SEARCH FIRES ON KEY EVENTS, NOT ON `input`. A native-setter write plus an `input` event
//      sets the value and even opens the listbox, but no search runs and the box sits EMPTY. Typing
//      character-by-character with keydown/input/keyup returns rows. (Knockout takes the value from
//      `input`; the SEARCH is bound to keys.)
//   2. THE OPTIONS ARE `div[role="row"]` INSIDE `div#<id>-listbox[role="grid"]`. A `[role=option]`
//      scrape finds NOTHING. The listbox does not exist until the widget opens, and it is NOT
//      portaled — it lives inside the field's own `div.input-row`.
//   3. A BARE `.click()` ON A ROW DOES NOT COMMIT. A full pointer sequence does
//      (pointerdown→mousedown→pointerup→mouseup→click with real clientX/Y) — i.e. exactly
//      robustClick's first strategy, arrived at independently here.
//   4. TYPE THE FULL OPTION TEXT BEFORE COMMITTING. The widget re-syncs its input to whatever was
//      typed, so committing after a partial query ("United" for "United States") leaves the typed
//      fragment behind and the selection does not stick.
//   5. READ AND COMMIT MUST HAPPEN IN ONE EVALUATION. Measured: the listbox closes between two
//      separate CDP calls, so a read in one call and a click in the next finds zero rows.
//   6. ⚠ ESCAPE IS THE CLOSE — and the hazard is UNCOMMITTED TEXT, not Escape (corrected by the
//      operator, then measured). Blur, focus-move and a second toggle click ALL leave the rows
//      mounted; Escape takes them to zero with the value untouched. What destroyed an address block
//      during recon was DISMISSING A PICKER THAT HELD TEXT IT HAD NEVER COMMITTED (`country` was
//      prefilled text wearing `cx-select-input--invalid`): the dismissal discarded it, and clearing
//      a geo PARENT unmounts its whole dependent block. So: commit before closing, and if the value
//      did not take, REPORT it — never dismiss it and hope.
//
// `wantTexts` is a LIST so a composite row can be matched whole ("Tallahassee, Leon, FL"), and the
// caller supplies it — the ambiguity rules stay SW-side. Commits ONLY on exactly one match: two hits
// is not a confident answer and returns `ambiguous` with the rows, never a guess.
// Returns the rows it saw either way, so a miss is diagnosable without a second page contact.
async function atsInjOrcPick(inputSel, query, wantTexts, budgetMs, noClear, segmentMatch) {
  const t = (el) => ((el && el.textContent) || "").replace(/\s+/g, " ").trim();
  const norm = (s) => String(s == null ? "" : s).toLowerCase().replace(/\s+/g, " ").trim();
  // ⚠ ORC's GEO ROWS ARE COMPOSITES and no profile value will ever equal one: a postal code offers
  // "32312, Tallahassee, Leon, FL", a city "Tallahassee, Leon, FL", a county "Leon, FL". Exact
  // matching therefore refused a REQUIRED field while the widget was showing the answer (live).
  // `segmentMatch` compares against the row's FIRST comma-segment, which is the form's own delimiter
  // rather than a guess — so it is structured matching, NOT the loose containment the match ladder
  // deliberately refuses. "32312" matches "32312, …" and still cannot match "323120, …".
  const firstSeg = (v) => norm(String(v).split(",")[0]);
  // ⚠ AND ORC LABELS SOME LISTS WITH A LEADING CODE: `"<CODE> - <Name>"`. Measured on the Education
  // entry's Degree picker — a search for "Bachelor of Science" returned exactly ONE row,
  // `"BS - Bachelor of Science"`, and an exact compare refused it, so the required field stayed empty
  // and Oracle refused the whole Education entry on three consecutive runs.
  //
  // ⚠ THIS IS NOT THE CONTAINMENT THE MATCH LADDER REFUSES, and the difference is structural rather
  // than a matter of degree:
  //   • the split is on the FORM'S OWN separator, " - " WITH SPACES — never a bare hyphen, which
  //     lives inside ordinary words and names ("Jean-Luc", "e-mail", "Add-On");
  //   • what remains must equal the candidate EXACTLY after normalize, not contain it. "Bachelor"
  //     still cannot claim "BS - Bachelor of Science";
  //   • the ambiguity guard above is untouched — two rows matching is still `ambiguous` and refuses.
  // Same reasoning as the postal composite ("32312" → "32312, Tallahassee, Leon, FL"): a delimiter
  // the tenant chose is structure, and reading it is not guessing.
  const afterCode = (v) => {
    const str = String(v);
    const i = str.indexOf(" - ");
    return i > 0 ? norm(str.slice(i + 3)) : null;
  };
  const el = document.querySelector(inputSel);
  if (!el) return { ok: false, error: "not-found:" + inputSel };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  const wants = (Array.isArray(wantTexts) ? wantTexts : [wantTexts]).map(norm).filter(Boolean);
  if (!wants.length) return { ok: false, error: "no-target-text" };

  // CLEARING A GEO PICKER CASCADES (operator, 2026-08-19): emptying city/state/postal/county can
  // empty its siblings too, so the house "clear before typing" rule -- which exists to stop residual
  // text contaminating a re-fill -- is DESTRUCTIVE here. It is what made a sequence of picks look
  // like the fields were deleting each other. `noClear` skips it for those fields; everything else
  // keeps the clear, because a stale query really would poison the search.
  el.focus();
  if (!noClear) {
    setter.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  for (const ch of String(query == null ? "" : query)) {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
    setter.call(el, el.value + ch);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
  }

  // ⚠ INLINED, not a call to the top-level twin: this function is stringified and evaluated in the
  // page, so any free identifier is undefined there. Splitting it out "so the paths cannot drift"
  // would have thrown ReferenceError on the first live pick.
  // ENTER IS THE COMMIT (operator, then measured 2026-08-19). A full pointer sequence on the row
  // LOOKS like it works -- it returns cleanly and the field shows the typed query -- but the list
  // stays OPEN and the selection is never made, which is how four required address fields sat empty
  // with a visible option row underneath them. Pressing Enter while exactly one row is showing
  // selects it, closes the list, AND fires the tenant's own cascade. The pointer sequence is kept
  // only as a fallback for a widget that ignores Enter.
  const commitRow = (row, wantText, sawRows) => {
    el.focus();
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
    return { ok: true, committed: wantText, rows: sawRows, via: "enter" };
  };
  const commitRowByPointer = (row, wantText, sawRows) => {
    const r = row.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window,
      clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2) };
    for (const ty of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      row.dispatchEvent(new MouseEvent(ty, o));
    }
    return { ok: true, committed: wantText, rows: sawRows, via: "pointer" };
  };

  const lbId = el.getAttribute("aria-controls") || (el.id ? el.id + "-listbox" : null);
  const readRows = () => {
    const lb = lbId ? document.getElementById(lbId) : null;
    return lb ? [...lb.querySelectorAll('[role="row"]')] : [];
  };
  const deadline = Date.now() + (budgetMs || 8000);
  const openedAt = Date.now();
  let lastRows = [], reopens = 0;
  while (Date.now() < deadline) {
    // ⚠ AN OPEN THAT DID NOT TAKE IS RE-CLICKED, not waited out (speed round, 2026-08-20). ORC's
    // combobox is sometimes not wired when the first click lands — measured on the Education entry's
    // School picker at ~17s, which was one dead 8s visit followed by a retry that worked. Two extra
    // clicks cost nothing next to that, and they also cure the "it lags until I click the page"
    // symptom: without them the run sits in a poll on a picker that never opened.
    if (!lastRows.length && reopens < 2 && Date.now() - openedAt > (reopens + 1) * 700) {
      reopens++;
      try { el.click(); } catch (e) { /* the poll below is the judge */ }
    }
    await new Promise((r) => setTimeout(r, 250));
    const rows = readRows();
    if (!rows.length) {
      // the widget's own terminal "nothing here" — stop early rather than burning the budget
      const box = document.querySelector(".cx-select__listbox");
      if (box && /no results/i.test(t(box))) return { ok: false, error: "no-results", query, rows: [] };
      continue;
    }
    lastRows = rows.map(t);
    const hits = rows.filter((r) => wants.indexOf(norm(t(r))) !== -1
      || (segmentMatch && wants.indexOf(firstSeg(t(r))) !== -1)
      || (segmentMatch && afterCode(t(r)) !== null && wants.indexOf(afterCode(t(r))) !== -1));
    if (hits.length > 1) return { ok: false, error: "ambiguous", query, rows: lastRows, matched: hits.length };
    if (hits.length === 1) {
      const row = hits[0];
      const want = t(row);
      // finding 4: make the typed text agree with the option before committing
      if (!segmentMatch && !noClear && norm(el.value) !== norm(want)) {
        setter.call(el, "");
        el.dispatchEvent(new Event("input", { bubbles: true }));
        for (const ch of want) {
          el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
          setter.call(el, el.value + ch);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
        }
        // re-resolve the row: retyping re-renders the list
        await new Promise((r) => setTimeout(r, 400));
        const again = readRows().filter((r) => norm(t(r)) === norm(want));
        if (again.length === 1) return commitRow(again[0], want, lastRows);
        // fall through and try again on the next tick rather than clicking a stale node
        continue;
      }
      return commitRow(row, want, lastRows);
    }
  }
  return { ok: false, error: "no-match", query, rows: lastRows };
}

// ── CAPTURE AN ORC PICKER'S OPTIONS SO REVIEW GETS A REAL PICKER (2026-08-19) ────────────
// The operator's rule, carried over from iCIMS: on a form where a field we never filled still has to
// be ANSWERABLE, a picker with no usable options is just a text box. ORC's scan cannot read options
// inline — the listbox does not exist until the widget opens — so this is a separate, read-only pass.
//
// ⚠ AN EMPTY OPEN RETURNS THE WHOLE VOCABULARY ON ORC, which is what makes the captured list
// genuinely COMPLETE rather than a first page. Measured: `country` returns **251** rows,
// Afghanistan→Zimbabwe. So ORC needs none of the page-cap derivation iCIMS required — there is no
// pager to detect. (If a future tenant does paginate, the caller must mark the list partial; that is
// why completeness is the CALLER's call and this function only reports what it saw.)
//
// ⚠ IT OPENS WITH NO QUERY, on purpose. Typing would filter, and a filtered list is not the field's
// vocabulary — the same reason a search-filtered actuation list must not be mistaken for a complete
// scan list.
//
// ⚠ CLOSED BY BLUR ONLY. NEVER Escape (it REVERTS an ORC geo picker) and never a click elsewhere:
// that combination unmounted an entire dependent address block during recon and did not recover.
// Verifies the rows are GONE afterwards and says so, because a lingering list is the standing hazard.
async function atsInjOrcCaptureOptions(inputSel, budgetMs) {
  const t = (el) => ((el && el.textContent) || "").replace(/\s+/g, " ").trim();
  const el = document.querySelector(inputSel);
  if (!el) return { ok: false, error: "not-found:" + inputSel };
  const lbId = el.getAttribute("aria-controls") || (el.id ? el.id + "-listbox" : null);
  const readRows = () => {
    const lb = lbId ? document.getElementById(lbId) : null;
    return lb ? [...lb.querySelectorAll('[role="row"]')] : [];
  };
  el.focus();
  el.click();
  const deadline = Date.now() + (budgetMs || 6000);
  let texts = [];
  let terminalNo = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const rows = readRows();
    if (rows.length) { texts = rows.map(t).filter(Boolean); break; }
    const box = document.querySelector(".cx-select__listbox");
    if (box && /no results/i.test(t(box))) { terminalNo = true; break; }
  }
  // ⚠ ESCAPE IS THE CLOSE, and it is the ONLY one that works (operator, then measured): blur,
  // focus-move to another field, and a second toggle click ALL leave the rows mounted — captured
  // lists were observed accumulating to 515 rows across three captures. Escape took `title` from 17
  // rows to 0 with `aria-expanded` true→false and the value untouched.
  //
  // ⚠ THE REAL HAZARD IS NOT ESCAPE, IT IS CLOSING A PICKER THAT HOLDS UNCOMMITTED TEXT. A picker
  // wearing `cx-select-input--invalid` is holding text it never accepted as a selection, and
  // dismissing it DISCARDS that text — which for a geo PARENT (`country`) also unmounts its whole
  // dependent block (addressLine1-3, city, region1/2, postalCode leave the DOM). This capture pass
  // opens with NO query and writes nothing, so it has nothing to lose; a caller that has typed into
  // a picker must commit it before closing, and report a failure rather than dismissing it.
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true }));
  el.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 300));
  return { ok: true, options: texts, count: texts.length, terminalNo,
    // the standing rule: a close is confirmed by the options being GONE, never by aria-expanded
    closed: readRows().length === 0,
    heldUncommittedText: /cx-select-input--invalid/.test(String(el.className || "")) };
}

// Read an ORC picker back. ⚠ THE VALUE ALONE IS NOT PROOF: the widget keeps typed text that it has
// not accepted as a selection, and marks that state with `cx-select-input--invalid` (measured — a
// prefilled "United States" carried it from first load). So `invalid` is a NEGATIVE verify signal and
// a commit that leaves it set must not be reported as filled.
// ⚠ It is also LAGGY: a read in the same evaluation as the click returns the PREVIOUS value, so the
// caller must poll this SW-side rather than reading once.
function atsInjOrcReadPicker(inputSel) {
  const el = document.querySelector(inputSel);
  if (!el) return { ok: false, error: "not-found:" + inputSel };
  return { ok: true, value: el.value || null,
    invalid: /cx-select-input--invalid/.test(String(el.className || "")),
    expanded: el.getAttribute("aria-expanded") === "true",
    openRows: [...document.querySelectorAll(".cx-select__listbox [role=\"row\"]")].length };
}

// ── PRESS AN ORC FLOW BUTTON BY CAPTION (injected; 2026-08-19) ───────────────────────────
// ⚠ atsInjClickAuthSubmit is NOT reusable here, and the reason is measured: ORC's "Next" and
// "Verify" are plain `<button>`s with **no id** and no `type="submit"`, so that helper's selector
// would be null and its fallback query (`input[type=submit], button[type=submit]`) finds nothing —
// it would report `no-submit-control` on a page whose button is right there.
//
// The caption is therefore the only handle, which brings its own hazard the timeline already
// demonstrated: on ORC's own experience form the entry-COMMIT button carries the SAME TEXT as the
// entry-OPENER. So this takes an optional `withinSel` and, when given, only considers buttons
// inside it — the caller decides the scope rather than hoping the first match is the right one.
// A pattern SOURCE string is passed rather than a RegExp because CDP serializes arguments as JSON
// and a RegExp arrives as `{}`.
// WHERE THE WIZARD IS, AND WHAT MAY BE PRESSED. Read as a whole rather than field by field,
// because the walk's two decisions ("is this the last step" / "did Next actually advance") each need
// several of these at the same instant, and reading them across separate evals lets the page move in
// between.
//
// ⚠ THE STEP NUMBER COMES FROM THE URL FIRST. It is DECLARED (`…/apply/section/<n>`), where every
// other candidate is measured — and the standing ORC rule is that on the FORM geometry tells the
// truth while declared intent lies (inactive sections report aria-hidden="false" at 0×0), so a
// signal that is declared *and* corroborated by geometry is the only one worth building a loop on.
// The announced "step N of M" gives the TOTAL, which the URL cannot.
//
// ⚠ AND THE TOTAL IS NEVER THE SECTION COUNT. Measured: Baylor serves 5 <apply-flow-section> for 4
// steps (index 0 an empty shell), Oracle 4 for 3, and on Oracle TWO are visible at once (index 0 is
// the résumé-import banner). Any arithmetic on that count is wrong on one of the two tenants, which
// is why the walk's terminal test is the PRESENCE OF A NEXT CONTROL and not `step >= total`.
// ⚠ THE ADVANCE PATTERN AND THE REFUSAL PATTERN ARE DEFINED AS A PAIR, deliberately adjacent: the
// safety property is that no caption can satisfy both, and that is only checkable by reading them
// together. The pre-form's own click pattern DOES include `submit` (a sign-in step's control is
// legitimately captioned Submit) — this pair is the WALK's, where a submit press is the one
// irreversible act in the whole pipeline.
// ⚠ `\\b` not `\b`: in a JS string literal `\b` is U+0008 (BACKSPACE), so the regex could never
// match. That exact slip halted a run at Oracle's email gate with `auth-submit-not-pressable` on a
// page whose Next button was plainly there, and a test that asserted the pattern's SPELLING passed
// the whole time. test/ats.test.js decodes these literals and matches them against real captions.
const ATS_ORC_NEXT_RE = "^(next|continue|save and continue|save & continue)\\b";
const ATS_ORC_FORBID_RE = "submit|apply now|finish|send application";

function atsInjOrcStepState() {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const url = String(location.href).split("#")[0];
  const um = /\/apply\/section\/?(\d+)/.exec(url);
  const step = um ? Number(um[1]) : null;

  // "…application, step 1 of 4" — announced for screen readers, so it is text on the page rather
  // than an attribute. Searched over a bounded set of small nodes, never the whole body's text.
  let total = null, announced = null;
  const cands = [...document.querySelectorAll("apply-flow-pagination, [aria-live], [role=status], h1, h2, .progress-bar-text")];
  for (const el of cands) {
    const m = /step\s+(\d+)\s+of\s+(\d+)/i.exec(clean(el.textContent));
    if (m) { announced = Number(m[1]); total = Number(m[2]); break; }
  }

  const secs = [...document.querySelectorAll("apply-flow-section")];
  const visibleIdx = secs.map((el, i) => (vis(el) ? i : -1)).filter((i) => i >= 0);

  // Pagination. The bar reads "Back 1 2 3 4 Next", so the NUMBERED buttons are step jumps and must
  // never be mistaken for the advance control — hence an anchored caption match, not a position.
  const pag = document.querySelector("apply-flow-pagination");
  const btns = pag ? [...pag.querySelectorAll('button, a[role="button"], input[type="button"], input[type="submit"]')].filter(vis) : [];
  const cap = (b) => clean(b.value || b.textContent);
  const enabled = (b) => !(b.disabled || b.getAttribute("aria-disabled") === "true");
  const next = btns.find((b) => /^(next|continue|save and continue|save & continue)\b/i.test(cap(b))) || null;
  const back = btns.find((b) => /^back\b/i.test(cap(b))) || null;

  // The submit control, document-wide but VISIBLE-filtered: ORC mounts every step at once, so an
  // inactive step's submit is present in the DOM at 0×0. Geometry is what excludes it, and on this
  // form geometry is the trustworthy signal.
  const submit = [...document.querySelectorAll('button, input[type="submit"]')]
    .filter(vis).find((b) => /^(submit|submit application)\b/i.test(cap(b))) || null;

  return {
    ok: true, url, step, announcedStep: announced, total,
    sectionCount: secs.length, visibleSections: visibleIdx,
    hasNext: !!next, nextCaption: next ? cap(next).slice(0, 40) : null, nextEnabled: !!(next && enabled(next)),
    hasBack: !!back,
    hasSubmit: !!submit, submitCaption: submit ? cap(submit).slice(0, 40) : null,
    // the error channel, so a refused advance can say WHY without a second read
    errors: [...document.querySelectorAll("cx-notifications [role=alert], .oj-messages-message, [role=alert]")]
      .filter(vis).map((e) => clean(e.textContent).slice(0, 160)).filter(Boolean).slice(0, 6),
  };
}

function atsInjOrcClickButton(patternSource, withinSel, forbidSource) {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  let re;
  try { re = new RegExp(patternSource, "i"); } catch (e) { return { ok: false, error: "bad-pattern" }; }
  const root = withinSel ? document.querySelector(withinSel) : document;
  if (!root) return { ok: false, error: "scope-not-found:" + withinSel };
  const btns = [...root.querySelectorAll('button, input[type="submit"], input[type="button"], a[role="button"]')].filter(vis);
  const hit = btns.find((b) => re.test(clean(b.value || b.textContent)));
  if (!hit) return { ok: false, error: "no-button-matching:" + patternSource, offered: btns.map((b) => clean(b.value || b.textContent).slice(0, 40)).slice(0, 8) };
  if (hit.disabled || hit.getAttribute("aria-disabled") === "true") return { ok: false, error: "button-disabled", caption: clean(hit.value || hit.textContent).slice(0, 40) };
  // ⚠⚠ SECOND GUARD ON THE ONE CLICK THAT COULD SUBMIT AN APPLICATION. The walk already refuses to
  // advance off a step that has no Next; this refuses to PRESS a caption the caller has forbidden,
  // inside the injected fn, using the caption actually resolved rather than the pattern that found
  // it. Defense in depth, exactly as Workday's clickPageNext refuses `review-page` independently of
  // the walk's own top-of-loop check — that footer button reuses Submit's automation-id, and the
  // whole reason two guards exist there is that one of them was once enough right up until it wasn't.
  const capHit = clean(hit.value || hit.textContent);
  if (forbidSource) {
    let bad = null;
    try { bad = new RegExp(forbidSource, "i"); } catch (e) { return { ok: false, error: "bad-forbid-pattern" }; }
    if (bad.test(capHit)) return { ok: false, error: "refused-forbidden-caption", caption: capHit.slice(0, 40) };
  }
  hit.click();
  return { ok: true, caption: capHit.slice(0, 40) };
}

// ── TYPE A ONE-TIME CODE INTO ORC'S SIX BOXES (injected; 2026-08-19) ─────────────────────
// ⚠ A VERIFICATION CODE IS TREATED WITH THE CREDENTIAL DISCIPLINE, not as ordinary field data:
// it returns a COUNT and never the digits, so the value cannot reach a log line, a record or the
// review bundle by way of this function's result. Same reasoning as atsInjSetCredential returning
// a length — the callers that log results are many, and the belt belongs at the source.
//
// Each box is one Knockout-bound `type=number` input with NO name, so the write is the house
// technique (native setter → `input` → `change`; a bare assignment leaves Knockout unaware — the
// measured ORC substrate finding). Boxes are written in the order the caller resolved them.
// ⚠ Cleared FIRST, for the same reason iCIMS' credential write is: a setter SETS rather than
// replaces, so a retry after a wrong or expired code would otherwise append into a 2-digit box.
function atsInjOrcFillPin(sels, code) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  const digits = String(code == null ? "" : code).replace(/\D+/g, "");
  const list = Array.isArray(sels) ? sels : [];
  if (!digits.length) return { ok: false, error: "no digits to enter" };
  if (digits.length !== list.length) return { ok: false, error: "code length " + digits.length + " does not match " + list.length + " boxes" };
  let filled = 0;
  for (let i = 0; i < list.length; i++) {
    const el = document.querySelector(list[i]);
    if (!el) return { ok: false, error: "box " + (i + 1) + " not found", filled };
    for (const v of ["", digits[i]]) {
      setter.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    // read back the LENGTH only — never the character
    if (String(el.value || "").length !== 1) return { ok: false, error: "box " + (i + 1) + " did not accept a digit", filled };
    filled++;
  }
  return { ok: true, filled };
}

// ── THE ORACLE PRE-FORM SCAN (injected; 2026-08-19) ──────────────────────────────────────
// Reports, classifies nothing — the judgement is orcApplyView + atsConsentKind + atsDecoyKind,
// SW-side, so there is ONE copy of each rule rather than an injected dup that can drift. Same
// split atsInjAuthScan / icimsAuthView already uses.
//
// ⚠ THE ONE PLACE THIS SCAN DOES EXERCISE JUDGEMENT IS THE HONEYPOT, AND THAT IS DELIBERATE.
// ORC's gate ships a bot-detection decoy beside the real email box that passes every visibility
// test (measured 179×38 and 200×38 on two tenants; see atsDecoyKind). If the scan merely
// *reported* it and left exclusion to the caller, then any caller bug puts a value in it — and
// that value is replayed on submit and marks the application as a bot, with no read-back able to
// notice because the write succeeds. So decoys are excluded from the candidate lists HERE, at the
// only point where a selector for one could be produced at all, AND reported separately so the
// run's log can say it was seen and skipped.
// ⚠ LOCKSTEP with atsDecoyKind (an injected fn cannot import): the generic aria-hidden + tabindex
// pair plus the honeypot name. atsDecoyKind stays the authority for judging REPORTED fields.
function atsInjOrcAuthScan() {
  const vis = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"));
  const selOf = (e) => (e && e.id ? "#" + esc(e.id) : (e && e.name ? '[name="' + esc(e.name) + '"]' : null));
  const labelOf = (e) => {
    let l = e.id ? document.querySelector('label[for="' + esc(e.id) + '"]') : null;
    if (!l) l = e.closest("label");
    return clean(l && l.textContent).slice(0, 90);
  };
  // LOCKSTEP with atsDecoyKind — see the note above.
  const isDecoy = (e) => {
    const nm = clean((e.name || "") + " " + (e.getAttribute("aria-label") || ""));
    if (/\bhoney[\s_-]?pot\b/i.test(nm)) return true;
    return e.getAttribute("aria-hidden") === "true" && e.getAttribute("tabindex") === "-1";
  };
  const describe = (e) => (e ? { sel: selOf(e), id: e.id || null, name: e.name || null,
    label: labelOf(e), type: String(e.type || "").toLowerCase(),
    prefilled: !!(e.value && String(e.value).length) } : null);

  const all = [...document.querySelectorAll("input:not([type=hidden]), select, textarea")];
  const decoys = all.filter(isDecoy).map((e) => ({ sel: selOf(e), name: e.name || null,
    ariaLabel: e.getAttribute("aria-label"), tabIndex: e.getAttribute("tabindex"),
    ariaHidden: e.getAttribute("aria-hidden"), cssClassAttr: e.getAttribute("cssclass") }));
  // Every candidate list below is drawn from this, so a decoy can never become a selector.
  const shown = all.filter((e) => vis(e) && !isDecoy(e));

  const pins = [...document.querySelectorAll('[id^="pin-code-"]')]
    .filter((e) => !isDecoy(e))
    .sort((a, b) => (parseInt(String(a.id).replace(/\D+/g, ""), 10) || 0) - (parseInt(String(b.id).replace(/\D+/g, ""), 10) || 0))
    .map((e) => "#" + esc(e.id));

  const emailEl = shown.find((e) => String(e.type || "").toLowerCase() === "email")
    || shown.find((e) => /^primary-email/.test(e.id || "") || /\b(e-?mail|username|login)\b/i.test(clean((e.name || "") + " " + labelOf(e))));
  const passEl = shown.find((e) => String(e.type || "").toLowerCase() === "password");

  const clickables = [...document.querySelectorAll('button, input[type="submit"], input[type="button"], a[role="button"]')].filter(vis);
  const cap = (b) => clean(b.value || b.textContent).slice(0, 60);
  const byText = (re) => { const b = clickables.find((x) => re.test(cap(x))); return b ? { sel: b.id ? "#" + esc(b.id) : null, caption: cap(b) } : null; };

  // The apply opener. Class is stable across tenants (`apply-now-button`); the caption is not
  // (localised sites), so key on the class and report the caption for the log only.
  const applyEl = document.querySelector("button.apply-now-button");

  // Same VISIBLE-challenge rule as atsInjAuthScan: a dormant invisible-mode container is a
  // full-viewport hidden iframe and must not read as a challenge.
  const captchaChallenge = [...document.querySelectorAll('iframe[src*="hcaptcha"], iframe[src*="recaptcha"]')].some((f) => {
    const cs = getComputedStyle(f);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.1) return false;
    const r = f.getBoundingClientRect();
    return r.width > 60 && r.height > 60 && r.width < 700;
  });

  // Consent boxes are REPORTED with their surrounding text; atsConsentKind decides. Only an
  // "accept" is ever ticked, and never an opt-in or an attestation.
  const consents = [...document.querySelectorAll('input[type="checkbox"]')].filter((e) => vis(e) || (e.getBoundingClientRect().width === 0 && e.closest("label")))
    .filter((e) => !isDecoy(e))
    .map((e) => {
      const row = e.closest(".input-row, .legal-disclaimer-container, div");
      // ⚠ THE PAGE'S OWN FILING BEATS ITS PROSE. Oracle wraps its job-alerts box in
      // <job-alerts-opt-in>/<opt-in> while WORDING it as an acceptance ("I agree to receive new job
      // opportunities…"), which the text recognizer read as `accept` — i.e. it would have been
      // ticked. So the enclosing custom-element names travel with the report and atsConsentKind
      // consults them FIRST. Reported, not judged, here: the rule stays in one SW-side place.
      const containers = [];
      for (let p = e.parentElement; p && containers.length < 6; p = p.parentElement) {
        const n = p.tagName.toLowerCase();
        if (n.includes("-")) containers.push(n);
      }
      return { sel: selOf(e), checked: !!e.checked, label: labelOf(e),
        id: e.id || null, name: e.name || null, containers,
        rowText: clean(row && row.textContent).slice(0, 220),
        // the CSS-clipped box is clicked through its LABEL (the Workday radio rule)
        labelSel: e.id ? 'label[for="' + esc(e.id) + '"]' : null };
    }).slice(0, 8);

  const secs = [...document.querySelectorAll("apply-flow-section")];
  return {
    ok: true, url: location.href, title: document.title,
    // The form's own structural tell — measured absent (0) on the gate and the pin screen.
    formSectionVisible: secs.some(vis), sectionCount: secs.length,
    emailGate: !!document.querySelector("quick-email-verification-form"),
    emailInput: describe(emailEl), passwordInput: describe(passEl),
    pinInputs: pins.length, pinSels: pins,
    submit: byText(/^(next|verify|continue|sign in|log ?in|submit)\b/i),
    resend: byText(/send\s+new\s+code|resend/i),
    applyControl: applyEl ? { sel: "button.apply-now-button", caption: cap(applyEl) } : null,
    federated: clickables.map(cap).filter((t) => /\b(with|using)\s+(google|linkedin|apple|microsoft|facebook)\b|\b(sso|single sign[ -]?on)\b/i.test(t)).slice(0, 5),
    createAccount: clickables.map(cap).filter((t) => /\b(create (an? )?account|register|sign ?up)\b/i.test(t)).slice(0, 5),
    captchaChallenge, consents, decoys,
    errors: [...document.querySelectorAll('[role="alert"], .error, .cx-error, cx-notifications')].filter(vis)
      .map((e) => clean(e.textContent)).filter(Boolean).slice(0, 4),
  };
}

// ── ORC REPEATING BLOCKS: the entry lifecycle (2026-08-19) ───────────────────────────────
// A repeating section on ORC is an `<apply-flow-block>` identified by its `<apply-flow-block-title>`,
// holding an Add control. Pressing it materialises the entry form's fields INSIDE THAT BLOCK through
// the ordinary `<form-builder>`.
//
// ⚠ DO NOT KEY ON THE TIMELINE ELEMENTS. Baylor renders entries through `<beautiful-timeline>` →
// `<timeline-form-inline>` → `<timeline-form-builder>`; Oracle has NONE of those and renders in-block.
// The block + its title is the only portable handle, which is why this takes a title pattern.
//
// ⚠⚠ THE COMMIT BUTTON IS A HOMONYM OF THE OPENER. Both read "Add Experience", and on Oracle both
// live in the SAME block — so scoping by container cannot separate them (recon (c) proposed exactly
// that, and it does not work here). The discriminator is the sibling **Cancel**, which exists only
// while an entry form is open:
//
//     block closed → [ "Add Experience" ]
//     block OPEN   → [ "Cancel", "Add Experience" ]   ← the second one COMMITS
//
// Verified in both directions: after pressing Cancel the block returned to 0 inputs and Cancel
// disappeared. So `open` refuses when a form is already open, and `commit` refuses when one is not —
// each would otherwise press the other's button.
var ATS_ORC_ENTRY_MAX = 8;   // same backstop as ATS_ENTRY_MAX: a runaway Add loop is worse than a short history

// ⚠ A REPEATING BLOCK WITH ZERO INPUTS CANNOT BE FOUND BY THE FIELD SCAN, which is the whole reason
// this read exists. ORC builds Experience / Education entries ON DEMAND — recon measured §3 at "0
// inputs" — so the block is a heading and an Add button and nothing else until something is pressed.
// The scan derives a field's block from its ANCESTOR, so a block with no fields contributes nothing
// and the entry pass would conclude the section is absent. Live 2026-08-19 that is exactly what
// happened: step 2 reported 4 fields (three uploads and a link) and the whole employment history
// went unfilled, with nothing in the log saying a block had been skipped.
function atsInjOrcBlocks() {
  const t = (el) => ((el && el.textContent) || "").replace(/\s+/g, " ").trim();
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  // VISIBLE blocks only, and for the standing ORC reason: every step is mounted at once and the
  // inactive ones report aria-hidden="false" at 0×0, so geometry is the trustworthy signal here.
  return { ok: true, blocks: [...document.querySelectorAll("apply-flow-block")].filter(vis)
    // ⚠ COUNT WHAT CAN BE ANSWERED, NOT WHAT IS AN `<input>`. ORC's yes/no questions are BUTTON
    // pairs, so a block holding three of them counted 0 and the settle spent 15s concluding it was
    // still loading — of a block that was visible at 680×331 with every question rendered. "Zero
    // inputs" and "nothing to answer" are different claims and this read was making the wrong one.
    .map((b) => ({ title: t(b.querySelector("apply-flow-block-title")),
                   inputs: b.querySelectorAll("input, textarea, select").length
                         + b.querySelectorAll("ul.cx-select-pills-container").length,
                   addCaption: ([...b.querySelectorAll("button")].filter(vis).map(t)
                     .find((c) => /^add\b/i.test(c))) || null }))
    .filter((b) => b.title) };
}

// ⚠⚠ WHAT DID THE SCAN NOT SEE? A scan is a CONVENIENCE LIST, NOT AN INVENTORY — the Workday lesson,
// written down there after an approved field turned out to be absent from `cdpPageScan.fields` twice
// live. This makes the same gap VISIBLE on Oracle instead of leaving it to be noticed by a human
// reading the form: live 2026-08-19 step 3 recorded 7 fields while the operator could see THREE
// REQUIRED yes/no application questions on it, and nothing anywhere said a control had been missed.
// A missing required field is not a cosmetic gap — it blocks the step and the walk halts on a page
// that looks, in the log, like it filled cleanly.
//
// It reports rather than classifies (the standing split: the page answers what it can observe, the
// judgement lives SW-side), and it reports the ROW CLASS specifically, because the ORC classifier
// keys the widget off `div.input-row--<kind>` — so an unrecognised row class is the answer to "why
// was this not scanned?" in the same line that raises the question.
function atsInjOrcUnclaimed(claimedNames) {
  const t = (el) => ((el && el.textContent) || "").replace(/\s+/g, " ").trim();
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const claimed = new Set((claimedNames || []).map(String));
  const secs = [...document.querySelectorAll("apply-flow-section")].filter(vis);
  if (!secs.length) return { ok: true, unclaimed: [] };

  const seen = new Map();   // group key → report
  for (const sec of secs) {
    const controls = [...sec.querySelectorAll("input, select, textarea")]
      .filter((e) => e.type !== "hidden" && vis(e));
    for (const e of controls) {
      // ⚠ A DECOY IS NOT AN OVERSIGHT. Same declared-intent test as the scan (LOCKSTEP with
      // atsDecoyKind): reporting the honeypot as "a field we missed" would invite someone to fix it
      // by filling it, which is the one thing that must never happen.
      const nm = ((e.name || "") + " " + (e.getAttribute("aria-label") || "")).replace(/\s+/g, " ");
      if (/\bhoney[\s_-]?pot\b/i.test(nm)) continue;
      if (e.getAttribute("aria-hidden") === "true" && e.getAttribute("tabindex") === "-1") continue;

      // Radios and checkboxes group by `name`, so a yes/no pair reports ONCE rather than twice —
      // otherwise a three-question step reads as six missing controls.
      const isGroup = e.type === "radio" || e.type === "checkbox";
      const key = (isGroup && e.name) ? "group:" + e.name : (e.name || e.id || "");
      if (!key) continue;
      // ⚠ THE SCAN KEYS A GROUP TWO WAYS — `group:<name>` when the inputs share a name, and
      // `group:<label-slug>` when they do not (measured: `group:ethnicity` next to
      // `group:select-the-races-you-identify-with` on one step). Testing only one shape makes the
      // OTHER one look unscanned, so a correctly-filled races group would be reported as missing
      // every run and the real signal would be lost in it.
      const slug = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const rowEl = e.closest("div.input-row") || e.closest("[class*=input-row]");
      const q = isGroup
        ? ((e.closest("fieldset") && e.closest("fieldset").querySelector("legend") ? t(e.closest("fieldset").querySelector("legend")) : "")
           || t(rowEl ? rowEl.querySelector(".input-row__label, label") : null))
        : "";
      if (claimed.has(e.name || "") || claimed.has(e.id || "") || claimed.has(key)) continue;
      if (isGroup && q && claimed.has("group:" + slug(q))) continue;
      // ⚠ OVER-REPORTING IS THE SAFE DIRECTION and this stays a DIAGNOSTIC: a false positive costs
      // one noisy log line, while a miss costs a required field that silently never gets filled. The
      // line carries the row class, the block and the question, which is enough to dismiss a false
      // positive at a glance.
      if (seen.has(key)) { const r = seen.get(key); r.count++; if (isGroup && t(e.closest("label")) ) r.options.push(t(e.closest("label")).slice(0, 40)); continue; }

      const row = e.closest("div.input-row") || e.closest("[class*=input-row]");
      const rowClass = row ? String(row.className || "").split(/\s+/).filter((c) => /input-row/.test(c)).join(" ") : null;
      const block = e.closest("apply-flow-block");
      const lbl = (e.id ? t(document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(e.id) : e.id) + '"]')) : "")
        || t(e.closest("label")) || e.getAttribute("aria-label") || "";
      // The QUESTION for a grouped control is the fieldset's legend, not the option's own label.
      const legend = isGroup ? (t((e.closest("fieldset") || {}).querySelector ? e.closest("fieldset").querySelector("legend") : null)
        || t(row ? row.querySelector(".input-row__label, label") : null)) : "";
      seen.set(key, {
        key, name: e.name || null, id: e.id || null, type: e.type, tag: e.tagName.toLowerCase(),
        role: e.getAttribute("role") || null, grouped: isGroup, count: 1,
        question: (legend || lbl || "").slice(0, 120),
        options: isGroup && t(e.closest("label")) ? [t(e.closest("label")).slice(0, 40)] : [],
        rowClass, block: block ? t(block.querySelector("apply-flow-block-title")).slice(0, 60) : null,
        required: e.required === true || e.getAttribute("aria-required") === "true"
          || !!(row && /required/.test(String(row.className || ""))),
      });
    }
  }
  // ⚠⚠ AND THE CONTROLS THAT ARE NOT NATIVE ELEMENTS AT ALL. The sweep above queries
  // `input, select, textarea`, which is every control ORC has used so far — and it reported NOTHING
  // on a step the operator could see three REQUIRED yes/no application questions on. Oracle JET
  // renders its own widgets as custom elements (`oj-radioset`, `oj-select-single`, …) with ARIA
  // roles instead of native inputs, so a question can be plainly visible, plainly required, and
  // invisible to every selector this file uses.
  //
  // Reported SEPARATELY from the native list because the two mean different things: a native control
  // we missed is a classifier gap, while an ARIA-only control is a whole widget FAMILY with no
  // handler. Conflating them would make the second look like the first and send the fix at the row
  // classifier, which cannot see these at all.
  const aria = [];
  const ROLES = "[role=radiogroup], [role=radio], [role=combobox], [role=listbox], [role=checkbox], [role=spinbutton], [role=switch]";
  for (const sec of secs) {
    // Custom elements first: their tag name is the most useful single fact about them, because it
    // names the JET component and therefore what a handler would have to drive.
    const custom = [...sec.querySelectorAll("*")].filter((e) => e.tagName.indexOf("-") > 0 && vis(e));
    for (const e of custom) {
      const tag = e.tagName.toLowerCase();
      if (!/^oj-|-form$|^apply-flow|^form-builder|^cx-/.test(tag)) continue;
      // only leaves that actually look like a CONTROL — a layout custom element is not a field
      if (!e.matches(ROLES) && !e.querySelector(ROLES) && !e.hasAttribute("required") && e.getAttribute("aria-required") !== "true") continue;
      // …and skip one that merely CONTAINS native controls the sweep above already accounted for
      if (e.querySelector("input, select, textarea")) continue;
      const lbl = t(e.querySelector("[class*=label], label, legend")) || e.getAttribute("aria-label") || "";
      aria.push({ tag, role: e.getAttribute("role") || (e.querySelector(ROLES) ? e.querySelector(ROLES).getAttribute("role") : null),
        id: e.id || null, question: (lbl || "").slice(0, 120),
        required: e.hasAttribute("required") || e.getAttribute("aria-required") === "true",
        options: [...e.querySelectorAll("[role=radio], [role=option]")].map((o) => t(o).slice(0, 40)).filter(Boolean).slice(0, 6),
        block: (e.closest("apply-flow-block") ? t(e.closest("apply-flow-block").querySelector("apply-flow-block-title")).slice(0, 60) : null) });
    }
    // …then any bare ARIA control that is not inside one of those and not a native element.
    for (const e of [...sec.querySelectorAll(ROLES)].filter(vis)) {
      if (/^(input|select|textarea)$/i.test(e.tagName)) continue;
      if (e.closest("oj-radioset, oj-select-single, oj-select-many, oj-combobox-one")) continue;
      if (aria.some((a) => a.id && a.id === e.id)) continue;
      // ⚠⚠ A WRAPPER AROUND NATIVE INPUTS IS NOT AN UNHANDLED WIDGET. ORC marks a native radio group
      // with `<div role="radiogroup">` around real `<input type=radio>`s, and this reported the
      // disability question as "an ARIA-only control with NO handler" on a run where that very field
      // came back `filled_review`. The custom-element branch above already excluded this shape; the
      // bare-ARIA branch did not.
      //
      // Left unfixed it is worse than a cosmetic bug: this sweep exists to surface a REAL missing
      // widget family, and a false positive on every native radiogroup is precisely the noise that
      // would bury the thing it was built to find. Over-reporting is the safe direction for the
      // NATIVE list, where the cost is a line; here the cost is the signal itself.
      if (e.querySelector("input, select, textarea")) continue;
      aria.push({ tag: e.tagName.toLowerCase(), role: e.getAttribute("role"), id: e.id || null,
        question: (t(e.closest("[class*=input-row]") ? e.closest("[class*=input-row]").querySelector("[class*=label], label, legend") : null) || e.getAttribute("aria-label") || "").slice(0, 120),
        required: e.getAttribute("aria-required") === "true",
        options: [...e.querySelectorAll("[role=radio], [role=option]")].map((o) => t(o).slice(0, 40)).filter(Boolean).slice(0, 6),
        block: (e.closest("apply-flow-block") ? t(e.closest("apply-flow-block").querySelector("apply-flow-block-title")).slice(0, 60) : null) });
    }
  }
  return { ok: true, unclaimed: [...seen.values()], aria };
}

// Scroll named blocks into view. READ-ONLY in the sense that matters: it moves the viewport and
// touches nothing else, so it cannot change an answer — which is what makes it a safe probe for
// "does this block render only when looked at?".
function atsInjOrcScrollBlocks(titles) {
  const t = (el) => ((el && el.textContent) || "").replace(/\s+/g, " ").trim();
  const want = new Set((titles || []).map(String));
  let n = 0;
  for (const b of document.querySelectorAll("apply-flow-block")) {
    const title = t(b.querySelector("apply-flow-block-title"));
    if (!want.has(title)) continue;
    try { b.scrollIntoView({ block: "center" }); n++; } catch (e) { /* older engines */ }
  }
  return { ok: true, scrolled: n };
}

// ⚠⚠ A COMMITTED ENTRY IS A **TILE**, AND ITS CONTROLS ARE ICON-ONLY (live 2026-08-20).
// Measured on a returning candidate's form:
//   <button class="apply-flow-profile-item-tile__edit-item-icon"  aria-label="Edit">    (no text)
//   <button class="apply-flow-profile-item-tile__delete-icon"     aria-label="Delete">  (no text)
//   …and the Add control is button.apply-flow-profile-item-tile__new-tile ("Add Experience")
// The tile's own text is the entry summary:
//   "Characterization and Test Automation Intern Rivian and Volkswagon Technologies 05/2026 - 08/2026"
//
// The first attempt at detecting pre-existing entries matched button CAPTIONS against
// /^(edit|delete|remove)/ and counted ZERO, because these buttons have no textContent at all — so the
// guard did not fire and a second run duplicated the history again. The label is in `aria-label`
// and `title`, never in the text. Skills render ONE TILE PER SKILL, which is what makes
// "only add the ones that are missing" possible at all.
// The `<candidate-links>` repeating family. Its control is `name="siteLink-<n>"` `type="url"` and the
// add control is `button.candidate-links__add-link` ("Add Another Link"). The ordinal lives in the
// NAME (the trailing `-7` on the id is the render counter), so it is a POSITION and safe to index by.
// ⚠⚠ ONE OPEN PER PICKER: CLASSIFY AND COMMIT IN THE SAME VISIT (speed round, 2026-08-20).
// The date pair used to CAPTURE each half's options (open → poll → Escape) and then PICK it
// (open → type → match → click) — four opens per pair, and the operator noticed exactly that: "it
// opens the dropdown before going back and filling it when it could definitely fill it just once."
//
// Measured cost of the split: `startDate` ~11s while `endDate` — same widget, same code — cost ~2s.
// The difference is that startDate is the FIRST picker touched in a freshly-created entry form, where
// the open-click does not register because the combobox is not wired yet. The capture then polled its
// WHOLE 8s budget for rows that were never going to appear, and only the retry's second click worked.
// That is ~8s wasted per entry, ~24s across three — and it is also the "sometimes it lags until I
// click the page" symptom, because the run is sitting in a poll on a picker that never opened.
//
// So: open, and if no rows appear quickly, CLICK AGAIN (the cheap, targeted fix for an open that did
// not take) rather than waiting out a budget. Then classify from the rows in front of us and click the
// matching one. Classification stays evidence-based — each half is still judged by its OWN options, so
// a tenant that renders year-then-month is still handled — it just no longer costs a second visit.
async function atsInjOrcPickFromOwnList(inputSel, monthCands, yearCands, budgetMs) {
  const t = (el) => ((el && el.textContent) || "").replace(/\s+/g, " ").trim();
  const norm = (v) => String(v == null ? "" : v).toLowerCase().replace(/\s+/g, " ").trim();
  const el = document.querySelector(inputSel);
  if (!el) return { ok: false, error: "not-found:" + inputSel };
  const lbId = el.getAttribute("aria-controls") || (el.id ? el.id + "-listbox" : null);
  const readRows = () => {
    const lb = lbId ? document.getElementById(lbId) : null;
    return lb ? [...lb.querySelectorAll('[role="row"]')] : [];
  };
  const deadline = Date.now() + (budgetMs || 6000);
  el.focus();
  el.click();
  let rows = [], reopens = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 120));
    rows = readRows();
    if (rows.length) break;
    // ⚠ AN OPEN THAT DID NOT TAKE IS RE-CLICKED, not waited out. Two extra clicks at ~700ms and
    // ~1400ms cost almost nothing and replace an 8-second stall.
    const waited = Date.now() - (deadline - (budgetMs || 6000));
    if (reopens < 2 && waited > (reopens + 1) * 700) { reopens++; el.click(); }
  }
  if (!rows.length) return { ok: false, error: "no-rows", reopens };

  const texts = rows.map(t);
  const yearish = texts.filter((x) => /^\s*(19|20)\d{2}\s*$/.test(x)).length;
  const monthish = texts.filter((x) => /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(x)).length;
  const kind = yearish > monthish ? "year" : (monthish > 0 ? "month" : null);
  if (!kind) return { ok: false, error: "unclassified", rows: texts.slice(0, 4), reopens };

  const cands = (kind === "year" ? yearCands : monthCands) || [];
  // The wording the picker itself uses for this value ("May" / "05" / "5" are all shapes a tenant
  // may render), taken from the rows in front of us rather than from a hardcoded table.
  let want = null;
  for (const c of cands) {
    const row = rows.find((r) => norm(t(r)) === norm(c));
    if (row) { want = t(row); break; }
  }
  if (!want) return { ok: false, error: "no-match", kind, rows: texts.slice(0, 6), reopens };

  // ⚠⚠ THE COMMIT IS TYPE-THEN-**ENTER**, NOT A CLICK ON THE ROW. Measured 2026-08-20: the first
  // version of this clicked the matching row with the full pointer sequence and ORC ignored it —
  // both halves of every date came back `commit-not-accepted … got nothing`. atsInjOrcPick has always
  // committed by typing the value and pressing Enter on the INPUT, and that is the mechanism this
  // widget actually honours. Fusing the visits was the right idea; changing the commit with it was
  // not, and it cost a run to find out.
  //
  // Typing re-filters the list, which is fine — it filters TO the value we already confirmed is
  // present, so this cannot invent a match that was not there.
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  el.focus();
  setter.call(el, "");
  el.dispatchEvent(new Event("input", { bubbles: true }));
  for (const ch of String(want)) {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
    setter.call(el, el.value + ch);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
  }
  // Let the filtered list settle before Enter — polled on the rows, not a flat sleep.
  for (let i = 0; i < 14; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const now = readRows().map(t);
    if (now.some((x) => norm(x) === norm(want))) break;
  }
  el.focus();
  for (const type of ["keydown", "keypress", "keyup"]) {
    el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  }

  // ⚠⚠ THE READ-BACK SETTLES **HERE**, PAGE-SIDE, AND THAT IS THE WHOLE POINT (speed round,
  // 2026-08-20). Shortening the SW-side poll from 150ms to 80ms bought nothing, because the MV3
  // worker's timers are STARVED: the run's own PACE warnings measured `a 80ms pace took 1226ms` and
  // `a 150ms pace took 1555ms`. So the cost of a poll is the NUMBER of awaits, not their length —
  // sixteen 80ms SW awaits is sixteen ~1s stalls, which is exactly the 5067ms / 3200ms / 1701ms gaps
  // that showed up between an entry form's discovery read and its first 20ms text write.
  //
  // Page-side timers are real, so settling in here costs the caller ONE cdpEval round-trip instead of
  // sixteen starved ones. `value` comes back with the result and the SW does no further waiting.
  //
  // ⚠ This does NOT relax the house rule that pacing lives SW-side. That rule exists because a hidden
  // or throttled tab's page timers stall — and it is about PACING (spacing actuation so a throttled
  // page keeps up). This is a read-back SETTLE on a visible tab, bounded by the caller's own budget,
  // and if the page never settles it simply returns `value: null` and the caller reports the failure
  // exactly as before. Nothing is assumed from a timer that did not fire.
  let value = null, invalid = false;
  const vDeadline = Date.now() + 2500;
  while (Date.now() < vDeadline) {
    await new Promise((r) => setTimeout(r, 60));
    const v = String(el.value || "").trim();
    invalid = /cx-select-input--invalid/.test(String(el.className || ""));
    if (v && !invalid) { value = v; break; }
  }
  return { ok: true, kind, committed: want, reopens, value, invalid };
}

function atsInjOrcLinks() {
  const t = (el) => ((el && el.textContent) || "").replace(/\s+/g, " ").trim();
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const inputs = [...document.querySelectorAll('input[name^="siteLink"]')].filter(vis);
  const add = [...document.querySelectorAll("button, a[role=button]")].filter(vis)
    .find((b) => /add another link/i.test(t(b)) || /candidate-links__add-link/.test(String(b.className || "")));
  return { ok: true, count: inputs.length, addPresent: !!add,
    links: inputs.map((e) => ({ name: e.name || null, id: e.id || null, value: String(e.value || "").trim() })) };
}

function atsInjOrcAddLink() {
  const t = (el) => ((el && el.textContent) || "").replace(/\s+/g, " ").trim();
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const add = [...document.querySelectorAll("button, a[role=button]")].filter(vis)
    .find((b) => /add another link/i.test(t(b)) || /candidate-links__add-link/.test(String(b.className || "")));
  if (!add) return { ok: false, error: "no-add-link-control" };
  if (add.disabled || add.getAttribute("aria-disabled") === "true") return { ok: false, error: "add-link-disabled" };
  add.click();
  return { ok: true };
}

function atsInjOrcTiles(blockTitlePattern) {
  const t = (el) => ((el && el.textContent) || "").replace(/\s+/g, " ").trim();
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  let re;
  try { re = new RegExp(blockTitlePattern, "i"); } catch (e) { return { ok: false, error: "bad-pattern" }; }
  const block = [...document.querySelectorAll("apply-flow-block")].filter(vis)
    .find((b) => re.test(t(b.querySelector("apply-flow-block-title"))));
  if (!block) return { ok: false, error: "block-not-found:" + blockTitlePattern };

  // A tile is identified by its DELETE control, then walked up to the smallest ancestor that holds
  // exactly that one control — the tile itself. Keyed off the control rather than a tile class so a
  // tenant that renames the wrapper still works.
  const dels = [...block.querySelectorAll("button, a[role=button]")].filter(vis)
    .filter((b) => /delete|remove/i.test(String(b.getAttribute("aria-label") || b.getAttribute("title") || "")));
  const tiles = dels.map((del) => {
    let tile = del.parentElement;
    for (let i = 0; i < 5 && tile; i++) {
      if (tile.querySelectorAll("button, a[role=button]").length > 3) break;   // walked too far — into the block
      const txt = t(tile);
      // ⚠ `> 0`, NOT `> 1`. The text is already trimmed, so a length test above zero drops nothing
      // real — and `> 1` dropped the skill **"C"**, which came back as "" and would have looked
      // ABSENT on every visit, re-added forever. One-character skills are ordinary (C, R, Go).
      if (txt && txt.length > 0) return { text: txt.slice(0, 140) };
      tile = tile.parentElement;
    }
    return { text: t(del.parentElement).slice(0, 140) };
  });
  const add = [...block.querySelectorAll("button, a[role=button]")].filter(vis)
    .find((b) => /^add\b/i.test(t(b)));
  return { ok: true, count: tiles.length, tiles, addCaption: add ? t(add) : null };
}

// Press a tile's Delete, then REPORT whatever appeared. ORC may put a confirmation in front of it,
// and a surprise modal is exactly what wedges a run — so this never assumes, it describes.
// ⚠ It reports the dialog rather than dismissing it: the judgement about pressing a confirm belongs
// SW-side, like every other consequential decision in this file.
function atsInjOrcDeleteTile(blockTitlePattern, index) {
  const t = (el) => ((el && el.textContent) || "").replace(/\s+/g, " ").trim();
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  let re;
  try { re = new RegExp(blockTitlePattern, "i"); } catch (e) { return { ok: false, error: "bad-pattern" }; }
  const block = [...document.querySelectorAll("apply-flow-block")].filter(vis)
    .find((b) => re.test(t(b.querySelector("apply-flow-block-title"))));
  if (!block) return { ok: false, error: "block-not-found" };
  const dels = [...block.querySelectorAll("button, a[role=button]")].filter(vis)
    .filter((b) => /delete|remove/i.test(String(b.getAttribute("aria-label") || b.getAttribute("title") || "")));
  const i = index == null ? dels.length - 1 : index;      // last-first keeps earlier indexes stable
  if (i < 0 || i >= dels.length) return { ok: false, error: "no-such-tile", count: dels.length };
  dels[i].click();
  const dlg = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], oj-dialog')].filter(vis);
  return { ok: true, remaining: dels.length - 1,
    dialog: dlg.length ? { present: true, text: t(dlg[0]).slice(0, 160),
      buttons: [...dlg[0].querySelectorAll("button")].filter(vis).map((b) => t(b)).slice(0, 6) } : { present: false } };
}

// Press a named control inside a visible dialog. Separate from the delete so the caller decides.
function atsInjOrcDialogPress(patternSource) {
  const t = (el) => ((el && el.textContent) || "").replace(/\s+/g, " ").trim();
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  let re;
  try { re = new RegExp(patternSource, "i"); } catch (e) { return { ok: false, error: "bad-pattern" }; }
  const dlg = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], oj-dialog')].filter(vis)[0];
  if (!dlg) return { ok: false, error: "no-dialog" };
  const hit = [...dlg.querySelectorAll("button")].filter(vis).find((b) => re.test(t(b)));
  if (!hit) return { ok: false, error: "no-button", offered: [...dlg.querySelectorAll("button")].filter(vis).map((b) => t(b)).slice(0, 6) };
  hit.click();
  return { ok: true, pressed: t(hit) };
}

function atsInjOrcEntryState(blockTitlePattern) {
  const t = (el) => ((el && el.textContent) || "").replace(/\s+/g, " ").trim();
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  let re;
  try { re = new RegExp(blockTitlePattern, "i"); } catch (e) { return { ok: false, error: "bad-pattern" }; }
  const block = [...document.querySelectorAll("apply-flow-block")]
    .filter(vis)
    .find((b) => re.test(t(b.querySelector("apply-flow-block-title"))));
  if (!block) return { ok: false, error: "block-not-found:" + blockTitlePattern };
  const buttons = [...block.querySelectorAll("button")].filter(vis).map((b) => t(b)).filter(Boolean);
  // An OPEN entry form is the one state we can read without ambiguity.
  const open = buttons.some((c) => /^cancel$/i.test(c));
  const fields = [...block.querySelectorAll("input, textarea, select")].filter((e) => e.type !== "hidden" && vis(e))
    .map((e) => ({ id: e.id || null, name: e.name || null, type: e.type,
      role: e.getAttribute("role") || null,
      label: (e.id ? t(document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(e.id) : e.id) + '"]')) : "") || e.getAttribute("aria-label") || "",
      value: e.value || null }));
  // ⚠⚠ WHAT IS ALREADY HERE? (live 2026-08-20) A run landed on a form Oracle had PREFILLED from an
  // existing candidate record, and the pass pressed Add three times on top of it — leaving TWO copies
  // of every job. Workday's repeating-section rule is "reconcile to exactly N, then fill each entry —
  // true idempotency, proven from ARBITRARY dirty state", and only the second half of that was ever
  // built here. Add-N-times is correct on a blank form and duplicates on every other kind.
  //
  // Counting is a READ, and it is reported rather than interpreted: `entryControls` are the per-row
  // controls a committed entry renders (Edit / Delete / Remove), which is the only count available —
  // a saved entry leaves no live inputs behind. The captions come back too, because the structure of a
  // POPULATED block has never been observed and this log is what will describe it.
  const rowCtl = [...block.querySelectorAll("button, a[role=button]")].filter(vis)
    .map((b) => t(b)).filter((c) => /^(edit|delete|remove)\b/i.test(c));
  return { ok: true, title: t(block.querySelector("apply-flow-block-title")), open, buttons, fields,
    entryControls: rowCtl.length, entryControlCaptions: rowCtl.slice(0, 8),
    // every distinct caption in the block, so one run describes a populated block completely
    allCaptions: buttons.slice(0, 12),
    // rows already committed: a saved entry leaves no live inputs, so the block's own list length is
    // the only count available. Reported, not interpreted.
    addCaption: buttons.find((c) => /^add\b/i.test(c)) || null };
}

// `action`: "open" | "commit" | "cancel". Refuses rather than pressing the wrong homonym.
// ⚠⚠ OPEN-AND-WAIT IN ONE CALL, because the WAIT is what costs (speed round, 2026-08-20).
// The SW-side poll for "has the entry form appeared" was 28 awaits of 150ms; the MV3 worker's timers
// are starved, so each of those is ~1s in practice — the run's own PACE lines measured `a 150ms pace
// took 1555ms`. That is the 5067ms / 3200ms / 1701ms gap between an entry form's discovery read and
// its first 20ms text write.
//
// Page-side timers are real, so waiting here costs ONE cdpEval instead of N starved ones. The wait is
// bounded and it reports what it saw: a form that never appeared comes back `fields: 0` and the caller
// halts the block exactly as before — nothing is assumed from a timer that did not fire.
async function atsInjOrcOpenEntryAndWait(blockTitlePattern, budgetMs) {
  const t = (el) => ((el && el.textContent) || "").replace(/\s+/g, " ").trim();
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  let re;
  try { re = new RegExp(blockTitlePattern, "i"); } catch (e) { return { ok: false, error: "bad-pattern" }; }
  const findBlock = () => [...document.querySelectorAll("apply-flow-block")].filter(vis)
    .find((b) => re.test(t(b.querySelector("apply-flow-block-title"))));
  const block0 = findBlock();
  if (!block0) return { ok: false, error: "block-not-found:" + blockTitlePattern };
  const btns0 = [...block0.querySelectorAll("button")].filter(vis);
  if (btns0.some((b) => /^cancel$/i.test(t(b)))) return { ok: false, error: "entry-already-open" };
  const add = btns0.find((b) => /^add\b/i.test(t(b)));
  if (!add) return { ok: false, error: "no-add-control", offered: btns0.map((b) => t(b)).slice(0, 6) };
  add.click();

  const deadline = Date.now() + (budgetMs || 6000);
  let fields = [];
  const before = [...block0.querySelectorAll("input, textarea, select")]
    .filter((e) => e.type !== "hidden" && vis(e)).length;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 80));
    const block = findBlock();
    if (!block) continue;
    // ⚠⚠ THE EVIDENCE THAT A FORM OPENED IS THAT **INPUTS APPEARED**, not that a button says
    // "Cancel" (operator, 2026-08-20). Requiring the Cancel caption made this report
    // `pressed "Add Experience" but no entry form appeared` on a form whose entry fields were
    // plainly there — the tenant simply does not render that button, or words it differently.
    // A caption is tenant wording; a control that did not exist a moment ago is structure.
    //
    // The Cancel test still earns its keep on the COMMIT side, where it disambiguates the Add
    // homonym — but even there it is now backed up by the input count, below.
    const live = [...block.querySelectorAll("input, textarea, select")]
      .filter((e) => e.type !== "hidden" && vis(e));
    if (live.length > before) {
      fields = live.map((e) => ({ id: e.id || null, name: e.name || null, type: e.type,
        role: e.getAttribute("role") || null,
        label: (e.id ? t(document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(e.id) : e.id) + '"]')) : "") || e.getAttribute("aria-label") || "",
        value: e.value || null }));
      break;
    }
  }
  return { ok: true, pressed: t(add), fields, count: fields.length };
}

// ── THE RÉSUMÉ IS ALWAYS REMOVED AND REPLACED ON A REPLAY (operator, 2026-08-21) ─────────────
// "A rehearsal should only remove and replace the resume since there is no way to tell which is
// actually uploaded." That is the exact reason it is the ONE exception to read-before-write: every
// other field can be verified by LOOKING at the page, but a file field shows only a NAME, and a
// filename says nothing about which bytes the server is holding. Re-uploading is the only way to
// know, so the résumé is re-uploaded unconditionally.
//
// This also fixes the failure that exposed it: on the re-visit ORC renders the ATTACHED state
// instead of the upload control, so `resume-upload` was absent from the scan entirely and the strict
// verify reported the approved résumé as "no matching field on the live form". Removing it first
// brings the file input back, after which the ORDINARY field loop attaches it — no second attach
// path, and the route that maps exactly one field to the résumé still decides which slot gets it.
//
// ⚠ IT REPORTS WHAT IT FOUND RATHER THAN ASSUMING. I have not seen ORC's attached-résumé markup, and
// inventing a selector for it is what the trace-first rule exists to prevent — so the remove control
// is discovered the same way the tile controls are (aria-label / title / text), and when there is no
// such control this returns the controls it DID see. That way a miss is a diagnosable report instead
// of a silent no-op, and the next run has the DOM evidence.
async function atsInjOrcResumeReset(budgetMs) {
  const t = (el) => ((el && el.textContent) || "").replace(/\s+/g, " ").trim();
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const FILE_RE = /\.(pdf|docx?|rtf|txt|odt)\b/i;
  const findWrap = () => {
    const own = [...document.querySelectorAll("resume-upload-button")].filter(vis)[0];
    if (own) return own;
    // Fall back to the row/block whose own label names a résumé — never a document-wide sweep, so a
    // cover-letter or attachment slot can never be mistaken for it.
    return [...document.querySelectorAll("div.input-row, apply-flow-block")].filter(vis)
      .find((d) => /r[ée]sum[ée]/i.test(t(d.querySelector("label")) || "")
                || /r[ée]sum[ée]/i.test(t(d.querySelector("apply-flow-block-title")) || "")) || null;
  };
  const wrap0 = findWrap();
  if (!wrap0) return { ok: true, present: false };
  const controlsOf = (w) => [...w.querySelectorAll("button, a[role=button]")].filter(vis);
  const nameIn = (w) => {
    const el = [...w.querySelectorAll("*")].find((e) => FILE_RE.test(t(e)) && t(e).length < 120);
    return el ? t(el) : null;
  };
  const attachedName = nameIn(wrap0);
  const offered = controlsOf(wrap0)
    .map((b) => (b.getAttribute("aria-label") || b.getAttribute("title") || t(b) || "").slice(0, 40))
    .filter(Boolean);
  if (!attachedName) {
    return { ok: true, present: true, attached: false, offered,
      hasFileInput: !!wrap0.querySelector('input[type="file"]') };
  }
  const rm = controlsOf(wrap0).find((b) => /remove|delete|clear|discard|trash|replace/i
    .test(String(b.getAttribute("aria-label") || b.getAttribute("title") || t(b))));
  if (!rm) return { ok: true, present: true, attached: true, attachedName, removed: false,
    error: "no-remove-control", offered };
  rm.click();
  const deadline = Date.now() + (budgetMs || 6000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    const w = findWrap();
    if (!w) return { ok: true, present: true, attached: true, attachedName, removed: true, hasFileInput: false };
    if (nameIn(w) !== attachedName) {
      return { ok: true, present: true, attached: true, attachedName, removed: true,
        hasFileInput: !!w.querySelector('input[type="file"]') };
    }
  }
  return { ok: true, present: true, attached: true, attachedName, removed: false,
    error: "still-attached", offered };
}

// OPEN AN EXISTING TILE FOR EDIT — the read side of the replay's verify (2026-08-20).
// Same shape as the open above and the same evidence rule: a form is open when INPUTS APPEARED, not
// when a button says Cancel. The tile is addressed by INDEX in the same order atsInjOrcTiles returns
// them (both walk the block's Delete controls), so a caller that read tiles can act on tile k.
async function atsInjOrcOpenTileAndWait(blockTitlePattern, tileIndex, budgetMs) {
  const t = (el) => ((el && el.textContent) || "").replace(/\s+/g, " ").trim();
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  let re;
  try { re = new RegExp(blockTitlePattern, "i"); } catch (e) { return { ok: false, error: "bad-pattern" }; }
  const findBlock = () => [...document.querySelectorAll("apply-flow-block")].filter(vis)
    .find((b) => re.test(t(b.querySelector("apply-flow-block-title"))));
  const block0 = findBlock();
  if (!block0) return { ok: false, error: "block-not-found:" + blockTitlePattern };
  const btns0 = [...block0.querySelectorAll("button")].filter(vis);
  if (btns0.some((b) => /^cancel$/i.test(t(b)))) return { ok: false, error: "entry-already-open" };

  // ⚠ THE TILE CONTROLS ARE ICON-ONLY — no textContent — so they are found by aria-label/title, the
  // same way the delete pass finds its own. Ordered by the DELETE controls so the index agrees with
  // atsInjOrcTiles; the Edit control is the one nearest that tile.
  const dels = [...block0.querySelectorAll("button, a[role=button]")].filter(vis)
    .filter((b) => /delete|remove/i.test(String(b.getAttribute("aria-label") || b.getAttribute("title") || "")));
  if (!dels.length) return { ok: false, error: "no-tiles" };
  if (tileIndex < 0 || tileIndex >= dels.length) return { ok: false, error: "tile-index-out-of-range:" + tileIndex + "/" + dels.length };
  const del = dels[tileIndex];
  let edit = null, scope = del.parentElement;
  for (let i = 0; i < 5 && scope && !edit; i++) {
    edit = [...scope.querySelectorAll("button, a[role=button]")].filter(vis)
      .find((b) => /edit|change|update/i.test(String(b.getAttribute("aria-label") || b.getAttribute("title") || "")));
    if (!edit) scope = scope.parentElement;
  }
  if (!edit) return { ok: false, error: "no-edit-control" };

  const before = [...block0.querySelectorAll("input, textarea, select")]
    .filter((e) => e.type !== "hidden" && vis(e)).length;
  edit.click();

  const deadline = Date.now() + (budgetMs || 6000);
  let fields = [];
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 80));
    const block = findBlock();
    if (!block) continue;
    const live = [...block.querySelectorAll("input, textarea, select")]
      .filter((e) => e.type !== "hidden" && vis(e));
    if (live.length > before) {
      fields = live.map((e) => ({ id: e.id || null, name: e.name || null, type: e.type,
        role: e.getAttribute("role") || null,
        label: (e.id ? t(document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(e.id) : e.id) + '"]')) : "") || e.getAttribute("aria-label") || "",
        value: e.value || null }));
      break;
    }
  }
  if (!fields.length) return { ok: false, error: "entry-form-never-rendered" };
  return { ok: true, fields, count: fields.length };
}

// CLOSE AN OPEN ENTRY WITHOUT SAVING. Cancel is preferred because it asserts nothing; a tenant that
// renders no Cancel falls back to the commit control, which is equivalent HERE and only here —
// this is called on a path that has written nothing, so committing re-saves the entry unchanged.
// ⚠ It must never be reused after a write unless a save is what you mean.
async function atsInjOrcCloseEntry(blockTitlePattern, budgetMs) {
  const t = (el) => ((el && el.textContent) || "").replace(/\s+/g, " ").trim();
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  let re;
  try { re = new RegExp(blockTitlePattern, "i"); } catch (e) { return { ok: false, error: "bad-pattern" }; }
  const findBlock = () => [...document.querySelectorAll("apply-flow-block")].filter(vis)
    .find((b) => re.test(t(b.querySelector("apply-flow-block-title"))));
  const block0 = findBlock();
  if (!block0) return { ok: false, error: "block-not-found" };
  // ⚠⚠ THE CANCEL CLICK IS IGNORED IF IT ARRIVES TOO EARLY — MEASURED, not inferred (2026-08-21).
  // Diagnosed by hand on the operator's own live form, which settled two wrong theories of mine:
  //
  //   • NOT stale nodes. After pressing Edit, every previously-held button reported
  //     `isConnected: true` and the block node was identical — nothing is detached, and the tiles
  //     stay in the DOM alongside the open form.
  //   • NOT a mis-targeted control. Resolving Cancel and clicking it by hand took the block from
  //     6 visible inputs to 0 in under 200ms, and it stayed 0.
  //
  // And it explained the diagnostic that misled me: `offered: ["","","","","",""]` was not six
  // orphaned nodes, it was the three Edit/Delete tile pairs — ORC's tile controls are ICON-ONLY, so
  // their textContent is empty, and the report sliced the first six of the block's buttons.
  //
  // What is left is TIMING. The verify pass opens an entry, reads its fields page-side (fast), and
  // clicks Cancel almost immediately; ORC does not have the handler wired that early, so the press
  // is a no-op. Entry 1 escapes it because the first open is slower (component bootstrap), and the
  // SELF-HEAL close succeeds because by then the form has been open for a while — which is exactly
  // why the failure looked like "every entry after the first".
  //
  // ⚠ THE FIX IS A RE-PRESS, NOT A SLEEP. There is no readable "the form is ready" signal to poll,
  // and the standing rule refuses fixed delays — but the predicate here ("the form is closed") is
  // MONOTONE, so pressing again is free: if the first press worked we have already returned. Cancel
  // twice, then the commit control as a last resort, each round re-resolved and each round polling
  // its own share of the budget.
  const pick = (rx) => {
    const block = findBlock();
    if (!block) return null;
    return [...block.querySelectorAll("button")].filter(vis).find((b) => rx.test(t(b))) || null;
  };
  const openCount = () => {
    const block = findBlock();
    return block ? [...block.querySelectorAll("input, textarea, select")]
      .filter((e) => e.type !== "hidden" && vis(e)).length : -1;
  };
  // ⚠⚠ TRY THE OTHER CONTROL BEFORE GIVING UP (live 2026-08-20). Measured on the first rehearsal to
  // run this path: entry 1 closed via Cancel every time and **entry 2's close always failed**, in
  // BOTH the Experience and the Skills block — deterministic, not flaky. A form left open then made
  // every later tile unopenable (`entry-already-open`), so ONE stuck close cost 10 of that run's 16
  // verify failures. Whatever makes the second Cancel a no-op, a second press of the OTHER control
  // is a cheap way out, and it is safe HERE for the same reason the fallback already was: this path
  // writes nothing, so committing re-saves the entry unchanged.
  const attempts = [];
  // Cancel, Cancel again, then the commit control — which is equivalent HERE and only here, because
  // this path writes nothing, so committing re-saves the entry unchanged.
  const rounds = [/^cancel$/i, /^cancel$/i, /^(add|save|update)\b/i];
  const perRound = Math.max(600, Math.round((budgetMs || 6000) / rounds.length));
  for (const rx of rounds) {
    if (openCount() === 0) return { ok: true, via: attempts[attempts.length - 1] || "already-closed", attempts };
    const ctl = pick(rx);                       // resolved NOW, not once at the top
    if (!ctl) continue;
    const label = t(ctl) || "?";
    ctl.click();
    attempts.push(label);
    const deadline = Date.now() + perRound;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 80));
      if (openCount() === 0) return { ok: true, via: label, attempts };
    }
  }
  // Read the controls LIVE for the report as well — the stale-node version of this line is what made
  // the Experience failure look like a block with six nameless buttons.
  const offeredNow = (() => {
    const block = findBlock();
    return block ? [...block.querySelectorAll("button")].filter(vis).map((b) => t(b)).slice(0, 6) : [];
  })();
  if (!attempts.length) return { ok: false, error: "no-close-control", offered: offeredNow };
  return { ok: false, error: "entry-still-open", attempts, stillOpen: openCount(), offered: offeredNow };
}

// COMMIT-AND-WAIT, same reasoning: press the (homonymous) Add and wait page-side for the form to be
// GONE. `closed` is the evidence; a form still open means Oracle refused the entry.
async function atsInjOrcCommitEntryAndWait(blockTitlePattern, budgetMs) {
  const t = (el) => ((el && el.textContent) || "").replace(/\s+/g, " ").trim();
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  let re;
  try { re = new RegExp(blockTitlePattern, "i"); } catch (e) { return { ok: false, error: "bad-pattern" }; }
  const findBlock = () => [...document.querySelectorAll("apply-flow-block")].filter(vis)
    .find((b) => re.test(t(b.querySelector("apply-flow-block-title"))));
  const block0 = findBlock();
  if (!block0) return { ok: false, error: "block-not-found" };
  const btns0 = [...block0.querySelectorAll("button")].filter(vis);
  // ⚠ REFUSE if nothing is open: the SAME caption would OPEN a blank entry instead of committing one.
  // "Open" is a Cancel button OR live inputs — the caption is tenant wording, the inputs are
  // structure, and a tenant that renders no Cancel must still be able to commit.
  const liveNow = [...block0.querySelectorAll("input, textarea, select")]
    .filter((e) => e.type !== "hidden" && vis(e)).length;
  if (!btns0.some((b) => /^cancel$/i.test(t(b))) && !liveNow) return { ok: false, error: "no-open-entry-to-commit" };
  const add = btns0.find((b) => /^add\b/i.test(t(b)));
  if (!add) return { ok: false, error: "no-add-control" };
  add.click();

  const deadline = Date.now() + (budgetMs || 6000);
  let closed = false;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 80));
    const block = findBlock();
    if (!block) { closed = true; break; }
    const stillOpen = [...block.querySelectorAll("input, textarea, select")]
      .filter((e) => e.type !== "hidden" && vis(e)).length > 0;
    if (!stillOpen) { closed = true; break; }
  }
  return { ok: true, pressed: t(add), closed };
}

function atsInjOrcEntryAction(blockTitlePattern, action) {
  const t = (el) => ((el && el.textContent) || "").replace(/\s+/g, " ").trim();
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  let re;
  try { re = new RegExp(blockTitlePattern, "i"); } catch (e) { return { ok: false, error: "bad-pattern" }; }
  const block = [...document.querySelectorAll("apply-flow-block")]
    .filter(vis)
    .find((b) => re.test(t(b.querySelector("apply-flow-block-title"))));
  if (!block) return { ok: false, error: "block-not-found:" + blockTitlePattern };
  const buttons = [...block.querySelectorAll("button")].filter(vis);
  const cap = (b) => t(b);
  const isOpen = buttons.some((b) => /^cancel$/i.test(cap(b)));

  if (action === "cancel") {
    const c = buttons.find((b) => /^cancel$/i.test(cap(b)));
    if (!c) return { ok: false, error: "no-open-entry" };
    c.click();
    return { ok: true, pressed: "Cancel" };
  }
  const addBtn = buttons.find((b) => /^add\b/i.test(cap(b)));
  if (!addBtn) return { ok: false, error: "no-add-control", offered: buttons.map(cap).slice(0, 6) };
  if (action === "open") {
    // ⚠ REFUSE if a form is already open: the same caption would COMMIT the entry instead.
    if (isOpen) return { ok: false, error: "entry-already-open", caption: cap(addBtn) };
    addBtn.click();
    return { ok: true, pressed: cap(addBtn), was: "closed" };
  }
  if (action === "commit") {
    // ⚠ REFUSE if no form is open: the same caption would OPEN a blank entry instead.
    if (!isOpen) return { ok: false, error: "no-open-entry-to-commit", caption: cap(addBtn) };
    addBtn.click();
    return { ok: true, pressed: cap(addBtn), was: "open" };
  }
  return { ok: false, error: "unknown-action:" + action };
}

// ── WHICH ORC BLOCKS REPEAT, AND FROM WHAT (pure) ────────────────────────────────────────
// Block titles are the tenant's own wording, so these are PATTERNS rather than exact strings, and the
// profile source is named explicitly. Anything not listed is left alone — a block we cannot source is
// the operator's to fill, not ours to guess at.
// ⚠ `Skills` and the résumé arrive PREFILLED from a returning candidate's account (measured: skills
// already populated, `Kevin_s_Resume (6).pdf` already attached), so an entry pass here must reconcile
// UP only and never assume a block starts empty.
// ── PICKER READ-BACK: FRONT-LOADED, SAME BUDGET (operator reported slow skills, 2026-08-21) ──
// Every ORC picker commit polls its read-back eight times. A flat 250ms wait meant even a value that
// landed instantly cost 250ms before the first LOOK — and a fill crosses ~30 pickers (both halves of
// every date pair, the dial code, the degree, and one per skill), so the floor alone was seconds.
//
// This schedule sums to the SAME 2000ms over the SAME eight awaits, so nothing is traded away: the
// worst case is unchanged and the number of chances to be descheduled is unchanged — which matters,
// because on this codebase the cost of a poll is the NUMBER of awaits, not their length. All that
// changes is that the early looks happen sooner, so the common case (the widget already settled)
// returns in 60ms instead of 250ms.
//
// ⚠ Do NOT "improve" this by adding more polls. A stability predicate gets WEAKER with denser
// sampling, and every extra await is another starvation exposure (docs/fill-speed-log.md round 15).
const ATS_ORC_READBACK_MS = [60, 100, 140, 200, 260, 320, 420, 500];

var ATS_ORC_ENTRY_BLOCKS = [
  { pattern: "^Experience", source: "work_experience", label: "Experience" },
  { pattern: "^Education", source: "education", label: "Education" },
  { pattern: "^Licenses? and Certificates?", source: "certifications", label: "Licenses and Certificates" },
  { pattern: "^Skills", source: "skills", label: "Skills" },
];

// The entry forms, MEASURED — each one was read off the live DOM by the entry pass's own discovery
// log (2026-08-19), which is why the shapes here are shorter and stranger than a guess would be.
//
// ⚠⚠ A DATE IS **TWO COMBOBOXES SHARING ONE `name`**, not one field. Measured verbatim:
//   Experience entry 1 — 6 field(s): employerName[text], jobTitle[text],
//                        startDate[combobox], startDate[combobox], endDate[combobox], endDate[combobox]
// The first pass treated `startDate` as a single field, wrote "2025-05" into whichever id came
// first, and burned 8.2s failing — the slowest field of the whole run. `date_pair` says so, and the
// pass decides WHICH half is which by reading each picker's own options (a month list vs a year
// list) rather than by position: a tenant that renders year-then-month would otherwise file every
// start date backwards, and nothing about that failure would look like an ordering bug.
//
// ⚠ AND EXPERIENCE HAS NO CITY, COUNTRY OR RESPONSIBILITIES ON THIS TENANT. The earlier map carried
// all three from the iCIMS shape; they never existed here. Left OUT rather than kept "just in case",
// because a map entry that matches nothing is indistinguishable from one that is broken.
var ATS_ORC_ENTRY_MAPS = {
  work_experience: {
    "employerName": { path: "company" },
    "jobTitle": { path: "job_title" },
    "startDate": { path: "from", kind: "date_pair" },
    // ⚠ A JOB YOU STILL HOLD HAS NO END DATE — the entry pass skips this when
    // `currently_work_here` is true, exactly as the iCIMS entry resolver does. Writing today's date
    // there would assert you had left.
    "endDate": { path: "to", kind: "date_pair", blankWhenCurrent: true },
  },
  education: {
    // `contentItemId` is Oracle's own name for the DEGREE picker — an opaque platform id whose label
    // is the only thing that says so, which is why the discovery log prints the label next to the
    // name. The profile stores degree and field-of-study as TIERED ARRAYS ("Bachelor of Science" →
    // "Bachelor's Degree" → "Bachelors"), so both go through the ladder as candidates and the form's
    // own vocabulary picks the wording it has.
    "contentItemId": { path: "degree", kind: "tiered" },
    "educationalEstablishment": { path: "school_or_university" },
    "major": { path: "field_of_study", kind: "tiered" },
    "gpa": { path: "gpa" },
  },
  skills: {
    // ⚠ A SKILLS ENTRY IS A BARE STRING, NOT AN OBJECT. `profile.skills` is an array of names, so
    // there is no property to read — `kind:"self"` says "the entry IS the value". Without it the
    // resolver would index a string and answer nothing, which is what left every skill blank.
    "skills": { kind: "self" },
    // `yearsOfExperience` is deliberately unmapped: the profile does not record per-skill years, and
    // inventing a number on a form an employer reads is the confidently-wrong class. If Oracle
    // REQUIRES it the entry is refused and the pass says so — which is the honest outcome, and the
    // evidence for either adding the data or dropping this block.
  },
};

// Resolve ONE field of ONE entry. Pure, so the kinds are unit-pinnable without a page.
//
// ⚠ EVERY VALUE COMES FROM THE ENTRY, NEVER FROM THE PROFILE ROOT — the iCIMS seal, and it holds for
// the same reason: a "City" inside an Experience entry is the EMPLOYER's city, so answering it from
// the candidate's home address is a DIFFERENT FACT, not a near-miss. A kind that cannot answer
// returns null and the caller reports the field UNANSWERED rather than falling through to a wider
// scope.
function atsOrcEntryValue(spec, entry) {
  if (!spec || !entry) return null;
  const raw = (k) => {
    const v = entry[k];
    return v === undefined || v === null || (typeof v === "string" && !v.trim()) ? null : v;
  };
  if (spec.kind === "skip") return null;
  if (!spec.kind) { const v = raw(spec.path); return v == null ? null : String(v); }
  // The entry IS the value (profile.skills is an array of bare strings).
  if (spec.kind === "self") {
    const v = typeof entry === "string" ? entry : null;
    return v && v.trim() ? v.trim() : null;
  }
  // A TIERED profile array passes through as a ready-made candidate list, most-specific first —
  // the same contract `resolve()` has everywhere else here, so the form's vocabulary decides.
  if (spec.kind === "tiered") {
    const v = raw(spec.path);
    if (v == null) return null;
    if (Array.isArray(v)) { const list = v.map((x) => String(x)).filter((x) => x.trim()); return list.length ? list : null; }
    return String(v);
  }
  if (spec.kind === "date_pair") {
    // A job still held has no end date; asserting one would say you had left.
    if (spec.blankWhenCurrent && entry.currently_work_here === true) return null;
    const v = raw(spec.path);
    if (v == null) return null;
    const m = /^(\d{4})-(\d{1,2})/.exec(String(v));
    if (!m) { const y = /^(\d{4})$/.exec(String(v).trim()); return y ? { year: y[1], month: null } : null; }
    return { year: m[1], month: String(Number(m[2])) };
  }

  // "Tallahassee, FL" → the city half. The profile stores one `location` string per entry and ORC
  // asks for the parts separately, so the comma is the form's own delimiter, not an inference.
  if (spec.kind === "city_of") {
    const loc = raw(spec.path);
    if (!loc) return null;
    const first = String(loc).split(",")[0].trim();
    return first || null;
  }
  // ⚠ THE COUNTRY IS IMPLIED BY THE STATE, AND ONLY WHEN THE STATE IS ONE WE RECOGNISE. A US state
  // abbreviation implies the US; anything else returns null rather than guessing a country from a
  // city name. Same rule the iCIMS education entry uses, and the same reason: a wrong country on an
  // employment record is a confidently wrong fact, and blank is recoverable at review.
  if (spec.kind === "country_of") {
    const loc = raw(spec.path);
    if (!loc) return null;
    const parts = String(loc).split(",").map((x) => x.trim()).filter(Boolean);
    const tail = parts.length > 1 ? parts[parts.length - 1] : "";
    if (!tail) return null;
    const ab = atsLib.REGION_ABBREV || {};
    const up = tail.toUpperCase();
    const known = Object.prototype.hasOwnProperty.call(ab, up)
      || Object.keys(ab).some((k) => String(ab[k]).toLowerCase() === tail.toLowerCase());
    return known ? "United States" : null;
  }
  if (spec.kind === "join") {
    const v = raw(spec.path);
    if (!v) return null;
    return Array.isArray(v) ? (atsLib.joinBullets ? atsLib.joinBullets(v) : v.join("\n")) : String(v);
  }
  // A month-precision date, passed through as the profile stores it ("2025-05"). The WIDGET decides
  // how it is entered, which is read live rather than assumed — see the entry pass's field report.
  if (spec.kind === "date") { const v = raw(spec.path); return v == null ? null : String(v); }
  return null;
}

// ── THE LINKS PASS ───────────────────────────────────────────────────────────────────────
// `siteLink` is a REPEATING section (operator, 2026-08-20): "Add Another Link" creates siteLink-2,
// -3… and ALL of the operator's profile links belong on the form, not just the first.
//
// The flat loop already fills whichever link inputs EXIST at scan time — and correctly, one url each,
// because the map's `website` kind indexes the profile list by the ordinal in the field name. This
// pass exists for the urls with nowhere to go yet: it presses Add Another Link and fills the input
// that appears.
//
// ⚠ IDEMPOTENT BY URL, like skills. Oracle's form arrives prepopulated for a returning candidate, so
// a url already on the form is SKIPPED rather than added again — otherwise every run would grow the
// list. Comparison is on the https-normalized string, which is what both sides already hold.
async function atsOrcFillLinks(act, profile, opts) {
  const o = opts || {};
  const log = o.log || (() => {});
  const records = [], notes = [];
  const want = atsProfileWebsites(profile);
  if (!want.length) return { records, notes };

  const st0 = await act.eval(atsInjOrcLinks).catch(() => null);
  if (!st0 || !st0.ok) return { records, notes };
  if (!st0.count && !st0.addPresent) return { records, notes };   // no links section on this step

  const norm = (v) => atsLib.normalize(String(v || "")).replace(/\/+$/, "");
  const have = st0.links.map((l) => norm(l.value)).filter(Boolean);
  const missing = want.filter((u) => have.indexOf(norm(u)) === -1);
  log(`links: profile has ${want.length}, the form holds ${have.length} (${JSON.stringify(st0.links.map((l) => l.value).filter(Boolean))}) — ${missing.length} to add`);

  // ⚠ REPORT THE LINKS ALREADY ON THE FORM, for the same reason as the entries above: a link the run
  // did not have to add is still part of the application, and a review page that omits it tells the
  // operator their links are missing.
  // ⚠ THE FLAT LOOP ALREADY RECORDED `siteLink-1` (it is in the static map), so reporting every link
  // here would DOUBLE it in review — the field would appear twice, which reads as two links.
  const already = new Set((o.recorded || []).map(String));
  for (const l of st0.links) {
    if (!l.value) continue;
    if (l.name && already.has(l.name)) continue;
    records.push({
      fieldName: l.name || "siteLink", label: "Link " + ((String(l.name || "").split("-")[1]) || "?"),
      widgetType: "text", isRequired: false, mappedPath: "websites[].url",
      status: "filled", verified: true, after: l.value, elapsedMs: 0,
      detail: want.indexOf(l.value) !== -1 || have.indexOf(norm(l.value)) !== -1
        ? "already on the form" + (want.some((u) => norm(u) === norm(l.value)) ? " and it is one of your profile's links — verified, not re-entered" : "")
        : "already on the form",
    });
  }
  if (!missing.length) return { records, notes };

  if (!st0.addPresent) {
    notes.push(`${missing.length} profile link(s) could not be added — this form has no "Add Another Link" control`);
    return { records, notes };
  }

  for (const url of missing.slice(0, ATS_ORC_ENTRY_MAX)) {
    const before = await act.eval(atsInjOrcLinks).catch(() => null);
    const n = before && before.ok ? before.count : 0;
    // An EMPTY input already on the form is used before creating another one — pressing Add with a
    // blank row sitting there would leave a hole the operator has to notice.
    let slot = (before && before.ok ? before.links : []).find((l) => !l.value);
    if (!slot) {
      const add = await act.eval(atsInjOrcAddLink).catch(() => null);
      if (!add || !add.ok) {
        log(`⛔ links: could not press "Add Another Link" (${(add && add.error) || "unknown"})`);
        notes.push(`could not add a row for ${url}`);
        break;
      }
      // MONOTONE: a new input exists. Polled, never a fixed sleep.
      for (let i = 0; i < 12 && !slot; i++) {
        await act.delayFull(250);
        const now = await act.eval(atsInjOrcLinks).catch(() => null);
        if (now && now.ok && now.count > n) slot = now.links.find((l) => !l.value) || null;
      }
      if (!slot) {
        log("⛔ links: pressed \"Add Another Link\" but no new empty input appeared");
        notes.push(`could not add a row for ${url}`);
        break;
      }
    }
    const sel = slot.id ? "#" + slot.id.replace(/([^\w-])/g, "\\$1") : 'input[name="' + slot.name + '"]';
    const rec = { fieldName: slot.name || "siteLink", label: "Link " + ((slot.name || "").split("-")[1] || "?"),
                  widgetType: "text", isRequired: false, mappedPath: "websites[].url",
                  status: "skipped", after: null, elapsedMs: 0 };
    const t0 = Date.now();
    await act.eval(atsInjSetText, sel, url).catch(() => null);
    const back = await act.eval(atsInjReadValue, "oracle", sel, "text").catch(() => null);
    rec.after = back && back.ok ? back.value : null;
    rec.elapsedMs = Date.now() - t0;
    const ok = String(rec.after || "").trim() === url;
    rec.status = ok ? "filled" : "needs_review";
    if (!ok) { rec.flag = "commit-not-accepted"; rec.detail = `wrote ${JSON.stringify(url)} but the field holds ${JSON.stringify(rec.after)}`; }
    else rec.detail = "added a link row for this profile website";
    records.push(rec);
    log(`  ${rec.fieldName} → ${rec.status} · after=${JSON.stringify(rec.after)}`);
  }
  return { records, notes };
}

// ── THE ENTRY PASS ───────────────────────────────────────────────────────────────────────
// One entry at a time: OPEN → read the form ORC just built → fill → COMMIT → confirm it closed.
//
// ⚠ DISCOVERY-FIRST, AND DELIBERATELY SO. Recon could not describe this form because it does not
// exist until an Add is pressed ("0 inputs, built on demand"), and the standing rule on this
// codebase is to trace the real DOM before writing a handler — every hard widget here only cracked
// after blind guesses failed. So the pass READS the entry form it just created, LOGS every field it
// found (always, not behind a debug flag: that log is the recon record for the next tenant), fills
// what the map claims by NAME, and reports the rest as unanswered rather than pretending they were
// absent. A field the map does not know about is then one line to add, evidenced.
//
// ⚠ THE FIELD KEY IS `name`, NEVER `id`. Measured: every ORC control is `id="<name>-<N>"` where N is
// a render-assignment counter — `country-19` numbers BELOW `email-27` while appearing after it — so
// an id is an in-visit address and nothing more. The id IS used for the actuation selector, resolved
// from the same read that produced it, which is the only safe way to use it.
//
// ⚠ AND `Add` IS A HOMONYM. The same button opens a blank entry and commits the open one, so both
// actions are gated on whether a Cancel is present (atsInjOrcEntryAction refuses the wrong one).
// Pressing it twice in a row on a misread state would silently create an empty entry.
async function atsOrcFillEntries(act, profile, jc, opts) {
  const o = opts || {};
  const log = o.log || (() => {});
  const records = [], notes = [];
  const read = await act.eval(atsInjOrcBlocks).catch(() => null);
  const blocks = (read && read.ok && read.blocks) || [];
  if (!blocks.length) { log("no visible apply-flow-block on this step"); return { records, notes }; }
  // ⚠ THE WHOLE BLOCK INVENTORY, EVERY STEP. The operator reported three REQUIRED yes/no application
  // questions that no pass has ever recorded — and with no inventory there is no way to tell whether
  // the block holding them is on a step we walked, on one we did not, or present with zero controls.
  // Printing the blocks and their control counts answers that in one line per step, and costs nothing
  // (the read already happened).
  log(`blocks on this step: ${blocks.map((b) => JSON.stringify(b.title) + " (" + b.inputs + " input(s)" + (b.addCaption ? ", add=" + JSON.stringify(b.addCaption) : "") + ")").join(", ") || "none"}`);
  const plan = atsOrcEntryPlan(profile, blocks.map((b) => b.title));

  // ⚠⚠ A SUBMIT/REHEARSAL VISIT REPORTS THE ENTRIES; IT MUST NOT REBUILD THEM (2026-08-20).
  // The replay passes `profile: {}` by design — every value comes from the approved bundle — so the
  // plan above is EMPTY on a submit run. Doing nothing is the right ACTION (ORC saves entries to the
  // candidate profile server-side, so the tiles the fill created are still on the form, and re-adding
  // them would duplicate the work history) but it is not a complete ANSWER: the approved bundle
  // carries one record per entry, and a replay that emits none of them makes the strict verify report
  // every Experience and Education row as "approved value has NO matching field on the live form".
  // That is the exact shape that produced 28 of an iCIMS rehearsal's 32 failures — except here it
  // would block a submit whose entries are all present and correct.
  //
  // So a report-only visit READS the tiles and records them, and clicks nothing. The verify then
  // means what it should — "the entries you approved are still on the form" — and a tile that changed
  // or vanished between the fill and the submit FAILS the gate instead of passing unnoticed.
  if (o.reportOnly) {
    // ⚠⚠ PER-FIELD, NOT PER-ENTRY. The fill records one row per entry FIELD
    // (`work_experience[0].employerName`), and for Oracle atsSubmitKey is just the durable field
    // name — so the replay's rows must carry the SAME names or the strict verify reports every
    // approved entry field as "no matching field on the live form". An earlier version of this
    // branch emitted one summary row per entry, which lined up only because the fill was emitting
    // summaries too; both are gone.
    //
    // The operator's rule for this visit: "see if nothing is wrong, then don't change it, but if
    // something is filled wrong, change it." This half does the seeing. Each tile is opened, its
    // fields are read, and each is compared with the value the human approved:
    //   • equal  ⇒ `filled`, verified, nothing written and nothing to review;
    //   • differs ⇒ `needs_review` + `entry-mismatch`, which BLOCKS the gate and names the field.
    // ⚠ The repair itself is deliberately NOT done here yet — writing into an entry form means
    // driving the date-pair and tiered-degree resolvers from a committed DISPLAY value ("May 2026",
    // the degree wording the form chose), and a repair that mis-parses one would damage an entry
    // that was merely reported wrong. Blocking is the safe half and is correct on its own: a
    // mismatch stops the submit instead of passing unnoticed.
    for (const spec of ATS_ORC_ENTRY_BLOCKS) {
      const re = new RegExp(spec.pattern, "i");
      if (!blocks.some((b) => re.test(String(b.title || "")))) continue;
      const t0 = await act.eval(atsInjOrcTiles, spec.pattern).catch(() => null);
      const tiles = (t0 && t0.ok && t0.tiles) || [];
      if (!tiles.length) { log(`${spec.label}: no entries on the form`); continue; }
      const emap = ATS_ORC_ENTRY_MAPS[spec.source] || {};
      log(`${spec.label}: ${tiles.length} entr${tiles.length === 1 ? "y" : "ies"} on the form — opening each to check it against your approved values (nothing is rewritten)`);

      for (let k = 0; k < tiles.length; k++) {
        // ── THE CHEAP CHECK FIRST: is everything the human approved already visible in the tile? ──
        // The map tells us which fields this section has, so the expected values can be looked up
        // without opening anything. All present ⇒ verified from the DOM, nothing touched.
        const expected = [];
        for (const key of Object.keys(emap)) {
          const fieldName = `${spec.source}[${k}].${key}`;
          const want = typeof o.valueFor === "function"
            ? o.valueFor({ fieldName, entrySection: spec.source, entryIndex: k, widgetType: "text" })
            : undefined;
          if (want === undefined || String(want).trim() === "") continue;
          expected.push({ key, fieldName, want: String(want) });
        }
        const missing = expected.filter((e) => !atsOrcTileHoldsValue(tiles[k].text, e.want));
        if (expected.length && !missing.length) {
          log(`  ${spec.label} entry ${k + 1}: all ${expected.length} approved value(s) are visible on the tile — verified from the DOM, not opened`);
          for (const e of expected) {
            records.push({
              fieldName: e.fieldName, label: `${spec.label} ${e.key}`, widgetType: "text",
              isRequired: false, entrySection: spec.source, entryIndex: k,
              status: "filled", verified: true, after: e.want, elapsedMs: 0,
              detail: "read from the entry's own summary on the form — it matches what you approved, so the entry was not opened",
            });
          }
          continue;
        }
        // ── something disagrees (or the tile does not display it) ⇒ open THIS entry and look ──
        log(`  ${spec.label} entry ${k + 1}: ${missing.length ? `the tile does not show ${JSON.stringify(missing.map((m) => m.key))}` : "nothing approved to compare"} — opening it to check field by field`);
        let opened = await act.eval(atsInjOrcOpenTileAndWait, spec.pattern, k, ATS_ORC_PICK_MS).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
        // ⚠ SELF-HEAL A STUCK-OPEN FORM. A close that did not take is a local failure; letting it
        // block every REMAINING tile turns one lost entry into a whole lost section — measured, one
        // stuck close cost 10 of a rehearsal's 16 verify failures. Clear it and try this tile once
        // more, so the damage stops at the entry that actually went wrong.
        if (opened && opened.error === "entry-already-open") {
          log(`${spec.label} entry ${k + 1}: an entry form was still open — closing it and retrying`);
          await act.eval(atsInjOrcCloseEntry, spec.pattern, ATS_ORC_PICK_MS).catch(() => null);
          opened = await act.eval(atsInjOrcOpenTileAndWait, spec.pattern, k, ATS_ORC_PICK_MS).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
        }
        if (!opened || !opened.ok) {
          // A tile we could not open is NOT a tile we can vouch for.
          log(`⛔ ${spec.label} entry ${k + 1}: could not open it to check — ${(opened && opened.error) || "unknown"}`);
          records.push({
            fieldName: `${spec.source}[${k}]`, label: `${spec.label} entry ${k + 1}`,
            widgetType: "text", isRequired: false, entrySection: spec.source, entryIndex: k,
            status: "needs_review", flag: "entry-unverifiable", after: tiles[k].text, elapsedMs: 0,
            detail: "this entry is on the form but could not be opened to check its fields — "
              + ((opened && opened.error) || "unknown") + ". Check it by hand.",
          });
          continue;
        }
        const byName = new Map();
        for (const f of opened.fields || []) {
          const key = f.name || f.id || "";
          if (!key) continue;
          if (!byName.has(key)) byName.set(key, []);
          byName.get(key).push(f);
        }
        let same = 0, diff = 0;
        for (const [key, group] of byName) {
          if (!emap[key]) continue;                       // unmapped on the fill side too
          const fieldName = `${spec.source}[${k}].${key}`;
          const want = typeof o.valueFor === "function"
            ? o.valueFor({ fieldName, entrySection: spec.source, entryIndex: k, widgetType: group[0].role === "combobox" ? "dropdown" : "text" })
            : undefined;
          if (want === undefined) continue;               // not in the bundle ⇒ nothing was approved
          const live = group.map((g) => String(g.value == null ? "" : g.value).trim()).filter(Boolean).join(" ");
          const agrees = atsLib.normalize(live) === atsLib.normalize(want)
            || (live && atsLib.normalize(live).indexOf(atsLib.normalize(want)) !== -1)
            || (want && atsLib.normalize(want).indexOf(atsLib.normalize(live)) !== -1 && live.length > 0);
          records.push({
            fieldName, label: group[0].label || key, widgetType: "text", isRequired: false,
            entrySection: spec.source, entryIndex: k,
            status: agrees ? "filled" : "needs_review",
            flag: agrees ? null : "entry-mismatch",
            verified: !!agrees, after: live || null, elapsedMs: 0,
            detail: agrees
              ? "already on the form and it matches what you approved — checked, not rewritten"
              : `the form holds ${JSON.stringify(live)} but you approved ${JSON.stringify(want)} — fix it on the form, then re-run`,
          });
          if (agrees) same++; else diff++;
        }
        const closed = await act.eval(atsInjOrcCloseEntry, spec.pattern, ATS_ORC_PICK_MS).catch(() => null);
        if (!closed || !closed.ok) {
          const why = (closed && closed.error) || "unknown";
          const extra = closed && closed.attempts ? ` after pressing ${JSON.stringify(closed.attempts)}` : "";
          notes.push(`${spec.label} entry ${k + 1}: its form was left OPEN (${why})${extra} — check the page by hand`);
          log(`⛔ ${spec.label} entry ${k + 1}: could not close the entry form — ${why}${extra}`
            + (closed && closed.offered ? `; the block offered ${JSON.stringify(closed.offered)}` : ""));
        }
        log(`  ${spec.label} entry ${k + 1}: ${same} field(s) match${diff ? `, ${diff} DIFFER` : ""}${closed && closed.ok ? ` (closed via ${closed.via})` : ""}`);
      }
    }
    return { records, notes };
  }

  if (!plan.length) {
    // Say WHICH blocks were present but not planned — a repeating block we cannot fill must never be
    // silently absent from the log, because "step 2 had 4 fields" reads as a complete step.
    const repeat = blocks.filter((b) => b.addCaption);
    if (repeat.length) {
      log(`repeating block(s) present but nothing to fill from the profile: ${repeat.map((b) => JSON.stringify(b.title) + " (" + b.addCaption + ")").join(", ")}`);
      notes.push(`repeating blocks left empty (profile has no entries): ${repeat.map((b) => b.title).join(", ")}`);
    }
    return { records, notes };
  }

  for (const item of plan) {
    const arr = (profile || {})[item.source] || [];
    if (item.capped) {
      // NO SILENT CAPS — the standing rule. Whatever a cap drops is named.
      log(`⚠ ${item.block}: profile has ${item.capped} entries and the cap is ${ATS_ORC_ENTRY_MAX} — filling ${item.want}, the rest are NOT on the form`);
      notes.push(`${item.block}: only ${item.want} of ${item.capped} entries filled (cap)`);
    }
    // ⚠⚠ RECONCILE BEFORE FILLING — the form arrives PREPOPULATED (operator, 2026-08-20).
    // Oracle keeps a candidate record, so a RETURNING applicant's Experience / Education / Skills
    // blocks already hold tiles, and pressing Add once per profile entry left TWO copies of every job
    // on a real application. This is Workday's rule verbatim — "reconcile to exactly N, then fill each
    // entry — true idempotency, proven from ARBITRARY dirty state" — and only the second half of it
    // had ever been built here.
    //
    // ⚠ The FIRST attempt at detecting this counted button CAPTIONS matching /^(edit|delete|remove)/
    // and found ZERO, so a second run duplicated the history again: a committed entry's controls are
    // ICON-ONLY, with the word in `aria-label` and nothing in textContent. Measured, not guessed.
    //
    // ⚠⚠ TWO DIFFERENT POLICIES, on the operator's instruction, because the blocks mean different
    // things:
    //   • HISTORY (Experience / Education / Licenses) — DELETE the old tiles, then fill from the
    //     profile. The profile is the source of truth for a history, and a stale tile from an earlier
    //     application is not something to merge with: keeping it risks an outdated employer, an old
    //     end date, or a job the operator has since removed.
    //   • SKILLS — ADD ONLY WHAT IS MISSING. A skills list is a SET, so deleting and re-adding eight
    //     tiles to reach the same set is pure page contact — and the profile's 33 skills are CAPPED at
    //     8, so deleting first would throw away skills the operator had that we could not restore.
    const tiles0 = await act.eval(atsInjOrcTiles, item.pattern).catch(() => null);
    const present = (tiles0 && tiles0.ok && tiles0.tiles) || [];
    const isSkills = item.source === "skills";

    // ⚠⚠ THE TILE-MATCH SKIP IS GONE (operator, 2026-08-20). It fired when the tiles already agreed
    // with the profile and left them in place, which saved an open, ~2 picker visits per field and a
    // commit per entry. It cost the review page twice, and the second cost is the one that settles it:
    //
    //   • first it emitted NOTHING, so Experience, Education and Links were missing from review
    //     entirely on a run where all three were correctly on the form;
    //   • then it emitted one summary record per entry, so review showed four opaque rows
    //     ("Experience entry 1", "Education entry 1") instead of the FIELDS. A reviewer cannot check
    //     an employer name they cannot see, and cannot correct one they cannot edit.
    //
    // The operator's division of labour is explicit: the FILL clicks Add, exposes the entry form and
    // fills it — so those fields reach review — and it is the REHEARSAL that leaves a correct value
    // alone and repairs only a wrong one. Leaving-alone therefore belongs on the replay, not here.
    // Deleting and re-entering is also what was asked for directly ("make sure you delete old entries
    // before filling the repeating sections"), and it makes the fill's behaviour uniform: one path,
    // one shape of record, whatever state the form arrives in.
    //
    // The cost is real but it is paid on the ABNORMAL case — a form that arrives prepopulated —
    // and correctness of the review page outranks it.
    if (present.length && !isSkills) {
      log(`${item.block}: ${present.length} existing tile(s) on the form — deleting before filling: ${JSON.stringify(present.map((x) => x.text.slice(0, 50)))}`);
      let removed = 0;
      // LAST-FIRST so earlier indexes stay valid, and gated on the count actually DROPPING — a delete
      // that did not take must stop the loop rather than spin it.
      for (let guard = 0; guard < present.length + 4; guard++) {
        const before = await act.eval(atsInjOrcTiles, item.pattern).catch(() => null);
        const n = before && before.ok ? before.count : 0;
        if (!n) break;
        const del = await act.eval(atsInjOrcDeleteTile, item.pattern, null).catch(() => null);
        if (!del || !del.ok) { log(`⛔ ${item.block}: could not press Delete (${(del && del.error) || "unknown"})`); break; }
        // ⚠ A CONFIRMATION MAY APPEAR, and a surprise modal is what wedges a run. The primitive
        // REPORTS it rather than dismissing it; the decision to confirm a delete belongs here.
        if (del.dialog && del.dialog.present) {
          log(`${item.block}: a confirmation appeared — ${JSON.stringify(del.dialog.text)} offering ${JSON.stringify(del.dialog.buttons)}`);
          const okd = await act.eval(atsInjOrcDialogPress, "^(yes|delete|remove|confirm|ok)\\b").catch(() => null);
          if (!okd || !okd.ok) { log(`⛔ ${item.block}: the confirmation could not be answered (${(okd && okd.error) || "unknown"}) — stopping`); break; }
        }
        let dropped = false;
        for (let w = 0; w < 24; w++) {
          await act.delayFull(150);
          const after = await act.eval(atsInjOrcTiles, item.pattern).catch(() => null);
          if (after && after.ok && after.count < n) { dropped = true; removed++; break; }
        }
        if (!dropped) { log(`⛔ ${item.block}: pressed Delete but the tile count did not drop from ${n} — stopping rather than spinning`); break; }
      }
      const leftover = await act.eval(atsInjOrcTiles, item.pattern).catch(() => null);
      const still = leftover && leftover.ok ? leftover.count : -1;
      log(`${item.block}: deleted ${removed} of ${present.length} existing tile(s)${still > 0 ? ` — ${still} could NOT be removed` : ""}`);
      if (still > 0) {
        // ⚠ DO NOT FILL ON TOP OF WHAT WE COULD NOT CLEAR — that is precisely the duplicate this
        // block exists to prevent, and a PARTIAL clear is exactly when it would happen quietly.
        notes.push(`${item.block}: ${still} pre-existing entr(y/ies) could not be deleted, so nothing was added — check this section by hand`);
        continue;
      }
    }

    // SKILLS: the set already on the form, so only the missing ones get added.
    const haveSkills = isSkills ? present.map((x) => atsLib.normalize(x.text)).filter(Boolean) : [];
    if (isSkills && haveSkills.length) {
      log(`${item.block}: ${haveSkills.length} skill(s) already on the form — only missing ones will be added: ${JSON.stringify(present.map((x) => x.text).slice(0, 10))}`);
    }
    let added = 0;
    for (let i = 0; i < arr.length && added < item.want; i++) {
      const entry = arr[i];
      // ⚠ A SKILL ALREADY ON THE FORM IS SKIPPED, NOT RE-ADDED (operator, 2026-08-20). The cap counts
      // what we ADD, which is why this walks the whole profile list and stops once `want` NEW ones are
      // in — capping the loop at `want` iterations instead would let eight already-present skills
      // consume the entire budget and add nothing at all.
      if (isSkills && typeof entry === "string" && haveSkills.indexOf(atsLib.normalize(entry)) !== -1) {
        log(`  ${item.block}: "${entry}" is already on the form — skipped`);
        continue;
      }
      added++;
      const tag = `${item.block} entry ${added}`;

      // ── OPEN ────────────────────────────────────────────────────────────────────────
      // ⚠⚠ ONE CALL: press Add and wait PAGE-SIDE for the form to render. The SW-side version of this
      // wait was 28 awaits of 150ms, and the MV3 worker's timers are STARVED — this run's own PACE
      // lines measured `a 150ms pace took 1555ms` and `an 80ms pace took 1226ms`. So the cost of a
      // poll is the NUMBER of awaits, not their length, and this was the largest single gap on the
      // page: 5067ms between an entry's discovery read and its first 20ms text write.
      //
      // Page-side timers are real, so the wait costs ONE cdpEval instead of ~28 starved ones. The
      // evidence is unchanged: a form that never renders comes back with no fields and the block
      // halts exactly as before. See atsInjOrcOpenEntryAndWait.
      const opened = await act.eval(atsInjOrcOpenEntryAndWait, item.pattern, ATS_ORC_PICK_MS).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
      if (!opened || !opened.ok) {
        log(`⛔ ${tag}: could not open an entry form — ${(opened && opened.error) || "unknown"}`);
        notes.push(`${tag}: not filled (${(opened && opened.error) || "could not open"})`);
        break;                       // the block is not workable; do not hammer it
      }
      const st = { ok: true, open: true, fields: opened.fields || [] };
      if (!st.fields.length) {
        log(`⛔ ${tag}: pressed ${JSON.stringify(opened.pressed)} but no entry form appeared`);
        notes.push(`${tag}: not filled (the entry form never rendered)`);
        break;
      }

      const recordsBefore = records.length;
      // ── THE RECON RECORD, EVERY RUN ─────────────────────────────────────────────────
      log(`${tag} — the form offers ${st.fields.length} field(s): ${st.fields.map((f) => `${f.name || f.id}[${f.role || f.type}]${f.label ? " “" + f.label + "”" : ""}`).join(", ")}`);

      // ── FILL ────────────────────────────────────────────────────────────────────────
      // ⚠ GROUP BY `name` FIRST. A date is TWO comboboxes sharing one name (measured: `startDate`
      // twice, `endDate` twice), so a field-at-a-time loop handed the same spec to both halves and
      // wrote the whole "2025-05" into whichever id came first — the slowest failing field of the
      // run at 8.2s. Grouping is also what makes the month/year split decidable at all.
      const map = ATS_ORC_ENTRY_MAPS[item.source] || {};
      const unmapped = [];
      const byName = new Map();
      for (const f of st.fields) {
        const k = f.name || f.id || "";
        if (!k) continue;
        if (!byName.has(k)) byName.set(k, []);
        byName.get(k).push(f);
      }
      for (const [key, group] of byName) {
        const spec = map[key] || null;
        if (!spec) { unmapped.push(key + (group[0].label ? " (" + group[0].label + ")" : "")); continue; }

        // ── the date pair: WHICH half is month and which is year is READ, not assumed ──
        if (spec.kind === "date_pair" && group.length >= 2) {
          const ym = atsOrcEntryValue(spec, entry);
          // ⚠ THE HALVES CARRY NO LABEL AT ALL on this form, so the review page showed the raw
          // platform name ("startDate"). Split the camelCase into words so the operator reads
          // "Start Date" — the same string a human sees above the pickers.
          const prettyDate = String(key).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
          const rec0 = { fieldName: `${item.source}[${i}].${key}`, label: group[0].label || prettyDate,
                         widgetType: "dropdown", isRequired: false, entrySection: item.source, entryIndex: i,
                         mappedPath: `${item.source}[${i}].${spec.path}`, status: "skipped", after: null, elapsedMs: 0 };
          if (ym == null) {
            rec0.detail = spec.blankWhenCurrent && entry && entry.currently_work_here === true
              ? "you still work here — the end date is deliberately left blank"
              : "this entry has no date for it — left blank rather than answered from elsewhere";
            rec0.flag = spec.blankWhenCurrent && entry && entry.currently_work_here === true ? null : "entry-unanswered";
            records.push(rec0); continue;
          }
          const t0 = Date.now();
          // ⚠ ONE VISIT PER HALF. Each picker is opened once, classified from the rows it shows, and
          // committed in the same visit — see atsInjOrcPickFromOwnList for the measurement that made
          // this necessary (the capture-then-pick split cost ~8s per entry on a picker whose first
          // open never registered, and it is what the operator saw as the dropdown opening twice).
          // Classification is still per-half and still evidence-based; it just no longer costs a
          // second open.
          const mNum = Number(ym.month);
          const NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
          const monthCands = mNum >= 1 && mNum <= 12
            ? [NAMES[mNum - 1], NAMES[mNum - 1].slice(0, 3), String(mNum).padStart(2, "0"), String(mNum)]
            : [];
          const yearCands = [String(ym.year)];
          const got_by = {}; const failed = [];
          let reopenTotal = 0;
          let halfIdx = -1;
          for (const g of group.slice(0, 2)) {
            halfIdx++;
            // ⚠ PACE BETWEEN THE HALVES. Committing the first half re-renders the widget, and the
            // second half's open lands mid-render — measured as a retry firing on EVERY startDate
            // (4108/4181/4168ms) while endDate, whose widget family is already warm, took
            // 809/834/795ms with no retry at all. That is systematic, not flaky, so it is cheaper to
            // wait 250ms once than to spend a failed attempt plus a 400ms recovery pace rediscovering
            // it on every entry.
            if (halfIdx) await act.delayFull(150);
            if (!g.id) { failed.push("a half with no id"); continue; }
            const sel = "#" + g.id.replace(/([^\w-])/g, "\\$1");
            // ⚠ ONE RETRY PER HALF, and only on failure. Committing the first half re-renders the
            // widget, so the second half's open can land mid-render — measured as
            // `after="May" … (year not retained)`: the month took and the year did not, on the FIRST
            // pair of a freshly-created entry form (endDate, moments later, took both halves in
            // 804ms). A retry costs nothing when the commit works and saves the whole entry when it
            // does not — Oracle refuses an entry whose required date is incomplete, so this one flake
            // was costing the other two work-history entries as well.
            let r = null, got = null;
            for (let attempt = 0; attempt < 2 && got == null; attempt++) {
              if (attempt) await act.delayFull(400);
              r = await act.eval(atsInjOrcPickFromOwnList, sel, monthCands, yearCands, ATS_ORC_PICK_MS).catch(() => null);
              reopenTotal += (r && r.reopens) || 0;
              if (!r || !r.ok) continue;
              // READ-BACK VERIFIED, but settled PAGE-SIDE inside the primitive — see the note there.
              // The verification is unchanged in strength: a half whose value did not stick still
              // comes back null and still fails the pair.
              if (r.value && !r.invalid) got = r.value;
            }
            if (!r || !r.ok) { failed.push((r && r.error) || "unknown"); continue; }
            if (got == null) { failed.push(r.kind + " not retained"); continue; }
            got_by[r.kind] = got;
          }
          rec0.elapsedMs = Date.now() - t0;
          // ⚠⚠ THIS VALUE GOES ON THE REVIEW PAGE AND INTO THE SUBMIT REPLAY — it is not a log line.
          // It used to be `month="May" year="2026"`, my own debug string, which the review editor then
          // rendered as a TEXT BOX for the operator to edit as raw markup, and which a replay would
          // have typed at the form verbatim. `current_value` is copied straight from `rec.after`, so
          // anything convenient for a log becomes the application's answer.
          rec0.after = [got_by.month, got_by.year].filter(Boolean).join(" ") || null;
          const okAll = !failed.length && got_by.month != null && got_by.year != null;
          rec0.status = okAll ? "filled" : "needs_review";
          if (!okAll) {
            rec0.flag = failed.some((x) => /unclassified/.test(String(x))) ? "date-halves-unidentified" : "commit-not-accepted";
            rec0.detail = `Oracle did not accept ${ym.month}/${ym.year} — got ${rec0.after || "nothing"}` +
              (failed.length ? ` (${failed.join("; ")})` : "");
          } else {
            rec0.detail = `month+year pair set from ${JSON.stringify(String(ym.month) + "/" + ym.year)}` +
              ` in one visit per half${reopenTotal ? ` (${reopenTotal} re-open(s) — the first click did not register)` : ""}`;
          }
          records.push(rec0); continue;
        }

        const f = group[0];
        if (group.length > 1) unmapped.push(`${key} ×${group.length} (only the first was filled)`);
        const value = atsOrcEntryValue(spec, entry);
        const rec = { fieldName: `${item.source}[${i}].${key}`, label: f.label || key,
                      widgetType: f.role === "combobox" ? "dropdown" : (f.type === "textarea" ? "textarea" : "text"),
                      isRequired: false, entrySection: item.source, entryIndex: i,
                      mappedPath: `${item.source}[${i}].${spec.path}`, status: "skipped", after: null, elapsedMs: 0 };
        if (value == null) {
          // The seal: an entry field with no answer IN ITS OWN ENTRY stops here. It does NOT fall
          // through to the label ladder or the AI, either of which would answer it from page-level
          // profile data — a different fact about a different subject.
          rec.detail = "this entry has no value for it — left blank rather than answered from elsewhere";
          rec.flag = "entry-unanswered";
          records.push(rec); continue;
        }
        if (!f.id) {
          rec.status = "needs_review"; rec.flag = "field-unaddressable";
          rec.detail = "the entry form rendered this field with no id, so it has no selector to actuate";
          records.push(rec); continue;
        }
        const sel = "#" + (f.id.replace(/([^\w-])/g, "\\$1"));
        const t0 = Date.now();
        if (f.role === "combobox") {
          // ORC's own typeahead — the same primitive step 1 uses, including the composite
          // first-segment match, because an entry's city picker offers "Tallahassee, Leon, FL" too.
          // ⚠ A TIERED VALUE IS TRIED MOST-SPECIFIC FIRST and stops at the first hit, which is the
          // whole point of the profile storing degrees as ["Bachelor of Science", "Bachelor's
          // Degree", "Bachelors"]: the form's own vocabulary decides, and nothing is guessed.
          const cands = Array.isArray(value) ? value.map(String) : [String(value)];
          let r = null, back = null;
          // ⚠⚠ ZERO ROWS OFFERED IS "THE SEARCH DID NOT ANSWER", NOT "YOUR VALUE IS NOT IN THE LIST",
          // and only the second is a finding. Measured on the Education Degree picker across two
          // consecutive runs of the same posting: one run offered exactly one row
          // ("BS - Bachelor of Science"), the next offered ZERO after burning the same full 8s budget.
          // The list is server-backed and its answer is sometimes simply late — the identical shape
          // as iCIMS' school search, where a 675ms give-up reported "no option matched" for a value
          // that returns first when typed by hand.
          //
          // So the whole candidate ladder is retried ONCE, and ONLY when the last attempt saw no rows
          // at all. A ladder that saw rows and matched none has genuinely answered, and retrying that
          // would just spend another 8s to be told the same thing.
          // ⚠ THE PRIMITIVE NOW SELF-HEALS A DEAD OPEN (it re-clicks), so this outer retry exists only
          // for the case it cannot fix: a server-backed search that genuinely answered nothing in
          // time. That is still worth one more try — zero rows is "the search did not answer", not
          // "your value is not in the list" — but it no longer has to cover a click that never
          // landed, which is what made it a full second 8s pass on every School pick.
          for (let attempt = 0; attempt < 2; attempt++) {
            for (const c of cands) {
              r = await act.eval(atsInjOrcPick, sel, c, [c], ATS_ORC_PICK_MS, false, true).catch(() => null);
              back = await act.eval(atsInjOrcReadPicker, sel).catch(() => null);
              if (r && r.ok && String((back && back.value) || "").trim() && !(back && back.invalid)) break;
            }
            const good = r && r.ok && String((back && back.value) || "").trim() && !(back && back.invalid);
            const sawRows = !!(r && r.rows && r.rows.length);
            if (good || sawRows) break;
            if (attempt === 0) {
              await act.delayFull(400);
              log(`  (${key}: the picker returned NO rows at all — one more try; a silent search is not the same as a search that answered)`);
            }
          }
          rec.after = back && back.ok ? back.value : null;
          rec.elapsedMs = Date.now() - t0;
          const ok = r && r.ok && String(rec.after || "").trim() && !(back && back.invalid);
          rec.status = ok ? "filled" : "needs_review";
          if (!ok) {
            rec.flag = "no-option-match";
            rec.detail = `Oracle's list did not accept any of ${JSON.stringify(cands.slice(0, 4))}`;
            // ⚠ ONE OPTION PER LINE, deliberately. The single combined line carrying a picker's
            // option list was unreadable through the dev-log channel (its content tripped a filter),
            // and "the list did not accept our value" without knowing what the list HELD is the
            // least actionable message a picker can produce — it was the whole reason the Education
            // entry stayed unexplained for two runs.
            const rows = (r && r.rows) || [];
            log(`  ↳ ${key}: wanted ${JSON.stringify(cands.slice(0, 4))}, and the picker offered ${rows.length} row(s):`);
            for (const row of rows.slice(0, 10)) log(`      · ${String(row).slice(0, 60)}`);
            if (!rows.length) log("      (none — the search returned nothing at all)");
          }
          else rec.detail = `picked ${JSON.stringify(rec.after)} from the form's own list`;
        } else {
          // A tiered value in a TEXT box takes the most specific wording — there is no list to
          // negotiate with, so the fallback tiers have nothing to add.
          const flat = Array.isArray(value) ? String(value[0]) : String(value);
          const w = await act.eval(atsInjSetText, sel, flat).catch(() => null);
          const back = await act.eval(atsInjReadValue, "oracle", sel, "text").catch(() => null);
          rec.after = back && back.ok ? back.value : null;
          rec.resolved = Array.isArray(value) ? value : undefined;
          rec.elapsedMs = Date.now() - t0;
          // Read-back verified like every other commit here: a write that did not stick is
          // needs_review, never a silent pass.
          const ok = w && w.ok && String(rec.after || "").trim();
          rec.status = ok ? "filled" : "needs_review";
          if (!ok) { rec.flag = "commit-not-accepted"; rec.detail = "wrote the value but the field did not keep it"; }
        }
        records.push(rec);
      }
      // ⚠ LOG EVERY ENTRY FIELD'S OUTCOME, not just whether the entry committed. Without this an
      // "Oracle refused the entry" line is unactionable: three entries failed on one run and the log
      // could not say whether the cause was a date half misidentified, a picker that rejected the
      // value, or a field written and taken back. The flat loop has printed per-field outcomes from
      // the start and that is exactly why its failures were one-run diagnoses.
      for (const r of records.slice(recordsBefore)) {
        log(`  ${r.fieldName} (${r.widgetType}) → ${r.status}${r.flag ? " · " + r.flag : ""}` +
            `${r.after != null ? ' · after=' + JSON.stringify(String(r.after).slice(0, 60)) : ""}` +
            ` · ${r.elapsedMs || 0}ms${r.detail ? " · " + r.detail : ""}`);
      }
      if (unmapped.length) {
        // Evidence for the next map line, and a review note so an unfilled entry field is visible
        // rather than merely absent.
        log(`${tag} — UNMAPPED entry field(s), left blank: ${unmapped.join(", ")}`);
        notes.push(`${tag}: unmapped field(s) ${unmapped.join(", ")}`);
      }

      // ── COMMIT ──────────────────────────────────────────────────────────────────────
      // ⚠ ONE CALL again — press the homonymous Add and wait page-side for the form to be GONE, for
      // the same starved-timer reason as the open above.
      const done = await act.eval(atsInjOrcCommitEntryAndWait, item.pattern, ATS_ORC_PICK_MS).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
      if (!done || !done.ok) {
        log(`⛔ ${tag}: could not commit — ${(done && done.error) || "unknown"}`);
        notes.push(`${tag}: filled but NOT committed (${(done && done.error) || "unknown"})`);
        break;
      }
      // Committed means the open form is GONE (no Cancel) — the primitive settled that page-side and
      // reports it. A form that stays open is ORC refusing the entry, almost always a required entry
      // field we left blank, so the pass CANCELS to leave the block clean rather than abandoning a
      // half-open form that would block Next, and says so.
      if (!done.closed) {
        log(`⛔ ${tag}: pressed ${JSON.stringify(done.pressed)} but the entry form stayed open — Oracle is refusing it, usually a required entry field we could not answer`);
        notes.push(`${tag}: Oracle refused the entry (a required field in it is unanswered)`);
        await act.eval(atsInjOrcEntryAction, item.pattern, "cancel").catch(() => null);
        break;
      }
      log(`✔ ${tag} committed`);
    }
  }
  return { records, notes };
}

// ⚠⚠ DOES THIS TILE ALREADY SAY WHAT WE WOULD WRITE? (speed round, 2026-08-20)
// On a re-run the form arrives holding exactly the entries the profile would produce, and the pass
// deleted all of them and typed the identical thing back — the single largest waste on step 2, since
// each entry costs an open, four fields (two of them date pairs) and a commit.
//
// The tile's own summary is the evidence: "Characterization and Test Automation Intern Rivian and
// Volkswagon Technologies 05/2026 - 08/2026". A match requires EVERY identifying string to be present,
// which is the conservative direction — anything unrecognised falls through to delete-and-refill, so a
// changed employer, a corrected title or an edited date still rewrites the block.
//
// ⚠ This does NOT relax the operator's "delete old entries before filling" instruction. An entry that
// already states the right thing is not an old entry; deleting and retyping it changes nothing on the
// application and costs seconds. A PARTIAL match is still a full delete-and-refill.
function atsOrcEntryIdentity(source, entry) {
  if (!entry) return null;
  const val = (k) => {
    const v = entry[k];
    if (v == null) return "";
    return Array.isArray(v) ? String(v[0] || "") : String(v);
  };
  if (source === "work_experience") {
    const parts = [val("company"), val("job_title")].map((x) => x.trim()).filter(Boolean);
    return parts.length === 2 ? parts : null;      // both, or we cannot claim a match
  }
  if (source === "education") {
    const parts = [val("school_or_university")].map((x) => x.trim()).filter(Boolean);
    return parts.length ? parts : null;
  }
  if (source === "skills") return typeof entry === "string" && entry.trim() ? [entry.trim()] : null;
  return null;                                     // an unknown section never claims a match
}

// True when the tiles on the form already are the entries we would write — same count, and each
// wanted entry matched by a DISTINCT tile (order-independent, because the form may sort them).
// ── DOES THIS TILE ALREADY SHOW THIS VALUE? (operator, 2026-08-21) ───────────────────────────
// "for the experience section, no need to go in and edit each one, you can read the information and
// parse it directly from the dom and you only change it if something is wrong. Same for education."
//
// The tile summary carries the entry's content, so the cheap check is whether every value the human
// approved is visible in it. Opening an entry is then the EXCEPTION — which matters for more than
// speed: opening is the риskiest thing this pass does (it is what produced the second-close failure
// that cascaded through a whole section), so not doing it is strictly safer.
//
// ⚠ DATES ARE THE ONE THING THAT NEEDS TOLERANCE. The tile renders "05/2025" while the record stores
// "May 2025" — the same fact in two vocabularies, and a raw containment test would call every date
// wrong and open every entry, which is exactly the work this avoids. So a month+year on either side
// is reduced to a canonical key before comparing.
// ⚠ ATS_MONTHS already exists at the top of this file (capitalised). The service worker evaluates
// this whole file into ONE scope, so a second declaration is a SyntaxError that kills the worker —
// the documented "never re-declare an imported name" trap, caught here by node --check.
function atsYearMonthKey(v) {
  const t = String(v == null ? "" : v).trim().toLowerCase();
  if (!t) return null;
  let m = /^(\d{4})[-/](\d{1,2})$/.exec(t);                       // 2025-05
  if (m) return m[1] + "-" + String(Number(m[2])).padStart(2, "0");
  m = /^(\d{1,2})[-/](\d{4})$/.exec(t);                            // 05/2025
  if (m) return m[2] + "-" + String(Number(m[1])).padStart(2, "0");
  m = /^([a-z]+)\s+(\d{4})$/.exec(t);                              // May 2025
  if (m) {
    const i = ATS_MONTHS.findIndex((n) => { const l = n.toLowerCase(); return l === m[1] || l.slice(0, 3) === m[1].slice(0, 3); });
    if (i >= 0) return m[2] + "-" + String(i + 1).padStart(2, "0");
  }
  return null;
}
function atsOrcTileHoldsValue(tileText, value) {
  const tile = String(tileText == null ? "" : tileText);
  const v = String(value == null ? "" : value).trim();
  if (!v) return true;                          // nothing approved ⇒ nothing to disagree with
  if (!tile) return false;
  if (atsLib.normalize(tile).indexOf(atsLib.normalize(v)) !== -1) return true;
  // the date case: compare canonical month+year keys, both directions
  const want = atsYearMonthKey(v);
  if (!want) return false;
  const seen = (tile.match(/\b(?:[A-Za-z]+\s+\d{4}|\d{1,2}[-/]\d{4}|\d{4}[-/]\d{1,2})\b/g) || [])
    .map(atsYearMonthKey).filter(Boolean);
  return seen.indexOf(want) !== -1;
}

function atsOrcTilesAlreadyMatch(source, entries, want, tiles) {
  if (!Array.isArray(tiles) || !Array.isArray(entries)) return false;
  if (!want || tiles.length !== want) return false;
  const norm = (v) => atsLib.normalize(String(v || ""));
  const pool = tiles.map((x) => norm(x && x.text));
  for (let i = 0; i < want; i++) {
    const id = atsOrcEntryIdentity(source, entries[i]);
    if (!id) return false;                          // cannot identify ⇒ cannot claim a match
    const at = pool.findIndex((tx) => tx && id.every((part) => tx.indexOf(norm(part)) !== -1));
    if (at === -1) return false;
    pool[at] = null;                                // consume it — two entries cannot share a tile
  }
  return true;
}

function atsOrcEntryPlan(profile, blocks) {
  const present = Array.isArray(blocks) ? blocks : [];
  const out = [];
  for (const spec of ATS_ORC_ENTRY_BLOCKS) {
    const re = new RegExp(spec.pattern, "i");
    if (present.length && !present.some((b) => re.test(String(b || "")))) continue;
    const arr = (profile || {})[spec.source];
    const n = Array.isArray(arr) ? arr.filter((e) => e != null && String(e).trim() !== "").length : 0;
    if (!n) continue;
    out.push({ block: spec.label, pattern: spec.pattern, source: spec.source, want: Math.min(n, ATS_ORC_ENTRY_MAX),
      capped: n > ATS_ORC_ENTRY_MAX ? n : 0 });
  }
  return out;
}

// ── ORC's ADDRESS IS ONE ANSWER, NOT FIVE (operator, 2026-08-19) ─────────────────────────
// Measured with the operator: typing a postal code and pressing Enter on its single row fills CITY,
// STATE and COUNTY by itself -- "32312" -> "32312, Tallahassee, Leon, FL" -> city Tallahassee, state
// FL, county Leon, all accepted, no further actuation. So the address block is ONE decision expressed
// through the most specific field, not five independent ones.
//
// That also explains a failure I mis-diagnosed for most of a session. Filling the five in sequence
// looked like "each commit deletes the others", and I wrote that down. The real cause was the house
// CLEAR-BEFORE-TYPING step: clearing a geo picker cascades to its siblings, so every pick was wiping
// what the previous pick had auto-filled. The fields were never deleting each other -- I was.
//
// So the plan is: actuate the ANCHOR only, then VERIFY the dependents. A dependent that came back
// correct is `already-filled` (audit-excluded, never re-actuated -- the standing rule for a field
// that holds a live value); one that came back wrong or empty is a review item, NOT something to
// type into, because typing into it would clear the anchor that produced the rest.
//
// The anchor is the postal code because it is the most specific: measured, "32312" resolved to
// exactly ONE row while "Tallahassee" resolved to TWO (Jefferson and Leon counties) -- and the
// profile stores no county at all, so the city route is genuinely ambiguous from the data we hold.
// Falling back to city when there is no postal code is deliberate and flagged: it can pick the wrong
// county, which is exactly the kind of confidently-wrong value that belongs in review.
var ATS_ORC_GEO_ANCHOR = ["postalCode", "city", "region2", "region1"];

// ⚠ `valueFor` EXISTS BECAUSE A REPLAY PASSES `profile: {}` BY DESIGN. Without it this returned null
// on the submit run -- no profile, so nothing to anchor on, so no roles stamped -- and `city` was
// typed straight back in from the approved bundle, clearing the anchor that had just produced it.
// Caught by a test rather than live, but it is the SAME failure iCIMS paid for with 28 of a
// rehearsal's 32 verify failures ("grow repeating entries from the BUNDLE, not the profile"): any
// pass that derives structure from the profile is silently disabled on replay.
function atsOrcGeoPlan(fields, profile, valueFor) {
  const list = Array.isArray(fields) ? fields : [];
  const geo = list.filter((f) => f && f.searchDriven && f.widgetType === "select");
  if (!geo.length) return null;
  const byName = {};
  for (const f of geo) byName[f.fieldName] = f;
  const pi = (profile && profile.personal_info) || {};
  // `country` is the geo ROOT and mounts the rest -- it is not an anchor candidate and is filled
  // normally (measured: clearing it unmounts the whole block).
  const fromProfile = { postalCode: pi.postal_code, city: pi.city, region2: pi.state_province, region1: null };
  for (const name of ATS_ORC_GEO_ANCHOR) {
    const f = byName[name];
    // On a replay the approved bundle is the ONLY source; on a fill it is the profile.
    const v = (typeof valueFor === "function" && f) ? valueFor(f) : fromProfile[name];
    if (f && v != null && String(v).trim()) {
      return {
        anchor: f,
        anchorValue: String(v).trim(),
        // everything else in the block is verified, never actuated
        dependents: geo.filter((g) => g !== f && g.fieldName !== "country"),
        exact: name === "postalCode",
        detail: name === "postalCode"
          ? "Oracle resolves the whole address from the postal code"
          : "no postal code in profile, so the address is anchored on " + name +
            " -- that can resolve to more than one county, so the result needs checking",
      };
    }
  }
  return null;
}

// ── SHOULD THIS ORC PICKER BE ENUMERATED FOR REVIEW? (2026-08-19) ────────────────────────
// The judgement half of the option capture, SW-side so there is one copy of the policy.
//
// The operator's rule is an ASYMMETRY, and it decides every uncertain case here: a picker MISSING
// their answer makes them conclude the form does not offer it, while a complete list wrongly called
// partial only costs them a typed value. So this errs toward "do not claim a list".
//
//   • a NON-geo picker → capture, and the result is COMPLETE, because an empty open on ORC returns
//     the whole vocabulary (measured: country = 251 rows) and there is no pager to defeat us.
//   • a `searchDriven` (geo-hierarchy) picker → NEVER captured. Two independent reasons, either
//     sufficient: its list is DEPENDENT (a child with an uncommitted parent answers "No results", so
//     a capture at scan time would record an empty or wrong vocabulary as if it were the field's),
//     and for city/postal it is effectively UNBOUNDED, so an empty open could never be the picker —
//     exactly why Workday's capture skips SKILLS. It reaches review as type-it-yourself, which is
//     the honest rendering. ⚠ Touching these has also already proven destructive during recon.
//   • anything already carrying options from the scan (radio/checkbox groups read their own labels
//     inline) needs no capture at all.
//
// ⚠ `country` is the one field this deliberately under-serves: it IS a fixed 251-item vocabulary and
// it is the geo ROOT, so it could be enumerated. It is skipped anyway because it wears the same
// declared geo class as its dependents, and keying on "which geo field is the root" would be a
// guess about tenant configuration. The cost is one typed value on a 251-item list; noted rather
// than silently accepted.
function atsOrcCaptureEligible(f) {
  if (!f) return false;
  if (f.searchDriven) return false;
  if (Array.isArray(f.options) && f.options.length) return false; // already enumerated inline
  return f.widgetType === "select";
}

// ── WHICH ORACLE APPLY-FLOW VIEW ARE WE LOOKING AT? (2026-08-19) ─────────────────────────
// The ORC pre-form walk is a loop over views, exactly like the iCIMS one above, and this is the
// judgement half — pure, so the sequencing in background.js has nothing to decide.
//
// Views, and why the ORDER is what it is:
//   "captcha"  — FIRST, ahead of anything actionable. The bot never solves or bypasses one; the
//                only correct response is to stop for the operator, and that must not be
//                reachable-around by a later branch that happens to find a fillable box.
//   "form"     — a VISIBLE apply-flow-section: we have arrived, and the stage is DONE. Checked
//                before the auth views so a form that happens to keep an email box (ORC prefills
//                `email` from the gate) is never mistaken for the gate itself.
//   "code"     — the six #pin-code-N boxes ("Confirm Your Identity"). Above "email" because the
//                code screen is where the email gate LEADS, and on some tenants the flow lands
//                straight here with the gate's markup still in the document.
//   "email"    — the quick-apply gate (`quick-email-verification-form` / `primary-email-*`).
//   "password" — a real sign-in. Distinct from "email" because it needs the stored password, not
//                just the login, and because ORC's quick gate never has one (measured: Nokia and
//                Baylor both ask for an email and nothing else).
//   "blocked"  — no field we can fill, but federated sign-in or account creation is on offer.
//                Those controls are REPORTED, never pressed. Saying "blocked" beats "unknown".
//   "posting"  — still on the job description with an Apply control: the flow has not been
//                entered yet, so the caller should press it.
//   "none"     — nothing recognizable.
//
// ⚠ Deliberately NO control-count bound, unlike icimsAuthView. iCIMS needed one because its
// sign-in card and its application form are both "a form with an email box", so only size
// separated them. ORC declares the difference structurally — `apply-flow-section` exists on the
// form and does not exist on the gate (measured `sections: 0` on the pin screen) — and a declared
// signal always beats a threshold.
function orcApplyView(s) {
  if (!s || !s.ok) return "unreadable";
  if (s.captchaChallenge) return "captcha";
  if (s.formSectionVisible) return "form";
  if (Number(s.pinInputs || 0) > 0) return "code";
  if (s.emailGate || s.emailInput) return "email";
  if (s.passwordInput) return "password";
  if ((s.federated || []).length || (s.createAccount || []).length) return "blocked";
  if (s.applyControl) return "posting";
  return "none";
}

// ── WHAT KIND OF CHECKBOX IS THIS? (operator, 2026-08-18) ────────────────────────────────
// The operator read ITT's and Peraton's privacy notices themselves and instructed that **accept
// checkboxes be ticked, now and in the future**. They are the data subject, the notices govern the
// processing of THEIR data for THEIR application, and refusing them means the application cannot be
// made at all — so this is theirs to delegate. It replaces the earlier `consent-required` halt.
//
// The authorisation is precise, so the recognizer is too. Ticking a box is a legal act, and "all accept
// checkboxes" is not the same set as "all checkboxes":
//
//   "accept"  — I accept / I agree / I acknowledge / I have read <a notice, policy, terms, GDPR>.
//               This is what was authorised: assent to a document governing the application.
//   "optin"   — send me jobs, add me to a talent community, contact me about future roles. NOT an
//               acceptance of anything; ticking it signs the operator up for mail they never asked
//               for, and leaving it unticked costs them nothing. Never ticked.
//   null      — anything else (a "still enrolled?" box, "upload résumé later", a screening question).
//               Untouched, as before.
//
// ⚠ Deliberately NOT classed "accept": a TRUTHFULNESS attestation ("I certify the information given is
// accurate", "I understand falsification is grounds for dismissal"). Those are a factual claim by the
// applicant rather than assent to a notice, they carry a different consequence when wrong, and the
// instruction that authorised this was about privacy notices. They stay out until asked for by name.
// Cookie/consent BANNERS are also out of scope — unrelated to applying, and the standing rule to
// prefer the privacy-preserving option there is untouched.
var ATS_CONSENT_ACCEPT_RE = /\b(i\s+(accept|agree|consent|acknowledge|have\s+read)|accept(ing)?\s+the|agree\s+to\s+the|consent\s+to\s+the)\b|\bgdpr\b|privacy\s+(notice|policy|statement)|data\s+protection|terms\s+(of\s+(use|service)|and\s+conditions)/i;
// ⚠ THE `receive … job opportunities` ARM WAS ADDED FROM A LIVE MISS (Oracle, 2026-08-19). Its
// job-alerts box says "I agree to receive new job opportunities (see oracle.com privacy policy)" —
// no "job alerts", no "future jobs", so none of the original arms fired and the ACCEPT arm claimed
// it. The declared-intent check in atsConsentKind is the primary fix; this is the belt for a tenant
// that ships the same wording without the `<opt-in>` wrapper.
var ATS_CONSENT_OPTIN_RE = /\b(talent\s+(community|network)|job\s+alerts?|email\s+me|notify\s+me|keep\s+me\s+(informed|posted)|marketing|newsletter|similar\s+(jobs|roles|openings)|future\s+(jobs|roles|opportunities|openings))\b|\b(receive|send\s+me|text\s+me)\s+(new\s+|other\s+|additional\s+|further\s+)?(job|career|employment)\s+(opportunit|alert|posting|opening)|\bnew\s+job\s+opportunit/i;
// A truthfulness attestation — recognized ONLY so it can be excluded on purpose rather than by
// accident, and so a future decision about it has a name to refer to.
var ATS_CONSENT_ATTEST_RE = /\b(i\s+certify|i\s+declare|i\s+affirm|under\s+penalty|falsif(y|ication)|to\s+the\s+best\s+of\s+my\s+knowledge)\b/i;
// text = whatever describes the box (label, its row, the consent's own title). Most specific wins:
// an opt-in that merely mentions "privacy" must not read as an acceptance.
// ⚠ AN OPT-IN CAN BE WORDED EXACTLY LIKE AN ACCEPTANCE — so DECLARED INTENT decides first
// (live on Oracle's own careers site, 2026-08-19). Its job-alerts box reads:
//
//     "I agree to receive new job opportunities (see oracle.com privacy policy)"
//
// which hits ATS_CONSENT_ACCEPT_RE on "i agree" and does NOT hit the opt-in wordings (it says
// neither "job alerts" nor "future jobs"), and it even name-drops a privacy policy. Measured: it
// classified as **accept**, i.e. it would have been TICKED — subscribing the operator to marketing
// mail, the one thing the accept-checkbox authorisation explicitly excludes. Wording alone cannot
// separate these two, because a marketer writes an opt-in in the language of assent.
//
// So `hints` (the page's own structural declaration) is consulted BEFORE any text: Oracle wraps the
// box in `<job-alerts-opt-in>` / `<opt-in>` and ids it `job-alerts-checkbox`. A control the page
// itself files under "opt-in" is an opt-in whatever its prose claims.
//
// ⚠ The remaining ambiguity is resolved toward "optin" ON PURPOSE, and the asymmetry is the reason:
// wrongly ticking an opt-in silently signs the operator up for mail they never asked for and cannot
// be undone from a review page, while wrongly NOT ticking an acceptance halts LOUDLY
// (`consent-not-accepted`) and costs one operator click. Silent-and-wrong loses to loud-and-wrong.
//
// `hints` is optional, so every existing caller (iCIMS) behaves byte-identically.
// ⚠ NO `\b` HERE, deliberately — and that is the difference between prose and an IDENTIFIER.
// Hints are element names, ids and `name` attributes: `job-alerts-opt-in`, `marketingOptIn`,
// `optInCheckbox`. camelCase has no word boundary between "marketing" and "Opt", so a
// boundary-anchored test misses exactly the ids most likely to appear. Substring matching is safe
// in this space because these tokens do not occur inside unrelated English words ("adoption",
// "description" contain no "optin"), whereas in PROSE the boundaries are load-bearing — which is
// why ATS_CONSENT_OPTIN_RE keeps them.
var ATS_CONSENT_OPTIN_DECLARED_RE = /opt-?in|job-?alert|marketing|subscribe|newsletter/i;

function atsConsentKind(text, hints) {
  const t = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  const h = hints || {};
  const declared = [].concat(h.containers || [], h.id ? [h.id] : [], h.name ? [h.name] : []).join(" ");
  if (declared && ATS_CONSENT_OPTIN_DECLARED_RE.test(declared)) return "optin";
  if (!t) return null;
  if (ATS_CONSENT_OPTIN_RE.test(t)) return "optin";
  if (ATS_CONSENT_ATTEST_RE.test(t)) return "attestation";
  if (ATS_CONSENT_ACCEPT_RE.test(t)) return "accept";
  return null;
}
// The gate's boxes, decided. Returns what to TICK and what was deliberately left alone, so the caller
// can log both — an acceptance made on the operator's behalf must be visible in the run, by name.
function atsConsentPlan(consents) {
  const list = Array.isArray(consents) ? consents : [];
  const out = { tick: [], left: [] };
  for (const c of list) {
    if (!c) continue;
    // hints are FIRST-CLASS: a page that files a box under <opt-in> has told us what it is, and that
    // outranks its prose (see atsConsentKind). Absent on iCIMS scans, so that path is unchanged.
    const kind = atsConsentKind([c.label, c.rowText, c.title].filter(Boolean).join(" · "),
      { containers: c.containers, id: c.id, name: c.name });
    const rec = { ...c, kind };
    if (kind === "accept" && !c.checked) out.tick.push(rec);
    else out.left.push(rec);
  }
  return out;
}

// ── A DECOY FIELD: VISIBLE BY EVERY MEASURE, AND WRITING TO IT SABOTAGES THE APPLICATION ─────────
// Oracle Recruiting Cloud's apply gate ships a bot-detection HONEYPOT next to the real email box
// (observed live 2026-08-19, Nokia):
//
//   <input class="input-row__control" id="honey-pot-1" name="honey-pot"
//          cssclass="input-row--invisible" aria-label="honeypot" aria-hidden="true" tabindex="-1">
//
// ⚠ EVERY VISIBILITY TEST THIS PIPELINE OWNS PASSES IT. Measured on the live page: rect 179×38, the
// closest `div` 179×19, `offsetParent` NOT null, `display:inline-block`, `visibility:visible`,
// `opacity:1`. The Greenhouse/Lever scan predicate (`rect.width > 0 && rect.height > 0`, optionally
// on `el.closest("div")`) therefore admits it as an ordinary required-less text field.
//
// Why that is worse than it looks. Being OPTIONAL, the AI tier never touches it (AI is REQUIRED-only)
// and it would end blank — so the fill looks clean. But it still reaches the REVIEW EDITOR as a
// fillable box, and anything typed there is replayed on submit. **No read-back catches this: the
// write succeeds.** The failure is invisible from inside the pipeline and lands on the employer's
// side as "this application was filed by a bot" — the one failure class that cannot be recovered from
// a review page afterwards, and the reason this is a recognizer rather than a filter.
//
// ⛔ DO NOT "FIX" THIS BY TIGHTENING THE VISIBILITY TEST. That is the Workday dropdown-chip dead end
// (tried twice, confirmed): the element is genuinely visible by every computed-style measure. The only
// honest signal is the intent the PAGE DECLARES about the control.
//
// Judgement lives here, SW-side, and the scan only REPORTS markers — the same split `atsInjAuthScan` /
// `atsConsentKind` uses, so there is ONE copy of a rule this consequential rather than an injected dup
// that can drift.
//
// The primary signal is deliberately GENERIC, not an Oracle name match: a control the page hides from
// assistive technology AND removes from tab order is not a control a human is being asked to fill, on
// any platform. `aria-hidden` alone is NOT enough — a decorative wrapper around a real input can carry
// it — and `tabindex="-1"` alone is NOT enough either, since custom widgets routinely park a
// programmatically-focused input out of tab order. Requiring BOTH is what makes it precise. The name /
// label match is a belt for a tenant that ships only one of them.
function atsDecoyKind(f) {
  if (!f) return null;
  const name = String(f.fieldName == null ? "" : f.fieldName);
  const label = String(f.ariaLabel == null ? "" : f.ariaLabel);
  const cssClassAttr = String(f.cssClassAttr == null ? "" : f.cssClassAttr);
  // A NAMED honeypot is a honeypot whatever else it does — anchored on a word boundary so a genuine
  // field is never claimed by a substring ("phone-number" must not match "honey").
  if (/\bhoney[\s_-]?pot\b/i.test(name) || /\bhoney[\s_-]?pot\b/i.test(label)) return "honeypot";
  // The page's own "do not show this to anyone" pair.
  const hiddenFromAt = f.ariaHidden === true || String(f.ariaHidden) === "true";
  const outOfTabOrder = String(f.tabIndex) === "-1";
  if (hiddenFromAt && outOfTabOrder) return "aria-hidden+untabbable";
  // A wrapper the tenant itself marks invisible, via ORC's Knockout `cssclass` binding attribute.
  // Only trusted alongside one of the two signals above, because a class NAME is the tenant's
  // vocabulary and could plausibly mean something else on its own.
  if (/(^|[\s_-])(invisible|hidden|offscreen)([\s_-]|$)/i.test(cssClassAttr) && (hiddenFromAt || outOfTabOrder)) return "invisible-wrapper";
  return null;
}

// SSO refusal is URL-EVIDENCED ONLY (the Workday invariant, verbatim): a real federated login
// LEAVES the portal host. Field-absence proves nothing — a still-rendering auth widget looks
// identical to a provider redirect, and that mistake produced a flat-wrong `sso` halt on Workday.
var ICIMS_SSO_HOST_RE = /(^|\.)(okta(preview)?\.com|onelogin\.com|pingidentity\.com|auth0\.com|accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|appleid\.apple\.com|www\.linkedin\.com)$/i;
var ICIMS_SSO_PATH_RE = /\/(saml2?|sso|openid|oauth2?|idp)(\/|$)/i;
function icimsLooksLikeSso(url, portalHost) {
  let u = null;
  try { u = new URL(String(url == null ? "" : url)); } catch (e) { return false; }
  const host = u.hostname.toLowerCase();
  // Still on the portal ⇒ never SSO, whatever the path says. iCIMS' own routes include `/login`,
  // and a tenant vanity path must not be read as a federation hop.
  if (portalHost && host === String(portalHost).toLowerCase()) return false;
  if (ICIMS_SSO_HOST_RE.test(host)) return true;
  return ICIMS_SSO_PATH_RE.test(u.pathname);
}

// ⚠ NOT EVERY icims.com LOGIN IS THE CANDIDATE'S. `login.icims.com` is iCIMS' Auth0 universal
// login for RECRUITERS — traced 2026-08-16, `/u/login/identifier` with the customer's own org name
// on it, reached by wandering one path off the candidate portal (`/jobs/intro` redirects there).
// It renders an email box, so the auth scan would classify it `email` and type the candidate's
// account address into a STAFF login. The host is the whole tell, and it is a host we can never
// have business on: the candidate portal always lives on a TENANT subdomain.
// Checked ahead of the SSO test, because the SSO test deliberately exempts icims.com hosts.
function icimsIsAdminLogin(url) {
  try { return new URL(String(url == null ? "" : url)).hostname.toLowerCase() === "login.icims.com"; }
  catch (e) { return false; }
}

// iCIMS can answer the email gate by MAILING you a one-time link instead of showing a password
// box — that is where the `?eem=…&code=…` magic-link session this tenant was first driven with
// came from. Such a page has no field to fill and no button worth pressing, so it must be
// recognised: without this it lands in the generic "unknown page" halt, which tells the operator
// nothing about the fact that the next step is sitting in their inbox.
// Anchored on the SENDING claim, not the word "email" (the gate itself says "Email" as a label).
var ICIMS_MAILED_LINK_RE = /\b(we('ve| have)? (just )?(sent|emailed|e-mailed)|(an? )?(email|link|code) (has been|was) sent|check your (e-?mail|inbox)|sent you (an? )?(e-?mail|link|code))\b/i;
function icimsMailedCredential(bodyText) {
  return ICIMS_MAILED_LINK_RE.test(String(bodyText == null ? "" : bodyText));
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

// ── A LONE ASSERTION CHECKBOX ANSWERS "NO" BY STAYING UNTICKED (operator, 2026-08-20) ──────
// The twin of atsAssertionLead above. That one finds the option a STATED assertion matches; this one
// recognises that for a form offering exactly ONE tickable assertion, the negative answer is not an
// option at all — it is the ABSENCE of a tick, and the box already holds it.
//
// Seen first on Oracle's ethnicity question (label "Ethnicity", one option, "I am Hispanic or
// Latino.", profile "No, I am not Hispanic"), but written for the shape rather than the question:
// veteran status, disability, and most single-box self-ID questions are put the same way, and every
// tenant words both halves differently. Nothing here knows what the question is ABOUT — relevance was
// already established by whatever routed the profile value to this field.
//
// ⚠ THE OPTION MUST READ AFFIRMATIVELY. A negatively-worded box ("I do NOT consent…", "I decline…")
// makes "no" a DOUBLE NEGATIVE, and which way that resolves is exactly the kind of thing this
// codebase refuses to guess — those fall through and get flagged for a human, as before.
//
// ⚠ AND IT ONLY EVER RECOGNISES A NO. A yes-polarity answer is left to the tiers above (assertion-lead
// ticks it), because a YES we fail to express must still be surfaced: the difference matters, since
// "leave it unticked" is indistinguishable from "we never got to it" on the page itself.
const ATS_OPTION_NEGATIVE_RE = /\b(not|never|no longer|decline|declines?|opt[- ]?out|unwilling)\b/i;
function atsAssertionDeclined(candidate, optionText) {
  const c = String(candidate == null ? "" : candidate).trim();
  const o = String(optionText == null ? "" : optionText).trim();
  if (!c || !o) return false;
  if (ATS_NEG_LEAD_RE.test(o) || ATS_OPTION_NEGATIVE_RE.test(o)) return false;  // double negative ⇒ refuse
  if (/^(false|no)$/i.test(c)) return true;                 // a coerced boolean, or a bare "No"
  if (/^\s*(no|false)\b/i.test(c)) return true;             // "No, I am not Hispanic"
  if (ATS_NEG_LEAD_RE.test(c)) return true;                 // "I am not a protected veteran"
  if (/^\s*not\b/i.test(c)) return true;                    // "Not Hispanic or Latino"
  return false;
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
// A degree spelled out reduces to its OWN initials, and that is not a guess: "Bachelor of Science" is
// what "BS" abbreviates. `of/in/the/and` are dropped, so "Master of Business Administration" → "MBA".
function atsDegreeAcronym(text) {
  const words = String(text == null ? "" : text)
    .replace(/[().,]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !/^(of|in|the|and|a)$/i.test(w));
  if (words.length < 2) return null;             // "Bachelors" has no acronym to build
  return words.map((w) => w[0].toUpperCase()).join("");
}
function atsDegreeMatch(candidates, options) {
  const norm = (s) => String(s == null ? "" : s).replace(/[.\s]/g, "").toUpperCase();
  // ⚠ THE ACRONYM TIER COMES FIRST, and it is what makes an abbreviation list usable (live 2026-08-18,
  // Cretex: "AS · BS · MS · PhD · MBA · MCS · BCS · BA"). The level tier below cannot answer that list at
  // all — BS, BCS and BA are ALL "bachelor", so its exactly-one guard correctly refuses, and the option
  // the applicant plainly holds stays unreachable. Initials are exact, not fuzzy: "Bachelor of Science"
  // abbreviates to BS and to nothing else, so a unique hit is a fact about the words rather than a
  // similarity score. Still guarded by uniqueness, so a list carrying both "BS" and "B.S." asks a human.
  for (const c of candidates || []) {
    const ac = atsDegreeAcronym(c);
    if (!ac) continue;
    const hits = (options || []).filter((o) => norm(o) === norm(ac));
    if (hits.length === 1) return hits[0];
  }
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
// ⚠ DISPLAY LABEL vs MATCH LABEL. `f.label` is what the REVIEW PAGE shows, and for a composite part
// the scan composes it as "<question> — <part>" ("Start Date — Month") so the row reads properly. The
// MATCHING layer must keep seeing the control's own raw name, which is what it saw before that display
// change — otherwise a date part stops matching its date-group spec and falls through to the AI, which
// then invents a work-experience date the profile already answers (observed live 2026-08-17: "Jun 1
// 2026", reasoned from "typical summer internship start date"). One helper, used at every label-keyed
// rung, so a future display tweak cannot reach the matcher again.
function atsMatchLabel(f) {
  return String((f && (f.partLabel || f.label)) || "");
}

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
    // `defaults` threaded through for the day-of-month fallback (see atsDefaultDay) — the entry seal is
    // unaffected: a default is the OPERATOR's own setting, not another entry's data.
    const r = atsResolveEntryField(es, entry, f, undefined, defaults);
    if (r) return r;
    return { kind: "entry-unanswered", source: "entry", section: es.section, entryIndex: es.entryIndex };
  }
  // A REPEAT of a field the profile answers with a single value — the second address row, the second
  // phone row. Claimed BEFORE the static map below, because that map is keyed on the ordinal-stripped
  // id and would otherwise answer every entry identically.
  // ⚠ Only ever reached when the FORM ACTUALLY RENDERED more than one (see atsAssignEntryIndexes) —
  // nothing here declares which blocks repeat, so a tenant whose phone is a single row never sees it.
  if (ats === "icims" && typeof f.repeatIndex === "number" && f.repeatIndex > 0) {
    const what = String(f.label || "").replace(/[*✱:]\s*$/, "").trim();
    return { kind: "skip", source: "repeat-entry",
      detail: "this form renders more than one " + (what ? '"' + what + '"' : "of this field") +
        " and your profile holds a single value for it — the extra entry is left for you to fill on the form" };
  }
  const map = (ATS_STATIC_MAPS[ats] || {})[atsMapKey(ats, f.fieldName)];
  if (map) {
    if (map.kind === "resume") return { kind: "resume", source: "map" };
    if (map.kind === "skip") return { kind: "skip", source: "map", detail: map.detail };
  // ⚠⚠ `siteLink` IS A REPEATING FAMILY, so the ORDINAL picks WHICH website (operator, 2026-08-20).
  // The control is `name="siteLink-1"` inside `<candidate-links>`, with "Add Another Link" creating
  // `siteLink-2`, `-3`… — and atsMapKey strips a trailing `-<digits>` for Oracle, so EVERY one of
  // them reduces to the same map key. Returning "the first website" therefore filled link 1 correctly
  // and would have written that SAME url into every further link the moment a second input existed:
  // a duplicate the operator would have to delete, from a rung that looked like it was working.
  //
  // The ordinal is a POSITION, not a render counter (unlike the `-7` on the id), so it indexes the
  // profile's own ordered list of non-empty websites. Beyond the end ⇒ null, which leaves the extra
  // input blank rather than repeating the last url.
  if (map.kind === "selfid_disability") {
    // same one-liner the map branch below uses; it is scoped inside that branch, so it is repeated
    // here rather than hoisted — hoisting it would change the shape of a rung this file has settled.
    const raw = map.path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), profile);
    if (raw == null || String(raw).trim() === "") return { eeoUnstated: true };
    const list = atsFd.selfIdDisabilityCandidates(String(raw));
    return { candidates: (list && list.length ? list : [String(raw)]), source: "eeo",
             path: map.path };   // NO containment — the ladder ends in a polarity token that lands exactly
  }
  if (map.kind === "website") {
    const list = atsProfileWebsites(profile);
    if (!list.length) return null;
    const m = /-(\d+)$/.exec(String(f.fieldName || ""));
    const idx = m ? Math.max(0, Number(m[1]) - 1) : 0;
    const hit = list[idx];
    return hit ? { raw: hit, path: "websites[" + idx + "].url", source: "map" } : null;
  }
    // ⚠ A LITERAL ANSWER, for a question whose answer is a fact about the FORM, not about the applicant.
    // Used by the address Type below: the one address a profile holds is the candidate's own residence, so
    // "Home" is not a guess and there is no profile field to read it from. Still a CANDIDATE list through
    // the ordinary ladder — the tenant's wording ("Home", "Home Address", "Residence") is matched against
    // its live options, never blind-committed.
    if (Array.isArray(map.candidates) && map.candidates.length) {
      return { candidates: map.candidates.slice(), source: "map", path: map.note || "(form-shape constant)",
        detail: map.detail || null };
    }
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
  // A taught wording is matched against the control's own name too (atsMatchLabel), so the display
  // composition cannot silently orphan every bucket on a composite question.
  if (bucketIndex && atsMatchLabel(f)) {
    const bk = atsLib.normalizeLabel(atsMatchLabel(f));
    const b = bucketIndex.get ? bucketIndex.get(bk) : bucketIndex[bk];
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
  const routed = atsRouteLabel(atsMatchLabel(f), f, profile, defaults);
  if (routed) return routed;
  // Employment-status recognizer (the "have you worked for «company» before?" class) —
  // the same deterministic tier the Workday driver runs, sentence-scoped + bail-guarded.
  // Contract (fill-driver): recognize → {tense, company} | null; decide → {fill, review,
  // detail} where fill:null = unevaluable → blank + review, NEVER a guess.
  const company = (jobContext && jobContext.company) || null;
  const er = atsFd.recognizeEmploymentQuestion(atsMatchLabel(f), company);
  if (er) {
    const dec = atsFd.decideEmploymentStatus(er.tense, company, profile, atsMatchLabel(f));
    if (dec && dec.fill) return { candidates: [dec.fill], source: "employment", review: !!dec.review, flag: dec.review ? "employer-match" : null, detail: dec.detail || "employment-status recognizer" };
    return { kind: "employment-blank", review: true, flag: "employer-match", detail: (dec && dec.detail) || "employment question unevaluable — left blank" };
  }
  return null;
}

// ── THE RÉSUMÉ ON iCIMS: ATTACHED FIRST, AND THE PARSE IS WAITED OUT (operator, 2026-08-17) ─────────
// iCIMS parses an uploaded résumé SERVER-SIDE and posts the result back into the panel, re-rendering
// entries under new ids and blanking what was already written — the form says so in its own words
// ("Existing data in the form will be replaced"). Attaching it as an ordinary field is therefore
// self-defeating, which is why it was skipped entirely from 2026-08-16.
//
// The fix is ORDER: attach BEFORE anything is filled, wait for the parse to land AND the panel to stop
// churning, and only then fill. The parse then overwrites nothing of ours, and the fill (or the approved
// replay) writes on top of whatever it produced. Everything after this point in the run is unchanged.
//
// ⚠ THE WAIT IS NOT A TIMER (CLAUDE.md: nothing proceeds on a fixed delay — every wait polls the
// condition it gates). Two independent conditions, both polled on SW wall-clock:
//   • the form's own IDENTITY changed — the postback re-renders fields under new ids and repopulates
//     values, so a scan signature is the evidence that the parse actually LANDED. A field-COUNT settle
//     cannot see this: the count is often identical on both sides of a re-render.
//   • …and then the panel goes QUIET — the mutation-stamp watch is the only probe here that can say
//     "the DOM is mid-reaction", which no count settle can (the cdpInstallQuietWatch lesson).
// A parse that changes NOTHING is indistinguishable from one that has not started yet, so the no-change
// branch does NOT proceed early — it still requires quiet + a stable signature, spends its whole
// change budget first, and says which branch it took. Being slow there costs latency; being early
// costs the whole fill.
const ATS_ICIMS_PARSE = {
  pollMs: 900,        // one read-only scan per tick (waitAtsFormReady already polls this at 450ms)
  // ⚠ RAISED from 1500 on 2026-08-18, deliberately spending ~1s of the ~6s the lean signature probe
  // saved. Polling faster makes a STABILITY predicate weaker, not stronger — sparse reads are stronger
  // evidence that nothing is moving — so with a cheap probe the binding evidence has to be the quiet
  // watch's own wall-clock idle time rather than the read count. 2500ms also covers a parse that
  // renders in two bursts with a gap between them, which 1500ms could have called finished.
  quietMs: 2500,      // no mutation for this long ⇒ the postback has finished rendering
  stableReads: 3,     // …and the signature agreed that many times (the waitAtsFormReady bar)
  // How long the postback gets to START before we accept "it changed nothing". ⚠ THIS IS THE ONE
  // NUMBER THAT CAN LET A PARSE LAND MID-FILL: past it, a quiet form is taken at face value, so a
  // postback arriving later would overwrite fields we had already written. Six live runs on Astrion
  // (2026-08-18) landed the parse at 8.4 · 9.0 · 9.4 · 10.5 · 12.9 · 17.6s — the worst case was only
  // 2.4s inside the 20000 this shipped with, which is not headroom, it is luck. 45s is ~2.5× the
  // slowest observed. It costs NOTHING in the normal case: every one of those runs saw the change and
  // exited on quiet+stable (~14s), so only a form whose parse genuinely produces nothing waits it out.
  // ⚠ CONFIRMED THE SAME DAY, NOT THEORETICAL: a later Astrion run landed its parse at **25.6s**
  // (settled 29.7s). Under the 20s budget that run would have called the form quiet, started filling,
  // and had the postback overwrite it mid-fill — the exact failure this stage exists to prevent, on the
  // tenant that had already passed six clean runs. Slow parses are a fact about the SERVER's load, not
  // about the page, so they cannot be designed away — only waited for.
  changeMs: 45000,
  ceilingMs: 120000,  // total budget: attach → parse → quiet. Generous by design (see above).
};
// The quiet watch observes the PARENT of what it is given, so this hands it the profile panel and gets
// the whole form. Absent ⇒ cdpInstallQuietWatch falls back to document.body, which inside the iCIMS
// form frame IS the form — the right answer either way.
const ATS_ICIMS_QUIET_ROOT = ".iCIMS_ProfileFormTable";

// The form's identity as one comparable string: how many fields, WHICH fields, and which of them hold
// a value. Deliberately NOT the values themselves and not the option lists — a signature that carries
// text no postback settles on (a search-filtered list, a re-quoted filename) would never stabilise, and
// the question here is only "did the form change and has it stopped changing". Pure + unit-pinned.
function atsFormSignature(scan) {
  const fields = (scan && scan.fields) || [];
  return fields.length + "|" + fields
    .map((f) => String((f && f.fieldName) || "") + ":" + (f && f.value != null && String(f.value).trim() !== "" ? "1" : "0"))
    .join(",");
}

// ── THE SETTLE HEARTBEAT MUST BE CHEAP, OR IT BECOMES THE WAIT (live 2026-08-18) ────────────────
//
// Measured on Cretex: the parse landed after 6.0s and the stage finished at 15.4s. The 8.6s in between
// was not iCIMS — it was US proving the form had gone quiet. `atsIcimsAwaitParse` was calling
// `atsInjScan` once per tick, and that is a 479-line full read: every label, every option list, every
// icims_dropdown's `<ul>` of results, the section walk, the entry ordinals, then a large JSON payload
// back over CDP for 68 fields. So a "900ms poll" actually cost ~2.9s per tick, and the three stable
// reads the gate asks for took ~8.6s instead of ~2.8s.
//
// The signature only ever needed two things per field — its NAME and whether it HOLDS a value — which
// is one flat pass over the controls, no labels, no options, no sections. It also returns the finished
// STRING rather than 68 field objects, so the payload stops mattering too.
//
// ⚠ BOTH SIDES OF THE COMPARISON MUST BE COMPUTED THE SAME WAY. A base read with the full scan and
// ticks read leanly would differ on tick one, which the loop would read as "the parse changed the
// form" — and a false `changed` lets it exit as soon as the page is briefly quiet, i.e. possibly
// BEFORE the real parse lands. That is the one failure this whole stage exists to prevent, so the
// caller no longer passes a full-scan baseline and this function reads its own.
//
// ⚠ Deliberately NOT `selectedIndex > 0` for a <select> (see the "index 0 is not unselected" rule):
// a non-empty `value` is the honest test, an opaque iCIMS id counts as a value, and a real
// placeholder row carries "" — no placeholder guessing needed for a signature.
function atsInjLeanSignature(ats) {
  try {
    const parts = [];
    for (const el of document.querySelectorAll("input, textarea, select")) {
      const type = String(el.type || "").toLowerCase();
      if (type === "hidden" || type === "submit" || type === "button" || type === "image" || type === "reset") continue;
      const nm = el.name || el.id || "";
      if (!nm) continue;
      let has = 0;
      if (type === "checkbox" || type === "radio") has = el.checked ? 1 : 0;
      else has = String(el.value == null ? "" : el.value).trim() ? 1 : 0;
      parts.push(nm + ":" + has);
    }
    return { ok: true, sig: parts.length + "|" + parts.join(","), n: parts.length };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// Wait for iCIMS' résumé parse to land and the panel to go quiet. Returns what it OBSERVED — never
// throws, because a wait that cannot read the page must not abort a run that can still fill it.
async function atsIcimsAwaitParse(act, ats, opts) {
  const o = opts || {};
  const cfg = Object.assign({}, ATS_ICIMS_PARSE, o.parse || {});
  const log = o.log || (() => {});
  const t0 = Date.now();
  const deadline = t0 + cfg.ceilingMs;
  let readMs = 0, reads = 0;
  const readSig = async () => {
    const t = Date.now();
    try {
      const r = await act.eval(atsInjLeanSignature, ats);
      return r && r.ok ? r.sig : null;
    } catch (e) { return null; }
    finally { readMs += Date.now() - t; reads++; }
  };
  // ⚠ Reads its OWN baseline — see atsInjLeanSignature's note on why a mixed comparison is unsafe.
  // `o.baseSignature` remains honoured so a test can pin a starting point.
  const base = o.baseSignature != null ? o.baseSignature : await readSig();
  let prev = base, stable = 0, changed = false, changedAt = null, idle = 0;
  while (Date.now() < deadline) {
    if (act.wakePage) { try { await act.wakePage(); } catch (e) { /* a hidden tab still reads */ } }
    await act.delayFull(cfg.pollMs);
    const sig = await readSig();
    if (sig == null) { stable = 0; continue; } // a read we could not make is not a stable read
    if (base != null && sig !== base && !changed) { changed = true; changedAt = Date.now() - t0; }
    stable = sig === prev ? stable + 1 : 0;
    prev = sig;
    // QUIET: a missing watch means the postback replaced the world it lived in — i.e. something just
    // happened — so re-arm and treat this tick as busy rather than as evidence of calm.
    idle = 0;
    if (act.quietRead) {
      let q = null;
      try { q = await act.quietRead(ATS_ICIMS_QUIET_ROOT); } catch (e) { q = null; }
      if (q && q.ok) idle = q.idleMs || 0;
      else if (act.quietInstall) { try { await act.quietInstall(ATS_ICIMS_QUIET_ROOT); } catch (e) { /* best effort */ } }
    } else {
      idle = cfg.quietMs; // no quiescence probe (a test act, a substrate without it) ⇒ signature only
    }
    const settled = stable >= cfg.stableReads && idle >= cfg.quietMs;
    if (settled && (changed || Date.now() - t0 >= cfg.changeMs)) {
      const waitedMs = Date.now() - t0;
      // The breakdown matters more than the total: "the parse landed at X, then WE spent Y proving it
      // had stopped" is what separates the server's time from our own, and reading the total as the
      // server's is how an 8.6s probe cost went unnoticed for a day.
      const probing = changedAt != null ? waitedMs - changedAt : waitedMs;
      const cost = ` [${reads} signature read(s) costing ${readMs}ms; ${(probing / 1000).toFixed(1)}s of this wait was OURS, proving quiet]`;
      log((changed
        ? `the résumé parse landed after ${(changedAt / 1000).toFixed(1)}s and the form settled at ${waitedMs > 0 ? (waitedMs / 1000).toFixed(1) : "0.0"}s — filling now, on top of whatever it wrote`
        : `no postback changed this form within ${(waitedMs / 1000).toFixed(1)}s — the parse either produced nothing or had already landed before we looked; the form is quiet, filling now`) + cost);
      return { parsed: true, changed, changedAt, waitedMs, quietMs: idle, signature: prev, baseSignature: base };
    }
  }
  const waitedMs = Date.now() - t0;
  // ⚠ SAY WHAT WE SAW. A parse still churning at the ceiling is the one case where filling can be
  // overwritten, so the caller flags the résumé for review rather than reporting a clean attach.
  log(`⚠ the form was STILL changing ${(waitedMs / 1000).toFixed(1)}s after the résumé attach (changed=${changed}, quiet ${idle}ms, ${stable} stable read(s)) — filling anyway, but the parse may overwrite fields; check the résumé section in review`);
  return { parsed: false, changed, changedAt, waitedMs, quietMs: idle, signature: prev, baseSignature: base, reason: "still-changing" };
}

// Attach the résumé BEFORE the fill and wait its parse out. Returns an `attachResume`-shaped outcome
// ({ok, name, verified, detail} | {ok:false, error}) plus what the wait observed, so the fill loop can
// record it as the résumé field's own result without attaching anything itself.
async function atsIcimsResumeStage(act, ats, opts) {
  const o = opts || {};
  const log = o.log || (() => {});
  let scan = o.scan || null;
  if (!scan) { try { scan = await act.eval(atsInjScan, ats); } catch (e) { scan = null; } }
  const fields = (scan && scan.fields) || [];
  // ⚠ WHICH FILE FIELD IS THE RÉSUMÉ IS THE ROUTER'S ANSWER, NOT A LABEL GUESS — the same rule the
  // replay learned on a Greenhouse cover-letter dropzone (attaching to every file field files the
  // wrong document to the employer, and no gate downstream catches it).
  const f = fields.find((x) => {
    if (!x || x.widgetType !== "file_upload") return false;
    const r = atsRouteField(ats, x, {}, {}, {}, null, null);
    return !!(r && r.kind === "resume");
  });
  if (!f) {
    log("no résumé field on this form — nothing to attach before the fill");
    return { ran: false, ok: false, error: "no résumé field on this form", reason: "no-field" };
  }
  // ALREADY CARRIES A FILE ⇒ DO NOT ATTACH A SECOND ONE. A second upload is a second parse, and that
  // one lands DURING the fill — exactly the failure this whole stage exists to avoid.
  if (f.value) {
    log(`the form already carries ${JSON.stringify(String(f.value))} — not attaching again (a second upload is a second parse)`);
    return { ran: false, ok: true, already: true, name: String(f.value), verified: true,
      detail: "the form already carried this file when the run arrived — not re-attached (a second upload would re-parse and blank the fill)" };
  }
  const ref = { inputSel: f.inputSel, widgetType: f.widgetType };
  // Arm the quiescence watch BEFORE the upload, so the stamp exists while the parse is rendering.
  if (act.quietInstall) { try { await act.quietInstall(ATS_ICIMS_QUIET_ROOT); } catch (e) { /* signature-only then */ } }
  log(`attaching the résumé FIRST (${f.fieldName}${f.isRequired ? ", required" : ""}) — its parse rewrites this form, so nothing is filled until the parse is done`);
  const att = await act.attachResume(ref);
  if (!att || !att.ok) {
    // A required résumé we could not attach is a review item, not a silent gap — the fill loop turns
    // this into needs_review + `resume-attach-failed` from the same shape the other ATSs use.
    log(`⚠ the résumé did NOT attach: ${(att && att.error) || "unknown"} — the form is untouched, so the fill proceeds without it`);
    return Object.assign({ ran: true, ok: false, error: "unknown" }, att || {}, { fieldName: f.fieldName, isRequired: !!f.isRequired });
  }
  // BASELINE AFTER THE CONFIRMATION, not before the attach: our own upload changes the résumé row, and
  // a baseline taken before it would count that as "the parse landed". If the postback beat the
  // confirmation, the no-change branch of the wait covers it (quiet + stable, then proceed).
  // ⚠ NO baseSignature FROM HERE. It used to pass one derived from a full atsInjScan, which the wait
  // then compared against its own lean reads — two different vocabularies, so tick one always looked
  // like a change. A false "changed" is the dangerous direction: it lets the wait finish on the first
  // brief quiet, potentially before the parse has even started. The wait reads its own baseline now.
  const parse = await atsIcimsAwaitParse(act, ats, { log, parse: o.parse });
  // WHAT EVIDENCE DO WE ACTUALLY HAVE THAT THE FILE LANDED? Setting `input.files` proves nothing on
  // its own — it is a page-side write, and iCIMS uploads on the change event. Two independent kinds of
  // positive evidence, and the record is flagged for review when there is NEITHER:
  //   • the widget CONFIRMED it (attachResume read the filename back), or
  //   • the server REACTED — a postback re-rendered this form, which only an accepted upload does.
  // A required résumé reported `filled` on no evidence is the false-verify class CLAUDE.md exists to
  // prevent, and on this form it would be reported at the one moment it cannot be undone.
  const flag = !parse.parsed ? "resume-parse-unsettled"
    : (att.verified || parse.changed) ? null
      : "resume-unconfirmed";
  const bits = [att.detail || null,
    parse.parsed
      ? (parse.changed ? `the form's own parse re-rendered it ${(parse.changedAt / 1000).toFixed(1)}s later and settled before the fill started` : "no parse postback changed the form")
      : "the form was still changing when the fill started — the parse may have overwritten fields",
    flag === "resume-unconfirmed" ? "nothing confirmed the upload — no filename read back and no postback — so check the résumé section on the form" : null].filter(Boolean);
  return { ran: true, ok: true, name: att.name || null, verified: !!att.verified && parse.parsed,
    detail: "attached before the fill — " + bits.join("; "), parse,
    flag, fieldName: f.fieldName, isRequired: !!f.isRequired };
}

// Add entries to each repeating section until it can hold every profile row it maps to.
// Bounded twice over: never more than the profile has, and never more than ATS_ENTRY_MAX clicks —
// a section whose Add button does not actually mount anything must cost a few seconds, not a loop.
const ATS_ENTRY_MAX = 8;
// ⚠ `wantBySection` OVERRIDES the profile count, and the SUBMIT run cannot work without it. A submit
// run replays an APPROVED BUNDLE and deliberately passes `profile: {}` — every value comes from the
// bundle, never the profile — so counting profile rows here yields 0 and the form keeps the ONE entry
// it renders by default. Live 2026-08-17 that produced 28 of a rehearsal's 32 verify failures: every
// field of work-history entries 2 and 3 reported "approved value has NO matching field on the live
// form", because those entries had never been added. A multi-entry history could not be replayed at
// all. The bundle knows how many entries it holds, so the caller counts them and says so.
async function atsGrowIcimsEntries(act, ats, scan, profile, wantBySection) {
  let current = scan;
  for (const [section, def] of Object.entries(ATS_ICIMS_ENTRY_MAPS)) {
    if (!def.addButton) continue;
    const asked = wantBySection && typeof wantBySection[section] === "number" ? wantBySection[section] : null;
    const want = asked != null ? asked
      : (Array.isArray((profile || {})[def.source]) ? profile[def.source].length : 0);
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
    try { console.log(`[ApplyPilot][ATS-FILL] ${section}: ${asked != null ? "the approved bundle holds" : "profile has"} ${want} entr(ies), form now shows ${have}`); } catch (e) { /* log only */ }
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
  // Grown on BOTH paths now: a fill sizes the sections from the profile, a submit run from the counts
  // the caller derived from the approved bundle (see atsGrowIcimsEntries — it used to be skipped
  // whenever `valueFor` was present, which is exactly the submit run).
  if (ats === "icims") scan = await atsGrowIcimsEntries(act, ats, scan, profile, o.entryCounts);
  // ⚠ BEFORE the fill, because it is what decides whether an UNFILLED field reaches review as a real
  // picker — the operator's standing rule. Read-only, and it enriches the scan so every downstream
  // atsAttachOptions call works unchanged.
  if (ats === "oracle") await atsCaptureOrcOptions(act, scan, (...a) => console.log("[ApplyPilot]", ...a));
  // ORACLE'S ADDRESS IS ONE ANSWER. Stamp the anchor/dependent roles onto the scan so the field loop
  // does not have to re-derive them, and so a dependent is never actuated -- typing into one clears
  // the anchor that produced it (see atsOrcGeoPlan).
  if (ats === "oracle") {
    const geo = atsOrcGeoPlan((scan && scan.fields) || [], profile, o.valueFor);
    if (geo) {
      geo.anchor.geoAnchor = true;
      geo.anchor.geoAnchorValue = geo.anchorValue;
      for (const d of geo.dependents) { d.geoDependent = true; d.geoAnchorName = geo.anchor.label || geo.anchor.fieldName; }
      console.log(`[ApplyPilot][ATS-GEO] address anchored on ${geo.anchor.fieldName}=${JSON.stringify(geo.anchorValue)}`
        + `${geo.exact ? "" : " (NOT exact -- " + geo.detail + ")"}; ${geo.dependents.length} dependent(s) will be VERIFIED, not typed into: `
        + geo.dependents.map((d) => d.fieldName).join(", "));
    }
  }
  // RECON THE LISTS BEFORE FILLING — including the OPTIONAL ones (operator, 2026-08-16). On these
  // one-page forms a field we never fill still has to be ANSWERABLE in review, and that means a
  // real picker, not a picker-shaped text box. The scan already carries every list, so the work is
  // not fetching them: it is deciding which ones are COMPLETE, because a list flagged partial is
  // rendered as free text. See atsIcimsPageCap — the form's own dropdowns reveal its page size, and
  // a list shorter than a page has reached its end. Zero extra page contact, so this costs nothing.
  if (ats === "icims") {
    const idd = ((scan && scan.fields) || []).filter((f) => f.widgetType === "icims_dropdown");
    const lens = idd.map((f) => (f.options || []).length);
    const cap = atsIcimsPageCap(lens);
    const maxLen = lens.length ? Math.max.apply(null, lens) : 0;
    let proven = 0;
    for (const f of idd) {
      if (f.optionsPartial === true && atsIcimsListComplete((f.options || []).length, cap, maxLen)) {
        f.optionsPartial = false;
        proven++;
      }
    }
    if (idd.length) console.log(`[ApplyPilot][ATS-OPTIONS] iCIMS page cap ${cap == null ? "NOT proven" : cap} — ${proven}/${idd.length} dropdown list(s) proven COMPLETE (these reach review as real pickers), ${idd.length - proven} stay partial`);
  }
  // WHAT DID THE SCAN ALREADY SEE? Printed BEFORE anything actuates, because that is the only
  // moment the answer is uncontaminated: once a dropdown has been opened its result list stays
  // populated, so a probe of a finished run reports full coverage no matter what the fresh page
  // served. This line is what tells "the scan carries the list, attaching it is free" apart from
  // "the list is only there after we open it" — and those want opposite implementations.
  try {
    const per = {};
    for (const f of (scan && scan.fields) || []) {
      if (!ATS_CHOICE_WIDGETS.includes(f.widgetType)) continue;
      const k = f.widgetType;
      per[k] = per[k] || { total: 0, withOpts: 0, partial: 0 };
      per[k].total++;
      if ((f.options || []).length) per[k].withOpts++;
      if (f.optionsPartial === true) per[k].partial++;
    }
    const parts = Object.entries(per).map(([k, v]) => `${k} ${v.withOpts}/${v.total}${v.partial ? ` (${v.partial} partial)` : ""}`);
    if (parts.length) console.log(`[ApplyPilot][ATS-OPTIONS] scan-time coverage — ${parts.join(" · ")}`);
  } catch (e) { /* diagnostic only */ }
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

  // DID EVERY CHOICE FIELD ACTUALLY REACH REVIEW AS A PICKER? The scan-time line above says what we
  // KNEW; this says what the operator will SEE, which is the thing that was asked for and the only
  // one worth measuring. A record with `options` renders a picker; one holding `captured_options`
  // was flagged partial and renders a type-it-yourself box instead. They diverge for a real reason —
  // a field filled through a SEARCH records only the filtered rows it matched against — so keeping
  // both numbers visible is what stops "16 proven complete" being mistaken for "16 pickers".
  try {
    // ⚠ REVIEW-side names. A result's widgetType is already rewritten by ATS_REVIEW_WIDGET, so
    // matching the scan vocabulary here counted almost nothing (measured: 19 of 46 choice fields).
    const ch = results.filter((r) => r && (ATS_CHOICE_REVIEW_WIDGETS.includes(r.widgetType) || (r.captured_options || []).length));
    const picker = ch.filter((r) => Array.isArray(r.options) && r.options.length).length;
    const freeText = ch.filter((r) => !(Array.isArray(r.options) && r.options.length) && (r.captured_options || []).length).length;
    const bare = ch.length - picker - freeText;
    if (ch.length) console.log(`[ApplyPilot][ATS-OPTIONS] review editors — ${picker} picker · ${freeText} filter-or-type (list unproven) · ${bare} with no options at all, of ${ch.length} choice record(s)`);
  } catch (e) { /* diagnostic only */ }
  // ⚠ `profile` and `jobContext` are handed on because the ORC entry pass runs inside the finish
  // stage — see the entry block there for why that ORDERING is the right one (after the audit and
  // the pre-filled sweep, before the counts). It threw `profile is not defined` on a live run when
  // the pass was written against driveAtsPageFill's scope while sitting in atsFinishFill's; the
  // completeness guard around it kept the flat fields and reported the failure, which is the only
  // reason a whole step's employment history was not silently missing again.
  // ⚠ `replay` is threaded EXPLICITLY rather than read off a variable that happens to be in scope.
  // atsFinishFill does not receive `o`, and the entry pass inside it already cost one live run by
  // being written against driveAtsPageFill's scope — `profile is not defined`, thrown into a silent
  // catch. `o.valueFor` is this file's established "this is a replay" signal (see the match opts).
  return await atsFinishFill(act, ats, scan, results, o.credentials, profile, jobContext, !!o.valueFor, o.valueFor);
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
  if (ATS_CHOICE_WIDGETS.includes(wt)) return "choice";
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
// ── CAPTURE ORC PICKER OPTIONS SO REVIEW DRAWS A REAL PICKER (2026-08-19) ────────────────
// Enriches the SCAN in place rather than the records, which is the whole trick: every downstream
// `atsAttachOptions(rec, f.options)` call site then works unchanged, and a captured list reaches
// review by exactly the same path a natively-enumerated one does.
//
// Why a separate pass at all: ORC's listbox does not exist until its widget is opened, so options
// cannot be read inline the way Greenhouse's or Lever's can. This is read-only page contact — it
// opens with NO query, reads, and closes with Escape (the only close that works — see
// atsInjOrcCaptureOptions).
//
// ⚠ COST IS BOUNDED BY POLICY, NOT BY A CAP: `atsOrcCaptureEligible` refuses geo pickers (dependent
// and unbounded) and anything already enumerated, so this opens only fixed-vocabulary lists. On the
// observed step 1 that is 2 fields, not 7.
// ⚠ NO SILENT CAPS: whatever it skips or fails to read is logged, because a field that quietly
// reaches review as a text box is indistinguishable from one the form never offered options for.
async function atsCaptureOrcOptions(act, scan, LOG) {
  const log = LOG || (() => {});
  const fields = (scan && scan.fields) || [];
  const eligible = fields.filter(atsOrcCaptureEligible);
  const skipped = fields.filter((f) => f.widgetType === "select" && !atsOrcCaptureEligible(f));
  if (!eligible.length) {
    if (skipped.length) log(`[ATS-OPTIONS] ORC: 0 capturable, ${skipped.length} picker(s) left as type-it-yourself (${skipped.map((f) => f.fieldName).join(", ")})`);
    return { captured: 0, skipped: skipped.length };
  }
  let captured = 0, failed = 0;
  for (const f of eligible) {
    let r = null;
    try { r = await act.eval(atsInjOrcCaptureOptions, f.inputSel, ATS_ORC_PICK_MS); } catch (e) { r = null; }
    if (r && r.ok && r.count) {
      // Complete by construction: an empty open returns ORC's WHOLE vocabulary (measured — country
      // 251 rows, dial 247, title 17; there is no pager to defeat us the way iCIMS' 25 did).
      f.options = r.options;
      captured++;
      if (r.closed === false) log(`[ATS-OPTIONS] ⚠ ${f.fieldName}: list did NOT close after Escape — a lingering list is the standing hazard`);
    } else {
      failed++;
      log(`[ATS-OPTIONS] ⚠ ${f.fieldName}: no options captured${r && r.terminalNo ? " (the widget said \"No results\")" : ""} — it will reach review as a text box`);
    }
  }
  log(`[ATS-OPTIONS] ORC scan-time capture — ${captured} complete list(s), ${failed} unreadable, ${skipped.length} skipped as search-driven`);
  return { captured, failed, skipped: skipped.length };
}

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
      // ⚠ CARRY THE SECTION THROUGH. The scan reads it (`sectionOf` — the nearest preceding heading)
      // and the bundle has a slot for it, but nothing joined the two, so every iCIMS field arrived
      // with `section_heading: null` and the review page filed all 108 of them under "Other fields".
      // That is why "Supervisor's Name" and "Employer Phone Number" read as context-free questions:
      // they are Experience fields that lost the only thing saying so (operator, 2026-08-17).
      section_heading: f.section != null ? f.section : null,
      section_known: f.section != null ? true : null,
      // One question rendered as several controls — see the scan's questionRowOf. Carried so the
      // review page can show ONE row per question with its parts inside, instead of three peers
      // whose labels ("Month", "Year") say nothing about which date they belong to.
      question_key: f.questionKey != null ? f.questionKey : null,
      question_label_full: f.questionLabel != null ? f.questionLabel : null,
      part_label: f.partLabel != null ? f.partLabel : null,
      // ⚠ WHICH REPEATING ENTRY THIS FIELD BELONGS TO. atsAssignEntryIndexes already works this out
      // from the id's ordinal, but nothing carried it, so a per-customer Experience field (Start Date,
      // Supervisor's Name, Employer Phone Number — all `rcf<NNNN>`, so no profile path either) had
      // nothing placing it in a job. Review therefore listed all 27 of them AFTER the three entry
      // blocks instead of inside them, which is what the operator saw (2026-08-17).
      // ⚠ EMITTED AS THE SECTION KEY, because that is what `canonical_field` is built from
      // ("experience[0].company", not "work_experience[0].company"). A first cut sent the profile
      // ARRAY name instead and the two disagreed, so Experience split into `experience[i]` (the mapped
      // fields) and `work_experience[i]` (these) — two groups per job. Education hid the bug, because
      // its section key and its profile array happen to share a name.
      entry_section: f.entrySection != null ? f.entrySection : null,
      entry_index: typeof f.entryIndex === "number" ? f.entryIndex : null,
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
      // A GEO DEPENDENT IS NEVER ACTUATED, ON EITHER PATH. Oracle fills city/state/county from the
      // postal code, and typing into one of them CLEARS the anchor that produced it -- so this is
      // placed above the replay branch deliberately: an approved bundle carrying "Tallahassee" must
      // not cause it to be typed back in on the submit run either.
      // Left claiming NOTHING on purpose: atsSurfacePrefilled then re-reads the live page and, when
      // the cascade did fill it, promotes the record to filled_review + `already-filled` with the
      // real value. That is the existing, tested path for "the form holds something we did not type",
      // and reusing it beats a parallel verify of my own.
      if (f.geoDependent) {
        rec.status = "skipped";
        rec.detail = "Oracle fills this from " + (f.geoAnchorName || "the postal code")
          + " -- left for the cascade, because typing here would clear that anchor";
        results.push(fin()); continue;
      }
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
        // ⚠⚠ A REHEARSAL READS BEFORE IT WRITES (operator, 2026-08-21): "the rehearsal run should not
        // refill if it is correct. you can get all the information by looking at the page."
        //
        // The replay used to re-actuate every approved field unconditionally. That is a lot of
        // avoidable page contact on a form that is already right, and every write is a chance to
        // disturb something that was fine — a stray commit landing in a neighbouring widget is a
        // failure mode this codebase has paid for more than once (the Workday lingering-listbox
        // rule). The scan ALREADY carries each field's live value, so the check is free: no extra
        // read, no extra round-trip.
        //
        // Equal ⇒ record it verified and move on. Different ⇒ fall through and actuate exactly as
        // before, which is the operator's other half: "if something is filled wrong, change it."
        //
        // ⚠ THE COMPARISON IS DELIBERATELY CONSERVATIVE. A format difference between what the scan
        // reads and what the fill recorded (a date read "5/2026" but stored "May 2026") simply falls
        // through and re-writes the same value — costly, never wrong. The asymmetry matters: a false
        // "already correct" would skip a field that needed fixing and report it verified, so anything
        // uncertain must actuate.
        // ⚠ FILE FIELDS ARE EXEMPT — see the résumé note below. Their "value" is a filename, which
        // says nothing about which bytes are on the server.
        if (f.widgetType !== "file_upload") {
          const liveRaw = f.value;
          const live = liveRaw == null ? "" : (typeof liveRaw === "boolean" ? (liveRaw ? "true" : "") : String(liveRaw));
          if (live && atsLib.normalize(live) === atsLib.normalize(String(v))) {
            rec.after = live;
            rec.verified = true;
            rec.status = "filled";
            rec.tier = "already-correct";
            // `resolved` marks this as a field we HAD a value for, which is what keeps
            // atsSurfacePrefilled from re-reading it and re-reporting it as pre-populated.
            rec.resolved = [String(v)];
            rec.detail = "the form already holds the value you approved — checked, not rewritten";
            results.push(fin()); continue;
          }
        }
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
      // A PERMISSION THE OPERATOR HAS NOT GIVEN — claimed by the entry resolver precisely so that the
      // AI cannot reach it (see the may_contact branch). Blank + flagged, exactly like an unstated
      // clearance: the answer belongs to a human, and a required one blocking the gate is the point.
      if (route && route.kind === "entry-permission-unstated") {
        rec.status = "needs_review";
        rec.flag = route.flag || "may-contact-unstated";
        rec.mappedPath = route.path || null;
        rec.detail = route.detail;
        results.push(fin()); continue;
      }
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
        // ⚠ ON iCIMS THE ATTACH ALREADY HAPPENED, BEFORE THIS LOOP EVER RAN (atsIcimsResumeStage).
        // Its parse REPLACES the form's contents, so attaching here would blank every field written
        // above this one — and on a submit run it would blank approved values on their way to a real
        // submission. So the outcome is RECORDED and the file input is never touched: the pre-attach
        // is the only attach, and its absence is reported rather than quietly repaired here.
        const pre = o.resumePreattached || null;
        const att = pre || (ats === "icims" ? null : await act.attachResume(ref));
        if (!att) {
          rec.status = f.isRequired ? "needs_review" : "skipped";
          rec.flag = "resume-not-attached";
          rec.detail = "no résumé stage ran for this page — on iCIMS the résumé is attached BEFORE the fill (its parse rewrites the form), never during it";
          results.push(fin()); continue;
        }
        Object.assign(rec, att.ok
          ? { status: att.flag ? "filled_review" : "filled", after: att.name || "resume attached", detail: att.detail || null, verified: !!att.verified, flag: att.flag || null }
          : { status: f.isRequired ? "needs_review" : "skipped", detail: "resume attach failed: " + (att.error || "unknown"), flag: "resume-attach-failed" });
        results.push(fin()); continue;
      }
      if (route && (route.kind === "skip" || route.skip)) { rec.status = "skipped"; rec.detail = route.detail || "deliberately left to the operator"; results.push(fin()); continue; }
      if (route && route.kind === "employment-blank") { rec.status = "needs_review"; rec.flag = route.flag || "employer-match"; rec.detail = route.detail; results.push(fin()); continue; }
      // A clearance question we cannot answer from a STATED clearance stops here, blank and flagged —
      // it must not fall through to the AI, which would answer it by reasoning from absence. Claiming
      // the question is what keeps that from happening; see the clearance rung in atsRouteLabel.
      if (route && route.kind === "clearance-unstated") { rec.status = "needs_review"; rec.flag = route.flag || "clearance-unstated"; rec.detail = route.detail; results.push(fin()); continue; }
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
          const isChoice = ATS_CHOICE_WIDGETS.includes(f.widgetType);
          const rr = atsFd.resolve(route.raw, isChoice ? "dropdown" : "text");
          if (rr.skip) { /* falls through to AI/blank */ }
          else if (rr.candidates) candidates = rr.candidates;
          else if (rr.value !== undefined) { textValue = String(rr.value); candidates = [String(rr.value)]; }
        } else if (route.value != null) {
          textValue = String(route.value);
          // ⚠ A MULTI-ANSWER WIDGET'S APPROVED VALUE IS A SET, AND ARRIVES JOINED. `current_value` for a
          // checkbox group / native multi-select is the display string ("Internship; Part-time"), so a
          // replay that passes it through as ONE candidate asks the form for an option by that whole
          // name — live 2026-08-17 the rehearsal reported `your profile answer ("Internship; Part-time")
          // isn't one of this form's options`. Split it back into the set it represents, using the same
          // shared vocabulary the fill joined it with (GROUP_JOIN), so the multi-select handler matches
          // each answer against the live options exactly as it does on a fill.
          candidates = (f.widgetType === "multiselect_native" || f.widgetType === "checkbox_group")
            ? atsLib.splitGroupValue(route.value)
            : [String(route.value)];
        }
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
      // ⚠ EVERY CHOICE FIELD REACHES REVIEW WITH ITS OPTIONS, filled or not (operator, 2026-08-16).
      // A field we did not fill still has to be ANSWERABLE on the review page, and a picker with no
      // options is just a text box — the operator ends up retyping a value the form was showing us
      // all along. The scan already read these (native selects, radios, checkbox groups, and the
      // first page of an iCIMS dropdown), so attaching them costs NOTHING: no reopening, no page
      // contact, no added latency. Only the widget families whose list has no end — the big
      // server-backed typeaheads — are left alone, and they are left alone by construction here,
      // because the scan does not carry options for them either.
      // Attached only when the record has none: a field that DID actuate already recorded the live
      // list it matched against, which is the better of the two.
      if (!rec.options && !rec.captured_options && Array.isArray(f.options) && f.options.length) {
        atsAttachOptions(rec, f.options, f.optionsPartial === true);
      } else if (rec.captured_options && !rec.options && Array.isArray(f.options)
                 && f.optionsPartial !== true && f.options.length >= (rec.captured_options || []).length) {
        // …AND A COMPLETE LIST BEATS A FILTERED ONE. The rule above — "a field that actuated already
        // recorded the live list it matched against, which is the better of the two" — holds only
        // while the actuation list is FULLER. It is not: a field filled through the widget's SEARCH
        // records just the rows that search returned, so the record lands partial (a filter-or-type
        // box) even when the scan's own list for that field is proven COMPLETE. Measured on the
        // Astrion form: 18 of 46 choice records were filter-or-type, and most were dropdowns the
        // fill had answered by searching.
        // Both guards are load-bearing: the scan list must be PROVEN complete (never a first page
        // standing in for a longer list), and it must not be SHORTER than what the actuation saw —
        // otherwise a stale scan could narrow a list the widget had already shown us in full.
        atsAttachOptions(rec, f.options);
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
// ── WHAT THE FORM ALREADY HELD, AND WE DID NOT PUT THERE (operator, 2026-08-18) ─────────────────────
// iCIMS parses the résumé and pre-populates whatever it thinks the answers are — and the operator's
// verdict on that parse is blunt: "the auto parse is really bad… pretend the form is blank and refill
// everything". Two halves to that, and only the first was true:
//
//   • A field we CAN answer is already overwritten. atsInjSetText assigns the whole value, and the choice
//     paths commit regardless of what sits there, so nothing skips merely because the parse got there
//     first. That half needed no change.
//   • A field we CANNOT answer kept the parse's guess AND WENT UNRECORDED. Its record said `skipped` with
//     `after: null`, so the review editor rendered it BLANK while the form carried the parse's value —
//     invisible to the human, and submitted. On the Cretex form that was 45 of 81 fields' worth of blind
//     spot. This is the gap the operator was describing.
//
// So: re-read every field we did not fill and, when the page holds something, put it ON the record and
// flag it. Same convention the Workday walk has used for pre-filled fields (`already-filled` →
// needs_review), and for the same reason — the review bundle is supposed to be the page's source of
// truth, and a blank record about a populated field is simply false.
//
// ⚠ IT REPORTS, IT DOES NOT BLANK. Clearing a value we cannot vouch for is a different and riskier act:
// on a REQUIRED field it trades a wrong answer for a blocked submit, and some of what the parse extracts
// is correct. Surfacing puts the decision where it belongs — in review, next to the value, with an
// editor. Blanking is a one-line change if the operator wants it.
// ⚠ RUNS AFTER THE AUDIT, deliberately: the audit compares `rec.after` against the page for fields WE
// filled, and these are not those. Promoting them beforehand would audit the parse's work as if it were
// ours and report `audit-mismatch` on values nobody claimed.
// ⚠⚠ IS THIS VALUE SOMETHING THE PROFILE ACTUALLY SAYS? (operator, 2026-08-20)
// Oracle fills City / State / County from the postal code and the fill never types into them (typing
// clears the anchor), so they arrived in review as "PRE-POPULATED — double-check this field" on every
// run while being correct every time. Agreement with the profile is verification, not coincidence:
// the value came from an anchor the profile itself supplied.
//
// ⚠ NO LABEL PATTERNS, NO PER-FIELD MAPPING — the operator's instruction, and the first version of
// this got it wrong: it matched the label against /city|state|county|postal/ and looked each one up
// under a named profile key. That is a list that has to be extended for every tenant's wording and
// every locale's idea of a region, and it silently answers "no opinion" the moment a label is worded
// unexpectedly. Instead: build the set of strings the profile's address ACTUALLY contains, and ask
// whether the live value is one of them. A field whose value the profile does not contain is not
// verifiable, whatever it happens to be called.
//
// ⚠ AND "NOT IN THE PROFILE" MEANS REVIEW — also the operator's instruction, and a correction to my
// first version, which cleared the County because Oracle had derived it from a verified anchor. That
// reasoning is not wrong, but it is REASONING, and the operator's rule is the safer one: the profile
// is the authority on what the operator has actually told us, and a value it does not contain is
// something a human should look at once. There is no third state here — verified, or reviewed.
//
// The only normalization is FORM: "FL" and "Florida" are the same answer, so each profile value
// contributes its own spelling AND its abbreviation/expansion. That is data shape, not a per-field
// rule, and it is what lets the State field verify at all.
function atsProfileAddressValues(profile) {
  const pi = (profile && profile.personal_info) || {};
  const out = new Set();
  const add = (v) => {
    const n = atsLib.normalize(String(v == null ? "" : v));
    if (!n) return;
    out.add(n);
    // both directions through the region table, so a stored "Florida" also accepts "FL" and a stored
    // "FL" also accepts "Florida"
    const ab = atsLib.REGION_ABBREV || {};
    if (ab[n]) out.add(atsLib.normalize(ab[n]));
    const full = Object.keys(ab).find((k) => atsLib.normalize(ab[k]) === n);
    if (full) out.add(atsLib.normalize(full));
  };
  // every address-ish value the profile holds, whatever the form chooses to call its fields
  for (const k of ["city", "state_province", "postal_code", "country", "address_line_1", "address_line_2"]) add(pi[k]);
  for (const loc of (Array.isArray(profile && profile.locations) ? profile.locations : [])) {
    if (typeof loc === "string") { for (const part of loc.split(",")) add(part); }
    else if (loc) { add(loc.city); add(loc.state); add(loc.state_province); add(loc.country); }
  }
  return out;
}

// TRUE when the profile contains this value, FALSE when it does not. Deliberately two-valued: a value
// the profile does not contain is a review item, not an "unknown" to be reasoned about.
function atsGeoValueInProfile(liveValue, profile) {
  const live = atsLib.normalize(String(liveValue == null ? "" : liveValue));
  if (!live) return false;
  return atsProfileAddressValues(profile).has(live);
}

async function atsSurfacePrefilled(act, ats, scan, results, profile, valueFor) {
  const fields = (scan && scan.fields) || [];
  let surfaced = 0, geoAgreed = 0, geoUnverified = 0;
  for (const rec of results) {
    if (!rec || rec.credential) continue;
    // Only records that claim NOTHING: a skip, or a review item we could not give a value to.
    const claimsNothing = (rec.status === "skipped" || rec.status === "needs_review")
      && (rec.after == null || String(rec.after).trim() === "");
    if (!claimsNothing) continue;
    // ⚠ ONLY FIELDS WE NEVER HAD A VALUE FOR. `resolved` is set before any actuation, so a record that
    // carries one is a field we TRIED to fill — and if it ended without a value, that is a COMMIT FAILURE
    // whose record must survive intact. Re-labelling it `already-filled` would both misattribute the
    // value (we put it there, or tried to) and quietly convert a failed commit into a satisfied-looking
    // review item — the false-verify class this codebase exists to refuse. Caught by the existing
    // "a commit the widget does not display is NOT reported filled" test, which is precisely its job.
    if (rec.resolved != null) continue;
    const f = fields.find((x) => x.fieldName === rec.fieldName);
    if (!f || f.widgetType === "file_upload") continue;
    let live = null;
    try { live = await act.eval(atsInjReadValue, ats, f.inputSel, f.widgetType); } catch (e) { live = null; }
    // A read we could not make says nothing — leave the record exactly as the fill left it.
    if (!live || !live.ok) continue;
    // ⚠⚠ AN UNCHECKED CHECKBOX HOLDS NO VALUE — `false` IS NOT CONTENT (operator, 2026-08-20).
    // atsInjReadValue answers a checkbox with a BOOLEAN, and `String(false)` is `"false"`, a
    // perfectly non-empty string. So every unchecked box on every platform read as "the form already
    // has something here" and was surfaced as PRE-POPULATED — "not filled by ApplyPilot; verify it's
    // what you want" — on a box we had DELIBERATELY left alone because the profile says No.
    // Live: ORC's optional "I am Hispanic or Latino." reached review displaying "Unchecked".
    //
    // Leaving an optional box unticked is an ANSWER, and a correct one; the standing rule is that a
    // known, profile-defined empty is not a review item. This is one line, and it applies to
    // Greenhouse, Lever, Ashby and iCIMS as much as Oracle.
    if (live.value === false) continue;
    const v = live.value == null ? "" : String(live.value).trim();
    if (!v || v === "false") continue;

    // ⚠ TWO STATES ONLY: either the profile CONTAINS this value (verified — the cascade was driven
    // by an anchor the profile itself supplied) or it does not (a review item). No label patterns and
    // no reasoning about derived values; see atsGeoValueInProfile.
    if (f.geoDependent) {
      rec.after = v;
      rec.verified = true;
      // ⚠⚠ ON A REPLAY THE AUTHORITY IS THE APPROVED BUNDLE, NOT THE PROFILE (live rehearsal,
      // 2026-08-20). A submit run passes `profile: {}` by design — every value comes from the
      // bundle — so atsGeoValueInProfile could only ever answer NO, and City / State / County were
      // all flagged `geo-not-in-profile` and BLOCKED THE GATE on a form holding exactly the values
      // the human had already approved. The profile test is right on a FILL, where the profile is
      // what we know; on a replay the human's approval is strictly better evidence, and it is the
      // thing the rest of this run is verifying against anyway.
      const approvedHere = typeof valueFor === "function" ? valueFor(f) : undefined;
      if (approvedHere !== undefined) {
        const agrees = atsLib.normalize(String(approvedHere)) === atsLib.normalize(v);
        rec.status = agrees ? "filled" : "needs_review";
        rec.flag = agrees ? null : "geo-not-approved";
        rec.detail = agrees
          ? "Oracle filled this from " + (f.geoAnchorName || "the postal code")
            + ", and it matches the value you approved — verified"
          : "Oracle filled this from " + (f.geoAnchorName || "the postal code") + " as " + JSON.stringify(v)
            + ", but you approved " + JSON.stringify(String(approvedHere)) + " — check it here";
        if (agrees) geoAgreed++; else { geoUnverified++; surfaced++; }
        continue;
      }
      if (atsGeoValueInProfile(v, profile)) {
        rec.status = "filled";
        rec.flag = null;
        rec.detail = "Oracle filled this from " + (f.geoAnchorName || "the postal code")
          + ", and your profile contains this value — verified, nothing to check";
        geoAgreed++;
      } else {
        rec.status = "needs_review";
        rec.flag = "geo-not-in-profile";
        rec.detail = "Oracle filled this from " + (f.geoAnchorName || "the postal code")
          + " as " + JSON.stringify(v) + ", and your profile does not contain that value — check it here";
        geoUnverified++; surfaced++;
      }
      continue;
    }


    rec.status = "filled_review";
    rec.flag = "already-filled";
    rec.after = v;
    rec.verified = true;                 // it IS on the page — that is the whole point of the record
    rec.detail = (rec.detail ? rec.detail + " · " : "")
      + "this was ALREADY on the form and we did not put it there"
      + (ats === "icims" ? " — iCIMS pre-fills fields from the résumé it parsed, and that parse is not trustworthy" : "")
      + ". Your profile had no answer to overwrite it with, so check it or replace it here.";
    surfaced++;
  }
  if (geoAgreed || geoUnverified) {
    try { console.log(`[ApplyPilot][ATS-FILL] geo cascade: ${geoAgreed} value(s) your profile CONTAINS (not flagged)`
      + `${geoUnverified ? `, ${geoUnverified} it does NOT (flagged for review)` : ""}`); } catch (e) { /* log only */ }
  }

  if (surfaced) {
    try { console.log(`[ApplyPilot][ATS-FILL] ${surfaced} field(s) the form had ALREADY populated are now IN review with their live value — previously they were recorded blank and would have been submitted unseen`); } catch (e) { /* log only */ }
  }
  return surfaced;
}

async function atsFinishFill(act, ats, scan, results, credentials, profile, jobContext, replay, valueFor) {
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

  // …and the pre-filled sweep for the same reason: it promotes `skipped` records to `filled_review`, so
  // running it after the tally left the envelope reporting 45 skips for a page that had 26 (measured on
  // Cretex — the BUNDLE was right and the summary was not, which is the kind of disagreement that gets
  // read as a bug in whichever half you look at second). Placed after the audit deliberately: see
  // atsSurfacePrefilled.
  try { await atsSurfacePrefilled(act, ats, scan, results, profile, valueFor); } catch (e) { /* completeness — never abort */ }

  // ⚠ THE REPEATING ENTRIES, AND THEY MUST RUN AFTER THE FLAT LOOP. Every ORC step is scanned for
  // flat fields; a repeating block contributes NOTHING to that scan until an Add is pressed, because
  // ORC builds Experience / Education entries on demand. So the flat pass finishing is exactly the
  // moment to build them — before it, the fields do not exist; after the counts, the envelope would
  // under-report (the same ordering mistake atsSurfacePrefilled documents two comments above).
  //
  // ⚠ AND ITS RECORDS JOIN `results`, so they reach the review bundle like any other field. An entry
  // filled but absent from review is worse than one left blank: nobody would know to check it.
  // ⚠ REPORT WHAT WE DID NOT SEE, BEFORE the entry pass builds anything — otherwise the entry forms
  // it creates would themselves read as "unclaimed controls" and drown the signal.
  let unclaimedNotes = [];
  if (ats === "oracle") {
    try {
      const claimed = [];
      for (const r of results) { if (r.fieldName) claimed.push(r.fieldName); }
      // The scan's own identity keys: `fieldName` (the durable `name`) plus every id inside its
      // `inputSel`, since a composite (a date's three spinbuttons) claims several controls at once.
      for (const f of (scan.fields || [])) {
        if (f.fieldName) claimed.push(f.fieldName);
        for (const m of String(f.inputSel || "").matchAll(/#([\w-]+)/g)) claimed.push(m[1]);
      }
      const u = await act.eval(atsInjOrcUnclaimed, claimed).catch(() => null);
      const ariaOnly = (u && u.aria) || [];
      if (ariaOnly.length) {
        console.log(`[ApplyPilot][ORC-UNCLAIMED] ⚠⚠ ${ariaOnly.length} ARIA-ONLY control(s) — a JET widget family with NO handler in this file, so they were never even scanned:`);
        for (const a of ariaOnly) {
          const line = `${a.required ? "REQUIRED " : ""}<${a.tag}> role=${a.role} ${JSON.stringify(a.question || a.id || "")}` +
            `${a.options.length ? " options=" + JSON.stringify(a.options) : ""}${a.block ? " block=" + JSON.stringify(a.block) : ""}`;
          unclaimedNotes.push(line);
          console.log("[ApplyPilot][ORC-UNCLAIMED]   • " + line);
        }
      }
      const miss = (u && u.unclaimed) || [];
      if (miss.length) {
        for (const m of miss) {
          unclaimedNotes.push(`${m.required ? "REQUIRED " : ""}${m.grouped ? m.type + " group" : m.tag + "/" + m.type} ${JSON.stringify(m.question || m.key)}` +
            ` [name=${m.name} row=${m.rowClass || "none"}${m.block ? " block=" + JSON.stringify(m.block) : ""}${m.options.length ? " options=" + JSON.stringify(m.options) : ""}]`);
        }
        console.log(`[ApplyPilot][ORC-UNCLAIMED] ⚠ ${miss.length} control(s) on this step were NOT scanned and so were never filled:`);
        for (const n of unclaimedNotes) console.log("[ApplyPilot][ORC-UNCLAIMED]   • " + n);
      }
    } catch (e) {
      // ⚠ A SILENT COMPLETENESS CATCH HIDES A BUG FOREVER, and the pair of blocks here proved it in
      // one run: the entry pass beside this one threw `profile is not defined` (written against a
      // different function's scope) and its catch SAID SO, which is the only reason it was found
      // immediately. This catch swallowed everything, so an identical failure here would have left
      // "no unclaimed controls" — indistinguishable from a clean step, on the very diagnostic built
      // because a clean-looking step was hiding three required fields.
      // Still never fatal: a diagnostic must not break a fill. It just has to admit it failed.
      unclaimedNotes.push("the unclaimed-control check failed: " + String((e && e.message) || e));
      console.log("[ApplyPilot][ORC-UNCLAIMED] ⛔ the check itself failed, so this step's coverage is UNKNOWN:", String((e && e.message) || e));
    }
  }

  let entryNotes = [];
  if (ats === "oracle") {
    // LINKS FIRST: it only ever ADDS rows, so doing it before the entry pass keeps its new inputs out
    // of anything the entry pass reads.
    try {
      const lp = await atsOrcFillLinks(act, profile, { log: (m) => console.log("[ApplyPilot][ORC-LINK]", m),
        recorded: results.map((r) => r && r.fieldName).filter(Boolean) });
      if (lp && lp.records && lp.records.length) results.push(...lp.records);
      if (lp && lp.notes && lp.notes.length) entryNotes = entryNotes.concat(lp.notes);
    } catch (e) {
      entryNotes.push("the links pass failed: " + String((e && e.message) || e));
      console.log("[ApplyPilot][ORC-LINK] ⛔ the links pass threw:", String((e && e.message) || e));
    }
    try {
      const ep = await atsOrcFillEntries(act, profile, jobContext, { log: (m) => console.log("[ApplyPilot][ORC-ENTRY]", m), reportOnly: !!replay, valueFor });
      if (ep && ep.records && ep.records.length) results.push(...ep.records);
      // ⚠ CONCAT, never assign: the LINKS pass above writes into the same list, and an assignment
      // here silently discarded its notes — the one channel that reports a link we could not add.
      entryNotes = entryNotes.concat((ep && ep.notes) || []);
    } catch (e) {
      // Completeness over abort, like the sweep above: a broken entry pass must not lose the flat
      // fields this page already filled. It IS reported, because a silently skipped employment
      // history reads as a step that had nothing on it.
      entryNotes = ["the repeating-entry pass failed: " + String((e && e.message) || e)];
      console.log("[ApplyPilot][ORC-ENTRY] ⛔ the entry pass threw — flat fields are kept:", String((e && e.message) || e));
    }
  }

  const counts = results.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
  // DID THIS PAGE'S ASYNC WIDGETS EVER ANSWER? Greenhouse forms sometimes load in a state where their
  // server-backed comboboxes (school / degree / discipline / location) never return anything — the
  // operator's own workaround is to refresh the page, and by hand the same widget then answers in ~1s
  // (2026-08-06). We could not tell that state apart from a slow one, so a fill would sit through the
  // full budget on each such field and hand them all to review. This flag lets the RUN decide to
  // reload once and try again, which is the same remedy a human applies.
  const deadAsync = results.filter((r) => r.listUnproven || /never answered our search|suggestions never loaded/i.test(String(r.detail || "")));
  return { url: scan.url, title: scan.title, results, counts, entryNotes, unclaimedNotes,
    deadAsync: deadAsync.map((r) => r.fieldName),
    needsReview: results.filter((r) => r.status === "needs_review" || r.status === "filled_review") };
}

// ⚠⚠ PRESS A YES/NO AND CONFIRM IT STUCK — ONE implementation for all THREE call sites.
// Live 2026-08-20, hidden run: the two DETERMINISTIC yes/no questions both reported
// `took 2 press(es) — the first did not register` and landed, while the AI-answered one came back
// `needs_review` from the same page seconds later. The difference was not the widget and not the
// answer: the deterministic path had the deadline-and-re-press logic and the AI path still did one
// click plus a short read. A commit that only works on one of three paths is a coin flip about which
// rung happened to answer the question.
//
// The rules, all of them earned the hard way today:
//   • A DEADLINE, NOT AN ITERATION COUNT. An iteration count is a proxy for time and every proxy
//     breaks when the clock beneath it changes — this bit three times in one day (a fixed 150ms read;
//     10 iterations on the ADAPTIVE pace, which collapsed 1.5s into 196ms; 24 iterations that only
//     passed because the STARVED worker clock made each one ~500ms, then went blank once page-clock
//     pacing made the paces honest).
//   • RE-PRESS a press that did not register, GATED on nothing being pressed yet — on a toggle a
//     blind second press would un-press what the first one set.
//   • Report the PRESS COUNT, so a widget that habitually needs two is visible rather than merely
//     slow.
// ⚠⚠ A WALL-CLOCK BUDGET CAN BE EATEN WHOLE BY ONE STARVED PACE (live 2026-08-20).
// This reported `yes/no click not reflected after 2 press(es) over 8s (read null)` on Oracle's
// ex-Oracle-employee question, and the field was billed 34.7s. It was read as a widget bug and it
// was not one: the same question filled first time on the next clean run. What actually happened is
// that the service worker was starved — measured elsewhere that run, a 120ms pace took 10883ms — so
// `delayFull(120)` inside this loop consumed the ENTIRE 8s budget before a single read cycle
// completed. The loop then concluded "not reflected" having gathered no evidence at all.
//
// ⚠ THIS IS NOT THE ATTEMPTS FLOOR THE STANDING RULE FORBIDS. That rule ("a wait that timed out
// wants a bigger BUDGET; never add an attempts floor") is about COVERAGE of a monotone predicate,
// where sparse sampling can only notice late and never miss. The distinction drawn here is the one
// orcAdvanceAfterStep already draws on its own advance wait — "NOT ONE read landed, so this is
// blindness rather than evidence the page stood still". A budget that expired before the loop could
// look even once has measured nothing, and reporting that as a failed commit is a false negative on
// a field that was very likely fine.
//
// So the budget is spent in WALL CLOCK as before, and only extended when it ran out having completed
// fewer than MIN_CYCLES read cycles — bounded by a hard ceiling so a genuinely dead widget still
// ends. The detail then says WHICH of the two happened, so this never has to be diagnosed twice.
async function atsCommitYesNo(act, ats, ref, want, wt) {
  const kind = wt || "yesno";
  let r = await act.eval(atsInjClickYesNo, ref.inputSel, want);
  const t0 = Date.now();
  const BUDGET_MS = 8000, HARD_CEILING_MS = 30000, MIN_CYCLES = 3;
  let deadline = t0 + BUDGET_MS;
  let back = null, presses = 1, cycles = 0, starved = false;
  while (Date.now() < deadline) {
    await act.delayFull(120);
    cycles++;
    back = await act.eval(atsInjReadValue, ats, ref.inputSel, kind);
    if (back && back.ok && atsLib.normalize(String(back.value || "")) === atsLib.normalize(want)) break;
    const nothingPressed = !(back && back.ok && String(back.value || "").trim());
    if (nothingPressed && presses < 3 && Date.now() - t0 > presses * 1800) {
      presses++;
      r = await act.eval(atsInjClickYesNo, ref.inputSel, want);
    }
    // Out of budget, but we have barely looked — the clock was starved, not the widget.
    if (Date.now() >= deadline && cycles < MIN_CYCLES && Date.now() - t0 < HARD_CEILING_MS) {
      starved = true;
      deadline = Math.min(t0 + HARD_CEILING_MS, Date.now() + BUDGET_MS);
    }
  }
  const value = back && back.ok ? back.value : null;
  const ok = !!(r && r.ok) && atsLib.normalize(String(value || "")) === atsLib.normalize(want);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  return { ok, value, presses, cycles, starved, elapsedMs: Date.now() - t0,
    detail: ok
      ? (presses > 1 ? "took " + presses + " press(es) — the first did not register" : null)
      : "yes/no click not reflected after " + presses + " press(es) over " + secs + "s"
        + " (read " + JSON.stringify(value) + ", " + cycles + " read cycle(s)"
        + (starved ? " — the budget was EXTENDED because the service worker's clock was starved" : "") + ")" };
}

// ⚠⚠ IS THIS TIER DETERMINISTIC — i.e. does it commit `filled` rather than `filled_review`?
// Both choice-commit paths used to hardcode `tier === "exact-normalized" || tier === "label-exact"`,
// which is a list that cannot learn. Live 2026-08-20: the disability self-ID matched at
// **polarity-lead** — the tier that exists precisely so a stored "No" can land "No, I do not have a
// disability and have not had one in the past" DETERMINISTICALLY — and the hardcoded pair graded it
// `filled_review` anyway. The operator asked the right question: "it filled deterministically, why
// is that for review."
//
// ⚠ IT IS ADDITIVE, NOT A SWAP. `flagTierCategory` is fill-driver's shared grader and it returns
// `exact` for exact-normalized and polarity-lead — but `none` for **label-exact**, which is an
// ATS-LOCAL tier it has never heard of. Replacing the pair outright would therefore have demoted
// every label-exact commit from filled to filled_review: a silent regression on Greenhouse, Lever
// and Ashby, in the name of fixing Oracle. So the ATS-local tier stays named here and the shared
// grader is consulted for everything else, which means a future tier it calls exact is picked up for
// free while nothing already working changes.
function atsTierIsDeterministic(tier) {
  if (tier === "exact-normalized" || tier === "label-exact") return true;
  try { return atsFd.flagTierCategory(tier) === "exact"; } catch (e) { return false; }
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
    let listArrived = opts.length > 0;
    // ⚠ THE LIST IS FETCHED ON OPEN (`icimsdropdown-ajax="1"`), SO THE FIRST READ IS A RACE — WAIT FOR IT
    // (operator, 2026-08-18: "sometimes when you run it it shows no results… maybe it is the same reason"
    // as the non-iCIMS form, i.e. what the run does to the page). Measured: this widget's list is present
    // and complete under a run when read late, so an empty read is a not-yet-arrived list rather than a
    // broken one — a RACE, not a hard break. Two things make us lose it more often than a human does:
    // hidden runs pace fast (cdpSetFastWhenHidden), and we read immediately after a synthetic open.
    // ASK THE PAGE, NEVER A CLOCK: poll on SW wall-clock (delayFull, so a hidden run does not shorten the
    // one wait that matters) until rows appear, and remember whether they ever did — a list that never
    // arrived must be reported as exactly that, and never as "your answer is not offered", which is a
    // claim about the employer's vocabulary that an empty read cannot support.
    if (!listArrived) {
      for (let i = 0; i < 20; i++) {
        await act.delayFull(300);
        const r = await act.eval(atsInjIcimsReadOptions, ref.inputSel).catch(() => null);
        if (r && r.ok && r.awaitingParent) break;          // a different, self-explaining state
        if (r && r.ok && (r.options || []).length) { opts = r.options; listArrived = true; break; }
      }
    }
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
    // ⚠ THE DEGREE BRIDGE BELONGS HERE TOO. A tenant's degree list is written in ABBREVIATIONS
    // ("AS · BS · MS · PhD · MBA · BA" — Cretex, measured), and the profile stores "Bachelor of Science",
    // which meets none of them on any string tier. The generic choice path has bridged this since the
    // dial/degree work; this widget's path never did, so the option sitting in plain sight was
    // unreachable and the field went to review — the miss that then triggered the destructive search
    // below. Same helper, same label gate, so the two paths cannot disagree.
    if ((!m || m.targetIndex < 0) && /degree|education level/i.test(String(f.label || ""))) {
      const deg = atsDegreeMatch(candidates, opts);
      // ⚠ `matchTier`, not `tier` — this path's grading reads matchTier (the other path converts it into
      // its own `hit.tier`), and the mismatched key surfaced as `matched at the undefined tier`.
      // Graded EXACT on purpose: an acronym is not a similarity score. "Bachelor of Science" abbreviates
      // to "BS" and to nothing else, and uniqueness is already enforced — so this is the same kind of
      // fact an exact-normalized hit is, and flagging it would ask the operator to re-check arithmetic.
      if (deg) m = { targetIndex: opts.indexOf(deg), matchTier: "exact-normalized", degreeBridge: true };
    }
    // ⚠ ONE PAGE AT A TIME (26 countries / 25 states measured live). A miss here is NOT proof the
    // option doesn't exist, so the search box is tried before anything is reported — otherwise a
    // candidate in Texas fails on a list that stops at Michigan.
    // ⚠⚠ BUT ONLY IF THE WIDGET CAN ACTUALLY BE SEARCHED. `icimsdropdown-search="0"` means the list is
    // LOCAL and complete; the search box in its markup only FILTERS the rendered rows, so typing into it
    // DELETES the very options we are looking for and the field then reports an empty list. That is what
    // happened to Cretex's Degree — 9 options, reported empty, twice, until the operator said the
    // dropdown plainly works on their screen. A miss on a search-less widget is a REAL miss: report it
    // with the options it actually offers.
    if ((!m || m.targetIndex < 0) && f.searchable === false) {
      await act.eval(atsInjIcimsClose, ref.inputSel).catch(() => null);
      atsAttachOptions(rec, opts, false);
      rec.status = "needs_review";
      // ⚠ TWO DIFFERENT FACTS, AND ONLY ONE OF THEM IS ABOUT THE EMPLOYER. A list that never arrived says
      // nothing about what the form offers — claiming otherwise is the mistake this whole round started
      // with — so it is reported as OUR failed read, with the flag naming it.
      if (!listArrived) {
        rec.flag = "list-never-loaded";
        rec.detail = "this dropdown's list never loaded for us — it fetches on open and stayed empty for the whole wait, so we could not see what it offers (it is not searchable, so there was nothing else to try). It is populated when opened by hand, so this is our read, not the employer's form.";
      } else {
        rec.detail = "no option matched " + JSON.stringify(String(candidates[0])) +
          " — this list cannot be searched, so what it shows is all it offers: " + opts.slice(0, 8).join(" | ");
      }
      return true;
    }
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
    // Partial ONLY when the widget can be searched: then one page is a VIEW of the list and review
    // should get a type-to-filter editor rather than a 25-row list presented as every US state. A
    // search-less widget (`icimsdropdown-search="0"`) has no second page, so what it renders IS the
    // vocabulary and review gets a real picker.
    atsAttachOptions(rec, opts, f.searchable !== false);

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
          // ⚠ DO NOT CLAIM THE TENANT'S LIST IS EMPTY. An earlier round of this shipped a message saying
          // exactly that — "the employer's form offers no options" — on the strength of a probe that
          // read the list while OUR OWN leftover search text was still filtering it. The operator's
          // screen refuted it: nine options, no search box. A list that reads empty AFTER we searched is
          // evidence about our search, not about the employer, so the wording stays on our side of the
          // line and names the query we used.
          : "no option matched " + JSON.stringify(String(candidates[0])) + (searched ? " (after searching)" : "") +
              (opts.length ? " — offered: " + opts.slice(0, 4).join(" | ") : " — the list came back empty for this search");
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
    // ⚠ CARRY THE ARRAY, don't re-split a string. A multi-select reaches review as a checkbox GROUP,
    // whose contract is `selected_options` = the authoritative array + `current_value` = the joined
    // display. Setting only the joined string left the editor splitting on the wrong separator and
    // rendering the question BLANK on a form that held both answers (live 2026-08-17).
    const chosen = (back && back.ok && Array.isArray(back.values)) ? back.values
      : (r && Array.isArray(r.selected) ? r.selected : []);
    rec.selected_options = chosen;
    rec.after = chosen.length ? atsLib.joinGroupValue(chosen) : null;
    const got = chosen.map((x) => atsLib.normalize(x));
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
  // ── ORACLE'S PICKERS TAKE THEIR OWN PATH (2026-08-19) ──────────────────────────────────
  // Placed AHEAD of the generic select branch because none of that branch's primitives work here:
  // its option read queries `[role=option]` (ORC uses `div[role=row]` in a `div[role=grid]`), and its
  // commit is a plain click (ORC needs a full pointer sequence). Every clause is measured — the full
  // six-part recipe lives on atsInjOrcPick.
  //
  // The candidates still clear the SAME match ladder against the LIVE rows, and the commit is still
  // read-back verified — this changes HOW a value is committed, never WHETHER it had to be matched.
  if (ats === "oracle" && (wt === "select" || wt === "dial")) {
    if (!candidates || !candidates.length) return false;
    rec.resolved = candidates;
    // ⚠ THE ROWS ARE THE ONLY VOCABULARY THAT COUNTS, and it is per-field: `country` wants the full
    // name, `region2` (State) the TWO-LETTER code, `region1` (County) "County, ST", `city`
    // "City, County, ST", and the dial picker "+1 (United States)". So each candidate is offered as
    // its own query and matched against what comes back, rather than assuming one shape.
    // ⚠ THE DIAL PICKER SPEAKS "+<code> (<Country>)" AND NO PROFILE VALUE WILL EVER EQUAL THAT.
    // Live: candidates ["United States of America (+1)", …, "+1"] against rows
    // ["+1 (American Samoa)", "+1 (Anguilla)", …] matched nothing, and a REQUIRED field reached
    // review for no reason. atsDialMatch already solves this — it strips the code and the parens and
    // requires the CODE and the NAME to agree, which is order-agnostic — so route the dial picker
    // through it and pick by the row it returns rather than by string equality.
    const isDial = (mopts && mopts.dial) || f.fieldName === "phoneNumber"
      || /country\s*code/i.test(String(f.label || ""));
    if (isDial) {
      const opened = await act.eval(atsInjOrcCaptureOptions, ref.inputSel, ATS_ORC_PICK_MS);
      const rows = (opened && opened.options) || [];
      const hit = rows.length ? atsDialMatch(candidates, rows) : null;
      if (hit) {
        const want = rows[hit.index];
        const r = await act.eval(atsInjOrcPick, ref.inputSel, want, [want], ATS_ORC_PICK_MS, false);
        if (r && r.ok) {
          let back = null;
          for (let i = 0; i < ATS_ORC_READBACK_MS.length; i++) {
            await act.delayFull(ATS_ORC_READBACK_MS[i]);
            back = await act.eval(atsInjOrcReadPicker, ref.inputSel);
            if (back && back.ok && String(back.value || "").trim()) break;
          }
          // ⚠⚠ RECORD THE OPTION THAT WAS CHOSEN, NOT THE PICKER'S READ-BACK (live rehearsal,
          // 2026-08-20). The widget DISPLAYS the compact code ("+1") while its option reads
          // "+1 (United States)", and `rec.after` becomes the bundle's `current_value` — which is
          // what the submit run replays. So a fill that had recorded the read-back handed the replay
          // the candidate "+1", and the ladder correctly REFUSED it: +1 is the United States AND
          // Canada, so a bare code is genuinely ambiguous and matching it would be a guess between
          // two real countries. The rehearsal caught it as `no dial-code option agreed with ["+1"]`.
          //
          // The fix is not to loosen the ladder — the ambiguity is real — but to store a value that
          // reproduces the decision. The read-back stays the VERIFICATION (it is what proves the
          // commit landed on the page); the recorded value is the option. Safe because
          // atsSurfacePrefilled skips any record carrying `resolved`, so no audit re-reads this
          // field and compares the two.
          const shown = back && back.ok ? back.value : null;
          rec.resolved = candidates;
          if (String(shown || "").trim() && !(back && back.invalid)) {
            rec.after = want;
            rec.status = "filled";
            rec.tier = hit.tier;
            rec.detail = "dial code matched on code+name → " + JSON.stringify(want)
              + " (the picker displays it as " + JSON.stringify(shown) + ")";
            return true;
          }
          rec.after = shown;
        }
      }
      rec.status = f.isRequired ? "needs_review" : "skipped";
      rec.flag = "no-option-match";
      rec.resolved = candidates;
      rec.detail = "no dial-code option agreed with " + JSON.stringify((candidates || []).slice(0, 3))
        + (rows.length ? "; the field offered " + JSON.stringify(rows.slice(0, 4)) : " (no options read)");
      return true;
    }
    let last = null;
    for (const cand of candidates) {
      const q = String(cand == null ? "" : cand).trim();
      if (!q) continue;
      // ⚠ ALWAYS CLEAR FIRST (operator, 2026-08-19). `noClear` was passed here for geo pickers on the
      // grounds that clearing one cascades to its siblings — true, but it solved a problem my own
      // earlier approach created, back when all five geo fields were actuated in sequence. Now only
      // the ANCHOR is actuated and its cascade repopulates the rest, so the sibling clear is exactly
      // what we want.
      //
      // Leaving it OFF was actively harmful and a live run showed it: the fields already held values,
      // so the query was APPENDED to them — `country` held "United States", typing
      // "United States of America" produced a nonsense query, and the widget answered "No results"
      // on a field whose option was right there. Same for postalCode ("32312" typed onto "32312").
      // A search box must be cleared before it is searched; that is why the house rule exists.
      // ⚠ segmentMatch for a geo picker: its rows are composites keyed on the form's own comma.
      const r = await act.eval(atsInjOrcPick, ref.inputSel, q, [q], ATS_ORC_PICK_MS, false, !!f.searchDriven);
      last = r;
      if (r && r.ok) {
        // ⚠ READ-BACK IS POLLED, NOT READ ONCE: a read in the same beat as the click returns the
        // PREVIOUS value (measured — `country` read "United" straight after committing "United
        // States", and correctly a round-trip later).
        let back = null;
        for (let i = 0; i < ATS_ORC_READBACK_MS.length; i++) {
          await act.delayFull(ATS_ORC_READBACK_MS[i]);
          back = await act.eval(atsInjOrcReadPicker, ref.inputSel);
          if (back && back.ok && String(back.value || "").trim()) break;
        }
        rec.after = back && back.ok ? back.value : null;
        // ⚠ `cx-select-input--invalid` MEANS THE WIDGET IS HOLDING TEXT IT NEVER ACCEPTED. A value
        // being present is NOT proof: a prefilled `country` wore this from first load. A commit that
        // leaves it set must never be reported as filled.
        if (back && back.invalid) {
          rec.status = "needs_review";
          rec.flag = "commit-not-accepted";
          rec.detail = "Oracle shows " + JSON.stringify(rec.after) + " but still marks the field invalid — it is holding text it did not accept as a selection. Pick it here.";
          return true;
        }
        if (String(rec.after || "").trim()) {
          rec.status = "filled";
          rec.tier = "exact-normalized";
          rec.detail = "picked " + JSON.stringify(r.committed) + " from the form's own list";
          return true;
        }
      }
      if (r && r.error === "ambiguous") {
        // two rows matched — not a confident answer, and the standing rule refuses to guess.
        rec.status = "needs_review";
        rec.flag = "ambiguous-option";
        rec.detail = "more than one Oracle option matched " + JSON.stringify(q) +
          (r.rows ? "; the form offered " + JSON.stringify(r.rows.slice(0, 6)) : "") + " — choose here";
        return true;
      }
    }
    rec.status = f.isRequired ? "needs_review" : "skipped";
    rec.flag = rec.flag || "no-option-match";
    rec.detail = "none of " + JSON.stringify((candidates || []).slice(0, 4)) + " matched Oracle's list" +
      (last && last.rows && last.rows.length ? "; it offered " + JSON.stringify(last.rows.slice(0, 6)) : "") +
      // ⚠ ATTRIBUTE THE CAUSE ONLY WHERE IT CAN APPLY. This said "a dependent geo picker whose parent
      // is not committed does this" on EVERY no-results field, so a live run printed that explanation
      // for `title` — a salutation list in the name block, with no parent and no cascade. A confident
      // wrong diagnosis is worse than none: the standing lesson is that a misattributed message sends
      // the next debugging round at the wrong subsystem (it cost one round on iCIMS' "no options" vs
      // "awaiting parent"). A non-geo field gets the plain fact instead.
      (last && last.error === "no-results"
        ? (f.searchDriven
            ? " (the field returned \"No results\" — a dependent geo picker whose parent is not committed does this)"
            : " (the field returned \"No results\" — the form's list does not contain this answer)")
        : "");
    return true;
  }

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
      rec.status = atsTierIsDeterministic(hit.tier) ? "filled" : "filled_review";
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
    // ⚠ POLL THE READ-BACK, don't sample it once after a fixed beat. `act.delay` is ADAPTIVE and
    // collapses to ~20ms when page timers measure fast, so "delay(120) then read once" could sample
    // before the widget had settled — the exact trap atsReadBackSettled exists for and which the other
    // commit paths already use. Live 2026-08-17 two iCIMS salary selects reported `native select commit
    // failed` on a rehearsal; polling is the honest read, and a genuinely blank field still reports
    // blank — it just costs the window to say so.
    const back = await atsReadBackSettled(act, ats, ref.inputSel, wt, 2000);
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
    // ⚠⚠ A "NO" TO A ONE-OPTION ASSERTION CHECKBOX IS ANSWERED BY LEAVING IT UNTICKED (operator,
    // 2026-08-20). Oracle asks the Hispanic/Latino question as a single tickable assertion — label
    // "Ethnicity", one option, "I am Hispanic or Latino." — and the profile answers it
    // "No, I am not Hispanic". No option can ever match that, because the form offers no "no" to
    // pick: the negative answer IS the absence of a tick, and the box was already in exactly the
    // right state.
    //
    // Without this the field fell through to the `stated-value-unmatched` rule, which exists for a
    // real and different failure — a stated value the form genuinely cannot express (the profile
    // says "Bachelor of Science", the form offers "Bachelor's Degree", live 2026-07-31) — and so it
    // reached review as "ApplyPilot couldn't fill this — please fill it in yourself" on a question
    // that was correctly and completely answered. That is review noise on a DEMOGRAPHIC, which is
    // the worst place for it: it invites someone to "correct" a self-ID answer that was already right.
    //
    // Three guards, each load-bearing:
    //   • CHECKBOX GROUPS ONLY — never a radio. Absence has to be an expressible answer, and in a
    //     radio group it is not: leaving a radio set untouched means unanswered, not "no".
    //   • EXACTLY ONE OPTION. A multi-option group ("Select the races you identify with") has no
    //     single assertion for a bare "no" to deny, so this must not fire there.
    //   • THE CANDIDATE'S POLARITY IS NO, word-anchored, so "November" or a value merely CONTAINING
    //     "no" cannot trigger it. A yes-polarity answer is deliberately left to the tiers above —
    //     assertion-lead already ticks it, and a yes we fail to express should still be flagged.
    // The box is READ BACK and unticked if the form arrived with it set, because "leave it alone" is
    // only the right action when it is already in the answer's state.
    if (!pick && wt === "checkbox_group" && texts.length === 1
        && atsAssertionDeclined(candidates[0], texts[0])) {
      const cur = await act.eval(atsInjReadValue, ats, ref.inputSel, wt);
      const held = cur && cur.ok ? String(cur.value == null ? "" : cur.value).trim() : "";
      if (held) {
        // it arrived TICKED — the answer is "no", so untick it and verify
        await act.eval(atsInjCheckOption, ref.inputSel, texts[0], false);
        await act.delay(150);
        const back = await act.eval(atsInjReadValue, ats, ref.inputSel, wt);
        const nowHeld = back && back.ok ? String(back.value == null ? "" : back.value).trim() : "";
        atsAttachOptions(rec, texts);
        rec.resolved = candidates;
        if (nowHeld) {
          rec.status = "needs_review";
          rec.flag = "commit-not-accepted";
          rec.detail = "your profile says no to " + JSON.stringify(texts[0]) + " but the box stayed ticked — untick it here";
          return true;
        }
        rec.after = null; rec.verified = true; rec.status = "filled"; rec.tier = "assertion-negative";
        rec.detail = "your profile answers this " + JSON.stringify(String(candidates[0]))
          + ", so " + JSON.stringify(texts[0]) + " was UNTICKED — the form expresses no by leaving it unticked";
        return true;
      }
      atsAttachOptions(rec, texts);
      rec.resolved = candidates;
      rec.after = null; rec.verified = true; rec.status = "filled"; rec.tier = "assertion-negative";
      rec.detail = "your profile answers this " + JSON.stringify(String(candidates[0]))
        + ", and this form only offers " + JSON.stringify(texts[0]) + " to tick — leaving it unticked IS that answer";
      return true;
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
    rec.status = okv ? (atsTierIsDeterministic(tier) ? "filled" : "filled_review") : "needs_review";
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
    const yn = await atsCommitYesNo(act, ats, ref, want, wt);
    rec.after = yn.value;
    rec.options = f.options || ["Yes", "No"];
    rec.status = yn.ok ? "filled" : "needs_review";
    rec.verified = yn.ok;
    if (yn.detail) rec.detail = yn.detail;
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
      else if (wt === "yesno") c = await atsCommitYesNo(act, ats, ref, dec, wt);   // …and here (see above)
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
    // ⚠ THE SAME COMMIT AS THE DETERMINISTIC RUNG. Live: the two deterministic yes/no questions both
    // needed two presses and landed, while the AI-answered one on the SAME page came back
    // needs_review from a single click plus a short read. Which rung answered a question must not
    // decide whether the answer sticks.
    else if (wt === "yesno") committed = await atsCommitYesNo(act, ats, ref, pick, wt);
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
    detectAts, atsFormUrl, atsCompanyFromUrl, atsPlausibleCompany, ATS_STATIC_MAPS, atsComposeValue, atsWebsiteValue, atsFirstWebsiteValue, atsProfileWebsites,
    atsRouteLabel, atsRouteField, atsDialStrip, atsEnumStrip, atsListIsComplete, atsAttachOptions, atsNearOptions, ATS_REVIEW_WIDGET, ATS_CHOICE_WIDGETS, ATS_CHOICE_REVIEW_WIDGETS, atsIcimsPageCap, atsIcimsListComplete, ATS_ICIMS_CAP_MIN, ATS_POLL, driveAtsPageFill, atsActuateField,
    atsCredentialKind, atsCredentialValue, atsCredentialRecheck, atsFinishFill, atsSurfacePrefilled, atsMapKey,
    atsGeoValueInProfile, atsProfileAddressValues, atsTierIsDeterministic,
    atsEntrySpec, atsAssignEntryIndexes, atsScopeForField, atsResolveEntryField, atsMayContactCandidates, atsDefaultDay, ATS_DEFAULT_DAY, atsIsFutureYearMonth, atsGrowIcimsEntries, atsMonthCandidates, ATS_ICIMS_ENTRY_MAPS, ATS_MONTHS,
    atsIcimsResumeStage, atsIcimsAwaitParse, atsFormSignature, ATS_ICIMS_PARSE, ATS_ICIMS_QUIET_ROOT,
    atsInjLeanSignature,
    atsAiFallback, atsAiChooseOption, atsAiWriteText,
    ATS_AI_BATCH_MAX, atsAiBatchKind, atsBuildBatchPrompt, atsParseBatchReply, atsBatchMaxTokens,
    atsSameOptionSet, atsOpenAndPollOptions, atsCloseComboConfirmed, atsRunAiBatch,
    ATS_REDIRECT_STRONG_RE, atsPickRedirectAnchor, atsInjDetectRedirect,
    atsInjFindApplyLinks, atsPickApplyLink, atsInjClickApplyButton,
    atsInjPortalEvidence, atsPortalAts, atsInjPageSignature, atsSignatureChanged, atsInjClickApplyAnchor,
    atsInjOrcStepState, ATS_ORC_NEXT_RE, ATS_ORC_FORBID_RE, atsInjOrcBlocks, atsOrcEntryValue, atsOrcFillEntries,
    atsInjOrcUnclaimed, atsInjOrcScrollBlocks, atsInjOrcTiles, atsInjOrcDeleteTile, atsInjOrcDialogPress,
    atsInjOrcLinks, atsInjOrcAddLink, atsOrcFillLinks, atsInjOrcPickFromOwnList,
    atsOrcEntryIdentity, atsOrcTilesAlreadyMatch, atsInjOrcOpenEntryAndWait, atsInjOrcCommitEntryAndWait,
    atsInjOrcOpenTileAndWait, atsInjOrcCloseEntry, atsInjOrcResumeReset,
    atsInjAuthScan, icimsAuthView, icimsLooksLikeSso, ICIMS_AUTH_MAX_CONTROLS,
    atsConsentKind, atsConsentPlan, atsInjTickConsent, atsDecoyKind, orcApplyView, atsInjOrcAuthScan,
    atsInjOrcClickButton, atsInjOrcFillPin, atsInjOrcPick, atsInjOrcReadPicker, atsInjOrcCaptureOptions, atsOrcCaptureEligible, atsCaptureOrcOptions, ATS_ORC_PICK_MS, atsOrcGeoPlan, ATS_ORC_GEO_ANCHOR, atsInjOrcEntryState, atsInjOrcEntryAction, atsOrcEntryPlan, ATS_ORC_ENTRY_BLOCKS, ATS_ORC_ENTRY_MAPS, ATS_ORC_ENTRY_MAX,
    ATS_CONSENT_ACCEPT_RE, ATS_CONSENT_OPTIN_RE, ATS_CONSENT_ATTEST_RE,
    atsInjClickAuthSubmit, ICIMS_MAILED_LINK_RE, icimsMailedCredential, icimsIsAdminLogin,
    atsInjFindEmbeddedForms, atsPickEmbeddedForm, atsDurableFieldName, atsSubmitKey, atsDeclineOption,
    atsIsEeoLabel,
    atsPreferredNameValue, atsLooksLikeApplicationForm, atsAssertionLead, atsAssertionDeclined, atsCommitYesNo, atsOrcDurableName,
    atsOrcTileHoldsValue, atsYearMonthKey, atsDegreeLevel, atsDegreeMatch, atsDegreeAcronym, atsDialMatch, atsDialCode, atsDialName,
    atsPlacePick, atsPostingGone, ATS_LOCATION_LABEL_RE,
    atsReadBackSettled,
    atsInjReadComboInput, atsInjScan, atsInjSetText, atsInjSetCredential, atsInjVerifyCredential, atsInjReadValue, atsInjOpenAndReadOptions, atsInjReadOptions,
    atsInjFrameFieldY, atsInjScrollTopToFrameY, atsInjIcimsFrameSrc, atsInjIcimsAddEntry, atsInjIcimsOpen, atsInjIcimsSearch, atsInjIcimsReadOptions, atsInjIcimsCommit, atsInjIcimsRead, atsInjIcimsClose,
    atsInjTypeInCombo, atsInjCommitOption, atsInjCloseCombo, atsInjCheckOption, atsInjSetChecked,
    atsInjClickYesNo, atsInjAttachFile, atsInjReadFileState, atsInjPlacesReady, atsInjScrollIntoView, atsInjSubmitState, atsInjErrors, atsInjSelectNative,
  };
}
