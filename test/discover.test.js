// Unit tests for the PURE half of discover.js — the job-discovery sweep's
// identity/recency/dedup logic. The scrapers and the tab orchestration need a
// real page + chrome, so they're exercised by the recon harness instead; this
// pins the decisions that would silently corrupt a sweep:
//   - a job key that DISAGREES with the tracker's would re-queue applied jobs
//   - an unknown posted date must NOT silently drop a real posting
//   - "0 new" must be distinguishable from "0 found"
//   - a closed (inactive) Simplify row must never reach the queue

const test = require("node:test");
const assert = require("node:assert");

const {
  discoveryJobKey,
  parsePostedTimestamp,
  isFreshPosting,
  matchesDiscoverQuery,
  normalizeDiscoveredJob,
  simplifyListingsToJobs,
  dedupeDiscovered,
  summarizeDiscovery,
  comparePostedDesc,
  discoverLinkedInSearchUrl,
  discoverHandshakeSearchUrl,
  buildDiscoverQuery,
  discoverTermLabel,
  discoverKeywordTokens,
  matchesDiscoverLocation,
  isBoardUrl,
  DISCOVER_DEFAULTS,
  DISCOVER_DEFAULT_LOCATION,
} = require("../discover.js");
const { canonicalJobUrl } = require("../lib.js");

const DAY = 86400e3;
const NOW = Date.UTC(2026, 6, 26, 12, 0, 0); // 2026-07-26T12:00:00Z

// ── discoveryJobKey ─────────────────────────────────────────────────────────

test("discoveryJobKey: a Workday posting keys IDENTICALLY to the tracker's canonicalJobUrl", () => {
  // THE load-bearing invariant. A job discovered on the Simplify board links to
  // the employer's real Workday url; after the operator applies, the tracker
  // stores canonicalJobUrl of the (different) form url. If these two disagree,
  // "jobs I haven't applied to" silently re-queues jobs already applied to.
  const posting = "https://costar.wd1.myworkdayjobs.com/Costar_Campus/job/Sunnyvale/Summer-2026-Technology-Intern---Sunnyvale--CA_R37008";
  const formUrl = "https://wd1.myworkdaysite.com/en-US/recruiting/costar/Costar_Campus/job/Sunnyvale/Summer-2026-Technology-Intern_R37008/apply/applyManually";
  assert.equal(discoveryJobKey(posting), canonicalJobUrl(posting));
  assert.equal(discoveryJobKey(posting), "wd1:r37008");
  // …and the two hosts collapse to the SAME job.
  assert.equal(discoveryJobKey(formUrl), discoveryJobKey(posting));
});

test("discoveryJobKey: LinkedIn keys on the posting id, from either URL shape", () => {
  assert.equal(discoveryJobKey("https://www.linkedin.com/jobs/view/4123456789/"), "linkedin:4123456789");
  assert.equal(
    discoveryJobKey("https://www.linkedin.com/jobs/view/4123456789/?alternateChannel=search&refId=abc"),
    "linkedin:4123456789"
  );
  // The search page addresses the same posting via a query param.
  assert.equal(
    discoveryJobKey("https://www.linkedin.com/jobs/search/?currentJobId=4123456789&keywords=intern"),
    "linkedin:4123456789"
  );
});

test("discoveryJobKey: Handshake collapses /jobs/<id> and /job-search/<id> to one job", () => {
  assert.equal(discoveryJobKey("https://app.joinhandshake.com/jobs/9876543"), "handshake:9876543");
  assert.equal(
    discoveryJobKey("https://app.joinhandshake.com/job-search/9876543?query=intern&sort=created_at_desc"),
    "handshake:9876543"
  );
});

