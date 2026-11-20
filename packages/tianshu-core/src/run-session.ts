import type { AutomationRunStatus } from "@tianshu/protocol";

export interface RunOwner {
  kind: "task" | "graph";
  ownerId: number;
}

export function runOwnerOf(run: {
  taskId: number | null;
  graphId?: number;
}): RunOwner | null {
  if (run.taskId !== null) {
    return { kind: "task", ownerId: run.taskId };
  }
  if (run.graphId !== undefined) {
    return { kind: "graph", ownerId: run.graphId };
  }
  return null;
}

export function canFollowUpRun(status: AutomationRunStatus): boolean {
  return status === "success" || status === "failed";
}
