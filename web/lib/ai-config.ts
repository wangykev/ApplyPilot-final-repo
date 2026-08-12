import { z } from "zod";
import { LLM_DEFAULT_MODELS, type LlmProvider } from "@/lib/llm";
import { LLM_ACTIONS, type LlmAction } from "@/lib/llm-keys";

/**
 * Mirrors the extension's chrome.storage.local `llmConfig` (see WEBSITE.md → Data
 * contracts). v2 adds three things to the original flat shape:
 *
 *   keys      — MANY keys per provider, tried in order, so one hitting its limit doesn't
 *               stop a fill. Free keys lead (see `preferFreeFirst`).
 *   routes    — a provider+model per ACTION (fill / essay / resume parse / cover letter),
 *               each with its own fallback chain. Unset = follow the default pair. `teach`
 *               is not a row — it is aliased to `fill` in llm-keys.
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
  /**
   * Claude thinking, per ROUTE rather than per model — the same model wants deliberation
   * for an essay and none for a yes/no. Defaults OFF: that is the cheaper, faster answer
   * and matches how every call behaved before this existed. Ignored for models that can't
   * take the parameter (see ANTHROPIC_THINKING_ADJUSTABLE).
   */
  thinking: z.enum(["off", "adaptive", "manual"]).default("off"),
  /** Only used when thinking === "manual"; ignored (and unsent) otherwise. */
  effort: z.string().default(""),
  /**
   * PIN THIS SLOT TO ONE KEY (2026-08-11, operator). Empty = today's behaviour: any key for
   * the provider, in rotation order.
   *
   * WHY it exists: Gemini's free tier is **15 requests/minute PER KEY**, and rotation only
   * moves to the next key when one FAILS. So two equal free keys still funnel every call
   * through the first — measured live, 6 consecutive calls all used key 1 while key 2 sat
   * idle — and a fill doing ~16 calls/min breaches a 15/min limit while holding 30/min of
   * headroom. Pinning the primary to key A and its fallback to key B spends both.
   *
   * The pin is STRICT for the slot (that is the whole point — an isolated budget), and
   * resilience comes from the NEXT slot having its own key. An id that no longer matches a
   * stored key is IGNORED rather than obeyed, so deleting a key degrades to rotation
   * instead of silently disabling the slot.
   */
  keyId: z.string().default(""),
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
    thinking: z.enum(["off", "adaptive", "manual"]).default("off"),
    effort: z.string().default(""),
    /** Pin the DEFAULT slot to one key — same semantics as routeTargetSchema.keyId. */
    keyId: z.string().default(""),
    apiKey: z.string().default(""),
    enabled: z.boolean().default(false),

    keys: z.record(providerEnum, z.array(llmKeySchema)).default({}),
    /** Spend free-tier keys before metered ones. Only Gemini can hold a mix. */
    preferFreeFirst: z.boolean().default(true),
    fallbacks: z.array(routeTargetSchema).max(4).default([]),
    // Keyed permissively, then filtered to LLM_ACTIONS in the transform. An id can stop
    // being routable (teach now rides fill), and a stored route for it must be DROPPED
    // rather than fail validation and take the whole config down with it.
    routes: z.record(z.string(), routeSchema).default({}),
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
    const routes: Partial<Record<LlmAction, z.infer<typeof routeSchema>>> = {};
    for (const [action, route] of Object.entries(cfg.routes ?? {})) {
      if ((LLM_ACTIONS as readonly string[]).includes(action)) routes[action as LlmAction] = route;
    }
    return { ...cfg, keys, routes };
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
