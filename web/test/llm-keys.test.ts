import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  LLM_KEY_COOLDOWN, LLM_ACTIONS, llmKeysFor, newLlmKeyState, orderLlmKeys,
  classifyLlmFailure, applyLlmKeyOutcome, resolveLlmRoute, LLM_ACTION_ALIASES, type LlmKey,
} from "../lib/llm-keys";
import {
  LLM_DEFAULT_MODELS, LLM_MODELS, GEMINI_FREE_TIER, geminiFreeTierModels, isFreeTierModel, LLM_PRICING,
  LLM_MODEL_META, GEMINI_STARTER_CHAIN,
} from "../lib/llm";

// The extension's copies. llm-keys.ts is a LOCKSTEP dup of llm-keys.js and llm.ts of
// llm.js: the website decides the operator's key list and routing, the extension EXECUTES
// it, and a drift means the two disagree about which key to try or which models a free
// Gemini key can reach — invisible until a fill silently stops using half the keys.
// Loading the real files makes that drift a TEST FAILURE, not a production surprise.
const require_ = createRequire(import.meta.url);
const extKeys = require_("../../llm-keys.js");
const extLlm = require_("../../llm.js");

const NOW = 1_800_000_000_000;
const key = (id: string, over?: Partial<LlmKey>): LlmKey =>
  ({ id, key: "secret-" + id, tier: "paid", enabled: true, label: "", ...over }) as LlmKey;

// ─── Lockstep: the two copies must agree ────────────────────────────────────

test("LOCKSTEP — classifyLlmFailure agrees across both copies", () => {
  const cases: Array<{ status?: number; body?: unknown; networkError?: unknown }> = [
    { status: 401, body: "no" },
    { status: 403, body: "no" },
    { status: 400, body: { error: { message: "API key not valid. Please pass a valid API key." } } },
    { status: 400, body: { error: { message: "Your credit balance is too low to access the API." } } },
    { status: 400, body: { error: { message: 'Unknown name "foo"' } } },
    { status: 422, body: "unprocessable" },
    { status: 404, body: "model not found" },
    { status: 402, body: "" },
    { status: 429, body: { error: { status: "RESOURCE_EXHAUSTED" } } },
    { status: 429, body: { error: { type: "insufficient_quota" } } },
    { status: 500, body: "boom" },
    { status: 503, body: "overloaded" },
    { status: 529, body: "overloaded" },
    { networkError: "fetch failed" },
    { status: 418, body: "teapot" },
  ];
  for (const c of cases) {
    assert.deepEqual(classifyLlmFailure(c), extKeys.classifyLlmFailure(c), `disagreement on ${JSON.stringify(c)}`);
  }
});

test("LOCKSTEP — orderLlmKeys agrees across both copies", () => {
  const keys = [key("p1"), key("f1", { tier: "free" }), key("off", { enabled: false }), key("p2"), key("f2", { tier: "free" })];
  for (const preferFreeFirst of [true, false]) {
    const mine = orderLlmKeys(keys, { provider: "gemini", preferFreeFirst }, newLlmKeyState(), NOW);
    const theirs = extKeys.orderLlmKeys(keys, { provider: "gemini", preferFreeFirst }, extKeys.newLlmKeyState(), NOW);
    assert.deepEqual(mine.keys.map((k) => k.id), theirs.keys.map((k: LlmKey) => k.id));
    assert.deepEqual(mine.skipped, theirs.skipped);
  }
  // …including once state has accumulated.
  let a = newLlmKeyState();
  let b = extKeys.newLlmKeyState();
  a = applyLlmKeyOutcome(a, "gemini", "f1", "rate_limit", NOW);
  b = extKeys.applyLlmKeyOutcome(b, "gemini", "f1", "rate_limit", NOW);
  assert.deepEqual(a, b);
  assert.deepEqual(
    orderLlmKeys(keys, { provider: "gemini" }, a, NOW).keys.map((k) => k.id),
    extKeys.orderLlmKeys(keys, { provider: "gemini" }, b, NOW).keys.map((k: LlmKey) => k.id)
  );
});

