/**
 * New-user setup flow (`/app/start`) — the PURE state model.
 *
 * A new account can't do anything useful until three things exist: a resume to attach, a
 * profile that has been LOOKED AT by a human, and an API key so the extension can answer
 * what the deterministic matcher can't. So a signed-in user with any of them missing is
 * routed into the flow instead of a dashboard whose every button would fail.
 *
 * Everything here is pure and unit-pinned (`test/onboarding.test.ts`). Three places ask
 * "is this user set up?" — the middleware gate, the `/app/start` page, and the server
 * actions that record progress — and they MUST agree, or the flow either traps a finished
 * user or waves an unfinished one through.
 *
 * Step completion is DERIVED FROM REAL DATA wherever it can be (a resume row exists; a
 * usable key exists), never from a flag someone set once. The one exception is the profile
 * step: "I have reviewed this" is an act, not a fact you can read off a row, so it is the
 * only thing this module stores.
 */

/** Bumped only if the step SET changes — a stored record from an older set is re-derived. */
export const ONBOARDING_VERSION = 1;

export const ONBOARDING_STEPS = ["resume", "profile", "ai"] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number];

/** What `profiles.onboarding_json` holds. Timestamps are ISO strings; null = not yet. */
export type OnboardingRecord = {
  version: number;
  /** The human pressed "This is right" on their profile. Not derivable — hence stored. */
  profile_approved_at: string | null;
  /** The flow was finished. Sticky: see `onboardingStatus`. */
  completed_at: string | null;
};

export function emptyOnboarding(): OnboardingRecord {
  return { version: ONBOARDING_VERSION, profile_approved_at: null, completed_at: null };
}

/** Tolerant read of whatever is in the column — a bad/absent blob is "not started", never a throw. */
export function coerceOnboarding(raw: unknown): OnboardingRecord {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyOnboarding();
  const r = raw as Record<string, unknown>;
  const iso = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  const version = typeof r.version === "number" ? r.version : ONBOARDING_VERSION;
  // A record written against an older step set can't be trusted to mean the same thing,
  // so its progress is dropped and the flow re-derives from live data.
  if (version !== ONBOARDING_VERSION) return emptyOnboarding();
  return {
    version,
    profile_approved_at: iso(r.profile_approved_at),
    completed_at: iso(r.completed_at),
  };
}

/**
 * The live facts each step is judged against. Gathered by the caller (the middleware reads
 * the cheap ones; the page reads all of them) so this module stays free of any I/O.
 */
export type OnboardingFacts = {
  /** A stored default resume exists. */
  hasResume: boolean;
  /** `onboarding_json.profile_approved_at`. */
  profileApprovedAt: string | null;
  /** Usable (non-empty, enabled) API keys across every provider. */
  usableKeys: number;
  /** `onboarding_json.completed_at`. */
  completedAt: string | null;
};

export function stepDone(step: OnboardingStepId, facts: OnboardingFacts): boolean {
  switch (step) {
    case "resume":
      return facts.hasResume;
    case "profile":
      return !!facts.profileApprovedAt;
    case "ai":
      return facts.usableKeys > 0;
  }
}

export type OnboardingStatus = {
  steps: { id: OnboardingStepId; done: boolean }[];
  /** The first unfinished step — where the flow opens. `null` once every step is done. */
  currentStep: OnboardingStepId | null;
  doneCount: number;
  /** Nothing left to do: every step done, or the flow was finished before. */
  complete: boolean;
};

/**
 * `complete` is STICKY once the flow has been finished.
 *
 * Deliberate: the steps are derived from live data, so a user who later removes their
 * resume to upload a different one would otherwise be yanked out of whatever they were
 * doing and back into a setup wizard. Onboarding is a one-time introduction, not a
 * standing constraint — the places that genuinely need a resume or a key check for
 * themselves and say so.
 */
export function onboardingStatus(facts: OnboardingFacts): OnboardingStatus {
  const steps = ONBOARDING_STEPS.map((id) => ({ id, done: stepDone(id, facts) }));
  const doneCount = steps.filter((s) => s.done).length;
  const allDone = doneCount === steps.length;
  return {
    steps,
    currentStep: steps.find((s) => !s.done)?.id ?? null,
    doneCount,
    complete: allDone || !!facts.completedAt,
  };
}

