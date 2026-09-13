// web/test/teach-yesno.test.ts — a NEW remembered answer must default to Yes / No when the
// question is a yes/no one (operator, 2026-09-03).
//
// Before this, `seedNewBucket` consulted only the source card's WIDGET, so a yes/no question a
// tenant rendered as a dropdown — or a card carrying no widget at all — seeded as free Text, and
// the operator had to notice and change "Answer type" by hand on every such field.
//
// ⚠ The wording test anchors on a LEADING AUXILIARY VERB, which is what makes a question yes/no in
// English. That anchor is the guard: a wh-question cannot match it, and those must stay Text.

import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeYesNoQuestion } from "../lib/teach";

test("⚠ the operator's example: a sponsorship question is yes/no", () => {
  assert.equal(looksLikeYesNoQuestion("Will you now or at any time in the future require sponsorship for employment visa status?", ""), true);
  assert.equal(looksLikeYesNoQuestion("Do you now or will you in the future require sponsorship?", ""), true);
});

test("⚠ the ANSWER alone is enough — it is what the operator actually chose", () => {
  // Direct evidence of the field's shape, so it outranks any guess about the wording.
  for (const a of ["Yes", "No", "yes", "NO", "True", "false", "  Yes  "]) {
    assert.equal(looksLikeYesNoQuestion("Anything at all", a), true, a);
  }
});

test("recognises the ordinary auxiliary-verb openings", () => {
  for (const q of [
    "Are you authorized to work in the United States?",
    "Have you previously been employed by our company?",
    "Is this your first application to us?",
    "Can you commit to working from the office three days a week?",
    "Would you require relocation assistance?",
    "Has your visa status changed?",
    "Should we contact your current employer?",
    "Did you complete an internship with us before?",
  ]) {
    assert.equal(looksLikeYesNoQuestion(q, ""), true, q);
  }
});

test("⚠⚠ a WH-QUESTION must stay Text — this is the guard the anchor exists for", () => {
  for (const q of [
    "How many prior internships have you had?",
    "What is your expected graduation date?",
    "Which office would you prefer?",
    "Why do you want to work here?",
    "Describe your most impactful project",
    "Please select your graduation month",
    "Where are you currently based?",
    "Tell us about a time you disagreed with a teammate",
  ]) {
    assert.equal(looksLikeYesNoQuestion(q, ""), false, q);
  }
});

test("⚠ a required marker or bracketed prefix must not hide the auxiliary verb", () => {
  assert.equal(looksLikeYesNoQuestion("* Are you authorized to work in the US?", ""), true);
  assert.equal(looksLikeYesNoQuestion("✱ Do you require sponsorship?", ""), true);
  assert.equal(looksLikeYesNoQuestion("[Required] Will you relocate?", ""), true);
});

test("a non-boolean answer does not make a wh-question yes/no", () => {
  // "How many…" answered "2" is still a Text field, not a Yes/No one.
  assert.equal(looksLikeYesNoQuestion("How many prior internships have you had?", "2"), false);
  assert.equal(looksLikeYesNoQuestion("Please select your graduation month", "May"), false);
});

test("empty input is not a yes/no question", () => {
  assert.equal(looksLikeYesNoQuestion("", ""), false);
  assert.equal(looksLikeYesNoQuestion(null, null), false);
  assert.equal(looksLikeYesNoQuestion(undefined, undefined), false);
});

test("⚠ a word merely STARTING with an auxiliary is not one", () => {
  // The anchor is word-boundaried, so "Doctorate", "Willingness", "Canvas" cannot trigger it.
  assert.equal(looksLikeYesNoQuestion("Doctorate completion year?", ""), false);
  assert.equal(looksLikeYesNoQuestion("Willingness to relocate (describe)", ""), false);
  assert.equal(looksLikeYesNoQuestion("Canvas portfolio link", ""), false);
});
