/**
 * 个性化配置解析单测：默认值、字段解析、非法值回退、超长截断
 */
import { describe, expect, it } from "vitest";

import {
  PERSONALIZATION_KEYS,
  PERSONALIZATION_LIMITS,
  defaultPersonalization,
  fromAppOptions,
} from "../../electron/domains/ai/personalization/personalization.config";

describe("defaultPersonalization", () => {
  it("默认值：default 风格 / 欢迎语开 / 文件详情关 / 文本空 / aiName 天枢 / persona 空 / 画像记忆默认", () => {
    expect(defaultPersonalization()).toEqual({
      responseStyle: "default",
      welcomeLoading: true,
      fileChangeDetails: false,
      customInstructions: "",
      userNickname: "",
      aiName: "天枢",
      persona: "",
      memory: "",
      memoryProfile: "",
      memoryEnabled: true,
      memoryLastCompiledAt: "",
      memoryLastError: "",
    });
  });
});

describe("fromAppOptions", () => {
  it("空行数组 → 全默认", () => {
    expect(fromAppOptions([])).toEqual(defaultPersonalization());
  });

  it("正常行逐字段解析（含空串保留）", () => {
    const config = fromAppOptions([
      { name: PERSONALIZATION_KEYS.responseStyle, value: "snarky" },
      { name: PERSONALIZATION_KEYS.welcomeLoading, value: "false" },
      { name: PERSONALIZATION_KEYS.fileChangeDetails, value: "true" },
      { name: PERSONALIZATION_KEYS.customInstructions, value: "先给结论" },
      { name: PERSONALIZATION_KEYS.userNickname, value: "黄先生" },
      { name: PERSONALIZATION_KEYS.aiName, value: "尘心" },
      { name: PERSONALIZATION_KEYS.persona, value: "You are... " },
      { name: PERSONALIZATION_KEYS.memory, value: "对花生过敏" },
    ]);
    expect(config.responseStyle).toBe("snarky");
    expect(config.welcomeLoading).toBe(false);
    expect(config.fileChangeDetails).toBe(true);
    expect(config.customInstructions).toBe("先给结论");
    expect(config.userNickname).toBe("黄先生");
    expect(config.aiName).toBe("尘心");
    expect(config.persona).toBe("You are... ");
    expect(config.memory).toBe("对花生过敏");
  });

  it("未知风格值 → 回退 default；畸形 bool → 回退默认（仅字面 true 为真）", () => {
    const config = fromAppOptions([
      { name: PERSONALIZATION_KEYS.responseStyle, value: "yolo" },
      { name: PERSONALIZATION_KEYS.welcomeLoading, value: "yes" },
      { name: PERSONALIZATION_KEYS.fileChangeDetails, value: "true" },
    ]);
    expect(config.responseStyle).toBe("default");
    expect(config.welcomeLoading).toBe(false);
    expect(config.fileChangeDetails).toBe(true);
  });

  it("超长文本 → 截断到限长", () => {
    const long = "a".repeat(9000);
    const config = fromAppOptions([
      { name: PERSONALIZATION_KEYS.customInstructions, value: long },
      { name: PERSONALIZATION_KEYS.userNickname, value: long },
      { name: PERSONALIZATION_KEYS.aiName, value: long },
      { name: PERSONALIZATION_KEYS.persona, value: long },
      { name: PERSONALIZATION_KEYS.memory, value: long },
      { name: PERSONALIZATION_KEYS.memoryProfile, value: long },
      { name: PERSONALIZATION_KEYS.memoryLastCompiledAt, value: long },
      { name: PERSONALIZATION_KEYS.memoryLastError, value: long },
    ]);
    expect(config.customInstructions).toHaveLength(1500);
    expect(config.userNickname).toHaveLength(20);
    expect(config.aiName).toHaveLength(20);
    expect(config.persona).toHaveLength(4000);
    expect(config.memory).toHaveLength(1500);
    expect(config.memoryProfile).toHaveLength(8000);
    expect(config.memoryLastCompiledAt).toHaveLength(40);
    expect(config.memoryLastError).toHaveLength(200);
  });

  it("memoryLastCompiledAt 限长收口于 PERSONALIZATION_LIMITS（T2b）", () => {
    expect(PERSONALIZATION_LIMITS.memoryLastCompiledAt).toBe(40);
  });

  it("memoryLastError 限长收口于 PERSONALIZATION_LIMITS（修订 A：失败可观测）", () => {
    expect(PERSONALIZATION_LIMITS.memoryLastError).toBe(200);
  });

  it("非个性化前缀的行被忽略", () => {
    const config = fromAppOptions([{ name: "keepAwake", value: "true" }]);
    expect(config).toEqual(defaultPersonalization());
  });
});
