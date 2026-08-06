import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { SUPABASE_URL, SUPABASE_ANON_KEY, DEV_PREVIEW } from "@/lib/env";
import {
  ONBOARDED_COOKIE,
  ONBOARDED_COOKIE_MAX_AGE,
  ONBOARDING_PATH,
  coerceOnboarding,
  countUsableKeys,
  onboardedCookieMatches,
  onboardingStatus,
} from "@/lib/onboarding";

type CookieToSet = { name: string; value: string; options: CookieOptions };

/**
 * Refreshes the Supabase session on each request and guards /app/*. If Supabase
 * isn't configured yet, the middleware passes through (the landing page and the
 * "not configured" login notice still work).
 */
export async function middleware(request: NextRequest) {
  // Dev preview (hard-gated, dead in prod) and unconfigured backend both pass through.
  if (DEV_PREVIEW) return NextResponse.next();
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return NextResponse.next();

  let response = NextResponse.next({ request });

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  if (!user && path.startsWith("/app")) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }

  /**
   * New-user setup gate. A fresh account has no resume, no reviewed profile and no API
   * key, so every button on the deck would fail — send it to the flow instead of letting
   * it discover that one failure at a time. The flow's own route is never redirected (that
   * would loop), and neither is anything outside /app (the matcher below only covers /app).
   */
  if (user && path.startsWith("/app") && !path.startsWith(ONBOARDING_PATH)) {
    const cookie = request.cookies.get(ONBOARDED_COOKIE)?.value;
    // The cookie is a pure fast-path: it can only SKIP the redirect, never grant access, so
    // a stale one costs a missed wizard and nothing more. Keyed to the user id because two
    // accounts share a browser.
    if (!onboardedCookieMatches(cookie, user.id)) {
      const state = await onboardingState(supabase, user.id);
      if (state === "incomplete") {
        const url = request.nextUrl.clone();
        url.pathname = ONBOARDING_PATH;
        url.search = "";
        // Where they were headed, so the flow can hand them back at the end.
        if (path !== "/app") url.searchParams.set("next", path);
        return NextResponse.redirect(url);
      }
      // ONLY on a positive answer. "unknown" must not write the cookie: a database that
      // hasn't had migration 0014 applied answers "unknown" for everyone, and caching that
      // would permanently wave every user past the gate — including after the migration
      // lands. An unknown simply passes through and asks again next request.
      if (state === "complete") {
        response.cookies.set(ONBOARDED_COOKIE, user.id, {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: request.nextUrl.protocol === "https:",
          maxAge: ONBOARDED_COOKIE_MAX_AGE,
        });
      }
    }
  }

  return response;
}

/**
 * Is this user through setup? Read from LIVE data (a stored resume, a usable key) plus the
 * one thing that can't be derived — that they approved their profile. `onboardingStatus`
 * is shared with the page and the server actions so all three agree.
 *
 * Runs only when the cookie above is absent, so in the steady state it never runs at all.
 *
 * "unknown" is a real answer, not an error swallowed. A read can fail because the database
 * hiccuped, or because migration 0014 hasn't been applied yet so `onboarding_json` doesn't
 * exist — and in that second case progress CANNOT be recorded, so forcing the flow would
 * trap every user in a wizard they can't finish. Both cases pass through: the flow is an
 * introduction, not a security boundary, and every page still works without it.
 */
type OnboardingState = "complete" | "incomplete" | "unknown";

async function onboardingState(
  supabase: ReturnType<typeof createServerClient>,
  userId: string
): Promise<OnboardingState> {
  try {
    const [onboardingRes, aiRes, resumeRes] = await Promise.all([
      supabase.from("profiles").select("onboarding_json").eq("id", userId).maybeSingle(),
      supabase.from("profiles").select("ai_config").eq("id", userId).maybeSingle(),
      supabase.from("resumes").select("id").eq("user_id", userId).eq("kind", "default").limit(1),
    ]);
    if (onboardingRes.error || aiRes.error || resumeRes.error) return "unknown";

    const record = coerceOnboarding(onboardingRes.data?.onboarding_json);
    const complete = onboardingStatus({
      hasResume: (resumeRes.data?.length ?? 0) > 0,
      profileApprovedAt: record.profile_approved_at,
      usableKeys: countUsableKeys(aiRes.data?.ai_config),
      completedAt: record.completed_at,
    }).complete;
    return complete ? "complete" : "incomplete";
  } catch {
    return "unknown";
  }
}

export const config = {
  matcher: ["/app/:path*"],
};
