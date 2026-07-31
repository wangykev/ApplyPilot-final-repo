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
