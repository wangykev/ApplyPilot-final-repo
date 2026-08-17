// test/ats-icims.test.js — the iCIMS tenant and the credential tier.
//
// The credential tier is the reason most of this file exists. It is the only place in the codebase
// where a SECRET is typed into a page, and the failure modes are not hypothetical — every one of
// them below was observed on a live run against astrioncareers-astrion.icims.com before it was
// pinned here:
//
//   • the value reaching a record, and from there the review bundle POSTed to Supabase;
//   • a rewrite MERGING with a prepopulated value ("old@x.comnew@y.com");
//   • the browser's own password manager writing the box back after the fill, while the run still
//     reported `filled` — written, verified, reverted, still claimed. The false-verify class.
//
// Run: node --test test/ats-icims.test.js

const test = require("node:test");
const assert = require("node:assert");
const ats = require("../ats.js");

const CREDS = { email: "wangykev+icims@gmail.com", password: "Xq7!zPlum-42-secret" };

const PROFILE = {
  personal_info: {
    first_name: "Kevin", last_name: "Wang", middle_name: "",
    email: "kevin@example.com", phone_number: "+1 555 0100",
  },
};

// Shaped exactly like atsInjScan's iCIMS branch output (see ats.js).
const ICIMS_SCAN = {
  ats: "icims",
  url: "https://astrioncareers-astrion.icims.com/jobs/24615/engineering-directorate-support-intern/candidate",
  title: "Astrion - Careers Candidate Profile Information",
  fields: [
    { fieldName: "PersonProfileFields.Login", inputSel: "#PersonProfileFields\\.Login", widgetType: "text",
      inputType: "text", autocomplete: "username", label: "Login", isRequired: false, value: null, section: "Create a login", domIndex: 0 },
    { fieldName: "PersonProfileFields.Password", inputSel: "#PersonProfileFields\\.Password", widgetType: "text",
      inputType: "password", autocomplete: "new-password", label: "Password", isRequired: false, value: null, section: "Create a login", domIndex: 1 },
    { fieldName: "PersonProfileFields.Password_Confirm", inputSel: "#PersonProfileFields\\.Password_Confirm", widgetType: "text",
      inputType: "password", autocomplete: "new-password", label: "Password (Re-enter)", isRequired: false, value: null, section: "Create a login", domIndex: 2 },
    { fieldName: "PersonProfileFields.FirstName", inputSel: "#PersonProfileFields\\.FirstName", widgetType: "text",
      inputType: "text", label: "Legal First Name", isRequired: true, value: null, section: "Enter your information", domIndex: 3 },
  ],
};

// A fake page that behaves like a real text box: writes land, reads come back.
// `writes` records the ORDER of every value written per selector — that is how the
// clear-before-typing rule is pinned.
function icimsPage(over) {
  const box = {};        // selector → current value
  const writes = {};     // selector → [every value written, in order]
  const page = {
    atsInjScan: () => ICIMS_SCAN,
    atsInjScrollIntoView: () => ({ ok: true }),
    atsInjSetText: (sel, v) => { (writes[sel] = writes[sel] || []).push(v); box[sel] = v; return { ok: true, after: v }; },
    atsInjSetCredential: (sel, v) => {
      const had = (box[sel] || "").length;
      (writes[sel] = writes[sel] || []).push("");   // the clear
      (writes[sel] = writes[sel] || []).push(v);    // then the value
      box[sel] = v;
      return { ok: true, hadLength: had, len: v.length, matches: true };
    },
    atsInjVerifyCredential: (sel, v) => ({ ok: true, len: (box[sel] || "").length, empty: !box[sel], matches: box[sel] === v }),
    atsInjReadValue: (a, sel) => ({ ok: true, value: box[sel] != null ? box[sel] : null }),
    _box: box, _writes: writes,
  };
  return Object.assign(page, over || {});
}

function fakeAct(page) {
  return {
    aiEnabled: !!page.aiEnabled,
    llm: page.llm || (async () => ({ ok: false, error: "no-llm" })),
    delay: async () => {}, delayFull: async () => {},
    attachResume: page.attachResume || (async () => ({ ok: true, name: "resume.pdf", verified: true })),
    eval: async (fn, ...args) => {
      const h = page[fn.name];
      if (!h) throw new Error("fake page has no handler for " + fn.name);
      return h(...args);
    },
  };
}

// ── routing ─────────────────────────────────────────────────────────────────────────────

test("detectAts: iCIMS is a SUFFIX test, and it is anchored", () => {
  assert.strictEqual(ats.detectAts("https://astrioncareers-astrion.icims.com/jobs/24615/x/candidate"), "icims");
  assert.strictEqual(ats.detectAts("https://careers-acme.icims.com/jobs/1/apply"), "icims");
  assert.strictEqual(ats.detectAts("https://icims.com/jobs/1"), "icims");
  // the anchoring — the same discipline the exact-host tenants get
  assert.strictEqual(ats.detectAts("https://icims.com.evil.com/jobs/1"), null);
  assert.strictEqual(ats.detectAts("https://fakeicims.com/jobs/1"), null);
  assert.strictEqual(ats.detectAts("https://noticims.com/jobs/1"), null);
});

test("atsFormUrl: the iCIMS magic-link query SURVIVES (stripping it loses the session)", () => {
  const u = "https://astrioncareers-astrion.icims.com/jobs/24615/x/candidate?from=login&eem=TOKEN&code=ABC";
  assert.strictEqual(ats.atsFormUrl("icims", u), u);
});

test("atsCompanyFromUrl: iCIMS reads the SUBDOMAIN — path segment 0 is the literal 'jobs'", () => {
  assert.strictEqual(ats.atsCompanyFromUrl("https://astrioncareers-astrion.icims.com/jobs/24615/x/candidate"), "Astrion");
  assert.strictEqual(ats.atsCompanyFromUrl("https://careers-acme.icims.com/jobs/1"), "Acme");
  // NOT "Jobs" — that would be handed to the safety-critical employment recognizer as the anchor
  assert.notStrictEqual(ats.atsCompanyFromUrl("https://astrioncareers-astrion.icims.com/jobs/24615/x"), "Jobs");
});

// ── credential recognition ──────────────────────────────────────────────────────────────

test("atsCredentialKind: the mapped iCIMS platform ids", () => {
  const k = (fieldName, extra) => ats.atsCredentialKind("icims", Object.assign({ fieldName }, extra || {}));
  assert.strictEqual(k("PersonProfileFields.Login"), "login");
  assert.strictEqual(k("PersonProfileFields.Password"), "password");
  assert.strictEqual(k("PersonProfileFields.Password_Confirm"), "password_confirm");
  assert.strictEqual(k("PersonProfileFields.FirstName"), null);
  assert.strictEqual(k("PersonProfileFields.Email"), null, "the contact email is NOT the account login");
});

test("atsCredentialKind: an UNMAPPED password box is still claimed — that is the safety net", () => {
  // A password field the map does not know must never fall through to the AI rescue as an
  // ordinary required text field. type=password alone is enough to claim it.
  const f = { fieldName: "rcf9999", label: "Choose a password", inputType: "password" };
  assert.strictEqual(ats.atsCredentialKind("icims", f), "password");
  const c = { fieldName: "rcf9998", label: "Re-enter password", inputType: "password" };
  assert.strictEqual(ats.atsCredentialKind("icims", c), "password_confirm");
  const c2 = { fieldName: "x", label: "Confirm Password", inputType: "password" };
  assert.strictEqual(ats.atsCredentialKind("icims", c2), "password_confirm");
});

test("atsCredentialKind: claiming a LOGIN needs TWO agreeing signals", () => {
  // one signal is not enough — a false positive here overwrites an ordinary answer with an account name
  assert.strictEqual(ats.atsCredentialKind("icims", { fieldName: "x", label: "Login", inputType: "text" }), null);
  assert.strictEqual(ats.atsCredentialKind("icims", { fieldName: "x", label: "Email", autocomplete: "username", inputType: "text" }), null);
  // both → claimed
  assert.strictEqual(ats.atsCredentialKind("icims", { fieldName: "x", label: "Login", autocomplete: "username", inputType: "text" }), "login");
});

test("atsCredentialKind: the other tenants are untouched (they have no password fields)", () => {
  assert.strictEqual(ats.atsCredentialKind("greenhouse", { fieldName: "first_name", label: "First Name" }), null);
  assert.strictEqual(ats.atsCredentialKind("lever", { fieldName: "name", label: "Full name" }), null);
});

