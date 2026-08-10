/**
 * "What will this do to my profile?" — computed, not described.
 *
 * The rule that makes this trustworthy: a preview is produced by RUNNING the real
 * apply function against a clone and diffing the result. No mode re-implements its
 * own explanation, so a preview cannot drift from behaviour when someone edits the
 * merge rules later. (The alternative — hand-written "this mode overwrites X" copy —
 * is exactly the kind of thing that silently goes stale and lies to the user.)
 */
import { createHash } from "node:crypto";
import type { Profile } from "./profile-schema";
import { entryLabel, RECONCILE_SECTIONS, type ReconcileSection } from "./profile-reconcile";

export type EntryChange =
  | { kind: "add"; index: number; label: string }
  | { kind: "remove"; index: number; label: string }
  | { kind: "change"; index: number; before: string; after: string; fields: string[] };

export type FieldChange = { field: string; before: string; after: string };

export type SectionDiff = {
  section: string;
  fields?: FieldChange[];
  entries?: EntryChange[];
  /** Plain strings added/removed (skills, employment_history_companies). */
  values?: { added: string[]; removed: string[] };
};

export type ProfileDiff = {
  sections: SectionDiff[];
  /** Non-fatal things the user should know before committing. */
  warnings: string[];
};

const OBJECT_ARRAYS = [
  "work_experience",
  "education",
  "projects",
  "certifications",
  "languages",
  "websites",
  "skill_groups",
] as const;

const STRING_ARRAYS = ["skills", "employment_history_companies"] as const;

const SCALAR_SECTIONS = [
  "work_authorization",
  "how_did_you_hear",
  "self_identification",
  "screening",
] as const;

function show(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "string") return v.trim() === "" ? "—" : v;
  if (Array.isArray(v)) return v.length ? v.map(show).join(", ") : "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function labelFor(section: string, e: unknown): string {
  if ((RECONCILE_SECTIONS as readonly string[]).includes(section)) {
    return entryLabel(section as ReconcileSection, e);
  }
  const r = (e ?? {}) as Record<string, unknown>;
  if (typeof r.name === "string" && r.name) return r.name;
  return show(e).slice(0, 80);
}

/** Which fields differ between two entry objects. */
function changedFields(a: unknown, b: unknown): string[] {
  const ra = (a ?? {}) as Record<string, unknown>;
  const rb = (b ?? {}) as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  const out: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(ra[k]) !== JSON.stringify(rb[k])) out.push(k);
  }
  return out;
}

export function diffProfile(before: Profile, after: Profile): ProfileDiff {
  const sections: SectionDiff[] = [];
  const warnings: string[] = [];

  // personal_info + the scalar answer blocks — field level.
  for (const key of ["personal_info", ...SCALAR_SECTIONS] as const) {
    const a = (before[key] ?? {}) as Record<string, unknown>;
    const b = (after[key] ?? {}) as Record<string, unknown>;
    const fields: FieldChange[] = [];
    for (const f of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) {
        fields.push({ field: f, before: show(a[f]), after: show(b[f]) });
      }
    }
    if (fields.length) sections.push({ section: key, fields });
  }

  // Object arrays — positional compare, so a "change" is an in-place update.
  for (const key of OBJECT_ARRAYS) {
    const a = (before[key] ?? []) as unknown[];
    const b = (after[key] ?? []) as unknown[];
    const entries: EntryChange[] = [];
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (i >= a.length) {
        entries.push({ kind: "add", index: i, label: labelFor(key, b[i]) });
      } else if (i >= b.length) {
        entries.push({ kind: "remove", index: i, label: labelFor(key, a[i]) });
      } else if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) {
        entries.push({
          kind: "change",
          index: i,
          before: labelFor(key, a[i]),
          after: labelFor(key, b[i]),
          fields: changedFields(a[i], b[i]),
        });
      }
    }
    if (entries.length) sections.push({ section: key, entries });
  }

  // Plain string lists — set semantics read better than positions.
  for (const key of STRING_ARRAYS) {
    const a = (before[key] ?? []) as string[];
    const b = (after[key] ?? []) as string[];
    const setA = new Set(a);
    const setB = new Set(b);
    const added = b.filter((x) => !setA.has(x));
    const removed = a.filter((x) => !setB.has(x));
    if (added.length || removed.length) sections.push({ section: key, values: { added, removed } });
  }

  // answer_ladders: keyed by INDEXED path, so an array that changed shape can leave a
  // ladder pointing at a different entry than the one it was written for. Dropped keys
  // are already reported by the apply step; this catches the quieter case — the key is
  // still in range, but the entry underneath it is not the same one.
  const dropped = Object.keys(before.answer_ladders).filter((k) => !(k in after.answer_ladders));
  if (dropped.length) {
    warnings.push(`${dropped.length} answer ladder(s) will be dropped as dangling: ${dropped.join(", ")}`);
  }
  for (const key of Object.keys(after.answer_ladders)) {
    const m = key.match(/^([a-z_]+)\.(\d+)\./);
    if (!m) continue;
    const section = m[1];
    if (!(OBJECT_ARRAYS as readonly string[]).includes(section)) continue;
    const i = Number(m[2]);
    const a = (before[section as keyof Profile] ?? []) as unknown[];
    const b = (after[section as keyof Profile] ?? []) as unknown[];
    if (i < a.length && i < b.length && JSON.stringify(a[i]) !== JSON.stringify(b[i])) {
      warnings.push(
        `answer ladder "${key}" now applies to "${labelFor(section, b[i])}" instead of "${labelFor(section, a[i])}"`,
      );
    }
  }

  return { sections, warnings };
}

/**
 * Identity of a profile at a point in time. The preview is computed against one
 * snapshot and applied against another, so the apply step compares fingerprints and
 * refuses when they differ — otherwise the user could approve a diff and get a
 * different write (edit the profile in a second tab, then confirm a stale plan).
 */
export function profileFingerprint(p: Profile): string {
  return createHash("sha256").update(stable(p)).digest("hex").slice(0, 16);
}

/** Key-order-independent JSON so a re-serialised profile keeps the same fingerprint. */
function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + stable(o[k])).join(",") + "}";
}
