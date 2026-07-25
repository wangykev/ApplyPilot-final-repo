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
/** tri-state boolean: true / false / null (unanswered). For genuine yes/no QUESTIONS (work
 *  authorization, screening) where "unanswered" is meaningful — the tool leaves it blank rather
 *  than guess — and for languages[].fluent (null = auto-derive from reading∧speaking∧writing).
 *  TOLERANT of legacy string values ("yes"/"no"/"true"/"false"; anything else → null) — before
 *  this, ONE string tri-bool anywhere failed the whole parse and coerceProfile silently returned
 *  an EMPTY profile (hit live: the extension's data/profile.json carries string values here). */
const triBool = z
  .preprocess((v) => {
    if (v === true || v === false || v === null) return v;
    if (typeof v === "string") {
      const t = v.trim().toLowerCase();
      if (t === "true" || t === "yes" || t === "y") return true;
      if (t === "false" || t === "no" || t === "n") return false;
      return null; // "", "unknown", prose → unanswered
    }
    return null;
  }, z.boolean().nullable())
  .default(null);
/** plain CHECKBOX boolean. A checkbox has no "unanswered" state on a form — it's checked or it isn't —
 *  so absent / null / legacy values coerce to false. Migrates old triBool nulls → false. */
const bool = z
  .preprocess((v) => v === true || v === "true" || v === "yes" || v === "on" || v === 1, z.boolean())
  .default(false);
/** ordered candidate list, most-specific first */
const tiered = z.array(z.string()).default([]);

/**
 * A website URL is stored as the FULL canonical link (operator, 2026-07-26): a scheme, AND "www." on a
 * bare apex host — "linkedin.com/in/you" → "https://www.linkedin.com/in/you". A bare host is not what a
 * form's URL field wants, and Workday's own validation rejects it.
 *
 * WHY www is REQUIRED, not cosmetic: the site (and the form) canonicalize to the www host, so a stored
 * bare host stops matching what the page actually holds — and that mismatch fails EVERY equality tier
 * in the pipeline (exact; containment, since "www." is inserted mid-string so neither side contains the
 * other; and fuzzy, which lands at 89 against the 90 bar). The result is an M40 audit flag and a
 * submitPrecondition BLOCK on a review-page DISAGREE. Storing the canonical form keeps the profile, the
 * page and the approved bundle byte-identical.
 *
 * www is added ONLY to a bare apex host, because it is WRONG anywhere else: "blog.example.com" has no
 * "www.blog.example.com", and neither does most personal-domain hosting. A host that already carries
 * ANY subdomain (including "www.") is left untouched, as are IP/userinfo hosts. An apex is 2 labels
 * ("linkedin.com"), or 3 whose last two are a public multi-part suffix ("example.co.uk").
 *
 * LOCKSTEP with the extension's ensureHttps (lib.js), which normalizes the same way at fill time — so
 * the value the operator SEES, the value synced to the extension, and the value filled all match.
 */
const APEX_MULTIPART_TLD = /^(co|com|net|org|edu|gov|ac|gob|mil)\.[a-z]{2}$/i;

export function ensureHttpsUrl(url: unknown): string {
  const t = String(url ?? "").trim();
  if (!t) return "";
  const withScheme = /^https?:\/\//i.test(t) ? t : "https://" + t;
  try {
    const u = new URL(withScheme);
    if (u.username || u.password) return withScheme; // user:pass@host — the splice below can't be trusted
    const host = u.hostname;
    if (!host || /^[\d.]+$/.test(host) || host.includes(":")) return withScheme; // IPv4/IPv6 → never www
    const labels = host.split(".");
    const isApex =
      labels.length === 2 ||
      (labels.length === 3 && APEX_MULTIPART_TLD.test(labels.slice(-2).join(".")));
    if (!isApex) return withScheme; // already subdomained (incl. www.) → leave alone
    // Splice "www." after the scheme rather than rebuilding via URL.toString(), which would also
    // normalize the rest (e.g. appending a trailing "/" to a path-less URL) — we change the host only.
    const m = /^(https?:\/\/)([\s\S]*)$/i.exec(withScheme);
    return m ? m[1] + "www." + m[2] : withScheme;
  } catch {
    return withScheme; // unparseable → still better than a scheme-less value; never throws
  }
}

/** Does this look like a usable absolute URL? (post-normalization — for the editor's inline hint) */
export function looksLikeUrl(url: unknown): boolean {
  const t = ensureHttpsUrl(url);
  if (!t) return true; // empty is not an ERROR, just unset
  try {
    const u = new URL(t);
    return !!u.hostname && u.hostname.includes(".") && !/\s/.test(t);
  } catch {
    return false;
  }
}

