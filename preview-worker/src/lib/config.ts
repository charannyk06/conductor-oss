export const MIN_WORKER_API_KEY_BYTES = 32;

export function requireWorkerApiKey(value: string | undefined): string {
  const apiKey = value?.trim();
  if (!apiKey) {
    throw new Error("WORKER_API_KEY must be configured.");
  }
  if (Buffer.byteLength(apiKey, "utf8") < MIN_WORKER_API_KEY_BYTES) {
    throw new Error(
      `WORKER_API_KEY must contain at least ${MIN_WORKER_API_KEY_BYTES} bytes.`,
    );
  }
  return apiKey;
}
