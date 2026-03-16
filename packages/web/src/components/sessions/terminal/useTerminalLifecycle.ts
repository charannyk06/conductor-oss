/**
 * Hook for terminal lifecycle management: xterm creation, addon loading,
 * container mount/unmount, handler registration, and file-link provider.
 *
 * Owns containerRef, termRef, fitRef, and the `ready` flag.
 * All event callbacks are accessed through stable refs so the init effect
 * only re-runs when sessionId or shouldAttach changes.
 */

import { useEffect, useRef, useState } from "react";
import type { FitAddon as XFitAddon } from "@xterm/addon-fit";
import type { IDisposable, Terminal as XTerminal } from "@xterm/xterm";
import { captureTerminalViewport, type TerminalViewportState } from "../terminalViewport";
import { shouldShowTerminalAccessoryBar } from "./terminalHelpers";
import {
  loadTerminalCoreClientModules,
  loadTerminalWebglAddonModule,
  loadTerminalUnicode11AddonModule,
  loadTerminalWebLinksAddonModule,
  loadTerminalClipboardAddonModule,
  loadTerminalSerializeAddonModule,
  loadTerminalImageAddonModule,
} from "./useTerminalAddons";
import { TerminalFilePathLinkProvider } from "./filePathLinkProvider";
import { buildTerminalOptions } from "./terminalConfig";

export interface UseTerminalLifecycleOptions {
  sessionId: string;
  shouldAttach: boolean;

  /** Called when xterm emits user input data (onData). */
  onData: (data: string) => void;
  /** Called when the terminal scrolls. */
  onScroll: () => void;
  /** Called when the container is resized. */
  onResizeObserved: (term: XTerminal, entry: ResizeObserverEntry) => void;
  /** Called when a file link is activated in the terminal. */
  onFileLinkOpen: (path: string, line?: number, column?: number) => void;

  /**
   * Called after the terminal is created and mounted.
   * Use this to set up refs in other hooks (e.g. resize sync, snapshot render).
   */
  onInit: (term: XTerminal, fit: XFitAddon, container: HTMLDivElement) => void;
  /**
   * Called before the terminal is disposed on cleanup.
   * Use this to capture viewport state and reset external refs.
   */
  onCleanup: (term: XTerminal) => void;
}

export interface UseTerminalLifecycleReturn {
  termRef: React.MutableRefObject<XTerminal | null>;
  fitRef: React.MutableRefObject<XFitAddon | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  ready: boolean;
}

