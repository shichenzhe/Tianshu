/**
 * 模型编辑对话框（创建/编辑）。批5（provider-model §6 项 3/5）：
 * llm 态增能力矩阵（vision/tools 开关）、输入输出单价（USD/1M）与
 * 备用模型选择（fallbackModelId——主模型失败切备选重试一次）。
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { parseOptionalInt, parseOptionalNumber } from "../../lib/parse-number";
import ModelApi, {
  MODEL_TYPES,
  modelDisplayName,
  type ModelCapabilities,
  type ModelRecord,
  type ModelType,
} from "../../api/model.api";
import { mapIpcError } from "../../chat/lib/error-message";
import { diffOptionalString, diffOptionalValue } from "../../lib/update-diff";
import TokenLimitField from "./token-limit-field";

/** 新建模型的默认 token 上限（输入 128K / 输出 64K，与预设 chips 对齐） */
const DEFAULT_CONTEXT_WINDOW = 131072;
const DEFAULT_MAX_TOKENS = 65536;
const CONTEXT_PRESETS = [32768, 65536, 131072, 262144];
const OUTPUT_PRESETS = [8192, 16384, 32768, 65536];
/** 备用模型「不启用」哨兵值（Select 空串项不渲染，用哨兵区分） */
const FALLBACK_NONE = "none";

interface ModelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerId: number;
  editing?: ModelRecord;
  /** 备用模型候选（全部 llm 模型，调用方排除本模型后传入） */
  fallbackOptions?: ModelRecord[];
}

