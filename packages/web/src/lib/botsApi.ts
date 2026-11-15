import {
  normalizeBot,
  normalizeBots,
  normalizeInboxItems,
  type Bot,
  type BotThreadResponse,
  type InboxItem,
} from "@/lib/bots";
import type { DashboardSession } from "@/lib/types";

async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    cache: "no-store",
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload
      && typeof (payload as { error?: unknown }).error === "string"
      ? (payload as { error: string }).error
      : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return payload;
}

function expectBot(payload: unknown): Bot {
  const bot = normalizeBot((payload as { bot?: unknown } | null)?.bot);
  if (!bot) {
    throw new Error("The server response did not include a bot.");
  }
  return bot;
}

function expectThread(payload: unknown): DashboardSession {
  const thread = (payload as { thread?: unknown } | null)?.thread;
  if (!thread || typeof thread !== "object" || typeof (thread as { id?: unknown }).id !== "string") {
    throw new Error("The server response did not include a conversation.");
  }
  return thread as DashboardSession;
}

const botPath = (botId: string) => `/api/bots/${encodeURIComponent(botId)}`;
const schedulePath = (botId: string, scheduleId: string) =>
  `${botPath(botId)}/schedules/${encodeURIComponent(scheduleId)}`;

export async function fetchBots(signal?: AbortSignal): Promise<Bot[]> {
  return normalizeBots(await requestJson("/api/bots", { signal }));
}

export async function fetchInbox(signal?: AbortSignal): Promise<InboxItem[]> {
  return normalizeInboxItems(await requestJson("/api/inbox", { signal }));
}

export async function createBot(body: Record<string, unknown>): Promise<Bot> {
  return expectBot(await requestJson("/api/bots", { method: "POST", body: JSON.stringify(body) }));
}

export async function updateBot(botId: string, body: Record<string, unknown>): Promise<Bot> {
  return expectBot(await requestJson(botPath(botId), { method: "PATCH", body: JSON.stringify(body) }));
}

export async function deleteBot(botId: string): Promise<void> {
  await requestJson(botPath(botId), { method: "DELETE" });
}

export async function ensureBotThread(botId: string): Promise<BotThreadResponse> {
  const payload = await requestJson(`${botPath(botId)}/thread`, { method: "POST" });
  return { bot: expectBot(payload), thread: expectThread(payload) };
}

export async function resetBotThread(botId: string): Promise<BotThreadResponse> {
  const payload = await requestJson(`${botPath(botId)}/thread/reset`, { method: "POST" });
  return { bot: expectBot(payload), thread: expectThread(payload) };
}

export async function fetchDispatcherThread(
  projectId: string,
  threadId: string,
  signal?: AbortSignal,
): Promise<DashboardSession | null> {
  const payload = await requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/dispatcher?threadId=${encodeURIComponent(threadId)}`,
    { signal },
  );
  const thread = (payload as { thread?: unknown } | null)?.thread;
  return thread && typeof thread === "object" ? (thread as DashboardSession) : null;
}

export async function createBotSchedule(botId: string, body: Record<string, unknown>): Promise<Bot> {
  return expectBot(
    await requestJson(`${botPath(botId)}/schedules`, { method: "POST", body: JSON.stringify(body) }),
  );
}

export async function updateBotSchedule(
  botId: string,
  scheduleId: string,
  body: Record<string, unknown>,
): Promise<Bot> {
  return expectBot(
    await requestJson(schedulePath(botId, scheduleId), { method: "PATCH", body: JSON.stringify(body) }),
  );
}

export async function deleteBotSchedule(botId: string, scheduleId: string): Promise<Bot> {
  return expectBot(await requestJson(schedulePath(botId, scheduleId), { method: "DELETE" }));
}

export async function runBotScheduleNow(botId: string, scheduleId: string): Promise<Bot> {
  return expectBot(await requestJson(`${schedulePath(botId, scheduleId)}/run`, { method: "POST" }));
}

export async function fetchPushPublicKey(): Promise<{ publicKey: string; enabled: boolean }> {
  const payload = await requestJson("/api/push/public-key") as { publicKey?: unknown; enabled?: unknown } | null;
  return {
    publicKey: typeof payload?.publicKey === "string" ? payload.publicKey : "",
    enabled: payload?.enabled !== false,
  };
}

export async function savePushSubscription(body: unknown): Promise<void> {
  await requestJson("/api/push/subscriptions", { method: "POST", body: JSON.stringify(body) });
}

export async function removePushSubscription(endpoint: string): Promise<void> {
  await requestJson("/api/push/subscriptions", { method: "DELETE", body: JSON.stringify({ endpoint }) });
}

export async function sendTestPush(): Promise<number> {
  const payload = await requestJson("/api/push/test", { method: "POST" }) as { sent?: unknown } | null;
  return typeof payload?.sent === "number" ? payload.sent : 0;
}
