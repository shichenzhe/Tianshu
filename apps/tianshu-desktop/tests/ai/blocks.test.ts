import { describe, expect, it } from "vitest";
import {
  blocksToModelMessages,
  parseBlocks as parseBlocksMain,
  serializeBlocks as serializeBlocksMain,
} from "../../electron/domains/ai/chat/blocks";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import {
  parseBlocks as parseBlocksRenderer,
  serializeBlocks as serializeBlocksRenderer,
} from "../../src-react/domains/ai/chat/model/blocks";

/**
 * 主进程与渲染进程各有一份同构实现（渲染端不 import 主进程代码），
 * 同一组断言跑两份实现，钉死二者防漂移
 */
const IMPLS = [
  {
    name: "electron/domains/ai/chat/blocks",
    parseBlocks: parseBlocksMain,
    serializeBlocks: serializeBlocksMain,
  },
  {
    name: "src-react/domains/ai/chat/model/blocks",
    parseBlocks: parseBlocksRenderer,
    serializeBlocks: serializeBlocksRenderer,
  },
] as const;

describe.each(IMPLS)(
  "blocks 序列化（$name）",
  ({ parseBlocks, serializeBlocks }) => {
    it("往返一致", () => {
      const blocks = [
        { type: "text", text: "你好" },
        { type: "thinking", text: "思考中" },
        { type: "usage", input: 10, output: 20 },
      ];
      expect(parseBlocks(serializeBlocks(blocks))).toEqual(blocks);
    });

    it("畸形 JSON 返回空数组", () => {
      expect(parseBlocks("{not json")).toEqual([]);
    });

    it("非数组 JSON 返回空数组", () => {
      expect(parseBlocks('{"a":1}')).toEqual([]);
    });

    it("数组中混入非对象项被过滤", () => {
      const json = JSON.stringify([{ type: "text", text: "ok" }, 42, null]);
      expect(parseBlocks(json)).toEqual([{ type: "text", text: "ok" }]);
    });

    it("text 块缺 text 字段被过滤", () => {
      expect(parseBlocks('[{"type":"text"}]')).toEqual([]);
    });

    it("text 块 text 非字符串被过滤", () => {
      expect(parseBlocks('[{"type":"text","text":123}]')).toEqual([]);
    });

    it("usage 块缺 output 被过滤", () => {
      expect(parseBlocks('[{"type":"usage","input":1}]')).toEqual([]);
    });

    it("image 块往返一致", () => {
      const blocks = [
        {
          type: "image",
          imagePath: "attachments/shot.png",
          mime: "image/png",
          name: "shot.png",
        },
      ];
      expect(parseBlocks(serializeBlocks(blocks))).toEqual(blocks);
    });

    it("image 块缺 mime 字段被过滤", () => {
      expect(
        parseBlocks('[{"type":"image","imagePath":"attachments/a.png"}]'),
      ).toEqual([]);
    });

    it("image 块 imagePath 非字符串被过滤", () => {
      expect(
        parseBlocks('[{"type":"image","imagePath":123,"mime":"image/png"}]'),
      ).toEqual([]);
    });

    it("skill_ref 块往返一致（skill_ref 批新块型）", () => {
      const blocks = [{ type: "skill_ref", name: "workflow-creator" }];
      expect(parseBlocks(serializeBlocks(blocks))).toEqual(blocks);
    });

    it("skill_ref 块缺 name / name 非字符串被过滤", () => {
      expect(parseBlocks('[{"type":"skill_ref"}]')).toEqual([]);
      expect(parseBlocks('[{"type":"skill_ref","name":42}]')).toEqual([]);
    });

    it("file_ref 块往返一致（file_ref 批新块型——内容随块）", () => {
      const blocks = [
        { type: "file_ref", path: "docs/需求.md", content: "# 需求\n\n正文" },
      ];
      expect(parseBlocks(serializeBlocks(blocks))).toEqual(blocks);
    });

    it("file_ref 块缺 path/content 或非字符串被过滤", () => {
      expect(parseBlocks('[{"type":"file_ref","content":"x"}]')).toEqual([]);
      expect(
        parseBlocks('[{"type":"file_ref","path":"a.md","content":1}]'),
      ).toEqual([]);
    });

    it("memberReport 块往返一致（专家团可观测性批新块型）", () => {
      const blocks = [
        {
          type: "memberReport",
          memberName: "顾大局",
          task: "看宏观",
          content: "宏观结论",
          round: 1,
        },
      ];
      expect(parseBlocks(serializeBlocks(blocks))).toEqual(blocks);
    });

    it("memberReport 块缺必备字段或类型不符被过滤", () => {
      expect(parseBlocks('[{"type":"memberReport"}]')).toEqual([]);
      expect(
        parseBlocks('[{"type":"memberReport","memberName":"顾大局"}]'),
      ).toEqual([]);
      expect(
        parseBlocks(
          '[{"type":"memberReport","memberName":"顾大局","task":"t","content":"c","round":"1"}]',
        ),
      ).toEqual([]);
    });

    it("混合数组仅保留合法块", () => {
      const json = JSON.stringify([
        { type: "text", text: "ok" },
        { type: "text" },
        { type: "usage", input: 1, output: 2 },
        { type: "tool_call", toolCallId: "t1", toolName: "f" },
        { type: "unknown" },
        42,
      ]);
      expect(parseBlocks(json)).toEqual([
        { type: "text", text: "ok" },
        { type: "usage", input: 1, output: 2 },
        { type: "tool_call", toolCallId: "t1", toolName: "f" },
      ]);
    });
  },
);

