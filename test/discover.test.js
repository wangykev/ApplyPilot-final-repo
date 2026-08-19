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
// The board-JSON contract + ranking helpers are reached through the module object
// so this list doesn't have to grow every time one is added.
const discoverMod = require("../discover.js");
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

// ── The LinkedIn SEARCH PAGE url ─────────────────────────────────────────────
// TRACED 2026-07-30 on the live signed-in page: the SDUI jobs page REWRITES its
// own url and keeps ONLY keywords / geoId / f_TPR. `location=` (free text),
// `sortBy=` and `f_E=` are silently DISCARDED, so emitting them was worse than
// useless — it read as "the search is sorted and located" when it was neither.

test("discoverLinkedInSearchUrl: emits ONLY the params the SDUI page actually keeps", () => {
  const u = discoverLinkedInSearchUrl({ keywords: "software engineer intern", sinceDays: 7 });
  assert.ok(u.includes("f_TPR=r604800"), u); // 7 days in seconds
  assert.ok(u.includes("keywords=software%20engineer%20intern"), u);
  // The three the page throws away must NOT be sent — see the note above.
  assert.ok(!u.includes("sortBy="), "sortBy is discarded by the page: " + u);
  assert.ok(!/[?&]location=/.test(u), "free-text location is discarded by the page: " + u);
  assert.ok(!u.includes("f_E="), "f_E is discarded by the page: " + u);
});

