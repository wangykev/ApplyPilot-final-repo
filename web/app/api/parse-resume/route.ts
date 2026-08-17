import { NextResponse } from "next/server";
import { extractText, getDocumentProxy } from "unpdf";
import { createClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";
import { coerceAiConfig, totalUsableKeys } from "@/lib/ai-config";
import { callLLMTracked } from "@/lib/llm-server";
import { bulletizeRoleDescriptions } from "@/lib/resume-prompt";
import { buildResumePrompt, parseProfileFromReply } from "@/lib/resume-prompt";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return bad("Expected a multipart upload.", 400);
  }
  const file = form.get("file");
  if (!(file instanceof File)) return bad("No file provided.", 400);
  if (file.type && !file.type.includes("pdf")) return bad("Please upload a PDF.", 400);

  if (!isSupabaseConfigured()) return bad("Backend not connected — set Supabase env vars (see WEBSITE.md).", 400);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad("You're not signed in.", 401);

  const { data: row } = await supabase
    .from("profiles")
    .select("ai_config")
    .eq("id", user.id)
    .maybeSingle();
  const ai = coerceAiConfig(row?.ai_config);
  // totalUsableKeys, not ai.apiKey: with the multi-key config a v2 account can have
  // several keys and an empty legacy mirror, and rejecting it here would be wrong.
  if (!totalUsableKeys(ai)) return bad("Add an API key on the AI page before parsing.", 400);

  // --- extract text ---
  let text = "";
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const pdf = await getDocumentProxy(buf);
    const r = await extractText(pdf, { mergePages: true });
    text = Array.isArray(r.text) ? r.text.join("\n") : r.text;
  } catch (e) {
    return bad("Could not read the PDF: " + msg(e), 400);
  }
  if (!text.trim()) return bad("No text found in the PDF — is it a scanned image?", 400);

  // --- LLM extraction ---
  const { system, user: prompt } = buildResumePrompt(text);
  // "resume_parse" picks this action's model (falling back to the default pair), then
  // rotates through that provider's keys.
  // ⚠ 4096 was sized for SUMMARISED role descriptions. Now that every bullet comes back verbatim the
  // reply is materially longer, and a truncated reply is indistinguishable from a bad parse — it
  // simply arrives with the tail missing, which looks exactly like the dropped-bullet bug this
  // change fixes. Headroom is far cheaper than a silently short profile.
  const res = await callLLMTracked(ai, "resume_parse", { system, user: prompt, maxTokens: 12000 });
  if (!res.ok) return bad("AI request failed: " + res.error, 502);

  const profile = parseProfileFromReply(res.text);
  if (!profile) return bad("The model's reply wasn't valid JSON. Try parsing again.", 502);

  return NextResponse.json({ ok: true, profile: bulletizeRoleDescriptions(profile) });
}


function bad(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}
function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
