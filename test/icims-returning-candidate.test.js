// test/icims-returning-candidate.test.js — signing in instead of re-creating the account.
//
// iCIMS creates the candidate account AS PART OF SUBMITTING, so step 1 embeds a "Create a login"
// block. Once that email has an account the step fills perfectly and the server refuses it:
//   "This email address is already in use. Please login or use another email address."
// Live on Shure 5013, 2026-09-09, with a FRESH alias — which is what proved the alias-bumping
// workaround does not actually address this.
//
// Two things are being pinned here, and the second is the dangerous one:
//   1. the recognizer fires on that refusal and NOT on the form's many harmless mentions of "Login";
//   2. the control we press can never be `input#cp_form_submit_i`, which on this platform is Next on
//      every step and the REAL SUBMIT on the last.
//
// Run: node --test test/icims-returning-candidate.test.js

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { icimsAccountExists, icimsLoginControlPick, atsInjIcimsLoginLink, icimsIsAdminLogin, icimsIsIcimsHost } = require("../ats.js");

// ── the recognizer ───────────────────────────────────────────────────────────────────────────────

test("⚠ the form's real refusal is recognised", () => {
  // Verbatim from the live run.
  assert.ok(icimsAccountExists(["This email address is already in use. Please login or use another email address."]));
  // Sibling wordings other tenants use for the same condition.
  assert.ok(icimsAccountExists(["That username is already taken."]));
  assert.ok(icimsAccountExists(["An account with this email already exists."]));
  assert.ok(icimsAccountExists(["This login is already registered."]));
  // It only needs ONE of several errors to match.
  assert.ok(icimsAccountExists(["First Name is required.", "This email address is already in use."]));
});

test("⚠⚠ a harmless mention of Login must NOT read as the account existing", () => {
  // Every one of these is really on this form. Treating any as the collision would send a fully
  // filled application off to a sign-in page and lose the fill.
  assert.ok(!icimsAccountExists(["Login"]));
  assert.ok(!icimsAccountExists(["Create a login"]));
  // ⚠⚠ THE ONE THAT BIT. "Already have an account?" is the heading printed NEXT TO the Login link,
  // so it is on the page every single visit — including the first, before any account exists.
  // An earlier draft of the regex matched it, which would have sent every filled form to a sign-in
  // page and lost the fill. It is an INVITATION, not a claim that our email is taken.
  assert.ok(!icimsAccountExists(["Already have an account?"]));
  assert.ok(!icimsAccountExists(["Already have an account? Log in"]));
  assert.ok(!icimsAccountExists(["Please login to continue."]));
  assert.ok(!icimsAccountExists(["Password is required."]));
  assert.ok(!icimsAccountExists(["You will be logged out in 60 seconds due to inactivity."]));
  // BOTH halves are required — a collision about something that is not an account is not this.
  assert.ok(!icimsAccountExists(["This requisition is already in use by another recruiter."]));
  assert.ok(!icimsAccountExists([]));
  assert.ok(!icimsAccountExists(null));
});

// ── the picker: refuses rather than guesses ─────────────────────────────────────────────────────

test("⚠ exactly one usable control is required — none refuses", () => {
  const r = icimsLoginControlPick([{ caption: "Login", usable: false, excludedBecause: "not-visible" }]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "none");
  assert.deepStrictEqual(r.offered, ["Login"], "the rejected captions ARE the diagnosis when this refuses");
});

test("⚠⚠ two usable controls REFUSE — one wrong press here is the application's own Submit", () => {
  const r = icimsLoginControlPick([
    { caption: "Login", usable: true }, { caption: "Sign in here", usable: true },
  ]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "ambiguous");
  assert.deepStrictEqual(r.offered, ["Login", "Sign in here"]);
});

test("one usable control is taken", () => {
  const r = icimsLoginControlPick([
    { caption: "Login", usable: true, sel: "#cp_login" }, { caption: "Login", usable: false },
  ]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.control.sel, "#cp_login");
});

