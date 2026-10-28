/**
 * 新建任务 store 单测:草稿与配置状态、pending 去重/移除、resetDraft 语义
 * 与三字段 localStorage 持久化(store 手写持久化,key tianshu-new-task)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hydratePersistedDraft,
  useNewTaskStore,
} from "@/domains/ai/new-task/store/new-task-store";

// localStorage stub:与 tests/ai/edit-bar.test.tsx 同款内存 stub(本仓库
// 测试环境无原生 localStorage)
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

describe("new-task store", () => {
  beforeEach(() => useNewTaskStore.getState().resetDraft());

  it("addPending 按 label+kind 去重", () => {
    const { addPending, removePending } = useNewTaskStore.getState();
    addPending({ label: "a.md", ref: "docs/a.md", kind: "file" });
    addPending({ label: "a.md", ref: "docs/a.md", kind: "file" });
    expect(useNewTaskStore.getState().pending).toHaveLength(1);
    removePending("docs/a.md");
    expect(useNewTaskStore.getState().pending).toHaveLength(0);
  });
  it("resetDraft 清 content/pending 保留场景与配置", () => {
    useNewTaskStore.getState().setScenario("coding");
    useNewTaskStore.getState().setContent("x");
    useNewTaskStore.getState().resetDraft();
    const s = useNewTaskStore.getState();
    expect(s.content).toBe("");
    expect(s.scenario).toBe("coding");
  });
  it("mode/assistantId/modelId 为任务级草稿：setter 可写，resetDraft 回默认", () => {
    // + 菜单/工具栏对齐 ChatInput（完整对齐裁定）：模式/专家/模型选中暂存
    // 草稿，发送时经 dispatch 落库到新建 session；每次新任务回默认
    // （agent/无专家/模型未选走后端默认），不随三配置持久化
    expect(useNewTaskStore.getState().mode).toBe("agent");
    expect(useNewTaskStore.getState().assistantId).toBeNull();
    expect(useNewTaskStore.getState().modelId).toBeNull();
    useNewTaskStore.getState().setMode("plan");
    useNewTaskStore.getState().setAssistantId(5);
    useNewTaskStore.getState().setModelId(11);
    expect(useNewTaskStore.getState().mode).toBe("plan");
    expect(useNewTaskStore.getState().assistantId).toBe(5);
    expect(useNewTaskStore.getState().modelId).toBe(11);
    useNewTaskStore.getState().resetDraft();
    expect(useNewTaskStore.getState().mode).toBe("agent");
    expect(useNewTaskStore.getState().assistantId).toBeNull();
    expect(useNewTaskStore.getState().modelId).toBeNull();
  });
});

describe("new-task store 持久化", () => {
  const STORAGE_KEY = "tianshu-new-task";

  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    useNewTaskStore.setState({
      content: "",
      scenario: "daily",
      workspaceId: null,
      accessMode: "default",
      pending: [],
    });
  });

  it("配置 setter 写回三字段,草稿不持久化", () => {
    useNewTaskStore.getState().setScenario("coding");
    useNewTaskStore.getState().setWorkspaceId(3);
    useNewTaskStore.getState().setAccessMode("full");
    useNewTaskStore.getState().setContent("草稿");
    useNewTaskStore.getState().setMode("ask");
    useNewTaskStore.getState().setAssistantId(9);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(
      JSON.stringify({
        scenario: "coding",
        workspaceId: 3,
        accessMode: "full",
      }),
    );
  });
  it("hydrate 恢复三字段", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        scenario: "design",
        workspaceId: 7,
        accessMode: "full",
      }),
    );
    hydratePersistedDraft();
    const s = useNewTaskStore.getState();
    expect(s.scenario).toBe("design");
    expect(s.workspaceId).toBe(7);
    expect(s.accessMode).toBe("full");
  });
  it("hydrate 非法 scenario 回退 daily,损坏数据整体丢弃", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ scenario: "nope", workspaceId: 1, accessMode: "full" }),
    );
    hydratePersistedDraft();
    expect(useNewTaskStore.getState().scenario).toBe("daily");
    expect(useNewTaskStore.getState().workspaceId).toBe(1);

    localStorage.setItem(STORAGE_KEY, "not-json");
    useNewTaskStore.setState({ scenario: "design" });
    hydratePersistedDraft();
    expect(useNewTaskStore.getState().scenario).toBe("design");
  });
});
