"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import {
  DISPATCHER_SURFACE_CONTENT_CLASS_NAME,
  DISPATCHER_SURFACE_OVERLAY_CLASS_NAME,
} from "@/components/dispatcher/dispatcherMobileLayout";
import { Button } from "@/components/ui/Button";
import type { ConfigProject } from "@/hooks/useConfig";
import {
  botDraftToPayload,
  botToDraft,
  emptyBotDraft,
  parseHandleList,
  suggestBotHandle,
  validateBotDraft,
  type Bot,
  type BotDraft,
} from "@/lib/bots";
import { createBot, deleteBot, updateBot } from "@/lib/botsApi";
import {
  DISPATCHER_HANDOFF_AGENT_OPTIONS,
  DISPATCHER_RUNTIME_AGENT_OPTIONS,
} from "@/lib/dispatcherPreferences";
import { getKnownAgent } from "@/lib/knownAgents";
import {
  BOT_ERROR_BANNER_CLASS_NAME,
  BOT_FIELD_HINT_CLASS_NAME,
  BOT_FIELD_INPUT_CLASS_NAME,
  BOT_FIELD_LABEL_CLASS_NAME,
} from "./botFormStyles";

type BotEditorDialogProps = {
  open: boolean;
  /** The bot being edited, or null to create a new one. */
  bot: Bot | null;
  projects: ConfigProject[];
  defaultProjectId?: string | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (bot: Bot) => void;
  onDeleted: (botId: string) => void;
};

function agentLabel(agent: string): string {
  return getKnownAgent(agent)?.label ?? agent;
}

