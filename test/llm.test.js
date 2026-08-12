// Unit tests for llm.js — the multi-provider LLM adapter (AI-0). A FAKE fetch is
// injected (callLLM's 2nd arg) so no network: assert each provider builds the right
// request (url/headers/body) + parses its own response shape, and that every failure
// path returns a normalized { ok:false, error } (callLLM must NEVER throw — a thrown
// adapter would crash a fill).
const { test } = require("node:test");
const assert = require("node:assert");
const { callLLM, callLLMOnce, LLM_DEFAULT_MODELS, LLM_MODELS, LLM_RETRY_DELAYS_MS ,
  resetLlmRetryState,
  llmRetryAfterMs,
  LLM_BREAKER_TRIP_AFTER,
  LLM_RETRY_AFTER_CAP_MS,
  LLM_REQUEST_TIMEOUT_MS,
  LLM_FAST_RETRY_ATTEMPTS,
  LLM_FAST_RETRY_DELAY_MS,
  llmFastRetryMs,
  llmAttemptTimeoutMs,
  LLM_FAST_ADAPT_K,
  LLM_FAST_ADAPT_MIN_SAMPLES,
  LLM_FAST_ADAPT_MAX_CAP_MS,
  LLM_LAT_WINDOW,
  recordLlmAnswerMs,
  llmObservedAnswerP50,
  llmLatencyNewestAt,
  resetLlmLatency,
  LLM_AUTO_MODEL,
  LLM_AUTO_CANDIDATES,
  LLM_AUTO_STALE_MS,
  LLM_AUTO_SIDELINE_MS,
  LLM_AUTO_SLOW_FACTOR,
  LLM_AUTO_MIN_SAMPLES,
  llmRecentSamples,
  llmAutoPick,
  llmAutoOrder,
  llmExpandAutoAttempts,
  llmResolveAutoModel,
  recordLlmModelUnhealthy,
  llmModelSidelined,
  llmStatusIsServerHealth,
} = require("../llm.js");

// A fake fetch that captures the request + returns a canned JSON body.
function fakeFetch(captured, body, { ok = true, status = 200, throwNetwork = false, badJson = false } = {}) {
  return async (url, opts) => {
    captured.url = url; captured.opts = opts;
    if (throwNetwork) throw new Error("ECONNREFUSED");
    return {
      ok, status,
      json: async () => { if (badJson) throw new Error("Unexpected token"); return body; },
      text: async () => JSON.stringify(body)
    };
  };
}
const base = { model: "m-1", apiKey: "k-secret", system: "be brief", user: "hi", maxTokens: 32 };

test("anthropic: builds the Messages request + parses content[].text", async () => {
  const cap = {};
  const ff = fakeFetch(cap, { content: [{ type: "text", text: "  OK  " }] });
  const r = await callLLM({ ...base, provider: "anthropic" }, ff);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, "OK", "trimmed");
  assert.match(cap.url, /api\.anthropic\.com\/v1\/messages$/);
  assert.strictEqual(cap.opts.headers["x-api-key"], "k-secret");
  assert.strictEqual(cap.opts.headers["anthropic-version"], "2023-06-01");
  const body = JSON.parse(cap.opts.body);
  assert.strictEqual(body.model, "m-1");
  assert.strictEqual(body.system, "be brief");
  assert.deepStrictEqual(body.messages, [{ role: "user", content: "hi" }]);
  assert.strictEqual(body.max_tokens, 32);
});

test("gemini: key in the query string + parses candidates[].content.parts[].text", async () => {
  const cap = {};
  const ff = fakeFetch(cap, { candidates: [{ content: { parts: [{ text: "OK" }] } }] });
  const r = await callLLM({ ...base, provider: "gemini" }, ff);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, "OK");
  assert.match(cap.url, /generativelanguage\.googleapis\.com\/v1beta\/models\/m-1:generateContent\?key=k-secret$/);
  const body = JSON.parse(cap.opts.body);
  assert.deepStrictEqual(body.systemInstruction, { parts: [{ text: "be brief" }] });
  assert.deepStrictEqual(body.contents, [{ role: "user", parts: [{ text: "hi" }] }]);
  assert.strictEqual(body.generationConfig.maxOutputTokens, 32);
});

test("openai: Bearer auth + system+user messages + parses choices[].message.content", async () => {
  const cap = {};
  const ff = fakeFetch(cap, { choices: [{ message: { content: "OK" } }] });
  const r = await callLLM({ ...base, provider: "openai" }, ff);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, "OK");
  assert.match(cap.url, /api\.openai\.com\/v1\/chat\/completions$/);
  assert.strictEqual(cap.opts.headers["Authorization"], "Bearer k-secret");
  const body = JSON.parse(cap.opts.body);
  assert.deepStrictEqual(body.messages, [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }]);
});

test("missing config → normalized error, never throws", async () => {
  const ff = fakeFetch({}, {});
  assert.match((await callLLM({ provider: "gemini", apiKey: "k", model: "m" }, ff)).error, /no prompt/);
  assert.match((await callLLM({ provider: "gemini", model: "m", user: "x" }, ff)).error, /no API key/);
  assert.match((await callLLM({ provider: "gemini", apiKey: "k", user: "x" }, ff)).error, /no model/);
  assert.match((await callLLM({ provider: "nope", apiKey: "k", model: "m", user: "x" }, ff)).error, /unknown LLM provider/);
});

test("HTTP error (bad key) → { ok:false, error } with the status + body, never throws", async () => {
  const cap = {};
  const ff = fakeFetch(cap, { error: { message: "invalid api key" } }, { ok: false, status: 401 });
  const r = await callLLM({ ...base, provider: "openai" }, ff);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /HTTP 401/);
  assert.match(r.error, /invalid api key/);
});

test("network throw → normalized error, never throws", async () => {
  const ff = fakeFetch({}, {}, { throwNetwork: true });
  const r = await callLLM({ ...base, provider: "anthropic" }, ff);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /network error/);
});

