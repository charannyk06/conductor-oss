/**
 * Spawn Limiter -- prevents burst-spawning too many agent sessions.
 *
 * Enforces a per-project and global concurrency ceiling on active spawns.
 * When the limit is hit, spawn requests are queued and processed in order.
 */

export interface SpawnLimiterConfig {
  /** Max concurrent spawns across all projects. Default: 3. */
  globalMax?: number;
  /** Max concurrent spawns per project. Default: 2. */
  perProjectMax?: number;
  /** Timeout for queued spawns in ms. Default: 120000 (2 min). */
  queueTimeoutMs?: number;
}

interface PendingSpawn {
  projectId: string;
  resolve: () => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  enqueuedAt: number;
}

export interface SpawnLimiterMetrics {
  globalActive: number;
  globalMax: number;
  perProjectActive: Record<string, number>;
  perProjectMax: number;
  queueLength: number;
  totalSpawned: number;
  totalTimedOut: number;
}

export interface SpawnLimiter {
  /**
   * Acquire a spawn slot. Resolves when a slot is available.
   * Rejects if the queue timeout is exceeded.
   */
  acquire(projectId: string): Promise<void>;

  /** Release a spawn slot after session creation completes or fails. */
  release(projectId: string): void;

  /** Get current limiter metrics. */
  metrics(): SpawnLimiterMetrics;

  /** Clear all pending requests (used during shutdown). */
  shutdown(): void;
}

export function createSpawnLimiter(config: SpawnLimiterConfig = {}): SpawnLimiter {
  const globalMax = config.globalMax ?? 3;
  const perProjectMax = config.perProjectMax ?? 2;
  const queueTimeoutMs = config.queueTimeoutMs ?? 120_000;

  let globalActive = 0;
  const perProjectActive = new Map<string, number>();
  const queue: PendingSpawn[] = [];
  let totalSpawned = 0;
  let totalTimedOut = 0;

  function getProjectActive(projectId: string): number {
    return perProjectActive.get(projectId) ?? 0;
  }

  function canAcquire(projectId: string): boolean {
    return globalActive < globalMax && getProjectActive(projectId) < perProjectMax;
  }

  function drainQueue(): void {
    while (queue.length > 0) {
      const next = queue[0];
      if (!canAcquire(next.projectId)) break;

      queue.shift();
      clearTimeout(next.timer);
      globalActive++;
      perProjectActive.set(next.projectId, getProjectActive(next.projectId) + 1);
      totalSpawned++;
      next.resolve();
    }
  }

  return {
    acquire(projectId: string): Promise<void> {
      if (canAcquire(projectId)) {
        globalActive++;
        perProjectActive.set(projectId, getProjectActive(projectId) + 1);
        totalSpawned++;
        return Promise.resolve();
      }

      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = queue.findIndex((p) => p.resolve === resolve);
          if (idx >= 0) queue.splice(idx, 1);
          totalTimedOut++;
          reject(new Error(
            `Spawn queue timeout for project "${projectId}" after ${queueTimeoutMs}ms. ` +
            `Global: ${globalActive}/${globalMax}, Project: ${getProjectActive(projectId)}/${perProjectMax}`
          ));
        }, queueTimeoutMs);

        queue.push({ projectId, resolve, reject, timer, enqueuedAt: Date.now() });
      });
    },

    release(projectId: string): void {
      if (globalActive > 0) globalActive--;
      const current = getProjectActive(projectId);
      if (current > 0) {
        perProjectActive.set(projectId, current - 1);
      }
      drainQueue();
    },

    metrics(): SpawnLimiterMetrics {
      const active: Record<string, number> = {};
      for (const [k, v] of perProjectActive) {
        if (v > 0) active[k] = v;
      }
      return {
        globalActive,
        globalMax,
        perProjectActive: active,
        perProjectMax,
        queueLength: queue.length,
        totalSpawned,
        totalTimedOut,
      };
    },

    shutdown(): void {
      for (const pending of queue) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Spawn limiter shutting down"));
      }
      queue.length = 0;
    },
  };
}
