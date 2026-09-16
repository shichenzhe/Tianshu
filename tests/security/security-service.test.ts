/**
 * SecurityService 单测（SP1 spec §6.1）：init 读表入缓存、缺行回退默认、
 * getConfig 内置清单/配置分离结构、setConfig 校验→落库→缓存→审计联动、
 * 文件黑名单剔除内置项、未知 key 抛错。
 * 依赖经 vi.mock 替换（electron ipcMain / prisma client），沿用 project-repo.test.ts 模式。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock("../../electron/commons/prisma-client", () => ({
  default: {},
}));

import SecurityService from "../../electron/domains/security/security.service";

/** 内存 stub：SecurityOptionPrismaLike 最小实现（updateMany 命中已存在行时需写入新值） */
function makeDb() {
  const rows = new Map<string, string>();
  return {
    rows,
    findMany: async () => [...rows].map(([name, value]) => ({ name, value })),
    updateMany: async ({
      where,
      data,
    }: {
      where: { name: string };
      data: { value: string };
    }) => {
      if (!rows.has(where.name)) return { count: 0 };
      rows.set(where.name, data.value);
      return { count: 1 };
    },
    create: async ({ data }: { data: { name: string; value: string } }) => {
      rows.set(data.name, data.value);
      return {};
    },
  };
}

describe("SecurityService", () => {
  it("init 读 option 行入缓存，缺省回退默认", async () => {
    const db = makeDb();
    db.rows.set("sandboxEnabled", "false");
    const svc = new SecurityService({ db: db as never });
    await svc.init();
    expect(svc.getConfigValue().sandboxEnabled).toBe(false);
    expect(svc.getConfigValue().deleteProtection).toBe(true);
  });
  it("getConfig 返回 defaults/config 分离结构", async () => {
    const svc = new SecurityService({ db: makeDb() as never });
    await svc.init();
    const state = svc.getConfig();
    expect(state.defaults.fileBlocklist).toContain("~/.ssh/");
    expect(state.config.sandboxEnabled).toBe(true);
  });
  it("setConfig 校验+落库+更新缓存+发审计事件", async () => {
    const db = makeDb();
    const events: unknown[] = [];
    const svc = new SecurityService({
      db: db as never,
      audit: (e) => events.push(e),
    });
    await svc.init();
    const updated = await svc.setConfig("bulkDeleteThreshold", 999999999);
    expect(updated.bulkDeleteThreshold).toBe(10000); // 超上限钳至预估计数上限
    expect(db.rows.get("bulkDeleteThreshold")).toBe("10000");
    expect(svc.getConfigValue().bulkDeleteThreshold).toBe(10000);
    expect(events).toEqual([
      expect.objectContaining({
        eventType: "config.bulkDeleteThreshold.updated",
        decision: "info",
      }),
    ]);
  });
  it("setConfig 保存文件黑名单时剔除内置项", async () => {
    const db = makeDb();
    const svc = new SecurityService({ db: db as never });
    await svc.init();
    await svc.setConfig("fileBlocklist", ["/tmp/x", "~/.ssh/"]);
    expect(db.rows.get("fileBlocklist")).toBe('["/tmp/x"]');
  });
  it("未知 key 抛错", async () => {
    const svc = new SecurityService({ db: makeDb() as never });
    await svc.init();
    await expect(svc.setConfig("nope" as never, 1)).rejects.toThrow();
  });
});
