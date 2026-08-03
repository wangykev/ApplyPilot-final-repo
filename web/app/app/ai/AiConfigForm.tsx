"use client";

import { useMemo, useState, useTransition } from "react";
import { Save, Plug, Eye, EyeOff, Plus, Trash2, ChevronUp, ChevronDown, ExternalLink } from "lucide-react";
import { SectionCard } from "@/components/app/SectionCard";
import { SelectField, FieldLabel } from "@/components/form/fields";
import {
  LLM_MODELS, LLM_DEFAULT_MODELS, LLM_PROVIDER_LABELS, GEMINI_FREE_TIER, LLM_PRICING, LLM_PRICING_URLS,
  type LlmProvider,
} from "@/lib/llm";
import { LLM_ACTIONS, type LlmAction } from "@/lib/llm-keys";
import { PROVIDERS, keysForProvider, totalUsableKeys, type AiConfig, type LlmKeyEntry } from "@/lib/ai-config";
import { saveAiConfig, testLlmKey } from "./actions";
import { liveSync } from "@/lib/extension-sync";
import { clsx } from "@/lib/clsx";

/** What each routable action is, in the operator's words. Order = display order. */
const ACTION_COPY: Record<LlmAction, { label: string; desc: string }> = {
  fill: {
    label: "Form fill",
    desc: "Screening questions the deterministic matcher can't answer. The highest-volume caller by far — one application can ask dozens.",
  },
  resume_parse: {
    label: "Resume parsing",
    desc: "Reading an uploaded PDF into profile fields. Runs once per resume, so quality matters more than cost here.",
  },
  cover_letter: { label: "Cover letter", desc: "Drafting a letter from your profile and the job description." },
  teach: { label: "Teach", desc: "Working out which profile field a question belongs to when you correct a fill." },
};

const money = (n: number) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);
const compact = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

/** The rate line for a model: free-tier limits when free, otherwise the paid rate. */
function modelRate(provider: LlmProvider, model: string, free: boolean): string {
  const limits = GEMINI_FREE_TIER[model];
  if (free && provider === "gemini" && limits) {
    return `free · ${limits.rpm}/min · ${compact(limits.tpm)} tok/min · ${limits.rpd}/day`;
  }
  const price = LLM_PRICING[model];
  return price ? `${money(price.in)} in / ${money(price.out)} out per 1M` : "see pricing";
}

