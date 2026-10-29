/**
 * writeWorkspaceFile（纯逻辑）：正常写/建目录/mtime 基线冲突/新建语义
 * FILE_EXISTS/备份回调 fail-open。FileWriteIpc（handler）：归属校验、
 * 路径围栏（终审 I1：绝对路径/../ 越界与 symlink 外指拒绝）、备份注入、
 * 写后全窗广播 workspace:fileChanged；broadcastFileChangedFor：AI
 * write 写盘路径的广播闭包（absPath 反解 relPath，分隔符统一 "/"）。
 * 事件消费侧（文件窗 tab 重载/脏冲突）由 T12 联动测试覆盖。
 * notifyLibraryFileWritten（T14 修复轮 Important 1）：AI 直改库路径 →
 * bump 条目 updatedAt/size + fileWindow:libraryChanged 广播；非库路径
 * no-op；条目缺失不广播；bump 失败仍广播（读侧重载兜底）。
 * 传递依赖：electron（BrowserWindow/Log 链）与 prisma-client 经 vi.mock
 * 替换（file-window.service.test / permissions-integration 同款模式）。
 */
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockWins } = vi.hoisted(() => {
  interface MockWin {
    destroyed: boolean;
    sent: Array<{ channel: string; payload: unknown }>;
    isDestroyed(): boolean;
    webContents: { send(channel: string, payload: unknown): void };
  }
  const mockWins: MockWin[] = [];
  return { mockWins };
});

vi.mock("electron", () => ({
  // Log 顶层依赖 app（isPackaged/getPath）与 ipcMain
  app: {
    on: vi.fn(),
    getPath: vi.fn(() => "/tmp"),
    getAppPath: vi.fn(() => `/tmp/tianshu-test-app-${process.pid}`),
    isPackaged: false,
  },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => mockWins },
}));

vi.mock("../../../electron/commons/prisma-client", () => ({
  default: {
    workspace: { findFirst: vi.fn() },
    libraryItem: { updateMany: vi.fn() },
  },
}));

const handleUserMock = vi.hoisted(() => vi.fn());
vi.mock("../../../electron/commons/ipc-user", () => ({
  handleUser: (ch: string, fn: (...args: unknown[]) => unknown) =>
    handleUserMock(ch, fn),
}));

import prisma from "../../../electron/commons/prisma-client";
import { writeWorkspaceFile } from "../../../electron/domains/ai/chat/workspace-files";
import FileWriteIpc, {
  broadcastFileChanged,
  broadcastFileChangedFor,
  notifyLibraryFileWritten,
} from "../../../electron/domains/ai/file-window/file-write-ipc";
import { libraryDir } from "../../../electron/commons/paths";
import type { FileHistoryService } from "../../../electron/domains/security/file-history";

async function tmpWs() {
  return mkdtemp(path.join(tmpdir(), "fw-write-"));
}

/** 造一枚假窗口（destroyed 可控），返回其 send 收件箱 */
function pushMockWin(destroyed = false) {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  mockWins.push({
    destroyed,
    sent,
    isDestroyed: () => destroyed,
    webContents: {
      send: (channel, payload) => sent.push({ channel, payload }),
    },
  });
  return sent;
}

describe("writeWorkspaceFile", () => {
  it("写入并返回 mtime；自动建父目录", async () => {
    const ws = await tmpWs();
    const r = await writeWorkspaceFile(ws, {
      relPath: "sub/a.md",
      content: "hi",
      baselineMtime: null,
    });
    expect(await readFile(path.join(ws, "sub/a.md"), "utf8")).toBe("hi");
    expect(r.mtime).toBeGreaterThan(0);
  });

  it("基线不符抛 FILE_CONFLICT", async () => {
    const ws = await tmpWs();
    await writeFile(path.join(ws, "a.md"), "旧");
    const mtime = (await stat(path.join(ws, "a.md"))).mtimeMs;
    await writeFile(path.join(ws, "a.md"), "外部已改");
    await expect(
      writeWorkspaceFile(ws, {
        relPath: "a.md",
        content: "我的",
        baselineMtime: mtime,
      }),
    ).rejects.toThrow("FILE_CONFLICT");
  });

  it("覆盖已有文件先调备份回调；备份失败不阻断写盘（fail-open）", async () => {
    const ws = await tmpWs();
    await writeFile(path.join(ws, "a.md"), "旧");
    const backup = vi.fn().mockRejectedValue(new Error("备份盘满"));
    await writeWorkspaceFile(
      ws,
      { relPath: "a.md", content: "新", baselineMtime: null },
      { backupFile: backup },
    );
    expect(backup).toHaveBeenCalledWith(path.join(ws, "a.md"));
    expect(await readFile(path.join(ws, "a.md"), "utf8")).toBe("新");
  });

  it("新建语义（expectNotExists）：磁盘已有同名抛 FILE_EXISTS 不覆写", async () => {
    const ws = await tmpWs();
    await writeFile(path.join(ws, "未命名-1.md"), "磁盘既有");
    await expect(
      writeWorkspaceFile(ws, {
        relPath: "未命名-1.md",
        content: "",
        baselineMtime: null,
        expectNotExists: true,
      }),
    ).rejects.toThrow("FILE_EXISTS");
    expect(await readFile(path.join(ws, "未命名-1.md"), "utf8")).toBe(
      "磁盘既有",
    );
  });

  it("新建语义：磁盘无同名正常写入（expectNotExists 不拦新路径）", async () => {
    const ws = await tmpWs();
    const r = await writeWorkspaceFile(ws, {
      relPath: "未命名-2.md",
      content: "",
      baselineMtime: null,
      expectNotExists: true,
    });
    expect(r.mtime).toBeGreaterThan(0);
    expect(await readFile(path.join(ws, "未命名-2.md"), "utf8")).toBe("");
  });
});

