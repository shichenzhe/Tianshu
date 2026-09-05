/**
 * ＋扩展菜单（P3 spec §4）：添加文件 / 模式 / 专家 / 技能 / 连接器 五项
 * 模式与专家为二级子菜单（✓ 当前项），选中即写会话并失效 sessions 缓存，
 * 徽标展示由 ChatInput 按 currentMode 渲染（数据经 sessions query 刷新）。
 * 管理入口就近收纳（原齿轮菜单）：专家预设 → 专家子菜单底部；
 * 配置模型 → ModelPicker 面板底部；MCP → 连接器项
 */
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Bot,
  Check,
  FilePlus,
  Plug,
  Plus,
  Sparkles,
  Users,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { invoke } from "@/lib/ipc";
import AssistantApi from "../../api/assistant.api";
import SessionApi, { type SessionMode } from "../../api/session.api";
import { mapIpcError } from "../lib/error-message";

const ASSISTANTS_KEY = ["assistants"] as const;
const SESSIONS_KEY = ["sessions"] as const;
const ASSISTANTS_ROUTE = "/module/ai/assistants";

/** file:pickAndRead 单项：成功带 content，失败带 error（渲染层 toast 并丢弃） */
interface PickedFile {
  path: string;
  content?: string;
  error?: string;
}

interface PlusMenuProps {
  sessionId: number;
  currentMode: SessionMode;
  currentAssistantId?: number;
  /** 成功读取的文件回传 ChatInput 进 chips 暂存区 */
  onPickFiles: (files: Array<{ path: string; content: string }>) => void;
  onOpenSkills: () => void;
  onOpenMcp: () => void;
}

/** 模式三态（spec R5）：agent 为默认（DB 落 null） */
const MODES: Array<{ value: SessionMode; labelKey: string }> = [
  { value: "agent", labelKey: "chat:plus.modeAgent" },
  { value: "ask", labelKey: "chat:plus.modeAsk" },
  { value: "plan", labelKey: "chat:plus.modePlan" },
];

export default function PlusMenu({
  sessionId,
  currentMode,
  currentAssistantId,
  onPickFiles,
  onOpenSkills,
  onOpenMcp,
}: PlusMenuProps) {
  const { t } = useTranslation(["chat"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const assistantsQuery = useQuery({
    queryKey: ASSISTANTS_KEY,
    queryFn: () => AssistantApi.list(),
  });
  const assistants = assistantsQuery.data ?? [];

  /** 写会话后失效 sessions，徽标与选中态随缓存刷新 */
  const invalidateSessions = async () => {
    await queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
  };

  /** 添加文件：成功项回调进 chips，带 error 项逐个 toast 丢弃，取消（空数组）静默 */
  const handleAddFile = async () => {
    let picked: PickedFile[];
    try {
      picked = await invoke<PickedFile[]>("file:pickAndRead");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      return;
    }
    for (const file of picked) {
      if (file.error !== undefined) {
        toast.error(
          t("chat:attach.readFailed", {
            path: file.path,
            reason: file.error,
          }),
        );
      }
    }
    const okFiles = picked
      .filter((file) => file.content !== undefined)
      .map((file) => ({ path: file.path, content: file.content as string }));
    if (okFiles.length > 0) {
      onPickFiles(okFiles);
    }
  };

  const handleSelectMode = async (mode: SessionMode) => {
    if (mode === currentMode) {
      return;
    }
    try {
      await SessionApi.setMode(sessionId, mode);
      await invalidateSessions();
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  const handleSelectAssistant = async (assistantId: number | null) => {
    if ((assistantId ?? undefined) === currentAssistantId) {
      return;
    }
    try {
      await SessionApi.setAssistant(sessionId, assistantId);
      await invalidateSessions();
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("chat:plus.title")}
          className="h-8 w-8 shrink-0 p-0 hover:bg-primary-subtle hover:text-primary"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-52 border border-border/50 rounded-lg shadow-lg"
      >
        <DropdownMenuItem onClick={() => void handleAddFile()}>
          <FilePlus />
          {t("chat:plus.addFile")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Sparkles />
            {t("chat:plus.mode")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="border border-border/50 rounded-lg shadow-lg">
            {MODES.map((mode) => (
              <DropdownMenuItem
                key={mode.value}
                onClick={() => void handleSelectMode(mode.value)}
              >
                <span className="truncate">{t(mode.labelKey)}</span>
                {mode.value === currentMode && (
                  <Check className="ml-auto h-4 w-4 shrink-0 text-primary" />
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Bot />
            {t("chat:plus.expert")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-64 w-44 overflow-y-auto border border-border/50 rounded-lg shadow-lg">
            <DropdownMenuItem onClick={() => void handleSelectAssistant(null)}>
              <span className="truncate">{t("chat:plus.noAssistant")}</span>
              {currentAssistantId === undefined && (
                <Check className="ml-auto h-4 w-4 shrink-0 text-primary" />
              )}
            </DropdownMenuItem>
            {assistants.map((assistant) => (
              <DropdownMenuItem
                key={assistant.id}
                onClick={() => void handleSelectAssistant(assistant.id)}
              >
                <span className="truncate">{assistant.name}</span>
                {assistant.id === currentAssistantId && (
                  <Check className="ml-auto h-4 w-4 shrink-0 text-primary" />
                )}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            {/* 专家预设管理入口（原底部齿轮项并入） */}
            <DropdownMenuItem onClick={() => navigate(ASSISTANTS_ROUTE)}>
              <Users />
              {t("chat:settings.expertPresets")}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Zap />
            {t("chat:plus.skill")}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52 border border-border/50 rounded-lg shadow-lg">
            <DropdownMenuItem
              disabled
              className="cursor-default whitespace-normal text-xs text-muted-foreground"
            >
              {t("chat:plus.skillHint")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onOpenSkills}>
              {t("chat:settings.skills")}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onOpenMcp}>
          <Plug />
          {t("chat:plus.connector")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
