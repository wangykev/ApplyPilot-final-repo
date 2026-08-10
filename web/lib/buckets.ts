import { z } from "zod";

/**
 * Answer buckets — the platform-agnostic answer store (see docs/profile-v2-plan.md).
 * A bucket is ONE canonical answer + the question wordings that resolve to it.
 *
 *  - Mode A (profile_path set): the value comes from the profile field — editing
 *    the field re-fills every wording, on every platform. No answer stored here.
 *  - Mode B (profile_path empty): the value lives in `value` (standalone; the
 *    long tail with no schema home). Promotable to a profile field later.
 *
 * Stored as a jsonb array in profiles.buckets_json and synced to the extension,
 * which matches a live question's normalized label against `questions` — before
 * the AI pass, match-ladder-gated (never a blind commit).
 */

export const bucketSchema = z.object({
  id: z.string(),
  /** Mode A: dotted profile path (e.g. "work_authorization.authorized_to_work_in_us"). "" ⇒ Mode B. */
  profile_path: z.string().default(""),
  /** Mode B standalone answer as a CANDIDATE LIST (most-specific first): text uses value[0], choice
   *  widgets pass the whole list through the match ladder (fills like a tiered dropdown/typeahead).
   *  Ignored when profile_path is set (Mode A). */
  value: z.array(z.string()).default([]),
  /** Grouping for the buckets UI. Mode B: chosen by the user (AI-suggested). Mode A: derived from the
   *  profile field's section, so it's normally left blank on Mode-A buckets. */
  category: z.string().default(""),
  /** text | dropdown | radio | typeahead | checkbox (essays/files are never bucketed). */
  widget_hint: z.string().default(""),
  /** The question wordings (raw, human-readable) that resolve to this answer. */
  questions: z.array(z.string()).default([]),
  /** Optional per-platform stable-selector accelerators (workday automation-ids, etc.). */
  selectors: z.record(z.array(z.string())).default({}),
  /**
   * ARCHIVED — the taught wordings are kept but dormant, because the profile answer this bucket points
   * at changed out from under it. OPTIONAL rather than defaulted on purpose: every existing Bucket
   * literal in the codebase (starters, teach.ts, tests) predates these fields, and making them required
   * would force a churn edit through all of them for no behavioural gain. Absent === active.
   */
  archived: z.boolean().optional(),
  /** The answer this bucket was taught AGAINST, recorded when archiving so it can be restored. */
  archived_answer: z.string().optional(),
});
export type Bucket = z.infer<typeof bucketSchema>;

export const bucketsSchema = z.array(bucketSchema).default([]);

// Back-compat: older buckets stored `value` as a single string; the schema now expects a candidate
// list. Upgrade string → [string] ("" → []) BEFORE safeParse so legacy rows aren't dropped.
function upgradeBucket(item: unknown): unknown {
  if (!item || typeof item !== "object") return item;
  const v = (item as { value?: unknown }).value;
  if (typeof v === "string") return { ...(item as object), value: v.trim() === "" ? [] : [v] };
  return item;
}

