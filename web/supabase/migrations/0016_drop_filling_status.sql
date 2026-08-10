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
