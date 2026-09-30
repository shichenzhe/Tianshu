/**
 * 资料库预览内容体（从 LibraryPreviewDialog 拆壳内嵌化——详情面板载体）：
 * md 左编辑右预览分栏（右栏复用会话 MarkdownView 实时渲染）/ csv 表格
 * 编辑器（LibraryCsvEditor 单元格级）/ text-code <pre> 只读 / image <img> /
 * html-pdf-audio-video <webview file://>（独立 partition、禁弹窗、ref+
 * addEventListener 拦 will-navigate 外跳——renderer-guard 依赖 electron
 * 进不了渲染层，此为同语义内联实现）/ 其余或读失败降级 Finder。文本读取
 * 走 file:readExternalFile（512KB 上限沿用，超限降级 Finder）。dev 模式
 * 渲染器为 http 源、Chromium 阻止 file:// 子资源——图片经 readExternalFile
 * 取 dataUrl 内联（生产保持 file:// 直链，刻意不走 readExternalFile——其
 * 512KB 上限对照片普遍超限属行为回退）。
 * md/csv 实时保存：编辑变更防抖 800ms 写盘（library:writeFileContent），
 * 条目切换/卸载时 flush（卸载 flush 只写盘不回传——详情已关不重开）；
 * 工具行状态指示 保存中…/已保存。
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FolderSearch } from "lucide-react";

import { Button } from "@/components/ui/button";
import { mapIpcError } from "@/domains/ai/chat/lib/error-message";
import { invoke } from "@/lib/ipc";
import type { LibraryItem } from "../api/library.api";
import {
  fileUrlOf,
  parseCsv,
  previewModeOf,
  serializeCsv,
  toCsvGrid,
} from "../lib/library-view-model";
import LibraryApi from "../api/library.api";
import LibraryCsvEditor from "./LibraryCsvEditor";
import LibraryMarkdownEditor from "./LibraryMarkdownEditor";

/** 实时保存防抖窗口（编辑停顿后写盘） */
const AUTO_SAVE_DELAY_MS = 800;

/** 工具行保存状态（md/csv 编辑指示） */
type SaveState = "saved" | "pending" | "saving";

interface LibraryPreviewContentProps {
  item: LibraryItem;
  /** 保存成功回传新行（LibraryView 更新 detailItem 元信息） */
  onItemUpdate?: (item: LibraryItem) => void;
}

