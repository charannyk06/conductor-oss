import { Dashboard } from "@/components/Dashboard";
import type { DashboardSession, DashboardStats } from "@/lib/types";
import { getServices } from "@/lib/services";
import { sessionToDashboard, computeStats } from "@/lib/serialize";
import { getDashboardAccess } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const access = await getDashboardAccess();
  if (!access.ok) {
    return (
      <main className="min-h-screen flex items-center justify-center px-6 text-center bg-[var(--color-bg-base)]">
        <div className="rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-8 max-w-sm">
          <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-[rgba(239,68,68,0.1)] mx-auto">
            <svg width="20" height="20" viewBox="0 0 16 16" fill="var(--color-status-error)">
              <path d="M8 0a8 8 0 100 16A8 8 0 008 0zm3.28 5.78l-4 4a.75.75 0 01-1.06 0l-2-2a.75.75 0 111.06-1.06L6.5 8.19l3.47-3.47a.75.75 0 111.06 1.06z" />
            </svg>
          </div>
          <h1 className="text-[16px] font-semibold text-[var(--color-text-primary)] mb-2">Access denied</h1>
          <p className="text-[13px] text-[var(--color-text-secondary)]">{access.reason}</p>
          {access.email && (
            <p className="text-[11px] text-[var(--color-text-muted)] mt-2">Signed in as {access.email}</p>
          )}
        </div>
      </main>
    );
  }

  let sessions: DashboardSession[] = [];
  let stats: DashboardStats = {
    totalSessions: 0,
    workingSessions: 0,
    openPRs: 0,
    needsAttention: 0,
  };

  type ConfigProject = { id: string; boardDir: string; repo: string | null; description: string | null; agent: string };
  let configProjects: ConfigProject[] = [];

  try {
    const { sessionManager, config } = await getServices();
    const allSessions = await sessionManager.list();
    sessions = allSessions.map(sessionToDashboard);
    stats = computeStats(sessions);
    configProjects = Object.entries(config.projects).map(([id, project]) => {
      const p = project as unknown as Record<string, unknown>;
      return {
        id,
        repo: (p["repo"] as string | undefined) ?? null,
        boardDir: (p["boardDir"] as string | undefined) ?? id,
        description: (p["description"] as string | undefined) ?? null,
        agent: (p["agent"] as string | undefined) ?? "claude-code",
      };
    });
  } catch {
    // Services unavailable — show empty dashboard
  }

  return <Dashboard sessions={sessions} stats={stats} configProjects={configProjects} />;
}
