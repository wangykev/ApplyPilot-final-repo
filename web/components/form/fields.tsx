"use client";

import { useState } from "react";
import { X, ArrowUp, ArrowDown, Plus } from "lucide-react";
import { clsx } from "@/lib/clsx";

const inputCls =
  "w-full rounded-lg border border-hairline bg-cockpit px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-amber";

export function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <span className="flex items-baseline gap-2">
      <span className="font-mono text-[10px] uppercase tracking-label text-ink-dim">{children}</span>
      {hint && <span className="text-[11px] text-ink-faint">{hint}</span>}
    </span>
  );
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      <FieldLabel hint={hint}>{label}</FieldLabel>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={clsx(inputCls, "mt-1.5")}
      />
    </label>
  );
}

export function TextAreaField({
  label,
  value,
  onChange,
  placeholder,
  rows = 3,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  hint?: string;
}) {
  return (
    <label className="block">
      <FieldLabel hint={hint}>{label}</FieldLabel>
      <textarea
        value={value}
        rows={rows}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={clsx(inputCls, "mt-1.5 resize-y leading-relaxed")}
      />
    </label>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  hint?: string;
}) {
  return (
    <label className="block">
      <FieldLabel hint={hint}>{label}</FieldLabel>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={clsx(inputCls, "mt-1.5 appearance-none")}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-panel">
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Tri-state: Yes / No / unanswered (null). */
export function TriBoolField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: boolean | null;
  onChange: (v: boolean | null) => void;
  hint?: string;
}) {
  const opts: { v: boolean | null; t: string }[] = [
    { v: true, t: "Yes" },
    { v: false, t: "No" },
    { v: null, t: "—" },
  ];
  return (
    <div>
      <FieldLabel hint={hint}>{label}</FieldLabel>
      <div className="mt-1.5 grid grid-cols-3 gap-1 rounded-lg border border-hairline p-1">
        {opts.map((o) => {
          const active = value === o.v;
          return (
            <button
              key={String(o.v)}
              type="button"
              onClick={() => onChange(o.v)}
              className={clsx(
                "rounded-md py-1.5 text-sm transition-colors",
                active ? "bg-panel-raised text-ink" : "text-ink-dim hover:text-ink"
              )}
            >
              {o.t}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Editable list of free-text tags (skills, bullets, tech stack, companies). */
export function TagListField({
  label,
  value,
  onChange,
  placeholder = "Type and press Enter",
  hint,
}: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  hint?: string;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const t = draft.trim();
    if (!t) return;
    onChange([...value, t]);
    setDraft("");
  };
  return (
    <div>
      <FieldLabel hint={hint}>{label}</FieldLabel>
      <div className="mt-1.5 flex gap-2">
        <input
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          className={inputCls}
        />
        <button type="button" onClick={add} className="btn-ghost shrink-0 px-3 py-2" aria-label="Add">
          <Plus className="h-4 w-4" />
        </button>
      </div>
      {value.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {value.map((tag, i) => (
            <li
              key={`${tag}-${i}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-hairline bg-panel-raised px-2 py-1 text-xs text-ink"
            >
              {tag}
              <button
                type="button"
                onClick={() => onChange(value.filter((_, j) => j !== i))}
                className="text-ink-faint hover:text-signal"
                aria-label={`Remove ${tag}`}
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Ordered candidate list, most-specific first. Add / remove / reorder. */
export function TieredField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");
  // Adaptive placeholder: explain the tiered fallback in terms of how many
  // candidates are already listed ("if the first N aren't on the form").
  const autoPlaceholder =
    value.length === 0
      ? "Add a candidate — most-specific first"
      : `Add a candidate if the first ${value.length} ${
          value.length === 1 ? "option isn't" : "options aren't"
        } on the form`;
  const ph = placeholder ?? autoPlaceholder;
  const add = () => {
    const t = draft.trim();
    if (!t) return;
    onChange([...value, t]);
    setDraft("");
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div>
      <FieldLabel hint="most-specific first; the extension tries each in order">{label}</FieldLabel>
      <div className="mt-1.5 flex gap-2">
        <input
          value={draft}
          placeholder={ph}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          className={inputCls}
        />
        <button type="button" onClick={add} className="btn-ghost shrink-0 px-3 py-2" aria-label="Add">
          <Plus className="h-4 w-4" />
        </button>
      </div>
      {value.length > 0 && (
        <ol className="mt-2 space-y-1">
          {value.map((cand, i) => (
            <li
              key={`${cand}-${i}`}
              className="flex items-center gap-2 rounded-md border border-hairline bg-panel-raised px-2.5 py-1.5 text-sm"
            >
              <span className="font-mono text-[10px] text-ink-faint">{i + 1}</span>
              <span className="flex-1 truncate text-ink">{cand}</span>
              <button
                type="button"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                className="text-ink-faint hover:text-ink disabled:opacity-30"
                aria-label="Move up"
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => move(i, 1)}
                disabled={i === value.length - 1}
                className="text-ink-faint hover:text-ink disabled:opacity-30"
                aria-label="Move down"
              >
                <ArrowDown className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onChange(value.filter((_, j) => j !== i))}
                className="text-ink-faint hover:text-signal"
                aria-label="Remove"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

type CountryLike = { name: string; dial: string; candidates?: string[] };

/**
 * Country / dial-code picker. Pick one country from the dropdown; it EXPANDS
 * into the tiered candidate list the extension matches against (see
 * lib/countries.ts). A subtle reveal shows that list so the user can edit it if
 * a tenant words the option differently. Stored value stays a string[].
 */
export function CountryField({
  label,
  value,
  onChange,
  countries,
  expand,
  mode = "country",
}: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  countries: CountryLike[];
  expand: (c: CountryLike) => string[];
  mode?: "country" | "phone";
}) {
  // Reflect the current selection when the stored candidates still match a
  // known country's expansion; a hand-edited list falls back to "Choose…".
  const selected = countries.find((c) => expand(c).some((cand) => cand === value[0]))?.name ?? "";
  return (
    <div>
      <FieldLabel hint="pick one; edit the candidates below if a tenant words it differently">
        {label}
      </FieldLabel>
      <select
        value={selected}
        onChange={(e) => {
          const c = countries.find((x) => x.name === e.target.value);
          if (c) onChange(expand(c));
        }}
        className={clsx(inputCls, "mt-1.5 appearance-none")}
      >
        <option value="">Choose a country…</option>
        {countries.map((c) => (
          <option key={c.name} value={c.name} className="bg-panel">
            {mode === "phone" ? `${c.name} (${c.dial})` : c.name}
          </option>
        ))}
      </select>
      {value.length > 0 && (
        <div className="mt-2 rounded-lg border border-hairline/70 bg-panel-raised/30 p-2.5">
          <TieredField label="Candidates the extension tries" value={value} onChange={onChange} />
        </div>
      )}
    </div>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type DateGranularity = "year" | "month-year" | "month-day-year";
type DateParts = { year: string; month: string; day: string };

function parseDateValue(value: string, g: DateGranularity): DateParts {
  if (g === "year") return { year: /^\d{4}$/.test(value) ? value : "", month: "", day: "" };
  const m = value.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
  if (!m) return { year: "", month: "", day: "" };
  return { year: m[1], month: String(Number(m[2])), day: m[3] ? String(Number(m[3])) : "" };
}

/** Reassemble the canonical string; empty until the required segments exist so
 *  we never store a half-formed date the extension's parsers would reject. */
function assembleDate(p: DateParts, g: DateGranularity): string {
  const y = p.year.trim();
  const okY = /^\d{4}$/.test(y);
  if (g === "year") return okY ? y : "";
  const mo = p.month.trim();
  if (g === "month-year") return okY && mo ? `${y}-${mo.padStart(2, "0")}` : "";
  const d = p.day.trim();
  return okY && mo && d ? `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}` : "";
}

/**
 * Workday-style segmented date input. Granularity picks the segments (year /
 * month-year / month-day-year, US M/D/Y order) but the STORED value is always
 * the canonical string prepareProfile expects — "YYYY" / "YYYY-MM" /
 * "YYYY-MM-DD". Segments live in local state so a partial entry isn't lost.
 */
export function DateField({
  label,
  value,
  onChange,
  granularity,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  granularity: DateGranularity;
  hint?: string;
}) {
  const [parts, setParts] = useState<DateParts>(() => parseDateValue(value, granularity));
  const set = (patch: Partial<DateParts>) => {
    const next = { ...parts, ...patch };
    setParts(next);
    onChange(assembleDate(next, granularity));
  };
  const seg =
    "rounded-lg border border-hairline bg-cockpit px-2.5 py-2 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-amber";
  return (
    <div>
      <FieldLabel hint={hint}>{label}</FieldLabel>
      <div className="mt-1.5 flex gap-2">
        {granularity !== "year" && (
          <select
            aria-label={`${label} month`}
            value={parts.month}
            onChange={(e) => set({ month: e.target.value })}
            className={clsx(seg, "flex-1 appearance-none")}
          >
            <option value="">Month</option>
            {MONTHS.map((m, i) => (
              <option key={m} value={String(i + 1)} className="bg-panel">
                {String(i + 1).padStart(2, "0")} — {m}
              </option>
            ))}
          </select>
        )}
        {granularity === "month-day-year" && (
          <input
            aria-label={`${label} day`}
            inputMode="numeric"
            value={parts.day}
            placeholder="DD"
            onChange={(e) => set({ day: e.target.value.replace(/\D/g, "").slice(0, 2) })}
            className={clsx(seg, "w-16 text-center")}
          />
        )}
        <input
          aria-label={`${label} year`}
          inputMode="numeric"
          value={parts.year}
          placeholder="YYYY"
          onChange={(e) => set({ year: e.target.value.replace(/\D/g, "").slice(0, 4) })}
          className={clsx(seg, "w-24 text-center")}
        />
      </div>
    </div>
  );
}