test("LOCKSTEP — resolveLlmRoute agrees across both copies", () => {
  const configs: unknown[] = [
    { provider: "gemini", model: "gemini-3.1-flash-lite" },
    { provider: "gemini", model: "gemini-3.1-flash-lite", fallbacks: [{ provider: "gemini", model: "gemini-2.5-flash-lite" }, { provider: "anthropic", model: "claude-sonnet-4-6" }] },
    { provider: "gemini", routes: { essay: { provider: "anthropic" } } },
    // teach is an alias for fill — both copies must agree it rides fill's route.
    { provider: "openai", model: "gpt-4o", routes: { fill: { provider: "gemini", model: "gemini-2.5-flash-lite" } } },
    { provider: "gemini", model: "x", routes: { cover_letter: { provider: "anthropic", model: "claude-opus-4-8", fallbacks: [{ provider: "openai", model: "gpt-4o" }] } } },
    {},
  ];
  for (const cfg of configs) {
    for (const action of [...LLM_ACTIONS, "unknown_action"]) {
      assert.deepEqual(
        resolveLlmRoute(cfg, action, LLM_DEFAULT_MODELS),
        extKeys.resolveLlmRoute(cfg, action, extLlm.LLM_DEFAULT_MODELS),
        `disagreement on ${action} / ${JSON.stringify(cfg)}`
      );
    }
  }
});

test("LOCKSTEP — llmKeysFor agrees, including the legacy single-key shape", () => {
  const configs: unknown[] = [
    { provider: "gemini", model: "m", apiKey: "AIza-legacy" },
    { provider: "gemini", keys: { gemini: [{ id: "a", key: "AIza-1", tier: "free" }, { id: "b", key: "" }] } },
    { provider: "anthropic", apiKey: "sk-ant" },
    {},
  ];
  for (const cfg of configs) {
    for (const p of ["gemini", "anthropic", "openai"]) {
      assert.deepEqual(llmKeysFor(cfg, p), extKeys.llmKeysFor(cfg, p), `disagreement on ${p} / ${JSON.stringify(cfg)}`);
    }
  }
});

test("LOCKSTEP — the model catalog, free tier, and pricing match the extension", () => {
  assert.deepEqual(LLM_MODELS, extLlm.LLM_MODELS);
  assert.deepEqual(LLM_DEFAULT_MODELS, extLlm.LLM_DEFAULT_MODELS);
  assert.deepEqual(GEMINI_FREE_TIER, extLlm.GEMINI_FREE_TIER);
  assert.deepEqual(LLM_PRICING, extLlm.LLM_PRICING);
  assert.deepEqual(LLM_MODEL_META, extLlm.LLM_MODEL_META);
  assert.deepEqual({ ...GEMINI_STARTER_CHAIN }, extLlm.GEMINI_STARTER_CHAIN);
  assert.deepEqual(geminiFreeTierModels(), extLlm.geminiFreeTierModels());
  assert.deepEqual(LLM_KEY_COOLDOWN, extKeys.LLM_KEY_COOLDOWN);
  assert.deepEqual([...LLM_ACTIONS], extKeys.LLM_ACTIONS);
  assert.deepEqual(LLM_ACTION_ALIASES, extKeys.LLM_ACTION_ALIASES);
});

// ─── The port's own behaviour ───────────────────────────────────────────────

test("a legacy v1 config keeps working after the upgrade", () => {
  const v1 = { provider: "gemini", model: "gemini-3.1-flash-lite", apiKey: "AIza-legacy", enabled: true };
  assert.equal(llmKeysFor(v1, "gemini").length, 1);
  assert.deepEqual(llmKeysFor(v1, "openai"), []);
  assert.equal(resolveLlmRoute(v1, "fill", LLM_DEFAULT_MODELS)[0].model, "gemini-3.1-flash-lite");
});

