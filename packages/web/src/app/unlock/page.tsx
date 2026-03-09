import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isLoopbackHost } from "@/lib/accessControl";
import { sanitizeRedirectTarget } from "@/lib/remoteAuth";

function getErrorMessage(code: string | null | undefined): string | null {
  if (code === "invalid") return "That access link or token is invalid.";
  if (code === "unavailable") return "Public share-link remote access is no longer available for this session.";
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
  const forwardedHost = headerStore.get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim()
    .split(":")[0]
    ?.toLowerCase() ?? "";
  const requestHost = forwardedHost || (headerStore.get("host")?.split(":")[0]?.trim().toLowerCase() ?? "");

  if (isLoopbackHost(requestHost)) {
    redirect(nextPath);
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <section className="surface-card w-full max-w-md rounded-[var(--radius-lg)] border p-6 shadow-[var(--shadow-card)]">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--text-muted)]">
            Secure Remote Access
          </p>
          <h1 className="text-2xl font-semibold text-[var(--text-strong)]">Unlock Conductor</h1>
          <p className="text-sm leading-6 text-[var(--text-muted)]">
            Public share-link remote access has been removed. Use the private Tailscale link from Settings, or open the protected enterprise URL from Cloudflare Access or Clerk instead.
          </p>
        </div>

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
      </section>
    </main>
  );
}
