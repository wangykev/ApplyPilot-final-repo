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

// Claude models whose thinking is ON unless told otherwise. Sending {type:"disabled"} to
// a model that doesn't expect the parameter risks a 400, so this is an allowlist, not a
// blanket flag. (Opus 4.8/4.7 run WITHOUT thinking when the field is omitted, so they are
// deliberately absent.)
const ANTHROPIC_THINKING_DEFAULT_ON = { "claude-opus-5": true, "claude-sonnet-5": true };

// Claude models where the OPERATOR may turn thinking on (adaptive) or off. 4.6-and-newer
// take {type:"adaptive"}; Haiku 4.5 predates that shape (it wants budget_tokens), so it is
// NOT adjustable and the setting is ignored for it rather than risking a 400.
const ANTHROPIC_THINKING_ADJUSTABLE = {
  "claude-opus-5": true, "claude-sonnet-5": true, "claude-opus-4-8": true, "claude-sonnet-4-6": true
};
// Thinking needs room to happen: max_tokens caps thinking PLUS the answer, so leaving this
// adapter's small budgets (as low as 24) in place would spend the whole allowance on
// reasoning and return an empty reply. When thinking is ON, floor the budget.
// Effort levels each model accepts. NOT uniform: xhigh arrived with Opus 4.7, so 4.6 tops
// out at high/max, and Haiku 4.5 predates effort entirely (it is absent, so "manual" falls
// back to plain adaptive there rather than sending a parameter that errors).
const ANTHROPIC_EFFORT_LEVELS = {
  "claude-opus-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-5": ["low", "medium", "high", "xhigh", "max"],
  "claude-opus-4-8": ["low", "medium", "high", "xhigh", "max"],
  "claude-sonnet-4-6": ["low", "medium", "high", "max"]
};
// Thinking shares max_tokens with the answer, so a thinking request needs headroom or the
// reply truncates to nothing. Scaled by effort: this is a TRUNCATION GUARD, not a target —
// the model stops when it is done, it does not spend to the ceiling.
const ANTHROPIC_THINKING_MIN_TOKENS = 4096;
const ANTHROPIC_EFFORT_MIN_TOKENS = { low: 4096, medium: 4096, high: 8192, xhigh: 16384, max: 32768 };
function anthropicEffortFor(model, thinking, effort) {
  if (thinking !== "manual") return undefined; // off/adaptive never pin an effort
  const allowed = ANTHROPIC_EFFORT_LEVELS[model];
  return allowed && allowed.indexOf(effort) !== -1 ? effort : undefined;
}
function anthropicMaxTokens(model, thinking, effort, maxTokens) {
  const t = anthropicThinkingFor(model, thinking);
  if (!t || t.type !== "adaptive") return maxTokens || 1024;
  const eff = anthropicEffortFor(model, thinking, effort);
  const floor = (eff && ANTHROPIC_EFFORT_MIN_TOKENS[eff]) || ANTHROPIC_THINKING_MIN_TOKENS;
  return Math.max(maxTokens || 1024, floor);
}
function anthropicThinkingWants(model, want, type) {
  const t = anthropicThinkingFor(model, want);
  return !!(t && t.type === type);
}
function anthropicThinkingFor(model, want) {
  // "manual" is adaptive PLUS a pinned effort — the model still decides WHEN to think,
  // the operator caps HOW MUCH. A fixed budget_tokens would 400 on Claude 5.
  if ((want === "adaptive" || want === "manual") && ANTHROPIC_THINKING_ADJUSTABLE[model]) return { type: "adaptive" };
  if (ANTHROPIC_THINKING_DEFAULT_ON[model]) return { type: "disabled" };
  return undefined; // older models: omit the parameter entirely
}

