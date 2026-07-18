-- Teach flow — persistently-dismissed cards.
-- A jsonb array of normalized question keys the user SKIPPED on /app/teach, so a skipped card
-- never reappears (teachableCards excludes them). NULL / absent = nothing dismissed yet.
-- RLS is inherited from the existing owner-only policies on public.profiles.

alter table public.profiles
  add column if not exists teach_dismissed_json jsonb;
