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
//   2. linkedin  — the operator's LOGGED-IN job search, read out of a real tab
//      (their cookies, their session). LinkedIn renders the JD only in a side
//      pane on click, so list rows carry NO description → the JD pass opens each
//      posting.
//   3. handshake — same shape as LinkedIn: logged-in tab, list rows, JD on the
//      posting page.
//
// COOKIES, NOT APIS (operator decision 2026-07-26): LinkedIn/Handshake are read
// through the operator's own signed-in browser session. There is no API key and
// no credential handling here — if the session isn't signed in we say so and
// skip the source, we never attempt a login.
//
// ⚠ SELECTOR CONFIDENCE — READ BEFORE TRUSTING THE LIST SCRAPERS.
// CLAUDE.md's first working principle is "trace the real DOM before writing a
// handler — don't guess." The Simplify feed is a published contract (verified).
// The LinkedIn/Handshake list scrapers could NOT be traced from the build
// environment (both need an authenticated session), so they are written
// STRUCTURE-FIRST rather than selector-first: they anchor on the one thing that
// has survived every redesign — an <a href> carrying the posting id
// (/jobs/view/<id>, /jobs/<id>) — walk UP to the enclosing card, and then read
// title/company/location/date through a LADDER of candidate selectors with a
// text-line fallback. They also report `signedIn` and a per-source note instead
// of silently returning nothing. `dumpDiscoverRecon` (the AP_DISCOVER_RECON /
// popup "Discover recon" entry point) dumps the observed card shape from the
// operator's real session so the ladders can be tightened from observation —
// run it once per source before relying on the counts.
//
// BOUNDED BY CONSTRUCTION: every source is capped (maxPerSource), the whole
// sweep is capped (maxTotal), and the expensive part — opening a tab per posting
// to read its JD — is capped separately (maxJdOpens) and runs ONE tab at a time,
// each closed in a finally. A discovery pass can't fan out into dozens of tabs.
// ============================================================================

// ── Config ──────────────────────────────────────────────────────────────────

// The Simplify board's structured feed (verified 2026-07-26). `dev` is the
// branch the bot writes to; the array element shape is pinned in the header note
// above and exercised by test/discover.test.js.
const DISCOVER_SIMPLIFY_URL =
  "https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/.github/scripts/listings.json";

const DISCOVER_DEFAULTS = {
  sinceDays: 7,       // "recently posted" window
  maxPerSource: 25,   // cap per board BEFORE merge/dedup
  maxTotal: 60,       // cap the merged, deduped list
  maxJdOpens: 10,     // cap the open-tab-and-scrape-the-JD pass (the expensive one)
  query: "",          // keyword filter (empty = take everything fresh)
  termPattern: "2026", // Simplify `terms` filter — the 2026 internship season
};

// Per-source landing pages. LinkedIn's f_TPR=r<seconds> makes the SOURCE do the
// recency filtering (far cheaper than scraping a year of postings and dropping
// them here); sortBy=DD puts newest first so maxPerSource keeps the freshest.
function discoverLinkedInSearchUrl(query, sinceDays) {
  const secs = Math.max(1, Math.round((Number(sinceDays) || 1) * 86400));
  const q = encodeURIComponent(String(query || "").trim());
  return (
    "https://www.linkedin.com/jobs/search/?f_TPR=r" + secs + "&sortBy=DD" + (q ? "&keywords=" + q : "")
  );
}

