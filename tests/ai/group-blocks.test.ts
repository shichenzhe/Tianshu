import { describe, expect, it } from "vitest";
import {
  groupBlocks,
  summarizeThinking,
} from "../../src-react/domains/ai/chat/lib/group-blocks";
import type { MessageBlock } from "../../src-react/domains/ai/chat/model/blocks";

describe("groupBlocks 过程/结论分组", () => {
  it("thinking 块按序拼接、tool_call 保序、text 保序、usage 保留在 texts", () => {
    const blocks: MessageBlock[] = [
      { type: "thinking", text: "先想第一步" },
      {
        type: "tool_call",
        toolCallId: "t1",
        toolName: "read_file",
        args: { path: "/tmp/a.md" },
        state: "done",
      },
      { type: "thinking", text: "再想第二步" },
      { type: "text", text: "最终答案" },
      {
        type: "tool_call",
        toolCallId: "t2",
        toolName: "run_command",
        args: { command: "ls" },
        state: "error",
        output: "boom",
      },
      { type: "text", text: "补充说明" },
      { type: "usage", input: 10, output: 20 },
    ];

    const grouped = groupBlocks(blocks);
    expect(grouped.thinkingText).toBe("先想第一步\n\n再想第二步");
    expect(grouped.tools.map((tool) => tool.toolName)).toEqual([
      "read_file",
      "run_command",
    ]);
    expect(grouped.tools[1]).toMatchObject({ state: "error", output: "boom" });
    expect(grouped.texts.map((b) => b.text)).toEqual(["最终答案", "补充说明"]);
    expect(grouped.usage).toMatchObject({ input: 10, output: 20 });
  });

  it("无 thinking/tools 时 thinkingText 为空串、tools 为空数组", () => {
    const grouped = groupBlocks([
      { type: "text", text: "只有正文" },
      { type: "usage", input: 1, output: 2 },
    ]);
    expect(grouped.thinkingText).toBe("");
    expect(grouped.tools).toEqual([]);
    expect(grouped.hasProcess).toBe(false);
  });

  it("含过程块时 hasProcess 为 true", () => {
    expect(groupBlocks([{ type: "thinking", text: "想一想" }]).hasProcess).toBe(
      true,
    );
    expect(
      groupBlocks([
        {
          type: "tool_call",
          toolCallId: "t",
          toolName: "x",
          args: {},
          state: "done",
        },
      ]).hasProcess,
    ).toBe(true);
  });
});

describe("recommend_experts 块分流（会话内专家推荐卡）", () => {
  it("recommend_experts 工具块分流 recommends（不进思考面板工具组）", () => {
    const grouped = groupBlocks([
      {
        type: "tool_call",
        toolCallId: "t1",
        toolName: "recommend_experts",
        args: { candidates: ["translator"], reason: "翻译任务" },
        state: "done",
      },
      {
        type: "tool_call",
        toolCallId: "t2",
        toolName: "read_file",
        args: { path: "/x" },
        state: "done",
      },
    ] as never);
    expect(grouped.recommends).toHaveLength(1);
    expect(grouped.recommends[0]).toMatchObject({
      reason: "翻译任务",
      slugs: ["translator"],
      state: "done",
    });
    expect(grouped.tools.map((t) => t.toolName)).toEqual(["read_file"]);
  });
});

describe("summarizeThinking 折叠摘要", () => {
  it("短文本原样返回", () => {
    expect(summarizeThinking("我来梳理一下思路。")).toBe("我来梳理一下思路。");
  });

  it("按首个句末标点截断(。!?英文句号)", () => {
    const text =
      "我先看看资料库里的文件。接下来读取配置并逐项核对每一条细节内容";
    expect(summarizeThinking(text)).toBe("我先看看资料库里的文件。");
  });

  it("无句读长文本硬截 96 字符加省略号", () => {
    const text = "字".repeat(200);
    const summary = summarizeThinking(text);
    expect(summary).toHaveLength(97); // 96 字符 + …
    expect(summary.endsWith("…")).toBe(true);
  });
});

