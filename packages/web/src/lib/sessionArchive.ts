"use client";

import { withBridgeQuery } from "@/lib/bridgeQuery";
import { optimisticallyArchiveSession } from "@/lib/sessionState";

async function requestSessionArchive(
  sessionId: string,
  bridgeId?: string | null,
): Promise<void> {
  let response = await fetch(
    withBridgeQuery(`/api/sessions/${encodeURIComponent(sessionId)}/archive`, bridgeId),
    { method: "POST" },
  );
  let payload = (await response.json().catch(() => null)) as
    | { ok?: boolean; error?: string }
    | null;

  if (response.status === 404) {
    response = await fetch(
      withBridgeQuery(`/api/sessions/${encodeURIComponent(sessionId)}/actions`, bridgeId),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "archive" }),
      },
    );
    payload = (await response.json().catch(() => null)) as
      | { ok?: boolean; error?: string }
      | null;
  }

  if (!response.ok) {
    throw new Error(payload?.error ?? `Failed to archive session: ${response.status}`);
  }
}

export async function archiveSession(
  sessionId: string,
  options?: { bridgeId?: string | null },
): Promise<void> {
  const rollback = optimisticallyArchiveSession(sessionId, options);
  try {
    await requestSessionArchive(sessionId, options?.bridgeId);
  } catch (error) {
    rollback();
    throw error;
  }
}
