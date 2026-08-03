// ============================================================================
// llm-keys.js — the DECISIONS behind a multi-key `llmConfig` (AI-0, key rotation).
// Pure: no fetch, no chrome.*, no Date.now() (every function takes `nowMs`), and
// nothing mutates its arguments. That is what makes it unit-testable and what makes
// it safe to port — `web/lib/llm-keys.ts` is a LOCKSTEP dup, and
// `web/test/llm-keys.test.ts` cross-loads THIS file and fails if the two disagree
// (same discipline as discover.js ↔ lib/discover.ts).
//
// WHY A SEPARATE FILE FROM llm.js: llm.js owns the HTTP round-trip; this owns
// "which key next, and what does this failure mean for that key". Keeping them apart
// is what lets the website reuse the rules without also inheriting the extension's
// fetch/retry machinery.
//
// WHY KEY STATE IS NOT IN llmConfig: `llmConfig` is CONFIG, and the website owns it
// (Supabase `profiles.ai_config` → AP_SET_LLM → chrome.storage.local). If a cooldown
// were written back onto a key record, the next sync would wipe it and the extension
// has no config write-back path anyway. So failure state lives in memory for the life
// of the runtime, exactly like llm.js's existing llmRetryState.
// ============================================================================

// Cooldowns applied to ONE key after a key-specific failure. A rate limit is usually
// per-minute; an exhausted quota or a dead balance will not recover in a minute, so it
// earns a much longer rest rather than being re-tried at the front of the next round.
const LLM_KEY_COOLDOWN = { RATE_LIMIT_MS: 60000, QUOTA_MS: 900000 };

// The actions that route to a model. Ids match the real call sites, so adding a
// capability means adding an id here plus passing it at the call site — never a
// change to the settings UI, which renders this list.
//
// The pair that matters to an operator is fill vs essay, and they pull in opposite
// directions: `fill` answers short screening questions dozens of times per application
// (so: cheap and fast), while `essay` writes a paragraph of prose once or twice (so:
// worth a stronger model). Keeping them separate is the whole point of per-action routing.
const LLM_ACTIONS = ["fill", "essay", "resume_parse", "cover_letter"];

// Actions that deliberately RIDE another action's route instead of having their own row.
// `teach` classifies a question the same way the fill does — same kind of judgement, same
// prompt shape — so giving it a separate model would be a knob with no real decision
// behind it. It follows whatever `fill` is set to, including fill's fallback chain.
const LLM_ACTION_ALIASES = { teach: "fill" };

// ─── Config normalization ───────────────────────────────────────────────────

// One key entry: { id, label, key, tier: "free"|"paid", enabled }.
// `tier` is declared by the operator because the key itself cannot say: a Gemini AI
// Studio key is free-tier or billed with byte-identical format, and only the operator
// knows which project it belongs to.
function normalizeLlmKey(raw, index) {
  const k = raw && typeof raw === "object" ? raw : {};
  const secret = typeof k.key === "string" ? k.key.trim() : "";
  return {
    id: typeof k.id === "string" && k.id ? k.id : "k" + index,
    label: typeof k.label === "string" ? k.label : "",
    key: secret,
    tier: k.tier === "free" ? "free" : "paid",
    enabled: k.enabled !== false
  };
}

// Every key the operator has entered for a provider, in their own row order.
// Accepts the LEGACY single-key shape: a v1 llmConfig is `{provider, model, apiKey}`
// with no `keys`, and must keep working untouched — the extension may hold a v1 config
// synced before this change, and popup.js still writes one.
function llmKeysFor(config, provider) {
  const cfg = config && typeof config === "object" ? config : {};
  const byProvider = cfg.keys && typeof cfg.keys === "object" ? cfg.keys : null;
  const list = byProvider && Array.isArray(byProvider[provider]) ? byProvider[provider] : null;
  if (list) return list.map(normalizeLlmKey).filter((k) => k.key);
  // Legacy: the flat apiKey belongs to the flat provider, and nothing else.
  if (cfg.apiKey && cfg.provider === provider) {
    return [normalizeLlmKey({ id: "legacy", key: cfg.apiKey, tier: "paid", label: "" }, 0)];
  }
  return [];
}

// ─── Rotation order ─────────────────────────────────────────────────────────

// In-memory per-key failure state. Keyed by `provider + "/" + keyId` so two providers
// can reuse an id without colliding.
function newLlmKeyState() {
  return { keys: {} };
}

