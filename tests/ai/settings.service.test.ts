/**
 * 设置服务单测（Task 10）：upsert 语义、autoLaunch 读写映射、keepAwake
 * 起停幂等与退出清理、代理模式映射纯函数与双层应用/启动重放、
 * storageInfo 计算（真实临时目录；含单文件 stat 删除竞态容错）、
 * openDirectory 目录校验（真实临时目录）、
 * skill 开关默认值与 IPC 通道注册、
 * 测试通知（主进程 Notification：isSupported 分支与构造透传）。
 * electron/prisma/undici/Log 走 mock 三件套（参照 chat.service.test.ts）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// 主进程 Notification 的 show 桩（构造实例共享，断言 show 调用）
const notificationShow = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  app: {
    getPath: vi.fn(() => "/tmp/tianshu-settings-test-userdata"),
    getLoginItemSettings: vi.fn(),
    setLoginItemSettings: vi.fn(),
    on: vi.fn(),
  },
  Notification: Object.assign(
    // 普通函数（非箭头）才能被 new 调用：构造返回带 show 桩的实例
    vi.fn(function () {
      return { show: notificationShow };
    }),
    { isSupported: vi.fn(() => true) },
  ),
  powerSaveBlocker: {
    start: vi.fn(),
    stop: vi.fn(),
    isStarted: vi.fn(() => false),
  },
  shell: { beep: vi.fn(), openPath: vi.fn(), openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  session: { defaultSession: { setProxy: vi.fn(async () => undefined) } },
}));

vi.mock("undici", () => ({
  Agent: vi.fn(),
  EnvHttpProxyAgent: vi.fn(),
  ProxyAgent: vi.fn(),
  setGlobalDispatcher: vi.fn(),
}));

vi.mock("../../electron/commons/Log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** prisma.option 内存实现（findMany/updateMany/create 均可断言） */
const optionRows = new Map<string, string>();
const optionStub = {
  findMany: vi.fn(
    async (args: {
      where: { type: string; name?: { in: string[] } };
    }): Promise<Array<{ name: string; value: string }>> => {
      const names = args.where.name?.in;
      return [...optionRows]
        .filter(([name]) => !names || names.includes(name))
        .map(([name, value]) => ({ name, value }));
    },
  ),
  updateMany: vi.fn(
    async (args: {
      where: { name: string };
      data: { value: string };
    }): Promise<{ count: number }> => {
      if (!optionRows.has(args.where.name)) {
        return { count: 0 };
      }
      optionRows.set(args.where.name, args.data.value);
      return { count: 1 };
    },
  ),
  create: vi.fn(async (args: { data: { name: string; value: string } }) => {
    optionRows.set(args.data.name, args.data.value);
    return {};
  }),
};

vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    option: {
      findMany: (args: unknown) => optionStub.findMany(args),
      updateMany: (args: unknown) => optionStub.updateMany(args),
      create: (args: unknown) => optionStub.create(args),
    },
  },
}));

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  app,
  dialog,
  ipcMain,
  Notification,
  powerSaveBlocker,
  session,
  shell,
} from "electron";
import {
  Agent,
  EnvHttpProxyAgent,
  ProxyAgent,
  setGlobalDispatcher,
} from "undici";
import SettingsService from "../../electron/domains/app-settings/settings.service";
import {
  getAppOptionMap,
  parseBoolOption,
  readSkillAutomationFlags,
  setAppOption,
  type OptionPrismaLike,
} from "../../electron/domains/app-settings/option-store";
import {
  normalizeProxyParams,
  parseProxyMode,
  proxyOptionsToParams,
  proxyParamsToOptions,
  toDispatcherSpec,
  toProxyRules,
  toSessionProxyConfig,
} from "../../electron/domains/app-settings/proxy-config";
import {
  computeDirSize,
  diskBytesFromStatfs,
  type DirSizeFs,
} from "../../electron/domains/app-settings/storage-info";
import { isOpenExternalAllowed } from "../../electron/domains/app-settings/external-url";

/** IPC 通道 → 注册的 handler（断言通道名与直调 handler 用） */
const handlers = new Map<string, (...args: unknown[]) => unknown>();
const handlerOf = (channel: string) => {
  const handler = handlers.get(channel);
  if (!handler) {
    throw new Error(`handler 未注册: ${channel}`);
  }
  return handler;
};

