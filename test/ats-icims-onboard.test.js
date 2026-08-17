// iCIMS PRE-FORM stage — the pure decisions behind "portal → Apply → the email gate → the form".
//
// Everything here guards one of the stage's safety properties, and each case is written the
// direction that actually bites:
//   • the LOGIN page must never be classified as the application form (it passes
//     atsLooksLikeApplicationForm, so only the auth classifier stands between it and a fill),
//   • SSO is refused on URL EVIDENCE ONLY — never on field-absence (the Workday lesson),
//   • ambiguity refuses rather than guesses (portal detection, apply-control picking),
//   • the retry decides from the page's own identity, not from a click count.
const { test } = require("node:test");
const assert = require("node:assert");
const ats = require("../ats.js");

const isAts = ats.detectAts;

// ── portal detection: the employer's own domain ─────────────────────────────────────────

test("atsPortalAts: an iCIMS portal on the employer's domain is named by the hosts the page references", () => {
  // careers.astrion.us — traced 2026-08-16: no iframe, one Apply anchor at the tenant host.
  assert.strictEqual(ats.atsPortalAts({
    ok: true, url: "https://careers.astrion.us/jobs/24615",
    frameHosts: [], scriptHosts: [], linkHosts: [],
    applyHosts: ["astrioncareers-astrion.icims.com"], frameIds: [],
  }, isAts), "icims");
});

test("atsPortalAts: the iCIMS frame id carries it when no host reference does", () => {
  assert.strictEqual(ats.atsPortalAts({
    ok: true, frameHosts: [], scriptHosts: [], linkHosts: [], applyHosts: [],
    frameIds: ["icims_content_iframe"],
  }, isAts), "icims");
});

test("atsPortalAts: a script host names a Greenhouse-embedding careers page", () => {
  assert.strictEqual(ats.atsPortalAts({
    ok: true, frameHosts: [], applyHosts: [], linkHosts: [],
    scriptHosts: ["boards.greenhouse.io", "www.googletagmanager.com"], frameIds: [],
  }, isAts), "greenhouse");
});

test("atsPortalAts: TWO different ATSs on one page REFUSES rather than picking one", () => {
  assert.strictEqual(ats.atsPortalAts({
    ok: true, frameHosts: ["jobs.lever.co"], scriptHosts: ["boards.greenhouse.io"],
    linkHosts: [], applyHosts: [], frameIds: [],
  }, isAts), null);
});

test("atsPortalAts: an ordinary marketing page, and an unreadable probe, name nothing", () => {
  assert.strictEqual(ats.atsPortalAts({
    ok: true, frameHosts: ["www.youtube.com"], scriptHosts: ["cdn.example.com"],
    linkHosts: ["fonts.googleapis.com"], applyHosts: [], frameIds: ["yt-player"],
  }, isAts), null);
  assert.strictEqual(ats.atsPortalAts(null, isAts), null);
  assert.strictEqual(ats.atsPortalAts({ ok: false }, isAts), null);
});

test("atsPortalAts: Workday is never claimed here — it has its own pipeline", () => {
  assert.strictEqual(ats.atsPortalAts({
    ok: true, frameHosts: [], scriptHosts: [], linkHosts: [],
    applyHosts: ["acme.wd1.myworkdayjobs.com"], frameIds: [],
  }, isAts), null);
});

test("atsPortalAts: a lookalike host is not evidence (detectAts anchors, and this inherits that)", () => {
  assert.strictEqual(ats.atsPortalAts({
    ok: true, frameHosts: [], scriptHosts: ["icims.com.evil.example"], linkHosts: [],
    applyHosts: ["fakeicims.com"], frameIds: [],
  }, isAts), null);
});

// ── company plausibility: the employment recognizer's anchor ────────────────────────────

test("⚠ atsPlausibleCompany: the live employer-page scrape returned a TITLE, not a name", () => {
  // careers.astrion.us, 2026-08-16 — no ATS markup for the JD scrape to key on, so it fell back to
  // document.title. That string then anchors "have you worked for us before?", which is the one
  // question where a silently-never-matching anchor is a safety problem.
  assert.strictEqual(ats.atsPlausibleCompany("Engineering Directorate Support Intern in Mountain View, California | Astrion"), false);
  assert.strictEqual(ats.atsPlausibleCompany("Software Engineer Intern"), false);   // a role, not an employer
  assert.strictEqual(ats.atsPlausibleCompany("Staff Analyst - Remote | Acme"), false);
  assert.strictEqual(ats.atsPlausibleCompany("Data Scientist in Austin, Texas"), false);
});

