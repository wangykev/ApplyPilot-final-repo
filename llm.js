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
    },
    // Cache-read/creation tokens are reported separately and priced differently; they are
    // NOT folded in here, so a cached call reads as slightly cheaper than it was. Flagged
    // rather than guessed at — the tracker can add them when the rates are pinned down.
    usage: (d) => {
      const u = (d && d.usage) || {};
      return { input: u.input_tokens || 0, output: u.output_tokens || 0 };
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
    },
    // thoughtsTokenCount is billed as output but reported apart from candidates, so it has
    // to be added in or a thinking call looks cheaper than it was.
    usage: (d) => {
      const u = (d && d.usageMetadata) || {};
      return { input: u.promptTokenCount || 0, output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) };
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
    },
    usage: (d) => {
      const u = (d && d.usage) || {};
      return { input: u.prompt_tokens || 0, output: u.completion_tokens || 0 };
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
// ── PER-ATTEMPT REQUEST TIMEOUT (operator, 2026-08-08) ──────────────────────────────────────────
// A request that never answers used to block the whole walk, because fetch() has no timeout of its
// own. Live on cat.wd5: AI-4 remediation took ~182s to clear ONE field, and 148s of that was a single
// hung call — `[LLM] ok in 148262ms` — while the IDENTICAL retry right after it returned in 2005ms and
// every other call in the run took 0.5-2s. So the model was not slow; that one socket was stuck.
//
// Bounding each ATTEMPT turns a hang into the transient it actually is: an aborted fetch throws, which
// this function already treats as retryable, so the existing ladder re-issues it (and key rotation can
// move on). Generous against real latency — the LLM budget for a fill answer is small and the observed
// spread is 0.5-2s — and tight against a hang. Overridable per call via cfg.timeoutMs.
const LLM_REQUEST_TIMEOUT_MS = 30000;

// fetch with a hard deadline. Falls back to a plain fetch where AbortController is unavailable (or the
// timeout is disabled), so an injected test fetch keeps working untouched.
async function fetchWithTimeout(fetchFn, url, opts, ms) {
  if (!ms || typeof AbortController === "undefined") return fetchFn(url, opts);
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { ac.abort(); } catch (e) { /* already gone */ } }, ms);
  try {
    return await fetchFn(url, Object.assign({}, opts, { signal: ac.signal }));
  } catch (e) {
    if (timedOut) throw new Error("request timed out after " + ms + "ms");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
// ── FAST-RETRY: abandon a STUCK call instead of waiting out the full budget (operator, 2026-08-09) ──
// Measured on cat.wd5 across three back-to-back runs: gemini-3.1-flash-lite answered in 486ms, 646ms and
// 796ms — and ONCE in 30657ms, on a single attempt that SUCCEEDED, so nothing ever retried it. That one
// call was the whole difference between a 1.9s page and a 32s page. At that spread a call still running
// at 2s is overwhelmingly a stuck socket rather than a slow model, and opening a new one is far cheaper
// than waiting behind it. (Same shape as the 148s hang that motivated the per-attempt timeout above —
// only that one was extreme enough to notice.)
//
// ⚠ SAFETY — why only the EARLY attempts are capped. Capping EVERY attempt would turn a genuinely slow
// minute at the provider into a FAILED required field: the AI fill returns nothing, the field is left
// blank, Workday refuses Save & Continue and the walk halts. One slow page is much cheaper than a halted
// run, so the LAST attempt always gets the full budget. This can only ever make a call FASTER to succeed
// or equally likely to succeed — never less likely.
const LLM_FAST_RETRY_RULES = [
  { provider: "gemini", model: /^gemini-3\.1/i, ms: 2000 },
];
const LLM_FAST_RETRY_ATTEMPTS = 2;    // attempts 0 and 1 run capped; attempt 2+ gets the full budget
const LLM_FAST_RETRY_DELAY_MS = 150;  // WE chose to abandon it, so there is no server backpressure to respect

// ── ADAPTIVE CAP (2026-08-11) ────────────────────────────────────────────────────────────────────
// The static 2000ms was chosen for a model whose p50 was ~650ms, and it MISFIRES the moment that stops
// being true. Measured 2026-08-11 (round 8, docs/fill-speed-log.md): gemini-3.1-flash-lite was answering
// in ~7–13s, so **76 of 77 calls spent BOTH fast tries** — ~4000ms of pure overhead on essentially every
// call, ~28s per 7-call page, ~24% of the fill. Nothing was broken: every call still SUCCEEDED, because
// the post-fast attempt gets the full budget. It was pure wasted latency.
//
// THE INSIGHT THAT SETS THE CAP. What matters is not "is the model slow" but
// **P(stuck | still running at the cap)**. At a p50 of 650ms almost no healthy call reaches 2000ms, so
// nearly everything that trips the cap really is a stuck socket — the abort is close to free and very
// valuable. At a p50 of 11s EVERY call is still running at 2000ms, so the abort is paid by all of them
// and rescues none. The cap therefore belongs far out on the OBSERVED distribution, not at a constant.
//
// So: cap = K × the observed p50 of recent answers, and **when even that is too far out to police,
// switch the fast-retry OFF entirely** rather than let it fire on healthy calls. Turning it off is the
// safe direction — it is exactly the pre-2026-08-09 behaviour (full budget on attempt 1).
//
// K=3 is not arbitrary: 3 × the ~650ms p50 the rule was designed around is ~1950ms, i.e. it REPRODUCES
// the hand-picked 2000ms at the latency it was picked for. The static value stays the floor, so a
// healthy model behaves exactly as it does today (and the unit tests that pin 2000 still hold).
const LLM_LAT_WINDOW = 8;                 // recent answers kept per provider+model
const LLM_FAST_ADAPT_MIN_SAMPLES = 4;     // below this, use the rule's static ms — a MEDIAN over 4+ also
                                          // means one stuck-socket recovery cannot disable the feature
const LLM_FAST_ADAPT_K = 3;               // cap = K × observed p50
const LLM_FAST_ADAPT_MAX_CAP_MS = 6000;   // beyond this the cap cannot separate stuck from slow ⇒ OFF
const llmLatency = Object.create(null);   // "provider|model" → [answerMs, …]
const llmFastCapState = Object.create(null); // last logged cap per route, so the transition logs once

function llmLatKey(provider, model) { return String(provider || "") + "|" + String(model || ""); }

// The elapsed of the FETCH that actually answered — the same quantity the cap bounds, which is why an
// aborted attempt is never recorded: its true duration is censored at the cap. The timestamp is what
// lets AUTO mode re-probe a model it stopped choosing (see llmAutoPick).
function recordLlmAnswerMs(provider, model, ms, nowMs) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v < 0) return;
  const k = llmLatKey(provider, model);
  const a = llmLatency[k] || (llmLatency[k] = []);
  a.push({ ms: Math.round(v), at: Number(nowMs) || Date.now() });
  if (a.length > LLM_LAT_WINDOW) a.splice(0, a.length - LLM_LAT_WINDOW);
}

