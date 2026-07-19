"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  FileText,
  FileSignature,
  IdCard,
  Briefcase,
  Gauge,
  Sparkles,
  Cable,
  ListChecks,
  Activity,
  GraduationCap,
  BarChart3,
  LogOut,
} from "lucide-react";
import { LogoMark } from "@/components/Logo";
import { clsx } from "@/lib/clsx";

const PRIMARY = [
  { href: "/app", label: "Overview", icon: LayoutDashboard, exact: true },
  { href: "/app/resume", label: "Resume", icon: FileText },
  { href: "/app/cover-letter", label: "Cover letter", icon: FileSignature },
  { href: "/app/match", label: "Match score", icon: Gauge },
  { href: "/app/profile", label: "Profile", icon: IdCard },
  { href: "/app/job", label: "Job context", icon: Briefcase },
  { href: "/app/ai", label: "AI", icon: Sparkles },
  { href: "/app/connect", label: "Connect", icon: Cable },
  { href: "/app/queue", label: "Queue", icon: ListChecks },
  { href: "/app/tracker", label: "Tracker", icon: Activity },
  { href: "/app/teach", label: "Teach", icon: GraduationCap },
  { href: "/app/analytics", label: "Analytics", icon: BarChart3 },
];

const SOON: { label: string; icon: typeof BarChart3 }[] = [];

export function Sidebar({ email }: { email: string }) {
  const pathname = usePathname();
  return (
    <aside className="sticky top-0 flex h-screen w-16 shrink-0 flex-col border-r border-hairline bg-panel md:w-60">
      <div className="flex h-16 items-center gap-2.5 border-b border-hairline px-3 md:px-5">
        <LogoMark className="h-7 w-7 shrink-0" />
        <span className="hidden font-display text-base font-medium tracking-tight md:inline">
          Apply<span className="text-amber">Pilot</span>
        </span>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto p-2 md:p-3">
        {PRIMARY.map((item) => {
          const active = item.exact
            ? pathname === item.href
            : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={clsx(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
                active
                  ? "bg-panel-raised text-ink"
                  : "text-ink-dim hover:bg-panel-raised/60 hover:text-ink"
              )}
              title={item.label}
            >
              <item.icon
                className={clsx("h-[18px] w-[18px] shrink-0", active && "text-amber")}
                strokeWidth={1.75}
              />
              <span className="hidden md:inline">{item.label}</span>
              {active && (
                <span className="ml-auto hidden h-1.5 w-1.5 rounded-full bg-amber md:block" />
              )}
            </Link>
          );
        })}

        {SOON.length > 0 && (
          <div className="hidden px-3 pb-1 pt-5 md:block">
            <span className="font-mono text-[10px] uppercase tracking-label text-ink-faint">
              Coming soon
            </span>
          </div>
        )}
        {SOON.map((item) => (
          <div
            key={item.label}
            className="flex cursor-not-allowed items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-ink-faint"
            title={`${item.label} — coming soon`}
          >
            <item.icon className="h-[18px] w-[18px] shrink-0" strokeWidth={1.75} />
            <span className="hidden md:inline">{item.label}</span>
            <span className="ml-auto hidden font-mono text-[9px] uppercase tracking-label md:inline">
              soon
            </span>
          </div>
        ))}
      </nav>

      <div className="border-t border-hairline p-2 md:p-3">
        <div className="hidden truncate px-3 pb-2 font-mono text-[11px] text-ink-dim md:block">
          {email}
        </div>
        <form action="/auth/signout" method="post">
          <button
            type="submit"
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-ink-dim transition-colors hover:bg-panel-raised/60 hover:text-ink"
            title="Sign out"
          >
            <LogOut className="h-[18px] w-[18px] shrink-0" strokeWidth={1.75} />
            <span className="hidden md:inline">Sign out</span>
          </button>
        </form>
      </div>
    </aside>
  );
}
