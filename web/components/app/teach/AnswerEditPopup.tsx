"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import {
  TextField,
  SelectField,
  TriBoolField,
  CheckboxField,
  DateField,
  TieredField,
  TagListField,
  StateProvinceField,
} from "@/components/form/fields";
import { COUNTRIES, countryCandidates, phoneCandidates, type CountryEntry } from "@/lib/countries";
import { profileFieldMeta, getAtPath, setAtPath } from "@/lib/profile-fields";
import type { Profile } from "@/lib/profile-schema";
import { humanize } from "@/lib/teach";

const opt = (vals: string[]) => vals.map((v) => ({ value: v, label: v === "" ? "—" : v }));

// coercers from the raw profile value into each editor's expected shape
export const strv = (v: unknown): string => (Array.isArray(v) ? (v[0] != null ? String(v[0]) : "") : v == null ? "" : String(v));
export const triv = (v: unknown): boolean | null => (v === true ? true : v === false ? false : null);
export const arrv = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string") : typeof v === "string" && v ? [v] : [];

/**
 * The right editor for a single profile field — the same widget the real profile page uses (a select
 * for EEO, a Yes/No toggle for work-auth, a segmented date, a country dropdown that shows its ladder,
 * …). Shared by the answer popup and the teach "add to profile" confirm popup. `value` is the raw
 * stored value; onChange returns the new raw value (string / boolean / string[] per widget).
 */
export function ProfileFieldEditor({
  path,
  label,
  value,
  countryForState,
  onChange,
}: {
  path: string;
  label: string;
  value: unknown;
  countryForState?: string[];
  onChange: (value: unknown) => void;
}) {
  const meta = profileFieldMeta(path, value);
  if (meta.widget === "dropdown")
    return <SelectField label={label} value={strv(value)} options={opt(meta.options || [])} onChange={(v) => onChange(v)} />;
  if (meta.widget === "tribool") return <TriBoolField label={label} value={triv(value)} onChange={(v) => onChange(v)} />;
  if (meta.widget === "checkbox") return <CheckboxField label={label} checked={value === true} onChange={(v) => onChange(v)} />;
  if (meta.widget === "date")
    return <DateField label={label} granularity={meta.granularity || "month-day-year"} value={strv(value)} onChange={(v) => onChange(v)} />;
  if (meta.widget === "state")
    return <StateProvinceField value={strv(value)} country={countryForState || []} onChange={(v) => onChange(v)} />;
  if (meta.widget === "candidate")
    return <CandidateLadder value={arrv(value)} mode={meta.dropdownMode || "country"} onChange={(v) => onChange(v)} />;
  if (meta.widget === "tiered") return <TieredField label={label} value={arrv(value)} onChange={(v) => onChange(v)} />;
  if (meta.widget === "taglist") return <TagListField label={label} value={arrv(value)} onChange={(v) => onChange(v)} />;
  return <TextField label={label} value={strv(value)} onChange={(v) => onChange(v)} />;
}

/**
 * The popup a profile ANSWER opens on the teach page: modify the field's stored value with the right
 * editor (candidate / tiered fields show the LADDER). Edits flow up via onChange; parent persists on close.
 */
export function AnswerEditPopup({
  profile,
  path,
  label: labelProp,
  onChange,
  onClose,
}: {
  profile: Profile;
  path: string;
  label?: string;
  onChange: (next: Profile) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);

  const raw = getAtPath(profile, path);
  const label = labelProp || humanize(path);
  const set = (value: unknown) => onChange(setAtPath(profile, path, value));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose} role="presentation">
      <div className="w-full max-w-md rounded-xl border border-hairline bg-panel p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-mono text-[11px] uppercase tracking-label text-ink-dim">{label} — answer</h3>
          <button type="button" onClick={onClose} className="text-ink-faint hover:text-ink" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <ProfileFieldEditor
          path={path}
          label={label}
          value={raw}
          countryForState={arrv(getAtPath(profile, "personal_info.country"))}
          onChange={(v) => set(v)}
        />

        <div className="mt-4 flex justify-end">
          <button type="button" onClick={onClose} className="btn-primary">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/** A country/phone dropdown that EXPANDS its pick into the stored tiered ladder, with the ladder
 *  shown inline (the candidates the extension tries, most-specific first). */
function CandidateLadder({
  value,
  mode,
  onChange,
}: {
  value: string[];
  mode: "country" | "phone";
  onChange: (v: string[]) => void;
}) {
  const expand = mode === "phone" ? phoneCandidates : countryCandidates;
  const selected = COUNTRIES.find((c) => expand(c).some((cand) => cand === value[0]))?.name ?? "";
  const options = [
    { value: "", label: "Choose a country…" },
    ...COUNTRIES.map((c: CountryEntry) => ({ value: c.name, label: mode === "phone" ? `${c.name} (${c.dial})` : c.name })),
  ];
  return (
    <div className="space-y-4">
      <SelectField
        label={mode === "phone" ? "Country phone code" : "Country"}
        value={selected}
        options={options}
        onChange={(name) => {
          const c = COUNTRIES.find((x) => x.name === name);
          onChange(c ? expand(c) : []);
        }}
      />
      <TieredField label="Candidates it tries (most-specific first)" value={value} onChange={onChange} />
    </div>
  );
}
