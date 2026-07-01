"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { parseUrls } from "./shared";

type QueueResult = { ok: true; added: number } | { ok: false; error: string };
type ActionResult = { ok: true } | { ok: false; error: string };

async function ctx() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

export async function addQueueItems(text: string): Promise<QueueResult> {
  const urls = parseUrls(text);
  if (urls.length === 0) return { ok: false, error: "No valid URLs found. Paste full https:// links." };
  if (!isSupabaseConfigured()) return { ok: false, error: "Backend not connected — set Supabase env vars (see WEBSITE.md)." };
  try {
    const { supabase, user } = await ctx();
    if (!user) return { ok: false, error: "You're not signed in." };

    const { data: last } = await supabase
      .from("queue_items")
      .select("position")
      .eq("user_id", user.id)
      .order("position", { ascending: false })
      .limit(1)
      .maybeSingle();
    let pos = (last?.position ?? 0) + 1;

    const rows = urls.map((url) => ({ user_id: user.id, url, status: "pending", position: pos++ }));
    const { error } = await supabase.from("queue_items").insert(rows);
    if (error) return { ok: false, error: error.message };
    revalidatePath("/app/queue");
    return { ok: true, added: rows.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}

export async function removeQueueItem(id: string): Promise<ActionResult> {
  if (!isSupabaseConfigured()) return { ok: false, error: "Backend not connected." };
  try {
    const { supabase, user } = await ctx();
    if (!user) return { ok: false, error: "You're not signed in." };
    const { error } = await supabase.from("queue_items").delete().eq("id", id).eq("user_id", user.id);
    if (error) return { ok: false, error: error.message };
    revalidatePath("/app/queue");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}

export async function clearQueue(): Promise<ActionResult> {
  if (!isSupabaseConfigured()) return { ok: false, error: "Backend not connected." };
  try {
    const { supabase, user } = await ctx();
    if (!user) return { ok: false, error: "You're not signed in." };
    const { error } = await supabase.from("queue_items").delete().eq("user_id", user.id);
    if (error) return { ok: false, error: error.message };
    revalidatePath("/app/queue");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}
