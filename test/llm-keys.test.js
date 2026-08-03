// Unit tests for llm-keys.js — the rules that decide which of the operator's keys to
// try next and what a failure means for that key. These are the load-bearing decisions
// behind "when one key is used up, the next one takes over", so they're pinned here
// rather than discovered against a live provider.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  LLM_KEY_COOLDOWN, LLM_ACTIONS, LLM_ACTION_ALIASES, llmKeysFor, newLlmKeyState, orderLlmKeys,
  classifyLlmFailure, applyLlmKeyOutcome, resolveLlmRoute
} = require("../llm-keys.js");
const { LLM_DEFAULT_MODELS, GEMINI_FREE_TIER, geminiFreeTierModels, isFreeTierModel, LLM_MODELS } = require("../llm.js");

const NOW = 1_800_000_000_000;
const key = (id, over) => Object.assign({ id, key: "secret-" + id, tier: "paid", enabled: true, label: "" }, over);

// ─── Config shapes (v1 compat) ──────────────────────────────────────────────

test("llmKeysFor reads the v2 per-provider key list", () => {
  const cfg = { provider: "gemini", keys: { gemini: [{ id: "a", key: "AIza-1" }, { id: "b", key: "AIza-2", tier: "free" }] } };
  const keys = llmKeysFor(cfg, "gemini");
  assert.deepEqual(keys.map((k) => k.id), ["a", "b"]);
  assert.equal(keys[0].tier, "paid"); // explicit default
  assert.equal(keys[1].tier, "free");
});

test("llmKeysFor still accepts the LEGACY single apiKey shape", () => {
  // A config synced before this change, or one written by the extension popup, must
  // keep working — otherwise the upgrade silently turns AI fill off.
  const v1 = { provider: "gemini", model: "gemini-3.1-flash-lite", apiKey: "AIza-legacy", enabled: true };
  const keys = llmKeysFor(v1, "gemini");
  assert.equal(keys.length, 1);
  assert.equal(keys[0].key, "AIza-legacy");
  // …and that key belongs to the flat provider only, never to a different one.
  assert.deepEqual(llmKeysFor(v1, "anthropic"), []);
});

test("llmKeysFor drops entries with no secret", () => {
  assert.deepEqual(llmKeysFor({ keys: { gemini: [{ id: "a", key: "" }, { id: "b" }] } }, "gemini"), []);
});

// ─── Rotation order ─────────────────────────────────────────────────────────

test("orderLlmKeys skips disabled, rejected, and cooling keys", () => {
  let state = newLlmKeyState();
  state = applyLlmKeyOutcome(state, "gemini", "bad", "auth", NOW);
  state = applyLlmKeyOutcome(state, "gemini", "hot", "rate_limit", NOW);
  const keys = [key("ok"), key("off", { enabled: false }), key("bad"), key("hot")];

  const res = orderLlmKeys(keys, { provider: "gemini" }, state, NOW);
  assert.deepEqual(res.keys.map((k) => k.id), ["ok"]);
  assert.deepEqual(res.skipped.map((s) => s.id + ":" + s.reason).sort(), ["bad:rejected", "hot:cooldown", "off:disabled"]);
});

test("orderLlmKeys spends FREE keys first, keeping row order inside a tier", () => {
  const keys = [key("p1"), key("f1", { tier: "free" }), key("p2"), key("f2", { tier: "free" })];
  assert.deepEqual(
    orderLlmKeys(keys, { provider: "gemini", preferFreeFirst: true }, newLlmKeyState(), NOW).keys.map((k) => k.id),
    ["f1", "f2", "p1", "p2"]
  );
  // Off → pure row order, so the operator can override the policy by ordering.
  assert.deepEqual(
    orderLlmKeys(keys, { provider: "gemini", preferFreeFirst: false }, newLlmKeyState(), NOW).keys.map((k) => k.id),
    ["p1", "f1", "p2", "f2"]
  );
});

