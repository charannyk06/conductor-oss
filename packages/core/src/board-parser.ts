import type { ColumnAliasesConfig } from "./types.js";

export type ColumnRole = "intake" | "ready" | "dispatching" | "inProgress" | "review" | "done" | "blocked";

export interface BoardSection {
  heading: string;
  headingLine: number;
  bodyStartLine: number;
  bodyEndLine: number;
  lines: string[];
}

export interface ChecklistItem {
  text: string;
  checked: boolean;
  rawLine: string;
  lineOffset: number;
}

export interface ResolvedBoardColumns {
  aliases: Required<ColumnAliasesConfig>;
  columnsByRole: Record<ColumnRole, string>;
  headings: string[];
}

export const DEFAULT_COLUMN_ALIASES: Required<ColumnAliasesConfig> = {
  intake: ["Inbox", "Backlog", "To do", "To Do", "Todo", "Ideas"],
  ready: ["Ready to Dispatch", "Ready"],
  dispatching: ["Dispatching"],
  inProgress: ["In Progress", "Doing", "In Development"],
  review: ["Review", "In Review"],
  done: ["Done"],
  blocked: ["Blocked"],
};

const ROLES: ColumnRole[] = ["intake", "ready", "dispatching", "inProgress", "review", "done", "blocked"];

function normalizeHeading(value: string): string {
  return value.trim().toLowerCase();
}

function mergeAliases(
  base: Required<ColumnAliasesConfig>,
  override?: ColumnAliasesConfig,
): Required<ColumnAliasesConfig> {
  if (!override) return base;
  const next: Required<ColumnAliasesConfig> = { ...base };
  for (const role of ROLES) {
    const aliases = override[role];
    if (Array.isArray(aliases) && aliases.length > 0) {
      next[role] = aliases;
    }
  }
  return next;
}

export function resolveColumnAliases(
  globalAliases?: ColumnAliasesConfig,
  boardAliases?: ColumnAliasesConfig,
): Required<ColumnAliasesConfig> {
  return mergeAliases(mergeAliases(DEFAULT_COLUMN_ALIASES, globalAliases), boardAliases);
}