test("a missing / junk candidate list is safe", () => {
  assert.strictEqual(icimsLoginControlPick(undefined).ok, false);
  assert.strictEqual(icimsLoginControlPick([null, undefined]).ok, false);
});

// ── the probe, EXECUTED against a DOM double (the house precedent: ats-ashby-checkbox-group) ─────

const scrolled = [];
function withDom(els, scrollToIndex) {
  scrolled.length = 0;
  const mk = (o) => ({
    tagName: (o.tag || "a").toUpperCase(),
    id: o.id || "",
    value: o.value || "",
    textContent: o.text || "",
    scrollIntoView: () => scrolled.push(o.text || o.value),
    getBoundingClientRect: () => ({
      width: o.w == null ? 60 : o.w, height: o.h == null ? 20 : o.h,
      left: o.x == null ? 10 : o.x, top: o.y == null ? 40 : o.y,
    }),
    getAttribute: (k) => (o.attrs && k in o.attrs ? o.attrs[k] : null),
  });
  const nodes = els.map(mk);
  global.document = { querySelectorAll: () => nodes };
  global.CSS = { escape: (s) => String(s) };
  global.window = {};
  global.location = { hostname: "careersus-shure.icims.com", href: "https://careersus-shure.icims.com/jobs/5013/x/candidate" };
  try { return atsInjIcimsLoginLink(scrollToIndex); } finally {
    delete global.document; delete global.CSS; delete global.window; delete global.location;
  }
}

