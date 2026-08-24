// ============================================================================
// The email-verification gate: reading an emailed code and typing it into the form.
//
// Live 2026-08-24 (Zipline, Greenhouse): "Submit application" does not submit — it mails an
// 8-character code and re-renders the footer as eight single-character boxes with the submit
// button disabled. These tests pin the two halves:
//
//   gmail.js  — finding the code in an email, and REFUSING rather than guessing.
//   ats.js    — reading the widget's state and typing the code into it.
//
// The extractor tests are written from the direction that actually bites: a real HTML email is
// full of 8-character runs that are not the code (class hashes, hex colours, tracking tokens),
// and a wrong pick is not a retry — the code is single-use, so guessing BURNS the operator's
// real one and the form counts the failed attempt.
// ============================================================================
const test = require("node:test");
const assert = require("node:assert");
const gmail = require("../gmail.js");
const ats = require("../ats.js");

// ── gmailStripNonProse ──────────────────────────────────────────────────────────────────
test("strip: script/style bodies, tags, attributes, urls and entities all leave", () => {
  const html = '<style>.a1b2c3d4{color:#aabbcc}</style><script>var t="ZZZZZZZZ";</script>' +
    '<div class="hdr_9f8e7d6c" data-x="QQQQQQQQ">Your code is <b>ABCD2345</b></div>' +
    '<a href="https://track.example.com/u/KKKKKKKK?s=MMMMMMMM">unsubscribe</a>&nbsp;&#160;';
  const out = gmail.gmailStripNonProse(html);
  assert.ok(out.includes("Your code is ABCD2345"), "the prose survives: " + out);
  for (const junk of ["a1b2c3d4", "aabbcc", "ZZZZZZZZ", "9f8e7d6c", "QQQQQQQQ", "KKKKKKKK", "MMMMMMMM"]) {
    assert.ok(!out.includes(junk), junk + " should have been stripped: " + out);
  }
});

test("strip: null/empty are '' and never throw", () => {
  assert.strictEqual(gmail.gmailStripNonProse(null), "");
  assert.strictEqual(gmail.gmailStripNonProse(undefined), "");
  assert.strictEqual(gmail.gmailStripNonProse(""), "");
});

