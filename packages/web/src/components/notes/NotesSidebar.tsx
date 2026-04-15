"use client";

import { useState, useMemo } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Search,
} from "lucide-react";
import type { NoteFile, NotesTreeNode, TagMap } from "./types";
import { buildNotesTree, filterNotesTree, collectFolderPaths } from "./utils";

interface NotesSidebarProps {
  noteFiles: NoteFile[];
  selectedPath: string | null;
  expandedFolders: string[];
  onToggleFolder: (path: string) => void;
  onSelectFile: (path: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
  editorLabel?: string;
  tags?: TagMap;
  onTagClick?: (tag: string) => void;
}

function NotesTree({
  nodes,
  expandedFolders,
  selectedPath,
  onToggleFolder,
  onSelectFile,
  depth = 0,
}: {
  nodes: NotesTreeNode[];
  expandedFolders: Set<string>;
  selectedPath: string | null;
  onToggleFolder: (path: string) => void;
  onSelectFile: (path: string) => void;
  depth?: number;
}) {
  return (
    <>
      {nodes.map((node) => {
        const paddingLeft = 10 + depth * 14;
        if (node.isDirectory) {
          const expanded = expandedFolders.has(node.path);
          return (
            <div key={`${node.path}-${node.name}`}>
              <button
                type="button"
                onClick={() => onToggleFolder(node.path)}
                className="flex w-full items-center gap-1.5 py-1.5 text-left text-[12px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)]"
                style={{ paddingLeft }}
              >
                {expanded ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                )}
                {expanded ? (
                  <FolderOpen className="h-3.5 w-3.5 shrink-0 text-[var(--vk-accent)]" />
                ) : (
                  <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--vk-accent)]" />
                )}
                <span className="truncate">{node.name}</span>
              </button>
              {expanded ? (
                <NotesTree
                  nodes={node.children}
                  expandedFolders={expandedFolders}
                  selectedPath={selectedPath}
                  onToggleFolder={onToggleFolder}
                  onSelectFile={onSelectFile}
                  depth={depth + 1}
                />
              ) : null}
            </div>
          );
        }

        const selected = selectedPath === node.path;
        return (
          <button
            key={node.path}
            type="button"
            onClick={() => onSelectFile(node.path)}
            className={`flex w-full items-center gap-1.5 py-1.5 pr-2 text-left text-[12px] ${
              selected
                ? "bg-[var(--vk-bg-active)] text-[var(--vk-text-strong)]"
                : "text-[var(--vk-text-normal)] hover:bg-[var(--vk-bg-hover)]"
            }`}
            style={{ paddingLeft: paddingLeft + 18 }}
          >
            <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--vk-text-muted)]" />
            <span className="truncate">{node.name}</span>
          </button>
        );
      })}
    </>
  );
}

export function NotesSidebar({
  noteFiles,
  selectedPath,
  expandedFolders,
  onToggleFolder,
  onSelectFile,
  search,
  onSearchChange,
  editorLabel,
  tags,
  onTagClick,
}: NotesSidebarProps) {
  const [tagsExpanded, setTagsExpanded] = useState(true);

  const filteredTree = useMemo(() => {
    const matchingFiles =
      search.trim().length === 0
        ? noteFiles
        : noteFiles.filter((file) => {
            const haystack = `${file.displayPath} ${file.name} ${file.source ?? ""}`.toLowerCase();
            return haystack.includes(search.trim().toLowerCase());
          });
    return filterNotesTree(buildNotesTree(matchingFiles), search);
  }, [noteFiles, search]);

  const tagEntries = useMemo(() => {
    if (!tags) return [];
    return Object.entries(tags).sort((a, b) => b[1].length - a[1].length);
  }, [tags]);

  const folderPathsSet = useMemo(
    () => new Set(expandedFolders),
    [expandedFolders],
  );

  return (
    <aside className="flex min-h-0 flex-col border-r border-[var(--vk-border)] bg-[var(--vk-bg-panel)]/35">
      {/* Search + header */}
      <div className="flex items-center justify-between border-b border-[var(--vk-border)] px-3 py-2 text-[12px] text-[var(--vk-text-muted)]">
        <span>
          {noteFiles.length} note{noteFiles.length === 1 ? "" : "s"}
        </span>
        <span>
          {search.trim().length > 0 ? "Filtered" : editorLabel || "notes"}
        </span>
      </div>

      {/* Search bar */}
      <div className="border-b border-[var(--vk-border)] px-3 py-2">
        <div className="flex items-center gap-2 rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-2.5 py-1.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-[var(--vk-text-muted)]" />
          <input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search notes…"
            className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--vk-text-normal)] outline-none placeholder:text-[var(--vk-text-muted)]"
          />
        </div>
      </div>

      {/* File tree */}
      <div className="min-h-0 flex-1 overflow-auto py-2">
        <NotesTree
          nodes={filteredTree}
          expandedFolders={folderPathsSet}
          selectedPath={selectedPath}
          onToggleFolder={onToggleFolder}
          onSelectFile={onSelectFile}
        />
      </div>

      {/* Tags pane */}
      {tagEntries.length > 0 && (
        <div className="border-t border-[var(--vk-border)]">
          <button
            type="button"
            onClick={() => setTagsExpanded(!tagsExpanded)}
            className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[11px] uppercase tracking-[0.08em] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)]"
          >
            {tagsExpanded ? (
              <ChevronDown className="h-3 w-3 shrink-0" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0" />
            )}
            Tags ({tagEntries.length})
          </button>
          {tagsExpanded && (
            <div className="max-h-[160px] overflow-auto px-3 pb-2">
              <div className="flex flex-wrap gap-1.5">
                {tagEntries.map(([tag, files]) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => onTagClick?.(tag)}
                    className="inline-flex items-center gap-1 rounded-full border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-2 py-0.5 text-[11px] text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)]"
                  >
                    <span className="text-[#f6c56f]">#{tag}</span>
                    <span className="text-[10px] opacity-60">{files.length}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
