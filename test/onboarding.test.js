// Unit tests for the onboarding-stage PURE decisions in lib.js (the JD → Apply →
// Apply Manually → auth → verify flow). The DOM driving is in the SW; these pin the
// decisions that must not regress: the Apply-button priority, the sign-in outcome
// classifier, the Workday soft-error (refresh) detector, and SSO detection.
const { test } = require("node:test");
const assert = require("node:assert");
const { pickApplyTarget, classifyAuthOutcome, isWorkdaySoftError, looksLikeSso, isAlreadyApplied, jobPageSettleStep, isBlankAuthPage } = require("../lib.js");

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
