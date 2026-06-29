import { z } from "zod";

/**
 * Canonical RAW profile (schema v2.0) — the shape stored in profiles.profile_json
 * and synced to the extension's chrome.storage.local `profile`. The extension's
 * prepareProfile derives *Parsed / bulletsText / _allFluent at fill time; the
 * website NEVER stores those. Keep this in lockstep with the extension's
 * data/profile.example.json (see WEBSITE.md → Data contracts).
 *
 * Tiered fields (country, country_phone_code, degree, field_of_study,
 * certification) are stored as ordered candidate arrays, most-specific first.
 */

const str = z.string().default("");
/** tri-state boolean: true / false / null (unanswered) */
const triBool = z.boolean().nullable().default(null);
/** ordered candidate list, most-specific first */
const tiered = z.array(z.string()).default([]);

export const websiteSchema = z.object({
  type: str, // linkedin | github | portfolio | other
  label: str,
  url: str,
});

export const educationSchema = z.object({
  school_or_university: str,
  degree: tiered,
  field_of_study: tiered,
  minor: str,
  gpa: str,
  gpa_scale: str,
  from_year: str, // "YYYY"
  to_year: str, // "YYYY"
  graduation_date: str, // "YYYY-MM"
  currently_enrolled: triBool,
});

export const workExperienceSchema = z.object({
  job_title: str,
  company: str,
  location: str,
  currently_work_here: triBool,
  from: str, // "YYYY-MM"
  to: str, // "YYYY-MM"
  bullets: z.array(z.string()).default([]),
  tech_stack: z.array(z.string()).default([]),
});

export const languageSchema = z.object({
  language: str,
  reading: str,
  speaking: str,
  writing: str,
});

export const certificationSchema = z.object({
  certification: tiered,
  certification_number: str,
  issued_date: str, // "YYYY-MM-DD"
  expiration_date: str, // "YYYY-MM-DD"
});

export const personalInfoSchema = z
  .object({
    first_name: str,
    last_name: str,
    preferred_name: str,
    has_preferred_name: triBool,
    email: str,
    phone_number: str,
    phone_extension: str,
    phone_device_type: str, // Mobile | Home | Work
    address_line_1: str,
    address_line_2: str,
    city: str,
    state_province: str,
    postal_code: str,
    country: tiered,
    country_phone_code: tiered,
  })
  .default({});

export const workAuthSchema = z
  .object({
    authorized_to_work_in_us: triBool,
    requires_sponsorship_now: triBool,
    requires_sponsorship_future: triBool,
    permanent_resident: triBool,
    current_visa_status: str,
    citizenship_country: tiered,
  })
  .default({});

export const howDidYouHearSchema = z
  .object({
    preferred: z.array(z.string()).default([]),
    fallback: str,
  })
  .default({});

export const selfIdentificationSchema = z
  .object({
    gender: str,
    hispanic_or_latino: str,
    race_ethnicity: str,
    veteran_status: str,
    disability_status: str,
  })
  .default({});

export const screeningSchema = z
  .object({
    at_least_18_years_old: triBool,
    willing_background_check: triBool,
    willing_drug_test: triBool,
    has_valid_drivers_license: triBool,
    willing_to_relocate: triBool,
    remote_ok: triBool,
    earliest_start_date: str, // "YYYY-MM-DD"
    years_of_experience_total: str,
    salary_expectation: str,
  })
  .default({});

export const profileSchema = z.object({
  schema_version: z.string().default("2.0"),
  personal_info: personalInfoSchema,
  websites: z.array(websiteSchema).default([]),
  work_experience: z.array(workExperienceSchema).default([]),
  education: z.array(educationSchema).default([]),
  skills: z.array(z.string()).default([]),
  languages: z.array(languageSchema).default([]),
  certifications: z.array(certificationSchema).default([]),
  work_authorization: workAuthSchema,
  how_did_you_hear: howDidYouHearSchema,
  employment_history_companies: z.array(z.string()).default([]),
  self_identification: selfIdentificationSchema,
  screening: screeningSchema,
});

export type Profile = z.infer<typeof profileSchema>;
export type Website = z.infer<typeof websiteSchema>;
export type Education = z.infer<typeof educationSchema>;
export type WorkExperience = z.infer<typeof workExperienceSchema>;
export type Language = z.infer<typeof languageSchema>;
export type Certification = z.infer<typeof certificationSchema>;

/** A fully-defaulted empty profile. */
export function emptyProfile(): Profile {
  return profileSchema.parse({});
}

/**
 * Coerce an arbitrary stored blob into a valid Profile, tolerating older shapes
 * (e.g. a plain string where a tiered array is expected). Unknown keys are
 * dropped. Never throws — returns a best-effort valid profile.
 */
export function coerceProfile(raw: unknown): Profile {
  const obj: Record<string, unknown> =
    raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : {};

  // string -> [string] for tiered top-level-ish fields
  const pi = (obj.personal_info as Record<string, unknown>) ?? {};
  for (const k of ["country", "country_phone_code"]) {
    if (typeof pi[k] === "string") pi[k] = pi[k] ? [pi[k] as string] : [];
  }
  obj.personal_info = pi;

  const fixTieredIn = (arr: unknown, keys: string[]) => {
    if (!Array.isArray(arr)) return arr;
    return arr.map((e) => {
      if (!e || typeof e !== "object") return e;
      const rec = { ...(e as Record<string, unknown>) };
      for (const k of keys) {
        if (typeof rec[k] === "string") rec[k] = rec[k] ? [rec[k] as string] : [];
      }
      return rec;
    });
  };
  obj.education = fixTieredIn(obj.education, ["degree", "field_of_study"]);
  obj.certifications = fixTieredIn(obj.certifications, ["certification"]);

  const wa = (obj.work_authorization as Record<string, unknown>) ?? {};
  if (typeof wa.citizenship_country === "string") {
    wa.citizenship_country = wa.citizenship_country ? [wa.citizenship_country] : [];
  }
  obj.work_authorization = wa;

  const parsed = profileSchema.safeParse(obj);
  return parsed.success ? parsed.data : emptyProfile();
}
