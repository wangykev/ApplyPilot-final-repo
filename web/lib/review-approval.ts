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
import type { ReviewEntry, ApprovalEnvelope, FieldShape, RememberedField } from "./review-summary";

const sumNorm = (v: unknown): string => (v == null ? "" : String(v));

/** Edit provenance for the strict-replay SUBMIT: compare the bot's pick
 *  (original_ai_value) against the current (possibly human-edited) value.
 *  null = unedited. */
/** A menu's PROMPT row ("Select One", "-- Please select --") is not an answer. On Workday it is
 *  TEMPORARY: once a real option is chosen the placeholder is gone from the menu and cannot be chosen
 *  again, so offering it in this editor would offer something the form itself no longer allows
 *  (operator 2026-08-02). LOCKSTEP with `isPlaceholderOption` in lib.js — change both. */
const PLACEHOLDER_OPTION_RE =
  /^(?:[-–—_.*\s]*)(?:(?:please\s+)?(?:select|choose|pick)(?:\s+(?:an?|one|any|option|value|item))?|none\s+selected|no\s+selection|make\s+a\s+selection)(?:\s*(?:one|option|value|item))?(?:[-–—_.*\s]*)$/i;
export function isPlaceholderOption(text: unknown): boolean {
  const t = String(text ?? "").replace(/\u00a0/g, " ").trim();
  if (!t) return true;
  if (/^[-–—_.*\s]+$/.test(t)) return true;
  return PLACEHOLDER_OPTION_RE.test(t);
}
/** Drop prompt rows from an option list. Never returns empty — a list that is ALL placeholder is
 *  handed back untouched rather than leaving the reviewer with no choices at all. */
export function withoutPlaceholderOptions(texts: string[] | null | undefined): string[] {
  const all = Array.isArray(texts) ? texts : [];
  const keep = all.filter((t) => !isPlaceholderOption(t));
  return keep.length ? keep : all.slice();
}
/** Only a menu has a prompt row — a TEXT answer reading "select one" is a real answer. LOCKSTEP with
 *  CHOICE_WIDGETS / isChoiceWidget in fill-driver.js. */
const CHOICE_WIDGETS = ["dropdown", "radio", "typeahead", "source", "sourceTree", "checkbox_group", "multiselect"];
export const isChoiceWidget = (w: unknown): boolean => CHOICE_WIDGETS.indexOf(String(w ?? "")) !== -1;
/** The value a field EFFECTIVELY holds is empty when it is blank OR still on the menu's prompt row. */
export const holdsNoValue = (e: { current_value?: unknown; widget_type?: unknown }): boolean =>
  e.current_value == null ||
  String(e.current_value).trim() === "" ||
  (isChoiceWidget(e.widget_type) && isPlaceholderOption(e.current_value));
/** A checkbox GROUP holds a SET, not a value. Traced live on PSECU's `ethnicityMulti`: checking a
 *  second option leaves BOTH on and both survive Save & Continue, while Caterpillar's OFCCP
 *  disability group is genuinely pick-one — so the editor must carry whatever the human chose.
 *  `current_value` stays the JOINED display string (every existing consumer keeps working) and
 *  `selected_options` is authoritative when present. LOCKSTEP with lib.js groupSelection/join/split. */
export const GROUP_JOIN = "; ";
export function groupSelection(entry: { selected_options?: unknown; current_value?: unknown }): string[] {
  if (Array.isArray(entry?.selected_options)) return entry.selected_options.map((s) => String(s)).filter((s) => s.trim() !== "");
  const v = entry?.current_value;
  if (v == null || String(v).trim() === "") return [];
  return String(v).split(GROUP_JOIN).map((s) => s.trim()).filter(Boolean);
}
export const joinGroupValue = (labels: string[]): string =>
  (Array.isArray(labels) ? labels : []).map((s) => String(s)).filter((s) => s.trim() !== "").join(GROUP_JOIN);
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

