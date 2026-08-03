/**
 * TypeScript port of the extension's llm-keys.js (kept in LOCKSTEP — see WEBSITE.md →
 * Data contracts). The decisions behind a multi-key `llmConfig`: which key to try next,
 * and what a given failure means for that key.
 *
 * Pure — no fetch, no Date.now() (every function takes `nowMs`), nothing mutates its
 * arguments. `web/test/llm-keys.test.ts` cross-loads the extension's real llm-keys.js
 * and fails if the two copies disagree, the same discipline discover.ts follows.
 *
 * Key failure state deliberately does NOT live in `llmConfig`: that object is config
 * owned by this website (Supabase `profiles.ai_config` → AP_SET_LLM → the extension's
 * chrome.storage.local), so a cooldown written into it would be wiped by the next sync.
 * State is per-runtime and in-memory on both sides.
 */

import type { LlmProvider } from "@/lib/llm";

export const LLM_KEY_COOLDOWN = { RATE_LIMIT_MS: 60_000, QUOTA_MS: 900_000 } as const;

/**
 * Actions that route to a model. Ids match the real call sites.
 *
 * The pair that matters to an operator is fill vs essay, and they pull in opposite
 * directions: `fill` answers short screening questions dozens of times per application
 * (cheap and fast), while `essay` writes a paragraph of prose once or twice (worth a
 * stronger model). Keeping those separate is the point of per-action routing.
 */
export const LLM_ACTIONS = ["fill", "essay", "resume_parse", "cover_letter"] as const;
export type LlmAction = (typeof LLM_ACTIONS)[number];

/**
 * Actions that deliberately RIDE another action's route instead of getting their own row.
 * `teach` classifies a question the same way the fill does, so a separate model would be a
 * knob with no real decision behind it — it follows `fill`, including fill's fallbacks.
 */
export const LLM_ACTION_ALIASES: Record<string, LlmAction> = { teach: "fill" };
/** What a caller may ask for: a routable action, or an alias of one. */
export type LlmActionInput = LlmAction | keyof typeof LLM_ACTION_ALIASES;

export type LlmKeyTier = "free" | "paid";

export type LlmKey = {
  id: string;
  label: string;
  key: string;
  /** Declared by the operator — a Gemini key is free or billed with identical format. */
  tier: LlmKeyTier;
  enabled: boolean;
};

export type LlmFailureCode =
  | "auth"
  | "quota"
  | "rate_limit"
  | "provider_down"
  | "bad_request"
  | "not_found"
  | "unknown";

export type LlmKeyVerdict = { code: LlmFailureCode; rotate: boolean; keyFault: boolean };

export type LlmKeySlot = { invalid: boolean; cooldownUntil: number; lastCode?: LlmFailureCode };
export type LlmKeyState = { keys: Record<string, LlmKeySlot> };

export type LlmThinking = "off" | "adaptive";

export type LlmRouteAttempt = {
  provider: LlmProvider;
  model: string;
  /** Per-ROUTE, not per-model: prose wants deliberation, a yes/no does not. */
  thinking: LlmThinking;
  source: "action" | "action-fallback" | "default" | "default-fallback";
};

export function normalizeLlmKey(raw: unknown, index: number): LlmKey {
  const k = (raw && typeof raw === "object" ? raw : {}) as Partial<LlmKey>;
  const secret = typeof k.key === "string" ? k.key.trim() : "";
  return {
    id: typeof k.id === "string" && k.id ? k.id : "k" + index,
    label: typeof k.label === "string" ? k.label : "",
    key: secret,
    tier: k.tier === "free" ? "free" : "paid",
    enabled: k.enabled !== false,
  };
}

/**
 * Every key entered for a provider, in the operator's row order. Accepts the LEGACY
 * single-key shape (`{provider, model, apiKey}`) so a config stored before this change
 * — or one written by the extension popup — keeps working untouched.
 */
export function llmKeysFor(config: unknown, provider: string): LlmKey[] {
  const cfg = (config && typeof config === "object" ? config : {}) as {
    keys?: Record<string, unknown>;
    apiKey?: string;
    provider?: string;
  };
  const list = cfg.keys && typeof cfg.keys === "object" ? cfg.keys[provider] : null;
  if (Array.isArray(list)) return list.map(normalizeLlmKey).filter((k) => k.key);
  if (cfg.apiKey && cfg.provider === provider) {
    return [normalizeLlmKey({ id: "legacy", key: cfg.apiKey, tier: "paid", label: "" }, 0)];
  }
  return [];
}

