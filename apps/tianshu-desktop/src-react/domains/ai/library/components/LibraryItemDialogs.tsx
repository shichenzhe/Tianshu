/**
 * 资料库名称输入弹窗：新建文件夹与重命名共用（title/初值由 props 决定），
 * 空名提交禁用；提交调 LibraryApi 后由调用方失效缓存并 toast。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface LibraryItemDialogsProps {
  open: boolean;
  mode: "createFolder" | "rename";
  initialName: string;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void;
}

export default function LibraryItemDialogs({
  open,
  mode,
  initialName,
  submitting,
  onClose,
  onSubmit,
}: LibraryItemDialogsProps) {
  const { t } = useTranslation(["chat", "common"]);
  const [name, setName] = useState(initialName);
  useEffect(() => {
    if (open) {
      setName(initialName);
    }
  }, [open, initialName]);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="border border-border/50 rounded-lg shadow-lg sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {t(
              mode === "createFolder"
                ? "chat:library.createFolderTitle"
                : "chat:library.renameTitle",
            )}
          </DialogTitle>
        </DialogHeader>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label={t("chat:library.nameLabel")}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim() && !submitting) {
              onSubmit(name.trim());
            }
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common:cancel")}
          </Button>
          <Button
            disabled={!name.trim() || submitting}
            onClick={() => onSubmit(name.trim())}
          >
            {t("common:confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
