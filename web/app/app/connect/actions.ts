"use server";

import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured, SITE_URL } from "@/lib/env";
import { coerceProfile } from "@/lib/profile-schema";
import { coerceBuckets, ensureStarterBuckets, STARTER_BUCKETS } from "@/lib/buckets";
import { ensureDefaultFieldWordings } from "@/lib/teach";
import { coerceAiConfig, type AiConfig } from "@/lib/ai-config";
import { coerceCredentials, coerceOnboardConfig, type Credentials, type OnboardConfig } from "@/lib/credentials";
import { generateApiKey, hashApiKey } from "@/lib/api-key";

/** The website→extension data slices (everything AP_SYNC_PROFILE / AP_SET_LLM /
 *  AP_SYNC_RESUME carry) — the reporting `session` is NOT here (it mints a key). */
export type ProfileSlice = {
  profile: unknown;
  defaults: unknown;
  buckets: unknown;
  jobContext: { company: string };
};
// The WHOLE ai_config goes to the extension, not a hand-picked subset. It used to send
// only {provider,model,apiKey,enabled}, which silently stripped the key LIST, the
// per-action routes, the fallback chains and the thinking settings — so every one of those
// features was dead on arrival in the extension no matter what the AI page said. Typing it
// as AiConfig means a future hand-pick fails the typecheck instead of failing quietly.
export type AiSlice = { llmConfig: AiConfig };
export type ResumeSlice = { resume: { filename: string; mime: string; size: number; base64: string } | null };

export type SyncBundle = ProfileSlice &
  AiSlice &
  ResumeSlice & {
    session: { ingestUrl: string; ingestKey: string; reviewUrl: string };
    credentials: Credentials;
    onboardConfig: OnboardConfig;
  };

export type BundleResult = { ok: true; bundle: SyncBundle } | { ok: false; error: string };

// A `profiles` row holds every field the profile + AI slices are shaped from.
type ProfileRow = {
  profile_json?: unknown;
  job_context_json?: unknown;
  ai_config?: unknown;
  buckets_json?: unknown;
} | null;

// ── Pure shaping (kept private — a "use server" file may only export async fns).
// SINGLE source of truth for what the profile/AI slices look like, so the
// per-slice live-sync actions and the whole-bundle sync never drift. ──
function shapeProfileSlice(row: ProfileRow): ProfileSlice {
  const profile = coerceProfile(row?.profile_json);
  const defaults = { how_did_you_hear: profile.how_did_you_hear };
  // Buckets: provision the starter set into the payload if never set (so a sync
  // before the first profile-page visit still ships them). Extension merges/stores.
  // Ship any newly-added starter bindings (education/work-experience flat fields) to the extension too,
  // even for existing users whose buckets_json predates them (dedup by profile_path; non-destructive).
  // …plus each profile field's OWN NAME as a default wording ("First Name" in the first-name bucket),
  // so a form that labels its question the way the profile labels the field fills deterministically even
  // when the tenant's automation-id isn't in FIELD_MAP (operator, 2026-07-26). Non-destructive.
  const buckets = ensureDefaultFieldWordings(
    ensureStarterBuckets(row?.buckets_json != null ? coerceBuckets(row.buckets_json) : STARTER_BUCKETS),
    profile,
  );
  const jc = row?.job_context_json as { company?: string } | null;
  const jobContext = jc?.company !== undefined ? { company: jc.company as string } : { company: "" };
  return { profile, defaults, buckets, jobContext };
}

function shapeAiSlice(row: ProfileRow): AiSlice {
  const ai = coerceAiConfig(row?.ai_config);
  return { llmConfig: ai };
}

/** Auth + config guard shared by every slice action. */
async function requireUser() {
  if (!isSupabaseConfigured()) {
    return { ok: false as const, error: "Backend not connected — set Supabase env vars (see WEBSITE.md)." };
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, error: "You're not signed in." };
  return { ok: true as const, supabase, user };
}

async function downloadResume(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string
): Promise<ResumeSlice["resume"]> {
  const { data: rrow } = await supabase
    .from("resumes")
    .select("filename, mime, size, storage_path")
    .eq("user_id", userId)
    .eq("kind", "default")
    .order("created_at", { ascending: false })
    .maybeSingle();
  if (!rrow?.storage_path) return null;
  const { data: blob } = await supabase.storage.from("resumes").download(rrow.storage_path);
  if (!blob) return null;
  const buf = Buffer.from(await blob.arrayBuffer());
  return {
    filename: rrow.filename,
    mime: rrow.mime || "application/pdf",
    size: rrow.size || buf.length,
    base64: buf.toString("base64"),
  };
}

// ── Per-slice live-sync payloads (no key minting) — the website pushes these to
// the extension after any edit, so the reporting credential is never rotated by
// a routine profile/AI/resume save (that stays a Connect-page concern). ──

export type ProfileSliceResult = { ok: true; slice: ProfileSlice } | { ok: false; error: string };
export async function getProfileSyncSlice(): Promise<ProfileSliceResult> {
  try {
    const auth = await requireUser();
    if (!auth.ok) return auth;
    const { data } = await auth.supabase
      .from("profiles")
      .select("profile_json, job_context_json, buckets_json")
      .eq("id", auth.user.id)
      .maybeSingle();
    return { ok: true, slice: shapeProfileSlice(data) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}

export type AiSliceResult = { ok: true; slice: AiSlice } | { ok: false; error: string };
export async function getAiSyncSlice(): Promise<AiSliceResult> {
  try {
    const auth = await requireUser();
    if (!auth.ok) return auth;
    const { data } = await auth.supabase
      .from("profiles")
      .select("ai_config")
      .eq("id", auth.user.id)
      .maybeSingle();
    return { ok: true, slice: shapeAiSlice(data) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}

export type ResumeSliceResult = { ok: true; slice: ResumeSlice } | { ok: false; error: string };
export async function getResumeSyncSlice(): Promise<ResumeSliceResult> {
  try {
    const auth = await requireUser();
    if (!auth.ok) return auth;
    const resume = await downloadResume(auth.supabase, auth.user.id);
    return { ok: true, slice: { resume } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}

/** Gather everything the website pushes into the extension, and mint a fresh
 *  ingest key for the reporting path. */
export async function getSyncBundle(): Promise<BundleResult> {
  try {
    const auth = await requireUser();
    if (!auth.ok) return auth;
    const { supabase, user } = auth;

    const { data: prow } = await supabase
      .from("profiles")
      .select("profile_json, job_context_json, ai_config, buckets_json, credentials_json, onboard_config")
      .eq("id", user.id)
      .maybeSingle();

    const profileSlice = shapeProfileSlice(prow);
    const aiSlice = shapeAiSlice(prow);
    const credentials = coerceCredentials((prow as { credentials_json?: unknown } | null)?.credentials_json);
    const onboardConfig = coerceOnboardConfig((prow as { onboard_config?: unknown } | null)?.onboard_config);
    const resume = await downloadResume(supabase, user.id);

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

    return { ok: true, bundle: { ...profileSlice, ...aiSlice, resume, session, credentials, onboardConfig } };
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
  try {
    const auth = await requireUser();
    if (!auth.ok) return auth;
    const { supabase, user } = auth;

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
