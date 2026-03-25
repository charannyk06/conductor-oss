function normalizeTerminalUrlForReload(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    url.searchParams.delete("token");
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

export function terminalUrlNeedsReload(
  current: string | null | undefined,
  next: string,
): boolean {
  const currentIdentity = normalizeTerminalUrlForReload(current);
  const nextIdentity = normalizeTerminalUrlForReload(next);
  if (!currentIdentity) {
    return true;
  }

  return currentIdentity !== nextIdentity;
}
