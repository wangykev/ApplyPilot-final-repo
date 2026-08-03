import { AiTabs } from "./AiTabs";

/**
 * Wraps every page in the AI section so the tab strip is rendered once rather than repeated
 * per page, and the active tab is derived from the path.
 */
export default function AiLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <AiTabs />
      {children}
    </div>
  );
}
