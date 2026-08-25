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
  /** "list" (came with the row) | "api" (the board's own record) | "page" (opened it) | "" */
  descriptionSource: string;
  /**
   * `url` always holds the BEST known link. For a board find it is REWRITTEN to the
   * employer's real application URL when the posting exposes one, because the Run
   * pipeline drives Workday/Greenhouse/etc. and cannot drive a board url.
   * `boardUrl` remembers where the job was found; `applyKind` distinguishes
   * "board-only application, so no employer link EXISTS" from "we couldn't find it".
   */
  boardUrl?: string;
  applyKind?: string;
  applyResolved?: boolean;
  /**
   * EVERY source that found this posting, including `source` itself.
   *
   * Dedup runs at sweep time and keeps the first source's copy, so `source` alone
   * answers "who found it FIRST", not "who found it". The queue's per-source tabs need
   * the second question — otherwise a job LinkedIn genuinely surfaced disappears from
   * the LinkedIn tab just because Simplify happened to run earlier. This is what lets
   * the per-source tabs legitimately overlap while "All" stays the deduped union.
   */
  foundOn?: string[];
  /**
   * Ranking (2026-07-30, "scrape wide, queue narrow"). Both boards report how many
   * people have already applied, which is the strongest available signal; `score`
   * orders the queue and `scoreReasons` explains it, so the ranking is auditable
   * rather than a number to trust.
   */
  applicants?: number | null;
  earlyApplicant?: boolean;
  promoted?: boolean;
  employmentType?: string;
  score?: number;
  /** 0–100. Bounded on purpose: the operator queues by a "match >= N%" threshold. */
  matchPercent?: number;
  scoreReasons?: string[];
  /**
   * The ORIGINAL posting date and whether the board is showing a REPOST. Boards
   * re-float an old posting and display the bump as if it were new — measured on
   * LinkedIn, 2 of 3 sampled postings were reposts, one 63 days newer than its
   * original. Ranking uses the original so a bumped job can't re-top a daily sweep.
   */
  originalPostedAt?: number | null;
  reposted?: boolean;
  /**
   * Details worth seeing before opening anything. `pay` is Handshake-only —
   * LinkedIn's record carries no compensation (its `salaryInsights` is just a link),
   * so an empty string means "the board didn't say", never "unpaid".
   */
  pay?: string;
  startDate?: string;
  endDate?: string;
  /** The board's own apply-by deadline. */
  applyBy?: string;
  /** "Remote" | "Hybrid" | "On-site" as the board words it. */
  workplace?: string;
  /** e.g. "apply using the external link only" — an employer instruction worth keeping. */
  applyNote?: string;
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
  /** Descriptions read straight from a board's own record — no tab, no clicks. */
  jdInPage?: number;
  /** Everything that survived dedup, BEFORE the best-N cut — the "wide" of the sweep. */
  matched?: number;
  /** Postings rewritten to the employer's real application url. */
  employerLinks?: number;
  /** Board-only applications (Easy Apply / Quick apply) skipped — support is deferred. */
  boardOnlySkipped?: number;
  /** Postings that had already closed. */
  closedSkipped?: number;
};

/** The exact search the sweep ran — echoed back so it's never a mystery. */
export type DiscoverSearch = {
  keywords: string;
  derivedFrom: string;
  term: string;
  location: string;
  sinceDays: number;
  /** EVERY search that ran — a blank box derives several from the resume. */
  queries?: string[];
  minMatchPercent?: number;
};

export type DiscoverSourceKey = "simplify" | "zero2sudo" | "linkedin" | "handshake";

/** Sweep order — the same order the extension runs them in, which is what makes
 *  cross-source dedup deterministic (the first source to find a job keeps the row). */
export const DISCOVER_SOURCES: DiscoverSourceKey[] = ["simplify", "zero2sudo", "linkedin", "handshake"];

export const DISCOVER_SOURCE_LABEL: Record<DiscoverSourceKey, string> = {
  simplify: "Simplify 2026 internships",
  zero2sudo: "@zero2sudo stories",
  linkedin: "LinkedIn",
  handshake: "Handshake",
};

export const DISCOVER_SOURCE_HINT: Record<DiscoverSourceKey, string> = {
  simplify: "The public GitHub board — no sign-in needed.",
  // Two things the operator needs to know before ticking this, both measured live:
  // stories expire after 24h (so this is a daily-sweep source, and a gap is a real
  // gap), and reading them marks them seen — you appear in his viewer list.
  zero2sudo:
    "Read from your signed-in Instagram session. Only the last 24h of stories exist, so sweep daily. Reading them marks them seen — you'll show in his viewer list.",
  linkedin: "Read from your signed-in LinkedIn session in this browser.",
  handshake: "Read from your signed-in Handshake session in this browser.",
};

/**
 * Defaults mirrored from the extension's DISCOVER_DEFAULTS — keep in step.
 * `web/test/discover.test.ts` cross-loads the real discover.js and asserts every
 * key here matches, so a drift is a test failure rather than a production surprise.
 */
