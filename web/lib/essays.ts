/**
 * essays.ts — the operator's OWN written application answers, kept as a voice library.
 *
 * WHY THIS EXISTS. Every essay was written from scratch: the AI got the question, the company, the
 * JD and the profile JSON, and nothing about how the operator actually writes. So a "list one or two
 * projects that demonstrate your embedded systems experience (3 sentences max)" answer came back in
 * generic model prose, the operator rewrote it by hand — and that rewrite was thrown away, because
 * it lived only inside that one application's `review_bundle_json`.
 *
 * Two things this store is NOT:
 *
 *  • It is NOT a bucket. `BUCKET_ELIGIBLE` (teach.ts) deliberately excludes essays, and that is
 *    correct: a bucket is an exact-normalized-wording → verbatim-answer match, and an essay question
 *    is never phrased the same way twice. This is the complementary store — not "replay this answer"
 *    but "here is how I write". Do not widen BUCKET_ELIGIBLE to reach it.
 *  • It is NOT a résumé substitute, but it does carry detail the résumé does not (operator: the
 *    essays "give more details into some of my projects than what is on my resume"). That is why the
 *    prompt block permits reusing concrete FACTS from them, not just imitating their voice.
 *
 * ⚠ No DOM / Supabase / React in here — the page does the I/O (the teach.ts house rule). Everything
 * below is pure so `web/test/essays.test.ts` can pin it without a database or a browser.
 */

import { z } from "zod";
import { normalizeQuestion } from "./buckets";
import { wasManuallyEdited } from "./teach";
import type { ReviewEntry } from "./review-summary";

/** One saved answer, in the operator's own words. */
export const essaySchema = z.object({
  id: z.string(),
  /** The question it answered — the ranking signal, and what the library lists. */
  question: z.string().default(""),
  /** The essay itself, verbatim. */
  text: z.string().default(""),
  /** Where it came from, for the operator's benefit only. NEVER used to target an answer: a company
   *  name in a saved essay is context, not something to reuse on a different employer's form. */
  company: z.string().default(""),
  /** "review" = auto-captured from a review-page edit; "manual" = typed on the essays page. */
  source: z.enum(["review", "manual"]).default("manual"),
  created_at: z.string().default(""),
});
export type Essay = z.infer<typeof essaySchema>;

/**
 * The stored document. An OBJECT rather than a bare array so the operator's style notes have a home
 * beside the samples — "3 sentences max, no buzzwords" is style information that no sample states.
 */
export const essaysDocSchema = z.object({
  style_notes: z.string().default(""),
  essays: z.array(essaySchema).default([]),
});
export type EssaysDoc = z.infer<typeof essaysDocSchema>;

export function emptyEssaysDoc(): EssaysDoc {
  return { style_notes: "", essays: [] };
}

/**
 * Tolerant loader — never throws, drops what it cannot read, and accepts a BARE ARRAY as a legacy
 * shape so an early write (or a hand-edited column) still loads. Same contract as coerceBuckets:
 * a malformed store must degrade to "no essays", never to an exception on page load.
 */
export function coerceEssays(raw: unknown): EssaysDoc {
  if (raw == null) return emptyEssaysDoc();
  const doc = Array.isArray(raw) ? { essays: raw, style_notes: "" } : raw;
  const parsed = essaysDocSchema.safeParse(doc);
  if (parsed.success) return parsed.data;
  // Salvage what we can: keep the rows that individually validate rather than losing the library to
  // one bad entry.
  const obj = (doc && typeof doc === "object" ? doc : {}) as Record<string, unknown>;
  const list = Array.isArray(obj.essays) ? obj.essays : [];
  const essays: Essay[] = [];
  for (const row of list) {
    const one = essaySchema.safeParse(row);
    if (one.success) essays.push(one.data);
  }
  return { style_notes: typeof obj.style_notes === "string" ? obj.style_notes : "", essays };
}

// ── the capture predicate ────────────────────────────────────────────────────────────────

/**
 * Widgets that cannot hold prose. ⚠ NOTE WHAT IS *NOT* HERE: `text` and `textarea` both pass, and so
 * does an unknown widget.
 *
 * ⚠ THE GATE IS LENGTH AND SHAPE, NOT THE WIDGET (operator, explicitly). Keying on
 * `widget_type === "textarea"` is wrong in both directions: a 3,000-character essay routinely
 * arrives in a plain `<input type=text>` (widget `"text"`, and `teachableCards` already treats those
 * as ordinary short answers), while a two-word list can arrive in a textarea. So this set exists
 * only to rule out widgets where prose is impossible by construction.
 */
const NON_PROSE_WIDGETS = new Set([
  "dropdown", "radio", "checkbox", "checkbox_group", "yesno", "select",
  "date", "file_upload", "multiselect_native", "dropdown_native", "icims_dropdown", "dial",
]);

