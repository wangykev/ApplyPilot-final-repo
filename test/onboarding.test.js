// Unit tests for the onboarding-stage PURE decisions in lib.js (the JD → Apply →
// Apply Manually → auth → verify flow). The DOM driving is in the SW; these pin the
// decisions that must not regress: the Apply-button priority, the sign-in outcome
// classifier, the Workday soft-error (refresh) detector, and SSO detection.
const { test } = require("node:test");
const assert = require("node:assert");
const { pickApplyTarget, classifyAuthOutcome, isWorkdaySoftError, looksLikeSso, isAlreadyApplied, jobPageSettleStep, isBlankAuthPage, parseErrorFieldName, phantomRequiredTargets,
  classifyWorkdayPage, applyChainStuckMixed, isMyApplicationsPage, applicationStatusOf, reqIdFromUrl, pickApplicationRow } = require("../lib.js");

// Fold the pure settle rule over a sequence of page reads → the 1-based read it accepts at (null = never).
const settleAt = (reads) => {
  let st = null;
  for (let i = 0; i < reads.length; i++) {
    st = jobPageSettleStep(reads[i], st);
    if (st.accept) return i + 1;
  }
  return null;
};

const A = '[data-automation-id="adventureButton"]';
const C = '[data-automation-id="continueButton"]';
const M = '[data-automation-id="applyManually"]';
const REJECT = '[data-automation-id="useMyLastApplication"]';

test("pickApplyTarget: adventureButton wins over the rest", () => {
  assert.strictEqual(pickApplyTarget([M, C, A]).sel, A);
});
test("pickApplyTarget: falls to continueButton, then applyManually", () => {
  assert.strictEqual(pickApplyTarget([C, M]).sel, C);
  assert.strictEqual(pickApplyTarget([M]).sel, M);
});
test("pickApplyTarget: null when only reject/other controls are present", () => {
  assert.strictEqual(pickApplyTarget([REJECT]), null);
  assert.strictEqual(pickApplyTarget([]), null);
});

test("classifyAuthOutcome: verification message → 'verify'", () => {
  assert.strictEqual(classifyAuthOutcome({ bodyText: "A verification email has been sent to your inbox." }), "verify");
  assert.strictEqual(classifyAuthOutcome({ bodyText: "Please verify your account to continue." }), "verify");
});
test("classifyAuthOutcome: bad-credentials message → 'wrong_credentials'", () => {
  assert.strictEqual(classifyAuthOutcome({ bodyText: "The email or password you entered is incorrect." }), "wrong_credentials");
  assert.strictEqual(classifyAuthOutcome({ bodyText: "We couldn't find an account with that email." }), "wrong_credentials");
});
test("classifyAuthOutcome: 'success' only when a real form is present AND no auth element", () => {
  assert.strictEqual(classifyAuthOutcome({ bodyText: "My Information", formFieldCount: 12, hasAuthEl: false }), "success");
  assert.strictEqual(classifyAuthOutcome({ bodyText: "My Information", formFieldCount: 12, hasAuthEl: true }), "unknown", "a lingering auth element blocks success");
  assert.strictEqual(classifyAuthOutcome({ bodyText: "loading…", formFieldCount: 0, hasAuthEl: false }), "unknown");
});
test("classifyAuthOutcome: verify/wrong precede success (message is decisive)", () => {
  // A form skeleton has rendered but the verify message is present → still 'verify'.
  assert.strictEqual(classifyAuthOutcome({ bodyText: "check your email to verify your account", formFieldCount: 5, hasAuthEl: false }), "verify");
});

test("isWorkdaySoftError: the exact 'something went wrong / please refresh' page → true", () => {
  assert.strictEqual(isWorkdaySoftError("Something went wrong. Please refresh the page and then try again."), true);
});
test("isWorkdaySoftError: needs BOTH the apology AND a refresh/try-again cue", () => {
  assert.strictEqual(isWorkdaySoftError("Something went wrong with this field."), false, "apology alone is not enough");
  assert.strictEqual(isWorkdaySoftError("Please refresh your saved filters."), false, "refresh alone is not enough");
  assert.strictEqual(isWorkdaySoftError("An unexpected error occurred — please try again."), true);
});