test("orderLlmKeys reports when the first cooling key returns", () => {
  let state = newLlmKeyState();
  state = applyLlmKeyOutcome(state, "gemini", "a", "quota", NOW);       // long
  state = applyLlmKeyOutcome(state, "gemini", "b", "rate_limit", NOW);  // short
  const res = orderLlmKeys([key("a"), key("b")], { provider: "gemini" }, state, NOW);
  assert.deepEqual(res.keys, []);
  assert.equal(res.nextAvailableAt, NOW + LLM_KEY_COOLDOWN.RATE_LIMIT_MS);
});

test("orderLlmKeys keeps state per provider — same key id, different provider", () => {
  let state = newLlmKeyState();
  state = applyLlmKeyOutcome(state, "gemini", "k1", "auth", NOW);
  assert.deepEqual(orderLlmKeys([key("k1")], { provider: "gemini" }, state, NOW).keys, []);
  assert.equal(orderLlmKeys([key("k1")], { provider: "openai" }, state, NOW).keys.length, 1);
});

// ─── Failure classification ─────────────────────────────────────────────────

test("401/403 is the key's fault and rotates", () => {
  for (const status of [401, 403]) {
    assert.deepEqual(classifyLlmFailure({ status, body: "nope" }), { code: "auth", rotate: true, keyFault: true });
  }
});

test("Gemini's 400 'API key not valid' is auth, not a payload bug", () => {
  // Gemini rejects a bad key with 400 INVALID_ARGUMENT. Read as bad_request it would
  // NOT rotate, stranding the run on a dead key while the operator's others sit unused.
  const v = classifyLlmFailure({ status: 400, body: { error: { message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } } });
  assert.deepEqual(v, { code: "auth", rotate: true, keyFault: true });
});

test("Anthropic's 400 'credit balance is too low' is spent quota, and rotates", () => {
  const v = classifyLlmFailure({ status: 400, body: { error: { message: "Your credit balance is too low to access the API." } } });
  assert.deepEqual(v, { code: "quota", rotate: true, keyFault: true });
});

test("an ordinary 400 does NOT rotate — every key would fail identically", () => {
  const v = classifyLlmFailure({ status: 400, body: { error: { message: "Unknown name \"foo\": Cannot find field." } } });
  assert.deepEqual(v, { code: "bad_request", rotate: false, keyFault: false });
});

