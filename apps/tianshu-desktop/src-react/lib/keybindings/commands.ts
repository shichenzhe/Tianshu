/**
 * 快捷键命令定义表（17 条）
 * 可自定义 11 条 + 系统固定 6 条（固定项 customizable: false，仍参与冲突
 * 占用判定——用户改绑撞固定项视为冲突）；默认绑定以序列化字符串书写，
 * 模块加载时解析为 KeyBinding，非法默认绑定直接抛错（开发期暴露笔误）
 */
import { parseBindingString } from "./binding";
import type { CommandDef, KeyBinding } from "./types";

/** 原始定义表：[id, 默认绑定（序列化）, 是否可自定义] */
const RAW_COMMANDS: Array<readonly [string, string, boolean]> = [
  // 可自定义（customizable: true）
  ["openSettings", "cmd+,", true],
  ["sessionSearch", "cmd+f", true],
  ["sendMessage", "Enter", true],
  ["newlineInInput", "shift+Enter", true],
  ["newConversation", "cmd+n", true],
  ["stopGeneration", "Esc", true],
  ["previousTask", "cmd+[", true],
  ["nextTask", "cmd+]", true],
  ["toggleSidebar", "cmd+b", true],
  ["toggleArtifacts", "cmd+shift+b", true],
  ["toggleFullscreen", "cmd+ctrl+f", true],
  // 系统固定（customizable: false；showHideWindow 即 ⇧⌥W，按固定序列化
  // 顺序 canonical 写作 alt+shift+w）
  ["showHideWindow", "alt+shift+w", false],
  ["zoomIn", "cmd+=", false],
  ["zoomOut", "cmd+-", false],
  ["zoomReset", "cmd+0", false],
  ["atMention", "@", false],
  ["slashCommand", "/", false],
];

/** 全部命令定义（顺序即设置页展示顺序） */
export const KEYBINDING_COMMANDS: CommandDef[] = RAW_COMMANDS.map(
  ([id, serialized, customizable]) => ({
    id,
    defaultBinding: parseDefaultBinding(id, serialized),
    customizable,
  }),
);

/** 解析默认绑定，非法序列化直接抛错 */
function parseDefaultBinding(id: string, serialized: string): KeyBinding {
  const binding = parseBindingString(serialized);
  if (!binding) throw new Error(`非法默认绑定定义: ${id} = ${serialized}`);
  return binding;
}
