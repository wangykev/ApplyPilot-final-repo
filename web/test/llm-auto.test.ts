import { test } from "node:test";
import assert from "node:assert/strict";
import { llmExpandAutoAttempts, LLM_AUTO_MODEL, LLM_AUTO_CANDIDATES } from "../lib/llm";

/**
 * The `auto` model is stored as a literal model id and was, by design, expanded only by the
 * EXTENSION — which left every SERVER-side caller (résumé parse, cover letter, teach) POSTing
 * `models/auto` to the provider. Reported live 2026-08-16 by a user on the SHIPPED DEFAULT config:
 *
 *   AI request failed: HTTP 404: models/auto is not found for API version v1beta
 *
 * So this is not an optimisation — without the expansion the default setup cannot make a single
 * server-side call.
 */

const slot = (over: Partial<Record<string, unknown>> = {}) => ({
  provider: "gemini", model: LLM_AUTO_MODEL, thinking: "off", effort: "", keyId: "", source: "default",
  ...over,
} as never);

test("auto expands to ONE ATTEMPT PER CANDIDATE, in the documented order", () => {
  const out = llmExpandAutoAttempts([slot()]);
  assert.deepEqual(out.map((a) => a.model), LLM_AUTO_CANDIDATES.gemini);
  // never the literal — that is the string the provider 404s on
  assert.equal(out.some((a) => a.model === LLM_AUTO_MODEL), false);
  // ordering is the point: best-observed first, and the rest become in-call failover
  assert.equal(out[0].model, "gemini-3.5-flash-lite");
});

test("a concrete model is passed through untouched", () => {
  const concrete = slot({ model: "gemini-3.1-flash-lite" });
  const out = llmExpandAutoAttempts([concrete]);
  assert.equal(out.length, 1);
  assert.equal(out[0].model, "gemini-3.1-flash-lite");
  assert.equal(out[0], concrete, "a non-auto slot should not even be copied");
});

test("keyId is preserved and stays part of the dedupe identity", () => {
  const out = llmExpandAutoAttempts([slot({ keyId: "kA" }), slot({ keyId: "kB" })]);
  // same two models on two different keys = four USEFUL attempts (the 15-rpm-per-key rule)
  assert.equal(out.length, 4);
  assert.deepEqual([...new Set(out.map((a) => a.keyId))], ["kA", "kB"]);
});

test("the same auto slot twice collapses — dedupe survives expansion", () => {
  const out = llmExpandAutoAttempts([slot(), slot()]);
  assert.equal(out.length, LLM_AUTO_CANDIDATES.gemini!.length);
});

test("an auto slot for a provider with NO candidates is kept, not silently dropped", () => {
  // dropping it would take the user's only configured model with it and report
  // "No AI model configured" — a worse and more confusing failure than the provider's own error.
  const out = llmExpandAutoAttempts([slot({ provider: "openai" })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].provider, "openai");
});

test("an empty or malformed list never throws", () => {
  assert.deepEqual(llmExpandAutoAttempts([]), []);
  assert.deepEqual(llmExpandAutoAttempts(null as never), []);
  assert.deepEqual(llmExpandAutoAttempts([null, undefined] as never), []);
});
