// ============================================================================
// gmail.js — Gmail auto-verify adapter (the account-creation email step).
//
// WHAT: after the onboarding flow creates a Workday account, Workday emails a
// verification LINK. This module reads the operator's Gmail inbox (READ-ONLY),
// finds that email, and extracts the link so the service worker can navigate the
// CDP tab to it (the port of the Playwright repo's gmail_client.py +
// workday._handle_email_verification — verbatim behavior, extension substrate).
//
// AUTH: chrome.identity.getAuthToken with the gmail.readonly scope ONLY (declared
// in manifest.oauth2). Chrome owns the native account picker + token cache/refresh;
// we never store a token or a refresh token ourselves. Readonly is side-effect-free
// by construction — it cannot mark-read, send, or mutate anything.
//
// CLIENT-SIDE BOUNDARY (hard rule): the token and every byte of Gmail message data
// stay in this extension. They are NEVER routed to a backend. That boundary is what
// keeps this "verification-only" and avoids a restricted-scope CASA assessment even
// after a Phase-2 backend lands.
//
// SHAPE: mirrors llm.js — one file loaded three ways (SW importScripts / Node
// require via the UMD guard at the bottom), NEVER throws (every failure is a
// normalized { ok:false, error }), and the network + poll logic take an INJECTED
// fetch/sleep/now so the whole find-the-email loop is Node-testable without chrome
// or a live inbox (test/gmail.test.js). The only untestable surface is the thin
// chrome.identity token glue (gmailGetToken/gmailRemoveCachedToken).
// ============================================================================

// ── Pure helpers (no chrome, no network — unit-tested) ──────────────────────

