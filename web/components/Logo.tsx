/**
 * ApplyPilot mark — a heading-indicator dial: an amber autopilot needle on a
 * dark bezel. Reads as a cockpit instrument, not a generic rocket/bolt.
 */
export function LogoMark({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      role="img"
      aria-label="ApplyPilot"
      fill="none"
    >
      <circle cx="16" cy="16" r="14" stroke="#26303D" strokeWidth="2" />
      <circle cx="16" cy="16" r="9.5" stroke="#26303D" strokeWidth="1" opacity="0.7" />
      {/* tick marks */}
      {[0, 90, 180, 270].map((deg) => (
        <line
          key={deg}
          x1="16"
          y1="3.5"
          x2="16"
          y2="6.5"
          stroke="#566273"
          strokeWidth="1.5"
          transform={`rotate(${deg} 16 16)`}
        />
      ))}
      {/* the heading needle */}
      <path d="M16 5 L19.2 17 L16 14.5 L12.8 17 Z" fill="#FFB627" />
      <circle cx="16" cy="16" r="2" fill="#FFB627" />
    </svg>
  );
}

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <LogoMark className="h-7 w-7" />
      <span className="font-display text-lg font-medium tracking-tight text-ink">
        Apply<span className="text-amber">Pilot</span>
      </span>
    </span>
  );
}
