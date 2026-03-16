import type { ITerminalOptions } from "@xterm/xterm";

// Nerd Fonts first — agent CLIs (Claude Code, Gemini, etc.) and shell themes
// (Oh My Posh, Powerlevel10k, Starship) require them for proper icon/powerline
// rendering. System monospace fonts are fallbacks for users without Nerd Fonts.
export const TERMINAL_FONT_FAMILY = [
  "MesloLGM Nerd Font",
  "MesloLGM NF",
  "MesloLGS NF",
  "MesloLGS Nerd Font",
  "Hack Nerd Font",
  "FiraCode Nerd Font",
  "JetBrainsMono Nerd Font",
  "CaskaydiaCove Nerd Font",
  "Menlo",
  "Monaco",
  '"Courier New"',
  "monospace",
].join(", ");

const TERMINAL_THEME_DARK: NonNullable<ITerminalOptions["theme"]> = {
  background: "#060404",
  foreground: "#efe8e1",
  cursor: "#f08f56",
  cursorAccent: "#120d0d",
  selectionBackground: "#3a2a24",
  black: "#120d0d",
  red: "#ff8f7a",
  green: "#8fd18a",
  yellow: "#f3bd67",
  blue: "#7aa2f7",
  magenta: "#c792ea",
  cyan: "#74c7b8",
  white: "#d8d0c8",
  brightBlack: "#6f625b",
  brightRed: "#ffb4a6",
  brightGreen: "#b7f0b0",
  brightYellow: "#ffd899",
  brightBlue: "#9ec1ff",
  brightMagenta: "#ddb6ff",
  brightCyan: "#a4f1e0",
  brightWhite: "#fff8f2",
};

const TERMINAL_THEME_LIGHT: NonNullable<ITerminalOptions["theme"]> = {
  background: "#ffffff",
  foreground: "#000000",
  cursor: "#000000",
  cursorAccent: "#ffffff",
  selectionBackground: "#add6ff",
  black: "#2e3436",
  red: "#cc0000",
  green: "#4e9a06",
  yellow: "#c4a000",
  blue: "#3465a4",
  magenta: "#75507b",
  cyan: "#06989a",
  white: "#d3d7cf",
  brightBlack: "#555753",
  brightRed: "#ef2929",
  brightGreen: "#8ae234",
  brightYellow: "#fce94f",
  brightBlue: "#729fcf",
  brightMagenta: "#ad7fa8",
  brightCyan: "#34e2e2",
  brightWhite: "#eeeeec",
};

export function getTerminalTheme(isLight: boolean): NonNullable<ITerminalOptions["theme"]> {
  return isLight ? TERMINAL_THEME_LIGHT : TERMINAL_THEME_DARK;
}
