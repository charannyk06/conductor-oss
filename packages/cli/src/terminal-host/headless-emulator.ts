import "./xterm-env-polyfill.js";
import { SerializeAddon } from "@xterm/addon-serialize";
import * as xtermHeadless from "@xterm/headless";
// CJS interop: tsx exposes named exports directly, but native Node ESM wraps
// the CJS module under a `default` property.  Handle both.
const _mod = xtermHeadless as Record<string, unknown>;
const Terminal = (typeof _mod.Terminal === "function"
	? _mod.Terminal
	: (_mod.default as Record<string, unknown>)?.Terminal) as typeof import("@xterm/headless").Terminal;
import {
	DEFAULT_MODES,
	type TerminalModes,
	type TerminalSnapshot,
} from "./types.js";

const DEFAULT_TERMINAL_SCROLLBACK = 5000;

const ESC = "\x1b";
const BEL = "\x07";

const ESC_ESCAPED = ESC.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MODE_REGEX = new RegExp(`${ESC_ESCAPED}\\[\\?([0-9;]+)([hl])`, "g");
const OSC7_BEL_ESCAPED = BEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const OSC7_REGEX = new RegExp(
	`${ESC_ESCAPED}\\]7;file://[^/]*(/.+?)(?:${OSC7_BEL_ESCAPED}|${ESC_ESCAPED}\\\\)`,
	"g",
);
const COMPLETE_DECSET_REGEX = new RegExp(`${ESC_ESCAPED}\\[\\?[0-9;]+[hl]`);
const GLOBAL_DECSET_REGEX = new RegExp(`${ESC_ESCAPED}\\[\\?[0-9;]+[hl]`, "g");
const INCOMPLETE_DECSET_REGEX = new RegExp(`^${ESC_ESCAPED}\\[\\?[0-9;]*$`);

const DEBUG_EMULATOR_TIMING =
	process.env.SUPERSET_TERMINAL_EMULATOR_DEBUG === "1";

const MODE_MAP: Record<number, keyof TerminalModes> = {
	1: "applicationCursorKeys",
	6: "originMode",
	7: "autoWrap",
	9: "mouseTrackingX10",
	25: "cursorVisible",
	47: "alternateScreen", 
	1000: "mouseTrackingNormal",
	1001: "mouseTrackingHighlight",
	1002: "mouseTrackingButtonEvent",
	1003: "mouseTrackingAnyEvent",
	1004: "focusReporting",
	1005: "mouseUtf8",
	1006: "mouseSgr",
	1049: "alternateScreen", 
	2004: "bracketedPaste",
};

export interface HeadlessEmulatorOptions {
	cols?: number;
	rows?: number;
	scrollback?: number;
}

export class HeadlessEmulator {
	private terminal: InstanceType<typeof Terminal>;
	private serializeAddon: SerializeAddon;
	private modes: TerminalModes;
	private cwd: string | null = null;
	private disposed = false;

	private pendingOutput: string[] = [];
	private onDataCallback?: (data: string) => void;

	private escapeSequenceBuffer = "";

	private static readonly MAX_ESCAPE_BUFFER_SIZE = 1024;

	constructor(options: HeadlessEmulatorOptions = {}) {
		const {
			cols = 80,
			rows = 24,
			scrollback = DEFAULT_TERMINAL_SCROLLBACK,
		} = options;

		this.terminal = new Terminal({
			cols,
			rows,
			scrollback,
			allowProposedApi: true,
		});

		this.serializeAddon = new SerializeAddon();
		this.terminal.loadAddon(this.serializeAddon);

		this.modes = { ...DEFAULT_MODES };

		this.terminal.onData((data: string) => {
			this.pendingOutput.push(data);
			this.onDataCallback?.(data);
		});
	}

	onData(callback: (data: string) => void): void {
		this.onDataCallback = callback;
	}

	flushPendingOutput(): string[] {
		const output = this.pendingOutput;
		this.pendingOutput = [];
		return output;
	}

	write(data: string): void {
		if (this.disposed) return;

		if (!DEBUG_EMULATOR_TIMING) {
			this.parseEscapeSequences(data);
			this.terminal.write(data);
			return;
		}

		const parseStart = performance.now();
		this.parseEscapeSequences(data);
		const parseTime = performance.now() - parseStart;

		const terminalStart = performance.now();
		this.terminal.write(data);
		const terminalTime = performance.now() - terminalStart;

		if (parseTime > 2 || terminalTime > 2) {
			console.warn(
				`[HeadlessEmulator] write(${data.length}b): parse=${parseTime.toFixed(1)}ms, terminal=${terminalTime.toFixed(1)}ms`,
			);
		}
	}