describe("broadcastFileChanged / broadcastFileChangedFor", () => {
  it("全窗广播 workspace:fileChanged，跳过 destroyed 窗口", () => {
    const live = pushMockWin();
    pushMockWin(true);
    broadcastFileChanged(7, "sub/a.md");
    expect(live).toEqual([
      {
        channel: "workspace:fileChanged",
        payload: { workspaceId: 7, path: "sub/a.md" },
      },
    ]);
  });

  it('AI 写盘闭包：absPath 反解 relPath（分隔符统一 "/"）并绑定 workspaceId', () => {
    const sent = pushMockWin();
    const sink = broadcastFileChangedFor(9, path.join(tmpdir(), "ws-root"));
    // path.join 产出宿主分隔符（win32 为 "\"），广播 payload 恒为 "/"
    sink(path.join(path.join(tmpdir(), "ws-root"), "sub", "a.md"));
    expect(sent).toEqual([
      {
        channel: "workspace:fileChanged",
        payload: { workspaceId: 9, path: "sub/a.md" },
      },
    ]);
  });
});

describe("notifyLibraryFileWritten（AI 直改库文件联动，T14 修复轮）", () => {
  const updateMany = prisma.libraryItem.updateMany as unknown as ReturnType<
    typeof vi.fn
  >;

  beforeEach(() => {
    updateMany.mockReset();
  });

  it("库路径：按 <itemId> 首段寻址 bump updatedAt/size + 全窗广播 fileWindow:libraryChanged", async () => {
    // 真实落盘（tests/setup 已隔离数据根）：size 经 fs.stat 回填
    const file = path.join(libraryDir(), "3", "note.md");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "AI 改写");
    updateMany.mockResolvedValue({ count: 1 });
    const sent = pushMockWin();
    await expect(notifyLibraryFileWritten(file)).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 3, kind: "file" },
      data: {
        updatedAt: expect.any(Date),
        size: Buffer.byteLength("AI 改写", "utf8"),
      },
    });
    expect(sent).toEqual([
      { channel: "fileWindow:libraryChanged", payload: { itemId: 3 } },
    ]);
  });

  it("非库路径 → false 不联动（调用方回落空间维度广播）", async () => {
    await expect(
      notifyLibraryFileWritten(path.join(tmpdir(), "elsewhere", "a.md")),
    ).resolves.toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("条目不存在（count=0）不广播；bump 失败仍广播（读侧重载兜底）", async () => {
    const file = path.join(libraryDir(), "99", "x.md");
    updateMany.mockResolvedValue({ count: 0 });
    const sent = pushMockWin();
    await expect(notifyLibraryFileWritten(file)).resolves.toBe(true);
    expect(sent).toHaveLength(0);
    updateMany.mockRejectedValue(new Error("db locked"));
    await expect(notifyLibraryFileWritten(file)).resolves.toBe(true);
    expect(sent).toEqual([
      { channel: "fileWindow:libraryChanged", payload: { itemId: 99 } },
    ]);
  });
});

