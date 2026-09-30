/**
 * 助手编辑对话框（创建/编辑）
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
import { Textarea } from "@/components/ui/textarea";
import { parseOptionalInt, parseOptionalNumber } from "../../lib/parse-number";
import AssistantApi, { type AssistantRecord } from "../../api/assistant.api";
import { mapIpcError } from "../../chat/lib/error-message";
import { diffOptionalString, diffOptionalValue } from "../../lib/update-diff";

interface AssistantDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing?: AssistantRecord;
}

/** 标签输入解析：逗号分隔 → 去空白去空项的数组 */
function parseTagsInput(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/** 标签差量：与原值一致 undefined（不改），空数组 null（清空），否则新数组 */
function diffTagsInput(
  raw: string,
  original: string[] | undefined,
): string[] | null | undefined {
  const next = parseTagsInput(raw);
  const joined = next.join(",");
  if (joined === (original ?? []).join(",")) {
    return undefined;
  }
  return joined ? next : null;
}

export default function AssistantDialog({
  open,
  onOpenChange,
  editing,
}: AssistantDialogProps) {
  const { t } = useTranslation(["ai"]);
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [temperature, setTemperature] = useState("");
  const [topP, setTopP] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [description, setDescription] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName(editing?.name ?? "");
      setIcon(editing?.icon ?? "");
      setSystemPrompt(editing?.systemPrompt ?? "");
      setTemperature(
        editing?.temperature === undefined ? "" : String(editing.temperature),
      );
      setTopP(editing?.topP === undefined ? "" : String(editing.topP));
      setMaxTokens(
        editing?.maxTokens === undefined ? "" : String(editing.maxTokens),
      );
      setDescription(editing?.description ?? "");
      setTagsInput((editing?.tags ?? []).join(", "));
    }
  }, [open, editing]);

  const handleSubmit = async () => {
    if (!name.trim() || !systemPrompt.trim() || submitting) {
      return;
    }
    let params;
    try {
      params = {
        name: name.trim(),
        icon: icon.trim() || undefined,
        systemPrompt: systemPrompt.trim(),
        temperature: parseOptionalNumber(temperature),
        topP: parseOptionalNumber(topP),
        maxTokens: parseOptionalInt(maxTokens),
        description: description.trim() || undefined,
        tags: parseTagsInput(tagsInput),
      };
    } catch {
      toast.error(t("ai:model.invalidNumber"));
      return;
    }
    setSubmitting(true);
    try {
      if (editing) {
        // 编辑态差量提交：可空字段清除时传 null（undefined 会被 Prisma 跳过，旧值残留）
        await AssistantApi.update({
          id: editing.id,
          name: params.name,
          systemPrompt: params.systemPrompt,
          icon: diffOptionalString(icon, editing.icon),
          temperature: diffOptionalValue(
            params.temperature,
            editing.temperature,
          ),
          topP: diffOptionalValue(params.topP, editing.topP),
          maxTokens: diffOptionalValue(params.maxTokens, editing.maxTokens),
          description: diffOptionalString(description, editing.description),
          tags: diffTagsInput(tagsInput, editing.tags),
        });
      } else {
        await AssistantApi.create(params);
      }
      await queryClient.invalidateQueries({ queryKey: ["assistants"] });
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
            {editing ? editing.name : t("ai:assistant.add")}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-[1fr_100px] gap-3">
            <div className="space-y-1.5">
              <Label>{t("ai:assistant.name")}</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("ai:assistant.icon")}</Label>
              <Input
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                className="text-center"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>{t("ai:assistant.systemPrompt")}</Label>
            <Textarea
              rows={5}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("ai:assistant.description")}</Label>
            <Textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("ai:assistant.tags")}</Label>
            <Input
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {t("ai:model.optionalHint")}
          </p>
          <div className="grid grid-cols-3 gap-3">
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
