/**
 * 设置面板-快捷键页（右栏整页视图）
 * 顶部搜索框（放大镜/占位/× 与 Esc 清空，过滤命令列）+「全部恢复默认」
 * 二次确认；三列表格 17 条命令。点击绑定胶囊进入监听捕获（window capture
 * keydown + preventDefault：阻断全局分发与 Radix Esc 关闭），有效组合经
 * 冲突/系统级检查后写 localStorage 并刷新视图（分发层每次按键直读存储，
 * 变更即时生效，无需通知）；删除写 unbound 哨兵（≠恢复默认）
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { RotateCcw, Search, X } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  detectPlatform,
  findConflict,
  isSystemLevelCombo,
  isValidNewBinding,
  KEYBINDING_COMMANDS,
  loadOverrides,
  resetAll,
  resolveBindings,
  saveOverride,
} from "@/lib/keybindings";
import type {
  BindingOverrides,
  CommandDef,
  KeyBinding,
} from "@/lib/keybindings";
import { bindingOfEvent } from "@/lib/keybindings/dispatcher";
import { releaseOccupiedBinding } from "../model/shortcut-bindings";
import ShortcutRow from "./ShortcutRow";

/** 冲突确认弹窗载荷 */
interface ConflictPrompt {
  commandId: string;
  binding: KeyBinding;
  conflict: CommandDef;
  name: string;
}

export default function ShortcutsGroup() {
  const { t } = useTranslation(["settings", "common"]);
  const [query, setQuery] = useState("");
  const [overrides, setOverrides] = useState<BindingOverrides>(() =>
    loadOverrides(),
  );
  const [listeningId, setListeningId] = useState<string | null>(null);
  const [conflictPrompt, setConflictPrompt] = useState<ConflictPrompt | null>(
    null,
  );
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const platform = useMemo(detectPlatform, []);

  const resolved = useMemo(() => resolveBindings(overrides), [overrides]);
  const refresh = useCallback(() => setOverrides(loadOverrides()), []);
  const commandLabel = useCallback(
    (commandId: string) => t(`settings:shortcut.commands.${commandId}`),
    [t],
  );
  const visibleCommands = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return KEYBINDING_COMMANDS.filter((command) =>
      commandLabel(command.id).toLowerCase().includes(keyword),
    );
  }, [commandLabel, query]);

  /** 落盘提交：系统级组合先警告（PRD：警告但允许），随后写入并刷新 */
  const commitBinding = useCallback(
    (commandId: string, binding: KeyBinding) => {
      if (isSystemLevelCombo(binding, platform)) {
        toast.warning(t("settings:shortcut.systemWarning"));
      }
      saveOverride(commandId, binding);
      refresh();
    },
    [platform, refresh, t],
  );

  /** 录到的有效组合：无冲突直接保存；固定项占用仅提示；否则弹替换确认 */
  const promptOrCommit = useCallback(
    (commandId: string, binding: KeyBinding) => {
      const conflict = findConflict(
        commandId,
        binding,
        resolveBindings(loadOverrides()),
      );
      if (!conflict) {
        commitBinding(commandId, binding);
        return;
      }
      const name = commandLabel(conflict.id);
      if (!conflict.customizable) {
        toast.error(t("settings:shortcut.conflictFixed", { name }));
        return;
      }
      setConflictPrompt({ commandId, binding, conflict, name });
    },
    [commandLabel, commitBinding, t],
  );

  /** 监听捕获：Esc 退出不保存；纯修饰键继续等待；无效组合 toast 并保持监听 */
  const handleListeningKeydown = useCallback(
    (event: KeyboardEvent) => {
      event.preventDefault();
      if (event.key === "Escape" || listeningId === null) {
        setListeningId(null);
        return;
      }
      const binding = bindingOfEvent(event, platform);
      if (!binding) {
        return;
      }
      if (!isValidNewBinding(binding)) {
        toast.error(t("settings:shortcut.invalidBinding"));
        return;
      }
      setListeningId(null);
      promptOrCommit(listeningId, binding);
    },
    [listeningId, platform, promptOrCommit, t],
  );

  // 监听期局部捕获（window capture，先于 Radix DismissableLayer 与全局分发）
  useEffect(() => {
    if (listeningId === null) {
      return;
    }
    window.addEventListener("keydown", handleListeningKeydown, true);
    return () =>
      window.removeEventListener("keydown", handleListeningKeydown, true);
  }, [listeningId, handleListeningKeydown]);

  // 搜索词非空时 Esc 清空（preventDefault 阻断面板关闭）；弹窗/监听期让位
  useEffect(() => {
    if (
      query === "" ||
      listeningId !== null ||
      conflictPrompt !== null ||
      deleteId !== null ||
      resetOpen
    ) {
      return;
    }
    const clearQuery = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      setQuery("");
    };
    window.addEventListener("keydown", clearQuery, true);
    return () => window.removeEventListener("keydown", clearQuery, true);
  }, [query, listeningId, conflictPrompt, deleteId, resetOpen]);

  /** 打开确认弹窗前先退出监听，避免捕获吞掉弹窗的键盘交互 */
  const requestDelete = useCallback((commandId: string) => {
    setListeningId(null);
    setDeleteId(commandId);
  }, []);

  const openResetConfirm = useCallback(() => {
    setListeningId(null);
    setResetOpen(true);
  }, []);

  /** 替换冲突：先释放占用键（回默认或 unbound），再提交新绑定 */
  const confirmReplace = useCallback(() => {
    if (!conflictPrompt) {
      return;
    }
    releaseOccupiedBinding(conflictPrompt.conflict, conflictPrompt.binding);
    commitBinding(conflictPrompt.commandId, conflictPrompt.binding);
    setConflictPrompt(null);
  }, [conflictPrompt, commitBinding]);

  /** 删除 = 写 unbound 哨兵（区别于恢复默认的清除覆盖） */
  const confirmDelete = useCallback(() => {
    if (deleteId === null) {
      return;
    }
    saveOverride(deleteId, null);
    setDeleteId(null);
    refresh();
  }, [deleteId, refresh]);

  const confirmReset = useCallback(() => {
    resetAll();
    setResetOpen(false);
    refresh();
  }, [refresh]);

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("settings:shortcut.searchPlaceholder")}
            aria-label={t("common:search")}
            className="pl-8 pr-8"
          />
          {query !== "" && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label={t("common:close")}
              className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer text-muted-foreground transition-colors hover:text-primary"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
          onClick={openResetConfirm}
        >
          <RotateCcw className="size-3.5" />
          {t("settings:shortcut.resetAll")}
        </Button>
      </div>
      {visibleCommands.length === 0 ? (
        <div className="flex flex-1 items-center justify-center py-16 text-sm text-muted-foreground">
          {t("settings:shortcut.noResults")}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("settings:shortcut.columnCommand")}</TableHead>
              <TableHead className="text-center">
                {t("settings:shortcut.columnBinding")}
              </TableHead>
              <TableHead className="w-24 text-center">
                {t("settings:shortcut.columnAction")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleCommands.map((command) => (
              <ShortcutRow
                key={command.id}
                command={command}
                binding={resolved[command.id] ?? null}
                platform={platform}
                listening={listeningId === command.id}
                label={commandLabel(command.id)}
                onStartListening={setListeningId}
                onRequestDelete={requestDelete}
              />
            ))}
          </TableBody>
        </Table>
      )}
      <ResetConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        onConfirm={confirmReset}
      />
      <DeleteConfirmDialog
        commandId={deleteId}
        onConfirm={confirmDelete}
        onClose={() => setDeleteId(null)}
      />
      <ConflictConfirmDialog
        prompt={conflictPrompt}
        onConfirm={confirmReplace}
        onClose={() => setConflictPrompt(null)}
      />
    </div>
  );
}