export const websiteSchema = z.object({
  type: str, // linkedin | github | portfolio | other
  url: str.transform(ensureHttpsUrl), // always stored as a full https:// URL
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
  currently_enrolled: bool, // checkbox
  // Resume-only: the "Relevant Coursework: …" line under this school. coerceProfile
  // bridges the extension profile's application_questions.role_specific.coursework_relevant
  // into entry 0 so an imported profile keeps its education section intact.
  coursework: z.array(z.string()).default([]),
});

// Resume-only section (not on any Workday fill path) — LOCKSTEP with the extension's
// data/profile.example.json projects shape. `bullets[]` stays an array here (unlike
// work_experience's role_description textarea) because no editor renders it yet.
export const projectSchema = z.object({
  name: str,
  role: str,
  from: str, // "YYYY-MM"
  to: str, // "YYYY-MM"
  summary: str,
  bullets: z.array(z.string()).default([]),
  tech_stack: z.array(z.string()).default([]),
  link: str,
  github: str,
});

export const workExperienceSchema = z.object({
  job_title: str,
  company: str,
  location: str,
  currently_work_here: bool, // checkbox
  from: str, // "YYYY-MM"
  to: str, // "YYYY-MM"
  role_description: str, // one textarea — how Workday renders the role description
  tech_stack: z.array(z.string()).default([]),
});

export const languageSchema = z.object({
  language: str,
  reading: str,
  speaking: str,
  writing: str,
  // Human-controlled "I am fluent" box, decoupled from the three proficiencies.
  // null = unset → the extension falls back to deriving it (all three Fluent).
  fluent: triBool,
});

/** A stored file reference (bytes live in the private `attachments` bucket). */
export const fileRefSchema = z.object({
  path: str,
  filename: str,
  size: z.number().default(0),
  mime: str,
});
/** An additional document = a human label + a file reference. */
export const additionalFileSchema = z.object({
  label: str,
  file: fileRefSchema.nullable().default(null),
});

export const specialtySchema = z.object({
  specialty: str,
  start_date: str, // "YYYY-MM-DD"
  end_date: str, // "YYYY-MM-DD"
  attachment: fileRefSchema.nullable().default(null), // optional per-specialty file
});

export const certificationSchema = z.object({
  certification: tiered,
  certification_number: str,
  issued_date: str, // "YYYY-MM-DD"
  expiration_date: str, // "YYYY-MM-DD"
  // Nested repeating sub-section (matches the extension's CERT_NESTED fill).
  specialties: z.array(specialtySchema).default([]),
});

export const personalInfoSchema = z
  .object({
    first_name: str,
    last_name: str,
    preferred_name: str,
    has_preferred_name: bool, // checkbox — "I have a preferred name"
    preferred_first_name: str,
    preferred_last_name: str,
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
    // Deterministic fallback ladder for the "How did you hear about us?" source
    // picker — tried in order, most-preferred first, BEFORE the AI drill. The
    // primary/per-application answer is deferred, so this ladder is what fills.
    // "Other" ships as the LAST default entry — an always-matching catch-all most tenants
    // offer, tried last so it can't short-circuit LinkedIn/Handshake/GitHub. The user can
    // remove or reorder it. `fallback` is retained (default empty) ONLY for backward-compat
    // with older stored profiles; the extension still appends it after `preferred` if non-empty.
    preferred: z.array(z.string()).default(["LinkedIn", "Handshake", "GitHub", "Other"]),
    fallback: z.string().default(""),
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
    willing_to_relocate_at_own_cost: triBool, // the common follow-up: relocation offered, but WHO PAYS
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
  projects: z.array(projectSchema).default([]),
  skills: z.array(z.string()).default([]),
  // Workday's "Autofill with Resume" already suggests a set of skills, and adding the whole profile list
  // on top costs a separate search round trip PER SKILL (~1.5–3s each — it is the slowest field on the
  // page). So it is OPT-IN: off ⇒ keep Workday's suggestions and record them for review; on ⇒ also add
  // every profile skill the taxonomy accepts. Default false, i.e. fast.
  fill_all_skills: z.boolean().default(false),
  languages: z.array(languageSchema).default([]),
  certifications: z.array(certificationSchema).default([]),
  work_authorization: workAuthSchema,
  how_did_you_hear: howDidYouHearSchema,
  employment_history_companies: z.array(z.string()).default([]),
  self_identification: selfIdentificationSchema,
  screening: screeningSchema,
  additional_files: z.array(additionalFileSchema).default([]),
  // Editable per-field candidate "fill ladders", keyed by field path (e.g. "screening.at_least_18_years_old"
  // or "education.0.gpa"). The field itself keeps its own value; this holds EXTRA string candidates the
  // extension tries against a dropdown/radio/typeahead option (a text box types the field's own value; a
  // CHECKBOX uses the boolean). `yes`/`no` are the per-polarity ladders for a yes/no (triBool) field;
  // `values` are the variants for a text/dropdown field (e.g. gpa → ["3.5+"], gender → ["Man"]). Empty /
  // absent → the extension's defaults (["Yes","True"] / ["No","False"] for yes/no; just the field value otherwise).
  answer_ladders: z
    .record(
      z.string(),
      z.object({
        yes: z.array(z.string()).default([]),
        no: z.array(z.string()).default([]),
        // Optional so a yes/no entry ({yes,no}) stays valid; scalar fields set it. Consumers treat
        // absent as empty (extension appendFieldVariants / the UI's `?? []`).
        values: z.array(z.string()).optional(),
      }),
    )
    .default({}),
});

