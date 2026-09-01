// test/ats-ashby-checkbox-group.test.js — Ashby's DECLARED checkbox groups.
//
// Live 2026-08-31, Notion (Software Engineer Intern, Summer 2027): the Ashby scan branch treated
// every checkbox in an entry as its own consent box — an assumption written for OpenAI's consent
// checkboxes ("one per entry") that Notion's "select all that apply" questions break. Four grouped
// questions became TWENTY-ONE phantom fields, each labelled with its own OPTION text, and the
// questions themselves never reached the review bundle at all.
//
// Two consequences, both read off that live bundle rather than reasoned about:
//
//   • THE LABEL LADDER ROUTES ON THE LABEL. The phantom labelled "LinkedIn" resolved to
//     canonical_field `websites.0.url`, so the fill tried to write the operator's LinkedIn PROFILE
//     URL into a checkbox meaning "I heard about this job on LinkedIn". It landed in needs_review
//     only because a URL matches no option — luck of the value, not a refusal.
//   • REQUIRED-NESS IS DECLARED ON THE QUESTION, NOT THE BOXES. Three of the four groups are
//     required; every phantom reported isRequired:false. That is the dangerous direction — a
//     required field reading false hides a field that will block submission.
//
// ⚠ THIS FILE EXECUTES `atsInjScan` FOR REAL. Every other suite stubs it, which is precisely why a
// scan-shape bug of this size survived: nothing ran it. The DOM double below implements only the
// selector forms the Ashby branch actually uses (tag, .class, [attr="v"], [attr*="v"], and comma
// lists) — deliberately small, and it throws on anything it does not understand so that a future
// selector cannot be silently mismatched into a passing test.
//
// Run: node --test test/ats-ashby-checkbox-group.test.js

const test = require("node:test");
const assert = require("node:assert");
const ats = require("../ats.js");

// ── a very small DOM ────────────────────────────────────────────────────────────────────
// Supports exactly: "tag", ".cls", "[a=\"v\"]", "[a*=\"v\"]", "tag[a=\"v\"]", "tag.cls",
// and comma-separated unions of those. Anything else throws.
function parseSimple(sel) {
  const s = sel.trim();
  const m = /^([a-zA-Z]+)?((?:\.[A-Za-z0-9_-]+)*)((?:\[[^\]]+\])*)$/.exec(s);
  if (!m) throw new Error("DOM double: unsupported selector " + JSON.stringify(sel));
  const tag = m[1] ? m[1].toLowerCase() : null;
  const classes = (m[2] || "").split(".").filter(Boolean);
  const attrs = [];
  for (const raw of (m[3] || "").match(/\[[^\]]+\]/g) || []) {
    const a = /^\[([A-Za-z_:][-A-Za-z0-9_:.]*)([*^$]?=)"([^"]*)"\]$/.exec(raw);
    if (!a) throw new Error("DOM double: unsupported attribute selector " + raw);
    attrs.push({ name: a[1], op: a[2], value: a[3] });
  }
  return { tag, classes, attrs };
}
function parseSelector(sel) { return String(sel).split(",").map(parseSimple); }

let DOC_SEQ = 0;

