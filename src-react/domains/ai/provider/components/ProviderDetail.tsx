/**
 * 右栏详情（spec §3.1）：详情头（名称/类型/地址/开关/编辑/删除）+
 * 拉取行（拉取动作兼任连接测试）+ ModelList。comfyui 无模型列表概念
 * ——拉取入口隐藏，换 provider 级「测试连接」（GET /system_stats）
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Edit, Play, RefreshCw, Trash2 } from "lucide-react";

import IconTooltip from "@/components/common/icon-tooltip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import ProviderApi, { type ProviderRecord } from "../../api/provider.api";
import type { ModelRecord } from "../../api/model.api";
import { mapIpcError } from "../../chat/lib/error-message";
import { useHostStore } from "../../data-source/host.store";
import ModelList from "./ModelList";

export default function ProviderDetail({
  provider,
  models,
  testingModelId,
  onToggleEnabled,
  onEdit,
  onDelete,
  onFetchRemote,
  onToggleModel,
  onTestModel,
  onEditModel,
  onDeleteModel,
  onAddModel,
}: {
  provider: ProviderRecord;
  models: ModelRecord[];
  testingModelId: number | null;
  onToggleEnabled: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onFetchRemote: () => void;
  onToggleModel: (model: ModelRecord, enabled: boolean) => void;
  onTestModel: (model: ModelRecord) => void;
  onEditModel: (model: ModelRecord) => void;
  onDeleteModel: (model: ModelRecord) => void;
  onAddModel: () => void;
}) {
  const { t } = useTranslation(["ai"]);
  const [testingConnection, setTestingConnection] = useState(false);
  const hostKind = useHostStore((s) => s.activeHost.kind);
  const isComfyui = provider.type === "comfyui";
  // provider:test 为本地 IPC——远程主机 provider id 与本地自增 id 碰撞会
  // 误探本地同名 id 服务商，远程态不显示（无头端 provider/test 不支持
  // comfyui，待补后再路由）
  const showProviderTest = isComfyui && hostKind === "local";

  /** comfyui 无模型行可挂测试：provider 级探测（/system_stats），结果
   *  展示口径与模型行测试一致（成功/错误码 toast） */
  const handleTestConnection = async () => {
    if (testingConnection) {
      return;
    }
    setTestingConnection(true);
    try {
      const result = await ProviderApi.test(provider.id);
      if (result.success) {
        toast.success(t("ai:model.testSuccess"));
      } else {
        toast.error(t(`ai:errors.${result.errorCode ?? "UNKNOWN"}`));
      }
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setTestingConnection(false);
    }
  };
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-2.5 rounded-lg border border-border/50 bg-card px-4 py-3">
        <span className="truncate text-sm font-semibold text-foreground">
          {provider.name}
        </span>
        <Badge variant="secondary">{provider.type}</Badge>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {provider.baseUrl}
        </span>
        <Switch
          checked={provider.enabled}
          onCheckedChange={onToggleEnabled}
          aria-label={t("ai:provider.enabled")}
        />
        <Button
          variant="outline"
          size="sm"
          className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          onClick={onEdit}
        >
          <Edit className="mr-1 h-3 w-3" />
          {t("ai:provider.editConnection")}
        </Button>
        <IconTooltip label={t("common:delete")}>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 hover:bg-primary-subtle hover:text-destructive"
            aria-label={t("common:delete")}
            onClick={onDelete}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </IconTooltip>
      </div>
      <div className="flex items-center gap-2.5">
        {showProviderTest && (
          <Button
            size="sm"
            onClick={handleTestConnection}
            disabled={testingConnection}
          >
            <Play className="mr-1 h-3 w-3" />
            {testingConnection
              ? t("ai:model.testing")
              : t("ai:provider.testConnection")}
          </Button>
        )}
        {!isComfyui && (
          <Button size="sm" onClick={onFetchRemote}>
            <RefreshCw className="mr-1 h-3 w-3" />
            {t("ai:model.fetchRemote")}
          </Button>
        )}
        <span className="text-xs text-muted-foreground">
          {isComfyui
            ? t("ai:provider.comfyNoModelList")
            : t("ai:model.fetchRemoteHint")}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
        {models.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/60 text-sm text-muted-foreground">
            <span>{t("ai:provider.emptyDetail")}</span>
            {!isComfyui && (
              <Button
                variant="outline"
                size="sm"
                onClick={onFetchRemote}
                className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
              >
                {t("ai:model.fetchRemote")}
              </Button>
            )}
          </div>
        ) : (
          <ModelList
            models={models}
            testingModelId={testingModelId}
            onToggle={onToggleModel}
            onTest={onTestModel}
            onEdit={onEditModel}
            onDelete={onDeleteModel}
            onAdd={onAddModel}
          />
        )}
      </div>
    </div>
  );
}
