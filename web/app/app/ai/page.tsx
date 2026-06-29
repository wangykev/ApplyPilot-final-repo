import { PageHeader } from "@/components/app/PageHeader";

export default function AiPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Engine"
        title="AI configuration"
        description="Pick a provider and model, add your API key, and toggle AI fill. Mirrors the extension's AI settings."
      />
      <div className="bezel p-10 text-center text-sm text-ink-dim">
        AI configuration — built in M6.
      </div>
    </div>
  );
}
