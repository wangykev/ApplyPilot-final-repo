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
