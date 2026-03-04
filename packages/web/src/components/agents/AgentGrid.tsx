"use client";

import { Bot, BadgeCheck } from "lucide-react";
import { useAgents } from "@/hooks/useAgents";
import { Badge } from "@/components/ui/Badge";
import { Card, CardContent } from "@/components/ui/Card";
import { AgentTileIcon } from "@/components/AgentTileIcon";

interface AgentCardProps {
  name: string;
  description: string;
  model?: string;
  homepage?: string;
  iconUrl?: string;
}

function AgentCard({ name, description, model, homepage, iconUrl }: AgentCardProps) {
  return (
    <Card className="h-full">
      <CardContent className="flex h-full flex-col gap-3">
        <div className="flex items-start gap-3">
          <span className="surface-panel inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius-sm)] border">
            <AgentTileIcon seed={{ label: name, homepage, iconUrl }} className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[14px] font-semibold text-[var(--text-strong)]">{name}</h3>
            <div className="mt-1 flex items-center gap-1.5">
              <Badge variant="outline">Available</Badge>
              {model && <Badge variant="info">{model}</Badge>}
            </div>
          </div>
        </div>

        <p className="line-clamp-3 text-[13px] leading-relaxed text-[var(--text-muted)]">
          {description || "No description available."}
        </p>

        {homepage && (
          <a
            href={homepage}
            target="_blank"
            rel="noreferrer"
            className="mt-auto inline-flex items-center gap-1 text-[11px] text-[var(--accent)] hover:underline"
          >
            <BadgeCheck className="h-3.5 w-3.5" />
            Visit docs
          </a>
        )}
      </CardContent>
    </Card>
  );
}

export function AgentGrid() {
  const { agents, loading } = useAgents();

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <span className="text-[13px] text-[var(--text-muted)]">Loading agents...</span>
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <Bot className="h-8 w-8 text-[var(--text-faint)]" />
        <span className="text-[13px] text-[var(--text-muted)]">No agents configured</span>
      </div>
    );
  }

  return (
    <div className="space-y-3 px-1 py-1">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold text-[var(--text-strong)]">Configured Agents</h2>
        <Badge variant="outline">{agents.length}</Badge>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {agents.map((agent) => (
          <AgentCard
            key={agent.name}
            name={agent.name}
            description={agent.description}
            model={agent["model"] as string | undefined}
            homepage={agent["homepage"] as string | undefined}
            iconUrl={agent["iconUrl"] as string | undefined}
          />
        ))}
      </div>
    </div>
  );
}
