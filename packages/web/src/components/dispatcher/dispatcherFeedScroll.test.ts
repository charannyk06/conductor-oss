import assert from "node:assert/strict";
import test from "node:test";
import {
  DISPATCHER_FEED_AUTO_SCROLL_THRESHOLD_PX,
  isDispatcherFeedNearBottom,
} from "./dispatcherFeedScroll";

test("isDispatcherFeedNearBottom returns true when the feed is already at the end", () => {
  assert.equal(
    isDispatcherFeedNearBottom({
      clientHeight: 480,
      scrollHeight: 1280,
      scrollTop: 800,
    }),
    true,
  );
});

test("isDispatcherFeedNearBottom tolerates small remaining gaps near the end", () => {
  assert.equal(
    isDispatcherFeedNearBottom({
      clientHeight: 480,
      scrollHeight: 1280,
      scrollTop: 1280 - 480 - (DISPATCHER_FEED_AUTO_SCROLL_THRESHOLD_PX - 0.5),
    }),
    true,
  );
});

test("isDispatcherFeedNearBottom returns false when the user has scrolled away", () => {
  assert.equal(
    isDispatcherFeedNearBottom({
      clientHeight: 480,
      scrollHeight: 1280,
      scrollTop: 1280 - 480 - (DISPATCHER_FEED_AUTO_SCROLL_THRESHOLD_PX + 24),
    }),
    false,
  );
});
