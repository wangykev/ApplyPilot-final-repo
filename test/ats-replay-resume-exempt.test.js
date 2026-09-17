// test/ats-replay-resume-exempt.test.js — a FILE field is exempt from the replay's
// "no approved entry for this field" skip, for the same reason a credential is.
//
// LIVE FAILURE, Oracle "OCI Software Engineer Intern - OVIP", armed submit 2026-09-17:
//
//   [ATS-SUBMIT] résumé: removed "Kevin's Resume.pdf Remove" so it can be re-uploaded
//   [ATS-FILL]   resume-upload (file_upload, req) → skipped · no approved entry for this field
//
// …and the form was then submitted with NO résumé on a required slot, which the employer's own
// validation rejected. Operator: "this one just didn't attach a resume, everything else was fine
// so it errored when submit was pressed."
//
// ⚠ THE REMOVE-AND-REPLACE PASS MAKES THIS WORSE THAN A NO-OP. atsInjOrcResumeReset deliberately
// removes the attached résumé so the upload control comes back — its own comment says "after which
// the ORDINARY field loop attaches it". When the loop skips instead, the form goes from
// résumé-attached to résumé-absent. So this is not a missed optimisation; the reset actively
// destroys a good attachment unless the replace half can fire.
//
// WHY THE BUNDLE IS THE WRONG SOURCE, permanently: a bundle never carries file BYTES. The résumé
// comes from IndexedDB on every visit, exactly as a credential comes from storage on every visit —
// and the credential exemption sits on the very same line. The file branch further down already
// knows this (it ignores `v` and routes through atsRouteField, which maps exactly one field to the
// résumé); that routing was simply unreachable behind the early skip.
//
// And the name mismatch that triggers it will recur: ORC renders the ATTACHED state on a re-visit
// and the upload control only after the remove, so the field the replay meets (`resume-upload`)
// need not be the one the fill recorded.
//
// Run: node --test test/ats-replay-resume-exempt.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

// ⚠ `[^\r\n]*`, never `.*$` — CRLF checkout, and JS `.` does not match `\r`.
const strip = (t) => String(t)
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .split("\n").map((l) => l.replace(/\/\/[^\r\n]*/, "")).join("\n");
const src = strip(fs.readFileSync(path.join(__dirname, "..", "ats.js"), "utf8"));

test("⚠⚠ the replay's missing-entry skip exempts file fields", () => {
  assert.match(src, /if \(v === undefined && f\.widgetType !== "file_upload"\) \{[^\n]*no approved entry for this field/,
    "a file field must fall through to the résumé router instead of being skipped");
});

test("⚠ the exemption sits on the SAME guard the credential exemption does", () => {
  // Both are "the bundle is not the source of truth for this field" cases, and keeping them
  // together is what stops the next person reinstating a bare `v === undefined` skip.
  const i = src.indexOf('if (o.valueFor && !atsCredentialKind(ats, f))');
  assert.ok(i > 0, "the replay branch must still exempt credentials on its condition");
  const near = src.slice(i, i + 900);
  assert.match(near, /f\.widgetType !== "file_upload"/,
    "the file exemption belongs in the same guard block as the credential one");
});

test("⚠⚠ a file field still reaches the RÉSUMÉ ROUTER, which is what prevents a mis-file", () => {
  // The exemption must not become "attach to every file field". Greenhouse renders the cover letter
  // as a file dropzone too, and attaching the résumé there files the wrong document to the employer
  // with no gate catching it. The router maps exactly one field to the résumé.
  const i = src.indexOf('if (f.widgetType === "file_upload") {');
  assert.ok(i > 0, "the file branch must exist");
  const body = src.slice(i, i + 700);
  assert.match(body, /atsRouteField\(ats, f, profile, defaults, jc, bucketIndex, o\.credentials\)/);
  assert.match(body, /fr && fr\.kind === "resume"/, "only the routed résumé slot gets the file");
  assert.match(body, /kind: "skip"/, "every other file field is still left alone");
});

test("⚠ a NON-résumé file field is still not actuated — just refused one line later", () => {
  const i = src.indexOf('if (f.widgetType === "file_upload") {');
  const body = src.slice(i, i + 700);
  assert.match(body, /a file field that is not the r[eé]sum[eé] — left to the operator/,
    "the truer reason replaces 'no approved entry for this field' for file fields");
});

test("⚠⚠ the ORC reset still exists and still explains that the FIELD LOOP does the attaching", () => {
  // This test is the link between the two halves. If someone removes the reset, the exemption above
  // is harmless; if someone removes the exemption, the reset silently destroys the attachment again.
  // Pinning the pairing is the point.
  assert.match(src, /async function atsInjOrcResumeReset/);
  const raw = fs.readFileSync(path.join(__dirname, "..", "ats.js"), "utf8");
  assert.match(raw, /brings the file input back, after which the ORDINARY field loop attaches it/,
    "the reset's contract with the field loop must stay written down");
});
