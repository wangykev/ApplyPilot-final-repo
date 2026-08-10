import { test } from "node:test";
import assert from "node:assert/strict";
import { questionNamesCompany } from "../lib/teach";

test("THE CASE: a question naming the employer is not teachable", () => {
  assert.equal(
    questionNamesCompany(
      "Do you have any commitments to another organization that might affect your employment with Analog Devices?",
      "Analog Devices",
    ),
    true,
  );
});

test("a corporate suffix on the stored company still matches the bare name", () => {
  for (const co of ["Analog Devices Inc.", "Analog Devices, Inc.", "Analog Devices Corporation"]) {
    assert.equal(
      questionNamesCompany("…your employment with Analog Devices?", co),
      true,
      co,
    );
  }
});

test("an ordinary question is still teachable — the whole point of the queue", () => {
  const co = "Analog Devices";
  for (const q of [
    "Are you at least 18 years of age?",
    "Are you authorized to work in the United States?",
    "Will you now or in the future require sponsorship?",
    "How did you hear about us?",
  ]) {
    assert.equal(questionNamesCompany(q, co), false, q);
  }
});

test("a multi-word company matches as a PHRASE, never word-by-word", () => {
  // "devices" and "analog" appear in ordinary technical prose; withholding those cards would be a
  // silent regression in what the queue offers.
  assert.equal(questionNamesCompany("Have you worked with analog circuits or medical devices?", "Analog Devices"), false);
});

test("matching is word-boundary anchored, not substring", () => {
  assert.equal(questionNamesCompany("Do you have experience with Nvidiaesque hardware?", "Nvidia"), false);
  assert.equal(questionNamesCompany("Have you previously worked at Nvidia?", "Nvidia"), true);
});

test("case and punctuation around the name do not matter", () => {
  assert.equal(questionNamesCompany("...employment with ANALOG DEVICES.", "analog devices"), true);
  assert.equal(questionNamesCompany("...employment with (Analog Devices)?", "Analog Devices"), true);
});

test("no company known ⇒ nothing is withheld", () => {
  assert.equal(questionNamesCompany("...employment with Analog Devices?", null), false);
  assert.equal(questionNamesCompany("...employment with Analog Devices?", ""), false);
  assert.equal(questionNamesCompany("...employment with Analog Devices?", undefined), false);
});

test("a company that is ONLY a suffix cannot match everything", () => {
  // "Inc" alone must not blank the whole teach queue.
  assert.equal(questionNamesCompany("Are you incorporated as a contractor?", "Inc."), false);
  assert.equal(questionNamesCompany("Do you work for a company?", "Company"), false);
});

test("junk input never throws", () => {
  assert.equal(questionNamesCompany("", "Analog Devices"), false);
  assert.equal(questionNamesCompany("anything", "   "), false);
});
