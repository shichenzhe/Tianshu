/**
 * 应用设置键值解析辅助（设置面板三组共享）
 */

import type { SettingItem } from "../api/settings.api";

/** 键值数组 → Record（缺项取值为 undefined） */
export function toOptionMap(items: SettingItem[]): Record<string, string> {
  return Object.fromEntries(items.map((item) => [item.name, item.value]));
}

/** 布尔设置解析：仅字面 "true" 为真；缺失回退 fallback（与后端 parseBoolOption 同语义） */
export function parseBoolOption(
  raw: string | undefined,
  fallback: boolean,
): boolean {
  if (raw === undefined) {
    return fallback;
  }
  return raw === "true";
}
