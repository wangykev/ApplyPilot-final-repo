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
  location: str, // resume-only ("Pittsburgh, PA")
  degree: tiered,
  field_of_study: tiered,
  minor: str,
  gpa: str,
  gpa_scale: str,
  from_year: str, // "YYYY" — résumé rendering ("2023 – 2027"); the ATS fill prefers start_date below
  to_year: str, // "YYYY" — ditto
  /**
   * ⚠ DAY-CAPABLE DATES FOR THE ATS FILL (operator, 2026-08-18). Some application forms require a
   * DAY for education start/end, and `from_year`/`to_year` are year-only — a year says nothing about a
   * month, let alone a day, so those forms fell back to `defaults.date_day` (an approximation, flagged
   * `default-value` in review) or were left to the résumé parse's guess.
   *
   * These are the day-capable equivalents: "YYYY-MM-DD" when the operator knows the day, "YYYY-MM"
   * when they only know the month. A day STATED here is a fact, so it fills unflagged and stops
   * reaching review; an absent one leaves the existing default/blank behaviour exactly as it was.
   *
   * Deliberately SEPARATE from from_year/to_year rather than a change of their format: the résumé
   * renders those as a year range, and widening a field the résumé prints is a different blast radius
   * than adding one the fill reads. The fill prefers these and falls back to the year fields.
   */
  start_date: str, // "YYYY-MM-DD" | "YYYY-MM" | ""
  end_date: str, // "YYYY-MM-DD" | "YYYY-MM" | ""
  graduation_date: str, // "YYYY-MM" or "YYYY-MM-DD" — a stated day fills unflagged
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
  // "YYYY-MM", or "YYYY-MM-DD" when the operator knows the day. A form that REQUIRES a day gets the
  // stated one unflagged; with month precision it falls back to `defaults.date_day` and flags it
  // `default-value` for review (which is what 6 of one Cretex fill's 11 review items were).
  from: str, // "YYYY-MM" | "YYYY-MM-DD"
  to: str, // "YYYY-MM" | "YYYY-MM-DD"
  role_description: str, // one textarea — how Workday renders the role description
  tech_stack: z.array(z.string()).default([]),
  // ── Employer detail some ATSs ask for and a resume never states (operator, 2026-08-16) ──
  // iCIMS' experience block asks for all of these. They are HUMAN-ENTERED only: a resume cannot
  // state a supervisor or why you left, so the resume parse must never populate them — which is why
  // they are absent from the parse template in resume-prompt.ts.
  employer_address: str,
  employer_postal_code: str,
  supervisor_name: str,
  supervisor_title: str,
  reason_for_leaving: str,
  // ⚠ TRI-STATE, not a checkbox. "may we contact this employer?" is a QUESTION with a real
  // consequence — a false yes hands a recruiter a reference you did not agree to — so an unanswered
  // one must stay unanswered rather than defaulting to either polarity. `triBool` is the same type
  // the work-authorization questions use for exactly this reason.
  may_contact: triBool,
  // Only meaningful when may_contact is true; the filler enforces that, and gates on the ANSWER
  // rather than on whether these happen to be filled in.
  employer_email: str,
  employer_phone: str,
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
    /**
     * The applicant's US security clearance, from SECURITY_CLEARANCE_OPTIONS (profile-fields.ts).
     * ⚠ EMPTY AND "None" ARE DIFFERENT ANSWERS: empty = not told, so the extension refuses to answer a
     * clearance question at all (and keeps the AI away from it — inventing a clearance is the one wrong
     * value here that could not be walked back); "None" = a stated fact that answers "do you hold a
     * clearance?" with No.
     */
    security_clearance: str,
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
  // Resume-only presentation grouping for the Technical Skills section (the
  // resume's labeled lines: Languages / Tools / …). `skills` stays the FLAT
  // canonical list the extension fills from; groups only shape the rendering.
  skill_groups: z
    .array(z.object({ name: str, skills: z.array(z.string()).default([]) }))
    .default([]),
  languages: z.array(languageSchema).default([]),
  certifications: z.array(certificationSchema).default([]),
  work_authorization: workAuthSchema,
  /**
   * Which kinds of employment the applicant would consider — a MULTI-answer question several ATSs
   * ask ("Please select the employment options you would consider…", iCIMS renders it as a native
   * multi-select). Stored as the canonical option words so a form's own wording is matched through
   * the ordinary ladder rather than guessed: an empty list simply leaves the question unanswered.
   */
  employment_types_considered: z.array(z.string()).default([]),
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
  /**
   * PARKED ladders, keyed by the same field path, each remembering the ANSWER it was written for.
   *
   * A ladder is hand-written work: the variants a tenant might phrase your answer as. It must never be
   * destroyed by an import. When the answer at a path changes, that path's `values` ladder stops being
   * about the current answer — so it is parked here rather than deleted, and restored verbatim if the
   * answer comes back (operator 2026-08-10: "accidentally changes it to no, then changes it back to
   * yes, that ladder should return").
   *
   * The per-polarity `yes`/`no` ladders are NOT parked on a flip: they are already answer-specific and
   * both stay valid whichever way the field currently reads.
   */
  answer_ladders_archive: z
    .record(
      z.string(),
      z.array(
        z.object({
          answer: z.string(),
          values: z.array(z.string()).default([]),
        }),
      ),
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
    "skill_groups",
    "languages",
    "certifications",
    "employment_history_companies",
  ] as const;
  for (const k of arrayKeys) {
    if ((out[k] as unknown[]).length === 0 && (incoming[k] as unknown[]).length > 0) {
      (out as Record<string, unknown>)[k] = structuredClone(incoming[k]);
    }
  }

  // education: when the base ALREADY has entries (so the whole-array take above
  // skipped), still fill each entry's EMPTY fields from the index-matched parsed
  // entry — this is how coursework/location/graduation_date reach a profile
  // whose education predates those schema fields. Populated values never change.
  out.education.forEach((e, i) => {
    const inc = incoming.education[i];
    if (!inc) return;
    const rec = e as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(inc)) {
      if (isEmpty(rec[k]) && !isEmpty(v)) rec[k] = structuredClone(v);
    }
  });

  return out;
}