test("atsPlausibleCompany: real names are KEPT — the existing ATS behaviour must not move", () => {
  for (const ok of ["Astrion", "Anthropic", "Kraken", "US Bank", "Cambium Learning",
    "Analog Devices", "Booz Allen Hamilton", "Magna International"]) {
    assert.ok(ats.atsPlausibleCompany(ok), `${ok} should be kept`);
  }
});

test("atsPlausibleCompany: nothing to judge is not plausible (the caller then uses the URL)", () => {
  assert.strictEqual(ats.atsPlausibleCompany(""), false);
  assert.strictEqual(ats.atsPlausibleCompany(null), false);
  assert.strictEqual(ats.atsPlausibleCompany("   "), false);
});

test("atsCompanyFromUrl reads the tenant out of the iCIMS subdomain — the fallback's evidence", () => {
  assert.strictEqual(ats.atsCompanyFromUrl("https://astrioncareers-astrion.icims.com/jobs/24615/login"), "Astrion");
});

// ── the auth-view classifier ────────────────────────────────────────────────────────────

// The gate as traced live: ONE visible control (`#email` / css_loginName) + `Next`, hCaptcha in
// invisible mode, all inside #icims_content_iframe.
const GATE = {
  ok: true, url: "https://astrioncareers-astrion.icims.com/jobs/24615/login",
  controlCount: 1,
  email: { sel: "#email", id: "email", name: "css_loginName", label: "Email", type: "email", prefilled: false },
  password: null, code: null,
  submit: { sel: "#enterEmailSubmitButton", id: "enterEmailSubmitButton", caption: "Next" },
  federated: [], createAccount: [], captchaChallenge: false, errors: [],
  bodyText: "Enter Your Information Email Application FAQs Software Powered by ICIMS Protected by hCaptcha",
};

test("icimsAuthView: the live email gate", () => {
  assert.strictEqual(ats.icimsAuthView(GATE), "email");
});

test("icimsAuthView: the password step", () => {
  assert.strictEqual(ats.icimsAuthView({ ...GATE, controlCount: 2,
    password: { sel: "#password", type: "password", label: "Password" } }), "password");
});

test("icimsAuthView: a mailed one-time code outranks the email box still on the page", () => {
  assert.strictEqual(ats.icimsAuthView({ ...GATE, controlCount: 2,
    code: { sel: "#otp", label: "Verification code" } }), "code");
});

test("icimsAuthView: a VISIBLE captcha challenge outranks every fillable field", () => {
  // The bot never solves one, so this must win over the step it is blocking — otherwise the run
  // types into a form it cannot submit and reports the wrong reason.
  assert.strictEqual(ats.icimsAuthView({ ...GATE, captchaChallenge: true }), "captcha");
  assert.strictEqual(ats.icimsAuthView({ ...GATE, controlCount: 2,
    password: { sel: "#password" }, captchaChallenge: true }), "captcha");
});

test("icimsAuthView: federated-only / register-only walls are `blocked`, not `none`", () => {
  assert.strictEqual(ats.icimsAuthView({ ...GATE, controlCount: 0, email: null, submit: null,
    federated: ["Sign in with Google"] }), "blocked");
  assert.strictEqual(ats.icimsAuthView({ ...GATE, controlCount: 0, email: null, submit: null,
    createAccount: ["Create an account"] }), "blocked");
});

test("⚠ THE APPLICATION FORM IS NEVER AN AUTH VIEW — including its own 'Create a login' block", () => {
  // iCIMS puts Login / Password / Password_Confirm INSIDE the application form (the account is
  // created by the submission). A password box is therefore NOT evidence of a sign-in page, and
  // classifying the form as one would send the pre-form stage typing credentials and pressing
  // submit on a real application.
  const form = { ...GATE, controlCount: 118,
    email: { sel: "#PersonProfileFields_EmailAddress" },
    password: { sel: "#PersonProfileFields_Password" } };
  assert.strictEqual(ats.icimsAuthView(form), "none");
});

test("icimsAuthView: the control bound is the separator, and it is stated once", () => {
  const atBound = { ...GATE, controlCount: ats.ICIMS_AUTH_MAX_CONTROLS };
  const overBound = { ...GATE, controlCount: ats.ICIMS_AUTH_MAX_CONTROLS + 1 };
  assert.strictEqual(ats.icimsAuthView(atBound), "email");
  assert.strictEqual(ats.icimsAuthView(overBound), "none");
});

test("icimsAuthView: an unreadable scan says so — it never reads as 'not an auth page'", () => {
  assert.strictEqual(ats.icimsAuthView(null), "unreadable");
  assert.strictEqual(ats.icimsAuthView({ ok: false, error: "no context" }), "unreadable");
});