test("429 separates per-minute limiting from a spent balance", () => {
  // Gemini's free tier says RESOURCE_EXHAUSTED for ordinary rate limiting, so that
  // alone must earn the SHORT cooldown — the key works again within a minute.
  assert.equal(classifyLlmFailure({ status: 429, body: { error: { status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for quota metric" } } }).code, "rate_limit");
  assert.equal(classifyLlmFailure({ status: 429, body: { error: { type: "insufficient_quota", message: "You exceeded your current quota" } } }).code, "quota");
  assert.equal(classifyLlmFailure({ status: 402, body: "" }).code, "quota");
});

test("a 5xx or a network throw is the PROVIDER down — rotation buys nothing", () => {
  // Another key reaches the same dead endpoint. Rotating would just burn the whole key
  // list on one outage; llm.js's wait ladder is the right tool here.
  for (const status of [500, 502, 503, 529]) {
    assert.deepEqual(classifyLlmFailure({ status, body: "overloaded" }), { code: "provider_down", rotate: false, keyFault: false });
  }
  assert.deepEqual(classifyLlmFailure({ networkError: "fetch failed" }), { code: "provider_down", rotate: false, keyFault: false });
});

// ─── Outcome folding ────────────────────────────────────────────────────────

test("auth marks a key rejected; a cooldown would be pointless", () => {
  const state = applyLlmKeyOutcome(newLlmKeyState(), "gemini", "k1", "auth", NOW);
  assert.equal(state.keys["gemini/k1"].invalid, true);
  assert.equal(state.keys["gemini/k1"].cooldownUntil, 0);
});

test("spent quota rests far longer than a rate limit, and Retry-After wins", () => {
  const q = applyLlmKeyOutcome(newLlmKeyState(), "gemini", "k", "quota", NOW);
  const r = applyLlmKeyOutcome(newLlmKeyState(), "gemini", "k", "rate_limit", NOW);
  assert.equal(q.keys["gemini/k"].cooldownUntil, NOW + LLM_KEY_COOLDOWN.QUOTA_MS);
  assert.equal(r.keys["gemini/k"].cooldownUntil, NOW + LLM_KEY_COOLDOWN.RATE_LIMIT_MS);
  assert.ok(q.keys["gemini/k"].cooldownUntil > r.keys["gemini/k"].cooldownUntil);
  const advised = applyLlmKeyOutcome(newLlmKeyState(), "gemini", "k", "rate_limit", NOW, 5000);
  assert.equal(advised.keys["gemini/k"].cooldownUntil, NOW + 5000);
});

test("a provider outage leaves the key untouched, and ok clears it", () => {
  const down = applyLlmKeyOutcome(newLlmKeyState(), "gemini", "k", "provider_down", NOW);
  assert.equal(down.keys["gemini/k"], undefined);
  const hot = applyLlmKeyOutcome(newLlmKeyState(), "gemini", "k", "rate_limit", NOW);
  assert.equal(applyLlmKeyOutcome(hot, "gemini", "k", "ok", NOW).keys["gemini/k"], undefined);
});

test("applyLlmKeyOutcome does not mutate the state it was given", () => {
  const before = newLlmKeyState();
  applyLlmKeyOutcome(before, "gemini", "k", "auth", NOW);
  assert.deepEqual(before.keys, {});
});

// ─── Routing + fallback chains ──────────────────────────────────────────────

test("an action's own model wins, then its chain, then the default and its chain", () => {
  const cfg = {
    provider: "gemini", model: "gemini-3.1-flash-lite",
    fallbacks: [{ provider: "openai", model: "gpt-4o-mini" }],
    routes: {
      cover_letter: {
        provider: "anthropic", model: "claude-opus-4-8",
        fallbacks: [{ provider: "anthropic", model: "claude-sonnet-4-6" }]
      }
    }
  };
  assert.deepEqual(
    resolveLlmRoute(cfg, "cover_letter", LLM_DEFAULT_MODELS).map((a) => a.provider + "/" + a.model + ":" + a.source),
    [
      "anthropic/claude-opus-4-8:action",
      "anthropic/claude-sonnet-4-6:action-fallback",
      "gemini/gemini-3.1-flash-lite:default",
      "openai/gpt-4o-mini:default-fallback"
    ]
  );
});

test("an unrouted action just uses the default pair and chain", () => {
  const cfg = { provider: "gemini", model: "gemini-3.1-flash-lite", fallbacks: [{ provider: "gemini", model: "gemini-2.5-flash-lite" }] };
  assert.deepEqual(
    resolveLlmRoute(cfg, "fill", LLM_DEFAULT_MODELS).map((a) => a.model),
    ["gemini-3.1-flash-lite", "gemini-2.5-flash-lite"]
  );
});

test("a free-Gemini chain can hop MODEL then PROVIDER", () => {
  // The point of a model hop: requests-per-day is metered PER MODEL, so the same free
  // key still has allowance on the next one.
  const cfg = {
    provider: "gemini", model: "gemini-3.1-flash-lite",
    fallbacks: [{ provider: "gemini", model: "gemini-2.5-flash-lite" }, { provider: "anthropic", model: "claude-sonnet-4-6" }]
  };
  assert.deepEqual(resolveLlmRoute(cfg, "fill", LLM_DEFAULT_MODELS).map((a) => a.provider + "/" + a.model), [
    "gemini/gemini-3.1-flash-lite",
    "gemini/gemini-2.5-flash-lite",
    "anthropic/claude-sonnet-4-6"
  ]);
});

test("teach RIDES fill's route — including fill's own override, not the global default", () => {
  // teach is an alias, so setting a model for the fill sets it for teach too. Without the
  // alias, teach would be an unknown action and fall to the DEFAULT pair — quietly using a
  // different model from the fill it is meant to mirror.
  const cfg = {
    provider: "openai", model: "gpt-4o",                                  // the global default
    routes: { fill: { provider: "gemini", model: "gemini-2.5-flash-lite", fallbacks: [{ provider: "anthropic", model: "claude-sonnet-4-6" }] } }
  };
  assert.deepEqual(
    resolveLlmRoute(cfg, "teach", LLM_DEFAULT_MODELS).map((a) => a.provider + "/" + a.model),
    ["gemini/gemini-2.5-flash-lite", "anthropic/claude-sonnet-4-6", "openai/gpt-4o"]
  );
  // …and identical to what the fill itself resolves to.
  assert.deepEqual(resolveLlmRoute(cfg, "teach", LLM_DEFAULT_MODELS), resolveLlmRoute(cfg, "fill", LLM_DEFAULT_MODELS));
});

test("the action catalog is fill / essay / resume_parse / cover_letter, and teach is an alias", () => {
  // fill vs essay is the distinction the operator actually cares about: dozens of short
  // answers per application versus a couple of paragraphs.
  assert.deepEqual(LLM_ACTIONS, ["fill", "essay", "resume_parse", "cover_letter"]);
  assert.equal(LLM_ACTION_ALIASES.teach, "fill");
  assert.equal(LLM_ACTIONS.includes("teach"), false, "teach must not be a routable row");
});

test("essay routes independently of fill", () => {
  const cfg = {
    provider: "gemini", model: "gemini-3.1-flash-lite",
    routes: { essay: { provider: "anthropic", model: "claude-opus-4-8", fallbacks: [] } }
  };
  assert.equal(resolveLlmRoute(cfg, "essay", LLM_DEFAULT_MODELS)[0].model, "claude-opus-4-8");
  assert.equal(resolveLlmRoute(cfg, "fill", LLM_DEFAULT_MODELS)[0].model, "gemini-3.1-flash-lite");
});

test("a route with no model falls back to that provider's default", () => {
  const attempts = resolveLlmRoute({ provider: "gemini", routes: { essay: { provider: "anthropic" } } }, "essay", LLM_DEFAULT_MODELS);
  assert.equal(attempts[0].model, LLM_DEFAULT_MODELS.anthropic);
});

test("duplicate pairs collapse so no attempt is made twice", () => {
  const cfg = { provider: "gemini", model: "gemini-3.1-flash-lite", routes: { fill: { provider: "gemini", model: "gemini-3.1-flash-lite" } } };
  assert.equal(resolveLlmRoute(cfg, "fill", LLM_DEFAULT_MODELS).length, 1);
});

// ─── Free tier ──────────────────────────────────────────────────────────────

test("the free tier is Gemini-only and excludes the pro model", () => {
  assert.ok(isFreeTierModel("gemini", "gemini-3.1-flash-lite"));
  // Offering 2.5-pro to a free key would fail every request with a quota error.
  assert.equal(isFreeTierModel("gemini", "gemini-2.5-pro"), false);
  assert.equal(isFreeTierModel("anthropic", "claude-sonnet-4-6"), false);
});

test("every free-tier model is a real, offerable Gemini model", () => {
  for (const m of geminiFreeTierModels()) {
    assert.ok(LLM_MODELS.gemini.includes(m), `${m} is in the free-tier table but not in LLM_MODELS.gemini`);
    const l = GEMINI_FREE_TIER[m];
    assert.ok(l.rpm > 0 && l.tpm > 0 && l.rpd > 0, `${m} needs real limits`);
  }
});

test("the default Gemini model is on the free tier", () => {
  // A first-time free-key operator must not land on a model their key can't reach.
  assert.ok(isFreeTierModel("gemini", LLM_DEFAULT_MODELS.gemini));
});

// ─── Rotation through callLLM ───────────────────────────────────────────────
// The behaviour the key list exists for. The load-bearing assertion in most of these is
// `waits` — rotating to the next key must cost ZERO waiting, because the alternative
// (llm.js's ladder) sits out ~75s on a 429.

const { callLLM, resetLlmRetryState } = require("../llm.js");

function harness(responses) {
  const calls = [];
  const waits = [];
  const queue = responses.slice();
  const fetchImpl = async (url, opts) => {
    const headers = opts && opts.headers ? opts.headers : {};
    calls.push({ url, key: headers["x-api-key"] || headers.Authorization || (String(url).match(/key=([^&]+)/) || [])[1] || "" });
    const next = queue.shift();
    if (!next) throw new Error("unexpected fetch #" + calls.length);
    if (next.throw) throw new Error(next.throw);
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.json,
      text: async () => (typeof next.body === "string" ? next.body : JSON.stringify(next.body || "")),
      headers: { get: (h) => (next.headers || {})[String(h).toLowerCase()] || null }
    };
  };
  return { calls, waits, fetchImpl, sleepImpl: async (ms) => { waits.push(ms); } };
}

const geminiOk = (text) => ({ status: 200, json: { candidates: [{ content: { parts: [{ text }] } }] } });
const twoKeys = [
  { id: "k1", key: "AIza-one", tier: "free", enabled: true },
  { id: "k2", key: "AIza-two", tier: "free", enabled: true }
];
const req = (over) => Object.assign({ provider: "gemini", model: "gemini-3.1-flash-lite", user: "hi", keys: twoKeys }, over);

test("rotation: a rate-limited key hands off to the next WITHOUT waiting", () => {
  resetLlmRetryState();
  const h = harness([{ status: 429, body: { error: { status: "RESOURCE_EXHAUSTED" } } }, geminiOk("second key answered")]);
  return callLLM(req(), h.fetchImpl, h.sleepImpl).then((res) => {
    assert.equal(res.ok, true);
    assert.equal(res.text, "second key answered");
    assert.equal(h.calls.length, 2);
    assert.ok(h.calls[0].key.includes("one") && h.calls[1].key.includes("two"), "should have moved to the second key");
    assert.deepEqual(h.waits, [], "rotating must not spend a single wait — that is the entire point");
  });
});

test("rotation: a rejected key is parked in the returned state, so the next call skips it", async () => {
  resetLlmRetryState();
  let saved = null;
  const h = harness([{ status: 400, body: { error: { message: "API key not valid. Please pass a valid API key." } } }, geminiOk("ok")]);
  const res = await callLLM(req({ onKeyState: (s) => { saved = s; } }), h.fetchImpl, h.sleepImpl);
  assert.equal(res.ok, true);
  assert.equal(saved.keys["gemini/k1"].invalid, true);
  assert.deepEqual(h.waits, []);

  // Second call with that state: k1 is skipped entirely — one fetch, on k2.
  const h2 = harness([geminiOk("straight to k2")]);
  const res2 = await callLLM(req({ keyState: saved }), h2.fetchImpl, h2.sleepImpl);
  assert.equal(res2.ok, true);
  assert.equal(h2.calls.length, 1);
  assert.ok(h2.calls[0].key.includes("two"));
});

test("rotation: every key spent → one cheap probe each, no ladder, and the error says so", async () => {
  resetLlmRetryState();
  const h = harness([
    { status: 429, body: { error: { status: "RESOURCE_EXHAUSTED" } } },
    { status: 429, body: { error: { status: "RESOURCE_EXHAUSTED" } } }
  ]);
  const res = await callLLM(req(), h.fetchImpl, h.sleepImpl);
  assert.equal(res.ok, false);
  assert.match(res.error, /all 2 gemini keys are spent/);
  assert.match(res.error, /frees up in ~\d+s/, "should say when a key returns");
  assert.equal(h.calls.length, 2, "one attempt per key, never a ladder per key");
  assert.deepEqual(h.waits, []);
});

test("rotation: a 5xx does NOT burn the key list — the provider is down, so the ladder runs", async () => {
  resetLlmRetryState();
  // Probe k1 → 503 (provider_down, no rotate) → hand k1 to the full ladder, which
  // recovers on its first wait. k2 is never touched: it would hit the same dead endpoint.
  const h = harness([{ status: 503, body: "overloaded" }, { status: 503, body: "overloaded" }, geminiOk("recovered")]);
  const res = await callLLM(req(), h.fetchImpl, h.sleepImpl);
  assert.equal(res.ok, true);
  assert.equal(res.text, "recovered");
  assert.ok(h.waits.length >= 1, "an outage still gets the wait ladder it always had");
  assert.ok(h.calls.every((c) => c.key.includes("one")), "must not rotate on a provider outage");
});

test("rotation: a malformed request stops at the first key", async () => {
  resetLlmRetryState();
  const h = harness([{ status: 400, body: { error: { message: 'Unknown name "foo": Cannot find field.' } } }]);
  const res = await callLLM(req(), h.fetchImpl, h.sleepImpl);
  assert.equal(res.ok, false);
  assert.equal(h.calls.length, 1, "every other key would fail identically");
  assert.deepEqual(h.waits, []);
});

test("rotation: free keys are tried before paid ones", async () => {
  resetLlmRetryState();
  const keys = [
    { id: "paid", key: "AIza-paid", tier: "paid", enabled: true },
    { id: "free", key: "AIza-free", tier: "free", enabled: true }
  ];
  const h = harness([geminiOk("free first")]);
  await callLLM(req({ keys }), h.fetchImpl, h.sleepImpl);
  assert.ok(h.calls[0].key.includes("free"), "the free key should be spent first");
});

test("rotation: Retry-After parks the key for exactly as long as the server asked", async () => {
  resetLlmRetryState();
  let saved = null;
  const h = harness([{ status: 429, body: "slow down", headers: { "retry-after": "5" } }, geminiOk("ok")]);
  await callLLM(req({ onKeyState: (s) => { saved = s; } }), h.fetchImpl, h.sleepImpl);
  const until = saved.keys["gemini/k1"].cooldownUntil - Date.now();
  assert.ok(until > 0 && until <= 5000, `cooldown should honour Retry-After: 5 (got ${until}ms)`);
});

test("rotation: one usable key still gets the full ladder — nothing to rotate to", async () => {
  resetLlmRetryState();
  const h = harness([{ status: 503, body: "x" }, geminiOk("ok")]);
  const res = await callLLM(req({ keys: [twoKeys[0]] }), h.fetchImpl, h.sleepImpl);
  assert.equal(res.ok, true);
  assert.ok(h.waits.length >= 1, "with a single key, waiting IS the remedy");
});

test("rotation: no usable key names the reason instead of calling out", async () => {
  resetLlmRetryState();
  const h = harness([]);
  const res = await callLLM(req({ keys: [{ id: "off", key: "AIza-x", tier: "free", enabled: false }] }), h.fetchImpl, h.sleepImpl);
  assert.equal(res.ok, false);
  assert.match(res.error, /no usable API key for gemini/);
  assert.equal(h.calls.length, 0);
});

test("a caller still passing a bare apiKey is untouched by any of this", async () => {
  resetLlmRetryState();
  const h = harness([geminiOk("legacy path")]);
  const res = await callLLM({ provider: "gemini", model: "gemini-3.1-flash-lite", apiKey: "AIza-legacy", user: "hi" }, h.fetchImpl, h.sleepImpl);
  assert.equal(res.ok, true);
  assert.equal(res.text, "legacy path");
  assert.equal(h.calls.length, 1);
});

// ─── Claude 5: thinking must be off for short-answer fills ──────────────────

test("Claude 5 requests disable thinking; older Claude models don't get the parameter", async () => {
  // On Opus 5 / Sonnet 5 thinking is ON by default and max_tokens caps thinking PLUS the
  // answer — so a 24-token yes/no fill would return an EMPTY reply, looking like a broken
  // model. Older models must NOT receive the parameter at all: a `disabled` block isn't
  // accepted everywhere (Haiku 4.5 predates this shape), and a 400 there is a dead key.
  const bodyFor = async (model) => {
    let sent = null;
    const fetchImpl = async (_url, opts) => {
      sent = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "OK" }] }), headers: { get: () => null } };
    };
    const res = await callLLM({ provider: "anthropic", model, apiKey: "sk-ant-x", user: "hi", maxTokens: 24 }, fetchImpl);
    assert.equal(res.ok, true);
    return sent;
  };

  for (const model of ["claude-opus-5", "claude-sonnet-5"]) {
    assert.deepEqual((await bodyFor(model)).thinking, { type: "disabled" }, `${model} must disable thinking`);
  }
  for (const model of ["claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5-20251001"]) {
    assert.equal("thinking" in (await bodyFor(model)), false, `${model} must not receive a thinking block`);
  }
});

