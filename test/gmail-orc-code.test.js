// test/gmail-orc-code.test.js — Oracle's one-time pass code, against the REAL email.
//
// The operator pasted three genuine Emerson/ORC verification emails on 2026-09-17, which is what
// this file is built from. Their shape matters, because two plausible theories about why auto-verify
// kept failing were both WRONG and the email is what refuted them:
//
//   From: Emerson Human Resources <hdjq.fa.sender@workflow.mail.us2.cloud.oracle.com>
//
//     Hello Kevin,
//     Just one more step before you get started.
//     You must confirm your identity using the one-time pass code : 953757
//     Note : This code will expire in 10 minutes.
//
// REFUTED (1): "the extractor wants digits and Oracle sends alphanumeric." It is six plain digits.
// REFUTED (2): "the cue wording is wrong" — the body says "one-time pass code", not "verification
//   code". It does not matter: the body contains exactly ONE six-digit run ("10 minutes" is two
//   digits), and the extractor returns a LONE unambiguous candidate even with no cue nearby.
//
// THE ACTUAL CAUSE was timing. Each "Send New Code" press produced mail about a MINUTE later
// (presses at ~30s and ~60s; mail at 3:06pm and 3:07pm), while the wait was 30s — so the run gave up
// and pressed resend just before each code landed, and halted at 91s with three valid codes sitting
// in the inbox. The mail itself says the code lasts 10 MINUTES, so the hurry was self-imposed.
//
// A second, quieter bug rode along: the freshness floor was passed as `Date.now() - resendAt`
// immediately after `resendAt = Date.now()` — a ~0ms LOOKBACK that marched forward on every press,
// so a code delivered moments after a press could be excluded by that very press. It is now an
// absolute instant fixed once per code stage.
//
// Run: node --test test/gmail-orc-code.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { gmailExtractVerificationCode, gmailFindVerificationCode } = require("../gmail.js");

const ORC_BODY = [
  "Hello Kevin,",
  "Just one more step before you get started.",
  "You must confirm your identity using the one-time pass code : 953757",
  "Note : This code will expire in 10 minutes.",
  "Thank you,",
  "Emerson Career Site Talent Acquisition Team",
].join("\n");

test("⚠⚠ the real ORC email yields its code (six digits, no 'verification code' cue)", () => {
  assert.strictEqual(gmailExtractVerificationCode(ORC_BODY, { length: 6 }), "953757");
});

test("⚠ 'This code will expire in 10 minutes' is not mistaken for the code", () => {
  // The only other number in the body is two digits, so it can never satisfy \d{6}. Pinned because
  // a future 'relax the length' change would make "10" a candidate.
  assert.strictEqual(gmailExtractVerificationCode("expires in 10 minutes", { length: 6 }), null);
});

test("⚠ two codes in one body REFUSE rather than guess", () => {
  const two = "one-time pass code : 953757 ... and another 985305";
  // Both sit near the cue, so the nearest wins; with no cue at all it must refuse.
  assert.strictEqual(gmailExtractVerificationCode("953757 and 985305", { length: 6 }), null);
  assert.ok(["953757", "985305"].includes(gmailExtractVerificationCode(two, { length: 6 })));
});

// ── the freshness floor ─────────────────────────────────────────────────────────────────────────

function fakeGmail(messages) {
  // Minimal Gmail API double: list then per-message fetch, matching gmailApiGet's URL shapes.
  return async (url) => {
    const u = String(url);
    if (u.includes("/messages?q=")) {
      return { ok: true, status: 200, json: async () => ({ messages: messages.map((m) => ({ id: m.id })) }) };
    }
    const id = (u.match(/\/messages\/([^?]+)/) || [])[1];
    const m = messages.find((x) => x.id === id);
    return { ok: true, status: 200, json: async () => ({
      id: m.id, internalDate: String(m.at),
      payload: { headers: [{ name: "Subject", value: m.subject || "Your code" }],
                 mimeType: "text/plain", body: { data: Buffer.from(m.body, "utf8").toString("base64") } },
    }) };
  };
}

test("⚠⚠ an ABSOLUTE floor accepts a code that arrives after the stage began", async () => {
  const t0 = 1_000_000_000_000;
  const r = await gmailFindVerificationCode({
    token: "t", length: 6, notBeforeMs: t0, timeoutMs: 50, pollMs: 10,
    fetchImpl: fakeGmail([{ id: "a", at: t0 + 60_000, body: ORC_BODY }]),
    nowImpl: () => t0 + 1,
    sleepImpl: async () => {},
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.code, "953757");
});

test("⚠⚠ …and still refuses a code that predates the run (the operator's 54-minute-old one)", async () => {
  const t0 = 1_000_000_000_000;
  const r = await gmailFindVerificationCode({
    token: "t", length: 6, notBeforeMs: t0, timeoutMs: 30, pollMs: 10,
    fetchImpl: fakeGmail([{ id: "old", at: t0 - 54 * 60_000, body: ORC_BODY }]),
    nowImpl: (() => { let n = t0; return () => (n += 10); })(),
    sleepImpl: async () => {},
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /predate this run/, "and it must SAY that, not just fail");
  assert.strictEqual(r.stale, 1);
});

test("⚠⚠ 'mail arrived but unreadable' is distinguishable from 'no mail at all'", () => {
  // The whole reason this cost a debugging round: both used to read
  // "no verification code found within Ns", so the operator could see the emails while the log
  // insisted nothing was found. The two messages must differ.
  const src = fs.readFileSync(path.join(__dirname, "..", "gmail.js"), "utf8");
  assert.match(src, /no matching message arrived at all/);
  assert.match(src, /matching message\(s\) arrived but no \$\{len\}-digit code could be read/);
  assert.match(src, /predate this run/);
});

test("⚠ the ORC caller waits minutes, not 30s, and fixes ONE absolute floor", () => {
  const strip = (t) => String(t)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/\/\/[^\r\n]*/, "")).join("\n");
  const bg = strip(fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8"));
  assert.match(bg, /const CODE_WAIT_MS = 150000;/, "the code is valid 10 minutes — 30s was self-imposed");
  assert.match(bg, /const codeStageT0 = Date\.now\(\);/, "one floor per code stage");
  assert.match(bg, /notBeforeMs: codeStageT0/, "and it is passed as an ABSOLUTE instant");
  assert.ok(!/sinceMs: Date\.now\(\) - resendAt/.test(bg),
    "the ~0ms per-press lookback must not come back");
});
