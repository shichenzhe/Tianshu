/**
 * AI 服务商管理：服务商表格 + 行内模型管理（连通性测试/编辑/删除、Ollama 导入）
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Edit, FolderOpen, Play, Plus, Trash2 } from "lucide-react";

import PageTitle from "@/components/layout/PageTitle";
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
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import ProviderApi, { type ProviderRecord } from "../../api/provider.api";
import ModelApi, { type ModelRecord } from "../../api/model.api";
import ProviderDialog from "../components/ProviderDialog";
import ModelDialog from "../components/ModelDialog";
import OllamaImportDialog from "../components/OllamaImportDialog";

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

  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderRecord>();
  const [modelDialog, setModelDialog] = useState<{
    providerId: number;
    editing?: ModelRecord;
  } | null>(null);
  const [ollamaProviderId, setOllamaProviderId] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [deletingProvider, setDeletingProvider] =
    useState<ProviderRecord | null>(null);
  const [deletingModel, setDeletingModel] = useState<ModelRecord | null>(null);
  const [testingModelId, setTestingModelId] = useState<number | null>(null);

  const providers = providersQuery.data ?? [];
  const models = modelsQuery.data ?? [];

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
    toast.error(e instanceof Error ? e.message : String(e));
  };

  const toggleEnabled = async (provider: ProviderRecord, enabled: boolean) => {
    try {
      await ProviderApi.update({ id: provider.id, enabled });
      await queryClient.invalidateQueries({ queryKey: PROVIDERS_KEY });
    } catch (e) {
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
      if (expandedId === deletingProvider.id) {
        setExpandedId(null);
      }
      await invalidateProviderData();
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

  return (
    <div className="p-6">
      <PageTitle title={t("ai:pageTitle")} />
      <p className="mb-4 text-sm text-muted-foreground">{t("ai:pageDesc")}</p>

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
        <>
          <div className="mb-4">
            <Button onClick={openCreate} size="sm">
              <Plus className="mr-1 h-4 w-4" />
              {t("ai:provider.add")}
            </Button>
          </div>
          <div className="bg-card rounded-lg border border-border/50 shadow-sm">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("ai:provider.name")}</TableHead>
                  <TableHead className="w-40">
                    {t("ai:provider.type")}
                  </TableHead>
                  <TableHead>{t("ai:provider.baseUrl")}</TableHead>
                  <TableHead className="w-24 text-center">
                    {t("ai:provider.models")}
                  </TableHead>
                  <TableHead className="w-20 text-center">
                    {t("ai:provider.enabled")}
                  </TableHead>
                  <TableHead className="w-56">
                    {t("common:operation")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {providers.map((provider) => (
                  <ProviderRow
                    key={provider.id}
                    provider={provider}
                    models={models.filter((m) => m.providerId === provider.id)}
                    expanded={expandedId === provider.id}
                    testingModelId={testingModelId}
                    onToggleEnabled={(enabled) =>
                      toggleEnabled(provider, enabled)
                    }
                    onToggleExpand={() =>
                      setExpandedId(
                        expandedId === provider.id ? null : provider.id,
                      )
                    }
                    onEdit={() => openEdit(provider)}
                    onDelete={() => setDeletingProvider(provider)}
                    onAddModel={() => openAddModel(provider.id)}
                    onImportOllama={() => setOllamaProviderId(provider.id)}
                    onTestModel={handleTest}
                    onEditModel={openEditModel}
                    onDeleteModel={setDeletingModel}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      <ProviderDialog
        open={providerDialogOpen}
        onOpenChange={setProviderDialogOpen}
        editing={editingProvider}
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
      <OllamaImportDialog
        open={ollamaProviderId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setOllamaProviderId(null);
          }
        }}
        providerId={ollamaProviderId ?? 0}
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

interface ProviderRowProps {
  provider: ProviderRecord;
  models: ModelRecord[];
  expanded: boolean;
  testingModelId: number | null;
  onToggleEnabled: (enabled: boolean) => void;
  onToggleExpand: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onAddModel: () => void;
  onImportOllama: () => void;
  onTestModel: (model: ModelRecord) => void;
  onEditModel: (model: ModelRecord) => void;
  onDeleteModel: (model: ModelRecord) => void;
}

function ProviderRow({
  provider,
  models,
  expanded,
  testingModelId,
  onToggleEnabled,
  onToggleExpand,
  onEdit,
  onDelete,
  onAddModel,
  onImportOllama,
  onTestModel,
  onEditModel,
  onDeleteModel,
}: ProviderRowProps) {
  const { t } = useTranslation(["ai", "common"]);

  return (
    <>
      <TableRow>
        <TableCell className="font-medium">{provider.name}</TableCell>
        <TableCell>
          <Badge variant="secondary">{provider.type}</Badge>
        </TableCell>
        <TableCell className="max-w-56 truncate font-mono text-xs text-muted-foreground">
          {provider.baseUrl}
        </TableCell>
        <TableCell className="text-center text-muted-foreground">
          {models.length}
        </TableCell>
        <TableCell className="text-center">
          <Switch
            checked={provider.enabled}
            onCheckedChange={onToggleEnabled}
            aria-label={t("ai:provider.enabled")}
          />
        </TableCell>
        <TableCell>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 hover:bg-primary-subtle hover:text-primary"
              onClick={onToggleExpand}
            >
              <FolderOpen className="mr-1 h-3 w-3" />
              {t("ai:provider.manageModels")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 hover:bg-primary-subtle hover:text-primary"
              onClick={onEdit}
              aria-label={t("common:edit")}
            >
              <Edit className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 hover:bg-primary-subtle hover:text-destructive"
              onClick={onDelete}
              aria-label={t("common:delete")}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={6} className="bg-primary-subtle/40 p-4">
            <div className="mb-2 flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={onAddModel}>
                <Plus className="mr-1 h-3 w-3" />
                {t("ai:model.add")}
              </Button>
              {provider.type === "ollama" && (
                <Button
                  size="sm"
                  variant="outline"
                  className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
                  onClick={onImportOllama}
                >
                  {t("ai:model.importOllama")}
                </Button>
              )}
            </div>
            <div className="rounded-lg border border-border/50 bg-background">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("ai:model.modelId")}</TableHead>
                    <TableHead>{t("ai:model.displayName")}</TableHead>
                    <TableHead className="w-40">
                      {t("common:operation")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {models.map((model) => (
                    <ModelRow
                      key={model.id}
                      model={model}
                      testing={testingModelId === model.id}
                      onTest={onTestModel}
                      onEdit={onEditModel}
                      onDelete={onDeleteModel}
                    />
                  ))}
                  {models.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={3}
                        className="py-6 text-center text-sm text-muted-foreground"
                      >
                        {t("common:noData")}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

interface ModelRowProps {
  model: ModelRecord;
  testing: boolean;
  onTest: (model: ModelRecord) => void;
  onEdit: (model: ModelRecord) => void;
  onDelete: (model: ModelRecord) => void;
}

function ModelRow({ model, testing, onTest, onEdit, onDelete }: ModelRowProps) {
  const { t } = useTranslation(["ai", "common"]);

  return (
    <TableRow>
      <TableCell className="font-mono text-sm">{model.modelId}</TableCell>
      <TableCell className="text-muted-foreground">
        {model.name || "-"}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 hover:bg-primary-subtle hover:text-primary"
            disabled={testing}
            onClick={() => onTest(model)}
          >
            <Play className="mr-1 h-3 w-3" />
            {testing ? t("ai:model.testing") : t("ai:model.test")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 hover:bg-primary-subtle hover:text-primary"
            onClick={() => onEdit(model)}
            aria-label={t("common:edit")}
          >
            <Edit className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 hover:bg-primary-subtle hover:text-destructive"
            onClick={() => onDelete(model)}
            aria-label={t("common:delete")}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
