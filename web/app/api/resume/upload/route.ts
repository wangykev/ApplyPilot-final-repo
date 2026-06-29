import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";

export const runtime = "nodejs";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

/** Upload the default resume PDF to Storage + record its metadata. */
export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return bad("Expected a multipart upload.", 400);
  }
  const file = form.get("file");
  if (!(file instanceof File)) return bad("No file provided.", 400);
  if (file.type && !file.type.includes("pdf")) return bad("Please upload a PDF.", 400);
  if (file.size > MAX_BYTES) return bad("That PDF is over 10 MB.", 400);

  if (!isSupabaseConfigured()) return bad("Backend not connected — set Supabase env vars (see WEBSITE.md).", 400);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad("You're not signed in.", 401);

  const path = `${user.id}/default-resume.pdf`;
  const { error: upErr } = await supabase.storage
    .from("resumes")
    .upload(path, file, { upsert: true, contentType: file.type || "application/pdf" });
  if (upErr) return bad("Upload failed: " + upErr.message, 500);

  // one default per user: replace the row
  await supabase.from("resumes").delete().eq("user_id", user.id).eq("kind", "default");
  const { error: insErr } = await supabase.from("resumes").insert({
    user_id: user.id,
    kind: "default",
    filename: file.name,
    mime: file.type || "application/pdf",
    size: file.size,
    storage_path: path,
  });
  if (insErr) return bad("Saved the file but couldn't record it: " + insErr.message, 500);

  return NextResponse.json({
    ok: true,
    resume: { filename: file.name, size: file.size, storage_path: path },
  });
}

function bad(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}
