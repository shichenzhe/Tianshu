/**
 * 跨 AI 导入记忆弹窗（spec §6.4 两步）：① 复制预置提示词到外部 AI
 * （getImportPrompt 按当前 locale；成功短暂「已复制」，失败提示手动复制）
 * ② 粘贴返回结果 → 先剥代码块围栏再 mergeMemoryMarkdown 合并追加（近期
 * 动态按日期重排）。未识别到任何四节标题 → 回退 toast（内容仍全进工作
 * 背景，merge 自身处理）；成功 → toast + 关闭清空；失败 → toast 且弹窗
 * 保持打开。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getImportPrompt } from "../../model/import-prompt";
import {
  hasMemoryHeadings,
  mergeMemoryMarkdown,
  stripCodeFence,
} from "../../model/memory-markdown";

export interface ImportMemoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前记忆全文（合并追加的基准，非覆盖） */
  currentMemory: string;
  /** 导入落库（reject = 失败，弹窗保持打开并 toast error） */
  onImported: (merged: string) => Promise<void>;
}

/** 复制成功后「已复制」的复位延时 */
const COPIED_RESET_MS = 2000;

export default function ImportMemoryDialog({
  open,
  onOpenChange,
  currentMemory,
  onImported,
}: ImportMemoryDialogProps) {
  const { t, i18n } = useTranslation(["settings"]);
  const [value, setValue] = useState("");
  const [copied, setCopied] = useState(false);
  const [importing, setImporting] = useState(false);

  // 每次打开重置粘贴内容与复制态（关闭期间状态不跨次残留）
  useEffect(() => {
    if (open) {
      setValue("");
      setCopied(false);
    }
  }, [open]);

  const prompt = getImportPrompt(
    i18n.language.startsWith("en") ? "en-US" : "zh-CN",
  );

  /** 复制提示词：成功短暂「已复制」，失败提示手动复制 */
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_RESET_MS);
    } catch {
      toast.error(t("settings:memory.toast.copyFailed"));
    }
  };

  /** 导入：剥围栏 → 未识别到分类标记先回退提示（内容仍进工作背景）→ 合并追加 */
  const handleImport = async () => {
    const stripped = stripCodeFence(value);
    if (!hasMemoryHeadings(stripped)) {
      toast.info(t("settings:memory.toast.importFallback"));
    }
    const merged = mergeMemoryMarkdown(currentMemory, stripped);
    setImporting(true);
    try {
      await onImported(merged);
      toast.success(t("settings:memory.toast.imported"));
      onOpenChange(false);
      setValue("");
    } catch {
      toast.error(t("settings:error.saveFailed"));
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg border-border/50 rounded-lg shadow-lg">
        <DialogHeader>
          <DialogTitle>{t("settings:memory.importDialog.title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-5">
          <section className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary-subtle text-xs font-medium text-primary">
                  1
                </span>
                <h4 className="text-sm font-medium text-foreground">
                  {t("settings:memory.importDialog.step1.title")}
                </h4>
              </div>
              <Button
                size="sm"
                className="h-7 px-3 text-xs"
                onClick={() => void copyPrompt()}
              >
                {copied
                  ? t("settings:memory.importDialog.step1.copied")
                  : t("settings:memory.importDialog.step1.copy")}
              </Button>
            </div>
            <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md border border-border/50 bg-muted/50 p-3 text-xs leading-relaxed text-foreground/80">
              {prompt}
            </pre>
          </section>
          <section className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary-subtle text-xs font-medium text-primary">
                2
              </span>
              <h4 className="text-sm font-medium text-foreground">
                {t("settings:memory.importDialog.step2.title")}
              </h4>
            </div>
            <Textarea
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={t("settings:memory.importDialog.step2.placeholder")}
              aria-label={t("settings:memory.importDialog.step2.title")}
              className="min-h-[96px] text-xs leading-relaxed"
            />
          </section>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          >
            {t("common:cancel")}
          </Button>
          <Button
            disabled={value.trim() === "" || importing}
            onClick={() => void handleImport()}
          >
            {t("settings:memory.importDialog.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