test("discoveryJobKey: the common ATS boards key on company + posting id", () => {
  assert.equal(
    discoveryJobKey("https://boards.greenhouse.io/acme/jobs/4567890?gh_src=abc"),
    "greenhouse:acme:4567890"
  );
  assert.equal(
    discoveryJobKey("https://jobs.lever.co/acme/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"),
    "lever:acme:0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"
  );
  assert.equal(
    discoveryJobKey("https://jobs.ashbyhq.com/mercor/11516609-e54b-4087-87c2-e84a8bafbb5a"),
    "ashby:mercor:11516609-e54b-4087-87c2-e84a8bafbb5a"
  );
});

test("discoveryJobKey: an unknown board falls back to the tracker's generic key", () => {
  const u = "https://fa-essf-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/10003905?x=1";
  assert.equal(discoveryJobKey(u), canonicalJobUrl(u));
});

test("discoveryJobKey: empty / junk input never throws", () => {
  assert.equal(discoveryJobKey(""), "");
  assert.equal(discoveryJobKey(null), "");
  assert.equal(discoveryJobKey("not a url"), "not a url");
});

// ── parsePostedTimestamp ────────────────────────────────────────────────────

test("parsePostedTimestamp: unix SECONDS (the Simplify feed) and milliseconds", () => {
  assert.equal(parsePostedTimestamp(1764346884, NOW), 1764346884000);
  assert.equal(parsePostedTimestamp(1764346884000, NOW), 1764346884000);
  assert.equal(parsePostedTimestamp("1764346884", NOW), 1764346884000);
});

test("parsePostedTimestamp: relative prose from a board list row", () => {
  assert.equal(parsePostedTimestamp("2 days ago", NOW), NOW - 2 * DAY);
  assert.equal(parsePostedTimestamp("Reposted 3 hours ago", NOW), NOW - 3 * 3600e3);
  assert.equal(parsePostedTimestamp("just now", NOW), NOW);
  assert.equal(parsePostedTimestamp("Yesterday", NOW), NOW - DAY);
  assert.equal(parsePostedTimestamp("1 week ago", NOW), NOW - 7 * DAY);
});

test("parsePostedTimestamp: '30+ days ago' floors at 30 days (can only look OLDER, never fresher)", () => {
  assert.equal(parsePostedTimestamp("30+ days ago", NOW), NOW - 30 * DAY);
});

test("parsePostedTimestamp: ISO dates, and null for genuinely unknown", () => {
  assert.equal(parsePostedTimestamp("2026-07-20T00:00:00.000Z", NOW), Date.parse("2026-07-20T00:00:00.000Z"));
  assert.equal(parsePostedTimestamp("", NOW), null);
  assert.equal(parsePostedTimestamp(null, NOW), null);
  assert.equal(parsePostedTimestamp("sometime recently", NOW), null);
  assert.equal(parsePostedTimestamp(0, NOW), null);
});

// ── isFreshPosting ──────────────────────────────────────────────────────────

test("isFreshPosting: inside the window is fresh, outside is not", () => {
  assert.equal(isFreshPosting(NOW - 2 * DAY, 7, NOW), true);
  assert.equal(isFreshPosting(NOW - 9 * DAY, 7, NOW), false);
  assert.equal(isFreshPosting(NOW, 7, NOW), true);
});

test("isFreshPosting: an UNKNOWN date counts as fresh (never silently drop a real posting)", () => {
  // Every source is already time-bounded upstream, so an unparseable date is far
  // more likely a parse gap than a stale job. Dropping it would hide real jobs
  // in a way the operator can never see; including it costs one reviewable row.
  assert.equal(isFreshPosting(null, 7, NOW), true);
  assert.equal(isFreshPosting(undefined, 1, NOW), true);
});

test("isFreshPosting: a nonsense window disables filtering rather than dropping everything", () => {
  assert.equal(isFreshPosting(NOW - 900 * DAY, 0, NOW), true);
  assert.equal(isFreshPosting(NOW - 900 * DAY, NaN, NOW), true);
});

// ── matchesDiscoverQuery ────────────────────────────────────────────────────

