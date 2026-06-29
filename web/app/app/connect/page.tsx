import { PageHeader } from "@/components/app/PageHeader";

export default function ConnectPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Handoff"
        title="Connect the extension"
        description="Link your installed ApplyPilot extension and sync your resume + profile straight into it."
      />
      <div className="bezel p-10 text-center text-sm text-ink-dim">
        Extension connect + sync — built in M7.
      </div>
    </div>
  );
}
