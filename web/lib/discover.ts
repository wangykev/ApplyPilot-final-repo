/**
 * Job discovery — the shared contract between the Discover button, the extension's
 * sweep, and the queue table.
 *
 * The extension (discover.js) does the actual sweeping: it reads the operator's
 * signed-in LinkedIn + Handshake job searches out of real tabs and fetches the
 * SimplifyJobs 2026 internship board's published listings.json, opens each new
 * posting just long enough to scrape its description, closes it, and RETURNS the
 * jobs. Nothing is stored extension-side — this module's job is to define the
 * shape that comes back, re-derive the dedup key server-side (never trust a
 * client-supplied key), and shape rows for `queue_items`.
 */

import { canonicalJobUrl } from "@/lib/job-key";

/** One discovered posting, as the extension's runJobDiscovery returns it. */
export type DiscoveredJob = {
  source: string;
  url: string;
  jobKey: string;
  title: string;
  company: string;
  location: string;
  category: string;
  /** epoch ms, or null when the source gave no parseable date */
  postedAt: number | null;
  postedText: string;
  postedUnknown: boolean;
  description: string;
  /** "list" (came with the row) | "pane" (read in-page) | "page" (opened it) | "" */
  descriptionSource: string;
  /**
   * `url` always holds the BEST known link. For a board find it is REWRITTEN to the
   * employer's real application URL when the posting exposes one, because the Run
   * pipeline drives Workday/Greenhouse/etc. and cannot drive a board url.
   * `boardUrl` remembers where the job was found; `applyKind` distinguishes
   * "LinkedIn Easy Apply, so no employer link EXISTS" from "we couldn't find it".
   */
  boardUrl?: string;
  applyKind?: string;
  applyResolved?: boolean;
};

/** Is this a job-BOARD link rather than an employer/ATS one? Lockstep with discover.js. */
export function isBoardUrl(u: string): boolean {
  try {
    const h = new URL(String(u)).hostname.toLowerCase();
    return /(^|\.)linkedin\.com$/.test(h) || /joinhandshake\.com$/.test(h);
  } catch {
    return false;
  }
}

/** Per-sweep tallies the extension reports, surfaced in the result panel. */
export type DiscoverStats = {
  scanned: Record<string, number>;
  found: number;
  skippedKnown: number;
  skippedDupe: number;
  droppedByCap: number;
  newJobs: number;
  bySource: Record<string, number>;
  jdOpened: number;
  jdFailed: number;
  jdSkipped: number;
  /** Descriptions read WITHOUT opening a tab (LinkedIn's details pane). */
  jdInPage?: number;
};

/** The exact search the sweep ran — echoed back so it's never a mystery. */
export type DiscoverSearch = {
  keywords: string;
  derivedFrom: string;
  term: string;
  location: string;
  sinceDays: number;
};

export type DiscoverSourceKey = "simplify" | "linkedin" | "handshake";

export const DISCOVER_SOURCE_LABEL: Record<DiscoverSourceKey, string> = {
  simplify: "Simplify 2026 internships",
  linkedin: "LinkedIn",
  handshake: "Handshake",
};

export const DISCOVER_SOURCE_HINT: Record<DiscoverSourceKey, string> = {
  simplify: "The public GitHub board — no sign-in needed.",
  linkedin: "Read from your signed-in LinkedIn session in this browser.",
  handshake: "Read from your signed-in Handshake session in this browser.",
};

/** Defaults mirrored from the extension's DISCOVER_DEFAULTS — keep in step. */
export const DISCOVER_DEFAULTS = {
  sinceDays: 7,
  maxPerSource: 25,
  maxTotal: 60,
  maxJdOpens: 10,
  query: "",
};

/** No location given ⇒ search the whole country, not the profile's home city. */
export const DISCOVER_DEFAULT_LOCATION = "United States";

export const DISCOVER_CYCLES = ["summer", "fall", "winter", "spring"] as const;
export type DiscoverCycle = (typeof DISCOVER_CYCLES)[number];

/**
 * "summer" + "2026" → "Summer 2026" — the season wording the Simplify feed's own
 * `terms` field uses, which is why it filters that source EXACTLY.
 * LOCKSTEP with the extension's discoverTermLabel.
 */
export function discoverTermLabel(cycle: string, year: string): string {
  const c = String(cycle || "").trim().toLowerCase();
  const y = String(year || "").trim();
  const cap = (DISCOVER_CYCLES as readonly string[]).includes(c) ? c[0].toUpperCase() + c.slice(1) : "";
  if (cap && y) return cap + " " + y;
  return cap || y || "";
}

/**
 * Compose the keyword string the board search will actually run.
 *
 * An empty keyword box is NOT "search everything": LinkedIn's `/jobs/search` with
 * no `keywords` renders the signed-in RECOMMENDED feed, so a blank query used to
 * quietly return whatever LinkedIn suggested rather than the jobs being hunted.
 * Blank now means "derive something specific" — from the profile's field of study.
 *
 * LOCKSTEP with the extension's buildDiscoverQuery (test-enforced).
 */
