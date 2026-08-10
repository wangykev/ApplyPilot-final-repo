/**
 * SMART MERGE for repeating sections.
 *
 * "Replace" makes the resume the whole truth; "fill blanks" changes nothing on a
 * complete profile. Neither handles the common case: you rewrote a role's bullets
 * AND added a new job. That needs a per-entry decision — is this parsed entry the
 * SAME role as one you already have (update it in place) or a NEW one (append it)?
 *
 * A model makes that judgement; this module owns everything around it — the prompt,
 * the strict parse of the reply, and the VALIDATION that turns whatever the model
 * said into a plan that cannot corrupt a profile. The apply step is pure and
 * deterministic, so it is unit-testable without an LLM.
 *
 * The anti-corruption rules, each of which exists because the model can get it wrong:
 *  - a target index outside the existing array degrades to "add" (never writes nowhere)
 *  - two parsed entries may not claim the SAME existing entry (the second degrades to
 *    "add"), or one would silently swallow the other
 *  - a parsed entry the model forgot to mention degrades to "add" — an entry is never
 *    silently dropped
 *  - existing entries nobody targeted are KEPT untouched; smart merge never deletes
 */
import type { Profile } from "./profile-schema";

/** Repeating sections a resume can describe as discrete, matchable entries. */
export const RECONCILE_SECTIONS = [
  "work_experience",
  "education",
  "projects",
  "certifications",
  "languages",
  "websites",
] as const;

export type ReconcileSection = (typeof RECONCILE_SECTIONS)[number];

export type EntryDecision = {
  section: ReconcileSection;
  /** Index into the PARSED array. */
  incoming: number;
  action: "update" | "add";
  /** Index into the EXISTING array — only meaningful when action === "update". */
  target?: number;
  reason: string;
};

export type ReconcilePlan = {
  decisions: EntryDecision[];
  /** Decisions the model asked for that were downgraded, with why. Surfaced, never hidden. */
  corrections: string[];
};

/** A short human label for one entry, used in the prompt and in the UI plan. */
export function entryLabel(section: ReconcileSection, e: unknown): string {
  const r = (e ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof r[k] === "string" ? (r[k] as string).trim() : "");
  const first = (k: string) => {
    const v = r[k];
    if (Array.isArray(v) && v.length && typeof v[0] === "string") return v[0];
    return typeof v === "string" ? v : "";
  };
  switch (section) {
    case "work_experience": {
      const t = [s("job_title"), s("company")].filter(Boolean).join(" @ ");
      const d = [s("from"), s("currently_work_here") ? "Present" : s("to")].filter(Boolean).join("–");
      return [t || "(untitled role)", d].filter(Boolean).join("  ");
    }
    case "education": {
      const t = [s("school_or_university"), first("degree")].filter(Boolean).join(" — ");
      return t || "(unnamed school)";
    }
    case "projects":
      return s("name") || "(unnamed project)";
    case "certifications":
      return first("certification") || "(unnamed certification)";
    case "languages":
      return s("language") || "(unnamed language)";
    case "websites":
      return [s("type"), s("url")].filter(Boolean).join(" ") || "(no url)";
  }
}

/** The compact view of both sides that the model reasons over. */
export function buildReconcilePrompt(
  existing: Profile,
  parsed: Profile,
): { system: string; user: string } {
  const system = [
    "You reconcile a freshly parsed resume against a user's saved profile.",
    "For EVERY entry in the parsed resume you decide ONE of:",
    '  "update" — it is the SAME real-world item as one the user already has (same job at the same',
    "             company, same degree at the same school), just reworded, re-dated or expanded.",
    '  "add"    — it is a NEW item the profile does not have yet.',
    "Judge by identity (company + role, school + degree), NOT by wording similarity: a rewritten",
    "description of the same job is an UPDATE; a different job at the same company is an ADD.",
    "Never map two parsed entries to the same existing entry. If unsure, choose add — a duplicate",
    "the user can delete is safer than overwriting something they wrote.",
    "Reply with JSON ONLY, no prose, no code fence:",
    '{"decisions":[{"section":"work_experience","incoming":0,"action":"update","target":1,"reason":"same role at same company, description rewritten"}]}',
  ].join("\n");

  const lines: string[] = [];
  for (const section of RECONCILE_SECTIONS) {
    const cur = (existing[section] ?? []) as unknown[];
    const inc = (parsed[section] ?? []) as unknown[];
    if (inc.length === 0) continue; // nothing to decide for this section
    lines.push(`## ${section}`);
    lines.push("EXISTING:");
    lines.push(cur.length ? cur.map((e, i) => `  [${i}] ${entryLabel(section, e)}`).join("\n") : "  (none)");
    lines.push("PARSED:");
    lines.push(inc.map((e, i) => `  [${i}] ${entryLabel(section, e)}`).join("\n"));
    lines.push("");
  }
  return { system, user: lines.join("\n") || "(nothing to reconcile)" };
}

