/**
 * ＋扩展菜单（P3 spec §4）：添加文件 / 模式 / 专家 / 技能 / 连接器 五项
 * 模式为二级子菜单（✓ 当前项），专家/技能二级浮层拆至独立组件
 * （搜索 + 列表 + 底部操作）。技能本地导入复用 SkillImportDialog：
 * 先经系统选择器取路径，再开弹窗自动预检。管理入口就近收纳：
 * 配置模型 → ModelPicker 面板底部；MCP → 连接器项
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, FilePlus, Plug, Plus, Sparkles } from "lucide-react";

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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { invoke } from "@/lib/ipc";
import SessionApi, { type SessionMode } from "../../api/session.api";
import SkillImportDialog from "../../skills/components/SkillImportDialog";
import { mapIpcError } from "../lib/error-message";
import ExpertSubMenu from "./expert-sub-menu";
import SkillSubMenu from "./skill-sub-menu";

const SESSIONS_KEY = ["sessions"] as const;

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
  /** 选中的文件路径回传 ChatInput 以内联 @token 插入(内容发送时再读) */
  onPickPaths: (paths: string[]) => void;
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
  onPickPaths,
  onOpenMcp,
}: PlusMenuProps) {
  const { t } = useTranslation(["chat"]);
  const queryClient = useQueryClient();
  const [importOpen, setImportOpen] = useState(false);

  /** 写会话后失效 sessions，徽标与选中态随缓存刷新 */
  const invalidateSessions = async () => {
    await queryClient.invalidateQueries({ queryKey: SESSIONS_KEY });
  };

  /** 添加文件：路径以内联 @token 进输入流（内容发送时再读），
      读取失败项逐个 toast 丢弃，取消（空数组）静默 */
  const handleAddFile = async () => {
    let picked: PickedFile[];
    try {
      picked = await invoke<PickedFile[]>("file:pickAndRead");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      return;
    }
    const paths: string[] = [];
    for (const file of picked) {
      if (file.error !== undefined) {
        toast.error(
          t("chat:attach.readFailed", {
            path: file.path,
            reason: file.error,
          }),
        );
      } else {
        paths.push(file.path);
      }
    }
    if (paths.length > 0) {
      onPickPaths(paths);
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

  /** 从本地添加技能：直接弹上传框（框内点击选择/拖拽，与技能维护页一致） */
  const handleImportSkill = () => {
    setImportOpen(true);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t("chat:input.addMenuHint")}
                  className="h-8 w-8 shrink-0 p-0 hover:bg-primary-subtle hover:text-primary"
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("chat:input.addMenuHint")}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
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
          <ExpertSubMenu
            sessionId={sessionId}
            currentAssistantId={currentAssistantId}
          />
          <SkillSubMenu onImport={handleImportSkill} />
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onOpenMcp}>
            <Plug />
            {t("chat:plus.connector")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SkillImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </>
  );
}
