"use server";

import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import {
  coerceCredentials,
  coerceOnboardConfig,
  credentialsSchema,
  onboardConfigSchema,
  type Credentials,
  type OnboardConfig,
} from "@/lib/credentials";

export type SaveResult = { ok: true } | { ok: false; error: string };

/** Auth + config guard shared by every action here. */
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

export async function saveCredentials(raw: unknown): Promise<SaveResult> {
  const parsed = credentialsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Credentials didn't validate." };
  try {
    const auth = await requireUser();
    if (!auth.ok) return auth;
    const { error } = await auth.supabase
      .from("profiles")
      .upsert({ id: auth.user.id, credentials_json: parsed.data }, { onConflict: "id" });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}

export async function saveOnboardConfig(raw: unknown): Promise<SaveResult> {
  const parsed = onboardConfigSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Config didn't validate." };
  try {
    const auth = await requireUser();
    if (!auth.ok) return auth;
    const { error } = await auth.supabase
      .from("profiles")
      .upsert({ id: auth.user.id, onboard_config: parsed.data }, { onConflict: "id" });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}

// ── Live-sync slices (fetched from the backend — the single source of truth — then
// pushed to the extension by @/lib/extension-sync). ──

export type CredentialsSliceResult = { ok: true; slice: Credentials } | { ok: false; error: string };
export async function getCredentialsSyncSlice(): Promise<CredentialsSliceResult> {
  try {
    const auth = await requireUser();
    if (!auth.ok) return auth;
    const { data } = await auth.supabase
      .from("profiles")
      .select("credentials_json")
      .eq("id", auth.user.id)
      .maybeSingle();
    return { ok: true, slice: coerceCredentials(data?.credentials_json) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}

export type OnboardSliceResult = { ok: true; slice: OnboardConfig } | { ok: false; error: string };
export async function getOnboardSyncSlice(): Promise<OnboardSliceResult> {
  try {
    const auth = await requireUser();
    if (!auth.ok) return auth;
    const { data } = await auth.supabase
      .from("profiles")
      .select("onboard_config")
      .eq("id", auth.user.id)
      .maybeSingle();
    return { ok: true, slice: coerceOnboardConfig(data?.onboard_config) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}
