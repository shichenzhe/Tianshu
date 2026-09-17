/**
 * 敏感词预检单测:本地词表命中/未命中
 */
import { describe, expect, it } from "vitest";
import { checkSensitive } from "@/domains/ai/new-task/lib/sensitive-check";

describe("checkSensitive", () => {
  it("命中返回词", () => {
    expect(checkSensitive("这里包含 示例违禁词A 看看")).toBe("示例违禁词A");
  });
  it("未命中返回 null（大小写归一）", () => {
    expect(checkSensitive("正常文本")).toBeNull();
  });
});
