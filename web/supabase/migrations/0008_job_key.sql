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