/** powerSaveBlocker 状态机（start 返回递增 id，模拟真实行为） */
let psbActiveId: number | null = null;
let psbNextId = 0;

beforeEach(() => {
  vi.clearAllMocks();
  optionRows.clear();
  handlers.clear();
  vi.mocked(ipcMain.handle).mockImplementation(((
    channel: string,
    handler: (...args: unknown[]) => unknown,
  ) => {
    handlers.set(channel, handler);
  }) as never);
  psbActiveId = null;
  psbNextId = 0;
  vi.mocked(powerSaveBlocker.start).mockImplementation(() => {
    psbActiveId = ++psbNextId;
    return psbActiveId;
  });
  vi.mocked(powerSaveBlocker.stop).mockImplementation((id: number) => {
    if (psbActiveId === id) {
      psbActiveId = null;
    }
    return true;
  });
  vi.mocked(powerSaveBlocker.isStarted).mockImplementation(
    (id: number) => psbActiveId === id,
  );
});

/** 局部内存 db（option-store 纯函数直测用，独立于全局 optionStub） */
const makeOptionDb = (initial: Record<string, string> = {}) => {
  const rows = new Map(Object.entries(initial));
  const db: OptionPrismaLike = {
    async findMany(args) {
      const names = args.where.name?.in;
      return [...rows]
        .filter(([name]) => !names || names.includes(name))
        .map(([name, value]) => ({ name, value }));
    },
    async updateMany(args) {
      if (!rows.has(args.where.name)) {
        return { count: 0 };
      }
      rows.set(args.where.name, args.data.value);
      return { count: 1 };
    },
    async create(args) {
      rows.set(args.data.name, args.data.value);
      return {};
    },
  };
  return { db, rows };
};

describe("option 存取（upsert 语义）", () => {
  it("updateMany 命中 0 行 → create 补插（settings:set 的 upsert 落库）", async () => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const create = vi.fn(async () => ({}));
    const db = {
      findMany: vi.fn(),
      updateMany,
      create,
    } as unknown as OptionPrismaLike;
    await setAppOption(db, "theme", "dark");
    expect(updateMany).toHaveBeenCalledWith({
      where: { type: "app", name: "theme" },
      data: { value: "dark" },
    });
    expect(create).toHaveBeenCalledWith({
      data: { type: "app", name: "theme", value: "dark" },
    });
  });

  it("updateMany 命中 → 不 create；重复写仍走 updateMany（幂等）", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const create = vi.fn(async () => ({}));
    const db = {
      findMany: vi.fn(),
      updateMany,
      create,
    } as unknown as OptionPrismaLike;
    await setAppOption(db, "theme", "dark");
    await setAppOption(db, "theme", "darker");
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(create).not.toHaveBeenCalled();
  });

  it("首次写走 create，其后走 updateMany（内存 db 行为与真实语义一致）", async () => {
    const { db, rows } = makeOptionDb();
    await setAppOption(db, "proxyMode", "direct");
    expect(rows.get("proxyMode")).toBe("direct");
    await setAppOption(db, "proxyMode", "system");
    expect(rows.get("proxyMode")).toBe("system");
  });

  it("getAppOptionMap 只取指定名集合（缺项不出现）", async () => {
    const { db } = makeOptionDb({ a: "1", b: "2", c: "3" });
    expect(await getAppOptionMap(db, ["a", "c"])).toEqual(
      new Map([
        ["a", "1"],
        ["c", "3"],
      ]),
    );
  });

  it("parseBoolOption：仅字面 true 为真，缺省回退 fallback，畸形视为假", () => {
    expect(parseBoolOption("true", false)).toBe(true);
    expect(parseBoolOption("false", true)).toBe(false);
    expect(parseBoolOption("yes", true)).toBe(false);
    expect(parseBoolOption(undefined, true)).toBe(true);
    expect(parseBoolOption(undefined, false)).toBe(false);
  });
});

