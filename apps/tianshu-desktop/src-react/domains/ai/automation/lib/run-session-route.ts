import type { RunOwner } from "@tianshu/core/run-session";
import type { SessionRecord } from "../../api/session.api";

/** Fixed-entry deep links shared by the sidebar, search, and run history. */
export function runSessionPath(owner: RunOwner, runId?: number): string {
  const key = owner.kind === "task" ? "automation" : "graphRun";
  const run = runId === undefined ? "" : `&run=${runId}`;
  return `/module/ai?${key}=${owner.ownerId}${run}`;
}

export function canonicalRunSessionPath(session: SessionRecord): string | null {
  if (session.automationTaskId != null) {
    return runSessionPath(
      { kind: "task", ownerId: session.automationTaskId },
      session.automationRunId,
    );
  }
  if (session.runGraphId != null) {
    return runSessionPath(
      { kind: "graph", ownerId: session.runGraphId },
      session.automationRunId,
    );
  }
  return null;
}
