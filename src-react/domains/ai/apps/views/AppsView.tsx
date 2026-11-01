/**
 * 应用管理页（聚合期核心，切片 C P1）：应用列表 + 新建/编辑（名称/描述/
 * 工作流勾选）+ 删除。应用 = 一组工作流的聚合边界，会话绑定后工作流工具
 * 面收窄到应用集合（作用域在工具 execute 层生效）。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { LayoutGrid, Pencil, Plus, Trash2 } from "lucide-react";

import { usePageHeader } from "@/components/layout/page-header.store";
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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import AppApi, { type AppRecord } from "../../api/app.api";
import AppDialog from "../components/AppDialog";
import { mapIpcError } from "../../chat/lib/error-message";

const APPS_KEY = ["apps"] as const;

export default function AppsView() {
  const { t } = useTranslation(["ai", "common"]);
  const queryClient = useQueryClient();
  const listQuery = useQuery({
    queryKey: APPS_KEY,
    queryFn: () => AppApi.list(),
  });
  const apps = listQuery.data ?? [];

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AppRecord>();
  const [deleting, setDeleting] = useState<AppRecord | null>(null);

  usePageHeader({
    title: (
      <h2 className="truncate text-sm font-medium text-foreground">
        {t("ai:pageTitle")}
      </h2>
    ),
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: APPS_KEY });
  };

  const handleDelete = async () => {
    if (!deleting) {
      return;
    }
    try {
      await AppApi.delete(deleting.id);
      await invalidate();
      // 会话解绑在主进程删除链路内完成（session.appId 置 null），
      // 会话树缓存一并失效
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-background p-6">
      {listQuery.isPending ? (
        <p className="py-16 text-center text-sm text-muted-foreground">
          {t("common:loading")}
        </p>
      ) : listQuery.isError ? (
        <p className="py-16 text-center text-sm text-destructive">
          {listQuery.error instanceof Error
            ? listQuery.error.message
            : t("ai:errors.UNKNOWN")}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-foreground">
                {t("ai:app.sectionTitle")}
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("ai:app.sectionTip")}
              </p>
            </div>
            <Button
              onClick={() => {
                setEditing(undefined);
                setDialogOpen(true);
              }}
            >
              <Plus className="mr-1 h-4 w-4" />
              {t("ai:app.add")}
            </Button>
          </div>

          {apps.length === 0 ? (
            <Card className="border-border/50 rounded-lg shadow-sm">
              <CardHeader>
                <CardTitle>{t("ai:app.empty")}</CardTitle>
                <CardDescription>{t("ai:app.emptyTip")}</CardDescription>
              </CardHeader>
            </Card>
          ) : (
            apps.map((app) => (
              <Card
                key={app.id}
                className="border-border/50 rounded-lg shadow-sm"
              >
                <CardContent className="flex flex-wrap items-center gap-3 py-4">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-subtle">
                    <LayoutGrid className="h-4 w-4 text-primary" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {app.name}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {app.description ||
                        t("ai:app.workflowCount", {
                          count: app.graphIds.length,
                        })}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setEditing(app);
                        setDialogOpen(true);
                      }}
                      className="gap-1.5 hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      {t("common:edit")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setDeleting(app)}
                      className="gap-1.5 hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {t("common:delete")}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      )}

      <AppDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        onSaved={() => void invalidate()}
      />

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null);
          }
        }}
      >
        <AlertDialogContent className="border border-border/50 rounded-lg shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("ai:app.deleteConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleting
                ? `${deleting.name} · ${t("ai:app.deleteConfirmDesc")}`
                : t("ai:app.deleteConfirmDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleDelete()}>
              {t("common:confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
