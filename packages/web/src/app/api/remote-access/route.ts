import { type NextRequest, NextResponse } from "next/server";
import {
  getDashboardConfigSnapshot,
  guardApiAccess,
  guardApiActionAccess,
} from "@/lib/auth";
import {
  disableManagedRemoteAccess,
  enableManagedRemoteAccess,
  getManagedRemoteAccessStatus,
  type ManagedRemoteAccessStatus,
} from "@/lib/remoteAccessManager";
import {
  resolveRemoteAccessSummary,
  resolveRequestPublicUrl,
} from "@/lib/remoteAccess";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RemoteAccessAction = "enable";

function buildRemoteAccessPayload(
  request: Request,
  remoteStatus: ManagedRemoteAccessStatus,
): Record<string, unknown> {
  const dashboardConfig = getDashboardConfigSnapshot();
  const runtimeState = remoteStatus.state;
  const summary = resolveRemoteAccessSummary({
    access: dashboardConfig.access,
    clerkConfigured: Boolean(
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY,
    ),
    configuredPublicUrl: runtimeState?.publicUrl
      || process.env.CONDUCTOR_PUBLIC_DASHBOARD_URL?.trim()
      || (
        dashboardConfig.access?.trustedHeaders?.enabled === true
        && dashboardConfig.access?.trustedHeaders?.provider !== "generic"
        && dashboardConfig.access?.trustedHeaders?.teamDomain?.trim()
        && dashboardConfig.access?.trustedHeaders?.audience?.trim()
          ? dashboardConfig.dashboardUrl
          : null
      ),
    managedProvider: runtimeState?.provider ?? null,
    observedPublicUrl: resolveRequestPublicUrl(request),
    preferredProvider: remoteStatus.recommendedProvider,
    preferredProviderConnected: remoteStatus.connected,
  });

  return {
    ...summary,
    status: runtimeState?.status ?? "disabled",
    provider: runtimeState?.provider ?? null,
    recommendedProvider: remoteStatus.recommendedProvider,
    localUrl: runtimeState?.localUrl ?? null,
    managed: runtimeState?.provider === "tailscale",
    installed: remoteStatus.installed,
    connected: remoteStatus.connected,
    canAutoInstall: remoteStatus.canAutoInstall,
    autoInstallMethod: remoteStatus.autoInstallMethod,
    lastError: runtimeState?.lastError ?? null,
    startedAt: runtimeState?.startedAt ?? null,
    updatedAt: runtimeState?.updatedAt ?? null,
  };
}

export async function GET(request: Request): Promise<Response> {
  const denied = await guardApiAccess(request, "admin");
  if (denied) return denied;

  const remoteStatus = await getManagedRemoteAccessStatus();
  return NextResponse.json(buildRemoteAccessPayload(request, remoteStatus));
}

export async function POST(request: NextRequest): Promise<Response> {
  const denied = await guardApiAccess(request, "admin");
  if (denied) return denied;
  const deniedAction = guardApiActionAccess(request);
  if (deniedAction) return deniedAction;

  const payload = await request.json().catch(() => null) as { action?: unknown } | null;
  const action = payload?.action;
  if (action !== "enable") {
    return NextResponse.json(
      { error: "Unsupported remote access action." },
      { status: 400 },
    );
  }
  try {
    const nextStatus = await enableManagedRemoteAccess();
    return NextResponse.json(buildRemoteAccessPayload(request, nextStatus));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Remote access action failed." },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest): Promise<Response> {
  const denied = await guardApiAccess(request, "admin");
  if (denied) return denied;
  const deniedAction = guardApiActionAccess(request);
  if (deniedAction) return deniedAction;

  try {
    const remoteStatus = await disableManagedRemoteAccess();
    return NextResponse.json(buildRemoteAccessPayload(request, remoteStatus));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Remote access action failed." },
      { status: 500 },
    );
  }
}
