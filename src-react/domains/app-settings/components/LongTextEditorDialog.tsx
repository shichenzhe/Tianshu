/**
 * 大文本编辑弹窗（人设/记忆共用，spec §5.1）：受控 Textarea（maxLength
 * 参数化）+ 字数统计 + 取消/保存。保存成功 → toast + 关闭；失败 → toast
 * 保持打开（编辑内容不丢）。存在未保存修改时关闭 → AlertDialog 二次确认。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface LongTextEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 弹窗标题（已翻译文本） */
  title: string;
  /** 编辑初始值（每次打开重置为该值） */
  initialValue: string;
  maxLength: number;
  /** 持久化回调（reject = 失败，弹窗保持打开并 toast error） */
  onSave: (value: string) => Promise<void>;
}

export default function LongTextEditorDialog({
  open,
  onOpenChange,
  title,
  initialValue,
  maxLength,
  onSave,
}: LongTextEditorDialogProps) {
  const { t } = useTranslation(["settings"]);
  const [draft, setDraft] = useState(initialValue);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // 每次打开重置草稿（关闭期间外部 initialValue 变化同步不到草稿）
  useEffect(() => {
    if (open) {
      setDraft(initialValue);
    }
  }, [open, initialValue]);

  const dirty = draft !== initialValue;

  /** 保存：成功 toast + 关闭；失败 toast + 保持打开 */
  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(draft.trim());
      toast.success(t("settings:personalization.savedToast"));
      onOpenChange(false);
    } catch {
      toast.error(t("settings:error.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  /** 关闭请求：干净直接关，脏态先确认 */
  const requestClose = () => {
    if (dirty) {
      setConfirmDiscard(true);
    } else {
      onOpenChange(false);
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}
      >
        <DialogContent className="max-w-3xl h-[70vh] p-0 gap-0 flex flex-col overflow-hidden">
          <DialogHeader className="px-6 py-4 border-b border-border/50">
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto px-6 py-4">
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={maxLength}
              aria-label={title}
              className="min-h-full resize-none font-mono text-xs leading-relaxed"
            />
          </div>
          <div className="flex items-center justify-between border-t border-border/50 px-6 py-3">
            <span className="text-xs text-muted-foreground">
              {t("settings:personalization.charCount", {
                count: draft.length,
                max: maxLength,
              })}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={requestClose}
                className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
              >
                {t("settings:personalization.editor.cancel")}
              </Button>
              <Button
                disabled={!dirty || saving}
                onClick={() => void handleSave()}
              >
                {t("settings:personalization.editor.save")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent className="border border-border/50 rounded-lg shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings:personalization.editor.unsavedTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings:personalization.editor.unsavedBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction
              onClick={() => {
                setConfirmDiscard(false);
                onOpenChange(false);
              }}
            >
              {t("settings:personalization.editor.discard")}
            </AlertDialogAction>
            <AlertDialogAction onClick={() => setConfirmDiscard(false)}>
              {t("settings:personalization.editor.keepEditing")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
