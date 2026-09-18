/**
 * ＋扩展菜单（P3 spec §4）：添加文件 / 模式 / 专家 / 技能 / 连接器 五项；
 * 可选 localTask 开关项（项目底栏 T8，未传不渲染——AI 模块零改动）
 * 模式为二级子菜单（✓ 当前项），专家/技能二级浮层拆至独立组件
 * （搜索 + 列表 + 底部操作）。技能本地导入复用 SkillImportDialog：
 * 先经系统选择器取路径，再开弹窗自动预检。管理入口就近收纳：
 * 配置模型 → ModelPicker 面板底部；MCP → 连接器项
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, FilePlus, Library, Plug, Plus, Sparkles } from "lucide-react";

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
import LibraryPickerDialog, {
  type PickedLibraryFile,
} from "../../library/components/LibraryPickerDialog";
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

/** 本地任务开关项数据（项目底栏 T8）：label 由调用方传入——
    PlusMenu 属 ai 域共享组件，不直接依赖 project 命名空间文案 */
export interface LocalTaskToggle {
  enabled: boolean;
  label: string;
  onToggle: (next: boolean) => void;
}

interface PlusMenuProps {
  sessionId: number;
  currentMode: SessionMode;
  currentAssistantId?: number;
  /** 项目动态流：仅展示已挂载专家（透传为专家子菜单 allowedIds）；未传不过滤 */
  boundAssistantIds?: number[];
  /** 项目动态流：仅展示已挂载技能（透传为技能子菜单 allowedNames）；未传不过滤 */
  boundSkillNames?: string[];
  /** 项目底栏本地任务开关（T8）：传入时在模式子菜单后渲染开关项；
      未传不渲染（AI 模块 ChatView 零改动） */
  localTask?: LocalTaskToggle;
  /** 选中的文件路径回传 ChatInput 以内联 @token 插入(内容发送时再读) */
  onPickPaths: (paths: string[]) => void;
  /** 资料库选中文件回传 ChatInput 挂引用 pill（storagePath 含空格不入
      @token 流；内容发送时再读） */
  onPickLibraryFiles: (files: PickedLibraryFile[]) => void;
  onOpenMcp: () => void;
}

/** 模式三态（spec R5）：agent 为默认（DB 落 null）；导出供新建任务
    落地页 AttachMenu 复用（+ 菜单对齐，避免双份漂移） */
export const MODES: Array<{ value: SessionMode; labelKey: string }> = [
  { value: "agent", labelKey: "chat:plus.modeAgent" },
  { value: "ask", labelKey: "chat:plus.modeAsk" },
  { value: "plan", labelKey: "chat:plus.modePlan" },
];

export default function PlusMenu({
  sessionId,
  currentMode,
  currentAssistantId,
  boundAssistantIds,
  boundSkillNames,
  localTask,
  onPickPaths,
  onPickLibraryFiles,
  onOpenMcp,
}: PlusMenuProps) {
  const { t } = useTranslation(["chat"]);
  const queryClient = useQueryClient();
  const [importOpen, setImportOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);

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
        {/* 嵌套顺序回归锚点（b68d536）：TooltipProvider 最外层，两个
            asChild 触发器直连 Button 合并事件 props（同
            context-usage-button.tsx）；若 TooltipProvider 插入两个
            asChild 之间，Dropdown 触发事件将无法到达按钮 */}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t("chat:input.addMenuHint")}
                  className="h-8 w-8 shrink-0 p-0 hover:bg-primary-subtle hover:text-primary"
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>{t("chat:input.addMenuHint")}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <DropdownMenuContent
          align="start"
          className="w-52 border border-border/50 rounded-lg shadow-lg"
        >
          <DropdownMenuItem onClick={() => void handleAddFile()}>
            <FilePlus />
            {t("chat:plus.addFile")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setLibraryOpen(true)}>
            <Library />
            {t("chat:plus.library")}
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
          {localTask && (
            <DropdownMenuItem
              // 开关项：切换勾选不关闭菜单（同技能子菜单多选），允许反复切换
              onSelect={(e) => e.preventDefault()}
              onClick={() => localTask.onToggle(!localTask.enabled)}
            >
              <span className="truncate">{localTask.label}</span>
              {localTask.enabled && (
                <Check className="ml-auto h-4 w-4 shrink-0 text-primary" />
              )}
            </DropdownMenuItem>
          )}
          <ExpertSubMenu
            sessionId={sessionId}
            currentAssistantId={currentAssistantId}
            allowedIds={boundAssistantIds}
          />
          <SkillSubMenu
            onImport={handleImportSkill}
            allowedNames={boundSkillNames}
          />
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onOpenMcp}>
            <Plug />
            {t("chat:plus.connector")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SkillImportDialog open={importOpen} onOpenChange={setImportOpen} />
      <LibraryPickerDialog
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        onPick={onPickLibraryFiles}
      />
    </>
  );
}
