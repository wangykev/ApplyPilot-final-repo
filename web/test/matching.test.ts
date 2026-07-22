import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProfileSignal, scoreMatch } from "../lib/matching";
import { coerceProfile } from "../lib/profile-schema";

const KEVIN = coerceProfile({
  skills: ["C", "C++", "Python", "SystemVerilog", "Java", "ROS 2", "FPGA", "Altium Designer", "Git", "Linux"],
  education: [
    {
      degree: ["Bachelor of Science"],
      field_of_study: ["Electrical and Computer Engineering"],
      gpa: "3.95",
      graduation_date: "2028-05",
      currently_enrolled: true,
    },
  ],
  work_authorization: { authorized_to_work_in_us: true, requires_sponsorship_now: false },
});

// A JD must exceed the ~200-char "is this a real description vs a thin SPA shell"
// threshold to be scored as read. Real postings are thousands of chars; fixtures
// below include realistic boilerplate so they cross it.
const BOILER =
  " The internship runs over the summer with mentorship, code reviews, and the chance to present your work to the wider engineering organization. We value curiosity and collaboration.";

test("buildProfileSignal derives undergrad, grad year, gpa, skills", () => {
  const s = buildProfileSignal(KEVIN);
  assert.equal(s.degreeLevel, "undergraduate");
  assert.equal(s.gradYear, 2028);
  assert.equal(s.gpa, 3.95);
  assert.equal(s.usAuthorized, true);
  assert.ok(s.skills.includes("python"));
  assert.ok(s.fieldsOfStudy.includes("electrical and computer engineering"));
});

test("graduate-only JD → ineligible, score capped low", () => {
  const s = buildProfileSignal(KEVIN);
  const jd =
    "We are hiring a software engineering intern for our platform team. You must be currently pursuing a 2-year graduate degree in Computer Science, Machine Learning, or a related field, and returning to school in the fall. No visa sponsorship is available for this role." +
    BOILER;
  const r = scoreMatch(
    { title: "Software Engineer Intern", company: "PANW", location: "CA", jd, autoApply: true },
    s,
  );
  assert.equal(r.eligibility, "no");
  assert.ok(r.score <= 28, `score ${r.score} should be capped for an ineligible role`);
  assert.equal(r.jdRead, true);
});

test("returning-intern conversion JD → ineligible", () => {
  const s = buildProfileSignal(KEVIN);
  const jd =
    "This is an engineering conversion program spanning aerospace, electrical, and software disciplines. Basic qualification: previously interned with the company. You must be a currently enrolled student pursuing a bachelor's degree and graduate before the program ends." +
    BOILER;
  const r = scoreMatch(
    { title: "Intern to Entry Conversion", company: "Boeing", location: "US", jd, autoApply: true },
    s,
  );
  assert.equal(r.eligibility, "no");
});

test("embedded JD naming the profile's skills → eligible, solid+, matched skills", () => {
  const s = buildProfileSignal(KEVIN);
  const jd =
    "Join our team as a Software Engineer Intern. You should be a current student pursuing a bachelor's degree with at least one year of technical coursework. You will write firmware in C, C++, and Python for embedded systems, work in Linux, and use Git for version control. Experience with real-time control and robotics is a plus." +
    BOILER;
  const r = scoreMatch(
    { title: "Software Engineer Intern", company: "SEL", location: "Boise, ID", jd, autoApply: true },
    s,
  );
  assert.equal(r.eligibility, "yes");
  assert.ok(r.score >= 60, `score ${r.score} should reach the solid tier`);
  assert.ok(r.matchedSkills.includes("c++"));
  assert.ok(r.matchedSkills.includes("python"));
});

test("grad-year mismatch (wants 2027, you're 2028) → maybe", () => {
  const s = buildProfileSignal(KEVIN);
  const jd =
    "We are seeking a technology intern to join our cloud engineering team. Candidates should be pursuing a Bachelor's degree in Computer Science with an expected graduation date of May 2027. You will use Java and Python and Google Cloud Platform to build internal tooling." +
    BOILER;
  const r = scoreMatch(
    { title: "Technology Intern", company: "Equifax", location: "GA", jd, autoApply: true },
    s,
  );
  assert.equal(r.eligibility, "maybe");
});

test("title-only (no JD) → unknown eligibility, capped, jdRead false", () => {
  const s = buildProfileSignal(KEVIN);
  const r = scoreMatch(
    { title: "Software Engineer Intern", company: "Startup", location: "SF", jd: null, autoApply: false },
    s,
  );
  assert.equal(r.eligibility, "unknown");
  assert.equal(r.jdRead, false);
  assert.ok(r.score <= 82, "title-only confidence is capped below JD-verified strong");
});

test("low-fit JD (marketing/frontend) scores below an embedded fit", () => {
  const s = buildProfileSignal(KEVIN);
  const low = scoreMatch(
    {
      title: "Content Marketing Intern",
      company: "Eulerity",
      location: "NYC",
      jd:
        "Website content and social media marketing internship. You will manage SEO and run marketing campaigns across channels, writing copy and scheduling posts. Pursuing a bachelor's degree in marketing or communications preferred." +
        BOILER,
      autoApply: false,
    },
    s,
  );
  const high = scoreMatch(
    {
      title: "Embedded Firmware Intern",
      company: "Acme",
      location: "US",
      jd:
        "Write firmware in C and C++ for embedded microcontroller systems with real-time control loops and sensor integration. You should be pursuing a bachelor's degree in electrical or computer engineering and be comfortable with Linux." +
        BOILER,
      autoApply: false,
    },
    s,
  );
  assert.ok(high.score > low.score, `embedded ${high.score} should beat marketing ${low.score}`);
});