test("looksLikeSso: SSO-provider URLs → true; a plain Workday login URL → false", () => {
  assert.strictEqual(looksLikeSso({ url: "https://acme.okta.com/app/workday/sso/saml" }), true);
  assert.strictEqual(looksLikeSso({ url: "https://login.microsoftonline.com/x" }), true);
  assert.strictEqual(looksLikeSso({ url: "https://acme.wd1.myworkdayjobs.com/en-US/careers/login" }), false);
});
test("looksLikeSso: a sign-in button with no email/password field → true (redirect button)", () => {
  assert.strictEqual(looksLikeSso({ url: "https://x/login", signInButtonPresent: true, emailInput: false, passwordInput: false }), true);
  assert.strictEqual(looksLikeSso({ url: "https://x/login", signInButtonPresent: true, emailInput: true, passwordInput: true }), false);
});
// REGRESSION (live, Caterpillar wd5 in a BACKGROUND tab, 2026-07-27). The field-absence branch above is
// absence-of-evidence, and on a Workday host it fired on an ordinary CREATE-ACCOUNT page whose widget
// simply hadn't painted its inputs yet: auth chrome present, no email/password in the DOM, and the
// "Already have an account? Sign In" link satisfying signInButtonPresent → a flat-wrong "this tenant uses
// SSO" halt. Operator: "Workday will never be SSO." A REAL federated login leaves the Workday host, so the
// URL test still catches it — see the isWorkdayHost guard.
test("looksLikeSso: a still-RENDERING Workday auth page is NOT sso (field-absence proves nothing there)", () => {
  const midRender = {
    url: "https://cat.wd5.myworkdayjobs.com/en-US/CaterpillarCareers/login",
    signInButtonPresent: true, emailInput: false, passwordInput: false, signInWithEmail: false,
    hasAuthEl: true, markers: { signInLink: true, createAccountSubmit: true },
  };
  assert.strictEqual(looksLikeSso(midRender), false);
  // …and the same page on the logged-in form host is equally not-SSO.
  assert.strictEqual(looksLikeSso({ ...midRender, url: "https://wd5.myworkdaysite.com/recruiting/cat/x/login" }), false);
});
test("looksLikeSso: a Workday tenant that REDIRECTS to an identity provider is still caught (positive evidence)", () => {
  assert.strictEqual(looksLikeSso({ url: "https://cat.okta.com/app/signin", signInButtonPresent: true, emailInput: false, passwordInput: false }), true);
  assert.strictEqual(looksLikeSso({ url: "https://login.microsoftonline.com/cat", signInButtonPresent: true, emailInput: false, passwordInput: false }), true);
  // A non-Workday host keeps the original field-absence inference (unchanged behavior).
  assert.strictEqual(looksLikeSso({ url: "https://careers.acme.com/login", signInButtonPresent: true, emailInput: false, passwordInput: false }), true);
});

test("looksLikeSso: a social-login chooser with a 'Sign in with email' button → NOT sso", () => {
  // Palo Alto Networks variant: Apple/Google/LinkedIn buttons + SignInWithEmailButton, no form yet.
  assert.strictEqual(looksLikeSso({ url: "https://paloaltonetworks.wd5.myworkdayjobs.com/…/applyManually", signInButtonPresent: true, emailInput: false, passwordInput: false, signInWithEmail: true }), false);
});

// ── jobPageSettleStep — "has the posting finished rendering?" (replaces a flat 1500ms beat) ─────────
// Live evidence it exists for (Caterpillar wd5, background run, 2026-07-27): a scrape read 461 chars of
// a posting that healthy runs read as 2913, and the still-hydrating page then reflowed the Apply button
// out from under the cover-check.
test("jobPageSettleStep: a warm load settles as soon as an equal read lands WITH posting content", () => {
  assert.strictEqual(settleAt([
    { len: 800, hasPosting: false },
    { len: 2913, hasPosting: true },
    { len: 2913, hasPosting: true },
  ]), 3, "two equal reads + the posting present = done (and sooner than the flat beat it replaces)");
});

