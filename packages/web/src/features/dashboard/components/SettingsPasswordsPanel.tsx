"use client";

import { Loader2, Trash2, Upload } from "lucide-react";
import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  describeVaultImport,
  parseVaultCredentials,
  parseVaultImportResult,
  parseVaultKeyStorage,
  vaultSourceLabel,
  type VaultCredential,
  type VaultKeyStorage,
  type VaultSource,
} from "@/lib/vault";

const SOURCES: Array<{ id: VaultSource; hint: string }> = [
  { id: "chrome", hint: "Google Password Manager → Settings → Export passwords (.csv)" },
  { id: "bitwarden", hint: "Tools → Export vault → File format .json or .csv (not encrypted)" },
  { id: "1password", hint: "File → Export → choose the account → CSV" },
];

/** Largest export file the panel will read, matching the backend body limit. */
const MAX_EXPORT_BYTES = 1_500_000;

async function readError(response: Response, fallback: string): Promise<string> {
  const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof payload?.error === "string" && payload.error.trim() ? payload.error : fallback;
}

export function SettingsPasswordsPanel() {
  const [credentials, setCredentials] = useState<VaultCredential[]>([]);
  const [keyStorage, setKeyStorage] = useState<VaultKeyStorage | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [source, setSource] = useState<VaultSource>("chrome");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/vault/credentials", { cache: "no-store" });
      if (!response.ok) {
        setError(await readError(response, "Could not load saved passwords."));
        return;
      }
      const payload: unknown = await response.json();
      setCredentials(parseVaultCredentials(payload));
      setKeyStorage(parseVaultKeyStorage(payload));
      setError(null);
    } catch {
      setError("Could not reach the Conductor backend.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setNotice(null);
    if (file.size > MAX_EXPORT_BYTES) {
      setError("That file is too large to be a password export.");
      return;
    }
    setBusy(true);
    try {
      const content = await file.text();
      const response = await fetch("/api/vault/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, content }),
      });
      if (!response.ok) {
        setError(await readError(response, "The import failed."));
        return;
      }
      const result = parseVaultImportResult(await response.json());
      setError(null);
      setNotice(
        result
          ? `${describeVaultImport(result)} Delete the export file now; it holds your passwords in plain text.`
          : "Import finished.",
      );
      await load();
    } catch {
      setError("The import failed.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(path: string, confirmMessage: string) {
    if (!window.confirm(confirmMessage)) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(path, { method: "DELETE" });
      if (!response.ok) {
        setError(await readError(response, "Could not delete."));
        return;
      }
      setError(null);
      await load();
    } catch {
      setError("Could not delete.");
    } finally {
      setBusy(false);
    }
  }

  const selectedSource = SOURCES.find((entry) => entry.id === source) ?? SOURCES[0];

  return (
    <div className="space-y-5">
      <section className="space-y-1">
        <h4 className="text-[24px] leading-[24px] text-[var(--vk-text-strong)]">Passwords</h4>
        <p className="text-[13px] leading-[20px] text-[var(--vk-text-muted)]">
          Import logins from your password manager so the assistant can sign in for you. They are stored
          encrypted on this machine and are never shown here or sent anywhere else.
        </p>
      </section>

      {keyStorage === "keychain" ? (
        <p className="text-[12px] leading-[18px] text-[var(--vk-text-muted)]">
          The encryption key is kept in this computer&apos;s system keychain.
        </p>
      ) : keyStorage === "file" ? (
        <p role="status" className="rounded-[4px] border border-[var(--vk-border)] px-3 py-2 text-[12px] leading-[18px] text-[var(--vk-orange)]">
          No system keychain is available on this machine, so the encryption key is kept in a private file next to
          the vault. Other programs running as your user could read it.
        </p>
      ) : null}

      <section className="space-y-3 rounded-[4px] border border-[var(--vk-border)] p-3">
        <div className="flex flex-wrap items-center gap-2">
          {SOURCES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={source === entry.id}
              onClick={() => setSource(entry.id)}
              className={`inline-flex h-8 items-center rounded-[4px] border px-3 text-[13px] ${
                source === entry.id
                  ? "border-[var(--vk-orange)] bg-[var(--vk-bg-hover)] text-[var(--vk-text-strong)]"
                  : "border-[var(--vk-border)] text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
              }`}
            >
              {vaultSourceLabel(entry.id)}
            </button>
          ))}
        </div>
        <p className="text-[12px] leading-[18px] text-[var(--vk-text-muted)]">{selectedSource.hint}</p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.json,text/csv,application/json"
          className="hidden"
          onChange={(event) => {
            void handleFile(event);
          }}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex h-8 items-center gap-2 rounded-[4px] border border-[var(--vk-border)] px-3 text-[13px] text-[var(--vk-text-strong)] hover:bg-[var(--vk-bg-hover)] disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          Choose export file
        </button>
        {notice ? <p className="text-[12px] leading-[18px] text-[var(--vk-green)]">{notice}</p> : null}
        {error ? <p role="alert" className="text-[12px] leading-[18px] text-[var(--vk-red)]">{error}</p> : null}
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h5 className="text-[14px] text-[var(--vk-text-strong)]">
            {loading ? "Saved logins" : `Saved logins (${credentials.length})`}
          </h5>
          {credentials.length > 0 ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void remove(
                  "/api/vault/credentials",
                  `Delete all ${credentials.length} saved logins from this machine? This cannot be undone.`,
                );
              }}
              className="text-[12px] text-[var(--vk-red)] hover:underline disabled:opacity-60"
            >
              Delete all
            </button>
          ) : null}
        </div>
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin text-[var(--vk-text-muted)]" />
        ) : credentials.length === 0 ? (
          <p className="text-[13px] text-[var(--vk-text-muted)]">Nothing saved yet.</p>
        ) : (
          <ul className="max-h-[320px] divide-y divide-[var(--vk-border)] overflow-y-auto rounded-[4px] border border-[var(--vk-border)]">
            {credentials.map((credential) => (
              <li key={credential.id} className="flex items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] text-[var(--vk-text-strong)]">
                    {credential.name || credential.url || "Untitled login"}
                  </div>
                  <div className="truncate text-[12px] text-[var(--vk-text-muted)]">
                    {[credential.username, credential.url, vaultSourceLabel(credential.source)]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Delete login for ${credential.name || credential.url || "this site"}`}
                  onClick={() => {
                    void remove(
                      `/api/vault/credentials/${encodeURIComponent(credential.id)}`,
                      "Delete this saved login?",
                    );
                  }}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[4px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-red)] disabled:opacity-60"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
