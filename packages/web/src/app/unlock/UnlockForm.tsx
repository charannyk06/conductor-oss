"use client";

import { type FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

type UnlockFormProps = {
  initialError: string | null;
  nextPath: string;
};

export function UnlockForm({ initialError, nextPath }: UnlockFormProps) {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token }),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        setError(payload?.error ?? "Unable to unlock this Conductor session.");
        return;
      }

      router.replace(nextPath);
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="mt-6 space-y-4" onSubmit={(event) => void handleSubmit(event)}>
      <label className="block space-y-2">
        <span className="text-sm font-medium text-[var(--text-strong)]">Access token</span>
        <input
          autoCapitalize="none"
          autoComplete="one-time-code"
          autoCorrect="off"
          className="w-full rounded-[var(--radius-md)] border bg-[var(--bg-elevated)] px-3 py-2 text-sm text-[var(--text-strong)] outline-none transition focus:border-[var(--accent-primary)]"
          inputMode="text"
          onChange={(event) => setToken(event.target.value)}
          placeholder="Paste the Conductor access token"
          spellCheck={false}
          type="password"
          value={token}
        />
      </label>

      {error ? (
        <p className="rounded-[var(--radius-md)] border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {error}
        </p>
      ) : null}

      <button
        className="inline-flex w-full items-center justify-center rounded-[var(--radius-md)] bg-[var(--accent-primary)] px-4 py-2 text-sm font-medium text-[var(--accent-contrast)] transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-60"
        disabled={submitting || token.trim().length === 0}
        type="submit"
      >
        {submitting ? "Unlocking..." : "Unlock"}
      </button>
    </form>
  );
}