// Samples for a route, optionally only those newer than maxAgeMs.
//
// ⚠ THE AGE BOUND IS LOAD-BEARING FOR RECOVERY, and leaving it out was a real bug (caught by the
// operator asking "how do you make sure it doesn't stay on 3.1 if 3.5 comes back?"). Without it, a
// re-probe drops ONE fresh fast sample into a window still holding four stale slow ones — the MEDIAN
// stays slow, so a recovered model needs ~5 separate probes, i.e. ~75 minutes, to win its traffic back.
// Old measurements are not weak evidence about now; they are evidence about THEN, and must be dropped.
function llmRecentSamples(provider, model, nowMs, maxAgeMs) {
  const a = llmLatency[llmLatKey(provider, model)];
  if (!a || !a.length) return [];
  if (!(Number(maxAgeMs) > 0)) return a.slice();
  const cutoff = (Number(nowMs) || Date.now()) - Number(maxAgeMs);
  return a.filter((e) => e.at >= cutoff);
}

// opts: { now, maxAgeMs, minSamples }. Defaults reproduce the adaptive cap's original behaviour — the
// whole window, at least LLM_FAST_ADAPT_MIN_SAMPLES of it.
function llmObservedAnswerP50(provider, model, opts) {
  const o = opts || {};
  const min = Number(o.minSamples) > 0 ? Number(o.minSamples) : LLM_FAST_ADAPT_MIN_SAMPLES;
  const list = llmRecentSamples(provider, model, o.now, o.maxAgeMs);
  if (list.length < min) return null;
  const s = list.map((e) => e.ms).sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
}

