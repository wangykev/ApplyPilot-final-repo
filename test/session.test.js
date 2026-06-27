// Unit tests for sessionLooksDead (lib.js) — the M31 session-death classifier.
// CONSERVATIVE by design: a valid form — INCLUDING one showing ordinary validation
// errors — is NEVER dead (the false-positive guard; recon-proven that a live
// validation error has vpsErrorPresent=false).
const { test } = require("node:test");
const assert = require("node:assert");
const { sessionLooksDead, isWorkdayMaintenance, cdpPageKey } = require("../lib.js");

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
