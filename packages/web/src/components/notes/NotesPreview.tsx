"use client";

import { useMemo, type ReactNode, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { NoteFile } from "./types";
import { resolveWikilinkTarget } from "./utils";

interface NotesPreviewProps {
  content: string;
  onWikilinkClick?: (target: string) => void;
  noteFiles?: NoteFile[];
}

function preprocessWikilinks(
  markdown: string,
  onWikilinkClick?: (target: string) => void,
  noteFiles?: NoteFile[],
): ReactNode[] {
  const parts: ReactNode[] = [];
  const regex = /(\[\[([^\]]+)\]\])|(#([a-zA-Z][\w/-]*))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = regex.exec(markdown)) !== null) {
    // Add text before this match
    if (match.index > lastIndex) {
      parts.push(markdown.slice(lastIndex, match.index));
    }

    if (match[1]) {
      // Wikilink [[target]]
      const target = match[2].trim();
      const resolved = noteFiles ? resolveWikilinkTarget(target, noteFiles) : null;
      const isUnresolved = !resolved;
      parts.push(
        <span
          key={`wl-${key++}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onWikilinkClick?.(target);
          }}
          style={{
            backgroundColor: isUnresolved ? "rgba(255, 143, 122, 0.12)" : "rgba(139, 92, 246, 0.15)",
            borderRadius: "3px",
            padding: "1px 5px",
            cursor: "pointer",
            color: isUnresolved ? "var(--vk-red, #ff8f7a)" : "#cdb4ff",
            fontSize: "0.9em",
          }}
        >
          {target}
        </span>,
      );
    } else if (match[3]) {
      // Tag #tag
      // Check if it's a heading (# at start of line followed by space)
      const tagStr = match[3];
      const preChar = match.index > 0 ? markdown[match.index - 1] : "\n";
      const isHeading = (match.index === 0 || preChar === "\n") && markdown[match.index + tagStr.length] === " ";

      if (isHeading) {
        parts.push(tagStr);
      } else {
        const tagName = match[4];
        parts.push(
          <span
            key={`tag-${key++}`}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              // Could trigger tag filtering
            }}
            style={{
              backgroundColor: "rgba(248, 147, 30, 0.12)",
              borderRadius: "3px",
              padding: "1px 5px",
              cursor: "pointer",
              color: "#f6c56f",
              fontSize: "0.85em",
            }}
          >
            #{tagName}
          </span>,
        );
      }
    }

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < markdown.length) {
    parts.push(markdown.slice(lastIndex));
  }

  return parts.length > 0 ? parts : [markdown];
}

export function NotesPreview({ content, onWikilinkClick, noteFiles }: NotesPreviewProps) {
  const processedContent = useMemo(() => {
    if (!content.trim()) return "";
    return content;
  }, [content]);

  if (!content.trim()) {
    return (
      <div className="flex h-full min-h-[240px] items-center justify-center text-center text-[13px] text-[var(--vk-text-muted)]">
        Markdown preview will appear here once the note has content.
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-[var(--vk-bg-panel)]/25 px-4 py-4">
      <article className="prose prose-invert max-w-none text-[14px] leading-7 text-[var(--vk-text-normal)] prose-headings:text-[var(--vk-text-strong)] prose-strong:text-[var(--vk-text-strong)] prose-code:text-[var(--vk-accent)] prose-pre:bg-[var(--vk-bg-main)] prose-blockquote:border-l-[var(--vk-accent)] prose-blockquote:text-[var(--vk-text-muted)]">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            // Process text nodes to render wikilinks and tags
            p: ({ children, ...props }: ComponentPropsWithoutRef<"p">) => {
              return <p {...props}>{processChildren(children, onWikilinkClick, noteFiles)}</p>;
            },
            li: ({ children, ...props }: ComponentPropsWithoutRef<"li">) => {
              return <li {...props}>{processChildren(children, onWikilinkClick, noteFiles)}</li>;
            },
          }}
        >
          {processedContent}
        </ReactMarkdown>
      </article>
    </div>
  );
}

function processChildren(
  children: ReactNode,
  onWikilinkClick?: (target: string) => void,
  noteFiles?: NoteFile[],
): ReactNode {
  if (typeof children === "string") {
    const nodes = preprocessWikilinks(children, onWikilinkClick, noteFiles);
    return nodes.length === 1 ? nodes[0] : <>{nodes}</>;
  }
  if (Array.isArray(children)) {
    return children.map((child, idx) => {
      if (typeof child === "string") {
        const nodes = preprocessWikilinks(child, onWikilinkClick, noteFiles);
        return nodes.length === 1 ? (
          <span key={idx}>{nodes[0]}</span>
        ) : (
          <span key={idx}>{nodes}</span>
        );
      }
      return child;
    });
  }
  return children;
}
