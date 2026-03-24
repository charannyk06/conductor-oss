import assert from "node:assert/strict";
import test from "node:test";

import { shouldAutoOpenPreviewTab } from "./sessionDetailBehavior";

test("shouldAutoOpenPreviewTab only opens preview for active terminal sessions", () => {
  assert.equal(
    shouldAutoOpenPreviewTab({
      active: true,
      activeTab: "terminal",
      alreadyOpened: false,
      connected: true,
      suppressAutoOpen: false,
    }),
    true,
  );

  assert.equal(
    shouldAutoOpenPreviewTab({
      active: true,
      activeTab: "terminal",
      alreadyOpened: false,
      connected: true,
      suppressAutoOpen: true,
    }),
    false,
  );

  assert.equal(
    shouldAutoOpenPreviewTab({
      active: true,
      activeTab: "preview",
      alreadyOpened: false,
      connected: true,
      suppressAutoOpen: false,
    }),
    false,
  );
});
