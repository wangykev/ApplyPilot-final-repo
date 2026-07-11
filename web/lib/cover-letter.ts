import type { Profile } from "@/lib/profile-schema";

export type JobInput = { company: string; role: string; jobDescription: string };

/**
 * Build the cover-letter prompt from the RAW profile + the target job. Grounded
 * ONLY in the candidate's real background (never invents facts) — same guess-but-
 * -let-the-human-own-it spirit as the rest of ApplyPilot.
 */
export function buildCoverLetterPrompt(
  profile: Profile,
  job: JobInput
): { system: string; user: string } {
  const system = [
    "You write concise, specific, first-person cover letters grounded ONLY in the candidate's real background.",
    "Rules: no clichés, no 'I am writing to apply', no invented facts (companies, metrics, titles).",
    "3 short paragraphs, 220–330 words, plain text (no markdown, no placeholders like [Company]).",
    "Open with a concrete hook, not a template line. Focus the middle on 2–3 real, relevant accomplishments.",
  ].join(" ");

  const pi = profile.personal_info;
  const name = [pi.first_name, pi.last_name].filter(Boolean).join(" ");
  const work = (profile.work_experience ?? [])
    .slice(0, 3)
    .map((w) => {
      const bullets = (w.bullets ?? []).slice(0, 3).join("; ");
      return `- ${w.job_title || "Role"} at ${w.company || "a company"}${bullets ? `: ${bullets}` : ""}`;
    })
    .join("\n");
  const edu = (profile.education ?? [])
    .slice(0, 2)
    .map((e) => `${e.degree?.[0] ?? ""} ${e.field_of_study?.[0] ?? ""} — ${e.school_or_university}`.trim())
    .filter(Boolean)
    .join("; ");
  const skills = (profile.skills ?? []).slice(0, 18).join(", ");

  const user = [
    name ? `Candidate: ${name}` : "",
    `Applying to: ${job.role || "the role"} at ${job.company || "the company"}`,
    work ? `Experience:\n${work}` : "",
    edu ? `Education: ${edu}` : "",
    skills ? `Skills: ${skills}` : "",
    job.jobDescription ? `Job description:\n${job.jobDescription.slice(0, 4000)}` : "",
    "",
    "Write the cover letter now, addressed to the hiring team. Draw only on the experience above.",
  ]
    .filter(Boolean)
    .join("\n");

  return { system, user };
}