test("icimsAuthView: a plain job page with nothing on it is `none`", () => {
  assert.strictEqual(ats.icimsAuthView({ ok: true, controlCount: 0, email: null, password: null,
    code: null, submit: null, federated: [], createAccount: [], captchaChallenge: false }), "none");
});

// ── SSO refusal: URL evidence ONLY ──────────────────────────────────────────────────────

test("icimsLooksLikeSso: a real federated hop LEAVES the portal host", () => {
  const host = "astrioncareers-astrion.icims.com";
  assert.strictEqual(ats.icimsLooksLikeSso("https://acme.okta.com/app/x/sso/saml", host), true);
  assert.strictEqual(ats.icimsLooksLikeSso("https://login.microsoftonline.com/common/oauth2/authorize", host), true);
  assert.strictEqual(ats.icimsLooksLikeSso("https://accounts.google.com/o/oauth2/auth", host), true);
  assert.strictEqual(ats.icimsLooksLikeSso("https://idp.example.com/saml2/login", host), true);
});

test("⚠ icimsLooksLikeSso: STILL ON THE PORTAL is never SSO, whatever the path says", () => {
  // The Workday lesson, carried over: a still-rendering auth widget is indistinguishable from a
  // provider redirect by field-absence, and that mistake produced a flat-wrong `sso` halt on an
  // ordinary sign-in page. Only leaving the host counts.
  const host = "astrioncareers-astrion.icims.com";
  assert.strictEqual(ats.icimsLooksLikeSso("https://astrioncareers-astrion.icims.com/jobs/24615/login", host), false);
  assert.strictEqual(ats.icimsLooksLikeSso("https://astrioncareers-astrion.icims.com/sso/whatever", host), false);
  assert.strictEqual(ats.icimsLooksLikeSso("https://careers.astrion.us/jobs/24615", "careers.astrion.us"), false);
});

test("icimsLooksLikeSso: garbage and an ordinary off-portal page are not SSO", () => {
  assert.strictEqual(ats.icimsLooksLikeSso("not a url", "x.icims.com"), false);
  assert.strictEqual(ats.icimsLooksLikeSso("", "x.icims.com"), false);
  assert.strictEqual(ats.icimsLooksLikeSso("https://www.astrion.us/about", "x.icims.com"), false);
});

test("⚠ icimsIsAdminLogin: the RECRUITER login is an icims.com host we must never type into", () => {
  // login.icims.com is iCIMS' Auth0 universal login for STAFF, and it renders an email box — so the
  // auth classifier would call it `email` and offer the candidate's address to it. The SSO test
  // cannot catch it, because that one deliberately exempts icims.com hosts.
  assert.ok(ats.icimsIsAdminLogin("https://login.icims.com/u/login/identifier?state=abc"));
  assert.strictEqual(ats.detectAts("https://login.icims.com/u/login/identifier"), "icims"); // why SSO misses it
  assert.strictEqual(ats.icimsIsAdminLogin("https://astrioncareers-astrion.icims.com/jobs/24615/login"), false);
  assert.strictEqual(ats.icimsIsAdminLogin("https://careers.astrion.us/jobs/24615"), false);
  assert.strictEqual(ats.icimsIsAdminLogin("login.icims.com.evil.example"), false);
  assert.strictEqual(ats.icimsIsAdminLogin(null), false);
});

// ── "iCIMS mailed you the next step" ────────────────────────────────────────────────────

test("icimsMailedCredential: recognises the send CLAIM, not the word 'email'", () => {
  assert.ok(ats.icimsMailedCredential("We've sent a link to your email address."));
  assert.ok(ats.icimsMailedCredential("An email has been sent. Check your inbox to continue."));
  assert.ok(ats.icimsMailedCredential("We emailed you a one-time code"));
  // The gate itself renders the label "Email" and must NOT match — it has a box to fill.
  assert.strictEqual(ats.icimsMailedCredential("Enter Your Information Email Next"), false);
  assert.strictEqual(ats.icimsMailedCredential(""), false);
  assert.strictEqual(ats.icimsMailedCredential(null), false);
});

// ── the page signature behind the flaky-Apply retry ─────────────────────────────────────

const SIG = { url: "https://careers.astrion.us/jobs/24615", frameSrc: null, heading: "Engineering Directorate Support Intern", controls: 0, ids: "" };

