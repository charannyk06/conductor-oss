import type { NoteFile, NotesTreeNode } from "./types";

export function buildNotesTree(files: NoteFile[]): NotesTreeNode[] {
  const root: NotesTreeNode = {
    name: "",
    path: "",
    isDirectory: true,
    children: [],
  };

  for (const file of files) {
    const normalizedDisplayPath = file.displayPath.replace(/^\/+/, "");
    const parts = normalizedDisplayPath.split("/").filter(Boolean);
    if (parts.length === 0) {
      continue;
    }

    let current = root;
    let currentPath = "";
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isLast = index === parts.length - 1;
      let child = current.children.find((candidate) => candidate.name === part && candidate.isDirectory !== isLast);
      if (!child) {
        child = {
          name: part,
          path: isLast ? file.path : currentPath,
          isDirectory: !isLast,
          file: isLast ? file : undefined,
          children: [],
        };
        current.children.push(child);
      }
      current = child;
    }
  }

  const sortTree = (nodes: NotesTreeNode[]) => {
    nodes.sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) {
        return left.isDirectory ? -1 : 1;
      }
      return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    });
    for (const node of nodes) {
      if (node.children.length > 0) {
        sortTree(node.children);
      }
    }
  };

  sortTree(root.children);
  return root.children;
}

export function filterNotesTree(nodes: NotesTreeNode[], query: string): NotesTreeNode[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return nodes;
  }

  const filterNode = (node: NotesTreeNode): NotesTreeNode | null => {
    const haystack = `${node.name} ${node.file?.displayPath ?? ""}`.toLowerCase();
    const childMatches = node.children
      .map((child) => filterNode(child))
      .filter((child): child is NotesTreeNode => Boolean(child));
    if (haystack.includes(normalizedQuery) || childMatches.length > 0) {
      return {
        ...node,
        children: childMatches,
      };
    }
    return null;
  };

  return nodes
    .map((node) => filterNode(node))
    .filter((node): node is NotesTreeNode => Boolean(node));
}

export function collectFolderPaths(nodes: NotesTreeNode[]): string[] {
  const paths: string[] = [];
  const visit = (node: NotesTreeNode) => {
    if (node.isDirectory) {
      paths.push(node.path);
      node.children.forEach(visit);
    }
  };
  nodes.forEach(visit);
  return paths;
}

export function formatTimestamp(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString();
}

export function formatBytes(value: number | null | undefined): string {
  if (!value || value <= 0) {
    return "";
  }
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function normalizeNewNotePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized) {
    return "";
  }
  if (/\.(md|markdown|mdx|txt)$/i.test(normalized)) {
    return normalized;
  }
  return `${normalized}.md`;
}

export function buildNewNoteSeedContent(notePath: string): string {
  const fileName = notePath.split("/").pop() ?? "Note";
  const heading = fileName.replace(/\.(md|markdown|mdx|txt)$/i, "").replace(/[-_]+/g, " ").trim();
  if (!heading) {
    return "";
  }
  return `# ${heading.charAt(0).toUpperCase()}${heading.slice(1)}\n\n`;
}

export function extractWikilinks(text: string): string[] {
  const matches = text.matchAll(/\[\[([^\]]+)\]\]/g);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const match of matches) {
    const target = match[1].trim();
    if (target && !seen.has(target)) {
      seen.add(target);
      result.push(target);
    }
  }
  return result;
}

export function extractTags(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const lines = text.split("\n");
  for (const line of lines) {
    // Find inline tags: #tag but not # heading (must not be at start of line followed by space)
    const tagMatches = line.matchAll(/(?:^|[\s(])(#([a-zA-Z][\w/-]*))/g);
    for (const match of tagMatches) {
      const fullMatch = match[1];
      const tagName = match[2];
      // Skip if it looks like a markdown heading (# at start of line followed by space)
      if (fullMatch.startsWith("#") && match.index === 0 && line.startsWith("# ")) continue;
      if (tagName && !seen.has(tagName)) {
        seen.add(tagName);
        result.push(tagName);
      }
    }
  }
  return result;
}

export function resolveWikilinkTarget(name: string, files: NoteFile[]): string | null {
  // Try exact path match
  const exactPath = files.find((f) => f.path === name);
  if (exactPath) return exactPath.path;

  // Try name match
  const byName = files.find((f) => f.name === name || f.name === `${name}.md`);
  if (byName) return byName.path;

  // Try display path match
  const byDisplay = files.find((f) => f.displayPath === name);
  if (byDisplay) return byDisplay.path;

  // Try case-insensitive name match
  const lowerName = name.toLowerCase();
  const byLower = files.find(
    (f) => f.name.toLowerCase() === lowerName || f.name.toLowerCase() === `${lowerName}.md`,
  );
  if (byLower) return byLower.path;

  // Try partial match on display path
  const byPartial = files.find((f) => f.displayPath.toLowerCase().endsWith(`/${lowerName}.md`) || f.displayPath.toLowerCase() === `${lowerName}.md`);
  if (byPartial) return byPartial.path;

  return null;
}

export interface FuzzyMatchResult {
  item: string;
  score: number;
}

export function fuzzyMatch(query: string, items: string[]): FuzzyMatchResult[] {
  const lowerQuery = query.toLowerCase();
  const results: FuzzyMatchResult[] = [];

  for (const item of items) {
    const lowerItem = item.toLowerCase();
    let score = 0;
    let queryIdx = 0;

    // Exact substring match gets highest score
    if (lowerItem.includes(lowerQuery)) {
      score = 100 - lowerItem.indexOf(lowerQuery);
    } else {
      // Character-by-character fuzzy match
      for (let i = 0; i < lowerItem.length && queryIdx < lowerQuery.length; i++) {
        if (lowerItem[i] === lowerQuery[queryIdx]) {
          score += 1;
          queryIdx += 1;
        }
      }
      if (queryIdx < lowerQuery.length) {
        // Didn't match all characters
        continue;
      }
    }

    results.push({ item, score });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}
