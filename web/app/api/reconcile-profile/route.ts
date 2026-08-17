import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { coerceAiConfig, totalUsableKeys } from "@/lib/ai-config";
import { callLLMTracked } from "@/lib/llm-server";
import { coerceProfile, emptyProfile, profileSchema } from "@/lib/profile-schema";
import {
  buildReconcilePrompt,
  parseReconcileReply,
  validatePlan,
  applyReconcilePlan,
  entryLabel,
  RECONCILE_SECTIONS,
  type ReconcileSection,
} from "@/lib/profile-reconcile";
import { diffProfile, profileFingerprint } from "@/lib/profile-diff";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * PLAN the smart merge. Read-only: it decides what WOULD change and hands that back
 * for the user to confirm. The write happens in the `applyReconcile` server action,
 * which re-validates the plan rather than trusting this response.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad("Expected JSON.", 400);
  }
  const parsedIn = profileSchema.safeParse((body as { parsed?: unknown })?.parsed);
  if (!parsedIn.success) return bad("Parsed profile didn't validate.", 400);

  if (!isSupabaseConfigured()) return bad("Backend not connected — set Supabase env vars (see WEBSITE.md).", 400);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad("You're not signed in.", 401);

  const { data: row } = await supabase
    .from("profiles")
    .select("profile_json, ai_config")
    .eq("id", user.id)
    .maybeSingle();
  const current = row?.profile_json ? coerceProfile(row.profile_json) : emptyProfile();
  const ai = coerceAiConfig(row?.ai_config);
  if (!totalUsableKeys(ai)) return bad("Add an API key on the AI page before using smart merge.", 400);

  const { system, user: prompt } = buildReconcilePrompt(current, parsedIn.data);
  const res = await callLLMTracked(ai, "resume_parse", { system, user: prompt, maxTokens: 2048 });
  if (!res.ok) return bad("AI request failed: " + res.error, 502);

  const raw = parseReconcileReply(res.text);
  if (!raw) return bad("The model's reply wasn't valid JSON. Try again.", 502);

  const plan = validatePlan(current, parsedIn.data, raw);
  // The same before/after the other two modes show, produced by running the REAL apply
  // against a clone — the preview cannot describe something the commit won't do.
  const after = applyReconcilePlan(current, parsedIn.data, plan).profile;
  const diff = diffProfile(current, after);

  // Render the plan against real labels so the UI shows what a human can check.
  const preview = plan.decisions.map((d) => {
    const section = d.section as ReconcileSection;
    const inc = (parsedIn.data[section] as unknown[])[d.incoming];
    const from =
      d.action === "update" && d.target !== undefined
        ? entryLabel(section, (current[section] as unknown[])[d.target])
        : null;
    // ⚠ WHAT ACTUALLY CHANGES, PER ROW (operator, 2026-08-16). Without this every update row read
    // «X — replaces "X" · same role and company», which states the MATCHING decision and hides the
    // EDIT — so a row that added three role descriptions was indistinguishable from a no-op, and the
    // operator reasonably read the whole preview as "a bunch of things that were the same".
    // The diff was already computed for the summary; it just never reached the rows.
    const fields =
      d.action === "update" && d.target !== undefined
        ? entryFieldChanges(
            (current[section] as unknown[])[d.target],
            (after[section] as unknown[])[d.target],
          )
        : [];
    return {
      section,
      action: d.action,
      incoming: d.incoming,
      target: d.target ?? null,
      label: entryLabel(section, inc),
      replaces: from,
      reason: d.reason,
      fields,
    };
  });

  return NextResponse.json({
    ok: true,
    plan,
    preview,
    diff,
    fingerprint: profileFingerprint(current),
    // Sections the resume said nothing about — untouched either way, worth stating.
    untouched: RECONCILE_SECTIONS.filter((s) => ((parsedIn.data[s] ?? []) as unknown[]).length === 0),
  });
}

/** Which keys of ONE entry the merge would touch, and whether each is filling a blank or
 *  overwriting. "added" vs "changed" is the distinction a reviewer actually cares about: filling an
 *  empty role_description is safe, replacing a written one deserves a second look. Values are
 *  truncated — this is a preview, not the editor. */
export type EntryFieldChange = { key: string; kind: "added" | "changed"; before: string; after: string };
function entryFieldChanges(before: unknown, after: unknown): EntryFieldChange[] {
  const b = (before && typeof before === "object" ? before : {}) as Record<string, unknown>;
  const a = (after && typeof after === "object" ? after : {}) as Record<string, unknown>;
  const show = (v: unknown) => {
    const s = Array.isArray(v) ? v.join(", ") : v == null ? "" : String(v);
    return s.length > 160 ? s.slice(0, 160) + "…" : s;
  };
  const empty = (v: unknown) => v == null || (Array.isArray(v) ? v.length === 0 : String(v).trim() === "");
  const out: EntryFieldChange[] = [];
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (key.startsWith("_")) continue; // internal review notes are not the user's data
    if (JSON.stringify(b[key] ?? null) === JSON.stringify(a[key] ?? null)) continue;
    out.push({ key, kind: empty(b[key]) ? "added" : "changed", before: show(b[key]), after: show(a[key]) });
  }
  return out;
}

function bad(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}
