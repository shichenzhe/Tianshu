/**
 * 跨页预填输入桥:技能页「创建技能」入口跳转聊天页时携带引导语,
 * ChatInput 挂载时消费一次(读后即清,不留残留)
 */
import { create } from "zustand";

interface CreateSkillPromptState {
  pendingPrompt: string | null;
  setPendingPrompt: (prompt: string) => void;
  consumePendingPrompt: () => string | null;
}

export const useCreateSkillPromptStore = create<CreateSkillPromptState>(
  (set, get) => ({
    pendingPrompt: null,
    setPendingPrompt: (prompt) => set({ pendingPrompt: prompt }),
    consumePendingPrompt: () => {
      const current = get().pendingPrompt;
      if (current !== null) {
        set({ pendingPrompt: null });
      }
      return current;
    },
  }),
);
