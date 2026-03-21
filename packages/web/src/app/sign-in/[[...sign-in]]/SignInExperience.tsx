"use client";

import { useAuth, useSignIn } from "@clerk/nextjs";
import { ArrowRight, Github, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";

type SignInExperienceProps = {
  redirectTarget: string;
};

function describeDestination(redirectTarget: string): string {
  if (redirectTarget.startsWith("/bridge/connect")) {
    return "your bridge pairing flow";
  }

  if (redirectTarget === "/" || redirectTarget.length === 0) {
    return "the dashboard";
  }

  return "your requested destination";
}

function resolveErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "Unable to start the GitHub sign-in redirect. Please retry.";
}

export function SignInExperience({ redirectTarget }: SignInExperienceProps) {
  const router = useRouter();
  const { isLoaded, signIn } = useSignIn();
  const { isSignedIn } = useAuth();
  const [isRedirecting, setIsRedirecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const destinationLabel = describeDestination(redirectTarget);

  useEffect(() => {
    if (!isSignedIn) {
      return;
    }

    router.replace(redirectTarget);
  }, [isSignedIn, redirectTarget, router]);

  async function handleGitHubSignIn(): Promise<void> {
    if (!isLoaded || !signIn || isRedirecting) {
      return;
    }

    setIsRedirecting(true);
    setError(null);

    try {
      await signIn.authenticateWithRedirect({
        strategy: "oauth_github",
        redirectUrl: "/sign-in/sso-callback",
        redirectUrlComplete: redirectTarget,
        continueSignIn: true,
        continueSignUp: true,
      });
    } catch (nextError) {
      setIsRedirecting(false);
      setError(resolveErrorMessage(nextError));
    }
  }

  if (isSignedIn) {
    return (
      <div className="space-y-3 rounded-[var(--radius-md)] border border-[var(--border-soft)] bg-[var(--bg-shell)] p-4">
        <div className="flex items-center gap-3 text-sm text-[var(--text-normal)]">
          <LoaderCircle className="h-4 w-4 animate-spin text-[var(--status-ready)]" />
          <span>Redirecting you to {destinationLabel}.</span>
        </div>
      </div>
    );
  }

  const showBusyState = !isLoaded || isRedirecting;

  return (
    <div className="space-y-4">
      <Button
        type="button"
        variant="primary"
        size="lg"
        className="w-full justify-between px-4"
        disabled={showBusyState}
        onClick={() => {
          void handleGitHubSignIn();
        }}
      >
        <span className="flex items-center gap-3">
          <Github className="h-4 w-4" />
          <span>{isRedirecting ? "Redirecting to GitHub..." : "Continue with GitHub"}</span>
        </span>
        {showBusyState ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
      </Button>

      <div className="rounded-[var(--radius-md)] border border-[var(--border-soft)] bg-[var(--bg-shell)] p-4 text-sm">
        <p className="font-medium text-[var(--text-strong)]">Redirect-based sign-in</p>
        <p className="mt-2 leading-6 text-[var(--text-muted)]">
          Clerk will send you to GitHub for authentication, then return you directly to {destinationLabel}.
        </p>
        {!isLoaded ? (
          <p className="mt-2 text-xs uppercase tracking-[0.16em] text-[var(--text-faint)]">
            Preparing secure redirect...
          </p>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-[var(--radius-md)] border border-[var(--status-error)]/30 bg-[color:color-mix(in_srgb,var(--status-error)_12%,transparent)] p-4 text-sm text-[var(--text-normal)]">
          {error}
        </div>
      ) : null}
    </div>
  );
}