describe("blocksToModelMessages image 块转换（主进程实现，LangChain 形态）", () => {
  it("user 消息 image 块经 loader 转 image_url content block 且前置于文本", async () => {
    const messages = await blocksToModelMessages(
      [
        { type: "text", text: "提取内容" },
        { type: "image", imagePath: "attachments/a.png", mime: "image/png" },
      ],
      "user",
      async (imagePath) => `data:image/png;base64,${imagePath}`,
    );
    // image_url 为 LangChain 标准多模态形态（url 承载完整 dataUrl）；
    // 图片前置于文本（Qwen-VL 系列惯例：视觉输入在指令前）
    expect(messages).toHaveLength(1);
    expect(messages[0]).toBeInstanceOf(HumanMessage);
    expect(messages[0]?.content).toEqual([
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,attachments/a.png" },
      },
      { type: "text", text: "提取内容" },
    ]);
  });

  it("多图保持相对序（依次前置不逆序）", async () => {
    const messages = await blocksToModelMessages(
      [
        { type: "text", text: "对比这两张" },
        { type: "image", imagePath: "attachments/a.png", mime: "image/png" },
        { type: "image", imagePath: "attachments/b.png", mime: "image/png" },
      ],
      "user",
      async (imagePath) => `data:image/png;base64,${imagePath}`,
    );
    const content = messages[0]?.content;
    if (!Array.isArray(content)) {
      throw new Error("content 应为 parts 数组");
    }
    expect(content.map((part) => (part as { type: string }).type)).toEqual([
      "image_url",
      "image_url",
      "text",
    ]);
    expect(
      content
        .filter((part) => (part as { type: string }).type === "image_url")
        .map((part) => (part as { image_url: { url: string } }).image_url.url),
    ).toEqual([
      "data:image/png;base64,attachments/a.png",
      "data:image/png;base64,attachments/b.png",
    ]);
  });

  it("loader 返回 null（文件缺失）降级为占位文本", async () => {
    const messages = await blocksToModelMessages(
      [
        { type: "text", text: "看图" },
        {
          type: "image",
          imagePath: "attachments/gone.png",
          mime: "image/png",
          name: "gone.png",
        },
      ],
      "user",
      async () => null,
    );
    // 降级占位同为 text part，纯文本消息归并为字符串（既有 flush 语义）
    expect(messages).toHaveLength(1);
    expect(messages[0]).toBeInstanceOf(HumanMessage);
    expect(messages[0]?.content).toBe("看图\n[图片 gone.png 已失效]");
  });

  it("无 loader 时 image 块降级为占位文本（旧调用方行为兼容）", async () => {
    const messages = await blocksToModelMessages(
      [{ type: "image", imagePath: "attachments/a.png", mime: "image/png" }],
      "user",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toBeInstanceOf(HumanMessage);
    expect(messages[0]?.content).toBe("[图片 attachments/a.png 已失效]");
  });

  it("assistant 消息中的 image 块降级为占位（assistant content 不支持图片 block）", async () => {
    const messages = await blocksToModelMessages(
      [{ type: "image", imagePath: "attachments/a.png", mime: "image/png" }],
      "assistant",
      async () => "data:image/png;base64,xxx",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toBeInstanceOf(AIMessage);
    expect(messages[0]?.content).toBe("[图片 attachments/a.png 已失效]");
  });

  it("skill_ref 块经 loadSkill 展开为旧注入前缀口径（[引用技能 name]\\n全文，前置正文）", async () => {
    const messages = await blocksToModelMessages(
      [
        { type: "skill_ref", name: "workflow-creator" },
        { type: "text", text: "帮我建个流程" },
      ],
      "user",
      undefined,
      async (name) => (name === "workflow-creator" ? "# 技能全文" : null),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toBeInstanceOf(HumanMessage);
    expect(messages[0]?.content).toContain(
      "[引用技能 workflow-creator]\n# 技能全文",
    );
    expect(messages[0]?.content).toContain("帮我建个流程");
    // 展开段前置于正文（引用块前置语义）
    expect((messages[0]?.content as string).indexOf("[引用技能")).toBeLessThan(
      (messages[0]?.content as string).indexOf("帮我建个流程"),
    );
  });

  it("skill_ref 读不到（null/抛错）与 loader 缺席都降级行，不阻断流", async () => {
    const messages = await blocksToModelMessages(
      [
        { type: "skill_ref", name: "gone" },
        { type: "skill_ref", name: "boom" },
      ],
      "user",
      undefined,
      async (name) => (name === "boom" ? Promise.reject(new Error("io")) : null),
    );
    expect(messages[0]?.content).toBe(
      "[引用技能 gone]（内容读取失败）\n[引用技能 boom]（内容读取失败）",
    );

    const noLoader = await blocksToModelMessages(
      [{ type: "skill_ref", name: "any" }],
      "user",
    );
    expect(noLoader[0]?.content).toBe("[引用技能 any]（内容读取失败）");
  });

  it("file_ref 块展开为旧注入前缀口径（内容随块直取，含空行内容完整保留）", async () => {
    const messages = await blocksToModelMessages(
      [
        {
          type: "file_ref",
          path: "docs/需求.md",
          content: "# 需求\n\n第一段\n\n第二段",
        },
        { type: "text", text: "按这个改" },
      ],
      "user",
    );
    expect(messages[0]).toBeInstanceOf(HumanMessage);
    const content = messages[0]?.content as string;
    // 前缀口径逐字同旧注入；块内空行完整保留（泄漏根治点：内容不再
    // 进 text，渲染层无从拆错）
    expect(content).toContain("[引用文件 docs/需求.md]\n# 需求\n\n第一段");
    expect(content.indexOf("[引用文件")).toBeLessThan(
      content.indexOf("按这个改"),
    );
    // assistant 侧同展开（内容随块无读失败面，无 user 限定必要）
    const assistant = await blocksToModelMessages(
      [{ type: "file_ref", path: "a.txt", content: "x" }],
      "assistant",
    );
    expect(assistant[0]?.content).toBe("[引用文件 a.txt]\nx");
  });

  it("tool_call 块 → AIMessage.tool_calls + ToolMessage（T3-3 LangChain 回喂形态）", async () => {
    const messages = await blocksToModelMessages([
      { type: "text", text: "我先看看" },
      {
        type: "tool_call",
        toolCallId: "t1",
        toolName: "read",
        args: { path: "a.txt" },
        state: "done",
        output: "内容",
      },
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBeInstanceOf(AIMessage);
    expect(messages[0]?.content).toBe("我先看看");
    expect(
      (messages[0] as unknown as { tool_calls?: unknown[] }).tool_calls,
    ).toEqual([
      {
        id: "t1",
        name: "read",
        args: { path: "a.txt" },
        type: "tool_call",
      },
    ]);
    expect(messages[1]).toBeInstanceOf(ToolMessage);
    expect(messages[1]).toMatchObject({
      tool_call_id: "t1",
      name: "read",
      content: "内容",
    });
  });

  it("memberReport 块不回喂模型（dispatch tool_call 的 output 已携带同文，防双份）", async () => {
    const messages = await blocksToModelMessages([
      { type: "memberReport", memberName: "顾大局", task: "t", content: "成员结论", round: 1 },
      { type: "text", text: "最终回答" },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("最终回答");
  });
});
