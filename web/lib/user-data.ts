import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured, DEV_PREVIEW } from "@/lib/env";
import { coerceProfile, type Profile } from "@/lib/profile-schema";
import { coerceAiConfig, type AiConfig } from "@/lib/ai-config";

/**
 * Shared server-side loader for "the signed-in user's profile + AI config" —
 * the pair every LLM feature (match score, tailoring, cover letter) needs.
 *
 * DEV-PREVIEW fallback (mirrors the tracker's sample-data precedent): when NOT
 * signed in AND `DEV_PREVIEW` is on (hard-gated to non-production builds), the
 * profile can come from a LOCAL file (`DEV_PREVIEW_PROFILE_PATH`, e.g. the
 * extension's operator-managed data/profile.json) and the AI config from
 * `DEV_PREVIEW_LLM_{PROVIDER,MODEL,KEY}` env vars — so the full feature flow is
 * exercisable on localhost before Supabase auth is set up. Dead code in prod.
 */

export type UserData = { profile: Profile; ai: AiConfig };
export type UserDataResult = { ok: true; data: UserData } | { ok: false; error: string };

async function devPreviewData(): Promise<UserData | null> {
  if (!DEV_PREVIEW) return null;
  const profilePath = process.env.DEV_PREVIEW_PROFILE_PATH;
  const apiKey = process.env.DEV_PREVIEW_LLM_KEY;
  if (!profilePath || !apiKey) return null;
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = JSON.parse(await readFile(profilePath, "utf-8"));
    const profile = coerceProfile(raw);
    const ai = coerceAiConfig({
      provider: process.env.DEV_PREVIEW_LLM_PROVIDER || "gemini",
      model: process.env.DEV_PREVIEW_LLM_MODEL || "gemini-2.5-flash",
      apiKey,
      enabled: true,
    });
    return { profile, ai };
  } catch {
    return null;
  }
}

export async function loadUserData(): Promise<UserDataResult> {
  if (isSupabaseConfigured()) {
    try {
      const supabase = await createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        const { data } = await supabase
          .from("profiles")
          .select("profile_json, ai_config")
          .eq("id", user.id)
          .maybeSingle();
        return {
          ok: true,
          data: { profile: coerceProfile(data?.profile_json), ai: coerceAiConfig(data?.ai_config) },
        };
      }
    } catch {
      /* fall through to dev preview / error below */
    }
  }
  const dev = await devPreviewData();
  if (dev) return { ok: true, data: dev };
  if (!isSupabaseConfigured()) {
    return { ok: false, error: "Backend not connected — set Supabase env vars (see WEBSITE.md)." };
  }
  return { ok: false, error: "You're not signed in." };
}
