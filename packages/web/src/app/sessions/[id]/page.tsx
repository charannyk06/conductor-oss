"use client";

import { useParams } from "next/navigation";
import { SessionDetail } from "@/components/sessions/SessionDetail";

export default function SessionPage() {
  const params = useParams<{ id: string }>();

  if (!params.id) {
    return (
      <div className="flex h-screen items-center justify-center">
        <span className="text-[13px] text-[var(--color-text-muted)]">No session ID provided</span>
      </div>
    );
  }

  return (
    <div className="h-screen bg-[var(--color-bg-base)]">
      <SessionDetail sessionId={params.id} />
    </div>
  );
}
