export type RemoteEditorId = "vscode" | "vscode-insiders";

const REMOTE_EDITOR_LABELS: Record<RemoteEditorId, string> = {
  vscode: "VS Code",
  "vscode-insiders": "VS Code Insiders",
};

function normalizeWorkspacePath(workspacePath: string): string {
  if (!workspacePath.startsWith("/")) {
    return `/${workspacePath}`;
  }
  return workspacePath;
}

export function supportsRemoteEditor(editorId: string | null | undefined): editorId is RemoteEditorId {
  return editorId === "vscode" || editorId === "vscode-insiders";
}

export function getRemoteEditorLabel(editorId: RemoteEditorId): string {
  return REMOTE_EDITOR_LABELS[editorId];
}

export function formatRemoteAuthority(host: string, user?: string | null): string {
  const trimmedHost = host.trim();
  const trimmedUser = user?.trim();
  if (!trimmedHost) return "";
  return trimmedUser ? `${trimmedUser}@${trimmedHost}` : trimmedHost;
}

export function buildRemoteEditorUrl({
  editorId,
  workspacePath,
  remoteSshHost,
  remoteSshUser,
}: {
  editorId: string | null | undefined;
  workspacePath: string | null | undefined;
  remoteSshHost: string | null | undefined;
  remoteSshUser?: string | null | undefined;
}): string | null {
  if (!supportsRemoteEditor(editorId)) return null;
  const host = remoteSshHost?.trim();
  const path = workspacePath?.trim();
  if (!host || !path) return null;

  const authority = formatRemoteAuthority(host, remoteSshUser);
  const normalizedPath = normalizeWorkspacePath(path);
  const encodedPath = encodeURI(normalizedPath);

  return `${editorId}://vscode-remote/ssh-remote+${authority}${encodedPath}`;
}
