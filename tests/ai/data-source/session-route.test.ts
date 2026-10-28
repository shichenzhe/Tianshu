// @vitest-environment jsdom
// session 域主机路由化（HD-T2，spec §2.2/2.3）：
// - 本地主机：SessionApi 全方法 invoke 原通道（参数逐字——本地零行为变化）
// - 远程主机：走 remote-session 适配器（server:* 通道）；形状转换后 UI 类型一致
// mock @/lib/ipc 与 server.api（适配器依赖 requestRemote）
import { describe, expect, it, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  on: () => () => {},
}));

const serverApi = vi.hoisted(() => ({
  sessionList: vi.fn(),
  sessionGet: vi.fn(),
  sessionCreate: vi.fn(),
  sessionDelete: vi.fn(),
  sessionUpdate: vi.fn(),
}));
vi.mock("../../../src-react/domains/ai/server/api/server.api", () => ({
  default: serverApi,
  requestRemote: vi.fn(),
  LOCAL_CONNECTION_ID: "local",
  newConnectionId: vi.fn(() => "conn-x"),
  on: () => () => {},
  onRemoteChunk: () => () => {},
  onRemoteEvent: () => () => {},
}));

import {
  useHostStore,
  LOCAL_HOST_CAPS,
} from "../../../src-react/domains/ai/data-source/host.store";
import SessionApi from "../../../src-react/domains/ai/api/session.api";

beforeEach(() => {
  vi.clearAllMocks();
  useHostStore.setState({
    activeHost: { kind: "local" },
    caps: LOCAL_HOST_CAPS,
  });
});

describe("SessionApi 本地主机（零行为变化）", () => {
  it("listAll/rename/pin/setMode：invoke 原通道参数逐字", async () => {
    invoke.mockResolvedValue([]);
    await SessionApi.listAll();
    expect(invoke).toHaveBeenCalledWith("session:listAll");

    invoke.mockResolvedValue(undefined);
    await SessionApi.rename(7, "新名");
    expect(invoke).toHaveBeenCalledWith("session:rename", 7, "新名");

    await SessionApi.pin(7, true);
    expect(invoke).toHaveBeenCalledWith("session:pin", 7, true);

    await SessionApi.setMode(7, "ask");
    expect(invoke).toHaveBeenCalledWith("session:setMode", 7, "ask");

    await SessionApi.setModel(7, 11);
    expect(invoke).toHaveBeenCalledWith("session:setModel", 7, 11);
    expect(serverApi.sessionUpdate).not.toHaveBeenCalled();
  });
});

describe("SessionApi 远程主机（适配器映射）", () => {
  it("listAll：分页拉拼全量 + SessionRecord 形状（mode 收窄/pinnedAt/archivedAt）", async () => {
    useHostStore.getState().switchHost({ kind: "remote", connId: "c1" });
    serverApi.sessionList
      .mockResolvedValueOnce({
        page: 1,
        pageSize: 500,
        total: 2,
        records: [
          {
            id: 1,
            title: "远端会话",
            mode: "ask",
            updatedAt: "2026-10-19T00:00:00.000Z",
            pinnedAt: "2026-10-18T00:00:00.000Z",
          },
          { id: 2, title: "归档", mode: "agent", archivedAt: "x" },
        ],
      })
      // 第二页空收口（page*pageSize >= total 已 break——只调一次即可，
      // 这里 mock 兜底防意外二次拉取）
      .mockResolvedValueOnce({ page: 2, pageSize: 500, total: 2, records: [] });

    const result = await SessionApi.listAll();
    expect(serverApi.sessionList).toHaveBeenCalledWith(
      { page: 1, pageSize: 500 },
      "c1",
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id: 1,
      title: "远端会话",
      mode: "ask",
      pinnedAt: "2026-10-18T00:00:00.000Z",
    });
    expect(result[1]).toMatchObject({ id: 2, archivedAt: "x" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rename/pin/archive/setAssistant/setModel：复合 sessionUpdate 映射", async () => {
    useHostStore.getState().switchHost({ kind: "remote", connId: "c2" });
    serverApi.sessionUpdate.mockResolvedValue(undefined);

    await SessionApi.rename(5, "t");
    expect(serverApi.sessionUpdate).toHaveBeenCalledWith(
      5,
      { title: "t" },
      "c2",
    );

    await SessionApi.pin(5, true);
    expect(serverApi.sessionUpdate).toHaveBeenLastCalledWith(
      5,
      { pinned: true },
      "c2",
    );

    await SessionApi.archive(5, false);
    expect(serverApi.sessionUpdate).toHaveBeenLastCalledWith(
      5,
      { archived: false },
      "c2",
    );

    await SessionApi.setAssistant(5, 21);
    expect(serverApi.sessionUpdate).toHaveBeenLastCalledWith(
      5,
      { assistantId: 21 },
      "c2",
    );

    await SessionApi.setModel(5, 11);
    expect(serverApi.sessionUpdate).toHaveBeenLastCalledWith(
      5,
      { currentModelId: 11 },
      "c2",
    );
  });

  it("delete：server:sessionDelete；listMessages：详情拼全量首页语义", async () => {
    useHostStore.getState().switchHost({ kind: "remote", connId: "c3" });
    serverApi.sessionDelete.mockResolvedValue(undefined);
    await SessionApi.delete(9);
    expect(serverApi.sessionDelete).toHaveBeenCalledWith(9, "c3");

    serverApi.sessionGet.mockResolvedValue({
      session: { id: 9, title: "s", mode: "agent" },
      messages: [
        { id: 1, role: "user", blocks: "[]" },
        {
          id: 2,
          role: "assistant",
          blocks: "[]",
          createdAt: "t",
          modelId: 3,
          durationMs: 2350,
        },
      ],
    });
    const page = await SessionApi.listMessages(9);
    expect(page.hasMore).toBe(false);
    expect(page.items).toHaveLength(2);
    expect(page.items[1]).toMatchObject({
      sessionId: 9,
      modelId: 3,
      durationMs: 2350,
    });
  });
});
