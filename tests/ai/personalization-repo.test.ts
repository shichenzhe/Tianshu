/**
 * loadPersonalization 容错单测：正常解析 / 查询异常回退默认 /
 * delegate 缺失（既有 chat.service.test 的 prisma stub 无 option）回退默认
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: vi.fn(() => "/tmp/tianshu-test-user-data") },
}));

vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    option: {
      findMany: (...args: unknown[]) => optionStub.findMany(...args),
    },
  },
}));

const optionStub = { findMany: vi.fn() };

import { loadPersonalization } from "../../electron/domains/ai/personalization/personalization.repo";
import {
  PERSONALIZATION_KEYS,
  defaultPersonalization,
  fromAppOptions,
} from "../../electron/domains/ai/personalization/personalization.config";
import { buildPersonalizedSystem } from "../../electron/domains/ai/personalization/personalization.prompt";

describe("loadPersonalization", () => {
  beforeEach(() => {
    optionStub.findMany.mockReset();
  });

  it("正常行 → 解析为配置", async () => {
    optionStub.findMany.mockResolvedValue([
      { name: PERSONALIZATION_KEYS.responseStyle, value: "snarky" },
      { name: PERSONALIZATION_KEYS.welcomeLoading, value: "false" },
    ]);
    const config = await loadPersonalization();
    expect(config.responseStyle).toBe("snarky");
    expect(config.welcomeLoading).toBe(false);
  });

  it("无个性化行 → 全默认（D8：system 与现状一致）", async () => {
    optionStub.findMany.mockResolvedValue([
      { name: "keepAwake", value: "true" },
    ]);
    await expect(loadPersonalization()).resolves.toEqual(
      defaultPersonalization(),
    );
  });

  it("查询 reject → 回退全默认（对话不中断）", async () => {
    optionStub.findMany.mockRejectedValue(new Error("db down"));
    await expect(loadPersonalization()).resolves.toEqual(
      defaultPersonalization(),
    );
  });

  it("查询同步抛错（delegate 缺失场景）→ 回退全默认", async () => {
    optionStub.findMany.mockImplementation(() => {
      throw new TypeError("prisma.option is undefined");
    });
    await expect(loadPersonalization()).resolves.toEqual(
      defaultPersonalization(),
    );
  });
});

describe("记忆画像字段（memory-evolution spec §3）", () => {
  it("默认值：memoryProfile 空、memoryEnabled true、lastCompiledAt 空", () => {
    const config = fromAppOptions([]);
    expect(config.memoryProfile).toBe("");
    expect(config.memoryEnabled).toBe(true);
    expect(config.memoryLastCompiledAt).toBe("");
  });

  it("option 行解析三字段并截断 memoryProfile", () => {
    const long = "x".repeat(9000);
    const config = fromAppOptions([
      { name: "personalization.memoryProfile", value: long },
      { name: "personalization.memoryEnabled", value: "false" },
      {
        name: "personalization.memoryLastCompiledAt",
        value: "2026-09-08T18:00:00.000Z",
      },
    ]);
    expect(config.memoryProfile).toHaveLength(8000);
    expect(config.memoryEnabled).toBe(false);
    expect(config.memoryLastCompiledAt).toBe("2026-09-08T18:00:00.000Z");
  });

  it("buildPersonalizedSystem 注入【用户画像记忆】段且位于长期记忆与自定义指令之间", () => {
    const config = {
      ...defaultPersonalization(),
      memory: "手动记忆",
      memoryProfile: "## 工作背景\n画像",
      customInstructions: "规则",
    };
    const system = buildPersonalizedSystem(config, "base");
    const idxMemory = system!.indexOf("【用户长期记忆】");
    const idxProfile = system!.indexOf("【用户画像记忆】");
    const idxInstr = system!.indexOf("【用户自定义指令】");
    expect(idxProfile).toBeGreaterThan(0);
    expect(idxMemory).toBeLessThan(idxProfile);
    expect(idxProfile).toBeLessThan(idxInstr);
    expect(system).toContain(
      "以下是系统从对话中提炼的用户画像，请在对话中参考：",
    );
  });

  it("memoryProfile 空 → 不注入画像段（D8 线级行为不回归）", () => {
    const system = buildPersonalizedSystem(defaultPersonalization(), "base");
    expect(system).not.toContain("【用户画像记忆】");
  });
});
