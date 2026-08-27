/**
 * review-model.ts — PURE grouping / prominence / shape helpers for the hosted review
 * editor. Port of the non-DOM logic in the extension's `summary.js` (sectionOf,
 * nestedInfoOf, the flag-prominence predicates, sectionShapeFor, nextIndexFor). Kept
 * separate from `review-approval.ts` (the summary-lib.js port) but consumed together by
 * the React editor. NO React, NO DOM.
 */
import type { ReviewEntry, ReviewBundle, FieldShape } from "./review-summary";

export const fmt = (v: unknown): string => (v == null || v === "" ? "—" : String(v));
export const norm = (v: unknown): string => (v == null ? "" : String(v));
export const autofilledOf = (e: ReviewEntry): string | null =>
  e.original_ai_value != null ? e.original_ai_value : (e.current_value ?? null);

// Section grouping. Keys = the REAL canonical-field prefixes the fill engine emits
// (FIELD_MAP flat paths like personal_info.* + PAGE_SECTIONS names, which are camelCase).
const SECTION_LABELS: Record<string, string> = {
  personal_info: "Personal Information",
  self_identification: "Self-Identification",
  agreements: "Agreements",
  workExperience: "Work Experience",
  education: "Education",
  language: "Languages",
  website: "Websites",
  certification: "Certifications",
  skill: "Skills",
  _documents: "Documents",
  _other: "Other Fields",
};

export const humanize = (k: string): string =>
  SECTION_LABELS[k] ||
  k
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

export type SectionInfo = { key: string; label: string; index: number | null };

/** Group info for an entry, from its canonical_field. Repeating: base[idx]; flat: prefix.rest. */
export function sectionOf(e: ReviewEntry): SectionInfo {
  const cf = e.canonical_field || "";
  // A repeating ENTRY keeps its profile-shaped key: the INDEX is what separates education[0] from
  // education[1], and a form heading cannot express that (both sit under one "Education").
  let m = cf.match(/^([A-Za-z_]+)\s*\[(\d+)\]/);
  if (m) return { key: m[1], label: humanize(m[1]), index: +m[2] };
  // ⚠ A FIELD WITH NO PROFILE PATH CAN STILL BELONG TO A REPEATING ENTRY. Every per-customer question
  // inside a work-history entry (Start Date, Supervisor's Name, Employer Phone Number — all
  // `rcf<NNNN>`) has no canonical_field, so the branch above cannot place it, and it used to be listed
  // AFTER the three entry blocks instead of inside them. The fill now carries the entry the scan
  // worked out from the id's ordinal; using it puts the field in its job — and dissolves the duplicate
  // "EXPERIENCE" heading, because these fields join experience[i] instead of forming a section of
  // their own. Keyed on the SAME profile base the mapped fields use, so an entry stays one group and
  // `sectionKey` keeps building valid canonical_fields for a newly added entry.
  // `entry_section` arrives as the SAME base canonical_field uses, so it needs no translation.
  if (e.entry_section && typeof e.entry_index === "number") {
    return { key: e.entry_section, label: humanize(e.entry_section), index: e.entry_index };
  }
  // ⚠ THE FORM'S OWN HEADING WINS for a flat field, because the review page is read next to the form
  // (operator, 2026-08-17: "display the same order as the form"). Grouping by PROFILE SHAPE instead
  // reordered the page relative to the form and — worse — collapsed every question with no profile
  // path into one "Other Fields" bucket, which is how "Supervisor's Name", "Employer Phone Number"
  // and a bare "Day" ended up as context-free rows. Section ORDER is first-appearance (see the
  // grouping in ReviewEditor), so honouring the heading also puts the sections in form order.
  // Keyed on the heading text with a prefix, so it can never collide with a profile-path key.
  const heading = String(e.section_heading || "").trim();
  if (heading) return { key: "h:" + heading.toLowerCase(), label: heading, index: null };
  m = cf.match(/^([A-Za-z_]+)\./);
  if (m) return { key: m[1], label: humanize(m[1]), index: null };
  if (e.widget_type === "file_upload") return { key: "_documents", label: "Documents", index: null };
  return { key: "_other", label: "Other Fields", index: null };
}

