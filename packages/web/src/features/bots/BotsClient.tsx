"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarClock,
  ChevronLeft,
  Inbox,
  LayoutDashboard,
  Loader2,
  MessageSquarePlus,
  Plus,
  Settings,
} from "lucide-react";
import { DispatcherSessionPane } from "@/components/dispatcher/DispatcherSessionPane";
import { KeyboardSafeViewportMetricsProvider } from "@/components/layout/KeyboardSafeViewportMetricsProvider";
import { KEYBOARD_SAFE_VIEWPORT_FRAME_CLASS_NAME } from "@/components/layout/keyboardSafeViewport";
import { Button } from "@/components/ui/Button";
import { useBots } from "@/hooks/useBots";
import { useConfig } from "@/hooks/useConfig";
import {
  botAttention,
  botDispatcherApiPaths,
  botIsWorking,
  botStatusLabel,
  sortBotsForList,
  upsertBot,
  type Bot,
} from "@/lib/bots";
import { ensureBotThread, fetchDispatcherThread, resetBotThread } from "@/lib/botsApi";
import { cn } from "@/lib/cn";
import type { DashboardSession } from "@/lib/types";
import { BotEditorDialog } from "./BotEditorDialog";
import { BotInboxPanel } from "./BotInboxPanel";
import { BotSchedulesDialog } from "./BotSchedulesDialog";
import { BOT_ERROR_BANNER_CLASS_NAME } from "./botFormStyles";
import { PushNotificationsControl } from "./PushNotificationsControl";

const DESKTOP_MEDIA_QUERY = "(min-width: 1024px)";
const THREAD_REFRESH_INTERVAL_MS = 10_000;

const HEADER_ICON_BUTTON_CLASS_NAME =
  "oc-mobile-touch-target inline-flex h-11 shrink-0 items-center gap-1.5 rounded-[4px] px-2 text-[12px] font-medium text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)] disabled:pointer-events-none disabled:opacity-45 sm:h-8";

function useIsDesktop(): boolean | null {
  const [isDesktop, setIsDesktop] = useState<boolean | null>(null);
  useEffect(() => {
    const query = window.matchMedia(DESKTOP_MEDIA_QUERY);
    const update = () => setIsDesktop(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return isDesktop;
}

function BotStatusDot({ bot }: { bot: Bot }) {
  const attention = botAttention(bot);
  const working = botIsWorking(bot);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block h-2 w-2 shrink-0 rounded-full",
        attention === "error"
          ? "bg-[var(--status-error)]"
          : attention
            ? "bg-[var(--status-attention)]"
            : working
              ? "bg-[var(--status-working)] attention-glow"
              : "bg-[var(--status-idle)]",
      )}
    />
  );
}

type ThreadState = {
  /** `bot:<id>` or `thread:<project>:<id>`; identifies what the thread belongs to. */
  key: string;
  projectId: string;
  thread: DashboardSession;
};

