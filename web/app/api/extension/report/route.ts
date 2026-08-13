import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashApiKey } from "@/lib/api-key";
import { isSupabaseConfigured } from "@/lib/env";
import { reportColumns, str } from "@/lib/report-fields";
import { currentResume } from "@/lib/resume-store";

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

  // WHICH RÉSUMÉ went with this application. Stamped server-side from the user's current default,
  // because that is the document the Connect sync pushes into the extension — the extension attaches
  // its own copy of exactly these bytes.
  //
  // The honest limit: this records the résumé that is current AT REPORT TIME. If someone re-uploads
  // between syncing and running, the stamp names the newer one. Closing that gap means having the
  // extension report the hash of the bytes it actually attached, at which point `resume_sha256` below
  // is compared rather than copied — the column is here so that upgrade needs no migration.
  // resume_delta stays NULL: every run today attaches the base résumé unmodified.
  const resume = await currentResume(admin, row.user_id, "default");
  if (resume) {
    fields.resume_id = resume.id;
    if (resume.sha256) fields.resume_sha256 = resume.sha256;
  }

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
  const write = (cols: Record<string, unknown>) =>
    existing
      ? admin
          .from("applications")
          // deleted_at: null — a re-fill of the same URL UN-deletes a previously soft-deleted app (it's
          // active again, so it returns to the tracker).
          .update({ ...cols, deleted_at: null, updated_at: new Date().toISOString() })
          .eq("id", existing.id)
      : admin.from("applications").insert(cols);

  let { error } = await write(fields);
  // A database that has not run the latest migration must not lose the REPORT over an optional column.
  // Losing the bundle is the expensive failure — a whole fill has to be re-run to recover it (exactly
  // what the stale-ingest-key 401 cost). Drop the optional columns and write the bundle anyway.
  //
  // ⚠ This list must GROW with every optional column added here. `approved_at` was added to the write
  // without being added to this guard, and every report immediately 500'd against a database that had
  // not run 0018 — the bundle was silently lost on a run that had otherwise succeeded.
  if (error && /resume_(id|sha256|delta)|approved_at|job_description/.test(error.message || "")) {
    const { resume_id, resume_sha256, resume_delta, approved_at, job_description, ...rest } = fields;
    void resume_id; void resume_sha256; void resume_delta; void approved_at; void job_description;
    ({ error } = await write(rest));
  }
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
