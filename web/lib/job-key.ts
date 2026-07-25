/**
 * Stable per-JOB identity for tracker dedup — LOCKSTEP with `canonicalJobUrl` in the extension's
 * lib.js. A Workday application URL varies across runs AND hosts: the posting the user pastes is
 * <tenant>.wdN.myworkdayjobs.com (tenant in the SUBDOMAIN), but after login the form is on
 * wdN.myworkdaysite.com (tenant only in the PATH). The one token common to both hosts is the
 * data-center (wd3, wd5, …); with the requisition id (…_R00244793, in both paths) it makes a key
 * "<dc>:r<reqid>" that collapses the posting + every form/instance/query variant to ONE row.
 * No _R match → origin+pathname minus query and the trailing /apply… tail. Keep identical to the JS copy.
 */
export function canonicalJobUrl(u: string): string {
  try {
    const p = new URL(String(u));
    const req = (p.pathname.match(/_R(\d+)\b/i) || [])[1];
    const dc = (p.hostname.match(/\bwd\d+\b/i) || [""])[0].toLowerCase(); // "wd3" — on both hosts
    if (req) return (dc || "wd") + ":r" + req;
    return (p.origin + p.pathname)
      .toLowerCase()
      .replace(/\/apply(?:\/[^/]*)*\/?$/i, "")
      .replace(/\/+$/, "");
  } catch {
    return String(u == null ? "" : u).split(/[?#]/)[0].toLowerCase();
  }
}
