/**
 * Canonical US state / territory list for the profile editor's State field.
 *
 * The State field shows this DROPDOWN when the selected country is the United States, and a free-text
 * box otherwise (you can type your own region or leave it blank). The list is FIXED — the same
 * regardless of the country (US → this list). Full names match Workday's `countryRegion` option text,
 * so the extension's EXACT match lands (containment is off for dropdowns now, 2026-07-16), instead of a
 * 2-letter abbreviation like "PA" that used to mis-match "Armed Forces Pacific".
 */

// Full set: 50 states + DC + territories + military postings (all real Workday countryRegion options).
// Exported SORTED so the dropdown reads A→Z like Workday's own review-page list (findability) — the
// territories / armed-forces entries sort IN (e.g. "American Samoa" near the top), not at the bottom.
const US_STATES_SET: string[] = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware",
  "District of Columbia", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa",
  "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota",
  "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico",
  "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island",
  "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington",
  "West Virginia", "Wisconsin", "Wyoming",
  "American Samoa", "Guam", "Northern Mariana Islands", "Puerto Rico", "United States Virgin Islands",
  "Armed Forces Americas", "Armed Forces Europe", "Armed Forces Pacific",
];

export const US_STATES: string[] = [...US_STATES_SET].sort((a, b) => a.localeCompare(b));

// 2-letter USPS abbreviations → the canonical full name (so a legacy "PA" auto-upgrades to "Pennsylvania").
const US_STATE_BY_ABBR: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky",
  LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  AS: "American Samoa", GU: "Guam", MP: "Northern Mariana Islands", PR: "Puerto Rico",
  VI: "United States Virgin Islands", AA: "Armed Forces Americas", AE: "Armed Forces Europe",
  AP: "Armed Forces Pacific",
};

const norm = (v: string): string =>
  v.toLowerCase().replace(/\s*\(\+\d+\)\s*$/, "").replace(/\s+/g, " ").trim();

const US_STATE_BY_NORM = new Map(US_STATES.map((s) => [norm(s), s]));

/** Resolve a stored value to its canonical US-state full name, or null if it isn't a US state.
 *  Accepts the full name (any case / spacing) or a 2-letter abbreviation ("PA" → "Pennsylvania"). */
export function resolveUsState(v: string | null | undefined): string | null {
  if (!v) return null;
  const full = US_STATE_BY_NORM.get(norm(v));
  if (full) return full;
  return US_STATE_BY_ABBR[v.trim().toUpperCase()] ?? null;
}

// The country field stores a TIERED candidate array (US = ["United States of America","United States","USA"]).
const US_COUNTRY_NAMES = new Set([
  "united states of america", "united states", "usa", "us", "u.s.", "u.s.a.", "u.s", "america",
]);

/** Is the (tiered) country value the United States? */
export function isUnitedStates(country: string[] | null | undefined): boolean {
  if (!Array.isArray(country)) return false;
  return country.some((c) => typeof c === "string" && US_COUNTRY_NAMES.has(norm(c)));
}