function llmKeyStateSlot(state, provider, keyId) {
  const map = state && state.keys ? state.keys : {};
  return map[provider + "/" + keyId] || null;
}

// Which keys to try, in order, and why the rest were skipped.
//   - a disabled key, or one the provider REJECTED (auth), is out
//   - a key still cooling from a 429 / spent quota is out until its timer passes
//   - with preferFreeFirst, free keys go first so the metered ones are the reserve
//   - within a tier the operator's own row order wins (they can reorder in the UI)
// An empty `keys` with a non-zero `nextAvailableAt` means "every key is resting, and
// here is when the first one returns" — which is a far better error than a bare 429,
// and is exactly what the caller needs to decide between waiting and giving up.
function orderLlmKeys(keys, options, state, nowMs) {
  const opts = options || {};
  const provider = opts.provider || "";
  const preferFreeFirst = opts.preferFreeFirst !== false;
  const usable = [];
  const skipped = [];
  let nextAvailableAt = 0;

  (Array.isArray(keys) ? keys : []).forEach((k, index) => {
    if (!k || !k.key) { skipped.push({ id: k && k.id, reason: "empty" }); return; }
    if (k.enabled === false) { skipped.push({ id: k.id, reason: "disabled" }); return; }
    const slot = llmKeyStateSlot(state, provider, k.id);
    if (slot && slot.invalid) { skipped.push({ id: k.id, reason: "rejected" }); return; }
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
    return a.index - b.index; // stable — the operator's row order
  });

  return { keys: usable.map((u) => u.k), skipped, nextAvailableAt };
}

// ─── Failure classification ─────────────────────────────────────────────────

// Two providers break the obvious status→meaning mapping, and both were found the hard
// way. Classifying on status alone strands a run on a dead key while the operator's
// other keys sit unused — the precise failure multiple keys exist to prevent.
const LLM_BAD_KEY_RE = /api[ _-]?key not valid|invalid[ _-]?api[ _-]?key|api_key_invalid|invalid_api_key|incorrect api key|unauthenticated/i;
const LLM_QUOTA_RE = /insufficient[_ ]quota|insufficient[_ ]balance|credit balance|exceeded your current quota|billing|out of credits/i;

// → { code, rotate, keyFault }
//   code     — auth | quota | rate_limit | provider_down | bad_request | not_found | unknown
//   rotate   — try the operator's NEXT key; a provider outage sets this false, because
//              every key would hit the same dead endpoint
//   keyFault — this key earns a cooldown / rejection; a provider outage does not
function classifyLlmFailure(input) {
  const { status, body, networkError } = input || {};
  const text = typeof body === "string" ? body : body ? JSON.stringify(body) : "";
  const s = Number(status) || 0;

  // A network throw says nothing about the key — llm.js's existing ladder handles it.
  if (networkError) return { code: "provider_down", rotate: false, keyFault: false };

  if (s === 401 || s === 403) return { code: "auth", rotate: true, keyFault: true };

  if (s === 400 || s === 422) {
    // Gemini rejects a bad key with 400 INVALID_ARGUMENT, not 401.
    if (LLM_BAD_KEY_RE.test(text)) return { code: "auth", rotate: true, keyFault: true };
    // Anthropic reports an exhausted balance as a 400 ("Your credit balance is too low").
    if (LLM_QUOTA_RE.test(text)) return { code: "quota", rotate: true, keyFault: true };
    // Anything else at 400 is OUR request. Rotating would burn every key to relearn it.
    return { code: "bad_request", rotate: false, keyFault: false };
  }

  if (s === 404) return { code: "not_found", rotate: false, keyFault: false };
  if (s === 402) return { code: "quota", rotate: true, keyFault: true };

  if (s === 429) {
    // A 429 is a spent balance only when the body says so. Gemini's free tier reports
    // RESOURCE_EXHAUSTED for ordinary per-minute limiting, so that alone must not earn
    // the long cooldown — the key is fine again in a minute.
    return { code: LLM_QUOTA_RE.test(text) ? "quota" : "rate_limit", rotate: true, keyFault: true };
  }

  // 5xx/529: the provider is down or overloaded. Another key reaches the same endpoint,
  // so rotation buys nothing — this is what llm.js's wait ladder is for.
  if (s === 408 || s === 409 || s === 529 || (s >= 500 && s < 600)) {
    return { code: "provider_down", rotate: false, keyFault: false };
  }

  if (LLM_QUOTA_RE.test(text)) return { code: "quota", rotate: true, keyFault: true };
  return { code: "unknown", rotate: false, keyFault: false };
}

