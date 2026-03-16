import { spawn, type ChildProcess } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { HeadlessEmulator } from "./terminal-host/headless-emulator.js";
import { type TerminalSnapshot } from "./terminal-host/types.js";
import {
	createFrameHeader,
	PtySubprocessFrameDecoder,
	PtySubprocessIpcType,
} from "./terminal-host/pty-subprocess-ipc.js";

// Protocols
const DETACHED_PTY_PROTOCOL_VERSION = 1;
const DETACHED_STREAM_FRAME_HEADER_BYTES = 13;

type NodeLaunchTarget = {
	cmd: string;
	args: string[];
};

enum DetachedPtyStreamFrameKind {
	Data = 1,
	Exit = 2,
	Error = 3,
}

interface DetachedPtyHostSpec {
	protocolVersion?: number;
	token: string;
	binary: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	cols: number;
	rows: number;
	controlSocketPath: string;
	streamSocketPath: string;
	logPath: string;
	checkpointPath: string;
	exitPath: string;
	readyPath: string;
	streamFlushIntervalMs?: number;
	streamMaxBatchBytes?: number;
	isolationMode?: string;
}

interface DetachedPtyHostReady {
	protocolVersion: number;
	hostPid: number;
	childPid: number;
}

type DetachedPtyHostCommand =
	| { kind: "ping" }
	| { kind: "checkpoint" }
	| { kind: "text"; text: string }
	| { kind: "raw"; data: string }
	| { kind: "write_no_ack"; data: string }
	| { kind: "resize"; cols: number; rows: number }
	| { kind: "kill" };

interface DetachedPtyHostRequest {
	protocolVersion?: number;
	token: string;
	kind: string;
	text?: string;
	data?: string;
	cols?: number;
	rows?: number;
}

interface DetachedPtyHostResponse {
	protocolVersion: number;
	ok: boolean;
	childPid: number | null;
	outputOffset?: number;
	restoreSnapshot?: TerminalSnapshot;
	error?: string;
}

interface DetachedPtyHostStreamRequest {
	protocolVersion?: number;
	token: string;
	offset: number;
}

interface DetachedPtyHostStreamResponse {
	protocolVersion: number;
	ok: boolean;
	childPid: number | null;
	error?: string;
}

function resolveLocalTsxCliPath(): string | null {
	const require = createRequire(import.meta.url);
	try {
		const packageJsonPath = require.resolve("tsx/package.json");
		const candidate = path.join(path.dirname(packageJsonPath), "dist", "cli.mjs");
		return existsSync(candidate) ? candidate : null;
	} catch {
		return null;
	}
}

function resolvePtySubprocessLaunchTarget(): NodeLaunchTarget {
	const compiledEntry = fileURLToPath(new URL("./terminal-host/pty-subprocess.js", import.meta.url));
	if (existsSync(compiledEntry)) {
		return {
			cmd: process.execPath,
			args: [compiledEntry],
		};
	}

	const sourceEntry = fileURLToPath(new URL("./terminal-host/pty-subprocess.ts", import.meta.url));
	const tsxCliPath = resolveLocalTsxCliPath();
	if (existsSync(sourceEntry) && tsxCliPath) {
		return {
			cmd: process.execPath,
			args: [tsxCliPath, sourceEntry],
		};
	}

	throw new Error("Unable to resolve the PTY subprocess entrypoint for this CLI install");
}

function isTokenValid(provided: string | undefined, expected: string): boolean {
	const tokenBuf = Buffer.from(provided || "");
	const expectedBuf = Buffer.from(expected);
	if (tokenBuf.length !== expectedBuf.length) return false;
	return timingSafeEqual(tokenBuf, expectedBuf);
}

class PtyHost {
	private spec: DetachedPtyHostSpec;
	private subprocess: ChildProcess | null = null;
	private emulator: HeadlessEmulator;
	private childPid: number | null = null;
	private logOffset = 0;
	private logFileHandle: fs.FileHandle | null = null;

	private controlServer: net.Server | null = null;
	private streamServer: net.Server | null = null;
	private activeStreams: Set<net.Socket> = new Set();
	private decoder = new PtySubprocessFrameDecoder();