/** Tolerant loader — never throws; drops malformed entries; upgrades legacy string values. */
export function coerceBuckets(raw: unknown): Bucket[] {
  if (!Array.isArray(raw)) return [];
  const out: Bucket[] = [];
  for (const item of raw) {
    const parsed = bucketSchema.safeParse(upgradeBucket(item));
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * Normalize a question label to its match key: strip a trailing required marker
 * (asterisk or double-asterisk) + whitespace, lowercase, collapse internal
 * whitespace. MUST stay in lockstep with the extension's label normalization so
 * a wording added here matches the live form label at fill time.
 */
export function normalizeQuestion(label: string): string {
  return String(label || "")
    .replace(/[*\s]+$/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function isModeA(b: Bucket): boolean {
  return b.profile_path.trim() !== "";
}

/**
 * Approved starter set copied into a new user's buckets_json at signup. Mode A
 * ONLY — wording → profile-field bindings, never a pre-filled standalone answer
 * (the value always comes from the user's own profile). Deliberately small;
 * grow it as forms are tested. Every binding is a candidate that still clears
 * the extension's match ladder against the live options, so a binding can never
 * blind-commit a wrong value.
 */
export const STARTER_BUCKETS: Bucket[] = [
  {
    id: "work_auth_us",
    profile_path: "work_authorization.authorized_to_work_in_us",
    value: [],
    category: "",
    widget_hint: "radio",
    questions: [
      "Are you legally authorized to work in the United States?",
      "Are you authorized to work in the US?",
      "Do you have the legal right to work in the United States?",
    ],
    selectors: {},
  },
  {
    id: "over_18",
    profile_path: "screening.at_least_18_years_old",
    value: [],
    category: "",
    widget_hint: "radio",
    questions: ["Are you at least 18 years of age?", "Are you over the age of 18?"],
    selectors: {},
  },
  {
    id: "gender",
    profile_path: "self_identification.gender",
    value: [],
    category: "",
    widget_hint: "dropdown",
    questions: ["Gender", "What is your gender?"],
    selectors: {},
  },
  // Education / work-experience FLAT fields: many forms ask these as individual questions (a single
  // "School", "GPA", etc.) rather than a repeat-add section. These Mode-A bindings to the PRIMARY entry
  // (education[0] / work_experience[0]) let a flat question fill from the profile by matching its label.
  // On a REPEATING tenant these never fire (the flat scan excludes fields inside repeating containers),
  // so the section fill still owns those. Dates/textareas aren't bucket-fillable yet, so they're omitted.
  {
    id: "edu_school",
    profile_path: "education.0.school_or_university",
    value: [],
    category: "Education",
    widget_hint: "text",
    questions: ["School", "University", "College", "Institution", "School or University", "School name"],
    selectors: {},
  },
  {
    id: "edu_gpa",
    profile_path: "education.0.gpa",
    value: [],
    category: "Education",
    widget_hint: "text",
    questions: ["GPA", "Grade point average", "Cumulative GPA", "Grade Point Average (GPA)"],
    selectors: {},
  },
  {
    id: "edu_degree",
    profile_path: "education.0.degree",
    value: [],
    category: "Education",
    widget_hint: "typeahead",
    questions: ["Degree", "Degree earned", "Degree type", "Degree received", "Level of education"],
    selectors: {},
  },
  {
    id: "edu_field_of_study",
    profile_path: "education.0.field_of_study",
    value: [],
    category: "Education",
    widget_hint: "typeahead",
    questions: ["Major", "Field of study", "Area of study", "Major / Field of study", "Concentration"],
    selectors: {},
  },
  {
    id: "we_job_title",
    profile_path: "work_experience.0.job_title",
    value: [],
    category: "Experience",
    widget_hint: "text",
    questions: ["Job title", "Title", "Position", "Job Title", "Role"],
    selectors: {},
  },
  {
    id: "we_company",
    profile_path: "work_experience.0.company",
    value: [],
    category: "Experience",
    widget_hint: "text",
    questions: ["Company", "Employer", "Company name", "Organization", "Employer name"],
    selectors: {},
  },
];

/**
 * Add any Mode-A starter bucket whose `profile_path` isn't already present in `buckets` — so an EXISTING
 * user (whose buckets_json predates a newly-shipped starter, e.g. the education/work-experience field
 * bindings) still gets those bindings. Dedup is by `profile_path`; an existing bucket's wordings/values
 * are never touched. Applied on LOAD (not persisted), so it's idempotent. Caveat: a starter the user
 * fully DELETED reappears — acceptable for these wording-only Mode-A bindings (the value still comes
 * from the profile, and an extra wording only makes the field match more questions).
 */
export function ensureStarterBuckets(buckets: Bucket[]): Bucket[] {
  const havePaths = new Set(buckets.map((b) => b.profile_path.trim()).filter(Boolean));
  const add = STARTER_BUCKETS.filter((s) => s.profile_path.trim() && !havePaths.has(s.profile_path.trim()));
  return add.length ? [...buckets, ...add] : buckets;
}

// ── BUCKETS vs a PROFILE THAT JUST CHANGED ──────────────────────────────────────────────────────
// A Mode-A bucket stores only a `profile_path`: its ANSWER is whatever the profile holds there. So
// nothing has to DELETE a bucket for it to look emptied — overwriting the profile value underneath it
// is enough. Applying a rewritten resume does exactly that, and the operator watched buckets go blank
// (2026-08-10). The resume-apply code had guarded the index-keyed `answer_ladders` against the same
// hazard and missed buckets entirely, because they live in a different column it never loaded.
//
// The rule, operator-stated: an answer that did not change leaves its bucket alone; an answer that DID
// change may retire the bucket, but the taught wordings are kept in the background and come back if the
// answer returns. Teaching a wording is manual work — an import must be able to park it, never destroy it.
//
// Mode-B buckets carry their own `value` and are never touched here: no profile edit can invalidate them.

/** Read a dotted path ("education.0.gpa") out of a profile-shaped object. */
function readPath(root: unknown, path: string): unknown {
  if (!path) return undefined;
  let cur: unknown = root;
  for (const seg of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** The comparable form of a bucket's answer. Tiered arrays compare by content, not identity. */
function answerKey(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean).join(" | ");
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v).trim();
}

export type BucketReconcile = {
  buckets: Bucket[];
  /** Wordings parked because their answer changed. */
  archived: { path: string; from: string; to: string; questions: number }[];
  /** Wordings brought back because their answer returned. */
  restored: { path: string; answer: string; questions: number }[];
};

/**
 * Re-point the bucket set at a profile that just changed. `before`/`after` are the profile on either
 * side of the edit. Pure — the caller persists.
 */
export function reconcileBucketsToProfile(
  buckets: Bucket[],
  before: unknown,
  after: unknown,
): BucketReconcile {
  const archived: BucketReconcile["archived"] = [];
  const restored: BucketReconcile["restored"] = [];

  const out = buckets.map((b) => {
    const path = b.profile_path.trim();
    if (!path) return b; // Mode B — its answer lives in the bucket itself
    const nowKey = answerKey(readPath(after, path));

    if (b.archived) {
      // Only an EXACT return of the answer it was taught against restores it. A different answer is a
      // different question, and re-attaching old wordings to it would be exactly the silent-wrong-answer
      // failure buckets exist to prevent.
      if (b.archived_answer && nowKey === b.archived_answer) {
        restored.push({ path, answer: nowKey, questions: b.questions.length });
        return { ...b, archived: false, archived_answer: "" };
      }
      return b;
    }

    const wasKey = answerKey(readPath(before, path));
    if (wasKey === nowKey) return b; // unchanged → leave it completely alone
    // An answer that went BLANK is still a change, and it is the common one here: an import that
    // shortened work_experience leaves "work_experience.2.*" pointing at nothing.
    archived.push({ path, from: wasKey, to: nowKey, questions: b.questions.length });
    return { ...b, archived: true, archived_answer: wasKey };
  });

  return { buckets: out, archived, restored };
}

/** The buckets that answer questions at fill time. Archived ones are dormant, not deleted. */
export function activeBuckets(buckets: Bucket[]): Bucket[] {
  return buckets.filter((b) => !b.archived);
}
