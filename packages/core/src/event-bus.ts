/**
 * Event Bus -- central event stream for session lifecycle signals.
 *
 * Captures events from the lifecycle manager and provides a queryable
 * buffer plus a subscription API for real-time consumers (SSE, webhooks).
 */

import type { OrchestratorEvent, EventType, EventPriority } from "./types.js";

export interface EventFilter {
  sessionId?: string;
  projectId?: string;
  type?: EventType;
  priority?: EventPriority;
  since?: Date;
  limit?: number;
}

export interface EventSubscriber {
  id: string;
  filter?: EventFilter;
  callback: (event: OrchestratorEvent) => void;
}

export interface EventBus {
  /** Push an event into the bus. */
  emit(event: OrchestratorEvent): void;

  /** Query recent events matching a filter. */
  query(filter: EventFilter): OrchestratorEvent[];

  /** Subscribe to real-time events. Returns unsubscribe function. */
  subscribe(subscriber: EventSubscriber): () => void;

  /** Get pending attention events (unacknowledged urgent/action events). */
  pending(): OrchestratorEvent[];

  /** Acknowledge an event by ID (removes from pending). */
  acknowledge(eventId: string): boolean;

  /** Get bus metrics. */
  metrics(): EventBusMetrics;

  /** Clear all events and subscribers. */
  clear(): void;
}

export interface EventBusMetrics {
  totalEmitted: number;
  bufferSize: number;
  maxBufferSize: number;
  subscriberCount: number;
  pendingCount: number;
}

export interface EventBusConfig {
  /** Max events to retain in buffer. Default: 500. */
  maxBufferSize?: number;
}

export function createEventBus(config: EventBusConfig = {}): EventBus {
  const maxBufferSize = config.maxBufferSize ?? 500;
  const buffer: OrchestratorEvent[] = [];
  const subscribers = new Map<string, EventSubscriber>();
  const acknowledged = new Set<string>();
  let totalEmitted = 0;

  function matchesFilter(event: OrchestratorEvent, filter?: EventFilter): boolean {
    if (!filter) return true;
    if (filter.sessionId && event.sessionId !== filter.sessionId) return false;
    if (filter.projectId && event.projectId !== filter.projectId) return false;
    if (filter.type && event.type !== filter.type) return false;
    if (filter.priority && event.priority !== filter.priority) return false;
    if (filter.since && event.timestamp < filter.since) return false;
    return true;
  }

  return {
    emit(event: OrchestratorEvent): void {
      buffer.push(event);
      totalEmitted++;

      // Trim buffer if over max
      while (buffer.length > maxBufferSize) {
        const removed = buffer.shift();
        if (removed) acknowledged.delete(removed.id);
      }

      // Notify subscribers
      for (const sub of subscribers.values()) {
        if (matchesFilter(event, sub.filter)) {
          try {
            sub.callback(event);
          } catch {
            // Subscriber error should not break the bus
          }
        }
      }
    },

    query(filter: EventFilter): OrchestratorEvent[] {
      let results = buffer.filter((e) => matchesFilter(e, filter));
      if (filter.limit && results.length > filter.limit) {
        results = results.slice(-filter.limit);
      }
      return results;
    },

    subscribe(subscriber: EventSubscriber): () => void {
      subscribers.set(subscriber.id, subscriber);
      return () => {
        subscribers.delete(subscriber.id);
      };
    },

    pending(): OrchestratorEvent[] {
      const urgentPriorities = new Set<EventPriority>(["urgent", "action"]);
      return buffer.filter(
        (e) => urgentPriorities.has(e.priority) && !acknowledged.has(e.id),
      );
    },

    acknowledge(eventId: string): boolean {
      const exists = buffer.some((e) => e.id === eventId);
      if (exists) {
        acknowledged.add(eventId);
        return true;
      }
      return false;
    },

    metrics(): EventBusMetrics {
      const urgentPriorities = new Set<EventPriority>(["urgent", "action"]);
      return {
        totalEmitted,
        bufferSize: buffer.length,
        maxBufferSize,
        subscriberCount: subscribers.size,
        pendingCount: buffer.filter(
          (e) => urgentPriorities.has(e.priority) && !acknowledged.has(e.id),
        ).length,
      };
    },

    clear(): void {
      buffer.length = 0;
      subscribers.clear();
      acknowledged.clear();
      totalEmitted = 0;
    },
  };
}