// Decode Gmail's base64url message-part data to a UTF-8 string. Gmail uses the
// URL-safe alphabet (-/_ for +//) and drops padding; atob wants standard + padding.
// atob/TextDecoder are globals in both the SW and modern Node, so this runs in both.
function gmailB64UrlDecode(data) {
  if (!data) return "";
  let s = String(data).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  let bin;
  try { bin = atob(s); } catch (e) { return ""; }
  try {
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch (e) { return bin; } // fall back to the raw binary string (good enough for URL regex)
}

// Recursively walk a Gmail message payload and concatenate every text/plain and
// text/html part (base64url-decoded). Mirrors gmail_client._extract_body_text:
// leaf part → decode body.data; multipart → recurse. The HTML parts matter — the
// verify link usually lives in an href="…", which the URL regex catches inside the
// raw HTML just as well as in plaintext.
function gmailExtractBodyText(payload) {
  if (!payload) return "";
  const parts = payload.parts;
  if (!parts || !parts.length) {
    const data = payload.body && payload.body.data;
    return data ? gmailB64UrlDecode(data) : "";
  }
  let text = "";
  for (const part of parts) {
    const mime = (part && part.mimeType) || "";
    if (mime === "text/plain" || mime === "text/html") {
      const data = part.body && part.body.data;
      if (data) text += gmailB64UrlDecode(data) + "\n";
    } else if (mime.indexOf("multipart") !== -1) {
      text += gmailExtractBodyText(part);
    }
  }
  return text;
}

// Extract the verification URL from a decoded body. Mirrors
// _extract_verification_url: the FIRST http(s) URL that contains `urlMustContain`
// (the caller passes the TENANT HOST — e.g. "capitalone.wd1.myworkdayjobs.com" —
// so a Workday email's logo/footer/tracking links are skipped and only the
// tenant's own activate link matches). If no needle is given, fall back to a URL
// carrying an activate/verify/confirm token (defensive — the caller always sets a
// needle in practice). HTML bodies encode & as &amp; inside href, so decode it.
function gmailExtractVerificationUrl(body, urlMustContain) {
  if (!body) return null;
  const urls = (String(body).match(/https?:\/\/[^\s"'<>]+/g) || []).map((u) => u.replace(/&amp;/g, "&"));
  const needle = urlMustContain || "";
  const activate = /\/(activate|verify|verification|confirm)\b|token=|activationCode=/i;
  const hostUrls = needle ? urls.filter((u) => u.indexOf(needle) !== -1) : urls;
  // Prefer an activation/verify-looking link — so a job-listing link that happens to share the
  // tenant host (a Workday email can carry both) is never mistaken for the verify link.
  const preferred = hostUrls.find((u) => activate.test(u));
  if (preferred) return preferred;
  // With a tenant-host needle, the first host-matching URL is an acceptable fallback; WITHOUT a
  // needle, only return an activate-looking URL (never a random first link).
  return needle ? (hostUrls[0] || null) : null;
}

// ── A NUMERIC VERIFICATION CODE, NOT A LINK (Oracle Recruiting Cloud, 2026-08-19) ──────────
// Workday emails a clickable activation URL; ORC emails a SIX-DIGIT CODE to type into six boxes
// ("Confirm Your Identity"). Same auto-verify purpose, a different payload, so this sits beside
// gmailExtractVerificationUrl rather than inside it.
//
// ⚠ THE ADVERSARIAL CASE IS REAL, NOT HYPOTHETICAL: an ORC requisition id is itself six digits
// (`…/job/334325`), and the verification email carries links back to the posting. A naive
// `\d{6}` would happily return the JOB ID and then report "the code was rejected", sending the
// next debugging round at the typing code rather than at the extraction. Two guards:
//
//   1. URLs are stripped FIRST, so a job id, a tracking parameter or a message id inside a link
//      cannot be a candidate at all.
//   2. A candidate must sit near a code-ish word. Only if the body contains EXACTLY ONE candidate
//      overall is proximity waived — and otherwise it REFUSES. Refusing costs one operator stop;
//      guessing burns the code (each wrong submit may invalidate it) and lies about why.
//
// `\b\d{6}\b` is deliberate: `\b` is not a boundary between two digits, so a 7+ digit run is
// rejected wholesale rather than having its first six taken.
var GMAIL_CODE_KEYWORD_RE = /(verification|verify|confirm|identity|security|access|one[\s-]?time|passcode|\bpin\b|\bcode\b|\botp\b)/gi;

function gmailExtractVerificationCode(body, opts) {
  const o = opts || {};
  const len = Number(o.length) > 0 ? Number(o.length) : 6;
  const windowChars = o.windowChars != null ? Number(o.windowChars) : 200;
  const text = String(body == null ? "" : body);
  if (!text) return null;

  const noUrls = text.replace(/https?:\/\/[^\s"'<>]+/g, " ");

  const cands = [];
  const digitRe = new RegExp("\\b\\d{" + len + "}\\b", "g");
  for (let m = digitRe.exec(noUrls); m; m = digitRe.exec(noUrls)) cands.push({ code: m[0], at: m.index });
  if (!cands.length) return null;

  const keys = [];
  GMAIL_CODE_KEYWORD_RE.lastIndex = 0;
  for (let m = GMAIL_CODE_KEYWORD_RE.exec(noUrls); m; m = GMAIL_CODE_KEYWORD_RE.exec(noUrls)) keys.push(m.index);

  if (keys.length) {
    let best = null;
    for (const c of cands) {
      for (const k of keys) {
        const d = Math.abs(c.at - k);
        if (d <= windowChars && (!best || d < best.d)) best = { code: c.code, d };
      }
    }
    if (best) return best.code;
  }
  // No keyword anywhere near a candidate. A LONE candidate is still unambiguous; two or more is a
  // guess, and this refuses to make it.
  return cands.length === 1 ? cands[0].code : null;
}

// The Gmail search `q`. Mirrors the reference: sender + a 1h recency floor (the
// hard freshness guard is the internalDate cutoff below; newer_than:1h just keeps
// the result set small). Optional subject narrows further (unused by the caller).
function gmailBuildQuery(senderContains, subjectContains) {
  // Match ANY recent Workday verification email. The SENDER is unreliable — some tenants send from
  // Workday@<tenant>.com rather than workday.com (Palo Alto Networks: Workday@paloaltonetworks.com,
  // 2026-07-09), so keying on from:workday.com missed it. Instead key on the "myworkdayjobs" token
  // that the activate LINK in the body always carries, OR the workday.com sender. The
  // urlMustContain=tenant-host filter downstream is the decisive gate; this only narrows candidates
  // to the last hour.
  const sender = senderContains || "workday.com";
  let q = "newer_than:1h (myworkdayjobs OR from:" + sender + ")";
  if (subjectContains) q += " subject:" + subjectContains;
  return q;
}

// ── Network (injected fetch; never throws) ──────────────────────────────────

// One authenticated GET against users/me + `path`. Returns { ok, data } or
// { ok:false, status, error } — status is surfaced so the caller can react to a
// 401/403 (stale/insufficient token) by refreshing it. fetchImpl is injectable
// for tests; defaults to the global fetch (SW).
async function gmailApiGet(token, path, fetchImpl) {
  const fetchFn = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  if (!fetchFn) return { ok: false, error: "no fetch available in this context" };
  if (!token) return { ok: false, error: "no token" };
  const url = "https://gmail.googleapis.com/gmail/v1/users/me" + path;
  let res;
  try { res = await fetchFn(url, { headers: { Authorization: "Bearer " + token } }); }
  catch (e) { return { ok: false, error: "network error: " + String((e && e.message) || e) }; }
  if (!res || !res.ok) {
    let body = "";
    try { body = await res.text(); } catch (e) { /* ignore */ }
    return { ok: false, status: res ? res.status : 0, error: "HTTP " + (res ? res.status : "?") + (body ? ": " + body.slice(0, 200) : "") };
  }
  try { return { ok: true, data: await res.json() }; }
  catch (e) { return { ok: false, error: "bad JSON response: " + String((e && e.message) || e) }; }
}

// Poll the inbox for the Workday verification email and return its link. Options:
//   token           — a gmail.readonly access token (from gmailGetToken)
//   senderContains  — sender filter (default "workday.com")
//   urlMustContain  — the tenant host the link must contain (STRONGLY recommended)
//   subjectContains — optional subject narrowing
//   timeoutMs       — total poll budget (default 120000, matching the reference)
//   pollMs          — inter-poll wait (default 5000)
//   sinceMs         — freshness floor: reject any message older than now-sinceMs
//                     (default 300000 = 5min; prevents matching a LEFTOVER verify
//                     mail from a prior run — the reference's since_seconds guard)
//   maxResults      — messages.list page size (default 10)
//   fetchImpl/sleepImpl/nowImpl — injected for tests
// Returns { ok:true, url, messageId, internalDate } or { ok:false, error, ... }.
// NEVER throws. A 401/403 bubbles up immediately (status kept) so the SW can
// refresh the token and call again — the loop itself doesn't touch chrome.
async function gmailFindVerificationEmail(opts) {
  const o = opts || {};
  const fetchFn = o.fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  const sleep = o.sleepImpl || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = o.nowImpl || (() => Date.now());
  if (!fetchFn) return { ok: false, error: "no fetch available in this context" };
  if (!o.token) return { ok: false, error: "no Gmail token" };

  const senderContains = o.senderContains || "workday.com";
  const urlMustContain = o.urlMustContain || "";
  const timeoutMs = o.timeoutMs != null ? o.timeoutMs : 120000;
  const pollMs = o.pollMs != null ? o.pollMs : 5000;
  const sinceMs = o.sinceMs != null ? o.sinceMs : 300000;
  const maxResults = o.maxResults || 10;

  const start = now();
  const cutoffMs = start - sinceMs;
  const q = gmailBuildQuery(senderContains, o.subjectContains);
  let lastErr = null;

  while (now() - start < timeoutMs) {
    const list = await gmailApiGet(o.token, "/messages?q=" + encodeURIComponent(q) + "&maxResults=" + maxResults, fetchFn);
    if (!list.ok) {
      if (list.status === 401 || list.status === 403) return list; // auth problem — bubble up for a token refresh; polling can't fix it
      lastErr = list;
    } else {
      const stubs = (list.data && list.data.messages) || [];
      const msgs = [];
      for (const stub of stubs) {
        const full = await gmailApiGet(o.token, "/messages/" + stub.id + "?format=full", fetchFn);
        if (full.ok && full.data) msgs.push(full.data);
        else if (full.status === 401 || full.status === 403) return full;
      }
      // newest first — internalDate is ms-epoch as a string
      msgs.sort((a, b) => Number(b.internalDate || 0) - Number(a.internalDate || 0));
      for (const m of msgs) {
        if (Number(m.internalDate || 0) < cutoffMs) continue; // freshness guard
        const body = gmailExtractBodyText(m.payload || {});
        const url = gmailExtractVerificationUrl(body, urlMustContain);
        if (url) return { ok: true, url, messageId: m.id, internalDate: Number(m.internalDate || 0) };
      }
    }
    if (now() - start + pollMs >= timeoutMs) break; // don't sleep past the deadline
    await sleep(pollMs);
  }
  return {
    ok: false,
    timedOut: true,
    error: lastErr
      ? ("no matching verification email; last API error: " + lastErr.error)
      : ("verification email did not arrive within " + Math.round(timeoutMs / 1000) + "s")
  };
}

// ── chrome.identity glue (SW-only; never throws) ─────────────────────────────
// Not Node-testable (references chrome) — kept thin so the testable core above
// carries the real logic.

// Get a gmail.readonly access token. interactive:true shows Chrome's native
// account-picker/consent (first connect); interactive:false is silent (cached/
// refreshed by Chrome) and fails fast if consent was never granted.
// ── POLL FOR AN EMAILED *CODE* (Oracle Recruiting Cloud, 2026-08-19) ───────────────────────
// A deliberate SIBLING of gmailFindVerificationEmail rather than a new mode inside it. That
// function is live on the Workday path and extracts a URL; threading a second payload type through
// it would put the one auto-verify path that already works at risk for no benefit. This shares the
// pieces that matter (gmailApiGet, gmailExtractBodyText, the freshness cutoff) and nothing else.
//
// ⚠ THE FRESHNESS CUTOFF IS THE LOAD-BEARING PART. A code is one-time and short-lived, and an ORC
// inbox accumulates them — one per apply attempt per tenant. Returning a STALE code fails
// verification and, worse, may consume an attempt, so the internalDate floor is not an
// optimisation: a message older than `sinceMs` is not a candidate at all. Default 300s.
// Returns { ok, code } | { ok:false, error } and NEVER throws. The code is returned to the caller
// (which must not log it) and appears nowhere else.
async function gmailFindVerificationCode(opts) {
  const o = opts || {};
  const fetchFn = o.fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  const sleep = o.sleepImpl || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = o.nowImpl || (() => Date.now());
  if (!fetchFn) return { ok: false, error: "no fetch available in this context" };
  if (!o.token) return { ok: false, error: "no Gmail token" };

  const timeoutMs = o.timeoutMs != null ? o.timeoutMs : 120000;
  const pollMs = o.pollMs != null ? o.pollMs : 5000;
  const sinceMs = o.sinceMs != null ? o.sinceMs : 300000;
  const maxResults = o.maxResults || 10;
  // Oracle's candidate mail comes from the tenant's Fusion pod, so the SENDER is as unreliable as
  // Workday's was. Key on tokens the body/subject carry instead, and let the code extractor's own
  // guards be the decisive filter.
  const q = o.query || ("newer_than:1h (oraclecloud OR oracle OR \"verification code\" OR \"Confirm Your Identity\")");

  const start = now();
  const cutoffMs = start - sinceMs;
  let lastErr = null;

  while (now() - start < timeoutMs) {
    const list = await gmailApiGet(o.token, "/messages?q=" + encodeURIComponent(q) + "&maxResults=" + maxResults, fetchFn);
    if (!list.ok) {
      if (list.status === 401 || list.status === 403) return list; // auth — polling cannot fix it
      lastErr = list;
    } else {
      const stubs = (list.data && list.data.messages) || [];
      const msgs = [];
      for (const stub of stubs) {
        const full = await gmailApiGet(o.token, "/messages/" + stub.id + "?format=full", fetchFn);
        if (full.ok && full.data) msgs.push(full.data);
        else if (full.status === 401 || full.status === 403) return full;
      }
      msgs.sort((a, b) => Number(b.internalDate || 0) - Number(a.internalDate || 0)); // newest first
      for (const m of msgs) {
        if (Number(m.internalDate || 0) < cutoffMs) continue; // stale — see the note above
        const code = gmailExtractVerificationCode(gmailExtractBodyText(m.payload), o);
        if (code) return { ok: true, code, messageId: m.id, internalDate: Number(m.internalDate || 0) };
      }
    }
    if (now() - start + pollMs >= timeoutMs) break;
    await sleep(pollMs);
  }
  return { ok: false, error: lastErr ? ("Gmail lookup failed: " + (lastErr.error || lastErr.status)) : "no verification code found within " + Math.round(timeoutMs / 1000) + "s" };
}

function gmailGetToken(interactive) {
  return new Promise((resolve) => {
    try {
      if (!(typeof chrome !== "undefined" && chrome.identity && chrome.identity.getAuthToken)) {
        resolve({ ok: false, error: "chrome.identity.getAuthToken unavailable (identity permission / oauth2 client_id set in manifest?)" });
        return;
      }
      chrome.identity.getAuthToken({ interactive: !!interactive }, (result) => {
        // Chrome versions differ: the callback yields either a bare token string or
        // a { token, grantedScopes } object — accept both.
        const token = result && typeof result === "object" ? result.token : result;
        if (chrome.runtime.lastError || !token) {
          resolve({ ok: false, error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || "no token returned" });
          return;
        }
        resolve({ ok: true, token });
      });
    } catch (e) { resolve({ ok: false, error: String((e && e.message) || e) }); }
  });
}

// Drop a token from Chrome's cache (call on a 401 before re-requesting, so the
// next getAuthToken mints a fresh one instead of handing back the stale cached one).
function gmailRemoveCachedToken(token) {
  return new Promise((resolve) => {
    try {
      if (!token || !(typeof chrome !== "undefined" && chrome.identity && chrome.identity.removeCachedAuthToken)) { resolve(); return; }
      chrome.identity.removeCachedAuthToken({ token }, () => { void (chrome.runtime && chrome.runtime.lastError); resolve(); });
    } catch (e) { resolve(); }
  });
}

// UMD-lite: export for the Node test runner; in the SW `module` is undefined so
// these stay globals (from importScripts). Mirrors llm.js/db.js.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    gmailB64UrlDecode, gmailExtractBodyText, gmailExtractVerificationUrl,
    gmailExtractVerificationCode, gmailFindVerificationCode,
    gmailBuildQuery, gmailApiGet, gmailFindVerificationEmail,
    gmailGetToken, gmailRemoveCachedToken
  };
}
