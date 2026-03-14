/**
 * Hook for search addon lifecycle: lazy load, find next/prev, highlight state.
 */

import { useCallback, useEffect, useRef } from "react";
import type { SearchAddon as XSearchAddon } from "@xterm/addon-search";
import type { Terminal as XTerminal } from "@xterm/xterm";
import { loadTerminalSearchAddonModule } from "./useTerminalAddons";

export interface UseTerminalSearchOptions {
  searchOpen: boolean;
  searchQuery: string;
  termRef: React.RefObject<XTerminal | null>;
}

export interface UseTerminalSearchReturn {
  searchRef: React.RefObject<XSearchAddon | null>;
  runSearch: (direction: "next" | "prev") => void;
}

export function useTerminalSearch({
  searchOpen,
  searchQuery,
  termRef,
}: UseTerminalSearchOptions): UseTerminalSearchReturn {
  const searchRef = useRef<XSearchAddon | null>(null);

  useEffect(() => {
    if (!searchOpen || !termRef.current || searchRef.current) {
      return;
    }

    let cancelled = false;
    void loadTerminalSearchAddonModule()
      .then((searchMod) => {
        if (cancelled || !termRef.current || searchRef.current) {
          return;
        }
        const searchAddon = new searchMod.SearchAddon();
        termRef.current.loadAddon(searchAddon);
        searchRef.current = searchAddon;
      })
      .catch(() => {
        // Search stays optional; terminal rendering should not fail if the
        // addon bundle cannot load.
      });

    return () => {
      cancelled = true;
    };
  }, [searchOpen, termRef]);

  const runSearch = useCallback((direction: "next" | "prev") => {
    const addon = searchRef.current;
    if (!addon || searchQuery.trim().length === 0) {
      return;
    }
    if (direction === "next") {
      addon.findNext(searchQuery, { incremental: true, caseSensitive: false });
    } else {
      addon.findPrevious(searchQuery, { incremental: true, caseSensitive: false });
    }
  }, [searchQuery]);

  return { searchRef, runSearch };
}