test("empty / missing text in a 200 response → { ok:false } (never a blank 'success')", async () => {
  const ff = fakeFetch({}, { candidates: [{ content: { parts: [{ text: "   " }] } }] });
  const r = await callLLM({ ...base, provider: "gemini" }, ff);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /no text in response/);
});

// ── Transient-availability retry (the 2026-07-02 Gemini 503 "high demand") ──
// A fake fetch returning a SEQUENCE of responses, one per attempt (the last repeats).
function seqFetch(calls, seq) {
  return async (url, opts) => {
    calls.push({ url, opts });
    const s = seq[Math.min(calls.length - 1, seq.length - 1)];
    return { ok: s.ok !== false, status: s.status || 200,
      json: async () => s.body, text: async () => JSON.stringify(s.body) };
  };
}

test("retry: HTTP 503 then success → ok:true after ONE wait (the Gemini high-demand spike recovers)", async () => {
  const calls = [], waits = [];
  const ff = seqFetch(calls, [
    { ok: false, status: 503, body: { error: { code: 503, message: "This model is currently experiencing high demand.", status: "UNAVAILABLE" } } },
    { body: { candidates: [{ content: { parts: [{ text: "OK" }] } }] } }
  ]);
  const r = await callLLM({ ...base, provider: "gemini" }, ff, async (ms) => waits.push(ms));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, "OK");
  assert.strictEqual(calls.length, 2, "one retry");
  assert.deepStrictEqual(waits, [LLM_RETRY_DELAYS_MS[0]], "waited before the retry");
});

test("retry: persistent 503 → exhausts every delay then ok:false NAMING the attempts (bounded, never an infinite loop)", async () => {
  const calls = [], waits = [];
  const ff = seqFetch(calls, [{ ok: false, status: 503, body: { error: { message: "high demand" } } }]);
  const r = await callLLM({ ...base, provider: "gemini" }, ff, async (ms) => waits.push(ms));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /HTTP 503/);
  assert.match(r.error, /high demand/);
  assert.match(r.error, new RegExp("gave up after " + (LLM_RETRY_DELAYS_MS.length + 1) + " attempts"));
  assert.strictEqual(calls.length, LLM_RETRY_DELAYS_MS.length + 1, "one attempt per delay + the first");
  assert.deepStrictEqual(waits, LLM_RETRY_DELAYS_MS, "waited the full ladder");
});

test("retry: auth/validation (401) NEVER retries — one attempt, no wait, no attempts note", async () => {
  const calls = [], waits = [];
  const ff = seqFetch(calls, [{ ok: false, status: 401, body: { error: { message: "invalid api key" } } }]);
  const r = await callLLM({ ...base, provider: "openai" }, ff, async (ms) => waits.push(ms));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /HTTP 401/);
  assert.ok(!/gave up after/.test(r.error), "a single attempt carries no attempts note");
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(waits, []);
});

test("retry: 429 (rate limit) is retryable — recovers on the second attempt", async () => {
  const calls = [];
  const ff = seqFetch(calls, [
    { ok: false, status: 429, body: { error: { message: "rate limited" } } },
    { body: { choices: [{ message: { content: "OK" } }] } }
  ]);
  const r = await callLLM({ ...base, provider: "openai" }, ff, async () => {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(calls.length, 2);
});

test("LLM_DEFAULT_MODELS has a default per provider", () => {
  assert.ok(LLM_DEFAULT_MODELS.anthropic && LLM_DEFAULT_MODELS.gemini && LLM_DEFAULT_MODELS.openai);
});

test("LLM_MODELS: each provider has a non-empty list and the default is its FIRST entry (no drift)", () => {
  for (const p of ["anthropic", "gemini", "openai"]) {
    assert.ok(Array.isArray(LLM_MODELS[p]) && LLM_MODELS[p].length, `${p} has a model list`);
    assert.strictEqual(LLM_DEFAULT_MODELS[p], LLM_MODELS[p][0], `${p} default == first listed model`);
  }
});

// ── Retrying HARDER, and knowing when to stop (operator 2026-08-02: "if the llm gives an error
// you should try again for a bit"). A 429 is usually a per-MINUTE quota, which the old 2s+8s
// ladder could not outlast — live, a 65-field form dropped fields to needs_review that the model
// could have answered.

// A fetch that fails with a given status N times (carrying headers), then succeeds.
function failThenOk(calls, status, times, headers) {
  return async (url, opts) => {
    calls.push({ url, opts });
    if (calls.length <= times) {
      return { ok: false, status, headers: headers ? { get: (k) => headers[String(k).toLowerCase()] ?? null } : undefined,
        json: async () => ({}), text: async () => "limited" };
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "OK" } }] }), text: async () => "" };
  };
}

test("retry: Retry-After (seconds) is OBEYED instead of the ladder", async () => {
  resetLlmRetryState();
  const calls = [], waits = [];
  const ff = failThenOk(calls, 429, 1, { "retry-after": "5" });
  const r = await callLLM({ ...base, provider: "openai" }, ff, async (ms) => waits.push(ms));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(waits, [5000], "waited exactly what the server asked, not the ladder step");
});

test("retry: an absurd Retry-After is CAPPED so one header can't hang a run", () => {
  const res = { headers: { get: () => "3600" } }; // an hour
  assert.strictEqual(llmRetryAfterMs(res, Date.now()), LLM_RETRY_AFTER_CAP_MS);
});

test("retry: Retry-After as an HTTP DATE is understood; junk falls back to the ladder", async () => {
  const now = Date.parse("2026-08-02T12:00:00Z");
  const res = { headers: { get: () => new Date(now + 4000).toUTCString() } };
  const ms = llmRetryAfterMs(res, now);
  assert.ok(ms >= 3000 && ms <= 5000, "about four seconds, got " + ms);
  assert.strictEqual(llmRetryAfterMs({ headers: { get: () => "soon-ish" } }, now), null);
  assert.strictEqual(llmRetryAfterMs({}, now), null, "no headers at all is not an error");
});

