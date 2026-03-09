import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="surface-card w-full max-w-md overflow-hidden rounded-[var(--radius-lg)] border p-3 shadow-[var(--shadow-card)]">
        {publishableKey ? (
          <SignIn routing="path" path="/sign-in" />
        ) : (
          <div className="space-y-3 p-3 sm:p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--text-muted)]">
              Sign In Unavailable
            </p>
            <h1 className="text-2xl font-semibold text-[var(--text-strong)]">Authentication is not configured.</h1>
            <p className="text-sm leading-6 text-[var(--text-muted)]">
              Add{" "}
              <code className="rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[13px] text-[var(--text-strong)] [overflow-wrap:anywhere]">
                NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
              </code>{" "}
              to enable the Clerk sign-in flow for this page.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
