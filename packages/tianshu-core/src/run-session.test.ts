import { describe, expect, it } from "vitest";
import { canFollowUpRun, runOwnerOf } from "./run-session";

describe("runOwnerOf", () => {
  it("prioritizes task ownership when both task and graph ids exist", () => {
    expect(runOwnerOf({ taskId: 7, graphId: 3 })).toEqual({
      kind: "task",
      ownerId: 7
    });
  });

  it("uses graph ownership for a top-level graph run", () => {
    expect(runOwnerOf({ taskId: null, graphId: 3 })).toEqual({
      kind: "graph",
      ownerId: 3
    });
  });

  it("returns null when the run has no owner", () => {
    expect(runOwnerOf({ taskId: null })).toBeNull();
  });
});

describe("canFollowUpRun", () => {
  it.each(["success", "failed"] as const)(
    "allows follow-up for %s",
    (status) => {
      expect(canFollowUpRun(status)).toBe(true);
    }
  );

  it.each(["running", "skipped"] as const)(
    "rejects follow-up for %s",
    (status) => {
      expect(canFollowUpRun(status)).toBe(false);
    }
  );
});
