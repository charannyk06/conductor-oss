import assert from "node:assert/strict";
import test from "node:test";
import { isTransientRequestStatus, requestRetryDelayMs } from "./requestRetry";

test("transient request status classification retries bridge and server outages", () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(isTransientRequestStatus(status), true, `status ${status}`);
  }

  for (const status of [400, 401, 403, 404, 409, 422, 505]) {
    assert.equal(isTransientRequestStatus(status), false, `status ${status}`);
  }
});

test("request retry delay backs off, jitters, and remains capped", () => {
  assert.equal(requestRetryDelayMs(0, 0), 1_000);
  assert.equal(requestRetryDelayMs(1, 0), 2_000);
  assert.equal(requestRetryDelayMs(2, 1), 5_000);
  assert.equal(requestRetryDelayMs(3, 1), 10_000);
  assert.equal(requestRetryDelayMs(4, 1), 15_000);
  assert.equal(requestRetryDelayMs(20, 1), 15_000);
  assert.equal(requestRetryDelayMs(Number.NaN, Number.NaN), 1_000);
});
