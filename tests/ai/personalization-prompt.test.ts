/**
 * 个性化 system 拼接单测（spec §4.2/§4.6）：
 * D8 全默认逐字节一致、段序、空值跳过、确定性（缓存友好）
 */
import { describe, expect, it } from "vitest";

import {
  defaultPersonalization,
  type PersonalizationConfig,
} from "../../electron/domains/ai/personalization/personalization.config";
import {
  STYLE_PROMPTS,
  buildPersonalizedSystem,
} from "../../electron/domains/ai/personalization/personalization.prompt";

const BASE = "你是专家助手。";

function withConfig(
  patch: Partial<PersonalizationConfig>,
): PersonalizationConfig {
  return { ...defaultPersonalization(), ...patch };
}

describe("buildPersonalizedSystem", () => {
  it("D8 全默认 → 与 baseSystem 逐字节一致（含 baseSystem 为 undefined）", () => {
    expect(buildPersonalizedSystem(defaultPersonalization(), BASE)).toBe(BASE);
    expect(buildPersonalizedSystem(defaultPersonalization(), undefined)).toBe(
      "",
    );
  });

  it("persona 非空 → 原文置于最前，不加包装标签", () => {
    const config = withConfig({ persona: "You're not a chatbot." });
    expect(buildPersonalizedSystem(config, BASE)).toBe(
      `You're not a chatbot.\n\n${BASE}`,
    );
  });

  it("风格段：7 种非 default 风格逐一注入【回复风格】段（位于 baseSystem 之后）", () => {
    for (const [style, prompt] of Object.entries(STYLE_PROMPTS)) {
      const config = withConfig({ responseStyle: style as never });
      expect(buildPersonalizedSystem(config, BASE)).toBe(
        `${BASE}\n\n【回复风格】\n${prompt}`,
      );
    }
  });

  it("身份段：自定义 aiName + userNickname 各自成句；默认 aiName/空昵称不注入", () => {
    const both = buildPersonalizedSystem(
      withConfig({ aiName: "尘心", userNickname: "黄先生" }),
      BASE,
    );
    expect(both).toBe(
      `${BASE}\n\n【身份】\n你的名字是「尘心」，对话中以此自称。\n称呼用户为「黄先生」。`,
    );
    // 默认 aiName「天枢」+ 空昵称 → 无身份段
    expect(buildPersonalizedSystem(defaultPersonalization(), BASE)).toBe(BASE);
    // 仅昵称 → 单句
    const nickOnly = buildPersonalizedSystem(
      withConfig({ userNickname: "黄先生" }),
      BASE,
    );
    expect(nickOnly).toBe(`${BASE}\n\n【身份】\n称呼用户为「黄先生」。`);
  });

  it("记忆段与指令段：非空注入、空跳过", () => {
    const config = withConfig({ memory: "对花生过敏" });
    expect(buildPersonalizedSystem(config, BASE)).toBe(
      `${BASE}\n\n【用户长期记忆】\n以下是用户希望你长期记住的信息，请在对话中遵循：\n对花生过敏`,
    );
    const withInstructions = withConfig({
      customInstructions: "先给结论",
    });
    expect(buildPersonalizedSystem(withInstructions, BASE)).toBe(
      `${BASE}\n\n【用户自定义指令】\n用户设定的全局规则，必须遵守：\n先给结论`,
    );
  });

  it("全字段组合：段序 persona → baseSystem → 风格 → 身份 → 记忆 → 指令（\\n\\n 连接）", () => {
    const config = withConfig({
      persona: "PERSONA",
      responseStyle: "snarky",
      aiName: "尘心",
      memory: "MEMORY",
      customInstructions: "RULES",
    });
    expect(buildPersonalizedSystem(config, BASE)).toBe(
      [
        "PERSONA",
        BASE,
        `【回复风格】\n${STYLE_PROMPTS.snarky}`,
        "【身份】\n你的名字是「尘心」，对话中以此自称。",
        "【用户长期记忆】\n以下是用户希望你长期记住的信息，请在对话中遵循：\nMEMORY",
        "【用户自定义指令】\n用户设定的全局规则，必须遵守：\nRULES",
      ].join("\n\n"),
    );
  });

  it("缓存友好：同 config 两次调用输出严格相等；空白文本视为空跳过", () => {
    const config = withConfig({
      persona: "  ",
      memory: "\t\n",
      customInstructions: "  ",
    });
    const first = buildPersonalizedSystem(config, BASE);
    const second = buildPersonalizedSystem(config, BASE);
    expect(first).toBe(second);
    expect(first).toBe(BASE);
  });
});
