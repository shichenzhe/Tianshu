/**
 * 我的专家：非空=管理网格（编辑/删除/开对话）+创建入口；
 * 空=PRD 引导页（返回全部专家/插画/主副标题/创建按钮/去市场）。
 * 创建流复用「创建技能」预填桥：新会话+预填模板→跳聊天页
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft,
  Bot,
  Edit,
  GraduationCap,
  MessageSquare,
  Plus,
  Trash2,
} from "lucide-react";

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
import SessionApi from "../../api/session.api";
import { WorkspaceApi } from "../../api/workspace.api";
import { mapIpcError } from "../../chat/lib/error-message";
import { useCreateSkillPromptStore } from "../../skills/store/create-skill.store";
import AssistantDialog from "../../assistant/components/AssistantDialog";

const ASSISTANTS_KEY = ["assistants"] as const;

export default function MyExpertsView({
  onBack,
  onBrowseMarket,
}: {
  onBack: () => void;
  onBrowseMarket: () => void;
}) {
  const { t } = useTranslation(["ai", "chat", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setPendingPrompt = useCreateSkillPromptStore(
    (s) => s.setPendingPrompt,
  );
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

  /** 对话式创建：新开会话+预填模板→跳聊天页（同创建技能流） */
  const handleChatCreate = async () => {
    try {
      const workspaces = await queryClient.ensureQueryData({
        queryKey: ["workspaces"],
        queryFn: () => WorkspaceApi.list(),
      });
      const workspaceId = workspaces[0]?.id;
      if (workspaceId === undefined) {
        toast.info(t("chat:skills.comingSoon"));
        return;
      }
      const created = await SessionApi.create({ workspaceId });
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      setPendingPrompt(t("chat:experts.createPrompt"));
      navigate(`/module/ai?session=${created.id}`);
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  /** 开对话：新会话绑定该专家直达聊天页 */
  const handleOpenChat = async (assistant: AssistantRecord) => {
    try {
      const workspaces = await queryClient.ensureQueryData({
        queryKey: ["workspaces"],
        queryFn: () => WorkspaceApi.list(),
      });
      const workspaceId = workspaces[0]?.id;
      if (workspaceId === undefined) {
        toast.error(t("chat:experts.myExperts.chatFailed"));
        return;
      }
      const session = await SessionApi.create({
        workspaceId,
        assistantId: assistant.id,
      });
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      navigate(`/module/ai?session=${session.id}`);
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  const handleDelete = async () => {
    if (!deleting) {
      return;
    }
    try {
      await AssistantApi.delete(deleting.id);
      await queryClient.invalidateQueries({ queryKey: ASSISTANTS_KEY });
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setDeleting(null);
    }
  };

  if (assistantsQuery.isPending) {
    return (
      <p className="py-16 text-center text-sm text-muted-foreground">
        {t("common:loading")}
      </p>
    );
  }
  if (assistantsQuery.isError) {
    return (
      <p className="py-16 text-center text-sm text-destructive">
        {assistantsQuery.error instanceof Error
          ? assistantsQuery.error.message
          : t("ai:errors.UNKNOWN")}
      </p>
    );
  }

  return (
    <div className="relative p-6">
      {assistants.length === 0 ? (
        <EmptyState
          onBack={onBack}
          onCreate={() => void handleChatCreate()}
          onBrowseMarket={onBrowseMarket}
        />
      ) : (
        <>
          <div className="mb-4 flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="gap-1 text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
              onClick={onBack}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              {t("chat:experts.market.allExperts")}
            </Button>
            <Button size="sm" className="ml-auto" onClick={() => void handleChatCreate()}>
              <Plus className="mr-1 h-4 w-4" />
              {t("chat:experts.myExperts.create")}
            </Button>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {assistants.map((assistant) => (
              <ExpertCardMine
                key={assistant.id}
                assistant={assistant}
                onEdit={() => {
                  setEditing(assistant);
                  setDialogOpen(true);
                }}
                onDelete={() => setDeleting(assistant)}
                onOpenChat={() => void handleOpenChat(assistant)}
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

/** PRD 4.2 空状态：返回 + 毕业帽插画 + 主副标题 + 创建/去市场 */
function EmptyState({
  onBack,
  onCreate,
  onBrowseMarket,
}: {
  onBack: () => void;
  onCreate: () => void;
  onBrowseMarket: () => void;
}) {
  const { t } = useTranslation(["chat", "common"]);
  return (
    <div className="flex flex-col items-center gap-4 py-24">
      <Button
        variant="ghost"
        size="sm"
        className="absolute left-4 top-4 gap-1 text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
        onClick={onBack}
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        {t("chat:experts.market.allExperts")}
      </Button>
      <GraduationCap className="h-16 w-16 text-muted-foreground/40" />
      <div className="text-center">
        <p className="text-base font-medium text-foreground">
          {t("chat:experts.myExperts.emptyTitle")}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("chat:experts.myExperts.emptySubtitle")}
        </p>
      </div>
      <Button variant="outline" className="gap-1" onClick={onCreate}>
        <Plus className="h-4 w-4" />
        {t("chat:experts.myExperts.create")}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
        onClick={onBrowseMarket}
      >
        {t("chat:experts.myExperts.browseMarket")}
      </Button>
    </div>
  );
}

interface ExpertCardMineProps {
  assistant: AssistantRecord;
  onEdit: () => void;
  onDelete: () => void;
  onOpenChat: () => void;
}

/** 我的专家卡：迁移自 AssistantCard，描述优先 description 回退 systemPrompt 截断 */
function ExpertCardMine({
  assistant,
  onEdit,
  onDelete,
  onOpenChat,
}: ExpertCardMineProps) {
  const { t } = useTranslation(["ai", "chat", "common"]);
  const description =
    assistant.description ||
    assistant.systemPrompt.slice(0, 60) + (assistant.systemPrompt.length > 60 ? "…" : "");
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
          {description}
        </CardDescription>
      </CardHeader>
      <CardContent className="mt-auto flex items-center justify-end gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 hover:bg-primary-subtle hover:text-primary"
          onClick={onOpenChat}
          aria-label={t("chat:experts.myExperts.openChat")}
        >
          <MessageSquare className="h-3.5 w-3.5" />
        </Button>
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
