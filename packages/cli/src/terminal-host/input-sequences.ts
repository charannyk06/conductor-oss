/**
 * Terminal Input Sequences
 *
 * Comprehensive terminal input sequence generation for F-keys, modifiers,
 * arrow keys, and special combinations. Based on xterm/VT100/VT220 standards.
 */

export interface KeyModifiers {
	shift?: boolean;
	alt?: boolean;
	ctrl?: boolean;
	meta?: boolean;
}

const ESC = "\x1b";

export function encodeKey(key: string, modifiers?: KeyModifiers): string {
	const mod =
		modifiers?.shift || modifiers?.alt || modifiers?.ctrl || modifiers?.meta
			? encodeModifiers(modifiers)
			: null;

	// Special keys
	switch (key.toLowerCase()) {
		case "enter":
			return mod ? `${ESC}[1${mod}~` : "\r";
		case "tab":
			if (modifiers?.shift) return mod ? `${ESC}[0${mod}~` : `${ESC}[Z`;
			return mod ? `${ESC}[1${mod}~` : "\t";
		case "backspace":
			return mod ? `${ESC}[1${mod}~` : "\x7f";
		case "escape":
			return ESC;
		case "space":
			return mod ? `${ESC}[1${mod}~` : " ";
		case "insert":
		case "delete":
		case "home":
		case "end":
		case "pageup":
		case "pagedown": {
			const code = SPECIAL_KEY_CODES[key.toLowerCase()];
			return mod ? `${ESC}[${code}${mod}~` : `${ESC}[${code}~`;
		}
		case "arrowup":
		case "arrowdown":
		case "arrowleft":
		case "arrowright": {
			const arrowKey = key.slice(5).toUpperCase();
			return encodeArrowKey(arrowKey, modifiers);
		}
		default:
			break;
	}

	// F-keys (F1-F12)
	const fMatch = key.match(/^f(\d+)$/i);
	if (fMatch) {
		const num = parseInt(fMatch[1], 10);
		return encodeFunctionKey(num, modifiers);
	}

	// Regular key with modifiers
	if (mod) {
		const charCode = key.charCodeAt(0);
		if (charCode >= 32 && charCode <= 126) {
			return `${ESC}[27${mod};${charCode}~`;
		}
	}

	return key;
}

const SPECIAL_KEY_CODES: Record<string, string> = {
	insert: "2",
	delete: "3",
	home: "1",
	end: "4",
	pageup: "5",
	pagedown: "6",
};

function encodeModifiers(modifiers?: KeyModifiers): string {
	if (!modifiers) return "1";

	let code = 1; // Base modifier code starts at 1
	if (modifiers.shift) code += 1;
	if (modifiers.alt) code += 2;
	if (modifiers.ctrl) code += 4;
	if (modifiers.meta) code += 8;

	return String(code);
}

function encodeArrowKey(direction: string, modifiers?: KeyModifiers): string {
	// Arrow keys use CSI n A/B/C/D format
	// With modifiers: CSI 1 ; modifier A/B/C/D
	const codes: Record<string, string> = {
		UP: "A",
		DOWN: "B",
		RIGHT: "C",
		LEFT: "D",
	};

	const code = codes[direction];
	if (!code) return "";

	const mod = encodeModifiers(modifiers);

	if (modifiers?.shift || modifiers?.alt || modifiers?.ctrl || modifiers?.meta) {
		// Modified arrow: ESC[1;modifier A/B/C/D
		return `${ESC}[1;${mod}${code}`;
	}

	// Normal arrow: ESC[A/B/C/D
	return `${ESC}[${code}`;
}

function encodeFunctionKey(num: number, modifiers?: KeyModifiers): string {
	// F-keys have different sequences depending on the key number and modifiers
	// F1-F4: ESC O P/Q/R/S (VT100) or ESC[11~ etc (VT220+)
	// F5-F12: ESC[15~ through ESC[24~

	const mod = modifiers
		? encodeModifiers(modifiers)
		: null;
	const modSuffix = mod ? `;${mod}` : "";

	if (num >= 1 && num <= 4) {
		// VT100 style for F1-F4: SS3 P/Q/R/S
		const vt100Codes = ["P", "Q", "R", "S"];
		if (!mod) {
			// SS3 (Single Shift 3): ESC O
			return `${ESC}O${vt100Codes[num - 1]}`;
		}
		// VT220+ style with modifiers
		const vt220Codes = ["11", "12", "13", "14"];
		return `${ESC}[${vt220Codes[num - 1]}${modSuffix}~`;
	}

	if (num >= 5 && num <= 12) {
		// F5-F12: VT220 style
		const codes = ["15", "17", "18", "19", "20", "21", "23", "24"];
		return `${ESC}[${codes[num - 5]}${modSuffix}~`;
	}

	if (num >= 13 && num <= 24) {
		// F13-F24: Extended function keys
		const codes = ["25", "26", "28", "29", "31", "32", "33", "34","42", "43", "44", "45"];
		const idx = num - 13;
		if (idx < codes.length) {
			return `${ESC}[${codes[idx]}${modSuffix}~`;
		}
	}

	return "";
}

