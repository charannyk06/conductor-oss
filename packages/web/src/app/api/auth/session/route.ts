import { openProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const POST = openProxyRoute("/api/auth/session");
export const DELETE = openProxyRoute("/api/auth/session");
