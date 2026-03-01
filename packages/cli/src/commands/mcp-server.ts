/**
 * `co mcp-server`
 *
 * Starts Conductor as a Model Context Protocol (MCP) server on stdio.
 * AI clients (Cursor, Claude Desktop, Windsurf, etc.) connect via this
 * transport to dispatch tasks and inspect sessions.
 *
 * Usage:
 *   co mcp-server
 *
 * MCP client config example (claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "conductor": {
 *         "command": "co",
 *         "args": ["mcp-server"]
 *       }
 *     }
 *   }
 */

import type { Command } from "commander";

export function registerMcpServer(program: Command): void {
  program
    .command("mcp-server")
    .description("Start Conductor as an MCP server on stdio (for Cursor, Claude Desktop, etc.)")
    .action(async () => {
      try {
        const { startMcpServer } = await import("@conductor-oss/plugin-mcp-server");
        await startMcpServer();
      } catch (err) {
        process.stderr.write(`Failed to start MCP server: ${String(err)}\n`);
        process.exit(1);
      }
    });
}
