"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { aiConfigSchema } from "@/lib/ai-config";
import { callLLM } from "@/lib/llm";

export type SaveResult = { ok: true } | { ok: false; error: string };
export type FieldRecommendation = { maps_to: string; suggested_category: string };

const dismissedSchema = z.array(z.string()).default([]);

/** Load the user's persistently-dismissed teach keys (normalized question labels). */
export async function loadDismissed(): Promise<string[]> {
  if (!isSupabaseConfigured()) return [];
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return [];
    const { data } = await supabase
      .from("profiles")
      .select("teach_dismissed_json")
      .eq("id", user.id)
      .maybeSingle();
    const parsed = dismissedSchema.safeParse(data?.teach_dismissed_json);
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** Persist the full set of dismissed teach keys (the client sends the merged list). */
export async function saveDismissed(raw: unknown): Promise<SaveResult> {
  const parsed = dismissedSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Dismissed list didn't validate." };
  if (!isSupabaseConfigured()) return { ok: false, error: "Backend not connected." };
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "You're not signed in." };
    // de-dupe before storing
    const unique = Array.from(new Set(parsed.data));
    const { error } = await supabase
      .from("profiles")
      .upsert({ id: user.id, teach_dismissed_json: unique }, { onConflict: "id" });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}

/** Load the user's permanently-deleted teach keys — a SUBSET of the dismissed set that's ALSO
 *  hidden from the Skipped section (the "Delete all skipped" action; see teach page partition). */
export async function loadDeleted(): Promise<string[]> {
  if (!isSupabaseConfigured()) return [];
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return [];
    const { data } = await supabase
      .from("profiles")
      .select("teach_deleted_json")
      .eq("id", user.id)
      .maybeSingle();
    const parsed = dismissedSchema.safeParse(data?.teach_deleted_json);
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** Persist the full set of permanently-deleted teach keys (the client sends the merged list). The
 *  deleted keys stay in teach_dismissed_json too (so they're out of the active queue) — this only
 *  hides them from the Skipped section. */
export async function saveDeleted(raw: unknown): Promise<SaveResult> {
  const parsed = dismissedSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Deleted list didn't validate." };
  if (!isSupabaseConfigured()) return { ok: false, error: "Backend not connected." };
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "You're not signed in." };
    const unique = Array.from(new Set(parsed.data));
    const { error } = await supabase
      .from("profiles")
      .upsert({ id: user.id, teach_deleted_json: unique }, { onConflict: "id" });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}

/** Parse the LLM's {maps_to, suggested_category} reply; tolerant of fences / embedded JSON. */
function parseRecommendation(text: string): FieldRecommendation {
  const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let obj: Record<string, unknown> | null = null;
  try {
    obj = JSON.parse(clean) as Record<string, unknown>;
  } catch {
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        obj = JSON.parse(m[0]) as Record<string, unknown>;
      } catch {
        /* ignore */
      }
    }
  }
  const mt = String(obj?.maps_to ?? "").trim();
  const cat = String(obj?.suggested_category ?? "").trim();
  return {
    maps_to: !mt || /^none$/i.test(mt) ? "" : mt,
    suggested_category: !cat || /^none$/i.test(cat) ? "" : cat,
  };
}

/**
 * Teach-time AI fallback: for a card with no stamped `maps_to` hint (an older fill, or a widget
 * path the fill-time piggyback doesn't cover), ask the LLM which profile field this question maps
 * to (+ a category), using the user's saved ai_config. Returns empty ("" / "") on any failure —
 * the card then just reads "AI didn't find a matching field", never an error.
 */
export async function recommendField(input: { question: string; answer: string }): Promise<FieldRecommendation> {
  const none: FieldRecommendation = { maps_to: "", suggested_category: "" };
  if (!isSupabaseConfigured()) return none;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return none;
    const { data } = await supabase.from("profiles").select("ai_config, profile_json").eq("id", user.id).maybeSingle();
    const cfg = aiConfigSchema.safeParse(data?.ai_config);
    if (!cfg.success || !cfg.data.apiKey) return none;
    const system =
      "You map a job-application question to an applicant's stored profile. Given the profile (JSON), one question, and the answer the applicant gave, identify which profile field this question corresponds to as a dotted path (using the profile JSON's structure, e.g. \"work_authorization.authorized_to_work_in_us\" or \"self_identification.gender\"), or \"none\" if no existing field fits.";
    const userPrompt =
      "Question: " + input.question +
      "\nApplicant's answer: " + input.answer +
      "\nProfile: " + JSON.stringify(data?.profile_json ?? {}) +
      "\n\nReply ONLY with a JSON object and nothing else:\n{\"maps_to\":\"<profile dotted path or none>\",\"suggested_category\":\"<ONE of: Screening, Work authorization, Demographics, Personal, Experience, Education, Other>\"}";
    const res = await callLLM({
      provider: cfg.data.provider,
      model: cfg.data.model,
      apiKey: cfg.data.apiKey,
      system,
      user: userPrompt,
      maxTokens: 200,
    });
    return res.ok ? parseRecommendation(res.text) : none;
  } catch {
    return none;
  }
}
