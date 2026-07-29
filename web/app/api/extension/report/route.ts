import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashApiKey } from "@/lib/api-key";
import { isSupabaseConfigured } from "@/lib/env";
import { reportColumns, str } from "@/lib/report-fields";

export const runtime = "nodejs";

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

  const url = str(body.url);
  const jobKey = str(body.job_key);
  // Only the columns this payload actually carries — an absent company/role/url must NEVER null an
  // existing one (see lib/report-fields.ts: a Rehearse run wiped the tracker row's company + role that
  // way, because reportApplication always sends role:null).
  const fields = reportColumns(body, row.user_id);

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

function j(obj: unknown, status: number) {
  return NextResponse.json(obj, { status });
}
