import type { AgentModelAccess } from "@conductor-oss/core/types";
import type { RuntimeAgentModelCatalog } from "../runtimeAgentModelsShared";
import {
  buildDefaultAccessRuntimeCatalog,
  readCommandHelp,
} from "./helpers";

export async function buildCursorRuntimeModelCatalog(): Promise<RuntimeAgentModelCatalog | null> {
  const help = await readCommandHelp(["cursor-agent", "cursor-cli", "cursor"]);
  if (!help) {
    return null;
  }

  const models = [
    {
      id: "gpt-5",
      label: "GPT-5",
      description: "Cursor Agent preset alias exposed by the local CLI.",
      access: ["default"] as AgentModelAccess[],
    },
    {
      id: "sonnet-4",
      label: "Sonnet 4",
      description: "Cursor Agent preset alias exposed by the local CLI.",
      access: ["default"] as AgentModelAccess[],
    },
    {
      id: "opus",
      label: "Opus",
      description: "Cursor Agent preset alias exposed by the local CLI.",
      access: ["default"] as AgentModelAccess[],
    },
  ];

  return buildDefaultAccessRuntimeCatalog("cursor-cli", models, {
    customModelPlaceholder: "gpt-5",
    defaultModel: "gpt-5",
  });
}
