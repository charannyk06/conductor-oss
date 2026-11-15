import assert from "node:assert/strict";
import test from "node:test";
import {
  botAttention,
  botDispatcherApiPaths,
  botDraftToPayload,
  botStatusLabel,
  botToDraft,
  describeCadence,
  describeRelativeTime,
  describeScheduleLastRun,
  describeScheduleNextRun,
  emptyBotDraft,
  emptyScheduleDraft,
  groupInboxItems,
  normalizeBot,
  normalizeBots,
  normalizeCadence,
  normalizeInboxItems,
  parseHandleList,
  resolveInboxItemHref,
  scheduleDraftToCadence,
  scheduleDraftToPayload,
  scheduleToDraft,
  sortBotsForList,
  suggestBotHandle,
  upsertBot,
  validateBotDraft,
  validateScheduleDraft,
  type Bot,
  type InboxItem,
} from "./bots";

const NOW = Date.parse("2026-11-15T12:00:00Z");

function makeBot(overrides: Partial<Bot> = {}): Bot {
  const bot = normalizeBot({ id: "bot-1", name: "Rel", projectId: "app", ...overrides });
  assert.ok(bot);
  return bot;
}

function makeInboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "i1",
    kind: "needs_input",
    title: "Title",
    summary: "",
    projectId: "app",
    sessionId: "s1",
    threadId: null,
    botId: null,
    botName: null,
    updatedAt: "2026-11-15T11:00:00Z",
    ...overrides,
  };
}

test("describeCadence formats intervals", () => {
  assert.equal(describeCadence({ kind: "interval", minutes: 1 }), "Every minute");
  assert.equal(describeCadence({ kind: "interval", minutes: 15 }), "Every 15 minutes");
  assert.equal(describeCadence({ kind: "interval", minutes: 60 }), "Every hour");
  assert.equal(describeCadence({ kind: "interval", minutes: 120 }), "Every 2 hours");
  assert.equal(describeCadence({ kind: "interval", minutes: 90 }), "Every 90 minutes");
  assert.equal(describeCadence({ kind: "interval", minutes: 1440 }), "Every day");
});

test("describeCadence formats daily and weekly cadences", () => {
  assert.equal(describeCadence({ kind: "daily", time: "09:00" }), "Daily at 9:00 AM");
  assert.equal(describeCadence({ kind: "daily", time: "00:05" }), "Daily at 12:05 AM");
  assert.equal(describeCadence({ kind: "daily", time: "13:30" }), "Daily at 1:30 PM");
  assert.equal(
    describeCadence({ kind: "weekly", days: [1, 2, 3, 4, 5], time: "09:00" }),
    "Weekdays at 9:00 AM",
  );
  assert.equal(describeCadence({ kind: "weekly", days: [6, 0], time: "18:00" }), "Weekends at 6:00 PM");
  assert.equal(describeCadence({ kind: "weekly", days: [3, 1], time: "12:00" }), "Mon, Wed at 12:00 PM");
  assert.equal(
    describeCadence({ kind: "weekly", days: [0, 1, 2, 3, 4, 5, 6], time: "07:00" }),
    "Daily at 7:00 AM",
  );
  assert.match(describeCadence({ kind: "weekly", days: [], time: "07:00" }), /no days selected/);
});

test("normalizeCadence falls back to an hourly interval for bad input", () => {
  assert.deepEqual(normalizeCadence(null), { kind: "interval", minutes: 60 });
  assert.deepEqual(normalizeCadence({ kind: "interval", minutes: 0 }), { kind: "interval", minutes: 1 });
  assert.deepEqual(normalizeCadence({ kind: "daily", time: "25:00" }), { kind: "daily", time: "09:00" });
  assert.deepEqual(
    normalizeCadence({ kind: "weekly", days: [5, 5, 9, 1], time: "7:05" }),
    { kind: "weekly", days: [1, 5], time: "07:05" },
  );
});

test("describeRelativeTime handles past, future and invalid values", () => {
  assert.equal(describeRelativeTime(null, NOW), null);
  assert.equal(describeRelativeTime("not a date", NOW), null);
  assert.equal(describeRelativeTime("2026-11-15T11:59:40Z", NOW), "just now");
  assert.equal(describeRelativeTime("2026-11-15T11:55:00Z", NOW), "5m ago");
  assert.equal(describeRelativeTime("2026-11-15T09:00:00Z", NOW), "3h ago");
  assert.equal(describeRelativeTime("2026-11-13T12:00:00Z", NOW), "2d ago");
  assert.equal(describeRelativeTime("2026-11-15T12:00:20Z", NOW), "in under a minute");
  assert.equal(describeRelativeTime("2026-11-15T12:30:00Z", NOW), "in 30m");
  assert.equal(describeRelativeTime("2026-11-16T13:00:00Z", NOW), "in 1d");
});

