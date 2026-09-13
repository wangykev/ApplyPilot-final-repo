// test/ats-salary-digits.test.js — the form states its own format rule; read that, don't guess it.
//
// Live 2026-09-10, RoviSys (iCIMS), step 2 of 4:
//   "2. Please state your desired gross annual salary.: Please enter a number using only the digits
//    0 to 9 with a value between 0 and 300000. Do not include any commas, decimals, or currency
//    symbols."
// The walk halted two steps early with a PARTIAL bundle, so one formatting mismatch cost the rest
// of the application.
//
// ⚠ THE FIRST FIX WAS THE WRONG SHAPE and is recorded here because the reasoning matters. It
// recognised the QUESTION ("desired … salary") and rewrote the value at both write seams. That
// works exactly as far as someone enumerated phrasings — and the operator's objection is decisive:
// "there are many ways to ask the same question." The REJECTION, by contrast, states the rule
// outright, names its field, and arrives precisely when it is needed. So format handling is
// error-driven now, and the label recognizer survives only for the POLICY rung (refusing to invent
// a salary), which is a judgement about the VALUE that no error message can supply.
//
// Run: node --test test/ats-salary-digits.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const {
  atsIsSalaryAmountField, atsSalaryDigits,
  atsErrorDemand, atsMatchErrorToField, atsValueForDemand,
} = require("../ats.js");

// ── reading the form's demand out of its own error ──────────────────────────────────────────────

const LIVE_ERR = "2. Please state your desired gross annual salary.: Please enter a number using "
  + "only the digits 0 to 9 with a value between 0 and 300000. Do not include any commas, "
  + "decimals, or currency symbols.";

test("⚠ the live error is read as a digits demand, with its stated bounds", () => {
  const d = atsErrorDemand(LIVE_ERR);
  assert.strictEqual(d.kind, "digits");
  assert.strictEqual(d.min, 0);
  assert.strictEqual(d.max, 300000);
});

test("the same demand phrased many other ways is still recognised", () => {
  // This is the point of the redesign: one rule, many phrasings — of the ERROR, which is a far
  // smaller and more stereotyped space than the space of questions.
  for (const t of [
    "Numbers only, please.",
    "Please enter only digits.",
    "Enter a whole number.",
    "Do not include any commas or currency symbols.",
    "This field accepts only the numbers 0-9.",
  ]) {
    assert.strictEqual(atsErrorDemand(t).kind, "digits", t);
  }
});

test("a required-and-empty complaint is its own kind, not a format rule", () => {
  assert.strictEqual(atsErrorDemand("This field is required.").kind, "required");
  assert.strictEqual(atsErrorDemand("Please enter your first name").kind, "required");
});

test("⚠ an unrecognised demand is reported as unknown — that is where the AI comes in", () => {
  const d = atsErrorDemand("The value you provided conflicts with your earlier answer.");
  assert.strictEqual(d.kind, "unknown");
  assert.match(d.detail, /conflicts/);
  assert.strictEqual(atsErrorDemand(""), null);
  assert.strictEqual(atsErrorDemand(null), null);
});

// ── matching an error to the field it is about ──────────────────────────────────────────────────

test("⚠ the error names its field, so no wording list is needed", () => {
  const fields = [
    { id: "Q39", label: "Are you at least 18 years of age?" },
    { id: "Q40", label: "2. Please state your desired gross annual salary." },
    { id: "Q41", label: "Do you have reliable transportation?" },
  ];
  assert.strictEqual(atsMatchErrorToField(LIVE_ERR, fields).id, "Q40");
});

test("⚠⚠ the LONGEST matching label wins — a short one must not claim a longer one's error", () => {
  const fields = [
    { id: "A", label: "Salary" },
    { id: "B", label: "Salary (USD, annual)" },
  ];
  const err = "Salary (USD, annual): Please enter a number using only digits.";
  assert.strictEqual(atsMatchErrorToField(err, fields).id, "B");
});

test("⚠⚠ an unmatched error matches NOTHING — writing into a guessed field is worse than halting", () => {
  const fields = [{ id: "Q1", label: "Are you at least 18 years of age?" }];
  assert.strictEqual(atsMatchErrorToField(LIVE_ERR, fields), null);
  assert.strictEqual(atsMatchErrorToField("", fields), null);
  assert.strictEqual(atsMatchErrorToField(LIVE_ERR, []), null);
  // …and a very short label is not allowed to match on coincidence
  assert.strictEqual(atsMatchErrorToField("Please enter a number", [{ id: "x", label: "No" }]), null);
});

test("the leading number and trailing asterisk on a question do not stop the match", () => {
  const fields = [{ id: "Q40", label: "2. Please state your desired gross annual salary.*" }];
  assert.ok(atsMatchErrorToField(LIVE_ERR, fields));
});

// ── turning the demand into a value ─────────────────────────────────────────────────────────────

test("⚠ the value already on the form is REFORMATTED, not replaced", () => {
  const d = atsErrorDemand(LIVE_ERR);
  assert.strictEqual(atsValueForDemand("$75,000", d), "75000");
  assert.strictEqual(atsValueForDemand("75,000 per year", d), "75000");
  assert.strictEqual(atsValueForDemand("75k", d), "75000");
});

test("⚠ the form's own stated bound is honoured", () => {
  const d = atsErrorDemand(LIVE_ERR);   // between 0 and 300000
  assert.strictEqual(atsValueForDemand("500000", d), "300000", "clamped to the maximum it stated");
});

