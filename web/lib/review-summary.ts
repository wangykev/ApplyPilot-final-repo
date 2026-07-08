/**
 * Types + presentation helpers for the hosted review summary — the web render of
 * the extension's `reviewSummary` bundle (kept in lockstep with the extension's
 * buildReviewBundle / summary.js; see WEBSITE.md → Data contracts). Read-only
 * viewer for now; editing/replay stays in the extension.
 */

export type ReviewEntry = {
  field_id: string;
  question_label?: string | null;
  widget_type?: string | null;
  canonical_field?: string | null;
  is_required?: boolean;
  current_value?: string | null;
  original_ai_value?: string | null;
  is_edited?: boolean;
  confidence?: "high" | "medium" | "low" | "none" | null;
  confidence_source?: string | null;
  needs_review?: boolean;
  needs_review_reason?: string | null;
  fill_status?: string | null;
  flag?: string | null;
  match_tier?: string | null;
  detail?: string | null;
  options?: string[] | null;
  captured_options?: string[] | null;
};

export type ReviewBundle = {
  schema_version?: string;
  page?: string | null;
  url?: string | null;
  tenant?: string | null;
  captured_at?: string | null;
  total?: number;
  needs_review_count?: number;
  counts?: Record<string, number>;
  by_type?: Record<string, number>;
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
