#!/usr/bin/env node

/**
 * Conductor CLI — `co`
 *
 * Markdown-native AI agent orchestrator.
 * Dispatch tasks from a kanban board, track PRs, CI, and reviews.
 */

import { Command } from "commander";
import { registerSpawn } from "./commands/spawn.js";
import { registerList } from "./commands/list.js";
import { registerStatus } from "./commands/status.js";
import { registerSend } from "./commands/send.js";
import { registerKill } from "./commands/kill.js";
import { registerAttach } from "./commands/attach.js";
import { registerCleanup } from "./commands/cleanup.js";
import { registerRestore } from "./commands/restore.js";
import { registerDashboard } from "./commands/dashboard.js";
import { registerStart } from "./commands/start.js";
import { registerWatch } from "./commands/watch.js";
import { registerInit } from "./commands/init.js";
import { registerMcpServer } from "./commands/mcp-server.js";
import { registerWebhook } from "./commands/webhook.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerRetry } from "./commands/retry.js";
import { registerTask } from "./commands/task.js";
import { registerFeedback } from "./commands/feedback.js";
import { registerSetup } from "./commands/setup.js";

const program = new Command();

program
  .name("co")
  .description("Conductor — markdown-native AI agent orchestrator")
  .version("0.2.6");

registerSpawn(program);
registerList(program);
registerStatus(program);
registerSend(program);
registerKill(program);
registerAttach(program);
registerCleanup(program);
registerRestore(program);
registerDashboard(program);
registerStart(program);
registerWatch(program);
registerInit(program);
registerSetup(program);
registerMcpServer(program);
registerWebhook(program);
registerDoctor(program);
registerRetry(program);
registerTask(program);
registerFeedback(program);

if (process.argv.slice(2).length === 0) {
  process.argv.push("start", "--open");
}

program.parse();
