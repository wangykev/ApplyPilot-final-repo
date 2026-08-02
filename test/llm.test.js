// Unit tests for llm.js — the multi-provider LLM adapter (AI-0). A FAKE fetch is
// injected (callLLM's 2nd arg) so no network: assert each provider builds the right
// request (url/headers/body) + parses its own response shape, and that every failure
// path returns a normalized { ok:false, error } (callLLM must NEVER throw — a thrown
// adapter would crash a fill).
const { test } = require("node:test");
const assert = require("node:assert");
const { callLLM, LLM_DEFAULT_MODELS, LLM_MODELS, LLM_RETRY_DELAYS_MS ,
  resetLlmRetryState,
  llmRetryAfterMs,
  LLM_BREAKER_TRIP_AFTER,
  LLM_RETRY_AFTER_CAP_MS,
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
