#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { buildReleaseEntry, buildReleaseMarkdown } from "./release-notes-lib.mjs";

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const part = argv[index];
    if (!part.startsWith("--")) continue;
    args.set(part.slice(2), argv[index + 1]);
    index += 1;
  }
  return args;
}

function run(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function getPreviousTag(currentTag) {
  const tags = run("git", ["tag", "--sort=-v:refname"])
    .split("\n")
    .map((tag) => tag.trim())
    .filter(Boolean);
  const currentIndex = tags.indexOf(currentTag);
  if (currentIndex >= 0) {
    return tags[currentIndex + 1] ?? "";
  }
  return tags.find((tag) => tag !== currentTag) ?? "";
}

function getCommitSubjects(previousTag, currentTag) {
  const range = previousTag ? `${previousTag}..${currentTag}` : currentTag;
  const output = run("git", ["log", "--first-parent", "--reverse", "--pretty=format:%s", range]);
  return output ? output.split("\n").map((line) => line.trim()).filter(Boolean) : [];
}

function extractPullNumbers(subjects) {
  const numbers = [];
  const seen = new Set();

  for (const subject of subjects) {
    const match =
      subject.match(/\(#(\d+)\)\s*$/)
      ?? subject.match(/^Merge pull request #(\d+)/)
      ?? subject.match(/\(#(\d+)\)/);
    const number = match?.[1];
    if (!number || seen.has(number)) continue;
    seen.add(number);
    numbers.push(number);
  }

  return numbers;
}

function fetchPr(repo, number) {
  return JSON.parse(
    run("gh", [
      "pr",
      "view",
      String(number),
      "--repo",
      repo,
      "--json",
      "number,title,body,url",
    ]),
  );
}

const args = parseArgs(process.argv.slice(2));
const repo = args.get("repo");
const currentTag = args.get("current-tag");

if (!repo || !currentTag) {
  console.error("usage: node scripts/generate-release-notes.mjs --repo owner/name --current-tag v1.2.3");
  process.exit(1);
}

const previousTag = getPreviousTag(currentTag);
const pullNumbers = extractPullNumbers(getCommitSubjects(previousTag, currentTag));
const entries = pullNumbers.map((number) => buildReleaseEntry(fetchPr(repo, number)));
const markdown = buildReleaseMarkdown({
  currentTag,
  entries,
  previousTag,
  repo,
});

process.stdout.write(markdown);
