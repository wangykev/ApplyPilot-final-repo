import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashApiKey } from "@/lib/api-key";
import { isSupabaseConfigured } from "@/lib/env";

export const runtime = "nodejs";

const STATUSES = [
  "queued",
  "filling",
  "needs_review",
  "submitted",
  "interviewing",
  "offer",
  "rejected",
] as const;

/**
 * Extension → backend application-status report. Authenticated with the per-user
 * ingest key (AP_SET_SESSION). The tracker UI that surfaces these rows is P2;
 * this validates the key and records the row so the path is ready.
 */
export async function POST(req: Request) {
  if (!isSupabaseConfigured()) return j({ ok: false, error: "Backend not configured." }, 503);

  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return j({ ok: false, error: "Missing bearer key." }, 401);
  const key = m[1].trim();

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return j({ ok: false, error: "Bad JSON." }, 400);
  }

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return j({ ok: false, error: "Service role not configured." }, 503);
  }

  const { data: row } = await admin
    .from("api_keys")
    .select("user_id")
    .eq("key_hash", hashApiKey(key))
    .maybeSingle();
  if (!row) return j({ ok: false, error: "Invalid key." }, 401);

  const status = STATUSES.includes(body.status as (typeof STATUSES)[number])
    ? (body.status as string)
    : "needs_review";

  const url = str(body.url);
  const jobKey = str(body.job_key);
  const fields = {
    user_id: row.user_id,
    company: str(body.company),
    role: str(body.role),
    url,
    job_key: jobKey,
    status,
    needs_review_count: typeof body.needs_review_count === "number" ? body.needs_review_count : 0,
    review_bundle_json: body.review_bundle ?? null,
    applied_at: typeof body.captured_at === "string" ? body.captured_at : null,
  };

  // Dedupe by the stable job_key when present (a Workday application url changes every run — see
  // canonicalJobUrl), else fall back to the raw url (older reports / non-run fills). Re-running the
  // same job updates its row rather than piling up duplicates. (No unique constraint — match by hand.)
  let existing: { id: string } | null = null;
  if (jobKey) {
    const { data } = await admin
      .from("applications")
      .select("id")
      .eq("user_id", row.user_id)
      .eq("job_key", jobKey)
      .maybeSingle();
    existing = data ?? null;
  }
  if (!existing && url) {
    const { data } = await admin
      .from("applications")
      .select("id")
      .eq("user_id", row.user_id)
      .eq("url", url)
      .maybeSingle();
    existing = data ?? null;
  }
  const { error } = existing
    ? await admin
        .from("applications")
        // deleted_at: null — a re-fill of the same URL UN-deletes a previously soft-deleted app (it's
        // active again, so it returns to the tracker).
        .update({ ...fields, deleted_at: null, updated_at: new Date().toISOString() })
        .eq("id", existing.id)
    : await admin.from("applications").insert(fields);
  if (error) return j({ ok: false, error: error.message }, 500);

  await admin
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("key_hash", hashApiKey(key));

  return j({ ok: true }, 200);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function j(obj: unknown, status: number) {
  return NextResponse.json(obj, { status });
}
