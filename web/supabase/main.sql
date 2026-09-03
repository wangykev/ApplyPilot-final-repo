-- ApplyPilot Web — main.sql
--
-- THE WHOLE DATABASE IN ONE FILE. Every migration, in order, in a form that is safe to run more
-- than once: create ... if not exists, add column if not exists, drop+create for policies and
-- triggers, drop constraint if exists before add.
--
-- So this sets up a FRESH database, and running it again on a LIVE one brings it up to date
-- WITHOUT touching your data: there is no drop table, no delete, and no truncate anywhere in this
-- file. The single statement that writes to existing rows is in 0016, which re-homes applications
-- that were left on the retired 'filling' status.
--
-- Paste into the Supabase SQL editor and run. Replaces the numbered files in migrations/ and the
-- older schema.sql snapshot.
--
-- Generated from migrations/ 0001-0016. If you add a migration later, append it here too.
--
-- VERIFIED by execution (2026-08-10), not by reading it: run against a real Postgres (PGlite) with
-- Supabase's auth/storage objects stubbed —
--   * fresh database        -> succeeds; 7 tables, every applications column, RLS policies present
--   * run a SECOND time     -> succeeds (idempotent)
--   * over a database already holding 'filling' rows under the old constraint -> succeeds, and the
--     rows re-home by bundle presence (bundle -> needs_review, none -> queued) with nothing else
--     touched and no row lost


-- ==========================================================================
-- 0001_init.sql
-- ==========================================================================
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


-- ==========================================================================
-- 0002_buckets.sql
-- ==========================================================================
-- Profile v2 — answer buckets.
-- One jsonb array of buckets per user (see web/lib/buckets.ts + docs/profile-v2-plan.md).
-- NULL  = never provisioned  → the app seeds STARTER_BUCKETS on first load.
-- '[]'  = provisioned then emptied by the user (never re-seeded).
-- RLS is inherited from the existing owner-only policies on public.profiles.

alter table public.profiles
  add column if not exists buckets_json jsonb;


-- ==========================================================================
-- 0003_attachments.sql
-- ==========================================================================
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


-- ==========================================================================
-- 0004_teach_dismissed.sql
-- ==========================================================================
-- Teach flow — persistently-dismissed cards.
-- A jsonb array of normalized question keys the user SKIPPED on /app/teach, so a skipped card
-- never reappears (teachableCards excludes them). NULL / absent = nothing dismissed yet.
-- RLS is inherited from the existing owner-only policies on public.profiles.

alter table public.profiles
  add column if not exists teach_dismissed_json jsonb;


-- ==========================================================================
-- 0005_applications_soft_delete.sql
-- ==========================================================================
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


-- ==========================================================================
-- 0006_job_description.sql
-- ==========================================================================
-- Store the scraped job-description text on the application row. The Run flow
-- (website "Run" button → extension) scrapes the JD from the posting before it
-- clicks Apply, then persists it here so the tracker can show it and the
-- cover-letter generator can pull it in. Nullable — older rows and non-Run
-- fills simply leave it empty.
alter table public.applications
  add column if not exists job_description text;


-- ==========================================================================
-- 0007_credentials.sql
-- ==========================================================================
-- Workday account sign-in credentials + the Gmail auto-verify toggle, stored on
-- the profile row so they sync to the connected extension like the AI key does.
-- credentials_json = { email, password } (mirrors chrome.storage.local.credentials);
-- onboard_config   = { gmailEnabled } (the website-managed subset of the extension's
-- onboardConfig). Owner-only via the existing profiles RLS policy. Same posture as
-- ai_config, which already holds the provider API key.
alter table public.profiles
  add column if not exists credentials_json jsonb not null default '{}'::jsonb,
  add column if not exists onboard_config   jsonb not null default '{}'::jsonb;


-- ==========================================================================
-- 0008_job_key.sql
-- ==========================================================================
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