test("jobPageSettleStep: a page PAUSED mid-hydration is NOT accepted on one repeat (the 461-char case)", () => {
  assert.strictEqual(settleAt([
    { len: 461, hasPosting: false },
    { len: 461, hasPosting: false },
  ]), null, "equal but no posting content → keep waiting, don't scrape a partial page");
});

test("jobPageSettleStep: …and it DOES settle once the real content arrives", () => {
  assert.strictEqual(settleAt([
    { len: 461, hasPosting: false },
    { len: 461, hasPosting: false },
    { len: 2913, hasPosting: true },
    { len: 2913, hasPosting: true },
  ]), 4);
});

test("jobPageSettleStep: a genuinely static page with no posting marker still settles (3 repeats)", () => {
  assert.strictEqual(settleAt([
    { len: 900, hasPosting: false }, { len: 900, hasPosting: false },
    { len: 900, hasPosting: false }, { len: 900, hasPosting: false },
  ]), 4, "never block forever on a tenant whose markers we don't recognize");
});

test("jobPageSettleStep: an empty/unreadable page never counts as settled", () => {
  assert.strictEqual(settleAt([{ len: 0, hasPosting: false }, { len: 0, hasPosting: false }, { len: 0, hasPosting: false }]), null);
  assert.strictEqual(settleAt([{}, {}, {}]), null);
});

// ── isBlankAuthPage — Workday's EMPTY shell after a sign-in submit (recover by reloading) ───────────
// Captured live on cat.wd5/solarturbines: the submit returned a fully-loaded page with NOTHING on it,
// while the title still said "Create Account". It used to halt `auth-unknown`; a reload fixes it.
// The detector authorizes a page RELOAD, so every near-miss below must stay false.
const BLANK_LIVE = {
  readyState: "complete", formFieldCount: 0, hasAuthEl: false, emailInput: false, passwordInput: false,
  signInWithEmail: false, markers: {},
  bodyText: 'Skip to main content This site uses and sets "cookies" on your computer to help make this website better.',
};
test("isBlankAuthPage: the live empty-shell state → true", () => {
  assert.strictEqual(isBlankAuthPage(BLANK_LIVE), true);
});
test("isBlankAuthPage: a page still LOADING is never blank (absence proves nothing mid-navigation)", () => {
  assert.strictEqual(isBlankAuthPage({ ...BLANK_LIVE, readyState: "loading" }), false);
  assert.strictEqual(isBlankAuthPage({ ...BLANK_LIVE, readyState: undefined }), false, "an older scan without readyState fails closed");
});
test("isBlankAuthPage: ANY actionable page is never blank (never reload something we can drive)", () => {
  assert.strictEqual(isBlankAuthPage({ ...BLANK_LIVE, formFieldCount: 2 }), false, "the application form");
  assert.strictEqual(isBlankAuthPage({ ...BLANK_LIVE, emailInput: true, hasAuthEl: true }), false, "a live sign-in form");
  assert.strictEqual(isBlankAuthPage({ ...BLANK_LIVE, markers: { signInSubmit: true } }), false);
  assert.strictEqual(isBlankAuthPage({ ...BLANK_LIVE, markers: { createAccountSubmit: true } }), false);
  assert.strictEqual(isBlankAuthPage({ ...BLANK_LIVE, markers: { applyManually: true } }), false, "the apply chain");
  assert.strictEqual(isBlankAuthPage({ ...BLANK_LIVE, markers: { alreadyAppliedPage: true } }), false, "already-applied is its own clean halt");
  assert.strictEqual(isBlankAuthPage({ ...BLANK_LIVE, bodyText: "x".repeat(3000) }), false, "a page with real content");
});

