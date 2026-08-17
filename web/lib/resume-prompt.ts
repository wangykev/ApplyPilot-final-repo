import { coerceProfile, type Profile } from "@/lib/profile-schema";

/**
 * The resume → profile extraction prompt. We ask the model for STRICT JSON
 * matching the raw profile shape, and to leave fields it can't find empty
 * (never invent). The reply is parsed tolerantly + coerced through the zod
 * schema, so a slightly-off shape still yields a valid profile.
 */
export function buildResumePrompt(resumeText: string): { system: string; user: string } {
  const system = [
    "You extract a job-application profile from a resume.",
    "Output ONLY a single JSON object — no prose, no markdown fences.",
    "Use exactly the keys shown in the template. Leave any field you cannot find as an empty string \"\" or empty array [].",
    "NEVER invent facts (emails, phone numbers, dates, employers). If it isn't in the resume, leave it blank.",
    "Dates: work_experience.from/to and certifications dates as \"YYYY-MM\" or \"YYYY-MM-DD\"; education from_year/to_year as \"YYYY\".",
    "Tiered fields (degree, field_of_study, country, country_phone_code, certification) are arrays, most-specific first.",
    // ⚠ EVERY BULLET, VERBATIM — this asked for "one paragraph (a few sentences)" until 2026-08-16,
    // and a summarising instruction is a LOSSY one: the operator's third bullet was simply dropped on
    // every role. The field fills a single text box, which is why it must stay plain text — but plain
    // text and complete are not in tension: newline-separated bullets fill a textarea perfectly well.
    // Same rule projects[] already had; work experience was the odd one out.
    "work_experience[].role_description is the role's bullet points VERBATIM — EVERY bullet, none omitted, none summarised or merged, in resume order, one per LINE separated by \\n, with no leading bullet glyphs or dashes. It fills a single plain text box, so no markup — but it must be COMPLETE.",
    "work_experience[].currently_work_here is a boolean: true when the role has no end date or says Present/Current, else false.",
    "education[].graduation_date is \"YYYY-MM\" when the resume shows an (expected) graduation month/year; education[].coursework is the 'Relevant Coursework' course list, one string per course.",
    "projects[] mirror the resume's Projects section: bullets VERBATIM (one string per bullet), tech_stack from the project's tech line.",
    "skill_groups mirror the resume's labeled skill-category lines (e.g. Languages / Tools) EXACTLY as grouped; skills is the FLAT union of every skill.",
  ].join(" ");

  const template = {
    personal_info: {
      first_name: "",
      last_name: "",
      email: "",
      phone_number: "",
      city: "",
      state_province: "",
      postal_code: "",
      country: [],
    },
    websites: [{ type: "linkedin|github|portfolio|other", url: "" }],
    work_experience: [
      { job_title: "", company: "", location: "", currently_work_here: false, from: "YYYY-MM", to: "YYYY-MM", role_description: "", tech_stack: [] },
    ],
    education: [
      {
        school_or_university: "",
        location: "",
        degree: [],
        field_of_study: [],
        gpa: "",
        gpa_scale: "",
        from_year: "YYYY",
        to_year: "YYYY",
        graduation_date: "YYYY-MM",
        coursework: [],
      },
    ],
    projects: [
      { name: "", from: "YYYY-MM", to: "YYYY-MM", summary: "", bullets: [], tech_stack: [], link: "", github: "" },
    ],
    skills: [],
    skill_groups: [{ name: "", skills: [] }],
    languages: [{ language: "", reading: "", speaking: "", writing: "" }],
    certifications: [{ certification: [], certification_number: "", issued_date: "", expiration_date: "" }],
  };

  const user = [
    "Resume text:",
    "```",
    resumeText.slice(0, 20000),
    "```",
    "",
    "Return JSON in exactly this shape (fill what the resume supports, leave the rest empty):",
    JSON.stringify(template),
  ].join("\n");

  return { system, user };
}

/** Pull a JSON object out of an LLM reply (tolerates ```json fences / prose). */
export function parseProfileFromReply(reply: string): Profile | null {
  let text = reply.trim();
  // strip code fences
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  // else slice from first { to last }
  if (!text.startsWith("{")) {
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    if (a === -1 || b === -1 || b <= a) return null;
    text = text.slice(a, b + 1);
  }
  try {
    const obj = JSON.parse(text);
    return deriveCurrentlyWorkHere(coerceProfile(obj));
  } catch {
    return null;
  }
}

/**
 * Guarantee every work-experience entry carries a concrete currently_work_here
 * (Yes/No) instead of null — so the profile's toggle is never left blank after a
 * parse. An explicit model answer is respected; only an UNSET (null) value is
 * derived, from the end date: no `to` (or a "Present"/"Current" `to`) means the
 * role is ongoing → true, otherwise → false.
 */
export function deriveCurrentlyWorkHere(profile: Profile): Profile {
  for (const w of profile.work_experience) {
    if (w.currently_work_here != null) continue;
    const to = (w.to ?? "").trim().toLowerCase();
    w.currently_work_here = to === "" || to === "present" || to === "current";
  }
  return profile;
}
