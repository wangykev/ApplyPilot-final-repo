/**
 * review-approval.ts — PURE edit/approval transforms for the hosted review editor.
 *
 * FAITHFUL TS PORT of the extension's `summary-lib.js` (repo root). Keep the two in
 * LOCKSTEP: the extension's `runCdpReplayWalk` / `submitPrecondition` read the exact
 * per-entry fields these transforms write (current_value, edit_kind, is_deleted,
 * is_approved, needs_review, cascade_revealed), so a drift here silently mis-labels an
 * edit's provenance or mis-reads submit-readiness. `test/summary.test.js` in the
 * extension remains the semantic spec these must satisfy.
 *
 * NO React, NO DOM, NO Supabase — pure data transforms only.
 */
import type { ReviewEntry, ApprovalEnvelope, FieldShape } from "./review-summary";

const sumNorm = (v: unknown): string => (v == null ? "" : String(v));

/** Edit provenance for the strict-replay SUBMIT: compare the bot's pick
 *  (original_ai_value) against the current (possibly human-edited) value.
 *  null = unedited. */
export function editKindOf(e: ReviewEntry): ReviewEntry["edit_kind"] {
  // An OPERATOR-ADDED entry keeps STICKY "added_entry" provenance — a value edit must
  // NOT flip it to override/filled_blank, so the strict-replay knows the whole entry is
  // new (it must be CREATED on the form, not matched). Checked before the value compare.
  if (e && e.is_added) return "added_entry";
  const o = sumNorm(e.original_ai_value),
    c = sumNorm(e.current_value);
  if (o === c) return null;
  if (o === "") return "filled_blank";
  if (c === "") return "cleared";
  return "override";
}

// Checkbox value helpers — a toggle commits a token in the SAME family as the bot's
// value, so flipping back to the original state reads as "not edited", not a false override.
export const checkedOf = (v: unknown): boolean =>
  v === true || /^(checked|true|yes|1|on)$/i.test(sumNorm(v));

export function tokenFor(orig: unknown, want: boolean): string | boolean {
  if (typeof orig === "boolean") return want;
  const fam = [
    ["Checked", "Unchecked"],
    ["True", "False"],
    ["Yes", "No"],
    ["1", "0"],
    ["On", "Off"],
  ];
  const s = sumNorm(orig).trim();
  for (const [c, u] of fam) {
    if (s.toLowerCase() === c.toLowerCase()) return want ? s : u;
    if (s.toLowerCase() === u.toLowerCase()) return want ? c : s;
  }
  return want ? "Checked" : "Unchecked";
}

// AI-2 placeholder marker (LOCKSTEP with lib.js AI_NEEDS_ANSWER_MARK + fill-driver.js
// AI_NEEDS_ANSWER_MARK_FD). A REQUIRED free-text field the AI couldn't answer holds this
// sentinel so the walk reaches review; it MUST be replaced before submit.
export const SUMMARY_PLACEHOLDER_MARK = "[NEEDS YOUR ANSWER";
export const hasPlaceholder = (v: unknown): boolean =>
  typeof v === "string" && v.indexOf(SUMMARY_PLACEHOLDER_MARK) !== -1;

export type EffectiveValue = {
  value: string | null;
  kind: ReviewEntry["edit_kind"];
  approved: boolean;
  deleted: boolean;
};

/** The effective value the strict-replay SUBMIT will replay for an entry. */
export function effectiveValue(entry: ReviewEntry): EffectiveValue {
  return {
    value: entry.current_value != null ? entry.current_value : null,
    kind: editKindOf(entry),
    approved: !!entry.is_approved,
    deleted: !!entry.is_deleted,
  };
}

// A cascade-REVEALED field: it appeared only after another value committed, so it never
// went through the operator's eyes on the first pass — force a second review even if it
// filled cleanly.
export const isCascadeRevealed = (e: ReviewEntry): boolean => !!(e && e.cascade_revealed);

// Which entries demand an EXPLICIT human approval before submit: the flagged ones
// (needs_review) AND any cascade-revealed field, minus soft-deleted. Un-flagged fields are
// approved-by-default (lower friction). super-hard / sensitive / needs-answer are ALL
// needs_review, so they're covered here.
export const requiresApproval = (e: ReviewEntry): boolean =>
  !e.is_deleted && (!!e.needs_review || isCascadeRevealed(e));

/** Approval roll-up for the envelope + the viewer's progress UI. PURE over the entries.
 *  submit_ready = every field that requires approval IS approved AND no required field
 *  still holds an unreplaced AI placeholder. */
export function approvalEnvelope(entries: ReviewEntry[]): ApprovalEnvelope {
  const live = (entries || []).filter((e) => !e.is_deleted);
  const toApprove = live.filter(requiresApproval);
  const approved = toApprove.filter((e) => !!e.is_approved);
  const placeholdersLeft = live.filter(
    (e) => e.flag === "ai-text-needs-answer" && hasPlaceholder(e.current_value)
  );
  const all_approved = toApprove.length === approved.length;
  return {
    to_approve_count: toApprove.length,
    approved_count: approved.length,
    pending_count: toApprove.length - approved.length,
    unreplaced_placeholders: placeholdersLeft.length,
    all_approved,
    submit_ready: all_approved && placeholdersLeft.length === 0,
  };
}

