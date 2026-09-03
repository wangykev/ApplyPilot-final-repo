// web/test/essays.test.ts — the essay library's capture predicate and store.
//
// The feature exists because an essay the operator rewrote by hand was thrown away: it lived only
// inside that one application's review_bundle_json. These tests pin the two decisions that make
// auto-capture usable rather than annoying:
//
//   1. The bar is LENGTH AND SHAPE, not the widget type (operator, explicitly). A long essay
//      routinely arrives in a plain <input type=text>, and a list can arrive in a textarea.
//   2. Only what the OPERATOR typed counts. An AI draft approved unchanged is the model's voice;
//      saving it would teach the model to imitate itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coerceEssays, emptyEssaysDoc, isEssayAnswer, looksLikeProse, dedupeEssays, addEssay,
  recentEssays, ESSAY_MIN_CHARS,
} from "../lib/essays";
import type { ReviewEntry } from "../lib/review-summary";

// The operator's own example, verbatim in shape: a "3 sentences max" projects answer.
const REAL_ESSAY =
  "I built a real-time telemetry logger on an STM32F4 that sampled four analog channels at 10 kHz " +
  "and streamed them over USB CDC, which meant getting DMA double-buffering and the ring buffer " +
  "right so no samples were dropped under load. The second project was a CAN bus sniffer on an " +
  "RP2040 where I wrote the bit-timing setup by hand after the vendor driver kept mis-sampling at " +
  "500 kbps, and I used a logic analyser to confirm the sample point.";

/** A review entry the operator rewrote by hand. */
function edited(over: Partial<ReviewEntry> = {}): ReviewEntry {
  return {
    field_id: "f1",
    question_label: "List one or two projects that best demonstrate your embedded systems experience (3 sentences max)",
    widget_type: "textarea",
    original_ai_value: "I have worked on embedded systems in several courses and personal projects.",
    current_value: REAL_ESSAY,
    is_edited: true,
    edit_kind: "override",
    ...over,
  } as ReviewEntry;
}

test("⚠ the operator's real embedded-projects answer is captured", () => {
  assert.equal(isEssayAnswer(edited()), true);
});

test("⚠⚠ an AI draft APPROVED UNCHANGED is never captured — it is the model's voice", () => {
  // The whole point of the library is to drift TOWARD the operator, not toward the model.
  const approved = edited({
    original_ai_value: REAL_ESSAY,
    current_value: REAL_ESSAY,
    is_edited: false,
    edit_kind: null,
    is_approved: true,
    needs_review: true,
  });
  assert.equal(isEssayAnswer(approved), false);
});

test("an answer written into a field the AI left blank IS captured", () => {
  // edit_kind "filled_blank" — the operator supplied the whole thing.
  assert.equal(isEssayAnswer(edited({ original_ai_value: "", edit_kind: "filled_blank" })), true);
  assert.equal(isEssayAnswer(edited({ original_ai_value: null, edit_kind: "filled_blank" })), true);
});

test("⚠ clearing a field and adding an entry are not essays", () => {
  assert.equal(isEssayAnswer(edited({ edit_kind: "cleared", current_value: "" })), false);
  assert.equal(isEssayAnswer(edited({ edit_kind: "added_entry", is_added: true })), false);
});

test("⚠⚠ THE GATE IS NOT THE WIDGET — a long essay in a plain text input is captured", () => {
  // This is the case that made widget-gating wrong: tenants put essay questions in <input type=text>.
  assert.equal(isEssayAnswer(edited({ widget_type: "text" })), true);
  assert.equal(isEssayAnswer(edited({ widget_type: "" })), true, "unknown widget still passes");
  assert.equal(isEssayAnswer(edited({ widget_type: null })), true);
});

test("⚠ a widget that cannot hold prose is rejected however long the value", () => {
  for (const w of ["dropdown", "radio", "checkbox", "checkbox_group", "yesno", "select", "date", "file_upload"]) {
    assert.equal(isEssayAnswer(edited({ widget_type: w })), false, w);
  }
});

test("⚠⚠ A LIST IS NOT AN ESSAY, even a long one", () => {
  // The operator asked specifically that a "random long answer" not be saved. A skills list clears
  // both the char and word floors easily; separator density is what tells them apart.
  const skills =
    "Python; C++; Verilog; SystemVerilog; Rust; Embedded C; RTOS; FreeRTOS; Zephyr; STM32; RP2040; " +
    "CAN; SPI; I2C; UART; DMA; JTAG; SWD; Logic analyser; Oscilloscope; KiCad; Altium; Git; Docker; " +
    "Linux; Yocto; Buildroot; Make; CMake; Bazel; Jenkins; Verilator; GTKWave; OpenOCD; Segger; " +
    "Ozone; PlatformIO; Arduino; Raspberry Pi; BeagleBone; Nordic nRF; ESP32; TI MSP430; Xilinx Vivado";
  assert.ok(skills.length > ESSAY_MIN_CHARS, "the fixture must actually be long enough to matter");
  assert.equal(isEssayAnswer(edited({ current_value: skills })), false);

  // …and the comma-separated and newline-separated variants.
  assert.equal(isEssayAnswer(edited({ current_value: skills.replace(/;/g, ",") })), false);
  assert.equal(isEssayAnswer(edited({ current_value: skills.replace(/; /g, "\n") })), false);
});

