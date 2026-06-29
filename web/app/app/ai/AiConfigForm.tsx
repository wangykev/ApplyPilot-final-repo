"use client";

import { useState, useTransition } from "react";
import { Save, Plug, Eye, EyeOff } from "lucide-react";
import { SectionCard } from "@/components/app/SectionCard";
import { SelectField, FieldLabel } from "@/components/form/fields";
import { LLM_MODELS, LLM_DEFAULT_MODELS, LLM_PROVIDER_LABELS, type LlmProvider } from "@/lib/llm";
import { PROVIDERS, type AiConfig } from "@/lib/ai-config";
import { saveAiConfig, testLlm } from "./actions";
import { clsx } from "@/lib/clsx";

export function AiConfigForm({ initial }: { initial: AiConfig }) {
  const [cfg, setCfg] = useState<AiConfig>(initial);
  const [showKey, setShowKey] = useState(false);
  const [saving, startSave] = useTransition();
  const [testing, setTesting] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [testMsg, setTestMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const setProvider = (p: string) => {
    const provider = p as LlmProvider;
    setCfg((c) => ({ ...c, provider, model: LLM_DEFAULT_MODELS[provider] }));
  };

  const save = () =>
    startSave(async () => {
      setSaveMsg(null);
      const res = await saveAiConfig(cfg);
      setSaveMsg(res.ok ? { kind: "ok", text: "Saved" } : { kind: "err", text: res.error });
    });

  const test = async () => {
    setTesting(true);
    setTestMsg(null);
    const res = await testLlm(cfg);
    setTestMsg(
      res.ok
        ? { kind: "ok", text: `Connected — model replied "${res.text}".` }
        : { kind: "err", text: res.error }
    );
    setTesting(false);
  };

  const providerOptions = PROVIDERS.map((p) => ({ value: p, label: LLM_PROVIDER_LABELS[p] }));
  const modelOptions = LLM_MODELS[cfg.provider].map((m) => ({ value: m, label: m }));

  return (
    <SectionCard
      title="AI provider"
      subtitle="Used to answer screening questions and parse resumes. Your key is stored on your account and used server-side — never shown to other users."
    >
      <div className="space-y-5">
        {/* enable toggle */}
        <div className="flex items-center justify-between rounded-lg border border-hairline bg-panel-raised/40 p-4">
          <div>
            <div className="text-sm text-ink">AI fill</div>
            <div className="mt-0.5 text-xs text-ink-dim">
              When off, the extension never calls a provider — no AI spend, screening questions stay blank for review.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={cfg.enabled}
            onClick={() => setCfg((c) => ({ ...c, enabled: !c.enabled }))}
            className={clsx(
              "relative h-6 w-11 shrink-0 rounded-full transition-colors",
              cfg.enabled ? "bg-amber" : "bg-hairline"
            )}
          >
            <span
              className={clsx(
                "absolute top-0.5 h-5 w-5 rounded-full bg-cockpit transition-transform",
                cfg.enabled ? "translate-x-[22px]" : "translate-x-0.5"
              )}
            />
          </button>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SelectField label="Provider" value={cfg.provider} options={providerOptions} onChange={setProvider} />
          <SelectField
            label="Model"
            value={cfg.model}
            options={modelOptions}
            onChange={(v) => setCfg((c) => ({ ...c, model: v }))}
          />
        </div>

        <div>
          <FieldLabel hint="stored on your account; never exposed to the browser of others">API key</FieldLabel>
          <div className="mt-1.5 flex gap-2">
            <input
              type={showKey ? "text" : "password"}
              value={cfg.apiKey}
              onChange={(e) => setCfg((c) => ({ ...c, apiKey: e.target.value }))}
              placeholder="Paste your provider API key"
              autoComplete="off"
              className="w-full rounded-lg border border-hairline bg-cockpit px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-amber"
            />
            <button
              type="button"
              onClick={() => setShowKey((s) => !s)}
              className="btn-ghost shrink-0 px-3 py-2"
              aria-label={showKey ? "Hide key" : "Show key"}
            >
              {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <button onClick={save} disabled={saving} className="btn-primary">
            <Save className="h-4 w-4" />
            {saving ? "Saving…" : "Save AI config"}
          </button>
          <button onClick={test} disabled={testing} className="btn-ghost">
            <Plug className="h-4 w-4" />
            {testing ? "Testing…" : "Test connection"}
          </button>
          {saveMsg && (
            <span className={clsx("text-sm", saveMsg.kind === "ok" ? "text-verified" : "text-signal")}>
              {saveMsg.kind === "ok" ? "✓ " : ""}
              {saveMsg.text}
            </span>
          )}
        </div>
        {testMsg && (
          <p className={clsx("text-sm", testMsg.kind === "ok" ? "text-verified" : "text-signal")}>
            {testMsg.text}
          </p>
        )}
      </div>
    </SectionCard>
  );
}
