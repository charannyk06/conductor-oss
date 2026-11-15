"use client";

import Link from "next/link";
import { ArrowRight, Inbox } from "lucide-react";
import {
  describeRelativeTime,
  groupInboxItems,
  inboxKindActionLabel,
  resolveInboxItemHref,
  type InboxItem,
} from "@/lib/bots";

type BotInboxPanelProps = {
  items: InboxItem[];
  loading: boolean;
};

export function BotInboxPanel({ items, loading }: BotInboxPanelProps) {
  const groups = groupInboxItems(items);

  if (groups.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="max-w-[360px] text-center">
          <Inbox className="mx-auto h-6 w-6 text-[var(--vk-text-muted)]" />
          <p className="mt-3 text-[14px] font-medium text-[var(--vk-text-normal)]">
            {loading ? "Loading inbox…" : "Nothing needs you right now"}
          </p>
          {loading ? null : (
            <p className="mt-1 text-[12px] leading-5 text-[var(--vk-text-muted)]">
              Plans waiting for approval, questions from agents, failures and finished work show up here.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[760px] space-y-6 px-4 py-5 sm:px-6">
        {groups.map((group) => (
          <section key={group.kind} aria-label={group.label}>
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--vk-text-muted)]">
              {group.label} · {group.items.length}
            </h2>
            <ul className="mt-2 space-y-2">
              {group.items.map((item) => (
                <li key={item.id}>
                  <Link
                    href={resolveInboxItemHref(item)}
                    className="group flex items-start gap-3 rounded-[10px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-3 py-3 transition-colors hover:bg-[var(--vk-bg-hover)]"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium text-[var(--vk-text-normal)]">
                        {item.title}
                      </p>
                      {item.summary ? (
                        <p className="mt-0.5 line-clamp-2 text-[12px] leading-5 text-[var(--vk-text-muted)]">
                          {item.summary}
                        </p>
                      ) : null}
                      <p className="mt-1 truncate text-[11px] text-[var(--vk-text-muted)]">
                        {[item.botName, item.projectId, describeRelativeTime(item.updatedAt)]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </div>
                    <span className="inline-flex h-8 shrink-0 items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--vk-border)] bg-[var(--vk-bg-active)] px-2.5 text-[12px] font-medium text-[var(--vk-text-normal)]">
                      {inboxKindActionLabel(item.kind)}
                      <ArrowRight className="h-3.5 w-3.5" />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
