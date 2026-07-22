import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReadme } from "../lib/simplify";
import { workdayCxsUrl, atsOf } from "../lib/job-description";

// Mirrors the real README format: an HTML <table>, "↳" continuation rows, an
// Application cell whose FIRST <a href> is the direct apply URL (simplify.jobs is
// second), and closed roles (🔒) with no direct link.
const SAMPLE = `
<table>
<thead><tr><th>Company</th><th>Role</th><th>Location</th><th>Application</th><th>Age</th></tr></thead>
<tbody>
<tr>
<td><strong><a href="https://simplify.jobs/c/xx">Onware</a></strong></td>
<td>Full Stack Developer-Intern Opportunity</td>
<td>Edmonton, AB, Canada</td>
<td><div align="center"><a href="https://ats.rippling.com/onware/jobs/abc?utm_source=Simplify&ref=Simplify"><img src="x" alt="Apply"></a> <a href="https://simplify.jobs/p/yy"><img src="z" alt="Simplify"></a></div></td>
<td>1d</td>
</tr>
<tr>
<td>↳</td>
<td>Backend Intern</td>
<td>Remote in US</td>
<td><div align="center"><a href="https://ats.rippling.com/onware/jobs/def"><img alt="Apply"></a> <a href="https://simplify.jobs/p/zz"><img alt="Simplify"></a></div></td>
<td>3d</td>
</tr>
<tr>
<td><strong><a href="https://simplify.jobs/c/sel">Schweitzer Engineering Laboratories</a></strong></td>
<td>Software Engineer Intern</td>
<td>Boise, ID</td>
<td><div align="center"><a href="https://selinc.wd1.myworkdayjobs.com/SEL/job/Idaho---Boise/Software-Engineer-Intern_2026-22321?utm_source=Simplify&ref=Simplify"><img alt="Apply"></a> <a href="https://simplify.jobs/p/aa"><img alt="Simplify"></a></div></td>
<td>2w</td>
</tr>
<tr>
<td><strong><a href="https://simplify.jobs/c/closed">ClosedCo</a></strong></td>
<td>Old Intern</td>
<td>NYC</td>
<td><div align="center">🔒 <a href="https://simplify.jobs/p/bb"><img alt="Simplify"></a></div></td>
<td>30d</td>
</tr>
</tbody>
</table>
`;

test("parseReadme: fields, ↳ inheritance, direct URL, closed-row skip, age parsing", () => {
  const rows = parseReadme(SAMPLE);
  assert.equal(rows.length, 3, "the 🔒 closed row (no direct link) is skipped");

  assert.equal(rows[0].company, "Onware");
  assert.equal(rows[0].role, "Full Stack Developer-Intern Opportunity");
  assert.equal(rows[0].location, "Edmonton, AB, Canada");
  assert.equal(rows[0].url, "https://ats.rippling.com/onware/jobs/abc?utm_source=Simplify&ref=Simplify");
  assert.equal(rows[0].ageDays, 1);

  assert.equal(rows[1].company, "Onware", "↳ inherits the company above");
  assert.equal(rows[1].role, "Backend Intern");
  assert.equal(rows[1].ageDays, 3);

  assert.equal(rows[2].company, "Schweitzer Engineering Laboratories");
  assert.equal(rows[2].ageDays, 14, "2w → 14 days");
  assert.ok(rows[2].url.includes("myworkdayjobs.com"));
});

test("atsOf classifies hosts", () => {
  assert.equal(atsOf("https://selinc.wd1.myworkdayjobs.com/SEL/job/x_123"), "workday");
  assert.equal(atsOf("https://job-boards.greenhouse.io/drweng/jobs/7992936"), "greenhouse");
  assert.equal(atsOf("https://jobs.ashbyhq.com/spacial/abc"), "ashby");
  assert.equal(atsOf("https://ats.rippling.com/onware/jobs/abc"), "rippling");
  assert.equal(atsOf("https://www.tesla.com/careers/search/job/1"), "other");
});

test("workdayCxsUrl transforms apply URL → CxS endpoint (tenant/site/path)", () => {
  assert.equal(
    workdayCxsUrl(
      "https://selinc.wd1.myworkdayjobs.com/SEL/job/Idaho---Boise/Software-Engineer-Intern_2026-22321?utm_source=Simplify",
    ),
    "https://selinc.wd1.myworkdayjobs.com/wday/cxs/selinc/SEL/job/Idaho---Boise/Software-Engineer-Intern_2026-22321",
  );
  // locale segment before the site is dropped
  assert.equal(
    workdayCxsUrl("https://comcast.wd5.myworkdayjobs.com/en-US/Comcast_Careers/job/IL/Role_R1"),
    "https://comcast.wd5.myworkdayjobs.com/wday/cxs/comcast/Comcast_Careers/job/IL/Role_R1",
  );
  assert.equal(workdayCxsUrl("https://jobs.ashbyhq.com/x/y"), null);
});
