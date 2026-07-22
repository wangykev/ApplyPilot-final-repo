/**
 * Server-side fetch + parse of the SimplifyJobs/Summer2026-Internships listing.
 * The repo README renders an HTML <table>; each <tr> is a posting. We extract the
 * company (resolving the "↳" same-as-above marker), role, location, the DIRECT
 * apply URL (the first <a href> in the Application cell — the Simplify redirect is
 * second), and the age ("1d", "2w", "1mo" → days).
 *
 * `parseReadme` is pure and unit-tested; `fetchRecentPostings` adds a module-level
 * TTL cache so a match run doesn't re-download the ~MB README on every request.
 */

export type SimplifyPosting = {
  company: string;
  role: string;
  location: string;
  url: string; // direct apply URL (not the simplify.jobs redirect)
  ageDays: number;
  ageLabel: string;
};

const README_URL =
  "https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/README.md";
const TTL_MS = 60 * 60 * 1000; // 1 hour

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&nbsp;/g, (m) => ENTITIES[m] ?? m);
}

function stripTags(cell: string): string {
  return decodeEntities(
    cell
      .replace(/<br\s*\/?>/gi, "; ")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function ageToDays(label: string): number {
  const m = /(\d+)\s*(h|d|w|mo|m|y)/i.exec(label);
  if (!m) return 9999;
  const n = Number(m[1]);
  switch (m[2].toLowerCase()) {
    case "h":
      return Math.max(0, Math.round(n / 24));
    case "d":
      return n;
    case "w":
      return n * 7;
    case "mo":
    case "m":
      return n * 30;
    case "y":
      return n * 365;
    default:
      return 9999;
  }
}

/** Parse the README HTML into postings, newest-first order preserved from source. */
export function parseReadme(md: string): SimplifyPosting[] {
  const out: SimplifyPosting[] = [];
  let lastCompany = "";

  const rows = md.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? [];
  for (const row of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cells.length < 5) continue; // header (<th>) or malformed row

    const [companyCell, roleCell, locCell, appCell, ageCell] = cells;

    let company = stripTags(companyCell);
    if (company === "↳" || company === "" || company === "|") {
      company = lastCompany;
    } else {
      lastCompany = company;
    }

    const role = stripTags(roleCell);
    const location = stripTags(locCell);

    // Direct apply URL = the first href that is NOT the simplify.jobs redirect.
    const hrefs = [...appCell.matchAll(/href="([^"]+)"/gi)].map((m) => m[1]);
    const direct = hrefs.find((h) => !/simplify\.jobs/i.test(h));
    if (!direct) continue; // closed role (🔒) or no application link — skip

    const ageLabel = stripTags(ageCell);
    if (!role || !company) continue;

    out.push({
      company,
      role,
      location,
      url: direct,
      ageDays: ageToDays(ageLabel),
      ageLabel,
    });
  }
  return out;
}

let cache: { at: number; postings: SimplifyPosting[] } | null = null;

/**
 * Fetch the freshest N postings (newest first). Cached for an hour. `now`/`fetchImpl`
 * are injectable for testing; production uses the global fetch and Date.now().
 */
export async function fetchRecentPostings(
  limit = 40,
  opts: { now?: () => number; fetchImpl?: typeof fetch } = {},
): Promise<SimplifyPosting[]> {
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetchImpl ?? fetch;

  if (cache && now() - cache.at < TTL_MS) {
    return cache.postings.slice(0, limit);
  }

  const res = await doFetch(README_URL, {
    headers: { "User-Agent": "ApplyPilot-match/1.0" },
  });
  if (!res.ok) {
    if (cache) return cache.postings.slice(0, limit); // serve stale on error
    throw new Error(`Simplify README fetch failed: HTTP ${res.status}`);
  }
  const md = await res.text();
  const postings = parseReadme(md).sort((a, b) => a.ageDays - b.ageDays);
  cache = { at: now(), postings };
  return postings.slice(0, limit);
}

/** Test-only: reset the module cache. */
export function __resetCache(): void {
  cache = null;
}
