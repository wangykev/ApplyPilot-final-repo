import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashApiKey } from "@/lib/api-key";
import { isSupabaseConfigured } from "@/lib/env";

export const runtime = "nodejs";

/**
 * Usage ingest for the EXTENSION's model calls (/app/usage).
 *
 * Why this route has to exist: the form fill is by far the highest-volume caller — one
 * application asks dozens of screening questions — and it runs in the extension's service
 * worker, which has no database access. Without this, the tracker would show only the three
 * server-side callers and understate real usage by an order of magnitude.
 *
 * Auth is the same per-user ingest key the tracker report uses (`api_keys.key_hash`), so the
 * extension needs no session and this endpoint can never write to another user's rows: the
 * user_id comes from the key lookup, never from the payload.
 *
 * BATCHED on purpose. A fill makes tens of calls; one POST per call would add a network
 * round trip to every field. The extension buffers and flushes, so this takes an array.
 */

const MAX_ROWS = 200;

// Mirrors llm-keys.js classifyLlmFailure's codes. Anything unrecognised is stored as
// "unknown" rather than rejected — losing a usage row over an unexpected label would be a
// worse outcome than an imprecise one.
const ERROR_CODES = new Set(["auth", "quota", "rate_limit", "provider_down", "bad_request", "not_found", "unknown"]);

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const text = (v: unknown, max = 120) => (typeof v === "string" ? v.slice(0, max) : "");

export async function POST(req: Request) {
  if (!isSupabaseConfigured()) return j({ ok: false, error: "Backend not configured." }, 503);

  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return j({ ok: false, error: "Missing bearer key." }, 401);
  const key = m[1].trim();

  let body: { calls?: unknown };
  try {
    body = (await req.json()) as { calls?: unknown };
  } catch {
    return j({ ok: false, error: "Bad JSON." }, 400);
  }
  const calls = Array.isArray(body.calls) ? body.calls.slice(0, MAX_ROWS) : null;
  if (!calls || !calls.length) return j({ ok: false, error: "No calls[] in payload." }, 400);

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return j({ ok: false, error: "Service role not configured." }, 503);
  }

  const { data: row } = await admin.from("api_keys").select("user_id").eq("key_hash", hashApiKey(key)).maybeSingle();
  if (!row) return j({ ok: false, error: "Invalid key." }, 401);

  const rows = calls
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
    .map((c) => {
      const errorCode = text(c.error_code, 24);
      return {
        // From the KEY, never the payload — a client can't attribute usage to someone else.
        user_id: row.user_id,
        provider: text(c.provider, 32),
        model: text(c.model),
        action: text(c.action, 32) || "fill",
        key_id: text(c.key_id, 64) || null,
        key_tier: c.key_tier === "free" || c.key_tier === "paid" ? c.key_tier : null,
        tokens_in: num(c.tokens_in),
        tokens_out: num(c.tokens_out),
        // null is preserved deliberately: it means "rate unknown", not free (migration 0013).
        cost_usd: typeof c.cost_usd === "number" && Number.isFinite(c.cost_usd) ? c.cost_usd : null,
        ok: c.ok !== false,
        error_code: ERROR_CODES.has(errorCode) ? errorCode : errorCode ? "unknown" : null,
        source: "extension" as const,
        // The extension timestamps each call, so a batch flushed after a long run keeps the
        // real per-call times instead of collapsing onto the flush moment. Bad values fall
        // back to the server clock.
        created_at: isoOrNow(c.created_at),
      };
    });

  const { error } = await admin.from("llm_calls").insert(rows);
  if (error) return j({ ok: false, error: error.message }, 500);
  return j({ ok: true, inserted: rows.length });
}

function isoOrNow(v: unknown): string {
  if (typeof v === "string") {
    const t = Date.parse(v);
    // Reject clock skew far outside a plausible window rather than trusting the client.
    if (Number.isFinite(t) && Math.abs(t - Date.now()) < 7 * 86_400_000) return new Date(t).toISOString();
  }
  return new Date().toISOString();
}

function j(payload: unknown, status = 200) {
  return NextResponse.json(payload, { status });
}
