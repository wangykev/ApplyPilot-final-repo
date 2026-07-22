import { PageHeader } from "@/components/app/PageHeader";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import {
  coerceCredentials,
  coerceOnboardConfig,
  emptyCredentials,
  emptyOnboardConfig,
  type Credentials,
  type OnboardConfig,
} from "@/lib/credentials";
import { CredentialsPanel } from "./CredentialsPanel";

export const dynamic = "force-dynamic";

async function load(): Promise<{ credentials: Credentials; onboard: OnboardConfig }> {
  const empty = { credentials: emptyCredentials(), onboard: emptyOnboardConfig() };
  if (!isSupabaseConfigured()) return empty;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return empty;
    const { data } = await supabase
      .from("profiles")
      .select("credentials_json, onboard_config")
      .eq("id", user.id)
      .maybeSingle();
    return {
      credentials: coerceCredentials(data?.credentials_json),
      onboard: coerceOnboardConfig(data?.onboard_config),
    };
  } catch {
    return empty;
  }
}

export default async function CredentialsPage() {
  const { credentials, onboard } = await load();
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Access"
        title="Sign-in & email"
        description="The Workday account the extension signs in with (or creates), and Gmail auto-verify for tenants that email a confirmation link. These sync to your connected extension automatically."
      />
      <CredentialsPanel initialCredentials={credentials} initialOnboard={onboard} />
    </div>
  );
}
