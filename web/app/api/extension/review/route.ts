import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashApiKey } from "@/lib/api-key";
import { isSupabaseConfigured } from "@/lib/env";

export const runtime = "nodejs";

/**
 * Extension → backend: PULL the human-approved review bundle for an application, so the
 * SW can write it into chrome.storage.local.reviewSummary and replay/submit exactly what
 * the operator approved on the website (the review stage now lives on the site, not the
 * extension's summary.html). Authenticated with the per-user ingest key (AP_SET_SESSION),
 * mirroring the queue-pull route. READ-ONLY.
 *
 * Match strategy: `?url=` (the posting URL the report upserts by) → the exact application
 * row; falls back to the most-recently-updated application that HAS a bundle when no url is
 * given. Returns `{ ok, bundle }` (bundle null when nothing matches — the SW then keeps its
 * local bundle). The bundle is returned VERBATIM; the SW does not re-derive approval (the
 * save action already recomputed the envelope; submitPrecondition re-checks defensively).
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

  const url = new URL(req.url).searchParams.get("url");

  let q = admin
    .from("applications")
    .select("id, url, review_bundle_json, updated_at")
    .eq("user_id", keyRow.user_id)
    .not("review_bundle_json", "is", null)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (url && url.trim()) q = q.eq("url", url.trim());

  const { data, error } = await q.maybeSingle();
  if (error) return j({ ok: false, error: error.message }, 500);

  await admin
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("key_hash", hashApiKey(m[1].trim()));

  return j({ ok: true, bundle: data?.review_bundle_json ?? null, application_id: data?.id ?? null }, 200);
}

function j(obj: unknown, status: number) {
  return NextResponse.json(obj, { status });
}
