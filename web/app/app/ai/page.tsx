import { PageHeader } from "@/components/app/PageHeader";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { coerceAiConfig, emptyAiConfig, type AiConfig } from "@/lib/ai-config";
import { AiConfigForm } from "./AiConfigForm";

export const dynamic = "force-dynamic";

async function loadAiConfig(): Promise<AiConfig> {
  if (!isSupabaseConfigured()) return emptyAiConfig();
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return emptyAiConfig();
    const { data } = await supabase
      .from("profiles")
      .select("ai_config")
      .eq("id", user.id)
      .maybeSingle();
    return data?.ai_config ? coerceAiConfig(data.ai_config) : emptyAiConfig();
  } catch {
    return emptyAiConfig();
  }
}

export default async function AiPage() {
  const initial = await loadAiConfig();
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Engine"
        title="AI configuration"
        description="Add as many API keys per provider as you like — they're tried in turn, so one hitting its limit doesn't stop a fill. Then give any job its own model. These mirror the extension's AI settings and sync to it."
      />
      <AiConfigForm initial={initial} />
    </div>
  );
}