-- ==========================================================================
-- 0009_teach_deleted.sql
-- ==========================================================================
-- Teach flow — permanently-discarded skipped cards.
-- A jsonb array of normalized question keys the user DELETED from the /app/teach "Skipped" list.
-- These keys are a SUBSET of teach_dismissed_json (still out of the active queue), and are ALSO
-- hidden from the Skipped section — the Skipped list renders `dismissed − deleted`. Restoring a
-- skipped card can't reach a deleted one (it isn't shown), so a delete is permanent (until the same
-- question is taught, which covers it either way). NULL / absent = nothing deleted yet.
-- RLS is inherited from the existing owner-only policies on public.profiles.

alter table public.profiles
  add column if not exists teach_deleted_json jsonb;


-- ==========================================================================
-- 0010_queue_discovery.sql
-- ==========================================================================
-- Job discovery (the Discover button on /app/run) writes into the SAME queue the
-- operator pastes links into, so the queue row has to carry what a discovered job
-- knows: where it came from, when it was posted, and the description the extension
-- scraped by opening the posting. A pasted row simply leaves these null — nothing
-- about the existing paste flow changes.
--
-- job_key is the dedup identity, LOCKSTEP with web/lib/discover.ts discoveryJobKey
-- and the extension's discover.js. It extends the tracker's canonicalJobUrl with
-- the board ids (linkedin:<id>, handshake:<id>, greenhouse:<co>:<id>, …), and for a
-- Workday posting it produces the SAME key applications.job_key holds — that is what
-- makes "jobs I have not already applied to" work across the two tables.
alter table public.queue_items
  add column if not exists job_key         text,
  add column if not exists company         text,
  add column if not exists role            text,
  add column if not exists source          text,
  add column if not exists location        text,
  add column if not exists posted_at       timestamptz,
  add column if not exists job_description text;

-- One row per job per user. PARTIAL so the pre-existing pasted rows (job_key null)
-- are untouched and a future paste without a key can still be inserted — Postgres
-- would treat multiple nulls as distinct anyway, but being explicit documents it.
create unique index if not exists queue_items_user_job_key_uidx
  on public.queue_items (user_id, job_key)
  where job_key is not null;

-- The discovery dedup reads every existing key for the user on each sweep.
create index if not exists queue_items_user_created_idx
  on public.queue_items (user_id, created_at desc);


-- ==========================================================================
-- 0011_application_login.sql
-- ==========================================================================
-- WHICH Workday account each application was filed with (operator ask 2026-07-26).
--
-- Workday accounts are per-tenant, so "what did I sign in as on this one?" is a real question weeks
-- later when a recruiter replies — and after a create-account run this row is the only record that the
-- account exists at all. The extension is the source of truth here: it's the thing that actually signed
-- in, so it reports what it USED (see background.js recordRunLogin / getRunLoginFor), and the website's
-- own Run/Submit actions fill the same columns when the ingest report doesn't reach us.
--
--   login_email    the account the run signed in as (null = signed in by hand, nothing to record)
--   login_tenant   the Workday tenant it belongs to ("Magna") — accounts do NOT carry across tenants
--   login_host     the host it was created/used on (magna.wd3.myworkdayjobs.com)
--   login_created  true = the account was CREATED during that run (vs signing in to an existing one)
--   login_verified true = the run completed the email verification round-trip
--   login_at       when that sign-in happened
--
-- Deliberately NOT stored here: the password. It lives once on profiles.credentials_json; copying it per
-- application would multiply the same secret across rows for no gain.
alter table public.applications
  add column if not exists login_email    text,
  add column if not exists login_tenant   text,
  add column if not exists login_host     text,
  add column if not exists login_created  boolean not null default false,
  add column if not exists login_verified boolean not null default false,
  add column if not exists login_at       timestamptz;

-- "Which applications went through this account?" — the lookup this column exists to answer.
create index if not exists applications_user_login_email_idx
  on public.applications (user_id, login_email);


