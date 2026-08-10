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
