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
