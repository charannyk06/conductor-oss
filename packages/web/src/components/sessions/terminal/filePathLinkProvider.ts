import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";

type ParsedTerminalFileLink = {
  path: string;
  line?: number;
  column?: number;
  startIndex: number;
  endIndex: number;
};

type WrappedLineSegment = {
  bufferLineNumber: number;
  startIndex: number;
  endIndex: number;
  text: string;
};

// Anchored path pattern: requires an explicit prefix (./  ../  ~/  /  C:\) or a
// directory separator before the filename to prevent catastrophic backtracking
// on long strings of path-like characters without an extension.
const FILE_LINK_PATTERN = /(?:\.{1,2}\/|~\/|\/|[A-Za-z]:[\\/])[A-Za-z0-9._-]+(?:[\\/][A-Za-z0-9._-]+)*(?:\.[A-Za-z0-9_-]+)?(?::\d+)?(?::\d+)?/g;
const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?)]*$/;

function tokenContainsUrl(text: string, start: number, end: number): boolean {
  if (start < 0) {
    return false;
  }

  let tokenStart = start;
  while (tokenStart > 0 && !/\s/.test(text[tokenStart - 1] ?? "")) {
    tokenStart -= 1;
  }

  let tokenEnd = end;
  while (tokenEnd < text.length && !/\s/.test(text[tokenEnd] ?? "")) {
    tokenEnd += 1;
  }

  return text.slice(tokenStart, tokenEnd).includes("://");
}

function trimTrailingPunctuation(value: string): string {
  return value.replace(TRAILING_PUNCTUATION_PATTERN, "");
}

function normalizeMatchedPath(path: string): string {
  if (
    (path.startsWith("a/") || path.startsWith("b/"))
    && path.length > 2
    && !path.startsWith("a://")
    && !path.startsWith("b://")
  ) {
    return path.slice(2);
  }
  return path;
}

export function parseTerminalFileLinks(text: string): ParsedTerminalFileLink[] {
  const links: ParsedTerminalFileLink[] = [];

  for (const match of text.matchAll(FILE_LINK_PATTERN)) {
    const rawMatch = match[0];
    const startIndex = match.index ?? -1;
    if (startIndex < 0) {
      continue;
    }

    const trimmedMatch = trimTrailingPunctuation(rawMatch);
    if (trimmedMatch.length === 0 || trimmedMatch.includes("://")) {
      continue;
    }

    const matchEnd = startIndex + rawMatch.length;
    if (tokenContainsUrl(text, startIndex, matchEnd)) {
      continue;
    }

    const locationMatch = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(trimmedMatch);
    if (!locationMatch) {
      continue;
    }

    const rawPath = normalizeMatchedPath(locationMatch[1] ?? "");
    if (!rawPath) {
      continue;
    }

    const line = locationMatch[2] ? Number.parseInt(locationMatch[2], 10) : undefined;
    const column = locationMatch[3] ? Number.parseInt(locationMatch[3], 10) : undefined;
    const hasDirectoryHint =
      rawPath.includes("/")
      || rawPath.includes("\\")
      || rawPath.startsWith("./")
      || rawPath.startsWith("../")
      || rawPath.startsWith("~/")
      || rawPath.startsWith("/");
    if (!hasDirectoryHint && line === undefined) {
      continue;
    }

    links.push({
      path: rawPath,
      line,
      column,
      startIndex,
      endIndex: startIndex + trimmedMatch.length,
    });
  }

  return links;
}

function collectWrappedLineSegments(
  terminal: Terminal,
  bufferLineNumber: number,
): WrappedLineSegment[] {
  const lineIndex = bufferLineNumber - 1;
  let startIndex = lineIndex;
  while (startIndex > 0) {
    const current = terminal.buffer.active.getLine(startIndex);
    if (!current?.isWrapped) {
      break;
    }
    startIndex -= 1;
  }

  let endIndex = lineIndex;
  while (true) {
    const next = terminal.buffer.active.getLine(endIndex + 1);
    if (!next?.isWrapped) {
      break;
    }
    endIndex += 1;
  }

  const segments: WrappedLineSegment[] = [];
  let combinedOffset = 0;

  for (let currentIndex = startIndex; currentIndex <= endIndex; currentIndex += 1) {
    const line = terminal.buffer.active.getLine(currentIndex);
    if (!line) {
      continue;
    }
    const text = line.translateToString(true);
    segments.push({
      bufferLineNumber: currentIndex + 1,
      startIndex: combinedOffset,
      endIndex: combinedOffset + text.length,
      text,
    });
    combinedOffset += text.length;
  }

  return segments;
}

function resolveRangePosition(
  absoluteIndex: number,
  segments: WrappedLineSegment[],
  preferNextSegmentOnBoundary: boolean,
): { x: number; y: number } | null {
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment) {
      continue;
    }
    if (absoluteIndex < segment.endIndex) {
      return {
        x: absoluteIndex - segment.startIndex + 1,
        y: segment.bufferLineNumber,
      };
    }
    if (absoluteIndex === segment.endIndex) {
      if (preferNextSegmentOnBoundary) {
        const nextSegment = segments[index + 1];
        if (nextSegment) {
          return {
            x: 1,
            y: nextSegment.bufferLineNumber,
          };
        }
      }
      return {
        x: segment.text.length + 1,
        y: segment.bufferLineNumber,
      };
    }
  }

  const lastSegment = segments[segments.length - 1];
  if (!lastSegment) {
    return null;
  }
  return {
    x: lastSegment.text.length + 1,
    y: lastSegment.bufferLineNumber,
  };
}

function buildLinkRange(
  link: ParsedTerminalFileLink,
  segments: WrappedLineSegment[],
): ILink["range"] | null {
  const start = resolveRangePosition(link.startIndex, segments, false);
  const end = resolveRangePosition(link.endIndex, segments, true);
  if (!start || !end) {
    return null;
  }
  return { start, end };
}

export class TerminalFilePathLinkProvider implements ILinkProvider {
  constructor(
    private readonly terminal: Terminal,
    private readonly onOpen: (path: string, line?: number, column?: number) => void | Promise<void>,
  ) {}

  provideLinks(
    bufferLineNumber: number,
    callback: (links: ILink[] | undefined) => void,
  ): void {
    const segments = collectWrappedLineSegments(this.terminal, bufferLineNumber);
    const currentSegment = segments.find((segment) => segment.bufferLineNumber === bufferLineNumber);
    if (!currentSegment) {
      callback(undefined);
      return;
    }

    const combinedText = segments.map((segment) => segment.text).join("");
    const links = parseTerminalFileLinks(combinedText)
      .filter((link) => link.endIndex > currentSegment.startIndex && link.startIndex < currentSegment.endIndex)
      .map<ILink | null>((link) => {
        const range = buildLinkRange(link, segments);
        if (!range) {
          return null;
        }

        return {
          range,
          text: combinedText.slice(link.startIndex, link.endIndex),
          activate: (event: MouseEvent) => {
            if (!event.metaKey && !event.ctrlKey) {
              return;
            }
            event.preventDefault();
            void this.onOpen(link.path, link.line, link.column);
          },
        };
      })
      .filter((link): link is ILink => link !== null);

    callback(links.length > 0 ? links : undefined);
  }
}
