/**
 * 快捷键分发匹配（Task 15 分发层，纯函数）
 * 输入为结构化按键事件（修饰键 + 主键 + 场景旗标），不依赖 DOM/React/electron
 * 类型，便于对「修饰键 × 主键 × 输入框聚焦 × 消费者优先」做矩阵单测。
 * 本文件为 Task 14 之后的新增分发层：不改既有冻结文件，故不经 index.ts
 * 再导出，消费方从 "@/lib/keybindings/dispatcher" 直接引入。
 * win/linux 裸 F11 作为 toggleFullscreen 的平台等价键在此映射（裁决：
 * F11 是平台等价键而非用户绑定，isValidNewBinding 保持不变——F11 本就
 * 不是用户可绑键）；映射仅在全屏生效绑定保持默认时成立（镜像设置页
 * showsF11Equivalent 判定），解绑/改绑后裸 F11 落空，遵守
 * 「删除 = unbound 哨兵」契约。
 */
import { parseKeyBinding, serializeBinding } from "./binding";
import { KEYBINDING_COMMANDS } from "./commands";
import { resolveBindings } from "./resolve";
import { loadOverrides } from "./store";
import type { KeyBinding, Modifier, Platform, ResolvedBindings } from "./types";

/** 结构化按键事件：React 合成事件与原生 KeyboardEvent 的最小公共面 */
export interface DispatchKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** 分发匹配输入：按键事件 + 平台与场景旗标 */
export interface DispatchMatchInput extends DispatchKeyEvent {
  platform: Platform;
  /** 焦点位于文本输入元素：裸可打印键不触发（见 firesWhenInputFocused） */
  inputFocused: boolean;
  /** 消费者优先：已被组件 preventDefault 的事件不再分发（联想面板/编辑态的 Esc） */
  defaultPrevented: boolean;
  /** 按住不放的重复触发跳过（避免 toggle 类命令连打） */
  repeat: boolean;
}

/** 即时合成当前生效绑定（每次按键读取，覆盖变更立即生效） */
export function currentBindings(): ResolvedBindings {
  return resolveBindings(loadOverrides());
}

/** 事件是否命中指定绑定（修饰键按平台归一后序列化比对；null 绑定永不命中） */
export function eventMatchesBinding(
  event: DispatchKeyEvent,
  binding: KeyBinding | null,
  platform: Platform,
): boolean {
  if (!binding) {
    return false;
  }
  const pressed = bindingOfEvent(event, platform);
  return (
    pressed !== null && serializeBinding(pressed) === serializeBinding(binding)
  );
}

/** 匹配：结构化事件 + 合成视图 → 命中的命令 id；未命中或已被消费返回 null */
export function matchKeybindingCommand(
  bindings: ResolvedBindings,
  input: DispatchMatchInput,
): string | null {
  if (input.defaultPrevented || input.repeat) {
    return null;
  }
  const pressed = bindingOfEvent(input, input.platform);
  if (!pressed) {
    return null;
  }
  if (isBarePlatformF11(pressed, input.platform)) {
    return keepsFullscreenDefault(bindings) ? "toggleFullscreen" : null;
  }
  return findMatchedCommand(
    bindings,
    serializeBinding(pressed),
    input.inputFocused,
  );
}

/** 按定义表顺序返回首个占用该序列化且聚焦语义允许的命令 */
function findMatchedCommand(
  bindings: ResolvedBindings,
  serialized: string,
  inputFocused: boolean,
): string | null {
  for (const command of KEYBINDING_COMMANDS) {
    const bound = bindings[command.id];
    if (!bound || serializeBinding(bound) !== serialized) {
      continue;
    }
    if (inputFocused && !firesWhenInputFocused(bound)) {
      continue;
    }
    return command.id;
  }
  return null;
}

/** 输入框聚焦时仍触发的绑定：含任意修饰键，或裸非打印键（Esc/F1-F12） */
function firesWhenInputFocused(binding: KeyBinding): boolean {
  if (binding.modifiers.length > 0) {
    return true;
  }
  return binding.key === "Esc" || /^F([1-9]|1[0-2])$/.test(binding.key);
}

/** win/linux 裸 F11：平台等价的全屏键（mac 无此惯例，不映射） */
function isBarePlatformF11(binding: KeyBinding, platform: Platform): boolean {
  return (
    platform !== "darwin" &&
    binding.key === "F11" &&
    binding.modifiers.length === 0
  );
}

/** toggleFullscreen 默认序列化（裸 F11 等价键映射的默认绑定基准） */
const FULLSCREEN_DEFAULT_SERIALIZED = serializeBinding(
  KEYBINDING_COMMANDS.find(({ id }) => id === "toggleFullscreen")!
    .defaultBinding,
);

/**
 * 全屏生效绑定是否保持默认（⌘⌃F 在 win/linux 因修饰键归一无法命中，
 * 设置页此时显示平台等价键 F11）：解绑（unbound）或改绑为可命中键后
 * 裸 F11 不再映射（镜像 shortcut-bindings.ts 的 showsF11Equivalent），
 * 避免不可见不可删的幽灵绑定
 */
function keepsFullscreenDefault(bindings: ResolvedBindings): boolean {
  const fullscreen = bindings.toggleFullscreen;
  return (
    fullscreen !== null &&
    fullscreen !== undefined &&
    serializeBinding(fullscreen) === FULLSCREEN_DEFAULT_SERIALIZED
  );
}

/**
 * 结构化事件 → 归一绑定：接收结构化输入而非 DOM KeyboardEvent
 * （React 合成事件与原生事件均可直接传入，取其最小公共面）。
 * "+" 符号在常见布局需按住 shift 产生（mac ⌘⇧=）：剥离 shift 使其与
 * cmd+=（zoomIn 默认绑定）等价，preventDefault 才能拦住 Chromium 页面缩放。
 * 设置页监听捕获（Task 16）复用本函数，保证录到的绑定与分发生效口径一致
 */
export function bindingOfEvent(
  event: DispatchKeyEvent,
  platform: Platform,
): KeyBinding | null {
  const isShiftedPlus = event.key === "+";
  const modifiers = extractModifiers(event, platform).filter(
    (modifier) => !(isShiftedPlus && modifier === "shift"),
  );
  return parseKeyBinding(modifiers, event.key);
}

/** 按平台抽修饰键：darwin ⌘=metaKey/^=ctrlKey；win·linux Ctrl=cmd（Meta 忽略） */
function extractModifiers(
  event: DispatchKeyEvent,
  platform: Platform,
): Modifier[] {
  const primary = platform === "darwin" ? event.metaKey : event.ctrlKey;
  const modifiers: Modifier[] = [];
  if (primary) {
    modifiers.push("cmd");
  }
  if (platform === "darwin" && event.ctrlKey) {
    modifiers.push("ctrl");
  }
  if (event.altKey) {
    modifiers.push("alt");
  }
  if (event.shiftKey) {
    modifiers.push("shift");
  }
  return modifiers;
}
