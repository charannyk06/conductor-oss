"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import { CalendarClock, Loader2, PencilLine, Play, Plus, Trash2 } from "lucide-react";
import {
  DISPATCHER_SURFACE_CONTENT_CLASS_NAME,
  DISPATCHER_SURFACE_OVERLAY_CLASS_NAME,
} from "@/components/dispatcher/dispatcherMobileLayout";
import { Button } from "@/components/ui/Button";
import {
  describeCadence,
  describeScheduleLastRun,
  describeScheduleNextRun,
  emptyScheduleDraft,
  scheduleDraftToCadence,
  scheduleDraftToPayload,
  scheduleToDraft,
  validateScheduleDraft,
  WEEKDAY_SHORT_LABELS,
  type Bot,
  type BotSchedule,
  type ScheduleDraft,
} from "@/lib/bots";
import {
  createBotSchedule,
  deleteBotSchedule,
  runBotScheduleNow,
  updateBotSchedule,
} from "@/lib/botsApi";
import { cn } from "@/lib/cn";
import {
  BOT_ERROR_BANNER_CLASS_NAME,
  BOT_FIELD_INPUT_CLASS_NAME,
  BOT_FIELD_LABEL_CLASS_NAME,
} from "./botFormStyles";

type BotSchedulesDialogProps = {
  open: boolean;
  bot: Bot | null;
  onOpenChange: (open: boolean) => void;
  onBotUpdated: (bot: Bot) => void;
};

/** "new" while adding, a schedule id while editing, null when showing the list. */
type EditorTarget = "new" | string | null;