test("isAlreadyApplied: the alreadyAppliedPage marker → true (Magna wd3 — title is a stale 'Create Account')", () => {
  assert.strictEqual(isAlreadyApplied({ title: "Create Account", markers: { alreadyAppliedPage: true }, bodyText: "" }), true);
});
test("isAlreadyApplied: body-text fallback when the marker is absent", () => {
  assert.strictEqual(isAlreadyApplied({ markers: {}, bodyText: "Junior Full Stack Developer Coop You've already applied for this job. View My Applications" }), true);
  assert.strictEqual(isAlreadyApplied({ markers: {}, bodyText: "You have already applied for this position." }), true);
});
test("isAlreadyApplied: an ordinary form / auth / apply page → false (no false positive)", () => {
  assert.strictEqual(isAlreadyApplied({ markers: { formField: true }, bodyText: "My Information First name Last name" }), false);
  assert.strictEqual(isAlreadyApplied({ markers: { signInSubmit: true }, bodyText: "Sign In Email Password" }), false);
  assert.strictEqual(isAlreadyApplied({ markers: {}, bodyText: "Apply Apply Manually Use My Last Application" }), false);
  assert.strictEqual(isAlreadyApplied(null), false);
  assert.strictEqual(isAlreadyApplied({}), false);
});

// ── Already-applied RECOVERY: the pure decisions (2026-07-28) ───────────────────────────────────────
// Workday shows "you've already applied" for started-but-unsubmitted applications too, so the flow now
// checks the candidate's own applications list before believing it. These pin the three decisions that
// could silently do the WRONG thing: mislabelling "Not Submitted", picking the wrong application row,
// and misreading which page a click landed on.

test('applicationStatusOf: "Not Submitted" is NOT submitted (the substring trap)', () => {
  // "Not Submitted" CONTAINS "Submitted" — a positive-first test abandons every fillable application.
  assert.strictEqual(applicationStatusOf("Not Submitted"), "not-submitted");
  assert.strictEqual(applicationStatusOf("Software Engineer Intern — Not Submitted — 10/02/2026"), "not-submitted");
  assert.strictEqual(applicationStatusOf("Unsubmitted"), "not-submitted");
  assert.strictEqual(applicationStatusOf("In Progress"), "not-submitted");
  assert.strictEqual(applicationStatusOf("Draft"), "not-submitted");
});
test("applicationStatusOf: a genuinely submitted row, and an unreadable one", () => {
  assert.strictEqual(applicationStatusOf("Submitted"), "submitted");
  assert.strictEqual(applicationStatusOf("Gas Turbine Intern — Submitted — Under Consideration"), "submitted");
  assert.strictEqual(applicationStatusOf("Gas Turbine Intern 10/02/2026"), "unknown", "no status word ⇒ unknown, never a guess");
  assert.strictEqual(applicationStatusOf(""), "unknown");
  assert.strictEqual(applicationStatusOf(null), "unknown");
});

test("reqIdFromUrl: the requisition id out of a Workday job URL", () => {
  assert.strictEqual(
    reqIdFromUrl("https://cat.wd5.myworkdaysite.com/en-US/solarturbines/job/San-Diego%2C-California/XMLNAME-2027--Gas-Turbine-Product-Engineering-Internship_R0000382293/apply"),
    "R0000382293");
  assert.strictEqual(reqIdFromUrl("Requisition ID: R0000382293"), "R0000382293");
  assert.strictEqual(reqIdFromUrl("JR-102938"), "JR-102938");
  assert.strictEqual(reqIdFromUrl("https://x.wd1.myworkdayjobs.com/en-US/careers"), null);
  assert.strictEqual(reqIdFromUrl(null), null);
});

const ROW = (title, href, text) => ({ title, href, text: text || title });

