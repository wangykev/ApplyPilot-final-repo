-- ApplyPilot Web — CONSOLIDATED schema snapshot.
--
-- This is every file in migrations/ concatenated IN ORDER, for a one-paste setup in the
-- Supabase SQL editor. All statements are idempotent (create ... if not exists / drop ...+create
-- for policies & triggers / add column if not exists / on conflict do nothing), so running this
-- on a FRESH database sets everything up, and re-running it on an EXISTING one is a safe no-op
-- that brings it up to date.
--
-- SOURCE OF TRUTH is still the numbered migrations/ files. After adding a new migration,
-- regenerate this file with:
--     cat web/supabase/migrations/0*.sql > web/supabase/schema.sql   (then re-add this header)
-- Do NOT put this file inside migrations/ (a runner would try to apply it out of order).

-- ============================================================================
-- 0001_init.sql
-- ============================================================================
-- ApplyPilot Web — initial schema.
-- Run in the Supabase SQL editor (or `supabase db push`). RLS is keyed to
-- auth.uid(); every table is private to its owner.

-- ---------------------------------------------------------------- profiles
-- One row per user. Stores ONLY raw profile fields (schema v2.0); the
-- extension's prepareProfile derives *Parsed / bulletsText / _allFluent.
create table if not exists public.profiles (
  id                uuid primary key references auth.users (id) on delete cascade,
  profile_json      jsonb not null default '{}'::jsonb,
  defaults_json     jsonb not null default '{}'::jsonb,
  job_context_json  jsonb not null default '{}'::jsonb,
  ai_config         jsonb not null default '{}'::jsonb,  -- {provider,model,apiKey,enabled}
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles owner" on public.profiles;
create policy "profiles owner" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

-- Seed a profiles row when a new auth user is created.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------- resumes
-- kind='default' is the single resume the extension attaches; 'variant' is an
-- AI-tailored-per-job variant (P5). Bytes live in Supabase Storage.
create table if not exists public.resumes (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  kind          text not null default 'default' check (kind in ('default','variant','source')),
  job_id        uuid,
  filename      text not null,
  mime          text not null default 'application/pdf',
  size          integer not null default 0,
  storage_path  text not null,
  created_at    timestamptz not null default now()
);

alter table public.resumes enable row level security;
drop policy if exists "resumes owner" on public.resumes;
create policy "resumes owner" on public.resumes
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ------------------------------------------------------------ applications
-- Tracker rows. Populated by the extension's report POST (P2).
create table if not exists public.applications (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  company            text,
  role               text,
  url                text,
  status             text not null default 'queued'
                       check (status in ('queued','filling','needs_review','submitted','interviewing','offer','rejected')),
  needs_review_count integer not null default 0,
  review_bundle_json jsonb,
  applied_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

alter table public.applications enable row level security;
drop policy if exists "applications owner" on public.applications;
create policy "applications owner" on public.applications
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ------------------------------------------------------------- queue_items
create table if not exists public.queue_items (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  url         text not null,
  status      text not null default 'pending'
                check (status in ('pending','active','done','error')),
  position    integer not null default 0,
  created_at  timestamptz not null default now()
);

alter table public.queue_items enable row level security;
drop policy if exists "queue owner" on public.queue_items;
create policy "queue owner" on public.queue_items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- --------------------------------------------------------------- reminders
create table if not exists public.reminders (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid not null references public.applications (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  due_at          timestamptz not null,
  note            text,
  done            boolean not null default false,
  created_at      timestamptz not null default now()
);

alter table public.reminders enable row level security;
drop policy if exists "reminders owner" on public.reminders;
create policy "reminders owner" on public.reminders
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------- api_keys
-- The extension ingest credential. Only the hash is stored; the plaintext key
-- is shown once at creation. Validated server-side by the report route (P2).
create table if not exists public.api_keys (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  key_hash      text not null unique,
  label         text,
  last_used_at  timestamptz,
  created_at    timestamptz not null default now()
);

alter table public.api_keys enable row level security;
drop policy if exists "api_keys owner" on public.api_keys;
create policy "api_keys owner" on public.api_keys
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ----------------------------------------------------------- updated_at
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists touch_profiles on public.profiles;
create trigger touch_profiles before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists touch_applications on public.applications;
create trigger touch_applications before update on public.applications
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------ storage bucket
-- Private bucket for resume bytes. Objects are namespaced under the user id:
--   resumes/<auth.uid()>/<filename>
insert into storage.buckets (id, name, public)
values ('resumes', 'resumes', false)
on conflict (id) do nothing;

-- Path-based ownership (Supabase's canonical pattern): objects are namespaced
-- under the user id folder — resumes/<auth.uid()>/<file>. More robust than the
-- storage `owner` column (which the client must set correctly on upload).
drop policy if exists "resume objects owner read" on storage.objects;
create policy "resume objects owner read" on storage.objects
  for select using (bucket_id = 'resumes' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "resume objects owner write" on storage.objects;
create policy "resume objects owner write" on storage.objects
  for insert with check (bucket_id = 'resumes' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "resume objects owner update" on storage.objects;
create policy "resume objects owner update" on storage.objects
  for update using (bucket_id = 'resumes' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "resume objects owner delete" on storage.objects;
create policy "resume objects owner delete" on storage.objects
  for delete using (bucket_id = 'resumes' and (storage.foldername(name))[1] = auth.uid()::text);

-- ============================================================================
-- 0002_buckets.sql
-- ============================================================================
-- Profile v2 — answer buckets.
-- One jsonb array of buckets per user (see web/lib/buckets.ts + docs/profile-v2-plan.md).
-- NULL  = never provisioned  → the app seeds STARTER_BUCKETS on first load.
-- '[]'  = provisioned then emptied by the user (never re-seeded).
-- RLS is inherited from the existing owner-only policies on public.profiles.

alter table public.profiles
  add column if not exists buckets_json jsonb;

-- ============================================================================
-- 0003_attachments.sql
-- ============================================================================
-- Profile v2 — attachments (per-specialty files + general additional documents).
-- Private Storage bucket; objects are namespaced under the user id:
--   attachments/<auth.uid()>/<file>
-- The file references (path/filename/size/mime) are stored inside profile_json
-- (certifications[].specialties[].attachment and the top-level additional_files[]).

insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do nothing;

-- Path-based ownership: attachments/<auth.uid()>/<file> (mirrors the resumes bucket).
drop policy if exists "attachment objects owner read" on storage.objects;
create policy "attachment objects owner read" on storage.objects
  for select using (bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "attachment objects owner write" on storage.objects;
create policy "attachment objects owner write" on storage.objects
  for insert with check (bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "attachment objects owner update" on storage.objects;
create policy "attachment objects owner update" on storage.objects
  for update using (bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "attachment objects owner delete" on storage.objects;
create policy "attachment objects owner delete" on storage.objects
  for delete using (bucket_id = 'attachments' and (storage.foldername(name))[1] = auth.uid()::text);

-- ============================================================================
-- 0004_teach_dismissed.sql
-- ============================================================================
-- Teach flow — persistently-dismissed cards.
-- A jsonb array of normalized question keys the user SKIPPED on /app/teach, so a skipped card
-- never reappears (teachableCards excludes them). NULL / absent = nothing dismissed yet.
-- RLS is inherited from the existing owner-only policies on public.profiles.

alter table public.profiles
  add column if not exists teach_dismissed_json jsonb;

-- ============================================================================
-- 0005_applications_soft_delete.sql
-- ============================================================================
-- Soft-delete for applications: deleting a fill on the tracker HIDES it from the tracker but KEEPS the
-- row (and its review_bundle_json) so any answers the operator APPROVED still surface on the teach page.
-- The tracker/applications queries filter `deleted_at is null`; the teach queries read all bundles.
-- (A re-fill of the same URL clears deleted_at → the app reappears on the tracker.)

alter table public.applications
  add column if not exists deleted_at timestamptz;

-- partial index: the tracker's common "live apps for this user" query
create index if not exists applications_user_live_idx
  on public.applications (user_id, created_at desc)
  where deleted_at is null;

-- ============================================================================
-- 0006_job_description.sql
-- ============================================================================
-- Store the scraped job-description text on the application row. The Run flow
-- (website "Run" button → extension) scrapes the JD from the posting before it
-- clicks Apply, then persists it here so the tracker can show it and the
-- cover-letter generator can pull it in. Nullable — older rows and non-Run
-- fills simply leave it empty.
alter table public.applications
  add column if not exists job_description text;

-- ============================================================================
-- 0007_credentials.sql
-- ============================================================================
-- Workday account sign-in credentials + the Gmail auto-verify toggle, stored on
-- the profile row so they sync to the connected extension like the AI key does.
-- credentials_json = { email, password } (mirrors chrome.storage.local.credentials);
-- onboard_config   = { gmailEnabled } (the website-managed subset of the extension's
-- onboardConfig). Owner-only via the existing profiles RLS policy. Same posture as
-- ai_config, which already holds the provider API key.
alter table public.profiles
  add column if not exists credentials_json jsonb not null default '{}'::jsonb,
  add column if not exists onboard_config   jsonb not null default '{}'::jsonb;

-- ============================================================================
-- 0008_job_key.sql
-- ============================================================================
-- Stable per-job dedup key for tracker rows. A Workday application URL changes every run (after
-- login the form is on <tenant>.wdN.myworkdaysite.com with a per-application-instance path), so
-- keying the row by url piled up a new row per run. job_key = "<tenant.wdN>:r<reqid>" (see
-- lib.js canonicalJobUrl / web/lib/job-key.ts) is stable across runs; both the extension report
-- and the web Run save now upsert by (user_id, job_key). url stays as the (latest) raw link.
alter table public.applications
  add column if not exists job_key text;

-- Speeds up the per-user job_key lookup the dedup does on every report/run.
create index if not exists applications_user_job_key_idx
  on public.applications (user_id, job_key);

-- ============================================================================
-- 0009_teach_deleted.sql
-- ============================================================================
-- Teach flow — permanently-discarded skipped cards.
-- A jsonb array of normalized question keys the user DELETED from the /app/teach "Skipped" list.
-- These keys are a SUBSET of teach_dismissed_json (still out of the active queue), and are ALSO
-- hidden from the Skipped section — the Skipped list renders `dismissed − deleted`. Restoring a
-- skipped card can't reach a deleted one (it isn't shown), so a delete is permanent (until the same
-- question is taught, which covers it either way). NULL / absent = nothing deleted yet.
-- RLS is inherited from the existing owner-only policies on public.profiles.

alter table public.profiles
  add column if not exists teach_deleted_json jsonb;