// ── gmailExtractVerificationCode ────────────────────────────────────────────────────────
test("extract: the 8-char code next to the cue, at the exact length the form asked for", () => {
  const body = "Hi Kevin, your verification code is TQ7F2M9B. Enter it to submit your application.";
  const r = gmail.gmailExtractVerificationCode(body, { length: 8 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.code, "TQ7F2M9B");
});

test("extract: a code in the SUBJECT is found (the caller prepends it)", () => {
  const r = gmail.gmailExtractVerificationCode("Your security code: 4KD9WQ2X\nOpen the application to continue.", { length: 8 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.code, "4KD9WQ2X");
});

test("extract: an HTML mail full of 8-char junk still yields exactly the code", () => {
  const body = '<html><head><style>.wrap_7ab3c9de{padding:8px}</style></head><body>' +
    '<table class="m_-812739 shell_44ff9911"><tr><td>' +
    '<p>To finish your application, enter this verification code:</p>' +
    "<h2>WQ4T7YB2</h2>" +
    '<p><a href="https://click.greenhouse.io/f/a/PXQ99KLM/x/BB771A2C">View your application</a></p>' +
    "</td></tr></table></body></html>";
  const r = gmail.gmailExtractVerificationCode(body, { length: 8 });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.code, "WQ4T7YB2");
});

test("extract: REFUSES when two candidates sit at the same radius (never picks one)", () => {
  const body = "Your verification code is AAAA1111 or maybe BBBB2222, we are not sure.";
  const r = gmail.gmailExtractVerificationCode(body, { length: 8 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "ambiguous");
  assert.ok(r.candidates.length >= 2, JSON.stringify(r));
});

test("extract: no cue at all ⇒ no-cue, even when a perfectly-shaped token is present", () => {
  const r = gmail.gmailExtractVerificationCode("Thanks for applying! Reference ABCD1234 for your records.", { length: 8 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "no-cue");
});

test("extract: a YYYYMMDD date stamp beside the cue is rejected by shape", () => {
  const body = "Your verification code was sent 20260824 and expires soon.";
  const r = gmail.gmailExtractVerificationCode(body, { length: 8 });
  assert.strictEqual(r.ok, false, "a date stamp must never be returned as a code: " + JSON.stringify(r));
});

test("extract: an all-digit code IS accepted (only date-SHAPED runs are junk)", () => {
  const r = gmail.gmailExtractVerificationCode("Your verification code is 90210417.", { length: 8 });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.code, "90210417");
});

test("extract: a repeated-character run is styling filler, not a code", () => {
  const r = gmail.gmailExtractVerificationCode("Your verification code is XXXXXXXX below.", { length: 8 });
  assert.strictEqual(r.ok, false, JSON.stringify(r));
});

test("extract: the cue's OWN words are never offered as the code", () => {
  // "security" is exactly 8 characters and sits immediately beside every cue.
  const r = gmail.gmailExtractVerificationCode("Enter your security code: 7HJ4KP2Q", { length: 8 });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.code, "7HJ4KP2Q");
});

test("extract: shape is a TIE-BREAK, not a matcher — two code-shaped candidates still refuse", () => {
  const r = gmail.gmailExtractVerificationCode("Your verification code is AAAA1111, previously BBBB2222.", { length: 8 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "ambiguous");
});

test("extract: two WORD-shaped candidates and nothing code-shaped also refuse", () => {
  // Two 8-character lower-case words, no digits and no caps anywhere ⇒ nothing to prefer, so it
  // escalates instead of guessing.
  const r = gmail.gmailExtractVerificationCode("your verification code is elephant, continue reading", { length: 8 });
  assert.strictEqual(r.ok, false, JSON.stringify(r));
  assert.strictEqual(r.reason, "ambiguous");
});

test("extract: an English word of the code's length loses to the code beside it", () => {
  // "continue" is exactly 8 characters and sits right next to the cue. Before the shape tie-break
  // this refused a perfectly clear email as ambiguous.
  const r = gmail.gmailExtractVerificationCode("Your verification code is 4KD9WQ2X, continue to submit.", { length: 8 });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.code, "4KD9WQ2X");
  assert.strictEqual(r.shaped, true);
});

test("extract: LENGTH IS EXACT — an 8-box form does not accept a 6-char code", () => {
  const body = "Your verification code is AB12CD.";
  assert.strictEqual(gmail.gmailExtractVerificationCode(body, { length: 8 }).ok, false);
  const six = gmail.gmailExtractVerificationCode(body, { length: 6 });
  assert.strictEqual(six.ok, true);
  assert.strictEqual(six.code, "AB12CD");
});

test("extract: with no length given, 4-10 chars are accepted (the probe path)", () => {
  const r = gmail.gmailExtractVerificationCode("Your verification code is AB12CD.");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.code, "AB12CD");
});

test("extract: the module-level cue regex keeps no lastIndex between calls", () => {
  // A `g`-flagged module constant would make the SECOND call in a poll loop start mid-string.
  const body = "Your verification code is TQ7F2M9B. Enter it to submit.";
  const a = gmail.gmailExtractVerificationCode(body, { length: 8 });
  const b = gmail.gmailExtractVerificationCode(body, { length: 8 });
  const c = gmail.gmailExtractVerificationCode(body, { length: 8 });
  assert.deepStrictEqual([a.code, b.code, c.code], ["TQ7F2M9B", "TQ7F2M9B", "TQ7F2M9B"]);
});

test("extract: empty body ⇒ a reason, never a throw", () => {
  assert.strictEqual(gmail.gmailExtractVerificationCode("", { length: 8 }).reason, "empty-body");
  assert.strictEqual(gmail.gmailExtractVerificationCode(null, { length: 8 }).reason, "empty-body");
});

// ── gmailBuildCodeQuery ─────────────────────────────────────────────────────────────────
test("code query: recency floor always; sender/subject only when given", () => {
  assert.strictEqual(gmail.gmailBuildCodeQuery(null, null, null), "newer_than:1h");
  assert.strictEqual(gmail.gmailBuildCodeQuery("greenhouse.io", null, null), "newer_than:1h from:greenhouse.io");
  assert.strictEqual(gmail.gmailBuildCodeQuery("greenhouse.io", "verify", "2h"), "newer_than:2h from:greenhouse.io subject:verify");
});

