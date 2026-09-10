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
  // ⚠ The bypass widened once evidence showed the SAME host serves both roles: Shure's candidate
  // login is login.icims.eu, RoviSys routes candidates to login.icims.com, and the documented staff
  // login is login.icims.com too. Provenance is the only discriminator, so the START host vouches
  // as well as the returning-candidate recovery. Both invariants below are unchanged:
  assert.match(fn, /icimsIsIcimsHost\(url\)/,
    "the bypass must still require the destination to be iCIMS' own infrastructure");
  assert.match(fn, /viaTenantLoginLink \|\| !startedOnStaffLogin/,
    "…and some provenance — the recovery's link, or having begun on the tenant's own posting");
  assert.match(fn, /!portalHost \|\| icimsIsAdminLogin/,
    "an UNKNOWN start host must vouch for nothing — the safe direction");
  assert.match(fn, /icimsIsAdminLogin\(url\) && !vouchedIcimsLogin/,
    "the staff-login refusal must still fire for a login.icims.* page reached any other way");
  // …and only the returning-candidate stage may claim that provenance.
  assert.strictEqual((bg.match(/viaTenantLoginLink: true/g) || []).length, 1,
    "exactly one caller may vouch for a login.icims.* destination");
});

test("⚠⚠ the STAFF login is .com ONLY — login.icims.eu is a CANDIDATE login", () => {
  // This was briefly widened to every TLD on the theory that reaching login.icims.eu meant we had
  // followed the wrong link. The operator refuted it, and the widening then broke an ORDINARY run:
  // Shure job 4960 halted `wrong-login` on a redirect the tenant's own flow had made, because the
  // provenance bypass only covers the returning-candidate recovery. Asymmetric on evidence beats
  // symmetric on a guess.
  assert.ok(icimsIsAdminLogin("https://login.icims.com/sso"), "the documented RECRUITER login stays refused");
  assert.ok(!icimsIsAdminLogin("https://login.icims.eu/sso/login"), "this tenant's candidate login must not be refused");
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

// ── which control advances a step ────────────────────────────────────────────────────────────────

const { icimsAdvancePick } = require("../ats.js");
const ctl = (caption, extra) => ({ index: 0, caption, visible: true, disabled: false, rect: { cx: 5, cy: 5 }, ...(extra || {}) });

test("⚠⚠ Save Profile beats Submit Profile — the one the operator proved by hand", () => {
  // Live 2026-09-09: signed in, the step carries both. Pressing "Submit Profile" saves and stays put
  // ("Your responses have been saved."); the operator clicked "Save Profile" and it moved on.
  // atsInjSubmitState took whichever came FIRST IN DOCUMENT ORDER, which is not a choice at all.
  const r = icimsAdvancePick([ctl("Submit Profile", { index: 0 }), ctl("Save Profile", { index: 1 })]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.control.caption, "Save Profile");
});

test("Update Profile also beats Submit Profile, and order does not matter", () => {
  const a = icimsAdvancePick([ctl("Update Profile", { index: 0 }), ctl("Submit Profile", { index: 1 })]);
  assert.strictEqual(a.control.caption, "Update Profile");
  const b = icimsAdvancePick([ctl("Submit Profile", { index: 0 }), ctl("Update Profile", { index: 1 })]);
  assert.strictEqual(b.control.caption, "Update Profile");
});

test("Submit Profile alone is still taken — the historical behaviour is the fallback", () => {
  const r = icimsAdvancePick([ctl("Submit Profile")]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.control.caption, "Submit Profile");
});

test("⚠⚠ two controls at the SAME tier refuse — one of them could be the application's Submit", () => {
  const r = icimsAdvancePick([ctl("Save Profile", { index: 0 }), ctl("Update Profile", { index: 1 })]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "ambiguous");
  assert.deepStrictEqual(r.offered, ["Save Profile", "Update Profile"]);
});

test("⚠ a hidden, disabled or unmeasurable control is never the advance", () => {
  assert.strictEqual(icimsAdvancePick([ctl("Save Profile", { visible: false })]).ok, false);
  assert.strictEqual(icimsAdvancePick([ctl("Save Profile", { disabled: true })]).ok, false);
  assert.strictEqual(icimsAdvancePick([ctl("Save Profile", { rect: null })]).ok, false);
  // …and a disabled preferred one does not shadow a usable fallback
  const r = icimsAdvancePick([ctl("Save Profile", { index: 0, disabled: true }), ctl("Submit Profile", { index: 1 })]);
  assert.strictEqual(r.control.caption, "Submit Profile");
});

test("⚠⚠ the EEO step: 'Submit' advances, 'Finish Later' must never be pressed", () => {
  // Measured live 2026-09-09 on step 2 of 3: input#eeop_form_save_i "Finish Later" sits right next
  // to input#eeop_form_submit_i "Submit". Finish Later is the more dangerous of the two — it does not
  // fail loudly, it SAVES AND LEAVES THE FLOW, so the walk would report a successful press and the
  // remaining steps would silently never be filled.
  const r = icimsAdvancePick([
    ctl("Finish Later", { index: 0, id: "eeop_form_save_i" }),
    ctl("Submit", { index: 1, id: "eeop_form_submit_i" }),
  ]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.control.caption, "Submit");
  assert.strictEqual(r.control.id, "eeop_form_submit_i");
});

test("⚠ a step offering ONLY a leave-the-flow control advances nowhere", () => {
  // Better to refuse than to press the one control that abandons the application.
  const r = icimsAdvancePick([ctl("Finish Later")]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "none");
});

test("⚠ backwards and destructive wordings are refused too", () => {
  for (const cap of ["Cancel", "Go Back", "Previous", "Delete", "Withdraw", "Log Out", "Complete Later"]) {
    assert.strictEqual(icimsAdvancePick([ctl(cap)]).ok, false, cap + " must never advance a step");
  }
});

test("no controls at all is reported, not thrown", () => {
  assert.strictEqual(icimsAdvancePick([]).ok, false);
  assert.strictEqual(icimsAdvancePick(undefined).reason, "none");
});

// ── the scratch alias: fill under +1, submit under the real address ─────────────────────────────

const { icimsScratchEmail, icimsUnscratchEmail, atsUnscratchRecords } = require("../ats.js");

test("⚠ the fill alias is +1, and it NEVER stacks on an address that already has one", () => {
  assert.strictEqual(icimsScratchEmail("wangykev@gmail.com"), "wangykev+1@gmail.com");
  // ⚠ The one that would break Gmail auto-verify: an operator whose own address already carries a
  // tag must not become `name+foo+1@`, which is a mailbox nothing polls — the run would then sit
  // waiting for a verification mail that never arrives.
  assert.strictEqual(icimsScratchEmail("wangykev+foo@gmail.com"), "wangykev+foo@gmail.com");
  assert.strictEqual(icimsScratchEmail("wangykev+1@gmail.com"), "wangykev+1@gmail.com");
  // junk in, junk out — never a malformed address
  assert.strictEqual(icimsScratchEmail(""), "");
  assert.strictEqual(icimsScratchEmail(null), "");
  assert.strictEqual(icimsScratchEmail("not-an-address"), "not-an-address");
  assert.strictEqual(icimsScratchEmail("@nolocal.com"), "@nolocal.com");
});

test("the inverse restores the real address", () => {
  assert.strictEqual(icimsUnscratchEmail("wangykev+1@gmail.com"), "wangykev@gmail.com");
  assert.strictEqual(icimsUnscratchEmail("wangykev@gmail.com"), "wangykev@gmail.com");
});

test("⚠⚠ every recorded value is un-aliased before it can become a bundle", () => {
  // The operator must review the address the submission will actually use. Approving `+1` would be
  // approving a value that never gets filed.
  const recs = [
    { name: "PersonProfileFields.Email", after: "wangykev+1@gmail.com" },
    { name: "other", after: "unrelated", resolved: "wangykev+1@gmail.com" },
    { name: "PersonProfileFields.Login", after: "(stored login)" },
  ];
  const n = atsUnscratchRecords(recs, "wangykev+1@gmail.com", "wangykev@gmail.com");
  assert.strictEqual(n, 2);
  assert.strictEqual(recs[0].after, "wangykev@gmail.com");
  assert.strictEqual(recs[1].resolved, "wangykev@gmail.com");
  // ⚠ the credential record is a PLACEHOLDER and must stay one — that is what keeps the aliased
  // login out of Supabase entirely
  assert.strictEqual(recs[2].after, "(stored login)");
});

test("⚠ un-aliasing is a no-op when no alias was used", () => {
  const recs = [{ after: "wangykev@gmail.com" }];
  assert.strictEqual(atsUnscratchRecords(recs, "wangykev@gmail.com", "wangykev@gmail.com"), 0);
  assert.strictEqual(atsUnscratchRecords(recs, null, "x"), 0);
  assert.strictEqual(atsUnscratchRecords(null, "a", "b"), 0);
  assert.strictEqual(recs[0].after, "wangykev@gmail.com");
});

test("⚠⚠ only the ARMED submit uses the real address — a rehearsal takes its own throwaway", () => {
  // ⚠ THIS INVARIANT CHANGED ON 2026-09-10 (operator): "if you reherse, log out do +2 or +3 or
  // something like that, only on the final submit run, use the non plus version." The old test said
  // the submit run never aliases, which was true only while a rehearsal was a dry run. It is not —
  // it walks and writes for real and only withholds the final press, so it burns a candidate
  // account exactly as the fill does. Reusing `+1` meets that candidate's completed application;
  // reusing the REAL address burns the identity the armed run needs.
  const i = bg.indexOf("async function runAtsSubmitRun(");
  const fn = bg.slice(i);
  assert.match(fn, /if \(!arm && submitCreds && submitCreds\.email\)/,
    "the alias must be gated on NOT being armed");
  assert.match(fn, /icimsRehearsalTag/, "…and each rehearsal takes a FRESH tag, counted in storage");
  assert.match(fn, /Math\.max\(2,/, "…starting at +2, so it never collides with the fill's +1");
  // the armed path must reach runIcimsPreForm with the credentials untouched
  const armAt = fn.indexOf("} else if (arm) {");
  assert.ok(armAt > 0, "the armed branch must be explicit rather than implied");
});

test("⚠⚠ a rehearsal re-aliases the CONTACT email in the bundle too", () => {
  // iCIMS keys the candidate ACCOUNT on the PROFILE address, not the login. The bundle deliberately
  // carries the real one (atsUnscratchRecords put it back so the operator approved what would
  // actually be filed), so a rehearsal replaying it verbatim would create the account under the
  // real address and burn the identity the armed submit needs.
  const i = bg.indexOf("async function runAtsSubmitRun(");
  const fn = bg.slice(i);
  assert.match(fn, /e\.current_value\.indexOf\(realAddr\)/,
    "the approved contact email must be swapped for the rehearsal's alias");
});

test("⚠⚠ the rehearsal's throwaway reaches the REPLAY, not only the sign-in gate", () => {
  // The nastiest bug of this sequence, and it had a real consequence. The credential tier
  // deliberately re-reads storage rather than taking a value from the bundle (the bundle holds only
  // a "(stored login)" placeholder, and typing THAT into a login box is the failure that rule
  // exists to prevent). So a rehearsal signed in at the gate as a throwaway and then filled step
  // 1's "Create a login" block with the REAL address out of storage — creating, under the real
  // identity, the very account the armed submit needed. The next rehearsal was refused
  // "The given login name is already in use."
  const i = bg.indexOf("async function runAtsSubmitRun(");
  const fn = bg.slice(i);
  assert.match(fn, /credentials: \(ats === "icims" && icimsSubmitCreds\)/,
    "the replay must use THIS run's credentials, not whatever storage holds");
  assert.match(fn, /icimsSubmitCreds = submitCreds/,
    "…and the throwaway must be published to that variable when one is taken");
});

test("⚠⚠ an iCIMS submit signs OUT first — a shared cookie serves the previous candidate", () => {
  const i = bg.indexOf("async function runAtsSubmitRun(");
  const fn = bg.slice(i);
  assert.match(fn, /if \(ats === "icims"\) await icimsSignOut\(/);
  // ⚠ slice to the next function, NOT to a comment marker — `bg` is comment-stripped, so a `//`
  // anchor is never found and the slice silently becomes empty (which passes some asserts and
  // fails others for the wrong reason).
  const so = bg.indexOf("async function icimsSignOut(");
  const sofn = bg.slice(so, bg.indexOf("\nasync function ", so + 10));
  assert.match(sofn, /Storage\.clearDataForOrigin/, "the session is dropped at the source, not navigated around");
  // ⚠ READ THE RAW FILE FOR THE HOST LIST. The comment stripper is line-based and cuts at the first
  // `//`, which inside `"https://login.icims.com"` is the URL's own separator — so the stripped copy
  // loses the rest of that line and this assertion fails against code that is perfectly correct.
  // Worth recording: every source-text guard in this repo shares that stripper.
  const bgRaw = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  const soRaw = bgRaw.indexOf("async function icimsSignOut(");
  const sofnRaw = bgRaw.slice(soRaw, bgRaw.indexOf("\nasync function ", soRaw + 10));
  assert.match(sofnRaw, /login\.icims\.com/, "…including the Auth0 host, or it silently re-authenticates");
});

test("⚠⚠ the SUBMIT run walks iCIMS' steps — the fill knowing and the submit not is the worst split", () => {
  const i = bg.indexOf("async function runAtsSubmitRun(");
  const fn = bg.slice(i);
  assert.match(fn, /ats === "oracle" \|\| ats === "icims"/, "iCIMS must enter the multi-step replay");
  assert.match(fn, /await icimsAdvanceAfterStep\(stepNo,/,
    "…and press through ITS OWN guards: ORC's guard 2 is caption-based and cannot work where one control is both Next and Submit");
  assert.match(fn, /if \(ats !== "icims"\) await orcAwaitBlocksPopulated/,
    "ORC's block settle would poll for something iCIMS never sends");
});

test("⚠⚠ the alias is decided BEFORE the gate, and undone BEFORE the bundle", () => {
  const i = bg.indexOf("async function runAtsApplicationRun(");
  const fn = bg.slice(i, bg.indexOf("async function runAtsSubmitRun("));
  const gateAt = fn.indexOf("runIcimsPreForm(tabId, preCredsIcims");
  const decideAt = fn.indexOf("icimsScratchEmail");
  const fillAt = fn.indexOf("driveAtsPageFill");
  const undoAt = fn.indexOf("atsUnscratchRecords");
  assert.ok(decideAt > 0 && gateAt > decideAt,
    "the gate types the account email — deciding the alias after it would sign into the REAL account");
  assert.ok(undoAt > fillAt, "records are un-aliased immediately after the fill, per step");
  // and the login is aliased too, or the scratch account cannot be created at all
  assert.match(fn, /email: icimsScratchEmail\(store\.credentials\.email\)/,
    "a +1 contact address with the REAL login just moves the collision to the login field");
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

test("⚠⚠ a resumed iCIMS walk carries earlier steps forward, and ONLY for the same job", () => {
  // iCIMS saves each step and restarts a returning candidate at the first INCOMPLETE one, so
  // successive runs start further along (measured 1-of-3, then 2-of-3, then 3-of-3) and the
  // clear-at-start wiped the steps the walk no longer walks — the bundle shrank 19 fields -> 8 -> 6.
  // The step indicators are not navigable, so they cannot be re-collected; they are carried instead.
  const i = bg.indexOf("let signInRecoveries = 0;");
  const fn = bg.slice(i, i + 2600);
  // ⚠ MATCHES THE COMPARISON, NOT THE VARIABLE NAME. This was `prior\.jobKeyUrl === originUrl` and
  // broke the moment the gate was factored into a `mine()` helper — the guard was still there and
  // still applied to BOTH the local and the pulled bundle, so a literal pattern would have forced a
  // real improvement to be reverted to satisfy a test about something else. (Same lesson as
  // `icimsStepState\(\)` in test/icims-walk-guards.js.)
  assert.match(fn, /jobKeyUrl === originUrl/,
    "carrying forward must be gated on the JOB — merging another application's bundle would put its answers on this review page");
  // …and the website is consulted for the earlier steps, since local storage holds only the last run
  assert.match(fn, /pullApprovedBundle\(LOG, \{ url: originUrl \}\)/,
    "the durable copy of an earlier step lives on the site, not in chrome.storage");
  assert.match(fn, /ats === "icims"/, "only iCIMS resumes mid-application; every other walk still clears");
  // the clear must still happen when nothing is carried
  assert.match(fn, /reviewSummary: null, reviewAudit: null/,
    "a walk with nothing to carry still clears once, outside the loop");
  const carryAt = fn.indexOf("accEntries = carried.entries");
  const clearAt = fn.indexOf("reviewSummary: null");
  assert.ok(carryAt > 0 && clearAt > carryAt, "the clear is the ELSE branch — never both");
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

// ── Auth0's passkey enrolment offer is DECLINED, never accepted (live 2026-09-10, RoviSys) ──────

const { atsEnrolmentDecline } = require("../ats.js");
const btn = (caption) => ({ caption, visible: true, disabled: false });

test("⚠⚠ the live enrolment screen is declined, and 'Continue' is never the answer", () => {
  // Measured: heading "Log In Faster on This Device", buttons Continue | Remind me later |
  // Not on this device. Continue REGISTERS A PASSKEY on the operator's device.
  const page = { ok: true, headings: ["Log In Faster on This Device"],
    controls: [btn("Continue"), btn("Remind me later"), btn("Not on this device")] };
  assert.strictEqual(atsEnrolmentDecline(page), "Remind me later");
});

test("⚠ several declines is a PREFERENCE, not an ambiguity — each one is safe", () => {
  // Deliberately unlike the advance-control picker, which refuses on two matches because one of
  // them could be the application's Submit. Here every candidate declines, so there is no hazard.
  const page = { ok: true, headings: ["Add a passkey"], controls: [btn("Continue"), btn("Not now"), btn("Skip")] };
  assert.strictEqual(atsEnrolmentDecline(page), "Not now");
});

test("⚠⚠ an enrolment screen with NO decline returns null — a human's problem, not a guess", () => {
  const page = { ok: true, headings: ["Log In Faster on This Device"], controls: [btn("Continue")] };
  assert.strictEqual(atsEnrolmentDecline(page), null, "never fall back to the enrolling button");
});

test("⚠ an ordinary page is not mistaken for an enrolment offer", () => {
  // A "Continue" button alone must not trigger this — most pages have one.
  assert.strictEqual(atsEnrolmentDecline({ ok: true, headings: ["Candidate Profile"], controls: [btn("Continue"), btn("Skip")] }), null);
  assert.strictEqual(atsEnrolmentDecline({ ok: true, headings: [], controls: [btn("Not now")] }), null);
  assert.strictEqual(atsEnrolmentDecline({ ok: false }), null);
  assert.strictEqual(atsEnrolmentDecline(null), null);
});

test("⚠ a hidden or disabled decline is not pressable", () => {
  const page = { ok: true, headings: ["Log In Faster on This Device"],
    controls: [btn("Continue"), { caption: "Remind me later", visible: false, disabled: false }] };
  assert.strictEqual(atsEnrolmentDecline(page), null);
});

// ── a consent interstitial with nothing to tick is pressed through (live 2026-09-10, RoviSys) ───

const { atsConsentGateNext } = require("../ats.js");

test("⚠ the live GDPR interstitial is pressed through with its own Next", () => {
  // careers-rovisys.icims.com/jobs/gdpr?jobid=2142 — a notice with NO inputs and two buttons.
  // Until today we only got past it as a side effect of ticking its EU-resident box; refusing that
  // box (correctly) removed the accident that was carrying the run forward.
  const page = { ok: true, headings: ["General Data Protection Regulation (GDPR)"],
    forms: [{ id: "gdprConsentForm", action: "", method: "post" }],
    controls: [btn("Next"), btn("Keep me logged in")] };
  assert.strictEqual(atsConsentGateNext(page), "Next");
});

test("⚠⚠ a page with ANYTHING to fill is never pressed through — that is the safety gate", () => {
  // A page with no inputs cannot be an application form, which is the whole licence for pressing an
  // unknown button. One input and that argument is gone.
  const page = { ok: true, headings: ["General Data Protection Regulation (GDPR)"],
    forms: [{ id: "gdprConsentForm", action: "", method: "post" }],
    controls: [btn("Next"), { caption: null, visible: true, disabled: false, holdsSomething: false }] };
  assert.strictEqual(atsConsentGateNext(page), null);
});

test("⚠ 'Keep me logged in' is never mistaken for the forward control", () => {
  const page = { ok: true, headings: ["General Data Protection Regulation (GDPR)"],
    forms: [{ id: "gdprConsentForm", action: "", method: "post" }],
    controls: [btn("Keep me logged in")] };
  assert.strictEqual(atsConsentGateNext(page), null, "no whitelisted forward caption ⇒ stop for a human");
});

test("⚠ an ordinary page is not pressed through", () => {
  assert.strictEqual(atsConsentGateNext({ ok: true, headings: ["Candidate Profile"], forms: [], controls: [btn("Next")] }), null);
  assert.strictEqual(atsConsentGateNext({ ok: false }), null);
  assert.strictEqual(atsConsentGateNext(null), null);
});

// ── a CONDITIONAL box is a factual claim, not a consent (live 2026-09-10, RoviSys) ───────────────

const { atsConsentKind: consentKind, atsConsentPlan } = require("../ats.js");

test("⚠⚠ 'If you are a European Union resident, please check this box' is NOT an acceptance", () => {
  // It carries GDPR wording, so the accept matcher claimed it and the run TICKED it — asserting the
  // operator lives in the EU, which is false, and plausibly disabling the gate's own Next control.
  // Same boundary the attestation exclusion draws, reached from the other side: the standing
  // instruction authorised accepting a privacy notice, and cannot authorise a statement of fact.
  const t = "If you are a European Union resident, please check this box";
  assert.strictEqual(consentKind(t), "conditional");
  const plan = atsConsentPlan([{ id: "accept_gdpr", label: t, checked: false }]);
  assert.strictEqual(plan.tick.length, 0, "nothing conditional may be ticked");
  assert.strictEqual(plan.left[0].kind, "conditional");
});

test("⚠ an ordinary privacy acceptance is UNCHANGED — the narrowing must not swallow it", () => {
  for (const t of [
    "I accept the Privacy Policy",
    "I accept the Peraton Job Application Privacy Notice",
    "I have read and agree to the General Data Protection Regulation (GDPR) notice",
  ]) {
    assert.strictEqual(consentKind(t), "accept", t + " must still be accepted");
  }
  assert.strictEqual(consentKind("Check this box only if you reside in California"), "conditional");
  assert.strictEqual(consentKind("If you are a citizen of the EEA, tick here"), "conditional");
});
