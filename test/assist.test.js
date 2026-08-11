// Manual assist — the pure half (lib.js). Everything the popup's card and its two buttons decide from
// is here: the JD score parse, the "missing from your resume" derivation, which page we are looking at,
// and whether an application was actually submitted. No page, no tab, no provider.
const test = require("node:test");
const assert = require("node:assert");
const {
  verdictForScore, buildCandidateSummary, buildScorePrompt, parseScoreReply, missingResumeSkills,
  classifyPageContext, formIsOnPage, ATS_FORM_MIN_FIELDS, submitEvidenceVerdict, MATCH_MIN_JD_CHARS, SCORE_SYSTEM,
} = require("../lib.js");

// ── verdict bands ──────────────────────────────────────────────────────────────────────────────────
test("verdictForScore: the bands, and nothing for a non-score", () => {
  assert.equal(verdictForScore(10), "strong");
  assert.equal(verdictForScore(8), "strong");
  assert.equal(verdictForScore(7), "moderate");
  assert.equal(verdictForScore(5), "moderate");
  assert.equal(verdictForScore(4), "weak");
  assert.equal(verdictForScore(1), "weak");
  assert.equal(verdictForScore(null), null);
  assert.equal(verdictForScore(NaN), null);
  assert.equal(verdictForScore("8"), null); // a string is not a score — never coerce a model's output
});

// ── the candidate summary ──────────────────────────────────────────────────────────────────────────
const PROFILE = {
  personal_info: { first_name: "Kevin", email: "kev@example.com", phone: "555-0100" },
  work_authorization: { requires_sponsorship: false },
  self_identification: { gender: "Male", race: "Asian" },
  education: [{ degree: ["BS", "Bachelor"], field_of_study: "Computer Engineering", school_or_university: "State U", gpa: "3.8", gpa_scale: "4.0", graduation_date: "2027-05" }],
  work_experience: [{ job_title: "SWE Intern", company: "Acme", from: "2025-06", to: "2025-08", role_description: "Built an API\n- Wrote tests", tech_stack: ["Python", "FastAPI"] }],
  skills: ["Python", "C++", "Git", "Verilog"],
  certifications: [{ certification: "CPP" }],
};

test("buildCandidateSummary: résumé sections in, PII and demographics OUT", () => {
  const s = buildCandidateSummary(PROFILE);
  assert.match(s, /EDUCATION:/);
  assert.match(s, /Computer Engineering/);
  assert.match(s, /SWE Intern @ Acme/);
  assert.match(s, /tech: Python, FastAPI/);
  assert.match(s, /SKILLS: Python, C\+\+, Git, Verilog/);
  assert.match(s, /CERTIFICATIONS: CPP/);
  // The whole point of the exclusion list: none of this may reach a provider.
  assert.doesNotMatch(s, /kev@example\.com/);
  assert.doesNotMatch(s, /555-0100/);
  assert.doesNotMatch(s, /Asian|Male|sponsorship/i);
});

test("buildCandidateSummary: an empty profile is empty, not a crash", () => {
  assert.equal(buildCandidateSummary({}), "");
  assert.equal(buildCandidateSummary(null), "");
});

test("buildScorePrompt: carries the rubric, the summary and a bounded JD", () => {
  const { system, user } = buildScorePrompt(PROFILE, "x".repeat(9000));
  assert.equal(system, SCORE_SYSTEM);
  assert.match(user, /CANDIDATE BACKGROUND:/);
  assert.match(user, /JOB DESCRIPTION:/);
  assert.ok(user.length < 9000, "the JD is truncated to 6000 chars, so one huge posting can't blow the context");
});

// ── parsing the reply ──────────────────────────────────────────────────────────────────────────────
test("parseScoreReply: plain JSON", () => {
  const r = parseScoreReply('{"score":8,"matched_requirements":["Python"],"gaps":["Kubernetes"],"keywords":["gRPC"],"reasoning":"Close fit."}');
  assert.equal(r.score, 8);
  assert.equal(r.verdict, "strong");
  assert.deepEqual(r.matched_requirements, ["Python"]);
  assert.deepEqual(r.gaps, ["Kubernetes"]);
  assert.deepEqual(r.keywords, ["gRPC"]);
  assert.equal(r.rationale, "Close fit.");
});

