"use client";

import { Bot } from "lucide-react";
import { useAgents } from "@/hooks/useAgents";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";

interface AgentCardProps {
  name: string;
  description: string;
  model?: string;
}

function AgentCard({ name, description, model }: AgentCardProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-surface)] p-4",
        "transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-bg-elevated)]",
      )}
    >
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--color-accent-subtle)]">
          <Bot className="h-4.5 w-4.5 text-[var(--color-accent)]" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[14px] font-semibold text-[var(--color-text-primary)]">
            {name}
          </h3>
          {model && (
            <Badge variant="outline" className="mt-0.5 text-[10px]">
              {model}
            </Badge>
          )}
        </div>
      </div>
      <p className="line-clamp-2 text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
        {description || "No description"}
      </p>
    </div>
  );
}

export function AgentGrid() {
  const { agents, loading } = useAgents();

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <span className="text-[13px] text-[var(--color-text-muted)]">Loading agents...</span>
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <Bot className="h-8 w-8 text-[var(--color-text-muted)]" />
        <span className="text-[13px] text-[var(--color-text-muted)]">No agents configured</span>
      </div>
    );
  }

  return (
    <div className="p-6">
      <h2 className="mb-4 text-[15px] font-semibold text-[var(--color-text-primary)]">Agents</h2>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {agents.map((agent) => (
          <AgentCard
            key={agent.name}
            name={agent.name}
            description={agent.description}
            model={agent["model"] as string | undefined}
          />
        ))}
      </div>
    </div>
  );
}