function discoverHandshakeSearchUrl(query) {
  const q = encodeURIComponent(String(query || "").trim());
  // Handshake's search route; sort newest-first where the param is honored (an
  // unknown param is ignored by the SPA, never an error) — the posted-date parse
  // + the caller's sinceDays filter are the real guard.
  return "https://app.joinhandshake.com/job-search?sort=created_at_desc" + (q ? "&query=" + q : "");
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

// Does a posting match the operator's keyword filter? Empty query ⇒ everything.
// Every whitespace-separated term must appear somewhere in title/company/
// category (AND semantics — "software intern" shouldn't match every "intern").
function matchesDiscoverQuery(job, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const hay = [job.title, job.company, job.location, job.category]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return q.split(/\s+/).every((term) => hay.includes(term));
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
  };
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
    if (!matchesDiscoverQuery(job, o.query)) continue;
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

// LINKEDIN list scrape. Structure-first: every posting row on a LinkedIn jobs
// search carries an <a href="/jobs/view/<id>"> — that anchor has outlived every
// redesign of the surrounding markup, so it is the identity anchor. From the
// anchor we walk UP to the enclosing card and read fields through a selector
// ladder, falling back to the card's own text lines. Returns { signedIn, jobs,
// note } — never throws, and reports a sign-in problem instead of "0 jobs".
function scrapeLinkedInJobList() {
  const txt = (el) => ((el && (el.innerText || el.textContent)) || "").replace(/\s+/g, " ").trim();
  const pickIn = (root, sels) => {
    for (const s of sels) {
      try {
        const el = root.querySelector(s);
        const t = txt(el);
        if (t) return t;
      } catch (e) { /* bad selector on an old Chrome — skip */ }
    }
    return "";
  };

  // Signed-out detection FIRST: an authwall/login redirect renders a jobs-ish page
  // with zero real rows, which would otherwise look like "no new jobs today".
  const href = location.href || "";
  if (/\/(?:login|authwall|checkpoint|uas\/login)/i.test(href)) {
    return { signedIn: false, jobs: [], note: "LinkedIn redirected to its sign-in page." };
  }

  const anchors = Array.from(document.querySelectorAll('a[href*="/jobs/view/"]'));
  if (!anchors.length) {
    const guest = document.querySelector('.sign-in-form, [data-tracking-control-name*="guest"], a[href*="/uas/login"]');
    return {
      signedIn: !guest,
      jobs: [],
      note: guest
        ? "LinkedIn is showing its signed-out page."
        : "No job rows found on the LinkedIn results page (the layout may have changed — run Discover recon).",
    };
  }

  const byId = new Map();
  for (const a of anchors) {
    const m = (a.getAttribute("href") || "").match(/\/jobs\/view\/(\d+)/);
    if (!m) continue;
    const id = m[1];
    if (byId.has(id)) continue;

    // Walk up to the card: the nearest element that looks like a result row.
    let card = a.closest('[data-job-id], [data-occludable-job-id], li.jobs-search-results__list-item, li.scaffold-layout__list-item, div.job-card-container, li');
    if (!card) card = a.parentElement || a;

    const title =
      pickIn(card, [
        '.job-card-list__title', '.job-card-list__title--link', '.artdeco-entity-lockup__title',
        '[class*="job-card"] strong', 'a[href*="/jobs/view/"] strong',
      ]) ||
      (a.getAttribute("aria-label") || "").trim() ||
      txt(a);

    const company = pickIn(card, [
      '.job-card-container__primary-description', '.artdeco-entity-lockup__subtitle',
      '.job-card-container__company-name', '[class*="subtitle"]',
    ]);

    const location = pickIn(card, [
      '.job-card-container__metadata-item', '.artdeco-entity-lockup__caption',
      '[class*="metadata"] li', '[class*="caption"]',
    ]);

    // Posted date: a <time datetime> is exact; else any "… ago" text in the card.
    let postedAt = "";
    let postedText = "";
    const timeEl = card.querySelector("time[datetime]");
    if (timeEl) {
      postedAt = timeEl.getAttribute("datetime") || "";
      postedText = txt(timeEl);
    }
    if (!postedText) {
      const m2 = txt(card).match(/((?:just now|yesterday|today)|\d+\s*\+?\s*(?:minute|min|hour|hr|day|week|month)s?\s+ago)/i);
      if (m2) postedText = m2[1];
    }

    byId.set(id, {
      url: "https://www.linkedin.com/jobs/view/" + id + "/",
      title: (title || "").slice(0, 300),
      company: (company || "").slice(0, 200),
      location: (location || "").slice(0, 200),
      postedAt: postedAt || postedText,
      postedText,
      // LinkedIn renders the JD only in the right-hand pane on click, so a list
      // row NEVER carries a usable description → the JD pass opens the posting.
      description: "",
    });
  }

  return { signedIn: true, jobs: Array.from(byId.values()), note: "" };
}

// HANDSHAKE list scrape. Same structure-first approach: postings are addressed as
// /jobs/<id> (and the search route mirrors them at /job-search/<id>).
function scrapeHandshakeJobList() {
  const txt = (el) => ((el && (el.innerText || el.textContent)) || "").replace(/\s+/g, " ").trim();
  const pickIn = (root, sels) => {
    for (const s of sels) {
      try {
        const el = root.querySelector(s);
        const t = txt(el);
        if (t) return t;
      } catch (e) { /* skip */ }
    }
    return "";
  };

  const href = location.href || "";
  if (/\/(?:login|users\/sign_in|saml)/i.test(href)) {
    return { signedIn: false, jobs: [], note: "Handshake redirected to its sign-in page." };
  }

  const anchors = Array.from(document.querySelectorAll('a[href*="/jobs/"], a[href*="/job-search/"], a[href*="/postings/"]'));
  const byId = new Map();
  for (const a of anchors) {
    const m = (a.getAttribute("href") || "").match(/\/(?:jobs|job-search|postings)\/(\d+)/);
    if (!m) continue;
    const id = m[1];
    if (byId.has(id)) continue;

    let card = a.closest('[data-hook*="job"], [class*="JobCard"], [class*="job-card"], [role="listitem"], li, article');
    if (!card) card = a.parentElement || a;

    const title =
      pickIn(card, ['[data-hook="job-title"]', '[class*="title"]', "h1", "h2", "h3", "strong"]) ||
      (a.getAttribute("aria-label") || "").trim() ||
      txt(a);
    const company = pickIn(card, ['[data-hook="employer-name"]', '[class*="employer"]', '[class*="company"]', '[class*="subtitle"]']);
    const location = pickIn(card, ['[data-hook="job-location"]', '[class*="location"]', '[class*="city"]']);

    let postedAt = "";
    let postedText = "";
    const timeEl = card.querySelector("time[datetime]");
    if (timeEl) {
      postedAt = timeEl.getAttribute("datetime") || "";
      postedText = txt(timeEl);
    }
    if (!postedText) {
      const m2 = txt(card).match(/((?:just now|yesterday|today)|\d+\s*\+?\s*(?:minute|min|hour|hr|day|week|month)s?\s+ago)/i);
      if (m2) postedText = m2[1];
    }

    byId.set(id, {
      url: "https://app.joinhandshake.com/jobs/" + id,
      title: (title || "").slice(0, 300),
      company: (company || "").slice(0, 200),
      location: (location || "").slice(0, 200),
      postedAt: postedAt || postedText,
      postedText,
      description: "",
    });
  }

  if (!byId.size) {
    const signIn = document.querySelector('form[action*="sign_in"], input[type="password"]');
    return {
      signedIn: !signIn,
      jobs: [],
      note: signIn
        ? "Handshake is showing its sign-in page."
        : "No job rows found on the Handshake results page (the layout may have changed — run Discover recon).",
    };
  }
  return { signedIn: true, jobs: Array.from(byId.values()), note: "" };
}

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

  return {
    title: (title || "").slice(0, 300),
    company: (company || "").slice(0, 200),
    text: (body || "").replace(/\n{3,}/g, "\n\n").slice(0, 20000),
    url: location.href,
  };
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
    'a[href*="/jobs/view/"]', "[data-job-id]", "[data-occludable-job-id]",
    "li.jobs-search-results__list-item", "div.job-card-container", ".artdeco-entity-lockup__title",
    'a[href*="/jobs/"]', 'a[href*="/job-search/"]', '[data-hook*="job"]',
    '[class*="JobCard"]', '[class*="job-card"]', '[role="listitem"]',
    "time[datetime]", 'input[type="password"]', "article", "main",
  ];
  const counts = {};
  for (const p of probes) counts[p] = count(p);

  // One representative card's markup (trimmed) — the highest-value artifact: it
  // shows the REAL class names for title/company/location/date on this account.
  let sample = "";
  const anchor = document.querySelector('a[href*="/jobs/view/"], a[href*="/job-search/"], a[href*="/jobs/"]');
  if (anchor) {
    const card =
      anchor.closest('[data-job-id], [data-occludable-job-id], [class*="JobCard"], [class*="job-card"], [role="listitem"], li, article') ||
      anchor.parentElement ||
      anchor;
    sample = (card.outerHTML || "").slice(0, 4000);
  }

  return {
    url: location.href,
    title: document.title || "",
    counts,
    sample,
    bodyStart: ((document.body && document.body.innerText) || "").replace(/\s+/g, " ").slice(0, 600),
  };
}

