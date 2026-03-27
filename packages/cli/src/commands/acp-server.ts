import { spawn } from "node:child_process";
import type { Command } from "commander";
import { resolveRustCliLaunch, rustCliGlobalArgs } from "../rust-cli.js";

export function registerAcpServer(program: Command): void {
  program
    .command("acp-server")
    .description("Start Conductor as an ACP server on stdio")
    .action(async () => {
      try {
        const launch = resolveRustCliLaunch();
        const child = spawn(
          launch.cmd,
          [...launch.argsPrefix, ...rustCliGlobalArgs(), "acp-server"],
          {
            cwd: process.cwd(),
            stdio: "inherit",
          },
        );

        child.on("error", (error) => {
          process.stderr.write(`Failed to start ACP server: ${String(error)}\n`);
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
        process.stderr.write(`Failed to start ACP server: ${String(err)}\n`);
        process.exit(1);
      }
    });
}