	async writeSync(data: string): Promise<void> {
		if (this.disposed) return;

		this.parseEscapeSequences(data);

		return new Promise<void>((resolve) => {
			this.terminal.write(data, () => resolve());
		});
	}

	resize(cols: number, rows: number): void {
		if (this.disposed) return;
		this.terminal.resize(cols, rows);
	}

	getDimensions(): { cols: number; rows: number } {
		return {
			cols: this.terminal.cols,
			rows: this.terminal.rows,
		};
	}

	getModes(): TerminalModes {
		return { ...this.modes };
	}

	getCwd(): string | null {
		return this.cwd;
	}

	setCwd(cwd: string): void {
		this.cwd = cwd;
	}

	getScrollbackLines(): number {
		return this.terminal.buffer.active.length;
	}

	async flush(): Promise<void> {
		if (this.disposed) return;
		return new Promise<void>((resolve) => {
			this.terminal.write("", () => resolve());
		});
	}

	getSnapshot(): TerminalSnapshot {
		const snapshotAnsi = this.serializeAddon.serialize({
			scrollback:
				this.terminal.options.scrollback ?? DEFAULT_TERMINAL_SCROLLBACK,
		});

		const rehydrateSequences = this.generateRehydrateSequences();

		const xtermBufferType = this.terminal.buffer.active.type;
		const hasAltScreenEntry = snapshotAnsi.includes("\x1b[?1049h");

		let altBufferDebug:
			| {
					lines: number;
					nonEmptyLines: number;
					totalChars: number;
					cursorX: number;
					cursorY: number;
					sampleLines: string[];
			  }
			| undefined;

		if (this.modes.alternateScreen || xtermBufferType === "alternate") {
			const altBuffer = this.terminal.buffer.alternate;
			let nonEmptyLines = 0;
			let totalChars = 0;
			const sampleLines: string[] = [];

			for (let i = 0; i < altBuffer.length; i++) {
				const line = altBuffer.getLine(i);
				if (line) {
					const lineText = line.translateToString(true);
					if (lineText.trim().length > 0) {
						nonEmptyLines++;
						totalChars += lineText.length;
						if (sampleLines.length < 3) {
							sampleLines.push(lineText.slice(0, 80));
						}
					}
				}
			}

			altBufferDebug = {
				lines: altBuffer.length,
				nonEmptyLines,
				totalChars,
				cursorX: altBuffer.cursorX,
				cursorY: altBuffer.cursorY,
				sampleLines,
			};
		}

		return {
			snapshotAnsi,
			rehydrateSequences,
			cwd: this.cwd,
			modes: { ...this.modes },
			cols: this.terminal.cols,
			rows: this.terminal.rows,
			scrollbackLines: this.getScrollbackLines(),
			debug: {
				xtermBufferType,
				hasAltScreenEntry,
				altBuffer: altBufferDebug,
				normalBufferLines: this.terminal.buffer.normal.length,
			},
		};
	}

	async getSnapshotAsync(): Promise<TerminalSnapshot> {
		await this.flush();
		return this.getSnapshot();
	}

	clear(): void {
		if (this.disposed) return;
		this.terminal.clear();
	}

	reset(): void {
		if (this.disposed) return;
		this.terminal.reset();
		this.modes = { ...DEFAULT_MODES };
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.terminal.dispose();
	}

	private parseEscapeSequences(data: string): void {
		const fullData = this.escapeSequenceBuffer + data;
		this.escapeSequenceBuffer = "";

		this.parseModeChanges(fullData);
		this.parseOsc7(fullData);

		const incompleteSequence = this.findIncompleteTrackedSequence(fullData);

		if (incompleteSequence) {
			if (
				incompleteSequence.length <= HeadlessEmulator.MAX_ESCAPE_BUFFER_SIZE
			) {
				this.escapeSequenceBuffer = incompleteSequence;
			}
		}
	}

