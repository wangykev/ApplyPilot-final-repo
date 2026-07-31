// ============================================================================
// discover.js — JOB DISCOVERY (find new postings → the website queue).
//
// WHAT: the stage BEFORE the queue. Sweeps three sources for recently-posted
// jobs the operator has NOT already applied to / queued, scrapes a job
// description for each, and RETURNS them. The website (the Discover button on
// /app/run) persists the result into `queue_items`. This module NEVER applies,
// never submits, and never writes to the backend itself — "engine computes /
// service worker does I/O" extended one level: discover computes, the WEBSITE
// stores.
//
// THE THREE SOURCES (deliberately different substrates — cheapest that works):
//   1. simplify  — the SimplifyJobs/Summer2026-Internships GitHub board. It
//      publishes STRUCTURED JSON (.github/scripts/listings.json: company_name,
//      title, url, locations, date_posted (unix s), active, is_visible, terms),
//      so we plain `fetch` it — no tab, no scraping, and a REAL posted date to
//      filter on. Scraping the rendered README would be strictly worse.
//   2. linkedin  — the operator's LOGGED-IN job search. SEARCH + each posting's
//      RECORD are read as the JSON the search page itself runs on; the rendered
//      page is the FALLBACK.
//   3. handshake — the mirror image: its JSON posting index ignores every filter
//      param, so the SEARCH is the rendered page (whose params were traced) while
//      each posting's RECORD is JSON.
//
// COOKIES, NOT KEYS (operator decision 2026-07-26, unchanged): both boards are
// read through the operator's own signed-in browser session, from inside a tab on
// that board, so every request is same-origin and carries their own cookies.
// There is no API key and no credential handling here — if the session isn't
// signed in we say so and skip the source; we never attempt a login.
//
// ── WHY JSON AND NOT THE DOM (traced 2026-07-30; supersedes the old
//    "structure-first" note that lived here) ─────────────────────────────────
// The previous LinkedIn scrapers were written blind (an authenticated session
// wasn't available at build time) and, when finally traced against the live page,
// matched NOTHING — all ~30 selectors returned 0. LinkedIn had shipped a
// server-driven-UI rewrite: result cards are no longer anchors at all, and every
// class is a per-deploy hash. Worse, the SEARCH PAGE silently DISCARDS `location`,
// `sortBy` and `f_E` from its own URL, so the sweep had been running an unsorted,
// unlocated search the whole time.
//
// Reading the JSON each board's front-end already requests fixes the class of
// problem rather than one instance of it, and it is what the branch needs anyway:
//   · the EMPLOYER's real application url arrives as a TYPED field (LinkedIn's
//     applyMethod…OffsiteApply.companyApplyUrl / Handshake's external_apply_link)
//     instead of being guessed at from off-host anchors near an apply button;
//   · board-only applications (Easy Apply / Quick apply) are identified by that
//     field's SHAPE, not by matching the words "easy apply" in rendered copy;
//   · posted dates are exact epochs, not "3 days ago" parsed backwards;
//   · applicant counts come through, which is the ranking signal that makes
//     "queue only the best" meaningful;
//   · nothing is clicked, so no Apply button can ever be touched.
// The rendered-DOM scrapers remain as a per-board FALLBACK, rebuilt on the two
// stable anchors the trace did find — `componentkey="job-card-component-ref-<id>"`
// (LinkedIn) and `data-hook="job-result-card | <id>"` (Handshake) — and a fallback
// is always REPORTED, never silent. Run `dumpDiscoverRecon` (AP_DISCOVER_RECON /
// the popup "Discover recon") after any board redesign: it reports both anchors'
// hit counts, what the real scraper parsed, and the page's readyState/visibility.
//
// NO OVERLAPS ACROSS BOARDS: because both boards resolve a posting to the
// EMPLOYER's url before dedup, the same job found on LinkedIn and on Handshake
// collapses to one discoveryJobKey (its ATS key) — which is also the key the
// tracker writes after applying, so "jobs I haven't applied to" holds across
// sources and across tables.
//
// BOUNDED BY CONSTRUCTION: each source is capped (maxPerSource) and reads a
// bounded number of result pages (maxPages); the whole sweep is capped (maxTotal);
// per-posting record reads are capped (maxJdOpens) and PACED from the service
// worker; and only the best `queueLimit` are returned. Every cap reports what it
// dropped — a silent narrowing is indistinguishable from an empty sweep.
//
// HIDDEN-TAB SAFE: all pacing and every wait is service-worker wall clock, and the
// injected functions contain NO setTimeout — Chrome throttles page timers to ~1Hz
// in a background tab but does not throttle fetch, so a sweep behaves the same
// unfocused as focused (the standing rule from CLAUDE.md's CDP section).
// ============================================================================

// ── Config ──────────────────────────────────────────────────────────────────

// The Simplify board's structured feed (verified 2026-07-26). `dev` is the
// branch the bot writes to; the array element shape is pinned in the header note
// above and exercised by test/discover.test.js.
const DISCOVER_SIMPLIFY_URL =
  "https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/.github/scripts/listings.json";

const DISCOVER_DEFAULTS = {
  // The recency WINDOW. No longer an operator knob (2026-07-30: the "Posted within N
  // days" control was removed) — matchPercent scores freshness directly, so a wide
  // window costs nothing: an old posting simply scores low and falls under the
  // threshold, while a wider net finds more of what IS fresh.
  sinceDays: 30,
  maxPerSource: 25,   // cap per board BEFORE merge/dedup
  maxTotal: 60,       // cap the merged, deduped list
  // TWO budgets, because the two things cost wildly different amounts:
  //   maxRecords — a board's own JSON record per posting (JD + employer apply link +
  //     exact date + applicant count). One cheap same-origin fetch, batched 5 at a
  //     time, so covering a whole page of candidates costs seconds. This used to share
  //     maxJdOpens' budget of 10, which was calibrated back when a JD meant OPENING A
  //     TAB — and that mismatch had a real consequence: records were read for the
  //     NEWEST 10 while the queue kept the BEST N, so a queued job could have no JD and
  //     no employer link (observed live). Enriching every candidate also makes the
  //     ranking honest, since score depends on the JD and the applicant count.
  //   maxJdOpens — real page loads in the reused reader tab, for anything with no board
  //     record (Simplify's ATS links, or a record read that failed). Still tight.
  maxRecords: 25,
  maxJdOpens: 10,
  maxPages: 3,        // how many result PAGES to sweep per board (scrape wide…)
  // …queue narrow, by a MATCH THRESHOLD rather than a count (operator 2026-07-30):
  // everything scoring at or above this is queued, however many that is. 0 ⇒ queue
  // everything found. matchPercent's components sum to 100 so this is comparable.
  minMatchPercent: 60,
  // How many DIFFERENT searches to run per board when the keyword box is blank and
  // the queries are derived from the resume — see buildDiscoverQueries.
  maxQueries: 3,
  query: "",          // explicit keywords; blank ⇒ derived (see buildDiscoverQuery)
  field: "",          // the operator's field of study — the derived-keyword source
  intern: true,       // hunting internships: keyword + the board's internship filter
  cycle: "",          // "summer" | "fall" | "winter" | "spring" — the season targeted
  year: "",           // e.g. "2026"
  location: "",       // free text ("Austin, Texas" / "United States"); resolved per board
  skipEasyApply: true, // drop postings that can only be applied to ON the board
};

// No location given ⇒ search the whole country rather than wherever the board
// decides to centre on (which, signed in, is the operator's profile city — a
// silent, invisible narrowing).
const DISCOVER_DEFAULT_LOCATION = "United States";

const DISCOVER_CYCLES = ["summer", "fall", "winter", "spring"];

// "summer" + "2026" → "Summer 2026". This is the SEASON label, used as the
// Simplify feed's `terms` filter (its rows literally carry "Summer 2026"), which
// is why it's exact there and only advisory on the keyword-matched boards.
function discoverTermLabel(cycle, year) {
  const c = String(cycle || "").trim().toLowerCase();
  const y = String(year || "").trim();
  const cap = DISCOVER_CYCLES.includes(c) ? c[0].toUpperCase() + c.slice(1) : "";
  if (cap && y) return cap + " " + y;
  return cap || y || "";
}

/**
 * Compose the keyword string a board search actually runs.
 *
 * WHY THIS EXISTS: an empty keyword box is NOT "search everything" on LinkedIn —
 * `/jobs/search` with no `keywords` renders the signed-in RECOMMENDED feed, so a
 * blank query silently returned whatever LinkedIn felt like suggesting instead of
 * the jobs being hunted (observed 2026-07-29). Blank now means "derive something
 * specific", and a search that would still end up keyword-less is REFUSED rather
 * than run (see discoverLinkedInSearchUrl).
 *
 * Pure + unit-tested. Returns { keywords, derivedFrom } — `derivedFrom` is shown
 * in the UI so the operator can always see WHY a given search ran.
 */
function buildDiscoverQuery(opts) {
  const o = opts || {};
  const explicit = String(o.query || "").trim();
  const field = String(o.field || "").trim();
  const wantIntern = o.intern !== false;

  let base = "";
  let derivedFrom = "";
  if (explicit) {
    base = explicit;
    derivedFrom = "your keywords";
  } else if (field) {
    // e.g. "Electrical and Computer Engineering" → "electrical and computer
    // engineering intern", the search the operator asked for by example.
    base = field;
    derivedFrom = "your field of study";
  } else if (wantIntern) {
    base = "";
    derivedFrom = "the internship default";
  }

  const parts = [];
  if (base) parts.push(base);
  // Don't double up if the operator already typed intern/internship themselves.
  if (wantIntern && !/\bintern(ship)?s?\b/i.test(base)) parts.push("intern");

  return { keywords: parts.join(" ").replace(/\s+/g, " ").trim(), derivedFrom };
}

// ── Board vocabularies (TRACED on the operator's live session, 2026-07-30) ───
//
// Only codes whose EFFECT was observed are listed. Guessing a filter code is
// worse than omitting it: an unknown code is silently IGNORED by both boards
// (verified — a bogus param leaves the result total unchanged), so a wrong guess
// reads as "the filter is on" while nothing is filtered.
//
// LinkedIn `experience:List(1)` = Internship — observed 127 → 25 results, every
// row a genuine internship/co-op. Handshake `jobType=3` = Internship — observed
// 62,820 → 4,989.
const LINKEDIN_EXPERIENCE_INTERNSHIP = "1";
const HANDSHAKE_JOB_TYPE_INTERNSHIP = "3";
// Handshake's own sort vocabulary, read off its <select> (the ONLY valid values —
// an invented one, e.g. "created_at_desc", renders its "Something went wrong"
// page rather than being ignored, which is how this was found).
const HANDSHAKE_SORT_NEWEST = "posted_date_desc";

/**
 * SEVERAL searches from the RESUME, not one from the major.
 *
 * Operator 2026-07-30: "when nothing specific is in the what-to-search-for, you
 * should try and search for different things that I would be interested in based on
 * my resume instead of just the major."
 *
 * One query derived from `field_of_study` only ever finds one shape of job —
 * "electrical and computer engineering intern" misses the embedded-firmware and
 * robotics-software roles the same person is obviously a fit for. So a blank box
 * derives SEVERAL queries from the structured resume and runs each against BOTH
 * boards, merging the results (dedup + the match threshold sort it out):
 *
 *   · each past JOB TITLE, level words stripped  — what they have actually done
 *   · the field of study                         — the broad one
 *   · their top SKILLS, paired                   — what they can do
 *
 * Titles lead because a title you have held is the strongest evidence of what you
 * want next. An EXPLICIT query short-circuits all of it — one search, exactly what
 * was typed. Pure + unit-tested; LOCKSTEP with web/lib/discover.ts.
 */
function buildDiscoverQueries(opts) {
  const o = opts || {};
  const wantIntern = o.intern !== false;
  const cap = Math.max(1, Number(o.maxQueries) || DISCOVER_DEFAULTS.maxQueries);

  // Add "intern" unless the phrase already says it (buildDiscoverQuery's rule).
  const withIntern = (base) => {
    const parts = [];
    if (base) parts.push(base);
    if (wantIntern && !/\bintern(ship)?s?\b/i.test(base)) parts.push("intern");
    return parts.join(" ").replace(/\s+/g, " ").trim();
  };

  const explicit = String(o.query || "").trim();
  if (explicit) return { queries: [{ keywords: withIntern(explicit), from: "your keywords" }], derivedFrom: "your keywords" };

  // Strip the words that describe the LEVEL or the employment relationship rather
  // than the WORK, so "Software Engineering Intern" and "Senior Software Engineer"
  // both reduce to the field. The second list is generic-noise: a real resume title
  // like "Firmware Team Member" would otherwise search for "team member" as though
  // that described a kind of job (observed on the operator's own profile).
  const roleCore = (t) =>
    String(t || "")
      .replace(/\b(intern|internship|co-?op|trainee|apprentice|fellow|fellowship)\b/gi, " ")
      .replace(/\b(senior|sr\.?|junior|jr\.?|lead|staff|principal|associate|assistant|entry[- ]level)\b/gi, " ")
      .replace(/\b(team member|member|worker|volunteer|employee|student|part[- ]time|full[- ]time|summer|fall|winter|spring|\d{4})\b/gi, " ")
      .replace(/[^A-Za-z0-9+#. ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  // A title has to say something about the WORK to be worth a query slot. "Research"
  // or "Lab" alone matches half a board; require either two meaningful tokens or one
  // long, specific one.
  const usefulRole = (core) => {
    const toks = discoverKeywordTokens(core);
    return toks.length >= 2 || (toks.length === 1 && toks[0].length >= 7);
  };

  const out = [];
  const seen = new Set();
  const push = (base, from) => {
    const keywords = withIntern(base);
    if (!keywords) return;
    // Dedupe on the meaningful TOKEN SET, so "software engineering" and
    // "engineering software" don't both burn a query slot.
    const key = discoverKeywordTokens(keywords).slice().sort().join(" ");
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ keywords, from });
  };

  // RESERVE a slot for the field of study when there is one: titles are the better
  // signal but they are also narrow, and on a real resume they filled every slot and
  // pushed the major out entirely (observed live). Keeping one guarantees the sweep
  // always covers the broad case as well as the specific ones.
  const field = String(o.field || "").trim();
  const titleCap = field ? Math.max(1, cap - 1) : cap;
  for (const t of Array.isArray(o.jobTitles) ? o.jobTitles : []) {
    if (out.length >= titleCap) break;
    const core = roleCore(t);
    if (core && usefulRole(core)) push(core, "a role on your resume");
  }
  if (out.length < cap && field) push(field, "your field of study");
  // Skills, PAIRED: one skill alone is usually too broad ("Python"), two is a shape.
  const skills = (Array.isArray(o.skills) ? o.skills : []).map((x) => String(x || "").trim()).filter(Boolean);
  for (let i = 0; i < skills.length && out.length < cap; i += 2) {
    push(skills.slice(i, i + 2).join(" "), "skills on your resume");
  }
  // Nothing usable on the resume — fall back to the plain internship default rather
  // than a blank search (which is a board's recommended feed, not a search).
  // NOT via push(): "intern" is a STOPWORD, so its token key is empty and push()
  // would reject it as meaningless — which silently produced ZERO queries and thus a
  // skipped board for anyone with an empty profile.
  if (!out.length && wantIntern) out.push({ keywords: "intern", from: "the internship default" });

  return {
    queries: out.slice(0, cap),
    derivedFrom: out.length ? out.map((q) => q.from).filter((v, i, a) => a.indexOf(v) === i).join(" + ") : "",
  };
}

// The LinkedIn SEARCH PAGE url. ⚠ ONLY `keywords`, `geoId` and `f_TPR` survive a
// page load (traced 2026-07-30) — the new SDUI jobs page REWRITES its own URL and
// silently DISCARDS `location=` (free text), `sortBy=` and `f_E=`. This builder
// therefore emits only what the page honours; every richer filter goes through
// linkedInApiSearchUrl instead. Used for the DOM-fallback sweep, the geo resolver
// and recon — i.e. the paths that need a real rendered page.
function discoverLinkedInSearchUrl(opts) {
  const o = opts || {};
  const keywords = String(o.keywords || "").trim();
  // HARD REFUSAL: a keyword-less LinkedIn search is the recommended feed, not a
  // search. Better to fail loudly than to queue jobs nobody asked for.
  if (!keywords) return "";
  const secs = Math.max(1, Math.round((Number(o.sinceDays) || 1) * 86400));
  let u = "https://www.linkedin.com/jobs/search-results/?keywords=" + encodeURIComponent(keywords) +
    "&f_TPR=r" + secs;
  // A numeric geoId is the ONLY location form the page keeps. No geoId ⇒ no
  // location param at all, which the caller reports rather than pretending.
  const geoId = String(o.geoId || "").trim();
  if (/^\d+$/.test(geoId)) u += "&geoId=" + geoId;
  // `start` IS honoured (verified: start=25 returns a different 25 postings), which
  // is what lets the sweep go deeper on later days instead of re-reading page 1.
  const start = Math.max(0, Number(o.start) || 0);
  if (start > 0) u += "&start=" + start;
  return u;
}

// The LinkedIn JOB-SEARCH JSON url — the request the search page itself makes.
// Unlike the page, this honours the whole filter vocabulary AND paginates with
// start/count against a real `paging.total`.
function linkedInApiSearchUrl(opts) {
  const o = opts || {};
  const keywords = String(o.keywords || "").trim();
  if (!keywords) return ""; // same refusal as the page builder
  const geoId = String(o.geoId || "").trim();
  if (!/^\d+$/.test(geoId)) return ""; // locationUnion REQUIRES a numeric geoId (locationName ⇒ HTTP 500)
  const secs = Math.max(1, Math.round((Number(o.sinceDays) || 1) * 86400));
  const start = Math.max(0, Number(o.start) || 0);
  const count = Math.max(1, Math.min(Number(o.count) || 25, 25));

  // ⚠ RELEVANCE, NOT DATE, BY DEFAULT — and this was a real mistake to unlearn.
  // `sortBy:List(DD)` does drop every promoted row (verified), which looked like a
  // free win, so an earlier version of this had it permanently on. But date-sorting
  // this endpoint DESTROYS keyword relevance: searching "embedded software intern"
  // returned "EH&S Intern", "Audit Intern", "Finance Intern" — i.e. the newest
  // internships of ANY kind. On relevance the same query returns Skydio, Anduril,
  // Blue Origin avionics/embedded, Palantir. Promoted rows are handled where they
  // belong instead — detected from footerItems and PENALISED by matchPercent —
  // which costs nothing and doesn't trade away the actual match quality.
  const filters = ["timePostedRange:List(r" + secs + ")"];
  if (o.sortByDate) filters.push("sortBy:List(DD)");
  if (o.internshipOnly) filters.push("experience:List(" + LINKEDIN_EXPERIENCE_INTERNSHIP + ")");

  const query =
    "(origin:JOB_SEARCH_PAGE_KEYWORD_AUTOCOMPLETE" +
    ",keywords:" + encodeURIComponent(keywords) +
    ",locationUnion:(geoId:" + geoId + ")" +
    ",selectedFilters:(" + filters.join(",") + ")" +
    ",spellCorrectionEnabled:true)";

  return (
    "https://www.linkedin.com/voyager/api/voyagerJobsDashJobCards" +
    "?decorationId=com.linkedin.voyager.dash.deco.jobs.search.JobSearchCardsCollection-207" +
    "&count=" + count + "&q=jobSearch&query=" + query + "&start=" + start
  );
}

// One posting's full record: JD text, the typed apply method (which carries the
// EMPLOYER's real application url), the exact posted timestamp, and its state.
function linkedInApiDetailUrl(id) {
  const n = String(id || "").trim();
  if (!/^\d+$/.test(n)) return "";
  return (
    "https://www.linkedin.com/voyager/api/jobs/jobPostings/" + n +
    "?decorationId=com.linkedin.voyager.deco.jobs.web.shared.WebFullJobPosting-65"
  );
}

// Pull a numeric geoId out of any LinkedIn url. This is how the geo resolver
// reads its answer back (selecting a suggestion in LinkedIn's own location
// dropdown rewrites the page url to carry `geoId=<n>`), and it means a LinkedIn
// search url the operator pastes works for free.
function parseLinkedInGeoId(url) {
  const m = String(url || "").match(/[?&]geoId=(\d+)/);
  return m ? m[1] : "";
}

// The Handshake SEARCH PAGE url. Handshake's own JSON index (/stu/postings.json)
// IGNORES every filter param (verified — the total never moves), so the PAGE is
// the search substrate here and its params were traced from the real UI:
//   query · jobType · sort · per_page · page · locationFilter
// `locationFilter` is a JSON blob carrying a resolved place (id/label/point/
// distance) — produced by Handshake's own location dropdown, never hand-built.
function discoverHandshakeSearchUrl(opts) {
  const o = opts || {};
  const keywords = String(o.keywords || "").trim();
  if (!keywords) return "";
  const perPage = Math.max(1, Math.min(Number(o.perPage) || 25, 25));
  const page = Math.max(1, Number(o.page) || 1);
  let u =
    "https://app.joinhandshake.com/job-search?query=" + encodeURIComponent(keywords) +
    "&sort=" + encodeURIComponent(o.sort || HANDSHAKE_SORT_NEWEST) +
    "&per_page=" + perPage + "&page=" + page;
  if (o.internshipOnly) u += "&jobType=" + HANDSHAKE_JOB_TYPE_INTERNSHIP;
  const lf = String(o.locationFilter || "").trim();
  if (lf) u += "&locationFilter=" + encodeURIComponent(lf);
  return u;
}