test("matchesDiscoverQuery: ANY meaningful token matches — AND silently dropped correct hits", () => {
  // 2026-07-29 fix. This sieve runs ONLY on the Simplify feed (LinkedIn/Handshake
  // are filtered by the board itself). AND-ing every token of a phrase against a
  // row's SHORT title/company/category threw away real hits: searching
  // "electrical and computer engineering intern" demanded "electrical" appear in a
  // row reading title "Engineering Intern", category "Hardware".
  const job = { title: "Engineering Intern", company: "Acme", location: "Remote", category: "Hardware" };
  assert.equal(matchesDiscoverQuery(job, ""), true);
  assert.equal(matchesDiscoverQuery(job, "electrical and computer engineering intern"), true,
    "one meaningful token (engineering) is enough");
  assert.equal(matchesDiscoverQuery(job, "ACME"), true); // case-insensitive
  // Nothing relevant at all still misses.
  assert.equal(matchesDiscoverQuery(job, "quantitative finance"), false);
});

test("discoverKeywordTokens: drops stopwords, the role word, and too-short tokens", () => {
  assert.deepEqual(
    discoverKeywordTokens("electrical and computer engineering intern"),
    ["electrical", "computer", "engineering"],
    "'and' is a stopword and 'intern' carries no signal on an internships board"
  );
  assert.deepEqual(discoverKeywordTokens("internship"), []);
  assert.deepEqual(discoverKeywordTokens("AI ML"), [], "2-char tokens match far too much");
  assert.deepEqual(discoverKeywordTokens(""), []);
});

test("matchesDiscoverLocation: whole-country matches everything; a specific place filters", () => {
  const sf = { location: "San Francisco, CA" };
  const remote = { location: "Remote" };
  // The board rows carry no country, so filtering literally on "United States"
  // would drop every row — the whole-country default must be a pass-through.
  assert.equal(matchesDiscoverLocation(sf, ""), true);
  assert.equal(matchesDiscoverLocation(sf, DISCOVER_DEFAULT_LOCATION), true);
  assert.equal(matchesDiscoverLocation(sf, "San Francisco"), true);
  assert.equal(matchesDiscoverLocation(sf, "Austin"), false);
  assert.equal(matchesDiscoverLocation(remote, "Austin"), true, "remote always qualifies");
  assert.equal(matchesDiscoverLocation({ location: "" }, "Austin"), true, "unknown location: surface, don't hide");
});

// ── buildDiscoverQuery — the "don't search the recommended feed" fix ─────────

test("buildDiscoverQuery: explicit keywords win, and intern is appended once", () => {
  const r = buildDiscoverQuery({ query: "electrical and computer engineering", intern: true });
  assert.equal(r.keywords, "electrical and computer engineering intern");
  assert.equal(r.derivedFrom, "your keywords");
  // Already says intern ⇒ don't say it twice.
  assert.equal(buildDiscoverQuery({ query: "software intern", intern: true }).keywords, "software intern");
  assert.equal(buildDiscoverQuery({ query: "Software Internship", intern: true }).keywords, "Software Internship");
});

test("buildDiscoverQuery: a BLANK box derives from the field of study, not nothing", () => {
  // The operator's point: "If the user doesn't give something specific you should
  // look for specific jobs." Blank used to mean a keyword-less URL = the
  // recommended feed; now it means "derive something specific".
  const r = buildDiscoverQuery({ query: "", field: "Electrical and Computer Engineering", intern: true });
  assert.equal(r.keywords, "Electrical and Computer Engineering intern");
  assert.equal(r.derivedFrom, "your field of study");
});

test("buildDiscoverQuery: intern off leaves the role word out", () => {
  assert.equal(buildDiscoverQuery({ query: "data engineering", intern: false }).keywords, "data engineering");
  assert.equal(buildDiscoverQuery({ field: "Computer Science", intern: false }).keywords, "Computer Science");
});

