// test/ats-conditional-questions.test.js — a question that carries its own instructions.
//
// Operator, 2026-09-10, from a live RoviSys step:
//   6. If you answered yes to questions 4 or 5, please explain, if no please type "n/a."
//
// Optional and unmapped, these went unanswered; on a REQUIRED one the whole walk stops. And there
// is nothing to infer about the topic — the form has already said what to do, including the exact
// literal to type when the condition does not apply. Same principle as reading the form's error
// rather than recognising the question: quote the form back to itself.
//
// The two branches are deliberately NOT symmetric:
//   condition not met ⇒ type the stated literal, `filled`, unflagged (no judgement was made)
//   condition met     ⇒ AI drafts the explanation, ALWAYS `filled_review` — it is a statement about
//                       the operator's own history, and they fix it on the tracker page.
//
// Run: node --test test/ats-conditional-questions.test.js

const test = require("node:test");
const assert = require("node:assert");
const {
  atsConditionalSpec, atsQuestionOrdinal, atsAnswerIsAffirmative, atsResolveConditional,
} = require("../ats.js");

const LIVE = '6. If you answered yes to questions 4 or 5, please explain, if no please type "n/a."';

// ── reading the instruction ─────────────────────────────────────────────────────────────────────

test("⚠ the live question is parsed: trigger, the questions it points at, and the literal", () => {
  const s = atsConditionalSpec(LIVE);
  assert.strictEqual(s.trigger, "yes");
  assert.deepStrictEqual(s.refs, ["4", "5"]);
  // ⚠ VERBATIM from inside the quotes — the form is being quoted back to itself, so its own
  // trailing punctuation is not second-guessed.
  assert.strictEqual(s.literal, "n/a.");
});

test("the same instruction in other shapes is still read", () => {
  assert.deepStrictEqual(atsConditionalSpec('If yes to question 3, explain. If no, type "N/A"').refs, ["3"]);
  assert.deepStrictEqual(atsConditionalSpec('If you selected yes to #7 or #8, please explain; otherwise enter "none"').refs, ["7", "8"]);
  assert.strictEqual(atsConditionalSpec('If you answered no to questions 1, 2 or 3, please write "n/a"').trigger, "no");
});

test("⚠ an ordinary question is NOT a conditional", () => {
  for (const t of [
    "Are you at least 18 years of age?",
    "Please describe your relevant experience.",
    "What is your desired gross annual salary?",
    "",
  ]) {
    assert.strictEqual(atsConditionalSpec(t), null, t);
  }
  assert.strictEqual(atsConditionalSpec(null), null);
});

test("a bare 'if yes' with nothing to check and nothing to type is not actionable", () => {
  assert.strictEqual(atsConditionalSpec("If yes, tell us more."), null);
});

// ── the pieces it resolves against ──────────────────────────────────────────────────────────────

test("a question's printed ordinal is how a conditional names its siblings", () => {
  assert.strictEqual(atsQuestionOrdinal("4. Have you ever been terminated?"), "4");
  assert.strictEqual(atsQuestionOrdinal("12) Something"), "12");
  assert.strictEqual(atsQuestionOrdinal("Have you ever…"), null);
});

test("⚠⚠ absence is NOT a 'no' — an unanswered screening question is unknown", () => {
  assert.strictEqual(atsAnswerIsAffirmative("Yes"), true);
  assert.strictEqual(atsAnswerIsAffirmative("No"), false);
  assert.strictEqual(atsAnswerIsAffirmative(""), null, "blank means unanswered, not negative");
  assert.strictEqual(atsAnswerIsAffirmative(null), null);
  assert.strictEqual(atsAnswerIsAffirmative("Prefer not to say"), null, "cannot be judged either way");
});

// ── the decision ────────────────────────────────────────────────────────────────────────────────

const spec = () => atsConditionalSpec(LIVE);

test("⚠ condition NOT met → type the literal the question itself specified", () => {
  const recs = [
    { name: "Q4", label: "4. Have you ever been terminated?", after: "No" },
    { name: "Q5", label: "5. Have you ever been convicted?", after: "No" },
  ];
  const r = atsResolveConditional(spec(), recs);
  assert.strictEqual(r.decision, "literal");
  assert.strictEqual(r.literal, "n/a.");
});

test("⚠ condition MET by EITHER referenced question → explain", () => {
  const recs = [
    { name: "Q4", label: "4. Have you ever been terminated?", after: "No" },
    { name: "Q5", label: "5. Have you ever been convicted?", after: "Yes" },
  ];
  assert.strictEqual(atsResolveConditional(spec(), recs).decision, "explain");
});

