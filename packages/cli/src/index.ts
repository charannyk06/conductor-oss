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

const program = new Command();

program
  .name("co")
  .description("Conductor — markdown-native AI agent orchestrator")
  .version("0.1.0");

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

program.parse();
