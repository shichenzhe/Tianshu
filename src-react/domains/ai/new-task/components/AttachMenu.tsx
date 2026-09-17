/**
 * 新建任务输入卡 ＋号引用菜单（spec §4）：三项——
 * 1. localFile：通用文件选择器（file:pickLocalFiles，仅取绝对路径）→
 *    readExternalFile 校验入 pending（512KB/无权限 toast 丢弃，取消静默）；
 * 2. workspaceFile：二级子面板列工作空间文件清单（useWorkspaceFiles），
 *    选中 addPending({label: rel, ref: rel, kind: "file"})；
 * 3. historyChat：占位 toast（与 LibraryView 口径一致，Task 后续接入）
 * 触发钮样式参照 ChatInput 底行 PlusMenu
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FilePlus, History, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { invoke } from "@/lib/ipc";
import { useLocalFileAttach } from "../hooks/use-local-file-attach";
import { useWorkspaceFiles } from "../hooks/use-workspace-files";
import { useNewTaskStore } from "../store/new-task-store";

export default function AttachMenu() {
  const { t } = useTranslation(["newTask"]);
  const workspaceId = useNewTaskStore((s) => s.workspaceId);
  const addPending = useNewTaskStore((s) => s.addPending);
  const addLocalFile = useLocalFileAttach();
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

  return (
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
          {t("newTask:attach.localFile")}
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
        <DropdownMenuItem
          onClick={() => toast.info(t("newTask:attach.developing"))}
        >
          <History />
          {t("newTask:attach.historyChat")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