test("pickApplicationRow: the requisition id wins — titles truncate, req ids don't", () => {
  const rows = [
    ROW("Mechanical Engineering Intern", "https://x/job/A_R0000111111/apply", "Mechanical Engineering Intern Submitted"),
    ROW("2027 Gas Turbine Product Engi…", "https://x/job/B_R0000382293/apply", "2027 Gas Turbine Product Engi… Not Submitted"),
  ];
  const got = pickApplicationRow(rows, { url: "https://x/job/B_R0000382293/apply", title: "Something Else Entirely" });
  assert.strictEqual(got.tier, "req-id");
  assert.strictEqual(got.row.href, "https://x/job/B_R0000382293/apply");
});
test("pickApplicationRow: exact title, then single-match containment", () => {
  const rows = [ROW("Gas Turbine Intern", "https://x/job/a"), ROW("Software Intern", "https://x/job/b")];
  assert.strictEqual(pickApplicationRow(rows, { title: "gas  turbine   intern" }).tier, "exact-title", "normalized exact");
  assert.strictEqual(pickApplicationRow(rows, { title: "Software" }).tier, "title-containment");
});
test("pickApplicationRow: AMBIGUITY REFUSES — opening the wrong application would fill someone else's", () => {
  const dupTitle = [ROW("Engineering Intern", "https://x/job/a"), ROW("Engineering Intern", "https://x/job/b")];
  const dup = pickApplicationRow(dupTitle, { title: "Engineering Intern" });
  assert.strictEqual(dup.row, null);
  assert.match(dup.reason, /2 rows share the title/);

  const partial = [ROW("Engineering Intern - Summer", "https://x/job/a"), ROW("Engineering Intern - Fall", "https://x/job/b")];
  assert.strictEqual(pickApplicationRow(partial, { title: "Engineering Intern" }).row, null, "2+ containment hits is not a confident match");

  const twoReq = [ROW("A", "https://x/job/a_R0000382293"), ROW("B", "https://x/job/b_R0000382293")];
  assert.strictEqual(pickApplicationRow(twoReq, { url: "https://x/job/c_R0000382293" }).row, null);
});
test("pickApplicationRow: no rows / no match reports WHY", () => {
  assert.match(pickApplicationRow([], { title: "X" }).reason, /no rows/);
  const miss = pickApplicationRow([ROW("Other Job", "https://x/job/z")], { url: "https://x/job/q_R0000382293", title: "Gas Turbine" });
  assert.strictEqual(miss.row, null);
  assert.match(miss.reason, /R0000382293/);
});

test("isMyApplicationsPage: heading + a status word; the already-applied page that LINKS to it is not it", () => {
  assert.strictEqual(isMyApplicationsPage({ markers: {}, bodyText: "My Applications Gas Turbine Intern Not Submitted 10/02/2026" }), true);
  assert.strictEqual(isMyApplicationsPage({ markers: { myApplicationsPage: true }, bodyText: "" }), true, "the marker alone");
  assert.strictEqual(
    isMyApplicationsPage({ markers: { alreadyAppliedPage: true }, bodyText: "You've already applied for this job. View My Applications" }),
    false, "the already-applied page links to the list — it is not the list");
  assert.strictEqual(isMyApplicationsPage({ markers: {}, bodyText: "My Applications" }), false, "a heading with no status word");
  assert.strictEqual(isMyApplicationsPage({ markers: { formField: true }, bodyText: "My Information First name" }), false);
});

