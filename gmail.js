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

// ── TWO EMAILED-CODE READERS, AND WHICH ONE TO USE ─────────────────────────────────────────
// Both landed independently in 2026-08 for different ATSs, and they are kept SEPARATE on the same
// reasoning the ORC note below gives for not folding itself into the URL reader: threading a second
// payload shape through a live path risks the one that already works, for no benefit.
//
//   gmailExtractVerificationCode / gmailFindVerificationCode  — ORACLE RECRUITING CLOUD.
//     A fixed-length run of DIGITS (six). Its adversarial case is an ORC requisition id, which is
//     also six digits, so it strips URLs and requires a code-ish word nearby.
//
//   gmailExtractAlnumCode / gmailFindAlnumCode                — GREENHOUSE (and any alphanumeric).
//     An ALPHANUMERIC code whose length the FORM declares (Greenhouse: 8, read off its own box
//     count). ⚠ The numeric reader physically cannot read one — `\d{6}` never matches "TQ7F2M9B" —
//     so this is not a duplicate. Its adversarial case is different too: an HTML mail is full of
//     8-character class hashes and tracking tokens, so it strips to PROSE first and REFUSES on two
//     candidates rather than taking the nearest.
//
// Shared by both: the freshness floor is what stops a STALE code being typed, and neither may have
// its result logged.
// ── A CODE, NOT A LINK ──────────────────────────────────────────────────────
// Workday mails an activation URL; Greenhouse mails an 8-character code and asks for it in the
// form itself (traced live 2026-08-24 on a Zipline posting — `div.email-verification__wrapper`
// holding eight `#security-input-N` boxes). Same inbox, same readonly scope, same poll shape,
// but a different needle — so this is a SIBLING of gmailExtractVerificationUrl rather than a
// widening of it. Nothing here knows about a form; the caller owns every actuation.

