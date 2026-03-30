import assert from "node:assert/strict";
import test from "node:test";
import { resolveAgentIconKey, resolveAgentIconSources } from "@/components/agentIconSources";

test("Hermes label resolves to the bundled Hermes logo", () => {
  assert.equal(resolveAgentIconKey({ label: "Hermes" }), "hermes");
  assert.deepEqual(resolveAgentIconSources({ label: "Hermes" }), ["/agents/hermes.png"]);
});

test("Hermes aliases resolve to the bundled Hermes logo", () => {
  assert.equal(resolveAgentIconKey({ label: "hermes-agent" }), "hermes");
  assert.deepEqual(
    resolveAgentIconSources({
      label: "Session",
      homepage: "https://hermes-agent.nousresearch.com/",
    }),
    ["/agents/hermes.png"],
  );
});

test("Known vector agents still prefer local themed assets before external icons", () => {
  assert.equal(resolveAgentIconKey({ label: "Codex" }), "codex");
  assert.deepEqual(
    resolveAgentIconSources({
      label: "Codex",
      iconUrl: "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/openai.svg",
    }),
    [
      "/agents/codex-dark.svg",
      "/agents/codex-light.svg",
      "https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/openai.svg",
    ],
  );
});
