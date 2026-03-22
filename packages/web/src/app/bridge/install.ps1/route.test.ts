import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "./route";

test("GET includes concrete reconnect guidance for the PowerShell installer", async () => {
  const response = await GET();
  assert.equal(response.status, 200);

  const body = await response.text();

  assert.match(
    body,
    /Starting Conductor Bridge pairing for dashboard: \$DashboardUrl/,
  );
  assert.match(
    body,
    /Bridge service installed\. Future reconnects can use: conductor-bridge connect --dashboard-url \$DashboardUrl/,
  );
  assert.match(body, /conductor-bridge\.exe/);
});
