"use server";

import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { aiConfigSchema } from "@/lib/ai-config";
import { callLLM } from "@/lib/llm";

export type SaveResult = { ok: true } | { ok: false; error: string };
export type TestResult = { ok: true; text: string } | { ok: false; error: string };

export async function saveAiConfig(raw: unknown): Promise<SaveResult> {
  const parsed = aiConfigSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "AI config didn't validate." };

  if (!isSupabaseConfigured()) {
    return { ok: false, error: "Backend not connected — set Supabase env vars to save (see WEBSITE.md)." };
  }
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "You're not signed in." };

    const { error } = await supabase
      .from("profiles")
      .upsert({ id: user.id, ai_config: parsed.data }, { onConflict: "id" });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}

/** Round-trip a trivial prompt to verify the provider + key + model (server-side). */
export async function testLlm(raw: unknown): Promise<TestResult> {
  const parsed = aiConfigSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "AI config didn't validate." };
  const { provider, model, apiKey } = parsed.data;
  if (!apiKey) return { ok: false, error: "Enter an API key to test." };

  const res = await callLLM({
    provider,
    model,
    apiKey,
    user: 'Reply with exactly the word "OK".',
    maxTokens: 16,
  });
  return res.ok ? { ok: true, text: res.text } : { ok: false, error: res.error };
}
