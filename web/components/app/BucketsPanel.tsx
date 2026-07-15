"use client";

import { useState, useTransition } from "react";
import { Plus, Trash2, Save, Link2, FileQuestion } from "lucide-react";
import { SectionCard } from "@/components/app/SectionCard";
import { SelectField, TagListField, TextField, CheckboxField } from "@/components/form/fields";
import { saveBuckets } from "@/app/app/profile/actions";
import { isModeA, type Bucket } from "@/lib/buckets";
import { clsx } from "@/lib/clsx";

const WIDGET_OPTS = [
  { value: "text", label: "text" },
  { value: "dropdown", label: "dropdown" },
  { value: "radio", label: "radio" },
  { value: "typeahead", label: "typeahead" },
  { value: "checkbox", label: "checkbox" },
];

/**
 * Manage answer buckets: each is one answer + the question wordings that resolve
 * to it. Mode A (profile-backed) shows its bound profile field read-only — the
 * value always comes from the profile; you edit the wordings. Mode B (standalone)
 * holds its own value. See docs/profile-v2-plan.md.
 */
export function BucketsPanel({ initial }: { initial: Bucket[] }) {
  const [buckets, setBuckets] = useState<Bucket[]>(initial);
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<{ kind: "idle" | "ok" | "err"; msg?: string }>({ kind: "idle" });

  const update = (fn: (b: Bucket[]) => void) =>
    setBuckets((prev) => {
      const next = structuredClone(prev);
      fn(next);
      return next;
    });

  const save = () =>
    startTransition(async () => {
      setStatus({ kind: "idle" });
      const res = await saveBuckets(buckets);
      setStatus(res.ok ? { kind: "ok" } : { kind: "err", msg: res.error });
    });

  const addStandalone = () =>
    update((b) =>
      b.push({
        id: "answer_" + Date.now().toString(36),
        profile_path: "",
        value: "",
        widget_hint: "text",
        sensitive: false,
        questions: [],
        selectors: {},
      })
    );

  return (
    <SectionCard
      title="Answer buckets"
      subtitle="Each bucket is one answer plus the question wordings that map to it — edit a wording once and every phrasing fills the same way. Profile-backed buckets pull their value from the field above; standalone buckets hold their own."
      actions={
        <button type="button" onClick={addStandalone} className="btn-ghost px-3 py-1.5 text-xs">
          <Plus className="h-3.5 w-3.5" />
          Add standalone answer
        </button>
      }
    >
      {buckets.length === 0 && <p className="py-2 text-sm text-ink-faint">No buckets yet.</p>}
      <div className="space-y-4">
        {buckets.map((bk, i) => {
          const modeA = isModeA(bk);
          return (
            <div key={bk.id} className="rounded-lg border border-hairline bg-panel-raised/40 p-4">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={clsx(
                      "inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[10px] uppercase tracking-label",
                      modeA ? "bg-verified/10 text-verified" : "bg-amber/10 text-amber"
                    )}
                  >
                    {modeA ? <Link2 className="h-3 w-3" /> : <FileQuestion className="h-3 w-3" />}
                    {modeA ? "profile-backed" : "standalone"}
                  </span>
                  {bk.sensitive && (
                    <span className="rounded-md bg-signal/10 px-2 py-1 font-mono text-[10px] uppercase tracking-label text-signal">
                      sensitive
                    </span>
                  )}
                  {modeA && (
                    <code className="rounded bg-cockpit px-1.5 py-0.5 font-mono text-[11px] text-ink-dim">
                      {bk.profile_path}
                    </code>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => update((b) => b.splice(i, 1))}
                  className="inline-flex items-center gap-1 text-xs text-ink-faint transition-colors hover:text-signal"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Remove
                </button>
              </div>

              {!modeA && (
                <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <TextField
                    label="Answer value"
                    value={bk.value}
                    placeholder="The value to fill"
                    onChange={(v) => update((b) => { b[i].value = v; })}
                  />
                  <SelectField
                    label="Field type"
                    value={bk.widget_hint}
                    options={WIDGET_OPTS}
                    onChange={(v) => update((b) => { b[i].widget_hint = v; })}
                  />
                </div>
              )}

              <TagListField
                label="Question wordings"
                value={bk.questions}
                placeholder="Add a wording a form might use, press Enter"
                onChange={(v) => update((b) => { b[i].questions = v; })}
              />

              <div className="mt-3">
                <CheckboxField
                  label="Sensitive (EEO / legal)"
                  checked={bk.sensitive}
                  onChange={(v) => update((b) => { b[i].sensitive = v; })}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-5 flex items-center justify-between gap-4 border-t border-hairline pt-4">
        <span
          className={clsx(
            "font-mono text-[11px] tracking-label",
            status.kind === "ok" && "text-verified",
            status.kind === "err" && "text-signal",
            status.kind === "idle" && "text-ink-faint"
          )}
        >
          {status.kind === "ok" ? "✓ BUCKETS SAVED" : status.kind === "err" ? status.msg : "BUCKET EDITS ARE LOCAL UNTIL SAVED"}
        </span>
        <button onClick={save} disabled={pending} className="btn-primary">
          <Save className="h-4 w-4" />
          {pending ? "Saving…" : "Save buckets"}
        </button>
      </div>
    </SectionCard>
  );
}
