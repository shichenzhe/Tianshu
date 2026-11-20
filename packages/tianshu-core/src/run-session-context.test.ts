import { describe, expect, it } from "vitest";
import type { AutomationRunDetail } from "@tianshu/protocol";
import { buildRunFollowupContext } from "./run-session-context";

function makeRun(
  overrides: Partial<AutomationRunDetail> = {},
): AutomationRunDetail {
  return {
    id: 41,
    taskId: null,
    taskName: "daily-graph",
    graphId: 7,
    workspaceId: 3,
    attempt: 1,
    triggerType: "manual",
    status: "failed",
    error: "run-level-error",
    startedAt: "2026-11-20T01:02:03.000Z",
    finishedAt: "2026-11-20T01:02:04.000Z",
    ...overrides,
  };
}

describe("buildRunFollowupContext", () => {
  it("bounds large graph traces while preserving final output and failed nodes", () => {
    const graphTrace = JSON.stringify([
      ...Array.from({ length: 100 }, (_, index) => ({
        id: `node-${index}`,
        name: `Node ${index}`,
        status: "success",
        outputPreview: "x".repeat(500),
      })),
      {
        id: "failed-node",
        name: "Failed node",
        status: "failed",
        error: {
          code: "http_failed",
          message: "request failed",
          detail: "stack",
        },
      },
      {
        id: "final-node",
        name: "Final node",
        status: "success",
        outputPreview: "final-output",
      },
    ]);

    const context = buildRunFollowupContext(makeRun({ graphTrace }));

    expect(context.length).toBeLessThanOrEqual(16000);
    expect(context).toContain("final-output");
    expect(context).toContain("failed-node");
    expect(context).toContain("run-level-error");
  });

  it("retains bounded metadata, final output, and failure details when essentials overflow", () => {
    const graphTrace = JSON.stringify([
      {
        id: "failed-node",
        status: "failed",
        error: {
          code: "failed-code",
          message: "failed-message",
          detail: `failure-detail-${"d".repeat(20000)}`,
        },
      },
      {
        id: "final-node",
        status: "success",
        outputPreview: `final-output-${"o".repeat(12000)}`,
      },
    ]);

    const context = buildRunFollowupContext(
      makeRun({
        taskName: `essential-name-${"n".repeat(12000)}`,
        error: `essential-error-${"e".repeat(12000)}`,
        graphTrace,
      }),
    );

    expect(context.length).toBeLessThanOrEqual(16000);
    expect(context).toContain("essential-name");
    expect(context).toContain("essential-error");
    expect(context).toContain("final-output");
    expect(context).toContain("failed-node");
    expect(context).toContain("failure-detail");
  });

  it("does not throw for malformed JSON or incomplete trace entries", () => {
    expect(() =>
      buildRunFollowupContext(makeRun({ graphTrace: "not-json" })),
    ).not.toThrow();
    const context = buildRunFollowupContext(
      makeRun({ graphTrace: JSON.stringify([null, {}, { id: 9 }]) }),
    );

    expect(context).toContain("daily-graph");
    expect(context).toContain("run-level-error");
  });

  it("keeps prompt runs to run metadata and errors without graph message sections", () => {
    const context = buildRunFollowupContext(
      makeRun({
        taskId: 5,
        taskName: "prompt-task",
        graphId: undefined,
        graphTrace: undefined,
        status: "failed",
        error: "early-prompt-error",
      }),
    );

    expect(context).toContain("prompt-task");
    expect(context).toContain("early-prompt-error");
    expect(context).not.toContain("final-output");
    expect(context).not.toContain("failed-node");
  });

  it("honours a smaller explicit character bound", () => {
    const context = buildRunFollowupContext(makeRun(), 120);

    expect(context.length).toBeLessThanOrEqual(120);
  });
});