test("code query is SEPARATE from the Workday one (widening it must not touch Workday)", () => {
  // gmailBuildQuery hardcodes Workday's own needles; a Greenhouse change must not reach it.
  assert.ok(gmail.gmailBuildQuery().includes("myworkdayjobs"));
  assert.ok(!gmail.gmailBuildCodeQuery("greenhouse.io").includes("myworkdayjobs"));
});

// ── gmailFindVerificationCode (injected fetch/sleep/now) ────────────────────────────────
// A tiny Gmail double: `msgs` is [{ id, internalDate, subject, body }].
function fakeGmail(msgs, opts) {
  const o = opts || {};
  let listCalls = 0;
  const queries = [];
  const fetchImpl = async (url) => {
    if (url.includes("/messages?q=")) {
      listCalls++;
      queries.push(decodeURIComponent(/q=([^&]*)/.exec(url)[1]));
      if (o.status) return { ok: false, status: o.status, text: async () => "boom" };
      const visible = o.hideUntilCall && listCalls < o.hideUntilCall ? [] : msgs;
      const matched = o.senderFilterWorks === false
        ? visible.filter(() => !queries[queries.length - 1].includes("from:"))
        : visible;
      return { ok: true, json: async () => ({ messages: matched.map((m) => ({ id: m.id })) }) };
    }
    const id = /\/messages\/([^?]+)/.exec(url)[1];
    const m = msgs.find((x) => x.id === id);
    return {
      ok: true,
      json: async () => ({
        id: m.id, internalDate: String(m.internalDate),
        payload: {
          headers: [{ name: "Subject", value: m.subject || "" }, { name: "From", value: m.from || "noreply@greenhouse.io" }],
          mimeType: "text/plain",
          body: { data: Buffer.from(m.body || "", "utf8").toString("base64url") },
        },
      }),
    };
  };
  return { fetchImpl, queries, listCalls: () => listCalls };
}

