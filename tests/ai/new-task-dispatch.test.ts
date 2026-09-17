/**
 * 新建任务 dispatch 发送编排单测（spec §3.2）：create(scenario) →
 * [full: setPermission] → send（引用前缀块注入，ChatView 同口径；发起即
 * 继续不等流结束——chat:send IPC 到流完成才 resolve，早期失败 toast）→
 * navigate；create/读引用失败抛错且草稿保留，send 例外（session 已建立，
 * 失败仅 toast 仍导航）。IPC 全量走 invoke 级 mock
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// localStorage stub：store 配置 setter 手写持久化（beforeEach setWorkspaceId
// 触发），测试环境无原生 localStorage（同 tests/ai/new-task-store.test.ts）
vi.hoisted(() => {
  const memory = new Map<string, string>();
  const stub = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => void memory.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
});

// i18n 桩：dispatch 的 mapDispatchError 断言用（验证映射走向而非文案内容，
// 同 tests/ai/error-message.test.ts）
vi.mock("@/i18n", () => ({
  default: { t: (key: string) => `mapped:${key}` },
}));

const { invokeMock, toastMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  toastMock: { error: vi.fn() },
}));
vi.mock("@/lib/ipc", () => ({ invoke: invokeMock }));
vi.mock("sonner", () => ({ toast: toastMock }));

import {
  dispatchNewTask,
  mapDispatchError,
} from "@/domains/ai/new-task/lib/dispatch";
import { useNewTaskStore } from "@/domains/ai/new-task/store/new-task-store";

const navigate = vi.fn();

const SESSION = { id: 9, workspaceId: 2, title: "x", mode: "agent" };

/** 通用 mock：默认仅 session:create 成功，其余通道 reject（测试内按需覆写） */
function mockInvokeDefault(): void {
  invokeMock.mockImplementation((channel: string) => {
    if (channel === "session:create") {
      return Promise.resolve(SESSION);
    }
    return Promise.resolve(null);
  });
}