test("⚠ a dense space-separated token list is rejected too", () => {
  // No separators at all, so only the function-word test can catch this one.
  const tokens = "Python C++ Verilog SystemVerilog Rust EmbeddedC RTOS FreeRTOS Zephyr STM32 RP2040 "
    + "CAN SPI I2C UART DMA JTAG SWD LogicAnalyser Oscilloscope KiCad Altium Git Docker Linux Yocto "
    + "Buildroot Make CMake Bazel Jenkins Verilator";
  assert.equal(isEssayAnswer(edited({ current_value: tokens })), false);
});

test("⚠ a bare URL is never an essay", () => {
  const url = "https://github.com/wangykev/" + "a".repeat(300);
  assert.equal(isEssayAnswer(edited({ current_value: url })), false);
});

test("a short answer is below the bar", () => {
  const short = "I built a telemetry logger on an STM32 and a CAN sniffer on an RP2040 for a class project.";
  assert.ok(short.length < ESSAY_MIN_CHARS);
  assert.equal(isEssayAnswer(edited({ current_value: short })), false);
});

test("⚠ a credential field is never stored as writing", () => {
  assert.equal(isEssayAnswer(edited({ credential: true, credential_kind: "password" })), false);
});

test("looksLikeProse in both directions", () => {
  assert.equal(looksLikeProse(REAL_ESSAY), true);
  assert.equal(looksLikeProse(""), false);
  assert.equal(looksLikeProse("Yes"), false);
  assert.equal(looksLikeProse("a, b, c, d, e, f, g, h"), false);
});

test("coerceEssays never throws and tolerates junk", () => {
  assert.deepEqual(coerceEssays(null), emptyEssaysDoc());
  assert.deepEqual(coerceEssays(undefined), emptyEssaysDoc());
  assert.deepEqual(coerceEssays("nonsense"), emptyEssaysDoc());
  assert.deepEqual(coerceEssays(42), emptyEssaysDoc());
  assert.deepEqual(coerceEssays({}), emptyEssaysDoc());
});

test("⚠ coerceEssays accepts the LEGACY bare-array shape", () => {
  const doc = coerceEssays([{ id: "a", question: "Q", text: "T", company: "", source: "manual", created_at: "2026-09-01" }]);
  assert.equal(doc.essays.length, 1);
  assert.equal(doc.style_notes, "");
});

test("⚠ one malformed row does not lose the whole library", () => {
  const doc = coerceEssays({
    style_notes: "3 sentences max",
    essays: [
      { id: "good", question: "Q1", text: "T1", company: "", source: "review", created_at: "2026-09-01" },
      { nope: true },                       // no id — unparseable
      { id: "good2", question: "Q2", text: "T2", company: "", source: "manual", created_at: "2026-09-02" },
    ],
  });
  assert.deepEqual(doc.essays.map((e) => e.id), ["good", "good2"]);
  assert.equal(doc.style_notes, "3 sentences max");
});

test("⚠⚠ dedupe collapses a double blur-commit of the SAME answer", () => {
  // TextBox commits on blur, so one essay genuinely commits more than once.
  const e = (created: string) => ({ id: created, question: "Why us?", text: REAL_ESSAY, company: "Notion", source: "review" as const, created_at: created });
  const out = dedupeEssays([e("2026-09-01T10:00:00Z"), e("2026-09-01T10:00:05Z")]);
  assert.equal(out.length, 1);
  assert.equal(out[0].created_at, "2026-09-01T10:00:05Z", "newest kept");
});

test("⚠ a DIFFERENT answer to the same question is kept — dedupe is on question + text", () => {
  const a = { id: "1", question: "Why us?", text: REAL_ESSAY, company: "", source: "review" as const, created_at: "2026-09-01" };
  const b = { ...a, id: "2", text: REAL_ESSAY + " I also rewrote the bootloader.", created_at: "2026-09-02" };
  assert.equal(dedupeEssays([a, b]).length, 2);
});

test("addEssay puts the newest first and preserves style notes", () => {
  const doc = { style_notes: "no buzzwords", essays: [{ id: "old", question: "Q", text: "T", company: "", source: "manual" as const, created_at: "2026-08-01" }] };
  const next = addEssay(doc, { id: "new", question: "Q2", text: "T2", company: "", source: "review", created_at: "2026-09-02" });
  assert.deepEqual(next.essays.map((e) => e.id), ["new", "old"]);
  assert.equal(next.style_notes, "no buzzwords");
});

test("recentEssays is newest-first and bounded", () => {
  const mk = (i: number) => ({ id: "e" + i, question: "Q" + i, text: "T" + i, company: "", source: "manual" as const, created_at: "2026-09-0" + i });
  const doc = { style_notes: "", essays: [mk(1), mk(3), mk(2)] };
  assert.deepEqual(recentEssays(doc, 2).map((e) => e.id), ["e3", "e2"]);
  assert.deepEqual(recentEssays(doc, 0), []);
  assert.deepEqual(recentEssays(emptyEssaysDoc(), 3), []);
});
