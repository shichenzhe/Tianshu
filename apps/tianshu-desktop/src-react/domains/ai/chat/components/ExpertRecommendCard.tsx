/**
 * 会话内专家推荐卡（recommend_expert 工具块渲染，WorkBuddy
 * suggest_plugin_install 卡片移植）：候选胶囊卡 +「添加并启用」——
 * 市场模板建专家 + 绑定当前会话。已添加（sourceSlug 命中）收敛为已添加态。
 */
import { memo, useContext, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  QueryClient,
  QueryClientContext,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Check, HelpCircle, Loader2, Plus, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { mapIpcError } from "../lib/error-message";
import AssistantApi from "../../api/assistant.api";
import SessionApi from "../../api/session.api";
import {
  MARKET_EXPERTS,
  toCreateParams,
  type ExpertMarketItem,
} from "../../experts/data/marketplace";
import type { RecommendPanelItem } from "../lib/group-blocks";

const ASSISTANTS_KEY = ["assistants"] as const;

/**
 * 无 QueryClientProvider 场景（组件单测/独立预览）的兜底 client：经公开
 * QueryClientContext 探测宿主缓存，缺失时自挂隔离 client——已添加判定与
 * 失效通知均可用，组件不因缺 Provider 而崩（宁退不崩同款原则）
 */
let fallbackQueryClient: QueryClient | undefined;
function getFallbackQueryClient(): QueryClient {
  if (!fallbackQueryClient) {
    fallbackQueryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  }
  return fallbackQueryClient;
}

interface ExpertRecommendCardProps {
  item: RecommendPanelItem;
  /** 当前会话 id：添加后绑定专家；缺省（历史重放等场景）只添加不绑定 */
  sessionId?: number;
  /** 添加成功回调（slug）；MessageItem 未接线，预留测试/扩展 */
  onAdded?: (slug: string) => void;
}

function ExpertRecommendCardBody({
  item,
  sessionId,
  onAdded,
}: ExpertRecommendCardProps) {
  const { t } = useTranslation(["chat"]);
  const queryClient = useQueryClient();
  const [busySlug, setBusySlug] = useState<string>();

  // 已添加判定：sourceSlug 命中（与专家市场同口径，共享 ["assistants"] 缓存）
  const assistantsQuery = useQuery({
    queryKey: ASSISTANTS_KEY,
    queryFn: async () => (await AssistantApi.list()) ?? [],
  });
  const addedSlugs = useMemo(
    () =>
      new Set(
        (assistantsQuery.data ?? [])
          .map((a) => a.sourceSlug)
          .filter((s): s is string => typeof s === "string"),
      ),
    [assistantsQuery.data],
  );

  /** 候选反查市场目录：miss（模型幻觉 slug）渲染原文占位行 */
  const candidates = useMemo(
    () =>
      item.slugs.map((slug) => ({
        slug,
        expert: MARKET_EXPERTS.find((e) => e.slug === slug) ?? null,
      })),
    [item.slugs],
  );

  const handleAdd = async (item: ExpertMarketItem) => {
    setBusySlug(item.slug);
    try {
      // 载荷构造与专家市场同一 toCreateParams（收口 T7 单源：专家团
      // expertType/members 透传同口径）
      const created = await AssistantApi.create(toCreateParams(item));
      if (sessionId) {
        await SessionApi.setAssistant(sessionId, created.id);
        await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      }
      await queryClient.invalidateQueries({ queryKey: ["assistants"] });
      onAdded?.(item.slug);
      toast.success(
        sessionId
          ? t("chat:experts.recommend.addSuccess")
          : t("chat:experts.market.addSuccess"),
      );
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setBusySlug(undefined);
    }
  };

  // 执行中（args 渐进）：骨架占位，不闪现空候选卡
  if (item.state === "running" || item.state === "awaiting-approval") {
    return (
      <div
        data-testid="recommend-loading"
        className="my-2 overflow-hidden rounded-lg border border-border/50"
      >
        <div className="flex items-center gap-1.5 border-b border-border/50 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5 shrink-0 animate-pulse text-primary" />
          <span className="truncate">
            {t("chat:experts.recommend.loading")}
          </span>
        </div>
        <div className="flex items-center gap-2.5 px-3 py-2.5">
          <div className="h-10 w-10 shrink-0 animate-pulse rounded-lg bg-muted" />
          <div className="min-w-0 flex-1 space-y-1.5 py-1">
            <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
            <div className="h-2.5 w-2/3 animate-pulse rounded bg-muted" />
          </div>
        </div>
      </div>
    );
  }

  // 失败/被拒：动作未发生，无卡可荐——仅保留推荐理由行（ReasonText 语义）
  if (item.state === "denied" || item.state === "error") {
    return (
      <div
        data-testid="recommend-reason"
        className="my-2 rounded-lg border border-border/50 px-3 py-2 text-xs text-muted-foreground"
      >
        {item.reason}
      </div>
    );
  }

  return (
    <div
      data-testid="recommend-card"
      className="my-2 overflow-hidden rounded-lg border border-border/50"
    >
      {/* 标题栏：推荐图标 + 标题 + 推荐理由（视觉同 WidgetRenderer 标题栏） */}
      <div className="flex items-center gap-1.5 border-b border-border/50 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="shrink-0">{t("chat:experts.recommend.title")}</span>
        {item.reason && (
          <>
            <span className="shrink-0">·</span>
            <span className="truncate">{item.reason}</span>
          </>
        )}
      </div>
      <div className="flex flex-col divide-y divide-border/50">
        {candidates.map(({ slug, expert }) =>
          expert ? (
            <div key={slug} className="flex items-center gap-2.5 px-3 py-2.5">
              {/* 视觉对齐 ExpertCard：emoji 头像 + 名称/profession/描述截断 */}
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-subtle text-xl leading-none">
                {expert.icon}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">
                  {expert.name}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {expert.subtitle}
                </p>
                <p className="line-clamp-1 text-xs text-muted-foreground">
                  {expert.description}
                </p>
              </div>
              {addedSlugs.has(slug) ? (
                <span className="flex h-7 shrink-0 items-center gap-1 px-2 text-xs text-muted-foreground">
                  <Check className="h-3.5 w-3.5" />
                  {t("chat:experts.recommend.added")}
                </span>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busySlug === slug}
                  onClick={() => void handleAdd(expert)}
                  className="h-7 shrink-0 gap-1 hover:border-primary/30 hover:bg-primary-subtle hover:text-primary"
                >
                  {busySlug === slug ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Plus className="h-3.5 w-3.5" />
                  )}
                  {busySlug === slug
                    ? t("chat:experts.recommend.adding")
                    : t("chat:experts.recommend.addAndEnable")}
                </Button>
              )}
            </div>
          ) : (
            // 未知 slug：渲染原文占位行（宁退不崩）
            <div
              key={slug}
              className="flex items-center gap-2.5 px-3 py-2.5 text-xs text-muted-foreground"
            >
              <HelpCircle className="h-4 w-4 shrink-0" />
              <span className="truncate font-mono">{slug}</span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

function ExpertRecommendCardImpl(props: ExpertRecommendCardProps) {
  // 宿主无 Provider（测试等）→ 兜底隔离 client，组件可独立渲染
  const hostClient = useContext(QueryClientContext);
  if (!hostClient) {
    return (
      <QueryClientProvider client={getFallbackQueryClient()}>
        <ExpertRecommendCardBody {...props} />
      </QueryClientProvider>
    );
  }
  return <ExpertRecommendCardBody {...props} />;
}

export default memo(ExpertRecommendCardImpl);