test("free keys are tried before paid ones", () => {
  const keys = [key("paid"), key("free", { tier: "free" })];
  assert.deepEqual(orderLlmKeys(keys, { provider: "gemini" }, newLlmKeyState(), NOW).keys.map((k) => k.id), ["free", "paid"]);
});

test("a rejected key stays out until it is replaced", () => {
  const state = applyLlmKeyOutcome(newLlmKeyState(), "gemini", "k1", "auth", NOW);
  // Far in the future — a rejection has no timer, unlike a rate limit.
  assert.deepEqual(orderLlmKeys([key("k1")], { provider: "gemini" }, state, NOW + 86_400_000).keys, []);
});

test("only Gemini has a free tier, and 2.5-pro is not in it", () => {
  assert.ok(isFreeTierModel("gemini", "gemini-3.1-flash-lite"));
  assert.equal(isFreeTierModel("gemini", "gemini-2.5-pro"), false);
  assert.equal(isFreeTierModel("anthropic", "claude-sonnet-4-6"), false);
  assert.equal(isFreeTierModel("openai", "gpt-4o"), false);
});

test("every offerable model has a human label and a role — no raw ids in the picker", () => {
  // A model in LLM_MODELS but missing from LLM_MODEL_META would render as its bare id
  // ("claude-haiku-4-5-20251001"), which is exactly the unclear dropdown this replaced.
  for (const [provider, models] of Object.entries(LLM_MODELS)) {
    for (const m of models) {
      const meta = LLM_MODEL_META[m];
      assert.ok(meta, `${provider}/${m} has no LLM_MODEL_META entry — it would show as a raw id`);
      // Model ids are all-lowercase; a display name carries capitals ("Gemini 3.1 Flash-Lite",
      // "GPT-4o"). Cheapest way to catch someone pasting the raw id in as the label.
      assert.ok(/[A-Z]/.test(meta.label), `${m} label should be a display name, got "${meta.label}"`);
      assert.ok(meta.role, `${m} needs a role so the option reads as a decision`);
    }
  }
});

test("the seeded Gemini chain is two free-tier models, primary first", () => {
  // A fresh Gemini key gets 3.5-flash-lite with 3.1-flash-lite behind it. Both must be
  // FREE-TIER (a free key can't reach anything else) and DISTINCT (a fallback to the same
  // model shares the same per-model daily allowance, so it would buy nothing).
  const { model, fallback } = GEMINI_STARTER_CHAIN;
  assert.notEqual(model, fallback);
  for (const m of [model, fallback]) {
    assert.ok(isFreeTierModel("gemini", m), m + " must be reachable by a free key");
    assert.ok(LLM_MODELS.gemini.includes(m), m + " must be offerable");
  }
  // The primary is also the provider default, so picking Gemini anywhere lands on it.
  assert.equal(LLM_DEFAULT_MODELS.gemini, model);
  // Both carry the same generous free allowance — the point is two separate 500/day pots.
  assert.equal(GEMINI_FREE_TIER[model].rpd, GEMINI_FREE_TIER[fallback].rpd);
});

test("every free-tier model is offerable and carries real limits", () => {
  for (const m of geminiFreeTierModels()) {
    assert.ok(LLM_MODELS.gemini.includes(m), `${m} missing from LLM_MODELS.gemini`);
    const l = GEMINI_FREE_TIER[m];
    assert.ok(l.rpm > 0 && l.tpm > 0 && l.rpd > 0);
  }
  assert.ok(isFreeTierModel("gemini", LLM_DEFAULT_MODELS.gemini), "the default Gemini model must be reachable by a free key");
});

// ─── Server-side rotation (web/lib/llm.ts) ──────────────────────────────────
// The website's own callers (resume parse, cover letter, teach) go through
// callLLMForAction, so these cover the path they actually take.

import { callLLM, callLLMForAction } from "../lib/llm";

