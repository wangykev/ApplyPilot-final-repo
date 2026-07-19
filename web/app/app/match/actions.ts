"use server";

import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { coerceProfile } from "@/lib/profile-schema";
import { coerceAiConfig } from "@/lib/ai-config";
import { callLLM } from "@/lib/llm";
import { buildScorePrompt, parseScoreReply, MIN_JD_CHARS, type ScoreResult } from "@/lib/score";

export type ScoreActionResult = { ok: true; result: ScoreResult } | { ok: false; error: string };

export async function scoreMatch({ jobDescription }: { jobDescription: string }): Promise<ScoreActionResult> {
  const jd = (jobDescription || "").trim();
  if (jd.length < MIN_JD_CHARS) {
    return { ok: false, error: "Paste a job description first — a bit more text is needed to score." };
  }
  if (!isSupabaseConfigured()) {
    return { ok: false, error: "Backend not connected — set Supabase env vars (see WEBSITE.md)." };
  }
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "You're not signed in." };

    const { data } = await supabase
      .from("profiles")
      .select("profile_json, ai_config")
      .eq("id", user.id)
      .maybeSingle();
    const ai = coerceAiConfig(data?.ai_config);
    if (!ai.apiKey) return { ok: false, error: "Add an API key on the AI page first." };

    const profile = coerceProfile(data?.profile_json);
    const { system, user: prompt } = buildScorePrompt(profile, jd);
    const res = await callLLM({
      provider: ai.provider,
      model: ai.model,
      apiKey: ai.apiKey,
      system,
      user: prompt,
      maxTokens: 700,
    });
    if (!res.ok) return { ok: false, error: "AI request failed: " + res.error };

    const result = parseScoreReply(res.text);
    if (result.score == null) {
      return { ok: false, error: "Couldn't read a score from the AI reply — try again." };
    }
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}
