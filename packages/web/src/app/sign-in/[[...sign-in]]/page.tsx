import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Check, HardDrive, ShieldCheck, Workflow } from "lucide-react";
import { SignInExperience } from "./SignInExperience";
import { Button } from "@/components/ui/Button";
import { PublicPageShell, PublicPanel, PublicSection } from "@/components/public/PublicPageShell";
import { getDashboardAccess, resolvePostSignInRedirectTarget } from "@/lib/auth";
import { resolveClerkConfiguration, resolveRequestBaseUrl, resolveRequestHostname } from "@/lib/clerkConfig";

const LOCAL_RUNTIME_POINTS = [
  "Repositories remain on the paired laptop.",
  "Agent credentials remain on the paired laptop.",
  "Terminal output streams from the local ttyd runtime.",
] as const;

const OPERATOR_POINTS = [
  "Sign in to the dashboard.",
  "Pick the paired machine you trust.",
  "Launch and review work without moving the runtime.",
] as const;

type SignInPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function firstQueryValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0]?.trim() || null;
  }
  return value?.trim() || null;
}

function SignInUnavailable({ hostedMisconfiguration = false }: { hostedMisconfiguration?: boolean }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--status-error)]/30 bg-[color:color-mix(in_srgb,var(--status-error)_10%,transparent)] p-5 text-left">
      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--text-muted)]">Sign In Unavailable</p>
      <h2 className="mt-3 text-xl font-semibold text-[var(--text-strong)]">
        {hostedMisconfiguration ? "Hosted authentication is misconfigured." : "Authentication is not configured."}
      </h2>
      {hostedMisconfiguration ? (
        <p className="mt-3 text-sm leading-6 text-[var(--text-muted)]">
          This deployment is using Clerk development keys. Development keys only work on local loopback
          hosts. Add a production Clerk publishable key and secret key for this deployed domain, then
          redeploy.
        </p>
      ) : (
        <p className="mt-3 text-sm leading-6 text-[var(--text-muted)]">
          Add both{" "}
          <code className="rounded bg-[var(--bg-shell)] px-1.5 py-0.5 text-[13px] text-[var(--text-strong)]">
            NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
          </code>{" "}
          and{" "}
          <code className="rounded bg-[var(--bg-shell)] px-1.5 py-0.5 text-[13px] text-[var(--text-strong)]">
            CLERK_SECRET_KEY
          </code>{" "}
          to enable the Clerk sign-in flow for this page.
        </p>
      )}
    </div>
  );
}

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const redirectTarget = resolvePostSignInRedirectTarget(firstQueryValue(resolvedSearchParams.redirect_url));
  const access = await getDashboardAccess();

  if (access.authenticated) {
    redirect(redirectTarget);
  }

  const headerStore = await headers();
  const hostname = resolveRequestHostname(headerStore);
  const baseUrl = resolveRequestBaseUrl(headerStore);
  const clerkConfiguration = resolveClerkConfiguration(hostname, baseUrl);

  return (
    <PublicPageShell>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start">
        <PublicSection
          eyebrow="Local-First Access"
          title="Operate the laptop you trust from anywhere."
          description="Conductor keeps repositories, terminals, and agent credentials on the paired machine while the dashboard handles launch, review, and session control."
          className="max-w-2xl"
        >
          <div className="flex items-center gap-2 text-sm text-[var(--text-normal)]">
            <ShieldCheck className="h-4 w-4 text-[var(--status-ready)]" />
            Production auth with paired-device execution
          </div>
          <div className="flex flex-wrap gap-3 pt-2">
            <Button asChild variant="primary" size="lg">
              <Link href="https://conductross.com">Read the product story</Link>
            </Button>
          </div>
        </PublicSection>

        <PublicPanel className="p-6 sm:p-7">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--text-muted)]">Sign in</p>
          <h2 className="mt-3 text-2xl font-semibold text-[var(--text-strong)]">Connect to your paired runtime</h2>
          <p className="mt-3 text-sm leading-6 text-[var(--text-muted)]">
            GitHub uses a full-page Clerk redirect, then returns you straight to the dashboard or active bridge
            claim flow without relying on an embedded widget.
          </p>

          <div className="mt-6">
            {clerkConfiguration.enabled && clerkConfiguration.publishableKey ? (
              <SignInExperience redirectTarget={redirectTarget} />
            ) : clerkConfiguration.reason === "hosted-development-keys" ? (
              <SignInUnavailable hostedMisconfiguration />
            ) : (
              <SignInUnavailable />
            )}
          </div>
        </PublicPanel>
      </div>

      <div className="mt-10 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <PublicPanel className="p-5">
          <div className="flex items-center gap-2 text-[var(--text-normal)]">
            <HardDrive className="h-4 w-4 text-[var(--status-ready)]" />
            <p className="text-sm font-semibold">What stays local</p>
          </div>
          <ul className="mt-4 space-y-3 text-sm leading-6 text-[var(--text-muted)]">
            {LOCAL_RUNTIME_POINTS.map((item) => (
              <li key={item} className="flex items-start gap-2">
                <Check className="mt-1 h-3.5 w-3.5 shrink-0 text-[var(--status-ready)]" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </PublicPanel>

        <PublicPanel className="p-5">
          <div className="flex items-center gap-2 text-[var(--text-normal)]">
            <Workflow className="h-4 w-4 text-[var(--status-working)]" />
            <p className="text-sm font-semibold">How it works</p>
          </div>
          <ul className="mt-4 space-y-3 text-sm leading-6 text-[var(--text-muted)]">
            {OPERATOR_POINTS.map((item) => (
              <li key={item} className="flex items-start gap-2">
                <Check className="mt-1 h-3.5 w-3.5 shrink-0 text-[var(--status-working)]" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </PublicPanel>

        <PublicPanel className="p-5 md:col-span-2 xl:col-span-1">
          <div className="flex items-center gap-2 text-[var(--text-normal)]">
            <ShieldCheck className="h-4 w-4 text-[var(--status-ready)]" />
            <p className="text-sm font-semibold">What Conductor does not do</p>
          </div>
          <p className="mt-4 text-sm leading-6 text-[var(--text-muted)]">
            No cloud repo clone. No hosted shell. No credential proxy. Conductor orchestrates the machine you
            pair and leaves the runtime where it already lives.
          </p>
        </PublicPanel>
      </div>
    </PublicPageShell>
  );
}
