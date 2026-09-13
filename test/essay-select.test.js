// test/essay-select.test.js — choosing WHICH of the operator's past answers to show the model.
//
// The library grows with every application and essays are long, while both ATS prompt sites already
// truncate the profile at 12 000 chars. So "send them all" is not an option: this picks a few by
// relevance, breaks ties by recency, and stops at a char budget.
//
// Run: node --test test/essay-select.test.js

const test = require("node:test");
const assert = require("node:assert");
const lib = require("../lib.js");

const mk = (over) => Object.assign({
  id: "x", question: "", text: "body", company: "", source: "manual", created_at: "2026-01-01",
}, over);

const EMBEDDED = mk({
  id: "embedded",
  question: "List one or two projects that demonstrate your experience with embedded systems",
  text: "I built a telemetry logger on an STM32F4 with DMA double-buffering, and a CAN sniffer on an RP2040.",
  created_at: "2026-08-01",
});
const WHYUS = mk({
  id: "whyus",
  question: "Why do you want to work at this company?",
  text: "I care about tools people actually use every day, and your product is one I reach for.",
  created_at: "2026-08-02",
});
const LEADERSHIP = mk({
  id: "leadership",
  question: "Describe a time you led a team through a difficult technical decision",
  text: "I chaired the design review where we chose to drop the vendor CAN driver and write bit timing by hand.",
  created_at: "2026-08-03",
});

test("⚠ relevance beats recency on a clear topic match", () => {
  // LEADERSHIP is the NEWEST, but the question is about embedded systems.
  const got = lib.selectEssaysForQuestion([LEADERSHIP, WHYUS, EMBEDDED],
    "Tell us about a project involving embedded systems and firmware", { max: 1 });
  assert.deepStrictEqual(got.map((e) => e.id), ["embedded"]);
});

test("⚠ recency breaks ties when nothing matches the question", () => {
  // A question sharing no meaningful tokens with any sample ⇒ all score 0 ⇒ newest first.
  const got = lib.selectEssaysForQuestion([EMBEDDED, WHYUS, LEADERSHIP],
    "What is your favourite colour?", { max: 2 });
  assert.deepStrictEqual(got.map((e) => e.id), ["leadership", "whyus"]);
});

test("the stored QUESTION outranks a passing mention in the body", () => {
  // Both mention CAN; only LEADERSHIP's body does, while EMBEDDED answered the project question.
  const got = lib.selectEssaysForQuestion([LEADERSHIP, EMBEDDED],
    "Describe a project where you worked with embedded systems", { max: 1 });
  assert.deepStrictEqual(got.map((e) => e.id), ["embedded"]);
});

test("⚠ `max` is respected", () => {
  const all = [EMBEDDED, WHYUS, LEADERSHIP];
  assert.strictEqual(lib.selectEssaysForQuestion(all, "embedded systems", { max: 2 }).length, 2);
  assert.strictEqual(lib.selectEssaysForQuestion(all, "embedded systems", { max: 3 }).length, 3);
  assert.strictEqual(lib.selectEssaysForQuestion(all, "embedded systems", { max: 0 }).length, 0);
});

test("⚠⚠ each essay is TRUNCATED and the whole set is BUDGETED", () => {
  // This is the property that keeps a growing library from growing the prompt without bound.
  const long = mk({ id: "long", question: "embedded systems", text: "z".repeat(5000), created_at: "2026-08-09" });
  const one = lib.selectEssaysForQuestion([long], "embedded systems", { max: 3, perEssayChars: 400, totalChars: 2200 });
  assert.strictEqual(one[0].text.length, 400, "per-essay cap applied");

  const many = [1, 2, 3, 4, 5].map((i) => mk({ id: "e" + i, question: "embedded systems", text: "y".repeat(900), created_at: "2026-08-0" + i }));
  const picked = lib.selectEssaysForQuestion(many, "embedded systems", { max: 5, perEssayChars: 900, totalChars: 2000 });
  const total = picked.reduce((n, e) => n + e.text.length, 0);
  assert.ok(total <= 2000, "total budget honoured, got " + total);
  assert.strictEqual(picked.length, 2, "900+900 fits, a third would not");
});

test("⚠ the ORIGINAL essay objects are not mutated by truncation", () => {
  const src = mk({ id: "src", question: "embedded", text: "w".repeat(1000) });
  lib.selectEssaysForQuestion([src], "embedded", { perEssayChars: 100 });
  assert.strictEqual(src.text.length, 1000, "truncation must copy, not edit the library");
});

test("an empty or junk library is safe — most operators have none for a while", () => {
  assert.deepStrictEqual(lib.selectEssaysForQuestion([], "anything"), []);
  assert.deepStrictEqual(lib.selectEssaysForQuestion(null, "anything"), []);
  assert.deepStrictEqual(lib.selectEssaysForQuestion(undefined, "anything"), []);
  assert.deepStrictEqual(lib.selectEssaysForQuestion([null, undefined], "anything"), []);
  // an essay with no text is not a sample
  assert.deepStrictEqual(lib.selectEssaysForQuestion([mk({ text: "" }), mk({ text: "   " })], "x"), []);
  assert.deepStrictEqual(lib.selectEssaysForQuestion([EMBEDDED], null), [EMBEDDED].map((e) => ({ ...e })));
});

// ── the prompt block ─────────────────────────────────────────────────────────────────────

test("⚠⚠ the block grants FACT REUSE and forbids wholesale copying — both, explicitly", () => {
  const out = lib.essayPromptBlock([EMBEDDED], "");
  assert.match(out, /Match this voice/i, "the samples are here for voice");
  assert.match(out, /MAY reuse concrete facts/i, "the operator's explicit grant");
  assert.match(out, /Do NOT copy an answer wholesale/i, "the guard against pasting a different answer");
  assert.match(out, /STM32F4/, "the sample text is actually included");
  assert.match(out, /Q: List one or two projects/, "the question it answered is included");
});

test("style notes appear even with no samples yet, and samples with no notes", () => {
  assert.match(lib.essayPromptBlock([], "3 sentences max, no buzzwords"), /3 sentences max/);
  assert.match(lib.essayPromptBlock([EMBEDDED], ""), /STM32F4/);
});

test("⚠ an empty library and no notes produce NO block at all", () => {
  // The four prompt sites concatenate this, so it must be "" rather than a dangling header —
  // an empty section would tell the model the operator has a voice and then show it nothing.
  assert.strictEqual(lib.essayPromptBlock([], ""), "");
  assert.strictEqual(lib.essayPromptBlock(null, null), "");
  assert.strictEqual(lib.essayPromptBlock(undefined, "   "), "");
});