// When this route was last measured, or null if never. AUTO mode's staleness check.
function llmLatencyNewestAt(provider, model) {
  const a = llmLatency[llmLatKey(provider, model)];
  if (!a || !a.length) return null;
  return a.reduce((mx, e) => (e.at > mx ? e.at : mx), 0) || null;
}

// ── AUTO MODEL (2026-08-11, operator) ────────────────────────────────────────────────────────────
// "Choose the fastest model for us, and if one is degraded switch to the other flash-lite."
//
// The need is real and was measured, not assumed: on 2026-08-11, interleaved on the SAME free key in
// the same minute, gemini-3.1-flash-lite answered in 11499/7620/10903ms while gemini-3.5-flash-lite
// answered in 409/682/395ms — a 20× gap that is purely server-side model health. Neither model is
// reliably "the fast one"; which is degraded changes, so the pick has to be an OBSERVATION.
//
// It reuses the adaptive cap's latency window, so AUTO costs no extra calls — it reads measurements a
// fill was making anyway.
//
// TWO PROPERTIES MATTER, and the second is the one that is easy to get wrong:
//   1. Pick the observably fastest candidate.
//   2. NEVER let the first verdict become permanent. A model we stop choosing stops being measured, so
//      its stale slow p50 would freeze the choice forever and a recovered model could never win the
//      traffic back. Anything unmeasured — or measured longer ago than LLM_AUTO_STALE_MS — is probed
//      instead. That costs one slow call per staleness window, which is the price of not being stuck.
const LLM_AUTO_MODEL = "auto";
// PREFERENCE ORDER, first = always tried first (operator, 2026-08-11: "try 3.5 flash lite first and if
// it is busy, errors, or something else, then go to 3"). This is NOT a lowest-latency race: a stable,
// predictable primary is worth more than chasing whichever sibling measured faster this minute, so the
// order is honoured and a later candidate is only reached when the one above it is EVIDENCED unhealthy.
//
// Interchangeable, same-price, same-quota siblings only — swapping between these changes speed, not the
// answer's character or the bill. Deliberately NOT the whole model list: 2.5-flash-lite shares the name
// but allows 20 requests/day against these two's 500, so auto-ing onto it would exhaust in one page.
const LLM_AUTO_CANDIDATES = {
  gemini: ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"],
};
// The RECOVERY WINDOW, and the operator's ask in one constant (2026-08-11: "every 10-20 minutes you are
// actively filling forms make a 3.5 call if currently using 3.1 and if it shows it is good, switch back").
// That is what this does, without a timer: AUTO only ever judges a model on samples from the last
// LLM_AUTO_STALE_MS, so a demoted primary ages back to "unmeasured", returns to the front of the
// preference order, and the next real fill call IS the probe. No polling, no calls the fill wasn't
// already making, and nothing to run while idle.
const LLM_AUTO_STALE_MS = 900000;      // 15min — inside the operator's 10–20min ask
const LLM_AUTO_SIDELINE_MS = 120000;   // 2min out after a SERVER-HEALTH failure (503/504/network)
const LLM_AUTO_SLOW_FACTOR = 3;        // "busy": answering ≥3× slower than a sibling counts as unhealthy
// Deliberately LOWER than the adaptive cap's 4. The cap wants a robust median because it is setting a
// timeout; AUTO wants to react, and needs a re-probed model to be re-confirmed in ~1–2 calls rather than
// four. Both read the same window — only the required sample count differs.
const LLM_AUTO_MIN_SAMPLES = 2;
const llmAutoState = Object.create(null);   // provider → last logged pick, so the log fires on CHANGE
const llmModelHealth = Object.create(null); // "provider|model" → { sidelinedUntil }

