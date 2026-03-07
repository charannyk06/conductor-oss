/**
 * Singleton accessor for the event bus in the web dashboard.
 *
 * The event bus is created once and stored on globalThis to survive
 * Next.js hot reloads in development. In production, module scope
 * provides the same guarantee.
 */

// EventBus type is defined in the event-bus module
interface EventBus {
  query(filter: Record<string, unknown>): Array<{
    id: string;
    type: string;
    priority: string;
    sessionId: string;
    projectId: string;
    message: string;
    timestamp: Date;
    data: Record<string, unknown>;
  }>;
  pending(): Array<Record<string, unknown>>;
  acknowledge(eventId: string): boolean;
  metrics(): {
    totalEmitted: number;
    bufferSize: number;
    maxBufferSize: number;
    subscriberCount: number;
    pendingCount: number;
  };
}

// Use globalThis to survive HMR in development
const globalForEventBus = globalThis as unknown as {
  __conductorEventBus?: EventBus;
};

/**
 * Get the shared event bus instance. Returns null if not yet initialized.
 * The event bus is initialized during service bootstrap (getServices).
 */
export function getEventBus(): EventBus | null {
  return globalForEventBus.__conductorEventBus ?? null;
}

/**
 * Set the shared event bus instance. Called during service initialization.
 */
export function setEventBus(bus: EventBus): void {
  globalForEventBus.__conductorEventBus = bus;
}
