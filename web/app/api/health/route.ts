import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Setup health check — hit /api/health after wiring Supabase to confirm the env
 * is present and the schema is reachable. Safe: no secrets returned, only booleans.
 */
export async function GET() {
  const env = {
    supabase_url_set: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
    supabase_anon_set: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    service_role_set: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    site_url: process.env.NEXT_PUBLIC_SITE_URL ?? null,
  };

  if (!isSupabaseConfigured()) {
    return NextResponse.json({
      ok: false,
      configured: false,
      env,
      hint: "Set NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY in web/.env.local, then restart the dev server. See SETUP.md.",
    });
  }

  let schema_ok = false;
  let schema_error: string | null = null;
  try {
    const supabase = await createClient();
    // A table created by the migration. RLS returns [] for an anon caller — no
    // error means the table (and thus the migration) exists.
    const { error } = await supabase.from("profiles").select("id").limit(1);
    if (error) schema_error = error.message;
    else schema_ok = true;
  } catch (e) {
    schema_error = e instanceof Error ? e.message : String(e);
  }

  return NextResponse.json({
    ok: schema_ok,
    configured: true,
    schema_ok,
    schema_error,
    env,
    hint: schema_ok
      ? "Backend reachable. If sign-in fails, check Auth providers + redirect URLs in SETUP.md."
      : "Configured but the schema isn't reachable — run web/supabase/migrations/0001_init.sql in the Supabase SQL editor.",
  });
}