// Strip everything from a body that can hold an N-character run but is not prose the sender
// wrote for the reader: <style>/<script> blocks, tags AND their attributes, URLs, entities.
// ⚠ Without this the scan is hopeless on an HTML mail. A class hash, a hex colour, a
// message-id and an unsubscribe token all match [A-Za-z0-9]{8} exactly as well as the code
// does — and one tracking URL can carry a dozen of them. Tags go first so an href's contents
// leave with the tag that held them.
function gmailStripNonProse(body) {
  let s = String(body == null ? "" : body);
  s = s.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<[^>]*>/g, " ");
  s = s.replace(/https?:\/\/[^\s"'<>]+/g, " ");
  s = s.replace(/&[a-z]+;|&#\d+;/gi, " ");
  return s.replace(/\s+/g, " ").trim();
}

// A code is recognised by the WORDS AROUND IT, never by its shape alone. A bare
// /[A-Za-z0-9]{8}/ scan over a real email is a coin flip, and the cost of guessing wrong is not
// a retry: the code is SINGLE-USE, so a wrong pick burns the operator's real one and the form
// counts the failed attempt against them.
const GMAIL_CODE_CUE_RE = /(verification|security|confirmation|one[-\s]?time|access|login|sign[-\s]?in)\s+code|\bcode\s*(is|:)|\byour\s+code\b|\bpasscode\b/i;

// Radii tried in order around a cue. The FIRST radius that yields any candidate decides the
// answer — and if that radius yields more than one DISTINCT candidate the extractor REFUSES.
// Progressive-then-refuse is deterministic and explainable; "prefer the nearest one" would be a
// guess, and the whole matching discipline in this repo is that a guess never beats an honest
// escalation.
const GMAIL_CODE_RADII = [48, 130, 280];

// A date stamp is the one 8-digit run that turns up near verification prose ("sent 20260824"),
// and it is never a code. Rejected by SHAPE, so an all-digit code of any other shape still works.
function gmailCodeIsJunk(tok) {
  const t = String(tok || "");
  if (/^(19|20)\d{6}$/.test(t)) return true;            // a YYYYMMDD date stamp
  if (/^(.)\1+$/.test(t)) return true;                  // AAAAAAAA — styling filler, not a code
  return false;
}

// Pull the verification code out of a decoded body (the caller prepends the SUBJECT — senders
// often put the code there, and the cue usually rides along with it).
//   length  — the EXACT character count, read off the FORM's own box count. The form is the
//             authority on this, so it is a fact rather than a tuned constant. Absent ⇒ accept
//             4–10, which is the probe path, where we are still learning a sender's shape.
//   cueRe   — override the cue set.
// Returns { ok:true, code, radius } | { ok:false, reason, candidates? }. NEVER throws, and never
// picks between candidates.
function gmailExtractAlnumCode(body, opts) {
  const o = opts || {};
  const text = gmailStripNonProse(body);
  if (!text) return { ok: false, reason: "empty-body" };
  const len = Number(o.length || 0);
  const cueRe = o.cueRe || GMAIL_CODE_CUE_RE;
  // A fresh, global copy — the cue set is a module constant, and a lastIndex left on it would
  // make the SECOND call in a poll loop start scanning from the middle of the string.
  const cues = new RegExp(cueRe.source, cueRe.flags.replace(/[gy]/g, "") + "g");
  const spans = [];
  let m;
  while ((m = cues.exec(text)) !== null) {
    spans.push([m.index, m.index + m[0].length]);
    if (cues.lastIndex === m.index) cues.lastIndex++; // zero-width safety
    if (spans.length >= 8) break;
  }
  if (!spans.length) return { ok: false, reason: "no-cue" };

  const quant = len ? "{" + len + "}" : "{4,10}";
  const tokRe = new RegExp("(?<![A-Za-z0-9])[A-Za-z0-9]" + quant + "(?![A-Za-z0-9])", "g");
  const scan = (radius) => {
    const found = [];
    for (const [s, e] of spans) {
      const from = Math.max(0, s - radius);
      const win = text.slice(from, Math.min(text.length, e + radius));
      let t;
      tokRe.lastIndex = 0;
      while ((t = tokRe.exec(win)) !== null) {
        const tok = t[0];
        if (gmailCodeIsJunk(tok)) continue;
        // ⚠ NEVER OFFER A WORD OUT OF THE CUE PHRASE ITSELF. At length 8 "security" is a
        // perfectly-shaped token sitting immediately beside every cue. Excluded POSITIONALLY —
        // by overlap with a cue's own span — because testing the cue regex against a lone token
        // does not work: the pattern needs the whole phrase ("security code"), so "security" on
        // its own does not match it and sailed straight through as a candidate.
        const at = from + t.index;
        if (spans.some(([cs, ce]) => at < ce && at + tok.length > cs)) continue;
        found.push(tok);
      }
    }
    return [...new Set(found)];
  };

  // A code CONTAINS A DIGIT, or is written in caps. An ordinary lower-case English word of
  // exactly the code's length is not a code — and near verification prose there is always one
  // ("continue" is 8 characters, so is "everyone"). Without this split the extractor refuses
  // perfectly clear emails as `ambiguous`, which is safe but useless. Shape is a WEAK signal, so
  // it is used only to CHOOSE BETWEEN candidates already next to a cue — never to find one.
  const codeShaped = (t) => /\d/.test(t) || (/^[A-Z0-9]+$/.test(t) && /[A-Z]/.test(t));
  for (const radius of GMAIL_CODE_RADII) {
    const hits = scan(radius);
    if (!hits.length) continue;
    const shaped = hits.filter(codeShaped);
    const pool = shaped.length ? shaped : hits;
    if (pool.length > 1) return { ok: false, reason: "ambiguous", candidates: pool.slice(0, 6), radius };
    return { ok: true, code: pool[0], radius, shaped: shaped.length > 0 };
  }
  return { ok: false, reason: "no-code-near-cue" };
}

// The search `q` for a CODE mail. Kept SEPARATE from gmailBuildQuery below, which hardcodes
// Workday's own needles ("myworkdayjobs OR from:workday.com") — widening that one would put
// Workday's live auto-verify behind a change made for Greenhouse.
function gmailBuildCodeQuery(senderContains, subjectContains, newerThan) {
  let q = "newer_than:" + (newerThan || "1h");
  if (senderContains) q += " from:" + senderContains;
  if (subjectContains) q += " subject:" + subjectContains;
  return q;
}

// Poll the inbox for a verification CODE. Mirrors gmailFindVerificationEmail (injected
// fetch/sleep/now, never throws, a 401/403 bubbles up for a token refresh) with three
// differences that matter:
//
//  • `notBeforeMs` is an ABSOLUTE epoch, not a relative window, and the caller passes the moment
//    it clicked Submit. ⚠ This is the load-bearing guard: a code from an EARLIER attempt (another
//    job, a rehearsal, yesterday) is still sitting in the inbox and is still 8 characters next to
//    the same cue. Typing it would burn a real attempt on the form and report a rejection that
//    looks exactly like a bug in the extractor. `skewMs` allows for the SW clock and Gmail's
//    server clock disagreeing — one minute, generous in the SAFE direction, since a code
//    marginally "older" than our own click is at worst the one we just asked for.
//  • the SENDER is the WEAK half of the identification and the cue+length+freshness are the
//    strong half, so a sender miss WIDENS (once, loudly) rather than failing. Which address
//    Greenhouse mails from has not been observed yet, and an operator must not be stranded by a
//    guess frozen into a constant.
//  • it RETURNS THE CODE, so no caller on this path may log its result object wholesale.
async function gmailFindAlnumCode(opts) {
  const o = opts || {};
  const fetchFn = o.fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  const sleep = o.sleepImpl || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = o.nowImpl || (() => Date.now());
  if (!fetchFn) return { ok: false, error: "no fetch available in this context" };
  if (!o.token) return { ok: false, error: "no Gmail token" };

  const timeoutMs = o.timeoutMs != null ? o.timeoutMs : 120000;
  const pollMs = o.pollMs != null ? o.pollMs : 5000;
  const skewMs = o.skewMs != null ? o.skewMs : 60000;
  const maxResults = o.maxResults || 10;
  const log = typeof o.log === "function" ? o.log : () => {};
  const start = now();
  const floor = (o.notBeforeMs != null ? Number(o.notBeforeMs) : start) - skewMs;
  let widened = !o.senderContains;
  let lastErr = null, sawFresh = 0, sawStale = 0, lastReason = null;

  while (now() - start < timeoutMs) {
    const q = gmailBuildCodeQuery(widened ? null : o.senderContains, o.subjectContains, o.newerThan);
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
      for (const msg of msgs) {
        if (Number(msg.internalDate || 0) < floor) { sawStale++; continue; } // predates our own click
        sawFresh++;
        const hdrs = ((msg.payload || {}).headers || []);
        const hdr = (n) => (hdrs.find((h) => String(h.name || "").toLowerCase() === n) || {}).value || "";
        const subject = hdr("subject");
        const got = gmailExtractAlnumCode(subject + "\n" + gmailExtractBodyText(msg.payload || {}), { length: o.length });
        if (got.ok) return { ok: true, code: got.code, messageId: msg.id, internalDate: Number(msg.internalDate || 0), from: hdr("from"), subject, widened };
        lastReason = got.reason + (got.candidates ? " (" + got.candidates.length + " candidates)" : "");
      }
    }
    // Half the budget spent with a sender filter and nothing fresh read ⇒ the filter is the suspect.
    if (!widened && now() - start > timeoutMs / 2 && !sawFresh) {
      widened = true;
      log("no fresh mail matched from:" + o.senderContains + " — widening to ANY sender (the code's own cue + length + freshness stay the gate)");
    }
    if (now() - start + pollMs >= timeoutMs) break;
    await sleep(pollMs);
  }
  return {
    ok: false, timedOut: true, sawFresh, sawStale, widened,
    error: lastErr ? ("no verification code found; last API error: " + lastErr.error)
      : sawFresh ? ("read " + sawFresh + " fresh message(s) but could not identify a " + (o.length || "4-10") + "-character code in any of them" + (lastReason ? " (" + lastReason + ")" : ""))
        : ("no verification email arrived within " + Math.round(timeoutMs / 1000) + "s" + (sawStale ? " (" + sawStale + " older message(s) skipped as predating the submit click)" : ""))
  };
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
    // ORC: a fixed-length run of DIGITS (see the two-readers note at the top of this file).
    gmailExtractVerificationCode, gmailFindVerificationCode, GMAIL_CODE_KEYWORD_RE,
    gmailBuildQuery, gmailApiGet, gmailFindVerificationEmail,
    // Greenhouse: an ALPHANUMERIC code of the length the form declares.
    gmailStripNonProse, gmailExtractAlnumCode, gmailBuildCodeQuery, gmailFindAlnumCode,
    gmailCodeIsJunk, GMAIL_CODE_CUE_RE, GMAIL_CODE_RADII,
    gmailGetToken, gmailRemoveCachedToken
  };
}
