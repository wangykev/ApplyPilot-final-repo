import { PageHeader } from "@/components/app/PageHeader";
import { ConnectPanel } from "./ConnectPanel";

export const dynamic = "force-dynamic";

export default function ConnectPage() {
  const initialExtId = process.env.NEXT_PUBLIC_EXTENSION_ID ?? "";
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Handoff"
        title="Connect the extension"
        description="Link your installed ApplyPilot extension and sync your resume + profile straight into it. Nothing leaves your machine except the AI calls you configure."
      />
      <ConnectPanel initialExtId={initialExtId} />
    </div>
  );
}
