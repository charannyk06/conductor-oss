import { openProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

export const POST = openProxyRoute("/api/github/webhook");
