/**
 * 页内查找条（WorkBuddy「查找页面内容」）：webview 原生 findInPage，计数经
 * found-in-page DOM 事件回流（Electron 把计数挂 event.detail）。输入即搜；
 * Enter 下一个 / Shift+Enter 上一个；Esc 或关闭清高亮。IME 组合期跳过
 * （isComposing 判定，避免拼音上屏误触发）。
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import IconTooltip from "@/components/common/icon-tooltip";
import { webviewApi } from "../lib/webview-api";

interface BrowserFindBarProps {
  /** 惰性取 active webview 节点（勿传节点本身，见 BrowserToolbar 头注释） */
  getWebviewNode: () => HTMLElement | null;
  onClose: () => void;
}

interface FindResult {
  active: number;
  total: number;
}

export default function BrowserFindBar({
  getWebviewNode,
  onClose,
}: BrowserFindBarProps) {
  const { t } = useTranslation(["chat"]);
  const [text, setText] = useState("");
  const [result, setResult] = useState<FindResult | null>(null);
  // findNext 语义：首搜 false（重启搜索刷新计数），后续 true（步进匹配）
  const searchedRef = useRef(false);
  const textRef = useRef("");

  // 计数回流：found-in-page 多次分派（finalUpdate 收敛），直接取末值即可
  useEffect(() => {
    const node = getWebviewNode();
    if (!node) return;
    const onFound = (event: Event) => {
      const detail = (
        event as { detail?: { activeMatchOrdinal?: number; matches?: number } }
      ).detail;
      if (!detail) return;
      setResult({
        active: detail.activeMatchOrdinal ?? 0,
        total: detail.matches ?? 0,
      });
    };
    node.addEventListener("found-in-page", onFound);
    return () => node.removeEventListener("found-in-page", onFound);
  }, [getWebviewNode]);

  const stop = () => {
    setResult(null);
    searchedRef.current = false;
    webviewApi(getWebviewNode())?.stopFindInPage("clearSelection");
  };

  /** forward 步进方向；首搜（文本刚变）findNext=false 重启整场搜索 */
  const search = (forward: boolean) => {
    const api = webviewApi(getWebviewNode());
    if (!textRef.current || !api) return;
    api.findInPage(textRef.current, {
      forward,
      findNext: searchedRef.current,
      matchCase: false,
    });
    searchedRef.current = true;
  };

  const changeText = (value: string) => {
    setText(value);
    textRef.current = value;
    if (value === "") {
      stop();
      return;
    }
    searchedRef.current = false;
    search(true);
  };

  const close = () => {
    stop();
    onClose();
  };

  const btn =
    "rounded p-0.5 text-muted-foreground hover:bg-primary-subtle hover:text-primary";

  return (
    <div className="flex items-center gap-1.5 border-b border-border/50 px-2 py-1">
      <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <input
        value={text}
        autoFocus
        spellCheck={false}
        placeholder={t("chat:browser.findInPage")}
        onChange={(e) => changeText(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") search(!e.shiftKey);
          if (e.key === "Escape") close();
        }}
        className="h-6 min-w-0 flex-1 rounded-md border border-border/50 bg-background px-2 text-xs outline-none focus:border-primary/30"
      />
      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
        {result ? `${result.active}/${result.total}` : ""}
      </span>
      <IconTooltip label={t("chat:browser.findPrev")}>
        <button
          type="button"
          className={btn}
          aria-label={t("chat:browser.findPrev")}
          onClick={() => search(false)}
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
      </IconTooltip>
      <IconTooltip label={t("chat:browser.findNext")}>
        <button
          type="button"
          className={btn}
          aria-label={t("chat:browser.findNext")}
          onClick={() => search(true)}
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </IconTooltip>
      <IconTooltip label={t("chat:browser.findClose")}>
        <button
          type="button"
          className={btn}
          aria-label={t("chat:browser.findClose")}
          onClick={close}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </IconTooltip>
    </div>
  );
}
