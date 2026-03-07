const BASE = "/api";

export interface HealthResponse {
  status: string;
  version: string;
  uptime_secs: number;
  executors: number;
  event_subscribers: number;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  board_path: string | null;
  default_executor: string | null;
  max_sessions: number;
}

export interface Session {
  id: string;
  task_id: string;
  project_id: string;
  executor: string;
  state: string;
  pid: number | null;
  working_dir: string | null;
  branch: string | null;
  model: string | null;
  exit_code: number | null;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
}

export interface SessionHealth {
  total: number;
  active: number;
  errored: number;
  needs_input: number;
  sessions: Array<{
    id: string;
    project_id: string;
    executor: string;
    state: string;
    grade: string;
    idle_secs: number;
  }>;
}

export interface ExecutorInfo {
  kind: string;
  name: string;
  binary: string;
}

export const api = {
  async health(): Promise<HealthResponse> {
    const res = await fetch(`${BASE}/health`);
    return res.json();
  },

  async sessionHealth(): Promise<SessionHealth> {
    const res = await fetch(`${BASE}/health/sessions`);
    return res.json();
  },

  async projects(): Promise<Project[]> {
    const res = await fetch(`${BASE}/projects`);
    return res.json();
  },

  async sessions(filter?: { state?: string; project_id?: string }): Promise<Session[]> {
    const params = new URLSearchParams();
    if (filter?.state) params.set("state", filter.state);
    if (filter?.project_id) params.set("project_id", filter.project_id);
    const res = await fetch(`${BASE}/sessions?${params}`);
    return res.json();
  },

  async killSession(id: string): Promise<void> {
    await fetch(`${BASE}/sessions/${id}/kill`, { method: "POST" });
  },

  async sendToSession(id: string, text: string): Promise<void> {
    await fetch(`${BASE}/sessions/${id}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  },

  async executors(): Promise<ExecutorInfo[]> {
    const res = await fetch(`${BASE}/config/executors`);
    return res.json();
  },

  eventStream(): EventSource {
    return new EventSource(`${BASE}/events`);
  },
};
