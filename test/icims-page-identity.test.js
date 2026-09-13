// test/icims-page-identity.test.js — one physical page must be ONE page in the bundle, and a
// missing PAGE is fatal where a missing field is not.
//
// Traced live 2026-09-13 on RoviSys. The submit gate refused with two approved fields reporting
// "approved value has NO matching field on the live form", and the first reading — that the form had
// stopped rendering them — was wrong. The bundle had recorded "Candidate Profile" TWICE:
//
//   key A — 16 entries, `-1_PersonProfileFields.*`      (fresh candidate: positional ordinals)
//   key B — 18 entries, `104321_…` / `112435_…`         (saved rows: server ordinals) + rcf3048/9
//
// 34 entries for a page with 16 boxes. iCIMS prefixes repeating-entry fields with an ordinal and
// that ordinal CHANGES once the account exists, so the two scans shared only the 7 unprefixed names
// — 7/16 = 0.44, just under samePhysicalPage's 0.5 bar. The page did not change; its field NAMES
// did, and the accumulator therefore kept both. At submit time only one can exist.
//
// ⚠ The operator's rule for what remains: "if a field or two dissapears, it is fine, but we need to
// make sure an entire page does not dissapear."
//
// Run: node --test test/icims-page-identity.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { samePhysicalPage } = require("../fill-driver.js");

const PATH = "/jobs/2142/engineering-co-op---spring-2027/candidate";
// The two keys exactly as the live bundle carried them (sorted field-name sets).
const FRESH = PATH + "|" + [
  "-1_PersonProfileFields.AddressCity", "-1_PersonProfileFields.AddressCountry",
  "-1_PersonProfileFields.AddressState", "-1_PersonProfileFields.AddressStreet1",
  "-1_PersonProfileFields.AddressStreet2", "-1_PersonProfileFields.AddressType",
  "-1_PersonProfileFields.AddressZip", "-1_PersonProfileFields.PhoneNumber",
  "-1_PersonProfileFields.PhoneType", "PersonProfileFields.Email",
  "PersonProfileFields.FirstName", "PersonProfileFields.LastName", "PersonProfileFields.Login",
  "PersonProfileFields.Password", "PersonProfileFields.Password_Confirm",
  "PortalProfileFields.Resume_File",
].join(",");
const SAVED = PATH + "|" + [
  "104321_PersonProfileFields.AddressCity", "104321_PersonProfileFields.AddressCountry",
  "104321_PersonProfileFields.AddressState", "104321_PersonProfileFields.AddressStreet1",
  "104321_PersonProfileFields.AddressStreet2", "104321_PersonProfileFields.AddressType",
  "104321_PersonProfileFields.AddressZip", "112435_PersonProfileFields.PhoneNumber",
  "112435_PersonProfileFields.PhoneType", "PersonProfileFields.Email",
  "PersonProfileFields.FirstName", "PersonProfileFields.LastName", "PersonProfileFields.Login",
  "PersonProfileFields.Password", "PersonProfileFields.Password_Confirm",
  "PortalProfileFields.Resume_File", "rcf3048", "rcf3049",
].join(",");

test("⚠⚠ the same page scanned before and after the account exists is ONE page", () => {
  // Without the bare-name comparison this is 7/16 = 0.44 and the bundle keeps both copies.
  assert.strictEqual(samePhysicalPage(FRESH, SAVED), true);
  assert.strictEqual(samePhysicalPage(SAVED, FRESH), true, "and symmetrically");
});

test("⚠ an ordinal is not part of a field's identity", () => {
  const a = "/p|-1_X.City,-1_X.Zip,Y.Name";
  const b = "/p|998877_X.City,998877_X.Zip,Y.Name";
  assert.strictEqual(samePhysicalPage(a, b), true);
});

test("⚠⚠ genuinely different pages still do NOT merge", () => {
  // The M31 discriminator has to survive: same pathname, disjoint field sets.
  const eeo = PATH + "|CandProfileFields.Disability,CandProfileFields.Gender,CandProfileFields.Race,CandProfileFields.Veteran";
  assert.strictEqual(samePhysicalPage(FRESH, eeo), false);
  assert.strictEqual(samePhysicalPage(SAVED, eeo), false);
  // a different pathname is never the same page, however similar the fields
  assert.strictEqual(samePhysicalPage(FRESH, FRESH.replace("/candidate", "/questions")), false);
  // and stripping ordinals must not collapse two pages that merely share a couple of names
  assert.strictEqual(samePhysicalPage("/p|-1_A,-2_B,-3_C,-4_D", "/p|-9_A,Z1,Z2,Z3"), false);
});

test("a field-less key still matches only itself", () => {
  assert.strictEqual(samePhysicalPage("P1", "P1"), true);
  assert.strictEqual(samePhysicalPage("P1", "P2"), false);
  assert.strictEqual(samePhysicalPage(null, "P1"), false);
});

// ── the submit gate's absence rule ──────────────────────────────────────────────────────────────

const strip = (t) => String(t)
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .split("\n").map((l) => l.replace(/\/\/[^\r\n]*/, "")).join("\n");
const bg = strip(fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8"));

test("⚠⚠ a whole missing PAGE is fatal; a few missing fields are not", () => {
  // Operator, 2026-09-13. A form legitimately stops rendering the odd box between fill and submit
  // (a question asked once per candidate, a conditional whose parent now answers differently) — that
  // is the form saying "I am not asking this". A whole page absent means the run never reached that
  // step, and submitting then files an application missing everything on it.
  const i = bg.indexOf("const missByPage");
  assert.ok(i > 0, "the absence check must group by page");
  const fn = bg.slice(i, i + 1800);
  assert.match(fn, /g\.missing\.length === g\.total/, "ALL of a page's approved fields gone ⇒ fatal");
  assert.match(fn, /failures\.push\(`the whole /, "…and that is a gate failure, by name");
  // the partial case must be REPORTED, not silently dropped
  assert.match(fn, /tolerated because the rest of the page IS there/);
  assert.match(fn, /LOG\(/, "a tolerated absence still has to be visible to the operator");
});

test("⚠ the page grouping uses the BUNDLE's own page key, not a guess", () => {
  const i = bg.indexOf("const missByPage");
  const fn = bg.slice(i, i + 600);
  assert.match(fn, /String\(e\.page \|\| "\?"\)/, "the form's own page identity decides what 'a page' is");
});
