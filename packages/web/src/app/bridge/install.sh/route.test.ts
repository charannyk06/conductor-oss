import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "./route";

test("GET includes concrete reconnect guidance when a dashboard URL is provided to the installer", async () => {
  const response = await GET();
  assert.equal(response.status, 200);

  const body = await response.text();

  assert.match(
    body,
    /Starting Conductor Bridge pairing for dashboard: \$CONNECT_DASHBOARD_URL/,
  );
  assert.match(
    body,
    /Future reconnects can use: conductor-bridge connect --dashboard-url \$CONNECT_DASHBOARD_URL/,
  );
  assert.match(
    body,
    /Future reconnects can use: conductor-bridge connect --dashboard-url <your dashboard URL>/,
  );
});
