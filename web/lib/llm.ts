/**
 * TypeScript port of the extension's llm.js (kept in LOCKSTEP — see WEBSITE.md →
 * Data contracts). The ONLY provider-aware code on the website. callLLM NEVER
 * throws — every failure is a normalized { ok:false, error }. Used server-side
 * for resume parsing, and LLM_MODELS feeds the AI-config dropdown so the website
 * matches the extension's model lists exactly.
 */

import {
  llmKeysFor, resolveLlmRoute, orderLlmKeys, classifyLlmFailure, applyLlmKeyOutcome, newLlmKeyState,
  type LlmKey, type LlmKeyState, type LlmActionInput, type LlmThinking,
} from "@/lib/llm-keys";

export type LlmProvider = "anthropic" | "gemini" | "openai";

/**
 * Claude models whose thinking is ON unless told otherwise (lockstep with llm.js). An
 * allowlist, not a blanket flag: sending a `disabled` block to a model that doesn't expect
 * the parameter risks a 400. Opus 4.8/4.7 run without thinking when it's omitted, so
 * they're deliberately absent.
 */
const ANTHROPIC_THINKING_DEFAULT_ON: Record<string, boolean> = {
  "claude-opus-5": true,
  "claude-sonnet-5": true,
};

/**
 * Claude models where the OPERATOR may turn thinking on (adaptive) or off. 4.6-and-newer
 * take {type:"adaptive"}; Haiku 4.5 predates that shape, so it is not adjustable and the
 * setting is ignored for it rather than risking a 400. Lockstep with llm.js.
 */
export const ANTHROPIC_THINKING_ADJUSTABLE: Record<string, boolean> = {
  "claude-opus-5": true,
  "claude-sonnet-5": true,
  "claude-opus-4-8": true,
  "claude-sonnet-4-6": true,
};

/**
 * max_tokens caps thinking PLUS the answer, so a thinking request needs a real budget —
 * otherwise reasoning eats this adapter's small allowances and the reply comes back empty.
 */
export const ANTHROPIC_EFFORT_LEVELS: Record<string, string[]> = {
  "claude-opus-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max"],
  // xhigh arrived with Opus 4.7, so 4.6 tops out at high/max. Haiku 4.5 predates effort
  // entirely and is absent — "manual" degrades to plain adaptive there.
  "claude-sonnet-4-6": ["low", "medium", "high", "max"],
};

export const ANTHROPIC_THINKING_MIN_TOKENS = 4096;
/** Truncation guard, not a target — scaled by effort. */
const ANTHROPIC_EFFORT_MIN_TOKENS: Record<string, number> = {
  low: 4096, medium: 4096, high: 8192, xhigh: 16384, max: 32768,
};

export function anthropicEffortFor(model: string, thinking?: LlmThinking, effort?: string): string | undefined {
  if (thinking !== "manual") return undefined;
  const allowed = ANTHROPIC_EFFORT_LEVELS[model];
  return allowed && effort && allowed.includes(effort) ? effort : undefined;
}

export function anthropicThinkingFor(model: string, want?: LlmThinking): { type: "adaptive" | "disabled" } | undefined {
  // "manual" is adaptive PLUS a pinned effort: the model still decides WHEN, the operator
  // caps HOW MUCH. A fixed budget_tokens would 400 on Claude 5.
  if ((want === "adaptive" || want === "manual") && ANTHROPIC_THINKING_ADJUSTABLE[model]) return { type: "adaptive" };
  if (ANTHROPIC_THINKING_DEFAULT_ON[model]) return { type: "disabled" };
  return undefined;
}

export type LlmRequest = {
  provider: LlmProvider;
  model: string;
  apiKey: string;
  system?: string;
  user: string;
  maxTokens?: number;
  /**
   * Rotation (lockstep with llm.js): when a key LIST is supplied, each key is tried in
   * turn until one answers. Omit it and this is the original single-key path.
   */
  /** "adaptive" turns Claude thinking on; "manual" also pins `effort`. */
  thinking?: LlmThinking;
  effort?: string;
  keys?: LlmKey[];
  preferFreeFirst?: boolean;
  keyState?: LlmKeyState;
  onKeyState?: (s: LlmKeyState) => void;
};