test("find: returns the code from a message newer than the submit click", async () => {
  const NOW = 1_700_000_000_000;
  const g = fakeGmail([{ id: "m1", internalDate: NOW + 2000, subject: "Verify", body: "Your verification code is TQ7F2M9B." }]);
  const r = await gmail.gmailFindVerificationCode({
    token: "t", length: 8, notBeforeMs: NOW, timeoutMs: 30000, pollMs: 100,
    fetchImpl: g.fetchImpl, nowImpl: () => NOW, sleepImpl: async () => {},
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.code, "TQ7F2M9B");
  assert.strictEqual(r.messageId, "m1");
});

test("find: A CODE PREDATING OUR OWN CLICK IS SKIPPED — the guard that stops us burning it", async () => {
  const NOW = 1_700_000_000_000;
  // A perfectly good code, but mailed for an EARLIER attempt (10 minutes before we clicked).
  const g = fakeGmail([{ id: "old", internalDate: NOW - 600_000, subject: "Verify", body: "Your verification code is OLDCODE1." }]);
  let slept = 0;
  const r = await gmail.gmailFindVerificationCode({
    token: "t", length: 8, notBeforeMs: NOW, timeoutMs: 400, pollMs: 100,
    fetchImpl: g.fetchImpl, nowImpl: () => NOW + slept, sleepImpl: async (ms) => { slept += ms; },
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.timedOut, true);
  assert.strictEqual(r.sawStale >= 1, true, JSON.stringify(r));
  assert.strictEqual(r.sawFresh, 0);
  assert.ok(/predating the submit click/.test(r.error), r.error);
});

test("find: the skew window accepts a code marginally 'older' than our click", async () => {
  const NOW = 1_700_000_000_000;
  // 20s before our click — inside the default 60s clock-skew allowance.
  const g = fakeGmail([{ id: "m1", internalDate: NOW - 20_000, subject: "Verify", body: "Your verification code is TQ7F2M9B." }]);
  const r = await gmail.gmailFindVerificationCode({
    token: "t", length: 8, notBeforeMs: NOW, timeoutMs: 5000, pollMs: 100,
    fetchImpl: g.fetchImpl, nowImpl: () => NOW, sleepImpl: async () => {},
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.code, "TQ7F2M9B");
});

test("find: a sender filter that matches nothing WIDENS once, loudly, and then succeeds", async () => {
  const NOW = 1_700_000_000_000;
  const g = fakeGmail(
    [{ id: "m1", internalDate: NOW + 1000, from: "no-reply@notifications.example", subject: "Verify", body: "Your verification code is TQ7F2M9B." }],
    { senderFilterWorks: false },
  );
  let slept = 0;
  const logs = [];
  const r = await gmail.gmailFindVerificationCode({
    token: "t", length: 8, senderContains: "greenhouse.io", notBeforeMs: NOW,
    timeoutMs: 1000, pollMs: 100, log: (m) => logs.push(m),
    fetchImpl: g.fetchImpl, nowImpl: () => NOW + slept, sleepImpl: async (ms) => { slept += ms; },
  });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.widened, true);
  assert.ok(logs.some((m) => /widening/.test(m)), JSON.stringify(logs));
  assert.ok(g.queries.some((q) => q.includes("from:greenhouse.io")), "it must TRY the sender first");
  assert.ok(g.queries.some((q) => !q.includes("from:")), "and then widen");
});

test("find: a 401 bubbles up immediately for a token refresh (polling cannot fix auth)", async () => {
  const NOW = 1_700_000_000_000;
  const g = fakeGmail([], { status: 401 });
  const r = await gmail.gmailFindVerificationCode({
    token: "t", length: 8, notBeforeMs: NOW, timeoutMs: 30000, pollMs: 100,
    fetchImpl: g.fetchImpl, nowImpl: () => NOW, sleepImpl: async () => {},
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 401);
  assert.strictEqual(g.listCalls(), 1, "it must not keep polling a 401");
});

test("find: a fresh mail we cannot read a code from is reported as SUCH, not as 'no mail'", async () => {
  const NOW = 1_700_000_000_000;
  const g = fakeGmail([{ id: "m1", internalDate: NOW + 1000, subject: "Thanks", body: "Thanks for applying. Nothing code-shaped here." }]);
  let slept = 0;
  const r = await gmail.gmailFindVerificationCode({
    token: "t", length: 8, notBeforeMs: NOW, timeoutMs: 400, pollMs: 100,
    fetchImpl: g.fetchImpl, nowImpl: () => NOW + slept, sleepImpl: async (ms) => { slept += ms; },
  });
  assert.strictEqual(r.ok, false);
  assert.ok(/fresh message/.test(r.error), r.error);
  assert.ok(r.sawFresh >= 1);
});

test("find: no token / no fetch ⇒ a normalized error, never a throw", async () => {
  assert.strictEqual((await gmail.gmailFindVerificationCode({ fetchImpl: async () => ({}) })).ok, false);
  assert.strictEqual((await gmail.gmailFindVerificationCode({ token: "t", fetchImpl: null, nowImpl: () => 0 })).ok, false);
});

// ── the injected widget fns ─────────────────────────────────────────────────────────────
// A minimal DOM double shaped exactly like the live page (traced 2026-08-24): eight
// `#security-input-N` boxes inside `.email-verification__wrapper`, and the application's own
// submit button, disabled until every box holds a character.
function installVerifyDom(opts) {
  const o = opts || {};
  const n = o.boxCount === undefined ? 8 : o.boxCount;
  const prefill = o.prefill || [];
  const boxes = [];
  for (let i = 0; i < n; i++) {
    boxes.push({
      id: "security-input-" + i,
      tagName: "INPUT",
      type: "text",
      value: prefill[i] || "",
      getAttribute: (a) => (a === "maxlength" ? "1" : a === "aria-required" ? "true" : null),
      getBoundingClientRect: () => (o.hidden ? { width: 0, height: 0, x: 0, y: 0 } : { width: 32, height: 40, x: 10 + i * 40, y: 500 }),
      focus() {}, blur() {},
      dispatchEvent() { return true; },
    });
  }
  const allFilled = () => boxes.every((b) => String(b.value || "").length > 0);
  const btn = {
    tagName: "BUTTON",
    textContent: "Submit application",
    get disabled() { return o.forceDisabled === true ? true : !allFilled(); },
    getAttribute: (a) => (a === "aria-disabled" ? (btn.disabled ? "true" : "false") : null),
    getBoundingClientRect: () => ({ width: 180, height: 44, x: 400, y: 600 }),
  };
  const notice = {
    innerText: "A verification code was sent to applicant@example.com. To submit your application, enter the " +
      (o.statedLength || n) + "-character code to confirm you're a human.",
    children: [],
    get textContent() { return notice.innerText; },
  };
  const wrapper = {
    className: "email-verification__wrapper",
    innerText: notice.innerText,
    querySelectorAll: (sel) => (/maxlength/.test(sel) ? (o.unnumbered ? boxes : []) : []),
  };
  const errNode = o.errorText ? {
    textContent: o.errorText,
    getBoundingClientRect: () => ({ width: 200, height: 18, x: 10, y: 560 }),
  } : null;

  const prev = { document: global.document, window: global.window };
  const nodeList = (sel) => {
    if (/security-input-/.test(sel)) return o.unnumbered ? [] : boxes;
    if (/button/.test(sel)) return [btn];
    if (/div, p, span|div,p,span/.test(sel)) return [notice];
    return [];
  };
  global.document = {
    body: { innerText: notice.innerText },
    querySelectorAll: nodeList,
    querySelector: (sel) => (/email-verification__wrapper/.test(sel) ? wrapper : (nodeList(sel)[0] || null)),
    getElementById: (id) => (id === "email-verification-error" ? errNode : null),
  };
  global.window = { HTMLInputElement: { prototype: {} }, HTMLTextAreaElement: { prototype: {} } };
  // The page's native value setter, faithfully — the filler grabs it off the prototype and
  // `.call(box, v)`s it, so it must write THROUGH to whichever box it is invoked on. ⚠ It also
  // honours maxlength="1", because silent truncation is exactly the failure mode a concatenating
  // re-entry produces, and a double that ignored it could not reproduce the bug being guarded.
  Object.defineProperty(global.window.HTMLInputElement.prototype, "value", {
    configurable: true,
    set(v) {
      const max = Number((this.getAttribute && this.getAttribute("maxlength")) || 0);
      const s = String(v);
      Object.defineProperty(this, "value", { configurable: true, writable: true, value: max ? s.slice(0, max) : s });
    },
    get() { return ""; },
  });
  return { boxes, btn, restore: () => { global.document = prev.document; global.window = prev.window; } };
}

test("verify state: reads 8 boxes, the stated length, the destination address and the disabled submit", () => {
  const dom = installVerifyDom();
  try {
    const s = ats.atsInjEmailVerifyState();
    assert.strictEqual(s.present, true);
    assert.strictEqual(s.boxCount, 8);
    assert.strictEqual(s.filledCount, 0);
    assert.strictEqual(s.statedLength, 8);
    assert.strictEqual(s.emailedTo, "applicant@example.com");
    assert.strictEqual(s.hasSubmit, true);
    assert.strictEqual(s.submitDisabled, true, "the button is held until the code is complete");
    assert.strictEqual(s.errorText, null, "no error node until a code is REJECTED");
    assert.ok(s.rect && s.rect.cx > 0);
  } finally { dom.restore(); }
});

test("verify state: absent on an ordinary form ⇒ present:false (the gate is opt-in by DOM)", () => {
  const prev = global.document;
  try {
    global.document = { body: { innerText: "" }, querySelectorAll: () => [], querySelector: () => null, getElementById: () => null };
    assert.strictEqual(ats.atsInjEmailVerifyState().present, false);
  } finally { global.document = prev; }
});

test("verify state: already-typed boxes are COUNTED, so the stage can refuse to overwrite them", () => {
  const dom = installVerifyDom({ prefill: ["A", "B", "C"] });
  try {
    assert.strictEqual(ats.atsInjEmailVerifyState().filledCount, 3);
  } finally { dom.restore(); }
});

test("verify state: a tenant that renames the ids is still found via the wrapper", () => {
  const dom = installVerifyDom({ unnumbered: true, boxCount: 6 });
  try {
    const s = ats.atsInjEmailVerifyState();
    assert.strictEqual(s.present, true);
    assert.strictEqual(s.boxCount, 6);
  } finally { dom.restore(); }
});

test("verify state: an error node reports the form's own rejection text", () => {
  const dom = installVerifyDom({ errorText: "That code is incorrect." });
  try {
    assert.strictEqual(ats.atsInjEmailVerifyState().errorText, "That code is incorrect.");
  } finally { dom.restore(); }
});

test("fill: one character per box, in ID ORDER, and the form's button unlocks", () => {
  const dom = installVerifyDom();
  try {
    const r = ats.atsInjFillEmailCode("TQ7F2M9B");
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.matches, true);
    assert.strictEqual(r.len, 8);
    assert.deepStrictEqual(dom.boxes.map((b) => b.value), ["T", "Q", "7", "F", "2", "M", "9", "B"]);
    assert.strictEqual(r.submitDisabled, false, "the page itself now agrees the code is complete");
  } finally { dom.restore(); }
});

test("fill: NEVER returns the code — only a length, a boolean and per-box occupancy", () => {
  const dom = installVerifyDom();
  try {
    const r = ats.atsInjFillEmailCode("TQ7F2M9B");
    const blob = JSON.stringify(r);
    assert.ok(!blob.includes("TQ7F2M9B"), "the code must not travel in the result: " + blob);
    for (const ch of ["T", "Q", "F", "M", "B"]) {
      assert.ok(!new RegExp('"' + ch + '"').test(blob), "no character may appear as a value: " + blob);
    }
    assert.deepStrictEqual(r.perBox, [1, 1, 1, 1, 1, 1, 1, 1]);
  } finally { dom.restore(); }
});

test("fill: A LENGTH MISMATCH IS REFUSED — maxlength would silently truncate the difference", () => {
  const dom = installVerifyDom({ boxCount: 6 });
  try {
    const r = ats.atsInjFillEmailCode("TQ7F2M9B");
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, "length-mismatch");
    assert.strictEqual(r.boxCount, 6);
    assert.strictEqual(r.codeLength, 8);
    assert.deepStrictEqual(dom.boxes.map((b) => b.value), ["", "", "", "", "", ""], "and it writes NOTHING");
  } finally { dom.restore(); }
});

test("fill: a re-entry over half-typed boxes CLEARS first (a concatenation would truncate)", () => {
  const dom = installVerifyDom({ prefill: ["X", "Y", "Z", "", "", "", "", ""] });
  try {
    const r = ats.atsInjFillEmailCode("TQ7F2M9B");
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(dom.boxes.map((b) => b.value), ["T", "Q", "7", "F", "2", "M", "9", "B"]);
  } finally { dom.restore(); }
});

test("fill: no boxes ⇒ an error, never a throw", () => {
  const prev = global.document;
  try {
    global.document = { querySelectorAll: () => [], querySelector: () => null };
    const r = ats.atsInjFillEmailCode("TQ7F2M9B");
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, "no-code-boxes");
  } finally { global.document = prev; }
});

