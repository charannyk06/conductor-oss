const CODE_RABBIT_BLOCK_RE =
  /<!-- This is an auto-generated comment: release notes by coderabbit\.ai -->[\s\S]*?<!-- end of auto-generated comment: release notes by coderabbit\.ai -->/gi;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const CONVENTIONAL_PREFIX_RE = /^[a-z]+(?:\([^)]+\))?!?:\s*/i;
const TITLE_PR_SUFFIX_RE = /\s+\(#\d+\)\s*$/;
const MAX_FALLBACK_NOTE_LENGTH = 240;

const CATEGORY_ORDER = [
  "Breaking Changes",
  "New Features",
  "Improvements",
  "Fixes",
  "Plugin Updates",
  "Documentation",
  "Maintenance",
];

const TYPE_CATEGORY_PRIORITY = {
  "Breaking Changes": 0,
  "New Features": 1,
  "Improvements": 2,
  "Fixes": 3,
  "Plugin Updates": 4,
  "Documentation": 5,
  "Maintenance": 6,
};

const TYPE_LABEL_TO_CATEGORY = new Map([
  ["breaking change", "Breaking Changes"],
  ["new feature", "New Features"],
  ["plugin addition / modification", "Plugin Updates"],
  ["bug fix", "Fixes"],
  ["documentation update", "Documentation"],
  ["refactor / chore", "Maintenance"],
]);

function normalizeTypeLabel(value) {
  const normalized = cleanupInlineMarkdown(value).toLowerCase();
  for (const label of TYPE_LABEL_TO_CATEGORY.keys()) {
    if (normalized === label || normalized.startsWith(`${label} (`)) {
      return label;
    }
  }
  return normalized;
}

function normalizeNewlines(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n");
}

function normalizeHeading(value) {
  return value
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function stripTemplateNoise(markdown) {
  return normalizeNewlines(markdown)
    .replace(CODE_RABBIT_BLOCK_RE, "")
    .replace(HTML_COMMENT_RE, "");
}

function cleanupInlineMarkdown(value) {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sentenceCase(value) {
  if (!value) return value;
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

function normalizeFallbackNarration(value) {
  let normalized = cleanupInlineMarkdown(value);
  const replacements = [
    [/^this fixes\s+/i, "Fixes "],
    [/^this adds\s+/i, "Adds "],
    [/^this introduces\s+/i, "Introduces "],
    [/^this updates\s+/i, "Updates "],
    [/^this (?:pr|pull request|patch|change)\s+fixes\s+/i, "Fixes "],
    [/^this (?:pr|pull request|patch|change)\s+adds\s+/i, "Adds "],
    [/^this (?:pr|pull request|patch|change)\s+introduces\s+/i, "Introduces "],
    [/^this (?:pr|pull request|patch|change)\s+updates\s+/i, "Updates "],
    [/^this (?:pr|pull request|patch|change)\s+/i, ""],
  ];

  for (const [pattern, replacement] of replacements) {
    if (!pattern.test(normalized)) continue;
    normalized = normalized.replace(pattern, replacement);
    break;
  }

  return sentenceCase(normalized);
}

function unique(values) {
  return [...new Set(values)];
}

function extractSection(markdown, headings) {
  const normalizedHeadings = new Set(headings.map(normalizeHeading));
  const lines = stripTemplateNoise(markdown).split("\n");
  let start = -1;
  let level = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(HEADING_RE);
    if (!match) continue;

    const nextLevel = match[1].length;
    const nextHeading = normalizeHeading(match[2]);
    if (!normalizedHeadings.has(nextHeading)) continue;

    start = index + 1;
    level = nextLevel;
    break;
  }

  if (start === -1) {
    return "";
  }

  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    const match = lines[index].match(HEADING_RE);
    if (!match) continue;
    if (match[1].length <= level) {
      end = index;
      break;
    }
  }

  return lines.slice(start, end).join("\n").trim();
}

function parseBullets(section) {
  const lines = normalizeNewlines(section).split("\n");
  const bullets = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const bulletMatch = line.match(/^[-*+]\s+(.*)$/);
    if (bulletMatch && !/^\[[ xX]\]\s+/.test(bulletMatch[1])) {
      if (current) {
        bullets.push(cleanupInlineMarkdown(current));
      }
      current = bulletMatch[1].trim();
      continue;
    }

    if (!line) {
      if (current) {
        bullets.push(cleanupInlineMarkdown(current));
        current = null;
      }
      continue;
    }

    if (current) {
      current += ` ${line}`;
    }
  }

  if (current) {
    bullets.push(cleanupInlineMarkdown(current));
  }

  return bullets.filter(Boolean);
}

function firstParagraph(section) {
  const chunks = stripTemplateNoise(section)
    .split(/\n\s*\n/)
    .map((chunk) => cleanupInlineMarkdown(chunk))
    .filter(Boolean)
    .filter((chunk) => !/^closes\s+#/i.test(chunk));
  return chunks[0] ?? "";
}

function firstNarrativeParagraph(markdown) {
  const chunks = stripTemplateNoise(markdown)
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  for (const chunk of chunks) {
    if (/^#+\s/.test(chunk)) {
      continue;
    }
    if (/^```/.test(chunk)) {
      continue;
    }

    const cleaned = cleanupInlineMarkdown(chunk);
    if (!cleaned || /^closes\s+#/i.test(cleaned)) {
      continue;
    }
    return cleaned;
  }

  return "";
}

function shortenNote(value) {
  const normalized = normalizeFallbackNarration(value);

  if (normalized.length <= MAX_FALLBACK_NOTE_LENGTH) {
    return normalized;
  }

  const sentenceMatch = normalized.match(new RegExp(`^(.{1,${MAX_FALLBACK_NOTE_LENGTH}}[.!?])\\s`));
  if (sentenceMatch?.[1]) {
    return sentenceMatch[1].trim();
  }

  return `${normalized.slice(0, MAX_FALLBACK_NOTE_LENGTH - 3).trim()}...`;
}

function isInternalOnlyMarker(value) {
  const normalized = cleanupInlineMarkdown(value).toLowerCase();
  return normalized === "n/a"
    || normalized === "na"
    || normalized === "none"
    || normalized.startsWith("n/a ")
    || normalized.startsWith("n/a -")
    || normalized.includes("internal maintenance only")
    || normalized.includes("internal only")
    || normalized.includes("no user-facing change")
    || normalized.includes("no user facing change");
}

export function sanitizePrTitle(title) {
  return cleanupInlineMarkdown(
    normalizeNewlines(title)
      .replace(CONVENTIONAL_PREFIX_RE, "")
      .replace(TITLE_PR_SUFFIX_RE, ""),
  );
}

export function extractReleaseNotes(body) {
  const section = extractSection(body, [
    "User-Facing Release Notes",
    "User Facing Release Notes",
    "Release Notes",
    "Public Release Notes",
  ]);

  if (!section) {
    return { explicit: false, internalOnly: false, notes: [] };
  }

  const bullets = parseBullets(section);
  if (bullets.length > 0) {
    const publicNotes = bullets.filter((bullet) => !isInternalOnlyMarker(bullet));
    return {
      explicit: true,
      internalOnly: publicNotes.length === 0 && bullets.some(isInternalOnlyMarker),
      notes: publicNotes,
    };
  }

  const paragraph = firstParagraph(section);
  if (!paragraph) {
    return { explicit: true, internalOnly: false, notes: [] };
  }

  if (isInternalOnlyMarker(paragraph)) {
    return { explicit: true, internalOnly: true, notes: [] };
  }

  return { explicit: true, internalOnly: false, notes: [shortenNote(paragraph)] };
}

export function extractCheckedCategories(body) {
  const section = extractSection(body, ["Type of Change"]);
  if (!section) {
    return [];
  }

  const categories = [];
  for (const line of normalizeNewlines(section).split("\n")) {
    const match = line.trim().match(/^[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (!match || match[1].toLowerCase() !== "x") continue;

    const normalized = normalizeTypeLabel(match[2]);
    const category = TYPE_LABEL_TO_CATEGORY.get(normalized);
    if (category) {
      categories.push(category);
    }
  }

  return unique(categories);
}

export function inferCategoryFromTitle(title) {
  const normalized = normalizeNewlines(title).trim();
  if (/^[a-z]+(?:\([^)]+\))?!:/i.test(normalized) || /breaking change/i.test(normalized)) {
    return "Breaking Changes";
  }
  if (/^feat(?:\([^)]+\))?:/i.test(normalized)) {
    return "New Features";
  }
  if (/^fix(?:\([^)]+\))?:/i.test(normalized)) {
    return "Fixes";
  }
  if (/^(docs|doc)(?:\([^)]+\))?:/i.test(normalized)) {
    return "Documentation";
  }
  if (/^(refactor|perf)(?:\([^)]+\))?:/i.test(normalized)) {
    return "Improvements";
  }
  if (/^(build|ci|chore|test)(?:\([^)]+\))?:/i.test(normalized)) {
    return "Maintenance";
  }
  return "Improvements";
}

export function extractSummaryFallbackNotes(body) {
  const section = extractSection(body, ["Summary", "Overview", "What Changed"]);
  if (section) {
    const bullets = parseBullets(section)
      .filter((bullet) => !/^closes\s+#/i.test(bullet))
      .slice(0, 3)
      .map(shortenNote);

    if (bullets.length > 0) {
      return bullets;
    }

    const paragraph = firstParagraph(section);
    if (paragraph) {
      return [shortenNote(paragraph)];
    }
  }

  const paragraph = firstNarrativeParagraph(body);
  return paragraph ? [shortenNote(paragraph)] : [];
}

function pickCategory(checkedCategories, fallbackCategory) {
  const ranked = checkedCategories
    .slice()
    .sort((left, right) => TYPE_CATEGORY_PRIORITY[left] - TYPE_CATEGORY_PRIORITY[right]);
  return ranked[0] ?? fallbackCategory;
}

export function buildReleaseEntry(pr) {
  const releaseNotes = extractReleaseNotes(pr.body);
  const checkedCategories = extractCheckedCategories(pr.body);
  let category = pickCategory(checkedCategories, inferCategoryFromTitle(pr.title));
  let notes = releaseNotes.notes;

  if (notes.length === 0 && !releaseNotes.internalOnly) {
    notes = extractSummaryFallbackNotes(pr.body);
  }

  if (notes.length === 0 && !releaseNotes.internalOnly) {
    notes = [sanitizePrTitle(pr.title)];
  }

  if (releaseNotes.explicit && releaseNotes.notes.length > 0 && category === "Maintenance") {
    category = "Improvements";
  }

  const internalOnly = releaseNotes.internalOnly || (!releaseNotes.explicit && category === "Maintenance");

  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    category,
    internalOnly,
    notes: unique(notes).filter(Boolean),
  };
}

function formatReleaseBullet(note, entry) {
  return `- ${note} ([#${entry.number}](${entry.url}))`;
}

export function buildReleaseMarkdown({ currentTag, entries, previousTag, repo }) {
  const publicEntries = entries.filter((entry) => !entry.internalOnly && entry.notes.length > 0);
  const lines = ["## What's Changed"];

  if (publicEntries.length === 0) {
    lines.push("");
    lines.push("- Internal maintenance and tooling work only. No user-facing product changes shipped in this release.");
  } else {
    const grouped = new Map();
    for (const category of CATEGORY_ORDER) {
      grouped.set(category, []);
    }

    for (const entry of publicEntries) {
      grouped.get(entry.category)?.push(entry);
    }

    for (const category of CATEGORY_ORDER) {
      const categoryEntries = grouped.get(category) ?? [];
      if (categoryEntries.length === 0) continue;

      lines.push("");
      lines.push(`### ${category}`);
      for (const entry of categoryEntries) {
        for (const note of entry.notes) {
          lines.push(formatReleaseBullet(note, entry));
        }
      }
    }
  }

  if (previousTag) {
    lines.push("");
    lines.push(`**Full Changelog**: [${previousTag}...${currentTag}](https://github.com/${repo}/compare/${previousTag}...${currentTag})`);
  }

  return `${lines.join("\n")}\n`;
}

export function validatePrDescription({ body, title }) {
  const errors = [];
  const releaseNotes = extractReleaseNotes(body);
  const checkedCategories = extractCheckedCategories(body);

  if (!releaseNotes.explicit) {
    errors.push("Add a `## User-Facing Release Notes` section to the PR description.");
  } else if (!releaseNotes.internalOnly && releaseNotes.notes.length === 0) {
    errors.push("Add 1-3 plain-English bullets to `## User-Facing Release Notes`, or mark it `N/A - internal maintenance only`.");
  }

  if (releaseNotes.notes.some((note) => CONVENTIONAL_PREFIX_RE.test(note))) {
    errors.push("Release note bullets must not start with commit prefixes like `feat:` or `fix:`.");
  }

  if (checkedCategories.length === 0) {
    errors.push("Check at least one option in `## Type of Change`.");
  }

  return {
    errors,
    releaseNotes,
    checkedCategories,
    sanitizedTitle: sanitizePrTitle(title),
  };
}
