"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  BookOpen,
  Bug,
  CheckCircle2,
  Cpu,
  FileText,
  Globe,
  Image,
  LayoutGrid,
  Loader2,
  Megaphone,
  NotebookPen,
  Palette,
  Presentation,
  Rocket,
  Search,
  Sparkles,
  Puzzle,
  Table2,
  UsersRound,
  Video,
  Wand2,
  Workflow,
  type LucideIcon,
  Wrench,
} from "lucide-react";
import type { DashboardSession } from "@/lib/types";
import { withBridgeQuery } from "@/lib/bridgeQuery";
import type {
  CustomInstalledSkill,
  InstalledSkillStatus,
  SkillAgentCatalogEntry,
  SkillCatalogEntry,
} from "@/lib/skills";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardContent, CardHeader } from "@/components/ui/Card";

type SessionSkillsProps = {
  session: DashboardSession;
  sessionId: string;
  active: boolean;
};

type InstallScope = "user" | "workspace";

type ToastState = { kind: "success" | "error"; message: string } | null;

type SkillCatalogResponse = {
  skills?: SkillCatalogEntry[];
  agents?: SkillAgentCatalogEntry[];
};

type InstalledSkillsResponse = {
  skills?: InstalledSkillStatus[];
  customSkills?: CustomInstalledSkill[];
};

type ActiveSkillsResponse = {
  skillIds?: string[];
};

type RefreshOptions = {
  clearToast?: boolean;
};

const SKILL_ICON_BY_NAME: Record<string, LucideIcon> = {
  FileText,
  Presentation,
  Table2,
  UsersRound,
  Palette,
  Image,
  Sparkles,
  LayoutGrid,
  Rocket,
  Bug,
  Search,
  Workflow,
  Wand2,
  Video,
  Megaphone,
  Globe,
  BookOpen,
  NotebookPen,
};

const CUSTOM_SKILL_ICON_POOL: LucideIcon[] = [
  FileText,
  BookOpen,
  Globe,
  LayoutGrid,
  Palette,
  Search,
  Sparkles,
  Wand2,
  Workflow,
  NotebookPen,
  UsersRound,
];

const DEFAULT_GENERIC_AGENT: SkillAgentCatalogEntry = {
  id: "generic-open-standard",
  name: "Generic open-standard",
  projectRoots: [".agents/skills"],
  userRoots: ["~/.agents/skills"],
};

function detectSessionAgent(session: DashboardSession): string {
  return (
    session.metadata["agent"]?.trim() ||
    session.metadata["executor"]?.trim() ||
    session.metadata["runtimeAgent"]?.trim() ||
    ""
  );
}

function detectWorkspacePath(session: DashboardSession): string | null {
  return session.metadata["workspacePath"]?.trim() || null;
}

function getResponseErrorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === "object") {
    const candidate = payload as { error?: unknown; reason?: unknown };
    if (typeof candidate.error === "string" && candidate.error.trim().length > 0) {
      return candidate.error;
    }
    if (typeof candidate.reason === "string" && candidate.reason.trim().length > 0) {
      return candidate.reason;
    }
  }

  return `Request failed (${status})`;
}

async function readJsonResponse<T>(responsePromise: Promise<Response>): Promise<T> {
  const response = await responsePromise;
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(getResponseErrorMessage(payload, response.status));
  }

  return payload as T;
}

function getErrorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

function getSkillIcon(iconName: string | null | undefined): LucideIcon {
  const candidate = iconName?.trim();
  if (candidate && SKILL_ICON_BY_NAME[candidate]) {
    return SKILL_ICON_BY_NAME[candidate];
  }

  return Puzzle;
}

function getCustomSkillIcon(label: string): LucideIcon {
  if (label.trim().length === 0) {
    return Puzzle;
  }

  let hash = 0;
  for (const character of label) {
    hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  }

  return CUSTOM_SKILL_ICON_POOL[Math.abs(hash) % CUSTOM_SKILL_ICON_POOL.length] ?? Sparkles;
}

