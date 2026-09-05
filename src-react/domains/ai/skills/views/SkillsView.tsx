/**
 * 技能 Tab 双视图容器(发现页/我安装的)与顶部导航区:
 * 市场搜索(远端 keyword)与本地搜索语义分置 —— discover 态显示市场搜索框,
 * installed 态沿用 SkillManagerView 自带搜索条(P-A 交互不变)
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import SkillApi from "../api/skill.api";
import SkillDiscoverView from "./SkillDiscoverView";
import SkillManagerView from "./SkillManagerView";

type SkillView = "discover" | "installed";

export default function SkillsView() {
  const { t } = useTranslation(["chat", "common"]);
  const [view, setView] = useState<SkillView>("discover");

  const recordsQuery = useQuery({
    queryKey: ["skillRecords"],
    queryFn: () => SkillApi.list(),
  });
  const installedCount = recordsQuery.data?.length ?? 0;

  return (
    <div className="flex flex-col gap-3">
      {view === "discover" ? (
        <SkillDiscoverView
          onOpenInstalled={() => setView("installed")}
          installedCount={installedCount}
        />
      ) : (
        <>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:bg-primary-subtle hover:text-primary"
              onClick={() => setView("discover")}
            >
              <ChevronLeft className="mr-1 h-3.5 w-3.5" />
              {t("chat:skills.discover")}
            </Button>
            <span className="text-xs text-muted-foreground">
              {t("chat:skills.installedNav", { count: installedCount })}
            </span>
          </div>
          <SkillManagerView />
        </>
      )}
    </div>
  );
}
