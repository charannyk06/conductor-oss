import { LifeBuoy } from "lucide-react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { PublicPageShell, PublicPanel, PublicSection } from "@/components/public/PublicPageShell";
import { allowsLocalUnauthenticatedAccess, isLoopbackHost } from "@/lib/accessControl";
import { resolveRequestHostname } from "@/lib/clerkConfig";
import { sanitizeRedirectTarget } from "@/lib/redirectTarget";
import {
  CONDUCTOR_APP_URL,
  CONDUCTOR_SUPPORT_DISCUSSIONS_URL,
  getRemoteAccessSupportMessage,
} from "@/lib/supportLinks";

function getErrorMessage(code: string | null | undefined): string | null {
  if (code === "invalid") return "That access request is invalid.";
  if (code === "unavailable") return "This access path is not available for this session.";
  return null;
}

type UnlockPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function UnlockPage({ searchParams }: UnlockPageProps) {
  const resolved = searchParams ? await searchParams : {};
  const rawNext = resolved.next;
  const nextValue = Array.isArray(rawNext) ? rawNext[0] : rawNext;
  const rawError = resolved.error;
  const errorValue = Array.isArray(rawError) ? rawError[0] : rawError;
  const nextPath = sanitizeRedirectTarget(nextValue);
  const errorMessage = getErrorMessage(errorValue);
  const remoteAccessHelp = getRemoteAccessSupportMessage(errorValue);
  const headerStore = await headers();
  const requestHost = resolveRequestHostname(headerStore);

  if (isLoopbackHost(requestHost) && allowsLocalUnauthenticatedAccess()) {
    redirect(nextPath);
  }

  return (
    <PublicPageShell className="flex items-center">
      <div className="mx-auto w-full max-w-2xl">
        <PublicPanel className="p-6 sm:p-8">
          <PublicSection
            eyebrow="Dashboard Access"
            title="Authentication Required"
            description="Open Conductor from a local session, use the hosted paired-device flow at app.conductross.com, or put your self-hosted dashboard behind Cloudflare Access or Clerk."
          />

          {errorMessage ? (
            <p className="mt-6 rounded-[var(--radius-md)] border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {errorMessage}
            </p>
          ) : null}

          {remoteAccessHelp ? (
            <p className="mt-4 rounded-[var(--radius-md)] border border-[var(--border-soft)] bg-[var(--bg-shell)] px-3 py-2 text-sm leading-6 text-[var(--text-muted)]">
              {remoteAccessHelp}
            </p>
          ) : null}

          {nextPath !== "/" ? (
            <p className="mt-6 text-sm leading-6 text-[var(--text-muted)]">
              Requested path: <code>{nextPath}</code>
            </p>
          ) : null}
          <div className="mt-6 flex flex-wrap gap-3">
            <a
              href={CONDUCTOR_APP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--accent-primary)] px-4 py-2 text-sm font-medium text-white transition hover:opacity-90"
            >
              Open hosted app
            </a>
            <a
              href={CONDUCTOR_SUPPORT_DISCUSSIONS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--border-soft)] px-4 py-2 text-sm font-medium text-[var(--text-muted)] transition hover:border-[var(--border-default)] hover:text-[var(--text-normal)]"
            >
              <LifeBuoy className="h-4 w-4" />
              Open support
            </a>
          </div>
        </PublicPanel>
      </div>
    </PublicPageShell>
  );
}
