import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "./route";

test("GET includes concrete reconnect guidance for the PowerShell installer", async () => {
  const response = await GET();
  assert.equal(response.status, 200);

  const body = await response.text();

  assert.match(body, /\$ProgressPreference = "SilentlyContinue"/);
  assert.match(body, /Checking for Go toolchain/);
  assert.match(body, /Building conductor-bridge\.exe/);
  assert.match(
    body,
    /Starting Conductor Bridge pairing for dashboard: \$DashboardUrl/,
  );
  assert.match(
    body,
    /Bridge service installed\. Future reconnects can use: conductor-bridge connect --dashboard-url \$DashboardUrl/,
  );
  assert.match(body, /Installing conductor-oss CLI via npm/);
  assert.match(body, /Configure-UserPath/);
  assert.match(body, /SetEnvironmentVariable\("Path", \(\$updatedEntries -join ";"\), "User"\)/);
  assert.match(body, /Conductor CLI installed for local backend/);
  assert.match(body, /conductor-bridge\.exe/);
});
