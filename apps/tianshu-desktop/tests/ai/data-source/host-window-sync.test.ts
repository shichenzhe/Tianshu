// @vitest-environment jsdom
// 主机态跨窗口同步（webview 批 2026-11-11）：主窗 switchToHost 落
// localStorage 快照；文件窗 initFileWindowHostSync 初值应用 + storage
// 事件跟随（kick/caps 回填语义对齐 switchToHost）；损坏快照落本地
// 兜底；退订后不再跟随。store/ipc 语义全用真实实现（ServerApi mock）。
import { describe, expect, it, vi, beforeEach } from "vitest";

// localStorage stub：与 tests/lib/keybinding-dispatcher.test.ts 同款内存 stub
vi.hoisted(() => {
  const memory = new Map<string, string>();
  const stub = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
});

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
import {
  dispatchHostStorageForTest,
  initFileWindowHostSync,
} from "../../../src-react/domains/ai/data-source/host-window-sync";

const CONNECTIONS = {
  activeConnId: null,
  connections: [
    {
      id: "conn-pg",
      name: "docker-pg",
      state: "connected",
      capabilities: ["chat", "files", "graph"],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useHostStore.setState({
    activeHost: { kind: "local" },
    caps: LOCAL_HOST_CAPS,
  });
  serverApi.listConnections.mockResolvedValue(CONNECTIONS);
});

describe("主窗侧快照发布", () => {
  it("switchToHost 切远程后 localStorage 落快照", async () => {
    await switchToHost(
      { kind: "remote", connId: "conn-pg" },
      {
        kickQueries: () => {},
      },
    );
    expect(localStorage.getItem("tianshu-active-host")).toBe(
      JSON.stringify({ kind: "remote", connId: "conn-pg" }),
    );
  });

  it("同主机幂等不写快照", async () => {
    await switchToHost({ kind: "local" }, { kickQueries: () => {} });
    expect(localStorage.getItem("tianshu-active-host")).toBeNull();
  });
});

describe("文件窗引导", () => {
  it("初值应用：快照为远程 → store 切远程 + caps 回填", async () => {
    localStorage.setItem(
      "tianshu-active-host",
      JSON.stringify({ kind: "remote", connId: "conn-pg" }),
    );
    const kicks: number[] = [];
    initFileWindowHostSync({
      kickQueries: () => kicks.push(1),
    })();
    expect(useHostStore.getState().activeHost).toEqual({
      kind: "remote",
      connId: "conn-pg",
    });
    expect(kicks).toHaveLength(1);
    // caps 回填异步（连接注册表上报）
    await vi.waitFor(() =>
      expect(useHostStore.getState().caps.files).toBe(true),
    );
    expect(useHostStore.getState().caps.chat).toBe(true);
  });

  it("无快照/损坏快照 → 本地兜底零副作用", () => {
    localStorage.setItem("tianshu-active-host", "{broken json");
    const kicks: number[] = [];
    initFileWindowHostSync({
      kickQueries: () => kicks.push(1),
    })();
    expect(useHostStore.getState().activeHost).toEqual({ kind: "local" });
    expect(kicks).toHaveLength(0);
  });

  it("storage 事件跟随：主窗切 conn-pg → 文件窗 store 跟切 + kick", async () => {
    const unsub = initFileWindowHostSync({
      kickQueries: () => {},
    });
    dispatchHostStorageForTest({ kind: "remote", connId: "conn-pg" });
    expect(useHostStore.getState().activeHost).toEqual({
      kind: "remote",
      connId: "conn-pg",
    });
    await vi.waitFor(() =>
      expect(useHostStore.getState().caps.graph).toBe(true),
    );
    unsub();
  });

  it("退订后不再跟随", () => {
    const unsub = initFileWindowHostSync({
      kickQueries: () => {},
    });
    unsub();
    dispatchHostStorageForTest({ kind: "remote", connId: "conn-pg" });
    expect(useHostStore.getState().activeHost).toEqual({ kind: "local" });
  });

  it("同主机 storage 事件幂等（不 kick 不切）", () => {
    const kicks: number[] = [];
    initFileWindowHostSync({
      kickQueries: () => kicks.push(1),
    });
    dispatchHostStorageForTest({ kind: "local" });
    expect(kicks).toHaveLength(0);
    expect(useHostStore.getState().activeHost).toEqual({ kind: "local" });
  });
});