-- ==========================================================================
-- 0012_queue_job_details.sql
-- ==========================================================================
-- 0012 — the details worth seeing in the queue BEFORE opening a posting.
--
-- Operator 2026-07-30: "on the queue, give more information like the pay, start
-- date/end date if they have and other important information."
--
-- Discovery already reads all of this out of each board's own job record — it was
-- simply being thrown away at the queue boundary, so a row showed only company /
-- role / location / age. One JSONB column rather than eight scalars because the set
-- is board-dependent and still settling: Handshake publishes pay and a term,
-- LinkedIn publishes neither (its `salaryInsights` is a link to its salary tool, not
-- a number), and a nullable jsonb absorbs the next field without another migration.
--
-- Nothing here is required. A pasted row, or a row written before this migration,
-- leaves it NULL and the queue renders exactly as it did.
--
-- Shape (all optional, see web/lib/discover.ts → toQueueRow):
--   {
--     pay:        "$20-30/hr",        -- as the BOARD words it; absent ⇒ not stated
--     start_date: "2026-08-14",       -- the term, when the board gives one
--     end_date:   "2026-12-14",
--     apply_by:   "2026-08-26",       -- the board's own application deadline
--     workplace:  "Remote",           -- Remote | Hybrid | On-site
--     employment_type: "Internship",
--     applicants: 6,                  -- read + displayed, but NOT ranked on
--     match_percent: 84,              -- why this row was queued
--     match_reasons: ["title matches embedded, software", "posted 3h ago"],
--     reposted:   true,               -- the board's date was a BUMP…
--     original_posted_at: "2026-05-27T19:15:00Z",  -- …this is the real one
--     apply_note: "apply using the external link only"
--   }
alter table public.queue_items
  add column if not exists details jsonb;

comment on column public.queue_items.details is
  'Optional per-posting extras from discovery: pay, term dates, apply-by deadline, workplace, applicant count, match score + reasons, and the ORIGINAL posted date when the board was showing a repost. Null for pasted rows.';


-- ==========================================================================
-- 0013_llm_calls.sql
-- ==========================================================================
-- One row per model call, for the AI usage tracker (/app/usage).
--
-- WHY A LEDGER AND NOT A COUNTER: the two questions worth answering pull in opposite
-- directions. "What am I spending?" is a sum over paid calls. "How much of my free Gemini
-- allowance is left today?" is a COUNT per model per day against a 500/day cap — and that
-- cap is per MODEL, which is exactly why the fallback chain exists. A pair of running
-- totals can answer neither once you slice by day, model, action or key. Rows are small and
-- one application produces tens of them, not thousands.
--
-- cost_usd is NULLABLE ON PURPOSE, and null does not mean free:
--   0     a free-tier Gemini call — genuinely costs nothing
--   n     a priced model, computed from LLM_PRICING at call time
--   null  the rate is not known (Gemini paid, OpenAI). Storing 0 there would silently
--         under-report spend, so the page shows those calls as "unpriced" instead of
--         folding them into a total as if they were free.
-- Cost is frozen at call time rather than derived later: rates change, and a historical row
-- should keep what it actually cost.
create table if not exists public.llm_calls (
  id            bigserial primary key,
  user_id       uuid not null references auth.users (id) on delete cascade,

  -- What ran. `action` is the routable id (fill / essay / resume_parse / cover_letter) so
  -- the page can answer "which job is burning my quota?" — the whole point of per-action
  -- routing. Kept as text, not an enum: the action list evolves (teach became an alias of
  -- fill), and a migration to add an enum value for every new capability is friction with
  -- no benefit here.
  provider      text not null,
  model         text not null,
  action        text not null,

  -- Which key served it, and on which tier. After a rotation the key that answered is not
  -- the one first tried, so this is the only record of who actually paid. `key_id` is the
  -- operator's own key id from llmConfig — never the secret itself.
  key_id        text,
  key_tier      text,

  tokens_in     integer not null default 0,
  tokens_out    integer not null default 0,
  cost_usd      numeric(12, 6),

  -- ok=false rows are kept deliberately: a run of rate_limit/quota failures is the signal
  -- that a key is spent, and dropping them would hide exactly the pattern the tracker
  -- exists to surface. `error_code` is the classifyLlmFailure code (auth / quota /
  -- rate_limit / provider_down / bad_request / not_found / unknown).
  ok            boolean not null default true,
  error_code    text,

  -- Where the call came from: 'extension' (the form fill) or 'web' (resume parse, cover
  -- letter). Worth separating because the extension is by far the higher-volume caller and
  -- reaches the DB through the ingest route rather than directly.
  source        text not null default 'web',

  created_at    timestamptz not null default now()
);

