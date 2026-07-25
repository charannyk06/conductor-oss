"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ModelAccessPreferences } from "@conductor-oss/core/types";
import type { ReactNode } from "react";
import { Brain, Check, ChevronDown } from "lucide-react";
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
    <span className="flex min-w-0 items-center gap-1.5 sm:gap-1">
      <AgentTileIcon
        seed={{ label: agent }}
        className="h-3.5 w-3.5 border-none bg-transparent sm:h-3 sm:w-3"
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
  triggerClassName,
  contentClassName,
  children,
}: {
  label: ReactNode;
  title: string;
  disabled?: boolean;
  accent?: boolean;
  triggerClassName?: string;
  contentClassName?: string;
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
            "inline-flex h-9 min-w-0 items-center gap-1.5 rounded-[11px] border px-2.5 text-[12px] font-medium transition disabled:cursor-not-allowed disabled:opacity-60 sm:h-[30px] sm:gap-1 sm:rounded-[9px] sm:px-2 sm:text-[11.5px]",
            accent
              ? "border-[rgba(214,163,126,0.28)] bg-[rgba(66,44,35,0.94)] text-[#f2d9cd] hover:bg-[rgba(78,52,41,0.98)]"
              : "border-[rgba(255,255,255,0.08)] bg-[#272220] text-[#f3ead8] hover:bg-[#312926]",
            triggerClassName,
          )}
        >
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[rgba(255,255,255,0.55)] sm:h-2.5 sm:w-2.5" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          collisionPadding={8}
          sideOffset={6}
          className={cn(
            "z-50 max-h-[70vh] w-[calc(100vw-1rem)] max-w-[22rem] overflow-y-auto rounded-[12px] border border-[rgba(255,255,255,0.08)] bg-[#1c1a19] p-2 shadow-[0_18px_50px_rgba(0,0,0,0.45)] sm:max-h-[22rem] sm:w-auto sm:min-w-[200px] sm:max-w-[26rem] sm:rounded-[10px] sm:p-1.5",
            contentClassName,
          )}
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

type DispatcherPreferenceChipsProps = {
  agent: string;
  agentOptions: readonly string[];
  agentLabel: string;
  modelSelection: ModelSelectionState;
  modelAccess: ModelAccessPreferences;
  runtimeModelCatalogs: Record<string, RuntimeAgentModelCatalog>;
  disabled?: boolean;
  className?: string;
  onAgentChange: (next: string) => void;
  onModelSelectionChange: (next: ModelSelectionState) => void;
};

