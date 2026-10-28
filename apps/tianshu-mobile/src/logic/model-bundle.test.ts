import { describe, expect, it } from "vitest";

import {
  hasUsableModels,
  modelLabel,
  modelNameMap,
  parseProviderBundle,
} from "./model-bundle";

/** ProviderBundleDto wire 样例（Prisma provider/model 行直序列化形态） */
const wire = {
  providers: [
    { id: 1, name: "OpenAI", type: "openai", enabled: true },
    { id: 2, name: "硅基流动", type: "openai-compatible", enabled: false },
  ],
  models: [
    { id: 11, providerId: 1, modelId: "gpt-4o", name: "GPT-4o", type: "llm", enabled: true },
    { id: 12, providerId: 1, modelId: "text-embedding-3", name: null, type: "embedding" },
    { id: 13, providerId: 1, modelId: "gpt-4o-mini", name: null, type: "llm", enabled: false },
    { id: 21, providerId: 2, modelId: "qwen-max", type: "llm" }, // name/enabled 缺省（老数据）
    { id: 22, providerId: 99, modelId: "orphan", type: "llm" }, // provider 行缺席
    { id: 23, providerId: "x", modelId: "bad" }, // 畸形行
  ],
};

describe("parseProviderBundle wire 判别", () => {
  it("仅 llm + enabled 入组；按 provider 分组、空组滤除、孤儿模型不进组", () => {
    const bundle = parseProviderBundle(wire);
    expect(bundle.providers).toHaveLength(2);
    // models 保留全部可解析行（孤儿 22 含内——仅 label 反查用）；
    // 分组侧孤儿（providerId 无对应 provider 行）丢弃
    expect(bundle.models.map((m) => m.id)).toEqual([11, 21, 22]);
    expect(bundle.groups).toEqual([
      {
        provider: { id: 1, name: "OpenAI" },
        models: [
          { id: 11, providerId: 1, name: "GPT-4o", modelId: "gpt-4o" },
        ],
      },
      {
        provider: { id: 2, name: "硅基流动" },
        models: [
          { id: 21, providerId: 2, name: null, modelId: "qwen-max" },
        ],
      },
    ]);
  });

  it("modelLabel：name 空串/null 回落 modelId 标识", () => {
    expect(modelLabel({ id: 11, providerId: 1, name: "GPT-4o", modelId: "gpt-4o" })).toBe("GPT-4o");
    expect(modelLabel({ id: 21, providerId: 2, name: null, modelId: "qwen-max" })).toBe("qwen-max");
    expect(modelLabel({ id: 22, providerId: 2, name: "  ", modelId: "qwen-plus" })).toBe("qwen-plus");
  });

  it("畸形输入退空 bundle（null/非对象/非数组字段）", () => {
    expect(parseProviderBundle(null).groups).toEqual([]);
    expect(parseProviderBundle(undefined).groups).toEqual([]);
    expect(parseProviderBundle("x").groups).toEqual([]);
    expect(parseProviderBundle({ providers: "x", models: 3 }).groups).toEqual([]);
    expect(parseProviderBundle({ providers: [], models: [] }).groups).toEqual([]);
  });
});

describe("modelNameMap / hasUsableModels（B5 消息元信息 + 无模型引导判据）", () => {
  it("modelNameMap：可对话模型 id → 展示名（name 空回落 modelId，含孤儿行）", () => {
    const map = modelNameMap(wire);
    expect(map.get(11)).toBe("GPT-4o");
    expect(map.get(21)).toBe("qwen-max"); // name 缺省回落 modelId
    expect(map.get(22)).toBe("orphan"); // 孤儿模型行也入表（反查兜底）
    expect(map.has(12)).toBe(false); // embedding 不入表
    expect(map.has(13)).toBe(false); // 禁用模型不入表
    expect(map.has(23)).toBe(false); // 畸形行不入表
  });

  it("hasUsableModels：有可对话 llm 模型即 true；空表/全禁用/专项端点全 false", () => {
    expect(hasUsableModels(wire)).toBe(true); // 11/21/22 可对话
    expect(hasUsableModels(null)).toBe(false); // 未拉取：未知不引导
    expect(hasUsableModels({ providers: [], models: [] })).toBe(false);
    // 全禁用（llm 但 enabled:false）+ 专项端点（embedding）→ 无可用
    expect(
      hasUsableModels({
        providers: [{ id: 1, name: "P", type: "openai", enabled: true }],
        models: [
          { id: 13, providerId: 1, modelId: "m1", type: "llm", enabled: false },
          { id: 12, providerId: 1, modelId: "m2", type: "embedding", enabled: true },
        ],
      }),
    ).toBe(false);
  });
});
