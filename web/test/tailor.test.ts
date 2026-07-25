import { test } from "node:test";
import assert from "node:assert/strict";
import {
  splitRoleDescription,
  workUnits,
  projectUnits,
  skillUnits,
  buildTailorPrompt,
  parseTailorReply,
  verifyFactsPreserved,
  buildProfileVocab,
  identityResume,
} from "@/lib/tailor";
import { escapeLatex, tailoredToTex, tailoredToPrintHtml, displayDate, dateRange } from "@/lib/resume-doc";
import { coerceProfile } from "@/lib/profile-schema";

const PROFILE = coerceProfile({
  personal_info: { first_name: "Kevin", last_name: "Wang", email: "k@x.com", phone_number: "850-666-0266" },
  websites: [{ type: "linkedin", url: "https://linkedin.com/in/wangykev" }],
  education: [
    {
      degree: "Bachelor of Science",
      field_of_study: "Electrical and Computer Engineering",
      school_or_university: "Carnegie Mellon University",
      gpa: "3.95",
      gpa_scale: "4.00",
      graduation_date: "2028-05",
      coursework: ["Intro to Computer Systems", "Digital Design"],
    },
  ],
  projects: [
    {
      name: "FPGA Motor Control",
      from: "2026-01",
      summary: "real-time motor control on an FPGA",
      bullets: ["Built a real-time motor-control peripheral on an FPGA", "Implemented a fixed-point PID speed loop"],
      tech_stack: ["SystemVerilog", "FPGA"],
    },
    { name: "Summary-only project", summary: "a project with only a summary", bullets: [] },
  ],
  work_experience: [
    {
      job_title: "Robotics Lab Intern",
      company: "FSU / L3Harris",
      location: "Tallahassee, FL",
      from: "2025-05",
      to: "2025-08",
      role_description: "- Developed ROS 2 nodes for robotic systems\n- Implemented CAN bus protocols for 4 motor drivers using C++",
      tech_stack: ["ROS 2", "C++", "CAN bus"],
    },
    {
      job_title: "Firmware Team Member",
      company: "Carnegie Mellon Racing",
      location: "Pittsburgh, PA",
      currently_work_here: true,
      from: "2024-09",
      role_description: "- Analyzed C++ firmware and built a VSM testbench",
      tech_stack: ["C++"],
    },
  ],
  skills: ["C", "C++", "Python", "SystemVerilog"],
});

// ── units ─────────────────────────────────────────────────────────────────────
test("splitRoleDescription: dash/star/dot bullets split; blanks dropped", () => {
  assert.deepEqual(splitRoleDescription("- a\n* b\n• c\n\n  - d "), ["a", "b", "c", "d"]);
  assert.deepEqual(splitRoleDescription(""), []);
});
test("workUnits/skillUnits: stable ids", () => {
  const w = workUnits(PROFILE);
  assert.equal(w[0].id, "W0");
  assert.equal(w[0].bullets[1].id, "W0.B1");
  assert.equal(w[1].bullets[0].id, "W1.B0");
  assert.equal(skillUnits(PROFILE)[3].id, "S3");
});

// ── prompt ────────────────────────────────────────────────────────────────────
test("buildTailorPrompt: numbered units + JD + mode rules in place", () => {
  const { system, user } = buildTailorPrompt(PROFILE, "We need C++ and CAN bus experience.", "select");
  assert.match(system, /SELECT-ONLY/);
  assert.match(user, /\[W0\.B1\] Implemented CAN bus/);
  assert.match(user, /\[S1\] C\+\+/);
  assert.match(user, /JOB DESCRIPTION:/);
  const surface = buildTailorPrompt(PROFILE, "jd", "rewrite-surface");
  assert.match(surface.system, /SURFACE REWRITE/);
  const full = buildTailorPrompt(PROFILE, "jd", "rewrite-full");
  assert.match(full.system, /FULL REWRITE/);
});

