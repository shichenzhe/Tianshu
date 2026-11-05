// @vitest-environment jsdom
// 主机切换入口（HD-T4，spec §2.1）：switchToHost 承载切换副作用——
// 切前 kick react-query（批3B：不再清缓存——queryKeyHashFn 按主机隔离，
// 缓存保留回切秒开）、会话搜索与流式缓冲复位、远程 caps 自连接注册表
// 运行上报回填；同主机幂等直 return（零请求）。store 全用真实实现。
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/ipc", () => ({
  invoke: vi.fn(),
  on: () => () => {},
}));

const serverApi = vi.hoisted(() => ({ listConnections: vi.fn() }));
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
import { switchToHost } from "../../../src-react/domains/ai/data-source/switch-host";
import { useSessionSearchStore } from "../../../src-react/domains/ai/store/session-search.store";
import { useChatStore } from "../../../src-react/domains/ai/chat/store/chat.store";

beforeEach(() => {
  vi.clearAllMocks();
  useHostStore.setState({
    activeHost: { kind: "local" },
    caps: LOCAL_HOST_CAPS,
  });
  useSessionSearchStore.getState().reset();
  useChatStore.getState().resetAll();
});

describe("chat.store resetAll", () => {
  it("streams/isStreaming 整体清空", () => {
    useChatStore.getState().startStream(1);
    useChatStore.getState().startStream(2);
    useChatStore.getState().appendDelta(1, "text", "半截内容");
    expect(Object.keys(useChatStore.getState().streams)).toHaveLength(2);

    useChatStore.getState().resetAll();
    expect(useChatStore.getState().streams).toEqual({});
    expect(useChatStore.getState().isStreaming).toEqual({});
  });
});

describe("switchToHost", () => {
  it("切远程：caps 自连接注册表上报回填（chat 开/files 恒关）", async () => {
    serverApi.listConnections.mockResolvedValue({
      activeConnId: null,
      connections: [
        {
          id: "c9",
          name: "无头端",
          state: "connected",
          capabilities: ["chat", "provider", "graph"],
        },
      ],
    });

    await switchToHost(
      { kind: "remote", connId: "c9" },
      { kickQueries: vi.fn() },
    );

    expect(serverApi.listConnections).toHaveBeenCalledTimes(1);
    expect(useHostStore.getState().activeHost).toEqual({
      kind: "remote",
      connId: "c9",
    });
    const caps = useHostStore.getState().caps;
    expect(caps.chat).toBe(true);
    expect(caps.provider).toBe(true);
    expect(caps.graph).toBe(true);
    expect(caps.files).toBe(false);
  });

  it("切换副作用齐发：切前 kick/会话搜索复位/流式缓冲复位", async () => {
    const kickQueries = vi.fn();
    // 污染三个面：query 缓存（spy 断言）、搜索态、流式缓冲
    useSessionSearchStore.getState().setOpen(true);
    useSessionSearchStore.getState().setQuery("旧主机关键词");
    useChatStore.getState().startStream(3);
    serverApi.listConnections.mockResolvedValue({
      activeConnId: null,
      connections: [
        { id: "c1", name: "x", state: "connected", capabilities: ["chat"] },
      ],
    });

    await switchToHost({ kind: "remote", connId: "c1" }, { kickQueries });

    expect(kickQueries).toHaveBeenCalledTimes(1);
    expect(useSessionSearchStore.getState().open).toBe(false);
    expect(useSessionSearchStore.getState().query).toBe("");
    expect(useChatStore.getState().streams).toEqual({});
  });

  it("切回本地：caps 全集，副作用同样触发", async () => {
    useHostStore.setState({ activeHost: { kind: "remote", connId: "c1" } });
    const kickQueries = vi.fn();

    await switchToHost({ kind: "local" }, { kickQueries });

    expect(useHostStore.getState().activeHost).toEqual({ kind: "local" });
    expect(useHostStore.getState().caps.files).toBe(true);
    expect(kickQueries).toHaveBeenCalledTimes(1);
    expect(serverApi.listConnections).not.toHaveBeenCalled();
  });

  it("同主机幂等：副作用不触发且零请求（消灭回填 caps 的重复拉取）", async () => {
    const kickQueries = vi.fn();
    await switchToHost({ kind: "local" }, { kickQueries });
    expect(kickQueries).not.toHaveBeenCalled();
    expect(serverApi.listConnections).not.toHaveBeenCalled();

    // 同远程主机同样幂等（此前仍会拉 listConnections 回填 caps）
    useHostStore.setState({ activeHost: { kind: "remote", connId: "c1" } });
    await switchToHost({ kind: "remote", connId: "c1" }, { kickQueries });
    expect(kickQueries).not.toHaveBeenCalled();
    expect(serverApi.listConnections).not.toHaveBeenCalled();
  });

  it("注册表查无该连接（已删）：caps 保持空面不炸", async () => {
    serverApi.listConnections.mockResolvedValue({
      activeConnId: null,
      connections: [],
    });
    await switchToHost(
      { kind: "remote", connId: "gone" },
      { kickQueries: vi.fn() },
    );
    expect(useHostStore.getState().activeHost).toEqual({
      kind: "remote",
      connId: "gone",
    });
    expect(useHostStore.getState().caps.chat).toBe(false);
  });
});
