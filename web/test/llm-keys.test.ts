import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  LLM_KEY_COOLDOWN, LLM_ACTIONS, llmKeysFor, newLlmKeyState, orderLlmKeys,
  classifyLlmFailure, applyLlmKeyOutcome, resolveLlmRoute, type LlmKey,
} from "../lib/llm-keys";
import {
  LLM_DEFAULT_MODELS, LLM_MODELS, GEMINI_FREE_TIER, geminiFreeTierModels, isFreeTierModel, LLM_PRICING,
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
    { provider: "gemini", routes: { teach: { provider: "anthropic" } } },
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
  assert.deepEqual(geminiFreeTierModels(), extLlm.geminiFreeTierModels());
  assert.deepEqual(LLM_KEY_COOLDOWN, extKeys.LLM_KEY_COOLDOWN);
  assert.deepEqual([...LLM_ACTIONS], extKeys.LLM_ACTIONS);
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

test("every free-tier model is offerable and carries real limits", () => {
  for (const m of geminiFreeTierModels()) {
    assert.ok(LLM_MODELS.gemini.includes(m), `${m} missing from LLM_MODELS.gemini`);
    const l = GEMINI_FREE_TIER[m];
    assert.ok(l.rpm > 0 && l.tpm > 0 && l.rpd > 0);
  }
  assert.ok(isFreeTierModel("gemini", LLM_DEFAULT_MODELS.gemini), "the default Gemini model must be reachable by a free key");
});
