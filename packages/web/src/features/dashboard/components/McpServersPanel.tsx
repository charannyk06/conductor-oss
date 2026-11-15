"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useConfig } from "@/hooks/useConfig";
import {
  draftToServer,
  emptyDraft,
  normalizeMcpServers,
  serverToDraft,
  validateDrafts,
  type McpServerDraft,
} from "@/lib/mcpServers";

const LABEL_CLASS_NAME =
  "block text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--vk-text-muted)]";
const INPUT_CLASS_NAME =
  "mt-1.5 w-full rounded-[6px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 py-2 text-[13px] text-[var(--vk-text-normal)] outline-none placeholder:text-[var(--vk-text-muted)] focus:border-[var(--vk-orange)] disabled:opacity-60";
const MONO_INPUT_CLASS_NAME = `${INPUT_CLASS_NAME} font-mono text-[12px]`;

function endpoint(projectId: string): string {
  return projectId ? `/api/mcp-servers?projectId=${encodeURIComponent(projectId)}` : "/api/mcp-servers";
}

async function readError(response: Response, fallback: string): Promise<string> {
  const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof payload?.error === "string" ? payload.error : fallback;
}

export function McpServersPanel() {
  const { projects } = useConfig();
  const [scope, setScope] = useState("");
  const [drafts, setDrafts] = useState<McpServerDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  // The backend decides who may manage MCP servers; a 403 means this viewer is not an admin.
  const [forbidden, setForbidden] = useState(false);
  const nextKey = useRef(0);

  const newKey = useCallback(() => {
    nextKey.current += 1;
    return `server-${nextKey.current}`;
  }, []);

  const applyPayload = useCallback((payload: unknown) => {
    setDrafts(normalizeMcpServers(payload).map((server) => serverToDraft(server, newKey())));
    setDirty(false);
  }, [newKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSaved(false);
    void (async () => {
      try {
        const response = await fetch(endpoint(scope), { cache: "no-store" });
        if (response.status === 403) {
          if (!cancelled) {
            setForbidden(true);
            setDrafts([]);
          }
          return;
        }
        if (!cancelled) setForbidden(false);
        if (!response.ok) {
          throw new Error(await readError(response, "Failed to load MCP servers"));
        }
        const payload: unknown = await response.json();
        if (!cancelled) applyPayload(payload);
      } catch (err) {
        if (!cancelled) {
          setDrafts([]);
          setError(err instanceof Error ? err.message : "Failed to load MCP servers");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyPayload, reloadToken, scope]);

  const updateDraft = (key: string, patch: Partial<McpServerDraft>) => {
    setDrafts((current) => current.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
    setDirty(true);
    setSaved(false);
  };

  const handleSave = async () => {
    const problem = validateDrafts(drafts);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(endpoint(scope), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ servers: drafts.map(draftToServer) }),
      });
      if (!response.ok) {
        throw new Error(await readError(response, "Failed to save MCP servers"));
      }
      applyPayload(await response.json());
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save MCP servers");
    } finally {
      setSaving(false);
    }
  };

  const disabled = forbidden || saving;

  return (
    <div className="space-y-5">
      <section className="space-y-1">
        <h4 className="text-[24px] leading-[24px] text-[var(--vk-text-strong)]">MCP Servers</h4>
        <p className="text-[13px] leading-5 text-[var(--vk-text-muted)]">
          Tools your agents and bots can call. Each server is a command this machine runs when a
          session starts. Global servers apply to every project; a project can add its own.
        </p>
      </section>

      <label className="block">
        <span className={LABEL_CLASS_NAME}>Applies to</span>
        <select
          value={scope}
          onChange={(event) => setScope(event.target.value)}
          disabled={saving || dirty}
          className={INPUT_CLASS_NAME}
        >
          <option value="">All projects (global)</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>{project.id}</option>
          ))}
        </select>
        {dirty ? (
          <span className="mt-1 block text-[11px] text-[var(--vk-text-muted)]">
            Save or discard your changes before switching scope.
          </span>
        ) : null}
      </label>

      {forbidden ? (
        <p className="rounded-[6px] border border-[var(--vk-border)] px-3 py-2 text-[12px] text-[var(--vk-text-muted)]">
          Only admins can view or change MCP servers.
        </p>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-2 text-[13px] text-[var(--vk-text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading MCP servers…
        </div>
      ) : (
        <div className="space-y-3">
          {drafts.length === 0 ? (
            <p className="rounded-[6px] border border-dashed border-[var(--vk-border)] px-3 py-4 text-center text-[13px] text-[var(--vk-text-muted)]">
              No MCP servers configured for this scope.
            </p>
          ) : null}
          {drafts.map((draft) => (
            <fieldset
              key={draft.key}
              disabled={disabled}
              className="space-y-3 rounded-[8px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] p-3"
            >
              <div className="flex flex-wrap items-end gap-3">
                <label className="min-w-[140px] flex-1">
                  <span className={LABEL_CLASS_NAME}>Name</span>
                  <input
                    value={draft.name}
                    onChange={(event) => updateDraft(draft.key, { name: event.target.value })}
                    placeholder="filesystem"
                    className={INPUT_CLASS_NAME}
                  />
                </label>
                <label className="flex h-[38px] items-center gap-2 text-[13px] text-[var(--vk-text-normal)]">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(event) => updateDraft(draft.key, { enabled: event.target.checked })}
                  />
                  Enabled
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${draft.name || "server"}`}
                  onClick={() => {
                    setDrafts((current) => current.filter((candidate) => candidate.key !== draft.key));
                    setDirty(true);
                    setSaved(false);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className={LABEL_CLASS_NAME}>Command</span>
                  <input
                    value={draft.command}
                    onChange={(event) => updateDraft(draft.key, { command: event.target.value })}
                    placeholder="npx"
                    className={MONO_INPUT_CLASS_NAME}
                  />
                </label>
                <label className="block">
                  <span className={LABEL_CLASS_NAME}>Arguments</span>
                  <input
                    value={draft.argsText}
                    onChange={(event) => updateDraft(draft.key, { argsText: event.target.value })}
                    placeholder="-y @modelcontextprotocol/server-filesystem ."
                    className={MONO_INPUT_CLASS_NAME}
                  />
                </label>
              </div>
              <label className="block">
                <span className={LABEL_CLASS_NAME}>Working directory (optional)</span>
                <input
                  value={draft.cwd}
                  onChange={(event) => updateDraft(draft.key, { cwd: event.target.value })}
                  className={MONO_INPUT_CLASS_NAME}
                />
              </label>
              <label className="block">
                <span className={LABEL_CLASS_NAME}>Environment (KEY=value per line)</span>
                <textarea
                  value={draft.envText}
                  onChange={(event) => updateDraft(draft.key, { envText: event.target.value })}
                  rows={Math.min(6, Math.max(2, draft.envText.split("\n").length))}
                  spellCheck={false}
                  className={MONO_INPUT_CLASS_NAME}
                />
                <span className="mt-1 block text-[11px] leading-4 text-[var(--vk-text-muted)]">
                  Stored values are shown masked. Leave a masked value as is to keep it, or type a new one to replace it.
                </span>
              </label>
            </fieldset>
          ))}
        </div>
      )}

      {error ? (
        <p role="alert" className="rounded-[6px] border border-[var(--vk-red)]/35 px-3 py-2 text-[12px] text-[var(--vk-red)]">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={disabled || loading}
          onClick={() => {
            setDrafts((current) => [...current, emptyDraft(newKey())]);
            setDirty(true);
            setSaved(false);
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          Add server
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={disabled || loading || !dirty}
          onClick={() => void handleSave()}
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Save MCP servers
        </Button>
        {dirty ? (
          <Button
            type="button"
            variant="ghost"
            disabled={saving}
            onClick={() => setReloadToken((current) => current + 1)}
          >
            Discard changes
          </Button>
        ) : null}
        {saved ? (
          <span className="text-[12px] text-[var(--vk-text-muted)]">
            Saved. New sessions pick this up; running ones keep their current tools.
          </span>
        ) : null}
      </div>
    </div>
  );
}
