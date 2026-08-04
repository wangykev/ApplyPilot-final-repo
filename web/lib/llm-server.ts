import "server-only";

import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { callLLMForAction, llmCostUsd, type LlmResult } from "@/lib/llm";
import { classifyLlmFailure, type LlmActionInput } from "@/lib/llm-keys";

/**
 * Server-side model calls that RECORD themselves into llm_calls (the /app/usage tracker).
 *
 * Why this is a separate module and not part of lib/llm.ts: llm.ts is isomorphic — the AI
 * settings page imports LLM_MODELS and the pricing tables from it into the CLIENT bundle.
 * Importing the Supabase server client there would drag server-only code into the browser
 * build. `server-only` at the top makes that mistake a build error rather than a mystery.
 *
 * Recording NEVER affects the call: the result is returned exactly as callLLMForAction gave
 * it, and a failed insert is swallowed. Losing a usage row is a gap in a chart; failing a
 * cover letter because the ledger was unavailable would be absurd.
 */

type RecordInput = {
  provider: string;
  model: string;
  action: string;
  keyId?: string;
  keyTier?: "free" | "paid";
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  ok: boolean;
  errorCode?: string;
  source?: "web" | "extension";
};

export async function recordLlmCall(input: RecordInput): Promise<void> {
  if (!isSupabaseConfigured()) return;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    await supabase.from("llm_calls").insert({
      user_id: user.id,
      provider: input.provider,
      model: input.model,
      action: input.action,
      key_id: input.keyId ?? null,
      key_tier: input.keyTier ?? null,
      tokens_in: input.tokensIn,
      tokens_out: input.tokensOut,
      // null is meaningful here — see the migration. It means "rate unknown", not "free".
      cost_usd: input.costUsd,
      ok: input.ok,
      error_code: input.errorCode ?? null,
      source: input.source ?? "web",
    });
  } catch {
    /* a missing usage row must never cost the operator their answer */
  }
}

/**
 * Drop-in replacement for callLLMForAction that writes a usage row for every attempt.
 * One place, so all three server callers (resume parse, cover letter, teach) are covered
 * without each repeating the bookkeeping.
 *
 * A FAILED call is recorded too, with its classified error code: a run of quota/rate_limit
 * failures is precisely the signal that a key is spent, and dropping those rows would hide
 * the pattern the tracker exists to show.
 */
export async function callLLMTracked(
  config: unknown,
  action: LlmActionInput,
  prompt: { system?: string; user: string; maxTokens?: number }
): Promise<LlmResult> {
  const res = await callLLMForAction(config, action, prompt);

  // The route actually taken isn't known until the call returns — rotation and the fallback
  // chain can land somewhere other than the primary — so the row is built from the RESULT.
  if (res.ok) {
    await recordLlmCall({
      provider: res.provider ?? "",
      model: res.model ?? "",
      action: String(action),
      keyId: res.keyId,
      keyTier: res.keyTier,
      tokensIn: res.usage.input,
      tokensOut: res.usage.output,
      costUsd: llmCostUsd(res.model ?? "", res.usage, res.keyTier),
      ok: true,
    });
  } else {
    // On failure there is no usage and no attributable key — callLLMForAction has already
    // walked every attempt. Record the classified reason so the page can show WHY.
    const verdict = classifyLlmFailure({ status: res.status, body: res.body, networkError: res.networkError });
    await recordLlmCall({
      provider: "",
      model: "",
      action: String(action),
      tokensIn: 0,
      tokensOut: 0,
      costUsd: null,
      ok: false,
      errorCode: verdict.code,
    });
  }
  return res;
}
