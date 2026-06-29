import { PageHeader } from "@/components/app/PageHeader";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
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
      .order("created_at", { ascending: false })
      .maybeSingle();
    return data ? { filename: data.filename, size: data.size } : null;
  } catch {
    return null;
  }
}

export default async function ResumePage() {
  const stored = await loadResume();
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Documents"
        title="Resume"
        description="Upload one PDF. ApplyPilot stores it for the extension to attach, and can parse it into your profile."
      />
      <ResumePanel initialStored={stored} />
    </div>
  );
}
