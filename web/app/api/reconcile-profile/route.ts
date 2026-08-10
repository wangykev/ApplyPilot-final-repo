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
    return {
      section,
      action: d.action,
      incoming: d.incoming,
      target: d.target ?? null,
      label: entryLabel(section, inc),
      replaces: from,
      reason: d.reason,
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

function bad(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}
