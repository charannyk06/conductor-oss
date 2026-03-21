import { guardedProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const GET = guardedProxyRoute("/api/github/repos", { role: "operator", bridgeAware: true });
