# Demo videos

You need **two**, for two different reviewers, with different rules. Do not try to make one
video serve both — the Google reviewer is checking a specific list of on-screen facts, and
padding it with a product tour makes those facts harder to find.

| | Video A | Video B |
|---|---|---|
| **Audience** | Chrome Web Store reviewer | Google OAuth verification (Trust & Safety) |
| **Required?** | Field is optional. In practice it is what gets `debugger` approved. | **Mandatory** — `gmail.readonly` is a restricted scope. |
| **Job to do** | Prove the single purpose; make `debugger` obviously necessary and visibly bounded. | Prove app identity, show the consent screen, show exactly how the scope's data is used. |
| **Length** | 2–4 min | 3–5 min |
| **Where it goes** | Listing → "Video" field (YouTube URL) | The OAuth verification reply / Cloud Console form |

## Ground rules for both

- **Unlisted YouTube**, not private — a private video is invisible to the reviewer and is a
  common cause of a stalled review. Do not delete it after approval; re-verification pulls
  it up again.
- **1280×720 or better**, real screen recording, no mockups, no stock footage, no music.
- **Narrate, or caption.** English audio or burned-in English captions. Silent screen
  recordings get sent back.
- **Use a throwaway identity.** A test Gmail account and a scrubbed profile — fake name,
  fake phone, fake address. Whatever is on screen is permanently on the internet.
- **Never show a real password.** The extension renders the stored login as dots; keep it
  that way and do not open a password manager on camera.
- **Apply to a disposable posting.** Do not submit a real application you care about. Per
  the project's own rule, the first run that reaches a submit gate is watched eyes-on.
- **Do not cut mid-action.** Reviewers read jump cuts as hiding a step. If a fill takes 30
  seconds, let it run, or speed it up visibly with an on-screen "2×" label.

---

# Video A — Chrome Web Store reviewer

The reviewer's unspoken questions, in order: *What is this? Why does it need the most
powerful permission Chrome has? Can it do something I would not expect? Who is in control?*
Answer them in that order.

| # | Duration | On screen | Say roughly this | What it proves |
|---|---|---|---|---|
| 1 | 0:00–0:20 | The companion site's profile page, scrubbed test data | "ApplyPilot fills job application forms. The user enters their profile once — contact details, work history, education, and the screening questions employers ask." | Single purpose; data is user-authored, not harvested |
| 2 | 0:20–0:35 | A real job application form, scrolled slowly | "This is what it is up against: a form with searchable dropdowns, type-ahead pickers, and multi-part date fields." | Sets up the `debugger` case with evidence, not assertion |
| 3 | 0:35–1:05 | Click the extension, start the fill. **Let Chrome's "ApplyPilot started debugging this browser" banner sit visibly in frame.** | "To fill these widgets, ApplyPilot uses Chrome's debugger API to send real keyboard and mouse input. These React widgets ignore synthetic events — a value set programmatically is discarded when the form re-renders, which would report a field as filled when the form is actually empty. Note Chrome's own banner: this access is visible to the user the entire time it is attached." | **The core justification.** Necessity plus visible, bounded scope |
| 4 | 1:05–1:35 | The fill proceeding; a type-ahead opening, filtering, committing | "Each value is read back after it is written and verified against what was intended." | Not a blind script; an accuracy tool |
| 5 | 1:35–2:10 | The review screen, with flagged rows | "Anything it could not answer with confidence is flagged. Here it is telling the user it guessed, and asking them to confirm." | Honest failure handling — reviewers weight this heavily |
| 6 | 2:10–2:35 | Correct one flagged value by hand | "The user corrects it, and that correction is what gets used." | Human in the loop, concretely |
| 7 | 2:35–3:00 | Reach the submit step and **stop**. Show the gate refusing while something is unapproved. | "ApplyPilot never submits on its own. Until every flagged value is approved, the submit step refuses to proceed." | The safety property, demonstrated rather than claimed |
| 8 | 3:00–3:20 | Show the debugger banner gone / the run ended | "When the run ends, the debugger is detached." | Closes the `debugger` story |

**Do show:** the banner (shot 3), a flagged guess (shot 5), the refusal (shot 7). Those
three are the video.

**Do not:** speed past the banner, or narrate `debugger` defensively. It is a legitimate
technical requirement with a real reason. State the reason plainly and move on.

---

# Video B — Google OAuth restricted-scope verification

