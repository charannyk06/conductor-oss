"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ModelAccessPreferences } from "@conductor-oss/core/types";
import type { ReactNode } from "react";
import { Check, ChevronDown, LoaderCircle } from "lucide-react";
import { AgentTileIcon } from "@/components/AgentTileIcon";
import { cn } from "@/lib/cn";
import {
  getSelectableAgentModels,
  getSelectableAgentReasoningOptions,
  getSelectableDefaultReasoningEffort,
  resolveModelSelectionValue,
  type ModelSelectionState,
} from "@/lib/agentModelSelection";
import { getKnownAgent } from "@/lib/knownAgents";
import type { RuntimeAgentModelCatalog } from "@/lib/runtimeAgentModelsShared";
import { formatCurrentModelLabel } from "@/lib/sessionModelCatalog";

const DISPATCHER_AGENT_OPTIONS = ["codex", "claude-code", "gemini"] as const;

function formatReasoningLabel(value: string): string {
  if (value === "xhigh") {
    return "Extra High";
  }
  return value
    .split(/[_-\s]+/g)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function AgentLabel({ agent }: { agent: string }) {
  const known = getKnownAgent(agent);
  return (
    <span className="flex min-w-0 items-center gap-2">
      <AgentTileIcon
        seed={{ label: agent }}
        className="h-4 w-4 border-none bg-transparent"
      />
      <span className="truncate">{known?.label ?? agent}</span>
    </span>
  );
}

function PreferenceChip({
  label,
  title,
  disabled = false,
  accent = false,
  children,
}: {
  label: ReactNode;
  title: string;
  disabled?: boolean;
  accent?: boolean;
  children: ReactNode;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild disabled={disabled}>
        <button
          type="button"
          disabled={disabled}
          title={title}
          className={cn(
            "inline-flex h-10 min-w-0 items-center gap-2 rounded-[12px] border px-3 text-[13px] transition disabled:cursor-not-allowed disabled:opacity-60",
            accent
              ? "border-[rgba(214,163,126,0.28)] bg-[rgba(66,44,35,0.94)] text-[#f2d9cd] hover:bg-[rgba(78,52,41,0.98)]"
              : "border-[rgba(255,255,255,0.08)] bg-[#272220] text-[#f3ead8] hover:bg-[#312926]",
          )}
        >
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[rgba(255,255,255,0.55)]" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={8}
          className="z-50 min-w-[220px] rounded-[12px] border border-[rgba(255,255,255,0.08)] bg-[#1c1a19] p-2 shadow-[0_18px_50px_rgba(0,0,0,0.45)]"
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

type DispatcherPreferenceChipsProps = {
  implementationAgent: string;
  modelSelection: ModelSelectionState;
  modelAccess: ModelAccessPreferences;
  runtimeModelCatalogs: Record<string, RuntimeAgentModelCatalog>;
  disabled?: boolean;
  className?: string;
  onImplementationAgentChange: (next: string) => void;
  onModelSelectionChange: (next: ModelSelectionState) => void;
};

export function DispatcherPreferenceChips({
  implementationAgent,
  modelSelection,
  modelAccess,
  runtimeModelCatalogs,
  disabled = false,
  className,
  onImplementationAgentChange,
  onModelSelectionChange,
}: DispatcherPreferenceChipsProps) {
  const availableModels = getSelectableAgentModels(
    implementationAgent,
    modelAccess,
    runtimeModelCatalogs,
  );
  const resolvedModel = resolveModelSelectionValue(modelSelection) ?? modelSelection.catalogModel;
  const modelLabel = resolvedModel
    ? formatCurrentModelLabel(implementationAgent, resolvedModel)
    : "Change model";
  const availableReasoningOptions = getSelectableAgentReasoningOptions(
    implementationAgent,
    modelAccess,
    runtimeModelCatalogs,
    resolvedModel,
  );
  const reasoningValue = modelSelection.reasoningEffort.trim().toLowerCase();

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <PreferenceChip
        label={modelLabel}
        title="Change model"
        disabled={disabled || availableModels.length === 0}
      >
        <div className="px-3 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[rgba(255,255,255,0.58)]">
          Change model
        </div>
        {availableModels.map((model) => {
          const selected = model.id === resolvedModel;
          return (
            <DropdownMenu.Item
              key={model.id}
              onSelect={() => {
                const nextReasoningOptions = getSelectableAgentReasoningOptions(
                  implementationAgent,
                  modelAccess,
                  runtimeModelCatalogs,
                  model.id,
                );
                onModelSelectionChange({
                  catalogModel: model.id,
                  customModel: "",
                  reasoningEffort: nextReasoningOptions.some((option) => option.id === reasoningValue)
                    ? reasoningValue
                    : getSelectableDefaultReasoningEffort(
                      implementationAgent,
                      modelAccess,
                      runtimeModelCatalogs,
                      model.id,
                    ),
                });
              }}
              className="flex min-h-[42px] cursor-default items-center gap-3 rounded-[8px] px-3 py-2 text-[13px] text-[#f3efea] outline-none transition hover:bg-[rgba(255,255,255,0.06)] focus:bg-[rgba(255,255,255,0.06)]"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{model.label}</p>
                <p className="truncate text-[11px] text-[rgba(255,255,255,0.58)]">
                  {model.description}
                </p>
              </div>
              {selected ? <Check className="h-4 w-4 text-[#f2d9cd]" /> : null}
            </DropdownMenu.Item>
          );
        })}
      </PreferenceChip>

      {availableReasoningOptions.length > 0 ? (
        <PreferenceChip
          label={(
            <span className="flex items-center gap-2">
              <LoaderCircle className="h-4 w-4 text-[#d7b6a5]" />
              <span>{formatReasoningLabel(reasoningValue || availableReasoningOptions[0].id)}</span>
            </span>
          )}
          title="Change thinking level"
          disabled={disabled}
          accent
        >
          <div className="px-3 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[rgba(255,255,255,0.58)]">
            Thinking
          </div>
          {availableReasoningOptions.map((option) => {
            const selected = option.id === reasoningValue;
            return (
              <DropdownMenu.Item
                key={option.id}
                onSelect={() => onModelSelectionChange({
                  ...modelSelection,
                  reasoningEffort: option.id,
                })}
                className="flex min-h-[42px] cursor-default items-center gap-3 rounded-[8px] px-3 py-2 text-[13px] text-[#f3efea] outline-none transition hover:bg-[rgba(255,255,255,0.06)] focus:bg-[rgba(255,255,255,0.06)]"
              >
                <LoaderCircle className="h-4 w-4 text-[#d7b6a5]" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{option.label}</p>
                  <p className="truncate text-[11px] text-[rgba(255,255,255,0.58)]">
                    {option.description}
                  </p>
                </div>
                {selected ? <Check className="h-4 w-4 text-[#f2d9cd]" /> : null}
              </DropdownMenu.Item>
            );
          })}
        </PreferenceChip>
      ) : null}

      <PreferenceChip
        label={<AgentLabel agent={implementationAgent} />}
        title="Change coding agent"
        disabled={disabled}
      >
        <div className="px-3 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[rgba(255,255,255,0.58)]">
          Coding agent
        </div>
        {DISPATCHER_AGENT_OPTIONS.map((agent) => {
          const known = getKnownAgent(agent);
          const selected = implementationAgent === agent;
          return (
            <DropdownMenu.Item
              key={agent}
              onSelect={() => onImplementationAgentChange(agent)}
              className="flex min-h-[42px] cursor-default items-center gap-3 rounded-[8px] px-3 py-2 text-[13px] text-[#f3efea] outline-none transition hover:bg-[rgba(255,255,255,0.06)] focus:bg-[rgba(255,255,255,0.06)]"
            >
              <AgentTileIcon
                seed={{ label: agent }}
                className="h-4 w-4 border-none bg-transparent"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{known?.label ?? agent}</p>
                <p className="truncate text-[11px] text-[rgba(255,255,255,0.58)]">
                  {known?.description ?? "Coding agent"}
                </p>
              </div>
              {selected ? <Check className="h-4 w-4 text-[#f2d9cd]" /> : null}
            </DropdownMenu.Item>
          );
        })}
      </PreferenceChip>
    </div>
  );
}
