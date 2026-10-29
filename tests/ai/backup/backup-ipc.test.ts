// backup-ipc 单测：registerBackupIpc 工厂式依赖注入（face/server ipc 同法）
// ——ipcMain mock 捕获 handler、注入 windows 捕获 webContents.send；
// archive/safety/restore/BackupClient 全替身（node ABI 铁律不触
// better-sqlite3 真身，不真发 HTTP）；prisma-client mock 捕获 $disconnect
// （恢复前断库裁定）。tempDir 落点断言：tianshuRoot() 直下（防 Linux
// /tmp tmpfs 跨卷 rename EXDEV），finally 全清理不残留。
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  sent: [] as Array<{ channel: string; payload: unknown }>,
  app: {
    relaunch: vi.fn(),
    exit: vi.fn(),
    // Log → ensureTianshuData 模块装载自查所需（数据根批口径同
    // file-history.test.ts：getPath 占位 /tmp，legacy 不存在 → migrate 全
    // no-op，真实数据根由 tests/setup.ts 的 TIANSHU_DATA_ROOT 隔离）
    getPath: vi.fn(() => "/tmp"),
    getAppPath: vi.fn(() => `/tmp/tianshu-test-app-${process.pid}`),
    isPackaged: false,
  },
  disconnect: vi.fn(),
}));

vi.mock(
  "electron",
  () => ({
    app: { ...mocks.app, getVersion: () => "9.9.9-test" },
    ipcMain: {
      handle: (channel: string, fn: Handler) => mocks.handlers.set(channel, fn),
    },
  }),
  { virtual: true },
);

vi.mock("../../../electron/commons/prisma-client", () => ({
  default: { $disconnect: mocks.disconnect },
}));

import { registerBackupIpc, type BackupIpcDeps } from "../../../electron/domains/backup/ipc";

/** 数据根（tests/setup.ts 注入的隔离临时根） */
const dataRoot = process.env.TIANSHU_DATA_ROOT!;

/** 列表替身行 */
const META = {
  id: "b-1",
  createdAt: "2026-10-27T08:00:00.000Z",
  appVersion: "1.0.0",
  schemaVersion: 1,
  fileSize: 12,
  sha256: "sha-abc",
  chunkCount: 1,
  status: "ready",
} as const;

/** /backup/list 完整结果替身（多用户批：viewer 声明查看者身份） */
const LIST_RESULT = {
  backups: [META],
  viewer: { kind: "admin" },
} as const;

interface DirectConn {
  id: string;
  name: string;
  mode: "direct";
  baseUrl: string;
  token?: string;
  /** 备份专用 token（可选；未配回落 token——现状单用户语义） */
  backupToken?: string;
}

const DIRECT: DirectConn = {
  id: "c1",
  name: "直连 A",
  mode: "direct",
  baseUrl: "http://127.0.0.1:3999",
  token: "tok-1",
};