test("retry: a NETWORK error is transient too — retried, then succeeds", async () => {
  resetLlmRetryState();
  const calls = [], waits = [];
  const ff = async (url, opts) => {
    calls.push({ url, opts });
    if (calls.length === 1) throw new Error("socket hang up");
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "OK" } }] }), text: async () => "" };
  };
  const r = await callLLM({ ...base, provider: "openai" }, ff, async (ms) => waits.push(ms));
  assert.strictEqual(r.ok, true, "recovered from the blip");
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(waits.length, 1);
});

test("retry: a persistent network error still gives up, naming the attempts", async () => {
  resetLlmRetryState();
  const ff = async () => { throw new Error("ENOTFOUND"); };
  const r = await callLLM({ ...base, provider: "openai" }, ff, async () => {});
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /network error/);
  assert.match(r.error, /gave up after/);
});

// Retrying is right for a spike and WRONG for an exhausted quota: a full ladder per field would
// turn a 65-field form into a ~45-minute stall.
test("breaker: after N exhausted calls, later calls take ONE attempt (no ladder)", async () => {
  resetLlmRetryState();
  const always429 = (calls) => async (url, opts) => {
    calls.push(1);
    return { ok: false, status: 429, json: async () => ({}), text: async () => "quota" };
  };
  for (let i = 0; i < LLM_BREAKER_TRIP_AFTER; i++) {
    const c = [];
    await callLLM({ ...base, provider: "openai" }, always429(c), async () => {});
    assert.ok(c.length > 1, "each pre-trip call spends its ladder");
  }
  const after = [];
  const r = await callLLM({ ...base, provider: "openai" }, always429(after), async () => {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(after.length, 1, "cooling down: exactly one attempt");
  assert.match(r.error, /cooldown/i, "and it SAYS so, rather than looking like a plain failure");
});

test("breaker: a SUCCESS clears it, so a recovered quota resumes full retrying", async () => {
  resetLlmRetryState();
  const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "OK" } }] }), text: async () => "" });
  const c1 = [];
  await callLLM({ ...base, provider: "openai" }, async () => { c1.push(1); return { ok: false, status: 429, json: async () => ({}), text: async () => "x" }; }, async () => {});
  const good = await callLLM({ ...base, provider: "openai" }, okFetch, async () => {});
  assert.strictEqual(good.ok, true);
  const c2 = [];
  await callLLM({ ...base, provider: "openai" }, async () => { c2.push(1); return { ok: false, status: 429, json: async () => ({}), text: async () => "x" }; }, async () => {});
  assert.ok(c2.length > 1, "full ladder again after the success");
  resetLlmRetryState();
});

// ── PER-ATTEMPT REQUEST TIMEOUT ─────────────────────────────────────────────
// Live (cat.wd5, 2026-08-08): AI-4 remediation took ~182s to clear ONE field, and 148s of that was a
// SINGLE hung call — `[LLM] ok in 148262ms` — while the identical retry right after it returned in
// 2005ms and every other call in the run took 0.5-2s. fetch() has no timeout of its own, so one stuck
// socket blocked the whole walk. Each attempt is now bounded; the abort throws, which callLLMOnce
// already treats as a retryable transient.
test("a request that never answers is ABORTED and retried, not waited on forever", async () => {
  resetLlmRetryState();
  let attempts = 0;
  const fetchImpl = async (url, opts) => {
    attempts++;
    if (attempts === 1) {
      return await new Promise((_resolve, reject) => {
        if (opts && opts.signal) opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }); // never resolves on its own — the live hang
    }
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: "hi" }] } }] }) };
  };
  const r = await callLLM(
    { provider: "gemini", model: LLM_DEFAULT_MODELS.gemini, apiKey: "k", user: "q", timeoutMs: 40 },
    fetchImpl,
    async () => {} // don't actually sleep the retry ladder
  );
  assert.equal(attempts, 2, "the hung attempt was abandoned and re-issued");
  assert.equal(r.ok, true);
  assert.equal(r.text, "hi");
});

test("a hang on EVERY attempt still returns a normalized error — callLLM never throws", async () => {
  resetLlmRetryState();
  const fetchImpl = async (url, opts) => new Promise((_res, rej) => {
    if (opts && opts.signal) opts.signal.addEventListener("abort", () => rej(new Error("aborted")));
  });
  const r = await callLLM(
    { provider: "gemini", model: LLM_DEFAULT_MODELS.gemini, apiKey: "k", user: "q", timeoutMs: 20 },
    fetchImpl,
    async () => {}
  );
  assert.equal(r.ok, false);
  assert.match(String(r.error), /timed out after 20ms/, "the reason names the timeout, not a bare network error");
  resetLlmRetryState();
});

// ── FAST-RETRY for gemini 3.1 (2026-08-09) ────────────────────────────────────────────────────────
// Live evidence: gemini-3.1-flash-lite answers in 486/646/796ms, and once took 30657ms on a single
// SUCCEEDING attempt that nothing retried — one call turning a 1.9s page into a 32s page. So an early
// attempt is capped short and re-issued; the LAST attempt keeps the full budget, because a short cap
// everywhere would fail a required field on a genuinely slow minute and halt the walk.

test("fast-retry: a gemini 3.1 model gets the short cap while fast tries remain", () => {
  const cfg = { provider: "gemini", model: "gemini-3.1-flash-lite" };
  assert.equal(llmFastRetryMs(cfg), 2000, "the rule matches gemini 3.1");
  assert.equal(llmAttemptTimeoutMs(cfg, LLM_FAST_RETRY_ATTEMPTS), 2000, "capped while tries remain");
  assert.equal(llmAttemptTimeoutMs(cfg, 1), 2000);
});

test("fast-retry SAFETY: once the fast tries are spent the call gets the FULL budget", () => {
  const cfg = { provider: "gemini", model: "gemini-3.1-flash-lite" };
  assert.equal(llmAttemptTimeoutMs(cfg, 0), LLM_REQUEST_TIMEOUT_MS,
    "a slow provider must never be FAILED by the cap — that would blank a required field and halt the walk");
});

