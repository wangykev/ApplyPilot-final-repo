import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { putResume } from "@/lib/resume-store";

export const runtime = "nodejs";

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — sources are small

/** Upload the resume SOURCE (.tex or .docx) to Storage + record it. The newest source row is the one
 *  in force; earlier ones are KEPT so an application built from them can still be shown. */
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

  const mime = ext === "tex" ? "application/x-tex" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  // The newest source row wins, so uploading a .tex over a .docx simply supersedes it — no need to
  // delete the other file, and deleting it would strand any application built from it.
  const res = await putResume(supabase, user.id, "source", {
    filename: file.name,
    mime,
    bytes: new Uint8Array(await file.arrayBuffer()),
    ext,
  });
  if (!res.ok) return bad(res.error, 500);

  // .tex comes back as text so the editor can open it immediately
  let tex: string | undefined;
  if (ext === "tex") tex = await file.text();
  return NextResponse.json({ ok: true, source: { kind: ext, filename: file.name, size: file.size }, tex });
}

function bad(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}