test("discoverLinkedInSearchUrl: a resolved geoId is the ONLY location form it emits", () => {
  const withGeo = discoverLinkedInSearchUrl({ keywords: "intern", sinceDays: 7, geoId: "103644278" });
  assert.ok(withGeo.includes("geoId=103644278"), withGeo);
  // A place NAME is not a geoId and must never be smuggled in as one — the API
  // returns HTTP 500 for a name, and the page ignores it.
  const withName = discoverLinkedInSearchUrl({ keywords: "intern", sinceDays: 7, geoId: "Austin, Texas" });
  assert.ok(!withName.includes("geoId="), withName);
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

test("discoverHandshakeSearchUrl: the TRACED page params, and a VALID sort value", () => {
  const u = discoverHandshakeSearchUrl({ keywords: "data intern" });
  assert.ok(u.startsWith("https://app.joinhandshake.com/job-search"), u);
  assert.ok(u.includes("query=data%20intern"), u);
  assert.ok(u.includes("per_page=25"), u);
  assert.ok(u.includes("page=1"), u);
  // ⚠ REGRESSION GUARD. Handshake's sort vocabulary is a closed set read off its
  // own <select>; an INVENTED value ("created_at_desc", which this used to send)
  // does not get ignored — it renders Handshake's "Something went wrong" page and
  // the sweep returns zero jobs. Only its real values may ever appear here.
  assert.ok(u.includes("sort=posted_date_desc"), u);
  assert.ok(!u.includes("created_at_desc"), "created_at_desc is NOT a Handshake sort value: " + u);
  assert.equal(discoverHandshakeSearchUrl({ keywords: "" }), "");
});

test("discoverHandshakeSearchUrl: internship filter + paging + the opaque location blob", () => {
  const u = discoverHandshakeSearchUrl({ keywords: "intern", internshipOnly: true, page: 3, perPage: 25 });
  assert.ok(u.includes("jobType=3"), u); // traced: 62,820 → 4,989 results
  assert.ok(u.includes("page=3"), u);
  // locationFilter is a JSON blob produced by Handshake's OWN typeahead; it is
  // passed through verbatim (url-encoded) and never constructed here.
  const blob = '{"id":"place.15042796","label":"Austin, Texas, United States","distance":"50mi"}';
  const withLoc = discoverHandshakeSearchUrl({ keywords: "intern", locationFilter: blob });
  assert.ok(withLoc.includes("locationFilter=" + encodeURIComponent(blob)), withLoc);
});

// ── The LinkedIn JSON search url ─────────────────────────────────────────────

test("linkedInApiSearchUrl: RELEVANCE by default, and REQUIRES a numeric geoId", () => {
  const u = discoverMod.linkedInApiSearchUrl({ keywords: "intern", geoId: "103644278", sinceDays: 1 });
  assert.ok(u.includes("q=jobSearch"), u);
  assert.ok(u.includes("timePostedRange:List(r86400)"), u);
  assert.ok(u.includes("locationUnion:(geoId:103644278)"), u);

  // ⚠ REGRESSION GUARD, and a mistake worth not repeating. `sortBy:List(DD)` DOES
  // drop every promoted row, which made it look like a free win, so an earlier
  // version had it permanently on. Live, it also destroys keyword relevance:
  // "embedded software intern" came back as "EH&S Intern" / "Audit Intern" /
  // "Finance Intern" — the newest internships of ANY kind. On relevance the same
  // query returns Skydio, Anduril, Blue Origin avionics/embedded, Palantir.
  // Promoted rows are handled by scoreDiscovery's penalty instead.
  assert.ok(!u.includes("sortBy:List(DD)"), "date sort must NOT be the default: " + u);
  const dated = discoverMod.linkedInApiSearchUrl({ keywords: "intern", geoId: "1", sortByDate: true });
  assert.ok(dated.includes("sortBy:List(DD)"), "…but it stays available explicitly: " + dated);

  // No geoId ⇒ no url at all. `locationUnion:(locationName:…)` returns HTTP 500,
  // so guessing a name here would break the whole source rather than degrade it.
  assert.equal(discoverMod.linkedInApiSearchUrl({ keywords: "intern", geoId: "" }), "");
  assert.equal(discoverMod.linkedInApiSearchUrl({ keywords: "intern", geoId: "Austin" }), "");
  assert.equal(discoverMod.linkedInApiSearchUrl({ keywords: "", geoId: "103644278" }), "");
});

test("discoverLinkedInSearchUrl: `start` paginates the rendered page", () => {
  // Verified live: start=25 returns a DIFFERENT 25 postings and the param survives
  // the page's url rewrite. This is what lets a later sweep reach past what's
  // already queued instead of re-reading page 1 forever.
  const p1 = discoverMod.discoverLinkedInSearchUrl({ keywords: "intern", sinceDays: 7 });
  assert.ok(!p1.includes("start="), "page 1 sends no start: " + p1);
  const p2 = discoverMod.discoverLinkedInSearchUrl({ keywords: "intern", sinceDays: 7, start: 25 });
  assert.ok(p2.includes("start=25"), p2);
});

test("linkedInApiSearchUrl: the internship filter and start/count paging", () => {
  const intern = discoverMod.linkedInApiSearchUrl({ keywords: "intern", geoId: "1", internshipOnly: true });
  assert.ok(intern.includes("experience:List(1)"), intern); // traced: 127 → 25 results
  const plain = discoverMod.linkedInApiSearchUrl({ keywords: "intern", geoId: "1", internshipOnly: false });
  assert.ok(!plain.includes("experience:List"), plain);
  const p2 = discoverMod.linkedInApiSearchUrl({ keywords: "intern", geoId: "1", start: 25, count: 25 });
  assert.ok(p2.includes("start=25") && p2.includes("count=25"), p2);
  // count is clamped to what the endpoint actually serves.
  assert.ok(discoverMod.linkedInApiSearchUrl({ keywords: "i", geoId: "1", count: 500 }).includes("count=25"));
});

test("linkedInApiDetailUrl / handshakeDetailPath: numeric ids only", () => {
  assert.ok(discoverMod.linkedInApiDetailUrl("4445788818").includes("/jobPostings/4445788818"));
  assert.equal(discoverMod.linkedInApiDetailUrl("not-an-id"), "");
  assert.equal(discoverMod.linkedInApiDetailUrl(""), "");
  assert.equal(discoverMod.handshakeDetailPath("11244161"), "/stu/jobs/11244161.json");
  assert.equal(discoverMod.handshakeDetailPath("x"), "");
});

test("parseLinkedInGeoId: reads the token back off a LinkedIn url", () => {
  // This is how the geo resolver gets its answer: picking a suggestion in
  // LinkedIn's own location box rewrites the page url to carry geoId=<n>.
  assert.equal(discoverMod.parseLinkedInGeoId("https://www.linkedin.com/jobs/search-results/?keywords=x&geoId=104472865&f_TPR=r86400"), "104472865");
  assert.equal(discoverMod.parseLinkedInGeoId("https://www.linkedin.com/jobs/search-results/?keywords=x"), "");
  assert.equal(discoverMod.parseLinkedInGeoId(""), "");
});

test("locationVariants: a profile country that no board matches still resolves", () => {
  // The panel seeds the location from the profile's country, whose canonical value is
  // "United States of America" — and NEITHER board's typeahead matches that string
  // (both want "United States"). Live, that cost the location filter entirely on both
  // boards, so the sweep silently searched whatever location the session defaulted to.
  const v = discoverMod.locationVariants("United States of America");
  assert.equal(v[0], "United States of America", "the exact string is always tried first");
  assert.ok(v.includes("United States"), "…then the form the boards actually know: " + JSON.stringify(v));

  // A full "city, state, country" narrows down, not up.
  assert.deepEqual(discoverMod.locationVariants("Austin, Texas, United States"),
    ["Austin, Texas, United States", "Austin, Texas", "Austin"]);

  // Bounded and never empty-looping.
  assert.deepEqual(discoverMod.locationVariants(""), []);
  assert.deepEqual(discoverMod.locationVariants("   "), []);
  assert.ok(discoverMod.locationVariants("Austin, Texas, United States, Earth, Milky Way").length <= 3);
  // A single unambiguous place yields just itself — no wasted resolve attempts.
  assert.deepEqual(discoverMod.locationVariants("Seattle"), ["Seattle"]);
});

test("geoCacheKey: per-board, case/space insensitive", () => {
  assert.equal(discoverMod.geoCacheKey("linkedin", "Austin,  Texas"), discoverMod.geoCacheKey("LinkedIn", "austin, texas"));
  // The two boards' tokens are different things and must never share a slot.
  assert.notEqual(discoverMod.geoCacheKey("linkedin", "Austin"), discoverMod.geoCacheKey("handshake", "Austin"));
});

// ── The board payload adapters ───────────────────────────────────────────────
//
// The fixtures below are TRIMMED COPIES OF REAL RECORDS captured from the
// operator's signed-in session on 2026-07-30 (Draper/Intel on LinkedIn,
// CampusMesh on Handshake) — the shapes, key names and nesting are verbatim. That
// is the point: these tests fail if either board's payload contract drifts, which
// is the failure mode that would otherwise show up as a silently empty sweep.

const LI_CARD = {
  jobCardUnion: {
    jobPostingCard: {
      jobPostingUrn: "urn:li:fsd_jobPosting:4446423890",
      title: { text: "Embedded Software Engineer Intern - Fall 2026" },
      primaryDescription: { text: "Redwood Materials" },
      secondaryDescription: { text: "San Francisco, CA (On-site)" },
      footerItems: [
        { type: "LISTED_DATE", timeAt: 1785361537000 },
        { type: "APPLICANT_COUNT_TEXT", text: { text: "Be an early applicant" } },
      ],
    },
  },
};

test("linkedInCardToRaw: id from the urn, exact date from the TYPED footer", () => {
  const raw = discoverMod.linkedInCardToRaw(LI_CARD);
  assert.equal(raw.url, "https://www.linkedin.com/jobs/view/4446423890/");
  assert.equal(raw.title, "Embedded Software Engineer Intern - Fall 2026");
  assert.equal(raw.company, "Redwood Materials");
  assert.equal(raw.location, "San Francisco, CA (On-site)");
  // An EXACT epoch, not "10 hours ago" parsed backwards — the whole reason the
  // JSON is preferred over the rendered card.
  assert.equal(raw.postedAt, 1785361537000);
  assert.equal(raw.earlyApplicant, true);
  assert.equal(raw.promoted, false);
  assert.equal(discoverMod.linkedInCardToRaw({}), null);
  assert.equal(discoverMod.linkedInCardToRaw(null), null);
});

test("linkedInCardToRaw: PROMOTED is read off the footer, applicant counts parsed", () => {
  const promoted = {
    jobCardUnion: { jobPostingCard: {
      jobPostingUrn: "urn:li:fsd_jobPosting:1", title: { text: "T" },
      primaryDescription: { text: "C" }, secondaryDescription: { text: "L" },
      footerItems: [{ type: "PROMOTED" }, { type: "APPLICANT_COUNT_TEXT", text: { text: "1,234 applicants" } }],
    } },
  };
  const raw = discoverMod.linkedInCardToRaw(promoted);
  assert.equal(raw.promoted, true);
  assert.equal(raw.applicants, 1234);
  assert.equal(raw.earlyApplicant, false);
  assert.equal(raw.postedAt, null, "no LISTED_DATE ⇒ unknown, never 'now'");
});

test("linkedInFieldsFromLines: REGRESSION — a '(Verified job)' card must not shift every field", () => {
  // All three fixtures are VERBATIM live card text (2026-07-30). Shape A is the one
  // that broke: consecutive-dedupe left the a11y summary in place, so company took
  // the title's value and location took the company's — wrong data that still
  // looked plausible, on 2 of the first 5 cards.
  const A = ["Software Algorithm Embedded Intern (Verified job)", "Software Algorithm Embedded Intern", "STMicroelectronics", "Santa Clara, CA", "Viewed", "·", "Posted 2 days ago", "2 days ago"];
  const B = ["AI Software Engineering Intern", "AI Software Engineering Intern", "Intel", "Hillsboro, OR (Hybrid)", "6 school alumni work here", "Be an early applicant"];
  const C = ["Embedded Software Engineer Intern - Fall 2026", "Redwood Materials", "San Francisco, CA (On-site)", "Be an early applicant", "·", "Posted 12 hours ago"];

  assert.deepEqual(discoverMod.linkedInFieldsFromLines(A), {
    title: "Software Algorithm Embedded Intern", company: "STMicroelectronics", location: "Santa Clara, CA",
  });
  assert.deepEqual(discoverMod.linkedInFieldsFromLines(B), {
    title: "AI Software Engineering Intern", company: "Intel", location: "Hillsboro, OR (Hybrid)",
  });
  assert.deepEqual(discoverMod.linkedInFieldsFromLines(C), {
    title: "Embedded Software Engineer Intern - Fall 2026", company: "Redwood Materials", location: "San Francisco, CA (On-site)",
  });
  // The invariant that catches this class of bug generically, whatever the suffix:
  // the company can never legitimately equal the title.
  for (const f of [A, B, C].map(discoverMod.linkedInFieldsFromLines)) {
    assert.notEqual(f.company, f.title, "field shift: company === title");
    assert.ok(f.company, "company must not be empty");
  }
});

test("linkedInFieldsFromLines: degenerate input never throws", () => {
  assert.deepEqual(discoverMod.linkedInFieldsFromLines([]), { title: "", company: "", location: "" });
  assert.deepEqual(discoverMod.linkedInFieldsFromLines(null), { title: "", company: "", location: "" });
  // A single-line card yields a title and nothing invented for the rest.
  assert.deepEqual(discoverMod.linkedInFieldsFromLines(["Only A Title"]), { title: "Only A Title", company: "", location: "" });
});

test("linkedInDetailToPatch: OffsiteApply yields the EMPLOYER's real url", () => {
  // Verbatim shape of the real Intel record — the url is a Workday /apply link,
  // which is exactly what the Run pipeline needs and what a linkedin.com url isn't.
  const patch = discoverMod.linkedInDetailToPatch({
    title: "AI Software Engineering Intern",
    formattedLocation: "Hillsboro, OR",
    listedAt: 1785323407000,
    jobState: "LISTED",
    applies: 42,
    formattedEmploymentStatus: "Part-time",
    description: { text: "Come build things." },
    applyMethod: {
      "com.linkedin.voyager.jobs.OffsiteApply": {
        companyApplyUrl: "https://intel.wd1.myworkdayjobs.com/External/job/US-Oregon-Hillsboro/AI-Software-Engineering-Intern_JR0282639/apply",
      },
    },
    companyDetails: {
      "com.linkedin.voyager.deco.jobs.web.shared.WebJobPostingCompany": { companyResolutionResult: { name: "Intel" } },
    },
  });
  assert.equal(patch.ok, true);
  assert.equal(patch.applyKind, "external");
  assert.ok(patch.applyUrl.includes("intel.wd1.myworkdayjobs.com"));
  assert.equal(patch.company, "Intel");
  assert.equal(patch.applicants, 42);
  assert.equal(patch.closed, false);
  // …and the resolved url keys the SAME as the tracker row written after applying,
  // which is what makes cross-table "already applied" work.
  assert.equal(discoveryJobKey(patch.applyUrl), canonicalJobUrl(patch.applyUrl));
});

test("linkedInDetailToPatch: Easy Apply is the union KEY, not a text match", () => {
  // The old code sniffed the rendered page for /easy apply/. The union key is
  // authoritative and can't be confused by surrounding copy.
  for (const key of ["com.linkedin.voyager.jobs.ComplexOnsiteApply", "com.linkedin.voyager.jobs.SimpleOnsiteApply"]) {
    const patch = discoverMod.linkedInDetailToPatch({ jobState: "LISTED", applyMethod: { [key]: {} } });
    assert.equal(patch.applyKind, "easy", key);
    assert.equal(patch.applyUrl, "", "a board-only application has NO employer url to save");
  }
  assert.equal(discoverMod.linkedInDetailToPatch({ jobState: "LISTED", applyMethod: {} }).applyKind, "unknown");
});

test("linkedInDetailToPatch: anything but LISTED is closed (never queue a dead posting)", () => {
  assert.equal(discoverMod.linkedInDetailToPatch({ jobState: "CLOSED" }).closed, true);
  assert.equal(discoverMod.linkedInDetailToPatch({ jobState: "SUSPENDED" }).closed, true);
  assert.equal(discoverMod.linkedInDetailToPatch({ jobState: "LISTED", closed: true }).closed, true);
  assert.equal(discoverMod.linkedInDetailToPatch({ jobState: "LISTED" }).closed, false);
});

test("handshakeDetailToPatch: the apply link comes from job_apply_setting", () => {
  // VERBATIM shape of the real Tudor Investment record (2026-07-30). Note that
  // `use_external_apply_link` is false and `external_apply_link` is null on this
  // very posting even though it plainly applies offsite — see the next test.
  const patch = discoverMod.handshakeDetailToPatch({
    job: {
      id: 11242894, title: "AI Engineering Summer Internship 2027",
      employer_name: "Tudor Investment Corporation",
      text_description: "Build models.",
      location_names: ["New York, New York, United States"],
      created_at: "2026-07-27T10:11:25.655-07:00",
      applications_count: 51,
      job_type: { name: "Internship" },
      use_external_apply_link: false,
      external_apply_link: null,
      job_apply_setting: {
        apply_type: "external",
        external_apply_type: "url",
        external_url: "https://job-boards.greenhouse.io/2027internshipai/jobs/8088962",
        additional_instructions: "Please apply using the external link only. Resumes received via Handshake only will not be reviewed.",
      },
    },
  });
  assert.equal(patch.ok, true);
  assert.equal(patch.applyKind, "external");
  assert.equal(patch.applyUrl, "https://job-boards.greenhouse.io/2027internshipai/jobs/8088962");
  assert.equal(patch.applyVia, "job_apply_setting.external_url");
  assert.equal(patch.company, "Tudor Investment Corporation");
  assert.equal(patch.applicants, 51);
  // The employer's "apply via the link ONLY" instruction must survive to the queue.
  assert.match(patch.applyNote, /external link only/i);
});

test("handshakeDetailToPatch: REGRESSION — the legacy external_apply_link pair is not the source of truth", () => {
  // ⚠ This pins a near-miss. Across 30 live postings `use_external_apply_link` was
  // false and `external_apply_link` null on EVERY one — including the 10 that do
  // apply offsite. Reading only that pair reported "0% of Handshake jobs have an
  // employer link" and would have silently reduced Handshake to zero queued jobs
  // once board-only postings are skipped. job_apply_setting must win.
  const legacyBlank = discoverMod.handshakeDetailToPatch({
    job: {
      id: 1, title: "T", employer_name: "E", text_description: "d",
      use_external_apply_link: false, external_apply_link: null,
      job_apply_setting: { apply_type: "external", external_url: "https://grnh.se/abc123" },
    },
  });
  assert.equal(legacyBlank.applyKind, "external", "job_apply_setting must be believed over the legacy pair");
  assert.equal(legacyBlank.applyUrl, "https://grnh.se/abc123");

  // The legacy pair is still honoured when it IS populated and the setting isn't.
  const legacyOnly = discoverMod.handshakeDetailToPatch({
    job: { id: 1, title: "T", use_external_apply_link: true, external_apply_link: "https://jobs.lever.co/x/y" },
  });
  assert.equal(legacyOnly.applyKind, "external");
  assert.equal(legacyOnly.applyVia, "external_apply_link (legacy)");
});

test("handshakeDetailToPatch: apply_type handshake ⇒ Quick apply; external-without-url ⇒ unknown", () => {
  // 18 of the 30 sampled live postings are genuinely Quick-apply-only: the
  // application happens ON Handshake, so no employer url exists to save.
  const quick = discoverMod.handshakeDetailToPatch({
    job: { id: 1, title: "T", employer_name: "E", text_description: "d", job_apply_setting: { apply_type: "handshake", external_url: "" } },
  });
  assert.equal(quick.applyKind, "easy");
  assert.equal(quick.applyUrl, "");

  // "external" with a BLANK url is a real state (link left empty / email apply).
  // It must not be called an employer link we don't have, nor a Quick apply — both
  // would be false; it is simply unresolved.
  const broken = discoverMod.handshakeDetailToPatch({
    job: { id: 1, title: "T", job_apply_setting: { apply_type: "external", external_url: "" } },
  });
  assert.equal(broken.applyKind, "unknown");
  assert.equal(broken.applyUrl, "");
  // A non-http value is not a link either.
  const mailto = discoverMod.handshakeDetailToPatch({
    job: { id: 1, title: "T", job_apply_setting: { apply_type: "external", external_url: "mailto:jobs@x.com" } },
  });
  assert.equal(mailto.applyKind, "unknown");
});

test("handshakeDetailToPatch: archived/hidden/not-postable are all closed; HTML falls back", () => {
  const mk = (over) => discoverMod.handshakeDetailToPatch({ job: { id: 1, title: "T", ...over } });
  assert.equal(mk({ archived: true }).closed, true);
  assert.equal(mk({ hidden: true }).closed, true);
  assert.equal(mk({ is_postable: false }).closed, true);
  assert.equal(mk({}).closed, false);
  // text_description missing ⇒ strip the HTML description rather than losing the JD.
  const html = mk({ description: "<p>Hello <b>world</b></p>" });
  assert.equal(html.description, "Hello world");
  assert.equal(discoverMod.handshakeDetailToPatch({}).ok, false);
});

// ── Cross-source dedup (the "no overlaps" requirement) ──────────────────────

test("dedupeCrossSource: the SAME job on two boards under different employer links queues ONCE", () => {
  // MEASURED, not hypothetical: Simplify carries the full Greenhouse url for Redwood
  // Materials' embedded intern posting while LinkedIn's companyApplyUrl for the very
  // same posting is a Greenhouse SHORTLINK, so their keys can never agree and the job
  // would otherwise be queued twice.
  const simplify = { source: "simplify", company: "Redwood Materials", title: "Embedded Software Engineer Intern", jobKey: "greenhouse:redwoodmaterials:6126784004" };
  const linkedin = { source: "linkedin", company: "Redwood Materials", title: "Embedded Software Engineer Intern", jobKey: "https://grnh.se/2fwkl2zj4us" };
  assert.notEqual(simplify.jobKey, linkedin.jobKey, "the premise: key dedup cannot catch this");

  const { kept, dropped } = discoverMod.dedupeCrossSource([simplify, linkedin]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].source, "simplify", "first source wins, so it's deterministic");
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].keptFrom, "simplify", "the drop is attributable, so it can be reported");
});

