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
      setMaxTokens(
        editing?.maxTokens === undefined ? "" : String(editing.maxTokens),
      );
      setContextWindow(
        editing?.contextWindow === undefined
          ? ""
          : String(editing.contextWindow),
      );
    }
  }, [open, editing]);

  const handleSubmit = async () => {
    if (!modelId.trim() || submitting) {
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
            <div className="space-y-1.5">
              <Label>{t("ai:model.maxTokens")}</Label>
              <Input
                type="number"
                step="1"
                min="1"
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("ai:model.contextWindow")}</Label>
              <Input
                type="number"
                step="1"
                min="1"
                value={contextWindow}
                onChange={(e) => setContextWindow(e.target.value)}
              />
            </div>
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
