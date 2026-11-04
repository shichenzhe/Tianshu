/**
 * 可编辑 tab 内容（workspace 资源 md/text/csv 载体）：受控编辑器——draft
 * 状态在 FileTabContent（上层），本组件只承载渲染与快捷键：md →
 * FileWindowMdEditor（CM6+分栏预览，T24）、text/代码 → FileWindowEditor
 * （语言按扩展名懒加载映射，lib/cm-language；边框/内边距/焦点高亮对照
 * 原 textarea 口径，T25）；onChange 即上抛
 * （dirty/unsaved 落 store 由上层负责）；⌘S（meta/ctrl+s）仅在本 tab
 * 激活且 dirty 时委托无参 onSave（保存值由上层自取 draft）。
 */
import { useEffect } from "react";

import { cmLanguageOfPath } from "../lib/cm-language";
import { useFileWindowStore } from "../store/file-window.store";
import FileWindowEditor from "./FileWindowEditor";
import FileWindowMdEditor from "./FileWindowMdEditor";

export default function FileTabEditor({
  tabId,
  value,
  onChange,
  onSave,
  loading,
}: {
  tabId: string;
  /** 受控值：draft ?? 磁盘内容（上层计算） */
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;
  /** 文件读取中（防半值编辑：编辑器禁输入） */
  loading: boolean;
}) {
  const tab = useFileWindowStore((s) => s.tabs.find((t) => t.id === tabId));
  const dirty = tab?.dirty ?? false;

  // ⌘S：仅激活且 dirty 时委托 onSave；preventDefault 抢在浏览器默认保存
  // 前。激活门经 getState 取事件时激活态（全挂载下每个已挂编辑器各持
  // window 级监听，无门则一次 ⌘S 并发保存所有脏 tab、后台草稿被静默
  // 写盘）；不用订阅/reactive 值——不随激活切换重建监听。CM6 keymap 不
  // 含 Mod-s（未处理键冒泡），本监听自然触发
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty && tabId === useFileWindowStore.getState().activeTabId) {
          onSave();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSave, dirty, tabId]);

  if (!tab || tab.resource.kind !== "workspace") return null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {tab.contentKind === "md" ? (
        <FileWindowMdEditor
          value={value}
          onChange={onChange}
          loading={loading}
        />
      ) : (
        <FileWindowEditor
          value={value}
          onChange={onChange}
          language={cmLanguageOfPath(tab.resource.path)}
          readOnly={loading}
          className="h-full min-h-[60vh] overflow-hidden rounded-md border border-border/50 p-3 focus-within:border-primary/30"
        />
      )}
    </div>
  );
}
