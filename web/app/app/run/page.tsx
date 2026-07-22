import { PageHeader } from "@/components/app/PageHeader";
import { RunPanel } from "./RunPanel";

export default function RunPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Autopilot"
        title="Run an application"
        description="Paste a Workday job link and press Run. The extension opens it in a new tab, grabs the job description, applies, signs in and verifies your email if the tenant needs it, then fills every page — stopping at the review page for you to approve. It never submits."
      />
      <RunPanel />
    </div>
  );
}
