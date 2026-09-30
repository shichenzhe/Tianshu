/**
 * 专家市场首页：搜索 + 我的专家入口｜精选场景横滑（聚合态收起换返回）｜
 * 专家/专家团 + 排序 + 分类横滚筛选｜卡片网格（添加/详情/添加并对话）
 */
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Search, Users } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { mapIpcError } from "../../chat/lib/error-message";
import AssistantApi from "../../api/assistant.api";
import SessionApi from "../../api/session.api";
import { WorkspaceApi } from "../../api/workspace.api";
import {
  EXPERT_CATEGORIES,
  MARKET_EXPERTS,
  SCENARIOS,
  type ExpertMarketItem,
} from "../data/marketplace";
import {
  filterExperts,
  sortExperts,
  type ExpertSortBy,
} from "../lib/market-filter";
import ExpertCard from "../components/ExpertCard";
import ExpertDetailDialog from "../components/ExpertDetailDialog";
import ScenarioCard from "../components/ScenarioCard";

const ASSISTANTS_KEY = ["assistants"] as const;

export default function ExpertMarketView({
  onOpenMine,
}: {
  onOpenMine: () => void;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [keywordInput, setKeywordInput] = useState("");
  const [keyword, setKeyword] = useState("");
  const [type, setType] = useState<"expert" | "team">("expert");
  const [sortBy, setSortBy] = useState<ExpertSortBy>("comprehensive");
  const [category, setCategory] = useState<string | null>(null);
  const [scenarioSlug, setScenarioSlug] = useState<string | null>(null);
  const [detailSlug, setDetailSlug] = useState<string | null>(null);
  const [addingSlug, setAddingSlug] = useState<string | null>(null);
  const searchTimerRef = useRef<number | undefined>(undefined);

  const assistantsQuery = useQuery({
    queryKey: ASSISTANTS_KEY,
    queryFn: () => AssistantApi.list(),
  });
  const addedSlugs = useMemo(
    () =>
      new Set(
        (assistantsQuery.data ?? [])
          .map((a) => a.sourceSlug)
          .filter((s): s is string => s !== undefined),
      ),
    [assistantsQuery.data],
  );

  /** 市场搜索防抖 300ms（清空即回浏览态，同技能市场） */
  const onSearchChange = (value: string) => {
    setKeywordInput(value);
    window.clearTimeout(searchTimerRef.current);
    searchTimerRef.current = window.setTimeout(() => {
      setKeyword(value.trim());
    }, 300);
  };

  const scenario = useMemo(
    () => SCENARIOS.find((s) => s.slug === scenarioSlug) ?? null,
    [scenarioSlug],
  );

  const visible = useMemo(() => {
    const filtered = filterExperts(MARKET_EXPERTS, {
      keyword: keyword || undefined,
      type,
      category: category ?? undefined,
      scenarioSlugs: scenario ? new Set(scenario.expertSlugs) : undefined,
    });
    return sortExperts(filtered, sortBy);
  }, [keyword, type, category, scenario, sortBy]);

  const detailItem = useMemo(
    () => MARKET_EXPERTS.find((e) => e.slug === detailSlug) ?? null,
    [detailSlug],
  );

  /** 添加 = 以市场专家为模板建一条自己的专家 */
  const handleAdd = async (item: ExpertMarketItem) => {
    setAddingSlug(item.slug);
    try {
      await AssistantApi.create({
        name: item.name,
        icon: item.icon,
        systemPrompt: item.systemPrompt,
        description: item.description,
        tags: item.tags,
        sourceSlug: item.slug,
      });
      await queryClient.invalidateQueries({ queryKey: ASSISTANTS_KEY });
      toast.success(t("chat:experts.market.addSuccess"));
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setAddingSlug(null);
    }
  };

  /** 添加并对话：添加后新会话绑定专家直达聊天页 */
  const handleAddAndChat = async (item: ExpertMarketItem) => {
    setAddingSlug(item.slug);
    try {
      const created = await AssistantApi.create({
        name: item.name,
        icon: item.icon,
        systemPrompt: item.systemPrompt,
        description: item.description,
        tags: item.tags,
        sourceSlug: item.slug,
      });
      await queryClient.invalidateQueries({ queryKey: ASSISTANTS_KEY });
      const workspaces = await queryClient.ensureQueryData({
        queryKey: ["workspaces"],
        queryFn: () => WorkspaceApi.list(),
      });
      const workspaceId = workspaces[0]?.id;
      if (workspaceId === undefined) {
        return;
      }
      const session = await SessionApi.create({
        workspaceId,
        assistantId: created.id,
      });
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      navigate(`/module/ai?session=${session.id}`);
    } catch (e) {
      toast.error(mapIpcError(e));
    } finally {
      setAddingSlug(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* 工具栏 */}
      <div className="flex items-center gap-2">
        {scenario ? (
          <Button
            variant="ghost"
            size="sm"
            className="gap-1 text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
            onClick={() => setScenarioSlug(null)}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {t("chat:experts.market.allExperts")}
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
            onClick={onOpenMine}
          >
            <Users className="mr-1 h-3.5 w-3.5" />
            {t("chat:experts.market.myExpertsCount", {
              count: assistantsQuery.data?.length ?? 0,
            })}
          </Button>
        )}
        <div className="relative ml-auto w-56">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={keywordInput}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={t("chat:experts.market.searchPlaceholder")}
            className="h-8 pl-7 text-sm"
          />
        </div>
      </div>

      {/* 精选场景横滑（聚合态收起） */}
      {!scenario && (
        <section>
          <h3 className="mb-2 text-sm font-medium text-foreground">
            {t("chat:experts.market.scenarios")}
          </h3>
          <div className="flex gap-3 overflow-x-auto pb-1">
            {SCENARIOS.map((s) => (
              <ScenarioCard
                key={s.slug}
                scenario={s}
                experts={s.expertSlugs
                  .map(
                    (slug) =>
                      MARKET_EXPERTS.find((e) => e.slug === slug) ?? null,
                  )
                  .filter((e): e is ExpertMarketItem => e !== null)}
                onOpenScenario={() => setScenarioSlug(s.slug)}
                onOpenExpert={(item) => setDetailSlug(item.slug)}
              />
            ))}
          </div>
        </section>
      )}

      {/* 筛选行：类型 + 排序 + 分类横滚 */}
      <div className="flex items-center gap-2">
        <div className="inline-flex items-center rounded-lg border border-border/50 bg-primary-subtle/30 p-0.5 text-xs">
          {(
            [
              ["expert", t("chat:experts.market.typeExpert")],
              ["team", t("chat:experts.market.typeTeam")],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={cn(
                "rounded-md px-2.5 py-1 transition-colors",
                type === value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-primary",
              )}
              onClick={() => setType(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {(
          [
            ["comprehensive", t("chat:experts.market.sortComprehensive")],
            ["hot", t("chat:experts.market.sortHot")],
            ["newest", t("chat:experts.market.sortNewest")],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={cn(
              "text-xs transition-colors",
              sortBy === value
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setSortBy(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1 overflow-x-auto border-b border-border/50 pb-1 [&::-webkit-scrollbar]:hidden">
        <CategoryPill
          active={category === null}
          label={t("chat:experts.market.allCategories")}
          onClick={() => setCategory(null)}
        />
        {EXPERT_CATEGORIES.map((c) => (
          <CategoryPill
            key={c.key}
            active={category === c.key}
            label={t(`chat:experts.categories.${c.labelKey}`)}
            onClick={() => setCategory(c.key)}
          />
        ))}
      </div>

      {/* 网格 */}
      {visible.length === 0 ? (
        <p className="py-16 text-center text-sm text-muted-foreground">
          {t("chat:experts.market.noResult")}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {visible.map((item) => (
            <ExpertCard
              key={item.slug}
              item={item}
              added={addedSlugs.has(item.slug)}
              adding={addingSlug === item.slug}
              onAdd={() => void handleAdd(item)}
              onOpenDetail={() => setDetailSlug(item.slug)}
            />
          ))}
        </div>
      )}

      {/* 详情弹窗（key 随专家切换重建，重置提示词折叠态） */}
      <ExpertDetailDialog
        key={detailItem?.slug ?? "none"}
        item={detailItem}
        added={detailItem ? addedSlugs.has(detailItem.slug) : false}
        adding={detailItem ? addingSlug === detailItem.slug : false}
        onAdd={() => detailItem && void handleAdd(detailItem)}
        onAddAndChat={() => detailItem && void handleAddAndChat(detailItem)}
        onOpenChange={(open) => {
          if (!open) {
            setDetailSlug(null);
          }
        }}
      />
    </div>
  );
}

function CategoryPill({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-xs transition-colors",
        active
          ? "bg-primary-subtle text-primary"
          : "text-muted-foreground hover:text-foreground",
      )}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