export type NestedInfo =
  | { kind: "field"; childBase: string; childIndex: number; field: string }
  | { kind: "stub"; childBase: string; childIndex: null; field: null }
  | null;

/** NESTED sub-section classifier (cert ▸ Specialties). null = the parent entry's own field. */
export function nestedInfoOf(e: ReviewEntry): NestedInfo {
  const cf = e.canonical_field || "";
  let m = cf.match(/^[A-Za-z_]+\[\d+\]\.([A-Za-z_]+)\[(\d+)\]\.(.+)$/);
  if (m) return { kind: "field", childBase: m[1], childIndex: +m[2], field: m[3] };
  m = cf.match(/^[A-Za-z_]+\[\d+\]\.([A-Za-z_]+)\._stub$/);
  if (m) return { kind: "stub", childBase: m[1], childIndex: null, field: null };
  return null;
}

// ── Review-card prominence predicates — prominence keys off the FLAG, never confidence
// (a high-confidence reasoning-from-absence answer, e.g. criminal→"No", must still be the
// most conspicuous, not buried). ──
export const isSensitive = (e: ReviewEntry): boolean => !!e.flag && /sensitive/.test(e.flag);
export const needsAnswer = (e: ReviewEntry): boolean => e.flag === "ai-text-needs-answer";
export const isEeoGuess = (e: ReviewEntry): boolean => e.flag === "ai-eeo-guess";
export const isAiFlag = (e: ReviewEntry): boolean => !!e.flag && e.flag.indexOf("ai-") === 0;
// SUPER-HARD: an AI typeahead pick the applicant didn't claim (ai-closest-forced), OR any AI
// guess the model itself flagged LOW confidence — the riskiest committed AI answers.
// `ai-canon-approximate` and `required-forced-pick` belong here for the same reason (2026-08-07): a
// CLOSED list must be answered, so when nothing in it means what the applicant said we commit the
// nearest option (AI) or a last-resort option (deterministic, when no model could answer). Both are
// values the applicant never claimed, which is exactly what this tier is for — without them they fell
// through to the generic "AI filled this" line and lost the one fact that matters.
export const isSuperHard = (e: ReviewEntry): boolean =>
  e.flag === "ai-closest-forced" || e.flag === "ai-canon-approximate" || e.flag === "required-forced-pick"
  || (isAiFlag(e) && e.confidence === "low");
export const mustReplace = (e: ReviewEntry): boolean =>
  isSuperHard(e) || isSensitive(e) || needsAnswer(e) || isEeoGuess(e);
// Pre-populated: the value was ALREADY on the form (account pre-fill / operator / prior run).
export const isPrePopulated = (e: ReviewEntry): boolean =>
  e.flag === "already-filled" || e.flag === "already-filled-match";
export const isCascadeRevealed = (e: ReviewEntry): boolean => !!e.cascade_revealed;
// A field the form MADE REQUIRED after this application was reviewed (flag `cascade-required`, written
// by the replay walk when Workday refuses a page over a field the approved bundle can't answer). It IS
// cascade_revealed — same approval force — but different news for the human: "⤴ REVEALED" describes a
// field that merely appeared, this one is a question the form is now demanding an answer to (operator
// 2026-07-27). The badge checks this FIRST so only one of the two shows. Twin: review-approval.ts /
// summary-lib.js (same predicate, kept in lockstep like isCascadeRevealed itself).
export const isBecameRequired = (e: ReviewEntry): boolean =>
  !!(e.cascade_revealed && e.flag === "cascade-required");

