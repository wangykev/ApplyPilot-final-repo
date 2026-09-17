// test/ats-orc-confirmation.test.js — Oracle's confirmation screen must READ as a confirmation.
//
// LIVE 2026-09-17, Oracle "OCI Software Engineer Intern - OVIP", armed submit. The application was
// FILED, and the run reported stopped:"validation-errors" anyway:
//
//   [ATS-SUBMIT] submit refused — validation errors:
//   [ATS-SUBMIT]   · You're all set, Kevin!
//   [ATS-SUBMIT]   · Saving candidate info Saving job application info
//   [ATS-SUBMIT]   · Saved
//
// Those are the SUCCESS page's own words. The outcome loop already checks confirmation FIRST and
// errors LAST, with a comment saying why — but that ordering only helps if success is recognised.
// `confirmed` only knew "thank you for applying" / "application submitted|received" wordings, none
// of which ORC uses, so the loop fell through to the error read. That read matches `[role="alert"]`,
// and ORC announces save progress through ARIA live regions.
//
// The cost is not cosmetic: reportApplication never runs on a non-submit, so the tracker row stayed
// `needs_review` for an application that had been filed — a filed application that looks unsent,
// which is exactly the duplicate-application hazard.
//
// Same rule this repo already paid for on Workday's résumé upload: role="alert" is the STATUS
// channel, NOT an error channel.
//
// ⚠ THE DANGEROUS DIRECTION IS INVERTED HERE, which is why the detection is deliberately strict. A
// false "confirmed" reports an application as filed when it is not, and the operator then never
// re-applies — a silently lost application. A false refusal only costs a retry. So: two signals,
// and scoped to oracle.
//
// Run: node --test test/ats-orc-confirmation.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const ats = require("../ats.js");

// Drive the real injected function with a fake document, the way test/ats-ashby-checkbox-group.test.js
// executes atsInjScan rather than stubbing it.
function runSubmitState(bodyText, { atsName = "oracle", withSubmit = false, href = "https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/334325/apply/section/4" } = {}) {
  const els = [];
  if (withSubmit) {
    els.push({
      tagName: "BUTTON", textContent: "Submit", disabled: false,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ x: 10, y: 10, width: 120, height: 40, top: 10, bottom: 50, left: 10, right: 130 }),
    });
  }
  const doc = {
    body: { innerText: bodyText },
    querySelectorAll: () => els,
    querySelector: () => null,
    getElementById: () => null,
  };
  const g = {
    document: doc,
    location: { href },
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    innerHeight: 900,
  };
  // atsInjSubmitState runs page-side, so hand it exactly the globals it reaches for. `with` is the
  // simplest faithful way to do that for a stringified injected function.
  const wrapped = new Function(
    "g", "atsName",
    `with (g) { return (${ats.atsInjSubmitState.toString()})(atsName); }`
  );
  return wrapped(g, atsName);
}

const ORC_SUCCESS = "You're all set, Kevin! Saving candidate info Saving job application info Saved";

test("⚠⚠ ORC's success screen reads as CONFIRMED, not as validation errors", () => {
  const s = runSubmitState(ORC_SUCCESS);
  assert.strictEqual(s.confirmed, true,
    "\"You're all set\" + the save announcement is Oracle's confirmation");
});

test("⚠⚠ it is SCOPED to oracle — the same words elsewhere prove nothing", () => {
  // A generic page that happens to say "you're all set" must not be read as a filed application.
  const s = runSubmitState(ORC_SUCCESS, { atsName: "greenhouse" });
  assert.strictEqual(s.confirmed, false);
});

test("⚠⚠ the completion phrase ALONE is not enough — it needs corroboration", () => {
  // Still offering a live Submit, and no save announced: the form is not done with us.
  const s = runSubmitState("You're all set, Kevin! Review your application before submitting.", { withSubmit: true });
  assert.strictEqual(s.confirmed, false,
    "a page still offering Submit and announcing no save is not a confirmation");
});

test("the save announcement corroborates even while a Submit button lingers", () => {
  const s = runSubmitState(ORC_SUCCESS, { withSubmit: true });
  assert.strictEqual(s.confirmed, true);
});

test("⚠ an ORC page mid-application is NOT confirmed", () => {
  const s = runSubmitState("Step 4 of 4 Voluntary self-identification Submit", { withSubmit: true });
  assert.strictEqual(s.confirmed, false);
});

test("⚠ the generic wordings are untouched (no regression for the other platforms)", () => {
  for (const [name, body] of [
    ["greenhouse", "Thank you for applying to Whatnot."],
    ["lever", "Your application has been submitted."],
    ["ashby", "We have received your application."],
  ]) {
    const s = runSubmitState(body, { atsName: name });
    assert.strictEqual(s.confirmed, true, `${name} must still confirm on its own wording`);
  }
});

// ── the ordering this depends on must stay ───────────────────────────────────────────────────────

test("⚠⚠ the outcome loop still checks CONFIRMATION before it reads errors", () => {
  // The whole fix rests on this order: success is positive evidence and must win over an error
  // sweep that matches role="alert". If someone reorders these, ORC regresses silently.
  const strip = (t) => String(t)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/\/\/[^\r\n]*/, "")).join("\n");
  const bg = strip(fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8"));
  const conf = bg.indexOf("if (s2 && s2.confirmed)");
  const errs = bg.indexOf("const errs = await cdpEval(atsInjErrors, ats)");
  assert.ok(conf > 0 && errs > 0, "both checks must exist in the submit outcome loop");
  assert.ok(conf < errs, "confirmation must be checked BEFORE the validation-error read");
});
