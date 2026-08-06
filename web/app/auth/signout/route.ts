import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ONBOARDED_COOKIE } from "@/lib/onboarding";

export async function POST(request: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  const response = NextResponse.redirect(new URL("/", request.url), { status: 303 });
  // The setup-gate fast-path belongs to the account that just left. It is keyed to a user
  // id so a leftover copy is already harmless, but there's no reason to keep it around.
  response.cookies.delete(ONBOARDED_COOKIE);
  return response;
}
