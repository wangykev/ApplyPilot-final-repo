# ApplyPilot Web — setup

Wire the app to a real backend, verify it on localhost, then deploy. Steps marked
**[you]** need your account login; the rest is already done in the repo. Total ~15 min.

---

## 1. Create the Supabase project **[you]**
1. Go to <https://supabase.com> → **New project** (free tier is fine). Pick a region near you.
2. Wait for it to provision (~2 min).

## 2. Grab the keys **[you]**
Project → **Settings → API**. Copy three values:
- **Project URL** → `NEXT_PUBLIC_SUPABASE_URL`
- **anon public** key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- **service_role** key → `SUPABASE_SERVICE_ROLE_KEY` *(secret — server only, never shipped to the browser)*

## 3. Fill `web/.env.local`
Create `web/.env.local` (copy from `web/.env.example`):
```
NEXT_PUBLIC_SUPABASE_URL=https://<your-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service_role key>
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```
**Remove/omit `NEXT_PUBLIC_DEV_PREVIEW`** — with a real backend you want real auth, not the
sample-data preview. (`.env.local` is git-ignored.)

## 4. Run the schema **[you]**
Supabase → **SQL Editor** → **New query** → paste all of `web/supabase/migrations/0001_init.sql`
→ **Run**. This creates the tables, RLS policies, the new-user trigger, and the private
`resumes` storage bucket. Safe to re-run (idempotent).

## 5. Auth — Email **[you]**
Supabase → **Authentication → Providers → Email**: enabled by default. For fast local testing,
**Authentication → Providers → Email → turn OFF "Confirm email"** so email/password sign-in works
without a confirmation round-trip. (Turn it back on for production.)

## 6. Auth — Google **[you]**
1. Supabase → **Authentication → Providers → Google** — it shows a **Callback URL** like
   `https://<your-ref>.supabase.co/auth/v1/callback`. Copy it.
2. [Google Cloud Console](https://console.cloud.google.com) → **APIs & Services → Credentials →
   Create Credentials → OAuth client ID → Web application**. Under **Authorized redirect URIs**,
   paste the Supabase callback URL from step 1. Create.
3. Copy the **Client ID** + **Client secret** back into Supabase → Google provider → **enable** +
   paste both → Save.

## 7. Redirect URLs **[you]**
Supabase → **Authentication → URL Configuration**:
- **Site URL**: `http://localhost:3000`
- **Redirect URLs**: add `http://localhost:3000/**` (and your Vercel URL later).

## 8. Run + confirm
```
cd web
npm run dev
```
Open <http://localhost:3000/api/health> → you want `"configured": true, "schema_ok": true`.
- `configured:false` → env not picked up (check `.env.local`, restart dev).
- `schema_ok:false` → migration not run (redo step 4).

## 9. Verify the whole loop (the point of all this)
1. <http://localhost:3000> → **Open the deck** → sign in (Google or email).
2. **AI** → pick a provider + paste an API key → **Test connection**.
3. **Resume** → upload a PDF → **Parse with AI** → **Apply to my profile**.
4. **Profile** → review/edit → **Save**.
5. **Job context** → set a company.
6. **Connect** → load the extension unpacked (`chrome://extensions` → Load unpacked → repo root),
   copy its ID, paste it, **Check connection**, **Sync to extension**.
7. Run a fill on a Workday page → the extension reports it → check **Tracker** + open the row for
   the hosted **review summary**, and **Analytics**.

## 10. Deploy to Vercel (once local works) **[you]**
1. Push this branch; on [Vercel](https://vercel.com) **Import** the repo, set **Root Directory =
   `web`**. Framework auto-detects Next.js.
2. Add the same env vars, but `NEXT_PUBLIC_SITE_URL = https://<your-app>.vercel.app`.
3. Deploy. Then:
   - Add `https://<your-app>.vercel.app/**` to Supabase **Redirect URLs** (step 7).
   - Add `https://<your-app>.vercel.app/*` to the extension `manifest.json`
     **`externally_connectable.matches`** *and* **`host_permissions`**, and reload the extension.
   - (Optional hardening) pin the extension ID via a manifest `key` so the ID is stable.

---

**Notes**
- The AI features (resume parse, cover letter, screening answers) use *your* LLM key, stored
  per-user in `profiles.ai_config` — set it on the **AI** page.
- `NEXT_PUBLIC_DEV_PREVIEW=1` (dev only, hard-gated off in production) shows sample data and
  bypasses the auth gate so you can preview the signed-in UI before Supabase is wired.