test("buildDiscoverQuery: nothing to go on ⇒ 'intern' alone, and never a blank search", () => {
  const r = buildDiscoverQuery({ intern: true });
  assert.equal(r.keywords, "intern");
  // With intern OFF and no field/query there is genuinely nothing — the caller
  // must REFUSE rather than run a keyword-less board search.
  assert.equal(buildDiscoverQuery({ intern: false }).keywords, "");
});

test("discoverTermLabel: season + year → the Simplify feed's own `terms` wording", () => {
  assert.equal(discoverTermLabel("summer", "2026"), "Summer 2026");
  assert.equal(discoverTermLabel("Fall", "2026"), "Fall 2026");
  assert.equal(discoverTermLabel("summer", ""), "Summer");
  assert.equal(discoverTermLabel("", "2026"), "2026");
  assert.equal(discoverTermLabel("", ""), "");
  assert.equal(discoverTermLabel("nonsense", "2026"), "2026", "an unknown season is ignored, not injected");
});

test("discoverTermLabel feeds an EXACT Simplify filter (its rows carry the season verbatim)", () => {
  const rows = [
    { company_name: "A", title: "SWE Intern", url: "https://x.test/a", terms: ["Summer 2026"], active: true, is_visible: true, date_posted: Math.floor((NOW - DAY) / 1000) },
    { company_name: "B", title: "SWE Intern", url: "https://x.test/b", terms: ["Fall 2026"], active: true, is_visible: true, date_posted: Math.floor((NOW - DAY) / 1000) },
  ];
  const summer = simplifyListingsToJobs(rows, { nowMs: NOW, sinceDays: 7, termPattern: discoverTermLabel("summer", "2026") });
  assert.deepEqual(summer.map((j) => j.company), ["A"]);
  const fall = simplifyListingsToJobs(rows, { nowMs: NOW, sinceDays: 7, termPattern: discoverTermLabel("fall", "2026") });
  assert.deepEqual(fall.map((j) => j.company), ["B"]);
});

// ── normalizeDiscoveredJob ──────────────────────────────────────────────────

test("normalizeDiscoveredJob: stamps the key, flags an unknown date, tags the description source", () => {
  const job = normalizeDiscoveredJob(
    { url: "https://www.linkedin.com/jobs/view/42/", title: "Intern", company: "Acme", postedAt: "2 days ago" },
    "linkedin",
    NOW
  );
  assert.equal(job.jobKey, "linkedin:42");
  assert.equal(job.source, "linkedin");
  assert.equal(job.postedAt, NOW - 2 * DAY);
  assert.equal(job.postedUnknown, false);
  assert.equal(job.description, "");
  assert.equal(job.descriptionSource, ""); // no description ⇒ no source claim

  const unknown = normalizeDiscoveredJob({ url: "https://x.test/job/1", title: "T" }, "handshake", NOW);
  assert.equal(unknown.postedAt, null);
  assert.equal(unknown.postedUnknown, true);
});

test("normalizeDiscoveredJob: a row with no URL is dropped (nothing to queue or key)", () => {
  assert.equal(normalizeDiscoveredJob({ title: "No link" }, "linkedin", NOW), null);
  assert.equal(normalizeDiscoveredJob({ url: "   " }, "linkedin", NOW), null);
});

// ── simplifyListingsToJobs ──────────────────────────────────────────────────

