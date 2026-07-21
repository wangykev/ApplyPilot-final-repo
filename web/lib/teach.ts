import { normalizeQuestion, type Bucket } from "@/lib/buckets";
import type { ReviewEntry, ReviewBundle } from "@/lib/review-summary";

/**
 * Pure logic for the "teach the tool" flow (see docs/profile-v2-plan.md → teach).
 * After a fill is reviewed + APPROVED on the website, its AI-answered questions become
 * teaching candidates: the user adds each to an answer bucket (a wording on an existing
 * bucket, or a new standalone Mode-B bucket) so it fills deterministically next time.
 * No DOM / Supabase / React here — the page does the I/O.
 */

/** Widget types that can be remembered as a bucket (essays/files are never bucketed). */
const BUCKET_ELIGIBLE = new Set(["text", "dropdown", "radio", "typeahead", "checkbox"]);
export function isBucketEligibleWidget(w?: string | null): boolean {
  return BUCKET_ELIGIBLE.has(String(w || ""));
}

/** Read a dotted profile path → a display string (a tiered array shows its first candidate). */
export function profileValueAt(profile: unknown, path: string): string {
  if (!path) return "";
  const v = String(path)
    .split(".")
    .reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), profile);
  if (Array.isArray(v)) return v.length ? String(v[0]) : "";
  return v == null ? "" : String(v);
}

export type TeachCard = {
  key: string; // normalizeQuestion(question) — identity + dedup key
  question: string; // verbatim label (what gets stored as the bucket wording)
  answer: string; // the approved / edited value
  widget: string; // widget_type
  sensitive: boolean; // legally-loaded / EEO (from the flag)
  maps_to: string; // fill-time AI piggyback hint: the profile field this Q maps to ("" = none)
  canonical_field: string; // the field's MAPPED home (FIELD_MAP), if any — a KNOWN target, no LLM needed
  match_tier: string; // how it filled ("containment"/"fuzzy-NN"/…) — a fuzzy/containment tier ⇒ possible typo/variant
  suggested_category: string; // piggyback hint: a category for a new standalone bucket
  profile_value: string; // the profile's value at the KNOWN path (canonical_field || maps_to) — for the same-vs-different check
  app_id: string; // source application (reference only)
  company: string | null;
};

/** Whether a match_tier indicates a fuzzy / containment (near) match — a likely typo/variant. */
export function isFuzzyTier(matchTier?: string | null): boolean {
  const t = String(matchTier || "");
  return t === "containment" || /^fuzzy/.test(t);
}

export type TeachSource = { id: string; company?: string | null; bundle: ReviewBundle | null };

/** A human value edit on review that represents a corrected answer worth remembering — an override, or
 *  a filled-in blank. A `cleared` edit (the field is now empty) or an `added_entry` (a new repeating row,
 *  not a question→answer) is NOT a teachable answer. */
export function wasManuallyEdited(e: ReviewEntry): boolean {
  return !!e.is_edited && e.edit_kind !== "cleared" && e.edit_kind !== "added_entry";
}

/** A teachable pair, either:
 *   • an APPROVED fill that DIDN'T fill deterministically (needs_review — an AI guess, a no-match the
 *     human answered, a fuzzy/containment match…); OR
 *   • a MANUAL EDIT on review (`wasManuallyEdited` — an override / filled-in blank). The user typed this
 *     value themselves, so it's their own answer and teaches EVEN THOUGH the edit reset its approval
 *     (the review editor clears `is_approved` on any value edit, to force a submit re-review — a
 *     submit concern, not a teach one). The teach popup is its own confirm gate.
 *  A clean, untouched deterministic fill (needs_review=false, not edited) is skipped — already known.
 *  Must be bucket-eligible with a real question + a non-empty value. */
/** A repeating / nested SECTION field (education[0].degree, certification[1].specialties[0].x). Its answer
 *  is PER-ENTRY structured profile data filled by the section machinery, which does NOT consult buckets — so
 *  it is NOT a label→answer teach candidate (a "Degree" bucket would never fire on a repeating fill and would
 *  wrongly apply ONE value to EVERY entry). This also implements the operator's Phase-4 rule: for a
 *  delete-with-memory add-back, the deterministically-filled fields (school/degree) don't teach; and the
 *  AI/manually-supplied field isn't bucket-taught either — a repeating answer is learned by editing the
 *  profile's LIST (the profile page), not by a bucket. */
