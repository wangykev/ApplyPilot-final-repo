import { PageHeader } from "@/components/app/PageHeader";
import { loadUserData } from "@/lib/user-data";
import { identityResume } from "@/lib/tailor";
import { tailoredToPrintHtml, tailoredToTex } from "@/lib/resume-doc";
import { getResumePreviewUrl, getResumeSource } from "@/app/app/resume/actions";
import { listJdApplications } from "./actions";
import { TailorPanel, type OriginalResume } from "./TailorPanel";

export const dynamic = "force-dynamic";

/** The "Original" view's data. The REAL original is the uploaded PDF (shown when
 *  one is stored — a signed URL); the profile-generated rendition is the fallback
 *  and stays the baseline the tailored version is built from. */
async function loadOriginal(): Promise<OriginalResume | null> {
  const loaded = await loadUserData();
  if (!loaded.ok) return null;
  const { profile } = loaded.data;
  if (!(profile.work_experience ?? []).length && !(profile.skills ?? []).length) return null;
  const resume = identityResume(profile);
  const uploaded = await getResumePreviewUrl(); // graceful: not signed in / none stored → error
  return {
    resume,
    printHtml: tailoredToPrintHtml(profile, resume),
    tex: tailoredToTex(profile, resume),
    uploadedUrl: uploaded.ok ? uploaded.url : null,
  };
}

export default async function TailorPage() {
  const [apps, original, sourceRes] = await Promise.all([listJdApplications(), loadOriginal(), getResumeSource()]);
  const source = sourceRes.ok ? sourceRes.source : null;
  const serverTex = source?.kind === "tex" && source.tex ? { tex: source.tex, name: source.filename } : null;
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Documents"
        title="Tailor resume"
        description="Reshape your resume for a specific posting — from safe bullet selection to an aggressive rewrite. Your employers, dates, education and skills list never change; every AI edit is flagged for review."
      />
      <TailorPanel apps={apps} original={original} serverTex={serverTex} />
    </div>
  );
}
