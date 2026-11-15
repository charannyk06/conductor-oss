import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

// MCP servers are commands the backend machine executes, so both reading and
// changing them is admin-only (the backend enforces the same rule).
export const GET = guardedProxyRoute("/api/mcp-servers", { role: "admin" });
export const PUT = guardedProxyRoute("/api/mcp-servers", { role: "admin", requireActionGuard: true });