type Canned = { status: number; json?: unknown; body?: string };
function fakeFetch(responses: Canned[]) {
  const calls: Array<{ url: string; key: string }> = [];
  const queue = responses.slice();
  const impl = (async (url: unknown, opts: unknown) => {
    const o = (opts ?? {}) as { headers?: Record<string, string> };
    const h = o.headers ?? {};
    calls.push({
      url: String(url),
      key: h["x-api-key"] || h.Authorization || (String(url).match(/key=([^&]+)/) || [])[1] || "",
    });
    const next = queue.shift();
    if (!next) throw new Error("unexpected fetch #" + calls.length);
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.json,
      text: async () => next.body ?? JSON.stringify(next.json ?? ""),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const okGemini = (text: string): Canned => ({ status: 200, json: { candidates: [{ content: { parts: [{ text }] } }] } });
const twoGeminiKeys: LlmKey[] = [
  { id: "k1", label: "", key: "AIza-one", tier: "free", enabled: true },
  { id: "k2", label: "", key: "AIza-two", tier: "free", enabled: true },
];

test("server rotation: a rate-limited key hands off to the next", async () => {
  const f = fakeFetch([{ status: 429, body: '{"error":{"status":"RESOURCE_EXHAUSTED"}}' }, okGemini("second key")]);
  const res = await callLLM(
    { provider: "gemini", model: "gemini-3.1-flash-lite", apiKey: "", user: "hi", keys: twoGeminiKeys },
    f.impl
  );
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.text, "second key");
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[1].key.includes("two"));
});

test("server rotation: a plain 400 stops at the first key", async () => {
  const f = fakeFetch([{ status: 400, body: '{"error":{"message":"Unknown name \\"foo\\""}}' }]);
  const res = await callLLM(
    { provider: "gemini", model: "gemini-3.1-flash-lite", apiKey: "", user: "hi", keys: twoGeminiKeys },
    f.impl
  );
  assert.equal(res.ok, false);
  assert.equal(f.calls.length, 1);
});

test("callLLMForAction uses the action's own model", async () => {
  const cfg = {
    provider: "gemini",
    model: "gemini-3.1-flash-lite",
    keys: { anthropic: [{ id: "a1", label: "", key: "sk-ant-x", tier: "paid", enabled: true }] },
    routes: { cover_letter: { provider: "anthropic", model: "claude-opus-4-8", fallbacks: [] } },
  };
  const f = fakeFetch([{ status: 200, json: { content: [{ type: "text", text: "letter" }] } }]);
  const res = await callLLMForAction(cfg, "cover_letter", { user: "hi" }, f.impl);
  assert.equal(res.ok, true);
  assert.match(f.calls[0].url, /api\.anthropic\.com/);
  assert.equal(f.calls[0].key, "sk-ant-x");
});

test("callLLMForAction falls through to the default when the routed provider has no key", async () => {
  const cfg = {
    provider: "gemini",
    model: "gemini-3.1-flash-lite",
    keys: { gemini: [twoGeminiKeys[0]] },
    // Routed at OpenAI, but no OpenAI key exists — a per-action override must not be able
    // to break an otherwise working setup.
    routes: { essay: { provider: "openai", model: "gpt-4o", fallbacks: [] } },
  };
  const f = fakeFetch([okGemini("default answered")]);
  const res = await callLLMForAction(cfg, "essay", { user: "hi" }, f.impl);
  assert.equal(res.ok, true);
  assert.equal(f.calls.length, 1, "the keyless provider is skipped without a request");
  assert.match(f.calls[0].url, /generativelanguage/);
});

test("callLLMForAction on a v1 config is one attempt with one key", async () => {
  const v1 = { provider: "gemini", model: "gemini-3.1-flash-lite", apiKey: "AIza-legacy", enabled: true };
  const f = fakeFetch([okGemini("legacy")]);
  const res = await callLLMForAction(v1, "fill", { user: "hi" }, f.impl);
  assert.equal(res.ok, true);
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].key.includes("legacy"));
});

