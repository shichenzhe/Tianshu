/**
 * 从 Ollama 实例导入已安装模型（勾选后批量创建）
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
import { mapIpcError } from "../../chat/lib/error-message";

interface OllamaImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerId: number;
}

export default function OllamaImportDialog({
  open,
  onOpenChange,
  providerId,
}: OllamaImportDialogProps) {
  const { t } = useTranslation(["ai"]);
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);

  const remoteQuery = useQuery({
    queryKey: ["ollama-models", providerId],
    queryFn: () => ModelApi.listOllama(providerId),
    enabled: open,
  });

  useEffect(() => {
    if (open) {
      setSelected(new Set());
    }
  }, [open, providerId]);

  const remoteModelIds = remoteQuery.data
    ? Array.from(new Set(remoteQuery.data.map((m) => m.modelId)))
    : [];

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

  const handleImport = async () => {
    if (selected.size === 0 || importing) {
      return;
    }
    setImporting(true);
    try {
      for (const modelId of selected) {
        await ModelApi.create({ providerId, modelId });
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border border-border/50 rounded-lg shadow-lg sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("ai:model.importOllama")}</DialogTitle>
        </DialogHeader>
        <div className="max-h-72 space-y-2 overflow-auto">
          {remoteQuery.isPending ? (
            <p className="text-sm text-muted-foreground">
              {t("common:loading")}
            </p>
          ) : remoteQuery.isError ? (
            <p className="text-sm text-destructive">
              {remoteQuery.error instanceof Error
                ? remoteQuery.error.message
                : t("ai:errors.UNKNOWN")}
            </p>
          ) : remoteModelIds.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("ai:model.ollamaEmpty")}
            </p>
          ) : (
            remoteModelIds.map((modelId) => (
              <div key={modelId} className="flex items-center gap-2">
                <Checkbox
                  id={`ollama-model-${modelId}`}
                  checked={selected.has(modelId)}
                  onCheckedChange={(checked) =>
                    toggle(modelId, checked === true)
                  }
                />
                <Label
                  htmlFor={`ollama-model-${modelId}`}
                  className="cursor-pointer font-mono text-sm"
                >
                  {modelId}
                </Label>
              </div>
            ))
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common:cancel")}
          </Button>
          <Button
            onClick={handleImport}
            disabled={importing || selected.size === 0}
          >
            {importing ? t("common:submitting") : t("ai:model.importSelected")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