describe("skill 自动化开关（默认值）", () => {
  it("无记录 → 双开关默认 false（安全缺省：不自动安装/不自动更新）", async () => {
    expect(await readSkillAutomationFlags(makeOptionDb().db)).toEqual({
      autoInstallTrusted: false,
      autoUpdate: false,
    });
  });

  it("显式写 true 后读回 true；畸形值仍为 false", async () => {
    const { db } = makeOptionDb({
      autoInstallTrustedSkills: "true",
      autoUpdateSkills: "1",
    });
    expect(await readSkillAutomationFlags(db)).toEqual({
      autoInstallTrusted: true,
      autoUpdate: false,
    });
  });
});

describe("代理配置纯函数", () => {
  it("toProxyRules：http://host:port", () => {
    expect(toProxyRules("127.0.0.1", 7890)).toBe("http://127.0.0.1:7890");
  });

  it("toSessionProxyConfig：direct/system → mode，proxy → proxyRules", () => {
    expect(toSessionProxyConfig({ mode: "direct" })).toEqual({
      mode: "direct",
    });
    expect(toSessionProxyConfig({ mode: "system" })).toEqual({
      mode: "system",
    });
    expect(toSessionProxyConfig({ mode: "proxy", host: "h", port: 1 })).toEqual(
      { proxyRules: "http://h:1" },
    );
  });

  it("toDispatcherSpec：direct→Agent / system→env / proxy→uri", () => {
    expect(toDispatcherSpec({ mode: "direct" })).toEqual({ kind: "direct" });
    expect(toDispatcherSpec({ mode: "system" })).toEqual({ kind: "env" });
    expect(toDispatcherSpec({ mode: "proxy", host: "h", port: 2 })).toEqual({
      kind: "proxy",
      uri: "http://h:2",
    });
  });

  it("normalizeProxyParams：非法 mode → INVALID_PROXY_MODE", () => {
    expect(normalizeProxyParams({ mode: 1 })).toEqual({
      ok: false,
      error: "INVALID_PROXY_MODE",
    });
    expect(normalizeProxyParams({ mode: "socks5" })).toEqual({
      ok: false,
      error: "INVALID_PROXY_MODE",
    });
  });

  it("normalizeProxyParams：proxy 模式 host/端口校验", () => {
    const invalid = [
      { mode: "proxy" },
      { mode: "proxy", host: "127.0.0.1" },
      { mode: "proxy", host: "127.0.0.1", port: 0 },
      { mode: "proxy", host: "127.0.0.1", port: 65536 },
      { mode: "proxy", host: "127.0.0.1", port: 1.5 },
      { mode: "proxy", host: "127.0.0.1", port: "8080" },
      { mode: "proxy", host: "a b", port: 8080 },
      { mode: "proxy", host: "a/b", port: 8080 },
    ];
    for (const input of invalid) {
      expect(normalizeProxyParams(input)).toEqual({
        ok: false,
        error: "INVALID_PROXY_CONFIG",
      });
    }
    expect(
      normalizeProxyParams({ mode: "proxy", host: " 127.0.0.1 ", port: 7890 }),
    ).toEqual({
      ok: true,
      params: { mode: "proxy", host: "127.0.0.1", port: 7890 },
    });
  });

  it("parseProxyMode：缺省/非法回退 system（Chromium 缺省）", () => {
    expect(parseProxyMode(undefined)).toBe("system");
    expect(parseProxyMode("garbage")).toBe("system");
    expect(parseProxyMode("direct")).toBe("direct");
  });

  it("持久化键值 ↔ 参数往返；direct/system 写空 host/port 清残留", () => {
    const options = proxyParamsToOptions({
      mode: "proxy",
      host: "h",
      port: 3,
    });
    expect(options).toEqual([
      { name: "proxyMode", value: "proxy" },
      { name: "proxyHost", value: "h" },
      { name: "proxyPort", value: "3" },
    ]);
    expect(
      proxyOptionsToParams(new Map(options.map((o) => [o.name, o.value]))),
    ).toEqual({ mode: "proxy", host: "h", port: 3 });
    expect(proxyParamsToOptions({ mode: "direct" })).toEqual([
      { name: "proxyMode", value: "direct" },
      { name: "proxyHost", value: "" },
      { name: "proxyPort", value: "" },
    ]);
    expect(proxyOptionsToParams(new Map())).toEqual({ mode: "system" });
  });

  it("proxyOptionsToParams：proxy 记录畸形（缺 host/坏端口）降级 system", () => {
    const broken = new Map([
      ["proxyMode", "proxy"],
      ["proxyHost", ""],
      ["proxyPort", "7890"],
    ]);
    expect(proxyOptionsToParams(broken)).toEqual({ mode: "system" });
  });
});

