// Unit tests for llm-keys.js — the rules that decide which of the operator's keys to
// try next and what a failure means for that key. These are the load-bearing decisions
// behind "when one key is used up, the next one takes over", so they're pinned here
// rather than discovered against a live provider.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  LLM_KEY_COOLDOWN, llmKeysFor, newLlmKeyState, orderLlmKeys,
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

test("a route with no model falls back to that provider's default", () => {
  const attempts = resolveLlmRoute({ provider: "gemini", routes: { teach: { provider: "anthropic" } } }, "teach", LLM_DEFAULT_MODELS);
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