export function BotsClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isDesktop = useIsDesktop();
  const { bots, inbox, loading, error, refresh, setBots } = useBots();
  const { projects, loading: projectsLoading } = useConfig();

  const selectedBotId = searchParams.get("bot");
  const inboxSelected = searchParams.get("view") === "inbox";
  const adHocProjectId = searchParams.get("project");
  const adHocThreadId = searchParams.get("thread");
  const adHocSelected = Boolean(adHocProjectId && adHocThreadId) && !selectedBotId && !inboxSelected;
  const hasExplicitSelection = Boolean(selectedBotId) || inboxSelected || adHocSelected;

  const sortedBots = useMemo(() => sortBotsForList(bots), [bots]);
  const activeBot = useMemo(() => {
    if (inboxSelected || adHocSelected) return null;
    if (selectedBotId) return bots.find((bot) => bot.id === selectedBotId) ?? null;
    // Desktop shows the list and a chat side by side, so open the first bot.
    return isDesktop ? sortedBots[0] ?? null : null;
  }, [adHocSelected, bots, inboxSelected, isDesktop, selectedBotId, sortedBots]);
  const activeBotId = activeBot?.id ?? null;

  const [threadState, setThreadState] = useState<ThreadState | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorBotId, setEditorBotId] = useState<string | null>(null);
  const [schedulesOpen, setSchedulesOpen] = useState(false);

  const targetKey = activeBotId
    ? `bot:${activeBotId}`
    : adHocSelected
      ? `thread:${adHocProjectId}:${adHocThreadId}`
      : null;

  const applyBot = useCallback((bot: Bot) => {
    setBots((current) => upsertBot(current, bot));
  }, [setBots]);

  // Open (or create) the conversation for the active bot or ad-hoc thread.
  useEffect(() => {
    if (!targetKey) {
      setThreadState(null);
      setThreadError(null);
      setThreadLoading(false);
      return;
    }
    let cancelled = false;
    setThreadLoading(true);
    setThreadError(null);
    void (async () => {
      try {
        if (activeBotId) {
          const { bot, thread } = await ensureBotThread(activeBotId);
          if (cancelled) return;
          applyBot(bot);
          setThreadState({ key: targetKey, projectId: bot.projectId, thread });
        } else if (adHocProjectId && adHocThreadId) {
          const thread = await fetchDispatcherThread(adHocProjectId, adHocThreadId);
          if (cancelled) return;
          if (!thread) throw new Error("That conversation no longer exists.");
          setThreadState({ key: targetKey, projectId: adHocProjectId, thread });
        }
      } catch (err) {
        if (!cancelled) {
          setThreadState(null);
          setThreadError(err instanceof Error ? err.message : "Failed to open the conversation");
        }
      } finally {
        if (!cancelled) setThreadLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeBotId, adHocProjectId, adHocThreadId, applyBot, targetKey]);

  const currentThread = threadState && threadState.key === targetKey ? threadState : null;
  const currentThreadId = currentThread?.thread.id ?? null;
  const currentThreadProjectId = currentThread?.projectId ?? null;

  // Keep the session record (status, model, metadata) fresh; the feed itself streams.
  useEffect(() => {
    if (!currentThreadId || !currentThreadProjectId || !targetKey) return;
    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void fetchDispatcherThread(currentThreadProjectId, currentThreadId)
        .then((thread) => {
          if (!thread) return;
          setThreadState((current) =>
            current && current.key === targetKey && current.thread.id === thread.id
              ? { ...current, thread }
              : current);
        })
        .catch(() => {
          // Transient; the next tick retries.
        });
    }, THREAD_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [currentThreadId, currentThreadProjectId, targetKey]);

  const selectBot = useCallback((botId: string) => {
    router.push(`/bots?bot=${encodeURIComponent(botId)}`);
  }, [router]);

  const handleNewConversation = useCallback(async () => {
    if (!activeBotId || !targetKey) return;
    setResetting(true);
    setThreadError(null);
    try {
      const { bot, thread } = await resetBotThread(activeBotId);
      applyBot(bot);
      setThreadState({ key: targetKey, projectId: bot.projectId, thread });
    } catch (err) {
      setThreadError(err instanceof Error ? err.message : "Failed to start a new conversation");
    } finally {
      setResetting(false);
    }
  }, [activeBotId, applyBot, targetKey]);

  const openEditor = useCallback((botId: string | null) => {
    setEditorBotId(botId);
    setEditorOpen(true);
  }, []);

  const handleBotSaved = useCallback((bot: Bot) => {
    applyBot(bot);
    // A project change invalidates the open conversation; reload it.
    setThreadState((current) => (current?.key === `bot:${bot.id}` && current.projectId !== bot.projectId ? null : current));
    selectBot(bot.id);
    void refresh();
  }, [applyBot, refresh, selectBot]);

  const handleBotDeleted = useCallback((botId: string) => {
    setBots((current) => current.filter((bot) => bot.id !== botId));
    if (selectedBotId === botId) {
      router.replace("/bots");
    }
    void refresh();
  }, [refresh, router, selectedBotId, setBots]);

  const editorBot = editorBotId ? bots.find((bot) => bot.id === editorBotId) ?? null : null;
  const noBots = !loading && bots.length === 0;
  // With no bots there is nothing to list, so phones go straight to the empty state.
  const showMainOnMobile = hasExplicitSelection || noBots;
  const selectedBotMissing = Boolean(selectedBotId) && !loading && !activeBot;

  const botList = (
    <nav aria-label="Bots" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--vk-border)] px-3 py-2">
        <Link
          href="/bots?view=inbox"
          aria-current={inboxSelected ? "page" : undefined}
          className={cn(
            "oc-mobile-touch-target flex h-11 min-w-0 flex-1 items-center gap-2 rounded-[8px] px-2.5 text-[13px] font-medium transition-colors sm:h-9",
            inboxSelected
              ? "bg-[var(--vk-bg-active)] text-[var(--vk-text-normal)]"
              : "text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)]",
          )}
        >
          <Inbox className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Inbox</span>
          {inbox.length > 0 ? (
            <span
              className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--vk-orange)] px-1.5 text-[11px] font-semibold leading-none text-white"
              aria-label={`${inbox.length} waiting on you`}
            >
              {inbox.length > 99 ? "99+" : inbox.length}
            </span>
          ) : null}
        </Link>
        <Button
          type="button"
          size="sm"
          variant="primary"
          onClick={() => openEditor(null)}
          disabled={projectsLoading || projects.length === 0}
          title={projects.length === 0 ? "Add a workspace on the dashboard first" : "Create a bot"}
          className="h-11 shrink-0 sm:h-9"
        >
          <Plus className="h-4 w-4" />
          New bot
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-[13px] text-[var(--vk-text-muted)]">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading bots…
          </div>
        ) : null}
        {error && bots.length === 0 ? (
          <div role="alert" className={BOT_ERROR_BANNER_CLASS_NAME}>{error}</div>
        ) : null}
        {noBots && !error ? (
          <p className="px-2 py-6 text-center text-[12px] leading-5 text-[var(--vk-text-muted)]">
            No bots yet.
          </p>
        ) : null}
        <ul className="space-y-1">
          {sortedBots.map((bot) => {
            const selected = bot.id === activeBotId;
            const attention = botAttention(bot);
            return (
              <li key={bot.id}>
                <button
                  type="button"
                  onClick={() => selectBot(bot.id)}
                  aria-current={selected ? "page" : undefined}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2.5 text-left transition-colors",
                    selected ? "bg-[var(--vk-bg-active)]" : "hover:bg-[var(--vk-bg-hover)]",
                  )}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--vk-border)] bg-[var(--vk-bg-main)] text-[18px] leading-none">
                    {bot.emoji}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-[var(--vk-text-normal)]">
                        {bot.name}
                      </span>
                      <BotStatusDot bot={bot} />
                    </span>
                    <span
                      className={cn(
                        "mt-0.5 block truncate text-[12px]",
                        attention ? "text-[var(--status-attention)]" : "text-[var(--vk-text-muted)]",
                      )}
                    >
                      {attention || botIsWorking(bot) ? botStatusLabel(bot) : bot.role || bot.projectId}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );

  let main: React.ReactNode;
  if (inboxSelected) {
    main = <BotInboxPanel items={inbox} loading={loading} />;
  } else if (noBots && !adHocSelected) {
    main = (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
        <div className="w-full max-w-[460px] rounded-[12px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] p-6 text-center">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-[var(--vk-border)] bg-[var(--vk-bg-main)] text-[22px]">
            🤖
          </div>
          <h2 className="mt-3 text-[15px] font-medium text-[var(--vk-text-strong)]">
            Create your first bot
          </h2>
          <p className="mt-2 text-[13px] leading-5 text-[var(--vk-text-muted)]">
            A bot is a named teammate with a job, standing instructions and memory. Message it like a
            colleague; it plans the work, hands tasks to coding agents on this machine, and comes
            back to you only when it needs a decision.
          </p>
          {projects.length === 0 && !projectsLoading ? (
            <>
              <p className="mt-3 text-[12px] leading-5 text-[var(--vk-text-muted)]">
                Bots work inside a project. Add a workspace first.
              </p>
              <Button asChild variant="primary" className="mt-4">
                <Link href="/">
                  <LayoutDashboard className="h-4 w-4" />
                  Add a workspace
                </Link>
              </Button>
            </>
          ) : (
            <Button type="button" variant="primary" className="mt-4" onClick={() => openEditor(null)} disabled={projectsLoading}>
              <Plus className="h-4 w-4" />
              Create your first bot
            </Button>
          )}
        </div>
      </div>
    );
  } else if (selectedBotMissing) {
    main = (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-[13px] text-[var(--vk-text-muted)]">
        That bot no longer exists.
      </div>
    );
  } else if (currentThread) {
    main = (
      <div className="flex min-h-0 flex-1 justify-center bg-[var(--vk-bg-panel)]">
        <DispatcherSessionPane
          key={currentThread.thread.id}
          session={currentThread.thread}
          className="max-w-[880px] border-t-0 xl:w-full xl:border-l-0"
          hideOpenSessionAction
          hideRepositoryControls
          hideSessionStatusBadge
          apiPaths={botDispatcherApiPaths(currentThread.projectId, currentThread.thread.id)}
        />
      </div>
    );
  } else if (threadError) {
    main = (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="max-w-[420px] text-center">
          <div role="alert" className={BOT_ERROR_BANNER_CLASS_NAME}>{threadError}</div>
          <Button type="button" className="mt-3" onClick={() => void refresh().then(() => router.refresh())}>
            Try again
          </Button>
        </div>
      </div>
    );
  } else if (threadLoading || loading || isDesktop === null) {
    main = (
      <div className="flex min-h-0 flex-1 items-center justify-center text-[13px] text-[var(--vk-text-muted)]">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Opening conversation…
      </div>
    );
  } else {
    main = (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-[13px] text-[var(--vk-text-muted)]">
        Pick a bot to start chatting.
      </div>
    );
  }

  const mainTitle = inboxSelected
    ? "Inbox"
    : activeBot
      ? activeBot.name
      : adHocSelected
        ? "Dispatcher conversation"
        : "Bots";

  return (
    <KeyboardSafeViewportMetricsProvider lockDocumentScrolling>
      <div className={cn("flex w-full flex-col overflow-hidden bg-[var(--vk-bg-main)]", KEYBOARD_SAFE_VIEWPORT_FRAME_CLASS_NAME)}>
        <header className="flex h-11 shrink-0 items-center gap-1 border-b border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-2 sm:h-[41px] sm:px-3">
          <Link href="/" className={HEADER_ICON_BUTTON_CLASS_NAME} aria-label="Back to dashboard" title="Dashboard">
            <LayoutDashboard className="h-4 w-4" />
            <span className="hidden sm:inline">Dashboard</span>
          </Link>
          <h1 className="min-w-0 flex-1 truncate px-1 text-center text-[13px] font-medium text-[var(--vk-text-normal)]">
            Bots
          </h1>
          <PushNotificationsControl />
        </header>

        <div className="flex min-h-0 flex-1">
          <aside
            className={cn(
              "min-h-0 w-full flex-col border-r border-[var(--vk-border)] bg-[var(--vk-bg-panel)] lg:flex lg:w-[300px] lg:shrink-0",
              showMainOnMobile ? "hidden" : "flex",
            )}
          >
            {botList}
          </aside>

          <section
            aria-label={mainTitle}
            className={cn(
              "min-h-0 min-w-0 flex-1 flex-col lg:flex",
              showMainOnMobile ? "flex" : "hidden",
            )}
          >
            {activeBot || inboxSelected || adHocSelected ? (
              <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--vk-border)] bg-[var(--vk-bg-panel)]/70 px-2 sm:px-3">
                <Link
                  href="/bots"
                  className={cn(HEADER_ICON_BUTTON_CLASS_NAME, "w-11 justify-center px-0 sm:w-8 lg:hidden")}
                  aria-label="Back to bots"
                  title="Back to bots"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Link>
                {activeBot ? (
                  <>
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--vk-border)] bg-[var(--vk-bg-main)] text-[16px] leading-none">
                      {activeBot.emoji}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 truncate text-[13px] font-medium text-[var(--vk-text-normal)]">
                        <span className="truncate">{activeBot.name}</span>
                        <BotStatusDot bot={activeBot} />
                      </p>
                      <p className="truncate text-[11px] text-[var(--vk-text-muted)]">
                        {[botStatusLabel(activeBot), activeBot.role || null, activeBot.projectId]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSchedulesOpen(true)}
                      className={HEADER_ICON_BUTTON_CLASS_NAME}
                      aria-label="Routines"
                      title="Routines"
                    >
                      <CalendarClock className="h-4 w-4" />
                      <span className="hidden xl:inline">
                        Routines{activeBot.schedules.length > 0 ? ` (${activeBot.schedules.length})` : ""}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleNewConversation()}
                      disabled={resetting || threadLoading}
                      className={HEADER_ICON_BUTTON_CLASS_NAME}
                      aria-label="New conversation"
                      title="New conversation"
                    >
                      {resetting ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageSquarePlus className="h-4 w-4" />}
                      <span className="hidden xl:inline">New conversation</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => openEditor(activeBot.id)}
                      className={HEADER_ICON_BUTTON_CLASS_NAME}
                      aria-label="Bot settings"
                      title="Bot settings"
                    >
                      <Settings className="h-4 w-4" />
                      <span className="hidden xl:inline">Settings</span>
                    </button>
                  </>
                ) : (
                  <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--vk-text-normal)]">
                    {mainTitle}
                  </p>
                )}
              </div>
            ) : null}
            {currentThread && threadError ? (
              <div role="alert" className={cn(BOT_ERROR_BANNER_CLASS_NAME, "m-2")}>{threadError}</div>
            ) : null}
            {main}
          </section>
        </div>
      </div>

      <BotEditorDialog
        open={editorOpen}
        bot={editorBot}
        projects={projects}
        defaultProjectId={activeBot?.projectId ?? null}
        onOpenChange={setEditorOpen}
        onSaved={handleBotSaved}
        onDeleted={handleBotDeleted}
      />
      <BotSchedulesDialog
        open={schedulesOpen}
        bot={activeBot}
        onOpenChange={setSchedulesOpen}
        onBotUpdated={applyBot}
      />
    </KeyboardSafeViewportMetricsProvider>
  );
}
