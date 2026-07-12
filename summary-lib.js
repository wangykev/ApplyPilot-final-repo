// summary-lib.js — PURE, testable helpers for the review-summary viewer (summary.js) +
// the Node test runner (test/summary.test.js). UMD-lite: in the browser it defines globals
// consumed by summary.js (loaded as a <script> BEFORE summary.js in summary.html); in Node it
// exports via module.exports. NO DOM, NO chrome.* — pure data transforms only, so they're
// unit-testable without a page (summary.js had no tests before; this is where they live now).
//
// LOCKSTEP: editKindOf + the AI-2 placeholder marker MIRROR copies in lib.js + fill-driver.js.
// A drift here silently mis-labels an edit's provenance / mis-reads submit-readiness — keep
// the three identical.

const sumNorm = (v) => (v == null ? "" : String(v));

// Edit provenance for the later strict-replay SUBMIT (Plan 1): compare the bot's pick
// (original_ai_value) against the current (possibly human-edited) value. null = unedited.
function editKindOf(e) {
  // 2b: an OPERATOR-ADDED entry keeps STICKY "added_entry" provenance — a value edit must NOT
  // flip it to override/filled_blank, so the strict-replay knows the whole entry is new (it must
  // be CREATED on the form, not matched to an existing one). Checked before the value compare.
  if (e && e.is_added) return "added_entry";
  const o = sumNorm(e.original_ai_value), c = sumNorm(e.current_value);
  if (o === c) return null;
  if (o === "") return "filled_blank";
  if (c === "") return "cleared";
  return "override";
}

// Checkbox value helpers — a toggle commits a token in the SAME family as the bot's value, so
// flipping back to the original state reads as "not edited", not a false override.
const checkedOf = (v) => v === true || /^(checked|true|yes|1|on)$/i.test(sumNorm(v));
function tokenFor(orig, want) {
  if (typeof orig === "boolean") return want;
  const fam = [["Checked", "Unchecked"], ["True", "False"], ["Yes", "No"], ["1", "0"], ["On", "Off"]];
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
const SUMMARY_PLACEHOLDER_MARK = "[NEEDS YOUR ANSWER";
const hasPlaceholder = (v) => typeof v === "string" && v.indexOf(SUMMARY_PLACEHOLDER_MARK) !== -1;

// The effective value the future strict-replay SUBMIT (Plan 1) will replay for an entry.
// current_value already reflects any human edit (the editor writes it; a clear → null). This is
// the documented seam Plan 1 reads — kind/approved/deleted ride alongside the value.
function effectiveValue(entry) {
  return {
    value: entry.current_value != null ? entry.current_value : null,
    kind: editKindOf(entry),
    approved: !!entry.is_approved,
    deleted: !!entry.is_deleted
  };
}

// A cascade-REVEALED field (M6): it appeared only after another value committed, so it never went
// through the operator's eyes on the first pass — force a second review even if it filled cleanly.
const isCascadeRevealed = (e) => !!(e && e.cascade_revealed);

// Which entries demand an EXPLICIT human approval before submit: the flagged ones (needs_review) AND
// any cascade-revealed field, minus soft-deleted. Un-flagged fields are approved-by-default (lower
// friction — the operator decision). super-hard / sensitive / needs-answer are ALL needs_review, so
// they're covered here; cascade-revealed is added so a cleanly-filled revealed field still forces review.
const requiresApproval = (e) => !e.is_deleted && (!!e.needs_review || isCascadeRevealed(e));

// Approval roll-up for the envelope + the viewer's progress UI. PURE over the entries.
// submit_ready = every field that requires approval IS approved AND no required field still
// holds an unreplaced AI placeholder. This is what the future SUBMIT (Plan 1) reads.
function approvalEnvelope(entries) {
  const live = (entries || []).filter((e) => !e.is_deleted);
  const toApprove = live.filter(requiresApproval);
  const approved = toApprove.filter((e) => !!e.is_approved);
  const placeholdersLeft = live.filter((e) => e.flag === "ai-text-needs-answer" && hasPlaceholder(e.current_value));
  const all_approved = toApprove.length === approved.length;
  return {
    to_approve_count: toApprove.length,
    approved_count: approved.length,
    pending_count: toApprove.length - approved.length,
    unreplaced_placeholders: placeholdersLeft.length,
    all_approved,
    submit_ready: all_approved && placeholdersLeft.length === 0
  };
}

const submitReady = (entries) => approvalEnvelope(entries).submit_ready;

// "I currently work here" → the form removes the "To" (endDate) box; mirror that in the review.
// Match on the field's id/canonical (the WE map names: currentlyWorkHere checkbox, endDate→`to`).
const _idstr = (e) => String((e && e.field_id) || "") + "|" + String((e && e.canonical_field) || "");
const isCurrentlyWorkHere = (e) => !!e && e.widget_type === "checkbox" && /currentlyworkhere|currently_work_here/i.test(_idstr(e));
const isWorkExpEndDate = (e) => !!e && /workexperience\[\d+\]\.(to|enddate)\b/i.test(_idstr(e));

// Given one repeating-entry's fields, return the ones to SHOW: when "I currently work here" is
// CHECKED, drop the endDate ("To") field — EXCEPT keep it if it's flagged needs_review (e.g. the
// today's-date fallback when the box stayed required), so a flagged value is never hidden.
function visibleEntryItems(items) {
  const list = items || [];
  const cw = list.find(isCurrentlyWorkHere);
  if (cw && checkedOf(cw.current_value)) return list.filter((e) => !(isWorkExpEndDate(e) && !e.needs_review));
  return list;
}

// Build the field records for an OPERATOR-ADDED repeating-section entry (2b — the inverse of the
// soft-delete). `shape` is [{recName, path, widget_type, is_required, label?, options?,
// captured_options?, tree_structure?}] (the viewer derives it from an existing entry of the same
// section, or — for an empty section — from the stub's engine-emitted section_field_shape). Each
// record mirrors buildReviewBundle's entry shape PLUS the additive `is_added`/`added_at` markers
// and a sticky edit_kind "added_entry". field_id / canonical_field use the SAME
// "<sectionKey>[<index>].<rec>" format the fill engine emits, so the viewer groups the new entry
// correctly AND the future strict-replay's isRepeatingEntry recognizes it (CREATE on the form via
// the section reconcile, never replay as a flat field). PURE → unit-tested (the viewer passes
// `at` since this stays Date-free).
function newEntryRecords(shape, meta) {
  const m = meta || {};
  const fpfx = (m.page != null ? m.page + "::" : "") + "formField-" + m.sectionKey + "[" + m.index + "].";
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
    edit_kind: "added_entry",
    is_added: true,
    added_at: m.at != null ? m.at : null,
    is_approved: false,
    approved_at: null,
    page_number: m.pageNumber != null ? m.pageNumber : null,
    page_label: m.pageLabel != null ? m.pageLabel : null,
    confidence: "none",
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
    tree_structure: (s.tree_structure && typeof s.tree_structure === "object") ? s.tree_structure : null,
    date_order: Array.isArray(s.date_order) ? s.date_order : null, // m3c: date-segment order for the segmented date editor
    tiers: null, // m3c: ordered candidate list for a hierarchical/tree field — filled by the review's tier editor
    character_count: null
  }));
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { editKindOf, checkedOf, tokenFor, effectiveValue, requiresApproval, isCascadeRevealed, approvalEnvelope, submitReady, hasPlaceholder, SUMMARY_PLACEHOLDER_MARK, isCurrentlyWorkHere, isWorkExpEndDate, visibleEntryItems, newEntryRecords };
}