/** 替身依赖工厂：calls 记录恢复链路顺序，tempDirs/archiveExisted 捕获落点 */
function makeDeps(conn: DirectConn | { id: string; mode: "relay" }) {
  const calls: string[] = [];
  const tempDirs: string[] = [];
  const ctx = {
    calls,
    tempDirs,
    archiveExisted: false,
    downloadDest: "",
    safetyTempDir: "",
    uploadArchive: vi.fn(),
    downloadArchive: vi.fn(),
    remove: vi.fn(),
  };
  const client = {
    list: vi.fn(async () => [META]),
    // 多用户批：IPC backup:list 通道用完整结果（backups+viewer——UI admin
    // 面板显隐判定）；restore 回查仍走 list
    listWithViewer: vi.fn(async () => LIST_RESULT),
    claim: vi.fn(async () => ({
      clientId: "c-claim",
      clientToken: "ct-claim",
    })),
    createInvites: vi.fn(async () => []),
    listInvites: vi.fn(async () => []),
    removeInvite: vi.fn(async (_code: string) => {}),
    listClients: vi.fn(async () => []),
    removeClient: vi.fn(async (_clientId: string) => {}),
    remove: vi.fn(async (id: string) => {
      ctx.remove(id);
    }),
    uploadArchive: vi.fn(
      async (
        archivePath: string,
        meta: { fileSize: number; sha256: string },
        onProgress?: (current: number, total: number) => void,
      ) => {
        ctx.archiveExisted = existsSync(archivePath);
        ctx.uploadArchive(meta);
        onProgress?.(40, 100);
        return { fileSize: meta.fileSize, sha256: meta.sha256 };
      },
    ),
    downloadArchive: vi.fn(
      async (
        _id: string,
        destPath: string,
        onProgress?: (current: number, total: number) => void,
      ) => {
        ctx.downloadDest = destPath;
        writeFileSync(destPath, "FAKE-TARGZ-BYTES");
        ctx.downloadArchive(destPath);
        onProgress?.(50, 100);
        return { sha256: "sha-abc" };
      },
    ),
  };
  const deps = {
    getConnection: vi.fn(async (connId: string) =>
      connId === conn.id ? conn : undefined,
    ),
    windows: () => [
      {
        webContents: {
          send: (channel: string, payload: unknown) =>
            mocks.sent.push({ channel, payload }),
        },
      },
    ],
    makeClient: vi.fn(() => client),
    archive: vi.fn(async (opts: { tempDir: string }) => {
      tempDirs.push(opts.tempDir);
      const archivePath = path.join(opts.tempDir, "backup-test.tar.gz");
      writeFileSync(archivePath, "ARCHIVE-BYTES");
      return {
        archivePath,
        meta: {
          appVersion: "1.0.0",
          schemaVersion: 1,
          fileSize: 14,
          sha256: "sha-abc",
          chunkCount: 1,
        },
        sha256: "sha-abc",
        fileCount: 3,
      };
    }),
    safety: vi.fn(async (tempDir: string) => {
      calls.push("safety");
      ctx.safetyTempDir = tempDir;
      return path.join(tempDir, "safety.tar.gz");
    }),
    restore: vi.fn(async (archivePath: string) => {
      calls.push("restore");
      ctx.downloadArchive(archivePath);
    }),
    disconnectDatabase: vi.fn(async () => {
      calls.push("disconnect");
    }),
    appVersion: () => "1.0.0",
    // 申领写回替身（backup:claim 成功把 clientToken 落连接 backupToken）
    saveConnection: vi.fn(async () => {}),
    // 本地链路路径选择器替身位（默认未装配 → 单测按需覆写走替身，
    // 不装配时 handler 落真 dialog——与 makeClient/archive 同口径）
    pickSavePath: undefined as BackupIpcDeps["pickSavePath"],
    pickArchivePath: undefined as BackupIpcDeps["pickArchivePath"],
  };
  return { deps, ctx, client };
}

function call(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error(`handler 未注册：${channel}`);
  return Promise.resolve(handler({}, ...args));
}

beforeEach(() => {
  mocks.handlers.clear();
  mocks.sent.length = 0;
  mocks.app.relaunch.mockClear();
  mocks.app.exit.mockClear();
  mocks.disconnect.mockClear();
});

