/**
 * 模型显示名单测（modelDisplayName）：name 空/空白回退 modelId。
 * 回归背景 2026-10-23：记忆整理模型下拉五处渲染表达式分叉——
 * MemoryGroup 误写 `name?.trim() !== ""`（name 为 null 时
 * undefined !== "" 恒真 → children=null → 空白 item，视觉上
 * "无模型可选"），其余四处 `name || modelId` 正确但语义重复；
 * 收敛为单一显示函数（DRY）
 */
import { describe, expect, it } from "vitest";
import { modelDisplayName } from "@/domains/ai/api/model.api";

describe("modelDisplayName", () => {
  it("name 为 null/undefined（库内可空，dev 实测恒 null）→ 回退 modelId", () => {
    expect(modelDisplayName({ name: null, modelId: "qwen3.5-4b" })).toBe(
      "qwen3.5-4b",
    );
    expect(modelDisplayName({ name: undefined, modelId: "qwen3.5-4b" })).toBe(
      "qwen3.5-4b",
    );
  });

  it("name 为空串/空白串 → 回退 modelId（trim 真值判定）", () => {
    expect(modelDisplayName({ name: "", modelId: "qwen3.5-4b" })).toBe(
      "qwen3.5-4b",
    );
    expect(modelDisplayName({ name: "   ", modelId: "qwen3.5-4b" })).toBe(
      "qwen3.5-4b",
    );
  });

  it("name 有效 → 显示 trim 后的 name", () => {
    expect(modelDisplayName({ name: "主力模型", modelId: "qwen3.5-4b" })).toBe(
      "主力模型",
    );
    expect(
      modelDisplayName({ name: " 主力模型 ", modelId: "qwen3.5-4b" }),
    ).toBe("主力模型");
  });
});
