import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { randomUUID } from "crypto";

export const runtime = "nodejs";

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB

/** Upload an attachment (specialty file or additional document) to the private
 *  `attachments` bucket under attachments/<uid>/<uuid>-<name>. Returns the file
 *  reference the caller stores in profile_json. Any file type is accepted. */
export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return bad("Expected a multipart upload.", 400);
  }
  const file = form.get("file");
  if (!(file instanceof File)) return bad("No file provided.", 400);
  if (file.size > MAX_BYTES) return bad("That file is over 20 MB.", 400);

  if (!isSupabaseConfigured()) return bad("Backend not connected — set Supabase env vars (see WEBSITE.md).", 400);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad("You're not signed in.", 401);

  const safe = (file.name || "file").replace(/[^\w.\-]+/g, "_").slice(-80);
  const path = `${user.id}/${randomUUID()}-${safe}`;
  const { error: upErr } = await supabase.storage
    .from("attachments")
    .upload(path, file, { upsert: false, contentType: file.type || "application/octet-stream" });
  if (upErr) return bad("Upload failed: " + upErr.message, 500);

  return NextResponse.json({
    ok: true,
    file: { path, filename: file.name, size: file.size, mime: file.type || "application/octet-stream" },
  });
}

function bad(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}
