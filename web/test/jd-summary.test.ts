import { test } from "node:test";
import assert from "node:assert";
import { summarizeJd } from "../lib/jd-summary";

const val = (t: string, label: string) => summarizeJd(t).find((f) => f.label === label)?.value;

test("jd summary: nothing found ⇒ NO facts, so the caller renders no panel at all", () => {
  assert.deepStrictEqual(summarizeJd(""), []);
  assert.deepStrictEqual(summarizeJd(null), []);
  assert.deepStrictEqual(summarizeJd("We are a company that does things. Join us!"), []);
});

test("jd summary: pay takes RANGES and explicit rates, never a bare dollar figure", () => {
  assert.strictEqual(val("The salary range is $120,000 - $150,000 per year.", "Pay"), "$120,000 – $150,000");
  assert.strictEqual(val("Compensation: $45.50/hour", "Pay"), "$45.50/hour");
  assert.strictEqual(val("Base pay $90,000 to $110,000 depending on experience", "Pay"), "$90,000 – $110,000");
  // ⚠ the whole reason bare figures are refused: these are NOT the salary
  assert.strictEqual(val("You'll receive a $5,000 signing bonus.", "Pay"), undefined);
  assert.strictEqual(val("We offer a $2,000 annual education stipend.", "Pay"), undefined);
});

test("jd summary: hybrid beats remote, because a hybrid post almost always says 'remote' too", () => {
  assert.strictEqual(val("This is a hybrid role — remote two days a week.", "Workplace"), "Hybrid");
  assert.strictEqual(val("This role is fully remote.", "Workplace"), "Remote");
  assert.strictEqual(val("This position is on-site in Austin.", "Workplace"), "On-site");
});

test("jd summary: experience only counts when tied to the word 'experience'", () => {
  assert.strictEqual(val("5+ years of professional experience required", "Experience"), "5+ years");
  assert.strictEqual(val("3-5 years experience in embedded systems", "Experience"), "3–5 years");
  assert.strictEqual(val("Minimum of 7 years of relevant industry experience", "Experience"), "7+ years");
  // a number of years about something else must not be read as a requirement
  assert.strictEqual(val("Our company has been building rockets for 10 years.", "Experience"), undefined);
});

test("jd summary: the NEGATIVE sponsorship statement wins — it is the one that changes your decision", () => {
  assert.strictEqual(val("We are unable to provide visa sponsorship for this role.", "Sponsorship"), "No visa sponsorship");
  assert.strictEqual(val("The employer will not sponsor applicants for work visas.", "Sponsorship"), "No visa sponsorship");
  assert.strictEqual(val("Visa sponsorship is available for exceptional candidates.", "Sponsorship"), "Sponsorship available");
  assert.strictEqual(val("We value diverse backgrounds.", "Sponsorship"), undefined);
});

test("jd summary: clearance and export control are hard eligibility gates, so they surface", () => {
  assert.strictEqual(val("Must hold an active TS/SCI clearance.", "Clearance"), "Ts/sci");
  assert.strictEqual(val("An active Security Clearance is required.", "Clearance"), "Security clearance");
  assert.strictEqual(val("This role is subject to ITAR; applicants must be a U.S. Person.", "Clearance"), "ITAR / US person");
});

test("jd summary: degree words only — 'BS'/'MS' collide with too much else", () => {
  assert.strictEqual(val("Bachelor's degree in Computer Science or equivalent", "Degree"), "Bachelor's");
  assert.strictEqual(val("PhD in Machine Learning preferred", "Degree"), "PhD");
  assert.strictEqual(val("Master's degree required", "Degree"), "Master's");
  assert.strictEqual(val("Experience with MS Office and BS EN standards", "Degree"), undefined);
});

test("jd summary: type, travel and deadline", () => {
  assert.strictEqual(val("This is a full-time position based in Denver.", "Type"), "Full-time");
  assert.strictEqual(val("Summer 2026 Internship — apply early!", "Type"), "Internship");
  assert.strictEqual(val("Position requires travel up to 25% of the time.", "Travel"), "Up to 25%");
  assert.strictEqual(val("Please apply by March 14, 2026 to be considered.", "Apply by"), "March 14, 2026");
});

test("jd summary: a realistic posting yields an ordered, deduplicated fact list", () => {
  const jd = `About Us
    Cloudflare is hiring an Accounting Intern for Fall 2026.
    This is a full-time internship based in Austin, TX — hybrid, three days in office.
    Compensation: $28.00/hour.
    Requirements: Bachelor's degree in progress; 2+ years of relevant experience preferred.
    We are unable to provide visa sponsorship for this position.`;
  const facts = summarizeJd(jd);
  assert.deepStrictEqual(facts.map((f) => f.label), ["Pay", "Type", "Workplace", "Experience", "Degree", "Sponsorship"]);
  assert.strictEqual(facts[0].value, "$28.00/hour");
  assert.strictEqual(facts[2].value, "Hybrid");
  assert.strictEqual(facts[5].value, "No visa sponsorship");
});
