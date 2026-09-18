/**
 * 资料库选择器（引用入口共用，spec §6）：面包屑逐层浏览 + 跨层搜索，
 * 仅 file 可勾选（多选），确认回调 { name, storagePath } 数组。
 * folder 点击进入，不参与选择。
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronRight, FileText, Folder } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import LibraryApi, { type LibraryItem } from "../api/library.api";
import { sortItems } from "../lib/library-view-model";

export interface PickedLibraryFile {
  name: string;
  storagePath: string;
}

interface LibraryPickerDialogProps {
  open: boolean;
  onClose: () => void;
  onPick: (files: PickedLibraryFile[]) => void;
}

export default function LibraryPickerDialog({
  open,
  onClose,
  onPick,
}: LibraryPickerDialogProps) {
  const { t } = useTranslation(["chat", "common"]);
  const [folderId, setFolderId] = useState<number | null>(null);
  const [keyword, setKeyword] = useState("");
  const [selected, setSelected] = useState<Map<number, PickedLibraryFile>>(
    new Map(),
  );
  const searching = keyword.trim().length > 0;
  const { data } = useQuery({
    queryKey: searching
      ? ["librarySearch", keyword.trim()]
      : ["libraryItems", folderId],
    // 显式标注联合返回（搜索为数组、浏览为 items/breadcrumbs 结构），
    // 否则 useQuery 泛型退化为 {}
    queryFn: (): Promise<
      LibraryItem[] | Awaited<ReturnType<typeof LibraryApi.list>>
    > =>
      searching
        ? LibraryApi.search(keyword.trim())
        : LibraryApi.list(folderId ?? undefined),
    enabled: open,
  });
  const items = sortItems(
    data instanceof Array ? data : (data?.items ?? []),
    "name",
    "asc",
  );
  const breadcrumbs = data && !(data instanceof Array) ? data.breadcrumbs : [];

  const toggle = (item: PickedLibraryFile & { id: number }) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(item.id)) {
        next.delete(item.id);
      } else {
        next.set(item.id, item);
      }
      return next;
    });
  };

  const confirm = () => {
    onPick([...selected.values()]);
    setSelected(new Map());
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex max-h-[70vh] flex-col border border-border/50 rounded-lg shadow-lg sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("chat:library.pickTitle")}</DialogTitle>
        </DialogHeader>
        <Input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder={t("chat:library.searchPlaceholder")}
        />
        {/* 面包屑逐层浏览（搜索时隐藏，返回全部由清空关键词承担） */}
        {!searching && (
          <nav className="flex flex-wrap items-center gap-1 text-xs">
            <button
              type="button"
              className="rounded-md px-1.5 py-1 hover:bg-primary-subtle hover:text-primary"
              onClick={() => setFolderId(null)}
            >
              {t("chat:library.mine")}
            </button>
            {breadcrumbs.map((crumb) => (
              <span key={crumb.id} className="flex items-center gap-1">
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
                <button
                  type="button"
                  className="rounded-md px-1.5 py-1 hover:bg-primary-subtle hover:text-primary"
                  onClick={() => setFolderId(crumb.id)}
                >
                  {crumb.name}
                </button>
              </span>
            ))}
          </nav>
        )}
        <div className="flex-1 overflow-y-auto">
          {items.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t("chat:library.empty")}
            </p>
          )}
          {items.map((item) =>
            item.kind === "folder" ? (
              <button
                key={item.id}
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-primary-subtle hover:text-primary"
                onClick={() => {
                  setKeyword("");
                  setFolderId(item.id);
                }}
              >
                <Folder className="h-4 w-4 shrink-0 text-primary" />
                <span className="truncate">{item.name}</span>
              </button>
            ) : (
              <button
                key={item.id}
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-primary-subtle"
                onClick={() =>
                  toggle({
                    id: item.id,
                    name: item.name,
                    storagePath: item.storagePath ?? "",
                  })
                }
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-border/50">
                  {selected.has(item.id) && (
                    <Check className="h-3 w-3 text-primary" />
                  )}
                </span>
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{item.name}</span>
              </button>
            ),
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common:cancel")}
          </Button>
          <Button disabled={selected.size === 0} onClick={confirm}>
            {t("chat:library.pickConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
