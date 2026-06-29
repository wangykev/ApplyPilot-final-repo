import { PageHeader } from "@/components/app/PageHeader";

export default function ProfilePage() {
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Your data"
        title="Profile"
        description="The details ApplyPilot fills applications from. Stored as raw fields; the extension derives the rest."
      />
      <div className="bezel p-10 text-center text-sm text-ink-dim">
        Profile editor — built in M4.
      </div>
    </div>
  );
}