Different game. This reviewer works from a checklist, and a missing item means a
resubmission with weeks of latency. Every item below is on that checklist.

### The identity problem, and how to solve it on camera

`chrome.identity.getAuthToken` shows the consent screen in a Chrome-managed window with
**no address bar**, so you cannot simply point at the URL to prove the `client_id` matches
your project — which is what the reviewer wants to see. Establish identity by bracketing
the grant instead:

1. **Before the grant:** show `chrome://extensions` with ApplyPilot's **extension ID**
   visible, then the Google Cloud Console OAuth client page showing the **same ID** in the
   Application ID field and the client ID string.
2. **The grant:** record the consent screen with the **app name and the requested scope**
   legible.
3. **After the grant:** show `myaccount.google.com/permissions` listing ApplyPilot with the
   scope it holds.

That chain proves the extension on screen is the client registered to the project, without
ever needing an address bar.

### Shot list

| # | On screen | Say roughly this | Checklist item |
|---|---|---|---|
| 1 | The published listing or `chrome://extensions` with name + **extension ID** in frame | "This is ApplyPilot, extension ID `<id>`." | App identity |
| 2 | Cloud Console → Credentials → the OAuth client, Application ID matching shot 1 | "It is the registered OAuth client for this project — same extension ID, client ID `<...>`." | Client ID ↔ app match |
| 3 | The privacy policy at `applypilot.vercel.app/privacy`, scrolled to **section 04**, Limited Use paragraph legible | "The privacy policy is on the app's own domain, linked from the home page, and states the Limited Use commitment." | Policy requirements |
| 4 | The extension's Gmail toggle, **off** | "The Gmail feature is off by default. Nothing is requested until the user turns it on." | Consent is opt-in |
| 5 | Turn it on → the consent screen, **app name and scope legible**, then Allow | "Turning it on shows Google's consent screen, requesting one scope: `gmail.readonly`, read-only." | **Consent flow — the central item** |
| 6 | An ATS account-creation step that emails a code | "Hiring sites email a verification code during account creation. This is the only situation the scope is used in." | Context of use |
| 7 | The extension finding the code and entering it; briefly show the actual email in Gmail so the code visibly matches | "ApplyPilot searches recent mail for that message, reads the code, and enters it — so the user does not switch to their inbox and copy it by hand." | **How the scope's data is used — the other central item** |
| 8 | The completed step; state the retention rule to camera | "The code is used immediately and discarded. Message contents are never stored in our database, never logged, and never sent to any AI provider or third party." | Limited Use in practice |
| 9 | `myaccount.google.com/permissions` showing ApplyPilot, then revoke it | "Access is read-only — it cannot send, delete, or modify mail — and the user can revoke it at any time." | Scope minimality + revocability |

### The question they will actually ask

> *Why do you need `gmail.readonly` rather than something narrower?*

Have this answer ready in the video **and** in the written justification, because it is the
crux of a restricted-scope review:

```
Gmail publishes no narrower read scope. Reading a verification code requires reading the
body of the message that contains it, and Gmail offers no per-sender, per-label, or
"transactional email only" read permission to request instead. The metadata scope
(gmail.metadata) cannot see message bodies, and the compose and modify scopes are broader,
not narrower. gmail.readonly is the least-privileged scope that can accomplish the
feature, and it is requested only when the user turns the feature on.
```

That answer works because it is true and it is falsifiable — the reviewer can check the
scope list. Do not claim you cannot function without it; claim, accurately, that it is the
narrowest scope that exists for the job.

### Two things that will get Video B sent back

- **Recording the grant on an account that already granted it.** You will get a silent
  token and no consent screen, and the central checklist item will be missing. **Revoke at
  `myaccount.google.com/permissions` first**, and confirm the screen actually appears.
- **The app name on the consent screen not matching** the name in the listing and Cloud
  project. Set the OAuth consent screen's app name to `ApplyPilot` before recording.

---

## Order of operations

The extension ID changes when you publish, and the OAuth client is bound to that ID
(`docs/gmail-setup.md` §1). So:

1. Create the store item and upload the package → **the published extension ID is minted**.
2. Register a Chrome-Extension OAuth client for **that** ID; update `oauth2.client_id`.
3. Record **Video B** against the published build, so the IDs on screen are the real ones.
4. Submit for OAuth verification.

Recording Video B against your unpacked dev build shows the reviewer a dev extension ID
that does not match the published client. **Video A can be recorded any time** — it shows
no identifiers.