// ── select mode: fabrication impossible by construction ──────────────────────
test("select: id strings pick verbatim source bullets in the reply's order", () => {
  const r = parseTailorReply(
    JSON.stringify({
      summary: "Embedded-focused ECE student.",
      experiences: [{ id: "W0", include: true, bullets: ["W0.B1", "W0.B0"] }],
      skills: ["S1", "S3"],
      gaps: ["Kubernetes"],
      reasoning: "why",
    }),
    PROFILE,
    "select"
  );
  assert.equal(r.error, undefined);
  assert.equal(r.experiences[0].bullets[0].text, "Implemented CAN bus protocols for 4 motor drivers using C++");
  assert.equal(r.experiences[0].bullets[0].edited, false);
  assert.deepEqual(r.skills, ["C++", "SystemVerilog"]);
  assert.deepEqual(r.skills_omitted, ["C", "Python"]);
  assert.deepEqual(r.gaps, ["Kubernetes"]);
  // unmentioned experience is kept verbatim (fail-safe)
  assert.equal(r.experiences[1].include, true);
  assert.equal(r.experiences[1].bullets.length, 1);
});
test("select: a {text} rewrite in the reply is IGNORED — source text wins", () => {
  const r = parseTailorReply(
    JSON.stringify({
      experiences: [{ id: "W0", bullets: [{ id: "W0.B0", text: "Invented 10x claim with Kubernetes" }] }],
    }),
    PROFILE,
    "select"
  );
  assert.equal(r.experiences[0].bullets[0].text, "Developed ROS 2 nodes for robotic systems");
  assert.equal(r.experiences[0].bullets[0].edited, false);
});
test("select: unknown / cross-experience ids are skipped; empty result falls back to all bullets", () => {
  const r = parseTailorReply(
    JSON.stringify({ experiences: [{ id: "W0", bullets: ["W1.B0", "W9.B9"] }] }),
    PROFILE,
    "select"
  );
  assert.equal(r.experiences[0].bullets.length, 2, "fell back to the experience's own bullets");
});
test("select: include:false drops an experience; ALL dropped falls back to all included", () => {
  const one = parseTailorReply(
    JSON.stringify({ experiences: [{ id: "W1", include: false, bullets: [] }] }),
    PROFILE,
    "select"
  );
  assert.equal(one.experiences[1].include, false);
  // all experiences dropped but projects remain → allowed (the resume isn't empty)
  const expOnly = parseTailorReply(
    JSON.stringify({
      experiences: [
        { id: "W0", include: false },
        { id: "W1", include: false },
      ],
    }),
    PROFILE,
    "select"
  );
  assert.ok(expOnly.experiences.every((e) => !e.include));
  assert.ok(expOnly.projects.every((p) => p.include));
  // EVERYTHING dropped → fail-safe restores the whole original (never an empty resume)
  const all = parseTailorReply(
    JSON.stringify({
      experiences: [
        { id: "W0", include: false },
        { id: "W1", include: false },
      ],
      projects: [
        { id: "P0", include: false },
        { id: "P1", include: false },
      ],
    }),
    PROFILE,
    "select"
  );
  assert.ok(all.experiences.every((e) => e.include), "never emit an empty resume");
  assert.ok(all.projects.every((p) => p.include));
});

// ── surface mode: facts locked by a deterministic check ──────────────────────
test("verifyFactsPreserved: invented number → violation; dropped number OK; profile-vocab tech OK", () => {
  const vocab = buildProfileVocab(PROFILE);
  assert.match(verifyFactsPreserved("Built 4 drivers", "Built 25 drivers", vocab) ?? "", /invented number "25"/);
  assert.equal(verifyFactsPreserved("Built 4 drivers", "Built motor drivers", vocab), null);
  assert.equal(verifyFactsPreserved("Wrote firmware", "Wrote C++ firmware", vocab), null, "C++ is in the profile vocab");
  assert.match(verifyFactsPreserved("Wrote firmware", "Wrote Kubernetes firmware", vocab) ?? "", /Kubernetes|kubernetes/);
});
test("surface: clean reword accepted (edited); fact violation reverted + flagged", () => {
  const r = parseTailorReply(
    JSON.stringify({
      experiences: [
        {
          id: "W0",
          bullets: [
            { id: "W0.B0", text: "Engineered ROS 2 nodes powering robotic systems" },
            { id: "W0.B1", text: "Implemented CAN bus protocols for 90 motor drivers using C++" },
          ],
        },
      ],
    }),
    PROFILE,
    "rewrite-surface"
  );
  const [ok, bad] = r.experiences[0].bullets;
  assert.equal(ok.edited, true);
  assert.match(ok.text, /Engineered ROS 2/);
  assert.equal(bad.edited, false, "reverted");
  assert.equal(bad.text, "Implemented CAN bus protocols for 4 motor drivers using C++");
  assert.match(bad.violation ?? "", /invented number "90"/);
  assert.equal(r.reverted_count, 1);
});

// ── full mode: flags, never silent ────────────────────────────────────────────
test("full: free text carries sources; out-of-profile tech flagged as fabrication risk", () => {
  const r = parseTailorReply(
    JSON.stringify({
      experiences: [
        {
          id: "W0",
          bullets: [
            { text: "Delivered real-time robotic control software in C++", sources: ["W0.B0", "W0.B1"] },
            { text: "Deployed services on Kubernetes clusters", sources: ["W0.B0"] },
          ],
        },
      ],
    }),
    PROFILE,
    "rewrite-full"
  );
  const [clean, risky] = r.experiences[0].bullets;
  assert.equal(clean.edited, true);
  assert.equal(clean.fabrication_risk, undefined);
  assert.deepEqual(clean.source_ids, ["W0.B0", "W0.B1"]);
  assert.match(risky.fabrication_risk ?? "", /kubernetes/i);
});