/**
 * The ONLY sections an AI resume parse produces (see lib/resume-prompt.ts). Everything
 * outside this list — work_authorization, how_did_you_hear, self_identification,
 * screening, employment_history_companies, additional_files, answer_ladders — is
 * NEVER written by either apply mode, because a resume cannot state it.
 *
 * `employment_history_companies` is deliberately absent: it is the safety-critical
 * list behind the "have you worked here before?" auto-"No" (a non-empty list is
 * treated as COMPLETE), and a resume parse is not a trustworthy source for it.
 */
export const PARSED_ARRAY_SECTIONS = [
  "websites",
  "work_experience",
  "education",
  "projects",
  "skills",
  "skill_groups",
  "languages",
  "certifications",
] as const;

export type ParsedSection = (typeof PARSED_ARRAY_SECTIONS)[number] | "personal_info";

/**
 * Every `tech_stack` entry across work experience and projects, de-duped.
 *
 * The resume states these as per-role technology lines, but the extension only ever
 * fills from the FLAT `skills` list — so a tool you listed under a job but not in your
 * skills section would never reach a Workday skills picker. Order preserved, first
 * spelling wins.
 */
export function collectTechStack(p: Profile): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown) => {
    if (typeof raw !== "string") return;
    const t = raw.trim();
    if (!t) return;
    const k = t.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };
  for (const w of p.work_experience) (w.tech_stack ?? []).forEach(push);
  for (const pr of p.projects) (pr.tech_stack ?? []).forEach(push);
  return out;
}

/** Case-insensitive union; the existing spelling wins so the user's casing survives. */
export function unionSkills(into: string[], add: string[]): { skills: string[]; added: string[] } {
  const skills = into.slice();
  const seen = new Set(skills.map((s) => s.toLowerCase()));
  const added: string[] = [];
  for (const s of add) {
    const t = typeof s === "string" ? s.trim() : "";
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    skills.push(t);
    added.push(t);
  }
  return { skills, added };
}

export type ReplaceResult = {
  profile: Profile;
  /** Sections actually overwritten (the parse found something for them). */
  replaced: ParsedSection[];
  /** answer_ladders keys dropped because they indexed past the new array length. */
  droppedLadders: string[];
};

/**
 * REPLACE apply: overwrite the sections the parse actually found, and leave every
 * other section exactly as it was.
 *
 * Differs from `mergeProfile` in one way only — a populated section is no longer a
 * reason to skip. The guard rails that remain, and why:
 *
 * - A section the parse did NOT find is never cleared. "The AI missed my
 *   certifications" must not delete your certifications.
 * - Only PARSED_ARRAY_SECTIONS + personal_info are eligible at all, so screening
 *   answers, work authorization, self-ID and employment_history_companies survive
 *   untouched no matter what the model returns.
 * - `answer_ladders` are keyed by INDEXED path ("education.0.gpa"). Replacing an
 *   array can leave a key pointing past the end of the new one, so those dangling
 *   keys are dropped and REPORTED. In-range keys are kept: the slot still exists,
 *   and silently discarding tuning the user hand-wrote would be worse.
 */
