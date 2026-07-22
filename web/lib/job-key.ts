/**
 * Stable per-JOB identity for tracker dedup — LOCKSTEP with `canonicalJobUrl` in the extension's
 * lib.js. A Workday application URL varies across runs (after login the form lives on
 * <tenant>.wdN.myworkdaysite.com with a per-application-instance path; the pasted posting is on
 * myworkdayjobs.com), but every variant carries the same tenant subdomain + requisition id
 * (…_R00244793). Reduce any of them to "<tenant.wdN>:r<reqid>" so both writers (the extension's
 * reportApplication and the web saveRunJob) land on ONE row per job. No _R match → origin+pathname
 * minus query and the trailing /apply… tail. Keep this identical to the JS copy.
 */
export function canonicalJobUrl(u: string): string {
  try {
    const p = new URL(String(u));
    const host = p.hostname.toLowerCase().replace(/\.myworkday(?:jobs|site)\.com$/i, ""); // "magna.wd3"
    const req = (p.pathname.match(/_R(\d+)\b/i) || [])[1];
    if (req && host) return host + ":r" + req;
    return (p.origin + p.pathname)
      .toLowerCase()
      .replace(/\/apply(?:\/[^/]*)*\/?$/i, "")
      .replace(/\/+$/, "");
  } catch {
    return String(u == null ? "" : u).split(/[?#]/)[0].toLowerCase();
  }
}