// A field the form MADE REQUIRED after this application was reviewed (flag `cascade-required`, added by
// the extension's replay when Workday refuses a page over a field the approved bundle can't answer).
// It is a cascade_revealed entry — same approval force — but a DIFFERENT thing to tell the human:
// "⤴ REVEALED" describes a field that merely appeared, while this one is a question the form is now
// demanding an answer to (operator 2026-07-27: "instead can you make a different flag like became
// required"). Checked BEFORE the generic revealed badge so only one of the two shows.
export const isBecameRequired = (e: ReviewEntry): boolean =>
  !!(e && e.cascade_revealed && e.flag === "cascade-required");

// Which entries demand an EXPLICIT human approval before submit: the flagged ones
// (needs_review) AND any cascade-revealed field, minus soft-deleted. Un-flagged fields are
// approved-by-default (lower friction). super-hard / sensitive / needs-answer are ALL
// needs_review, so they're covered here.
export const requiresApproval = (e: ReviewEntry): boolean =>
  !e.is_deleted && (!!e.needs_review || isCascadeRevealed(e));

/** Approval roll-up for the envelope + the viewer's progress UI. PURE over the entries.
 *  submit_ready = every field that requires approval IS approved, no required field still holds an
 *  unreplaced AI placeholder, AND no required field is blank. */
