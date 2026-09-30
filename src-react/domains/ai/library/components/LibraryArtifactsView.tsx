/**
 * 资料库「本地产物」视图：树状分层（工作空间 → 任务/会话 → 文件，
 * 参考 §2.1 云文档样式）——工具栏（类型筛选 + 我的收藏开关 + 搜索，
 * 前端本地过滤）+ 分组列表（名称/类型/更新人/写入时间/大小；名称与
 * 写入时间表头三态排序，工作空间行带「N 个任务」徽标；折叠态
 * localStorage 记忆，默认展开一级收起二级）。「返回资料库」按钮在
 * TopBar 顶行左侧（LibraryView 注册，列表/预览统一）。文件行点击
 * 预览（复用会话产物面板 FilePreview，读取/定位/另存走 workspace:*
 * 同通道）；列表由主进程 stat 过滤，磁盘上已删除的文件不出现。
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FileText,
  Filter,
  FolderOpen,
  MoreHorizontal,
  Search,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import ArtifactApi, { type ArtifactListItem } from "../../api/artifact.api";
import FilePreview from "../../chat/components/artifacts/FilePreview";
import type { SessionFile } from "../../chat/lib/artifacts";
import { mapIpcError } from "../../chat/lib/error-message";
import { TYPE_LABEL_KEY } from "./LibraryFileList";
import {
  formatSize,
  groupArtifacts,
  nextArtifactSort,
  sortArtifactFiles,
  type ArtifactSortState,
} from "../lib/library-view-model";

/** 折叠记忆持久化 key（对齐 tianshu-locale 命名） */
const COLLAPSED_STORAGE_KEY = "tianshu-artifacts-collapsed";

/** 表头与文件行共用的五列网格（名称/类型/更新人/写入时间/大小/…，
 *  ≈ PRD 50/15/15/10/10） */
const GRID =
  "grid grid-cols-[minmax(0,5fr)_90px_minmax(0,1.5fr)_110px_70px_40px] items-center gap-2";

/** 类型筛选项 = all + TYPE_LABEL_KEY 全部类型 */
const TYPE_FILTERS = ["all", ...Object.keys(TYPE_LABEL_KEY)];

/** 列表条目 → FilePreview 的 SessionFile 形状（产物组、已完成态） */
function toSessionFile(item: ArtifactListItem): SessionFile {
  return {
    path: item.relPath,
    group: "artifact",
    status: "written",
    messageId: -1,
  };
}

