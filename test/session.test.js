// Unit tests for sessionLooksDead (lib.js) — the M31 session-death classifier.
// CONSERVATIVE by design: a valid form — INCLUDING one showing ordinary validation
// errors — is NEVER dead (the false-positive guard; recon-proven that a live
// validation error has vpsErrorPresent=false).
const { test } = require("node:test");
const assert = require("node:assert");
const { sessionLooksDead, isWorkdayMaintenance, looksLikeWorkdaySoftError, cdpPageKey } = require("../lib.js");

// The live-reconned Workday planned-maintenance page (2026-06-27, see dom-patterns).
const maintenancePage = {
  title: "Workday is currently unavailable.",
  formFieldCount: 0, applyFlowPagePresent: false,
  passwordInputPresent: false, signInButtonPresent: false, authUrl: false,
  sessionBanner: false, vpsErrorPresent: false, maintenancePresent: true,
  bodyTextSample: "English Workday is currently unavailable. Workday is performing planned maintenance during the following period:"
};

// The recon-captured valid-form baseline (Magna My Information).
const validForm = {
  formFieldCount: 14, applyFlowPagePresent: true, applyFlowReviewPresent: false,
  nextButtonPresent: true, passwordInputPresent: false, signInButtonPresent: false,
  authUrl: false, sessionBanner: false, vpsErrorPresent: false
};

test("sessionLooksDead: valid form → alive", () => {
  assert.strictEqual(sessionLooksDead(validForm), false);
});

test("sessionLooksDead: valid form with an ordinary VALIDATION error → alive (THE false-positive guard)", () => {
  // Recon: a required field empty → "…is required" + an "Errors Found" banner, but
  // vpsErrorPresent=false. Must NOT classify dead (would cost a good user their session).
  const validationError = Object.assign({}, validForm, {
    errorMarkers: { count: 1, samples: ["The field How Did You Hear About Us? is required and must have a value."] },
    errorPageText: null
  });
  assert.strictEqual(sessionLooksDead(validationError), false);
});

test("sessionLooksDead: VPS error (dead session, post Save & Continue) → dead", () => {
  assert.strictEqual(sessionLooksDead(Object.assign({}, validForm, { vpsErrorPresent: true })), true);
});

test("sessionLooksDead: explicit session banner → dead", () => {
  assert.strictEqual(sessionLooksDead(Object.assign({}, validForm, { sessionBanner: true })), true);
});

test("sessionLooksDead: login / redirect markers → dead", () => {
  assert.strictEqual(sessionLooksDead(Object.assign({}, validForm, { passwordInputPresent: true })), true);
  assert.strictEqual(sessionLooksDead(Object.assign({}, validForm, { signInButtonPresent: true })), true);
  assert.strictEqual(sessionLooksDead(Object.assign({}, validForm, { authUrl: true })), true);
});

test("sessionLooksDead: no form at all (hard redirect / blank page) → dead", () => {
  assert.strictEqual(sessionLooksDead({ formFieldCount: 0, applyFlowPagePresent: false }), true);
});

test("sessionLooksDead: 0 fields BUT the applyFlow page shell is present → alive (conservative)", () => {
  assert.strictEqual(sessionLooksDead({ formFieldCount: 0, applyFlowPagePresent: true }), false);
});

test("sessionLooksDead: null / undefined → alive (never dead on missing data)", () => {
  assert.strictEqual(sessionLooksDead(null), false);
  assert.strictEqual(sessionLooksDead(undefined), false);
});

// 2026-06-27 — isWorkdayMaintenance: the planned-maintenance page is a TRANSIENT retry-later state,
// NOT a dead session. It MUST be detected before sessionLooksDead (which says "dead" on no-form).
test("isWorkdayMaintenance: the live maintenance page → true (and sessionLooksDead would MISreport it dead)", () => {
  assert.strictEqual(isWorkdayMaintenance(maintenancePage), true);
  assert.strictEqual(sessionLooksDead(maintenancePage), true, "no-form → sessionLooksDead says dead; the maintenance check MUST run first in the walk");
});

test("isWorkdayMaintenance: detects via title/body even without the maintenancePresent marker", () => {
  assert.strictEqual(isWorkdayMaintenance(Object.assign({}, maintenancePage, { maintenancePresent: false })), true);
});

test("isWorkdayMaintenance: a valid form (or one with the text matched somewhere) is NEVER maintenance", () => {
  assert.strictEqual(isWorkdayMaintenance(validForm), false);
  assert.strictEqual(isWorkdayMaintenance(Object.assign({}, validForm, { maintenancePresent: true })), false, "formFieldCount>0 guard wins");
});

test("isWorkdayMaintenance: a login redirect → NOT maintenance (falls through to sessionLooksDead)", () => {
  assert.strictEqual(isWorkdayMaintenance({ formFieldCount: 0, passwordInputPresent: true, maintenancePresent: true }), false);
  assert.strictEqual(isWorkdayMaintenance({ formFieldCount: 0, signInButtonPresent: true, bodyTextSample: "sign in to continue" }), false);
});

test("isWorkdayMaintenance: a blank / hard-redirect dead session (no maintenance text) → NOT maintenance", () => {
  assert.strictEqual(isWorkdayMaintenance({ formFieldCount: 0, title: "", bodyTextSample: "" }), false);
});

test("isWorkdayMaintenance: null / undefined → false", () => {
  assert.strictEqual(isWorkdayMaintenance(null), false);
  assert.strictEqual(isWorkdayMaintenance(undefined), false);
});

