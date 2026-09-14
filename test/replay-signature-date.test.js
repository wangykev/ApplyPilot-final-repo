// test/replay-signature-date.test.js — a SIGNATURE date is re-derived to TODAY on every replay,
// never taken from the approved bundle.
//
// Operator, 2026-09-14: "maybe hardcode that the date in the self identify page on workday if they
// have one, should always be today's date, even if it was approved some other date."
//
// WHY THIS IS NOT A SHORTCUT PAST THE APPROVAL GATE. The field asserts WHEN YOU SIGNED. Replaying a
// date approved on an earlier day states a signing date that never happened — the approved value is
// not merely stale, it is WRONG, which is why Workday rejects it. Today is the only truthful value,
// so this joins credentials and the résumé in the family of things a submit run re-derives per visit
// instead of replaying from the bundle.
//
// ⚠ THIS REINSTATES A PROACTIVE STAMP REMOVED ON 2026-08-08, and what makes it safe is a LATER rule.
// The August bug: stamping wrote onto a date the human had left BLANK, and on the Self Identify page
// that write CASCADES (Name + the disability group become required), so a rehearse halted on two
// questions the human never saw. Since 2026-08-10 the FILL answers that whole page unconditionally,
// so the bundle already carries Name and disability and the cascade has nothing left to promote.
//
// The live failure that forced it (Marvell + Intel wd1, both armed submits, 2026-09-14): the REACTIVE
// remediation in runCdpReplayWalk could not save this. It lives in the nav-timeout branch, and the
// blocked page tripped sessionLooksDead first, so the walk returned "session-expired" before the stamp
// could run. Being proactive makes the fix independent of how the failure gets classified.
//
// Run: node --test test/replay-signature-date.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { isSignatureDateQuestion } = require("../lib.js");

// ⚠ `[^\r\n]*`, never `.*$` — CRLF checkout, and JS `.` does not match `\r`.
const strip = (t) => String(t)
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .split("\n").map((l) => l.replace(/\/\/[^\r\n]*/, "")).join("\n");
const src = strip(fs.readFileSync(path.join(__dirname, "..", "fill-driver.js"), "utf8"));

const body = (() => {
  const i = src.indexOf("async function replayField");
  assert.ok(i > 0, "replayField must exist");
  return src.slice(i, i + 4000);
})();

test("⚠⚠ the replay re-derives a signature date instead of using entry.current_value", () => {
  assert.match(body, /const sigDateStamp = \(widget === "date" \|\| widget === "text"\)/,
    "the stamp is scoped to the two widgets a signature date is ever rendered as");
  assert.match(body, /apMatch\.isSignatureDateQuestion\(entry\.question_label\)/,
    "and gated on the NARROW recognizer, reached through apMatch (lib.js owns the definition)");
  // the value must actually be replaced, from a fresh Date
  assert.match(body, /if \(sigDateStamp\) \{[\s\S]{0,240}new Date\(\)[\s\S]{0,240}value = /,
    "a stamped field's value comes from today, not the bundle");
  // …and `value` must be reassignable for that to be possible
  assert.match(body, /let value = entry\.current_value/,
    "value is `let` — a `const` here is what makes the stamp impossible");
});

test("⚠⚠ a stamped signature date is never treated as CLEARED", () => {
  // Without this guard an entry the human emptied (edit_kind "cleared") takes the blank branch and
  // skips the stamp — which is precisely the case that blocks the form, since Workday is ASKING
  // for the date. This is also the exact shape the 2026-08-08 removal was worried about, now safe
  // because the fill answers the whole self-ID page up front.
  assert.match(body, /const cleared = !sigDateStamp && \(entry\.edit_kind === "cleared"/);
});

test("⚠ the stamp is MM/D/YYYY — the shape auditDateSegments and fillTextCdp both consume", () => {
  // A `date` composite is split by auditDateSegments on "/" into Month/Day/Year; a `text` signature
  // date is typed as the same string. One format serves both branches.
  assert.match(body, /\$\{t\.getMonth\(\) \+ 1\}\/\$\{t\.getDate\(\)\}\/\$\{t\.getFullYear\(\)\}/);
});

// ── the recognizer's narrowness is what keeps this from overwriting real date questions ──────────

test("⚠⚠ only a SIGNATURE date is stamped — other date questions are untouched", () => {
  // If this recognizer widened, the replay would overwrite a factual date with today. These are the
  // labels that must never match, each naming a DIFFERENT event.
  for (const label of [
    "Date of Birth", "Graduation Date", "Desired Start Date", "Start Date", "End Date",
    "Expiration Date", "From", "To",
  ]) {
    assert.strictEqual(isSignatureDateQuestion(label), false, `must NOT stamp today onto "${label}"`);
  }
});

test("a real signature date IS recognized", () => {
  for (const label of ["Date", "Date Signed On", "Today's Date", "Signature Date"]) {
    assert.strictEqual(isSignatureDateQuestion(label), true, `should stamp "${label}"`);
  }
});

// ── the reconcile already tolerates it, which is why the gate cannot false-DISAGREE ──────────────

test("⚠ the review-page reconcile still accepts EITHER the approved date or today", () => {
  // lib.js compares a signature date against both. That predates this change and is what stops a
  // stamped date reading as a DISAGREE at the submit gate — so it must not be "simplified" away now
  // that the replay always writes today.
  const lib = strip(fs.readFileSync(path.join(__dirname, "..", "lib.js"), "utf8"));
  const i = lib.indexOf("altCvs");
  assert.ok(i > 0, "the alternate-value comparison must still exist");
  assert.match(lib.slice(i - 400, i + 400), /isSignatureDateQuestion\(e\.question_label\)/);
});
