/**
 * Terminal Session
 *
 * Manages a single terminal session with PTY subprocess, headless emulator,
 * and history persistence. Implements snapshot boundary system for consistent state.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { HeadlessEmulator } from "./headless-emulator.js";
import {
	PtySubprocessIpcType,
	PtySubprocessFrameDecoder,
	type PtySubprocessFrame,
} from "./pty-subprocess-ipc.js";
import type { HistoryManager } from "./history-manager.js";
import type { TerminalSnapshot, TerminalModes } from "./types.js";

const SPAWN_TIMEOUT_MS = 10000;
const EMULATOR_WRITE_BUDGET_MS = 5;
const EMULATOR_WRITE_BUDGET_STRESSED_MS = 25;
const SNAPSHOT_FLUSH_INTERVAL_MS = 2000;

export interface SessionOptions {
	sessionId: string;
	cols: number;
	rows: number;
	shell: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	scrollback?: number;
	historyManager?: HistoryManager;
}

export interface SessionInfo {
	sessionId: string;
	pid: number;
	cols: number;
	rows: number;
	shell: string;
	cwd: string;
	startedAt: number;
	hasEmulator: boolean;
}

export interface SessionSnapshotWithBoundary {
	snapshot: TerminalSnapshot;
	processedItems: number;
	timestamp: number;
}

type OutputHandler = (data: Buffer) => void;
type ExitHandler = (exitCode: number, signal?: number) => void;

export class TerminalSession {
	private sessionId: string;
	private process: ChildProcess | null = null;
	private emulator: HeadlessEmulator | null = null;
	private historyManager: HistoryManager | null = null;
	private disposed = false;
	private started = false;

	private outputBuffer: Buffer[] = [];
	private outputBytesBuffered = 0;
	private emulatorWriteQueue: string[] = [];
	private emulatorWriteQueuedBytes = 0;
	private emulatorWriteScheduled = false;
	private emulatorWriteProcessedItems = 0;
	private snapshotBoundaryWaiters: Array<{
		id: number;
		targetProcessedItems: number;
		resolve: () => void;
	}> = [];
	private nextBoundaryWaiterId = 1;

	private outputHandlers: Set<OutputHandler> = new Set();
	private exitHandlers: Set<ExitHandler> = new Set();

	private lastSnapshot: TerminalSnapshot | null = null;
	private lastSnapshotTime = 0;
	private snapshotFlushTimer: NodeJS.Timeout | null = null;

	private cols: number;
	private rows: number;

	private readonly scrollback: number;
	private readonly shell: string;
	private readonly args: string[];
	private readonly cwd: string;
	private readonly env: Record<string, string>;

	constructor(options: SessionOptions) {
		this.sessionId = options.sessionId;
		this.cols = options.cols;
		this.rows = options.rows;
		this.scrollback = options.scrollback ?? 5000;
		this.shell = options.shell;
		this.args = options.args;
		this.cwd = options.cwd;
		this.env = options.env;
		this.historyManager = options.historyManager ?? null;

		this.emulator = new HeadlessEmulator({
			cols: options.cols,
			rows: options.rows,
			scrollback: this.scrollback,
		});
	}

	async spawn(nodePath: string, subprocessScript: string): Promise<number> {
		if (this.started) throw new Error("Session already started");
		this.started = true;

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error("PTY spawn timeout"));
				if (this.process) {
					this.process.kill("SIGKILL");
					this.process = null;
				}
			}, SPAWN_TIMEOUT_MS);

			const args: string[] = [subprocessScript];
			const child = spawn(nodePath, args, {
				stdio: ["pipe", "pipe", "inherit"],
				env: process.env,
			});

			this.process = child;
			let decoder: PtySubprocessFrameDecoder | null = null;

			child.on("error", (err) => {
				clearTimeout(timeout);
				reject(err);
			});

			child.stdout?.on("data", (chunk: Buffer) => {
				if (!decoder) {
					decoder = new PtySubprocessFrameDecoder();
				}
				const frames = decoder.push(chunk);
				for (const frame of frames) {
					this.handleFrame(frame);
				}
			});

			child.on("spawn", () => {
				clearTimeout(timeout);
				this.started = true;
			});

			child.on("exit", (code, signal) => {
				clearTimeout(timeout);
				this.handleExit(code ?? 0, signal ? signal : undefined);
				resolve(code ?? 0);
			});

			child.on("close", () => {
				clearTimeout(timeout);
			});

			child.stdin?.on("error", () => {
				// Ignore stdin errors during shutdown
			});

			const spawnPayload = Buffer.from(
				JSON.stringify({
					shell: this.shell,
					args: this.args,
					cwd: this.cwd,
					cols: this.cols,
					rows: this.rows,
					env: this.env,
				}),
			);
			this.writeFrame(PtySubprocessIpcType.Spawn, spawnPayload);
		});
	}

	private handleFrame(frame: PtySubprocessFrame): void {
		switch (frame.type) {
			case PtySubprocessIpcType.Ready:
				// Ready signal received
				break;

			case PtySubprocessIpcType.Spawned:
				// PID is in the payload
				break;

			case PtySubprocessIpcType.Data:
				this.handlePtyData(frame.payload);
				break;

			case PtySubprocessIpcType.Exit:
				this.handlePtyExit(frame.payload);
				break;

			case PtySubprocessIpcType.Error:
				console.error(
					`[TerminalSession ${this.sessionId}] Error: ${frame.payload.toString("utf8")}`,
				);
				break;
		}
	}

	private handlePtyData(data: Buffer): void {
		// Buffer for batching
		this.outputBuffer.push(data);
		this.outputBytesBuffered += data.length;

		// Queue for emulator
		const str = data.toString("utf8");
		this.emulatorWriteQueue.push(str);
		this.emulatorWriteQueuedBytes += str.length;

		if (!this.emulatorWriteScheduled) {
			this.emulatorWriteScheduled = true;
			setImmediate(() => this.processEmulatorQueue());
		}

		// Broadcast to handlers immediately
		for (const handler of this.outputHandlers) {
			try {
				handler(data);
			} catch {
				// Ignore handler errors
			}
		}
	}

	private processEmulatorQueue(): void {
		this.emulatorWriteScheduled = false;

		if (!this.emulator || this.emulatorWriteQueue.length === 0) return;

		const backlogBytes = this.emulatorWriteQueuedBytes;
		const baseBudgetMs =
			this.outputHandlers.size > 0
				? EMULATOR_WRITE_BUDGET_MS
				: EMULATOR_WRITE_BUDGET_STRESSED_MS;
		const budgetMs =
			backlogBytes > 1024 * 1024
				? Math.max(baseBudgetMs, EMULATOR_WRITE_BUDGET_STRESSED_MS)
				: baseBudgetMs;

		const start = performance.now();
		let processedCount = 0;
		const itemsToProcess = [...this.emulatorWriteQueue];
		this.emulatorWriteQueue = [];
		this.emulatorWriteQueuedBytes = 0;

		for (const chunk of itemsToProcess) {
			this.emulator.write(chunk);
			processedCount++;

			if (performance.now() - start > budgetMs) {
				break;
			}
		}

		this.emulatorWriteProcessedItems += processedCount;

		// Re-queue unprocessed items that were dropped when the budget was exceeded
		const remaining = itemsToProcess.slice(processedCount);
		if (remaining.length > 0) {
			this.emulatorWriteQueue.unshift(...remaining);
			this.emulatorWriteQueuedBytes += remaining.reduce((sum, c) => sum + c.length, 0);
			// Schedule another processing pass
			if (!this.emulatorWriteScheduled) {
				this.emulatorWriteScheduled = true;
				setImmediate(() => this.processEmulatorQueue());
			}
		}

		// Check boundary waiters
		this.checkBoundaryWaiters();

		// Schedule periodic snapshot
		this.scheduleSnapshotFlush();
	}

	private checkBoundaryWaiters(): void {
		const processed = this.emulatorWriteProcessedItems;
		const ready: Array<{ resolve: () => void }> = [];
		const remaining: typeof this.snapshotBoundaryWaiters = [];

		for (const waiter of this.snapshotBoundaryWaiters) {
			if (waiter.targetProcessedItems <= processed) {
				ready.push(waiter);
			} else {
				remaining.push(waiter);
			}
		}

		this.snapshotBoundaryWaiters = remaining;

		for (const { resolve } of ready) {
			resolve();
		}
	}

	waitForEmulatorBoundary(): Promise<void> {
		return new Promise((resolve) => {
			const id = this.nextBoundaryWaiterId++;
			this.snapshotBoundaryWaiters.push({
				id,
				targetProcessedItems: this.emulatorWriteProcessedItems + 1,
				resolve,
			});

			// Force queue processing if not scheduled
			if (!this.emulatorWriteScheduled && this.emulatorWriteQueue.length > 0) {
				this.emulatorWriteScheduled = true;
				setImmediate(() => this.processEmulatorQueue());
			}
		});
	}

	private handlePtyExit(payload: Buffer): void {
		const exitCode = payload.length >= 4 ? payload.readInt32LE(0) : 0;
		const signal = payload.length >= 8 ? payload.readInt32LE(4) : undefined;

		for (const handler of this.exitHandlers) {
			try {
				handler(exitCode, signal);
			} catch {
				// Ignore handler errors
			}
		}
	}

	private handleExit(code: number, signal?: NodeJS.Signals): void {
		void this.historyManager?.markEnded(this.sessionId);
	}

	private writeFrame(type: PtySubprocessIpcType, payload?: Buffer): boolean {
		if (!this.process?.stdin?.writable) return false;

		const header = Buffer.allocUnsafe(5);
		header.writeUInt8(type, 0);
		header.writeUInt32LE(payload?.length ?? 0, 1);

		try {
			this.process.stdin.write(header);
			if (payload && payload.length > 0) {
				this.process.stdin.write(payload);
			}
			return true;
		} catch {
			return false;
		}
	}

	write(data: Buffer): boolean {
		return this.writeFrame(PtySubprocessIpcType.Write, data);
	}

	resize(cols: number, rows: number): boolean {
		this.cols = cols;
		this.rows = rows;
		this.emulator?.resize(cols, rows);

		const payload = Buffer.allocUnsafe(8);
		payload.writeUInt32LE(cols, 0);
		payload.writeUInt32LE(rows, 4);
		return this.writeFrame(PtySubprocessIpcType.Resize, payload);
	}

	kill(signal: string = "SIGTERM"): void {
		this.writeFrame(PtySubprocessIpcType.Kill, Buffer.from(signal, "utf8"));
	}

	signal(signal: string = "SIGINT"): void {
		this.writeFrame(PtySubprocessIpcType.Signal, Buffer.from(signal, "utf8"));
	}

	async getSnapshot(): Promise<SessionSnapshotWithBoundary> {
		if (!this.emulator) {
			throw new Error("Session disposed");
		}

		await this.waitForEmulatorBoundary();

		const snapshot = await this.emulator.getSnapshotAsync();
		this.lastSnapshot = snapshot;
		this.lastSnapshotTime = Date.now();

		return {
			snapshot,
			processedItems: this.emulatorWriteProcessedItems,
			timestamp: this.lastSnapshotTime,
		};
	}

	getSnapshotSync(): TerminalSnapshot | null {
		return this.lastSnapshot;
	}

	private scheduleSnapshotFlush(): void {
		if (this.snapshotFlushTimer) return;

		this.snapshotFlushTimer = setTimeout(() => {
			this.snapshotFlushTimer = null;
			this.flushSnapshotToHistory().catch(() => {});
		}, SNAPSHOT_FLUSH_INTERVAL_MS);
	}

	private async flushSnapshotToHistory(): Promise<void> {
		if (!this.historyManager || !this.emulator) return;

		try {
			const snapshot = await this.getSnapshot();
			await this.historyManager.writeSnapshot(this.sessionId, {
				ansi: snapshot.snapshot.snapshotAnsi,
				modes: { ...snapshot.snapshot.modes } as Record<string, unknown>,
				cwd: snapshot.snapshot.cwd,
			});
		} catch {
			// Ignore flush errors
		}
	}

	getModes(): TerminalModes | null {
		return this.emulator?.getModes() ?? null;
	}

	getCwd(): string | null {
		return this.emulator?.getCwd() ?? null;
	}

	getDimensions(): { cols: number; rows: number } {
		return { cols: this.cols, rows: this.rows };
	}

	getInfo(): SessionInfo {
		return {
			sessionId: this.sessionId,
			pid: this.process?.pid ?? 0,
			cols: this.cols,
			rows: this.rows,
			shell: "unknown", // Would be set from spawn
			cwd: this.emulator?.getCwd() ?? "/",
			startedAt: Date.now(),
			hasEmulator: this.emulator !== null,
		};
	}

	onOutput(handler: OutputHandler): () => void {
		this.outputHandlers.add(handler);
		return () => this.outputHandlers.delete(handler);
	}

	onExit(handler: ExitHandler): () => void {
		this.exitHandlers.add(handler);
		return () => this.exitHandlers.delete(handler);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;

		if (this.snapshotFlushTimer) {
			clearTimeout(this.snapshotFlushTimer);
			this.snapshotFlushTimer = null;
		}

		// Flush final snapshot
		await this.flushSnapshotToHistory().catch(() => {});

		this.writeFrame(PtySubprocessIpcType.Dispose);

		if (this.emulator) {
			this.emulator.dispose();
			this.emulator = null;
		}

		this.process = null;
		this.outputHandlers.clear();
		this.exitHandlers.clear();
	}
}

export function createSession(options: SessionOptions): TerminalSession {
	return new TerminalSession(options);
}
