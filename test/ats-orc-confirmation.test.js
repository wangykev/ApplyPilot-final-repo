// test/ats-orc-confirmation.test.js — status announcements are not validation errors, and
// "You're all set" is NOT a confirmation.
//
// Every fixture below is REAL TEXT captured from live armed submits on 2026-09-15/17, taken from the
// seven "submit refused — validation errors:" blocks in the service-worker log. That matters: my
// first attempt at this fix was built on ONE observation and was wrong.
//
// ── what the seven blocks actually showed ───────────────────────────────────────────────────────
// Three distinct shapes, not one:
//   (a) genuine, actionable failures — a spam flag, a missing required field, a location that must be
//       picked from the dropdown, "This info is required. (1 issue)"
//   (b) pure PROGRESS text — "You're all set, Kevin!", "Saving candidate info…", "Saved"
//   (c) ⚠ BOTH AT ONCE — progress text sitting right next to "Your application couldn't be
//       submitted. Try again."
//
// (c) is the one that refutes the tempting fix. I had added an oracle branch treating "you're all
// set" + "Saved" as a confirmation; shape (c) proves those lines co-occur with explicit failure, so
// they are the final step's heading and a section-save announcement — not acceptance. Reporting that
// as `confirmed` would mark a FAILED application as filed, and the operator would never re-apply.
// A silently lost application is worse than a refusal they can retry, so nothing was added to
// `confirmed`; an ambiguous ORC page correctly falls to the loop's `no-confirmation` halt.
//
// What DID need fixing is the error read: role="alert" is the STATUS channel, not an error channel —
// the same rule this repo already paid for on Workday's résumé upload, never applied to this path.
//
// Run: node --test test/ats-orc-confirmation.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const ats = require("../ats.js");

// Execute the REAL injected functions against a fake document, rather than stubbing them.
function fakeDoc(texts) {
  const els = texts.map((t) => ({
    textContent: t,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 400, height: 24 }),
  }));
  return { body: { innerText: texts.join(" ") }, querySelectorAll: () => els, querySelector: () => null, getElementById: () => null };
}
function runErrors(texts, atsName = "oracle") {
  const g = { document: fakeDoc(texts), location: { href: "https://eeho.fa.us2.oraclecloud.com/x" } };
  const f = new Function("g", "atsName", `with (g) { return (${ats.atsInjErrors.toString()})(atsName); }`);
  return f(g, atsName).errors;
}
function runSubmitState(bodyText, atsName = "oracle", href = "https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/334325/apply/section/4") {
  const g = {
    document: { body: { innerText: bodyText }, querySelectorAll: () => [], querySelector: () => null, getElementById: () => null },
    location: { href },
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    innerHeight: 900,
  };
  const f = new Function("g", "atsName", `with (g) { return (${ats.atsInjSubmitState.toString()})(atsName); }`);
  return f(g, atsName);
}

// ── (b) PURE PROGRESS — must produce NO errors ───────────────────────────────────────────────────

test("⚠⚠ ORC's progress announcements are not validation errors", () => {
  const errs = runErrors([
    "You're all set, Kevin!",
    "Saving candidate info Saving job application info",
    "Saved",
  ]);
  assert.deepStrictEqual(errs, [],
    "role=alert is the STATUS channel — a refusal built from progress text is evidence of nothing");
});

// ── (c) THE REFUTATION — progress text WITH a real failure must still report the failure ─────────