const SIMPLIFY_ROWS = [
  {
    company_name: "Mercor", title: "Data Science Intern", category: "Data Science, AI & Machine Learning",
    url: "https://jobs.ashbyhq.com/mercor/11516609-e54b-4087-87c2-e84a8bafbb5a",
    locations: ["San Francisco, CA"], terms: ["Summer 2026"], active: true, is_visible: true,
    date_posted: Math.floor((NOW - 1 * DAY) / 1000),
  },
  {
    company_name: "ClosedCo", title: "Software Engineer Intern", url: "https://boards.greenhouse.io/closedco/jobs/1",
    locations: ["Remote"], terms: ["Summer 2026"], active: false, is_visible: true,
    date_posted: Math.floor((NOW - 1 * DAY) / 1000),
  },
  {
    company_name: "HiddenCo", title: "Software Engineer Intern", url: "https://boards.greenhouse.io/hiddenco/jobs/2",
    locations: ["Remote"], terms: ["Summer 2026"], active: true, is_visible: false,
    date_posted: Math.floor((NOW - 1 * DAY) / 1000),
  },
  {
    company_name: "StaleCo", title: "Software Engineer Intern", url: "https://boards.greenhouse.io/staleco/jobs/3",
    locations: ["Remote"], terms: ["Summer 2026"], active: true, is_visible: true,
    date_posted: Math.floor((NOW - 40 * DAY) / 1000),
  },
  {
    company_name: "WrongSeason", title: "Software Engineer Intern", url: "https://boards.greenhouse.io/wrongseason/jobs/4",
    locations: ["Remote"], terms: ["Winter 2025"], active: true, is_visible: true,
    date_posted: Math.floor((NOW - 1 * DAY) / 1000),
  },
  {
    company_name: "CoStar Group", title: "Technology Intern", category: "Software",
    url: "https://costar.wd1.myworkdayjobs.com/Costar_Campus/job/Sunnyvale/Summer-2026-Technology-Intern_R37008",
    locations: ["Sunnyvale, CA"], terms: ["Summer 2026"], active: true, is_visible: true,
    date_posted: Math.floor((NOW - 3 * DAY) / 1000),
  },
];

test("simplifyListingsToJobs: only LIVE, in-season, in-window rows survive", () => {
  const jobs = simplifyListingsToJobs(SIMPLIFY_ROWS, { nowMs: NOW, sinceDays: 7, termPattern: "2026" });
  const names = jobs.map((j) => j.company);
  assert.deepEqual(names, ["Mercor", "CoStar Group"]); // newest first
  // inactive / hidden / stale / wrong-season are all gone
  for (const bad of ["ClosedCo", "HiddenCo", "StaleCo", "WrongSeason"]) {
    assert.ok(!names.includes(bad), `${bad} should be filtered out`);
  }
});

test("simplifyListingsToJobs: maps the feed's field names and keys Workday rows for the tracker", () => {
  const jobs = simplifyListingsToJobs(SIMPLIFY_ROWS, { nowMs: NOW, sinceDays: 7, termPattern: "2026" });
  const costar = jobs.find((j) => j.company === "CoStar Group");
  assert.equal(costar.title, "Technology Intern");
  assert.equal(costar.location, "Sunnyvale, CA"); // locations[] joined
  assert.equal(costar.source, "simplify");
  assert.equal(costar.jobKey, "wd1:r37008");      // lines up with the tracker
  assert.equal(costar.description, "");            // the feed carries no JD → the JD pass opens it
});

test("simplifyListingsToJobs: honors the keyword filter and the per-source cap", () => {
  const ds = simplifyListingsToJobs(SIMPLIFY_ROWS, { nowMs: NOW, sinceDays: 7, termPattern: "2026", keywords: "data science" });
  assert.deepEqual(ds.map((j) => j.company), ["Mercor"]);
  const capped = simplifyListingsToJobs(SIMPLIFY_ROWS, { nowMs: NOW, sinceDays: 7, termPattern: "2026", maxItems: 1 });
  assert.equal(capped.length, 1);
  assert.equal(capped[0].company, "Mercor"); // the cap keeps the NEWEST
});

test("simplifyListingsToJobs: a garbage feed yields nothing rather than throwing", () => {
  assert.deepEqual(simplifyListingsToJobs(null, { nowMs: NOW }), []);
  assert.deepEqual(simplifyListingsToJobs([null, 3, "x", {}], { nowMs: NOW, termPattern: "2026" }), []);
});