export default function LibraryArtifactsView() {
  const { t } = useTranslation(["chat"]);
  const queryClient = useQueryClient();
  const [keyword, setKeyword] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [favOnly, setFavOnly] = useState(false);
  const [sortState, setSortState] = useState<ArtifactSortState>("default");
  // 收起集合；key 形如 "ws:1" / "s:10"（默认展开一级、收起二级，见下方 effect）
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [collapseInit, setCollapseInit] = useState(false);
  const [previewItem, setPreviewItem] = useState<ArtifactListItem | null>(null);
  const [previewFullscreen, setPreviewFullscreen] = useState(false);

  const artifactsQuery = useQuery({
    queryKey: ["localArtifacts"],
    queryFn: () => ArtifactApi.listArtifacts(),
  });

  const groups = useMemo(
    () =>
      groupArtifacts(artifactsQuery.data ?? [], {
        keyword,
        fileType: typeFilter,
        favoriteOnly: favOnly,
      }),
    [artifactsQuery.data, keyword, typeFilter, favOnly],
  );

  // 折叠初值：groups 首次非空时一次性填充——优先 localStorage 记忆，
  // 无记忆默认收起全部任务组（一级工作空间展开）
  useEffect(() => {
    if (collapseInit || groups.length === 0) return;
    setCollapseInit(true);
    let saved: Set<string> | null = null;
    try {
      const parsed = JSON.parse(
        localStorage.getItem(COLLAPSED_STORAGE_KEY) ?? "[]",
      );
      if (Array.isArray(parsed)) saved = new Set(parsed);
    } catch {
      // 存储损坏——回落默认折叠
    }
    setCollapsed(
      saved ??
        new Set(
          groups.flatMap((g) => g.sessions.map((s) => `s:${s.sessionId}`)),
        ),
    );
  }, [groups, collapseInit]);

  const toggleCollapse = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      try {
        localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // 存储不可用（隐私模式等）——仅本次会话内记忆
      }
      return next;
    });
  };

  /** 收藏开关（独立表 toggle，成功后刷新列表；失败 toast 不阻断） */
  const toggleFavorite = async (item: ArtifactListItem) => {
    try {
      await ArtifactApi.toggleArtifactFavorite(item.workspaceId, item.relPath);
      await queryClient.invalidateQueries({ queryKey: ["localArtifacts"] });
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

  /** 菜单操作：定位/另存/复制路径（文案与产物面板一致，失败 toast 不阻断） */
  const reveal = (item: ArtifactListItem) => {
    ArtifactApi.revealFile(item.workspaceId, item.relPath).catch((e) =>
      toast.error(mapIpcError(e)),
    );
  };
  const exportCopy = async (item: ArtifactListItem) => {
    try {
      const saved = await ArtifactApi.exportFile(
        item.workspaceId,
        item.relPath,
      );
      if (saved) toast.success(t("chat:artifacts.exportSuccess"));
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };
  const copyPath = async (item: ArtifactListItem) => {
    try {
      await navigator.clipboard.writeText(item.path);
      toast.success(t("chat:artifacts.copyPathSuccess"));
    } catch {
      toast.error(t("chat:artifacts.copyPathFailed"));
    }
  };

  // 预览态：FilePreview 占满主区（fullscreen 为真全屏 fixed inset-0，
  // 不依赖外层 relative）
  if (previewItem) {
    return (
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/50">
        <FilePreview
          file={toSessionFile(previewItem)}
          workspaceId={previewItem.workspaceId}
          onBack={() => {
            setPreviewItem(null);
            setPreviewFullscreen(false);
          }}
          fullscreen={previewFullscreen}
          onToggleFullscreen={() => setPreviewFullscreen((v) => !v)}
        />
      </div>
    );
  }

  if (artifactsQuery.isLoading) {
    return <p className="py-10 text-center text-sm text-muted-foreground">…</p>;
  }
  if (artifactsQuery.isError) {
    return (
      <div className="py-10 text-center">
        <p className="text-sm text-muted-foreground">
          {t("chat:library.loadFailed")}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-2 hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          onClick={() => void artifactsQuery.refetch()}
        >
          {t("chat:library.retry")}
        </Button>
      </div>
    );
  }
  const hasArtifacts = (artifactsQuery.data ?? []).length > 0;

  return (
    <TooltipProvider>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* 工具栏：类型筛选 + 我的收藏开关（左）+ 搜索（右），前端本地过滤 */}
        <div className="flex flex-wrap items-center gap-2 py-3">
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger
              className="w-32"
              aria-label={t("chat:library.colType")}
            >
              <Filter className="h-4 w-4 shrink-0 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border border-border/50 rounded-lg shadow-lg">
              {TYPE_FILTERS.map((type) => (
                <SelectItem key={type} value={type}>
                  {t(
                    type === "all"
                      ? "chat:library.typeAll"
                      : (TYPE_LABEL_KEY[type] ?? "chat:library.typeOther"),
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Checkbox
              checked={favOnly}
              onCheckedChange={(v) => setFavOnly(v === true)}
              aria-label={t("chat:library.favOnly")}
            />
            {t("chat:library.favOnly")}
          </label>
          <div className="relative ml-auto w-64">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={t("chat:library.artifactsSearchPlaceholder")}
              className="h-8 pl-8 text-sm"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!hasArtifacts ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-border/50 p-10 text-sm text-muted-foreground">
              <FolderOpen className="h-6 w-6" />
              {t("chat:library.artifactsEmpty")}
            </div>
          ) : favOnly && groups.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-border/50 p-10 text-sm text-muted-foreground">
              <FileText className="h-6 w-6" />
              {t("chat:library.favEmpty")}
            </div>
          ) : groups.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-border/50 p-10 text-sm text-muted-foreground">
              <Search className="h-6 w-6" />
              {t("chat:library.artifactsNoMatch")}
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border/50">
              <div
                className={`${GRID} border-b border-border/50 bg-primary-subtle/40 px-3 py-2 text-xs font-medium text-muted-foreground`}
              >
                <button
                  type="button"
                  className="flex items-center gap-0.5 text-left hover:text-primary"
                  aria-label={t(
                    sortState === "nameDesc"
                      ? "chat:library.sortDesc"
                      : "chat:library.sortAsc",
                  )}
                  onClick={() =>
                    setSortState((s) => nextArtifactSort(s, "name"))
                  }
                >
                  {t("chat:library.colName")}
                  {sortState === "nameAsc" && <ChevronUp className="h-3 w-3" />}
                  {sortState === "nameDesc" && (
                    <ChevronDown className="h-3 w-3" />
                  )}
                </button>
                <span>{t("chat:library.colType")}</span>
                <span>{t("chat:library.colUpdater")}</span>
                <button
                  type="button"
                  className="flex items-center gap-0.5 text-left hover:text-primary"
                  aria-label={t(
                    sortState === "timeDesc"
                      ? "chat:library.sortDesc"
                      : "chat:library.sortAsc",
                  )}
                  onClick={() =>
                    setSortState((s) => nextArtifactSort(s, "time"))
                  }
                >
                  {t("chat:library.colWrittenAt")}
                  {sortState === "timeAsc" && <ChevronUp className="h-3 w-3" />}
                  {sortState === "timeDesc" && (
                    <ChevronDown className="h-3 w-3" />
                  )}
                </button>
                <span>{t("chat:library.colSize")}</span>
                <span />
              </div>
              {groups.map((ws) => {
                const wsKey = `ws:${ws.workspaceId}`;
                const wsOpen = !collapsed.has(wsKey);
                return (
                  <div
                    key={wsKey}
                    className="border-b border-border/50 last:border-b-0"
                  >
                    {/* 工作空间行：展开箭头 + 名称 + 「N 个任务」徽标 */}
                    <div
                      className={`${GRID} px-3 py-2 text-sm hover:bg-primary-subtle/40`}
                    >
                      <button
                        type="button"
                        className="flex min-w-0 items-center gap-1.5 text-left font-medium"
                        onClick={() => toggleCollapse(wsKey)}
                      >
                        <ChevronRight
                          className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${
                            wsOpen ? "rotate-90" : ""
                          }`}
                        />
                        <FolderOpen className="h-4 w-4 shrink-0 text-primary" />
                        <span className="truncate">{ws.name}</span>
                        <span className="ml-1 shrink-0 rounded-full bg-primary-subtle px-1.5 py-0.5 text-[10px] text-primary">
                          {t("chat:library.artifactsTaskCount", {
                            count: ws.sessions.length,
                          })}
                        </span>
                      </button>
                      <span />
                      <span />
                      <span />
                      <span />
                      <span />
                    </div>
                    {wsOpen &&
                      ws.sessions.map((session) => {
                        const sKey = `s:${session.sessionId}`;
                        const sOpen = !collapsed.has(sKey);
                        return (
                          <div key={sKey}>
                            {/* 任务（会话）行：缩进一层 */}
                            <div
                              className={`${GRID} px-3 py-1.5 text-sm text-muted-foreground hover:bg-primary-subtle/40`}
                            >
                              <button
                                type="button"
                                className="flex min-w-0 items-center gap-1.5 pl-5 text-left"
                                onClick={() => toggleCollapse(sKey)}
                              >
                                <ChevronRight
                                  className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${
                                    sOpen ? "rotate-90" : ""
                                  }`}
                                />
                                <Bot className="h-4 w-4 shrink-0" />
                                <span className="truncate">
                                  {session.title ||
                                    t("chat:library.localArtifacts")}
                                </span>
                              </button>
                              <span />
                              <span />
                              <span />
                              <span />
                              <span />
                            </div>
                            {sOpen &&
                              sortArtifactFiles(session.files, sortState).map(
                                (item) => (
                                  <div
                                    key={`${item.workspaceId}:${item.path}`}
                                    className={`group ${GRID} px-3 py-2 text-sm hover:bg-primary-subtle/40`}
                                  >
                                    <div className="flex min-w-0 items-center gap-2 pl-10">
                                      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                                      <button
                                        type="button"
                                        className="min-w-0 truncate text-left"
                                        title={item.path}
                                        onClick={() => setPreviewItem(item)}
                                      >
                                        {item.name}
                                      </button>
                                    </div>
                                    <span className="truncate text-muted-foreground">
                                      {t(
                                        TYPE_LABEL_KEY[item.fileType] ??
                                          "chat:library.typeOther",
                                      )}
                                    </span>
                                    <span
                                      className="truncate text-muted-foreground"
                                      title={item.sessionTitle}
                                    >
                                      {item.sessionTitle}
                                    </span>
                                    <span className="truncate text-muted-foreground">
                                      {new Date(
                                        item.writtenAt,
                                      ).toLocaleString()}
                                    </span>
                                    <span className="truncate text-muted-foreground">
                                      {formatSize(item.size)}
                                    </span>
                                    <DropdownMenu>
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <DropdownMenuTrigger asChild>
                                            <Button
                                              variant="ghost"
                                              size="sm"
                                              className="h-6 w-6 p-0 text-muted-foreground opacity-0 transition-opacity hover:text-primary focus-visible:opacity-100 group-hover:opacity-100"
                                              aria-label={t(
                                                "chat:library.moreActions",
                                              )}
                                            >
                                              <MoreHorizontal className="h-4 w-4" />
                                            </Button>
                                          </DropdownMenuTrigger>
                                        </TooltipTrigger>
                                        <TooltipContent side="bottom">
                                          {t("chat:library.moreActions")}
                                        </TooltipContent>
                                      </Tooltip>
                                      <DropdownMenuContent
                                        align="end"
                                        className="border border-border/50 rounded-lg shadow-lg"
                                      >
                                        <DropdownMenuItem
                                          onClick={() =>
                                            void toggleFavorite(item)
                                          }
                                        >
                                          {t(
                                            item.favorite
                                              ? "chat:library.unfavoriteAction"
                                              : "chat:library.favoriteAction",
                                          )}
                                        </DropdownMenuItem>
                                        <DropdownMenuItem
                                          onClick={() => setPreviewItem(item)}
                                        >
                                          {t("chat:artifacts.actionPreview")}
                                        </DropdownMenuItem>
                                        <DropdownMenuItem
                                          onClick={() => void exportCopy(item)}
                                        >
                                          {t("chat:artifacts.actionExport")}
                                        </DropdownMenuItem>
                                        <DropdownMenuItem
                                          onClick={() => reveal(item)}
                                        >
                                          {t("chat:artifacts.actionReveal")}
                                        </DropdownMenuItem>
                                        <DropdownMenuItem
                                          onClick={() => void copyPath(item)}
                                        >
                                          {t("chat:artifacts.actionCopyPath")}
                                        </DropdownMenuItem>
                                      </DropdownMenuContent>
                                    </DropdownMenu>
                                  </div>
                                ),
                              )}
                          </div>
                        );
                      })}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
