/**
 * 产物 tab 内容（原右栏面板瘦身为 DetailPanel 的 tab 内容）：头部视图
 * dropdown（概览/产物文件/工作空间文件，当前项打钩）+ 内容区列表三视图。
 * 文件列表从消息缓存与流式 tools 派生（deriveSessionFiles），selector
 * 只订 tools 避免 text delta 重渲染。点击文件由 onOpenFile 上抛
 * DetailPanel 开独立 file tab（WorkBuddy 对齐，内嵌预览形态已移除，
 * topSection 不再让位常驻渲染）
 */
import { useCallback, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import IconTooltip from "@/components/common/icon-tooltip";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import SessionApi from "../../../api/session.api";
import { useAiUiStore, type AiArtifactsView } from "../../../store/ai-ui.store";
import { useChatStore } from "../../store/chat.store";
import { deriveSessionFiles, type SessionFile } from "../../lib/artifacts";
import FileListGroup from "./FileListGroup";

const VIEWS: readonly AiArtifactsView[] = [
  "overview",
  "artifacts",
  "workspace",
];

interface ArtifactsTabProps {
  sessionId: number;
  workspaceId: number;
  /** 顶部插槽（批 4 任务概览等）：渲染于内容区顶部、视图切换头之下 */
  topSection?: ReactNode;
  /** 点击文件：开独立 file tab（path 相对工作空间根） */
  onOpenFile: (path: string) => void;
}

export default function ArtifactsTab({
  sessionId,
  workspaceId,
  topSection,
  onOpenFile,
}: ArtifactsTabProps) {
  const { t } = useTranslation(["chat"]);
  const view = useAiUiStore((s) => s.artifactsView);
  const setView = useAiUiStore((s) => s.setArtifactsView);

  // 与 MessageList 共享 ["messages", sessionId] 缓存；流结束既有 invalidate 链路刷新。
  // H6 分页：同 key 同形状的 infinite 查询（react-query 按 key 去重，与
  // MessageList 共享同一份数据/请求）；产物扫描基于已加载页，搜索态由
  // MessageList 兜底拉全
  const messagesQuery = useInfiniteQuery({
    queryKey: ["messages", sessionId],
    queryFn: ({ pageParam }) =>
      SessionApi.listMessages(sessionId, pageParam as number | undefined),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) =>
      last.hasMore && last.nextBeforeId !== null
        ? last.nextBeforeId
        : undefined,
  });
  // 只订 tools：text/thinking delta 不改变 tools 引用，不触发重渲染
  const tools = useChatStore((s) => s.streams[sessionId]?.tools);

  const files = useMemo(
    () =>
      deriveSessionFiles(
        (messagesQuery.data?.pages ?? []).flatMap((page) => page.items),
        tools,
      ),
    [messagesQuery.data, tools],
  );
  const artifactFiles = useMemo(
    () => files.filter((f) => f.group === "artifact"),
    [files],
  );
  const workspaceFiles = useMemo(
    () => files.filter((f) => f.group === "workspace"),
    [files],
  );

  // FileListGroup 的 onPreview 形状（SessionFile）→ 路径上抛开 file tab
  const handleOpenFile = useCallback(
    (file: SessionFile) => onOpenFile(file.path),
    [onOpenFile],
  );

  return (
    <>
      <div className="flex items-center border-b border-border/50 px-2 py-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1 rounded px-2 py-1 text-sm font-medium hover:bg-primary-subtle hover:text-primary"
            >
              {t(`chat:artifacts.${view}`)}
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="border border-border/50 rounded-lg shadow-lg"
          >
            {VIEWS.map((item) => (
              <DropdownMenuItem key={item} onClick={() => setView(item)}>
                {t(`chat:artifacts.${item}`)}
                {view === item && (
                  <Check className="ml-auto h-4 w-4 text-primary" />
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* 顶部插槽（任务概览）：常驻渲染（内嵌预览形态移除，无让位态） */}
        {topSection}
        {view === "overview" ? (
          <>
            <FileListGroup
              title={t("chat:artifacts.artifacts")}
              files={artifactFiles}
              defaultOpen
              workspaceId={workspaceId}
              onPreview={handleOpenFile}
            />
            <FileListGroup
              title={t("chat:artifacts.workspace")}
              files={workspaceFiles}
              defaultOpen
              workspaceId={workspaceId}
              onPreview={handleOpenFile}
            />
          </>
        ) : view === "artifacts" ? (
          <FileListGroup
            title={t("chat:artifacts.artifacts")}
            files={artifactFiles}
            defaultOpen
            workspaceId={workspaceId}
            onPreview={handleOpenFile}
          />
        ) : (
          <FileListGroup
            title={t("chat:artifacts.workspace")}
            files={workspaceFiles}
            defaultOpen
            workspaceId={workspaceId}
            onPreview={handleOpenFile}
          />
        )}
      </div>
    </>
  );
}

/** 顶栏开关按钮（ChatView 顶行右侧，与项目详情右栏开关同构）：
 *  图标随状态切换（展开=收起图标/收起=展开图标），ghost 无 Tooltip */
export function ArtifactsPanelToggle() {
  const { t } = useTranslation(["chat"]);
  const open = useAiUiStore((s) => s.artifactsOpen);
  const toggle = useAiUiStore((s) => s.toggleArtifacts);
  const label = open ? t("chat:artifacts.close") : t("chat:artifacts.open");
  return (
    <IconTooltip label={label}>
      <Button
        variant="ghost"
        size="sm"
        aria-label={label}
        aria-pressed={open}
        onClick={toggle}
        className="h-7 w-7 p-0 text-muted-foreground hover:text-primary"
      >
        {open ? (
          <PanelRightClose className="h-4 w-4" />
        ) : (
          <PanelRightOpen className="h-4 w-4" />
        )}
      </Button>
    </IconTooltip>
  );
}