// One Handshake posting's full record (same role as linkedInApiDetailUrl):
// text_description, use_external_apply_link + external_apply_link, created_at,
// applications_count, archived/hidden. Same-origin path — fetched from the page.
function handshakeDetailPath(id) {
  const n = String(id || "").trim();
  if (!/^\d+$/.test(n)) return "";
  return "/stu/jobs/" + n + ".json";
}

// Cache key for a resolved location. Both boards need their own opaque location
// token (LinkedIn a numeric geoId, Handshake a JSON place blob) and NEITHER can
// be built from free text — each is produced by that board's own typeahead. So a
// resolution is done ONCE per (board, text) and remembered.
function geoCacheKey(source, text) {
  return String(source || "").toLowerCase() + "|" + String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// ── Pure helpers (no chrome, no network — unit-tested in test/discover.test.js) ──

// canonicalJobUrl is lib.js's (importScripts loads lib.js BEFORE this file, so
// it's already a global in the SW). Under the Node test runner there is no
// importScripts, so pull it off the module instead — same function either way.
const _canonicalJobUrl =
  typeof canonicalJobUrl === "function" ? canonicalJobUrl : require("./lib.js").canonicalJobUrl;

// Stable per-JOB identity for discovery dedup. Extends the tracker's
// canonicalJobUrl (lib.js) with the BOARD ids the discovery sources hand us.
//
// Ordering is load-bearing: a Workday posting is keyed by canonicalJobUrl FIRST
// so a job discovered on the Simplify board (whose `url` IS the employer's
// Workday link) produces the SAME key the tracker stores after the operator
// applies to it — that is what makes "jobs I have not yet applied to" actually
// work across the two writers. Board ids only key postings whose canonical
// identity IS the board (LinkedIn/Handshake), where no ATS key exists yet.
//
// LOCKSTEP with web/lib/discover.ts `discoveryJobKey`. Change both.
function discoveryJobKey(u) {
  const raw = String(u == null ? "" : u).trim();
  if (!raw) return "";
  let p;
  try {
    p = new URL(raw);
  } catch (e) {
    return raw.split(/[?#]/)[0].toLowerCase();
  }
  const host = (p.hostname || "").toLowerCase();
  const path = p.pathname || "";

  // 1. Workday (either host shape) → the tracker's own key, so discovery and the
  //    application report converge on one identity.
  if (/_R\d+\b/i.test(path) || /myworkday(?:jobs|site)\.com$/i.test(host)) {
    return _canonicalJobUrl(raw);
  }
  // 2. LinkedIn — /jobs/view/<id> (also reachable as ?currentJobId=<id>).
  if (/(^|\.)linkedin\.com$/i.test(host)) {
    const viewed = path.match(/\/jobs\/view\/(\d+)/i);
    const current = (p.searchParams.get("currentJobId") || "").match(/^\d+$/);
    const id = viewed ? viewed[1] : current ? current[0] : "";
    if (id) return "linkedin:" + id;
  }
  // 3. Handshake — /jobs/<id> and the search route /job-search/<id> are the SAME
  //    posting, so both collapse to one key.
  if (/joinhandshake\.com$/i.test(host)) {
    const m = path.match(/\/(?:jobs|job-search|postings)\/(\d+)/i);
    if (m) return "handshake:" + m[1];
  }
  // 4. The common ATS shapes the Simplify board links out to — keyed so the same
  //    posting reached by a differing query string / locale prefix is one job.
  const gh = path.match(/\/([^/]+)\/jobs\/(\d+)/i);
  if (/greenhouse\.io$/i.test(host) && gh) return "greenhouse:" + gh[1].toLowerCase() + ":" + gh[2];
  const lever = path.match(/^\/([^/]+)\/([0-9a-f-]{16,})/i);
  if (/lever\.co$/i.test(host) && lever) return "lever:" + lever[1].toLowerCase() + ":" + lever[2].toLowerCase();
  const ashby = path.match(/^\/([^/]+)\/([0-9a-f-]{16,})/i);
  if (/ashbyhq\.com$/i.test(host) && ashby) return "ashby:" + ashby[1].toLowerCase() + ":" + ashby[2].toLowerCase();

  // 5. Everything else → the tracker's generic fallback (origin+path, no query).
  return _canonicalJobUrl(raw);
}

// Parse "when was this posted" from whatever a source gives us: a unix timestamp
// (seconds OR milliseconds), an ISO/date string, or LinkedIn/Handshake's relative
// prose ("2 days ago", "Reposted 3 hours ago", "just now", "30+ days ago").
// Returns epoch MILLISECONDS, or null when genuinely unknown — null is a real
// answer here and callers must not coerce it to "now" (see isFreshPosting).
function parsePostedTimestamp(input, nowMs) {
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  if (input == null || input === "") return null;

  if (typeof input === "number" && isFinite(input)) {
    if (input <= 0) return null;
    // Heuristic: 10-digit values are unix SECONDS (the Simplify feed), 13-digit ms.
    return input < 1e12 ? Math.round(input * 1000) : Math.round(input);
  }

  const s = String(input).trim();
  if (!s) return null;

  // A bare numeric string is a timestamp too (some feeds stringify it).
  if (/^\d{9,14}$/.test(s)) return parsePostedTimestamp(Number(s), now);

  // Relative prose. "30+ days ago" → treat as exactly 30 days (a floor, which is
  // the safe direction: it can only make something look OLDER, never fresher).
  const rel = s.match(/(\d+)\s*\+?\s*(minute|min|hour|hr|day|week|month|year)s?\s*ago/i);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    const ms =
      unit.startsWith("min") ? 60e3 :
      unit.startsWith("h") ? 3600e3 :
      unit === "day" ? 86400e3 :
      unit === "week" ? 7 * 86400e3 :
      unit === "month" ? 30 * 86400e3 :
      365 * 86400e3;
    return now - n * ms;
  }
  if (/\b(just\s*now|today|new|moments?\s+ago)\b/i.test(s)) return now;
  if (/\byesterday\b/i.test(s)) return now - 86400e3;

  const t = Date.parse(s);
  return isFinite(t) ? t : null;
}

// Is this posting inside the recency window?
//
// UNKNOWN DATE ⇒ FRESH (deliberate). Every source is ALREADY bounded before we
// get here — LinkedIn by f_TPR, Simplify by a real date_posted, Handshake by its
// newest-first sort — so a row whose date text we simply couldn't parse is far
// more likely a parse gap than a genuinely stale posting. Dropping it would
// silently hide real jobs (the failure the operator would never see); including
// it costs one reviewable queue row, and the row is tagged posted_unknown so the
// UI can show it. Unit-pinned so the choice can't drift.
function isFreshPosting(tsMs, sinceDays, nowMs) {
  if (tsMs == null) return true;
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  const days = Number(sinceDays);
  if (!isFinite(days) || days <= 0) return true;
  return tsMs >= now - days * 86400e3;
}

// Filler words + the role word itself, which carry no discriminating power when
// matching a keyword phrase against a board row's SHORT fields.
const DISCOVER_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "in", "at", "to", "with",
  "intern", "interns", "internship", "internships", "co-op", "coop",
]);

// The meaningful tokens of a keyword phrase — what's left after stopwords and the
// role word. "electrical and computer engineering intern" → [electrical, computer,
// engineering]. Short tokens (<3 chars) go too: they match far too much.
function discoverKeywordTokens(keywords) {
  return String(keywords || "")
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter((t) => t.length >= 3 && !DISCOVER_STOPWORDS.has(t));
}

/**
 * Does a posting match the operator's keywords? Used ONLY for sources we filter
 * OURSELVES (the Simplify feed) — never for LinkedIn/Handshake, where the BOARD
 * already ran the search against the full posting text.
 *
 * ANY-token, not every-token (fixed 2026-07-29). AND semantics over a row's short
 * title/company/category fields silently threw away almost everything: searching
 * "electrical and computer engineering intern" requires every token, but the row
 * that matters reads title "Engineering Intern", category "Hardware" — no
 * "electrical" anywhere, so a correct hit got dropped. The board search is the
 * precise filter; this is a coarse relevance sieve over a feed that has none.
 */
function matchesDiscoverQuery(job, keywords) {
  const tokens = discoverKeywordTokens(keywords);
  if (!tokens.length) return true;
  const hay = [job.title, job.company, job.location, job.category]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return tokens.some((t) => hay.includes(t));
}

// Location match for a source we filter ourselves. A blank/whole-country setting
// matches everything (the board rows carry no country, so "United States" can't be
// matched literally — filtering on it would drop every row). A SPECIFIC place
// matches a substring of the row's locations, and Remote always qualifies.
function matchesDiscoverLocation(job, location) {
  const loc = String(location || "").trim().toLowerCase();
  if (!loc || loc === DISCOVER_DEFAULT_LOCATION.toLowerCase()) return true;
  const hay = String(job.location || "").toLowerCase();
  if (!hay) return true; // unknown location — surface it rather than hide it
  if (/\bremote\b/.test(hay)) return true;
  return loc.split(/[^a-z0-9]+/).filter((t) => t.length >= 2).some((t) => hay.includes(t));
}

// Normalize one raw source row into the common discovered-job shape. Keeps the
// contract in ONE place so all three sources (and the website) agree.
function normalizeDiscoveredJob(raw, source, nowMs) {
  const url = String((raw && raw.url) || "").trim();
  if (!url) return null;
  const postedAt = parsePostedTimestamp(raw.postedAt != null ? raw.postedAt : raw.datePosted, nowMs);
  const text = String(raw.description || "").trim();
  return {
    source: String(source || raw.source || "").toLowerCase(),
    url,
    jobKey: discoveryJobKey(url),
    title: String(raw.title || "").trim().slice(0, 300),
    company: String(raw.company || "").trim().slice(0, 200),
    location: String(raw.location || "").trim().slice(0, 200),
    category: String(raw.category || "").trim().slice(0, 120),
    postedAt,                                   // epoch ms | null
    postedText: String(raw.postedText || "").trim().slice(0, 80),
    postedUnknown: postedAt == null,
    description: text.slice(0, 20000),
    descriptionSource: text ? String(raw.descriptionSource || "list") : "",
    // Apply-link resolution (filled in by the JD pass). `url` always holds the
    // BEST known link — rewritten to the employer's real application URL when the
    // posting exposes one — and `boardUrl` remembers where we found it.
    boardUrl: "",
    applyKind: "",       // "easy" | "external" | "unknown" (LinkedIn only)
    applyResolved: false, // true once `url` is the employer's, not the board's
    // Ranking inputs. Both boards report how many people have applied, which is
    // the single best "should I bother" signal available — and a board's own
    // "promoted" flag marks a paid placement rather than a relevance match.
    applicants: raw.applicants == null ? null : Number(raw.applicants),
    earlyApplicant: !!raw.earlyApplicant,
    promoted: !!raw.promoted,
    // ── The REAL posting date vs a REPOST (operator 2026-07-30) ───────────────
    // Boards re-float an old posting and show the REPOST date as if it were new.
    // Measured on LinkedIn: 2 of 3 sampled postings were reposts, one of them 63
    // DAYS newer than its original. Ranking on the board's headline date would put
    // a two-month-old job at the top of a daily sweep every time it was bumped, so
    // the original is kept separately and `postedForRanking` prefers it.
    originalPostedAt: parsePostedTimestamp(raw.originalPostedAt, nowMs),
    reposted: !!raw.reposted,
    // ── Details worth seeing in the queue before opening anything ─────────────
    // Handshake publishes pay and a term; LinkedIn publishes neither (its
    // `salaryInsights` is a link to its salary tool, not a number) — so pay stays
    // EMPTY for LinkedIn rather than being invented.
    pay: String(raw.pay || "").trim().slice(0, 80),
    startDate: String(raw.startDate || "").trim().slice(0, 40),
    endDate: String(raw.endDate || "").trim().slice(0, 40),
    applyBy: String(raw.applyBy || "").trim().slice(0, 40),
    workplace: String(raw.workplace || "").trim().slice(0, 24),
    employmentType: String(raw.employmentType || "").trim().slice(0, 60),
    score: 0,
    matchPercent: 0,
    scoreReasons: [],
  };
}

// "(On-site)" / "(Hybrid)" / "(Remote)" as both boards render it on a card. Read
// from the OBSERVED text rather than mapping LinkedIn's `workplaceType` urns, of
// which only 2=Remote and 3=Hybrid were actually confirmed live.
function workplaceFromText(s) {
  const m = String(s || "").match(/\((on-?site|hybrid|remote)\)/i);
  if (m) return m[1].replace(/^on-?site$/i, "On-site").replace(/^hybrid$/i, "Hybrid").replace(/^remote$/i, "Remote");
  return "";
}

// ── Board payload → the common shape (PURE; the network lives in the drivers) ──

// One element of LinkedIn's job-search JSON → a raw row for normalizeDiscoveredJob.
// The card is already structured, so nothing is parsed out of rendered text: the
// id comes from `jobPostingUrn`, and the footer is a TYPED list whose LISTED_DATE
// entry is an exact epoch — no "3 days ago" prose to reverse-engineer.
function linkedInCardToRaw(element) {
  const card = (element && element.jobCardUnion && element.jobCardUnion.jobPostingCard) || null;
  if (!card) return null;
  const id = String((card.jobPostingUrn || card.entityUrn || "")).split(":").pop();
  if (!/^\d+$/.test(id)) return null;
  const foot = Array.isArray(card.footerItems) ? card.footerItems : [];
  const item = (t) => foot.find((f) => f && f.type === t) || null;
  const listed = item("LISTED_DATE");
  const applicantText = ((item("APPLICANT_COUNT_TEXT") || {}).text || {}).text || "";
  const n = String(applicantText).match(/(\d[\d,]*)/);
  const loc = ((card.secondaryDescription || {}).text || "").trim();
  return {
    url: "https://www.linkedin.com/jobs/view/" + id + "/",
    title: ((card.title || {}).text || card.jobPostingTitle || "").trim(),
    company: ((card.primaryDescription || {}).text || "").trim(),
    location: loc,
    workplace: workplaceFromText(loc),
    postedAt: listed && listed.timeAt ? listed.timeAt : null,
    promoted: !!item("PROMOTED"),
    // "Be an early applicant" carries no number but IS the signal we want.
    earlyApplicant: /early applicant/i.test(applicantText),
    applicants: n ? Number(n[1].replace(/,/g, "")) : null,
  };
}

/**
 * A LinkedIn result card's text lines → { title, company, location }.
 *
 * The SDUI card has NO per-field selectors to key on (every class is a build hash),
 * so the fields come from the card's reading order. Three shapes exist live
 * (traced 2026-07-30) and they differ only in the leading a11y summary line:
 *
 *   A  ["Title (Verified job)", "Title", "Company", "Location", …]   ← verified jobs
 *   B  ["Title",                "Title", "Company", "Location", …]
 *   C  ["Title",                         "Company", "Location", …]
 *
 * ⚠ REGRESSION THIS PINS: a plain consecutive-dedupe handles B and C but NOT A,
 * because "Title (Verified job)" is not byte-equal to "Title". On the 25-card live
 * page that shifted every field by one on exactly the verified postings — company
 * became the title and location became the company — while still looking like
 * plausible data. That is the worst kind of scraper bug (wrong, not empty), which
 * is why this lives out here as a pure function instead of inside the injected
 * scraper where it could not be tested.
 *
 * Order matters: strip the decoration FIRST, then dedupe, then drop a leading line
 * that is merely a longer form of the next one (a belt for any future suffix).
 */
function linkedInFieldsFromLines(lines) {
  const deco = (s) =>
    String(s || "")
      .replace(/\s*\((?:verified job|verified)\)\s*$/i, "")
      .replace(/^\s*Selected,\s*/i, "")
      .trim();
  const raw = (Array.isArray(lines) ? lines : []).map(deco).filter(Boolean);
  let out = raw.filter((l, i) => i === 0 || l !== raw[i - 1]);
  if (out.length > 1 && out[0] !== out[1] && (out[0].startsWith(out[1]) || out[1].startsWith(out[0]))) {
    out = out.slice(1);
  }
  return {
    title: (out[0] || "").slice(0, 300),
    company: (out[1] || "").slice(0, 200),
    location: (out[2] || "").slice(0, 200),
  };
}

// LinkedIn's full posting record → the fields the JD pass patches onto a job.
// `applyMethod` is a TYPED union: its KEY says whether the application lives on
// LinkedIn ("…OnsiteApply" = Easy Apply, so no employer url can exist) or offsite
// (which carries `companyApplyUrl` — the employer's real application page). That
// replaces sniffing the rendered text for the words "easy apply".
function linkedInDetailToPatch(json) {
  const j = json || {};
  const method = j.applyMethod || {};
  const key = Object.keys(method)[0] || "";
  const easy = /OnsiteApply/i.test(key);
  const co =
    ((((j.companyDetails || {})["com.linkedin.voyager.deco.jobs.web.shared.WebJobPostingCompany"] || {})
      .companyResolutionResult) || {}).name || "";
  return {
    ok: true,
    title: String(j.title || "").trim(),
    company: String(co).trim(),
    location: String(j.formattedLocation || "").trim(),
    description: String((j.description || {}).text || ""),
    // `listedAt` is the LATEST listing (a repost bumps it); `originalListedAt` is
    // when it was actually first posted. Both are carried; ranking uses the original.
    postedAt: j.listedAt || j.originalListedAt || null,
    originalPostedAt: j.originalListedAt || null,
    // A repost only counts as one if the two dates differ by more than an hour —
    // they are equal (or near-equal) on a genuinely new posting.
    reposted: !!(j.listedAt && j.originalListedAt && j.listedAt - j.originalListedAt > 3600e3),
    // A real apply-by deadline, which is worth seeing before opening anything.
    applyBy: j.expireAt ? new Date(j.expireAt).toISOString().slice(0, 10) : "",
    workplace: workplaceFromText(j.formattedLocation) || (j.workRemoteAllowed ? "Remote" : ""),
    // LinkedIn does NOT publish pay here: `salaryInsights` carries only a link to
    // its salary tool (`insightExists:false`, `salaryExplorerUrl`), so pay is left
    // empty rather than fabricated. Handshake does publish it.
    pay: "",
    // jobState is "LISTED" while live; anything else (CLOSED/SUSPENDED) means
    // applying is impossible, so the row must not reach the queue.
    closed: !!j.closed || (j.jobState ? String(j.jobState).toUpperCase() !== "LISTED" : false),
    applyKind: easy ? "easy" : key ? "external" : "unknown",
    applyUrl: easy ? "" : String((method[key] || {}).companyApplyUrl || ""),
    applyVia: key ? "applyMethod:" + key.split(".").pop() : "",
    applicants: j.applies == null ? null : Number(j.applies),
    employmentType: String(j.formattedEmploymentStatus || "").trim(),
  };
}

// Handshake's /stu/jobs/<id>.json → the same patch shape, so both boards converge.
//
// ⚠ THE APPLY LINK LIVES IN `job_apply_setting`, NOT `external_apply_link`.
// This cost a near-miss worth recording (2026-07-30): the record has BOTH, and the
// obvious-looking pair `use_external_apply_link` / `external_apply_link` is LEGACY
// — measured across 30 live postings it was `false`/`null` on every single one,
// INCLUDING postings that plainly do apply offsite. Reading it concluded "0% of
// Handshake jobs have an employer link", which would have silently reduced the
// whole source to nothing once board-only postings are skipped.
//
// The authoritative config is the nested `job_apply_setting`:
//     { apply_type: "handshake" | "external", external_url, external_apply_type,
//       additional_instructions }
// Read that way, 10 of the same 30 postings (33%) carry a real employer link —
// Greenhouse, Workday, Google Careers, Paylocity, Tesla. The legacy pair is kept
// only as a fallback in case an older record shape still populates it.
// "2026-08-14T00:00:00-07:00" → "2026-08-14"; anything unparseable → "".
function dateOnly(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return "";
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const t = Date.parse(s);
  return isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "";
}

// NOTE — a `handshakePayLabel` that rebuilt the pay string from the record's raw
// numbers was REMOVED (2026-07-30). It produced "$3000/hr" and "$50K/mo" live, because
// the record's `salary` is in CENTS and `salary_type_name` is "Paid"/"Unpaid" rather
// than a unit — it was being read as one. Handshake already renders the correct label
// on the card ("$30-50/hr", "Unpaid"), so the card is the source of truth and there is
// nothing left to reconstruct. See scrapeHandshakeJobList.

