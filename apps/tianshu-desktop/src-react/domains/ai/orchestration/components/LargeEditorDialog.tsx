// src-react/domains/ai/orchestration/components/LargeEditorDialog.tsx
/**
 * 放大编辑弹窗：近全屏 Dialog 内嵌 HighlightTextarea（fill 撑满），
 * 编辑实时同步草稿（onChange 直通，无确认步——所见即所得，关闭即用）。
 * 提示词/脚本两处复用。
 */
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import HighlightTextarea from "./HighlightTextarea";
import type { HighlightLanguage } from "../lib/prompt-highlight";

export interface LargeEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  value: string;
  onChange: (next: string) => void;
  language: HighlightLanguage;
  placeholder?: string;
}

export default function LargeEditorDialog({
  open,
  onOpenChange,
  title,
  value,
  onChange,
  language,
  placeholder,
}: LargeEditorDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] max-w-4xl flex-col rounded-lg border border-border/50 shadow-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1">
          <HighlightTextarea
            value={value}
            onChange={onChange}
            language={language}
            placeholder={placeholder}
            fill
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