test("⚠⚠ a real failure in the SAME live region is still reported", () => {
  const errs = runErrors([
    "You're all set, Kevin!",
    "Creating candidate info Saving job application info",
    "Your application couldn't be submitted. Try again.",
    "Saved",
  ]);
  assert.strictEqual(errs.length, 1, "exactly the failure line survives");
  assert.match(errs[0], /couldn't be submitted/);
});

// ── (a) GENUINE FAILURES — every captured shape must survive the filter ──────────────────────────

test("⚠ every genuine failure captured live is still reported", () => {
  for (const t of [
    "We couldn't submit your applicationYour application submission was flagged as possible spam. If you believe this was a mistake, please submit your application again.",
    "Your form needs correctionsMissing entry for required field: Where do you plan on working from (for payroll tax purposes)?",
    "✱ Error: Please select a location from the dropdown menu and try again.",
    "This info is required. (1 issue)",
    "You need to add or modify some info before submitting your job application.",
  ]) {
    assert.deepStrictEqual(runErrors([t]), [t], `must keep: ${t.slice(0, 48)}`);
  }
});

test("⚠ the status filter needs BOTH halves — a status-leading line that names a failure is kept", () => {
  // "Saving…" that reports a problem is not progress. Dropping on the lead alone would swallow it.
  const errs = runErrors(["Saving failed — required field missing"]);
  assert.strictEqual(errs.length, 1, "a failure cue overrides the status lead");
});

// ── "You're all set" must NOT be a confirmation ──────────────────────────────────────────────────

// ── ORC confirmation: the VERIFIED pair ─────────────────────────────────────────────────────────
// These two are the same page, one filed and one not, differing by exactly one line. The filed one
// was verified independently in Oracle's own candidate portal ("OCI Software Engineer Intern - OVIP
// … Oracle 334325 Applied on 09/17/2026, Status New") plus the confirmation email — that external
// check is what licenses detecting this at all.

test("⚠⚠ the FILED ORC page confirms (save sequence, no failure anywhere)", () => {
  const s = runSubmitState("You're all set, Kevin! Saving candidate info Saving job application info Saved");
  assert.strictEqual(s.confirmed, true, "verified filed: Applied on 09/17/2026 in Oracle's portal");
});

test("⚠⚠ the NOT-FILED ORC page does NOT confirm — the failure line is the discriminator", () => {
  const s = runSubmitState("You're all set, Kevin! Creating candidate info Saving job application info "
    + "Your application couldn't be submitted. Try again. Saved");
  assert.strictEqual(s.confirmed, false,
    "same completion + save text; only the failure line differs, so the negative half is load-bearing");
});

test("⚠ the completion phrase alone, with no save announced, is not a confirmation", () => {
  assert.strictEqual(runSubmitState("You're all set, Kevin! Review your application.").confirmed, false);
});

test("⚠ every genuine ORC failure still blocks confirmation", () => {
  for (const f of [
    "Your application submission was flagged as possible spam.",
    "Your form needs corrections Missing entry for required field: Where do you plan on working from?",
    "Error: Please select a location from the dropdown menu and try again.",
    "This info is required. (1 issue)",
    "You need to add or modify some info before submitting your job application.",
  ]) {
    assert.strictEqual(runSubmitState("You're all set, Kevin! Saved " + f).confirmed, false,
      `must not confirm alongside: ${f.slice(0, 44)}`);
  }
});

test("⚠⚠ it is SCOPED to oracle — the same words on another ATS prove nothing", () => {
  assert.strictEqual(runSubmitState("You're all set, Kevin! Saved", "greenhouse").confirmed, false);
});

test("⚠ the generic confirmation wordings are untouched", () => {
  assert.strictEqual(runSubmitState("Thank you for applying to Whatnot.", "greenhouse").confirmed, true);
  assert.strictEqual(runSubmitState("Your application has been submitted.", "lever").confirmed, true);
  assert.strictEqual(runSubmitState("We have received your application.", "ashby").confirmed, true);
  assert.strictEqual(runSubmitState("Step 4 of 4 Voluntary self-identification").confirmed, false);
});

// ── the ordering the whole design rests on ───────────────────────────────────────────────────────

test("⚠⚠ the outcome loop still checks CONFIRMATION before it reads errors", () => {
  const strip = (t) => String(t)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/\/\/[^\r\n]*/, "")).join("\n");
  const bg = strip(fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8"));
  const conf = bg.indexOf("if (s2 && s2.confirmed)");
  const errs = bg.indexOf("const errs = await cdpEval(atsInjErrors, ats)");
  assert.ok(conf > 0 && errs > 0, "both checks must exist in the submit outcome loop");
  assert.ok(conf < errs, "confirmation must be checked BEFORE the validation-error read");
});
