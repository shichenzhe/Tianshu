/**
 * 从服务商拉取远端模型列表并勾选导入（四协议通用）：
 * 已导入项置灰排末尾且不参与勾选/全选；拉取失败展示错误码 + 原始信息并可重试
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import ModelApi from "../../api/model.api";
import type { RemoteModel } from "../../api/model.api";
import type { ProviderRecord } from "../../api/provider.api";
import { guessModelType } from "../lib/model-type-guess";
import { mapIpcError } from "../../chat/lib/error-message";

interface RemoteModelImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ProviderRecord | null;
  /** 该服务商已导入的 modelId 集合（置灰排末尾，不参与勾选与全选） */
  existingModelIds: string[];
}

export default function RemoteModelImportDialog({
  open,
  onOpenChange,
  provider,
  existingModelIds,
}: RemoteModelImportDialogProps) {
  const { t } = useTranslation(["ai", "common"]);
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [query, setQuery] = useState("");

  const remoteQuery = useQuery({
    queryKey: ["remote-models", provider?.id],
    // enabled 已保证 provider 非空
    queryFn: () => ModelApi.listRemote(provider!.id),
    enabled: open && provider !== null,
  });

  // 打开或切换服务商时清空勾选与搜索词
  useEffect(() => {
    if (open) {
      setSelected(new Set());
      setQuery("");
    }
  }, [open, provider]);

  const existing = useMemo(() => new Set(existingModelIds), [existingModelIds]);

  // 去重后已导入排末尾（稳定排序保持拉取原始顺序）
  const models = useMemo(() => {
    const remote = remoteQuery.data;
    if (!remote?.success) {
      return [];
    }
    const seen = new Set<string>();
    const unique = remote.models.filter((m) => {
      if (seen.has(m.modelId)) {
        return false;
      }
      seen.add(m.modelId);
      return true;
    });
    return [...unique].sort(
      (a, b) =>
        Number(existing.has(a.modelId)) - Number(existing.has(b.modelId)),
    );
  }, [remoteQuery.data, existing]);

  // 模型名/归属方大小写不敏感子串过滤（纯前端，不动 useQuery）
  const filteredModels = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) {
      return models;
    }
    return models.filter(
      (m) =>
        m.modelId.toLowerCase().includes(keyword) ||
        (m.ownedBy?.toLowerCase().includes(keyword) ?? false),
    );
  }, [models, query]);

  const importableIds = useMemo(
    () => models.filter((m) => !existing.has(m.modelId)).map((m) => m.modelId),
    [models, existing],
  );
  const allSelected =
    importableIds.length > 0 &&
    importableIds.every((modelId) => selected.has(modelId));

  if (!provider) {
    return null;
  }

  const toggle = (modelId: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(modelId);
      } else {
        next.delete(modelId);
      }
      return next;
    });
  };

  const toggleAll = (checked: boolean) => {
    setSelected(checked ? new Set(importableIds) : new Set());
  };

  const handleImport = async () => {
    if (selected.size === 0 || importing) {
      return;
    }
    setImporting(true);
    try {
      // 类型按名称启发式预填（llm 默认），导入后可在编辑对话框手改
      for (const modelId of selected) {
        await ModelApi.create({
          providerId: provider.id,
          modelId,
          type: guessModelType(modelId),
        });
      }
      await queryClient.invalidateQueries({ queryKey: ["models"] });
      toast.success(t("ai:model.importSuccess"));
      onOpenChange(false);
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setImporting(false);
    }
  };

  const remote = remoteQuery.data;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border border-border/50 rounded-lg shadow-lg sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("ai:model.importTitle", { name: provider.name })}
          </DialogTitle>
        </DialogHeader>
        {remoteQuery.isPending ? (
          <p className="text-sm text-muted-foreground">{t("common:loading")}</p>
        ) : remoteQuery.isError ? (
          <FetchErrorState
            message={
              remoteQuery.error instanceof Error
                ? remoteQuery.error.message
                : t("ai:errors.UNKNOWN")
            }
            onRetry={() => void remoteQuery.refetch()}
          />
        ) : !remote?.success ? (
          <FetchErrorState
            message={t(`ai:errors.${remote?.errorCode ?? "UNKNOWN"}`)}
            detail={remote?.message}
            onRetry={() => void remoteQuery.refetch()}
          />
        ) : models.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("ai:model.fetchEmpty")}
          </p>
        ) : (
          <>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("ai:model.searchPlaceholder")}
              className="mb-2"
            />
            <div className="flex items-center gap-2 border-b border-border/50 pb-2">
              <Checkbox
                id="remote-model-select-all"
                checked={allSelected}
                onCheckedChange={(checked) => toggleAll(checked === true)}
              />
              <Label
                htmlFor="remote-model-select-all"
                className="cursor-pointer text-sm text-muted-foreground"
              >
                {t("ai:model.selectAll")}
              </Label>
            </div>
            {filteredModels.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("ai:model.searchEmpty")}
              </p>
            ) : (
              <ul className="max-h-72 space-y-2 overflow-auto">
                {filteredModels.map((model) => (
                  <RemoteModelRow
                    key={model.modelId}
                    model={model}
                    imported={existing.has(model.modelId)}
                    checked={selected.has(model.modelId)}
                    onToggle={toggle}
                  />
                ))}
              </ul>
            )}
          </>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common:cancel")}
          </Button>
          <Button
            onClick={handleImport}
            disabled={importing || selected.size === 0}
          >
            {importing ? (
              t("common:submitting")
            ) : (
              // 两节点：key 译文 + 计数（key 值本身不含 count 插值）
              <>
                {t("ai:model.importSelected")} · {selected.size}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 单行远端模型：已导入置灰禁用并带标签，未导入 Label 关联复选框可勾选；
 *  非 llm 识别结果显示类型徽章 */
function RemoteModelRow({
  model,
  imported,
  checked,
  onToggle,
}: {
  model: RemoteModel;
  imported: boolean;
  checked: boolean;
  onToggle: (modelId: string, checked: boolean) => void;
}) {
  const { t } = useTranslation(["ai"]);
  const guessed = guessModelType(model.modelId);

  return (
    <li className={`flex items-center gap-2 ${imported ? "opacity-50" : ""}`}>
      <Checkbox
        id={`remote-model-${model.modelId}`}
        checked={checked}
        disabled={imported}
        onCheckedChange={(checked) => onToggle(model.modelId, checked === true)}
      />
      {imported ? (
        <span className="font-mono text-sm">{model.modelId}</span>
      ) : (
        <Label
          htmlFor={`remote-model-${model.modelId}`}
          className="cursor-pointer font-mono text-sm"
        >
          {model.modelId}
        </Label>
      )}
      {guessed !== "llm" && (
        <Badge variant="secondary" className="text-[10px]">
          {t(`ai:model.type.${guessed}`)}
        </Badge>
      )}
      {imported && (
        <span className="ml-auto text-xs text-muted-foreground">
          {t("ai:model.imported")}
        </span>
      )}
    </li>
  );
}

/** 拉取错误态：错误文案 + 原始信息小字 + 重试按钮 */
function FetchErrorState({
  message,
  detail,
  onRetry,
}: {
  message: string;
  detail?: string;
  onRetry: () => void;
}) {
  const { t } = useTranslation(["ai"]);

  return (
    <div className="space-y-2">
      <p className="text-sm text-destructive">{message}</p>
      {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
      <Button
        size="sm"
        variant="outline"
        className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
        onClick={onRetry}
      >
        {t("ai:model.retry")}
      </Button>
    </div>
  );
}