test("parseScoreReply: a ```json fence and surrounding prose both survive", () => {
  assert.equal(parseScoreReply('```json\n{"score":6}\n```').score, 6);
  assert.equal(parseScoreReply('Sure! Here you go:\n{"score":3, "reasoning":"Different field."}\nHope that helps.').score, 3);
});

test("parseScoreReply: the score is clamped to 1-10 and rounded", () => {
  assert.equal(parseScoreReply('{"score":47}').score, 10);
  assert.equal(parseScoreReply('{"score":0}').score, 1);
  assert.equal(parseScoreReply('{"score":7.6}').score, 8);
});

test("parseScoreReply: junk yields no score and keeps the raw text — never a fabricated number", () => {
  const bad = parseScoreReply("I'm not able to score this.");
  assert.equal(bad.score, null);
  assert.equal(bad.verdict, null);
  assert.equal(bad.error, "parse-failed");
  assert.match(bad.raw, /not able/);
  const noScore = parseScoreReply('{"reasoning":"hmm"}');
  assert.equal(noScore.score, null);
  assert.match(noScore.error, /no score/);
});

test("parseScoreReply: arrays are sanitized, non-arrays become []", () => {
  const r = parseScoreReply('{"score":5,"gaps":["  Go  ", "", null, 7],"keywords":"not-an-array"}');
  assert.deepEqual(r.gaps, ["Go", "7"]);
  assert.deepEqual(r.keywords, []);
});

// ── missing-from-your-resume ───────────────────────────────────────────────────────────────────────
test("missingResumeSkills: only what the profile really lacks", () => {
  const res = { keywords: ["Python", "Kubernetes", "gRPC"], gaps: ["3+ years of Go"] };
  assert.deepEqual(missingResumeSkills(res, PROFILE), ["Kubernetes", "gRPC", "3+ years of Go"]);
});

test("missingResumeSkills: WHOLE-WORD — 'Git' is not covered by 'Digital', 'CAN' not by 'Canadian'", () => {
  const p = { skills: ["Digital design"], work_experience: [{ job_title: "Engineer", company: "Canadian Tire" }] };
  assert.deepEqual(missingResumeSkills({ keywords: ["Git", "CAN"] }, p), ["Git", "CAN"]);
  // …and a real hit is still a hit.
  assert.deepEqual(missingResumeSkills({ keywords: ["Digital design"] }, p), []);
});

test("missingResumeSkills: regex-metacharacter skills (C++, C#, .NET, Node.js) match literally", () => {
  const p = { skills: ["C++", ".NET", "Node.js"] };
  assert.deepEqual(missingResumeSkills({ keywords: ["C++", ".NET", "Node.js", "C#"] }, p), ["C#"]);
});

test("missingResumeSkills: de-duplicates case-insensitively, keywords before gaps, bounded", () => {
  const res = { keywords: ["Rust", "rust", "Elixir"], gaps: ["Rust", "Scala", "Haskell", "OCaml", "Erlang", "Nim", "Zig", "Ada", "Julia"] };
  const out = missingResumeSkills(res, {});
  assert.equal(out[0], "Rust");
  assert.equal(out[1], "Elixir");
  assert.equal(out.length, 8, "default cap");
  assert.equal(new Set(out.map((s) => s.toLowerCase())).size, out.length, "no duplicates");
  assert.equal(missingResumeSkills(res, {}, 2).length, 2);
});

test("missingResumeSkills: nothing to report is an empty list, not a crash", () => {
  assert.deepEqual(missingResumeSkills({}, PROFILE), []);
  assert.deepEqual(missingResumeSkills(null, null), []);
});

// ── which page is this ─────────────────────────────────────────────────────────────────────────────
test("classifyPageContext: Workday posting vs apply flow", () => {
  const job = classifyPageContext("https://comcast.wd5.myworkdayjobs.com/en-US/Comcast_Careers/job/IL/Intern_R438146");
  assert.equal(job.kind, "job");
  assert.equal(job.ats, "workday");
  const form = classifyPageContext("https://comcast.wd5.myworkdayjobs.com/en-US/Comcast_Careers/job/IL/Intern_R438146/apply/applyManually");
  assert.equal(form.kind, "form");
  // the logged-in host counts too
  assert.equal(classifyPageContext("https://wd3.myworkdaysite.com/recruiting/magna/Magna/job/x_R1").ats, "workday");
  assert.equal(classifyPageContext("https://comcast.wd5.myworkdayjobs.com/en-US/Comcast_Careers").kind, "other");
});

