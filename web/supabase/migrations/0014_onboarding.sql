-- New-user setup flow (/app/start) — progress that cannot be derived from live data.
--
-- Almost every step IS derivable and so is NOT stored: "has a resume" is a resumes row,
-- "has an AI key" is a usable key in ai_config. Deriving them means a step can never claim
-- to be done after the thing it describes was deleted.
--
-- Two facts have no such source, and are all this column holds:
--   profile_approved_at  the human pressed "This is right" on their profile. An ACT, not a
--                        readable fact — a filled-in profile is not the same as a reviewed one.
--   completed_at         the flow was finished. Sticky, so swapping your resume later never
--                        drops you back into a setup wizard mid-task.
--
-- Shape (lib/onboarding.ts, coerceOnboarding tolerates anything else):
--   { "version": 1, "profile_approved_at": "…Z"|null, "completed_at": "…Z"|null }
-- NULL / absent = never started, which is exactly what a brand-new row means.
-- RLS is inherited from the existing owner-only policies on public.profiles.

alter table public.profiles
  add column if not exists onboarding_json jsonb;