test("schedule run descriptions cover paused, due and failed states", () => {
  assert.equal(describeScheduleNextRun({ enabled: false, nextRunAt: "2026-11-15T13:00:00Z" }, NOW), "Paused");
  assert.equal(describeScheduleNextRun({ enabled: true, nextRunAt: null }, NOW), "Not scheduled yet");
  assert.equal(describeScheduleNextRun({ enabled: true, nextRunAt: "2026-11-15T11:00:00Z" }, NOW), "Due now");
  assert.equal(
    describeScheduleNextRun({ enabled: true, nextRunAt: "2026-11-15T14:00:00Z" }, NOW),
    "Next run in 2h",
  );
  assert.equal(describeScheduleLastRun({ lastRunAt: null, lastStatus: null, lastError: null }, NOW), "Never run");
  assert.equal(
    describeScheduleLastRun({ lastRunAt: "2026-11-15T11:00:00Z", lastStatus: "ok", lastError: null }, NOW),
    "Last ran 1h ago",
  );
  assert.equal(
    describeScheduleLastRun({ lastRunAt: "2026-11-15T11:00:00Z", lastStatus: "error", lastError: "boom" }, NOW),
    "Failed 1h ago: boom",
  );
  assert.match(
    describeScheduleLastRun({ lastRunAt: "2026-11-15T11:00:00Z", lastStatus: "busy", lastError: null }, NOW),
    /bot was busy/,
  );
});

test("parseHandleList strips prefixes, splits and dedupes", () => {
  assert.deepEqual(parseHandleList(""), []);
  assert.deepEqual(parseHandleList("@rel,  #ops  Rel\nqa,,"), ["rel", "ops", "qa"]);
  assert.deepEqual(parseHandleList("C0123, C0456"), ["C0123", "C0456"]);
});

test("suggestBotHandle slugifies a name", () => {
  assert.equal(suggestBotHandle("  Release Captain! "), "release-captain");
  assert.equal(suggestBotHandle("🤖"), "");
});

test("groupInboxItems orders kinds by priority and items newest first", () => {
  const groups = groupInboxItems([
    makeInboxItem({ id: "a", kind: "review", updatedAt: "2026-11-15T10:00:00Z" }),
    makeInboxItem({ id: "b", kind: "needs_input", updatedAt: "2026-11-15T09:00:00Z" }),
    makeInboxItem({ id: "c", kind: "plan_approval" }),
    makeInboxItem({ id: "d", kind: "needs_input", updatedAt: "2026-11-15T11:00:00Z" }),
  ]);
  assert.deepEqual(groups.map((group) => group.kind), ["plan_approval", "needs_input", "review"]);
  assert.deepEqual(groups[1]?.items.map((item) => item.id), ["d", "b"]);
  assert.deepEqual(groupInboxItems([]), []);
});

test("resolveInboxItemHref routes to the bot, the thread, or the session", () => {
  assert.equal(resolveInboxItemHref(makeInboxItem({ botId: "bot 1", kind: "plan_approval" })), "/bots?bot=bot%201");
  assert.equal(
    resolveInboxItemHref(makeInboxItem({ kind: "plan_approval", threadId: "t1", projectId: "my app" })),
    "/bots?project=my%20app&thread=t1",
  );
  assert.equal(resolveInboxItemHref(makeInboxItem({ kind: "failed", sessionId: "s/1" })), "/sessions/s%2F1");
});

test("normalizers drop malformed entries and fill defaults", () => {
  const bots = normalizeBots({
    bots: [
      null,
      { name: "missing id" },
      { id: "b1", name: "Rel", projectId: "app", schedules: [{ id: "s1", cadence: { kind: "daily", time: "08:00" } }, 7] },
    ],
  });
  assert.equal(bots.length, 1);
  assert.equal(bots[0]?.emoji, "🤖");
  assert.equal(bots[0]?.status, "idle");
  assert.equal(bots[0]?.schedules.length, 1);
  assert.equal(bots[0]?.schedules[0]?.enabled, true);
  assert.deepEqual(normalizeBots(null), []);
  assert.deepEqual(
    normalizeInboxItems({ items: [{ id: "x", kind: "bogus" }, { id: "y", kind: "failed" }] }).map((item) => item.id),
    ["y"],
  );
});

