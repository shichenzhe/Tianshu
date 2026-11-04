/**
 * 项目指令编辑弹窗：Textarea 回填 systemPrompt → 保存走
 * ProjectApi.update（空串即清空指令）→ toast(saved) + invalidate
 * ["project", id]（详情刷新后只读区与新会话提示词随之更新）。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import ProjectApi from "../api/project.api";
import type { ProjectRecord } from "../../../../electron/domains/project/project.entity";

interface InstructionEditDialogProps {
  project: ProjectRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function InstructionEditDialog({
  project,
  open,
  onOpenChange,
}: InstructionEditDialogProps) {
  const { t } = useTranslation(["project", "common"]);
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState(project.systemPrompt ?? "");
  const [saving, setSaving] = useState(false);

  // 打开（或 invalidate 后 systemPrompt 变化）时回填最新指令
  useEffect(() => {
    if (open) {
      setPrompt(project.systemPrompt ?? "");
      setSaving(false);
    }
  }, [open, project.systemPrompt]);

  const handleSave = async () => {
    if (saving) {
      return;
    }
    setSaving(true);
    try {
      await ProjectApi.update({
        id: project.id,
        systemPrompt: prompt.trim(),
      });
      await queryClient.invalidateQueries({
        queryKey: ["project", project.id],
      });
      toast.success(t("project:toast.saved"));
      onOpenChange(false);
    } catch {
      toast.error(t("project:toast.operationFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="rounded-lg border-border/50 shadow-lg sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>{t("project:panel.editInstruction")}</DialogTitle>
        </DialogHeader>
        <Textarea
          rows={8}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={t("project:create.promptPlaceholder")}
          aria-label={t("project:panel.instruction")}
        />
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
          >
            {t("common:cancel")}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {t("project:panel.saveInstruction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
