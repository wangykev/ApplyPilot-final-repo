import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";

export const runtime = "nodejs";

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — sources are small

/** Upload the resume SOURCE (.tex or .docx) to Storage + record it. One source
 *  per user: uploading either kind replaces the previous source (both files). */
export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return bad("Expected a multipart upload.", 400);
  }
  const file = form.get("file");
  if (!(file instanceof File)) return bad("No file provided.", 400);
  const lower = file.name.toLowerCase();
  const ext = lower.endsWith(".tex") ? "tex" : lower.endsWith(".docx") ? "docx" : null;
  if (!ext) return bad("Please upload a .tex or .docx file.", 400);
  if (file.size > MAX_BYTES) return bad("That file is over 5 MB.", 400);

  if (!isSupabaseConfigured()) return bad("Backend not connected — set Supabase env vars (see WEBSITE.md).", 400);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad("You're not signed in.", 401);

  const path = `${user.id}/source.${ext}`;
  const mime = ext === "tex" ? "application/x-tex" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const { error: upErr } = await supabase.storage
    .from("resumes")
    .upload(path, file, { upsert: true, contentType: mime });
  if (upErr) return bad("Upload failed: " + upErr.message, 500);

  // one source per user — remove the OTHER kind's file + the old row
  const other = ext === "tex" ? `${user.id}/source.docx` : `${user.id}/source.tex`;
  await supabase.storage.from("resumes").remove([other]);
  await supabase.from("resumes").delete().eq("user_id", user.id).eq("kind", "source");
  const { error: insErr } = await supabase.from("resumes").insert({
    user_id: user.id,
    kind: "source",
    filename: file.name,
    mime,
    size: file.size,
    storage_path: path,
  });
  if (insErr) return bad("Saved the file but couldn't record it: " + insErr.message, 500);

  // .tex comes back as text so the editor can open it immediately
  let tex: string | undefined;
  if (ext === "tex") tex = await file.text();
  return NextResponse.json({ ok: true, source: { kind: ext, filename: file.name, size: file.size }, tex });
}

function bad(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}
