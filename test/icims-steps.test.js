// test/icims-steps.test.js — iCIMS declares its own pages; read them, never infer them.
//
// Operator, 2026-09-08: "this form may have multiple pages and pressing submit actually moves you to
// the next page until the last page is reached - then submit actually submits the form." Verified
// live: the form at /candidate has exactly the 19 fields the fill sees, and the required `rcf3048`
// ("How did you hear about us?") is NOT on it — it lives on step 2 (EEO). The submit run only ever
// saw that field because its single press had already ADVANCED the form, and what we logged as
// `validation-errors` was page 2 reporting its own empty required field. The click had worked.
//
// The markup is the operator's, pasted verbatim from their own page.
//
// Run: node --test test/icims-steps.test.js

const test = require("node:test");
const assert = require("node:assert");
const { atsInjIcimsSteps } = require("../ats.js");

// A DOM double good enough for querySelectorAll('li[...]') + className/textContent/getAttribute.
// Same approach as test/ats-ashby-checkbox-group.test.js, which is the house precedent for
// executing an injected scanner rather than stubbing it.
function withDom(lis) {
  const mk = (o) => ({
    id: o.id || "",
    className: o.className || "",
    textContent: o.text || "",
    getAttribute: (k) => (k === "title" ? (o.title == null ? null : o.title) : null),
    // The operator's real markup holds only a <span> — no anchor, no button. Measured live
    // 2026-09-09: the step indicators are NOT navigable, which is why a resumed walk carries its
    // earlier steps forward instead of going back to re-collect them.
    querySelector: () => null,
  });
  const nodes = lis.map(mk);
  global.document = { querySelectorAll: (sel) => (/^li\[/.test(sel) ? nodes : []) };
  try { return atsInjIcimsSteps(); } finally { delete global.document; }
}

// The operator's page, verbatim (nbsp included — iCIMS pads the sr-only text with them).
const REAL = [
  { id: "Step_profileStep", className: "iCIMS_Steps_First iCIMS_Steps_Current",
    title: "Candidate Profile (Current Step)",
    text: "Step   1   of   2.   Candidate Profile(Current Step)" },
  { id: "Step_eeoStep", className: " iCIMS_Steps_NotCurrent", title: "EEO",
    text: "Step   2   of   2.   EEO(Incomplete Step)" },
];

test("⚠⚠ the operator's real markup: 2 steps, on step 1, NOT the last", () => {
  const r = withDom(REAL);
  assert.strictEqual(r.present, true);
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.currentPos, 1);
  assert.strictEqual(r.isLast, false, "step 1 of 2 must never read as terminal — that submits a page early");
  assert.strictEqual(r.current.title, "Candidate Profile");
  assert.strictEqual(r.current.declaredIndex, 1);
  assert.strictEqual(r.current.declaredTotal, 2);
  assert.strictEqual(r.declaredAgrees, true);
  assert.deepStrictEqual(r.titles, ["Candidate Profile", "EEO"]);
  assert.strictEqual(r.steps[1].incomplete, true);
});

test("⚠⚠ NotCurrent contains the word 'Current' — a substring test marks every step current", () => {
  // The trap that would make the walk believe it is ALWAYS on the last page and submit immediately.
  // Class tokens are therefore compared EXACTLY.
  const r = withDom(REAL);
  assert.strictEqual(r.steps[0].current, true);
  assert.strictEqual(r.steps[1].current, false, "iCIMS_Steps_NotCurrent must not read as current");
});

test("on the LAST step, isLast is true — terminality is 'nothing after this', not a count", () => {
  const r = withDom([
    { id: "Step_profileStep", className: "iCIMS_Steps_First iCIMS_Steps_NotCurrent", title: "Candidate Profile",
      text: "Step 1 of 2. Candidate Profile" },
    { id: "Step_eeoStep", className: "iCIMS_Steps_Current", title: "EEO (Current Step)",
      text: "Step 2 of 2. EEO(Current Step)" },
  ]);
  assert.strictEqual(r.currentPos, 2);
  assert.strictEqual(r.isLast, true);
  assert.strictEqual(r.current.title, "EEO");
});

test("⚠ a THREE-step form is walked structurally, not by arithmetic", () => {
  const r = withDom([
    { id: "Step_a", className: "iCIMS_Steps_First iCIMS_Steps_NotCurrent", title: "Profile", text: "Step 1 of 3. Profile" },
    { id: "Step_b", className: "iCIMS_Steps_Current", title: "Questions (Current Step)", text: "Step 2 of 3. Questions(Current Step)" },
    { id: "Step_c", className: "iCIMS_Steps_NotCurrent", title: "EEO", text: "Step 3 of 3. EEO(Incomplete Step)" },
  ]);
  assert.strictEqual(r.count, 3);
  assert.strictEqual(r.currentPos, 2);
  assert.strictEqual(r.isLast, false);
  assert.strictEqual(r.declaredAgrees, true);
});

test("⚠ a DISAGREEMENT between the DOM order and iCIMS' own 'Step N of M' is REPORTED, not resolved", () => {
  // The ORC ruling: never settle terminality by comparing numbers. If the declaration and the
  // structure disagree, the caller must be able to see that and refuse rather than pick one.
  const r = withDom([
    { id: "Step_a", className: "iCIMS_Steps_Current", title: "Profile (Current Step)", text: "Step 2 of 4. Profile(Current Step)" },
    { id: "Step_b", className: "iCIMS_Steps_NotCurrent", title: "EEO", text: "Step 3 of 4. EEO" },
  ]);
  assert.strictEqual(r.declaredAgrees, false, "1st of 2 in the DOM claiming 'Step 2 of 4' must be flagged");
  assert.strictEqual(r.isLast, false, "structure still governs");
});

test("no steps list ⇒ present:false, so a one-page iCIMS form keeps its existing behaviour", () => {
  const r = withDom([]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.present, false);
});

test("a steps list with no current step reports null rather than guessing", () => {
  const r = withDom([
    { id: "Step_a", className: "iCIMS_Steps_NotCurrent", title: "Profile", text: "Step 1 of 2. Profile" },
    { id: "Step_b", className: "iCIMS_Steps_NotCurrent", title: "EEO", text: "Step 2 of 2. EEO" },
  ]);
  assert.strictEqual(r.present, true);
  assert.strictEqual(r.currentPos, null);
  assert.strictEqual(r.isLast, null, "unknown position must not read as terminal");
  assert.strictEqual(r.current, null);
});
