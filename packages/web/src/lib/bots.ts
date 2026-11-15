import type { DashboardSession } from "@/lib/types";

export type BotCadence =
  | { kind: "interval"; minutes: number }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; days: number[]; time: string };

export type BotScheduleStatus = "ok" | "busy" | "error";

export interface BotSchedule {
  id: string;
  title: string;
  prompt: string;
  cadence: BotCadence;
  /** Minutes east of UTC, i.e. `-new Date().getTimezoneOffset()`. */
  timezoneOffsetMinutes: number;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastStatus: BotScheduleStatus | null;
  lastError: string | null;
}

export interface Bot {
  id: string;
  name: string;
  role: string;
  instructions: string;
  emoji: string;
  projectId: string;
  dispatcherAgent: string | null;
  implementationAgent: string | null;
  dispatcherModel: string | null;
  implementationModel: string | null;
  handles: string[];
  slackChannels: string[];
  isDefault: boolean;
  threadId: string | null;
  status: string;
  activity: string | null;
  waitingForApproval: boolean;
  lastActiveAt: string | null;
  schedules: BotSchedule[];
  createdAt: string;
  updatedAt: string;
}

export type InboxItemKind = "plan_approval" | "needs_input" | "failed" | "review";

export interface InboxItem {
  id: string;
  kind: InboxItemKind;
  title: string;
  summary: string;
  projectId: string;
  sessionId: string;
  threadId: string | null;
  botId: string | null;
  botName: string | null;
  updatedAt: string;
}

export interface BotDraft {
  name: string;
  emoji: string;
  role: string;
  instructions: string;
  projectId: string;
  dispatcherAgent: string;
  implementationAgent: string;
  handles: string;
  slackChannels: string;
  isDefault: boolean;
}

export interface BotThreadResponse {
  bot: Bot;
  thread: DashboardSession;
}

export const DEFAULT_BOT_EMOJI = "🤖";
export const WEEKDAY_SHORT_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const INBOX_KIND_ORDER: readonly InboxItemKind[] = [
  "plan_approval",
  "needs_input",
  "failed",
  "review",
];

const INBOX_KIND_LABELS: Record<InboxItemKind, string> = {
  plan_approval: "Plans waiting for approval",
  needs_input: "Waiting for your input",
  failed: "Failed or stuck",
  review: "Ready for review",
};

const INBOX_KIND_ACTIONS: Record<InboxItemKind, string> = {
  plan_approval: "Review plan",
  needs_input: "Answer",
  failed: "Inspect",
  review: "Review",
};

export function inboxKindLabel(kind: InboxItemKind): string {
  return INBOX_KIND_LABELS[kind] ?? "Other";
}

