// GENERIC form driver — the pure resolution layer, pinned against FIXTURES CAPTURED FROM REAL
// FORMS during the 2026-08-11/12 recon (docs/generic-filler-plan.md, dom-patterns 2026-08-11..12).
//
// Every test here names the form that earned it. These are regressions, not examples: each one
// failed at some point during the recon, and several encode a mistake this plan made first and
// measured its way out of (the heading rung, the exclusion rule, "native select ⇒ free options").
//
// ⚠ ALSO GUARDS THE BLAST RADIUS: the generic kind must never leak into the three supported ATS
// families or Workday. See "isolation" at the bottom.
const { test } = require("node:test");
const assert = require("node:assert");
const ats = require("../ats.js");
const fd = require("../fill-driver.js");

// ── identity durability ─────────────────────────────────────────────────────────────────
test("generic identity: real durable ids pass, real per-render ids are rejected", () => {
  const d = ats.atsGenericIdDurable;
  // Dayforce — semantic, and it even carries the repeating index, so entry scoping is free
  assert.ok(d("jobPostingApplication_personalInfo_email"));
  assert.ok(d("jobPostingApplication_educationHistory_0_degreeName"));
  // Paylocity / KEF / Greenhouse / Lever — clean names
  assert.ok(d("info.firstName"));
  assert.ok(d("public-site-address-city"));
  assert.ok(d("first-name"));
  assert.ok(d("cResume"));
  assert.ok(d("question_16203685008"));
  assert.ok(d("urls[LinkedIn]"));
  // Wix build ids survive a session (they change only on republish) — accepted, and a change just
  // fails to re-find the field, which is an honest needs_review rather than a wrong fill.
  assert.ok(d("collection_comp-lpjwscz6"));
  // ⚠ iCIMS — these regressed once. A case-TRANSITION ratio rejected `CandProfileFields` (5/17=0.29)
  // as random while accepting `QQUpFBNbEVDkaqRr` (6/16=0.375), and the live consequence was the whole
  // education section losing its ids and keying on `label:School#0`. The shape test (camel fragments
  // vs single-char debris) is what separates them.
  assert.ok(d("-1_CandProfileFields.School"));
  assert.ok(d("-1_CandProfileFields.EducationStartDate_Month"));
  assert.ok(d("-1_PersonProfileFields.AddressStreet1"));
  assert.ok(d("PortalProfileFields.Resume_File"));
  assert.ok(d("PersonProfileFields.Password_Confirm"));

  // Workable — regenerated on EVERY render, so it can never key a replay
  assert.ok(!d("input_files_input_QQUpFBNbEVDkaqRr"));
  // Dayforce/rc-select — a per-render SEQUENTIAL counter (and these two also share a duplicate
  // label, "Country dialing code", so they have neither a durable id nor a unique name)
  assert.ok(!d("rc_select_4"));
  assert.ok(!d("rc_select_5"));
  // Paylocity — opaque signed tokens on repeating-entry fields
  assert.ok(!d("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abcdef"));
  // degenerate
  assert.ok(!d("4128182"));
  assert.ok(!d(""));
  assert.ok(!d(null));
});

// ── required-ness: four mechanisms, and a form may use exactly one ──────────────────────
test("generic required: Paylocity marks it ONLY in the label text", () => {
  const r = ats.atsGenericRequiredFromLabel;
  assert.strictEqual(r("First Name (required)"), true);
  assert.strictEqual(r("Email Address (required)"), true);
  assert.strictEqual(r("Address Line 2(optional)"), false);
  // Workday/Greenhouse/Lever asterisks — and Lever's is MID-STRING, ahead of an inline error, so
  // an end-anchored test is not enough
  assert.strictEqual(r("AI Policy for Application*"), true);
  assert.strictEqual(r("Current location ✱No location found. Try entering a different"), true);
  // says nothing
  assert.strictEqual(r("Middle Name"), null);
  assert.strictEqual(r(""), null);
});

test("generic label cleaning: the required marker is stripped before it becomes a QUESTION", () => {
  const c = ats.atsGenericCleanLabel;
  // left in, these are carried into normalizeLabel and can never match a stored bucket wording
  assert.strictEqual(c("First Name (required)"), "First Name");
  assert.strictEqual(c("Address Line 2(optional)"), "Address Line 2");
  assert.strictEqual(c("AI Policy for Application*"), "AI Policy for Application");
  assert.strictEqual(c("Do you require visa sponsorship? *"), "Do you require visa sponsorship?");
  assert.strictEqual(c("Email:"), "Email");
  assert.strictEqual(c("  spaced   out  "), "spaced out");
});

// ── the label ladder, and the ORDER regression this plan created itself ─────────────────
test("generic labels: BREEZY — placeholder beats an ancestor section heading", () => {
  // Live: putting the heading rung ABOVE placeholder made four fields resolve to the SAME string,
  // "Personal Details", where placeholder was correct. This is that regression, pinned.
  const raw = {
    url: "https://victory.breezy.hr/p/x/apply", title: "Staff Software Engineer",
    fields: [
      { attrId: "cName", inputSel: "#cName", widgetType: "text", domIndex: 0,
        labelCandidates: { placeholder: "Full Name", heading: "Personal Details" } },
      { attrId: "cEmail", inputSel: "#cEmail", widgetType: "text", domIndex: 1,
        labelCandidates: { placeholder: "Email Address", heading: "Personal Details" } },
      { attrId: "cPhoneNumber", inputSel: "#cPhoneNumber", widgetType: "text", domIndex: 2,
        labelCandidates: { placeholder: "Phone Number", heading: "Personal Details" } },
      { attrId: "cAddress", inputSel: "#cAddress", widgetType: "text", domIndex: 3,
        labelCandidates: { placeholder: "Address", heading: "Personal Details" } },
    ],
  };
  const s = ats.atsGenericPostProcess(raw);
  assert.deepStrictEqual(s.fields.map((f) => f.label), ["Full Name", "Email Address", "Phone Number", "Address"]);
  assert.ok(s.fields.every((f) => f.labelVia === "placeholder"));
});

test("generic labels: BREEZY — a radio group DOES take its heading (no placeholder to fall back on)", () => {
  // …and the rung exists precisely for this: without it, race_ethnicity resolved to its FIRST
  // OPTION's label, "White (not Hispanic or Latino)", on a REQUIRED demographic.
  const raw = {
    fields: [
      { attrId: "race_ethnicity", inputSel: 'input[name="race_ethnicity"]', widgetType: "radio", domIndex: 0,
        reqAttr: true, options: ["White (not Hispanic or Latino)", "Asian (not Hispanic or Latino)", "I don't wish to answer"],
        labelCandidates: { heading: "Race or Ethnicity" } },
      { attrId: "gender", inputSel: 'input[name="gender"]', widgetType: "radio", domIndex: 1,
        reqAttr: true, options: ["Male", "Female", "I don't wish to answer"],
        labelCandidates: { heading: "Gender" } },
    ],
  };
  const s = ats.atsGenericPostProcess(raw);
  assert.strictEqual(s.fields[0].label, "Race or Ethnicity");
  assert.strictEqual(s.fields[0].labelVia, "heading");
  assert.strictEqual(s.fields[1].label, "Gender");
  // the option list survives so review can render a real picker
  assert.strictEqual(s.fields[0].options.length, 3);
  assert.ok(s.fields.every((f) => f.isRequired));
});

test("generic labels: a heading claimed by 2+ fields is a SECTION heading and is refused", () => {
  const raw = {
    fields: [
      { attrId: "cSummaryOne", inputSel: "#one", widgetType: "text", domIndex: 0, labelCandidates: { heading: "Experience" } },
      { attrId: "cSummaryTwo", inputSel: "#two", widgetType: "text", domIndex: 1, labelCandidates: { heading: "Experience" } },
      { attrId: "cGpaValue", inputSel: "#gpa", widgetType: "text", domIndex: 2, labelCandidates: { heading: "GPA" } },
    ],
  };
  const s = ats.atsGenericPostProcess(raw);
  // refused → no label at all, so the field keeps its DURABLE id as identity and the id stands in
  // as the display label. It reaches review unlabelled-but-addressable rather than mislabelled.
  assert.strictEqual(s.fields[0].labelVia, "none");
  assert.strictEqual(s.fields[0].fieldName, "cSummaryOne");
  assert.strictEqual(s.fields[0].identityFrom, "attr");
  assert.strictEqual(s.fields[0].label, "cSummaryOne");
  assert.strictEqual(s.fields[2].label, "GPA");          // unique heading is kept
  assert.strictEqual(s.fields[2].labelVia, "heading");
});

test("generic labels: the full rung order is honoured", () => {
  const raw = {
    fields: [
      { attrId: "x", inputSel: "#x", widgetType: "text", domIndex: 0,
        labelCandidates: { ariaLabel: "A", ariaLabelledby: "B", labelFor: "C", labelWrap: "D", unitLabel: "E", placeholder: "F", heading: "G" } },
      { attrId: "y", inputSel: "#y", widgetType: "text", domIndex: 1,
        labelCandidates: { labelFor: "C", unitLabel: "E", placeholder: "F" } },
      { attrId: "z", inputSel: "#z", widgetType: "checkbox", domIndex: 2,
        labelCandidates: { adjacentText: "By providing your phone number you agree…" } },
    ],
  };
  const s = ats.atsGenericPostProcess(raw);
  assert.strictEqual(s.fields[0].labelVia, "ariaLabel");
  assert.strictEqual(s.fields[1].labelVia, "labelFor");
  // the consent-checkbox rung: BOTH the DOM ladder and Chrome's AX tree fail to name Breezy's
  // smsConsent box — its text is a sibling, not a label
  assert.strictEqual(s.fields[2].labelVia, "adjacentText");
});

// ── identity fallback + the duplicate-label problem ─────────────────────────────────────
test("generic identity: DAYFORCE — duplicate labels + non-durable ids get an ORDINAL", () => {
  // The two dialing-code selects have NEITHER a durable id (rc_select_4/5) NOR a unique label
  // ("Country dialing code" ×2) — the worst case on any form in the corpus.
  const raw = {
    fields: [
      { attrId: "rc_select_4", inputSel: "#rc_select_4", widgetType: "select", domIndex: 0,
        labelCandidates: { ariaLabel: "Country dialing code" } },
      { attrId: "rc_select_5", inputSel: "#rc_select_5", widgetType: "select", domIndex: 1,
        labelCandidates: { ariaLabel: "Country dialing code" } },
      { attrId: "jobPostingApplication_personalInfo_email", inputSel: "#e", widgetType: "text", domIndex: 2,
        labelCandidates: { labelFor: "Email Address" }, reqAttr: true },
    ],
  };
  const s = ats.atsGenericPostProcess(raw);
  assert.strictEqual(s.fields[0].fieldName, "label:Country dialing code#0");
  assert.strictEqual(s.fields[1].fieldName, "label:Country dialing code#1");
  assert.strictEqual(s.fields[0].identityFrom, "label");
  // a durable id is used as-is and never ordinal-suffixed
  assert.strictEqual(s.fields[2].fieldName, "jobPostingApplication_personalInfo_email");
  assert.strictEqual(s.fields[2].identityFrom, "attr");
  assert.deepStrictEqual(s.diag.duplicateLabels, ["country dialing code"]);
  assert.strictEqual(s.diag.nonDurableIds, 2);
});

test("generic identity: a UNIQUE label is NOT ordinal-suffixed (it must key stably across visits)", () => {
  const raw = { fields: [{ attrId: "rc_select_9", inputSel: "#rc_select_9", widgetType: "select", domIndex: 0, labelCandidates: { ariaLabel: "Highest degree" } }] };
  const s = ats.atsGenericPostProcess(raw);
  assert.strictEqual(s.fields[0].fieldName, "label:Highest degree");
});

