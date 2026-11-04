// ui-drive 被控面 E2E 冒烟（UD-T3，spec 2026-10-17 §2/§4）：真实 HTTP 面
// （server-face node:http + Bearer 鉴权 + starter 包装体 + 路由表）直连
// 驱动 ui 三端点——
// - ui/notify 往返：2000 + notified:true，主窗收到 ui:notify 事件载荷
// - ui/openRoute 穿越段 /module/../login → 4005 拒且不驱动主窗（UD-T3
//   段校验上提的线上行为钉子）；合法 /module/ 路由与查询串含 // 放行
// - ui/openSession 不存在会话 → 4040「会话不存在」
// 实现口径（任务书「选实现最轻者」）：桌面被控面模块顶层 import electron
// （BrowserWindow）/Log/prisma-client（app），纯 node 原样起进程即抛——
// e2e-smoke「不复用 mirror transport」同一事实；故经 vitest 跑本文件
// （@tianshu alias + vi.mock 三桩为最轻可行），桩外的 HTTP 面/鉴权/
// 请求体解析/路由分发/包装体均为真实代码路径。手动冒烟不可行（并行
// 会话占用 dev 环境），本脚本覆盖即算（ledger 备案）。
// 运行：npm run test:e2e:ui（文件名无 .test. 段不进 vitest 常规集）
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const FACE_TOKEN = "e2e-ui-token";

// 主窗替身容器（vi.mock 工厂引用，hoisted）：首个 = 主窗（先建不变式）
const electronWindows = vi.hoisted(() => ({
  current: [] as unknown[],
}));

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => electronWindows.current },
}));
vi.mock("../../../electron/commons/Log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// option 表桩：serverFace 配置行（enabled+token，port 0 随机）——
// ensureServerFace 与逐请求鉴权（handleFaceRequest 每次重读）同源
vi.mock("../../../electron/commons/prisma-client", () => ({
  default: {
    option: {
      findFirst: vi.fn(async () => ({
        value: JSON.stringify({ enabled: true, port: 0, token: FACE_TOKEN }),
      })),
    },
  },
}));

import {
  ensureServerFace,
  stopServerFace,
} from "../../../electron/domains/server-face/server-face";
import {
  setServerFaceDeps,
  type ServerFaceSessions,
} from "../../../electron/domains/server-face/deps";

/** 主窗 webContents.send 捕获账本（channel, payload） */
const windowEvents: Array<{ channel: string; payload: unknown }> = [];

let base = "";

/** POST 往返（token 省略 = 不带鉴权头） */
async function post(
  path: string,
  body: unknown,
  token: string | null = FACE_TOKEN,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? null),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

beforeAll(async () => {
  // 主窗替身：聚焦三连可调用，webContents.send 记账
  electronWindows.current = [
    {
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: () => {},
      show: () => {},
      focus: () => {},
      webContents: {
        send: (channel: string, payload: unknown) => {
          windowEvents.push({ channel, payload });
        },
      },
    },
  ];
  setServerFaceDeps({
    sessions: {
      // ui/openSession 4040 路径只需 getSessionById（不存在 → 业务错）；
      // 其余方法本冒烟不可达，结构子集经 as 收口
      getSessionById: async () => {
        throw new Error("SESSION_NOT_FOUND");
      },
    } as unknown as ServerFaceSessions,
    chat: { send: vi.fn(), stop: vi.fn(), respondApproval: vi.fn() },
    approvals: { respond: vi.fn() },
    providers: { listBundle: vi.fn() },
    images: { readImage: vi.fn() },
    resolveUserId: async () => 1,
    resolveDefaultWorkspaceId: async () => 1,
    info: async () => ({
      name: "tianshu-desktop",
      version: "0.0.0-e2e",
      instanceId: "iid-e2e-ui",
      capabilities: ["chat", "provider", "ui-drive"],
      username: "测试用户",
    }),
  });
  const port = await ensureServerFace();
  expect(port).toBeGreaterThan(0);
  base = `http://127.0.0.1:${port}`;
  console.log(`[e2e-ui] serverFace 已起：${base}（token ${FACE_TOKEN}）`);
});

afterAll(async () => {
  await stopServerFace();
});

describe("ui-drive 被控面 E2E 冒烟（UD-T3）", () => {
  it("未带 token → HTTP 401（4010 包装，不裸奔）", async () => {
    const result = await post("/ui/notify", { title: "t" }, null);
    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ code: "4010", success: false });
  });

  it("ui/notify 往返：2000 + notified:true，主窗收到 ui:notify 载荷", async () => {
    const result = await post("/ui/notify", {
      title: "远控提醒",
      message: "e2e 正文",
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      code: "2000",
      success: true,
      message: "success",
      data: { notified: true },
    });
    expect(windowEvents).toContainEqual({
      channel: "ui:notify",
      payload: { title: "远控提醒", message: "e2e 正文" },
    });
  });

  it("ui/openRoute 穿越段 4005：/module/../login 主进程即拒，不驱动主窗", async () => {
    const before = windowEvents.length;
    const result = await post("/ui/openRoute", { path: "/module/../login" });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      code: "4005",
      success: false,
      data: null,
      message: "path 必须为 /module/ 前缀的应用内路由",
    });
    expect(windowEvents.length).toBe(before);
  });

  it("ui/openRoute 合法放行：/module/ 路由与查询串含 //（UD-T3 口径）→ opened:true", async () => {
    const plain = await post("/ui/openRoute", { path: "/module/ai/server" });
    expect(plain.body).toMatchObject({
      code: "2000",
      success: true,
      data: { opened: true },
    });
    const query = await post("/ui/openRoute", {
      path: "/module/ai?redirect=a//b",
    });
    expect(query.body).toMatchObject({
      code: "2000",
      success: true,
      data: { opened: true },
    });
    expect(windowEvents).toContainEqual({
      channel: "ui:openRoute",
      payload: { path: "/module/ai/server" },
    });
    expect(windowEvents).toContainEqual({
      channel: "ui:openRoute",
      payload: { path: "/module/ai?redirect=a//b" },
    });
  });

  it("ui/openSession 不存在会话 → 4040「会话不存在」", async () => {
    const result = await post("/ui/openSession", { sessionId: 987654 });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      code: "4040",
      success: false,
      data: null,
      message: "会话不存在",
    });
  });
});
