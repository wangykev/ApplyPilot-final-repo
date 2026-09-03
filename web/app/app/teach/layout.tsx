import { TeachTabs } from "./TeachTabs";

/**
 * Wraps every page in the Teach section so the tab strip renders once rather than per page, and the
 * active tab is derived from the path. Same shape as the AI section's layout.
 */
export default function TeachLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <TeachTabs />
      {children}
    </div>
  );
}