export function encodeMouseEvent(
	event: "down" | "up" | "move",
	button: number | "wheel",
	x: number,
	y: number,
	modifiers?: KeyModifiers,
	encoding: "normal" | "utf8" | "sgr" = "sgr",
): string {
	const col = Math.max(1, Math.min(223, x));
	const row = Math.max(1, Math.min(223, y));

	let mod = 0;
	if (modifiers?.shift) mod |= 4;
	if (modifiers?.alt) mod |= 8;
	if (modifiers?.ctrl) mod |= 16;

	if (encoding === "sgr") {
		// SGR extended mouse encoding
		let action: number;
		if (button === "wheel") {
			action = 64; // Wheel scroll
		} else {
			action = event === "up" ? button + 32 : button;
		}

		const ce = event === "up" ? "m" : "M";
		return `${ESC}[<${action + mod};${col};${row}${ce}`;
	}

	// Legacy encoding
	if (encoding === "utf8") {
		// UTF-8 encoding for large coordinates
		const encodeCoord = (c: number): string => {
			if (c < 95) return String.fromCharCode(32 + c);
			if (c < 127) return String.fromCharCode(c + 32);
			if (c < 160) return "";
			return String.fromCharCode(32 + c);
		};

		let code: number;
		if (button === "wheel") {
			code = 32 + 64 + mod;
		} else {
			code = 32 + button + mod;
		}
		if (event === "up") code += 3;

		return `${ESC}[M${String.fromCharCode(code)}${encodeCoord(col)}${encodeCoord(row)}`;
	}

	// Normal encoding (limited to 223x223)
	let code: number;
	if (button === "wheel") {
		code = 32 + 64 + mod;
	} else {
		code = 32 + button + mod;
	}	if (event === "up") code += 3;

	return `${ESC}[M${String.fromCharCode(code)}${String.fromCharCode(32 + col)}${String.fromCharCode(32 + row)}`;
}

export function encodeBracketedPaste(data: string): string {
	// Strip the end-paste sequence to prevent escape injection
	const sanitized = data.replace(/\x1b\[201~/g, '');
	return `${ESC}[200~${sanitized}${ESC}[201~`;
}

export function encodeFocusIn(): string {
	return `${ESC}[I`;
}

export function encodeFocusOut(): string {
	return `${ESC}[O`;
}

export const TERMINAL_CONTROL_SEQUENCES = {
	// Device Status
	DEVICE_ATTRIBUTES: `${ESC}[0c`,
	DEVICE_STATUS: `${ESC}[5n`,
	CURSOR_POSITION: `${ESC}[6n`,

	// Screen Clear
	CLEAR_SCREEN: `${ESC}[2J`,
	CLEAR_LINE: `${ESC}[2K`,
	CLEAR_SCREEN_ABOVE: `${ESC}[1J`,
	CLEAR_SCREEN_BELOW: `${ESC}[0J`,

	// Cursor
	CURSOR_HOME: `${ESC}[H`,
	CURSOR_SAVE: `${ESC}[s`,
	CURSOR_RESTORE: `${ESC}[u`,
	CURSOR_SAVE_ALT: `${ESC}[?47s`, // Save cursor + screen
	CURSOR_RESTORE_ALT: `${ESC}[?47l`, // Restore cursor + screen

	// Alternate Screen
	ENTER_ALT_SCREEN: `${ESC}[?1049h`,
	EXIT_ALT_SCREEN: `${ESC}[?1049l`,

	// Modes
	ENABLE_BRACKETED_PASTE: `${ESC}[?2004h`,
	DISABLE_BRACKETED_PASTE: `${ESC}[?2004l`,

	 ENABLE_MOUSE_NORMAL: `${ESC}[?1000h`,
	DISABLE_MOUSE_NORMAL: `${ESC}[?1000l`,
	ENABLE_MOUSE_BUTTON: `${ESC}[?1002h`,
	DISABLE_MOUSE_BUTTON: `${ESC}[?1002l`,
	ENABLE_MOUSE_ANY: `${ESC}[?1003h`,
	DISABLE_MOUSE_ANY: `${ESC}[?1003l`,
	ENABLE_MOUSE_SGR: `${ESC}[?1006h`,
	DISABLE_MOUSE_SGR: `${ESC}[?1006l`,

	ENABLE_FOCUS_REPORTING: `${ESC}[?1004h`,
	DISABLE_FOCUS_REPORTING: `${ESC}[?1004l`,

	// Cursor style
	CURSOR_BLINK: `${ESC}[5 q`,
	CURSOR_STEADY: `${ESC}[0 q`,
	CURSOR_BLINK_BAR: `${ESC}[6 q`,
	CURSOR_STEADY_BAR: `${ESC}[2 q`,
	CURSOR_BLINK_UNDERLINE: `${ESC}[4 q`,
	CURSOR_STEADY_UNDERLINE: `${ESC}[2 q`,
	CURSOR_BLINK_BLOCK: `${ESC}[1 q`,
	CURSOR_STEADY_BLOCK: `${ESC}[0 q`,

	// Scroll
	SCROLL_UP: `${ESC}[S`,
	SCROLL_DOWN: `${ESC}[T`,

	// SGR (colors)
	RESET_ATTRIBUTES: `${ESC}[0m`,
	BOLD: `${ESC}[1m`,
	DIM: `${ESC}[2m`,
	ITALIC: `${ESC}[3m`,
	UNDERLINE: `${ESC}[4m`,
	BLINK: `${ESC}[5m`,
	REVERSE: `${ESC}[7m`,
	HIDDEN: `${ESC}[8m`,
	STRIKETHROUGH: `${ESC}[9m`,
} as const;

export function encodeTrueColorFg(r: number, g: number, b: number): string {
	return `${ESC}[38;2;${r};${g};${b}m`;
}

export function encodeTrueColorBg(r: number, g: number, b: number): string {
	return `${ESC}[48;2;${r};${g};${b}m`;
}

export function encode256ColorFg(color: number): string {
	return `${ESC}[38;5;${color}m`;
}

export function encode256ColorBg(color: number): string {
	return `${ESC}[48;5;${color}m`;
}
