// SECRET REDACTION — nothing we persist or send may carry a session token.
//
// The case that produced this: an iCIMS candidate page's bootstrap script was scraped as the job
// DESCRIPTION (live 2026-08-16), and it embedded the one-time magic-link session URL
// `?from=login&eem=…&code=…`. That one string then travelled to three places, each a real exposure —
// the tracker row in Supabase, every AI prompt the JD grounds, and the run's log lines.
//
// The tests are written in the two directions that matter: a REAL token must never survive, and
// ordinary prose must never be mangled (a JD is prose, and over-redacting it would quietly corrupt
// the text the operator reads and the model is grounded on).
const { test } = require("node:test");
const assert = require("node:assert");
const lib = require("../lib.js");

const r = lib.redactSecrets;

// The exact shape observed live, truncated only in length.
const LEAKED =
  'icimsFrame.src = "https://astrioncareers-astrion.icims.com/jobs/24615/engineering-directorate-' +
  'support-intern/candidate?from=login&eem=ZYgN3oNSr2Z3aDf65HL7xc_j6REChSggs7dJo5oqeA2kscGSNDUE' +
  '&code=2e0ad61b0baacde2b2db338b2b0f6097cfdc41edc90bb9e5431f6dc9763ba23d";';

test("⚠ the live iCIMS magic-link tokens are gone, and the KEYS remain", () => {
  const out = r(LEAKED);
  assert.ok(!/ZYgN3oNSr2Z3/.test(out), "the eem token survived");
  assert.ok(!/2e0ad61b0baacde2/.test(out), "the code token survived");
  // Keeping the key is deliberate: a reader diagnosing a leak needs to see that a magic link WAS
  // there, and "<redacted>" carries nothing usable.
  assert.match(out, /eem=<redacted>/);
  assert.match(out, /code=<redacted>/);
  // Everything that is not a secret is untouched — including the surrounding URL, which is what
  // makes the redacted text still diagnosable.
  assert.match(out, /astrioncareers-astrion\.icims\.com\/jobs\/24615/);
  assert.match(out, /from=login/); // not a credential; informative
});

test("the usual credential-ish query keys are covered", () => {
  for (const key of ["token", "access_token", "id_token", "refresh_token", "apikey", "api_key",
    "sig", "signature", "password", "secret", "session", "jsessionid", "validitytoken", "auth", "key"]) {
    const out = r(`https://x.example/p?${key}=abcdef123456`);
    assert.strictEqual(out, `https://x.example/p?${key}=<redacted>`, `${key} not redacted`);
  }
});

test("case and separators: iCIMS also uses ';', and keys arrive in any case", () => {
  assert.strictEqual(r("https://x/p?a=1;code=abcdef123456"), "https://x/p?a=1;code=<redacted>");
  assert.strictEqual(r("https://x/p?EEM=ABCDEF123456"), "https://x/p?EEM=<redacted>");
  assert.match(r("https://x/p#access_token=abcdef123456"), /access_token=<redacted>/);
});

test("⚠ ORDINARY PROSE IS NOT TOUCHED — a JD is prose, and mangling it corrupts what is read", () => {
  // No query separator in front ⇒ not a URL parameter, so a posting that happens to discuss a
  // "code" or a "key" reads exactly as written.
  assert.strictEqual(r("Use code=ALPHA in your build script."), "Use code=ALPHA in your build script.");
  assert.strictEqual(r("Experience with key=value configuration formats."),
    "Experience with key=value configuration formats.");
  assert.strictEqual(r("Astrion seeks undergraduate, graduate and PhD students."),
    "Astrion seeks undergraduate, graduate and PhD students.");
  // A non-secret query parameter survives, so a tracking link in a JD still reads normally.
  assert.strictEqual(r("Apply at https://x.example/jobs?utm_source=linkedin&iis=LinkedIn"),
    "Apply at https://x.example/jobs?utm_source=linkedin&iis=LinkedIn");
});

test("a SHORT value is left alone — it cannot be a session token, and might be meaningful", () => {
  // `?code=US` is a country code, not a credential. The 6-char floor is what keeps such a value
  // readable while every real token (always far longer) is caught.
  assert.strictEqual(r("https://x/p?code=US"), "https://x/p?code=US");
  assert.strictEqual(r("https://x/p?key=id"), "https://x/p?key=id");
});

test("idempotent, and safe on every empty/absent input", () => {
  assert.strictEqual(r(r(LEAKED)), r(LEAKED));
  assert.strictEqual(r(""), "");
  assert.strictEqual(r(null), "");
  assert.strictEqual(r(undefined), "");
});

test("multiple tokens in one blob all go, and the text around them survives", () => {
  const blob = "a?eem=aaaaaaaaaaaa b https://y/z?token=bbbbbbbbbbbb&page=2 trailing words";
  const out = r(blob);
  assert.ok(!/aaaaaaaaaaaa/.test(out) && !/bbbbbbbbbbbb/.test(out));
  assert.match(out, /page=2/);
  assert.match(out, /trailing words$/);
});

test("redactSecrets is exported from lib.js — background.js calls it as a BARE global", () => {
  // It is deliberately NOT reached through the `apMatch` literal: that literal is hand-written in the
  // service worker, and adding a name to lib.js without it is the lockstep trap CLAUDE.md documents
  // (every Node test passes, the browser throws "is not a function").
  assert.strictEqual(typeof lib.redactSecrets, "function");
  assert.ok(lib.SECRET_QUERY_KEYS instanceof RegExp);
});
