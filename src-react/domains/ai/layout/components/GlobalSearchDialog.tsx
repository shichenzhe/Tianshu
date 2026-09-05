/**
 * 全局搜索任务：居中 Modal，空关键词展示最近任务，输入实时过滤（300ms 防抖）
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Folder } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import WorkspaceApi from "../../api/workspace.api";
import SessionApi from "../../api/session.api";
import { mapIpcError } from "../../chat/lib/error-message";
import { useAiUiStore } from "../../store/ai-ui.store";

const SEARCH_DEBOUNCE_MS = 300;

export default function GlobalSearchDialog() {
  const { t } = useTranslation(["chat", "common"]);
  const navigate = useNavigate();
  const searchOpen = useAiUiStore((s) => s.searchOpen);
  const setSearchOpen = useAiUiStore((s) => s.setSearchOpen);
  const [keyword, setKeyword] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const timer = setTimeout(
      () => setDebounced(keyword.trim()),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [keyword]);

  const workspacesQuery = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => WorkspaceApi.list(),
    enabled: searchOpen,
  });
  const resultsQuery = useQuery({
    queryKey: ["session-search", debounced],
    queryFn: () => SessionApi.searchByTitle(debounced),
    enabled: searchOpen,
  });
  const results = resultsQuery.data ?? [];
  const workspaceName = (id: number) =>
    workspacesQuery.data?.find((w) => w.id === id)?.name ?? "";

  const handleSelect = (sessionId: number) => {
    setSearchOpen(false);
    setKeyword("");
    navigate(`/module/ai?session=${sessionId}`, { replace: true });
  };

  return (
    <Dialog
      open={searchOpen}
      onOpenChange={(open) => {
        if (!open) {
          setSearchOpen(false);
        }
      }}
    >
      <DialogContent className="rounded-lg border border-border/50 shadow-lg sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="sr-only">
            {t("chat:search.placeholder")}
          </DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder={t("chat:search.placeholder")}
        />
        <div className="max-h-72 overflow-y-auto">
          <p className="px-1 pb-1 text-xs text-muted-foreground">
            {debounced ? t("common:search") : t("chat:search.recent")}
          </p>
          {resultsQuery.isPending ? (
            <p className="px-2 py-4 text-sm text-muted-foreground">
              {t("common:loading")}
            </p>
          ) : resultsQuery.error ? (
            <p className="px-2 py-4 text-sm text-destructive">
              {mapIpcError(resultsQuery.error)}
            </p>
          ) : results.length === 0 ? (
            <p className="px-2 py-4 text-sm text-muted-foreground">
              {t("chat:search.noResults")}
            </p>
          ) : (
            results.map((session) => (
              <button
                key={session.id}
                type="button"
                className="mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-primary-subtle/60"
                onClick={() => handleSelect(session.id)}
              >
                <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">
                    {session.title}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {workspaceName(session.workspaceId)}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
