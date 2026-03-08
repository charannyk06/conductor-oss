import { type NextRequest, NextResponse } from "next/server";
import { readFile, writeFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { normalizeProjectConfigMap, syncWorkspaceSupportFiles } from "@conductor-oss/core";
import { getServices, invalidateServicesCache } from "@/lib/services";
import { guardApiAccess, guardApiActionAccess } from "@/lib/auth";
import { normalizeRootProjectPaths } from "@/lib/projectConfigSync";

export const dynamic = "force-dynamic";

type MutableConfig = Record<string, unknown>;

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await guardApiAccess(request, "operator");
  if (denied) return denied;
  const deniedAction = guardApiActionAccess(request);
  if (deniedAction) return deniedAction;

  const { id } = await params;
  if (!id || id.trim().length === 0) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  try {
    const { config } = await getServices();
    const configPath = config.configPath;
    if (!configPath) {
      return NextResponse.json({ error: "Unable to resolve conductor config path" }, { status: 500 });
    }

    const originalConfigRaw = await readFile(configPath, "utf8");
    const parsed = (parse(originalConfigRaw) ?? {}) as MutableConfig;
    const nextRoot: MutableConfig =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? { ...parsed }
        : {};

    const nextProjects = normalizeProjectConfigMap(nextRoot["projects"]);
    if (!(id in nextProjects)) {
      return NextResponse.json({ error: `Unknown repository id: ${id}` }, { status: 404 });
    }

    delete nextProjects[id];
    nextRoot["projects"] = nextProjects;
    await normalizeRootProjectPaths(nextRoot);

    const updatedYaml = stringify(nextRoot, { lineWidth: 0 });
    await writeFile(configPath, updatedYaml, "utf8");

    try {
      invalidateServicesCache("repository unlinked");
      const { config: refreshedConfig, registry } = await getServices();
      syncWorkspaceSupportFiles(refreshedConfig, {
        agentNames: registry.list("agent").map((agent) => agent.name),
      });
    } catch (err) {
      await writeFile(configPath, originalConfigRaw, "utf8");
      invalidateServicesCache("repository unlink rollback");
      throw err;
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to unlink repository";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
