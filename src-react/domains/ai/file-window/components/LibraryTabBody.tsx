/**
 * library tab 内容体（T14）：条目元数据（lib/library-item 经 library:tree
 * 平铺 find id）→ contentKind 细化（libraryContentKindOf，T3 占位 text 收
 * 敛）+ title/徽标落库 → storagePath 经 file:readExternalFile 读 → md/
 * text 走 CM6 编辑器（FileWindowMdEditor/FileWindowEditor，语言按条目名
 * 扩展懒加载映射，T24）、csv 仍 LibraryCsvEditor（props 为 rows/
 * onChange，csv 侧维护网格草稿、保存时 serializeCsv 序列化）/ image
 * （dev dataUrl 内联，生产 file:// 直链，同 LibraryPreviewContent 口径）/
 * webview 类 file:// 直开（外跳守卫复用 use-webview-guard）。
 * 保存手动语义（区别 LibraryPreviewContent 防抖自动保存）：走
 * library:writeFileContent 独立路径（useSaveTab 是 workspace:writeFile 专
 * 用，不复用）；updatedAt 基线冲突：tab.baselineMtime 存
 * Date.parse(updatedAt)，保存前重取条目比对，不符弹冲突条复用
 * FileTabHeader——overwrite=免基线直写、reload=弃草稿重读（条目/内容两
 * 查询重取，基线随新数据落回）。⌘S 与 workspace 编辑器同语义（激活且
 * 脏时触发）。
 * flush 注册表覆盖（T9 F4）：CloseConfirmBar「保存并关闭」经注册表走本
 * 保存流。卸载（关 tab）触发 fileWindow:revokeSession 回收会话路径授权
 * （T13，尽力而为；下次发送前 grant 幂等重注，T15 移窗携带 sessionId
 * 语义无碍）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileX, FolderSearch } from "lucide-react";

import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import LibraryApi from "@/domains/ai/library/api/library.api";
import LibraryCsvEditor from "@/domains/ai/library/components/LibraryCsvEditor";
import {
  parseCsv,
  serializeCsv,
  toCsvGrid,
} from "@/domains/ai/library/lib/library-view-model";
import { useWebviewGuard } from "@/domains/ai/chat/lib/use-webview-guard";
import { fileUrlOf } from "@/lib/file-url";
import { invoke } from "@/lib/ipc";
import { libraryContentKindOf, saveStatusOfKind } from "../lib/content-kind";
import { cmLanguageOfPath } from "../lib/cm-language";
import { libraryItemOf } from "../lib/library-item";
import { registerTabFlush, unregisterTabFlush } from "../lib/tab-save-flush";
import { useFileWindowStore } from "../store/file-window.store";
import FileWindowApi from "../api/file-window.api";
import FileTabHeader from "./FileTabHeader";
import FileWindowEditor from "./FileWindowEditor";
import FileWindowMdEditor from "./FileWindowMdEditor";

/** file:readExternalFile 回传（chat.service readWorkspaceFile） */
interface ExternalFileContent {
  kind?: "text" | "image";
  content?: string;
  dataUrl?: string;
  error?: string;
}

