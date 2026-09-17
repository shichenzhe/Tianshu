// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// vitest.config 未开 globals,RTL 自动清理不生效,手动注册（同
// tests/ai/chat-input-todo.test.tsx:152）
afterEach(cleanup);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ invoke: invokeMock }));
// localStorage stub:与 tests/ai/new-task-store.test.ts 同款内存 stub
// (beforeEach setScenario 触发 store 手写持久化,本仓库测试环境无原生
// localStorage)
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
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: [
      { name: "pdf-skill", enabled: true, scenarios: ["daily"] },
      { name: "other", enabled: true, scenarios: ["coding"] },
    ],
  }),
}));

import PromptChips from "@/domains/ai/new-task/components/PromptChips";
import { useNewTaskStore } from "@/domains/ai/new-task/store/new-task-store";

describe("PromptChips", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useNewTaskStore.getState().resetDraft();
    useNewTaskStore.getState().setScenario("daily");
  });

  it("模板胶囊点击填入 prompt 到 store", () => {
    render(<PromptChips />);
    fireEvent.click(screen.getByText("newTask:chips.slides.label"));
    expect(useNewTaskStore.getState().content).toBe(
      "newTask:chips.slides.prompt",
    );
  });

  it("场景技能混排为 pill（点击加 pending）", () => {
    render(<PromptChips />);
    fireEvent.click(screen.getByText("pdf-skill"));
    expect(useNewTaskStore.getState().pending).toEqual([
      { label: "pdf-skill", ref: "pdf-skill", kind: "skill" },
    ]);
  });
});
