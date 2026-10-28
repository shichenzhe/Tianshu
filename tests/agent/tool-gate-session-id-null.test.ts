import { describe, expect, it } from "vitest";
import type { AgentStreamOptions } from "../../electron/domains/ai/agent/tool-gate";

describe("AgentStreamOptions.sessionId 可空", () => {
  it("sessionId: null 满足类型（图执行传 null 编译通过）", () => {
    const opts = {
      sessionId: null,
      workspacePath: undefined,
      projectId: null,
      fullAccess: () => false,
      isToolAllowed: async () => false,
      requestApproval: async () => false,
    } as AgentStreamOptions;
    expect(opts.sessionId).toBeNull();
  });
});
