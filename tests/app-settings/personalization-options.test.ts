/**
 * 前端个性化模型单测：解析默认值、非法回退、保存包装（trim/截断/bool 转换）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const setMock = vi.fn(async () => undefined);

vi.mock("../../src-react/domains/app-settings/api/settings.api", () => ({
  SettingsApi: {
    getAll: vi.fn(async () => [] as Array<{ name: string; value: string }>),
    set: (name: string, value: string) => setMock(name, value),
  },
}));

import {
  DEFAULT_PERSONA,
  PERSONALIZATION_KEYS,
  PERSONALIZATION_LIMITS,
  defaultPersonalizationOptions,
  parsePersonalizationOptions,
  savePersonalizationOption,
} from "../../src-react/domains/app-settings/model/personalization-options";

describe("DEFAULT_PERSONA", () => {
  it("非空且在 persona 限长内", () => {
    expect(DEFAULT_PERSONA.trim().length).toBeGreaterThan(0);
    expect(DEFAULT_PERSONA.length).toBeLessThanOrEqual(
      PERSONALIZATION_LIMITS.persona,
    );
  });
});

describe("parsePersonalizationOptions", () => {
  it("空列表 → 全默认（persona 空 = 未启用，spec D6）", () => {
    expect(parsePersonalizationOptions([])).toEqual(
      defaultPersonalizationOptions(),
    );
    expect(defaultPersonalizationOptions().persona).toBe("");
    expect(defaultPersonalizationOptions().aiName).toBe("天枢");
  });

  it("正常行解析；非法风格回退 default", () => {
    const options = parsePersonalizationOptions([
      { name: PERSONALIZATION_KEYS.responseStyle, value: "socratic" },
      { name: PERSONALIZATION_KEYS.fileChangeDetails, value: "true" },
      { name: PERSONALIZATION_KEYS.persona, value: "自定义人设" },
    ]);
    expect(options.responseStyle).toBe("socratic");
    expect(options.fileChangeDetails).toBe(true);
    expect(options.persona).toBe("自定义人设");
    const bad = parsePersonalizationOptions([
      { name: PERSONALIZATION_KEYS.responseStyle, value: "nope" },
    ]);
    expect(bad.responseStyle).toBe("default");
  });
});

describe("savePersonalizationOption", () => {
  beforeEach(() => {
    setMock.mockClear();
  });

  it("文本值：trim + 截断后写入，返回实际持久化值", async () => {
    const saved = await savePersonalizationOption(
      PERSONALIZATION_KEYS.customInstructions,
      "  先给结论  ",
    );
    expect(setMock).toHaveBeenCalledWith(
      PERSONALIZATION_KEYS.customInstructions,
      "先给结论",
    );
    expect(saved).toBe("先给结论");
    const truncated = await savePersonalizationOption(
      PERSONALIZATION_KEYS.userNickname,
      "a".repeat(50),
    );
    expect(truncated).toHaveLength(PERSONALIZATION_LIMITS.userNickname);
  });

  it("布尔值：转换为字面 true/false 字符串", async () => {
    await savePersonalizationOption(PERSONALIZATION_KEYS.welcomeLoading, false);
    expect(setMock).toHaveBeenCalledWith(
      PERSONALIZATION_KEYS.welcomeLoading,
      "false",
    );
  });

  it("空文本 trim 后为空串照常写入（清空语义）", async () => {
    const saved = await savePersonalizationOption(
      PERSONALIZATION_KEYS.persona,
      "   ",
    );
    expect(saved).toBe("");
    expect(setMock).toHaveBeenCalledWith(PERSONALIZATION_KEYS.persona, "");
  });
});