describe("FileWriteIpc（workspace:writeFile handler）", () => {
  type Handler = (
    event: unknown,
    userId: number,
    ...args: unknown[]
  ) => unknown;
  const handlers = new Map<string, Handler>();

  beforeEach(() => {
    mockWins.length = 0;
    handlers.clear();
    handleUserMock.mockImplementation((ch: string, fn: Handler) =>
      handlers.set(ch, fn),
    );
    handleUserMock.mockClear();
  });

  const invoke = (userId: number, p: unknown) => {
    const fn = handlers.get("workspace:writeFile");
    if (!fn) throw new Error("handler 未注册");
    return fn({}, userId, p);
  };

  const findFirst = prisma.workspace.findFirst as unknown as ReturnType<
    typeof vi.fn
  >;

  function newIpc(backupEnabled: boolean) {
    const backup = vi.fn(async () => ({ ok: true, size: 1 }));
    new FileWriteIpc({
      fileHistory: { backupFile: backup } as unknown as FileHistoryService,
      fileBackupEnabled: () => backupEnabled,
    });
    return backup;
  }

  it("归属校验：工作空间不存在/非本人 → WORKSPACE_NOT_FOUND，不触写盘", async () => {
    newIpc(false);
    findFirst.mockResolvedValue(null);
    await expect(
      invoke(1, {
        workspaceId: 7,
        path: "a.md",
        content: "x",
        baselineMtime: null,
      }),
    ).rejects.toThrow("WORKSPACE_NOT_FOUND");
  });

  it("覆盖写：备份回调（sessionId=0 手动保存）+ 写盘 + 全窗广播", async () => {
    const ws = await tmpWs();
    await writeFile(path.join(ws, "a.md"), "旧");
    findFirst.mockResolvedValue({ directoryPath: ws });
    const backup = newIpc(true);
    const sent = pushMockWin();
    const r = (await invoke(1, {
      workspaceId: 7,
      path: "a.md",
      content: "新",
      baselineMtime: null,
    })) as { absPath: string; mtime: number };
    expect(await readFile(path.join(ws, "a.md"), "utf8")).toBe("新");
    expect(r.absPath).toBe(path.join(ws, "a.md"));
    expect(r.mtime).toBeGreaterThan(0);
    expect(backup).toHaveBeenCalledWith(path.join(ws, "a.md"), 0);
    expect(sent).toEqual([
      {
        channel: "workspace:fileChanged",
        payload: { workspaceId: 7, path: "a.md" },
      },
    ]);
  });

  it("备份开关关闭：不备份仍写盘广播；基线冲突上抛 FILE_CONFLICT", async () => {
    const ws = await tmpWs();
    findFirst.mockResolvedValue({ directoryPath: ws });
    const backup = newIpc(false);
    const sent = pushMockWin();
    await invoke(1, {
      workspaceId: 7,
      path: "b/c.md",
      content: "hi",
      baselineMtime: null,
    });
    expect(backup).not.toHaveBeenCalled();
    expect(sent[0]?.payload).toEqual({ workspaceId: 7, path: "b/c.md" });

    // 磁盘 mtime 与基线不符 → 冲突上抛，不写盘不广播
    sent.length = 0;
    await expect(
      invoke(1, {
        workspaceId: 7,
        path: "b/c.md",
        content: "again",
        baselineMtime: 12345,
      }),
    ).rejects.toThrow("FILE_CONFLICT");
    expect(sent).toHaveLength(0);
  });

  it("路径围栏（终审 I1）：绝对路径与 ../ 越界拒绝，不触写盘不广播", async () => {
    const ws = await tmpWs();
    findFirst.mockResolvedValue({ directoryPath: ws });
    newIpc(false);
    const sent = pushMockWin();
    await expect(
      invoke(1, {
        workspaceId: 7,
        path: path.join(tmpdir(), "fw-evil", "a.md"),
        content: "x",
        baselineMtime: null,
      }),
    ).rejects.toThrow("PATH_OUTSIDE_WORKSPACE");
    await expect(
      invoke(1, {
        workspaceId: 7,
        path: "../escape.md",
        content: "x",
        baselineMtime: null,
      }),
    ).rejects.toThrow("PATH_OUTSIDE_WORKSPACE");
    // 子目录内 ../.. 归一后仍在空间外
    await expect(
      invoke(1, {
        workspaceId: 7,
        path: "sub/../../escape.md",
        content: "x",
        baselineMtime: null,
      }),
    ).rejects.toThrow("PATH_OUTSIDE_WORKSPACE");
    expect(existsSync(path.join(tmpdir(), "fw-evil"))).toBe(false);
    expect(existsSync(path.join(path.dirname(ws), "escape.md"))).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("路径围栏 realpath 复检：空间内 symlink 目录外指 → 展开后越界拒绝", async () => {
    const ws = await tmpWs();
    const outside = await tmpWs();
    await mkdir(path.join(ws, "sub"), { recursive: true });
    await symlink(outside, path.join(ws, "sub", "link-out"));
    findFirst.mockResolvedValue({ directoryPath: ws });
    newIpc(false);
    await expect(
      invoke(1, {
        workspaceId: 7,
        path: "sub/link-out/evil.md",
        content: "x",
        baselineMtime: null,
      }),
    ).rejects.toThrow("PATH_OUTSIDE_WORKSPACE");
    expect(existsSync(path.join(outside, "evil.md"))).toBe(false);
  });

  it("新建语义（终审 I2）：expectNotExists 透传，磁盘撞名 FILE_EXISTS 换名可写", async () => {
    const ws = await tmpWs();
    await writeFile(path.join(ws, "未命名-1.md"), "磁盘既有");
    findFirst.mockResolvedValue({ directoryPath: ws });
    newIpc(false);
    await expect(
      invoke(1, {
        workspaceId: 7,
        path: "未命名-1.md",
        content: "",
        baselineMtime: null,
        expectNotExists: true,
      }),
    ).rejects.toThrow("FILE_EXISTS");
    expect(await readFile(path.join(ws, "未命名-1.md"), "utf8")).toBe(
      "磁盘既有",
    );
    const r = (await invoke(1, {
      workspaceId: 7,
      path: "未命名-2.md",
      content: "",
      baselineMtime: null,
      expectNotExists: true,
    })) as { mtime: number };
    expect(r.mtime).toBeGreaterThan(0);
  });
});
