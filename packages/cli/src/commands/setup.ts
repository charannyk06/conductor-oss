import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import process from "node:process";
import chalk from "chalk";
import type { Command } from "commander";
import { runInitScaffold, type InitOptions } from "./init.js";

type SetupOptions = InitOptions & {
  ide?: string;
  markdownEditor?: string;
  start?: boolean;
  tunnel?: boolean;
  yes?: boolean;
};

export type InstallCommand = {
  label: string;
  cmd: string;
  args: string[];
};

export type SetupCheck = {
  id: string;
  label: string;
  description: string;
  installed: boolean;
  detail: string;
  install?: InstallCommand;
  authCommand?: InstallCommand;
  postInstallAuthCommand?: InstallCommand;
};

export type AgentSetupConfig = {
  commands: string[];
  installPackage?: string;
  installLabel?: string;
  requiredNodeMajor?: number;
  postInstallAuthCommand?: InstallCommand;
};

export type TunnelSetupConfig = {
  commands: string[];
  install?: InstallCommand;
};

function commandExists(command: string): boolean {
  const result = spawnSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" });
  return result.status === 0;
}

function appExists(appName: string): boolean {
  if (process.platform !== "darwin") return false;
  const candidates = [
    `/Applications/${appName}.app`,
    `${homedir()}/Applications/${appName}.app`,
  ];
  return candidates.some((candidate) => spawnSync("test", ["-d", candidate], { stdio: "ignore" }).status === 0);
}

