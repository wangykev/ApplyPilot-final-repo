"use server";

import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { coerceProfile } from "@/lib/profile-schema";
import {
  ONBOARDED_COOKIE,
  ONBOARDED_COOKIE_MAX_AGE,
  coerceOnboarding,
  countUsableKeys,
  missingForApproval,
  onboardingStatus,
  type OnboardingFacts,
  type OnboardingRecord,
} from "@/lib/onboarding";

export type StartResult = { ok: true } | { ok: false; error: string };
export type FactsResult = { ok: true; facts: OnboardingFacts } | { ok: false; error: string };

const NOT_CONNECTED = "Backend not connected — set Supabase env vars to save (see WEBSITE.md).";

/** The live facts every step is judged against. One place, so the page and the gate agree. */
export async function readFacts(): Promise<FactsResult> {
  if (!isSupabaseConfigured()) return { ok: false, error: NOT_CONNECTED };
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "You're not signed in." };
    return { ok: true, facts: await factsFor(supabase, user.id) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}

/**
 * Record that the human reviewed their profile — the one step with no derivable fact
 * behind it (a filled-in profile is not a reviewed one).
 *
 * The same emptiness check the button is disabled by runs again HERE, against the stored
 * profile rather than the client's copy: an approval recorded over an empty profile would
 * be a review that never happened, and the first application would fail on the most basic
 * fields.
 */
export async function approveProfile(): Promise<StartResult> {
  if (!isSupabaseConfigured()) return { ok: false, error: NOT_CONNECTED };
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "You're not signed in." };

    const [profileRes, onboardingRes] = await Promise.all([
      supabase.from("profiles").select("profile_json").eq("id", user.id).maybeSingle(),
      supabase.from("profiles").select("onboarding_json").eq("id", user.id).maybeSingle(),
    ]);

    const gaps = missingForApproval(coerceProfile(profileRes.data?.profile_json ?? {}));
    if (gaps.length) {
      const names = gaps.map((g) => g.label.toLowerCase()).join(", ");
      return { ok: false, error: `Add your ${names} before approving — every application asks for them.` };
    }

    const record: OnboardingRecord = {
      ...coerceOnboarding(onboardingRes.data?.onboarding_json),
      profile_approved_at: new Date().toISOString(),
    };
    const { error } = await supabase
      .from("profiles")
      .upsert({ id: user.id, onboarding_json: record }, { onConflict: "id" });
    if (error) return { ok: false, error: writeError(error.message) };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}

/**
 * Finish the flow. Verifies every step against LIVE data first — the client says which
 * step it thinks it is on, and that is a display concern, not something to write a
 * "you're set up" flag from. Then sets the fast-path cookie so the very next request
 * skips the gate's database read instead of waiting for middleware to notice.
 */
export async function finishOnboarding(): Promise<StartResult> {
  if (!isSupabaseConfigured()) return { ok: false, error: NOT_CONNECTED };
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "You're not signed in." };

    const facts = await factsFor(supabase, user.id);
    const status = onboardingStatus(facts);
    if (!status.complete) {
      const left = status.steps.filter((s) => !s.done).map((s) => STEP_NOUN[s.id]).join(" and ");
      return { ok: false, error: `Still missing: ${left}.` };
    }

    const { data: row } = await supabase
      .from("profiles")
      .select("onboarding_json")
      .eq("id", user.id)
      .maybeSingle();
    const record: OnboardingRecord = {
      ...coerceOnboarding(row?.onboarding_json),
      completed_at: new Date().toISOString(),
    };
    const { error } = await supabase
      .from("profiles")
      .upsert({ id: user.id, onboarding_json: record }, { onConflict: "id" });
    if (error) return { ok: false, error: writeError(error.message) };

    const store = await cookies();
    store.set(ONBOARDED_COOKIE, user.id, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: process.env.NODE_ENV === "production",
      maxAge: ONBOARDED_COOKIE_MAX_AGE,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}

const STEP_NOUN = {
  resume: "your resume",
  profile: "your profile approval",
  ai: "an AI key",
} as const;

/**
 * Shared reader: one round of live state, used by both actions and the page loader.
 *
 * `onboarding_json` is queried on its own — see the note in page.tsx. Folded into the same
 * select, a database still missing migration 0014 would fail the whole read and make a
 * configured account look empty.
 */
async function factsFor(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string
): Promise<OnboardingFacts> {
  const [aiRes, onboardingRes, resumeRes] = await Promise.all([
    supabase.from("profiles").select("ai_config").eq("id", userId).maybeSingle(),
    supabase.from("profiles").select("onboarding_json").eq("id", userId).maybeSingle(),
    supabase.from("resumes").select("id").eq("user_id", userId).eq("kind", "default").limit(1),
  ]);
  const record = coerceOnboarding(onboardingRes.data?.onboarding_json);
  return {
    hasResume: (resumeRes.data?.length ?? 0) > 0,
    profileApprovedAt: record.profile_approved_at,
    usableKeys: countUsableKeys(aiRes.data?.ai_config),
    completedAt: record.completed_at,
  };
}

/**
 * A write that fails because the column isn't there is not a mystery worth making the user
 * solve — name the migration.
 */
function writeError(message: string): string {
  return /onboarding_json/i.test(message)
    ? "Setup progress can't be saved yet — run migration 0014_onboarding.sql on your Supabase project (see WEBSITE.md)."
    : message;
}