function handshakeDetailToPatch(json) {
  const j = (json && json.job) || null;
  if (!j) return { ok: false, error: "no-job-in-payload" };

  const setting = j.job_apply_setting || {};
  const applyType = String(setting.apply_type || "").trim().toLowerCase();
  const settingUrl = String(setting.external_url || "").trim();
  const legacyUrl = j.use_external_apply_link ? String(j.external_apply_link || "").trim() : "";
  const link = /^https?:\/\//i.test(settingUrl) ? settingUrl : (/^https?:\/\//i.test(legacyUrl) ? legacyUrl : "");
  // "external" WITHOUT a usable url is a real state (the employer set the type but
  // left the link blank / it's an email-apply): still not Run-drivable, so it is
  // reported as unknown rather than being called an employer link we don't have.
  const applyKind = link ? "external" : applyType === "external" ? "unknown" : "easy";

  const text = String(j.text_description || "").trim() ||
    String(j.description || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return {
    ok: true,
    title: String(j.title || "").trim(),
    company: String(j.employer_name || j.fancy_employer_name || "").trim(),
    location: Array.isArray(j.location_names) ? j.location_names.join(", ") : String(j.location_names || ""),
    description: text,
    postedAt: j.created_at || j.apply_start || null,
    // Handshake hides/archives rather than deleting; `hidden` also means the
    // operator dismissed it in the UI, which is a deliberate "not this one".
    closed: !!j.archived || !!j.hidden || (j.is_postable === false),
    // Handshake publishes real compensation and a term — exactly the "pay, start
    // date/end date and other important information" worth showing in the queue.
    // NOT reconstructed from the record — see the note in scrapeHandshakeJobList. The
    // card's own formatting is authoritative; this only fills in the paid/unpaid fact
    // when the card didn't say, which is the one thing the record states unambiguously.
    pay: /unpaid/i.test(String(j.salary_type_name || (j.salary_type && j.salary_type.name) || "")) ? "Unpaid" : "",
    startDate: dateOnly(j.start_date),
    endDate: dateOnly(j.end_date),
    applyBy: dateOnly(j.expiration_date || j.default_expiration_date),
    workplace: j.remote ? "Remote" : j.hybrid ? "Hybrid" : j.on_site ? "On-site" : "",
    applyKind,
    applyUrl: link,
    applyVia: link ? (link === settingUrl ? "job_apply_setting.external_url" : "external_apply_link (legacy)") : "",
    // Worth carrying: several postings say "apply using the external link only —
    // resumes received via Handshake will not be reviewed", which is exactly the
    // kind of instruction that shouldn't be lost on the way to the queue.
    applyNote: String(setting.additional_instructions || "").trim().slice(0, 300),
    applicants: j.applications_count == null ? null : Number(j.applications_count),
    employmentType: String((j.job_type || {}).name || j.job_type_name || "").trim(),
    promoted: !!j.promoted_job || !!j.premium_job,
  };
}

// ── MATCH PERCENTAGE (deterministic, explainable, 0–100) ────────────────────
//
// The operator queues by a "% match" THRESHOLD rather than a top-N count, so the
// number has to mean something on its own — an unbounded score can't be compared
// against "60%". Every component therefore has a fixed maximum and they sum to 100:
//
//     relevance   0–65   does it match what was asked for / the resume
//     freshness   0–30   how recently it was POSTED (the operator's main criterion)
//     drivable    0–5    can the Run pipeline actually drive it
//     penalties          promoted listing, board-only application
//
// Deliberately not an LLM call: cheap, stable across runs, and every point is
// attributable, so `scoreReasons` is shown next to the job instead of asking the
// operator to trust a number.
//
// ⚠ APPLICANT COUNT IS NOT SCORED (operator 2026-07-30: "I don't need the how many
// people applied sort. mainly filter on when it was posted"). It is still READ and
// displayed, because it is free and useful to a human deciding — but it no longer
// moves the ranking, and freshness now carries the weight it used to take.
function matchPercent(job, opts) {
  const o = opts || {};
  const now = typeof o.nowMs === "number" ? o.nowMs : Date.now();
  const windowDays = Number(o.sinceDays) > 0 ? Number(o.sinceDays) : DISCOVER_DEFAULTS.sinceDays;
  const reasons = [];

  // 1. RELEVANCE (0–65). Coverage of the search terms, with a title hit worth far
  //    more than a body mention: a JD that says "python" once is weak evidence
  //    against a title that says it. Scored as a FRACTION of the tokens asked for,
  //    so a 2-word and a 6-word search are comparable.
  const tokens = discoverKeywordTokens([o.keywords, o.field].filter(Boolean).join(" "));
  const title = String(job.title || "").toLowerCase();
  const body = String(job.description || "").toLowerCase();
  const inTitle = tokens.filter((t) => title.includes(t));
  const inBody = tokens.filter((t) => !title.includes(t) && body.includes(t));
  let relevance;
  if (!tokens.length) {
    relevance = 40; // nothing specific asked for — neutral, don't fake precision
  } else {
    const covered = (inTitle.length + inBody.length * 0.35) / tokens.length;
    relevance = Math.min(1, covered) * 55;
    // A title that names the role is the strongest single signal available.
    if (inTitle.length) relevance += Math.min(10, inTitle.length * 5);
  }
  if (inTitle.length) reasons.push("title matches " + inTitle.slice(0, 4).join(", "));
  else if (inBody.length) reasons.push("mentions " + inBody.slice(0, 3).join(", "));
  else if (tokens.length) reasons.push("no keyword match in the title or description");

  // Internship intent — the board filter already applied, but a title that SAYS
  // intern/co-op is a stronger match than one that merely passed the filter.
  if (o.intern !== false && /\b(intern|internship|co-?op)\b/i.test(job.title || "")) {
    relevance = Math.min(65, relevance + 6);
    reasons.push("an internship by title");
  }
  relevance = Math.max(0, Math.min(65, relevance));

  // 2. FRESHNESS (0–30) — the operator's primary criterion. Linear decay across the
  //    recency window, measured in HOURS so a daily sweep can tell today from
  //    yesterday. An unknown date scores mid-range rather than 0: every source is
  //    already time-bounded upstream, so unknown means "unparsed", not "ancient".
  let freshness;
  const at = postedForRanking(job);
  if (at == null) {
    freshness = 12;
    reasons.push("posted date unknown");
  } else {
    const hrs = Math.max(0, (now - at) / 3600e3);
    const windowHrs = windowDays * 24;
    freshness = Math.max(0, Math.min(30, 30 * (1 - hrs / windowHrs)));
    reasons.push(
      hrs < 1 ? "posted within the hour" :
      hrs < 24 ? `posted ${Math.round(hrs)}h ago` :
      `posted ${Math.round(hrs / 24)}d ago`
    );
    // Say so when the board's headline date was a REPOST and this is the original.
    if (job.reposted) reasons.push("(board shows a repost; scored on the original date)");
  }

  // 3. DRIVABLE (0–5). A board-only application is worth strictly less to THIS tool
  //    than an employer ATS link, whatever the posting says.
  let drivable = 0;
  if (job.applyResolved && !isBoardUrl(job.url)) { drivable = 5; reasons.push("employer link resolved"); }
  else if (job.applyKind === "easy") { reasons.push("board-only application"); }

  let pct = relevance + freshness + drivable;
  if (job.applyKind === "easy") pct -= 8;      // can't be driven at all
  if (job.promoted) { pct -= 5; reasons.push("promoted listing"); }

  return { percent: Math.max(0, Math.min(100, Math.round(pct))), reasons };
}

/**
 * The date to RANK on — the ORIGINAL posting date, not a repost.
 *
 * Operator 2026-07-30: "sometimes it says when it was reposted. that is different
 * from when it was actually posted." A reposted job shows "Reposted 22 hours ago"
 * on the card and LinkedIn's record carries BOTH `listedAt` (the repost) and
 * `originalListedAt`. Ranking on the repost date would keep re-floating an old
 * posting to the top of a daily sweep every time the employer bumped it.
 */
function postedForRanking(job) {
  const orig = job && job.originalPostedAt;
  const at = job && job.postedAt;
  if (orig != null && at != null) return Math.min(orig, at); // the older of the two IS the original
  if (orig != null) return orig;
  return at == null ? null : at;
}

// Rank by match %, then keep everything at or above `minPercent`. Returns BOTH
// halves so the caller can report what it left behind — a narrowing the operator
// can't see is indistinguishable from a sweep that found nothing.
function pickByThreshold(jobs, minPercent, opts) {
  const scored = (jobs || []).filter(Boolean).map((j) => {
    const { percent, reasons } = matchPercent(j, opts);
    return { ...j, score: percent, matchPercent: percent, scoreReasons: reasons };
  });
  scored.sort((a, b) => (b.matchPercent - a.matchPercent) || comparePostedDesc(a, b));
  const min = Number(minPercent);
  if (!isFinite(min) || min <= 0) return { kept: scored, dropped: [] };
  return {
    kept: scored.filter((j) => j.matchPercent >= min),
    dropped: scored.filter((j) => j.matchPercent < min),
  };
}

// Kept as a thin alias: the driver pre-ranks candidates before spending the record
// budget, and only needs the ORDER, not a threshold.
function rankByMatch(jobs, opts) {
  return pickByThreshold(jobs, 0, opts).kept;
}

// Map the Simplify feed's array to discovered jobs: live postings only
// (active && is_visible — an inactive row is a CLOSED posting, queueing it would
// waste a run), inside the term season, inside the recency window, matching the
// keyword filter, newest first, capped.
function simplifyListingsToJobs(listings, opts) {
  const o = opts || {};
  const now = typeof o.nowMs === "number" ? o.nowMs : Date.now();
  const termRx = o.termPattern ? new RegExp(String(o.termPattern), "i") : null;
  const max = Number(o.maxItems) > 0 ? Number(o.maxItems) : DISCOVER_DEFAULTS.maxPerSource;

  const out = [];
  for (const row of Array.isArray(listings) ? listings : []) {
    if (!row || typeof row !== "object") continue;
    if (row.active === false || row.is_visible === false) continue;
    if (termRx) {
      const terms = Array.isArray(row.terms) ? row.terms.join(" ") : String(row.terms || "");
      if (!termRx.test(terms)) continue;
    }
    const job = normalizeDiscoveredJob(
      {
        url: row.url,
        title: row.title,
        company: row.company_name,
        location: Array.isArray(row.locations) ? row.locations.join(", ") : row.locations,
        category: row.category,
        postedAt: row.date_posted,
      },
      "simplify",
      now
    );
    if (!job) continue;
    if (!isFreshPosting(job.postedAt, o.sinceDays, now)) continue;
    // This feed has no server-side search, so we sieve it ourselves (coarse,
    // any-token) and honour an explicit location.
    if (!matchesDiscoverQuery(job, o.keywords)) continue;
    if (!matchesDiscoverLocation(job, o.location)) continue;
    out.push(job);
  }
  out.sort(comparePostedDesc);
  return out.slice(0, max);
}

// Newest first; unknown dates last (they're the least-trustworthy rows, so they
// shouldn't crowd out postings we KNOW are fresh when maxTotal bites).
function comparePostedDesc(a, b) {
  const av = a && a.postedAt != null ? a.postedAt : -Infinity;
  const bv = b && b.postedAt != null ? b.postedAt : -Infinity;
  return bv - av;
}

// Drop anything already applied-to / queued (knownKeys) and any self-duplicate
// (the same job listed on two boards — first source wins, and sources are merged
// in a stable order so that's deterministic). Returns { jobs, skippedKnown,
// skippedDupe } so the UI can say WHY a sweep found fewer than it scanned —
// "0 new" must be distinguishable from "0 found".
function dedupeDiscovered(jobs, knownKeys) {
  const known = new Set((knownKeys || []).map((k) => String(k || "").trim()).filter(Boolean));
  const seen = new Set();
  const out = [];
  let skippedKnown = 0;
  let skippedDupe = 0;
  for (const job of jobs || []) {
    if (!job || !job.url) continue;
    const key = job.jobKey || discoveryJobKey(job.url);
    if (known.has(key)) { skippedKnown++; continue; }
    if (seen.has(key)) { skippedDupe++; continue; }
    seen.add(key);
    out.push({ ...job, jobKey: key });
  }
  return { jobs: out, skippedKnown, skippedDupe };
}

/**
 * SECOND-PASS dedup: the same posting listed on two DIFFERENT boards under keys that
 * cannot be reconciled.
 *
 * WHY THIS IS NEEDED (measured 2026-07-30). Key-based dedup catches the normal case,
 * because both boards resolve a posting to the employer's url first. But boards hand
 * out DIFFERENT employer urls for the same job: Simplify carries the full Greenhouse
 * link while LinkedIn's `companyApplyUrl` for that very posting is a Greenhouse
 * SHORTLINK —
 *     simplify → greenhouse:redwoodmaterials:6126784004
 *     linkedin → https://grnh.se/2fwkl2zj4us
 * — and a shortlink can't be expanded without following its redirect, which needs a
 * host permission this extension deliberately doesn't take. Live, "Redwood Materials —
 * Embedded Software Engineer Intern" was on BOTH boards, so it would have queued twice.
 *
 * SAFETY — why company+title is acceptable here but wouldn't be in general:
 *   · it only ever collapses jobs from DIFFERENT sources. Two boards listing the same
 *     company AND the same exact title is overwhelmingly one posting;
 *   · WITHIN one source it does nothing, which is the case that would be wrong —
 *     LinkedIn legitimately lists two "Embedded Software Engineer Intern, Implant
 *     Embedded Systems" at Neuralink (San Francisco and South San Francisco), and
 *     those are distinct postings that must both survive;
 *   · both fields must be non-empty, so sparse rows never collapse into each other;
 *   · the FIRST source wins (sources merge in a fixed order), so it's deterministic,
 *     and the drop is REPORTED like every other narrowing.
 */
function crossSourceKey(job) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  const co = norm(job && job.company);
  const t = norm(job && job.title);
  if (!co || !t) return "";
  return co + "|" + t;
}

function dedupeCrossSource(jobs) {
  const byPair = new Map();
  const kept = [];
  const dropped = [];
  for (const job of jobs || []) {
    if (!job) continue;
    const pair = crossSourceKey(job);
    if (!pair) { kept.push(job); continue; }
    const prev = byPair.get(pair);
    // Only a DIFFERENT source collapses; a same-source repeat is a real second posting.
    if (prev && prev.source !== job.source) { dropped.push({ job, keptFrom: prev.source }); continue; }
    if (!prev) byPair.set(pair, job);
    kept.push(job);
  }
  return { kept, dropped };
}

// One-line-per-source tally for the SW log + the website's result panel.
function summarizeDiscovery(jobs) {
  const bySource = {};
  for (const j of jobs || []) {
    const s = (j && j.source) || "unknown";
    bySource[s] = (bySource[s] || 0) + 1;
  }
  return { total: (jobs || []).length, bySource };
}

// ── Injected page functions (self-contained — close over NOTHING) ───────────
// These are stringified into the page (chrome.scripting or CDP Runtime.evaluate),
// exactly like background.js's scrapeJobDescription. They may not reference
// anything from this module.

// LINKEDIN list scrape — the FALLBACK substrate (the primary is the search JSON).
//
// ⚠ REWRITTEN 2026-07-30 after tracing the live signed-in page. LinkedIn shipped a
// server-driven-UI (SDUI) rewrite of the jobs experience and the previous version
// of this function matched NOTHING — all ~30 of its selectors returned 0:
//   · cards are NOT anchors any more. There is no <a href="/jobs/view/<id>"> per
//     row at all (a 25-result page had exactly ONE such anchor, and not on a card),
//     so the old "walk up from the posting link" identity anchor is simply gone.
//   · every class is a rotating build hash (`_778a8c0c`, `c1b80624`), so a
//     class-based ladder is unfixable in principle, not merely stale.
//
// The one stable, semantic hook: each card carries
//     componentkey="job-card-component-ref-<jobId>"
// — the same naming convention LinkedIn uses for its other durable nodes
// (`JobsSearchFilters`, `SearchResults_SearchTyahInputRef`), and it hands us the
// job id directly. Verified: 25 unique ids off a 25-result page.
//
// Fields come from the card's OWN text lines (there are no per-field selectors to
// key on), which is stable because the card's reading order is its visual order:
// title, company, location, then the insight/posted lines.
function scrapeLinkedInJobList() {
  const href = location.href || "";
  if (/\/(?:login|authwall|checkpoint|uas\/login)/i.test(href)) {
    return { signedIn: false, jobs: [], note: "LinkedIn redirected to its sign-in page." };
  }

  // The id-carrying attribute appears on the card AND on an inner wrapper, so keep
  // the RICHEST node per id (the one whose text covers the whole card).
  const best = new Map();
  for (const el of document.querySelectorAll('[componentkey^="job-card-component-ref-"]')) {
    const id = (el.getAttribute("componentkey") || "").replace("job-card-component-ref-", "");
    if (!/^\d+$/.test(id)) continue;
    const len = ((el.innerText || "") + "").length;
    const prev = best.get(id);
    if (!prev || len > prev.len) best.set(id, { el, len });
  }

  if (!best.size) {
    const guest = document.querySelector('.sign-in-form, [data-tracking-control-name*="guest"], a[href*="/uas/login"], input[type="password"]');
    return {
      signedIn: !guest,
      jobs: [],
      note: guest
        ? "LinkedIn is showing its signed-out page."
        : "No job cards found on the LinkedIn results page — no [componentkey^=\"job-card-component-ref-\"] nodes. Run Discover recon; the SDUI layout may have changed again.",
    };
  }

  const jobs = [];
  for (const [id, { el }] of best) {
    const all = (el.innerText || "");
    const posted =
      (all.match(/Posted\s+([^\n]+)/i) || [])[1] ||
      (all.match(/(\d+\s*\+?\s*(?:minute|min|hour|hr|day|week|month)s?\s+ago|just now|today|yesterday)/i) || [])[1] ||
      "";
    const applicants = (all.match(/([\d,]+)\s+applicants?/i) || [])[1] || "";
    jobs.push({
      url: "https://www.linkedin.com/jobs/view/" + id + "/",
      // The card's raw text LINES, not parsed fields. Splitting them into
      // title/company/location is done service-worker-side by the pure, unit-tested
      // linkedInFieldsFromLines — deliberately, because getting that split wrong is
      // silent (it mislabels every field rather than failing) and it DID go wrong:
      // see that function's note on the "(Verified job)" shift.
      lines: all.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 12),
      postedAt: posted,
      postedText: posted,
      promoted: /\bPromoted\b/i.test(all),
      earlyApplicant: /early applicant/i.test(all),
      applicants: applicants ? Number(applicants.replace(/,/g, "")) : null,
      // The JD is only ever in the right-hand pane, so a list row carries none —
      // the detail pass fills it in.
      description: "",
    });
  }
  return { signedIn: true, jobs, note: "" };
}