alter table public.llm_calls enable row level security;

-- drop+create (not a bare create): every other policy in this schema is written this way so the
-- whole set can be re-run on a live database without erroring on "policy already exists".
drop policy if exists "llm_calls owner" on public.llm_calls;
create policy "llm_calls owner" on public.llm_calls
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- The tracker's own query: this user's calls, newest first, windowed by day.
create index if not exists llm_calls_user_created_idx
  on public.llm_calls (user_id, created_at desc);

-- The free-tier quota question: how many calls has THIS model made today? Per-model because
-- requests-per-day is metered per model, not per key.
create index if not exists llm_calls_user_model_created_idx
  on public.llm_calls (user_id, model, created_at desc);


-- ==========================================================================
-- 0015_resume_source.sql
-- ==========================================================================
-- Resume SOURCE files (.tex / .docx): the editable document the PDF is generated
-- from. One source per user (replaced on upload), stored in the same private
-- `resumes` bucket at <uid>/source.<ext>; the compiled/converted PDF still lands
-- on the `default` row (whose filename is the user-chosen attachment name).
alter table public.resumes drop constraint if exists resumes_kind_check;
alter table public.resumes
  add constraint resumes_kind_check check (kind in ('default', 'variant', 'source'));


-- ==========================================================================
-- 0016_drop_filling_status.sql
-- ==========================================================================
-- Retire the "filling" application status.
--
-- It was an IN-PROGRESS state on a row that only a report can move: a run created the row as
-- 'filling', and a run that errored never reported, so the row sat reading "Filling" forever. A
-- completed fill with nothing flagged also landed there, because the report fell back to it. Neither
-- is a state the tracker can act on.
--
-- Rows are re-homed by what is actually true of them, not blanket-set:
--   • has a review bundle  -> 'needs_review' (the fill finished; a human still approves before submit)
--   • no bundle            -> 'queued'       (nothing was ever captured for it)
update public.applications
   set status = case when review_bundle_json is not null then 'needs_review' else 'queued' end
 where status = 'filling';

-- …then take it out of the allowed set so nothing can write it again.
alter table public.applications drop constraint if exists applications_status_check;
alter table public.applications
  add constraint applications_status_check
  check (status in ('queued', 'needs_review', 'submitted', 'interviewing', 'offer', 'rejected'));



-- ==========================================================================
-- 0017_application_resume.sql
-- ==========================================================================
-- WHICH RÉSUMÉ an application was sent with.
--
-- The tracker could show every answer on a submitted application except the document that went with
-- it. These three columns close that, and they are shaped for the tailored-résumé future rather than
-- only for today:
--
--   resume_id      -> the resumes row this application was built from
--   resume_sha256  -> the hash of the bytes actually attached (the record of what was sent)
--   resume_delta   -> NULL means "the base résumé, unmodified" — which is every application TODAY,
--                     since one default PDF is attached to every run. When per-application AI
--                     tailoring ships it holds the tailor's own edit records (tex-tailor.ts already
--                     emits them, and fitTexToPages bakes its page-fit reverts INTO those records),
--                     so replaying a tailored résumé is a pure spliceTexEdits — no LLM call, no
--                     page-fit loop. Storing ~0.8KB of edits instead of a 30KB PDF per application is
--                     what keeps this affordable across many users; measured on a real 9KB source
--                     résumé with 21 bullets.
--
-- on delete set null: removing a résumé must never cascade into deleting applications.
alter table public.applications
  add column if not exists resume_id uuid references public.resumes (id) on delete set null;
