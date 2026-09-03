"use server";

import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { coerceProfile } from "@/lib/profile-schema";
import { coerceEssays } from "@/lib/essays";
import { coerceAiConfig, totalUsableKeys } from "@/lib/ai-config";
import { callLLMTracked } from "@/lib/llm-server";
import { buildCoverLetterPrompt, type JobInput } from "@/lib/cover-letter";

export type GenResult = { ok: true; text: string } | { ok: false; error: string };

export async function generateCoverLetter(job: JobInput): Promise<GenResult> {
  if (!job.company && !job.role && !job.jobDescription) {
    return { ok: false, error: "Add a company, role, or job description first." };
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
      .select("profile_json, ai_config, essays_json")
      .eq("id", user.id)
      .maybeSingle();
    const ai = coerceAiConfig(data?.ai_config);
    if (!totalUsableKeys(ai)) return { ok: false, error: "Add an API key on the AI page first." };

    const profile = coerceProfile(data?.profile_json);
    // The operator's own writing, so the letter sounds like them rather than like the model.
    const essays = coerceEssays(data?.essays_json);
    const { system, user: prompt } = buildCoverLetterPrompt(profile, job, essays);
    const res = await callLLMTracked(ai, "cover_letter", { system, user: prompt, maxTokens: 900 });
    if (!res.ok) return { ok: false, error: "AI request failed: " + res.error };
    return { ok: true, text: res.text };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}
