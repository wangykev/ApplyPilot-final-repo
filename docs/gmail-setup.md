# Onboarding walk — one-time setup (extension key + Gmail auto-verify)

The onboarding stage (JD page → **Apply** → **Apply Manually** → sign-in / create-account →
**email verification** → land on the form) needs two one-time setup steps: a **pinned
extension ID** and a **Gmail OAuth client**. Everything else (credentials, the Gmail toggle)
is configured in the popup.

Gmail access uses `chrome.identity.getAuthToken` with the **`gmail.readonly`** scope only.
Chrome owns the native account picker + token cache/refresh; the extension never stores a
token. Read-only is side-effect-free by construction (it can't send/mark-read/mutate). **The
token and all Gmail message data stay client-side — never routed to any backend.**

---

## 1. The extension ID is pinned

`manifest.json` now carries a `key` (the public half of `secrets/ext-key.pem`), which fixes
the extension ID to:

```
degflnkiejblbjcihdpmikekdgmbgehb
```

- **`secrets/ext-key.pem` is the private half — keep it.** It's what preserves this ID on
  publish. It's gitignored (`secrets/`). If it's lost, the ID changes and the OAuth client
  below must be re-registered.
- **Adding the `key` changed the extension ID**, so the first reload wipes the old
  extension's `chrome.storage.local`. Re-add at `chrome://extensions` → reload → re-run
  **Load default profile** and **Load account credentials**.
- **Dev ID vs. published ID:** a local key gives a *stable dev* ID (what you register the
  OAuth client against now). At Web Store publish time the store assigns its own public key;
  to keep dev ID == prod ID, copy the item's public key from the Developer Dashboard into
  `manifest.json` `key` and register a second OAuth client for the prod ID (or update the
  existing one). This is expected at public launch, not during dev.

## 2. Create the Gmail OAuth client (Google Cloud Console)

1. Go to <https://console.cloud.google.com/> → create/pick a project.
2. **APIs & Services → Library →** enable **Gmail API**.
3. **APIs & Services → OAuth consent screen:** External; add your Gmail address as a **Test
   user** (in Testing status, tokens re-consent ~weekly — fine for dev; restricted-scope
   verification is only required at public launch).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID →** application
   type **Chrome Extension** (older consoles: **Chrome App**). Enter the **Item/Application
   ID** = `degflnkiejblbjcihdpmikekdgmbgehb`. (No redirect URI — that's only for
   `launchWebAuthFlow`, which we don't use.)
5. Copy the generated **Client ID** (`…apps.googleusercontent.com`).
6. Paste it into `manifest.json` → `oauth2.client_id` (replacing the
   `REPLACE_WITH_YOUR_…` placeholder). Reload the extension card.

## 3. Smoke-test BEFORE trusting auto-verify (the build order)

In the popup: **Connect / test Gmail (readonly)**. This calls `getAuthToken` (Chrome shows
the account picker/consent the first time) then a read-only `users/me/profile` call, and
reports the **connected inbox email + message count** in the popup and `[GMAIL-TEST]` in the
service-worker console. Confirm the connected account is the inbox your Workday `+alias`
delivers to (e.g. `wangykev@gmail.com` for `wangykev+NNN@gmail.com`).

## 4. Credentials

Put the Workday account email + password in `data/.credentials.json` (copy
`data/.credentials.example.json`). Both `data/.credentials.json` and `data/credentials.json`
are accepted (some Chrome builds don't serve dotfiles via `getURL`) and both are gitignored.
Click **Load account credentials** in the popup. The **same** email is reused across tenants —
sign-in-first handles account reuse; a first-time tenant creates the account then verifies.

## 5. Run it

Popup → **Onboarding** section:
- (optional) **Start URL** — a job-posting URL to navigate to first; blank = drive the active tab.
- **Gmail auto-verify ON** — enables the email-verification step (needs steps 2–3).
- **Continue into the fill walk after login** — OFF by default. When ON, after login lands on
  the form it chains into the CDP fill walk, which **advances a live application** — leave OFF
  until you're on a **disposable** application (the hard gate in CLAUDE.md).
- **Start application** — drives Apply → Apply Manually → login/create-account → verify →
  form. Keep the tab **visible** to watch. It **never submits**. `[ONBOARD]` in the SW console.

### Known caveats / halts (all self-explaining in the popup + `[ONBOARD]` log)
- **SSO/federated tenants** (Okta/Ping/Azure/…) → halts `sso`: sign in manually, then re-run
  (it detects the form and continues).
- **Verify link may be session-bound.** The reference navigates the tab to the fetched link;
  if a tenant's link is session-bound it may not complete headlessly — halts `verify-link-invalid`
  so you can open it manually. Confirm this end-to-end on the first tenant before trusting it.
- **Workday soft-error** ("Something went wrong / please refresh the page and then try again")
  → the flow reloads once (capped) and retries automatically.
- **2FA / CAPTCHA** → not automated; complete it manually and re-run.
