// Unit tests for llm.js — the multi-provider LLM adapter (AI-0). A FAKE fetch is
// injected (callLLM's 2nd arg) so no network: assert each provider builds the right
// request (url/headers/body) + parses its own response shape, and that every failure
// path returns a normalized { ok:false, error } (callLLM must NEVER throw — a thrown
// adapter would crash a fill).
const { test } = require("node:test");
const assert = require("node:assert");
const { callLLM, LLM_DEFAULT_MODELS, LLM_MODELS } = require("../llm.js");

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

test("LLM_DEFAULT_MODELS has a default per provider", () => {
  assert.ok(LLM_DEFAULT_MODELS.anthropic && LLM_DEFAULT_MODELS.gemini && LLM_DEFAULT_MODELS.openai);
});

test("LLM_MODELS: each provider has a non-empty list and the default is its FIRST entry (no drift)", () => {
  for (const p of ["anthropic", "gemini", "openai"]) {
    assert.ok(Array.isArray(LLM_MODELS[p]) && LLM_MODELS[p].length, `${p} has a model list`);
    assert.strictEqual(LLM_DEFAULT_MODELS[p], LLM_MODELS[p][0], `${p} default == first listed model`);
  }
});
