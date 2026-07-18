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
  /** EEO/legal — drives the review provenance badge + a save-time warning. */
  sensitive: z.boolean().default(false),
  /** The question wordings (raw, human-readable) that resolve to this answer. */
  questions: z.array(z.string()).default([]),
  /** Optional per-platform stable-selector accelerators (workday automation-ids, etc.). */
  selectors: z.record(z.array(z.string())).default({}),
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
    sensitive: false,
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
    sensitive: false,
    questions: ["Are you at least 18 years of age?", "Are you over the age of 18?"],
    selectors: {},
  },
  {
    id: "gender",
    profile_path: "self_identification.gender",
    value: [],
    category: "",
    widget_hint: "dropdown",
    sensitive: true,
    questions: ["Gender", "What is your gender?"],
    selectors: {},
  },
];
