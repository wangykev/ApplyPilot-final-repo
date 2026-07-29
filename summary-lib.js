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
// A field the form MADE REQUIRED after this application was reviewed (flag `cascade-required`). Same
// approval force as any cascade_revealed entry, but DIFFERENT news for the human — see the web twin in
// review-approval.ts (LOCKSTEP).
const isBecameRequired = (e) => !!(e && e.cascade_revealed && e.flag === "cascade-required");

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
  // A preferred-name field HIDDEN by an unchecked "I have a preferred name" is off the form, so it
  // must NOT demand approval (else a synthesized/empty preferred row blocks submit while invisible).
  const toApprove = live.filter((e) => requiresApproval(e) && !isHiddenPreferredName(e, live));
  const approved = toApprove.filter((e) => !!e.is_approved);
  const placeholdersLeft = live.filter((e) => e.flag === "ai-text-needs-answer" && hasPlaceholder(e.current_value));
  // A REQUIRED field with NO VALUE blocks submit (operator 2026-07-27) — LOCKSTEP with
  // bundleSubmitBlockers (fill-driver.js) and web/lib/review-approval.ts. canApprove (summary.js) already
  // refuses to approve one in the UI; this makes the ENVELOPE agree, so submit_ready can't say yes while
  // a mandatory field is empty. Carve-outs: a checkbox stores "false" (never empty), file_upload has its
  // own re-attach + halt, stub rows are display-only.
  const requiredBlank = live.filter((e) => e.is_required === true
    && e.widget_type !== "file_upload" && e.widget_type !== "section_stub"
    && e.widget_type !== "nested_section_stub" && e.widget_type !== "removed_entry"
    && (e.current_value == null || String(e.current_value).trim() === ""));
  const all_approved = toApprove.length === approved.length;
  return {
    to_approve_count: toApprove.length,
    approved_count: approved.length,
    pending_count: toApprove.length - approved.length,
    unreplaced_placeholders: placeholdersLeft.length,
    required_blank: requiredBlank.length,
    all_approved,
    submit_ready: all_approved && placeholdersLeft.length === 0 && requiredBlank.length === 0
  };
}

const submitReady = (entries) => approvalEnvelope(entries).submit_ready;

// "I currently work here" → the form removes the "To" (endDate) box; mirror that in the review.
// Match on the field's id/canonical (the WE map names: currentlyWorkHere checkbox, endDate→`to`).
const _idstr = (e) => String((e && e.field_id) || "") + "|" + String((e && e.canonical_field) || "");
const isCurrentlyWorkHere = (e) => !!e && e.widget_type === "checkbox" && /currentlyworkhere|currently_work_here/i.test(_idstr(e));
const isWorkExpEndDate = (e) => !!e && /workexperience\[\d+\]\.(to|enddate)\b/i.test(_idstr(e));

// #3 (UI): "I have a preferred name" reveals the preferred first/last fields (a cascade). When that
// checkbox is UNCHECKED the form hides them, so the review should too. Hide a preferred-name field when
// its controlling preferredCheck (same page) is present AND unchecked. Mirrors the visibleEntryItems
// "currently work here → hide the To date" pattern, but for these two flat fields. Pure → unit-tested.
// Match the FIELD-NAME tail (after the last "formField-") + the canonical path — NOT the whole field_id.
// The field_id's PAGE-KEY prefix (cdpPageKey = "pathname|sorted-field-names") LISTS every flat field name,
// so testing "preferredName--" against the full field_id matched EVERY page-1 field → it hid the ENTIRE page.
const _ffName = (e) => { const id = String((e && e.field_id) || ""); const i = id.lastIndexOf("formField-"); return i !== -1 ? id.slice(i + "formField-".length) : id; };
const isPreferredNameField = (e) => !!e && (/^preferred_?name--/i.test(_ffName(e)) || /preferred_(first|last)_name/i.test(sumNorm(e.canonical_field)));
const isPreferredCheckField = (e) => !!e && e.widget_type === "checkbox" && (/^preferredcheck$/i.test(_ffName(e)) || /has_preferred_name/i.test(sumNorm(e.canonical_field)));
function isHiddenPreferredName(e, entries) {
  if (!isPreferredNameField(e)) return false;
  const ctrl = (entries || []).find((x) => isPreferredCheckField(x) && x.page === e.page);
  return !!ctrl && !checkedOf(ctrl.current_value); // controlling checkbox present + UNCHECKED → hide the field
}

// When "I have a preferred name" is CHECKED but the preferred first/last fields are ABSENT (the first
// fill had the box unchecked, so the form never revealed them), SYNTHESIZE editable text rows so the
// review shows them like the profile page — inserted right after the controlling checkbox. Uses the SAME
// field name / canonical the fill engine emits (preferredName--firstName → personal_info.preferred_first_name)
// so a later replay recognizes them. Returns the list UNCHANGED if both already exist. PURE → unit-tested.
function ensurePreferredNameEntries(entries, ctrl) {
  const list = entries || [];
  const page = ctrl.page != null ? ctrl.page : null;
  const hasFor = (which) => list.some((e) => isPreferredNameField(e) && e.page === page && new RegExp("preferred_" + which + "_name").test(sumNorm(e.canonical_field)));
  const make = (which) => ({
    field_id: (page != null ? page + "::" : "") + "formField-preferredName--" + (which === "first" ? "firstName" : "lastName"),
    page,
    field_index: null,
    question_label: which === "first" ? "Preferred First Name" : "Preferred Last Name",
    widget_type: "text",
    canonical_field: "personal_info.preferred_" + which + "_name",
    is_required: false, // Workday preferred-name fields are optional → an empty one never blocks approval
    current_value: null,
    original_ai_value: null,
    is_edited: false,
    edit_kind: null,
    is_added: true,
    added_at: null,
    is_approved: false,
    approved_at: null,
    page_number: ctrl.page_number != null ? ctrl.page_number : null,
    page_label: ctrl.page_label != null ? ctrl.page_label : null,
    confidence: "none",
    confidence_source: "added",
    needs_review: true,
    needs_review_reason: "revealed by 'I have a preferred name' — fill it in",
    fill_status: "not_filled",
    fill_error: null,
    detail: "revealed by 'I have a preferred name' — fill it in",
    match_tier: null,
    flag: "preferred-name-added",
    options: null,
    captured_options: null,
    tree_structure: null,
    date_order: null,
    tiers: null,
    character_count: null
  });
  const additions = [];
  if (!hasFor("first")) additions.push(make("first"));
  if (!hasFor("last")) additions.push(make("last"));
  if (!additions.length) return list;
  const idx = list.findIndex((e) => e.field_id === ctrl.field_id);
  if (idx === -1) return list.concat(additions);
  return list.slice(0, idx + 1).concat(additions, list.slice(idx + 1));
}

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
  module.exports = { editKindOf, checkedOf, tokenFor, effectiveValue, requiresApproval, isCascadeRevealed, isBecameRequired, approvalEnvelope, submitReady, hasPlaceholder, SUMMARY_PLACEHOLDER_MARK, isCurrentlyWorkHere, isWorkExpEndDate, isHiddenPreferredName, isPreferredNameField, isPreferredCheckField, ensurePreferredNameEntries, visibleEntryItems, newEntryRecords };
}
