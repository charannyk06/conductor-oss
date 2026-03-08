"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ComponentProps,
  type KeyboardEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  Code2,
  FileSearch2,
  FileText,
  Globe,
  ListTodo,
  Loader2,
  Paperclip,
  PencilLine,
  Search,
  Shield,
  TerminalSquare,
  UserRound,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { AgentTileIcon } from "@/components/AgentTileIcon";
import { useAgents } from "@/hooks/useAgents";
import { useSessionFeed } from "@/hooks/useSessionFeed";
import type { NormalizedChatEntry } from "@/lib/chatFeed";
import { normalizeAgentName } from "@/lib/agentUtils";
import { getAvailableAgentModels, resolveAgentModelAccess } from "@conductor-oss/core/types";

interface ChatPanelProps {
  sessionId: string;
  agentName?: string | null;
  projectId?: string | null;
  sessionModel?: string | null;
  sessionReasoningEffort?: string | null;
}

interface AttachmentDraft {
  file: File;
}

interface ModelOption {
  id: string;
  label: string;
  helper: string;
}

interface SlashCommandOption {
  command: string;
  label: string;
  description: string;
  exact?: boolean;
}

const COMMON_SLASH_COMMANDS: SlashCommandOption[] = [
  {
    command: "/help",
    label: "/help",
    description: "Show the agent help and available commands.",
  },
  {
    command: "/model",
    label: "/model",
    description: "Inspect or switch the active model.",
  },
  {
    command: "/clear",
    label: "/clear",
    description: "Clear the current agent conversation context.",
  },
  {
    command: "/review",
    label: "/review",
    description: "Ask the agent to review current changes.",
  },
  {
    command: "/diff",
    label: "/diff",
    description: "Inspect the current diff from inside the agent.",
  },
];

function formatCurrentModelLabel(agentName: string, modelId: string): string {
  const normalizedModel = modelId.trim();
  const normalizedAgent = normalizeAgentName(agentName);
  if (!normalizedModel) return normalizedModel;

  if (normalizedAgent === "claude-code") {
    const lower = normalizedModel.toLowerCase();
    if (lower === "opus") return "Claude Opus";
    if (lower === "sonnet") return "Claude Sonnet";
    if (lower === "haiku") return "Claude Haiku";
    const match = lower.match(/^claude-(sonnet|opus|haiku)-(\d+)-(\d+)(?:-\d{8})?$/);
    if (match) {
      const family = match[1];
      return `Claude ${family[0]?.toUpperCase() + family.slice(1)} ${match[2]}.${match[3]}`;
    }
  }

  return normalizedModel
    .split(/[-_]+/g)
    .filter(Boolean)
    .map((segment) => {
      const lower = segment.toLowerCase();
      if (lower === "gpt") return "GPT";
      if (/^\d+(?:\.\d+)?$/.test(segment)) return segment;
      return segment[0]?.toUpperCase() + segment.slice(1);
    })
    .join("-");
}

function getModelOptions(
  agents: ReturnType<typeof useAgents>["agents"],
  agentName: string,
  currentModel: string,
): ModelOption[] {
  const options = new Map<string, ModelOption>();
  const normalizedAgentName = normalizeAgentName(agentName);

  const fallbackModels = getAvailableAgentModels(agentName, undefined);
  for (const model of fallbackModels) {
    const id = model.id.trim();
    if (!id || options.has(id)) continue;
    options.set(id, {
      id,
      label: model.label.trim() || id,
      helper: "Built-in catalog",
    });
  }

  for (const agent of agents) {
    if (normalizedAgentName && normalizeAgentName(agent.name) !== normalizedAgentName) {
      continue;
    }
    const catalog = agent.runtimeModelCatalog;
    if (!catalog) continue;

    const modelsByAccess = catalog.modelsByAccess;
    if (!modelsByAccess) continue;

    for (const modelList of Object.values(modelsByAccess)) {
      if (!Array.isArray(modelList)) continue;
      for (const model of modelList) {
        const id = typeof model.id === "string" ? model.id.trim() : "";
        if (!id || options.has(id)) continue;
        const label = typeof model.label === "string" && model.label.trim().length > 0 ? model.label.trim() : id;
        const helper = typeof agent.name === "string" && agent.name.trim().length > 0 ? agent.name.trim() : "Runtime catalog";
        options.set(id, { id, label, helper });
      }
    }
  }

  if (currentModel.trim() && !options.has(currentModel.trim())) {
    options.set(currentModel.trim(), {
      id: currentModel.trim(),
      label: formatCurrentModelLabel(agentName, currentModel),
      helper: "Current session model",
    });
  }

  return [...options.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function getSlashCommandOptions(agentName: string, message: string): SlashCommandOption[] {
  const normalizedMessage = message.trimStart();
  if (!normalizedMessage.startsWith("/")) {
    return [];
  }

  const normalizedAgent = agentName.trim() || "agent";
  const query = normalizedMessage.toLowerCase();
  const options = new Map<string, SlashCommandOption>();

  options.set(normalizedMessage, {
    command: normalizedMessage,
    label: normalizedMessage,
    description: `Send this raw slash command directly to ${normalizedAgent}.`,
    exact: true,
  });

  for (const option of COMMON_SLASH_COMMANDS) {
    const haystack = `${option.command} ${option.label} ${option.description}`.toLowerCase();
    if (!query || haystack.includes(query)) {
      options.set(option.command, option);
    }
  }

  return [...options.values()];
}

function formatTimestamp(value: string | null): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  }).format(new Date(timestamp));
}

function getStatusPresentation(text: string): {
  Icon: LucideIcon;
  compact: boolean;
  showDot: boolean;
} {
  const normalizedText = text.trim();

  if (/^thinking\b/i.test(normalizedText)) {
    return { Icon: Code2, compact: true, showDot: false };
  }

  if (/^searched\b/i.test(normalizedText)) {
    return { Icon: Search, compact: true, showDot: true };
  }

  if (
    /^(git|pnpm|npm|npx|yarn|cargo|bun|node|ls|cd|cat|rg|find|sed|touch|mkdir|rm|cp|mv|gh|python|uv)\b/i.test(normalizedText)
    || normalizedText.includes("&&")
  ) {
    return { Icon: TerminalSquare, compact: true, showDot: true };
  }

  if (/session status:/i.test(normalizedText)) {
    return { Icon: Code2, compact: true, showDot: false };
  }

  return { Icon: Code2, compact: false, showDot: false };
}