/* ── Step 3: does this account have a usable key? ────────────────────────────── */

/**
 * Count usable API keys straight off a RAW stored `ai_config`, with no zod and no
 * provider tables — the middleware runs on the edge and reads the jsonb column directly,
 * and a schema parse there would pull the whole AI config module into that bundle.
 *
 * Counts the LEGACY flat `apiKey` too when the v2 `keys` map holds nothing. That is the
 * difference from `totalUsableKeys` (lib/ai-config.ts), which only sees `keys` because the
 * AI page's own warning is about the rotation list. An account that configured a key
 * before multi-key shipped has a perfectly good key, and must not be dragged back through
 * setup to re-enter it.
 */
export function countUsableKeys(rawAiConfig: unknown): number {
  if (!rawAiConfig || typeof rawAiConfig !== "object") return 0;
  const cfg = rawAiConfig as Record<string, unknown>;

  let n = 0;
  const keys = cfg.keys;
  if (keys && typeof keys === "object" && !Array.isArray(keys)) {
    for (const list of Object.values(keys as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        if (!entry || typeof entry !== "object") continue;
        const e = entry as Record<string, unknown>;
        // `enabled` absent means on — that is the schema default, and treating an older
        // record without the field as "off" would report a working setup as empty.
        if (typeof e.key === "string" && e.key.trim() && e.enabled !== false) n++;
      }
    }
  }
  if (n === 0 && typeof cfg.apiKey === "string" && cfg.apiKey.trim()) n = 1;
  return n;
}

/* ── Step 2: what "approve your profile" requires ────────────────────────────── */

/**
 * Approving a profile that holds nothing would record a review that never happened, and
 * the first application would then fail on the most basic fields. So the approve action
 * is gated on the three things EVERY application asks for, and nothing beyond them —
 * a longer list would block people whose remaining details genuinely vary.
 *
 * Checked on the client (to disable the button and name what's missing) and again in the
 * server action, through this one function.
 */
export type ApprovalGap = { path: string; label: string };

const EMAIL_RE = /\S+@\S+\.\S+/;

/** Structural, so the middleware/tests don't need the zod Profile type to ask this. */
export type ApprovableProfile = {
  personal_info?: {
    first_name?: string | null;
    last_name?: string | null;
    email?: string | null;
  } | null;
};

export function missingForApproval(profile: ApprovableProfile | null | undefined): ApprovalGap[] {
  const pi = profile?.personal_info ?? {};
  const text = (v: unknown) => String(v ?? "").trim();
  const gaps: ApprovalGap[] = [];
  if (!text(pi.first_name)) gaps.push({ path: "personal_info.first_name", label: "First name" });
  if (!text(pi.last_name)) gaps.push({ path: "personal_info.last_name", label: "Last name" });
  if (!EMAIL_RE.test(text(pi.email))) gaps.push({ path: "personal_info.email", label: "Email address" });
  return gaps;
}

export function profileReadyForApproval(profile: ApprovableProfile | null | undefined): boolean {
  return missingForApproval(profile).length === 0;
}

/* ── The "already onboarded" cookie ──────────────────────────────────────────── */

/**
 * Set once the flow is finished so the middleware can wave the user through WITHOUT a
 * database round trip on every `/app/*` request (including RSC prefetches).
 *
 * The value is the USER ID, not a bare "1": two accounts share a browser, and a flag that
 * only said "somebody here finished" would skip a brand-new user's setup entirely. It is a
 * pure fast-path — it can only ever skip the redirect, never grant access to anything, so a
 * stale or forged cookie costs a missed wizard and nothing else.
 */
export const ONBOARDED_COOKIE = "ap_onboarded";
export const ONBOARDED_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function onboardedCookieMatches(value: string | undefined, userId: string): boolean {
  return !!value && !!userId && value === userId;
}

/** The one route the gate must never redirect away from, or it would loop. */
export const ONBOARDING_PATH = "/app/start";
