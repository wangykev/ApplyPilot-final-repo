import { z } from "zod";
import { LLM_DEFAULT_MODELS, type LlmProvider } from "@/lib/llm";
import { LLM_ACTIONS } from "@/lib/llm-keys";

/**
 * Mirrors the extension's chrome.storage.local `llmConfig` (see WEBSITE.md → Data
 * contracts). v2 adds three things to the original flat shape:
 *
 *   keys      — MANY keys per provider, tried in order, so one hitting its limit doesn't
 *               stop a fill. Free keys lead (see `preferFreeFirst`).
 *   routes    — a provider+model per ACTION (fill / resume parse / cover letter / teach),
 *               each with its own fallback chain. Unset = follow the default pair.
 *   fallbacks — the default chain, used by any action without its own.
 *
 * v1 COMPATIBILITY IS LOAD-BEARING, in both directions:
 *  - READ: a stored v1 config (`{provider, model, apiKey, enabled}`) has no `keys`, and
 *    `llmKeysFor` treats the flat `apiKey` as a single key for the flat provider — so an
 *    account that never opens this page keeps working with no migration at all.
 *  - WRITE: `apiKey` is still written, mirroring the first usable key of the default
 *    provider (`withLegacyMirror`). An extension build older than this change — and the
 *    extension popup, which still writes the flat shape — reads `apiKey`. Dropping the
 *    field would silently turn AI fill off on the next sync.
 */

const providerEnum = z.enum(["anthropic", "gemini", "openai"]);

export const llmKeySchema = z.object({
  id: z.string().min(1),
  label: z.string().default(""),
  key: z.string().default(""),
  /**
   * GEMINI ONLY in the UI: it's the one provider of the three with a usable free tier,
   * and a free AI Studio key is byte-identical to a billed one, so only the operator can
   * say which it is. Forced to "paid" for other providers in the transform below, so a
   * stray "free" can never quietly reorder rotation.
   */
  tier: z.enum(["free", "paid"]).default("paid"),
  enabled: z.boolean().default(true),
});

export type LlmKeyEntry = z.infer<typeof llmKeySchema>;

const routeTargetSchema = z.object({
  provider: providerEnum,
  model: z.string().default(""),
});

const routeSchema = routeTargetSchema.extend({
  /** Another model, or another provider entirely — both are real fallbacks. */
  fallbacks: z.array(routeTargetSchema).max(4).default([]),
});

export const aiConfigSchema = z
  .object({
    // The default pair — also the v1 fields, kept at the top level for compatibility.
    provider: providerEnum.default("gemini"),
    model: z.string().default(LLM_DEFAULT_MODELS.gemini),
    apiKey: z.string().default(""),
    enabled: z.boolean().default(false),

    keys: z.record(providerEnum, z.array(llmKeySchema)).default({}),
    /** Spend free-tier keys before metered ones. Only Gemini can hold a mix. */
    preferFreeFirst: z.boolean().default(true),
    fallbacks: z.array(routeTargetSchema).max(4).default([]),
    routes: z.record(z.enum(LLM_ACTIONS), routeSchema).default({}),
  })
  .transform((cfg) => {
    // Only Gemini has a free tier, so no other provider's key may claim one — otherwise
    // free-first ordering would be driven by a value that means nothing there.
    const keys: Partial<Record<LlmProvider, LlmKeyEntry[]>> = {};
    for (const [provider, list] of Object.entries(cfg.keys ?? {})) {
      keys[provider as LlmProvider] = (list ?? []).map((k) => ({
        ...k,
        tier: provider === "gemini" ? k.tier : "paid",
      }));
    }
    return { ...cfg, keys };
  });

export type AiConfig = z.infer<typeof aiConfigSchema>;

export function emptyAiConfig(): AiConfig {
  return aiConfigSchema.parse({});
}

export function coerceAiConfig(raw: unknown): AiConfig {
  const parsed = aiConfigSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : emptyAiConfig();
}

export const PROVIDERS: LlmProvider[] = ["gemini", "anthropic", "openai"];

/** Keys entered for a provider, in the operator's order (never undefined). */
export function keysForProvider(cfg: AiConfig, provider: LlmProvider): LlmKeyEntry[] {
  return cfg.keys?.[provider] ?? [];
}

/**
 * Point the legacy flat `apiKey` at the first usable key of the default provider, so an
 * older extension build (and the extension popup) still finds a key where it expects
 * one. Free keys lead, matching rotation order, so the mirror is the key that would
 * actually be tried first. With no keys in the list, whatever v1 `apiKey` was already
 * stored is left alone — a half-migrated account must not lose its only key.
 */
export function withLegacyMirror(cfg: AiConfig): AiConfig {
  const list = keysForProvider(cfg, cfg.provider).filter((k) => k.key && k.enabled);
  const preferred = cfg.preferFreeFirst
    ? [...list].sort((a, b) => (a.tier === "free" ? 0 : 1) - (b.tier === "free" ? 0 : 1))
    : list;
  return preferred.length ? { ...cfg, apiKey: preferred[0].key } : cfg;
}

/** Total usable keys across every provider — drives the page's empty state. */
export function totalUsableKeys(cfg: AiConfig): number {
  return PROVIDERS.reduce((n, p) => n + keysForProvider(cfg, p).filter((k) => k.key && k.enabled).length, 0);
}
