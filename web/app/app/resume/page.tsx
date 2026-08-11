import { PageHeader } from "@/components/app/PageHeader";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { getResumeSource } from "./actions";
import { ResumePanel } from "./ResumePanel";

export const dynamic = "force-dynamic";

async function loadResume(): Promise<{ filename: string; size: number } | null> {
  if (!isSupabaseConfigured()) return null;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;
    const { data } = await supabase
      .from("resumes")
      .select("filename, size")
      .eq("user_id", user.id)
      .eq("kind", "default")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(1) // versioned résumés: maybeSingle() ERRORS on multiple rows
      .maybeSingle();
    return data ? { filename: data.filename, size: data.size } : null;
  } catch {
    return null;
  }
}

export default async function ResumePage() {
  const [stored, sourceRes] = await Promise.all([loadResume(), getResumeSource()]);
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Documents"
        title="Resume"
        description="Upload your resume's SOURCE (.tex or .docx), live-edit it, and generate the PDF that gets attached to every application — under the filename you choose."
      />
      <ResumePanel initialStored={stored} initialSource={sourceRes.ok ? sourceRes.source : null} />
    </div>
  );
}
