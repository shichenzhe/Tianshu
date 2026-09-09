/**
 * 按键绑定解析/归一/序列化/平台符号渲染
 * 核心为纯函数（抽象输入：修饰键数组 + 原始 key 字符串），便于脱离 DOM 单测；
 * KeyboardEvent 薄适配与平台探测仅供渲染层（Task 15/16）使用，不依赖 React/electron
 */
import type { KeyBinding, Modifier, Platform } from "./types";

/** 修饰键固定顺序（序列化与符号渲染共用） */
export const MODIFIER_ORDER: Modifier[] = ["cmd", "ctrl", "alt", "shift"];

/** 事件修饰键原始名（仅按下修饰键时视为未完成组合，解析返回 null） */
const MODIFIER_KEY_NAMES = new Set(["Meta", "Shift", "Control", "Alt"]);

/** darwin 修饰键符号 */
const DARWIN_MODIFIER_SYMBOLS: Record<Modifier, string> = {
  cmd: "⌘",
  ctrl: "^",
  alt: "⌥",
  shift: "⇧",
};

/** win/linux 修饰键标签（cmd 与 ctrl 同显 Ctrl） */
const WINDOWS_MODIFIER_LABELS: Record<Modifier, string> = {
  cmd: "Ctrl",
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
};

/**
 * 主键归一：命名键 Escape→Esc（Enter 原样）、单字符小写化、
 * 符号原样（, [ ] @ / = - 0）、"+" 归一为 "="（⌘+ 实际产生 cmd+=）
 */
export function normalizeKey(rawKey: string): string {
  if (rawKey === "Escape") return "Esc";
  if (rawKey === "+") return "=";
  return rawKey.length === 1 ? rawKey.toLowerCase() : rawKey;
}

/**
 * 抽象输入解析：修饰键数组 + 原始 key → 归一绑定
 * 空主键或仅按下修饰键（Meta/Shift/Control/Alt）返回 null
 */
export function parseKeyBinding(
  modifiers: readonly Modifier[],
  rawKey: string,
): KeyBinding | null {
  const key = normalizeKey(rawKey);
  if (!key || MODIFIER_KEY_NAMES.has(rawKey)) return null;
  return { modifiers: orderedModifiers(modifiers), key };
}

/**
 * 序列化："cmd+shift+b" 风格（固定顺序 cmd/ctrl/alt/shift + key），
 * 作存储与冲突比对键；无修饰键时仅 key（如 "Enter"）
 */
export function serializeBinding(binding: KeyBinding): string {
  return [...orderedModifiers(binding.modifiers), binding.key].join("+");
}

/**
 * 反解析：序列化字符串 → 绑定（token 顺序不敏感，统一归一到固定顺序）；
 * 空串、纯修饰键、未知修饰键 token 等非法输入返回 null
 */
export function parseBindingString(serialized: string): KeyBinding | null {
  const tokens = serialized.split("+");
  const key = normalizeKey(tokens.pop() ?? "");
  const invalid = !key || MODIFIER_KEY_NAMES.has(key) || isModifier(key);
  if (invalid || tokens.some((token) => !isModifier(token))) return null;
  return { modifiers: orderedModifiers(tokens as Modifier[]), key };
}

/** 平台符号渲染：返回段落数组（每段一个符号），供 UI 分别渲染胶囊 */
export function formatBinding(
  binding: KeyBinding,
  platform: Platform,
): string[] {
  return [
    ...orderedModifiers(binding.modifiers).map((modifier) =>
      platform === "darwin"
        ? DARWIN_MODIFIER_SYMBOLS[modifier]
        : WINDOWS_MODIFIER_LABELS[modifier],
    ),
    formatKeyLabel(binding.key, platform),
  ];
}

/** KeyboardEvent 薄适配：按平台抽修饰键后交给纯解析 */
export function bindingFromKeyEvent(
  event: KeyboardEvent,
  platform: Platform,
): KeyBinding | null {
  return parseKeyBinding(extractModifiers(event, platform), event.key);
}

/** 平台探测（渲染层调用一次并缓存；无 navigator 环境回退 darwin） */
export function detectPlatform(): Platform {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (ua.includes("Win")) return "win";
  return ua.includes("Mac") || !ua ? "darwin" : "linux";
}

/** 按固定顺序去重输出修饰键 */
function orderedModifiers(modifiers: readonly Modifier[]): Modifier[] {
  return MODIFIER_ORDER.filter((modifier) => modifiers.includes(modifier));
}

/** 判断 token 是否为合法修饰键名 */
function isModifier(token: string): token is Modifier {
  return MODIFIER_ORDER.includes(token as Modifier);
}

/** 按平台抽修饰键：darwin ⌘=metaKey/^=ctrlKey；win·linux Ctrl=cmd（Meta 忽略） */
function extractModifiers(
  event: KeyboardEvent,
  platform: Platform,
): Modifier[] {
  const primary = platform === "darwin" ? event.metaKey : event.ctrlKey;
  const modifiers: Modifier[] = [];
  if (primary) modifiers.push("cmd");
  if (platform === "darwin" && event.ctrlKey) modifiers.push("ctrl");
  if (event.altKey) modifiers.push("alt");
  if (event.shiftKey) modifiers.push("shift");
  return modifiers;
}

/** 主键显示：darwin 单字母大写（⌘B 风格），其余（Enter/Esc/@///）原样 */
function formatKeyLabel(key: string, platform: Platform): string {
  return platform === "darwin" && /^[a-z]$/.test(key) ? key.toUpperCase() : key;
}
