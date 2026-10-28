/** 工具分组场景门控（spec §20 项 B）：核心组窄常驻、工作流/专家组
 * 按需挂载的纯函数单测（先例 disabled-tools.test.ts 的
 * filterDisabledTools 直测） */
import { describe, expect, it } from "vitest";
import {
  CORE_TOOL_NAMES,
  EXPERT_GROUP_TOOL_NAMES,
  WORKFLOW_GROUP_TOOL_NAMES,
  filterToolsBySession,
  type ToolGroupGate,
} from "../../electron/domains/ai/agent/tool-groups";

const def = (name: string) => ({ name });

/** 全谱样本：核心组 + 两组门控组 + 照旧组（mcp 前缀、plan 前缀、面板类等） */
const fullSpectrum = () =>
  [
    ...CORE_TOOL_NAMES,
    ...WORKFLOW_GROUP_TOOL_NAMES,
    ...EXPERT_GROUP_TOOL_NAMES,
    "mcp__srv__tool",
    "plan_create_item",
    "show_widget",
    "recommend_experts",
    "dispatch_member",
    "create_automation_task",
  ].map(def);

const names = (defs: Array<{ name: string }>) => defs.map((d) => d.name);

/** 缺省门控：未选场景、未绑专家、workflow-creator 未启用 */
const gate = (o: Partial<ToolGroupGate> = {}): ToolGroupGate => ({
  scenario: null,
  assistantBound: false,
  workflowCreatorEnabled: false,
  ...o,
});

describe("filterToolsBySession（spec §20 项 B）", () => {
  it("核心组恒注入：空门控（daily 未启用技能）下核心 14 件全保留", () => {
    const kept = names(filterToolsBySession(fullSpectrum(), gate()));
    for (const core of CORE_TOOL_NAMES) {
      expect(kept).toContain(core);
    }
  });

  it("automation 场景带工作流组 6 件套", () => {
    const kept = names(
      filterToolsBySession(fullSpectrum(), gate({ scenario: "automation" })),
    );
    expect(kept).toEqual(
      expect.arrayContaining([...WORKFLOW_GROUP_TOOL_NAMES]),
    );
  });

  it("coding 场景带工作流组", () => {
    const kept = names(
      filterToolsBySession(fullSpectrum(), gate({ scenario: "coding" })),
    );
    expect(kept).toContain("create_workflow");
    expect(kept).toContain("get_workflow_run");
  });

  it("daily 场景不带工作流组", () => {
    const kept = names(
      filterToolsBySession(fullSpectrum(), gate({ scenario: "daily" })),
    );
    for (const wf of WORKFLOW_GROUP_TOOL_NAMES) {
      expect(kept).not.toContain(wf);
    }
  });

  it("design 场景/未选场景（null/undefined）均不带工作流组", () => {
    for (const scenario of ["design", null, undefined]) {
      const kept = names(
        filterToolsBySession(fullSpectrum(), gate({ scenario })),
      );
      expect(kept).not.toContain("create_workflow");
    }
  });

  it("workflow-creator 技能启用带工作流组（场景任意，含 daily）", () => {
    const kept = names(
      filterToolsBySession(
        fullSpectrum(),
        gate({ scenario: "daily", workflowCreatorEnabled: true }),
      ),
    );
    expect(kept).toEqual(
      expect.arrayContaining([...WORKFLOW_GROUP_TOOL_NAMES]),
    );
  });

  it("assistantId 绑定带专家组", () => {
    const kept = names(
      filterToolsBySession(fullSpectrum(), gate({ assistantBound: true })),
    );
    expect(kept).toContain("create_expert");
    expect(kept).toContain("update_expert");
  });

  it("experts 场景带专家组（未绑专家也挂载，预留场景值）", () => {
    const kept = names(
      filterToolsBySession(fullSpectrum(), gate({ scenario: "experts" })),
    );
    expect(kept).toContain("create_expert");
    expect(kept).toContain("update_expert");
  });

  it("未绑定且非 experts 场景不带专家组", () => {
    const kept = names(
      filterToolsBySession(fullSpectrum(), gate({ scenario: "coding" })),
    );
    expect(kept).not.toContain("create_expert");
    expect(kept).not.toContain("update_expert");
  });

  it("其余工具不受门控：mcp__/plan_*/面板类照旧放行（黑名单式，新工具不误剔）", () => {
    const kept = names(filterToolsBySession(fullSpectrum(), gate()));
    for (const passthrough of [
      "mcp__srv__tool",
      "plan_create_item",
      "show_widget",
      "recommend_experts",
      "dispatch_member",
      "create_automation_task",
    ]) {
      expect(kept).toContain(passthrough);
    }
  });

  it("过滤不改变保留工具的相对次序（注入序稳定）", () => {
    const source = fullSpectrum();
    const kept = filterToolsBySession(
      source,
      gate({ scenario: "coding", assistantBound: true }),
    );
    let cursor = -1;
    for (const d of kept) {
      const idx = source.findIndex((s) => s.name === d.name);
      expect(idx).toBeGreaterThan(cursor);
      cursor = idx;
    }
  });
});
