"use server";

import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { callLLM } from "@/lib/llm";
import { loadUserData } from "@/lib/user-data";
import { buildTailorPrompt, parseTailorReply, type TailorMode, type TailoredResume } from "@/lib/tailor";
import { tailoredToTex, tailoredToPrintHtml } from "@/lib/resume-doc";

export type TailorActionResult =
  | { ok: true; result: TailoredResume; tex: string; printHtml: string }
  | { ok: false; error: string };

const MIN_JD_CHARS = 40;

export async function tailorResume({
  jobDescription,
  mode,
}: {
  jobDescription: string;
  mode: TailorMode;
}): Promise<TailorActionResult> {
  const jd = (jobDescription || "").trim();
  if (jd.length < MIN_JD_CHARS) {
    return { ok: false, error: "Paste a job description first — a bit more text is needed to tailor." };
  }
  if (!["select", "rewrite-surface", "rewrite-full"].includes(mode)) {
    return { ok: false, error: "Unknown tailoring mode." };
  }

  const loaded = await loadUserData();
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const { profile, ai } = loaded.data;
  if (!ai.apiKey) return { ok: false, error: "Add an API key on the AI page first." };
  if (!(profile.work_experience ?? []).length && !(profile.skills ?? []).length) {
    return { ok: false, error: "Your profile has no work experience or skills yet — fill it in (or parse your resume) first." };
  }

  const { system, user: prompt } = buildTailorPrompt(profile, jd, mode);
  const res = await callLLM({
    provider: ai.provider,
    model: ai.model,
    apiKey: ai.apiKey,
    system,
    user: prompt,
    // Generous twice over: the reply carries every bullet, AND thinking-enabled
    // models (gemini-2.5-flash) spend output tokens on thought before the JSON —
    // a tight budget truncates the reply mid-object (live-test finding).
    maxTokens: 8000,
  });
  if (!res.ok) return { ok: false, error: "AI request failed: " + res.error };

  const result = parseTailorReply(res.text, profile, mode);
  if (result.error) {
    return { ok: false, error: "Couldn't read the AI reply (" + result.error + ") — try again." };
  }
  return {
    ok: true,
    result,
    tex: tailoredToTex(profile, result),
    printHtml: tailoredToPrintHtml(profile, result),
  };
}

// ── JD sources: tracked applications that carry a scraped job description ────

export type JdApplication = {
  id: string;
  company: string;
  role: string;
  url: string;
  job_description: string;
};

/** Applications whose Run flow captured a job description — the picker's feed.
 *  Graceful []: not signed in / not configured / older rows without a JD. */
export async function listJdApplications(): Promise<JdApplication[]> {
  if (!isSupabaseConfigured()) return [];
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return [];
    const { data } = await supabase
      .from("applications")
      .select("id, company, role, url, job_description")
      .eq("user_id", user.id)
      .is("deleted_at", null)
      .not("job_description", "is", null)
      .order("created_at", { ascending: false })
      .limit(50);
    return (data ?? [])
      .filter((r) => r.job_description && String(r.job_description).trim().length >= 40)
      .map((r) => ({
        id: String(r.id),
        company: String(r.company ?? ""),
        role: String(r.role ?? ""),
        url: String(r.url ?? ""),
        job_description: String(r.job_description),
      }));
  } catch {
    return [];
  }
}
