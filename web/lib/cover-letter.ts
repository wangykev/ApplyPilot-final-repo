import type { Profile } from "@/lib/profile-schema";
import { recentEssays, emptyEssaysDoc, type EssaysDoc } from "@/lib/essays";

export type JobInput = { company: string; role: string; jobDescription: string };

/**
 * Build the cover-letter prompt from the RAW profile + the target job. Grounded
 * ONLY in the candidate's real background (never invents facts) — same guess-but-
 * -let-the-human-own-it spirit as the rest of ApplyPilot.
 */
export function buildCoverLetterPrompt(
  profile: Profile,
  job: JobInput,
  /**
   * The operator's essay library. Optional, so an existing caller and a first-time user with no
   * essays both keep exactly the behaviour that was here before.
   *
   * ⚠ RECENCY, NOT RELEVANCE, and that is a real distinction rather than a shortcut. A cover letter
   * has no single question to rank samples against — the whole posting is the prompt — so "most
   * recent" is the only honest ordering. The fill path ranks by question overlap because it HAS a
   * question to rank against.
   */
  essays?: EssaysDoc | null
): { system: string; user: string } {
  const system = [
    "You write concise, specific, first-person cover letters grounded ONLY in the candidate's real background.",
    "Rules: no clichés, no 'I am writing to apply', no invented facts (companies, metrics, titles).",
    "3 short paragraphs, 220–330 words, plain text (no markdown, no placeholders like [Company]).",
    "Open with a concrete hook, not a template line. Focus the middle on 2–3 real, relevant accomplishments.",
  ].join(" ");

  // The candidate's OWN writing. Until now this prompt's voice was entirely hardcoded above and read
  // nothing the operator had ever written, so every letter sounded like the model rather than them.
  const doc = essays || emptyEssaysDoc();
  const samples = recentEssays(doc, 3);
  const styleNotes = String(doc.style_notes || "").trim();

  const pi = profile.personal_info;
  const name = [pi.first_name, pi.last_name].filter(Boolean).join(" ");
  const work = (profile.work_experience ?? [])
    .slice(0, 3)
    .map((w) => {
      const desc = (w.role_description ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
      return `- ${w.job_title || "Role"} at ${w.company || "a company"}${desc ? `: ${desc}` : ""}`;
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
    styleNotes ? `How I write (my own instructions): ${styleNotes}` : "",
    // ⚠ THE LENGTH RULES IN THE SYSTEM PROMPT STILL GOVERN. These samples are for VOICE and for
    // facts, not for length: a letter is a different form from a three-sentence application answer,
    // so "match this voice" must not be read as "match this length" — hence the closing clause.
    samples.length
      ? "My own past application answers — my writing, not yours. Match this voice: sentence length,"
        + " directness, how much detail I give. You MAY reuse concrete facts from them (projects,"
        + " tools, numbers) where they genuinely fit this role — they describe my work in more detail"
        + " than the experience list above. Keep to the length rules regardless.\n"
        + samples.map((e, i) => `--- sample ${i + 1}\n${e.text}`).join("\n")
      : "",
    "",
    "Write the cover letter now, addressed to the hiring team. Draw only on the experience above.",
  ]
    .filter(Boolean)
    .join("\n");

  return { system, user };
}
