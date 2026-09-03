import { describe, expect, it } from "vitest";
import { parseBlocks, serializeBlocks } from "../../electron/domains/ai/chat/blocks";

describe("blocks 序列化", () => {
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
});
