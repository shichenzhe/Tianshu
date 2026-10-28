// @vitest-environment jsdom
// chat 域主机路由化（HD-T3，spec §2.2/2.3）：
// - 本地主机：ChatApi 流式五方法（send/regenerate/editAndResend/stop/
//   usage）invoke 原通道参数逐字；onChatStream 走 chat:stream 动态通道
// - 远程主机：server:* 通道映射（sessionSend/sessionRegenerate/
//   sessionEditResend/sessionAbort/sessionUsage）；流订阅走
//   server:chunk:<connId>:<sessionId>
// mock @/lib/ipc 与 server.api（适配器依赖 requestRemote）
import { describe, expect, it, vi, beforeEach } from "vitest";

const invoke = vi.fn();
const on = vi.fn(() => () => {});
vi.mock("@/lib/ipc", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  on: (...args: unknown[]) => on(...args),
}));

const serverApi = vi.hoisted(() => ({
  sessionSend: vi.fn(),
  sessionRegenerate: vi.fn(),
  sessionEditResend: vi.fn(),
  sessionAbort: vi.fn(),
  sessionUsage: vi.fn(),
  sessionAccessMode: vi.fn(),
  approveSession: vi.fn(),
  filesUploadImage: vi.fn(),
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
import ChatApi, {
  onChatStream,
} from "../../../src-react/domains/ai/api/chat.api";

beforeEach(() => {
  vi.clearAllMocks();
  useHostStore.setState({
    activeHost: { kind: "local" },
    caps: LOCAL_HOST_CAPS,
  });
});

describe("ChatApi 本地主机（零行为变化）", () => {
  it("send/regenerate/editAndResend/stop/usage：invoke 原通道参数逐字", async () => {
    invoke.mockResolvedValue(undefined);
    // send：空 images 归一化掉（载荷与既往一致）
    await ChatApi.send({ sessionId: 1, content: "hi", modelId: 3, images: [] });
    expect(invoke).toHaveBeenCalledWith("chat:send", {
      sessionId: 1,
      content: "hi",
      modelId: 3,
    });
    // send：非空 images 保留
    await ChatApi.send({
      sessionId: 1,
      content: "看图",
      images: [{ absPath: "/a.png" }],
    });
    expect(invoke).toHaveBeenLastCalledWith("chat:send", {
      sessionId: 1,
      content: "看图",
      images: [{ absPath: "/a.png" }],
    });

    await ChatApi.regenerate(7, 12);
    expect(invoke).toHaveBeenCalledWith("chat:regenerate", 7, 12);
    await ChatApi.regenerate(7);
    expect(invoke).toHaveBeenLastCalledWith("chat:regenerate", 7, undefined);

    await ChatApi.editAndResend(7, 3, "改写");
    expect(invoke).toHaveBeenCalledWith("chat:editAndResend", 7, 3, "改写");

    await ChatApi.stop(7);
    expect(invoke).toHaveBeenCalledWith("chat:stop", 7);

    const breakdown = { system: 1, total: 1, contextWindow: null };
    invoke.mockResolvedValue(breakdown);
    await expect(ChatApi.usage(7)).resolves.toBe(breakdown);
    expect(invoke).toHaveBeenCalledWith("chat:usage", 7);

    // status/权限：本地 invoke 原通道参数逐字
    const snapshot = {
      streaming: false,
      accessMode: "full",
      text: "",
      thinking: "",
      tools: { order: [], map: {} },
    };
    invoke.mockResolvedValue(snapshot);
    await expect(ChatApi.status(7)).resolves.toBe(snapshot);
    expect(invoke).toHaveBeenCalledWith("chat:status", 7);
    invoke.mockResolvedValue("full");
    await expect(ChatApi.getPermission(7)).resolves.toBe("full");
    expect(invoke).toHaveBeenCalledWith("permission:get", 7);
    await ChatApi.setPermission(7, "full");
    expect(invoke).toHaveBeenLastCalledWith("permission:set", 7, "full");
    expect(serverApi.sessionSend).not.toHaveBeenCalled();
  });

  it("onChatStream：chat:stream 动态通道，chunk 透传", () => {
    const chunks: unknown[] = [];
    const off = onChatStream(5, (chunk) => chunks.push(chunk));
    expect(on).toHaveBeenCalledWith("chat:stream:5", expect.any(Function));

    // 真实签名 (event, chunk)：listener 第二参才是 chunk
    const listener = on.mock.calls[0][1] as (
      event: unknown,
      ...args: unknown[]
    ) => void;
    listener(undefined, { type: "text-delta", text: "x" });
    expect(chunks).toEqual([{ type: "text-delta", text: "x" }]);
    off();
  });
});

describe("ChatApi 远程主机（适配器映射）", () => {
  it("send：sessionSend 映射（sessionId/content/modelId；无图时 images 缺省不传）", async () => {
    useHostStore.getState().switchHost({ kind: "remote", connId: "c1" });
    serverApi.sessionSend.mockResolvedValue(undefined);

    await ChatApi.send({ sessionId: 9, content: "你好", modelId: 4 });
    expect(serverApi.sessionSend).toHaveBeenCalledWith(
      9,
      "你好",
      "c1",
      4,
      undefined,
      undefined,
    );

    await ChatApi.send({ sessionId: 9, content: "再发" });
    expect(serverApi.sessionSend).toHaveBeenLastCalledWith(
      9,
      "再发",
      "c1",
      undefined,
      undefined,
      undefined,
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("regenerate/editAndResend/stop：sessionRegenerate/sessionEditResend/sessionAbort 映射", async () => {
    useHostStore.getState().switchHost({ kind: "remote", connId: "c2" });

    await ChatApi.regenerate(7, 12);
    expect(serverApi.sessionRegenerate).toHaveBeenCalledWith(7, 12, "c2");
    await ChatApi.regenerate(7);
    expect(serverApi.sessionRegenerate).toHaveBeenLastCalledWith(
      7,
      undefined,
      "c2",
    );

    await ChatApi.editAndResend(7, 3, "改写");
    expect(serverApi.sessionEditResend).toHaveBeenCalledWith(
      7,
      3,
      "改写",
      "c2",
    );

    await ChatApi.stop(7);
    expect(serverApi.sessionAbort).toHaveBeenCalledWith(7, "c2");
  });

  it("approveToolCall：本地 invoke 原通道（sessionId 不上行）；远程 approveSession 映射", async () => {
    invoke.mockResolvedValue(undefined);
    await ChatApi.approveToolCall(7, "tc1", true);
    expect(invoke).toHaveBeenCalledWith("agent:approve", "tc1", true);

    useHostStore.getState().switchHost({ kind: "remote", connId: "c9" });
    serverApi.approveSession.mockResolvedValue(undefined);
    await ChatApi.approveToolCall(7, "tc2", false);
    expect(serverApi.approveSession).toHaveBeenCalledWith(
      "c9",
      7,
      "tc2",
      false,
    );
  });

  it("usage：sessionUsage 直传（SessionUsageBreakdown 与本地 Breakdown 同构）", async () => {
    useHostStore.getState().switchHost({ kind: "remote", connId: "c3" });
    const breakdown = {
      system: 100,
      tools: 200,
      messages: 300,
      mcp: 0,
      skills: 50,
      total: 650,
      contextWindow: 8000,
    };
    serverApi.sessionUsage.mockResolvedValue(breakdown);

    await expect(ChatApi.usage(9)).resolves.toEqual(breakdown);
    expect(serverApi.sessionUsage).toHaveBeenCalledWith(9, "c3");
    // 未配模型 null（UI 灰态语义保持）
    serverApi.sessionUsage.mockResolvedValue(null);
    await expect(ChatApi.usage(10)).resolves.toBeNull();
  });

  it("status：远程恒非流式态（accessMode 查询对齐，流态由订阅表达）", async () => {
    useHostStore.getState().switchHost({ kind: "remote", connId: "c5" });
    serverApi.sessionAccessMode.mockResolvedValue({ mode: "full" });

    await expect(ChatApi.status(9)).resolves.toEqual({
      streaming: false,
      accessMode: "full",
      text: "",
      thinking: "",
      tools: { order: [], map: {} },
    });
    expect(serverApi.sessionAccessMode).toHaveBeenCalledWith(
      9,
      undefined,
      "c5",
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("permission get/set：sessionAccessMode get/set 合一端点映射", async () => {
    useHostStore.getState().switchHost({ kind: "remote", connId: "c6" });
    serverApi.sessionAccessMode.mockResolvedValue({ mode: "default" });

    await expect(ChatApi.getPermission(9)).resolves.toBe("default");
    expect(serverApi.sessionAccessMode).toHaveBeenCalledWith(
      9,
      undefined,
      "c6",
    );

    await ChatApi.setPermission(9, "full");
    expect(serverApi.sessionAccessMode).toHaveBeenLastCalledWith(
      9,
      "full",
      "c6",
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("onChatStream：server:chunk 动态通道，chunk 透传", () => {
    useHostStore.getState().switchHost({ kind: "remote", connId: "c4" });
    const chunks: unknown[] = [];
    onChatStream(5, (chunk) => chunks.push(chunk));
    expect(on).toHaveBeenCalledWith("server:chunk:c4:5", expect.any(Function));

    const listener = on.mock.calls[0][1] as (
      event: unknown,
      ...args: unknown[]
    ) => void;
    listener(undefined, { type: "finish" });
    expect(chunks).toEqual([{ type: "finish" }]);
  });
});