/** Strictly read the model's reply. Returns null when it isn't usable. */
export function parseReconcileReply(text: unknown): EntryDecision[] | null {
  if (typeof text !== "string") return null;
  let raw = text.trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const list = (obj as { decisions?: unknown })?.decisions;
  if (!Array.isArray(list)) return null;

  const out: EntryDecision[] = [];
  for (const d of list) {
    const r = d as Record<string, unknown>;
    const section = r.section as ReconcileSection;
    if (!(RECONCILE_SECTIONS as readonly string[]).includes(section)) continue;
    const incoming = Number(r.incoming);
    if (!Number.isInteger(incoming) || incoming < 0) continue;
    const action = r.action === "update" ? "update" : "add";
    const target = Number(r.target);
    out.push({
      section,
      incoming,
      action,
      target: action === "update" && Number.isInteger(target) && target >= 0 ? target : undefined,
      reason: typeof r.reason === "string" ? r.reason.slice(0, 200) : "",
    });
  }
  return out;
}

/**
 * Turn the model's raw decisions into a plan that is safe to apply. Every downgrade
 * is recorded in `corrections` so the UI can show what was overruled.
 */
export function validatePlan(
  existing: Profile,
  parsed: Profile,
  raw: EntryDecision[],
): ReconcilePlan {
  const corrections: string[] = [];
  const decisions: EntryDecision[] = [];
  const claimed = new Map<ReconcileSection, Set<number>>();

  for (const section of RECONCILE_SECTIONS) {
    const incCount = ((parsed[section] ?? []) as unknown[]).length;
    const curCount = ((existing[section] ?? []) as unknown[]).length;
    if (incCount === 0) continue;
    claimed.set(section, new Set());
    const seen = new Set<number>();

    for (let i = 0; i < incCount; i++) {
      const label = `${section}[${i}] "${entryLabel(section, (parsed[section] as unknown[])[i])}"`;
      const d = raw.find((x) => x.section === section && x.incoming === i);

      if (!d) {
        decisions.push({ section, incoming: i, action: "add", reason: "the model did not decide this entry" });
        corrections.push(`${label}: no decision returned → added`);
        continue;
      }
      if (seen.has(i)) continue;
      seen.add(i);

      if (d.action === "add") {
        decisions.push({ ...d, target: undefined });
        continue;
      }
      // action === "update" from here
      if (d.target === undefined || d.target >= curCount) {
        decisions.push({ ...d, action: "add", target: undefined });
        corrections.push(`${label}: update target ${d.target ?? "(missing)"} is out of range → added`);
        continue;
      }
      const taken = claimed.get(section)!;
      if (taken.has(d.target)) {
        decisions.push({ ...d, action: "add", target: undefined });
        corrections.push(`${label}: existing entry ${d.target} was already claimed → added`);
        continue;
      }
      taken.add(d.target);
      decisions.push(d);
    }
  }
  return { decisions, corrections };
}

export type ReconcileApplyResult = {
  profile: Profile;
  updated: number;
  added: number;
};

/**
 * Apply a validated plan. Pure and deterministic — no AI here.
 *
 * Untargeted existing entries are kept as-is, so this mode never deletes. Appends
 * only ever grow an array, so index-keyed `answer_ladders` stay valid (unlike the
 * replace path, which can strand them).
 */
export function applyReconcilePlan(
  base: Profile,
  parsed: Profile,
  plan: ReconcilePlan,
): ReconcileApplyResult {
  const out = structuredClone(base);
  let updated = 0;
  let added = 0;

  for (const section of RECONCILE_SECTIONS) {
    const inc = (parsed[section] ?? []) as unknown[];
    if (inc.length === 0) continue;
    const arr = (out[section] as unknown[]) ?? [];
    const appends: unknown[] = [];

    for (const d of plan.decisions) {
      if (d.section !== section) continue;
      const entry = inc[d.incoming];
      if (entry === undefined) continue;
      if (d.action === "update" && d.target !== undefined && d.target < arr.length) {
        arr[d.target] = structuredClone(entry);
        updated++;
      } else {
        appends.push(structuredClone(entry));
        added++;
      }
    }
    (out as Record<string, unknown>)[section] = arr.concat(appends);
  }

  // Skills are a flat vocabulary, not matchable entries: UNION them so a new resume
  // contributes without dropping skills the user added by hand. Case-insensitive
  // de-dupe, first spelling wins.
  if (parsed.skills.length) {
    const seen = new Set(out.skills.map((s) => s.toLowerCase()));
    for (const s of parsed.skills) {
      if (!seen.has(s.toLowerCase())) {
        out.skills.push(s);
        seen.add(s.toLowerCase());
      }
    }
  }
  // Presentation-only grouping: take the resume's if it has one.
  if (parsed.skill_groups.length) out.skill_groups = structuredClone(parsed.skill_groups);

  // personal_info: adopt what the resume states (a new resume carries the new email/phone).
  for (const [k, v] of Object.entries(parsed.personal_info)) {
    const empty = v == null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && !v.length);
    if (!empty) (out.personal_info as Record<string, unknown>)[k] = structuredClone(v);
  }

  return { profile: out, updated, added };
}
