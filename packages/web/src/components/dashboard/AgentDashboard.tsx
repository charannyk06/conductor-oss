"use client";

/**
 * Agent Monitoring Dashboard
 * 
 * Superset-style centralized view of all active AI agent sessions.
 * Provides real-time status, quick actions, and resource monitoring.
 */

import { useState } from "react";
import { 
  Activity, 
  AlertCircle, 
  CheckCircle2, 
  Clock, 
  Cpu, 
  HardDrive, 
  MoreHorizontal, 
  Pause, 
  Play, 
  RefreshCw, 
  Square, 
  Terminal,
  X
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

// Types
export interface AgentStatus {
  id: string;
  name: string;
  agentName: string;
  projectId: string;
  projectName: string;
  status: "running" | "idle" | "error" | "completed" | "paused";
  startTime: string;
  duration: number; // seconds
  lastActivity: string;
  cpuUsage?: number;
  memoryUsage?: number;
  recentOutput?: string;
  taskCount: number;
  errorCount: number;
}

interface AgentCardProps {
  agent: AgentStatus;
  isSelected: boolean;
  onSelect: () => void;
  onAction: (action: "stop" | "pause" | "resume" | "restart") => void;
}

function AgentCard({ agent, isSelected, onSelect, onAction }: AgentCardProps) {
  const getStatusIcon = () => {
    switch (agent.status) {
      case "running":
        return <Activity className="w-4 h-4 text-green-400" />;
      case "idle":
        return <Clock className="w-4 h-4 text-yellow-400" />;
      case "error":
        return <AlertCircle className="w-4 h-4 text-red-400" />;
      case "completed":
        return <CheckCircle2 className="w-4 h-4 text-blue-400" />;
      case "paused":
        return <Pause className="w-4 h-4 text-orange-400" />;
      default:
        return null;
    }
  };

  const getStatusColor = () => {
    switch (agent.status) {
      case "running":
        return "border-green-500/30 bg-green-500/5";
      case "idle":
        return "border-yellow-500/30 bg-yellow-500/5";
      case "error":
        return "border-red-500/30 bg-red-500/5";
      case "completed":
        return "border-blue-500/30 bg-blue-500/5";
      case "paused":
        return "border-orange-500/30 bg-orange-500/5";
      default:
        return "border-white/10";
    }
  };

  const formatDuration = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
      return `${hours}h ${mins}m`;
    }
    return `${mins}m`;
  };

  return (
    <div
      onClick={onSelect}
      className={cn(
        "relative p-4 rounded-xl border cursor-pointer transition-all",
        "hover:border-white/20 hover:shadow-lg hover:shadow-black/20",
        isSelected ? "ring-2 ring-white/20 ring-offset-2 ring-offset-black" : "",
        getStatusColor()
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="p-2 rounded-lg bg-black/30">
            <Terminal className="w-4 h-4 text-white/70" />
          </div>
          <div>
            <h3 className="text-sm font-medium text-white/90">{agent.name}</h3>
            <p className="text-xs text-white/50">{agent.agentName}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {getStatusIcon()}
          <span className="text-xs capitalize text-white/60">{agent.status}</span>
        </div>
      </div>

      {/* Project */}
      <div className="mb-3">
        <p className="text-xs text-white/40">{agent.projectName}</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2 mb-3">
        <div className="text-center p-2 rounded-lg bg-black/20">
          <p className="text-xs text-white/40 mb-0.5">Runtime</p>
          <p className="text-sm font-medium text-white/70">{formatDuration(agent.duration)}</p>
        </div>
        <div className="text-center p-2 rounded-lg bg-black/20">
          <p className="text-xs text-white/40 mb-0.5">Tasks</p>
          <p className="text-sm font-medium text-white/70">{agent.taskCount}</p>
        </div>
        <div className="text-center p-2 rounded-lg bg-black/20">
          <p className="text-xs text-white/40 mb-0.5">Errors</p>
          <p className={cn(
            "text-sm font-medium",
            agent.errorCount > 0 ? "text-red-400" : "text-white/70"
          )}>
            {agent.errorCount}
          </p>
        </div>
      </div>

      {/* Resource usage */}
      {(agent.cpuUsage !== undefined || agent.memoryUsage !== undefined) && (
        <div className="flex items-center gap-4 mb-3 text-xs text-white/40">
          {agent.cpuUsage !== undefined && (
            <div className="flex items-center gap-1">
              <Cpu className="w-3 h-3" />
              <span>{agent.cpuUsage.toFixed(1)}%</span>
            </div>
          )}
          {agent.memoryUsage !== undefined && (
            <div className="flex items-center gap-1">
              <HardDrive className="w-3 h-3" />
              <span>{(agent.memoryUsage / 1024 / 1024).toFixed(0)} MB</span>
            </div>
          )}
        </div>
      )}

      {/* Recent output preview */}
      {agent.recentOutput && (
        <div className="p-2 rounded-lg bg-black/30 mb-3">
          <p className="text-xs text-white/40 font-mono truncate">
            {agent.recentOutput}
          </p>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-1">
        {agent.status === "running" ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 text-xs text-white/60 hover:text-red-400 hover:bg-red-500/10"
            onClick={(e) => {
              e.stopPropagation();
              onAction("stop");
            }}
          >
            <Square className="w-3 h-3 mr-1" />
            Stop
          </Button>
        ) : agent.status === "paused" ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 text-xs text-white/60 hover:text-green-400 hover:bg-green-500/10"
            onClick={(e) => {
              e.stopPropagation();
              onAction("resume");
            }}
          >
            <Play className="w-3 h-3 mr-1" />
            Resume
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 text-xs text-white/60 hover:text-white/90 hover:bg-white/10"
            onClick={(e) => {
              e.stopPropagation();
              onAction("restart");
            }}
          >
            <RefreshCw className="w-3 h-3 mr-1" />
            Restart
          </Button>
        )}
        
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0 text-white/40 hover:text-white/70"
        >
          <MoreHorizontal className="w-4 h-4" />
        </Button>
      </div>

      {/* Selection indicator */}
      {isSelected && (
        <div className="absolute top-2 right-2 w-2 h-2 rounded-full bg-white/60" />
      )}
    </div>
  );
}

// Main dashboard component
interface AgentDashboardProps {
  agents: AgentStatus[];
  onAgentSelect: (agentId: string) => void;
  onAgentAction: (agentId: string, action: "stop" | "pause" | "resume" | "restart") => void;
  selectedAgentId?: string;
}

export function AgentDashboard({
  agents,
  onAgentSelect,
  onAgentAction,
  selectedAgentId,
}: AgentDashboardProps) {
  const [filter, setFilter] = useState<"all" | "running" | "error" | "completed">("all");
  const [searchQuery, setSearchQuery] = useState("");

  // Filter agents
  const filteredAgents = agents.filter((agent) => {
    if (filter !== "all" && agent.status !== filter) {
      return false;
    }
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      return (
        agent.name.toLowerCase().includes(query) ||
        agent.agentName.toLowerCase().includes(query) ||
        agent.projectName.toLowerCase().includes(query)
      );
    }
    return true;
  });

  // Stats
  const stats = {
    total: agents.length,
    running: agents.filter((a) => a.status === "running").length,
    error: agents.filter((a) => a.status === "error").length,
    completed: agents.filter((a) => a.status === "completed").length,
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/5">
        <div>
          <h1 className="text-lg font-semibold text-white/90">Agent Dashboard</h1>
          <p className="text-sm text-white/50">
            {stats.running} running, {stats.error} errors, {stats.completed} completed
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Search */}
          <div className="relative">
            <input
              type="text"
              placeholder="Search agents..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-48 h-8 pl-3 pr-8 rounded-lg bg-white/5 border border-white/10 text-sm text-white/80 placeholder:text-white/30 focus:outline-none focus:border-white/20"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/70"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Filter tabs */}
          <div className="flex items-center gap-1 p-1 rounded-lg bg-white/5">
            {(["all", "running", "error", "completed"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  "px-3 py-1 rounded-md text-xs font-medium transition-colors",
                  filter === f
                    ? "bg-white/10 text-white/90"
                    : "text-white/50 hover:text-white/70"
                )}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
                {f !== "all" && (
                  <span className="ml-1.5 text-white/40">
                    {stats[f]}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Agent grid */}
      <div className="flex-1 overflow-y-auto p-6">
        {filteredAgents.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-4">
              <Terminal className="w-8 h-8 text-white/20" />
            </div>
            <h3 className="text-base font-medium text-white/60 mb-1">
              {searchQuery ? "No agents match your search" : "No agents running"}
            </h3>
            <p className="text-sm text-white/40 max-w-sm">
              {searchQuery
                ? "Try adjusting your search or filters"
                : "Create a new session to start an AI agent"}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {filteredAgents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                isSelected={agent.id === selectedAgentId}
                onSelect={() => onAgentSelect(agent.id)}
                onAction={(action) => onAgentAction(agent.id, action)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Compact version for sidebar
interface AgentMiniListProps {
  agents: AgentStatus[];
  onAgentSelect: (agentId: string) => void;
  selectedAgentId?: string;
}

export function AgentMiniList({ agents, onAgentSelect, selectedAgentId }: AgentMiniListProps) {
  return (
    <div className="flex flex-col gap-1">
      {agents.slice(0, 10).map((agent) => (
        <button
          key={agent.id}
          onClick={() => onAgentSelect(agent.id)}
          className={cn(
            "flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors",
            selectedAgentId === agent.id
              ? "bg-white/10 text-white/90"
              : "hover:bg-white/5 text-white/60"
          )}
        >
          <div className={cn(
            "w-2 h-2 rounded-full",
            agent.status === "running" && "bg-green-400",
            agent.status === "error" && "bg-red-400",
            agent.status === "idle" && "bg-yellow-400",
            agent.status === "completed" && "bg-blue-400",
          )} />
          <span className="text-xs truncate flex-1">{agent.name}</span>
        </button>
      ))}
      
      {agents.length > 10 && (
        <p className="text-xs text-white/30 px-3 py-1">
          +{agents.length - 10} more agents
        </p>
      )}
    </div>
  );
}
