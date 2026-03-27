export type BoardTaskLaunchPayload = {
  id: string;
  issueId: string;
  title: string;
  description: string;
  notes?: string | null;
  agent?: string | null;
  linkedSessionId?: string | null;
  linkedSessionLabel?: string | null;
  acceptanceCriteria?: string[];
};

export function buildBoardTaskPlanningPrompt(task: BoardTaskLaunchPayload): string {
  const parts: string[] = [
    `You are helping plan and execute the board task: ${task.title}`,
    "",
    `Task link: ${task.issueId}`,
    "",
    "Task description:",
    task.description?.trim() || "No description provided.",
  ];

  if (task.notes?.trim()) {
    parts.push("", "Board notes:", task.notes.trim());
  }

  if (task.acceptanceCriteria && task.acceptanceCriteria.length > 0) {
    parts.push("", "Acceptance criteria:");
    for (const item of task.acceptanceCriteria) {
      parts.push(`- ${item}`);
    }
  }

  parts.push(
    "",
    "Please do the following:",
    "1. Break this work into concrete implementation steps.",
    "2. Call out blockers or missing context.",
    "3. Suggest the best next execution move for this task.",
    "4. When asked to continue, keep working against this same board task context.",
  );

  return parts.join("\n");
}
