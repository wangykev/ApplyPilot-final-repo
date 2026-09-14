// Unit tests for sessionLooksDead (lib.js) — the M31 session-death classifier.
// CONSERVATIVE by design: a valid form — INCLUDING one showing ordinary validation
// errors — is NEVER dead (the false-positive guard).
//
// ⚠ The original claim in this header — "recon-proven that a live validation error has
// vpsErrorPresent=false" — was REFUTED live on 2026-09-14 (Marvell + Intel wd1). See the
// annotated VPS tests below; a live validation error CAN carry a VPS code, so VPS alone no
// longer proves death. The false-positive guard is unchanged and now covers that case too.
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

// ⚠⚠ 2026-09-14 — THE VPS ASSUMPTION WAS REFUTED LIVE, AND THIS TEST USED TO ASSERT IT.
// It read: VPS on an otherwise-valid form → dead. The Magna recon (one tenant, one pair) said VPS was
// false on a live validation error and true on a dead session, so trusting it alone looked safe.
// On Marvell and Intel wd1 an armed submit was blocked by an ordinary SIGNATURE-DATE validation error
// on a completely live page, and the operator read the banner off their own screen:
//
//     Error-Page Error
//     - Error Code: VPS|a3d970ea-cbce-4fec-b158-fc9de52b902e
//
// …then fixed it BY HAND by typing today's date, and the error cleared. A page a human repairs by
// filling one field is not an expired session. Three armed submits were abandoned as "session-expired",
// and that return also preempted the signature-date remediation that would have repaired the page.
// VPS is therefore EVIDENCE, not PROOF — it counts only once the form is no longer usable.
test("⚠⚠ VPS code on a LIVE apply form → ALIVE (the 2026-09-14 refutation)", () => {
  // Exactly the live shape: fields on screen, a footer Next to press, VPS banner showing.
  const vpsOnLiveForm = Object.assign({}, validForm, {
    vpsErrorPresent: true,
    errorMarkers: { count: 1, samples: ["Error-Page Error - Error Code: VPS|a3d970ea-cbce-4fec-b158-fc9de52b902e"] }
  });
  assert.strictEqual(sessionLooksDead(vpsOnLiveForm), false,
    "a VPS banner on a page the operator can still fill is a page error, not a dead session");
});

test("VPS error with NO usable form → dead (the case the recon actually saw)", () => {
  // The genuine post-Save & Continue expiry: the flow is gone, so there is nothing left to repair.
  assert.strictEqual(sessionLooksDead(Object.assign({}, validForm, {
    vpsErrorPresent: true, formFieldCount: 0, nextButtonPresent: false
  })), true);
  // …and fields with no footer Next is equally unusable.
  assert.strictEqual(sessionLooksDead(Object.assign({}, validForm, {
    vpsErrorPresent: true, nextButtonPresent: false
  })), true);
});

test("⚠ the OTHER death signals still fire even on a live-looking form", () => {
  // Narrowing VPS must not weaken the tests that actually catch a real expiry.
  assert.strictEqual(sessionLooksDead(Object.assign({}, validForm, { vpsErrorPresent: true, sessionBanner: true })), true);
  assert.strictEqual(sessionLooksDead(Object.assign({}, validForm, { vpsErrorPresent: true, authUrl: true })), true);
  assert.strictEqual(sessionLooksDead(Object.assign({}, validForm, { vpsErrorPresent: true, passwordInputPresent: true })), true);
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

// ── a FIELD-LESS page must still get a UNIQUE key (kiongroup.wd3 live 2026-08-09) ──
// A page with no flat fields has no identity in this scheme, and the pathname alone is shared by the
// whole apply flow — so every field-less page produced the byte-identical key "<path>|".
// accumulateBundle treats identical keys as the same physical page and DROPS the prior entries, so on
// kiongroup My Experience (legitimately field-less: every field is inside a repeating section) landed
// on the same key as My Information and OVERWROTE it. The bundle reached review with no
// name/address/country/source at all — 4 pages recorded for 5 filled — and the rehearsal halted
// `replay-page-not-in-bundle`, which is the only reason it was noticed.
test("cdpPageKey: two FIELD-LESS pages get DISTINCT keys (the walk ordinal breaks the tie)", () => {
  const url = "https://kiongroup.wd3.myworkdayjobs.com/en-US/KION_SCS/job/X/apply/autofillWithResume";
  const p1 = cdpPageKey({ url, fields: [] }, 1);
  const p2 = cdpPageKey({ url, fields: [] }, 2);
  assert.notStrictEqual(p1, p2, "two field-less pages must NOT share a key — the second overwrites the first");
  // stable across re-runs: the same page, same ordinal, same key (so a re-fill OVERWRITES, not duplicates)
  assert.strictEqual(cdpPageKey({ url, fields: [] }, 2), p2);
  // a page WITH fields is unaffected — the key stays the field-set, byte-identical to before
  const withFields = cdpPageKey({ url, fields: [{ fieldName: "country" }, { fieldName: "addressLine1" }] }, 1);
  assert.strictEqual(withFields, new URL(url).pathname + "|addressLine1,country");
  // and a field-less key can never collide with a real one
  assert.notStrictEqual(p1, withFields);
});

// The ordering that CAUSED it: the key was computed off a scan taken as the page was entered, BEFORE
// awaitFieldSetSettled, so on a slow tenant a page whose fields had not mounted read as field-less.
// Structural, because this is an ORDER bug — every unit test on cdpPageKey itself passed while the
// caller handed it an empty scan. Both lines live in fillAndPersistPage.
test("fillAndPersistPage computes the page key AFTER the field set has settled", () => {
  const fs = require("fs"), path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  const start = src.indexOf("async function fillAndPersistPage");
  assert.ok(start > 0, "could not find fillAndPersistPage");
  const body = src.slice(start, start + 12000);
  const settleAt = body.indexOf("await awaitFieldSetSettled(");
  const keyAt = body.indexOf("cdpPageKey(preScan");
  assert.ok(settleAt > 0, "fillAndPersistPage should settle the field set");
  assert.ok(keyAt > 0, "fillAndPersistPage should compute the page key from a scan");
  assert.ok(keyAt > settleAt,
    "the page key is computed BEFORE awaitFieldSetSettled, so a page whose fields have not mounted yet " +
    "keys as field-less and gets overwritten by the next field-less page (kiongroup.wd3, 2026-08-09)");
});