test("callLLMForAction with no keys at all explains itself", async () => {
  const f = fakeFetch([]);
  const res = await callLLMForAction({ provider: "gemini", model: "gemini-3.1-flash-lite" }, "fill", { user: "hi" }, f.impl);
  assert.equal(res.ok, false);
  assert.match(res.ok === false ? res.error : "", /AI page/);
  assert.equal(f.calls.length, 0);
});

// ─── Persistence: what the AI page saves must survive the round trip ─────────
// ai_config is a jsonb column, so the config goes out through JSON and comes back through
// coerceAiConfig. Anything the schema quietly drops on the way back in is a setting the
// operator sets and never gets — invisible until a fill uses the wrong model.

import { aiConfigSchema, coerceAiConfig, withLegacyMirror, totalUsableKeys } from "../lib/ai-config";

test("a full v2 config survives save → jsonb → read unchanged", () => {
  const saved = aiConfigSchema.parse({
    provider: "gemini",
    model: "gemini-3.5-flash-lite",
    thinking: "manual",
    effort: "high",
    enabled: true,
    preferFreeFirst: true,
    fallbacks: [{ provider: "gemini", model: "gemini-3.1-flash-lite", thinking: "off", effort: "" }],
    keys: {
      gemini: [
        { id: "g1", label: "aistudio", key: "AIza-1", tier: "free", enabled: true },
        { id: "g2", label: "billed", key: "AIza-2", tier: "paid", enabled: true },
      ],
      anthropic: [{ id: "a1", label: "", key: "sk-ant-1", tier: "paid", enabled: true }],
    },
    routes: {
      essay: {
        provider: "anthropic",
        model: "claude-opus-5",
        thinking: "manual",
        effort: "max",
        fallbacks: [{ provider: "gemini", model: "gemini-3.5-flash", thinking: "off", effort: "" }],
      },
    },
  });

  const readBack = coerceAiConfig(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(readBack, saved, "the round trip must not drop or alter a single field");

  // Spot-check the fields most likely to be lost, since a deepEqual failure alone
  // wouldn't say which.
  assert.equal(readBack.keys.gemini?.length, 2);
  assert.equal(readBack.routes.essay?.effort, "max");
  assert.equal(readBack.routes.essay?.fallbacks[0].model, "gemini-3.5-flash");
  assert.equal(readBack.fallbacks[0].model, "gemini-3.1-flash-lite");
  assert.equal(readBack.thinking, "manual");
  assert.equal(totalUsableKeys(readBack), 3);
});

test("the legacy apiKey mirror points at the key rotation would try first", () => {
  // An extension build older than the multi-key change reads only `apiKey`, so the mirror
  // has to be the FREE key here — the one free-first ordering would actually pick.
  const cfg = aiConfigSchema.parse({
    provider: "gemini",
    preferFreeFirst: true,
    keys: {
      gemini: [
        { id: "paid", key: "AIza-paid", tier: "paid", enabled: true },
        { id: "free", key: "AIza-free", tier: "free", enabled: true },
      ],
    },
  });
  assert.equal(withLegacyMirror(cfg).apiKey, "AIza-free");

  // With no keys at all, a pre-existing v1 apiKey must NOT be wiped — that would be the
  // only key a half-migrated account has.
  const v1 = aiConfigSchema.parse({ provider: "gemini", apiKey: "AIza-legacy" });
  assert.equal(withLegacyMirror(v1).apiKey, "AIza-legacy");
});

test("a route for an id that stopped being routable is dropped, not fatal", () => {
  // teach became an alias of fill, so a config stored while it was a row must still load.
  const cfg = coerceAiConfig({
    provider: "gemini",
    routes: { teach: { provider: "openai", model: "gpt-4o" }, essay: { provider: "anthropic", model: "claude-opus-5" } },
  });
  // Cast: the type no longer admits "teach" as a route key — which is the point.
  assert.equal((cfg.routes as Record<string, unknown>).teach, undefined, "the stale row is dropped");
  assert.equal(cfg.routes.essay?.model, "claude-opus-5", "the valid one survives");
});
