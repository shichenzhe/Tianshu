/**
 * 快捷键设置页展示与释放逻辑（纯展示层，不改 Task 14 lib 序列化口径）
 * - displaySegments：胶囊分段渲染（controller 裁决：darwin 下 ⇧ 前置；
 *   win/linux 的 toggleFullscreen 默认绑定显示平台等价键 F11）
 * - releaseOccupiedBinding：冲突替换前释放被占用命令的键
 */
import {
  clearOverride,
  formatBinding,
  saveOverride,
  serializeBinding,
} from "@/lib/keybindings";
import type { CommandDef, KeyBinding, Platform } from "@/lib/keybindings";

/** 展示分段：空绑定返回空数组（UI 层显示「未绑定」文案） */
export function displaySegments(
  command: CommandDef,
  binding: KeyBinding | null,
  platform: Platform,
): string[] {
  if (!binding) {
    return [];
  }
  if (showsF11Equivalent(command, binding, platform)) {
    return ["F11"];
  }
  const segments = formatBinding(binding, platform);
  return platform === "darwin" ? withShiftFirst(segments) : segments;
}

/**
 * 释放被占用命令的键（冲突「替换」确认后的前置步骤）：
 * 默认绑定即占用键时写 unbound 哨兵（清除覆盖无法释放）；
 * 用户覆盖占用时清除覆盖回默认（默认键不同，键即释放）
 */
export function releaseOccupiedBinding(
  conflict: CommandDef,
  binding: KeyBinding,
): void {
  if (serializeBinding(conflict.defaultBinding) === serializeBinding(binding)) {
    saveOverride(conflict.id, null);
    return;
  }
  clearOverride(conflict.id);
}

/**
 * win/linux 全屏默认绑定（⌘⌃F 因平台修饰键归一无法命中）显示平台
 * 等价键 F11（分发层裸 F11 映射）；用户改绑后按实际绑定展示
 */
function showsF11Equivalent(
  command: CommandDef,
  binding: KeyBinding,
  platform: Platform,
): boolean {
  return (
    command.id === "toggleFullscreen" &&
    platform !== "darwin" &&
    serializeBinding(binding) === serializeBinding(command.defaultBinding)
  );
}

/**
 * darwin 显示序：⇧ 前置（PRD 风格 ⇧⌘B/⇧⌥W），其余保持 ⌘^⌥；
 * 仅显示层排序，序列化（存储/冲突比对）仍用 lib 的 ⌘^⌥⇧ 规范序
 */
function withShiftFirst(segments: string[]): string[] {
  const shiftIndex = segments.indexOf("⇧");
  if (shiftIndex <= 0) {
    return segments;
  }
  return [
    "⇧",
    ...segments.slice(0, shiftIndex),
    ...segments.slice(shiftIndex + 1),
  ];
}