export function replaceProfileSections(base: Profile, incoming: Profile): ReplaceResult {
  const out = structuredClone(base);
  const replaced: ParsedSection[] = [];

  // personal_info: overwrite per field, but only where the parse actually found something.
  let personalTouched = false;
  for (const [k, v] of Object.entries(incoming.personal_info)) {
    if (isEmpty(v)) continue;
    const cur = (out.personal_info as Record<string, unknown>)[k];
    if (JSON.stringify(cur) === JSON.stringify(v)) continue;
    (out.personal_info as Record<string, unknown>)[k] = structuredClone(v);
    personalTouched = true;
  }
  if (personalTouched) replaced.push("personal_info");

  for (const k of PARSED_ARRAY_SECTIONS) {
    const inc = incoming[k] as unknown[];
    if (inc.length === 0) continue; // parse found nothing → keep what the user has
    const cur = out[k] as unknown[];
    if (JSON.stringify(cur) === JSON.stringify(inc)) continue; // no-op, don't report it
    (out as Record<string, unknown>)[k] = structuredClone(inc);
    replaced.push(k);
  }

  // Fold the resume's per-role tech_stack into the flat skills list. Done AFTER the
  // section replace so it reads off the entries that actually landed. Additive only —
  // it can promote a skill the resume's own Skills line omitted, never remove one.
  const tech = collectTechStack({ ...out, work_experience: out.work_experience, projects: out.projects });
  const union = unionSkills(out.skills, tech);
  if (union.added.length) {
    out.skills = union.skills;
    if (!replaced.includes("skills")) replaced.push("skills");
  }

  const droppedLadders: string[] = [];
  for (const key of Object.keys(out.answer_ladders)) {
    const m = key.match(/^([a-z_]+)\.(\d+)\./);
    if (!m) continue;
    const section = m[1] as (typeof PARSED_ARRAY_SECTIONS)[number];
    if (!replaced.includes(section as ParsedSection)) continue;
    const len = (out[section] as unknown[] | undefined)?.length ?? 0;
    if (Number(m[2]) >= len) {
      // PARK, don't delete (operator 2026-08-10). The entry this ladder described is gone from the
      // new array, but the ladder is hand-written work: keep it under the answer it belonged to, so
      // re-adding that entry brings it straight back.
      parkLadder(out, key, answerKeyOf(readProfilePath(base, key)), out.answer_ladders[key]?.values ?? []);
      delete out.answer_ladders[key];
      droppedLadders.push(key);
    }
  }

  return { profile: out, replaced, droppedLadders };
}

// ── ANSWER LADDERS SURVIVE EVERYTHING ───────────────────────────────────────────────────────────
// Operator rule (2026-08-10): a taught ladder is never destroyed by a profile write. If the answer it
// was written for changes, the ladder is PARKED under that answer; if the answer comes back, the
// ladder comes back with it. Deleting is reserved for the user deleting it.

/** Read a dotted path ("education.0.gpa") out of a profile. */
function readProfilePath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** The comparable form of an answer. Tiered arrays compare by content; booleans by polarity. */
export function answerKeyOf(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean).join(" | ");
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v).trim();
}

/** Park a path's `values` ladder under `answer`, de-duped by answer. Never overwrites a different answer's park. */
function parkLadder(p: Profile, path: string, answer: string, values: string[]): void {
  if (!values.length) return;
  const list = p.answer_ladders_archive[path] ?? [];
  const at = list.findIndex((e) => e.answer === answer);
  if (at >= 0) list[at] = { answer, values: values.slice() };
  else list.push({ answer, values: values.slice() });
  p.answer_ladders_archive[path] = list;
}

export type LadderReconcile = { profile: Profile; parked: string[]; restored: string[] };

/**
 * Re-point the answer ladders at a profile that just changed.
 *
 * - answer UNCHANGED → the ladder is left completely alone
 * - answer CHANGED   → its `values` are parked under the OLD answer (yes/no ladders are kept as-is)
 * - answer RETURNED  → the parked `values` for exactly that answer are restored
 *
 * Pure. Nothing is ever deleted.
 */
export function reconcileLaddersToProfile(before: Profile, after: Profile): LadderReconcile {
  const out = structuredClone(after);
  const parked: string[] = [];
  const restored: string[] = [];
  const paths = new Set([
    ...Object.keys(out.answer_ladders),
    ...Object.keys(out.answer_ladders_archive),
  ]);

  for (const path of paths) {
    const wasKey = answerKeyOf(readProfilePath(before, path));
    const nowKey = answerKeyOf(readProfilePath(out, path));
    const live = out.answer_ladders[path];

    if (wasKey !== nowKey && live && (live.values ?? []).length) {
      parkLadder(out, path, wasKey, live.values ?? []);
      out.answer_ladders[path] = { ...live, values: [] };
      parked.push(path);
    }

    // Restore: an EXACT return of a parked answer brings its ladder back. A different answer is a
    // different question — re-attaching those variants would be a silently wrong answer.
    const park = (out.answer_ladders_archive[path] ?? []).find((e) => e.answer === nowKey);
    if (park && park.values.length) {
      const cur = out.answer_ladders[path] ?? { yes: [], no: [], values: [] };
      if (!(cur.values ?? []).length) {
        out.answer_ladders[path] = { ...cur, values: park.values.slice() };
        restored.push(path);
      }
    }
  }
  return { profile: out, parked, restored };
}

function isEmpty(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
}
