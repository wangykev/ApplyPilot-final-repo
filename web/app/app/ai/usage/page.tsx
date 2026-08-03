import { PageHeader } from "@/components/app/PageHeader";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { coerceAiConfig, keysForProvider, PROVIDERS } from "@/lib/ai-config";
import { GEMINI_FREE_TIER } from "@/lib/llm";
import { UsagePanel, type UsageRow, type QuotaRow } from "./UsagePanel";

export const dynamic = "force-dynamic";

const WINDOW_DAYS = 30;

async function load(): Promise<{ rows: UsageRow[]; quota: QuotaRow[] }> {
  if (!isSupabaseConfigured()) return { rows: [], quota: [] };
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { rows: [], quota: [] };

    const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
    const { data } = await supabase
      .from("llm_calls")
      .select("provider, model, action, key_tier, tokens_in, tokens_out, cost_usd, ok, error_code, source, created_at")
      .eq("user_id", user.id)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(5000);

    const rows: UsageRow[] = (data ?? []).map((r) => ({
      provider: r.provider ?? "",
      model: r.model ?? "",
      action: r.action ?? "",
      keyTier: r.key_tier ?? null,
      tokensIn: r.tokens_in ?? 0,
      tokensOut: r.tokens_out ?? 0,
      // Postgres numeric arrives as a string; null stays null, because null means "rate
      // unknown" and must never be coerced to 0 (see migration 0013).
      costUsd: r.cost_usd == null ? null : Number(r.cost_usd),
      ok: r.ok !== false,
      errorCode: r.error_code ?? null,
      source: r.source ?? "web",
      createdAt: r.created_at,
    }));

    // The free-tier quota view needs the CAP per model, which lives in the config +
    // GEMINI_FREE_TIER — not in the ledger. Only Gemini models the operator actually holds
    // a FREE key for have a daily limit worth showing.
    const { data: prof } = await supabase.from("profiles").select("ai_config").eq("id", user.id).maybeSingle();
    const cfg = coerceAiConfig(prof?.ai_config);
    const hasFreeGemini = keysForProvider(cfg, "gemini").some((k) => k.key && k.enabled && k.tier === "free");

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todayMs = startOfDay.getTime();

    const quota: QuotaRow[] = hasFreeGemini
      ? Object.entries(GEMINI_FREE_TIER).map(([model, limits]) => ({
          model,
          rpd: limits.rpd,
          rpm: limits.rpm,
          usedToday: rows.filter((r) => r.model === model && r.ok && new Date(r.createdAt).getTime() >= todayMs).length,
        }))
      : [];

    return { rows, quota };
  } catch {
    return { rows: [], quota: [] };
  }
}

export default async function UsagePage() {
  const { rows, quota } = await load();
  const configured = PROVIDERS.length > 0;
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Engine"
        title="AI usage"
        description="Every model call ApplyPilot makes, what it cost, and how much of your free Gemini allowance is left today."
      />
      <UsagePanel rows={rows} quota={quota} windowDays={WINDOW_DAYS} configured={configured} />
    </div>
  );
}