export function buildDiscoverQuery(opts: {
  query?: string;
  field?: string;
  intern?: boolean;
}): { keywords: string; derivedFrom: string } {
  const explicit = String(opts?.query || "").trim();
  const field = String(opts?.field || "").trim();
  const wantIntern = opts?.intern !== false;

  let base = "";
  let derivedFrom = "";
  if (explicit) {
    base = explicit;
    derivedFrom = "your keywords";
  } else if (field) {
    base = field;
    derivedFrom = "your field of study";
  } else if (wantIntern) {
    base = "";
    derivedFrom = "the internship default";
  }

  const parts: string[] = [];
  if (base) parts.push(base);
  if (wantIntern && !/\bintern(ship)?s?\b/i.test(base)) parts.push("intern");

  return { keywords: parts.join(" ").replace(/\s+/g, " ").trim(), derivedFrom };
}

/**
 * Stable per-JOB identity for discovery dedup — LOCKSTEP with `discoveryJobKey` in
 * the extension's discover.js. Change both.
 *
 * Ordering is load-bearing: a Workday posting keys through canonicalJobUrl FIRST so
 * a job discovered on the Simplify board (whose url IS the employer's Workday link)
 * produces the SAME key the tracker stores once the operator applies — that is what
 * makes "jobs I have not yet applied to" hold across `applications` and
 * `queue_items`. Board ids only key postings whose canonical identity IS the board.
 */
export function discoveryJobKey(u: string): string {
  const raw = String(u ?? "").trim();
  if (!raw) return "";
  let p: URL;
  try {
    p = new URL(raw);
  } catch {
    return raw.split(/[?#]/)[0].toLowerCase();
  }
  const host = (p.hostname || "").toLowerCase();
  const path = p.pathname || "";

  if (/_R\d+\b/i.test(path) || /myworkday(?:jobs|site)\.com$/i.test(host)) {
    return canonicalJobUrl(raw);
  }
  if (/(^|\.)linkedin\.com$/i.test(host)) {
    const viewed = path.match(/\/jobs\/view\/(\d+)/i);
    const current = (p.searchParams.get("currentJobId") || "").match(/^\d+$/);
    const id = viewed ? viewed[1] : current ? current[0] : "";
    if (id) return "linkedin:" + id;
  }
  if (/joinhandshake\.com$/i.test(host)) {
    const m = path.match(/\/(?:jobs|job-search|postings)\/(\d+)/i);
    if (m) return "handshake:" + m[1];
  }
  const gh = path.match(/\/([^/]+)\/jobs\/(\d+)/i);
  if (/greenhouse\.io$/i.test(host) && gh) return "greenhouse:" + gh[1].toLowerCase() + ":" + gh[2];
  const lever = path.match(/^\/([^/]+)\/([0-9a-f-]{16,})/i);
  if (/lever\.co$/i.test(host) && lever) return "lever:" + lever[1].toLowerCase() + ":" + lever[2].toLowerCase();
  const ashby = path.match(/^\/([^/]+)\/([0-9a-f-]{16,})/i);
  if (/ashbyhq\.com$/i.test(host) && ashby) return "ashby:" + ashby[1].toLowerCase() + ":" + ashby[2].toLowerCase();

  return canonicalJobUrl(raw);
}

/**
 * Coerce whatever the extension sent into a safe, bounded queue row payload.
 *
 * The extension is trusted code, but this data crossed a message boundary and is
 * about to be written to the operator's database, so every field is re-derived or
 * clamped here: the key is RECOMPUTED from the url (never taken from the client),
 * text is trimmed to column-sane lengths, and a row without a usable http(s) url is
 * dropped outright. Returns null for anything unusable.
 */
export function toQueueRow(job: Partial<DiscoveredJob> | null | undefined): {
  url: string;
  job_key: string;
  company: string | null;
  role: string | null;
  source: string | null;
  location: string | null;
  posted_at: string | null;
  job_description: string | null;
} | null {
  const url = String(job?.url ?? "").trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return null;
  const key = discoveryJobKey(url);
  if (!key) return null;

  const str = (v: unknown, max: number) => {
    const s = String(v ?? "").trim();
    return s ? s.slice(0, max) : null;
  };

  // postedAt is epoch ms from the extension. Guard against a nonsense clock —
  // anything before 2000 or more than a day in the future is treated as unknown
  // rather than written as a bogus timestamp.
  let postedAt: string | null = null;
  const ms = typeof job?.postedAt === "number" ? job.postedAt : NaN;
  if (isFinite(ms) && ms > 946684800000 && ms < Date.now() + 86400000) {
    postedAt = new Date(ms).toISOString();
  }

  return {
    url,
    job_key: key,
    company: str(job?.company, 200),
    role: str(job?.title, 200),
    source: str(job?.source, 40),
    location: str(job?.location, 200),
    posted_at: postedAt,
    job_description: str(job?.description, 20000),
  };
}

/** Human summary of a sweep for the result panel — says WHY, not just how many. */
export function describeSweep(stats: DiscoverStats | null | undefined): string {
  if (!stats) return "";
  const bits: string[] = [];
  const scanned = Object.values(stats.scanned || {}).reduce((a, b) => a + (b || 0), 0);
  if (scanned) bits.push(`scanned ${scanned}`);
  if (stats.skippedKnown) bits.push(`${stats.skippedKnown} already applied or queued`);
  if (stats.skippedDupe) bits.push(`${stats.skippedDupe} listed on more than one board`);
  const inPage = stats.jdInPage || 0;
  if (inPage) bits.push(`${inPage} description${inPage === 1 ? "" : "s"} read without opening a tab`);
  if (stats.jdOpened) bits.push(`${stats.jdOpened - stats.jdFailed} of ${stats.jdOpened} read in the reader tab`);
  return bits.join(" · ");
}
