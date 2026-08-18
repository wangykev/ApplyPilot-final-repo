import type { DateGranularity } from "@/components/form/fields";
import type { Profile } from "@/lib/profile-schema";

/**
 * Field metadata for the object-section profile fields that the teach page's
 * ProfilePanel surfaces (via flattenProfileFields). It lets the panel render each
 * field's answer editor + its bucket ("advanced options") popup exactly like the
 * real profile page does — a select for EEO, a Yes/No toggle for work-auth, a
 * segmented date, a country dropdown that expands into a tiered ladder, etc.
 *
 * The EEO / phone-type option sets live here as the SINGLE SOURCE OF TRUTH — the
 * profile page (ProfileEditor.tsx) imports them too, so the two stay in lockstep.
 * Keep in sync with ProfileEditor's per-field widgets.
 */

// ── option sets (shared with ProfileEditor) ──
export const PHONE_TYPE_OPTIONS = ["", "Mobile", "Home", "Work"];
export const GENDER_OPTIONS = ["", "Male", "Female", "Non-binary", "Decline to self-identify"];
export const YES_NO_DECLINE_OPTIONS = ["", "Yes", "No", "Decline to self-identify"];
export const RACE_ETHNICITY_OPTIONS = [
  "",
  "American Indian or Alaska Native",
  "Asian",
  "Black or African American",
  "Hispanic or Latino",
  "Native Hawaiian or Other Pacific Islander",
  "White",
  "Two or More Races",
  "Decline to self-identify",
];
export const VETERAN_STATUS_OPTIONS = [
  "",
  "I am not a protected veteran",
  "I identify as one or more of the classifications of a protected veteran",
  "Decline to self-identify",
];
export const DISABILITY_STATUS_OPTIONS = [
  "",
  "No, I do not have a disability",
  "Yes, I have a disability (or previously had one)",
  "I do not wish to answer",
];
/**
 * US security clearances, lowest to highest, with the DOE and niche ones after the ladder.
 *
 * ⚠ A CLEARANCE IS A FACTUAL CLAIM, and claiming one you do not hold is a serious matter — so the
 * blank (unset) entry and "None" mean DIFFERENT things and both are needed. Blank = "I have not told
 * ApplyPilot", which leaves a clearance question for the human (the extension refuses to guess and
 * never lets the AI answer it). "None" = "I hold no clearance", a real, statable answer that fills
 * "Do you have an active clearance?" with No deterministically.
 *
 * "Public Trust" is not strictly a clearance but is offered by most federal-contractor forms in the
 * same dropdown, so it belongs in the same list. Interim grades are listed because forms ask for them
 * specifically and an interim Secret is not a Secret.
 */
export const SECURITY_CLEARANCE_OPTIONS = [
  "",
  "None",
  "Public Trust",
  "Confidential",
  "Interim Secret",
  "Secret",
  "Interim Top Secret",
  "Top Secret",
  "Top Secret/SCI",
  "Top Secret/SCI with CI Polygraph",
  "Top Secret/SCI with Full Scope Polygraph",
  "DOE L",
  "DOE Q",
  "Yankee White",
];

// ── field metadata ──
/** How the answer editor renders a given profile field. */
export type ProfileWidget =
  | "text"
  | "dropdown"
  | "tribool" // true / false / null (yes/no with a clearable blank)
  | "checkbox" // plain boolean
  | "date"
  | "candidate" // country-style: a dropdown pick that EXPANDS into a tiered ladder
  | "state" // state/province — a US-states dropdown when the country is the US, else free text
  | "tiered" // a plain ordered candidate list (how_did_you_hear.preferred)
  | "taglist"; // an unordered free-text list (skills, employer history)

export type ProfileFieldMeta = {
  widget: ProfileWidget;
  options?: string[]; // for "dropdown"
  granularity?: DateGranularity; // for "date"
  dropdownMode?: "country" | "phone"; // for "candidate"
  /** widget_hint stored on a Mode-A bucket created from this field's label popup. */
  bucketWidget: string;
};

const TEXT: ProfileFieldMeta = { widget: "text", bucketWidget: "text" };

