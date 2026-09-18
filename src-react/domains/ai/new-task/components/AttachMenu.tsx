/**
 * 新建任务输入卡 ＋号菜单（PlusMenu 对齐）：与会话 ChatInput 的
 * PlusMenu 菜单项一致——
 * 文件组：添加文件（file:pickLocalFiles 取路径 → readExternalFile 校验入
 *   pending，机制按落地页 pill 范式不搬 @token）、引用工作空间文件（二级
 *   子面板 useWorkspaceFiles）、资料库（LibraryPickerDialog 浏览/搜索多选，
 *   选中 storagePath 逐个走 addLocalFile 入 pending）；
 * 草稿组：模式（PlusMenu 导出 MODES 复用，✓ 草稿态写 store，dispatch 时
 *   setMode 落库）、专家（ExpertSubMenu onPick 草稿分支，同 dispatch 落库）、
 *   技能（SkillSubMenu 直接复用——全局启停/本地导入/管理入口无 session 依赖）；
 * 连接器：导航专家页 connectors Tab（ChatView MCP_ROUTE 同目标）。
 * 文案复用 chat:plus.* 词条（两侧一致），触发钮样式同 PlusMenu
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
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
import { invoke } from "@/lib/ipc";
import type { SessionMode } from "../../api/session.api";
import SkillImportDialog from "../../skills/components/SkillImportDialog";
import LibraryPickerDialog from "../../library/components/LibraryPickerDialog";
import { MODES } from "../../chat/components/PlusMenu";
import ExpertSubMenu from "../../chat/components/expert-sub-menu";
import SkillSubMenu from "../../chat/components/skill-sub-menu";
import { useLocalFileAttach } from "../hooks/use-local-file-attach";
import { useWorkspaceFiles } from "../hooks/use-workspace-files";
import { useNewTaskStore } from "../store/new-task-store";

const MCP_ROUTE = "/module/ai/experts?tab=connectors";

export default function AttachMenu() {
  const { t } = useTranslation(["chat", "newTask"]);
  const navigate = useNavigate();
  const workspaceId = useNewTaskStore((s) => s.workspaceId);
  const addPending = useNewTaskStore((s) => s.addPending);
  const mode = useNewTaskStore((s) => s.mode);
  const setMode = useNewTaskStore((s) => s.setMode);
  const assistantId = useNewTaskStore((s) => s.assistantId);
  const setAssistantId = useNewTaskStore((s) => s.setAssistantId);
  const addLocalFile = useLocalFileAttach();
  const [importOpen, setImportOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  // 子面板打开时才拉清单（关闭后缓存复用，空间切换重拉）
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const workspaceFiles = useWorkspaceFiles(workspaceId, workspaceOpen);

  /** 选择器本地文件：仅取路径，内容校验（512KB/权限）在 addLocalFile 内 */
  const handlePickLocalFiles = async () => {
    let paths: string[] | null;
    try {
      paths = await invoke<string[] | null>("file:pickLocalFiles");
    } catch {
      toast.error(t("newTask:attach.readFailed"));
      return;
    }
    if (!paths) {
      return; // 取消/空选静默
    }
    for (const absPath of paths) {
      await addLocalFile(absPath);
    }
  };

  /** 模式为草稿态：写 store，session 创建后由 dispatch setMode 落库 */
  const handleSelectMode = (next: SessionMode) => {
    setMode(next);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("newTask:attach.title")}
            title={t("newTask:attach.title")}
            className="h-8 w-8 shrink-0 p-0 hover:bg-primary-subtle hover:text-primary"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-52 border border-border/50 rounded-lg shadow-lg"
        >
          <DropdownMenuItem onClick={() => void handlePickLocalFiles()}>
            <FilePlus />
            {t("chat:plus.addFile")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setLibraryOpen(true)}>
            <Library />
            {t("chat:plus.library")}
          </DropdownMenuItem>
          <DropdownMenuSub onOpenChange={setWorkspaceOpen}>
            <DropdownMenuSubTrigger>
              <FilePlus />
              {t("newTask:attach.workspaceFile")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-64 w-72 overflow-y-auto border border-border/50 rounded-lg shadow-lg">
              {workspaceFiles && workspaceFiles.length > 0 ? (
                workspaceFiles.map((rel) => (
                  <DropdownMenuItem
                    key={rel}
                    title={rel}
                    onClick={() =>
                      addPending({ label: rel, ref: rel, kind: "file" })
                    }
                  >
                    <span className="truncate">{rel}</span>
                  </DropdownMenuItem>
                ))
              ) : (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  {t(
                    workspaceId === null
                      ? "newTask:context.noWorkspace"
                      : "newTask:attach.noFiles",
                  )}
                </p>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Sparkles />
              {t("chat:plus.mode")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="border border-border/50 rounded-lg shadow-lg">
              {MODES.map((item) => (
                <DropdownMenuItem
                  key={item.value}
                  onClick={() => handleSelectMode(item.value)}
                >
                  <span className="truncate">{t(item.labelKey)}</span>
                  {item.value === mode && (
                    <Check className="ml-auto h-4 w-4 shrink-0 text-primary" />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <ExpertSubMenu
            onPick={setAssistantId}
            currentAssistantId={assistantId ?? undefined}
          />
          <SkillSubMenu onImport={() => setImportOpen(true)} />
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => navigate(MCP_ROUTE)}>
            <Plug />
            {t("chat:plus.connector")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SkillImportDialog open={importOpen} onOpenChange={setImportOpen} />
      <LibraryPickerDialog
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        onPick={(files) => {
          for (const file of files) {
            void addLocalFile(file.storagePath);
          }
        }}
      />
    </>
  );
}