describe("show_widget 块分流（聊天面板可视化组件）", () => {
  const widgetBlock = {
    type: "tool_call",
    toolCallId: "tc-1",
    toolName: "show_widget",
    args: { title: "销量图", widget_code: "<b>chart</b>" },
    state: "done",
  } as never;

  it("show_widget 工具块分流到 widgets（不进思考面板工具组）", () => {
    const grouped = groupBlocks([
      { type: "thinking", text: "想想" } as never,
      widgetBlock,
      { type: "text", text: "结论" } as never,
    ]);
    expect(grouped.widgets).toHaveLength(1);
    expect(grouped.widgets[0].code).toBe("<b>chart</b>");
    expect(grouped.widgets[0].title).toBe("销量图");
    expect(grouped.tools).toHaveLength(0);
    // hasProcess 含 widget（面板门槛不受影响——无其它过程块时也可无面板）
    expect(grouped.hasProcess).toBe(true);
  });

  it("普通工具块仍进 tools；show_widget 不混入", () => {
    const grouped = groupBlocks([
      widgetBlock,
      {
        type: "tool_call",
        toolCallId: "tc-2",
        toolName: "read_file",
        args: {},
        state: "done",
      } as never,
    ]);
    expect(grouped.tools.map((t) => t.toolName)).toEqual(["read_file"]);
    expect(grouped.widgets).toHaveLength(1);
  });
});

describe("show_table 块分流（消息流数据表格卡）", () => {
  const tableBlock = {
    type: "tool_call",
    toolCallId: "tc-t1",
    toolName: "show_table",
    args: {
      title: "支出明细",
      columns: [
        { key: "amount", label: "金额" },
        { key: "note", label: "备注" },
      ],
      rows: [
        { amount: 35, note: "午饭" },
        { amount: 12.5, note: null },
      ],
    },
    state: "done",
  } as never;

  it("show_table 工具块分流到 tables（不进思考面板工具组）", () => {
    const grouped = groupBlocks([
      tableBlock,
      { type: "text", text: "结论" } as never,
    ]);
    expect(grouped.tables).toHaveLength(1);
    expect(grouped.tables[0].title).toBe("支出明细");
    expect(grouped.tables[0].columns).toHaveLength(2);
    expect(grouped.tables[0].rows[1]).toMatchObject({ amount: 12.5 });
    expect(grouped.tools).toHaveLength(0);
    expect(grouped.hasProcess).toBe(true);
  });

  it("args 渐进/缺失（columns/rows 非数组）退空结构，不炸分流", () => {
    const grouped = groupBlocks([
      {
        type: "tool_call",
        toolCallId: "tc-t2",
        toolName: "show_table",
        args: { columns: "半截", rows: null },
        state: "running",
      } as never,
    ]);
    expect(grouped.tables).toHaveLength(1);
    expect(grouped.tables[0].columns).toEqual([]);
    expect(grouped.tables[0].rows).toEqual([]);
    expect(grouped.tables[0].state).toBe("running");
  });
});

describe("show_summary 块分流（消息流摘要指标卡）", () => {
  it("show_summary 工具块分流到 summaries（不进思考面板工具组）", () => {
    const grouped = groupBlocks([
      {
        type: "tool_call",
        toolCallId: "tc-s1",
        toolName: "show_summary",
        args: {
          title: "月度汇总",
          items: [
            { label: "总支出", value: "¥123.5", hint: "含退款" },
            { label: "笔数", value: 12 },
          ],
        },
        state: "done",
      } as never,
      {
        type: "tool_call",
        toolCallId: "tc-s2",
        toolName: "read_file",
        args: {},
        state: "done",
      } as never,
    ]);
    expect(grouped.summaries).toHaveLength(1);
    expect(grouped.summaries[0].items[0]).toMatchObject({
      label: "总支出",
      hint: "含退款",
    });
    expect(grouped.tools.map((t) => t.toolName)).toEqual(["read_file"]);
    expect(grouped.hasProcess).toBe(true);
  });

  it("args 渐进（items 非数组）退空结构", () => {
    const grouped = groupBlocks([
      {
        type: "tool_call",
        toolCallId: "tc-s3",
        toolName: "show_summary",
        args: {},
        state: "running",
      } as never,
    ]);
    expect(grouped.summaries).toHaveLength(1);
    expect(grouped.summaries[0].items).toEqual([]);
  });
});