function isCommandLikeStatus(text: string): boolean {
  return /^(git|pnpm|npm|npx|yarn|cargo|bun|node|ls|cd|cat|rg|find|sed|touch|mkdir|rm|cp|mv|gh|python|uv)\b/i.test(text.trim())
    || text.includes("&&");
}

function extractComposerSummary(entries: NormalizedChatEntry[]): string | null {
  const candidates = [
    ...entries.map((entry) => entry.text),
  ].map((value) => value.trim()).filter(Boolean);

  return candidates.find((value) => /files changed/i.test(value) || (/\+\d+/.test(value) && /-\d+/.test(value))) ?? null;
}

function parseComposerSummary(summary: string): {
  label: string;
  additions: string | null;
  deletions: string | null;
} {
  const match = summary.match(/^(.*?files changed)(?:\s+(\+\d+))?(?:\s+(-\d+))?$/i);
  if (!match) {
    return {
      label: summary,
      additions: null,
      deletions: null,
    };
  }

  return {
    label: match[1]?.trim() || summary,
    additions: match[2] ?? null,
    deletions: match[3] ?? null,
  };
}

const markdownComponents = {
  a: (props: ComponentProps<"a">) => (
    <a
      {...props}
      target="_blank"
      rel="noreferrer"
      className="text-[#ea7a2a] underline underline-offset-2"
    />
  ),
  p: (props: ComponentProps<"p">) => (
    <p
      {...props}
      className={[props.className, "whitespace-pre-wrap"].filter(Boolean).join(" ")}
    />
  ),
  li: (props: ComponentProps<"li">) => (
    <li
      {...props}
      className={[props.className, "whitespace-pre-wrap"].filter(Boolean).join(" ")}
    />
  ),
};

function SetupScriptHint() {
  return (
    <div className="flex items-start gap-3 rounded-[3px] px-2 py-1 text-[#8f8f8f]">
      <div className="flex h-[21px] w-[21px] items-center justify-center pt-[1px] text-[#8f8f8f]">
        <TerminalSquare className="h-[15px] w-[15px]" strokeWidth={1.6} />
      </div>
      <div className="min-w-0 space-y-[2px]">
        <p className="text-[14px] leading-[21px] text-[#8f8f8f]">Setup Script</p>
        <p className="text-[12px] leading-[18px] text-[#c4c4c4]">
          No setup script configured. Setup scripts run before the coding agent starts.
        </p>
      </div>
    </div>
  );
}

function MarkdownBlock({ text, className }: { text: string; className: string }) {
  return (
    <ReactMarkdown
      className={className}
      remarkPlugins={[remarkGfm]}
      components={markdownComponents}
    >
      {text}
    </ReactMarkdown>
  );
}

type ParsedReviewFinding = {
  id: string;
  severity: "critical" | "high" | "medium" | "low" | "neutral";
  title: string;
  body: string;
};

type ParsedReviewContent = {
  intro: string | null;
  findingsHeading: string;
  findings: ParsedReviewFinding[];
  closing: string | null;
};

type ParsedOutlineSection = {
  id: string;
  title: string;
  items: string[];
};

function parseReviewContent(text: string): ParsedReviewContent | null {
  const normalized = text.replace(/\r/g, "");
  const lines = normalized.split("\n");
  const findingsIndex = lines.findIndex((line) => /^(?:#{1,6}\s*)?findings\b/i.test(line.trim()));
  if (findingsIndex < 0) {
    return null;
  }

  const intro = lines.slice(0, findingsIndex).join("\n").trim() || null;
  const findingsHeading = lines[findingsIndex]?.replace(/^#{1,6}\s*/, "").trim() || "Findings";
  const remaining = lines.slice(findingsIndex + 1);

  const trailingHeadingIndex = remaining.findIndex((line) =>
    /^(?:#{1,6}\s*)?(assumptions|open questions|assumptions\s*\/\s*open questions|next steps)\b/i.test(line.trim())
  );

  const findingsLines = trailingHeadingIndex >= 0 ? remaining.slice(0, trailingHeadingIndex) : remaining;
  const closing = trailingHeadingIndex >= 0 ? remaining.slice(trailingHeadingIndex).join("\n").trim() || null : null;

  const chunks: string[][] = [];
  let current: string[] = [];

  for (const line of findingsLines) {
    if (/^\s*\d+[.)]\s+/.test(line)) {
      if (current.length > 0) {
        chunks.push(current);
      }
      current = [line];
    } else if (current.length > 0) {
      current.push(line);
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  const findings = chunks
    .map((chunk, index) => {
      const [firstLine, ...rest] = chunk;
      const cleanedFirst = firstLine.replace(/^\s*\d+[.)]\s+/, "").replace(/\*\*/g, "").trim();
      const severityMatch = cleanedFirst.match(/\b(critical|high|medium|low)\b/i);
      const severity = (severityMatch?.[1]?.toLowerCase() ?? "neutral") as ParsedReviewFinding["severity"];
      const title = cleanedFirst
        .replace(/\b(critical|high|medium|low)\b\s*[—:-]\s*/i, "")
        .replace(/\b(critical|high|medium|low)\b/i, "")
        .trim();
      const body = rest.join("\n").trim();

      return {
        id: `finding-${index}`,
        severity,
        title: title || cleanedFirst,
        body,
      };
    })
    .filter((finding) => finding.title.length > 0);

  if (findings.length === 0) {
    return null;
  }

  return {
    intro,
    findingsHeading,
    findings,
    closing,
  };
}

function isLikelyOutlineTitle(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^[-*+]\s|^\d+[.)]\s|^#{1,6}\s|^>\s|^```/.test(trimmed)) return false;
  if (trimmed.length > 72) return false;
  if (/[.!?;]$/.test(trimmed)) return false;
  const wordCount = trimmed.split(/\s+/).length;
  return wordCount <= 8;
}

function parseOutlineContent(text: string): ParsedOutlineSection[] | null {
  const normalized = text.replace(/\r/g, "");
  const lines = normalized.split("\n");
  if (lines.some((line) => /^\s*[-*+]\s|^\s*\d+[.)]\s|^\s*#{1,6}\s/.test(line))) {
    return null;
  }

  const titleIndices = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line, index }) => {
      const next = lines[index + 1]?.trim() ?? "";
      return isLikelyOutlineTitle(line) && next.length > 0 && !isLikelyOutlineTitle(next);
    })
    .map(({ index }) => index);

  if (titleIndices.length < 2) {
    return null;
  }

  const sections: ParsedOutlineSection[] = [];
  for (let i = 0; i < titleIndices.length; i += 1) {
    const start = titleIndices[i];
    const end = titleIndices[i + 1] ?? lines.length;
    const title = lines[start]!.trim().replace(/:$/, "");
    const items = lines
      .slice(start + 1, end)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (title.length === 0 || items.length === 0) {
      continue;
    }

    sections.push({
      id: `outline-${i}`,
      title,
      items,
    });
  }

  return sections.length >= 2 ? sections : null;
}

