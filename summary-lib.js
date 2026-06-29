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

// Which entries demand an EXPLICIT human approval before submit: the flagged ones (needs_review),
// minus soft-deleted. Un-flagged fields are approved-by-default (lower friction — the operator
// decision). super-hard / sensitive / needs-answer are ALL needs_review, so they're covered here.
const requiresApproval = (e) => !e.is_deleted && !!e.needs_review;

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

if (typeof module !== "undefined" && module.exports) {
  module.exports = { editKindOf, checkedOf, tokenFor, effectiveValue, requiresApproval, approvalEnvelope, submitReady, hasPlaceholder, SUMMARY_PLACEHOLDER_MARK, isCurrentlyWorkHere, isWorkExpEndDate, visibleEntryItems };
}
