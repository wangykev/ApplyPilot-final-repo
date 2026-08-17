"use client";

import { useState, useMemo, useTransition } from "react";
import { Plus, Trash2, Save, ShieldAlert, Settings2 } from "lucide-react";
import {
  TextField,
  TextAreaField,
  SelectField,
  TriBoolField,
  TagListField,
  TieredField,
  CandidateField,
  DateField,
  CheckboxField,
  StateProvinceField,
  FieldLabel,
  FileField,
  BucketLabelContext,
  AnswerLadderContext,
  AdvancedChoices,
} from "@/components/form/fields";
import { SectionCard } from "@/components/app/SectionCard";
import { BucketFieldPopup } from "@/components/form/BucketFieldPopup";
import {
  RememberedAnswerPopup,
  ConfirmDeleteButton,
  RememberedToggle,
  RememberedCheckbox,
} from "@/components/app/RememberedAnswerPopup";
import { COUNTRIES, countryCandidates, phoneCandidates } from "@/lib/countries";
import {
  PHONE_TYPE_OPTIONS,
  GENDER_OPTIONS,
  YES_NO_DECLINE_OPTIONS,
  RACE_ETHNICITY_OPTIONS,
  VETERAN_STATUS_OPTIONS,
  DISABILITY_STATUS_OPTIONS,
} from "@/lib/profile-fields";
import { saveProfile, saveBuckets } from "./actions";
import { liveSync } from "@/lib/extension-sync";
import { type Bucket } from "@/lib/buckets";
import {
  type Profile,
  websiteSchema,
  educationSchema,
  workExperienceSchema,
  languageSchema,
  certificationSchema,
  specialtySchema,
  additionalFileSchema,
  ensureHttpsUrl,
  looksLikeUrl,
} from "@/lib/profile-schema";
import { clsx } from "@/lib/clsx";

const opt = (vals: string[], blank = "—") =>
  vals.map((v) => ({ value: v, label: v === "" ? blank : v }));
// Mirrors the extension's isFluent (=== "fluent") so an untouched "I am fluent"
// box reflects what the extension would derive; a human toggle overrides it.
const isFluentLevel = (p: string) => p.trim().toLowerCase() === "fluent";
const allFluent = (l: { reading: string; speaking: string; writing: string }) =>
  isFluentLevel(l.reading) && isFluentLevel(l.speaking) && isFluentLevel(l.writing);
const PROFICIENCY = opt(["", "None", "Basic", "Intermediate", "Advanced", "Fluent"]);
const PHONE_TYPE = opt(PHONE_TYPE_OPTIONS);
// The three fixed link rows every profile shows — type is LOCKED, only the URL is
// editable. Any of the user's existing links of these types are slotted in (matched
// case-insensitively), and a missing one is created empty.
const DEFAULT_WEBSITE_TYPES = ["LinkedIn", "GitHub", "Personal Website"];
function withDefaultWebsites(list: { type: string; url: string }[] | undefined) {
  const arr = Array.isArray(list) ? [...list] : [];
  const fixed = DEFAULT_WEBSITE_TYPES.map((t) => {
    const idx = arr.findIndex((w) => (w.type || "").trim().toLowerCase() === t.toLowerCase());
    if (idx >= 0) {
      const [found] = arr.splice(idx, 1);
      return { ...found, type: t };
    }
    return { type: t, url: "" };
  });
  return [...fixed, ...arr]; // fixed defaults first, then any custom links
}
// The "How did you hear about us?" ladder, shown pre-filled so the user can see and edit it.
// Seeded ONLY when the stored list is empty (mirrors withDefaultWebsites): a user who trimmed it
// to a non-empty list keeps theirs. "Other" ships as the last default entry (the catch-all), so
// there's no separate "last resort" field anymore.
const DEFAULT_SOURCE_LADDER = ["LinkedIn", "Handshake", "GitHub", "Other"];
/** The canonical employment-option words, in the order the fill should try them. Kept here so the
 *  editor and the profile agree on spelling — a form's own wording is matched through the ordinary
 *  ladder, so these do not have to equal any one tenant's labels. */
const EMPLOYMENT_TYPES = ["Full-time", "Part-time", "Internship", "Temporary"] as const;

function withDefaultSources(h: Profile["how_did_you_hear"] | undefined) {
  const preferred =
    Array.isArray(h?.preferred) && h!.preferred.length > 0 ? h!.preferred : [...DEFAULT_SOURCE_LADDER];
  // fallback is legacy (kept in the schema for backward-compat with older profiles); no longer
  // seeded or shown — the catch-all "Other" now lives in `preferred` as its last item.
  const fallback = h?.fallback ?? "";
  return { preferred, fallback };
}
// Standard US EEO option sets (canonical lists live in lib/profile-fields.ts, shared with the teach
// panel). Stored values are candidates the extension matches against each tenant's live options.
const GENDER = opt(GENDER_OPTIONS);
const YES_NO_DECLINE = opt(YES_NO_DECLINE_OPTIONS);
const RACE_ETHNICITY = opt(RACE_ETHNICITY_OPTIONS);
const VETERAN_STATUS = opt(VETERAN_STATUS_OPTIONS);
const DISABILITY_STATUS = opt(DISABILITY_STATUS_OPTIONS);