test("fast-retry is SCOPED: other gemini models and other providers are untouched", () => {
  assert.equal(llmFastRetryMs({ provider: "gemini", model: "gemini-2.5-flash-lite" }), null);
  assert.equal(llmFastRetryMs({ provider: "gemini", model: "gemini-3.5-flash-lite" }), null);
  assert.equal(llmFastRetryMs({ provider: "anthropic", model: "gemini-3.1-flash-lite" }), null, "provider must match too");
  assert.equal(llmAttemptTimeoutMs({ provider: "gemini", model: "gemini-3.5-flash-lite" }, 2), LLM_REQUEST_TIMEOUT_MS);
});

// ── ADAPTIVE CAP (2026-08-11) ────────────────────────────────────────────────────────────────────
// Round 8 measured 76 of 77 calls spending BOTH fast tries because the model's real p50 had moved to
// ~7–13s. Nothing failed (the last attempt always gets the full budget) but ~4s per call was wasted,
// ~28s a page. The cap now follows the observed p50 and switches OFF when no short cap could separate
// "stuck" from merely "slow". Every test here reset the window first — it is worker-lifetime state.
const G31 = { provider: "gemini", model: "gemini-3.1-flash-lite" };
const feed = (ms, n) => { for (let i = 0; i < n; i++) recordLlmAnswerMs(G31.provider, G31.model, ms); };

test("adaptive cap: a COLD worker uses the rule's static ms (today's behaviour, unchanged)", () => {
  resetLlmLatency();
  assert.equal(llmObservedAnswerP50(G31.provider, G31.model), null, "no samples ⇒ no opinion");
  assert.equal(llmFastRetryMs(G31), 2000);
  feed(650, LLM_FAST_ADAPT_MIN_SAMPLES - 1);
  assert.equal(llmObservedAnswerP50(G31.provider, G31.model), null,
    "under the minimum, still no opinion — one stuck-socket recovery must not be able to retune it");
  assert.equal(llmFastRetryMs(G31), 2000);
  resetLlmLatency();
});

test("adaptive cap: a HEALTHY model keeps the 2000ms static floor (K×p50 lands right on it)", () => {
  resetLlmLatency();
  feed(650, LLM_FAST_ADAPT_MIN_SAMPLES);
  assert.equal(llmObservedAnswerP50(G31.provider, G31.model), 650);
  // 3 × 650 = 1950, under the static floor ⇒ the hand-picked 2000 stands. This is the calibration
  // check: K was chosen so the adaptive rule REPRODUCES the value that was tuned by hand.
  assert.equal(650 * LLM_FAST_ADAPT_K < 2000, true);
  assert.equal(llmFastRetryMs(G31), 2000, "a fast model behaves exactly as before the change");
  resetLlmLatency();
});

test("adaptive cap: a MODERATELY slower model gets a PROPORTIONALLY wider cap", () => {
  resetLlmLatency();
  feed(1200, LLM_FAST_ADAPT_MIN_SAMPLES);
  assert.equal(llmFastRetryMs(G31), 3600, "3 × 1200ms — still short enough to police a stuck socket");
  resetLlmLatency();
});

test("★ adaptive cap: the ROUND 8 REGRESSION — a ~11s p50 turns the fast-retry OFF", () => {
  resetLlmLatency();
  feed(11000, LLM_FAST_ADAPT_MIN_SAMPLES);
  assert.equal(llmFastRetryMs(G31), null,
    "at this p50 EVERY healthy call is still running at 2000ms, so the cap fires on all of them and rescues none");
  // …and OFF must mean the full budget on the FIRST attempt, which is where the ~4s/call is recovered.
  assert.equal(llmAttemptTimeoutMs(G31, LLM_FAST_RETRY_ATTEMPTS), LLM_REQUEST_TIMEOUT_MS);
  assert.equal(llmAttemptTimeoutMs(G31, 0), LLM_REQUEST_TIMEOUT_MS);
  resetLlmLatency();
});

test("adaptive cap: the OFF threshold is where K×p50 crosses LLM_FAST_ADAPT_MAX_CAP_MS", () => {
  const justUnder = Math.floor(LLM_FAST_ADAPT_MAX_CAP_MS / LLM_FAST_ADAPT_K) - 1;
  resetLlmLatency();
  feed(justUnder, LLM_FAST_ADAPT_MIN_SAMPLES);
  assert.equal(typeof llmFastRetryMs(G31), "number", "still policeable just under the threshold");
  resetLlmLatency();
  feed(Math.ceil(LLM_FAST_ADAPT_MAX_CAP_MS / LLM_FAST_ADAPT_K) + 50, LLM_FAST_ADAPT_MIN_SAMPLES);
  assert.equal(llmFastRetryMs(G31), null, "past it, OFF");
  resetLlmLatency();
});

test("adaptive cap: RECOVERS — a model that speeds up gets its fast-retry back", () => {
  resetLlmLatency();
  feed(11000, LLM_FAST_ADAPT_MIN_SAMPLES);
  assert.equal(llmFastRetryMs(G31), null);
  feed(600, LLM_LAT_WINDOW);                 // the window rolls the slow era out entirely
  assert.equal(llmFastRetryMs(G31), 2000, "back to the static floor once answers are fast again");
  resetLlmLatency();
});

test("adaptive cap: the window is BOUNDED and keeps only the most recent answers", () => {
  resetLlmLatency();
  feed(500, LLM_LAT_WINDOW + 6);
  assert.equal(llmObservedAnswerP50(G31.provider, G31.model), 500);
  feed(9000, LLM_LAT_WINDOW);                // fully displaces them
  assert.equal(llmObservedAnswerP50(G31.provider, G31.model), 9000);
  resetLlmLatency();
});

test("adaptive cap: a MEDIAN, so one outlier neither widens nor disables the cap", () => {
  resetLlmLatency();
  feed(600, 3);
  recordLlmAnswerMs(G31.provider, G31.model, 30000);   // one genuine 30s hang, the case the feature exists for
  assert.equal(llmObservedAnswerP50(G31.provider, G31.model), 600);
  assert.equal(llmFastRetryMs(G31), 2000, "the fast-retry must SURVIVE the very event it guards against");
  resetLlmLatency();
});