function llmAutoCandidates(provider) {
  const list = LLM_AUTO_CANDIDATES[provider];
  return Array.isArray(list) ? list.slice() : [];
}

// A model is sidelined by SERVER-health failures only. ⚠ Deliberately NOT by 429/401: a rate-limited or
// rejected KEY says nothing about the model, and demoting the operator's chosen primary because one key
// hit its per-minute quota would hand the traffic to the slower sibling for no reason.
function recordLlmModelUnhealthy(provider, model, nowMs) {
  const k = llmLatKey(provider, model);
  const h = llmModelHealth[k] || (llmModelHealth[k] = {});
  h.sidelinedUntil = (Number(nowMs) || Date.now()) + LLM_AUTO_SIDELINE_MS;
}
function llmModelSidelined(provider, model, nowMs) {
  const h = llmModelHealth[llmLatKey(provider, model)];
  if (!h || !h.sidelinedUntil) return false;
  return (Number(nowMs) || Date.now()) < h.sidelinedUntil;
}
// Which statuses mean "the MODEL/server is unwell" rather than "this key is". 503 is the one actually
// observed live (gemini-3.1-flash-lite, "overloaded", 10166ms before failing).
function llmStatusIsServerHealth(status) {
  const s = Number(status);
  return s === 500 || s === 502 || s === 503 || s === 504;
}

// → { model, reason }. `model` is "" only when the provider has no candidates AND no default.
function llmAutoPick(provider, nowMs) {
  const cands = llmAutoCandidates(provider);
  const fallbackModel = (LLM_DEFAULT_MODELS && LLM_DEFAULT_MODELS[provider]) || "";
  if (!cands.length) return { model: fallbackModel, reason: "no auto candidates for " + provider + " — using its default" };
  const now = Number(nowMs) || Date.now();

  // 1. Drop anything sidelined by a recent server-health failure. If EVERYTHING is sidelined, ignore
  //    sidelining entirely rather than answer nothing — a degraded model still beats no answer, and a
  //    failed AI call blanks a required field and halts a walk.
  const live = cands.filter((m) => !llmModelSidelined(provider, m, now));
  const pool = live.length ? live : cands;
  const first = pool[0];
  const sidelinedNote = live.length && live.length < cands.length
    ? " (skipping " + cands.filter((m) => !live.includes(m)).join(", ") + " — recent server errors)"
    : "";

  // 2. The preferred model wins unless RECENT measurements say it is slow. Judged on a short window
  //    only (LLM_AUTO_STALE_MS), which is what makes recovery automatic AND fast: once the primary's
  //    samples age out it reads unmeasured, so it goes back to the front and gets probed. One fast
  //    answer is then enough to keep it there, because the stale slow samples are no longer counted.
  const seen = (m) => llmObservedAnswerP50(provider, m, { now, maxAgeMs: LLM_AUTO_STALE_MS, minSamples: LLM_AUTO_MIN_SAMPLES });
  const p50First = seen(first);
  const atFirst = llmLatencyNewestAt(provider, first);
  if (p50First == null) {
    return {
      model: first,
      reason: "preferring " + first + (atFirst == null ? " — no measurements yet"
        : " — nothing measured in the last " + Math.round(LLM_AUTO_STALE_MS / 60000)
          + "min (last was " + Math.round((now - atFirst) / 60000) + "min ago), re-checking whether it recovered")
        + sidelinedNote,
    };
  }

  // 3. "Busy": it answers, but a sibling answers at least LLM_AUTO_SLOW_FACTOR× quicker.
  const better = pool.slice(1)
    .map((m) => ({ model: m, p50: seen(m) }))
    .filter((x) => x.p50 != null && x.p50 * LLM_AUTO_SLOW_FACTOR <= p50First)
    .sort((a, b) => a.p50 - b.p50)[0];
  if (better) {
    return {
      model: better.model,
      reason: first + " is answering in " + p50First + "ms vs " + better.model + "'s " + better.p50
        + "ms (≥" + LLM_AUTO_SLOW_FACTOR + "× slower) — stepping down to the healthy sibling" + sidelinedNote,
    };
  }
  return { model: first, reason: "preferring " + first + " — healthy at p50 " + p50First + "ms" + sidelinedNote };
}