export function AiConfigForm({ initial }: { initial: AiConfig }) {
  const [cfg, setCfg] = useState<AiConfig>(initial);
  const [savedCfg, setSavedCfg] = useState<AiConfig>(initial);
  const [saving, startSave] = useTransition();
  const [saveMsg, setSaveMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Deep compare: the config is now nested (key lists, route chains), so field-by-field
  // dirty checks would miss most edits.
  const dirty = useMemo(() => JSON.stringify(cfg) !== JSON.stringify(savedCfg), [cfg, savedCfg]);

  const edit = (updater: (c: AiConfig) => AiConfig) => {
    setCfg(updater);
    setSaveMsg(null);
  };

  /**
   * Gemini is in FREE MODE when every key it holds is free-tier. That is the moment the
   * model list must narrow: a free key cannot reach gemini-2.5-pro at all, so offering it
   * would guarantee a quota error on the first request. Add one paid Gemini key and the
   * full list comes back.
   */
  const geminiKeys = keysForProvider(cfg, "gemini").filter((k) => k.key && k.enabled);
  const geminiFreeOnly = geminiKeys.length > 0 && geminiKeys.every((k) => k.tier === "free");

  const modelOptions = (provider: LlmProvider) => {
    const freeOnly = provider === "gemini" && geminiFreeOnly;
    const ids = freeOnly ? LLM_MODELS.gemini.filter((m) => GEMINI_FREE_TIER[m]) : LLM_MODELS[provider];
    return ids.map((m) => ({ value: m, label: `${m} — ${modelRate(provider, m, freeOnly)}` }));
  };

  const save = () =>
    startSave(async () => {
      setSaveMsg(null);
      const res = await saveAiConfig(cfg);
      if (res.ok) {
        setSavedCfg(cfg);
        setSaveMsg({ kind: "ok", text: "Saved" });
        liveSync("ai"); // mirror into a connected extension (no-op when not connected)
      } else {
        setSaveMsg({ kind: "err", text: res.error });
      }
    });

  return (
    <div className="space-y-6">
      {/* ── AI fill on/off ─────────────────────────────────────────────── */}
      <SectionCard
        title="AI fill"
        subtitle="When off, nothing here is ever called — no AI spend, and screening questions stay blank for review."
      >
        <div className="flex items-center justify-between gap-4">
          <div className="text-sm text-ink-dim">
            {cfg.enabled
              ? "On — the extension may call a model for questions it can't match deterministically."
              : "Off."}
            {cfg.enabled && totalUsableKeys(cfg) === 0 && (
              <span className="ml-1 text-signal">No usable key yet, so those calls will fail.</span>
            )}
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
      </SectionCard>

      {/* ── Keys ───────────────────────────────────────────────────────── */}
      <SectionCard
        title="API keys"
        subtitle="Add more than one key to a provider and they are tried in order — when the first is rate-limited or out of quota the next takes over, instead of the fill giving up. Stored on your account and used server-side."
      >
        <div className="space-y-4">
          {PROVIDERS.map((provider) => (
            <ProviderKeys key={provider} provider={provider} cfg={cfg} edit={edit} geminiFreeOnly={geminiFreeOnly} />
          ))}
        </div>
      </SectionCard>

      {/* ── Default model ──────────────────────────────────────────────── */}
      <SectionCard
        title="Default model"
        subtitle="Used by every action that does not override it below. A fallback is tried once every key for the provider above it is spent."
      >
        <RouteEditor
          target={{ provider: cfg.provider, model: cfg.model, fallbacks: cfg.fallbacks }}
          modelOptions={modelOptions}
          onChange={(next) =>
            edit((c) => ({ ...c, provider: next.provider, model: next.model, fallbacks: next.fallbacks }))
          }
        />
      </SectionCard>

      {/* ── Per action ─────────────────────────────────────────────────── */}
      <SectionCard
        title="Model per action"
        subtitle="Give any job its own model — something cheap and fast for the high-volume fill, something stronger for a cover letter. Leave an action on “Use default” and it follows the section above."
      >
        <div className="space-y-4">
          {LLM_ACTIONS.map((action) => (
            <ActionRoute key={action} action={action} cfg={cfg} edit={edit} modelOptions={modelOptions} />
          ))}
        </div>
      </SectionCard>

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={save}
          disabled={saving || !dirty}
          className="btn-primary"
          title={!dirty ? "No changes to save" : undefined}
        >
          <Save className="h-4 w-4" />
          {saving ? "Saving…" : "Save AI config"}
        </button>
        {saveMsg && (
          <span className={clsx("text-sm", saveMsg.kind === "ok" ? "text-verified" : "text-signal")}>
            {saveMsg.kind === "ok" ? "✓ " : ""}
            {saveMsg.text}
          </span>
        )}
      </div>
    </div>
  );
}

/* ─── One provider's key list ───────────────────────────────────────────── */

function ProviderKeys({
  provider,
  cfg,
  edit,
  geminiFreeOnly,
}: {
  provider: LlmProvider;
  cfg: AiConfig;
  edit: (u: (c: AiConfig) => AiConfig) => void;
  geminiFreeOnly: boolean;
}) {
  const keys = keysForProvider(cfg, provider);
  // Gemini is the only one of the three that serves a free tier, so it is the only
  // provider where the free/paid question is real — asking it of an Anthropic key would
  // be inventing a choice that does not exist.
  const hasFreeTier = provider === "gemini";
  const [newKey, setNewKey] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newTier, setNewTier] = useState<"free" | "paid">(hasFreeTier ? "free" : "paid");

  const setKeys = (next: LlmKeyEntry[]) => edit((c) => ({ ...c, keys: { ...c.keys, [provider]: next } }));

  const add = () => {
    const secret = newKey.trim();
    if (!secret || keys.some((k) => k.key === secret)) return;
    setKeys([
      ...keys,
      {
        id: `k${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
        label: newLabel.trim(),
        key: secret,
        tier: hasFreeTier ? newTier : "paid",
        enabled: true,
      },
    ]);
    setNewKey("");
    setNewLabel("");
  };

  const usable = keys.filter((k) => k.key && k.enabled).length;

  return (
    <div className="rounded-lg border border-hairline bg-panel-raised/30 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h3 className="text-sm text-ink">{LLM_PROVIDER_LABELS[provider]}</h3>
          <span className="text-xs text-ink-faint">
            {usable ? `${usable} key${usable === 1 ? "" : "s"} in rotation` : "no keys"}
          </span>
        </div>
        <a
          href={LLM_PRICING_URLS[provider]}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-ink-dim transition-colors hover:text-ink"
        >
          rates <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      {hasFreeTier && (
        <p className="mt-2 text-xs leading-relaxed text-ink-dim">
          An AI Studio key is free-tier unless its project has billing enabled, and the key looks identical either way —
          so mark it yourself. Free keys are spent before paid ones.
          {geminiFreeOnly && (
            <>
              {" "}
              <span className="text-ink">Every Gemini key here is free, so only free-tier models are offered</span> —
              gemini-2.5-pro needs a billed key.
            </>
          )}
        </p>
      )}

      {keys.length > 0 && (
        <div className="mt-3 space-y-2">
          {keys.map((k, i) => (
            <KeyRow
              key={k.id}
              entry={k}
              index={i}
              total={keys.length}
              provider={provider}
              hasFreeTier={hasFreeTier}
              onChange={(next) => setKeys(keys.map((x, j) => (j === i ? next : x)))}
              onRemove={() => setKeys(keys.filter((_, j) => j !== i))}
              onMove={(delta) => {
                const to = i + delta;
                if (to < 0 || to >= keys.length) return;
                const next = [...keys];
                [next[i], next[to]] = [next[to], next[i]];
                setKeys(next);
              }}
            />
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="Label (optional)"
          className="w-36 rounded-lg border border-hairline bg-cockpit px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-amber"
        />
        <input
          type="password"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          placeholder={`Paste your ${LLM_PROVIDER_LABELS[provider]} key`}
          autoComplete="off"
          className="min-w-[15rem] flex-1 rounded-lg border border-hairline bg-cockpit px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-amber"
        />
        {hasFreeTier && (
          <select
            value={newTier}
            onChange={(e) => setNewTier(e.target.value as "free" | "paid")}
            className="rounded-lg border border-hairline bg-cockpit px-2 py-2 text-sm text-ink outline-none focus:border-amber"
          >
            <option value="free" className="bg-panel">Free tier</option>
            <option value="paid" className="bg-panel">Paid</option>
          </select>
        )}
        <button type="button" onClick={add} disabled={!newKey.trim()} className="btn-ghost">
          <Plus className="h-4 w-4" />
          Add
        </button>
      </div>
    </div>
  );
}

function KeyRow({
  entry,
  index,
  total,
  provider,
  hasFreeTier,
  onChange,
  onRemove,
  onMove,
}: {
  entry: LlmKeyEntry;
  index: number;
  total: number;
  provider: LlmProvider;
  hasFreeTier: boolean;
  onChange: (next: LlmKeyEntry) => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
}) {
  const [show, setShow] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const test = async () => {
    setTesting(true);
    setMsg(null);
    const res = await testLlmKey({ provider, key: entry.key });
    setMsg(res.ok ? { kind: "ok", text: "works" } : { kind: "err", text: res.error });
    setTesting(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-hairline bg-cockpit/60 p-2">
      <div className="flex flex-col">
        <button
          type="button"
          onClick={() => onMove(-1)}
          disabled={index === 0}
          title="Try this key earlier"
          className="px-1 text-ink-dim transition-colors hover:text-ink disabled:opacity-30"
        >
          <ChevronUp className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={() => onMove(1)}
          disabled={index === total - 1}
          title="Try this key later"
          className="px-1 text-ink-dim transition-colors hover:text-ink disabled:opacity-30"
        >
          <ChevronDown className="h-3 w-3" />
        </button>
      </div>

      <span className="w-4 font-mono text-[10px] text-ink-faint">{index + 1}</span>

      <input
        value={entry.label}
        onChange={(e) => onChange({ ...entry, label: e.target.value })}
        placeholder={`Key ${index + 1}`}
        className="w-24 rounded border border-hairline bg-cockpit px-2 py-1 text-xs text-ink outline-none placeholder:text-ink-faint focus:border-amber"
      />

      <input
        type={show ? "text" : "password"}
        value={entry.key}
        onChange={(e) => onChange({ ...entry, key: e.target.value })}
        autoComplete="off"
        className="min-w-[11rem] flex-1 rounded border border-hairline bg-cockpit px-2 py-1 font-mono text-xs text-ink outline-none focus:border-amber"
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        className="px-1 text-ink-dim transition-colors hover:text-ink"
        aria-label={show ? "Hide key" : "Show key"}
      >
        {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>

      {hasFreeTier && (
        <select
          value={entry.tier}
          onChange={(e) => onChange({ ...entry, tier: e.target.value as "free" | "paid" })}
          title="Free-tier keys are spent before paid ones"
          className="rounded border border-hairline bg-cockpit px-1.5 py-1 text-xs text-ink outline-none focus:border-amber"
        >
          <option value="free" className="bg-panel">Free</option>
          <option value="paid" className="bg-panel">Paid</option>
        </select>
      )}

      <label className="flex items-center gap-1 text-xs text-ink-dim" title="Include this key in rotation">
        <input
          type="checkbox"
          checked={entry.enabled}
          onChange={(e) => onChange({ ...entry, enabled: e.target.checked })}
        />
        on
      </label>

      <button type="button" onClick={test} disabled={testing || !entry.key} className="btn-ghost px-2 py-1 text-xs">
        <Plug className="h-3 w-3" />
        {testing ? "…" : "Test"}
      </button>
      {msg && (
        <span
          className={clsx("max-w-[14rem] truncate text-xs", msg.kind === "ok" ? "text-verified" : "text-signal")}
          title={msg.text}
        >
          {msg.kind === "ok" ? "✓ works" : `✗ ${msg.text}`}
        </span>
      )}

      <button
        type="button"
        onClick={onRemove}
        className="px-1 text-ink-dim transition-colors hover:text-signal"
        aria-label="Remove key"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/* ─── A provider+model pair with its fallback chain ──────────────────────── */

type RouteTarget = { provider: LlmProvider; model: string };
type RouteValue = RouteTarget & { fallbacks: RouteTarget[] };

function RouteEditor({
  target,
  modelOptions,
  onChange,
}: {
  target: RouteValue;
  modelOptions: (p: LlmProvider) => { value: string; label: string }[];
  onChange: (next: RouteValue) => void;
}) {
  const providerOptions = PROVIDERS.map((p) => ({ value: p, label: LLM_PROVIDER_LABELS[p] }));

  const setPair = (i: number | null, provider: LlmProvider, model: string) => {
    if (i === null) return onChange({ ...target, provider, model });
    onChange({ ...target, fallbacks: target.fallbacks.map((f, j) => (j === i ? { provider, model } : f)) });
  };

  const row = (pair: RouteTarget, i: number | null) => {
    const opts = modelOptions(pair.provider);
    // A provider swap has to carry the model with it, or the pair ends up naming a model
    // the new provider has never heard of.
    const onProvider = (v: string) => {
      const p = v as LlmProvider;
      const list = modelOptions(p);
      const keep = list.some((o) => o.value === pair.model) ? pair.model : list[0]?.value || LLM_DEFAULT_MODELS[p];
      setPair(i, p, keep);
    };
    return (
      <div key={i ?? "primary"} className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[11rem_1fr_2.5rem]">
        <SelectField
          label={i === null ? "Provider" : `Fallback ${i + 1}`}
          value={pair.provider}
          options={providerOptions}
          onChange={onProvider}
        />
        <SelectField label="Model" value={pair.model} options={opts} onChange={(v) => setPair(i, pair.provider, v)} />
        {i === null ? (
          <span />
        ) : (
          <button
            type="button"
            onClick={() => onChange({ ...target, fallbacks: target.fallbacks.filter((_, j) => j !== i) })}
            className="btn-ghost mb-0.5 px-2 py-2"
            aria-label={`Remove fallback ${i + 1}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-3">
      {row({ provider: target.provider, model: target.model }, null)}
      {target.fallbacks.map((f, i) => row(f, i))}
      {target.fallbacks.length < 4 && (
        <button
          type="button"
          onClick={() =>
            onChange({
              ...target,
              fallbacks: [
                ...target.fallbacks,
                { provider: target.provider, model: modelOptions(target.provider)[1]?.value || target.model },
              ],
            })
          }
          className="btn-ghost"
        >
          <Plus className="h-4 w-4" />
          Add fallback
        </button>
      )}
      <p className="text-xs leading-relaxed text-ink-dim">
        A fallback can be another <span className="text-ink">model</span> or another <span className="text-ink">provider</span>{" "}
        entirely. Both matter on Gemini&apos;s free tier, where requests-per-day is counted per model — when one
        model&apos;s daily allowance is gone, the same key still has the next one&apos;s.
      </p>
    </div>
  );
}

function ActionRoute({
  action,
  cfg,
  edit,
  modelOptions,
}: {
  action: LlmAction;
  cfg: AiConfig;
  edit: (u: (c: AiConfig) => AiConfig) => void;
  modelOptions: (p: LlmProvider) => { value: string; label: string }[];
}) {
  const route = cfg.routes?.[action];
  const copy = ACTION_COPY[action];

  const setRoute = (next: RouteValue | null) =>
    edit((c) => {
      const routes = { ...(c.routes ?? {}) };
      if (next) routes[action] = next;
      else delete routes[action];
      return { ...c, routes };
    });

  return (
    <div className="rounded-lg border border-hairline bg-panel-raised/30 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm text-ink">{copy.label}</h3>
        <label className="flex items-center gap-2 text-xs text-ink-dim">
          <input
            type="checkbox"
            checked={!route}
            onChange={(e) =>
              setRoute(e.target.checked ? null : { provider: cfg.provider, model: cfg.model, fallbacks: [] })
            }
          />
          Use default
        </label>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-ink-dim">{copy.desc}</p>
      {route ? (
        <div className="mt-3">
          <RouteEditor target={route} modelOptions={modelOptions} onChange={setRoute} />
        </div>
      ) : (
        <p className="mt-2 flex items-baseline gap-2 text-xs text-ink-faint">
          <FieldLabel>Following default</FieldLabel>
          <span className="font-mono">
            {cfg.provider} / {cfg.model || LLM_DEFAULT_MODELS[cfg.provider]}
          </span>
        </p>
      )}
    </div>
  );
}
