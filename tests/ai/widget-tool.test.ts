// tests/ai/widget-tool.test.ts
/**
 * show_widget 内置工具（聊天面板可视化组件）：
 * - 参数 schema：widget_code 必填（HTML/JS 代码串）、title 可选
 * - kind=read（渲染层消费 args，无文件/系统副作用，免审批）
 * - execute 返回确认文本回喂模型（不抛出）
 */
import { describe, expect, it } from "vitest";
import {
  makeWidgetTool,
  WIDGET_TOOL_NAME,
} from "../../electron/domains/ai/agent/widget-tool";

describe("show_widget 工具", () => {
  const tool = makeWidgetTool();

  it("命名与 kind：show_widget / read（免审批）", () => {
    expect(tool.name).toBe(WIDGET_TOOL_NAME);
    expect(tool.kind).toBe("read");
  });

  it("参数 schema：widget_code 必填、title 可选（非法载荷拒绝）", () => {
    expect(tool.parameters.safeParse({ widget_code: "<b>x</b>" }).success).toBe(
      true,
    );
    expect(
      tool.parameters.safeParse({ widget_code: "<b>x</b>", title: "图表" })
        .success,
    ).toBe(true);
    expect(tool.parameters.safeParse({ title: "缺代码" }).success).toBe(false);
    expect(tool.parameters.safeParse({ widget_code: "" }).success).toBe(false);
  });

  it("execute 返回确认文本（带标题时含标题），不抛出", async () => {
    const ctx = { workspacePath: "/ws", sessionId: 1 };
    const plain = await tool.execute(ctx, { widget_code: "<b>x</b>" });
    expect(plain).toContain("已渲染");
    const titled = await tool.execute(ctx, {
      widget_code: "<b>x</b>",
      title: "销量图",
    });
    expect(titled).toContain("销量图");
  });
});