export default function ModelDialog({
  open,
  onOpenChange,
  providerId,
  editing,
  fallbackOptions = [],
}: ModelDialogProps) {
  const { t } = useTranslation(["ai"]);
  const queryClient = useQueryClient();
  const [modelId, setModelId] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<ModelType>("llm");
  const [temperature, setTemperature] = useState("");
  const [topP, setTopP] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [contextWindow, setContextWindow] = useState("");
  const [vision, setVision] = useState(false);
  const [tools, setTools] = useState(false);
  const [priceIn, setPriceIn] = useState("");
  const [priceOut, setPriceOut] = useState("");
  const [fallbackModelId, setFallbackModelId] = useState(FALLBACK_NONE);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setModelId(editing?.modelId ?? "");
      setName(editing?.name ?? "");
      setType(editing?.type ?? "llm");
      setTemperature(
        editing?.temperature === undefined ? "" : String(editing.temperature),
      );
      setTopP(editing?.topP === undefined ? "" : String(editing.topP));
      setMaxTokens(String(editing?.maxTokens ?? DEFAULT_MAX_TOKENS));
      setContextWindow(
        String(editing?.contextWindow ?? DEFAULT_CONTEXT_WINDOW),
      );
      setVision(editing?.capabilities?.vision ?? false);
      setTools(editing?.capabilities?.tools ?? false);
      setPriceIn(
        editing?.priceInPerMTokens === undefined
          ? ""
          : String(editing.priceInPerMTokens),
      );
      setPriceOut(
        editing?.priceOutPerMTokens === undefined
          ? ""
          : String(editing.priceOutPerMTokens),
      );
      setFallbackModelId(
        editing?.fallbackModelId != null
          ? String(editing.fallbackModelId)
          : FALLBACK_NONE,
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
    let parsed;
    try {
      parsed = {
        temperature: parseOptionalNumber(temperature),
        topP: parseOptionalNumber(topP),
        maxTokens: parseOptionalInt(maxTokens),
        contextWindow: parseOptionalInt(contextWindow),
        priceInPerMTokens: parseOptionalNumber(priceIn),
        priceOutPerMTokens: parseOptionalNumber(priceOut),
      };
    } catch {
      toast.error(t("ai:model.invalidNumber"));
      return;
    }
    if (
      (parsed.maxTokens !== undefined && parsed.maxTokens <= 0) ||
      (parsed.contextWindow !== undefined && parsed.contextWindow <= 0)
    ) {
      toast.error(t("ai:model.positiveIntRequired"));
      return;
    }
    if (
      (parsed.priceInPerMTokens !== undefined &&
        parsed.priceInPerMTokens < 0) ||
      (parsed.priceOutPerMTokens !== undefined && parsed.priceOutPerMTokens < 0)
    ) {
      // 单价为 step 0.01 的浮点（USD/1M），负值提示用「正数」而非「正整数」
      toast.error(t("ai:model.positiveNumberRequired"));
      return;
    }
    // 能力矩阵：两开关全关 = 无能力标注（null 清除语义由差量承载）
    const capabilities: ModelCapabilities | undefined =
      vision || tools ? { vision, tools } : undefined;
    const pickedFallbackId =
      fallbackModelId === FALLBACK_NONE ? undefined : Number(fallbackModelId);
    setSubmitting(true);
    try {
      if (editing) {
        // 编辑态差量提交：可空字段清除时传 null（undefined 会被 Prisma 跳过，旧值残留）
        await ModelApi.update({
          id: editing.id,
          modelId: modelId.trim(),
          name: diffOptionalString(name, editing.name),
          type,
          temperature: diffOptionalValue(
            parsed.temperature,
            editing.temperature,
          ),
          topP: diffOptionalValue(parsed.topP, editing.topP),
          maxTokens: diffOptionalValue(parsed.maxTokens, editing.maxTokens),
          contextWindow: diffOptionalValue(
            parsed.contextWindow,
            editing.contextWindow,
          ),
          capabilities: diffCapabilities(capabilities, editing.capabilities),
          priceInPerMTokens: diffOptionalValue(
            parsed.priceInPerMTokens,
            editing.priceInPerMTokens,
          ),
          priceOutPerMTokens: diffOptionalValue(
            parsed.priceOutPerMTokens,
            editing.priceOutPerMTokens,
          ),
          fallbackModelId: diffOptionalValue(
            pickedFallbackId,
            editing.fallbackModelId,
          ),
        });
      } else {
        await ModelApi.create({
          providerId,
          type,
          modelId: modelId.trim(),
          name: name.trim() || undefined,
          temperature: parsed.temperature,
          topP: parsed.topP,
          maxTokens: parsed.maxTokens,
          contextWindow: parsed.contextWindow,
          ...(capabilities ? { capabilities } : {}),
          ...(parsed.priceInPerMTokens !== undefined
            ? { priceInPerMTokens: parsed.priceInPerMTokens }
            : {}),
          ...(parsed.priceOutPerMTokens !== undefined
            ? { priceOutPerMTokens: parsed.priceOutPerMTokens }
            : {}),
          ...(pickedFallbackId !== undefined
            ? { fallbackModelId: pickedFallbackId }
            : {}),
        });
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
          <div className="space-y-1.5">
            <Label>{t("ai:model.typeLabel")}</Label>
            <Select
              value={type}
              onValueChange={(value) => setType(value as ModelType)}
            >
              <SelectTrigger
                aria-label={t("ai:model.typeLabel")}
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border border-border/50 rounded-lg shadow-lg">
                {MODEL_TYPES.map((item) => (
                  <SelectItem key={item} value={item}>
                    {t(`ai:model.type.${item}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("ai:model.optionalHint")}
          </p>
          {type === "llm" && (
            <>
              <div className="grid grid-cols-2 gap-3">
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
              </div>
              <div className="flex items-center gap-5 rounded-lg border border-border/50 px-3 py-2.5">
                <span className="text-xs text-muted-foreground">
                  {t("ai:model.capabilitiesLabel")}
                </span>
                <label className="flex items-center gap-1.5 text-xs text-foreground">
                  <Switch
                    checked={vision}
                    onCheckedChange={setVision}
                    aria-label={t("ai:model.vision")}
                  />
                  {t("ai:model.vision")}
                </label>
                <label className="flex items-center gap-1.5 text-xs text-foreground">
                  <Switch
                    checked={tools}
                    onCheckedChange={setTools}
                    aria-label={t("ai:model.toolsAbility")}
                  />
                  {t("ai:model.toolsAbility")}
                </label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>{t("ai:model.priceIn")}</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={priceIn}
                    aria-label={t("ai:model.priceIn")}
                    onChange={(e) => setPriceIn(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>{t("ai:model.priceOut")}</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={priceOut}
                    aria-label={t("ai:model.priceOut")}
                    onChange={(e) => setPriceOut(e.target.value)}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("ai:model.priceHint")}
              </p>
              <div className="space-y-1.5">
                <Label>{t("ai:model.fallbackModel")}</Label>
                <Select
                  value={fallbackModelId}
                  onValueChange={setFallbackModelId}
                >
                  <SelectTrigger
                    aria-label={t("ai:model.fallbackModel")}
                    className="w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border border-border/50 rounded-lg shadow-lg">
                    <SelectItem value={FALLBACK_NONE}>
                      {t("ai:model.fallbackNone")}
                    </SelectItem>
                    {fallbackOptions.map((option) => (
                      <SelectItem key={option.id} value={String(option.id)}>
                        {modelDisplayName(option)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t("ai:model.fallbackHint")}
                </p>
              </div>
            </>
          )}
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

/** 能力矩阵差量：与原值等价 undefined；由有到无 null（清除）；有变更新值 */
function diffCapabilities(
  next: ModelCapabilities | undefined,
  original: ModelCapabilities | undefined,
): ModelCapabilities | null | undefined {
  const nextVision = next?.vision ?? false;
  const nextTools = next?.tools ?? false;
  const originalVision = original?.vision ?? false;
  const originalTools = original?.tools ?? false;
  if (nextVision === originalVision && nextTools === originalTools) {
    return undefined;
  }
  return nextVision || nextTools
    ? { vision: nextVision, tools: nextTools }
    : null;
}
