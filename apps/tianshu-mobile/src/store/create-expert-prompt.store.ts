/**
 * 跨页预填输入桥（体验精修批）：专家页「对话式创建」入口跳转会话页时
 * 携带访谈式引导语，会话页挂载时消费一次并自动发送（读后即清，不留
 * 残留——对齐桌面 create-skill store 形态）
 */
import { create } from "zustand";

interface CreateExpertPromptState {
  pendingPrompt: string | null;
  setPendingPrompt: (prompt: string) => void;
  /** 读且清：消费端（会话页挂载）调用一次拿回引导语 */
  consumePendingPrompt: () => string | null;
}

export const useCreateExpertPromptStore = create<CreateExpertPromptState>(
  (set, get) => ({
    pendingPrompt: null,
    setPendingPrompt: (prompt) => set({ pendingPrompt: prompt }),
    consumePendingPrompt: () => {
      const { pendingPrompt } = get();
      if (pendingPrompt !== null) {
        set({ pendingPrompt: null });
      }
      return pendingPrompt;
    },
  }),
);