// Fold one attempt's outcome into the in-memory state. Returns a NEW state object.
//   ok         — clear this key's failure record
//   auth       — the provider rejected the key itself; mark it rejected so rotation
//                skips it until the operator replaces it (no retry can fix a bad key)
//   quota      — long cooldown; a dead balance will not refill in a minute
//   rate_limit — short cooldown, or exactly what Retry-After asked for
function applyLlmKeyOutcome(state, provider, keyId, code, nowMs, retryAfterMs) {
  const prev = state && state.keys ? state.keys : {};
  const next = { keys: Object.assign({}, prev) };
  const slotKey = provider + "/" + keyId;

  if (code === "ok") { delete next.keys[slotKey]; return next; }

  const base = Object.assign({ invalid: false, cooldownUntil: 0 }, prev[slotKey] || {});
  if (code === "auth") {
    base.invalid = true;
  } else if (code === "quota") {
    base.cooldownUntil = nowMs + (Number(retryAfterMs) || LLM_KEY_COOLDOWN.QUOTA_MS);
  } else if (code === "rate_limit") {
    base.cooldownUntil = nowMs + (Number(retryAfterMs) || LLM_KEY_COOLDOWN.RATE_LIMIT_MS);
  } else {
    return { keys: prev }; // not this key's fault — leave it alone
  }
  base.lastCode = code;
  next.keys[slotKey] = base;
  return next;
}

// ─── Per-action routing ─────────────────────────────────────────────────────

// The ordered {provider, model} attempts for an action:
//   1. the action's own pair, then ITS fallback chain
//   2. the configured default pair, then the default fallback chain
// A fallback is a full provider+model pair, so a chain can switch MODEL (a free Gemini
// key that ran out of requests-per-day on 3.1-flash-lite moves to 2.5-flash-lite, whose
// daily allowance is separate) or switch PROVIDER entirely (…then Claude). Both matter
// on the free tier, where every model has its own small RPM/RPD budget.
// Ending with the default means a per-action override can never break a working setup.
// `defaultModels` maps provider → its default model (llm.js's LLM_DEFAULT_MODELS), so
// picking a provider without naming a model still resolves.
function resolveLlmRoute(config, action, defaultModels) {
  const cfg = config && typeof config === "object" ? config : {};
  const models = defaultModels || {};
  const out = [];

  // `thinking` rides along per attempt ("off" | "adaptive"): the right answer differs by
  // JOB on the same model — prose wants deliberation, a yes/no does not.
  const push = (provider, model, thinking, effort, source) => {
    if (!provider) return;
    const resolved = model || models[provider] || "";
    const think = thinking === "adaptive" || thinking === "manual" ? thinking : "off";
    const eff = think === "manual" && typeof effort === "string" ? effort : "";
    if (out.some((a) => a.provider === provider && a.model === resolved && a.thinking === think && a.effort === eff)) return;
    out.push({ provider, model: resolved, thinking: think, effort: eff, source });
  };

  const pushChain = (chain, source) => {
    (Array.isArray(chain) ? chain : []).forEach((f) => {
      if (f && typeof f === "object") push(f.provider, f.model, f.thinking, f.effort, source);
    });
  };

  const routes = cfg.routes && typeof cfg.routes === "object" ? cfg.routes : {};
  // An alias resolves to its target BEFORE the lookup, so `teach` picks up fill's own
  // override — not the global default, which is what an unknown action would fall to.
  const act = action && LLM_ACTION_ALIASES[action] ? LLM_ACTION_ALIASES[action] : action;
  const route = act && routes[act] && typeof routes[act] === "object" ? routes[act] : null;
  if (route && route.provider) {
    push(route.provider, route.model, route.thinking, route.effort, "action");
    pushChain(route.fallbacks, "action-fallback");
  }

  push(cfg.provider, cfg.model, cfg.thinking, cfg.effort, "default");
  pushChain(cfg.fallbacks, "default-fallback");
  return out;
}

// UMD-lite: export for the Node test runner (and for the website's lockstep test to
// cross-load); in the SW/popup `module` is undefined so these stay globals.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    LLM_KEY_COOLDOWN, LLM_ACTIONS, LLM_ACTION_ALIASES, normalizeLlmKey, llmKeysFor, newLlmKeyState,
    orderLlmKeys, classifyLlmFailure, applyLlmKeyOutcome, resolveLlmRoute
  };
}