/**
 * A date composite's segment order, NORMALIZED for the editor: `["month","day","year"]` /
 * `["month","year"]` / `["year"]`. Accepts either the already-clean form OR the raw scan
 * automation-ids (`dateSectionMonth-display`, `dateSectionMonth-input`, …), deduping and dropping
 * anything it doesn't recognize. Returns `[]` when nothing usable survives, which tells the editor to
 * fall back to a plain text box.
 *
 * WHY the viewer normalizes instead of trusting the bundle (operator 2026-07-28, twice): a bundle whose
 * `date_order` held raw ids rendered them as the input placeholders — "dateSectionMonth-display /
 * dateSectionMonth-input / …" — because DateSeg fell back to `{ ph: segment }` for unknown tokens. The
 * extension side was fixed, but a bundle is DURABLE: any already-stored bundle (and any older extension
 * build still installed) keeps its raw ids, so the page must heal them rather than print garbage. This
 * also means an unrecognized token can never again leak into the UI as a placeholder.
 */
export function normalizeDateOrder(order: unknown): string[] {
  const out: string[] = [];
  for (const raw of Array.isArray(order) ? order : []) {
    const s = String(raw).toLowerCase();
    const m = /(month|day|year)/.exec(s); // matches "month" AND "datesectionmonth-display"
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * TODAY, shaped to a date field's own segment order (operator 2026-07-28: "for date questions in the
 * review page can you put a button next to it that fills with the current date").
 *
 * The one date a form asks for that the profile can never hold is *today* — a signature or
 * acknowledgement date — and it's the field most likely to come back as BECAME REQUIRED, so typing it by
 * hand is the friction worth removing. Returns one string per segment IN THE FORM'S ORDER, so a
 * month/year or year-only composite gets only what it asks for.
 *
 * LOCAL date, not UTC (`getMonth`/`getDate`): "today" means the operator's today — near midnight a UTC
 * read would sign the form with the wrong day. `now` is injectable so this is testable without freezing
 * the clock. Zero-padded to match the MM / DD placeholders.
 */
export function todayForDateOrder(order: string[] | null | undefined, now?: Date): string[] {
  const d = now || new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (Array.isArray(order) ? order : []).map((s) =>
    s === "month" ? pad(d.getMonth() + 1) : s === "day" ? pad(d.getDate()) : s === "year" ? String(d.getFullYear()) : ""
  );
}

/**
 * Order for the "Needs review" list (operator 2026-07-28: "if the form fills again and goes to review
 * can you put the new review items at the top").
 *
 * When a submit run sends questions BACK to review, they are the entire reason the operator reopened the
 * page — they must not be buried in form order among fields that were already approved once. Everything
 * NEW sorts first; the pre-existing safety ordering (loudest AI guesses, then must-replace, then the
 * rest) is preserved underneath it, and the sort is STABLE so form order still decides within a tier.
 *
 * 0 = became REQUIRED after review (a question the form now demands — nothing to verify, something to
 *     ANSWER), 1 = otherwise cascade-revealed (appeared after another value committed),
 * 2 = super-hard (forced / low-confidence AI on a sensitive field), 3 = must-replace, 4 = everything else.
 */
export function reviewPriority(e: ReviewEntry): number {
  if (isBecameRequired(e)) return 0;
  if (isCascadeRevealed(e)) return 1;
  if (isSuperHard(e)) return 2;
  if (mustReplace(e)) return 3;
  return 4;
}

/** The flagged entries in review order — NEW items first. Stable, so form order holds within a tier. */
export function orderForReview(entries: ReviewEntry[]): ReviewEntry[] {
  return (entries || [])
    .map((e, i) => ({ e, i }))
    .sort((a, b) => reviewPriority(a.e) - reviewPriority(b.e) || a.i - b.i)
    .map((x) => x.e);
}

// ── Plain-English "what happened" line for a review card ──
// The engine records a terse log-style `detail` (e.g. `AI canonicalized stated "Bachelor of Science"
// → "Bachelors" (vocab map, not inferred)`). That's accurate but reads like a debug string. explainFill
// turns the STABLE flag (+ the specific values the engine kept) into a sentence the applicant can act on:
// what their profile had, what got filled, and that they should check it. Falls back to the raw detail
// for shapes we don't specially phrase, so nothing is ever hidden.

/** Pull the applicant's ORIGINAL value out of the engine's detail string (the value it mapped FROM),
 *  so the explanation can name it. Matches the engine's fixed phrasings; null if none present. */
function statedFromDetail(detail?: string | null): string | null {
  if (!detail) return null;
  const m =
    detail.match(/stated\s+"([^"]+)"/i) ||
    detail.match(/mapped\s+"([^"]+)"/i) ||
    detail.match(/snapped from\s+"([^"]+)"/i);
  return m ? m[1] : null;
}