// The FULL candidate list in the order to try them, health-ranked. This is what an "auto" route slot
// expands into (see cdp.js act.llm), so one slot becomes one ATTEMPT PER CANDIDATE and the failover the
// operator asked for — "if it is busy, errors, or something else, then go to 3" — happens WITHIN a single
// call instead of only on the next one.
//
// WHY IN-CALL MATTERS: a single `auto` slot used to resolve to ONE model, so it was also the LAST attempt.
// A persistent 503 on the chosen model therefore ended the call unanswered — the field goes to review —
// and the sibling was only reached by a LATER call via the 2min sideline. Live on the operator's own
// config, `resolveLlmRoute` returned a route of length 1 and there was no in-call fallback at all.
//
// Sidelined candidates go to the BACK rather than being dropped: a degraded answer still beats no answer
// (a failed AI call blanks a required field and halts a walk), it just must not outrank a live model.
function llmAutoOrder(provider, nowMs) {
  const cands = llmAutoCandidates(provider);
  if (!cands.length) {
    const d = (LLM_DEFAULT_MODELS && LLM_DEFAULT_MODELS[provider]) || "";
    return d ? [d] : [];
  }
  const now = Number(nowMs) || Date.now();
  const head = llmAutoPick(provider, now).model;
  const rest = cands.filter((m) => m !== head);
  return [
    head,
    ...rest.filter((m) => !llmModelSidelined(provider, m, now)),
    ...rest.filter((m) => llmModelSidelined(provider, m, now)),
  ];
}

// Turn a resolved ROUTE (a list of slots from resolveLlmRoute) into the ATTEMPT list act.llm loops over,
// expanding every "auto" slot into one attempt per candidate. Pure, so the whole behaviour is unit-tested
// rather than living inline in cdp.js, which no Node test can require.
//
// `keyId` rides onto every expansion, so Auto and per-slot key pinning COMPOSE: an auto slot pinned to
// key A becomes 3.5@A → 3.1@A rather than silently losing the pin.
//
// The re-dedupe is not cosmetic: expansion can collide with a concrete slot the operator ALSO configured
// ([auto, 3.1-flash-lite] → [3.5, 3.1, 3.1]), and a duplicate attempt is a wasted request on a model that
// just failed. Identity matches resolveLlmRoute's own dedupe, keyId included — two attempts differing only
// by KEY are genuinely useful (that is the free tier's per-key minute budget) and must survive.
function llmExpandAutoAttempts(slots, nowMs) {
  const out = [];
  const seen = new Set();
  for (const slot of Array.isArray(slots) ? slots : []) {
    if (!slot || typeof slot !== "object") continue;
    const models = slot.model === LLM_AUTO_MODEL ? llmAutoOrder(slot.provider, nowMs) : [slot.model];
    for (const model of models) {
      const k = [slot.provider, model, slot.thinking || "off", slot.effort || "", slot.keyId || ""].join("|");
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(slot.model === LLM_AUTO_MODEL ? { ...slot, model, fromAuto: true } : slot);
    }
  }
  return out;
}

// Expand an "auto" slot to a concrete model, logging only when the choice CHANGES (a per-call line
// would bury the run log, and a silent switch is untraceable when an answer looks off).
function llmResolveAutoModel(provider, model, nowMs) {
  if (String(model || "") !== LLM_AUTO_MODEL) return String(model || "");
  const pick = llmAutoPick(provider, nowMs);
  if (llmAutoState[provider] !== pick.model) {
    llmAutoState[provider] = pick.model;
    try { console.log(`[LLM] AUTO model for ${provider} → ${pick.model} — ${pick.reason}`); } catch (e) { /* log only */ }
  }
  return pick.model;
}

function resetLlmLatency() {
  for (const k of Object.keys(llmLatency)) delete llmLatency[k];
  for (const k of Object.keys(llmFastCapState)) delete llmFastCapState[k];
  for (const k of Object.keys(llmAutoState)) delete llmAutoState[k];
  for (const k of Object.keys(llmModelHealth)) delete llmModelHealth[k];
}