// HANDSHAKE list scrape. TRACED on the live signed-in session (2026-07-30).
//
// Handshake is the friendlier of the two: it keeps SEMANTIC `data-hook`
// attributes, and the card's own hook carries the job id:
//     data-hook="job-result-card | 11243659"
// (with a sibling `job-result-card-footer` holding "Remote ∙ New" / "Promoted ∙
// Pittsburgh, PA + 2 ∙ 2wk ago", and a `job-hide-button-<id>`). Verified: 25 cards
// on a 25-per-page search.
//
// The card's inner <a> carries an aria-label that is the whole row in reading
// order — "«Employer» «Title» $20-30/hr · Internship · Aug 14—Dec 14 Remote New" —
// which is a far better field source than the hashed-class inner nodes.
function scrapeHandshakeJobList() {
  const txt = (el) => ((el && (el.innerText || el.textContent)) || "").replace(/\s+/g, " ").trim();
  const href = location.href || "";
  if (/\/(?:login|users\/sign_in|saml)/i.test(href)) {
    return { signedIn: false, jobs: [], note: "Handshake redirected to its sign-in page." };
  }

  const cards = Array.from(document.querySelectorAll('[data-hook^="job-result-card |"]'));
  if (!cards.length) {
    const signIn = document.querySelector('form[action*="sign_in"], input[type="password"]');
    // ⚠ "NO CARDS" AND "NO RESULTS" ARE DIFFERENT ANSWERS, and conflating them sent the
    // operator to run recon over a scraper that was working perfectly: a narrow derived
    // search ("Robotics Lab intern" + the internship filter) simply has no matches, and
    // that got reported as "the layout may have changed". Handshake states the count
    // itself in a hook we already traced, so read it and say which.
    const announced = txt(document.querySelector('[data-hook="job-search-results-status-announcer"]'));
    const zero = /\b0\s+jobs?\s+found\b/i.test(announced) || /no jobs found|no results/i.test(announced) ||
      /no jobs found|no results/i.test((document.body && document.body.innerText) || "");
    if (zero && !signIn) {
      return { signedIn: true, jobs: [], note: "no results for this search (Handshake reported " + (announced || "0 jobs found") + ").", empty: true };
    }
    // Handshake renders "Something went wrong. Please try again." for an INVALID
    // search param (e.g. an unknown `sort` value) — a distinct failure from an
    // empty result set, and one the caller can actually act on.
    const broke = /Something went wrong/i.test((document.body && document.body.innerText) || "");
    return {
      signedIn: !signIn,
      jobs: [],
      note: signIn
        ? "Handshake is showing its sign-in page."
        : broke
          ? "Handshake rejected the search (its \"Something went wrong\" page) — usually an unsupported search parameter."
          : "No job cards found on the Handshake results page — no [data-hook^=\"job-result-card |\"] nodes. Run Discover recon.",
    };
  }

  const jobs = [];
  const seen = new Set();
  for (const card of cards) {
    const id = ((card.getAttribute("data-hook") || "").split("|")[1] || "").trim();
    if (!/^\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);

    const a = card.querySelector('a[href*="/job-search/"], a[href*="/jobs/"]');
    const aria = ((a && a.getAttribute("aria-label")) || "").replace(/^\s*Selected,\s*/i, "").trim();
    const footer = txt(card.querySelector('[data-hook="job-result-card-footer"]'));
    const body = txt(card);

    // The card's text lines are the reliable split: employer, then title.
    const lines = (card.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
    const company = lines[0] || "";
    const title = lines[1] || "";

    // The footer is "«Promoted ∙» «location ∙» «age»" — its LAST segment is the age
    // ("New", "6d ago", "2wk ago"); "New" is Handshake's own "just posted" badge.
    const segs = footer.split(/[∙·]/).map((s) => s.trim()).filter(Boolean);
    const last = segs.length ? segs[segs.length - 1] : "";
    const age = /ago|new/i.test(last) ? last : "";
    const loc = segs.filter((s) => s !== last && !/^promoted$/i.test(s)).join(", ");

    // ── PAY + TERM, AS HANDSHAKE ITSELF FORMATS THEM ────────────────────────
    // Read from the card, NOT reconstructed from the record's raw numbers. That
    // reconstruction was wrong three different ways (traced 2026-07-30): the record's
    // `salary` is in CENTS (3000 for a card reading "$30-50/hr"), `salary_type_name`
    // is "Paid"/"Unpaid" rather than a unit — it was being used as one, producing
    // "$3000/hr" and "$50K/mo" — and "Unpaid", which the card states plainly and which
    // matters a lot to a student, was dropped entirely. The card is already correct.
    const payText =
      (body.match(/\$[\d,.]+\s*(?:-\s*\$?[\d,.]+)?\s*\/\s*(?:hr|hour|mo|month|wk|week|yr|year)/i) || [])[0] ||
      (body.match(/\$[\d,.]+\s*(?:K|k)?\s*\/\s*(?:hr|mo|wk|yr)/i) || [])[0] ||
      (/\bunpaid\b/i.test(body) ? "Unpaid" : "");
    // "Aug 14—Dec 14" / "Jul 31—Dec 31" — an em-dash range of two month-day pairs.
    const termText = (body.match(/([A-Z][a-z]{2}\s+\d{1,2})\s*[—–-]\s*([A-Z][a-z]{2}\s+\d{1,2})/) || []);

    jobs.push({
      // /jobs/<id> is the canonical posting page; discoveryJobKey collapses it and
      // the /job-search/<id> search route to the same key.
      url: "https://app.joinhandshake.com/jobs/" + id,
      pay: (payText || "").replace(/\s+/g, ""),
      startDate: termText[1] || "",
      endDate: termText[2] || "",
      title: (title || aria).slice(0, 300),
      company: company.slice(0, 200),
      location: (loc || "").slice(0, 200),
      postedAt: /new/i.test(age) ? "today" : age,
      postedText: age,
      promoted: /\bPromoted\b/i.test(footer) || /\bPromoted\b/i.test(body),
      description: "",
    });
  }
  return { signedIn: true, jobs, note: "" };
}

// ── The board JSON readers (injected; run IN the signed-in page) ─────────────
//
// Both boards expose the JSON their own front-end runs on, and reading THAT
// instead of the rendered DOM is what makes this sweep robust: exact posted
// timestamps, the employer's real application url, the full JD, and the applicant
// count — none of which survive being painted into hashed-class markup.
//
// Runs in the PAGE so the request is same-origin and carries the operator's own
// session cookies; nothing here handles credentials. LinkedIn additionally wants
// its CSRF token, which is literally the JSESSIONID cookie value.
//
// ⚠ NO setTimeout ANYWHERE IN HERE. Chrome throttles page TIMERS in a background
// tab (~1Hz) but not fetch, so a batch of awaited fetches with no sleeps runs at
// full speed hidden — which is why the pacing between batches lives in the service
// worker instead (see discoverApiBatch).
async function discoverApiFetch(urls, kind) {
  const csrf = (document.cookie.match(/JSESSIONID="?([^";]+)"?/) || [])[1] || "";
  const headers = { accept: "application/json" };
  if (csrf) {
    headers["csrf-token"] = csrf;
    headers["x-restli-protocol-version"] = "2.0.0";
  }

  // Prune to the fields the pure adapters read, PRESERVING the payload's own
  // shape (so linkedInDetailToPatch/handshakeDetailToPatch stay testable against
  // real records). This is key-selection only — no logic — and it keeps a 27KB
  // LinkedIn record or a 123KB Handshake record from crossing the boundary whole.
  const prune = (kind_, j) => {
    if (!j || typeof j !== "object") return j;
    if (kind_ === "linkedin-search") {
      const els = Array.isArray(j.elements) ? j.elements : [];
      return {
        paging: j.paging ? { total: j.paging.total, start: j.paging.start, count: j.paging.count } : null,
        elements: els.map((e) => {
          const c = (e && e.jobCardUnion && e.jobCardUnion.jobPostingCard) || null;
          if (!c) return {};
          return {
            jobCardUnion: {
              jobPostingCard: {
                jobPostingUrn: c.jobPostingUrn || c.entityUrn || "",
                title: { text: (c.title || {}).text || c.jobPostingTitle || "" },
                primaryDescription: { text: (c.primaryDescription || {}).text || "" },
                secondaryDescription: { text: (c.secondaryDescription || {}).text || "" },
                footerItems: (Array.isArray(c.footerItems) ? c.footerItems : []).map((f) => ({
                  type: f && f.type, timeAt: f && f.timeAt,
                  text: { text: ((f && f.text) || {}).text || "" },
                })),
              },
            },
          };
        }),
      };
    }
    if (kind_ === "linkedin-detail") {
      const cd = (j.companyDetails || {})["com.linkedin.voyager.deco.jobs.web.shared.WebJobPostingCompany"];
      return {
        title: j.title, formattedLocation: j.formattedLocation,
        listedAt: j.listedAt, originalListedAt: j.originalListedAt,
        expireAt: j.expireAt, workRemoteAllowed: j.workRemoteAllowed,
        jobState: j.jobState, closed: j.closed,
        applyMethod: j.applyMethod,
        description: { text: ((j.description || {}).text || "").slice(0, 20000) },
        applies: j.applies, formattedEmploymentStatus: j.formattedEmploymentStatus,
        companyDetails: cd
          ? { "com.linkedin.voyager.deco.jobs.web.shared.WebJobPostingCompany":
              { companyResolutionResult: { name: ((cd.companyResolutionResult || {}).name) || "" } } }
          : undefined,
      };
    }
    if (kind_ === "handshake-detail") {
      const b = j.job || {};
      return {
        job: {
          id: b.id, title: b.title,
          text_description: String(b.text_description || "").slice(0, 20000),
          employer_name: b.employer_name, fancy_employer_name: b.fancy_employer_name,
          location_names: b.location_names,
          created_at: b.created_at, apply_start: b.apply_start,
          // The AUTHORITATIVE apply config — see handshakeDetailToPatch for why the
          // `external_apply_link` pair below it cannot be trusted on its own.
          job_apply_setting: b.job_apply_setting ? {
            apply_type: (b.job_apply_setting || {}).apply_type,
            external_url: (b.job_apply_setting || {}).external_url,
            external_apply_type: (b.job_apply_setting || {}).external_apply_type,
            additional_instructions: (b.job_apply_setting || {}).additional_instructions,
          } : undefined,
          use_external_apply_link: b.use_external_apply_link,
          external_apply_link: b.external_apply_link,
          applications_count: b.applications_count,
          archived: b.archived, hidden: b.hidden, is_postable: b.is_postable,
          job_type: b.job_type ? { name: (b.job_type || {}).name } : undefined,
          job_type_name: b.job_type_name,
          salary_type_name: b.salary_type_name,
          salary_type: b.salary_type ? { name: (b.salary_type || {}).name } : undefined,
          salary_min_raw: b.salary_min_raw, salary_max_raw: b.salary_max_raw,
          pay_schedule: b.pay_schedule ? { name: (b.pay_schedule || {}).name } : undefined,
          start_date: b.start_date, end_date: b.end_date,
          expiration_date: b.expiration_date, default_expiration_date: b.default_expiration_date,
          remote: b.remote, on_site: b.on_site, hybrid: b.hybrid,
          promoted_job: b.promoted_job, premium_job: b.premium_job,
        },
      };
    }
    return j;
  };

  const out = [];
  for (const u of urls || []) {
    try {
      const r = await fetch(u, { credentials: "include", headers, cache: "no-store" });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { /* an HTML error page, not JSON */ }
      out.push({
        url: u,
        ok: r.status === 200 && json != null,
        status: r.status,
        json: json ? prune(kind, json) : null,
      });
    } catch (e) {
      out.push({ url: u, ok: false, status: 0, json: null, error: String((e && e.message) || e) });
    }
  }
  return out;
}

// ── The location resolver (injected, ONE STEP PER CALL) ──────────────────────
//
// Neither board's location token can be constructed: LinkedIn needs a numeric
// geoId (its API returns HTTP 500 for a plain place name) and Handshake needs a
// JSON place blob with a Mapbox-style id and lat/lon. Both are produced ONLY by
// that board's own location typeahead — LinkedIn's runs through an opaque RSC
// server action with build-specific ids, so it cannot be called directly either.
//
// So we do exactly what a person does: open the location control, type, pick the
// first suggestion, and read the token the board then puts in its own URL.
//
// SPLIT INTO STEPS on purpose: every wait then happens in the SERVICE WORKER on
// wall-clock, never in a page timer, so this works identically in a background
// tab (where page timers are throttled to ~1Hz). Each call returns immediately.
// ⚠ IT ONLY RETURNS RECTS — IT NEVER CLICKS OR TYPES. The actual input is
// dispatched by the caller through CDP (trusted `Input.*`), because SYNTHETIC
// EVENTS DO NOT WORK ON THIS CONTROL. Verified live against LinkedIn's location
// pill (2026-07-30): `el.click()`, a full pointerdown→mousedown→pointerup→mouseup→
// click sequence WITH pointerId/isPrimary/detail, Enter-on-focus, and clicking the
// inner child ALL left the panel closed. Same lesson CLAUDE.md already records for
// the Workday auth form — some surfaces only register trusted events — so this
// follows the established remedy rather than inventing a new one.
//
// Split into rect-returning STEPS so every wait happens in the service worker on
// wall clock, never a page timer: that is what makes it work identically in a
// background tab, and trusted CDP input needs no paint either.
function discoverLocationStep(step, arg) {
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
  };
  // ⚠ RENDERED-ness ONLY — do NOT also require "inside the viewport".
  // An earlier version did, and it made the whole resolver fail in the very place it
  // has to work: a BACKGROUND tab, whose `window.innerHeight` can be 0 (or a stale
  // size) because it has never been presented. Every element then fails a
  // `bottom <= innerHeight` test, so the location control read as "not found" while
  // being perfectly present — and the sweep fell back to the board's own default
  // location. Viewport-containment is instead ARRANGED, not asserted: the rect steps
  // scroll the target into view and re-measure, so the coordinates handed to the
  // trusted click are in-viewport by construction (the same recipe cdpSourceRowRect
  // uses for out-of-view listbox rows).
  const vis = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  // Bring an element into view, then measure it. Returns a viewport-relative rect.
  const rectInView = (el) => {
    try { el.scrollIntoView({ block: "center", inline: "nearest" }); } catch (e) { /* non-fatal */ }
    return rectOf(el);
  };

  // Chips that are definitely NOT the location control, on either board. Matching
  // by exclusion is safer here than by inclusion: the location chip's label is
  // whatever place is currently selected, so it has no fixed text to match.
  const NOT_LOCATION = /^(jobs|past \d+ \w+|past week|easy apply|experience level|employment type|company|in my network|under \d+ applicants|full-time job|internship|part time|filters|sort by|save|share|apply|quick apply|more|see all|clear|done|remote|automotive|robotics|semiconductor|firmware|research & development|cmu collections)$/i;

  const isInJobCard = (el) =>
    !!(el.closest && (el.closest('[componentkey^="job-card-component-ref-"]') || el.closest('[data-hook^="job-result-card |"]')));

  const findOpener = () => {
    // The filter strip lives at the TOP of the document; scroll there so "near the top"
    // is a meaningful test even if a previous step scrolled the list.
    try { window.scrollTo(0, 0); } catch (e) { /* non-fatal */ }
    const cands = Array.from(document.querySelectorAll('button, [role="button"], a[role="button"]')).filter((b) => {
      if (!vis(b) || isInJobCard(b)) return false;          // never a job card (it would OPEN a posting)
      const t = (b.innerText || "").trim();
      if (!t || t.length > 40 || NOT_LOCATION.test(t)) return false;
      // The control lives in the filter/header strip, not down the results list.
      return b.getBoundingClientRect().top < 400;
    });
    // Prefer an explicit "Location" label / aria, else a place-shaped label.
    return (
      cands.find((b) => /^location$/i.test((b.innerText || "").trim())) ||
      cands.find((b) => /location/i.test(b.getAttribute("aria-label") || "")) ||
      cands.find((b) => /,|united states|worldwide|metropolitan|remote/i.test((b.innerText || "").trim())) ||
      null
    );
  };

  // The panel's text box.
  //
  // ⚠ ON LINKEDIN IT IS NOT AN <input> AT ALL. Traced 2026-07-30: the panel renders
  //     <div componentkey="LocationTypeahead_TextEditor" contenteditable="true"
  //          role="textbox">United States</div>
  // so every `querySelectorAll('input')` strategy found nothing while the box was
  // plainly open on screen — which is exactly how this failed the first time.
  // Handshake's IS a real <input placeholder="Search by city, state, or zip code">.
  // Both are handled, semantic key first.
  // ⚠ POSITIVE IDENTIFICATION ONLY — never "the first input that isn't the keyword box".
  //
  // That fallback caused the worst bug in this resolver: on Handshake the location panel
  // is `display:none` until opened, so no location box is visible, and the fallback
  // happily returned the KEYWORD box instead. The resolver then typed "Pittsburgh,
  // Pennsylvania" into the job-search field, matched a job suggestion, clicked it, and
  // reported `location-token-never-appeared` — a completely wrong action that looked
  // like a timing failure. (It slipped past an exclusion list too, because the regex
  // said "describe the job" and Handshake's placeholder is "Describe A job you want".)
  //
  // Both boards CAN be matched positively, so require that and return null otherwise —
  // a null correctly means "the panel isn't open yet", which makes the caller click to
  // open it instead of typing into whatever happened to be lying around.
  const LOCATION_HINT = /city|state|zip|postal|location|where/i;
  const KEYWORD_HINT = /describe\s+(a|the)\s+job|search jobs|job title|keyword|what.*looking for/i;
  const findInput = () => {
    // LinkedIn: a contenteditable div with a stable semantic key (no placeholder at all).
    const li = document.querySelector('[componentkey="LocationTypeahead_TextEditor"]');
    if (li && vis(li)) return li;
    // Handshake + anything conventional: a real input that SAYS it takes a place.
    const hintOf = (el) => (el.getAttribute("placeholder") || "") + " " + (el.getAttribute("aria-label") || "");
    const byHint = Array.from(document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])'))
      .filter((i) => vis(i) && LOCATION_HINT.test(hintOf(i)) && !KEYWORD_HINT.test(hintOf(i)));
    if (byHint.length) return byHint[0];
    // A generic contenteditable textbox, as long as it isn't the keyword box.
    const editable = Array.from(document.querySelectorAll('[contenteditable="true"][role="textbox"], [contenteditable=""][role="textbox"]'))
      .filter((e) => vis(e) && !KEYWORD_HINT.test(hintOf(e)) && (e.getAttribute("componentkey") || "") !== "semanticSearchBox");
    return editable[0] || null;
  };

  // Only ever accept a CLICKABLE row element. The suggestion text is wrapped several
  // levels deep (…<a><div><p><span>Seattle, Washington…), and the click has to land
  // on the row that carries the handler — so restricting the selector to row-ish tags
  // both finds the right node and de-dupes the nested copies for free.
  const ROW_SEL = 'a, li, [role="option"], [role="button"], button, div[tabindex]';

  const suggestionRows = () => {
    const input = findInput();
    const collect = (root) =>
      Array.from(root.querySelectorAll(ROW_SEL))
        .filter((el) => vis(el) && !isInJobCard(el) && el !== input && !el.contains(input))
        .map((el) => ({ el, t: (el.innerText || "").trim().replace(/\s+/g, " ") }))
        .filter((r) => r.t && r.t.length > 2 && r.t.length < 120);

    // 1. LinkedIn's own suggestion container — semantic and stable. ⚠ Its rows are
    //    <a> elements and carry NO role="option"/"listbox" at all, which is why a
    //    purely role-based scan found zero while five suggestions were on screen.
    for (const el of document.querySelectorAll('[componentkey*="LocationList"], [componentkey*="locationList"]')) {
      const rows = collect(el);
      if (rows.length) return dedupe(rows);
    }
    // 2. A proper a11y listbox, when a board provides one.
    let rows = Array.from(document.querySelectorAll('[role="option"], [role="listbox"] li, ul[role="listbox"] > *'))
      .filter((el) => vis(el) && !isInJobCard(el))
      .map((el) => ({ el, t: (el.innerText || "").trim().replace(/\s+/g, " ") }))
      .filter((r) => r.t && r.t.length > 2 && r.t.length < 120);
    if (rows.length) return dedupe(rows);
    // 3. Generic: walk OUT from the box until an ancestor contains place-shaped rows.
    //    Walking out matters — the suggestion list is a SIBLING subtree of the box,
    //    so the box's nearest div doesn't contain it.
    let node = input;
    for (let up = 0; up < 6 && node; up++) {
      node = node.parentElement;
      if (!node) break;
      const found = collect(node).filter((r) => /,|united states|remote|metropolitan|worldwide|area$/i.test(r.t));
      if (found.length) return dedupe(found);
    }
    return [];
  };
  function dedupe(rows) {
    // Same text can appear on a row AND an inner wrapper that also matched ROW_SEL;
    // keep the first (outermost in document order).
    const seen = new Set();
    return rows.filter((r) => (seen.has(r.t) ? false : (seen.add(r.t), true)));
  }

  try {
    if (step === "openerRect") {
      const vp = { w: window.innerWidth, h: window.innerHeight };
      const b = findOpener();
      if (!b) {
        // Report the buttons that WERE visible in the filter strip — that is what
        // distinguishes "the page isn't up" from "my matcher is wrong".
        const nearby = Array.from(document.querySelectorAll('button, [role="button"]'))
          .filter((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.top < 400; })
          .map((x) => (x.innerText || "").trim().slice(0, 24)).filter(Boolean).slice(0, 12);
        return { ok: false, error: "location-control-not-found", viewport: vp, nearby };
      }
      return { ok: true, rect: rectInView(b), label: (b.innerText || "").trim().slice(0, 60), viewport: vp };
    }
    if (step === "inputRect") {
      const i = findInput();
      if (!i) {
        const editables = document.querySelectorAll('[contenteditable="true"], [role="textbox"]').length;
        const inputs = document.querySelectorAll('input[type="text"], input[type="search"]').length;
        return { ok: false, error: "location-input-not-found", viewport: { w: window.innerWidth, h: window.innerHeight }, editables, inputs };
      }
      // A contenteditable has no .value — read its text instead, so the log shows
      // what was actually in the box on both boards.
      const current = i.value !== undefined ? String(i.value) : String(i.innerText || "");
      return { ok: true, rect: rectInView(i), value: current.slice(0, 60), editable: i.value === undefined, placeholder: String(i.getAttribute("placeholder") || "").slice(0, 80) };
    }
    if (step === "suggestions") {
      const rows = suggestionRows();
      return { ok: true, options: rows.slice(0, 8).map((r) => ({ text: r.t, rect: rectInView(r.el) })) };
    }
    if (step === "clear") {
      // Leave the box EMPTY. A board that persists its filters per session (Handshake
      // does) will otherwise keep applying the text we abandoned, and every later
      // search in the sweep returns nothing.
      const i = findInput();
      if (!i) return { ok: true, cleared: false };
      try {
        if (i.value !== undefined) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
          setter.call(i, "");
          i.dispatchEvent(new Event("input", { bubbles: true }));
          i.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          i.textContent = "";
          i.dispatchEvent(new Event("input", { bubbles: true }));
        }
      } catch (e) { return { ok: true, cleared: false, error: String((e && e.message) || e) }; }
      return { ok: true, cleared: true };
    }
    if (step === "read") {
      // Whatever the board decided, read back off its OWN url.
      const p = new URLSearchParams(location.search);
      return { ok: true, url: location.href, geoId: p.get("geoId") || "", locationFilter: p.get("locationFilter") || "" };
    }
    return { ok: false, error: "unknown-step:" + step };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// NOTE — the card-clicking in-page JD reader was REMOVED 2026-07-30.
