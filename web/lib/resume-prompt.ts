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
    "work_experience[].role_description is ONE paragraph (a few sentences) describing the role — how it would fill a single Workday text box, NOT a bulleted list.",
    "work_experience[].currently_work_here is a boolean: true when the role has no end date or says Present/Current, else false.",
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
      { school_or_university: "", degree: [], field_of_study: [], gpa: "", from_year: "YYYY", to_year: "YYYY" },
    ],
    skills: [],
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
    return coerceProfile(obj);
  } catch {
    return null;
  }
}
