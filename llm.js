// ============================================================================
// llm.js — the multi-provider LLM adapter (AI-0). ONE provider-agnostic entry,
// callLLM({provider, model, apiKey, system, user, maxTokens}) → normalized
// { ok, text } | { ok:false, error }. The ONLY provider-aware code in the repo —
// the brain (fill-driver.js, via act.llm) and the integration never branch on
// provider. Loaded three ways off ONE file (the db.js/lib.js UMD-lite pattern):
// SW importScripts, popup <script>, and Node require (the bottom guard) — the
// last makes it unit-testable with an INJECTED fetch (test/llm.test.js).
//
// SAFETY note: this layer only does the HTTP round-trip + response normalization.
// The guess+fill+FLAG safety contract lives in the brain (a model reply is always a
// guess that gets a human review); this file never decides anything about a fill.
// ============================================================================

// Per-provider request builders + response parsers. Each returns { url, opts } for
// fetch and a parse(data)→text. Adding a provider = one entry here, nothing else.
const LLM_PROVIDERS = {
  anthropic: {
    build: ({ model, apiKey, system, user, maxTokens }) => ({
      url: "https://api.anthropic.com/v1/messages",
      opts: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          // Anthropic rejects non-allowlisted browser origins unless this opt-in is set;
          // the extension SW fetch carries an extension origin, so we include it.
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens || 1024,
          system: system || undefined,
          messages: [{ role: "user", content: user }]
        })
      }
    }),
    // { content: [{ type:"text", text }] }
    parse: (d) => {
      const block = d && Array.isArray(d.content) ? d.content.find((b) => b && b.type === "text") : null;
      return block ? block.text : null;
    }
  },

  gemini: {
    build: ({ model, apiKey, system, user, maxTokens }) => ({
      // key in the query string (Gemini's documented auth for generateContent)
      url: "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(apiKey),
      opts: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: system ? { parts: [{ text: system }] } : undefined,
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: { maxOutputTokens: maxTokens || 1024 }
        })
      }
    }),
    // { candidates: [{ content: { parts: [{ text }] } }] }
    parse: (d) => {
      const cand = d && Array.isArray(d.candidates) ? d.candidates[0] : null;
      const parts = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : null;
      const part = parts ? parts.find((p) => p && typeof p.text === "string") : null;
      return part ? part.text : null;
    }
  },

  openai: {
    build: ({ model, apiKey, system, user, maxTokens }) => ({
      url: "https://api.openai.com/v1/chat/completions",
      opts: {
        method: "POST",
        headers: { "content-type": "application/json", "Authorization": "Bearer " + apiKey },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens || 1024,
          messages: [
            ...(system ? [{ role: "system", content: system }] : []),
            { role: "user", content: user }
          ]
        })
      }
    }),
    // { choices: [{ message: { content } }] }
    parse: (d) => {
      const ch = d && Array.isArray(d.choices) ? d.choices[0] : null;
      return ch && ch.message ? ch.message.content : null;
    }
  }
};

// Transient-availability RETRY (2026-07-02: a Gemini HTTP 503 "high demand … try again later"
// killed a page-3 screening-question fill). Demand/infra spikes are usually temporary, so a
// retryable HTTP status WAITS then re-sends the SAME request (delays below, in order) before
// giving up with ok:false. Status-keyed ONLY: auth/validation failures (400/401/403/404) and
// malformed-response failures never retry (a retry can't fix them), and a network throw keeps
// its existing single-attempt contract. Worst case adds ~10s to a failing call — acceptable;
// the alternative is a needs_review on a field the model could have answered seconds later.
const LLM_RETRY_STATUS = { 429: true, 500: true, 502: true, 503: true, 504: true, 529: true };
// Wait-then-retry, in order; length = max retries. Reaches ~75s because a 429 is usually a
// per-MINUTE quota and the old 2s+8s ladder could not outlast one (live 2026-08-02: a 65-field
// form burned its quota and fields fell to needs_review the model could have answered).
const LLM_RETRY_DELAYS_MS = [2000, 8000, 20000, 45000];
// A 429 usually carries Retry-After (seconds, or an HTTP date). Obeying the server beats
// guessing — but cap it, so a header asking for an hour can't hang a run.
const LLM_RETRY_AFTER_CAP_MS = 60000;
// CIRCUIT BREAKER. Retrying is right for a momentary spike and wrong for an EXHAUSTED quota:
// with a full ladder per field, one dead quota would turn a 65-field form into a ~45-minute
// stall. After this many calls exhaust their whole ladder back-to-back, stop retrying for a
// cooldown — each call still gets ONE attempt, so the moment the quota frees up we recover.
const LLM_BREAKER_TRIP_AFTER = 3;
const LLM_BREAKER_COOLDOWN_MS = 120000;
const llmRetryState = { consecutiveExhausted: 0, coolingUntil: 0 };
function resetLlmRetryState() { llmRetryState.consecutiveExhausted = 0; llmRetryState.coolingUntil = 0; }
// Retry-After → ms. Accepts a delta-seconds number or an HTTP date; null when absent/unusable.
function llmRetryAfterMs(res, nowMs) {
  try {
    const h = res && res.headers && typeof res.headers.get === "function" ? res.headers.get("retry-after") : null;
    if (!h) return null;
    const secs = Number(String(h).trim());
    if (Number.isFinite(secs)) return Math.max(0, Math.min(secs * 1000, LLM_RETRY_AFTER_CAP_MS));
    const when = Date.parse(String(h));
    if (!Number.isFinite(when)) return null;
    return Math.max(0, Math.min(when - (nowMs || Date.now()), LLM_RETRY_AFTER_CAP_MS));
  } catch (e) { return null; }
}

