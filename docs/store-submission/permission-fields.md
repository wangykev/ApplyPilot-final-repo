# Privacy-tab form fields — 1000-char versions

The dashboard caps **every** free-text field on this tab at 1000 characters — the single
purpose description and each permission justification alike. The prose in `privacy-tab.md`
explains the reasoning at length for our own reference; these are the versions that fit the
form. Every block below is verified by `npm run check:justifications`, which measures the
**CRLF-adjusted** length (see the script — a field measuring 999 can arrive as 1015).

What survived the cut, and what did not: every field keeps the *why a narrower permission
will not do* argument, because that is the reviewer's real question. What was dropped is
restatement and context. In `debugger` the two mechanisms and the scope-and-visibility
paragraph are all load-bearing and all stayed.

---

## Single purpose description

The policy tests *scope coherence*, not feature count — so this names the one pipeline
(fill → review → submit) and lets the résumé handling, the tracker and the optional AI read
as steps within it rather than as separate bundled products. It also states the never-submit
guarantee, because a reviewer's first worry about an application-filling tool is an extension
that applies to jobs on its own.

```
ApplyPilot has one purpose: to fill in job application forms on the user's behalf from a
profile they maintain, and to let them review every filled value before anything is
submitted.

Everything in the extension serves that one flow. The user stores their profile once —
contact details, work history, education, and the answers employers commonly ask for. When
they open a job application, ApplyPilot reads the form's fields, matches each against that
profile, fills what it can answer confidently, and records every value it entered. Anything
it cannot answer with certainty is flagged for the user to correct rather than guessed at.

The extension never submits an application by itself. Submission happens only after the
user has reviewed the record of what was filled and approved the flagged values.
```

## activeTab

```
ApplyPilot fills the job application form in the tab the user is already viewing, and only
after they click the extension. activeTab limits access to that one tab at that moment.

The alternative would be requesting host permissions across the many thousands of employer
domains that host application forms, which is far broader than the extension needs.
```

## scripting

```
Filling a form requires running code in the page's own context.

Application forms are built with React, which keeps its own copy of each field's state.
Assigning to input.value updates the DOM but not React's state, and the value is then
discarded when the form is submitted. ApplyPilot injects a routine that sets values through
the native property setter and dispatches the input and change events React listens for,
which is the only way the value persists.

The same injection reads the job title, company and job description so the user's own
application tracker records what they applied to.

Injection happens only in the tab the user chose, only when they start a fill.
```

## storage

```
Stores the user's own profile — contact details, work history, education, and their saved
answers to the questions employers commonly ask — plus their answer preferences and the
extension's settings, so they do not have to re-enter all of it for every application.

This is the extension's own local storage. It holds only data the user entered themselves.
Nothing is written to it from any page they visit, and none of it is transmitted anywhere
except into the application form the user is applying through.
```

## debugger

```
ApplyPilot fills forms by sending input via chrome.debugger (Input.dispatchKeyEvent /
dispatchMouseEvent, Runtime.evaluate). Two requirements make this necessary; no other
extension API meets either.

1. TRUSTED INPUT. Application forms (Workday, iCIMS) are React apps whose searchable
dropdowns, type-aheads and date fields commit a value only on genuine keyboard/pointer
events. A synthetic event is ignored, or appears to work then is discarded on re-render —
reporting a field as filled while the form holds nothing, so an incomplete application is
submitted as complete.

2. BACKGROUNDED TABS. Chrome throttles then freezes page timers when a tab leaves the
foreground, stalling a multi-page fill. CDP commands run from the service worker, off that
loop.

SCOPE: one tab, only during a user-started run, detached when it ends. Chrome's debugging
banner shows throughout, so this cannot be covert. Never used to read network traffic,
cookies or site storage.
```

## identity

```
Used only for the optional Gmail verification feature, which is off by default.

Hiring sites email a verification code when the user creates an account. With the user's
explicit permission, ApplyPilot calls chrome.identity.getAuthToken to obtain a token for
one read-only scope, gmail.readonly, reads that code, and enters it into the form — so the
user does not have to switch to their inbox and copy it by hand.

If the user leaves the feature off, no token is ever requested and no Google user data is
accessed.
```

## tabs

```
A job application spans several pages.

ApplyPilot needs to detect when the tab it is filling has navigated to the next page of the
application, so it can continue, and it needs that tab's URL to select the correct handler
for the hiring system in use (Workday, Greenhouse, Lever, Ashby, iCIMS).

Both come from the single tab it is already working on. ApplyPilot does not enumerate,
read, or track the user's other tabs.
```

## Host permission

```
myworkdayjobs.com, myworkdaysite.com: the Workday application forms the extension fills —
needed to read the form's fields and the job description on the page the user is applying
through.

linkedin.com, app.joinhandshake.com: the optional job-search feature, reading the user's
own saved and recommended postings on boards they are already signed in to. Read-only; it
never clicks apply and never attempts a sign-in.

raw.githubusercontent.com: fetches one public JSON file listing open postings. No user data
is sent, and the response is parsed as JSON, never executed.

gmail.googleapis.com: the read-only Gmail call for the emailed verification code.

api.anthropic.com, api.openai.com, generativelanguage.googleapis.com: the optional AI
assist, off by default, calling the provider the user chose with the user's own API key.

apply-pilot-final-repo.vercel.app: our own companion site, where the user authors their
profile and reviews what was filled.
```

## Remote code → **No, I am not using Remote code**

Fill the justification field anyway; it is shown for both answers.

```
All JavaScript in ApplyPilot executes from files inside the extension package. There are no
external script tags, no modules pointing at external files, and no eval() of fetched text.

The one outbound data request, to raw.githubusercontent.com, returns a JSON file that is
parsed with JSON.parse and never executed.

Strings passed to Runtime.evaluate are literals that ship inside the reviewed package;
nothing from the network reaches them. Responses from AI providers are treated only as
candidate text matched against the options the form itself offers, never as code.
```