/** Operator's chosen bar. ~275 chars / 30 words is about two to three real sentences. */
export const ESSAY_MIN_CHARS = 275;
export const ESSAY_MIN_WORDS = 30;

function wordsOf(s: string): string[] {
  return String(s || "").trim().split(/\s+/).filter(Boolean);
}

/**
 * Does this read as prose rather than a list or a single blob?
 *
 * ⚠ THE LIST TEST IS WHY LENGTH ALONE IS NOT ENOUGH. "Python; C++; Verilog; Rust; Embedded C; …" can
 * clear 275 characters and 30 words while being nothing like an essay, and the operator asked
 * specifically that a "random long answer" not be saved. A list is recognisable by its separator
 * density: real prose has far more words than it has commas, semicolons and newlines.
 */
export function looksLikeProse(text: string): boolean {
  const t = String(text || "").trim();
  if (!t) return false;
  const words = wordsOf(t);
  if (words.length < 2) return false;                       // one blob is never prose
  if (/^https?:\/\/\S*$/i.test(t)) return false;            // a bare URL, however long
  // A separator every ~3 words or denser is a list, not a sentence. Prose sits far below that.
  const separators = (t.match(/[;,\n•|\t]/g) || []).length;
  if (separators > 0 && words.length / separators < 3.2) return false;
  // Prose has ordinary function words. A dense token list ("C++ Verilog Python SystemVerilog …")
  // has almost none, and this catches the space-separated variant the separator test cannot see.
  const fn = words.filter((w) => /^(the|a|an|and|to|of|in|for|with|that|it|is|was|we|i|my|on|as|at|this|which|but|so)$/i.test(w));
  if (fn.length < 2) return false;
  return true;
}

/**
 * Is this review entry an essay the OPERATOR wrote?
 *
 * ⚠ `wasManuallyEdited` is load-bearing, not a formality. An AI draft the operator approved
 * UNCHANGED is the model's voice — feeding it back as a style sample would teach the model to
 * imitate itself, and the library would drift away from the operator with every application. Only a
 * value they actually typed counts.
 *
 * (`edit_kind` covers both shapes that mean "they wrote it": `override` — they rewrote the draft,
 * which includes rewriting over the AI-2 "[NEEDS YOUR ANSWER" sentinel — and `filled_blank`, where
 * the AI produced nothing. `cleared` and `added_entry` are excluded by wasManuallyEdited itself.)
 */
export function isEssayAnswer(entry: ReviewEntry): boolean {
  if (!entry) return false;
  if (!wasManuallyEdited(entry)) return false;
  if (NON_PROSE_WIDGETS.has(String(entry.widget_type || ""))) return false;
  if (entry.credential) return false;                       // never store a secret as writing
  const text = String(entry.current_value == null ? "" : entry.current_value).trim();
  if (text.length < ESSAY_MIN_CHARS) return false;
  if (wordsOf(text).length < ESSAY_MIN_WORDS) return false;
  if (!looksLikeProse(text)) return false;
  return true;
}

// ── library maintenance ──────────────────────────────────────────────────────────────────

/** Cheap stable hash of the text, for dedupe only (not security). */
function textKey(s: string): string {
  const t = String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
  let h = 0;
  for (let i = 0; i < t.length; i++) { h = (h * 31 + t.charCodeAt(i)) | 0; }
  return t.length + ":" + h;
}

/**
 * Collapse duplicates, newest kept.
 *
 * ⚠ THIS IS NOT HOUSEKEEPING — IT IS REQUIRED. The review page's TextBox commits on BLUR, so one
 * essay can commit more than once (edit, blur, click back in, blur again), and re-approving an
 * application re-runs the same commit path. Deduped on the QUESTION plus the text, so a genuine
 * second answer to the same question still lands, and an identical re-save does not.
 */
export function dedupeEssays(list: Essay[]): Essay[] {
  const byKey = new Map<string, Essay>();
  for (const e of list || []) {
    if (!e) continue;
    const key = normalizeQuestion(e.question || "") + " " + textKey(e.text);
    const prev = byKey.get(key);
    if (!prev || String(e.created_at || "") >= String(prev.created_at || "")) byKey.set(key, e);
  }
  // Newest first — the library reads better that way, and recentEssays then needs no sort.
  return [...byKey.values()].sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
}

/** Add one essay to a doc, deduped. Returns a NEW doc (callers persist the whole thing). */
export function addEssay(doc: EssaysDoc, essay: Essay): EssaysDoc {
  return { style_notes: doc.style_notes, essays: dedupeEssays([essay, ...(doc.essays || [])]) };
}

/** The N most recent — for the cover letter, which has no question to rank against. */
export function recentEssays(doc: EssaysDoc, n: number): Essay[] {
  return dedupeEssays(doc && doc.essays ? doc.essays : []).slice(0, Math.max(0, n));
}
