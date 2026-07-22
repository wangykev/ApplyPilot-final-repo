/**
 * Server-side "open the link and read the JD" for a posting URL. Strategy per ATS:
 *
 *  - Workday (*.myworkdayjobs.com): the apply page is a JS shell, but every tenant
 *    exposes the description at /wday/cxs/{tenant}/{site}/job/{path} as JSON. We hit
 *    that and read jobPostingInfo.jobDescription. (Verified against SEL, NREL, PANW…)
 *  - Greenhouse (*.greenhouse.io): server-rendered; the board API returns clean JSON,
 *    with a raw-HTML fetch as fallback for the /embed/job_app token form.
 *  - Everything else (Ashby, Rippling, Tesla, iCIMS, …): try a raw fetch and keep it
 *    only if it yields substantial text; SPAs return a thin shell → needsBrowser, i.e.
 *    "read this one in-browser via the extension" (which renders the real page).
 *
 * The classifier `atsOf` and the URL transform `workdayCxsUrl` are pure/testable;
 * `fetchJobDescription` does the network and never throws (returns a failure shape).
 */

export type Ats =
  | "workday"
  | "greenhouse"
  | "ashby"
  | "rippling"
  | "lever"
  | "icims"
  | "other";

export type JdResult =
  | { ok: true; text: string; source: "workday-cxs" | "greenhouse" | "generic" }
  | { ok: false; reason: string; needsBrowser: boolean };

const ENTITY_RE = /&(amp|lt|gt|quot|#39|nbsp|#x27|apos);/g;
const ENTITY_MAP: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " ", "#x27": "'", apos: "'",
};

/** Strip HTML to readable text and collapse whitespace. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|br|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ")
    .replace(ENTITY_RE, (m, e) => ENTITY_MAP[e] ?? m)
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/g, "");
}

export function atsOf(url: string): Ats {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "other";
  }
  if (host.endsWith("myworkdayjobs.com")) return "workday";
  if (host.endsWith("greenhouse.io")) return "greenhouse";
  if (host.endsWith("ashbyhq.com")) return "ashby";
  if (host.endsWith("rippling.com")) return "rippling";
  if (host.endsWith("lever.co")) return "lever";
  if (host.endsWith("icims.com")) return "icims";
  return "other";
}

/** Convert a Workday apply/job URL to its CxS JSON endpoint, or null if it isn't one. */
export function workdayCxsUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!u.hostname.endsWith("myworkdayjobs.com")) return null;
  const tenant = u.hostname.split(".")[0];
  const parts = u.pathname.split("/").filter(Boolean);
  const ji = parts.indexOf("job");
  if (ji < 1) return null; // need a {site} segment before "job"
  const site = parts[ji - 1];
  const jobPath = parts.slice(ji + 1).join("/");
  if (!site || !jobPath) return null;
  return `${u.origin}/wday/cxs/${tenant}/${site}/job/${jobPath}`;
}

async function fetchWorkday(url: string, doFetch: typeof fetch): Promise<JdResult> {
  const cxs = workdayCxsUrl(url);
  if (!cxs) return { ok: false, reason: "Not a recognizable Workday job URL.", needsBrowser: true };
  const res = await doFetch(cxs, {
    headers: { Accept: "application/json", "User-Agent": "ApplyPilot-match/1.0" },
  });
  if (!res.ok) return { ok: false, reason: `Workday CxS HTTP ${res.status}`, needsBrowser: true };
  const data = (await res.json()) as {
    jobPostingInfo?: { jobDescription?: string; title?: string };
  };
  const html = data?.jobPostingInfo?.jobDescription;
  if (!html) return { ok: false, reason: "No jobDescription in CxS payload.", needsBrowser: false };
  const text = htmlToText(html);
  if (text.length < 120) return { ok: false, reason: "CxS description too short.", needsBrowser: true };
  return { ok: true, text, source: "workday-cxs" };
}

async function fetchGreenhouse(url: string, doFetch: typeof fetch): Promise<JdResult> {
  const m = /greenhouse\.io\/([^/]+)\/jobs\/(\d+)/i.exec(url);
  if (m) {
    const [, board, id] = m;
    const api = `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`;
    const res = await doFetch(api, { headers: { "User-Agent": "ApplyPilot-match/1.0" } });
    if (res.ok) {
      const data = (await res.json()) as { content?: string };
      if (data?.content) {
        const text = htmlToText(data.content);
        if (text.length >= 120) return { ok: true, text, source: "greenhouse" };
      }
    }
  }
  return fetchGeneric(url, doFetch); // embed/token form or API miss → raw fetch
}

async function fetchGeneric(url: string, doFetch: typeof fetch): Promise<JdResult> {
  const res = await doFetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; ApplyPilot-match/1.0; +https://applypilot)",
      Accept: "text/html",
    },
  });
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, needsBrowser: true };
  const html = await res.text();
  const text = htmlToText(html);
  // A JS-only SPA returns a thin shell; treat that as "needs a real browser".
  if (text.length < 600) return { ok: false, reason: "Page rendered client-side (thin HTML).", needsBrowser: true };
  return { ok: true, text, source: "generic" };
}

/** Fetch a posting's full JD. Never throws — returns {ok:false, needsBrowser} on any failure. */
export async function fetchJobDescription(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JdResult> {
  try {
    switch (atsOf(url)) {
      case "workday":
        return await fetchWorkday(url, fetchImpl);
      case "greenhouse":
        return await fetchGreenhouse(url, fetchImpl);
      case "ashby":
      case "rippling":
        // Known SPAs — a raw fetch won't have the JD; the extension reads these.
        return { ok: false, reason: "Client-rendered ATS — read in-browser.", needsBrowser: true };
      default:
        return await fetchGeneric(url, fetchImpl);
    }
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "JD fetch failed.",
      needsBrowser: true,
    };
  }
}
