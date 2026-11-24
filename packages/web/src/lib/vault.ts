/** Client-side shapes for the local credential vault API. Passwords are never part of them. */

export type VaultSource = "bitwarden" | "chrome" | "1password";

export type VaultCredential = {
  id: string;
  name: string;
  url: string;
  username: string;
  source: VaultSource;
  createdAt: string;
};

export type VaultImportResult = {
  source: VaultSource;
  imported: number;
  updated: number;
  unchanged: number;
  skipped: number;
};

function isVaultSource(value: unknown): value is VaultSource {
  return value === "bitwarden" || value === "chrome" || value === "1password";
}

export function vaultSourceLabel(source: VaultSource): string {
  switch (source) {
    case "bitwarden":
      return "Bitwarden";
    case "chrome":
      return "Chrome";
    case "1password":
      return "1Password";
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function parseVaultCredentials(payload: unknown): VaultCredential[] {
  const list = (payload as { credentials?: unknown } | null)?.credentials;
  if (!Array.isArray(list)) return [];
  const credentials: VaultCredential[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id || !isVaultSource(record.source)) continue;
    credentials.push({
      id: record.id,
      name: text(record.name),
      url: text(record.url),
      username: text(record.username),
      source: record.source,
      createdAt: text(record.createdAt),
    });
  }
  return credentials;
}

export function parseVaultImportResult(payload: unknown): VaultImportResult | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (!isVaultSource(record.source)) return null;
  return {
    source: record.source,
    imported: count(record.imported),
    updated: count(record.updated),
    unchanged: count(record.unchanged),
    skipped: count(record.skipped),
  };
}

export function describeVaultImport(result: VaultImportResult): string {
  const parts = [`${result.imported} new`];
  if (result.updated > 0) parts.push(`${result.updated} updated`);
  if (result.unchanged > 0) parts.push(`${result.unchanged} already saved`);
  if (result.skipped > 0) parts.push(`${result.skipped} skipped (no password)`);
  return `Imported from ${vaultSourceLabel(result.source)}: ${parts.join(", ")}.`;
}