test("the Anthropic list leads with a current-generation model", () => {
  // First entry = the default (LLM_DEFAULT_MODELS), so it must not be a previous generation.
  assert.equal(LLM_MODELS.anthropic[0], "claude-sonnet-5");
  assert.ok(LLM_MODELS.anthropic.includes("claude-opus-5"));
});

// ─── Thinking: off / adaptive / manual ──────────────────────────────────────

test("thinking modes send the right Anthropic parameters", async () => {
  const bodyFor = async (model, thinking, effort) => {
    let sent = null;
    const fetchImpl = async (_u, opts) => {
      sent = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "OK" }] }), headers: { get: () => null } };
    };
    const r = await callLLM({ provider: "anthropic", model, apiKey: "sk-ant-x", user: "hi", maxTokens: 24, thinking, effort }, fetchImpl);
    assert.equal(r.ok, true);
    return sent;
  };

  // OFF on a Claude 5 model must explicitly disable (it thinks by default) and must NOT
  // pin an effort — on Opus 5 a disabled block is only accepted at effort <= high.
  const off = await bodyFor("claude-opus-5", "off");
  assert.deepEqual(off.thinking, { type: "disabled" });
  assert.equal(off.output_config, undefined);
  assert.equal(off.max_tokens, 24, "off keeps the caller's small budget");

  // ADAPTIVE: thinking on, no effort pinned, and max_tokens floored so reasoning can't
  // consume the whole 24-token allowance and return an empty answer.
  const adaptive = await bodyFor("claude-opus-5", "adaptive");
  assert.deepEqual(adaptive.thinking, { type: "adaptive" });
  assert.equal(adaptive.output_config, undefined);
  assert.ok(adaptive.max_tokens >= 4096);

  // MANUAL: adaptive PLUS an effort in output_config (not top-level), with a floor that
  // scales — a deeper level needs more room before the answer gets truncated.
  const manualMax = await bodyFor("claude-opus-5", "manual", "max");
  assert.deepEqual(manualMax.thinking, { type: "adaptive" });
  assert.deepEqual(manualMax.output_config, { effort: "max" });
  assert.ok(manualMax.max_tokens > (await bodyFor("claude-opus-5", "manual", "low")).max_tokens);

  // An effort the model does not accept is DROPPED, never sent: xhigh arrived with Opus
  // 4.7, so Sonnet 4.6 would reject it.
  const bad = await bodyFor("claude-sonnet-4-6", "manual", "xhigh");
  assert.equal(bad.output_config, undefined, "an unsupported effort must not be sent");
  assert.deepEqual(bad.thinking, { type: "adaptive" }, "…but thinking still turns on");

  // A model that predates the parameter shape gets neither field.
  const haiku = await bodyFor("claude-haiku-4-5-20251001", "manual", "high");
  assert.equal("thinking" in haiku, false);
  assert.equal(haiku.output_config, undefined);
});

