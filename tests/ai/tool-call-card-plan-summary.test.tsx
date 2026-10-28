// @vitest-environment jsdom
/**
 * ToolCallCard plan_* 富化摘要行渲染测试（三期批 11 D15；骨架同
 * tool-call-card-default-open.test.tsx；测试环境 i18n 已初始化为 zh-CN，
 * 断言真实译文与插值——含 statusKey 嵌套翻译链路）：
 * - 四工具解析成功 → 头部出现 chat:tool.plan.* 摘要（替代路径摘要段）
 * - plan_list_items 失败输出「错误: ...」→ 无摘要（回退现有形态）
 * - error 态不渲染摘要（动作未发生，摘要会误导）
 * - 非 plan 工具路径摘要段不受影响
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import ToolCallCard from "../../src-react/domains/ai/chat/components/ToolCallCard";

function renderCard(props: {
  toolName: string;
  args?: unknown;
  state?: string;
  output?: string;
}) {
  const { container } = render(
    <ToolCallCard
      toolName={props.toolName}
      args={props.args}
      state={props.state ?? "done"}
      output={props.output}
    />,
  );
  return container.querySelector("details") as HTMLDetailsElement;
}

describe("ToolCallCard plan_* 富化摘要（批 11 D15）", () => {
  it("plan_create_item：头部渲染新建任务摘要（运行中即可，无输出）", () => {
    const details = renderCard({
      toolName: "plan_create_item",
      args: { title: "调研竞品" },
      state: "running",
    });
    expect(details.querySelector("summary")?.textContent).toContain(
      "新建任务: 调研竞品",
    );
  });

  it("plan_update_status：头部渲染状态流转摘要", () => {
    const details = renderCard({
      toolName: "plan_update_status",
      args: { id: 3, status: "done" },
    });
    // statusKey 先译再插值（t 不做嵌套翻译）：#3 → 已完成
    expect(details.querySelector("summary")?.textContent).toContain(
      "流转状态: #3 → 已完成",
    );
  });

  it("plan_list_items：成功输出渲染计数摘要；失败输出回退（无摘要段）", () => {
    const ok = renderCard({
      toolName: "plan_list_items",
      args: {},
      output: "当前项目计划清单（共 3 项）：\n#1《a》",
    });
    expect(ok.querySelector("summary")?.textContent).toContain("列出任务 3 项");

    const failed = renderCard({
      toolName: "plan_list_items",
      args: {},
      output: "错误: 当前会话未关联项目",
    });
    expect(failed.querySelector("summary")?.textContent).not.toContain(
      "列出任务",
    );
  });

  it("error 态不渲染摘要（动作未发生）；denied 同口径", () => {
    for (const state of ["error", "denied"]) {
      const details = renderCard({
        toolName: "plan_create_item",
        args: { title: "调研竞品" },
        state,
      });
      expect(details.querySelector("summary")?.textContent).not.toContain(
        "新建任务",
      );
    }
  });

  it("非 plan 工具：路径摘要段不受影响", () => {
    const details = renderCard({
      toolName: "write_file",
      args: { path: "src/a.ts" },
    });
    const summary = details.querySelector("summary")?.textContent ?? "";
    expect(summary).toContain("→ src/a.ts");
    expect(summary).not.toContain("新建任务");
  });
});