// callLLM — provider-agnostic. Returns { ok:true, text } or { ok:false, error }.
// `fetchImpl` is injectable for Node tests; in the SW/popup it defaults to global fetch.
// `sleepImpl` is injectable the same way (retry tests pass a capture so they don't wait).
// NEVER throws — every failure is a normalized { ok:false, error } (the caller flags
// the field for review; a thrown adapter must not crash a fill).
async function callLLM(req, fetchImpl, sleepImpl) {
  const fetchFn = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  if (!fetchFn) return { ok: false, error: "no fetch available in this context" };
  const cfg = req || {};
  const prov = LLM_PROVIDERS[cfg.provider];
  if (!prov) return { ok: false, error: "unknown LLM provider: " + cfg.provider };
  if (!cfg.apiKey) return { ok: false, error: "no API key configured" };
  if (!cfg.model) return { ok: false, error: "no model configured" };
  if (!cfg.user) return { ok: false, error: "no prompt (user) provided" };

  let url, opts;
  try { ({ url, opts } = prov.build(cfg)); } catch (e) { return { ok: false, error: "request build failed: " + String((e && e.message) || e) }; }
  const sleep = sleepImpl || ((ms) => new Promise((r) => setTimeout(r, ms)));

  // While the breaker is cooling, take ONE attempt and don't spend the ladder.
  const cooling = Date.now() < llmRetryState.coolingUntil;
  const maxRetries = cooling ? 0 : LLM_RETRY_DELAYS_MS.length;
  let res, attempt = 0, netErr = null;
  for (;;) {
    netErr = null;
    try { res = await fetchFn(url, opts); }
    catch (e) { netErr = String((e && e.message) || e); res = null; }
    // A network throw is transient too (DNS blip, dropped socket) — it earns the same ladder.
    const retryable = netErr !== null || (res && !res.ok && LLM_RETRY_STATUS[res.status]);
    if (retryable && attempt < maxRetries) {
      const after = res ? llmRetryAfterMs(res, Date.now()) : null; // the server's own advice wins
      await sleep(after == null ? LLM_RETRY_DELAYS_MS[attempt] : after);
      attempt++;
      continue;
    }
    break;
  }
  if (netErr !== null) {
    if (attempt > 0) llmRetryState.consecutiveExhausted++;
    return { ok: false, error: "network error: " + netErr + (attempt > 0 ? " (gave up after " + (attempt + 1) + " attempts)" : "") };
  }
  if (!res || !res.ok) {
    // Only a RETRYABLE exhaustion counts toward the breaker — a 401 says nothing about capacity.
    if (res && LLM_RETRY_STATUS[res.status]) {
      llmRetryState.consecutiveExhausted++;
      if (llmRetryState.consecutiveExhausted >= LLM_BREAKER_TRIP_AFTER) {
        llmRetryState.coolingUntil = Date.now() + LLM_BREAKER_COOLDOWN_MS;
        llmRetryState.consecutiveExhausted = 0;
      }
    }
    let body = "";
    try { body = await res.text(); } catch (e) { /* ignore */ }
    return { ok: false, error: "HTTP " + (res ? res.status : "?") + (body ? ": " + body.slice(0, 300) : "")
      + (attempt > 0 ? " (gave up after " + (attempt + 1) + " attempts)" : "")
      + (cooling ? " [rate-limit cooldown: not retrying for now]" : "") };
  }
  llmRetryState.consecutiveExhausted = 0; // a success clears the run of failures
  llmRetryState.coolingUntil = 0;
  let data;
  try { data = await res.json(); } catch (e) { return { ok: false, error: "bad JSON response: " + String((e && e.message) || e) }; }
  let text;
  try { text = prov.parse(data); } catch (e) { return { ok: false, error: "parse failed: " + String((e && e.message) || e) }; }
  if (text == null || String(text).trim() === "") return { ok: false, error: "no text in response: " + JSON.stringify(data).slice(0, 300) };
  return { ok: true, text: String(text).trim() };
}