alter table public.applications add column if not exists resume_sha256 text;
alter table public.applications add column if not exists resume_delta jsonb;

-- ---------------------------------------------------------------- resumes: VERSIONED
-- Upload used to DELETE the previous row and overwrite the bytes at a fixed path, so the moment you
-- re-uploaded, every application pointing at "your résumé" silently resolved to a DIFFERENT document
-- — the record broke exactly when you would want it. Rows are now kept and addressed by content
-- hash; `deleted_at` is what "I removed my résumé" means, so history survives it.
alter table public.resumes add column if not exists sha256 text;
alter table public.resumes add column if not exists deleted_at timestamptz;

-- The current résumé of a kind = the newest row that is not soft-deleted.
create index if not exists resumes_current_idx
  on public.resumes (user_id, kind, created_at desc)
  where deleted_at is null;


-- ==========================================================================
-- 0018_application_approved_at.sql
-- ==========================================================================
-- WHEN the operator finished approving this application review.
--
-- Approval already exists per FIELD, inside review_bundle_json, and the tracker LIST deliberately does
-- not load that column (it is a large jsonb). So a row whose every flagged field was approved still read
-- "Needs review" in the list, and there was no way to see at a glance what was actually ready to submit.
--
-- A TIMESTAMP rather than a boolean, matching applied_at / deleted_at / login_at: null means not
-- approved, and a value records when. Status is deliberately NOT touched — the enum is written by the
-- extension, and approval is a different axis from where the application sits in the pipeline.
alter table public.applications add column if not exists approved_at timestamptz;


-- ==========================================================================
-- 0019_essays.sql
-- ==========================================================================
-- The operator's OWN written application answers, kept as a voice library.
--
-- WHY. Every essay was written from scratch: the fill AI got the question, the company, the JD and
-- the profile JSON, and nothing about how the operator actually writes. So a "list one or two
-- projects that demonstrate your embedded systems experience (3 sentences max)" answer came back in
-- generic model prose, the operator rewrote it by hand — and that rewrite was thrown away, because
-- it lived only inside that one application's review_bundle_json. Now an answer they wrote is saved
-- and fed back into later essay prompts as a voice sample the model may also mine for facts (their
-- essays describe projects in more detail than their résumé does).
--
-- ONE JSONB COLUMN ON profiles, exactly like buckets_json (0002): RLS is inherited from the existing
-- owner-only policies, so there is no new policy to keep in step.
--   NULL  = never provisioned  → the app treats it as an empty library
--   '{}'  = provisioned then emptied by the operator
--
-- ⚠ DELIBERATELY NOT INSIDE profile_json. The ATS essay prompt truncates the profile at
-- `JSON.stringify(profile).slice(0, 12000)` (ats.js), so essays riding inside the profile would eat
-- that budget and silently push out real profile data — the fill would get quietly worse as the
-- library grew. Selection also needs them as an addressable list so it can rank a few against the
-- question being answered rather than sending the lot.
--
-- ⚠ NOT A BUCKET, and not a candidate to become one. buckets_json holds
-- exact-normalized-wording → verbatim-answer matches, and web/lib/teach.ts excludes essays from that
-- store on purpose: an essay question is never phrased the same way twice. This is the complementary
-- store — not "replay this answer" but "here is how I write".
--
-- Shape (see web/lib/essays.ts for the zod schema, which is the authority):
--   { "style_notes": "3 sentences max, no buzzwords",
--     "essays": [ { "id", "question", "text", "company", "source", "created_at" } ] }
-- `source` is "review" (auto-captured from a review-page edit) or "manual" (typed on the page).
alter table public.profiles
  add column if not exists essays_json jsonb;
