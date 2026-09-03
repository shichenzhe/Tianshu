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
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName(editing?.name ?? "");
      setType(editing?.type ?? "openai-compatible");
      setBaseUrl(editing?.baseUrl ?? "");
      setApiKey(editing?.apiKey ?? "");
      setExtraHeaders(editing?.extraHeaders ?? "");
      setEnabled(editing?.enabled ?? true);
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
        apiKey: apiKey.trim() || undefined,
        extraHeaders: extraHeaders.trim() || undefined,
        enabled,
      };
      if (editing) {
        await ProviderApi.update({ id: editing.id, ...shared });
      } else {
        await ProviderApi.create(shared);
      }
      await queryClient.invalidateQueries({ queryKey: ["providers"] });
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
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
