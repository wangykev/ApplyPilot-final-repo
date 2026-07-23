-- Teach flow — permanently-discarded skipped cards.
-- A jsonb array of normalized question keys the user DELETED from the /app/teach "Skipped" list.
-- These keys are a SUBSET of teach_dismissed_json (still out of the active queue), and are ALSO
-- hidden from the Skipped section — the Skipped list renders `dismissed − deleted`. Restoring a
-- skipped card can't reach a deleted one (it isn't shown), so a delete is permanent (until the same
-- question is taught, which covers it either way). NULL / absent = nothing deleted yet.
-- RLS is inherited from the existing owner-only policies on public.profiles.

alter table public.profiles
  add column if not exists teach_deleted_json jsonb;
