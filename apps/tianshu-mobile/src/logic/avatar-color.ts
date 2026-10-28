import type { ThemeName } from "@/theme/colors";

/** 头像取色顺序（固定——存量 seed 的取色结果不随数组重排漂移） */
export const AVATAR_THEME_ORDER: readonly ThemeName[] = [
  "blue",
  "red",
  "green",
  "orange",
];

/** djb2 字符串散列（>>> 0 保非负——取模索引的前提） */
export function hashSeed(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return hash >>> 0;
}

/** seed → 四主题色索引（会话 id/工作空间名等稳定 seed 得稳定配色） */
export function avatarThemeIndex(seed: string): number {
  return hashSeed(seed) % AVATAR_THEME_ORDER.length;
}

/** 标题首字符（头像内显字）；空白/空标题兜底 "?" */
export function avatarInitial(title: string | null | undefined): string {
  const trimmed = (title ?? "").trim();
  if (trimmed === "") return "?";
  return Array.from(trimmed)[0].toUpperCase();
}
