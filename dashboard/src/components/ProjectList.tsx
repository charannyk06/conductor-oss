import { useState, useEffect } from "react";
import { api, type Project } from "@/lib/api";

export function ProjectList() {
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => {
    api.projects().then(setProjects);
  }, []);

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">Projects</h2>
      {projects.length === 0 ? (
        <p className="text-zinc-500 text-sm">No projects configured</p>
      ) : (
        <div className="grid gap-2">
          {projects.map((project) => (
            <div
              key={project.id}
              className="bg-zinc-900 border border-zinc-800 rounded-lg p-3"
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium">{project.name}</div>
                  <div className="text-xs text-zinc-500 font-mono">{project.path}</div>
                </div>
                <div className="text-xs text-zinc-400">
                  max {project.max_sessions} sessions
                </div>
              </div>
              {project.default_executor && (
                <div className="mt-1 text-xs text-zinc-500">
                  Default: {project.default_executor}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
