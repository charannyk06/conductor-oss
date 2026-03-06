import { type NextRequest, NextResponse } from "next/server";
import { readFile, writeFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import type { DashboardAccessConfig, DashboardRoleBindings } from "@conductor-oss/core/types";
import { getDashboardAccess, guardApiAccess, guardApiActionAccess } from "@/lib/auth";
import { getServices, invalidateServicesCache } from "@/lib/services";
import { normalizeRootProjectPaths } from "@/lib/projectConfigSync";

export const dynamic = "force-dynamic";

type MutableConfig = Record<string, unknown>;

type AccessPatchBody = {
  requireAuth?: unknown;
  defaultRole?: unknown;
  trustedHeaders?: unknown;
  roles?: unknown;
};

function toObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

function asOptionalRole(value: unknown): DashboardAccessConfig["defaultRole"] | undefined {
  if (value === "viewer" || value === "operator" || value === "admin") {
    return value;
  }
  return undefined;
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value !== "string") return [];
  return value
    .split(/[\n,]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeRoles(value: unknown): DashboardRoleBindings | undefined {
  const root = toObject(value);
  const next: DashboardRoleBindings = {};

  const viewers = normalizeStringList(root["viewers"]);
  const operators = normalizeStringList(root["operators"]);
  const admins = normalizeStringList(root["admins"]);
  const viewerDomains = normalizeStringList(root["viewerDomains"]);
  const operatorDomains = normalizeStringList(root["operatorDomains"]);
  const adminDomains = normalizeStringList(root["adminDomains"]);

  if (viewers.length > 0) next.viewers = viewers;
  if (operators.length > 0) next.operators = operators;
  if (admins.length > 0) next.admins = admins;
  if (viewerDomains.length > 0) next.viewerDomains = viewerDomains;
  if (operatorDomains.length > 0) next.operatorDomains = operatorDomains;
  if (adminDomains.length > 0) next.adminDomains = adminDomains;

  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeAccessConfig(value: unknown): DashboardAccessConfig {
  const root = toObject(value);
  const trustedHeaders = toObject(root["trustedHeaders"]);
  const defaultRole = asOptionalRole(root["defaultRole"]);

  const next: DashboardAccessConfig = {
    requireAuth: root["requireAuth"] === true,
    trustedHeaders: {
      enabled: trustedHeaders["enabled"] === true,
      provider:
        trustedHeaders["provider"] === "generic"
          ? "generic"
          : "cloudflare-access",
      emailHeader:
        (typeof trustedHeaders["emailHeader"] === "string" && trustedHeaders["emailHeader"].trim().length > 0
          ? trustedHeaders["emailHeader"].trim()
          : "Cf-Access-Authenticated-User-Email"),
      jwtHeader:
        (typeof trustedHeaders["jwtHeader"] === "string" && trustedHeaders["jwtHeader"].trim().length > 0
          ? trustedHeaders["jwtHeader"].trim()
          : "Cf-Access-Jwt-Assertion"),
    },
  };

  if (typeof trustedHeaders["teamDomain"] === "string" && trustedHeaders["teamDomain"].trim().length > 0) {
    next.trustedHeaders!.teamDomain = trustedHeaders["teamDomain"].trim();
  }

  if (typeof trustedHeaders["audience"] === "string" && trustedHeaders["audience"].trim().length > 0) {
    next.trustedHeaders!.audience = trustedHeaders["audience"].trim();
  }

  if (defaultRole) {
    next.defaultRole = defaultRole;
  }

  const roles = normalizeRoles(root["roles"]);
  if (roles) {
    next.roles = roles;
  }

  return next;
}

export async function GET(request: NextRequest) {
  const denied = await guardApiAccess(request, "viewer");
  if (denied) return denied;

  try {
    const { config } = await getServices();
    const access = normalizeAccessConfig(config.access);
    const current = await getDashboardAccess(request);

    return NextResponse.json({
      access,
      current: {
        authenticated: current.authenticated,
        role: current.role ?? null,
        email: current.email ?? null,
        provider: current.provider ?? null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load access settings";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const denied = await guardApiAccess(request, "admin");
  if (denied) return denied;
  const deniedAction = guardApiActionAccess(request);
  if (deniedAction) return deniedAction;

  const body = (await request.json().catch(() => null)) as AccessPatchBody | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
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

    const nextAccess = normalizeAccessConfig(nextRoot["access"]);

    if (typeof body.requireAuth === "boolean") {
      nextAccess.requireAuth = body.requireAuth;
    }

    if (body.defaultRole !== undefined) {
      nextAccess.defaultRole = asOptionalRole(body.defaultRole);
    }

    if (body.trustedHeaders !== undefined) {
      const nextTrusted = toObject(body.trustedHeaders);
      nextAccess.trustedHeaders = {
        enabled: nextTrusted["enabled"] === true,
        emailHeader:
          (typeof nextTrusted["emailHeader"] === "string" && nextTrusted["emailHeader"].trim().length > 0
            ? nextTrusted["emailHeader"].trim()
            : "Cf-Access-Authenticated-User-Email"),
      };
    }

    if (body.roles !== undefined) {
      nextAccess.roles = normalizeRoles(body.roles);
    }

    nextRoot["access"] = nextAccess;
    await normalizeRootProjectPaths(nextRoot);

    const updatedYaml = stringify(nextRoot, { lineWidth: 0 });
    await writeFile(configPath, updatedYaml, "utf8");

    try {
      invalidateServicesCache("access updated");
      await getServices();
    } catch (err) {
      await writeFile(configPath, originalConfigRaw, "utf8");
      invalidateServicesCache("access update rollback");
      throw err;
    }

    const current = await getDashboardAccess(request);
    return NextResponse.json({
      access: nextAccess,
      current: {
        authenticated: current.authenticated,
        role: current.role ?? null,
        email: current.email ?? null,
        provider: current.provider ?? null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update access settings";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
