import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "yaml";
import { buildConductorYaml } from "../scaffold.js";

test("buildConductorYaml pre-populates dashboardUrl from the configured port", () => {
  const parsed = parse(buildConductorYaml({
    port: 4812,
    projects: [],
  })) as { dashboardUrl?: string };

  assert.equal(parsed.dashboardUrl, "http://localhost:4812");
});

test("buildConductorYaml persists model access preferences and project default model", () => {
  const parsed = parse(buildConductorYaml({
    preferences: {
      codingAgent: "codex",
      modelAccess: {
        codex: "api",
      },
    },
    projects: [
      {
        projectId: "repo",
        repo: "org/repo",
        path: "/tmp/repo",
        agent: "codex",
        defaultBranch: "main",
        agentModel: "gpt-5.2-codex",
      },
    ],
  })) as {
    preferences?: { modelAccess?: { codex?: string } };
    projects?: Record<string, { agentConfig?: { model?: string } }>;
  };

  assert.equal(parsed.preferences?.modelAccess?.codex, "api");
  assert.equal(parsed.projects?.["repo"]?.agentConfig?.model, "gpt-5.2-codex");
});

test("buildConductorYaml includes organization-friendly access defaults", () => {
  const parsed = parse(buildConductorYaml({
    projects: [],
  })) as {
    access?: {
      requireAuth?: boolean;
      defaultRole?: string;
      trustedHeaders?: {
        enabled?: boolean;
        provider?: string;
        emailHeader?: string;
        jwtHeader?: string;
      };
    };
  };

  assert.equal(parsed.access?.requireAuth, false);
  assert.equal(parsed.access?.defaultRole, "operator");
  assert.equal(parsed.access?.trustedHeaders?.enabled, false);
  assert.equal(parsed.access?.trustedHeaders?.provider, "cloudflare-access");
  assert.equal(parsed.access?.trustedHeaders?.emailHeader, "Cf-Access-Authenticated-User-Email");
  assert.equal(parsed.access?.trustedHeaders?.jwtHeader, "Cf-Access-Jwt-Assertion");
});