function isRepeatingSectionField(e: ReviewEntry): boolean {
  return /\[\d+\]\./.test(String(e.canonical_field || "")) || /\[\d+\]\./.test(String(e.field_id || ""));
}

function isTeachable(e: ReviewEntry): boolean {
  const edited = wasManuallyEdited(e);
  return (
    !e.is_deleted &&
    !isRepeatingSectionField(e) && // per-entry structured data → learned by editing the profile list, not a bucket
    (edited || (!!e.is_approved && !!e.needs_review)) &&
    isBucketEligibleWidget(e.widget_type) &&
    !!e.question_label &&
    normalizeQuestion(e.question_label) !== "" &&
    e.current_value != null &&
    String(e.current_value).trim() !== ""
  );
}

/** Normalized wordings already covered by SOME bucket (so a taught question won't reappear). */
export function coveredKeys(buckets: Bucket[]): Set<string> {
  const s = new Set<string>();
  for (const b of buckets) for (const q of b.questions || []) {
    const k = normalizeQuestion(q);
    if (k) s.add(k);
  }
  return s;
}

/** Teachable cards across the user's reviewed applications — deduped by question, excluding
 *  anything already covered by a bucket OR explicitly dismissed (skipped). Most-recent application
 *  wins a duplicate. */
export function teachableCards(
  apps: TeachSource[],
  buckets: Bucket[],
  profile: unknown,
  dismissed?: Iterable<string>,
): TeachCard[] {
  const covered = coveredKeys(buckets);
  const skipped = new Set<string>(dismissed || []);
  const seen = new Set<string>();
  const cards: TeachCard[] = [];
  for (const app of apps) {
    for (const e of app.bundle?.entries || []) {
      if (!isTeachable(e)) continue;
      const key = normalizeQuestion(e.question_label as string);
      if (covered.has(key) || skipped.has(key) || seen.has(key)) continue;
      seen.add(key);
      const maps_to = e.maps_to || "";
      const canonical_field = e.canonical_field || "";
      const known = canonical_field || maps_to; // the deterministic mapped home wins over the AI hint
      cards.push({
        key,
        question: e.question_label as string,
        answer: String(e.current_value),
        widget: String(e.widget_type || "text"),
        sensitive: typeof e.flag === "string" && /sensitive|eeo/.test(e.flag),
        maps_to,
        canonical_field,
        match_tier: e.match_tier || "",
        suggested_category: e.suggested_category || "",
        profile_value: known ? profileValueAt(profile, known) : "",
        app_id: app.id,
        company: app.company ?? null,
      });
    }
  }
  return cards;
}

/** Same-vs-different answer for the add-wording-vs-new-bucket decision (normalize per the plan). */
export function sameAnswer(a: string, b: string): boolean {
  const n = (s: string) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
  return !!n(a) && n(a) === n(b);
}

/** Raw value at a dotted path (arrays PRESERVED, unlike profileValueAt which collapses to the first). */
function rawAt(profile: unknown, path: string): unknown {
  if (!path) return undefined;
  return String(path)
    .split(".")
    .reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), profile);
}

/** Whether the profile field at `path` ALREADY holds `answer` — for a tiered array, ANY candidate
 *  counts; a boolean is compared as Yes/No; a scalar is compared normalized. */
export function fieldHoldsAnswer(profile: unknown, path: string, answer: string): boolean {
  const raw = rawAt(profile, path);
  if (Array.isArray(raw)) return raw.some((v) => typeof v === "string" && sameAnswer(v, answer));
  if (typeof raw === "boolean") return sameAnswer(raw ? "Yes" : "No", answer);
  return raw != null && sameAnswer(String(raw), answer);
}

/** Which route the teach confirm popup takes when a card is added to a chosen profile field:
 *  - "wording": the field already holds the card's answer → only the phrasing is missing, so add the
 *    wording (the value stays untouched);
 *  - "answer":  the field is empty OR holds a different value → set / append the answer (and file the
 *    wording too, so the card is fully taught).
 *  Splitting these is what makes the popup show exactly "the question OR the answer" that's missing. */
