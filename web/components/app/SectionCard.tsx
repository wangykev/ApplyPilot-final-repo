export function SectionCard({
  title,
  subtitle,
  children,
  actions,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section className="bezel p-6">
      <div className="flex items-start justify-between gap-4 border-b border-hairline pb-4">
        <div>
          <h2 className="font-display text-lg font-medium">{title}</h2>
          {subtitle && <p className="mt-1 text-xs leading-relaxed text-ink-dim">{subtitle}</p>}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
      <div className="pt-5">{children}</div>
    </section>
  );
}
