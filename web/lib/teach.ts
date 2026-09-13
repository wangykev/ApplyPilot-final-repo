import { normalizeQuestion, type Bucket } from "@/lib/buckets";
import { profileFieldMeta } from "@/lib/profile-fields";
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

/**
 * "What is today's date?" is NOT a reusable answer (operator 2026-07-28: "don't put any questions that
 * are just date into teach"). A signature/acknowledgement date is per-APPLICATION: remembering it would
 * teach a bucket to fill a STALE date on every future form — worse than not learning it at all.
 *
 * Deliberately NARROW — it excludes questions that are JUST a date ask, not everything containing the
 * word. "Date of Birth" and "Graduation Date" ARE reusable answers and must keep teaching, so only a
 * bare "Date" (however punctuated) and the explicit today/signature phrasings are dropped. The `date`
 * and `year` WIDGETS are excluded too: a date composite can't be bucket-filled at all today, so a card
 * for one is unanswerable — and this keeps it that way if `date` is ever added to BUCKET_ELIGIBLE.
 */
const DATE_ONLY_QUESTION =
  /^(date|dates|todays? date|current date|date signed( on)?|signature date|date of signature|date completed|completion date|date of application|application date)( of (application|signing|signature))?$/;
export function isDateOnlyQuestion(label?: string | null, widget?: string | null): boolean {
  const w = String(widget || "");
  if (w === "date" || w === "year") return true;
  const q = normalizeQuestion(String(label || ""))
    // A real form spells out what the date is for and how to format it — live 2026-08-02 a card
    // read "Today's Date of Application (MM/DD/YY Format)", which the bare `^todays date$` anchor
    // missed, so a STALE 05/22/2025 was offered as a reusable answer. Drop a trailing format hint
    // and let the today/signature family carry an "of application/signing/signature" tail.
    // Stripping the parenthetical is safe BECAUSE the test is an exact match against the list
    // below: "Date of Birth (MM/DD/YYYY)" becomes "date of birth", which still does not match.
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/[:.]+$/, "")
    .replace(/'/g, "")
    .trim();
  return DATE_ONLY_QUESTION.test(q);
}

/**
 * Is this a YES/NO question? Used to seed a NEW remembered answer's "Answer type" so a yes/no
 * question does not default to free Text (operator, 2026-09-03).
 *
 * ⚠ TWO SIGNALS, AND THE ANSWER IS THE STRONGER ONE. An approved answer of Yes/No/True/False is
 * direct evidence of the field's shape — it is what the operator actually chose — whereas the
 * wording is an inference. So the answer is tested first and alone is enough.
 *
 * The wording test exists for the case the answer cannot cover: creating a field from a card whose
 * answer is blank, or one the AI left empty. It anchors on a LEADING AUXILIARY VERB, which is what
 * makes a yes/no question yes/no in English ("Do you…", "Are you…", "Will you require…"). That
 * anchor is the guard: a wh-question ("How many prior internships…", "What is your…", "Which
 * office…") cannot match it, and those are exactly the ones that must stay Text.
 *
 * ⚠ Deliberately NOT keyed on option counts or on a `sensitive` flag: a two-option dropdown is
 * often a real pick-one ("Bachelors/Masters"), and a legally-loaded question is not therefore a
 * boolean.
 */
const YES_NO_ANSWER = /^\s*(yes|no|true|false)\s*$/i;
const YES_NO_LEAD = /^\s*(do|does|did|are|is|was|were|will|would|have|has|had|can|could|should|may|must|shall)\b/i;

export function looksLikeYesNoQuestion(question?: string | null, answer?: string | null): boolean {
  if (YES_NO_ANSWER.test(String(answer || ""))) return true;
  const q = String(question || "")
    // A leading "*" / "✱" required marker, or a bracketed prefix some tenants prepend, must not
    // hide the auxiliary verb from the anchor.
    .replace(/^[\s*✱]+/, "")
    .replace(/^\[[^\]]*\]\s*/, "")
    .trim();
  return YES_NO_LEAD.test(q);
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
    !isDateOnlyQuestion(e.question_label, e.widget_type) && // a per-application date is never a reusable answer
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

