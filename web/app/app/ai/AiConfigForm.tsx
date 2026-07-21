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
  const [savedCfg, setSavedCfg] = useState<AiConfig>(initial); // last persisted value — the dirty baseline
  const [showKey, setShowKey] = useState(false);
  const [saving, startSave] = useTransition();
  const [testing, setTesting] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [testMsg, setTestMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Only allow Save when the config actually DIFFERS from what's stored (no redundant write + sync).
  const dirty =
    cfg.provider !== savedCfg.provider ||
    cfg.model !== savedCfg.model ||
    cfg.apiKey !== savedCfg.apiKey ||
    cfg.enabled !== savedCfg.enabled;

  // Any edit invalidates the stale "Saved ✓" note.
  const edit = (updater: (c: AiConfig) => AiConfig) => {
    setCfg(updater);
    setSaveMsg(null);
  };

  const setProvider = (p: string) => {
    const provider = p as LlmProvider;
    edit((c) => ({ ...c, provider, model: LLM_DEFAULT_MODELS[provider] }));
  };

  const save = () =>
    startSave(async () => {
      setSaveMsg(null);
      const res = await saveAiConfig(cfg);
      if (res.ok) {
        setSavedCfg(cfg); // now clean — Save disables until the next change
        setSaveMsg({ kind: "ok", text: "Saved" });
      } else {
        setSaveMsg({ kind: "err", text: res.error });
      }
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
            aria-label="AI fill"
            onClick={() => edit((c) => ({ ...c, enabled: !c.enabled }))}
            className={clsx(
              "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full outline-none transition-colors",
              "focus-visible:ring-2 focus-visible:ring-amber/60 focus-visible:ring-offset-2 focus-visible:ring-offset-panel",
              cfg.enabled ? "bg-amber" : "bg-panel-raised ring-1 ring-inset ring-hairline"
            )}
          >
            <span
              className={clsx(
                "inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform",
                cfg.enabled ? "translate-x-[1.375rem]" : "translate-x-0.5"
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
            onChange={(v) => edit((c) => ({ ...c, model: v }))}
          />
        </div>

        <div>
          <FieldLabel hint="stored on your account; never exposed to the browser of others">API key</FieldLabel>
          <div className="mt-1.5 flex gap-2">
            <input
              type={showKey ? "text" : "password"}
              value={cfg.apiKey}
              onChange={(e) => edit((c) => ({ ...c, apiKey: e.target.value }))}
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
          <button onClick={save} disabled={saving || !dirty} className="btn-primary" title={!dirty ? "No changes to save" : undefined}>
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