test("manual effort rides the route through resolveLlmRoute", () => {
  const cfg = { provider: "anthropic", model: "claude-opus-5", thinking: "manual", effort: "high" };
  const a = resolveLlmRoute(cfg, "essay", LLM_DEFAULT_MODELS)[0];
  assert.equal(a.thinking, "manual");
  assert.equal(a.effort, "high");
  // off/adaptive never carry an effort, so a stale value can't leak into a request.
  assert.equal(resolveLlmRoute({ ...cfg, thinking: "adaptive" }, "essay", LLM_DEFAULT_MODELS)[0].effort, "");
  assert.equal(resolveLlmRoute({ ...cfg, thinking: "off" }, "essay", LLM_DEFAULT_MODELS)[0].effort, "");
});

// ─── Usage + cost: the foundation of the spend/quota tracker ─────────────────

const { llmCostUsd } = require("../llm.js");

test("token usage is extracted from all three provider shapes", async () => {
  const run = async (provider, model, json) => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => json, headers: { get: () => null } });
    return await callLLM({ provider, model, apiKey: "k", user: "hi", thinking: "off" }, fetchImpl);
  };

  const a = await run("anthropic", "claude-opus-5", { content: [{ type: "text", text: "hi" }], usage: { input_tokens: 120, output_tokens: 34 } });
  assert.deepEqual(a.usage, { input: 120, output: 34 });

  // Gemini reports thinking tokens SEPARATELY from candidates, but bills them as output —
  // omitting them would make a thinking call look cheaper than it was.
  const g = await run("gemini", "gemini-3.5-flash-lite", {
    candidates: [{ content: { parts: [{ text: "hi" }] } }],
    usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 10, thoughtsTokenCount: 40 }
  });
  assert.deepEqual(g.usage, { input: 90, output: 50 });

  const o = await run("openai", "gpt-4o", { choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 7, completion_tokens: 3 } });
  assert.deepEqual(o.usage, { input: 7, output: 3 });

  // A response with no usage block must not throw or poison the answer.
  const bare = await run("openai", "gpt-4o", { choices: [{ message: { content: "hi" } }] });
  assert.equal(bare.ok, true);
  assert.deepEqual(bare.usage, { input: 0, output: 0 });
});

