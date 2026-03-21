"use client";

import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";
import { LoaderCircle } from "lucide-react";
import { PublicPageShell, PublicPanel, PublicSection } from "@/components/public/PublicPageShell";

export default function SsoCallbackPage() {
  return (
    <PublicPageShell className="flex items-center">
      <div className="mx-auto w-full max-w-xl">
        <PublicPanel className="p-6 sm:p-8">
          <PublicSection
            eyebrow="Signing in"
            title="Finishing your secure redirect"
            description="Conductor is restoring your session and will send you back automatically."
          />

          <div className="mt-6 flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--border-soft)] bg-[var(--bg-shell)] p-4 text-sm text-[var(--text-normal)]">
            <LoaderCircle className="h-4 w-4 animate-spin text-[var(--status-ready)]" />
            <span>Completing the Clerk callback...</span>
          </div>
        </PublicPanel>
      </div>

      <AuthenticateWithRedirectCallback signInFallbackRedirectUrl="/sign-in" />
    </PublicPageShell>
  );
}