test("classifyWorkdayPage: each landing is named — the whole point is never assuming where a click went", () => {
  assert.strictEqual(classifyWorkdayPage({ markers: { alreadyAppliedPage: true }, bodyText: "" }), "already-applied");
  assert.strictEqual(classifyWorkdayPage({ markers: {}, bodyText: "My Applications Intern Not Submitted" }), "my-applications");
  assert.strictEqual(classifyWorkdayPage({ markers: { applyFlowReviewPage: true }, formFieldCount: 3 }), "review");
  assert.strictEqual(classifyWorkdayPage({ markers: { formField: true }, formFieldCount: 14, hasAuthEl: false }), "form");
  assert.strictEqual(classifyWorkdayPage({ markers: {}, formFieldCount: 0, hasAuthEl: true, passwordInput: true }), "auth");
  assert.strictEqual(classifyWorkdayPage({ markers: { continueButton: true }, formFieldCount: 0 }), "job-description");
  assert.strictEqual(classifyWorkdayPage({ markers: { adventureButton: true }, formFieldCount: 0 }), "job-description");
  assert.strictEqual(classifyWorkdayPage({ markers: {}, formFieldCount: 0, bodyText: "Something went wrong. Please refresh the page." }), "soft-error");
  assert.strictEqual(classifyWorkdayPage({ markers: {}, formFieldCount: 0, bodyText: "" }), "unknown");
});
test("classifyWorkdayPage: a form page still showing auth chrome is NOT yet the form", () => {
  // The success test everywhere else in the flow (isPastAuth) is fields AND no auth chrome — same here,
  // so a half-rendered auth widget over a form can't be mistaken for having arrived.
  assert.strictEqual(classifyWorkdayPage({ markers: { formField: true }, formFieldCount: 2, hasAuthEl: true }), "auth");
});
test("classifyWorkdayPage: transient/terminal states outrank page shape", () => {
  // A maintenance or soft-error page can carry leftover chrome; those must win or the flow acts on a
  // page that is about to be replaced.
  assert.strictEqual(
    classifyWorkdayPage({ markers: { formField: true }, formFieldCount: 5, bodyText: "Something went wrong. Please refresh the page." }),
    "soft-error");
  assert.strictEqual(
    classifyWorkdayPage({ markers: { continueButton: true }, formFieldCount: 0, bodyText: "You've already applied for this job. View My Applications" }),
    "already-applied");
});

// ── Workday's PHANTOM "required" error (2026-07-28) ─────────────────────────────────────────────────
// Live, HIDDEN solarturbines replay page 5: "The field Name is required and must have a value" + the
// same for Date, while both fields held correct, read-back-verified values. Cause is the synthetic-mode
// blur race. `phantomRequiredTargets` is the SAFETY GATE on the automatic re-save, so these pin the
// direction that actually matters: it must REFUSE anything that isn't provably the race, because a false
// positive re-saves a page with a genuinely empty required field and hides a real problem behind a retry.

const F = (fieldName, label, value) => ({ fieldName, label, value, wrapperSel: `[data-automation-id="formField-${fieldName}"]` });
// The live page-5 shape, verbatim from the run that failed.
const PAGE5 = [
  F("name", "Name*", "Kevin Wang"),
  F("dateSignedOn", "Date*", "07/28/2026"),
  F("disabilityStatus", "Please check one of the boxes below", "No, I do not have a disability"),
];
const ERR_NAME = "Error-NameThe field Name is required and must have a value.";
const ERR_DATE = "Error-DateThe field Date is required and must have a value.";
const titlesOf = (...errs) => errs.map((e) => parseErrorFieldName(e));

test("phantomRequiredTargets: the live page-5 case — both named fields hold values ⇒ PHANTOM", () => {
  const v = phantomRequiredTargets(titlesOf(ERR_NAME, ERR_DATE), PAGE5);
  assert.strictEqual(v.phantom, true);
  assert.deepStrictEqual(v.targets.map((t) => t.fieldName), ["name", "dateSignedOn"]);
  assert.deepStrictEqual(v.targets.map((t) => t.wrapperSel), [
    '[data-automation-id="formField-name"]',
    '[data-automation-id="formField-dateSignedOn"]',
  ]);
});

test("phantomRequiredTargets: a GENUINELY empty required field is NOT the phantom (the dangerous direction)", () => {
  // If this returned phantom:true the walk would nudge and re-save a page that really is incomplete,
  // burying a real gap under a retry. One empty field among many full ones must veto the whole thing.
  const withEmptyDate = [F("name", "Name*", "Kevin Wang"), F("dateSignedOn", "Date*", "")];
  const v = phantomRequiredTargets(titlesOf(ERR_NAME, ERR_DATE), withEmptyDate);
  assert.strictEqual(v.phantom, false);
  assert.match(v.reason, /genuinely empty/);
  assert.match(v.reason, /Date/);
});

