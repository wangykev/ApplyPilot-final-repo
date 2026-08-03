"use server";

import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { aiConfigSchema, withLegacyMirror } from "@/lib/ai-config";
import { callLLM, LLM_DEFAULT_MODELS, type LlmProvider } from "@/lib/llm";

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

    // Keep the legacy flat `apiKey` pointing at the key rotation would try first, so an
    // extension build older than the multi-key change — and the extension popup, which
    // still writes the flat shape — keeps finding a key where it expects one.
    const config = withLegacyMirror(parsed.data);

    const { error } = await supabase
      .from("profiles")
      .upsert({ id: user.id, ai_config: config }, { onConflict: "id" });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}

/**
 * Round-trip a trivial prompt with ONE specific key, server-side. Per-key rather than
 * per-config: with several keys on a provider, "does my AI work" is not a useful answer —
 * the operator needs to know WHICH key is the dead one.
 *
 * Tests against that provider's default model, which for Gemini is a free-tier model, so
 * a free key isn't reported broken merely for being pointed at a paid-only model.
 */
export async function testLlmKey(input: { provider: string; key: string }): Promise<TestResult> {
  const provider = input?.provider as LlmProvider;
  const apiKey = typeof input?.key === "string" ? input.key.trim() : "";
  if (!apiKey) return { ok: false, error: "Enter a key first." };
  if (!LLM_DEFAULT_MODELS[provider]) return { ok: false, error: `Unknown provider "${input?.provider}".` };

  const res = await callLLM({
    provider,
    model: LLM_DEFAULT_MODELS[provider],
    apiKey,
    user: 'Reply with exactly the word "OK".',
    maxTokens: 16,
  });
  return res.ok ? { ok: true, text: res.text } : { ok: false, error: res.error };
}
