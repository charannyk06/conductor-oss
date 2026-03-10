import type { ITerminalOptions } from "@xterm/xterm";

export const SUPERSET_TERMINAL_FONT_FAMILY = [
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
  "SF Mono",
  "SF Pro",
  "monospace",
].join(", ");

const SUPERSET_TERMINAL_THEME_DARK: NonNullable<ITerminalOptions["theme"]> = {
  background: "#000000",
  foreground: "#ffffff",
  cursor: "#ffffff",
  cursorAccent: "#000000",
  selectionBackground: "#4d4d4d",
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

const SUPERSET_TERMINAL_THEME_LIGHT: NonNullable<ITerminalOptions["theme"]> = {
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

export function getSupersetLikeTerminalTheme(isLight: boolean): NonNullable<ITerminalOptions["theme"]> {
  return isLight ? SUPERSET_TERMINAL_THEME_LIGHT : SUPERSET_TERMINAL_THEME_DARK;
}
