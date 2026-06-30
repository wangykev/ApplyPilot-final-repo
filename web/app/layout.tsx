import type { Metadata } from "next";
import {
  Space_Grotesk,
  IBM_Plex_Sans,
  IBM_Plex_Mono,
  Archivo,
  JetBrains_Mono,
} from "next/font/google";
import "./globals.css";

// Extra families used only by the alternate design directions under /designs.
const archivo = Archivo({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-archivo",
  display: "swap",
});
const jbMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-jb-mono",
  display: "swap",
});

const display = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

const sans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-sans",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ApplyPilot — application autopilot for Workday",
  description:
    "Upload your resume once. ApplyPilot fills Workday applications from your profile, flags every guess for your review, and never submits without you.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${sans.variable} ${mono.variable} ${archivo.variable} ${jbMono.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
