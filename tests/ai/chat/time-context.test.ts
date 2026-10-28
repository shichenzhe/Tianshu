import { describe, expect, it } from "vitest";
import {
  formatTimeContext,
  withTimeBlock,
} from "../../../electron/domains/ai/chat/time-context";

/** 2026-09-23 为周三，本地时区 09:05（月参数 0 起：8 = 9 月） */
const NOW = new Date(2026, 8, 23, 9, 5);

describe("formatTimeContext", () => {
  it("本地时区格式：yyyy-MM-dd HH:mm 周X + UTC±HH:mm 尾缀", () => {
    const label = formatTimeContext(NOW);
    expect(label.startsWith("2026-09-23 09:05 周三 ")).toBe(true);
    // 偏移值随测试环境时区而变，断言形态（含半小时偏移国家）
    expect(label).toMatch(/UTC[+-]\d{2}:\d{2}$/);
  });

  it("个位数月/日/时/分补零", () => {
    const label = formatTimeContext(new Date(2026, 0, 5, 3, 7));
    expect(label.startsWith("2026-01-05 03:07 ")).toBe(true);
  });
});

describe("withTimeBlock", () => {
  it("时间 block 插头部，原 blocks 逐字保留", () => {
    const blocks = JSON.stringify([
      { type: "text", text: "hi" },
      { type: "text", text: "正文" },
    ]);
    expect(JSON.parse(withTimeBlock(blocks, NOW))).toEqual([
      { type: "text", text: `当前时间：${formatTimeContext(NOW)}` },
      { type: "text", text: "hi" },
      { type: "text", text: "正文" },
    ]);
  });

  it("畸形/空 blocks → 仅时间 block（parseBlocks 空数组归一）", () => {
    for (const malformed of ["not-json", "[]", '{"a":1}']) {
      expect(JSON.parse(withTimeBlock(malformed, NOW))).toEqual([
        { type: "text", text: `当前时间：${formatTimeContext(NOW)}` },
      ]);
    }
  });
});
