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
  DISCOVER_DEFAULTS,
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

test("matchesDiscoverQuery: empty query matches everything; terms are ANDed", () => {
  const job = { title: "Software Engineer Intern", company: "Acme", location: "Remote", category: "Software" };
  assert.equal(matchesDiscoverQuery(job, ""), true);
  assert.equal(matchesDiscoverQuery(job, "software intern"), true);
  assert.equal(matchesDiscoverQuery(job, "software quantitative"), false); // AND, not OR
  assert.equal(matchesDiscoverQuery(job, "ACME"), true);                    // case-insensitive
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
  const ds = simplifyListingsToJobs(SIMPLIFY_ROWS, { nowMs: NOW, sinceDays: 7, termPattern: "2026", query: "data science" });
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

test("discoverLinkedInSearchUrl: the SOURCE does the recency filtering (f_TPR), newest first", () => {
  const u = discoverLinkedInSearchUrl("software engineer intern", 7);
  assert.ok(u.includes("f_TPR=r604800"), u); // 7 days in seconds
  assert.ok(u.includes("sortBy=DD"), u);
  assert.ok(u.includes("keywords=software%20engineer%20intern"), u);
  // No keyword ⇒ no empty keywords param.
  assert.ok(!discoverLinkedInSearchUrl("", 3).includes("keywords="));
});

test("discoverHandshakeSearchUrl: sorts newest-first and encodes the query", () => {
  const u = discoverHandshakeSearchUrl("data intern");
  assert.ok(u.startsWith("https://app.joinhandshake.com/job-search"), u);
  assert.ok(u.includes("sort=created_at_desc"), u);
  assert.ok(u.includes("query=data%20intern"), u);
});

test("DISCOVER_DEFAULTS: every expensive knob is bounded by default", () => {
  assert.ok(DISCOVER_DEFAULTS.maxPerSource > 0);
  assert.ok(DISCOVER_DEFAULTS.maxTotal > 0);
  assert.ok(DISCOVER_DEFAULTS.maxJdOpens > 0 && DISCOVER_DEFAULTS.maxJdOpens <= 25, "the tab-opening pass must stay modest");
  assert.ok(DISCOVER_DEFAULTS.sinceDays > 0);
});
