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
