"use client";

import { useState, useTransition } from "react";
import { Save, Info } from "lucide-react";
import { SectionCard } from "@/components/app/SectionCard";
import { TextField } from "@/components/form/fields";
import { saveJobContext } from "./actions";
import { clsx } from "@/lib/clsx";

export function JobContextForm({ initialCompany }: { initialCompany: string }) {
  const [company, setCompany] = useState(initialCompany);
  const [saving, startSave] = useTransition();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const save = () =>
    startSave(async () => {
      setMsg(null);
      const res = await saveJobContext({ company: company.trim() });
      setMsg(res.ok ? { kind: "ok", text: "Saved" } : { kind: "err", text: res.error });
    });

  return (
    <SectionCard
      title="Target company"
      subtitle="Set this to the company you're applying to right now. The extension uses it to answer “have you worked here before?” safely and to corroborate the source picker."
    >
      <div className="max-w-md space-y-4">
        <TextField
          label="Company"
          value={company}
          placeholder="e.g. Comcast"
          onChange={setCompany}
        />
        <div className="flex items-center gap-3">
          <button onClick={save} disabled={saving} className="btn-primary">
            <Save className="h-4 w-4" />
            {saving ? "Saving…" : "Save company"}
          </button>
          {msg && (
            <span className={clsx("text-sm", msg.kind === "ok" ? "text-verified" : "text-signal")}>
              {msg.kind === "ok" ? "✓ " : ""}
              {msg.text}
            </span>
          )}
        </div>
      </div>

      <div className="mt-6 flex gap-3 rounded-lg border border-hairline bg-panel-raised/40 p-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-dim" />
        <p className="text-xs leading-relaxed text-ink-dim">
          For now this is set by hand, one company at a time. When the job queue lands, each queued
          Workday link will set its own company automatically.
        </p>
      </div>
    </SectionCard>
  );
}
