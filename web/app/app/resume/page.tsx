import { PageHeader } from "@/components/app/PageHeader";

export default function ResumePage() {
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Documents"
        title="Resume"
        description="Upload one PDF. ApplyPilot stores it for the extension to attach, and can parse it into your profile."
      />
      <div className="bezel p-10 text-center text-sm text-ink-dim">
        Resume upload + AI parse — built in M5.
      </div>
    </div>
  );
}
