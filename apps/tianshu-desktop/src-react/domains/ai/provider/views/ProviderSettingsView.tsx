/**
 * AI 服务商管理：主从双栏（左列服务商列表 + 右栏详情/模型管理，
 * 连通性测试/编辑/删除、远端模型拉取导入）
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus } from "lucide-react";

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
import ProviderApi, { type ProviderRecord } from "../../api/provider.api";
import ModelApi, { type ModelRecord } from "../../api/model.api";
import ProviderDialog from "../components/ProviderDialog";
import ModelDialog from "../components/ModelDialog";
import RemoteModelImportDialog from "../components/RemoteModelImportDialog";
import ProviderList from "../components/ProviderList";
import ProviderDetail from "../components/ProviderDetail";
import { mapIpcError } from "../../chat/lib/error-message";
import { useHostStore } from "../../data-source/host.store";

const PROVIDERS_KEY = ["providers"] as const;
const MODELS_KEY = ["models"] as const;

export default function ProviderSettingsView() {
  const { t } = useTranslation(["ai", "common"]);
  const queryClient = useQueryClient();
  const providersQuery = useQuery({
    queryKey: PROVIDERS_KEY,
    queryFn: () => ProviderApi.list(),
  });
  const modelsQuery = useQuery({
    queryKey: MODELS_KEY,
    queryFn: () => ModelApi.listAll(),
  });

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderRecord>();
  const [modelDialog, setModelDialog] = useState<{
    providerId: number;
    editing?: ModelRecord;
  } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [deletingProvider, setDeletingProvider] =
    useState<ProviderRecord | null>(null);
  const [deletingModel, setDeletingModel] = useState<ModelRecord | null>(null);
  const [testingModelId, setTestingModelId] = useState<number | null>(null);

  const providers = providersQuery.data ?? [];
  const models = modelsQuery.data ?? [];
  const modelCounts = useMemo(
    () =>
      models.reduce(
        (m, x) => m.set(x.providerId, (m.get(x.providerId) ?? 0) + 1),
        new Map<number, number>(),
      ),
    [models],
  );
  const selected = providers.find((p) => p.id === selectedId) ?? null;

  // 默认选中：数据就绪且未选中（或选中项已不存在）→ 首个
  useEffect(() => {
    if (providers.length > 0 && !providers.some((p) => p.id === selectedId)) {
      setSelectedId(providers[0].id);
    }
  }, [providers, selectedId]);

  const openCreate = () => {
    setEditingProvider(undefined);
    setProviderDialogOpen(true);
  };

  const openEdit = (provider: ProviderRecord) => {
    setEditingProvider(provider);
    setProviderDialogOpen(true);
  };

  const openAddModel = (providerId: number) => {
    setModelDialog({ providerId });
  };

  const openEditModel = (model: ModelRecord) => {
    setModelDialog({ providerId: model.providerId, editing: model });
  };

  const invalidateProviderData = async () => {
    await queryClient.invalidateQueries({ queryKey: PROVIDERS_KEY });
    await queryClient.invalidateQueries({ queryKey: MODELS_KEY });
  };

  const handleError = (e: unknown) => {
    toast.error(mapIpcError(e));
  };

  // 远程桌面被控端只读（HD-P3a）：provider save 端点仅无头端有（caps.graph
  // 判定——与 ProviderPanel editable 同口径）；只读态写回调轻提示不放行
  // （防远端 404 误导排障）
  const activeHost = useHostStore((s) => s.activeHost);
  const caps = useHostStore((s) => s.caps);
  const remoteReadOnly = activeHost.kind === "remote" && !caps.graph;
  const guardWrite =
    <A extends unknown[]>(
      action: (...args: A) => unknown,
    ): ((...args: A) => unknown) =>
    (...args) => {
      if (remoteReadOnly) {
        toast.info(t("ai:provider.remoteReadOnly"));
        return undefined;
      }
      return action(...args);
    };

  const toggleEnabled = async (provider: ProviderRecord, enabled: boolean) => {
    if (remoteReadOnly) {
      toast.info(t("ai:provider.remoteReadOnly"));
      return;
    }
    try {
      await ProviderApi.update({ id: provider.id, enabled });
      await queryClient.invalidateQueries({ queryKey: PROVIDERS_KEY });
    } catch (e) {
      handleError(e);
    }
  };

  /** 模型开关：乐观翻转 → update → 失败回滚 + toast（spec §5） */
  const handleToggleModel = async (model: ModelRecord, enabled: boolean) => {
    if (remoteReadOnly) {
      toast.info(t("ai:provider.remoteReadOnly"));
      return;
    }
    const snapshot = models;
    queryClient.setQueryData<ModelRecord[]>(MODELS_KEY, (rows) =>
      (rows ?? []).map((r) => (r.id === model.id ? { ...r, enabled } : r)),
    );
    try {
      await ModelApi.update({ id: model.id, enabled });
    } catch (e) {
      queryClient.setQueryData(MODELS_KEY, snapshot);
      handleError(e);
    }
  };

  const handleTest = async (model: ModelRecord) => {
    if (testingModelId !== null) {
      return;
    }
    setTestingModelId(model.id);
    try {
      const result = await ModelApi.test(model.id);
      if (result.success) {
        toast.success(t("ai:model.testSuccess"));
      } else {
        toast.error(t(`ai:errors.${result.errorCode ?? "UNKNOWN"}`));
      }
    } catch (e) {
      handleError(e);
    } finally {
      setTestingModelId(null);
    }
  };

  const handleDeleteProvider = async () => {
    if (!deletingProvider) {
      return;
    }
    try {
      await ProviderApi.delete(deletingProvider.id);
      await invalidateProviderData();
      // 删除后回落：清空选中，默认选中 effect 自动重选首个
      setSelectedId(null);
    } catch (e) {
      handleError(e);
    } finally {
      setDeletingProvider(null);
    }
  };

  const handleDeleteModel = async () => {
    if (!deletingModel) {
      return;
    }
    try {
      await ModelApi.delete(deletingModel.id);
      await queryClient.invalidateQueries({ queryKey: MODELS_KEY });
    } catch (e) {
      handleError(e);
    } finally {
      setDeletingModel(null);
    }
  };

  // 页面顶行（TopBar 中段）：标题迁入（原 PageTitle 横幅），页内留副标题
  usePageHeader({
    title: (
      <h2 className="truncate text-sm font-medium text-foreground">
        {t("ai:pageTitle")}
      </h2>
    ),
  });

  return (
    // 实底背景：遮住 body 壁纸叠加层（皮肤体系壁纸不透入本页内容区）
    <div className="h-full overflow-y-auto bg-background p-6">
      {providersQuery.isPending ? (
        <p className="py-16 text-center text-sm text-muted-foreground">
          {t("common:loading")}
        </p>
      ) : providersQuery.isError ? (
        <p className="py-16 text-center text-sm text-destructive">
          {providersQuery.error instanceof Error
            ? providersQuery.error.message
            : t("ai:errors.UNKNOWN")}
        </p>
      ) : providers.length === 0 ? (
        <Card className="border-border/50 rounded-lg shadow-sm">
          <CardHeader>
            <CardTitle>{t("ai:provider.empty")}</CardTitle>
            <CardDescription>{t("ai:provider.emptyTip")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={openCreate}>
              <Plus className="mr-1 h-4 w-4" />
              {t("ai:provider.add")}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="flex h-[calc(100vh-8.5rem)] gap-4">
          <ProviderList
            providers={providers}
            modelCounts={modelCounts}
            selectedId={selectedId}
            totalModels={models.length}
            onSelect={setSelectedId}
            onAdd={guardWrite(openCreate)}
          />
          {selected ? (
            <ProviderDetail
              provider={selected}
              models={models.filter((m) => m.providerId === selected.id)}
              testingModelId={testingModelId}
              onToggleEnabled={(enabled) => toggleEnabled(selected, enabled)}
              onEdit={guardWrite(() => openEdit(selected))}
              onDelete={guardWrite(() => setDeletingProvider(selected))}
              onFetchRemote={() => setImportOpen(true)}
              onToggleModel={handleToggleModel}
              onTestModel={handleTest}
              onEditModel={guardWrite(openEditModel)}
              onDeleteModel={guardWrite(setDeletingModel)}
              onAddModel={guardWrite(() => openAddModel(selected.id))}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-border/60 text-sm text-muted-foreground">
              {t("ai:provider.selectFirst")}
            </div>
          )}
        </div>
      )}

      <ProviderDialog
        open={providerDialogOpen}
        onOpenChange={setProviderDialogOpen}
        editing={editingProvider}
        onCreated={(id) => setSelectedId(id)}
      />
      <ModelDialog
        open={modelDialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setModelDialog(null);
          }
        }}
        providerId={modelDialog?.providerId ?? 0}
        editing={modelDialog?.editing}
      />
      <RemoteModelImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        provider={selected}
        existingModelIds={
          selected
            ? models
                .filter((m) => m.providerId === selected.id)
                .map((m) => m.modelId)
            : []
        }
      />

      <AlertDialog
        open={deletingProvider !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeletingProvider(null);
          }
        }}
      >
        <AlertDialogContent className="border border-border/50 rounded-lg shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("ai:provider.deleteConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deletingProvider
                ? `${deletingProvider.name} · ${t("ai:provider.deleteConfirmDesc")}`
                : t("ai:provider.deleteConfirmDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteProvider}>
              {t("common:confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deletingModel !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeletingModel(null);
          }
        }}
      >
        <AlertDialogContent className="border border-border/50 rounded-lg shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("common:confirmDelete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {deletingModel
                ? `${deletingModel.modelId} · ${t("common:irreversible")}`
                : t("common:irreversible")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteModel}>
              {t("common:confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
