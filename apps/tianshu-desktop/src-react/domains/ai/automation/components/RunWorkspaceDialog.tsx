import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { WorkspaceRecord } from "../../api/workspace.api";

interface RunWorkspaceDialogProps {
  open: boolean;
  workspaces: WorkspaceRecord[];
  onConfirm: (workspaceId: number) => void;
  onCancel: () => void;
}

/** 历史运行无法推导空间时，只允许用户显式选择，绝不默认第一空间。 */
export default function RunWorkspaceDialog({
  open,
  workspaces,
  onConfirm,
  onCancel,
}: RunWorkspaceDialogProps) {
  const { t } = useTranslation(["chat", "common"]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  useEffect(() => {
    if (open) setSelectedId(null);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="border border-border/50 rounded-lg shadow-lg sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("chat:runSession.workspaceRequiredTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("chat:runSession.workspaceRequiredDescription")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              aria-pressed={selectedId === workspace.id}
              className={`rounded-md border px-3 py-2 text-left text-sm hover:bg-primary-subtle hover:text-primary hover:border-primary/30 ${
                selectedId === workspace.id
                  ? "border-primary bg-primary-subtle text-primary"
                  : "border-border/50"
              }`}
              onClick={() => setSelectedId(workspace.id)}
            >
              {workspace.name}
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {t("common:cancel")}
          </Button>
          <Button
            disabled={selectedId === null}
            onClick={() => selectedId !== null && onConfirm(selectedId)}
          >
            {t("common:confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