test("phantomRequiredTargets: an UNMATCHED error title vetoes it (we don't understand that error)", () => {
  // A field the error names but the scan can't see could be anywhere — inside a repeating section the
  // flat scan filters out, or not rendered yet. Acting on a partial understanding is how a retry loop
  // starts, so any unmatched title refuses.
  const v = phantomRequiredTargets(titlesOf(ERR_NAME, "Error-SchoolThe field School is required and must have a value."), PAGE5);
  assert.strictEqual(v.phantom, false);
  assert.match(v.reason, /not every error maps/);
  assert.match(v.reason, /School/);
});

test("phantomRequiredTargets: no titles / no matching field / empty page ⇒ refuse with a reason", () => {
  assert.strictEqual(phantomRequiredTargets([], PAGE5).phantom, false);
  assert.match(phantomRequiredTargets([], PAGE5).reason, /names no field/);
  const none = phantomRequiredTargets(["Salary Expectation"], PAGE5);
  assert.strictEqual(none.phantom, false);
  assert.match(none.reason, /match no field on this page/);
  assert.strictEqual(phantomRequiredTargets(titlesOf(ERR_NAME), []).phantom, false);
});

test("phantomRequiredTargets: matches on the automation-id when the error is worded after it", () => {
  const byId = [F("dateSignedOn", "Signature Date", "07/28/2026")];
  const v = phantomRequiredTargets(["dateSignedOn"], byId);
  assert.strictEqual(v.phantom, true);
  assert.strictEqual(v.targets[0].fieldName, "dateSignedOn");
});

test("phantomRequiredTargets: the required-marker asterisk doesn't break the label match", () => {
  // The error says "Name"; the DOM label is "Name*" (normalizeLabel strips it). A mismatch here would
  // silently disable the whole fix on every required field — i.e. on every field it exists for.
  assert.strictEqual(phantomRequiredTargets(["Name"], [F("name", "Name*", "Kevin Wang")]).phantom, true);
  assert.strictEqual(phantomRequiredTargets(["Name"], [F("name", "Name **", "Kevin Wang")]).phantom, true);
});

test("phantomRequiredTargets: a placeholder 'Select One' does not count as holding a value", () => {
  const v = phantomRequiredTargets(["Country"], [F("country", "Country*", "Select One")]);
  assert.strictEqual(v.phantom, false);
  assert.match(v.reason, /genuinely empty/);
});

test("phantomRequiredTargets: a CHECKED checkbox (boolean true) counts as holding a value", () => {
  assert.strictEqual(phantomRequiredTargets(["Acknowledgement"], [F("ack", "Acknowledgement*", true)]).phantom, true);
  assert.strictEqual(phantomRequiredTargets(["Acknowledgement"], [F("ack", "Acknowledgement*", false)]).phantom, false);
});

