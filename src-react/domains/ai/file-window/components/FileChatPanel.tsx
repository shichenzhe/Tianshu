/**
 * AI 对话面板（WorkBuddy office chat pane 对齐）：外壳保留（头部
 * 新建任务/打开主页/收起/reinject + 拖宽 320~50%），T26（spec §15 项 1）
 * 废止空态轻输入框分支——面板挂载即渲染完整 ChatPane：
 * - 有会话（tab.sessionId + getById 拉到记录）→ ChatPane 真记录
 * - 无会话 → ChatPane 占位 SessionRecord id=-1 + sessionResolver（首条
 *   发送经 resolver 惰建会话 + 拼文件注入前缀直发，use-file-session
 *   prepareFirstSend）；快捷指令经 ChatInput quickPrompts 胶囊可达
 *   （原空态 chips 退役）
 * - 加载中（getById 在飞）占 common:loading、非已删失败（T23 I1）错误
 *   态重试——两态不渲染 ChatPane（绑定还在，占位会误导）
 * 图片拖入（T19/T22）：面板容器 onDrop 落盘得 absPath 后经
 * pendingImageInjection 受控注入 ChatInput 附件体系。
 * 会话已删（getById 报 SESSION_NOT_FOUND）：hook 善后清绑定+摘映射
 * +专用提示，面板回占位再发即新建；其他失败保留绑定走错误态重试。
 * library 会话：授权补注册（ensureLibraryGrant）+ 全空间未绑目录降级
 * 提示条。hasModel 照 ChatView：会话当前模型 → 工作空间默认模型。
 * 流订阅归属：面板不再持有 useChatSend 订阅——ChatPane 内 useChatSend
 * 独占（占位期哨兵 -1 不订阅，真会话落地随 key 重建换绑）。
 * 空会话回收（spec §15 项 2）：onSessionResolved 落 sessionCreatedHere
 * 标记，关闭 tab/整窗时判空回收（store.closeTab / FileWindowView）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Home, PanelRightClose, RefreshCw, SquarePen } from "lucide-react";
import IconTooltip from "@/components/common/icon-tooltip";

import ChatPane, {
  type SessionResolverResult,
} from "@/domains/ai/chat/components/ChatPane";
import {
  blobToBase64,
  isOverLimit,
} from "@/domains/ai/chat/lib/paste-attachments";
import SessionApi, { type SessionRecord } from "@/domains/ai/api/session.api";
import WorkspaceApi from "@/domains/ai/api/workspace.api";
import { invoke } from "@/lib/ipc";
import FileWindowApi from "../api/file-window.api";
import { useFileWindowStore } from "../store/file-window.store";
import { isSessionGoneError, useFileSession } from "../hooks/use-file-session";
import { usePanelWidth } from "../hooks/use-panel-width";
import { quickPromptsOf } from "../lib/quick-prompts";

/** 拖入暂存图片（name 展示 / absPath 发送，同 ChatInput PastedFileEntry 形态） */
interface PendingImage {
  name: string;
  absPath: string;
}

const HEADER_BTN =
  "rounded p-1 text-muted-foreground hover:bg-primary-subtle hover:text-primary";

const CHIP =
  "rounded-full border border-border/50 px-3 py-1 text-xs transition-base " +
  "hover:border-primary/30 hover:bg-primary-subtle hover:text-primary";

/** ChatPane 设置类入口 → 主窗路由（onOpenSettings target 映射，ChatView 同款） */
const SETTINGS_ROUTE: Record<"providers" | "assistants" | "mcp", string> = {
  providers: "/module/ai/providers",
  assistants: "/module/ai/experts",
  mcp: "/module/ai/experts?tab=connectors",
};

