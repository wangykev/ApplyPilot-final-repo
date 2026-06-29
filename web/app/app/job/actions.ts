"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";

const jobContextSchema = z.object({ company: z.string().default("") });
export type JobContext = z.infer<typeof jobContextSchema>;

export type SaveResult = { ok: true } | { ok: false; error: string };

export async function saveJobContext(raw: unknown): Promise<SaveResult> {
  const parsed = jobContextSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Job context didn't validate." };

  if (!isSupabaseConfigured()) {
    return { ok: false, error: "Backend not connected — set Supabase env vars to save (see WEBSITE.md)." };
  }
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "You're not signed in." };

    const { error } = await supabase
      .from("profiles")
      .upsert({ id: user.id, job_context_json: parsed.data }, { onConflict: "id" });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not reach the backend." };
  }
}
