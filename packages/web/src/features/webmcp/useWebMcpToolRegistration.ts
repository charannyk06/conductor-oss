"use client";

import { useEffect, useState } from "react";
import {
  detectWebMcpCompatibility,
  registerWebMcpTools,
  type WebMcpCompatibility,
  type WebMcpToolDefinition,
} from "@/lib/webmcp";

const UNSUPPORTED_COMPATIBILITY: WebMcpCompatibility = {
  supported: false,
  reason: "WebMCP compatibility has not been checked yet.",
  toolRegistrationAvailable: false,
  modelContext: null,
};

export function useWebMcpToolRegistration(tools: WebMcpToolDefinition[]): WebMcpCompatibility {
  const [compatibility, setCompatibility] = useState<WebMcpCompatibility>(UNSUPPORTED_COMPATIBILITY);

  useEffect(() => {
    if (typeof document === "undefined") {
      setCompatibility({
        supported: false,
        reason: "Document context is unavailable.",
        toolRegistrationAvailable: false,
        modelContext: null,
      });
      return undefined;
    }

    let stopped = false;
    let registrationInFlight = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let disposeRegistration: (() => void) | null = null;

    const updateCompatibility = (next: WebMcpCompatibility) => {
      setCompatibility((current) => (
        current.supported === next.supported
        && current.reason === next.reason
        && current.toolRegistrationAvailable === next.toolRegistrationAvailable
        && current.modelContext === next.modelContext
          ? current
          : next
      ));
    };

    const scheduleRetry = () => {
      if (!stopped) {
        retryTimer = setTimeout(() => void attemptRegistration(), 1_000);
      }
    };

    const attemptRegistration = async () => {
      if (stopped || registrationInFlight || disposeRegistration) {
        return;
      }
      const nextCompatibility = detectWebMcpCompatibility(document, navigator);
      if (!nextCompatibility.supported || !nextCompatibility.modelContext) {
        updateCompatibility(nextCompatibility);
        scheduleRetry();
        return;
      }

      registrationInFlight = true;
      updateCompatibility({
        ...nextCompatibility,
        supported: false,
        reason: "Registering browser-native WebMCP tools.",
      });
      try {
        const dispose = await registerWebMcpTools(nextCompatibility.modelContext, tools);
        if (stopped) {
          dispose();
          return;
        }
        disposeRegistration = dispose;
        updateCompatibility(nextCompatibility);
      } catch (error) {
        if (!stopped) {
          updateCompatibility({
            supported: false,
            reason: `WebMCP registration failed: ${error instanceof Error ? error.message : "Unknown error"}`,
            toolRegistrationAvailable: true,
            modelContext: nextCompatibility.modelContext,
          });
          scheduleRetry();
        }
      } finally {
        registrationInFlight = false;
      }
    };

    void attemptRegistration();

    return () => {
      stopped = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      disposeRegistration?.();
    };
  }, [tools]);

  return compatibility;
}