test("⚠⚠ a referenced question that cannot be read → UNKNOWN, never a guess", () => {
  // Typing "n/a" over a condition that WAS met is a false statement; inventing an explanation for
  // one that was not is worse. Both are refused.
  const missing = atsResolveConditional(spec(), [{ name: "Q4", label: "4. Terminated?", after: "No" }]);
  assert.strictEqual(missing.decision, "unknown");
  const blank = atsResolveConditional(spec(), [
    { name: "Q4", label: "4. Terminated?", after: "No" },
    { name: "Q5", label: "5. Convicted?", after: "" },
  ]);
  assert.strictEqual(blank.decision, "unknown");
});

test("⚠ a 'no' trigger inverts correctly", () => {
  const s = atsConditionalSpec('If you answered no to question 2, please explain; if yes type "n/a"');
  const met = atsResolveConditional(s, [{ name: "Q2", label: "2. Do you have a license?", after: "No" }]);
  assert.strictEqual(met.decision, "explain", "answering NO is what triggers this one");
  const notMet = atsResolveConditional(s, [{ name: "Q2", label: "2. Do you have a license?", after: "Yes" }]);
  assert.strictEqual(notMet.decision, "literal");
});

test("a spec naming no question resolves to unknown rather than guessing", () => {
  assert.strictEqual(atsResolveConditional({ trigger: "yes", refs: [], literal: "n/a" }, []).decision, "unknown");
  assert.strictEqual(atsResolveConditional(null, []).decision, "unknown");
});

// ── the pass's own policy, pinned in source ─────────────────────────────────────────────────────

const fs = require("node:fs");
const path = require("node:path");
const strip = (t) => String(t)
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .split("\n").map((l) => l.replace(/\/\/[^\r\n]*/, "")).join("\n");
const src = strip(fs.readFileSync(path.join(__dirname, "..", "ats.js"), "utf8"));
const body = (() => {
  const i = src.indexOf("async function atsAnswerConditionals(");
  return src.slice(i, src.indexOf("\nasync function ", i + 10));
})();

test("⚠⚠ an AI-drafted explanation is ALWAYS flagged for the human", () => {
  assert.match(body, /rec\.status = "filled_review"/);
  assert.match(body, /ai-conditional-explain/);
  assert.ok(!/decision === "explain"[\s\S]{0,400}rec\.status = "filled"[^_]/.test(body),
    "an explanation of a screening 'yes' must never be recorded as a silent, unflagged fill");
});

test("⚠ the literal branch is unflagged — quoting the form back to itself is not a judgement", () => {
  const i = body.indexOf('decision === "literal"');
  const near = body.slice(i, i + 500);
  assert.match(near, /rec\.status = "filled"/);
  assert.ok(!/rec\.flag/.test(near), "no flag: nothing was decided");
});

test("⚠ it only ever touches a field nothing else answered", () => {
  assert.match(body, /rec\.status !== "skipped" && rec\.status !== "needs_review"/);
  assert.match(body, /if \(rec\.after && String\(rec\.after\)\.trim\(\)\) continue/);
});

test("⚠⚠ records join fields on `fieldName`, and ordinals come from the SCAN's labels", () => {
  // The bug this pins cost a live run and was invisible in the bundle: the first version looked
  // records up with `r.name === f.id`, which is wrong on BOTH sides, so it found nothing and left
  // every conditional untouched — identical, from the outside, to the pass never running at all.
  // `fieldName` is the key every other late pass uses.
  assert.match(body, /r\.fieldName === x\.fieldName/);
  assert.ok(!/r\.name === f\.id/.test(body), "the broken join must not come back");
  // …and the printed "4." / "5." live on the SCAN's label; a record carries the platform's field
  // NAME ("Q4"), which has no ordinal in it.
  assert.match(body, /x\.label \|\| x\.question \|\| x\.fieldName/);
  assert.match(body, /atsResolveConditional\(spec, answered\)/);
  // the write goes through the same selector every other pass uses
  assert.match(body, /const sel = f\.inputSel/);
});

test("⚠ it runs LATE — a conditional cannot be decided before its siblings are answered", () => {
  const call = src.indexOf("await atsAnswerConditionals(");
  const prefilled = src.indexOf("await atsSurfacePrefilled(");
  assert.ok(call > prefilled && prefilled > 0, "after the ordinary fill passes");
});