test("dedupeCrossSource: WITHIN one source, an identical title is a REAL second posting", () => {
  // The case that makes a bare company+title dedup unsafe in general — and why this one
  // is cross-source only. LinkedIn genuinely lists these as two distinct postings.
  const a = { source: "linkedin", company: "Neuralink", title: "Embedded Software Engineer Intern, Implant Embedded Systems", location: "San Francisco, CA", jobKey: "linkedin:4416595271" };
  const b = { source: "linkedin", company: "Neuralink", title: "Embedded Software Engineer Intern, Implant Embedded Systems", location: "South San Francisco, CA", jobKey: "linkedin:4416594316" };
  const { kept, dropped } = discoverMod.dedupeCrossSource([a, b]);
  assert.equal(kept.length, 2, "both must survive — they are different jobs");
  assert.equal(dropped.length, 0);
});

test("dedupeCrossSource: sparse rows never collapse into each other", () => {
  // Without both fields there is no evidence of sameness, so nothing may be dropped.
  const rows = [
    { source: "simplify", company: "", title: "", jobKey: "a" },
    { source: "linkedin", company: "", title: "", jobKey: "b" },
    { source: "handshake", company: "Acme", title: "", jobKey: "c" },
    { source: "linkedin", company: "", title: "Intern", jobKey: "d" },
  ];
  assert.equal(discoverMod.dedupeCrossSource(rows).kept.length, 4);
  assert.equal(discoverMod.crossSourceKey({ company: "Acme", title: "" }), "");
  assert.equal(discoverMod.crossSourceKey({ company: "", title: "Intern" }), "");
});

