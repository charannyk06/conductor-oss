"use client";

import { SignIn, useSignIn } from "@clerk/nextjs";
import { ArrowRight, Github, Loader2 } from "lucide-react";
import { useState, useTransition } from "react";

const EMAIL_SIGN_IN_APPEARANCE = {
  variables: {
    colorPrimary: "#d4d4d8",
    colorBackground: "transparent",
    colorInputBackground: "#18181b",
    colorInputText: "#fafafa",
    colorText: "#fafafa",
    colorTextSecondary: "#a1a1aa",
    colorNeutral: "#3f3f46",
    colorDanger: "#d25151",
    fontFamily: "var(--font-sans), system-ui, sans-serif",
    borderRadius: "0.375rem",
  },
  elements: {
    rootBox: "w-full",
    cardBox: "w-full",
    card: "w-full border-0 bg-transparent p-0 shadow-none",
    main: "gap-5",
    header: "hidden",
    headerTitle: "hidden",
    headerSubtitle: "hidden",
    dividerRow: "hidden",
    formFieldLabel: "mb-2 text-[11px] font-medium uppercase tracking-[0.22em] text-[var(--text-muted)]",
    formFieldInput:
      "min-h-12 rounded-[var(--radius-md)] border border-[var(--border-soft)] bg-[var(--bg-shell)] text-[var(--text-strong)] shadow-none placeholder:text-[var(--text-faint)]",
    formButtonPrimary:
      "min-h-11 rounded-[var(--radius-md)] border border-[var(--border-soft)] bg-[var(--bg-muted)] text-[var(--text-strong)] shadow-none transition hover:bg-[var(--bg-panel-2)]",
    footerActionText: "text-[13px] text-[var(--text-muted)]",
    footerActionLink: "font-semibold text-[var(--text-strong)] transition hover:text-[var(--accent-hover)]",
    identityPreviewText: "text-[var(--text-strong)]",
    identityPreviewEditButton: "text-[var(--text-muted)] transition hover:text-[var(--text-strong)]",
    formFieldSuccessText: "text-emerald-400",
    formFieldErrorText: "text-rose-400",
    alertText: "text-rose-300",
  },
} as const;

function formatOauthError(error: unknown): string {
  if (error && typeof error === "object" && "errors" in error) {
    const issue = (error as { errors?: Array<{ longMessage?: string; message?: string }> }).errors?.[0];
    if (issue?.longMessage) return issue.longMessage;
    if (issue?.message) return issue.message;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "GitHub sign-in could not start. Refresh and try again.";
}

export function SignInExperience() {
  const { isLoaded, signIn } = useSignIn();
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleGitHubSignIn = () => {
    if (!isLoaded || !signIn) {
      return;
    }

    setOauthError(null);

    startTransition(() => {
      void (async () => {
        try {
          await signIn.authenticateWithRedirect({
            strategy: "oauth_github",
            redirectUrl: "/sign-in/sso-callback",
            redirectUrlComplete: "/",
          });
        } catch (error) {
          setOauthError(formatOauthError(error));
        }
      })();
    });
  };

  return (
    <div className="space-y-5">
      <button
        type="button"
        onClick={handleGitHubSignIn}
        disabled={!isLoaded || isPending}
        className="group flex min-h-12 w-full items-center justify-between rounded-[var(--radius-md)] border border-[var(--border-soft)] bg-[var(--bg-shell)] px-4 text-left text-[var(--text-strong)] transition-colors hover:bg-[var(--bg-panel-2)] disabled:cursor-not-allowed disabled:opacity-70"
      >
        <span className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--border-soft)] bg-[var(--bg-panel)] text-[var(--text-strong)]">
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Github className="h-4 w-4" />}
          </span>
          <span>
            <span className="block text-[15px] font-semibold tracking-[-0.01em]">
              {isPending ? "Redirecting to GitHub" : "Continue with GitHub"}
            </span>
            <span className="mt-0.5 block text-sm text-[var(--text-muted)]">
              Fastest path for the paired-device workflow
            </span>
          </span>
        </span>
        <ArrowRight className="h-4 w-4 text-[var(--text-muted)] transition group-hover:text-[var(--text-strong)]" />
      </button>

      {oauthError ? (
        <div className="rounded-[var(--radius-md)] border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm leading-6 text-rose-200">
          {oauthError}
        </div>
      ) : null}

      <div className="flex items-center gap-4">
        <span className="h-px flex-1 bg-[var(--border-soft)]" />
        <span className="text-[11px] uppercase tracking-[0.24em] text-[var(--text-muted)]">Or continue with email</span>
        <span className="h-px flex-1 bg-[var(--border-soft)]" />
      </div>

      <div className="conductor-auth-form">
        <SignIn routing="path" path="/sign-in" appearance={EMAIL_SIGN_IN_APPEARANCE} />
      </div>
    </div>
  );
}
