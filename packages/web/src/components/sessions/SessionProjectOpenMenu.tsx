"use client";

import { useMemo, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, ExternalLink, Loader2, Settings2 } from "lucide-react";
import { usePreferences } from "@/hooks/usePreferences";

const CODE_EDITOR_ICON_CLASS = "block h-5 w-5 shrink-0 object-contain";

type CodeEditorIconSpec =
  | { kind: "icon"; className: string }
  | { kind: "image"; imageSrc: string; className: string };

const IDE_OPTIONS = [
  { id: "finder", label: "Finder" },
  { id: "cursor", label: "Cursor" },
  { id: "antigravity", label: "Antigravity" },
  { id: "windsurf", label: "Windsurf" },
  { id: "zed", label: "Zed" },
  { id: "xcode", label: "Xcode" },
  { id: "vscode", label: "VS Code" },
  { id: "vscode-insiders", label: "VS Code Insiders" },
  { id: "intellij-idea", label: "IntelliJ IDEA" },
  { id: "custom", label: "Custom" },
];

const CODE_EDITOR_ICON_MAP: Record<string, CodeEditorIconSpec> = {
  finder: { kind: "image", imageSrc: "/icons/ide/finder.svg", className: CODE_EDITOR_ICON_CLASS },
  vscode: { kind: "image", imageSrc: "/icons/ide/vscode-dark.svg", className: CODE_EDITOR_ICON_CLASS },
  "vscode-insiders": { kind: "image", imageSrc: "/icons/ide/vscode-insiders.svg", className: CODE_EDITOR_ICON_CLASS },
  cursor: { kind: "image", imageSrc: "/icons/ide/cursor-dark.svg", className: CODE_EDITOR_ICON_CLASS },
  windsurf: { kind: "image", imageSrc: "/icons/ide/windsurf-dark.svg", className: CODE_EDITOR_ICON_CLASS },
  "intellij-idea": { kind: "image", imageSrc: "/icons/ide/intellij.svg", className: CODE_EDITOR_ICON_CLASS },
  zed: { kind: "image", imageSrc: "/icons/ide/zed-dark.svg", className: CODE_EDITOR_ICON_CLASS },
  xcode: { kind: "image", imageSrc: "/icons/ide/xcode.svg", className: CODE_EDITOR_ICON_CLASS },
  antigravity: { kind: "image", imageSrc: "/icons/ide/antigravity-dark.svg", className: CODE_EDITOR_ICON_CLASS },
  custom: { kind: "icon", className: `${CODE_EDITOR_ICON_CLASS} text-[var(--vk-text-muted)]` },
};

function resolveIdeOption(editorId: string): { id: string; label: string } {
  return IDE_OPTIONS.find((option) => option.id === editorId) ?? { id: editorId, label: editorId };
}

function CodeEditorIcon({ editorId, label }: { editorId: string; label: string }) {
  const iconSpec = CODE_EDITOR_ICON_MAP[editorId];
  if (!iconSpec) {
    return <Settings2 className={`${CODE_EDITOR_ICON_CLASS} text-[var(--vk-text-muted)]`} />;
  }
  if (iconSpec.kind === "icon") {
    return <Settings2 className={iconSpec?.className ?? `${CODE_EDITOR_ICON_CLASS} text-[var(--vk-text-muted)]`} />;
  }
  return <img src={iconSpec.imageSrc} alt={`${label} logo`} className={iconSpec.className} />;
}

interface SessionProjectOpenMenuProps {
  projectId: string | null;
  compact?: boolean;
}

export function SessionProjectOpenMenu({ projectId, compact = false }: SessionProjectOpenMenuProps) {
  const { preferences } = usePreferences();
  const [openingEditorId, setOpeningEditorId] = useState<string | null>(null);
  const resolvedCurrentEditor = useMemo(
    () => resolveIdeOption(preferences?.ide ?? "vscode"),
    [preferences?.ide],
  );

  async function handleOpen(editorId: string) {
    if (!projectId || openingEditorId) return;
    setOpeningEditorId(editorId);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/open`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ide: editorId }),
      });
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(data?.error ?? `Failed to open project (${response.status})`);
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Failed to open project");
    } finally {
      setOpeningEditorId(null);
    }
  }

  const menuClass = "z-50 min-w-[240px] rounded-[8px] border border-[rgba(255,255,255,0.08)] bg-[#1c1a19] p-2 shadow-[0_18px_50px_rgba(0,0,0,0.45)]";
  const menuItemClass = "flex min-h-[44px] cursor-default items-center gap-3 rounded-[6px] px-3 py-2 text-[14px] text-[#f3efea] outline-none transition hover:bg-[rgba(255,255,255,0.06)] focus:bg-[rgba(255,255,255,0.06)]";

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          disabled={!projectId || openingEditorId !== null}
          className={`inline-flex items-center gap-2 rounded-[6px] border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.03)] px-3 text-[13px] text-[var(--vk-text-normal)] transition hover:bg-[rgba(255,255,255,0.06)] disabled:cursor-not-allowed disabled:opacity-60 ${
            compact ? "h-[26px]" : "h-9"
          }`}
          aria-label="Open project in code editor"
          title={projectId ? `Open project in ${resolvedCurrentEditor.label}` : "No project selected"}
        >
          {openingEditorId ? (
            <Loader2 className="h-4 w-4 animate-spin text-[var(--vk-text-muted)]" />
          ) : (
            <ExternalLink className={`text-[var(--vk-text-muted)] ${compact ? "h-3.5 w-3.5" : "h-4 w-4"}`} />
          )}
          {!compact && <span className="hidden font-medium sm:inline">Open</span>}
          <ChevronDown className={`text-[var(--vk-text-muted)] ${compact ? "h-3 w-3" : "h-3.5 w-3.5"}`} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={8} className={menuClass}>
          {IDE_OPTIONS.map((option) => (
            <DropdownMenu.Item
              key={option.id}
              onSelect={() => void handleOpen(option.id)}
              className={menuItemClass}
            >
              <CodeEditorIcon editorId={option.id} label={option.label} />
              <span className="flex-1">{option.label}</span>
              {resolvedCurrentEditor.id === option.id ? (
                <Check className="h-4 w-4 text-[var(--vk-text-muted)]" />
              ) : null}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
