/**
 * 敏感词预检单测:本地词表命中/未命中（词表为基础通用档,见
 * sensitive-check.ts 顶部类别注释）
 */
import { describe, expect, it } from "vitest";
import { checkSensitive } from "@/domains/ai/new-task/lib/sensitive-check";

describe("checkSensitive", () => {
  it("命中返回词（各类别抽样）", () => {
    expect(checkSensitive("这里包含 赌球 看看")).toBe("赌球");
    expect(checkSensitive("帮我找 洗钱渠道")).toBe("洗钱渠道");
    expect(checkSensitive("如何 制作炸弹")).toBe("制作炸弹");
  });
  it("未命中返回 null（大小写归一；正常讨论不误伤）", () => {
    expect(checkSensitive("正常文本")).toBeNull();
    expect(checkSensitive("写一篇防范电信诈骗的宣传稿")).toBeNull();
    expect(checkSensitive("整理 冰箱除霜 步骤")).toBeNull();
  });
});
