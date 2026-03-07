/**
 * Webhook Emitter -- fires HTTP POST to configured webhook endpoints
 * on session lifecycle events.
 *
 * Events include: session state changes, PR events, CI status, reviews.
 * Payload is signed with HMAC-SHA256 if a secret is configured.
 */

import { createHmac } from "node:crypto";
import type { OrchestratorEvent } from "./types.js";

export interface WebhookTarget {
  url: string;
  secret?: string;
  /** Event types to receive. Empty means all. */
  events?: string[];
}

export interface WebhookEmitterConfig {
  targets: WebhookTarget[];
  /** Request timeout in ms. Default: 10000. */
  timeoutMs?: number;
  /** Max retries on failure. Default: 2. */
  maxRetries?: number;
}

export interface WebhookEmitter {
  /** Send an event to all matching webhook targets. */
  fire(event: OrchestratorEvent): Promise<void>;
  /** Get delivery metrics. */
  metrics(): WebhookMetrics;
}

export interface WebhookMetrics {
  totalFired: number;
  totalSuccess: number;
  totalFailed: number;
  lastFailure?: { url: string; error: string; at: string };
}

function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function createWebhookEmitter(config: WebhookEmitterConfig): WebhookEmitter {
  const timeoutMs = config.timeoutMs ?? 10_000;
  const maxRetries = config.maxRetries ?? 2;

  let totalFired = 0;
  let totalSuccess = 0;
  let totalFailed = 0;
  let lastFailure: { url: string; error: string; at: string } | undefined;

  async function sendToTarget(target: WebhookTarget, payload: string): Promise<boolean> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "Conductor-OSS-Webhook/1.0",
    };

    if (target.secret) {
      headers["X-Conductor-Signature"] = `sha256=${signPayload(payload, target.secret)}`;
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(target.url, {
          method: "POST",
          headers,
          body: payload,
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (response.ok || response.status < 500) {
          return true;
        }

        // 5xx: retry
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      } catch (err) {
        if (attempt >= maxRetries) {
          const msg = err instanceof Error ? err.message : String(err);
          lastFailure = { url: target.url, error: msg, at: new Date().toISOString() };
          return false;
        }
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }

    return false;
  }

  return {
    async fire(event: OrchestratorEvent): Promise<void> {
      const payload = JSON.stringify({
        event: event.type,
        priority: event.priority,
        sessionId: event.sessionId,
        projectId: event.projectId,
        message: event.message,
        timestamp: event.timestamp.toISOString(),
        data: event.data,
      });

      const matchingTargets = config.targets.filter((t) => {
        if (!t.events || t.events.length === 0) return true;
        return t.events.includes(event.type);
      });

      for (const target of matchingTargets) {
        totalFired++;
        const ok = await sendToTarget(target, payload);
        if (ok) {
          totalSuccess++;
        } else {
          totalFailed++;
        }
      }
    },

    metrics(): WebhookMetrics {
      return { totalFired, totalSuccess, totalFailed, lastFailure };
    },
  };
}
