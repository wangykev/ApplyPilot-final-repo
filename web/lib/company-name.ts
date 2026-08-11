/**
 * Display name for a tracker row's company.
 *
 * The extension derives `company` from the posting when it can, but it FALLS BACK to the posting host
 * when the JD scrape finds no company element — and a submit run, which never re-scrapes the JD, can
 * therefore store a bare hostname ("analogdevices.wd1.myworkdayjobs.com"). That is the right value to
 * KEEP (it identifies the tenant unambiguously) and the wrong value to SHOW.
 *
 * So this is a DISPLAY-time transform, deliberately: it fixes rows already in the table, needs no
 * migration, and cannot corrupt the stored identity if the parse is ever wrong.
 *
 * Two steps: reduce a host to its tenant slug, then map that slug to a human name. The second step
 * needs a table — "analogdevices" cannot be split into "Analog Devices" algorithmically, and guessing
 * a split ("Analog Devices" vs "Anal Ogdevices") is exactly the kind of plausible-but-wrong output
 * this codebase avoids elsewhere. Unknown slugs get a plain title-case, which is always readable.
 */

// Tenant slug (lowercased, punctuation-free) → the company's own spelling. Add a line when a tenant
// shows up misspelled on the tracker; there is no need to be exhaustive.
const COMPANY_ALIASES: Record<string, string> = {
  analogdevices: "Analog Devices",
  clearwateranalytics: "Clearwater Analytics",
  homedepot: "Home Depot",
  kiongroup: "KION Group",
  radiancetech: "Radiance Technologies",
  solarturbines: "Solar Turbines",
  shieldai: "Shield AI",
  slingshotai: "Slingshot AI",
  elevenlabs: "ElevenLabs",
  openevidence: "OpenEvidence",
  gitlab: "GitLab",
  gopuff: "Gopuff",
  psecu: "PSECU",
  asuep: "ASU",
  hp: "HP",
  ibm: "IBM",
  nvidia: "NVIDIA",
  cat: "Caterpillar",
  clearesult: "CLEAResult",
  aptiv: "Aptiv",
  copart: "Copart",
};

/** `<tenant>.wdN.myworkdayjobs.com` / `.myworkdaysite.com` → `tenant`; any other host → its first label. */
function tenantFromHost(raw: string): string | null {
  const host = raw.trim().replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
  if (!host.includes(".")) return null; // not a host at all — leave it alone
  const wd = host.match(/^([a-z0-9-]+)\.wd\d+\.myworkday(?:jobs|site)\.com$/);
  if (wd) return wd[1];
  const labels = host.replace(/^www\./, "").split(".");
  // A generic host: the first label is the company for careers.acme.com / acme.com alike, EXCEPT
  // when that label is a job-board name, where the company isn't in the host at all.
  const first = labels[0];
  if (["job-boards", "jobs", "boards", "apply", "careers", "myworkdayjobs", "myworkdaysite"].includes(first)) {
    return labels[1] && !["com", "net", "org", "io"].includes(labels[1]) ? labels[1] : null;
  }
  return first || null;
}

function titleCase(slug: string): string {
  return slug
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * The name to SHOW for a stored company value. Falls back to the URL's tenant when company is empty,
 * so a row that never got a company still reads as something.
 */
export function prettyCompany(company: string | null | undefined, url?: string | null): string {
  const raw = (company || "").trim();
  const source = raw || (url || "").trim();
  if (!source) return "";

  const slug = tenantFromHost(source);
  if (!slug) {
    // Already a human name ("Solar Turbines"). Only normalize a bare one-word slug we know about.
    const key = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
    return COMPANY_ALIASES[key] || raw;
  }
  return COMPANY_ALIASES[slug.replace(/[^a-z0-9]/g, "")] || titleCase(slug);
}
