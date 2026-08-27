import type { Metadata } from "next";
import { WebMcpDemoPage } from "@/features/webmcp/WebMcpDemoPage";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Conductor WebMCP Challenge Demo",
  description: "A browser-native WebMCP control surface for inspecting and coordinating bounded AI coding-agent work with explicit human approval.",
};

export default function WebMcpPage() {
  return <WebMcpDemoPage />;
}
