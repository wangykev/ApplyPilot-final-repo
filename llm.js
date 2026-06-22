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

// callLLM — provider-agnostic. Returns { ok:true, text } or { ok:false, error }.
// `fetchImpl` is injectable for Node tests; in the SW/popup it defaults to global fetch.
// NEVER throws — every failure is a normalized { ok:false, error } (the caller flags
// the field for review; a thrown adapter must not crash a fill).
async function callLLM(req, fetchImpl) {
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

  let res;
  try { res = await fetchFn(url, opts); } catch (e) { return { ok: false, error: "network error: " + String((e && e.message) || e) }; }
  if (!res || !res.ok) {
    let body = "";
    try { body = await res.text(); } catch (e) { /* ignore */ }
    return { ok: false, error: "HTTP " + (res ? res.status : "?") + (body ? ": " + body.slice(0, 300) : "") };
  }
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
// stale-model 429), so 2.5-flash-lite leads (highest free RPD — best for many-call fills);
// 3.5-flash = quality, 3.1-flash-lite = ~15 RPM.
const LLM_MODELS = {
  anthropic: ["claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5-20251001"],
  gemini: ["gemini-2.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-2.5-flash", "gemini-2.5-pro"],
  openai: ["gpt-4o", "gpt-4o-mini"]
};
// Default = the first listed model per provider (single source of truth — can't drift from the list).
const LLM_DEFAULT_MODELS = { anthropic: LLM_MODELS.anthropic[0], gemini: LLM_MODELS.gemini[0], openai: LLM_MODELS.openai[0] };

// UMD-lite: export for the Node test runner; in the popup/SW `module` is undefined so
// the functions stay globals (from <script> / importScripts).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { callLLM, LLM_PROVIDERS, LLM_MODELS, LLM_DEFAULT_MODELS };
}
