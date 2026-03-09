#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { validatePrDescription } from "./release-notes-lib.mjs";

const eventPath = process.env["GITHUB_EVENT_PATH"];

if (!eventPath) {
  console.error("GITHUB_EVENT_PATH is required.");
  process.exit(1);
}

const payload = JSON.parse(readFileSync(eventPath, "utf8"));
const pr = payload.pull_request;

if (!pr) {
  console.log("No pull request payload found. Skipping PR description validation.");
  process.exit(0);
}

const result = validatePrDescription({
  title: pr.title ?? "",
  body: pr.body ?? "",
});

if (result.errors.length > 0) {
  console.error("PR description validation failed:");
  for (const error of result.errors) {
    console.error(`- ${error}`);
  }
  console.error("");
  console.error("Expected pattern:");
  console.error("## User-Facing Release Notes");
  console.error("- You can now...");
  console.error("");
  console.error("If there is no user-facing change, use:");
  console.error("N/A - internal maintenance only");
  process.exit(1);
}

if (result.releaseNotes.internalOnly) {
  console.log("PR description validated: internal-only change documented.");
} else {
  console.log(`PR description validated: ${result.releaseNotes.notes.length} user-facing release note bullet(s) found.`);
}