// The fast-retry cap for this request, or null when no rule matches, the caller opted out, or the
// observed latency has moved too far for a short cap to mean anything.
function llmFastRetryMs(cfg) {
  if (!cfg || cfg.fastRetry === false) return null;
  const m = String(cfg.model || "");
  const r = LLM_FAST_RETRY_RULES.find((x) => x.provider === cfg.provider && x.model.test(m));
  if (!r) return null;
  const p50 = llmObservedAnswerP50(cfg.provider, m);
  if (p50 == null) return r.ms;                       // cold worker: today's behaviour, exactly
  const adapted = p50 * LLM_FAST_ADAPT_K;
  const cap = adapted > LLM_FAST_ADAPT_MAX_CAP_MS ? null : Math.max(r.ms, Math.round(adapted));
  // Say it ONCE per route per change — an adaptive knob that moves invisibly is untuneable, and this is
  // the line that explains a page suddenly costing 28s less.
  const key = llmLatKey(cfg.provider, m);
  if (llmFastCapState[key] !== cap) {
    llmFastCapState[key] = cap;
    try {
      console.log(`[LLM] fast-retry cap for ${m}: ${cap == null ? "OFF" : cap + "ms"}`
        + ` — observed p50 ${p50}ms over the last ${(llmLatency[key] || []).length} answer(s)`
        + (cap == null ? `; ${LLM_FAST_ADAPT_K}×p50 exceeds ${LLM_FAST_ADAPT_MAX_CAP_MS}ms, so a short cap`
          + ` would fire on HEALTHY calls — full budget on every attempt instead.`
          : `. Static floor ${r.ms}ms.`));
    } catch (e) { /* log only */ }
  }
  return cap;
}

