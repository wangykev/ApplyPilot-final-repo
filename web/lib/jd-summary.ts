/**
 * DETERMINISTIC job-description summary — the handful of facts you want before deciding whether to
 * finish an application, pulled straight out of the posting text with no model in the loop.
 *
 * THE DESIGN RULE, and it decides every regex below: **a MISS is free, a WRONG ANSWER is not**
 * (operator, 2026-08-12 — "things not listed won't hurt"). The summary sits above the full JD, which
 * is always one scroll away, so anything this fails to find costs the reader nothing. Anything it
 * gets WRONG is worse than useless — it is a confident claim about pay or sponsorship that the
 * posting never made. So every pattern here requires the posting to have said the thing more or less
 * explicitly, and bails rather than guessing.
 *
 * No LLM on purpose: this runs on every JD open, must be instant, and must give the SAME answer every
 * time you open the same posting. A model would be slower, cost money per open, and could word the
 * same fact differently on two viewings of one page.
 */
export type JdFact = { label: string; value: string };

const clean = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Title-case a matched token so "FULL-TIME" and "full time" render the same. */
const tidy = (s: string): string => {
  const t = clean(s).toLowerCase().replace(/\s*-\s*/g, "-");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/**
 * PAY. Ranges and explicit per-hour/per-year figures only — never a bare "$5,000", which in a JD is
 * far more often a bonus, a relocation allowance or an education stipend than the salary.
 */
function pay(t: string): string | null {
  const money = String.raw`\$\s?\d[\d,]*(?:\.\d+)?\s*[kK]?`;
  const range = new RegExp(`${money}\\s*(?:-|–|—|to)\\s*${money}`);
  const m = t.match(range);
  if (m) return clean(m[0]).replace(/\s*(?:-|–|—|to)\s*/, " – ");
  const rate = t.match(new RegExp(`${money}\\s*(?:/|\\bper\\s+)(hour|hr|year|yr|annum)\\b`, "i"));
  if (rate) return clean(rate[0]);
  return null;
}

/** EMPLOYMENT TYPE. Prefer an explicit "this is a …" statement; fall back to a bare token. */
function employmentType(t: string): string | null {
  const explicit = t.match(/\bthis is an?\s+((?:full|part)[- ]time|contract|temporary|intern(?:ship)?|co-?op)\b/i);
  if (explicit) return tidy(explicit[1]);
  const bare = t.match(/\b(internship|co-?op|full[- ]time|part[- ]time|contract position|temporary position)\b/i);
  return bare ? tidy(bare[1]) : null;
}

/**
 * WORKPLACE. Checked hybrid → remote → on-site, because a hybrid posting almost always also contains
 * the word "remote" (as in "remote two days a week") and answering "Remote" there would be wrong.
 */
function workplace(t: string): string | null {
  if (/\bhybrid\b/i.test(t)) return "Hybrid";
  if (/\b(fully remote|remote[- ]first|work from home|\bremote\b)/i.test(t)) return "Remote";
  if (/\b(on-?site|in[- ]office|in person)\b/i.test(t)) return "On-site";
  return null;
}

/** YEARS OF EXPERIENCE — only when the posting ties the number to the word "experience". */
function experience(t: string): string | null {
  const span = t.match(/\b(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s*\+?\s*years?(?:\s+of)?\s+(?:[a-z]+\s+){0,3}experience/i);
  if (span) return `${span[1]}–${span[2]} years`;
  const plus = t.match(/\b(\d{1,2})\s*\+\s*years?(?:\s+of)?\s+(?:[a-z]+\s+){0,3}experience/i);
  if (plus) return `${plus[1]}+ years`;
  const flat = t.match(/\b(?:minimum of\s+|at least\s+)(\d{1,2})\s*years?(?:\s+of)?\s+(?:[a-z]+\s+){0,3}experience/i);
  return flat ? `${flat[1]}+ years` : null;
}

/** DEGREE — spelled-out words only. "BS"/"MS" collide with too much else to be worth the risk. */
function degree(t: string): string | null {
  if (/\b(ph\.?\s?d|doctorate)\b/i.test(t)) return "PhD";
  if (/\bmaster'?s?\b/i.test(t)) return "Master's";
  if (/\bbachelor'?s?\b/i.test(t)) return "Bachelor's";
  return null;
}

/** SPONSORSHIP — the negative is the one that changes whether you bother applying, so it wins. */
function sponsorship(t: string): string | null {
  if (/\b(?:will not|unable to|cannot|do(?:es)? not)\b[^.]{0,40}\bsponsor/i.test(t)) return "No visa sponsorship";
  if (/\b(?:sponsorship (?:is )?available|will sponsor|open to sponsor)/i.test(t)) return "Sponsorship available";
  return null;
}

/** CLEARANCE / EXPORT CONTROL — a hard gate on eligibility, so worth surfacing verbatim-ish. */
function clearance(t: string): string | null {
  const m = t.match(/\b(top secret\/sci|ts\/sci|top secret|secret clearance|security clearance|public trust)\b/i);
  if (m) return tidy(m[1]);
  if (/\b(itar|export[- ]control(?:led)?|u\.?s\.? person)\b/i.test(t)) return "ITAR / US person";
  return null;
}

function travel(t: string): string | null {
  const m = t.match(/\btravel\b[^.]{0,30}?(\d{1,3})\s*%/i);
  return m ? `Up to ${m[1]}%` : null;
}

function deadline(t: string): string | null {
  const m = t.match(/\bappl(?:y|ications?)\b[^.]{0,24}?\b(?:by|before|close[sd]?(?:\s+on)?)\s+([A-Z][a-z]{2,8}\.?\s+\d{1,2}(?:,?\s+\d{4})?)/);
  return m ? clean(m[1]) : null;
}

/**
 * The ordered fact list. Empty array = nothing was confidently found, and the caller should render no
 * summary panel at all rather than an empty box claiming there was nothing to say.
 */
export function summarizeJd(text: string | null | undefined): JdFact[] {
  const t = String(text || "");
  if (!t.trim()) return [];
  const out: JdFact[] = [];
  const add = (label: string, v: string | null) => { if (v) out.push({ label, value: v }); };
  add("Pay", pay(t));
  add("Type", employmentType(t));
  add("Workplace", workplace(t));
  add("Experience", experience(t));
  add("Degree", degree(t));
  add("Sponsorship", sponsorship(t));
  add("Clearance", clearance(t));
  add("Travel", travel(t));
  add("Apply by", deadline(t));
  return out;
}
