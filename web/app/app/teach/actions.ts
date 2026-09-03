"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { aiConfigSchema, totalUsableKeys } from "@/lib/ai-config";
import { callLLMTracked } from "@/lib/llm-server";
import {
  coerceEssays, emptyEssaysDoc, essaysDocSchema, addEssay, dedupeEssays, type EssaysDoc,
} from "@/lib/essays";

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
    if (!cfg.success || !totalUsableKeys(cfg.data)) return none;
    const system =
      "You map a job-application question to an applicant's stored profile. Given the profile (JSON), one question, and the answer the applicant gave, identify which profile field this question corresponds to as a dotted path (using the profile JSON's structure, e.g. \"work_authorization.authorized_to_work_in_us\" or \"self_identification.gender\"), or \"none\" if no existing field fits.";
    const userPrompt =
      "Question: " + input.question +
      "\nApplicant's answer: " + input.answer +
      "\nProfile: " + JSON.stringify(data?.profile_json ?? {}) +
      "\n\nReply ONLY with a JSON object and nothing else:\n{\"maps_to\":\"<profile dotted path or none>\",\"suggested_category\":\"<ONE of: Screening, Work authorization, Demographics, Personal, Experience, Education, Other>\"}";
    const res = await callLLMTracked(cfg.data, "teach", { system, user: userPrompt, maxTokens: 200 });
    return res.ok ? parseRecommendation(res.text) : none;
  } catch {
    return none;
  }
}

// ── the essay voice library ─────────────────────────────────────────────────────────────────
// Stored on `profiles.essays_json` (main.sql section 0019), exactly like buckets_json: RLS is
// inherited from the profiles owner-only policies, so there is no new policy to keep in step.

/** Load the operator's essay library. `null` (never provisioned) reads as an empty one. */
export async function loadEssays(): Promise<EssaysDoc> {
  if (!isSupabaseConfigured()) return emptyEssaysDoc();
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return emptyEssaysDoc();
    const { data } = await supabase.from("profiles").select("essays_json").eq("id", user.id).maybeSingle();
    return coerceEssays(data?.essays_json);
  } catch {
    return emptyEssaysDoc();
  }
}

/** Persist the whole library (the client sends the merged doc, as the dismissed-keys pair does). */
export async function saveEssays(raw: unknown): Promise<SaveResult> {
  const parsed = essaysDocSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Essays didn't validate." };
  if (!isSupabaseConfigured()) {
    return { ok: false, error: "Backend not connected — set Supabase env vars to save (see WEBSITE.md)." };
  }
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "You're not signed in." };
    // Dedupe on the way in as well as in the UI: this action is also the capture path, which can
    // fire twice for one essay (TextBox commits on blur).
    const doc = { style_notes: parsed.data.style_notes, essays: dedupeEssays(parsed.data.essays) };
    const { error } = await supabase.from("profiles").upsert({ id: user.id, essays_json: doc }, { onConflict: "id" });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}

/**
 * Capture ONE essay the operator just wrote on the review page.
 *
 * ⚠ READ-MODIFY-WRITE, and it must stay that way. The column holds the whole library, so a blind
 * upsert of a single essay would erase every other one. The read is cheap (one small jsonb) and this
 * fires at most once per essay per edit.
 *
 * ⚠ NEVER FATAL. It is called from the review editor's commit path, which is also autosaving the
 * bundle — losing a style sample is a small thing, losing an approved answer is not. Every failure
 * returns ok:false and the caller ignores it.
 */
export async function captureEssay(
  input: { question: string; text: string; company?: string; source?: "review" | "manual" }
): Promise<SaveResult> {
  const text = String(input?.text || "").trim();
  const question = String(input?.question || "").trim();
  if (!text) return { ok: false, error: "empty" };
  if (!isSupabaseConfigured()) return { ok: false, error: "not connected" };
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "not signed in" };
    const { data } = await supabase.from("profiles").select("essays_json").eq("id", user.id).maybeSingle();
    const doc = coerceEssays(data?.essays_json);
    const next = addEssay(doc, {
      id: "essay_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      question,
      text,
      company: String(input?.company || "").trim(),
      // "review" = captured on its own from a review-page edit; "manual" = the operator pressed
      // Save as essay themselves (the teach card, or the library's own Add).
      source: input?.source === "manual" ? "manual" : "review",
      created_at: new Date().toISOString(),
    });
    // addEssay already deduped, so a second commit of the same answer is a no-op write rather than a
    // duplicate row.
    const { error } = await supabase.from("profiles").upsert({ id: user.id, essays_json: next }, { onConflict: "id" });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "capture failed" };
  }
}
