# Store listing — copy and assets

Paste-ready text for the **Store listing** tab, then the asset specs and a shot list.

Field limits, so nothing gets truncated on submit: **name 75 chars**, **short description
132 chars**, **detailed description 16,000 chars**.

---

## Name (75 max)

```
ApplyPilot — job application autofill with a review step
```

56 characters. The trailing clause is doing real work: "autofill" alone reads like the
dozens of form-fillers already in the store, and the review step is the actual difference.

## Short description (132 max)

This is the line shown in search results and next to the install button — the highest-read
text in the whole listing.

```
Fills job applications from your saved profile, flags every value it had to guess, and never submits without your approval.
```

125 characters. Leads with the benefit, closes with the guarantee.

## Category

**Workflow & Planning.** It is a productivity tool for a repeated task. *Tools* is the
tempting alternative and is worse: it is the store's most crowded catch-all, and a job
seeker does not browse it.

## Language

English (United States).

---

## Detailed description

```
ApplyPilot fills in job application forms for you — and then shows you exactly what it
entered before anything is submitted.

Applying for jobs means typing the same forty fields into a different form every time.
Your name, your address, your work history, your education, the same screening questions
worded slightly differently. ApplyPilot does that typing. You keep the final word.

HOW IT WORKS

1. Set up your profile once on the ApplyPilot website — contact details, work history,
   education, skills, and the standard questions employers ask. Upload your resume.

2. Open a job application and start a fill. ApplyPilot reads the form, matches each field
   against your profile, and fills what it can answer confidently.

3. Review what it did. Every value it entered is listed for you, in the order the form
   asks. Anything it had to guess is flagged and sorted to the top.

4. Approve, correct anything wrong, and submit. Until every flagged value is approved,
   the submit step will not proceed.

WHAT MAKES IT DIFFERENT

A wrong answer on a job application is worse than a blank one. An autofill tool that
guesses confidently and quietly will eventually put the wrong salary, the wrong work
authorization, or the wrong answer to a legally-loaded question in front of an employer,
and you will never know it happened. ApplyPilot is built the other way around:

- It only fills a choice when it has an exact match for your answer, or an obvious typo
  variant of it. Anything less becomes a question for you rather than a guess.
- Every value it writes is read back off the page and verified. If it cannot confirm what
  it wrote, it says so instead of reporting success.
- It never submits on its own. Not as a setting you can change — the review gate is the
  point of the tool.
- Questions about disability, veteran status, race, and gender are always optional, and it
  will not invent an answer to one. Neither will it invent a security clearance you did
  not tell it you hold.

SUPPORTED APPLICATION SYSTEMS

Workday, Greenhouse, Lever, Ashby, and iCIMS — the systems behind most corporate job
applications, including multi-page Workday flows with work history, education, and
voluntary self-identification sections.

OPTIONAL FEATURES, ALL OFF BY DEFAULT

- AI assist. For a required question your profile does not cover, ApplyPilot can ask an
  AI provider you choose, using your own API key. Every AI-suggested answer is flagged for
  you to confirm — none is ever submitted unreviewed.
- Email verification. Hiring sites often email a code when you create an account. With
  your permission, ApplyPilot can read that code from Gmail so you do not have to switch
  to your inbox. Read-only, used for nothing else, and stored nowhere.
- Job search. Pull your own saved and recommended postings from job boards you are already
  signed in to into a queue. Read-only: it never clicks apply for you.

YOUR DATA

Your profile is yours. It is not sold, not shared with advertisers, and not used to train
anyone's models. There is no analytics or tracking of any kind in this extension. What
leaves your browser is the application you chose to send to the employer you chose to send
it to — plus, only if you turn AI assist on, the prompts that go to your own provider.

Full detail, including how the optional Gmail permission works and how a stored hiring-site
password is handled: https://apply-pilot-final-repo.vercel.app/privacy

A NOTE ON THE PERMISSIONS

ApplyPilot asks for Chrome's debugger permission, which is unusual, so here is why.
Application forms are built with React, and their searchable dropdowns and date fields only
accept a value from genuine keyboard and mouse input — a value set by script is silently
discarded when the page re-renders, which would report a field as filled when the form is
actually empty. The debugger API is the only way an extension can send real input events,
and it is also what lets a long multi-page fill keep running when the tab is not in the
foreground. Chrome shows its own banner the entire time it is attached, so you can always
see when it is active, and it detaches when the run ends.
```

---

## Assets

### Store icon — 128×128 PNG · **required** · ✔ done

`icons/icon128.png`, generated by `node scripts/build-icons.mjs`. Upload that exact file.

### Screenshots — 1280×800 PNG · **at least 1, up to 5** · ✖ you must capture these

Hard requirements: exactly **1280×800** or 640×400, PNG or JPEG, **24-bit, no alpha
channel**. A PNG with transparency is rejected — if you crop in an editor, flatten before
export.

Capture at 1280×800 directly: in Chrome DevTools, toggle the device toolbar, choose
"Responsive", type 1280 × 800, then use the ⋮ menu → "Capture screenshot". That produces
exactly the right dimensions with no cropping.

The five shots, in listing order. Order matters — most people look at the first two.

| # | Shot | Why it is in this position |
|---|---|---|
| 1 | **The review screen with flagged rows visible.** A field marked as a guess, awaiting confirmation. | The differentiator, first. Anyone can claim autofill; this shows the honesty mechanism. |
| 2 | **A filled application form** next to the extension, obviously complete. | The payoff — what the user actually wants. |
| 3 | **The profile editor** on the website, with sections populated (scrubbed data). | Shows the one-time setup and that data is user-authored. |
| 4 | **The submit gate refusing** while something is unapproved. | Proves the safety claim rather than asserting it. |
| 5 | **The application tracker** listing several applications with statuses. | Shows it is a workflow, not a one-shot button. |

⚠ **Scrub every screenshot.** Fake name, fake phone, fake address, no real email, no real
posting you care about. These are public forever. Check the browser's tab strip, bookmarks
bar, and any notification badges before capturing — those leak more real data than the page
does.

### Small promo tile — 440×280 PNG · optional

Skip it for now. It only matters for merchandising and homepage placement, which an
unlisted item is not eligible for anyway. If you later go public and want it, the mark on a
`#0A0E14` field with the wordmark set in Space Grotesk matches the site.

### Marquee promo tile — 1400×560 · skip

Featured-placement only.

### Promo video — YouTube URL · optional field, high value here

This is **Video A** from `demo-videos.md`. The field is optional, but for an extension
requesting `debugger`, it is the most effective thing you can put in the listing.

---

## Visibility

Start **Unlisted**.

Same review, same requirements, but the item does not appear in search or category
browsing — anyone with the link can install it. That is the right trade while you are
iterating: you get a real installable build and an update channel without a public listing
to defend, and no chance of a stranger installing v1.0.0 and reviewing it badly while you
are still finishing tenants. Switching to Public later is a visibility change on the same
item, and it keeps your extension ID, your users, and your review history.
