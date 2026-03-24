import { withBridgeQuery } from "@/lib/bridgeQuery";

export interface UploadClipboardImageOptions {
  imageBlob: Blob;
  projectId: string;
  taskRef?: string;
  bridgeId?: string | null;
  fileName?: string;
}

export interface UploadClipboardImageResult {
  path: string;
  absolutePath: string;
}

export async function uploadClipboardImage(
  options: UploadClipboardImageOptions,
): Promise<UploadClipboardImageResult> {
  const { imageBlob, projectId, taskRef, bridgeId, fileName } = options;

  const formData = new FormData();
  formData.append("projectId", projectId);
  if (taskRef) {
    formData.append("taskRef", taskRef);
  }
  const finalFileName = fileName ?? `clipboard-${Date.now()}.png`;
  formData.append("files", imageBlob, finalFileName);

  const response = await fetch(withBridgeQuery("/api/attachments", bridgeId), {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Failed to upload image (${response.status})`);
  }

  const data = (await response.json()) as {
    files?: Array<{
      path?: string;
      absolutePath?: string;
    }>;
    path?: string;
    absolutePath?: string;
  };

  const fileEntry = Array.isArray(data.files) && data.files.length > 0
    ? data.files[0]
    : data;

  const path = fileEntry?.path ?? data.path;
  const absolutePath = fileEntry?.absolutePath ?? data.absolutePath;

  if (!path && !absolutePath) {
    throw new Error("Image upload succeeded but did not return a usable file path");
  }

  return {
    path: path ?? absolutePath ?? "",
    absolutePath: absolutePath ?? path ?? "",
  };
}

function collectFilesFromTransferItems(transferItems?: DataTransferItemList | null): File[] {
  if (!transferItems) {
    return [];
  }

  const files: File[] = [];
  for (const item of Array.from(transferItems)) {
    if (item.kind !== "file") {
      continue;
    }
    const file = item.getAsFile();
    if (file) {
      files.push(file);
    }
  }

  return files;
}

export function extractFilesFromTransfer(
  transfer?: DataTransfer | null,
): File[] {
  const directFiles = transfer?.files;
  if (directFiles && directFiles.length > 0) {
    return Array.from(directFiles);
  }

  return collectFilesFromTransferItems(transfer?.items ?? null);
}

export function extractImageFromClipboard(
  clipboardData?: DataTransfer | null,
): Blob | null {
  if (clipboardData?.items) {
    for (const item of Array.from(clipboardData.items)) {
      if (item.kind !== "file" || !item.type.startsWith("image/")) {
        continue;
      }
      const file = item.getAsFile();
      if (file) {
        return file;
      }
    }
  }

  const files = extractFilesFromTransfer(clipboardData);
  for (const file of files) {
    if (file.type.startsWith("image/")) {
      return file;
    }
  }

  return null;
}
