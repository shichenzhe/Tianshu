/**
 * 技能发现页:顶部导航(市场搜索/我安装的[n]/添加技能下拉)+
 * 精选区(top 洗牌取 8,换一换)+ 分类 Tab(categories 动态)+
 * 推荐网格(搜索态切 keyword 查询;加载更多 = pageSize 增量,单查询)
 */
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import SkillHubApi from "../api/skillhub.api";
import { shuffle } from "../lib/shuffle";
import SkillHubCard from "../components/SkillHubCard";

const PAGE_SIZE = 24;

export default function SkillDiscoverView({
  onOpenInstalled,
  installedCount,
}: {
  onOpenInstalled: () => void;
  installedCount: number;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const [keywordInput, setKeywordInput] = useState("");
  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [pages, setPages] = useState(1);
  const [featuredSeed, setFeaturedSeed] = useState(0);
  const searchTimerRef = useRef<number | undefined>(undefined);

  const topQuery = useQuery({
    queryKey: ["skillhub", "top"],
    queryFn: () => SkillHubApi.top(),
    staleTime: 10 * 60 * 1000,
  });
  const categoriesQuery = useQuery({
    queryKey: ["skillhub", "categories"],
    queryFn: () => SkillHubApi.categories(),
    staleTime: 60 * 60 * 1000,
  });
  const listQuery = useQuery({
    queryKey: ["skillhub", "list", keyword, category, pages],
    queryFn: () =>
      SkillHubApi.list({
        keyword: keyword || undefined,
        category: category ?? undefined,
        pageSize: Math.min(PAGE_SIZE * pages, 100),
        sortBy: "score",
      }),
  });

  const featured = useMemo(() => {
    void featuredSeed; // 换一换:仅触发重算
    return shuffle(topQuery.data ?? []).slice(0, 8);
  }, [topQuery.data, featuredSeed]);

  /** 市场搜索防抖 300ms(清空即回分类浏览) */
  const onSearchChange = (value: string) => {
    setKeywordInput(value);
    window.clearTimeout(searchTimerRef.current);
    searchTimerRef.current = window.setTimeout(() => {
      setKeyword(value.trim());
      setPages(1);
    }, 300);
  };

  return (
    <div className="flex flex-col gap-3">
      {/* 顶部导航区 */}
      <div className="flex items-center gap-2">
        <div className="relative w-56">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={keywordInput}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={t("chat:skills.searchMarket")}
            className="h-8 pl-7 text-sm"
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
          onClick={onOpenInstalled}
        >
          {t("chat:skills.installedNav", { count: installedCount })}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" className="ml-auto h-8">
              {t("chat:skills.addSkill")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="rounded-lg border border-border/50 shadow-lg"
          >
            <DropdownMenuItem
              onClick={() => {
                setKeyword("");
                setKeywordInput("");
                window.clearTimeout(searchTimerRef.current);
              }}
            >
              <Search className="mr-2 h-4 w-4" />
              {t("chat:skills.findSkill")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => toast.info(t("chat:skills.comingSoon"))}
            >
              {t("chat:skills.uploadSkill")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => toast.info(t("chat:skills.comingSoon"))}
            >
              {t("chat:skills.createSkill")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* 精选区(搜索态隐藏) */}
      {!keyword && (
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-medium text-foreground">
              {t("chat:skills.featured")}
            </h3>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
              onClick={() => setFeaturedSeed((s) => s + 1)}
            >
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
              {t("chat:skills.shuffle")}
            </Button>
          </div>
          <div className="flex gap-3 overflow-x-auto pb-1">
            {topQuery.isPending ? (
              <p className="py-8 text-sm text-muted-foreground">
                {t("common:loading")}
              </p>
            ) : (
              featured.map((skill) => (
                <div key={skill.slug} className="w-64 shrink-0">
                  <SkillHubCard skill={skill} />
                </div>
              ))
            )}
          </div>
        </section>
      )}

      {/* 分类 Tab(搜索态隐藏) */}
      {!keyword && (
        <div className="flex items-center gap-1 border-b border-border/50">
          <CategoryTab
            active={category === null}
            label={t("chat:skills.allCategories")}
            onClick={() => {
              setCategory(null);
              setPages(1);
            }}
          />
          {(categoriesQuery.data ?? []).map((c) => (
            <CategoryTab
              key={c.key}
              active={category === c.key}
              label={c.name}
              onClick={() => {
                setCategory(c.key);
                setPages(1);
              }}
            />
          ))}
        </div>
      )}

      {/* 网格 */}
      {listQuery.isPending ? (
        <p className="py-16 text-center text-sm text-muted-foreground">
          {t("common:loading")}
        </p>
      ) : listQuery.isError ? (
        <div className="flex flex-col items-center gap-2 py-16">
          <p className="text-sm text-destructive">
            {t("chat:skills.marketFailed")}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void listQuery.refetch()}
          >
            {t("chat:skills.retry")}
          </Button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {(listQuery.data?.skills ?? []).map((skill) => (
              <SkillHubCard key={skill.slug} skill={skill} />
            ))}
          </div>
          {(listQuery.data?.total ?? 0) >
            (listQuery.data?.skills.length ?? 0) &&
            (listQuery.data?.skills.length ?? 0) < 100 && (
              <div className="flex justify-center py-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="hover:bg-primary-subtle hover:text-primary hover:border-primary/30"
                  onClick={() => setPages((p) => p + 1)}
                >
                  {t("chat:skills.loadMore")}
                </Button>
              </div>
            )}
        </>
      )}
    </div>
  );
}

function CategoryTab({
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
        "border-b-2 px-3 py-2 text-sm transition-colors",
        active
          ? "border-primary text-primary"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
