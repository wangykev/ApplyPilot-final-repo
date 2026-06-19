// Unit tests for sessionLooksDead (lib.js) — the M31 session-death classifier.
// CONSERVATIVE by design: a valid form — INCLUDING one showing ordinary validation
// errors — is NEVER dead (the false-positive guard; recon-proven that a live
// validation error has vpsErrorPresent=false).
const { test } = require("node:test");
const assert = require("node:assert");
const { sessionLooksDead, cdpPageKey } = require("../lib.js");

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