//
// It clicked each result card and settle-polled the right-hand rail for the
// description, then hunted the rendered DOM for an employer apply link through a
// ladder of guesses. Both jobs are now done by ONE JSON read per posting
// (discoverApiFetch + linkedInDetailToPatch), which is strictly better on every
// axis that matters here:
//   · the apply url is a TYPED field (applyMethod.…OffsiteApply.companyApplyUrl)
//     instead of "the first off-LinkedIn anchor inside an apply-ish container" —
//     the old ladder's last scope was the whole details pane, so it could pick up
//     a link out of the description prose it promised not to read;
//   · Easy-Apply is the union's KEY, not a /easy apply/ text match;
//   · the posted date is an exact epoch, not "3 days ago" parsed backwards;
//   · nothing is clicked, so there is no risk of touching Apply, and no dependence
//     on the pane painting — which is what made the old path unreliable in a
//     background tab (its settle poll ran on page timers, throttled to ~1Hz).
// If the JSON read fails, the job still queues and falls through to
// fillMissingDescriptions, which opens the posting in the ONE reused reader tab.

// GENERIC JOB-POSTING scrape — the "physically open the link, scrape the JD"
// half. Runs on an ARBITRARY employer/ATS page (Workday, Greenhouse, Lever,
// Ashby, Oracle, iCIMS, …), so it is a LADDER of the known description containers
// followed by a largest-text-block fallback, never a single selector. Superset of
// background.js's Workday-only scrapeJobDescription; that one is left untouched
// (it's on the live-verified run path).
function scrapeJobPosting() {
  const txt = (el) => ((el && (el.innerText || el.textContent)) || "").trim();
  const pick = (sels) => {
    for (const s of sels) {
      try {
        const el = document.querySelector(s);
        const t = txt(el);
        if (t) return t;
      } catch (e) { /* skip */ }
    }
    return "";
  };
  const clean = (s) => (s || "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  const titleCase = (s) => clean(s).split(" ").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");

  const title =
    pick([
      '[data-automation-id="jobPostingHeader"]', '[data-automation-id="jobTitle"]',
      "h1.app-title", ".posting-headline h2", "h1.ashby-job-posting-heading",
      '[class*="job-title"]', '[class*="posting-title"]', "h1",
    ]) || (document.title || "").split(/\s[|–—-]\s/)[0].trim();

  let company =
    pick([
      '[data-automation-id="company"]', '[data-automation-id="jobPostingCompany"]',
      ".company-name", '[class*="company-name"]', 'meta[property="og:site_name"]',
    ]) || "";
  if (!company) {
    const og = document.querySelector('meta[property="og:site_name"]');
    if (og) company = (og.getAttribute("content") || "").trim();
  }
  if (!company) {
    const m = (location.hostname || "").match(/^([a-z0-9-]+)\.wd\d+\.myworkday(?:jobs|site)\.com$/i);
    if (m) company = titleCase(m[1]);
  }
  if (!company) {
    // boards.greenhouse.io/<co>/…, jobs.lever.co/<co>/…, jobs.ashbyhq.com/<co>/…
    const pm = (location.pathname || "").match(/^\/([^/]+)\//);
    if (pm && /greenhouse|lever|ashbyhq|myworkdayjobs|myworkdaysite/i.test(location.hostname || "")) {
      company = titleCase(decodeURIComponent(pm[1]));
    }
  }

  let body = pick([
    '[data-automation-id="jobPostingDescription"]', '[data-automation-id="richTextArea"]',
    "#content .job__description", ".job__description", "#job-description",
    '[class*="job-description"]', '[class*="jobDescription"]',
    ".posting-page .section-wrapper", ".ashby-job-posting-content",
    '[data-testid*="description"]', "article", "main",
  ]);

  // Fallback: the largest text block on the page. An SPA that renders its JD into
  // an unrecognized wrapper still yields the description this way; a page that
  // genuinely has no JD yields whatever is longest, which the caller treats as
  // best-effort (a thin/absent JD never blocks queueing the job).
  if (!body || body.length < 200) {
    let best = "";
    const cands = document.querySelectorAll("main, article, section, div");
    for (let i = 0; i < cands.length && i < 4000; i++) {
      const t = txt(cands[i]);
      if (t.length > best.length && t.length < 60000) best = t;
    }
    if (best.length > body.length) body = best;
  }

  // The EMPLOYER's application link, when this page is itself a board wrapper
  // (Handshake's posting page links out to the real ATS). Scoped to apply-ish
  // controls and off-host only — never harvested from the description prose, which
  // routinely contains unrelated company links.
  let applyUrl = "";
  let applyVia = "";
  try {
    const here = location.hostname.replace(/^www\./, "").toLowerCase();
    const SCOPES = [
      '[class*="apply"]', '[data-hook*="apply"]', '[id*="apply"]',
      "main", "body",
    ];
    for (const scope of SCOPES) {
      const root = document.querySelector(scope);
      if (!root) continue;
      for (const a of root.querySelectorAll('a[href^="http"]')) {
        const label = (((a.innerText || a.textContent) || "") + " " + (a.getAttribute("aria-label") || "")).toLowerCase();
        if (!/apply/.test(label)) continue;
        let host = "";
        try { host = new URL(a.href).hostname.replace(/^www\./, "").toLowerCase(); } catch (e) { continue; }
        if (host && host !== here && !host.endsWith("." + here)) {
          applyUrl = a.href;
          applyVia = scope + " a(apply)";
          break;
        }
      }
      if (applyUrl) break;
    }
  } catch (e) { /* best-effort — a missing apply link is never fatal */ }

  return {
    title: (title || "").slice(0, 300),
    company: (company || "").slice(0, 200),
    text: (body || "").replace(/\n{3,}/g, "\n\n").slice(0, 20000),
    url: location.href,
    applyUrl,
    applyVia,
  };
}

// Is this a job-BOARD url (a wrapper around someone else's application) rather
// than an employer/ATS url? Only a board url is worth rewriting to a real link —
// a Workday/Greenhouse link IS already the real thing.
function isBoardUrl(u) {
  try {
    const h = new URL(String(u)).hostname.toLowerCase();
    return /(^|\.)linkedin\.com$/.test(h) || /joinhandshake\.com$/.test(h);
  } catch (e) {
    return false;
  }
}

// RECON dump (read-only). The operator runs this ONCE per source from their real
// signed-in session; it reports what the page actually looks like so the list
// scrapers' selector ladders can be tightened from OBSERVATION rather than the
// structure-first guesses above. Mirrors reconDropdownDump's role for dropdowns.
function dumpDiscoverRecon() {
  const count = (sel) => {
    try { return document.querySelectorAll(sel).length; } catch (e) { return -1; }
  };
  const probes = [
    // ── THE LIVE ANCHORS (traced 2026-07-30). These are the two selectors the
    //    list scrapers actually depend on; if either reads 0 on a signed-in
    //    results page, that source's scraper is broken and nothing else matters.
    '[componentkey^="job-card-component-ref-"]',   // LinkedIn card (carries the job id)
    '[data-hook^="job-result-card |"]',            // Handshake card (carries the job id)
    // Supporting hooks, for confirming the page shape around them.
    "[componentkey]", '[data-component-type="LazyColumn"]', "[data-sdui-screen]",
    '[data-hook="job-result-card-footer"]', '[data-hook="job-search-filters"]',
    '[data-hook="job-search-results-status-announcer"]',
    // ── The PREVIOUS generation of selectors, kept deliberately as a REGRESSION
    //    tripwire: these all read 0 on the 2026-07-30 SDUI LinkedIn page, which is
    //    how the rewrite was discovered. If they start reporting non-zero again,
    //    LinkedIn has rolled back and the old ladders would be viable.
    'a[href*="/jobs/view/"]', "[data-job-id]", "[data-occludable-job-id]",
    "li.jobs-search-results__list-item", "div.job-card-container", ".artdeco-entity-lockup__title",
    "code#applyUrl", '[class*="jobs-apply"]', "#job-details", ".jobs-description__content",
    // Generic shape + the sign-in tell.
    'a[href*="/jobs/"]', 'a[href*="/job-search/"]', '[data-hook*="job"]',
    '[role="listitem"]', "time[datetime]", 'input[type="password"]', "article", "main",
  ];
  const counts = {};
  for (const p of probes) counts[p] = count(p);

  // Every job id the page exposes, from BOTH anchors — the single most useful
  // recon fact: "did we see the cards at all, and how many".
  const ids = { linkedin: [], handshake: [] };
  for (const el of document.querySelectorAll('[componentkey^="job-card-component-ref-"]')) {
    const id = (el.getAttribute("componentkey") || "").replace("job-card-component-ref-", "");
    if (/^\d+$/.test(id) && ids.linkedin.indexOf(id) < 0) ids.linkedin.push(id);
  }
  for (const el of document.querySelectorAll('[data-hook^="job-result-card |"]')) {
    const id = ((el.getAttribute("data-hook") || "").split("|")[1] || "").trim();
    if (/^\d+$/.test(id) && ids.handshake.indexOf(id) < 0) ids.handshake.push(id);
  }

  // One representative card: its markup AND — more useful on a hashed-class page —
  // the text LINES the scrapers actually read fields out of.
  let sample = "";
  let sampleLines = [];
  const card =
    document.querySelector('[data-hook^="job-result-card |"]') ||
    (() => {
      // The richest node for the first LinkedIn id (the attribute repeats on an
      // inner wrapper, and the outer one is the whole card).
      let bestEl = null, bestLen = -1;
      for (const el of document.querySelectorAll('[componentkey^="job-card-component-ref-"]')) {
        const n = ((el.innerText || "") + "").length;
        if (n > bestLen) { bestLen = n; bestEl = el; }
      }
      return bestEl;
    })();
  if (card) {
    sample = (card.outerHTML || "").slice(0, 4000);
    sampleLines = (card.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 12);
  }

  // Which location token this page is carrying, if any — the geo resolver's output
  // and the one search parameter that cannot be constructed by hand.
  const sp = new URLSearchParams(location.search);
  const locationToken = { geoId: sp.get("geoId") || "", locationFilter: (sp.get("locationFilter") || "").slice(0, 300) };

  // Every off-host link that LOOKS like an apply control, with its label — this is
  // exactly what the real-link extractor keys on, so seeing the true shape here is
  // what lets its ladder be tightened from observation instead of guesswork.
  const applyLinks = [];
  try {
    const here = location.hostname.replace(/^www\./, "").toLowerCase();
    for (const a of document.querySelectorAll('a[href^="http"]')) {
      let host = "";
      try { host = new URL(a.href).hostname.replace(/^www\./, "").toLowerCase(); } catch (e) { continue; }
      const label = (((a.innerText || a.textContent) || "").trim() + " " + (a.getAttribute("aria-label") || "")).trim();
      if (host !== here && (/apply/i.test(label) || /externalApply|offsite/i.test(a.href))) {
        applyLinks.push({ host, label: label.slice(0, 80), href: a.href.slice(0, 300) });
        if (applyLinks.length >= 12) break;
      }
    }
  } catch (e) { /* best-effort */ }

  return {
    url: location.href,
    title: document.title || "",
    // readyState + a visibility read matter here: recon must be trustworthy in a
    // BACKGROUND tab (operator 2026-07-30), and "0 cards" on a page that is still
    // loading is a different fact from "0 cards" on a settled one.
    readyState: document.readyState,
    hidden: !!document.hidden,
    visibility: document.visibilityState || "",
    counts,
    cardIds: { linkedin: ids.linkedin.length, handshake: ids.handshake.length },
    cardIdSample: { linkedin: ids.linkedin.slice(0, 8), handshake: ids.handshake.slice(0, 8) },
    locationToken,
    applyLinks,
    sample,
    sampleLines,
    bodyStart: ((document.body && document.body.innerText) || "").replace(/\s+/g, " ").slice(0, 600),
  };
}

// ── Service-worker orchestration (chrome APIs) ──────────────────────────────

// One prefix for every discovery line so the SW console can be filtered to
// `[DISCOVER]` and read as a narrative of the sweep.
function dlog(msg) {
  try { console.log("[ApplyPilot][DISCOVER] " + msg); } catch (e) { /* ignore */ }
}

// Progress → the website's live Run port (background.js owns it). ALSO logged, so
// the SW console and the on-page progress line tell the same story. Defensive: a
// popup-triggered discovery runs before/without any port and must still work.
function discoverProgress(phase, detail) {
  try {
    dlog(`» ${phase}${detail ? " — " + detail : ""}`);
    if (typeof emitRunProgress === "function") emitRunProgress(phase, detail);
  } catch (e) { /* never let telemetry break a sweep */ }
}

// A stable, readable one-liner for a job in the log. Used at every stage so the
// same job is recognisable as it moves through discovery → JD read → queue.
function jobLine(job) {
  const co = job.company || "?";
  const title = job.title || "?";
  const when = job.postedAt == null ? "date?" : `${Math.max(0, Math.round((Date.now() - job.postedAt) / 86400e3))}d`;
  return `${co} — ${title} [${when}] ${job.jobKey}`;
}

const discoverDelay = (ms) => new Promise((r) => setTimeout(r, ms));

// Open a tab, run `work(tabId)`, and ALWAYS close the tab. `background:true`
// opens it unfocused so a sweep doesn't steal the operator's window. The close is
// in a finally — a thrown scraper can never leak a tab (the "physically open the
// link … and close it" contract).
async function withDiscoverTab(url, opts, work) {
  const o = opts || {};
  const tab = await new Promise((res) => chrome.tabs.create({ url, active: o.background === false }, res));
  if (!tab || tab.id === undefined) throw new Error("could not open a tab for " + url);
  const tabId = tab.id;
  try {
    await waitTabComplete(tabId, o.loadTimeoutMs || 25000);
    await discoverDelay(o.settleMs || 2000); // SPA hydration beat — these are all React apps
    return await work(tabId);
  } finally {
    try { await new Promise((r) => chrome.tabs.remove(tabId, () => { void chrome.runtime.lastError; r(); })); }
    catch (e) { /* already gone */ }
  }
}

// Read a page by injecting `fn`. Two substrates, cheapest first:
//   1. chrome.scripting — for hosts in manifest host_permissions (linkedin,
//      handshake). Light, no infobar.
//   2. chrome.debugger (CDP) — for ARBITRARY employer/ATS hosts, which we
//      deliberately do NOT take blanket host permissions for. chrome.debugger is
//      not host-gated (the documented invariant CLAUDE.md relies on for the
//      Workday walk), so this reads any posting without an <all_urls> grab. It
//      costs Chrome's "started debugging" infobar for the moment the tab is open.
//
// ⚠ cdp.js tracks ONE attached tab in a module-level cdpTabId, so a CDP read here
// would clobber a concurrently-running fill walk. background.js enforces mutual
// exclusion between discovery and a run; this function assumes that guard holds.
// `opts.keepAttach` — the caller owns the CDP attach lifecycle. Used by the
// single-tab JD pass so ONE attach covers every navigation instead of N
// attach/detach cycles (each of which flashes Chrome's debugging infobar).
async function discoverReadPage(tabId, fn, args, opts) {
  const argv = args || [];
  const keep = !!(opts && opts.keepAttach);
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId }, func: fn, args: argv });
    const value = results && results[0] ? results[0].result : undefined;
    if (value !== undefined) return value;
  } catch (e) {
    // No host permission for this origin (the common case for employer ATS
    // pages) — fall through to CDP.
  }
  if (keep && cdpAttachedTab() === tabId) return await cdpEval(fn, ...argv);
  const att = await cdpAttach(tabId);
  if (!att || !att.ok) throw new Error("cdp attach failed: " + ((att && att.error) || "unknown"));
  try {
    return await cdpEval(fn, ...argv);
  } finally {
    if (!keep) await cdpDetach();
  }
}

// Nudge a lazy/virtualized results list into mounting more rows. LinkedIn and
// Handshake both mount ~a screenful at a time. Bounded, and every round is
// followed by a settle — we re-scrape AFTER scrolling, so a round that mounts
// nothing only costs the delay.
async function discoverAutoScroll(tabId, rounds) {
  const n = Math.max(0, Math.min(Number(rounds) || 0, 12));
  for (let i = 0; i < n; i++) {
    try {
      await discoverReadPage(tabId, () => {
        // Scroll the tallest scrollable container (the results pane), plus the
        // window — LinkedIn scrolls an inner pane, Handshake scrolls the page.
        let best = null;
        const all = document.querySelectorAll("div, main, section, ul");
        for (let i = 0; i < all.length && i < 3000; i++) {
          const el = all[i];
          if (el.scrollHeight > el.clientHeight + 200 && el.clientHeight > 200) {
            if (!best || el.scrollHeight > best.scrollHeight) best = el;
          }
        }
        if (best) best.scrollTop = best.scrollHeight;
        window.scrollTo(0, document.body.scrollHeight);
        return true;
      });
    } catch (e) { break; }
    await discoverDelay(900);
  }
}

// SOURCE 1 — the Simplify board. No tab: a plain fetch of the published feed.
async function discoverFromSimplify(opts) {
  const o = opts || {};
  discoverProgress("Checking the Simplify 2026 internship board");
  let listings;
  try {
    const res = await fetch(DISCOVER_SIMPLIFY_URL, { cache: "no-store" });
    if (!res.ok) return { jobs: [], note: `Simplify board returned HTTP ${res.status}.`, scanned: 0 };
    const text = await res.text();
    if (text.length > 40 * 1024 * 1024) return { jobs: [], note: "Simplify feed was implausibly large — skipped.", scanned: 0 };
    listings = JSON.parse(text);
  } catch (e) {
    return { jobs: [], note: "Couldn't read the Simplify board: " + String((e && e.message) || e), scanned: 0 };
  }
  const total = Array.isArray(listings) ? listings.length : 0;
  dlog(`simplify: feed has ${total} listings; filtering to live + "${o.termPattern || "any term"}" + last ${o.sinceDays}d + "${o.keywords || "any keywords"}"`);
  const jobs = simplifyListingsToJobs(listings, {
    nowMs: o.nowMs,
    sinceDays: o.sinceDays,
    keywords: o.keywords,
    location: o.location,
    termPattern: o.termPattern,
    maxItems: o.maxPerSource,
  });
  dlog(`simplify: ${jobs.length} match${jobs.length === 1 ? "" : "es"}`);
  for (let i = 0; i < jobs.length; i++) dlog(`  ${String(i + 1).padStart(2, "0")}. ${jobLine(jobs[i])}`);
  return { jobs, note: "", scanned: total };
}

// ── Shared board plumbing ───────────────────────────────────────────────────

// Run a batch of same-origin JSON reads inside the board's own tab, PACED here.
//
// The pacing is deliberately SERVICE-WORKER side (wall clock) rather than a sleep
// inside the injected function: Chrome throttles page timers to ~1Hz in a
// background tab, so an in-page sleep would make a hidden sweep ~10× slower and
// visibility-dependent. The fetches themselves aren't throttled, so a small batch
// runs at full speed either way. (CLAUDE.md's standing rule: never let a wait
// depend on a page timer.)
async function discoverApiBatch(tabId, urls, kind, opts) {
  const o = opts || {};
  const chunk = Math.max(1, Number(o.chunk) || 5);
  const gap = Number(o.gapMs != null ? o.gapMs : 350);
  const out = [];
  for (let i = 0; i < urls.length; i += chunk) {
    const slice = urls.slice(i, i + chunk);
    let res;
    try {
      res = await discoverReadPage(tabId, discoverApiFetch, [slice, kind], { keepAttach: true });
    } catch (e) {
      res = slice.map((u) => ({ url: u, ok: false, status: 0, json: null, error: String((e && e.message) || e) }));
    }
    for (const r of Array.isArray(res) ? res : []) out.push(r);
    if (i + chunk < urls.length) await discoverDelay(gap);
  }
  return out;
}

// ── The location resolver ───────────────────────────────────────────────────
//
// Free text in, the board's own opaque location token out. See discoverLocationStep
// for WHY this has to drive the real dropdown (neither token is constructible, and
// LinkedIn's typeahead is an opaque RSC server action). Resolved ONCE per
// (board, text) and cached, so the cost is paid on a location's first use only.
const DISCOVER_GEO_CACHE_KEY = "discoverGeoCache";

async function loadGeoCache() {
  try {
    const got = await chrome.storage.local.get(DISCOVER_GEO_CACHE_KEY);
    const c = got && got[DISCOVER_GEO_CACHE_KEY];
    return c && typeof c === "object" ? c : {};
  } catch (e) { return {}; }
}

async function saveGeoToCache(source, text, token) {
  try {
    const cache = await loadGeoCache();
    cache[geoCacheKey(source, text)] = { ...token, at: Date.now() };
    await chrome.storage.local.set({ [DISCOVER_GEO_CACHE_KEY]: cache });
  } catch (e) { /* a cache miss next time is the only cost */ }
}

// Remember a FAILED resolve so the next sweep doesn't pay for it again (see the
// negative-cache read in boardLocationToken). Driving a board's location dropdown
// is the most expensive thing in a sweep and a failure costs the full budget, so
// repeating it every run is what pushed a multi-search sweep past the point where
// the page had given up waiting. Stored with the reason + a timestamp and only
// honoured for a day, so a transient failure self-heals tomorrow.
async function saveGeoFailure(source, text, error) {
  try {
    const cache = await loadGeoCache();
    cache[geoCacheKey(source, text)] = { failed: true, error: String(error || "unknown"), at: Date.now() };
    await chrome.storage.local.set({ [DISCOVER_GEO_CACHE_KEY]: cache });
  } catch (e) { /* paying it again is the only cost */ }
}

