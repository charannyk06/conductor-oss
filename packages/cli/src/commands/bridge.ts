import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Command } from "commander";

interface BridgeSetupOptions {
  dashboardUrl: string;
  relayUrl?: string;
  noBrowser?: boolean;
  installUrl?: string;
}

function resolveDefaultInstallUrl(dashboardUrl: string): string {
  const base = new URL(dashboardUrl);
  base.pathname = process.platform === "win32" ? "/bridge/install.ps1" : "/bridge/install.sh";
  base.search = "";
  base.hash = "";
  return base.toString();
}

async function downloadInstaller(installUrl: string): Promise<{ tempDir: string; filePath: string }> {
  const response = await fetch(installUrl, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Failed to download bridge installer (${response.status}) from ${installUrl}`);
  }

  const script = await response.text();
  const tempDir = await mkdtemp(join(tmpdir(), "conductor-bridge-"));
  const filePath = join(tempDir, process.platform === "win32" ? "install.ps1" : "install.sh");
  await writeFile(filePath, script, { mode: 0o700 });
  return { tempDir, filePath };
}

function runInstaller(filePath: string, options: BridgeSetupOptions): number {
  if (process.platform === "win32") {
    const command = process.env.SystemRoot
      ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "powershell.exe";
    const args = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      filePath,
      "-Connect",
      "-DashboardUrl",
      options.dashboardUrl,
    ];
    if (options.relayUrl?.trim()) {
      args.push("-RelayUrl", options.relayUrl.trim());
    }
    if (options.noBrowser) {
      args.push("-NoBrowser");
    }
    const result = spawnSync(command, args, { stdio: "inherit" });
    if (result.error) {
      throw result.error;
    }
    return result.status ?? 1;
  }

  const args = [filePath, "--connect", "--dashboard-url", options.dashboardUrl];
  if (options.relayUrl?.trim()) {
    args.push("--relay-url", options.relayUrl.trim());
  }
  if (options.noBrowser) {
    args.push("--no-browser");
  }
  const result = spawnSync("sh", args, { stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

export function registerBridge(program: Command): void {
  const bridge = program
    .command("bridge")
    .description("Cross-platform Conductor Bridge setup and pairing");

  bridge
    .command("setup")
    .description("Install Conductor Bridge for this OS and pair it to a dashboard")
    .requiredOption("--dashboard-url <url>", "Dashboard URL to pair against")
    .option("--relay-url <url>", "Relay URL for bridge traffic")
    .option("--no-browser", "Do not auto-open the dashboard claim page")
    .option("--install-url <url>", "Override installer URL. Intended for development only.")
    .action(async (opts: BridgeSetupOptions) => {
      const installUrl = opts.installUrl?.trim() || resolveDefaultInstallUrl(opts.dashboardUrl);
      console.log(`Preparing Conductor Bridge setup for ${opts.dashboardUrl}`);
      console.log(`Detected platform: ${process.platform}`);
      console.log(`Downloading installer: ${installUrl}`);
      const { tempDir, filePath } = await downloadInstaller(installUrl);
      try {
        console.log(`Running installer: ${process.platform === "win32" ? "PowerShell" : "sh"}`);
        const exitCode = runInstaller(filePath, opts);
        if (exitCode !== 0) {
          process.exitCode = exitCode;
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    });
}
