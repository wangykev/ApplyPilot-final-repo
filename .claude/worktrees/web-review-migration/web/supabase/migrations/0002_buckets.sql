-- Profile v2 — answer buckets.
-- One jsonb array of buckets per user (see web/lib/buckets.ts + docs/profile-v2-plan.md).
-- NULL  = never provisioned  → the app seeds STARTER_BUCKETS on first load.
-- '[]'  = provisioned then emptied by the user (never re-seeded).
-- RLS is inherited from the existing owner-only policies on public.profiles.

alter table public.profiles
  add column if not exists buckets_json jsonb;
