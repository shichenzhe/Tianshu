/**
 * 计划推进预填桥:计划视图「AI 推进」入口写入引导语(#<id>《标题》+模板),
 * 项目底栏 ChatInput 订阅 prompt 值运行期消费(底栏常驻仅挂载一次,
 * 挂载式消费不可达);读后即清,二次消费得 null 天然防重复预填
 */
import { create } from "zustand";

interface PlanAdvanceState {
  prompt: string | null;
  setPrompt: (prompt: string) => void;
  consume: () => string | null;
}

export const usePlanAdvanceStore = create<PlanAdvanceState>((set, get) => ({
  prompt: null,
  setPrompt: (prompt) => set({ prompt }),
  consume: () => {
    const { prompt } = get();
    if (prompt !== null) {
      set({ prompt: null });
    }
    return prompt;
  },
}));
