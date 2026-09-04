/**
 * 服务商编辑对话框（创建/编辑）
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
import { Textarea } from "@/components/ui/textarea";
import ProviderApi, {
  PROVIDER_TYPES,
  type ProviderRecord,
  type ProviderType,
} from "../../api/provider.api";
import { PROVIDER_PRESETS } from "../model/presets";
import { mapIpcError } from "../../chat/lib/error-message";
import { diffOptionalString } from "../../lib/update-diff";

interface ProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing?: ProviderRecord;
}

export default function ProviderDialog({
  open,
  onOpenChange,
  editing,
}: ProviderDialogProps) {
  const { t } = useTranslation(["ai"]);
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [type, setType] = useState<ProviderType>("openai-compatible");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [extraHeaders, setExtraHeaders] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [preset, setPreset] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName(editing?.name ?? "");
      setType(editing?.type ?? "openai-compatible");
      setBaseUrl(editing?.baseUrl ?? "");
      setApiKey(editing?.apiKey ?? "");
      setExtraHeaders(editing?.extraHeaders ?? "");
      setEnabled(editing?.enabled ?? true);
      setPreset(null);
    }
  }, [open, editing]);

  const handleSubmit = async () => {
    if (!name.trim() || !baseUrl.trim() || submitting) {
      return;
    }
    if (extraHeaders.trim()) {
      try {
        JSON.parse(extraHeaders);
      } catch {
        toast.error(t("ai:provider.extraHeadersInvalid"));
        return;
      }
    }
    setSubmitting(true);
    try {
      const shared = {
        name: name.trim(),
        type,
        baseUrl: baseUrl.trim(),
        enabled,
      };
      if (editing) {
        // 编辑态差量提交：可空字段清除时传 null（undefined 会被 Prisma 跳过，旧值残留）
        await ProviderApi.update({
          id: editing.id,
          ...shared,
          apiKey: diffOptionalString(apiKey, editing.apiKey),
          extraHeaders: diffOptionalString(extraHeaders, editing.extraHeaders),
        });
      } else {
        await ProviderApi.create({
          ...shared,
          apiKey: apiKey.trim() || undefined,
          extraHeaders: extraHeaders.trim() || undefined,
        });
      }
      await queryClient.invalidateQueries({ queryKey: ["providers"] });
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
            {editing ? editing.name : t("ai:provider.add")}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {!editing && (
            <div className="space-y-1.5">
              <Label>{t("ai:provider.presetLabel")}</Label>
              <Select
                value={preset ?? undefined}
                onValueChange={(value) => {
                  const found = PROVIDER_PRESETS.find((p) => p.label === value);
                  if (found) {
                    setName(found.label);
                    setType(found.type);
                    setBaseUrl(found.baseUrl);
                  }
                  setPreset(null);
                }}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={t("ai:provider.presetPlaceholder")}
                  />
                </SelectTrigger>
                <SelectContent className="border border-border/50 rounded-lg shadow-lg">
                  {PROVIDER_PRESETS.map((p) => (
                    <SelectItem key={p.label} value={p.label}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t("ai:provider.presetHint")}
              </p>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>{t("ai:provider.name")}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("ai:provider.type")}</Label>
            <Select
              value={type}
              onValueChange={(v) => setType(v as ProviderType)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border border-border/50 rounded-lg shadow-lg">
                {PROVIDER_TYPES.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t("ai:provider.baseUrl")}</Label>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={t(`ai:provider.typePlaceholders.${type}`)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("ai:provider.apiKey")}</Label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("ai:provider.extraHeaders")}</Label>
            <Textarea
              rows={3}
              value={extraHeaders}
              onChange={(e) => setExtraHeaders(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={enabled} onCheckedChange={setEnabled} />
            <Label>{t("ai:provider.enabled")}</Label>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? t("common:ok") : t("common:confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