	constructor(_specPath: string, specData: string) {
		this.spec = JSON.parse(specData);
		this.spec.protocolVersion = this.spec.protocolVersion ?? DETACHED_PTY_PROTOCOL_VERSION;

		this.emulator = new HeadlessEmulator({
			cols: this.spec.cols,
			rows: this.spec.rows,
		});
	}

	async start() {
		// Ensure socket dirs exist
		await fs.mkdir(path.dirname(this.spec.controlSocketPath), { recursive: true });
		await fs.mkdir(path.dirname(this.spec.streamSocketPath), { recursive: true });
		await fs.mkdir(path.dirname(this.spec.logPath), { recursive: true });

		// Unlink old sockets
		await fs.rm(this.spec.controlSocketPath, { force: true }).catch(() => {});
		await fs.rm(this.spec.streamSocketPath, { force: true }).catch(() => {});

		// Open log file for appending
		this.logFileHandle = await fs.open(this.spec.logPath, "a+");

		// Spawn pty-subprocess
		const launchTarget = resolvePtySubprocessLaunchTarget();
		this.subprocess = spawn(launchTarget.cmd, launchTarget.args, {
			stdio: ["pipe", "pipe", "inherit"],
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
		});

		if (this.subprocess.stdout) {
			this.subprocess.stdout.on("data", (chunk: Buffer) => {
				const frames = this.decoder.push(chunk);
				for (const frame of frames) {
					this.handleSubprocessFrame(frame.type, frame.payload);
				}
			});
		}

		this.subprocess.on("exit", async (code) => {
			await this.broadcastStreamFrame(DetachedPtyStreamFrameKind.Exit, Buffer.from(new Int32Array([code ?? -1]).buffer));
			await fs.writeFile(this.spec.exitPath, String(code ?? -1));
			await this.shutdown();
		});

		this.subprocess.on("error", async (err) => {
			await this.broadcastStreamFrame(DetachedPtyStreamFrameKind.Error, Buffer.from(err.message));
			await fs.writeFile(this.spec.exitPath, "-1");
			await this.shutdown();
		});

		// Create servers
		this.controlServer = net.createServer((socket) => this.handleControlSocket(socket));
		this.controlServer.listen(this.spec.controlSocketPath);

		this.streamServer = net.createServer((socket) => this.handleStreamSocket(socket));
		this.streamServer.listen(this.spec.streamSocketPath);
	}

	private async handleSubprocessFrame(type: PtySubprocessIpcType, payload: Buffer) {
		switch (type) {
			case PtySubprocessIpcType.Ready:
				// Send spawn frame.
				// Merge spec.env on top of the host's own process.env so that
				// the agent inherits essential variables (HOME, TERM, SHELL,
				// USER, etc.) that build_runtime_env intentionally omits.
				// Without this merge, agents run in a nearly-empty environment
				// and silently crash (exit 127, no output).
				const mergedEnv: Record<string, string> = {};
				for (const [k, v] of Object.entries(process.env)) {
					if (v !== undefined) mergedEnv[k] = v;
				}
				for (const [k, v] of Object.entries(this.spec.env)) {
					if (v !== undefined && v !== "") {
						mergedEnv[k] = v;
					} else if (v === "") {
						// Empty string means "unset this var" (e.g. ANTHROPIC_API_KEY for claude-code)
						delete mergedEnv[k];
					}
				}
				const spawnPayload = {
					shell: this.spec.binary,
					args: this.spec.args,
					cwd: this.spec.cwd,
					cols: this.spec.cols,
					rows: this.spec.rows,
					env: mergedEnv,
				};
				this.sendToSubprocess(PtySubprocessIpcType.Spawn, Buffer.from(JSON.stringify(spawnPayload)));
				break;
			case PtySubprocessIpcType.Spawned:
				this.childPid = payload.readUInt32LE(0);
				const readyData: DetachedPtyHostReady = {
					protocolVersion: this.spec.protocolVersion!,
					hostPid: process.pid,
					childPid: this.childPid,
				};
				await fs.writeFile(this.spec.readyPath, JSON.stringify(readyData));
				break;
			case PtySubprocessIpcType.Data:
				if (payload.length > 0) {
					const data = payload.toString("utf8");
					this.emulator.write(data);

					// Write to log file
					if (this.logFileHandle) {
						await this.logFileHandle.write(payload);
					}

					// Broadcast to streams
					const prevOffset = this.logOffset;
					this.logOffset += payload.length;
					await this.broadcastStreamFrame(DetachedPtyStreamFrameKind.Data, payload, prevOffset);
				}
				break;
			case PtySubprocessIpcType.Exit:
				const code = payload.length >= 4 ? payload.readInt32LE(0) : 0;
				await this.broadcastStreamFrame(DetachedPtyStreamFrameKind.Exit, Buffer.from(new Int32Array([code]).buffer));
				await fs.writeFile(this.spec.exitPath, String(code));
				await this.shutdown();
				break;
		}
	}

