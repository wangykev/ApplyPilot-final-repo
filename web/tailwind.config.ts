import type { Config } from "tailwindcss";

/**
 * ApplyPilot Web — night flight-deck design tokens.
 * The status palette (amber/verified/signal) is semantic, reused as the app's
 * status-light vocabulary. Boldness is spent in one place: amber.
 */
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        cockpit: "#0A0E14",
        panel: "#121821",
        "panel-raised": "#1A2230",
        hairline: "#26303D",
        ink: "#E6EDF5",
        "ink-dim": "#7E8C9E",
        "ink-faint": "#566273",
        amber: {
          DEFAULT: "#FFB627",
          soft: "#FFC85C",
          dim: "#8a6a22",
        },
        verified: {
          DEFAULT: "#36D6A0",
          dim: "#1f6b54",
        },
        signal: {
          DEFAULT: "#FF5C5C",
          dim: "#7a3636",
        },
        // A FOURTH accent, added only when a fourth discovery source arrived
        // (@zero2sudo, 2026-08-19). The other three were already spoken for —
        // verified=Simplify, amber=LinkedIn, ink-dim=Handshake — and reusing one
        // would make two sources read as the same thing in the queue's badges.
        // Deliberately the only addition: this palette stays small.
        iris: {
          DEFAULT: "#B07CFF",
          dim: "#5b3f85",
        },
      },
      fontFamily: {
        display: ["var(--font-display)", "ui-sans-serif", "system-ui", "sans-serif"],
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      letterSpacing: {
        label: "0.18em",
      },
      boxShadow: {
        bezel:
          "inset 0 1px 0 0 rgba(255,255,255,0.04), 0 1px 2px 0 rgba(0,0,0,0.4)",
        glow: "0 0 0 1px rgba(255,182,39,0.25), 0 8px 40px -12px rgba(255,182,39,0.35)",
      },
      backgroundImage: {
        "grid-faint":
          "linear-gradient(to right, rgba(38,48,61,0.35) 1px, transparent 1px), linear-gradient(to bottom, rgba(38,48,61,0.35) 1px, transparent 1px)",
      },
      keyframes: {
        sweep: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(100%)" },
        },
        "blink-amber": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
        "rise-in": {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        sweep: "sweep 1.4s ease-in-out infinite",
        "blink-amber": "blink-amber 1.6s ease-in-out infinite",
        "rise-in": "rise-in 0.5s ease-out both",
      },
    },
  },
  plugins: [],
};

export default config;
