import { PageHeader } from "@/components/app/PageHeader";
import { MatchesPanel } from "./MatchesPanel";

export const dynamic = "force-dynamic";

export default function MatchesPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Find your next apply"
        title="Job matches"
        description="Pull the freshest Summer 2026 internships from SimplifyJobs, read each full job description, and score every one against your profile — with eligibility flags and one-click add-to-queue for the Workday roles the extension can auto-apply."
      />
      <MatchesPanel />
    </div>
  );
}
