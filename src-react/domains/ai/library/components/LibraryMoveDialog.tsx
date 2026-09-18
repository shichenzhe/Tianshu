/**
 * 移动弹窗：目标文件夹浏览（根「我的资料」起，逐层进入），「移到这里」
 * 调 library:move；同层重名由后端自动序号。复用 library:list。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronLeft, Folder } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import LibraryApi from "../api/library.api";
import { mapIpcError } from "@/domains/ai/chat/lib/error-message";

interface LibraryMoveDialogProps {
  open: boolean;
  itemIds: number[];
  onClose: () => void;
  onMoved: () => void;
}

export default function LibraryMoveDialog({
  open,
  itemIds,
  onClose,
  onMoved,
}: LibraryMoveDialogProps) {
  const { t } = useTranslation(["chat", "common"]);
  const [folderId, setFolderId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { data } = useQuery({
    queryKey: ["libraryItems", folderId],
    queryFn: () => LibraryApi.list(folderId ?? undefined),
    enabled: open,
  });
  const folders = (data?.items ?? []).filter((item) => item.kind === "folder");

  /** 关闭统一重置浏览层（取消/遮罩关闭/移入成功后均回根层，避免下次开窗残留） */
  const handleClose = () => {
    onClose();
    setFolderId(null);
  };

  const handleMove = async () => {
    setSubmitting(true);
    try {
      await LibraryApi.move(itemIds, folderId ?? undefined);
      onMoved();
      handleClose();
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && handleClose()}>
      <DialogContent className="border border-border/50 rounded-lg shadow-lg sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {folderId !== null && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0"
                aria-label={t("common:back")}
                title={t("common:back")}
                onClick={() => setFolderId(null)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
            )}
            {folderId === null
              ? t("chat:library.moveTargetRoot")
              : (data?.breadcrumbs ?? []).slice(-1)[0]?.name}
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-56 overflow-y-auto">
          {folders.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {t("chat:library.empty")}
            </p>
          )}
          {folders.map((folder) => (
            <button
              key={folder.id}
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-primary-subtle hover:text-primary"
              onClick={() => setFolderId(folder.id)}
            >
              <Folder className="h-4 w-4 shrink-0 text-primary" />
              <span className="truncate">{folder.name}</span>
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            {t("common:cancel")}
          </Button>
          <Button disabled={submitting} onClick={() => void handleMove()}>
            {t("chat:library.moveHere")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