test("⚠⚠ a value with no number in it yields NULL — never an empty required field", () => {
  const d = atsErrorDemand(LIVE_ERR);
  // This is the live case: the AI had answered "Negotiable". Blanking it would trade a rejected
  // value for an empty REQUIRED one, which is strictly worse. It goes to the AI reformat, and if
  // that cannot help either, to the human.
  assert.strictEqual(atsValueForDemand("Negotiable", d), null);
  assert.strictEqual(atsValueForDemand("", d), null);
  assert.strictEqual(atsValueForDemand("75000", { kind: "unknown" }), null);
  assert.strictEqual(atsValueForDemand("75000", null), null);
});

// ── the number reader ───────────────────────────────────────────────────────────────────────────

test("every human spelling of the same number collapses to the same digits", () => {
  for (const v of ["75000", "75,000", "$75,000", "$75,000.00", "USD 75,000", "75,000 per year", "75000/yr"]) {
    assert.strictEqual(atsSalaryDigits(v), "75000", v);
  }
  assert.strictEqual(atsSalaryDigits("$75K per year"), "75000");
});

test("⚠⚠ a dot is not always a decimal point", () => {
  // "75.000" is seventy-five thousand in much of the world. Reading it as 75 would file a salary
  // three orders of magnitude wrong, and the read-back would happily confirm it — we wrote exactly
  // what we meant to. That is the confident-wrong-value class this codebase exists to refuse.
  assert.strictEqual(atsSalaryDigits("75.000"), "75000");
  assert.strictEqual(atsSalaryDigits("75000.50"), "75001");
  assert.strictEqual(atsSalaryDigits("32.50"), "33");
});

test("⚠ a RANGE takes its low end — the box wants one number", () => {
  assert.strictEqual(atsSalaryDigits("70,000-80,000"), "70000");
  assert.strictEqual(atsSalaryDigits("$70k – $80k"), "70000");
});

test("nothing numeric yields null, never an empty string", () => {
  for (const v of ["Negotiable", "Open to discussion", "", null, undefined, "N/A", "market rate"]) {
    assert.strictEqual(atsSalaryDigits(v), null, String(v));
  }
  assert.strictEqual(atsSalaryDigits("0"), null, "zero is not a salary anyone stated");
});

// ── the POLICY rung, which error-detection cannot replace ───────────────────────────────────────

test("a salary AMOUNT question is still recognised — for the policy, not the format", () => {
  assert.ok(atsIsSalaryAmountField({ label: "2. Please state your desired gross annual salary." }));
  assert.ok(atsIsSalaryAmountField({ label: "Minimum acceptable compensation" }));
  assert.ok(!atsIsSalaryAmountField({ label: "Why do you want to work here?" }));
  assert.ok(!atsIsSalaryAmountField(null));
});

const strip = (t) => String(t)
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .split("\n").map((l) => l.replace(/\/\/[^\r\n]*/, "")).join("\n");
const src = strip(fs.readFileSync(path.join(__dirname, "..", "ats.js"), "utf8"));

test("⚠⚠ an unstated salary is CLAIMED and left blank — no error message can supply a figure", () => {
  // The reason this stays label-driven while formatting does not: a number here is a NEGOTIATING
  // POSITION. The form's rejection can tell us the required FORMAT; it cannot tell us what the
  // operator would accept. Unclaimed, the question reaches the AI, whose prompt infers from
  // ABSENCE and never refuses — live, it answered "Negotiable".
  assert.match(src, /atsIsSalaryAmountField\(\{ label: L \}\)/);
  assert.match(src, /kind: "salary-unstated", review: true/);
});

test("⚠⚠ the stated value is read from profile.screening — the schema's home for it", () => {
  // The first version read `application_questions.availability_and_preferences.salary_expectation`,
  // taken from a TEACH BINDING LABEL in web/lib/teach.ts that reads like a profile path and is not
  // one. `salary_expectation` lives on screeningSchema. A wrong accessor fails EXACTLY like an
  // empty field — the run reported "you have not stated one" against a profile holding 80000 — so
  // it cost a live run to spot and is pinned here rather than left to read plausibly.
  assert.match(src, /profile\.screening \|\| \{\}\)\.salary_expectation/);
  assert.match(src, /path: "screening\.salary_expectation"/);
  // ⚠ ONE rung, not two. A pre-existing one read the same value from
  // `aq.availability_and_preferences.salary_expectation` — always undefined, so it always fell
  // through to the AI, which is how a required salary box came to hold "Negotiable".
  assert.ok(!/availability_and_preferences \|\| \{\}\)\.salary_expectation/.test(src),
    "the old, always-undefined salary accessor must not survive alongside the new one");
});

test("⚠ a bare 'Salary' label is still claimed — the replaced rung matched those", () => {
  // Dropping this would silently stop claiming the shortest and most common labels of all.
  assert.ok(atsIsSalaryAmountField({ label: "Salary" }));
  assert.ok(atsIsSalaryAmountField({ label: "Desired Compensation" }));
  assert.ok(atsIsSalaryAmountField({ label: "Pay expectation" }));
  // …while a LONG label mentioning pay is a different question and must still fall through
  assert.ok(!atsIsSalaryAmountField({ label: "Are you willing to negotiate salary with our team?" }));
  assert.ok(!atsIsSalaryAmountField({ label: "Describe your compensation philosophy in detail" }));
});

test("⚠ the label-triggered FORMAT coercion is gone, not merely unused", () => {
  // Two mechanisms for one job is the drift this codebase keeps paying for.
  assert.ok(!/function atsCoerceSalaryText\b/.test(src),
    "formatting is the error path's job now — a second, label-driven copy must not survive");
});
