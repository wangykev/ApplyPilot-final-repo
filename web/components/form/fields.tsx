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