	private sendToSubprocess(type: PtySubprocessIpcType, payload?: Buffer) {
		if (!this.subprocess || !this.subprocess.stdin) return;
		const payloadBuf = payload ?? Buffer.alloc(0);
		const header = createFrameHeader(type, payloadBuf.length);
		this.subprocess.stdin.write(header);
		if (payloadBuf.length > 0) {
			this.subprocess.stdin.write(payloadBuf);
		}
	}

	/** Maximum buffer size (1 MB) for line-protocol socket handlers. */
	private static readonly MAX_SOCKET_BUFFER = 1024 * 1024;

	private handleControlSocket(socket: net.Socket) {
		let buffer = "";
		socket.on("data", async (data) => {
			buffer += data.toString();
			if (buffer.length > PtyHost.MAX_SOCKET_BUFFER) {
				socket.destroy(new Error("Control socket buffer exceeded maximum size"));
				return;
			}
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const req = JSON.parse(line) as DetachedPtyHostRequest;
					const res = await this.processControlRequest(req);
					// write_no_ack: skip sending the response to reduce
					// latency for input.  The caller fires and forgets.
					if (req.kind !== "write_no_ack") {
						socket.write(JSON.stringify(res) + "\n");
					}
					if (req.kind === "kill") {
						await this.shutdown();
					}
				} catch (e) {
					socket.write(JSON.stringify({
						protocolVersion: this.spec.protocolVersion,
						ok: false,
						error: String(e),
					}) + "\n");
				}
			}
		});
	}

	private async processControlRequest(req: DetachedPtyHostRequest): Promise<DetachedPtyHostResponse> {
		if (req.protocolVersion !== this.spec.protocolVersion) {
			throw new Error("Protocol version mismatch");
		}
		if (!isTokenValid(req.token, this.spec.token)) {
			throw new Error("Unauthorized");
		}

		const baseRes = {
			protocolVersion: this.spec.protocolVersion!,
			ok: true,
			childPid: this.childPid,
			outputOffset: this.logOffset,
		};

		switch (req.kind) {
			case "ping":
				return baseRes;
			case "checkpoint":
				const snapshot = this.emulator.getSnapshot();
				// Also save to disk
				const checkpointData = {
					outputOffset: this.logOffset,
					restoreSnapshot: snapshot,
				};
				await fs.writeFile(this.spec.checkpointPath, JSON.stringify(checkpointData));
				return { ...baseRes, restoreSnapshot: snapshot };
			case "text":
				if (req.text) this.sendToSubprocess(PtySubprocessIpcType.Write, Buffer.from(req.text));
				return baseRes;
			case "raw":
				if (req.data) this.sendToSubprocess(PtySubprocessIpcType.Write, Buffer.from(req.data));
				return baseRes;
			case "write_no_ack":
				// Fire-and-forget input — same as "raw" but semantically signals
				// that the caller will not wait for the response.  We still return
				// a response (the line protocol requires it), but the daemon's
				// write_no_ack handler may discard it to cut latency.
				if (req.data) this.sendToSubprocess(PtySubprocessIpcType.Write, Buffer.from(req.data));
				return baseRes;
			case "resize":
				if (req.cols && req.rows) {
					this.emulator.resize(req.cols, req.rows);
					const payload = Buffer.alloc(8);
					payload.writeUInt32LE(req.cols, 0);
					payload.writeUInt32LE(req.rows, 4);
					this.sendToSubprocess(PtySubprocessIpcType.Resize, payload);
				}
				return baseRes;
			case "kill":
				this.sendToSubprocess(PtySubprocessIpcType.Kill);
				return baseRes;
			default:
				throw new Error("Unknown control command: " + req.kind);
		}
	}

	private handleStreamSocket(socket: net.Socket) {
		let buffer = "";
		let ready = false;
		socket.on("data", async (data) => {
			if (ready) return;
			buffer += data.toString();
			if (buffer.length > PtyHost.MAX_SOCKET_BUFFER) {
				socket.destroy(new Error("Stream socket buffer exceeded maximum size"));
				return;
			}
			if (buffer.includes("\n")) {
				const line = buffer.split("\n")[0];
				ready = true;
				try {
					const req = JSON.parse(line) as DetachedPtyHostStreamRequest;
					if (!isTokenValid(req.token, this.spec.token)) {
						socket.write(JSON.stringify({
							protocolVersion: this.spec.protocolVersion,
							ok: false,
							error: "Unauthorized",
						}) + "\n");
						socket.end();
						return;
					}

					socket.write(JSON.stringify({
						protocolVersion: this.spec.protocolVersion,
						ok: true,
						childPid: this.childPid,
					}) + "\n");

					// Replay history
					await this.replayLog(socket, req.offset);

					this.activeStreams.add(socket);
					socket.on("close", () => this.activeStreams.delete(socket));
					socket.on("error", () => this.activeStreams.delete(socket));
				} catch (e) {
					socket.end();
				}
			}
		});
	}

	private async replayLog(socket: net.Socket, offset: number) {
		if (offset >= this.logOffset) return;
		try {
			const fh = await fs.open(this.spec.logPath, "r");
			try {
				const stat = await fh.stat();
				const readFrom = Math.min(offset, stat.size);
				const bytesToRead = stat.size - readFrom;
				if (bytesToRead <= 0) return;
				const buf = Buffer.alloc(bytesToRead);
				await fh.read(buf, 0, bytesToRead, readFrom);
				const frame = this.createStreamFrame(DetachedPtyStreamFrameKind.Data, buf, readFrom);
				socket.write(frame);
			} finally {
				await fh.close();
			}
		} catch (e) {
			console.error("Failed to replay log", e);
		}
	}

	private createStreamFrame(kind: DetachedPtyStreamFrameKind, payload: Buffer, overrideOffset?: number): Buffer {
		const offset = overrideOffset ?? this.logOffset;
		const header = Buffer.alloc(13);
		header.writeUInt8(kind, 0);
		// write BigInt offset (8 bytes)
		header.writeBigUInt64BE(BigInt(offset), 1);
		// length (4 bytes)
		header.writeUInt32BE(payload.length, 9);
		return Buffer.concat([header, payload]);
	}

	private async broadcastStreamFrame(kind: DetachedPtyStreamFrameKind, payload: Buffer, overrideOffset?: number) {
		const frame = this.createStreamFrame(kind, payload, overrideOffset);
		for (const socket of this.activeStreams) {
			socket.write(frame);
		}
	}

	private shuttingDown = false;

	private async shutdown() {
		if (this.shuttingDown) return;
		this.shuttingDown = true;

		for (const socket of this.activeStreams) socket.end();

		await Promise.all([
			this.controlServer ? new Promise<void>((resolve) => this.controlServer!.close(() => resolve())) : Promise.resolve(),
			this.streamServer ? new Promise<void>((resolve) => this.streamServer!.close(() => resolve())) : Promise.resolve(),
		]);

		if (this.logFileHandle) {
			await this.logFileHandle.close().catch(() => {});
			this.logFileHandle = null;
		}
		process.exit(0);
	}
}

const specParam = process.argv.indexOf("--spec");
if (specParam !== -1 && specParam + 1 < process.argv.length) {
	const specPath = process.argv[specParam + 1];
	fs.readFile(specPath, "utf-8").then((specData) => {
		const ptyHost = new PtyHost(specPath, specData);
		ptyHost.start().catch((e) => {
			console.error("Fatal error starting pty host", e);
			process.exit(1);
		});
	}).catch((e) => {
		console.error("Failed to read spec file", e);
		process.exit(1);
	});
}