const CADENCE_KIND_OPTIONS: Array<{ value: ScheduleDraft["kind"]; label: string }> = [
  { value: "interval", label: "Every…" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];

export function BotSchedulesDialog({ open, bot, onOpenChange, onBotUpdated }: BotSchedulesDialogProps) {
  const [editorTarget, setEditorTarget] = useState<EditorTarget>(null);
  const [draft, setDraft] = useState<ScheduleDraft>(() => emptyScheduleDraft());
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setEditorTarget(null);
      setError(null);
      setNotice(null);
    }
  }, [open, bot?.id]);

  if (!bot) {
    return null;
  }

  const schedules = bot.schedules;
  const updateDraft = <K extends keyof ScheduleDraft>(key: K, value: ScheduleDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const openEditor = (schedule: BotSchedule | null) => {
    setDraft(schedule ? scheduleToDraft(schedule) : emptyScheduleDraft());
    setEditorTarget(schedule ? schedule.id : "new");
    setError(null);
    setNotice(null);
  };

  const runAction = async (scheduleId: string, action: () => Promise<Bot>, successNotice?: string) => {
    setPendingId(scheduleId);
    setError(null);
    setNotice(null);
    try {
      onBotUpdated(await action());
      if (successNotice) setNotice(successNotice);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The routine could not be updated");
    } finally {
      setPendingId(null);
    }
  };

  const handleSave = async () => {
    const validationError = validateScheduleDraft(draft);
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = scheduleDraftToPayload(draft);
      const updated = editorTarget && editorTarget !== "new"
        ? await updateBotSchedule(bot.id, editorTarget, payload)
        : await createBotSchedule(bot.id, payload);
      onBotUpdated(updated);
      setEditorTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save the routine");
    } finally {
      setSaving(false);
    }
  };

  const toggleDay = (day: number) => {
    setDraft((current) => ({
      ...current,
      days: current.days.includes(day)
        ? current.days.filter((value) => value !== day)
        : [...current.days, day].sort((left, right) => left - right),
    }));
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next); }}>
      <Dialog.Portal>
        <Dialog.Overlay className={DISPATCHER_SURFACE_OVERLAY_CLASS_NAME} />
        <Dialog.Content className={DISPATCHER_SURFACE_CONTENT_CLASS_NAME}>
          <div className="border-b border-[var(--vk-border)] px-5 py-4">
            <Dialog.Title className="text-[15px] font-medium text-[var(--vk-text-strong)]">
              {bot.emoji} {bot.name} · Routines
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-[12px] leading-5 text-[var(--vk-text-muted)]">
              Routines message this bot on a schedule. They run while Conductor is running on this
              machine, in your local time zone.
            </Dialog.Description>
          </div>

          {editorTarget ? (
            <form
              className="flex min-h-0 flex-1 flex-col"
              onSubmit={(event) => {
                event.preventDefault();
                void handleSave();
              }}
            >
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
                <label className="block">
                  <span className={BOT_FIELD_LABEL_CLASS_NAME}>Title</span>
                  <input
                    value={draft.title}
                    onChange={(event) => updateDraft("title", event.target.value)}
                    placeholder="Morning issue triage"
                    maxLength={80}
                    disabled={saving}
                    autoFocus
                    className={BOT_FIELD_INPUT_CLASS_NAME}
                  />
                </label>
                <label className="block">
                  <span className={BOT_FIELD_LABEL_CLASS_NAME}>What should the bot do?</span>
                  <textarea
                    value={draft.prompt}
                    onChange={(event) => updateDraft("prompt", event.target.value)}
                    placeholder="Review issues opened since the last run, label them, and create tasks for anything actionable."
                    rows={4}
                    disabled={saving}
                    className={`${BOT_FIELD_INPUT_CLASS_NAME} resize-y leading-5`}
                  />
                </label>

                <div>
                  <span className={BOT_FIELD_LABEL_CLASS_NAME}>Repeats</span>
                  <div className="mt-1.5 inline-flex rounded-[8px] border border-[var(--vk-border)] p-0.5" role="radiogroup" aria-label="Repeat cadence">
                    {CADENCE_KIND_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={draft.kind === option.value}
                        onClick={() => updateDraft("kind", option.value)}
                        disabled={saving}
                        className={cn(
                          "rounded-[6px] px-3 py-1.5 text-[12px] font-medium transition-colors",
                          draft.kind === option.value
                            ? "bg-[var(--vk-bg-active)] text-[var(--vk-text-normal)]"
                            : "text-[var(--vk-text-muted)] hover:text-[var(--vk-text-normal)]",
                        )}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>

                  {draft.kind === "interval" ? (
                    <div className="mt-3 flex items-center gap-2">
                      <input
                        type="number"
                        min={1}
                        max={draft.intervalUnit === "hours" ? 168 : 1440}
                        value={Number.isFinite(draft.intervalAmount) ? draft.intervalAmount : ""}
                        onChange={(event) => updateDraft("intervalAmount", event.target.valueAsNumber)}
                        disabled={saving}
                        aria-label="Interval amount"
                        className={`${BOT_FIELD_INPUT_CLASS_NAME} mt-0 w-24`}
                      />
                      <select
                        value={draft.intervalUnit}
                        onChange={(event) => updateDraft("intervalUnit", event.target.value === "minutes" ? "minutes" : "hours")}
                        disabled={saving}
                        aria-label="Interval unit"
                        className={`${BOT_FIELD_INPUT_CLASS_NAME} mt-0 w-32`}
                      >
                        <option value="minutes">minutes</option>
                        <option value="hours">hours</option>
                      </select>
                    </div>
                  ) : (
                    <div className="mt-3 space-y-3">
                      {draft.kind === "weekly" ? (
                        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days of the week">
                          {WEEKDAY_SHORT_LABELS.map((label, day) => {
                            const selected = draft.days.includes(day);
                            return (
                              <button
                                key={label}
                                type="button"
                                aria-pressed={selected}
                                onClick={() => toggleDay(day)}
                                disabled={saving}
                                className={cn(
                                  "h-9 min-w-11 rounded-[8px] border px-2 text-[12px] font-medium transition-colors",
                                  selected
                                    ? "border-[var(--vk-orange)] bg-[color:color-mix(in_srgb,var(--vk-orange)_22%,transparent)] text-[var(--vk-text-normal)]"
                                    : "border-[var(--vk-border)] text-[var(--vk-text-muted)] hover:text-[var(--vk-text-normal)]",
                                )}
                              >
                                {label}
                              </button>
                            );
                          })}
                        </div>
                      ) : null}
                      <label className="flex items-center gap-2 text-[13px] text-[var(--vk-text-normal)]">
                        at
                        <input
                          type="time"
                          value={draft.time}
                          onChange={(event) => updateDraft("time", event.target.value)}
                          disabled={saving}
                          aria-label="Time of day"
                          className={`${BOT_FIELD_INPUT_CLASS_NAME} mt-0 w-36`}
                        />
                      </label>
                    </div>
                  )}
                  <p className="mt-2 text-[12px] text-[var(--vk-text-muted)]">
                    {describeCadence(scheduleDraftToCadence(draft))}
                  </p>
                </div>

                <label className="flex items-center gap-3 text-[13px] text-[var(--vk-text-normal)]">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(event) => updateDraft("enabled", event.target.checked)}
                    disabled={saving}
                    className="h-4 w-4 accent-[var(--vk-orange)]"
                  />
                  Enabled
                </label>

                {error ? <div role="alert" className={BOT_ERROR_BANNER_CLASS_NAME}>{error}</div> : null}
              </div>
              <div className="flex items-center justify-end gap-2 border-t border-[var(--vk-border)] px-5 py-3">
                <Button type="button" variant="ghost" onClick={() => { setEditorTarget(null); setError(null); }} disabled={saving}>
                  Back
                </Button>
                <Button type="submit" variant="primary" disabled={saving}>
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {editorTarget === "new" ? "Add routine" : "Save routine"}
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-5 py-4">
                {schedules.length === 0 ? (
                  <div className="rounded-[10px] border border-dashed border-[var(--vk-border)] px-4 py-6 text-center">
                    <CalendarClock className="mx-auto h-5 w-5 text-[var(--vk-text-muted)]" />
                    <p className="mt-2 text-[13px] text-[var(--vk-text-normal)]">No routines yet</p>
                    <p className="mt-1 text-[12px] leading-5 text-[var(--vk-text-muted)]">
                      Have {bot.name} check in on its own, for example triaging new issues every morning.
                    </p>
                  </div>
                ) : null}
                {schedules.map((schedule) => {
                  const pending = pendingId === schedule.id;
                  return (
                    <div
                      key={schedule.id}
                      className="rounded-[10px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 py-3"
                    >
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-medium text-[var(--vk-text-normal)]">
                            {schedule.title || "Untitled routine"}
                          </p>
                          <p className="mt-0.5 text-[12px] text-[var(--vk-text-muted)]">
                            {describeCadence(schedule.cadence)} · {describeScheduleNextRun(schedule)}
                          </p>
                          <p
                            className={cn(
                              "mt-0.5 break-words text-[12px]",
                              schedule.lastStatus === "error"
                                ? "text-[var(--vk-red)]"
                                : "text-[var(--vk-text-muted)]",
                            )}
                          >
                            {describeScheduleLastRun(schedule)}
                          </p>
                        </div>
                        <label className="flex shrink-0 items-center gap-2 text-[12px] text-[var(--vk-text-muted)]">
                          <input
                            type="checkbox"
                            checked={schedule.enabled}
                            disabled={pending}
                            onChange={(event) =>
                              void runAction(schedule.id, () =>
                                updateBotSchedule(bot.id, schedule.id, { enabled: event.target.checked }))}
                            className="h-4 w-4 accent-[var(--vk-orange)]"
                            aria-label={`${schedule.enabled ? "Pause" : "Enable"} ${schedule.title}`}
                          />
                          On
                        </label>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <Button
                          type="button"
                          size="sm"
                          disabled={pending}
                          onClick={() =>
                            void runAction(
                              schedule.id,
                              () => runBotScheduleNow(bot.id, schedule.id),
                              `Sent "${schedule.title}" to ${bot.name}.`,
                            )}
                        >
                          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                          Run now
                        </Button>
                        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => openEditor(schedule)}>
                          <PencilLine className="h-3.5 w-3.5" />
                          Edit
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={pending}
                          onClick={() => void runAction(schedule.id, () => deleteBotSchedule(bot.id, schedule.id))}
                          aria-label={`Delete ${schedule.title}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Delete
                        </Button>
                      </div>
                    </div>
                  );
                })}
                {notice ? (
                  <p role="status" className="text-[12px] text-[var(--vk-text-muted)]">{notice}</p>
                ) : null}
                {error ? <div role="alert" className={BOT_ERROR_BANNER_CLASS_NAME}>{error}</div> : null}
              </div>
              <div className="flex items-center justify-between gap-2 border-t border-[var(--vk-border)] px-5 py-3">
                <Button type="button" variant="primary" onClick={() => openEditor(null)}>
                  <Plus className="h-4 w-4" />
                  Add routine
                </Button>
                <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                  Done
                </Button>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