test("crossSourceKey: punctuation and casing don't defeat the match", () => {
  const a = discoverMod.crossSourceKey({ company: "Redwood Materials", title: "Embedded Software Engineer Intern" });
  const b = discoverMod.crossSourceKey({ company: "redwood  materials", title: "Embedded / Software Engineer Intern" });
  assert.equal(a, b);
  // …but a genuinely different title still differs.
  assert.notEqual(a, discoverMod.crossSourceKey({ company: "Redwood Materials", title: "Mechanical Engineer Intern" }));
});

// ── Best-match ranking ──────────────────────────────────────────────────────

const PCT = (job, over) => discoverMod.matchPercent(job, { keywords: "embedded software", nowMs: NOW, sinceDays: 30, ...over }).percent;

test("matchPercent: is a real 0–100 scale, so a % threshold means something", () => {
  // The operator queues by "match ≥ N%", so the number must be bounded and
  // comparable — an unbounded score can't be compared against 60.
  const perfect = PCT({ title: "Embedded Software Intern", postedAt: NOW, applyResolved: true, url: "https://x.wd1.myworkdayjobs.com/a/job/b_R1/apply" });
  const awful = PCT({ title: "Retail Cashier", description: "", postedAt: NOW - 29 * DAY, applyKind: "easy", url: "https://www.linkedin.com/jobs/view/1/" });
  assert.ok(perfect > 85 && perfect <= 100, "a strong match should be high: " + perfect);
  assert.ok(awful < 35, "an unrelated, stale, undrivable job should be low: " + awful);
  for (const j of [{}, { title: "x" }, { postedAt: null }]) {
    const p = PCT(j);
    assert.ok(p >= 0 && p <= 100, "always in range: " + p);
  }
});