// ── dedupeDiscovered ────────────────────────────────────────────────────────

test("dedupeDiscovered: drops already-applied/queued jobs and reports WHY", () => {
  const jobs = [
    { url: "https://www.linkedin.com/jobs/view/1/", jobKey: "linkedin:1" },
    { url: "https://www.linkedin.com/jobs/view/2/", jobKey: "linkedin:2" },
  ];
  const r = dedupeDiscovered(jobs, ["linkedin:1"]);
  assert.equal(r.jobs.length, 1);
  assert.equal(r.jobs[0].jobKey, "linkedin:2");
  assert.equal(r.skippedKnown, 1);
  assert.equal(r.skippedDupe, 0);
});

test("dedupeDiscovered: the same job on two boards collapses — first source wins", () => {
  const wd = "https://costar.wd1.myworkdayjobs.com/Costar_Campus/job/X_R37008";
  const jobs = [
    { url: wd, source: "simplify" },
    { url: wd + "/apply", source: "linkedin" }, // same requisition, different link
  ];
  const r = dedupeDiscovered(jobs, []);
  assert.equal(r.jobs.length, 1);
  assert.equal(r.jobs[0].source, "simplify"); // stable source order → deterministic
  assert.equal(r.skippedDupe, 1);
});

test("dedupeDiscovered: computes a missing key rather than trusting the caller", () => {
  const r = dedupeDiscovered([{ url: "https://www.linkedin.com/jobs/view/7/" }], []);
  assert.equal(r.jobs[0].jobKey, "linkedin:7");
});

test("dedupeDiscovered: empty inputs are safe", () => {
  const r = dedupeDiscovered([], null);
  assert.deepEqual(r.jobs, []);
  assert.equal(r.skippedKnown, 0);
});

// ── ranking + summary + search URLs ─────────────────────────────────────────

test("comparePostedDesc: newest first, unknown dates LAST", () => {
  const jobs = [
    { company: "unknown", postedAt: null },
    { company: "old", postedAt: NOW - 5 * DAY },
    { company: "new", postedAt: NOW - 1 * DAY },
  ];
  jobs.sort(comparePostedDesc);
  assert.deepEqual(jobs.map((j) => j.company), ["new", "old", "unknown"]);
});

test("summarizeDiscovery: tallies per source", () => {
  const s = summarizeDiscovery([{ source: "simplify" }, { source: "simplify" }, { source: "linkedin" }]);
  assert.equal(s.total, 3);
  assert.deepEqual(s.bySource, { simplify: 2, linkedin: 1 });
});

test("discoverLinkedInSearchUrl: SOURCE-side recency (f_TPR), newest first, whole-country default", () => {
  const u = discoverLinkedInSearchUrl({ keywords: "software engineer intern", sinceDays: 7 });
  assert.ok(u.includes("f_TPR=r604800"), u); // 7 days in seconds
  assert.ok(u.includes("sortBy=DD"), u);
  assert.ok(u.includes("keywords=software%20engineer%20intern"), u);
  // No location given ⇒ the WHOLE COUNTRY, explicitly. Omitting the param lets a
  // signed-in session silently centre the search on the profile's own city.
  assert.ok(u.includes("location=United%20States"), u);
});

test("discoverLinkedInSearchUrl: an explicit location is honoured", () => {
  const u = discoverLinkedInSearchUrl({ keywords: "intern", sinceDays: 7, location: "Austin, Texas" });
  assert.ok(u.includes("location=Austin%2C%20Texas"), u);
});

