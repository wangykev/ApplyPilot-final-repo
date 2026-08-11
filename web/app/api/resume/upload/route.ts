import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { putResume } from "@/lib/resume-store";

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

  // VERSIONED, not replaced (see lib/resume-store): the previous row and its bytes stay, so an
  // application that recorded "sent with this résumé" still resolves to the document it really used.
  const res = await putResume(supabase, user.id, "default", {
    filename: file.name,
    mime: file.type || "application/pdf",
    bytes: new Uint8Array(await file.arrayBuffer()),
    ext: "pdf",
  });
  if (!res.ok) return bad(res.error, 500);

  return NextResponse.json({
    ok: true,
    resume: { filename: res.row.filename, size: res.row.size, storage_path: res.row.storage_path },
  });
}

function bad(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}
