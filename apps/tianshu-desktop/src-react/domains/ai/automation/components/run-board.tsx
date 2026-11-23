/**
 * 固定入口右侧运行看板（替代原页头下拉选择器，spec 2026-11-23 §1）：
 * 按开始时间倒序常驻展示，条目含时间/状态/触发/耗时/attempt 与失败摘要；
 * 显式选中不在已加载页时顶部置顶「当前选择」；分页复用 queryRunPage
 * 服务端过滤（追加式聚合），不做客户端过滤；窄宽可收起成窄轨。
 */
import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import type { RunOwner } from "@tianshu/core/run-session";
import type { AutomationRunRecord } from "@tianshu/protocol";
import { Button } from "@/components/ui/button";
import { mapIpcError } from "../../chat/lib/error-message";
import {
  formatDateTime,
  formatDuration,
  localizeRunError,
  triggerTypeKey,
} from "../lib/run-display";
import { queryRunPage, RunStatusBadge } from "./RunSelector";

/** 服务端分页大小（automation:runs:page / orchestration:runs 同口径） */
const PAGE_SIZE = 20;

export function runBoardQueryKey(owner: RunOwner, pages: number) {
  return [
    "automation",
    "runSessionRuns",
    owner.kind,
    owner.ownerId,
    "board",
    pages,
  ];
}

/** 追加式聚合 1..pages 页（按页序 concat）；total 以末页为准。 */
export async function queryRunPages(
  owner: RunOwner,
  pages: number,
): Promise<{ items: AutomationRunRecord[]; total: number }> {
  const fetched = [];
  for (let page = 1; page <= pages; page += 1) {
    fetched.push(await queryRunPage(owner, page));
  }
  const last = fetched[fetched.length - 1];
  return {
    items: fetched.flatMap((result) => result.items),
    total: last?.total ?? 0,
  };
}

interface RunBoardProps {
  owner: RunOwner;
  selectedRunId?: number;
  currentRun?: AutomationRunRecord;
  onSelect: (runId: number) => void;
}

export default function RunBoard({
  owner,
  selectedRunId,
  currentRun,
  onSelect,
}: RunBoardProps) {
  const { t } = useTranslation(["chat"]);
  const [collapsed, setCollapsed] = useState(false);
  const ownerKey = `${owner.kind}:${owner.ownerId}`;
  const [pagesState, setPagesState] = useState(() => ({
    key: ownerKey,
    pages: 1,
  }));
  // 渲染期重置（非 effect）：owner 切换的首次提交即回落第 1 页，
  // 不按旧 owner 的追加页数发出瞬态请求
  if (pagesState.key !== ownerKey) {
    setPagesState({ key: ownerKey, pages: 1 });
  }
  const pages = pagesState.key === ownerKey ? pagesState.pages : 1;
  const runsQuery = useQuery({
    queryKey: runBoardQueryKey(owner, pages),
    queryFn: () => queryRunPages(owner, pages),
    // 追加页拉取/刷新期间保留已显示条目，失败不清空（spec 验收）
    placeholderData: keepPreviousData,
  });
  const runs = runsQuery.data?.items ?? [];
  const total = runsQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pinnedRun = pinnedRunOf(runs, selectedRunId, currentRun);

  if (collapsed) {
    return <BoardRail onExpand={() => setCollapsed(false)} />;
  }
  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-border/50">
      <BoardHeader total={total} onCollapse={() => setCollapsed(true)} />
      <div className="flex-1 overflow-y-auto p-2" data-testid="run-board-list">
        {pinnedRun && (
          <div className="mb-2 border-b border-border/50 pb-2">
            <p className="px-2 pb-1 text-xs text-muted-foreground">
              {t("chat:runSession.board.pinned")}
            </p>
            <RunBoardItem run={pinnedRun} selected onSelect={onSelect} pinned />
          </div>
        )}
        {runs.map((run) => (
          <RunBoardItem
            key={run.id}
            run={run}
            selected={run.id === selectedRunId}
            onSelect={onSelect}
          />
        ))}
        {runs.length === 0 && !pinnedRun && !runsQuery.isLoading && (
          <BoardFallback query={runsQuery} />
        )}
      </div>
      <footer className="border-t border-border/50 p-2">
        <Button
          variant="outline"
          size="sm"
          className="w-full hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
          disabled={pages >= totalPages || runsQuery.isFetching}
          onClick={() =>
            setPagesState((state) => ({
              key: state.key,
              pages: state.pages + 1,
            }))
          }
        >
          {t("chat:runSession.board.loadMore")}
        </Button>
      </footer>
    </aside>
  );
}