describe("SettingsService 代理（服务层）", () => {
  it("setProxy(proxy)：session.proxyRules + ProxyAgent dispatcher + 三键持久化", async () => {
    const svc = new SettingsService();
    await svc.setProxy("proxy", "127.0.0.1", 7890);
    expect(session.defaultSession.setProxy).toHaveBeenCalledWith({
      proxyRules: "http://127.0.0.1:7890",
    });
    expect(ProxyAgent).toHaveBeenCalledWith({ uri: "http://127.0.0.1:7890" });
    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    expect(optionStub.create).toHaveBeenCalledWith({
      data: { type: "app", name: "proxyMode", value: "proxy" },
    });
    expect(optionStub.create).toHaveBeenCalledWith({
      data: { type: "app", name: "proxyHost", value: "127.0.0.1" },
    });
    expect(optionStub.create).toHaveBeenCalledWith({
      data: { type: "app", name: "proxyPort", value: "7890" },
    });
  });

  it("setProxy(direct)：session mode=direct + 普通 Agent 覆盖旧 dispatcher", async () => {
    const svc = new SettingsService();
    await svc.setProxy("direct");
    expect(session.defaultSession.setProxy).toHaveBeenCalledWith({
      mode: "direct",
    });
    expect(Agent).toHaveBeenCalledTimes(1);
    expect(ProxyAgent).not.toHaveBeenCalled();
    expect(optionStub.updateMany).toHaveBeenCalledWith({
      where: { type: "app", name: "proxyMode" },
      data: { value: "direct" },
    });
  });

  it("setProxy 非法入参：抛错误码且不触 session/持久化", async () => {
    const svc = new SettingsService();
    await expect(svc.setProxy("socks")).rejects.toThrow("INVALID_PROXY_MODE");
    await expect(svc.setProxy("proxy", "", 0)).rejects.toThrow(
      "INVALID_PROXY_CONFIG",
    );
    expect(session.defaultSession.setProxy).not.toHaveBeenCalled();
    expect(optionStub.updateMany).not.toHaveBeenCalled();
  });

  it("restorePersistedSettings：按持久化代理重放并恢复防休眠", async () => {
    optionRows.set("proxyMode", "proxy");
    optionRows.set("proxyHost", "127.0.0.1");
    optionRows.set("proxyPort", "7890");
    optionRows.set("keepAwake", "true");
    const svc = new SettingsService();
    await svc.restorePersistedSettings();
    expect(session.defaultSession.setProxy).toHaveBeenCalledWith({
      proxyRules: "http://127.0.0.1:7890",
    });
    expect(setGlobalDispatcher).toHaveBeenCalledTimes(1);
    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
    expect(svc.getKeepAwake()).toBe(true);
  });

  it("restorePersistedSettings：无记录 → system 且不起防休眠", async () => {
    const svc = new SettingsService();
    await svc.restorePersistedSettings();
    expect(session.defaultSession.setProxy).toHaveBeenCalledWith({
      mode: "system",
    });
    expect(EnvHttpProxyAgent).toHaveBeenCalledTimes(1);
    expect(powerSaveBlocker.start).not.toHaveBeenCalled();
  });

  it("restorePersistedSettings：proxy 记录畸形 → 降级 system 不阻塞启动", async () => {
    optionRows.set("proxyMode", "proxy");
    const svc = new SettingsService();
    await svc.restorePersistedSettings();
    expect(session.defaultSession.setProxy).toHaveBeenCalledWith({
      mode: "system",
    });
  });
});

describe("autoLaunch（开机自启）读写映射", () => {
  it("get：映射 getLoginItemSettings().openAtLogin", () => {
    vi.mocked(app.getLoginItemSettings).mockReturnValue({
      openAtLogin: true,
    } as never);
    expect(new SettingsService().getAutoLaunch()).toBe(true);
    vi.mocked(app.getLoginItemSettings).mockReturnValue({
      openAtLogin: false,
    } as never);
    expect(new SettingsService().getAutoLaunch()).toBe(false);
  });

  it("set：透传 openAtLogin（OS 登录项为唯一事实源）", async () => {
    await new SettingsService().setAutoLaunch(true);
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
    });
    await new SettingsService().setAutoLaunch(false);
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: false,
    });
  });
});

