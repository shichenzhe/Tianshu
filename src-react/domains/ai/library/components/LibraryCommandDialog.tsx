/**
 * 资料库搜索命令面板（spec §4）：居中浮层、键盘全程驱动
 * （↑↓ 切换 / Enter 打开 / Esc 关闭）、空输入显示最近浏览。
 * 占位实现：Task 6 替换为完整实现（props 契约先行）。
 */
import type { LibraryItem } from "../api/library.api";

export interface LibraryCommandDialogProps {
  open: boolean;
  onClose: () => void;
  onSelect: (item: LibraryItem) => void;
}

export default function LibraryCommandDialog({
  open,
}: LibraryCommandDialogProps) {
  return open ? null : null;
}
