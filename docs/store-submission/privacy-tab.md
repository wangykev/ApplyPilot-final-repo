# Chrome Web Store → Privacy practices tab

Paste-ready answers for every field on the **Privacy practices** tab, plus the reasoning
behind each so you can defend it if a reviewer pushes back.

Two things to know before you start:

- **These answers are a certification, not marketing copy.** Under-disclosing a data
  category is the failure mode that gets an item taken down after it is live, which is far
  worse than a slow first review. Where a category is genuinely borderline, this document
  recommends **disclosing it** and says why.
- **`debugger` is the permission that decides this submission.** It is the most powerful
  permission Chrome grants an extension, very few published items request it, and the
  justification below is the single highest-leverage text in the whole listing. Do not
  shorten it.

---

## 1 · Single purpose

> **Field:** "Single purpose description"

```
ApplyPilot has one purpose: to fill in job application forms on the user's behalf from a
profile they maintain, and to let them review every filled value before anything is
submitted.

Everything in the extension serves that one flow. The user stores their profile once
(contact details, work history, education, and the standard screening answers employers
ask for). When they open a job application, ApplyPilot reads the form's fields, matches
each one against their stored profile, fills what it can answer confidently, and records
every value it entered. Anything it could not answer with certainty is flagged for the
user to correct. The extension never submits an application on its own: submission happens
only after the user has reviewed and approved the flagged values.
```

**Why this wording:** the single-purpose policy is about *scope coherence*, not feature
count. Naming the fill → review → submit pipeline makes the résumé handling, the job
tracker, and the optional AI assist read as steps in one purpose rather than as three
bundled products.

---

## 2 · Permission justifications

One field per permission. Each is written to answer the reviewer's actual question — *why
is a narrower permission not sufficient?*

### `activeTab`

```
ApplyPilot fills the job application form in the tab the user is already looking at, and
only after they click the extension. activeTab scopes that access to that single tab at
that moment, which is narrower than requesting host permissions for the many thousands of
employer domains that host application forms.
```

### `scripting`

```
Filling a form requires running code in the page's own context. Application forms are
built with React, which keeps its own copy of each field's state; assigning to
input.value updates the DOM but not React's state, and the value is discarded when the
form is submitted. ApplyPilot therefore injects a routine that sets values through the
native property setter and dispatches the input and change events React listens for. The
same injection reads the job title, company, and job description so the user's application
tracker can show what they applied to.
```

### `storage`

```
Stores the user's profile, their answer preferences, and their extension settings locally
so they do not have to re-enter them for every application. This is the extension's own
local storage; it holds only data the user entered, and nothing is written to it from any
page they visit.
```

### `debugger` — the important one

```
ApplyPilot drives application forms using Chrome's input dispatch (Input.dispatchKeyEvent,
Input.dispatchMouseEvent) and Runtime.evaluate through chrome.debugger. Two hard
requirements make this necessary, and no other extension API provides either.

1. TRUSTED INPUT EVENTS. Enterprise application forms (Workday, iCIMS and similar) are
   React applications whose complex widgets only commit a value in response to genuine
   user input. Their searchable dropdowns, type-ahead pickers, and multi-segment date
   fields filter and commit on real keyboard and pointer events; a synthetic event
   dispatched from page script is ignored, or worse, appears to work and is then silently
   discarded when the page re-renders. That last case is the dangerous one for an
   accuracy tool: it reports a field as filled when the form actually holds nothing, so a
   user submits an incomplete application believing it is complete. chrome.debugger is
   the only extension API that can produce input events the page treats as trusted, which
   is what makes a verified fill possible at all.

2. WORKING WHILE THE TAB IS NOT IN THE FOREGROUND. A multi-page application takes minutes
   to complete. When the tab is backgrounded or minimised, Chrome throttles the page's
   timers to roughly once per second and then freezes them, so any fill routine driven by
   page-side timing stalls part-way through a form. CDP commands are issued from the
   extension's service worker and execute off the page's event loop, so a run started by
   the user completes reliably instead of hanging half-filled.

SCOPE AND VISIBILITY. The debugger is attached to exactly one tab, only for the duration
of a run the user explicitly started, and detached when the run ends. Chrome displays its
own "ApplyPilot started debugging this browser" banner for the entire attachment, so the
access is visible to the user the whole time it is active — it cannot be used covertly.
ApplyPilot does not use the debugger to read network traffic, cookies, or storage from any
site, and it does not use it on any page other than the application form the user chose.
No code is downloaded or executed; every instruction issued is part of the reviewed
package.
```

### `identity`

```
Used only for the optional Gmail verification feature, which is off by default. Hiring
sites email a verification code when creating an account. With the user's explicit
permission, ApplyPilot calls chrome.identity.getAuthToken to obtain an OAuth token for the
single read-only scope gmail.readonly, reads that code, and enters it into the form so the
user does not have to switch to their inbox and copy it by hand. If the feature is left
off, no token is ever requested.
```

### `tabs`

```
A job application spans several pages. ApplyPilot needs to know when the tab it is filling
has navigated to the next page, and needs that tab's URL to select the correct handler for
the hiring system in use. Both come from the tab it is already working on. ApplyPilot does
not enumerate, read, or track the user's other tabs.
```

