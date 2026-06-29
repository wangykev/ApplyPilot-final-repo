import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_URL, serviceRoleKey } from "@/lib/env";

/**
 * Service-role client — SERVER ONLY, bypasses RLS. Used by the extension report
 * endpoint, where the caller authenticates with a per-user ingest key (not a
 * Supabase session) and we insert on that user's behalf after validating it.
 */
export function createAdminClient() {
  const key = serviceRoleKey();
  if (!SUPABASE_URL || !key) {
    throw new Error("Service role not configured — set SUPABASE_SERVICE_ROLE_KEY.");
  }
  return createSupabaseClient(SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
