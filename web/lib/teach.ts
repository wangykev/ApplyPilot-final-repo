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

/** Read a dotted profile path → a display string (a tiered array shows its first candidate). A path
 *  that lands on an OBJECT or an array-of-objects (e.g. a whole repeating section like `education`) has
 *  no scalar display → "" (guards against rendering "[object Object]"). */
export function profileValueAt(profile: unknown, path: string): string {
  if (!path) return "";
  const v = String(path)
    .split(".")
    .reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), profile);
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "Yes" : "No"; // a yes/no (triBool) field → readable label, not "true"/"false"
  if (Array.isArray(v)) return v.length && typeof v[0] !== "object" ? String(v[0]) : "";
  return typeof v === "object" ? "" : String(v);
}

export type TeachCard = {
  key: string; // normalizeQuestion(question) — identity + dedup key
  question: string; // verbatim label (what gets stored as the bucket wording)
  answer: string; // the approved / edited value
  widget: string; // widget_type
  sensitive: boolean; // legally-loaded / EEO (from the flag)
  bucket_path: string; // AUTHORITATIVE: the profile field a Mode-A bucket binds this question to (wording match), "" = none
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

/** Normalize a repeating-section path to the DOTTED form the profile resolvers + the teach panel rows use:
 *  "education[0].degree" → "education.0.degree". The extension emits BRACKETED indexes in a bundle entry's
 *  canonical_field, but profileValueAt / getAtPath / setAtPath split on "." (and arrays index by "0"), and
 *  ProfilePanel rows are dotted — so without this a repeating field reads as "no value", never highlights,
 *  and can't be edited. A flat path (no brackets) passes through unchanged. */
export function dottedPath(path?: string | null): string {
  return String(path == null ? "" : path).replace(/\[(\d+)\]/g, ".$1");
}

/** The profile field a Mode-A bucket binds this question (by matching wording) to — the AUTHORITATIVE
 *  mapping (a bucket the operator or the starter set defined), preferred over a FIELD_MAP guess or the
 *  AI's `maps_to` hint. This is what fixes e.g. the over-18 card recommending its real field
 *  (screening.at_least_18_years_old) instead of the AI's hallucinated "education". "" when no Mode-A
 *  bucket wording matches. */
export function bucketBindingFor(buckets: Bucket[], questionKey: string): string {
  for (const b of buckets || []) {
    const path = String(b.profile_path || "").trim();
    if (!path) continue; // Mode-B (no bound field) → nothing to recommend
    if ((b.questions || []).some((q) => normalizeQuestion(q) === questionKey)) return dottedPath(path);
  }
  return "";
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
function isTeachable(e: ReviewEntry): boolean {
  // Operator rule (per-field, incl. repeating entries): the AI-filled / manually-supplied field of an
  // entry teaches (needs_review + approved, or a manual edit); a DETERMINISTICALLY-filled field does NOT
  // (needs_review=false, untouched → already known). The base condition below is exactly that split — it
  // applies to repeating-section fields too (an AI-canonicalized education[0].degree teaches; a clean
  // deterministic one doesn't). (No repeating-field exclusion — that was over-broad and dropped the very
  // AI-filled answers worth learning; reverted 2026-07-21.)
  const edited = wasManuallyEdited(e);
  return (
    !e.is_deleted &&
    (edited || (!!e.is_approved && !!e.needs_review)) &&
    isBucketEligibleWidget(e.widget_type) &&
    !!e.question_label &&
    normalizeQuestion(e.question_label) !== "" &&
    e.current_value != null &&
    String(e.current_value).trim() !== ""
  );
}

/** Whether a bucket would actually PRODUCE an answer — so it truly "covers" its questions.
 *  Mode-A (bound to a profile field) needs that field to hold a value; Mode-B needs a non-empty
 *  `value`. An EMPTY / unanswered bucket (e.g. the `over_18` starter bound to a profile field the
 *  operator left blank or ACCIDENTALLY REMOVED) does NOT cover: the fill can't use it (it AI-guesses
 *  instead), so the question must resurface in teach — where the operator is notified (the card's
 *  "no profile value" warning) and can add it back. Otherwise it's invisible to teach AND re-guessed
 *  on every fill, with no way to fix it except hunting through the profile. */
export function bucketAnswers(b: Bucket, profile: unknown): boolean {
  const path = String(b.profile_path || "").trim();
  if (path) {
    const raw = rawAt(profile, dottedPath(path)); // Mode-A → the bound profile value
    if (raw == null) return false;
    if (Array.isArray(raw)) return raw.some((v) => String(v).trim() !== "");
    if (typeof raw === "string") return raw.trim() !== "";
    return true; // boolean / number is a real answer (e.g. a triBool "No" / false)
  }
  const val = (b as { value?: unknown }).value; // Mode-B → its own candidate value
  if (Array.isArray(val)) return val.some((v) => String(v).trim() !== "");
  return String(val == null ? "" : val).trim() !== "";
}

/** Normalized wordings covered by an ANSWERABLE bucket (an empty/unanswered bucket does NOT hide its
 *  questions — see bucketAnswers). Takes the profile to resolve Mode-A buckets' bound values. */
export function coveredKeys(buckets: Bucket[], profile: unknown): Set<string> {
  const s = new Set<string>();
  for (const b of buckets) {
    if (!bucketAnswers(b, profile)) continue;
    for (const q of b.questions || []) {
      const k = normalizeQuestion(q);
      if (k) s.add(k);
    }
  }
  return s;
}

/** Whether an ANSWERABLE bucket both COVERS `questionKey` (a wording match) AND already HOLDS `answer`
 *  — i.e. it would fill this question with THIS value next time, so the question is genuinely handled.
 *  This is the #4 reconciliation: an AI fill on a covered wording means the bucket's saved value did
 *  NOT match the tenant's options this run, so the card must keep surfacing — UNTIL the operator TEACHES
 *  the value (sets the bound profile field, or adds it to a Mode-B bucket's candidates; see TeachAddPopup).
 *  Once the bucket holds the value, the card disappears and STAYS gone — no resurface on re-approve /
 *  reload even though the stored bundle entry keeps its `ai-*` flag forever (the bug this fixes). A
 *  no-value / value-mismatch covering bucket returns false → the card still surfaces. */
export function bucketCoversAnswer(buckets: Bucket[], profile: unknown, questionKey: string, answer: string): boolean {
  for (const b of buckets || []) {
    if (!bucketAnswers(b, profile)) continue; // an empty/unanswered bucket never covers
    if (!(b.questions || []).some((q) => normalizeQuestion(q) === questionKey)) continue; // wording not in this bucket
    const path = String(b.profile_path || "").trim();
    if (path) {
      if (fieldHoldsAnswer(profile, dottedPath(path), answer)) return true; // Mode-A: the bound field holds it
    } else {
      const val = (b as { value?: unknown }).value; // Mode-B: its candidate list holds it
      const arr = Array.isArray(val) ? val : val == null ? [] : [val];
      if (arr.some((v) => sameAnswer(String(v), answer))) return true;
    }
  }
  return false;
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
  const covered = coveredKeys(buckets, profile);
  const skipped = new Set<string>(dismissed || []);
  const seen = new Set<string>();
  const cards: TeachCard[] = [];
  for (const app of apps) {
    for (const e of app.bundle?.entries || []) {
      if (!isTeachable(e)) continue;
      const key = normalizeQuestion(e.question_label as string);
      // #4 + the resurface fix: a bucket "covers" a question only when it would actually fill it. For an
      // AI fill (flag ai-*), the bar is HIGHER — the covering bucket must already HOLD the value that got
      // filled: an AI fill means the bucket's saved value didn't match the tenant this run, so the card
      // keeps surfacing so the operator can add the variant — UNTIL they TEACH the value (set the bound
      // field / add the candidate), after which the bucket holds it and the card disappears and STAYS gone
      // (the stored bundle keeps its ai-* flag forever, so plain coverage never hid it → it resurfaced on
      // every re-approve/reload). A non-AI (deterministic/bucket) fill uses plain coverage, unchanged.
      // skip (dismissed) + dedup (seen) still always apply.
      const aiFilled = typeof e.flag === "string" && /^ai/i.test(e.flag);
      const isCovered = aiFilled
        ? bucketCoversAnswer(buckets, profile, key, String(e.current_value))
        : covered.has(key);
      if (isCovered || skipped.has(key) || seen.has(key)) continue;
      seen.add(key);
      // DOTTED-normalize so a repeating field (canonical_field "education[0].degree") resolves against the
      // profile + matches the dotted panel rows (else it reads "no value", never highlights, can't be added).
      const bucket_path = bucketBindingFor(buckets, key); // authoritative Mode-A binding (wording match)
      const maps_to = dottedPath(e.maps_to || "");
      const canonical_field = dottedPath(e.canonical_field || "");
      const known = bucket_path || canonical_field || maps_to; // bucket binding wins, then FIELD_MAP, then the AI hint
      cards.push({
        key,
        question: e.question_label as string,
        answer: String(e.current_value),
        widget: String(e.widget_type || "text"),
        sensitive: typeof e.flag === "string" && /sensitive|eeo/.test(e.flag),
        bucket_path,
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

/** A yes/no / true-false / checkbox answer → the tiered candidate list that matches EITHER labeling a
 *  tenant renders (Yes/No OR True/False), so a taught standalone (Mode-B) answer resolves automatically
 *  regardless of how the form words its options. Mirrors the extension resolve()'s boolean coercion
 *  (boolean → ["Yes","True"] / ["No","False"]) so a taught bucket behaves like a triBool profile field.
 *  A non-boolean answer passes through as a single candidate (empty → []). */
export function boolAnswerCandidates(answer: string): string[] {
  const n = String(answer || "").trim().toLowerCase();
  if (["yes", "true", "checked", "on"].includes(n)) return ["Yes", "True"];
  if (["no", "false", "unchecked", "off"].includes(n)) return ["No", "False"];
  const t = String(answer || "").trim();
  return t ? [t] : [];
}

/** Raw value at a dotted path (arrays PRESERVED, unlike profileValueAt which collapses to the first). */
function rawAt(profile: unknown, path: string): unknown {
  if (!path) return undefined;
  return String(path)
    .split(".")
    .reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), profile);
}

/** Whether the profile field at `path` ALREADY holds `answer` — for a tiered array, ANY candidate
 *  counts; a scalar is compared normalized; a boolean (yes/no triBool) holds the answer when its
 *  POLARITY matches, recognizing BOTH labelings (Yes/True, No/False) AND any custom candidate the
 *  operator added to this field's ladder (profile.answer_ladders[path][yes|no]). The boolean handling is
 *  kept in lockstep with the extension's fill (boolLadderCandidates) so a True-labeled or custom-labeled
 *  answer the profile already covers does NOT resurface in teach after being taught. */
export function fieldHoldsAnswer(profile: unknown, path: string, answer: string): boolean {
  const raw = rawAt(profile, path);
  if (Array.isArray(raw)) return raw.some((v) => typeof v === "string" && sameAnswer(v, answer));
  if (typeof raw === "boolean") {
    const ladders = (profile as { answer_ladders?: Record<string, { yes?: string[]; no?: string[] }> } | null)?.answer_ladders;
    const custom = ladders && path ? ladders[path]?.[raw ? "yes" : "no"] : undefined;
    if (Array.isArray(custom) && custom.some((c) => sameAnswer(String(c), answer))) return true;
    return boolAnswerCandidates(answer).some((c) => sameAnswer(c, raw ? "Yes" : "No"));
  }
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
// Arrays shown by ProfilePanel's OWN boxes (websites) or as single editable string-lists (skills /
// employer history) — not expanded into per-entry rows here (avoids duplication / a wall of tokens).
const TEACH_SKIP_ARRAYS = new Set(["websites", "skills", "employment_history_companies"]);

/** A field's display string, or null to SKIP (a nested object / an array-of-objects — handled per-entry).
 *  A tiered/string array shows its FIRST value (its primary), matching the object-section behavior. */
function _teachDisplayVal(v: unknown): string | null {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) {
    if (v.length === 0) return "";
    if (v.every((x) => typeof x === "string")) return (v as string[])[0];
    return null; // array of objects → skip (a repeating sub-section)
  }
  return null; // nested object → skip
}

export function flattenProfileFields(profile: unknown): ProfileFieldRow[] {
  const rows: ProfileFieldRow[] = [];
  if (!profile || typeof profile !== "object") return rows;
  const p = profile as Record<string, unknown>;
  for (const section of Object.keys(p)) {
    const sv = p[section];
    if (!sv || typeof sv !== "object") continue;
    if (section === "answer_ladders") continue; // internal fill-ladder metadata, not a displayable profile field
    if (Array.isArray(sv)) {
      // REPEATING section (arrays of OBJECTS: work_experience / education / languages / certifications /
      // additional_files) → one grouped box PER ENTRY, so the teach page shows EVERYTHING the profile
      // page does. DOTTED index paths ("education.0.degree") so getAtPath/setAtPath resolve them (arrays
      // index by "0") → the answer editor edits them in place.
      if (TEACH_SKIP_ARRAYS.has(section)) continue;
      (sv as unknown[]).forEach((entry, i) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return; // objects only (skip a string-list)
        const sectionKey = section + "." + i;
        const sectionLabel = humanize(section) + " · " + (i + 1);
        for (const field of Object.keys(entry as Record<string, unknown>)) {
          const value = _teachDisplayVal((entry as Record<string, unknown>)[field]);
          if (value == null) continue; // nested object/array (specialties, file) → skip
          rows.push({ path: sectionKey + "." + field, label: humanize(field), value, section: sectionKey, sectionLabel });
        }
      });
      continue;
    }
    // OBJECT section (personal_info / work_authorization / how_did_you_hear / self_identification / screening).
    const sectionLabel = humanize(section);
    for (const field of Object.keys(sv as Record<string, unknown>)) {
      const value = _teachDisplayVal((sv as Record<string, unknown>)[field]);
      if (value == null) continue;
      rows.push({ path: section + "." + field, label: humanize(field), value, section, sectionLabel });
    }
  }
  return rows;
}