test("atsSignatureChanged: each half of the identity is load-bearing", () => {
  assert.strictEqual(ats.atsSignatureChanged(SIG, { ...SIG }), false);
  assert.ok(ats.atsSignatureChanged(SIG, { ...SIG, url: "https://astrioncareers-astrion.icims.com/jobs/24615/login" }));
  // A postback keeps the URL and swaps the frame — the case a url-only test misses entirely.
  assert.ok(ats.atsSignatureChanged(SIG, { ...SIG, frameSrc: "https://x.icims.com/jobs/24615/login" }));
  assert.ok(ats.atsSignatureChanged(SIG, { ...SIG, heading: "Enter Your Information" }));
  assert.ok(ats.atsSignatureChanged(SIG, { ...SIG, controls: 1 }));
  assert.ok(ats.atsSignatureChanged(SIG, { ...SIG, ids: "email|enterEmailSubmitButton" }));
});

test("⚠ atsSignatureChanged: an UNREADABLE side is 'no change', never progress", () => {
  // The conservative direction on purpose: a failed read must leave the caller waiting or giving
  // up self-explaining — it must never look like the click worked.
  assert.strictEqual(ats.atsSignatureChanged(null, SIG), false);
  assert.strictEqual(ats.atsSignatureChanged(SIG, null), false);
  assert.strictEqual(ats.atsSignatureChanged(null, null), false);
});

// ── the injected reads stay self-contained ──────────────────────────────────────────────