class El {
  constructor(tag, attrs, kids) {
    this.tagName = String(tag).toUpperCase();
    this._attrs = Object.assign({}, attrs || {});
    this.children = [];
    this.parentElement = null;
    this._seq = DOC_SEQ++;
    this._text = this._attrs.text || "";
    delete this._attrs.text;
    // input-ish properties the scan reads directly
    this.type = this._attrs.type || (this.tagName === "INPUT" ? "text" : undefined);
    this.name = this._attrs.name || "";
    this.id = this._attrs.id || "";
    this.value = this._attrs.value == null ? "" : this._attrs.value;
    this.checked = !!this._attrs.checked;
    this.required = !!this._attrs.required;
    for (const k of kids || []) this.append(k);
  }
  append(child) { child.parentElement = this; this.children.push(child); return this; }
  get className() { return this._attrs.class || ""; }
  get classList() {
    const list = this.className.split(/\s+/).filter(Boolean);
    return { contains: (c) => list.indexOf(c) !== -1 };
  }
  getAttribute(n) { return Object.prototype.hasOwnProperty.call(this._attrs, n) ? this._attrs[n] : null; }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  getBoundingClientRect() { return { width: 100, height: 20 }; }
  compareDocumentPosition(other) { return other._seq > this._seq ? 4 : 2; }
  _matchesOne(p) {
    if (p.tag && this.tagName !== p.tag.toUpperCase()) return false;
    const cls = this.className.split(/\s+/).filter(Boolean);
    for (const c of p.classes) if (cls.indexOf(c) === -1) return false;
    for (const a of p.attrs) {
      let v = a.name === "type" ? this.type : a.name === "name" ? this.name : a.name === "id" ? this.id : this.getAttribute(a.name);
      if (a.name === "class") v = this.className;
      if (v == null) return false;
      v = String(v);
      if (a.op === "=" && v !== a.value) return false;
      if (a.op === "*=" && v.indexOf(a.value) === -1) return false;
    }
    return true;
  }
  matches(sel) { return parseSelector(sel).some((p) => this._matchesOne(p)); }
  _descendants(acc) { for (const c of this.children) { acc.push(c); c._descendants(acc); } return acc; }
  querySelectorAll(sel) {
    const ps = parseSelector(sel);
    return this._descendants([]).filter((el) => ps.some((p) => el._matchesOne(p)));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel) {
    const ps = parseSelector(sel);
    let n = this;
    while (n) { if (ps.some((p) => n._matchesOne(p))) return n; n = n.parentElement; }
    return null;
  }
}
const el = (tag, attrs, kids) => new El(tag, attrs, kids);