export function newLlmKeyState(): LlmKeyState {
  return { keys: {} };
}

function slotFor(state: LlmKeyState | null | undefined, provider: string, keyId: string): LlmKeySlot | null {
  return state?.keys?.[provider + "/" + keyId] ?? null;
}

/**
 * Try-order for a provider's keys, plus why the rest were skipped. Disabled,
 * provider-rejected, and still-cooling keys are out; free keys lead when
 * preferFreeFirst is on; the operator's row order breaks ties.
 *
 * Empty `keys` with a non-zero `nextAvailableAt` means every key is resting and says
 * when the first returns — a far more actionable error than a bare 429.
 */
export function orderLlmKeys(
  keys: LlmKey[],
  options: { provider: string; preferFreeFirst?: boolean },
  state: LlmKeyState | null | undefined,
  nowMs: number
): { keys: LlmKey[]; skipped: Array<{ id?: string; reason: string; until?: number }>; nextAvailableAt: number } {
  const provider = options?.provider ?? "";
  const preferFreeFirst = options?.preferFreeFirst !== false;
  const usable: Array<{ k: LlmKey; index: number }> = [];
  const skipped: Array<{ id?: string; reason: string; until?: number }> = [];
  let nextAvailableAt = 0;

  (Array.isArray(keys) ? keys : []).forEach((k, index) => {
    if (!k || !k.key) return void skipped.push({ id: k?.id, reason: "empty" });
    if (k.enabled === false) return void skipped.push({ id: k.id, reason: "disabled" });
    const slot = slotFor(state, provider, k.id);
    if (slot?.invalid) return void skipped.push({ id: k.id, reason: "rejected" });
    if (slot && slot.cooldownUntil > nowMs) {
      skipped.push({ id: k.id, reason: "cooldown", until: slot.cooldownUntil });
      if (!nextAvailableAt || slot.cooldownUntil < nextAvailableAt) nextAvailableAt = slot.cooldownUntil;
      return;
    }
    usable.push({ k, index });
  });

  usable.sort((a, b) => {
    if (preferFreeFirst) {
      const ra = a.k.tier === "free" ? 0 : 1;
      const rb = b.k.tier === "free" ? 0 : 1;
      if (ra !== rb) return ra - rb;
    }
    return a.index - b.index;
  });

  return { keys: usable.map((u) => u.k), skipped, nextAvailableAt };
}

const LLM_BAD_KEY_RE =
  /api[ _-]?key not valid|invalid[ _-]?api[ _-]?key|api_key_invalid|invalid_api_key|incorrect api key|unauthenticated/i;
const LLM_QUOTA_RE =
  /insufficient[_ ]quota|insufficient[_ ]balance|credit balance|exceeded your current quota|billing|out of credits/i;

/**
 * What a failure means for the key that produced it.
 *   rotate   — try the next key; false for a provider outage, where every key would
 *              hit the same dead endpoint
 *   keyFault — this key earns a cooldown or a rejection
 *
 * The two non-obvious cases, both found the hard way: Gemini rejects a bad key with
 * 400 INVALID_ARGUMENT rather than 401, and Anthropic reports an exhausted balance as
 * a 400. Classifying on status alone strands a run on a dead key while the operator's
 * other keys sit unused.
 */
export function classifyLlmFailure(input: {
  status?: number;
  body?: unknown;
  networkError?: unknown;
}): LlmKeyVerdict {
  const { status, body, networkError } = input || {};
  const text = typeof body === "string" ? body : body ? JSON.stringify(body) : "";
  const s = Number(status) || 0;

  if (networkError) return { code: "provider_down", rotate: false, keyFault: false };
  if (s === 401 || s === 403) return { code: "auth", rotate: true, keyFault: true };

  if (s === 400 || s === 422) {
    if (LLM_BAD_KEY_RE.test(text)) return { code: "auth", rotate: true, keyFault: true };
    if (LLM_QUOTA_RE.test(text)) return { code: "quota", rotate: true, keyFault: true };
    return { code: "bad_request", rotate: false, keyFault: false };
  }

  if (s === 404) return { code: "not_found", rotate: false, keyFault: false };
  if (s === 402) return { code: "quota", rotate: true, keyFault: true };
  if (s === 429) {
    return { code: LLM_QUOTA_RE.test(text) ? "quota" : "rate_limit", rotate: true, keyFault: true };
  }
  if (s === 408 || s === 409 || s === 529 || (s >= 500 && s < 600)) {
    return { code: "provider_down", rotate: false, keyFault: false };
  }
  if (LLM_QUOTA_RE.test(text)) return { code: "quota", rotate: true, keyFault: true };
  return { code: "unknown", rotate: false, keyFault: false };
}

