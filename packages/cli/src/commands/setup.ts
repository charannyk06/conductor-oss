import { execFileSync, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import process from "node:process";
import chalk from "chalk";
import type { Command } from "commander";
import { runInitScaffold, type InitOptions } from "./init.js";

type SetupOptions = InitOptions & {
  ide?: string;
  markdownEditor?: string;
  start?: boolean;
  yes?: boolean;
};

type InstallCommand = {
  label: string;
  cmd: string;
  args: string[];
};

type SetupCheck = {
  id: string;
  label: string;
  description: string;
  installed: boolean;
  detail: string;
  install?: InstallCommand;
  authCommand?: InstallCommand;
};

type SelectOption = {
  value: string;
  label: string;
};

const AGENT_OPTIONS: SelectOption[] = [
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "OpenAI Codex" },
  { value: "gemini", label: "Gemini CLI" },
  { value: "github-copilot", label: "GitHub Copilot" },
  { value: "cursor-cli", label: "Cursor Agent" },
  { value: "amp", label: "Amp" },
  { value: "opencode", label: "OpenCode" },
  { value: "droid", label: "Droid" },
  { value: "qwen-code", label: "Qwen Code" },
  { value: "ccr", label: "CCR" },
];

const IDE_OPTIONS: SelectOption[] = [
  { value: "vscode", label: "VS Code" },
  { value: "vscode-insiders", label: "VS Code Insiders" },
  { value: "cursor", label: "Cursor" },
  { value: "zed", label: "Zed" },
  { value: "custom", label: "I already have something else" },
];

const MARKDOWN_EDITOR_OPTIONS: SelectOption[] = [
  { value: "obsidian", label: "Obsidian" },
  { value: "notion", label: "Notion" },
  { value: "logseq", label: "Logseq" },
  { value: "typora", label: "Typora" },
  { value: "custom", label: "I already have something else" },
];

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

function detectGitHubAuth(): boolean {
  if (!commandExists("gh")) return false;
  const result = spawnSync("gh", ["auth", "status", "--hostname", "github.com"], { stdio: "ignore" });
  return result.status === 0;
}

function buildAgentCheck(agent: string): SetupCheck {
  const normalized = agent.trim();
  const byAgent: Record<string, { commands: string[]; install?: InstallCommand }> = {
    "claude-code": {
      commands: ["claude-code", "claude", "cc"],
      install: buildNpmInstall("Install Claude Code", "@anthropic-ai/claude-code"),
    },
    codex: {
      commands: ["codex"],
      install: buildNpmInstall("Install OpenAI Codex", "@openai/codex-cli"),
    },
    gemini: {
      commands: ["gemini"],
      install: buildNpmInstall("Install Gemini CLI", "@google/gemini-cli"),
    },
    "github-copilot": {
      commands: ["github-copilot", "copilot", "gh-copilot"],
      install: buildNpmInstall("Install GitHub Copilot CLI", "@githubnext/github-copilot-cli"),
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
      commands: ["qwen-code"],
    },
    ccr: {
      commands: ["ccr"],
    },
  };

  const config = byAgent[normalized] ?? { commands: [normalized] };
  const installed = config.commands.some((command) => commandExists(command));

  return {
    id: `agent:${normalized}`,
    label: `AI assistant: ${normalized}`,
    description: "Used to handle product and engineering tasks inside Conductor.",
    installed,
    detail: installed
      ? "Ready"
      : config.install
        ? "Missing. Conductor can install it for you."
        : "Missing. Automatic installation is not available yet for this tool.",
    install: !installed ? config.install : undefined,
  };
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

function buildBaseChecks(agent: string, ide: string, markdownEditor: string): SetupCheck[] {
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

  return checks;
}

async function askYesNo(question: string, defaultValue = true): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? "[Y/n]" : "[y/N]";
  const answer = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase();
  rl.close();
  if (!answer) return defaultValue;
  return answer === "y" || answer === "yes";
}

async function selectOption(question: string, options: SelectOption[], fallback: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log();
  console.log(chalk.bold(question));
  options.forEach((option, index) => {
    const isDefault = option.value === fallback;
    console.log(`  ${index + 1}. ${option.label}${isDefault ? chalk.dim(" (recommended)") : ""}`);
  });
  const answer = (await rl.question("Choose a number and press Enter: ")).trim();
  rl.close();
  const selected = Number.parseInt(answer, 10);
  if (Number.isFinite(selected) && selected >= 1 && selected <= options.length) {
    return options[selected - 1]?.value ?? fallback;
  }
  return fallback;
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

function rerunChecks(agent: string, ide: string, markdownEditor: string): SetupCheck[] {
  return buildBaseChecks(agent, ide, markdownEditor);
}

function startConductor(projectPath: string, configPath: string): void {
  const cliEntrypoint = process.argv[1];
  if (!cliEntrypoint || cliEntrypoint.endsWith(".ts")) {
    console.log();
    console.log(chalk.yellow("Setup finished. Run `co start` to launch Conductor."));
    return;
  }

  console.log();
  console.log(chalk.bold("Launching Conductor..."));
  execFileSync(
    process.execPath,
    [cliEntrypoint, "start", "--workspace", projectPath],
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
    .option("--yes", "Install what is missing without asking for confirmation")
    .option("--no-start", "Do not start Conductor after setup completes")
    .action(async (opts: SetupOptions) => {
      try {
        const cwd = process.cwd();
        const agent = opts.agent?.trim() || await selectOption("Which AI assistant should Conductor use by default?", AGENT_OPTIONS, "claude-code");
        const ide = opts.ide?.trim() || await selectOption("Which code editor should open when someone reviews work?", IDE_OPTIONS, "vscode");
        const markdownEditor = opts.markdownEditor?.trim() || await selectOption("Which notes app should Conductor expect for docs and context?", MARKDOWN_EDITOR_OPTIONS, "obsidian");

        console.log();
        console.log(chalk.bold("Conductor Setup"));
        console.log(chalk.dim("We’ll check your machine, install what is missing, scaffold the workspace, and start Conductor."));

        let checks = rerunChecks(agent, ide, markdownEditor);
        printChecks(checks);

        const installableChecks = checks.filter((check) => !check.installed && check.install);
        if (installableChecks.length > 0) {
          const shouldInstall = opts.yes || await askYesNo("Install the missing tools automatically?", true);
          if (shouldInstall) {
            for (const check of installableChecks) {
              if (!check.install) continue;
              console.log();
              console.log(chalk.bold(check.install.label));
              runCommand(check.install);
            }
          }
        }

        checks = rerunChecks(agent, ide, markdownEditor);
        const pendingAuth = checks.filter((check) => !check.installed && check.authCommand);
        if (pendingAuth.length > 0) {
          const shouldConnect = opts.yes || await askYesNo("Connect GitHub in your browser now?", true);
          if (shouldConnect) {
            for (const check of pendingAuth) {
              if (!check.authCommand) continue;
              console.log();
              console.log(chalk.bold(check.authCommand.label));
              runCommand(check.authCommand);
            }
          }
        }

        checks = rerunChecks(agent, ide, markdownEditor);
        printChecks(checks);

        console.log();
        const remainingManual = checks.filter((check) => !check.installed && !check.install && !check.authCommand);
        if (remainingManual.length > 0) {
          console.log(chalk.yellow("A few selections still need manual install:"));
          for (const check of remainingManual) {
            console.log(`  - ${check.label}: ${check.detail}`);
          }
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
          startConductor(project.path, configPath);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`Setup failed: ${message}`));
        process.exitCode = 1;
      }
    });
}
