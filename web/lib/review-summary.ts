/**
 * Types + presentation helpers for the hosted review summary — the web render of
 * the extension's `reviewSummary` bundle (kept in lockstep with the extension's
 * buildReviewBundle / summary.js; see WEBSITE.md → Data contracts).
 *
 * The website is now the PRIMARY review surface (editing + approval), replacing
 * the extension's summary.html viewer. The pure edit/approval transforms live in
 * `review-approval.ts` (faithful port of the extension's summary-lib.js) and the
 * model helpers in `review-model.ts` (port of summary.js's pure grouping). The
 * edited+approved bundle is persisted back to `applications.review_bundle_json`
 * and PULLED by the extension before replay. The extension's summary.html stays
 * as a fallback until the web path is live-verified.
 */

/** A field-shape stub for an operator-added repeating entry (mirrors the engine's
 *  section_field_shape / summary.js sectionShapeFor). */
export type FieldShape = {
  recName: string;
  path?: string | null;
  widget_type?: string | null;
  is_required?: boolean;
  label?: string | null;
  options?: string[] | null;
  captured_options?: string[] | null;
  tree_structure?: TreeStructure | null;
  date_order?: string[] | null;
};

export type TreeStructure = { chosen?: string | null; leaves?: string[] | null } | null;

/** Phase 2 (delete-with-memory): one field of a `removed_entry` — the value that filled (if any) and
 *  HOW, so an add-back reconstructs the entry PREFILLED. `filled_by`: "deterministic" | an `ai-*` flag |
 *  "unfilled". Mirrors the engine's makeRemovedEntry.remembered_fields. */
export type RememberedField = {
  recName: string;
  path?: string | null;
  widget_type?: string | null;
  label?: string | null;
  is_required?: boolean;
  value?: string | null;
  filled_by?: string | null;
  match_tier?: string | null;
  options?: string[] | null;
  date_order?: string[] | null;
};

export type ReviewEntry = {
  field_id: string;
  page?: string | null; // the STABLE merge key (cdpPageKey / field-set key), NOT the human label
  page_number?: number | null; // walk ordinal (display order; null = single page)
  page_label?: string | null; // friendly page caption
  field_index?: number | null;
  question_label?: string | null;
  widget_type?: string | null;
  canonical_field?: string | null;
  is_required?: boolean;
  current_value?: string | null; // the value actually filled / edited (what replay reads)
  original_ai_value?: string | null; // the bot's pick at write time (never changed by edits)
  is_edited?: boolean;
  edit_kind?: "override" | "filled_blank" | "cleared" | "added_entry" | null;
  confidence?: "high" | "medium" | "low" | "none" | null;
  confidence_source?: string | null;
  needs_review?: boolean;
  needs_review_reason?: string | null;
  fill_status?: string | null;
  fill_error?: string | null;
  flag?: string | null;
  match_tier?: string | null;
  detail?: string | null;
  options?: string[] | null; // full list, plain dropdowns
  captured_options?: string[] | null; // partial filtered set, typeaheads
  options_partial?: boolean | null;   // the FILL says these are a filtered view, not the whole list
  // checkbox_group: the AUTHORITATIVE selection, because a group can hold more than one (traced live
  // on PSECU's ethnicityMulti — two options checked, both saved). current_value stays the joined
  // display string so the blank tests / submit gate / review reconcile keep reading one value.
  selected_options?: string[] | null;
  // ⚠ A CREDENTIAL FIELD CARRIES NO VALUE. On a form whose account is created by the submission
  // (iCIMS), the login/password are ordinary fields, but `current_value` is the placeholder
  // "(stored login)" — the secret is never put in the bundle, because the bundle lives on the
  // application row in Supabase. These two say WHICH credential the field wants, so the editor can
  // render it as a login box and read the real value from the account's own credentials record.
  credential?: boolean | null;
  credential_kind?: string | null; // "login" | "password" | "password_confirm"
  tree_structure?: TreeStructure; // cert/source tree-AI (chosen category + leaves)
  date_order?: string[] | null; // segment order for the segmented date editor
  tiers?: string[] | null; // ordered candidate list for a hierarchical/tree field
  character_count?: number | null;

  // ── editing / approval state (was extension-local; now website-owned) ──
  is_approved?: boolean;
  approved_at?: string | null;
  is_deleted?: boolean; // soft-delete for repeating entries (replay honors it)
  is_added?: boolean; // operator-added entry (must be CREATED on the form, not matched)
  added_at?: string | null;
  cascade_revealed?: boolean; // appeared only after another value committed → force review

  // Profile Learning piggyback (Buckets M4): the fill AI's routing hints the teach flow reads —
  // maps_to = the profile field this question maps to ("" = none), suggested_category = a bucket group.
  maps_to?: string | null;
  suggested_category?: string | null;

  // ── repeating / nested section metadata (grouping + add-entry) ──
  section_heading?: string | null; // real DOM heading for an unknown section
  section_field_shape?: FieldShape[] | null; // shape stub for an empty section / nested sub-section
  section_known?: boolean;
  // Phase 2 (delete-with-memory): a `removed_entry` card — the entry the fill DELETED (a required field
  // couldn't be filled) but REMEMBERED, so the review offers add-back-with-prefill.
  remembered_fields?: RememberedField[] | null; // per-field: what filled + how (prefill on add-back)
  unfilled_fields?: { recName: string; label?: string | null }[] | null; // the field(s) to supply/verify
  nested_shapes?: Record<string, FieldShape[]> | null; // nested sub-section shapes (cert ▸ specialties)
  nested_attachments?: boolean | null;
  container_prefix?: string | null;
  nested_parent?: { base: string; index: number } | null;
  nested_child_base?: string | null;
};