export function useTerminalLifecycle({
  sessionId,
  shouldAttach,
  onData,
  onScroll,
  onResizeObserved,
  onFileLinkOpen,
  onInit,
  onCleanup,
}: UseTerminalLifecycleOptions): UseTerminalLifecycleReturn {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerminal | null>(null);
  const fitRef = useRef<XFitAddon | null>(null);
  const [ready, setReady] = useState(false);

  // Stable callback refs — the effect reads .current so it never needs to re-run
  // when callback identity changes.
  const onDataRef = useRef(onData);
  const onScrollRef = useRef(onScroll);
  const onResizeObservedRef = useRef(onResizeObserved);
  const onFileLinkOpenRef = useRef(onFileLinkOpen);
  const onInitRef = useRef(onInit);
  const onCleanupRef = useRef(onCleanup);
  onDataRef.current = onData;
  onScrollRef.current = onScroll;
  onResizeObservedRef.current = onResizeObserved;
  onFileLinkOpenRef.current = onFileLinkOpen;
  onInitRef.current = onInit;
  onCleanupRef.current = onCleanup;

  useEffect(() => {
    let term: XTerminal | null = null;
    let mounted = true;
    let inputDisposable: IDisposable | null = null;
    let scrollDisposable: IDisposable | null = null;
    let fileLinkDisposable: IDisposable | null = null;
    let resizeObserver: ResizeObserver | null = null;

    async function init() {
      if (!shouldAttach || !containerRef.current || !mounted) return;

      const [xtermMod, fitMod] = await loadTerminalCoreClientModules();
      if (!mounted || !containerRef.current) return;

      const isMobileInit = shouldShowTerminalAccessoryBar();
      const terminalOptions = buildTerminalOptions({
        windowWidth: window.innerWidth,
        isLight: document.documentElement.classList.contains("light"),
        isMobile: isMobileInit,
        isLive: true,
      });
      const newTerm = new xtermMod.Terminal(terminalOptions);
      // Assign to outer `term` immediately so cleanup can always reach it,
      // even if a later `mounted` check causes an early return.
      term = newTerm;

      if (!mounted) {
        newTerm.dispose();
        term = null;
        return;
      }

      const fit = new fitMod.FitAddon();
      newTerm.loadAddon(fit);
      newTerm.open(containerRef.current);
      fit.fit();

      // Lazy-load optional addons.
      // WebGL rendering: skip on macOS where it causes corruption artifacts
      // (matching Superset's approach of Canvas fallback on macOS).
      // On other platforms, WebGL replaces the DOM renderer for better perf.
      // Fallback chain: WebGL → Canvas → DOM renderer.
      const isMacOS = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
      if (!isMacOS) {
        void loadTerminalWebglAddonModule()
          .then((mod) => {
            if (mounted && termRef.current === term) {
              const a = new mod.WebglAddon();
              a.onContextLoss(() => {
                // Dispose WebGL addon — xterm falls back to DOM renderer
                a.dispose();
              });
              term!.loadAddon(a);
              try { fit.fit(); } catch { /* container may have been removed */ }
            }
          })
          .catch(() => {});
      }
      // Helper: safely load an addon — the terminal may have been disposed
      // between the guard check and the loadAddon call in rare async races.
      const safeLoadAddon = (addon: import("@xterm/xterm").ITerminalAddon): void => {
        try { term!.loadAddon(addon); } catch { /* terminal disposed */ }
      };

      void loadTerminalUnicode11AddonModule()
        .then((mod) => {
          if (mounted && termRef.current === term) {
            const a = new mod.Unicode11Addon();
            safeLoadAddon(a);
            try { term!.unicode.activeVersion = "11"; } catch { /* disposed */ }
          }
        })
        .catch(() => {});
      void loadTerminalWebLinksAddonModule()
        .then((mod) => {
          if (mounted && termRef.current === term) safeLoadAddon(new mod.WebLinksAddon());
        })
        .catch(() => {});
      void loadTerminalClipboardAddonModule()
        .then((mod) => {
          if (mounted && termRef.current === term) safeLoadAddon(new mod.ClipboardAddon());
        })
        .catch(() => {});
      void loadTerminalSerializeAddonModule()
        .then((mod) => {
          if (mounted && termRef.current === term) safeLoadAddon(new mod.SerializeAddon());
        })
        .catch(() => {});
      void loadTerminalImageAddonModule()
        .then((mod) => {
          if (mounted && termRef.current === term) safeLoadAddon(new mod.ImageAddon());
        })
        .catch(() => {});

      // File link provider
      fileLinkDisposable = term.registerLinkProvider(
        new TerminalFilePathLinkProvider(term, (p, l, c) => onFileLinkOpenRef.current(p, l, c)),
      );

      // Store refs
      termRef.current = term;
      fitRef.current = fit;

      // Register handlers
      inputDisposable = term.onData((data) => onDataRef.current(data));
      scrollDisposable = term.onScroll(() => onScrollRef.current());

      resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry && term) onResizeObservedRef.current(term, entry);
      });
      resizeObserver.observe(containerRef.current);

      setReady(true);
      onInitRef.current(term, fit, containerRef.current);
    }

    if (!shouldAttach) {
      setReady(false);
      return () => { mounted = false; };
    }

    void init();

    return () => {
      mounted = false;
      if (term) onCleanupRef.current(term);
      inputDisposable?.dispose();
      scrollDisposable?.dispose();
      fileLinkDisposable?.dispose();
      resizeObserver?.disconnect();
      if (term) term.dispose();
      termRef.current = null;
      fitRef.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, shouldAttach]);

  return { containerRef, termRef, fitRef, ready };
}
