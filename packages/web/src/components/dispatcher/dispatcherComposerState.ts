export type DispatcherContextFile = {
  path: string;
  displayPath?: string;
  name: string;
  kind: "image" | "file";
  source?: string;
  sizeBytes?: number | null;
};

function normalizePath(value: string): string {
  return value.trim();
}

export function normalizeDispatcherAttachmentPaths(paths: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const rawPath of paths) {
    const path = normalizePath(rawPath);
    if (!path || seen.has(path)) {
      continue;
    }
    seen.add(path);
    normalized.push(path);
  }

  return normalized;
}

export function resolveDispatcherAttachmentLabel(
  path: string,
  file: DispatcherContextFile | null | undefined,
): string {
  const displayPath = file?.displayPath?.trim();
  if (displayPath) {
    return displayPath;
  }
  const name = file?.name?.trim();
  if (name) {
    return name;
  }
  return normalizePath(path);
}

export function filterDispatcherContextFiles(
  files: readonly DispatcherContextFile[],
  query: string,
): DispatcherContextFile[] {
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery
    ? files.filter((file) => {
      const haystack = `${file.path} ${file.displayPath ?? ""} ${file.name} ${file.source ?? ""}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    })
    : [...files];

  const unique = new Map<string, DispatcherContextFile>();
  for (const file of filtered) {
    if (!unique.has(file.path)) {
      unique.set(file.path, file);
    }
  }

  return [...unique.values()];
}

export function buildDispatcherSendBody(
  message: string,
  attachments: readonly string[],
): {
  message: string;
  attachments?: string[];
} {
  const normalizedAttachments = normalizeDispatcherAttachmentPaths(attachments);
  return normalizedAttachments.length > 0
    ? {
      message: message.trim(),
      attachments: normalizedAttachments,
    }
    : {
      message: message.trim(),
    };
}

export function canSendDispatcherDraft(input: {
  message: string;
  attachments: readonly string[];
  canContinue: boolean;
  sending: boolean;
  isActiveInstalled: boolean;
}): boolean {
  if (!input.canContinue || input.sending || !input.isActiveInstalled) {
    return false;
  }

  return input.message.trim().length > 0
    || normalizeDispatcherAttachmentPaths(input.attachments).length > 0;
}

export function shouldSendDispatcherComposerOnEnter(input: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  isDesktopXl: boolean;
}): boolean {
  return input.key === "Enter"
    && !input.shiftKey
    && !input.isComposing
    && !input.isDesktopXl;
}