describe("dispatchNewTask", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    navigate.mockReset();
    useNewTaskStore.getState().resetDraft();
    // 三配置跨用例持久（resetDraft 不清）——显式回基线避免用例间顺序耦合
    useNewTaskStore.getState().setWorkspaceId(2);
    useNewTaskStore.getState().setAccessMode("default");
    useNewTaskStore.getState().setContent("帮我写周报");
  });

  it("标准流程：create→send→navigate，不调 setPermission，成功清草稿", async () => {
    mockInvokeDefault();
    await dispatchNewTask({ navigate });
    expect(invokeMock).toHaveBeenNthCalledWith(1, "session:create", {
      workspaceId: 2,
      scenario: "daily",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "chat:send", {
      sessionId: 9,
      content: "帮我写周报",
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      "permission:set",
      expect.anything(),
      expect.anything(),
    );
    expect(navigate).toHaveBeenCalledWith("/module/ai?session=9", {
      replace: true,
    });
    expect(useNewTaskStore.getState().content).toBe("");
  });

  it("高危：create 后 setPermission 再 send", async () => {
    useNewTaskStore.getState().setAccessMode("full");
    mockInvokeDefault();
    await dispatchNewTask({ navigate });
    const channels = invokeMock.mock.calls.map((c) => c[0]);
    expect(channels).toEqual(["session:create", "permission:set", "chat:send"]);
    expect(invokeMock).toHaveBeenNthCalledWith(2, "permission:set", 9, "full");
  });

  it("草稿选了专家与非默认模式：create 后 setAssistant→setMode 落库再 send", async () => {
    useNewTaskStore.getState().setAssistantId(5);
    useNewTaskStore.getState().setMode("plan");
    mockInvokeDefault();
    await dispatchNewTask({ navigate });
    const channels = invokeMock.mock.calls.map((c) => c[0]);
    expect(channels).toEqual([
      "session:create",
      "session:setAssistant",
      "session:setMode",
      "chat:send",
    ]);
    expect(invokeMock).toHaveBeenCalledWith("session:setAssistant", 9, 5);
    expect(invokeMock).toHaveBeenCalledWith("session:setMode", 9, "plan");
  });

  it("高危+专家+plan 全量：create→setAssistant→setMode→setPermission→send 顺序落库", async () => {
    useNewTaskStore.getState().setAssistantId(5);
    useNewTaskStore.getState().setMode("plan");
    useNewTaskStore.getState().setAccessMode("full");
    mockInvokeDefault();
    await dispatchNewTask({ navigate });
    expect(invokeMock.mock.calls.map((c) => c[0])).toEqual([
      "session:create",
      "session:setAssistant",
      "session:setMode",
      "permission:set",
      "chat:send",
    ]);
  });

  it("send 早期失败：不阻塞导航，toast 提示（session 已建立、用户消息已落库）", async () => {
    invokeMock.mockImplementation((channel: string) => {
      if (channel === "session:create") {
        return Promise.resolve(SESSION);
      }
      if (channel === "chat:send") {
        return Promise.reject(new Error("network"));
      }
      return Promise.resolve(null);
    });
    await dispatchNewTask({ navigate });
    expect(navigate).toHaveBeenCalledWith("/module/ai?session=9", {
      replace: true,
    });
    await vi.waitFor(() => expect(toastMock.error).toHaveBeenCalled());
  });

  it("chat:send 挂起（流式生成中）不阻塞导航——跳转不等流结束", async () => {
    invokeMock.mockImplementation((channel: string) => {
      if (channel === "session:create") {
        return Promise.resolve(SESSION);
      }
      if (channel === "chat:send") {
        // chat:send IPC 契约：整个流式生成完成才 resolve——用永不 resolve
        // 的 promise 模拟流进行中，dispatch 不得被它挡住
        return new Promise(() => {});
      }
      return Promise.resolve(null);
    });
    await dispatchNewTask({ navigate });
    expect(navigate).toHaveBeenCalledWith("/module/ai?session=9", {
      replace: true,
    });
    expect(useNewTaskStore.getState().content).toBe("");
  });

  it("pending 引用读内容注入：file 走 readWorkspaceFile，localFile 走 readExternalFile，skill 走 readSkill", async () => {
    const { addPending } = useNewTaskStore.getState();
    addPending({ label: "a.md", ref: "docs/a.md", kind: "file" });
    addPending({ label: "b.md", ref: "/tmp/b.md", kind: "localFile" });
    addPending({ label: "s1", ref: "s1", kind: "skill" });
    invokeMock.mockImplementation((channel: string) => {
      if (channel === "session:create") {
        return Promise.resolve(SESSION);
      }
      if (channel === "file:readWorkspaceFile") {
        return Promise.resolve({ content: "A" });
      }
      if (channel === "file:readExternalFile") {
        return Promise.resolve({ kind: "text", content: "B", size: 1 });
      }
      if (channel === "skill:readSkill") {
        return Promise.resolve({ content: "C" });
      }
      return Promise.resolve(null);
    });
    await dispatchNewTask({ navigate });
    expect(invokeMock).toHaveBeenCalledWith(
      "file:readWorkspaceFile",
      2,
      "docs/a.md",
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "file:readExternalFile",
      "/tmp/b.md",
    );
    expect(invokeMock).toHaveBeenCalledWith("skill:readSkill", { name: "s1" });
    const sendCall = invokeMock.mock.calls.find((c) => c[0] === "chat:send");
    expect(sendCall![1]).toMatchObject({ sessionId: 9 });
    // 注入格式与 ChatView 渲染层（ChatPane/ProjectChatBar）逐字节同口径
    const content = (sendCall![1] as { content: string }).content;
    expect(content).toContain("[引用文件 docs/a.md]\nA");
    expect(content).toContain("[引用文件 /tmp/b.md]\nB");
    expect(content).toContain("[引用技能 s1]\nC");
    expect(content.endsWith("\n\n帮我写周报")).toBe(true);
  });

  it("localFile 图片引用注入占位标记（不读图进文本）", async () => {
    useNewTaskStore.getState().addPending({
      label: "shot.png",
      ref: "/tmp/shot.png",
      kind: "localFile",
    });
    invokeMock.mockImplementation((channel: string) => {
      if (channel === "session:create") {
        return Promise.resolve(SESSION);
      }
      if (channel === "file:readExternalFile") {
        return Promise.resolve({
          kind: "image",
          dataUrl: "data:image/png;base64,x",
          size: 9,
        });
      }
      return Promise.resolve(null);
    });
    await dispatchNewTask({ navigate });
    const sendCall = invokeMock.mock.calls.find((c) => c[0] === "chat:send");
    expect((sendCall![1] as { content: string }).content).toContain(
      "[图片 shot.png]",
    );
  });
});

describe("mapDispatchError", () => {
  it("敏感词/无空间/读失败映射 newTask 文案，其余走 mapIpcError 透传", () => {
    expect(mapDispatchError(new Error("no-workspace"))).toBe(
      "mapped:newTask:context.noWorkspace",
    );
    expect(mapDispatchError(new Error("sensitive:示例违禁词A"))).toBe(
      "mapped:newTask:sensitiveHit",
    );
    expect(mapDispatchError(new Error("read-failed:docs/a.md"))).toBe(
      "mapped:newTask:attach.readFailed",
    );
    expect(mapDispatchError(new Error("network"))).toBe("network");
  });
});
