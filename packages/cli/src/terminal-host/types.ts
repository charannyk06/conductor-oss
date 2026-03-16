export const PROTOCOL_VERSION = 2;

export interface TerminalModes {
	applicationCursorKeys: boolean;
	bracketedPaste: boolean;
	mouseTrackingX10: boolean;
	mouseTrackingNormal: boolean;
	mouseTrackingHighlight: boolean;
	mouseTrackingButtonEvent: boolean;
	mouseTrackingAnyEvent: boolean;
	focusReporting: boolean;
	mouseUtf8: boolean;
	mouseSgr: boolean;
	alternateScreen: boolean;
	cursorVisible: boolean;
	originMode: boolean;
	autoWrap: boolean;
}

export const DEFAULT_MODES: TerminalModes = {
	applicationCursorKeys: false,
	bracketedPaste: false,
	mouseTrackingX10: false,
	mouseTrackingNormal: false,
	mouseTrackingHighlight: false,
	mouseTrackingButtonEvent: false,
	mouseTrackingAnyEvent: false,
	focusReporting: false,
	mouseUtf8: false,
	mouseSgr: false,
	alternateScreen: false,
	cursorVisible: true,
	originMode: false,
	autoWrap: true,
};

export interface TerminalSnapshot {
	snapshotAnsi: string;
	rehydrateSequences: string;
	cwd: string | null;
	modes: TerminalModes;
	cols: number;
	rows: number;
	scrollbackLines: number;
	debug?: {
		xtermBufferType: string;
		hasAltScreenEntry: boolean;
		altBuffer?: {
			lines: number;
			nonEmptyLines: number;
			totalChars: number;
			cursorX: number;
			cursorY: number;
			sampleLines: string[];
		};
		normalBufferLines: number;
	};
}
