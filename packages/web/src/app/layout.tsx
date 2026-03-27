import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Orbitron, Tomorrow } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { Analytics } from "@vercel/analytics/next";
import { headers } from "next/headers";
import { ThemeProvider } from "@/components/ThemeProvider";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { resolveRustBackendUrl } from "@/lib/backendUrl";
import { resolveClerkConfiguration, resolveRequestBaseUrl, resolveRequestHostname } from "@/lib/clerkConfig";
import "./globals.css";

const tomorrow = Tomorrow({
  subsets: ["latin"],
  variable: "--font-tomorrow",
  display: "swap",
  weight: ["700"],
});

const orbitron = Orbitron({
  subsets: ["latin"],
  variable: "--font-brand-display",
  display: "swap",
  weight: ["500", "700"],
});

const ibmPlexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  variable: "--font-ibm-plex-sans",
  display: "swap",
  weight: ["400", "500", "600"],
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-ibm-plex-mono",
  display: "swap",
  weight: ["400", "500"],
});

const rootClass = `${ibmPlexSans.variable} ${tomorrow.variable} ${orbitron.variable} ${ibmPlexMono.variable}`;
const isVercelDeployment = process.env.VERCEL === "1" || process.env.VERCEL === "true";

export const metadata: Metadata = {
  title: "Conductor",
  description: "Multi-agent orchestrator dashboard",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

function Shell({ children }: { children: React.ReactNode }) {
  const backendUrl = resolveRustBackendUrl() ?? "";

  return (
    <html lang="en" className={`${rootClass} dark`} suppressHydrationWarning>
      <head>
        <meta name="conductor-backend-url" content={backendUrl} />
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
          <ThemeProvider>
            {children}
            {isVercelDeployment ? <Analytics /> : null}
          </ThemeProvider>
        </TooltipProvider>
      </body>
    </html>
  );
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const headerStore = await headers();
  const hostname = resolveRequestHostname(headerStore);
  const baseUrl = resolveRequestBaseUrl(headerStore);
  const clerkConfiguration = resolveClerkConfiguration(hostname, baseUrl);

  if (!clerkConfiguration.enabled || !clerkConfiguration.publishableKey) {
    return <Shell>{children}</Shell>;
  }

  return (
    <ClerkProvider
      publishableKey={clerkConfiguration.publishableKey}
      proxyUrl={clerkConfiguration.proxyUrl ?? undefined}
      clerkJSUrl={clerkConfiguration.clerkJSUrl ?? undefined}
      signInUrl={clerkConfiguration.signInUrl ?? undefined}
      signUpUrl={clerkConfiguration.signUpUrl ?? undefined}
      allowedRedirectOrigins={clerkConfiguration.allowedRedirectOrigins.length > 0
        ? clerkConfiguration.allowedRedirectOrigins
        : undefined}
      appearance={{ cssLayerName: "clerk" }}
    >
      <Shell>{children}</Shell>
    </ClerkProvider>
  );
}
