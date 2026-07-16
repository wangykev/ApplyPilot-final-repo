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

  // ── repeating / nested section metadata (grouping + add-entry) ──
  section_heading?: string | null; // real DOM heading for an unknown section
  section_field_shape?: FieldShape[] | null; // shape stub for an empty section / nested sub-section
  section_known?: boolean;
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
  all_approved: boolean;
  submit_ready: boolean;
};

export type ReviewBundle = {
  schema_version?: string;
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