export type ApprovalEnvelope = {
  to_approve_count: number;
  approved_count: number;
  pending_count: number;
  unreplaced_placeholders: number;
  /** REQUIRED fields still holding no value — Workday refuses the page, so submit_ready is false. */
  required_blank?: number;
  all_approved: boolean;
  submit_ready: boolean;
};

/** WHY a fill didn't reach the review page (stamped by the extension's runCdpWalk finally). Drives the
 *  loud halt banner on the review page. `completed` = reached the review page (whole app filled). */
export type WalkStatus = {
  completed: boolean;
  stopped_page?: number | null;
  page_errors?: string[]; // Workday's top-of-page error text (e.g. "32312 is not a valid postal code…")
  error_text?: string | null;
  empty_fields?: { field: string; reason: string }[]; // required fields with no profile value
  cancelled?: boolean; // operator cancelled the run mid-fill
};

export type ReviewBundle = {
  schema_version?: string;
  /** Which pipeline filled this: "workday" | "greenhouse" | "lever" | "ashby". The extension has
   *  written it since 2026-08-02 (a submit run cannot re-derive it from an employer URL). The UI
   *  needs it because the one-page ATSs have NO review page, so Workday's "stopped before the review
   *  page" wording describes something that does not exist on them. */
  ats?: string | null;
  page?: string | null;
  page_number?: number | null;
  page_label?: string | null;
  url?: string | null;
  tenant?: string | null;
  captured_at?: string | null;
  total?: number;
  needs_review_count?: number;
  counts?: Record<string, number>;
  by_type?: Record<string, number>;
  section_shapes?: Record<string, FieldShape[]> | null; // DOM-detected field sets, per section key
  approval?: ApprovalEnvelope | null; // viewer roll-up (kept in the bundle, persisted on write)
  walk_status?: WalkStatus | null; // WHY the fill stopped (halt banner); absent on older bundles
  entries: ReviewEntry[];
};

export type BadgeTone = "crit" | "warn" | "info";
export type Badge = { label: string; tone: BadgeTone };

/** The badge + prominence for a needs-review entry — prominence off the FLAG,
 *  never confidence (a high-confidence reasoning-from-absence answer must not be
 *  the easiest to scroll past). Mirrors summary.js. */
export function deriveBadge(e: ReviewEntry): Badge {
  const flag = (e.flag ?? "").toLowerCase();
  const reason = (e.needs_review_reason ?? "").toLowerCase();

  if (flag.includes("needs-answer") || reason === "ai_needs_answer" || reason === "ai_no_answer")
    return { label: "Needs answer", tone: "crit" };
  if (flag.includes("sensitive") || reason === "ai_inferred_sensitive")
    return { label: "Legally-loaded — verify", tone: "crit" };
  if (reason === "required_field_empty" || reason === "unmapped_required_field")
    return { label: "Required — empty", tone: "crit" };
  if (flag.includes("eeo") || reason === "ai_eeo_inferred" || reason === "eeo_declined")
    return { label: "AI-guessed demographic — verify", tone: "warn" };
  if (flag.includes("forced") || flag.includes("closest"))
    return { label: "AI forced a pick", tone: "warn" };
  if (reason === "employer_match_uncertain")
    return { label: "Employer match — verify", tone: "warn" };
  if (e.confidence === "low" && (flag.startsWith("ai") || e.confidence_source === "ai_inference"))
    return { label: "Low-confidence AI", tone: "warn" };
  if (reason === "fill_error" || e.fill_status === "error")
    return { label: "Fill error", tone: "crit" };
  if (flag.startsWith("ai") || e.confidence_source === "ai_inference")
    return { label: "AI-inferred", tone: "info" };
  return { label: "Review", tone: "warn" };
}

const TONE_RANK: Record<BadgeTone, number> = { crit: 3, warn: 2, info: 1 };

/** Sort key for the needs-review list: most-prominent first. */
export function prominence(e: ReviewEntry): number {
  return TONE_RANK[deriveBadge(e).tone];
}

const SECTION_LABELS: Record<string, string> = {
  personal_info: "Personal information",
  work_experience: "Work experience",
  workExperience: "Work experience",
  education: "Education",
  websites: "Websites",
  languages: "Languages",
  certifications: "Certifications",
  work_authorization: "Work authorization",
  self_identification: "Self-identification",
  screening: "Screening",
  how_did_you_hear: "How did you hear",
};

/** Group label for an entry, from its canonical_field prefix. */
export function sectionOf(e: ReviewEntry): string {
  const cf = e.canonical_field ?? "";
  if (!cf) return "Other fields";
  const head = cf.split(/[.[]/)[0];
  return SECTION_LABELS[head] ?? head.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** ok / verified vs needs-review vs skipped/empty — the reused status vocabulary. */
export function statusKind(e: ReviewEntry): "verified" | "review" | "error" | "skip" {
  if (e.needs_review) return "review";
  if (e.fill_status === "error") return "error";
  if (e.fill_status === "filled" || e.fill_status === "filled_review") return "verified";
  return "skip";
}

export function groupBySection(entries: ReviewEntry[]): { section: string; entries: ReviewEntry[] }[] {
  const map = new Map<string, ReviewEntry[]>();
  for (const e of entries) {
    const s = sectionOf(e);
    if (!map.has(s)) map.set(s, []);
    map.get(s)!.push(e);
  }
  return Array.from(map, ([section, es]) => ({ section, entries: es }));
}