export const DISCOVER_DEFAULTS = {
  /**
   * The recency WINDOW — no longer an operator knob (the "Posted within N days"
   * control was removed 2026-07-30). matchPercent scores freshness directly, so a
   * wide window costs nothing: a stale posting simply scores low and falls under the
   * threshold, while a wider net finds more of what IS fresh.
   */
  sinceDays: 30,
  maxPerSource: 25,
  maxTotal: 60,
  /**
   * A board's own JSON record per posting — one cheap same-origin fetch, so this
   * covers a whole page of candidates. Distinct from maxJdOpens (real tab loads):
   * sharing one budget meant records were read for the NEWEST N while the queue kept
   * the BEST N, so a queued job could end up with no JD and no employer link.
   */
  maxRecords: 25,
  /** Real page loads in the reused reader tab, for anything with no board record. */
  maxJdOpens: 10,
  /**
   * zero2sudo's OWN description budget, spent inside its driver. Separate from
   * maxJdOpens on purpose: a story link is a bare url with no company, title or JD,
   * and the global ranking runs BEFORE the reader pass — so an unenriched story job
   * would score ~0 on relevance and be dropped below the match threshold before
   * anything ever opened it. The source would look empty rather than filtered.
   */
  maxStoryReads: 16,
  /** How many result PAGES to sweep per board (scrape wide…). */
  maxPages: 3,
  /**
   * …queue narrow, by a MATCH THRESHOLD rather than a count: everything scoring at or
   * above this is queued, however many that is. 0 ⇒ queue everything found.
   * matchPercent's components sum to 100 precisely so this is comparable.
   */
  minMatchPercent: 60,
  /** How many DIFFERENT searches to derive from the resume when the box is blank. */
  maxQueries: 3,
  /** Drop postings that can only be applied to ON the board (no employer link exists). */
  skipEasyApply: true,
  query: "",
};

/**
 * LAST-RESORT location only. The panel seeds its location box from the profile's
 * own country, so this is what's used when there is no profile country either —
 * and when it IS used, the sweep says so in a note rather than searching a
 * country the operator never chose.
 */
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
/**
 * Filler words + the role word itself, which carry no discriminating power when
 * matching a keyword phrase. LOCKSTEP with the extension's DISCOVER_STOPWORDS.
 */
const DISCOVER_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "in", "at", "to", "with",
  "intern", "interns", "internship", "internships", "co-op", "coop",
]);

/**
 * The meaningful tokens of a keyword phrase. LOCKSTEP with the extension's
 * discoverKeywordTokens (test-enforced) — it is what dedupes derived searches, so a
 * drift would let two identical searches each burn a query slot.
 */
export function discoverKeywordTokens(keywords: string): string[] {
  return String(keywords || "")
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter((t) => t.length >= 3 && !DISCOVER_STOPWORDS.has(t));
}

/**
 * SEVERAL searches from the RESUME, not one from the major.
 *
 * A single query derived from `field_of_study` only ever finds one shape of job.
 * A blank box therefore derives several — past job titles (level words stripped),
 * the field of study, then skills PAIRED — and each is run against both boards.
 * An explicit query short-circuits all of it.
 *
 * LOCKSTEP with the extension's buildDiscoverQueries (test-enforced).
 */
export function buildDiscoverQueries(opts: {
  query?: string;
  field?: string;
  intern?: boolean;
  jobTitles?: string[];
  skills?: string[];
  maxQueries?: number;
}): { queries: Array<{ keywords: string; from: string }>; derivedFrom: string } {
  const wantIntern = opts?.intern !== false;
  const cap = Math.max(1, Number(opts?.maxQueries) || DISCOVER_DEFAULTS.maxQueries);

  const withIntern = (base: string) => {
    const parts: string[] = [];
    if (base) parts.push(base);
    if (wantIntern && !/\bintern(ship)?s?\b/i.test(base)) parts.push("intern");
    return parts.join(" ").replace(/\s+/g, " ").trim();
  };

  const explicit = String(opts?.query || "").trim();
  if (explicit) return { queries: [{ keywords: withIntern(explicit), from: "your keywords" }], derivedFrom: "your keywords" };

  // Strips LEVEL words and generic-noise nouns: a real resume title like "Firmware
  // Team Member" would otherwise search for "team member" as if that were a kind of
  // job (observed on the operator's own profile).
  const roleCore = (t: string) =>
    String(t || "")
      .replace(/\b(intern|internship|co-?op|trainee|apprentice|fellow|fellowship)\b/gi, " ")
      .replace(/\b(senior|sr\.?|junior|jr\.?|lead|staff|principal|associate|assistant|entry[- ]level)\b/gi, " ")
      .replace(/\b(team member|member|worker|volunteer|employee|student|part[- ]time|full[- ]time|summer|fall|winter|spring|\d{4})\b/gi, " ")
      .replace(/[^A-Za-z0-9+#. ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  // A title must say something about the WORK to earn a query slot — "Research" or
  // "Lab" alone matches half a board.
  const usefulRole = (core: string) => {
    const toks = discoverKeywordTokens(core);
    return toks.length >= 2 || (toks.length === 1 && toks[0].length >= 7);
  };

  const out: Array<{ keywords: string; from: string }> = [];
  const seen = new Set<string>();
  const push = (base: string, from: string) => {
    const keywords = withIntern(base);
    if (!keywords) return;
    const key = discoverKeywordTokens(keywords).slice().sort().join(" ");
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ keywords, from });
  };

  // RESERVE a slot for the field of study: titles are the better signal but also
  // narrow, and on a real resume they filled every slot and pushed the major out
  // entirely (observed live). One reserved slot keeps the broad case covered.
  const field = String(opts?.field || "").trim();
  const titleCap = field ? Math.max(1, cap - 1) : cap;
  for (const t of Array.isArray(opts?.jobTitles) ? opts!.jobTitles! : []) {
    if (out.length >= titleCap) break;
    const core = roleCore(t);
    if (core && usefulRole(core)) push(core, "a role on your resume");
  }
  if (out.length < cap && field) push(field, "your field of study");
  const skills = (Array.isArray(opts?.skills) ? opts!.skills! : []).map((x) => String(x || "").trim()).filter(Boolean);
  for (let i = 0; i < skills.length && out.length < cap; i += 2) {
    push(skills.slice(i, i + 2).join(" "), "skills on your resume");
  }
  // NOT via push(): "intern" is a stopword, so its token key is empty and push()
  // would reject it — which silently produced zero queries for an empty profile.
  if (!out.length && wantIntern) out.push({ keywords: "intern", from: "the internship default" });

  return {
    queries: out.slice(0, cap),
    derivedFrom: out.length ? out.map((q) => q.from).filter((v, i, a) => a.indexOf(v) === i).join(" + ") : "",
  };
}

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
/**
 * The optional extras a discovered row carries into the queue (migration 0012).
 * Everything is optional and absent means "the board didn't say" — never a zero and
 * never, for pay, "unpaid". Only Handshake publishes compensation; LinkedIn's record
 * has none, so its rows simply omit `pay`.
 */
