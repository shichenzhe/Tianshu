/**
 * 模型编辑对话框（创建/编辑）
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parseOptionalInt, parseOptionalNumber } from "../../lib/parse-number";
import ModelApi, { type ModelRecord } from "../../api/model.api";
import { mapIpcError } from "../../chat/lib/error-message";
import { diffOptionalString, diffOptionalValue } from "../../lib/update-diff";
import TokenLimitField from "./token-limit-field";

/** 新建模型的默认 token 上限（输入 128K / 输出 64K，与预设 chips 对齐） */
const DEFAULT_CONTEXT_WINDOW = 131072;
const DEFAULT_MAX_TOKENS = 65536;
const CONTEXT_PRESETS = [32768, 65536, 131072, 262144];
const OUTPUT_PRESETS = [8192, 16384, 32768, 65536];

interface ModelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerId: number;
  editing?: ModelRecord;
}

export default function ModelDialog({
  open,
  onOpenChange,
  providerId,
  editing,
}: ModelDialogProps) {
  const { t } = useTranslation(["ai"]);
  const queryClient = useQueryClient();
  const [modelId, setModelId] = useState("");
  const [name, setName] = useState("");
  const [temperature, setTemperature] = useState("");
  const [topP, setTopP] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [contextWindow, setContextWindow] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setModelId(editing?.modelId ?? "");
      setName(editing?.name ?? "");
      setTemperature(
        editing?.temperature === undefined ? "" : String(editing.temperature),
      );
      setTopP(editing?.topP === undefined ? "" : String(editing.topP));
      setMaxTokens(String(editing?.maxTokens ?? DEFAULT_MAX_TOKENS));
      setContextWindow(
        String(editing?.contextWindow ?? DEFAULT_CONTEXT_WINDOW),
      );
    }
  }, [open, editing]);

  // 联动校验：输出达到或超过输入窗口时，输出空间会挤占全部上下文
  const exceedsLimit =
    maxTokens.trim() !== "" &&
    contextWindow.trim() !== "" &&
    Number(maxTokens) >= Number(contextWindow);

  const handleSubmit = async () => {
    if (!modelId.trim() || submitting) {
      return;
    }
    if (exceedsLimit) {
      toast.error(t("ai:model.exceedsContext"));
      return;
    }
    let params;
    try {
      params = {
        modelId: modelId.trim(),
        name: name.trim() || undefined,
        temperature: parseOptionalNumber(temperature),
        topP: parseOptionalNumber(topP),
        maxTokens: parseOptionalInt(maxTokens),
        contextWindow: parseOptionalInt(contextWindow),
      };
    } catch {
      toast.error(t("ai:model.invalidNumber"));
      return;
    }
    if (
      (params.maxTokens !== undefined && params.maxTokens <= 0) ||
      (params.contextWindow !== undefined && params.contextWindow <= 0)
    ) {
      toast.error(t("ai:model.positiveIntRequired"));
      return;
    }
    setSubmitting(true);
    try {
      if (editing) {
        // 编辑态差量提交：可空字段清除时传 null（undefined 会被 Prisma 跳过，旧值残留）
        await ModelApi.update({
          id: editing.id,
          modelId: params.modelId,
          name: diffOptionalString(name, editing.name),
          temperature: diffOptionalValue(
            params.temperature,
            editing.temperature,
          ),
          topP: diffOptionalValue(params.topP, editing.topP),
          maxTokens: diffOptionalValue(params.maxTokens, editing.maxTokens),
          contextWindow: diffOptionalValue(
            params.contextWindow,
            editing.contextWindow,
          ),
        });
      } else {
        await ModelApi.create({ providerId, ...params });
      }
      await queryClient.invalidateQueries({ queryKey: ["models"] });
      onOpenChange(false);
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border border-border/50 rounded-lg shadow-lg sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {editing ? editing.modelId : t("ai:model.add")}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t("ai:model.modelId")}</Label>
            <Input
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              className="font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("ai:model.displayName")}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <p className="text-xs text-muted-foreground">
            {t("ai:model.optionalHint")}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("ai:model.temperature")}</Label>
              <Input
                type="number"
                step="0.1"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("ai:model.topP")}</Label>
              <Input
                type="number"
                step="0.1"
                value={topP}
                onChange={(e) => setTopP(e.target.value)}
              />
            </div>
            <TokenLimitField
              label={t("ai:model.inputLimit")}
              value={contextWindow}
              presets={CONTEXT_PRESETS}
              onChange={setContextWindow}
            />
            <TokenLimitField
              label={t("ai:model.outputLimit")}
              value={maxTokens}
              presets={OUTPUT_PRESETS}
              onChange={setMaxTokens}
              error={exceedsLimit}
              hint={exceedsLimit ? t("ai:model.exceedsContext") : undefined}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common:cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? t("common:saving") : t("common:confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
