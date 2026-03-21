"use client";

import { SignIn } from "@clerk/nextjs";

type SignInExperienceProps = {
  redirectTarget: string;
};

const SIGN_IN_APPEARANCE = {
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
  layout: {
    socialButtonsVariant: "blockButton",
    socialButtonsPlacement: "top",
  },
  elements: {
    rootBox: "w-full",
    cardBox: "w-full",
    card: "w-full border-0 bg-transparent p-0 shadow-none",
    main: "gap-5",
    header: "hidden",
    headerTitle: "hidden",
    headerSubtitle: "hidden",
    formFieldInput:
      "min-h-12 rounded-[var(--radius-md)] border border-[var(--border-soft)] bg-[var(--bg-shell)] px-4 text-[var(--text-strong)] shadow-none placeholder:text-[var(--text-faint)]",
    formButtonPrimary:
      "min-h-11 rounded-[var(--radius-md)] border border-[var(--border-soft)] bg-[var(--bg-muted)] text-[var(--text-strong)] shadow-none transition hover:bg-[var(--bg-panel-2)]",
    socialButtonsBlockButton:
      "min-h-12 rounded-[var(--radius-md)] border border-[var(--border-soft)] bg-white text-[#111111] shadow-none transition hover:bg-[#f4f4f5]",
    socialButtonsBlockButtonText: "font-semibold text-[#111111]",
    dividerText: "text-[11px] uppercase tracking-[0.24em] text-[var(--text-muted)]",
    dividerLine: "bg-[var(--border-soft)]",
    footerActionText: "text-[13px] text-[var(--text-muted)]",
    footerActionLink: "font-semibold text-[var(--text-strong)] transition hover:text-[var(--accent-hover)]",
    identityPreviewText: "text-[var(--text-strong)]",
    identityPreviewEditButton: "text-[var(--text-muted)] transition hover:text-[var(--text-strong)]",
    formFieldSuccessText: "text-emerald-400",
    formFieldErrorText: "text-rose-400",
    alertText: "text-rose-300",
  },
} as const;

export function SignInExperience({ redirectTarget }: SignInExperienceProps) {
  return (
    <div className="conductor-auth-form">
      <SignIn
        routing="path"
        path="/sign-in"
        appearance={SIGN_IN_APPEARANCE}
        oauthFlow="redirect"
        forceRedirectUrl={redirectTarget}
        fallbackRedirectUrl={redirectTarget}
        signUpForceRedirectUrl={redirectTarget}
        signUpFallbackRedirectUrl={redirectTarget}
      />
    </div>
  );
}
