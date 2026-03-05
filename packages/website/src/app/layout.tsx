import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Conductor OSS — Orchestrate AI Coding Agents",
  description:
    "Write tasks in markdown. Conductor spawns agents, manages worktrees, tracks PRs, and updates your board — all locally. Works with Claude Code, Codex, Gemini, and 7 more agents.",
  keywords: [
    "AI agents",
    "coding automation",
    "claude code",
    "orchestration",
    "developer tools",
    "git worktrees",
    "open source",
  ],
  authors: [{ name: "Conductor OSS Contributors" }],
  openGraph: {
    title: "Conductor OSS — Orchestrate AI Coding Agents",
    description:
      "Write tasks in markdown. Conductor spawns agents, manages worktrees, tracks PRs — all locally.",
    type: "website",
    url: "https://conductor-oss.dev",
  },
  twitter: {
    card: "summary_large_image",
    title: "Conductor OSS — Orchestrate AI Coding Agents",
    description:
      "Write tasks in markdown. Conductor spawns agents, manages worktrees, tracks PRs — all locally.",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} dark`}
    >
      <body
        className="font-[var(--font-inter)] bg-[#09090b] text-zinc-100 antialiased"
        style={{ fontFamily: "var(--font-inter), Inter, sans-serif" }}
      >
        {children}
      </body>
    </html>
  );
}