test("generic identity: no durable id AND no label ⇒ unidentified, reported, never fillable", () => {
  const raw = { fields: [{ attrId: null, inputSel: '[data-apg="g3"]', widgetType: "text", domIndex: 3, labelCandidates: {} }] };
  const s = ats.atsGenericPostProcess(raw);
  assert.strictEqual(s.fields[0].unidentified, true);
  assert.strictEqual(s.fields[0].identityFrom, "none");
  assert.match(s.fields[0].fieldName, /^unidentified#/);
});

// ── required: the merge, and the "no signal anywhere" state ─────────────────────────────
test("generic required: PAYLOCITY — label text is the only signal, and it must win", () => {
  const raw = {
    fields: [
      { attrId: "info.firstName", inputSel: "#fn", widgetType: "text", domIndex: 0,
        reqAttr: false, reqMarker: false, labelCandidates: { unitLabel: "First Name (required)" } },
      { attrId: "info.middleName", inputSel: "#mn", widgetType: "text", domIndex: 1,
        reqAttr: false, reqMarker: false, labelCandidates: { unitLabel: "Middle Name" } },
    ],
  };
  const s = ats.atsGenericPostProcess(raw);
  assert.strictEqual(s.fields[0].isRequired, true);
  assert.strictEqual(s.fields[0].reqVia, "label-text");
  assert.strictEqual(s.fields[0].label, "First Name");   // marker stripped from the question
  assert.strictEqual(s.fields[1].isRequired, false);
  assert.strictEqual(s.diag.noRequiredSignalAnywhere, false);
});

test("generic required: KEF — a form with NO required signal is REPORTED, not read as 'none required'", () => {
  // Only `email` was marked on the real form; here nothing is, which is the state that must be
  // surfaced rather than silently trusted (under-flagging is the dangerous direction).
  const raw = {
    fields: [
      { attrId: "first-name", inputSel: "#f", widgetType: "text", domIndex: 0, labelCandidates: { labelFor: "First name" } },
      { attrId: "last-name", inputSel: "#l", widgetType: "text", domIndex: 1, labelCandidates: { labelFor: "Last name" } },
    ],
  };
  const s = ats.atsGenericPostProcess(raw);
  assert.strictEqual(s.diag.noRequiredSignalAnywhere, true);
});

test("generic required: ANY mechanism saying required wins (over-flag is the safe direction)", () => {
  const mk = (over) => ats.atsGenericPostProcess({ fields: [Object.assign({ attrId: "q", inputSel: "#q", widgetType: "text", domIndex: 0, labelCandidates: { labelFor: "Q" } }, over)] }).fields[0].isRequired;
  assert.strictEqual(mk({ reqAttr: true }), true);
  assert.strictEqual(mk({ reqMarker: true }), true);
  assert.strictEqual(mk({ labelCandidates: { labelFor: "Q (required)" } }), true);
  assert.strictEqual(mk({}), false);
});

// ── label confidence: a MIS-ASSIGNED label is not merely a polluted one ────────────────
test("generic labels: PAYLOCITY — a label taken from a shared unit is flagged low-confidence", () => {
  // Live, `info.maximumDesiredSalary` resolved to a NEIGHBOURING field's label, "Desired Salary
  // Type". It looks perfectly plausible and is wrong, so it must be reviewable rather than trusted.
  const raw = {
    fields: [{ attrId: "info.maximumDesiredSalary", inputSel: "#mx", widgetType: "text", domIndex: 0,
      labelShared: true, labelCandidates: { unitLabel: "Desired Salary Type" } }],
  };
  const s = ats.atsGenericPostProcess(raw);
  assert.strictEqual(s.fields[0].labelLowConfidence, true);
});

// ── native-select options: "free" is FALSE when the list is a placeholder ───────────────
test("generic options: a placeholder-only native select carries NO options (KEF)", () => {
  // KEF Robotics' "Are you a US Citizen?" is a real <select> holding exactly ["Choose an option"],
  // unchanged after 4s. mustOpen is decided from the list's CONTENTS, never the tag name.
  const raw = {
    fields: [
      { attrId: "collection_comp-lpjwscz6", inputSel: "#c", widgetType: "dropdown_native", domIndex: 0,
        options: [], optionsPlaceholderOnly: true, labelCandidates: { labelFor: "Are you a US Citizen?" } },
      { attrId: "real", inputSel: "#r", widgetType: "dropdown_native", domIndex: 1,
        options: ["Yes", "No"], optionsPlaceholderOnly: false, labelCandidates: { labelFor: "Authorized?" } },
    ],
  };
  const s = ats.atsGenericPostProcess(raw);
  assert.strictEqual(s.fields[0].options, null);
  assert.strictEqual(s.fields[0].optionsPlaceholderOnly, true);
  assert.deepStrictEqual(s.fields[1].options, ["Yes", "No"]);
});

// ── the exclusion set is REPORTED, never silently dropped ──────────────────────────────
test("generic scan: excluded controls are carried through to the caller", () => {
  const s = ats.atsGenericPostProcess({
    excluded: [{ id: "hp_7f2b", why: "tabindex-1", cls: "" }, { id: "", why: "aria-hidden+opacity0", cls: "requiredInput" }],
    fields: [],
  });
  assert.strictEqual(s.excluded.length, 2);
  assert.strictEqual(s.excluded[0].id, "hp_7f2b");   // Breezy's honeypot
});

// ── the injected scanner must be SELF-CONTAINED (same rule as every other injected fn) ──
test("atsInjScanGeneric: stringifies without closure references", () => {
  const src = ats.atsInjScanGeneric.toString();
  // it may only reach for page globals + its own locals
  for (const forbidden of ["atsLib", "atsFd", "ATS_POLL", "atsGenericIdDurable", "atsGenericCleanLabel", "require("]) {
    assert.ok(!src.includes(forbidden), "injected scanner must not reference " + forbidden);
  }
  // and it must actually be a function body we can hand to Runtime.evaluate
  assert.ok(/^function atsInjScanGeneric\(\)/.test(src));
});

// ── the review picker ───────────────────────────────────────────────────────────────────
test("atsCaptureChoiceOptions: opens an unfilled combobox, attaches options, CONFIRMS the close", () => {
  // Operator requirement: a reconnable dropdown must show up in review. A field the fill filled had
  // its options read at commit time and a deferred field had them read by the defer pass — the gap
  // is a choice field we neither filled nor deferred.
  const calls = [];
  const act = {
    eval: async (fn, sel, force) => {
      const n = fn && fn.name;
      calls.push(n + ":" + sel);
      if (n === "atsInjOpenAndReadOptions") return { ok: true };
      if (n === "atsInjReadOptions") {
        // after a close, report shut; before it, report the list
        const closed = calls.some((c) => c.startsWith("atsInjCloseCombo:"));
        return closed ? { open: false, options: [] } : { open: true, options: [{ text: "Yes" }, { text: "No" }] };
      }
      if (n === "atsInjCloseCombo") return { ok: true };
      return { ok: true };
    },
    delayFull: async () => {},
  };
  const scan = { fields: [{ fieldName: "label:Sponsorship", inputSel: "#s", widgetType: "select", label: "Do you require sponsorship?" }] };
  const results = [{ fieldName: "label:Sponsorship", status: "skipped" }];
  return ats.atsCaptureChoiceOptions(act, "generic", scan, results).then((r) => {
    assert.strictEqual(r.captured, 1);
    assert.deepStrictEqual(results[0].options, ["Yes", "No"]);
    // the close is not optional: a menu left mounted swallows the next widget's open-click
    assert.ok(calls.some((c) => c.startsWith("atsInjCloseCombo:")), "must close the menu it opened");
  });
});

test("atsCaptureChoiceOptions: a placeholder-only NATIVE select is re-read live (the KEF gap)", async () => {
  // Found on the first real run: the citizenship <select> was placeholder-only at scan time, so the
  // scan claimed no vocabulary, the capture pass skipped it as "not a combobox", and review got NO
  // picker — the operator's requirement, missed. It is now re-read from the live page.
  let reads = 0;
  const act = { delayFull: async () => {},
    eval: async (fn, sel) => {
      if (fn.name === "atsInjReadNativeOptions") { reads++; return { ok: true, options: ["Yes", "No"], placeholder: null, total: 3 }; }
      throw new Error("unexpected eval " + fn.name);
    } };
  const scan = { fields: [{ fieldName: "cit", inputSel: "#cit", widgetType: "dropdown_native", label: "Are you a US Citizen?", options: null }] };
  const results = [{ fieldName: "cit", status: "skipped" }];
  const r = await ats.atsCaptureChoiceOptions(act, "generic", scan, results);
  assert.strictEqual(reads, 1, "it must re-read the live select");
  assert.strictEqual(r.captured, 1);
  assert.deepStrictEqual(results[0].options, ["Yes", "No"]);
});

test("atsCaptureChoiceOptions: a native select that is STILL empty explains itself, never sits silent", async () => {
  const act = { delayFull: async () => {},
    eval: async (fn) => (fn.name === "atsInjReadNativeOptions"
      ? { ok: true, options: [], placeholder: "Choose an option", total: 1 }
      : (() => { throw new Error("unexpected"); })()) };
  const scan = { fields: [{ fieldName: "cit", inputSel: "#cit", widgetType: "dropdown_native", label: "Are you a US Citizen?", options: null }] };
  const results = [{ fieldName: "cit", status: "skipped" }];
  const r = await ats.atsCaptureChoiceOptions(act, "generic", scan, results);
  assert.strictEqual(r.captured, 0);
  assert.strictEqual(r.skipped, 1);
  assert.strictEqual(results[0].flag, "options-never-rendered");
  assert.match(results[0].detail, /offers no options/);
  assert.match(results[0].detail, /Choose an option/);
});

test("atsInjReadNativeOptions: strips the placeholder and reports it when nothing real remains", () => {
  const src = ats.atsInjReadNativeOptions.toString();
  assert.doesNotThrow(() => new Function("return (" + src + ")"), "must parse standalone");
  for (const other of ["atsLib", "atsFd", "atsGenericCleanLabel"]) assert.ok(!src.includes(other));
});

test("atsCaptureChoiceOptions: a server-ranked widget is SKIPPED (it can never BE the picker)", () => {
  const act = { eval: async () => { throw new Error("must not open a location widget"); }, delayFull: async () => {} };
  const scan = { fields: [{ fieldName: "label:Where are you based?", inputSel: "#l", widgetType: "select", label: "Where are you currently based?" }] };
  const results = [{ fieldName: "label:Where are you based?", status: "skipped" }];
  return ats.atsCaptureChoiceOptions(act, "generic", scan, results).then((r) => {
    assert.strictEqual(r.captured, 0);
    assert.strictEqual(r.skipped, 1);
    assert.ok(!results[0].options);
  });
});

test("atsCaptureChoiceOptions: never re-reads a field that already carries options", () => {
  const act = { eval: async () => { throw new Error("must not open an already-populated field"); }, delayFull: async () => {} };
  const scan = { fields: [{ fieldName: "q", inputSel: "#q", widgetType: "select", label: "Q" }] };
  const results = [{ fieldName: "q", status: "needs_review", options: ["A", "B"] }];
  return ats.atsCaptureChoiceOptions(act, "generic", scan, results).then((r) => assert.strictEqual(r.captured, 0));
});

test("atsCaptureChoiceOptions: a radio/native list is attached from the SCAN, with no open at all", () => {
  const act = { eval: async () => { throw new Error("must not open a scan-known widget"); }, delayFull: async () => {} };
  const scan = { fields: [{ fieldName: "g", inputSel: 'input[name="g"]', widgetType: "radio", label: "G", options: ["A", "B"] }] };
  const results = [{ fieldName: "g", status: "skipped" }];
  return ats.atsCaptureChoiceOptions(act, "generic", scan, results).then((r) => {
    assert.strictEqual(r.captured, 1);
    assert.deepStrictEqual(results[0].options, ["A", "B"]);
  });
});

// ── the résumé: no static map exists for a generic form, so it is recognized ────────────
test("generic résumé: recognized from the widget + label, and NEVER from a neighbour slot", () => {
  const route = (f) => ats.atsRouteField("generic", f, {}, {}, {}, null);
  // KEF Robotics ("Upload Resume"), Lever-style ("Resume/CV"), a bare "Attach"
  assert.strictEqual(route({ widgetType: "file_upload", fieldName: "fileInputcomp-x", label: "Upload Resume" }).kind, "resume");
  assert.strictEqual(route({ widgetType: "file_upload", fieldName: "cResume", label: "" }).kind, "resume");
  assert.strictEqual(route({ widgetType: "file_upload", fieldName: "f1", label: "Resume/CV" }).kind, "resume");
  // the slots a form puts NEXT to it must never receive the résumé
  for (const l of ["Cover Letter", "Upload Cover Letter", "Transcript", "Portfolio", "Writing sample", "References"]) {
    assert.strictEqual(route({ widgetType: "file_upload", fieldName: "x", label: l }).kind, "skip", l + " must not be the résumé");
  }
});

test("generic résumé: an UNLABELLED file input is the résumé only when it is the form's only one", () => {
  const route = (f) => ats.atsRouteField("generic", f, {}, {}, {}, null);
  assert.strictEqual(route({ widgetType: "file_upload", fieldName: "u1", label: "", soleFileInput: true }).kind, "resume");
  // several unlabelled slots ⇒ not decidable ⇒ left for the operator rather than guessed
  assert.strictEqual(route({ widgetType: "file_upload", fieldName: "u1", label: "" }).kind, "skip");
});

test("generic résumé: postProcess marks soleFileInput only when there is exactly one", () => {
  const one = ats.atsGenericPostProcess({ fields: [
    { attrId: "cResume", inputSel: "#r", widgetType: "file_upload", domIndex: 0, labelCandidates: {} },
    { attrId: "cName", inputSel: "#n", widgetType: "text", domIndex: 1, labelCandidates: { placeholder: "Full Name" } },
  ] });
  assert.strictEqual(one.fields[0].soleFileInput, true);
  assert.strictEqual(one.diag.fileInputs, 1);
  const two = ats.atsGenericPostProcess({ fields: [
    { attrId: "fileA", inputSel: "#a", widgetType: "file_upload", domIndex: 0, labelCandidates: {} },
    { attrId: "fileB", inputSel: "#b", widgetType: "file_upload", domIndex: 1, labelCandidates: {} },
  ] });
  assert.ok(!two.fields[0].soleFileInput);
  assert.ok(!two.fields[1].soleFileInput);
  assert.strictEqual(two.diag.fileInputs, 2);
});

test("isolation: the résumé recognizer does NOT fire for the supported families", () => {
  // they name their resume field in ATS_STATIC_MAPS, and that map is checked FIRST — this guard is
  // here so the generic recognizer can never start claiming their file inputs.
  for (const kind of ["greenhouse", "lever", "ashby"]) {
    const r = ats.atsRouteField(kind, { widgetType: "file_upload", fieldName: "some_unmapped_file", label: "Transcript" }, {}, {}, {}, null);
    assert.ok(!r || r.source !== "generic", kind + " must not use the generic recognizer");
  }
});

// ── the submit gate: a WIZARD's "Next Step" is not a submit ─────────────────────────────
test("generic submit: a multi-step page is a FORM but has NO submit control", () => {
  // Paylocity's primary button is literally "Next Step" (44 fields, multi-page). Detection must
  // accept the page as an application form; the submit GATE must still refuse to click.
  const fields = [{ fieldName: "info.email", label: "Email Address (required)", widgetType: "text" }];
  const wizard = ats.atsLooksLikeApplicationForm(fields, { hasSubmit: false, multiStep: true });
  assert.strictEqual(wizard.ok, true, "a wizard page IS an application form");
  assert.strictEqual(wizard.hasSubmit, false, "…but it offers nothing to submit");
  assert.strictEqual(wizard.multiStep, true);
  // and a page with neither is refused
  const neither = ats.atsLooksLikeApplicationForm(fields, { hasSubmit: false, multiStep: false });
  assert.strictEqual(neither.ok, false);
  // a real submit still passes exactly as before (the three supported families' path)
  const real = ats.atsLooksLikeApplicationForm(fields, { hasSubmit: true });
  assert.strictEqual(real.ok, true);
  assert.strictEqual(real.multiStep, false);
});

test("isolation: atsLooksLikeApplicationForm still REFUSES page chrome (Crown / Dayforce JD pages)", () => {
  // Crown's only two <form> tags held nothing but search/alert controls; the Dayforce JD page's only
  // controls were cookie-banner checkboxes + a language picker. Both must stay refused.
  const chrome1 = [{ fieldName: "q", label: "Search by Keyword", widgetType: "text" },
                   { fieldName: "locationsearch", label: "Search by Location", widgetType: "text" },
                   { fieldName: "frequency", label: "Select how often (in days) to receive an alert", widgetType: "text" }];
  assert.strictEqual(ats.atsLooksLikeApplicationForm(chrome1, { hasSubmit: true }).ok, false);
  const chrome2 = [{ fieldName: "lang-select", label: "English (United States)", widgetType: "text" }];
  assert.strictEqual(ats.atsLooksLikeApplicationForm(chrome2, { hasSubmit: true, multiStep: true }).ok, false);
});

// ── END-TO-END against a REAL captured scan ─────────────────────────────────────────────
// This raw object is the VERBATIM output of atsInjScanGeneric run against the live
// https://www.kefrobotics.com/careers/gnc form on 2026-08-12 (a custom Wix employer page — the pure
// long-tail case). It is the closest thing to an integration test the resolution layer can have.
const KEF_LIVE_SCAN = {
  ats: "generic", url: "https://www.kefrobotics.com/careers/gnc", title: "GNC | KEF Robotics",
  usedFormTag: true, excluded: [], submitState: { hasSubmit: true, texts: ["Upload Resume", "Submit"] },
  fields: [
    { attrId: "first-name", domIndex: 0, inputSel: 'input[name="first-name"]', widgetType: "text", reqAttr: false, reqMarker: false, labelShared: false, options: null, value: null,
      labelCandidates: { heading: "GNC Engineer, Slam focus", labelFor: "First name", unitLabel: "First name" } },
    { attrId: "last-name", domIndex: 1, inputSel: 'input[name="last-name"]', widgetType: "text", reqAttr: false, reqMarker: false, labelShared: false, options: null, value: null,
      labelCandidates: { heading: "GNC Engineer, Slam focus", labelFor: "Last name", unitLabel: "Last name" } },
    { attrId: "email", domIndex: 2, inputSel: 'input[name="email"]', widgetType: "text", reqAttr: true, reqMarker: false, labelShared: false, options: null, value: null,
      labelCandidates: { heading: "GNC Engineer, Slam focus", labelFor: "Email", unitLabel: "Email" } },
    { attrId: "collection_comp-lpjwscz6", domIndex: 3, inputSel: "#collection_comp-lpjwscz6", widgetType: "dropdown_native", reqAttr: false, reqMarker: false, labelShared: false, options: [], optionsPlaceholderOnly: true, value: null,
      labelCandidates: { heading: "GNC Engineer, Slam focus", labelFor: "Are you a US Citizen?", unitLabel: "Are you a US Citizen?" } },
    { attrId: "textarea_comp-lpjwyoei", domIndex: 4, inputSel: "#textarea_comp-lpjwyoei", widgetType: "textarea", reqAttr: false, reqMarker: false, labelShared: false, options: null, value: null,
      labelCandidates: { heading: "GNC Engineer, Slam focus", labelFor: "How many years of experience do you have with GNC/SLAM?", placeholder: "Add answer here", unitLabel: "How many years of experience do you have with GNC/SLAM?" } },
    { attrId: "textarea_comp-lpjwpit22", domIndex: 5, inputSel: "#textarea_comp-lpjwpit22", widgetType: "textarea", reqAttr: false, reqMarker: false, labelShared: false, options: null, value: null,
      labelCandidates: { heading: "GNC Engineer, Slam focus", labelFor: "Optional cover letter", unitLabel: "Optional cover letter" } },
    { attrId: "fileInputcomp-lpjx9isk", domIndex: 6, inputSel: "#fileInputcomp-lpjx9isk", widgetType: "file_upload", reqAttr: false, reqMarker: false, labelShared: false, options: null, value: null,
      labelCandidates: { adjacentText: "Upload Resume Upload supported file (Max 15MB)", heading: "GNC Engineer, Slam focus", unitLabel: "Upload Resume" } },
  ],
};

test("LIVE KEF Robotics: the captured scan resolves to the right 7 fields", () => {
  const s = ats.atsGenericPostProcess(KEF_LIVE_SCAN);
  assert.strictEqual(s.fields.length, 7);
  assert.deepStrictEqual(s.fields.map((f) => f.label), [
    "First name", "Last name", "Email", "Are you a US Citizen?",
    "How many years of experience do you have with GNC/SLAM?", "Optional cover letter", "Upload Resume",
  ]);
  assert.deepStrictEqual(s.fields.map((f) => f.widgetType), [
    "text", "text", "text", "dropdown_native", "textarea", "textarea", "file_upload",
  ]);
  // ⚠ the page's ONE <h1> ("GNC Engineer, Slam focus") is a candidate for all 7 fields, so the
  // section-heading guard must refuse it for every one of them
  assert.ok(!s.fields.some((f) => /GNC Engineer/.test(f.label)), "the job title must never become a field label");
  assert.ok(s.fields.every((f) => f.labelVia === "labelFor" || f.labelVia === "unitLabel"));
});

test("LIVE KEF Robotics: only `email` is required, and that is REPORTED not trusted as 'the rest are optional'", () => {
  const s = ats.atsGenericPostProcess(KEF_LIVE_SCAN);
  assert.deepStrictEqual(s.fields.filter((f) => f.isRequired).map((f) => f.fieldName), ["email"]);
  // the citizenship question is plainly required in practice but enforced in JS only — the form does
  // carry SOME signal (email), so this is not the noRequiredSignalAnywhere state
  assert.strictEqual(s.diag.noRequiredSignalAnywhere, false);
});

test("LIVE KEF Robotics: the lazy native select is placeholder-only ⇒ no vocabulary claimed", () => {
  const s = ats.atsGenericPostProcess(KEF_LIVE_SCAN);
  const cit = s.fields.find((f) => f.fieldName === "collection_comp-lpjwscz6");
  assert.strictEqual(cit.options, null);
  assert.strictEqual(cit.optionsPlaceholderOnly, true);
});

test("LIVE KEF Robotics: identified as an application form, and its résumé slot routes", () => {
  const s = ats.atsGenericPostProcess(KEF_LIVE_SCAN);
  const id = ats.atsLooksLikeApplicationForm(s.fields, KEF_LIVE_SCAN.submitState);
  assert.strictEqual(id.ok, true);
  assert.ok(id.hasResume && id.hasEmail && id.hasName);
  assert.strictEqual(s.diag.fileInputs, 1);
  const file = s.fields.find((f) => f.widgetType === "file_upload");
  assert.strictEqual(ats.atsRouteField("generic", file, {}, {}, {}, null).kind, "resume");
  // every id on this form is durable, so identity never falls back to a label here
  assert.strictEqual(s.diag.nonDurableIds, 0);
  assert.ok(s.fields.every((f) => f.identityFrom === "attr"));
});

// ── three bugs found by running the scanner against the LIVE Paylocity form (2026-08-12) ──
test("LIVE Paylocity: a radio group must not take an OPTION's text from unitLabel either", () => {
  // Found live: `info.howDidYouHearAboutUs` resolved to "Advertisement-Print" — its first option —
  // because the field UNIT contains the option labels. Dropping labelFor/labelWrap was not enough.
  // The scanner now recomputes a group's unit label (legend first, else a non-member label), so by
  // the time the resolver sees it the option text is gone. This pins the resolver end of that: an
  // option-looking unitLabel is all the group has, and the ordinal/identity path must still hold.
  const s = ats.atsGenericPostProcess({
    fields: [{ attrId: "info.howDidYouHearAboutUs", inputSel: 'input[name="info.howDidYouHearAboutUs"]',
      widgetType: "radio", domIndex: 0, options: ["Advertisement-Print", "Employee Referral", "Job Board"],
      labelCandidates: { unitLabel: "How did you hear about us?" } }],
  });
  assert.strictEqual(s.fields[0].label, "How did you hear about us?");
  assert.deepStrictEqual(s.fields[0].options, ["Advertisement-Print", "Employee Referral", "Job Board"]);
});

test("LIVE Paylocity: only ONE résumé slot is primary when a form offers two upload routes", () => {
  // btn-forceResume ("Apply with resume") and btn-resume ("Fill out application with my resume") both
  // match the résumé wording. Attaching to both would upload twice and can start two server parses.
  const s = ats.atsGenericPostProcess({
    fields: [
      { attrId: "btn-forceResume", inputSel: "#btn-forceResume", widgetType: "file_upload", domIndex: 0,
        labelCandidates: { adjacentText: "Upload Resume" } },
      { attrId: "btn-resume", inputSel: "#btn-resume", widgetType: "file_upload", domIndex: 1,
        labelCandidates: { unitLabel: "Fill out application with my resume" } },
      { attrId: "btn-coverLetter", inputSel: "#btn-coverLetter", widgetType: "file_upload", domIndex: 2,
        labelCandidates: { unitLabel: "Upload Cover Letter" } },
    ],
  });
  assert.strictEqual(s.diag.fileInputs, 3);
  assert.strictEqual(s.diag.resumeSlots, 2, "the cover letter must not count as a résumé slot");
  assert.strictEqual(s.fields[0].primaryResumeSlot, true);
  assert.strictEqual(s.fields[1].primaryResumeSlot, false);
  const route = (f) => ats.atsRouteField("generic", f, {}, {}, {}, null);
  assert.strictEqual(route(s.fields[0]).kind, "resume");
  assert.strictEqual(route(s.fields[1]).kind, "skip", "the second upload route must not also receive it");
  assert.strictEqual(route(s.fields[2]).kind, "skip", "the cover letter must never receive the résumé");
});

test("LIVE Paylocity: required comes from the label for 10+ fields that carry NO attribute", () => {
  // Measured live: only the `public-site-address-*` fields set aria-required. Everything else marks
  // it as literal "(required)" text — so the label rung is carrying most of this form.
  const mk = (id, label, reqAttr) => ({ attrId: id, inputSel: "#" + id, widgetType: "text", domIndex: 0, reqAttr: !!reqAttr, labelCandidates: { unitLabel: label } });
  const s = ats.atsGenericPostProcess({ fields: [
    mk("info.firstName", "First Name (required)"), mk("info.lastName", "Last Name (required)"),
    mk("info.email", "Email Address (required)"), mk("info.cellPhone", "Mobile Number (required)"),
    mk("info.referredBy", "Referred by (required)"), mk("info.middleName", "Middle Name"),
    mk("public-site-address-city", "City", true),
  ] });
  const req = s.fields.filter((f) => f.isRequired).map((f) => f.fieldName);
  assert.strictEqual(req.length, 6);
  assert.ok(req.includes("info.firstName") && req.includes("info.referredBy"));
  assert.ok(!req.includes("info.middleName"));
  // and the marker is gone from every question
  assert.ok(!s.fields.some((f) => /required/i.test(f.label)), "no question may still carry '(required)'");
  // the label-text rung is what did the work for five of them
  assert.strictEqual(s.fields.filter((f) => f.reqVia === "label-text").length, 5);
  assert.strictEqual(s.fields.find((f) => f.fieldName === "public-site-address-city").reqVia, "attr");
});

test("LIVE Paylocity: the scanner strips NESTED labels, and finds a group's label[for=<name>]", () => {
  // Both earned live. The question label WRAPS its own option labels, so a plain textContent read gave
  // "How did you hear about us?(optional)Advertisement-PrintCollege-Recruiting Event…". And the
  // question is a label[for="info.howDidYouHearAboutUs"] — pointing at the group's shared NAME, not
  // at any input id — which is the only place it exists on that form.
  const src = ats.atsInjScanGeneric.toString();
  assert.ok(/label,legend,/.test(src), "nested label/legend must be in the filtered-read DROP list");
  assert.ok(/label\[for="' \+ esc\(first\.name\)/.test(src), "a group must look up label[for=<group name>]");
  // the ladder order for a group: legend, then label[for=name], then a non-option label
  const i = src.indexOf('querySelector("legend")');
  const j = src.indexOf("esc(first.name)");
  assert.ok(i > 0 && j > i, "legend must be tried before label[for=<name>]");
});

test("LIVE Paylocity: the resolved group question is clean and its (optional) marker is read", () => {
  // what the live scanner now hands the resolver, verbatim
  const s = ats.atsGenericPostProcess({
    fields: [{ attrId: "info.howDidYouHearAboutUs", inputSel: 'input[name="info.howDidYouHearAboutUs"]',
      widgetType: "radio", domIndex: 0, options: ["Advertisement-Print", "Employee Referral", "Other"],
      labelCandidates: { unitLabel: "How did you hear about us?(optional)" } }],
  });
  assert.strictEqual(s.fields[0].label, "How did you hear about us?");
  assert.strictEqual(s.fields[0].isRequired, false, "(optional) must be read as NOT required");
  assert.ok(!/Advertisement/.test(s.fields[0].label), "no option text may survive in the question");
});

test("LIVE Paylocity: 'Next Step' is reported as multiStep, never as a submit", () => {
  // the scanner's own submitState must use the SAME split as atsInjSubmitState
  const src = ats.atsInjScanGeneric.toString();
  assert.ok(/multiStep:/.test(src), "the generic scanner must report multiStep");
  // and the shared judgement accepts the page as a form while refusing to call it submittable
  const fields = [{ fieldName: "info.email", label: "Email Address", widgetType: "text" }];
  const id = ats.atsLooksLikeApplicationForm(fields, { hasSubmit: false, multiStep: true });
  assert.strictEqual(id.ok, true);
  assert.strictEqual(id.hasSubmit, false);
});

// ── INTEGRATION: drive the real fill loop over the LIVE-captured KEF form ───────────────
// Same fake-actuation pattern test/ats.test.js uses for Greenhouse, but through the GENERIC path:
// atsInjScanGeneric → atsGenericPostProcess → routing → actuation → the review picker. This is what
// exercises `driveAtsPageFill` end to end without a browser.
const GENERIC_PROFILE = {
  personal_info: { first_name: "Kevin", last_name: "Wang", email: "kevin@example.com", phone_number: "+1 555 010 2030",
    city: "Los Angeles", state: "CA", country: "United States" },
  work_authorization: { authorized_to_work_in_us: true, requires_sponsorship_now: false, requires_sponsorship_future: false },
};

// ⚠ A GENERIC form has NO static field map, so the identity fields reach the profile through the
// BUCKET tier — which is the DESIGNED path, not a gap: the operator ruled that identity aliases must
// live in operator-visible bucket wordings rather than hidden backend regexes (2026-07-31), and the
// website seeds one bucket per profile field in `ensureDefaultFieldWordings`. The first live run
// confirmed it: every identity field logged `filled · bucket`.
//
// The consequence worth knowing: on a generic form, bucket coverage is what decides whether a field
// fills deterministically — and a REQUIRED field with no wording goes to the AI instead. Supplying
// realistic buckets here is therefore reproducing production, not papering over anything.
const GENERIC_BUCKETS = [
  { id: "b1", profile_path: "personal_info.first_name", questions: ["First Name"] },
  { id: "b2", profile_path: "personal_info.last_name", questions: ["Last Name"] },
  { id: "b3", profile_path: "personal_info.email", questions: ["Email", "Email Address"] },
];

function genericFakeAct(page) {
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

test("INTEGRATION (generic, live KEF scan): text fills verified, résumé attaches, dropdown reaches review WITH a picker", async () => {
  const values = {};
  let resumeAttached = 0, opened = [], closed = [];
  const act = genericFakeAct({
    // the generic path calls atsInjScanGeneric, never atsInjScan — a handler for the latter would
    // never fire, which is itself part of what this asserts.
    atsInjScanGeneric: () => JSON.parse(JSON.stringify(KEF_LIVE_SCAN)),
    atsInjSetText: (sel, v) => { values[sel] = v; return { ok: true, after: v }; },
    atsInjReadValue: (a, sel) => ({ ok: true, value: values[sel] != null ? values[sel] : null }),
    atsInjSelectNative: (sel, text) => { values[sel] = text; return { ok: true }; },
    atsInjReadFileState: () => ({ ok: true, name: "resume.pdf" }),
    atsInjScrollIntoView: () => ({ ok: true }),
    atsInjSubmitState: () => ({ ok: true, hasSubmit: true, multiStep: false, captchaChallenge: false, confirmed: false }),
    atsInjErrors: () => ({ ok: true, errors: [] }),
    // the citizenship <select> was placeholder-only at scan time, so the review picker must RE-READ it
    // live — the exact gap the first real run exposed. Here the page has since populated it.
    atsInjReadNativeOptions: (sel) => { opened.push(sel); return { ok: true, options: ["Yes", "No"], placeholder: null, total: 3 }; },
    atsInjOpenAndReadOptions: (sel) => { opened.push(sel); return { ok: true, opened: true }; },
    atsInjReadOptions: (sel) => (closed.includes(sel)
      ? { ok: true, open: false, options: [] }
      : { ok: true, open: true, options: [{ text: "Yes", disabled: false }, { text: "No", disabled: false }] }),
    atsInjCloseCombo: (sel) => { closed.push(sel); return { ok: true }; },
    attachResume: async () => { resumeAttached++; return { ok: true, name: "resume.pdf", verified: true }; },
  });

  const out = await ats.driveAtsPageFill(act, "generic", GENERIC_PROFILE, {}, { company: "KEF Robotics" }, { buckets: GENERIC_BUCKETS });
  const by = Object.fromEntries(out.results.map((r) => [r.fieldName, r]));

  // the identity fields fill deterministically off the profile and are read-back verified
  assert.strictEqual(by["first-name"].after, "Kevin");
  assert.strictEqual(by["first-name"].status, "filled");
  assert.strictEqual(by["last-name"].after, "Wang");
  assert.strictEqual(by.email.after, "kevin@example.com");

  // the résumé slot is recognized with no static map and attached exactly once
  assert.strictEqual(resumeAttached, 1, "the résumé must attach exactly once");

  // ⚠ THE OPERATOR'S REQUIREMENT: the unfilled citizenship dropdown reaches review WITH a picker.
  // Its <select> was placeholder-only, so the options can only have come from the capture pass.
  const cit = by["collection_comp-lpjwscz6"];
  assert.ok(cit, "the citizenship dropdown must reach review");
  assert.deepStrictEqual(cit.options, ["Yes", "No"], "review must get a real picker for it");
  assert.ok(opened.includes("#collection_comp-lpjwscz6"), "the capture pass must have re-read it");

  // nothing was silently dropped: every scanned field produced a record
  assert.strictEqual(out.results.length, KEF_LIVE_SCAN.fields.length);
});

test("INTEGRATION (generic): a field whose read-back disagrees ends needs_review, never a silent wrong value", async () => {
  const act = genericFakeAct({
    atsInjScanGeneric: () => JSON.parse(JSON.stringify(KEF_LIVE_SCAN)),
    // the page accepts the write but reports something else back — the false-verify class
    atsInjSetText: () => ({ ok: true, after: "Kevin" }),
    atsInjReadValue: () => ({ ok: true, value: "SOMETHING ELSE" }),
    atsInjSelectNative: () => ({ ok: true }),
    atsInjScrollIntoView: () => ({ ok: true }),
    atsInjSubmitState: () => ({ ok: true, hasSubmit: true }),
    atsInjErrors: () => ({ ok: true, errors: [] }),
    atsInjOpenAndReadOptions: () => ({ ok: true }),
    atsInjReadOptions: () => ({ ok: true, open: false, options: [] }),
    atsInjCloseCombo: () => ({ ok: true }),
  });
  const out = await ats.driveAtsPageFill(act, "generic", GENERIC_PROFILE, {}, {}, { buckets: GENERIC_BUCKETS });
  const first = out.results.find((r) => r.fieldName === "first-name");
  assert.notStrictEqual(first.status, "filled", "a disagreeing read-back must never report filled");
  assert.ok(["needs_review", "filled_review"].includes(first.status));
});

test("INTEGRATION (generic): the AI is never asked when nothing is required and unmapped", async () => {
  let llmCalls = 0;
  const act = genericFakeAct({
    aiEnabled: true,
    llm: async () => { llmCalls++; return { ok: true, text: '{"answer":"x"}' }; },
    atsInjScanGeneric: () => JSON.parse(JSON.stringify(KEF_LIVE_SCAN)),
    atsInjSetText: (sel, v) => ({ ok: true, after: v }),
    atsInjReadValue: (a, sel) => ({ ok: true, value: null }),
    atsInjSelectNative: () => ({ ok: true }),
    atsInjScrollIntoView: () => ({ ok: true }),
    atsInjSubmitState: () => ({ ok: true, hasSubmit: true }),
    atsInjErrors: () => ({ ok: true, errors: [] }),
    atsInjOpenAndReadOptions: () => ({ ok: true }),
    atsInjReadOptions: () => ({ ok: true, open: false, options: [] }),
    atsInjCloseCombo: () => ({ ok: true }),
  });
  await ats.driveAtsPageFill(act, "generic", GENERIC_PROFILE, {}, {}, { buckets: GENERIC_BUCKETS });
  // On this form only `email` is required, and the profile answers it. The two free-text questions are
  // OPTIONAL, and the operator rule is that an optional unmapped field fills deterministically or
  // stays BLANK — it must never buy an LLM call.
  assert.strictEqual(llmCalls, 0, "no optional field may spend an AI request");
});

// ── ⚠ the RÉSUMÉ was attached THREE times on a live iCIMS run — one predicate, two callers ──
test("LIVE iCIMS: exactly ONE of four file inputs receives the résumé", () => {
  // Live 2026-08-12 the résumé went into the real slot AND "Attachment 1" AND "Attachment 2", because
  // the router's regex contained a bare `attach` (matching "Attachment 1") while primaryResumeSlot was
  // computed from a narrower one, so the refusal never fired. Three copies to an employer.
  const s = ats.atsGenericPostProcess({
    fields: [
      { attrId: "PortalProfileFields.Resume_File", inputSel: "#r", widgetType: "file_upload", domIndex: 0,
        labelCandidates: { labelFor: "Please upload your resume (max size: 5 MB)" }, reqAttr: true },
      { attrId: "rcf2000_File", inputSel: "#a0", widgetType: "file_upload", domIndex: 1,
        labelCandidates: { labelFor: "Additional Documents" } },
      { attrId: "rcf2100_File", inputSel: "#a1", widgetType: "file_upload", domIndex: 2,
        labelCandidates: { labelFor: "Attachment 1" } },
      { attrId: "rcf2101_File", inputSel: "#a2", widgetType: "file_upload", domIndex: 3,
        labelCandidates: { labelFor: "Attachment 2" } },
    ],
  });
  assert.strictEqual(s.diag.fileInputs, 4);
  assert.strictEqual(s.diag.resumeSlots, 1, "only the real résumé field may count as a résumé slot");
  const kinds = s.fields.map((f) => ats.atsRouteField("generic", f, {}, {}, {}, null).kind);
  assert.deepStrictEqual(kinds, ["resume", "skip", "skip", "skip"]);
});

test("résumé predicate: 'attach' alone is not enough, and attachment/document slots are refused", () => {
  const mk = (label, name) => ({ widgetType: "file_upload", label, fieldName: name || "f" });
  assert.ok(ats.atsGenericIsResumeSlot(mk("Attach Resume")));
  assert.ok(ats.atsGenericIsResumeSlot(mk("Upload Resume")));
  assert.ok(ats.atsGenericIsResumeSlot(mk("Resume/CV")));
  assert.ok(ats.atsGenericIsResumeSlot(mk("Curriculum Vitae")));
  assert.ok(ats.atsGenericIsResumeSlot(mk("", "cResume")));
  // the live false positives
  assert.ok(!ats.atsGenericIsResumeSlot(mk("Attachment 1")));
  assert.ok(!ats.atsGenericIsResumeSlot(mk("Attachment 2")));
  assert.ok(!ats.atsGenericIsResumeSlot(mk("Additional Documents")));
  // and the neighbours it must keep refusing
  for (const l of ["Cover Letter", "Transcript", "Portfolio", "Writing sample", "References"]) {
    assert.ok(!ats.atsGenericIsResumeSlot(mk(l)), l);
  }
  // a non-file widget is never a résumé slot however it is labelled
  assert.ok(!ats.atsGenericIsResumeSlot({ widgetType: "text", label: "Resume" }));
});

test("LIVE iCIMS: a widget SHIM sharing a label is collapsed into the real control", () => {
  // iCIMS pairs <select id="rcf3077"> with <a id="rcf3077_icimsDropdown" role=combobox>; both matched
  // the control selector, so each dropdown was scanned twice live — doubling review rows, option
  // captures and (for a required one) AI questions.
  const s = ats.atsGenericPostProcess({
    fields: [
      { attrId: "rcf3077", inputSel: "#rcf3077", widgetType: "dropdown_native", domIndex: 0, options: ["A", "B"],
        labelCandidates: { labelFor: "Time Zone" } },
      { attrId: "rcf3077_icimsDropdown", inputSel: "#rcf3077_icimsDropdown", widgetType: "select", domIndex: 1,
        labelCandidates: { labelFor: "Time Zone" } },
      { attrId: "-1_CandProfileFields.School", inputSel: "#s", widgetType: "dropdown_native", domIndex: 2,
        labelCandidates: { labelFor: "School" } },
      { attrId: "-1_CandProfileFields.School_icimsDropdown", inputSel: "#s2", widgetType: "select", domIndex: 3,
        labelCandidates: { labelFor: "School" } },
    ],
  });
  assert.deepStrictEqual(s.fields.map((f) => f.fieldName), ["rcf3077", "-1_CandProfileFields.School"]);
  assert.strictEqual(s.diag.widgetShimsDropped.length, 2);
  // the survivor is the one that posts a value, and it keeps its options
  assert.deepStrictEqual(s.fields[0].options, ["A", "B"]);
});

test("⚠ shim dedupe: a genuine pair with DIFFERENT labels is never collapsed", () => {
  const s = ats.atsGenericPostProcess({
    fields: [
      { attrId: "phone", inputSel: "#p", widgetType: "text", domIndex: 0, labelCandidates: { labelFor: "Phone" } },
      { attrId: "phone_ext", inputSel: "#pe", widgetType: "text", domIndex: 1, labelCandidates: { labelFor: "Extension" } },
    ],
  });
  assert.strictEqual(s.fields.length, 2, "different labels ⇒ two real fields");
  assert.ok(!s.diag.widgetShimsDropped);
});

// ── the form inside a SAME-ORIGIN IFRAME (iCIMS) ────────────────────────────────────────
test("frame hop: a rich same-origin frame beats an empty top page", () => {
  // Measured on iCIMS: top document ~121 nodes / 0 controls, frame 91 controls.
  const pick = ats.atsPickFormFrame({
    topControls: 0, crossOrigin: 0,
    candidates: [{ src: "https://x.icims.com/jobs/1/candidate?in_iframe=1", controls: 91, visible: true }],
  });
  assert.match(pick, /in_iframe=1/);
});

test("⚠ frame hop: a page that already shows its own form is NEVER abandoned for a frame", () => {
  // a marketing / video / captcha iframe must not steal a run off a real form
  assert.strictEqual(ats.atsPickFormFrame({ topControls: 7, candidates: [{ src: "https://ads.example/x", controls: 2, visible: true }] }), null);
  // …and not even when the frame has a few controls, if the top page has more
  assert.strictEqual(ats.atsPickFormFrame({ topControls: 20, candidates: [{ src: "https://x/y", controls: 9, visible: true }] }), null);
});

test("frame hop: a trivial frame is below the floor, and cross-origin frames never count", () => {
  // a 1-input newsletter frame must not qualify
  assert.strictEqual(ats.atsPickFormFrame({ topControls: 0, candidates: [{ src: "https://x/y", controls: 1, visible: true }] }), null);
  // the probe reports cross-origin frames but never lists them as candidates (it cannot read them)
  assert.strictEqual(ats.atsPickFormFrame({ topControls: 0, crossOrigin: 3, candidates: [] }), null);
  const src = ats.atsInjFindFormFrame.toString();
  assert.ok(/crossOrigin\+\+/.test(src), "unreadable frames must be counted, not guessed at");
  assert.doesNotThrow(() => new Function("return (" + src + ")"));
});

// ── ADDRESS: the tier that was missing entirely ─────────────────────────────────────────
const ADDR_PROFILE = {
  personal_info: {
    address_line_1: "715 Middlebrooks Circle", address_line_2: "",
    city: "Tallahassee", state_province: "Florida", postal_code: "32312",
    country: ["United States of America", "United States"],
    country_phone_code: ["United States of America (+1)"],
  },
};

test("address: the whole block resolves from the profile (it filled NOTHING before)", () => {
  // Live on iCIMS only City and Country committed -- and only because a bucket wording happened to
  // match those two words. "Address", "Zip/Postal Code" and "State/Province" matched nothing, so no
  // candidate was ever routed to them. The review picker still scraped their options, which is what
  // "it scrapes the dropdowns but doesn't click commit" looks like from outside.
  const v = (name, label) => {
    const r = ats.atsGenericAddressValue(ADDR_PROFILE, { fieldName: name, label, widgetType: "text" });
    return r && r.value;
  };
  assert.strictEqual(v("-1_PersonProfileFields.AddressStreet1", "Address"), "715 Middlebrooks Circle");
  assert.strictEqual(v("-1_PersonProfileFields.AddressCity", "City"), "Tallahassee");
  assert.strictEqual(v("-1_PersonProfileFields.AddressZip", "Zip/Postal Code"), "32312");
  assert.strictEqual(v("-1_PersonProfileFields.AddressState", "State/Province"), "Florida");
  assert.deepStrictEqual(v("-1_PersonProfileFields.AddressCountry", "Country"), ["United States of America", "United States"]);
  // an empty profile field stays blank rather than becoming ""
  assert.strictEqual(v("-1_PersonProfileFields.AddressStreet2", "Address 2"), null);
});

test("⚠ address: an EDUCATION or WORK entry's City/State is NOT the applicant's address", () => {
  // Live: EducationCity was filled "Tallahassee" for a school in Pittsburgh -- a bucket answering a
  // bare "City" with the home address, silently and confidently. The entry owns these.
  const v = (name, label) => ats.atsGenericAddressValue(ADDR_PROFILE, { fieldName: name, label, widgetType: "text" });
  assert.strictEqual(v("-1_CandProfileFields.EducationCity", "City"), null);
  assert.strictEqual(v("-1_CandProfileFields.EducationState", "State/Province"), null);
  assert.strictEqual(v("-6481216_PersonProfileFields.rcf3216", "City"), null, "a work entry's city is the employer's");
});

test("address: a phone COUNTRY CODE is never answered with the address country", () => {
  const v = (name, label) => ats.atsGenericAddressValue(ADDR_PROFILE, { fieldName: name, label, widgetType: "select" });
  assert.strictEqual(v("-1_PersonProfileFields.PhoneCountryCode", "Country dialing code"), null);
  assert.strictEqual(v("rcf_phone", "Phone Country"), null);
});

test("⚠ scope: a WORK-EXPERIENCE address is the EMPLOYER's, not the applicant's", () => {
  // Operator 2026-08-12: "in the work experience section, address actually means the address of the
  // workplace so filling the address of the home location is wrong." iCIMS names that whole block
  // rcf3212…rcf3218 — nothing in the NAME says "work" — so the section HEADING is what scopes it.
  const wf = (label) => ({ fieldName: "-6481216_PersonProfileFields.rcf3216", label,
    sectionHeading: "Professional Experience (beginning with your most recent)", widgetType: "text" });
  assert.strictEqual(ats.atsGenericScopeOf(wf("Address")), "work");
  assert.strictEqual(ats.atsGenericAddressValue(ADDR_PROFILE, wf("Address")), null, "the home street must not reach an employer's address");
  assert.strictEqual(ats.atsGenericAddressValue(ADDR_PROFILE, wf("City")), null);
  assert.strictEqual(ats.atsGenericAddressValue(ADDR_PROFILE, wf("Country")), null);

  // …while the real address section, under its own heading, still fills
  const af = (label, name) => ({ fieldName: name, label, sectionHeading: "Addresses (1)* required.", widgetType: "text" });
  assert.strictEqual(ats.atsGenericScopeOf(af("Address", "-1_PersonProfileFields.AddressStreet1")), "address");
  const r = ats.atsGenericAddressValue(ADDR_PROFILE, af("Address", "-1_PersonProfileFields.AddressStreet1"));
  assert.strictEqual(r && r.value, "715 Middlebrooks Circle");
});

test("scope: an opaque field under an EDUCATION heading scopes to education", () => {
  const f = { fieldName: "rcf9001", label: "City", sectionHeading: "Education (1)", widgetType: "text" };
  assert.strictEqual(ats.atsGenericScopeOf(f), "education");
  assert.strictEqual(ats.atsGenericAddressValue(ADDR_PROFILE, f), null);
});

test("scope: the scanner records the raw nearest heading independently of the label ladder", () => {
  const src = ats.atsInjScanGeneric.toString();
  assert.ok(/sectionHeading:/.test(src), "every scanned field must carry its section heading");
  // and the resolver must carry it through to the field the router sees
  const s = ats.atsGenericPostProcess({
    fields: [{ attrId: "rcf3216", inputSel: "#x", widgetType: "text", domIndex: 0,
      sectionHeading: "Professional Experience", labelCandidates: { labelFor: "City" } }],
  });
  assert.strictEqual(s.fields[0].sectionHeading, "Professional Experience");
  assert.strictEqual(ats.atsGenericScopeOf(s.fields[0]), "work");
});

test("scope: the field NAME decides, because the label cannot", () => {
  const s = (name, label) => ats.atsGenericScopeOf({ fieldName: name, label });
  assert.strictEqual(s("-1_PersonProfileFields.AddressCity", "City"), "address");
  assert.strictEqual(s("-1_CandProfileFields.EducationCity", "City"), "education");
  assert.strictEqual(s("-1_CandProfileFields.School", "School"), "education");
  assert.strictEqual(s("jobPostingApplication_workHistory_0_city", "City"), "work");
  assert.strictEqual(s("info.firstName", "First Name"), "none");
  // label-only fallback, for names that carry no signal
  assert.strictEqual(s("rcf1234", "Highest degree earned"), "education");
  assert.strictEqual(s("rcf9999", "Current employer"), "work");
});

test("⚠ buckets are BLOCKED from an entry-scoped location label", () => {
  // the guard that stops a scalar bucket answering "City" inside an education entry
  const idx = new Map([["city", { id: "b", profile_path: "personal_info.city", questions: ["City"] }]]);
  const edu = ats.atsRouteField("generic", { widgetType: "text", fieldName: "-1_CandProfileFields.EducationCity", label: "City" }, ADDR_PROFILE, {}, {}, idx);
  assert.ok(!edu || edu.source !== "bucket", "a bucket must not answer an education entry's city");
  // …while the ADDRESS one still resolves (via the address tier, before buckets)
  const addr = ats.atsRouteField("generic", { widgetType: "text", fieldName: "-1_PersonProfileFields.AddressCity", label: "City" }, ADDR_PROFILE, {}, {}, idx);
  assert.strictEqual(addr.source, "address");
  assert.strictEqual(addr.raw, "Tallahassee");
});

test("isolation: the address tier is generic-only", () => {
  for (const kind of ["greenhouse", "lever", "ashby"]) {
    const r = ats.atsRouteField(kind, { widgetType: "text", fieldName: "AddressCity", label: "City" }, ADDR_PROFILE, {}, {}, null);
    assert.ok(!r || r.source !== "address", kind + " must not use the generic address tier");
  }
});

// ── EDUCATION: the repeating-entry tier, and the NON-repeating rule ─────────────────────
const EDU_PROFILE = {
  education: [
    { school_or_university: "State College", degree: "Associate's Degree", field_of_study: "General", to_year: "2022" },
    { school_or_university: "Carnegie Mellon University", degree: "Bachelor of Science",
      field_of_study: "Electrical and Computer Engineering", minor: "Robotics", gpa: "3.95",
      from_year: "2024", graduation_date: "2028-05", currently_enrolled: true },
  ],
};

test("⚠ entry ordinal and IDENTITY are independent — a durable id keeps its name AND gets an ordinal", () => {
  // Regression: threading entryOrdinal turned `else if (s.label)` into `if (s.label)`, so the label
  // branch overwrote perfectly good durable ids and 8 tests went red at once. A repeating section can
  // have excellent per-entry ids (Dayforce's ..._educationHistory_0_...) and still need its index.
  const s = ats.atsGenericPostProcess({
    fields: [
      { attrId: "jobPostingApplication_educationHistory_0_schoolName", inputSel: "#a", widgetType: "text", domIndex: 0, labelCandidates: { labelFor: "School" } },
      { attrId: "jobPostingApplication_educationHistory_1_schoolName", inputSel: "#b", widgetType: "text", domIndex: 1, labelCandidates: { labelFor: "School" } },
      { attrId: "jobPostingApplication_personalInfo_email", inputSel: "#e", widgetType: "text", domIndex: 2, labelCandidates: { labelFor: "Email Address" } },
    ],
  });
  // identity is the durable id, untouched by the ordinal
  assert.deepStrictEqual(s.fields.map((f) => f.fieldName), [
    "jobPostingApplication_educationHistory_0_schoolName",
    "jobPostingApplication_educationHistory_1_schoolName",
    "jobPostingApplication_personalInfo_email",
  ]);
  assert.ok(s.fields.every((f) => f.identityFrom === "attr"));
  // …and the ordinal still says which entry each one is
  assert.deepStrictEqual(s.fields.map((f) => f.entryOrdinal), [0, 1, 0]);
});

test("entry ordinal: the k-th field carrying a label IS entry k; a unique label is entry 0", () => {
  const s = ats.atsGenericPostProcess({
    fields: [
      { attrId: null, inputSel: "#a", widgetType: "select", domIndex: 0, labelCandidates: { labelFor: "School" } },
      { attrId: null, inputSel: "#b", widgetType: "select", domIndex: 1, labelCandidates: { labelFor: "School" } },
      { attrId: null, inputSel: "#c", widgetType: "text", domIndex: 2, labelCandidates: { labelFor: "GPA" } },
    ],
  });
  assert.deepStrictEqual(s.fields.map((f) => f.entryOrdinal), [0, 1, 0]);
  assert.deepStrictEqual(s.fields.map((f) => f.fieldName), ["label:School#0", "label:School#1", "label:GPA"]);
});

test("education ordering: 'top' means currently enrolled, then most recent — not profile order", () => {
  // ⚠ load-bearing, not cosmetic: the operator's rule is that a NON-repeating education block fills
  // the top choice, and ordinal 0 is what "top" resolves to.
  const ordered = ats.atsGenericEducationOrder(EDU_PROFILE.education);
  assert.strictEqual(ordered[0].school_or_university, "Carnegie Mellon University");
  assert.strictEqual(ordered[1].school_or_university, "State College");
  // ties keep the profile's own order (stable) so a curated list is never reshuffled
  const tied = ats.atsGenericEducationOrder([{ school_or_university: "A", to_year: "2020" }, { school_or_university: "B", to_year: "2020" }]);
  assert.deepStrictEqual(tied.map((e) => e.school_or_university), ["A", "B"]);
  assert.deepStrictEqual(ats.atsGenericEducationOrder(null), []);
});

test("education: a NON-repeating block fills the TOP entry (the operator's rule)", () => {
  const v = (label) => { const r = ats.atsGenericEducationValue(EDU_PROFILE, label, 0); return r && r.value; };
  assert.strictEqual(v("School"), "Carnegie Mellon University");
  assert.strictEqual(v("Degree"), "Bachelor of Science");
  assert.strictEqual(v("Major"), "Electrical and Computer Engineering");
  assert.strictEqual(v("Minor"), "Robotics");
  assert.strictEqual(v("GPA"), "3.95");
  // …and the router defaults the ordinal to 0, so a field with no entry index gets the top entry
  const r = ats.atsRouteField("generic", { widgetType: "select", label: "School" }, EDU_PROFILE, {}, {}, null);
  assert.strictEqual(r.source, "education");
  assert.strictEqual(r.raw, "Carnegie Mellon University");
  assert.match(r.detail, /most recent/);
});

test("education: entry ordinal 1 reaches the SECOND entry, so a repeating section fills distinctly", () => {
  const r0 = ats.atsRouteField("generic", { widgetType: "select", label: "School", entryOrdinal: 0 }, EDU_PROFILE, {}, {}, null);
  const r1 = ats.atsRouteField("generic", { widgetType: "select", label: "School", entryOrdinal: 1 }, EDU_PROFILE, {}, {}, null);
  assert.strictEqual(r0.raw, "Carnegie Mellon University");
  assert.strictEqual(r1.raw, "State College");
  // an ordinal beyond the profile's entries yields nothing rather than repeating the last one
  assert.strictEqual(ats.atsGenericEducationValue(EDU_PROFILE, "School", 9), null);
});

test("education: one stored date serves iCIMS' three separate controls", () => {
  const v = (label) => { const r = ats.atsGenericEducationValue(EDU_PROFILE, label, 0); return r && r.value; };
  assert.strictEqual(v("Graduation Date Year"), "2028");
  assert.deepStrictEqual(v("Graduation Date Month"), ["May", "05", "5", "May"]); // tiered — see below
  assert.strictEqual(v("Start Date Year"), "2024");
  // the part extractor itself
  assert.strictEqual(ats.atsGenericDatePart("05/15/2028", "End Date Year"), "2028");
  assert.strictEqual(ats.atsGenericDatePart("2026", "Start Date Year"), "2026");
  // a bare year cannot answer a MONTH box — better blank than wrong
  assert.strictEqual(ats.atsGenericDatePart("2026", "Start Date Month"), null);
  assert.strictEqual(ats.atsGenericDatePart("", "Year"), null);
});

test("⚠ dates: a MONTH control is offered a TIERED vocabulary, because forms disagree on it", () => {
  // Live on iCIMS a bare "5" reached a 12-option month dropdown and was refused
  // (`stated-value-unmatched`) — that form lists month NAMES. We do not know which vocabulary a form
  // uses until its options are read, so all three go to the match ladder in order.
  const m = ats.atsGenericDatePart("2028-05", "Graduation Date Month");
  assert.ok(Array.isArray(m), "a month must be a tiered candidate list");
  assert.deepStrictEqual(m, ["May", "05", "5", "May"]);
  assert.deepStrictEqual(ats.atsGenericDatePart("2028-12", "Month"), ["December", "12", "12", "Dec"]);
  // out-of-range or missing ⇒ blank, never a guess
  assert.strictEqual(ats.atsGenericDatePart("2028", "Month"), null);
});

test("⚠ dates: a DAY control gets a day or NOTHING — never a year, never a whole date", () => {
  // Two live bugs, both refused by the ladder but wrong to have offered at all: iCIMS names its day
  // field `..._Date`, so a missing day fell through to the whole-date branch and offered "05/1/2028",
  // and `EducationStartDate_Date` was offered the bare year "2024".
  assert.strictEqual(ats.atsGenericDatePart("2028-05", "Graduation Date Date"), null, "no day stored ⇒ blank");
  assert.strictEqual(ats.atsGenericDatePart("2024", "Start Date Date"), null, "a year must never reach a day box");
  assert.strictEqual(ats.atsGenericDatePart("2024", "Start Date Day"), null);
  // …and a real day IS offered, zero-padded as a fallback
  assert.deepStrictEqual(ats.atsGenericDatePart("2028-05-15", "Graduation Date Day"), ["15", "15"]);
  assert.deepStrictEqual(ats.atsGenericDatePart("05/09/2028", "End Date Date"), ["9", "09"]);
});

test("education: 'Did You Graduate?' is derived, and currently-enrolled means NO", () => {
  const g = (p) => { const r = ats.atsGenericEducationValue(p, "Did You Graduate?", 0); return r && r.value; };
  assert.strictEqual(g(EDU_PROFILE), false, "currently enrolled ⇒ has not graduated");
  assert.strictEqual(g({ education: [{ school_or_university: "X", graduation_date: "2020-05" }] }), true);
  assert.strictEqual(g({ education: [{ school_or_university: "X" }] }), false);
});

test("education: a non-education label is left alone, and an empty profile yields nothing", () => {
  assert.strictEqual(ats.atsGenericEducationValue(EDU_PROFILE, "Legal First Name", 0), null);
  assert.strictEqual(ats.atsGenericEducationValue(EDU_PROFILE, "Phone Number", 0), null);
  assert.strictEqual(ats.atsGenericEducationValue({}, "School", 0), null);
  assert.strictEqual(ats.atsGenericEducationValue({ education: [] }, "School", 0), null);
});

test("isolation: the education tier is generic-only", () => {
  for (const kind of ["greenhouse", "lever", "ashby"]) {
    const r = ats.atsRouteField(kind, { widgetType: "select", label: "School" }, EDU_PROFILE, {}, {}, null);
    assert.ok(!r || r.source !== "education", kind + " must not use the generic education tier");
  }
});

// ── WIDGET DRIVER: the paired ARIA combobox (traced on iCIMS) ────────────────────────────
// <select id=X visibility:hidden> + <a id=X_icimsDropdown role=combobox> + a container holding
// ul[role=listbox] > li[role=option]. The real Degree list, verbatim from the live widget.
const ICIMS_DEGREES = ["AS", "BS", "MS", "PhD", "MBA", "MCS", "BCS", "BA", "B.S", "Diploma",
  "Master's Degree", "Bachelor's Degree", "Bachelor of Science", "Associate's Degree"];

function pairedAct(over) {
  const calls = [];
  const base = {
    delay: async () => {}, delayFull: async () => {},
    eval: async (fn, ...args) => {
      calls.push(fn.name);
      switch (fn.name) {
        case "atsInjPairedComboProbe": return { ok: true, triggerSel: "#d_icimsDropdown", ctnrSel: "#d_ctnr", expanded: false, triggerText: "— Make a Selection —" };
        case "atsInjPairedComboOpen": return { ok: true, expanded: true };
        case "atsInjPairedComboRead": return { ok: true, open: true, loading: false, options: ICIMS_DEGREES.map((t) => ({ text: t, disabled: false })) };
        case "atsInjPairedComboFilter": return { ok: true, filtered: true };
        case "atsInjPairedComboCommit": return { ok: true, clicked: args[1] };
        case "atsInjPairedComboValue": return { ok: true, value: over && over.readBack !== undefined ? over.readBack : "BS", from: "trigger" };
        case "atsInjPairedComboClose": return { ok: true, open: false };
        default: return { ok: true };
      }
    },
  };
  return Object.assign(base, { calls }, over && over.eval ? { eval: over.eval } : {});
}

test("paired combo: an exact match commits, verifies, and CLOSES the list", async () => {
  const act = pairedAct();
  const rec = {};
  const r = await ats.atsFillPairedCombo(act, { label: "Degree" }, { inputSel: "#d" }, rec, ["BS"]);
  assert.strictEqual(r.handled, true);
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.after, "BS");
  assert.deepStrictEqual(rec.options, ICIMS_DEGREES, "review gets the real list");
  assert.ok(act.calls.includes("atsInjPairedComboClose"), "a list left mounted eats the next open-click");
});

test("paired combo: a non-exact (typo) match is filled_review, never silently filled", async () => {
  const act = pairedAct({ readBack: "Bachelor's Degree" });
  const rec = {};
  await ats.atsFillPairedCombo(act, { label: "Degree" }, { inputSel: "#d" }, rec, ["Bachelors Degree"]);
  assert.strictEqual(rec.status, "filled_review");
  assert.strictEqual(rec.flag, "non-exact-match");
});

test("⚠ paired combo: a read-back that disagrees ends needs_review", async () => {
  const act = pairedAct({ readBack: "PhD" });   // we chose BS, the page shows PhD
  const rec = {};
  await ats.atsFillPairedCombo(act, { label: "Degree" }, { inputSel: "#d" }, rec, ["BS"]);
  assert.strictEqual(rec.status, "needs_review");
  assert.match(rec.detail, /commit did not persist/);
});

test("⚠ paired combo: no candidate match NEVER guesses, and still hands review the options", async () => {
  const act = pairedAct();
  const rec = {};
  await ats.atsFillPairedCombo(act, { label: "Degree" }, { inputSel: "#d" }, rec, ["Underwater Basket Weaving"]);
  assert.strictEqual(rec.status, "needs_review");
  assert.match(rec.detail, /no candidate matched 14 option/);
  assert.deepStrictEqual(rec.options, ICIMS_DEGREES);
});

test("paired combo: a widget of a DIFFERENT shape is not handled — the caller falls through", async () => {
  const act = pairedAct({ eval: async (fn) => (fn.name === "atsInjPairedComboProbe" ? { ok: false, error: "no-paired-trigger" } : { ok: true }) });
  const r = await ats.atsFillPairedCombo(act, { label: "x" }, { inputSel: "#x" }, {}, ["y"]);
  assert.strictEqual(r.handled, false, "react-select etc. must reach their own path unchanged");
});

test("paired combo: an EMPTY list types into the widget's own filter box before giving up", async () => {
  // iCIMS' school picker is server-backed: it returns nothing until a query is typed.
  let filtered = false, reads = 0;
  const act = {
    delay: async () => {}, delayFull: async () => {},
    eval: async (fn, ...args) => {
      if (fn.name === "atsInjPairedComboProbe") return { ok: true, triggerSel: "#t", ctnrSel: "#c" };
      if (fn.name === "atsInjPairedComboOpen") return { ok: true, expanded: true };
      if (fn.name === "atsInjPairedComboFilter") { filtered = true; return { ok: true, filtered: true }; }
      if (fn.name === "atsInjPairedComboRead") {
        reads++;
        return filtered
          ? { ok: true, open: true, loading: false, options: [{ text: "University of California, Los Angeles", disabled: false }] }
          : { ok: true, open: true, loading: false, options: [] };
      }
      if (fn.name === "atsInjPairedComboCommit") return { ok: true, clicked: args[1] };
      if (fn.name === "atsInjPairedComboValue") return { ok: true, value: "University of California, Los Angeles" };
      return { ok: true, open: false };
    },
  };
  const rec = {};
  await ats.atsFillPairedCombo(act, { label: "School" }, { inputSel: "#s" }, rec, ["University of California, Los Angeles"]);
  assert.ok(filtered, "it must query a server-backed list rather than declaring it empty");
  assert.strictEqual(rec.status, "filled");
});

test("⚠ paired combo: a picker STUCK loading routes into the existing dead-async path", async () => {
  // Measured on iCIMS' School picker: the query fires (the box holds the text, the list collapses) and
  // `loading` stays true past 5.4s with zero results — this form's own search never answers. It must
  // be reported as that, not as our failure, and it must reuse `listUnproven` so atsFinishFill's
  // deadAsync collection (and the run's reload-once remedy) picks it up.
  const act = {
    delay: async () => {}, delayFull: async () => {},
    eval: async (fn) => {
      if (fn.name === "atsInjPairedComboProbe") return { ok: true, triggerSel: "#t", ctnrSel: "#c" };
      if (fn.name === "atsInjPairedComboOpen") return { ok: true, expanded: true };
      if (fn.name === "atsInjPairedComboRead") return { ok: true, open: true, loading: true, options: [] };
      return { ok: true, open: false };
    },
  };
  const rec = {};
  await ats.atsFillPairedCombo(act, { label: "School" }, { inputSel: "#s" }, rec, ["Carnegie Mellon University"]);
  assert.strictEqual(rec.status, "needs_review");
  assert.strictEqual(rec.flag, "options-never-rendered");
  assert.strictEqual(rec.listUnproven, true, "must reuse the dead-async signal, not a second one");
  // the wording is what atsFinishFill's deadAsync regex matches on
  assert.match(rec.detail, /never answered our search/);
  assert.match(rec.detail, /Carnegie Mellon University/, "say WHAT was searched for");
});

test("paired combo: an empty list that is NOT loading reads as empty, not as a dead search", async () => {
  const act = {
    delay: async () => {}, delayFull: async () => {},
    eval: async (fn) => {
      if (fn.name === "atsInjPairedComboProbe") return { ok: true, triggerSel: "#t", ctnrSel: "#c" };
      if (fn.name === "atsInjPairedComboOpen") return { ok: true, expanded: true };
      if (fn.name === "atsInjPairedComboRead") return { ok: true, open: true, loading: false, options: [] };
      return { ok: true, open: false };
    },
  };
  const rec = {};
  await ats.atsFillPairedCombo(act, { label: "Degree" }, { inputSel: "#d" }, rec, ["BS"]);
  assert.ok(!rec.listUnproven, "a genuinely empty list is not a stuck server call");
  assert.match(rec.detail, /listed no options/);
});

test("paired combo: every injected fn is self-contained, and the OPEN uses a pointer sequence", () => {
  for (const n of ["atsInjPairedComboProbe", "atsInjPairedComboOpen", "atsInjPairedComboRead",
                   "atsInjPairedComboFilter", "atsInjPairedComboCommit", "atsInjPairedComboValue", "atsInjPairedComboClose"]) {
    const src = String(ats[n]);
    assert.doesNotThrow(() => new Function("return (" + src + ")"), n + " must parse standalone");
    for (const other of ["atsLib", "atsFd", "atsAttachOptions", "ATS_POLL"]) assert.ok(!src.includes(other), n + " references " + other);
  }
  // ⚠ a plain el.click() does NOT open this widget — measured live; aria-expanded stayed false until
  // the pointer/mouse sequence was dispatched.
  const openSrc = String(ats.atsInjPairedComboOpen);
  for (const ev of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    assert.ok(openSrc.includes(ev), "the open sequence must dispatch " + ev);
  }
  // and the option read must be SCOPED to this widget's container (the chip-contamination lesson)
  assert.ok(String(ats.atsInjPairedComboRead).includes("querySelectorAll('[role=\"option\"]')"));
});

// ── CREDENTIALS (iCIMS embeds a "Create a login" block INSIDE the application form) ─────
// Operator 2026-08-12: use the same stored credentials the Workday onboarding signs in with. The
// safety of that rests entirely on the credential tier being UNREACHABLE by any other answer source.
const CREDS = { email: "kevin@example.com", password: "correct-horse-battery-staple" };

test("credentials: ALWAYS filled, and a PREPOPULATED value is overwritten", () => {
  // Operator 2026-08-12: this class of application creates the ACCOUNT AS PART OF THE SUBMISSION —
  // there is no separate login onboarding — so the credentials block is just another section of the
  // form, and whatever the page already shows must be replaced by the stored credentials.
  const f = { widgetType: "text", fieldName: "PersonProfileFields.Login", label: "Login",
    credentialKind: "login", value: "someone.else@old-account.com" };
  const r = ats.atsRouteField("generic", f, {}, {}, {}, null, CREDS);
  assert.strictEqual(r.kind, "credential");
  assert.strictEqual(r.value, CREDS.email);
  assert.strictEqual(r.overwrite, true);
  assert.match(r.detail, /had a value here and it was replaced/);
});

test("credentials: the rewrite CLEARS the box first, so a refill cannot merge strings", async () => {
  // atsInjSetText SETS a value rather than replacing a selection, so rewriting a prepopulated login
  // without clearing risks "old@x.comkevin@example.com". Same "clear before typing" rule the typeahead
  // path already follows.
  const writes = [];
  // RAW shape — the generic path runs the scan through atsGenericPostProcess before filling
  const scan = {
    ats: "generic", url: "u", title: "t", excluded: [],
    fields: [{ attrId: "PersonProfileFields.Login", inputSel: "#login", widgetType: "text",
      credentialKind: "login", value: "someone.else@old-account.com", domIndex: 0,
      labelCandidates: { labelFor: "Login" } }],
  };
  const act = {
    delay: async () => {}, delayFull: async () => {},
    attachResume: async () => ({ ok: true }),
    eval: async (fn, sel, val) => {
      if (fn.name === "atsInjScanGeneric") return scan;
      if (fn.name === "atsInjSetText") { writes.push(val); return { ok: true, after: val }; }
      if (fn.name === "atsInjReadValue") return { ok: true, value: writes[writes.length - 1] || null };
      if (fn.name === "atsInjSubmitState") return { ok: true, hasSubmit: true };
      if (fn.name === "atsInjErrors") return { ok: true, errors: [] };
      return { ok: true };
    },
  };
  // the resolver is bypassed here (a hand-built scan), so drive the fill directly
  const out = await ats.driveAtsPageFill(act, "generic", {}, {}, {}, { credentials: CREDS });
  assert.deepStrictEqual(writes, ["", CREDS.email], "must clear, THEN write the stored login");
  const rec = out.results.find((r) => r.fieldName === "PersonProfileFields.Login");
  assert.strictEqual(rec.status, "filled");
  assert.strictEqual(rec.credential, true);
  assert.strictEqual(rec.after, "(stored login)", "the value must never enter the record");
  assert.ok(!JSON.stringify(out.results).includes(CREDS.email), "no credential value may reach the bundle");
});

test("credentials: a password field is answered ONLY from stored credentials", () => {
  const f = { widgetType: "text", fieldName: "PersonProfileFields.Password", label: "Password", credentialKind: "password" };
  const r = ats.atsRouteField("generic", f, {}, {}, {}, null, CREDS);
  assert.strictEqual(r.kind, "credential");
  assert.strictEqual(r.credentialKind, "password");
  assert.strictEqual(r.value, CREDS.password);
  assert.strictEqual(r.source, "credentials");
});

test("credentials: login takes the EMAIL, confirm takes the same password", () => {
  const mk = (kind, name) => ats.atsRouteField("generic", { widgetType: "text", fieldName: name, label: name, credentialKind: kind }, {}, {}, {}, null, CREDS);
  assert.strictEqual(mk("login", "PersonProfileFields.Login").value, CREDS.email);
  assert.strictEqual(mk("password", "PersonProfileFields.Password").value, CREDS.password);
  assert.strictEqual(mk("password_confirm", "PersonProfileFields.Password_Confirm").value, CREDS.password);
});

test("⚠ credentials: a BUCKET can never answer a credential field", () => {
  // a hostile/careless bucket wording that matches the password label must NOT win — the credential
  // tier returns before the bucket rung is reached.
  const buckets = ats.atsRouteField ? new Map() : null;
  const idx = new Map([["password", { id: "b", profile_path: "personal_info.first_name", questions: ["Password"] }]]);
  const f = { widgetType: "text", fieldName: "PersonProfileFields.Password", label: "Password", credentialKind: "password" };
  const r = ats.atsRouteField("generic", f, { personal_info: { first_name: "Kevin" } }, {}, {}, idx, CREDS);
  assert.strictEqual(r.source, "credentials", "the bucket must not reach a credential field");
  assert.notStrictEqual(r.value, "Kevin");
  assert.ok(buckets === null || true);
});

test("⚠ credentials: incomplete credentials never half-fill", () => {
  const f = { widgetType: "text", fieldName: "PersonProfileFields.Password", label: "Password", credentialKind: "password" };
  // opted in but nothing (or only half) stored ⇒ still needs_review, never a partial account
  for (const creds of [{ email: "x@y.z" }, { password: "p" }]) {
    const r = ats.atsRouteField("generic", f, {}, {}, {}, null, creds);
    assert.strictEqual(r.kind, "credential-missing", "incomplete credentials must not half-fill");
    assert.strictEqual(r.flag, "credentials-not-stored");
    assert.ok(!r.value);
  }
  // and with no credentials stored at all
  for (const creds of [null, undefined, {}]) {
    const r = ats.atsRouteField("generic", f, {}, {}, {}, null, creds);
    assert.strictEqual(r.kind, "credential-missing");
    assert.ok(!r.value);
  }
});

test("⚠ credentials: the scanner tags them, and a GOVERNMENT ID is refused outright", () => {
  const src = ats.atsInjScanGeneric.toString();
  assert.ok(/credentialKindOf/.test(src), "the scanner must classify credential fields");
  assert.ok(/isGovernmentId/.test(src), "the scanner must refuse government ids");
  // government id is an EXCLUSION (never a field); a credential is a TAGGED field (fillable only
  // from stored credentials) — the two must not be conflated
  assert.ok(/government-id-never-filled/.test(src));
  assert.ok(/password_confirm/.test(src));
  // ⚠ the government-id refusal must come BEFORE the type=file exemption, or a file input named
  // "passport" would slip through
  const gi = src.indexOf("isGovernmentId(el)");
  const fileExempt = src.indexOf("if (isFile) return []");
  assert.ok(gi > 0 && fileExempt > gi, "the government-id refusal must precede the file exemption");
});

test("isolation: a credential field on a SUPPORTED ats is not special-cased", () => {
  // the three supported families are login-free, and their scanner never sets credentialKind — so the
  // tier is unreachable there even if a field were somehow tagged.
  const f = { widgetType: "text", fieldName: "password", label: "Password", credentialKind: "password" };
  for (const kind of ["greenhouse", "lever", "ashby"]) {
    const r = ats.atsRouteField(kind, f, {}, {}, {}, null, CREDS);
    assert.ok(!r || r.source !== "credentials", kind + " must not use the credential tier");
  }
});

// ── ISOLATION: the generic kind must not leak into the supported families ───────────────
test("isolation: detectAts NEVER returns 'generic'", () => {
  const urls = [
    "https://job-boards.greenhouse.io/x/jobs/1", "https://jobs.lever.co/x/uuid",
    "https://jobs.ashbyhq.com/x/uuid", "https://magna.wd3.myworkdayjobs.com/x/job/1",
    "https://recruiting.paylocity.com/Recruiting/Jobs/Details/1", "https://example.com/careers",
    "https://jobs.dayforcehcm.com/en-US/x/y/jobs/1", "https://www.kefrobotics.com/careers/gnc",
  ];
  for (const u of urls) assert.notStrictEqual(ats.detectAts(u), "generic");
});

test("isolation: atsCaptureChoiceOptions is a NO-OP for the three supported families", () => {
  const act = { eval: async () => { throw new Error("must not touch a non-generic run"); }, delayFull: async () => {} };
  const scan = { fields: [{ fieldName: "q", inputSel: "#q", widgetType: "select", label: "Q" }] };
  const mk = () => [{ fieldName: "q", status: "skipped" }];
  return Promise.all(["greenhouse", "lever", "ashby", "workday", undefined].map((kind) => {
    const results = mk();
    return ats.atsCaptureChoiceOptions(act, kind, scan, results).then((r) => {
      assert.strictEqual(r.captured, 0, kind + " must be untouched");
      assert.ok(!results[0].options, kind + " must be untouched");
    });
  }));
});

test("isolation: atsFormUrl leaves a generic/unknown URL untouched", () => {
  const u = "https://recruiting.paylocity.com/Recruiting/Jobs/Details/4128182";
  assert.strictEqual(ats.atsFormUrl("generic", u), u);
});

// ── WHOLE-PAGE VERIFY + REPAIR (Astrion iCIMS, live 2026-08-12) ─────────────────────────────
// "addresses (1) still is not filled — it never fills." The log said six fields `filled` with
// read-backs passing; reading the run's own tab afterwards showed every address box empty and
// AddressState back at "Please select a country", i.e. the block had been RE-RENDERED after the fill.
// The credential re-check was masking the same event for its three fields ("0 held, 3 rewritten").
test("⚠ post-fill verify: a field the page RESET to empty is re-filled", async () => {
  const live = { "#street": "715 Middlebrooks Circle", "#city": "" };   // the page blanked city
  const scanFields = [
    { fieldName: "AddressStreet1", inputSel: "#street", widgetType: "text", labelCandidates: { labelFor: "Street Address" } },
    { fieldName: "AddressCity", inputSel: "#city", widgetType: "text", labelCandidates: { labelFor: "City" } },
  ];
  let refilled = null;
  const act = genericFakeAct({
    atsInjScanGeneric: () => ({ fields: scanFields.map((f) => Object.assign({ attrId: f.fieldName, domIndex: 0 }, f)) }),
    atsInjReadValue: (a, sel) => ({ ok: true, value: live[sel] != null ? live[sel] : null }),
    atsInjSetText: (sel, v) => { live[sel] = v; refilled = sel; return { ok: true, after: v }; },
    atsInjScrollIntoView: () => ({ ok: true }),
  });
  const results = [
    { fieldName: "AddressStreet1", status: "filled", after: "715 Middlebrooks Circle", widgetType: "text" },
    { fieldName: "AddressCity", status: "filled", after: "Tallahassee", widgetType: "text" },
  ];
  const profile = { personal_info: { address_line_1: "715 Middlebrooks Circle", city: "Tallahassee" } };
  const out = await ats.atsGenericVerifyAndRepair(act, "generic", { fields: scanFields }, results,
    profile, {}, {}, ats.atsFd ? null : null, {});
  assert.strictEqual(out.reverted, 1, "only the blanked field counts as reverted");
  assert.strictEqual(refilled, "#city", "…and it is the one re-actuated");
  assert.strictEqual(live["#city"], "Tallahassee");
});

test("post-fill verify: a page that held everything costs no re-actuation", async () => {
  let writes = 0;
  const scanFields = [{ fieldName: "AddressCity", inputSel: "#city", widgetType: "text", labelCandidates: { labelFor: "City" } }];
  const act = genericFakeAct({
    atsInjScanGeneric: () => ({ fields: scanFields.map((f) => Object.assign({ attrId: f.fieldName, domIndex: 0 }, f)) }),
    atsInjReadValue: () => ({ ok: true, value: "Tallahassee" }),
    atsInjSetText: () => { writes++; return { ok: true }; },
    atsInjScrollIntoView: () => ({ ok: true }),
  });
  const results = [{ fieldName: "AddressCity", status: "filled", after: "Tallahassee", widgetType: "text" }];
  const out = await ats.atsGenericVerifyAndRepair(act, "generic", { fields: scanFields }, results, {}, {}, {}, null, {});
  assert.deepStrictEqual([out.reverted, out.repaired], [0, 0]);
  assert.strictEqual(writes, 0, "nothing is re-written when nothing was lost");
});

test("⚠ post-fill verify: a value REPLACED by something else is repaired too", async () => {
  // Operator: "email somehow fills kevinw4@gmail.com but it should be the login". That address is
  // neither the profile's nor the stored login — an outside agent (the browser password manager that
  // also filled the Login box) replaced a committed, verified value. Not blank, so the blank-only
  // test walked past it.
  const live = { "#email": "kevinw4@gmail.com" };
  const scanFields = [{ fieldName: "Email", inputSel: "#email", widgetType: "text", labelCandidates: { labelFor: "Email" } }];
  const act = genericFakeAct({
    atsInjScanGeneric: () => ({ fields: scanFields.map((f) => Object.assign({ attrId: f.fieldName, domIndex: 0 }, f)) }),
    atsInjReadValue: (a, sel) => ({ ok: true, value: live[sel] }),
    atsInjSetText: (sel, v) => { live[sel] = v; return { ok: true, after: v }; },
    atsInjScrollIntoView: () => ({ ok: true }),
  });
  const results = [{ fieldName: "Email", status: "filled", after: "wangykev@gmail.com", widgetType: "text" }];
  const profile = { personal_info: { email: "wangykev@gmail.com" } };
  const buckets = [{ id: "be", profile_path: "personal_info.email", questions: ["Email"] }];
  const out = await ats.atsGenericVerifyAndRepair(act, "generic", { fields: scanFields }, results,
    profile, {}, {}, fd.buildBucketIndex(buckets), { buckets });
  assert.strictEqual(out.reverted, 1, "a replaced value counts as lost");
  assert.strictEqual(live["#email"], "wangykev@gmail.com", "…and the profile value goes back");
});

test("⚠ post-fill verify: a page REFORMATTING our value is left alone", async () => {
  // A page is entitled to render "United States" as "United States (US)". Repairing on any
  // difference would be a second fill pass on every page — the mistake the cascade fix unlearned.
  let writes = 0;
  const scanFields = [{ fieldName: "Country", inputSel: "#ctry", widgetType: "dropdown", labelCandidates: { labelFor: "Country" } }];
  const act = genericFakeAct({
    atsInjScanGeneric: () => ({ fields: scanFields.map((f) => Object.assign({ attrId: f.fieldName, domIndex: 0 }, f)) }),
    atsInjReadValue: () => ({ ok: true, value: "United States (US)" }),
    atsInjSelectNative: () => { writes++; return { ok: true }; },
    atsInjSetText: () => { writes++; return { ok: true }; },
    atsInjScrollIntoView: () => ({ ok: true }),
  });
  const results = [{ fieldName: "Country", status: "filled", after: "United States", widgetType: "dropdown" }];
  const out = await ats.atsGenericVerifyAndRepair(act, "generic", { fields: scanFields }, results, {}, {}, {}, null, {});
  assert.strictEqual(out.reverted, 0, "a rendering of our own value is not a loss");
  assert.strictEqual(writes, 0);
});

test("isolation: the post-fill verify is generic-only", async () => {
  const act = genericFakeAct({});   // any eval would throw; a no-op proves the gate
  assert.strictEqual(await ats.atsGenericVerifyAndRepair(act, "greenhouse", { fields: [] }, [{ status: "filled", after: "x" }], {}, {}, {}, null, {}), null);
});

// ── CREDENTIALS RE-CHECKED LAST (Astrion iCIMS, live 2026-08-12) ────────────────────────────
// The operator's form showed Login holding `kevinw4@andrew.cmu.edu` with an EMPTY password while the
// run had logged both `filled` with the read-back passing. The stored login is a different address
// and a freshly-signed-in form has an EMPTY Login box, so the value arrived AFTER load — the field
// is `autocomplete="username"`, i.e. a browser password manager. Verified-then-reverted is the exact
// failure the safety contract exists to prevent, so it must never end a run reported as filled.
function credRecheckAct(page) {
  return { delayFull: async () => {}, delay: async () => {},
    eval: async (fn, ...args) => { const h = page[fn.name]; if (!h) throw new Error("no handler for " + fn.name); return h(...args); } };
}
const RECHECK_CREDS = { email: "wangykev+2@gmail.com", password: "s3cret-pw" };
const credScan = { fields: [{ fieldName: "PersonProfileFields.Login", inputSel: "#login", widgetType: "text" }] };
const credRec = () => ([{ fieldName: "PersonProfileFields.Login", credential: true, credentialKind: "login",
  status: "filled", after: "(stored login)", detail: "filled from your stored login" }]);

test("⚠ credentials: a value REPLACED after the fill is rewritten, not left wrong", async () => {
  let live = "kevinw4@andrew.cmu.edu";           // the password manager got there first
  const act = credRecheckAct({
    atsInjReadValue: () => ({ ok: true, value: live }),
    atsInjSetText: (sel, v) => { live = v; return { ok: true, after: v }; },
  });
  const results = credRec();
  const out = await ats.atsGenericCredentialRecheck(act, "generic", credScan, results, RECHECK_CREDS);
  assert.strictEqual(out.repaired, 1);
  assert.strictEqual(live, RECHECK_CREDS.email, "the stored login must end up on the page");
  assert.strictEqual(results[0].status, "filled");
  assert.ok(/written again/.test(results[0].detail), "the repair is stated, not silent");
});

test("⚠ credentials: one the page KEEPS overwriting ends needs_review — never claimed filled", async () => {
  const act = credRecheckAct({
    atsInjReadValue: () => ({ ok: true, value: "kevinw4@andrew.cmu.edu" }),   // our write never sticks
    atsInjSetText: () => ({ ok: true }),
  });
  const results = credRec();
  const out = await ats.atsGenericCredentialRecheck(act, "generic", credScan, results, RECHECK_CREDS);
  assert.strictEqual(out.lost, 1);
  assert.strictEqual(results[0].status, "needs_review");
  assert.strictEqual(results[0].flag, "credential-overwritten");
  assert.strictEqual(results[0].after, null, "no placeholder may imply it was filled");
});

test("credentials: one that HELD is left alone and costs no rewrite", async () => {
  let writes = 0;
  const act = credRecheckAct({
    atsInjReadValue: () => ({ ok: true, value: RECHECK_CREDS.email }),
    atsInjSetText: () => { writes++; return { ok: true }; },
  });
  const results = credRec();
  const out = await ats.atsGenericCredentialRecheck(act, "generic", credScan, results, RECHECK_CREDS);
  assert.deepStrictEqual([out.held, out.repaired, out.lost], [1, 0, 0]);
  assert.strictEqual(writes, 0);
  assert.strictEqual(results[0].status, "filled");
});

test("isolation: the credential re-check is generic-only and needs stored credentials", async () => {
  const act = credRecheckAct({});   // any eval would throw, so a no-op is proven by not throwing
  assert.strictEqual(await ats.atsGenericCredentialRecheck(act, "greenhouse", credScan, credRec(), RECHECK_CREDS), null);
  assert.strictEqual(await ats.atsGenericCredentialRecheck(act, "generic", credScan, credRec(), null), null);
});

// ── THE EMAIL-ONLY LOGIN GATE (Astrion iCIMS, live 2026-08-12) ──────────────────────────────
// `careers.astrion.us/jobs/24615?mode=apply` → Apply → `…icims.com/jobs/24615/login`, which asks for
// an email and nothing else, → the form. That middle page halted the run `unknown-page`.
// This types a stored credential and SUBMITS, so the guards are the whole design.
function loginGateAct(page) {
  const calls = [];
  return { calls, delayFull: async () => {},
    eval: async (fn, ...args) => {
      const name = fn.name || "anon";
      calls.push([name, ...args]);
      const h = page[name] || (name === "anon" ? page.anon : null);
      if (!h) throw new Error("no handler for " + name);
      return h(...args);
    } };
}

test("login gate: types the STORED email, submits, and reports passing once the page advances", async () => {
  let advanced = false, typed = null, clicked = null;
  const act = loginGateAct({
    atsInjLoginGate: () => (advanced
      ? { ok: true, isGate: false, reason: "12 fillable field(s) — a login gate has exactly one" }
      : { ok: true, isGate: true, emailSel: '[id="email"]', submitSel: 'input[type="submit"]', submitLabel: "Next" }),
    atsInjSetText: (sel, v) => { if (v) typed = v; return { ok: true, after: v }; },
    atsInjReadValue: () => ({ ok: true, value: typed }),
    atsInjScrollIntoView: () => ({ ok: true }),
    anon: (sel) => { clicked = sel; advanced = true; return { ok: true }; },
  });
  const r = await ats.atsPassLoginGate(act, { email: "me@example.com", password: "pw" });
  assert.strictEqual(r.passed, true);
  assert.strictEqual(typed, "me@example.com", "the STORED login email is what gets typed");
  assert.strictEqual(clicked, 'input[type="submit"]');
  // the box is CLEARED before the write, same rule the credential tier follows
  const sets = act.calls.filter((c) => c[0] === "atsInjSetText");
  assert.strictEqual(sets[0][2], "", "the field is cleared first");
});

test("⚠ login gate: NO stored credentials means needs_operator — never a blank or guessed login", async () => {
  let wrote = false;
  const act = loginGateAct({
    atsInjLoginGate: () => ({ ok: true, isGate: true, emailSel: '[id="email"]', submitSel: "#go", submitLabel: "Next" }),
    atsInjSetText: () => { wrote = true; return { ok: true }; },
  });
  const r = await ats.atsPassLoginGate(act, null);
  assert.strictEqual(r.passed, false);
  assert.strictEqual(r.needsOperator, true);
  assert.strictEqual(wrote, false, "nothing may be written without stored credentials");
});

test("⚠ login gate: a read-back that disagrees NEVER submits", async () => {
  let clicked = false;
  const act = loginGateAct({
    atsInjLoginGate: () => ({ ok: true, isGate: true, emailSel: '[id="email"]', submitSel: "#go", submitLabel: "Next" }),
    atsInjSetText: () => ({ ok: true }),
    atsInjReadValue: () => ({ ok: true, value: "" }),        // the write did not take
    atsInjScrollIntoView: () => ({ ok: true }),
    anon: () => { clicked = true; return { ok: true }; },
  });
  const r = await ats.atsPassLoginGate(act, { email: "me@example.com", password: "pw" });
  assert.strictEqual(r.passed, false);
  assert.strictEqual(clicked, false, "a login we could not verify must never be submitted");
});

test("login gate: a page that is NOT a one-field login is declined, and the caller carries on", async () => {
  const act = loginGateAct({ atsInjLoginGate: () => ({ ok: true, isGate: false, reason: "a password field is present — not an email-only gate" }) });
  const r = await ats.atsPassLoginGate(act, { email: "me@example.com", password: "pw" });
  assert.strictEqual(r.passed, false);
  assert.ok(!r.needsOperator, "declining is not an operator stop — the run continues its ladder");
});

test("login gate: the last rung asks the FORM to submit, running its own handlers", () => {
  // requestSubmit() runs validation + submit handlers; .submit() skips them, so it is only the
  // fallback-of-the-fallback. Needs no coordinates and no event dispatch, which is the point.
  const src = ats.atsInjSubmitLoginForm.toString();
  assert.ok(/requestSubmit/.test(src), "requestSubmit is preferred");
  assert.ok(src.indexOf("requestSubmit") < src.indexOf("form.submit()"), "…and tried BEFORE bare submit()");
  assert.ok(/not inside a form/.test(src), "a control with no form is reported, not thrown on");
});

test("⚠ login gate: the injected probe demands ONE fillable field, no password, and a named email box", () => {
  const src = ats.atsInjLoginGate.toString();
  assert.ok(/fillable\.length !== 1/.test(src), "exactly one fillable control");
  assert.ok(/pw\.length/.test(src), "a password field must disqualify it");
  assert.ok(/email\|login\|user/.test(src), "the field must name itself an email/login");
  assert.ok(/no submit control/.test(src), "a submit control is required");
});

// ── RÉSUMÉ PARSE POSTBACK (iCIMS, live 2026-08-12) ──────────────────────────────────────────
// The portal parses the attached résumé server-side and posts the result back into the SAME panel,
// re-creating the repeating entries under server-assigned ids. That landed MID-FILL and blanked
// everything written before it: the run logged `-1_…AddressStreet1 → filled` with a verified
// read-back while the operator saw an empty "Addresses (1)". These pin the fix — attach FIRST, wait
// for the field set to stop moving, then fill against the settled page.
function icimsParsePage() {
  const RESUME = { attrId: "PortalProfileFields.Resume_File", inputSel: "#resume", widgetType: "file_upload",
    domIndex: 0, labelCandidates: { labelFor: "Resume" } };
  const before = { fields: [RESUME,
    { attrId: "-1_PersonProfileFields.AddressStreet1", inputSel: "#a1", widgetType: "text", domIndex: 1,
      labelCandidates: { labelFor: "Street Address*" }, sectionHeading: "Addresses (1)" }] };
  // after the parse: the entry is re-created under a server id, blank again
  const after = { fields: [RESUME,
    { attrId: "-6489345_PersonProfileFields.AddressStreet1", inputSel: "#a2", widgetType: "text", domIndex: 1,
      labelCandidates: { labelFor: "Street Address*" }, sectionHeading: "Addresses (1)" }] };
  return { before, after };
}

test("INTEGRATION (generic): a résumé-parse postback cannot blank the fill — the address lands on the SETTLED entry", async () => {
  const { before, after } = icimsParsePage();
  const values = {};
  let attached = 0;
  const act = genericFakeAct({
    // scan #1 is pre-attach; every later scan shows the re-rendered panel
    atsInjScanGeneric: () => JSON.parse(JSON.stringify(attached ? after : before)),
    atsInjSetText: (sel, v) => { values[sel] = v; return { ok: true, after: v }; },
    atsInjReadValue: (a, sel) => ({ ok: true, value: values[sel] != null ? values[sel] : null }),
    atsInjScrollIntoView: () => ({ ok: true }),
    atsInjSubmitState: () => ({ ok: true, hasSubmit: true, multiStep: false, captchaChallenge: false, confirmed: false }),
    atsInjErrors: () => ({ ok: true, errors: [] }),
    attachResume: async () => { attached++; return { ok: true, name: "resume.pdf", verified: true }; },
  });
  const profile = Object.assign({}, GENERIC_PROFILE, { address_line_1: "715 Middlebrooks Circle" });
  const buckets = GENERIC_BUCKETS.concat([{ id: "ba", profile_path: "address_line_1", questions: ["Street Address"] }]);
  const out = await ats.driveAtsPageFill(act, "generic", profile, {}, {}, { buckets });

  assert.strictEqual(attached, 1, "the résumé attaches exactly once");
  // the load-bearing assertion: the value is on the POST-postback element, not the one that was
  // replaced. Writing to #a1 is precisely the bug — it verifies, then vanishes.
  assert.strictEqual(values["#a2"], "715 Middlebrooks Circle", "the address must land on the settled entry");
  assert.ok(values["#a1"] === undefined, "nothing may be written to the entry the postback replaced");
  const rec = (out.results || []).find((r) => /AddressStreet1/.test(r.fieldName));
  assert.ok(rec && rec.status === "filled", "the address must be recorded filled");
  assert.ok(/6489345/.test(rec.fieldName), "the record must name the surviving entry");
});

test("INTEGRATION (generic): a form whose field set does NOT move pays no re-fill and keeps one attach", async () => {
  // the other half of the contract — the settle poll exits on two agreeing scans, so a portal that
  // never re-renders must fill exactly as before (no duplicate writes, no second résumé attach).
  const { before } = icimsParsePage();
  const values = {}; let attached = 0, writes = 0;
  const act = genericFakeAct({
    atsInjScanGeneric: () => JSON.parse(JSON.stringify(before)),
    atsInjSetText: (sel, v) => { writes++; values[sel] = v; return { ok: true, after: v }; },
    atsInjReadValue: (a, sel) => ({ ok: true, value: values[sel] != null ? values[sel] : null }),
    atsInjScrollIntoView: () => ({ ok: true }),
    atsInjSubmitState: () => ({ ok: true, hasSubmit: true, multiStep: false, captchaChallenge: false, confirmed: false }),
    atsInjErrors: () => ({ ok: true, errors: [] }),
    attachResume: async () => { attached++; return { ok: true, name: "resume.pdf", verified: true }; },
  });
  const profile = Object.assign({}, GENERIC_PROFILE, { address_line_1: "715 Middlebrooks Circle" });
  const buckets = GENERIC_BUCKETS.concat([{ id: "ba", profile_path: "address_line_1", questions: ["Street Address"] }]);
  await ats.driveAtsPageFill(act, "generic", profile, {}, {}, { buckets });
  assert.strictEqual(attached, 1, "one attach");
  assert.strictEqual(writes, 1, "the address is written exactly once");
  assert.strictEqual(values["#a1"], "715 Middlebrooks Circle");
});

test("LIVE iCIMS headings: only the HOME address block may take the profile address", () => {
  // Measured on the live Astrion form, 2026-08-12, using the scanner's own h1–h6 rule. ⚠ The address
  // block's nearest HEADING is "Enter your information" — "Addresses (1)" is a <legend>, which the
  // scanner does not read — so the home address is recognised by its NAME, and the heading only ever
  // has to push the other blocks away.
  const at = (fieldName, sectionHeading) => ats.atsGenericScopeOf({ fieldName, sectionHeading, label: "" });
  assert.strictEqual(at("-1_PersonProfileFields.AddressCity", "Enter your information"), "address");
  assert.strictEqual(at("-1_PersonProfileFields.rcf3265", "Experience"), "work");
  assert.strictEqual(at("-1_PersonProfileFields.rcf3217", "Experience"), "work");
  assert.strictEqual(at("-1_CandProfileFields.EducationCity", "Education"), "education");
  assert.strictEqual(at("-1_PersonProfileFields.rcf2065", "Professional Certifications (1)"), "other-entity");

  const profile = { personal_info: { city: "Tallahassee", state_province: "Florida", postal_code: "32312" } };
  const claims = (fieldName, sectionHeading, label) =>
    !!ats.atsGenericAddressValue(profile, { fieldName, sectionHeading, label });
  assert.strictEqual(claims("-1_PersonProfileFields.AddressCity", "Enter your information", "City"), true);
  // the three the operator caught filling with the HOME address
  assert.strictEqual(claims("-1_PersonProfileFields.rcf3265", "Experience", "Zip"), false, "employer zip");
  assert.strictEqual(claims("-1_PersonProfileFields.rcf3217", "Experience", "State"), false, "employer state");
  assert.strictEqual(claims("-1_PersonProfileFields.rcf2065", "Professional Certifications (1)", "City"), false,
    "a certification's city is the issuing body's");
});

test("the résumé pre-pass is GENERIC-ONLY and never runs on a replay", () => {
  // Greenhouse / Lever / Ashby do not parse-and-repopulate, and a replay must keep its own ordering —
  // so the hoist is gated twice. Pinned on the source because the gate is the whole isolation story.
  const src = ats.driveAtsPageFill.toString();
  assert.ok(/ats === "generic" && !o\.valueFor/.test(src),
    'the pre-pass must be gated on ats === "generic" && !o.valueFor');
});

// ── THE AI ONLY SEES ITS OWN ENTRY (operator, 2026-08-12) ───────────────────────────────────
// "if inside education it asks for state and city, it should only look for values in the profile
// repeating section for education… education 0 to AI for the education 0 field, and education 1, AI
// only gets education 1 … so it can determine that carnegie mellon is in pittsburgh rather than
// following the tallahassee answer from a different part of my profile."
// Live, `EducationCity → ai-text · "Tallahassee" · AI: "City is listed in personal info address."`
// The model was not hallucinating — it was shown a fact that had no business being in front of it.
const SCOPE_PROFILE = {
  personal_info: { city: "Tallahassee", state_province: "Florida", email: "wangykev@gmail.com" },
  education: [
    { school_or_university: "Carnegie Mellon University", degree: "Bachelor of Science", currently_enrolled: true },
    { school_or_university: "Some Other College", degree: "Associate", to: "2020" },
  ],
  work_experience: [{ company: "Acme", title: "Intern" }],
};

test("⚠ AI scope: an education field's profile view holds ONLY that entry — no home city at all", () => {
  const f = { fieldName: "-1_CandProfileFields.EducationCity", label: "City", sectionHeading: "Education", entryOrdinal: 0 };
  const view = ats.atsGenericProfileForAi(SCOPE_PROFILE, f);
  assert.deepStrictEqual(Object.keys(view), ["education"], "nothing but the education section reaches the model");
  assert.strictEqual(view.education.length, 1, "and only ONE entry");
  assert.strictEqual(view.education[0].school_or_university, "Carnegie Mellon University");
  // the actual defect: the home city must be UNREACHABLE, not merely unlikely to be chosen
  assert.ok(!JSON.stringify(view).includes("Tallahassee"), "the home city cannot appear in the prompt");
  assert.ok(!JSON.stringify(view).includes("Some Other College"), "nor a sibling entry");
});

test("⚠ AI scope: entry 1 gets entry 1 — never entry 0's school", () => {
  const f = { fieldName: "-1_CandProfileFields.EducationCity", label: "City", sectionHeading: "Education", entryOrdinal: 1 };
  const view = ats.atsGenericProfileForAi(SCOPE_PROFILE, f);
  assert.strictEqual(view.education.length, 1);
  assert.strictEqual(view.education[0].school_or_university, "Some Other College");
  assert.ok(!JSON.stringify(view).includes("Carnegie Mellon"), "entry 0 is invisible to entry 1's question");
});

test("AI scope: a WORK entry is scoped the same way, and an unscoped field still sees everything", () => {
  const w = { fieldName: "-1_PersonProfileFields.rcf3216", label: "City", sectionHeading: "Experience", entryOrdinal: 0 };
  const wv = ats.atsGenericProfileForAi(SCOPE_PROFILE, w);
  assert.deepStrictEqual(Object.keys(wv), ["work_experience"]);
  assert.ok(!JSON.stringify(wv).includes("Tallahassee"));
  // an ordinary question is unchanged — this must not become a page-wide narrowing
  const plain = { fieldName: "PersonProfileFields.Email", label: "Email", sectionHeading: "Enter your information", entryOrdinal: 0 };
  assert.strictEqual(ats.atsGenericProfileForAi(SCOPE_PROFILE, plain), SCOPE_PROFILE);
  assert.strictEqual(ats.atsGenericAiScopeKey(plain), "", "no scope key means no narrowing");
});

test("⚠ AI scope: the answer CACHE is keyed per entry, so two schools cannot share one city", () => {
  // Answers are cached by QUESTION so a cascade re-mount reuses one already paid for. Inside a
  // repeating section that rule inverts: both entries ask "City" and must get DIFFERENT answers.
  assert.strictEqual(ats.atsGenericAiScopeKey({ label: "City", sectionHeading: "Education", entryOrdinal: 0 }), "education#0");
  assert.strictEqual(ats.atsGenericAiScopeKey({ label: "City", sectionHeading: "Education", entryOrdinal: 1 }), "education#1");
  assert.notStrictEqual(ats.atsGenericAiScopeKey({ label: "City", sectionHeading: "Education", entryOrdinal: 0 }),
    ats.atsGenericAiScopeKey({ label: "City", sectionHeading: "Education", entryOrdinal: 1 }));
});

test("⚠ AI scope: an entry the profile does not have yields an EMPTY section, never a borrowed one", () => {
  const f = { fieldName: "x", label: "City", sectionHeading: "Education", entryOrdinal: 7 };
  const view = ats.atsGenericProfileForAi(SCOPE_PROFILE, f);
  assert.deepStrictEqual(view, { education: [] }, "blank is the correct answer, not another entry's city");
});

// ── THE PROMPT ITSELF (operator: "the prompt you gave it is not good") ──────────────────────
// Scoping stopped the WRONG answer (Tallahassee) but produced a USELESS one: "N/A" written into a
// required field. Dumping the actual prompt showed three faults, and all three were in the prompt,
// not the model: the question read `{"question":"City"}` with the school's name nowhere in it; the
// SYSTEM prompt said to answer what "the profile clearly holds" and never permitted public
// knowledge, so a permission sitting in the USER message lost to it; and nothing forbade "N/A".
// ── THE WORK-EXPERIENCE TIER (operator, 2026-08-12) ─────────────────────────────────────────
// "the employer is somehow rivian and volkswagon technologies, The title is also always
// characterization." The AI SCOPING for work already worked — the batch splits work#0/1/2 and the
// justifications name the right company. What was missing was the deterministic half: education had
// a value tier and work had none, so every employer/title/date was an AI guess. A stored fact
// answered by inference is the inversion the match ladder exists to prevent.
const WORK_PROFILE = { work_experience: [
  { job_title: "CISCOR Robotics Lab Intern", company: "Florida State University / L3Harris", location: "Tallahassee, FL", from: "2025-05", to: "2025-08" },
  { job_title: "Firmware Team Member", company: "Carnegie Mellon Racing", location: "Pittsburgh, PA", from: "2024-09", currently_work_here: true },
] };

test("⚠ work tier: each entry answers from ITS OWN job — never one value repeated", () => {
  const v = (label, ord) => { const r = ats.atsGenericWorkValue(WORK_PROFILE, label, ord); return r && r.value; };
  // ordered by RECENCY, so entry 0 is the current job — not the profile's array order
  assert.strictEqual(v("Employer", 0), "Carnegie Mellon Racing");
  assert.strictEqual(v("Title", 0), "Firmware Team Member");
  assert.strictEqual(v("Employer", 1), "Florida State University / L3Harris");
  assert.strictEqual(v("Title", 1), "CISCOR Robotics Lab Intern");
  assert.notStrictEqual(v("Title", 0), v("Title", 1), "the defect was every entry sharing one title");
});

test("work tier: one 'City, ST' string serves the form's separate City and State controls", () => {
  const v = (label, ord) => { const r = ats.atsGenericWorkValue(WORK_PROFILE, label, ord); return r && r.value; };
  assert.strictEqual(v("City", 0), "Pittsburgh");
  // ⚠ expanded, because a 2-char token is what matchCandidates refuses to guess with (the "PA" →
  // "Armed Forces Pacific" lesson) — an unexpanded "PA" would reach a dropdown and match nothing.
  assert.strictEqual(v("State/Province", 0), "Pennsylvania");
  assert.strictEqual(v("State", 1), "Florida");
});

test("⚠ work tier: a CURRENT job leaves End Date empty, and a missing entry yields nothing", () => {
  const v = (label, ord) => { const r = ats.atsGenericWorkValue(WORK_PROFILE, label, ord); return r && r.value; };
  assert.strictEqual(v("Start Date", 0), "2024-09");
  assert.ok(!v("End Date", 0), "still employed ⇒ no end date, not a guessed one");
  assert.strictEqual(v("End Date", 1), "2025-08");
  assert.ok(!v("Employer", 7), "an entry the profile lacks is BLANK, never borrowed");
});

test("⚠ work tier: one stored date serves a THREE-control composite and a single input alike", () => {
  // Live, `rcf3214_Year` received the whole "2024-09" because the tier returned the raw value.
  const v = (label) => { const r = ats.atsGenericWorkValue(WORK_PROFILE, label, 0); return r && r.value; };
  assert.strictEqual(v("Start Date Year"), "2024");
  assert.deepStrictEqual(v("Start Date Month"), ["September", "09", "9", "Sep"]);
  // …and a form with ONE date box still gets the whole date: `atsGenericDatePart` reads the label to
  // pick a piece, and a bare "Start Date" contains "date", so it is taken for a day-of-month control.
  assert.strictEqual(v("Start Date"), "2024-09", "a single date input must not be starved by the splitter");
});

test("⚠ work tier is SCOPE-GATED — it may not answer a field outside an experience entry", () => {
  // "Title"/"Employer"/"City" are not self-evidently employment the way "School"/"Degree" are.
  const inWork = { fieldName: "-1_PersonProfileFields.rcf3213", label: "City", sectionHeading: "Experience", entryOrdinal: 0 };
  const inAddr = { fieldName: "-1_PersonProfileFields.AddressCity", label: "City", sectionHeading: "Enter your information", entryOrdinal: 0 };
  assert.strictEqual(ats.atsGenericScopeOf(inWork), "work");
  assert.notStrictEqual(ats.atsGenericScopeOf(inAddr), "work");
  const src = ats.atsRouteField.toString();
  assert.match(src, /atsGenericScopeOf\(f\) === "work"/, "the router must gate the work tier on scope");
});

test("⚠ 'graduated' needs no question mark — a stored fact must not lose to a guess", () => {
  // Live: iCIMS names the field `IsGraduated` and labels it without a "?", so the old
  // /graduated\?/ never matched, the deterministic tier never saw it, and the AI answered "Yes" from
  // a 2028 graduation date for someone still enrolled.
  const enrolled = { education: [{ school_or_university: "Carnegie Mellon University", currently_enrolled: true, graduation_date: "2028-05" }] };
  for (const label of ["Graduated", "Is Graduated", "Did You Graduate?", "Graduated?"]) {
    const v = ats.atsGenericEducationValue(enrolled, label, 0);
    assert.ok(v, `"${label}" must be recognised by the education tier`);
    assert.strictEqual(v.value, false, `"${label}" → currently enrolled means NO`);
  }
  // …and a finished degree still answers YES
  const done = { education: [{ school_or_university: "X", to_year: "2020" }] };
  assert.strictEqual(ats.atsGenericEducationValue(done, "Graduated", 0).value, true);
  // ⚠ "Graduation Date" must NOT be captured by it — that is a date question, not a yes/no
  const gd = ats.atsGenericEducationValue(enrolled, "Graduation Date", 0);
  assert.ok(!gd || gd.value !== false, "'Graduation Date' is a date, not the graduated flag");
});

test("⚠ skipResume: the résumé is NOT attached, and the record says so out loud", async () => {
  // Operator, 2026-08-12: "skip the resume upload for now. that parser gets a lot of things wrong,
  // first I want to make sure you can fill the form correctly." A TEST LEVER, not a fix — on iCIMS
  // the upload triggers a parse that re-renders the panel and rewrites filled fields. A run that
  // quietly stopped attaching the résumé would be a serious silent change to what the employer
  // receives, so the field must end up flagged, never merely absent.
  const RESUME = { attrId: "PortalProfileFields.Resume_File", inputSel: "#resume", widgetType: "file_upload",
    domIndex: 0, labelCandidates: { labelFor: "Resume" } };
  let attached = 0;
  const act = genericFakeAct({
    atsInjScanGeneric: () => ({ fields: [JSON.parse(JSON.stringify(RESUME))] }),
    atsInjReadValue: () => ({ ok: true, value: null }),
    atsInjScrollIntoView: () => ({ ok: true }),
    atsInjSubmitState: () => ({ ok: true, hasSubmit: true, multiStep: false, captchaChallenge: false, confirmed: false }),
    atsInjErrors: () => ({ ok: true, errors: [] }),
    attachResume: async () => { attached++; return { ok: true, name: "resume.pdf", verified: true }; },
  });
  const out = await ats.driveAtsPageFill(act, "generic", GENERIC_PROFILE, {}, {}, { skipResume: true });
  assert.strictEqual(attached, 0, "nothing may be uploaded when the skip is on");
  const rec = (out.results || []).find((r) => /Resume/i.test(r.fieldName));
  assert.strictEqual(rec.status, "skipped");
  assert.strictEqual(rec.flag, "resume-skipped", "flagged, so it cannot pass for a normal run");
  assert.match(rec.detail, /attach it yourself/);
});

test("skipResume OFF (the default) still attaches — the lever must be opt-in", async () => {
  const RESUME = { attrId: "PortalProfileFields.Resume_File", inputSel: "#resume", widgetType: "file_upload",
    domIndex: 0, labelCandidates: { labelFor: "Resume" } };
  let attached = 0;
  const act = genericFakeAct({
    atsInjScanGeneric: () => ({ fields: [JSON.parse(JSON.stringify(RESUME))] }),
    atsInjReadValue: () => ({ ok: true, value: null }),
    atsInjScrollIntoView: () => ({ ok: true }),
    atsInjSubmitState: () => ({ ok: true, hasSubmit: true, multiStep: false, captchaChallenge: false, confirmed: false }),
    atsInjErrors: () => ({ ok: true, errors: [] }),
    attachResume: async () => { attached++; return { ok: true, name: "resume.pdf", verified: true }; },
  });
  await ats.driveAtsPageFill(act, "generic", GENERIC_PROFILE, {}, {}, {});
  assert.strictEqual(attached, 1, "absent flag ⇒ the résumé is attached exactly as before");
});

test("⚠ THE ENTRY CONTAINER decides the ordinal — city and state cannot disagree", () => {
  // Live: the three experience blocks appear in DOM order -7560267, -7560269, -7560268, so a
  // POSITIONAL counter gave the k-th "City" and the k-th "State" different entries. Every value was
  // real and the record was nonsense: Carnegie Mellon Racing in Pittsburgh, FLORIDA; FSU in
  // Tallahassee, PENNSYLVANIA. The entry id is on the page — use it.
  const mk = (id, label, i) => ({ attrId: id + "_PersonProfileFields." + (label === "City" ? "rcf3216" : "rcf3217"),
    inputSel: "#" + i, widgetType: "text", domIndex: i, labelCandidates: { labelFor: label }, sectionHeading: "Experience" });
  const s = ats.atsGenericPostProcess({ fields: [
    mk("-7560267", "City", 0), mk("-7560267", "State", 1),
    mk("-7560269", "City", 2), mk("-7560268", "State", 3),
    mk("-7560268", "City", 4), mk("-7560269", "State", 5),
  ] });
  const ord = (id, rcf) => s.fields.find((f) => f.fieldName.startsWith(id) && f.fieldName.endsWith(rcf)).entryOrdinal;
  for (const id of ["-7560267", "-7560268", "-7560269"]) {
    assert.strictEqual(ord(id, "rcf3216"), ord(id, "rcf3217"), `${id}: city and state must be the SAME entry`);
  }
  // first appearance order, so the first block on the page is entry 0
  assert.strictEqual(ord("-7560267", "rcf3216"), 0);
  assert.strictEqual(ord("-7560269", "rcf3216"), 1);
  assert.strictEqual(ord("-7560268", "rcf3216"), 2);
});

test("⚠ THE ENTRY ORDINAL COUNTS WITHIN ITS SECTION, NOT THE PAGE", () => {
  // The bug behind the "N/A" that no prompt wording could fix. "City" appears in the address block,
  // the education entry AND each work entry, and the ordinal counted every one of them: live,
  // `CandProfileFields.EducationCity` was numbered 1 or 2. Cosmetic until entry ordinals began
  // SELECTING which profile entry the AI may see — then it handed education entry 1 (or an empty
  // one) to a question about entry 0, so the school's name never reached the prompt at all.
  const raw = { fields: [
    { attrId: "-1_PersonProfileFields.AddressCity", inputSel: "#a", widgetType: "text", domIndex: 0, labelCandidates: { labelFor: "City" }, sectionHeading: "Enter your information" },
    { attrId: "-1_CandProfileFields.EducationCity", inputSel: "#b", widgetType: "text", domIndex: 1, labelCandidates: { labelFor: "City" }, sectionHeading: "Education" },
    { attrId: "-1_PersonProfileFields.rcf3216", inputSel: "#c", widgetType: "text", domIndex: 2, labelCandidates: { labelFor: "City" }, sectionHeading: "Experience" },
  ] };
  const s = ats.atsGenericPostProcess(raw);
  const by = (frag) => s.fields.find((f) => f.fieldName.includes(frag));
  assert.strictEqual(by("EducationCity").entryOrdinal, 0, "the FIRST city inside education is education entry 0");
  assert.strictEqual(by("rcf3216").entryOrdinal, 0, "…and the first inside experience is work entry 0");
  assert.strictEqual(ats.atsGenericAiScopeKey(by("EducationCity")), "education#0");
  assert.strictEqual(ats.atsGenericAiScopeKey(by("rcf3216")), "work#0");
  // and the school name therefore reaches the prompt
  assert.strictEqual(ats.atsGenericEntryLabel(ats.atsGenericProfileForAi(SCOPE_PROFILE, by("EducationCity")), by("EducationCity")),
    "Carnegie Mellon University");
});

test("⚠ entry label: reads the ALREADY-SCOPED view — it must not scope twice", () => {
  // The batch hands this the profile it is about to send, which already holds ONE entry. Re-applying
  // the ordinal to a one-element list returned undefined for every entry after the first, so those
  // questions lost the very name that makes them answerable.
  const f1 = { label: "City", sectionHeading: "Education", entryOrdinal: 1 };
  const scoped = ats.atsGenericProfileForAi(SCOPE_PROFILE, f1);   // {education:[Some Other College]}
  assert.strictEqual(ats.atsGenericEntryLabel(scoped, f1), "Some Other College");
});

test("⚠ prompt: the question NAMES what it is about — not just a bare label", () => {
  const f = { fieldName: "x", label: "City", sectionHeading: "Education", entryOrdinal: 0 };
  assert.strictEqual(ats.atsGenericEntryLabel(SCOPE_PROFILE, f), "Carnegie Mellon University");
  const items = [{ id: "q1", kind: "text", question: "City", about: ats.atsGenericEntryLabel(SCOPE_PROFILE, f) }];
  const p = ats.atsBuildBatchPrompt(items, ats.atsGenericProfileForAi(SCOPE_PROFILE, f), {}, ats.atsGenericEntryScopeNote(f));
  const qline = p.user.split("\n")[0];
  assert.match(qline, /"about":"Carnegie Mellon University"/, "the subject must be IN the question JSON");
  assert.ok(!p.user.includes("Tallahassee"), "and the home city still cannot appear anywhere");
});

test("⚠ prompt: the public-knowledge permission lives in the SYSTEM prompt, and N/A is WANTED", () => {
  // Where the permission lives is the point: one that contradicts a system instruction has to sit
  // beside it. As a user-message note it was ignored and the answer came back "N/A".
  const p = ats.atsBuildBatchPrompt([{ id: "q1", kind: "text", question: "City", about: "X University" }], {}, {}, "");
  assert.match(p.system, /"about" field asks for a property of THAT named organization/);
  assert.match(p.system, /ANSWER IT from your own knowledge/);
  assert.match(p.system, /Facts about the APPLICANT still may not be invented/, "the limit travels with the permission");
  // ⚠ I had banned "N/A" as junk; the operator overruled it (2026-08-12) and the reasons stick:
  // a MULTI-PAGE form cannot advance past an empty required field, so the walk never reaches the
  // rest of the form to review it; and a visible "N/A" gets corrected where a blank reads as
  // "nothing to do". An honest placeholder beats both a blank and a guess.
  assert.match(p.system, /write "N\/A" rather than inventing something/);
  assert.ok(!/NEVER write "N\/A"/.test(p.system), "the ban must be gone, not merely contradicted");
});

test("prompt: a question with no entry scope carries no `about` and is unchanged", () => {
  const plain = { fieldName: "Email", label: "Email", sectionHeading: "Enter your information", entryOrdinal: 0 };
  assert.strictEqual(ats.atsGenericEntryLabel(SCOPE_PROFILE, plain), "");
  const p = ats.atsBuildBatchPrompt([{ id: "q1", kind: "text", question: "Email", about: "" }], SCOPE_PROFILE, {}, "");
  assert.ok(!p.user.split("\n")[0].includes('"about"'), "an unscoped question gains no about field");
});

test("isolation: AI scoping is generic-only at the call sites", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "ats.js"), "utf8");
  assert.ok((src.match(/ats === "generic" \? atsGenericProfileForAi/g) || []).length >= 1,
    "the per-field fallback must scope only on the generic path");
  assert.match(src, /const aiScope = ats === "generic" \? atsGenericAiScopeKey/, "…and so must the cache key");
});
