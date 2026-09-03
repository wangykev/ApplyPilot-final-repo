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
import { humanize, setFieldVariants } from "@/lib/teach";

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
  highlight,
  ladder,
  onLadderChange,
}: {
  path: string;
  label: string;
  value: unknown;
  countryForState?: string[];
  onChange: (value: unknown) => void;
  /** For list widgets (candidate / tiered / taglist): the entry to ring in amber (the teach popup's
   *  "adding this one"). Ignored by scalar widgets. */
  highlight?: string;
  /** YES/NO answer ladder for a tribool, and its persist handler. TriBool only opens its ladder popup
   *  when a handler is wired, so without these the teach page could select Yes/No but never edit the
   *  wordings behind them — which the profile page has always allowed (operator, 2026-08-09). */
  ladder?: { yes: string[]; no: string[] };
  onLadderChange?: (next: { yes: string[]; no: string[] }) => void;
}) {
  const meta = profileFieldMeta(path, value);
  if (meta.widget === "dropdown")
    return <SelectField label={label} value={strv(value)} options={opt(meta.options || [])} onChange={(v) => onChange(v)} />;
  if (meta.widget === "tribool")
    return <TriBoolField label={label} value={triv(value)} onChange={(v) => onChange(v)} ladder={ladder} onLadderChange={onLadderChange} />;
  if (meta.widget === "checkbox") return <CheckboxField label={label} checked={value === true} onChange={(v) => onChange(v)} />;
  if (meta.widget === "date")
    return <DateField label={label} granularity={meta.granularity || "month-day-year"} value={strv(value)} onChange={(v) => onChange(v)} />;
  if (meta.widget === "state")
    return <StateProvinceField value={strv(value)} country={countryForState || []} onChange={(v) => onChange(v)} />;
  if (meta.widget === "candidate")
    return <CandidateLadder value={arrv(value)} mode={meta.dropdownMode || "country"} onChange={(v) => onChange(v)} highlight={highlight} />;
  if (meta.widget === "tiered") return <TieredField label={label} value={arrv(value)} onChange={(v) => onChange(v)} highlight={highlight} />;
  if (meta.widget === "taglist") return <TagListField label={label} value={arrv(value)} onChange={(v) => onChange(v)} highlight={highlight} />;
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
  // A scalar field (text / plain dropdown / state) also shows its ANSWER LADDER (variants) here — the
  // "advanced options". A candidate/tiered field already edits its ladder as the value; yes/no has its own.
  // Repeating-section entry fields (education.0.gpa, …) ARE included — on flat forms they fill from the
  // primary entry via a Mode-A bucket, which honors these variants.
  const meta = profileFieldMeta(path, raw);
  const scalarLadder = meta.widget === "text" || meta.widget === "dropdown" || meta.widget === "state";
  const variants = (profile.answer_ladders as Record<string, { values?: string[] }> | undefined)?.[path]?.values ?? [];
  // The yes/no polarity ladders live under the SAME answer_ladders[path] key as `values`, in `yes`/`no`.
  // Read as a whole so the spread above cannot drop a sibling (e.g. a `values` list set earlier).
  const boolLadder = (profile.answer_ladders as Record<string, { yes?: string[]; no?: string[] }> | undefined)?.[path] as
    | { yes: string[]; no: string[] }
    | undefined;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose} role="presentation">
      {/* ⚠ SCROLLABLE, HEADER AND FOOTER PINNED (operator, 2026-09-03) — the third of the three teach
          popups that shared this bug; see RememberedAnswerPopup for the reasoning. */}
      <div className="flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col rounded-xl border border-hairline bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex shrink-0 items-center justify-between px-5 pt-5 pb-3">
          <h3 className="font-mono text-[11px] uppercase tracking-label text-ink-dim">{label} — answer</h3>
          <button type="button" onClick={onClose} className="text-ink-faint hover:text-ink" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5">
        <ProfileFieldEditor
          path={path}
          label={label}
          value={raw}
          countryForState={arrv(getAtPath(profile, "personal_info.country"))}
          onChange={(v) => set(v)}
          // A yes/no answer gets the SAME editable ladder the profile page has always offered: click the
          // already-selected Yes or No again to open its wordings. Without a persist handler TriBool
          // deliberately keeps the popup shut, which is why teach could pick a polarity but never edit
          // what it fills as. Same shape and same storage key as ProfileEditor, so the two stay in sync.
          ladder={boolLadder}
          onLadderChange={(next) =>
            onChange({
              ...(profile as object),
              answer_ladders: { ...(profile.answer_ladders ?? {}), [path]: { ...(boolLadder ?? {}), ...next } },
            } as Profile)
          }
        />

        {scalarLadder && (
          <div className="mt-4 border-t border-hairline pt-4">
            <p className="mb-2 text-xs leading-relaxed text-ink-dim">
              Answer variants — other wordings a form might use for this answer. The extension tries them,
              in order, when the field is a dropdown/select.
            </p>
            <TieredField label="Variants" value={variants} onChange={(next) => onChange(setFieldVariants(profile, path, next) as Profile)} />
          </div>
        )}

        </div>
        <div className="flex shrink-0 justify-end border-t border-hairline px-5 pt-4 pb-5">
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
  highlight,
}: {
  value: string[];
  mode: "country" | "phone";
  onChange: (v: string[]) => void;
  highlight?: string;
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
      <TieredField label="Candidates it tries (most-specific first)" value={value} onChange={onChange} highlight={highlight} />
    </div>
  );
}