test("matchPercent: a title match beats a body mention", () => {
  assert.ok(
    PCT({ title: "Embedded Software Intern", description: "" }) >
    PCT({ title: "Analyst", description: "some embedded software here" })
  );
  const r = discoverMod.matchPercent({ title: "Embedded Software Intern" }, { keywords: "embedded software", nowMs: NOW });
  assert.ok(r.reasons.join(" ").includes("title matches"));
});

test("matchPercent: APPLICANT COUNT does not move the score", () => {
  // Operator 2026-07-30: "I don't need the how many people applied sort." It is still
  // read and displayed, but it must not affect ranking — freshness carries that weight.
  const base = { title: "Embedded Software Intern", postedAt: NOW };
  assert.equal(PCT({ ...base, applicants: 3 }), PCT({ ...base, applicants: 99999 }));
  assert.equal(PCT({ ...base, earlyApplicant: true }), PCT({ ...base, earlyApplicant: false }));
});

test("matchPercent: recency dominates — it is the operator's main criterion", () => {
  const base = { title: "Embedded Software Intern" };
  const hourOld = PCT({ ...base, postedAt: NOW - 3600e3 });
  const weekOld = PCT({ ...base, postedAt: NOW - 7 * DAY });
  const monthOld = PCT({ ...base, postedAt: NOW - 29 * DAY });
  assert.ok(hourOld > weekOld && weekOld > monthOld, `${hourOld} > ${weekOld} > ${monthOld}`);
  // An UNKNOWN date scores mid-range, not zero: every source is time-bounded
  // upstream, so unknown means "unparsed", not "ancient".
  const unknown = PCT({ ...base, postedAt: null });
  assert.ok(unknown > monthOld && unknown < hourOld, "unknown sits between: " + unknown);
});

