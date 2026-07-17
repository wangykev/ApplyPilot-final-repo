/**
 * review-model.ts — PURE grouping / prominence / shape helpers for the hosted review
 * editor. Port of the non-DOM logic in the extension's `summary.js` (sectionOf,
 * nestedInfoOf, the flag-prominence predicates, sectionShapeFor, nextIndexFor). Kept
 * separate from `review-approval.ts` (the summary-lib.js port) but consumed together by
 * the React editor. NO React, NO DOM.
 */
import type { ReviewEntry, ReviewBundle, FieldShape } from "./review-summary";

export const fmt = (v: unknown): string => (v == null || v === "" ? "—" : String(v));
export const norm = (v: unknown): string => (v == null ? "" : String(v));
export const autofilledOf = (e: ReviewEntry): string | null =>
  e.original_ai_value != null ? e.original_ai_value : (e.current_value ?? null);

// Section grouping. Keys = the REAL canonical-field prefixes the fill engine emits
// (FIELD_MAP flat paths like personal_info.* + PAGE_SECTIONS names, which are camelCase).
const SECTION_LABELS: Record<string, string> = {
  personal_info: "Personal Information",
  self_identification: "Self-Identification",
  agreements: "Agreements",
  workExperience: "Work Experience",
  education: "Education",
  language: "Languages",
  website: "Websites",
  certification: "Certifications",
  skill: "Skills",
  _documents: "Documents",
  _other: "Other Fields",
};

export const humanize = (k: string): string =>
  SECTION_LABELS[k] ||
  k
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

export type SectionInfo = { key: string; label: string; index: number | null };

/** Group info for an entry, from its canonical_field. Repeating: base[idx]; flat: prefix.rest. */
export function sectionOf(e: ReviewEntry): SectionInfo {
  const cf = e.canonical_field || "";
  let m = cf.match(/^([A-Za-z_]+)\s*\[(\d+)\]/);
  if (m) return { key: m[1], label: humanize(m[1]), index: +m[2] };
  m = cf.match(/^([A-Za-z_]+)\./);
  if (m) return { key: m[1], label: humanize(m[1]), index: null };
  if (e.widget_type === "file_upload") return { key: "_documents", label: "Documents", index: null };
  return { key: "_other", label: "Other Fields", index: null };
}

export type NestedInfo =
  | { kind: "field"; childBase: string; childIndex: number; field: string }
  | { kind: "stub"; childBase: string; childIndex: null; field: null }
  | null;

/** NESTED sub-section classifier (cert ▸ Specialties). null = the parent entry's own field. */
export function nestedInfoOf(e: ReviewEntry): NestedInfo {
  const cf = e.canonical_field || "";
  let m = cf.match(/^[A-Za-z_]+\[\d+\]\.([A-Za-z_]+)\[(\d+)\]\.(.+)$/);
  if (m) return { kind: "field", childBase: m[1], childIndex: +m[2], field: m[3] };
  m = cf.match(/^[A-Za-z_]+\[\d+\]\.([A-Za-z_]+)\._stub$/);
  if (m) return { kind: "stub", childBase: m[1], childIndex: null, field: null };
  return null;
}

// ── Review-card prominence predicates — prominence keys off the FLAG, never confidence
// (a high-confidence reasoning-from-absence answer, e.g. criminal→"No", must still be the
// most conspicuous, not buried). ──
export const isSensitive = (e: ReviewEntry): boolean => !!e.flag && /sensitive/.test(e.flag);
export const needsAnswer = (e: ReviewEntry): boolean => e.flag === "ai-text-needs-answer";
export const isEeoGuess = (e: ReviewEntry): boolean => e.flag === "ai-eeo-guess";
export const isAiFlag = (e: ReviewEntry): boolean => !!e.flag && e.flag.indexOf("ai-") === 0;
// SUPER-HARD: an AI typeahead pick the applicant didn't claim (ai-closest-forced), OR any AI
// guess the model itself flagged LOW confidence — the riskiest committed AI answers.
export const isSuperHard = (e: ReviewEntry): boolean =>
  e.flag === "ai-closest-forced" || (isAiFlag(e) && e.confidence === "low");
export const mustReplace = (e: ReviewEntry): boolean =>
  isSuperHard(e) || isSensitive(e) || needsAnswer(e) || isEeoGuess(e);
// Pre-populated: the value was ALREADY on the form (account pre-fill / operator / prior run).
export const isPrePopulated = (e: ReviewEntry): boolean =>
  e.flag === "already-filled" || e.flag === "already-filled-match";
export const isCascadeRevealed = (e: ReviewEntry): boolean => !!e.cascade_revealed;

export type StatusKind = "ok" | "warn" | "crit" | "skip";
export function statusOf(e: ReviewEntry): StatusKind {
  if (e.fill_status === "skipped") return "skip";
  if (e.fill_status === "error" || e.fill_status === "not_filled") return "crit";
  if (e.needs_review) return mustReplace(e) ? "crit" : "warn";
  return "ok";
}

/** Friendly page caption: page_label wins; an "accumulated (N pages)" envelope shows as-is;
 *  otherwise a cdpPageKey ("pathname|field,field,…") collapses to its last path segment. */