export function inboxKindActionLabel(kind: InboxItemKind): string {
  return INBOX_KIND_ACTIONS[kind] ?? "Open";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

export function normalizeTimeOfDay(value: unknown, fallback = "09:00"): string {
  if (typeof value !== "string") return fallback;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return fallback;
  const hours = Number.parseInt(match[1] ?? "", 10);
  const minutes = Number.parseInt(match[2] ?? "", 10);
  if (hours > 23 || minutes > 59) return fallback;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function normalizeWeekdays(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const days = new Set<number>();
  for (const entry of value) {
    if (typeof entry === "number" && Number.isInteger(entry) && entry >= 0 && entry <= 6) {
      days.add(entry);
    }
  }
  return [...days].sort((left, right) => left - right);
}

export function normalizeCadence(value: unknown): BotCadence {
  if (isRecord(value)) {
    if (value.kind === "daily") {
      return { kind: "daily", time: normalizeTimeOfDay(value.time) };
    }
    if (value.kind === "weekly") {
      return {
        kind: "weekly",
        days: normalizeWeekdays(value.days),
        time: normalizeTimeOfDay(value.time),
      };
    }
    if (value.kind === "interval") {
      const minutes = typeof value.minutes === "number" && Number.isFinite(value.minutes)
        ? Math.max(1, Math.round(value.minutes))
        : 60;
      return { kind: "interval", minutes };
    }
  }
  return { kind: "interval", minutes: 60 };
}

export function normalizeBotSchedule(value: unknown): BotSchedule | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const lastStatus = value.lastStatus;
  return {
    id: value.id,
    title: asString(value.title),
    prompt: asString(value.prompt),
    cadence: normalizeCadence(value.cadence),
    timezoneOffsetMinutes: typeof value.timezoneOffsetMinutes === "number"
      ? value.timezoneOffsetMinutes
      : 0,
    enabled: value.enabled !== false,
    lastRunAt: asNullableString(value.lastRunAt),
    nextRunAt: asNullableString(value.nextRunAt),
    lastStatus: lastStatus === "ok" || lastStatus === "busy" || lastStatus === "error"
      ? lastStatus
      : null,
    lastError: asNullableString(value.lastError),
  };
}

export function normalizeBot(value: unknown): Bot | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  return {
    id: value.id,
    name: asString(value.name, "Bot"),
    role: asString(value.role),
    instructions: asString(value.instructions),
    emoji: asString(value.emoji).trim() || DEFAULT_BOT_EMOJI,
    projectId: asString(value.projectId),
    dispatcherAgent: asNullableString(value.dispatcherAgent),
    implementationAgent: asNullableString(value.implementationAgent),
    dispatcherModel: asNullableString(value.dispatcherModel),
    implementationModel: asNullableString(value.implementationModel),
    handles: asStringList(value.handles),
    slackChannels: asStringList(value.slackChannels),
    isDefault: value.isDefault === true,
    threadId: asNullableString(value.threadId),
    status: asString(value.status, "idle") || "idle",
    activity: asNullableString(value.activity),
    waitingForApproval: value.waitingForApproval === true,
    lastActiveAt: asNullableString(value.lastActiveAt),
    schedules: Array.isArray(value.schedules)
      ? value.schedules
        .map(normalizeBotSchedule)
        .filter((schedule): schedule is BotSchedule => schedule !== null)
      : [],
    createdAt: asString(value.createdAt),
    updatedAt: asString(value.updatedAt),
  };
}

export function normalizeBots(payload: unknown): Bot[] {
  const list = isRecord(payload) ? payload.bots : null;
  if (!Array.isArray(list)) return [];
  return list.map(normalizeBot).filter((bot): bot is Bot => bot !== null);
}

const INBOX_KINDS = new Set<string>(INBOX_KIND_ORDER);

export function normalizeInboxItems(payload: unknown): InboxItem[] {
  const list = isRecord(payload) ? payload.items : null;
  if (!Array.isArray(list)) return [];
  const items: InboxItem[] = [];
  for (const entry of list) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue;
    const kind = asString(entry.kind);
    if (!INBOX_KINDS.has(kind)) continue;
    items.push({
      id: entry.id,
      kind: kind as InboxItemKind,
      title: asString(entry.title, "Untitled"),
      summary: asString(entry.summary),
      projectId: asString(entry.projectId),
      sessionId: asString(entry.sessionId),
      threadId: asNullableString(entry.threadId),
      botId: asNullableString(entry.botId),
      botName: asNullableString(entry.botName),
      updatedAt: asString(entry.updatedAt),
    });
  }
  return items;
}

export interface InboxGroup {
  kind: InboxItemKind;
  label: string;
  items: InboxItem[];
}

/** Groups inbox items by kind in priority order, newest first within a group. */
export function groupInboxItems(items: readonly InboxItem[]): InboxGroup[] {
  const groups: InboxGroup[] = [];
  for (const kind of INBOX_KIND_ORDER) {
    const matching = items
      .filter((item) => item.kind === kind)
      .sort((left, right) => timestampOf(right.updatedAt) - timestampOf(left.updatedAt));
    if (matching.length > 0) {
      groups.push({ kind, label: inboxKindLabel(kind), items: matching });
    }
  }
  return groups;
}

