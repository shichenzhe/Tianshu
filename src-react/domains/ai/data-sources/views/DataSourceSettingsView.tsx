/**
 * 数据源设置页（PG 首选通道，切片 B 2026-10-29）：配置列表 + 新增/编辑/
 * 删除 + 连通性测试。配置行供 database 节点 dataSourceId 引用——凭据只
 * 写不读（回执 hasPassword），永不出现在聊天上下文。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Database, Loader2, Pencil, Plus, PlugZap, Trash2 } from "lucide-react";

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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import DataSourceApi, {
  type DataSourceRecord,
} from "../../api/data-source.api";
import DataSourceDialog from "../components/DataSourceDialog";
import { mapIpcError } from "../../chat/lib/error-message";

const DATA_SOURCES_KEY = ["dataSources"] as const;

export default function DataSourceSettingsView() {
  const { t } = useTranslation(["ai", "common"]);
  const queryClient = useQueryClient();
  const listQuery = useQuery({
    queryKey: DATA_SOURCES_KEY,
    queryFn: () => DataSourceApi.list(),
  });
  const sources = listQuery.data ?? [];

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<DataSourceRecord>();
  const [deleting, setDeleting] = useState<DataSourceRecord | null>(null);
  const [testingId, setTestingId] = useState<number | null>(null);

  usePageHeader({
    title: (
      <h2 className="truncate text-sm font-medium text-foreground">
        {t("ai:pageTitle")}
      </h2>
    ),
  });

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: DATA_SOURCES_KEY });
  };

  const openCreate = () => {
    setEditing(undefined);
    setDialogOpen(true);
  };

  const openEdit = (source: DataSourceRecord) => {
    setEditing(source);
    setDialogOpen(true);
  };

  const handleTest = async (source: DataSourceRecord) => {
    if (testingId !== null) {
      return;
    }
    setTestingId(source.id);
    try {
      const result = await DataSourceApi.test(source.id);
      if (result.success) {
        toast.success(
          t("ai:dataSource.testSuccess", { latencyMs: result.latencyMs ?? 0 }),
        );
      } else {
        toast.error(result.error ?? t("ai:dataSource.testFailed"));
      }
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setTestingId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleting) {
      return;
    }
    try {
      await DataSourceApi.delete(deleting.id);
      await invalidate();
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
                {t("ai:dataSource.sectionTitle")}
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("ai:dataSource.sectionTip")}
              </p>
            </div>
            <Button onClick={openCreate} className="hover:bg-primary-hover">
              <Plus className="mr-1 h-4 w-4" />
              {t("ai:dataSource.add")}
            </Button>
          </div>

          {sources.length === 0 ? (
            <Card className="border-border/50 rounded-lg shadow-sm">
              <CardHeader>
                <CardTitle>{t("ai:dataSource.empty")}</CardTitle>
                <CardDescription>{t("ai:dataSource.emptyTip")}</CardDescription>
              </CardHeader>
            </Card>
          ) : (
            sources.map((source) => (
              <Card
                key={source.id}
                className="border-border/50 rounded-lg shadow-sm"
              >
                <CardContent className="flex flex-wrap items-center gap-3 py-4">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-subtle">
                    <Database className="h-4 w-4 text-primary" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                      <span className="truncate">{source.name}</span>
                      <Badge variant="secondary" className="shrink-0">
                        {source.engine}
                      </Badge>
                      {source.ssl && (
                        <Badge variant="outline" className="shrink-0">
                          SSL
                        </Badge>
                      )}
                    </p>
                    <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                      {source.host}:{source.port}/{source.database}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={testingId === source.id}
                      onClick={() => void handleTest(source)}
                      className="gap-1.5 hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
                    >
                      {testingId === source.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <PlugZap className="h-3.5 w-3.5" />
                      )}
                      {t("ai:dataSource.test")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openEdit(source)}
                      className="gap-1.5 hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      {t("common:edit")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setDeleting(source)}
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

      <DataSourceDialog
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
              {t("ai:dataSource.deleteConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleting
                ? `${deleting.name} · ${t("ai:dataSource.deleteConfirmDesc")}`
                : t("ai:dataSource.deleteConfirmDesc")}
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