// Drives the board's real location box with TRUSTED CDP input. Every wait is
// service-worker wall clock and every read is one instantaneous injection, so this
// behaves the same in a background tab; trusted `Input.*` needs no paint either.
//
// It must be CDP: see discoverLocationStep for the live evidence that synthetic
// events (including a full pointer sequence) do not open LinkedIn's location panel.
// Discovery never enables cdp.js's synthetic-input mode, so cdpClickAt/cdpInsertText
// here are the trusted implementations.
async function resolveBoardLocation(tabId, source, text) {
  const want = String(text || "").trim();
  if (!want) return { ok: false, error: "no-location-text" };

  // The resolver needs a CDP attach for trusted input. Reuse the caller's if it has
  // one; otherwise attach and give it back exactly as we found it.
  const hadAttach = cdpAttachedTab() === tabId;
  if (!hadAttach) {
    const att = await cdpAttach(tabId);
    if (!att || !att.ok) return { ok: false, error: "cdp-attach-failed:" + ((att && att.error) || "unknown") };
  }

  // ── MAKE A HIDDEN TAB BEHAVE, RATHER THAN DEMANDING REAL FOCUS ──────────────
  // Measured: with none of this, an identical trusted click at identical coordinates
  // opens the panel in a FOREGROUND tab every time and NEVER in a background one — the
  // click is delivered and acked, but the panel never mounts. The reveal defers on
  // rAF/timers, which Chrome pauses (rAF) and throttles to ~1Hz (timers) in a tab that
  // has never been presented. Requiring real focus is not acceptable (the whole sweep
  // has to run unattended), so instead apply the three levers this codebase already
  // uses for exactly this class of hidden-tab stall:
  //   · cdpInstallPageOverrides — routes the page's setTimeout/setInterval/rAF through
  //     a blob Web Worker whose timers ESCAPE background throttling (+ Page.setBypassCSP
  //     first, since a CSP that blocks the blob worker silently defeats it);
  //   · cdpWakePage             — Page.setWebLifecycleState('active'), unfreezes a
  //     tab Chrome has frozen outright;
  //   · cdpSetFocusEmulation    — Emulation.setFocusEmulationEnabled, which makes the
  //     page behave as focused+active and keeps it REPAINTING. This is documented in
  //     cdp.js as the independent lever for a reveal that defers on rAF.
  // None of these touch real window focus, so nothing the operator is doing is
  // disturbed, and cdpVisible's pacing sampler reads chrome.tabs (not page state) so
  // adaptive pacing stays honest.
  try { await cdpInstallPageOverrides(); } catch (e) { /* best-effort */ }
  await cdpWakePage();
  const focusEmulated = await cdpSetFocusEmulation(true);
  if (!focusEmulated) dlog(`${source}: focus emulation unavailable on this Chrome — the location panel may not open hidden`);
  const read = async (s, arg) => {
    try { return await cdpEval(discoverLocationStep, s, arg); }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  };

  // Diagnostics travel back in the RESULT, not just the SW log: this resolver runs in
  // an unfocused tab on a page nobody is watching, and "could-not-open-location-control"
  // on its own is unactionable — it can't distinguish "no control found" from "clicked
  // but nothing opened" from "opened but the box wasn't recognised".
  const diag = { attempts: 0, openerFound: false, openerLabel: "", clicked: false, inputFound: false, viewport: null, lastError: "" };

  try {
    // 1. Open the panel: ONE trusted click on the location control, then POLL.
    //
    // ⚠ THE CONTROL IS A TOGGLE — NEVER RE-CLICK IT BLIND. The first version clicked,
    // waited a flat 500ms, checked once, and looped. Live diagnostics showed exactly
    // what that does: `control found ("Seattle, WA (50 mi)"), clicked yes, box NOT
    // found` on every one of 8 attempts — the panel needs longer than 500ms to mount,
    // so attempt 1 checked too early and attempt 2's click CLOSED the panel it had
    // just opened, alternating open/shut forever. Same invariant CLAUDE.md records for
    // Workday dropdowns ("never re-click an expanded trigger").
    // So: check whether it is ALREADY open before clicking, click at most once per
    // round, and then poll for the box instead of guessing how long it takes.
    let opened = null;
    for (let round = 0; round < 2 && !opened; round++) {
      diag.attempts = round + 1;

      // Already open (e.g. the previous round's click landed late)? Don't touch it.
      let inp = await read("inputRect");
      if (inp && inp.ok) {
        // Already open — the control was obviously present, so don't later report it
        // as "NOT found" just because this round never needed to look for it.
        diag.openerFound = true;
        diag.alreadyOpen = true;
      }
      if (!(inp && inp.ok)) {
        const o = await read("openerRect");
        if (o && o.ok && o.rect && o.rect.w > 0) {
          diag.openerFound = true;
          diag.openerLabel = o.label || "";
          diag.viewport = o.viewport || diag.viewport;
          await cdpClickAt(o.rect.x, o.rect.y);
          diag.clicked = true;
        } else {
          diag.lastError = (o && o.error) || "opener-read-failed";
          diag.viewport = (o && o.viewport) || diag.viewport;
          if (o && o.nearby && o.nearby.length) diag.nearby = o.nearby;
          await discoverDelay(700);
          continue;
        }
        // Poll for the box — up to ~6s, which a hidden tab can genuinely need. Wake
        // the page each tick: a backgrounded tab can be re-frozen between reads, and a
        // frozen page will never mount the panel however long we wait.
        for (let i = 0; i < 8 && !(inp && inp.ok); i++) {
          await discoverDelay(500);
          await cdpWakePage();
          inp = await read("inputRect");
        }
      }
      if (inp && inp.ok) { diag.inputFound = true; diag.placeholder = inp.placeholder || ""; opened = { control: diag.openerLabel, input: inp }; break; }
      diag.lastError = (inp && inp.error) || "input-read-failed";
    }
    if (!opened) return { ok: false, error: "could-not-open-location-control", diag };

    // 2. Focus the box, clear it, and type — all trusted. The box arrives pre-filled
    //    with the current place on LinkedIn, so the clear is required, not cosmetic.
    await cdpClickAt(opened.input.rect.x, opened.input.rect.y);
    await discoverDelay(200);
    await cdpSelectAllDelete();
    await discoverDelay(150);
    await cdpInsertText(want);

    // 3. Wait for the board's suggestions (its typeahead is the authority on what
    //    "Austin" means — we never invent a place id).
    let options = [];
    for (let i = 0; i < 14; i++) {
      await discoverDelay(300);
      await cdpWakePage();
      const r = await read("suggestions");
      if (r && r.ok && r.options && r.options.length) { options = r.options; break; }
    }
    if (!options.length) return { ok: false, error: "no-location-suggestions", diag };

    // 4. Take the board's OWN top suggestion, with a trusted click on its rect.
    const top = options[0];
    diag.suggestions = options.map((o) => o.text).slice(0, 5);
    diag.picked = top.text;
    diag.pickedRect = top.rect;
    await cdpClickAt(top.rect.x, top.rect.y);

    // 5. Read the token back off the board's own URL (selecting rewrites it).
    for (let i = 0; i < 14; i++) {
      await discoverDelay(400);
      const r = await read("read");
      if (!r || !r.ok) continue;
      if (source === "linkedin" && /^\d+$/.test(r.geoId || "")) {
        return { ok: true, label: top.text, geoId: r.geoId, options: options.map((o) => o.text) };
      }
      if (source === "handshake" && (r.locationFilter || "")) {
        return { ok: true, label: top.text, locationFilter: r.locationFilter, options: options.map((o) => o.text) };
      }
    }
    return { ok: false, error: "location-token-never-appeared", label: top.text, diag };
  } finally {
    // ⚠ LEAVE THE BOX EMPTY on the way out. Handshake persists its filters per
    // SESSION, so an abandoned "United States of America" sitting in its location box
    // kept being applied to every later search in the same sweep — live, a board that
    // had worked minutes earlier returned `scanned 0` three times in a row. Clearing
    // is unconditional: on success the board has already committed the selection, so
    // emptying the text box afterwards costs nothing.
    try { await cdpEval(discoverLocationStep, "clear", ""); } catch (e) { /* page may be gone */ }
    // Put the page back as we found it BEFORE releasing the attach.
    try { await cdpSetFocusEmulation(false); } catch (e) { /* page may be gone */ }
    if (!hadAttach) { try { await cdpDetach(); } catch (e) { /* tab may be gone */ } }
  }
}

/**
 * Simpler forms of a place name to try when the exact string doesn't match.
 *
 * The panel seeds the location from the profile's country, whose canonical value is
 * "United States of America" — and NEITHER board's typeahead matches that (both want
 * "United States"). One unlucky string shouldn't cost the location filter entirely,
 * so a failed exact match falls back through progressively simpler forms. Ordered
 * most-specific first, deduped, and always finite.
 */
function locationVariants(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const out = [raw];
  const add = (v) => { const t = String(v || "").trim(); if (t && out.indexOf(t) < 0) out.push(t); };
  add(raw.replace(/\s+of\s+America\b/i, ""));   // United States of America → United States
  add(raw.replace(/\bU\.?S\.?A?\.?\b/i, "United States"));
  if (raw.indexOf(",") >= 0) {
    const parts = raw.split(",").map((x) => x.trim()).filter(Boolean);
    add(parts.slice(0, 2).join(", "));            // Austin, Texas, United States → Austin, Texas
    add(parts[0]);                                 // …→ Austin
  }
  return out.slice(0, 3);
}

// Cache-first token lookup. A bare number is accepted as an already-resolved
// LinkedIn geoId (so a geoId pasted straight in just works), and a LinkedIn search
// URL is parsed for one.
async function boardLocationToken(tabId, source, text, notes) {
  const want = String(text || "").trim();
  if (!want) return {};
  if (source === "linkedin") {
    if (/^\d+$/.test(want)) return { geoId: want, label: want, from: "typed geoId" };
    const fromUrl = parseLinkedInGeoId(want);
    if (fromUrl) return { geoId: fromUrl, label: want, from: "pasted LinkedIn URL" };
  }
  const cache = await loadGeoCache();
  const hit = cache[geoCacheKey(source, want)];
  if (hit && (hit.geoId || hit.locationFilter)) {
    dlog(`${source}: location "${want}" → cached ${hit.geoId ? "geoId " + hit.geoId : "place " + String(hit.label || "")}`);
    return { ...hit, from: "cache" };
  }
  // ── NEGATIVE cache: remember a FAILED resolve too ──────────────────────────
  // Driving a board's location dropdown is the single most expensive thing in a
  // sweep, and a failure costs the full budget. Without this, a location that board
  // simply can't match was retried at full price on EVERY sweep — live, a Handshake
  // resolve for "United States of America" burned minutes each run and pushed the
  // whole sweep past the point where the page had given up on it. Remembered for a
  // day, so a transient failure still gets another chance tomorrow.
  if (hit && hit.failed && Date.now() - (hit.at || 0) < 86400e3) {
    dlog(`${source}: location "${want}" failed to resolve earlier today (${hit.error || "unknown"}) — not retrying this sweep`);
    if (notes) notes.push(`${source}: "${want}" couldn't be matched on ${source} earlier today, so this sweep searched without a location filter.`);
    return {};
  }
  dlog(`${source}: resolving location "${want}" through ${source}'s own location box (first use)`);
  discoverProgress(`Resolving location on ${source}`, want);
  // Try progressively simpler forms of the place name — the panel seeds the location
  // from the profile's country, whose canonical value ("United States of America")
  // matches NEITHER board's typeahead, and one unlucky string shouldn't cost the
  // location filter entirely. See locationVariants.
  let r = { ok: false, error: "no-location-text" };
  for (const variant of locationVariants(want)) {
    r = await resolveBoardLocation(tabId, source, variant);
    if (r.ok) {
      if (variant !== want) dlog(`${source}: "${want}" matched as "${variant}"`);
      break;
    }
  }
  if (!r.ok) {
    // NEVER silently search somewhere else. A failed resolve is reported and the
    // sweep continues WITHOUT a location filter, which is stated plainly.
    const d = r.diag || {};
    // Distinguish "the board offered nothing for that text" from "the control didn't
    // work". Reaching the box and still getting no token means the typeahead returned no
    // usable suggestion for what was typed — a misspelling, or a place that board doesn't
    // index. That is an answer, not a malfunction, so say so plainly and carry on.
    //
    // ⚠ Do NOT conclude anything about what the board "supports" from this. A previous
    // version of this branch told the operator that Handshake's box "only takes a city,
    // state or ZIP" and therefore couldn't do countries — quoting the box's own
    // placeholder as evidence. That was WRONG, and the operator corrected it: Handshake
    // resolves "United States" perfectly well. The real cause was the keyword-box bug
    // above (the text had been typed into the job-search field, so of course no place
    // matched), and the confident-sounding explanation outlived the bug that produced it.
    // Report the observation, never a theory about the board's capabilities.
    if (d.inputFound && (r.error === "no-location-suggestions" || r.error === "location-token-never-appeared")) {
      await saveGeoFailure(source, want, r.error);
    dlog(`${source}: ${source}'s location box offered no match for "${want}" — searching without a location filter`);
      if (notes) notes.push(`${source}: ${source}'s location box offered no match for "${want}" (check the spelling). Searched without a location filter.`);
      return {};
    }
    const detail =
      `${r.error}` +
      (d.attempts ? ` after ${d.attempts} attempt(s)` : "") +
      `; control ${d.openerFound ? `found ("${d.openerLabel}")` : "NOT found"}` +
      (d.openerFound ? `, clicked ${d.clicked ? "yes" : "no"}, box ${d.inputFound ? "found" : "NOT found"}` : "") +
      (d.viewport ? `, viewport ${d.viewport.w}x${d.viewport.h}` : "") +
      (d.lastError ? `, last: ${d.lastError}` : "") +
      (d.picked ? `, picked "${d.picked}"` : "") +
      (d.suggestions && d.suggestions.length ? `, offered: ${d.suggestions.join(" | ")}` : "") +
      (d.nearby && d.nearby.length ? `, saw: ${d.nearby.join(" | ")}` : "");
    await saveGeoFailure(source, want, r.error);
    dlog(`${source}: could not resolve "${want}" — ${detail}`);
    if (notes) notes.push(`${source}: couldn't resolve the location "${want}" — ${detail}`);
    return {};
  }
  dlog(`${source}: location "${want}" → ${r.label}${r.geoId ? ` (geoId ${r.geoId})` : ""}`);
  const token = { geoId: r.geoId || "", locationFilter: r.locationFilter || "", label: r.label || want };
  await saveGeoToCache(source, want, token);
  return { ...token, from: "resolved" };
}

// Poll (SW-side) until a board's result list has SETTLED — not merely started.
//
// ⚠ SETTLE, DON'T JUST WAIT FOR NON-EMPTY. The first version returned on the first
// non-empty read and live that captured **3 cards of 25**: both boards mount their
// list progressively, so "some cards exist" is true long before "the page is done".
// The sweep then reported `scanned 3` and silently missed 22 postings — a quiet
// under-read, which is worse than an error. Accept only a NON-ZERO count that reads
// the same twice in a row (and stop early if the count is already at the page size).
//
// This is the third place in this codebase to learn the same lesson — the JD page,
// Workday form pages, and the review page all needed a settle rather than a delay —
// so: never scan a progressively-rendered list without settling it first.
//
// All wall-clock, SW-side, so it behaves identically in a background tab where page
// timers are throttled.
async function pollForCards(tabId, scraper, ceilingMs, opts) {
  const o = opts || {};
  const expect = Number(o.expect) || 25;      // a full page — stop as soon as we have it
  const deadline = Date.now() + (Number(ceilingMs) || 25000);
  let last = null;
  let prevCount = -1;
  while (Date.now() < deadline) {
    try {
      const out = await discoverReadPage(tabId, scraper, [], { keepAttach: true });
      if (out && typeof out === "object") {
        last = out;
        if (out.signedIn === false) return out;                 // terminal — stop waiting
        const n = (out.jobs || []).length;
        if (n >= expect) return out;                            // a full page; no point waiting
        if (n > 0 && n === prevCount) return out;               // settled
        prevCount = n;
      }
    } catch (e) { /* mid-navigation — keep polling */ }
    await discoverDelay(700);
  }
  return last || { signedIn: true, jobs: [], note: "the results list never rendered before the timeout." };
}

/**
 * Make a HIDDEN tab actually render, then re-poll for cards.
 *
 * Chrome pauses rAF and throttles timers to ~1Hz in a tab that has never been
 * presented. LinkedIn's list survives that (62 cards scanned hidden), but Handshake's
 * slower SPA does NOT: live, the very query that renders 14 cards in a foreground tab
 * returned `scanned 0` three sweeps in a row while unfocused — and the sweep reported
 * it as "no job cards found … run recon", i.e. blamed the scraper for a render that
 * never happened.
 *
 * These are the same three levers the location resolver uses, and the ones cdp.js
 * already documents for hidden-tab stalls: worker-timers (behind Page.setBypassCSP, or
 * a blocking CSP silently defeats it), setWebLifecycleState to unfreeze, and
 * Emulation.setFocusEmulationEnabled to keep the page repainting. None of them touch
 * real window focus.
 *
 * Applied ONLY when a board came back empty while hidden, so a board that renders fine
 * unfocused never pays the debugger attach.
 */
async function retryHiddenRender(tabId, scraper, ceilingMs) {
  let visible = true;
  try { visible = await cdpVisible(); } catch (e) { /* assume visible; the retry is cheap */ }
  if (visible) return null; // a foreground tab that rendered nothing really has nothing

  const hadAttach = cdpAttachedTab() === tabId;
  if (!hadAttach) {
    const att = await cdpAttach(tabId);
    if (!att || !att.ok) return null;
  }
  try {
    dlog("the tab is hidden and rendered no cards — enabling worker-timers + focus emulation and retrying");
    try { await cdpInstallPageOverrides(); } catch (e) { /* best-effort */ }
    await cdpWakePage();
    await cdpSetFocusEmulation(true);
    const out = await pollForCards(tabId, scraper, ceilingMs, { expect: 25 });
    return out;
  } finally {
    try { await cdpSetFocusEmulation(false); } catch (e) { /* page may be gone */ }
    if (!hadAttach) { try { await cdpDetach(); } catch (e) { /* tab may be gone */ } }
  }
}

// Turn a board's raw rows into candidate jobs: normalize → freshness → not already
// applied to. Shared by both boards so the filter arithmetic (and its logging) is
// identical. Returns the survivors plus the per-reason counts.
function boardRowsToCandidates(rawRows, source, o, known) {
  const now = typeof o.nowMs === "number" ? o.nowMs : Date.now();
  const jobs = [];
  let skippedKnown = 0, skippedStale = 0, skippedUnusable = 0;
  for (const raw of rawRows || []) {
    const job = normalizeDiscoveredJob(raw, source, now);
    if (!job) { skippedUnusable++; continue; }
    if (!isFreshPosting(job.postedAt, o.sinceDays, now)) { skippedStale++; continue; }
    if (known.has(job.jobKey)) { skippedKnown++; continue; }
    jobs.push(job);
  }
  return { jobs, skippedKnown, skippedStale, skippedUnusable };
}