export function approvalEnvelope(entries: ReviewEntry[]): ApprovalEnvelope {
  const live = (entries || []).filter((e) => !e.is_deleted);
  // A preferred-name field HIDDEN by an unchecked "I have a preferred name" is off the form, so it
  // must NOT demand approval (else a synthesized/empty preferred row blocks submit while invisible).
  const toApprove = live.filter((e) => requiresApproval(e) && !isHiddenPreferredName(e, live));
  const approved = toApprove.filter((e) => !!e.is_approved);
  const placeholdersLeft = live.filter(
    (e) => e.flag === "ai-text-needs-answer" && hasPlaceholder(e.current_value)
  );
  // A REQUIRED field with NO VALUE blocks submit (operator 2026-07-27). The extension viewer refused to
  // APPROVE a required-empty field, but that was UI-only — this envelope never encoded it, so an
  // approved-but-blank required field read as submit_ready and only Workday's own validation stopped it
  // (as a mid-replay halt). LOCKSTEP with bundleSubmitBlockers (fill-driver.js), including the carve-outs:
  // a checkbox stores "false" (never empty), file_upload has its own re-attach + halt, and stub rows are
  // display-only. Preferred-name fields are is_required:false, so a hidden one can't trip this.
  const requiredBlank = live.filter(
    (e) =>
      e.is_required === true &&
      e.widget_type !== "file_upload" &&
      e.widget_type !== "section_stub" &&
      e.widget_type !== "nested_section_stub" &&
      e.widget_type !== "removed_entry" &&
      // A placeholder is BLANK: it reads like an answer in the bundle but the form counts it as
      // unanswered — live, an AI-picked "Select One" got Waystar's page rejected as required-empty.
      holdsNoValue(e)
  );
  const all_approved = toApprove.length === approved.length;
  return {
    to_approve_count: toApprove.length,
    approved_count: approved.length,
    pending_count: toApprove.length - approved.length,
    unreplaced_placeholders: placeholdersLeft.length,
    required_blank: requiredBlank.length,
    all_approved,
    submit_ready: all_approved && placeholdersLeft.length === 0 && requiredBlank.length === 0,
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

/** When "I have a preferred name" is CHECKED but the preferred first/last fields are ABSENT from the
 *  bundle (the first fill had the box unchecked, so the form never revealed them), SYNTHESIZE editable
 *  text rows so the review page shows them just like the profile page does — inserted right after the
 *  controlling checkbox. Uses the SAME field name / canonical the fill engine emits
 *  (preferredName--firstName → personal_info.preferred_first_name) so a later replay recognizes them.
 *  Returns the list UNCHANGED if both already exist (isHiddenPreferredName already reveals those). PURE. */
export function ensurePreferredNameEntries(entries: ReviewEntry[], ctrl: ReviewEntry): ReviewEntry[] {
  const list = entries || [];
  const page = ctrl.page ?? null;
  const hasFor = (which: "first" | "last"): boolean =>
    list.some(
      (e) =>
        isPreferredNameField(e) &&
        e.page === page &&
        new RegExp("preferred_" + which + "_name").test(sumNorm(e.canonical_field))
    );
  const make = (which: "first" | "last"): ReviewEntry => ({
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
    page_number: ctrl.page_number ?? null,
    page_label: ctrl.page_label ?? null,
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
    character_count: null,
  } as ReviewEntry);

  const additions: ReviewEntry[] = [];
  if (!hasFor("first")) additions.push(make("first"));
  if (!hasFor("last")) additions.push(make("last"));
  if (!additions.length) return list;
  const idx = list.findIndex((e) => e.field_id === ctrl.field_id);
  if (idx === -1) return [...list, ...additions];
  return [...list.slice(0, idx + 1), ...additions, ...list.slice(idx + 1)];
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

/** Build the field records for an operator ADD-BACK of a delete-with-memory `removed_entry` (Phase 2):
 *  each remembered field is PREFILLED with the value that filled during the walk. A field that filled
 *  DETERMINISTICALLY is clean (approved-by-default, needs_review false); an AI-filled field or a field in
 *  `unfilled` (the ones that couldn't fill) needs review (verify / supply). Same "<sectionKey>[<index>].
 *  <rec>" id format as newEntryRecords, so replay's isRepeatingEntry re-creates the entry positionally. PURE. */
export function addBackEntryRecords(
  remembered: RememberedField[],
  unfilled: string[],
  meta: NewEntryMeta
): ReviewEntry[] {
  const m = meta || ({} as NewEntryMeta);
  const fpfx = (m.page != null ? m.page + "::" : "") + "formField-" + m.sectionKey + "[" + m.index + "].";
  const cpfx = m.sectionKey + "[" + m.index + "].";
  const unfilledSet = new Set(unfilled || []);
  return (remembered || []).map((s) => {
    const isAi = typeof s.filled_by === "string" && s.filled_by.indexOf("ai-") === 0;
    const hasValue = s.value != null && String(s.value).trim() !== "";
    const mustAttend = unfilledSet.has(s.recName) || !hasValue || isAi; // supply (unfilled) or verify (AI)
    return {
      field_id: fpfx + s.recName,
      page: m.page != null ? m.page : null,
      field_index: null,
      question_label: s.label != null ? s.label : s.recName,
      widget_type: s.widget_type,
      canonical_field: cpfx + (s.path != null ? s.path : s.recName),
      is_required: !!s.is_required,
      current_value: hasValue ? s.value : null,
      original_ai_value: isAi && hasValue ? s.value : null,
      is_edited: true,
      edit_kind: "added_entry" as const,
      is_added: true,
      added_at: m.at != null ? m.at : null,
      is_approved: false,
      approved_at: null,
      page_number: m.pageNumber != null ? m.pageNumber : null,
      page_label: m.pageLabel != null ? m.pageLabel : null,
      confidence: isAi ? ("low" as const) : hasValue ? ("high" as const) : ("none" as const),
      confidence_source: isAi ? "ai_inference" : hasValue ? "profile_direct" : "added",
      needs_review: mustAttend,
      needs_review_reason: mustAttend ? (isAi && hasValue ? "ai_inferred" : "added_entry") : null,
      fill_status: hasValue ? "filled" : "not_filled",
      fill_error: null,
      detail: hasValue
        ? isAi
          ? "AI-filled during the walk — verify"
          : "prefilled from your profile (filled cleanly during the walk)"
        : "add-back: supply this field, then approve",
      match_tier: s.match_tier || null,
      flag: isAi ? s.filled_by : hasValue ? null : "added-entry",
      options: Array.isArray(s.options) ? s.options : null,
      captured_options: null,
      tree_structure: null,
      date_order: Array.isArray(s.date_order) ? s.date_order : null,
      tiers: null,
      character_count: null,
    };
  });
}

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
