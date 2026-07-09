// Unit tests for gmail.js — the Gmail auto-verify adapter. A FAKE fetch + injected
// now/sleep drive the poll loop with NO network, no chrome, no real inbox: assert the
// base64url/MIME/URL parsers are correct, the freshness guard rejects stale mail, the
// newest match wins, a 401 bubbles up for a token refresh, and every failure path is a
// normalized { ok:false, error } (gmail.js must NEVER throw — a thrown adapter would
// crash the onboarding walk mid-verification).
const { test } = require("node:test");
const assert = require("node:assert");
const {
  gmailB64UrlDecode, gmailExtractBodyText, gmailExtractVerificationUrl,
  gmailBuildQuery, gmailApiGet, gmailFindVerificationEmail
} = require("../gmail.js");

// Gmail message parts are base64URL (‑/_ alphabet, no padding).
const b64url = (str) => Buffer.from(str, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ── pure parsers ────────────────────────────────────────────────────────────

test("gmailB64UrlDecode: URL-safe alphabet + missing padding + UTF-8", () => {
  assert.strictEqual(gmailB64UrlDecode(b64url("Café ✓ résumé")), "Café ✓ résumé");
  assert.strictEqual(gmailB64UrlDecode(""), "");
  assert.strictEqual(gmailB64UrlDecode(b64url("a")), "a"); // forces re-padding
});

test("gmailExtractBodyText: recurses multipart, decodes text/plain + text/html", () => {
  const payload = {
    mimeType: "multipart/alternative",
    parts: [
      { mimeType: "text/plain", body: { data: b64url("plain body") } },
      { mimeType: "multipart/related", parts: [
        { mimeType: "text/html", body: { data: b64url("<b>html body</b>") } },
        { mimeType: "image/png", body: { data: b64url("IGNOREME") } }
      ] }
    ]
  };
  const text = gmailExtractBodyText(payload);
  assert.match(text, /plain body/);
  assert.match(text, /<b>html body<\/b>/);
  assert.doesNotMatch(text, /IGNOREME/, "non-text parts are skipped");
});

test("gmailExtractBodyText: single leaf part (no parts[])", () => {
  assert.strictEqual(gmailExtractBodyText({ mimeType: "text/plain", body: { data: b64url("hi") } }), "hi");
  assert.strictEqual(gmailExtractBodyText({}), "");
});

test("gmailExtractVerificationUrl: matches the tenant-host needle, skips others, decodes &amp;", () => {
  const body = "Welcome! Logo: https://cdn.workday.com/logo.png\n" +
    "Verify: https://acme.wd1.myworkdayjobs.com/activate/abc123?tok=1&amp;u=2\n" +
    "Unsub: https://email.workday.com/unsub";
  const url = gmailExtractVerificationUrl(body, "acme.wd1.myworkdayjobs.com");
  assert.strictEqual(url, "https://acme.wd1.myworkdayjobs.com/activate/abc123?tok=1&u=2");
});

test("gmailExtractVerificationUrl: no needle → falls back to an activate/verify token URL", () => {
  const body = "tracking https://t.workday.com/x then https://acme.wd1.myworkdayjobs.com/activate/xyz";
  assert.match(gmailExtractVerificationUrl(body, ""), /\/activate\/xyz$/);
  assert.strictEqual(gmailExtractVerificationUrl("no links here", "acme.com"), null);
});

test("gmailBuildQuery: matches the myworkdayjobs body token OR the sender (+ recency, optional subject)", () => {
  // Sender-agnostic: some tenants send from Workday@<tenant>.com, so key on the body's activate-link
  // token (myworkdayjobs) OR the workday.com sender.
  assert.strictEqual(gmailBuildQuery("workday.com"), "newer_than:1h (myworkdayjobs OR from:workday.com)");
  assert.strictEqual(gmailBuildQuery("workday.com", "Verify"), "newer_than:1h (myworkdayjobs OR from:workday.com) subject:Verify");
  assert.strictEqual(gmailBuildQuery(), "newer_than:1h (myworkdayjobs OR from:workday.com)"); // default sender
});

test("gmailExtractVerificationUrl: prefers the /activate link over a job-listing link on the same host", () => {
  // A Workday email can carry both a "back to your job" link and the activate link on the same host.
  const body = "Back to your job: https://paloaltonetworks.wd5.myworkdayjobs.com/panwexternalcareers/job/JR-1\n" +
    "Confirm: https://paloaltonetworks.wd5.myworkdayjobs.com/panwexternalcareers/activate/tok123/?redirect=%2Fjob";
  assert.match(gmailExtractVerificationUrl(body, "paloaltonetworks.wd5.myworkdayjobs.com"), /\/activate\/tok123/);
});

// ── gmailApiGet ───────────────────────────────────────────────────────────────

test("gmailApiGet: builds the users/me URL + Bearer header; parses JSON", async () => {
  let cap = {};
  const ff = async (url, opts) => { cap = { url, opts }; return { ok: true, status: 200, json: async () => ({ emailAddress: "me@gmail.com" }), text: async () => "" }; };
  const r = await gmailApiGet("tok-123", "/profile", ff);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.emailAddress, "me@gmail.com");
  assert.strictEqual(cap.url, "https://gmail.googleapis.com/gmail/v1/users/me/profile");
  assert.strictEqual(cap.opts.headers.Authorization, "Bearer tok-123");
});