test("matchPercent: a REPOST is scored on the ORIGINAL date, not the bump", () => {
  // Measured live: 2 of 3 sampled LinkedIn postings were reposts, one 63 DAYS newer
  // than its original. Scoring the bump would re-float a two-month-old posting to the
  // top of every daily sweep.
  const base = { title: "Embedded Software Intern" };
  const genuinelyNew = PCT({ ...base, postedAt: NOW - 3600e3 });
  const bumpedOld = PCT({ ...base, postedAt: NOW - 3600e3, originalPostedAt: NOW - 63 * DAY, reposted: true });
  assert.ok(bumpedOld < genuinelyNew, `repost ${bumpedOld} must score below new ${genuinelyNew}`);
  const r = discoverMod.matchPercent({ ...base, postedAt: NOW - 3600e3, originalPostedAt: NOW - 63 * DAY, reposted: true }, { keywords: "embedded software", nowMs: NOW, sinceDays: 30 });
  assert.ok(r.reasons.join(" ").toLowerCase().includes("repost"), "and it says so: " + r.reasons.join("; "));
});

test("postedForRanking: prefers the ORIGINAL of the two dates", () => {
  assert.equal(discoverMod.postedForRanking({ postedAt: 900, originalPostedAt: 100 }), 100);
  // Even if a board reported them the other way round, the OLDER one is the original.
  assert.equal(discoverMod.postedForRanking({ postedAt: 100, originalPostedAt: 900 }), 100);
  assert.equal(discoverMod.postedForRanking({ postedAt: 500 }), 500);
  assert.equal(discoverMod.postedForRanking({ originalPostedAt: 500 }), 500);
  assert.equal(discoverMod.postedForRanking({}), null);
});

test("matchPercent: a Run-drivable employer link beats a board-only application", () => {
  assert.ok(
    PCT({ title: "Embedded Software Intern", url: "https://x.wd1.myworkdayjobs.com/a/job/b_R1/apply", applyResolved: true, applyKind: "external" }) >
    PCT({ title: "Embedded Software Intern", url: "https://www.linkedin.com/jobs/view/1/", applyKind: "easy" })
  );
});

test("matchPercent: a promoted listing is penalised (a paid placement isn't relevance)", () => {
  const base = { title: "Embedded Software Intern", postedAt: NOW };
  assert.ok(PCT({ ...base, promoted: true }) < PCT(base));
});

