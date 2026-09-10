// test/ats-salary-digits.test.js — a salary box that demands digits rejects every human spelling.
//
// Live 2026-09-10, RoviSys (iCIMS), step 2 of 4. The form refused the fill in its own words:
//   "2. Please state your desired gross annual salary.: Please enter a number using only the digits
//    0 to 9 with a value between 0 and 300000. Do not include any commas, decimals, or currency
//    symbols."
// The walk halted two steps early and the bundle was marked PARTIAL — so a formatting mismatch on
// ONE field cost the rest of the application.
//
// The coercion is unconditional for an AMOUNT question because the asymmetry is one-sided: a bare
// number is the one spelling every such box accepts, while the constraint that rejects a formatted
// one is only stated AFTER a failed submit. What must NOT happen is stripping a non-numeric answer
// to nothing — that turns a real answer into a blank required field.
//
// Run: node --test test/ats-salary-digits.test.js

const test = require("node:test");
const assert = require("node:assert");
const {
  atsIsSalaryAmountField, atsSalaryDigits, atsCoerceSalaryText,
} = require("../ats.js");

// ── which questions are amount questions ────────────────────────────────────────────────────────

test("⚠ the live RoviSys question is recognised", () => {
  assert.ok(atsIsSalaryAmountField({ label: "2. Please state your desired gross annual salary." }));
});

test("the usual amount wordings are recognised", () => {
  for (const label of [
    "Desired Salary",
    "Expected salary",
    "What is your desired base salary?",
    "Minimum acceptable compensation",
    "Desired hourly rate of pay",
    "Required wage",
  ]) {
    assert.ok(atsIsSalaryAmountField({ label }), label);
  }
  // it reads name/question too, since a per-customer field may carry the text there
  assert.ok(atsIsSalaryAmountField({ question: "Expected annual salary" }));
});

test("⚠⚠ a question that is NOT about an amount is left alone", () => {
  // Coercing one of these to digits would gut a real answer.
  for (const label of [
    "Why do you want to work here?",
    "Are you willing to relocate?",
    "Have you previously been employed by us?",
    "Are you willing to negotiate salary?",     // salary, but asks for no amount
    "Describe your compensation philosophy",    // salary word, no amount word
    "",
  ]) {
    assert.ok(!atsIsSalaryAmountField({ label }), label);
  }
  assert.ok(!atsIsSalaryAmountField(null));
  assert.ok(!atsIsSalaryAmountField({}));
});

test("KNOWN LIMIT: the recognizer is two keyword sets, not comprehension", () => {
  // A label pairing a salary word with an amount word is treated as an amount question, and prose
  // that happens to do the same would be too — e.g. help text like "Salary history is not
  // requested". Deliberately not chased: proximity does not separate those (the words sit adjacent),
  // and the cost is bounded — the coercion only ever fires on a value that CONTAINS a number, and a
  // value with no number passes through untouched. Recorded so the next reader does not mistake it
  // for an oversight.
  assert.ok(atsIsSalaryAmountField({ label: "Salary history is not requested" }));
  // …and even then, a non-numeric answer is left alone, which is what bounds the damage:
  assert.strictEqual(atsCoerceSalaryText({ label: "Salary history is not requested" }, "None", null), "None");
});

// ── the digits ──────────────────────────────────────────────────────────────────────────────────

test("every human spelling of the same number collapses to the same digits", () => {
  for (const v of ["75000", "75,000", "$75,000", "$75,000.00", "USD 75,000", "75,000 per year", "75000/yr"]) {
    assert.strictEqual(atsSalaryDigits(v), "75000", v);
  }
  assert.strictEqual(atsSalaryDigits("75k"), "75000");
  assert.strictEqual(atsSalaryDigits("$75K per year"), "75000");
});

test("⚠⚠ a dot is not always a decimal point", () => {
  // "75.000" is seventy-five thousand in much of the world. Reading it as 75 would file a salary
  // three orders of magnitude wrong, and the read-back would happily confirm it — the
  // confident-wrong-value class this codebase exists to refuse.
  assert.strictEqual(atsSalaryDigits("75.000"), "75000");
  // …while 1–2 trailing digits really are cents
  assert.strictEqual(atsSalaryDigits("75000.50"), "75001");
  assert.strictEqual(atsSalaryDigits("32.50"), "33");
});

test("⚠ a RANGE takes its low end — the box wants one number", () => {
  assert.strictEqual(atsSalaryDigits("70,000-80,000"), "70000");
  assert.strictEqual(atsSalaryDigits("$70k – $80k"), "70000");
});

test("⚠⚠ a value with no number in it yields NULL, never an empty string", () => {
  // Stripping "Negotiable" to "" turns a real answer into a blank REQUIRED field — strictly worse
  // than a formatting mismatch a human can see and fix on the review page.
  for (const v of ["Negotiable", "Open to discussion", "", null, undefined, "N/A", "market rate"]) {
    assert.strictEqual(atsSalaryDigits(v), null, String(v));
  }
  assert.strictEqual(atsSalaryDigits("0"), null, "zero is not a salary anyone stated");
});

// ── the seam both write paths share ─────────────────────────────────────────────────────────────

test("⚠ coercion applies ONLY to an amount field, and records what it did", () => {
  const rec = {};
  const out = atsCoerceSalaryText({ label: "Desired gross annual salary" }, "$75,000", rec);
  assert.strictEqual(out, "75000");
  assert.match(rec.detail, /digits only/);
  assert.match(rec.detail, /75000/);
});

test("⚠ a non-amount field passes through untouched, even holding a number", () => {
  const rec = {};
  const out = atsCoerceSalaryText({ label: "How many years of experience do you have?" }, "3 years", rec);
  assert.strictEqual(out, "3 years");
  assert.strictEqual(rec.detail, undefined, "nothing was changed, so nothing is reported");
});

test("⚠ an amount field whose answer has no number passes through untouched", () => {
  const rec = {};
  const out = atsCoerceSalaryText({ label: "Desired salary" }, "Negotiable", rec);
  assert.strictEqual(out, "Negotiable");
  assert.strictEqual(rec.detail, undefined);
});

test("an already-bare number is not re-reported as a change", () => {
  const rec = {};
  assert.strictEqual(atsCoerceSalaryText({ label: "Desired salary" }, "75000", rec), "75000");
  assert.strictEqual(rec.detail, undefined);
});

test("the helper tolerates a missing rec (the AI seam passes null on purpose)", () => {
  assert.strictEqual(atsCoerceSalaryText({ label: "Desired salary" }, "$80,000", null), "80000");
});