export function BotEditorDialog({
  open,
  bot,
  projects,
  defaultProjectId = null,
  onOpenChange,
  onSaved,
  onDeleted,
}: BotEditorDialogProps) {
  const [draft, setDraft] = useState<BotDraft>(() => emptyBotDraft());
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(bot ? botToDraft(bot) : emptyBotDraft(defaultProjectId ?? projects[0]?.id ?? ""));
    setError(null);
    setConfirmingDelete(false);
    // Re-seed only when the dialog opens or targets a different bot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bot?.id]);

  const projectOptions = useMemo(() => {
    const ids = projects.map((project) => project.id);
    if (draft.projectId && !ids.includes(draft.projectId)) {
      ids.push(draft.projectId);
    }
    return ids;
  }, [draft.projectId, projects]);

  const suggestedHandle = suggestBotHandle(draft.name);
  const busy = saving || deleting;
  const update = <K extends keyof BotDraft>(key: K, value: BotDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const handleSave = async () => {
    const validationError = validateBotDraft(draft);
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = botDraftToPayload(draft);
      const saved = bot ? await updateBot(bot.id, payload) : await createBot(payload);
      onSaved(saved);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save the bot");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!bot) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteBot(bot.id);
      onDeleted(bot.id);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete the bot");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <Dialog.Portal>
        <Dialog.Overlay className={DISPATCHER_SURFACE_OVERLAY_CLASS_NAME} />
        <Dialog.Content className={DISPATCHER_SURFACE_CONTENT_CLASS_NAME}>
          <div className="border-b border-[var(--vk-border)] px-5 py-4">
            <Dialog.Title className="text-[15px] font-medium text-[var(--vk-text-strong)]">
              {bot ? `Edit ${bot.name}` : "New bot"}
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-[12px] leading-5 text-[var(--vk-text-muted)]">
              A bot is a named teammate with a job and standing instructions. It plans work in one
              project and hands tasks to coding agents on this machine.
            </Dialog.Description>
          </div>

          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSave();
            }}
          >
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
              <div className="flex gap-3">
                <label className="w-[72px] shrink-0">
                  <span className={BOT_FIELD_LABEL_CLASS_NAME}>Emoji</span>
                  <input
                    value={draft.emoji}
                    onChange={(event) => update("emoji", event.target.value)}
                    maxLength={8}
                    disabled={busy}
                    className={`${BOT_FIELD_INPUT_CLASS_NAME} text-center text-[18px]`}
                    aria-label="Bot emoji"
                  />
                </label>
                <label className="min-w-0 flex-1">
                  <span className={BOT_FIELD_LABEL_CLASS_NAME}>Name</span>
                  <input
                    value={draft.name}
                    onChange={(event) => update("name", event.target.value)}
                    placeholder="Release Captain"
                    maxLength={60}
                    disabled={busy}
                    autoFocus={!bot}
                    className={BOT_FIELD_INPUT_CLASS_NAME}
                  />
                </label>
              </div>

              <label className="block">
                <span className={BOT_FIELD_LABEL_CLASS_NAME}>Role</span>
                <input
                  value={draft.role}
                  onChange={(event) => update("role", event.target.value)}
                  placeholder="Triage new issues and keep the release branch green"
                  maxLength={160}
                  disabled={busy}
                  className={BOT_FIELD_INPUT_CLASS_NAME}
                />
              </label>

              <label className="block">
                <span className={BOT_FIELD_LABEL_CLASS_NAME}>Standing instructions</span>
                <textarea
                  value={draft.instructions}
                  onChange={(event) => update("instructions", event.target.value)}
                  placeholder="How this bot should work, what it must always or never do, and when it should ask you first."
                  rows={5}
                  disabled={busy}
                  className={`${BOT_FIELD_INPUT_CLASS_NAME} resize-y leading-5`}
                />
                <p className={BOT_FIELD_HINT_CLASS_NAME}>Applied to every message this bot receives.</p>
              </label>

              <label className="block">
                <span className={BOT_FIELD_LABEL_CLASS_NAME}>Project</span>
                <select
                  value={draft.projectId}
                  onChange={(event) => update("projectId", event.target.value)}
                  disabled={busy || projectOptions.length === 0}
                  className={BOT_FIELD_INPUT_CLASS_NAME}
                >
                  {projectOptions.length === 0 ? <option value="">No projects yet</option> : null}
                  {projectOptions.map((projectId) => (
                    <option key={projectId} value={projectId}>{projectId}</option>
                  ))}
                </select>
                {bot && draft.projectId !== bot.projectId ? (
                  <p className={BOT_FIELD_HINT_CLASS_NAME}>
                    Changing the project starts a fresh conversation in the new project.
                  </p>
                ) : null}
              </label>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className={BOT_FIELD_LABEL_CLASS_NAME}>Planner agent</span>
                  <select
                    value={draft.dispatcherAgent}
                    onChange={(event) => update("dispatcherAgent", event.target.value)}
                    disabled={busy}
                    className={BOT_FIELD_INPUT_CLASS_NAME}
                  >
                    <option value="">Project default</option>
                    {DISPATCHER_RUNTIME_AGENT_OPTIONS.map((agent) => (
                      <option key={agent} value={agent}>{agentLabel(agent)}</option>
                    ))}
                  </select>
                  <p className={BOT_FIELD_HINT_CLASS_NAME}>Runs the bot&apos;s own conversation.</p>
                </label>
                <label className="block">
                  <span className={BOT_FIELD_LABEL_CLASS_NAME}>Handoff agent</span>
                  <select
                    value={draft.implementationAgent}
                    onChange={(event) => update("implementationAgent", event.target.value)}
                    disabled={busy}
                    className={BOT_FIELD_INPUT_CLASS_NAME}
                  >
                    <option value="">Project default</option>
                    {DISPATCHER_HANDOFF_AGENT_OPTIONS.map((agent) => (
                      <option key={agent} value={agent}>{agentLabel(agent)}</option>
                    ))}
                  </select>
                  <p className={BOT_FIELD_HINT_CLASS_NAME}>Does the coding work it hands off.</p>
                </label>
              </div>

              <label className="block">
                <span className={BOT_FIELD_LABEL_CLASS_NAME}>Mention handles</span>
                <input
                  value={draft.handles}
                  onChange={(event) => update("handles", event.target.value)}
                  placeholder={suggestedHandle || "release-captain"}
                  disabled={busy}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className={BOT_FIELD_INPUT_CLASS_NAME}
                />
                <p className={BOT_FIELD_HINT_CLASS_NAME}>
                  Comma-separated. Mentioning <code>@handle</code> in a GitHub comment or Slack message
                  routes it to this bot.
                  {suggestedHandle && parseHandleList(draft.handles).length === 0 ? (
                    <>
                      {" "}
                      <button
                        type="button"
                        onClick={() => update("handles", suggestedHandle)}
                        className="text-[var(--vk-text-normal)] underline underline-offset-2"
                      >
                        Use @{suggestedHandle}
                      </button>
                    </>
                  ) : null}
                </p>
              </label>

              <label className="block">
                <span className={BOT_FIELD_LABEL_CLASS_NAME}>Slack channel IDs</span>
                <input
                  value={draft.slackChannels}
                  onChange={(event) => update("slackChannels", event.target.value)}
                  placeholder="C0123456789"
                  disabled={busy}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className={BOT_FIELD_INPUT_CLASS_NAME}
                />
                <p className={BOT_FIELD_HINT_CLASS_NAME}>
                  Comma-separated. Mentions of the Conductor app in these channels go to this bot.
                </p>
              </label>

              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={draft.isDefault}
                  onChange={(event) => update("isDefault", event.target.checked)}
                  disabled={busy}
                  className="mt-0.5 h-4 w-4 accent-[var(--vk-orange)]"
                />
                <span>
                  <span className="block text-[13px] text-[var(--vk-text-normal)]">Default bot</span>
                  <span className={BOT_FIELD_HINT_CLASS_NAME}>
                    Receives mentions that do not name a specific bot.
                  </span>
                </span>
              </label>

              {error ? <div role="alert" className={BOT_ERROR_BANNER_CLASS_NAME}>{error}</div> : null}
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-[var(--vk-border)] px-5 py-3">
              {bot ? (
                confirmingDelete ? (
                  <>
                    <span className="text-[12px] text-[var(--vk-text-muted)]">Delete this bot?</span>
                    <Button type="button" variant="danger" onClick={() => void handleDelete()} disabled={busy}>
                      {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                      Delete
                    </Button>
                    <Button type="button" variant="ghost" onClick={() => setConfirmingDelete(false)} disabled={busy}>
                      Keep
                    </Button>
                  </>
                ) : (
                  <Button type="button" variant="ghost" onClick={() => setConfirmingDelete(true)} disabled={busy}>
                    <Trash2 className="h-4 w-4" />
                    Delete bot
                  </Button>
                )
              ) : null}
              <div className="ml-auto flex items-center gap-2">
                <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={busy || projectOptions.length === 0}>
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {bot ? "Save changes" : "Create bot"}
                </Button>
              </div>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
