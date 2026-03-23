import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { PublicPageShell, PublicPanel, PublicSection } from "@/components/public/PublicPageShell";
import { isLoopbackHost } from "@/lib/accessControl";
import { resolveRequestHostname } from "@/lib/clerkConfig";
import { sanitizeRedirectTarget } from "@/lib/redirectTarget";

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
  const headerStore = await headers();
  const requestHost = resolveRequestHostname(headerStore);

  if (isLoopbackHost(requestHost)) {
    redirect(nextPath);
  }

  return (
    <PublicPageShell className="flex items-center">
      <div className="mx-auto w-full max-w-2xl">
        <PublicPanel className="p-6 sm:p-8">
          <PublicSection
            eyebrow="Dashboard Access"
            title="Authentication Required"
            description="Open Conductor from a local session, or use a protected dashboard URL backed by a verified identity provider such as Cloudflare Access or Clerk."
          />

          {errorMessage ? (
            <p className="mt-6 rounded-[var(--radius-md)] border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {errorMessage}
            </p>
          ) : null}

          {nextPath !== "/" ? (
            <p className="mt-6 text-sm leading-6 text-[var(--text-muted)]">
              Requested path: <code>{nextPath}</code>
            </p>
          ) : null}
        </PublicPanel>
      </div>
    </PublicPageShell>
  );
}