// ── Service-worker orchestration (chrome APIs) ──────────────────────────────

// Progress → the website's live Run port (background.js owns it). Defensive: a
// popup-triggered discovery runs before/without any port and must still work.
function discoverProgress(phase, detail) {
  try {
    if (typeof emitRunProgress === "function") emitRunProgress(phase, detail);
    else console.log(`[ApplyPilot][DISCOVER] » ${phase}${detail ? " — " + detail : ""}`);
  } catch (e) { /* never let telemetry break a sweep */ }
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
async function discoverReadPage(tabId, fn, args) {
  const argv = args || [];
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId }, func: fn, args: argv });
    const value = results && results[0] ? results[0].result : undefined;
    if (value !== undefined) return value;
  } catch (e) {
    // No host permission for this origin (the common case for employer ATS
    // pages) — fall through to CDP.
  }
  const att = await cdpAttach(tabId);
  if (!att || !att.ok) throw new Error("cdp attach failed: " + ((att && att.error) || "unknown"));
  try {
    return await cdpEval(fn, ...argv);
  } finally {
    await cdpDetach();
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
  const jobs = simplifyListingsToJobs(listings, {
    nowMs: o.nowMs,
    sinceDays: o.sinceDays,
    query: o.query,
    termPattern: o.termPattern,
    maxItems: o.maxPerSource,
  });
  return { jobs, note: "", scanned: Array.isArray(listings) ? listings.length : 0 };
}