test("the new injected functions close over nothing (they cross the CDP boundary as source)", () => {
  for (const fn of [ats.atsInjPortalEvidence, ats.atsInjPageSignature, ats.atsInjClickApplyAnchor,
    ats.atsInjAuthScan, ats.atsInjClickAuthSubmit]) {
    const src = String(fn);
    // Every identifier they use must be a browser global, a parameter, or locally declared —
    // a reference to a module-scope helper would throw ReferenceError inside the page.
    assert.ok(!/\batsLib\.|\batsFd\.|\bapMatch\./.test(src), `${fn.name} reaches for a module namespace`);
    assert.ok(!/\brequire\(/.test(src), `${fn.name} calls require()`);
  }
});

test("atsInjClickAuthSubmit refuses a disabled control rather than reporting a press", () => {
  // Exercised as source-shape rather than in a DOM: the guard is the reason a stalled sign-in
  // reports "submit-disabled" instead of silently doing nothing and blaming the page.
  const src = String(ats.atsInjClickAuthSubmit);
  assert.ok(/submit-disabled/.test(src));
  assert.ok(/no-submit-control/.test(src));
});

// ── DAY-OF-MONTH: a form requires it, the profile stores months ───────────────────────────
// Every date on the iCIMS form nagged for a day, because a required field we cannot answer reaches
// review. The profile stores "2025-05", so the day comes from the operator's default — and the tests
// below are written around the one thing that matters: a default must never become a wrong FACT.

test("atsDefaultDay: absent config ⇒ the built-in default, so dates stop nagging out of the box", () => {
  assert.strictEqual(ats.atsDefaultDay(undefined), ats.ATS_DEFAULT_DAY);
  assert.strictEqual(ats.atsDefaultDay({}), ats.ATS_DEFAULT_DAY);
  assert.strictEqual(ats.ATS_DEFAULT_DAY, 1);
});

test("atsDefaultDay: an explicit null OPTS OUT — the field goes back to review", () => {
  // The escape hatch for an operator who would rather pick the day themselves than have one assumed.
  assert.strictEqual(ats.atsDefaultDay({ date_day: null }), null);
  assert.strictEqual(ats.atsDefaultDay({ date_day: { value: null } }), null);
});

test("⚠ atsDefaultDay: only 1–31 is accepted — a typo must not reach a real application", () => {
  assert.strictEqual(ats.atsDefaultDay({ date_day: 15 }), 15);
  assert.strictEqual(ats.atsDefaultDay({ date_day: { value: 15 } }), 15);
  assert.strictEqual(ats.atsDefaultDay({ date_day: "7" }), 7);
  for (const bad of [0, -1, 32, 45, "", "abc", []]) {
    assert.strictEqual(ats.atsDefaultDay({ date_day: bad }), null, `${JSON.stringify(bad)} must be refused`);
  }
  // `{}` is NOT junk — a wrapper with no `value` is indistinguishable from no `date_day` at all, and
  // both mean "unconfigured", so it takes the built-in default rather than being refused.
  assert.strictEqual(ats.atsDefaultDay({ date_day: {} }), ats.ATS_DEFAULT_DAY);
});

test("⚠ a day STATED in the profile beats the default — the default is only for what is unknown", () => {
  const es = { section: "experience", source: "work_experience", entryIndex: 0,
    spec: { kind: "date_day", from: "from" } };
  const stated = ats.atsResolveEntryField(es, { from: "2025-05-12" }, {}, undefined, { date_day: 1 });
  assert.strictEqual(stated.value, "12");
  assert.strictEqual(stated.source, "entry", "a stated day is a FACT, not a default");
  assert.strictEqual(stated.detail, undefined, "and it needs no explaining");
});

test("⚠ month precision ⇒ the default, FLAGGED for review because it is an approximation", () => {
  const es = { section: "experience", source: "work_experience", entryIndex: 0,
    spec: { kind: "date_day", from: "from" } };
  const r = ats.atsResolveEntryField(es, { from: "2025-05" }, {}, undefined, { date_day: 1 });
  assert.strictEqual(r.value, "1");
  assert.strictEqual(r.source, "default");
  // The gate: a value the operator did not state faces the human, same as an AI answer or a
  // non-exact match. It still FILLS, so the nag is one click rather than a lookup.
  assert.strictEqual(r.review, true, "a default must reach review");
  assert.strictEqual(r.flag, "default-value");
  assert.ok(!/^ai-/.test(r.flag), "not an AI guess — it must not pick up the AI styling");
  assert.match(r.detail, /not in your profile/i);
  assert.match(r.detail, /2025-05/, "names the value it could not get a day from");
});

test("⚠ a STATED day is a fact — filled, and NOT flagged", () => {
  // The asymmetry is the whole point: only the approximation is reviewable.
  const es = { section: "experience", source: "work_experience", entryIndex: 0,
    spec: { kind: "date_day", from: "from" } };
  const r = ats.atsResolveEntryField(es, { from: "2025-05-12" }, {}, undefined, { date_day: 1 });
  assert.strictEqual(r.value, "12");
  assert.strictEqual(r.review, undefined);
  assert.strictEqual(r.flag, undefined);
});

test("⚠ a YEAR-ONLY value gets no day — that would be doubly invented", () => {
  // "2024" says nothing about the month either, so a day off it is two guesses stacked.
  const es = { section: "education", source: "education", entryIndex: 0,
    spec: { kind: "date_day", from: "from_year" } };
  assert.strictEqual(ats.atsResolveEntryField(es, { from_year: "2024" }, {}, undefined, { date_day: 1 }), null);
  // …and an absent date resolves to nothing at all, rather than a day with no date.
  assert.strictEqual(ats.atsResolveEntryField(es, {}, {}, undefined, { date_day: 1 }), null);
});

test("opting out leaves a month-precision day unanswered rather than assumed", () => {
  const es = { section: "experience", source: "work_experience", entryIndex: 0,
    spec: { kind: "date_day", from: "from" } };
  assert.strictEqual(ats.atsResolveEntryField(es, { from: "2025-05" }, {}, undefined, { date_day: null }), null);
});

test("the shipped defaults file carries a valid day", () => {
  const d = require("../data/application_defaults.json");
  assert.strictEqual(ats.atsDefaultDay(d), 1);
});

// ── a native multi-select reaches review as a checkbox GROUP ─────────────────────────────
// Live 2026-08-17: "Please select the following employment options you would consider" rendered
// BLANK in review while the form plainly held two answers. `current_value` was right
// ("Internship, Part-time") but the group vocabulary joins and splits on GROUP_JOIN ("; "), so
// splitGroupValue could not split a comma-joined string — it became ONE option matching nothing,
// and the editor ticked no boxes.

const lib = require("../lib.js");

test("⚠ the multi-select join separator IS the shared group separator, in both injected reads", () => {
  // Injected functions cannot import, so the separator is hardcoded in two places. This is the pin
  // that stops them drifting from GROUP_JOIN again — drift is invisible until a form renders blank.
  assert.strictEqual(lib.GROUP_JOIN, "; ");
  for (const fn of [ats.atsInjScan, ats.atsInjReadValue]) {
    const src = String(fn);
    const multi = /multiselect_native[\s\S]{0,400}?selectedOptions[\s\S]{0,200}?join\((["'])(.*?)\1\)/.exec(src)
      || /selectedOptions[\s\S]{0,200}?join\((["'])(.*?)\1\)/.exec(src);
    assert.ok(multi, `${fn.name}: no multi-select join found`);
    assert.strictEqual(multi[2], lib.GROUP_JOIN,
      `${fn.name} joins a multi-select with ${JSON.stringify(multi[2])}, not GROUP_JOIN`);
  }
});

test("splitGroupValue round-trips what the multi-select now produces", () => {
  const picked = ["Internship", "Part-time"];
  const joined = lib.joinGroupValue(picked);
  assert.strictEqual(joined, "Internship; Part-time");
  assert.deepStrictEqual(lib.splitGroupValue(joined), picked);
  // …and the OLD comma form is exactly what could not be split — the bug, pinned so the reason stays
  // legible: one unmatched element is why the editor showed nothing.
  assert.deepStrictEqual(lib.splitGroupValue("Internship, Part-time"), ["Internship, Part-time"]);
});

test("groupSelection prefers the authoritative ARRAY over re-splitting the string", () => {
  // Which is why the commit path now sets `selected_options` from the read-back array rather than
  // letting the far side reverse-engineer a display string.
  assert.deepStrictEqual(
    lib.groupSelection({ selected_options: ["Internship", "Part-time"], current_value: "anything at all" }),
    ["Internship", "Part-time"],
  );
  // An older bundle carries no array, so its joined value is the only record of the set.
  assert.deepStrictEqual(lib.groupSelection({ current_value: "Internship; Part-time" }), ["Internship", "Part-time"]);
});

test("a multi-select record carries BOTH halves of the group contract", () => {
  // `selected_options` (authoritative) + `current_value` (joined display) — the same shape a Workday
  // checkbox group produces, so the review editor needs no multi-select-specific branch.
  const src = String(ats.driveAtsPageFill) + String(ats.atsActuateField || "");
  assert.ok(/rec\.selected_options\s*=/.test(src), "the multiselect commit must set selected_options");
  assert.ok(/joinGroupValue/.test(src), "current_value must be joined with the shared joiner");
});

// ── the candidate's phone, and REPEATED entries of a single-value field ──────────────────
// Live 2026-08-16: `-1_PersonProfileFields.PhoneNumber` / `.PhoneType` were both REQUIRED, both
// unmapped, and their labels are only "Number" and "Type" — so both fell through the label ladder to
// the AI, which answered "Number" with `24615`, the job's requisition id.

const PHONE_PROFILE = {
  personal_info: {
    phone_number: "4125551234", phone_device_type: "Mobile", phone_extension: "204",
    country_phone_code: ["United States of America (+1)", "United States"],
    city: "Pittsburgh", state_province: "Pennsylvania",
  },
};
const route = (f, profile) =>
  ats.atsRouteField("icims", f, profile || PHONE_PROFILE, {}, {}, new Map(), null);

test("⚠ the candidate's phone is MAPPED — it must never reach the AI again", () => {
  const num = route({ fieldName: "-1_PersonProfileFields.PhoneNumber", label: "Number", widgetType: "text", repeatIndex: 0 });
  assert.strictEqual(num.source, "map", "the phone NUMBER still routes to the AI");
  assert.strictEqual(num.path, "personal_info.phone_number");
  assert.strictEqual(num.raw, "4125551234");
  const type = route({ fieldName: "-1_PersonProfileFields.PhoneType", label: "Type", widgetType: "dropdown_native", repeatIndex: 0 });
  assert.strictEqual(type.source, "map", "the phone TYPE still routes to the AI");
  assert.strictEqual(type.path, "personal_info.phone_device_type");
  assert.strictEqual(type.raw, "Mobile");
  // The extension + dial-code halves, when a tenant renders them.
  const ext = route({ fieldName: "-1_PersonProfileFields.PhoneExtension", label: "Extension", widgetType: "text", repeatIndex: 0 });
  assert.strictEqual(ext.path, "personal_info.phone_extension");
  const dial = route({ fieldName: "-1_PersonProfileFields.PhoneCountry", label: "Country", widgetType: "dropdown_native", repeatIndex: 0 });
  assert.strictEqual(dial.kind, "dial", "the dial-code half must strip the trailing +<digits> for matching");
  // An EMPTY optional half maps to nothing and simply stays blank — it is not required, so the AI is
  // not eligible for it either (that gate is REQUIRED-only).
  const noExt = route({ fieldName: "-1_PersonProfileFields.PhoneExtension", label: "Extension", widgetType: "text", repeatIndex: 0 },
    { personal_info: { phone_number: "4125551234", phone_extension: "" } });
  assert.strictEqual(noExt, null);
});

test("the phone id family is keyed BARE, and cannot collide with an employer's phone", () => {
  // The candidate's is iCIMS' own platform vocabulary; an employer's phone in a work-history entry is
  // a per-customer rcf id (rcf3271 on this tenant), which this map deliberately does not contain.
  const m = ats.ATS_STATIC_MAPS.icims;
  assert.ok(m["PersonProfileFields.PhoneNumber"], "candidate phone number unmapped");
  assert.ok(m["PersonProfileFields.PhoneType"], "candidate phone type unmapped");
  assert.strictEqual(m["PersonProfileFields.rcf3271"], undefined, "a per-customer id must not be mapped");
});

test("⚠ A REPEAT IS DETECTED FROM THE PAGE, NOT DECLARED — nothing names which blocks repeat", () => {
  // The point of the design: no family list, so a tenant whose phone block is a single row is
  // unaffected, and a tenant that repeats something we have never seen is covered for free.
  const src = String(ats.atsAssignEntryIndexes);
  assert.ok(!/Address\|Phone|PhoneNumber|AddressCity/.test(src),
    "atsAssignEntryIndexes must not name specific id families");
  assert.strictEqual(ats.ATS_ICIMS_FLAT_REPEATING, undefined, "the hardcoded family list must be gone");
});

test("repeatIndex: one row per field ⇒ index 0 for everything, so the rule never fires", () => {
  // The common case, and the one that must be untouched: a form with a single address + phone.
  const fields = [
    { fieldName: "-1_PersonProfileFields.AddressCity", label: "City" },
    { fieldName: "-1_PersonProfileFields.PhoneNumber", label: "Number" },
    { fieldName: "-1_PersonProfileFields.PhoneType", label: "Type" },
  ];
  ats.atsAssignEntryIndexes("icims", fields);
  assert.deepStrictEqual(fields.map((f) => f.repeatIndex), [0, 0, 0]);
  assert.strictEqual(route(fields[1]).source, "map", "a single row must still be mapped");
});

test("repeatIndex: a SECOND rendered row is index 1, and is left for the operator", () => {
  const fields = [
    { fieldName: "-1_PersonProfileFields.PhoneNumber", label: "Number" },
    { fieldName: "-1_PersonProfileFields.PhoneType", label: "Type" },
    { fieldName: "-2_PersonProfileFields.PhoneNumber", label: "Number" },
    { fieldName: "-2_PersonProfileFields.PhoneType", label: "Type" },
  ];
  ats.atsAssignEntryIndexes("icims", fields);
  assert.deepStrictEqual(fields.map((f) => f.repeatIndex), [0, 0, 1, 1]);
  assert.strictEqual(route(fields[0]).source, "map", "the first row is still filled");
  const second = route(fields[2]);
  assert.strictEqual(second.kind, "skip");
  assert.strictEqual(second.source, "repeat-entry");
  // Blank, never a COPY of the first and never an AI guess: the profile holds one phone number, so
  // either of those would be a fabricated second one.
  assert.strictEqual(second.value, undefined);
  assert.match(second.detail, /single value|left for you/i);
});

test("repeatIndex counts ORDINAL POSITION, not the ordinal's numeric value", () => {
  // `-1` is iCIMS' default entry; a SAVED entry carries an opaque server id. So the first row the
  // page renders is index 0 whatever number it happens to carry.
  const fields = [
    { fieldName: "4839201_PersonProfileFields.AddressCity", label: "City" },
    { fieldName: "-1_PersonProfileFields.AddressCity", label: "City" },
  ];
  ats.atsAssignEntryIndexes("icims", fields);
  assert.deepStrictEqual(fields.map((f) => f.repeatIndex), [0, 1]);
});

test("⚠ a SECTION entry's repeats are NOT this rule — they come from a profile array", () => {
  // "Employer Phone Number" is rcf3271 at -1/-2/-3 inside Experience. Those are three real jobs, and
  // the section tier answers them from work_experience[i]; treating them as duplicates of one value
  // would blank two of them.
  const fields = [
    { fieldName: "-1_PersonProfileFields.rcf3271", label: "Employer Phone Number", section: "Experience" },
    { fieldName: "-2_PersonProfileFields.rcf3271", label: "Employer Phone Number", section: "Experience" },
    { fieldName: "-3_PersonProfileFields.rcf3271", label: "Employer Phone Number", section: "Experience" },
  ];
  ats.atsAssignEntryIndexes("icims", fields);
  for (const f of fields) {
    assert.strictEqual(f.entrySection, "experience", "should be claimed by the section tier");
    assert.strictEqual(f.repeatIndex, undefined, "a section entry must not be stamped as a repeat");
  }
  assert.deepStrictEqual(fields.map((f) => f.entryIndex), [0, 1, 2]);
});

test("repeatIndex is iCIMS-only and needs an ordinal — a plain id is untouched", () => {
  const fields = [
    { fieldName: "PersonProfileFields.FirstName", label: "First Name" },
    { fieldName: "-1_PersonProfileFields.PhoneNumber", label: "Number" },
  ];
  ats.atsAssignEntryIndexes("greenhouse", fields);
  assert.deepStrictEqual(fields.map((f) => f.repeatIndex), [undefined, undefined]);
  ats.atsAssignEntryIndexes("icims", fields);
  assert.deepStrictEqual(fields.map((f) => f.repeatIndex), [undefined, 0]);
});

// ── option-list completeness: which optional dropdowns reach review as real PICKERS ─────
// Every icims_dropdown used to be marked partial UNCONDITIONALLY — the flag read a
// `data-ap-complete` attribute nothing in the codebase has ever written. A partial list is attached
// as captured_options + widgetType "typeahead", i.e. review renders a type-it-yourself box, so a
// two-option "May We Contact" question reached the operator as FREE TEXT.

test("atsIcimsPageCap: the live Astrion form's own dropdowns reveal a page size of 25", () => {
  // Measured 2026-08-16, scan-time on a FRESH form (before any actuation, the only uncontaminated
  // moment): 2x1, 10x2, 1x6, 1x17, 11x25. Time Zone / Country / State/Province / Degree all
  // stopping at exactly 25 is a pager — four unrelated vocabularies do not share a length by chance.
  const lengths = [1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 6, 17, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25];
  assert.strictEqual(ats.atsIcimsPageCap(lengths), 25);
});

test("atsIcimsPageCap: a length must REPEAT to be a cap, and be big enough to be a page", () => {
  assert.strictEqual(ats.atsIcimsPageCap([17, 6, 2]), null);   // nothing repeats
  assert.strictEqual(ats.atsIcimsPageCap([17, 17, 6]), 17);    // repeated and at/above the floor
  // ⚠ ten Yes/No dropdowns all holding 2 options must NOT be read as "the page size is 2" —
  // every list on the form would then be at-or-above the cap and nothing could ever be proven.
  assert.strictEqual(ats.atsIcimsPageCap([2, 2, 2, 2, 2]), null);
  assert.strictEqual(ats.atsIcimsPageCap([]), null);
  assert.strictEqual(ats.atsIcimsPageCap(null), null);
});

test("atsIcimsPageCap: the LARGEST repeated length wins (a smaller one is a vocabulary)", () => {
  assert.strictEqual(ats.atsIcimsPageCap([12, 12, 25, 25, 25]), 25);
});

test("atsIcimsListComplete: a page that came back SHORT has reached its end", () => {
  assert.ok(ats.atsIcimsListComplete(2, 25, 25));    // May We Contact — a real picker now
  assert.ok(ats.atsIcimsListComplete(6, 25, 25));    // Availability
  assert.ok(ats.atsIcimsListComplete(17, 25, 25));   // School's first page
  assert.ok(ats.atsIcimsListComplete(24, 25, 25));
});

test("⚠ atsIcimsListComplete: a FULL page is unproven, and stays free text rather than lying", () => {
  // The asymmetry is the point. A picker MISSING the operator's answer makes them conclude the form
  // does not offer it; a complete list called partial only costs them a typed value.
  assert.strictEqual(ats.atsIcimsListComplete(25, 25, 25), false);
  assert.strictEqual(ats.atsIcimsListComplete(26, 25, 26), false);
});

test("atsIcimsListComplete: no cap proven means complete only when nothing is even page-sized", () => {
  // A form of small dropdowns cannot be suffering truncation at all, so they are pickers…
  assert.ok(ats.atsIcimsListComplete(3, null, 6));
  // …but once anything on the form IS page-sized, an unproven cap means UNPROVEN — today's
  // behaviour, not a guess in either direction.
  assert.strictEqual(ats.atsIcimsListComplete(3, null, 25), false);
  assert.strictEqual(ats.atsIcimsListComplete(3, null, ats.ATS_ICIMS_CAP_MIN), false);
});

test("atsIcimsListComplete: an EMPTY list is never complete (there is nothing to pick)", () => {
  // The awaiting-parent State dropdown lands here: its only row is the "Please select a country"
  // placeholder, which the scan now drops, so it has no options and must not become a picker.
  assert.strictEqual(ats.atsIcimsListComplete(0, 25, 25), false);
  assert.strictEqual(ats.atsIcimsListComplete(null, 25, 25), false);
});

test("⚠ the scan drops BOTH placeholder rows — a one-row child is not a one-option vocabulary", () => {
  const src = String(ats.atsInjScan);
  assert.ok(/make a selection/i.test(src), "the placeholder row must be filtered");
  assert.ok(/please select a /i.test(src), "the awaiting-parent row must be filtered too");
});

test("ATS_CHOICE_WIDGETS is the single list the call sites share", () => {
  // CLAUDE.md: a new choice widget must be registered in FOUR places and a miss fails silently and
  // differently each time. The list was inlined identically three times, which makes the fourth
  // miss inevitable.
  for (const w of ["icims_dropdown", "dropdown_native", "radio", "yesno", "checkbox_group",
    "multiselect_native", "select", "dial", "location"]) {
    assert.ok(ats.ATS_CHOICE_WIDGETS.includes(w), w + " missing from ATS_CHOICE_WIDGETS");
  }
  assert.ok(!/"select",\s*"dial",\s*"radio",\s*"yesno"/.test(String(ats.driveAtsPageFill)),
    "the choice-widget list is inlined again inside driveAtsPageFill");
});
