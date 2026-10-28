// 记忆面错码映射：五值枚举全覆盖 + ok 分支 null（AI 操作业务失败非
// wire 错——渲染层按码出文案）
import { describe, expect, it } from "vitest";
import type { MemoryServiceResult } from "@tianshu/protocol";
import { describeMemoryResult } from "./memory-error";

const T = (key: string) => key;

describe("describeMemoryResult", () => {
  it("ok 分支与无码失败 → null", () => {
    expect(describeMemoryResult({ ok: true, memory: "x" }, T)).toBeNull();
    expect(describeMemoryResult({ ok: false }, T)).toBeNull();
  });

  it("五错码逐一映射 i18n key", () => {
    const cases: Array<[MemoryServiceResult["error"] & string, string]> = [
      ["MEMORY_DISABLED", "memory:errDisabled"],
      ["MEMORY_MODEL_MISSING", "memory:errModelMissing"],
      ["MEMORY_COMPILE_FAILED", "memory:errCompileFailed"],
      ["MEMORY_NO_MATERIAL", "memory:errNoMaterial"],
      ["MEMORY_BUSY", "memory:errBusy"],
    ];
    for (const [code, key] of cases) {
      expect(describeMemoryResult({ ok: false, error: code }, T)).toBe(key);
    }
  });
});
