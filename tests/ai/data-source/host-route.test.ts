// @vitest-environment jsdom
// 主机数据源骨架（HD-T1，spec 2026-10-19 §2.1/2.2）：
// - hostStore：activeHost 默认本地；switchHost 切换+同主机幂等+onSwitched 钩子
// - capsOfCapabilities：远程上报 capabilities → HostCaps 推导（files 恒 false）
// - routeInvoke：本地走 invoke 原通道（参数逐字透传）；远程走适配器闭包
// - onChatStream：本地 chat:stream:<sid> / 远程 server:chunk:<connId>:<sid>
// mock @/lib/ipc（invoke/on 双面）
import { describe, expect, it, vi, beforeEach } from "vitest";

const invoke = vi.fn();
// listener 签名对齐真实 lib/ipc.on：Electron (event, ...args)——主进程
// send(channel, chunk) 到达时回调收 (event, chunk)，chunk 在第二参
const listeners = new Map<
  string,
  Array<(event: unknown, ...args: unknown[]) => void>
>();
vi.mock("@/lib/ipc", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  on: (
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => void,
  ) => {
    const arr = listeners.get(channel) ?? [];
    arr.push(listener);
    listeners.set(channel, arr);
    return () => {
      const cur = listeners.get(channel) ?? [];
      const i = cur.indexOf(listener);
      if (i >= 0) cur.splice(i, 1);
    };
  },
}));

import {
  useHostStore,
  LOCAL_HOST_CAPS,
  capsOfCapabilities,
} from "../../../src-react/domains/ai/data-source/host.store";
import {
  routeInvoke,
  remoteConnId,
} from "../../../src-react/domains/ai/data-source/host-route";
import { onChatStream } from "../../../src-react/domains/ai/data-source/chat-stream";

beforeEach(() => {
  vi.clearAllMocks();
  listeners.clear();
  useHostStore.setState({
    activeHost: { kind: "local" },
    caps: LOCAL_HOST_CAPS,
  });
});

describe("host.store", () => {
  it("默认本地主机；caps 全集（files=true）", () => {
    const s = useHostStore.getState();
    expect(s.activeHost.kind).toBe("local");
    expect(s.caps.files).toBe(true);
    expect(remoteConnId()).toBeNull();
  });

  it("switchHost 切远程：activeHost/caps 更新+onSwitched 钩子触发；同主机幂等", () => {
    const onSwitched = vi.fn();
    useHostStore
      .getState()
      .switchHost({ kind: "remote", connId: "c1" }, { onSwitched });
    expect(useHostStore.getState().activeHost).toEqual({
      kind: "remote",
      connId: "c1",
    });
    expect(useHostStore.getState().caps.files).toBe(false);
    expect(onSwitched).toHaveBeenCalledTimes(1);
    expect(remoteConnId()).toBe("c1");

    // 同 connId 幂等（钩子不再触发）
    useHostStore.getState().switchHost({ kind: "remote", connId: "c1" });
    expect(onSwitched).toHaveBeenCalledTimes(1);

    // 切回本地
    useHostStore.getState().switchHost({ kind: "local" });
    expect(useHostStore.getState().caps.files).toBe(true);
    expect(remoteConnId()).toBeNull();
  });

  it("capsOfCapabilities：chat+provider+graph 上报 → 对应面开/files 恒关", () => {
    const caps = capsOfCapabilities(["chat", "provider", "graph"]);
    expect(caps.chat).toBe(true);
    expect(caps.provider).toBe(true);
    expect(caps.graph).toBe(true);
    expect(caps.files).toBe(false);
    expect(capsOfCapabilities([]).chat).toBe(false);
  });
});

describe("routeInvoke", () => {
  it("本地主机：invoke 原通道透传（参数逐字）", async () => {
    invoke.mockResolvedValue([{ id: 1 }]);
    const result = await routeInvoke({ ch: "session:listAll", args: [7] }, () =>
      Promise.reject(new Error("不应走远程")),
    );
    expect(result).toEqual([{ id: 1 }]);
    expect(invoke).toHaveBeenCalledWith("session:listAll", 7);
  });

  it("远程主机：走适配器闭包（connId 透传），不触 invoke", async () => {
    useHostStore.getState().switchHost({ kind: "remote", connId: "c2" });
    const adapter = vi.fn(async (connId: string) => `remote-${connId}`);
    const result = await routeInvoke(
      { ch: "session:listAll", args: [] },
      adapter,
    );
    expect(result).toBe("remote-c2");
    expect(adapter).toHaveBeenCalledWith("c2");
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("onChatStream", () => {
  it("本地主机订阅 chat:stream:<sid>；取消即退订", () => {
    const off = onChatStream(9, (chunk) => {
      expect(chunk).toEqual({ type: "finish" });
    });
    const arr = listeners.get("chat:stream:9");
    expect(arr).toHaveLength(1);
    arr?.[0](undefined, { type: "finish" });
    off();
    expect(listeners.get("chat:stream:9")).toHaveLength(0);
  });

  it("远程主机订阅 server:chunk:<connId>:<sid>", () => {
    useHostStore.getState().switchHost({ kind: "remote", connId: "c3" });
    const seen: unknown[] = [];
    const off = onChatStream(9, (chunk) => seen.push(chunk));
    const arr = listeners.get("server:chunk:c3:9");
    expect(arr).toHaveLength(1);
    arr?.[0](undefined, { type: "text-delta", text: "hi" });
    expect(seen).toEqual([{ type: "text-delta", text: "hi" }]);
    off();
  });
});
