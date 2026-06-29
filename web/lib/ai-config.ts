import { z } from "zod";
import { LLM_DEFAULT_MODELS, type LlmProvider } from "@/lib/llm";

/** Mirrors the extension's chrome.storage.local `llmConfig`. */
export const aiConfigSchema = z.object({
  provider: z.enum(["anthropic", "gemini", "openai"]).default("gemini"),
  model: z.string().default(LLM_DEFAULT_MODELS.gemini),
  apiKey: z.string().default(""),
  enabled: z.boolean().default(false),
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