test("discoverLinkedInSearchUrl: REFUSES a keyword-less search (that URL is the RECOMMENDED feed)", () => {
  // The 2026-07-29 bug: a blank keyword box built /jobs/search with no keywords,
  // which — signed in — renders LinkedIn's RECOMMENDED jobs. The sweep then queued
  // whatever LinkedIn suggested instead of the jobs being hunted. Empty now yields
  // NO url, and the caller reports the skip rather than scraping recommendations.
  assert.equal(discoverLinkedInSearchUrl({ keywords: "", sinceDays: 3 }), "");
  assert.equal(discoverLinkedInSearchUrl({ keywords: "   ", sinceDays: 3 }), "");
  assert.equal(discoverLinkedInSearchUrl({}), "");
});

test("discoverHandshakeSearchUrl: sorts newest-first, encodes the query, refuses empty", () => {
  const u = discoverHandshakeSearchUrl({ keywords: "data intern", location: "" });
  assert.ok(u.startsWith("https://app.joinhandshake.com/job-search"), u);
  assert.ok(u.includes("sort=created_at_desc"), u);
  assert.ok(u.includes("query=data%20intern"), u);
  assert.ok(u.includes("location=United%20States"), u);
  assert.equal(discoverHandshakeSearchUrl({ keywords: "" }), "");
});

test("DISCOVER_DEFAULTS: every expensive knob is bounded by default", () => {
  assert.ok(DISCOVER_DEFAULTS.maxPerSource > 0);
  assert.ok(DISCOVER_DEFAULTS.maxTotal > 0);
  assert.ok(DISCOVER_DEFAULTS.maxJdOpens > 0 && DISCOVER_DEFAULTS.maxJdOpens <= 25, "the tab-opening pass must stay modest");
  assert.ok(DISCOVER_DEFAULTS.sinceDays > 0);
});

// ── isBoardUrl — which links still need the employer's real URL ──────────────

test("isBoardUrl: board wrappers are flagged, employer/ATS links are not", () => {
  // The operator's ask: "save the real job link, not the linkedin apply." A board
  // url is a WRAPPER around someone else's application — Run can't drive it — so it
  // is the thing that must be rewritten (or, failing that, flagged).
  assert.equal(isBoardUrl("https://www.linkedin.com/jobs/view/4123456789/"), true);
  assert.equal(isBoardUrl("https://app.joinhandshake.com/jobs/987"), true);
  // An employer/ATS link IS already the real thing and must never be rewritten.
  assert.equal(isBoardUrl("https://costar.wd1.myworkdayjobs.com/x/job/Y_R37008"), false);
  assert.equal(isBoardUrl("https://boards.greenhouse.io/acme/jobs/1"), false);
  assert.equal(isBoardUrl("https://jobs.ashbyhq.com/mercor/abc"), false);
  assert.equal(isBoardUrl("not a url"), false);
  assert.equal(isBoardUrl(""), false);
});

test("a resolved employer link re-keys the job so it dedups against the tracker", () => {
  // This is the payoff of rewriting: a LinkedIn find whose real link is a Workday
  // requisition now keys IDENTICALLY to the application row written after applying,
  // so it stops coming back in later sweeps.
  const boardKey = discoveryJobKey("https://www.linkedin.com/jobs/view/4123456789/");
  assert.equal(boardKey, "linkedin:4123456789");
  const realKey = discoveryJobKey("https://costar.wd1.myworkdayjobs.com/x/job/Y_R37008");
  assert.equal(realKey, "wd1:r37008");
  assert.notEqual(boardKey, realKey);
  // …and dedupe drops it once the tracker already holds that requisition.
  const r = dedupeDiscovered([{ url: "https://costar.wd1.myworkdayjobs.com/x/job/Y_R37008" }], ["wd1:r37008"]);
  assert.equal(r.jobs.length, 0);
  assert.equal(r.skippedKnown, 1);
});

test("normalizeDiscoveredJob: carries the apply-resolution fields from the start", () => {
  const job = normalizeDiscoveredJob({ url: "https://www.linkedin.com/jobs/view/42/", title: "T" }, "linkedin", NOW);
  assert.equal(job.boardUrl, "");
  assert.equal(job.applyKind, "");
  assert.equal(job.applyResolved, false);
});