test("bot attention, labels and list ordering", () => {
  assert.equal(botAttention(makeBot({ waitingForApproval: true, status: "needs_input" })), "approval");
  assert.equal(botAttention(makeBot({ status: "needs_input" })), "input");
  assert.equal(botAttention(makeBot({ status: "errored" })), "error");
  assert.equal(botAttention(makeBot({ status: "working" })), null);
  assert.equal(botStatusLabel(makeBot({ status: "working" })), "Working");
  assert.equal(botStatusLabel(makeBot({ status: "idle" })), "Idle");

  const sorted = sortBotsForList([
    makeBot({ id: "idle-old", lastActiveAt: "2026-11-10T00:00:00Z" }),
    makeBot({ id: "working", status: "working" }),
    makeBot({ id: "idle-new", lastActiveAt: "2026-11-14T00:00:00Z" }),
    makeBot({ id: "needs", status: "needs_input" }),
  ]);
  assert.deepEqual(sorted.map((bot) => bot.id), ["needs", "working", "idle-new", "idle-old"]);
});

test("bot drafts validate and round-trip to request payloads", () => {
  assert.equal(validateBotDraft(emptyBotDraft("app")), "Give the bot a name.");
  assert.equal(validateBotDraft({ ...emptyBotDraft(), name: "Rel" }), "Pick the project this bot works in.");

  const draft = botToDraft(makeBot({ handles: ["rel", "captain"], dispatcherAgent: "codex", isDefault: true }));
  assert.equal(draft.handles, "rel, captain");
  assert.equal(validateBotDraft(draft), null);
  assert.deepEqual(botDraftToPayload({ ...draft, name: " Rel ", emoji: " ", slackChannels: "#C1 C2" }), {
    name: "Rel",
    emoji: "🤖",
    role: "",
    instructions: "",
    projectId: "app",
    dispatcherAgent: "codex",
    implementationAgent: null,
    handles: ["rel", "captain"],
    slackChannels: ["C1", "C2"],
    isDefault: true,
  });
});

test("schedule drafts validate and convert to cadences", () => {
  const draft = emptyScheduleDraft();
  assert.equal(validateScheduleDraft(draft), "Give the routine a title.");
  draft.title = "Triage";
  assert.equal(validateScheduleDraft(draft), "Describe what the bot should do on each run.");
  draft.prompt = "Triage issues";
  assert.equal(validateScheduleDraft(draft), null);
  assert.deepEqual(scheduleDraftToCadence(draft), { kind: "daily", time: "09:00" });

  assert.equal(validateScheduleDraft({ ...draft, kind: "weekly", days: [] }), "Pick at least one day of the week.");
  assert.deepEqual(
    scheduleDraftToCadence({ ...draft, kind: "weekly", days: [5, 1] }),
    { kind: "weekly", days: [1, 5], time: "09:00" },
  );
  assert.deepEqual(
    scheduleDraftToCadence({ ...draft, kind: "interval", intervalAmount: 2, intervalUnit: "hours" }),
    { kind: "interval", minutes: 120 },
  );
  assert.equal(
    validateScheduleDraft({ ...draft, kind: "interval", intervalAmount: Number.NaN }),
    "The interval must be at least 1.",
  );
  assert.deepEqual(scheduleDraftToPayload(draft, 330), {
    title: "Triage",
    prompt: "Triage issues",
    cadence: { kind: "daily", time: "09:00" },
    timezoneOffsetMinutes: 330,
    enabled: true,
  });
});

test("scheduleToDraft picks the most readable interval unit", () => {
  const base = makeBot({
    schedules: [
      { id: "a", cadence: { kind: "interval", minutes: 180 } },
      { id: "b", cadence: { kind: "interval", minutes: 45 } },
      { id: "c", cadence: { kind: "weekly", days: [2], time: "06:30" } },
    ] as never,
  }).schedules;
  assert.deepEqual(
    [scheduleToDraft(base[0]!).intervalAmount, scheduleToDraft(base[0]!).intervalUnit],
    [3, "hours"],
  );
  assert.deepEqual(
    [scheduleToDraft(base[1]!).intervalAmount, scheduleToDraft(base[1]!).intervalUnit],
    [45, "minutes"],
  );
  const weekly = scheduleToDraft(base[2]!);
  assert.deepEqual([weekly.kind, weekly.days, weekly.time], ["weekly", [2], "06:30"]);
});

test("upsertBot replaces in place or appends", () => {
  const first = makeBot({ id: "a", name: "A" });
  const second = makeBot({ id: "b", name: "B" });
  assert.deepEqual(upsertBot([first], second).map((bot) => bot.id), ["a", "b"]);
  assert.equal(upsertBot([first, second], makeBot({ id: "a", name: "A2" }))[0]?.name, "A2");
});

test("botDispatcherApiPaths scopes every endpoint to the thread", () => {
  const paths = botDispatcherApiPaths("my app", "t 1");
  assert.equal(paths.send, "/api/projects/my%20app/dispatcher/send?threadId=t%201");
  assert.equal(paths.feed, "/api/projects/my%20app/dispatcher/feed?limit=120&threadId=t%201");
  for (const value of Object.values(paths)) {
    assert.ok(value.endsWith("threadId=t%201"));
  }
});
