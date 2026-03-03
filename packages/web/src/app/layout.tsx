import type { Metadata, Viewport } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { ThemeProvider } from "@/components/ThemeProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Conductor",
  description: "Multi-agent orchestrator dashboard",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem("conductor-theme");if(t==="light"||t==="dark")document.documentElement.className=t}catch{}`,
          }}
        />
      </head>
      <body className="bg-[var(--color-bg-base)] text-[var(--color-text-primary)] antialiased">
        <ThemeProvider>{children}</ThemeProvider>
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
