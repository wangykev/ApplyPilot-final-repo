/**
 * TypeScript port of the extension's llm.js (kept in LOCKSTEP — see WEBSITE.md →
 * Data contracts). The ONLY provider-aware code on the website. callLLM NEVER
 * throws — every failure is a normalized { ok:false, error }. Used server-side
 * for resume parsing, and LLM_MODELS feeds the AI-config dropdown so the website
 * matches the extension's model lists exactly.
 */

export type LlmProvider = "anthropic" | "gemini" | "openai";

export type LlmRequest = {
  provider: LlmProvider;
  model: string;
  apiKey: string;
  system?: string;
  user: string;
  maxTokens?: number;
};

export type LlmResult = { ok: true; text: string } | { ok: false; error: string };

type Built = { url: string; opts: RequestInit };

const PROVIDERS: Record<
  LlmProvider,
  { build: (req: LlmRequest) => Built; parse: (data: unknown) => string | null }
> = {
  anthropic: {
    build: ({ model, apiKey, system, user, maxTokens }) => ({
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
          max_tokens: maxTokens || 1024,
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

export async function callLLM(
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
    return { ok: false, error: "network error: " + msg(e) };
  }
  if (!res || !res.ok) {
    let body = "";
    try {
      body = await res.text();
    } catch {
      /* ignore */
    }
    return { ok: false, error: "HTTP " + (res ? res.status : "?") + (body ? ": " + body.slice(0, 300) : "") };
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

// The ONLY place model ids live (matches llm.js). First entry = provider default.
export const LLM_MODELS: Record<LlmProvider, string[]> = {
  anthropic: ["claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5-20251001"],
  gemini: ["gemini-3.1-flash-lite", "gemini-2.5-flash-lite", "gemini-3.5-flash", "gemini-2.5-flash", "gemini-2.5-pro"],
  openai: ["gpt-4o", "gpt-4o-mini"],
};

export const LLM_DEFAULT_MODELS: Record<LlmProvider, string> = {
  anthropic: LLM_MODELS.anthropic[0],
  gemini: LLM_MODELS.gemini[0],
  openai: LLM_MODELS.openai[0],
};

export const LLM_PROVIDER_LABELS: Record<LlmProvider, string> = {
  gemini: "Google Gemini",
  anthropic: "Anthropic Claude",
  openai: "OpenAI",
};
