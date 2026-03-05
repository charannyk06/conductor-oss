import { type NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import type { OrchestratorConfig } from "@conductor-oss/core";
import { guardApiAccess, guardApiActionAccess } from "@/lib/auth";
import { getServices } from "@/lib/services";

export const dynamic = "force-dynamic";

const MAX_UPLOAD_FILES = 20;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB per file

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".tiff",
]);

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function expandHome(value: string): string {
  if (value.startsWith("~/")) {
    return resolve(homedir(), value.slice(2));
  }
  return resolve(value);
}

function resolveWorkspacePath(config: OrchestratorConfig): string {
  if (process.env["CONDUCTOR_WORKSPACE"]?.trim()) {
    return expandHome(process.env["CONDUCTOR_WORKSPACE"]);
  }
  if (config.configPath) {
    return dirname(config.configPath);
  }
  return resolve(process.cwd());
}

function normalizeToken(value: string): string {
  const input = value.trim().toLowerCase();
  let out = "";
  let prevDash = false;
  for (const ch of input) {
    const code = ch.charCodeAt(0);
    const isDigit = code >= 48 && code <= 57;
    const isLowerAlpha = code >= 97 && code <= 122;
    const isSafe = isDigit || isLowerAlpha || ch === "." || ch === "_";
    if (isSafe) {
      out += ch;
      prevDash = false;
      continue;
    }
    if (!prevDash && out.length > 0) {
      out += "-";
      prevDash = true;
    }
  }
  while (out.endsWith("-")) out = out.slice(0, -1);
  return out || "project";
}

function sanitizeFileName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "upload.bin";
  const normalized = trimmed
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .pop() ?? "upload.bin";
  const safe = normalized
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^\.+/, "")
    .replace(/^-+/, "");
  return safe || "upload.bin";
}

function isImagePath(path: string): boolean {
  const lower = path.toLowerCase();
  for (const ext of IMAGE_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

export async function POST(request: NextRequest) {
  const denied = await guardApiAccess();
  if (denied) return denied;
  const deniedAction = guardApiActionAccess(request);
  if (deniedAction) return deniedAction;

  try {
    const form = await request.formData();
    const projectId = asNonEmptyString(form.get("projectId"));
    if (!projectId) {
      return NextResponse.json({ error: "projectId is required" }, { status: 400 });
    }

    const incoming = form.getAll("files").filter((item): item is File => item instanceof File);
    if (incoming.length === 0) {
      return NextResponse.json({ error: "No files uploaded" }, { status: 400 });
    }
    if (incoming.length > MAX_UPLOAD_FILES) {
      return NextResponse.json(
        { error: `Too many files. Max ${MAX_UPLOAD_FILES} files per request.` },
        { status: 400 },
      );
    }

    const { config } = await getServices();
    if (!config.projects[projectId]) {
      return NextResponse.json({ error: `Unknown project: ${projectId}` }, { status: 404 });
    }

    const workspaceRoot = resolveWorkspacePath(config);
    const projectSegment = normalizeToken(projectId);
    const targetDir = resolve(workspaceRoot, "attachments", projectSegment);
    const workspacePrefix = workspaceRoot.endsWith(sep) ? workspaceRoot : `${workspaceRoot}${sep}`;
    if (targetDir !== workspaceRoot && !targetDir.startsWith(workspacePrefix)) {
      return NextResponse.json({ error: "Upload path escapes workspace" }, { status: 400 });
    }
    await mkdir(targetDir, { recursive: true });

    const uploaded: Array<{
      path: string;
      name: string;
      size: number;
      mimeType: string | null;
      kind: "image" | "file";
    }> = [];

    for (const [index, file] of incoming.entries()) {
      if (file.size > MAX_UPLOAD_BYTES) {
        return NextResponse.json(
          { error: `File "${file.name}" exceeds 25MB limit.` },
          { status: 413 },
        );
      }
      const safeName = sanitizeFileName(file.name);
      const uniquePrefix = `${Date.now()}-${index}-${randomBytes(3).toString("hex")}`;
      const fileName = `${uniquePrefix}-${safeName}`;
      const absolutePath = resolve(targetDir, fileName);
      if (absolutePath !== workspaceRoot && !absolutePath.startsWith(workspacePrefix)) {
        return NextResponse.json({ error: "Resolved upload path escapes workspace" }, { status: 400 });
      }

      const bytes = Buffer.from(await file.arrayBuffer());
      await writeFile(absolutePath, bytes);
      const relPath = relative(workspaceRoot, absolutePath).replaceAll("\\", "/");
      uploaded.push({
        path: relPath,
        name: file.name || safeName,
        size: file.size,
        mimeType: file.type || null,
        kind: isImagePath(relPath) ? "image" : "file",
      });
    }

    return NextResponse.json({ files: uploaded }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to upload files" },
      { status: 500 },
    );
  }
}