export function parseBoardSections(content: string): BoardSection[] {
  const lines = content.split("\n");
  const sections: BoardSection[] = [];

  for (let i = 0; i < lines.length; i++) {
    const headingMatch = lines[i]?.match(/^##\s+(.+)\s*$/);
    if (!headingMatch) continue;

    const heading = (headingMatch[1] ?? "").trim();
    const bodyStartLine = i + 1;
    let end = lines.length;
    for (let j = bodyStartLine; j < lines.length; j++) {
      if (/^##\s+/.test(lines[j] ?? "")) {
        end = j;
        break;
      }
    }

    sections.push({
      heading,
      headingLine: i,
      bodyStartLine,
      bodyEndLine: end,
      lines: lines.slice(bodyStartLine, end),
    });

    i = end - 1;
  }

  return sections;
}

export function getSectionByHeading(content: string, heading: string): BoardSection | null {
  const target = normalizeHeading(heading);
  for (const section of parseBoardSections(content)) {
    if (normalizeHeading(section.heading) === target) return section;
  }
  return null;
}

export function getSectionsByAliases(content: string, aliases: string[]): BoardSection[] {
  const normalized = new Set(aliases.map((alias) => normalizeHeading(alias)));
  return parseBoardSections(content).filter((section) => normalized.has(normalizeHeading(section.heading)));
}

export function resolveColumnsFromBoard(
  content: string,
  aliases: Required<ColumnAliasesConfig>,
): ResolvedBoardColumns {
  const headings = parseBoardSections(content).map((section) => section.heading);
  const headingMap = new Map(headings.map((heading) => [normalizeHeading(heading), heading]));

  const columnsByRole = {} as Record<ColumnRole, string>;
  for (const role of ROLES) {
    let picked = aliases[role][0] ?? role;
    for (const alias of aliases[role]) {
      const hit = headingMap.get(normalizeHeading(alias));
      if (hit) {
        picked = hit;
        break;
      }
    }
    columnsByRole[role] = picked;
  }

  return { aliases, columnsByRole, headings };
}

function isChecklistLine(line: string): { checked: boolean; text: string } | null {
  const match = parseChecklistPrefix(line);
  if (!match) return null;

  const text = line.slice(match.textStart).trim();
  if (!text) return null;

  return {
    checked: match.checked,
    text,
  };
}

function isContinuationLine(line: string): boolean {
  if (!line.trim()) return false;
  if (/^\s*##\s+/.test(line)) return false;
  if (parseChecklistPrefix(line)) return false;
  return /^\s+/.test(line) || /^\s*>\s+/.test(line);
}

export function parseChecklistItems(section: BoardSection): ChecklistItem[] {
  const items: ChecklistItem[] = [];

  for (let i = 0; i < section.lines.length; i++) {
    const parsed = isChecklistLine(section.lines[i] ?? "");
    if (!parsed) continue;

    let text = parsed.text;
    for (let j = i + 1; j < section.lines.length; j++) {
      const nextLine = section.lines[j] ?? "";
      if (!isContinuationLine(nextLine)) break;
      const normalized = nextLine.trimStart().replace(/^>\s?/, "").trim();
      if (normalized) {
        text += ` ${normalized}`;
      }
    }

    items.push({
      text: text.replace(/\s+/g, " ").trim(),
      checked: parsed.checked,
      rawLine: section.lines[i] ?? "",
      lineOffset: i,
    });
  }

  return items;
}

export function getUncheckedTasks(content: string, heading: string): string[] {
  const section = getSectionByHeading(content, heading);
  if (!section) return [];
  return parseChecklistItems(section)
    .filter((item) => !item.checked)
    .map((item) => item.text);
}

export function getTrackedCardLines(content: string, headings: string[]): Array<{ line: string; column: string }> {
  const normalized = new Set(headings.map((heading) => normalizeHeading(heading)));
  const out: Array<{ line: string; column: string }> = [];

  for (const section of parseBoardSections(content)) {
    if (!normalized.has(normalizeHeading(section.heading))) continue;
    for (const line of section.lines) {
      if (!parseChecklistPrefix(line)) continue;
      out.push({ line, column: section.heading });
    }
  }

  return out;
}

interface ChecklistMatch {
  checked: boolean;
  textStart: number;
}

/** Parse and normalize a checklist line prefix without regex backtracking risk. */
function parseChecklistPrefix(line: string): ChecklistMatch | null {
  let index = 0;
  const len = line.length;

  while (index < len && isInlineWhitespace(line.charCodeAt(index))) {
    index += 1;
  }

  if (line[index] === ">") {
    index += 1;
    while (index < len && isInlineWhitespace(line.charCodeAt(index))) {
      index += 1;
    }
  }

  const bullet = line.charCodeAt(index);
  if (bullet !== 0x2d && bullet !== 0x2a && bullet !== 0x2b) {
    return null;
  }
  index += 1;

  if (!isInlineWhitespace(line.charCodeAt(index))) return null;
  while (isInlineWhitespace(line.charCodeAt(index))) {
    index += 1;
  }

  if (line.charCodeAt(index) !== 0x5b) return null;
  const mark = line.charCodeAt(index + 1);
  if (mark !== 0x20 && mark !== 0x78 && mark !== 0x58) return null;
  if (line.charCodeAt(index + 2) !== 0x5d) return null;
  index += 3;

  if (!isInlineWhitespace(line.charCodeAt(index))) return null;
  while (isInlineWhitespace(line.charCodeAt(index))) {
    index += 1;
  }

  return {
    checked: mark !== 0x20,
    textStart: index,
  };
}

function isInlineWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09;
}

export function moveUncheckedTask(
  content: string,
  taskText: string,
  fromHeading: string,
  toHeading: string,
  newCardText?: string,
): { content: string; moved: boolean } {
  const lines = content.split("\n");
  const from = getSectionByHeading(content, fromHeading);
  const to = getSectionByHeading(content, toHeading);
  if (!from || !to) return { content, moved: false };

  const items = parseChecklistItems(from).filter((item) => !item.checked);
  const target = items.find((item) => item.text === taskText);
  if (!target) return { content, moved: false };

  const removeAt = from.bodyStartLine + target.lineOffset;
  lines.splice(removeAt, 1);

  const line = `- [x] ${newCardText ?? taskText}`;
  const insertAt = to.bodyStartLine;
  lines.splice(insertAt, 0, line);

  return { content: lines.join("\n"), moved: true };
}

export function moveCardLine(
  content: string,
  oldLine: string,
  fromHeading: string,
  toHeading: string,
  newLine?: string,
): { content: string; moved: boolean } {
  const lines = content.split("\n");
  const from = getSectionByHeading(content, fromHeading);
  const to = getSectionByHeading(content, toHeading);
  if (!from || !to) return { content, moved: false };

  let removeAt = -1;
  for (let i = from.bodyStartLine; i < from.bodyEndLine; i++) {
    if ((lines[i] ?? "") === oldLine) {
      removeAt = i;
      break;
    }
  }
  if (removeAt === -1) return { content, moved: false };

  lines.splice(removeAt, 1);
  lines.splice(to.bodyStartLine, 0, newLine ?? oldLine);

  return { content: lines.join("\n"), moved: true };
}

export function replaceLine(content: string, oldLine: string, newLine: string): string {
  const lines = content.split("\n");
  const idx = lines.findIndex((line) => line === oldLine);
  if (idx === -1) return content;
  lines[idx] = newLine;
  return lines.join("\n");
}
