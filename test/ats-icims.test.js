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
