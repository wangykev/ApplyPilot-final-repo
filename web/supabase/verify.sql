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
