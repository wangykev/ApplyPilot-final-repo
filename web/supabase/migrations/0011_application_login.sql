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