interface ResetConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

/** 「全部恢复默认」二次确认 */
function ResetConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
}: ResetConfirmDialogProps) {
  const { t } = useTranslation(["settings", "common"]);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="rounded-lg border-border/50 shadow-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("settings:shortcut.resetTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("settings:shortcut.resetMessage")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {t("common:confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface DeleteConfirmDialogProps {
  commandId: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

/** 删除绑定二次确认（值驱动开合） */
function DeleteConfirmDialog({
  commandId,
  onConfirm,
  onClose,
}: DeleteConfirmDialogProps) {
  const { t } = useTranslation(["settings", "common"]);
  return (
    <AlertDialog
      open={commandId !== null}
      onOpenChange={(o) => !o && onClose()}
    >
      <AlertDialogContent className="rounded-lg border-border/50 shadow-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("settings:shortcut.deleteTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("settings:shortcut.deleteMessage")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {t("common:delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface ConflictConfirmDialogProps {
  prompt: ConflictPrompt | null;
  onConfirm: () => void;
  onClose: () => void;
}

/** 冲突替换二次确认（取消即退出监听，不写入） */
function ConflictConfirmDialog({
  prompt,
  onConfirm,
  onClose,
}: ConflictConfirmDialogProps) {
  const { t } = useTranslation(["settings", "common"]);
  return (
    <AlertDialog open={prompt !== null} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent className="rounded-lg border-border/50 shadow-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("settings:shortcut.conflictTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("settings:shortcut.conflictMessage", { name: prompt?.name })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {t("settings:shortcut.replace")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