export type LlmResult =
  | { ok: true; text: string }
  | { ok: false; error: string; status?: number; body?: string; networkError?: string };

type Built = { url: string; opts: RequestInit };

const PROVIDERS: Record<
  LlmProvider,
  { build: (req: LlmRequest) => Built; parse: (data: unknown) => string | null }
> = {
  anthropic: {
    build: ({ model, apiKey, system, user, maxTokens, thinking, effort }) => ({
      url: "https://api.anthropic.com/v1/messages",
      opts: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model,
          max_tokens:
            anthropicThinkingFor(model, thinking)?.type === "adaptive"
              ? Math.max(
                  maxTokens || 1024,
                  ANTHROPIC_EFFORT_MIN_TOKENS[anthropicEffortFor(model, thinking, effort) ?? ""] ??
                    ANTHROPIC_THINKING_MIN_TOKENS
                )
              : maxTokens || 1024,
          // Claude 5 thinks by default so it must be turned OFF for short answers; 4.6/4.8
          // stay off unless the operator asks. Lockstep with llm.js.
          thinking: anthropicThinkingFor(model, thinking),
          // effort lives in output_config, not top-level, and only on "manual".
          output_config: anthropicEffortFor(model, thinking, effort)
            ? { effort: anthropicEffortFor(model, thinking, effort) }
            : undefined,
          system: system || undefined,
          messages: [{ role: "user", content: user }],
        }),
      },
    }),
    parse: (d) => {
      const data = d as { content?: Array<{ type?: string; text?: string }> };
      const block = Array.isArray(data?.content)
        ? data.content.find((b) => b && b.type === "text")
        : null;
      return block?.text ?? null;
    },
  },

  gemini: {
    build: ({ model, apiKey, system, user, maxTokens }) => ({
      url:
        "https://generativelanguage.googleapis.com/v1beta/models/" +
        encodeURIComponent(model) +
        ":generateContent?key=" +
        encodeURIComponent(apiKey),
      opts: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: system ? { parts: [{ text: system }] } : undefined,
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: { maxOutputTokens: maxTokens || 1024 },
        }),
      },
    }),
    parse: (d) => {
      const data = d as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const cand = Array.isArray(data?.candidates) ? data.candidates[0] : null;
      const parts = cand?.content?.parts;
      const part = Array.isArray(parts)
        ? parts.find((p) => p && typeof p.text === "string")
        : null;
      return part?.text ?? null;
    },
  },

  openai: {
    build: ({ model, apiKey, system, user, maxTokens }) => ({
      url: "https://api.openai.com/v1/chat/completions",
      opts: {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer " + apiKey },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens || 1024,
          messages: [
            ...(system ? [{ role: "system", content: system }] : []),
            { role: "user", content: user },
          ],
        }),
      },
    }),
    parse: (d) => {
      const data = d as { choices?: Array<{ message?: { content?: string } }> };
      const ch = Array.isArray(data?.choices) ? data.choices[0] : null;
      return ch?.message?.content ?? null;
    },
  },
};

/**
 * ONE key. The original path, unchanged — callLLM (below) wraps it to walk a key list.
 *
 * Deliberately has NO wait-ladder, unlike the extension's llm.js: these run inside server
 * actions and API routes, where sitting out a 75s retry would hang the page the operator
 * is looking at. Rotation is the server-side answer to a spent key; waiting is the
 * extension's, because a background fill can afford it. That asymmetry is intentional and
 * documented in WEBSITE.md.
 */
