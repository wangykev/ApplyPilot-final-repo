"use server";

import { callLLM } from "@/lib/llm";
import { loadUserData } from "@/lib/user-data";
import { buildScorePrompt, parseScoreReply, MIN_JD_CHARS, type ScoreResult } from "@/lib/score";

export type ScoreActionResult = { ok: true; result: ScoreResult } | { ok: false; error: string };

export async function scoreMatch({ jobDescription }: { jobDescription: string }): Promise<ScoreActionResult> {
  const jd = (jobDescription || "").trim();
  if (jd.length < MIN_JD_CHARS) {
    return { ok: false, error: "Paste a job description first — a bit more text is needed to score." };
  }

  const loaded = await loadUserData();
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const { profile, ai } = loaded.data;
  if (!ai.apiKey) return { ok: false, error: "Add an API key on the AI page first." };

  const { system, user: prompt } = buildScorePrompt(profile, jd);
  const res = await callLLM({
    provider: ai.provider,
    model: ai.model,
    apiKey: ai.apiKey,
    system,
    user: prompt,
    // Generous: thinking-enabled models (gemini-2.5-flash) spend output tokens on
    // thought BEFORE the JSON — a tight budget truncates the reply mid-object.
    maxTokens: 2500,
  });
  if (!res.ok) return { ok: false, error: "AI request failed: " + res.error };

  const result = parseScoreReply(res.text);
  if (result.score == null) {
    return { ok: false, error: "Couldn't read a score from the AI reply — try again." };
  }
  return { ok: true, result };
}
