// 记忆进化批 memory-tap 直测：get 聚合归一（modelId/时间戳/错误 空串→null）、
// saveConfig 显式携带才写、saveProfile 覆写+8000 截断、AI 操作转
// MemoryService（错误码透传）。批9（2026-11-05）：五端点带 userId——
// 画像落当前用户命名空间键、loadConfig/applyInstruction 收到 userId。
// 内存替身直测（providers-tap 先例）。
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => "/tmp/tianshu-mem-test") },
}));
vi.mock("../../../electron/commons/Log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createMemoryFace } from "../../../electron/domains/server-face/memory-tap";

/** PersonalizationConfig 结构子集（tap 消费面） */
function config(over: Record<string, unknown> = {}) {
  return {
    memoryEnabled: true,
    memoryProfile: "### 工作背景\n- [2026-10-27] - 测",
    memoryModelId: "5",
    memoryLastCompiledAt: "2026-10-27T01:00:00.000Z",
    memoryLastError: "",
    ...over,
  };
}

function makeDeps(initial: ReturnType<typeof config>) {
  const saved: Array<[string, string]> = [];
  let current = initial;
  return {
    saved,
    deps: {
      loadConfig: vi.fn(async () => current),
      save: vi.fn(async (name: string, value: string) => {
        saved.push([name, value]);
        // 简化语义：save 后回读反映写入（enabled/modelId/profile 三键）
        current = {
          ...current,
          [name.replace("personalization.memory", "").toLowerCase() || "x"]:
            value,
        } as never;
      }),
      memoryService: {
        applyInstruction: vi.fn(
          async (_instruction: string, _userId: number) => ({
            ok: true,
            memory: "### 工作背景\n- 新",
          }),
        ),
        compileNow: vi.fn(async (_userId: number) => ({
          ok: false,
          error: "MEMORY_NO_MATERIAL" as const,
        })),
      },
    },
  };
}

/** 被控端当前登录用户（批9：画像归属） */
const FACE_USER = 3;

describe("memory-tap：get 聚合归一", () => {
  it("modelId 数字化、时间戳/错误空串转 null", async () => {
    const { deps } = makeDeps(config());
    const face = createMemoryFace(deps);
    const state = await face.get(FACE_USER);
    expect(state).toEqual({
      enabled: true,
      profile: "### 工作背景\n- [2026-10-27] - 测",
      modelId: 5,
      lastCompiledAt: "2026-10-27T01:00:00.000Z",
      lastError: null,
    });
    expect(deps.loadConfig).toHaveBeenCalledWith(FACE_USER);
  });

  it("modelId 空串/非数字 → null", async () => {
    const { deps } = makeDeps(config({ memoryModelId: "" }));
    expect((await createMemoryFace(deps).get(FACE_USER)).modelId).toBeNull();
  });
});

describe("memory-tap：saveConfig/saveProfile 写面", () => {
  it("saveConfig：enabled/modelId 各自显式携带才写（本机全局键）", async () => {
    const { deps, saved } = makeDeps(config());
    const face = createMemoryFace(deps);
    await face.saveConfig(FACE_USER, { enabled: false });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual(["personalization.memoryEnabled", "false"]);

    await face.saveConfig(FACE_USER, { modelId: null });
    expect(saved[1]).toEqual(["personalization.memoryModelId", ""]);
  });

  it("saveProfile：全量覆写当前用户命名空间 + 超 8000 截断", async () => {
    const { deps, saved } = makeDeps(config());
    const face = createMemoryFace(deps);
    await face.saveProfile(FACE_USER, "");
    expect(saved[0]).toEqual(["personalization.3.memoryProfile", ""]);
    await face.saveProfile(FACE_USER, "x".repeat(9000));
    expect(saved[1]?.[0]).toBe("personalization.3.memoryProfile");
    expect(saved[1]?.[1].length).toBe(8000);
  });
});

describe("memory-tap：AI 操作透传", () => {
  it("applyInstruction/compile 转 MemoryService（userId 随行、码透传）", async () => {
    const { deps } = makeDeps(config());
    const face = createMemoryFace(deps);
    const applied = await face.applyInstruction(FACE_USER, "删掉天气相关记忆");
    expect(applied).toEqual({ ok: true, memory: "### 工作背景\n- 新" });
    expect(deps.memoryService.applyInstruction).toHaveBeenCalledWith(
      "删掉天气相关记忆",
      FACE_USER,
    );
    const compiled = await face.compile(FACE_USER);
    expect(compiled).toEqual({ ok: false, error: "MEMORY_NO_MATERIAL" });
    expect(deps.memoryService.compileNow).toHaveBeenCalledWith(FACE_USER);
  });
});
