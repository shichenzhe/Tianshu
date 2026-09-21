/**
 * 资料库搜索命令面板（spec §4）：居中浮层，键盘全程驱动——↑↓ 切换
 * 选中、Enter 打开、Esc 关闭（Dialog 内建）；空输入显示最近浏览
 * （listRecent），输入实时检索（search，300ms 防抖）；每项 = 图标 +
 * 加粗名 + 灰色位置。打开后 markViewed 由调用方 onSelect 处理。
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { FileText, Search } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import LibraryApi, { type LibraryItem } from "../api/library.api";
import { formatLocation } from "../lib/library-view-model";

export interface LibraryCommandDialogProps {
  open: boolean;
  onClose: () => void;
  onSelect: (item: LibraryItem) => void;
}

const SEARCH_DEBOUNCE_MS = 300;

export default function LibraryCommandDialog({
  open,
  onClose,
  onSelect,
}: LibraryCommandDialogProps) {
  const { t } = useTranslation(["chat"]);
  const [keyword, setKeyword] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // 重开裁定：面板每次打开回到初始态（清输入 → 默认「最近浏览」），
  // 不保留上次关键词——命令面板重开预期从最近列表起步，而非残留搜索
  useEffect(() => {
    if (open) {
      setKeyword("");
      setDebounced("");
      setSelectedIndex(0);
    }
  }, [open]);

  useEffect(() => {
    const timer = setTimeout(
      () => setDebounced(keyword.trim()),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [keyword]);

  const searching = debounced.length > 0;
  const resultsQuery = useQuery({
    queryKey: searching
      ? ["libraryCommandSearch", debounced]
      : ["libraryRecent"],
    queryFn: () =>
      searching ? LibraryApi.search(debounced) : LibraryApi.listRecent(),
    enabled: open,
  });
  const results = useMemo(() => resultsQuery.data ?? [], [resultsQuery.data]);

  useEffect(() => setSelectedIndex(0), [debounced]);

  // 选中项滚入可视区
  useEffect(() => {
    listRef.current
      ?.querySelectorAll("[data-command-item]")
      [selectedIndex]?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      // 空列表钳制到 0，防 selectedIndex 落成 -1
      setSelectedIndex((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      const item = results[selectedIndex];
      if (item) {
        e.preventDefault();
        onSelect(item);
      }
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="rounded-lg border border-border/50 shadow-lg sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="sr-only">
            {t("chat:library.commandPlaceholder")}
          </DialogTitle>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={keyword}
            onKeyDown={handleKeyDown}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder={t("chat:library.commandPlaceholder")}
            className="bg-primary-subtle/30 pl-8"
          />
        </div>
        <div ref={listRef} className="max-h-72 overflow-y-auto">
          <p className="px-1 pb-1 text-xs text-muted-foreground">
            {searching ? t("common:search") : t("chat:library.commandRecent")}
          </p>
          {resultsQuery.isPending ? (
            <p className="px-2 py-4 text-sm text-muted-foreground">
              {t("common:loading")}
            </p>
          ) : results.length === 0 ? (
            <p className="px-2 py-4 text-sm text-muted-foreground">
              {t("chat:library.commandNoResult")}
            </p>
          ) : (
            results.map((item, index) => (
              <button
                key={item.id}
                type="button"
                data-command-item
                className={`mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${
                  index === selectedIndex
                    ? "bg-primary-subtle"
                    : "hover:bg-primary-subtle/60"
                }`}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => onSelect(item)}
              >
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {item.name}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {formatLocation(item.location, t("chat:library.mine"))}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
        {/* 底部快捷键操作栏（横线分隔） */}
        <div className="flex items-center gap-4 border-t border-border/50 pt-2 text-xs text-muted-foreground">
          <span>↑ ↓ {t("chat:library.commandHintNavigate")}</span>
          <span>↵ {t("chat:library.commandHintOpen")}</span>
          <span>Esc {t("chat:library.commandHintClose")}</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
