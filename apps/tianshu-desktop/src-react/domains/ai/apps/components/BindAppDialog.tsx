/**
 * 会话绑定应用弹窗（切片 C P1）：应用单选 + 解绑。保存走
 * SessionApi.setApp（null=解绑）并失效 ["sessions"]（会话树即时反映
 * appId）。作用域生效在工具 execute 层，无需重启会话。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Check, LayoutGrid } from "lucide-react";
import SessionApi from "../../api/session.api";
import AppApi from "../../api/app.api";
import { mapIpcError } from "../../chat/lib/error-message";

const APPS_KEY = ["apps"] as const;

interface BindAppDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: number;
  /** 当前绑定 appId（缺省 = 未绑定） */
  currentAppId?: number;
}

export default function BindAppDialog({
  open,
  onOpenChange,
  sessionId,
  currentAppId,
}: BindAppDialogProps) {
  const { t } = useTranslation(["ai", "common"]);
  const queryClient = useQueryClient();
  const appsQuery = useQuery({
    queryKey: APPS_KEY,
    queryFn: () => AppApi.list(),
    enabled: open,
  });
  const apps = appsQuery.data ?? [];

  const [selected, setSelected] = useState<string>("none");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setSelected(currentAppId ? String(currentAppId) : "none");
    }
  }, [open, currentAppId]);

  const handleSave = async () => {
    if (saving) {
      return;
    }
    setSaving(true);
    try {
      const appId = selected === "none" ? null : Number(selected);
      await SessionApi.setApp(sessionId, appId);
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      onOpenChange(false);
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border border-border/50 rounded-lg shadow-lg">
        <DialogHeader>
          <DialogTitle>{t("ai:app.bindTitle")}</DialogTitle>
          <DialogDescription>{t("ai:app.bindTip")}</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
          <button
            type="button"
            onClick={() => setSelected("none")}
            className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left ${
              selected === "none"
                ? "bg-primary-subtle"
                : "hover:bg-primary-subtle/60"
            }`}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
              {selected === "none" && (
                <Check className="h-3.5 w-3.5 text-primary" />
              )}
            </span>
            <span className="text-sm text-muted-foreground">
              {t("ai:app.unbind")}
            </span>
          </button>
          {appsQuery.isPending ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">
              {t("common:loading")}
            </p>
          ) : apps.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">
              {t("ai:app.empty")}
            </p>
          ) : (
            apps.map((app) => (
              <button
                key={app.id}
                type="button"
                onClick={() => setSelected(String(app.id))}
                className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left ${
                  selected === String(app.id)
                    ? "bg-primary-subtle"
                    : "hover:bg-primary-subtle/60"
                }`}
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  {selected === String(app.id) && (
                    <Check className="h-3.5 w-3.5 text-primary" />
                  )}
                </span>
                <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {app.name}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t("ai:app.workflowCount", { count: app.graphIds.length })}
                </span>
              </button>
            ))
          )}
        </div>
        <DialogFooter>
          <p className="mr-auto max-w-[60%] text-xs font-normal text-muted-foreground">
            {t("ai:app.bindScopeNote")}
          </p>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common:cancel")}
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {t("common:confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
