/**
 * Centralized env access. NEXT_PUBLIC_* values are inlined into the client
 * bundle at build; server-only values are read at runtime.
 *
 * The app is designed to RUN without Supabase configured — the landing page
 * works, and auth surfaces a clear "not configured" notice rather than
 * crashing. This keeps local dev frictionless before the user provisions
 * Supabase.
 */
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export function isSupabaseConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

/**
 * Dev-only preview bypass: lets you view the signed-in UI before wiring
 * Supabase. HARD-GATED — dead code in production builds (NODE_ENV==="production")
 * and off unless NEXT_PUBLIC_DEV_PREVIEW=1. Never weakens prod auth.
 */
export const DEV_PREVIEW =
  process.env.NODE_ENV !== "production" &&
  process.env.NEXT_PUBLIC_DEV_PREVIEW === "1";

/** Server-only. Throws if read in the browser. */
export function serviceRoleKey(): string | undefined {
  if (typeof window !== "undefined") {
    throw new Error("serviceRoleKey() must never be called in the browser");
  }
  return process.env.SUPABASE_SERVICE_ROLE_KEY;
}
