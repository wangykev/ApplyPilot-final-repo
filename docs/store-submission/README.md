# Chrome Web Store submission — the whole path

Everything needed to submit ApplyPilot for review. Read this file top to bottom once; the
other three are reference you paste from.

| File | What it holds |
|---|---|
| `privacy-tab.md` | Single purpose, per-permission justifications, remote-code answer, data-usage disclosures |
| `listing.md` | Name, descriptions, category, asset specs, screenshot shot list, visibility |
| `demo-videos.md` | Both video scripts — the CWS walkthrough and the Google OAuth one |

---

## The one thing to get right: ordering

**The extension ID changes when you publish, and your Gmail OAuth client is bound to that
ID** (`docs/gmail-setup.md` §1). Do these in the wrong order and Gmail auto-verify is broken
on the published build only — which is the worst kind of bug to find, because it works
perfectly in every dev test you run.

```
1. Build the package                    npm run build:store
2. Create the CWS item, upload the zip  → the PUBLISHED extension ID is minted
3. Register a Chrome-Extension OAuth client for THAT id
   → paste it into manifest.json oauth2.client_id
   → rebuild, re-upload
4. Fill in the listing + privacy tabs   (listing.md, privacy-tab.md)
5. Record Video A, add it to the listing
6. Submit for CWS review
7. Record Video B against the PUBLISHED build   (real ids on screen)
8. Submit the OAuth consent screen for verification
```

Steps 6 and 8 are **independent reviews on different timelines**. CWS review is typically
days; restricted-scope OAuth verification is typically weeks and is the long pole. You can
publish and use the extension while OAuth verification is pending — the Gmail feature stays
limited to test users until it clears, and everything else works.

---

## Before you submit — five open items

Four need a decision or an action from you. Nothing else is outstanding.

### 1 · Set the privacy-policy contact email ⚠ blocking

`web/app/privacy/page.tsx` has `CONTACT_EMAIL = "support@applypilot.app"`, a placeholder.
Both reviews test that the contact is reachable, and a bounce restarts the queue. Set it to
a mailbox you read, then deploy the site so `/privacy` is live before you submit.

### 2 · Decide the "financial information" disclosure

Recommendation: **check it**, because the profile stores a salary expectation. The full
reasoning and the defensible alternative are in `privacy-tab.md` §4. Make it a decision
rather than a default.

### 3 · Confirm `/privacy` is publicly reachable

The middleware only guards `/app/:path*`, so it should be. Verify in a logged-out browser
after deploying — a policy URL that redirects to a login is a standard rejection, and it is
a ten-second check.

### 4 · Capture five screenshots

The only asset you cannot generate from the repo. Specs, capture method, and the shot list
are in `listing.md`. **Scrub them** — fake name, fake address, no real posting.

### 5 · Record the two videos

Scripts in `demo-videos.md`. Video A any time; Video B **after** step 3 above.

---

## What is already done

- **Privacy policy** — `web/app/privacy/page.tsx`, public, with the Google Limited Use
  disclosure, linked from the home-page footer (`web/components/site/Footer.tsx` — that link
  is a Google OAuth requirement, do not remove it).
- **Production packaging** — `npm run build:store` emits `dist/applypilot-<version>.zip`:
  name set to `ApplyPilot`, version `1.0.0`, `manifest.key` stripped, `http://localhost/*`
  removed from both `host_permissions` and `externally_connectable`, and a 132-char
  manifest description. `npm run build:store:dry` prints the plan without writing.
- **Icons** — `npm run build:icons` renders `icons/icon{16,32,48,128}.png` from the site's
  own mark. `icon128.png` is the store's required 128×128. There were none before; the
  extension was shipping Chrome's default puzzle piece.
- **Dev-only popup controls hidden on a store install** — "Load default profile" and "Load
  account credentials" read gitignored files that are deliberately not packaged, so on a
  store build they would have shown a reviewer "copy data/profile.example.json and fill it
  in". They now hide themselves when Chrome reports a store install (`popup.js`, the
  `[data-dev-only]` block).
- **All listing and privacy-tab copy** — written, in the two files above.

---

## Things that are correct as-is — don't "fix" them

Each of these looks like an omission and is not. They are recorded here so a future round
does not spend time on them or, worse, change them.

**Your real profile cannot be packaged.** `data/` is gitignored deny-by-default because it
holds a real profile and real credentials. The build script ships an **allowlist**
(`SHIP_FILES` / `SHIP_DIR_ALLOW`), so a file it does not name cannot ship even if someone
adds it. A second belt scans shipped text files for email/phone/password/address shapes and
**fails the build** rather than warning. Verified live: the guard trips on
`credentials.example.json`.

**iCIMS, Greenhouse, Lever, and Ashby hosts are absent from `host_permissions`, and that is
deliberate.** Those forms are read and driven entirely through CDP, which is not
host-gated — including the job-description scrape (`background.js:5108`, via `cdpEval`).
Only the Workday onboarding path uses `chrome.scripting.executeScript`, which *is*
host-gated, and that is exactly what the two Workday hosts are declared for
(`background.js:430`). Adding ATS hosts would buy nothing, widen the permission warning
users see, and cost every existing user a re-consent prompt later.

**`0.0.1` stays in the dev `manifest.json`.** The store version lives in
`scripts/build-store-zip.mjs` as `STORE_VERSION`, applied to a copy at package time. One
manifest, no twin to drift. Bump with `--version 1.0.1` or by editing that constant.

**No remote code, despite `Runtime.evaluate`.** Everything evaluated ships in the package;
the one GitHub fetch returns JSON parsed with `JSON.parse`. Answer the store's remote-code
question **No** — reasoning in `privacy-tab.md` §3.

---

## After it is approved

- **Updates are unlimited.** Bump the version, `npm run build:store`, upload. Each version
  is reviewed again; users get it automatically.
- **A mid-review upload replaces the in-review build and restarts the clock.** Allowed, but
  you lose your place in the queue — usually better to let the first one land and ship the
  fix as the next version.
- **Never reuse or lower a version number.** Chrome requires strictly increasing versions.
- **New permissions disable the extension for existing users** until they re-approve. This
  is the reason not to add host permissions speculatively, and the reason to think once
  about whether a future feature needs one before it has users.
- **Keep both videos up.** Re-verification and any future scope change pull them up again.