export default function FileChatPanel({ tabId }: { tabId: string }) {
  const { t } = useTranslation(["chat", "common"]);
  const tab = useFileWindowStore((s) => s.tabs.find((x) => x.id === tabId));
  const patchTab = useFileWindowStore((s) => s.patchTab);
  const queryClient = useQueryClient();
  const { width, isResizing, startResize } = usePanelWidth();
  const boundSessionId = tab?.sessionId ?? -1;

  // 会话记录。key 挂 ["sessions","fw",id]：ChatPane 内换模型/专家/模式等
  // 操作 invalidate ["sessions"]（前缀匹配）连带失效本查询，徽标/hasModel
  // 随之收敛（ChatView 侧 ["sessions","all"] 同惯例）
  const sessionQuery = useQuery({
    queryKey: ["sessions", "fw", boundSessionId],
    queryFn: () => SessionApi.getById(boundSessionId),
    enabled: boundSessionId > 0,
    retry: false,
  });
  const sessionRecord = sessionQuery.data ?? null;

  // 首条上下文/善后出口（T26：发送经 ChatPane sessionResolver 直发）
  const {
    sessionId,
    prepareFirstSend,
    reinject,
    handleSessionGone,
    ensureLibraryGrant,
  } = useFileSession(tabId);
  // ChatPane 拖入注入（T22 迁移）：落盘后经受控 prop 并入 ChatInput
  // 附件体系
  const [pendingInjection, setPendingInjection] = useState<PendingImage[]>([]);
  const [paneDragOver, setPaneDragOver] = useState(false);

  const isLibraryTab = tab?.resource.kind === "library";

  // 降级提示（修复轮 2 观察①）：全空间未绑定目录时 library 会话挂未绑
  // 定空间——文件四件不注入（§6.4 直改失效），顶部提示条告知（纯文本
  // 对话不受阻）；绑定空间存在即静默。恒启用（T26：占位期 hasModel/
  // workspaceId 也需空间解析——首条发送前即有输入框）
  const workspacesQuery = useQuery({
    queryKey: ["fw-workspaces"],
    queryFn: () => WorkspaceApi.list(),
    enabled: true,
    staleTime: 30_000,
    retry: false,
  });
  const workspaces = workspacesQuery.data;
  const noBoundWorkspace =
    isLibraryTab &&
    (workspaces?.length ?? 0) > 0 &&
    !workspaces!.some((w) => !!w.directoryPath?.trim());

  // 会话已删（主窗删除）：仅 SESSION_NOT_FOUND 走善后（清绑定+摘映射+
  // 专用提示，回占位再发即新建）；其他失败（token 失效/IPC 瞬时错，
  // T23 I1）不清——主窗会话仍在，误清会让再发凭空新建丢上下文
  const sessionGone =
    sessionQuery.isError && isSessionGoneError(sessionQuery.error);
  useEffect(() => {
    if (sessionGone) handleSessionGone(boundSessionId);
  }, [sessionGone, handleSessionGone, boundSessionId]);

  // ChatPane library 授权补注册（spec §6.4）：会话就位即 grant（幂等）
  useEffect(() => {
    if (!sessionRecord || !isLibraryTab) return;
    ensureLibraryGrant().catch(() => undefined);
  }, [sessionRecord, isLibraryTab, ensureLibraryGrant]);

  // 占位会话（T26，spec §15 项 1）：无绑定时 ChatPane 恒渲染（哨兵
  // id=-1，首条经 sessionResolver 惰建）；workspaceId 尽力取 tab 资源
  // （@ 联想/hasModel 占位期解析），library 占位无空间可取（落地后补）
  const placeholderSession = useMemo<SessionRecord>(
    () => ({
      id: -1,
      workspaceId:
        tab?.resource.kind === "workspace" ? tab.resource.workspaceId : -1,
      title: "",
      mode: "agent",
      createdAt: "",
      updatedAt: "",
    }),
    [tab?.resource],
  );
  const paneSession = sessionRecord ?? placeholderSession;

  // workspace 透传：真会话挂其空间；占位 workspace tab 挂 tab 资源空间
  // （@ 文件联想可用），library 占位 null（空间未定）
  const paneWorkspace = useMemo(() => {
    if (sessionRecord) return { id: sessionRecord.workspaceId };
    if (tab?.resource.kind === "workspace")
      return { id: tab.resource.workspaceId };
    return null;
  }, [sessionRecord, tab?.resource]);

  // hasModel 照 ChatView：会话当前模型 → 工作空间默认模型（占位期按
  // tab 资源空间解析，首条前即有模型徽标口径）
  const sessionWorkspace =
    workspaces?.find((w) => w.id === paneWorkspace?.id) ?? null;
  const hasModel = Boolean(
    sessionRecord?.currentModelId ?? sessionWorkspace?.defaultModelId,
  );

  // 快捷指令：contentKind 矩阵解析（i18n 就地解出 label/prompt；
  // ChatInput 空会话输入区上方点击填草稿不发送——占位会话恒空会话展示）
  const paneQuickPrompts = useMemo(
    () =>
      quickPromptsOf(tab?.contentKind ?? "text").map((p) => ({
        id: p.id,
        label: t(p.labelKey),
        prompt: t(p.promptKey),
      })),
    [tab?.contentKind, t],
  );

  // ChatPane 设置类入口（跨窗导航）：聚焦主窗跳对应路由（失败静默）
  const handleOpenSettings = useCallback(
    (target: "providers" | "assistants" | "mcp") => {
      void invoke("fileWindow:openRoute", {
        hash: SETTINGS_ROUTE[target],
      }).catch(() => undefined);
    },
    [],
  );

  // 占位首条解析（T26）：prepareFirstSend 失败统一在此提示（ChatPane 对
  // resolver 阶段不兜底 toast，防双弹）——标记码映射专用文案，会话已删
  // 走 hook 善后提示
  const handleResolveSession =
    useCallback(async (): Promise<SessionResolverResult> => {
      try {
        return await prepareFirstSend();
      } catch (e) {
        const code = e instanceof Error ? e.message : "";
        if (code === "LIBRARY_ITEM_MISSING")
          toast.error(t("chat:fileWindow.chat.itemMissing"));
        else if (code === "WORKSPACE_DIR_MISSING")
          toast.error(t("chat:fileWindow.chat.imageNotFound"));
        else if (!isSessionGoneError(e))
          toast.error(t("chat:fileWindow.chat.sendFailed"));
        throw e;
      }
    }, [prepareFirstSend, t]);

  // 真会话落地（T26）：落 tab 绑定 + 失效会话记录缓存（面板换真记录渲染）。
  // sessionCreatedHere 不在此写——ensureSession 建会话即写（修复轮 1
  // Critical 1：send ack 前已落 user 消息，成功后补标记会让判空回收永不
  // 执行、失败空会话漏回收；双写无必要）
  const handleSessionResolved = useCallback(
    (s: SessionRecord) => {
      patchTab(tabId, { sessionId: s.id });
      void queryClient.invalidateQueries({
        queryKey: ["sessions", "fw", s.id],
      });
    },
    [patchTab, queryClient, tabId],
  );

  // per-tab 输入草稿（T28，spec §16 项 5）：面板仅挂激活 tab，切 tab/收起
  // 即卸载丢草稿——ChatInput 卸载上报回存 tab 瞬态字段（不入快照），重挂
  // 经 initialDraft 回灌；tab 已关时 patchTab 无害 no-op
  const handleDraftUnmount = useCallback(
    (draft: string) => {
      patchTab(tabId, { inputDraft: draft });
    },
    [patchTab, tabId],
  );

  // 拖入图片落盘（面板 drop 层唯一路径）：过滤 image/*（非图片忽略）→
  // 超限（10MB，与主输入框粘贴同口径）拒绝 toast → blobToBase64 →
  // file:savePastedImage 落盘（返回 attachments 绝对路径，主进程已登记读
  // 授权）；失败/超限分别合并 toast，返回成功条目
  const stageDroppedImages = useCallback(
    async (files: File[]): Promise<PendingImage[]> => {
      const imageFiles = files.filter((f) => f.type.startsWith("image/"));
      if (imageFiles.length === 0) return [];
      const oversize: string[] = [];
      const failed: string[] = [];
      const staged: PendingImage[] = [];
      for (const file of imageFiles) {
        const name = file.name || "image.png";
        if (isOverLimit(file.size)) {
          oversize.push(name);
          continue;
        }
        try {
          const abs = await invoke<string>(
            "file:savePastedImage",
            name,
            await blobToBase64(file),
          );
          staged.push({ name, absPath: abs });
        } catch {
          failed.push(name);
        }
      }
      if (oversize.length > 0)
        toast.warning(
          t("chat:paste.imageTooLarge", { names: oversize.join(", ") }),
        );
      if (failed.length > 0)
        toast.warning(t("chat:paste.readFailed", { names: failed.join(", ") }));
      return staged;
    },
    [t],
  );

  // 面板拖入：落盘得 absPath 后经 pendingImageInjection 受控注入
  // ChatInput 附件体系（chips 管理/发送分流归其自有链路）
  const handlePaneDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setPaneDragOver(false);
      const staged = await stageDroppedImages(Array.from(e.dataTransfer.files));
      if (staged.length === 0) return;
      setPendingInjection((prev) => [
        ...prev,
        ...staged.filter((p) => !prev.some((x) => x.absPath === p.absPath)),
      ]);
    },
    [stageDroppedImages],
  );

  const handlePaneDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setPaneDragOver(true);
  }, []);

  const handlePaneDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null))
      setPaneDragOver(false);
  }, []);

  if (!tab) return null;

  const paneLoading =
    boundSessionId > 0 && !sessionRecord && !sessionQuery.isError;
  // 非已删失败（T23 I1）：错误态+重试（refetch 重拉）；不落占位——绑定
  // 还在，占位「首条惰建」语义会误导，且保留绑定重试可恢复
  const paneLoadFailed =
    boundSessionId > 0 &&
    !sessionRecord &&
    sessionQuery.isError &&
    !sessionGone;
  return (
    <div className="flex h-full min-h-0 shrink-0" style={{ width }}>
      <div
        role="separator"
        aria-label={t("chat:fileWindow.chat.resize")}
        onPointerDown={startResize}
        className="w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-primary/30"
      />
      <div className="flex min-w-0 flex-1 flex-col border-l border-border/50">
        <div className="flex h-9 items-center gap-1 border-b border-border/50 px-2">
          <IconTooltip label={t("chat:fileWindow.chat.openHome")}>
            <button
              type="button"
              aria-label={t("chat:fileWindow.chat.openHome")}
              onClick={() =>
                void FileWindowApi.focusMain().catch(() => undefined)
              }
              className={HEADER_BTN}
            >
              <Home className="h-4 w-4" />
            </button>
          </IconTooltip>
          <IconTooltip label={t("chat:fileWindow.chat.newTask")}>
            <button
              type="button"
              aria-label={t("chat:fileWindow.chat.newTask")}
              onClick={() =>
                patchTab(tabId, {
                  sessionId: undefined,
                  sessionCreatedHere: undefined,
                })
              }
              className={HEADER_BTN}
            >
              <SquarePen className="h-4 w-4" />
            </button>
          </IconTooltip>
          {/* reinject（spec §6.3）：文件被外部/AI 修改后追问时贴最新路径提示
              重读；ChatInput 全量嵌入后收纳于面板头部（直发链路不变） */}
          {sessionId > 0 && (
            <IconTooltip label={t("chat:fileWindow.chat.reinject")}>
              <button
                type="button"
                aria-label={t("chat:fileWindow.chat.reinject")}
                onClick={() => {
                  reinject().catch((e) => {
                    if (!isSessionGoneError(e))
                      toast.error(t("chat:fileWindow.chat.sendFailed"));
                  });
                }}
                className={HEADER_BTN}
              >
                <RefreshCw className="h-4 w-4" />
              </button>
            </IconTooltip>
          )}
          <IconTooltip label={t("chat:fileWindow.chat.collapse")}>
            <button
              type="button"
              aria-label={t("chat:fileWindow.chat.collapse")}
              onClick={() => patchTab(tabId, { aiPanelOpen: false })}
              className={`ml-auto ${HEADER_BTN}`}
            >
              <PanelRightClose className="h-4 w-4" />
            </button>
          </IconTooltip>
        </div>
        {noBoundWorkspace && (
          <div className="border-b border-border/50 bg-primary-subtle/50 px-3 py-1.5 text-xs leading-5 text-muted-foreground">
            {t("chat:fileWindow.chat.noBoundWorkspace")}
          </div>
        )}
        {paneLoading ? (
          // 会话记录在飞：不闪占位（发送会误判为新会话入口语义）
          <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
            {t("common:loading")}
          </div>
        ) : paneLoadFailed ? (
          // 会话记录拉取失败（非已删，T23 I1）：错误态+重试，绑定保留
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-muted-foreground">
            <p className="text-xs">{t("chat:fileWindow.chat.loadFailed")}</p>
            <button
              type="button"
              onClick={() => void sessionQuery.refetch()}
              className={CHIP}
            >
              {t("chat:fileWindow.chat.retry")}
            </button>
          </div>
        ) : (
          <div
            data-testid="file-chat-pane-drop-zone"
            onDragOver={handlePaneDragOver}
            onDragLeave={handlePaneDragLeave}
            onDrop={(e) => void handlePaneDrop(e)}
            className={`flex min-h-0 flex-1 flex-col ${
              paneDragOver ? "bg-primary-subtle/40" : ""
            }`}
          >
            <ChatPane
              key={paneSession.id}
              session={paneSession}
              workspace={paneWorkspace}
              hasModel={hasModel}
              onOpenSettings={handleOpenSettings}
              quickPrompts={paneQuickPrompts}
              pendingImageInjection={pendingInjection}
              onPendingImageInjectionConsumed={() => setPendingInjection([])}
              sessionResolver={handleResolveSession}
              onSessionResolved={handleSessionResolved}
              initialDraft={tab?.inputDraft}
              onDraftUnmount={handleDraftUnmount}
            />
          </div>
        )}
      </div>
      {/* 拖动期全屏遮罩：col-resize 光标全域生效 + 盖住 webview/编辑器
          （webview 是独立合成层，不遮会吞 pointermove 断拖） */}
      {isResizing && (
        <div aria-hidden className="fixed inset-0 z-40 cursor-col-resize" />
      )}
    </div>
  );
}
