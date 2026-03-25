export function extractTerminalAuthToken(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const token = new URL(value).searchParams.get("token")?.trim();
    return token && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}
