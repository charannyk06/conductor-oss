import assert from "node:assert/strict";
import test from "node:test";
import { filterGitHubRepos, type GitHubRepo } from "./githubRepos";

const repos: GitHubRepo[] = Array.from({ length: 8 }, (_, index) => ({
  name: `repo-${index + 1}`,
  fullName: `octo/repo-${index + 1}`,
  httpsUrl: `https://github.com/octo/repo-${index + 1}.git`,
  sshUrl: `git@github.com:octo/repo-${index + 1}.git`,
  defaultBranch: index === 7 ? "develop" : "main",
  private: index % 2 === 0,
  description: index === 4 ? "Task orchestration" : null,
  updatedAt: `2026-03-${String(index + 1).padStart(2, "0")}T12:00:00Z`,
  ownerLogin: index === 5 ? "automation-team" : "octo",
  permission: "WRITE",
}));

test("filterGitHubRepos returns the full list when the search is empty", () => {
  const filtered = filterGitHubRepos(repos, "   ");
  assert.equal(filtered.length, repos.length);
  assert.deepEqual(
    filtered.map((repo) => repo.fullName),
    repos.map((repo) => repo.fullName),
  );
});

test("filterGitHubRepos matches repositories by owner, description, and branch", () => {
  assert.deepEqual(
    filterGitHubRepos(repos, "automation-team").map((repo) => repo.fullName),
    ["octo/repo-6"],
  );
  assert.deepEqual(
    filterGitHubRepos(repos, "task orchestration").map((repo) => repo.fullName),
    ["octo/repo-5"],
  );
  assert.deepEqual(
    filterGitHubRepos(repos, "develop").map((repo) => repo.fullName),
    ["octo/repo-8"],
  );
});
