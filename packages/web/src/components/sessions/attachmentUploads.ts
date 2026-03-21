"use client";

import { withBridgeQuery } from "@/lib/bridgeQuery";

type UploadAttachmentsResponse = {
  files?: unknown;
  error?: string;
  path?: unknown;
  absolutePath?: unknown;
  filePath?: unknown;
  attachment?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function firstNonEmptyString(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function extractAttachmentPath(entry: unknown, preferAbsolute: boolean): string | null {
  const record = asRecord(entry);
  if (!record) {
    return null;
  }

  const nested = asRecord(record.attachment);
  const candidates = preferAbsolute
    ? [
        record.absolutePath,
        record.path,
        record.filePath,
        nested?.absolutePath,
        nested?.path,
        nested?.filePath,
      ]
    : [
        record.path,
        record.absolutePath,
        record.filePath,
        nested?.path,
        nested?.absolutePath,
        nested?.filePath,
      ];

  return firstNonEmptyString(candidates);
}

export function extractLocalFileTransferPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const lines = trimmed
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) {
    return null;
  }

  const candidate = lines[0].replace(/^['"]|['"]$/g, "");
  if (!candidate) {
    return null;
  }

  if (candidate.startsWith("file://")) {
    try {
      const url = new URL(candidate);
      if (url.protocol !== "file:") {
        return null;
      }
      let pathname = decodeURIComponent(url.pathname);
      if (/^\/[A-Za-z]:\//.test(pathname)) {
        pathname = pathname.slice(1);
      }
      return pathname || null;
    } catch {
      return null;
    }
  }

  const isAbsolutePath = candidate.startsWith("/") || /^[A-Za-z]:[\\/]/.test(candidate);
  if (!isAbsolutePath) {
    return null;
  }

  const lastSegment = candidate.split(/[\\/]/).filter(Boolean).pop() ?? "";
  if (!/\.[A-Za-z0-9]{1,10}$/.test(lastSegment)) {
    return null;
  }

  return candidate;
}

export async function uploadProjectAttachments({
  files,
  projectId,
  taskRef,
  bridgeId,
  preferAbsolute = true,
}: {
  files: File[];
  projectId: string;
  taskRef?: string | null;
  bridgeId?: string | null;
  preferAbsolute?: boolean;
}): Promise<string[]> {
  if (!files.length) {
    return [];
  }

  const trimmedProjectId = projectId.trim();
  if (!trimmedProjectId) {
    throw new Error("Project id is required to upload attachments");
  }

  const formData = new FormData();
  formData.append("projectId", trimmedProjectId);

  const trimmedTaskRef = taskRef?.trim();
  if (trimmedTaskRef) {
    formData.append("taskRef", trimmedTaskRef);
  }

  for (const file of files) {
    formData.append("files", file);
  }

  const response = await fetch(withBridgeQuery("/api/attachments", bridgeId), {
    method: "POST",
    body: formData,
  });

  const payload = (await response.json().catch(() => null)) as UploadAttachmentsResponse | null;
  if (!response.ok) {
    const fallbackName = files.length === 1 ? files[0]?.name ?? "attachment" : `${files.length} attachments`;
    throw new Error(payload?.error ?? `Failed to upload ${fallbackName}`);
  }

  const fileEntries = Array.isArray(payload?.files)
    ? payload.files
    : payload
      ? [payload]
      : [];
  const uploadedPaths = fileEntries
    .map((entry) => extractAttachmentPath(entry, preferAbsolute))
    .filter((value): value is string => Boolean(value));

  if (uploadedPaths.length === 0) {
    throw new Error("Attachment upload succeeded but did not return a usable file path");
  }

  return uploadedPaths;
}
