import { PageHeader } from "@/components/app/PageHeader";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { JobContextForm } from "./JobContextForm";

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
    const jc = data?.job_context_json as { company?: string } | null;
    return jc?.company ?? "";
  } catch {
    return "";
  }
}

export default async function JobPage() {
  const company = await loadCompany();
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Per application"
        title="Job context"
        description="The company you're applying to and how the extension corroborates employer-match questions."
      />
      <JobContextForm initialCompany={company} />
    </div>
  );
}
