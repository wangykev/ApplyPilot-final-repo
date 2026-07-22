-- Store the scraped job-description text on the application row. The Run flow
-- (website "Run" button → extension) scrapes the JD from the posting before it
-- clicks Apply, then persists it here so the tracker can show it and the
-- cover-letter generator can pull it in. Nullable — older rows and non-Run
-- fills simply leave it empty.
alter table public.applications
  add column if not exists job_description text;