// 2026-07-17 — looksLikeWorkdaySoftError: Workday's TRANSIENT "Something went wrong / Please refresh the
// page and then try again." page. Live-reconned on Magna wd3 right after login (title "Create Account",
// an <h1>Something went wrong</h1>, formFieldCount 0, BUT the applyFlowPage shell still present). The
// walks reload (→ page 1) + restart. cdpReadSessionState computes `softErrorPresent` off the FULL bodyText
// because the 500-char bodyTextSample can truncate right BEFORE the "Something went wrong" line.
const softErrorPage = {
  title: "Create Account",
  formFieldCount: 0, applyFlowPagePresent: true, applyFlowReviewPresent: false,
  nextButtonPresent: false, passwordInputPresent: false, signInButtonPresent: false, authUrl: false,
  sessionBanner: false, vpsErrorPresent: false, maintenancePresent: false, softErrorPresent: true,
  // the sample is truncated by the cookie banner + step nav BEFORE "Something went wrong" — proving the marker (not the sample) is load-bearing
  bodyTextSample: "Skip to main content This site uses cookies from MAGNA and third parties for our own business purposes and to personalize your experience. By using this site, you agree to the use of cookies. For more information, visit MAGNA Cookies Policy Decline Accept Cookies English Settings Visit Magna.com Search for Jobs Candidate Home Job Alerts Back to Job Posting"
};

test("looksLikeWorkdaySoftError: the live recon page (softErrorPresent marker) → true", () => {
  assert.strictEqual(looksLikeWorkdaySoftError(softErrorPage), true);
});

test("looksLikeWorkdaySoftError: relies on the marker, NOT the truncated 500-char sample", () => {
  // The sample does NOT contain "Something went wrong" (truncated) — detection must still succeed via the marker.
  assert.ok(!/something went wrong/i.test(softErrorPage.bodyTextSample), "the sample is genuinely truncated before the phrase");
  assert.strictEqual(looksLikeWorkdaySoftError(softErrorPage), true);
});

test("looksLikeWorkdaySoftError: text fallback for a caller carrying only bodyText (no marker)", () => {
  assert.strictEqual(looksLikeWorkdaySoftError({ bodyText: "Something went wrong Please refresh the page and then try again." }), true);
  assert.strictEqual(looksLikeWorkdaySoftError({ bodyText: "Something went wrong with this field." }), false, "apology alone (no refresh cue) is not a soft-error page");
});

test("looksLikeWorkdaySoftError: a valid form / maintenance / null → false", () => {
  assert.strictEqual(looksLikeWorkdaySoftError(validForm), false);
  assert.strictEqual(looksLikeWorkdaySoftError(maintenancePage), false, "maintenance is its own transient state, not the soft-error page");
  assert.strictEqual(looksLikeWorkdaySoftError(null), false);
  assert.strictEqual(looksLikeWorkdaySoftError(undefined), false);
});

test("ORDERING INVARIANT: the soft-error check MUST run before sessionLooksDead", () => {
  // On the observed page applyFlowPage IS present, so sessionLooksDead is false (it would proceed to
  // fill a 0-field page / halt at no-next-button). But a soft-error page that LACKS the shell reads as a
  // dead session — so the walk checks looksLikeWorkdaySoftError first (reload+restart), never re-login.
  assert.strictEqual(sessionLooksDead(softErrorPage), false, "with the applyFlowPage shell it is not 'dead' — but also not a real page → must reload");
  const softErrorNoShell = Object.assign({}, softErrorPage, { applyFlowPagePresent: false });
  assert.strictEqual(sessionLooksDead(softErrorNoShell), true, "without the shell, sessionLooksDead MISreads it dead → the soft-error check MUST win by running first");
  assert.strictEqual(looksLikeWorkdaySoftError(softErrorNoShell), true, "the soft-error check still fires → reload+restart, not a bogus re-login");
});

// M38 Part 2 — cdpPageKey: the STABLE per-page accumulation merge key.
test("cdpPageKey: STABLE across a volatile query change (same pathname + field-set → same key)", () => {
  const fields = [{ fieldName: "jobTitle" }, { fieldName: "companyName" }];
  const a = cdpPageKey({ url: "https://x.myworkdaysite.com/apply?utm_source=Simplify&t=111", fields });
  const b = cdpPageKey({ url: "https://x.myworkdaysite.com/apply?utm_source=Other&t=999", fields }); // query changed
  assert.strictEqual(a, b, "query/token changes must NOT change the key (no duplicate accumulation)");
  assert.ok(!a.includes("utm_source") && !a.includes("t="), "query dropped");
});

test("cdpPageKey: DISTINCT across pages on the SAME pathname (SPA — the field-set discriminates)", () => {
  const url = "https://x.myworkdaysite.com/apply"; // same pathname (SPA reuses the URL)
  const page1 = cdpPageKey({ url, fields: [{ fieldName: "legalName--firstName" }, { fieldName: "country" }] });
  const page2 = cdpPageKey({ url, fields: [{ fieldName: "jobTitle" }, { fieldName: "companyName" }] });
  assert.notStrictEqual(page1, page2, "different field-sets on the same URL must NOT overwrite each other");
});

test("cdpPageKey: field ORDER doesn't matter (sorted) + null on missing data", () => {
  const url = "https://x/apply";
  assert.strictEqual(
    cdpPageKey({ url, fields: [{ fieldName: "b" }, { fieldName: "a" }] }),
    cdpPageKey({ url, fields: [{ fieldName: "a" }, { fieldName: "b" }] })
  );
  assert.strictEqual(cdpPageKey(null), null);
  assert.strictEqual(cdpPageKey({ url }), null); // no fields
});
