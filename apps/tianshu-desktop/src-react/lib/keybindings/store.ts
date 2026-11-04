/**
 * 快捷键覆盖持久化（localStorage）
 * key: tianshu-keybindings，JSON `{ [commandId]: string }` 仅存用户改动；
 * 解除绑定写 "unbound" 哨兵；损坏 JSON/非对象结构容错回退空；
 * 纯持久化无策略（可否改绑等校验归 resolve/渲染层）
 */
import { serializeBinding } from "./binding";
import type { BindingOverrides, KeyBinding } from "./types";

/** 存储键 */
export const KEYBINDINGS_STORAGE_KEY = "tianshu-keybindings";

/** 解除绑定哨兵值 */
export const UNBOUND = "unbound";

/** 读取覆盖（仅用户改动）；缺失/损坏/结构非法回退空对象 */
export function loadOverrides(): BindingOverrides {
  try {
    const raw = localStorage.getItem(KEYBINDINGS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return isBindingOverrides(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 写入单条覆盖：binding 为 null 表示解除绑定（写 "unbound" 哨兵） */
export function saveOverride(
  commandId: string,
  binding: KeyBinding | null,
): void {
  const overrides = loadOverrides();
  overrides[commandId] = binding ? serializeBinding(binding) : UNBOUND;
  persist(overrides);
}

/** 清除单条覆盖（该命令恢复默认绑定） */
export function clearOverride(commandId: string): void {
  const overrides = loadOverrides();
  delete overrides[commandId];
  persist(overrides);
}

/** 恢复全部默认：整体移除存储键 */
export function resetAll(): void {
  localStorage.removeItem(KEYBINDINGS_STORAGE_KEY);
}

/** 落盘：空覆盖时移除键，避免残留 "{}" */
function persist(overrides: BindingOverrides): void {
  if (Object.keys(overrides).length === 0) {
    localStorage.removeItem(KEYBINDINGS_STORAGE_KEY);
    return;
  }
  localStorage.setItem(KEYBINDINGS_STORAGE_KEY, JSON.stringify(overrides));
}

/** 结构校验：非空对象且所有值均为字符串 */
function isBindingOverrides(value: unknown): value is BindingOverrides {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((item) => typeof item === "string");
}
