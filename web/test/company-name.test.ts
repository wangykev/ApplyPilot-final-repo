import { test } from "node:test";
import assert from "node:assert/strict";
import { prettyCompany } from "../lib/company-name";

// The live case this exists for: a submit run never re-scrapes the JD, so `company` can be stored as
// the bare posting host and the tracker showed "analogdevices.wd1.myworkdayjobs.com".
test("a Workday host reduces to the tenant's real name", () => {
  assert.equal(prettyCompany("analogdevices.wd1.myworkdayjobs.com"), "Analog Devices");
  assert.equal(prettyCompany("waystar.wd1.myworkdayjobs.com"), "Waystar");
});

test("the path-hosted Workday domain works the same way", () => {
  assert.equal(prettyCompany("magna.wd3.myworkdaysite.com"), "Magna");
});

test("an unknown tenant still reads as a name, never as a host", () => {
  assert.equal(prettyCompany("someunknownco.wd12.myworkdayjobs.com"), "Someunknownco");
  assert.ok(!prettyCompany("someunknownco.wd12.myworkdayjobs.com").includes("."));
});

test("a company that is ALREADY a human name is left alone", () => {
  assert.equal(prettyCompany("Solar Turbines"), "Solar Turbines");
  assert.equal(prettyCompany("Waystar"), "Waystar");
});

test("a known one-word slug gets the company's own spelling", () => {
  assert.equal(prettyCompany("Analogdevices"), "Analog Devices");
  assert.equal(prettyCompany("Homedepot"), "Home Depot");
  assert.equal(prettyCompany("Nvidia"), "NVIDIA");
});

test("an empty company falls back to the URL's tenant", () => {
  assert.equal(prettyCompany(null, "https://itron.wd5.myworkdayjobs.com/en-US/Itron/job/x"), "Itron");
  assert.equal(prettyCompany("", null), "");
});

test("a job-board host does NOT become the board's name", () => {
  // job-boards.greenhouse.io carries the company in the PATH, not the host — better to show nothing
  // than to label every Greenhouse application "Job-boards".
  assert.equal(prettyCompany("job-boards.greenhouse.io"), "Greenhouse");
  assert.equal(prettyCompany("jobs.lever.co"), "Lever");
});

test("an employer-hosted careers domain yields the employer", () => {
  assert.equal(prettyCompany("careers.moog.com"), "Moog");
  assert.equal(prettyCompany("sonos.com"), "Sonos");
});