// ── the tier inside the router ──────────────────────────────────────────────────────────

test("routeField: the credential tier supplies the STORED values, not profile ones", () => {
  const login = ats.atsRouteField("icims", ICIMS_SCAN.fields[0], PROFILE, {}, {}, new Map(), CREDS);
  assert.strictEqual(login.kind, "credential");
  assert.strictEqual(login.credentialKind, "login");
  assert.strictEqual(login.value, CREDS.email);
  assert.notStrictEqual(login.value, PROFILE.personal_info.email, "the login is the CREDENTIAL email, not the profile's");
  assert.strictEqual(login.overwrite, true);

  const pw = ats.atsRouteField("icims", ICIMS_SCAN.fields[1], PROFILE, {}, {}, new Map(), CREDS);
  assert.strictEqual(pw.value, CREDS.password);
  const pwc = ats.atsRouteField("icims", ICIMS_SCAN.fields[2], PROFILE, {}, {}, new Map(), CREDS);
  assert.strictEqual(pwc.value, CREDS.password, "the re-enter box gets the SAME password");
});

test("routeField: NO stored credentials ⇒ needs_review, never a blank guess", () => {
  for (const creds of [null, {}, { email: "a@b.c" }, { password: "x" }]) {
    const r = ats.atsRouteField("icims", ICIMS_SCAN.fields[0], PROFILE, {}, {}, new Map(), creds);
    assert.strictEqual(r.kind, "credential-missing", "incomplete credentials must not half-make an account");
    assert.strictEqual(r.flag, "credentials-not-stored");
    assert.strictEqual(r.review, true);
  }
});

test("routeField: the credential tier OUTRANKS a bucket that would claim the same label", () => {
  // a taught bucket for "Login" must never be able to answer an account credential
  const bucket = new Map([["login", { value: ["some-taught-answer"] }]]);
  const r = ats.atsRouteField("icims", ICIMS_SCAN.fields[0], PROFILE, {}, {}, bucket, CREDS);
  assert.strictEqual(r.source, "credentials");
  assert.strictEqual(r.value, CREDS.email);
});

// ── the driver, end to end ──────────────────────────────────────────────────────────────

test("driver: the Create-a-login trio fills DETERMINISTICALLY from stored credentials", async () => {
  const page = icimsPage();
  const out = await ats.driveAtsPageFill(fakeAct(page), "icims", PROFILE, {}, {}, { credentials: CREDS });
  const by = Object.fromEntries(out.results.map((r) => [r.fieldName, r]));

  assert.strictEqual(by["PersonProfileFields.Login"].status, "filled");
  assert.strictEqual(by["PersonProfileFields.Password"].status, "filled");
  assert.strictEqual(by["PersonProfileFields.Password_Confirm"].status, "filled");
  // deterministic means: no review flag, no AI, verified
  for (const n of ["PersonProfileFields.Login", "PersonProfileFields.Password", "PersonProfileFields.Password_Confirm"]) {
    assert.strictEqual(by[n].verified, true, n + " must be read-back verified");
    assert.strictEqual(by[n].flag, null, n + " must carry no flag — it is a stored value, not a guess");
    assert.strictEqual(by[n].credential, true);
  }
  assert.strictEqual(by["PersonProfileFields.Login"].credentialKind, "login");
  // the values really did reach the page
  assert.strictEqual(page._box["#PersonProfileFields\\.Login"], CREDS.email);
  assert.strictEqual(page._box["#PersonProfileFields\\.Password"], CREDS.password);
});

// ⚠ THE LOAD-BEARING TEST. `buildReviewBundle` copies `rec.after` into BOTH `current_value` and
// `original_ai_value`, background.js persists that to chrome.storage AND POSTs it to the website,
// where web/lib/report-fields.ts stores it verbatim in applications.review_bundle_json. There is no
// redaction anywhere on that path — so the value must never enter a record in the first place.
test("driver: NEITHER credential appears ANYWHERE in the results — the bundle is what leaves", async () => {
  const out = await ats.driveAtsPageFill(fakeAct(icimsPage()), "icims", PROFILE, {}, {}, { credentials: CREDS });
  const blob = JSON.stringify(out.results);
  assert.ok(!blob.includes(CREDS.password), "THE PASSWORD LEAKED INTO A RECORD — it would reach Supabase");
  assert.ok(!blob.includes(CREDS.email), "the stored login leaked into a record");
  // what IS carried: a placeholder naming which credential was used
  const by = Object.fromEntries(out.results.map((r) => [r.fieldName, r]));
  assert.strictEqual(by["PersonProfileFields.Password"].after, "(stored password)");
  assert.strictEqual(by["PersonProfileFields.Login"].after, "(stored login)");
  // and the fields that carry values elsewhere are untouched by all this
  assert.ok(blob.includes("Kevin"), "ordinary fields still record their value");
});

test("driver: a credential box is CLEARED before it is typed (a rewrite must not merge)", async () => {
  const page = icimsPage();
  // iCIMS renders the session's own login into the box — the normal case, not an edge one
  page._box["#PersonProfileFields\\.Login"] = "someone.else@old-account.com";
  const out = await ats.driveAtsPageFill(fakeAct(page), "icims", PROFILE, {}, {}, { credentials: CREDS });
  assert.deepStrictEqual(page._writes["#PersonProfileFields\\.Login"], ["", CREDS.email],
    "the write order must be clear-then-value, or a prefilled box produces 'old@x.comnew@y.com'");
  assert.strictEqual(page._box["#PersonProfileFields\\.Login"], CREDS.email, "the prefilled value must be REPLACED");
  const rec = out.results.find((r) => r.fieldName === "PersonProfileFields.Login");
  assert.strictEqual(rec.status, "filled");
  assert.match(rec.detail, /prefilled/, "review should say the page's own value was replaced");
});

test("driver: no stored credentials ⇒ reported to review, and NOTHING is typed", async () => {
  const page = icimsPage();
  const out = await ats.driveAtsPageFill(fakeAct(page), "icims", PROFILE, {}, {}, { credentials: null });
  const by = Object.fromEntries(out.results.map((r) => [r.fieldName, r]));
  for (const n of ["PersonProfileFields.Login", "PersonProfileFields.Password", "PersonProfileFields.Password_Confirm"]) {
    assert.strictEqual(by[n].status, "needs_review");
    assert.strictEqual(by[n].flag, "credentials-not-stored");
    assert.match(by[n].detail, /Credentials page/);
  }
  assert.strictEqual(page._writes["#PersonProfileFields\\.Login"], undefined, "nothing may be typed without credentials");
});

// ⚠ THE FALSE-VERIFY CLASS. Observed live: the login box held a DIFFERENT address with an empty
// password on a run whose log said both were filled and the read-back passed. `autocomplete="username"`
// invites Chrome's own password manager to write the box after the page settles.
test("driver: a credential the page TAKES BACK ends needs_review, never a silent 'filled'", async () => {
  const page = icimsPage();
  // the box accepts the write, then something else reverts it — every time
  page.atsInjSetCredential = (sel, v) => {
    (page._writes[sel] = page._writes[sel] || []).push("", v);
    page._box[sel] = sel.includes("Login") ? "kevinw4@andrew.cmu.edu" : v; // the manager's value wins
    return { ok: true, hadLength: 0, len: v.length, matches: sel.includes("Login") ? false : true };
  };
  const out = await ats.driveAtsPageFill(fakeAct(page), "icims", PROFILE, {}, {}, { credentials: CREDS });
  const rec = out.results.find((r) => r.fieldName === "PersonProfileFields.Login");
  assert.strictEqual(rec.status, "needs_review", "a login we could not keep on the page is NOT filled");
  assert.strictEqual(rec.verified, false);
  assert.strictEqual(rec.after, null, "the placeholder must be cleared — we are not claiming this one");
  // and the value the page substituted must not be recorded either
  assert.ok(!JSON.stringify(out.results).includes("kevinw4@andrew.cmu.edu"));
});

test("driver: the re-check REPAIRS a credential the page replaced after the fill", async () => {
  const page = icimsPage();
  let reverted = false;
  const realSet = page.atsInjSetCredential;
  page.atsInjSetCredential = (sel, v) => {
    const r = realSet(sel, v);
    if (sel.includes("Login") && !reverted) { reverted = true; page._box[sel] = "autofilled@elsewhere.com"; }
    return r;
  };
  const out = await ats.driveAtsPageFill(fakeAct(page), "icims", PROFILE, {}, {}, { credentials: CREDS });
  const rec = out.results.find((r) => r.fieldName === "PersonProfileFields.Login");
  assert.strictEqual(rec.status, "filled", "the re-check rewrote it and it stuck");
  assert.match(rec.detail, /replaced this after the fill/);
  assert.strictEqual(page._box["#PersonProfileFields\\.Login"], CREDS.email);
});