test("adaptive cap: samples are per provider+model — one route cannot retune another", () => {
  resetLlmLatency();
  feed(11000, LLM_FAST_ADAPT_MIN_SAMPLES);
  assert.equal(llmFastRetryMs(G31), null);
  assert.equal(llmObservedAnswerP50("gemini", "gemini-3.5-flash-lite"), null, "a sibling model is unaffected");
  assert.equal(llmObservedAnswerP50("anthropic", "gemini-3.1-flash-lite"), null, "and so is another provider");
  resetLlmLatency();
});

test("adaptive cap: opt-out and scoping still win over any observed latency", () => {
  resetLlmLatency();
  feed(1200, LLM_FAST_ADAPT_MIN_SAMPLES);
  assert.equal(llmFastRetryMs({ ...G31, fastRetry: false }), null, "explicit opt-out is absolute");
  assert.equal(llmFastRetryMs({ provider: "gemini", model: "gemini-3.5-flash-lite" }), null,
    "an unruled model never gains a cap by being measured");
  resetLlmLatency();
});

test("adaptive cap: garbage samples are ignored rather than poisoning the p50", () => {
  resetLlmLatency();
  feed(700, LLM_FAST_ADAPT_MIN_SAMPLES);
  [NaN, Infinity, -5, undefined, null, "slow"].forEach((bad) => recordLlmAnswerMs(G31.provider, G31.model, bad));
  assert.equal(llmObservedAnswerP50(G31.provider, G31.model), 700);
  resetLlmLatency();
});

test("★ adaptive cap: an ABORTED attempt is never recorded (it would justify its own cap)", async () => {
  resetLlmLatency();
  // Attempt 1 hangs past the cap and is abandoned; attempt 2 answers in ~0ms. Only the answer counts.
  let call = 0;
  const ff = async (url, opts) => {
    call++;
    if (call === 1) return await new Promise((_, rej) => { if (opts && opts.signal) opts.signal.addEventListener("abort", () => rej(new Error("aborted"))); });
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: "hi" }] } }] }), text: async () => "{}" };
  };
  const r = await callLLMOnce({ ...G31, apiKey: "k", user: "q", timeoutMs: 20, fastRetry: undefined }, ff, async () => {});
  assert.equal(r.ok, true);
  const p50 = llmObservedAnswerP50(G31.provider, G31.model);
  assert.equal(p50 === null || p50 < 2000, true,
    "the censored 20ms-capped attempt must not be in the window — counting aborts drags the p50 toward the cap");
  resetLlmLatency();
});

// ── AUTO MODEL (2026-08-11) ──────────────────────────────────────────────────────────────────────
// Operator: "try 3.5 flash lite first and if it is busy, errors, or something else, then go to 3".
// So this is ORDERED PREFERENCE WITH FAILOVER, not a lowest-latency race — the primary is honoured and
// a sibling is only reached on EVIDENCE. Measured cause: interleaved on one free key in one minute,
// 3.1 answered in 11499/7620/10903ms while 3.5 answered in 409/682/395ms.
const AUTO_1ST = LLM_AUTO_CANDIDATES.gemini[0];   // gemini-3.5-flash-lite
const AUTO_2ND = LLM_AUTO_CANDIDATES.gemini[1];   // gemini-3.1-flash-lite
const feedM = (model, ms, n, at) => { for (let i = 0; i < n; i++) recordLlmAnswerMs("gemini", model, ms, at); };
const healthy = (model, ms) => feedM(model, ms, LLM_FAST_ADAPT_MIN_SAMPLES);

test("auto: the PREFERRED model is 3.5-flash-lite and it wins with nothing measured", () => {
  resetLlmLatency();
  assert.equal(AUTO_1ST, "gemini-3.5-flash-lite");
  assert.equal(AUTO_2ND, "gemini-3.1-flash-lite");
  assert.equal(llmAutoPick("gemini").model, AUTO_1ST, "order is honoured, not raced");
  resetLlmLatency();
});

test("auto: the preferred model wins even when the sibling has measured FASTER but not 3× faster", () => {
  resetLlmLatency();
  healthy(AUTO_1ST, 900);
  healthy(AUTO_2ND, 600);   // faster, but only 1.5×
  assert.equal(llmAutoPick("gemini").model, AUTO_1ST,
    "a stable primary beats chasing a small latency edge — that is the point of preference order");
  resetLlmLatency();
});

test("★ auto: 'BUSY' — the preferred model answering ≥3× slower steps down to the sibling", () => {
  resetLlmLatency();
  healthy(AUTO_1ST, 11000);
  healthy(AUTO_2ND, 500);
  const pick = llmAutoPick("gemini");
  assert.equal(pick.model, AUTO_2ND);
  assert.match(pick.reason, /slower/);
  assert.equal(500 * LLM_AUTO_SLOW_FACTOR <= 11000, true);
  resetLlmLatency();
});

test("★ auto: 'ERRORS' — a 503 sidelines the preferred model, and it comes back after the cooldown", () => {
  resetLlmLatency();
  healthy(AUTO_1ST, 400);
  healthy(AUTO_2ND, 800);
  assert.equal(llmAutoPick("gemini").model, AUTO_1ST, "healthy ⇒ preferred");
  const t0 = 1_000_000;
  recordLlmModelUnhealthy("gemini", AUTO_1ST, t0);
  assert.equal(llmModelSidelined("gemini", AUTO_1ST, t0 + 1), true);
  assert.equal(llmAutoPick("gemini", t0 + 1).model, AUTO_2ND, "sidelined ⇒ the sibling serves");
  // …and the sideline EXPIRES, so a recovered model is not demoted permanently.
  assert.equal(llmModelSidelined("gemini", AUTO_1ST, t0 + LLM_AUTO_SIDELINE_MS + 1), false);
  assert.equal(llmAutoPick("gemini", t0 + LLM_AUTO_SIDELINE_MS + 1).model, AUTO_1ST);
  resetLlmLatency();
});

