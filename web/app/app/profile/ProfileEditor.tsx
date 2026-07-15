"use client";

import { useState, useTransition } from "react";
import { Plus, Trash2, Save, ShieldAlert } from "lucide-react";
import {
  TextField,
  SelectField,
  TriBoolField,
  TagListField,
  TieredField,
  CountryField,
  DateField,
  CheckboxField,
} from "@/components/form/fields";
import { SectionCard } from "@/components/app/SectionCard";
import { COUNTRIES, countryCandidates, phoneCandidates } from "@/lib/countries";
import { saveProfile } from "./actions";
import {
  type Profile,
  websiteSchema,
  educationSchema,
  workExperienceSchema,
  languageSchema,
  certificationSchema,
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
const PHONE_TYPE = opt(["", "Mobile", "Home", "Work"]);
const WEBSITE_TYPE = opt(["linkedin", "github", "portfolio", "other"]);
// Standard US EEO option sets. Stored values are candidates the extension
// matches against each tenant's live options — refine per observed wording.
const GENDER = opt(["", "Male", "Female", "Non-binary", "Decline to self-identify"]);
const YES_NO_DECLINE = opt(["", "Yes", "No", "Decline to self-identify"]);
const RACE_ETHNICITY = opt([
  "",
  "American Indian or Alaska Native",
  "Asian",
  "Black or African American",
  "Hispanic or Latino",
  "Native Hawaiian or Other Pacific Islander",
  "White",
  "Two or More Races",
  "Decline to self-identify",
]);
const VETERAN_STATUS = opt([
  "",
  "I am not a protected veteran",
  "I identify as one or more of the classifications of a protected veteran",
  "Decline to self-identify",
]);
const DISABILITY_STATUS = opt([
  "",
  "No, I do not have a disability",
  "Yes, I have a disability (or previously had one)",
  "I do not wish to answer",
]);

export function ProfileEditor({ initial }: { initial: Profile }) {
  const [profile, setProfile] = useState<Profile>(initial);
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

  const save = () =>
    startTransition(async () => {
      setStatus({ kind: "idle" });
      const res = await saveProfile(profile);
      setStatus(res.ok ? { kind: "ok", msg: "Saved" } : { kind: "err", msg: res.error });
    });

  const pi = profile.personal_info;

  return (
    <div className="space-y-6 pb-24">
      {/* Personal info */}
      <SectionCard title="Personal information" subtitle="The basics ApplyPilot maps onto the form's contact fields.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField label="First name" value={pi.first_name} onChange={(v) => update((p) => { p.personal_info.first_name = v; })} />
          <TextField label="Last name" value={pi.last_name} onChange={(v) => update((p) => { p.personal_info.last_name = v; })} />
          <TextField label="Email" type="email" value={pi.email} onChange={(v) => update((p) => { p.personal_info.email = v; })} />
          <TextField label="Phone number" value={pi.phone_number} onChange={(v) => update((p) => { p.personal_info.phone_number = v; })} />
          <SelectField label="Phone type" value={pi.phone_device_type} options={PHONE_TYPE} onChange={(v) => update((p) => { p.personal_info.phone_device_type = v; })} />
          <TextField label="Preferred name" value={pi.preferred_name} onChange={(v) => update((p) => { p.personal_info.preferred_name = v; })} />
          <TextField label="Address line 1" value={pi.address_line_1} onChange={(v) => update((p) => { p.personal_info.address_line_1 = v; })} />
          <TextField label="Address line 2" value={pi.address_line_2} onChange={(v) => update((p) => { p.personal_info.address_line_2 = v; })} />
          <TextField label="City" value={pi.city} onChange={(v) => update((p) => { p.personal_info.city = v; })} />
          <TextField label="State / Province" value={pi.state_province} onChange={(v) => update((p) => { p.personal_info.state_province = v; })} />
          <TextField label="Postal code" value={pi.postal_code} onChange={(v) => update((p) => { p.personal_info.postal_code = v; })} />
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <CountryField label="Country" value={pi.country} countries={COUNTRIES} expand={countryCandidates} onChange={(v) => update((p) => { p.personal_info.country = v; })} />
          <CountryField label="Country phone code" mode="phone" value={pi.country_phone_code} countries={COUNTRIES} expand={phoneCandidates} onChange={(v) => update((p) => { p.personal_info.country_phone_code = v; })} />
        </div>
      </SectionCard>

      {/* Websites */}
      <SectionCard
        title="Websites & links"
        subtitle="LinkedIn, GitHub, portfolio — each filled into its own row."
        actions={<AddButton onClick={() => update((p) => { p.websites.push(websiteSchema.parse({})); })} />}
      >
        {profile.websites.length === 0 && <Empty>No links yet.</Empty>}
        <div className="space-y-4">
          {profile.websites.map((w, i) => (
            <EntryCard key={i} index={i} onRemove={() => update((p) => { p.websites.splice(i, 1); })}>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <SelectField label="Type" value={w.type} options={WEBSITE_TYPE} onChange={(v) => update((p) => { p.websites[i].type = v; })} />
                <TextField label="URL" value={w.url} placeholder="https://…" onChange={(v) => update((p) => { p.websites[i].url = v; })} />
              </div>
            </EntryCard>
          ))}
        </div>
      </SectionCard>

      {/* Work experience */}
      <SectionCard
        title="Work experience"
        subtitle="Most-recent first. Bullets become the role description, joined line by line."
        actions={<AddButton onClick={() => update((p) => { p.work_experience.push(workExperienceSchema.parse({})); })} />}
      >
        {profile.work_experience.length === 0 && <Empty>No roles yet.</Empty>}
        <div className="space-y-4">
          {profile.work_experience.map((w, i) => (
            <EntryCard key={i} index={i} onRemove={() => update((p) => { p.work_experience.splice(i, 1); })}>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <TextField label="Job title" value={w.job_title} onChange={(v) => update((p) => { p.work_experience[i].job_title = v; })} />
                <TextField label="Company" value={w.company} onChange={(v) => update((p) => { p.work_experience[i].company = v; })} />
                <TextField label="Location" value={w.location} onChange={(v) => update((p) => { p.work_experience[i].location = v; })} />
                <TriBoolField label="Currently work here" value={w.currently_work_here} onChange={(v) => update((p) => { p.work_experience[i].currently_work_here = v; })} />
                <DateField label="From" granularity="month-year" value={w.from} onChange={(v) => update((p) => { p.work_experience[i].from = v; })} />
                <DateField label="To" granularity="month-year" value={w.to} onChange={(v) => update((p) => { p.work_experience[i].to = v; })} />
              </div>
              <div className="mt-4 space-y-4">
                <TagListField label="Bullets" value={w.bullets} placeholder="Add an accomplishment, press Enter" onChange={(v) => update((p) => { p.work_experience[i].bullets = v; })} />
                <TagListField label="Tech stack" value={w.tech_stack} onChange={(v) => update((p) => { p.work_experience[i].tech_stack = v; })} />
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
                <TextField label="School / University" value={e.school_or_university} onChange={(v) => update((p) => { p.education[i].school_or_university = v; })} />
                <TextField label="Minor" value={e.minor} onChange={(v) => update((p) => { p.education[i].minor = v; })} />
                <TextField label="GPA" value={e.gpa} onChange={(v) => update((p) => { p.education[i].gpa = v; })} />
                <TextField label="GPA scale" value={e.gpa_scale} placeholder="4.0" onChange={(v) => update((p) => { p.education[i].gpa_scale = v; })} />
                <DateField label="From year" granularity="year" value={e.from_year} onChange={(v) => update((p) => { p.education[i].from_year = v; })} />
                <DateField label="To year" granularity="year" value={e.to_year} onChange={(v) => update((p) => { p.education[i].to_year = v; })} />
              </div>
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <TieredField label="Degree" value={e.degree} onChange={(v) => update((p) => { p.education[i].degree = v; })} />
                <TieredField label="Major / Field of Study" value={e.field_of_study} onChange={(v) => update((p) => { p.education[i].field_of_study = v; })} />
              </div>
            </EntryCard>
          ))}
        </div>
      </SectionCard>

      {/* Skills */}
      <SectionCard title="Skills">
        <TagListField label="Skills" value={profile.skills} onChange={(v) => update((p) => { p.skills = v; })} />
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
                <TextField label="Language" value={l.language} onChange={(v) => update((p) => { p.languages[i].language = v; })} />
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
              <TieredField label="Certification" value={c.certification} onChange={(v) => update((p) => { p.certifications[i].certification = v; })} />
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
                <TextField label="Number" value={c.certification_number} onChange={(v) => update((p) => { p.certifications[i].certification_number = v; })} />
                <DateField label="Issued date" granularity="month-day-year" value={c.issued_date} onChange={(v) => update((p) => { p.certifications[i].issued_date = v; })} />
                <DateField label="Expiration date" granularity="month-day-year" value={c.expiration_date} onChange={(v) => update((p) => { p.certifications[i].expiration_date = v; })} />
              </div>
            </EntryCard>
          ))}
        </div>
      </SectionCard>

      {/* Work authorization */}
      <SectionCard title="Work authorization">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TriBoolField label="Authorized to work in the US" value={profile.work_authorization.authorized_to_work_in_us} onChange={(v) => update((p) => { p.work_authorization.authorized_to_work_in_us = v; })} />
          <TriBoolField label="Need sponsorship now" value={profile.work_authorization.requires_sponsorship_now} onChange={(v) => update((p) => { p.work_authorization.requires_sponsorship_now = v; })} />
          <TriBoolField label="Need sponsorship in future" value={profile.work_authorization.requires_sponsorship_future} onChange={(v) => update((p) => { p.work_authorization.requires_sponsorship_future = v; })} />
          <TriBoolField label="Permanent resident" value={profile.work_authorization.permanent_resident} onChange={(v) => update((p) => { p.work_authorization.permanent_resident = v; })} />
          <TextField label="Current visa status" value={profile.work_authorization.current_visa_status} onChange={(v) => update((p) => { p.work_authorization.current_visa_status = v; })} />
        </div>
        <div className="mt-4">
          <CountryField label="Citizenship country" value={profile.work_authorization.citizenship_country} countries={COUNTRIES} expand={countryCandidates} onChange={(v) => update((p) => { p.work_authorization.citizenship_country = v; })} />
        </div>
      </SectionCard>

      {/* How did you hear */}
      <SectionCard
        title="How did you hear about us?"
        subtitle="Candidates the extension tries for the source picker; the fallback is the last resort."
      >
        <TagListField label="Preferred sources" value={profile.how_did_you_hear.preferred} placeholder="LinkedIn, Handshake, …" onChange={(v) => update((p) => { p.how_did_you_hear.preferred = v; })} />
        <div className="mt-4">
          <TextField label="Fallback" value={profile.how_did_you_hear.fallback} placeholder="Other" onChange={(v) => update((p) => { p.how_did_you_hear.fallback = v; })} />
        </div>
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
          <SelectField label="Gender" value={profile.self_identification.gender} options={GENDER} onChange={(v) => update((p) => { p.self_identification.gender = v; })} />
          <SelectField label="Hispanic or Latino" value={profile.self_identification.hispanic_or_latino} options={YES_NO_DECLINE} onChange={(v) => update((p) => { p.self_identification.hispanic_or_latino = v; })} />
          <SelectField label="Race / Ethnicity" value={profile.self_identification.race_ethnicity} options={RACE_ETHNICITY} onChange={(v) => update((p) => { p.self_identification.race_ethnicity = v; })} />
          <SelectField label="Veteran status" value={profile.self_identification.veteran_status} options={VETERAN_STATUS} onChange={(v) => update((p) => { p.self_identification.veteran_status = v; })} />
          <SelectField label="Disability status" value={profile.self_identification.disability_status} options={DISABILITY_STATUS} onChange={(v) => update((p) => { p.self_identification.disability_status = v; })} />
        </div>
      </SectionCard>

      {/* Screening defaults */}
      <SectionCard title="Screening defaults" subtitle="Common yes/no questions and preferences the extension fills when asked.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TriBoolField label="At least 18 years old" value={profile.screening.at_least_18_years_old} onChange={(v) => update((p) => { p.screening.at_least_18_years_old = v; })} />
          <TriBoolField label="Willing to do a background check" value={profile.screening.willing_background_check} onChange={(v) => update((p) => { p.screening.willing_background_check = v; })} />
          <TriBoolField label="Willing to do a drug test" value={profile.screening.willing_drug_test} onChange={(v) => update((p) => { p.screening.willing_drug_test = v; })} />
          <TriBoolField label="Valid driver's license" value={profile.screening.has_valid_drivers_license} onChange={(v) => update((p) => { p.screening.has_valid_drivers_license = v; })} />
          <TriBoolField label="Willing to relocate" value={profile.screening.willing_to_relocate} onChange={(v) => update((p) => { p.screening.willing_to_relocate = v; })} />
          <TriBoolField label="Open to remote" value={profile.screening.remote_ok} onChange={(v) => update((p) => { p.screening.remote_ok = v; })} />
          <DateField label="Earliest start date" granularity="month-day-year" value={profile.screening.earliest_start_date} onChange={(v) => update((p) => { p.screening.earliest_start_date = v; })} />
          <TextField label="Total years of experience" value={profile.screening.years_of_experience_total} onChange={(v) => update((p) => { p.screening.years_of_experience_total = v; })} />
          <TextField label="Salary expectation" value={profile.screening.salary_expectation} onChange={(v) => update((p) => { p.screening.salary_expectation = v; })} />
        </div>
      </SectionCard>

      {/* sticky save bar */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-hairline bg-cockpit/90 backdrop-blur md:left-60">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-3 sm:px-8">
          <span
            className={clsx(
              "font-mono text-[11px] tracking-label",
              status.kind === "ok" && "text-verified",
              status.kind === "err" && "text-signal",
              status.kind === "idle" && "text-ink-faint"
            )}
          >
            {status.kind === "ok" ? "✓ SAVED" : status.kind === "err" ? status.msg : "EDITS ARE LOCAL UNTIL SAVED"}
          </span>
          <button onClick={save} disabled={pending} className="btn-primary">
            <Save className="h-4 w-4" />
            {pending ? "Saving…" : "Save profile"}
          </button>
        </div>
      </div>
    </div>
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
  children,
}: {
  index: number;
  onRemove: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-hairline bg-panel-raised/40 p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-label text-ink-faint">
          Entry {String(index + 1).padStart(2, "0")}
        </span>
        <button
          type="button"
          onClick={onRemove}
          className="inline-flex items-center gap-1 text-xs text-ink-faint transition-colors hover:text-signal"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Remove
        </button>
      </div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-2 text-sm text-ink-faint">{children}</p>;
}