// The deadline for ONE attempt: the short cap while a fast try remains, the full budget once they are
// spent. Deliberately keyed on the fast-try budget and NOT on the error ladder — see the loop below for
// why those two must stay separate (the first cut tied it to `maxRetries` and, with 2+ keys configured,
// the cap then never applied at all; live-verified 2026-08-09).
function llmAttemptTimeoutMs(cfg, fastLeft) {
  const full = (cfg && cfg.timeoutMs) === undefined ? LLM_REQUEST_TIMEOUT_MS : cfg.timeoutMs;
  const fast = llmFastRetryMs(cfg);
  if (fast == null || !fastLeft || fastLeft <= 0) return full;
  return Math.min(fast, full);
}

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
  const fullTimeoutMs = cfg.timeoutMs === undefined ? LLM_REQUEST_TIMEOUT_MS : cfg.timeoutMs;
  // The fast-try budget is SEPARATE from the error ladder, and available even on a `noRetry` rotation
  // probe. That separation is the whole fix: a stuck socket is not a key fault, so it must not consume a
  // rotation slot, must not get the key marked bad, and must not be reported upward as a failure. The
  // first cut gated this on `maxRetries`, which is 0 on every rotation probe — so with 2+ keys the cap
  // silently never applied, and a live run proved it (two calls answered in ~650ms under a 50ms cap).
  let fastLeft = llmFastRetryMs(cfg) == null ? 0 : LLM_FAST_RETRY_ATTEMPTS;
  let res, attempt = 0, netErr = null, fastAborts = 0, lastFetchMs = 0;
  for (;;) {
    netErr = null;
    const usingFast = fastLeft > 0;
    const budgetMs = llmAttemptTimeoutMs(cfg, fastLeft);
    const tFetch = Date.now();
    try { res = await fetchWithTimeout(fetchFn, url, opts, budgetMs); }
    catch (e) { netErr = String((e && e.message) || e); res = null; }
    lastFetchMs = Date.now() - tFetch;   // feeds the adaptive cap; only recorded if THIS attempt answers
    // OUR short deadline fired (or the socket died fast) and a fast try remains ⇒ re-issue immediately on
    // a fresh socket. `attempt` is deliberately NOT incremented: the error ladder is untouched, so a
    // genuinely slow provider still gets its full budget below and can never be failed by the cap.
    if (netErr !== null && usingFast) {
      fastLeft--; fastAborts++;
      try {
        // Quote the OBSERVED p50 rather than asserting "well under 1s" — that claim was hardcoded, and
        // when it stopped being true the line confidently mislabelled a slow model as a stuck socket on
        // every call (2026-08-11). A diagnostic must not state the premise it is supposed to be evidence for.
        const _p50 = llmObservedAnswerP50(cfg.provider, cfg.model);
        console.log(`[LLM] fast-retry: ${cfg.model} was still running at ${budgetMs}ms — abandoned it and re-issued on a new socket`
          + (_p50 == null ? " (no observed baseline yet on this worker — using the static cap)"
            : ` (observed p50 ${_p50}ms, so ${budgetMs}ms is ~${(budgetMs / _p50).toFixed(1)}× the normal answer ⇒ likely a stuck socket)`));
      } catch (e) { /* log-only */ }
      await sleep(LLM_FAST_RETRY_DELAY_MS); // our own deadline — no Retry-After to honour, nothing to back off from
      continue;
    }
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
    // A network failure that survived the whole ladder is a reachability problem with this model's
    // endpoint, so AUTO may step around it. A fast-retry ABORT is not this — those `continue` above and
    // never reach here, which is what keeps a stuck socket from demoting a healthy model.
    if (attempt > 0) recordLlmModelUnhealthy(cfg.provider, cfg.model);
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
    // AUTO health: a 5xx is the SERVER saying it cannot serve this model right now (503 "overloaded" is
    // the one seen live). Recorded regardless of `noRetry`, because a rotation probe's 503 is just as
    // much evidence about the model. 429/401 are NOT recorded — those are the KEY's problem, and
    // demoting the operator's chosen primary for a per-key quota would be plainly wrong.
    if (res && llmStatusIsServerHealth(res.status)) recordLlmModelUnhealthy(cfg.provider, cfg.model);
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
  // Usage is read HERE because it is the only place the raw response body exists. Without
  // it there is nothing for a spend/quota tracker to record — the body is discarded.
  let usage = { input: 0, output: 0 };
  try { if (typeof prov.usage === "function") usage = prov.usage(data); } catch (e) { /* never fail a good answer over accounting */ }
  // Feed the ADAPTIVE CAP with the fetch that actually answered. Recorded only on a real success, and
  // only for the winning attempt — an aborted one is censored at the cap, so counting it would drag the
  // p50 toward the cap and make the cap justify itself.
  recordLlmAnswerMs(cfg.provider, cfg.model, lastFetchMs);
  // fastAborts: how many stuck sockets the fast-retry cap threw away before this answer landed. Surfaced
  // so the run log can say the recovery happened rather than just showing a suspiciously quick success.
  return { ok: true, text: String(text).trim(), usage, model: cfg.model, provider: cfg.provider,
    fastAborts: fastAborts || 0 };
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
  let supplied = Array.isArray(cfg.keys) ? cfg.keys : null;

  // ── PINNED KEY (2026-08-11, operator) ──────────────────────────────────────────────────────────
  // `cfg.pinKeyId` restricts THIS attempt to one key. Gemini's free tier meters 15 requests/minute
  // PER KEY, and rotation only advances when a key FAILS — so two equal free keys still send every
  // call through the first (measured: 6 consecutive calls, key 2 never touched) and a fill at ~16
  // calls/min breaches a 15/min limit while holding 30/min. Pinning the primary slot to key A and its
  // fallback slot to key B spends both budgets.
  //
  // STRICT by design: the isolated budget IS the feature, so a pin must not spill onto the other key.
  // Resilience comes from the NEXT route slot carrying its own pin. But an id that matches NOTHING is
  // IGNORED, never obeyed — a deleted key would otherwise leave the slot permanently unusable, which
  // is a worse failure than falling back to rotation.
  if (supplied && supplied.length && cfg.pinKeyId) {
    const want = String(cfg.pinKeyId);
    const hit = supplied.filter((k) => k && String(k.id) === want);
    if (hit.length) supplied = hit;
    else {
      try {
        console.log(`[LLM] pinned key "${want}" is not in this provider's key list (deleted or renamed?) —`
          + ` ignoring the pin and rotating normally. Re-pick the key on the AI page to silence this.`);
      } catch (e) { /* log only */ }
    }
  }

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
    const one = ordered.keys[0];
    const res0 = await callLLMOnce({ ...cfg, apiKey: one.key }, fetchImpl, sleepImpl);
    const res = res0.ok ? { ...res0, keyId: one.id, keyTier: one.tier } : res0;
    const verdict = res.ok ? null : api.classifyLlmFailure({ status: res.status, body: res.body, networkError: res.networkError });
    state = api.applyLlmKeyOutcome(state, cfg.provider, one.id, res.ok ? "ok" : verdict.code, now(), llmRetryAfterMsFromBody(res));
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
      // Which key served it, and on which tier — a spend tracker cannot attribute a call
      // (or know it was free) without both.
      return { ...res, keyId: k.id, keyTier: k.tier };
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
  gemini: ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash-lite", "gemini-3.5-flash", "gemini-3.6-flash", "gemini-2.5-flash", "gemini-2.5-pro"],
  openai: ["gpt-4o", "gpt-4o-mini"]
};
// Default = the first listed model per provider (single source of truth — can't drift from the list).
const LLM_DEFAULT_MODELS = { anthropic: LLM_MODELS.anthropic[0], gemini: LLM_MODELS.gemini[0], openai: LLM_MODELS.openai[0] };

