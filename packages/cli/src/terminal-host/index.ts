/**
 * Terminal Host Module
 * 
 * Provides a complete terminal experience with:
 * - PTY subprocess with binary framing protocol
 * - Output batching (~30fps)
 * - Input queue with backpressure
 * - Headless emulator for state tracking
 * - Mode tracking (DECCKM, bracketed paste, alternate screen)
 * - Session persistence with history manager
 * - Snapshot boundary system for consistent state
 * - Full input sequences (F-keys, modifiers, mouse)
 */

export { HeadlessEmulator, applySnapshot, modesEqual } from "./headless-emulator.js";
export { HistoryManager, createHistoryManager } from "./history-manager.js";
export { TerminalSession, createSession } from "./session.js";
export {
	PtySubprocessFrameDecoder,
	PtySubprocessIpcType,
	writeFrame,
	createFrameHeader,
} from "./pty-subprocess-ipc.js";
export {
	DEFAULT_MODES,
	PROTOCOL_VERSION,
} from "./types.js";
export type { TerminalModes, TerminalSnapshot } from "./types.js";
export type { SessionOptions, SessionInfo, SessionSnapshotWithBoundary } from "./session.js";
export type { HistoryMetadata } from "./history-manager.js";
export {
	encodeKey,
	encodeMouseEvent,
	encodeBracketedPaste,
	encodeFocusIn,
	encodeFocusOut,
	encodeTrueColorFg,
	encodeTrueColorBg,
	encode256ColorFg,
	encode256ColorBg,
	TERMINAL_CONTROL_SEQUENCES,
} from "./input-sequences.js";
export type { KeyModifiers } from "./input-sequences.js";