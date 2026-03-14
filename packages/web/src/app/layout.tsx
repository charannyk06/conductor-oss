import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Tomorrow } from "next/font/google";
import { GeistSans } from "geist/font/sans";
import { ClerkProvider } from "@clerk/nextjs";
import { ThemeProvider } from "@/components/ThemeProvider";
import { TooltipProvider } from "@/components/ui/Tooltip";
import "./globals.css";

const tomorrow = Tomorrow({
  subsets: ["latin"],
  variable: "--font-tomorrow",
  display: "swap",
  weight: ["700"],
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
  weight: ["400", "500"],
});

const rootClass = `${GeistSans.variable} ${tomorrow.variable} ${jetbrainsMono.variable}`;

export const metadata: Metadata = {
  title: "Conductor",
  description: "Multi-agent orchestrator dashboard",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${rootClass} dark`} suppressHydrationWarning>
      <head>
        {/* Anti-FOUT theme script: reads localStorage and applies theme class
            before React hydrates. Content is static with no dynamic input. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem("conductor-theme");var e=document.documentElement;e.classList.remove("light","dark");e.classList.add(t==="light"||t==="dark"?t:"dark")}catch{}`,
          }}
        />
      </head>
      <body className="bg-[var(--bg-canvas)] text-[var(--text-strong)] antialiased">
        <TooltipProvider>
          <ThemeProvider>{children}</ThemeProvider>
        </TooltipProvider>
      </body>
    </html>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

  if (!publishableKey) {
    return <Shell>{children}</Shell>;
  }

  return (
    <ClerkProvider publishableKey={publishableKey}>
      <Shell>{children}</Shell>
    </ClerkProvider>
  );
}