function timestampOf(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Where the primary action of an inbox item should take the user. */
export function resolveInboxItemHref(item: InboxItem): string {
  if (item.botId) {
    return `/bots?bot=${encodeURIComponent(item.botId)}`;
  }
  if (item.kind === "plan_approval" && item.threadId && item.projectId) {
    return `/bots?project=${encodeURIComponent(item.projectId)}&thread=${encodeURIComponent(item.threadId)}`;
  }
  return `/sessions/${encodeURIComponent(item.sessionId || item.threadId || "")}`;
}

/** Splits a comma/space separated list, strips leading `@`/`#`, dedupes case-insensitively. */
export function parseHandleList(input: string): string[] {
  const seen = new Set<string>();
  const handles: string[] = [];
  for (const raw of input.split(/[\s,]+/)) {
    const handle = raw.trim().replace(/^[@#]+/, "");
    if (!handle) continue;
    const key = handle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    handles.push(handle);
  }
  return handles;
}

export function formatHandleList(handles: readonly string[]): string {
  return handles.join(", ");
}

/** A mention handle derived from the bot name, e.g. "Release Captain" -> "release-captain". */
export function suggestBotHandle(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type BotAttention = "approval" | "input" | "error" | null;

export function botAttention(bot: Pick<Bot, "status" | "waitingForApproval">): BotAttention {
  if (bot.waitingForApproval) return "approval";
  const status = bot.status.trim().toLowerCase();
  if (status === "needs_input") return "input";
  if (status === "errored" || status === "stuck") return "error";
  return null;
}

export function botIsWorking(bot: Pick<Bot, "status">): boolean {
  const status = bot.status.trim().toLowerCase();
  return status === "working" || status === "spawning" || status === "queued";
}

export function botStatusLabel(bot: Pick<Bot, "status" | "waitingForApproval">): string {
  const attention = botAttention(bot);
  if (attention === "approval") return "Needs your approval";
  if (attention === "input") return "Needs your input";
  if (attention === "error") return "Hit a problem";
  if (botIsWorking(bot)) return "Working";
  return "Idle";
}

/** Bots that need the user first, then working bots, then by most recent activity. */
export function sortBotsForList(bots: readonly Bot[]): Bot[] {
  const rank = (bot: Bot) => (botAttention(bot) ? 0 : botIsWorking(bot) ? 1 : 2);
  return [...bots].sort((left, right) => {
    const rankDelta = rank(left) - rank(right);
    if (rankDelta !== 0) return rankDelta;
    const activityDelta = timestampOf(right.lastActiveAt ?? right.updatedAt)
      - timestampOf(left.lastActiveAt ?? left.updatedAt);
    if (activityDelta !== 0) return activityDelta;
    return left.name.localeCompare(right.name);
  });
}

function formatTimeOfDay(time: string): string {
  const [hoursRaw, minutesRaw] = normalizeTimeOfDay(time).split(":");
  const hours = Number.parseInt(hoursRaw ?? "0", 10);
  const suffix = hours >= 12 ? "PM" : "AM";
  const displayHours = hours % 12 === 0 ? 12 : hours % 12;
  return `${displayHours}:${minutesRaw} ${suffix}`;
}

/** Human description of a cadence, e.g. "Every 2 hours" or "Weekdays at 9:00 AM". */
export function describeCadence(cadence: BotCadence): string {
  if (cadence.kind === "interval") {
    const minutes = Math.max(1, Math.round(cadence.minutes));
    if (minutes % 1440 === 0) {
      const days = minutes / 1440;
      return days === 1 ? "Every day" : `Every ${days} days`;
    }
    if (minutes % 60 === 0) {
      const hours = minutes / 60;
      return hours === 1 ? "Every hour" : `Every ${hours} hours`;
    }
    return minutes === 1 ? "Every minute" : `Every ${minutes} minutes`;
  }
  if (cadence.kind === "daily") {
    return `Daily at ${formatTimeOfDay(cadence.time)}`;
  }
  const days = normalizeWeekdays(cadence.days);
  const time = formatTimeOfDay(cadence.time);
  if (days.length === 0) return `Weekly at ${time} (no days selected)`;
  if (days.length === 7) return `Daily at ${time}`;
  if (days.join(",") === "1,2,3,4,5") return `Weekdays at ${time}`;
  if (days.join(",") === "0,6") return `Weekends at ${time}`;
  return `${days.map((day) => WEEKDAY_SHORT_LABELS[day]).join(", ")} at ${time}`;
}

/** Relative description of an ISO timestamp, past ("5m ago") or future ("in 2h"). */
export function describeRelativeTime(
  value: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return null;
  const deltaSeconds = Math.round((timestamp - now) / 1000);
  const absolute = Math.abs(deltaSeconds);
  if (absolute < 60) return deltaSeconds >= 0 ? "in under a minute" : "just now";
  let amount: string;
  if (absolute < 3600) amount = `${Math.floor(absolute / 60)}m`;
  else if (absolute < 86400) amount = `${Math.floor(absolute / 3600)}h`;
  else amount = `${Math.floor(absolute / 86400)}d`;
  return deltaSeconds >= 0 ? `in ${amount}` : `${amount} ago`;
}

export function describeScheduleNextRun(
  schedule: Pick<BotSchedule, "enabled" | "nextRunAt">,
  now: number = Date.now(),
): string {
  if (!schedule.enabled) return "Paused";
  const relative = describeRelativeTime(schedule.nextRunAt, now);
  if (!relative) return "Not scheduled yet";
  if (relative === "just now" || relative.endsWith("ago")) return "Due now";
  return `Next run ${relative}`;
}

export function describeScheduleLastRun(
  schedule: Pick<BotSchedule, "lastRunAt" | "lastStatus" | "lastError">,
  now: number = Date.now(),
): string {
  const relative = describeRelativeTime(schedule.lastRunAt, now);
  if (!relative) return "Never run";
  if (schedule.lastStatus === "error") {
    return `Failed ${relative}${schedule.lastError ? `: ${schedule.lastError}` : ""}`;
  }
  if (schedule.lastStatus === "busy") return `Skipped ${relative} (bot was busy)`;
  return `Last ran ${relative}`;
}

export function browserTimezoneOffsetMinutes(date: Date = new Date()): number {
  // getTimezoneOffset() is minutes WEST of UTC; the API wants minutes EAST.
  const offset = -date.getTimezoneOffset();
  return offset === 0 ? 0 : offset;
}

export function emptyBotDraft(projectId = ""): BotDraft {
  return {
    name: "",
    emoji: DEFAULT_BOT_EMOJI,
    role: "",
    instructions: "",
    projectId,
    dispatcherAgent: "",
    implementationAgent: "",
    handles: "",
    slackChannels: "",
    isDefault: false,
  };
}

export function botToDraft(bot: Bot): BotDraft {
  return {
    name: bot.name,
    emoji: bot.emoji || DEFAULT_BOT_EMOJI,
    role: bot.role,
    instructions: bot.instructions,
    projectId: bot.projectId,
    dispatcherAgent: bot.dispatcherAgent ?? "",
    implementationAgent: bot.implementationAgent ?? "",
    handles: formatHandleList(bot.handles),
    slackChannels: formatHandleList(bot.slackChannels),
    isDefault: bot.isDefault,
  };
}

export function validateBotDraft(draft: BotDraft): string | null {
  if (!draft.name.trim()) return "Give the bot a name.";
  if (!draft.projectId.trim()) return "Pick the project this bot works in.";
  return null;
}

/** Request body for POST /api/bots and PATCH /api/bots/{id}. */
export function botDraftToPayload(draft: BotDraft): Record<string, unknown> {
  return {
    name: draft.name.trim(),
    emoji: draft.emoji.trim() || DEFAULT_BOT_EMOJI,
    role: draft.role.trim(),
    instructions: draft.instructions.trim(),
    projectId: draft.projectId.trim(),
    dispatcherAgent: draft.dispatcherAgent.trim() || null,
    implementationAgent: draft.implementationAgent.trim() || null,
    handles: parseHandleList(draft.handles),
    slackChannels: parseHandleList(draft.slackChannels),
    isDefault: draft.isDefault,
  };
}

export type CadenceUnit = "minutes" | "hours";

export interface ScheduleDraft {
  title: string;
  prompt: string;
  kind: BotCadence["kind"];
  intervalAmount: number;
  intervalUnit: CadenceUnit;
  time: string;
  days: number[];
  enabled: boolean;
}

export function emptyScheduleDraft(): ScheduleDraft {
  return {
    title: "",
    prompt: "",
    kind: "daily",
    intervalAmount: 1,
    intervalUnit: "hours",
    time: "09:00",
    days: [1, 2, 3, 4, 5],
    enabled: true,
  };
}

export function scheduleToDraft(schedule: BotSchedule): ScheduleDraft {
  const draft = emptyScheduleDraft();
  draft.title = schedule.title;
  draft.prompt = schedule.prompt;
  draft.enabled = schedule.enabled;
  draft.kind = schedule.cadence.kind;
  if (schedule.cadence.kind === "interval") {
    const minutes = Math.max(1, Math.round(schedule.cadence.minutes));
    if (minutes % 60 === 0) {
      draft.intervalAmount = minutes / 60;
      draft.intervalUnit = "hours";
    } else {
      draft.intervalAmount = minutes;
      draft.intervalUnit = "minutes";
    }
  } else {
    draft.time = normalizeTimeOfDay(schedule.cadence.time);
    if (schedule.cadence.kind === "weekly") {
      draft.days = normalizeWeekdays(schedule.cadence.days);
    }
  }
  return draft;
}

export function scheduleDraftToCadence(draft: ScheduleDraft): BotCadence {
  if (draft.kind === "interval") {
    const amount = Number.isFinite(draft.intervalAmount) ? Math.max(1, Math.round(draft.intervalAmount)) : 1;
    return { kind: "interval", minutes: draft.intervalUnit === "hours" ? amount * 60 : amount };
  }
  if (draft.kind === "weekly") {
    return { kind: "weekly", days: normalizeWeekdays(draft.days), time: normalizeTimeOfDay(draft.time) };
  }
  return { kind: "daily", time: normalizeTimeOfDay(draft.time) };
}

export function validateScheduleDraft(draft: ScheduleDraft): string | null {
  if (!draft.title.trim()) return "Give the routine a title.";
  if (!draft.prompt.trim()) return "Describe what the bot should do on each run.";
  if (draft.kind === "weekly" && normalizeWeekdays(draft.days).length === 0) {
    return "Pick at least one day of the week.";
  }
  if (draft.kind === "interval" && !(draft.intervalAmount >= 1)) {
    return "The interval must be at least 1.";
  }
  return null;
}

/** Request body for POST/PATCH on a bot schedule. */
export function scheduleDraftToPayload(
  draft: ScheduleDraft,
  timezoneOffsetMinutes: number = browserTimezoneOffsetMinutes(),
): Record<string, unknown> {
  return {
    title: draft.title.trim(),
    prompt: draft.prompt.trim(),
    cadence: scheduleDraftToCadence(draft),
    timezoneOffsetMinutes,
    enabled: draft.enabled,
  };
}

export function upsertBot(bots: readonly Bot[], next: Bot): Bot[] {
  const index = bots.findIndex((bot) => bot.id === next.id);
  if (index === -1) return [...bots, next];
  const copy = [...bots];
  copy[index] = next;
  return copy;
}

export function botDispatcherApiPaths(projectId: string, threadId: string) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/dispatcher`;
  const threadQuery = `threadId=${encodeURIComponent(threadId)}`;
  return {
    feed: `${base}/feed?limit=120&${threadQuery}`,
    stream: `${base}/feed/stream?limit=120&${threadQuery}`,
    send: `${base}/send?${threadQuery}`,
    approve: `${base}/approve?${threadQuery}`,
    reject: `${base}/reject?${threadQuery}`,
    interrupt: `${base}/interrupt?${threadQuery}`,
    integration: `${base}/integration?${threadQuery}`,
  };
}
