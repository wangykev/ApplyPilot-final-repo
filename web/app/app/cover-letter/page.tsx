import { PageHeader } from "@/components/app/PageHeader";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { CoverLetterPanel } from "./CoverLetterPanel";

export const dynamic = "force-dynamic";

async function loadCompany(): Promise<string> {
  if (!isSupabaseConfigured()) return "";
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return "";
    const { data } = await supabase
      .from("profiles")
      .select("job_context_json")
      .eq("id", user.id)
      .maybeSingle();
    return (data?.job_context_json as { company?: string } | null)?.company ?? "";
  } catch {
    return "";
  }
}

export default async function CoverLetterPage() {
  const company = await loadCompany();
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Documents"
        title="Cover letter"
        description="Generate a tailored cover letter from your profile and the posting. Grounded only in your real background — review and edit before you send."
      />
      <CoverLetterPanel initialCompany={company} />
    </div>
  );
}