// Per-provider request builders + response parsers. Each returns { url, opts } for
// fetch and a parse(data)→text. Adding a provider = one entry here, nothing else.
const LLM_PROVIDERS = {
  anthropic: {
    build: ({ model, apiKey, system, user, maxTokens, thinking, effort }) => ({
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
          // max_tokens caps thinking PLUS the answer, so a thinking request needs a real
          // budget — otherwise reasoning eats a 24-token allowance and the reply comes back
          // empty, indistinguishable from a broken model.
          max_tokens: anthropicMaxTokens(model, thinking, effort, maxTokens),
          // Claude 5 thinks by default, so it must be turned OFF explicitly for short
          // answers; 4.6/4.8 stay off unless the operator asks. See anthropicThinkingFor.
          thinking: anthropicThinkingFor(model, thinking),
          // effort lives in output_config, not top-level, and only on "manual".
          output_config: anthropicEffortFor(model, thinking, effort)
            ? { effort: anthropicEffortFor(model, thinking, effort) }
            : undefined,
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

// callLLMOnce — ONE key, the original single-key path: build → fetch → wait-ladder →
// breaker → normalize. Behaviour here is unchanged; callLLM (below) wraps it to walk a
// list of keys. Returns { ok:true, text } or { ok:false, error }, and on an HTTP failure
// also `status` + `body` so the rotation layer can classify WHY without re-parsing the
// error string.
// `cfg.noRetry` skips the ladder entirely — that is what makes rotation cheap: probing
// the next key must not cost the 75s a full ladder does.
// `fetchImpl` is injectable for Node tests; in the SW/popup it defaults to global fetch.
// `sleepImpl` is injectable the same way (retry tests pass a capture so they don't wait).
// NEVER throws — every failure is a normalized { ok:false, error } (the caller flags
// the field for review; a thrown adapter must not crash a fill).
async function callLLMOnce(req, fetchImpl, sleepImpl) {
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
  // A rotation probe (noRetry) likewise takes one attempt — the next KEY is the cheaper
  // remedy than waiting, so the ladder is saved for when every key has been tried.
  const cooling = Date.now() < llmRetryState.coolingUntil;
  const maxRetries = cfg.noRetry || cooling ? 0 : LLM_RETRY_DELAYS_MS.length;
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
    return { ok: false, networkError: netErr, error: "network error: " + netErr + (attempt > 0 ? " (gave up after " + (attempt + 1) + " attempts)" : "") };
  }
  if (!res || !res.ok) {
    // Only a RETRYABLE exhaustion counts toward the breaker — a 401 says nothing about capacity.
    // Rotation probes are excluded: three keys each seeing one 429 is not three exhausted
    // ladders, and counting them would trip the breaker and suppress the ladder for 2min.
    if (!cfg.noRetry && res && LLM_RETRY_STATUS[res.status]) {
      llmRetryState.consecutiveExhausted++;
      if (llmRetryState.consecutiveExhausted >= LLM_BREAKER_TRIP_AFTER) {
        llmRetryState.coolingUntil = Date.now() + LLM_BREAKER_COOLDOWN_MS;
        llmRetryState.consecutiveExhausted = 0;
      }
    }
    let body = "";
    try { body = await res.text(); } catch (e) { /* ignore */ }
    // Surfaced so a rotation probe can park the key for exactly as long as the server
    // asked, instead of falling back to the per-code default cooldown.
    return { ok: false, status: res ? res.status : 0, body, retryAfterMs: llmRetryAfterMs(res, Date.now()),
      error: "HTTP " + (res ? res.status : "?") + (body ? ": " + body.slice(0, 300) : "")
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

// ─── Key rotation ───────────────────────────────────────────────────────────
// callLLM — the entry point every caller uses. Accepts EITHER the original single
// `apiKey` or a `keys` list (llmConfig.keys[provider]); with 0 or 1 usable key it is
// callLLMOnce verbatim, so the single-key contract — ladder, Retry-After, breaker, error
// strings — is untouched.
//
// WITH SEVERAL KEYS, ROTATION COMES BEFORE WAITING. That ordering is the whole point: a
// 429 on key 1 costs one cheap request to discover and then key 2 answers, where the
// ladder alone would sit out ~75s (the live 2026-08-02 incident — a 65-field form burned
// its quota and fields fell to needs_review the model could have answered). So:
//   pass 1  probe each usable key once, no waiting
//             success            → done
//             key's own fault    → park that key, try the next
//             provider down/our  → stop; no other key can help
//   pass 2  every key key-faulted → the ladder wouldn't help either; report which keys
//             were parked and when the first frees up.
//           provider down        → hand the FIRST key to the full ladder, so an outage
//             still gets the resilience it always had.
//
// `keyState`/`onKeyState` thread the in-memory cooldown map (llm-keys.js) through, so a
// key parked on one call is skipped on the next. Optional — omit them and rotation is
// still correct within the single call.
function llmKeysApi() {
  // llm-keys.js is a global in the SW/popup (importScripts / <script>) and a require in
  // Node. Missing entirely → rotation degrades to single-key, never crashes.
  if (typeof orderLlmKeys === "function") {
    return { orderLlmKeys, classifyLlmFailure, applyLlmKeyOutcome, newLlmKeyState };
  }
  try { return require("./llm-keys.js"); } catch (e) { return null; }
}

async function callLLM(req, fetchImpl, sleepImpl) {
  const cfg = req || {};
  const api = llmKeysApi();
  const supplied = Array.isArray(cfg.keys) ? cfg.keys : null;

  // Not a rotation call → the original path, unchanged.
  if (!api || !supplied || supplied.length === 0) {
    return callLLMOnce(cfg, fetchImpl, sleepImpl);
  }

  const now = () => Date.now();
  let state = cfg.keyState || api.newLlmKeyState();
  const ordered = api.orderLlmKeys(supplied, { provider: cfg.provider, preferFreeFirst: cfg.preferFreeFirst !== false }, state, now());
  const commit = () => { if (typeof cfg.onKeyState === "function") cfg.onKeyState(state); };

  if (!ordered.keys.length) {
    commit();
    const wait = ordered.nextAvailableAt ? " (first one frees up in ~" + Math.ceil((ordered.nextAvailableAt - now()) / 1000) + "s)" : "";
    return { ok: false, error: "no usable API key for " + cfg.provider + ": every key is disabled, rejected, or resting" + wait };
  }
  if (ordered.keys.length === 1) {
    // One key → give it the full ladder rather than a bare probe; there is nothing to
    // rotate to, so waiting IS the remedy.
    const res = await callLLMOnce({ ...cfg, apiKey: ordered.keys[0].key }, fetchImpl, sleepImpl);
    const verdict = res.ok ? null : api.classifyLlmFailure({ status: res.status, body: res.body, networkError: res.networkError });
    state = api.applyLlmKeyOutcome(state, cfg.provider, ordered.keys[0].id, res.ok ? "ok" : verdict.code, now(), llmRetryAfterMsFromBody(res));
    commit();
    return res;
  }

  let last = null;
  let ladderKey = null;
  for (const k of ordered.keys) {
    const res = await callLLMOnce({ ...cfg, apiKey: k.key, noRetry: true }, fetchImpl, sleepImpl);
    if (res.ok) {
      state = api.applyLlmKeyOutcome(state, cfg.provider, k.id, "ok", now());
      commit();
      return res;
    }
    const verdict = api.classifyLlmFailure({ status: res.status, body: res.body, networkError: res.networkError });
    last = res;
    if (verdict.keyFault) {
      state = api.applyLlmKeyOutcome(state, cfg.provider, k.id, verdict.code, now(), llmRetryAfterMsFromBody(res));
    }
    if (!verdict.rotate) { ladderKey = verdict.code === "provider_down" ? k : null; break; }
  }
  commit();

  // The provider itself is down or our request is malformed — another key changes
  // nothing, but an outage still deserves the ladder it has always had.
  if (ladderKey) return callLLMOnce({ ...cfg, apiKey: ladderKey.key }, fetchImpl, sleepImpl);

  const parked = api.orderLlmKeys(supplied, { provider: cfg.provider }, state, now());
  const wait = parked.nextAvailableAt ? "; earliest frees up in ~" + Math.ceil((parked.nextAvailableAt - now()) / 1000) + "s" : "";
  return { ok: false, error: "all " + ordered.keys.length + " " + cfg.provider + " keys are spent" + wait
    + (last && last.error ? " — last: " + last.error : "") };
}

// Retry-After the rotation layer can reuse: callLLMOnce already parsed and capped it for
// its own ladder, but a probe never reads headers, so fall back to null and let the
// per-code default cooldown apply.
function llmRetryAfterMsFromBody(res) {
  return res && typeof res.retryAfterMs === "number" ? res.retryAfterMs : null;
}

// Selectable models per provider for the popup dropdown — the operator PICKS one (no typing,
// so a stale typed id can't 429). FIRST entry of each list is the provider default. This is the
// ONLY place model IDs live — UPDATE here when a provider's lineup changes. Gemini IDs verified
// against Google's live list 2026-06-22 (gemini-2.0-flash-lite was SHUT DOWN 2026-06-01 — the
// stale-model 429). gemini-3.1-flash-lite LEADS — operator-verified to infer the screening
// answers correctly, and ~15 RPM is ample for the small screening page; 2.5-flash-lite (highest
// free RPD) is the high-volume alternative; 3.5-flash = quality.
const LLM_MODELS = {
  anthropic: ["claude-sonnet-5", "claude-opus-5", "claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5-20251001"],
  gemini: ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemini-2.5-flash-lite", "gemini-3.5-flash", "gemini-3.6-flash", "gemini-2.5-flash", "gemini-2.5-pro"],
  openai: ["gpt-4o", "gpt-4o-mini"]
};
// Default = the first listed model per provider (single source of truth — can't drift from the list).
const LLM_DEFAULT_MODELS = { anthropic: LLM_MODELS.anthropic[0], gemini: LLM_MODELS.gemini[0], openai: LLM_MODELS.openai[0] };


// ─── Human labels for the model pickers ─────────────────────────────────────
// A raw id tells an operator nothing about which to choose — "claude-haiku-4-5-20251001"
// is noise, and the date suffix actively hurts. Each model gets a display name plus a
// one-word ROLE, so the dropdown reads as a decision ("most capable" vs "fastest,
// cheapest") instead of a list of strings. A model missing from here would fall back to
// its bare id, so a test asserts every entry of LLM_MODELS is covered.
const LLM_MODEL_META = {
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
  "gpt-4o-mini": { label: "GPT-4o mini", role: "fastest, cheapest" }
};
function llmModelLabel(model) {
  const m = LLM_MODEL_META[model];
  return m ? m.label : String(model || "");
}

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
  "claude-opus-5": { in: 5, out: 25 },
  // Sonnet 5 has introductory pricing ($2/$10) through 2026-08-31; the STANDARD rate is
  // listed so the number doesn't quietly become wrong in a few weeks.
  "claude-sonnet-5": { in: 3, out: 15 },
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
    LLM_RETRY_AFTER_CAP_MS, LLM_BREAKER_TRIP_AFTER, LLM_BREAKER_COOLDOWN_MS, llmRetryAfterMs, resetLlmRetryState, llmRetryState, callLLM, callLLMOnce, LLM_PROVIDERS, LLM_MODELS, LLM_DEFAULT_MODELS, LLM_RETRY_STATUS, LLM_RETRY_DELAYS_MS,
    GEMINI_FREE_TIER, geminiFreeTierModels, isFreeTierModel, LLM_PRICING, LLM_PRICING_URLS,
    LLM_MODEL_META, llmModelLabel, ANTHROPIC_THINKING_ADJUSTABLE, ANTHROPIC_THINKING_DEFAULT_ON,
    ANTHROPIC_THINKING_MIN_TOKENS, anthropicThinkingFor, ANTHROPIC_EFFORT_LEVELS,
    ANTHROPIC_EFFORT_MIN_TOKENS, anthropicEffortFor, anthropicMaxTokens };
}
