/**
 * 快捷键表格行
 * 三列：命令名（左对齐）/ 按键绑定（胶囊居中，可自定义项可点击进入
 * 监听，监听中该单元格替换为提示文案）/ 操作（已绑定=垃圾桶、
 * 未绑定=「设置」按钮、固定项 = —）
 */

import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import type { CommandDef, KeyBinding, Platform } from "@/lib/keybindings";
import { displaySegments } from "../model/shortcut-bindings";

interface ShortcutRowProps {
  command: CommandDef;
  binding: KeyBinding | null;
  platform: Platform;
  listening: boolean;
  label: string;
  onStartListening: (commandId: string) => void;
  onRequestDelete: (commandId: string) => void;
}

export default function ShortcutRow({
  command,
  binding,
  platform,
  listening,
  label,
  onStartListening,
  onRequestDelete,
}: ShortcutRowProps) {
  const { t } = useTranslation(["settings"]);
  return (
    <TableRow>
      <TableCell className="text-left">{label}</TableCell>
      <TableCell className="text-center">
        {listening ? (
          <span className="animate-pulse text-xs font-medium text-primary">
            {t("settings:shortcut.listening")}
          </span>
        ) : (
          <BindingCell
            command={command}
            binding={binding}
            platform={platform}
            label={label}
            onStartListening={onStartListening}
          />
        )}
      </TableCell>
      <TableCell className="w-24 text-center">
        <ActionCell
          command={command}
          binding={binding}
          onStartListening={onStartListening}
          onRequestDelete={onRequestDelete}
        />
      </TableCell>
    </TableRow>
  );
}

interface BindingCellProps {
  command: CommandDef;
  binding: KeyBinding | null;
  platform: Platform;
  label: string;
  onStartListening: (commandId: string) => void;
}

/** 绑定胶囊：空绑定显示灰字「未绑定」，固定项纯展示不可点击 */
function BindingCell({
  command,
  binding,
  platform,
  label,
  onStartListening,
}: BindingCellProps) {
  const { t } = useTranslation(["settings"]);
  if (!binding) {
    return (
      <span className="text-xs text-muted-foreground">
        {t("settings:shortcut.unbound")}
      </span>
    );
  }
  const pills = displaySegments(command, binding, platform).map((segment) => (
    <kbd
      key={segment}
      className="inline-flex h-6 min-w-6 items-center justify-center rounded-md bg-primary-subtle px-1.5 font-sans text-xs font-medium text-foreground"
    >
      {segment}
    </kbd>
  ));
  if (!command.customizable) {
    return <span className="inline-flex items-center gap-1">{pills}</span>;
  }
  return (
    <button
      type="button"
      onClick={() => onStartListening(command.id)}
      aria-label={t("settings:shortcut.editHint", { name: label })}
      title={t("settings:shortcut.editHint", { name: label })}
      className="inline-flex cursor-pointer items-center gap-1 rounded-md p-0.5 transition-colors hover:bg-primary-subtle/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      {pills}
    </button>
  );
}

interface ActionCellProps {
  command: CommandDef;
  binding: KeyBinding | null;
  onStartListening: (commandId: string) => void;
  onRequestDelete: (commandId: string) => void;
}

/** 操作列：可自定义且已绑定 = 垃圾桶；可自定义且未绑定 = 「设置」；固定 = — */
function ActionCell({
  command,
  binding,
  onStartListening,
  onRequestDelete,
}: ActionCellProps) {
  const { t } = useTranslation(["settings", "common"]);
  if (!command.customizable) {
    return <span className="text-muted-foreground">—</span>;
  }
  if (!binding) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="h-7 px-2 text-xs hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
        onClick={() => onStartListening(command.id)}
      >
        {t("settings:shortcut.setBinding")}
      </Button>
    );
  }
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7 text-muted-foreground hover:text-destructive"
      aria-label={t("common:delete")}
      title={t("common:delete")}
      onClick={() => onRequestDelete(command.id)}
    >
      <Trash2 className="size-3.5" />
    </Button>
  );
}
