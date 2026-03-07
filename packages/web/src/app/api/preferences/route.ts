import { type NextRequest, NextResponse } from "next/server";
import { readFile, writeFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { syncWorkspaceSupportFiles, type UserPreferences } from "@conductor-oss/core";
import { getServices, invalidateServicesCache } from "@/lib/services";
import { guardApiAccess, guardApiActionAccess } from "@/lib/auth";
import { normalizeModelAccessPreferences } from "@/lib/modelAccess";
import { normalizeRootProjectPaths, syncAllProjectLocalConfigs } from "@/lib/projectConfigSync";

export const dynamic = "force-dynamic";

type MutableConfig = Record<string, unknown>;

type PreferencesPatchBody = {
  onboardingAcknowledged?: unknown;
  codingAgent?: unknown;
  ide?: unknown;
  remoteSshHost?: unknown;
  remoteSshUser?: unknown;
  markdownEditor?: unknown;
  modelAccess?: unknown;
  notifications?: unknown;
};

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

function normalizePreferences(
  value: unknown,
  fallbackAgent: string,
): UserPreferences {
  const root = toObject(value);
  const notifications = toObject(root["notifications"]);
  const soundFile = notifications["soundFile"];
  const remoteSshHost = asNonEmptyString(root["remoteSshHost"]);
  const remoteSshUser = asNonEmptyString(root["remoteSshUser"]);

  return {
    onboardingAcknowledged: root["onboardingAcknowledged"] === true,
    codingAgent: asNonEmptyString(root["codingAgent"]) ?? fallbackAgent,
    ide: asNonEmptyString(root["ide"]) ?? "vscode",
    ...(remoteSshHost ? { remoteSshHost } : {}),
    ...(remoteSshUser ? { remoteSshUser } : {}),
    markdownEditor: asNonEmptyString(root["markdownEditor"]) ?? "obsidian",
    modelAccess: normalizeModelAccessPreferences(root["modelAccess"]),
    notifications: {
      soundEnabled: notifications["soundEnabled"] !== false,
      soundFile: soundFile === null
        ? null
        : asNonEmptyString(soundFile) ?? "abstract-sound-4",
    },
  };
}

export async function GET() {
  const denied = await guardApiAccess(undefined, "viewer");
  if (denied) return denied;

  try {
    const { config } = await getServices();
    const fallbackAgent = config.defaults.agent;
    const preferences = normalizePreferences(config.preferences, fallbackAgent);
    return NextResponse.json({ preferences });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load preferences";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const denied = await guardApiAccess(request, "operator");
  if (denied) return denied;
  const deniedAction = guardApiActionAccess(request);
  if (deniedAction) return deniedAction;

  const body = (await request.json().catch(() => null)) as PreferencesPatchBody | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const { config } = await getServices();
    const configPath = config.configPath;
    if (!configPath) {
      return NextResponse.json(
        { error: "Unable to resolve conductor config path" },
        { status: 500 },
      );
    }

    const originalConfigRaw = await readFile(configPath, "utf8");
    const parsed = (parse(originalConfigRaw) ?? {}) as MutableConfig;
    const nextRoot: MutableConfig =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? { ...parsed }
        : {};

    const nextPreferences = normalizePreferences(
      nextRoot["preferences"],
      config.defaults.agent,
    );

    if (typeof body.onboardingAcknowledged === "boolean") {
      nextPreferences.onboardingAcknowledged = body.onboardingAcknowledged;
    }

    if (body.codingAgent !== undefined) {
      const value = asNonEmptyString(body.codingAgent);
      if (value) nextPreferences.codingAgent = value;
    }

    if (body.ide !== undefined) {
      const value = asNonEmptyString(body.ide);
      if (value) nextPreferences.ide = value;
    }

    if (body.remoteSshHost !== undefined) {
      const value = asNonEmptyString(body.remoteSshHost);
      if (value) {
        nextPreferences.remoteSshHost = value;
      } else {
        delete nextPreferences.remoteSshHost;
      }
    }

    if (body.remoteSshUser !== undefined) {
      const value = asNonEmptyString(body.remoteSshUser);
      if (value) {
        nextPreferences.remoteSshUser = value;
      } else {
        delete nextPreferences.remoteSshUser;
      }
    }

    if (body.markdownEditor !== undefined) {
      const value = asNonEmptyString(body.markdownEditor);
      if (value) nextPreferences.markdownEditor = value;
    }

    if (body.modelAccess !== undefined) {
      nextPreferences.modelAccess = normalizeModelAccessPreferences(body.modelAccess);
    }

    if (body.notifications !== undefined) {
      const notificationsPatch = toObject(body.notifications);
      if (typeof notificationsPatch["soundEnabled"] === "boolean") {
        nextPreferences.notifications.soundEnabled = notificationsPatch["soundEnabled"];
      }
      if (notificationsPatch["soundFile"] === null) {
        nextPreferences.notifications.soundFile = null;
      } else {
        const soundFile = asNonEmptyString(notificationsPatch["soundFile"]);
        if (soundFile) {
          nextPreferences.notifications.soundFile = soundFile;
        }
      }
    }

    nextRoot["preferences"] = nextPreferences;
    await normalizeRootProjectPaths(nextRoot);

    const updatedYaml = stringify(nextRoot, {
      lineWidth: 0,
    });

    await writeFile(configPath, updatedYaml, "utf8");

    try {
      invalidateServicesCache("preferences updated");
      const { config: refreshedConfig, registry } = await getServices();
      await syncAllProjectLocalConfigs(refreshedConfig as unknown as Record<string, unknown>);
      syncWorkspaceSupportFiles(refreshedConfig, {
        agentNames: registry.list("agent").map((agent) => agent.name),
      });
    } catch (err) {
      await writeFile(configPath, originalConfigRaw, "utf8");
      invalidateServicesCache("preferences update rollback");
      throw err;
    }

    return NextResponse.json({ preferences: nextPreferences });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update preferences";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