export default function LibraryPreviewContent({
  item,
  onItemUpdate,
}: LibraryPreviewContentProps) {
  const { t } = useTranslation(["chat", "common"]);
  // inline-text 只读预览文本
  const [text, setText] = useState<string | null>(null);
  // md 编辑内容（null=读取中）
  const [mdText, setMdText] = useState<string | null>(null);
  // csv 编辑网格（null=读取中）
  const [csvGrid, setCsvGrid] = useState<string[][] | null>(null);
  // dev 图片预览 dataUrl（生产恒 null——<img> 直链 file://）
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const webviewRef = useRef<HTMLElement>(null);
  // 防抖实时保存：待写内容（含条目 id，flush 幂等）+ 定时器
  const pendingRef = useRef<{ id: number; content: string } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 立即写盘 pending（notify=false 供条目切换/卸载 flush——详情已不在
   *  本条目，回传旧行会把详情跳回；保存落地时若已排入新 pending，指示
   *  保持 pending 不覆盖） */
  const flushSave = async (notify = true) => {
    const pending = pendingRef.current;
    if (pending === null) {
      return;
    }
    pendingRef.current = null;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setSaveState("saving");
    try {
      const updated = await LibraryApi.writeFileContent(
        pending.id,
        pending.content,
      );
      if (notify) {
        onItemUpdate?.(updated);
      }
      setSaveState(pendingRef.current !== null ? "pending" : "saved");
    } catch (e) {
      // 失败留渲染层提示（内容仍在编辑态不丢）；指示复位等待下次变更
      toast.error(mapIpcError(e));
      setSaveState(pendingRef.current !== null ? "pending" : "saved");
    }
  };

  /** 变更入列：覆写 pending + 重置防抖定时器 */
  const scheduleSave = (content: string) => {
    pendingRef.current = { id: item.id, content };
    setSaveState("pending");
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => void flushSave(), AUTO_SAVE_DELAY_MS);
  };

  // 条目切换：重置 + 读内容（md/csv/text 读文本、dev 图片读 dataUrl；
  // readExternalFile 512KB 上限沿用，超限/读失败降级 Finder）；ignore
  // flag 防 stale-read（A→B 快切旧 promise 后到覆盖新条目状态）；cleanup
  // flush 旧条目 pending 写盘（闭包捕获旧 id，与 pendingRef 内联双保险）
  useEffect(() => {
    setText(null);
    setMdText(null);
    setCsvGrid(null);
    setDataUrl(null);
    setLoadFailed(false);
    setSaveState("saved");
    if (item.kind !== "file") {
      return;
    }
    let stale = false;
    const mode = previewModeOf(item);
    if (
      mode === "inline-md" ||
      mode === "inline-csv" ||
      mode === "inline-text"
    ) {
      invoke<{ kind: "text" | "image"; content?: string }>(
        "file:readExternalFile",
        item.storagePath ?? "",
      )
        .then((result) => {
          if (stale) {
            return;
          }
          const content = result.content ?? "";
          if (mode === "inline-csv") {
            setCsvGrid(toCsvGrid(parseCsv(content)));
          } else if (mode === "inline-md") {
            setMdText(content);
          } else {
            setText(content);
          }
        })
        .catch(() => {
          if (!stale) {
            setLoadFailed(true);
          }
        });
    }
    if (mode === "inline-image" && import.meta.env.DEV) {
      invoke<{
        kind: "text" | "image";
        content?: string;
        dataUrl?: string;
      }>("file:readExternalFile", item.storagePath ?? "")
        .then((result) => {
          if (stale) {
            return;
          }
          if (!result.dataUrl) {
            setLoadFailed(true);
            return;
          }
          setDataUrl(result.dataUrl);
        })
        .catch(() => {
          if (!stale) {
            setLoadFailed(true);
          }
        });
    }
    return () => {
      stale = true;
      // 旧条目收尾只写盘不回传——详情已是新条目，回传旧行会把详情跳回
      void flushSave(false);
    };
    // 仅按 item.id 重置重读（本仓 ESLint 未注册 react-hooks 规则，无法
    // eslint-disable exhaustive-deps，以注释说明；若启用需抑制该行）
  }, [item?.id]);

  // webview 外跳拦截：will-navigate 全拦（初始 src 加载不经此事件），
  // 加载失败降级。React 合成事件不支持 webview 非标准事件，原生监听
  useEffect(() => {
    const node = webviewRef.current;
    if (!node) {
      return;
    }
    const onWillNavigate = (event: Event) => event.preventDefault();
    // ERR_ABORTED（-3，多为切换条目时的中止加载）不误降级 Finder
    const onFail = (event: Event) => {
      if ((event as { errorCode?: number }).errorCode !== -3) {
        setLoadFailed(true);
      }
    };
    node.addEventListener("will-navigate", onWillNavigate);
    node.addEventListener("did-fail-load", onFail);
    return () => {
      node.removeEventListener("will-navigate", onWillNavigate);
      node.removeEventListener("did-fail-load", onFail);
    };
  }, [item?.id]);

  // 卸载 flush（只写盘不回传——详情关闭/组件销毁不再触发 setDetailItem）
  useEffect(
    () => () => {
      void flushSave(false);
    },
    [],
  );

  const mode = previewModeOf(item);
  const url = item.storagePath ? fileUrlOf(item.storagePath) : "";
  // md/csv 可编辑（读失败已降级 Finder，无编辑语境）
  const editable =
    item.kind === "file" &&
    (mode === "inline-md" || mode === "inline-csv") &&
    !loadFailed;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 状态指示（md/csv 编辑实时保存）：pending 与 saving 同文案口径 */}
      {editable && (
        <div className="mb-2 flex shrink-0 items-center justify-end text-xs text-muted-foreground">
          {saveState === "saved"
            ? t("chat:library.savedIndicator")
            : t("chat:library.savingIndicator")}
        </div>
      )}
      {mode === "finder" || loadFailed ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
          <p>
            {loadFailed
              ? t("chat:library.previewFailed")
              : t("chat:library.previewUnsupported")}
          </p>
          <Button
            variant="outline"
            className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
            onClick={() =>
              void LibraryApi.revealItem(item.id).catch((e) =>
                toast.error(mapIpcError(e)),
              )
            }
          >
            <FolderSearch className="mr-1 h-4 w-4" />
            {t("chat:library.openInFinder")}
          </Button>
        </div>
      ) : mode === "inline-md" ? (
        // 标准编辑器：工具栏 + 左编辑右预览 + 快捷键/续行/缩进/滚动同步
        <LibraryMarkdownEditor
          value={mdText ?? ""}
          loading={mdText === null}
          onChange={(next) => {
            setMdText(next);
            scheduleSave(next);
          }}
        />
      ) : mode === "inline-csv" ? (
        csvGrid === null ? (
          <p className="p-4 text-sm text-muted-foreground">…</p>
        ) : (
          <LibraryCsvEditor
            rows={csvGrid}
            onChange={(rows) => {
              setCsvGrid(rows);
              scheduleSave(serializeCsv(rows));
            }}
          />
        )
      ) : mode === "inline-text" ? (
        <pre className="min-h-0 flex-1 overflow-auto rounded-md border border-border/50 p-4 text-xs leading-relaxed">
          {text === null ? "…" : text}
        </pre>
      ) : mode === "inline-image" ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto">
          {/* dev：dataUrl 读取中显示占位（此时直链 file:// 会因跨源被拒，
              不能提前挂 src 触发 onError 误降级）；生产直链 file:// */}
          {import.meta.env.DEV && dataUrl === null ? (
            "…"
          ) : (
            <img
              src={import.meta.env.DEV ? (dataUrl ?? "") : url}
              alt={item.name}
              onError={() => setLoadFailed(true)}
              className="max-h-full max-w-full object-contain"
            />
          )}
        </div>
      ) : (
        // allowpopups 刻意不写：Electron 按 DOM 属性「存在性」取值
        // （hasAttribute），写 "false" 反而会放行弹窗；不写即默认拒绝
        <webview
          ref={webviewRef}
          src={url}
          partition="library-preview"
          className="min-h-0 flex-1 rounded-md border border-border/50"
        />
      )}
    </div>
  );
}
