"use client";

import { useState, useEffect, createContext, useContext } from "react";
import { X, ArrowUp, ArrowDown, Plus, ChevronRight, Paperclip, Upload } from "lucide-react";
import { clsx } from "@/lib/clsx";
import { US_STATES, resolveUsState, isUnitedStates } from "@/lib/us-states";

/**
 * Optional hook: when a provider supplies an opener, a FieldLabel given a
 * `bucketPath` renders as a clickable link that opens that field's answer-bucket
 * popup. Absent a provider it stays a plain label (unchanged elsewhere).
 */
export const BucketLabelContext = createContext<((path: string, label: string, widget: string) => void) | null>(null);

const inputCls =
  "w-full rounded-lg border border-hairline bg-cockpit px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-amber";

export function FieldLabel({
  children,
  hint,
  bucketPath,
  bucketWidget,
}: {
  children: React.ReactNode;
  hint?: string;
  bucketPath?: string;
  bucketWidget?: string;
}) {
  const openBucket = useContext(BucketLabelContext);
  const clickable = !!bucketPath && !!openBucket;
  return (
    <span className="flex items-baseline gap-2">
      {clickable ? (
        <button
          type="button"
          onClick={() =>
            openBucket!(bucketPath!, typeof children === "string" ? children : String(bucketPath), bucketWidget || "text")
          }
          title="Edit the questions that map to this answer"
          className="cursor-pointer font-mono text-[10px] uppercase tracking-label text-ink-dim transition-colors hover:text-ink group-hover:text-ink"
        >
          {children}
        </button>
      ) : (
        <span className="font-mono text-[10px] uppercase tracking-label text-ink-dim">{children}</span>
      )}
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
  bucketPath,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  hint?: string;
  bucketPath?: string;
  disabled?: boolean;
}) {
  return (
    <label className="group block">
      <FieldLabel hint={hint} bucketPath={bucketPath} bucketWidget="text">{label}</FieldLabel>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={clsx(inputCls, "mt-1.5", disabled && "cursor-not-allowed text-ink-dim opacity-70")}
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
  bucketPath,
  bulletOnEnter,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  hint?: string;
  bucketPath?: string;
  bulletOnEnter?: boolean;
}) {
  return (
    <label className="group block">
      <FieldLabel hint={hint} bucketPath={bucketPath} bucketWidget="textarea">{label}</FieldLabel>
      <textarea
        value={value}
        rows={rows}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => {
          if (bulletOnEnter && value.trim() === "") onChange("- ");
        }}
        onBlur={() => {
          if (bulletOnEnter && value.trim() === "-") onChange(""); // leave an empty field truly empty
        }}
        onKeyDown={(e) => {
          // Bulleted role description: Enter starts a new "- " line (Shift+Enter = plain newline).
          if (!bulletOnEnter || e.key !== "Enter" || e.shiftKey) return;
          e.preventDefault();
          const el = e.currentTarget;
          const s = el.selectionStart ?? value.length;
          const en = el.selectionEnd ?? s;
          onChange(value.slice(0, s) + "\n- " + value.slice(en));
          const pos = s + 3;
          requestAnimationFrame(() => {
            try {
              el.selectionStart = el.selectionEnd = pos;
            } catch {
              /* noop */
            }
          });
        }}
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
  bucketPath,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  hint?: string;
  bucketPath?: string;
}) {
  return (
    <label className="group block">
      <FieldLabel hint={hint} bucketPath={bucketPath} bucketWidget="dropdown">{label}</FieldLabel>
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

/**
 * State / region field. When the selected country is the United States it's a DROPDOWN of the fixed
 * US-states list (`us-states.ts`) — the full names match Workday's `countryRegion` options so the
 * extension EXACT-matches (containment is off for dropdowns now). Otherwise it's a free-text box
 * (type your own region, or leave it blank). One stored `state_province` value regardless of country.
 *
 * Migration + safety: a legacy abbreviation / mis-cased value on a US profile auto-normalizes to the
 * canonical full name ("PA" → "Pennsylvania"). If you typed a region first and then pick the US, a value
 * that isn't a real US state shows a warning to pick again (and the dropdown falls back to "Choose…").
 */
export function StateProvinceField({
  value,
  country,
  onChange,
  bucketPath,
}: {
  value: string;
  country: string[];
  onChange: (v: string) => void;
  bucketPath?: string;
}) {
  const us = isUnitedStates(country);
  const resolved = resolveUsState(value);

  // Auto-upgrade a US abbreviation / mis-cased value to the canonical full name so the fill exact-matches.
  // Fires only when it actually differs (never loops — resolveUsState returns a canonical list member).
  useEffect(() => {
    if (us && resolved && resolved !== value) onChange(resolved);
  }, [us, resolved, value, onChange]);

  if (!us) {
    return (
      <label className="group block">
        <FieldLabel bucketPath={bucketPath} bucketWidget="text">State / Province / Region</FieldLabel>
        <input
          value={value}
          placeholder="Region (optional outside the US)"
          onChange={(e) => onChange(e.target.value)}
          className={clsx(inputCls, "mt-1.5")}
        />
      </label>
    );
  }

  const invalid = !!value && !resolved; // a US value that isn't a real state (typed-first, then picked US)
  return (
    <label className="group block">
      <FieldLabel bucketPath={bucketPath} bucketWidget="dropdown">State</FieldLabel>
      <select
        value={resolved ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className={clsx(inputCls, "mt-1.5 appearance-none", invalid && "border-amber")}
      >
        <option value="">Choose a state…</option>
        {US_STATES.map((s) => (
          <option key={s} value={s} className="bg-panel">
            {s}
          </option>
        ))}
      </select>
      {invalid && (
        <p className="mt-1 text-[11px] text-amber">
          &ldquo;{value}&rdquo; isn&apos;t a US state — pick your state from the list.
        </p>
      )}
    </label>
  );
}

/** Yes / No toggle. Starts unselected (null) — there is no blank option in the
 *  list; press Escape (while a choice is focused) to clear back to blank. */
export function TriBoolField({
  label,
  value,
  onChange,
  hint,
  bucketPath,
}: {
  label: string;
  value: boolean | null;
  onChange: (v: boolean | null) => void;
  hint?: string;
  bucketPath?: string;
}) {
  const opts: { v: boolean; t: string }[] = [
    { v: true, t: "Yes" },
    { v: false, t: "No" },
  ];
  const escHint = value !== null ? (hint ? hint + " · Esc clears" : "Esc clears") : hint;
  return (
    <div className="group">
      <FieldLabel hint={escHint} bucketPath={bucketPath} bucketWidget="radio">{label}</FieldLabel>
      <div
        className="mt-1.5 flex overflow-hidden rounded-lg border border-hairline"
        onKeyDown={(e) => {
          if (e.key === "Escape" && value !== null) {
            e.preventDefault();
            onChange(null);
          }
        }}
      >
        {opts.map((o, idx) => {
          const active = value === o.v;
          return (
            <button
              key={String(o.v)}
              type="button"
              onClick={() => onChange(o.v)}
              className={clsx(
                "flex-1 py-1.5 text-sm transition-colors",
                idx === 0 && "border-r border-hairline", // divider bar between Yes and No
                active
                  ? "bg-amber font-semibold text-cockpit" // bold, unmistakably selected
                  : "text-ink-dim hover:bg-panel-raised/40 hover:text-ink"
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
 * A tiered-candidate field with a compact primary control + a small "Advanced"
 * button that opens a popup for the ordered fallback list — so the page isn't
 * cluttered with tiers most people won't touch. Two modes:
 *   - "dropdown": pick from `countries`; the pick EXPANDS (via `expand`) into the
 *     stored candidate list (country / phone-code / citizenship).
 *   - "text": a free-text box bound to the primary (most-specific) candidate
 *     (degree / major / certification); the popup edits the full ordered list.
 * Stored value is always the candidate string[].
 */
export function CandidateField({
  label,
  value,
  onChange,
  mode = "text",
  countries,
  expand,
  dropdownMode = "country",
  placeholder,
  bucketPath,
}: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  mode?: "text" | "dropdown";
  countries?: CountryLike[];
  expand?: (c: CountryLike) => string[];
  dropdownMode?: "country" | "phone";
  placeholder?: string;
  bucketPath?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected =
    mode === "dropdown" && countries && expand
      ? countries.find((c) => expand(c).some((cand) => cand === value[0]))?.name ?? ""
      : "";
  const setPrimary = (v: string) => {
    const rest = value.slice(1);
    if (!v.trim() && rest.length === 0) onChange([]);
    else onChange([v, ...rest]);
  };
  const extra = value.length - 1; // fallbacks beyond the primary
  return (
    <div className="group">
      <FieldLabel bucketPath={bucketPath} bucketWidget={mode === "dropdown" ? "dropdown" : "typeahead"}>{label}</FieldLabel>
      <div className="relative mt-1.5">
        {mode === "dropdown" && countries && expand ? (
          <select
            value={selected}
            onChange={(e) => {
              const c = countries.find((x) => x.name === e.target.value);
              if (c) onChange(expand(c));
            }}
            className={clsx(inputCls, "appearance-none pr-9")}
          >
            <option value="">Choose a country…</option>
            {countries.map((c) => (
              <option key={c.name} value={c.name} className="bg-panel">
                {dropdownMode === "phone" ? `${c.name} (${c.dial})` : c.name}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={value[0] || ""}
            placeholder={placeholder}
            onChange={(e) => setPrimary(e.target.value)}
            className={clsx(inputCls, "pr-9")}
          />
        )}
        {/* subtle in-field arrow → the fallback-candidates popup (amber when fallbacks exist) */}
        <button
          type="button"
          onClick={() => setOpen(true)}
          title={extra > 0 ? `${extra} fallback${extra === 1 ? "" : "s"} — more choices` : "More choices — fallback wordings"}
          aria-label="More choices"
          className={clsx(
            "absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 transition-colors",
            extra > 0 ? "text-amber" : "text-ink-faint hover:text-amber"
          )}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      {open && <AdvancedChoices label={label} value={value} onChange={onChange} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** Modal for the ordered fallback candidate list. Backdrop click or Escape closes. */
function AdvancedChoices({
  label,
  value,
  onChange,
  onClose,
}: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-md rounded-xl border border-hairline bg-panel p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-mono text-[11px] uppercase tracking-label text-ink-dim">{label} — advanced choices</h3>
          <button type="button" onClick={onClose} className="text-ink-faint hover:text-ink" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-3 text-xs leading-relaxed text-ink-dim">
          Ordered fallbacks the extension tries if the main value isn&apos;t on the form — most-specific first.
        </p>
        <TieredField label="Candidates" value={value} onChange={onChange} />
        <div className="mt-4 flex justify-end">
          <button type="button" onClick={onClose} className="btn-primary">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Display form for a typed month: "5" or "05" → "05 — May" (raw when invalid). */
function monthLabel(m: string): string {
  if (!m) return "";
  const n = Number(m);
  return n >= 1 && n <= 12 ? `${String(n).padStart(2, "0")} — ${MONTHS[n - 1]}` : m;
}

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
  bucketPath,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  granularity: DateGranularity;
  hint?: string;
  bucketPath?: string;
}) {
  const [parts, setParts] = useState<DateParts>(() => parseDateValue(value, granularity));
  const [monthFocused, setMonthFocused] = useState(false);
  const set = (patch: Partial<DateParts>) => {
    const next = { ...parts, ...patch };
    setParts(next);
    onChange(assembleDate(next, granularity));
  };
  const seg =
    "rounded-lg border border-hairline bg-cockpit px-2.5 py-2 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-amber";
  return (
    <div className="group">
      <FieldLabel hint={hint} bucketPath={bucketPath} bucketWidget="date">{label}</FieldLabel>
      <div className="mt-1.5 flex gap-2">
        {granularity !== "year" && (
          <input
            aria-label={`${label} month`}
            inputMode="numeric"
            value={monthFocused ? parts.month : monthLabel(parts.month)}
            placeholder="MM"
            onFocus={() => setMonthFocused(true)}
            onChange={(e) => set({ month: e.target.value.replace(/\D/g, "").slice(0, 2) })}
            onBlur={() => {
              setMonthFocused(false);
              const n = Number(parts.month);
              if (!(n >= 1 && n <= 12)) set({ month: "" }); // invalid → clear
            }}
            className={clsx(seg, "flex-1")}
          />
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

/** A single labeled checkbox (e.g. "I am fluent") — a human-controlled boolean. */
export function CheckboxField({
  label,
  checked,
  onChange,
  hint,
  bucketPath,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
  bucketPath?: string;
}) {
  return (
    <label className="group flex cursor-pointer select-none items-center gap-2.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 shrink-0 accent-amber"
      />
      <FieldLabel bucketPath={bucketPath} bucketWidget="checkbox">{label}</FieldLabel>
      {hint && <span className="text-[11px] text-ink-faint">{hint}</span>}
    </label>
  );
}

type StoredFile = { path: string; filename: string; size: number; mime: string };

/** Upload a file to the private attachments bucket, then show it with a remove
 *  control. `value` is the stored file reference (or null). */
export function FileField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: StoredFile | null;
  onChange: (v: StoredFile | null) => void;
  hint?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pick = async (file: File) => {
    setBusy(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/attachments/upload", { method: "POST", body: fd });
      const j = await res.json();
      if (!res.ok || !j.ok) setErr(j.error || "Upload failed.");
      else onChange(j.file);
    } catch {
      setErr("Upload failed — is the backend connected?");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <FieldLabel hint={hint}>{label}</FieldLabel>
      <div className="mt-1.5">
        {value && value.path ? (
          <div className="flex items-center gap-2 rounded-lg border border-hairline bg-panel-raised px-3 py-2 text-sm">
            <Paperclip className="h-4 w-4 shrink-0 text-ink-faint" />
            <span className="flex-1 truncate text-ink">{value.filename}</span>
            <button
              type="button"
              onClick={() => onChange(null)}
              className="text-ink-faint transition-colors hover:text-signal"
              aria-label="Remove file"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <label
            className={clsx(
              "inline-flex cursor-pointer items-center gap-2 rounded-lg border border-hairline px-3 py-2 text-sm transition-colors",
              busy ? "text-ink-faint" : "text-ink-dim hover:border-amber hover:text-ink"
            )}
          >
            <Upload className="h-4 w-4" />
            {busy ? "Uploading…" : "Upload file"}
            <input
              type="file"
              className="hidden"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.currentTarget.value = "";
                if (f) pick(f);
              }}
            />
          </label>
        )}
        {err && <p className="mt-1 text-xs text-signal">{err}</p>}
      </div>
    </div>
  );
}
