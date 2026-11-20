import type { RunGroupRecord } from "@tianshu/protocol";
import type { SessionRecord } from "../../api/session.api";

/** Latest activity first; the backend's creation-time order remains stable for empty tasks. */
export function sortRunGroups(groups: RunGroupRecord[]): RunGroupRecord[] {
  return [...groups].sort((left, right) => {
    const leftStartedAt = left.latestRun?.startedAt;
    const rightStartedAt = right.latestRun?.startedAt;
    if (leftStartedAt && rightStartedAt) {
      return rightStartedAt.localeCompare(leftStartedAt);
    }
    if (leftStartedAt) return -1;
    if (rightStartedAt) return 1;
    return 0;
  });
}

export function excludeRunSessions(sessions: SessionRecord[]): SessionRecord[] {
  return sessions.filter(
    (session) => session.automationTaskId == null && session.runGraphId == null,
  );
}