export function cleanPageName(b: { page_label?: string | null; page?: string | null } | null): string {
  if (!b) return "—";
  if (b.page_label) return b.page_label;
  const p = b.page;
  if (typeof p === "string") {
    if (/^accumulated/.test(p)) return p;
    const seg = (p.split("|")[0] || p).split("/").filter(Boolean).pop();
    if (seg) return seg;
  }
  return fmt(p);
}

export const pageNumOf = (items: ReviewEntry[]): number | null => {
  const e = items.find((x) => x.page_number != null);
  return e ? (e.page_number as number) : null;
};
export const pageCaptionOf = (items: ReviewEntry[], pg: string | null): string => {
  const e = items.find((x) => x.page_label != null);
  if (e) return e.page_label as string;
  const n = pageNumOf(items);
  if (n != null) return "Page " + n;
  return cleanPageName({ page: pg });
};

// ── Add-entry shape derivation (sectionShapeFor / nextIndexFor) — PURE over the bundle. ──
const _stripEntryPrefix = (s: string | null | undefined, key: string): string =>
  String(s || "").replace(new RegExp("^" + key + "\\[\\d+\\]\\."), "");

/** The field SHAPE for a new entry of a repeating section: DOM-detected section_shapes first
 *  (enriched with captured options), else cloned from the highest-index existing entry, else
 *  the stub's engine-emitted section_field_shape. Empty = not addable. */
export function sectionShapeFor(bundle: ReviewBundle, page: string | null, key: string): FieldShape[] {
  const ents = bundle.entries.filter((e) => e.page === page && sectionOf(e).key === key);
  const indexed = ents.filter((e) => sectionOf(e).index != null && !e.is_deleted);
  const existingByRec: Record<string, ReviewEntry> = {};
  for (const e of indexed) {
    const r = _stripEntryPrefix(String(e.field_id).replace(/^.*formField-/, ""), key);
    const p = _stripEntryPrefix(e.canonical_field, key);
    if (r) existingByRec[r] = e;
    if (p && !(p in existingByRec)) existingByRec[p] = e;
  }
  const enrich = (s: FieldShape): FieldShape => {
    const ex = existingByRec[s.recName] || existingByRec[s.path || ""];
    return {
      recName: s.recName,
      path: s.path != null ? s.path : s.recName,
      widget_type: s.widget_type,
      is_required: !!s.is_required,
      label: s.label != null ? s.label : s.recName,
      options: ex ? ex.options : s.options || null,
      captured_options: ex ? ex.captured_options : s.captured_options || null,
      tree_structure: ex ? ex.tree_structure : s.tree_structure || null,
      date_order: s.date_order || (ex ? ex.date_order : null),
    };
  };
  const detected = bundle.section_shapes && bundle.section_shapes[key];
  if (Array.isArray(detected) && detected.length) return detected.map(enrich);
  if (indexed.length) {
    const maxIx = Math.max(...indexed.map((e) => sectionOf(e).index as number));
    return indexed
      .filter((e) => sectionOf(e).index === maxIx)
      .map((e) => ({
        recName: _stripEntryPrefix(String(e.field_id).replace(/^.*formField-/, ""), key),
        path: _stripEntryPrefix(e.canonical_field, key),
        widget_type: e.widget_type,
        is_required: e.is_required,
        label: e.question_label,
        options: e.options,
        captured_options: e.captured_options,
        tree_structure: e.tree_structure,
        date_order: e.date_order || null,
      }));
  }
  const stub = ents.find(
    (e) =>
      e.widget_type === "section_stub" &&
      Array.isArray(e.section_field_shape) &&
      e.section_field_shape.length
  );
  if (stub && stub.section_field_shape)
    return stub.section_field_shape.map((s) => ({
      recName: s.recName,
      path: s.path != null ? s.path : s.recName,
      widget_type: s.widget_type,
      is_required: !!s.is_required,
      label: s.label != null ? s.label : s.recName,
      options: null,
      captured_options: null,
      tree_structure: null,
      date_order: s.date_order || null,
    }));
  return [];
}

export function nextIndexFor(bundle: ReviewBundle, page: string | null, key: string): number {
  const idxs = bundle.entries
    .filter((e) => e.page === page && sectionOf(e).key === key)
    .map((e) => sectionOf(e).index)
    .filter((i): i is number => i != null);
  return idxs.length ? Math.max(...idxs) + 1 : 0;
}

export function nextNestedIndexFor(
  bundle: ReviewBundle,
  page: string | null,
  parentKey: string,
  parentIx: number,
  childBase: string
): number {
  const re = new RegExp("^" + parentKey + "\\[" + parentIx + "\\]\\." + childBase + "\\[(\\d+)\\]");
  const idxs = bundle.entries
    .filter((e) => e.page === page)
    .map((e) => {
      const m = String(e.canonical_field || "").match(re);
      return m ? +m[1] : null;
    })
    .filter((i): i is number => i != null);
  return idxs.length ? Math.max(...idxs) + 1 : 0;
}
