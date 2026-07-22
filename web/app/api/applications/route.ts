import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Lightweight JSON list of the signed-in user's applications — POLLED by the tracker so a fill the
 * extension just reported shows up WITHOUT an F5 (the client patches its list in place; no page reload,
 * no server-component re-render). Mirrors the tracker server page's loadApplications query (same
 * columns + order). Cookie-authed (same-origin fetch sends the Supabase session automatically).
 *
 * Returns ok:false when the backend isn't configured / not signed in — so the poller LEAVES the current
 * list untouched (never clobbers dev-preview sample data or a transient auth blip with an empty array).
 */
export async function GET() {
  if (!isSupabaseConfigured()) return NextResponse.json({ ok: false, reason: "not-configured" });
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ ok: false, reason: "not-signed-in" }, { status: 401 });
    const { data, error } = await supabase
      .from("applications")
      .select("id, company, role, url, status, needs_review_count, applied_at, created_at")
      .eq("user_id", user.id)
      .is("deleted_at", null) // hide soft-deleted apps from the tracker (bundles still feed teach)
      .order("created_at", { ascending: false });
    if (error) return NextResponse.json({ ok: false, reason: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, applications: data ?? [] });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: e instanceof Error ? e.message : "error" }, { status: 500 });
  }
}
