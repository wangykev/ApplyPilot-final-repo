/**
 * Pure, deterministic job-match scorer. Given a posting (title/company/location +
 * optionally the FULL job description) and a signal derived from the user's
 * profile, produce a 0–100 fit score, an eligibility verdict, and human-readable
 * reasons. No network, no LLM — unit-testable in isolation (test/matching.test.ts).
 *
 * Design notes:
 * - The score is transparent: domain-keyword overlap + profile-skill overlap +
 *   field-of-study alignment, damped by eligibility blockers found in the JD.
 * - Eligibility is SEPARATE from fit. A role whose skills match perfectly is still
 *   flagged "no" if the JD requires a degree level / prior status the user lacks.
 *   We only assert "no"/"maybe" when the FULL JD was read; a title-only score is
 *   "unknown" eligibility and is capped so JD-verified matches stand out.
 * - Sponsorship never lowers a score (a US-authorized citizen is unaffected); a
 *   citizenship/clearance requirement is surfaced as a note, not a silent penalty.
 */

import type { Profile } from "@/lib/profile-schema";

export type DegreeLevel = "undergraduate" | "graduate" | "unknown";
export type Eligibility = "yes" | "maybe" | "no" | "unknown";
export type Tier = "strong" | "solid" | "stretch";

export type ProfileSignal = {
  skills: string[]; // lowercased
  fieldsOfStudy: string[]; // lowercased
  degreeLevel: DegreeLevel;
  gradYear: number | null;
  gpa: number | null;
  usAuthorized: boolean;
  needsSponsorship: boolean;
};

export type ScoreInput = {
  title: string;
  company: string;
  location: string;
  /** The full job-description text, or null when it couldn't be fetched. */
  jd: string | null;
  /** True when the posting is a Workday tenant the extension can drive. */
  autoApply: boolean;
};

export type MatchResult = {
  score: number; // 0–100
  tier: Tier;
  eligibility: Eligibility;
  reasons: string[];
  matchedSkills: string[];
  jdRead: boolean;
};

// Domain vocabularies. CORE = the user's hardware/embedded strengths (weighted
// highest); SWE = general software; LOW = weak-fit signals that pull a score down.
const CORE = [
  "embedded", "firmware", "fpga", "verilog", "systemverilog", "rtl", "microcontroller",
  "mcu", "hardware", "pcb", "circuit", "robot", "robotics", "ros", "motor", "control system",
  "controls", "closed-loop", "closed loop", "dsp", "real-time", "real time", "signal processing",
  "sensor", "can bus", "electrical engineering", "autonomous", "instrument", "power system",
];
const SWE = [
  "software engineer", "software developer", "software development", "backend", "back-end",
  "systems programming", "c++", "python", "java ", "algorithm", "data structure", "api",
  "distributed", "low-level", "operating system", "linux", "git", "compiler", "full stack",
  "full-stack",
];
const LOW = [
  "front-end", "frontend", "react", "angular", "ui/ux", "marketing", "content", "seo",
  "sales", "recruiting", "graphic design", "social media", "financial reporting",
];