test("driver: a credential is NEVER handed to the AI, even required with AI enabled", async () => {
  let asked = 0;
  const page = icimsPage({
    aiEnabled: true,
    llm: async () => { asked++; return { ok: true, text: JSON.stringify({ answers: [{ id: "1", choice: "guessed" }] }) }; },
  });
  // make every credential field REQUIRED — the one condition that opens the AI rescue
  page.atsInjScan = () => ({ ...ICIMS_SCAN, fields: ICIMS_SCAN.fields.map((f) => ({ ...f, isRequired: true })) });
  const out = await ats.driveAtsPageFill(fakeAct(page), "icims", PROFILE, {}, {}, { credentials: null });
  const by = Object.fromEntries(out.results.map((r) => [r.fieldName, r]));
  for (const n of ["PersonProfileFields.Login", "PersonProfileFields.Password", "PersonProfileFields.Password_Confirm"]) {
    assert.strictEqual(by[n].status, "needs_review");
    assert.strictEqual(by[n].flag, "credentials-not-stored", "an unanswerable credential goes to the human, not the LLM");
    assert.ok(!/^ai-/.test(String(by[n].flag)));
  }
  assert.strictEqual(asked, 0, "no LLM call may be made for a credential field");
});

// ── the replay / submit path ────────────────────────────────────────────────────────────

