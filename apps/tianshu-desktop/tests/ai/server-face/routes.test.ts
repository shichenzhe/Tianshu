// 被控面路由表（server-face spec §3.1 / T11+T12）：handleRoute 分发查询
// 端点与 send/abort 桥——info capability 协商 + session create/query/
// getById/delete 闭环；响应包装与 tianshu-server starter 同构：成功
// {code:"2000",success:true,data,message:"success"}（业务错 HTTP 200 +
// {code:"4040",success:false,...}，控制端查 body.success 勿只看 res.ok
// ——T3/T4 契约注记）。send 桥流式侧（SSE/relay 事件帧）见
// server-face.test.ts；路由表纯函数无 IO 依赖：sessions 仓储/用户解析经
// deps 注入内存替身。
import { afterEach, describe, expect, it, vi } from "vitest";

// routes（T12 起）经 face-events → chat-tap → Log 引 electron；仅取静态
// 形状，行为断言不受影响（webhook/session-repo 测试同款 mock 口径）。
// UD-T1 起另挂 BrowserWindow.getAllWindows 主窗替身（hoisted 态，各用例
// 注入窗口列表——首个为主窗：主窗先建不变式，graph-executor
// notifyNodeStatus 同源取窗口径）。
const electronWindows = vi.hoisted(() => ({
  current: [] as unknown[],
}));

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: {
    getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`),
    getAppPath: vi.fn(() => `/tmp/tianshu-test-app-${process.pid}`),
    isPackaged: false,
  },
  BrowserWindow: { getAllWindows: () => electronWindows.current },
}));
vi.mock("../../../electron/commons/Log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { handleRoute } from "../../../electron/domains/server-face/routes";
import { onFaceEvent } from "../../../electron/domains/server-face/face-events";
import { FaceLibraryError } from "../../../electron/domains/server-face/library-tap";
import { FaceProjectError } from "../../../electron/domains/server-face/project-tap";
import { FacePermissionError } from "../../../electron/domains/server-face/permission-tap";
import { FaceWorkspaceError } from "../../../electron/domains/server-face/workspace-tap";
import {
  setServerFaceDeps,
  faceDeps,
  type ServerFaceSessions,
} from "../../../electron/domains/server-face/deps";
import type {
  MessageRecord,
  SessionCreateParams,
  SessionRecord,
} from "../../../src-react/domains/ai/api/session.api";
import {
  ENDPOINTS,
  type LibraryItemDto,
  type MonitorStats,
} from "@tianshu/protocol";

const MONITOR_STATS: MonitorStats = {
  today: {
    inputTokens: 120,
    outputTokens: 80,
    llmCalls: 4,
    toolCalls: 2,
    toolSuccessRate: 1,
  },
  trend: [
    {
      date: "2026-10-25",
      inputTokens: 120,
      outputTokens: 80,
      llmCalls: 4,
      toolCalls: 2,
    },
  ],
  byModel: [
    {
      modelId: 3,
      name: "测试模型",
      calls: 4,
      inputTokens: 120,
      outputTokens: 80,
    },
  ],
  tools: [
    {
      toolName: "Read",
      total: 2,
      done: 2,
      denied: 0,
      error: 0,
      avgDurationMs: 12,
      successRate: 1,
    },
  ],
};

/** 被控面单用户语义（user 表首个）的测试替身 id */
const UID = 7;

/** 内存版 sessions 仓储（结构子集，SessionRepository 同构） */
interface FakeSession {
  id: number;
  userId: number;
  workspaceId: number;
  title: string;
  archivedAt: Date | null;
  updatedAt: Date;
  /** A11 时间筛选批：活动时间主键（缺省回退 updatedAt） */
  lastMessageAt?: Date | null;
  /** CU 批模式切换桩（setMode 写入；断言直查） */
  mode?: "agent" | "ask" | "plan";
  /** P1 未读角标批：已读游标桩（markSessionRead 单调推进；断言直查） */
  lastReadMessageId?: number | null;
}

function toRecord(row: FakeSession): SessionRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    mode: "agent",
    createdAt: row.updatedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.archivedAt ? { archivedAt: row.archivedAt.toISOString() } : {}),
    ...(row.lastMessageAt
      ? { lastMessageAt: row.lastMessageAt.toISOString() }
      : {}),
  };
}

function makeFakeSessions() {
  let nextId = 1;
  const rows = new Map<number, FakeSession>();
  const messages = new Map<number, MessageRecord[]>();
  /** P1 未读角标批：FakeSession → enriched 摘要（未读=游标后 assistant 条数；
   *  末条摘要 kind/text 为确定性桩——routes 层只验形状透传，摘要在 core
   *  纯函数单测全边界覆盖） */
  const toSummary = (row: FakeSession) => {
    const msgs = messages.get(row.id) ?? [];
    const last = msgs[msgs.length - 1];
    const cursor = row.lastReadMessageId ?? 0;
    return {
      ...toRecord(row),
      unreadCount: msgs.filter((m) => m.role === "assistant" && m.id > cursor)
        .length,
      lastMessage: last
        ? {
            id: last.id,
            role: last.role,
            kind: "text" as const,
            text: last.blocks,
            createdAt: last.createdAt,
          }
        : null,
    };
  };
  const sessions: ServerFaceSessions = {
    async getSession(id) {
      return rows.get(id) ?? null;
    },
    async createSession(p: SessionCreateParams, userId) {
      const row: FakeSession = {
        id: nextId++,
        userId,
        workspaceId: p.workspaceId ?? 0,
        title: p.title ?? "新会话",
        archivedAt: null,
        updatedAt: new Date(),
      };
      rows.set(row.id, row);
      messages.set(row.id, []);
      return toRecord(row);
    },
    async listAllSessions(userId) {
      return [...rows.values()]
        .filter((row) => row.userId === userId)
        .map(toRecord);
    },
    // P1 未读角标批：enriched 数据源替身
    async listAllSessionsSummarized(userId) {
      return [...rows.values()]
        .filter((row) => row.userId === userId)
        .map(toSummary);
    },
    // face 全表扫描优化批：querySessions 替身（与 repo 同语义：条件下推
    // 过滤 + 固定三键排序 + keyword 大小写敏感内存过滤 + 过滤后分页）
    querySessions: vi.fn(async (params, userId) => {
      const page = Math.max(1, Math.trunc(params.page ?? 1));
      const pageSize = Math.min(
        500,
        Math.max(1, Math.trunc(params.pageSize ?? 100)),
      );
      const list = [...rows.values()]
        .filter((row) => row.userId === userId)
        .filter((row) =>
          params.workspaceId != null
            ? row.workspaceId === params.workspaceId
            : true,
        )
        .filter((row) =>
          typeof params.archived === "boolean"
            ? Boolean(row.archivedAt) === params.archived
            : true,
        )
        .filter((row) =>
          params.activityAfter
            ? new Date(row.lastMessageAt ?? row.updatedAt).getTime() >=
              params.activityAfter.getTime()
            : true,
        )
        // 固定三键排序对齐 repo：pinnedAt/lastMessageAt desc（null 居尾，
        // SQLite DESC 语义）→ id desc 次键；FakeSession 无 pinnedAt 字段
        //（替身缺省 null），lastMessageAt 缺省回退 null
        .sort((a, b) => {
          const ka = [a.lastMessageAt?.getTime() ?? null, a.id];
          const kb = [b.lastMessageAt?.getTime() ?? null, b.id];
          for (let i = 0; i < 2; i += 1) {
            const x = ka[i];
            const y = kb[i];
            if (x === y) continue;
            if (x === null) return 1; // null 居尾
            if (y === null) return -1;
            return (y as number) - (x as number); // desc
          }
          return 0;
        })
        .filter((row) =>
          params.keyword ? (row.title ?? "").includes(params.keyword) : true,
        );
      const total = list.length;
      const records = list
        .slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize)
        .map(toSummary);
      return { page, pageSize, records, total };
    }),
    async getSessionSummary(id, userId) {
      const row = rows.get(id);
      if (!row || row.userId !== userId) return null;
      return toSummary(row);
    },
    async markSessionRead(sessionId, messageId, userId) {
      const row = rows.get(sessionId);
      if (!row || row.userId !== userId) throw new Error("SESSION_NOT_FOUND");
      const msgs = messages.get(sessionId) ?? [];
      if (!msgs.some((m) => m.id === messageId)) {
        throw new Error("SESSION_NOT_FOUND");
      }
      // 单调推进替身：更小/相等不回退（与 repo updateMany 条件写同语义）
      if (row.lastReadMessageId == null || row.lastReadMessageId < messageId) {
        row.lastReadMessageId = messageId;
      }
      const cursor = row.lastReadMessageId;
      return {
        sessionId,
        lastReadMessageId: cursor,
        unreadCount: msgs.filter((m) => m.role === "assistant" && m.id > cursor)
          .length,
      };
    },
    async getSessionById(id, userId) {
      const row = rows.get(id);
      if (!row || row.userId !== userId) throw new Error("SESSION_NOT_FOUND");
      return toRecord(row);
    },
    async deleteSession(id, userId) {
      const row = rows.get(id);
      if (!row || row.userId !== userId) throw new Error("SESSION_NOT_FOUND");
      rows.delete(id);
    },
    async renameSession(id, title, userId) {
      const row = rows.get(id);
      if (!row || row.userId !== userId) throw new Error("SESSION_NOT_FOUND");
      row.title = title;
    },
    async setMode(id, mode, userId) {
      const row = rows.get(id);
      if (!row || row.userId !== userId) throw new Error("SESSION_NOT_FOUND");
      (row as FakeSession & { mode?: string }).mode = mode;
    },
    async archiveSession(id, archived, userId) {
      const row = rows.get(id);
      if (!row || row.userId !== userId) throw new Error("SESSION_NOT_FOUND");
      row.archivedAt = archived ? new Date() : null;
    },
    async listMessages(sessionId, userId) {
      const row = rows.get(sessionId);
      if (!row || row.userId !== userId) throw new Error("SESSION_NOT_FOUND");
      return {
        items: [...(messages.get(sessionId) ?? [])],
        hasMore: false,
        nextBeforeId: null,
      };
    },
  };
  const seed = (title: string, overrides: Partial<FakeSession> = {}) => {
    const row: FakeSession = {
      id: nextId++,
      userId: UID,
      workspaceId: 3,
      title,
      archivedAt: null,
      updatedAt: new Date(),
      ...overrides,
    };
    rows.set(row.id, row);
    messages.set(row.id, []);
    return row;
  };
  return { sessions, rows, messages, seed };
}

/** 记忆批 memory 面替身状态（用例断言 get 返回值同源） */
const MEMORY_STATE = {
  enabled: true,
  profile: "### 工作背景",
  modelId: 5,
  lastCompiledAt: null,
  lastError: null,
};

/** CRUD 批 automation 面替身行（用例断言 wireDeps().save 返回值同源） */
const TASK_ROW = {
  id: 7,
  name: "任务甲",
  prompt: "p",
  workspaceId: 3,
  workspaceName: "默认",
  source: "local",
  modelId: 0,
  targetKind: "prompt",
  graphId: null,
  eventJson: null,
  scheduleJson: "{}",
  scheduleText: "s",
  missedPolicy: "skip",
  accessMode: "default",
  enabled: true,
  status: "active",
  projectId: null,
  createdAt: "2026-10-27T00:00:00.000Z",
  updatedAt: "2026-10-27T00:00:00.000Z",
};

function wireDeps(
  overrides: Partial<ReturnType<typeof makeFakeSessions>> = {},
  options: { resolveDefaultWorkspaceId?: () => Promise<number | null> } = {},
) {
  const fake = { ...makeFakeSessions(), ...overrides };
  // send mock 返回 Promise：handleSend 的 setImmediate 分支链 .then/.catch
  // （vi.fn() 缺省返回 undefined 会让 .then 炸成 uncaught——存量隐性错误，
  // 本批顺手修，vitest 进程退出码恢复 0）
  const chat = {
    send: vi.fn(async () => {}),
    regenerate: vi.fn(async () => {}),
    editAndResend: vi.fn(async () => {}),
    // A9 批：compact 桥（202 异步）+ polish 桥（同步 30s）
    compact: vi.fn(async () => {}),
    polish: vi.fn(async () => ({ text: "润色结果" })),
    getUsageBreakdown: vi.fn(async () => ({
      system: 100,
      tools: 50,
      messages: 200,
      mcp: 0,
      skills: 0,
      total: 350,
      contextWindow: 8192,
    })),
    getAccessMode: vi.fn(async () => "default" as const),
    setAccessMode: vi.fn(async () => {}),
    stop: vi.fn(),
  };
  // 模型面/专家面替身（FA 批新路由）：providers 删除/拉取、assistants 列表
  const providers = {
    listBundle: vi.fn(async () => ({ providers: [], models: [] })),
    save: vi.fn(async () => ({ providers: [], models: [] })),
    deleteProviders: vi.fn(async () => {}),
    deleteModels: vi.fn(async () => {}),
    listRemote: vi.fn(async () => ({
      success: true,
      message: "",
      models: [{ modelId: "gpt-x" }],
    })),
  };
  const assistants = {
    list: vi.fn(async () => [{ id: 1, name: "专家A", icon: "🧠" }]),
  };
  const skills = {
    list: vi.fn(async () => [{ name: "code-review", description: "代码审查" }]),
    read: vi.fn(async () => ({ content: "# 代码审查技能全文" })),
  };
  const workspaces = {
    list: vi.fn(async () => [
      { id: 3, name: "默认工作空间", directoryPath: "/ws", defaultModelId: 7 },
    ]),
    // A8 写面替身：create/update 概要四字段回传；remove 记录删除
    create: vi.fn(
      async (_userId: number, payload: { name: string; icon?: string }) => ({
        id: 9,
        name: payload.name,
        directoryPath: null,
        defaultModelId: null,
      }),
    ),
    update: vi.fn(
      async (
        _userId: number,
        payload: { id: number; name?: string; defaultModelId?: number },
      ) => ({
        id: payload.id,
        name: payload.name ?? "改名后",
        directoryPath: "/ws",
        defaultModelId: payload.defaultModelId ?? 7,
      }),
    ),
    remove: vi.fn(async (_userId: number, _id: number) => undefined),
  };
  const mcps = {
    list: vi.fn(async () => [
      {
        id: 5,
        name: "filesystem",
        transport: "stdio",
        command: "npx fs-server",
        url: null,
        enabled: true,
      },
    ]),
    setEnabled: vi.fn(async () => undefined),
  };
  // A10 审批记忆面替身：五段记录调用（归属/排序/幂等语义在 tap/service
  // 单测覆盖，路由层只验信封/形状校验/码透传/未装配）
  const permissions = {
    listRemembered: vi.fn(async () => [
      {
        id: 3,
        workspaceName: "默认工作空间",
        toolName: "write",
        createdAt: "2026-10-26T00:00:00.000Z",
      },
    ]),
    revokeRemembered: vi.fn(async () => null),
    revokeAllRemembered: vi.fn(async () => ({ revoked: 4 })),
    listFullGrants: vi.fn(async () => ({
      grants: [{ sessionId: 11, title: "会话 #11" }],
    })),
    revokeAllFull: vi.fn(async () => ({ revoked: 2 })),
  };
  const monitor = {
    stats: vi.fn(async () => MONITOR_STATS),
  };
  // CRUD 批 automation/graphs 只读面替身（upsert 组合/剔除语义在
  // automation-tap.test 直测，路由层只验信封/参数透传/未装配）
  const automation = {
    query: vi.fn(async () => ({
      page: 2,
      pageSize: 10,
      records: [TASK_ROW],
      total: 1,
    })),
    save: vi.fn(async () => TASK_ROW),
    delete: vi.fn(async () => {}),
    runNow: vi.fn(async () => {}),
    runPage: vi.fn(async () => ({
      total: 1,
      items: [
        {
          id: 9,
          taskId: 7,
          taskName: "任务甲",
          attempt: 1,
          triggerType: "schedule",
          status: "failed",
          startedAt: "2026-10-27T01:00:00.000Z",
        },
      ],
    })),
  };
  const graphs = {
    query: vi.fn(async () => ({
      page: 1,
      pageSize: 20,
      records: [],
      total: 0,
    })),
  };
  // 记忆进化批 memory 面替身（聚合/写面语义在 memory-tap.test 直测，
  // 路由层只验信封/参数校验/未装配）
  const backup = {
    list: vi.fn(async () => ({
      backups: [],
      viewer: { kind: "admin" as const },
    })),
    create: vi.fn(async () => ({ accepted: true })),
    delete: vi.fn(async () => {}),
  };
  const memory = {
    get: vi.fn(async () => MEMORY_STATE),
    saveConfig: vi.fn(async () => MEMORY_STATE),
    saveProfile: vi.fn(async () => MEMORY_STATE),
    applyInstruction: vi.fn(async () => ({ ok: true, memory: "### 新" })),
    compile: vi.fn(async () => ({ ok: false, error: "MEMORY_NO_MATERIAL" })),
  };
  setServerFaceDeps({
    sessions: fake.sessions,
    chat,
    approvals: { respond: vi.fn(() => true) },
    providers,
    assistants,
    skills,
    workspaces,
    mcps,
    permissions,
    monitor,
    automation,
    graphsReadonly: graphs,
    memory,
    backup,
    images: { readImage: vi.fn(async () => null) },
    resolveUserId: async () => UID,
    resolveDefaultWorkspaceId:
      options.resolveDefaultWorkspaceId ?? (async () => 3),
    info: async () => ({
      name: "tianshu-desktop",
      version: "0.0.0-test",
      instanceId: "iid-1",
      capabilities: ["chat", "provider"],
      username: "测试用户",
    }),
  });
  return {
    ...fake,
    chat,
    providers,
    assistants,
    skills,
    workspaces,
    mcps,
    permissions,
    monitor,
    automation,
    graphs,
    memory,
    backup,
  };
}

/** 业务错断言：HTTP 200 + starter 失败包装（code 4xxx） */
async function expectBizError(
  method: "GET" | "POST",
  path: string,
  body: unknown,
  code: string,
) {
  const result = await handleRoute(method, path, body);
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ code, success: false, data: null });
  return result;
}

/** 主窗替身（BrowserWindow 结构子集：聚焦三连 + webContents.send） */
interface FakeWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  webContents: { send: ReturnType<typeof vi.fn> };
}

function makeFakeWindow(
  overrides: Partial<{
    isDestroyed: () => boolean;
    isMinimized: () => boolean;
  }> = {},
): FakeWindow {
  return {
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: { send: vi.fn() },
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  electronWindows.current = [];
});

describe("被控面路由表（T11 查询端点）", () => {
  it("GET info：capability 协商（chat/provider）+ 身份面 username + starter 成功包装", async () => {
    wireDeps();
    const result = await handleRoute("GET", "info", null);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      code: "2000",
      success: true,
      message: "success",
      data: {
        name: "tianshu-desktop",
        version: "0.0.0-test",
        instanceId: "iid-1",
        capabilities: ["chat", "provider"],
        username: "测试用户",
      },
    });
  });

  it("MCP 批：mcp/query 连接器列表 + mcp/setEnabled 启停（归属 userId）", async () => {
    const wired = wireDeps();
    const listed = await handleRoute("POST", "mcp/query", {});
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({
      code: "2000",
      success: true,
      message: "success",
      data: [
        {
          id: 5,
          name: "filesystem",
          transport: "stdio",
          command: "npx fs-server",
          url: null,
          enabled: true,
        },
      ],
    });
    expect(wired.mcps.list).toHaveBeenCalledWith(UID);

    const toggled = await handleRoute("POST", "mcp/setEnabled", {
      id: 5,
      enabled: false,
    });
    expect(toggled.body).toMatchObject({ success: true });
    expect(wired.mcps.setEnabled).toHaveBeenCalledWith(5, false, UID);

    // 载荷畸形（enabled 非布尔/id 缺失）→ 业务错
    const bad = await handleRoute("POST", "mcp/setEnabled", { id: 5 });
    expect(bad.body).toMatchObject({ success: false, code: "5000" });
  });

  it("A6：monitor/stats 透传合法 scene 并返回监控聚合", async () => {
    const wired = wireDeps();
    const result = await handleRoute("POST", "monitor/stats", {
      scene: "graph",
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      code: "2000",
      success: true,
      message: "success",
      data: MONITOR_STATS,
    });
    expect(wired.monitor.stats).toHaveBeenCalledWith(UID, "graph");
  });

  it("A6：monitor/stats 缺省或非法 scene 归一为 undefined", async () => {
    const wired = wireDeps();
    await handleRoute("POST", "monitor/stats", {});
    expect(wired.monitor.stats).toHaveBeenLastCalledWith(UID, undefined);
    await handleRoute("POST", "monitor/stats", { scene: "invalid" });
    expect(wired.monitor.stats).toHaveBeenLastCalledWith(UID, undefined);
  });

  it("A6：monitor/stats 未装配 monitor 面时返回 5000", async () => {
    wireDeps();
    const deps = faceDeps();
    const broken = { ...deps } as Record<string, unknown>;
    delete broken.monitor;
    setServerFaceDeps(broken as Parameters<typeof setServerFaceDeps>[0]);
    const result = await expectBizError("POST", "monitor/stats", {}, "5000");
    expect(result.body).toMatchObject({ message: "monitor 面未装配" });
  });

  // ===== 移动端 CRUD 批（2026-10-27）：automation 五端点 + graph/query 只读 =====
  it("CRUD 批：automation 五端点信封与参数透传", async () => {
    const wired = wireDeps();
    const q = await handleRoute("POST", "automation/query", {
      page: 2,
      pageSize: 10,
      keyword: "甲",
    });
    expect(q.body).toMatchObject({ success: true });
    expect(wired.automation.query).toHaveBeenCalledWith(2, 10, "甲", UID);

    const saved = await handleRoute("POST", "automation/save", {
      id: 7,
      name: "任务甲",
      enabled: false,
    });
    expect(saved.body.data).toEqual(TASK_ROW);
    expect(wired.automation.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7, enabled: false }),
      UID,
    );

    const rn = await handleRoute("POST", "automation/runNow", { taskId: 7 });
    expect(rn.body.data).toEqual({ accepted: true });
    expect(wired.automation.runNow).toHaveBeenCalledWith(7, UID);

    const rp = await handleRoute("POST", "automation/runPage", {
      page: 1,
      taskId: 7,
      status: "failed",
    });
    expect(rp.body.data.total).toBe(1);
    expect(rp.body.data.items[0]).not.toHaveProperty("graphTrace");
    expect(wired.automation.runPage).toHaveBeenCalledWith(1, 7, "failed", UID);

    await handleRoute("POST", "automation/delete", { ids: [7, 8] });
    expect(wired.automation.delete).toHaveBeenCalledWith([7, 8], UID);
  });

  it("CRUD 批：automation 载荷畸形业务错（page/taskId/ids 缺失或类型错）", async () => {
    wireDeps();
    await expectBizError("POST", "automation/runPage", {}, "5000");
    await expectBizError(
      "POST",
      "automation/runPage",
      { page: 1, taskId: "x" },
      "5000",
    );
    await expectBizError("POST", "automation/runNow", {}, "5000");
    await expectBizError("POST", "automation/delete", {}, "5000");
  });

  it("CRUD 批：graph/query 只读信封；automation/graphs 未装配 5000", async () => {
    const wired = wireDeps();
    const g = await handleRoute("POST", "graph/query", {
      page: 1,
      pageSize: 20,
    });
    expect(g.body.success).toBe(true);
    expect(wired.graphs.query).toHaveBeenCalledWith(1, 20, undefined, UID);

    wireDeps();
    const deps = faceDeps();
    const broken = { ...deps } as Record<string, unknown>;
    delete broken.automation;
    delete broken.graphsReadonly;
    setServerFaceDeps(broken as Parameters<typeof setServerFaceDeps>[0]);
    await expectBizError("POST", "automation/query", {}, "5000");
    await expectBizError("POST", "graph/query", {}, "5000");
  });

  // ===== 记忆进化批（2026-10-27）：memory 五端点 =====
  it("记忆批：memory 五端点信封与透传（get/saveConfig/saveProfile/applyInstruction/compile）", async () => {
    const wired = wireDeps();
    const g = await handleRoute("POST", "memory/get", {});
    expect(g.body.data).toEqual(MEMORY_STATE);

    await handleRoute("POST", "memory/saveConfig", { enabled: false });
    expect(wired.memory.saveConfig).toHaveBeenCalledWith({ enabled: false });

    await handleRoute("POST", "memory/saveProfile", { profile: "" });
    expect(wired.memory.saveProfile).toHaveBeenCalledWith("");

    const applied = await handleRoute("POST", "memory/applyInstruction", {
      instruction: "删掉天气相关记忆",
    });
    expect(applied.body.data).toEqual({ ok: true, memory: "### 新" });

    const compiled = await handleRoute("POST", "memory/compile", {});
    // AI 操作码透传（业务结果不是 HTTP 错——success:true + data 带 ok:false）
    expect(compiled.body.success).toBe(true);
    expect(compiled.body.data).toEqual({
      ok: false,
      error: "MEMORY_NO_MATERIAL",
    });
  });

  // ===== 备份面批（2026-10-27）：backup 三端点 =====
  it("备份批：list/create(202)/delete 信封与透传", async () => {
    const wired = wireDeps();
    const listResult = await handleRoute("POST", "backup/list", {});
    expect(listResult.body.success).toBe(true);
    expect(wired.backup.list).toHaveBeenCalledTimes(1);

    const created = await handleRoute("POST", "backup/create", {
      note: " 周末 ",
    });
    expect(created.body.data).toEqual({ accepted: true });
    expect(wired.backup.create).toHaveBeenCalledWith("周末");

    await handleRoute("POST", "backup/delete", { id: "b-1" });
    expect(wired.backup.delete).toHaveBeenCalledWith("b-1");
  });

  it("备份批：载荷畸形与未装配 5000", async () => {
    wireDeps();
    await expectBizError("POST", "backup/create", { note: 5 }, "5000");
    await expectBizError("POST", "backup/delete", {}, "5000");

    wireDeps();
    const deps = faceDeps();
    const broken = { ...deps } as Record<string, unknown>;
    delete broken.backup;
    setServerFaceDeps(broken as Parameters<typeof setServerFaceDeps>[0]);
    await expectBizError("POST", "backup/list", {}, "5000");
  });

  it("记忆批：载荷畸形业务错 + 未装配 5000", async () => {
    wireDeps();
    await expectBizError("POST", "memory/saveConfig", { enabled: "x" }, "5000");
    await expectBizError("POST", "memory/saveProfile", {}, "5000");
    await expectBizError("POST", "memory/applyInstruction", {}, "5000");

    wireDeps();
    const deps = faceDeps();
    const broken = { ...deps } as Record<string, unknown>;
    delete broken.memory;
    setServerFaceDeps(broken as Parameters<typeof setServerFaceDeps>[0]);
    await expectBizError("POST", "memory/get", {}, "5000");
  });

  it("create+query+getById+delete 闭环（workspaceId 缺省回落默认空间）", async () => {
    const wired = wireDeps();
    // create：不传 workspaceId → 被控面默认空间（resolveDefaultWorkspaceId）
    const created = await handleRoute("POST", "session/create", {
      title: "遥控会话",
    });
    expect(created.status).toBe(200);
    const record = (created.body as { data: SessionRecord }).data;
    expect(record.title).toBe("遥控会话");
    expect(record.workspaceId).toBe(3);

    // query：分页包装 {page,pageSize,records,total}（starter QueryResult 同构）
    const listed = await handleRoute("POST", "session/query", {
      page: 1,
      pageSize: 100,
    });
    const page = (
      listed.body as { data: { records: SessionRecord[]; total: number } }
    ).data;
    expect(page.total).toBe(1);
    expect(page.records.map((r) => r.id)).toEqual([record.id]);

    // getById：会话 + 空 messages（blocks 原样数组）
    const detail = await handleRoute("POST", "session/getById", {
      id: record.id,
    });
    const data = (
      detail.body as {
        data: { session: SessionRecord; messages: MessageRecord[] };
      }
    ).data;
    expect(data.session.id).toBe(record.id);
    expect(data.messages).toEqual([]);

    // delete 后 query 清空
    await handleRoute("POST", "session/delete", { id: record.id });
    const after = await handleRoute("POST", "session/query", {});
    expect((after.body as { data: { total: number } }).data.total).toBe(0);
    expect(wired.rows.size).toBe(0);
  });

  it("query 过滤：keyword contains / archived 布尔 / 分页切片（走 querySessions 下推分页）", async () => {
    const wired = wireDeps();
    const s1 = wired.seed("调研报告");
    wired.seed("周报", { archivedAt: new Date() });
    // null 标题防御（终审备案项 A）：列 NOT NULL 但外部写入/旧库残留可能
    // null——keyword 查询不抛 TypeError 且该行不命中（server 仓储同款用例）
    wired.seed(null as unknown as string);

    // face 全表扫描优化批：数据源切换断言——session/query 直调
    // querySessions（带 userId 与过滤参数），不再全量拉取内存过滤
    const byKeyword = await handleRoute("POST", "session/query", {
      keyword: "调研",
    });
    expect(wired.sessions.querySessions).toHaveBeenCalledWith(
      expect.objectContaining({ keyword: "调研" }),
      UID,
    );
    expect(
      (
        byKeyword.body as { data: { records: SessionRecord[] } }
      ).data.records.map((r) => r.id),
    ).toEqual([s1.id]);

    // null 标题行也不被空串/任意 keyword 误伤：keyword 命中 null 行自身抛错
    // 的回归在此钉住（total 含该行，仅过滤不命中）
    const nullGuard = await handleRoute("POST", "session/query", {
      keyword: "周报",
    });
    expect((nullGuard.body as { data: { total: number } }).data.total).toBe(1);

    const archived = await handleRoute("POST", "session/query", {
      archived: true,
    });
    expect((archived.body as { data: { total: number } }).data.total).toBe(1);

    const paged = await handleRoute("POST", "session/query", {
      page: 1,
      pageSize: 1,
    });
    const page = (paged.body as { data: { records: unknown[]; total: number } })
      .data;
    expect(page.records.length).toBe(1);
    expect(page.total).toBe(3);
  });

  // A11 会话时间筛选批（spec §1.1/§1.2）：活动时间 lastMessageAt ?? updatedAt
  // >= 阈值（含边界）；畸形时间串 5000 参数不合法；与 keyword/archived 叠加；
  // 分页在过滤后（total = 过滤后条数）
  it("query 过滤：activityAfter 时间窗（边界含/不含、坏时间串、叠加、过滤后分页）", async () => {
    const wired = wireDeps();
    const THRESHOLD = "2026-06-01T00:00:00.000Z";
    // 边界内（lastMessageAt 恰=阈值，含边界入选）
    const atEdge = wired.seed("边界内", {
      lastMessageAt: new Date(THRESHOLD),
    });
    // 边界外（lastMessageAt 早于阈值）
    const tooOld = wired.seed("边界外", {
      lastMessageAt: new Date("2026-05-31T23:59:59.000Z"),
    });
    // lastMessageAt 缺省回退 updatedAt：updatedAt 新 → 入选
    const fallbackNew = wired.seed("回退新", {
      lastMessageAt: null,
      updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    // lastMessageAt 缺省回退 updatedAt：updatedAt 旧 → 排除
    wired.seed("回退旧", {
      lastMessageAt: null,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const query = async (body: Record<string, unknown>) =>
      (await handleRoute("POST", "session/query", body)).body as {
        code: string;
        data: { records: SessionRecord[]; total: number };
      };

    // 基础过滤：边界内 + 回退新入选，边界外 + 回退旧排除
    const base = await query({ activityAfter: THRESHOLD });
    expect(base.code).toBe("2000");
    expect(base.data.total).toBe(2);
    expect(base.data.records.map((r) => r.id).sort()).toEqual(
      [atEdge.id, fallbackNew.id].sort(),
    );

    // 与 keyword 叠加：命中关键词的仅边界外那行 → 空集
    const withKeyword = await query({
      activityAfter: THRESHOLD,
      keyword: "边界外",
    });
    expect(withKeyword.data.total).toBe(0);

    // 与 archived 叠加：把边界内行归档后，archived:true + 时间窗只剩它
    await handleRoute("POST", "session/update", {
      sessionId: atEdge.id,
      archived: true,
    });
    const archivedOnly = await query({
      activityAfter: THRESHOLD,
      archived: true,
    });
    expect(archivedOnly.data.total).toBe(1);
    expect(archivedOnly.data.records[0].id).toBe(atEdge.id);
    const activeOnly = await query({
      activityAfter: THRESHOLD,
      archived: false,
    });
    expect(activeOnly.data.total).toBe(1);
    expect(activeOnly.data.records[0].id).toBe(fallbackNew.id);

    // 分页在过滤后：过滤剩 1 行（archived:false），pageSize=1 第 2 页为空
    const page2 = await query({
      activityAfter: THRESHOLD,
      archived: false,
      page: 2,
      pageSize: 1,
    });
    expect(page2.data.total).toBe(1);
    expect(page2.data.records).toEqual([]);
    // 未被归档/关键词波及的边界外旧行独立复核
    expect(tooOld.archivedAt).toBeNull();

    // 坏时间串：5000 参数不合法
    const bad = await query({ activityAfter: "not-a-date" });
    expect(bad.code).toBe("5000");
  });

  it("getById/getById 不存在：业务错 HTTP 200 + code 4040（错误码不泄露存在性）", async () => {
    wireDeps();
    await expectBizError("POST", "session/getById", { id: 999 }, "4040");
    await expectBizError("POST", "session/delete", { id: 999 }, "4040");
  });

  it("getById 多页历史：>2 页游标翻页块序按 id 升序（终审 Issue 2 回归）", async () => {
    // 真实 listMessages 语义替身（SessionRepository 同构）：id 倒序取
    // limit+1 判 hasMore，页内翻转回时间正序，游标自新向旧翻页——旧实现
    // 直接 push 拼接会以 500 条/块整块倒序（首块=最新 500 条）
    const fake = makeFakeSessions();
    fake.sessions.listMessages = async (
      sessionId: number,
      userId: number,
      opts?: { beforeId?: number; limit?: number },
    ) => {
      const row = fake.rows.get(sessionId);
      if (!row || row.userId !== userId) throw new Error("SESSION_NOT_FOUND");
      const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 500);
      const rows = (fake.messages.get(sessionId) ?? [])
        .filter((m) =>
          opts?.beforeId !== undefined ? m.id < opts.beforeId : true,
        )
        .sort((a, b) => b.id - a.id)
        .slice(0, limit + 1);
      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows).reverse();
      return {
        items,
        hasMore,
        nextBeforeId: hasMore ? (items[0]?.id ?? null) : null,
      };
    };
    const wired = wireDeps(fake);
    // 1201 条 = 500+500+201 三页（routes 每页 limit 500）
    const seeded = wired.seed("千条长会话");
    wired.messages.set(
      seeded.id,
      Array.from({ length: 1201 }, (_, i) => ({
        id: i + 1,
        sessionId: seeded.id,
        role: "user" as const,
        blocks: `m-${i + 1}`,
        createdAt: new Date(2026, 0, i + 1).toISOString(),
        // 耗时管道（durationMs 批）：末条带 round 计时，透传断言用
        ...(i === 1200 ? { durationMs: 2350 } : {}),
      })),
    );

    const detail = await handleRoute("POST", "session/getById", {
      id: seeded.id,
    });
    const data = (
      detail.body as {
        data: { session: SessionRecord; messages: MessageRecord[] };
      }
    ).data;
    const ids = data.messages.map((m) => m.id);
    expect(ids).toHaveLength(1201);
    // 全量严格升序（红色态：旧实现首块为 701..1200）
    for (let i = 1; i < ids.length; i += 1) {
      expect(ids[i]).toBe(i + 1);
    }
    expect(data.messages[0].blocks).toBe("m-1");
    expect(data.messages[1200].blocks).toBe("m-1201");
    // 耗时管道（durationMs 批）：表列透传；无计时行缺省 null
    expect(data.messages[1200].durationMs).toBe(2350);
    expect(data.messages[0].durationMs).toBeNull();
  });

  it("仓储抛 SESSION_NOT_FOUND 映射 4040；未知错误映射 5000 不裸抛", async () => {
    const wired = wireDeps();
    wired.sessions.getSessionById = async () => {
      throw new Error("SESSION_NOT_FOUND");
    };
    await expectBizError("POST", "session/getById", { id: 1 }, "4040");

    // face 全表扫描优化批：query 数据源已切 querySessions（不再全量
    // listAllSessionsSummarized 内存过滤），仓储异常经同一映射收口
    wired.sessions.querySessions = async () => {
      throw new Error("boom");
    };
    await expectBizError("POST", "session/query", {}, "5000");
  });

  it("send/abort（T12 接通）：缺会话 4040；存在则 202 受理 / aborted", async () => {
    const wired = wireDeps();
    await expectBizError(
      "POST",
      "session/send",
      { sessionId: 999, content: "hi" },
      "4040",
    );
    await expectBizError("POST", "session/abort", { sessionId: 999 }, "4040");
    await expectBizError(
      "POST",
      "session/send",
      { sessionId: "x", content: "hi" },
      "5000",
    );

    const seeded = wired.seed("流会话");
    const send = await handleRoute("POST", "session/send", {
      sessionId: seeded.id,
      content: "hi",
    });
    expect(send.status).toBe(202);
    expect(send.body).toMatchObject({
      code: "2000",
      success: true,
      data: { accepted: true },
    });
    // setImmediate 异步分发（受理即返回，流经事件通道）
    await new Promise((resolve) => setImmediate(resolve));
    expect(wired.chat.send).toHaveBeenCalledWith(
      { sessionId: seeded.id, content: "hi" },
      UID,
      undefined,
    );

    const abort = await handleRoute("POST", "session/abort", {
      sessionId: seeded.id,
    });
    expect(abort.body).toMatchObject({
      code: "2000",
      success: true,
      data: { aborted: true },
    });
    expect(wired.chat.stop).toHaveBeenCalledWith(seeded.id);
  });

  it("未登记路由：业务错 4040（starter 语义：路由缺失经异常过滤器 200+4xxx）", async () => {
    wireDeps();
    await expectBizError("POST", "session/rename", {}, "4040");
    await expectBizError("GET", "session/query", null, "4040");
  });

  it("path 容错：前导斜杠（HTTP /session/query 与 relay session/query 等价）", async () => {
    wireDeps();
    const withSlash = await handleRoute("POST", "/session/query", {});
    expect(withSlash.status).toBe(200);
    expect((withSlash.body as { data: { total: number } }).data.total).toBe(0);
  });
});

// —— A9 会话内工具批（spec 2026-10-26 §1 阶段 2/3）：session/compact 异步
// 桥（202 受理 + session.updated 收尾）+ session/polish 同步桥（30s 超时
// 语义在 service 内）——形状校验 → 预检 → 桥调用断言，事件经 onFaceEvent
// 订阅断言（P1 read 用例同款口径）——
describe("A9 会话内工具批：session/compact + session/polish", () => {
  it("compact：参数校验（缺 sessionId 5000/畸形 5000）；会话不存在 4040；归档 5000", async () => {
    wireDeps();
    await expectBizError("POST", "session/compact", {}, "5000");
    await expectBizError("POST", "session/compact", { sessionId: "x" }, "5000");
    await expectBizError("POST", "session/compact", { sessionId: 999 }, "4040");
    const wired = wireDeps();
    const archived = wired.seed("已归档", { archivedAt: new Date() });
    await expectBizError(
      "POST",
      "session/compact",
      { sessionId: archived.id },
      "5000",
    );
  });

  it("compact：202 受理后 setImmediate 桥 chat.compact，收尾发布 session.updated（enriched）", async () => {
    const wired = wireDeps();
    const seeded = wired.seed("压缩会话");
    const events: unknown[] = [];
    const off = onFaceEvent((event) => events.push(event));
    try {
      const result = await handleRoute("POST", "session/compact", {
        sessionId: seeded.id,
      });
      expect(result.status).toBe(202);
      expect(result.body).toMatchObject({
        code: "2000",
        success: true,
        data: { accepted: true },
      });
      // setImmediate 异步分发（受理即返回，流经事件通道）
      await new Promise((resolve) => setImmediate(resolve));
      expect(wired.chat.compact).toHaveBeenCalledWith(seeded.id, UID);
      const updated = events.filter(
        (e) => (e as { type: string }).type === "session.updated",
      );
      expect(updated).toHaveLength(1);
      expect(updated[0]).toMatchObject({
        type: "session.updated",
        payload: { id: seeded.id },
      });
    } finally {
      off();
    }
  });

  it("compact：执行失败经 session.error 事件回传（错误码透传）", async () => {
    const wired = wireDeps();
    const seeded = wired.seed("压缩失败会话");
    wired.chat.compact.mockRejectedValueOnce(new Error("NO_MODEL"));
    const events: unknown[] = [];
    const off = onFaceEvent((event) => events.push(event));
    try {
      await handleRoute("POST", "session/compact", { sessionId: seeded.id });
      await new Promise((resolve) => setImmediate(resolve));
      const errors = events.filter(
        (e) => (e as { type: string }).type === "session.error",
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        type: "session.error",
        payload: {
          sessionId: seeded.id,
          code: "NO_MODEL",
          message: "未选择模型：请先在该会话选择模型再发送",
        },
      });
    } finally {
      off();
    }
  });

  it("polish：同步返回改写文本；workspaceId 缺省解析默认空间；style 缺省回退 professional", async () => {
    const wired = wireDeps();
    const result = await handleRoute("POST", "session/polish", {
      text: "帮我把这段改专业点",
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      code: "2000",
      success: true,
      data: { text: "润色结果" },
    });
    expect(wired.chat.polish).toHaveBeenCalledWith(
      { workspaceId: 3, text: "帮我把这段改专业点", style: "professional" },
      UID,
    );
    // 显式 workspaceId/style 透传
    await handleRoute("POST", "session/polish", {
      workspaceId: 9,
      text: "精简它",
      style: "concise",
    });
    expect(wired.chat.polish).toHaveBeenCalledWith(
      { workspaceId: 9, text: "精简它", style: "concise" },
      UID,
    );
    // 未知 style 回退 professional（与桌面 STYLE_PROMPTS 缺省口径一致）
    await handleRoute("POST", "session/polish", {
      text: "x",
      style: "fancy",
    });
    expect(wired.chat.polish).toHaveBeenCalledWith(
      { workspaceId: 3, text: "x", style: "professional" },
      UID,
    );
  });

  it("polish：text 缺失/空串 5000；service 超时/无模型错误 5000（有用 message）", async () => {
    const wired = wireDeps();
    await expectBizError("POST", "session/polish", {}, "5000");
    await expectBizError("POST", "session/polish", { text: "" }, "5000");
    // mock LLM 30s 超时（TimeoutError）经 service 上抛 → 5000 兜底
    wired.chat.polish.mockRejectedValueOnce(new Error("TimeoutError"));
    await expectBizError(
      "POST",
      "session/polish",
      { text: "会超时的文本" },
      "5000",
    );
    // 工作空间不存在（默认空间解析失败）→ 4040
    wireDeps({}, { resolveDefaultWorkspaceId: async () => null });
    await expectBizError("POST", "session/polish", { text: "hi" }, "4040");
  });
});

describe("被控面 ui-drive 三端点（UD-T1，spec 2026-10-17 §2）", () => {
  it("openSession：归属校验通过 → 主窗聚焦（最小化先 restore）+ ui:openSession 事件 + {opened:true}；多窗口仅驱动主窗", async () => {
    const wired = wireDeps();
    const seeded = wired.seed("远控打开");
    // 最小化主窗 + 次窗并存：聚焦三连只打主窗（getAllWindows 首个）
    const main = makeFakeWindow({ isMinimized: () => true });
    const other = makeFakeWindow();
    electronWindows.current = [main, other];

    const result = await handleRoute("POST", "ui/openSession", {
      sessionId: seeded.id,
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      code: "2000",
      success: true,
      data: { opened: true },
    });
    expect(main.restore).toHaveBeenCalled();
    expect(main.show).toHaveBeenCalled();
    expect(main.focus).toHaveBeenCalled();
    expect(main.webContents.send).toHaveBeenCalledWith("ui:openSession", {
      sessionId: seeded.id,
    });
    expect(other.show).not.toHaveBeenCalled();
    expect(other.webContents.send).not.toHaveBeenCalled();
  });

  it("openSession：他人会话/不存在/畸形 sessionId → 4040 同码同文案（不泄露存在性），不驱动窗口", async () => {
    const wired = wireDeps();
    wired.seed("他人会话", { userId: UID + 1 });
    const win = makeFakeWindow();
    electronWindows.current = [win];
    const missing = await expectBizError(
      "POST",
      "ui/openSession",
      { sessionId: 999 },
      "4040",
    );
    const malformed = await expectBizError(
      "POST",
      "ui/openSession",
      { sessionId: "x" },
      "4040",
    );
    const others = await expectBizError(
      "POST",
      "ui/openSession",
      { sessionId: 1 },
      "4040",
    );
    // 三路 message 相等（UD-T1 Minor 补）：畸形/不存在/他人会话文案统一
    // 「会话不存在」——文案差异与错误码差异同样是存在性泄露面
    const messages = [missing, malformed, others].map(
      (r) => (r.body as { message: string }).message,
    );
    expect(messages).toEqual(["会话不存在", "会话不存在", "会话不存在"]);
    expect(win.show).not.toHaveBeenCalled();
    expect(win.webContents.send).not.toHaveBeenCalled();
  });

  it("notify：ui:notify 事件载荷 {title,message}（message 可省）；不抢焦点；title 缺失参数错", async () => {
    wireDeps();
    const win = makeFakeWindow();
    electronWindows.current = [win];
    const result = await handleRoute("POST", "ui/notify", {
      title: "远控提醒",
      message: "来自控制端",
    });
    expect(result.body).toMatchObject({
      code: "2000",
      success: true,
      data: { notified: true },
    });
    expect(win.webContents.send).toHaveBeenCalledWith("ui:notify", {
      title: "远控提醒",
      message: "来自控制端",
    });
    expect(win.show).not.toHaveBeenCalled();
    expect(win.focus).not.toHaveBeenCalled();

    const minimal = await handleRoute("POST", "ui/notify", { title: "短标题" });
    expect(minimal.body).toMatchObject({
      code: "2000",
      data: { notified: true },
    });
    expect(win.webContents.send).toHaveBeenLastCalledWith("ui:notify", {
      title: "短标题",
    });
    await expectBizError("POST", "ui/notify", {}, "5000");
    await expectBizError("POST", "ui/notify", { message: "无标题" }, "5000");
  });

  it("openRoute：白名单 /module/ 前缀——非白名单 4005 参数错不驱动窗口；白名单内 send + {opened:true}", async () => {
    wireDeps();
    const win = makeFakeWindow();
    electronWindows.current = [win];
    // 白名单外（登录页/外部 URL/畸形类型/空串）一律 4005
    await expectBizError("POST", "ui/openRoute", { path: "/login" }, "4005");
    await expectBizError(
      "POST",
      "ui/openRoute",
      { path: "https://evil.example" },
      "4005",
    );
    await expectBizError("POST", "ui/openRoute", { path: 42 }, "4005");
    await expectBizError("POST", "ui/openRoute", { path: "" }, "4005");
    expect(win.webContents.send).not.toHaveBeenCalled();
    // 仅 /module/ 前缀（含 "/module" 裸前缀不带尾斜杠——非前缀匹配）
    await expectBizError("POST", "ui/openRoute", { path: "/module" }, "4005");

    const result = await handleRoute("POST", "ui/openRoute", {
      path: "/module/ai/server",
    });
    expect(result.body).toMatchObject({
      code: "2000",
      success: true,
      data: { opened: true },
    });
    expect(win.webContents.send).toHaveBeenCalledWith("ui:openRoute", {
      path: "/module/ai/server",
    });
    // openRoute 语义为路由跳转，不抢焦点（spec §2.1 仅 openSession 聚焦）
    expect(win.show).not.toHaveBeenCalled();
  });

  it('openRoute 段校验上提（UD-T3，Ruling 2）：".."/"." 段与 // 空段主进程即拒 4005；字面段与查询串放行', async () => {
    wireDeps();
    const win = makeFakeWindow();
    electronWindows.current = [win];
    // 点段穿越：startsWith("/module/") 通过，但渲染层 resolvePath 归一后
    // 脱离前缀（"/module/../login" → "/login"）——旧实现裸前缀放行且返回
    // opened:true（主进程段校验上提后即拒，与 UD-T2 渲染层兜底同款语义）
    await expectBizError(
      "POST",
      "ui/openRoute",
      { path: "/module/../login" },
      "4005",
    );
    await expectBizError(
      "POST",
      "ui/openRoute",
      { path: "/module/./ai" },
      "4005",
    );
    await expectBizError(
      "POST",
      "ui/openRoute",
      { path: "/module/ai/../server" },
      "4005",
    );
    // "//" 空段：归一/协议相对语义歧义同拒
    await expectBizError(
      "POST",
      "ui/openRoute",
      { path: "/module//ai" },
      "4005",
    );
    expect(win.webContents.send).not.toHaveBeenCalled();

    // 字面 "..foo" 段非点段（按字面比较不归一）；查询串不参与段校验——
    // 含查询值里的 "//"（UD-T2 审查口径统一：// 检查切查询串后做）
    const literal = await handleRoute("POST", "ui/openRoute", {
      path: "/module/ai/graphs/..foo?a=/../login",
    });
    expect(literal.body).toMatchObject({
      code: "2000",
      success: true,
      data: { opened: true },
    });
    const query = await handleRoute("POST", "ui/openRoute", {
      path: "/module/ai?redirect=a//b",
    });
    expect(query.body).toMatchObject({
      code: "2000",
      success: true,
      data: { opened: true },
    });
    expect(win.webContents.send).toHaveBeenCalledTimes(2);
    expect(win.webContents.send).toHaveBeenCalledWith("ui:openRoute", {
      path: "/module/ai/graphs/..foo?a=/../login",
    });
    expect(win.webContents.send).toHaveBeenLastCalledWith("ui:openRoute", {
      path: "/module/ai?redirect=a//b",
    });
  });

  it("主窗缺失/已销毁降级：不抛、返回值如实（opened/notified:false）、零事件", async () => {
    const wired = wireDeps();
    const seeded = wired.seed("降级场景");
    electronWindows.current = [];
    const open = await handleRoute("POST", "ui/openSession", {
      sessionId: seeded.id,
    });
    expect(open.status).toBe(200);
    expect(open.body).toMatchObject({
      code: "2000",
      success: true,
      data: { opened: false },
    });
    const notify = await handleRoute("POST", "ui/notify", { title: "t" });
    expect(notify.body).toMatchObject({
      code: "2000",
      success: true,
      data: { notified: false },
    });
    const route = await handleRoute("POST", "ui/openRoute", {
      path: "/module/ai",
    });
    expect(route.body).toMatchObject({
      code: "2000",
      success: true,
      data: { opened: false },
    });

    // 已销毁窗口同款降级（isDestroyed 守卫，terminal-ipc 先例）
    const dead = makeFakeWindow({ isDestroyed: () => true });
    electronWindows.current = [dead];
    const openDead = await handleRoute("POST", "ui/openSession", {
      sessionId: seeded.id,
    });
    expect(openDead.body).toMatchObject({
      code: "2000",
      success: true,
      data: { opened: false },
    });
    expect(dead.restore).not.toHaveBeenCalled();
    expect(dead.show).not.toHaveBeenCalled();
    expect(dead.webContents.send).not.toHaveBeenCalled();
  });
});

describe("被控面模型/会话/专家新五路由（FA 批：对齐本地端功能）", () => {
  it("provider/delete：providerIds/modelIds 透传桥并返回 bundle；双空参数错", async () => {
    const wired = wireDeps();
    await expectBizError("POST", "provider/delete", {}, "5000");

    const result = await handleRoute("POST", "provider/delete", {
      providerIds: [1, 2],
      modelIds: [3],
    });
    expect(result.body).toMatchObject({ success: true });
    expect(wired.providers.deleteProviders).toHaveBeenCalledWith([1, 2], UID);
    expect(wired.providers.deleteModels).toHaveBeenCalledWith([3], UID);
    expect(wired.providers.listBundle).toHaveBeenCalledWith(UID);
  });

  it("provider/test：listRemote 结构化转 ok/message（含失败态）", async () => {
    const wired = wireDeps();
    const okResult = await handleRoute("POST", "provider/test", {
      providerId: 1,
    });
    expect(okResult.body).toMatchObject({
      success: true,
      data: { ok: true, message: "" },
    });

    wired.providers.listRemote.mockResolvedValueOnce({
      success: false,
      errorCode: "401",
      message: "HTTP 401",
      models: [],
    });
    const failResult = await handleRoute("POST", "provider/test", {
      providerId: 1,
    });
    expect(failResult.body).toMatchObject({
      success: true,
      data: { ok: false, message: "HTTP 401" },
    });
    await expectBizError("POST", "provider/test", {}, "5000");
  });

  it("provider/fetchModels：listRemote 透传；providerId 畸形参数错", async () => {
    const wired = wireDeps();
    const result = await handleRoute("POST", "provider/fetchModels", {
      providerId: 5,
    });
    expect(result.body).toMatchObject({
      success: true,
      data: {
        success: true,
        models: [{ modelId: "gpt-x" }],
      },
    });
    expect(wired.providers.listRemote).toHaveBeenCalledWith(5, UID);
    await expectBizError(
      "POST",
      "provider/fetchModels",
      { providerId: "x" },
      "5000",
    );
  });

  it("session/update：title trim 后桥 renameSession；空标题参数错", async () => {
    const wired = wireDeps();
    const row = wired.seed("旧标题");
    const result = await handleRoute("POST", "session/update", {
      sessionId: row.id,
      title: "  新标题  ",
    });
    expect(result.body).toMatchObject({ success: true });
    expect(wired.rows.get(row.id)?.title).toBe("新标题");
    await expectBizError(
      "POST",
      "session/update",
      { sessionId: row.id, title: "  " },
      "5000",
    );
  });

  it("session/regenerate：归属校验后 setImmediate 桥 regenerate（messageId 透传）", async () => {
    const wired = wireDeps();
    const row = wired.seed("要重生成");
    const result = await handleRoute("POST", "session/regenerate", {
      sessionId: row.id,
      messageId: 42,
    });
    expect(result.body).toMatchObject({ success: true });
    expect(result.status).toBe(202);
    await new Promise((r) => setTimeout(r, 10));
    expect(wired.chat.regenerate).toHaveBeenCalledWith(
      row.id,
      UID,
      42,
      undefined,
    );
    // 无 messageId → undefined 透传；归属外 4040
    await handleRoute("POST", "session/regenerate", { sessionId: row.id });
    await new Promise((r) => setTimeout(r, 10));
    expect(wired.chat.regenerate).toHaveBeenLastCalledWith(
      row.id,
      UID,
      undefined,
      undefined,
    );
    await expectBizError(
      "POST",
      "session/regenerate",
      { sessionId: 999 },
      "4040",
    );
  });

  it("session/update 携 mode：桥 setMode；editAndResend/accessMode 桥（CU 批）", async () => {
    const wired = wireDeps();
    const row = wired.seed("模式会话");
    // update {mode}：title 缺省仍合法
    await handleRoute("POST", "session/update", {
      sessionId: row.id,
      mode: "ask",
    });
    expect(wired.rows.get(row.id)?.mode).toBe("ask");
    // 双空参数错
    await expectBizError(
      "POST",
      "session/update",
      { sessionId: row.id },
      "5000",
    );

    // editAndResend：透传桥 + 202
    const res = await handleRoute("POST", "session/editAndResend", {
      sessionId: row.id,
      messageId: 9,
      content: "改写",
    });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 10));
    expect(wired.chat.editAndResend).toHaveBeenCalledWith(
      row.id,
      UID,
      9,
      "改写",
      undefined,
    );

    // accessMode：get/set 合一（set 后回读 get 值）
    const got = await handleRoute("POST", "session/accessMode", {
      sessionId: row.id,
    });
    expect(got.body).toMatchObject({
      success: true,
      data: { mode: "default" },
    });
    wired.chat.getAccessMode.mockResolvedValueOnce("full");
    const set = await handleRoute("POST", "session/accessMode", {
      sessionId: row.id,
      mode: "full",
    });
    expect(set.body).toMatchObject({ success: true, data: { mode: "full" } });
    expect(wired.chat.setAccessMode).toHaveBeenCalledWith(row.id, "full", UID);
  });

  it("session/usage 与 skills/query|read（AL 批）：用量透传 + 技能清单/全文", async () => {
    const wired = wireDeps();
    const row = wired.seed("用量会话");
    const usage = await handleRoute("POST", "session/usage", {
      sessionId: row.id,
    });
    expect(usage.body).toMatchObject({
      success: true,
      data: { total: 350, contextWindow: 8192 },
    });
    expect(wired.chat.getUsageBreakdown).toHaveBeenCalledWith(row.id, UID);

    const list = await handleRoute("POST", "skills/query", null);
    expect(list.body).toMatchObject({
      success: true,
      data: [{ name: "code-review", description: "代码审查" }],
    });
    const read = await handleRoute("POST", "skills/read", {
      name: "code-review",
    });
    expect(read.body).toMatchObject({
      success: true,
      data: { content: "# 代码审查技能全文" },
    });
    expect(wired.skills.read).toHaveBeenCalledWith(UID, "code-review");
    await expectBizError("POST", "skills/read", { name: "" }, "5000");
  });

  it("assistant/query：桥专家列表（id/name 概要）", async () => {
    const wired = wireDeps();
    const result = await handleRoute("POST", "assistant/query", null);
    expect(result.body).toMatchObject({
      success: true,
      data: [{ id: 1, name: "专家A" }],
    });
    expect(wired.assistants.list).toHaveBeenCalledWith(UID);
  });
});

describe("provider/save（A1 批写面：批量 upsert 桥）", () => {
  it("providers+models 载荷透传 deps.save 并回其 bundle", async () => {
    const d = wireDeps();
    d.providers.save.mockResolvedValue({
      providers: [{ id: 1, name: "ACME", apiKey: "MASKED" }],
      models: [],
    });
    const result = await handleRoute("POST", "provider/save", {
      providers: [
        {
          name: "ACME",
          type: "openai-compatible",
          baseUrl: "https://api.acme.test",
        },
      ],
      models: [{ providerId: 1, modelId: "gpt-x" }],
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ code: "2000", success: true });
    expect(d.providers.save).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: [expect.objectContaining({ name: "ACME" })],
      }),
      expect.any(Number),
    );
  });

  it("两数组均缺 → 5000", async () => {
    wireDeps();
    await expectBizError("POST", "provider/save", {}, "5000");
  });

  it("deps.save 抛错 → 5000 且 message 带项标识", async () => {
    const d = wireDeps();
    d.providers.save.mockRejectedValue(
      new Error("服务商「ACME」保存失败：归属校验"),
    );
    const result = await handleRoute("POST", "provider/save", {
      providers: [{ name: "ACME" }],
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ code: "5000", success: false });
    expect(JSON.stringify(result.body)).toContain("ACME");
  });
});

describe("workspace/query（HD-A1：单 UI 远程态侧栏分组树）", () => {
  it("概要列表透传（id/name/directoryPath/defaultModelId），按归属用户", async () => {
    const wired = wireDeps();
    const result = await handleRoute("POST", "workspace/query", null);
    expect(result.body).toMatchObject({
      success: true,
      data: [
        {
          id: 3,
          name: "默认工作空间",
          directoryPath: "/ws",
          defaultModelId: 7,
        },
      ],
    });
    expect(wired.workspaces.list).toHaveBeenCalledWith(UID);
  });

  it("未装配 workspaces 面：5000 接线缺失如实报错", async () => {
    const wired = wireDeps();
    const deps = faceDeps();
    const broken = { ...deps } as Record<string, unknown>;
    delete broken.workspaces;
    setServerFaceDeps(broken as Parameters<typeof setServerFaceDeps>[0]);
    await expectBizError("POST", "workspace/query", null, "5000");
    // 复原（后续用例依赖完整装配）
    setServerFaceDeps(deps as Parameters<typeof setServerFaceDeps>[0]);
    void wired;
  });
});

describe("workspace 写面三端点（A8：create/update/delete）", () => {
  it("workspace/create：载荷透传 + 概要四字段信封（directoryPath 缺省 null）", async () => {
    const wired = wireDeps();
    const result = await handleRoute("POST", "workspace/create", {
      name: "新空间",
      icon: "🚀",
      defaultModelId: 3,
    });
    expect(result.body).toMatchObject({
      success: true,
      data: {
        id: 9,
        name: "新空间",
        directoryPath: null,
        defaultModelId: null,
      },
    });
    expect(wired.workspaces.create).toHaveBeenCalledWith(UID, {
      name: "新空间",
      icon: "🚀",
      defaultModelId: 3,
    });
  });

  it("workspace/create：载荷畸形（name 非字符串）5000 参数错", async () => {
    wireDeps();
    await expectBizError("POST", "workspace/create", { name: 42 }, "5000");
  });

  it("workspace/create：WORKSPACE_INVALID 稳定码透传（name 空，tap 守卫）", async () => {
    const wired = wireDeps();
    wired.workspaces.create.mockRejectedValueOnce(
      new FaceWorkspaceError("WORKSPACE_INVALID", "工作空间名称不能为空"),
    );
    await expectBizError(
      "POST",
      "workspace/create",
      { name: "" },
      "WORKSPACE_INVALID",
    );
  });

  it("workspace/update：id 缺省/畸形 5000 参数错", async () => {
    wireDeps();
    await expectBizError("POST", "workspace/update", { name: "x" }, "5000");
    await expectBizError(
      "POST",
      "workspace/update",
      { id: "1", name: "x" },
      "5000",
    );
  });

  it("workspace/update：归属失败 WORKSPACE_NOT_FOUND 稳定码透传", async () => {
    const wired = wireDeps();
    wired.workspaces.update.mockRejectedValueOnce(
      new FaceWorkspaceError("WORKSPACE_NOT_FOUND", "WORKSPACE_NOT_FOUND"),
    );
    await expectBizError(
      "POST",
      "workspace/update",
      { id: 404, name: "x" },
      "WORKSPACE_NOT_FOUND",
    );
  });

  it("workspace/update：正常更新四字段回传", async () => {
    const wired = wireDeps();
    const result = await handleRoute("POST", "workspace/update", {
      id: 3,
      name: "改名",
    });
    expect(result.body).toMatchObject({
      success: true,
      data: { id: 3, name: "改名", directoryPath: "/ws", defaultModelId: 7 },
    });
    expect(wired.workspaces.update).toHaveBeenCalledWith(UID, {
      id: 3,
      name: "改名",
    });
  });

  it("workspace/delete：id 畸形 4040（资源不存在口径）", async () => {
    wireDeps();
    await expectBizError("POST", "workspace/delete", { id: "x" }, "4040");
  });

  it("workspace/delete：成功返回 null；调用带归属 userId", async () => {
    const wired = wireDeps();
    const result = await handleRoute("POST", "workspace/delete", { id: 3 });
    expect(result.body).toMatchObject({ success: true, data: null });
    expect(wired.workspaces.remove).toHaveBeenCalledWith(UID, 3);
  });

  it("未装配写面（workspaces.create 缺省）：5000 接线缺失如实报错", async () => {
    wireDeps();
    const deps = faceDeps();
    const broken = {
      ...deps,
      workspaces: { list: deps.workspaces.list },
    } as Parameters<typeof setServerFaceDeps>[0];
    setServerFaceDeps(broken);
    await expectBizError("POST", "workspace/create", { name: "x" }, "5000");
    // 复原（后续用例依赖完整装配）
    setServerFaceDeps(deps);
  });
});

describe("permission 五端点（A10 审批记忆批）", () => {
  it("permission/listRemembered：行列表透传（四字段形状），调用带归属 userId", async () => {
    const wired = wireDeps();
    const result = await handleRoute("POST", "permission/listRemembered", null);
    expect(result.body).toMatchObject({
      success: true,
      data: [
        {
          id: 3,
          workspaceName: "默认工作空间",
          toolName: "write",
          createdAt: "2026-10-26T00:00:00.000Z",
        },
      ],
    });
    expect(wired.permissions.listRemembered).toHaveBeenCalledWith(UID);
  });

  it("permission/revokeRemembered：正整数 id 透传 (userId, id)，返回 null", async () => {
    const wired = wireDeps();
    const result = await handleRoute("POST", "permission/revokeRemembered", {
      id: 42,
    });
    expect(result.body).toMatchObject({ success: true, data: null });
    expect(wired.permissions.revokeRemembered).toHaveBeenCalledWith(UID, 42);
  });

  it("permission/revokeRemembered：id 缺省/非正整数 → PERMISSION_INVALID（形态校验，非 5000）", async () => {
    wireDeps();
    await expectBizError(
      "POST",
      "permission/revokeRemembered",
      null,
      "PERMISSION_INVALID",
    );
    await expectBizError(
      "POST",
      "permission/revokeRemembered",
      { id: -1 },
      "PERMISSION_INVALID",
    );
    await expectBizError(
      "POST",
      "permission/revokeRemembered",
      { id: "1" },
      "PERMISSION_INVALID",
    );
  });

  it("permission/revokeAllRemembered：{revoked} 计数信封，调用带归属 userId", async () => {
    const wired = wireDeps();
    const result = await handleRoute(
      "POST",
      "permission/revokeAllRemembered",
      null,
    );
    expect(result.body).toMatchObject({ success: true, data: { revoked: 4 } });
    expect(wired.permissions.revokeAllRemembered).toHaveBeenCalledWith(UID);
  });

  it("permission/listFullGrants：{grants:[{sessionId,title}]} 信封", async () => {
    const wired = wireDeps();
    const result = await handleRoute("POST", "permission/listFullGrants", null);
    expect(result.body).toMatchObject({
      success: true,
      data: { grants: [{ sessionId: 11, title: "会话 #11" }] },
    });
    expect(wired.permissions.listFullGrants).toHaveBeenCalledWith(UID);
  });

  it("permission/revokeAllFull：{revoked} 计数信封", async () => {
    const wired = wireDeps();
    const result = await handleRoute("POST", "permission/revokeAllFull", null);
    expect(result.body).toMatchObject({ success: true, data: { revoked: 2 } });
    expect(wired.permissions.revokeAllFull).toHaveBeenCalledWith(UID);
  });

  it("未装配 permission 面：五端点 5000 接线缺失如实报错", async () => {
    wireDeps();
    const deps = faceDeps();
    const broken = { ...deps } as Record<string, unknown>;
    delete broken.permissions;
    setServerFaceDeps(broken as Parameters<typeof setServerFaceDeps>[0]);
    await expectBizError("POST", "permission/listRemembered", null, "5000");
    await expectBizError(
      "POST",
      "permission/revokeRemembered",
      { id: 1 },
      "5000",
    );
    // 复原（后续用例依赖完整装配）
    setServerFaceDeps(deps as Parameters<typeof setServerFaceDeps>[0]);
  });

  it("FacePermissionError 稳定码透传（tap 守卫与路由形态校验同码）", async () => {
    const wired = wireDeps();
    wired.permissions.revokeRemembered.mockRejectedValueOnce(
      new FacePermissionError("PERMISSION_INVALID", "id 必须是正整数"),
    );
    await expectBizError(
      "POST",
      "permission/revokeRemembered",
      { id: 7 },
      "PERMISSION_INVALID",
    );
  });
});

// —— A5 资料库批（spec 2026-10-26 §3）：library 十六端点路由——形状校验 →
// withUserId → face.library.* → ok/bizError 信封；FaceLibraryError 稳定码
// 透传（控制端判 LIBRARY_* 勿落 5000 兜底，同 files 口径）——
const LIB_ITEM: LibraryItemDto = {
  id: 7,
  parentId: null,
  name: "笔记.md",
  kind: "file",
  fileType: "markdown",
  mimeType: "text/markdown",
  size: 12,
  url: null,
  favorite: false,
  lastViewedAt: null,
  location: [],
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
};

/** 内存 library 面替身（结构同 ServerFaceLibrary，调用断言直查） */
function makeFakeLibrary(overrides: Record<string, unknown> = {}) {
  return {
    list: vi.fn(async () => ({ items: [LIB_ITEM], breadcrumbs: [] })),
    tree: vi.fn(async () => [LIB_ITEM]),
    search: vi.fn(async () => [LIB_ITEM]),
    listRecent: vi.fn(async () => [LIB_ITEM]),
    listFavorites: vi.fn(async () => [LIB_ITEM]),
    createFolder: vi.fn(async () => LIB_ITEM),
    createFile: vi.fn(async () => LIB_ITEM),
    addLink: vi.fn(async () => ({ ...LIB_ITEM, kind: "link" as const })),
    rename: vi.fn(async () => LIB_ITEM),
    move: vi.fn(async () => null),
    delete: vi.fn(async () => null),
    subtreeCount: vi.fn(async () => 2),
    toggleFavorite: vi.fn(async () => ({ ...LIB_ITEM, favorite: true })),
    markViewed: vi.fn(async () => LIB_ITEM),
    read: vi.fn(async () => ({ kind: "text" as const, content: "# hi" })),
    readImage: vi.fn(async () => ({ mime: "image/png", dataBase64: "QUJD" })),
    writeContent: vi.fn(async () => ({ ...LIB_ITEM, size: 6 })),
    uploadFile: vi.fn(async () => ({ ...LIB_ITEM, name: "pic.png" })),
    ...overrides,
  };
}

/** 最小装配：只挂 library 面（+ 单用户解析），其余面与本 describe 无关 */
function wireLibrary(fake: ReturnType<typeof makeFakeLibrary>) {
  setServerFaceDeps({
    resolveUserId: async () => UID,
    library: fake,
  } as never);
  return fake;
}

describe("library 十八端点（A5 资料库批 + 上传批）", () => {
  it("list/tree/search/recent/favorites：端点键 + 载荷映射 + withUserId 传递", async () => {
    const lib = wireLibrary(makeFakeLibrary());

    const list = await handleRoute("POST", ENDPOINTS.library.list, {
      parentId: 3,
    });
    expect(list.body).toMatchObject({
      code: "2000",
      data: { items: [LIB_ITEM], breadcrumbs: [] },
    });
    expect(lib.list).toHaveBeenCalledWith(UID, 3);

    // parentId 缺省/显式 null 均根层
    await handleRoute("POST", ENDPOINTS.library.list, null);
    expect(lib.list).toHaveBeenLastCalledWith(UID, null);

    expect(
      (await handleRoute("POST", ENDPOINTS.library.tree, null)).body,
    ).toMatchObject({ success: true, data: [LIB_ITEM] });
    expect(lib.tree).toHaveBeenCalledWith(UID);

    await handleRoute("POST", ENDPOINTS.library.search, {
      keyword: "  笔记  ",
    });
    expect(lib.search).toHaveBeenCalledWith(UID, "笔记");

    await handleRoute("POST", ENDPOINTS.library.listRecent, null);
    expect(lib.listRecent).toHaveBeenCalledWith(UID);
    await handleRoute("POST", ENDPOINTS.library.listFavorites, null);
    expect(lib.listFavorites).toHaveBeenCalledWith(UID);
  });

  it("createFolder/createFile/addLink：name trim + parentId 映射；addLink title 归一", async () => {
    const lib = wireLibrary(makeFakeLibrary());

    await handleRoute("POST", ENDPOINTS.library.createFolder, {
      name: " 新夹 ",
      parentId: null,
    });
    expect(lib.createFolder).toHaveBeenCalledWith(UID, "新夹", null);

    await handleRoute("POST", ENDPOINTS.library.createFile, {
      name: "doc.md",
      parentId: 5,
    });
    expect(lib.createFile).toHaveBeenCalledWith(UID, "doc.md", 5);

    // title 缺省归 null（链路条目名由 repo 取域名）
    await handleRoute("POST", ENDPOINTS.library.addLink, {
      url: "https://example.com/a",
      parentId: 2,
    });
    expect(lib.addLink).toHaveBeenCalledWith(
      UID,
      "https://example.com/a",
      null,
      2,
    );
  });

  it("rename/move/delete/subtreeCount/toggleFavorite/markViewed 载荷映射", async () => {
    const lib = wireLibrary(makeFakeLibrary());

    await handleRoute("POST", ENDPOINTS.library.rename, {
      id: 5,
      name: " 新名 ",
    });
    expect(lib.rename).toHaveBeenCalledWith(UID, 5, "新名");

    await handleRoute("POST", ENDPOINTS.library.move, {
      ids: [1, 2],
      targetParentId: null,
    });
    expect(lib.move).toHaveBeenCalledWith(UID, [1, 2], null);

    await handleRoute("POST", ENDPOINTS.library.delete, { ids: [9] });
    expect(lib.delete).toHaveBeenCalledWith(UID, [9]);

    const count = await handleRoute("POST", ENDPOINTS.library.subtreeCount, {
      id: 4,
    });
    expect(count.body).toMatchObject({ success: true, data: 2 });
    expect(lib.subtreeCount).toHaveBeenCalledWith(UID, 4);

    const fav = await handleRoute("POST", ENDPOINTS.library.toggleFavorite, {
      id: 6,
    });
    expect(fav.body).toMatchObject({
      success: true,
      data: { ...LIB_ITEM, favorite: true },
    });
    expect(lib.toggleFavorite).toHaveBeenCalledWith(UID, 6);

    await handleRoute("POST", ENDPOINTS.library.markViewed, { id: 6 });
    expect(lib.markViewed).toHaveBeenCalledWith(UID, 6);
  });

  it("read/readImage 直通（{id} 载荷 → face.read/readImage）", async () => {
    const lib = wireLibrary(makeFakeLibrary());

    const read = await handleRoute("POST", ENDPOINTS.library.read, { id: 8 });
    expect(read.body).toMatchObject({
      success: true,
      data: { kind: "text", content: "# hi" },
    });
    expect(lib.read).toHaveBeenCalledWith(UID, 8);

    const img = await handleRoute("POST", ENDPOINTS.library.readImage, {
      id: 8,
    });
    expect(img.body).toMatchObject({
      success: true,
      data: { mime: "image/png", dataBase64: "QUJD" },
    });
    expect(lib.readImage).toHaveBeenCalledWith(UID, 8);
  });

  it("writeContent：{id, content} 载荷 → face.writeContent，回传刷新 DTO", async () => {
    const lib = wireLibrary(makeFakeLibrary());

    const result = await handleRoute("POST", ENDPOINTS.library.writeContent, {
      id: 8,
      content: "新内容",
    });
    expect(result.body).toMatchObject({
      success: true,
      data: { ...LIB_ITEM, size: 6 },
    });
    expect(lib.writeContent).toHaveBeenCalledWith(UID, 8, "新内容");
  });

  it("uploadFile：{name, base64, parentId} 载荷 → face.uploadFile；parentId 可空", async () => {
    const lib = wireLibrary(makeFakeLibrary());

    const result = await handleRoute("POST", ENDPOINTS.library.uploadFile, {
      parentId: 3,
      name: "  pic.png ",
      base64: "iVBORw==",
    });
    expect(result.body).toMatchObject({
      success: true,
      data: { ...LIB_ITEM, name: "pic.png" },
    });
    expect(lib.uploadFile).toHaveBeenCalledWith(UID, {
      parentId: 3,
      name: "pic.png",
      base64: "iVBORw==",
    });

    // parentId 缺省/显式 null 均根层（asParentId null → 协议 undefined 归一）
    await handleRoute("POST", ENDPOINTS.library.uploadFile, {
      name: "a.txt",
      base64: "",
    });
    expect(lib.uploadFile).toHaveBeenLastCalledWith(UID, {
      parentId: undefined,
      name: "a.txt",
      base64: "",
    });
    await handleRoute("POST", ENDPOINTS.library.uploadFile, {
      parentId: null,
      name: "b.txt",
      base64: "QQ==",
    });
    expect(lib.uploadFile).toHaveBeenLastCalledWith(UID, {
      parentId: undefined,
      name: "b.txt",
      base64: "QQ==",
    });
  });

  it("uploadFile：LIBRARY_UPLOAD_INVALID/LIBRARY_NOT_FOUND 稳定码透传信封", async () => {
    wireLibrary(
      makeFakeLibrary({
        uploadFile: vi.fn(async (_uid, payload) => {
          if (payload.parentId === 404) {
            throw new FaceLibraryError("LIBRARY_NOT_FOUND", "资料库条目不存在");
          }
          throw new FaceLibraryError("LIBRARY_UPLOAD_INVALID", "base64 不合法");
        }),
      }),
    );
    const invalid = await handleRoute("POST", ENDPOINTS.library.uploadFile, {
      name: "a.txt",
      base64: "%%%",
    });
    expect(invalid.body).toMatchObject({
      code: "LIBRARY_UPLOAD_INVALID",
      success: false,
      message: "base64 不合法",
    });

    const notFound = await handleRoute("POST", ENDPOINTS.library.uploadFile, {
      parentId: 404,
      name: "a.txt",
      base64: "QUJD",
    });
    expect(notFound.body).toMatchObject({
      code: "LIBRARY_NOT_FOUND",
      success: false,
      message: "资料库条目不存在",
    });
  });

  it("非法载荷 5000：空 name / 非 http(s) url / 空 ids / 缺 id / 缺 keyword", async () => {
    wireLibrary(makeFakeLibrary());
    await expectBizError(
      "POST",
      ENDPOINTS.library.createFolder,
      { name: "   ", parentId: null },
      "5000",
    );
    await expectBizError(
      "POST",
      ENDPOINTS.library.createFile,
      { name: "x.md", parentId: "root" },
      "5000",
    );
    await expectBizError(
      "POST",
      ENDPOINTS.library.addLink,
      { url: "ftp://a.com", parentId: null },
      "5000",
    );
    await expectBizError(
      "POST",
      ENDPOINTS.library.move,
      { ids: [], targetParentId: null },
      "5000",
    );
    await expectBizError(
      "POST",
      ENDPOINTS.library.delete,
      { ids: ["a"] },
      "5000",
    );
    await expectBizError(
      "POST",
      ENDPOINTS.library.rename,
      { name: "x" },
      "5000",
    );
    await expectBizError("POST", ENDPOINTS.library.read, {}, "5000");
    await expectBizError("POST", ENDPOINTS.library.search, null, "5000");
    await expectBizError(
      "POST",
      ENDPOINTS.library.list,
      { parentId: "x" },
      "5000",
    );
    await expectBizError(
      "POST",
      ENDPOINTS.library.writeContent,
      { id: 1 },
      "5000",
    );
    await expectBizError(
      "POST",
      ENDPOINTS.library.writeContent,
      { id: "1", content: "x" },
      "5000",
    );
    await expectBizError(
      "POST",
      ENDPOINTS.library.uploadFile,
      { name: "x.txt" },
      "5000",
    );
    await expectBizError(
      "POST",
      ENDPOINTS.library.uploadFile,
      { name: "   ", base64: "QUJD", parentId: null },
      "5000",
    );
    await expectBizError(
      "POST",
      ENDPOINTS.library.uploadFile,
      { name: "x.txt", base64: 123, parentId: null },
      "5000",
    );
    await expectBizError(
      "POST",
      ENDPOINTS.library.uploadFile,
      { name: "x.txt", base64: "QUJD", parentId: "root" },
      "5000",
    );
  });

  it("未装配 library 面：全部端点 5000 接线缺失如实报错", async () => {
    setServerFaceDeps({
      resolveUserId: async () => UID,
    } as never);
    // 全合法超集载荷（各 handler 只取己需键）——确保走到未装配分支而非
    // 形状校验分支
    const body = {
      name: "x",
      parentId: null,
      url: "https://a.com",
      ids: [1],
      id: 1,
      targetParentId: null,
      keyword: "k",
      content: "x",
      base64: "QUJD",
    };
    for (const path of Object.values(ENDPOINTS.library)) {
      const result = await handleRoute("POST", path, body);
      expect(result.body).toMatchObject({
        code: "5000",
        success: false,
        message: "library 面未装配",
      });
    }
  });

  it("FaceLibraryError 稳定码透传信封；通用错误落 5000 兜底", async () => {
    const lib = wireLibrary(
      makeFakeLibrary({
        read: vi.fn(async () => {
          throw new FaceLibraryError("LIBRARY_NOT_FOUND", "资料库条目不存在");
        }),
        toggleFavorite: vi.fn(async () => {
          throw new Error("磁盘文件同步失败");
        }),
      }),
    );

    const missing = await handleRoute("POST", ENDPOINTS.library.read, {
      id: 404,
    });
    expect(missing.body).toMatchObject({
      code: "LIBRARY_NOT_FOUND",
      success: false,
      message: "资料库条目不存在",
    });

    const failed = await handleRoute("POST", ENDPOINTS.library.toggleFavorite, {
      id: 1,
    });
    expect(failed.body).toMatchObject({ code: "5000", success: false });
    expect(JSON.stringify(failed.body)).toContain("磁盘文件同步失败");
    void lib;
  });

  it("单用户解析失败：5000 被控端尚未初始化用户（存在性不泄露口径）", async () => {
    wireLibrary(makeFakeLibrary());
    setServerFaceDeps({
      resolveUserId: async () => null,
      library: makeFakeLibrary(),
    } as never);
    const result = await handleRoute("POST", ENDPOINTS.library.list, null);
    expect(result.body).toMatchObject({
      code: "5000",
      success: false,
      message: "被控端尚未初始化用户",
    });
  });
});

describe("P1 未读角标批：session/query enriched + session/read", () => {
  /** 会话播种 + assistant/user 消息桩（unread 计 cursor 后 assistant 条数） */
  const seedWithMessages = (
    wired: ReturnType<typeof wireDeps>,
    title: string,
    overrides: Partial<FakeSession> = {},
  ) => {
    const row = wired.seed(title, overrides);
    wired.messages.set(row.id, [
      {
        id: 1,
        sessionId: row.id,
        role: "user" as const,
        blocks: "首轮提问",
        createdAt: "2026-10-26T00:00:00.000Z",
      },
      {
        id: 2,
        sessionId: row.id,
        role: "assistant" as const,
        blocks: "首轮回答",
        createdAt: "2026-10-26T00:00:01.000Z",
      },
      {
        id: 3,
        sessionId: row.id,
        role: "assistant" as const,
        blocks: "次轮回答",
        createdAt: "2026-10-26T00:00:02.000Z",
      },
    ]);
    return row;
  };

  it("session/query：每行透传 unreadCount + lastMessage（末条摘要形状）", async () => {
    const wired = wireDeps();
    seedWithMessages(wired, "未读会话");
    const result = await handleRoute("POST", ENDPOINTS.session.query, {});
    expect(result.status).toBe(200);
    const data = (
      result.body as { data: { records: Array<Record<string, unknown>> } }
    ).data;
    expect(data.records).toHaveLength(1);
    expect(data.records[0]).toMatchObject({
      unreadCount: 2,
      lastMessage: {
        id: 3,
        role: "assistant",
        kind: "text",
        text: "次轮回答",
        createdAt: "2026-10-26T00:00:02.000Z",
      },
    });
  });

  it("session/read：游标单调推进——推进生效、回退幂等、响应含现算未读", async () => {
    const wired = wireDeps();
    const row = seedWithMessages(wired, "阅读会话");

    const first = await handleRoute("POST", ENDPOINTS.session.read, {
      sessionId: row.id,
      messageId: 2,
    });
    expect(first.body).toMatchObject({
      code: "2000",
      success: true,
      data: { sessionId: row.id, lastReadMessageId: 2, unreadCount: 1 },
    });
    expect(wired.rows.get(row.id)?.lastReadMessageId).toBe(2);

    // 回退请求（更小 id）：游标不回退、仍按生效游标现算未读
    const stale = await handleRoute("POST", ENDPOINTS.session.read, {
      sessionId: row.id,
      messageId: 1,
    });
    expect(stale.body).toMatchObject({
      code: "2000",
      data: { lastReadMessageId: 2, unreadCount: 1 },
    });

    // 推进到最新：未读清零
    const newer = await handleRoute("POST", ENDPOINTS.session.read, {
      sessionId: row.id,
      messageId: 3,
    });
    expect(newer.body).toMatchObject({
      code: "2000",
      data: { lastReadMessageId: 3, unreadCount: 0 },
    });
    expect(wired.rows.get(row.id)?.lastReadMessageId).toBe(3);
  });

  it("session/read：会话缺失 / 归属他人 / message 不属会话 同 4040", async () => {
    const wired = wireDeps();
    const row = seedWithMessages(wired, "归属会话");
    // 他人会话：直接改桩归属（同表 userId 隔离语义替身）
    wired.rows.set(row.id, { ...row, userId: UID + 1 });
    await expectBizError(
      "POST",
      ENDPOINTS.session.read,
      { sessionId: row.id, messageId: 2 },
      "4040",
    );
    wired.rows.set(row.id, row);
    await expectBizError(
      "POST",
      ENDPOINTS.session.read,
      { sessionId: 999, messageId: 2 },
      "4040",
    );
    await expectBizError(
      "POST",
      ENDPOINTS.session.read,
      { sessionId: row.id, messageId: 999 },
      "4040",
    );
  });

  it("session/read：sessionId/messageId 非整数或缺失 → 5000 参数不合法", async () => {
    wireDeps();
    await expectBizError(
      "POST",
      ENDPOINTS.session.read,
      { sessionId: "x", messageId: 2 },
      "5000",
    );
    await expectBizError(
      "POST",
      ENDPOINTS.session.read,
      { sessionId: 1 },
      "5000",
    );
    await expectBizError(
      "POST",
      ENDPOINTS.session.read,
      { sessionId: 1, messageId: 1.5 },
      "5000",
    );
  });

  it("session/read：读毕发布 enriched session.updated（unreadCount+lastMessage）", async () => {
    const wired = wireDeps();
    const row = seedWithMessages(wired, "事件会话");
    const events: import("@tianshu/protocol").FaceEvent[] = [];
    const off = onFaceEvent((event) => events.push(event));

    await handleRoute("POST", ENDPOINTS.session.read, {
      sessionId: row.id,
      messageId: 2,
    });
    off();

    const updated = events.filter((e) => e.type === "session.updated");
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({
      type: "session.updated",
      payload: {
        id: row.id,
        unreadCount: 1,
        lastMessage: { id: 3, role: "assistant", kind: "text" },
      },
    });
  });
});

// —— A7 项目批（spec 2026-10-26 §3）：project 域 23 端点路由——形状校验 →
// withUserId → face.{project|planItem|planView|projectAsset}.* → ok/bizError
// 信封；FaceProjectError 稳定码原码透传（控制端判 PROJECT_*/ASSET_* 勿落
// 5000 兜底）；载荷只含协议键——ownerId/createdById 无从混入——
const PROJECT_DTO = {
  id: 11,
  name: "项目甲",
  systemPrompt: null,
  templateKey: null,
  ownerId: UID,
  sessionId: 22,
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
};
const PROJECT_DETAIL = {
  project: PROJECT_DTO,
  assetWorkspaceId: 30,
  bindings: [],
  sessionId: 22,
};
const PLAN_ITEM_DTO = {
  id: 5,
  projectId: 3,
  title: "事项",
  description: "",
  aiSummary: "",
  status: "not_started",
  priority: "P1",
  assigneeId: null,
  tags: [],
  customFields: {},
  startDate: "",
  dueDate: "",
  source: "manual",
  sortOrder: 1,
  createdById: UID,
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
};
const ASSET_ENTRY_DTO = {
  name: "docs",
  type: "folder",
  size: 0,
  updatedAt: "2026-10-26T00:00:00.000Z",
  ext: "",
};

/** 内存 project 面替身（结构同 ServerFaceProject，调用断言直查） */
function makeFakeProject(overrides: Record<string, unknown> = {}) {
  return {
    query: vi.fn(async () => [PROJECT_DTO]),
    getDetail: vi.fn(async () => PROJECT_DETAIL),
    create: vi.fn(async () => PROJECT_DTO),
    update: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    listMembers: vi.fn(async () => [
      { userId: UID, nickname: "昵称", username: "user", role: "owner" },
    ]),
    ...overrides,
  };
}

/** 内存 planItem 面替身（十端点，结构同 ServerFacePlanItem） */
function makeFakePlanItem(overrides: Record<string, unknown> = {}) {
  return {
    list: vi.fn(async () => [PLAN_ITEM_DTO]),
    listMine: vi.fn(async () => [PLAN_ITEM_DTO]),
    create: vi.fn(async () => PLAN_ITEM_DTO),
    update: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    move: vi.fn(async () => {}),
    listFields: vi.fn(async () => [{ name: "进度", type: "text" }]),
    listAttachments: vi.fn(async () => [
      {
        id: 9,
        planItemId: 5,
        fileName: "f.png",
        assetPath: "docs/f.png",
        createdAt: "2026-10-26T00:00:00.000Z",
      },
    ]),
    createAttachment: vi.fn(async () => ({
      id: 9,
      planItemId: 5,
      fileName: "f.png",
      assetPath: "docs/f.png",
      createdAt: "2026-10-26T00:00:00.000Z",
    })),
    removeAttachment: vi.fn(async () => {}),
    ...overrides,
  };
}

function makeFakePlanView(overrides: Record<string, unknown> = {}) {
  return {
    list: vi.fn(async () => [
      {
        id: 1,
        projectId: 3,
        name: "",
        type: "table",
        groupBy: null,
        filterJson: "{}",
        sortJson: "[]",
        sortOrder: 0,
        createdAt: "2026-10-26T00:00:00.000Z",
        updatedAt: "2026-10-26T00:00:00.000Z",
      },
    ]),
    ...overrides,
  };
}

function makeFakeProjectAsset(overrides: Record<string, unknown> = {}) {
  return {
    list: vi.fn(async () => [ASSET_ENTRY_DTO]),
    createFolder: vi.fn(async () => "dir"),
    rename: vi.fn(async () => "b.png"),
    remove: vi.fn(async () => {}),
    storage: vi.fn(async () => ({ usedBytes: 1, quotaBytes: 2 })),
    readImage: vi.fn(async () => ({ mime: "image/png", dataBase64: "QUJD" })),
    ...overrides,
  };
}

/** 最小装配：挂 A7 四面（+ 单用户解析），其余面与本 describe 无关 */
function wireProjectFaces(faces: {
  project?: ReturnType<typeof makeFakeProject>;
  planItem?: ReturnType<typeof makeFakePlanItem>;
  planView?: ReturnType<typeof makeFakePlanView>;
  projectAsset?: ReturnType<typeof makeFakeProjectAsset>;
}) {
  setServerFaceDeps({
    resolveUserId: async () => UID,
    ...faces,
  } as never);
}

describe("project 六端点（A7 项目批）", () => {
  it("query/getDetail/listMembers：端点键 + 载荷映射 + withUserId 传递", async () => {
    const project = makeFakeProject();
    wireProjectFaces({ project });

    expect(
      (await handleRoute("POST", ENDPOINTS.project.query, null)).body,
    ).toMatchObject({ code: "2000", data: [PROJECT_DTO] });
    expect(project.query).toHaveBeenCalledWith(UID);

    const detail = await handleRoute("POST", ENDPOINTS.project.getDetail, {
      id: 11,
    });
    expect(detail.body).toMatchObject({ success: true, data: PROJECT_DETAIL });
    expect(project.getDetail).toHaveBeenCalledWith(UID, 11);

    await handleRoute("POST", ENDPOINTS.project.listMembers, {
      projectId: 11,
    });
    expect(project.listMembers).toHaveBeenCalledWith(UID, 11);
  });

  it("create：name trim + 可选字段归一；body 夹带 ownerId 被剔除", async () => {
    const project = makeFakeProject();
    wireProjectFaces({ project });

    await handleRoute("POST", ENDPOINTS.project.create, {
      name: " 新项目 ",
      systemPrompt: "指令",
      ownerId: 999,
    });
    expect(project.create).toHaveBeenCalledWith(UID, {
      name: "新项目",
      systemPrompt: "指令",
    });
    const payload = project.create.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("ownerId");
  });

  it("update/delete：载荷映射（update 全缺省属参数错）", async () => {
    const project = makeFakeProject();
    wireProjectFaces({ project });

    await handleRoute("POST", ENDPOINTS.project.update, {
      id: 11,
      name: " 改名 ",
    });
    expect(project.update).toHaveBeenCalledWith(UID, { id: 11, name: "改名" });

    await handleRoute("POST", ENDPOINTS.project.update, {
      id: 11,
      systemPrompt: "新指令",
    });
    expect(project.update).toHaveBeenLastCalledWith(UID, {
      id: 11,
      systemPrompt: "新指令",
    });

    const deleted = await handleRoute("POST", ENDPOINTS.project.delete, {
      id: 11,
    });
    expect(deleted.body).toMatchObject({ success: true });
    expect(project.remove).toHaveBeenCalledWith(UID, 11);
  });

  it("非法载荷：create 空 name / update 无字段 / getDetail 缺 id", async () => {
    wireProjectFaces({ project: makeFakeProject() });
    await expectBizError(
      "POST",
      ENDPOINTS.project.create,
      { name: "   " },
      "5000",
    );
    await expectBizError("POST", ENDPOINTS.project.create, { name: 5 }, "5000");
    await expectBizError("POST", ENDPOINTS.project.update, { id: 11 }, "5000");
    await expectBizError(
      "POST",
      ENDPOINTS.project.update,
      { id: 11, systemPrompt: null },
      "5000",
    );
    await expectBizError(
      "POST",
      ENDPOINTS.project.update,
      { name: "x" },
      "5000",
    );
    await expectBizError("POST", ENDPOINTS.project.getDetail, {}, "4040");
    await expectBizError("POST", ENDPOINTS.project.listMembers, {}, "4040");
  });
});

describe("planItem 十端点（A7 项目批）", () => {
  it("list/listMine/fieldsList/attachmentList：载荷映射 + withUserId", async () => {
    const planItem = makeFakePlanItem();
    wireProjectFaces({ planItem });

    await handleRoute("POST", ENDPOINTS.planItem.list, { projectId: 3 });
    expect(planItem.list).toHaveBeenCalledWith(UID, 3);
    expect(
      (await handleRoute("POST", ENDPOINTS.planItem.listMine, null)).body,
    ).toMatchObject({ code: "2000", data: [PLAN_ITEM_DTO] });
    expect(planItem.listMine).toHaveBeenCalledWith(UID);
    await handleRoute("POST", ENDPOINTS.planItem.fieldsList, { projectId: 3 });
    expect(planItem.listFields).toHaveBeenCalledWith(UID, 3);
    await handleRoute("POST", ENDPOINTS.planItem.attachmentList, {
      planItemId: 5,
    });
    expect(planItem.listAttachments).toHaveBeenCalledWith(UID, 5);
  });

  it("create：title trim 截 200 + 全可选字段透传；createdById 夹带被剔除", async () => {
    const planItem = makeFakePlanItem();
    wireProjectFaces({ planItem });

    await handleRoute("POST", ENDPOINTS.planItem.create, {
      title: " 新事项 ",
      projectId: 3,
      status: "in_progress",
      priority: "P0",
      assigneeId: null,
      tags: ["a", "b"],
      customFields: { 进度: 50 },
      startDate: "2026-10-26T00:00:00.000Z",
      dueDate: null,
      createdById: 999,
    });
    expect(planItem.create).toHaveBeenCalledWith(UID, {
      title: "新事项",
      projectId: 3,
      status: "in_progress",
      priority: "P0",
      assigneeId: null,
      tags: ["a", "b"],
      customFields: { 进度: 50 },
      startDate: "2026-10-26T00:00:00.000Z",
      dueDate: null,
    });
    const payload = planItem.create.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("createdById");

    // 本地任务（projectId 缺省）
    await handleRoute("POST", ENDPOINTS.planItem.create, { title: "本地" });
    expect(planItem.create).toHaveBeenLastCalledWith(UID, { title: "本地" });
  });

  it("update/move/delete：载荷映射", async () => {
    const planItem = makeFakePlanItem();
    wireProjectFaces({ planItem });

    await handleRoute("POST", ENDPOINTS.planItem.update, {
      id: 5,
      status: "done",
    });
    expect(planItem.update).toHaveBeenCalledWith(UID, {
      id: 5,
      status: "done",
    });

    const moved = await handleRoute("POST", ENDPOINTS.planItem.move, {
      id: 5,
      status: "done",
      sortOrder: 2,
    });
    expect(moved.body).toMatchObject({ success: true });
    expect(planItem.move).toHaveBeenCalledWith(UID, {
      id: 5,
      status: "done",
      sortOrder: 2,
    });

    await handleRoute("POST", ENDPOINTS.planItem.delete, { id: 5 });
    expect(planItem.remove).toHaveBeenCalledWith(UID, 5);
  });

  it("attachmentCreate/attachmentDelete：fileName/assetPath 非空映射", async () => {
    const planItem = makeFakePlanItem();
    wireProjectFaces({ planItem });

    await handleRoute("POST", ENDPOINTS.planItem.attachmentCreate, {
      planItemId: 5,
      fileName: " f.png ",
      assetPath: "docs/f.png",
    });
    expect(planItem.createAttachment).toHaveBeenCalledWith(UID, 5, {
      fileName: "f.png",
      assetPath: "docs/f.png",
    });

    await handleRoute("POST", ENDPOINTS.planItem.attachmentDelete, { id: 9 });
    expect(planItem.removeAttachment).toHaveBeenCalledWith(UID, 9);
  });

  it("非法载荷：空 title / 畸形 tags / 非字符串日期 / move 缺 sortOrder / 附件缺 assetPath", async () => {
    wireProjectFaces({ planItem: makeFakePlanItem() });
    await expectBizError(
      "POST",
      ENDPOINTS.planItem.create,
      { title: "  " },
      "5000",
    );
    await expectBizError(
      "POST",
      ENDPOINTS.planItem.create,
      { title: "x", tags: [1] },
      "5000",
    );
    await expectBizError(
      "POST",
      ENDPOINTS.planItem.create,
      { title: "x", customFields: { a: {} } },
      "5000",
    );
    await expectBizError(
      "POST",
      ENDPOINTS.planItem.create,
      { title: "x", startDate: 5 },
      "5000",
    );
    await expectBizError(
      "POST",
      ENDPOINTS.planItem.update,
      { id: 5, title: "" },
      "5000",
    );
    await expectBizError(
      "POST",
      ENDPOINTS.planItem.move,
      { id: 5, status: "done" },
      "5000",
    );
    await expectBizError(
      "POST",
      ENDPOINTS.planItem.attachmentCreate,
      { planItemId: 5, fileName: "f.png" },
      "5000",
    );
    await expectBizError(
      "POST",
      ENDPOINTS.planItem.attachmentCreate,
      { planItemId: 5, fileName: "f.png", assetPath: "/abs.png" },
      "5000",
    );
    await expectBizError("POST", ENDPOINTS.planItem.delete, {}, "4040");
  });
});

describe("planView/projectAsset 七端点（A7 项目批）", () => {
  it("planView/list：projectId 映射 + withUserId", async () => {
    const planView = makeFakePlanView();
    wireProjectFaces({ planView });
    const result = await handleRoute("POST", ENDPOINTS.planView.list, {
      projectId: 3,
    });
    expect(result.body).toMatchObject({ success: true });
    expect(planView.list).toHaveBeenCalledWith(UID, 3);
  });

  it("projectAsset 六端点：载荷映射 + 返回直透", async () => {
    const projectAsset = makeFakeProjectAsset();
    wireProjectFaces({ projectAsset });

    await handleRoute("POST", ENDPOINTS.projectAsset.list, {
      projectId: 3,
      path: "docs",
    });
    expect(projectAsset.list).toHaveBeenCalledWith(UID, 3, "docs");
    // path 缺省 = 根层（undefined）
    await handleRoute("POST", ENDPOINTS.projectAsset.list, { projectId: 3 });
    expect(projectAsset.list).toHaveBeenLastCalledWith(UID, 3, undefined);

    await handleRoute("POST", ENDPOINTS.projectAsset.createFolder, {
      projectId: 3,
      parentPath: "",
      name: "新夹",
    });
    expect(projectAsset.createFolder).toHaveBeenCalledWith(UID, 3, "", "新夹");
    await handleRoute("POST", ENDPOINTS.projectAsset.rename, {
      projectId: 3,
      path: "a.png",
      newName: "b",
    });
    expect(projectAsset.rename).toHaveBeenCalledWith(UID, 3, "a.png", "b");
    await handleRoute("POST", ENDPOINTS.projectAsset.delete, {
      projectId: 3,
      path: "a.png",
    });
    expect(projectAsset.remove).toHaveBeenCalledWith(UID, 3, "a.png");
    expect(
      (
        await handleRoute("POST", ENDPOINTS.projectAsset.storage, {
          projectId: 3,
        })
      ).body,
    ).toMatchObject({ code: "2000", data: { usedBytes: 1, quotaBytes: 2 } });
    expect(projectAsset.storage).toHaveBeenCalledWith(UID, 3);

    const img = await handleRoute("POST", ENDPOINTS.projectAsset.readImage, {
      projectId: 3,
      path: "a.png",
    });
    expect(img.body).toMatchObject({
      success: true,
      data: { mime: "image/png", dataBase64: "QUJD" },
    });
    expect(projectAsset.readImage).toHaveBeenCalledWith(UID, 3, "a.png");
  });

  it("非法载荷：/ 开头 path / 空 name / readImage 空 path", async () => {
    wireProjectFaces({ projectAsset: makeFakeProjectAsset() });
    await expectBizError(
      "POST",
      ENDPOINTS.projectAsset.list,
      { projectId: 3, path: "/abs" },
      "5000",
    );
    await expectBizError(
      "POST",
      ENDPOINTS.projectAsset.list,
      { projectId: 3, path: 5 },
      "5000",
    );
    await expectBizError(
      "POST",
      ENDPOINTS.projectAsset.createFolder,
      { projectId: 3, parentPath: "", name: " " },
      "5000",
    );
    await expectBizError(
      "POST",
      ENDPOINTS.projectAsset.rename,
      { projectId: 3, path: "a.png", newName: "  " },
      "5000",
    );
    await expectBizError(
      "POST",
      ENDPOINTS.projectAsset.readImage,
      { projectId: 3, path: "" },
      "5000",
    );
    await expectBizError("POST", ENDPOINTS.planView.list, {}, "4040");
  });
});

describe("A7 项目域 23 端点：未装配 / 错误透传 / 单用户", () => {
  /** 全合法超集载荷（各 handler 只取己需键）——确保走到未装配分支而非
      形状校验分支 */
  const SUPER_BODY = {
    id: 1,
    projectId: 2,
    planItemId: 3,
    name: "x",
    title: "t",
    path: "a/b.png",
    parentPath: "",
    newName: "y",
    fileName: "f.png",
    assetPath: "a/f.png",
    status: "done",
    sortOrder: 1,
    systemPrompt: "s",
  };

  it("未装配对应面：23 端点 5000 如实报错（project/planItem/planView/projectAsset）", async () => {
    const expected = {
      [ENDPOINTS.project.query]: "project 面未装配",
      [ENDPOINTS.project.getDetail]: "project 面未装配",
      [ENDPOINTS.project.create]: "project 面未装配",
      [ENDPOINTS.project.update]: "project 面未装配",
      [ENDPOINTS.project.delete]: "project 面未装配",
      [ENDPOINTS.project.listMembers]: "project 面未装配",
      [ENDPOINTS.planItem.list]: "planItem 面未装配",
      [ENDPOINTS.planItem.listMine]: "planItem 面未装配",
      [ENDPOINTS.planItem.create]: "planItem 面未装配",
      [ENDPOINTS.planItem.update]: "planItem 面未装配",
      [ENDPOINTS.planItem.delete]: "planItem 面未装配",
      [ENDPOINTS.planItem.move]: "planItem 面未装配",
      [ENDPOINTS.planItem.fieldsList]: "planItem 面未装配",
      [ENDPOINTS.planItem.attachmentList]: "planItem 面未装配",
      [ENDPOINTS.planItem.attachmentCreate]: "planItem 面未装配",
      [ENDPOINTS.planItem.attachmentDelete]: "planItem 面未装配",
      [ENDPOINTS.planView.list]: "planView 面未装配",
      [ENDPOINTS.projectAsset.list]: "projectAsset 面未装配",
      [ENDPOINTS.projectAsset.createFolder]: "projectAsset 面未装配",
      [ENDPOINTS.projectAsset.rename]: "projectAsset 面未装配",
      [ENDPOINTS.projectAsset.delete]: "projectAsset 面未装配",
      [ENDPOINTS.projectAsset.storage]: "projectAsset 面未装配",
      [ENDPOINTS.projectAsset.readImage]: "projectAsset 面未装配",
    };
    setServerFaceDeps({ resolveUserId: async () => UID } as never);
    for (const [path, message] of Object.entries(expected)) {
      const result = await handleRoute("POST", path, SUPER_BODY);
      expect(result.body).toMatchObject({
        code: "5000",
        success: false,
        message,
      });
    }
  });

  it("FaceProjectError 稳定码原码透传；通用错误落 5000 兜底", async () => {
    const project = makeFakeProject({
      getDetail: vi.fn(async () => {
        throw new FaceProjectError("PROJECT_NOT_FOUND", "项目不存在");
      }),
    });
    const projectAsset = makeFakeProjectAsset({
      readImage: vi.fn(async () => {
        throw new FaceProjectError("ASSET_NOT_FOUND", "图片超过 10MB 上限");
      }),
      rename: vi.fn(async () => {
        throw new Error("磁盘炸了");
      }),
    });
    wireProjectFaces({ project, projectAsset });

    const missing = await handleRoute("POST", ENDPOINTS.project.getDetail, {
      id: 404,
    });
    expect(missing.body).toMatchObject({
      code: "PROJECT_NOT_FOUND",
      success: false,
      message: "项目不存在",
    });

    const big = await handleRoute("POST", ENDPOINTS.projectAsset.readImage, {
      projectId: 3,
      path: "big.png",
    });
    expect(big.body).toMatchObject({
      code: "ASSET_NOT_FOUND",
      success: false,
      message: "图片超过 10MB 上限",
    });

    const failed = await handleRoute("POST", ENDPOINTS.projectAsset.rename, {
      projectId: 3,
      path: "a.png",
      newName: "b",
    });
    expect(failed.body).toMatchObject({ code: "5000", success: false });
    expect(JSON.stringify(failed.body)).toContain("磁盘炸了");
  });

  it("单用户解析失败：5000 被控端尚未初始化用户（存在性不泄露口径）", async () => {
    wireProjectFaces({ project: makeFakeProject() });
    setServerFaceDeps({
      resolveUserId: async () => null,
      project: makeFakeProject(),
    } as never);
    const result = await handleRoute("POST", ENDPOINTS.project.query, null);
    expect(result.body).toMatchObject({
      code: "5000",
      success: false,
      message: "被控端尚未初始化用户",
    });
  });
});
