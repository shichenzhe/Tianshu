/**
 * H7a 性能回归：产物结构化表——write_file 产物落 artifact 表（消息落库时
 * 提取登记），产物面板查表替代 blocks LIKE 全表扫（消息上千后每次打开
 * 面板都是 O(全表) 同步扫描，见性能审查报告 H7）；历史数据首查回填一次
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  dialog: { showSaveDialog: vi.fn() },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn() },
  // Log/prisma-client 顶层读取 app.getPath/getAppPath/isPackaged
  // 计算日志与数据目录（data-root 冷迁移链路）
  app: {
    getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`),
    getAppPath: vi.fn(() => `/tmp/tianshu-test-app-${process.pid}`),
    isPackaged: false,
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

// stat 包装：恒存在普通文件（存在性语义由真实 stat 承担，此处解除 IO 依赖）
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const stat = vi.fn(async () => ({ isFile: () => true, size: 100 }));
  return { ...actual, stat, default: { ...actual, stat } };
});

const db = vi.hoisted(() => ({
  sessions: [] as Array<{
    id: number;
    workspaceId: number;
    userId: number | null;
    title: string;
  }>,
  workspaces: [] as Array<{
    id: number;
    name: string;
    directoryPath: string | null;
  }>,
  messages: [] as Array<{
    id: number;
    sessionId: number;
    role: string;
    blocks: string;
    createdAt: Date;
  }>,
  artifacts: [] as Array<{
    userId: number;
    workspaceId: number;
    sessionId: number;
    relPath: string;
    createdAt: Date;
  }>,
  options: new Map<string, string>(),
  messageFindMany: vi.fn(),
}));

vi.mock("../../electron/commons/prisma-client", () => {
  const artifactUpsert = vi.fn(
    async ({
      create,
    }: {
      where?: unknown;
      create: {
        userId: number;
        workspaceId: number;
        sessionId: number;
        relPath: string;
      };
    }) => {
      const key = `${create.userId}:${create.workspaceId}:${create.relPath}`;
      const idx = db.artifacts.findIndex(
        (a) => `${a.userId}:${a.workspaceId}:${a.relPath}` === key,
      );
      if (idx === -1) {
        db.artifacts.push({ ...create, createdAt: new Date() });
      } else {
        db.artifacts[idx]!.createdAt = new Date();
      }
      return null;
    },
  );
  return {
    default: {
      message: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = {
            id: db.messages.length + 1,
            sessionId: data.sessionId as number,
            role: data.role as string,
            blocks: data.blocks as string,
            createdAt: new Date(),
          };
          db.messages.push(row);
          return row;
        },
        // 旧 LIKE 路径（回填消费）：含 write_file 的消息
        findMany: db.messageFindMany.mockImplementation(
          async (args?: { where?: { sessionId?: { in: number[] } } }) => {
            const ids = args?.where?.sessionId?.in;
            return db.messages.filter(
              (m) =>
                m.blocks.includes("write_file") &&
                (ids === undefined || ids.includes(m.sessionId)),
            );
          },
        ),
        update: vi.fn(),
      },
      session: {
        findFirst: async ({ where }: { where: { id: number } }) =>
          db.sessions.find((s) => s.id === where.id) ?? null,
        findMany: async ({
          where,
        }: {
          where: { userId?: number; id?: { in: number[] } };
        }) =>
          db.sessions.filter(
            (s) =>
              (where.userId === undefined || s.userId === where.userId) &&
              (where.id?.in === undefined || where.id.in.includes(s.id)),
          ),
        update: vi.fn(async () => null),
      },
      workspace: {
        findMany: async () => db.workspaces,
      },
      artifactFavorite: { findMany: async () => [] },
      artifact: {
        findMany: async ({ where }: { where: { userId: number } }) =>
          db.artifacts.filter((a) => a.userId === where.userId),
        upsert: artifactUpsert,
      },
      option: {
        findMany: async () =>
          [...db.options.entries()].map(([name, value]) => ({
            type: "app",
            name,
            value,
          })),
        // setAppOption 先 updateMany，count=0 时 create 兜底新建
        updateMany: vi.fn(async () => ({ count: 0 })),
        create: vi.fn(
          async ({ data }: { data: { name: string; value: string } }) => {
            db.options.set(data.name, data.value);
            return null;
          },
        ),
      },
    },
  };
});

import { SessionRepository } from "../../electron/domains/ai/chat/session.repo";

const writeToolBlocks = (relPath: string) =>
  JSON.stringify([
    {
      type: "tool_call",
      toolCallId: "tc1",
      toolName: "write_file",
      args: { path: relPath },
      state: "done",
    },
  ]);

beforeEach(() => {
  db.sessions = [{ id: 1, workspaceId: 10, userId: 1, title: "会话一" }];
  db.workspaces = [{ id: 10, name: "默认空间", directoryPath: "/ws-root" }];
  db.messages = [];
  db.artifacts = [];
  db.options = new Map();
  db.messageFindMany.mockClear();
});

describe("appendMessage 产物登记（H7a）", () => {
  it("assistant 消息落库后登记 write_file 产物（去重键 userId+workspace+relPath）", async () => {
    const repo = new SessionRepository();
    await repo.appendMessage({
      sessionId: 1,
      role: "assistant",
      blocks: writeToolBlocks("docs/a.md"),
    } as never);
    await vi.waitFor(() => {
      expect(db.artifacts).toHaveLength(1);
    });
    expect(db.artifacts[0]).toMatchObject({
      userId: 1,
      workspaceId: 10,
      sessionId: 1,
      relPath: "docs/a.md",
    });
  });

  it("普通 user 消息不登记", async () => {
    const repo = new SessionRepository();
    await repo.appendMessage({
      sessionId: 1,
      role: "user",
      blocks: JSON.stringify([{ type: "text", text: "你好" }]),
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(db.artifacts).toHaveLength(0);
  });
});

describe("listArtifacts 数据源切表（H7a）", () => {
  it("回填标记已置时查 artifact 表，不再 LIKE 扫消息表", async () => {
    db.options.set("artifact.backfilled.1", "1");
    db.artifacts = [
      {
        userId: 1,
        workspaceId: 10,
        sessionId: 1,
        relPath: "out/report.md",
        createdAt: new Date("2026-09-01T00:00:00Z"),
      },
    ];
    const repo = new SessionRepository();
    const items = await repo.listArtifacts(1);
    expect(db.messageFindMany).not.toHaveBeenCalled();
    expect(items.some((i) => i.relPath === "out/report.md")).toBe(true);
  });

  it("首次调用（无标记）回填历史消息并置 per-user 标记", async () => {
    db.messages = [
      {
        id: 1,
        sessionId: 1,
        role: "assistant",
        blocks: writeToolBlocks("legacy/old.txt"),
        createdAt: new Date("2026-08-01T00:00:00Z"),
      },
    ];
    const repo = new SessionRepository();
    const items = await repo.listArtifacts(1);
    expect(db.messageFindMany).toHaveBeenCalled();
    expect(db.artifacts.some((a) => a.relPath === "legacy/old.txt")).toBe(true);
    expect(db.options.get("artifact.backfilled.1")).toBe("1");
    expect(items.some((i) => i.relPath === "legacy/old.txt")).toBe(true);
  });
});
