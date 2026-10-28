// src-react/domains/ai/monitor/views/MonitorView.tsx
/**
 * 监控页（spec §6）：场景筛选 chip + KPI 行 + 7 天趋势 + 按模型分布 +
 * 工具排行。数据 monitor:stats 即时聚合；场景变更经 queryKey 失效重拉。
 */
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { usePageHeaderStore } from "@/components/layout/page-header.store";
import { MonitorApi, type MonitorScene } from "../api/monitor.api";
import {
  useMonitorStore,
  type MonitorSceneFilter,
} from "../store/monitor.store";
import { formatCount, formatDuration } from "../lib/format";
import MonitorTrendChart from "../components/MonitorTrendChart";

const SCENE_FILTERS: MonitorSceneFilter[] = [
  "all",
  "chat",
  "graph",
  "automation",
];

/** 场景 chip 行（选中态 bg-primary text-primary-foreground，主题变量） */
function SceneChips({
  scene,
  onPick,
}: {
  scene: MonitorSceneFilter;
  onPick: (s: MonitorSceneFilter) => void;
}) {
  const { t } = useTranslation(["chat"]);
  const labelKey: Record<MonitorSceneFilter, string> = {
    all: "chat:monitor.sceneAll",
    chat: "chat:monitor.sceneChat",
    graph: "chat:monitor.sceneGraph",
    automation: "chat:monitor.sceneAutomation",
  };
  return (
    <div className="flex items-center gap-1.5">
      {SCENE_FILTERS.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onPick(s)}
          className={`rounded-full px-3 py-1 text-xs transition-colors ${
            s === scene
              ? "bg-primary text-primary-foreground"
              : "bg-muted/40 text-muted-foreground hover:bg-primary-subtle hover:text-primary"
          }`}
        >
          {t(labelKey[s])}
        </button>
      ))}
    </div>
  );
}

/** KPI 卡（AutomationStatsPanel KpiCard 同款放大） */
function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted/40 px-3 py-2">
      <p className="text-2xl font-semibold leading-7 text-foreground">
        {value}
      </p>
      <p className="truncate text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

/** 通用统计表（模型分布/工具排行共用骨架） */
function StatTable({
  head,
  rows,
}: {
  head: string[];
  rows: Array<Array<{ text: string; tone?: "destructive" }>>;
}) {
  return (
    <table className="w-full text-left text-xs">
      <thead>
        <tr className="text-muted-foreground">
          {head.map((h) => (
            <th key={h} className="px-2 py-1 font-medium">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} className="border-t border-border/50">
            {row.map((cell, j) => (
              <td
                key={j}
                className={`px-2 py-1.5 ${cell.tone === "destructive" ? "text-destructive/80" : ""}`}
              >
                {cell.text}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function MonitorView() {
  const { t } = useTranslation(["chat"]);
  const scene = useMonitorStore((s) => s.scene);
  const setScene = useMonitorStore((s) => s.setScene);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["monitor", "stats", scene],
    queryFn: () =>
      MonitorApi.stats(scene === "all" ? undefined : (scene as MonitorScene)),
  });

  // 错误提示走副作用（render 体内直接 toast 会随每次重渲染重复弹出）
  useEffect(() => {
    if (isError) toast.error(t("chat:monitor.loadFailed"));
  }, [isError, t]);

  // 标题行迁入 TopBar 中段（usePageHeader，与其他一级页一致）：页内
  // 不再有大标题头，内容直接贴顶栏开始；场景 chips 放 trailing
  // （t 入 deps——语言切换时重写标题）
  useEffect(() => {
    const { setPageHeader } = usePageHeaderStore.getState();
    setPageHeader({
      title: (
        <h2 className="truncate text-sm font-medium text-foreground">
          {t("chat:monitor.title")}
        </h2>
      ),
      trailing: <SceneChips scene={scene} onPick={setScene} />,
    });
    return () => setPageHeader(null);
  }, [scene, setScene, t]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <div className="h-40 animate-pulse rounded-lg bg-muted/40" />
        ) : isError ? (
          <p className="py-20 text-center text-sm text-muted-foreground">
            {t("chat:monitor.loadFailed")}
          </p>
        ) : !data ? (
          <p className="py-20 text-center text-sm text-muted-foreground">
            {t("chat:monitor.empty")}
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <section className="rounded-lg border border-border/50 p-3">
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <KpiCard
                  label={t("chat:monitor.todayInputTokens")}
                  value={formatCount(data.today.inputTokens)}
                />
                <KpiCard
                  label={t("chat:monitor.todayOutputTokens")}
                  value={formatCount(data.today.outputTokens)}
                />
                <KpiCard
                  label={t("chat:monitor.todayLlmCalls")}
                  value={formatCount(data.today.llmCalls)}
                />
                <KpiCard
                  label={`${t("chat:monitor.todayToolCalls")} · ${Math.round(data.today.toolSuccessRate * 100)}%`}
                  value={formatCount(data.today.toolCalls)}
                />
              </div>
              <div className="mt-3 border-t border-border/50 pt-3">
                <p className="mb-2 text-xs font-medium text-muted-foreground">
                  {t("chat:monitor.trendTitle")}
                </p>
                <MonitorTrendChart trend={data.trend} />
              </div>
            </section>
            <section className="rounded-lg border border-border/50 p-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                {t("chat:monitor.byModelTitle")}
              </p>
              {data.byModel.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  {t("chat:monitor.empty")}
                </p>
              ) : (
                <StatTable
                  head={[
                    t("chat:monitor.modelName"),
                    t("chat:monitor.modelCalls"),
                    t("chat:monitor.modelInput"),
                    t("chat:monitor.modelOutput"),
                  ]}
                  rows={data.byModel.map((m) => [
                    { text: m.name },
                    { text: String(m.calls) },
                    { text: formatCount(m.inputTokens) },
                    { text: formatCount(m.outputTokens) },
                  ])}
                />
              )}
            </section>
            <section className="rounded-lg border border-border/50 p-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                {t("chat:monitor.toolsTitle")}
              </p>
              {data.tools.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  {t("chat:monitor.empty")}
                </p>
              ) : (
                <StatTable
                  head={[
                    t("chat:monitor.toolName"),
                    t("chat:monitor.toolTotal"),
                    t("chat:monitor.toolSuccess"),
                    t("chat:monitor.toolAvgDuration"),
                    t("chat:monitor.toolDenied"),
                    t("chat:monitor.toolError"),
                  ]}
                  rows={data.tools.map((tool) => [
                    { text: tool.toolName },
                    { text: String(tool.total) },
                    { text: `${Math.round(tool.successRate * 100)}%` },
                    { text: formatDuration(tool.avgDurationMs) },
                    {
                      text: String(tool.denied),
                      tone: tool.denied > 0 ? "destructive" : undefined,
                    },
                    {
                      text: String(tool.error),
                      tone: tool.error > 0 ? "destructive" : undefined,
                    },
                  ])}
                />
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
