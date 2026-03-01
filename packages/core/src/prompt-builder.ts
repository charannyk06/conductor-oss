/**
 * Prompt Builder -- composes layered prompts for agent sessions.
 *
 * Three layers:
 *   1. BASE_AGENT_PROMPT -- constant instructions about session lifecycle, git workflow, PR handling
 *   2. Config-derived context -- project name, repo, default branch, tracker info, reaction rules
 *   3. User rules -- inline agentRules and/or agentRulesFile content
 *
 * buildPrompt() returns null when there's nothing meaningful to compose
 * (no issue, no rules, no explicit prompt), preserving backward compatibility
 * for bare launches.
 */

import { readFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import type { ProjectConfig, TaskAttachment } from "./types.js";

// =============================================================================
// LAYER 1: BASE AGENT PROMPT
// =============================================================================

export const BASE_AGENT_PROMPT = `You are an AI coding agent managed by Conductor (co).

## CRITICAL: Fully Autonomous Operation
- You are running UNATTENDED. There is NO human watching your terminal.
- NEVER ask the user for input, confirmation, or choices. Make your own decisions.
- NEVER present multiple-choice menus, selection prompts, or "which option do you prefer?" questions.
- If you encounter a decision point (e.g. which tool to install, which approach to take), choose the most reasonable option yourself and proceed.
- If a tool asks for confirmation (y/n), always answer "yes" automatically.
- If you need to install dependencies, install them without asking.
- If you encounter an error, debug and fix it yourself -- do not wait for human input.
- Skip all optional interactive prompts and use defaults.

## Session Lifecycle
- You are running inside a managed session. Focus on the assigned task.
- When you finish your work, create a PR and push it. The orchestrator will handle CI monitoring and review routing.
- If CI fails, the orchestrator will send you the failures -- fix them and push again.
- If reviewers request changes, the orchestrator will forward their comments -- address each one, push fixes, and reply to the comments.

## Git Workflow
- Always create a feature branch from the default branch (never commit directly to it).
- Use conventional commit messages (feat:, fix:, chore:, etc.).
- Push your branch and create a PR when the implementation is ready.
- Keep PRs focused -- one issue per PR.

## PR Best Practices
- Write a clear PR title and description explaining what changed and why.
- Link the issue in the PR description so it auto-closes when merged.
- If the repo has CI checks, make sure they pass before requesting review.
- Respond to every review comment, even if just to acknowledge it.

## MANDATORY: Push and Create PR Before Exiting
- You MUST push your branch and create a pull request before you finish.
- Run: git push -u origin <your-branch> && gh pr create --fill
- If gh pr create fails, try: gh pr create --title "feat: <description>" --body "Automated PR from Conductor session"
- Do NOT exit without pushing. If you committed changes but did not push, you have NOT finished.
- The orchestrator considers a task complete ONLY when a PR exists.
- After creating the PR, EXIT immediately. Do NOT check CI, do NOT check reviews, do NOT continue working.
- The orchestrator handles CI monitoring and review routing automatically — that is NOT your job.
- Type /exit or simply stop after the PR is created.`;

// =============================================================================
// TYPES
// =============================================================================

export interface PromptBuildConfig {
  /** The project config from the orchestrator config */
  project: ProjectConfig;

  /** The project ID (key in the projects map) */
  projectId: string;

  /** Issue identifier (e.g. "INT-1343", "#42") -- triggers Layer 1+2 */
  issueId?: string;

  /** Pre-fetched issue context from tracker.generatePrompt() */
  issueContext?: string;

  /** Explicit user prompt (appended last) */
  userPrompt?: string;

  /** Image/file attachments from the task card. */
  attachments?: TaskAttachment[];
}

// =============================================================================
// LAYER 2: CONFIG-DERIVED CONTEXT
// =============================================================================

function buildConfigLayer(config: PromptBuildConfig): string {
  const { project, projectId, issueId, issueContext } = config;
  const lines: string[] = [];

  lines.push("## Project Context");
  lines.push(`- Project: ${project.name ?? projectId}`);
  lines.push(`- Repository: ${project.repo}`);
  lines.push(`- Default branch: ${project.defaultBranch}`);

  if (project.tracker) {
    lines.push(`- Tracker: ${project.tracker.plugin}`);
  }

  if (issueId) {
    lines.push(`\n## Task`);
    lines.push(`Work on issue: ${issueId}`);
    lines.push(
      `Create a branch named so that it auto-links to the issue tracker (e.g. feat/${issueId}).`,
    );
  }

  if (issueContext) {
    lines.push(`\n## Issue Details`);
    lines.push(issueContext);
  }

  // Include reaction rules so the agent knows what to expect
  if (project.reactions) {
    const reactionHints: string[] = [];
    for (const [event, reaction] of Object.entries(project.reactions)) {
      if (reaction.auto && reaction.action === "send-to-agent") {
        reactionHints.push(`- ${event}: auto-handled (you'll receive instructions)`);
      }
    }
    if (reactionHints.length > 0) {
      lines.push(`\n## Automated Reactions`);
      lines.push("The orchestrator will automatically handle these events:");
      lines.push(...reactionHints);
    }
  }

  return lines.join("\n");
}

// =============================================================================
// LAYER 3: USER RULES
// =============================================================================

function readUserRules(project: ProjectConfig): string | null {
  const parts: string[] = [];

  if (project.agentRules) {
    parts.push(project.agentRules);
  }

  if (project.agentRulesFile) {
    const filePath = resolve(project.path, project.agentRulesFile);
    try {
      const content = readFileSync(filePath, "utf-8").trim();
      if (content) {
        parts.push(content);
      }
    } catch {
      // File not found or unreadable -- skip silently (don't crash the spawn)
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Compose a layered prompt for an agent session.
 *
 * Returns null if there's nothing meaningful to compose (no issue, no rules,
 * no explicit user prompt). This preserves backward-compatible behavior where
 * bare launches (no issue) send no prompt.
 */
export function buildPrompt(config: PromptBuildConfig): string | null {
  const hasIssue = Boolean(config.issueId);
  const userRules = readUserRules(config.project);
  const hasRules = Boolean(userRules);
  const hasUserPrompt = Boolean(config.userPrompt);
  const hasAttachments = Boolean(config.attachments && config.attachments.length > 0);

  // Nothing to compose -- return null for backward compatibility
  if (!hasIssue && !hasRules && !hasUserPrompt && !hasAttachments) {
    return null;
  }

  const sections: string[] = [];

  // Layer 1: Base prompt (always included when we have something to compose)
  sections.push(BASE_AGENT_PROMPT);

  // Layer 2: Config-derived context
  sections.push(buildConfigLayer(config));

  // Layer 3: User rules
  if (userRules) {
    sections.push(`## Project Rules\n${userRules}`);
  }

  // Explicit user prompt (appended last, highest priority)
  if (config.userPrompt) {
    sections.push(`## Additional Instructions\n${config.userPrompt}`);
  }

  // Attachment instructions
  if (config.attachments && config.attachments.length > 0) {
    sections.push(buildAttachmentLayer(config.attachments));
  }

  return sections.join("\n\n");
}

// =============================================================================
// LAYER: ATTACHMENTS
// =============================================================================

function buildAttachmentLayer(attachments: TaskAttachment[]): string {
  const images = attachments.filter((a) => a.type === "image");
  const files = attachments.filter((a) => a.type === "file");
  const lines: string[] = [];

  lines.push("## Reference Attachments");
  lines.push("The following files were attached to this task as reference material.");
  lines.push("Read them using the Read tool to understand the visual design or context.");

  if (images.length > 0) {
    lines.push("");
    lines.push("### Images (screenshots / mockups / designs)");
    for (const img of images) {
      lines.push(`- \`${img.path}\` — ${basename(img.path)}`);
    }
    lines.push("");
    lines.push("Use the Read tool to view each image file. These are visual references — match your implementation to what you see.");
  }

  if (files.length > 0) {
    lines.push("");
    lines.push("### Reference Files");
    for (const f of files) {
      lines.push(`- \`${f.path}\` — ${basename(f.path)}`);
    }
  }

  return lines.join("\n");
}
