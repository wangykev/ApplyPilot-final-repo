// test/essay-prompt-sites.test.js — every essay prompt must actually carry the voice samples.
//
// There are FOUR places prose gets written, and they are easy to miss one of: two per engine
// (single-field and batched), in two different files, with the batched one being the path that
// normally runs. That asymmetry has already cost this codebase once — `buildBatchAiPrompt` never
// read `writing_style` at all, so the same operator got styled prose on Greenhouse and unstyled
// prose on Workday from the same profile, and nothing in either log said why.
//
// This is a SOURCE-TEXT guard (the house pattern, see test/report-recovery.test.js): it cannot check
// behaviour, only that no site was forgotten. A fifth prompt site added later will fail here until
// it either carries the block or is added to the list with a reason.
//
// Run: node --test test/essay-prompt-sites.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const ats = read("ats.js");
const fd = read("fill-driver.js");

/** The body of a named function/const, up to the next top-level declaration. */
function bodyOf(src, header) {
  const i = src.indexOf(header);
  assert.ok(i >= 0, "could not find " + header);
  const rest = src.slice(i + header.length);
  const end = rest.search(/\n(async )?(function|const) [a-zA-Z]/);
  return rest.slice(0, end === -1 ? rest.length : end);
}

const SITES = [
  ["ats.js  atsAiWriteText   (ATS single field)", bodyOf(ats, "async function atsAiWriteText("), "atsLib"],
  ["ats.js  atsBuildBatchPrompt (ATS batch — the usual path)", bodyOf(ats, "function atsBuildBatchPrompt("), "atsLib"],
  ["fill-driver.js  aiFillText (Workday single field)", bodyOf(fd, "const aiFillText = async ("), "apMatch"],
  ["fill-driver.js  buildBatchAiPrompt (Workday batch — the usual path)", bodyOf(fd, "function buildBatchAiPrompt("), "apMatch"],
];

test("⚠⚠ all FOUR essay prompt sites include the voice-sample block", () => {
  for (const [name, body, ns] of SITES) {
    assert.ok(body.includes(ns + ".essayPromptBlock("),
      name + " does not add the essay block — an operator's voice would be silently missing on this path");
  }
});

test("⚠ all four SELECT samples rather than dumping the library", () => {
  // Sending every essay would grow the prompt without bound as the library grows, and both ATS
  // sites already truncate the profile at 12 000 chars.
  for (const [name, body, ns] of SITES) {
    assert.ok(body.includes(ns + ".selectEssaysForQuestion("),
      name + " does not rank/limit the samples");
  }
});

test("⚠ every site reads the operator's STYLE NOTES, and the notes outrank the legacy profile field", () => {
  // `application_questions.writing_style` is always "" on the website sync path (coerceProfile
  // strips unknown keys), so a site reading only that has no style at all.
  for (const [name, body] of SITES) {
    assert.match(body, /style_notes/,
      name + " does not read style_notes — its style would always be empty on a synced profile");
  }
});

test("⚠ the block is appended AFTER the truncated profile slice on both ATS sites", () => {
  // A block placed before `JSON.stringify(profile).slice(0, 12000)` could be cut off by that slice;
  // after it, it cannot. Checked by position rather than by prose.
  for (const [name, body, ns] of SITES.slice(0, 2)) {
    const cut = body.indexOf("slice(0, 12000)");
    const block = body.indexOf(ns + ".essayPromptBlock(");
    assert.ok(cut >= 0, name + " no longer truncates the profile — re-check this guard");
    assert.ok(block > cut, name + " adds the essay block BEFORE the profile truncation");
  }
});

test("⚠ the extension reads the library from storage on both engines", () => {
  const bg = read("background.js");
  assert.match(bg, /chrome\.storage\.local\.get\("essays"/, "Workday path never loads the essays");
  assert.match(bg, /"buckets", "essays"/, "the ATS bulk storage read never loads the essays");
  assert.match(bg, /data\.essays = message\.essays/, "AP_SYNC_PROFILE never stores the essays");
});
