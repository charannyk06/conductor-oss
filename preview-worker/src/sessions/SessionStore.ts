import type { PreviewSession } from "../lib/types.js";

type SessionLock = {
  active: boolean;
  waiters: Array<() => void>;
};

export class SessionStore {
  private readonly sessions = new Map<string, PreviewSession>();
  private readonly locks = new Map<string, SessionLock>();

  constructor(private readonly sessionTimeoutMs: number) {}

  count(): number {
    return this.sessions.size;
  }

  countByApiKey(apiKey: string): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.apiKey === apiKey) {
        count += 1;
      }
    }
    return count;
  }

  list(): PreviewSession[] {
    return [...this.sessions.values()];
  }

  findByApiKeyAndClientSessionId(apiKey: string, clientSessionId: string): PreviewSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.apiKey === apiKey && session.clientSessionId === clientSessionId) {
        return session;
      }
    }
    return undefined;
  }

  get(sessionId: string): PreviewSession | undefined {
    return this.sessions.get(sessionId);
  }

  set(session: PreviewSession): void {
    this.sessions.set(session.id, session);
  }

  delete(sessionId: string): boolean {
    const deleted = this.sessions.delete(sessionId);
    const lock = this.locks.get(sessionId);
    if (deleted && lock && !lock.active && lock.waiters.length === 0) {
      this.locks.delete(sessionId);
    }
    return deleted;
  }

  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.lastActivityAt = Date.now();
  }

  isExpired(session: PreviewSession, now = Date.now()): boolean {
    return now - session.lastActivityAt > this.sessionTimeoutMs;
  }

  getExpiredSessions(now = Date.now()): PreviewSession[] {
    return this.list().filter((session) => this.isExpired(session, now));
  }

  async runExclusive<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const lock = this.getLock(sessionId);
    await this.acquire(lock);

    try {
      return await task();
    } finally {
      this.release(sessionId, lock);
    }
  }

  private getLock(sessionId: string): SessionLock {
    const existing = this.locks.get(sessionId);
    if (existing) {
      return existing;
    }

    const created: SessionLock = { active: false, waiters: [] };
    this.locks.set(sessionId, created);
    return created;
  }

  private async acquire(lock: SessionLock): Promise<void> {
    if (!lock.active) {
      lock.active = true;
      return;
    }

    await new Promise<void>((resolve) => lock.waiters.push(resolve));
    lock.active = true;
  }

  private release(sessionId: string, lock: SessionLock): void {
    lock.active = false;
    const next = lock.waiters.shift();
    if (next) {
      next();
      return;
    }

    if (!this.sessions.has(sessionId)) {
      this.locks.delete(sessionId);
    }
  }
}