test("fill: the form keeping Submit disabled is reported, not papered over", () => {
  const dom = installVerifyDom({ forceDisabled: true });
  try {
    const r = ats.atsInjFillEmailCode("TQ7F2M9B");
    assert.strictEqual(r.submitDisabled, true, "the caller halts on this rather than clicking");
  } finally { dom.restore(); }
});

// ── the cdpEval contract ────────────────────────────────────────────────────────────────
test("both new injected fns are self-contained (stringify → new Function parses)", () => {
  for (const name of ["atsInjEmailVerifyState", "atsInjFillEmailCode"]) {
    const src = String(ats[name]);
    assert.doesNotThrow(() => new Function("return (" + src + ")"), name + " does not parse standalone");
    // ⚠ STRIP THE COMMENTS FIRST. Both of these DOCUMENT the sibling they deliberately duplicate
    // ("an in-function dup of atsInjSubmitState's finder"), and a naive grep matches the
    // explanation rather than a real reference — the same trap CLAUDE.md records for the iCIMS
    // select readers.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
    for (const other of ["atsLib", "atsFd", "ATS_STATIC_MAPS", "atsRouteField", "atsRouteLabel", "atsInjSubmitState", "gmailFindVerificationCode"]) {
      assert.ok(!code.includes(other), name + " references " + other + " (not self-contained in the page)");
    }
  }
});
