"use server";

import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured, SITE_URL } from "@/lib/env";
import { coerceProfile } from "@/lib/profile-schema";
import { coerceBuckets, STARTER_BUCKETS } from "@/lib/buckets";
import { coerceAiConfig } from "@/lib/ai-config";
import { generateApiKey, hashApiKey } from "@/lib/api-key";

export type SyncBundle = {
  profile: unknown;
  defaults: unknown;
  buckets: unknown;
  jobContext: { company: string };
  llmConfig: { provider: string; model: string; apiKey: string; enabled: boolean };
  resume: { filename: string; mime: string; size: number; base64: string } | null;
  session: { ingestUrl: string; ingestKey: string; reviewUrl: string };
};

export type BundleResult = { ok: true; bundle: SyncBundle } | { ok: false; error: string };

/** Gather everything the website pushes into the extension, and mint a fresh
 *  ingest key for the reporting path. */
export async function getSyncBundle(): Promise<BundleResult> {
  if (!isSupabaseConfigured()) {
    return { ok: false, error: "Backend not connected — set Supabase env vars (see WEBSITE.md)." };
  }
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "You're not signed in." };

    const { data: prow } = await supabase
      .from("profiles")
      .select("profile_json, job_context_json, ai_config, buckets_json")
      .eq("id", user.id)
      .maybeSingle();

    const profile = coerceProfile(prow?.profile_json);
    const defaults = { how_did_you_hear: profile.how_did_you_hear };
    // Buckets: provision the starter set into the payload if never set (so a sync
    // before the first profile-page visit still ships them). Extension merges/stores.
    const buckets = prow?.buckets_json != null ? coerceBuckets(prow.buckets_json) : STARTER_BUCKETS;
    const jobContext =
      (prow?.job_context_json as { company?: string } | null)?.company !== undefined
        ? { company: (prow!.job_context_json as { company: string }).company }
        : { company: "" };
    const ai = coerceAiConfig(prow?.ai_config);
    const llmConfig = { provider: ai.provider, model: ai.model, apiKey: ai.apiKey, enabled: ai.enabled };

    // resume bytes (download from Storage -> base64)
    let resume: SyncBundle["resume"] = null;
    const { data: rrow } = await supabase
      .from("resumes")
      .select("filename, mime, size, storage_path")
      .eq("user_id", user.id)
      .eq("kind", "default")
      .order("created_at", { ascending: false })
      .maybeSingle();
    if (rrow?.storage_path) {
      const { data: blob } = await supabase.storage.from("resumes").download(rrow.storage_path);
      if (blob) {
        const buf = Buffer.from(await blob.arrayBuffer());
        resume = {
          filename: rrow.filename,
          mime: rrow.mime || "application/pdf",
          size: rrow.size || buf.length,
          base64: buf.toString("base64"),
        };
      }
    }

    // mint a fresh ingest key (rotates prior keys); only the hash is stored
    const key = generateApiKey();
    await supabase.from("api_keys").delete().eq("user_id", user.id);
    await supabase.from("api_keys").insert({
      user_id: user.id,
      key_hash: hashApiKey(key),
      label: "extension",
    });
    const session = {
      ingestUrl: `${SITE_URL}/api/extension/report`,
      ingestKey: key,
      reviewUrl: `${SITE_URL}/api/extension/review`,
    };

    return { ok: true, bundle: { profile, defaults, buckets, jobContext, llmConfig, resume, session } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}

export type SessionResult =
  | { ok: true; session: { ingestUrl: string; ingestKey: string; reviewUrl: string } }
  | { ok: false; error: string };

/** Mint ONLY the reporting credential — for linking the extension's tracker
 *  reporting without touching its profile / resume / AI config. */
export async function getSession(): Promise<SessionResult> {
  if (!isSupabaseConfigured()) {
    return { ok: false, error: "Backend not connected — set Supabase env vars (see WEBSITE.md)." };
  }
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "You're not signed in." };

    const key = generateApiKey();
    await supabase.from("api_keys").delete().eq("user_id", user.id);
    await supabase.from("api_keys").insert({ user_id: user.id, key_hash: hashApiKey(key), label: "extension" });
    return {
      ok: true,
      session: {
        ingestUrl: `${SITE_URL}/api/extension/report`,
        ingestKey: key,
        reviewUrl: `${SITE_URL}/api/extension/review`,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}