/** Common corporate suffixes, stripped so "Analog Devices Inc." still matches "Analog Devices". */
const COMPANY_SUFFIX_RX = /\b(inc|inc\.|incorporated|corp|corp\.|corporation|llc|l\.l\.c\.|ltd|ltd\.|limited|plc|gmbh|s\.a\.|nv|ag|co|co\.|company|group|holdings|technologies|technology|labs|laboratories)\b/gi;

function companyTokens(company: string | null | undefined): string[] {
  const cleaned = String(company || "")
    .replace(COMPANY_SUFFIX_RX, " ")
    .replace(/[^\p{L}\p{N}\s&-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return [];
  // The whole cleaned name is the reliable signal. Single tokens are only used when they are
  // distinctive enough not to appear in ordinary prose — "Analog" and "Devices" each fail that bar,
  // "Nvidia" passes — so a multi-word name matches as a PHRASE, not word-by-word.
  const words = cleaned.split(" ").filter(Boolean);
  const out = [cleaned];
  if (words.length === 1 && words[0].length >= 4) return out;
  return out;
}

/**
 * Does this question wording name the employer?
 *
 * Such a wording is tenant-specific by construction: every company asks "…employment with <us>?",
 * so a taught bucket for one of them can never match another. Deliberately conservative — it only
 * fires on the company we actually know for that application, matched as a whole phrase on word
 * boundaries, so an ordinary question is never withheld from teaching by accident.
 */
export function questionNamesCompany(question: string, company: string | null | undefined): boolean {
  const q = String(question || "").toLowerCase();
  if (!q) return false;
  for (const t of companyTokens(company)) {
    const needle = t.toLowerCase();
    if (needle.length < 3) continue;
    const rx = new RegExp(`(^|[^\\p{L}\\p{N}])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}\\p{N}]|$)`, "u");
    if (rx.test(q)) return true;
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
      // A wording that NAMES THE EMPLOYER cannot generalize (operator 2026-08-10). "Do you have any
      // commitments to another organization that might affect your employment with Analog Devices?"
      // is the same question everywhere, but no other tenant writes it that way — teaching it stores
      // a wording that will never match again, and it clutters the teach queue with one card per
      // employer for what is really one question. Skipped as a teach CARD only; the answer is still
      // filled, reviewed and submitted exactly as before.
      if (questionNamesCompany(e.question_label as string, app.company)) continue;
      const aiFilled = typeof e.flag === "string" && /^ai/i.test(e.flag);
      const isCovered = aiFilled
        ? bucketCoversAnswer(buckets, profile, key, String(e.current_value))
        : covered.has(key);
      if (isCovered || skipped.has(key) || seen.has(key)) continue;
      seen.add(key);
      // DOTTED-normalize so a repeating field (canonical_field "education[0].degree") resolves against the
      // profile + matches the dotted panel rows (else it reads "no value", never highlights, can't be added).
      const bucket_path = bucketBindingFor(buckets, key); // authoritative Mode-A binding (wording match)
      // ⚠ maps_to is an LLM-authored path and the model INVENTS plausible ones: live 2026-07-31 an
      // Ashby/Lever relocation question came back `screening.willing_to_relocate`, which does not
      // exist (the real path is application_questions.availability_and_preferences.willing_to_relocate).
      // Binding a bucket to a nonexistent path yields a Mode-A bucket that resolves undefined forever —
      // a DEAD bucket that silently teaches nothing. Only accept a hint that names a REAL profile field.
      const maps_to = validProfilePath(profile, dottedPath(e.maps_to || "")) ? dottedPath(e.maps_to || "") : "";
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

/** Does `path` RESOLVE to a real answerable value in THIS profile? Guards the LLM's maps_to hint
 *  (it invents plausible paths — see teachableCards). Deliberately checks RESOLUTION, not the
 *  teach panel's displayable rows: flattenProfileFields skips nested objects, but a Mode-A bucket
 *  resolves any dotted path, so `application_questions.availability_and_preferences.willing_to_
 *  relocate` is a perfectly good binding target while `screening.willing_to_relocate` (invented)
 *  is not. Object / array-of-objects targets are rejected — a bucket can't answer with a section. */
export function validProfilePath(profile: unknown, path: string): boolean {
  const p = String(path || "").trim();
  if (!p || !profile || typeof profile !== "object") return false;
  let cur: unknown = profile;
  for (const key of p.split(".")) {
    if (cur == null || typeof cur !== "object") return false;
    cur = (cur as Record<string, unknown>)[key];
    if (cur === undefined) return false;
  }
  if (cur === null) return true;                                  // present but unset — still a real field
  if (typeof cur === "object" && !Array.isArray(cur)) return false; // a whole section, not an answer
  if (Array.isArray(cur)) return cur.every((x) => typeof x === "string"); // tiered list yes, objects no
  return true;
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

/** Whether an answer is a recognized yes/no TOKEN (Yes/No/True/False/checked/…) — vs a NON-STANDARD
 *  label a tenant used for a yes/no option (e.g. "Affirmative", "Yes, I am authorized"), which the
 *  default ladder can't match and so must be remembered in the field's ladder. */
export function isBoolAnswer(answer: string): boolean {
  return ["yes", "true", "checked", "on", "no", "false", "unchecked", "off"].includes(
    String(answer || "").trim().toLowerCase(),
  );
}

/** The initial editable ladder shown when teaching a NON-STANDARD yes/no label: the field's existing
 *  ladder for the polarity (answer_ladders[path][yes|no]) or the defaults (["Yes","True"] / ["No","False"]),
 *  with `label` appended if not already present (deduped, case-insensitive). The operator can then reorder
 *  or trim it (via the same ladder editor as the profile page) before confirming. */
export function seedLadderDraft(profile: unknown, path: string, polarity: boolean, label: string): string[] {
  const src = (profile as { answer_ladders?: Record<string, { yes?: string[]; no?: string[] }> } | null)?.answer_ladders?.[path];
  const existing = polarity ? src?.yes : src?.no;
  const base = Array.isArray(existing) && existing.length ? [...existing] : boolAnswerCandidates(polarity ? "Yes" : "No");
  const t = String(label).trim();
  return t && !base.some((c) => sameAnswer(c, t)) ? [...base, t] : base;
}

/** Return a NEW profile with field `path`'s ladder for `polarity` set to `list` (the operator's
 *  edited/reordered ladder from the teach popup; blanks dropped, deduped case-insensitively, ORDER
 *  preserved). Deep-copies answer_ladders so the caller's profile is never mutated. An empty result
 *  clears that polarity's custom ladder → the extension falls back to its default. */
export function setLadderList(profile: unknown, path: string, polarity: boolean, list: string[]): unknown {
  const p: Record<string, unknown> = profile && typeof profile === "object" ? { ...(profile as Record<string, unknown>) } : {};
  const key = polarity ? "yes" : "no";
  const src = (p.answer_ladders as Record<string, { yes?: string[]; no?: string[]; values?: string[] }>) || {};
  const ladders: Record<string, { yes: string[]; no: string[]; values: string[] }> = {};
  for (const k of Object.keys(src)) ladders[k] = { yes: [...(src[k]?.yes || [])], no: [...(src[k]?.no || [])], values: [...(src[k]?.values || [])] };
  const entry = ladders[path] || { yes: [], no: [], values: [] };
  const clean: string[] = [];
  for (const c of list) {
    const t = String(c).trim();
    if (t && !clean.some((x) => sameAnswer(x, t))) clean.push(t);
  }
  entry[key] = clean;
  ladders[path] = entry;
  p.answer_ladders = ladders;
  return p;
}

/** Return a NEW profile with a SCALAR field's answer variants (answer_ladders[path].values) set to `list`
 *  (blanks dropped, deduped case-insensitively, ORDER preserved). Deep-copies answer_ladders (the yes/no
 *  polarity ladders are preserved) so the caller's profile is never mutated. The teach answer editor + the
 *  profile page's in-field arrow both edit this. */
export function setFieldVariants(profile: unknown, path: string, list: string[]): unknown {
  const p: Record<string, unknown> = profile && typeof profile === "object" ? { ...(profile as Record<string, unknown>) } : {};
  const src = (p.answer_ladders as Record<string, { yes?: string[]; no?: string[]; values?: string[] }>) || {};
  const ladders: Record<string, { yes: string[]; no: string[]; values: string[] }> = {};
  for (const k of Object.keys(src)) ladders[k] = { yes: [...(src[k]?.yes || [])], no: [...(src[k]?.no || [])], values: [...(src[k]?.values || [])] };
  const entry = ladders[path] || { yes: [], no: [], values: [] };
  const clean: string[] = [];
  for (const c of list) {
    const t = String(c).trim();
    if (t && !clean.some((x) => sameAnswer(x, t))) clean.push(t);
  }
  entry.values = clean;
  ladders[path] = entry;
  p.answer_ladders = ladders;
  return p;
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
  // The field's ANSWER-VARIANT ladder counts as HELD: answer_ladders[path].values is exactly what the
  // extension appends as extra match candidates (appendFieldVariants), so a phrasing already taught
  // there fills deterministically and must NOT resurface as a teach card (2026-07-25).
  const variants = (profile as { answer_ladders?: Record<string, { values?: string[] }> } | null)?.answer_ladders?.[path]?.values;
  if (Array.isArray(variants) && variants.some((v) => sameAnswer(String(v), answer))) return true;
  if (Array.isArray(raw)) return raw.some((v) => typeof v === "string" && sameAnswer(v, answer));
  if (typeof raw === "boolean") {
    const ladders = (profile as { answer_ladders?: Record<string, { yes?: string[]; no?: string[] }> } | null)?.answer_ladders;
    const custom = ladders && path ? ladders[path]?.[raw ? "yes" : "no"] : undefined;
    if (Array.isArray(custom) && custom.some((c) => sameAnswer(String(c), answer))) return true;
    return boolAnswerCandidates(answer).some((c) => sameAnswer(c, raw ? "Yes" : "No"));
  }
  return raw != null && sameAnswer(String(raw), answer);
}

/** Does this field's question bucket ALREADY contain this wording? (normalized, the fill's own key) */
export function bucketHasWording(buckets: Bucket[], path: string, question: string): boolean {
  const p = String(path || "").trim();
  const k = normalizeQuestion(question);
  if (!p || !k) return false;
  return (buckets || []).some(
    (b) => String(b.profile_path || "").trim() === p && (b.questions || []).some((q) => normalizeQuestion(q) === k),
  );
}

/** Is the field EMPTY (no stored value at all)? An empty field wants its VALUE set; a field that already
 *  holds a different value wants the tenant's phrasing filed as an answer VARIANT, never an overwrite. */
export function fieldIsEmpty(profile: unknown, path: string): boolean {
  const raw = rawAt(profile, path);
  if (raw == null) return true;
  if (Array.isArray(raw)) return raw.filter((v) => String(v ?? "").trim() !== "").length === 0;
  if (typeof raw === "boolean") return false;
  return String(raw).trim() === "";
}

/** Which route the teach confirm popup takes when a card is added to a chosen profile field. TWO
 *  INDEPENDENT axes (operator, 2026-07-25) — the question WORDING (the bucket) and the ANSWER (the
 *  field's value / its answer-variant ladder) can each be missing, so the old binary route mishandled
 *  the case where BOTH are:
 *  - "wording": the field already answers this → only the phrasing is new → add it to the bucket;
 *  - "answer":  the field is EMPTY → set its value (and file the wording too);
 *  - "variant": the field holds a DIFFERENT value and the wording is already known → the tenant's
 *    phrasing of the answer belongs in this field's answer-variant ladder — NEVER overwrite the value
 *    (the live case: race = "Asian", the form wanted "Asian (not hispanic or latino)");
 *  - "both":    the field holds a different value AND the wording is new → BOTH must be taught, so the
 *    popup shows the question bucket and the answer ladder side by side. Checked FIRST.
 */
export type TeachRoute = "answer" | "wording" | "variant" | "both";
export function decideTeachRoute(profile: unknown, path: string, answer: string): TeachRoute {
  if (fieldHoldsAnswer(profile, path, answer)) return "wording"; // the answer is covered; only the phrasing can be new
  if (fieldIsEmpty(profile, path)) return "answer";              // nothing stored yet → set the value
  return wantsVariant(profile, path) ? "variant" : "answer";     // scalar → the answer is another PHRASING; bool/list → a real value change
}

/** Is a DIFFERENT answer on this field a new PHRASING (→ the variant ladder) or a real VALUE change?
 *  - boolean (triBool): a different answer flips POLARITY → a value change (its per-polarity label
 *    ladder is handled by the popup's non-standard-label editor);
 *  - array (tiered/list): a different answer is another accepted option → appended to the field's OWN
 *    list by the value editor;
 *  - scalar: the profile holds one canonical value ("Asian") and the form worded it differently
 *    ("Asian (not hispanic or latino)") → the ANSWER-VARIANT ladder, never an overwrite. */
function wantsVariant(profile: unknown, path: string): boolean {
  const raw = rawAt(profile, path);
  return typeof raw !== "boolean" && !Array.isArray(raw);
}

/** The FULL decision, both axes at once — what the popup renders and what confirm must save. */
export function decideTeachPlan(
  profile: unknown,
  path: string,
  card: { question: string; answer: string },
  buckets: Bucket[],
): { route: TeachRoute; needsWording: boolean; needsAnswer: boolean } {
  const answerHeld = fieldHoldsAnswer(profile, path, card.answer);
  const wordingKnown = bucketHasWording(buckets, path, card.question);
  const needsWording = !wordingKnown;
  const needsAnswer = !answerHeld;
  if (!needsAnswer) return { route: "wording", needsWording, needsAnswer };   // only the phrasing can be missing
  if (fieldIsEmpty(profile, path)) return { route: "answer", needsWording, needsAnswer }; // empty field → set the value
  // Holds a DIFFERENT value. A bool polarity flip / a list append is a real VALUE change (the value
  // editor owns it, and it files the wording too); a SCALAR difference is another phrasing → the
  // variant ladder, and when the wording is new too, BOTH are taught in one merged popup.
  if (!wantsVariant(profile, path)) return { route: "answer", needsWording, needsAnswer };
  return { route: needsWording ? "both" : "variant", needsWording, needsAnswer };
}

/** Field NAMES that are too generic to be a safe default question wording on their own — a form asking
 *  "Type" or "Name" is not necessarily asking for the website type or a person's name, and a bucket
 *  wording is an EXACT (normalized) match that would then fill from the wrong field. Everything else
 *  ("First Name", "Postal Code", "Willing To Relocate") is specific enough to stand alone. */
const GENERIC_FIELD_LABELS = new Set(["type", "name", "value", "other", "notes", "description", "url", "id", "status", "title"]);

/** Profile keys that are RUN SETTINGS, not answers any form asks for. Without this, `fill_all_skills`
 *  (the "try to fill all skills" checkbox) would be seeded as a Mode-A bucket whose answer is "Yes"/"No",
 *  and a form question that normalized to "Fill All Skills" would fill from it. Nothing asks that. */
const NON_ANSWER_FIELDS = new Set(["fill_all_skills"]);

/** Only the PRIMARY entry of a repeating section gets a default wording — a flat tenant asks "School"
 *  once, and a bucket binds to ONE path (the education.0.* starter convention). "education.1.gpa" etc.
 *  are skipped. A non-indexed path always passes. */
function isPrimaryEntryPath(path: string): boolean {
  const m = /\.(\d+)\./.exec(path);
  return !m || m[1] === "0";
}

/**
 * DEFAULT QUESTION WORDINGS (operator, 2026-07-26): every profile field's question bucket starts with
 * the field's OWN NAME as a wording — the "First Name" bucket contains "First Name" — so a form that
 * literally labels its question the way the profile labels the field fills deterministically even when
 * the tenant's automation-id isn't in FIELD_MAP. Matching is normalized (lower-cased, whitespace
 * collapsed), so "First Name" also covers "first name".
 *
 * Non-destructive + idempotent, exactly like ensureStarterBuckets: existing wordings/values are never
 * touched, the default is added only when that wording isn't already present (deduped by
 * normalizeQuestion), and a bucket is created for a path only if the profile actually has the field.
 * Applied on LOAD alongside ensureStarterBuckets, so it self-heals as the profile schema grows.
 */
export function ensureDefaultFieldWordings(buckets: Bucket[], profile: unknown): Bucket[] {
  const rows = flattenProfileFields(profile);
  let next = buckets;
  // WEBSITES are the exception to both rules below: each entry is a DIFFERENT question (LinkedIn is not
  // GitHub), so every entry — not just the primary — gets its own bucket, and the wording comes from the
  // entry's TYPE rather than the field name ("Url"/"Type" are far too generic). Operator, 2026-07-26:
  // "for linkedin, github, and personal website also make it default, no need for URL" — the wording is
  // the type verbatim ("LinkedIn", "GitHub", "Personal Website"), matching a form that labels its field
  // exactly that. The three built-in types are type-locked in the profile editor; a custom one the
  // operator names works the same way.
  const sites = (profile as { websites?: { type?: string; url?: string }[] } | null)?.websites;
  if (Array.isArray(sites)) {
    sites.forEach((w, i) => {
      const type = String(w?.type || "").trim();
      if (!type) return;
      const path = "websites." + i + ".url";
      const existing = next.find((b) => String(b.profile_path || "").trim() === path);
      if (existing) {
        const k = normalizeQuestion(type);
        if ((existing.questions || []).some((q) => normalizeQuestion(q) === k)) return;
        next = next.map((b) => (b === existing ? { ...b, questions: [...(b.questions || []), type] } : b));
        return;
      }
      const seeded = ensureModeABucket(next, path, "text");
      next = addWordingToBucket(seeded.buckets, seeded.bucketId, type);
    });
  }
  for (const r of rows) {
    const label = String(r.label || "").trim();
    if (!label || GENERIC_FIELD_LABELS.has(label.toLowerCase())) continue;
    if (NON_ANSWER_FIELDS.has(String(r.path || "").trim())) continue; // a run setting, not a form answer
    if (!isPrimaryEntryPath(r.path)) continue;
    const path = r.path.trim();
    if (!path) continue;
    const existing = next.find((b) => String(b.profile_path || "").trim() === path);
    if (existing) {
      const k = normalizeQuestion(label);
      if ((existing.questions || []).some((q) => normalizeQuestion(q) === k)) continue; // already has it
      next = next.map((b) => (b === existing ? { ...b, questions: [...(b.questions || []), label] } : b));
      continue;
    }
    const seeded = ensureModeABucket(next, path, profileFieldMeta(path, undefined).bucketWidget);
    next = addWordingToBucket(seeded.buckets, seeded.bucketId, label);
  }
  // Known ALIAS WORDINGS for common fields — VISIBLE in the buckets (operator 2026-07-31:
  // "don't secretly code them together on the backend; have them in the question bucket so
  // users keep control"). These were briefly hidden regex rungs in the extension's label
  // router; as bucket wordings the operator can see, edit, or delete every one on /app/teach.
  // Exact-normalized matching, so casing/punctuation don't matter. Non-destructive + idempotent
  // (addWordingToBucket dedupes); only fields the profile actually has get seeded.
  for (const [path, aliases] of Object.entries(DEFAULT_ALIAS_WORDINGS)) {
    const existing = next.find((b) => String(b.profile_path || "").trim() === path);
    if (!existing) continue; // the field-name pass above only seeds fields present in the profile
    for (const w of aliases) next = addWordingToBucket(next, existing.id, w);
  }
  return next;
}

// path → the alias question wordings real ATS forms use for that field (each observed live:
// Ramp labels phone just "Phone"; OpenAI "Preferred Name (if applicable)"; GitLab "What's the
// name you'd prefer us to use throughout the interview process?" + country-of-residence;
// Scale AI the current-employer/title pair). Extend freely — every entry is operator-visible.
const DEFAULT_ALIAS_WORDINGS: Record<string, string[]> = {
  "personal_info.phone_number": ["Phone", "Mobile Phone", "Cell Phone", "Mobile Number", "Phone number (with country code)"],
  "personal_info.email": ["Email Address", "E-mail"],
  "personal_info.preferred_first_name": [
    "Preferred Name",
    "Preferred Name (if applicable)",
    "What's the name you'd prefer us to use throughout the interview process?",
  ],
  "personal_info.country": ["Country of Residence", "What is your current country of residence?"],
  "work_experience.0.company": ["Current Company", "Current Employer", "Who is your current or most recent employer?"],
  "work_experience.0.job_title": ["Current Title", "Current Job Title", "What is your current or most recent job title?"],
  "application_questions.availability_and_preferences.salary_expectation": [
    "Salary Expectations",
    "What are your salary expectations for this position?",
    "Desired Salary",
  ],
};

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
