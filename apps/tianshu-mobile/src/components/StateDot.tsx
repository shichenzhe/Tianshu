import { View } from "react-native";

import type { TransportState } from "@/transport/types";

/** 六态 → 色点（语义状态色非主题色：绿/黄/红/灰，主题切换不变；
 * T13 自 index.tsx 收编公共件——ConnectionCard 仍保留同款内联副本，
 * 统一改造待后续任务） */
export const STATE_DOT: Record<TransportState, string> = {
  connected: "#22c55e",
  reconnecting: "#eab308",
  "invalid-token": "#FF3B30",
  idle: "#8E8E93",
  connecting: "#8E8E93",
  closed: "#8E8E93",
};

/** 无激活目标（state undefined）为中性灰点 */
export function StateDot({ state }: { state?: TransportState }) {
  return (
    <View
      className="h-2.5 w-2.5 rounded-full"
      style={{ backgroundColor: state ? STATE_DOT[state] : "#d1d5db" }}
    />
  );
}
