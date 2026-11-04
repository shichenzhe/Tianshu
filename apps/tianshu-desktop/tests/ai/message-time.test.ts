/**
 * formatMessageTime 三档格式化（user 消息 hover 时间戳）：
 * - 当天 HH:mm（24 小时制，时/分两位补零）
 * - 同年不同日：zh「9月6日 14:30」/ en「Sep 6, 14:30」（月日不补零）
 * - 跨年：zh「2025/1/1 10:00」/ en「Jan 1, 2025, 10:00」
 * - 无效日期返回空串；now 注入固定参照时钟，判定不随运行环境/时区漂移
 */
import { describe, expect, it } from "vitest";

import { formatMessageTime } from "../../src-react/domains/ai/chat/lib/message-time";

/** 参照时钟固定为本地 2026-09-08 18:00（构造与比较均走本地时区） */
const now = new Date(2026, 8, 8, 18, 0);

/** 本地时区某时刻的 ISO 串（模拟后端落库的 createdAt） */
function isoOf(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): string {
  return new Date(year, month - 1, day, hour, minute).toISOString();
}

describe("formatMessageTime 当天", () => {
  it("只显示时分（24 小时制），分钟两位补零", () => {
    expect(formatMessageTime(isoOf(2026, 9, 8, 9, 5), "zh-CN", now)).toBe(
      "09:05",
    );
    expect(formatMessageTime(isoOf(2026, 9, 8, 9, 5), "en-US", now)).toBe(
      "09:05",
    );
    expect(formatMessageTime(isoOf(2026, 9, 8, 14, 30), "zh-CN", now)).toBe(
      "14:30",
    );
  });

  it("深夜零点走 h23 显示 00:mm（而非 24:mm）", () => {
    expect(formatMessageTime(isoOf(2026, 9, 8, 0, 5), "en-US", now)).toBe(
      "00:05",
    );
  });
});

describe("formatMessageTime 同年不同日", () => {
  it("短月名 + 日 + 时分", () => {
    expect(formatMessageTime(isoOf(2026, 9, 6, 14, 30), "zh-CN", now)).toBe(
      "9月6日 14:30",
    );
    expect(formatMessageTime(isoOf(2026, 9, 6, 14, 30), "en-US", now)).toBe(
      "Sep 6, 14:30",
    );
  });

  it("月/日不补零", () => {
    expect(formatMessageTime(isoOf(2026, 1, 5, 9, 5), "zh-CN", now)).toBe(
      "1月5日 09:05",
    );
    expect(formatMessageTime(isoOf(2026, 1, 5, 9, 5), "en-US", now)).toBe(
      "Jan 5, 09:05",
    );
  });
});

describe("formatMessageTime 跨年", () => {
  it("带年份：zh 数字月日 / en 短月名带年", () => {
    expect(formatMessageTime(isoOf(2025, 1, 1, 10, 0), "zh-CN", now)).toBe(
      "2025/1/1 10:00",
    );
    expect(formatMessageTime(isoOf(2025, 1, 1, 10, 0), "en-US", now)).toBe(
      "Jan 1, 2025, 10:00",
    );
  });
});

describe("formatMessageTime 无效输入", () => {
  it("不可解析的日期与空串返回空串", () => {
    expect(formatMessageTime("not-a-date", "zh-CN", now)).toBe("");
    expect(formatMessageTime("", "en-US", now)).toBe("");
  });
});
