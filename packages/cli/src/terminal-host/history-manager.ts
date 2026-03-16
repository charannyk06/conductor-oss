/**
 * Terminal History Manager
 *
 * Persists terminal scrollback to disk for crash recovery and session restoration.
 * Inspired by Superset's history persistence system.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { promisify } from "node:util";
import { rm } from "node:fs/promises";

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);
const unlink = promisify(fs.unlink);
const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);

export interface HistoryMetadata {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
  cols: number;
  rows: number;
  shell: string;
  cwd: string;
}

export interface HistoryFile {
  metaPath: string;
  dataPath: string;
  metadata: HistoryMetadata;
}

const HISTORY_DIR = "terminal-history";
const MAX_HISTORY_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_HISTORY_FILES = 100;

export class HistoryManager {
  private baseDir: string;
  private writeQueue: Map<string, { data: Buffer; callback?: () => void }> = new Map();
  private writeScheduled = false;
  private writeInProgress = false;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  async init(): Promise<void> {
    const historyDir = path.join(this.baseDir, HISTORY_DIR);
    try {
      await mkdir(historyDir, { recursive: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    await this.pruneOldHistory();
  }

  private getSessionDir(sessionId: string): string {
    const safeId = this.sanitizeSessionId(sessionId);
    return path.join(this.baseDir, HISTORY_DIR, safeId);
  }

  private sanitizeSessionId(sessionId: string): string {
    const hash = crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
    return `${sessionId.replace(/[^a-zA-Z0-9-_]/g, "_").slice(0, 32)}_${hash}`;
  }

  async writeMetadata(sessionId: string, metadata: Partial<HistoryMetadata>): Promise<void> {
    const sessionDir = this.getSessionDir(sessionId);
    const metaPath = path.join(sessionDir, "metadata.json");

    let existing: HistoryMetadata | null = null;
    try {
      const content = await readFile(metaPath, "utf8");
      existing = JSON.parse(content) as HistoryMetadata;
    } catch {
      // New session
    }

    const updated: HistoryMetadata = {
      sessionId,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      cols: metadata.cols ?? existing?.cols ?? 80,
      rows: metadata.rows ?? existing?.rows ?? 24,
      shell: metadata.shell ?? existing?.shell ?? "unknown",
      cwd: metadata.cwd ?? existing?.cwd ?? "/",
      endedAt: metadata.endedAt ?? existing?.endedAt,
    };

    await mkdir(sessionDir, { recursive: true });
    await writeFile(metaPath, JSON.stringify(updated, null, 2));
  }

  async appendOutput(sessionId: string, data: Buffer): Promise<void> {
    const existing = this.writeQueue.get(sessionId);
    if (existing) {
      existing.data = Buffer.concat([existing.data, data]);
    } else {
      this.writeQueue.set(sessionId, {
        data,
        callback: undefined,
      });
    }

    if (!this.writeScheduled && !this.writeInProgress) {
      this.writeScheduled = true;
      setImmediate(() => this.flushWriteQueue());
    }
  }

  private async flushWriteQueue(): Promise<void> {
    this.writeScheduled = false;
    if (this.writeInProgress) return;

    this.writeInProgress = true;
    const pending = new Map(this.writeQueue);
    this.writeQueue.clear();

    try {
      await Promise.all(
        Array.from(pending.entries()).map(async ([sessionId, { data }]) => {
          const sessionDir = this.getSessionDir(sessionId);
          const dataPath = path.join(sessionDir, "output.bin");

          await mkdir(sessionDir, { recursive: true });
          await writeFile(dataPath, data, { flag: "a" });
        }),
      );
    } finally {
      this.writeInProgress = false;

      if (this.writeQueue.size > 0 && !this.writeScheduled) {
        this.writeScheduled = true;
        setImmediate(() => this.flushWriteQueue());
      }
    }
  }

  async readOutput(sessionId: string): Promise<Buffer> {
    await this.flushWriteQueue();

    const sessionDir = this.getSessionDir(sessionId);
    const dataPath = path.join(sessionDir, "output.bin");

    try {
      return await readFile(dataPath);
    } catch {
      return Buffer.alloc(0);
    }
  }

  async readScrollback(
    sessionId: string,
    maxBytes: number = 2 * 1024 * 1024,
  ): Promise<Buffer> {
    const full = await this.readOutput(sessionId);
    if (full.length <= maxBytes) return full;
    return full.subarray(full.length - maxBytes);
  }

  async readMetadata(sessionId: string): Promise<HistoryMetadata | null> {
    const sessionDir = this.getSessionDir(sessionId);
    const metaPath = path.join(sessionDir, "metadata.json");

    try {
      const content = await readFile(metaPath, "utf8");
      return JSON.parse(content) as HistoryMetadata;
    } catch {
      return null;
    }
  }

  async markEnded(sessionId: string): Promise<void> {
    await this.writeMetadata(sessionId, { endedAt: Date.now() });
  }

  async deleteSession(sessionId: string): Promise<void> {
    const sessionDir = this.getSessionDir(sessionId);
    try {
      await rm(sessionDir, { recursive: true, force: true }).catch(() => {});
    } catch {
      // Ignore errors
    }
  }

  async writeSnapshot(
    sessionId: string,
    snapshot: { ansi: string; modes: Record<string, unknown>; cwd?: string | null },
  ): Promise<void> {
    const sessionDir = this.getSessionDir(sessionId);
    const snapshotPath = path.join(sessionDir, "snapshot.json");

    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      snapshotPath,
      JSON.stringify({
        ...snapshot,
        timestamp: Date.now(),
      }),
    );
  }

  async readSnapshot(
    sessionId: string,
  ): Promise<{
    ansi: string;
    modes: Record<string, unknown>;
    cwd?: string | null;
    timestamp: number;
  } | null> {
    const sessionDir = this.getSessionDir(sessionId);
    const snapshotPath = path.join(sessionDir, "snapshot.json");

    try {
      const content = await readFile(snapshotPath, "utf8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  private async pruneOldHistory(): Promise<void> {
    const historyDir = path.join(this.baseDir, HISTORY_DIR);
    let entries: string[];

    try {
      entries = await readdir(historyDir);
    } catch {
      return;
    }

    const now = Date.now();
    const sessions: Array<{ name: string; mtime: number; path: string }> = [];

    for (const name of entries) {
      const fullPath = path.join(historyDir, name);
      try {
        const s = await stat(fullPath);
        if (s.isDirectory()) {
          sessions.push({ name, mtime: s.mtimeMs, path: fullPath });
        }
      } catch {
        // Ignore errors
      }
    }

    for (const session of sessions) {
      if (now - session.mtime > MAX_HISTORY_AGE_MS) {
        await this.deleteSession(session.name).catch(() => {});
        continue;
      }

      const metaPath = path.join(session.path, "metadata.json");
      try {
        const content = await readFile(metaPath, "utf8");
        const meta = JSON.parse(content) as HistoryMetadata;
        if (meta.endedAt && now - meta.endedAt > MAX_HISTORY_AGE_MS) {
          await this.deleteSession(session.name).catch(() => {});
        }
      } catch {
        // No metadata, check age of dir
        if (now - session.mtime > MAX_HISTORY_AGE_MS) {
          await this.deleteSession(session.name).catch(() => {});
        }
      }
    }

    if (sessions.length > MAX_HISTORY_FILES) {
      const sorted = sessions.sort((a, b) => b.mtime - a.mtime);
      const toDelete = sorted.slice(MAX_HISTORY_FILES);
      for (const session of toDelete) {
        await this.deleteSession(session.name).catch(() => {});
      }
    }
  }

  async listSessions(): Promise<string[]> {
    const historyDir = path.join(this.baseDir, HISTORY_DIR);
    try {
      const entries = await readdir(historyDir);
      return entries.filter((name) => {
        try {
          const metaPath = path.join(historyDir, name, "metadata.json");
          return fs.existsSync(metaPath);
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
  }
}

export function createHistoryManager(baseDir: string): HistoryManager {
  return new HistoryManager(baseDir);
}