// The bundle carries "(stored login)" by design, so a replay that treats credentials like any other
// approved field types that placeholder into the account's login box and submits it.
test("replay: a credential is re-read from storage, NOT replayed from the bundle", async () => {
  const page = icimsPage();
  const valueFor = (f) => {
    if (f.fieldName === "PersonProfileFields.Login") return "(stored login)";
    if (f.fieldName === "PersonProfileFields.Password") return "(stored password)";
    if (f.fieldName === "PersonProfileFields.Password_Confirm") return "(stored password confirm)";
    return "Kevin";
  };
  await ats.driveAtsPageFill(fakeAct(page), "icims", {}, {}, {}, { valueFor, credentials: CREDS });
  assert.strictEqual(page._box["#PersonProfileFields\\.Login"], CREDS.email);
  assert.strictEqual(page._box["#PersonProfileFields\\.Password"], CREDS.password);
  for (const sel of Object.keys(page._writes)) {
    assert.ok(!page._writes[sel].some((v) => /^\(stored /.test(String(v))),
      "a placeholder was typed into " + sel + " — that string would have been submitted");
  }
});

// ── the résumé, deliberately deferred ───────────────────────────────────────────────────

test("iCIMS résumé is SKIPPED — its server-side parse blanks the form mid-fill", async () => {
  const page = icimsPage();
  page.atsInjScan = () => ({ ...ICIMS_SCAN, fields: [
    { fieldName: "PortalProfileFields.Resume_File", inputSel: "#resume", widgetType: "file_upload", label: "Please upload your resume", isRequired: true, value: null, domIndex: 0 },
  ] });
  let attached = 0;
  const act = fakeAct(page);
  act.attachResume = async () => { attached++; return { ok: true }; };
  const out = await ats.driveAtsPageFill(act, "icims", PROFILE, {}, {}, { credentials: CREDS });
  assert.strictEqual(attached, 0, "the résumé must not be attached on iCIMS yet");
  assert.strictEqual(out.results[0].status, "skipped");
  assert.match(out.results[0].detail, /re-parses and blanks the form/);
});

// ── the iCIMS AJAX combobox ("IdDropDown") + the address block ──────────────────────────
//
// The <select> is decorative: permanently empty, and its `value` is an opaque numeric id. The real
// options are `<li>` rows in a sibling `<ul id="<id>_dropdown-results">`, one PAGE at a time, with a
// search box for the rest. Live 2026-08-16 the required Country and State/Province both reached
// review as "no live options to choose from" because the scan read `select.options`.

const ICIMS_ADDR_SCAN = {
  ats: "icims", url: "https://astrioncareers-astrion.icims.com/jobs/24615/x/candidate", title: "t",
  fields: [
    { fieldName: "-1_PersonProfileFields.AddressCity", inputSel: "#city", widgetType: "text", inputType: "text",
      label: "City", isRequired: true, value: null, domIndex: 0 },
    { fieldName: "-1_PersonProfileFields.AddressCountry", inputSel: "#country", widgetType: "icims_dropdown",
      label: "Country", isRequired: true, value: null, optionsPartial: true,
      childLink: "PersonProfileFields.AddressState", domIndex: 1 },
    { fieldName: "-1_PersonProfileFields.AddressState", inputSel: "#state", widgetType: "icims_dropdown",
      label: "State/Province", isRequired: true, value: null, optionsPartial: true, domIndex: 2 },
  ],
};

// A fake iCIMS widget: one page of options, a search that reveals the rest, and a child list that
// stays "Please select a country" until the parent commits — exactly the live behaviour.
function icimsWidgetPage(over) {
  const FIRST_PAGE = { "#country": ["United States", "Afghanistan", "Åland Islands"],
                       "#state": ["Alabama", "Alaska", "Arizona", "Florida", "Michigan"] };
  const FULL = { "#country": ["United States", "Afghanistan", "Åland Islands", "Zimbabwe"],
                 "#state": ["Alabama", "Alaska", "Arizona", "Florida", "Michigan", "Texas", "Washington"] };
  const st = { shown: {}, committed: {}, parentSet: false, searches: [], opened: [] };
  const listFor = (sel) => {
    if (sel === "#state" && !st.parentSet) return { awaitingParent: true, options: [] };
    return { awaitingParent: false, options: st.shown[sel] || FIRST_PAGE[sel] || [] };
  };
  const page = {
    atsInjScan: () => ICIMS_ADDR_SCAN,
    atsInjScrollIntoView: () => ({ ok: true }),
    atsInjSetText: (sel, v) => { st.committed[sel] = v; return { ok: true, after: v }; },
    atsInjIcimsOpen: (sel) => { st.opened.push(sel); const l = listFor(sel); return { ok: true, open: true, options: l.options }; },
    atsInjIcimsSearch: (sel, q) => {
      st.searches.push([sel, q]);
      const hits = (FULL[sel] || []).filter(o => o.toLowerCase().includes(String(q).toLowerCase()));
      st.shown[sel] = hits;
      return { ok: true };
    },
    atsInjIcimsReadOptions: (sel) => { const l = listFor(sel); return { ok: true, options: l.options, awaitingParent: l.awaitingParent, noChildren: false }; },
    atsInjIcimsCommit: (sel, text) => {
      const l = listFor(sel);
      if (!l.options.includes(text)) return { ok: false, error: "option-not-found" };
      st.committed[sel] = text;
      if (sel === "#country") st.parentSet = true;   // the page's own parent→child cascade
      return { ok: true };
    },
    atsInjIcimsRead: (sel) => ({ ok: true, value: st.committed[sel] || null, rawId: st.committed[sel] ? "12781" : null }),
    atsInjIcimsClose: () => ({ ok: true, closed: true }),
    atsInjReadValue: (a, sel, wt) => ({ ok: true, value: st.committed[sel] != null ? st.committed[sel] : null }),
    _st: st,
  };
  return Object.assign(page, over || {});
}

test("atsMapKey: the entry ordinal is stripped for iCIMS only", () => {
  assert.strictEqual(ats.atsMapKey("icims", "-1_PersonProfileFields.AddressCity"), "PersonProfileFields.AddressCity");
  assert.strictEqual(ats.atsMapKey("icims", "0_PersonProfileFields.AddressCity"), "PersonProfileFields.AddressCity");
  // a saved application comes back with SERVER ids, not -1
  assert.strictEqual(ats.atsMapKey("icims", "-6489344_PersonProfileFields.AddressCity"), "PersonProfileFields.AddressCity");
  assert.strictEqual(ats.atsMapKey("icims", "PersonProfileFields.Login"), "PersonProfileFields.Login");
  // scoped: no other tenant has its field names rewritten
  assert.strictEqual(ats.atsMapKey("greenhouse", "2_foo"), "2_foo");
  assert.strictEqual(ats.atsMapKey("lever", "-1_bar"), "-1_bar");
});

test("routeField: the address block maps through the stripped ordinal", () => {
  const P = { personal_info: { address_line_1: "123 Oak St", city: "Tallahassee",
    state_province: "Florida", postal_code: "32312", country: ["United States of America", "United States"] } };
  const r = (n) => ats.atsRouteField("icims", { fieldName: n, label: "x", widgetType: "text" }, P, {}, {}, new Map(), null);
  assert.strictEqual(r("-1_PersonProfileFields.AddressCity").raw, "Tallahassee");
  assert.strictEqual(r("-1_PersonProfileFields.AddressZip").raw, "32312");
  assert.strictEqual(r("-1_PersonProfileFields.AddressStreet1").raw, "123 Oak St");
  assert.strictEqual(r("-1_PersonProfileFields.AddressState").raw, "Florida");
  assert.deepStrictEqual(r("-1_PersonProfileFields.AddressCountry").raw, ["United States of America", "United States"]);
});

test("icims_dropdown: country + state fill, and the state waits for its parent", async () => {
  const P = { personal_info: { city: "Tallahassee", state_province: "Florida",
    country: ["United States of America", "United States"] } };
  const page = icimsWidgetPage();
  const out = await ats.driveAtsPageFill(fakeAct(page), "icims", P, {}, {}, {});
  const by = Object.fromEntries(out.results.map(r => [r.fieldName, r]));

  // the TIERED country ladder is what makes this land: the form offers "United States", the
  // profile's first tier is "United States of America"
  const c = by["-1_PersonProfileFields.AddressCountry"];
  assert.strictEqual(c.status, "filled", "country should fill deterministically");
  assert.strictEqual(c.after, "United States");
  assert.strictEqual(c.matchTier, "exact-normalized");

  const s = by["-1_PersonProfileFields.AddressState"];
  assert.strictEqual(s.status, "filled", "state fills once its parent committed");
  assert.strictEqual(s.after, "Florida");
  // and the parent really was committed first
  assert.ok(page._st.opened.indexOf("#country") < page._st.opened.indexOf("#state"));
});

test("icims_dropdown: an option past the FIRST PAGE is found via the search box", async () => {
  // "Texas" is not in the first page — the widget pages at 25 and offers "— Type to Search —"
  const P = { personal_info: { state_province: "Texas", country: ["United States"] } };
  const page = icimsWidgetPage();
  const out = await ats.driveAtsPageFill(fakeAct(page), "icims", P, {}, {}, {});
  const s = out.results.find(r => r.fieldName === "-1_PersonProfileFields.AddressState");
  assert.ok(page._st.searches.some(([sel, q]) => sel === "#state" && /texas/i.test(q)),
    "a first-page miss must SEARCH before reporting — otherwise everyone past Michigan fails");
  assert.strictEqual(s.status, "filled");
  assert.strictEqual(s.after, "Texas");
});

test("icims_dropdown: a child whose parent is unset says SO — not 'no options'", async () => {
  const P = { personal_info: { state_province: "Florida" } };  // no country → parent never commits
  const page = icimsWidgetPage();
  const out = await ats.driveAtsPageFill(fakeAct(page), "icims", P, {}, {}, {});
  const s = out.results.find(r => r.fieldName === "-1_PersonProfileFields.AddressState");
  assert.strictEqual(s.status, "needs_review");
  assert.match(s.detail, /parent field is chosen/,
    "the live run reported 'no live options to choose from', which sent debugging at the option read " +
    "instead of at the unset parent");
});

test("icims_dropdown: a commit the widget does not display is NOT reported filled", async () => {
  const P = { personal_info: { country: ["United States"] } };
  const page = icimsWidgetPage({ atsInjIcimsRead: () => ({ ok: true, value: null }) }); // click 'worked', nothing shown
  const out = await ats.driveAtsPageFill(fakeAct(page), "icims", P, {}, {}, {});
  const c = out.results.find(r => r.fieldName === "-1_PersonProfileFields.AddressCountry");
  assert.strictEqual(c.status, "needs_review");
  assert.match(c.detail, /did not persist/);
});

test("icims_dropdown: its option list is always recorded PARTIAL (it pages + searches)", async () => {
  const P = { personal_info: { country: ["United States"] } };
  const out = await ats.driveAtsPageFill(fakeAct(icimsWidgetPage()), "icims", P, {}, {}, {});
  const c = out.results.find(r => r.fieldName === "-1_PersonProfileFields.AddressCountry");
  assert.strictEqual(c.optionsPartial, true, "25 rows must never be presented as the complete list");
  assert.ok(Array.isArray(c.captured_options) && c.captured_options.length > 0);
});

// ── repeating sections are SEALED to their own entry ────────────────────────────────────
//
// Operator's rule: a field inside a repeating section may only be answered from THAT section's
// data. The example that makes it obvious — a "State/Province" inside an Education entry is the
// COLLEGE's state, so answering it from the applicant's home address is a different fact, not a
// near-miss. The seal binds the LLM too: an entry field is shown only its own entry.

// ⚠ The graduation year is computed, not hard-coded: this profile must stay "still studying"
// whenever the suite runs, or the IsGraduated assertions would silently invert in a few years.
const FUTURE_YEAR = String(new Date().getFullYear() + 2);
const PAST_YEAR = String(new Date().getFullYear() - 2);

const EDU_PROFILE = {
  personal_info: { city: "Tallahassee", state_province: "Florida", country: ["United States"] },
  education: [{
    school_or_university: "Carnegie Mellon University",
    degree: ["Bachelor of Science", "Bachelor's Degree", "Bachelors"],
    field_of_study: ["Electrical and Computer Engineering", "Electrical Engineering"],
    minor: "", gpa: "3.95", from_year: "2024", graduation_date: FUTURE_YEAR + "-05",
    // ⚠ DELIBERATELY ABSENT, because that is what a real synced profile looks like: the website's
    // education editor does not expose this checkbox, so zod fills in the default. A rule that
    // reads the default as "has graduated" answers a student "Yes" — which is what happened live.
  }],
};

const EDU_FIELDS = [
  { fieldName: "-1_CandProfileFields.School", inputSel: "#school", widgetType: "icims_dropdown", label: "School", isRequired: true, value: null, domIndex: 0 },
  { fieldName: "-1_CandProfileFields.OtherSchool", inputSel: "#other", widgetType: "text", inputType: "text", label: "Other School", isRequired: true, value: null, domIndex: 1 },
  { fieldName: "-1_CandProfileFields.Degree", inputSel: "#degree", widgetType: "icims_dropdown", label: "Degree", isRequired: true, value: null, domIndex: 2 },
  { fieldName: "-1_CandProfileFields.Major", inputSel: "#major", widgetType: "icims_dropdown", label: "Major", isRequired: false, value: null, domIndex: 3 },
  { fieldName: "-1_CandProfileFields.GPA", inputSel: "#gpa", widgetType: "text", inputType: "text", label: "GPA", isRequired: false, value: null, domIndex: 4 },
  { fieldName: "-1_CandProfileFields.IsGraduated", inputSel: "#grad", widgetType: "dropdown_native", label: "Did You Graduate", isRequired: true, value: null, options: ["Yes", "No"], domIndex: 5 },
  { fieldName: "-1_CandProfileFields.GraduationDate_Month", inputSel: "#gm", widgetType: "dropdown_native", label: "Month", isRequired: false, value: null, options: ["January", "May", "December"], domIndex: 6 },
  { fieldName: "-1_CandProfileFields.GraduationDate_Year", inputSel: "#gy", widgetType: "text", inputType: "text", label: "Year", isRequired: false, value: null, domIndex: 7 },
  { fieldName: "-1_CandProfileFields.EducationState", inputSel: "#estate", widgetType: "icims_dropdown", label: "State/Province", isRequired: false, value: null, domIndex: 8 },
];

// `schoolList` controls whether the typeahead can find the school.
function eduPage(schoolList, over) {
  const committed = {}, searched = [];
  const LISTS = {
    "#school": schoolList,
    "#degree": ["Bachelor of Science", "Master of Science", "Other"],
    "#major": ["Electrical and Computer Engineering", "Mechanical Engineering"],
    "#estate": ["Alabama", "Florida", "Pennsylvania"],
  };
  const shown = {};
  const page = {
    atsInjScan: () => ({ ats: "icims", url: "https://x.icims.com/jobs/1/candidate", title: "t", fields: EDU_FIELDS.map(f => ({ ...f })) }),
    atsInjScrollIntoView: () => ({ ok: true }),
    atsInjSetText: (sel, v) => { committed[sel] = v; return { ok: true, after: v }; },
    atsInjSelectNative: (sel, t) => { committed[sel] = t; return { ok: true }; },
    atsInjIcimsOpen: (sel) => ({ ok: true, open: true, options: (LISTS[sel] || []).slice(0, 3) }),
    atsInjIcimsSearch: (sel, q) => { searched.push([sel, q]); shown[sel] = (LISTS[sel] || []).filter(o => o.toLowerCase().includes(String(q).toLowerCase())); return { ok: true }; },
    atsInjIcimsReadOptions: (sel) => {
      const l = shown[sel];
      if (l === undefined) return { ok: true, options: (LISTS[sel] || []).slice(0, 3), awaitingParent: false, noResults: false };
      return { ok: true, options: l, awaitingParent: false, noResults: l.length === 0 };
    },
    atsInjIcimsCommit: (sel, t) => { committed[sel] = t; return { ok: true }; },
    atsInjIcimsRead: (sel) => ({ ok: true, value: committed[sel] || null }),
    atsInjIcimsClose: () => ({ ok: true, closed: true }),
    atsInjReadValue: (a, sel) => ({ ok: true, value: committed[sel] != null ? committed[sel] : null }),
    _c: committed, _searched: searched,
  };
  return Object.assign(page, over || {});
}

test("scoping: an Education field sees ONLY its own entry — never the profile root", () => {
  const f = { fieldName: "-1_CandProfileFields.EducationState", entryIndex: 0 };
  const scoped = ats.atsScopeForField("icims", f, EDU_PROFILE);
  assert.deepStrictEqual(Object.keys(scoped), ["education_entry"]);
  assert.strictEqual(scoped.education_entry.school_or_university, "Carnegie Mellon University");
  assert.strictEqual(scoped.personal_info, undefined, "the home address must not be visible to an education question");
  // a NON-entry field still sees the whole profile
  assert.strictEqual(ats.atsScopeForField("icims", { fieldName: "PersonProfileFields.FirstName" }, EDU_PROFILE), EDU_PROFILE);
});

test("scoping: an Education State is NOT answered 'Florida' from the home address", async () => {
  const page = eduPage(["Carnegie Mellon University", "Other"]);
  const out = await ats.driveAtsPageFill(fakeAct(page), "icims", EDU_PROFILE, {}, {}, {});
  const s = out.results.find(r => r.fieldName === "-1_CandProfileFields.EducationState");
  assert.notStrictEqual(s.after, "Florida", "THE BUG THIS RULE EXISTS FOR — that is the applicant's home state, not the college's");
  assert.notStrictEqual(s.status, "filled");
  assert.strictEqual(page._c["#estate"], undefined, "nothing may be committed to it deterministically");
});

test("education: degree / major / GPA / dates all fill from the ENTRY", async () => {
  const page = eduPage(["Carnegie Mellon University", "Other"]);
  const out = await ats.driveAtsPageFill(fakeAct(page), "icims", EDU_PROFILE, {}, {}, {});
  const by = Object.fromEntries(out.results.map(r => [r.fieldName, r]));
  assert.strictEqual(by["-1_CandProfileFields.Degree"].after, "Bachelor of Science");
  assert.strictEqual(by["-1_CandProfileFields.Major"].after, "Electrical and Computer Engineering");
  assert.strictEqual(by["-1_CandProfileFields.GPA"].after, "3.95");
  // ⚠ A FUTURE graduation date means NOT graduated — and it must win WITHOUT `currently_enrolled`,
  // which this profile does not carry (see the fixture). Live, the missing flag defaulted to false
  // and answered a student "Yes".
  assert.strictEqual(by["-1_CandProfileFields.IsGraduated"].after, "No");
  assert.strictEqual(by["-1_CandProfileFields.GraduationDate_Month"].after, "May");
  assert.strictEqual(by["-1_CandProfileFields.GraduationDate_Year"].after, FUTURE_YEAR);
  for (const n of ["-1_CandProfileFields.Degree", "-1_CandProfileFields.GPA", "-1_CandProfileFields.IsGraduated"]) {
    assert.strictEqual(by[n].status, "filled", n + " should be deterministic");
  }
});

test("school pair: FOUND in the list ⇒ pick it, and Other School gets N/A", async () => {
  const page = eduPage(["Carnegie Mellon University", "Other"]);
  const out = await ats.driveAtsPageFill(fakeAct(page), "icims", EDU_PROFILE, {}, {}, {});
  assert.strictEqual(page._c["#school"], "Carnegie Mellon University");
  assert.strictEqual(page._c["#other"], "N/A");
});

test("school pair: NOT in the list ⇒ pick 'Other', and the NAME goes in Other School", async () => {
  const page = eduPage(["Some Other College", "Other"]);   // no Carnegie Mellon
  const out = await ats.driveAtsPageFill(fakeAct(page), "icims", EDU_PROFILE, {}, {}, {});
  assert.strictEqual(page._c["#school"], "Other");
  assert.strictEqual(page._c["#other"], "Carnegie Mellon University");
  const s = out.results.find(r => r.fieldName === "-1_CandProfileFields.School");
  assert.strictEqual(s.flag, "school-not-listed");
  assert.match(s.detail, /Other School/);
});

// ⚠ THE REGRESSION THAT CAUSED THE LIVE MISS. The pre-search list is already non-zero AND stable, so
// a stability-only settle accepts it and matches against the unfiltered page — reporting "no option
// matched Carnegie Mellon University (after searching)" while typing it by hand returns it first.
test("school search: the settle waits for the list to CHANGE, not merely to hold still", async () => {
  const page = eduPage(["Carnegie Mellon University", "Other"]);
  // the search result arrives LATE: three reads still show the unfiltered first page
  let reads = 0;
  const realRead = page.atsInjIcimsReadOptions;
  page.atsInjIcimsReadOptions = (sel) => {
    if (sel === "#school" && ++reads <= 3) return { ok: true, options: ["Some College", "Another College", "Other"], awaitingParent: false, noResults: false };
    return realRead(sel);
  };
  const out = await ats.driveAtsPageFill(fakeAct(page), "icims", EDU_PROFILE, {}, {}, {});
  assert.strictEqual(page._c["#school"], "Carnegie Mellon University",
    "a slow search must not be resolved against the pre-search list");
  assert.strictEqual(page._c["#other"], "N/A");
});

test("school search: the widget's own 'No Results' is a terminal state → the Other branch", async () => {
  const page = eduPage(["Other"]);
  page.atsInjIcimsSearch = (sel, q) => { page._searched.push([sel, q]); return { ok: true }; };
  page.atsInjIcimsReadOptions = (sel) => sel === "#school"
    ? { ok: true, options: [], awaitingParent: false, noResults: true }
    : { ok: true, options: ["Bachelor of Science", "Other"], awaitingParent: false, noResults: false };
  const out = await ats.driveAtsPageFill(fakeAct(page), "icims", EDU_PROFILE, {}, {}, {});
  assert.strictEqual(page._c["#school"], "Other");
  assert.strictEqual(page._c["#other"], "Carnegie Mellon University");
});

// ⚠ OBSERVED LIVE: School "Other" + Other School "Carnegie Mellon University" on a form that DOES
// list CMU. The fallback fired on ANY match failure, so a search still in flight — or a menu
// disturbed by the page moving under it — read identically to an absent school. "Other" is a
// STATEMENT that the university is not in their system; an unknown must never be answered with one.
test("school: a miss WITHOUT a 'No Results' verdict must NOT be answered 'Other'", async () => {
  const page = eduPage(["Carnegie Mellon University", "Other"]);
  // the search never resolves: the list keeps showing the unfiltered page, and the widget never
  // reports noResults — exactly what a slow or disturbed search looks like
  // the school is NOT on the first page (so a search is needed) and the search never resolves
  page.atsInjIcimsOpen = (sel) => ({ ok: true, open: true,
    options: sel === "#school" ? ["Some College", "Another College", "Other"] : ["Bachelor of Science", "Other"] });
  page.atsInjIcimsSearch = (sel, q) => { page._searched.push([sel, q]); return { ok: true }; };
  page.atsInjIcimsReadOptions = (sel) => sel === "#school"
    ? { ok: true, options: ["Some College", "Another College", "Other"], awaitingParent: false, noResults: false }
    : { ok: true, options: ["Bachelor of Science", "Other"], awaitingParent: false, noResults: false };
  const out = await ats.driveAtsPageFill(fakeAct(page), "icims", EDU_PROFILE, {}, {}, {});
  assert.notStrictEqual(page._c["#school"], "Other",
    "answering 'Other' here asserts the school is absent, which we never established");
  const s = out.results.find((r) => r.fieldName === "-1_CandProfileFields.School");
  assert.strictEqual(s.flag, "school-unconfirmed");
  assert.match(s.detail, /No Results/);
});

test("AI batching is grouped PER ENTRY — an entry question never sees the whole profile", async () => {
  const prompts = [];
  const page = eduPage(["Carnegie Mellon University", "Other"], {
    aiEnabled: true,
    llm: async (a) => { prompts.push(a); return { ok: true, text: JSON.stringify({ answers: [] }) }; },
  });
  // make the unanswerable entry field REQUIRED so it reaches the AI at all
  page.atsInjScan = () => ({ ats: "icims", url: "https://x.icims.com/jobs/1/candidate", title: "t",
    fields: EDU_FIELDS.map(f => f.fieldName.endsWith("EducationState") ? { ...f, isRequired: true } : { ...f }) });
  await ats.driveAtsPageFill(fakeAct(page), "icims", EDU_PROFILE, {}, {}, {});
  const blob = prompts.map(p => JSON.stringify(p)).join(" ");
  if (blob) {
    assert.ok(!/Tallahassee/.test(blob), "the home city must never appear in an education question's prompt");
    assert.ok(!/personal_info/.test(blob), "the profile root must not be sent for an entry field");
  }
});

// ⚠ THE ALLOWLIST HOLE, live 2026-08-16. The seal originally listed the field names it knew, so
// `EducationCity` — which it did not — escaped it, reached the label ladder, and was answered
// "Tallahassee" from the HOME address. A seal that only covers the fields you remembered is not a
// seal, so membership in the section is now enough on its own.
test("seal: an UNMAPPED field inside the section is still sealed from the profile root", async () => {
  const page = eduPage(["Carnegie Mellon University", "Other"]);
  page.atsInjScan = () => ({ ats: "icims", url: "https://x.icims.com/jobs/1/candidate", title: "t", fields: [
    ...EDU_FIELDS.map(f => ({ ...f, section: "Education" })),
    // ⚠ BOTH of these must be genuinely UNMAPPED, or the test proves nothing — the first version
    // used `EducationCity`, which had just been GIVEN a mapping, so it passed with the seal removed.
    // (a) name matches the section's id family, but there is no spec for it
    { fieldName: "-1_CandProfileFields.EducationSomethingElse", inputSel: "#ecity", widgetType: "text",
      inputType: "text", label: "City", isRequired: false, value: null, section: "Education", domIndex: 20 },
    // (b) a per-customer id the family regex cannot match — only SECTION MEMBERSHIP can seal this one
    { fieldName: "-1_rcf9999", inputSel: "#rcity", widgetType: "text",
      inputType: "text", label: "City", isRequired: false, value: null, section: "Education", domIndex: 21 },
  ] });
  // ⚠ THE BUCKET IS WHAT MAKES THIS REPRODUCE. A bare "City" label matches no recognizer in the
  // label ladder, so the ladder alone cannot answer it — the live "Tallahassee" came through a
  // TAUGHT BUCKET pointing at personal_info.city, which sits ABOVE the label ladder and would gladly
  // answer any field carrying that wording, wherever on the form it sits. Without this the fixture
  // passes with the seal removed and proves nothing.
  const buckets = [{ questions: ["City"], profile_path: "personal_info.city" }];
  await ats.driveAtsPageFill(fakeAct(page), "icims", EDU_PROFILE, {}, {}, { buckets });
  assert.notStrictEqual(page._c["#ecity"], "Tallahassee",
    "an unmapped education field must never be answered from the applicant's home address");
  assert.notStrictEqual(page._c["#rcity"], "Tallahassee",
    "a per-customer field inside the section is sealed by MEMBERSHIP alone");
});

test("seal: the entry's own location fills city / state / country — none of them from home", async () => {
  const withLoc = { ...EDU_PROFILE, education: [{ ...EDU_PROFILE.education[0], location: "Pittsburgh, PA" }] };
  const es = { section: "education", source: "education", entryIndex: 0, spec: null };
  const city = ats.atsResolveEntryField({ ...es, spec: { kind: "entry_city" } }, withLoc.education[0], {});
  const state = ats.atsResolveEntryField({ ...es, spec: { kind: "entry_state" } }, withLoc.education[0], {});
  const ctry = ats.atsResolveEntryField({ ...es, spec: { kind: "entry_country" } }, withLoc.education[0], {});
  assert.strictEqual(city.value, "Pittsburgh");
  assert.deepStrictEqual(state.candidates, ["Pennsylvania", "PA"]);
  // a US state implies the country — which is what fills State's declared PARENT in the same pass
  assert.deepStrictEqual(ctry.candidates, ["United States", "United States of America"]);
  // no location ⇒ nothing is invented
  assert.strictEqual(ats.atsResolveEntryField({ ...es, spec: { kind: "entry_city" } }, { school_or_university: "X" }, {}), null);
});

// ── the Experience section: per-customer ids, so routing is by LABEL inside the seal ────
const WE_PROFILE = {
  personal_info: { city: "Tallahassee", state_province: "Florida" },
  work_experience: [
    { job_title: "CISCOR Robotics Lab Intern", company: "Florida State University / L3Harris",
      location: "Tallahassee, FL", from: "2025-05", to: "2025-08", currently_work_here: false,
      role_description: "Developed ROS 2 nodes.\nImplemented CAN bus protocols.\nCreated RQT plugins." },
    { job_title: "Firmware Team Member", company: "Carnegie Mellon Racing",
      location: "Pittsburgh, PA", from: "2024-09", to: "", currently_work_here: true,
      role_description: "Analyzed C++ firmware.\nImproved the VSM testbench." },
  ],
};
// rcf ids are per-customer; the LABEL is what identifies the field, and Month/Year repeat.
const weField = (n, label, over) => Object.assign(
  { fieldName: "-1_PersonProfileFields." + n, inputSel: "#" + n, widgetType: "text", inputType: "text",
    label, isRequired: false, value: null, section: "Experience" }, over || {});

test("experience: routed by LABEL, and each field answers from its OWN entry", () => {
  const fields = [
    weField("rcf3212", "Employer"), weField("rcf3213", "Title"),
    weField("rcf3219", "Description", { widgetType: "textarea" }),
    weField("rcf3216", "City"), weField("rcf3214_Month", "Month"), weField("rcf3214_Year", "Year"),
    weField("rcf3215_Month", "Month"), weField("rcf3215_Year", "Year"),
  ];
  ats.atsAssignEntryIndexes("icims", fields);
  const r = (f) => ats.atsRouteField("icims", f, WE_PROFILE, {}, {}, new Map(), null);
  assert.strictEqual(r(fields[0]).raw, "Florida State University / L3Harris");
  assert.strictEqual(r(fields[1]).raw, "CISCOR Robotics Lab Intern");
  assert.match(r(fields[2]).raw, /Developed ROS 2 nodes/, "the Description box gets the role description");
  assert.strictEqual(r(fields[2]).raw.split("\n").length, 3, "every bullet, one per line");
  // the employer's city, never the home city
  assert.notStrictEqual(r(fields[3]).value, "Tallahassee".replace(/x/, "x") && undefined);
  assert.strictEqual(r(fields[3]).value, "Tallahassee", "entry 0's employer IS in Tallahassee — from ITS location, not personal_info");
  // ⚠ the two date triples carry IDENTICAL labels; only their group tells start from end
  assert.deepStrictEqual(r(fields[4]).candidates, ["May"]);
  assert.strictEqual(r(fields[5]).value, "2025");
  // tiered: the form may spell it "Aug" (see the month-vocabulary test)
  assert.deepStrictEqual(r(fields[6]).candidates, ["August", "Aug"]);
  assert.strictEqual(r(fields[7]).value, "2025");
});

// A month dropdown's VOCABULARY is the tenant's choice, not a fact about the date. Live, two
// end-date months reached review as `stated-value-unmatched` — "August" against a list spelling it
// "Aug" — while the education date control on the SAME page listed Jan…Dec.
test("months are tiered: full name first, then the abbreviation the form may use", () => {
  assert.deepStrictEqual(ats.atsMonthCandidates(7), ["August", "Aug"]);
  assert.deepStrictEqual(ats.atsMonthCandidates(0), ["January", "Jan"]);
  // May is already three letters — one candidate, not a duplicate
  assert.deepStrictEqual(ats.atsMonthCandidates(4), ["May"]);
  // the one month whose short form is commonly FOUR letters
  assert.deepStrictEqual(ats.atsMonthCandidates(8), ["September", "Sep", "Sept"]);
  // full name stays FIRST, so a form offering full names still matches exactly
  assert.strictEqual(ats.atsMonthCandidates(11)[0], "December");
});

test("experience: a role you STILL HOLD leaves its end date blank, never AI-guessed", () => {
  // ⚠ ENTRY INDEX COMES FROM ORDINAL ORDER, NOT THE ORDINAL'S VALUE — so entry TWO only exists if
  // entry one is on the page too. (My first draft listed only `-2_` fields, which made `-2` the
  // first-seen ordinal and therefore entry 0 — a PAST role, where the assertion is meaningless.)
  const all = [
    weField("rcf3212", "Employer"),                                   // -1_ → entry 0
    { ...weField("rcf3214_Month", "Month"), fieldName: "-2_PersonProfileFields.rcf3214_Month" },
    { ...weField("rcf3215_Month", "Month"), fieldName: "-2_PersonProfileFields.rcf3215_Month" },
    { ...weField("rcf3215_Year", "Year"), fieldName: "-2_PersonProfileFields.rcf3215_Year" },
  ];
  ats.atsAssignEntryIndexes("icims", all);
  assert.strictEqual(all[3].entryIndex, 1, "the -2_ fields must be entry 1 (Carnegie Mellon Racing)");
  const end = all.find((f) => /rcf3215_Year/.test(f.fieldName));
  const route = ats.atsRouteField("icims", end, WE_PROFILE, {}, {}, new Map(), null);
  assert.strictEqual(route.kind, "skip", "an end date for a current role must not be invented");
  assert.match(route.detail, /still work here/);
});

// "May we contact this employer?" governs whether a recruiter may ring a past employer. Releasing
// the contact details IS that consequence, so they are gated on the ANSWER — never on whether the
// profile happens to hold them.
test("employer contact details are withheld unless may_contact is an explicit YES", () => {
  const es = { section: "work_experience", source: "work_experience", entryIndex: 0 };
  const entry = (may) => ({ may_contact: may, employer_email: "hr@acme.com", employer_phone: "555-0100" });
  const ask = (may, kind, path) => ats.atsResolveEntryField({ ...es, spec: { kind, path } }, entry(may), {});

  // YES → released
  assert.strictEqual(ask(true, "contact_if_allowed", "employer_email").raw, "hr@acme.com");
  assert.strictEqual(ask(true, "contact_if_allowed", "employer_phone").raw, "555-0100");
  // NO → withheld, and says why
  assert.strictEqual(ask(false, "contact_if_allowed", "employer_email").kind, "skip");
  assert.match(ask(false, "contact_if_allowed", "employer_email").detail, /answered No/);
  // UNANSWERED → also withheld. A tri-state must not be read as consent by omission.
  assert.strictEqual(ask(null, "contact_if_allowed", "employer_phone").kind, "skip");
  assert.match(ask(null, "contact_if_allowed", "employer_phone").detail, /unanswered/);

  // the question itself is deterministic when answered, and unanswered when not
  assert.deepStrictEqual(ask(true, "may_contact").candidates, ["Yes"]);
  assert.deepStrictEqual(ask(false, "may_contact").candidates, ["No"]);
  assert.strictEqual(ask(null, "may_contact"), null, "an unanswered tri-state must not pick a side");
});

test("experience: the new employer fields route from the entry", () => {
  const P = { work_experience: [{
    employer_address: "1 Rivian Way", employer_postal_code: "92602",
    supervisor_name: "Dana Lee", supervisor_title: "Staff Engineer",
    reason_for_leaving: "Internship ended", may_contact: true,
  }] };
  const f = (label) => { const x = { fieldName: "-1_PersonProfileFields.rcfX", inputSel: "#x",
    widgetType: "text", label, isRequired: false, value: null, section: "Experience" };
    ats.atsAssignEntryIndexes("icims", [x]); return x; };
  const r = (label) => ats.atsRouteField("icims", f(label), P, {}, {}, new Map(), null);
  assert.strictEqual(r("Address").raw, "1 Rivian Way");
  assert.strictEqual(r("Zip").raw, "92602");
  assert.strictEqual(r("Supervisor's Name").raw, "Dana Lee");
  assert.strictEqual(r("Supervisor's Title").raw, "Staff Engineer");
  assert.strictEqual(r("Reason for Leaving").raw, "Internship ended");
  assert.deepStrictEqual(r("May We Contact").candidates, ["Yes"]);
});

test("experience: a field with no mapping is still SEALED — unanswered, never borrowed", () => {
  // Address/supervisor used to be `skip`; they are mapped now, so this uses a label with no mapping
  // at all. The point is unchanged: membership seals it, so it reaches the scoped AI rather than the
  // profile root — it must never be answered from personal_info.
  const f = weField("rcf9999", "Badge Number");
  ats.atsAssignEntryIndexes("icims", [f]);
  const route = ats.atsRouteField("icims", f, WE_PROFILE, {}, {}, new Map(), null);
  assert.strictEqual(route.kind, "entry-unanswered");
  assert.strictEqual(route.section, "experience", "the section KEY, not the profile array it reads");
});

// ⚠ The section is titled "Skills", not "Certifications" — the only control under that heading is
// the repeating Certifications box. Asked for before the operator had any certifications, so that
// the section is wired and SEALED in advance rather than discovered wrong on the first one.
test("certifications: the entry fills from its own row, tiered name, most specific first", () => {
  const P = { skills: ["Python"], certifications: [
    { certification: ["Certified Professional Engineer", "PE"], certification_number: "12345" },
    { certification: "EIT" },                                  // a bare string still works
    { certification: [] },                                     // nothing to say
  ] };
  const ask = (i) => ats.atsResolveEntryField(
    { section: "certifications", source: "certifications", entryIndex: i, spec: { kind: "certification_name" } },
    P.certifications[i], {});
  assert.strictEqual(ask(0).value, "Certified Professional Engineer", "most specific tier, not the abbreviation");
  assert.strictEqual(ask(1).value, "EIT");
  assert.strictEqual(ask(2), null, "an empty tier list stays unanswered rather than writing \"\"");
});

test("certifications: a Skills-section field is SEALED to the certifications entry", () => {
  const P = { skills: ["Python", "C++"], certifications: [{ certification: ["PE License"] }] };
  const f = { fieldName: "-1_PersonProfileFields.rcf2062", inputSel: "#c", widgetType: "text",
    inputType: "text", label: "Certifications", isRequired: false, value: null, section: "Skills" };
  ats.atsAssignEntryIndexes("icims", [f]);
  const route = ats.atsRouteField("icims", f, P, {}, {}, new Map(), null);
  assert.strictEqual(route.value, "PE License");
  assert.match(route.path, /^certifications\[0\]/);
});

// "Please select the following employment options you would consider…" — a native <select multiple>
// offering Full-time / Internship / Part-time / Temporary (iCIMS rcf2010, traced 2026-08-16).
const ET_FIELD = { fieldName: "rcf2010", inputSel: "#et", widgetType: "multiselect_native",
  label: "Please select the following employment options you would you consider (please hold down the Ctrl key to select multiple options):",
  isRequired: false, value: null, options: ["Full-time", "Internship", "Part-time", "Temporary"], domIndex: 0 };

test("employment options: routed deterministically from the stated list", () => {
  const P = { employment_types_considered: ["Internship", "Full-time"] };
  const r = ats.atsRouteField("icims", ET_FIELD, P, {}, {}, new Map(), null);
  assert.deepStrictEqual(r.candidates, ["Internship", "Full-time"]);
  assert.strictEqual(r.path, "employment_types_considered");
  // an empty list leaves the question UNANSWERED rather than guessing a default
  assert.strictEqual(ats.atsRouteField("icims", ET_FIELD, { employment_types_considered: [] }, {}, {}, new Map(), null), null);
});

test("employment options: the recognizer does not swallow work-AUTHORISATION questions", () => {
  const P = { employment_types_considered: ["Full-time"] };
  for (const label of [
    "Are you legally authorized to work in the United States?",
    "Will you now or in the future require sponsorship for employment visa status?",
  ]) {
    const r = ats.atsRouteLabel(label, { ...ET_FIELD, label }, P, {});
    assert.notStrictEqual(r && r.path, "employment_types_considered", "eligibility is a different question: " + label);
  }
});

test("multiselect: EVERY offered answer is selected in ONE commit, and misses are reported", async () => {
  const sel = {};
  const page = {
    atsInjScan: () => ({ ats: "icims", url: "https://x.icims.com/jobs/1/candidate", title: "t", fields: [ET_FIELD] }),
    atsInjScrollIntoView: () => ({ ok: true }),
    // ⚠ mirrors the real widget: a fresh selection REPLACES the previous one, so a per-option loop
    // would leave only the last pick — the bug the one-shot commit exists to avoid.
    atsInjSelectNativeMulti: (s, texts) => { sel[s] = [...texts]; return { ok: true, missed: [], selected: [...texts] }; },
    // ⚠ MIRRORS THE REAL atsInjReadValue: `values` is the authoritative array and `value` joins on the
    // shared group separator "; ". It used to join on ", ", and once the real function was corrected
    // that stale fixture made the post-fill AUDIT compare "A; B" against "A, B" and flip a correct
    // fill to audit-mismatch — a fixture taking a different path than the page, which is exactly what
    // the live-testing skill warns produces false results.
    atsInjReadValue: (a, s) => ({ ok: true, values: [...(sel[s] || [])], value: (sel[s] || []).join("; ") || null }),
  };
  const out = await ats.driveAtsPageFill(fakeAct(page), "icims",
    { employment_types_considered: ["Internship", "Full-time"] }, {}, {}, {});
  assert.deepStrictEqual(sel["#et"], ["Internship", "Full-time"], "both, in one commit");
  assert.strictEqual(out.results[0].status, "filled");
  // The GROUP contract, which is what the review editor ticks its boxes from: the authoritative array
  // plus a joined display string that splitGroupValue can split back apart. Without the array the
  // question rendered BLANK on a form holding both answers (live 2026-08-17).
  assert.deepStrictEqual(out.results[0].selected_options, ["Internship", "Full-time"]);
  assert.strictEqual(out.results[0].after, "Internship; Full-time");

  // a stored answer the form does not offer is REPORTED, never silently dropped
  const sel2 = {};
  const page2 = { ...page, atsInjSelectNativeMulti: (s, texts) => { sel2[s] = [...texts]; return { ok: true, missed: [], selected: [...texts] }; },
    atsInjReadValue: (a, s) => ({ ok: true, values: [...(sel2[s] || [])], value: (sel2[s] || []).join("; ") || null }) };
  const out2 = await ats.driveAtsPageFill(fakeAct(page2), "icims",
    { employment_types_considered: ["Internship", "Contract"] }, {}, {}, {});
  assert.deepStrictEqual(sel2["#et"], ["Internship"]);
  assert.strictEqual(out2.results[0].status, "filled_review");
  assert.strictEqual(out2.results[0].flag, "partial-multiselect");
  assert.match(out2.results[0].detail, /does not offer Contract/);
});

// A field we did not fill still has to be ANSWERABLE on the review page, and a picker with no
// options is just a text box — the operator retypes a value the form was showing us all along.
test("review: an UNFILLED choice field still carries the form's options", async () => {
  const OPTS = ["Full-time", "Part-time", "Internship", "Temporary"];
  const page = {
    atsInjScan: () => ({ ats: "icims", url: "https://x.icims.com/jobs/1/candidate", title: "t", fields: [
      // nothing in the profile answers either of these
      { fieldName: "rcf9001", inputSel: "#a", widgetType: "dropdown_native", label: "Shift preference",
        isRequired: false, value: null, options: OPTS, domIndex: 0 },
      { fieldName: "rcf9002", inputSel: "#b", widgetType: "radio", label: "Relocation help needed",
        isRequired: false, value: null, options: ["Yes", "No"], domIndex: 1 },
      // a text field has no options and must not gain any
      { fieldName: "rcf9003", inputSel: "#c", widgetType: "text", inputType: "text", label: "Badge",
        isRequired: false, value: null, domIndex: 2 },
    ] }),
    atsInjScrollIntoView: () => ({ ok: true }),
    atsInjReadValue: () => ({ ok: true, value: null }),
  };
  const out = await ats.driveAtsPageFill(fakeAct(page), "icims", { personal_info: {} }, {}, {}, {});
  const by = Object.fromEntries(out.results.map((r) => [r.fieldName, r]));
  assert.deepStrictEqual(by.rcf9001.options, OPTS, "an unfilled dropdown must still offer its options");
  assert.deepStrictEqual(by.rcf9002.options, ["Yes", "No"]);
  assert.strictEqual(by.rcf9003.options ?? null, null, "a text field gains nothing");
  // and this costs no page contact — the options came from the scan, not a re-open
  assert.strictEqual(by.rcf9001.status, "skipped");
});

test("atsIsFutureYearMonth: a bare year is past only once the year is OVER", () => {
  const now = new Date("2026-08-16T00:00:00Z").getTime();
  assert.strictEqual(ats.atsIsFutureYearMonth("2028-05", now), true);
  assert.strictEqual(ats.atsIsFutureYearMonth("2026-05", now), false);   // earlier this year
  assert.strictEqual(ats.atsIsFutureYearMonth("2026-11", now), true);    // later this year
  assert.strictEqual(ats.atsIsFutureYearMonth("2026", now), true);       // the year has not ended
  assert.strictEqual(ats.atsIsFutureYearMonth("2025", now), false);
  assert.strictEqual(ats.atsIsFutureYearMonth("whenever", now), null);
});

// The exact live wrong answer: no `currently_enrolled` on the entry (the website editor does not
// expose it), a graduation date two years out, and the run said "Yes, graduated".
test("is_graduated: a FUTURE graduation date beats a missing currently_enrolled flag", () => {
  const now = new Date("2026-08-16T00:00:00Z").getTime();
  const es = { section: "education", source: "education", entryIndex: 0, spec: { kind: "is_graduated" } };
  assert.deepStrictEqual(ats.atsResolveEntryField(es, { graduation_date: "2028-05" }, {}, now).candidates, ["No"]);
  assert.deepStrictEqual(ats.atsResolveEntryField(es, { to_year: "2028" }, {}, now).candidates, ["No"]);
  // a past date with no flag does mean graduated
  assert.deepStrictEqual(ats.atsResolveEntryField(es, { graduation_date: "2020-05" }, {}, now).candidates, ["Yes"]);
  // the flag still wins when the dates say nothing at all
  assert.deepStrictEqual(ats.atsResolveEntryField(es, { currently_enrolled: true }, {}, now).candidates, ["No"]);
  // and nothing to go on stays unanswered rather than guessing
  assert.strictEqual(ats.atsResolveEntryField(es, {}, {}, now), null);
});

test("atsAssignEntryIndexes: entries are ordered by FIRST APPEARANCE, not by ordinal value", () => {
  const fields = [
    { fieldName: "-1_CandProfileFields.School" },
    { fieldName: "-1_CandProfileFields.Degree" },
    { fieldName: "-6489344_CandProfileFields.School" },   // a SAVED entry's server id
    { fieldName: "-6489344_CandProfileFields.Degree" },
  ];
  ats.atsAssignEntryIndexes("icims", fields);
  assert.deepStrictEqual(fields.map(f => f.entryIndex), [0, 0, 1, 1]);
});

// ── the injected credential fns obey the same contracts as the rest ─────────────────────

test("the credential injected fns are self-contained and return NO value", () => {
  for (const name of ["atsInjSetCredential", "atsInjVerifyCredential"]) {
    const src = String(ats[name]);
    assert.doesNotThrow(() => new Function("return (" + src + ")"), name + " does not parse standalone");
    for (const other of ["atsLib", "atsFd", "ATS_STATIC_MAPS", "atsRouteField", "atsInjSetText", "atsCredentialKind"]) {
      assert.ok(!src.includes(other), name + " references " + other + " (not self-contained)");
    }
    // the no-value contract, pinned at the source: neither may return el.value
    assert.ok(!/return\s*\{[^}]*\bvalue\s*:/.test(src), name + " returns a `value` key — it must return only a length/boolean");
    assert.ok(!/after\s*:\s*el\.value/.test(src), name + " returns el.value — that is how a password reaches the bundle");
  }
});
