import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashApiKey } from "@/lib/api-key";
import { isSupabaseConfigured } from "@/lib/env";

export const runtime = "nodejs";

/**
 * Extension → backend: pull the user's pending job queue. Authenticated with the
 * per-user ingest key (AP_SET_SESSION). The extension uses this to know which
 * Workday URLs to work through next.
 */
export async function GET(req: Request) {
  if (!isSupabaseConfigured()) return j({ ok: false, error: "Backend not configured." }, 503);

  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return j({ ok: false, error: "Missing bearer key." }, 401);

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return j({ ok: false, error: "Service role not configured." }, 503);
  }

  const { data: keyRow } = await admin
    .from("api_keys")
    .select("user_id")
    .eq("key_hash", hashApiKey(m[1].trim()))
    .maybeSingle();
  if (!keyRow) return j({ ok: false, error: "Invalid key." }, 401);

  const { data, error } = await admin
    .from("queue_items")
    .select("id, url, status, position")
    .eq("user_id", keyRow.user_id)
    .eq("status", "pending")
    .order("position", { ascending: true });
  if (error) return j({ ok: false, error: error.message }, 500);

  return j({ ok: true, items: data ?? [] }, 200);
}

function j(obj: unknown, status: number) {
  return NextResponse.json(obj, { status });
}