export type TeachRoute = "answer" | "wording";
export function decideTeachRoute(profile: unknown, path: string, answer: string): TeachRoute {
  return fieldHoldsAnswer(profile, path, answer) ? "wording" : "answer";
}

/** Add a wording to a bucket (by id), deduped by normalizeQuestion. Returns a NEW array. */
export function addWordingToBucket(buckets: Bucket[], bucketId: string, wording: string): Bucket[] {
  const k = normalizeQuestion(wording);
  return buckets.map((b) => {
    if (b.id !== bucketId) return b;
    if ((b.questions || []).some((q) => normalizeQuestion(q) === k)) return b;
    return { ...b, questions: [...(b.questions || []), wording] };
  });
}

/** Ensure a Mode-A bucket bound to `path` exists; returns the (possibly extended) buckets + its id. */
export function ensureModeABucket(buckets: Bucket[], path: string, widget: string): { buckets: Bucket[]; bucketId: string } {
  const p = String(path).trim();
  const existing = buckets.find((b) => b.profile_path.trim() === p);
  if (existing) return { buckets, bucketId: existing.id };
  const bucketId = "field_" + p.replace(/[^\w]+/g, "_");
  const nb: Bucket = { id: bucketId, profile_path: p, value: [], category: "", widget_hint: widget, questions: [], selectors: {} };
  return { buckets: [...buckets, nb], bucketId };
}

/** Create a new standalone (Mode-B) bucket with a unique id. Returns the new buckets + its id. */
export function createModeBBucket(
  buckets: Bucket[],
  spec: { question: string; value: string[]; category: string; widget_hint: string },
): { buckets: Bucket[]; bucketId: string } {
  const base = "custom_" + (normalizeQuestion(spec.question).replace(/[^\w]+/g, "_").slice(0, 40) || "answer");
  const ids = new Set(buckets.map((b) => b.id));
  let bucketId = base;
  let n = 1;
  while (ids.has(bucketId)) bucketId = base + "_" + n++;
  const nb: Bucket = {
    id: bucketId,
    profile_path: "",
    value: spec.value.filter((v) => v.trim() !== ""),
    category: spec.category || "Other",
    widget_hint: spec.widget_hint || "text",
    questions: [spec.question],
    selectors: {},
  };
  return { buckets: [...buckets, nb], bucketId };
}

/** A short human label for a bucket in the "add to existing" picker. */
export function bucketLabel(b: Bucket): string {
  if (b.profile_path) return b.profile_path;
  return b.questions[0] || "(untitled answer)";
}

/** Title-case a snake_case field/section key ("state_province" → "State Province"). */
export function humanize(key: string): string {
  return String(key || "")
    .split(".")
    .pop()!
    .replace(/\[\d+\]/g, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** One displayable profile field for the teach page's profile panel. */
export type ProfileFieldRow = { path: string; label: string; value: string; section: string; sectionLabel: string };

/**
 * Flatten the profile's OBJECT sections (personal_info, work_authorization, self_identification,
 * screening, …) into scalar/boolean/tiered rows (path = "section.field") — the maps_to targets a
 * screening question resolves to. Repeating array sections (work_experience, education, skills…) and
 * nested objects are skipped; a boolean shows Yes/No, a tiered array shows its first candidate.
 */
export function flattenProfileFields(profile: unknown): ProfileFieldRow[] {
  const rows: ProfileFieldRow[] = [];
  if (!profile || typeof profile !== "object") return rows;
  const p = profile as Record<string, unknown>;
  for (const section of Object.keys(p)) {
    const sv = p[section];
    if (!sv || typeof sv !== "object" || Array.isArray(sv)) continue; // object sections only
    const sectionLabel = humanize(section);
    for (const field of Object.keys(sv as Record<string, unknown>)) {
      const v = (sv as Record<string, unknown>)[field];
      let value: string;
      if (v == null) value = "";
      else if (typeof v === "string") value = v;
      else if (typeof v === "boolean") value = v ? "Yes" : "No";
      else if (Array.isArray(v)) {
        if (v.length === 0) value = "";
        else if (v.every((x) => typeof x === "string")) value = (v as string[])[0];
        else continue; // array of objects → skip
      } else continue; // nested object → skip
      rows.push({ path: section + "." + field, label: humanize(field), value, section, sectionLabel });
    }
  }
  return rows;
}
