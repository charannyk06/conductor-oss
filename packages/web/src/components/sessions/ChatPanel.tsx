"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ChevronDown,
  Loader2,
  Paperclip,
  SendHorizontal,
  Sparkles,
} from "lucide-react";
import { useAgents } from "@/hooks/useAgents";
import { useSessionFeed } from "@/hooks/useSessionFeed";
import type { NormalizedChatEntry } from "@/lib/chatFeed";

interface ChatPanelProps {
  sessionId: string;
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

function getModelOptions(agents: ReturnType<typeof useAgents>["agents"]): ModelOption[] {
  const options = new Map<string, ModelOption>();

  for (const agent of agents) {
    const catalog = agent.runtimeModelCatalog;
    if (!catalog || typeof catalog !== "object") continue;

    const modelsByAccess = (catalog as { modelsByAccess?: Record<string, Array<Record<string, unknown>>> }).modelsByAccess;
    if (!modelsByAccess || typeof modelsByAccess !== "object") continue;

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

  return [...options.values()].sort((left, right) => left.label.localeCompare(right.label));
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

function entryChrome(entry: NormalizedChatEntry): {
  container: string;
  bubble: string;
  prose: string;
  meta: string;
} {
  switch (entry.kind) {
    case "user":
      return {
        container: "items-end",
        bubble: "max-w-[85%] rounded-[24px] rounded-br-md border border-white/10 bg-white/[0.08] px-5 py-4 text-white shadow-[0_24px_80px_rgba(0,0,0,0.22)] backdrop-blur",
        prose: "prose prose-invert prose-pre:overflow-x-auto prose-code:text-zinc-100 prose-p:text-zinc-100 max-w-none text-[15px] leading-7",
        meta: "text-right text-[11px] uppercase tracking-[0.18em] text-zinc-500",
      };
    case "assistant":
      return {
        container: "items-start",
        bubble: "max-w-[88%] rounded-[28px] rounded-tl-md border border-white/10 bg-[#11131a]/95 px-6 py-5 text-white shadow-[0_36px_90px_rgba(0,0,0,0.3)]",
        prose: "prose prose-invert prose-headings:text-zinc-100 prose-p:text-zinc-200 prose-strong:text-white prose-code:text-zinc-100 prose-pre:overflow-x-auto prose-li:text-zinc-200 max-w-none text-[15px] leading-7",
        meta: "text-left text-[11px] uppercase tracking-[0.18em] text-zinc-500",
      };
    case "system":
      return {
        container: "items-center",
        bubble: "max-w-[92%] rounded-full border border-emerald-500/20 bg-emerald-500/[0.08] px-4 py-2 text-emerald-100",
        prose: "max-w-none text-center text-[12px] leading-6 text-emerald-100",
        meta: "text-center text-[11px] uppercase tracking-[0.18em] text-emerald-400/80",
      };
    default:
      return {
        container: "items-center",
        bubble: "max-w-[92%] rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-zinc-300",
        prose: "max-w-none text-center text-[12px] leading-6 text-zinc-300",
        meta: "text-center text-[11px] uppercase tracking-[0.18em] text-zinc-500",
      };
  }
}

function extractAttachmentPath(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const nested = record.attachment && typeof record.attachment === "object"
    ? record.attachment as Record<string, unknown>
    : null;

  for (const candidate of [
    record.absolutePath,
    record.path,
    record.filePath,
    nested?.absolutePath,
    nested?.path,
    nested?.filePath,
  ]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
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
    const absolutePath = extractAttachmentPath(payload);
    if (!absolutePath) {
      throw new Error(`Attachment response for ${file.name} did not include a file path`);
    }

    return absolutePath;
  }));

  return uploadedPaths.filter(Boolean);
}

function FeedCard({ entry }: { entry: NormalizedChatEntry }) {
  const styles = entryChrome(entry);
  const timestamp = formatTimestamp(entry.createdAt);

  return (
    <div className={`flex w-full flex-col gap-2 ${styles.container}`}>
      <div className={styles.meta}>
        <span>{entry.label}</span>
        {timestamp ? <span className="ml-2 normal-case tracking-normal text-zinc-500">{timestamp}</span> : null}
        {entry.streaming ? <span className="ml-2 normal-case tracking-normal text-zinc-400">live</span> : null}
      </div>
      <div className={styles.bubble}>
        {entry.kind === "assistant" || entry.kind === "user" ? (
          <ReactMarkdown
            className={styles.prose}
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ ...props }) => <a {...props} target="_blank" rel="noreferrer" className="text-sky-300 underline" />,
            }}
          >
            {entry.text}
          </ReactMarkdown>
        ) : (
          <p className={styles.prose}>{entry.text}</p>
        )}
        {entry.attachments.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {entry.attachments.map((attachment) => (
              <span
                key={attachment}
                className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[11px] text-zinc-300"
              >
                {attachment.split("/").pop()}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ChatPanel({
  sessionId,
  projectId,
  sessionModel,
  sessionReasoningEffort,
}: ChatPanelProps) {
  const { agents } = useAgents();
  const { entries, error, loading, refresh } = useSessionFeed(sessionId);
  const modelOptions = useMemo(() => getModelOptions(agents), [agents]);

  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState(sessionModel?.trim() || "");
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);

  const endRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setSelectedModel(sessionModel?.trim() || "");
  }, [sessionModel]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [entries, sending]);

  const selectedModelLabel = useMemo(() => {
    if (!selectedModel) return "Model";
    return modelOptions.find((option) => option.id === selectedModel)?.label ?? selectedModel;
  }, [modelOptions, selectedModel]);

  async function handleSend() {
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

      if (!response.ok) {
        throw new Error(`Failed to send message: ${response.status}`);
      }

      setMessage("");
      setAttachments([]);
      await refresh();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  }

  function handleAttachmentChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;

    setAttachments((current) => {
      const next = [
        ...current,
        ...files.map((file) => ({ file })),
      ];
      return next;
    });

    event.target.value = "";
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[radial-gradient(circle_at_top,_rgba(72,114,255,0.14),_transparent_34%),linear-gradient(180deg,_#0f1015_0%,_#090a0d_100%)] text-white">
      <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col px-4 pb-6 pt-5 sm:px-6 lg:px-8">
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 pb-6 pt-4">
            {loading && entries.length === 0 ? (
              <div className="flex items-center justify-center gap-3 rounded-full border border-white/10 bg-white/[0.04] px-5 py-3 text-sm text-zinc-300">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Loading session conversation</span>
              </div>
            ) : null}

            {!loading && entries.length === 0 ? (
              <div className="rounded-[32px] border border-white/10 bg-white/[0.03] px-7 py-8 text-center text-zinc-300 shadow-[0_36px_100px_rgba(0,0,0,0.24)]">
                <p className="text-sm uppercase tracking-[0.28em] text-zinc-500">Chat</p>
                <h2 className="mt-3 font-mono text-2xl text-white">Session feed is ready</h2>
                <p className="mt-3 text-sm leading-7 text-zinc-400">
                  Send a follow-up to create the next execution turn. The panel now reads a normalized conversation feed instead of a raw terminal transcript.
                </p>
              </div>
            ) : null}

            {entries.map((entry) => <FeedCard key={entry.id} entry={entry} />)}

            {error ? (
              <div className="rounded-full border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-center text-sm text-rose-100">
                {error}
              </div>
            ) : null}

            {sendError ? (
              <div className="rounded-full border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-center text-sm text-rose-100">
                {sendError}
              </div>
            ) : null}

            <div ref={endRef} />
          </div>
        </div>

        <div className="mx-auto mt-4 w-full max-w-4xl">
          {attachments.length > 0 ? (
            <div className="mb-3 flex flex-wrap gap-2">
              {attachments.map((attachment, index) => (
                <button
                  key={`${attachment.file.name}-${index}`}
                  type="button"
                  onClick={() => {
                    setAttachments((current) => {
                      const next = [...current];
                      next.splice(index, 1);
                      return next;
                    });
                  }}
                  className="rounded-full border border-white/10 bg-white/[0.05] px-3 py-1 text-xs text-zinc-300 transition hover:bg-white/[0.08]"
                >
                  {attachment.file.name}
                </button>
              ))}
            </div>
          ) : null}

          <div className="relative overflow-hidden rounded-[30px] border border-white/10 bg-[#0f1118]/95 shadow-[0_34px_90px_rgba(0,0,0,0.35)]">
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder="Send a follow-up"
              rows={3}
              className="min-h-[120px] w-full resize-none bg-transparent px-5 py-5 text-[15px] leading-7 text-white outline-none placeholder:text-zinc-500"
            />

            <div className="flex items-center justify-between border-t border-white/10 px-4 py-3">
              <div className="flex items-center gap-2">
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
                  className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-zinc-300 transition hover:bg-white/[0.08] hover:text-white"
                  aria-label="Add attachment"
                >
                  <Paperclip className="h-4 w-4" />
                </button>

                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setModelMenuOpen((open) => !open)}
                    className="inline-flex h-10 items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 text-sm text-zinc-200 transition hover:bg-white/[0.08] hover:text-white"
                  >
                    <Sparkles className="h-4 w-4" />
                    <span className="max-w-[180px] truncate">{selectedModelLabel}</span>
                    <ChevronDown className="h-4 w-4" />
                  </button>

                  {modelMenuOpen ? (
                    <div className="absolute bottom-[calc(100%+12px)] left-0 z-20 max-h-80 w-72 overflow-y-auto rounded-3xl border border-white/10 bg-[#0f1118] p-2 shadow-[0_30px_80px_rgba(0,0,0,0.45)]">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedModel(sessionModel?.trim() || "");
                          setModelMenuOpen(false);
                        }}
                        className="flex w-full flex-col rounded-2xl px-4 py-3 text-left transition hover:bg-white/[0.05]"
                      >
                        <span className="text-sm text-white">Session default</span>
                        <span className="mt-1 text-xs text-zinc-400">Keep using the model configured on the current session.</span>
                      </button>

                      {modelOptions.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          onClick={() => {
                            setSelectedModel(option.id);
                            setModelMenuOpen(false);
                          }}
                          className={`flex w-full flex-col rounded-2xl px-4 py-3 text-left transition hover:bg-white/[0.05] ${selectedModel === option.id ? "bg-white/[0.06]" : ""}`}
                        >
                          <span className="text-sm text-white">{option.label}</span>
                          <span className="mt-1 text-xs text-zinc-400">{option.helper}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>

              <button
                type="button"
                onClick={() => void handleSend()}
                disabled={sending || (!message.trim() && attachments.length === 0)}
                className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-white text-[#0d0f15] transition hover:scale-[1.02] disabled:cursor-not-allowed disabled:bg-white/20 disabled:text-zinc-500"
                aria-label="Send message"
              >
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <SendHorizontal className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ChatPanel;