test("pickByThreshold: queues everything at/above the % and RETURNS the rest", () => {
  const jobs = [
    { title: "Unrelated Retail Manager", postedAt: NOW - 25 * DAY },
    { title: "Embedded Software Intern", postedAt: NOW },
    { title: "Software Intern", postedAt: NOW - DAY },
  ];
  const opts = { keywords: "embedded software", nowMs: NOW, sinceDays: 30 };
  const { kept, dropped } = discoverMod.pickByThreshold(jobs, 70, opts);
  assert.ok(kept.length >= 1 && kept[0].title === "Embedded Software Intern");
  assert.ok(kept.every((j) => j.matchPercent >= 70), "everything kept clears the bar");
  assert.ok(dropped.every((j) => j.matchPercent < 70), "everything dropped is below it");
  // The caller MUST be able to report what it left behind — that's what stops a
  // narrowing from looking like "the sweep found nothing".
  assert.equal(kept.length + dropped.length, 3);
  assert.ok(kept[0].matchPercent > 0 && Array.isArray(kept[0].scoreReasons) && kept[0].scoreReasons.length);
  // 0 / blank ⇒ queue everything found.
  assert.equal(discoverMod.pickByThreshold(jobs, 0, opts).kept.length, 3);
  assert.equal(discoverMod.pickByThreshold(jobs, 101, opts).kept.length, 0);
  // rankByMatch is the ORDER without a threshold — used before spending the record budget.
  assert.equal(discoverMod.rankByMatch(jobs, opts)[0].title, "Embedded Software Intern");
});

// ── Several searches from the RESUME, not one from the major ─────────────────

test("buildDiscoverQueries: derives SEVERAL searches from the resume", () => {
  const r = discoverMod.buildDiscoverQueries({
    query: "", field: "Electrical and Computer Engineering", intern: true,
    jobTitles: ["Software Engineering Intern", "Senior Embedded Firmware Engineer", "Software Engineering Intern"],
    skills: ["C++", "Python", "FPGA", "PCB Design"],
  });
  // Titles LEAD (a role you've held is the strongest evidence of what you want next),
  // and the level words are stripped so a title generalises to its field.
  assert.match(r.queries[0].keywords, /^Software Engineering intern$/i);
  assert.match(r.queries[1].keywords, /Embedded Firmware Engineer intern/i);
  assert.ok(r.queries.length <= 3, "bounded by maxQueries");
  // The duplicate title must not burn a second slot.
  const keys = r.queries.map((q) => q.keywords.toLowerCase());
  assert.equal(new Set(keys).size, keys.length, "no duplicate searches");
  assert.match(r.derivedFrom, /resume/);
});

test("buildDiscoverQueries: an explicit query short-circuits everything", () => {
  const r = discoverMod.buildDiscoverQueries({ query: "robotics intern", field: "X", jobTitles: ["Y"], skills: ["Z"], intern: true });
  assert.deepEqual(r.queries, [{ keywords: "robotics intern", from: "your keywords" }]);
  // …and the role word is not doubled.
  assert.equal(discoverMod.buildDiscoverQueries({ query: "data intern", intern: true }).queries[0].keywords, "data intern");
});

test("buildDiscoverQueries: an empty resume still yields a real search, never a blank one", () => {
  // A blank search is a board's RECOMMENDED FEED, not a search — the bug this whole
  // area exists to prevent. NOTE "intern" is a stopword, so the fallback cannot go
  // through the token-keyed dedupe or it silently produces zero queries.
  assert.deepEqual(discoverMod.buildDiscoverQueries({ intern: true }).queries,
    [{ keywords: "intern", from: "the internship default" }]);
  // Nothing at all to go on and internships off ⇒ no query, and the caller skips the
  // board with a note rather than searching for nothing.
  assert.deepEqual(discoverMod.buildDiscoverQueries({ intern: false }).queries, []);
});