test("auto: only SERVER-health statuses sideline a model — a 429/401 is the KEY's fault, not the model's", () => {
  [500, 502, 503, 504].forEach((s) => assert.equal(llmStatusIsServerHealth(s), true, `${s} is server health`));
  [400, 401, 403, 404, 429].forEach((s) => assert.equal(llmStatusIsServerHealth(s), false,
    `${s} must NOT demote the operator's chosen primary — a rate-limited key says nothing about the model`));
});

test("★ auto: a demoted primary is RE-PROBED once its data goes stale (never a permanent demotion)", () => {
  resetLlmLatency();
  const t0 = 5_000_000;
  feedM(AUTO_1ST, 11000, LLM_FAST_ADAPT_MIN_SAMPLES, t0);
  feedM(AUTO_2ND, 500, LLM_FAST_ADAPT_MIN_SAMPLES, t0);
  assert.equal(llmAutoPick("gemini", t0 + 1000).model, AUTO_2ND, "slow ⇒ stepped down");
  // We stop calling the primary, so its measurement ages. Staleness must return it to the front,
  // otherwise the very first verdict is permanent and a recovered model can never win traffic back.
  const later = t0 + LLM_AUTO_STALE_MS + 1;
  feedM(AUTO_2ND, 500, 1, later - 10);   // the sibling keeps being measured; only the primary is stale
  const pick = llmAutoPick("gemini", later);
  assert.equal(pick.model, AUTO_1ST);
  assert.match(pick.reason, /recovered|nothing measured/);
  resetLlmLatency();
});

test("★★ auto: RECOVERY IS FAST — stale slow samples are DISCARDED, not averaged with the fresh one", () => {
  resetLlmLatency();
  const t0 = 6_000_000;
  // The primary was measured slow and stepped down.
  feedM(AUTO_1ST, 11000, LLM_LAT_WINDOW, t0);
  feedM(AUTO_2ND, 500, LLM_AUTO_MIN_SAMPLES, t0);
  assert.equal(llmAutoPick("gemini", t0 + 1000).model, AUTO_2ND);

  // 15min later it is re-probed and comes back HEALTHY. Only ONE fresh sample exists.
  const later = t0 + LLM_AUTO_STALE_MS + 1;
  feedM(AUTO_2ND, 500, LLM_AUTO_MIN_SAMPLES, later);
  recordLlmAnswerMs("gemini", AUTO_1ST, 410, later);
  assert.equal(llmAutoPick("gemini", later + 1).model, AUTO_1ST,
    "one fresh sample is under LLM_AUTO_MIN_SAMPLES ⇒ unmeasured ⇒ the preferred model is used again");

  // A second fresh fast sample CONFIRMS it, and the eight stale 11000ms readings must not drag the
  // median back up — that bug would need ~5 probes (~75min) to switch back instead of ~1.
  recordLlmAnswerMs("gemini", AUTO_1ST, 400, later + 5);
  assert.equal(llmObservedAnswerP50("gemini", AUTO_1ST, { now: later + 6, maxAgeMs: LLM_AUTO_STALE_MS, minSamples: LLM_AUTO_MIN_SAMPLES }), 405,
    "the p50 sees ONLY the two fresh samples");
  assert.equal(llmAutoPick("gemini", later + 6).model, AUTO_1ST, "and it stays on the recovered primary");
  resetLlmLatency();
});

test("auto: a re-probe that finds the primary STILL slow steps back down without a long stall", () => {
  resetLlmLatency();
  const t0 = 7_000_000;
  const later = t0 + LLM_AUTO_STALE_MS + 1;
  feedM(AUTO_2ND, 500, LLM_AUTO_MIN_SAMPLES, later);
  // Two fresh slow answers are enough to demote again — the low AUTO sample bar cuts both ways, which
  // is the point: reacting quickly must be cheap in BOTH directions.
  feedM(AUTO_1ST, 12000, LLM_AUTO_MIN_SAMPLES, later);
  assert.equal(llmAutoPick("gemini", later + 1).model, AUTO_2ND);
  resetLlmLatency();
});

test("auto: if EVERY candidate is sidelined it still returns the preferred one — never nothing", () => {
  resetLlmLatency();
  const t0 = 9_000_000;
  LLM_AUTO_CANDIDATES.gemini.forEach((m) => recordLlmModelUnhealthy("gemini", m, t0));
  const pick = llmAutoPick("gemini", t0 + 1);
  assert.equal(pick.model, AUTO_1ST,
    "a degraded answer beats no answer — a failed AI call blanks a required field and halts a walk");
  resetLlmLatency();
});

test("auto: a provider with no candidate list falls back to its DEFAULT model, never ''", () => {
  resetLlmLatency();
  assert.equal(LLM_AUTO_CANDIDATES.anthropic, undefined);
  assert.equal(llmAutoPick("anthropic").model, LLM_DEFAULT_MODELS.anthropic);
  resetLlmLatency();
});

test("auto: llmResolveAutoModel passes a CONCRETE model through untouched", () => {
  resetLlmLatency();
  assert.equal(llmResolveAutoModel("gemini", "gemini-2.5-flash-lite"), "gemini-2.5-flash-lite",
    "only the literal \"auto\" sentinel is expanded");
  assert.equal(llmResolveAutoModel("gemini", LLM_AUTO_MODEL), AUTO_1ST);
  resetLlmLatency();
});

test("auto: the sentinel is the literal string \"auto\"", () => {
  assert.equal(LLM_AUTO_MODEL, "auto");
});

test("auto: latency samples carry a TIMESTAMP (what staleness and re-probing are built on)", () => {
  resetLlmLatency();
  assert.equal(llmLatencyNewestAt("gemini", AUTO_1ST), null);
  recordLlmAnswerMs("gemini", AUTO_1ST, 500, 4242);
  assert.equal(llmLatencyNewestAt("gemini", AUTO_1ST), 4242);
  recordLlmAnswerMs("gemini", AUTO_1ST, 500, 9999);
  assert.equal(llmLatencyNewestAt("gemini", AUTO_1ST), 9999, "newest wins");
  resetLlmLatency();
});

