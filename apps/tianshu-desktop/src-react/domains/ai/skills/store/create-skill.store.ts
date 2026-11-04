/**
 * 跨页预填输入桥:技能页「创建技能」入口跳转聊天页时携带引导语与
 * 预置技能引用(skill-creator),ChatInput 挂载时消费一次(读后即清,
 * 不留残留)
 */
import { create } from "zustand";

interface CreateSkillPromptState {
  pendingPrompt: string | null;
  /** 预置技能引用名(挂载时读正文入 chips) */
  pendingSkillRefs: string[];
  setPendingPrompt: (prompt: string, skillRefs?: string[]) => void;
  consumePendingPrompt: () => { prompt: string | null; skillRefs: string[] };
}

const INITIAL: { pendingPrompt: string | null; pendingSkillRefs: string[] } = {
  pendingPrompt: null,
  pendingSkillRefs: [],
};

export const useCreateSkillPromptStore = create<CreateSkillPromptState>(
  (set, get) => ({
    ...INITIAL,
    setPendingPrompt: (prompt, skillRefs = []) =>
      set({ pendingPrompt: prompt, pendingSkillRefs: skillRefs }),
    consumePendingPrompt: () => {
      const { pendingPrompt, pendingSkillRefs } = get();
      if (pendingPrompt !== null || pendingSkillRefs.length > 0) {
        set({ pendingPrompt: null, pendingSkillRefs: [] });
      }
      return { prompt: pendingPrompt, skillRefs: pendingSkillRefs };
    },
  }),
);