describe("backup ipc", () => {
  it("backup:create：直连 → 打包 → 上传 → 返回 commit 结果（note/deviceName 注入 meta）", async () => {
    const { deps, ctx } = makeDeps(DIRECT);
    registerBackupIpc(deps);
    const result = await call("backup:create", "c1", "升级前备份");
    expect(result).toEqual({ fileSize: 14, sha256: "sha-abc" });
    // 上传收到的是 archive 替身落的真文件（传输时仍在盘上）
    expect(ctx.archiveExisted).toBe(true);
    expect(ctx.uploadArchive).toHaveBeenCalledWith({
      appVersion: "1.0.0",
      schemaVersion: 1,
      fileSize: 14,
      sha256: "sha-abc",
      chunkCount: 1,
      note: "升级前备份",
      deviceName: expect.any(String),
    });
    // tempDir 一律 tianshuRoot() 直下（防 /tmp tmpfs 跨卷 rename EXDEV）
    expect(ctx.tempDirs).toHaveLength(1);
    expect(ctx.tempDirs[0].startsWith(dataRoot)).toBe(true);
    // finally 全清理：临时目录不残留
    expect(existsSync(ctx.tempDirs[0])).toBe(false);
  });

  it("backup:create：无 note 时 meta 不携带 note 字段", async () => {
    const { deps, ctx } = makeDeps(DIRECT);
    registerBackupIpc(deps);
    await call("backup:create", "c1");
    expect(ctx.uploadArchive).toHaveBeenCalledWith(
      expect.not.objectContaining({ note: expect.anything() }),
    );
  });

  it("backup:progress 事件按阶段推送（packing → uploading，含字节回调）", async () => {
    const { deps } = makeDeps(DIRECT);
    registerBackupIpc(deps);
    await call("backup:create", "c1");
    expect(mocks.sent).toEqual([
      {
        channel: "backup:progress",
        payload: { phase: "packing", current: 0, total: 0 },
      },
      {
        channel: "backup:progress",
        payload: { phase: "uploading", current: 0, total: 14 },
      },
      {
        channel: "backup:progress",
        payload: { phase: "uploading", current: 40, total: 100 },
      },
    ]);
  });

  it("backup:restore：下载 → 断库 → 保护副本 → 恢复 → 返回 relaunchRequired", async () => {
    const { deps, ctx, client } = makeDeps(DIRECT);
    registerBackupIpc(deps);
    const result = await call("backup:restore", "c1", "b-1");
    expect(result).toEqual({ relaunchRequired: true });
    // 无第三参 → 期望 sha256 回查 list 取（与下载替身返回值一致才放行）
    expect(client.list).toHaveBeenCalledTimes(1);
    // 恢复链路顺序：断 Prisma → 保护副本（旧数据）→ 切换恢复
    expect(ctx.calls).toEqual(["disconnect", "safety", "restore"]);
    // restore 收到的正是 downloadArchive 落盘的同一路径
    expect(ctx.downloadArchive).toHaveBeenLastCalledWith(ctx.downloadDest);
    // 保护副本临时区独立 mkdtemp（数据根直下同卷纪律不变），与下载临时
    // 区 finally 各自清理（本地恢复链共用后 SafetyTempDir 不再依附下载区）
    expect(ctx.safetyTempDir.startsWith(dataRoot)).toBe(true);
    expect(path.dirname(ctx.downloadDest).startsWith(dataRoot)).toBe(true);
    expect(existsSync(ctx.safetyTempDir)).toBe(false);
    expect(existsSync(path.dirname(ctx.downloadDest))).toBe(false);
    // 事件：downloading（含字节回调）→ restoring
    const phases = mocks.sent.map((s) => s.payload);
    expect(phases).toEqual([
      { phase: "downloading", current: 0, total: 0 },
      { phase: "downloading", current: 50, total: 100 },
      { phase: "restoring", current: 0, total: 0 },
    ]);
  });

  it("backup:restore：sha256 不匹配 → 抛错且 disconnect/safety/restore 均未被调用（断库前拦截）", async () => {
    const { deps, ctx, client } = makeDeps(DIRECT);
    registerBackupIpc(deps);
    // 下载替身首调返回损坏哈希（期望值取 META.sha256，模拟传输损坏）
    client.downloadArchive.mockResolvedValueOnce({ sha256: "corrupted-sha" });
    await expect(
      call("backup:restore", "c1", "b-1", "sha-abc"),
    ).rejects.toThrow("备份校验失败：sha256 不匹配");
    expect(ctx.calls).toEqual([]);
    expect(deps.safety).not.toHaveBeenCalled();
    expect(deps.restore).not.toHaveBeenCalled();
    // 注入式断库与默认 prisma 断库均未被触发
    expect(deps.disconnectDatabase).not.toHaveBeenCalled();
    expect(mocks.disconnect).not.toHaveBeenCalled();
  });

  it("backup:restore：第三参传期望 sha256 → 匹配走通链路且不再回查 list", async () => {
    const { deps, ctx, client } = makeDeps(DIRECT);
    registerBackupIpc(deps);
    const result = await call("backup:restore", "c1", "b-1", "sha-abc");
    expect(result).toEqual({ relaunchRequired: true });
    expect(ctx.calls).toEqual(["disconnect", "safety", "restore"]);
    expect(client.list).not.toHaveBeenCalled();
  });

  it("backup:restore：无第三参且 list 查无该备份 → 报错且不动本地数据", async () => {
    const { deps, ctx, client } = makeDeps(DIRECT);
    registerBackupIpc(deps);
    client.list.mockResolvedValueOnce([]);
    await expect(call("backup:restore", "c1", "ghost")).rejects.toThrow(
      /备份不存在/,
    );
    expect(ctx.calls).toEqual([]);
  });

  it("backup:restore：默认断库走 prisma.$disconnect（未注入 disconnectDatabase 时）", async () => {
    const { deps } = makeDeps(DIRECT);
    const { disconnectDatabase, ...rest } = deps;
    void disconnectDatabase;
    registerBackupIpc(rest);
    await call("backup:restore", "c1", "b-1");
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
  });

  it("relay 连接拒绝（错误含「仅支持直连」）且不落临时目录", async () => {
    const relay = { id: "r1", mode: "relay" as const };
    const { deps } = makeDeps(relay);
    registerBackupIpc(deps);
    await expect(call("backup:list", "r1")).rejects.toThrow(/仅支持直连/);
    await expect(call("backup:create", "r1")).rejects.toThrow(/仅支持直连/);
    await expect(call("backup:restore", "r1", "b-1")).rejects.toThrow(
      /仅支持直连/,
    );
    // 拒绝发生在 mkdtemp 之前：数据根无 .backup- 残留
    const residue = readdirSync(dataRoot).filter((name) =>
      name.startsWith(".backup-"),
    );
    expect(residue).toEqual([]);
  });

  it("连接不存在 → 报错", async () => {
    const { deps } = makeDeps(DIRECT);
    registerBackupIpc(deps);
    await expect(call("backup:list", "ghost")).rejects.toThrow(/连接不存在/);
    expect(deps.getConnection).toHaveBeenCalledWith("ghost");
  });

  it("backup:list / backup:delete 透传 BackupClient（list 含 viewer——UI admin 判定）", async () => {
    const { deps, client } = makeDeps(DIRECT);
    registerBackupIpc(deps);
    await expect(call("backup:list", "c1")).resolves.toEqual(LIST_RESULT);
    await expect(call("backup:delete", "c1", "b-1")).resolves.toBeUndefined();
    expect(client.listWithViewer).toHaveBeenCalledWith();
    expect(client.remove).toHaveBeenCalledWith("b-1");
  });

  it("backupToken 优先：连接配了 backupToken 时 makeClient 收到它而非远控 token", async () => {
    const conn: DirectConn = {
      id: "c1",
      name: "直连 B",
      mode: "direct",
      baseUrl: "http://x",
      token: "remote-tok",
      backupToken: "backup-tok",
    };
    const { deps } = makeDeps(conn);
    registerBackupIpc(deps);
    await call("backup:list", "c1");
    expect(deps.makeClient).toHaveBeenCalledWith("http://x", "backup-tok");
  });

  it("backup:claim：大门 token 调 claim → clientToken 写回连接 backupToken", async () => {
    const { deps, client } = makeDeps(DIRECT);
    client.claim = vi.fn(async () => ({
      clientId: "new-imac",
      clientToken: "ct-123",
    }));
    registerBackupIpc(deps);
    const r = await call("backup:claim", "c1", "TS-ABCD2345", "new-imac");
    expect(r).toEqual({ clientId: "new-imac" });
    expect(client.claim).toHaveBeenCalledWith("TS-ABCD2345", "new-imac");
    expect(deps.saveConnection).toHaveBeenCalledWith("c1", {
      backupToken: "ct-123",
    });
  });

  it("backup:claim 失败（邀请码无效）透错且不写回", async () => {
    const { deps, client } = makeDeps(DIRECT);
    client.claim = vi.fn(async () => {
      throw new Error("业务错 code=BACKUP_INVITE_INVALID 邀请码无效或已被使用");
    });
    registerBackupIpc(deps);
    await expect(
      call("backup:claim", "c1", "TS-BADCODE0", "x"),
    ).rejects.toThrow(/BACKUP_INVITE_INVALID|邀请码无效/);
    expect(deps.saveConnection).not.toHaveBeenCalled();
  });

  it("backup:claim 走大门 token：已配 backupToken 的连接仍以 conn.token 建客户端", async () => {
    const conn: DirectConn = {
      id: "c1",
      name: "直连 C",
      mode: "direct",
      baseUrl: "http://x",
      token: "gateway-tok",
      backupToken: "client-tok",
    };
    const { deps, client } = makeDeps(conn);
    client.claim = vi.fn(async () => ({
      clientId: "d1",
      clientToken: "ct-9",
    }));
    registerBackupIpc(deps);
    await call("backup:claim", "c1", "TS-ABCD2345", "d1");
    // 申领时无客户端身份（backupToken 是本调用的产物），凭据必须是
    // 大门 token——否则已申领连接二次申领会拿 clientToken 被 server 拒
    expect(deps.makeClient).toHaveBeenCalledWith("http://x", "gateway-tok");
    expect(deps.saveConnection).toHaveBeenCalledWith("c1", {
      backupToken: "ct-9",
    });
  });

  it("backup:claim：未装配 saveConnection 时成功申领但写回报「未装配」错", async () => {
    const { deps, client } = makeDeps(DIRECT);
    const { saveConnection, ...rest } = deps;
    void saveConnection;
    client.claim = vi.fn(async () => ({
      clientId: "d2",
      clientToken: "ct-x",
    }));
    registerBackupIpc(rest);
    await expect(
      call("backup:claim", "c1", "TS-ABCD2345", "d2"),
    ).rejects.toThrow(/未装配/);
  });

  it("管理通道透传：invites:create|list|delete 与 clients:list|delete", async () => {
    const { deps, client } = makeDeps(DIRECT);
    client.createInvites = vi.fn(async () => [
      { code: "TS-ABCD2345", createdAt: "2026-10-28T00:00:00.000Z" },
    ]);
    client.listInvites = vi.fn(async () => [
      {
        code: "TS-ABCD2345",
        createdAt: "2026-10-28T00:00:00.000Z",
        usedAt: "2026-10-28T01:00:00.000Z",
        usedBy: "new-imac",
      },
    ]);
    client.listClients = vi.fn(async () => [
      { clientId: "new-imac", createdAt: "2026-10-28T01:00:00.000Z" },
    ]);
    registerBackupIpc(deps);
    // create（count+note 透传；返回邀请码行）
    await expect(
      call("backup:invites:create", "c1", 3, "新设备"),
    ).resolves.toEqual([
      { code: "TS-ABCD2345", createdAt: "2026-10-28T00:00:00.000Z" },
    ]);
    expect(client.createInvites).toHaveBeenCalledWith(3, "新设备");
    // list（含核销状态行）
    await expect(call("backup:invites:list", "c1")).resolves.toEqual([
      {
        code: "TS-ABCD2345",
        createdAt: "2026-10-28T00:00:00.000Z",
        usedAt: "2026-10-28T01:00:00.000Z",
        usedBy: "new-imac",
      },
    ]);
    expect(client.listInvites).toHaveBeenCalledWith();
    // delete（撤销邀请码）
    await expect(
      call("backup:invites:delete", "c1", "TS-ABCD2345"),
    ).resolves.toBeUndefined();
    expect(client.removeInvite).toHaveBeenCalledWith("TS-ABCD2345");
    // clients:list / clients:delete（踢除）
    await expect(call("backup:clients:list", "c1")).resolves.toEqual([
      { clientId: "new-imac", createdAt: "2026-10-28T01:00:00.000Z" },
    ]);
    expect(client.listClients).toHaveBeenCalledWith();
    await expect(
      call("backup:clients:delete", "c1", "new-imac"),
    ).resolves.toBeUndefined();
    expect(client.removeClient).toHaveBeenCalledWith("new-imac");
  });

  it("管理通道与数据面同链：已配 backupToken 的连接调管理通道时 makeClient 收到 backupToken", async () => {
    // 二层部署态（server 设 TIANSHU_BACKUP_TOKEN）：admin 手填该值到连接
    // backupToken——面板可见（数据面 list 走 backupToken）即须可操作
    // （管理面同链），走大门 conn.token 会被 BackupGuard 401
    const conn: DirectConn = {
      id: "c1",
      name: "直连 D",
      mode: "direct",
      baseUrl: "http://x",
      token: "gateway-tok",
      backupToken: "admin-backup-tok",
    };
    const { deps } = makeDeps(conn);
    registerBackupIpc(deps);
    await call("backup:invites:create", "c1", 2, "二层部署");
    await call("backup:invites:list", "c1");
    await call("backup:invites:delete", "c1", "TS-ABCD2345");
    await call("backup:clients:list", "c1");
    await call("backup:clients:delete", "c1", "new-imac");
    expect(deps.makeClient).toHaveBeenCalledTimes(5);
    for (const [baseUrl, token] of deps.makeClient.mock.calls) {
      expect(baseUrl).toBe("http://x");
      expect(token).toBe("admin-backup-tok");
    }
  });

  it("未配 backupToken 回落 token（现状兼容）", async () => {
    const { deps } = makeDeps(DIRECT);
    registerBackupIpc(deps);
    await call("backup:list", "c1");
    expect(deps.makeClient).toHaveBeenCalledWith(
      "http://127.0.0.1:3999",
      "tok-1",
    );
  });

  it("backup:relaunch：app.relaunch + app.exit(0) 薄封装", () => {
    const { deps } = makeDeps(DIRECT);
    registerBackupIpc(deps);
    expect(call("backup:relaunch")).resolves.toBeUndefined();
    expect(mocks.app.relaunch).toHaveBeenCalledTimes(1);
    expect(mocks.app.exit).toHaveBeenCalledWith(0);
  });
});

