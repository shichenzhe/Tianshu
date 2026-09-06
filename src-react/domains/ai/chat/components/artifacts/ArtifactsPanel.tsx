/**
 * 右侧产物面板：头部视图 dropdown（概览/产物文件/工作空间文件，当前项打钩）
 * + 内容区路由（列表三视图 / preview 本地瞬时态）。文件列表从消息缓存与
 * 流式 tools 派生（deriveSessionFiles），selector 只订 tools 避免 text
 * delta 重渲染。preview 返回后回到前一列表视图（不落入 artifactsView）
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, PanelRight } from "lucide-react";

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
}

export default function ArtifactsPanel({
  sessionId,
  workspaceId,
}: ArtifactsPanelProps) {
  const { t } = useTranslation(["chat"]);
  const view = useAiUiStore((s) => s.artifactsView);
  const setView = useAiUiStore((s) => s.setArtifactsView);
  const [previewFile, setPreviewFile] = useState<SessionFile | null>(null);
  const [previewFullscreen, setPreviewFullscreen] = useState(false);

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
      {/* 悬浮面板：absolute 相对行容器，覆盖聊天区右缘不挤压内容 */}
      <div className="absolute inset-y-0 right-0 z-30 flex w-[340px] flex-col border-l border-border/50 bg-background shadow-lg">
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
      {/* 全屏预览渲染在行容器层（absolute inset-0 相对行容器而非悬浮面板） */}
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

/** 顶栏开关按钮（ChatView 顶行右侧） */
export function ArtifactsPanelToggle() {
  const { t } = useTranslation(["chat"]);
  const open = useAiUiStore((s) => s.artifactsOpen);
  const toggle = useAiUiStore((s) => s.toggleArtifacts);
  return (
    <button
      type="button"
      aria-label={open ? t("chat:artifacts.close") : t("chat:artifacts.open")}
      title={open ? t("chat:artifacts.close") : t("chat:artifacts.open")}
      onClick={toggle}
      className="rounded p-1 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
    >
      <PanelRight className="h-4 w-4" />
    </button>
  );
}
