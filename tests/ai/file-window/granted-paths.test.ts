/**
 * 会话级路径授权清单（spec 2026-10-14 §6.4，library AI 直改地基）：
 * - granted-paths：注册/同步读取/会话回收/持久化往返（新实例懒加载恢复）
 * - file-gate：makeFileDecider 第 3 参 grantedOf 命中 → "default"
 *   （在 extraBuiltin 数据根判定之前；数据根内其余路径保护不变）
 * - resolveSafePath：extraAllowed 白名单放行 workspace 外授权路径
 *   （realpath 归一比对），未授权仍抛 PATH_OUTSIDE_WORKSPACE
 * - runToolCall 链路：授权路径 read 直读（无审批）、write
 *   直执行免审（权限放宽 2026-10-24 spec §4.4——审批面只剩文件门 block）
 * 传递依赖：electron（file-tools 顶层 shell / Log 与 ipc-user 链）与
 * prisma-client 经 vi.mock 替换（file-write.test / chat.service.test 同款）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  // ipcMain/app：Log 与 ipc-user 顶层依赖；shell：file-tools 顶层（运行时才用）
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: {
    getPath: vi.fn(() => `/tmp/tianshu-fw-grant-user-data-${process.pid}`),
    getAppPath: vi.fn(() => `/tmp/tianshu-fw-grant-app-${process.pid}`),
    isPackaged: false,
  },
  shell: { trashItem: vi.fn() },
}));

// option 表行集 + 落盘失败开关（真实唯一键为 type+name+userId（T28 起
// grantedPaths 落 userId 维度，每用户一行）：upsert 走 updateMany 命中
// 0 行则 create，同 option-store 手法；mock 模拟该语义，行含 userId）
// + session/workspace 行集（grant/revoke 归属校验、删除级联回收）
// + 加载失败开关（findFirst 拒绝）
const { optionRows, persistFail, loadFail, sessionRows, workspaceRows } =
  vi.hoisted(() => {
    const optionRows: Array<{
      type: string;
      name: string;
      userId: number | null;
      value: string;
    }> = [];
    const persistFail = { on: false };
    const loadFail = { on: false };
    const sessionRows: Array<{ id: number; userId: number }> = [];
    const workspaceRows: Array<{ id: number; userId: number }> = [];
    return { optionRows, persistFail, loadFail, sessionRows, workspaceRows };
  });

vi.mock("../../../electron/commons/prisma-client", () => ({
  default: {
    workspace: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: number; userId: number } }) =>
          workspaceRows.find(
            (w) => w.id === where.id && w.userId === where.userId,
          ) ?? null,
      ),
      delete: vi.fn(async () => ({})),
    },
    session: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: number; userId: number } }) =>
          sessionRows.find(
            (s) => s.id === where.id && s.userId === where.userId,
          ) ?? null,
      ),
      // deleteWorkspace 级联回收（T28 spec §16 项 1）：返回带 userId 的行
      findMany: vi.fn(async () => sessionRows),
      delete: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    message: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    automationRun: { updateMany: vi.fn(async () => ({ count: 0 })) },
    // deleteSession 原子清理（数组形态顺序执行，同 session-repo.test）
    $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => {
      for (const op of ops) {
        await op;
      }
    }),
    option: {
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { type: string; name: string; userId: number | null };
        }) => {
          if (loadFail.on) throw new Error("db offline");
          return (
            optionRows.find(
              (r) =>
                r.type === where.type &&
                r.name === where.name &&
                r.userId === where.userId,
            ) ?? null
          );
        },
      ),
      updateMany: vi.fn(
        async (p: {
          where: { type: string; name: string; userId: number | null };
          data: { value: string };
        }) => {
          if (persistFail.on) throw new Error("db locked");
          const row = optionRows.find(
            (r) =>
              r.type === p.where.type &&
              r.name === p.where.name &&
              r.userId === p.where.userId,
          );
          if (!row) return { count: 0 };
          row.value = p.data.value;
          return { count: 1 };
        },
      ),
      create: vi.fn(
        async (p: {
          data: {
            type: string;
            name: string;
            userId: number | null;
            value: string;
          };
        }) => {
          if (persistFail.on) throw new Error("db locked");
          optionRows.push(p.data);
          return p.data;
        },
      ),
    },
  },
}));

const handleUserMock = vi.hoisted(() => vi.fn());
vi.mock("../../../electron/commons/ipc-user", () => ({
  handleUser: (ch: string, fn: (...args: unknown[]) => unknown) =>
    handleUserMock(ch, fn),
}));

// 纯函数模块静态引入；granted-paths 带模块级缓存，每用例 resetModules
// 后动态引入取新实例（持久化往返用例借同手法模拟进程重启）
import {
  makeFileTool,
  resolveSafePath,
} from "../../../electron/domains/ai/agent/file-tools";
import {
  runToolCall,
  type AgentStreamOptions,
} from "../../../electron/domains/ai/agent/tool-gate";
import { makeFileDecider } from "../../../electron/domains/security/file-gate";
import type { FileAccessDecision } from "../../../electron/domains/security/file-policy";
import { SECURITY_DEFAULTS } from "../../../electron/domains/security/defaults";
import type { SecurityConfig } from "../../../src-react/domains/security/model/types";
import type * as GrantedPathsModule from "../../../electron/domains/ai/file-window/granted-paths";

const GRANTED_PATHS_PATH =
  "../../../electron/domains/ai/file-window/granted-paths";
const GRANTED_PATHS_IPC_PATH =
  "../../../electron/domains/ai/file-window/granted-paths-ipc";

let gp: typeof GrantedPathsModule;
let ws = "";
let libDir = "";
let grantedFile = "";

beforeEach(async () => {
  optionRows.length = 0;
  persistFail.on = false;
  loadFail.on = false;
  sessionRows.length = 0;
  workspaceRows.length = 0;
  handleUserMock.mockReset();
  vi.resetModules();
  gp = (await import(GRANTED_PATHS_PATH)) as typeof GrantedPathsModule;
  // mkdtemp 真实目录：resolveSafePath 内 realpathSync 需路径存在
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "fw-grant-ws-"));
  libDir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-grant-lib-"));
  grantedFile = path.join(libDir, "1.md");
  fs.writeFileSync(grantedFile, "hello");
});

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(libDir, { recursive: true, force: true });
});

describe("授权清单 granted-paths", () => {
  it("注册后同步/异步可查（幂等），会话回收清空且会话间隔离", async () => {
    await gp.grantFilePath(5, grantedFile, 1);
    expect(await gp.grantedPathsOf(5, 1)).toEqual([grantedFile]);
    expect(gp.grantedSyncOf(5, 1)).toEqual([grantedFile]);
    expect(gp.grantedSetSync().has(grantedFile)).toBe(true);
    // 重复注册幂等
    await gp.grantFilePath(5, grantedFile, 1);
    expect(await gp.grantedPathsOf(5, 1)).toEqual([grantedFile]);
    // 其他会话不共享
    expect(gp.grantedSyncOf(6, 1)).toEqual([]);
    await gp.revokeSession(5, 1);
    expect(await gp.grantedPathsOf(5, 1)).toEqual([]);
    expect(gp.grantedSetSync().has(grantedFile)).toBe(false);
  });

  it("多用户隔离（T28 spec §16 项 2）：两用户授权互不可见、各落各 option 行", async () => {
    const user1File = grantedFile;
    const user2File = path.join(libDir, "2.md");
    fs.writeFileSync(user2File, "x");
    await gp.grantFilePath(5, user1File, 1);
    await gp.grantFilePath(6, user2File, 2);
    // 各自查各的：互不可见（同会话 id 维度亦然——真实场景 session id 全局
    // 唯一，此处用不同 id 模拟两用户各的会话）
    expect(await gp.grantedPathsOf(5, 1)).toEqual([user1File]);
    expect(gp.grantedSyncOf(6, 2)).toEqual([user2File]);
    expect(gp.grantedSyncOf(6, 1)).toEqual([]);
    expect(await gp.grantedPathsOf(5, 2)).toEqual([]);
    // 落盘每用户一行（option 唯一键 type+name+userId），各行只含本用户授权
    const row1 = optionRows.find((r) => r.userId === 1);
    const row2 = optionRows.find((r) => r.userId === 2);
    expect(row1?.value).toContain(user1File);
    expect(row1?.value).not.toContain(user2File);
    expect(row2?.value).toContain(user2File);
    expect(row2?.value).not.toContain(user1File);
    // gate 联合集（grantedSetSync）跨用户命中——gate 单例无用户维度，
    // 仅做黑名单放宽，访问控制由 resolveSafePath 每会话清单承担（见头注释）
    expect(gp.grantedSetSync().has(user1File)).toBe(true);
    expect(gp.grantedSetSync().has(user2File)).toBe(true);
    // 回收各归各：用户 2 回收不影响用户 1（含 gate 联合集收敛）
    await gp.revokeSession(6, 2);
    expect(gp.grantedSyncOf(6, 2)).toEqual([]);
    expect(gp.grantedSyncOf(5, 1)).toEqual([user1File]);
    expect(gp.grantedSetSync().has(user2File)).toBe(false);
    expect(gp.grantedSetSync().has(user1File)).toBe(true);
  });

  it("未加载时同步查询视为无授权（fail-safe）；持久化往返新实例可读", async () => {
    await gp.grantFilePath(5, grantedFile, 1);
    const row = optionRows.find(
      (r) =>
        r.type === "fileWindow" && r.name === "grantedPaths" && r.userId === 1,
    );
    expect(row?.value).toContain(grantedFile);
    // 模拟重启：模块缓存清空，懒加载完成前同步查询 fail-safe 为空
    vi.resetModules();
    const fresh = (await import(
      GRANTED_PATHS_PATH
    )) as typeof GrantedPathsModule;
    expect(fresh.grantedSyncOf(5, 1)).toEqual([]);
    // 异步读触发懒加载（恢复 DB 态）
    expect(await fresh.grantedPathsOf(5, 1)).toEqual([grantedFile]);
    // 加载完成后同步侧可见（gate / 工具闭包消费口径）
    expect(fresh.grantedSyncOf(5, 1)).toEqual([grantedFile]);
    // 重启后其他用户读不到（按 userId 行隔离）
    expect(await fresh.grantedPathsOf(5, 2)).toEqual([]);
  });

  it("落盘失败不阻塞：内存态即时生效且 grant 不抛错", async () => {
    persistFail.on = true;
    await expect(gp.grantFilePath(5, grantedFile, 1)).resolves.toBe(null);
    expect(gp.grantedSyncOf(5, 1)).toEqual([grantedFile]);
  });

  it("加载失败不固化空缓存：persist 跳过——已落盘快照不被空清单洗掉", async () => {
    // 既有授权已落盘（模拟上一进程的持久化快照）
    await gp.grantFilePath(5, grantedFile, 1);
    const row = () =>
      optionRows.find(
        (r) =>
          r.type === "fileWindow" &&
          r.name === "grantedPaths" &&
          r.userId === 1,
      );
    const snapshotBefore = row()?.value;
    expect(snapshotBefore).toContain(grantedFile);
    // 新进程：懒加载失败（DB 抖动）→ 内存空清单（fail-safe），但随后
    // grant/revoke 的 persist 跳过——快照原样保留
    vi.resetModules();
    loadFail.on = true;
    const fresh = (await import(
      GRANTED_PATHS_PATH
    )) as typeof GrantedPathsModule;
    await expect(fresh.grantedPathsOf(5, 1)).resolves.toEqual([]);
    await fresh.grantFilePath(6, grantedFile, 1);
    expect(row()?.value).toBe(snapshotBefore); // 未被空清单 + {"6":[…]} 覆盖
    // 内存态不受影响（fail-safe 读写照常）
    expect(fresh.grantedSyncOf(6, 1)).toEqual([grantedFile]);
  });

  it("IPC：fileWindow:grantFilePath 注册 handler 并委托 grantFilePath（归属校验 + trim）", async () => {
    sessionRows.push({ id: 9, userId: 1 });
    const { registerGrantedPathsIpc } = await import(GRANTED_PATHS_IPC_PATH);
    registerGrantedPathsIpc();
    expect(handleUserMock.mock.calls.at(-2)?.[0]).toBe(
      "fileWindow:grantFilePath",
    );
    expect(handleUserMock.mock.calls.at(-1)?.[0]).toBe(
      "fileWindow:revokeSession",
    );
    const handler = handleUserMock.mock.calls.at(-2)?.[1] as (
      event: unknown,
      userId: number,
      p: { sessionId: number; absPath: string },
    ) => Promise<null>;
    await handler({}, 1, { sessionId: 9, absPath: grantedFile });
    expect(gp.grantedSyncOf(9, 1)).toEqual([grantedFile]);
    // 首尾空白 trim 后 resolve（isAbsolute 判定与登记路径一致）
    await handler({}, 1, { sessionId: 9, absPath: `  ${grantedFile}  ` });
    expect(gp.grantedSyncOf(9, 1)).toEqual([grantedFile]);
    // 相对路径拒绝（防脏数据入库——授权清单按绝对路径口径比对）；
    // handler 同步抛出，生产侧由 handleUser 的 async 包装转为 IPC 拒绝
    await expect(
      handler({}, 1, { sessionId: 9, absPath: "rel/1.md" }),
    ).rejects.toThrow();
    // 会话归属校验：他人会话/不存在会话拒绝注册
    await expect(
      handler({}, 2, { sessionId: 9, absPath: grantedFile }),
    ).rejects.toThrow("SESSION_NOT_FOUND");
    await expect(
      handler({}, 1, { sessionId: 99, absPath: grantedFile }),
    ).rejects.toThrow("SESSION_NOT_FOUND");
  });

  it("IPC：fileWindow:revokeSession 归属校验 + 会话授权回收", async () => {
    sessionRows.push({ id: 9, userId: 1 });
    const { registerGrantedPathsIpc } = await import(GRANTED_PATHS_IPC_PATH);
    registerGrantedPathsIpc();
    const grantHandler = handleUserMock.mock.calls.find(
      (c) => c[0] === "fileWindow:grantFilePath",
    )?.[1] as (
      event: unknown,
      userId: number,
      p: { sessionId: number; absPath: string },
    ) => Promise<null>;
    await grantHandler({}, 1, { sessionId: 9, absPath: grantedFile });
    expect(gp.grantedSyncOf(9, 1)).toEqual([grantedFile]);
    const revokeHandler = handleUserMock.mock.calls.find(
      (c) => c[0] === "fileWindow:revokeSession",
    )?.[1] as (
      event: unknown,
      userId: number,
      p: { sessionId: number },
    ) => Promise<null>;
    // 他人会话/不存在会话拒绝
    await expect(revokeHandler({}, 2, { sessionId: 9 })).rejects.toThrow(
      "SESSION_NOT_FOUND",
    );
    await expect(revokeHandler({}, 1, { sessionId: 8 })).rejects.toThrow(
      "SESSION_NOT_FOUND",
    );
    expect(gp.grantedSyncOf(9, 1)).toEqual([grantedFile]);
    await expect(revokeHandler({}, 1, { sessionId: 9 })).resolves.toBe(null);
    expect(gp.grantedSyncOf(9, 1)).toEqual([]);
  });

  it("会话删除回收授权（T28 spec §16 项 1）：deleteSession 后 grantedPathsOf 空", async () => {
    sessionRows.push({ id: 9, userId: 1 });
    await gp.grantFilePath(9, grantedFile, 1);
    expect(await gp.grantedPathsOf(9, 1)).toEqual([grantedFile]);
    // 真实 SessionRepository.deleteSession（主进程内直连，不加通道）
    const { SessionRepository } =
      await import("../../../electron/domains/ai/chat/session.repo");
    await new SessionRepository().deleteSession(9, 1);
    expect(await gp.grantedPathsOf(9, 1)).toEqual([]);
    expect(gp.grantedSyncOf(9, 1)).toEqual([]);
    // 落盘同步洗掉（重启后不复活）
    expect(optionRows.find((r) => r.userId === 1)?.value ?? "{}").not.toContain(
      grantedFile,
    );
  });

  it("工作空间删除级联回收授权（T28 spec §16 项 1）：随会话行清空", async () => {
    workspaceRows.push({ id: 7, userId: 1 });
    sessionRows.push({ id: 9, userId: 1 }, { id: 10, userId: 1 });
    await gp.grantFilePath(9, grantedFile, 1);
    await gp.grantFilePath(10, grantedFile, 1);
    const { SessionRepository } =
      await import("../../../electron/domains/ai/chat/session.repo");
    await new SessionRepository().deleteWorkspace(7, 1);
    expect(await gp.grantedPathsOf(9, 1)).toEqual([]);
    expect(await gp.grantedPathsOf(10, 1)).toEqual([]);
  });
});

describe("resolveSafePath 白名单", () => {
  it("授权路径放行（workspace 外返回 resolve 值）；workspace 内照旧", () => {
    expect(resolveSafePath(ws, grantedFile, false, [grantedFile])).toBe(
      grantedFile,
    );
    fs.writeFileSync(path.join(ws, "a.md"), "x");
    expect(resolveSafePath(ws, "a.md", false, [grantedFile])).toBe(
      path.join(ws, "a.md"),
    );
  });

  it("未授权仍拒（清单外路径不越界放行）", () => {
    expect(() =>
      resolveSafePath(ws, path.join(libDir, "2.md"), false, [grantedFile]),
    ).toThrow("PATH_OUTSIDE_WORKSPACE");
  });

  it("realpath 归一：symlink 文字形态差异仍放行", () => {
    const link = path.join(os.tmpdir(), `fw-grant-link-${process.pid}.md`);
    let linked = true;
    try {
      fs.symlinkSync(grantedFile, link);
    } catch {
      linked = false; // Windows 无符号链接特权时跳过（平台限制）
    }
    if (!linked) return;
    try {
      expect(resolveSafePath(ws, link, false, [grantedFile])).toBe(link);
    } finally {
      fs.rmSync(link, { force: true });
    }
  });
});

describe("file-gate 授权命中", () => {
  const config = (): SecurityConfig => ({ ...SECURITY_DEFAULTS });

  it("命中授权 → default（extraBuiltin 数据根不再拦）；未授权/未接线照旧 block", async () => {
    await gp.grantFilePath(5, grantedFile, 1);
    const decide = makeFileDecider(config, [libDir], (absPath) =>
      gp.isPathGrantedSync(absPath),
    );
    expect(decide(grantedFile, ws)).toBe("default");
    // 数据根内其余路径仍拦
    expect(decide(path.join(libDir, "2.md"), ws)).toBe("block");
    // 未传 grantedOf（既有装配兼容）：授权路径也照旧拦——授权必须显式接线
    expect(makeFileDecider(config, [libDir])(grantedFile, ws)).toBe("block");
  });
});

describe("runToolCall 链路（授权双层放行落地）", () => {
  function makeAgent(over: Partial<AgentStreamOptions>): AgentStreamOptions {
    return {
      sessionId: 5,
      workspacePath: ws,
      fullAccess: () => false,
      isToolAllowed: async () => false,
      requestApproval: async () => true,
      grantedPaths: () => gp.grantedSyncOf(5, 1),
      ...over,
    };
  }

  it("read 授权路径直读（无审批），gate 收到 workspace 外绝对路径", async () => {
    await gp.grantFilePath(5, grantedFile, 1);
    const decideFileAccess = vi.fn((): FileAccessDecision => "default");
    const agent = makeAgent({ decideFileAccess });
    const out = await runToolCall(
      makeFileTool("read"),
      agent,
      "t1",
      { path: grantedFile },
      undefined,
    );
    // resolveFileGate 透传授权清单：越界路径成功 resolve 并到达 gate
    expect(decideFileAccess).toHaveBeenCalledWith(grantedFile, ws);
    expect(out).toContain("hello");
  });

  it("write 授权路径：直执行免审（权限放宽 spec §4.4），写盘成功", async () => {
    await gp.grantFilePath(5, grantedFile, 1);
    const approvals: string[] = [];
    const agent = makeAgent({
      requestApproval: async (id) => {
        approvals.push(id);
        return true;
      },
    });
    const out = await runToolCall(
      makeFileTool("write"),
      agent,
      "t2",
      { path: grantedFile, content: "改写" },
      undefined,
    );
    // 授权路径 gate=default 非 block：直执行不挂审批（审批面只剩 block）
    expect(approvals).toHaveLength(0);
    expect(out).toContain("已写入");
    expect(fs.readFileSync(grantedFile, "utf8")).toBe("改写");
  });

  it("read 未授权路径：越界拒绝回喂（不触审批）", async () => {
    await gp.grantFilePath(5, grantedFile, 1);
    const approvals: string[] = [];
    const agent = makeAgent({
      requestApproval: async (id) => {
        approvals.push(id);
        return true;
      },
    });
    const out = await runToolCall(
      makeFileTool("read"),
      agent,
      "t3",
      { path: path.join(libDir, "2.md") },
      undefined,
    );
    expect(out).toContain("路径超出工作空间范围");
    expect(approvals).toHaveLength(0);
  });
});
