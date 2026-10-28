/**
 * 计划推进预填 store 测试（纯 zustand，零 jsdom）：
 * - setPrompt 写入后 prompt 可读（订阅值触发 ChatInput 运行期消费）
 * - consume 读后即清（二次消费得 null——常驻底栏防重复预填的兜底）
 * ChatInput 运行期消费与聚焦行为见 tests/ai/chat-input-todo.test.tsx。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { usePlanAdvanceStore } from "../../src-react/domains/project/store/plan-advance.store";

describe("usePlanAdvanceStore", () => {
  beforeEach(() => {
    usePlanAdvanceStore.setState({ prompt: null });
  });

  it("初始 prompt 为 null（消费为空）", () => {
    expect(usePlanAdvanceStore.getState().prompt).toBeNull();
    expect(usePlanAdvanceStore.getState().consume()).toBeNull();
  });

  it("setPrompt → consume 读后即清", () => {
    usePlanAdvanceStore.getState().setPrompt("请推进 #3");
    expect(usePlanAdvanceStore.getState().prompt).toBe("请推进 #3");
    expect(usePlanAdvanceStore.getState().consume()).toBe("请推进 #3");
    expect(usePlanAdvanceStore.getState().prompt).toBeNull();
    expect(usePlanAdvanceStore.getState().consume()).toBeNull();
  });
});