test("★ auto + adaptive cap share ONE window, so a 503 fallback does not distort the cap", async () => {
  resetLlmLatency();
  // The live shape: 3.1 503s after ~10s, the route falls to 3.5 which answers in ~0.4s. The 3.5 sample
  // must land under 3.5 — attributing it to 3.1 would make the slow model look fast and keep it primary.
  recordLlmAnswerMs("gemini", AUTO_2ND, 10500);
  recordLlmAnswerMs("gemini", AUTO_1ST, 409);
  assert.equal(llmLatencyNewestAt("gemini", AUTO_1ST) !== null, true);
  healthy(AUTO_1ST, 409);
  healthy(AUTO_2ND, 10500);
  assert.equal(llmAutoPick("gemini").model, AUTO_1ST, "the fast one is primary AND preferred");
  resetLlmLatency();
});

// ── IN-CALL EXPANSION OF "auto" (2026-08-11) ─────────────────────────────────────────────────────
// act.llm loops the attempt list and fails fast on every attempt but the last, so the list IS the
// in-call failover. An `auto` slot that resolved to ONE model was therefore also the LAST attempt: a
// persistent 503 ended the call unanswered (field → review) and the sibling was only reached by a LATER
// call. Live on the operator's config resolveLlmRoute returned a route of LENGTH 1 — no fallback at all.
const slot = (model, extra) => ({ provider: "gemini", model, thinking: "off", effort: "", keyId: "", ...(extra || {}) });

test("★ auto expansion: ONE auto slot becomes one attempt PER CANDIDATE, health-ranked", () => {
  resetLlmLatency();
  const out = llmExpandAutoAttempts([slot(LLM_AUTO_MODEL)]);
  assert.deepEqual(out.map((a) => a.model), [AUTO_1ST, AUTO_2ND],
    "the whole point: a single auto slot now carries its own in-call fallback");
  assert.equal(out.every((a) => a.fromAuto === true), true, "marked, so the log can say (auto)");
  resetLlmLatency();
});

test("★ auto expansion: the order follows HEALTH — a sidelined primary drops behind the sibling", () => {
  resetLlmLatency();
  const t0 = 3_000_000;
  recordLlmModelUnhealthy("gemini", AUTO_1ST, t0);
  const out = llmExpandAutoAttempts([slot(LLM_AUTO_MODEL)], t0 + 1);
  assert.deepEqual(out.map((a) => a.model), [AUTO_2ND, AUTO_1ST],
    "the sidelined model is kept as a LAST RESORT, never dropped — a degraded answer beats none");
  resetLlmLatency();
});

test("★ auto expansion: keyId rides onto every attempt, so Auto and key PINNING compose", () => {
  resetLlmLatency();
  const out = llmExpandAutoAttempts([slot(LLM_AUTO_MODEL, { keyId: "keyA" })]);
  assert.deepEqual(out.map((a) => `${a.model}@${a.keyId}`), [`${AUTO_1ST}@keyA`, `${AUTO_2ND}@keyA`],
    "an auto slot pinned to key A must not silently lose the pin when it expands");
  resetLlmLatency();
});

test("★ auto expansion: two auto slots on DIFFERENT keys give both models on both keys", () => {
  resetLlmLatency();
  const out = llmExpandAutoAttempts([slot(LLM_AUTO_MODEL, { keyId: "keyA" }), slot(LLM_AUTO_MODEL, { keyId: "keyB" })]);
  assert.deepEqual(out.map((a) => `${a.model}@${a.keyId}`),
    [`${AUTO_1ST}@keyA`, `${AUTO_2ND}@keyA`, `${AUTO_1ST}@keyB`, `${AUTO_2ND}@keyB`],
    "attempts differing only by KEY are genuinely useful — that is the free tier's per-key minute budget");
  resetLlmLatency();
});

test("★ auto expansion: RE-DEDUPES against a concrete slot the operator also configured", () => {
  resetLlmLatency();
  // [auto, 3.1-flash-lite] naively expands to [3.5, 3.1, 3.1] — the duplicate would be a wasted
  // request on a model that just failed one line earlier.
  const out = llmExpandAutoAttempts([slot(LLM_AUTO_MODEL), slot(AUTO_2ND)]);
  assert.deepEqual(out.map((a) => a.model), [AUTO_1ST, AUTO_2ND]);
  resetLlmLatency();
});

test("auto expansion: two auto slots with the SAME key collapse (one slot already yields both)", () => {
  resetLlmLatency();
  const out = llmExpandAutoAttempts([slot(LLM_AUTO_MODEL), slot(LLM_AUTO_MODEL)]);
  assert.deepEqual(out.map((a) => a.model), [AUTO_1ST, AUTO_2ND],
    "the dedupe that used to LOSE the fallback is now harmless — expansion already supplied it");
  resetLlmLatency();
});

test("auto expansion: a CONCRETE route is passed through completely untouched", () => {
  resetLlmLatency();
  const route = [slot("gemini-2.5-flash-lite"), slot(AUTO_2ND, { keyId: "keyB" })];
  const out = llmExpandAutoAttempts(route);
  assert.deepEqual(out, route, "no auto slot ⇒ byte-identical behaviour to before this existed");
  assert.equal(out.some((a) => a.fromAuto), false);
  resetLlmLatency();
});

test("auto expansion: junk in the route is skipped, never crashes the call", () => {
  resetLlmLatency();
  assert.deepEqual(llmExpandAutoAttempts(null), []);
  assert.deepEqual(llmExpandAutoAttempts([null, undefined, "nope", 7]).length, 0);
  const out = llmExpandAutoAttempts([null, slot(LLM_AUTO_MODEL)]);
  assert.deepEqual(out.map((a) => a.model), [AUTO_1ST, AUTO_2ND]);
  resetLlmLatency();
});

test("auto expansion: a provider with NO candidate list expands to its single default model", () => {
  resetLlmLatency();
  const out = llmExpandAutoAttempts([{ provider: "anthropic", model: LLM_AUTO_MODEL, thinking: "off", effort: "", keyId: "" }]);
  assert.deepEqual(out.map((a) => a.model), [LLM_DEFAULT_MODELS.anthropic]);
  resetLlmLatency();
});

