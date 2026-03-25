// Pattern for selecting local development server candidates for preview auto-connect.
// Includes 0.0.0.0 because dev servers commonly bind to that address.
// This is intentionally broader than auth loopback checks in accessControl.ts.
const LOCAL_HOST_PATTERN = /(?:127\.0\.0\.1|0\.0\.0\.0|localhost|::1|\[::1\])/i;

function isLoopbackUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return LOCAL_HOST_PATTERN.test(parsed.hostname);
  } catch {
    return false;
  }
}

export function selectPreviewAutoConnectCandidate(candidateUrls: string[]): string | null {
  return candidateUrls.find((candidate) => isLoopbackUrl(candidate)) ?? null;
}
