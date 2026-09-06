/**
 * 会话内搜索框（顶栏右侧组前置，渲染在主题切换左边）：
 * 点击搜索图标在左侧展开输入框，X 收起并清除高亮；
 * Enter/Shift+Enter 在命中项间循环导航（定位滚动由 MessageList
 * 按 mark 的 data-hit-index 完成），旁显 n/m 命中计数
 */
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSessionSearchStore } from "../../store/session-search.store";

export default function SessionSearchBox() {
  const { t } = useTranslation(["chat", "common"]);
  const [searchParams] = useSearchParams();
  // 与 ChatView 同源：当前任务在 URL ?session=
  const sessionId = Number(searchParams.get("session")) || null;

  const open = useSessionSearchStore((s) => s.open);
  const query = useSessionSearchStore((s) => s.query);
  const activeIndex = useSessionSearchStore((s) => s.activeIndex);
  const totalHits = useSessionSearchStore((s) => s.totalHits);
  const setOpen = useSessionSearchStore((s) => s.setOpen);
  const setQuery = useSessionSearchStore((s) => s.setQuery);
  const navigateHits = useSessionSearchStore((s) => s.navigate);

  const inputRef = useRef<HTMLInputElement>(null);

  // 展开即聚焦输入框
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open]);

  // 无选中会话即隐藏（按钮与展开框整体）；顺带收起搜索态避免残留
  useEffect(() => {
    if (!sessionId) {
      setOpen(false);
    }
  }, [sessionId, setOpen]);

  if (!sessionId) {
    return null;
  }

  const hitCountText =
    query.length > 0
      ? totalHits > 0
        ? `${activeIndex + 1}/${totalHits}`
        : t("chat:searchInSession.noResults")
      : null;

  return (
    <div className="flex items-center gap-1">
      {open && (
        <div className="relative">
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                navigateHits(e.shiftKey ? -1 : 1);
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
            placeholder={t("chat:searchInSession.placeholder")}
            className="h-7 w-44 pr-16 text-xs"
          />
          {/* 命中计数贴右侧 X 按钮左边（pr-16 给文字留出空间，避免重叠） */}
          {hitCountText && (
            <span className="pointer-events-none absolute right-7 top-1/2 -translate-y-1/2 text-[10px] tabular-nums text-muted-foreground select-none">
              {hitCountText}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="absolute right-0.5 top-1/2 h-6 w-6 -translate-y-1/2 p-0 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
            onClick={() => setOpen(false)}
            aria-label={t("common:close")}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => setOpen(!open)}
              aria-label={t("chat:searchInSession.label")}
            >
              <Search className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t("chat:searchInSession.label")}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
