// Unit tests for the onboarding-stage PURE decisions in lib.js (the JD → Apply →
// Apply Manually → auth → verify flow). The DOM driving is in the SW; these pin the
// decisions that must not regress: the Apply-button priority, the sign-in outcome
// classifier, the Workday soft-error (refresh) detector, and SSO detection.
const { test } = require("node:test");
const assert = require("node:assert");
const { pickApplyTarget, classifyAuthOutcome, isWorkdaySoftError, looksLikeSso } = require("../lib.js");

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
test("looksLikeSso: a social-login chooser with a 'Sign in with email' button → NOT sso", () => {
  // Palo Alto Networks variant: Apple/Google/LinkedIn buttons + SignInWithEmailButton, no form yet.
  assert.strictEqual(looksLikeSso({ url: "https://paloaltonetworks.wd5.myworkdayjobs.com/…/applyManually", signInButtonPresent: true, emailInput: false, passwordInput: false, signInWithEmail: true }), false);
});