// ── The DETAIL pass (shared) ────────────────────────────────────────────────
//
// One JSON read per posting gives the JD, the exact posted date, whether it's
// still open, and — the reason this exists — the EMPLOYER's real application url.
// A `linkedin.com/jobs/view/…` or `joinhandshake.com/jobs/…` url is useless to the
// Run pipeline, which drives Workday/Greenhouse/Lever; rewriting to the employer's
// link is also what makes a board find dedup against a tracker row written after
// applying, and what lets the SAME posting found on both boards collapse to one.
async function readBoardDetails(tabId, source, jobs, opts, known) {
  const o = opts || {};
  // The RECORD budget, not the tab budget — see DISCOVER_DEFAULTS for why they differ.
  const budget = Math.max(0, Number(o.maxRecords != null ? o.maxRecords : DISCOVER_DEFAULTS.maxRecords));
  const knownSet = known || new Set();
  const prefix = source === "linkedin" ? "linkedin:" : "handshake:";
  const stats = { read: 0, failed: 0, rewritten: 0, easyApply: 0, noApply: 0, closed: 0, droppedKnown: [], droppedEasy: [], droppedClosed: [] };

  const targets = jobs.filter((j) => j && !j.description).slice(0, budget);
  if (!targets.length) return stats;
  if (targets.length < jobs.length) {
    dlog(`${source}: reading ${targets.length} of ${jobs.length} job records (maxRecords=${budget})`);
  }

  const idOf = (j) => (String(j.jobKey || "").startsWith(prefix) ? String(j.jobKey).slice(prefix.length) : "");
  const urls = [];
  const owners = [];
  for (const j of targets) {
    const id = idOf(j);
    if (!id) { stats.failed++; dlog(`  ✗ ${jobLine(j)} — no ${source} id on the key, skipped`); continue; }
    const u = source === "linkedin" ? linkedInApiDetailUrl(id) : handshakeDetailPath(id);
    if (!u) { stats.failed++; continue; }
    urls.push(u);
    owners.push(j);
  }
  if (!urls.length) return stats;

  discoverProgress(`Reading ${urls.length} job record${urls.length === 1 ? "" : "s"} on ${source}`, "no tabs opened");
  const kind = source === "linkedin" ? "linkedin-detail" : "handshake-detail";
  const results = await discoverApiBatch(tabId, urls, kind, { chunk: 5, gapMs: o.betweenJdMs != null ? o.betweenJdMs : 350 });

  for (let i = 0; i < owners.length; i++) {
    const job = owners[i];
    const res = results[i];
    if (!res || !res.ok || !res.json) {
      stats.failed++;
      dlog(`  ✗ ${jobLine(job)} — record read failed (HTTP ${(res && res.status) || "?"}${res && res.error ? ", " + res.error : ""})`);
      continue;
    }
    const patch = source === "linkedin" ? linkedInDetailToPatch(res.json) : handshakeDetailToPatch(res.json);
    if (!patch || !patch.ok) { stats.failed++; dlog(`  ✗ ${jobLine(job)} — ${(patch && patch.error) || "unreadable record"}`); continue; }

    // A CLOSED/archived posting can't be applied to — queueing it would burn a run.
    if (patch.closed) {
      stats.closed++;
      stats.droppedClosed.push(job);
      dlog(`  – ${jobLine(job)} — no longer open (dropped)`);
      continue;
    }

    if (patch.description) {
      job.description = String(patch.description).slice(0, 20000);
      job.descriptionSource = "api";
      stats.read++;
    }
    // The record is authoritative over a list card for these: the card's text is
    // truncated and its date is prose, the record's are exact.
    if (patch.title) job.title = patch.title.slice(0, 300);
    if (patch.company) job.company = patch.company.slice(0, 200);
    if (patch.location) job.location = patch.location.slice(0, 200);
    if (patch.employmentType) job.employmentType = patch.employmentType.slice(0, 60);
    if (patch.applicants != null && isFinite(patch.applicants)) job.applicants = patch.applicants;
    if (patch.promoted) job.promoted = true;
    // The details worth seeing in the queue before opening anything (pay, term,
    // deadline, on-site/remote). Only Handshake publishes pay; LinkedIn does not, and
    // an empty string here means "the board didn't say", never "free".
    if (patch.pay) job.pay = patch.pay.slice(0, 80);
    if (patch.startDate) job.startDate = patch.startDate.slice(0, 40);
    if (patch.endDate) job.endDate = patch.endDate.slice(0, 40);
    if (patch.applyBy) job.applyBy = patch.applyBy.slice(0, 40);
    if (patch.workplace) job.workplace = patch.workplace.slice(0, 24);
    if (patch.applyNote) job.applyNote = String(patch.applyNote).slice(0, 300);
    const ts = parsePostedTimestamp(patch.postedAt, o.nowMs);
    if (ts != null) { job.postedAt = ts; job.postedUnknown = false; }
    // The ORIGINAL posting date + the repost flag — what the ranking actually uses.
    const orig = parsePostedTimestamp(patch.originalPostedAt, o.nowMs);
    if (orig != null) job.originalPostedAt = orig;
    if (patch.reposted) job.reposted = true;

    job.applyKind = patch.applyKind || "unknown";
    job.boardUrl = job.url;
    if (patch.applyUrl && /^https?:\/\//i.test(patch.applyUrl)) {
      const before = job.jobKey;
      job.url = patch.applyUrl;
      job.jobKey = discoveryJobKey(patch.applyUrl);
      job.applyResolved = true;
      stats.rewritten++;
      dlog(`  ✓ ${jobLine(job)} — ${job.description.length} chars · REAL LINK via ${patch.applyVia}`);
      dlog(`      ${before} → ${job.jobKey}  ${job.url}`);
      // The board key wasn't known, but the ATS key it just resolved to may be —
      // this is the check that makes "jobs I haven't applied to" hold across tables.
      if (knownSet.has(job.jobKey)) {
        stats.droppedKnown.push(job);
        dlog(`      ↳ already applied/queued under ${job.jobKey} — dropped`);
      }
    } else if (job.applyKind === "easy") {
      stats.easyApply++;
      // Board-only application (LinkedIn Easy Apply / Handshake Quick apply): no
      // employer link EXISTS, so Run can never drive it. Dropped by default —
      // see the queue note; support for these is a deliberate later step.
      if (o.skipEasyApply !== false) {
        stats.droppedEasy.push(job);
        dlog(`  – ${jobLine(job)} — applies ON ${source} only (skipped; Run can't drive it)`);
      } else {
        dlog(`  ✓ ${jobLine(job)} — ${job.description.length} chars · applies ON ${source} (no employer link exists)`);
      }
    } else {
      stats.noApply++;
      dlog(`  ✓ ${jobLine(job)} — ${job.description.length} chars · ⚠ no employer link in the record (kept the board url)`);
    }
  }

  dlog(
    `${source} record pass done (no tabs opened): ${stats.read} read, ${stats.failed} failed · ` +
    `real employer link on ${stats.rewritten}, board-only ${stats.easyApply}, link-absent ${stats.noApply}, closed ${stats.closed}`
  );
  return stats;
}

// Remove a set of job OBJECTS from a list (identity-based — these are the same
// objects the detail pass mutated).
function dropJobs(list, ...groups) {
  const drop = new Set();
  for (const g of groups) for (const j of g || []) drop.add(j);
  return { kept: list.filter((j) => !drop.has(j)), removed: drop.size };
}

// ── SOURCES 2 & 3 — the logged-in boards, ONE driver ────────────────────────
//
// LinkedIn and Handshake turned out to have the SAME shape once both were traced,
// so they share one driver and differ only by this config. That is the "connect the
// two seamlessly" part: identical paging, filtering, detail-read, dedup and
// logging, so a fix or a bug is never in only one of them.
//
// Both use the rendered SEARCH PAGE for discovery and the board's own JSON RECORD
// for each posting. The page is the search substrate on BOTH — not a fallback:
//   · Handshake's JSON index ignores every filter param (verified: the total never
//     moves), so the page is the only thing that can actually run a search.
//   · LinkedIn HAS a usable search JSON, but its page runs LinkedIn's newer
//     SEMANTIC search and returns visibly better matches for the same words
//     (STMicroelectronics / Neuralink / Intel / Redwood, vs the JSON's Skydio /
//     PureSkill / "Juice — Summer sales intern"). The JSON stays as a fallback.
// Both pages paginate (LinkedIn `start=N`, Handshake `page=N`), which is what lets
// a later sweep reach past everything already queued.
const BOARD_CONFIG = {
  linkedin: {
    keyPrefix: "linkedin:",
    signInHint: "sign in to LinkedIn in this Chrome profile, then run Discover again.",
    scraper: () => scrapeLinkedInJobList,
    detailKind: "linkedin-detail",
    detailUrl: (id) => linkedInApiDetailUrl(id),
    // The scraper returns the card's raw LINES; the field split is done here by the
    // pure, unit-pinned helper (see linkedInFieldsFromLines for the bug that caused).
    parseRow: (r) => (r && r.lines ? { ...r, ...linkedInFieldsFromLines(r.lines) } : r),
    locationTokenKey: "geoId",
    // Observed render times: LinkedIn ~8s to a full list — cheap enough to run every
    // derived search against it.
    renderCeilingMs: 30000,
    maxQueries: 3,
    pageUrl: (o, page) => discoverLinkedInSearchUrl({
      keywords: o.keywords, sinceDays: o.sinceDays, geoId: o.token, start: (page - 1) * 25,
    }),
    // LinkedIn's own search JSON — used only if the page yields nothing.
    fallbackSearch: (o, page) => linkedInApiSearchUrl({
      keywords: o.keywords, geoId: o.token, sinceDays: o.sinceDays,
      internshipOnly: o.internshipOnly, start: (page - 1) * 25, count: 25,
    }),
    fallbackKind: "linkedin-search",
    fallbackRows: (json) => (Array.isArray(json && json.elements) ? json.elements : []).map(linkedInCardToRaw).filter(Boolean),
  },
  handshake: {
    keyPrefix: "handshake:",
    signInHint: "sign in to Handshake in this Chrome profile, then run Discover again.",
    scraper: () => scrapeHandshakeJobList,
    detailKind: "handshake-detail",
    detailUrl: (id) => handshakeDetailPath(id),
    parseRow: (r) => r,
    locationTokenKey: "locationFilter",
    // Handshake is MUCH slower: 15–25s to render its list even in the foreground
    // (measured), so it gets its own budget rather than sharing LinkedIn's — and only
    // ONE search, because three derived searches cost it ~a minute of pure waiting (a
    // live 3-search sweep took 224s, most of it spent right here).
    renderCeilingMs: 45000,
    maxQueries: 1,
    pageUrl: (o, page) => discoverHandshakeSearchUrl({
      keywords: o.keywords, page, perPage: 25,
      internshipOnly: o.internshipOnly, sort: HANDSHAKE_SORT_NEWEST, locationFilter: o.token,
    }),
    fallbackSearch: null, // its JSON index can't filter, so there is nothing to fall back TO
  },
};

async function discoverFromBoard(source, opts) {
  const o = opts || {};
  const cfg = BOARD_CONFIG[source];
  const notes = [];
  if (!cfg) return { jobs: [], note: `${source}: unknown board.`, scanned: 0 };
  // SEVERAL searches per board when the queries were derived from the resume (see
  // buildDiscoverQueries) — all driven through the ONE tab this board opens.
  const allQueries = (Array.isArray(o.queries) && o.queries.length
    ? o.queries
    : [{ keywords: String(o.keywords || "").trim(), from: "" }]
  ).filter((q) => q && String(q.keywords || "").trim());
  // Per-board cap: a SLOW board runs fewer of the derived searches (see BOARD_CONFIG).
  const queries = allQueries.slice(0, Math.max(1, Number(cfg.maxQueries) || allQueries.length));
  if (!allQueries.length) {
    return { jobs: [], note: `${source}: skipped — no search keywords were built (see the keyword box).`, scanned: 0 };
  }
  const known = new Set((o.knownKeys || []).filter(Boolean));
  const wantLocation = String(o.location || "").trim();
  const perSource = Math.max(1, Number(o.maxPerSource) || DISCOVER_DEFAULTS.maxPerSource);
  const maxPages = Math.max(1, Math.min(Number(o.maxPages) || DISCOVER_DEFAULTS.maxPages, 10));
  const internshipOnly = o.intern !== false;

  // A cached location token goes straight into the FIRST url, so the opening render
  // is already the right search and no resolve is needed at all on later runs.
  const cache = await loadGeoCache();
  const cachedTok = wantLocation ? cache[geoCacheKey(source, wantLocation)] || {} : {};
  let token = cachedTok[cfg.locationTokenKey] || "";
  if (!token && source === "linkedin" && wantLocation) {
    // A bare number IS a geoId, and a pasted LinkedIn url contains one.
    token = /^\d+$/.test(wantLocation) ? wantLocation : parseLinkedInGeoId(wantLocation);
  }

  // Pages PER QUERY: with several derived searches, one page each keeps the sweep
  // bounded and covers more ground than three pages of a single query would.
  const pagesPerQuery = queries.length > 1 ? 1 : maxPages;
  const urlFor = (keywords, page) => cfg.pageUrl({ keywords, sinceDays: o.sinceDays, internshipOnly, token }, page);
  const firstUrl = urlFor(queries[0].keywords, 1);
  discoverProgress(`Searching ${source}`, queries.length > 1 ? `${queries.length} searches from your resume` : "in your signed-in session");
  dlog(`${source}: ${queries.length} search(es) × ${pagesPerQuery} page(s) — ${queries.map((q) => JSON.stringify(q.keywords)).join(", ")}`);
  if (allQueries.length > queries.length) {
    dlog(`${source}: running ${queries.length} of ${allQueries.length} derived searches (this board renders too slowly for all of them)`);
  }
  dlog(`${source}: opening ${firstUrl}`);

  try {
    return await withDiscoverTab(firstUrl, { background: o.background !== false, settleMs: 2000 }, async (tabId) => {
      const rawRows = [];
      let scanned = 0;
      let signedOut = false;
      let usedFallback = false;

      // 1. Resolve the location through the board's OWN location box if we need to.
      //
      // ⚠ ORDER MATTERS — WAIT FOR THE PAGE FIRST. This used to run immediately after
      // the tab opened and failed every time with `could-not-open-location-control`:
      // the boards take ~8s (LinkedIn) to ~15s (Handshake) to render, so the location
      // control simply did not exist yet. Worse, the failure was not harmless — with
      // no token the url carries no location param and LinkedIn falls back to the
      // SESSION's sticky last location, so the sweep searched a city the operator
      // never asked for while reporting only that the resolve had failed. Settling on
      // the cards first proves the page (and therefore its filter strip) is up.
      if (wantLocation && !token) {
        const first = await pollForCards(tabId, cfg.scraper(), cfg.renderCeilingMs || 25000, { expect: 25 });
        if (first && first.signedIn === false) {
          dlog(`${source}: NOT SIGNED IN — ${first.note || "redirected to login"}`);
          return { jobs: [], note: `${source}: you're not signed in — ${cfg.signInHint}`, scanned: 0, signedOut: true };
        }
        const tok = await boardLocationToken(tabId, source, wantLocation, notes);
        token = tok[cfg.locationTokenKey] || "";
        if (!token) {
          // Be explicit that the search is now unlocated, because the board will
          // quietly substitute its own idea of where the operator is.
          notes.push(`${source}: searched with NO location filter, so ${source} used whatever location your session defaults to — the results may not match "${wantLocation}".`);
        }
      }

      // 2. Page through each derived search in turn, all in this one tab.
      let nav = 0;
      for (const q of queries) {
      for (let page = 1; page <= pagesPerQuery; page++) {
        const url = urlFor(q.keywords, page);
        // Re-navigate for everything except the very first render, and also for that
        // first one when a location was just resolved (the resolve leaves the tab on
        // the board's own rewritten url).
        if (nav++ > 0 || (wantLocation && token)) {
          dlog(`${source}: page ${page} → ${url}`);
          await new Promise((r) => chrome.tabs.update(tabId, { url }, () => { void chrome.runtime.lastError; r(); }));
          try { await waitTabComplete(tabId, o.loadTimeoutMs || 25000); } catch (e) { /* the poll below is the real gate */ }
        }
        // SETTLE on the cards rather than guessing a delay: Handshake's list can take
        // 15s+ even in the foreground, a hidden tab paints later still, and both mount
        // progressively (see pollForCards — reading too early captured 3 of 25).
        // The per-board ceiling is a COLD-START budget (Handshake needs 15–25s on
        // first paint). Once one page has rendered the SPA is warm, so later pages
        // get a much shorter one — otherwise several derived searches each pay the
        // cold price and the sweep outlives the page waiting on it.
        const ceiling = rawRows.length ? Math.min(12000, cfg.renderCeilingMs || 25000) : (cfg.renderCeilingMs || 25000);
        let out = await pollForCards(tabId, cfg.scraper(), ceiling, { expect: 25 });
        // Empty while HIDDEN is usually a render that never happened, not an empty
        // result set — Handshake in particular needs the hidden-tab levers. `empty:true`
        // means the board itself reported 0 results, which is a real answer.
        if (out && out.signedIn !== false && !((out.jobs || []).length) && !out.empty) {
          const retried = await retryHiddenRender(tabId, cfg.scraper(), ceiling);
          if (retried && ((retried.jobs || []).length || retried.empty)) out = retried;
        }
        if (out && out.signedIn === false) {
          signedOut = true;
          dlog(`${source}: NOT SIGNED IN — ${out.note || "redirected to login"}`);
          break;
        }
        const rows = ((out && out.jobs) || []).map(cfg.parseRow).filter(Boolean);
        if (out && out.note) notes.push(`${source}: ${out.note}`);
        scanned += rows.length;
        rawRows.push(...rows);
        dlog(`${source}: "${q.keywords}" page ${page} — ${rows.length} card${rows.length === 1 ? "" : "s"}`);
        if (!rows.length) break;                       // this query is out of results
        await discoverDelay(500);
      }
        if (signedOut) break;
      }

      if (signedOut) {
        return { jobs: [], note: `${source}: you're not signed in — ${cfg.signInHint}`, scanned: 0, signedOut: true };
      }

      // 3. Fallback to the board's search JSON if the page gave us nothing at all.
      //    Reported, never silent — a substrate downgrade the operator can't see is
      //    how a half-broken sweep looks like a quiet day on the job market.
      if (!rawRows.length && cfg.fallbackSearch) {
        const url = cfg.fallbackSearch({ keywords: queries[0].keywords, sinceDays: o.sinceDays, internshipOnly, token }, 1);
        if (url) {
          dlog(`${source}: the rendered page yielded nothing — trying the search JSON`);
          const [res] = await discoverApiBatch(tabId, [url], cfg.fallbackKind, { chunk: 1 });
          if (res && res.ok && res.json) {
            const rows = cfg.fallbackRows(res.json);
            scanned += rows.length;
            rawRows.push(...rows);
            usedFallback = true;
            dlog(`${source}: search JSON returned ${rows.length} card${rows.length === 1 ? "" : "s"}`);
            notes.push(`${source}: the results page rendered nothing, so its search API was used instead (matches can be looser). Run Discover recon if this repeats.`);
          } else {
            dlog(`${source}: search JSON also failed (HTTP ${(res && res.status) || "?"})`);
          }
        }
      }

      // 4. Filter → cap → read each posting's record.
      const f = boardRowsToCandidates(rawRows, source, o, known);
      dlog(
        `${source}: ${f.jobs.length} candidate${f.jobs.length === 1 ? "" : "s"} after filters ` +
        `(dropped ${f.skippedKnown} already applied/queued, ${f.skippedStale} older than ${o.sinceDays}d, ${f.skippedUnusable} unusable)`
      );
      // Newest-first here is only the CAP order (which to keep when there are more
      // than maxPerSource); the final ordering is matchPercent's, later.
      f.jobs.sort(comparePostedDesc);
      let kept = f.jobs.slice(0, perSource);
      if (kept.length < f.jobs.length) dlog(`${source}: keeping the newest ${kept.length} (maxPerSource=${perSource})`);
      for (let i = 0; i < kept.length; i++) dlog(`  ${String(i + 1).padStart(2, "0")}. ${jobLine(kept[i])}`);

      // ⚠ SPEND THE RECORD BUDGET ON THE JOBS MOST LIKELY TO BE QUEUED.
      // maxJdOpens is smaller than the candidate list, and the queue keeps the BEST N
      // while this pass used to read the NEWEST N — two different sets. Live, that
      // queued an Amazon posting whose record was never read, so it had no JD and no
      // employer link (`resolved:false`, and it fell through to the reader tab) while
      // the budget had been spent on candidates that were then discarded by the rank.
      // Pre-ranking on what the CARD already gives us (title match, freshness,
      // applicant count) costs nothing and aligns the two sets; the final ordering is
      // still computed after enrichment, on the fuller data.
      kept = rankByMatch(kept, { keywords: o.keywords, field: o.field, intern: o.intern, sinceDays: o.sinceDays, nowMs: o.nowMs });

      const detail = await readBoardDetails(tabId, source, kept, o, known);
      const after = dropJobs(kept, detail.droppedKnown, detail.droppedEasy, detail.droppedClosed);
      kept = after.kept;

      return {
        jobs: kept,
        note: notes.join(" "),
        scanned,
        skippedKnown: f.skippedKnown + detail.droppedKnown.length,
        detail,
        usedFallback,
      };
    });
  } catch (e) {
    dlog(`${source}: FAILED — ${String((e && e.message) || e)}`);
    return { jobs: [], note: `${source}: ${String((e && e.message) || e)}`, scanned: 0 };
  }
}

