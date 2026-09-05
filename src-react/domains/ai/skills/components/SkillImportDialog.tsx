/**
 * 导入技能弹窗:点击选择/拖拽 zip 或目录 → dryRun 预检
 * (异常红字 reason / 冲突覆盖确认 / 摘要展示)→
 * 「非高风险自动安装」勾上即装,或点「安装」;成功 toast + 关闭 + invalidate
 */
import { useRef, useState } from "react";
import type { DragEvent } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, UploadCloud } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { mapIpcError } from "../../chat/lib/error-message";
import SkillApi from "../api/skill.api";

/** 选中包展示名(路径末段:zip 文件名或目录名) */
const baseName = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** 拖拽取真实路径:File.path 已在 Electron 32 移除,
 * 经 preload 暴露的 webUtils.getPathForFile 取,异常时旧属性兜底 */
const dropFilePath = (file: File): string => {
  try {
    return window.filePath.getPathForFile(file);
  } catch {
    return (file as File & { path?: string }).path ?? "";
  }
};

export default function SkillImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const queryClient = useQueryClient();
  const pathRef = useRef<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<{
    name: string;
    description: string;
  } | null>(null);
  const [conflictName, setConflictName] = useState<string | null>(null);
  const [autoInstall, setAutoInstall] = useState(false);
  const [installing, setInstalling] = useState(false);

  const busy = checking || installing;

  /** 回初始态(关闭弹窗/冲突取消) */
  const reset = () => {
    pathRef.current = null;
    setFileName(null);
    setChecking(false);
    setError(null);
    setSummary(null);
    setConflictName(null);
    setAutoInstall(false);
    setInstalling(false);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  /** dryRun 预检:ok → 摘要;conflict → 覆盖确认;异常 → 红字 */
  const inspect = async (path: string) => {
    setChecking(true);
    setError(null);
    setSummary(null);
    try {
      const result = await SkillApi.importSkill({ path, dryRun: true });
      if (result.status === "conflict") setConflictName(result.name);
      else if (result.status === "ok") setSummary(result);
    } catch (e) {
      setError(mapIpcError(e));
    } finally {
      setChecking(false);
    }
  };

  /** 选中路径(zip 或目录)进入校验 */
  const selectPath = (path: string) => {
    if (!path) return;
    pathRef.current = path;
    setFileName(baseName(path));
    setError(null);
    setSummary(null);
    setConflictName(null);
    setAutoInstall(false);
    void inspect(path);
  };

  /** 点击拉起系统文件选择器(取消忽略) */
  const handleBrowse = async () => {
    if (busy) return;
    try {
      const picked = await SkillApi.pickImport();
      if (!picked.canceled) selectPath(picked.path);
    } catch (e) {
      setError(mapIpcError(e));
    }
  };

  /** 拖拽落点:取首个文件的本机路径 */
  const handleDrop = (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    if (busy) return;
    const file = e.dataTransfer.files[0];
    if (file) selectPath(dropFilePath(file));
  };

  /** 真装:成功 toast + 关闭 + invalidate;conflict(并发边缘)→ 覆盖弹窗;异常红字 */
  const install = async (path: string, overwrite = false) => {
    setInstalling(true);
    setError(null);
    try {
      const result = await SkillApi.importSkill({ path, overwrite });
      if (result.status === "conflict") {
        setConflictName(result.name);
        return;
      }
      if (result.status === "installed") {
        toast.success(
          t("chat:skills.installSuccess", { name: result.record.name }),
        );
        await queryClient.invalidateQueries({ queryKey: ["skillRecords"] });
        handleOpenChange(false);
      }
    } catch (e) {
      setError(mapIpcError(e));
    } finally {
      setInstalling(false);
    }
  };

  /** 冲突确认:关闭提示后以 overwrite 重装 */
  const handleOverwriteImport = () => {
    const path = pathRef.current;
    setConflictName(null);
    if (path) void install(path, true);
  };

  /** 勾上「非高风险自动安装」即触发安装;取消勾选仅改状态 */
  const handleAutoInstallChange = (checked: boolean) => {
    setAutoInstall(checked);
    if (checked && pathRef.current) void install(pathRef.current);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="rounded-lg border border-border/50 shadow-lg sm:max-w-md"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t("chat:skills.importTitle")}</DialogTitle>
          <DialogDescription>{t("chat:skills.requirement")}</DialogDescription>
        </DialogHeader>

        {/* 拖拽/点击选择区(选中后仍可重选) */}
        <button
          type="button"
          onClick={() => void handleBrowse()}
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          disabled={busy}
          className="flex w-full cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed border-border/50 p-6 text-center transition-colors hover:border-primary/30 hover:bg-primary-subtle disabled:cursor-not-allowed disabled:opacity-60"
        >
          {checking ? (
            <>
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              <span className="text-sm text-muted-foreground">
                {t("chat:skills.checking")}
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                {fileName}
              </span>
            </>
          ) : summary ? (
            <>
              <span className="text-sm font-medium text-foreground">
                {summary.name}
              </span>
              <span className="text-xs text-muted-foreground">
                {summary.description}
              </span>
            </>
          ) : (
            <>
              <UploadCloud className="h-6 w-6 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                {t("chat:skills.importDrop")}
              </span>
            </>
          )}
        </button>

        {/* 校验失败:保持文件名展示 + 红字原因,可重选 */}
        {error && !checking && (
          <div className="space-y-1">
            {fileName && (
              <p className="text-xs font-medium text-foreground">{fileName}</p>
            )}
            <p className="text-xs text-destructive">
              {`${t("chat:skills.importFailed")}: ${error}`}
            </p>
          </div>
        )}

        {/* 摘要态:非高风险自动安装开关 */}
        {summary && (
          <div className="flex items-center gap-2">
            <Checkbox
              id="skill-auto-install"
              checked={autoInstall}
              disabled={installing}
              onCheckedChange={(checked) =>
                handleAutoInstallChange(checked === true)
              }
            />
            <Label
              htmlFor="skill-auto-install"
              className="cursor-pointer text-sm text-muted-foreground"
            >
              {t("chat:skills.autoInstall")}
            </Label>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={installing}
          >
            {t("common:cancel")}
          </Button>
          {summary && (
            <Button
              onClick={() => {
                if (pathRef.current) void install(pathRef.current);
              }}
              disabled={busy}
            >
              {installing && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {t("chat:skills.install")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>

      {/* 冲突覆盖确认(与市场安装同款) */}
      <AlertDialog
        open={conflictName !== null}
        onOpenChange={(next) => {
          if (!next) setConflictName(null);
        }}
      >
        <AlertDialogContent className="rounded-lg border border-border/50 shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("chat:skills.conflictTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("chat:skills.conflictDesc", { name: conflictName ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={reset}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleOverwriteImport}>
              {t("chat:skills.overwrite")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