// REGRESSION (live, background submit run on cat.wd5/solarturbines, 2026-07-29). `signInButtonPresent` is
// a TEXT match over every clickable, and a Workday POSTING carries "Sign In" in its own header — so the JD
// page satisfied the onboarding's Stage-3 auth condition, doAuth waited its full 30s for credential fields
// that were never coming, and the run halted `auth-form-not-rendered` while the final state read
// `markers=[continueButton]` — the very button Stage 1 wanted to click. The discriminator is that an
// apply-chain marker is POSITIVE evidence, which must beat the absence-based text match.
test("classifyWorkdayPage: a JD page whose HEADER has a Sign In link is job-description, NOT auth", () => {
  const jdWithSignInHeader = {
    url: "https://cat.wd5.myworkdayjobs.com/en-US/solarturbines/job/San-Diego-California/XMLNAME-2027--Gas-Turbine-Product-Engineering-Internship_R0000382293",
    title: "2027 Gas Turbine Product Engineering Internship",
    readyState: "complete",
    formFieldCount: 0,
    emailInput: false, passwordInput: false, signInWithEmail: false, hasAuthEl: false,
    signInButtonPresent: true,                 // <- the header link that caused the bug
    markers: { continueButton: true },
    bodyText: "2027 Gas Turbine Product Engineering Internship Continue Application Sign In",
  };
  assert.strictEqual(classifyWorkdayPage(jdWithSignInHeader), "job-description");
  // …and the exact state the run halted on (the header link gone, Continue rendered) is the same verdict.
  assert.strictEqual(classifyWorkdayPage({ ...jdWithSignInHeader, signInButtonPresent: false }), "job-description");
  // A maintenance page must not be claimed by this path, and a signInButtonPresent page is never maintenance.
  assert.notStrictEqual(classifyWorkdayPage(jdWithSignInHeader), "maintenance");
});
test("classifyWorkdayPage: a REAL auth screen is still auth, even with an apply marker left on the page", () => {
  // The guard must never swallow a genuine auth screen: any credential field wins.
  assert.strictEqual(classifyWorkdayPage({ formFieldCount: 0, passwordInput: true, hasAuthEl: true, markers: { continueButton: true } }), "auth");
  assert.strictEqual(classifyWorkdayPage({ formFieldCount: 0, emailInput: true, hasAuthEl: true, markers: { applyManually: true } }), "auth");
  assert.strictEqual(classifyWorkdayPage({ formFieldCount: 0, signInWithEmail: true, hasAuthEl: true, markers: {} }), "auth");
});

// ── The half-torn-down apply chain (2026-08-07, live: radiancetech.wd12 + magna.wd3) ────────────────
// A healthy JD page has adventureButton and NO applyManually; a healthy /apply chooser has
// applyManually + useMyLastApplication and NO adventureButton (verified against a cleanly-loaded
// chooser). Both at once means the SPA swapped views without tearing the old one down, so the
// coordinate click hits a dead layer, reports success, and the page never moves. Onboarding used to
// burn the full 45s budget and re-issue the identical click three rounds over, then halt backToApply.
const STUCK = {
  // the exact marker set the live run logged on every read for 45s
  markers: { adventureButton: true, applyManually: true, useMyLastApplication: true },
  formFieldCount: 0, hasAuthEl: false, emailInput: false, passwordInput: false,
  title: "Senior FPGA Engineer",
};
test("applyChainStuckMixed: Apply + Apply Manually mounted together is the stuck state", () => {
  assert.strictEqual(applyChainStuckMixed(STUCK), true);
});
test("applyChainStuckMixed: a healthy JD page is NOT stuck (no applyManually)", () => {
  assert.strictEqual(applyChainStuckMixed({ markers: { adventureButton: true }, formFieldCount: 0, hasAuthEl: false }), false);
});
test("applyChainStuckMixed: a healthy chooser is NOT stuck (no adventureButton)", () => {
  assert.strictEqual(applyChainStuckMixed({ markers: { applyManually: true, useMyLastApplication: true }, formFieldCount: 0, hasAuthEl: false }), false);
});
test("applyChainStuckMixed: never fires once auth or the form has rendered — that is 'not landed yet', not stuck", () => {
  assert.strictEqual(applyChainStuckMixed({ ...STUCK, hasAuthEl: true }), false, "auth element present");
  assert.strictEqual(applyChainStuckMixed({ ...STUCK, passwordInput: true }), false, "credential field present");
  assert.strictEqual(applyChainStuckMixed({ ...STUCK, formFieldCount: 4 }), false, "the form is up");
});
test("applyChainStuckMixed: tolerates a missing/blank state", () => {
  assert.strictEqual(applyChainStuckMixed(null), false);
  assert.strictEqual(applyChainStuckMixed({}), false);
});
