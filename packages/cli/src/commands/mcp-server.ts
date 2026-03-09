import { spawn } from "node:child_process";
import type { Command } from "commander";
import { resolveRustCliLaunch, rustCliGlobalArgs } from "../rust-cli.js";

export function registerMcpServer(program: Command): void {
  program
    .command("mcp-server")
    .description("Start Conductor as an MCP server on stdio (for Cursor, Claude Desktop, etc.)")
    .action(async () => {
      try {
        const launch = resolveRustCliLaunch();
        const child = spawn(
          launch.cmd,
          [...launch.argsPrefix, ...rustCliGlobalArgs(), "mcp-server"],
          {
            cwd: process.cwd(),
            stdio: "inherit",
          },
        );

        child.on("error", (error) => {
          process.stderr.write(`Failed to start MCP server: ${String(error)}\n`);
          process.exit(1);
        });

        child.on("exit", (code, signal) => {
          if (signal) {
            process.kill(process.pid, signal);
            return;
          }
          process.exit(code ?? 0);
        });
      } catch (err) {
        process.stderr.write(`Failed to start MCP server: ${String(err)}\n`);
        process.exit(1);
      }
    });
}
