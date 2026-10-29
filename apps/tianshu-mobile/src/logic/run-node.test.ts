import { describe, expect, it } from "vitest";

import {
  parseNodeError,
  parseNodeFallback,
  parseNodeToolCalls,
  runStatusColor,
} from "./run-node";

// 执行详情批：graphRunNode 行内 JSON 序列（errorJson/toolCallsJson/fallbackJson）
// 的 parse 纯函数——服务端逐字段原样透传，畸形/老格式序列防御性回落。

describe("runStatusColor（运行状态展示色，running 占位由渲染层换主题色）", () => {
  it("四态映射", () => {
    expect(runStatusColor("running")).toBe("__primary__");
    expect(runStatusColor("success")).toBe("#34C759");
    expect(runStatusColor("failed")).toBe("#FF3B30");
    expect(runStatusColor("skipped")).toBe("#8E8E93");
  });
});

describe("parseNodeError", () => {
  it("完整错误对象：code/toolName/message/detail", () => {
    expect(
      parseNodeError(
        '{"code":"llm_error","toolName":"read_skill","message":"boom","detail":"d"}',
      ),
    ).toEqual({
      code: "llm_error",
      toolName: "read_skill",
      message: "boom",
      detail: "d",
    });
  });

  it("null/畸形 JSON/非对象 → null（不抛错）", () => {
    expect(parseNodeError(null)).toBeNull();
    expect(parseNodeError("{bad json")).toBeNull();
    expect(parseNodeError('"text"')).toBeNull();
    expect(parseNodeError("42")).toBeNull();
  });
});

describe("parseNodeToolCalls", () => {
  it("摘要数组：name/ok/durationMs 逐行", () => {
    expect(
      parseNodeToolCalls(
        '[{"name":"read_skill","ok":true,"durationMs":120},{"name":"write_file","ok":false,"durationMs":80}]',
      ),
    ).toEqual([
      { name: "read_skill", ok: true, durationMs: 120 },
      { name: "write_file", ok: false, durationMs: 80 },
    ]);
  });

  it("null/畸形/非数组/坏行剔除 → 空数组（不抛错）", () => {
    expect(parseNodeToolCalls(null)).toEqual([]);
    expect(parseNodeToolCalls("{bad")).toEqual([]);
    expect(parseNodeToolCalls('{"a":1}')).toEqual([]);
    expect(
      parseNodeToolCalls('[{"name":"ok","ok":true},{"bad":1},"x"]'),
    ).toEqual([{ name: "ok", ok: true }]);
  });
});

describe("parseNodeFallback", () => {
  it("降级标记 {code,message}", () => {
    expect(parseNodeFallback('{"code":"fallback_model","message":"降级"}')).toEqual(
      { code: "fallback_model", message: "降级" },
    );
  });

  it("null/畸形 → null（不抛错）", () => {
    expect(parseNodeFallback(null)).toBeNull();
    expect(parseNodeFallback("{bad")).toBeNull();
  });
});