function installDom(root) {
  global.window = { CSS: { escape: (s) => String(s).replace(/(["\\])/g, "\\$1") } };
  global.CSS = global.window.CSS;
  global.location = { href: "https://jobs.ashbyhq.com/notion/3fba1c39/application" };
  global.document = {
    title: "Software Engineer Intern (Summer 2027) @ Notion",
    querySelectorAll: (s) => root.querySelectorAll(s),
    querySelector: (s) => root.querySelector(s),
  };
}

// ── the live Notion shape ───────────────────────────────────────────────────────────────
// FIELDSET._container_… _fieldEntry_… ashby-application-form-input-checkbox-group
//  ├ LABEL._heading_…[ _required_…]                 ← THE QUESTION
//  └ DIV._option_… › input#<formId>_<qId>-labeled-checkbox-<N> + label[for]   ← the OPTION
const FORM_ID = "8b3ce1e3-998a-4b81-a67d-15e95e8e22a5";
const GROUP_CLS = "_container_1258i_28 _fieldEntry_1e3gg_28 ashby-application-form-input-checkbox-group";

function group(qId, question, options, required) {
  const kids = [el("label", {
    class: "_heading_f7cvd_52 " + (required ? "_required_f7cvd_91 " : "") + "_label_1e3gg_42 ashby-application-form-label",
    text: question,
  })];
  options.forEach((opt, i) => {
    const id = FORM_ID + "_" + qId + "-labeled-checkbox-" + i;
    kids.push(el("div", { class: "_option_1258i_34 ashby-application-form-option" }, [
      // ⚠ `name` is the OPTION TEXT on this widget — the whole reason the group cannot be keyed on it.
      el("input", { type: "checkbox", id, name: opt, value: "on" }),
      el("label", { for: id, text: opt }),
    ]));
  });
  return el("fieldset", { class: GROUP_CLS }, kids);
}

// A genuine standalone consent checkbox: a plain entry, name = a bare question UUID, NO id.
function soloConsent(nm, question) {
  return el("div", { class: "_fieldEntry_1e3gg_28 ashby-application-form-field-entry" }, [
    el("label", { text: question }, [el("input", { type: "checkbox", name: nm })]),
  ]);
}

const HEAR_Q = "How did you hear about this opportunity? (select all that apply)";
const HEAR_OPTS = ["LinkedIn", "Glassdoor", "Notion Blog", "Notion Employee", "Notion Website",
  "Billboard/Outdoor Ads", "Conference or Meetup"];
const LOC_Q = "Please indicate all of the locations that you would be interested in relocating to for this position.";

function notionForm() {
  return el("div", { class: "ashby-application-form-container" }, [
    group("2ff3be8b-ab56-445f-ad6c-8753234d2a91", LOC_Q, ["New York, NY", "San Francisco, CA"], true),
    group("39f16850-ea19-4a96-af1c-263f083a39d9", HEAR_Q, HEAR_OPTS, false),
    soloConsent("30fcdc85-13b8-43a4-9fb4-0ea387642215", "We work from our offices on Mondays, Tuesdays, and Thursdays"),
  ]);
}

function scan(root) { installDom(root); return ats.atsInjScan("ashby"); }

test("⚠ a declared checkbox group is ONE field, labelled with the QUESTION", () => {
  const out = scan(notionForm());
  const hear = out.fields.filter((f) => f.label === HEAR_Q);
  assert.strictEqual(hear.length, 1, "the question must produce exactly one field");
  assert.strictEqual(hear[0].widgetType, "checkbox_group");
  assert.deepStrictEqual(hear[0].options, HEAR_OPTS, "options are the member labels, in DOM order");
});

test("⚠⚠ no field is labelled with an OPTION — the phantom-field regression", () => {
  const out = scan(notionForm());
  // "LinkedIn" as a LABEL is the bug: it is what routed this box to websites.0.url.
  for (const opt of HEAR_OPTS.concat(["New York, NY", "San Francisco, CA"])) {
    assert.ok(!out.fields.some((f) => f.label === opt),
      "an option must never become a field label: " + opt);
  }
  // 2 groups + 1 consent = 3 fields, not 3 + 21.
  assert.strictEqual(out.fields.length, 3, "grouping must collapse the members, not add to them");
});

test("⚠ the group is keyed on the QUESTION id, never on a member's `name`", () => {
  const out = scan(notionForm());
  const hear = out.fields.find((f) => f.label === HEAR_Q);
  assert.strictEqual(hear.fieldName, "39f16850-ea19-4a96-af1c-263f083a39d9");
  // Both groups on one form share the formId and differ in the questionId — so a key taken from
  // anywhere before the LAST underscore would collide across questions.
  const loc = out.fields.find((f) => f.label === LOC_Q);
  assert.strictEqual(loc.fieldName, "2ff3be8b-ab56-445f-ad6c-8753234d2a91");
  assert.notStrictEqual(hear.fieldName, loc.fieldName);
  // …and never the option text that `name` actually holds.
  assert.ok(!/linkedin/i.test(hear.fieldName));
});

test("⚠ REQUIRED is declared on the question's heading, not on the inputs", () => {
  const out = scan(notionForm());
  // The live measurement: no input carries `required`, and `aria-required` is absent on all of
  // them — the only marker is `_required_…` in the heading label's class.
  assert.strictEqual(out.fields.find((f) => f.label === LOC_Q).isRequired, true);
  assert.strictEqual(out.fields.find((f) => f.label === HEAR_Q).isRequired, false);
});

test("the group resolves to all of its members, so a commit and a read-back can find them", () => {
  const out = scan(notionForm());
  const hear = out.fields.find((f) => f.label === HEAR_Q);
  assert.strictEqual(hear.optionSels.length, HEAR_OPTS.length);
  assert.strictEqual(hear.inputSel.split(", ").length, HEAR_OPTS.length);
  assert.ok(hear.inputSel.startsWith("#" + FORM_ID.replace(/(["\\])/g, "\\$1")));
});

test("an UNCHECKED group reports no value; checked members join on the group separator", () => {
  const plain = scan(notionForm());
  assert.strictEqual(plain.fields.find((f) => f.label === HEAR_Q).value, null);

  const root = notionForm();
  const boxes = root.querySelectorAll('input[type="checkbox"]');
  // tick LinkedIn and Notion Blog
  boxes.filter((b) => b.name === "LinkedIn" || b.name === "Notion Blog").forEach((b) => { b.checked = true; });
  const out = scan(root);
  // ⚠ "; " — GROUP_JOIN. The replay splits a multi-answer value on exactly this vocabulary.
  assert.strictEqual(out.fields.find((f) => f.label === HEAR_Q).value, "LinkedIn; Notion Blog");
});

test("⚠⚠ a ONE-BOX declared group is still a group (operator, 2026-08-20)", () => {
  // The declaration is the evidence, not the count. Collapsing to `checkbox` renders a bare
  // boolean and DROPS the options, so the question reaches the operator as "…— Unchecked" with no
  // sign of what was being declined — the ORC Hispanic/Latino bug.
  const root = el("div", {}, [group("aaaa1111-0000-0000-0000-000000000001", "Degree Type", ["Bachelors"], true)]);
  const out = scan(root);
  assert.strictEqual(out.fields.length, 1);
  assert.strictEqual(out.fields[0].widgetType, "checkbox_group");
  assert.strictEqual(out.fields[0].label, "Degree Type");
  assert.deepStrictEqual(out.fields[0].options, ["Bachelors"]);
});

test("a genuine standalone consent checkbox is UNCHANGED — the OpenAI shape still works", () => {
  const out = scan(notionForm());
  const consent = out.fields.find((f) => f.fieldName === "30fcdc85-13b8-43a4-9fb4-0ea387642215");
  assert.ok(consent, "the solo consent box must still be scanned");
  assert.strictEqual(consent.widgetType, "checkbox");
  assert.strictEqual(consent.label, "We work from our offices on Mondays, Tuesdays, and Thursdays");
  assert.strictEqual(consent.options, undefined, "a real boolean has no option list");
});

test("⚠ a group member's `name` must not shadow a REAL later field of the same name", () => {
  // The members are excluded from the solo loop by their CONTAINER, not by `seen` — because a
  // member's `name` IS its label text. Keying `seen` on "LinkedIn" would drop a genuine
  // "LinkedIn"-named control elsewhere on the form, which is a collision of exactly the kind this
  // whole bug was made of.
  const root = el("div", {}, [
    group("39f16850-ea19-4a96-af1c-263f083a39d9", HEAR_Q, HEAR_OPTS, false),
    el("div", { class: "_fieldEntry_1e3gg_28 ashby-application-form-field-entry" }, [
      el("label", { for: "real-linkedin", text: "LinkedIn Profile" }),
      el("input", { type: "url", id: "real-linkedin", name: "LinkedIn" }),
    ]),
  ]);
  const out = scan(root);
  // ⚠ The collision is REAL, not hypothetical: this input's own scanned key is `name` — literally
  // "LinkedIn" — the same string seven group members carry. That is what makes `seen` the wrong
  // place to exclude them.
  const real = out.fields.find((f) => f.label === "LinkedIn Profile");
  assert.ok(real, "the real LinkedIn Profile input must survive");
  assert.strictEqual(real.fieldName, "LinkedIn");
  assert.strictEqual(real.widgetType, "text");
  // …and the group is still its own single field alongside it.
  assert.strictEqual(out.fields.filter((f) => f.widgetType === "checkbox_group").length, 1);
  assert.strictEqual(out.fields.length, 2);
});

// ── required-ness is declared on the ENTRY, not the control ──────────────────────────────
// Live 2026-08-31: an armed Notion submit was REFUSED by the form's own validation for four
// fields our scan had recorded as OPTIONAL ("What pronouns…", "How many prior internships…",
// "Graduation Date", "Degree Type"). Ashby marks a required question with `_required_…` on its
// heading LABEL; the inputs carry neither `required` nor `aria-required`. Only the yes/no branch
// ever consulted the entry, so every other widget under-reported — and under-reporting is the
// dangerous direction: bundleSubmitBlockers had nothing to block on, so an approved bundle
// reached the submit gate that the form would never accept.

function entryWith(kids, required) {
  return el("div", { class: "_fieldEntry_1e3gg_28 ashby-application-form-field-entry" }, [
    el("label", { class: "_heading_f7cvd_52 " + (required ? "_required_f7cvd_91" : ""), text: "Graduation Date" }),
  ].concat(kids));
}

test("⚠⚠ a text input whose ENTRY heading is marked required scans as REQUIRED", () => {
  const req = scan(el("div", {}, [entryWith([el("input", { type: "text", name: "gradDate" })], true)]));
  assert.strictEqual(req.fields[0].isRequired, true, "the heading's _required_ marker must be read");
  const opt = scan(el("div", {}, [entryWith([el("input", { type: "text", name: "gradDate" })], false)]));
  assert.strictEqual(opt.fields[0].isRequired, false, "…and an unmarked entry must stay optional");
});

test("⚠ a RADIO group inherits its entry's required-ness (the pronouns field)", () => {
  const mk = (required) => el("div", {}, [
    el("div", { class: "_fieldEntry_1e3gg_28 ashby-application-form-field-entry" }, [
      el("label", { class: "_heading_f7cvd_52 " + (required ? "_required_f7cvd_91" : ""), text: "What pronouns would you like our team to use when addressing you?" }),
      el("div", {}, [el("input", { type: "radio", name: "pronouns", id: "p1" }), el("label", { for: "p1", text: "She/Her" })]),
      el("div", {}, [el("input", { type: "radio", name: "pronouns", id: "p2" }), el("label", { for: "p2", text: "He/Him" })]),
    ]),
  ]);
  assert.strictEqual(scan(mk(true)).fields[0].isRequired, true);
  assert.strictEqual(scan(mk(false)).fields[0].isRequired, false);
});

test("⚠ the required marker is read from the HEADING, not from anywhere in the subtree", () => {
  // A checkbox-group entry contains its option rows. If the test were
  // `entry.querySelector('[class*="required"]')` over the whole subtree, a stray token on any
  // descendant would flag every group on the form.
  const root = el("div", {}, [
    el("fieldset", { class: GROUP_CLS }, [
      el("label", { class: "_heading_f7cvd_52 _label_1e3gg_42", text: "Optional question" }),
      el("div", { class: "_option_1258i_34 some_required_looking_option" }, [
        el("input", { type: "checkbox", id: FORM_ID + "_qqq-labeled-checkbox-0", name: "A" }),
        el("label", { for: FORM_ID + "_qqq-labeled-checkbox-0", text: "A" }),
      ]),
    ]),
  ]);
  assert.strictEqual(scan(root).fields[0].isRequired, false,
    "a descendant's class must not make the question required");
});

// ── the ACCEPT-consent classifier reaches the GH/Lever/Ashby path ────────────────────────
// Live 2026-08-31: an armed IMC submit was refused — "You answered some demographic questions.
// Please accept the terms to proceed, or clear your responses." The box is
// `gdpr_demographic_data_consent_given` and its `required` property is FALSE (it is only
// mandatory once a demographic question carries an answer), so nothing in the bundle could see it.
test("⚠ the IMC demographic GDPR box classifies as ACCEPT, and an opt-in still does not", () => {
  const gdpr = "By checking this box, I consent to IMC collecting, storing, and processing my responses to the demographic data surveys above.";
  assert.strictEqual(ats.atsConsentKind(gdpr, { name: "gdpr_demographic_data_consent_given" }), "accept");
  // The authorised rule is unchanged in the direction that matters: a marketing opt-in is never
  // ticked, even when it mentions privacy.
  assert.notStrictEqual(ats.atsConsentKind("Email me about similar jobs — see our privacy policy", {}), "accept");
  // …and a truthfulness attestation stays deliberately excluded.
  assert.strictEqual(ats.atsConsentKind("I certify the information provided is accurate", {}), "attestation");
});
