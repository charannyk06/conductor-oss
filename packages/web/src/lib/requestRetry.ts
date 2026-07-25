const REQUEST_RETRY_BASE_DELAY_MS = 1_000;
const REQUEST_RETRY_MAX_DELAY_MS = 15_000;
const REQUEST_RETRY_JITTER_RATIO = 0.25;

export function isTransientRequestStatus(status: number): boolean {
  return status === 408
    || status === 425
    || status === 429
    || (status >= 500 && status <= 504);
}

export function requestRetryDelayMs(
  failedAttempt: number,
  randomValue: number = Math.random(),
): number {
  const normalizedAttempt = Number.isFinite(failedAttempt)
    ? Math.max(0, Math.floor(failedAttempt))
    : 0;
  const baseDelay = Math.min(
    REQUEST_RETRY_MAX_DELAY_MS,
    REQUEST_RETRY_BASE_DELAY_MS * (2 ** normalizedAttempt),
  );
  const normalizedRandom = Number.isFinite(randomValue)
    ? Math.min(1, Math.max(0, randomValue))
    : 0;
  const jitteredDelay = Math.round(
    baseDelay * (1 + (REQUEST_RETRY_JITTER_RATIO * normalizedRandom)),
  );
  return Math.min(REQUEST_RETRY_MAX_DELAY_MS, jitteredDelay);
}
