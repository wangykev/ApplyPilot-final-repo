import { PageHeader } from "@/components/app/PageHeader";
import { loadUserData } from "@/lib/user-data";
import { identityResume } from "@/lib/tailor";
import { tailoredToPrintHtml, tailoredToTex } from "@/lib/resume-doc";
import { listJdApplications } from "./actions";
import { TailorPanel, type OriginalResume } from "./TailorPanel";

export const dynamic = "force-dynamic";

/** The untailored resume (straight from the profile) + its documents — shown
 *  before any generation and behind the "Original" toggle after one. */
async function loadOriginal(): Promise<OriginalResume | null> {
  const loaded = await loadUserData();
  if (!loaded.ok) return null;
  const { profile } = loaded.data;
  if (!(profile.work_experience ?? []).length && !(profile.skills ?? []).length) return null;
  const resume = identityResume(profile);
  return {
    resume,
    printHtml: tailoredToPrintHtml(profile, resume),
    tex: tailoredToTex(profile, resume),
  };
}

export default async function TailorPage() {
  const [apps, original] = await Promise.all([listJdApplications(), loadOriginal()]);
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Documents"
        title="Tailor resume"
        description="Reshape your resume for a specific posting — from safe bullet selection to an aggressive rewrite. Your employers, dates, education and skills list never change; every AI edit is flagged for review."
      />
      <TailorPanel apps={apps} original={original} />
    </div>
  );
}
