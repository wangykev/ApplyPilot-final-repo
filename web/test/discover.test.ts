import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { discoveryJobKey, toQueueRow, describeSweep, DISCOVER_DEFAULTS } from "../lib/discover";
import { canonicalJobUrl } from "../lib/job-key";

// The extension's copy of the same key function. discover.js is a LOCKSTEP dup of
// web/lib/discover.ts's discoveryJobKey (the repo's TODO(dup) discipline), and a
// drift between them silently breaks "jobs I haven't applied to" — the sweep would
// key a job one way and the insert another, so nothing would ever dedupe. Loading
// the real file makes that drift a TEST FAILURE instead of a production surprise.
const require_ = createRequire(import.meta.url);
require_("../../lib.js"); // defines canonicalJobUrl as a global for discover.js
const extDiscover = require_("../../discover.js");

const LOCKSTEP_URLS = [
  "https://costar.wd1.myworkdayjobs.com/Costar_Campus/job/Sunnyvale/Summer-2026-Technology-Intern_R37008",
  "https://wd1.myworkdaysite.com/en-US/recruiting/costar/Costar_Campus/job/X_R37008/apply/applyManually",
  "https://www.linkedin.com/jobs/view/4123456789/?refId=abc",
  "https://www.linkedin.com/jobs/search/?currentJobId=4123456789&keywords=intern",
  "https://app.joinhandshake.com/jobs/9876543",
  "https://app.joinhandshake.com/job-search/9876543?query=intern",
  "https://boards.greenhouse.io/acme/jobs/4567890?gh_src=x",
  "https://jobs.lever.co/acme/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
  "https://jobs.ashbyhq.com/mercor/11516609-e54b-4087-87c2-e84a8bafbb5a",
  "https://fa-essf-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/10003905",
  "not a url",
  "",
];

test("discoveryJobKey is LOCKSTEP with the extension's discover.js copy", () => {
  for (const u of LOCKSTEP_URLS) {
    assert.equal(
      discoveryJobKey(u),
      extDiscover.discoveryJobKey(u),
      `web and extension disagree on the key for ${JSON.stringify(u)}`
    );
  }
});

test("discoveryJobKey: a Workday posting keys the SAME as the tracker's canonicalJobUrl", () => {
  // The invariant that makes cross-table dedup work: a job discovered on the
  // Simplify board (its url IS the employer's Workday link) must key identically to
  // the application row the tracker writes once it's applied to.
  const posting = "https://costar.wd1.myworkdayjobs.com/Costar_Campus/job/Sunnyvale/Summer-2026-Technology-Intern_R37008";
  assert.equal(discoveryJobKey(posting), canonicalJobUrl(posting));
  assert.equal(discoveryJobKey(posting), "wd1:r37008");
});

test("discoveryJobKey: board URLs collapse their variants to one job", () => {
  assert.equal(discoveryJobKey("https://www.linkedin.com/jobs/view/42/?x=1"), "linkedin:42");
  assert.equal(discoveryJobKey("https://www.linkedin.com/jobs/search/?currentJobId=42"), "linkedin:42");
  assert.equal(discoveryJobKey("https://app.joinhandshake.com/jobs/7"), "handshake:7");
  assert.equal(discoveryJobKey("https://app.joinhandshake.com/job-search/7?q=a"), "handshake:7");
});

test("toQueueRow: recomputes the key server-side — a client-supplied key is IGNORED", () => {
  // The extension is trusted code, but this crossed a message boundary on its way
  // to the operator's database. The key must come from the url, always.
  const row = toQueueRow({
    url: "https://www.linkedin.com/jobs/view/42/",
    jobKey: "attacker-supplied-key",
    title: "Intern",
    company: "Acme",
  } as never);
  assert.ok(row);
  assert.equal(row!.job_key, "linkedin:42");
});