export type Profile = z.infer<typeof profileSchema>;
export type Website = z.infer<typeof websiteSchema>;
export type Education = z.infer<typeof educationSchema>;
export type WorkExperience = z.infer<typeof workExperienceSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Language = z.infer<typeof languageSchema>;
export type Certification = z.infer<typeof certificationSchema>;
export type FileRef = z.infer<typeof fileRefSchema>;
export type AdditionalFile = z.infer<typeof additionalFileSchema>;

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

  // Migrate legacy work-experience bullets[] → role_description (one textarea), joined line
  // by line, so switching away from bullets never loses text.
  if (Array.isArray(obj.work_experience)) {
    obj.work_experience = obj.work_experience.map((e) => {
      if (!e || typeof e !== "object") return e;
      const rec = { ...(e as Record<string, unknown>) };
      const rd = rec.role_description;
      if ((rd == null || rd === "") && Array.isArray(rec.bullets) && rec.bullets.length) {
        rec.role_description = (rec.bullets as unknown[])
          .filter(Boolean)
          .map((b) => "- " + String(b)) // keep the bullet format, dash-style
          .join("\n");
      }
      return rec;
    });
  }

  const wa = (obj.work_authorization as Record<string, unknown>) ?? {};
  if (typeof wa.citizenship_country === "string") {
    wa.citizenship_country = wa.citizenship_country ? [wa.citizenship_country] : [];
  }
  obj.work_authorization = wa;

  // Bridge the extension profile's global coursework list into education[0].coursework
  // (the resume renders it as the "Relevant Coursework: …" line under the school).
  const aq = obj.application_questions as Record<string, unknown> | undefined;
  const rs = aq?.role_specific as Record<string, unknown> | undefined;
  const coursework = rs?.coursework_relevant;
  if (Array.isArray(coursework) && coursework.length && Array.isArray(obj.education) && obj.education[0] && typeof obj.education[0] === "object") {
    const e0 = obj.education[0] as Record<string, unknown>;
    if (!Array.isArray(e0.coursework) || !e0.coursework.length) {
      obj.education = [{ ...e0, coursework: coursework.filter(Boolean).map(String) }, ...(obj.education as unknown[]).slice(1)];
    }
  }

  const parsed = profileSchema.safeParse(obj);
  return parsed.success ? parsed.data : emptyProfile();
}

/**
 * Fill-the-blanks merge: keep everything the user already has; only take a value
 * from `incoming` (e.g. an AI parse) where the base is empty. Non-destructive —
 * a populated array or non-empty string is never overwritten. Used by
 * "Apply parsed resume to my profile".
 */
export function mergeProfile(base: Profile, incoming: Profile): Profile {
  const out = structuredClone(base);

  // personal_info: per-field fill
  for (const [k, v] of Object.entries(incoming.personal_info)) {
    const cur = (out.personal_info as Record<string, unknown>)[k];
    if (isEmpty(cur) && !isEmpty(v)) {
      (out.personal_info as Record<string, unknown>)[k] = v;
    }
  }

  // top-level arrays: take incoming only when base is empty
  const arrayKeys = [
    "websites",
    "work_experience",
    "education",
    "projects",
    "skills",
    "languages",
    "certifications",
    "employment_history_companies",
  ] as const;
  for (const k of arrayKeys) {
    if ((out[k] as unknown[]).length === 0 && (incoming[k] as unknown[]).length > 0) {
      (out as Record<string, unknown>)[k] = structuredClone(incoming[k]);
    }
  }

  return out;
}

function isEmpty(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
}