// ── projects as first-class units ─────────────────────────────────────────────
test("projectUnits: stable ids; bullets from bullets[]; summary is the fallback bullet", () => {
  const p = projectUnits(PROFILE);
  assert.equal(p[0].id, "P0");
  assert.equal(p[0].bullets[1].id, "P0.B1");
  assert.equal(p[0].tech, "SystemVerilog, FPGA");
  assert.deepEqual(p[1].bullets.map((b) => b.text), ["a project with only a summary"]);
});
test("buildTailorPrompt: projects block + reply contract include projects", () => {
  const { system, user } = buildTailorPrompt(PROFILE, "jd text", "select");
  assert.match(user, /\[P0\] FPGA Motor Control \| tech: SystemVerilog, FPGA/);
  assert.match(user, /\[P0\.B0\] Built a real-time motor-control peripheral/);
  assert.match(system, /"projects": one entry per project id/);
});
test("select: project bullets pick verbatim by id; a cross-section id is skipped", () => {
  const r = parseTailorReply(
    JSON.stringify({ projects: [{ id: "P0", include: true, bullets: ["P0.B1", "W0.B0"] }] }),
    PROFILE,
    "select"
  );
  assert.deepEqual(r.projects[0].bullets.map((b) => b.text), ["Implemented a fixed-point PID speed loop"]);
  // unmentioned project kept verbatim
  assert.equal(r.projects[1].include, true);
});
test("surface: a project rewrite that invents a number is reverted", () => {
  const r = parseTailorReply(
    JSON.stringify({ projects: [{ id: "P0", bullets: [{ id: "P0.B0", text: "Built 12 FPGA peripherals" }] }] }),
    PROFILE,
    "rewrite-surface"
  );
  assert.equal(r.projects[0].bullets[0].text, "Built a real-time motor-control peripheral on an FPGA");
  assert.match(r.projects[0].bullets[0].violation ?? "", /invented number "12"/);
});
test("projects: include:false drops one; experiences survive independently", () => {
  const r = parseTailorReply(
    JSON.stringify({ projects: [{ id: "P1", include: false }] }),
    PROFILE,
    "select"
  );
  assert.equal(r.projects[1].include, false);
  assert.ok(r.experiences.every((e) => e.include));
});

// ── identityResume (the "Original" view + the fail-safe baseline) ─────────────
test("identityResume: every experience included, every bullet verbatim, all skills, no summary", () => {
  const r = identityResume(PROFILE);
  assert.ok(r.experiences.every((e) => e.include));
  assert.equal(r.experiences[0].bullets[0].text, "Developed ROS 2 nodes for robotic systems");
  assert.ok(r.experiences.every((e) => e.bullets.every((b) => !b.edited && b.text === b.source_text)));
  assert.deepEqual(r.skills, ["C", "C++", "Python", "SystemVerilog"]);
  assert.equal(r.summary, "");
  assert.deepEqual(r.gaps, []);
});
test("identityResume: IS the parse fail-safe (a broken reply degrades to exactly the original)", () => {
  const failsafe = parseTailorReply("garbage", PROFILE, "select");
  delete (failsafe as { error?: string }).error;
  delete (failsafe as { raw?: string }).raw;
  assert.deepEqual(failsafe, identityResume(PROFILE, "select"));
});

// ── fail-safety ───────────────────────────────────────────────────────────────
test("unparseable reply → identity resume + error (a broken reply never costs content)", () => {
  const r = parseTailorReply("total garbage, no json", PROFILE, "select");
  assert.equal(r.error, "parse-failed");
  assert.equal(r.experiences.length, 2);
  assert.equal(r.experiences[0].bullets[0].text, "Developed ROS 2 nodes for robotic systems");
  assert.deepEqual(r.skills, ["C", "C++", "Python", "SystemVerilog"]);
});
test("invented skill ids are ignored (skills only ever come from the profile)", () => {
  const r = parseTailorReply(JSON.stringify({ skills: ["S99", "Kubernetes", "S0"] }), PROFILE, "select");
  assert.deepEqual(r.skills, ["C"]);
});

// ── profile coercion robustness (the live-test catch) ────────────────────────
test("coerceProfile: a legacy STRING tri-bool no longer nukes the whole profile to empty", () => {
  const p = coerceProfile({
    work_authorization: { permanent_resident: "no", authorized_to_work_in_us: "Yes", requires_sponsorship_now: "" },
    work_experience: [{ job_title: "Intern", company: "X", role_description: "- did things" }],
    skills: ["C++"],
  });
  assert.equal(p.work_experience.length, 1, "profile content survives");
  assert.equal(p.skills.length, 1);
  assert.equal(p.work_authorization.permanent_resident, false);
  assert.equal(p.work_authorization.authorized_to_work_in_us, true);
  assert.equal(p.work_authorization.requires_sponsorship_now, null, "empty string = unanswered");
});