export function ProfileEditor({ initial, initialBuckets }: { initial: Profile; initialBuckets: Bucket[] }) {
  // The seeded baseline (initial + default website/source rows). Used for BOTH the live
  // profile state and the "last saved" snapshot the dirty check compares against, so applying
  // those defaults on load never counts as an unsaved change.
  const seededInitial = useMemo<Profile>(
    () => ({
      ...initial,
      websites: withDefaultWebsites(initial.websites),
      how_did_you_hear: withDefaultSources(initial.how_did_you_hear),
    }),
    [initial]
  );
  const [profile, setProfile] = useState<Profile>(seededInitial);
  const [savedProfile, setSavedProfile] = useState<Profile>(seededInitial);
  const [buckets, setBuckets] = useState<Bucket[]>(initialBuckets);
  const [savedBuckets, setSavedBuckets] = useState<Bucket[]>(initialBuckets);
  const [bucketOpen, setBucketOpen] = useState<{ path: string; label: string; widget: string } | null>(null);
  // the field whose ANSWER LADDER (variants) popup is open — the in-field arrow on a scalar field.
  const [ladderOpen, setLadderOpen] = useState<{ path: string; label: string } | null>(null);
  // the Add / Advanced popup works on a DRAFT — nothing is written to `buckets` until Done.
  const [adv, setAdv] = useState<{ mode: "add" | "edit"; index: number; draft: Bucket } | null>(null);
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<{ kind: "idle" | "ok" | "err"; msg?: string }>({
    kind: "idle",
  });

  const update = (fn: (p: Profile) => void) =>
    setProfile((prev) => {
      const next = structuredClone(prev);
      fn(next);
      return next;
    });

  // Save is enabled only when the profile or buckets differ from the last-saved snapshot
  // (deep value compare — every edit goes through structuredClone / object spreads, so key
  // order stays stable and JSON.stringify is a reliable equality test here).
  const dirty =
    JSON.stringify(profile) !== JSON.stringify(savedProfile) ||
    JSON.stringify(buckets) !== JSON.stringify(savedBuckets);

  // One Save persists both the profile and the answer buckets edited via the labels.
  const save = () =>
    startTransition(async () => {
      setStatus({ kind: "idle" });
      const [pr, br] = await Promise.all([saveProfile(profile), saveBuckets(buckets)]);
      if (pr.ok && br.ok) {
        setSavedProfile(profile); // new clean baseline → Save disables until the next edit
        setSavedBuckets(buckets);
        setStatus({ kind: "ok", msg: "Saved" });
        liveSync("profile"); // push profile + buckets to a connected extension (no-op if not connected)
      } else setStatus({ kind: "err", msg: (!pr.ok && pr.error) || (!br.ok && br.error) || "Save failed" });
    });

  const pi = profile.personal_info;

  // ── remembered (Mode-B) answer helpers, lifted here so the answer cards can render both merged into a
  // matching profile section (SectionRemembered) and as their own cards (custom categories). ──
  const modeBBuckets = buckets.map((b, i) => ({ b, i })).filter((x) => x.b.profile_path.trim() === "");
  const patchBucket = (i: number, patch: Partial<Bucket>) =>
    setBuckets((prev) => {
      const next = prev.map((x) => ({ ...x }));
      next[i] = { ...next[i], ...patch };
      return next;
    });
  const removeBucket = (i: number) => setBuckets((prev) => prev.filter((_, j) => j !== i));
  const blankBucket = (category: string): Bucket => ({
    id: "custom_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    profile_path: "",
    value: [],
    category,
    widget_hint: "text",
    questions: [],
    selectors: {},
  });
  // Add / Advanced open the popup with a DRAFT; nothing is written to `buckets` until Done (commitAdv).
  const openAdd = () => setAdv({ mode: "add", index: -1, draft: blankBucket("Other") });
  const openAdvanced = (i: number) => setAdv({ mode: "edit", index: i, draft: { ...buckets[i] } });
  const closeAdv = () => setAdv(null); // cancel — discards the draft (a brand-new answer is never created)
  const commitAdv = (draft: Bucket) => {
    setBuckets((prev) => (adv?.mode === "edit" ? prev.map((b, j) => (j === adv.index ? draft : b)) : [...prev, draft]));
    setAdv(null);
  };
  const deleteAdv = () => {
    if (adv?.mode === "edit") removeBucket(adv.index);
    setAdv(null);
  };
  const rememberedFor = (cat: string) => modeBBuckets.filter((x) => bucketCategory(x.b) === cat);
  // dropdown options: fixed set + any custom category already in use (persists while an answer carries it)
  const usedCustomCats = Array.from(new Set(modeBBuckets.map((x) => (x.b.category || "").trim()).filter((c) => c && !BUCKET_CATEGORIES.includes(c))));
  const categoryOptions = [...BUCKET_CATEGORIES.filter((c) => c !== "Other"), ...usedCustomCats, "Other"];
  // categories that get their OWN card (not merged into a section, not "Other"): Experience/Education + customs
  const ownCardCats = Array.from(new Set(modeBBuckets.map((x) => bucketCategory(x.b)).filter((c) => c !== "Other" && !MERGED_CATEGORIES.includes(c))));
  // props shared by every simple remembered-answer field row
  const fieldRowProps = { onPatch: patchBucket, onOpenAdvanced: openAdvanced, onRemove: removeBucket };

  return (
    <BucketLabelContext.Provider value={(path, label, widget) => setBucketOpen({ path, label, widget })}>
    <AnswerLadderContext.Provider value={(path, label) => setLadderOpen({ path, label })}>
    <div className="space-y-6 pb-24">
      {/* Personal info */}
      <SectionCard title="Personal information" subtitle="The basics ApplyPilot maps onto the form's contact fields.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField label="First name" bucketPath="personal_info.first_name" value={pi.first_name} onChange={(v) => update((p) => { p.personal_info.first_name = v; })} />
          <TextField label="Last name" bucketPath="personal_info.last_name" value={pi.last_name} onChange={(v) => update((p) => { p.personal_info.last_name = v; })} />
          <TextField label="Email" type="email" bucketPath="personal_info.email" value={pi.email} onChange={(v) => update((p) => { p.personal_info.email = v; })} />
          <TextField label="Phone number" bucketPath="personal_info.phone_number" value={pi.phone_number} onChange={(v) => update((p) => { p.personal_info.phone_number = v; })} />
          <SelectField label="Phone type" bucketPath="personal_info.phone_device_type" value={pi.phone_device_type} options={PHONE_TYPE} onChange={(v) => update((p) => { p.personal_info.phone_device_type = v; })} />
          <TextField label="Address line 1" bucketPath="personal_info.address_line_1" value={pi.address_line_1} onChange={(v) => update((p) => { p.personal_info.address_line_1 = v; })} />
          <TextField label="Address line 2" bucketPath="personal_info.address_line_2" value={pi.address_line_2} onChange={(v) => update((p) => { p.personal_info.address_line_2 = v; })} />
          <TextField label="City" bucketPath="personal_info.city" value={pi.city} onChange={(v) => update((p) => { p.personal_info.city = v; })} />
          <StateProvinceField country={pi.country} bucketPath="personal_info.state_province" value={pi.state_province} onChange={(v) => update((p) => { p.personal_info.state_province = v; })} />
          <TextField label="Postal code" bucketPath="personal_info.postal_code" value={pi.postal_code} onChange={(v) => update((p) => { p.personal_info.postal_code = v; })} />
        </div>
        <div className="mt-4">
          <CheckboxField label="I have a preferred name" checked={pi.has_preferred_name === true} onChange={(v) => update((p) => { p.personal_info.has_preferred_name = v; })} />
          {pi.has_preferred_name === true && (
            <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextField label="Preferred first name" bucketPath="personal_info.preferred_first_name" value={pi.preferred_first_name} onChange={(v) => update((p) => { p.personal_info.preferred_first_name = v; })} />
              <TextField label="Preferred last name" bucketPath="personal_info.preferred_last_name" value={pi.preferred_last_name} onChange={(v) => update((p) => { p.personal_info.preferred_last_name = v; })} />
            </div>
          )}
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <CandidateField label="Country" mode="dropdown" bucketPath="personal_info.country" value={pi.country} countries={COUNTRIES} expand={countryCandidates} onChange={(v) => update((p) => { p.personal_info.country = v; })} />
          <CandidateField label="Country phone code" mode="dropdown" dropdownMode="phone" bucketPath="personal_info.country_phone_code" value={pi.country_phone_code} countries={COUNTRIES} expand={phoneCandidates} onChange={(v) => update((p) => { p.personal_info.country_phone_code = v; })} />
        </div>
        <SectionRemembered items={rememberedFor("Personal")} {...fieldRowProps} />
      </SectionCard>

      {/* Websites */}
      <SectionCard
        title="Websites & links"
        subtitle="LinkedIn, GitHub, and a personal website are built in (type locked — just add the URL). Add more with your own name; each link has its own bucket."
        actions={<AddButton onClick={() => update((p) => { p.websites.push(websiteSchema.parse({})); })} />}
      >
        <div className="space-y-4">
          {profile.websites.map((w, i) => {
            const locked = i < DEFAULT_WEBSITE_TYPES.length;
            return (
              <EntryCard
                key={i}
                index={i}
                onRemove={locked ? undefined : () => update((p) => { p.websites.splice(i, 1); })}
              >
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <TextField label="Type" value={w.type} disabled={locked} placeholder="Portfolio, Twitter…" onChange={(v) => update((p) => { p.websites[i].type = v; })} />
                  <TextField
                    label={w.type ? `${w.type} URL` : "URL"}
                    bucketPath={`websites.${i}.url`}
                    value={w.url}
                    placeholder="https://www.linkedin.com/in/you"
                    hint="Full URL, including www"
                    onChange={(v) => update((p) => { p.websites[i].url = v; })}
                    // Normalize on BLUR (not per keystroke): "linkedin.com/in/you" → the full canonical
                    // link "https://www.linkedin.com/in/you". www is added only to a bare apex host, so a
                    // URL that already has a subdomain ("blog.you.dev") keeps it — see ensureHttpsUrl.
                    onBlur={() => update((p) => { p.websites[i].url = ensureHttpsUrl(p.websites[i].url); })}
                    error={looksLikeUrl(w.url) ? null : "Enter a full URL, e.g. https://www.linkedin.com/in/you"}
                  />
                </div>
              </EntryCard>
            );
          })}
        </div>
      </SectionCard>

      {/* Work experience */}
      <SectionCard
        title="Work experience"
        subtitle="Most-recent first. Click a field's label to add the wordings other forms use for it."
        actions={<AddButton onClick={() => update((p) => { p.work_experience.push(workExperienceSchema.parse({})); })} />}
      >
        {profile.work_experience.length === 0 && <Empty>No roles yet.</Empty>}
        <div className="space-y-4">
          {profile.work_experience.map((w, i) => (
            <EntryCard key={i} index={i} onRemove={() => update((p) => { p.work_experience.splice(i, 1); })}>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <TextField label="Job title" bucketPath={i === 0 ? "work_experience.0.job_title" : undefined} value={w.job_title} onChange={(v) => update((p) => { p.work_experience[i].job_title = v; })} />
                <TextField label="Company" bucketPath={i === 0 ? "work_experience.0.company" : undefined} value={w.company} onChange={(v) => update((p) => { p.work_experience[i].company = v; })} />
                <TextField label="Location" bucketPath={i === 0 ? "work_experience.0.location" : undefined} value={w.location} onChange={(v) => update((p) => { p.work_experience[i].location = v; })} />
                {/* Flattened to a plain boolean checkbox (unchecked = false, checked = true) — the
                    form checkbox has no "unanswered" state. Checking it clears the To date (no end
                    date), keeping main #14's behavior on the boolean widget. */}
                <CheckboxField label="Currently work here" bucketPath={i === 0 ? "work_experience.0.currently_work_here" : undefined} checked={w.currently_work_here} onChange={(v) => update((p) => { p.work_experience[i].currently_work_here = v; if (v === true) p.work_experience[i].to = ""; })} />
                <DateField label="From" granularity="month-year" bucketPath={i === 0 ? "work_experience.0.from" : undefined} value={w.from} onChange={(v) => update((p) => { p.work_experience[i].from = v; })} />
                {/* "Currently work here" means no end date — hide the To field when Yes. */}
                {w.currently_work_here !== true && (
                  <DateField label="To" granularity="month-year" bucketPath={i === 0 ? "work_experience.0.to" : undefined} value={w.to} onChange={(v) => update((p) => { p.work_experience[i].to = v; })} />
                )}
              </div>
              <div className="mt-4 space-y-4">
                <TextAreaField label="Role description" bulletOnEnter bucketPath={i === 0 ? "work_experience.0.role_description" : undefined} value={w.role_description} rows={5} placeholder={"- Led the redesign of…\n- Shipped…"} onChange={(v) => update((p) => { p.work_experience[i].role_description = v; })} />
                {/* Tech stack has no editor any more (operator, 2026-08-16). The FIELD is kept on the
                    schema on purpose: the resume parse still populates it and smart merge folds it
                    into the skills list, so deleting it would quietly drop data the merge depends on.
                    It simply is not something to maintain by hand. */}
              </div>
              {/* ── Employer detail some ATSs ask for (iCIMS asks for all of it) ────────────── */}
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <TextField label="Employer address" bucketPath={i === 0 ? "work_experience.0.employer_address" : undefined} value={w.employer_address} onChange={(v) => update((p) => { p.work_experience[i].employer_address = v; })} />
                <TextField label="Employer ZIP / postal code" bucketPath={i === 0 ? "work_experience.0.employer_postal_code" : undefined} value={w.employer_postal_code} onChange={(v) => update((p) => { p.work_experience[i].employer_postal_code = v; })} />
                <TextField label="Supervisor's name" bucketPath={i === 0 ? "work_experience.0.supervisor_name" : undefined} value={w.supervisor_name} onChange={(v) => update((p) => { p.work_experience[i].supervisor_name = v; })} />
                <TextField label="Supervisor's title" bucketPath={i === 0 ? "work_experience.0.supervisor_title" : undefined} value={w.supervisor_title} onChange={(v) => update((p) => { p.work_experience[i].supervisor_title = v; })} />
              </div>
              <div className="mt-4 space-y-4">
                <TextAreaField label="Reason for leaving" bucketPath={i === 0 ? "work_experience.0.reason_for_leaving" : undefined} value={w.reason_for_leaving} rows={2} onChange={(v) => update((p) => { p.work_experience[i].reason_for_leaving = v; })} />
                {/* ⚠ TRI-STATE, and the two contact boxes appear ONLY on an explicit Yes. Answering
                    this is what authorises a recruiter to ring a past employer, so an unanswered
                    question must not look the same as "no" — and the details must not sit there
                    inviting entry when nothing has been agreed to. The filler applies the same gate,
                    so clearing this back to unanswered withholds them again. */}
                <TriBoolField
                  label="May we contact this employer?"
                  bucketPath={i === 0 ? "work_experience.0.may_contact" : undefined}
                  value={w.may_contact}
                  onChange={(v) => update((p) => { p.work_experience[i].may_contact = v; })}
                  ladder={profile.answer_ladders?.["work_experience.0.may_contact"]}
                  onLadderChange={(n) => update((p) => { (p.answer_ladders ||= {})["work_experience.0.may_contact"] = n; })}
                />
                {w.may_contact === true && (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <TextField label="Employer email" bucketPath={i === 0 ? "work_experience.0.employer_email" : undefined} value={w.employer_email} onChange={(v) => update((p) => { p.work_experience[i].employer_email = v; })} />
                    <TextField label="Employer phone number" bucketPath={i === 0 ? "work_experience.0.employer_phone" : undefined} value={w.employer_phone} onChange={(v) => update((p) => { p.work_experience[i].employer_phone = v; })} />
                  </div>
                )}
              </div>
            </EntryCard>
          ))}
        </div>
      </SectionCard>

      {/* Education */}
      <SectionCard
        title="Education"
        subtitle="Degree and field of study are tiered — list specific names first so any tenant's dropdown matches."
        actions={<AddButton onClick={() => update((p) => { p.education.push(educationSchema.parse({})); })} />}
      >
        {profile.education.length === 0 && <Empty>No schools yet.</Empty>}
        <div className="space-y-4">
          {profile.education.map((e, i) => (
            <EntryCard key={i} index={i} onRemove={() => update((p) => { p.education.splice(i, 1); })}>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <TextField label="School / University" bucketPath={i === 0 ? "education.0.school_or_university" : undefined} value={e.school_or_university} onChange={(v) => update((p) => { p.education[i].school_or_university = v; })} />
                <TextField label="Minor(s)" hint="comma-separate multiple" bucketPath={i === 0 ? "education.0.minor" : undefined} value={e.minor} onChange={(v) => update((p) => { p.education[i].minor = v; })} />
                <TextField label="GPA" bucketPath={i === 0 ? "education.0.gpa" : undefined} value={e.gpa} onChange={(v) => update((p) => { p.education[i].gpa = v; })} />
                <TextField label="GPA scale" bucketPath={i === 0 ? "education.0.gpa_scale" : undefined} value={e.gpa_scale} placeholder="4.0" onChange={(v) => update((p) => { p.education[i].gpa_scale = v; })} />
                <DateField label="From year" granularity="year" bucketPath={i === 0 ? "education.0.from_year" : undefined} value={e.from_year} onChange={(v) => update((p) => { p.education[i].from_year = v; })} />
                <DateField label="To year" granularity="year" bucketPath={i === 0 ? "education.0.to_year" : undefined} value={e.to_year} onChange={(v) => update((p) => { p.education[i].to_year = v; })} />
              </div>
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <CandidateField label="Degree" bucketPath={i === 0 ? "education.0.degree" : undefined} value={e.degree} placeholder="e.g. Bachelor of Science" onChange={(v) => update((p) => { p.education[i].degree = v; })} />
                <CandidateField label="Major / Field of Study" bucketPath={i === 0 ? "education.0.field_of_study" : undefined} value={e.field_of_study} placeholder="e.g. Computer Science" onChange={(v) => update((p) => { p.education[i].field_of_study = v; })} />
              </div>
            </EntryCard>
          ))}
        </div>
      </SectionCard>

      {/* Skills */}
      <SectionCard title="Skills">
        <TagListField label="Skills" value={profile.skills} onChange={(v) => update((p) => { p.skills = v; })} />
        {/* Workday's "Autofill with Resume" already suggests skills from the résumé. Adding this whole
            list on top costs one search round trip PER skill, so it is opt-in and the warning is not
            decoration — it is the slowest field on the page by a wide margin. */}
        <div className="mt-4">
          <CheckboxField
            label="Try to fill all of these skills, if possible"
            checked={profile.fill_all_skills === true}
            onChange={(v) => update((p) => { p.fill_all_skills = v; })}
          />
          <p className="mt-1.5 text-xs text-amber-400/90">
            ⚠ This makes each application take noticeably longer — every skill is searched on the form
            one at a time (roughly 1.5–3s each). Leave it off to keep just the skills Workday suggests
            from your résumé; either way the list is shown on the review page, where you can add or
            delete skills yourself.
          </p>
        </div>
      </SectionCard>

      {/* Languages */}
      <SectionCard
        title="Languages"
        subtitle={'Set a proficiency per skill. Check "I am fluent" to tick the form’s fluent/native box — independent of the three levels.'}
        actions={<AddButton onClick={() => update((p) => { p.languages.push(languageSchema.parse({})); })} />}
      >
        {profile.languages.length === 0 && <Empty>No languages yet.</Empty>}
        <div className="space-y-4">
          {profile.languages.map((l, i) => (
            <EntryCard key={i} index={i} onRemove={() => update((p) => { p.languages.splice(i, 1); })}>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <TextField label="Language" bucketPath={i === 0 ? "languages.0.language" : undefined} value={l.language} onChange={(v) => update((p) => { p.languages[i].language = v; })} />
                <SelectField label="Reading" value={l.reading} options={PROFICIENCY} onChange={(v) => update((p) => { p.languages[i].reading = v; })} />
                <SelectField label="Speaking" value={l.speaking} options={PROFICIENCY} onChange={(v) => update((p) => { p.languages[i].speaking = v; })} />
                <SelectField label="Writing" value={l.writing} options={PROFICIENCY} onChange={(v) => update((p) => { p.languages[i].writing = v; })} />
              </div>
              <div className="mt-3">
                <CheckboxField
                  label="I am fluent"
                  checked={l.fluent ?? allFluent(l)}
                  onChange={(v) => update((p) => { p.languages[i].fluent = v; })}
                />
              </div>
            </EntryCard>
          ))}
        </div>
      </SectionCard>

      {/* Certifications */}
      <SectionCard
        title="Certifications"
        actions={<AddButton onClick={() => update((p) => { p.certifications.push(certificationSchema.parse({})); })} />}
      >
        {profile.certifications.length === 0 && <Empty>No certifications yet.</Empty>}
        <div className="space-y-4">
          {profile.certifications.map((c, i) => (
            <EntryCard key={i} index={i} onRemove={() => update((p) => { p.certifications.splice(i, 1); })}>
              <CandidateField label="Certification" bucketPath={i === 0 ? "certifications.0.certification" : undefined} value={c.certification} placeholder="Certification name" onChange={(v) => update((p) => { p.certifications[i].certification = v; })} />
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <TextField label="Number" bucketPath={i === 0 ? "certifications.0.certification_number" : undefined} value={c.certification_number} onChange={(v) => update((p) => { p.certifications[i].certification_number = v; })} />
                <DateField label="Issued date" granularity="month-day-year" bucketPath={i === 0 ? "certifications.0.issued_date" : undefined} value={c.issued_date} onChange={(v) => update((p) => { p.certifications[i].issued_date = v; })} />
                <DateField label="Expiration date" granularity="month-day-year" bucketPath={i === 0 ? "certifications.0.expiration_date" : undefined} value={c.expiration_date} onChange={(v) => update((p) => { p.certifications[i].expiration_date = v; })} />
              </div>
              {/* Nested specialties (matches the extension's CERT_NESTED sub-section) */}
              <div className="mt-4 border-t border-hairline/60 pt-4">
                <div className="mb-2 flex items-center justify-between">
                  <FieldLabel>Specialties</FieldLabel>
                  <button
                    type="button"
                    onClick={() => update((p) => { p.certifications[i].specialties.push(specialtySchema.parse({})); })}
                    className="btn-ghost px-2.5 py-1 text-[11px]"
                  >
                    <Plus className="h-3 w-3" />
                    Add specialty
                  </button>
                </div>
                {c.specialties.length === 0 && <p className="py-1 text-xs text-ink-faint">No specialties.</p>}
                <div className="space-y-3">
                  {c.specialties.map((s, j) => (
                    <div key={j} className="rounded-lg border border-hairline/70 bg-panel-raised/30 p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="font-mono text-[10px] uppercase tracking-label text-ink-faint">
                          Specialty {String(j + 1).padStart(2, "0")}
                        </span>
                        <button
                          type="button"
                          onClick={() => update((p) => { p.certifications[i].specialties.splice(j, 1); })}
                          className="text-ink-faint transition-colors hover:text-signal"
                          aria-label="Remove specialty"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <TextField label="Specialty" value={s.specialty} onChange={(v) => update((p) => { p.certifications[i].specialties[j].specialty = v; })} />
                        <DateField label="Start date" granularity="month-day-year" value={s.start_date} onChange={(v) => update((p) => { p.certifications[i].specialties[j].start_date = v; })} />
                        <DateField label="End date" granularity="month-day-year" value={s.end_date} onChange={(v) => update((p) => { p.certifications[i].specialties[j].end_date = v; })} />
                      </div>
                      <div className="mt-3">
                        <FileField label="Attachment" value={s.attachment} onChange={(v) => update((p) => { p.certifications[i].specialties[j].attachment = v; })} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </EntryCard>
          ))}
        </div>
      </SectionCard>

      {/* Additional documents */}
      <SectionCard
        title="Additional documents"
        subtitle="Extra files (transcripts, portfolios, writing samples) to attach where a form asks for them."
        actions={<AddButton onClick={() => update((p) => { p.additional_files.push(additionalFileSchema.parse({})); })} />}
      >
        {profile.additional_files.length === 0 && <Empty>No documents yet.</Empty>}
        <div className="space-y-4">
          {profile.additional_files.map((f, i) => (
            <EntryCard key={i} index={i} onRemove={() => update((p) => { p.additional_files.splice(i, 1); })}>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <TextField label="Label" value={f.label} placeholder="e.g. Transcript" onChange={(v) => update((p) => { p.additional_files[i].label = v; })} />
                <FileField label="File" value={f.file} onChange={(v) => update((p) => { p.additional_files[i].file = v; })} />
              </div>
            </EntryCard>
          ))}
        </div>
      </SectionCard>

      {/* Work authorization */}
      <SectionCard title="Work authorization">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TriBoolField label="Authorized to work in the US" bucketPath="work_authorization.authorized_to_work_in_us" value={profile.work_authorization.authorized_to_work_in_us} onChange={(v) => update((p) => { p.work_authorization.authorized_to_work_in_us = v; })} ladder={profile.answer_ladders?.["work_authorization.authorized_to_work_in_us"]} onLadderChange={(n) => update((p) => { (p.answer_ladders ||= {})["work_authorization.authorized_to_work_in_us"] = n; })} />
          <TriBoolField label="Need sponsorship now" bucketPath="work_authorization.requires_sponsorship_now" value={profile.work_authorization.requires_sponsorship_now} onChange={(v) => update((p) => { p.work_authorization.requires_sponsorship_now = v; })} ladder={profile.answer_ladders?.["work_authorization.requires_sponsorship_now"]} onLadderChange={(n) => update((p) => { (p.answer_ladders ||= {})["work_authorization.requires_sponsorship_now"] = n; })} />
          <TriBoolField label="Need sponsorship in future" bucketPath="work_authorization.requires_sponsorship_future" value={profile.work_authorization.requires_sponsorship_future} onChange={(v) => update((p) => { p.work_authorization.requires_sponsorship_future = v; })} ladder={profile.answer_ladders?.["work_authorization.requires_sponsorship_future"]} onLadderChange={(n) => update((p) => { (p.answer_ladders ||= {})["work_authorization.requires_sponsorship_future"] = n; })} />
          <TriBoolField label="Permanent resident" bucketPath="work_authorization.permanent_resident" value={profile.work_authorization.permanent_resident} onChange={(v) => update((p) => { p.work_authorization.permanent_resident = v; })} ladder={profile.answer_ladders?.["work_authorization.permanent_resident"]} onLadderChange={(n) => update((p) => { (p.answer_ladders ||= {})["work_authorization.permanent_resident"] = n; })} />
          <TextField label="Current visa status" bucketPath="work_authorization.current_visa_status" value={profile.work_authorization.current_visa_status} onChange={(v) => update((p) => { p.work_authorization.current_visa_status = v; })} />
        </div>
        <div className="mt-4">
          <CandidateField label="Citizenship country" mode="dropdown" bucketPath="work_authorization.citizenship_country" value={profile.work_authorization.citizenship_country} countries={COUNTRIES} expand={countryCandidates} onChange={(v) => update((p) => { p.work_authorization.citizenship_country = v; })} />
        </div>
        <SectionRemembered items={rememberedFor("Work authorization")} {...fieldRowProps} />
      </SectionCard>

      {/* How did you hear */}
      <SectionCard
        title="How did you hear about us?"
        subtitle="A fallback list for the source question when the real source isn't known."
      >
        <div className="mb-4 rounded-lg border border-hairline bg-panel-raised/40 p-3">
          <p className="text-xs leading-relaxed text-ink-dim">
            The extension fills the <span className="text-ink">real source</span> when it&apos;s known
            (from how the job was queued). For a manually pasted link, or when no source is available, it
            works down this list <span className="text-ink">in order</span> — the first one the form offers
            wins. <span className="text-ink">Other</span> comes last by default as a catch-all; remove or
            reorder any of them.
          </p>
        </div>
        <TieredField
          label="Fallback sources (in order)"
          horizontal
          hint="reorder with the ◄ ► arrows; the first one the form offers wins — Other is the catch-all"
          value={profile.how_did_you_hear.preferred}
          placeholder="Add a source — e.g. LinkedIn"
          onChange={(v) => update((p) => { p.how_did_you_hear.preferred = v; })}
        />
      </SectionCard>

      {/* Employment history companies — safety-critical */}
      <SectionCard
        title="Employer history"
        subtitle='Every company you were formally employed by. Powers the "previously employed here?" answer.'
      >
        <div className="mb-4 flex gap-3 rounded-lg border border-amber/30 bg-amber/[0.06] p-3">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber" />
          <p className="text-xs leading-relaxed text-ink-dim">
            List <span className="text-ink">only formal employers</span> (not clubs or labs). This is what
            lets the extension safely answer &ldquo;No&rdquo; to &ldquo;have you worked here before?&rdquo;.
            Leave empty and every such question is flagged for your review instead. Add{" "}
            <span className="font-mono text-ink">none</span> if you&apos;ve never been formally employed.
          </p>
        </div>
        <TagListField label="Companies" value={profile.employment_history_companies} onChange={(v) => update((p) => { p.employment_history_companies = v; })} />
      </SectionCard>

      {/* Self identification */}
      <SectionCard
        title="Self-identification"
        subtitle="Used only if you provide it. Left blank, the extension flags these for your review rather than guessing."
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SelectField label="Gender" bucketPath="self_identification.gender" value={profile.self_identification.gender} options={GENDER} onChange={(v) => update((p) => { p.self_identification.gender = v; })} />
          <SelectField label="Hispanic or Latino" bucketPath="self_identification.hispanic_or_latino" value={profile.self_identification.hispanic_or_latino} options={YES_NO_DECLINE} onChange={(v) => update((p) => { p.self_identification.hispanic_or_latino = v; })} />
          <SelectField label="Race / Ethnicity" bucketPath="self_identification.race_ethnicity" value={profile.self_identification.race_ethnicity} options={RACE_ETHNICITY} onChange={(v) => update((p) => { p.self_identification.race_ethnicity = v; })} />
          <SelectField label="Veteran status" bucketPath="self_identification.veteran_status" value={profile.self_identification.veteran_status} options={VETERAN_STATUS} onChange={(v) => update((p) => { p.self_identification.veteran_status = v; })} />
          <SelectField label="Disability status" bucketPath="self_identification.disability_status" value={profile.self_identification.disability_status} options={DISABILITY_STATUS} onChange={(v) => update((p) => { p.self_identification.disability_status = v; })} />
        </div>
        <SectionRemembered items={rememberedFor("Demographics")} {...fieldRowProps} />
      </SectionCard>

      {/* Screening */}
      <SectionCard title="Screening" subtitle="Common yes/no questions and preferences the extension fills when asked.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TriBoolField label="At least 18 years old" bucketPath="screening.at_least_18_years_old" value={profile.screening.at_least_18_years_old} onChange={(v) => update((p) => { p.screening.at_least_18_years_old = v; })} ladder={profile.answer_ladders?.["screening.at_least_18_years_old"]} onLadderChange={(n) => update((p) => { (p.answer_ladders ||= {})["screening.at_least_18_years_old"] = n; })} />
          <TriBoolField label="Willing to do a background check" bucketPath="screening.willing_background_check" value={profile.screening.willing_background_check} onChange={(v) => update((p) => { p.screening.willing_background_check = v; })} ladder={profile.answer_ladders?.["screening.willing_background_check"]} onLadderChange={(n) => update((p) => { (p.answer_ladders ||= {})["screening.willing_background_check"] = n; })} />
          <TriBoolField label="Willing to do a drug test" bucketPath="screening.willing_drug_test" value={profile.screening.willing_drug_test} onChange={(v) => update((p) => { p.screening.willing_drug_test = v; })} ladder={profile.answer_ladders?.["screening.willing_drug_test"]} onLadderChange={(n) => update((p) => { (p.answer_ladders ||= {})["screening.willing_drug_test"] = n; })} />
          <TriBoolField label="Valid driver's license" bucketPath="screening.has_valid_drivers_license" value={profile.screening.has_valid_drivers_license} onChange={(v) => update((p) => { p.screening.has_valid_drivers_license = v; })} ladder={profile.answer_ladders?.["screening.has_valid_drivers_license"]} onLadderChange={(n) => update((p) => { (p.answer_ladders ||= {})["screening.has_valid_drivers_license"] = n; })} />
          <TriBoolField label="Willing to relocate" bucketPath="screening.willing_to_relocate" value={profile.screening.willing_to_relocate} onChange={(v) => update((p) => { p.screening.willing_to_relocate = v; })} ladder={profile.answer_ladders?.["screening.willing_to_relocate"]} onLadderChange={(n) => update((p) => { (p.answer_ladders ||= {})["screening.willing_to_relocate"] = n; })} />
          <TriBoolField label="Willing to relocate at your own cost" bucketPath="screening.willing_to_relocate_at_own_cost" value={profile.screening.willing_to_relocate_at_own_cost} onChange={(v) => update((p) => { p.screening.willing_to_relocate_at_own_cost = v; })} ladder={profile.answer_ladders?.["screening.willing_to_relocate_at_own_cost"]} onLadderChange={(n) => update((p) => { (p.answer_ladders ||= {})["screening.willing_to_relocate_at_own_cost"] = n; })} />
          <TriBoolField label="Open to remote" bucketPath="screening.remote_ok" value={profile.screening.remote_ok} onChange={(v) => update((p) => { p.screening.remote_ok = v; })} ladder={profile.answer_ladders?.["screening.remote_ok"]} onLadderChange={(n) => update((p) => { (p.answer_ladders ||= {})["screening.remote_ok"] = n; })} />
          <DateField label="Earliest start date" granularity="month-day-year" bucketPath="screening.earliest_start_date" value={profile.screening.earliest_start_date} onChange={(v) => update((p) => { p.screening.earliest_start_date = v; })} />
          <TextField label="Total years of experience" bucketPath="screening.years_of_experience_total" value={profile.screening.years_of_experience_total} onChange={(v) => update((p) => { p.screening.years_of_experience_total = v; })} />
          <TextField label="Salary expectation" bucketPath="screening.salary_expectation" value={profile.screening.salary_expectation} onChange={(v) => update((p) => { p.screening.salary_expectation = v; })} />
        </div>
        {/* Employment types considered — a MULTI-answer preference, so it lives with the other
            screening preferences rather than in a card of its own. */}
        <div className="mt-4">
          <FieldLabel>Employment types you'd consider</FieldLabel>
          <div className="flex flex-wrap gap-x-8 gap-y-2">
          {EMPLOYMENT_TYPES.map((t) => (
            <CheckboxField
              key={t}
              label={t}
              bucketPath={t === EMPLOYMENT_TYPES[0] ? "employment_types_considered" : undefined}
              checked={profile.employment_types_considered.includes(t)}
              onChange={(on) => update((p) => {
                // Kept in the canonical order above rather than click order, so the fill tries them
                // in a stable sequence and two profiles with the same ticks are the same answer.
                const next = EMPLOYMENT_TYPES.filter((x) => (x === t ? on : p.employment_types_considered.includes(x)));
                p.employment_types_considered = next;
              })}
            />
          ))}
        </div>
        </div>
        <SectionRemembered items={rememberedFor("Screening")} {...fieldRowProps} />
      </SectionCard>

      {/* Remembered answers with a CUSTOM category (or Experience/Education) → their own cards (display
          only). Answers whose category matches a section above are merged into that section instead. */}
      {ownCardCats.map((cat) => (
        <SectionCard key={cat} title={cat} subtitle="Remembered answers in this category.">
          <div className="space-y-4">
            {rememberedFor(cat).map(({ b, i }) => (
              <RememberedFieldRow key={b.id} b={b} i={i} {...fieldRowProps} />
            ))}
          </div>
        </SectionCard>
      ))}

      {/* Other / uncategorized — the single entry point for a brand-new remembered answer. Adding opens the
          Advanced popup; set a category there to file it under its section (or type a new category). */}
      <SectionCard title="Other remembered answers" subtitle="Custom question→answer pairs the profile doesn't cover. Add one here, then set its category to file it under the matching section.">
        <div className="space-y-4">
          {rememberedFor("Other").map(({ b, i }) => (
            <RememberedFieldRow key={b.id} b={b} i={i} {...fieldRowProps} />
          ))}
          <AddButton onClick={openAdd} />
        </div>
      </SectionCard>

      {/* sticky save bar */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-hairline bg-cockpit/90 backdrop-blur md:left-60">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-3 sm:px-8">
          <span
            className={clsx(
              "font-mono text-[11px] tracking-label",
              status.kind === "err" && "text-signal",
              !dirty && status.kind === "ok" && "text-verified",
              (dirty || status.kind === "idle") && "text-ink-faint"
            )}
          >
            {status.kind === "err"
              ? status.msg
              : dirty
                ? "EDITS ARE LOCAL UNTIL SAVED"
                : status.kind === "ok"
                  ? "✓ SAVED"
                  : "NO CHANGES TO SAVE"}
          </span>
          <button
            onClick={save}
            disabled={pending || !dirty}
            className="btn-primary"
            title={!dirty ? "No changes to save" : undefined}
          >
            <Save className="h-4 w-4" />
            {pending ? "Saving…" : "Save profile"}
          </button>
        </div>
      </div>

      {/* Question bucket (wordings) — opened from a field's label */}
      {bucketOpen && (
        <BucketFieldPopup
          path={bucketOpen.path}
          label={bucketOpen.label}
          widget={bucketOpen.widget}
          buckets={buckets}
          onBucketsChange={setBuckets}
          onClose={() => setBucketOpen(null)}
        />
      )}

      {/* Answer ladder (variants) — opened from a scalar field's in-field arrow */}
      {ladderOpen && (
        <AdvancedChoices
          label={ladderOpen.label}
          value={profile.answer_ladders?.[ladderOpen.path]?.values ?? []}
          onChange={(next) =>
            update((p) => {
              const map = (p.answer_ladders ||= {});
              const cur = map[ladderOpen.path] || { yes: [], no: [], values: [] };
              map[ladderOpen.path] = { yes: cur.yes || [], no: cur.no || [], values: next };
            })
          }
          onClose={() => setLadderOpen(null)}
        />
      )}

      {adv && (
        <RememberedAnswerPopup
          initial={adv.draft}
          mode={adv.mode}
          categoryOptions={categoryOptions}
          onDone={commitAdv}
          onCancel={closeAdv}
          onDelete={deleteAdv}
        />
      )}
    </div>
    </AnswerLadderContext.Provider>
    </BucketLabelContext.Provider>
  );
}

function AddButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="btn-ghost px-3 py-1.5 text-xs">
      <Plus className="h-3.5 w-3.5" />
      Add
    </button>
  );
}

function EntryCard({
  index,
  onRemove,
  title,
  children,
}: {
  index: number;
  onRemove?: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-hairline bg-panel-raised/40 p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-label text-ink-faint">
          {title || `Entry ${String(index + 1).padStart(2, "0")}`}
        </span>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="inline-flex items-center gap-1 text-xs text-ink-faint transition-colors hover:text-signal"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Remove
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-2 text-sm text-ink-faint">{children}</p>;
}

// Categories a remembered (Mode-B) answer can carry. The MERGED_CATEGORIES ones render inline in the
// matching profile section (below its fields); anything else (Experience/Education/custom + Other)
// renders as its own card.
const BUCKET_CATEGORIES = ["Screening", "Work authorization", "Demographics", "Personal", "Experience", "Education", "Other"];
const MERGED_CATEGORIES = ["Screening", "Work authorization", "Demographics", "Personal"];

/** A bucket's grouping category (blank → "Other"). */
function bucketCategory(b: Bucket): string {
  return (b.category || "").trim() || "Other";
}

/** One remembered answer displayed like a normal profile field: the question as the label, with Advanced
 *  + delete on the SAME line to save space, and the value control below (checkbox sits inline on the line). */
function RememberedFieldRow({
  b,
  i,
  onPatch,
  onOpenAdvanced,
  onRemove,
}: {
  b: Bucket;
  i: number;
  onPatch: (i: number, patch: Partial<Bucket>) => void;
  onOpenAdvanced: (i: number) => void;
  onRemove: (i: number) => void;
}) {
  const widget = b.widget_hint === "radio" || b.widget_hint === "checkbox" ? b.widget_hint : "text";
  const label = b.questions[0] || "Untitled answer";
  const controls = (
    <div className="flex shrink-0 items-center gap-3">
      <button
        type="button"
        onClick={() => onOpenAdvanced(i)}
        className="inline-flex items-center gap-1 text-[11px] text-ink-faint transition-colors hover:text-ink"
        title="Question wordings, answer type, category"
      >
        <Settings2 className="h-3 w-3" />
        Advanced
      </button>
      <ConfirmDeleteButton onDelete={() => onRemove(i)} />
    </div>
  );
  // Checkbox reads naturally inline (☑ question), so the whole answer is one line with the controls.
  if (widget === "checkbox") {
    return (
      <div className="group flex items-center justify-between gap-3">
        <RememberedCheckbox label={label} value={b.value} onChange={(v) => onPatch(i, { value: v })} />
        {controls}
      </div>
    );
  }
  return (
    <div className="group">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <span className="min-w-0 truncate font-mono text-[10px] uppercase tracking-label text-ink-dim">{label}</span>
        {controls}
      </div>
      {widget === "radio" ? (
        <RememberedToggle value={b.value} onChange={(v) => onPatch(i, { value: v })} />
      ) : (
        <CandidateField label="" hideLabel value={b.value} onChange={(v) => onPatch(i, { value: v })} placeholder="the answer" />
      )}
    </div>
  );
}

/** Remembered answers shown inside a matching profile section (below its fields), as simple profile-style
 *  fields. Renders NOTHING when the section has none — adding happens only in the "Other remembered
 *  answers" area at the end. */
function SectionRemembered({
  items,
  onPatch,
  onOpenAdvanced,
  onRemove,
}: {
  items: { b: Bucket; i: number }[];
  onPatch: (i: number, patch: Partial<Bucket>) => void;
  onOpenAdvanced: (i: number) => void;
  onRemove: (i: number) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mt-5 space-y-4 border-t border-hairline/60 pt-4">
      <p className="font-mono text-[10px] uppercase tracking-label text-ink-faint">Remembered answers</p>
      {items.map(({ b, i }) => (
        <RememberedFieldRow key={b.id} b={b} i={i} onPatch={onPatch} onOpenAdvanced={onOpenAdvanced} onRemove={onRemove} />
      ))}
    </div>
  );
}