test("classifyPageContext: a PROBED page outranks its URL, and review outranks everything", () => {
  const applyUrl = "https://comcast.wd5.myworkdayjobs.com/en-US/x/job/y_R1/apply/applyManually";
  assert.equal(classifyPageContext("https://acme.test/whatever", { formFieldCount: 12 }).kind, "form");
  // A review page carries fields too — it must still be "review", because that is the one state where
  // neither button may fire.
  assert.equal(classifyPageContext(applyUrl, { formFieldCount: 12, reviewMarker: true }).kind, "review");
  assert.equal(classifyPageContext(applyUrl, { submitted: true }).kind, "submitted");
});

test("classifyPageContext: a Workday POSTING stays a posting even if it renders formField-* wrappers", () => {
  // The career site's own search/filter panel uses the same automation-id prefix. Reading that as an
  // application form would offer "Fill page" on a page with no application on it.
  const posting = "https://comcast.wd5.myworkdayjobs.com/en-US/Comcast_Careers/job/IL/Intern_R438146";
  assert.equal(classifyPageContext(posting, { formFieldCount: 4 }).kind, "job");
  // The apply flow is still a form, by URL and by markers.
  assert.equal(classifyPageContext(posting + "/apply/applyManually", { formFieldCount: 0 }).kind, "form");
});

test("classifyPageContext: the other ATSs", () => {
  const gh = classifyPageContext("https://job-boards.greenhouse.io/anthropic/jobs/4020118008");
  assert.equal(gh.ats, "greenhouse");
  assert.equal(gh.kind, "job");
  assert.equal(gh.formIsHere, true, "a Greenhouse posting IS its own application form");
  assert.equal(classifyPageContext("https://jobs.lever.co/kraken/8e4c7b1a-2f3d-4a5b-9c8d-1e2f3a4b5c6d").kind, "job");
  assert.equal(classifyPageContext("https://jobs.lever.co/kraken/8e4c7b1a-2f3d-4a5b-9c8d-1e2f3a4b5c6d/apply").kind, "form");
  assert.equal(classifyPageContext("https://jobs.ashbyhq.com/ramp/8e4c7b1a-2f3d-4a5b-9c8d-1e2f3a4b5c6d").kind, "job");
  assert.equal(classifyPageContext("https://jobs.ashbyhq.com/ramp/8e4c7b1a-2f3d-4a5b-9c8d-1e2f3a4b5c6d/application").kind, "form");
});

test("classifyPageContext: LinkedIn is read-only — we score there, never fill", () => {
  const li = classifyPageContext("https://www.linkedin.com/jobs/view/4123456789/");
  assert.equal(li.kind, "job");
  assert.equal(li.readOnly, true);
});

test("classifyPageContext: an employer careers page is scorable; anything else is 'other'", () => {
  assert.equal(classifyPageContext("https://careers.stripe.com/jobs/12345").kind, "job");
  assert.equal(classifyPageContext("https://news.ycombinator.com/").kind, "other");
  assert.equal(classifyPageContext("not a url").kind, "other");
  assert.equal(classifyPageContext("").kind, "other");
});

// ── is there a form here (which drives the "Fill page" button) ─────────────────────────────────────
test("formIsOnPage: a URL that already says 'form' needs no counting", () => {
  assert.equal(formIsOnPage({ kind: "form", ats: "lever" }, {}), true);
  assert.equal(formIsOnPage({ kind: "form", ats: "workday" }, { formFieldCount: 0 }), true);
});