// Selectable models per provider for the popup dropdown — the operator PICKS one (no typing,
// so a stale typed id can't 429). FIRST entry of each list is the provider default. This is the
// ONLY place model IDs live — UPDATE here when a provider's lineup changes. Gemini IDs verified
// against Google's live list 2026-06-22 (gemini-2.0-flash-lite was SHUT DOWN 2026-06-01 — the
// stale-model 429). gemini-3.1-flash-lite LEADS — operator-verified to infer the screening
// answers correctly, and ~15 RPM is ample for the small screening page; 2.5-flash-lite (highest
// free RPD) is the high-volume alternative; 3.5-flash = quality.
const LLM_MODELS = {
  anthropic: ["claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5-20251001"],
  gemini: ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemini-2.5-flash-lite", "gemini-3.5-flash", "gemini-3.6-flash", "gemini-2.5-flash", "gemini-2.5-pro"],
  openai: ["gpt-4o", "gpt-4o-mini"]
};
// Default = the first listed model per provider (single source of truth — can't drift from the list).
const LLM_DEFAULT_MODELS = { anthropic: LLM_MODELS.anthropic[0], gemini: LLM_MODELS.gemini[0], openai: LLM_MODELS.openai[0] };

// ─── Free tier — GEMINI ONLY ────────────────────────────────────────────────
// Gemini is the only provider of the three that serves a usable free tier, which is why
// it is the only one with a free/paid key toggle. Anthropic and OpenAI keys are always
// metered, so offering the choice there would be a lie.
//
// Membership is NOT cosmetic: a model absent from this table cannot be reached with a
// free key at all (gemini-2.5-pro is paid-only), so the settings UI must not offer it
// while the key is free — picking it would fail every request with a quota error.
//
// Limits are PER MODEL, and that is the whole reason a fallback chain wants a second
// MODEL and not just a second key: requests-per-day is counted per model, so when
// 3.1-flash-lite's 500 RPD is gone, the same key still has 2.5-flash-lite's allowance.
// rpm = requests/min, tpm = tokens/min, rpd = requests/day.
// Operator-supplied from the AI Studio limits dashboard, 2026-08-03.
const GEMINI_FREE_TIER = {
  "gemini-3.1-flash-lite": { rpm: 15, tpm: 250000, rpd: 500 },
  "gemini-3.5-flash-lite": { rpm: 15, tpm: 250000, rpd: 500 },
  "gemini-2.5-flash-lite": { rpm: 10, tpm: 250000, rpd: 20 },
  "gemini-3.5-flash": { rpm: 5, tpm: 250000, rpd: 20 },
  "gemini-3.6-flash": { rpm: 5, tpm: 250000, rpd: 20 },
  "gemini-2.5-flash": { rpm: 5, tpm: 250000, rpd: 20 }
};
function geminiFreeTierModels() { return Object.keys(GEMINI_FREE_TIER); }
function isFreeTierModel(provider, model) { return provider === "gemini" && !!GEMINI_FREE_TIER[model]; }

// ─── Paid rates — USD per 1M tokens ─────────────────────────────────────────
// Shown next to each model so the cost of a choice is visible BEFORE it is made.
// Deliberately incomplete: only rates verified against the provider's own pricing page
// are listed. An unlisted model renders as "see pricing" with a link rather than a
// guessed number — a wrong price on a cost display is worse than no price.
const LLM_PRICING = {
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5-20251001": { in: 1, out: 5 }
};
const LLM_PRICING_URLS = {
  anthropic: "https://platform.claude.com/docs/en/pricing",
  gemini: "https://ai.google.dev/gemini-api/docs/pricing",
  openai: "https://openai.com/api/pricing"
};

// UMD-lite: export for the Node test runner; in the popup/SW `module` is undefined so
// the functions stay globals (from <script> / importScripts).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    LLM_RETRY_AFTER_CAP_MS, LLM_BREAKER_TRIP_AFTER, LLM_BREAKER_COOLDOWN_MS, llmRetryAfterMs, resetLlmRetryState, llmRetryState, callLLM, LLM_PROVIDERS, LLM_MODELS, LLM_DEFAULT_MODELS, LLM_RETRY_STATUS, LLM_RETRY_DELAYS_MS,
    GEMINI_FREE_TIER, geminiFreeTierModels, isFreeTierModel, LLM_PRICING, LLM_PRICING_URLS };
}