function runCommand(command: InstallCommand): void {
  const result = spawnSync(command.cmd, command.args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command.label}`);
  }
}

function getPackageInstaller(): "brew" | "apt" | null {
  if (commandExists("brew")) return "brew";
  if (commandExists("apt-get")) return "apt";
  return null;
}

function buildPackageInstall(label: string, brewFormula: string, aptFormula?: string): InstallCommand | undefined {
  const installer = getPackageInstaller();
  if (installer === "brew") {
    return { label, cmd: "brew", args: ["install", brewFormula] };
  }
  if (installer === "apt" && aptFormula) {
    return { label, cmd: "sudo", args: ["apt-get", "install", "-y", aptFormula] };
  }
  return undefined;
}

function buildCaskInstall(label: string, cask: string): InstallCommand | undefined {
  if (getPackageInstaller() !== "brew") return undefined;
  return { label, cmd: "brew", args: ["install", "--cask", cask] };
}

function buildNpmInstall(label: string, pkg: string): InstallCommand | undefined {
  if (!commandExists("npm")) return undefined;
  return { label, cmd: "npm", args: ["install", "-g", pkg] };
}

function getNodeMajorVersion(): number | null {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
  return Number.isFinite(major) ? major : null;
}

function detectGitHubAuth(): boolean {
  if (!commandExists("gh")) return false;
  const result = spawnSync("gh", ["auth", "status", "--hostname", "github.com"], { stdio: "ignore" });
  return result.status === 0;
}

export function buildAgentCheck(agent: string): SetupCheck {
  const normalized = agent.trim();
  const currentNodeMajor = getNodeMajorVersion();
  const hasNpm = commandExists("npm");
  const config = resolveAgentSetupConfig(normalized);

  const installed = config.commands.some((command) => commandExists(command));
  const installBlockedByNode = !installed
    && !!config.requiredNodeMajor
    && (!currentNodeMajor || currentNodeMajor < config.requiredNodeMajor);
  const install = !installed && !installBlockedByNode && config.installPackage && hasNpm
    ? buildNpmInstall(config.installLabel ?? `Install ${normalized}`, config.installPackage)
    : undefined;

  let detail = "Ready";
  if (!installed) {
    if (installBlockedByNode) {
      detail = `Missing. Requires Node.js ${config.requiredNodeMajor}+ before Conductor can install it.`;
    } else if (config.installPackage && !hasNpm) {
      detail = "Missing. Install npm first to let Conductor set this up automatically.";
    } else if (install) {
      detail = config.postInstallAuthCommand
        ? "Missing. Conductor can install it and launch browser sign-in."
        : "Missing. Conductor can install it for you.";
    } else {
      detail = "Missing. Automatic installation is not available yet for this tool.";
    }
  }

  return {
    id: `agent:${normalized}`,
    label: `AI assistant: ${normalized}`,
    description: "Used to handle product and engineering tasks inside Conductor.",
    installed,
    detail,
    install,
    postInstallAuthCommand: !installed ? config.postInstallAuthCommand : undefined,
  };
}

export function resolveAgentSetupConfig(agent: string): AgentSetupConfig {
  const normalized = agent.trim();
  const byAgent: Record<string, AgentSetupConfig> = {
    "claude-code": {
      commands: ["claude-code", "claude", "cc"],
      installPackage: "@anthropic-ai/claude-code",
      installLabel: "Install Claude Code",
    },
    codex: {
      commands: ["codex"],
      installPackage: "@openai/codex",
      installLabel: "Install OpenAI Codex",
      postInstallAuthCommand: {
        label: "Connect OpenAI Codex",
        cmd: "codex",
        args: ["login"],
      },
    },
    gemini: {
      commands: ["gemini"],
      installPackage: "@google/gemini-cli",
      installLabel: "Install Gemini CLI",
      requiredNodeMajor: 20,
    },
    "github-copilot": {
      commands: ["github-copilot", "copilot", "gh-copilot"],
      installPackage: "@githubnext/github-copilot-cli",
      installLabel: "Install GitHub Copilot CLI",
    },
    "cursor-cli": {
      commands: ["cursor-cli", "cursor"],
    },
    amp: {
      commands: ["amp"],
    },
    opencode: {
      commands: ["opencode"],
    },
    droid: {
      commands: ["droid"],
    },
    "qwen-code": {
      commands: ["qwen", "qwen-code"],
      installPackage: "@qwen-code/qwen-code@latest",
      installLabel: "Install Qwen Code",
      requiredNodeMajor: 20,
      postInstallAuthCommand: {
        label: "Connect Qwen Code",
        cmd: "qwen",
        args: [],
      },
    },
    ccr: {
      commands: ["ccr"],
    },
  };

  return byAgent[normalized] ?? { commands: [normalized] };
}

function buildIdeCheck(ide: string): SetupCheck | null {
  const normalized = ide.trim();
  const byIde: Record<string, { commands: string[]; apps: string[]; install?: InstallCommand }> = {
    vscode: {
      commands: ["code"],
      apps: ["Visual Studio Code"],
      install: buildCaskInstall("Install VS Code", "visual-studio-code"),
    },
    "vscode-insiders": {
      commands: ["code-insiders"],
      apps: ["Visual Studio Code - Insiders"],
      install: buildCaskInstall("Install VS Code Insiders", "visual-studio-code-insiders"),
    },
    cursor: {
      commands: ["cursor"],
      apps: ["Cursor"],
      install: buildCaskInstall("Install Cursor", "cursor"),
    },
    zed: {
      commands: ["zed"],
      apps: ["Zed"],
      install: buildCaskInstall("Install Zed", "zed"),
    },
  };

  const config = byIde[normalized];
  if (!config) return null;
  const installed = config.commands.some((command) => commandExists(command))
    || config.apps.some((appName) => appExists(appName));

  return {
    id: `ide:${normalized}`,
    label: `Code editor: ${normalized}`,
    description: "Used when opening files or jumping into a remote workspace.",
    installed,
    detail: installed
      ? "Ready"
      : config.install
        ? "Missing. Conductor can install it for you on macOS with Homebrew."
        : "Missing. Install this editor manually on your machine.",
    install: !installed ? config.install : undefined,
  };
}

function buildMarkdownCheck(editor: string): SetupCheck | null {
  const normalized = editor.trim();
  const byEditor: Record<string, { apps: string[]; install?: InstallCommand }> = {
    obsidian: {
      apps: ["Obsidian"],
      install: buildCaskInstall("Install Obsidian", "obsidian"),
    },
    notion: {
      apps: ["Notion"],
      install: buildCaskInstall("Install Notion", "notion"),
    },
    logseq: {
      apps: ["Logseq"],
      install: buildCaskInstall("Install Logseq", "logseq"),
    },
    typora: {
      apps: ["Typora"],
      install: buildCaskInstall("Install Typora", "typora"),
    },
  };

  const config = byEditor[normalized];
  if (!config) return null;
  const installed = config.apps.some((appName) => appExists(appName));

  return {
    id: `markdown:${normalized}`,
    label: `Notes app: ${normalized}`,
    description: "Used as the product team's context and documentation source.",
    installed,
    detail: installed
      ? "Ready"
      : config.install
        ? "Missing. Conductor can install it for you on macOS with Homebrew."
        : "Missing. Install this app manually on your machine.",
    install: !installed ? config.install : undefined,
  };
}

export function resolveTunnelSetupConfig(provider: string): TunnelSetupConfig {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "cloudflare") {
    return {
      commands: ["cloudflared"],
      install: buildPackageInstall("Install Cloudflare Tunnel", "cloudflared", "cloudflared"),
    };
  }

  return {
    commands: [normalized],
  };
}

export function buildTunnelCheck(provider: string): SetupCheck {
  const config = resolveTunnelSetupConfig(provider);
  const installed = config.commands.some((command) => commandExists(command));

  return {
    id: `tunnel:${provider}`,
    label: "Public dashboard tunnel",
    description: "Exposes the dashboard on a free public URL for remote device access.",
    installed,
    detail: installed
      ? "Ready"
      : config.install
        ? "Missing. Conductor can install a free Cloudflare Quick Tunnel for you."
        : "Missing. Install a supported tunnel binary manually.",
    install: !installed ? config.install : undefined,
  };
}

function buildBaseChecks(
  agent: string,
  ide: string,
  markdownEditor: string,
  options?: { tunnel?: boolean; tunnelProvider?: string },
): SetupCheck[] {
  const checks: SetupCheck[] = [
    {
      id: "git",
      label: "Git",
      description: "Required to create isolated workspaces and branches.",
      installed: commandExists("git"),
      detail: commandExists("git") ? "Ready" : "Missing. Conductor can install it for you.",
      install: !commandExists("git") ? buildPackageInstall("Install Git", "git", "git") : undefined,
    },
    {
      id: "tmux",
      label: "tmux",
      description: "Keeps long-running work alive even if the dashboard closes.",
      installed: commandExists("tmux"),
      detail: commandExists("tmux") ? "Ready" : "Missing. Conductor can install it for you.",
      install: !commandExists("tmux") ? buildPackageInstall("Install tmux", "tmux", "tmux") : undefined,
    },
    {
      id: "gh",
      label: "GitHub CLI",
      description: "Needed for repository discovery, pull requests, and CI integration.",
      installed: commandExists("gh"),
      detail: commandExists("gh") ? "Installed" : "Missing. Conductor can install it for you.",
      install: !commandExists("gh") ? buildPackageInstall("Install GitHub CLI", "gh", "gh") : undefined,
    },
    {
      id: "gh-auth",
      label: "GitHub connection",
      description: "Lets Conductor see repos and open pull requests for you.",
      installed: detectGitHubAuth(),
      detail: detectGitHubAuth() ? "Connected" : "Not connected yet. Conductor can guide you through browser sign-in.",
      authCommand: !detectGitHubAuth() && commandExists("gh")
        ? {
            label: "Connect GitHub",
            cmd: "gh",
            args: ["auth", "login", "--hostname", "github.com", "--web", "--git-protocol", "https", "--skip-ssh-key"],
          }
        : undefined,
    },
    buildAgentCheck(agent),
  ];

  const ideCheck = buildIdeCheck(ide);
  if (ideCheck) checks.push(ideCheck);

  const markdownCheck = buildMarkdownCheck(markdownEditor);
  if (markdownCheck) checks.push(markdownCheck);

  if (options?.tunnel) {
    checks.push(buildTunnelCheck(options.tunnelProvider ?? "cloudflare"));
  }

  return checks;
}

function printChecks(checks: SetupCheck[]): void {
  console.log();
  console.log(chalk.bold("Machine readiness"));
  for (const check of checks) {
    const marker = check.installed ? chalk.green("●") : chalk.yellow("●");
    console.log(`  ${marker} ${check.label}`);
    console.log(chalk.dim(`    ${check.detail}`));
  }
}

function rerunChecks(
  agent: string,
  ide: string,
  markdownEditor: string,
  options?: { tunnel?: boolean; tunnelProvider?: string },
): SetupCheck[] {
  return buildBaseChecks(agent, ide, markdownEditor, options);
}

function startConductor(projectPath: string, configPath: string, options?: { tunnel?: boolean }): void {
  const cliEntrypoint = process.argv[1];
  if (!cliEntrypoint || cliEntrypoint.endsWith(".ts")) {
    console.log();
    console.log(chalk.yellow("Setup finished. Run `co start --open` to launch Conductor."));
    return;
  }

  console.log();
  console.log(chalk.bold("Opening Conductor in your browser..."));
  execFileSync(
    process.execPath,
    [
      cliEntrypoint,
      "start",
      "--workspace",
      projectPath,
      "--open",
      ...(options?.tunnel ? ["--tunnel"] : []),
    ],
    {
      cwd: projectPath,
      stdio: "inherit",
      env: {
        ...process.env,
        CONDUCTOR_WORKSPACE: projectPath,
        CO_CONFIG_PATH: configPath,
      },
    },
  );
}

export function registerSetup(program: Command): void {
  program
    .command("setup")
    .description("Guided first-run setup for non-technical users")
    .option("-f, --force", "Overwrite existing files")
    .option("--project-id <id>", "Project id written to conductor.yaml")
    .option("--display-name <name>", "Friendly name shown in the dashboard")
    .option("--repo <owner/repo>", "GitHub repository slug. Auto-detected from origin if omitted.")
    .option("--path <path>", "Repository path. Defaults to the current working directory.")
    .option("--agent <agent>", "Default coding agent")
    .option("--default-branch <branch>", "Default target branch. Auto-detected if omitted.")
    .option("--default-working-directory <path>", "Relative directory inside the repository where agents start")
    .option("--dashboard-url <url>", "Public dashboard URL written into conductor.yaml")
    .option("--ide <editor>", "Preferred code editor")
    .option("--markdown-editor <editor>", "Preferred markdown app")
    .option("--tunnel", "Install and launch a free public Cloudflare tunnel for remote access")
    .option("--yes", "Install what is missing without asking for confirmation")
    .option("--no-start", "Do not start Conductor after setup completes")
    .action(async (opts: SetupOptions) => {
      try {
        const cwd = process.cwd();
        const agent = opts.agent?.trim() || "claude-code";
        const ide = opts.ide?.trim() || "vscode";
        const markdownEditor = opts.markdownEditor?.trim() || "obsidian";
        const tunnelEnabled = opts.tunnel === true;

        console.log();
        console.log(chalk.bold("Conductor Setup"));
        console.log(chalk.dim("We’ll scaffold this repo, launch the dashboard, and let the browser finish the guided setup."));

        let checks = rerunChecks(agent, ide, markdownEditor, {
          tunnel: tunnelEnabled,
          tunnelProvider: "cloudflare",
        });
        printChecks(checks);

        if (opts.yes) {
          const installableChecks = checks.filter((check) => !check.installed && check.install);
          for (const check of installableChecks) {
            if (!check.install) continue;
            console.log();
            console.log(chalk.bold(check.install.label));
            runCommand(check.install);
            if (check.postInstallAuthCommand) {
              console.log();
              console.log(chalk.bold(check.postInstallAuthCommand.label));
              runCommand(check.postInstallAuthCommand);
            }
          }

          checks = rerunChecks(agent, ide, markdownEditor, {
            tunnel: tunnelEnabled,
            tunnelProvider: "cloudflare",
          });
          const pendingAuth = checks.filter((check) => !check.installed && check.authCommand);
          for (const check of pendingAuth) {
            if (!check.authCommand) continue;
            console.log();
            console.log(chalk.bold(check.authCommand.label));
            runCommand(check.authCommand);
          }
        }

        checks = rerunChecks(agent, ide, markdownEditor, {
          tunnel: tunnelEnabled,
          tunnelProvider: "cloudflare",
        });
        printChecks(checks);

        console.log();
        const remainingManual = checks.filter((check) => !check.installed && !check.install && !check.authCommand);
        if (remainingManual.length > 0) {
          console.log(chalk.yellow("A few selections still need manual install:"));
          for (const check of remainingManual) {
            console.log(`  - ${check.label}: ${check.detail}`);
          }
          console.log(chalk.dim("You can keep going. Finish the product-facing setup in the dashboard after it opens."));
        }

        console.log();
        console.log(chalk.bold("Scaffolding this repository..."));
        const { project, created, configPath } = runInitScaffold(cwd, {
          ...opts,
          agent,
          ide,
          markdownEditor,
        });

        if (created > 0) {
          console.log();
          console.log(chalk.green("Everything is configured for this workspace."));
          console.log(chalk.dim(`Project: ${project.displayName} (${project.projectId})`));
          console.log(chalk.dim(`Repository: ${project.repo}`));
        }

        if (opts.start !== false) {
          startConductor(project.path, configPath, { tunnel: tunnelEnabled });
          return;
        }

        console.log();
        console.log(chalk.dim(`Next step: co start --workspace ${project.path} --open`));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`Setup failed: ${message}`));
        process.exitCode = 1;
      }
    });
}