// ── documents ─────────────────────────────────────────────────────────────────
test("escapeLatex: specials escaped, backslash first", () => {
  assert.equal(escapeLatex("C&A 50% #1 _x_ {y} $5 ~ ^"),
    "C\\&A 50\\% \\#1 \\_x\\_ \\{y\\} \\$5 \\textasciitilde{} \\textasciicircum{}");
  assert.equal(escapeLatex("a\\b"), "a\\textbackslash{}b");
});
test("displayDate/dateRange: YYYY-MM → Mon YYYY; current → Present", () => {
  assert.equal(displayDate("2025-05"), "May 2025");
  assert.equal(dateRange("2024-09", "", true), "Sep. 2024 – Present");
});
test("coerceProfile: projects survive; extension coursework bridges into education[0]", () => {
  const p = coerceProfile({
    education: [{ school_or_university: "CMU" }],
    projects: [{ name: "Vinyl Player", bullets: ["Designed a turntable"], tech_stack: ["Altium"] }],
    application_questions: { role_specific: { coursework_relevant: ["Imperative Computation"] } },
  });
  assert.equal(p.projects.length, 1);
  assert.equal(p.projects[0].name, "Vinyl Player");
  assert.deepEqual(p.education[0].coursework, ["Imperative Computation"]);
});

test("documents: Projects + coursework/GPA render in BOTH tex and print HTML", () => {
  const original = identityResume(PROFILE);
  const tex = tailoredToTex(PROFILE, original);
  assert.match(tex, /\\section\{Projects\}/);
  assert.match(tex, /FPGA Motor Control/);
  assert.match(tex, /Relevant Coursework: Intro to Computer Systems, Digital Design/);
  assert.match(tex, /Cumulative GPA: 3.95\/4.00/);
  const html = tailoredToPrintHtml(PROFILE, original);
  assert.match(html, /<h2>Projects<\/h2>/);
  assert.match(html, /Built a real-time motor-control peripheral/);
  assert.match(html, /Relevant Coursework: Intro to Computer Systems/);
});

test("tailoredToTex: pdfTeX-only lines are \\ifdefined-guarded (same .tex compiles under tectonic/XeTeX)", () => {
  const tex = tailoredToTex(PROFILE, identityResume(PROFILE));
  assert.match(tex, /\\ifdefined\\pdfgentounicode\\input\{glyphtounicode\}\\fi/);
  assert.match(tex, /\\ifdefined\\pdfgentounicode\\pdfgentounicode=1\\fi/);
  assert.ok(!/^\\pdfgentounicode=1$/m.test(tex), "no unguarded pdfTeX primitive");
});

test("tailoredToTex: sb2nov skeleton + escaped content + only included experiences", () => {
  const tailored = parseTailorReply(
    JSON.stringify({
      summary: "ECE student with 100% C++ focus",
      experiences: [
        { id: "W0", include: true, bullets: ["W0.B1"] },
        { id: "W1", include: false },
      ],
      skills: ["S1"],
    }),
    PROFILE,
    "select"
  );
  const tex = tailoredToTex(PROFILE, tailored);
  assert.match(tex, /\\pdfgentounicode=1/);
  assert.match(tex, /Kevin Wang/);
  assert.match(tex, /100\\% C\+\+ focus/, "summary escaped");
  assert.match(tex, /Implemented CAN bus/);
  assert.ok(!tex.includes("Carnegie Mellon Racing"), "dropped experience absent");
  assert.match(tex, /Carnegie Mellon University/, "education always present");
  assert.match(tex, /\\end\{document\}/);
});
test("tailoredToPrintHtml: standalone document, HTML-escaped, single column sections", () => {
  const tailored = parseTailorReply(
    JSON.stringify({ experiences: [{ id: "W0", bullets: ["W0.B0"] }], skills: ["S1"] }),
    PROFILE,
    "select"
  );
  tailored.summary = 'Loves <script> & "quotes"';
  const html = tailoredToPrintHtml(PROFILE, tailored);
  assert.match(html, /<!DOCTYPE html>/);
  assert.match(html, /Kevin Wang/);
  assert.match(html, /Loves &lt;script&gt; &amp; &quot;quotes&quot;/);
  assert.match(html, /Professional Experience/);
  assert.match(html, /Technical Skills/);
  assert.ok(!html.includes("<table"), "no tables — ATS-safe");
});
