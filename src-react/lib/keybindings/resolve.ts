/**
 * 快捷键合成/校验/冲突/系统级组合
 * 全部纯函数：resolveBindings 合成生效视图（默认 ∪ 覆盖 ∪ unbound→null）、
 * isValidNewBinding 有效性、findConflict 冲突查找（固定绑定同样占用）、
 * isSystemLevelCombo 系统级组合警告（仅提示不阻止）
 */
import { serializeBinding, parseBindingString } from "./binding";
import { KEYBINDING_COMMANDS } from "./commands";
import { UNBOUND } from "./store";
import type {
  BindingOverrides,
  CommandDef,
  KeyBinding,
  Platform,
  ResolvedBindings,
} from "./types";

/** 允许裸绑（无修饰键）的主键 */
const BARE_KEYS = new Set(["Enter", "Esc", "@", "/"]);

/** darwin 已知系统级组合（仅警告，允许绑定） */
const DARWIN_SYSTEM_COMBOS = new Set([
  "cmd+,", // 系统偏好设置
  "cmd+q", // 退出应用
  "cmd+w", // 关闭窗口
  "cmd+m", // 最小化
  "cmd+h", // 隐藏应用
]);

/** 合成视图：每条命令的生效绑定（默认 ∪ 覆盖 ∪ unbound→null） */
export function resolveBindings(overrides: BindingOverrides): ResolvedBindings {
  const resolved: ResolvedBindings = {};
  for (const command of KEYBINDING_COMMANDS) {
    resolved[command.id] = resolveCommand(command, overrides[command.id]);
  }
  return resolved;
}

/**
 * 有效性检测：主键 ∈ {Enter, Esc, @, /} 或修饰键含 cmd/ctrl/alt 为有效；
 * 裸单字符（如 a）或仅 shift+单字符无效（Task 16 录制提示用）
 */
export function isValidNewBinding(binding: KeyBinding): boolean {
  if (BARE_KEYS.has(binding.key)) return true;
  return binding.modifiers.some(
    (modifier) =>
      modifier === "cmd" || modifier === "ctrl" || modifier === "alt",
  );
}

/**
 * 冲突查找：返回占用同一序列化的其他命令（固定绑定也参与占用判定），
 * 按定义表顺序返回首个冲突；无冲突返回 null
 */
export function findConflict(
  commandId: string,
  binding: KeyBinding | null,
  resolved: ResolvedBindings,
): CommandDef | null {
  if (!binding) return null;
  const target = serializeBinding(binding);
  return (
    KEYBINDING_COMMANDS.find(
      (command) =>
        command.id !== commandId &&
        resolved[command.id] !== null &&
        resolved[command.id] !== undefined &&
        serializeBinding(resolved[command.id] as KeyBinding) === target,
    ) ?? null
  );
}

/** 系统级组合检测：darwin 已知组合清单命中返回 true（供 UI 警告，允许绑定） */
export function isSystemLevelCombo(
  binding: KeyBinding,
  platform: Platform,
): boolean {
  if (platform !== "darwin") return false;
  return DARWIN_SYSTEM_COMBOS.has(serializeBinding(binding));
}

/** 单命令合成：哨兵→null，无覆盖→默认，非法序列化容错回退默认 */
function resolveCommand(
  command: CommandDef,
  override: string | undefined,
): KeyBinding | null {
  if (override === UNBOUND) return null;
  if (override === undefined) return command.defaultBinding;
  return parseBindingString(override) ?? command.defaultBinding;
}
