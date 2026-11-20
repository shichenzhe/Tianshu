import { describe, expect, it } from "vitest";
import type { RunGroupRecord } from "@tianshu/protocol";
import type { SessionRecord } from "../../src-react/domains/ai/api/session.api";
import {
  canonicalRunSessionPath,
  runSessionPath,
} from "../../src-react/domains/ai/automation/lib/run-session-route";
import {
  excludeRunSessions,
  sortRunGroups,
} from "../../src-react/domains/ai/automation/lib/run-group-view";
import {
  LOCAL_HOST_CAPS,
  capsOfCapabilities,
} from "../../src-react/domains/ai/data-source/host.store";

function session(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    id: 1,
    workspaceId: 2,
    title: "session",
    mode: "agent",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...overrides,
  };
}

function group(overrides: Partial<RunGroupRecord>): RunGroupRecord {
  return {
    kind: "task",
    ownerId: 1,
    name: "task",
    hasRuns: false,
    ...overrides,
  };
}

describe("run session canonical routes", () => {
  it("builds the exact task and graph URLs with an optional run", () => {
    expect(runSessionPath({ kind: "task", ownerId: 4 }, 9)).toBe(
      "/module/ai?automation=4&run=9",
    );
    expect(runSessionPath({ kind: "graph", ownerId: 3 })).toBe(
      "/module/ai?graphRun=3",
    );
    expect(runSessionPath({ kind: "graph", ownerId: 3 }, 8)).toBe(
      "/module/ai?graphRun=3&run=8",
    );
  });

  it("canonicalizes owned sessions and leaves ordinary sessions unchanged", () => {
    expect(
      canonicalRunSessionPath(
        session({ automationTaskId: 4, automationRunId: 9 }),
      ),
    ).toBe("/module/ai?automation=4&run=9");
    expect(
      canonicalRunSessionPath(session({ runGraphId: 3, automationRunId: 8 })),
    ).toBe("/module/ai?graphRun=3&run=8");
    expect(
      canonicalRunSessionPath(
        session({ automationTaskId: 4, runGraphId: 3, automationRunId: 9 }),
      ),
    ).toBe("/module/ai?automation=4&run=9");
    expect(canonicalRunSessionPath(session({}))).toBeNull();
  });
});

describe("run group view", () => {
  it("sorts latest runs first while preserving the backend order of empty tasks", () => {
    const emptyOld = group({ ownerId: 1, name: "empty-old" });
    const emptyNew = group({ ownerId: 2, name: "empty-new" });
    const older = group({
      ownerId: 3,
      name: "older",
      hasRuns: true,
      latestRun: {
        id: 3,
        taskId: 3,
        taskName: "older",
        attempt: 1,
        triggerType: "schedule",
        status: "success",
        startedAt: "2026-11-02T00:00:00.000Z",
      },
    });
    const newer = group({
      kind: "graph",
      ownerId: 4,
      name: "newer",
      hasRuns: true,
      latestRun: {
        id: 4,
        taskId: null,
        graphId: 4,
        taskName: "newer",
        attempt: 1,
        triggerType: "manual",
        status: "failed",
        startedAt: "2026-11-03T00:00:00.000Z",
      },
    });

    expect(
      sortRunGroups([emptyOld, older, emptyNew, newer]).map(
        (item) => item.name,
      ),
    ).toEqual(["newer", "older", "empty-old", "empty-new"]);
  });

  it("removes every run-owned session from ordinary and archived lists", () => {
    const ordinary = session({ id: 1 });
    const taskRun = session({ id: 2, automationTaskId: 4 });
    const graphRun = session({ id: 3, runGraphId: 5 });
    expect(excludeRunSessions([ordinary, taskRun, graphRun])).toEqual([
      ordinary,
    ]);
  });
});

describe("run session host capability", () => {
  it("is local by default and remote only when explicitly reported", () => {
    expect(LOCAL_HOST_CAPS.runSessions).toBe(true);
    expect(capsOfCapabilities(["chat", "graph"]).runSessions).toBe(false);
    expect(capsOfCapabilities(["graph", "runSessions"]).runSessions).toBe(true);
  });
});