export function DispatcherPreferenceChips({
  agent,
  agentOptions,
  agentLabel,
  modelSelection,
  modelAccess,
  runtimeModelCatalogs,
  disabled = false,
  className,
  onAgentChange,
  onModelSelectionChange,
}: DispatcherPreferenceChipsProps) {
  const availableModels = getSelectableAgentModels(
    agent,
    modelAccess,
    runtimeModelCatalogs,
  );
  const resolvedModel = resolveModelSelectionValue(modelSelection) ?? modelSelection.catalogModel;
  const modelLabel = resolvedModel
    ? formatCurrentModelLabel(agent, resolvedModel)
    : "Change model";
  const availableReasoningOptions = getSelectableAgentReasoningOptions(
    agent,
    modelAccess,
    runtimeModelCatalogs,
    resolvedModel,
  );
  const showModelControls = availableModels.length > 0;
  const reasoningValue = modelSelection.reasoningEffort.trim().toLowerCase();

  return (
    <div className={cn("grid w-full grid-cols-[repeat(auto-fit,minmax(7.25rem,1fr))] gap-1.5 sm:flex sm:flex-wrap sm:items-center", className)}>
      <div className="min-w-0 sm:flex-none">
        <PreferenceChip
          label={<AgentLabel agent={agent} />}
          title={`Change ${agentLabel.toLowerCase()} (${getKnownAgent(agent)?.label ?? agent})`}
          disabled={disabled}
          triggerClassName="w-full justify-between sm:h-[27px] sm:w-auto sm:justify-start sm:max-w-[6.75rem]"
        >
          <div className="px-3 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-[rgba(255,255,255,0.58)]">
            {agentLabel}
          </div>
          {agentOptions.map((option) => {
            const known = getKnownAgent(option);
            const selected = agent === option;
            return (
              <DropdownMenu.Item
                key={option}
                onSelect={() => onAgentChange(option)}
                className="flex min-h-[40px] cursor-default items-center gap-2.5 rounded-[8px] px-3 py-2 text-[13px] text-[#f3efea] outline-none transition hover:bg-[rgba(255,255,255,0.06)] focus:bg-[rgba(255,255,255,0.06)] sm:min-h-[34px] sm:rounded-[7px] sm:px-2 sm:py-1.5 sm:text-[12px]"
              >
                <AgentTileIcon
                  seed={{ label: option }}
                  className="h-4 w-4 border-none bg-transparent sm:h-3.5 sm:w-3.5"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium sm:text-[12.5px]">{known?.label ?? option}</p>
                  <p className="truncate text-[11px] text-[rgba(255,255,255,0.58)] sm:text-[10.5px]">
                    {known?.description ?? agentLabel}
                  </p>
                </div>
                {selected ? <Check className="h-4 w-4 text-[#f2d9cd] sm:h-3.5 sm:w-3.5" /> : null}
              </DropdownMenu.Item>
            );
          })}
        </PreferenceChip>
      </div>

      {showModelControls ? (
        <div className="min-w-0 sm:flex-none">
          <PreferenceChip
            label={modelLabel}
            title={`Change model${resolvedModel ? ` (${modelLabel})` : ""}`}
            disabled={disabled}
            triggerClassName="w-full justify-between sm:h-[27px] sm:w-auto sm:justify-start sm:max-w-[11.75rem]"
            contentClassName="sm:min-w-[220px]"
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
                      agent,
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
                          agent,
                          modelAccess,
                          runtimeModelCatalogs,
                          model.id,
                        ),
                    });
                  }}
                  className="flex min-h-[40px] cursor-default items-center gap-2.5 rounded-[8px] px-3 py-2 text-[13px] text-[#f3efea] outline-none transition hover:bg-[rgba(255,255,255,0.06)] focus:bg-[rgba(255,255,255,0.06)] sm:min-h-[34px] sm:rounded-[7px] sm:px-2 sm:py-1.5 sm:text-[12px]"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium sm:text-[12px]">{model.label}</p>
                    <p className="truncate text-[11px] text-[rgba(255,255,255,0.58)] sm:text-[10.5px]">
                      {model.description}
                    </p>
                  </div>
                  {selected ? <Check className="h-4 w-4 text-[#f2d9cd] sm:h-3.5 sm:w-3.5" /> : null}
                </DropdownMenu.Item>
              );
            })}
          </PreferenceChip>
        </div>
      ) : null}

      {showModelControls && availableReasoningOptions.length > 0 ? (
        <div className="min-w-0 sm:flex-none">
          <PreferenceChip
            label={(
              <span className="flex items-center gap-1.5">
                <Brain className="h-3.5 w-3.5 text-[#d7b6a5] sm:h-3 sm:w-3" />
                <span>{formatReasoningLabel(reasoningValue || availableReasoningOptions[0].id)}</span>
              </span>
            )}
            title={`Change thinking level (${formatReasoningLabel(reasoningValue || availableReasoningOptions[0].id)})`}
            disabled={disabled}
            accent
            triggerClassName="w-full justify-between sm:h-[27px] sm:w-auto sm:justify-start sm:max-w-[7rem]"
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
                  className="flex min-h-[40px] cursor-default items-center gap-2.5 rounded-[8px] px-3 py-2 text-[13px] text-[#f3efea] outline-none transition hover:bg-[rgba(255,255,255,0.06)] focus:bg-[rgba(255,255,255,0.06)] sm:min-h-[34px] sm:rounded-[7px] sm:px-2 sm:py-1.5 sm:text-[12px]"
                >
                  <Brain className="h-4 w-4 text-[#d7b6a5] sm:h-3.5 sm:w-3.5" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium sm:text-[12.5px]">{option.label}</p>
                    <p className="truncate text-[11px] text-[rgba(255,255,255,0.58)] sm:text-[10.5px]">
                      {option.description}
                    </p>
                  </div>
                  {selected ? <Check className="h-4 w-4 text-[#f2d9cd] sm:h-3.5 sm:w-3.5" /> : null}
                </DropdownMenu.Item>
              );
            })}
          </PreferenceChip>
        </div>
      ) : null}

    </div>
  );
}
