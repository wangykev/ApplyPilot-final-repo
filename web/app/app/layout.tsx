import { redirect } from "next/navigation";
import { isSupabaseConfigured, DEV_PREVIEW } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { Sidebar } from "@/components/app/Sidebar";
import { LiveSyncToast } from "@/components/app/LiveSyncToast";

export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let email = "dev@local";
  let authed = false;

  if (isSupabaseConfigured()) {
    try {
      const supabase = await createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        email = user.email ?? "";
        authed = true;
      }
    } catch {
      // Supabase unreachable (e.g. placeholder creds). Falls through to the gate.
    }
  }

  // redirect() throws a control-flow signal — keep it OUT of the try above.
  if (!authed && !DEV_PREVIEW) redirect("/login");

  return (
    <div className="flex min-h-screen">
      <Sidebar email={email} />
      <div className="min-w-0 flex-1">
        <div className="mx-auto max-w-5xl px-5 py-8 sm:px-8 sm:py-10">{children}</div>
      </div>
      <LiveSyncToast />
    </div>
  );
}
