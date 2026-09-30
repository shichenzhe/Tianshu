/**
 * 右侧产物面板：头部视图 dropdown（概览/产物文件/工作空间文件，当前项打钩）
 * + 内容区路由（列表三视图 / preview 本地瞬时态）。文件列表从消息缓存与
 * 流式 tools 派生（deriveSessionFiles），selector 只订 tools 避免 text
 * delta 重渲染。preview 返回后回到前一列表视图（不落入 artifactsView）
 */
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";

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
import FilePreview from "./FilePreview";

const VIEWS: readonly AiArtifactsView[] = [
  "overview",
  "artifacts",
  "workspace",
];

interface ArtifactsPanelProps {
  sessionId: number;
  workspaceId: number;
  /** 顶部插槽（批 4 任务概览等）：渲染于内容区顶部、视图切换头之下；
   *  预览态（聚焦阅读）不渲染 */
  topSection?: ReactNode;
}

export default function ArtifactsPanel({
  sessionId,
  workspaceId,
  topSection,
}: ArtifactsPanelProps) {
  const { t } = useTranslation(["chat"]);
  const view = useAiUiStore((s) => s.artifactsView);
  const setView = useAiUiStore((s) => s.setArtifactsView);
  const [previewFile, setPreviewFile] = useState<SessionFile | null>(null);
  const [previewFullscreen, setPreviewFullscreen] = useState(false);
  // 顶部工具栏右段宽度注册（store 注册表求和，可与项目配置栏并存）：
  // 340 与本面板列宽 w-[340px] 同步维护
  const panelId = useId();
  useEffect(() => {
    useAiUiStore.getState().registerTopbarRightWidth(panelId, 340);
    return () => useAiUiStore.getState().unregisterTopbarRightWidth(panelId);
  }, [panelId]);

  // 与 MessageList 共享 ["messages", sessionId] 缓存；流结束既有 invalidate 链路刷新
  const messagesQuery = useQuery({
    queryKey: ["messages", sessionId],
    queryFn: () => SessionApi.listMessages(sessionId),
  });
  // 只订 tools：text/thinking delta 不改变 tools 引用，不触发重渲染
  const tools = useChatStore((s) => s.streams[sessionId]?.tools);

  const files = useMemo(
    () => deriveSessionFiles(messagesQuery.data ?? [], tools),
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

  const closePreview = () => {
    setPreviewFile(null);
    setPreviewFullscreen(false);
  };
  const togglePreviewFullscreen = () => setPreviewFullscreen((prev) => !prev);

  return (
    <>
      {/* 挤压式右列（与项目详情右栏同构）：shrink-0 占位，收起时由外层整体移除 */}
      <div className="flex w-[340px] shrink-0 flex-col border-l border-border/50 bg-background">
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
                <DropdownMenuItem
                  key={item}
                  onClick={() => {
                    setView(item);
                    closePreview();
                  }}
                >
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
          {/* 顶部插槽（任务概览）：预览态为聚焦阅读场景，让位不渲染 */}
          {!previewFile && topSection}
          {previewFile && !previewFullscreen ? (
            <FilePreview
              file={previewFile}
              workspaceId={workspaceId}
              onBack={closePreview}
              fullscreen={false}
              onToggleFullscreen={togglePreviewFullscreen}
            />
          ) : view === "overview" ? (
            <>
              <FileListGroup
                title={t("chat:artifacts.artifacts")}
                files={artifactFiles}
                defaultOpen
                workspaceId={workspaceId}
                onPreview={setPreviewFile}
              />
              <FileListGroup
                title={t("chat:artifacts.workspace")}
                files={workspaceFiles}
                defaultOpen
                workspaceId={workspaceId}
                onPreview={setPreviewFile}
              />
            </>
          ) : view === "artifacts" ? (
            <FileListGroup
              title={t("chat:artifacts.artifacts")}
              files={artifactFiles}
              defaultOpen
              workspaceId={workspaceId}
              onPreview={setPreviewFile}
            />
          ) : (
            <FileListGroup
              title={t("chat:artifacts.workspace")}
              files={workspaceFiles}
              defaultOpen
              workspaceId={workspaceId}
              onPreview={setPreviewFile}
            />
          )}
        </div>
      </div>
      {/* 全屏预览渲染在行容器层（absolute inset-0 相对行容器而非产物面板） */}
      {previewFile && previewFullscreen && (
        <FilePreview
          file={previewFile}
          workspaceId={workspaceId}
          onBack={closePreview}
          fullscreen
          onToggleFullscreen={togglePreviewFullscreen}
        />
      )}
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
  );
}
