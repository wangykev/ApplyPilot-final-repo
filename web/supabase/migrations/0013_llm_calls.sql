-- One row per model call, for the AI usage tracker (/app/usage).
--
-- WHY A LEDGER AND NOT A COUNTER: the two questions worth answering pull in opposite
-- directions. "What am I spending?" is a sum over paid calls. "How much of my free Gemini
-- allowance is left today?" is a COUNT per model per day against a 500/day cap — and that
-- cap is per MODEL, which is exactly why the fallback chain exists. A pair of running
-- totals can answer neither once you slice by day, model, action or key. Rows are small and
-- one application produces tens of them, not thousands.
--
-- cost_usd is NULLABLE ON PURPOSE, and null does not mean free:
--   0     a free-tier Gemini call — genuinely costs nothing
--   n     a priced model, computed from LLM_PRICING at call time
--   null  the rate is not known (Gemini paid, OpenAI). Storing 0 there would silently
--         under-report spend, so the page shows those calls as "unpriced" instead of
--         folding them into a total as if they were free.
-- Cost is frozen at call time rather than derived later: rates change, and a historical row
-- should keep what it actually cost.
create table if not exists public.llm_calls (
  id            bigserial primary key,
  user_id       uuid not null references auth.users (id) on delete cascade,

  -- What ran. `action` is the routable id (fill / essay / resume_parse / cover_letter) so
  -- the page can answer "which job is burning my quota?" — the whole point of per-action
  -- routing. Kept as text, not an enum: the action list evolves (teach became an alias of
  -- fill), and a migration to add an enum value for every new capability is friction with
  -- no benefit here.
  provider      text not null,
  model         text not null,
  action        text not null,

  -- Which key served it, and on which tier. After a rotation the key that answered is not
  -- the one first tried, so this is the only record of who actually paid. `key_id` is the
  -- operator's own key id from llmConfig — never the secret itself.
  key_id        text,
  key_tier      text,

  tokens_in     integer not null default 0,
  tokens_out    integer not null default 0,
  cost_usd      numeric(12, 6),

  -- ok=false rows are kept deliberately: a run of rate_limit/quota failures is the signal
  -- that a key is spent, and dropping them would hide exactly the pattern the tracker
  -- exists to surface. `error_code` is the classifyLlmFailure code (auth / quota /
  -- rate_limit / provider_down / bad_request / not_found / unknown).
  ok            boolean not null default true,
  error_code    text,

  -- Where the call came from: 'extension' (the form fill) or 'web' (resume parse, cover
  -- letter). Worth separating because the extension is by far the higher-volume caller and
  -- reaches the DB through the ingest route rather than directly.
  source        text not null default 'web',

  created_at    timestamptz not null default now()
);

alter table public.llm_calls enable row level security;

-- drop+create (not a bare create): every other policy in this schema is written this way so the
-- whole set can be re-run on a live database without erroring on "policy already exists".
drop policy if exists "llm_calls owner" on public.llm_calls;
create policy "llm_calls owner" on public.llm_calls
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- The tracker's own query: this user's calls, newest first, windowed by day.
create index if not exists llm_calls_user_created_idx
  on public.llm_calls (user_id, created_at desc);

-- The free-tier quota question: how many calls has THIS model made today? Per-model because
-- requests-per-day is metered per model, not per key.
create index if not exists llm_calls_user_model_created_idx
  on public.llm_calls (user_id, model, created_at desc);
