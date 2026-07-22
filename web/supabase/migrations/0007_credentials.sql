-- Workday account sign-in credentials + the Gmail auto-verify toggle, stored on
-- the profile row so they sync to the connected extension like the AI key does.
-- credentials_json = { email, password } (mirrors chrome.storage.local.credentials);
-- onboard_config   = { gmailEnabled } (the website-managed subset of the extension's
-- onboardConfig). Owner-only via the existing profiles RLS policy. Same posture as
-- ai_config, which already holds the provider API key.
alter table public.profiles
  add column if not exists credentials_json jsonb not null default '{}'::jsonb,
  add column if not exists onboard_config   jsonb not null default '{}'::jsonb;