/** Fold one attempt's outcome into the in-memory state. Returns a NEW state. */
export function applyLlmKeyOutcome(
  state: LlmKeyState | null | undefined,
  provider: string,
  keyId: string,
  code: LlmFailureCode | "ok",
  nowMs: number,
  retryAfterMs?: number
): LlmKeyState {
  const prev = state?.keys ?? {};
  const next: LlmKeyState = { keys: { ...prev } };
  const slotKey = provider + "/" + keyId;

  if (code === "ok") {
    delete next.keys[slotKey];
    return next;
  }

  const existing = prev[slotKey];
  const base: LlmKeySlot = existing ? { ...existing } : { invalid: false, cooldownUntil: 0 };
  if (code === "auth") {
    base.invalid = true;
  } else if (code === "quota") {
    base.cooldownUntil = nowMs + (Number(retryAfterMs) || LLM_KEY_COOLDOWN.QUOTA_MS);
  } else if (code === "rate_limit") {
    base.cooldownUntil = nowMs + (Number(retryAfterMs) || LLM_KEY_COOLDOWN.RATE_LIMIT_MS);
  } else {
    return { keys: prev };
  }
  base.lastCode = code;
  next.keys[slotKey] = base;
  return next;
}

/**
 * The ordered {provider, model} attempts for an action:
 *   1. the action's own pair, then ITS fallback chain
 *   2. the configured default pair, then the default fallback chain
 *
 * A fallback is a full provider+model pair, so a chain can switch MODEL (a free Gemini
 * key that exhausted requests-per-day on 3.1-flash-lite moves to 2.5-flash-lite, which
 * has its own daily allowance) or switch PROVIDER entirely. Both matter on the free
 * tier, where each model carries its own small RPM/RPD budget. Ending with the default
 * means a per-action override can never break an otherwise working setup.
 */
export function resolveLlmRoute(
  config: unknown,
  action: string | null | undefined,
  defaultModels: Partial<Record<string, string>>
): LlmRouteAttempt[] {
  const cfg = (config && typeof config === "object" ? config : {}) as {
    routes?: Record<string, { provider?: string; model?: string; thinking?: unknown; fallbacks?: unknown }>;
    fallbacks?: unknown;
    provider?: string;
    model?: string;
    thinking?: unknown;
  };
  const models = defaultModels || {};
  const out: LlmRouteAttempt[] = [];

  const push = (
    provider: string | undefined,
    model: string | undefined,
    thinking: unknown,
    source: LlmRouteAttempt["source"]
  ) => {
    if (!provider) return;
    const resolved = model || models[provider] || "";
    const think: LlmThinking = thinking === "adaptive" ? "adaptive" : "off";
    if (out.some((a) => a.provider === provider && a.model === resolved && a.thinking === think)) return;
    out.push({ provider: provider as LlmProvider, model: resolved, thinking: think, source });
  };

  const pushChain = (chain: unknown, source: LlmRouteAttempt["source"]) => {
    (Array.isArray(chain) ? chain : []).forEach((f) => {
      const t = f as { provider?: string; model?: string; thinking?: unknown };
      if (f && typeof f === "object") push(t.provider, t.model, t.thinking, source);
    });
  };

  // An alias resolves to its target BEFORE the lookup, so `teach` picks up fill's own
  // override rather than the global default an unknown action would fall to.
  const act = action ? LLM_ACTION_ALIASES[action] ?? action : action;
  const route = act && cfg.routes && typeof cfg.routes === "object" ? cfg.routes[act] : null;
  if (route?.provider) {
    push(route.provider, route.model, route.thinking, "action");
    pushChain(route.fallbacks, "action-fallback");
  }
  push(cfg.provider, cfg.model, cfg.thinking, "default");
  pushChain(cfg.fallbacks, "default-fallback");
  return out;
}
