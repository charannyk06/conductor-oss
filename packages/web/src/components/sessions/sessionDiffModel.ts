export type ReviewDiffStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copy"
  | "binary"
  | "untracked"
  | "unknown";

export type DiffCategory = "against-base" | "staged" | "unstaged" | "untracked";

export interface ChangedFileSummary {
  path: string;
  oldPath?: string | null;
  status: ReviewDiffStatus;
  additions: number;
  deletions: number;
}

export interface ReviewDiffSections {
  againstBase: ChangedFileSummary[];
  staged: ChangedFileSummary[];
  unstaged: ChangedFileSummary[];
  untracked: ChangedFileSummary[];
}

export interface FlattenedFileEntry {
  category: DiffCategory;
  categories: DiffCategory[];
  file: ChangedFileSummary;
  fileKey: string;
}

export const SECTION_ORDER: DiffCategory[] = ["against-base", "staged", "unstaged", "untracked"];

const PREFERRED_CATEGORY_ORDER: DiffCategory[] = ["against-base", "unstaged", "staged", "untracked"];

function getSectionFiles(sections: ReviewDiffSections, category: DiffCategory): ChangedFileSummary[] {
  if (category === "against-base") {
    return sections.againstBase;
  }
  return sections[category];
}

export function createFlattenedFileKey(file: ChangedFileSummary): string {
  return `${file.oldPath ?? ""}:${file.path}`;
}

export function flattenSectionEntries(sections: ReviewDiffSections): FlattenedFileEntry[] {
  const preferredOrder = new Map(
    PREFERRED_CATEGORY_ORDER.map((category, index) => [category, index] as const),
  );
  const sectionOrder = new Map(SECTION_ORDER.map((category, index) => [category, index] as const));
  const flattened = new Map<string, FlattenedFileEntry>();

  for (const category of SECTION_ORDER) {
    for (const file of getSectionFiles(sections, category)) {
      const fileKey = createFlattenedFileKey(file);
      const existing = flattened.get(fileKey);

      if (!existing) {
        flattened.set(fileKey, {
          category,
          categories: [category],
          file,
          fileKey,
        });
        continue;
      }

      if (!existing.categories.includes(category)) {
        existing.categories.push(category);
      }

      const existingRank = preferredOrder.get(existing.category) ?? Number.MAX_SAFE_INTEGER;
      const nextRank = preferredOrder.get(category) ?? Number.MAX_SAFE_INTEGER;
      if (nextRank < existingRank) {
        existing.category = category;
        existing.file = file;
      }
    }
  }

  return [...flattened.values()]
    .map((entry) => ({
      ...entry,
      categories: [...entry.categories].sort(
        (left, right) =>
          (sectionOrder.get(left) ?? Number.MAX_SAFE_INTEGER)
          - (sectionOrder.get(right) ?? Number.MAX_SAFE_INTEGER),
      ),
    }))
    .sort((left, right) => {
      const pathCompare = left.file.path.localeCompare(right.file.path, undefined, { sensitivity: "base" });
      if (pathCompare !== 0) return pathCompare;
      return (left.file.oldPath ?? "").localeCompare(right.file.oldPath ?? "", undefined, { sensitivity: "base" });
    });
}

export function filterFlattenedEntries(
  entries: FlattenedFileEntry[],
  query: string,
): FlattenedFileEntry[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return entries;
  }

  return entries.filter((entry) => {
    const oldPath = entry.file.oldPath ?? "";
    return entry.file.path.toLowerCase().includes(normalizedQuery)
      || oldPath.toLowerCase().includes(normalizedQuery);
  });
}

export function summarizeFlattenedEntries(entries: FlattenedFileEntry[]): {
  files: number;
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;

  for (const entry of entries) {
    additions += entry.file.additions;
    deletions += entry.file.deletions;
  }

  return {
    files: entries.length,
    additions,
    deletions,
  };
}