test("toQueueRow: maps the discovered shape onto the queue columns", () => {
  const posted = Date.UTC(2026, 6, 20, 8, 0, 0);
  const row = toQueueRow({
    source: "simplify",
    url: "https://jobs.ashbyhq.com/mercor/11516609-e54b-4087-87c2-e84a8bafbb5a",
    jobKey: "ashby:mercor:11516609-e54b-4087-87c2-e84a8bafbb5a",
    title: "Data Science Intern",
    company: "Mercor",
    location: "San Francisco, CA",
    category: "Data Science",
    postedAt: posted,
    postedText: "",
    postedUnknown: false,
    description: "We are hiring…",
    descriptionSource: "page",
  });
  assert.ok(row);
  assert.equal(row!.source, "simplify");
  assert.equal(row!.role, "Data Science Intern"); // title → role
  assert.equal(row!.company, "Mercor");
  assert.equal(row!.location, "San Francisco, CA");
  assert.equal(row!.posted_at, new Date(posted).toISOString());
  assert.equal(row!.job_description, "We are hiring…");
});

test("toQueueRow: drops a row with no usable http(s) url", () => {
  assert.equal(toQueueRow({ url: "" } as never), null);
  assert.equal(toQueueRow({ url: "javascript:alert(1)" } as never), null);
  assert.equal(toQueueRow({ url: "ftp://x.test/job" } as never), null);
  assert.equal(toQueueRow(null), null);
  assert.equal(toQueueRow(undefined), null);
});

test("toQueueRow: an absent or implausible posted date is stored as NULL, never a bogus timestamp", () => {
  const base = { url: "https://x.test/job/1", title: "T" };
  assert.equal(toQueueRow({ ...base, postedAt: null } as never)!.posted_at, null);
  assert.equal(toQueueRow({ ...base, postedAt: 0 } as never)!.posted_at, null);
  assert.equal(toQueueRow({ ...base, postedAt: 1 } as never)!.posted_at, null, "pre-2000 epoch is nonsense");
  assert.equal(
    toQueueRow({ ...base, postedAt: Date.now() + 30 * 86400000 } as never)!.posted_at,
    null,
    "a date far in the future is a broken clock, not a posting"
  );
});

test("toQueueRow: blank text fields become null rather than empty strings", () => {
  const row = toQueueRow({ url: "https://x.test/job/1", company: "   ", title: "", description: "" } as never);
  assert.ok(row);
  assert.equal(row!.company, null);
  assert.equal(row!.role, null);
  assert.equal(row!.job_description, null);
});

test("toQueueRow: long text is clamped to column-sane lengths", () => {
  const row = toQueueRow({
    url: "https://x.test/job/1",
    company: "C".repeat(500),
    title: "T".repeat(500),
    description: "D".repeat(50000),
  } as never);
  assert.equal(row!.company!.length, 200);
  assert.equal(row!.role!.length, 200);
  assert.equal(row!.job_description!.length, 20000);
});

test("describeSweep: explains WHY a sweep found few jobs, not just how many", () => {
  const s = describeSweep({
    scanned: { simplify: 900, linkedin: 25 },
    found: 40, skippedKnown: 30, skippedDupe: 4, droppedByCap: 0,
    newJobs: 6, bySource: { simplify: 5, linkedin: 1 },
    jdOpened: 6, jdFailed: 1, jdSkipped: 0,
  });
  assert.match(s, /scanned 925/);
  assert.match(s, /30 already applied or queued/);
  assert.match(s, /4 listed on more than one board/);
  assert.match(s, /read 5 of 6 descriptions/);
  assert.equal(describeSweep(null), "");
});

test("DISCOVER_DEFAULTS mirror the extension's caps", () => {
  assert.equal(DISCOVER_DEFAULTS.sinceDays, extDiscover.DISCOVER_DEFAULTS.sinceDays);
  assert.equal(DISCOVER_DEFAULTS.maxPerSource, extDiscover.DISCOVER_DEFAULTS.maxPerSource);
  assert.equal(DISCOVER_DEFAULTS.maxTotal, extDiscover.DISCOVER_DEFAULTS.maxTotal);
  assert.equal(DISCOVER_DEFAULTS.maxJdOpens, extDiscover.DISCOVER_DEFAULTS.maxJdOpens);
});
