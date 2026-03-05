"use client";

import { useParams } from "next/navigation";
import { SessionDetail } from "@/components/sessions/SessionDetail";

export default function SessionPage() {
  const params = useParams<{ id: string }>();

  if (!params.id) {
    return (
      <div className="flex h-dvh min-h-[100dvh] items-center justify-center">
        <span className="text-[13px] text-[var(--text-muted)]">No session ID provided</span>
      </div>
    );
  }

  return (
    <div className="h-dvh min-h-[100dvh] bg-[var(--bg-canvas)] p-2 sm:p-3">
      <SessionDetail sessionId={params.id} />
    </div>
  );
}
