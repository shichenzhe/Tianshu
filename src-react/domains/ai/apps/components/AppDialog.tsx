/**
 * 应用编辑弹窗（新增/编辑共用）：名称/描述 + 工作流勾选清单（graphIds
 * 集合编辑面）。勾选清单来自 orchestration:list 全量工作流；保存时序列化
 * 为 JSON 数组字符串（与 repo parseGraphIds 对齐）。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Workflow } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import AppApi, { type AppRecord } from "../../api/app.api";
import { GraphApi } from "../../orchestration/api/orchestration.api";
import { mapIpcError } from "../../chat/lib/error-message";

const GRAPHS_KEY = ["graphs"] as const;

interface AppDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 编辑目标（缺省 = 新增） */
  editing?: AppRecord;
  onSaved: () => void;
}

export default function AppDialog({
  open,
  onOpenChange,
  editing,
  onSaved,
}: AppDialogProps) {
  const { t } = useTranslation(["ai", "common"]);
  const graphsQuery = useQuery({
    queryKey: GRAPHS_KEY,
    queryFn: () => GraphApi.list(),
    enabled: open,
  });
  const graphs = graphsQuery.data ?? [];

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setName(editing?.name ?? "");
    setDescription(editing?.description ?? "");
    setSelected(new Set(editing?.graphIds ?? []));
  }, [open, editing]);

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

  const handleSave = async () => {
    if (saving) {
      return;
    }
    setSaving(true);
    try {
      const graphIds = JSON.stringify([...selected]);
      if (editing) {
        await AppApi.update({ id: editing.id, name, description, graphIds });
      } else {
        await AppApi.create({ name, description, graphIds });
      }
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border border-border/50 rounded-lg shadow-lg">
        <DialogHeader>
          <DialogTitle>
            {editing ? t("ai:app.editTitle") : t("ai:app.addTitle")}
          </DialogTitle>
          <DialogDescription>{t("ai:app.formTip")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-1">
          <div className="grid gap-1.5">
            <Label htmlFor="app-name">{t("ai:app.name")}</Label>
            <Input
              id="app-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="app-desc">{t("ai:app.description")}</Label>
            <Input
              id="app-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>{t("ai:app.workflows")}</Label>
            <div className="max-h-56 overflow-y-auto rounded-md border border-border/50 p-1">
              {graphsQuery.isPending ? (
                <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                  {t("common:loading")}
                </p>
              ) : graphs.length === 0 ? (
                <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                  {t("ai:app.noWorkflows")}
                </p>
              ) : (
                graphs.map((graph) => (
                  <label
                    key={graph.id}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-primary-subtle/60"
                  >
                    <Checkbox
                      checked={selected.has(graph.id)}
                      onCheckedChange={() => toggle(graph.id)}
                    />
                    <Workflow className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {graph.name}
                    </span>
                  </label>
                ))
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("ai:app.selectedCount", { count: selected.size })}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common:cancel")}
          </Button>
          <Button
            onClick={() => void handleSave()}
            disabled={saving || name.trim() === ""}
          >
            {t("common:confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
