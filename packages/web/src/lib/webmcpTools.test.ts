import assert from "node:assert/strict";
import test from "node:test";
import { requireConfirmedMutation } from "./webmcp";
import { WEBMCP_TOOL_ORDER, WEBMCP_TOOL_SPECS } from "./webmcpTools";

test("WebMCP tool catalog keeps the required shared tool names in a stable order", () => {
  assert.deepEqual(WEBMCP_TOOL_ORDER, [
    "conductor_get_workspace_overview",
    "conductor_list_projects",
    "conductor_list_sessions",
    "conductor_inspect_session",
    "conductor_focus_session",
    "conductor_start_agent",
    "conductor_send_feedback",
  ]);
});

test("read-only tools advertise readOnlyHint and bounded schemas", () => {
  for (const toolName of [
    "conductor_get_workspace_overview",
    "conductor_list_projects",
    "conductor_list_sessions",
    "conductor_inspect_session",
  ] as const) {
    const spec = WEBMCP_TOOL_SPECS[toolName];
    assert.equal(spec.annotations?.readOnlyHint, true);
    assert.equal(spec.inputSchema.type, "object");
    assert.equal(spec.inputSchema.additionalProperties, false);
  }
});

test("mutating tool schemas require confirmed and keep additionalProperties disabled", () => {
  for (const toolName of ["conductor_focus_session", "conductor_start_agent", "conductor_send_feedback"] as const) {
    const spec = WEBMCP_TOOL_SPECS[toolName];
    assert.equal(spec.inputSchema.type, "object");
    assert.equal(spec.inputSchema.additionalProperties, false);
    assert.ok(spec.inputSchema.required?.includes("confirmed"));
  }
  assert.equal(WEBMCP_TOOL_SPECS.conductor_list_sessions.inputSchema.properties?.limit?.maximum, 12);
  assert.equal(WEBMCP_TOOL_SPECS.conductor_start_agent.inputSchema.properties?.prompt?.maxLength, 4_000);
  assert.equal(WEBMCP_TOOL_SPECS.conductor_send_feedback.inputSchema.properties?.feedback?.maxLength, 4_000);
});

test("requireConfirmedMutation returns a structured JSON rejection", () => {
  const rejected = requireConfirmedMutation(
    { confirmed: false },
    "conductor_start_agent",
    "creating a real dashboard session",
  );
  assert.ok(rejected);
  const payload = JSON.parse(rejected ?? "{}") as {
    ok?: boolean;
    tool?: string;
    requiresConfirmation?: boolean;
    error?: string;
  };
  assert.equal(payload.ok, false);
  assert.equal(payload.tool, "conductor_start_agent");
  assert.equal(payload.requiresConfirmation, true);
  assert.match(payload.error ?? "", /confirmed: true/);
});
