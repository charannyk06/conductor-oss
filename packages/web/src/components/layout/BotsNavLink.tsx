"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Bot } from "lucide-react";
import { fetchInbox } from "@/lib/botsApi";

const INBOX_COUNT_POLL_INTERVAL_MS = 30_000;

/** Top-bar entry point to the bots home, with a badge for items waiting on the user. */
export function BotsNavLink() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const items = await fetchInbox();
        if (!cancelled) setCount(items.length);
      } catch {
        // The badge is best-effort; the link still works without it.
      }
    };
    void load();
    const intervalId = window.setInterval(() => void load(), INBOX_COUNT_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  const label = count > 0 ? `Bots, ${count} waiting on you` : "Bots";

  return (
    <Link
      href={count > 0 ? "/bots?view=inbox" : "/bots"}
      className="oc-mobile-touch-target relative inline-flex h-11 shrink-0 items-center gap-1.5 rounded-[4px] px-2 text-[12px] font-medium text-[var(--vk-text-muted)] hover:bg-[var(--vk-bg-hover)] hover:text-[var(--vk-text-normal)] sm:h-8"
      aria-label={label}
      title={label}
    >
      <Bot className="h-4 w-4" />
      <span className="hidden sm:inline">Bots</span>
      {count > 0 ? (
        <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--vk-orange)] px-1 text-[10px] font-semibold leading-none text-white">
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </Link>
  );
}
