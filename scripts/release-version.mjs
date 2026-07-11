#!/usr/bin/env node

import { readFileSync } from "node:fs";

import { detectReleaseBump, highestStableRegistryVersion } from "./release-workflow-lib.mjs";

const command = process.argv[2];
const input = readFileSync(0, "utf8");

if (command === "highest") {
  process.stdout.write(`${highestStableRegistryVersion(input)}\n`);
} else if (command === "bump") {
  process.stdout.write(`${detectReleaseBump(input)}\n`);
} else {
  throw new Error("usage: release-version.mjs <highest|bump>");
}