// SOURCE 2/3 — a logged-in board read out of a real tab. Same shape for both, so
// one function with the URL + scraper injected.
async function discoverFromBoard(source, url, scraper, opts) {
  const o = opts || {};
  discoverProgress(`Checking ${source}`, "in your signed-in session");
  try {
    return await withDiscoverTab(url, { background: o.background !== false, settleMs: 3000 }, async (tabId) => {
      await discoverAutoScroll(tabId, o.scrollRounds != null ? o.scrollRounds : 3);
      const out = await discoverReadPage(tabId, scraper);
      if (!out || typeof out !== "object") {
        return { jobs: [], note: `${source}: the page returned nothing readable.`, scanned: 0 };
      }
      if (out.signedIn === false) {
        return {
          jobs: [],
          note: `${source}: you're not signed in — sign in to ${source} in this Chrome profile, then run Discover again.`,
          scanned: 0,
          signedOut: true,
        };
      }
      const now = typeof o.nowMs === "number" ? o.nowMs : Date.now();
      const jobs = [];
      for (const raw of out.jobs || []) {
        const job = normalizeDiscoveredJob(raw, source, now);
        if (!job) continue;
        if (!isFreshPosting(job.postedAt, o.sinceDays, now)) continue;
        if (!matchesDiscoverQuery(job, o.query)) continue;
        jobs.push(job);
      }
      jobs.sort(comparePostedDesc);
      return {
        jobs: jobs.slice(0, o.maxPerSource || DISCOVER_DEFAULTS.maxPerSource),
        note: out.note || "",
        scanned: (out.jobs || []).length,
      };
    });
  } catch (e) {
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
  const need = (jobs || []).filter((j) => j && !j.description);
  const total = Math.min(need.length, budget);
  if (!total) return { opened, failed, skipped: need.length };

  for (const job of need) {
    if (opened >= budget) break;
    opened++;
    discoverProgress(
      `Reading job descriptions (${opened}/${total})`,
      `${job.company || ""}${job.company && job.title ? " — " : ""}${job.title || job.url}`
    );
    try {
      const jd = await withDiscoverTab(job.url, { background: o.background !== false, settleMs: 2500 }, (tabId) =>
        discoverReadPage(tabId, scrapeJobPosting)
      );
      if (jd && jd.text) {
        job.description = String(jd.text).slice(0, 20000);
        job.descriptionSource = "page";
        // The posting page is a BETTER source for title/company than a list row's
        // truncated text — but only fill gaps, never overwrite a value the board
        // already gave us (the board's company name is the cleaner one).
        if (!job.title && jd.title) job.title = String(jd.title).slice(0, 300);
        if (!job.company && jd.company) job.company = String(jd.company).slice(0, 200);
      } else {
        failed++;
      }
    } catch (e) {
      failed++;
      console.log(`[ApplyPilot][DISCOVER] JD scrape failed for ${job.url}: ${String((e && e.message) || e)}`);
    }
    await discoverDelay(o.betweenJdMs != null ? o.betweenJdMs : 600); // be a polite client
  }
  return { opened, failed, skipped: Math.max(0, need.length - opened) };
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

  console.log(
    `[ApplyPilot][DISCOVER] sweep start — sources ${Object.keys(want).filter((k) => want[k]).join("+") || "none"}, ` +
    `last ${o.sinceDays}d, query "${o.query || "(any)"}", ${(o.knownKeys || []).length} already known`
  );

  // Stable source order → deterministic cross-board dedup (first wins). Simplify
  // leads because its rows carry the employer's real ATS url, which is the key
  // that lines up with the tracker.
  if (want.simplify) {
    const r = await discoverFromSimplify({ ...o, nowMs: now });
    if (r.note) notes.push(r.note);
    scanned.simplify = r.scanned;
    all = all.concat(r.jobs);
  }
  if (want.linkedin) {
    const r = await discoverFromBoard("linkedin", discoverLinkedInSearchUrl(o.query, o.sinceDays), scrapeLinkedInJobList, { ...o, nowMs: now });
    if (r.note) notes.push(r.note);
    scanned.linkedin = r.scanned;
    all = all.concat(r.jobs);
  }
  if (want.handshake) {
    const r = await discoverFromBoard("handshake", discoverHandshakeSearchUrl(o.query), scrapeHandshakeJobList, { ...o, nowMs: now });
    if (r.note) notes.push(r.note);
    scanned.handshake = r.scanned;
    all = all.concat(r.jobs);
  }

  const found = all.length;
  const { jobs: fresh, skippedKnown, skippedDupe } = dedupeDiscovered(all, o.knownKeys);
  fresh.sort(comparePostedDesc);
  const capped = fresh.slice(0, o.maxTotal);
  const droppedByCap = fresh.length - capped.length;
  if (droppedByCap > 0) {
    // NO SILENT CAPS — say what was left behind, or "found 60" reads as "that's all there is".
    notes.push(`${droppedByCap} more new job${droppedByCap === 1 ? "" : "s"} matched but were left out by the ${o.maxTotal}-job cap — raise it or narrow the keyword.`);
  }

  const jd = await fillMissingDescriptions(capped, { ...o });
  if (jd.skipped > 0) {
    notes.push(`${jd.skipped} job${jd.skipped === 1 ? "" : "s"} were queued without a description (the ${o.maxJdOpens}-page read cap).`);
  }
  if (jd.failed > 0) {
    notes.push(`${jd.failed} job page${jd.failed === 1 ? "" : "s"} didn't yield a description — queued anyway.`);
  }

  const summary = summarizeDiscovery(capped);
  console.log(
    `[ApplyPilot][DISCOVER] done — scanned ${JSON.stringify(scanned)}, found ${found}, ` +
    `${skippedKnown} already known, ${skippedDupe} cross-board dupes, ${capped.length} new ` +
    `(${JSON.stringify(summary.bySource)}), JDs read ${jd.opened - jd.failed}/${jd.opened}`
  );
  discoverProgress("Discovery finished", `${capped.length} new job${capped.length === 1 ? "" : "s"}`);

  return {
    ok: true,
    jobs: capped,
    stats: {
      scanned,
      found,
      skippedKnown,
      skippedDupe,
      droppedByCap,
      newJobs: capped.length,
      bySource: summary.bySource,
      jdOpened: jd.opened,
      jdFailed: jd.failed,
      jdSkipped: jd.skipped,
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
  if (want.linkedin) targets.push(["linkedin", discoverLinkedInSearchUrl(o.query, o.sinceDays)]);
  if (want.handshake) targets.push(["handshake", discoverHandshakeSearchUrl(o.query)]);

  for (const [name, url] of targets) {
    discoverProgress(`Recon: ${name}`);
    try {
      out[name] = await withDiscoverTab(url, { background: o.background !== false, settleMs: 3500 }, async (tabId) => {
        await discoverAutoScroll(tabId, 1);
        return await discoverReadPage(tabId, dumpDiscoverRecon);
      });
    } catch (e) {
      out[name] = { error: String((e && e.message) || e) };
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
    discoverLinkedInSearchUrl,
    discoverHandshakeSearchUrl,
    discoveryJobKey,
    parsePostedTimestamp,
    isFreshPosting,
    matchesDiscoverQuery,
    normalizeDiscoveredJob,
    simplifyListingsToJobs,
    comparePostedDesc,
    dedupeDiscovered,
    summarizeDiscovery,
  };
}