export type QueueItemDetails = {
  pay?: string;
  start_date?: string;
  end_date?: string;
  apply_by?: string;
  workplace?: string;
  employment_type?: string;
  applicants?: number;
  match_percent?: number;
  match_reasons?: string[];
  reposted?: boolean;
  original_posted_at?: string;
  apply_note?: string;
  /**
   * TODO(dup): lockstep with web/app/app/queue/shared.ts QueueItemDetails.
   * Every source that found this posting. Present ONLY when more than one did, so an
   * ordinary row is unchanged. The queue's per-source tabs read it — see DiscoveredJob.foundOn.
   */
  found_on?: string[];
};

/** Drop empty/blank keys so a row never stores `{pay: ""}` and render code can just truthy-check. */
function compactDetails(d: QueueItemDetails): QueueItemDetails | null {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    if (v == null || v === "" || v === false) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? (out as QueueItemDetails) : null;
}

export function toQueueRow(job: Partial<DiscoveredJob> | null | undefined): {
  url: string;
  job_key: string;
  company: string | null;
  role: string | null;
  source: string | null;
  location: string | null;
  posted_at: string | null;
  job_description: string | null;
  /** Optional per-posting extras — see migration 0012. Null when nothing is known. */
  details: QueueItemDetails | null;
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
    // Pay / term / deadline / workplace / why-it-matched. Discovery already reads all
    // of this from each board's own record; before migration 0012 it was discarded
    // here, so a queue row could only show company · role · location · age.
    details: compactDetails({
      pay: str(job?.pay, 80) ?? undefined,
      start_date: str(job?.startDate, 40) ?? undefined,
      end_date: str(job?.endDate, 40) ?? undefined,
      apply_by: str(job?.applyBy, 40) ?? undefined,
      workplace: str(job?.workplace, 24) ?? undefined,
      employment_type: str(job?.employmentType, 60) ?? undefined,
      applicants: typeof job?.applicants === "number" && isFinite(job.applicants) ? job.applicants : undefined,
      match_percent: typeof job?.matchPercent === "number" ? job.matchPercent : undefined,
      match_reasons: Array.isArray(job?.scoreReasons) ? job.scoreReasons.slice(0, 6) : undefined,
      reposted: job?.reposted === true ? true : undefined,
      // The date the posting ACTUALLY went up, when the board was showing a repost.
      original_posted_at:
        job?.reposted && typeof job?.originalPostedAt === "number" && isFinite(job.originalPostedAt)
          ? new Date(job.originalPostedAt).toISOString()
          : undefined,
      apply_note: str(job?.applyNote, 300) ?? undefined,
      // EVERY source that found this posting (see DiscoveredJob.foundOn). Lives in
      // `details` rather than its own column deliberately — the queue page already
      // loads every row and filters client-side, so this needs no new query and no
      // migration, which is exactly the case migration 0012's jsonb was added for.
      // Omitted when it says nothing beyond `source` (the overwhelmingly common case),
      // so an ordinary single-source row is byte-identical to before.
      found_on:
        Array.isArray(job?.foundOn) && job.foundOn.length > 1
          ? job.foundOn.map((s) => String(s).slice(0, 40)).slice(0, 8)
          : undefined,
    }),
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
