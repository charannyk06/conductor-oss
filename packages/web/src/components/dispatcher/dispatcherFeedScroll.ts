export const DISPATCHER_FEED_AUTO_SCROLL_THRESHOLD_PX = 32;

type ScrollMetrics = {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
};

export function isDispatcherFeedNearBottom(
  metrics: ScrollMetrics,
  threshold = DISPATCHER_FEED_AUTO_SCROLL_THRESHOLD_PX,
): boolean {
  const { clientHeight, scrollHeight, scrollTop } = metrics;
  if (![clientHeight, scrollHeight, scrollTop].every(Number.isFinite)) {
    return true;
  }

  const remainingDistance = Math.max(0, scrollHeight - clientHeight - scrollTop);
  return remainingDistance <= Math.max(0, threshold);
}