export async function callLLMOnce(
  req: LlmRequest,
  fetchImpl: typeof fetch = fetch
): Promise<LlmResult> {
  if (!fetchImpl) return { ok: false, error: "no fetch available in this context" };
  const prov = PROVIDERS[req?.provider];
  if (!prov) return { ok: false, error: "unknown LLM provider: " + req?.provider };
  if (!req.apiKey) return { ok: false, error: "no API key configured" };
  if (!req.model) return { ok: false, error: "no model configured" };
  if (!req.user) return { ok: false, error: "no prompt (user) provided" };

  let built: Built;
  try {
    built = prov.build(req);
  } catch (e) {
    return { ok: false, error: "request build failed: " + msg(e) };
  }

  let res: Response;
  try {
    res = await fetchImpl(built.url, built.opts);
  } catch (e) {
    return { ok: false, networkError: msg(e), error: "network error: " + msg(e) };
  }
  if (!res || !res.ok) {
    let body = "";
    try {
      body = await res.text();
    } catch {
      /* ignore */
    }
    // status/body are surfaced so the rotation layer can classify WHY without re-parsing
    // the error string.
    return {
      ok: false,
      status: res ? res.status : 0,
      body,
      error: "HTTP " + (res ? res.status : "?") + (body ? ": " + body.slice(0, 300) : ""),
    };
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch (e) {
    return { ok: false, error: "bad JSON response: " + msg(e) };
  }
  let text: string | null;
  try {
    text = prov.parse(data);
  } catch (e) {
    return { ok: false, error: "parse failed: " + msg(e) };
  }
  if (text == null || String(text).trim() === "") {
    return { ok: false, error: "no text in response: " + JSON.stringify(data).slice(0, 300) };
  }
  return { ok: true, text: String(text).trim() };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Key rotation — lockstep with llm.js's callLLM. With 0 or 1 usable key this is
 * callLLMOnce verbatim; with several, each is tried in turn until one answers.
 *
 *   key's own fault (auth / quota / 429) → park it, try the next
 *   provider down, or our bad request   → stop; no other key can help
 *
 * Free keys go first, so the metered ones stay in reserve.
 */
export async function callLLM(req: LlmRequest, fetchImpl: typeof fetch = fetch): Promise<LlmResult> {
  const supplied = Array.isArray(req?.keys) ? req.keys : null;
  if (!supplied || supplied.length === 0) return callLLMOnce(req, fetchImpl);

  const now = Date.now();
  let state = req.keyState ?? newLlmKeyState();
  const ordered = orderLlmKeys(supplied, { provider: req.provider, preferFreeFirst: req.preferFreeFirst !== false }, state, now);
  const commit = () => req.onKeyState?.(state);

  if (!ordered.keys.length) {
    commit();
    const wait = ordered.nextAvailableAt ? ` (first frees up in ~${Math.ceil((ordered.nextAvailableAt - now) / 1000)}s)` : "";
    return { ok: false, error: `no usable ${req.provider} API key: every key is disabled, rejected, or resting${wait}` };
  }

  let last: LlmResult | null = null;
  for (const k of ordered.keys) {
    const res = await callLLMOnce({ ...req, apiKey: k.key }, fetchImpl);
    if (res.ok) {
      state = applyLlmKeyOutcome(state, req.provider, k.id, "ok", Date.now());
      commit();
      return res;
    }
    const verdict = classifyLlmFailure({ status: res.status, body: res.body, networkError: res.networkError });
    last = res;
    if (verdict.keyFault) state = applyLlmKeyOutcome(state, req.provider, k.id, verdict.code, Date.now());
    if (!verdict.rotate) break;
  }
  commit();
  return last ?? { ok: false, error: "no attempt was made" };
}

/**
 * The entry point every server caller should use: resolve the operator's route for this
 * ACTION (its model, then its fallback chain, then the configured default), and rotate
 * through that provider's keys at each step.
 *
 * `config` is the stored `ai_config` — v1 or v2. A v1 config resolves to exactly one
 * attempt with one key, so existing callers behave identically after switching to this.
 *
 * Key state is per-call: server actions are request-scoped, so a cooldown can't outlive
 * the request. Rotation within the call is what matters here.
 */
export async function callLLMForAction(
  config: unknown,
  action: LlmActionInput,
  prompt: { system?: string; user: string; maxTokens?: number },
  fetchImpl: typeof fetch = fetch
): Promise<LlmResult> {
  const cfg = (config ?? {}) as { preferFreeFirst?: boolean };
  const attempts = resolveLlmRoute(config, action, LLM_DEFAULT_MODELS);
  if (!attempts.length) return { ok: false, error: "No AI model configured — set one on the AI page." };

  let state = newLlmKeyState();
  let last: LlmResult | null = null;
  for (const attempt of attempts) {
    const keys = llmKeysFor(config, attempt.provider);
    if (!keys.length) {
      last = { ok: false, error: `No ${attempt.provider} API key — add one on the AI page.` };
      continue;
    }
    const res = await callLLM(
      {
        provider: attempt.provider,
        model: attempt.model,
        thinking: attempt.thinking,
        effort: attempt.effort,
        apiKey: "",
        keys,
        preferFreeFirst: cfg.preferFreeFirst !== false,
        keyState: state,
        onKeyState: (s) => { state = s; },
        ...prompt,
      },
      fetchImpl
    );
    if (res.ok) return res;
    last = res;
  }
  return last ?? { ok: false, error: "No AI attempt was made." };
}

// The ONLY place model ids live (matches llm.js). First entry = provider default.
export const LLM_MODELS: Record<LlmProvider, string[]> = {
  anthropic: ["claude-sonnet-5", "claude-opus-5", "claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5-20251001"],
  gemini: ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash-lite", "gemini-3.5-flash", "gemini-3.6-flash", "gemini-2.5-flash", "gemini-2.5-pro"],
  openai: ["gpt-4o", "gpt-4o-mini"],
};


/**
 * Human labels for the model pickers (lockstep with llm.js). A raw id tells an operator
 * nothing about which to pick — "claude-haiku-4-5-20251001" is noise, and the date suffix
 * actively hurts. Each model gets a display name plus a one-word ROLE so the dropdown
 * reads as a decision ("most capable" vs "fastest, cheapest") rather than a list of
 * strings. A model missing from here falls back to its bare id, so a test asserts every
 * entry of LLM_MODELS is covered.
 */
export const LLM_MODEL_META: Record<string, { label: string; role: string }> = {
  "claude-opus-5": { label: "Claude Opus 5", role: "most capable" },
  "claude-sonnet-5": { label: "Claude Sonnet 5", role: "balanced, recommended" },
  "claude-opus-4-8": { label: "Claude Opus 4.8", role: "previous generation" },
  "claude-sonnet-4-6": { label: "Claude Sonnet 4.6", role: "previous generation" },
  "claude-haiku-4-5-20251001": { label: "Claude Haiku 4.5", role: "fastest, cheapest" },

  "gemini-3.1-flash-lite": { label: "Gemini 3.1 Flash-Lite", role: "fastest, cheapest" },
  "gemini-3.5-flash-lite": { label: "Gemini 3.5 Flash-Lite", role: "fast" },
  "gemini-2.5-flash-lite": { label: "Gemini 2.5 Flash-Lite", role: "fast, older" },
  "gemini-3.6-flash": { label: "Gemini 3.6 Flash", role: "balanced, newest" },
  "gemini-3.5-flash": { label: "Gemini 3.5 Flash", role: "balanced" },
  "gemini-2.5-flash": { label: "Gemini 2.5 Flash", role: "balanced, older" },
  "gemini-2.5-pro": { label: "Gemini 2.5 Pro", role: "most capable" },

  "gpt-4o": { label: "GPT-4o", role: "balanced" },
  "gpt-4o-mini": { label: "GPT-4o mini", role: "fastest, cheapest" },
};

export function llmModelLabel(model: string): string {
  return LLM_MODEL_META[model]?.label ?? String(model || "");
}

/**
 * Free tier — GEMINI ONLY (lockstep with llm.js). Gemini is the only one of the three
 * with a usable free tier, which is why it is the only provider offering a free/paid key
 * toggle; Anthropic and OpenAI keys are always metered, so offering the choice there
 * would be a lie.
 *
 * Membership is not cosmetic: a model absent here cannot be reached with a free key at
 * all (gemini-2.5-pro is paid-only), so the settings UI must not offer it while the key
 * is free — picking it would fail every request with a quota error. Limits are PER
 * MODEL, which is exactly why a fallback chain wants a second MODEL and not just a
 * second key: requests-per-day is counted per model, so when 3.1-flash-lite's 500 RPD is
 * spent the same key still has 2.5-flash-lite's own allowance.
 * Operator-supplied from the AI Studio limits dashboard, 2026-08-03.
 */
export type GeminiFreeLimits = { rpm: number; tpm: number; rpd: number };
export const GEMINI_FREE_TIER: Record<string, GeminiFreeLimits> = {
  "gemini-3.1-flash-lite": { rpm: 15, tpm: 250_000, rpd: 500 },
  "gemini-3.5-flash-lite": { rpm: 15, tpm: 250_000, rpd: 500 },
  "gemini-2.5-flash-lite": { rpm: 10, tpm: 250_000, rpd: 20 },
  "gemini-3.5-flash": { rpm: 5, tpm: 250_000, rpd: 20 },
  "gemini-3.6-flash": { rpm: 5, tpm: 250_000, rpd: 20 },
  "gemini-2.5-flash": { rpm: 5, tpm: 250_000, rpd: 20 },
};

export function geminiFreeTierModels(): string[] {
  return Object.keys(GEMINI_FREE_TIER);
}

export function isFreeTierModel(provider: string, model: string): boolean {
  return provider === "gemini" && !!GEMINI_FREE_TIER[model];
}

/**
 * Paid rates, USD per 1M tokens — shown next to each model so the cost of a choice is
 * visible before it is made. Deliberately incomplete: only rates verified against the
 * provider's own pricing page are listed, and an unlisted model renders as a "see
 * pricing" link rather than a guessed number. A wrong number on a cost display is worse
 * than no number.
 */
export const LLM_PRICING: Record<string, { in: number; out: number }> = {
  "claude-opus-5": { in: 5, out: 25 },
  // Sonnet 5 has introductory pricing ($2/$10) through 2026-08-31; the STANDARD rate is
  // listed so the number doesn't quietly go wrong in a few weeks.
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
};

export const LLM_PRICING_URLS: Record<LlmProvider, string> = {
  anthropic: "https://platform.claude.com/docs/en/pricing",
  gemini: "https://ai.google.dev/gemini-api/docs/pricing",
  openai: "https://openai.com/api/pricing",
};

export const LLM_DEFAULT_MODELS: Record<LlmProvider, string> = {
  anthropic: LLM_MODELS.anthropic[0],
  gemini: LLM_MODELS.gemini[0],
  openai: LLM_MODELS.openai[0],
};

/**
 * The chain a fresh Gemini key gets seeded with (lockstep with llm.js). Both are free-tier
 * with identical allowances (15/min, 500/day), and requests-per-day is metered PER MODEL —
 * so when the primary's daily 500 is spent the same key still has the fallback's own 500.
 * That's why the fallback is a sibling MODEL rather than a second key.
 */
export const GEMINI_STARTER_CHAIN = {
  model: "gemini-3.5-flash-lite",
  fallback: "gemini-3.1-flash-lite",
} as const;

export const LLM_PROVIDER_LABELS: Record<LlmProvider, string> = {
  gemini: "Google Gemini",
  anthropic: "Anthropic Claude",
  openai: "OpenAI",
};