describe("keepAwake（防休眠）起停幂等", () => {
  it("set(true) 两次只 start 一次；get 反映活动状态", async () => {
    const svc = new SettingsService();
    await svc.setKeepAwake(true);
    await svc.setKeepAwake(true);
    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(1);
    expect(powerSaveBlocker.start).toHaveBeenCalledWith(
      "prevent-display-sleep",
    );
    expect(svc.getKeepAwake()).toBe(true);
  });

  it("set(false) 停止并清 id；再次 set(false) 不重复 stop", async () => {
    const svc = new SettingsService();
    await svc.setKeepAwake(true);
    await svc.setKeepAwake(false);
    expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
    await svc.setKeepAwake(false);
    expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
    expect(svc.getKeepAwake()).toBe(false);
  });

  it("未启用时 set(false) 为空操作（不触 stop）", async () => {
    const svc = new SettingsService();
    await svc.setKeepAwake(false);
    expect(powerSaveBlocker.stop).not.toHaveBeenCalled();
  });

  it("blocker 被外部停止（陈旧 id）后 set(true) 重新 start", async () => {
    const svc = new SettingsService();
    await svc.setKeepAwake(true);
    psbActiveId = null; // 模拟系统层已被停止
    expect(svc.getKeepAwake()).toBe(false);
    await svc.setKeepAwake(true);
    expect(powerSaveBlocker.start).toHaveBeenCalledTimes(2);
  });

  it("起停同时持久化 keepAwake 偏好（重启恢复依据）", async () => {
    const svc = new SettingsService();
    await svc.setKeepAwake(true);
    expect(optionStub.create).toHaveBeenCalledWith({
      data: { type: "app", name: "keepAwake", value: "true" },
    });
    await svc.setKeepAwake(false);
    expect(optionStub.updateMany).toHaveBeenCalledWith({
      where: { type: "app", name: "keepAwake" },
      data: { value: "false" },
    });
  });

  it("app quit 时释放阻断器（不泄漏）", async () => {
    const svc = new SettingsService();
    await svc.setKeepAwake(true);
    const quitHandler = vi
      .mocked(app.on)
      .mock.calls.find(([event]) => event === "quit")?.[1] as () => void;
    quitHandler();
    expect(powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
    expect(svc.getKeepAwake()).toBe(false);
  });
});

describe("storageInfo", () => {
  it("diskBytesFromStatfs：blocks×bsize / bavail×bsize", () => {
    expect(
      diskBytesFromStatfs({ bsize: 4096, blocks: 100, bavail: 25 }),
    ).toEqual({ diskTotal: 409600, diskFree: 102400 });
  });

  it("computeDirSize：递归累计，跳过符号链接（含目录自环不死循环）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tianshu-settings-"));
    try {
      writeFileSync(path.join(dir, "a.txt"), Buffer.alloc(10));
      mkdirSync(path.join(dir, "sub"));
      writeFileSync(path.join(dir, "sub", "b.bin"), Buffer.alloc(100));
      symlinkSync(path.join(dir, "a.txt"), path.join(dir, "link.txt"));
      symlinkSync(dir, path.join(dir, "loop"));
      expect(await computeDirSize(fsp, dir)).toBe(110);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("computeDirSize：目录不存在返回 0（不抛错）", async () => {
    expect(
      await computeDirSize(fsp, path.join(tmpdir(), "no-such-dir-xyz")),
    ).toBe(0);
  });

  it("computeDirSize：遍历中单文件 stat 失败（删除竞态）跳过该文件仍返回其余大小", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tianshu-settings-race-"));
    try {
      writeFileSync(path.join(dir, "vanishing.log"), Buffer.alloc(10));
      writeFileSync(path.join(dir, "kept.bin"), Buffer.alloc(7));
      // stat vanishing.log 时恰被轮转删除（ENOENT 竞态）：按 0 跳过不连坐
      const fsRace: DirSizeFs = {
        readdir: (target, options) => fsp.readdir(target, options),
        stat: (target) =>
          target.endsWith("vanishing.log")
            ? Promise.reject(new Error("ENOENT"))
            : fsp.stat(target),
      };
      expect(await computeDirSize(fsRace, dir)).toBe(7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("storageInfo：真实临时目录 end-to-end（userData 递归 + 磁盘容量）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tianshu-settings-e2e-"));
    try {
      writeFileSync(path.join(dir, "db.sqlite"), Buffer.alloc(12));
      vi.mocked(app.getPath).mockReturnValue(dir);
      const info = await new SettingsService().storageInfo();
      expect(info.userDataPath).toBe(dir);
      expect(info.cacheBytes).toBe(12);
      expect(info.diskTotal).toBeGreaterThan(0);
      expect(info.diskFree).toBeGreaterThan(0);
      expect(info.diskTotal).toBeGreaterThanOrEqual(info.diskFree);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("storageInfo：statfs 失败降级 0 并记日志", async () => {
    vi.mocked(app.getPath).mockReturnValue(
      "/tmp/tianshu-settings-test-userdata",
    );
    const info = await new SettingsService().storageInfo();
    expect(info.cacheBytes).toBe(0);
    expect(info.diskTotal).toBe(0);
    expect(info.diskFree).toBe(0);
  });
});

describe("目录选择/打开与提示音", () => {
  it("pickDirectory：选中返回路径；取消返回 null", async () => {
    const svc = new SettingsService();
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: ["/some/dir"],
    } as never);
    await expect(svc.pickDirectory()).resolves.toBe("/some/dir");
    expect(dialog.showOpenDialog).toHaveBeenCalledWith({
      properties: ["openDirectory"],
    });
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: true,
      filePaths: [],
    } as never);
    await expect(svc.pickDirectory()).resolves.toBeNull();
  });

  it("openDirectory：目录透传 shell.openPath 成功；openPath 错误串转 reject；空路径拒绝", async () => {
    const svc = new SettingsService();
    const dir = mkdtempSync(path.join(tmpdir(), "tianshu-open-dir-"));
    try {
      vi.mocked(shell.openPath).mockResolvedValue("");
      await expect(svc.openDirectory(dir)).resolves.toBeUndefined();
      expect(shell.openPath).toHaveBeenCalledWith(dir);
      vi.mocked(shell.openPath).mockResolvedValue("无法打开");
      await expect(svc.openDirectory(dir)).rejects.toThrow("无法打开");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    await expect(svc.openDirectory("")).rejects.toThrow("EMPTY_PATH");
  });

  it("openDirectory：文件路径拒绝 INVALID_DIRECTORY 且不触 openPath（防可执行文件借默认处理器执行）", async () => {
    const svc = new SettingsService();
    const dir = mkdtempSync(path.join(tmpdir(), "tianshu-open-file-"));
    try {
      const file = path.join(dir, "evil.app");
      writeFileSync(file, "x");
      await expect(svc.openDirectory(file)).rejects.toThrow(
        "INVALID_DIRECTORY",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it("openDirectory：不存在的路径拒绝 INVALID_DIRECTORY 且不触 openPath", async () => {
    const svc = new SettingsService();
    await expect(
      svc.openDirectory(path.join(tmpdir(), "tianshu-open-missing")),
    ).rejects.toThrow("INVALID_DIRECTORY");
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it("beep：调用 shell.beep", () => {
    new SettingsService();
    handlerOf("settings:beep")();
    expect(shell.beep).toHaveBeenCalledTimes(1);
  });

  it("openExternal：白名单地址透传 shell.openExternal，白名单外拒绝不触副作用", async () => {
    const svc = new SettingsService();
    vi.mocked(shell.openExternal).mockResolvedValue();
    await expect(
      svc.openExternal(
        "x-apple.systempreferences:com.apple.preference.notifications",
      ),
    ).resolves.toBeUndefined();
    await expect(
      svc.openExternal("ms-settings:notifications:"),
    ).resolves.toBeUndefined();
    expect(shell.openExternal).toHaveBeenCalledTimes(2);
    expect(shell.openExternal).toHaveBeenCalledWith(
      "x-apple.systempreferences:com.apple.preference.notifications",
    );

    await expect(svc.openExternal("https://evil.example.com")).rejects.toThrow(
      "OPEN_EXTERNAL_FORBIDDEN",
    );
    await expect(svc.openExternal("")).rejects.toThrow(
      "OPEN_EXTERNAL_FORBIDDEN",
    );
    await expect(svc.openExternal(undefined)).rejects.toThrow(
      "OPEN_EXTERNAL_FORBIDDEN",
    );
    expect(shell.openExternal).toHaveBeenCalledTimes(2); // 拒绝路径不触副作用
    // IPC 通道直调同语义
    await expect(
      handlerOf("settings:openExternal")(undefined, "file:///etc/passwd"),
    ).rejects.toThrow("OPEN_EXTERNAL_FORBIDDEN");
  });
});

describe("测试通知（主进程 IPC）", () => {
  it("IPC 直调：title/body 透传主进程 Notification 构造并 show", () => {
    new SettingsService();
    handlerOf("settings:testNotification")(undefined, "天枢", "测试正文");
    expect(Notification).toHaveBeenCalledWith({
      title: "天枢",
      body: "测试正文",
    });
    expect(notificationShow).toHaveBeenCalledTimes(1);
  });

  it("系统不支持时抛 TEST_NOTIFICATION_UNSUPPORTED 且不构造不 show", () => {
    vi.mocked(Notification.isSupported).mockReturnValueOnce(false);
    const svc = new SettingsService();
    expect(() => svc.testNotification("t", "b")).toThrow(
      "TEST_NOTIFICATION_UNSUPPORTED",
    );
    expect(Notification).not.toHaveBeenCalled();
    expect(notificationShow).not.toHaveBeenCalled();
  });
});

describe("openExternal 白名单纯函数", () => {
  it("仅放行两个系统通知设置 scheme 前缀", () => {
    expect(
      isOpenExternalAllowed(
        "x-apple.systempreferences:com.apple.preference.notifications",
      ),
    ).toBe(true);
    // Windows 前缀去尾冒号后，白名单同时放行裸形式与带子页形式
    expect(isOpenExternalAllowed("ms-settings:notifications")).toBe(true);
    expect(isOpenExternalAllowed("ms-settings:notifications:")).toBe(true);
    expect(isOpenExternalAllowed("ms-settings:notifications:sound")).toBe(true);
  });

  it("非字符串/空串/http(s)/文件协议/近似前缀一律拒绝", () => {
    for (const url of [
      "",
      "http://example.com",
      "https://example.com",
      "file:///etc/passwd",
      "x-apple.systempreferences:com.apple.preference.security",
      "ms-settings:other-pane",
      123,
      null,
      undefined,
    ]) {
      expect(isOpenExternalAllowed(url)).toBe(false);
    }
  });
});

describe("IPC 通道注册与 getAll/set", () => {
  it("注册通道集合与通道名准确（前端按此消费）", () => {
    new SettingsService();
    expect([...handlers.keys()].sort()).toEqual(
      [
        "settings:getAll",
        "settings:set",
        "settings:getAutoLaunch",
        "settings:setAutoLaunch",
        "settings:getKeepAwake",
        "settings:setKeepAwake",
        "settings:setProxy",
        "settings:storageInfo",
        "settings:pickDirectory",
        "settings:openDirectory",
        "settings:beep",
        "settings:openExternal",
        "settings:testNotification",
      ].sort(),
    );
  });

  it("settings:getAll：返回 type=app 的 {name,value} 列表", async () => {
    new SettingsService();
    optionRows.set("theme", "dark");
    optionRows.set("workspacePath", "/tmp");
    await expect(handlerOf("settings:getAll")()).resolves.toEqual([
      { name: "theme", value: "dark" },
      { name: "workspacePath", value: "/tmp" },
    ]);
    expect(optionStub.findMany).toHaveBeenCalledWith({
      where: { type: "app" },
      select: { name: true, value: true },
    });
  });

  it("settings:set：走 upsert（首次 create，已存在 update）", async () => {
    new SettingsService();
    await handlerOf("settings:set")(undefined, "theme", "dark");
    expect(optionRows.get("theme")).toBe("dark");
    await handlerOf("settings:set")(undefined, "theme", "light");
    expect(optionRows.get("theme")).toBe("light");
    expect(optionStub.create).toHaveBeenCalledTimes(1);
    // upsert 每次都先探测 updateMany：首次 count=0 落 create，二次命中走更新
    expect(optionStub.updateMany).toHaveBeenCalledTimes(2);
  });
});
