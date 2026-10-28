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

  it("tool_call 块 → AIMessage.tool_calls + ToolMessage（T3-3 LangChain 回喂形态）", async () => {
    const messages = await blocksToModelMessages([
      { type: "text", text: "我先看看" },
      {
        type: "tool_call",
        toolCallId: "t1",
        toolName: "read_file",
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
        name: "read_file",
        args: { path: "a.txt" },
        type: "tool_call",
      },
    ]);
    expect(messages[1]).toBeInstanceOf(ToolMessage);
    expect(messages[1]).toMatchObject({
      tool_call_id: "t1",
      name: "read_file",
      content: "内容",
    });
  });
});