describe("backup 本地链路（无服务端）", () => {
  /** 真实 sha256 的 archive 替身（本地链路 copy 后要对拍真哈希，替身
   *  meta 不能伪造——与远端链路替身「sha-abc 假值」的关键差异） */
  function realArchiveStub(
    tempDirs: string[],
    bytes: string,
    sha256Override?: string,
  ) {
    return vi.fn(async (opts: { tempDir: string }) => {
      tempDirs.push(opts.tempDir);
      const archivePath = path.join(opts.tempDir, `backup-test.tar.gz`);
      writeFileSync(archivePath, bytes);
      return {
        archivePath,
        meta: {
          appVersion: "1.0.0",
          schemaVersion: 1,
          fileSize: Buffer.byteLength(bytes),
          sha256: sha256Override ?? createHash("sha256").update(bytes).digest("hex"),
          chunkCount: 1,
        },
        sha256: sha256Override ?? createHash("sha256").update(bytes).digest("hex"),
        fileCount: 2,
      };
    });
  }

  it("backup:create:local：选路径 → 打包 → 复制+sha256 对拍 → 返回产物；全程不碰连接", async () => {
    const { deps } = makeDeps(DIRECT);
    const tempDirs: string[] = [];
    const bytes = "LOCAL-ARCHIVE-BYTES";
    const sha = createHash("sha256").update(bytes).digest("hex");
    deps.archive = realArchiveStub(tempDirs, bytes);
    // 用户选的保存路径（任意可写目录——模拟外置盘/下载目录）
    const destDir = mkdtempSync(path.join(dataRoot, "local-dest-"));
    const dest = path.join(destDir, "my-backup.tar.gz");
    deps.pickSavePath = vi.fn(async () => dest);
    registerBackupIpc(deps);
    const result = await call("backup:create:local");
    expect(result).toEqual({
      destPath: dest,
      fileSize: Buffer.byteLength(bytes),
      sha256: sha,
    });
    // 目标文件内容与打包产物一致
    expect(readFileSync(dest, "utf8")).toBe(bytes);
    // 打包临时区在数据根直下（同卷纪律）且 finally 全清理
    expect(tempDirs).toHaveLength(1);
    expect(tempDirs[0].startsWith(dataRoot)).toBe(true);
    expect(existsSync(tempDirs[0])).toBe(false);
    // 事件只有 packing 一相（本地链路无上传）
    expect(mocks.sent.map((s) => s.payload)).toEqual([
      { phase: "packing", current: 0, total: 0 },
    ]);
    // 无服务端铁证：连接注册表零访问
    expect(deps.getConnection).not.toHaveBeenCalled();
  });

  it("backup:create:local：sha256 对拍失败 → 删目标坏档并抛错（不留假备份）", async () => {
    const { deps } = makeDeps(DIRECT);
    deps.archive = realArchiveStub([], "BYTES", "lying-sha");
    const destDir = mkdtempSync(path.join(dataRoot, "local-dest-"));
    const dest = path.join(destDir, "bad.tar.gz");
    deps.pickSavePath = vi.fn(async () => dest);
    registerBackupIpc(deps);
    await expect(call("backup:create:local")).rejects.toThrow(
      "备份校验失败：sha256 不匹配",
    );
    // 坏档必须删除——留在盘上会被当真备份用
    expect(existsSync(dest)).toBe(false);
  });

  it("backup:create:local：取消选择返回 null——不打包、不推事件", async () => {
    const { deps } = makeDeps(DIRECT);
    deps.pickSavePath = vi.fn(async () => null);
    registerBackupIpc(deps);
    await expect(call("backup:create:local")).resolves.toBeNull();
    expect(deps.archive).not.toHaveBeenCalled();
    expect(mocks.sent).toEqual([]);
  });

  it("backup:restore:local：选档案 → restoring 事件 → 断库 → 保护副本 → 恢复选中路径；全程不碰连接", async () => {
    const { deps, ctx } = makeDeps(DIRECT);
    const archiveDir = mkdtempSync(path.join(dataRoot, "local-archive-"));
    const archiveFile = path.join(archiveDir, "backup.tar.gz");
    writeFileSync(archiveFile, "BYTES");
    deps.pickArchivePath = vi.fn(async () => archiveFile);
    registerBackupIpc(deps);
    const result = await call("backup:restore:local");
    expect(result).toEqual({ relaunchRequired: true });
    // 恢复链路顺序与远端一致：断 Prisma → 保护副本 → 切换恢复
    expect(ctx.calls).toEqual(["disconnect", "safety", "restore"]);
    // restore 收到的正是用户选中的本地档案路径
    expect(deps.restore).toHaveBeenCalledWith(archiveFile);
    // 事件只有 restoring 一相（本地链路无下载）
    expect(mocks.sent.map((s) => s.payload)).toEqual([
      { phase: "restoring", current: 0, total: 0 },
    ]);
    // 无服务端铁证：连接注册表零访问
    expect(deps.getConnection).not.toHaveBeenCalled();
  });

  it("backup:restore:local：取消选择返回 null——断库/保护副本/恢复零调用", async () => {
    const { deps, ctx } = makeDeps(DIRECT);
    deps.pickArchivePath = vi.fn(async () => null);
    registerBackupIpc(deps);
    await expect(call("backup:restore:local")).resolves.toBeNull();
    expect(ctx.calls).toEqual([]);
    expect(mocks.sent).toEqual([]);
  });

  it("backup:restore:local：档案不存在 → 断库前拦截报错（零损伤）", async () => {
    const { deps, ctx } = makeDeps(DIRECT);
    deps.pickArchivePath = vi.fn(
      async () => path.join(dataRoot, "ghost.tar.gz"),
    );
    registerBackupIpc(deps);
    await expect(call("backup:restore:local")).rejects.toThrow(
      /备份档案不存在/,
    );
    expect(ctx.calls).toEqual([]);
    expect(deps.safety).not.toHaveBeenCalled();
    expect(deps.restore).not.toHaveBeenCalled();
  });
});
