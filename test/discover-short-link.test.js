// test/discover-short-link.test.js — an ATS short link must be FOLLOWED before it is keyed.
//
// Live 2026-09-08: a K2 Space Avionics role was SUBMITTED in the morning and came back as a "new
// job" the same afternoon. Nothing was wrong with the dedup logic — the re-key + knownSet re-check in
// readBoardDetails was already there and correct. It was handed a key that could never match, because
// LinkedIn stored the apply link as Greenhouse's own shortener and a short link keys on ITSELF:
//
//   discoveryJobKey("https://grnh.se/uuce4zv48us")  →  "https://grnh.se/uuce4zv48us"
//   discoveryJobKey(<what it resolves to>)          →  "greenhouse:k2spacecorporation:5411921008"
//
// The second is byte-identical to the key already stored for the submitted application, so following
// the redirect is the whole fix. The operator's standing instruction is that a job already applied to
// must never be reported back.
//
// Run: node --test test/discover-short-link.test.js

const test = require("node:test");
const assert = require("node:assert");
const { isAtsShortLink, resolveAtsShortLink, discoveryJobKey } = require("../discover.js");

const SHORT = "https://grnh.se/uuce4zv48us?gh_src=097d7e1b4us";
const LANDED = "https://job-boards.greenhouse.io/k2spacecorporation/jobs/5411921008?gh_src=uuce4zv48us";
const STORED = "https://job-boards.greenhouse.io/k2spacecorporation/jobs/5411921008";

test("⚠⚠ the regression itself: a short link and its destination key DIFFERENTLY", () => {
  // This is why the knownSet check could not fire. If this ever stops being true, the fix is moot.
  assert.notStrictEqual(discoveryJobKey(SHORT), discoveryJobKey(LANDED));
  // …and the destination keys the SAME as the application already in the tracker
  assert.strictEqual(discoveryJobKey(LANDED), discoveryJobKey(STORED));
  assert.strictEqual(discoveryJobKey(LANDED), "greenhouse:k2spacecorporation:5411921008");
});

test("isAtsShortLink recognises Greenhouse's own shortener, and nothing else", () => {
  assert.strictEqual(isAtsShortLink(SHORT), true);
  assert.strictEqual(isAtsShortLink("https://grnh.se/abc"), true);
  // ⚠ A TIGHT ALLOWLIST is the point: following arbitrary redirectors found on scraped pages turns a
  // dedup fix into a request-forgery surface, and a generic shortener can point anywhere.
  for (const u of [
    "https://bit.ly/abc", "https://tinyurl.com/abc", "https://lnkd.in/abc", "https://t.co/abc",
    LANDED, "https://jobs.lever.co/acme/abc", "https://grnh.se.evil.com/abc", "https://notgrnh.se/abc",
    "ftp://grnh.se/abc", "", null, undefined, "not a url",
  ]) assert.strictEqual(isAtsShortLink(u), false, String(u));
});

test("resolveAtsShortLink returns where the redirect landed", async () => {
  const calls = [];
  const fakeFetch = async (u, opts) => { calls.push([u, opts && opts.redirect]); return { url: LANDED }; };
  assert.strictEqual(await resolveAtsShortLink(SHORT, fakeFetch), LANDED);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][0], SHORT);
  assert.strictEqual(calls[0][1], "follow", "the redirect must actually be followed");
});

test("⚠ resolving is what makes the key match — the end-to-end point of the fix", async () => {
  const landed = await resolveAtsShortLink(SHORT, async () => ({ url: LANDED }));
  assert.strictEqual(discoveryJobKey(landed), discoveryJobKey(STORED),
    "after resolving, the discovered job keys identically to the submitted application");
});

test("⚠ it NEVER throws, and an unresolvable link reports failure rather than itself", async () => {
  // The caller falls back to the original url on "", so the job is still queued — keyed as before.
  // Degrading to a possible duplicate is recoverable; dropping the job is not.
  assert.strictEqual(await resolveAtsShortLink(SHORT, async () => { throw new Error("network down"); }), "");
  assert.strictEqual(await resolveAtsShortLink(SHORT, async () => ({ url: "" })), "");
  assert.strictEqual(await resolveAtsShortLink(SHORT, async () => ({})), "");
  assert.strictEqual(await resolveAtsShortLink(SHORT, async () => ({ url: "javascript:alert(1)" })), "");
  // landing back on the shortener means nothing was followed — not a successful "resolved to itself"
  assert.strictEqual(await resolveAtsShortLink(SHORT, async () => ({ url: "https://grnh.se/uuce4zv48us" })), "");
  // a non-short link is not fetched at all
  let touched = false;
  assert.strictEqual(await resolveAtsShortLink(LANDED, async () => { touched = true; return { url: "x" }; }), "");
  assert.strictEqual(touched, false, "a url that needs no resolving must cost no request");
});
