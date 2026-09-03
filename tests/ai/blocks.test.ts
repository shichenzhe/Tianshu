import { describe, expect, it } from "vitest";
import {
  parseBlocks as parseBlocksMain,
  serializeBlocks as serializeBlocksMain,
} from "../../electron/domains/ai/chat/blocks";
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