export default function LibraryTabBody({ tabId }: { tabId: string }) {
  const { t } = useTranslation(["chat"]);
  const queryClient = useQueryClient();
  const patchTab = useFileWindowStore((s) => s.patchTab);
  const tab = useFileWindowStore((s) => s.tabs.find((x) => x.id === tabId));
  const itemId = tab?.resource.kind === "library" ? tab.resource.itemId : null;

  const itemQuery = useQuery({
    queryKey: ["fw-library-item", itemId],
    queryFn: async () => (itemId !== null ? await libraryItemOf(itemId) : null),
    enabled: itemId !== null,
    retry: false,
  });
  const item = itemQuery.data ?? null;
  const kind = item ? libraryContentKindOf(item.fileType) : "text";
  const editable = kind === "md" || kind === "csv" || kind === "text";

  // 条目就位：contentKind 细化 + 标题落库；徽标随可编辑性与当下脏态对齐
  //（只读类 hidden——重取不吞进行中的 unsaved）
  useEffect(() => {
    if (!item) return;
    const current = useFileWindowStore
      .getState()
      .tabs.find((x) => x.id === tabId);
    const refined = libraryContentKindOf(item.fileType);
    patchTab(tabId, {
      contentKind: refined,
      title: item.name,
      saveStatus: saveStatusOfKind(refined, current?.dirty ?? false),
    });
  }, [item, patchTab, tabId]);

  // 内容读取：文本类（md/csv/text）+ dev 图片 dataUrl；webview 类直开
  // file:// 不读内容；512KB 上限沿用（超限/二进制回 error 走 Finder 兜底）
  const needsText = editable || (import.meta.env.DEV && kind === "image");
  const contentQuery = useQuery({
    queryKey: ["fw-library-content", itemId, item?.storagePath],
    queryFn: () =>
      invoke<ExternalFileContent>("file:readExternalFile", item!.storagePath!),
    enabled: !!item?.storagePath && needsText,
    retry: false,
  });

  // 错误只 toast 一次（空态由渲染分支兜底）
  useEffect(() => {
    if (contentQuery.error) toast.error(mapIpcError(contentQuery.error));
  }, [contentQuery.error]);

  // 草稿：md/text 字符串、csv 网格（refs 为保存取值镜像——onChange/onSave
  // 同拍不经 effect 刷新；条目/路径切换弃草稿）
  const [draft, setDraft] = useState<string | null>(null);
  const [csvDraft, setCsvDraft] = useState<string[][] | null>(null);
  const [conflict, setConflict] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const valueRef = useRef("");
  const csvRef = useRef<string[][] | null>(null);
  const content = contentQuery.data?.content ?? "";
  const value = draft ?? content;
  const csvGrid = csvDraft ?? (content ? toCsvGrid(parseCsv(content)) : null);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);
  useEffect(() => {
    csvRef.current = csvGrid;
  }, [csvGrid]);
  useEffect(() => {
    setDraft(null);
    setCsvDraft(null);
    setLoadFailed(false);
  }, [item?.id, item?.storagePath]);

  // 基线落库（仅未脏时——外部重取不得吞用户编辑的保存基线，同 workspace）
  useEffect(() => {
    if (!item || !contentQuery.data) return;
    const current = useFileWindowStore
      .getState()
      .tabs.find((x) => x.id === tabId);
    if (!current || current.dirty) return;
    const mtime = Date.parse(item.updatedAt);
    if (current.baselineMtime !== mtime)
      patchTab(tabId, { baselineMtime: mtime });
  }, [contentQuery.data, item, patchTab, tabId]);

  const markDirty = useCallback(() => {
    patchTab(tabId, { dirty: true, saveStatus: "unsaved" });
  }, [patchTab, tabId]);

  const handleTextChange = useCallback(
    (next: string) => {
      valueRef.current = next;
      setDraft(next);
      markDirty();
    },
    [markDirty],
  );

  const handleCsvChange = useCallback(
    (rows: string[][]) => {
      csvRef.current = rows;
      setCsvDraft(rows);
      markDirty();
    },
    [markDirty],
  );

  /** 保存取值快照（csv 网格序列化 / md·text 最新镜像值） */
  const snapshotOf = useCallback(
    () =>
      kind === "csv" ? serializeCsv(csvRef.current ?? []) : valueRef.current,
    [kind],
  );

  const applyWrite = useCallback(
    async (contentToWrite: string): Promise<void> => {
      const updated = await LibraryApi.writeFileContent(
        itemId!,
        contentToWrite,
      );
      // 条目缓存直写回传行（updatedAt/size 即时一致；tree 全量拉取代价高）
      queryClient.setQueryData(["fw-library-item", itemId], updated);
      patchTab(tabId, {
        saveStatus: "saved",
        dirty: false,
        baselineMtime: Date.parse(updated.updatedAt),
        externalChanged: false,
      });
    },
    [itemId, patchTab, queryClient, tabId],
  );

  const saveNow = useCallback(async (): Promise<void> => {
    const current = useFileWindowStore
      .getState()
      .tabs.find((x) => x.id === tabId);
    if (!current || itemId === null || !current.dirty) return;
    // in-flight 门：写盘进行中再触发（连点/⌘S）不重复写盘（同 useSaveTab）
    if (current.saveStatus === "saving") return;
    const snapshot = snapshotOf();
    patchTab(tabId, { saveStatus: "saving" });
    try {
      // updatedAt 基线：保存前重取条目（query 缓存可能陈旧，直取 tree）
      const fresh = await libraryItemOf(itemId);
      if (!fresh?.storagePath) {
        patchTab(tabId, { saveStatus: "unsaved" });
        toast.error(t("chat:fileWindow.chat.itemMissing"));
        return;
      }
      if (
        current.baselineMtime !== null &&
        Date.parse(fresh.updatedAt) !== current.baselineMtime
      ) {
        // 基线不符（外部/它窗已写盘）：冲突条裁决，本次不写盘
        setConflict(true);
        patchTab(tabId, { saveStatus: "unsaved" });
        return;
      }
      await applyWrite(snapshot);
    } catch (e) {
      patchTab(tabId, { saveStatus: "unsaved" });
      toast.error(mapIpcError(e));
    } finally {
      // 在飞期间击键回补（草稿新于磁盘不误判净，同 workspace 语义）
      const after = useFileWindowStore
        .getState()
        .tabs.find((x) => x.id === tabId);
      if (after && snapshotOf() !== snapshot) {
        patchTab(tabId, { dirty: true, saveStatus: "unsaved" });
      }
    }
  }, [applyWrite, itemId, patchTab, snapshotOf, t, tabId]);

  const handleSave = useCallback(() => {
    void saveNow();
  }, [saveNow]);

  // ⌘S：仅激活且脏时（同 FileTabEditor；激活门经事件时 getState）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        const current = useFileWindowStore.getState();
        const active = current.tabs.find((x) => x.id === tabId);
        if (active?.dirty && tabId === current.activeTabId) void saveNow();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveNow, tabId]);

  // 关闭确认「保存并关闭」经注册表取本 tab 保存流；卸载除名
  useEffect(() => {
    registerTabFlush(tabId, saveNow);
    return () => unregisterTabFlush(tabId);
  }, [tabId, saveNow]);

  // 冲突裁决：overwrite=免基线直写、reload=弃草稿重读、keepMine=仅撤条幅
  //（externalChanged 联动走 fileWindow:libraryChanged——AI 直改库文件时
  // use-file-changed 对同 itemId 脏 tab 置位复用本条，T14 修复轮；保存时
  // updatedAt 基线仍兜底广播未达/亚帧场景）
  const handleResolveConflict = useCallback(
    (mode: "overwrite" | "reload" | "keepMine") => {
      if (mode === "keepMine") {
        setConflict(false);
        patchTab(tabId, { externalChanged: false });
        return;
      }
      const snapshot = snapshotOf();
      setConflict(false);
      if (mode === "reload") {
        setDraft(null);
        setCsvDraft(null);
        // dirty 先撤（基线随重读数据落回时不被脏门拦下）
        patchTab(tabId, {
          dirty: false,
          saveStatus: "saved",
          externalChanged: false,
        });
        void queryClient.invalidateQueries({
          queryKey: ["fw-library-item", itemId],
        });
        void queryClient.invalidateQueries({
          queryKey: ["fw-library-content", itemId],
        });
        return;
      }
      patchTab(tabId, { saveStatus: "saving" });
      void applyWrite(snapshot)
        .catch((e) => {
          patchTab(tabId, { saveStatus: "unsaved" });
          toast.error(mapIpcError(e));
        })
        .then(() => {
          const after = useFileWindowStore
            .getState()
            .tabs.find((x) => x.id === tabId);
          if (after && snapshotOf() !== snapshot) {
            patchTab(tabId, { dirty: true, saveStatus: "unsaved" });
          }
        });
    },
    [applyWrite, itemId, patchTab, queryClient, snapshotOf, tabId],
  );

  // 卸载（关 tab/关窗）回收会话路径授权（T13）：sessionId 经 ref 快照——
  // 卸载时 tab 多已从 store 移除；无会话绑定不触发。关窗时渲染层拆除竞态
  // 由主进程懒清理兜底（spec 允许）
  const sessionIdRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    sessionIdRef.current = tab?.sessionId;
  }, [tab?.sessionId]);
  useEffect(
    () => () => {
      const sessionId = sessionIdRef.current;
      if (sessionId !== undefined) {
        void FileWindowApi.revokeSession(sessionId).catch(() => {});
      }
    },
    [],
  );

  // webview 类直开（守卫同 workspace：外跳全拦/失败降级）
  const webviewSrc =
    item?.storagePath && !editable && kind !== "image"
      ? fileUrlOf(item.storagePath)
      : null;
  const { ref: webviewRef, failed: webviewFailed } =
    useWebviewGuard(webviewSrc);

  if (itemQuery.isPending)
    return <p className="p-3 text-xs text-muted-foreground">…</p>;
  if (!itemId || !item?.storagePath)
    return (
      <div className="flex h-full flex-col">
        <FileTabHeader
          tabId={tabId}
          onSave={handleSave}
          conflict={conflict}
          onResolveConflict={handleResolveConflict}
        />
        <p className="p-3 text-xs text-muted-foreground">
          {t("chat:fileWindow.chat.itemMissing")}
        </p>
      </div>
    );

  const reveal = () =>
    void LibraryApi.revealItem(itemId).catch((e) =>
      toast.error(mapIpcError(e)),
    );

  // 读失败/二进制 error 回传/webview 加载失败 → Finder 兜底（同 workspace 分支）
  const failed =
    loadFailed ||
    webviewFailed ||
    (needsText &&
      (!!contentQuery.error ||
        (!contentQuery.isPending && !contentQuery.data) ||
        !!contentQuery.data?.error));

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
        ) : kind === "image" ? (
          <div className="flex h-full items-center justify-center">
            {/* dev：dataUrl 读取中占位（直链 file:// 跨源被拒不能提前挂
                src 误降级）；生产直链 file:// */}
            {import.meta.env.DEV ? (
              contentQuery.data?.dataUrl ? (
                <img
                  src={contentQuery.data.dataUrl}
                  alt={item.name}
                  className="max-h-full max-w-full object-contain"
                />
              ) : (
                <p className="text-xs text-muted-foreground">…</p>
              )
            ) : (
              <img
                src={fileUrlOf(item.storagePath)}
                alt={item.name}
                onError={() => setLoadFailed(true)}
                className="max-h-full max-w-full object-contain"
              />
            )}
          </div>
        ) : webviewSrc ? (
          // allowpopups 刻意不写：不写即默认拒绝弹窗（同 FilePreview）
          <webview
            ref={webviewRef}
            src={webviewSrc}
            partition="library-preview"
            className="h-full min-h-0 w-full rounded-md border border-border/50"
          />
        ) : editable ? (
          kind === "md" ? (
            <FileWindowMdEditor
              value={value}
              onChange={handleTextChange}
              loading={contentQuery.isPending}
            />
          ) : kind === "csv" ? (
            csvGrid === null ? (
              <p className="text-xs text-muted-foreground">…</p>
            ) : (
              <LibraryCsvEditor rows={csvGrid} onChange={handleCsvChange} />
            )
          ) : (
            <FileWindowEditor
              value={value}
              onChange={handleTextChange}
              language={cmLanguageOfPath(item.name)}
              readOnly={contentQuery.isPending}
              className="h-full min-h-[60vh] overflow-hidden rounded-md border border-border/50 p-3 focus-within:border-primary/30"
            />
          )
        ) : (
          // 后端 kind 与条目类型不一致的兜底：原文只读
          <pre className="text-xs leading-relaxed">{value || "…"}</pre>
        )}
      </div>
    </div>
  );
}
