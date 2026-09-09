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
} from "../../electron/domains/ai/personalization/personalization.config";

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
