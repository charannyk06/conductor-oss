/**
 * Lazy addon loading for xterm.js addons (WebGL, Unicode11, WebLinks, Fit, Search).
 * Module-level singleton promises ensure each addon is loaded at most once.
 */

import type { TerminalCoreClientModules } from "./terminalTypes";

let terminalCoreClientModulesPromise: Promise<TerminalCoreClientModules> | null = null;
let terminalSearchAddonModulePromise: Promise<typeof import("@xterm/addon-search")> | null = null;
let terminalWebglAddonModulePromise: Promise<typeof import("@xterm/addon-webgl")> | null = null;
let terminalUnicode11AddonModulePromise: Promise<typeof import("@xterm/addon-unicode11")> | null = null;
let terminalWebLinksAddonModulePromise: Promise<typeof import("@xterm/addon-web-links")> | null = null;

export function loadTerminalCoreClientModules(): Promise<TerminalCoreClientModules> {
  if (!terminalCoreClientModulesPromise) {
    terminalCoreClientModulesPromise = Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
    ]).catch((error) => {
      terminalCoreClientModulesPromise = null;
      throw error;
    }) as Promise<TerminalCoreClientModules>;
  }
  return terminalCoreClientModulesPromise;
}

export function loadTerminalSearchAddonModule(): Promise<typeof import("@xterm/addon-search")> {
  if (!terminalSearchAddonModulePromise) {
    terminalSearchAddonModulePromise = import("@xterm/addon-search").catch((error) => {
      terminalSearchAddonModulePromise = null;
      throw error;
    });
  }
  return terminalSearchAddonModulePromise;
}

export function loadTerminalWebglAddonModule(): Promise<typeof import("@xterm/addon-webgl")> {
  if (!terminalWebglAddonModulePromise) {
    terminalWebglAddonModulePromise = import("@xterm/addon-webgl").catch((error) => {
      terminalWebglAddonModulePromise = null;
      throw error;
    });
  }
  return terminalWebglAddonModulePromise;
}

export function loadTerminalUnicode11AddonModule(): Promise<typeof import("@xterm/addon-unicode11")> {
  if (!terminalUnicode11AddonModulePromise) {
    terminalUnicode11AddonModulePromise = import("@xterm/addon-unicode11").catch((error) => {
      terminalUnicode11AddonModulePromise = null;
      throw error;
    });
  }
  return terminalUnicode11AddonModulePromise;
}

export function loadTerminalWebLinksAddonModule(): Promise<typeof import("@xterm/addon-web-links")> {
  if (!terminalWebLinksAddonModulePromise) {
    terminalWebLinksAddonModulePromise = import("@xterm/addon-web-links").catch((error) => {
      terminalWebLinksAddonModulePromise = null;
      throw error;
    });
  }
  return terminalWebLinksAddonModulePromise;
}