/** 显式选中不在已加载页时置顶当前选择；出现在列表后只在原位置显示。 */
function pinnedRunOf(
  runs: AutomationRunRecord[],
  selectedRunId: number | undefined,
  currentRun: AutomationRunRecord | undefined,
) {
  if (
    selectedRunId === undefined ||
    currentRun?.id !== selectedRunId ||
    runs.some((run) => run.id === selectedRunId)
  ) {
    return undefined;
  }
  return currentRun;
}

function BoardHeader({
  total,
  onCollapse,
}: {
  total: number;
  onCollapse: () => void;
}) {
  const { t } = useTranslation(["chat"]);
  return (
    <header className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
      <h2 className="text-sm font-medium">
        {t("chat:runSession.board.title")}
      </h2>
      <span className="text-xs text-muted-foreground">
        {t("chat:runSession.board.total", { count: total })}
      </span>
      <Button
        variant="ghost"
        size="sm"
        aria-label={t("chat:runSession.board.collapse")}
        onClick={onCollapse}
        className="ml-auto h-7 w-7 p-0 text-muted-foreground hover:text-primary"
      >
        <PanelRightClose className="h-4 w-4" />
      </Button>
    </header>
  );
}

/** 收起态窄轨：仅保留展开按钮，把宽度还给结果与追问区。 */
function BoardRail({ onExpand }: { onExpand: () => void }) {
  const { t } = useTranslation(["chat"]);
  return (
    <aside
      data-testid="run-board-rail"
      className="flex w-12 shrink-0 flex-col items-center border-l border-border/50 py-2"
    >
      <Button
        variant="ghost"
        size="sm"
        aria-label={t("chat:runSession.board.expand")}
        onClick={onExpand}
        className="h-7 w-7 p-0 text-muted-foreground hover:text-primary"
      >
        <PanelRightOpen className="h-4 w-4" />
      </Button>
    </aside>
  );
}

interface RunBoardItemProps {
  run: AutomationRunRecord;
  selected: boolean;
  pinned?: boolean;
  onSelect: (runId: number) => void;
}

function RunBoardItem({ run, selected, pinned, onSelect }: RunBoardItemProps) {
  const { t } = useTranslation(["chat"]);
  return (
    <button
      type="button"
      data-testid={pinned ? "run-board-pinned" : `run-board-item-${run.id}`}
      aria-current={selected ? "true" : undefined}
      className={[
        "flex w-full flex-col gap-1 rounded-md px-2 py-2 text-left",
        "hover:bg-primary-subtle hover:text-primary",
        selected ? "bg-primary-subtle" : "",
      ].join(" ")}
      onClick={() => onSelect(run.id)}
    >
      <span className="flex items-center justify-between gap-2 text-sm">
        <span className="truncate">{formatDateTime(run.startedAt)}</span>
        <RunStatusBadge status={run.status} />
      </span>
      <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
        <span>{t(triggerTypeKey(run.triggerType))}</span>
        <span>{formatDuration(run.durationMs)}</span>
        <span>{t("chat:automation.runs.attempt", { n: run.attempt })}</span>
      </span>
      {run.error && (
        <span className="line-clamp-2 break-all text-xs text-destructive">
          {localizeRunError(run.error, t)}
        </span>
      )}
    </button>
  );
}

/** 列表空态：首载失败给错误文案，否则给空提示。 */
function BoardFallback({
  query,
}: {
  query: { isError: boolean; error: unknown };
}) {
  const { t } = useTranslation(["chat"]);
  if (query.isError) {
    return (
      <p className="px-2 py-4 text-center text-xs text-destructive">
        {mapIpcError(query.error)}
      </p>
    );
  }
  return (
    <p className="px-2 py-4 text-center text-xs text-muted-foreground">
      {t("chat:runSession.empty")}
    </p>
  );
}