### Host permissions

Put this in the single "host permission justification" field, keeping the per-host
breakdown — a reviewer scanning ten hosts wants to see each one accounted for.

```
*://*.myworkdayjobs.com/* and *://*.myworkdaysite.com/*
  The Workday-hosted application forms the extension fills. Needed so the extension can
  read the job description and the form's fields on the page the user is applying through.

https://www.linkedin.com/* and https://app.joinhandshake.com/*
  For the optional job-search feature, which reads the user's own saved and recommended
  job lists on boards they are already signed in to, and adds them to their queue. It is
  strictly read-only: it never clicks an apply button and never attempts a sign-in.

https://raw.githubusercontent.com/*
  Fetches one public JSON file: a community-maintained list of open internship postings.
  The request carries no user data, and the response is parsed as JSON — never executed.

https://gmail.googleapis.com/*
  The read-only Gmail call that retrieves an emailed verification code, for the optional
  feature described under the identity permission.

https://api.anthropic.com/*, https://api.openai.com/*,
https://generativelanguage.googleapis.com/*
  For the optional AI assist, which is off by default. When the user enables it and
  supplies their own API key, the extension calls the provider they chose to suggest an
  answer for a required question their profile does not cover. Every such answer is
  flagged for the user to confirm and is never submitted unreviewed.

https://applypilot.vercel.app/*
  The extension's own companion site. The user's profile is authored there and read from
  there, and the record of what was filled is sent there so they can review and approve it
  before submitting.
```

---

## 3 · Remote code

> **Field:** "Are you using remote code?" → **No, I am not using remote code**

Verified against the source, so you can answer this confidently:

- No `<script src>` pointing off-package, no `eval` of fetched text, no dynamic
  `import()` of a remote URL, no WebAssembly fetched at runtime.
- The `raw.githubusercontent.com` request returns a **JSON data file** (a list of job
  postings) which is parsed with `JSON.parse`. Data, not code.
- LLM responses are treated as **candidate strings** that must match one of the options the
  form itself offers. They are never executed.
- `chrome.debugger`'s `Runtime.evaluate` executes only string literals that ship inside the
  reviewed package. Nothing from the network reaches it.

⚠ If a reviewer challenges this because of `Runtime.evaluate`, the distinction to make is
that the policy is about code whose *source* is remote. Every instruction ApplyPilot
evaluates is in the package they are reading.

---

## 4 · Data usage disclosures

Check these categories:

| Category | Answer | Why |
|---|---|---|
| Personally identifiable information | **YES** | Name, email, phone, postal address, plus voluntary demographic self-identification. |
| Health information | **YES** | The EEO self-identification section stores **disability status**. Optional for the user, but it is health-related data and must be disclosed. |
| Financial and payment information | **YES** | Judgment call — see the note below. |
| Authentication information | **YES** | The hiring-site account login, the user's AI provider API keys, and the Gmail OAuth token. |
| Personal communications | **YES** | With the optional Gmail feature on, the extension reads the message containing the verification code. |
| Location | **NO** | A home address is disclosed as PII. No GPS, IP-derived, or inferred location is collected. |
| Web history | **NO** | Only the URLs of postings the user chose to apply to or queue are stored. Browsing history is never read or collected. |
| User activity | **NO** | No click, scroll, keystroke, or mouse-position monitoring. No analytics of any kind. |
| Website content | **YES** | The job description text and the form's own field labels and answer options are read to fill the form and populate the tracker. |

**On "Financial and payment information":** the category is aimed at payment
instruments and credit data, and ApplyPilot handles neither. What it does store is the
user's **salary expectation**, which is financial information about a person. The
recommendation is to **check the box**: the cost is one line in the listing, whereas an
undisclosed category is the kind of finding that gets a live item pulled. If you would
rather not, the defensible alternative is to leave it unchecked and treat salary
expectation as an application answer — but make that call deliberately, not by accident.

### The three certifications

All three are true for ApplyPilot; check each one.

- ☑ I do not sell or transfer user data to third parties, outside of the approved use cases
- ☑ I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- ☑ I do not use or transfer user data to determine creditworthiness or for lending purposes

The third is worth a beat: an application-filling tool touches employment and salary data,
which is adjacent to credit decisioning. ApplyPilot does nothing of the kind, so the
certification is accurate.

---

## 5 · Privacy policy URL

```
https://applypilot.vercel.app/privacy
```

Requirements this URL already satisfies (`web/app/privacy/page.tsx`):

- **Publicly reachable, no login.** The middleware matcher only guards `/app/:path*`, so
  `/privacy` is never redirected. Confirm with a logged-out browser before submitting —
  a policy URL behind a login is a standard rejection.
- **Linked from the home page.** Required by Google OAuth verification, not by Chrome. The
  link lives in `web/components/site/Footer.tsx`; do not remove it.
- **Carries the Google Limited Use disclosure**, which the restricted-scope review checks
  for by name.
- **Same domain as the app**, also a Google OAuth requirement.

⚠ Set `CONTACT_EMAIL` in `web/app/privacy/page.tsx` to a mailbox you actually read. It
currently reads `support@applypilot.app`, a placeholder. Both reviews test the contact,
and a bounce restarts the queue.
