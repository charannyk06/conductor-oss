"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Search, FileText } from "lucide-react";
import { fuzzyMatch } from "./utils";

interface QuickSwitcherProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  files: { path: string; name: string; displayPath: string }[];
  onSelect: (path: string) => void;
  recentPaths?: string[];
}

export function QuickSwitcher({
  open,
  onOpenChange,
  files,
  onSelect,
  recentPaths = [],
}: QuickSwitcherProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      // Focus input after a tick
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [open]);

  const results = useMemo(() => {
    if (query.trim().length === 0) {
      // Show recent files when no query
      const recent = recentPaths
        .map((path) => files.find((f) => f.path === path))
        .filter((f): f is NonNullable<typeof f> => f != null);
      if (recent.length > 0) return recent;
      // Otherwise show all
      return files;
    }

    const names = files.map((f) => f.displayPath);
    const matched = fuzzyMatch(query.trim(), names);
    return matched
      .map((m) => files.find((f) => f.displayPath === m.item))
      .filter((f): f is NonNullable<typeof f> => f != null)
      .slice(0, 20);
  }, [query, files, recentPaths]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleSelect = useCallback(
    (path: string) => {
      onSelect(path);
      onOpenChange(false);
    },
    [onSelect, onOpenChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((idx) => Math.min(idx + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((idx) => Math.max(idx - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (results[selectedIndex]) {
          handleSelect(results[selectedIndex].path);
        }
      }
    },
    [results, selectedIndex, handleSelect],
  );

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-[20%] z-50 w-full max-w-lg -translate-x-1/2 rounded-[12px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] shadow-[0_20px_48px_rgba(0,0,0,0.3)]">
          {/* Search input */}
          <div className="flex items-center gap-3 border-b border-[var(--vk-border)] px-4 py-3">
            <Search className="h-4 w-4 shrink-0 text-[var(--vk-text-muted)]" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search notes by name…"
              className="min-w-0 flex-1 bg-transparent text-[14px] text-[var(--vk-text-normal)] outline-none placeholder:text-[var(--vk-text-muted)]"
            />
            <kbd className="rounded-[4px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-1.5 py-0.5 text-[11px] text-[var(--vk-text-muted)]">
              Esc
            </kbd>
          </div>

          {/* Results */}
          <div ref={listRef} className="max-h-[320px] overflow-auto py-1">
            {results.length === 0 ? (
              <div className="px-4 py-6 text-center text-[13px] text-[var(--vk-text-muted)]">
                No notes found
              </div>
            ) : (
              results.map((file, idx) => (
                <button
                  key={file.path}
                  type="button"
                  data-index={idx}
                  onClick={() => handleSelect(file.path)}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={`flex w-full items-center gap-2.5 px-4 py-2 text-left text-[13px] ${
                    idx === selectedIndex
                      ? "bg-[var(--vk-bg-active)] text-[var(--vk-text-strong)]"
                      : "text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
                  }`}
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--vk-text-muted)]" />
                  <span className="truncate">{file.displayPath}</span>
                </button>
              ))
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center gap-4 border-t border-[var(--vk-border)] px-4 py-2 text-[11px] text-[var(--vk-text-muted)]">
            <span>↑↓ Navigate</span>
            <span>↵ Open</span>
            <span>Esc Close</span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
