import { PageHeader } from "@/components/app/PageHeader";
import { listJdApplications } from "./actions";
import { TailorPanel } from "./TailorPanel";

export const dynamic = "force-dynamic";

export default async function TailorPage() {
  const apps = await listJdApplications();
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Documents"
        title="Tailor resume"
        description="Reshape your resume for a specific posting — from safe bullet selection to an aggressive rewrite. Your employers, dates, education and skills list never change; every AI edit is flagged for review."
      />
      <TailorPanel apps={apps} />
    </div>
  );
}
