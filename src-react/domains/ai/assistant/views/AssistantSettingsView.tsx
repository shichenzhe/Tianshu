/**
 * 助手预设管理：卡片网格 + 新建/编辑/删除
 * 内置助手可编辑（修改名称/提示词/参数），仅删除受限（UI 隐藏 + 后端兜底）
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Bot, Edit, Plus, Trash2 } from "lucide-react";

import PageTitle from "@/components/layout/PageTitle";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import AssistantApi, { type AssistantRecord } from "../../api/assistant.api";
import AssistantDialog from "../components/AssistantDialog";

const ASSISTANTS_KEY = ["assistants"] as const;

export default function AssistantSettingsView() {
  const { t } = useTranslation(["ai", "common"]);
  const queryClient = useQueryClient();

  const assistantsQuery = useQuery({
    queryKey: ASSISTANTS_KEY,
    queryFn: () => AssistantApi.list(),
  });
  const assistants = assistantsQuery.data ?? [];

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AssistantRecord>();
  const [deleting, setDeleting] = useState<AssistantRecord | null>(null);

  const openCreate = () => {
    setEditing(undefined);
    setDialogOpen(true);
  };

  const openEdit = (assistant: AssistantRecord) => {
    setEditing(assistant);
    setDialogOpen(true);
  };

  const handleDelete = async () => {
    if (!deleting) {
      return;
    }
    try {
      await AssistantApi.delete(deleting.id);
      await queryClient.invalidateQueries({ queryKey: ASSISTANTS_KEY });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="p-6">
      <PageTitle title={t("ai:assistant.pageTitle")} />
      <p className="mb-4 text-sm text-muted-foreground">
        {t("ai:assistant.pageDesc")}
      </p>

      {assistantsQuery.isPending ? (
        <p className="py-16 text-center text-sm text-muted-foreground">
          {t("common:loading")}
        </p>
      ) : assistantsQuery.isError ? (
        <p className="py-16 text-center text-sm text-destructive">
          {assistantsQuery.error instanceof Error
            ? assistantsQuery.error.message
            : t("ai:errors.UNKNOWN")}
        </p>
      ) : assistants.length === 0 ? (
        <Card className="border-border/50 rounded-lg shadow-sm">
          <CardHeader>
            <CardTitle>{t("ai:assistant.empty")}</CardTitle>
            <CardDescription>{t("ai:assistant.emptyTip")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={openCreate}>
              <Plus className="mr-1 h-4 w-4" />
              {t("ai:assistant.add")}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="mb-4">
            <Button onClick={openCreate} size="sm">
              <Plus className="mr-1 h-4 w-4" />
              {t("ai:assistant.add")}
            </Button>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {assistants.map((assistant) => (
              <AssistantCard
                key={assistant.id}
                assistant={assistant}
                onEdit={() => openEdit(assistant)}
                onDelete={() => setDeleting(assistant)}
              />
            ))}
          </div>
        </>
      )}

      <AssistantDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
      />

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null);
          }
        }}
      >
        <AlertDialogContent className="border border-border/50 rounded-lg shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("ai:assistant.deleteConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleting
                ? `${deleting.name} · ${t("ai:assistant.deleteConfirmDesc")}`
                : t("ai:assistant.deleteConfirmDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>
              {t("common:confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface AssistantCardProps {
  assistant: AssistantRecord;
  onEdit: () => void;
  onDelete: () => void;
}

function AssistantCard({ assistant, onEdit, onDelete }: AssistantCardProps) {
  const { t } = useTranslation(["ai", "common"]);

  return (
    <Card className="flex flex-col border-border/50 rounded-lg shadow-sm">
      <CardHeader>
        <div className="flex items-center gap-2">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-subtle text-2xl leading-none">
            {assistant.icon ? (
              assistant.icon
            ) : (
              <Bot className="h-5 w-5 text-primary" />
            )}
          </span>
          <CardTitle className="min-w-0 flex-1 truncate text-base">
            {assistant.name}
          </CardTitle>
          {assistant.builtin && (
            <Badge variant="secondary" className="shrink-0">
              {t("ai:assistant.builtin")}
            </Badge>
          )}
        </div>
        <CardDescription className="line-clamp-2 min-h-10">
          {assistant.systemPrompt}
        </CardDescription>
      </CardHeader>
      <CardContent className="mt-auto flex items-center justify-end gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 hover:bg-primary-subtle hover:text-primary"
          onClick={onEdit}
          aria-label={t("common:edit")}
        >
          <Edit className="h-3 w-3" />
        </Button>
        {!assistant.builtin && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 hover:bg-primary-subtle hover:text-destructive"
            onClick={onDelete}
            aria-label={t("common:delete")}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
