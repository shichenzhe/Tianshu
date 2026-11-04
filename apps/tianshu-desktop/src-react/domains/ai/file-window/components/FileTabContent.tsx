/**
 * 文件窗口内容区：按 resource 路由——workspace 走 ArtifactApi.readFile、
 * library 走 LibraryTabBody（T14：tree 条目 + readExternalFile 内容 +
 * library:writeFileContent 保存/updatedAt 基线冲突，编辑器复用资料库）。
 * 只读分支与 FilePreview 同语义（webview 守卫复用 chat/lib/
 * use-webview-guard（T28 收敛共享）、Finder 兜底）：image/webview 由后端返回 kind 驱动，md/text 判定复用
 * chat 域 previewModeOfPath（单一口径，不另建扩展名常量）；md/text 载
 * FileTabEditor（受控：draft 状态在本层，保存经 useSaveTab 走
 * workspace:writeFile + mtime 基线冲突确认）；读取回传 mtime 落
 * tab.baselineMtime（仅未脏时——外部重取不得吞用户编辑的保存基线）。
 * T12 外部换血守卫：draft 非空且重取 mtime 较上次吸收值已变 → 标
 * externalChanged 复用 T8 冲突条（重载磁盘版本/保留我的修改），基线
 * 不吸收新 mtime——保留 draft 所据基线，keepMine 后保存仍经
 * FILE_CONFLICT 兜底，防「旧 draft+新基线」免检覆盖（spec §5.2）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileX, FolderSearch } from "lucide-react";

import ArtifactApi from "@/domains/ai/api/artifact.api";
import { previewModeOfPath } from "@/domains/ai/chat/lib/file-preview-mode";
import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import { useWebviewGuard } from "@/domains/ai/chat/lib/use-webview-guard";
import { fileUrlOf } from "@/lib/file-url";
import { useFileWindowStore } from "../store/file-window.store";
import { useSaveTab } from "../hooks/use-save-tab";
import { registerTabFlush, unregisterTabFlush } from "../lib/tab-save-flush";
import FileTabEditor from "./FileTabEditor";
import FileTabHeader from "./FileTabHeader";
import LibraryTabBody from "./LibraryTabBody";

export default function FileTabContent({ tabId }: { tabId: string }) {
  const tab = useFileWindowStore((s) => s.tabs.find((t) => t.id === tabId));
  if (!tab) return null;
  // library 走 LibraryTabBody 自注册 flush（T9 F4 已覆盖）、workspace 走
  // 本层 WorkspaceFileBody
  if (tab.resource.kind === "library") return <LibraryTabBody tabId={tab.id} />;
  return (
    <WorkspaceFileBody
      tabId={tab.id}
      workspaceId={tab.resource.workspaceId}
      path={tab.resource.path}
    />
  );
}

function WorkspaceFileBody({
  tabId,
  workspaceId,
  path,
}: {
  tabId: string;
  workspaceId: number;
  path: string;
}) {
  const { t } = useTranslation(["chat"]);
  const patchTab = useFileWindowStore((s) => s.patchTab);
  const mode = previewModeOfPath(path);
  const fileQuery = useQuery({
    queryKey: ["fw-file", workspaceId, path],
    queryFn: () => ArtifactApi.readFile(workspaceId, path),
    retry: false,
    staleTime: 5_000,
  });
  const webviewSrc =
    fileQuery.data?.kind === "webview" && fileQuery.data.absPath
      ? fileUrlOf(fileQuery.data.absPath)
      : null;
  // webview 外跳拦截/失败降级守卫（语义见 hook 头注释）
  const { ref: webviewRef, failed: webviewFailed } =
    useWebviewGuard(webviewSrc);

  // 编辑器受控值：draft（本地编辑）?? 磁盘内容（query 数据）；编辑不回写
  // query 缓存（保存成功 invalidate 后随新数据收敛）
  const [draft, setDraft] = useState<string | null>(null);
  const content =
    fileQuery.data?.kind === "text" ? (fileQuery.data.content ?? "") : "";
  const value = draft ?? content;
  // 最新展示值镜像（ref）：onSave/onResolveConflict 取值不经闭包依赖，
  // 保持回调引用稳定（⌘S 监听不随每次按键重绑）
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  // 基线 mtime 落库（T7 审查缺口）+ 外部换血守卫（T12，见文件头注释）：
  // - lastSeenMtimeRef：上次吸收的数据 mtime（判「换血」的比对基准）
  // - draftStaleRef：draft 已偏离磁盘当前内容（换血后未重载/未写回），
  //   为 true 期间基线不吸收重取 mtime——保住 keepMine 的 FILE_CONFLICT 兜底
  const lastSeenMtimeRef = useRef<number | null>(null);
  const draftStaleRef = useRef(false);
  useEffect(() => {
    const data = fileQuery.data;
    if (!data) return;
    const tab = useFileWindowStore.getState().tabs.find((x) => x.id === tabId);
    if (!tab) return;
    const diverged =
      draft !== null &&
      lastSeenMtimeRef.current !== null &&
      data.mtime !== lastSeenMtimeRef.current;
    if (diverged) {
      draftStaleRef.current = true;
      patchTab(tabId, { externalChanged: true });
    } else if (!tab.dirty && !draftStaleRef.current) {
      patchTab(tabId, { baselineMtime: data.mtime });
    }
    lastSeenMtimeRef.current = data.mtime;
  }, [fileQuery.data, draft, patchTab, tabId]);

  // 错误只 toast 一次（空态由渲染分支兜底，文案不依赖错误分类）
  useEffect(() => {
    if (fileQuery.error) {
      toast.error(mapIpcError(fileQuery.error));
    }
  }, [fileQuery.error]);

  const failed = webviewFailed || (!fileQuery.isPending && !fileQuery.data);

  const { save, conflict, resolveConflict } = useSaveTab(tabId);

  const handleDraftChange = useCallback(
    (next: string) => {
      // valueRef 同步写：闭合 effect-lag 残余窗口（onChange 与 onSave 同
      // 处理器连发时，保存取值不经下一次渲染的 effect 刷新）
      valueRef.current = next;
      setDraft(next);
      patchTab(tabId, { dirty: true, saveStatus: "unsaved" });
    },
    [patchTab, tabId],
  );

  // 保存：仅 dirty 时（工具行按钮本就只脏可见，⌘S 编辑器侧同语义门）。
  // 写盘内容取触发时快照；完成时草稿已变（在飞期间击键）则回补脏标记——
  // write 成功一律 dirty:false 会把新于磁盘的草稿误判净（保存钮消失/
  // ⌘S no-op/关闭确认放行丢内容）
  const saveNow = useCallback(async (): Promise<void> => {
    const tab = useFileWindowStore.getState().tabs.find((x) => x.id === tabId);
    if (!tab?.dirty) return;
    const snapshot = valueRef.current;
    const result = await save(snapshot);
    if (result) {
      // 写回成功：draft 与磁盘重新一致——吸收写回 mtime（后续重取同
      // mtime 不误判换血）、清 stale（基线吸收恢复）
      lastSeenMtimeRef.current = result.mtime;
      draftStaleRef.current = false;
    }
    if (valueRef.current !== snapshot) {
      patchTab(tabId, { dirty: true, saveStatus: "unsaved" });
    }
  }, [patchTab, save, tabId]);

  const handleSave = useCallback(() => {
    void saveNow();
  }, [saveNow]);

  // 关闭确认「保存并关闭」经注册表取本 tab 保存流（draft 受控在本组件，
  // 外层 CloseConfirmBar 无从取值）；卸载（关 tab）除名——全挂载下非
  // active 不卸载，flush 退化为 no-op 仅发生在已关 tab
  useEffect(() => {
    registerTabFlush(tabId, saveNow);
    return () => unregisterTabFlush(tabId);
  }, [tabId, saveNow]);

  // 冲突确认：reload 丢弃本地草稿展示重读的磁盘内容（overwrite 保留
  // 草稿，其在飞期间击键同 handleSave 回补脏标记）；keepMine 为 T12
  // external 场景专有——仅撤条幅继续编辑，基线仍指 draft 所据版本，
  // 下次保存 FILE_CONFLICT 再兜底
  const handleResolveConflict = useCallback(
    (mode: "overwrite" | "reload" | "keepMine") => {
      if (mode === "keepMine") {
        patchTab(tabId, { externalChanged: false });
        return;
      }
      const snapshot = valueRef.current;
      if (mode === "reload") {
        setDraft(null);
        draftStaleRef.current = false;
      }
      void resolveConflict(mode, snapshot).then((result) => {
        if (mode === "overwrite" && result) {
          lastSeenMtimeRef.current = result.mtime;
          draftStaleRef.current = false;
        }
        if (mode === "overwrite" && valueRef.current !== snapshot) {
          patchTab(tabId, { dirty: true, saveStatus: "unsaved" });
        }
      });
    },
    [patchTab, resolveConflict, tabId],
  );

  const reveal = () =>
    void ArtifactApi.revealFile(workspaceId, path).catch((e) =>
      toast.error(mapIpcError(e)),
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <FileTabHeader
        tabId={tabId}
        onSave={handleSave}
        conflict={conflict}
        onResolveConflict={handleResolveConflict}
      />
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {failed ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
            <FileX className="h-8 w-8" />
            <p className="text-xs">{t("chat:artifacts.previewFailed")}</p>
            <button
              type="button"
              onClick={reveal}
              className="inline-flex items-center gap-1 rounded-md border border-border/50 px-2 py-1 text-xs hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
            >
              <FolderSearch className="h-3.5 w-3.5" />
              {t("chat:artifacts.actionReveal")}
            </button>
          </div>
        ) : fileQuery.isPending || !fileQuery.data ? (
          <p className="text-xs text-muted-foreground">…</p>
        ) : webviewSrc ? (
          // allowpopups 刻意不写：不写即默认拒绝弹窗（同 FilePreview）
          <webview
            ref={webviewRef}
            src={webviewSrc}
            partition="artifact-preview"
            className="h-full min-h-0 w-full rounded-md border border-border/50"
          />
        ) : fileQuery.data.kind === "image" ? (
          <div className="flex h-full items-center justify-center">
            <img
              src={fileQuery.data.dataUrl}
              alt={path}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        ) : mode === "md" || mode === "text" ? (
          // md/text/csv 编辑器（md 分栏 / 等宽 textarea 在其内部按
          // contentKind 路由；保存流在 useSaveTab）
          <FileTabEditor
            tabId={tabId}
            value={value}
            onChange={handleDraftChange}
            onSave={handleSave}
            loading={fileQuery.isPending}
          />
        ) : (
          // 后端 kind 与路径模式不一致的兜底（如图片扩展名回 text）：原文只读
          <pre className="text-xs leading-relaxed">
            {fileQuery.data.content ?? ""}
          </pre>
        )}
      </div>
    </div>
  );
}
