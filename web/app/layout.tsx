import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

/**
 * Geist has no entry in next/font/google at this Next version, so the woff2 subsets are
 * self-hosted. Google splits the family across subsets and the page needs two of them:
 * latin covers almost everything, latin-ext carries glyphs like the "ƒ" in the Sheets
 * card. Each subset is its own face, so both are chained in the CSS font stack — with
 * latin alone the browser silently falls back for "ƒ" and the row it sits in grows 1px.
 */
const geist = localFont({
  src: "./fonts/Geist-latin.woff2",
  variable: "--font-geist",
  weight: "100 900",
  display: "swap",
});

const geistExt = localFont({
  src: "./fonts/Geist-latin-ext.woff2",
  variable: "--font-geist-ext",
  weight: "100 900",
  display: "swap",
});

const geistMono = localFont({
  src: "./fonts/GeistMono-latin.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
});

const geistMonoExt = localFont({
  src: "./fonts/GeistMono-latin-ext.woff2",
  variable: "--font-geist-mono-ext",
  weight: "100 900",
  display: "swap",
});

export const metadata: Metadata = {
  title: "AlgoTerminal",
  description:
    "Standardized financial KPIs for Algorand DeFi, priced per query in USDC over x402. Built for autonomous agents.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const fonts = [geist, geistExt, geistMono, geistMonoExt].map((f) => f.variable).join(" ");
  return (
    <html lang="en" className={`dark ${fonts}`}>
      <body>{children}</body>
    </html>
  );
}
