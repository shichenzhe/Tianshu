/**
 * loadPersonalization 容错单测：正常解析 / 查询异常回退默认 /
 * delegate 缺失（既有 chat.service.test 的 prisma stub 无 option）回退默认；
 * 批9（2026-11-05）追加：userId 隔离（per-user key 优先、A 画像不进 B
 * 对话）与旧全局 key 首读迁移三态
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  app: {
    getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`),
    getAppPath: vi.fn(() => `/tmp/tianshu-test-app-${process.pid}`),
    isPackaged: false,
  },
}));

vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    option: {
      findMany: (...args: unknown[]) => optionStub.findMany(...args),
      updateMany: (...args: unknown[]) => optionStub.updateMany(...args),
      create: (...args: unknown[]) => optionStub.create(...args),
    },
  },
}));

/** setAppOption upsert 语义替身：命中改名行则改值，否则 create 记行 */
const optionStub = {
  findMany: vi.fn(),
  updateMany: vi.fn(
    async (args: { where: { name: string }; data: { value: string } }) => {
      const row = rowsStub.find((r) => r.name === args.where.name);
      if (!row) {
        return { count: 0 };
      }
      row.value = args.data.value;
      return { count: 1 };
    },
  ),
  create: vi.fn(async (args: { data: { name: string; value: string } }) => {
    rowsStub.push({ name: args.data.name, value: args.data.value });
  }),
};

/** option 行存储（findMany 按行序返回；updateMany/create 回写） */
const rowsStub: Array<{ name: string; value: string }> = [];

import { loadPersonalization } from "../../electron/domains/ai/personalization/personalization.repo";
import {
  PERSONALIZATION_KEYS,
  defaultPersonalization,
  fromAppOptions,
  memoryProfileKeyFor,
} from "../../electron/domains/ai/personalization/personalization.config";
import { buildPersonalizedSystem } from "../../electron/domains/ai/personalization/personalization.prompt";

describe("loadPersonalization", () => {
  beforeEach(() => {
    optionStub.findMany.mockReset();
    rowsStub.length = 0;
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

describe("loadPersonalization(userId)（批9 P2.1 隔离 + 迁移）", () => {
  beforeEach(() => {
    optionStub.findMany.mockReset();
    // mockClear 保留 upsert 实现只清调用记录（断言「未发生迁移写」用）
    optionStub.updateMany.mockClear();
    optionStub.create.mockClear();
    rowsStub.length = 0;
    // findMany 按 name in 过滤行存储（getAppOptionMap 语义）
    optionStub.findMany.mockImplementation(
      async (args: { where: { name: { in: string[] } } }) =>
        rowsStub.filter((row) => args.where.name.in.includes(row.name)),
    );
  });

  it("per-user 行优先：A 的画像不进 B 的对话（隔离核心断言）", async () => {
    rowsStub.push(
      { name: memoryProfileKeyFor(1), value: "## 工作背景\nA 的画像" },
      { name: memoryProfileKeyFor(2), value: "## 工作背景\nB 的画像" },
    );
    const a = await loadPersonalization(1);
    const b = await loadPersonalization(2);
    expect(a.memoryProfile).toBe("## 工作背景\nA 的画像");
    expect(b.memoryProfile).toBe("## 工作背景\nB 的画像");
    // 注入面终断言：A 的 system 不含 B 的画像，反之亦然
    const systemA = buildPersonalizedSystem(a, "base")!;
    expect(systemA).toContain("A 的画像");
    expect(systemA).not.toContain("B 的画像");
  });

  it("B 无 per-user 行且旧全局行不存在 → 默认空画像（不继承他人画像）", async () => {
    rowsStub.push({ name: memoryProfileKeyFor(1), value: "A 的画像" });
    const b = await loadPersonalization(2);
    expect(b.memoryProfile).toBe("");
  });

  it("迁移三态①：旧全局行在场、新 key 缺席 → 首读搬入当前用户命名空间", async () => {
    rowsStub.push({
      name: PERSONALIZATION_KEYS.memoryProfile,
      value: "## 工作背景\n旧全局画像",
    });
    const config = await loadPersonalization(3);
    expect(config.memoryProfile).toBe("## 工作背景\n旧全局画像");
    // 新 key 落值（upsert create 路径），旧 key 保留（升级可回滚不断忆）
    expect(rowsStub).toContainEqual({
      name: memoryProfileKeyFor(3),
      value: "## 工作背景\n旧全局画像",
    });
    expect(
      rowsStub.find((r) => r.name === PERSONALIZATION_KEYS.memoryProfile)
        ?.value,
    ).toBe("## 工作背景\n旧全局画像");
  });

  it("迁移三态②：新 key 已在场 → 不覆盖（旧全局行不冲掉用户自己的画像）", async () => {
    rowsStub.push(
      { name: PERSONALIZATION_KEYS.memoryProfile, value: "旧全局画像" },
      { name: memoryProfileKeyFor(3), value: "用户自己的画像" },
    );
    const config = await loadPersonalization(3);
    expect(config.memoryProfile).toBe("用户自己的画像");
    // 未发生迁移写（updateMany/create 均未动过新 key 行）
    expect(rowsStub.find((r) => r.name === memoryProfileKeyFor(3))?.value).toBe(
      "用户自己的画像",
    );
  });

  it("迁移三态③：两 key 均无（全新用户）→ 不写行", async () => {
    await loadPersonalization(4);
    expect(
      rowsStub.filter((r) => r.name.includes("memoryProfile")),
    ).toHaveLength(0);
  });

  it("迁移写失败不阻断读：仍回落旧全局行（兼容读取）", async () => {
    rowsStub.push({
      name: PERSONALIZATION_KEYS.memoryProfile,
      value: "旧全局画像",
    });
    optionStub.create.mockRejectedValueOnce(new Error("db locked"));
    const config = await loadPersonalization(5);
    expect(config.memoryProfile).toBe("旧全局画像");
    // 读取不受写失败影响（对话不中断，与 repo 容错语义一致）
  });

  it("整理元数据随画像 per-user 化（LastCompiledAt/LastError 同名空间读写）", async () => {
    rowsStub.push(
      {
        name: "personalization.7.memoryLastCompiledAt",
        value: "2026-11-05T02:00:00.000Z",
      },
      { name: "personalization.7.memoryLastError", value: "记忆整理失败：x" },
    );
    const config = await loadPersonalization(7);
    expect(config.memoryLastCompiledAt).toBe("2026-11-05T02:00:00.000Z");
    expect(config.memoryLastError).toBe("记忆整理失败：x");
  });

  it("无 userId 调用（既有全局路径）行为不变：全局行直读", async () => {
    rowsStub.push({
      name: PERSONALIZATION_KEYS.memoryProfile,
      value: "全局画像",
    });
    const config = await loadPersonalization();
    expect(config.memoryProfile).toBe("全局画像");
    // 不触发迁移写
    expect(optionStub.create).not.toHaveBeenCalled();
  });
});