test("buildDiscoverQueries: falls back through field then skills when titles are absent", () => {
  const noTitles = discoverMod.buildDiscoverQueries({ field: "Computer Science", skills: ["Rust", "Embedded"], intern: true, maxQueries: 3 });
  assert.match(noTitles.queries[0].keywords, /Computer Science intern/i);
  assert.match(noTitles.queries[1].keywords, /Rust Embedded intern/i, "skills are PAIRED — one alone is too broad");
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

// ── SOURCE 4 — zero2sudo story links ────────────────────────────────────────
//
// The driver needs chrome.tabs, so what is pinned here is every INTERPRETATION it
// makes: unwrapping the shim, and the foundOn bookkeeping the queue's per-source tabs
// read. Both were built off a live trace on 2026-08-19.

const { unwrapStoryLink, noteFoundOn, dedupeCrossSource } = discoverMod;

test("unwrapStoryLink: decodes Instagram's l.instagram.com shim to the real destination", () => {
  const real = "https://job-boards.greenhouse.io/acme/jobs/4567";
  const shim = "https://l.instagram.com/?u=" + encodeURIComponent(real) + "&e=AT1abcTOKEN";
  assert.equal(unwrapStoryLink(shim), real);
});

test("unwrapStoryLink: DROPS the shim's tracking token — it must never reach the queue", () => {
  // `e=` is a per-view token. A discovered url is written to Supabase and echoed into
  // logs, so carrying it there is the leak class redactSecrets exists for.
  const real = "https://boards.greenhouse.io/acme/jobs/1";
  const shim = "https://l.instagram.com/?u=" + encodeURIComponent(real) + "&e=AT3SECRET99";
  const out = unwrapStoryLink(shim);
  assert.ok(!/AT3SECRET99/.test(out), "the tracking token survived into the unwrapped url");
  assert.ok(!/l\.instagram\.com/.test(out), "the shim host survived");
});

test("unwrapStoryLink: strips Meta's fbclid from the DESTINATION, not just the shim (live 2026-08-19)", () => {
  // Observed on the first real sweep: unwrapping the shim still left `?fbclid=<~90 chars>` on
  // every url, which then reaches Supabase, the logs and the Run pipeline's navigation.
  const real = "https://careers.truist.com/us/en/job/12345?fbclid=PAcGRvZgRleHRuA2FlbQIxMQBzcnRj";
  const out = unwrapStoryLink("https://l.instagram.com/?u=" + encodeURIComponent(real));
  assert.ok(!/fbclid/i.test(out), "fbclid survived: " + out);
  assert.ok(out.startsWith("https://careers.truist.com/us/en/job/12345"));
});

test("unwrapStoryLink: strips igshid / igsh too, and leaves a clean url with no stray '?'", () => {
  const real = "https://job-boards.greenhouse.io/acme/jobs/9?igshid=abc&igsh=def";
  const out = unwrapStoryLink("https://l.instagram.com/?u=" + encodeURIComponent(real));
  assert.equal(out, "https://job-boards.greenhouse.io/acme/jobs/9");
});

test("unwrapStoryLink: a DENYLIST, not 'drop the query' — real params survive alongside a tracker", () => {
  // The whole reason this is a denylist: an ATS posting id lives in the query on some tenants,
  // so blanket-stripping would break the link it is meant to clean.
  const real = "https://x.example/job?jobId=129661&fbclid=PAcGRvZg&source=WEB";
  const out = unwrapStoryLink("https://l.instagram.com/?u=" + encodeURIComponent(real));
  assert.ok(out.includes("jobId=129661"), out);
  assert.ok(out.includes("source=WEB"), out);
  assert.ok(!/fbclid/i.test(out), out);
});

test("unwrapStoryLink: keeps the destination's OWN query — an ATS posting id can live there", () => {
  const real = "https://egug.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/job/26011698?mode=location";
  const shim = "https://l.instagram.com/?u=" + encodeURIComponent(real);
  assert.ok(unwrapStoryLink(shim).includes("mode=location"));
});

test("unwrapStoryLink: a bare (unshimmed) url passes through unchanged", () => {
  const real = "https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/x";
  assert.equal(unwrapStoryLink(real), real);
});

test("unwrapStoryLink: refuses anything that isn't a usable http(s) url", () => {
  assert.equal(unwrapStoryLink(""), "");
  assert.equal(unwrapStoryLink(null), "");
  assert.equal(unwrapStoryLink("not a url"), "");
  assert.equal(unwrapStoryLink("javascript:alert(1)"), "");
  // A shim with no `u` param is a dead sticker, not a destination.
  assert.equal(unwrapStoryLink("https://l.instagram.com/?e=AT1"), "");
});

test("noteFoundOn: seeds from the job's own source, then appends without duplicating", () => {
  const job = { source: "simplify" };
  noteFoundOn(job, "simplify");
  assert.deepEqual(job.foundOn, ["simplify"]);
  noteFoundOn(job, "linkedin");
  noteFoundOn(job, "linkedin");
  assert.deepEqual(job.foundOn, ["simplify", "linkedin"], "order-stable and unique");
});

test("dedupeDiscovered: a LATER source's duplicate is recorded on the survivor, not lost", () => {
  // THE reason foundOn exists. Dedup keeps the first copy, so without this LinkedIn's
  // tab would under-report — it really did find this job, it just wasn't first.
  const url = "https://job-boards.greenhouse.io/acme/jobs/9";
  const { jobs, skippedDupe } = dedupeDiscovered([
    { source: "zero2sudo", url },
    { source: "linkedin", url },
  ], []);
  assert.equal(jobs.length, 1, "All shows it ONCE");
  assert.equal(skippedDupe, 1);
  assert.deepEqual(jobs[0].foundOn, ["zero2sudo", "linkedin"], "both tabs can show it");
  assert.equal(jobs[0].source, "zero2sudo", "the first source still owns the row");
});

test("dedupeCrossSource: the dropped copy's FULL foundOn list is carried over", () => {
  // A three-source overlap: the dropped copy had already absorbed a third source in the
  // key pass, and losing that would silently empty one tab.
  const a = { source: "zero2sudo", url: "https://x.example/a", company: "Acme", title: "SWE Intern", foundOn: ["zero2sudo"] };
  const b = { source: "linkedin", url: "https://grnh.se/short", company: "Acme", title: "SWE Intern", foundOn: ["linkedin", "handshake"] };
  const { kept, dropped } = dedupeCrossSource([a, b]);
  assert.equal(kept.length, 1);
  assert.equal(dropped.length, 1);
  assert.deepEqual(kept[0].foundOn, ["zero2sudo", "linkedin", "handshake"]);
});

test("dedupeCrossSource: a SAME-source repeat is left alone (two real postings)", () => {
  const a = { source: "linkedin", url: "https://x.example/a", company: "Neuralink", title: "Embedded Intern", foundOn: ["linkedin"] };
  const b = { source: "linkedin", url: "https://x.example/b", company: "Neuralink", title: "Embedded Intern", foundOn: ["linkedin"] };
  const { kept } = dedupeCrossSource([a, b]);
  assert.equal(kept.length, 2, "same-source duplicates are distinct postings, not overlap");
});

test("DISCOVER_DEFAULTS: zero2sudo gets its OWN description budget", () => {
  // Separate from maxJdOpens on purpose — ranking runs before the global reader pass,
  // so unenriched story jobs would score ~0 and be dropped before being opened.
  assert.ok(DISCOVER_DEFAULTS.maxStoryReads > 0);
  assert.equal(discoverMod.DISCOVER_Z2S_USERNAME, "zero2sudo");
});