export function SessionSkills({ session, sessionId, active }: SessionSkillsProps) {
  const bridgeId = session.bridgeId ?? null;
  const agent = detectSessionAgent(session);
  const workspacePath = detectWorkspacePath(session);
  const [query, setQuery] = useState("");
  const [targetAgent, setTargetAgent] = useState(agent || DEFAULT_GENERIC_AGENT.id);
  const [scope, setScope] = useState<InstallScope>(workspacePath ? "workspace" : "user");
  const [catalog, setCatalog] = useState<SkillCatalogEntry[]>([]);
  const [catalogAgents, setCatalogAgents] = useState<SkillAgentCatalogEntry[]>([]);
  const [installed, setInstalled] = useState<Record<string, InstalledSkillStatus>>({});
  const [activeSkillIds, setActiveSkillIds] = useState<string[]>([]);
  const [customSkills, setCustomSkills] = useState<CustomInstalledSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionSkillId, setActionSkillId] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState>(null);

  const selectedAgent = useMemo(() => {
    return (
      catalogAgents.find((entry) => entry.id === targetAgent) ??
      (targetAgent.trim().length > 0 && targetAgent !== DEFAULT_GENERIC_AGENT.id
        ? {
            id: targetAgent,
            name: targetAgent,
            projectRoots: DEFAULT_GENERIC_AGENT.projectRoots,
            userRoots: DEFAULT_GENERIC_AGENT.userRoots,
          }
        : DEFAULT_GENERIC_AGENT)
    );
  }, [catalogAgents, targetAgent]);

  const agentOptions = useMemo(() => {
    const options = [...catalogAgents];
    if (!options.some((entry) => entry.id === selectedAgent.id)) {
      options.unshift(selectedAgent);
    }
    if (!options.some((entry) => entry.id === agent && agent.trim().length > 0)) {
      options.unshift({
        id: agent || DEFAULT_GENERIC_AGENT.id,
        name: agent || DEFAULT_GENERIC_AGENT.name,
        projectRoots: DEFAULT_GENERIC_AGENT.projectRoots,
        userRoots: DEFAULT_GENERIC_AGENT.userRoots,
      });
    }
    return options.filter((entry, index, array) => array.findIndex((candidate) => candidate.id === entry.id) === index);
  }, [agent, catalogAgents, selectedAgent]);

  const refresh = useCallback(async (options: RefreshOptions = {}) => {
    const { clearToast = true } = options;
    if (!active) return;

    setLoading(true);
    if (clearToast) {
      setToast(null);
    }

    try {
      const [catalogResult, installedResult, activeResult] = await Promise.allSettled([
        readJsonResponse<SkillCatalogResponse>(
          fetch(withBridgeQuery("/api/skills/catalog", bridgeId), { cache: "no-store" }),
        ),
        readJsonResponse<InstalledSkillsResponse>(
          fetch(
            withBridgeQuery(
              `/api/skills/installed?agent=${encodeURIComponent(targetAgent)}${workspacePath ? `&workspacePath=${encodeURIComponent(workspacePath)}` : ""}`,
              bridgeId,
            ),
            { cache: "no-store" },
          ),
        ),
        readJsonResponse<ActiveSkillsResponse>(
          fetch(
            withBridgeQuery(`/api/skills/session-active?sessionId=${encodeURIComponent(sessionId)}`, bridgeId),
            { cache: "no-store" },
          ),
        ),
      ]);

      const errors: string[] = [];

      if (catalogResult.status === "fulfilled") {
        setCatalog(Array.isArray(catalogResult.value.skills) ? catalogResult.value.skills : []);
        setCatalogAgents(Array.isArray(catalogResult.value.agents) ? catalogResult.value.agents : []);
      } else {
        errors.push(getErrorMessage(catalogResult.reason, "Failed to load skills catalog"));
      }

      if (installedResult.status === "fulfilled") {
        const installedMap = Object.fromEntries(
          (installedResult.value.skills ?? []).map((entry) => [entry.skillId, entry] as const),
        );
        setInstalled(installedMap);
        setCustomSkills(installedResult.value.customSkills ?? []);
      } else {
        errors.push(getErrorMessage(installedResult.reason, "Failed to load installed skills"));
      }

      if (activeResult.status === "fulfilled") {
        setActiveSkillIds(activeResult.value.skillIds ?? []);
      } else {
        errors.push(getErrorMessage(activeResult.reason, "Failed to load active session skills"));
      }

      if (errors.length > 0) {
        setToast({ kind: "error", message: errors[0] });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load skills";
      setToast({ kind: "error", message });
    } finally {
      setLoading(false);
    }
  }, [active, bridgeId, sessionId, targetAgent, workspacePath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filteredCatalog = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return catalog.filter((entry) => {
      if (needle.length === 0) return true;
      return (
        entry.name.toLowerCase().includes(needle) ||
        entry.summary.toLowerCase().includes(needle) ||
        entry.category.toLowerCase().includes(needle)
      );
    });
  }, [catalog, query]);

  const runAction = useCallback(async (skill: SkillCatalogEntry, mode: "install" | "activate" | "deactivate" | "uninstall") => {
    setActionSkillId(skill.id);
    setToast(null);
    try {
      const pathname =
        mode === "install"
          ? "/api/skills/install"
          : mode === "activate"
            ? "/api/skills/activate"
            : mode === "deactivate"
              ? "/api/skills/deactivate"
              : "/api/skills/uninstall";
      const payload =
        mode === "activate" || mode === "deactivate"
          ? { sessionId, skillId: skill.id }
          : {
              skillId: skill.id,
              agent: targetAgent,
              scope,
              workspacePath,
              sessionId,
            };
      const response = await fetch(withBridgeQuery(pathname, bridgeId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || "Skill action failed");
      }
      const messages: Record<typeof mode, string> = {
        install: `${skill.name} installed and activated for this session.`,
        activate: `${skill.name} is active for this session.`,
        deactivate: `${skill.name} is no longer active for this session.`,
        uninstall: `${skill.name} was removed from ${scope} scope.`,
      };
      setToast({ kind: "success", message: messages[mode] });
      await refresh({ clearToast: false });
    } catch (error) {
      setToast({ kind: "error", message: error instanceof Error ? error.message : "Skill action failed" });
    } finally {
      setActionSkillId(null);
    }
  }, [bridgeId, refresh, scope, sessionId, targetAgent, workspacePath]);

  const showInitialLoading = loading && catalog.length === 0;
  const showRefreshing = loading && catalog.length > 0;
  const hasQuery = query.trim().length > 0;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain pb-4 touch-pan-y lg:overflow-hidden lg:pb-0">
        <div className="flex min-h-full min-w-0 flex-col gap-3">
          <Card className="min-w-0">
            <CardHeader className="flex flex-col items-stretch gap-3">
              <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 space-y-1.5">
                  <h2 className="text-[15px] font-semibold text-[var(--vk-text-normal)]">Skills</h2>
                  <p className="text-[13px] text-[var(--vk-text-muted)]">
                    Install open-agent skills from the curated catalog, detect what is already installed for the selected agent, and mark a skill as active for this session.
                  </p>
                </div>
                <div className="flex min-w-0 flex-col gap-2 text-[12px] text-[var(--vk-text-muted)] lg:items-end">
                  <div className="flex min-w-0 items-center gap-2">
                    <Cpu className="h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0">
                      Agent: <span className="font-medium text-[var(--vk-text-normal)] break-words">{agent || "unknown"}</span>
                    </span>
                  </div>
                  <div className="min-w-0">
                    Device: <span className="font-medium text-[var(--vk-text-normal)] break-words">{bridgeId ?? "local"}</span>
                  </div>
                  <div className="min-w-0 break-words">
                    Target agent: <span className="font-medium text-[var(--vk-text-normal)] break-words">{selectedAgent.name}</span>
                  </div>
                  <div className="min-w-0 break-words">
                    Workspace: <span className="font-medium text-[var(--vk-text-normal)] break-words">{workspacePath ?? "Unavailable"}</span>
                  </div>
                </div>
              </div>
              <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                <label className="flex w-full items-center gap-2 rounded-[14px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 py-2 text-[12px] text-[var(--vk-text-muted)]">
                  <Search className="h-3.5 w-3.5 shrink-0" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search skills"
                    className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--vk-text-normal)] outline-none placeholder:text-[var(--vk-text-muted)]"
                  />
                </label>
                <label className="flex w-full items-center justify-between gap-2 text-[12px] text-[var(--vk-text-muted)] lg:w-auto lg:justify-start">
                  <span className="shrink-0">Target agent</span>
                  <select
                    value={targetAgent}
                    onChange={(event) => setTargetAgent(event.target.value)}
                    className="min-w-0 w-full rounded-[12px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 py-2 text-[13px] text-[var(--vk-text-normal)] lg:w-auto"
                  >
                    {agentOptions.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex w-full items-center justify-between gap-2 text-[12px] text-[var(--vk-text-muted)] lg:w-auto lg:justify-start">
                  <span className="shrink-0">Install scope</span>
                  <select
                    value={scope}
                    onChange={(event) => setScope(event.target.value as InstallScope)}
                    className="min-w-0 w-full rounded-[12px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 py-2 text-[13px] text-[var(--vk-text-normal)] lg:w-auto"
                  >
                    <option value="user">User</option>
                    <option value="workspace" disabled={!workspacePath}>Workspace</option>
                  </select>
                </label>
              </div>
              <div className="rounded-[14px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 py-2 text-[12px] text-[var(--vk-text-muted)]">
                Installs into the selected agent&apos;s official skill folders. User scope mirrors into{" "}
                <span className="font-medium text-[var(--vk-text-normal)]">{selectedAgent.userRoots.join(" • ")}</span>; workspace scope mirrors into{" "}
                <span className="font-medium text-[var(--vk-text-normal)]">{selectedAgent.projectRoots.join(" • ")}</span>.
              </div>
              {toast ? (
                <div className={`rounded-[14px] border px-3 py-2 text-[12px] ${toast.kind === "error" ? "border-red-400/35 bg-red-400/10 text-red-100" : "border-emerald-400/35 bg-emerald-400/10 text-emerald-100"}`}>
                  {toast.message}
                </div>
              ) : null}
              {showRefreshing ? (
                <div className="rounded-[14px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 py-2 text-[12px] text-[var(--vk-text-muted)]">
                  Refreshing skills...
                </div>
              ) : null}
            </CardHeader>
          </Card>

          <div className="grid min-h-0 min-w-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_320px] lg:overflow-hidden">
            <div className="min-h-0 min-w-0 rounded-[18px] border border-[var(--vk-border)] bg-[var(--vk-bg-surface)] p-3 lg:overflow-y-auto">
              <div className="space-y-3 lg:pr-2">
                {showInitialLoading ? (
                  <div className="flex min-h-[180px] items-center justify-center text-[13px] text-[var(--vk-text-muted)] sm:min-h-[220px]">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading skills...
                  </div>
                ) : filteredCatalog.length === 0 ? (
                  <div className="flex min-h-[180px] items-center justify-center text-[13px] text-[var(--vk-text-muted)] sm:min-h-[220px]">
                    {hasQuery ? "No matching skills found." : "No skills available."}
                  </div>
                ) : (
                  filteredCatalog.map((skill) => {
                    const installState = installed[skill.id];
                    const isInstalled = Boolean(installState?.installedUser || installState?.installedWorkspace);
                    const isActive = activeSkillIds.includes(skill.id);
                    const working = actionSkillId === skill.id;
                    const incompatible = false;
                    const SkillIcon = getSkillIcon(skill.icon);
                    const supportsAllAgents = catalogAgents.length > 0 && skill.compatibleAgents.length >= catalogAgents.length;
                    return (
                      <Card key={skill.id} className="min-w-0 border-[var(--vk-border)] bg-[var(--vk-bg-main)]">
                        <CardHeader className="flex flex-col items-stretch gap-3">
                          <div className="flex min-w-0 flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                            <div className="flex min-w-0 gap-3">
                              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] border border-[var(--vk-border)] bg-[var(--vk-bg-surface)] text-[var(--vk-text-normal)]">
                                <SkillIcon className="h-4 w-4" />
                              </div>
                              <div className="min-w-0 space-y-1.5">
                                <div className="flex min-w-0 flex-wrap items-center gap-2">
                                  <h3 className="min-w-0 text-[14px] font-semibold text-[var(--vk-text-normal)]">{skill.name}</h3>
                                  {skill.verified ? <Badge>Verified</Badge> : <Badge variant="outline">Community</Badge>}
                                  <Badge variant="outline">{skill.category}</Badge>
                                  {isInstalled ? <Badge variant="outline">Installed</Badge> : null}
                                  {isActive ? <Badge variant="outline">Active now</Badge> : null}
                                  {incompatible ? <Badge variant="outline">Unsupported</Badge> : null}
                                </div>
                                <p className="text-[13px] text-[var(--vk-text-muted)]">{skill.summary}</p>
                                {skill.note ? (
                                  <div className="rounded-[12px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] px-3 py-2 text-[12px] text-[var(--vk-text-muted)]">
                                    <Badge variant="info" className="mr-2 align-middle">Note</Badge>
                                    <span className="align-middle">{skill.note}</span>
                                  </div>
                                ) : null}
                              </div>
                            </div>
                            <div className="flex w-full flex-wrap items-center gap-2 xl:w-auto xl:justify-end">
                              <a
                                href={skill.docsUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-[12px] text-[var(--vk-text-muted)] hover:text-[var(--vk-text-normal)]"
                              >
                                Docs <ArrowUpRight className="h-3 w-3" />
                              </a>
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-2 text-[12px] text-[var(--vk-text-muted)]">
                            {supportsAllAgents ? (
                              <Badge variant="outline">Compatible with all supported agents</Badge>
                            ) : (
                              skill.compatibleAgents.map((compatibleAgent) => (
                                <Badge key={compatibleAgent} variant="outline">{compatibleAgent}</Badge>
                              ))
                            )}
                          </div>
                        </CardHeader>
                        <CardContent className="space-y-3">
                          {installState?.installPaths?.length ? (
                            <div className="rounded-[12px] border border-[var(--vk-border)] bg-[var(--vk-bg-surface)] px-3 py-2 text-[12px] text-[var(--vk-text-muted)] break-words">
                              Installed at: {installState.installPaths.join(" • ")}
                            </div>
                          ) : null}
                          <div className="flex flex-wrap gap-2">
                            {isInstalled ? (
                              isActive ? (
                                <Button type="button" variant="outline" size="sm" disabled={working} onClick={() => void runAction(skill, "deactivate")}>
                                  {working ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Wrench className="mr-1 h-3.5 w-3.5" />} Deactivate
                                </Button>
                              ) : (
                                <Button type="button" size="sm" disabled={working || incompatible} onClick={() => void runAction(skill, "activate")}>
                                  {working ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="mr-1 h-3.5 w-3.5" />} Use in session
                                </Button>
                              )
                            ) : (
                              <Button type="button" size="sm" disabled={working || incompatible} onClick={() => void runAction(skill, "install")}>
                                {working ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="mr-1 h-3.5 w-3.5" />} Install and use
                              </Button>
                            )}
                            {isInstalled ? (
                              <Button type="button" variant="outline" size="sm" disabled={working} onClick={() => void runAction(skill, "uninstall")}>
                                {working ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null} Uninstall
                              </Button>
                            ) : null}
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })
                )}
              </div>
            </div>

            <Card className="min-h-0 min-w-0 border-[var(--vk-border)] bg-[var(--vk-bg-surface)] lg:overflow-y-auto">
              <CardHeader className="flex-col items-start gap-1.5">
                <h3 className="text-[14px] font-semibold text-[var(--vk-text-normal)]">Detected custom skills</h3>
                <p className="text-[13px] text-[var(--vk-text-muted)]">
                  Extra skill folders already present on the paired machine that do not match the curated catalog.
                </p>
              </CardHeader>
              <CardContent className="space-y-2 text-[13px] text-[var(--vk-text-muted)]">
                {customSkills.length === 0 ? (
                  <p>No custom skill folders detected.</p>
                ) : (
                  customSkills.map((skill) => {
                    const CustomSkillIcon = getCustomSkillIcon(skill.name);
                    return (
                      <div key={skill.id} className="flex items-start gap-3 rounded-[12px] border border-[var(--vk-border)] bg-[var(--vk-bg-main)] px-3 py-2 break-words">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[12px] border border-[var(--vk-border)] bg-[var(--vk-bg-panel)] text-[var(--vk-text-muted)]">
                          <CustomSkillIcon className="h-3.5 w-3.5" />
                        </div>
                        <div className="min-w-0">
                          <div className="font-medium text-[var(--vk-text-normal)]">{skill.name}</div>
                          <div className="text-[12px] text-[var(--vk-text-muted)] break-words">Detected from {skill.source}</div>
                        </div>
                      </div>
                    );
                  })
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