// Explicit per-path metadata; anything not listed falls back to TEXT (or, if the
// stored value is an array, a "tiered" ladder — see profileFieldMeta below).
const META: Record<string, ProfileFieldMeta> = {
  // personal_info
  "personal_info.phone_device_type": { widget: "dropdown", options: PHONE_TYPE_OPTIONS, bucketWidget: "dropdown" },
  "personal_info.has_preferred_name": { widget: "checkbox", bucketWidget: "checkbox" },
  "personal_info.state_province": { widget: "state", bucketWidget: "dropdown" },
  "personal_info.country": { widget: "candidate", dropdownMode: "country", bucketWidget: "dropdown" },
  "personal_info.country_phone_code": { widget: "candidate", dropdownMode: "phone", bucketWidget: "dropdown" },

  // work_authorization
  "work_authorization.authorized_to_work_in_us": { widget: "tribool", bucketWidget: "radio" },
  "work_authorization.requires_sponsorship_now": { widget: "tribool", bucketWidget: "radio" },
  "work_authorization.requires_sponsorship_future": { widget: "tribool", bucketWidget: "radio" },
  "work_authorization.permanent_resident": { widget: "tribool", bucketWidget: "radio" },
  "work_authorization.citizenship_country": { widget: "candidate", dropdownMode: "country", bucketWidget: "dropdown" },
  "work_authorization.security_clearance": { widget: "dropdown", options: SECURITY_CLEARANCE_OPTIONS, bucketWidget: "dropdown" },

  // how_did_you_hear
  "how_did_you_hear.preferred": { widget: "tiered", bucketWidget: "typeahead" },

  // top-level free-text lists
  skills: { widget: "taglist", bucketWidget: "text" },
  // A RUN SETTING, not an answer any form asks for — it decides whether the fill adds the whole skills
  // list on top of Workday's résumé suggestions. Listed so the field walker knows its widget; it is
  // rendered explicitly in the Skills card (with its slowness warning), not as a generic row.
  fill_all_skills: { widget: "checkbox", bucketWidget: "checkbox" },
  employment_history_companies: { widget: "taglist", bucketWidget: "text" },

  // self_identification (EEO)
  "self_identification.gender": { widget: "dropdown", options: GENDER_OPTIONS, bucketWidget: "dropdown" },
  "self_identification.hispanic_or_latino": { widget: "dropdown", options: YES_NO_DECLINE_OPTIONS, bucketWidget: "dropdown" },
  "self_identification.race_ethnicity": { widget: "dropdown", options: RACE_ETHNICITY_OPTIONS, bucketWidget: "dropdown" },
  "self_identification.veteran_status": { widget: "dropdown", options: VETERAN_STATUS_OPTIONS, bucketWidget: "dropdown" },
  "self_identification.disability_status": { widget: "dropdown", options: DISABILITY_STATUS_OPTIONS, bucketWidget: "dropdown" },

  // screening
  "screening.at_least_18_years_old": { widget: "tribool", bucketWidget: "radio" },
  "screening.willing_background_check": { widget: "tribool", bucketWidget: "radio" },
  "screening.willing_drug_test": { widget: "tribool", bucketWidget: "radio" },
  "screening.has_valid_drivers_license": { widget: "tribool", bucketWidget: "radio" },
  "screening.willing_to_relocate": { widget: "tribool", bucketWidget: "radio" },
  "screening.willing_to_relocate_at_own_cost": { widget: "tribool", bucketWidget: "radio" },
  "screening.remote_ok": { widget: "tribool", bucketWidget: "radio" },
  "screening.earliest_start_date": { widget: "date", granularity: "month-day-year", bucketWidget: "date" },
};

/** Metadata for a profile field path. Unlisted paths → text, unless the stored
 *  value is an array (then a tiered ladder). */
export function profileFieldMeta(path: string, rawValue?: unknown): ProfileFieldMeta {
  const hit = META[path];
  if (hit) return hit;
  if (Array.isArray(rawValue)) return { widget: "tiered", bucketWidget: "typeahead" };
  return TEXT;
}

// ── dotted get / set over the profile (immutable set) ──
export function getAtPath(profile: unknown, path: string): unknown {
  if (!path) return undefined;
  return path
    .split(".")
    .reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), profile);
}

/** Return a new Profile with `path` set to `value` (structural clone; other fields untouched). */
export function setAtPath(profile: Profile, path: string, value: unknown): Profile {
  const next = structuredClone(profile) as unknown as Record<string, unknown>;
  const keys = path.split(".");
  let cur: Record<string, unknown> = next;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
  return next as unknown as Profile;
}