	private findIncompleteTrackedSequence(data: string): string | null {
		const lastEscIndex = data.lastIndexOf(ESC);
		if (lastEscIndex === -1) return null;

		const afterLastEsc = data.slice(lastEscIndex);

		if (afterLastEsc.startsWith(`${ESC}[?`)) {
			const completePattern = COMPLETE_DECSET_REGEX;
			if (completePattern.test(afterLastEsc)) {
				GLOBAL_DECSET_REGEX.lastIndex = 0;
				const globalPattern = GLOBAL_DECSET_REGEX;
				const matches = afterLastEsc.match(globalPattern);
				if (matches) {
					const lastMatch = matches[matches.length - 1];
					const lastMatchEnd =
						afterLastEsc.lastIndexOf(lastMatch) + lastMatch.length;
					const remainder = afterLastEsc.slice(lastMatchEnd);
					if (remainder.includes(ESC)) {
						return this.findIncompleteTrackedSequence(remainder);
					}
				}
				return null; 
			}
			return afterLastEsc;
		}

		if (afterLastEsc.startsWith(`${ESC}]7;`)) {
			if (afterLastEsc.includes(BEL) || afterLastEsc.includes(`${ESC}\\`)) {
				return null; 
			}
			return afterLastEsc;
		}

		if (afterLastEsc === ESC) return afterLastEsc; // Just ESC
		if (afterLastEsc === `${ESC}[`) return afterLastEsc; // ESC[
		if (afterLastEsc === `${ESC}]`) return afterLastEsc; // ESC]
		if (afterLastEsc === `${ESC}]7`) return afterLastEsc; // ESC]7
		const incompleteDecset = INCOMPLETE_DECSET_REGEX;
		if (incompleteDecset.test(afterLastEsc)) return afterLastEsc; // ESC[?123

		return null;
	}

	private parseModeChanges(data: string): void {
		MODE_REGEX.lastIndex = 0;
		const modeRegex = MODE_REGEX;

		for (const match of data.matchAll(modeRegex)) {
			const modesStr = match[1];
			const action = match[2]; 
			const enable = action === "h";

			const modeNumbers = modesStr
				.split(";")
				.map((s) => Number.parseInt(s, 10));

			for (const modeNum of modeNumbers) {
				const modeName = MODE_MAP[modeNum];
				if (modeName) {
					this.modes[modeName] = enable;
				}
			}
		}
	}

	private parseOsc7(data: string): void {
		OSC7_REGEX.lastIndex = 0;
		const osc7Regex = OSC7_REGEX;

		for (const match of data.matchAll(osc7Regex)) {
			if (match[1]) {
				try {
					this.cwd = decodeURIComponent(match[1]);
				} catch {
					this.cwd = match[1];
				}
			}
		}
	}

	private generateRehydrateSequences(): string {
		const sequences: string[] = [];

		const addModeSequence = (
			modeNum: number,
			enabled: boolean,
			defaultEnabled: boolean,
		) => {
			if (enabled !== defaultEnabled) {
				sequences.push(`${ESC}[?${modeNum}${enabled ? "h" : "l"}`);
			}
		};

		addModeSequence(1, this.modes.applicationCursorKeys, false);
		addModeSequence(6, this.modes.originMode, false);
		addModeSequence(7, this.modes.autoWrap, true);
		addModeSequence(25, this.modes.cursorVisible, true);

		addModeSequence(9, this.modes.mouseTrackingX10, false);
		addModeSequence(1000, this.modes.mouseTrackingNormal, false);
		addModeSequence(1001, this.modes.mouseTrackingHighlight, false);
		addModeSequence(1002, this.modes.mouseTrackingButtonEvent, false);
		addModeSequence(1003, this.modes.mouseTrackingAnyEvent, false);

		addModeSequence(1005, this.modes.mouseUtf8, false);
		addModeSequence(1006, this.modes.mouseSgr, false);

		addModeSequence(1004, this.modes.focusReporting, false);
		addModeSequence(2004, this.modes.bracketedPaste, false);

		return sequences.join("");
	}
}

export function applySnapshot(
	emulator: HeadlessEmulator,
	snapshot: TerminalSnapshot,
): void {
	emulator.write(snapshot.rehydrateSequences);
	emulator.write(snapshot.snapshotAnsi);
}

export function modesEqual(a: TerminalModes, b: TerminalModes): boolean {
	return (
		a.applicationCursorKeys === b.applicationCursorKeys &&
		a.bracketedPaste === b.bracketedPaste &&
		a.mouseTrackingX10 === b.mouseTrackingX10 &&
		a.mouseTrackingNormal === b.mouseTrackingNormal &&
		a.mouseTrackingHighlight === b.mouseTrackingHighlight &&
		a.mouseTrackingButtonEvent === b.mouseTrackingButtonEvent &&
		a.mouseTrackingAnyEvent === b.mouseTrackingAnyEvent &&
		a.focusReporting === b.focusReporting &&
		a.mouseUtf8 === b.mouseUtf8 &&
		a.mouseSgr === b.mouseSgr &&
		a.alternateScreen === b.alternateScreen &&
		a.cursorVisible === b.cursorVisible &&
		a.originMode === b.originMode &&
		a.autoWrap === b.autoWrap
	);
}