function getFindingTone(finding: ParsedReviewFinding): { badge: string; border: string; surface: string } {
  switch (finding.severity) {
    case "critical":
    case "high":
      return {
        badge: "bg-[rgba(210,81,81,0.14)] text-[#f1b0b0]",
        border: "border-[rgba(210,81,81,0.22)]",
        surface: "bg-[rgba(210,81,81,0.05)]",
      };
    case "medium":
      return {
        badge: "bg-[rgba(214,164,60,0.14)] text-[#f0d28b]",
        border: "border-[rgba(214,164,60,0.2)]",
        surface: "bg-[rgba(214,164,60,0.05)]",
      };
    case "low":
      return {
        badge: "bg-[rgba(84,176,79,0.14)] text-[#b8dfb5]",
        border: "border-[rgba(84,176,79,0.2)]",
        surface: "bg-[rgba(84,176,79,0.05)]",
      };
    default:
      return {
        badge: "bg-[rgba(143,143,143,0.14)] text-[#c4c4c4]",
        border: "border-[var(--vk-border)]",
        surface: "bg-[rgba(255,255,255,0.03)]",
      };
  }
}

function ReviewFindingsBlock({ text }: { text: string }) {
  const parsed = parseReviewContent(text);
  if (!parsed) {
    return null;
  }

  return (
    <div className="space-y-5">
      {parsed.intro ? (
        <MarkdownBlock
          text={parsed.intro}
          className="prose prose-invert max-w-none text-[16px] leading-[28px] text-[#cfcfcf] prose-headings:mb-3 prose-headings:mt-6 prose-headings:text-[#f1f1f1] prose-p:my-4 prose-p:text-[#cfcfcf] prose-strong:text-[#f1f1f1] prose-ol:my-4 prose-ol:pl-6 prose-ul:my-4 prose-ul:pl-6 prose-li:my-2 prose-li:text-[#cfcfcf] prose-pre:my-4 prose-pre:overflow-x-auto prose-pre:rounded-[6px] prose-pre:border prose-pre:border-[#333] prose-pre:bg-[#1c1c1c] prose-code:text-[#d7d7d7]"
        />
      ) : null}

      <div className="overflow-hidden rounded-[8px] border border-[var(--vk-border)] bg-[rgba(255,255,255,0.03)]">
        <div className="border-b border-[var(--vk-border)] px-4 py-3">
          <p className="text-[12px] uppercase tracking-[0.16em] text-[#8f8f8f]">{parsed.findingsHeading}</p>
        </div>
        <div className="space-y-4 p-4">
          {parsed.findings.map((finding, index) => {
            const tone = getFindingTone(finding);
            return (
              <div
                key={finding.id}
                className={`rounded-[6px] border px-4 py-3 ${tone.border} ${tone.surface}`}
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-[13px] font-medium leading-[20px] text-[#8f8f8f]">
                    {index + 1}.
                  </span>
                  <span className={`rounded-full px-2 py-[3px] text-[11px] font-medium uppercase tracking-[0.12em] ${tone.badge}`}>
                    {finding.severity}
                  </span>
                  <p className="min-w-0 flex-1 text-[16px] leading-[24px] text-[#f1f1f1]">
                    {finding.title}
                  </p>
                </div>
                {finding.body ? (
                  <MarkdownBlock
                    text={finding.body}
                    className="prose prose-invert mt-3 max-w-none text-[14px] leading-[24px] text-[#c9c9c9] prose-p:my-3 prose-p:text-[#c9c9c9] prose-strong:text-[#f1f1f1] prose-ul:my-3 prose-ul:pl-5 prose-ol:my-3 prose-ol:pl-5 prose-li:my-1.5 prose-li:text-[#c9c9c9] prose-code:text-[#d7d7d7] prose-pre:my-3 prose-pre:overflow-x-auto prose-pre:rounded-[6px] prose-pre:border prose-pre:border-[#333] prose-pre:bg-[#1c1c1c]"
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      {parsed.closing ? (
        <div className="rounded-[8px] border border-[var(--vk-border)] bg-[rgba(255,255,255,0.03)] px-4 py-4">
          <MarkdownBlock
            text={parsed.closing}
            className="prose prose-invert max-w-none text-[15px] leading-[25px] text-[#c9c9c9] prose-headings:mb-2 prose-headings:mt-5 prose-headings:text-[#f1f1f1] prose-p:my-3 prose-p:text-[#c9c9c9] prose-strong:text-[#f1f1f1] prose-ol:my-3 prose-ol:pl-5 prose-ul:my-3 prose-ul:pl-5 prose-li:my-1.5 prose-li:text-[#c9c9c9] prose-code:text-[#d7d7d7]"
          />
        </div>
      ) : null}
    </div>
  );
}

function OutlineSummaryBlock({ sections }: { sections: ParsedOutlineSection[] }) {
  return (
    <div className="space-y-6">
      {sections.map((section) => (
        <section key={section.id} className="space-y-3">
          <h3 className="text-[22px] font-medium leading-[30px] text-[#f1f1f1]">
            {section.title}
          </h3>
          <div className="space-y-3">
            {section.items.map((item, index) => (
              <div
                key={`${section.id}-item-${index}`}
                className="rounded-[6px] border border-[rgba(255,255,255,0.05)] bg-[rgba(255,255,255,0.02)] px-4 py-3"
              >
                <MarkdownBlock
                  text={item}
                  className="prose prose-invert max-w-none text-[16px] leading-[28px] text-[#cfcfcf] prose-p:my-0 prose-p:text-[#cfcfcf] prose-strong:text-[#f1f1f1] prose-code:text-[#d7d7d7]"
                />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function extractToolContent(entry: NormalizedChatEntry): string[] {
  const raw = entry.metadata?.toolContent;
  if (Array.isArray(raw)) {
    return raw.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  }
  return entry.text.trim().length > 0 ? [entry.text.trim()] : [];
}

function getToolInlineSummary(entry: NormalizedChatEntry, content: string[]): string | null {
  const title = typeof entry.metadata?.toolTitle === "string" ? entry.metadata.toolTitle.trim() : "";
  const first = content[0]?.trim() ?? "";
  if (!first) return null;
  if (title && first.toLowerCase() === title.toLowerCase()) {
    return null;
  }
  return first.length > 84 ? `${first.slice(0, 81)}...` : first;
}

function getToolStatusTone(status: string | null | undefined): "pending" | "running" | "success" | "error" | "cancelled" {
  const lower = status?.trim().toLowerCase() ?? "";
  if (lower.includes("complete") || lower.includes("success") || lower.includes("done")) {
    return "success";
  }
  if (lower.includes("error") || lower.includes("fail")) {
    return "error";
  }
  if (lower.includes("cancel")) {
    return "cancelled";
  }
  if (lower.includes("running") || lower.includes("progress")) {
    return "running";
  }
  return "pending";
}

function getToolIcon(entry: NormalizedChatEntry): LucideIcon {
  const toolKind = typeof entry.metadata?.toolKind === "string" ? entry.metadata.toolKind.toLowerCase() : "";
  const title = (typeof entry.metadata?.toolTitle === "string" ? entry.metadata.toolTitle : entry.text).toLowerCase();
  if (toolKind.includes("thinking") || title.includes("thinking")) {
    return BrainCircuit;
  }
  if (toolKind.includes("web") || title.includes("web search") || title.includes("web fetch")) {
    return Globe;
  }
  if (
    toolKind.includes("grep")
    || toolKind.includes("glob")
    || toolKind.includes("search")
    || toolKind.includes("find")
    || title.includes("search")
    || title.includes("grep")
    || title.includes("glob")
    || title.includes("find")
  ) {
    return FileSearch2;
  }
  if (toolKind.includes("read") || title.includes("read")) {
    return FileText;
  }
  if (
    toolKind.includes("edit")
    || toolKind.includes("write")
    || toolKind.includes("multiedit")
    || title.includes("edit")
    || title.includes("write")
  ) {
    return PencilLine;
  }
  if (toolKind.includes("task") || toolKind.includes("todo") || title.includes("todo")) {
    return ListTodo;
  }
  if (toolKind.includes("search") || title.includes("search") || title.includes("rg ") || title.includes("find ")) {
    return Search;
  }
  if (toolKind.includes("permission") || title.includes("permission") || title.includes("auth")) {
    return Shield;
  }
  if (toolKind.includes("command") || title.includes("bash") || title.includes("git ") || title.includes("bun ")) {
    return TerminalSquare;
  }
  return Wrench;
}

function AttachmentPills({
  attachments,
  onRemove,
}: {
  attachments: string[];
  onRemove?: (index: number) => void;
}) {
  if (!attachments.length) return null;

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {attachments.map((attachment, index) => {
        const label = attachment.split("/").pop() || attachment;

        if (onRemove) {
          return (
            <button
              key={`${attachment}-${index}`}
              type="button"
              onClick={() => onRemove(index)}
              className="rounded-[3px] border border-[#333] bg-[#1c1c1c] px-2 py-1 text-[12px] leading-[18px] text-[#c4c4c4] transition hover:bg-[#292929]"
            >
              {label}
            </button>
          );
        }

        return (
          <span
            key={`${attachment}-${index}`}
            className="rounded-[3px] border border-[#333] bg-[#1c1c1c] px-2 py-1 text-[12px] leading-[18px] text-[#c4c4c4]"
          >
            {label}
          </span>
        );
      })}
    </div>
  );
}

function SummaryChip({ summary }: { summary: string }) {
  const parsed = parseComposerSummary(summary);

  return (
    <div className="inline-flex min-h-[29px] items-center gap-1 rounded-[3px] bg-[#292929] px-3 py-[5px] text-[14px] leading-[21px] text-[#c4c4c4]">
      <span>{parsed.label}</span>
      {parsed.additions ? <span className="text-[#54b04f]">{parsed.additions}</span> : null}
      {parsed.deletions ? <span className="text-[#d25151]">{parsed.deletions}</span> : null}
    </div>
  );
}

function ParserStateBanner({
  kind,
  message,
  command,
}: {
  kind: string;
  message: string;
  command: string | null;
}) {
  const title = kind === "auth_required"
    ? "Authentication required"
    : kind === "interactive_required"
      ? "Terminal interaction required"
      : "Waiting for input";
  const border = kind === "auth_required" ? "border-[#6b5533] bg-[rgba(234,122,42,0.12)] text-[#f1c49f]" : "border-[#36506b] bg-[rgba(68,114,164,0.12)] text-[#bfd5ee]";

  return (
    <div className={`rounded-[3px] border px-3 py-2 ${border}`}>
      <div className="flex items-start gap-3">
        <div className="flex h-[20px] w-[20px] items-center justify-center pt-[1px]">
          <TerminalSquare className="h-[15px] w-[15px]" strokeWidth={1.6} />
        </div>
        <div className="min-w-0 space-y-1">
          <p className="text-[13px] font-medium leading-[20px]">{title}</p>
          <p className="whitespace-pre-wrap break-words text-[13px] leading-[20px]">{message}</p>
          {command ? (
            <p className="text-[12px] leading-[18px] text-[#c4c4c4]">
              Run locally: <code className="rounded bg-[rgba(0,0,0,0.22)] px-1 py-[1px] text-[#f1f1f1]">{command}</code>
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function UserEntryCard({ entry }: { entry: NormalizedChatEntry }) {
  const timestamp = formatTimestamp(entry.createdAt);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <UserRound className="h-[15px] w-[15px] shrink-0 text-[#8f8f8f]" strokeWidth={1.7} />
        <span className="text-[14px] leading-[21px] text-[#c4c4c4]">You</span>
        {timestamp ? (
          <span className="text-[12px] leading-[18px] text-[#5f5f5f]">{timestamp}</span>
        ) : null}
      </div>
      <MarkdownBlock
        text={entry.text}
        className="prose prose-invert max-w-none text-[16px] leading-[24px] text-[#c4c4c4] prose-headings:text-[#c4c4c4] prose-p:my-0 prose-p:text-[#c4c4c4] prose-pre:my-3 prose-pre:overflow-x-auto prose-pre:rounded-[3px] prose-pre:border prose-pre:border-[#333] prose-pre:bg-[#1c1c1c] prose-code:text-[#c4c4c4]"
      />
      <AttachmentPills attachments={entry.attachments} />
    </div>
  );
}

function StatusEntry({ entry }: { entry: NormalizedChatEntry }) {
  const presentation = getStatusPresentation(entry.text);
  const commandLike = isCommandLikeStatus(entry.text);

  if (!presentation.compact) {
    return (
      <div className="space-y-3">
        <MarkdownBlock
          text={entry.text}
          className="prose prose-invert max-w-none text-[16px] leading-[24px] text-[#c4c4c4] prose-headings:text-[#c4c4c4] prose-p:my-0 prose-p:text-[#c4c4c4] prose-pre:my-3 prose-pre:overflow-x-auto prose-pre:rounded-[3px] prose-pre:border prose-pre:border-[#333] prose-pre:bg-[#1c1c1c] prose-code:text-[#c4c4c4]"
        />
      </div>
    );
  }

  const { Icon } = presentation;

  return (
    <div className="flex items-start gap-2 py-[2px]">
      <div className="relative flex h-[22px] w-[20px] items-start pt-[2px] text-[#8f8f8f]">
        <Icon className="h-[20px] w-[20px]" strokeWidth={1.6} />
        {presentation.showDot ? (
          <span className="absolute bottom-0 left-[-2px] h-[6px] w-[6px] rounded-full bg-[#54b04f]" />
        ) : null}
      </div>
      <p className={`min-w-0 flex-1 whitespace-pre-wrap break-words text-[#8f8f8f] ${commandLike ? "font-mono text-[13px] leading-[20px]" : "text-[14px] leading-[21px]"}`}>
        {entry.text}
      </p>
    </div>
  );
}

function ToolEntry({ entry }: { entry: NormalizedChatEntry }) {
  const [expanded, setExpanded] = useState(false);
  const content = extractToolContent(entry);
  const inlineSummary = getToolInlineSummary(entry, content);
  const toolTitle = typeof entry.metadata?.toolTitle === "string" && entry.metadata.toolTitle.trim().length > 0
    ? entry.metadata.toolTitle.trim()
    : entry.text.trim() || "Tool call";
  const toolStatus = typeof entry.metadata?.toolStatus === "string" ? entry.metadata.toolStatus : null;
  const statusTone = getToolStatusTone(toolStatus);
  const Icon = getToolIcon(entry);
  const statusIndicator = statusTone === "running"
    ? (
      <span
        className="h-[9px] w-[9px] shrink-0 rounded-full border-2 border-[rgba(148,163,184,0.35)] border-t-[rgba(148,163,184,0.95)] animate-spin"
        aria-hidden="true"
      />
    )
    : (
      <span
        className={[
          "h-[9px] w-[9px] shrink-0 rounded-full",
          statusTone === "success"
            ? "bg-[var(--vk-green)]"
            : statusTone === "error"
              ? "bg-[var(--vk-red)]"
              : statusTone === "cancelled"
                ? "bg-[var(--vk-text-muted)]"
                : "bg-[rgba(148,163,184,0.7)]",
        ].join(" ")}
        aria-hidden="true"
      />
    );

  return (
    <div className={`group ${expanded ? "is-expanded" : ""}`}>
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full items-start gap-2 py-1 text-left text-[var(--vk-text-muted)] transition hover:text-[var(--vk-text-normal)]"
      >
        {statusIndicator}
        <Icon className="mt-[2px] h-[14px] w-[14px] shrink-0 text-[var(--vk-text-muted)]" strokeWidth={1.7} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="shrink-0 text-[14px] font-medium leading-[21px] text-[#d0d0d0]">
              {toolTitle}
            </span>
            {inlineSummary ? (
              <span className="min-w-0 max-w-full truncate rounded-[3px] bg-[rgba(255,255,255,0.06)] px-2 py-[2px] font-mono text-[12px] leading-[18px] text-[#a9a9a9]">
                {inlineSummary}
              </span>
            ) : null}
          </div>
        </div>
        <ChevronRight
          className={`mt-[2px] h-[14px] w-[14px] shrink-0 text-[var(--vk-text-muted)] transition-all duration-200 ${
            expanded ? "rotate-90 opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
          strokeWidth={1.8}
        />
      </button>
      {expanded ? (
        <div className="mt-2 max-h-[300px] overflow-y-auto border-t border-[var(--vk-border)] bg-[var(--vk-bg-surface)] px-3 py-3">
          {content.length > 0 ? (
            <div className="space-y-2">
              {content
                .filter((line, index) => !(inlineSummary && index === 0 && line.trim() === inlineSummary))
                .map((line, index) => (
                <p
                  key={`${entry.id}-tool-line-${index}`}
                  className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[18px] text-[var(--vk-text-normal)]"
                >
                  {line}
                </p>
                ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

type FeedRenderItem =
  | { kind: "entry"; entry: NormalizedChatEntry }
  | { kind: "tool-group"; id: string; entries: NormalizedChatEntry[] };

function buildFeedRenderItems(entries: NormalizedChatEntry[]): FeedRenderItem[] {
  const items: FeedRenderItem[] = [];
  let toolBuffer: NormalizedChatEntry[] = [];

  const flushTools = () => {
    if (toolBuffer.length === 0) return;
    items.push({
      kind: "tool-group",
      id: `tool-group-${toolBuffer[0]?.id ?? items.length}`,
      entries: toolBuffer,
    });
    toolBuffer = [];
  };

  for (const entry of entries) {
    if (entry.kind === "tool") {
      toolBuffer.push(entry);
      continue;
    }

    flushTools();
    items.push({ kind: "entry", entry });
  }

  flushTools();
  return items;
}

function ToolGroup({
  entries,
  autoCollapsed,
}: {
  entries: NormalizedChatEntry[];
  autoCollapsed: boolean;
}) {
  const [expanded, setExpanded] = useState(!autoCollapsed);
  const countLabel = `${entries.length} tool call${entries.length === 1 ? "" : "s"}`;

  useEffect(() => {
    if (autoCollapsed) {
      setExpanded(false);
    }
  }, [autoCollapsed]);

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="flex items-center gap-2 text-[15px] leading-[22px] text-[#9b9b9b] transition hover:text-[#c4c4c4]"
      >
        <ChevronDown
          className={`h-[14px] w-[14px] transition-transform ${expanded ? "" : "-rotate-90"}`}
          strokeWidth={1.8}
        />
        <span>{countLabel}</span>
      </button>
      {expanded ? (
        <div className="space-y-1 pl-5">
          {entries.map((entry) => (
            <ToolEntry key={entry.id} entry={entry} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AssistantEntry({
  entry,
  agentName,
}: {
  entry: NormalizedChatEntry;
  agentName: string;
}) {
  const timestamp = formatTimestamp(entry.createdAt);
  const reviewBlock = parseReviewContent(entry.text);
  const outlineSections = reviewBlock ? null : parseOutlineContent(entry.text);

  return (
    <div className="space-y-4">
      {entry.streaming ? (
        <div className="flex items-center gap-2 text-[#8f8f8f]">
          {agentName ? (
            <AgentTileIcon seed={{ label: agentName }} className="h-[20px] w-[20px] border-none bg-transparent" />
          ) : (
            <Code2 className="h-[20px] w-[20px]" strokeWidth={1.6} />
          )}
          <span className="text-[14px] leading-[21px]">Thinking</span>
        </div>
      ) : null}
      {reviewBlock ? (
        <ReviewFindingsBlock text={entry.text} />
      ) : outlineSections ? (
        <OutlineSummaryBlock sections={outlineSections} />
      ) : (
        <MarkdownBlock
          text={entry.text}
          className="prose prose-invert max-w-none text-[16px] leading-[28px] text-[#cfcfcf] prose-headings:mb-3 prose-headings:mt-6 prose-headings:text-[#f1f1f1] prose-p:my-4 prose-p:text-[#cfcfcf] prose-strong:text-[#f1f1f1] prose-ol:my-4 prose-ol:pl-6 prose-ul:my-4 prose-ul:pl-6 prose-li:my-2 prose-li:text-[#cfcfcf] prose-pre:my-4 prose-pre:overflow-x-auto prose-pre:rounded-[6px] prose-pre:border prose-pre:border-[#333] prose-pre:bg-[#1c1c1c] prose-code:text-[#d7d7d7] prose-blockquote:border-l prose-blockquote:border-[#333] prose-blockquote:pl-4 prose-blockquote:text-[#b7b7b7]"
        />
      )}
      <AttachmentPills attachments={entry.attachments} />
      {timestamp ? (
        <p className="text-[12px] leading-[18px] text-[#5f5f5f]">{timestamp}</p>
      ) : null}
    </div>
  );
}

function SystemEntry({ entry }: { entry: NormalizedChatEntry }) {
  return (
    <div className="rounded-[3px] border border-[#315434] bg-[rgba(84,176,79,0.08)] px-3 py-2">
      <p className="text-[12px] uppercase tracking-[0.18em] text-[#8bc886]">System</p>
      <MarkdownBlock
        text={entry.text}
        className="prose prose-invert mt-2 max-w-none text-[14px] leading-[21px] text-[#d8ead6] prose-p:my-0 prose-p:text-[#d8ead6] prose-strong:text-white prose-code:text-[#d8ead6]"
      />
      <AttachmentPills attachments={entry.attachments} />
    </div>
  );
}

function FeedEntry({
  entry,
  agentName,
}: {
  entry: NormalizedChatEntry;
  agentName: string;
}) {
  switch (entry.kind) {
    case "user":
      return <UserEntryCard entry={entry} />;
    case "assistant":
      return <AssistantEntry entry={entry} agentName={agentName} />;
    case "tool":
      return <ToolEntry entry={entry} />;
    case "system":
      return <SystemEntry entry={entry} />;
    default:
      return <StatusEntry entry={entry} />;
  }
}

async function uploadAttachments(files: File[]): Promise<string[]> {
  if (!files.length) return [];

  const uploadedPaths = await Promise.all(files.map(async (file) => {
    const formData = new FormData();
    formData.append("file", file);

    const response = await fetch("/api/attachments", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Failed to upload ${file.name}`);
    }

    const payload = await response.json();
    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
    const nested = record?.attachment && typeof record.attachment === "object"
      ? record.attachment as Record<string, unknown>
      : null;

    for (const candidate of [
      record?.absolutePath,
      record?.path,
      record?.filePath,
      nested?.absolutePath,
      nested?.path,
      nested?.filePath,
    ]) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }

    throw new Error(`Attachment response for ${file.name} did not include a file path`);
  }));

  return uploadedPaths.filter(Boolean);
}

export function ChatPanel({
  sessionId,
  agentName,
  projectId,
  sessionModel,
  sessionReasoningEffort,
}: ChatPanelProps) {
  const { agents } = useAgents();
  const { entries, error, loading, parserState, sessionStatus, refresh } = useSessionFeed(sessionId);

  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState(sessionModel?.trim() || "");
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);

  const endRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const normalizedAgentName = agentName?.trim() || "";
  const normalizedSessionStatus = sessionStatus?.trim().toLowerCase() ?? "";
  const modelOptions = useMemo(
    () => getModelOptions(agents, normalizedAgentName, sessionModel?.trim() || ""),
    [agents, normalizedAgentName, sessionModel],
  );
  const router = useRouter();

  useEffect(() => {
    setSelectedModel(sessionModel?.trim() || "");
  }, [sessionModel]);

  // Clear transient error state when the session changes.
  useEffect(() => {
    setSendError(null);
  }, [sessionId]);

  // Close model menu on click outside.
  useEffect(() => {
    if (!modelMenuOpen) return;
    function onClickOutside(event: globalThis.MouseEvent) {
      if (modelMenuRef.current && !modelMenuRef.current.contains(event.target as Node)) {
        setModelMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [modelMenuOpen]);

  const displayEntries = useMemo(
    () => {
      if (normalizedSessionStatus !== "working" && normalizedSessionStatus !== "running") {
        return entries;
      }
      return entries.filter((entry) => !(entry.kind === "status" && entry.source === "session-status"));
    },
    [entries, normalizedSessionStatus],
  );

  const hasStreamingEntry = displayEntries.some((entry) => entry.streaming);
  const isSessionRunning = normalizedSessionStatus === "running" || normalizedSessionStatus === "working" || hasStreamingEntry;
  const composerSummary = useMemo(
    () => extractComposerSummary(displayEntries),
    [displayEntries],
  );
  const slashCommandOptions = useMemo(
    () => getSlashCommandOptions(normalizedAgentName, message),
    [message, normalizedAgentName],
  );
  const showSlashCommandMenu = slashCommandOptions.length > 0;
  const feedItems = useMemo(
    () => buildFeedRenderItems(displayEntries),
    [displayEntries],
  );

  const prevEntryCountRef = useRef(0);
  useEffect(() => {
    const count = displayEntries.length;
    // Only auto-scroll when entries are added or while streaming — not on every poll.
    if (count !== prevEntryCountRef.current || hasStreamingEntry || sending) {
      endRef.current?.scrollIntoView({ behavior: hasStreamingEntry ? "auto" : "smooth", block: "end" });
    }
    prevEntryCountRef.current = count;
  }, [displayEntries, hasStreamingEntry, sending]);

  useEffect(() => {
    if (!showSlashCommandMenu) {
      setSelectedSlashIndex(0);
      return;
    }
    setSelectedSlashIndex((current) => Math.min(current, Math.max(slashCommandOptions.length - 1, 0)));
  }, [showSlashCommandMenu, slashCommandOptions.length]);

  const selectedModelLabel = useMemo(() => {
    if (!selectedModel) return "Latest";
    return modelOptions.find((option) => option.id === selectedModel)?.label ?? selectedModel;
  }, [modelOptions, selectedModel]);

  const handleInterrupt = useCallback(async () => {
    if (!isSessionRunning || interrupting) return;

    setInterrupting(true);
    setSendError(null);

    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/kill`, {
        method: "POST",
      });

      const data = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;

      if (!response.ok) {
        throw new Error(data?.error ?? `Failed to stop agent: ${response.status}`);
      }

      await refresh();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Failed to stop agent");
    } finally {
      setInterrupting(false);
    }
  }, [isSessionRunning, interrupting, sessionId, refresh]);

  const handleSend = useCallback(async () => {
    if (isSessionRunning || interrupting) return;
    const trimmedMessage = message.trim();
    if (!trimmedMessage && attachments.length === 0) return;

    setSending(true);
    setSendError(null);

    try {
      const attachmentPaths = await uploadAttachments(attachments.map((attachment) => attachment.file));

      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: trimmedMessage,
          attachments: attachmentPaths,
          model: selectedModel || null,
          reasoningEffort: sessionReasoningEffort || null,
          projectId: projectId || null,
        }),
      });

      const data = (await response.json().catch(() => null)) as
        | { error?: string; sessionId?: string | null }
        | null;

      if (!response.ok) {
        throw new Error(data?.error ?? `Failed to send message: ${response.status}`);
      }

      setMessage("");
      setAttachments([]);
      if (data?.sessionId && data.sessionId !== sessionId) {
        router.push(`/sessions/${encodeURIComponent(data.sessionId)}?tab=chat`);
        return;
      }
      await refresh();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  }, [isSessionRunning, interrupting, message, attachments, sessionId, selectedModel, sessionReasoningEffort, projectId, router, refresh]);

  function applySlashCommand(option: SlashCommandOption) {
    setMessage(option.command);
    setSendError(null);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (showSlashCommandMenu && event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedSlashIndex((current) => (
        current >= slashCommandOptions.length - 1 ? 0 : current + 1
      ));
      return;
    }

    if (showSlashCommandMenu && event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedSlashIndex((current) => (
        current <= 0 ? Math.max(slashCommandOptions.length - 1, 0) : current - 1
      ));
      return;
    }

    if (event.key === "Escape" && isSessionRunning) {
      event.preventDefault();
      void handleInterrupt();
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (showSlashCommandMenu) {
        const selectedOption = slashCommandOptions[selectedSlashIndex];
        if (selectedOption) {
          if (selectedOption.exact && !isSessionRunning) {
            void handleSend();
          } else {
            applySlashCommand(selectedOption);
          }
          return;
        }
      }
      if (!isSessionRunning) {
        void handleSend();
      }
    }
  }

  useEffect(() => {
    if (!isSessionRunning) return;

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (
        event.key !== "Escape"
        || event.defaultPrevented
        || event.metaKey
        || event.ctrlKey
        || event.altKey
        || event.shiftKey
      ) {
        return;
      }

      event.preventDefault();
      void handleInterrupt();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleInterrupt, isSessionRunning]);

  function handleAttachmentChange(event: ChangeEvent<HTMLInputElement>) {
    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;

    const validFiles: File[] = [];
    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        setSendError(`File "${file.name}" exceeds 10 MB limit`);
        continue;
      }
      validFiles.push(file);
    }

    if (validFiles.length > 0) {
      setAttachments((current) => [
        ...current,
        ...validFiles.map((file) => ({ file })),
      ]);
    }

    event.target.value = "";
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[radial-gradient(circle_at_top,rgba(45,45,45,0.32),rgba(33,33,33,1)_40%)] text-[#c4c4c4]">
      <div className="mx-auto flex h-full min-h-0 w-full max-w-[855px] flex-col">
        <div className="flex-1 overflow-y-auto px-3 pt-3 sm:px-4">
          <div className="mx-auto flex w-full max-w-[768px] flex-col gap-5 pb-6">
            {loading && displayEntries.length === 0 ? (
              <div className="flex items-center gap-2 px-4 text-[#8f8f8f]">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-[14px] leading-[21px]">Loading conversation</span>
              </div>
            ) : null}

            {!loading && displayEntries.length === 0 ? (
              <div className="px-4 py-2 text-[16px] leading-[24px] text-[#8f8f8f]">
                Start the next turn to stream follow-up work into this panel.
              </div>
            ) : null}

            {feedItems.map((item) => (
              item.kind === "tool-group" ? (
                <ToolGroup key={item.id} entries={item.entries} autoCollapsed={!isSessionRunning} />
              ) : (
                <FeedEntry key={item.entry.id} entry={item.entry} agentName={normalizedAgentName} />
              )
            ))}

            {error ? (
              <div className="rounded-[3px] border border-[#603535] bg-[rgba(210,81,81,0.12)] px-3 py-2 text-[13px] leading-[20px] text-[#f0b5b5]">
                {error}
              </div>
            ) : null}

            {sendError ? (
              <div className="rounded-[3px] border border-[#603535] bg-[rgba(210,81,81,0.12)] px-3 py-2 text-[13px] leading-[20px] text-[#f0b5b5]">
                {sendError}
              </div>
            ) : null}

            {parserState ? (
              <ParserStateBanner
                kind={parserState.kind}
                message={parserState.message}
                command={parserState.command}
              />
            ) : null}

            <div ref={endRef} />
          </div>
        </div>

        <div className="shrink-0 px-3 pb-4 pt-0 sm:px-4">
          <div className="mx-auto w-full max-w-[768px]">
            <div className="rounded-[3px] border border-[#333] bg-[#1c1c1c] shadow-[0_12px_40px_rgba(0,0,0,0.22)]">
              <div className="flex flex-wrap items-center gap-2 border-b border-[#333] px-2 py-2">
                {composerSummary ? <SummaryChip summary={composerSummary} /> : <div className="min-h-[29px]" />}
                <div className="ml-auto flex min-w-0 items-center gap-2">
                  {normalizedAgentName ? (
                    <div className="hidden items-center overflow-hidden sm:flex">
                      <AgentTileIcon seed={{ label: normalizedAgentName }} className="h-[25px] w-[25px] border-none bg-transparent" />
                    </div>
                  ) : null}
                  <div className="hidden h-[20px] w-[20px] items-center justify-center text-[#8f8f8f] sm:flex">
                    <Code2 className="h-[15px] w-[15px]" strokeWidth={1.7} />
                  </div>
                  <div className="relative" ref={modelMenuRef}>
                    <button
                      type="button"
                      onClick={() => setModelMenuOpen((open) => !open)}
                      className="inline-flex min-h-[31px] items-center gap-2 rounded-[3px] border border-[#333] bg-[#1c1c1c] px-[9px] py-[5px] text-[14px] leading-[21px] text-[#c4c4c4] transition hover:bg-[#292929]"
                    >
                      <span className="max-w-[140px] truncate">{selectedModelLabel}</span>
                      <ChevronDown className="h-[10px] w-[10px] text-[#8f8f8f]" strokeWidth={1.8} />
                    </button>

                    {modelMenuOpen ? (
                      <div className="absolute bottom-[calc(100%+8px)] right-0 z-20 max-h-80 w-[280px] overflow-y-auto rounded-[4px] border border-[#333] bg-[#1c1c1c] p-1 shadow-[0_18px_50px_rgba(0,0,0,0.35)]">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedModel(sessionModel?.trim() || "");
                            setModelMenuOpen(false);
                          }}
                          className="flex w-full flex-col rounded-[3px] px-3 py-2 text-left transition hover:bg-[#292929]"
                        >
                          <span className="text-[14px] leading-[21px] text-[#c4c4c4]">Session default</span>
                          <span className="text-[12px] leading-[18px] text-[#8f8f8f]">
                            Keep using the model configured on this session.
                          </span>
                        </button>

                        {modelOptions.map((option) => (
                          <button
                            key={option.id}
                            type="button"
                            onClick={() => {
                              setSelectedModel(option.id);
                              setModelMenuOpen(false);
                            }}
                            className={`flex w-full flex-col rounded-[3px] px-3 py-2 text-left transition hover:bg-[#292929] ${selectedModel === option.id ? "bg-[#292929]" : ""}`}
                          >
                            <span className="text-[14px] leading-[21px] text-[#c4c4c4]">{option.label}</span>
                            <span className="text-[12px] leading-[18px] text-[#8f8f8f]">{option.helper}</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="px-2 py-2">
                <textarea
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  placeholder="Continue working on this task..."
                  rows={1}
                  className="min-h-[24px] w-full resize-none bg-transparent px-1 py-0 text-[16px] leading-[24px] text-[#8f8f8f] outline-none placeholder:text-[#8f8f8f]"
                />

                {showSlashCommandMenu ? (
                  <div className="mt-3 overflow-hidden rounded-[3px] border border-[#333] bg-[#171717]">
                    <div className="border-b border-[#333] px-3 py-2 text-[11px] uppercase tracking-[0.18em] text-[#8f8f8f]">
                      Slash commands
                    </div>
                    <div className="max-h-[220px] overflow-y-auto py-1">
                      {slashCommandOptions.map((option, index) => (
                        <button
                          key={option.command}
                          type="button"
                          onClick={() => applySlashCommand(option)}
                          className={`flex w-full flex-col gap-1 px-3 py-2 text-left transition ${
                            index === selectedSlashIndex ? "bg-[#242424]" : "hover:bg-[#1f1f1f]"
                          }`}
                        >
                          <span className="text-[14px] leading-[21px] text-[#f1f1f1]">{option.label}</span>
                          <span className="text-[12px] leading-[18px] text-[#8f8f8f]">{option.description}</span>
                        </button>
                      ))}
                    </div>
                    <div className="border-t border-[#333] px-3 py-2 text-[12px] leading-[18px] text-[#8f8f8f]">
                      Slash commands are passed straight to the live agent session under the chat UI.
                    </div>
                  </div>
                ) : null}

                <AttachmentPills
                  attachments={attachments.map((attachment) => attachment.file.name)}
                  onRemove={(index) => {
                    setAttachments((current) => {
                      const next = [...current];
                      next.splice(index, 1);
                      return next;
                    });
                  }}
                />

                <div className="mt-3 flex items-end justify-between gap-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={handleAttachmentChange}
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="inline-flex h-[29px] w-[33px] items-center justify-center rounded-[3px] border border-[#333] bg-[#1c1c1c] text-[#c4c4c4] transition hover:bg-[#292929]"
                      aria-label="Add attachment"
                    >
                      <Paperclip className="h-[15px] w-[15px]" strokeWidth={1.7} />
                    </button>
                    <div className="inline-flex h-[29px] items-center justify-center rounded-[3px] border border-[#333] bg-[#1c1c1c] px-[9px] text-[#8f8f8f]">
                      <Code2 className="h-[15px] w-[15px]" strokeWidth={1.7} />
                    </div>
                    {sessionReasoningEffort ? (
                      <div className="hidden min-h-[29px] items-center rounded-[3px] bg-[#1c1c1c] px-[9px] py-[5px] text-[12px] leading-[18px] text-[#8f8f8f] sm:inline-flex">
                        {sessionReasoningEffort}
                      </div>
                    ) : null}
                  </div>

                  <button
                    type="button"
                    onClick={() => void (isSessionRunning ? handleInterrupt() : handleSend())}
                    disabled={interrupting || (!isSessionRunning && (sending || (!message.trim() && attachments.length === 0)))}
                    className={`inline-flex min-h-[29px] items-center justify-center rounded-[3px] px-4 py-[6px] text-[16px] leading-[16px] transition disabled:cursor-not-allowed disabled:opacity-40 ${
                      isSessionRunning
                        ? "border border-[#603535] bg-[rgba(210,81,81,0.12)] text-[#f0b5b5] hover:bg-[rgba(210,81,81,0.18)]"
                        : "bg-[#292929] text-[#c4c4c4] hover:bg-[#313131]"
                    }`}
                  >
                    {interrupting ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : isSessionRunning ? (
                      <span className="inline-flex items-center gap-2">
                        <span>Stop</span>
                        <span className="hidden text-[11px] leading-[11px] text-[#8f8f8f] sm:inline">Esc</span>
                      </span>
                    ) : sending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      "Send"
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ChatPanel;