function uniqLower(xs: string[]): string[] {
  return Array.from(new Set(xs.map((s) => s.trim().toLowerCase()).filter(Boolean)));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Count DISTINCT vocabulary entries present in the haystack. */
function countHits(vocab: string[], haystack: string): string[] {
  return vocab.filter((k) => haystack.includes(k));
}

/** Skill match with letter-boundaries so "c" / "can" / "git" don't false-hit mid-word. */
function matchSkills(skills: string[], haystack: string): string[] {
  return skills.filter((s) => {
    if (s.length < 3) return false; // too-short skills over-match; skip in text search
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(s)}([^a-z0-9]|$)`, "i");
    return re.test(haystack);
  });
}

function pickGradYear(p: Profile): number | null {
  let best: number | null = null;
  for (const e of p.education ?? []) {
    const fromDate = /^(\d{4})/.exec(e.graduation_date ?? "")?.[1];
    const fromTo = /^(\d{4})$/.exec(e.to_year ?? "")?.[1];
    const y = fromDate ? Number(fromDate) : fromTo ? Number(fromTo) : null;
    if (y && (best === null || y > best)) best = y;
  }
  return best;
}

function pickGpa(p: Profile): number | null {
  for (const e of p.education ?? []) {
    const g = Number.parseFloat(e.gpa ?? "");
    if (Number.isFinite(g) && g > 0) return g;
  }
  return null;
}

export function buildProfileSignal(p: Profile): ProfileSignal {
  const skills = uniqLower(p.skills ?? []);
  const fieldsOfStudy = uniqLower((p.education ?? []).flatMap((e) => e.field_of_study ?? []));
  const degrees = (p.education ?? []).flatMap((e) => e.degree ?? []).map((d) => d.toLowerCase());
  const hasBachelor = degrees.some((d) => /bachelor|b\.?s\.?\b|undergrad/.test(d));
  const hasGrad = degrees.some((d) => /master|ph\.?d|mba|graduate|m\.?s\.?\b/.test(d));
  const enrolled = (p.education ?? []).some((e) => e.currently_enrolled);
  const degreeLevel: DegreeLevel = hasBachelor
    ? "undergraduate"
    : hasGrad
      ? "graduate"
      : enrolled
        ? "undergraduate"
        : "unknown";
  return {
    skills,
    fieldsOfStudy,
    degreeLevel,
    gradYear: pickGradYear(p),
    gpa: pickGpa(p),
    usAuthorized: p.work_authorization?.authorized_to_work_in_us === true,
    needsSponsorship: p.work_authorization?.requires_sponsorship_now === true,
  };
}

function tierOf(score: number): Tier {
  return score >= 78 ? "strong" : score >= 60 ? "solid" : "stretch";
}

/** Assess eligibility from the FULL JD text. Returns "unknown" if no JD was read. */
function assessEligibility(
  jd: string,
  sig: ProfileSignal,
): { eligibility: Eligibility; notes: string[] } {
  const t = jd.toLowerCase();
  const notes: string[] = [];

  // Graduate-degree-only: a graduate requirement with NO bachelor's alternative.
  const wantsGrad = /(2-year )?graduate degree|master'?s or ph\.?d|pursuing (a |an )?(2-year )?graduate|currently pursuing[^.]{0,40}(master|ph\.?d|graduate)/.test(t);
  const allowsBachelor = /bachelor|undergraduate|b\.?s\.?\b/.test(t);
  if (wantsGrad && !allowsBachelor && sig.degreeLevel === "undergraduate") {
    notes.push("Requires a graduate degree — as an undergraduate you don't qualify.");
    return { eligibility: "no", notes };
  }

  // Returning-intern / prior-employment conversion programs.
  if (/previously interned|returning intern|must have (previously )?interned|prior internship with (us|the company)/.test(t)) {
    notes.push("For returning interns of this company only.");
    return { eligibility: "no", notes };
  }

  let eligibility: Eligibility = "yes";

  // Grad-year targeting: years mentioned near "graduat…" that exclude the user's year.
  if (sig.gradYear) {
    const years = new Set<number>();
    const re = /(?:graduat[a-z]*|class of|degree)[^.\n]{0,50}?(20\d{2})|(20\d{2})[^.\n]{0,25}?graduat/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) {
      const y = Number(m[1] ?? m[2]);
      if (y >= 2024 && y <= 2032) years.add(y);
    }
    if (years.size > 0 && !years.has(sig.gradYear)) {
      const list = [...years].sort().join(", ");
      notes.push(`Targets ${list} graduates; you graduate ${sig.gradYear}.`);
      eligibility = "maybe";
    }
  }

  // Minimum-GPA gate.
  const gpaReq = /(?:minimum|min\.?)[^.\n]{0,20}?(\d\.\d{1,2})\s*(?:gpa|grade point)|(\d\.\d{1,2})\s*(?:gpa|grade point)\s*(?:minimum|required|or higher)/i.exec(t);
  if (gpaReq && sig.gpa) {
    const req = Number(gpaReq[1] ?? gpaReq[2]);
    if (Number.isFinite(req) && sig.gpa < req) {
      notes.push(`Wants a ${req.toFixed(2)} GPA; yours is ${sig.gpa.toFixed(2)}.`);
      eligibility = eligibility === "yes" ? "maybe" : eligibility;
    }
  }

  // Security clearance (the user has none).
  if (/security clearance|ts\/sci|top secret|active .{0,12}clearance/.test(t)) {
    notes.push("May require a security clearance — verify.");
    eligibility = eligibility === "yes" ? "maybe" : eligibility;
  }

  // Citizenship / export control (a US citizen qualifies — informational).
  if (/u\.?s\.? citizen|must be a u\.?s\.? person|export control/.test(t) && sig.usAuthorized) {
    notes.push("US citizenship / US-person status required — you qualify.");
  }

  return { eligibility, notes };
}

export function scoreMatch(input: ScoreInput, sig: ProfileSignal): MatchResult {
  const jdText = input.jd ?? "";
  const jdRead = jdText.trim().length > 200;
  const haystack = `${input.title} ${input.company} ${jdRead ? jdText : ""}`.toLowerCase();

  const core = countHits(CORE, haystack);
  const swe = countHits(SWE, haystack);
  const low = countHits(LOW, haystack);
  const matchedSkills = matchSkills(sig.skills, haystack);

  let score = 42;
  score += Math.min(core.length * 6, 30);
  score += Math.min(swe.length * 3, 15);
  score -= Math.min(low.length * 4, 16);
  score += Math.min(matchedSkills.length * 3, 18);

  const fosHit = ["computer engineering", "electrical", "computer science"].some((f) =>
    haystack.includes(f),
  );
  if (fosHit) score += 5;

  score = Math.max(12, Math.min(96, score));

  const reasons: string[] = [];
  if (core.length > 0) {
    reasons.push(`Hits your hardware/embedded domain (${core.slice(0, 4).join(", ")}).`);
  }
  if (matchedSkills.length > 0) {
    reasons.push(`Names your skills: ${matchedSkills.slice(0, 6).join(", ")}.`);
  }
  if (low.length > 0 && core.length === 0) {
    reasons.push(`Leans ${low.slice(0, 2).join(" / ")} — further from your focus.`);
  }

  let eligibility: Eligibility = "unknown";
  if (jdRead) {
    const e = assessEligibility(jdText, sig);
    eligibility = e.eligibility;
    reasons.push(...e.notes);
    if (eligibility === "no") score = Math.min(score, 28);
    else if (eligibility === "maybe") score = Math.round(score * 0.85);
  } else {
    // Title-only: cap confidence so a JD-verified match always outranks a guess.
    score = Math.min(score, 82);
    reasons.push("Scored from the title only — full JD not fetched.");
  }

  return {
    score,
    tier: tierOf(score),
    eligibility,
    reasons,
    matchedSkills,
    jdRead,
  };
}