test("a successful call reports WHICH key served it, and on which tier", async () => {
  // A spend tracker can't attribute a call, or know it was free, without both.
  const keys = [
    { id: "free1", key: "AIza-free", tier: "free", enabled: true },
    { id: "paid1", key: "AIza-paid", tier: "paid", enabled: true }
  ];
  let n = 0;
  const fetchImpl = async () => {
    n++;
    if (n === 1) return { ok: false, status: 429, text: async () => "slow down", json: async () => ({}), headers: { get: () => null } };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: "hi" }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } }), headers: { get: () => null } };
  };
  const res = await callLLM({ provider: "gemini", model: "gemini-3.5-flash-lite", user: "hi", keys }, fetchImpl, async () => {});
  assert.equal(res.ok, true);
  assert.equal(res.keyId, "paid1", "the key that actually answered, not the first one tried");
  assert.equal(res.keyTier, "paid");
});

test("cost is 0 for a free-tier call, a real number when priced, and NULL when unknown", () => {
  const u = { input: 1_000_000, output: 1_000_000 };

  // A free Gemini key genuinely costs nothing — that is the point of the tier flag, and the
  // model id alone can't tell you, so the tier has to be passed in.
  assert.equal(llmCostUsd("gemini-3.5-flash-lite", u, "free"), 0);

  // Priced model: $5 in + $25 out per 1M.
  assert.equal(llmCostUsd("claude-opus-5", u, "paid"), 30);
  assert.equal(llmCostUsd("claude-haiku-4-5-20251001", { input: 2_000_000, output: 0 }, "paid"), 2);

  // UNKNOWN, not zero. Reporting an unpriced model as free would silently under-report
  // spend, which is worse than admitting the rate isn't known.
  assert.equal(llmCostUsd("gemini-2.5-pro", u, "paid"), null);
  assert.equal(llmCostUsd("gpt-4o", u, "paid"), null);

  // A paid-tier call on a free-tier MODEL still costs money, so it must not shortcut to 0.
  assert.equal(llmCostUsd("gemini-3.5-flash-lite", u, "paid"), null);
});
