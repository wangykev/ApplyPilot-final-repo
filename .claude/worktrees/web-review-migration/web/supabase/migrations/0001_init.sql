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
  kind          text not null default 'default' check (kind in ('default','variant')),
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
