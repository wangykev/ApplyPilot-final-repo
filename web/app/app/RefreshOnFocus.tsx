"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * Soft-refreshes the current app page's SERVER data when the tab regains focus / becomes visible.
 *
 * Why: the extension fills the Workday tab and pushes the review bundle to the site (POST
 * /api/extension/report) in the background — but an already-open tracker/review page won't reflect it
 * until it re-fetches. When the operator switches back to the website tab after a fill, this fires
 * router.refresh(), which re-runs the (force-dynamic) server components and picks up the new bundle —
 * no manual reload. router.refresh() PRESERVES client state, so unsaved form edits (profile / AI
 * config) are NOT lost. Throttled because focus + visibilitychange fire together.
 *
 * This covers the tab-switch case cheaply, with no realtime infra. (A truly live update while the site
 * tab stays focused during a fill would need a Supabase Realtime subscription on `applications`.)
 */
export function RefreshOnFocus() {
  const router = useRouter();
  const last = useRef(0);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - last.current < 1500) return; // focus + visibilitychange both fire — throttle to one
      last.current = now;
      router.refresh();
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [router]);
  return null;
}