/**
 * The MODEL'S OWN REASON, when it gave one worth showing (operator, 2026-08-12).
 *
 * Every AI prompt already asks for "a SHORT justification … that NAMES your basis: the positive
 * profile fact used, OR plainly that you are inferring from the ABSENCE of information", and the
 * engine records it as `detail: "AI: <justification>"` (+ ` → "<value>"` on the Workday choice path).
 * So it was already in every bundle — the card just wasn't showing it, and instead re-quoted the value
 * that the editor renders two inches to the right. "AI filled this as «2 weeks»" tells the reviewer
 * nothing they cannot see; "standard professional notice period inferred from profile context" tells
 * them the one thing they need in order to judge it.
 *
 * ⚠ `detail` is an ENGINE string and the frontend contract is that it never leaks (see
 * test/review-model.test.ts). Not every `AI: …` prefix is a justification: the represented-typeahead
 * path writes `AI: "Electrical Engineering" (genuinely represented in the list)`, which is engine
 * jargon about the MATCH, not a reason. So this extracts and then VALIDATES, and returns null on
 * anything that isn't a human phrase — a missing reason falls back to the flag's own wording.
 */
export function aiJustification(e: ReviewEntry): string | null {
  const d = (e.detail || "").trim();
  const m = d.match(/^AI:\s*(.+)$/s);
  if (!m) return null;
  let s = m[1]
    .split(/\s+→\s+/)[0] // drop the ` → "value"` tail: that's the value, which is the thing to NOT repeat
    .replace(/\s*—\s*(commit failed|LEGALLY-LOADED,?\s*verify).*$/i, "") // surfaced by the flag instead
    .trim()
    .replace(/\s+/g, " ");
  if (s.endsWith(".")) s = s.slice(0, -1);
  if (!s) return null;
  // Engine jargon and the "no reason given" placeholders every path falls back to.
  if (s.startsWith('"') || /[=]|^\(|automation-id|formField-/i.test(s)) return null;
  if (/^(generated answer|generated from profile|inferred|chose\b)/i.test(s)) return null;
  // A "reason" that is just the value restated is the duplication this exists to remove.
  const val = String(e.current_value ?? "").trim().toLowerCase();
  if (val && s.toLowerCase() === val) return null;
  return s;
}

/** Sentence-case the model's phrase — it comes back as a fragment, sometimes lowercase. */
function asSentence(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

/** A human, one-line explanation of how a flagged field was filled. Prefer this over the raw `detail`
 *  on the review card. Returns null only when there is nothing to say. */
export function explainFill(e: ReviewEntry): string | null {
  const flag = e.flag || "";
  const chose = fmt(e.current_value);
  const stated = statedFromDetail(e.detail);
  const from = stated ? `Your profile value “${stated}”` : "Your profile value";
  const why = aiJustification(e);

  // NEVER say the AI "filled" a field that holds nothing. Live on Copart: a required compensation box
  // only accepts a number, so the "N/A" placeholder never landed — and the row still read
  // 'AI filled this as "—"', which is both false and useless to act on. An empty value means the
  // opposite of filled, whatever the flag says, so tell the operator what to actually do.
  if ((e.current_value == null || String(e.current_value).trim() === "") && isAiFlag(e)) {
    return (e.detail && /REFUSED/.test(e.detail))
      ? "This form refused the placeholder AI tried — it only accepts certain input. Please fill it in."
      : "AI couldn’t answer this from your profile — please fill it in.";
  }

  // Vocab-match of a value you DID provide (dropdown canonicalize, or a typeahead pick the AI judged
  // genuinely present in the list) — NOT an inference.
  if (flag === "ai-canonicalized" || (flag === "ai-choice" && e.match_tier !== "ai-source-tree"))
    return `${from} wasn’t an exact option on this form, so AI matched it to the closest one — “${chose}”. Check it’s right.`;
  if (flag === "ai-choice" && e.match_tier === "ai-source-tree")
    return `AI matched your profile to “${chose}” in this form’s list. Check it’s right.`;
  // Forced: required field, nothing matched — the riskiest AI answer.
  // Nothing in the list MEANT what you said — the nearest option was taken so the form would accept it.
  if (flag === "ai-canon-approximate")
    return `No option on this form means ${stated ? `“${stated}”` : "your profile value"}, so the closest one — “${chose}” — was selected to get past this page. This is NOT your answer: correct it.`;
  // No model could answer it at all; a placeholder was committed purely so the page would advance.
  if (flag === "required-forced-pick")
    return `Nothing could answer this required question, so “${chose}” was selected only so the application could reach review. This is a PLACEHOLDER — set it yourself.`;
  if (flag === "ai-closest-forced")
    return `This field is required, but none of the options matched your profile. AI picked the nearest one — “${chose}”${stated ? ` (closest to “${stated}”)` : ""}. Double-check this one.`;
  if (flag === "ai-choice-sensitive")
    return `A legally-loaded question your profile doesn’t answer directly — ${why ? `AI’s reason: ${why}` : "AI reasoned from your profile"}. Verify carefully.`;
  if (flag === "ai-eeo-guess")
    return `You didn’t state this in your profile — AI guessed it from what it knows about you${why ? `: ${why}` : ""}. Verify or clear it.`;
  // A market-rate ESTIMATE, not something your profile said — the reviewer needs to know which.
  if (flag === "ai-estimate")
    return `Your profile states no figure, so AI estimated the market rate for this role — “${chose}”. This is a guess at YOUR ask: check it before you submit.`;
  if (flag === "ai-text-needs-answer" || needsAnswer(e))
    return `AI couldn’t answer this from your profile — please fill it in.`;
  if (flag === "ai-choice-other")
    return `AI couldn’t find your answer among the options, so it chose “Other”. Verify that’s okay.`;
  if (flag === "ai-commit-failed")
    return `AI’s answer didn’t take on the form — please fill this in yourself.`;
  // THE VALUE IS ALREADY ON SCREEN — this line's job is WHY, not what (operator, 2026-08-12). It used
  // to read 'AI filled this as “<value>”', repeating the editor immediately to its right and telling
  // the reviewer nothing they could act on; the model's own basis is what lets them judge the answer.
  if (isAiFlag(e))
    return why ? `${asSentence(why)} Verify it’s right.` : `AI answered this from your profile. Verify it’s right.`;

  // Non-AI: a taught/remembered answer, or a deterministic close (containment/fuzzy) match.
  if (flag === "bucket")
    return `Filled from an answer you taught ApplyPilot. Check it fits this form.`;
  if (e.needs_review && e.match_tier && /contain|fuzz/i.test(e.match_tier))
    return `${from} wasn’t an exact option on this form, so ApplyPilot chose the closest match — “${chose}”. Check it’s right.`;
  if (flag === "we-currentwork-today")
    return `Filled with today’s date because you marked “I currently work here” and this end date is required. Verify.`;
  if (flag === "audit-mismatch" || flag === "overwrite-stray")
    return `The form ended up showing a different value than expected — please double-check this field.`;
  if (flag === "audit-unverifiable")
    return `ApplyPilot couldn’t confirm this value stuck on the form — please verify it.`;

  // ── ORACLE'S ADDRESS CASCADE: the form filled it, we only VERIFIED it ────────────────────────
  // ⚠⚠ THESE ROWS HAVE A VALUE, AND THE OLD COPY TOLD THE OPERATOR THEY DID NOT (live 2026-08-22).
  // ORC derives City / State / County from the postal code, so the engine deliberately does not type
  // into them — it reads them back and flags them for a human look (`atsSurfacePrefilled`, which sets
  // `after`, `verified: true` and one of the geo flags below). The record therefore arrives as
  // `needs_review` -> `fill_status: "not_filled"`, and the catch-all beneath printed "ApplyPilot
  // couldn't fill this — please fill it in yourself" over a field holding **"Leon"**.
  //
  // That cost real confusion: County read as an unfillable required field, which is why it sat at the
  // top of the Oracle to-do list as a fill gap. It never was one — the value was there and the submit
  // gate was correctly reporting `bundle blockers: 0`, because that gate tests `current_value` while
  // this copy tested `fill_status`. Two different fields, and only one of them knows about the value.
  if (flag === "geo-not-in-profile")
    return `The form filled this from your postal code${chose ? ` — “${chose}”` : ""}. Your profile doesn’t state it, so check it’s right.`;
  if (flag === "geo-not-approved")
    return `The form filled this from your postal code${chose ? ` as “${chose}”` : ""}, which differs from what you approved. Check which one is right.`;

  // Anything else that still needs a look: an intuitive nudge, never the raw engine string (the precise
  // `detail` stays in the bundle + service-worker logs for debugging).
  // ⚠ AND ONLY WHEN IT IS ACTUALLY EMPTY. `not_filled` is the bundle's word for "flagged", not for
  // "blank" — mapFillStatus sends every `needs_review` here — so this must test the VALUE before
  // telling the operator nothing was filled. The submit gate has always tested the value; this is the
  // same question asked in the same way.
  const hasValue = e.current_value != null && String(e.current_value).trim() !== "";
  if ((e.fill_status === "error" || e.fill_status === "not_filled") && !hasValue)
    return `ApplyPilot couldn’t fill this — please fill it in yourself.`;
  if (e.needs_review) return `Please double-check this field.`;
  return null;
}

export type StatusKind = "ok" | "warn" | "crit" | "skip";
export function statusOf(e: ReviewEntry): StatusKind {
  if (e.widget_type === "removed_entry") return "crit"; // Phase 2: delete-with-memory card — add it back or dismiss (blocks submit)
  if (e.fill_status === "skipped") return "skip";
  if (e.fill_status === "error" || e.fill_status === "not_filled") return "crit";
  if (e.needs_review) return mustReplace(e) ? "crit" : "warn";
  return "ok";
}

/** Friendly page caption: page_label wins; an "accumulated (N pages)" envelope shows as-is;
 *  otherwise a cdpPageKey ("pathname|field,field,…") collapses to its last path segment. */
export function cleanPageName(b: { page_label?: string | null; page?: string | null } | null): string {
  if (!b) return "—";
  if (b.page_label) return b.page_label;
  const p = b.page;
  if (typeof p === "string") {
    if (/^accumulated/.test(p)) return p;
    const seg = (p.split("|")[0] || p).split("/").filter(Boolean).pop();
    if (seg) return seg;
  }
  return fmt(p);
}

export const pageNumOf = (items: ReviewEntry[]): number | null => {
  const e = items.find((x) => x.page_number != null);
  return e ? (e.page_number as number) : null;
};
export const pageCaptionOf = (items: ReviewEntry[], pg: string | null): string => {
  const e = items.find((x) => x.page_label != null);
  if (e) return e.page_label as string;
  const n = pageNumOf(items);
  if (n != null) return "Page " + n;
  return cleanPageName({ page: pg });
};

// ── Add-entry shape derivation (sectionShapeFor / nextIndexFor) — PURE over the bundle. ──
const _stripEntryPrefix = (s: string | null | undefined, key: string): string =>
  String(s || "").replace(new RegExp("^" + key + "\\[\\d+\\]\\."), "");

/** The field SHAPE for a new entry of a repeating section: DOM-detected section_shapes first
 *  (enriched with captured options), else cloned from the highest-index existing entry, else
 *  the stub's engine-emitted section_field_shape. Empty = not addable. */
export function sectionShapeFor(bundle: ReviewBundle, page: string | null, key: string): FieldShape[] {
  const ents = bundle.entries.filter((e) => e.page === page && sectionOf(e).key === key);
  const indexed = ents.filter((e) => sectionOf(e).index != null && !e.is_deleted);
  const existingByRec: Record<string, ReviewEntry> = {};
  for (const e of indexed) {
    const r = _stripEntryPrefix(String(e.field_id).replace(/^.*formField-/, ""), key);
    const p = _stripEntryPrefix(e.canonical_field, key);
    if (r) existingByRec[r] = e;
    if (p && !(p in existingByRec)) existingByRec[p] = e;
  }
  const enrich = (s: FieldShape): FieldShape => {
    const ex = existingByRec[s.recName] || existingByRec[s.path || ""];
    return {
      recName: s.recName,
      path: s.path != null ? s.path : s.recName,
      widget_type: s.widget_type,
      is_required: !!s.is_required,
      label: s.label != null ? s.label : s.recName,
      options: ex ? ex.options : s.options || null,
      captured_options: ex ? ex.captured_options : s.captured_options || null,
      tree_structure: ex ? ex.tree_structure : s.tree_structure || null,
      date_order: s.date_order || (ex ? ex.date_order : null),
    };
  };
  const detected = bundle.section_shapes && bundle.section_shapes[key];
  if (Array.isArray(detected) && detected.length) return detected.map(enrich);
  if (indexed.length) {
    const maxIx = Math.max(...indexed.map((e) => sectionOf(e).index as number));
    return indexed
      .filter((e) => sectionOf(e).index === maxIx)
      .map((e) => ({
        recName: _stripEntryPrefix(String(e.field_id).replace(/^.*formField-/, ""), key),
        path: _stripEntryPrefix(e.canonical_field, key),
        widget_type: e.widget_type,
        is_required: e.is_required,
        label: e.question_label,
        options: e.options,
        captured_options: e.captured_options,
        tree_structure: e.tree_structure,
        date_order: e.date_order || null,
      }));
  }
  const stub = ents.find(
    (e) =>
      e.widget_type === "section_stub" &&
      Array.isArray(e.section_field_shape) &&
      e.section_field_shape.length
  );
  if (stub && stub.section_field_shape)
    return stub.section_field_shape.map((s) => ({
      recName: s.recName,
      path: s.path != null ? s.path : s.recName,
      widget_type: s.widget_type,
      is_required: !!s.is_required,
      label: s.label != null ? s.label : s.recName,
      options: null,
      captured_options: null,
      tree_structure: null,
      date_order: s.date_order || null,
    }));
  return [];
}

export function nextIndexFor(bundle: ReviewBundle, page: string | null, key: string): number {
  const idxs = bundle.entries
    .filter((e) => e.page === page && sectionOf(e).key === key)
    .map((e) => sectionOf(e).index)
    .filter((i): i is number => i != null);
  return idxs.length ? Math.max(...idxs) + 1 : 0;
}

export function nextNestedIndexFor(
  bundle: ReviewBundle,
  page: string | null,
  parentKey: string,
  parentIx: number,
  childBase: string
): number {
  const re = new RegExp("^" + parentKey + "\\[" + parentIx + "\\]\\." + childBase + "\\[(\\d+)\\]");
  const idxs = bundle.entries
    .filter((e) => e.page === page)
    .map((e) => {
      const m = String(e.canonical_field || "").match(re);
      return m ? +m[1] : null;
    })
    .filter((i): i is number => i != null);
  return idxs.length ? Math.max(...idxs) + 1 : 0;
}