export const submitReady = (entries: ReviewEntry[]): boolean =>
  approvalEnvelope(entries).submit_ready;

// "I currently work here" → the form removes the "To" (endDate) box; mirror that.
const _idstr = (e: ReviewEntry): string =>
  String((e && e.field_id) || "") + "|" + String((e && e.canonical_field) || "");
export const isCurrentlyWorkHere = (e: ReviewEntry): boolean =>
  !!e && e.widget_type === "checkbox" && /currentlyworkhere|currently_work_here/i.test(_idstr(e));
export const isWorkExpEndDate = (e: ReviewEntry): boolean =>
  !!e && /workexperience\[\d+\]\.(to|enddate)\b/i.test(_idstr(e));

// "I have a preferred name" reveals the preferred first/last fields (a cascade). When that
// checkbox is UNCHECKED the form hides them, so the review should too. Match the FIELD-NAME
// tail (after the last "formField-") + the canonical path — NOT the whole field_id (whose
// PAGE-KEY prefix lists every flat field name).
const _ffName = (e: ReviewEntry): string => {
  const id = String((e && e.field_id) || "");
  const i = id.lastIndexOf("formField-");
  return i !== -1 ? id.slice(i + "formField-".length) : id;
};
export const isPreferredNameField = (e: ReviewEntry): boolean =>
  !!e &&
  (/^preferred_?name--/i.test(_ffName(e)) || /preferred_(first|last)_name/i.test(sumNorm(e.canonical_field)));
export const isPreferredCheckField = (e: ReviewEntry): boolean =>
  !!e &&
  e.widget_type === "checkbox" &&
  (/^preferredcheck$/i.test(_ffName(e)) || /has_preferred_name/i.test(sumNorm(e.canonical_field)));
export function isHiddenPreferredName(e: ReviewEntry, entries: ReviewEntry[]): boolean {
  if (!isPreferredNameField(e)) return false;
  const ctrl = (entries || []).find((x) => isPreferredCheckField(x) && x.page === e.page);
  return !!ctrl && !checkedOf(ctrl.current_value); // controlling checkbox present + UNCHECKED → hide
}

/** Given one repeating-entry's fields, return the ones to SHOW: when "I currently work
 *  here" is CHECKED, drop the endDate ("To") field — EXCEPT keep it if it's flagged
 *  needs_review (a flagged value is never hidden). */
export function visibleEntryItems(items: ReviewEntry[]): ReviewEntry[] {
  const list = items || [];
  const cw = list.find(isCurrentlyWorkHere);
  if (cw && checkedOf(cw.current_value))
    return list.filter((e) => !(isWorkExpEndDate(e) && !e.needs_review));
  return list;
}

export type NewEntryMeta = {
  page?: string | null;
  pageNumber?: number | null;
  pageLabel?: string | null;
  sectionKey: string;
  index: number;
  at?: string | null;
};

/** Build the field records for an OPERATOR-ADDED repeating-section entry (the inverse of the
 *  soft-delete). field_id / canonical_field use the SAME "<sectionKey>[<index>].<rec>" format
 *  the fill engine emits, so grouping + the strict-replay's isRepeatingEntry recognize it. PURE. */
export function newEntryRecords(shape: FieldShape[], meta: NewEntryMeta): ReviewEntry[] {
  const m = meta || ({} as NewEntryMeta);
  const fpfx =
    (m.page != null ? m.page + "::" : "") + "formField-" + m.sectionKey + "[" + m.index + "].";
  const cpfx = m.sectionKey + "[" + m.index + "].";
  return (shape || []).map((s) => ({
    field_id: fpfx + s.recName,
    page: m.page != null ? m.page : null,
    field_index: null,
    question_label: s.label != null ? s.label : s.recName,
    widget_type: s.widget_type,
    canonical_field: cpfx + (s.path != null ? s.path : s.recName),
    is_required: !!s.is_required,
    current_value: null,
    original_ai_value: null,
    is_edited: true,
    edit_kind: "added_entry" as const,
    is_added: true,
    added_at: m.at != null ? m.at : null,
    is_approved: false,
    approved_at: null,
    page_number: m.pageNumber != null ? m.pageNumber : null,
    page_label: m.pageLabel != null ? m.pageLabel : null,
    confidence: "none" as const,
    confidence_source: "added",
    needs_review: true,
    needs_review_reason: "added_entry",
    fill_status: "not_filled",
    fill_error: null,
    detail: "added by you in review — fill it in, then approve",
    match_tier: null,
    flag: "added-entry",
    options: Array.isArray(s.options) ? s.options : null,
    captured_options: Array.isArray(s.captured_options) ? s.captured_options : null,
    tree_structure: s.tree_structure && typeof s.tree_structure === "object" ? s.tree_structure : null,
    date_order: Array.isArray(s.date_order) ? s.date_order : null,
    tiers: null,
    character_count: null,
  }));
}
