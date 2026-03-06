import { sanitizeRedirectTarget } from "@/lib/remoteAuth";
import { UnlockForm } from "./UnlockForm";

function getErrorMessage(code: string | null | undefined): string | null {
  if (code === "invalid") return "That access link or token is invalid.";
  if (code === "unavailable") return "Remote sign-in is not available for this session.";
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

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <section className="surface-card w-full max-w-md rounded-[var(--radius-lg)] border p-6 shadow-[var(--shadow-card)]">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--text-muted)]">
            Secure Remote Access
          </p>
          <h1 className="text-2xl font-semibold text-[var(--text-strong)]">Unlock Conductor</h1>
          <p className="text-sm leading-6 text-[var(--text-muted)]">
            Use the secure unlock link from the terminal that started this session, or paste the access token below.
          </p>
        </div>

        <UnlockForm
          initialError={getErrorMessage(errorValue)}
          nextPath={sanitizeRedirectTarget(nextValue)}
        />
      </section>
    </main>
  );
}
