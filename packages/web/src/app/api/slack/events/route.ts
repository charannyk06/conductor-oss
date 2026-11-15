import { openProxyRoute } from "@/lib/proxyRoutes";

export const dynamic = "force-dynamic";

// Public Slack Events API webhook. The Rust backend verifies the Slack
// signature against the raw body, so the body and the x-slack-* headers are
// forwarded untouched.
export const POST = openProxyRoute("/api/slack/events");