test("★ auto expansion: the HEALTHY case still costs ONE request — extra attempts are fallbacks only", async () => {
  resetLlmLatency();
  // act.llm's contract: it returns on the FIRST ok attempt, so a longer attempt list must not mean more
  // requests when the first model answers. Proven against callLLM directly, one fetch per successful call.
  let calls = 0;
  const okFetch = async () => { calls++; return { ok: true, status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: "Doctorate" }] } }] }), text: async () => "{}" }; };
  const attempts = llmExpandAutoAttempts([slot(LLM_AUTO_MODEL)]);
  assert.equal(attempts.length, 2, "two attempts available");
  const r = await callLLM({ provider: "gemini", model: attempts[0].model, apiKey: "k", user: "q" }, okFetch, async () => {});
  assert.equal(r.ok, true);
  assert.equal(calls, 1, "a working primary means exactly one request — the expansion is latent, not eager");
  resetLlmLatency();
});

test("fast-retry honours an explicit per-call timeout as the ceiling", () => {
  const cfg = { provider: "gemini", model: "gemini-3.1-flash-lite", timeoutMs: 500 };
  assert.equal(llmAttemptTimeoutMs(cfg, 2), 500, "never LENGTHEN a caller's own tighter deadline");
  assert.equal(llmAttemptTimeoutMs({ provider: "gemini", model: "gemini-3.1-flash-lite", fastRetry: false }, 2),
    LLM_REQUEST_TIMEOUT_MS, "callers can opt out");
});

// THE REGRESSION THIS EXISTS FOR. Rotation probes every key with `noRetry:true`, so the ladder length is
// 0 on the normal multi-key path. The first cut gated the cap on that ladder, so with 2+ keys configured
// it silently never fired — a live run with the cap forced to 50ms still answered in ~650ms. The fast-try
// budget is therefore independent of `noRetry`.
test("fast-retry fires on a noRetry ROTATION PROBE — the multi-key path, where it silently did not", async () => {
  resetLlmRetryState();
  let attempts = 0;
  const fetchImpl = async (url, opts) => {
    attempts++;
    if (attempts === 1) {
      return await new Promise((_r, rej) => {
        if (opts && opts.signal) opts.signal.addEventListener("abort", () => rej(new Error("aborted")));
      });
    }
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: "hi" }] } }] }) };
  };
  const r = await callLLMOnce(
    { provider: "gemini", model: "gemini-3.1-flash-lite", apiKey: "k", user: "q", noRetry: true },
    fetchImpl,
    async () => {}
  );
  assert.equal(r.ok, true, "the stuck probe recovered instead of reporting the key as failed");
  assert.equal(attempts, 2);
  assert.equal(r.fastAborts, 1);
  resetLlmRetryState();
});

test("fast-retry EXHAUSTED: a permanently stuck socket still gets one FULL-budget attempt", async () => {
  resetLlmRetryState();
  const budgets = [];
  const fetchImpl = async (url, opts) => {
    // Record the deadline each attempt was given, then hang until aborted.
    return await new Promise((_r, rej) => {
      if (opts && opts.signal) opts.signal.addEventListener("abort", () => rej(new Error("aborted")));
    });
  };
  const wrapped = async (url, opts) => { budgets.push(Date.now()); return fetchImpl(url, opts); };
  const r = await callLLMOnce(
    { provider: "gemini", model: "gemini-3.1-flash-lite", apiKey: "k", user: "q", noRetry: true, timeoutMs: 40 },
    wrapped,
    async () => {}
  );
  assert.equal(r.ok, false, "it still fails honestly rather than hanging forever");
  assert.equal(budgets.length, LLM_FAST_RETRY_ATTEMPTS + 1,
    "two fast tries, then ONE final attempt on the full budget — the safety net");
  resetLlmRetryState();
});

test("fast-retry: a gemini 3.1 call stuck past the cap is abandoned, re-issued, and SUCCEEDS", async () => {
  resetLlmRetryState();
  let attempts = 0;
  const slept = [];
  const fetchImpl = async (url, opts) => {
    attempts++;
    if (attempts === 1) {
      // the stuck socket: never resolves on its own, only the abort ends it
      return await new Promise((_r, rej) => {
        if (opts && opts.signal) opts.signal.addEventListener("abort", () => rej(new Error("aborted")));
      });
    }
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: "hi" }] } }] }) };
  };
  const r = await callLLM(
    { provider: "gemini", model: "gemini-3.1-flash-lite", apiKey: "k", user: "q" },
    fetchImpl,
    async (ms) => { slept.push(ms); }
  );
  assert.equal(r.ok, true);
  assert.equal(r.text, "hi");
  assert.equal(attempts, 2, "the stuck call was abandoned and re-issued");
  assert.equal(r.fastAborts, 1, "the recovery is reported, so it is not silent in the log");
  assert.equal(slept[0], LLM_FAST_RETRY_DELAY_MS,
    "a self-inflicted abort re-issues almost immediately — waiting the normal 2s backoff would defeat the cap");
  resetLlmRetryState();
});

test("fast-retry: a NON-matching model still waits the full budget and the normal backoff", async () => {
  resetLlmRetryState();
  let attempts = 0;
  const slept = [];
  const fetchImpl = async (url, opts) => {
    attempts++;
    if (attempts === 1) {
      return await new Promise((_r, rej) => {
        if (opts && opts.signal) opts.signal.addEventListener("abort", () => rej(new Error("aborted")));
      });
    }
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }) };
  };
  const r = await callLLM(
    { provider: "gemini", model: "gemini-2.5-flash-lite", apiKey: "k", user: "q", timeoutMs: 30 },
    fetchImpl,
    async (ms) => { slept.push(ms); }
  );
  assert.equal(r.ok, true);
  assert.equal(r.fastAborts, 0, "no fast abort — this model is not in the rule table");
  assert.equal(slept[0], LLM_RETRY_DELAYS_MS[0], "it took the ordinary backoff, not the fast one");
  resetLlmRetryState();
});
