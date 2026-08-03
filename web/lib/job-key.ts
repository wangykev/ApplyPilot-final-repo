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
    // Requisition ids are not all "R<digits>" (2026-08-03). Copart and PSECU use JR109393 / JR100897,
    // and those fell through to the origin+pathname fallback — which is NOT stable, because Workday
    // redirects the posting URL you paste to its own canonical spelling ("Harrisburg-PA" ->
    // "Harrisburg%2C-PA"). Live that produced TWO tracker rows for one job, and a submit run that
    // refused its own approved bundle: the fill stored the key under the redirected path, the submit
    // computed it from the pasted one. Any letters+digits requisition token now keys the same way.
    // The _R tier above is untouched and still matches FIRST, so every existing wdN:r<digits> key is
    // byte-identical — only URLs that had no key at all get one.
    const alt = (p.pathname.match(/_([A-Za-z]{1,4}\d[\w-]*?)(?=\/|$)/g) || []).pop();
    if (alt) return (dc || "wd") + ":" + alt.slice(1).toLowerCase();
    // ⚠ An EMBED url carries its job identity ONLY in the query string: every employer's
    // Greenhouse embed is `job-boards.greenhouse.io/embed/job_app?for=<board>&token=<id>`, so
    // origin+pathname collapses ALL of them to one key (live 2026-08-02: a submit run pulled a
    // DIFFERENT company's approved bundle). Keep the job token when the path can't identify it.
    const path = (p.origin + p.pathname)
      .toLowerCase()
      .replace(/\/apply(?:\/[^/]*)*\/?$/i, "")
      .replace(/\/application\/?$/i, "") // Ashby's form tab (2026-07-31) — lockstep with lib.js
      .replace(/\/+$/, "");
    const tok = p.searchParams.get("token") || p.searchParams.get("gh_jid");
    if (tok && /\/embed\/job_app$|\/embed\/job_board$/.test(path)) return path + "?token=" + String(tok).toLowerCase();
    return path;
  } catch {
    return String(u == null ? "" : u).split(/[?#]/)[0].toLowerCase();
  }
}