test("formIsOnPage: Workday counts formField-* wrappers; the ATSs cannot", () => {
  assert.equal(formIsOnPage({ kind: "job", ats: "workday" }, { formFieldCount: 0, atsFieldCount: 30 }), false);
  assert.equal(formIsOnPage({ kind: "other", ats: "workday" }, { formFieldCount: 12 }), true);
  // The generic count is what a Greenhouse/Lever/Ashby form has — Workday's wrapper count is 0 there.
  assert.equal(formIsOnPage({ kind: "job", ats: "lever" }, { formFieldCount: 0, atsFieldCount: 9 }), true);
});

test("formIsOnPage: a Greenhouse posting IS its own form", () => {
  assert.equal(formIsOnPage({ kind: "job", ats: "greenhouse", formIsHere: true }, { atsFieldCount: 0 }), true);
});

test("formIsOnPage: a posting page's stray search box is not an application form", () => {
  assert.equal(formIsOnPage({ kind: "job", ats: "lever" }, { atsFieldCount: ATS_FORM_MIN_FIELDS - 1 }), false);
  assert.equal(formIsOnPage({ kind: "job", ats: "ashby" }, { atsFieldCount: ATS_FORM_MIN_FIELDS }), true);
});

test("formIsOnPage: never on the review page, never after a submit", () => {
  assert.equal(formIsOnPage({ kind: "review", ats: "workday" }, { formFieldCount: 40 }), false);
  assert.equal(formIsOnPage({ kind: "submitted", ats: "lever" }, { atsFieldCount: 40 }), false);
});

test("formIsOnPage: missing probe / ctx is 'no', never a crash", () => {
  assert.equal(formIsOnPage({ kind: "job", ats: "lever" }, null), false);
  assert.equal(formIsOnPage(null, null), false);
});

// ── did they submit it ─────────────────────────────────────────────────────────────────────────────
test("submitEvidenceVerdict: confirmation TEXT is the strong signal", () => {
  for (const t of [
    "You have submitted your application.",
    "Thank you for applying to Acme!",
    "Your application has been submitted",
    "We have received your application.",
    "Application submitted",
  ]) {
    const v = submitEvidenceVerdict({ url: "https://x.test/whatever", bodyText: t });
    assert.equal(v.submitted, true, t);
    assert.equal(v.confidence, "high");
    assert.equal(v.reason, "confirmation-text");
  }
});

test("submitEvidenceVerdict: a confirmation URL counts when the page can't be read", () => {
  assert.equal(submitEvidenceVerdict({ url: "https://jobs.lever.co/acme/123/thanks" }).submitted, true);
  assert.equal(submitEvidenceVerdict({ url: "https://boards.greenhouse.io/acme/application_confirmation" }).submitted, true);
  assert.equal(submitEvidenceVerdict({ url: "https://x.test/apply?submitted=true" }).submitted, true);
  // URL-only (no readable body) is deliberately the weaker claim.
  assert.equal(submitEvidenceVerdict({ url: "https://jobs.lever.co/acme/123/thanks" }).confidence, "medium");
  assert.equal(submitEvidenceVerdict({ url: "https://jobs.lever.co/acme/123/thanks", bodyText: "All done." }).confidence, "high");
});

test("submitEvidenceVerdict: a page still showing the form is NOT a submission", () => {
  // Boilerplate "thank you for your interest" in a live form's footer must never write a tracker row.
  const v = submitEvidenceVerdict({ url: "https://x.test/apply", bodyText: "Thank you for applying — please complete the form below.", formFieldCount: 14 });
  assert.equal(v.submitted, false);
  assert.equal(v.reason, "still-on-form");
  assert.equal(submitEvidenceVerdict({ url: "https://x.test/thanks", reviewMarker: true }).submitted, false);
});

test("submitEvidenceVerdict: no evidence means no", () => {
  assert.equal(submitEvidenceVerdict({ url: "https://x.test/apply", bodyText: "Page 3 of 5" }).submitted, false);
  assert.equal(submitEvidenceVerdict({}).submitted, false);
  assert.equal(submitEvidenceVerdict(null).submitted, false);
  // Navigating AWAY from the review page is not evidence either — absence of a form is not a submit.
  assert.equal(submitEvidenceVerdict({ url: "https://x.test/home", bodyText: "My Applications" }).submitted, false);
});

test("MATCH_MIN_JD_CHARS is the floor the popup refuses to score below", () => {
  assert.equal(MATCH_MIN_JD_CHARS, 40);
});