test("a plain <a>Login</a> is usable and carries a clickable rect", () => {
  const r = withDom([{ tag: "a", text: "Login", id: "cp_login", attrs: { href: "/login" } }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.candidates.length, 1);
  const c = r.candidates[0];
  assert.strictEqual(c.usable, true);
  assert.strictEqual(c.sel, "#cp_login");
  assert.ok(c.rect && c.rect.cx > 0 && c.rect.cy > 0);
});

test("⚠⚠ the rect is cx/cy — the shape atsAimedClick actually reads", () => {
  // Live 2026-09-09: this returned {x,y} and the press logged
  // `translating undefined,undefined by the frame's own offset → NaN,NaN`, so the recovery found the
  // right control and then clicked nowhere. A wrong KEY NAME is invisible to every read-back we have,
  // because nothing was ever pressed to read back.
  const c = withDom([{ tag: "a", text: "Login", id: "cp_login" }]).candidates[0];
  assert.deepStrictEqual(Object.keys(c.rect).sort(), ["cx", "cy", "h", "w"]);
  assert.strictEqual(typeof c.rect.cx, "number");
  assert.strictEqual(typeof c.rect.cy, "number");
  assert.ok(!("x" in c.rect) && !("y" in c.rect), "x/y would silently NaN the frame-offset translation");
});

test("⚠ scrolling happens BEFORE the rects are taken, and only for the chosen control", () => {
  const r = withDom([
    { tag: "a", text: "Login", id: "a1" },
    { tag: "a", text: "Sign in here", id: "a2" },
  ], 1);
  assert.deepStrictEqual(scrolled, ["Sign in here"], "only the chosen candidate is scrolled into view");
  assert.strictEqual(r.candidates.length, 2, "every candidate is still measured, in one frame of reference");
  // …and the default call scrolls nothing at all.
  withDom([{ tag: "a", text: "Login", id: "a1" }]);
  assert.deepStrictEqual(scrolled, [], "the no-argument probe stays read-only");
});

test("⚠⚠ an <input type=submit> captioned Login is REPORTED but NEVER usable", () => {
  // This is the whole point of the probe's <a>/<button> restriction: `input#cp_form_submit_i` is
  // Next on every step and the REAL SUBMIT on the last, and it is one caption away from matching.
  const r = withDom([
    { tag: "input", value: "Login", id: "cp_form_submit_i", attrs: { type: "submit" } },
    { tag: "input", value: "Sign in", id: "some_other_submit", attrs: { type: "submit" } },
  ]);
  assert.strictEqual(r.candidates.length, 2);
  for (const c of r.candidates) {
    assert.strictEqual(c.usable, false, c.caption + " must never be pressable");
    assert.strictEqual(c.excludedBecause, "not-an-anchor-or-button");
  }
  assert.strictEqual(icimsLoginControlPick(r.candidates).ok, false);
});

test("⚠ a zero-rect control is reported and refused", () => {
  const r = withDom([{ tag: "a", text: "Login", id: "hidden_login", w: 0, h: 0 }]);
  assert.strictEqual(r.candidates[0].usable, false);
  assert.strictEqual(r.candidates[0].excludedBecause, "not-visible");
  assert.strictEqual(r.candidates[0].rect, null);
});

test("⚠ prose that merely mentions signing in is not a candidate at all", () => {
  const r = withDom([
    { tag: "a", text: "Forgot your password?" },
    { tag: "a", text: "By logging in you agree to our terms" },
    { tag: "button", text: "Submit Profile" },
    { tag: "a", text: "Create a login" },
  ]);
  assert.deepStrictEqual(r.candidates, [], "none of these is an invitation to sign in");
});

test("⚠⚠ iCIMS' OWN login host is allowed — the operator corrected this one", () => {
  // A first version refused ANY cross-host link, on the reasoning that the candidate login lives on
  // the tenant host. The operator corrected it: this tenant's Login control legitimately goes to
  // `login.icims.eu`, and "the things later in the link identify it from their backend" — the
  // candidate/tenant identity is in the path and query, not the hostname. Refusing it would have
  // broken the real flow, so the guard keeps only what it can actually justify.
  const r = withDom([{ tag: "a", text: "login", attrs: { href: "https://login.icims.eu/sso/login?tenant=shure" } }]);
  assert.strictEqual(r.candidates[0].usable, true);
  assert.strictEqual(r.candidates[0].offSite, false);
  assert.strictEqual(icimsLoginControlPick(r.candidates).ok, true);
});

test("⚠ a link off to a THIRD PARTY is still refused", () => {
  // What the guard is actually for: a footer/partner/marketing link pressed with an application
  // half-filled sends the run somewhere it can never sign in.
  for (const href of ["https://www.shure.com/careers", "https://accounts.google.com/signin", "https://evil.example/login"]) {
    const r = withDom([{ tag: "a", text: "Login", attrs: { href } }]);
    assert.strictEqual(r.candidates[0].usable, false, href + " must be refused");
    assert.strictEqual(r.candidates[0].excludedBecause, "leaves-the-tenant-and-icims");
  }
});

test("icimsIsIcimsHost tells the vendor's own infrastructure from anything else", () => {
  assert.ok(icimsIsIcimsHost("https://login.icims.eu/sso"));
  assert.ok(icimsIsIcimsHost("https://careersus-shure.icims.com/jobs/1/x"));
  assert.ok(icimsIsIcimsHost("https://icims.com/"));
  assert.ok(!icimsIsIcimsHost("https://www.shure.com/careers"));
  assert.ok(!icimsIsIcimsHost("https://noticims.com/x"), "the boundary must be a dot, not a substring");
  assert.ok(!icimsIsIcimsHost("https://icims.com.evil.example/x"), "a suffix-lookalike is not iCIMS");
  assert.ok(!icimsIsIcimsHost("not a url"));
});

test("a same-host login link (absolute or relative) is fine", () => {
  const rel = withDom([{ tag: "a", text: "Login", id: "a", attrs: { href: "/jobs/5013/x/login" } }]);
  assert.strictEqual(rel.candidates[0].usable, true);
  assert.strictEqual(rel.candidates[0].offSite, false);
  const abs = withDom([{ tag: "a", text: "Login", id: "b", attrs: { href: "https://careersus-shure.icims.com/jobs/5013/x/login" } }]);
  assert.strictEqual(abs.candidates[0].usable, true);
  // a fragment / javascript: href is not a navigation, so it is not off-site
  const frag = withDom([{ tag: "a", text: "Login", id: "c", attrs: { href: "#" } }]);
  assert.strictEqual(frag.candidates[0].usable, true);
  // …and an href we cannot even parse REFUSES — we cannot vouch for where it goes
  const junk = withDom([{ tag: "a", text: "Login", id: "d", attrs: { href: "http://[::bad::]" } }]);
  assert.strictEqual(junk.candidates[0].usable, false);
  assert.strictEqual(junk.candidates[0].excludedBecause, "leaves-the-tenant-and-icims");
});

test("⚠⚠ the staff-login bypass needs BOTH provenance AND an iCIMS host", () => {
  // `login.icims.*` is the RECRUITER login and stays refused on sight. The single exception is a
  // page the tenant's own application form linked to — provenance, never the hostname alone. Both
  // halves must be required, or the exemption becomes "any login.icims.* page is fine".
  const i = bg.indexOf("async function runIcimsPreForm(");
  const fn = bg.slice(i, i + 9000);
  assert.match(fn, /const vouchedIcimsLogin = viaTenantLoginLink && url && icimsIsIcimsHost\(url\)/,
    "the bypass must require the caller's provenance AND that the destination is still iCIMS");
  assert.match(fn, /icimsIsAdminLogin\(url\) && !vouchedIcimsLogin/,
    "the staff-login refusal must still fire for a login.icims.* page reached any other way");
  // …and only the returning-candidate stage may claim that provenance.
  assert.strictEqual((bg.match(/viaTenantLoginLink: true/g) || []).length, 1,
    "exactly one caller may vouch for a login.icims.* destination");
});

test("⚠⚠ the STAFF login is refused on every TLD, not just .com", () => {
  // The guard was an equality test against the literal "login.icims.com", and iCIMS also serves
  // login.icims.eu — which is how a candidate password reached the central login.
  assert.ok(icimsIsAdminLogin("https://login.icims.com/sso"));
  assert.ok(icimsIsAdminLogin("https://login.icims.eu/sso/login"));
  assert.ok(icimsIsAdminLogin("https://LOGIN.ICIMS.EU/x"));
  assert.ok(icimsIsAdminLogin("https://login.icims.co.uk/x"));
  // …and a TENANT portal is never mistaken for it, whatever its name.
  assert.ok(!icimsIsAdminLogin("https://careersus-shure.icims.com/jobs/5013/x/login"));
  assert.ok(!icimsIsAdminLogin("https://login-services.icims.com/x"), "only the bare 'login' host is the staff login");
  assert.ok(!icimsIsAdminLogin("https://careers.astrion.us/login"));
  assert.ok(!icimsIsAdminLogin("not a url"));
});

test("an invitation phrased as a sentence still counts", () => {
  const r = withDom([{ tag: "a", text: "Already have an account? Log in", id: "x" }]);
  assert.strictEqual(r.candidates.length, 1);
  assert.strictEqual(r.candidates[0].usable, true);
});

// ── SOURCE-TEXT GUARDS (background.js / cdp.js are service-worker files and cannot be require()d) ─
// Comments are stripped FIRST — both files now *document* the shapes they refuse, and a naive grep
// matches the explanation instead of the code. `[^\r\n]*`, never `.*$`: this repo checks out CRLF
// and JS `.` does not match `\r`, so `.*` cannot reach `$` and NOTHING would be stripped.
const strip = (t) => String(t)
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .split("\n").map((l) => l.replace(/\/\/[^\r\n]*/, "")).join("\n");

const bg = strip(fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8"));
const cdp = strip(fs.readFileSync(path.join(__dirname, "..", "cdp.js"), "utf8"));

test("⚠⚠ a JS dialog is ALWAYS answered — an unanswered one wedges the renderer", () => {
  assert.match(cdp, /Page\.javascriptDialogOpening/, "the opening event must be listened for");
  assert.match(cdp, /Page\.handleJavaScriptDialog/, "and every one must be answered");
});

test("⚠⚠ the DEFAULT dialog policy refuses — only an armed leave is accepted", () => {
  const i = cdp.indexOf("function cdpDialogPolicy(");
  assert.ok(i > 0, "cdpDialogPolicy must exist and be pure/testable");
  const fn = cdp.slice(i, i + 400);
  assert.match(fn, /beforeunload"\s*\)\s*return\s*!!armed/,
    "a leave dialog is accepted ONLY while armed — otherwise a stray one discards a filled form");
  assert.match(fn, /return false;/, "confirm/prompt default to CANCEL — never agree to an unasked question");
});

test("⚠ a leave-arm never survives an attach", () => {
  const i = cdp.indexOf("function cdpAttach(");
  const fn = cdp.slice(i, i + 3000);
  assert.match(fn, /_dlgAcceptLeaveUntil\s*=\s*0/,
    "a stale arm would authorise discarding the NEXT run's filled form");
});

test("⚠⚠ the leave dialog is ARMED BEFORE the click, and disarmed after", () => {
  const i = bg.indexOf("async function icimsReturningCandidateSignIn(");
  assert.ok(i > 0, "the recovery stage must exist");
  const fn = bg.slice(i, bg.indexOf("\nasync function ", i + 10) + 1 || undefined);
  const armAt = fn.indexOf("cdpArmLeaveDialog");
  const clickAt = fn.indexOf("atsAimedClick");
  const disarmAt = fn.indexOf("cdpDisarmLeaveDialog");
  assert.ok(armAt > 0 && clickAt > armAt, "arming AFTER the click is too late — the dialog blocks the renderer");
  assert.ok(disarmAt > clickAt, "the arm must not still be standing when the fill resumes");
});

test("⚠ the recovery never re-implements the credential ladder", () => {
  const i = bg.indexOf("async function icimsReturningCandidateSignIn(");
  const fn = bg.slice(i, i + 6000);
  assert.match(fn, /await runIcimsPreForm\(/,
    "signing in must delegate to the ONE existing stage — a second copy of a ladder that types a password is the drift this repo has been bitten by");
  assert.ok(!/atsInjSetCredential/.test(fn),
    "the recovery must not write credentials itself");
});

test("⚠⚠ the walk routes account-exists to the sign-in, ONCE, and re-fills the same step", () => {
  assert.match(bg, /adv\.stopped === "account-exists"/, "the walk must act on the named refusal");
  assert.match(bg, /signInRecoveries < 1/, "bounded — the recovery re-enters the same step, so unbounded is a loop");
  assert.match(bg, /await icimsReturningCandidateSignIn\(/);
  // …and it must CONTINUE (re-fill), not count as an advance: signing in navigated the values away.
  const i = bg.indexOf('adv.stopped === "account-exists"');
  const near = bg.slice(i, i + 700);
  assert.match(near, /continue;/, "the same step must be filled again — its values are gone");
});

test("⚠⚠ the press diagnosis reads the form's OWN WORDS before claiming the click missed", () => {
  const i = bg.indexOf("async function icimsAdvanceAfterStep(");
  const fn = bg.slice(i, bg.indexOf("\nasync function ", i + 10));
  const errAt = fn.indexOf("atsInjErrors");
  const diagAt = fn.indexOf("press diagnosis");
  assert.ok(errAt > 0 && diagAt > errAt,
    "the error scrape must come FIRST — diagnosing from absence is what printed 'the press did not reach the control' "
    + "one line above the form's own rejection of that very press");
  assert.match(fn, /real\.length \?\s*"THE PRESS LANDED/,
    "validation text is positive proof the press landed, and must outrank the captcha read");
});