// THE JD PASS — "if the job description is not on the page, physically open the
// link, scrape the JD, and close it."
//
// Runs ONE tab at a time (never a fan-out), bounded by maxJdOpens, and each tab
// is closed by withDiscoverTab's finally. A failed scrape is NON-FATAL: the job
// still goes to the queue with an empty description and a note, because a missing
// JD is a nice-to-have, not a reason to lose a discovered posting.
async function fillMissingDescriptions(jobs, opts) {
  const o = opts || {};
  const budget = Math.max(0, Number(o.maxJdOpens != null ? o.maxJdOpens : DISCOVER_DEFAULTS.maxJdOpens));
  let opened = 0;
  let failed = 0;
  let rewritten = 0;
  const need = (jobs || []).filter((j) => j && !j.description);
  const total = Math.min(need.length, budget);
  if (!total) {
    dlog("reader tab: nothing left to read — every job already has a description");
    return { opened, failed, rewritten, skipped: need.length };
  }
  dlog(`reader tab: reading ${total} of ${need.length} remaining description${need.length === 1 ? "" : "s"} in ONE reused tab`);

  // ONE tab for the whole pass (2026-07-29). This used to create AND destroy a tab
  // per posting, which read as a flicker-storm of tabs opening and closing. Now we
  // open a single tab and NAVIGATE it from posting to posting, closing it once at
  // the end — and because a chrome.debugger attach SURVIVES navigation (the same
  // invariant the Workday walk relies on), one attach covers every posting instead
  // of N attach/detach cycles flashing the debugging infobar.
  let tabId = null;
  try {
    const tab = await new Promise((res) => chrome.tabs.create({ url: "about:blank", active: o.background === false }, res));
    if (!tab || tab.id === undefined) throw new Error("could not open the reader tab");
    tabId = tab.id;

    for (const job of need) {
      if (opened >= budget) break;
      opened++;
      discoverProgress(
        `Reading job descriptions (${opened}/${total})`,
        `${job.company || ""}${job.company && job.title ? " — " : ""}${job.title || job.url}`
      );
      try {
        await new Promise((r) => chrome.tabs.update(tabId, { url: job.url }, () => { void chrome.runtime.lastError; r(); }));
        await waitTabComplete(tabId, o.loadTimeoutMs || 25000);
        await discoverDelay(o.settleMs || 2500); // SPA hydration beat
        const jd = await discoverReadPage(tabId, scrapeJobPosting, [], { keepAttach: true });
        if (jd && jd.text) {
          job.description = String(jd.text).slice(0, 20000);
          job.descriptionSource = "page";
          // The posting page is a BETTER source for title/company than a list row's
          // truncated text — but only fill gaps, never overwrite a value the board
          // already gave us (the board's company name is the cleaner one).
          if (!job.title && jd.title) job.title = String(jd.title).slice(0, 300);
          if (!job.company && jd.company) job.company = String(jd.company).slice(0, 200);

          // If this was a BOARD wrapper (a Handshake posting page) and it exposes
          // the employer's application link, that link is what belongs in the
          // queue — the Run pipeline can't drive a board url. An ATS url is
          // already the real thing and is never rewritten.
          if (isBoardUrl(job.url) && jd.applyUrl && /^https?:\/\//i.test(jd.applyUrl) && !isBoardUrl(jd.applyUrl)) {
            const before = job.jobKey;
            job.boardUrl = job.url;
            job.url = jd.applyUrl;
            job.jobKey = discoveryJobKey(jd.applyUrl);
            job.applyResolved = true;
            rewritten++;
            dlog(`  ✓ ${jobLine(job)} — ${job.description.length} chars · REAL LINK via ${jd.applyVia}`);
            dlog(`      ${before} → ${job.jobKey}  ${job.url}`);
          } else {
            dlog(`  ✓ ${jobLine(job)} — ${job.description.length} chars${isBoardUrl(job.url) ? " · ⚠ no employer link found (kept the board url)" : ""}`);
          }
        } else {
          failed++;
          dlog(`  ✗ ${jobLine(job)} — no description found on the page`);
        }
      } catch (e) {
        failed++;
        dlog(`  ✗ ${jobLine(job)} — page read threw: ${String((e && e.message) || e)}`);
      }
      await discoverDelay(o.betweenJdMs != null ? o.betweenJdMs : 400); // be a polite client
    }
  } finally {
    // Release the shared CDP client BEFORE the tab goes, then close the one tab.
    try { if (tabId != null && cdpAttachedTab() === tabId) await cdpDetach(); } catch (e) { /* already gone */ }
    if (tabId != null) {
      try { await new Promise((r) => chrome.tabs.remove(tabId, () => { void chrome.runtime.lastError; r(); })); }
      catch (e) { /* already gone */ }
    }
  }
  dlog(`reader tab: done — ${opened - failed}/${opened} read, ${rewritten} rewritten to the employer's real link`);
  return { opened, failed, rewritten, skipped: Math.max(0, need.length - opened) };
}

/**
 * THE ORCHESTRATOR. Sweep the enabled sources → merge → drop everything already
 * applied-to/queued → rank newest-first → cap → scrape the missing JDs → RETURN.
 *
 * Never throws (every failure is a per-source note); never writes to storage or
 * the backend — the caller (the website's Discover button) persists the result.
 *
 * opts: {
 *   sources: { simplify?, linkedin?, handshake? }  // booleans, default all on
 *   knownKeys: string[]        // discoveryJobKey values already applied/queued
 *   query, sinceDays, maxPerSource, maxTotal, maxJdOpens, termPattern
 *   background: boolean        // open sweep tabs unfocused (default true)
 *   nowMs: number              // injectable clock (tests)
 * }
 */
async function runJobDiscovery(opts) {
  const o = { ...DISCOVER_DEFAULTS, ...(opts || {}) };
  const now = typeof o.nowMs === "number" ? o.nowMs : Date.now();
  const want = { simplify: true, linkedin: true, handshake: true, ...(o.sources || {}) };
  const notes = [];
  const scanned = {};
  let all = [];

  // The actual search string, composed once and REPORTED — an empty/odd query must
  // never again be invisible (the "it just looked at the recommended jobs" bug).
  // SEVERAL searches when the box is blank — derived from the resume, not just the
  // major (see buildDiscoverQueries). `keywords` stays the FIRST one so every existing
  // consumer (the Simplify sieve, the echoed search, the logs) is unchanged.
  const { queries, derivedFrom } = buildDiscoverQueries(o);
  const keywords = queries.length ? queries[0].keywords : "";
  const term = discoverTermLabel(o.cycle, o.year);
  const location = String(o.location || "").trim() || DISCOVER_DEFAULT_LOCATION;
  const search = { keywords, derivedFrom, term, location, sinceDays: o.sinceDays, queries: queries.map((q) => q.keywords), minMatchPercent: o.minMatchPercent == null ? DISCOVER_DEFAULTS.minMatchPercent : Number(o.minMatchPercent) };

  console.log(
    `[ApplyPilot][DISCOVER] sweep start — sources ${Object.keys(want).filter((k) => want[k]).join("+") || "none"}, ` +
    `search${queries.length === 1 ? "" : "es"} ${queries.length ? queries.map((q) => JSON.stringify(q.keywords)).join(" | ") : "(NONE)"} (from ${derivedFrom || "nothing"}), ` +
    `season "${term || "(any)"}", location "${location}", last ${o.sinceDays}d, ` +
    `${(o.knownKeys || []).length} already known`
  );
  if (!keywords) {
    // The keyword-searched boards CANNOT run without this, and a blank search on
    // LinkedIn is its recommended feed, not a search. Say so instead of scraping it.
    notes.push("No search keywords: type some, or set your field of study on the Profile page. LinkedIn and Handshake were skipped — a keyword-less search there just returns their recommended feed, not your jobs.");
  }

  // Stable source order → deterministic cross-board dedup (first wins). Simplify
  // leads because its rows carry the employer's real ATS url, which is the key
  // that lines up with the tracker.
  if (want.simplify) {
    // The season label is EXACT here: the feed's rows literally carry "Summer 2026"
    // in `terms`, so this is a real filter, not a keyword guess.
    const r = await discoverFromSimplify({ ...o, keywords, location, termPattern: term, nowMs: now });
    if (r.note) notes.push(r.note);
    scanned.simplify = r.scanned;
    all = all.concat(r.jobs);
  }
  let boardRewrites = 0;
  let easyApplyCount = 0;
  let linkNotFound = 0;
  let closedCount = 0;
  let easySkipped = 0;
  const tallyDetail = (d) => {
    if (!d) return;
    boardRewrites += d.rewritten || 0;
    easyApplyCount += d.easyApply || 0;
    linkNotFound += d.noApply || 0;
    closedCount += d.closed || 0;
    easySkipped += (d.droppedEasy || []).length;
  };
  // The boards run in a fixed order (LinkedIn then Handshake) so the cross-board
  // dedup below is deterministic — "first source wins" only means something if the
  // order is stable.
  for (const src of ["linkedin", "handshake"]) {
    if (!want[src]) continue;
    const r = await discoverFromBoard(src, { ...o, keywords, queries, location, nowMs: now });
    if (r.note) notes.push(r.note);
    scanned[src] = r.scanned;
    tallyDetail(r.detail);
    all = all.concat(r.jobs);
  }
  if (easySkipped > 0) {
    // A DEFERRED capability, not a silent drop (operator 2026-07-30).
    notes.push(
      `${easySkipped} posting${easySkipped === 1 ? "" : "s"} apply only on the board itself ` +
      `(LinkedIn Easy Apply / Handshake Quick apply) and were skipped — there is no employer link for Run to drive. ` +
      `Support for applying to these directly is planned; until then, untick "Skip board-only applications" to queue them for manual apply.`
    );
  }
  if (closedCount > 0) {
    notes.push(`${closedCount} posting${closedCount === 1 ? "" : "s"} had already closed and were dropped.`);
  }

  const found = all.length;
  // CROSS-BOARD DEDUP. This is where "no overlaps" actually happens, and it works
  // because BOTH boards resolved their postings to the employer's real application
  // url first: the same job found on LinkedIn and on Handshake reduces to the same
  // discoveryJobKey (the ATS key), so the second copy is dropped rather than
  // queued twice under two board urls.
  const { jobs: keyed, skippedKnown, skippedDupe } = dedupeDiscovered(all, o.knownKeys);
  // …and the second pass, for the same posting reached via two DIFFERENT employer urls
  // (a board shortlink vs the canonical one). See dedupeCrossSource.
  const cross = dedupeCrossSource(keyed);
  const fresh = cross.kept;
  if (cross.dropped.length) {
    notes.push(
      `${cross.dropped.length} posting${cross.dropped.length === 1 ? " was" : "s were"} listed on more than one board under different employer links ` +
      `and ${cross.dropped.length === 1 ? "was" : "were"} queued once.`
    );
    for (const d of cross.dropped) {
      dlog(`  = cross-board duplicate: [${d.job.source}] ${d.job.company} — ${d.job.title} (already have it from ${d.keptFrom})`);
    }
  }
  const cappedTotal = Number(o.maxTotal) > 0 ? Number(o.maxTotal) : DISCOVER_DEFAULTS.maxTotal;

  // ── SCRAPE WIDE, QUEUE NARROW (operator 2026-07-30) ────────────────────────
  // Everything found is ranked; only the best `queueLimit` are returned to be
  // queued. Both halves are reported — a narrowing the operator can't see is
  // indistinguishable from a sweep that found nothing.
  // ── QUEUE BY MATCH THRESHOLD (operator 2026-07-30) ────────────────────────
  // A "% match" the operator can edit, rather than a top-N count: everything at or
  // above the threshold is queued, however many that is. matchPercent's components
  // sum to 100 precisely so the number is comparable against a threshold.
  const rankOpts = { keywords, field: o.field, intern: o.intern, sinceDays: o.sinceDays, nowMs: now };
  const minPercent = o.minMatchPercent == null ? DISCOVER_DEFAULTS.minMatchPercent : Number(o.minMatchPercent);
  const graded = pickByThreshold(fresh, minPercent, rankOpts);
  const wide = graded.kept.concat(graded.dropped); // every candidate, best first
  // maxTotal is still the hard backstop, so a low threshold can't queue hundreds.
  const capped = graded.kept.slice(0, cappedTotal);
  const belowThreshold = graded.dropped.length;
  const droppedByCap = graded.kept.length - capped.length;
  if (belowThreshold > 0) {
    notes.push(
      `${wide.length} new job${wide.length === 1 ? "" : "s"} found; queued the ${capped.length} matching ${minPercent}% or better. ` +
      `${belowThreshold} scored lower — lower the threshold to take more.`
    );
    dlog(`ranking: ${wide.length} found, ${graded.kept.length} at/above ${minPercent}%, queued ${capped.length}`);
    for (const j of graded.dropped.slice(0, 10)) {
      dlog(`  – below threshold [${j.matchPercent}%] ${j.company || "?"} — ${j.title || "?"} (${(j.scoreReasons || []).join("; ") || "no signals"})`);
    }
  }
  if (droppedByCap > 0) {
    notes.push(`${droppedByCap} more job${droppedByCap === 1 ? "" : "s"} met the threshold but were left out by the ${cappedTotal}-job cap.`);
  }

  // How many descriptions came from a board's JSON record — i.e. with no tab
  // opened and no page clicked at all.
  const inPageRead = capped.filter((j) => j.descriptionSource === "api").length;

  // Whatever is STILL missing a description needs a real page load, and that now
  // happens in ONE reused tab rather than a tab per posting.
  const jd = await fillMissingDescriptions(capped, { ...o });
  if (jd.skipped > 0) {
    notes.push(`${jd.skipped} job${jd.skipped === 1 ? "" : "s"} were queued without a description (the ${o.maxJdOpens}-read cap).`);
  }
  if (jd.failed > 0) {
    notes.push(`${jd.failed} job page${jd.failed === 1 ? "" : "s"} didn't yield a description — queued anyway.`);
  }

  // A queued BOARD url can't be driven by the Run pipeline, so say so plainly here
  // rather than letting it fail later as a confusing halt.
  const stillBoard = capped.filter((j) => isBoardUrl(j.url));
  if (stillBoard.length) {
    const easy = stillBoard.filter((j) => j.applyKind === "easy").length;
    const other = stillBoard.length - easy;
    const bits = [];
    // Board-NEUTRAL wording: this note fires for Handshake Quick apply too, and saying
    // "LinkedIn Easy Apply" about a Handshake posting is simply wrong.
    if (easy) bits.push(`${easy} ${easy === 1 ? "applies" : "apply"} on the board itself (LinkedIn Easy Apply / Handshake Quick apply), so no employer link exists to save`);
    if (other) bits.push(`${other} didn't expose an employer link`);
    notes.push(
      `${stillBoard.length} job${stillBoard.length === 1 ? "" : "s"} kept a board link instead of the employer's: ` +
      `${bits.join("; ")}. Run can't drive those automatically — open them from the queue.`
    );
  }

  const summary = summarizeDiscovery(capped);
  dlog(
    `done — scanned ${JSON.stringify(scanned)}, found ${found}, ` +
    `${skippedKnown} already known, ${skippedDupe} cross-board dupes, ${capped.length} new ` +
    `(${JSON.stringify(summary.bySource)}), JDs: ${inPageRead} read in-page (no tab), ` +
    `${jd.opened - jd.failed}/${jd.opened} via the single reader tab`
  );
  dlog(
    `real employer links: ${boardRewrites + (jd.rewritten || 0)} resolved, ` +
    `${easyApplyCount} easy-apply, ${linkNotFound} not exposed, ${stillBoard.length} still on a board url`
  );
  dlog("queued jobs, best first — FINAL links:");
  for (let i = 0; i < capped.length; i++) {
    const j = capped[i];
    dlog(`  ${String(i + 1).padStart(2, "0")}. [${j.source}] score ${j.score} · ${j.company || "?"} — ${j.title || "?"}`);
    dlog(`      why: ${(j.scoreReasons || []).join("; ") || "no signals"}`);
    dlog(`      ${j.url}${j.boardUrl && j.boardUrl !== j.url ? `   (found on ${j.boardUrl})` : ""}`);
  }
  discoverProgress("Discovery finished", `${capped.length} new job${capped.length === 1 ? "" : "s"}`);

  return {
    ok: true,
    jobs: capped,
    search, // the exact keywords/season/location used — surfaced in the UI
    stats: {
      scanned,
      found,
      skippedKnown,
      skippedDupe: skippedDupe + cross.dropped.length,
      droppedByCap,
      matched: wide.length,   // everything that survived dedup, BEFORE the best-N cut
      newJobs: capped.length,
      bySource: summary.bySource,
      jdOpened: jd.opened,
      jdFailed: jd.failed,
      jdSkipped: jd.skipped,
      jdInPage: inPageRead,   // read straight from a board record — no tab, no clicks
      employerLinks: boardRewrites + (jd.rewritten || 0),
      boardOnlySkipped: easySkipped,
      closedSkipped: closedCount,
    },
    notes,
  };
}

/**
 * RECON entry point — read-only. Opens each requested source's landing page in
 * the operator's real session and dumps what the DOM actually looks like
 * (selector hit-counts + one representative card's markup). Run this ONCE per
 * source before trusting the list scrapers, exactly as the CDP recon harnesses
 * do for a new tenant. Touches nothing and queues nothing.
 */
async function runDiscoverRecon(opts) {
  const o = { ...DISCOVER_DEFAULTS, ...(opts || {}) };
  const want = { linkedin: true, handshake: true, ...(o.sources || {}) };
  const out = {};
  const targets = [];
  // Recon must land on the SAME page a real sweep would, so it composes the query
  // identically — including the refusal when there are no keywords at all.
  const { keywords } = buildDiscoverQuery(o);
  const wantLocation = String(o.location || "").trim();
  if (!keywords) return { ok: false, error: "no-keywords", detail: "Type keywords (or set your field of study) — recon opens the same search a sweep would." };

  // Reuse whatever location token has already been resolved, so recon lands on the
  // same filtered search a sweep would. Recon never RESOLVES one itself: resolving
  // drives the location dropdown, and recon must stay read-only.
  const cache = await loadGeoCache();
  const tok = (src) => (wantLocation ? cache[geoCacheKey(src, wantLocation)] || {} : {});

  if (want.linkedin) {
    targets.push(["linkedin", discoverLinkedInSearchUrl({
      keywords, sinceDays: o.sinceDays,
      geoId: tok("linkedin").geoId || (/^\d+$/.test(wantLocation) ? wantLocation : parseLinkedInGeoId(wantLocation)),
    })]);
  }
  if (want.handshake) {
    targets.push(["handshake", discoverHandshakeSearchUrl({
      keywords, page: 1, perPage: 25,
      internshipOnly: o.intern !== false,
      sort: HANDSHAKE_SORT_NEWEST,
      locationFilter: tok("handshake").locationFilter || "",
    })]);
  }

  for (const [name, url] of targets) {
    discoverProgress(`Recon: ${name}`);
    dlog(`recon ${name}: opening ${url}`);
    try {
      out[name] = await withDiscoverTab(url, { background: o.background !== false, settleMs: 2000 }, async (tabId) => {
        // POLL for the cards instead of trusting a fixed settle (operator
        // 2026-07-30: recon has to be as trustworthy in a BACKGROUND tab as in the
        // foreground). A hidden tab paints late — and Handshake takes 15s+ even
        // visible — so a fixed delay would report "0 cards" for a page that was
        // merely still rendering, which is the one thing recon must never do.
        const scraper = name === "linkedin" ? scrapeLinkedInJobList : scrapeHandshakeJobList;
        const polled = await pollForCards(tabId, scraper, (BOARD_CONFIG[name] || {}).renderCeilingMs || 25000, { expect: 25 });
        await discoverAutoScroll(tabId, 1);
        const dump = await discoverReadPage(tabId, dumpDiscoverRecon, [], { keepAttach: true });
        // Report what the REAL scraper got beside the raw counts: the counts prove
        // the anchors exist, this proves the parse works end to end.
        return {
          ...(dump || {}),
          searchUrl: url,
          scraper: {
            signedIn: polled && polled.signedIn,
            cards: ((polled && polled.jobs) || []).length,
            note: (polled && polled.note) || "",
            sample: ((polled && polled.jobs) || []).slice(0, 3).map((j) => ({
              title: j.title, company: j.company, location: j.location,
              postedText: j.postedText, url: j.url,
            })),
          },
        };
      });
    } catch (e) {
      out[name] = { error: String((e && e.message) || e) };
    }
    const r = out[name] || {};
    // A one-line verdict first — the dump is long, and the question being asked is
    // always "does the scraper still work on this board".
    if (r.error) dlog(`recon ${name}: FAILED — ${r.error}`);
    else {
      dlog(
        `recon ${name}: ${r.scraper ? r.scraper.cards : 0} card(s) parsed · signedIn=${r.scraper ? r.scraper.signedIn : "?"} · ` +
        `readyState=${r.readyState} · tabHidden=${r.hidden} · anchors: linkedin=${(r.cardIds || {}).linkedin} handshake=${(r.cardIds || {}).handshake}` +
        `${r.scraper && r.scraper.note ? ` · note: ${r.scraper.note}` : ""}`
      );
    }
    console.log(`[ApplyPilot][DISCOVER-RECON] ${name}:`, JSON.stringify(out[name], null, 2));
  }
  return { ok: true, recon: out };
}

// UMD-lite: export the PURE helpers for the Node test runner; in the SW `module`
// is undefined so everything stays a global (from importScripts). Mirrors
// lib.js/gmail.js/llm.js.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    DISCOVER_DEFAULTS,
    DISCOVER_SIMPLIFY_URL,
    DISCOVER_DEFAULT_LOCATION,
    DISCOVER_CYCLES,
    discoverTermLabel,
    buildDiscoverQuery,
    buildDiscoverQueries,
    discoverKeywordTokens,
    discoverLinkedInSearchUrl,
    discoverHandshakeSearchUrl,
    // The board JSON contract + ranking (traced 2026-07-30). Pure, so the payload
    // adapters can be unit-tested against real recorded records.
    linkedInApiSearchUrl,
    linkedInApiDetailUrl,
    parseLinkedInGeoId,
    handshakeDetailPath,
    geoCacheKey,
    locationVariants,
    linkedInCardToRaw,
    linkedInFieldsFromLines,
    linkedInDetailToPatch,
    handshakeDetailToPatch,
    matchPercent,
    postedForRanking,
    pickByThreshold,
    rankByMatch,
    workplaceFromText,
    dateOnly,
    HANDSHAKE_SORT_NEWEST,
    LINKEDIN_EXPERIENCE_INTERNSHIP,
    HANDSHAKE_JOB_TYPE_INTERNSHIP,
    discoveryJobKey,
    parsePostedTimestamp,
    isFreshPosting,
    matchesDiscoverQuery,
    matchesDiscoverLocation,
    isBoardUrl,
    normalizeDiscoveredJob,
    simplifyListingsToJobs,
    comparePostedDesc,
    dedupeDiscovered,
    crossSourceKey,
    dedupeCrossSource,
    summarizeDiscovery,
  };
}
