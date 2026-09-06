/**
 * 技能发现页:顶部导航(市场搜索/我安装的[n]/添加技能下拉)+
 * 精选区(top 洗牌取 8,换一换)+ 分类 Tab(categories 动态)+
 * 推荐网格(搜索态切 keyword 查询;加载更多 = pageSize 增量,单查询)
 * 安装流:installingSlug 单飞态;冲突 → AlertDialog 覆盖确认(overwrite 重装)
 * 添加下拉「上传技能」→ 导入弹窗;「创建技能」→ 预填引导语跳转聊天页(AI 创建流)
 */
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Search, Upload } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { mapIpcError } from "../../chat/lib/error-message";
import SessionApi from "../../api/session.api";
import { WorkspaceApi } from "../../api/workspace.api";
import SkillHubApi from "../api/skillhub.api";
import type { SkillHubSkill } from "../api/skillhub-types";
import { shuffle } from "../lib/shuffle";
import { useCreateSkillPromptStore } from "../store/create-skill.store";
import SkillHubCard from "../components/SkillHubCard";
import SkillImportDialog from "../components/SkillImportDialog";

const PAGE_SIZE = 24;

export default function SkillDiscoverView({
  onOpenInstalled,
  installedCount,
  installedSlugs,
}: {
  onOpenInstalled: () => void;
  installedCount: number;
  installedSlugs: Set<string>;
}) {
  const { t } = useTranslation(["chat", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setPendingPrompt = useCreateSkillPromptStore((s) => s.setPendingPrompt);
  const [keywordInput, setKeywordInput] = useState("");
  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [pages, setPages] = useState(1);
  const [featuredSeed, setFeaturedSeed] = useState(0);
  const [installingSlug, setInstallingSlug] = useState<string | null>(null);
  const [conflictSkill, setConflictSkill] = useState<SkillHubSkill | null>(
    null,
  );
  const [importOpen, setImportOpen] = useState(false);
  const searchTimerRef = useRef<number | undefined>(undefined);

  /**
   * 创建技能入口:新开会话(工作空间取第一个,与"无选中"派生语义一致)→
   * 预填引导语 → 跳转会话页(ChatInput 挂载时消费预填)
   */
  const handleCreateSkillFlow = async () => {
    try {
      const workspaces = await queryClient.ensureQueryData({
        queryKey: ["workspaces"],
        queryFn: () => WorkspaceApi.list(),
      });
      const workspaceId = workspaces[0]?.id;
      if (workspaceId === undefined) {
        toast.info(t("chat:skills.comingSoon"));
        return;
      }
      const created = await SessionApi.create({ workspaceId });
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      setPendingPrompt(t("chat:skills.createSkillPrompt"), ["skill-creator"]);
      navigate(`/module/ai?session=${created.id}`);
    } catch (e) {
      toast.error(mapIpcError(e));
    }
  };

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

  /** 市场安装:成功 invalidate 记录;冲突弹覆盖确认;异常 toast 原因 */
  const handleInstall = async (skill: SkillHubSkill, overwrite = false) => {
    setInstallingSlug(skill.slug);
    try {
      const result = await SkillHubApi.install({
        slug: skill.slug,
        overwrite,
      });
      if (result.status === "conflict") {
        setConflictSkill(skill);
        return;
      }
      toast.success(t("chat:skills.installSuccess", { name: skill.name }));
      await queryClient.invalidateQueries({ queryKey: ["skillRecords"] });
    } catch (e) {
      toast.error(`${t("chat:skills.installFailed")}: ${mapIpcError(e)}`);
    } finally {
      setInstallingSlug(null);
    }
  };

  /** 冲突弹窗确认:关闭并以 overwrite 重装 */
  const handleOverwriteInstall = () => {
    const skill = conflictSkill;
    setConflictSkill(null);
    if (skill) void handleInstall(skill, true);
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
            <DropdownMenuItem onClick={() => setImportOpen(true)}>
              <Upload className="mr-2 h-4 w-4" />
              {t("chat:skills.uploadSkill")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void handleCreateSkillFlow()}>
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
                  <SkillHubCard
                    skill={skill}
                    installed={installedSlugs.has(skill.slug)}
                    installing={installingSlug === skill.slug}
                    onInstall={() => void handleInstall(skill)}
                  />
                </div>
              ))
            )}
          </div>
        </section>
      )}

      {/* 分类 Tab(搜索态隐藏) */}
      {!keyword && (
        <div className="flex items-center gap-1 overflow-x-auto border-b border-border/50 [&::-webkit-scrollbar]:hidden">
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
              <SkillHubCard
                key={skill.slug}
                skill={skill}
                installed={installedSlugs.has(skill.slug)}
                installing={installingSlug === skill.slug}
                onInstall={() => void handleInstall(skill)}
              />
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

      {/* 导入技能弹窗(上传技能) */}
      <SkillImportDialog open={importOpen} onOpenChange={setImportOpen} />

      {/* 冲突覆盖确认 */}
      <AlertDialog
        open={conflictSkill !== null}
        onOpenChange={(open) => {
          if (!open) setConflictSkill(null);
        }}
      >
        <AlertDialogContent className="rounded-lg border border-border/50 shadow-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("chat:skills.conflictTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("chat:skills.conflictDesc", {
                name: conflictSkill?.name ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleOverwriteInstall}>
              {t("chat:skills.overwrite")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
        "shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors",
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
