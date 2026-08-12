-- ApplyPilot — post-run verification.
--
-- Run this AFTER main.sql, in the same SQL editor. It checks the END STATE rather than the input,
-- so it is a valid check even if the paste was truncated and re-pasted: every row must read PASS.
-- Read-only — it changes nothing.

with checks as (
  -- every table main.sql creates
  select 'tables' as item,
         (select count(*) from information_schema.tables
           where table_schema = 'public'
             and table_name in ('profiles','applications','resumes','api_keys','queue_items','reminders','llm_calls'))::text as got,
         '7' as want

  union all
  -- the columns added by the later migrations — the ones a truncated paste would miss
  select 'applications columns',
         (select count(*) from information_schema.columns
           where table_schema = 'public' and table_name = 'applications'
             and column_name in ('job_key','deleted_at','job_description',
                                 'login_email','login_tenant','login_host','login_created','login_verified','login_at'))::text,
         '9'

  union all
  select 'profiles columns',
         (select count(*) from information_schema.columns
           where table_schema = 'public' and table_name = 'profiles'
             and column_name in ('buckets_json','teach_dismissed_json','teach_deleted_json',
                                 'credentials_json','onboard_config'))::text,
         '5'

  union all
  -- 0015: the resumes kind constraint must allow 'source'
  select 'resumes allows source',
         (select case when pg_get_constraintdef(oid) like '%source%' then 'yes' else 'no' end
            from pg_constraint where conname = 'resumes_kind_check'),
         'yes'

  union all
  -- 0016: 'filling' must be gone from the allowed set
  select 'filling retired',
         (select case when pg_get_constraintdef(oid) like '%filling%' then 'no' else 'yes' end
            from pg_constraint where conname = 'applications_status_check'),
         'yes'

  union all
  -- …and no row may still be sitting on it
  select 'no filling rows',
         (select count(*) from public.applications where status = 'filling')::text,
         '0'

  union all
  -- 0017: which résumé an application was sent with
  select 'application resume columns',
         (select count(*) from information_schema.columns
           where table_schema = 'public' and table_name = 'applications'
             and column_name in ('resume_id','resume_sha256','resume_delta'))::text,
         '3'

  union all
  select 'resumes versioning columns',
         (select count(*) from information_schema.columns
           where table_schema = 'public' and table_name = 'resumes'
             and column_name in ('sha256','deleted_at'))::text,
         '2'

  union all
  -- Deleting a résumé must NULL the pointer, never cascade into deleting applications.
  select 'resume_id on delete set null',
         (select rc.delete_rule from information_schema.referential_constraints rc
            join information_schema.key_column_usage k on k.constraint_name = rc.constraint_name
           where k.table_name = 'applications' and k.column_name = 'resume_id'),
         'SET NULL'

  union all
  -- 0018: the tracker's "approved" signal
  select 'approved_at column',
         (select count(*) from information_schema.columns
           where table_schema = 'public' and table_name = 'applications' and column_name = 'approved_at')::text,
         '1'

  union all
  -- 0019: how the application was filled ('manual' = the extension assisted, you submitted it)
  select 'fill_mode column',
         (select count(*) from information_schema.columns
           where table_schema = 'public' and table_name = 'applications' and column_name = 'fill_mode')::text,
         '1'

  union all
  -- …and its CHECK, which is a separate statement in main.sql — a paste truncated between the two
  -- would leave the column with nothing constraining it, and that is worth catching separately.
  select 'fill_mode constrained',
         (select case when count(*) = 1 then 'yes' else 'no' end
            from pg_constraint where conname = 'applications_fill_mode_check'),
         'yes'

  union all
  -- RLS on every owner-scoped table
  select 'RLS enabled',
         (select count(*) from pg_tables
           where schemaname = 'public' and rowsecurity
             and tablename in ('profiles','applications','resumes','api_keys','queue_items','reminders','llm_calls'))::text,
         '7'

  union all
  select 'storage buckets',
         (select count(*) from storage.buckets where id in ('resumes','attachments'))::text,
         '2'
)
select item,
       want,
       got,
       case when got is not distinct from want then 'PASS' else 'FAIL' end as result
from checks
order by result, item;