test("gmailApiGet: non-ok surfaces status; network throw + no-token are normalized", async () => {
  const ff401 = async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => "unauthorized" });
  const r = await gmailApiGet("tok", "/profile", ff401);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 401);
  assert.match(r.error, /HTTP 401/);

  const ffThrow = async () => { throw new Error("ECONNREFUSED"); };
  assert.strictEqual((await gmailApiGet("tok", "/profile", ffThrow)).ok, false);
  assert.strictEqual((await gmailApiGet("", "/profile", ff401)).ok, false); // no token
});

// ── gmailFindVerificationEmail (the poll loop) ───────────────────────────────

// Fake Gmail: list returns id stubs for `messages`; get returns the full message.
function inboxFetch(messages, { status } = {}) {
  return async (url) => {
    if (status) return { ok: false, status, json: async () => ({}), text: async () => "err" };
    if (url.indexOf("/messages?q=") !== -1) {
      return { ok: true, status: 200, json: async () => ({ messages: messages.map((m) => ({ id: m.id })) }), text: async () => "" };
    }
    const m = messages.find((mm) => url.indexOf("/messages/" + mm.id + "?") !== -1);
    if (m) return { ok: true, status: 200, json: async () => m, text: async () => "" };
    return { ok: false, status: 404, json: async () => ({}), text: async () => "not found" };
  };
}
const msg = (id, internalDate, url) => ({ id, internalDate: String(internalDate), payload: { mimeType: "text/plain", body: { data: b64url("Please verify: " + url) } } });
const HOST = "acme.wd1.myworkdayjobs.com";
const link = (t) => "https://" + HOST + "/activate/" + t;

test("finds the link on the first poll", async () => {
  const r = await gmailFindVerificationEmail({
    token: "t", urlMustContain: HOST, nowImpl: () => 1000, sleepImpl: async () => {},
    fetchImpl: inboxFetch([msg("m1", 1000, link("abc"))])
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.url, link("abc"));
  assert.strictEqual(r.messageId, "m1");
});

test("freshness guard: a message older than sinceMs is skipped → times out", async () => {
  const START = 1_000_000_000_000; // positive epoch so cutoff = START - sinceMs is positive
  let i = 0; const now = () => [START, START, START, START + 120000, START + 120000][Math.min(i++, 4)];
  const r = await gmailFindVerificationEmail({
    token: "t", urlMustContain: HOST, nowImpl: now, sleepImpl: async () => {},
    fetchImpl: inboxFetch([msg("old", START - 400000, link("stale"))]) // 400s old > sinceMs(300s) → older than cutoff
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.timedOut, true);
});

test("newest matching message wins", async () => {
  const r = await gmailFindVerificationEmail({
    token: "t", urlMustContain: HOST, nowImpl: () => 6000, sleepImpl: async () => {},
    fetchImpl: inboxFetch([msg("older", 2000, link("A")), msg("newer", 5000, link("B"))])
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.messageId, "newer");
  assert.strictEqual(r.url, link("B"));
});

test("a 401 bubbles up immediately (for a token refresh), keeping status", async () => {
  const r = await gmailFindVerificationEmail({
    token: "stale", urlMustContain: HOST, nowImpl: () => 1000, sleepImpl: async () => {},
    fetchImpl: inboxFetch([], { status: 401 })
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 401);
});

test("no token / no fetch → normalized error, never throws", async () => {
  assert.strictEqual((await gmailFindVerificationEmail({ urlMustContain: HOST, fetchImpl: inboxFetch([]) })).ok, false);
  assert.strictEqual((await gmailFindVerificationEmail({ token: "t", fetchImpl: null, nowImpl: () => 0 })).ok, false);
});