// The chain a fresh Gemini key gets seeded with. Both are free-tier with identical
// allowances (15/min, 500/day), and requests-per-day is metered PER MODEL — so when the
// primary's daily 500 is gone the same key still has the fallback's own 500. That is the
// whole reason the fallback is a sibling MODEL rather than a second key.
const GEMINI_STARTER_CHAIN = { model: "gemini-3.5-flash-lite", fallback: "gemini-3.1-flash-lite" };



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
// Cost of one call, USD. Returns NULL when it cannot be known rather than 0 — an unpriced
// model must read as "unknown", never as free, or a spend chart would quietly under-report.
// A FREE-TIER Gemini call is a real 0: that is the whole point of the free/paid distinction,
// and it is why the tier has to be passed in (the model id alone cannot tell you).
function llmCostUsd(model, usage, tier) {
  if (tier === "free" && isFreeTierModel("gemini", model)) return 0;
  const rate = LLM_PRICING[model];
  if (!rate) return null;
  const u = usage || {};
  return ((u.input || 0) * rate.in + (u.output || 0) * rate.out) / 1e6;
}

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
    LLM_REQUEST_TIMEOUT_MS, fetchWithTimeout,
    LLM_FAST_RETRY_RULES, LLM_FAST_RETRY_ATTEMPTS, LLM_FAST_RETRY_DELAY_MS, llmFastRetryMs, llmAttemptTimeoutMs,
    LLM_LAT_WINDOW, LLM_FAST_ADAPT_MIN_SAMPLES, LLM_FAST_ADAPT_K, LLM_FAST_ADAPT_MAX_CAP_MS,
    recordLlmAnswerMs, llmObservedAnswerP50, llmLatencyNewestAt, resetLlmLatency,
    LLM_AUTO_MODEL, LLM_AUTO_CANDIDATES, LLM_AUTO_STALE_MS, LLM_AUTO_SIDELINE_MS, LLM_AUTO_SLOW_FACTOR,
    LLM_AUTO_MIN_SAMPLES, llmRecentSamples,
    llmAutoCandidates, llmAutoPick, llmAutoOrder, llmExpandAutoAttempts, llmResolveAutoModel,
    recordLlmModelUnhealthy, llmModelSidelined,
    llmStatusIsServerHealth,
    GEMINI_FREE_TIER, geminiFreeTierModels, isFreeTierModel, LLM_PRICING, LLM_PRICING_URLS,
    llmCostUsd, GEMINI_STARTER_CHAIN, LLM_MODEL_META, llmModelLabel, ANTHROPIC_THINKING_ADJUSTABLE, ANTHROPIC_THINKING_DEFAULT_ON,
    ANTHROPIC_THINKING_MIN_TOKENS, anthropicThinkingFor, ANTHROPIC_EFFORT_LEVELS,
    ANTHROPIC_EFFORT_MIN_TOKENS, anthropicEffortFor, anthropicMaxTokens };
}
