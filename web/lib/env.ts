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

/**
 * True on a hosted serverless deploy — Vercel sets VERCEL=1 on every deployment.
 *
 * Two features shell out to NATIVE BINARIES (tectonic for LaTeX→PDF, LibreOffice
 * for .docx→PDF) and neither can live in a serverless function bundle. On a local
 * machine the fix really is "set the engine's path"; on a hosted deploy that advice
 * is MISLEADING — no env var can make the binary appear. So each message is worded
 * for WHERE IT IS RUNNING, rather than shipping one string that is wrong in one of
 * the two places. Everything else in the app is unaffected: the AI tailoring itself
 * still runs hosted, only the PDF COMPILE step is unavailable.
 */
export const IS_HOSTED = process.env.VERCEL === "1";

/** Server-only. Throws if read in the browser. */
export function serviceRoleKey(): string | undefined {
  if (typeof window !== "undefined") {
    throw new Error("serviceRoleKey() must never be called in the browser");
  }
  return process.env.SUPABASE_SERVICE_ROLE_KEY;
}
